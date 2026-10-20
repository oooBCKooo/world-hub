import { mkdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ordinaryPath, privateJson, readBounded } from '../../scripts/runtime/paths.mjs';
import { ownProcess } from '../../scripts/runtime/process.mjs';
import { detectEnvironment, discoverEnvironment } from './environment.mjs';
import { readSourceIndex, fetchSourceArtifact, publishArtifact, validateArtifactBytes } from '../../scripts/runtime/sources.mjs';
import { managementApiLink } from './topology.mjs';
import { diagnose } from './diagnostics.mjs';
import { SourceRegistry } from './source-registry.mjs';
import { verifyStoredPublisherEvidence } from '../../scripts/runtime/publisher-store.mjs';
import { PathsService } from './paths-service.mjs';
import { LocalPrograms } from './local-programs.mjs';
import { ModuleGroups } from './module-groups.mjs';
import { importLocalArtifact } from './local-artifacts.mjs';
import { inspectDeployment } from '../../scripts/runtime/deployment.mjs';
import { prepareDependencies } from '../../scripts/runtime/dependency-prepare.mjs';
import { observeGlobalHubPrograms } from './global-topology.mjs';
import { GlobalExternalPrograms } from './global-external-programs.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export function launcherError(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
const errorOf = error => ({ code: error.code ?? 'LAUNCHER_ERROR', message: String(error.message).slice(0, 2048), diagnostic: diagnose(error),
  ...(error.cleanupIncomplete ? { cleanupIncomplete: true, retainedDirectory: error.retainedDirectory } : {}),
  ...(error.partialResult ? { partialResult: error.partialResult } : {}) });
const json = async path => JSON.parse((await readBounded(path)).toString('utf8'));

