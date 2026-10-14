// Optional Launcher deployment of independent programs on its existing local
// Hub. This service never creates a pack, owns a Hub, or executes Hub business.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { safeId } from '../../scripts/runtime/package.mjs';
import { doctorModule } from '../../scripts/runtime/developer.mjs';
import { ordinaryPath, privateJson, readBounded, hash } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { ownProcess } from '../../scripts/runtime/process.mjs';
import { validateDeploymentSettings } from '../../scripts/runtime/deployment.mjs';

const FORMAT = 'world-hub.launcher-local-programs/v1', REVIEW_AGE = 10 * 60000;
const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const json = async file => JSON.parse((await readBounded(file)).toString('utf8'));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const date = () => new Date().toISOString();
const delay = ms => new Promise(done => setTimeout(done, ms));
const contractEqual = (left, right) => left?.id === right?.id && left?.version === right?.version;
function principalFor(id) { return `local.${id.slice(0, 35)}.${hash(id).slice(0, 8)}`; }
function configuration(input, manifest, deployment = {}) {
  const settings = clone(input.settings ?? Object.fromEntries((deployment.settings ?? []).map(item => [item.key, item.default])));
  validateDeploymentSettings(deployment,settings,{publicSource:true});
  if (!plain(settings) || Buffer.byteLength(JSON.stringify(settings)) > 65536) throw error('LOCAL_SETTINGS_INVALID', 'Program settings must be an object within 64 KiB.');
  const topics = clone(input.topics ?? deployment.topics ?? {}), names = Object.keys(topics);
  if (!plain(topics) || names.length < 1 || names.length > 64) throw error('LOCAL_TOPICS_REQUIRED', 'Select the communication topics declared by this program.');
  for (const [alias, topic] of Object.entries(topics)) {
    safeId(alias, 'topic alias');
    if (typeof topic !== 'string' || !topic || topic.length > 512 || /[\s\0#+]/.test(topic) || topic.split('/').some(part => !part)) throw error('LOCAL_TOPIC_INVALID', 'Use concrete topics without wildcard characters.');
  }
  if (new Set(Object.values(topics)).size !== names.length) throw error('LOCAL_TOPIC_DUPLICATE', 'Each topic alias must name a distinct topic.');
  const bridges = clone(input.bridges ?? deployment.bridges ?? {});
  if (!plain(bridges) || Object.keys(bridges).length !== manifest.bridges.length || manifest.bridges.some(slot => !Object.hasOwn(bridges, slot))) throw error('LOCAL_BRIDGES_INVALID', 'Configure every declared module bridge slot exactly once.');
  for (const [slot, rules] of Object.entries(bridges)) {
    if (!manifest.bridges.includes(slot) || !plain(rules) || Object.keys(rules).some(key => !['publish', 'subscribe'].includes(key))) throw error('LOCAL_BRIDGES_INVALID', 'Bridge configuration must contain only publish and subscribe topic aliases.');
    for (const direction of ['publish', 'subscribe']) if (!Array.isArray(rules[direction]) || rules[direction].length > 64 || new Set(rules[direction]).size !== rules[direction].length || rules[direction].some(alias => !names.includes(alias))) throw error('LOCAL_BRIDGES_INVALID', 'Bridge permissions must refer to existing topic aliases.');
  }
  const bindings = clone(input.bindings ?? []);
  if (!Array.isArray(bindings) || bindings.length > 32) throw error('LOCAL_BINDINGS_INVALID', 'Choose at most 32 exact capability providers.');
  for (const binding of bindings) {
    if (!plain(binding) || Object.keys(binding).some(key => !['providerId', 'contract'].includes(key)) || !plain(binding.contract) || Object.keys(binding.contract).some(key => !['id', 'version'].includes(key))) throw error('LOCAL_BINDINGS_INVALID', 'A capability binding contains providerId and an exact contract.');
    safeId(binding.providerId, 'provider program ID');
    if (!manifest.requires.some(required => contractEqual(required, binding.contract))) throw error('LOCAL_BINDINGS_INVALID', 'The selected contract is not required by this module.');
  }
  if (new Set(bindings.map(item => JSON.stringify([item.providerId, item.contract.id, item.contract.version]))).size !== bindings.length) throw error('LOCAL_BINDINGS_INVALID', 'Repeated capability bindings are not allowed.');
  return { settings, topics, bridges, bindings };
}

export class LocalPrograms {
  constructor({ root, environment = {}, getHub, updateCredentials, inspectDeployment, prepareDependencies } = {}) {
    this.root = resolve(root); this.directory = join(this.root, 'local-programs'); this.environment = environment;
    this.getHub = getHub; this.updateCredentials = updateCredentials; this.inspectDeployment = inspectDeployment; this.prepareDependencies = prepareDependencies;
    this.records = new Map(); this.identities = new Map(); this.reviews = new Map(); this.handles = new Map(); this.monitors = new Map(); this.queue = Promise.resolve(); this.closing = false;
    this.startsPaused = false; this.startControllers = new Set();
  }
  enqueue(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  path(id, ...parts) { safeId(id, 'program ID'); return join(this.directory, id, ...parts); }
  async initialize() {
    await ordinaryPath(this.directory, { allowMissing: true }); await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let saved;
    try { saved = await json(join(this.directory, 'registry.json')); } catch (issue) { if (issue.code === 'ENOENT') return; throw issue; }
    if (saved.format !== FORMAT || !Array.isArray(saved.programs) || saved.programs.length > 128) throw error('LOCAL_REGISTRY_INVALID', 'Independent-program registry is invalid; retain its private data for inspection.');
    for (const record of saved.programs) {
      safeId(record.programId); if (this.records.has(record.programId) || record.principal !== principalFor(record.programId)) throw error('LOCAL_REGISTRY_INVALID', 'Independent-program identities are inconsistent.');
      const identity = await json(this.path(record.programId, 'identity.json'));
      if (identity.programId !== record.programId || identity.principal !== record.principal || typeof identity.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(identity.token)) throw error('LOCAL_IDENTITY_INVALID', 'The private program identity is invalid.');
      if (['starting', 'running', 'stopping'].includes(record.state)) {
        // A disk PID is never ownership. Only ESRCH proves that this recorded
        // process is gone; a live/reused/unknown PID must not be killed/adopted.
        record.state = 'unknown'; record.error = { code: 'LOCAL_PROCESS_OWNERSHIP_UNKNOWN', message: 'Previous process ownership is unavailable. No recorded PID was signalled.' };
        if (Number.isSafeInteger(record.pid) && record.pid > 0) try { process.kill(record.pid, 0); } catch (issue) { if (issue.code === 'ESRCH') { record.state = 'stopped'; record.stoppedAt = date(); delete record.error; } }
      }
      this.records.set(record.programId, record); this.identities.set(record.programId, identity);
    }
    await this.save();
  }
  async save() { await privateJson(join(this.directory, 'registry.json'), { format: FORMAT, programs: [...this.records.values()] }); }
  row(id) { safeId(id); const row = this.records.get(id); if (!row) throw error('LOCAL_PROGRAM_NOT_FOUND', 'Unknown independent program.', 404); return row; }
  public(record) {
    const handle = this.handles.get(record.programId);
    return { programId: record.programId, module: clone(record.module), title: record.deployment?.title ?? record.module.id,
      principal: record.principal, state: record.state, pid: handle?.pid ?? (record.state === 'unknown' ? record.pid : null),
      settings: clone(record.settings), topics: clone(record.topics), bridges: clone(record.bridges), bindings: clone(record.bindings),
      provides: clone(record.manifest.provides), requires: clone(record.manifest.requires), permissions: clone(record.manifest.permissions),
      executionProfile: 'trusted-local', sandbox: false, hubId: 'default', hubUrl: record.hubUrl ?? null,
      entryUrl: record.entryUrl ?? null, communication: record.communication ?? 'unknown', registeredAt: record.registeredAt,
      startedAt: record.startedAt ?? null, stoppedAt: record.stoppedAt ?? null, ...(record.error ? { error: clone(record.error) } : {}) };
  }
  async programs() { return [...this.records.values()].map(row => this.public(row)); }
  validateBindings(programId, manifest, bindings) {
    for (const required of manifest.requires) if (!bindings.some(item => contractEqual(item.contract, required))) throw error('LOCAL_PROVIDER_REQUIRED', `Select an installed provider for ${required.id}@${required.version}.`);
    for (const binding of bindings) {
      if (binding.providerId === programId) throw error('LOCAL_PROVIDER_INVALID', 'A program cannot provide its own required binding.');
      const provider = this.records.get(binding.providerId);
      if (!provider || !provider.manifest.provides.some(offered => contractEqual(offered, binding.contract))) throw error('LOCAL_PROVIDER_INVALID', 'The chosen program does not provide the exact required capability version.');
    }
  }
  peerSnapshot(programId, manifest, config) {
    const peers = Object.fromEntries([...this.records.values()].map(row => [row.programId, { principal: row.principal }]));
    peers[programId] = { principal: principalFor(programId) };
    const bindings = [...this.records.values()].filter(row => row.programId !== programId).flatMap(row => row.bindings.map(binding => ({ from: binding.providerId, to: row.programId, contract: binding.contract })));
    bindings.push(...config.bindings.map(binding => ({ from: binding.providerId, to: programId, contract: binding.contract })));
    return { peers, bindings, manifest };
  }
  async inspect(directory, input = {}) {
    const found = await doctorModule({ directory, nodePath: input.nodePath ?? this.environment.nodePath ?? process.execPath, pythonPath: input.pythonPath ?? this.environment.pythonPath });
    if (!found.ok) throw Object.assign(error('LOCAL_MODULE_INVALID', 'Select a complete supported module and a usable runtime before registering it.'), { issues: found.issues });
    const files = await collectSourceFiles(found.directory), runtime = found.interpreter;
    runtime.sha256 = hash(await readBounded(runtime.executable, 1024 * 1024 * 1024));
    const deploymentReview = this.inspectDeployment ? await this.inspectDeployment({ directory: found.directory, manifest: found.manifest, nodePath: input.nodePath ?? this.environment.nodePath ?? process.execPath, pythonPath: input.pythonPath ?? this.environment.pythonPath }) : null;
    if(deploymentReview?.dependencies?.recipes.includes('electron')&&(Number(runtime.version.split('.')[0])<22||runtime.version.startsWith('22.')&&Number(runtime.version.split('.')[1])<12))throw error('LOCAL_RUNTIME_VERSION','The Electron deployment recipe requires Node 22.12.0 or newer.');
    return { directory: found.directory, manifest: found.manifest, files, environment: { [found.manifest.runtime.kind]: runtime }, deploymentReview,
      digest: hash(JSON.stringify({ files, manifest: found.manifest, runtime, deploymentReview })) };
  }
  remember(kind, review, extra = {}) {
    const reviewId = randomUUID(), createdAt = Date.now(); this.reviews.set(reviewId, { kind, review, ...extra, createdAt });
    while (this.reviews.size > 64) this.reviews.delete(this.reviews.keys().next().value);
    return { reviewId, review: clone(review), expiresAt: new Date(createdAt + REVIEW_AGE).toISOString() };
  }
  async preview(input) {
    safeId(input.programId, 'program ID');
    if (this.records.has(input.programId)) throw error('LOCAL_PROGRAM_EXISTS', 'Choose another program instance ID; existing program data is retained.');
    const inspected = await this.inspect(input.directory, input), deployment = inspected.deploymentReview?.deployment ?? {};
    const configured = configuration(input, inspected.manifest, deployment);
    this.validateBindings(input.programId, inspected.manifest, configured.bindings);
    const snapshot = this.peerSnapshot(input.programId, inspected.manifest, configured);
    const review = { format: 'world-hub.local-program-review/v1', programId: input.programId, directory: inspected.directory, module: { id: inspected.manifest.id, version: inspected.manifest.version },
      principal: principalFor(input.programId), ...configured, manifest: inspected.manifest, environment: inspected.environment,
      deployment: inspected.deploymentReview, peers: snapshot.peers, capabilityBindings: snapshot.bindings,
      digest: hash(JSON.stringify({ inspected: inspected.digest, configured, peers: snapshot.peers, bindings: snapshot.bindings })),
      startsModules: false, createsPack: false, sandbox: false, executionProfile: 'trusted-local', installsDependencies: false };
    return this.remember('register', review, { inspected, input: clone(input) });
  }
  reviewed(reviewId, kind, id) {
    const saved = this.reviews.get(reviewId);
    if (!saved || saved.kind !== kind || id !== undefined && saved.review.programId !== id || Date.now() - saved.createdAt > REVIEW_AGE) throw error('LOCAL_REVIEW_REQUIRED', 'Review the current program code, permissions and wiring before this action.');
    return saved;
  }
  register(input) { return this.enqueue(() => this.registerNow(input)); }
  async registerNow({ reviewId, accepted }) {
    if (accepted !== true) throw error('TRUST_REQUIRED', 'Accept the displayed local code, permissions and communication wiring.');
    if (this.closing) throw error('LAUNCHER_STOPPING', 'Launcher is stopping.');
    if (this.records.size >= 128) throw error('LOCAL_PROGRAM_LIMIT', 'Launcher supports at most 128 independent programs.');
    const saved = this.reviewed(reviewId, 'register'), review = saved.review, id = review.programId;
    if (this.records.has(id)) throw error('LOCAL_PROGRAM_EXISTS', 'The independent program instance ID already exists.');
    const current = await this.inspect(saved.inspected.directory, saved.input);
    if (current.digest !== saved.inspected.digest) throw error('LOCAL_REVIEW_CHANGED', 'The module or its runtime changed after review. Inspect it again.');
    this.validateBindings(id, current.manifest, review.bindings);
    const snapshot = this.peerSnapshot(id, current.manifest, review);
    if (JSON.stringify(snapshot.peers) !== JSON.stringify(review.peers) || JSON.stringify(snapshot.bindings) !== JSON.stringify(review.capabilityBindings)) throw error('LOCAL_REVIEW_CHANGED', 'Installed capability providers changed after review. Inspect this wiring again.');
    const home = await ordinaryPath(this.path(id), { allowMissing: true }); await mkdir(home, { mode: 0o700 });
    try {
      const source = join(home, 'module'); await mkdir(source, { mode: 0o700 });
      for (const file of current.files) { const destination = join(source, file.path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); const bytes = await readBounded(join(current.directory, file.path), 8 * 1024 * 1024); if (hash(bytes) !== file.sha256) throw error('LOCAL_REVIEW_CHANGED', 'The module changed during installation.'); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
      const copied = await collectSourceFiles(source);
      if (JSON.stringify(copied) !== JSON.stringify(current.files)) throw error('LOCAL_REVIEW_CHANGED', 'Installed module contents differ from the reviewed source.');
      const identity = { format: 'world-hub.local-program-identity/v1', programId: id, principal: review.principal, token: randomBytes(32).toString('base64url') };
      await privateJson(join(home, 'identity.json'), identity, { exclusive: true });
      const row = { programId: id, module: review.module, principal: review.principal, manifest: current.manifest, deployment: current.deploymentReview?.deployment ?? null,
        settings: review.settings, topics: review.topics, bridges: review.bridges, bindings: review.bindings,
        environment: Object.fromEntries(Object.entries(current.environment).map(([kind, runtime]) => [`${kind}Path`, runtime.executable])),
        files: current.files, state: 'stopped', registeredAt: date(), communication: 'disconnected' };
      this.records.set(id, row); this.identities.set(id, identity);
      try { await this.save(); } catch (issue) { this.records.delete(id); this.identities.delete(id); throw issue; }
      this.reviews.delete(reviewId); return { program: this.public(row) };
    } catch (issue) { issue.incompleteDestination = home; throw issue; }
  }
  async reviewStart(id) {
    const row = this.row(id);
    if (row.state === 'unknown') throw error('LOCAL_PROCESS_OWNERSHIP_UNKNOWN', 'The recorded process is not owned by this Launcher. Retain it; no foreign process will be signalled.');
    const inspected = await this.inspect(this.path(id, 'module'), row.environment);
    if (JSON.stringify(inspected.files) !== JSON.stringify(row.files)) throw error('LOCAL_INSTALLED_CODE_CHANGED', 'Installed program contents changed. Reinstall a reviewed module under a new program ID.');
    this.validateBindings(id, inspected.manifest, row.bindings);
    const snapshot = this.peerSnapshot(id, inspected.manifest, row);
    const runningProviders = [...new Set(row.bindings.map(binding => binding.providerId))].filter(provider => this.records.get(provider)?.state === 'running');
    const review = { format: 'world-hub.local-program-start-review/v1', programId: id, module: row.module, principal: row.principal, permissions: row.manifest.permissions,
      settings: row.settings, topics: row.topics, bridges: row.bridges, bindings: row.bindings, peers: snapshot.peers, capabilityBindings: snapshot.bindings,
      directory:inspected.directory, manifest:inspected.manifest, environment: inspected.environment, deployment: inspected.deploymentReview, createsPack: false, startsModules: false, sandbox: false, executionProfile: 'trusted-local',
      runningProviders, providerConfigurationBoundary: runningProviders.length ? 'Existing providers retain their previously reviewed program configuration. Review and restart a provider if its application requires this new consumer identity.' : null,
      digest: hash(JSON.stringify({ inspected: inspected.digest, configuration: row.settings, topics: row.topics, bridges: row.bridges, peers: snapshot.peers, bindings: snapshot.bindings })) };
    return this.remember('start', review, { inspected });
  }
  pauseStarts() {
    this.startsPaused = true;
    for (const controller of this.startControllers) controller.abort();
  }
  resumeStarts() { if (!this.closing) this.startsPaused = false; }
  start(id, input = {}) {
    if (this.startsPaused || this.closing) throw error('LOCAL_HUB_STOPPING', 'The local Hub is stopping. Wait for its owned programs to finish stopping.');
    // Include queued starts, not only programs that have already acquired a
    // process handle. Dependency preparation belongs to this same lifetime.
    const controller = new AbortController(); this.startControllers.add(controller);
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    return this.enqueue(() => this.startNow(id, { ...input, signal })).finally(() => this.startControllers.delete(controller));
  }
  async startNow(id, { reviewId, accepted, signal } = {}) {
    if (this.startsPaused || signal?.aborted) throw error('START_STOPPED', 'Independent-program startup was cancelled before execution.');
    if (accepted !== true) throw error('TRUST_REQUIRED', 'Accept the current independent-program execution review.');
    if (this.closing) throw error('LAUNCHER_STOPPING', 'Launcher is stopping.');
    const row = this.row(id);
    if(this.handles.get(id)?.cleanupIncomplete)throw error('CLEANUP_INCOMPLETE','Previous owned process tree retirement is unconfirmed. Retry Stop before starting another run.');
    if (this.handles.has(id) && !this.handles.get(id).exit) {
      if(row.state!=='running')throw error('LOCAL_PROGRAM_STILL_OWNED','Stop the previous owned program before reviewing another start.');
      return { program: this.public(row) };
    }
    if (row.state === 'unknown') throw error('LOCAL_PROCESS_OWNERSHIP_UNKNOWN', 'No live process was adopted from a saved PID.');
    const saved = this.reviewed(reviewId, 'start', id), refreshed = await this.reviewStart(id); this.reviews.delete(refreshed.reviewId);
    if (refreshed.review.digest !== saved.review.digest) throw error('LOCAL_REVIEW_CHANGED', 'Program code, runtime or wiring changed after review.');
    const identity = this.identities.get(id), secret = identity.token, redact = message => String(message).replaceAll(secret, '[redacted]').slice(0, 2048);
    const checkAbort = () => { if (signal?.aborted) throw error('START_STOPPED', 'Independent-program startup was cancelled.'); };
    let handle;
    row.state = 'starting'; delete row.error; row.communication = 'unknown'; await this.save();
    try {
      checkAbort();
      const prepared = this.prepareDependencies ? await this.prepareDependencies({ directory: this.path(id, 'module'), manifest: row.manifest, review: saved.inspected.deploymentReview, stateDir: this.path(id, 'environment'), signal }) : null;
      checkAbort();
      const credentials = { [identity.principal]: { token: secret, maxConnections: row.manifest.bridges.length, allow: {
        publish: [...new Set(Object.values(row.bridges).flatMap(bridge => bridge.publish.map(alias => row.topics[alias])))],
        subscribe: [...new Set(Object.values(row.bridges).flatMap(bridge => bridge.subscribe.map(alias => row.topics[alias])))] } } };
      await this.updateCredentials({ credentials, annotations: { [identity.principal]: { programs: [{ id, name: row.module.id }], bridgeName: `Launcher local: ${id}` } }, remove: [] }, { signal });
      const hub = await this.getHub({ ensure: true, signal });
      if (!hub || typeof hub.url !== 'string') throw error('LOCAL_HUB_REQUIRED', 'The Launcher-managed local Hub is unavailable.');
      const url = new URL(hub.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw error('LOCAL_HUB_REQUIRED', 'Independent programs require the Launcher-owned loopback Hub.');
      const endpoint = hub.endpoint ?? `ws://127.0.0.1:${url.port}/bridge`;
      const runId = randomUUID(), runDirectory = this.path(id, 'runs', runId), stateDir = this.path(id, 'state');
      await mkdir(runDirectory, { recursive: true, mode: 0o700 }); await mkdir(join(stateDir, 'tmp'), { recursive: true, mode: 0o700 });
      const bridges = Object.entries(row.bridges).map(([slot, acl]) => ({ slot, endpoint, bridgeId: `local.${hash(id + ':' + slot).slice(0, 24)}`, credential: identity.principal, principal: identity.principal,
        token: secret, publish: acl.publish.map(alias => row.topics[alias]), subscribe: acl.subscribe.map(alias => row.topics[alias]) }));
      const configFile = join(runDirectory, 'runtime.json');
      await privateJson(configFile, { format: 'world-hub.run/v1', instanceId: 'launcher-local', componentId: id, module: row.module, stateDir,
        settings: row.settings, topics: row.topics, peers: saved.review.peers, bindings: saved.review.capabilityBindings, bridges,
        ...(prepared?.directory ? { deployment: { directory: prepared.directory } } : {}) });
      checkAbort(); const runtime = saved.inspected.environment[row.manifest.runtime.kind];
      const options = { cwd: stateDir, temporary: join(stateDir, 'tmp'), secrets: [secret], signal, onFailure: issue => {
        if (handle?.stopping) return; row.state = 'failed'; row.communication = 'disconnected'; row.error = { code: 'LOCAL_PROGRAM_EXITED', message: redact(issue.message) };
        void this.enqueue(async () => { await this.captureLogs(id); await this.save(); }).catch(() => {});
      } };
      const args = [...(row.manifest.runtime.kind === 'python' ? ['-B', '-s'] : []), join(prepared?.directory??this.path(id, 'module'), row.manifest.runtime.entry), '--runtime-config', configFile];
      handle = row.manifest.permissions.processes === 'owned-children'
        ? await (await import('../../scripts/runtime/host-process.mjs')).ownHostedProcess(runtime.executable, args, { ...options, ownedChildren: true })
        : ownProcess(runtime.executable, args, options);
      this.handles.set(id, handle); row.pid = handle.pid; row.runId = runId; row.hubUrl = hub.url;
      const ready = await handle.waitFor(event => event.event === 'module-ready', 30000);
      if (ready.entryUrl !== undefined) {
        const entry = new URL(ready.entryUrl);
        if (!row.manifest.permissions.network.includes('loopback-listen') || entry.protocol !== 'http:' || entry.hostname !== '127.0.0.1' || !entry.port || entry.username || entry.password || entry.search || entry.hash) throw error('LOCAL_ENTRY_INVALID', 'The program reported an undeclared or invalid local interface URL.');
        row.entryUrl = entry.href;
      } else row.entryUrl = null;
      const healthId = randomUUID(); handle.send({ command: 'health', id: healthId });
      const health = await handle.waitFor(event => event.event === 'module-health' && event.id === healthId, 10000);
      if (health.ready !== true) throw error('LOCAL_PROGRAM_NOT_READY', 'The program reports that it is not ready.');
      const deadline = Date.now() + 10000;
      while (true) {
        checkAbort(); if (handle.exit) throw error('LOCAL_PROGRAM_EXITED', 'The program exited before its bridge connections were observed.');
        const response = await fetch(new URL('/status', hub.url), { signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (!response.ok) throw error('LOCAL_HUB_UNAVAILABLE', 'The shared local Hub cannot be observed.');
        const snapshot = await response.json(), connected = snapshot.bridges?.filter(bridge => bridge.principal === identity.principal && bridge.authenticated === true);
        if (connected && bridges.every(expected => connected.some(actual => actual.declaredId === expected.bridgeId))) { row.communication = 'connected'; break; }
        if (Date.now() >= deadline) throw error('LOCAL_BRIDGE_TIMEOUT', 'The program did not establish its authenticated bridge connections.'); await delay(50);
      }
      checkAbort(); row.state = 'running'; row.startedAt = date(); delete row.stoppedAt; await this.save(); this.reviews.delete(reviewId);
      let checking=false;
      const monitor=setInterval(async()=>{
        if(checking||row.state!=='running'||handle.stopping||this.closing)return;checking=true;
        try {
          const healthId=randomUUID();handle.send({command:'health',id:healthId});
          const health=await handle.waitFor(event=>event.event==='module-health'&&event.id===healthId,5000);
          if(health.ready!==true)throw error('LOCAL_HEALTH_UNREADY','The independent program reports it is not ready.');
          const response=await fetch(new URL('/status',hub.url),{signal:AbortSignal.timeout(2000),redirect:'error'});
          if(!response.ok)throw error('LOCAL_HUB_UNAVAILABLE','The shared Hub cannot be observed.');
          const snapshot=await response.json();
          row.communication=bridges.every(expected=>snapshot.bridges?.some(actual=>actual.principal===identity.principal&&actual.declaredId===expected.bridgeId&&actual.authenticated===true))?'connected':'disconnected';
          row.communicationObservedAt=date();if(row.communication!=='connected')throw error('LOCAL_BRIDGE_DISCONNECTED','Independent program bridge communication is disconnected.');
        }catch(issue){if(row.state==='running'&&!handle.stopping&&!this.closing){row.state='failed';row.error={code:issue.code??'LOCAL_HEALTH_FAILED',message:redact(issue.message)};row.communication='disconnected';void this.enqueue(()=>this.save()).catch(()=>{});}}
        finally{checking=false;}
      },1000);monitor.unref?.();this.monitors.set(id,monitor);
      return { program: this.public(row) };
    } catch (issue) {
      if (handle) try { await handle.stop(5000); if (!handle.exit) throw error('CLEANUP_INCOMPLETE', 'Owned program exit remains unconfirmed.'); } catch (cleanup) { row.state = 'unknown'; row.error = { code: 'CLEANUP_INCOMPLETE', message: redact(cleanup.message) }; await this.save(); throw Object.assign(error('CLEANUP_INCOMPLETE', row.error.message), { cleanupIncomplete: true }); }
      row.state = signal?.aborted ? 'stopped' : 'failed'; row.communication = 'disconnected'; row.error = { code: issue.code ?? 'LOCAL_START_FAILED', message: redact(issue.message) };
      await this.captureLogs(id); await this.save(); throw issue;
    }
  }
  async captureLogs(id) {
    const handle = this.handles.get(id); if (handle) await privateJson(this.path(id, 'logs.json'), { stdout: handle.stdout, stderr: handle.stderr, truncated: handle.truncated, exit: handle.exit, observedAt: date() });
  }
  async logs(id) { this.row(id); const handle = this.handles.get(id); if (handle) return { stdout: handle.stdout, stderr: handle.stderr, truncated: handle.truncated, exit: handle.exit }; try { return await json(this.path(id, 'logs.json')); } catch (issue) { if (issue.code === 'ENOENT') return { stdout: '', stderr: '', truncated: false }; throw issue; } }
  stop(id) { return this.enqueue(() => this.stopNow(id)); }
  async stopNow(id) {
    const row = this.row(id), handle = this.handles.get(id);
    clearInterval(this.monitors.get(id));this.monitors.delete(id);
    if (!handle && row.state === 'unknown') throw error('LOCAL_PROCESS_OWNERSHIP_UNKNOWN', 'This Launcher does not own the recorded process. No foreign PID or shared Hub was signalled.');
    if (handle) { row.state = 'stopping'; await this.save(); try {await handle.stop(5000); if (!handle.exit || handle.cleanupIncomplete) throw error('CLEANUP_INCOMPLETE', 'Owned independent-program exit is not confirmed.'); await this.captureLogs(id);}
      catch(issue){row.state='unknown';row.error={code:'CLEANUP_INCOMPLETE',message:'Owned program cleanup is incomplete. Retry Stop; no recorded foreign PID will be signalled.'};await this.save();throw issue;} }
    row.state = 'stopped'; row.communication = 'disconnected'; row.stoppedAt = date(); row.entryUrl = null; delete row.error; await this.save();
    return { program: this.public(row) };
  }
  remove(id) { return this.enqueue(async () => {
    const row = this.row(id),handle=this.handles.get(id); if (handle&&(!handle.exit||handle.cleanupIncomplete)||['running', 'starting', 'stopping', 'unknown'].includes(row.state)) throw error('LOCAL_PROGRAM_RUNNING', 'Stop this owned program before removing its registration.');
    if ([...this.records.values()].some(candidate => candidate.programId !== id && candidate.bindings.some(binding => binding.providerId === id))) throw error('LOCAL_PROGRAM_IN_USE', 'Another independent program binds this capability provider. Retain it until those consumer registrations are removed.');
    await this.updateCredentials({ credentials: {}, annotations: {}, remove: [row.principal] }, {});
    // This operation removes registration only. Software, state and identity
    // remain recoverable; it does not recursively delete program data.
    this.records.delete(id); this.identities.delete(id); this.handles.delete(id); await this.save();
    return { programId: id, removed: true, retainedDirectory: this.path(id) };
  }); }
  async close() {
    this.closing = true; this.pauseStarts(); await this.queue; const failures = [];
    for(const monitor of this.monitors.values())clearInterval(monitor);this.monitors.clear();
    for (const [id, handle] of this.handles) if (!handle.exit || handle.cleanupIncomplete) try { await this.stopNow(id); } catch (issue) { failures.push(issue.message); }
    if (failures.length) { this.closing = false; this.resumeStarts(); throw error('CLEANUP_INCOMPLETE', failures.join('; ')); }
  }
}