export class LauncherManager {
  constructor(options) {
    this.root = resolve(options.root); this.defaults = { nodePath: options.nodePath ?? process.execPath,
      pythonPath: options.pythonPath ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
    this.operations = new Map();
    this.sourceRegistry = new SourceRegistry(this.root); this.sourceReviews = new Map(); this.publisherReviews = new Map();
    this.paths = new PathsService(this.root);
    this.credentialQueue = Promise.resolve(); this.defaultHubStopping = false;
    this.localPrograms = new LocalPrograms({root:this.root,environment:this.defaults,inspectDeployment,prepareDependencies,
      getHub:async ({ensure,signal}={}) => {
        const hub=await this.readyHub({ensure,signal});
        return {url:hub.url,endpoint:hub.url.replace('http:','ws:')+'/bridge'};
      },updateCredentials:(change,options)=>this.updateLocalCredentials(change,options)});
    this.moduleGroups = new ModuleGroups({localPrograms:this.localPrograms});
    this.busy = new Map(); this.url = ''; this.hub = null; this.hubFailure = null; this.closing = false;
    this.globalExternalPrograms = new GlobalExternalPrograms({ getHub: () => this.hub, isStopping: () => this.defaultHubStopping || this.closing,
      updateCredentials: (change, options) => this.updateLocalCredentials(change, options),
      managedPrincipals: () => new Set([...this.localPrograms.identities.values()].map(identity => identity.principal)) });
  }
  async initialize() {
    await ordinaryPath(this.root, {allowMissing:true}); await mkdir(this.root,{recursive:true,mode:0o700});
    await this.sourceRegistry.initialize(); await this.paths.initialize(); await this.localPrograms.initialize();
    const sample = join(repository,'examples/soft-ui-modules');
    try { if ((await lstat(await ordinaryPath(sample))).isDirectory()) this.defaults.moduleDirectory = sample; } catch {}
  }
  environment(input = {}) { return { nodePath: input.nodePath ?? this.defaults.nodePath, pythonPath: input.pythonPath ?? this.defaults.pythonPath }; }
  async readyHub({ensure=false,signal}={}) {
    const check=()=>{if(this.closing)throw launcherError('LAUNCHER_STOPPING','Launcher is stopping.');if(signal?.aborted)throw launcherError('START_STOPPED','Hub access was cancelled.');if(this.defaultHubStopping)throw launcherError('LOCAL_HUB_STOPPING','The local Hub is stopping.');};
    const wait=async operation=>{await operation.promise;if(operation.state==='failed')throw Object.assign(new Error(operation.error?.message??'Hub startup failed.'),operation.error);};
    check();
    const pending=this.busy.get('$default');
    if(pending?.kind==='start'&&pending.state==='running')await wait(pending);
    check();
    if(ensure&&(!this.hub||this.hub.exit||!this.hub.url)){const result=this.defaultHub('start');await wait(this.operations.get(result.operationId));}
    check();
    if(!this.hub||this.hub.exit||!this.hub.url)throw launcherError('LOCAL_HUB_REQUIRED','Start the local Hub first.');
    return this.hub;
  }
  async importArtifact(input) {
    const result=await importLocalArtifact({root:this.root,...input});
    await this.paths.remember({path:result.object.path,purpose:result.object.kind,library:true});return result;
  }
  programStartupPlan() { return this.localPrograms.startupPlanOverview(); }
  programStartupPlanSave(input) { return this.localPrograms.saveStartupPlan(input); }
  programStartupPlanReview() { return this.localPrograms.reviewStartupPlan(); }
  programStartupPlanStart(input) {
    if (input.accepted !== true) throw launcherError('TRUST_REQUIRED', 'Accept the displayed startup plan, source, permissions and wiring.');
    this.localPrograms.reviewed(input.reviewId, 'startup-plan');
    let launched;
    launched = this.launch('local-startup-plan', '$local-startup-plan', (_, signal) => this.localPrograms.startStartupPlan({ ...input, signal,
      progress: value => { const operation = this.operations.get(launched.operationId); if (operation) operation.progress = value; } }).catch(issue => {
        if (issue.partialResult) this.operations.get(launched.operationId).result = issue.partialResult;
        throw issue;
      }));
    return launched;
  }
  programTopology() {
    return observeGlobalHubPrograms({ hub: this.hub, localPrograms: this.localPrograms, launcherUrl: this.url });
  }
  programExternalOverview() { return this.globalExternalPrograms.inventory(); }
  programExternalPreview(input) { return this.globalExternalPrograms.preview(input); }
  programExternalApply(input) { return this.globalExternalPrograms.apply(input); }
  updateLocalCredentials(change,{signal,transient=false,expectedHub}={}) {
    const action=this.credentialQueue.then(async()=>{
      if (this.closing) throw launcherError('LAUNCHER_STOPPING', 'Launcher is stopping.');
      if(signal?.aborted)throw launcherError('START_STOPPED','Credential configuration cancelled.');
      if(this.defaultHubStopping)throw launcherError('LOCAL_HUB_STOPPING','The local Hub is stopping.');
      if (transient && (!expectedHub || this.hub !== expectedHub || expectedHub.exit)) throw launcherError('GLOBAL_EXTERNAL_STALE_RUN', 'The owned Hub run changed before communication authorization.');
      if (!transient && (!this.hub || this.hub.exit) && Object.keys(change.credentials).length === 0 && this.busy.get('$default')?.state !== 'running') {
        // Offline edits revoke saved grants without bringing any process online.
        const path=join(this.root,'default-hub','hub.json');
        let config;try{config=await json(path);}catch(error){if(error.code==='ENOENT')return {confirmed:true,persisted:false};throw error;}
        const credentials={...config.acl.credentials};for(const id of change.remove)delete credentials[id];
        await privateJson(path,{...config,acl:{...config.acl,credentials}});return {confirmed:true,persisted:true};
      }
      await this.readyHub({ensure:true,signal});
      if(signal?.aborted)throw launcherError('START_STOPPED','Credential configuration cancelled.');
      if(this.defaultHubStopping)throw launcherError('LOCAL_HUB_STOPPING','The local Hub is stopping.');
      if(!this.hub||this.hub.exit)throw launcherError('LOCAL_HUB_REQUIRED','The local Hub did not start.');
      if (transient) {
        if ([...Object.keys(change.credentials), ...change.remove].some(id => !/^external\.[a-z0-9][a-z0-9._-]{0,47}$/.test(id))) throw launcherError('GLOBAL_EXTERNAL_INVALID', 'Run-scoped external grants use their independent communication namespace.');
        const requestId = randomUUID(); expectedHub.send({ command: 'credentials-update', id: requestId, change });
        const result = await expectedHub.waitFor(event => event.event === 'credentials-updated' && event.id === requestId, 5000);
        if (!result.ok || this.hub !== expectedHub || expectedHub.exit || this.defaultHubStopping) throw launcherError('GLOBAL_EXTERNAL_APPLY_FAILED', 'The owned Hub did not confirm this run-scoped external communication change.');
        return { confirmed: true, persisted: false };
      }
      const path=join(this.root,'default-hub','hub.json'),config=await json(path);
      const credentials={...config.acl.credentials,...change.credentials};for(const id of change.remove)delete credentials[id];
      const requestId=randomUUID();this.hub.send({command:'credentials-update',id:requestId,change});
      const result=await this.hub.waitFor(event=>event.event==='credentials-updated'&&event.id===requestId,5000);
      if(!result.ok)throw launcherError('LOCAL_CREDENTIALS_REJECTED','The local Hub rejected credential configuration.');
      try {await privateJson(path,{...config,acl:{...config.acl,credentials}});}
      catch(error){const rollbackId=randomUUID();this.hub.send({command:'credentials-update',id:rollbackId,change:{credentials:Object.fromEntries(Object.entries(config.acl.credentials).filter(([id])=>id.startsWith('local.'))),remove:Object.keys(change.credentials).filter(id=>!config.acl.credentials[id])}});await this.hub.waitFor(event=>event.event==='credentials-updated'&&event.id===rollbackId,5000);throw error;}
      return {confirmed:true};
    });this.credentialQueue=action.catch(()=>{});return action;
  }
  async detect(input) { const chosen = this.environment(input); const [environment, candidates] = await Promise.all([detectEnvironment(chosen), discoverEnvironment(chosen)]);
    return { environment, candidates, guidance: ['Select an installed interpreter and check again. Prepare the supported dependency in a reviewed private venv, or install other dependencies manually in your own private environment.'] }; }
  publicOperation(operation) { const { promise, controller, ...value } = operation; return value; }
  operationList() { return { operations: [...this.operations.values()].slice(-128).reverse().map(operation => this.publicOperation(operation)) }; }
  discoverPaths(input) { return this.launch('discover-paths', '$path-discovery', (_, signal) => this.paths.discover(input, signal)); }
  launch(kind, instanceId, work) {
    if (this.closing) throw launcherError('LAUNCHER_STOPPING', 'Launcher is stopping.');
    if (kind === 'local-start' && this.defaultHubStopping) throw launcherError('LOCAL_HUB_STOPPING', 'The local Hub is stopping. Wait before starting an independent program.');
    if (this.busy.has(instanceId) && (kind !== 'stop' || this.busy.get(instanceId).kind === 'delete')) throw launcherError('RESOURCE_BUSY', 'Wait for this operation to complete.');
    const previous = this.busy.get(instanceId), operation = { id: randomUUID(), kind, instanceId, state: 'running', startedAt: new Date().toISOString(), controller: new AbortController() };
    this.operations.set(operation.id, operation); this.busy.set(instanceId, operation);
    operation.promise = Promise.resolve().then(() => work(previous, operation.controller.signal)).then(result => { operation.result = result; operation.state = 'succeeded'; }, error => { operation.error = errorOf(error); operation.state = 'failed'; }).finally(() => {
      operation.finishedAt = new Date().toISOString(); if (this.busy.get(instanceId) === operation) this.busy.delete(instanceId);
      for (const [id, old] of this.operations) if (this.operations.size > 128 && old.state !== 'running') this.operations.delete(id);
    });
    return { operationId: operation.id };
  }
  sources() { return this.sourceRegistry.list(); }
  publisherTrustState() { return this.sourceRegistry.publisherTrustState(); }
  publisherTrustPreview(change) { return this.sourceRegistry.previewPublisherTrust(change); }
  async publisherTrustApply(input) {
    if (input.accepted !== true) throw launcherError('TRUST_REQUIRED', 'Explicitly review the public key fingerprint and identity basis before changing publisher trust.');
    const result = await this.sourceRegistry.applyPublisherTrust(input); this.localPrograms.reviews.clear(); return result;
  }
  async publisherEvidencePreview(input) {
    const selection = { ...input, observe: false }, result = await this.sourceRegistry.publisherEvidence(selection);
    const trust = await this.sourceRegistry.publisherTrustState(), previewId = randomUUID();
    const fingerprint = value => createHash('sha256').update(JSON.stringify([value.evidenceSha256, value.report?.evidenceSha256, value.report?.statementDigest, value.artifact?.sha256, value.evidence])).digest('hex');
    this.publisherReviews.set(previewId, { selection, fingerprint: fingerprint(result), revision: trust.revision, createdAt: Date.now() });
    while (this.publisherReviews.size > 64) this.publisherReviews.delete(this.publisherReviews.keys().next().value);
    return { ...result, previewId, stateRevision: trust.revision };
  }
  async publisherEvidenceObserve(input) {
    if (input.accepted !== true) throw launcherError('TRUST_REQUIRED', 'Review this public signature, rotation, revocation or risk statement before recording it.');
    const preview = this.publisherReviews.get(input.previewId);
    if (!preview || Date.now() - preview.createdAt > 10 * 60000) throw launcherError('PUBLISHER_REVIEW_REQUIRED', 'Inspect the current evidence again.');
    const current = await this.sourceRegistry.publisherEvidence(preview.selection), trust = await this.sourceRegistry.publisherTrustState();
    const fingerprint = createHash('sha256').update(JSON.stringify([current.evidenceSha256, current.report?.evidenceSha256, current.report?.statementDigest, current.artifact?.sha256, current.evidence])).digest('hex');
    if (fingerprint !== preview.fingerprint || trust.revision !== preview.revision) throw launcherError('PUBLISHER_REVIEW_CHANGED', 'Public evidence or local trust changed after review. Inspect it again.');
    if (current.report?.accepted !== true) throw launcherError(current.report?.error?.code ?? 'PUBLISHER_EVIDENCE_REJECTED', current.report?.error?.message ?? 'This evidence cannot update trusted publisher state.');
    const artifact = current.artifact && Object.fromEntries(['kind', 'id', 'version', 'sha256'].map(key => [key, current.artifact[key]]));
    const report = await verifyStoredPublisherEvidence({ root: this.root, artifact, evidenceBytes: Buffer.from(JSON.stringify(current.evidence)), observe: true, sourceStatus: 'offline', expectedRevision: preview.revision });
    const result = { ...current, report };
    if (report.accepted !== true) throw launcherError(report.error?.code ?? 'PUBLISHER_EVIDENCE_REJECTED', 'Publisher evidence was rejected during observation.');
    this.publisherReviews.delete(input.previewId); this.localPrograms.reviews.clear(); return result;
  }
  saveSource(input) { return this.sourceRegistry.save(input); }
  deleteSource(id) { return this.sourceRegistry.delete(id); }
  async source(input) {
    const chosen = await this.sourceRegistry.resolve(input);
    const remember=result=>{
      const receiptId=randomUUID(),created=Date.now();this.sourceReviews.set(receiptId,{chosen,result,created});
      while(this.sourceReviews.size>64)this.sourceReviews.delete(this.sourceReviews.keys().next().value);
      return {...result,receiptId,sourceId:chosen.sourceId??null,createdAt:new Date(created).toISOString(),expiresAt:new Date(created+10*60000).toISOString()};
    };
    try {
      const result = await readSourceIndex(chosen.source, { expectedSha256: chosen.expectedSha256, allowPrivateNetwork: chosen.allowPrivateNetwork });
      await this.sourceRegistry.assertCurrent(chosen); await this.sourceRegistry.observed(chosen, result);
      return remember(result);
    } catch (error) {
      await this.sourceRegistry.unavailable(chosen);
      if(!chosen.sourceId||!['ENOENT','SOURCE_UNAVAILABLE'].includes(error.code))throw error;
      const prior=await this.sourceRegistry.observation(chosen);
      if(!prior||chosen.expectedSha256!==undefined&&chosen.expectedSha256!==prior.digest)throw error;
      await this.sourceRegistry.assertCurrent(chosen);
      const entries=await Promise.all(prior.index.entries.map(async entry=>{
        let cached=false;try{cached=(await lstat(await ordinaryPath(join(this.root,'source-cache',entry.sha256+'.artifact.json')))).isFile();}catch(issue){if(issue.code!=='ENOENT')throw issue;}
        return {...entry,cached,cachedVerified:false};
      }));
      return remember({source:chosen.source,digest:prior.digest,index:{...prior.index,entries},observedAt:prior.observedAt,
        networkPolicy:prior.networkPolicy,offline:true,cacheOnly:true,startsModules:false,requiresExecutionReview:true});
    }
  }
  fetchSource(input) {
    const key = '$source-cache';
    return this.launch('fetch-source', key, async (_, signal) => {
      const chosen = await this.sourceRegistry.resolve(input); let indexDigest = input.indexDigest, inspected;
      if (input.receiptId !== undefined) {
        const receipt = this.sourceReviews.get(input.receiptId);
        if (!receipt || Date.now() - receipt.created > 10 * 60000 || receipt.chosen.source !== chosen.source || receipt.chosen.revision !== chosen.revision
          || receipt.chosen.sourceId !== chosen.sourceId || receipt.chosen.allowPrivateNetwork !== chosen.allowPrivateNetwork
          || receipt.chosen.expectedSha256 !== chosen.expectedSha256) throw launcherError('SOURCE_REVIEW_REQUIRED', 'Inspect this current source configuration again.');
        indexDigest = receipt.result.digest; inspected = receipt.result;
      } else if (input.sourceId) throw launcherError('SOURCE_REVIEW_REQUIRED', 'Inspect the registered source and supply its current receiptId.');
      inspected ??= await readSourceIndex(chosen.source, {expectedSha256:chosen.expectedSha256,allowPrivateNetwork:chosen.allowPrivateNetwork,signal});
      if (indexDigest !== inspected.digest) throw launcherError('SOURCE_CHANGED','Inspect the current source again before downloading.');
      const entry = inspected.index.entries.find(row => row.entryId === input.entryId);
      if (!entry || entry.kind !== 'module') throw launcherError('MODULE_REQUIRED','Select a module artifact.');
      const result = await fetchSourceArtifact(chosen.source, indexDigest, input.entryId, { cacheRoot: join(this.root, 'source-cache'), publisherTrustRoot: this.root, allowPrivateNetwork: chosen.allowPrivateNetwork,
        expectedSha256:chosen.expectedSha256,cacheOnly:inspected.cacheOnly===true,signal });
      await this.sourceRegistry.assertCurrent(chosen);
      const bytes = await readBounded(join(this.root, 'source-cache', `${result.entry.sha256}.artifact.json`), 96 * 1024 * 1024);
      const validated = validateArtifactBytes(bytes);
      if (validated.entry.sha256 !== result.entry.sha256 || validated.artifact.kind !== result.kind
          || validated.manifest.id !== result.entry.id || validated.manifest.version !== result.entry.version)
        throw launcherError('SOURCE_CONTENT_CHANGED', 'Fetched artifact identity or contents changed before library registration.');
      const sourceReceipt = await this.sourceRegistry.recordFetch(chosen, { ...result, indexDigest });
      await this.paths.remember({ path: result.directory, purpose: result.kind, library: true });
      return { ...result, id: validated.manifest.id, version: validated.manifest.version, title: result.entry.title,
        ...(result.kind === 'module' ? { runtime: validated.manifest.runtime, provides: validated.manifest.provides, requires: validated.manifest.requires } : {}),
        libraryRegistered: true, sourceReceipt };
    });
  }
  defaultHub(kind) {
    if (this.defaultHubStopping) {
      const pending = this.busy.get('$default');
      if (kind === 'stop' && pending?.kind === 'stop') return { operationId: pending.id };
      throw launcherError('LOCAL_HUB_STOPPING', 'The local Hub is stopping. Wait before starting it again.');
    }
    if (kind === 'stop') {
      this.defaultHubStopping = true; this.localPrograms.pauseStarts();
      this.busy.get('$default')?.controller.abort();
    }
    let result;
    try { result = this.launch(kind, '$default', async (previous, signal) => {
      if (kind === 'stop' && previous) await previous.promise;
      if (kind === 'stop') {
        // Admission was closed synchronously before this operation was queued.
        // Aborted preparation and queued starts must finish before we inspect
        // handles or report success; none can restart the Hub behind Stop.
        await this.localPrograms.queue; await this.credentialQueue;
        for(const [id,handle] of this.localPrograms.handles) if(!handle.exit || handle.cleanupIncomplete) await this.localPrograms.stop(id);
        if (this.hub) await this.hub.stop(5000);
        if (this.hub && !this.hub.exit) throw launcherError('CLEANUP_INCOMPLETE', 'Default Hub exit unconfirmed.');
        return { stopped: true };
      }
      if (this.hub && !this.hub.exit) return { url: this.hub.url };
      const directory = join(this.root, 'default-hub'); await ordinaryPath(directory, { allowMissing: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'hub.json');
      try { await lstat(path); await ordinaryPath(path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const config = JSON.parse(await readFile(join(repository, 'config/hub.json'), 'utf8'));
        config.hub = { id: 'launcher.default' }; config.transport = { host: '127.0.0.1', port: 0, path: '/bridge' };
        config.log = { dir: join(directory, 'log') }; config.blobs = { dir: join(directory, 'blobs') };
        config.management = { ...config.management, stateFile: join(directory, 'management.json') };
        await privateJson(path, config, { exclusive: true });
      }
      const config = await json(path);
      if (config.transport?.host !== '127.0.0.1') throw launcherError('LOCAL_HUB_REQUIRED', 'Launcher-managed Hub must listen only on 127.0.0.1.');
      this.hubFailure = null;
      if (signal.aborted) throw launcherError('START_STOPPED', 'Default Hub startup was stopped.');
      this.hub = ownProcess(process.execPath, [join(repository, 'scripts/runtime/hub-process.mjs'), '--config', path, '--port', '0', '--quiet'],
        { cwd: directory, secrets: [], signal, onFailure: error => { this.hubFailure = errorOf(error); } });
      try {
        const ready = await this.hub.waitFor(event => event.event === 'ready', 10000);
        if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new Error('Invalid Hub port');
        this.hub.url = `http://127.0.0.1:${ready.port}`; this.hub.launcherRunId = randomUUID(); return { url: this.hub.url };
      } catch (error) { await this.hub.stop(1000); throw error; }
    }); } catch (error) {
      if (kind === 'stop') { this.defaultHubStopping = false; this.localPrograms.resumeStarts(); }
      throw error;
    }
    if (kind === 'stop') {
      const operation = this.operations.get(result.operationId);
      operation.promise = operation.promise.finally(() => { this.defaultHubStopping = false; this.localPrograms.resumeStarts(); });
    }
    return result;
  }
  programOverview() { return this.localPrograms.enqueue(async()=>({programs:await this.localPrograms.programs()})); }
  operation(id) { const operation=this.operations.get(id); if(!operation)throw launcherError('OPERATION_NOT_FOUND','Unknown operation',404); return this.publicOperation(operation); }
  async cancelOperation(id) {
    const operation=this.operations.get(id); if(!operation)throw launcherError('OPERATION_NOT_FOUND','Unknown operation',404);
    if(['stop','local-stop','group-stop'].includes(operation.kind))throw launcherError('CANCEL_UNAVAILABLE','Wait for this consistency operation to finish.');
    if(operation.state==='running')operation.cancelRequestedAt??=new Date().toISOString(); operation.controller.abort(); return this.publicOperation(operation);
  }
  groupStart(input) {
    if(input.accepted!==true)throw launcherError('TRUST_REQUIRED','Accept the reviewed group plan and module permissions.');
    this.localPrograms.reviewed(input.reviewId,'startup-plan'); let launched;
    launched=this.launch('group-start','$group-start',(_,signal)=>this.moduleGroups.applyStart({...input,signal,progress:value=>{this.operations.get(launched.operationId).progress=value;}})); return launched;
  }
  publishModule(input) {
    if(input.kind!=='module')throw launcherError('MODULE_REQUIRED','Publish a module artifact.');
    return this.launch('publish-module','$publish',(_,signal)=>publishArtifact(input.directory,{...input,...this.environment(input),signal}));
  }
  async hubs() { const live=this.hub&&!this.hub.exit; return [{id:'default',managedBy:'launcher',ownership:'managed',state:live?'running':this.hubFailure?'failed':'stopped',
    url:live?this.hub.url:null,runId:live?this.hub.launcherRunId:null,
    managementApiUrl:live?managementApiLink({hubUrl:this.hub.url}):null,
    statusUrl:live?new URL('/status',this.hub.url).href:null,error:this.hubFailure}]; }
  async close() {
    this.closing=true; this.localPrograms.pauseStarts();
    for(const op of this.operations.values())if(op.state==='running')op.controller.abort();
    await Promise.all([...this.operations.values()].filter(op=>op.state==='running').map(op=>op.promise));
    await this.paths.queue; await this.globalExternalPrograms.queue; await this.credentialQueue;
    const errors=[];
    for(const cleanup of [()=>this.paths.close(),()=>this.localPrograms.close(),async()=>{if(this.hub){await this.hub.stop(5000);if(!this.hub.exit)throw Error('Hub exit unconfirmed');}}])try{await cleanup();}catch(error){errors.push(error);}
    if(errors.length){this.closing=false;throw launcherError('CLEANUP_INCOMPLETE',errors.map(e=>e.message).join('; '));}
  }
}
