import { mkdir, readFile, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectPackage, importPackage, instancePath, safeId } from '../../scripts/runtime/package.mjs';
import { startInstance, statusInstance, stopInstance, logsInstance, exportInstance } from '../../scripts/runtime/runtime.mjs';
import { ordinaryPath, privateJson, readBounded } from '../../scripts/runtime/paths.mjs';
import { ownProcess } from '../../scripts/runtime/process.mjs';
import { detectEnvironment, discoverEnvironment } from './environment.mjs';
import { planPythonEnvironment, preparePythonEnvironment, cleanupPreparedEnvironment } from './environment-prepare.mjs';
import { backupInstance, inspectBackup, restoreInstance, storageInstance, detachInstance, reattachInstance } from '../../scripts/runtime/maintenance.mjs';
import { inspectAuthoring, previewReplacement, derivePackage, rebuildPackage, exportProposal, applyProposal, addComment, readComments, exportComments, importComments } from '../../scripts/runtime/authoring.mjs';
import { readSourceIndex, fetchSourceArtifact, publishArtifact } from '../../scripts/runtime/sources.mjs';
import { loopbackUrl, mapTopology, managementLink } from './topology.mjs';
import { diagnose } from './diagnostics.mjs';
import { SourceRegistry } from './source-registry.mjs';
import { inspectTemplate, previewTemplate, instantiateTemplate, createTemplate } from '../../scripts/runtime/template.mjs';
import { previewUpgrade, upgradeInstance, inspectUpgradeHistory, previewRollback, rollbackUpgrade, recoverUpgrade } from '../../scripts/runtime/upgrade.mjs';
import { previewStagedUpgrade, createStagedUpgrade } from '../../scripts/runtime/staged-upgrade.mjs';
import { probeIsolation, reviewIsolationPackage } from '../../scripts/runtime/isolation.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export function launcherError(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
const errorOf = error => ({ code: error.code ?? 'LAUNCHER_ERROR', message: String(error.message).slice(0, 2048),
  diagnostic: diagnose(error),
  ...(error.incompleteDestination ? { incompleteDestination: error.incompleteDestination } : {}),
  ...(error.returnToOldInstance ? { returnToOldInstance: error.returnToOldInstance, oldInstancePreserved: error.oldInstancePreserved,
    candidateMayNeedRecovery: error.candidateMayNeedRecovery, candidateStateDir: error.candidateStateDir, backup: error.backup, rollbackBoundary: error.rollbackBoundary } : {}),
  ...(error.cleanupIncomplete ? { cleanupIncomplete: true, retainedDirectory: error.retainedDirectory } : {}) });
const json = async path => JSON.parse((await readBounded(path)).toString('utf8'));
const optionsFor = row => ({ root: row.root, instanceId: row.instanceId, ...row.environment });
async function hasRunArtifacts(directory) {
  for (const file of ['control.json', 'owner.lock']) try { await ordinaryPath(join(directory, file)); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await ordinaryPath(join(directory, 'runs')); return (await readdir(join(directory, 'runs'))).length > 0; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return false;
}

export class LauncherManager {
  constructor(options) {
    this.root = resolve(options.root); this.defaults = { nodePath: options.nodePath ?? process.execPath,
      pythonPath: options.pythonPath ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
    this.records = new Map(); this.reviews = new Map(); this.operations = new Map(); this.sessions = new Map();
    this.sourceRegistry = new SourceRegistry(this.root); this.sourceReviews = new Map(); this.completionReviews = new Map();
    this.busy = new Map(); this.registryQueue = Promise.resolve(); this.saveQueue = Promise.resolve(); this.environmentPlans = new Map(); this.preparationOwners = new Map(); this.url = ''; this.hub = null; this.hubFailure = null; this.closing = false;
  }
  async initialize() {
    await ordinaryPath(this.root, { allowMissing: true }); await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.sourceRegistry.initialize();
    try {
      const data = await json(join(this.root, 'launcher-instances.json'));
      if (!Array.isArray(data.instances) || data.instances.length > 128) throw new Error('Invalid Launcher instance registry');
      for (const row of data.instances) {
        safeId(row.instanceId); if (!row.environment || typeof row.environment.nodePath !== 'string') throw new Error('Invalid instance environment');
        this.records.set(row.instanceId, { ...row, root: this.root });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const sample = join(repository, 'examples/ecosystem-pack');
    try { await lstat(join(sample, 'pack.json')); this.defaults.packDirectory = sample; } catch {}
  }
  async save() {
    const action = this.saveQueue.then(() => privateJson(join(this.root, 'launcher-instances.json'), { format: 'world-hub.launcher-instances/v1', instances: [...this.records.values()] }));
    this.saveQueue = action.catch(() => {}); return action;
  }
  environment(input = {}) { return { nodePath: input.nodePath ?? this.defaults.nodePath, pythonPath: input.pythonPath ?? this.defaults.pythonPath }; }
  async detect(input) { const chosen = this.environment(input); const [environment, candidates] = await Promise.all([detectEnvironment(chosen), discoverEnvironment(chosen)]);
    return { environment, candidates, guidance: ['Select an installed interpreter and check again. Prepare the supported dependency in a reviewed private venv, or install other dependencies manually in your own private environment.'] }; }
  async isolationProbe(input) { return { probe: await probeIsolation(input) }; }
  async environmentPlan(input) {
    const plan = await planPythonEnvironment({ root: this.root, ...input, ...this.environment(input) }), planId = randomUUID();
    this.environmentPlans.set(planId, { plan, createdAt: Date.now() });
    while (this.environmentPlans.size > 32) this.environmentPlans.delete(this.environmentPlans.keys().next().value);
    return { planId, plan };
  }
  prepareEnvironment(planId, accepted) {
    if (this.preparationOwners.size) throw launcherError('CLEANUP_INCOMPLETE', 'Previous environment-tool exits remain unconfirmed. Retry cancellation before preparing another environment.');
    if (accepted !== true) throw launcherError('TRUST_REQUIRED', 'Accept the displayed source, exact wheel digest and private-environment operations.');
    const record = this.environmentPlans.get(planId);
    if (!record || Date.now() - record.createdAt > 10 * 60000) throw launcherError('ENVIRONMENT_PLAN_REQUIRED', 'Inspect a current environment preparation plan first.');
    const operation = this.launch('prepare-environment', '$environment', async (_, signal) => {
      try { return await preparePythonEnvironment({ root: this.root, plan: record.plan, signal }); }
      catch (error) { if (error.cleanupHandle) this.preparationOwners.set(operation.operationId, { handle: error.cleanupHandle, directory: record.plan.destination }); throw error; }
    });
    this.environmentPlans.delete(planId); return operation;
  }
  async clearPreparationOwner(id) {
    const owner = this.preparationOwners.get(id); if (!owner) return;
    if (!await owner.handle.stop()) throw launcherError('CLEANUP_INCOMPLETE', 'Environment-tool exit is still unconfirmed. Retain the private environment and retry cancellation.');
    await cleanupPreparedEnvironment(this.root, owner.directory); this.preparationOwners.delete(id);
    const operation = this.operations.get(id); if (operation?.error) { operation.error.cleanupIncomplete = false; delete operation.error.retainedDirectory; }
  }
  async cancelOperation(id) {
    const operation = this.operations.get(id); if (!operation) throw launcherError('OPERATION_NOT_FOUND', 'Unknown operation', 404);
    if (['stop', 'detach', 'reattach'].includes(operation.kind)) throw launcherError('CANCEL_UNAVAILABLE', 'Wait for this short consistency operation to finish.');
    operation.controller.abort(); await this.clearPreparationOwner(id); return this.publicOperation(operation);
  }
  async review(directory, environment, instanceId = null) {
    const chosen = this.environment(environment), plan = await inspectPackage(directory, chosen);
    const isolation = environment?.isolation ? await reviewIsolationPackage(plan, environment.isolation) : null;
    const old = instanceId ? this.records.get(instanceId)?.permissions ?? [] : [];
    const names = new Set([...old, ...plan.permissions].map(p => p.module));
    const permissionDiff = [...names].map(module => ({ module, before: old.find(p => p.module === module)?.declared ?? null,
      after: plan.permissions.find(p => p.module === module)?.declared ?? null })).filter(p => JSON.stringify(p.before) !== JSON.stringify(p.after));
    const row = instanceId ? this.records.get(instanceId) : null;
    const sourceReceipt = row?.sourceDigest === plan.digest ? row.sourceReceipt ?? null : await this.sourceRegistry.recognize(plan.directory);
    const reviewId = randomUUID(), created = Date.now();
    this.reviews.set(reviewId, { reviewId, plan, environment: chosen, isolation, instanceId, createdAt: created, sourceReceipt });
    while (this.reviews.size > 64) this.reviews.delete(this.reviews.keys().next().value);
    return { reviewId, review: plan, isolation, executionProfile: isolation?.profile ?? 'trusted-local', permissionDiff, sourceReceipt, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 10 * 60000).toISOString() };
  }
  reviewed(reviewId, instanceId) {
    const review = this.reviews.get(reviewId);
    if (!review || review.instanceId !== instanceId || Date.now() - review.createdAt > 10 * 60000)
      throw launcherError('REVIEW_REQUIRED', 'Inspect the current package and its environment before this action.');
    return review;
  }
  async verifyReview(review) {
    const actual = await inspectPackage(review.plan.directory, review.environment);
    if (actual.digest !== review.plan.digest) throw launcherError('REVIEW_CHANGED', 'Package, permissions or interpreter changed after review. Inspect again.');
    if (review.isolation && (await reviewIsolationPackage(actual, review.isolation.policy)).digest !== review.isolation.digest) throw launcherError('REVIEW_CHANGED', 'Isolation provider or image changed after review. Inspect again.');
    return actual;
  }
  row(id) { safeId(id); const row = this.records.get(id); if (!row) throw launcherError('INSTANCE_NOT_FOUND', 'Unknown Launcher instance', 404); return row; }
  async softwareState(row) {
    const directory = instancePath(this.root, row.instanceId);
    const found = async name => { try { const path = await ordinaryPath(join(directory, name)); return (await lstat(path)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
    const [active, quarantined] = await Promise.all([found('package'), found('detached-package')]);
    let marker = null;
    try { marker = await json(join(directory, 'detached.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const validMarker = marker?.format === 'world-hub.detached-instance/v1' && marker.instanceId === row.instanceId;
    if (active && !quarantined && marker === null) { row.detached = false; delete row.maintenanceUnknown; }
    else if (!active && quarantined && validMarker) { row.detached = true; delete row.maintenanceUnknown; }
    else row.maintenanceUnknown = true;
    return row;
  }
  async maintainedRow(id) {
    const row = await this.softwareState(this.row(id));
    if (row.maintenanceUnknown) throw launcherError('MAINTENANCE_UNKNOWN', 'Software layout is incomplete or ambiguous. Retain data and inspect package/detached-package and detached metadata before changing lifecycle state.');
    return row;
  }
  async import(reviewId, instanceId) {
    if (this.closing) throw launcherError('LAUNCHER_STOPPING', 'Launcher is stopping.');
    const action = this.registryQueue.then(() => this.importNow(reviewId, instanceId));
    this.registryQueue = action.catch(() => {}); return action;
  }
  async importNow(reviewId, instanceId) {
    safeId(instanceId); if (this.records.size >= 128) throw launcherError('INSTANCE_LIMIT', 'Launcher supports at most 128 tracked instances.');
    if (this.busy.has(instanceId)) throw launcherError('INSTANCE_BUSY', 'Wait for the reserved instance operation.');
    if (this.records.has(instanceId)) throw launcherError('INSTANCE_EXISTS', 'Choose a new instance ID; existing data is retained.');
    const reviewed = this.reviewed(reviewId, null); await this.verifyReview(reviewed);
    const imported = await importPackage(reviewed.plan.directory, { root: this.root, instanceId, ...reviewed.environment });
    if (imported.digest !== reviewed.plan.digest) throw launcherError('REVIEW_CHANGED', 'Source changed during import; incomplete instance is retained for inspection. Choose a new instance ID after review.');
    this.records.set(instanceId, { root: this.root, instanceId, pack: { id: imported.plan.pack.id, version: imported.plan.pack.version, title: imported.plan.pack.title },
      importedAt: new Date().toISOString(), environment: reviewed.environment, permissions: imported.plan.permissions,
      sourceReceipt: reviewed.sourceReceipt ?? null, sourceDigest: imported.digest });
    await this.save(); return this.instance(instanceId);
  }
  async instance(id) {
    const row = await this.softwareState(this.row(id)), stateDir = instancePath(this.root, id);
    let status;
    try { status = await statusInstance(optionsFor(row)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const history = await hasRunArtifacts(stateDir);
      status = { state: this.busy.get(id)?.kind === 'start' ? 'starting' : history ? 'unknown' : 'imported', instanceId: id, components: [], sandbox: false,
        ...(history ? { observation: 'stale', supervisorUnavailable: true } : {}) };
    }
    if (row.maintenanceUnknown) status = { ...status, state: 'maintenance-unknown', maintenanceUnknown: true };
    else if (row.detached) status = { ...status, state: 'detached', detached: true };
    const hub = !row.detached && !status.stoppedAt && status.observation !== 'stale' ? loopbackUrl(status.hub?.url) : null;
    const links = { entryUrl: status.state === 'running' ? loopbackUrl(status.entryUrl)?.href ?? null : null,
      managementUrl: hub ? managementLink({ hubUrl: hub.href, launcherUrl: this.url, instanceId: id, runId: status.runId }) : null,
      workbenchUrl: hub ? managementLink({ hubUrl: hub.href, launcherUrl: this.url, instanceId: id, runId: status.runId, workbench: true }) : null };
    return { id, instanceId: id, directory: stateDir, packageDirectory: join(stateDir, row.detached ? 'detached-package' : 'package'), ...row, status, links,
      operation: this.busy.get(id) ? this.publicOperation(this.busy.get(id)) : null };
  }
  async instances() { return Promise.all([...this.records.keys()].map(id => this.instance(id))); }
  async reviewInstance(id, environment = {}) {
    const row = await this.maintainedRow(id);
    return this.review(join(instancePath(this.root, id), row.detached ? 'detached-package' : 'package'), { ...row.environment, ...environment }, id);
  }
  publicOperation(operation) { const { promise, controller, ...value } = operation; return value; }
  operation(id) { const operation = this.operations.get(id); if (!operation) throw launcherError('OPERATION_NOT_FOUND', 'Unknown operation', 404); return this.publicOperation(operation); }
  launch(kind, instanceId, work) {
    if (this.closing) throw launcherError('LAUNCHER_STOPPING', 'Launcher is stopping.');
    if (kind !== 'stop' && this.busy.has(instanceId)) throw launcherError('INSTANCE_BUSY', 'Wait for this instance operation to complete.');
    const previous = this.busy.get(instanceId), operation = { id: randomUUID(), kind, instanceId, state: 'running', startedAt: new Date().toISOString(), controller: new AbortController() };
    this.operations.set(operation.id, operation); this.busy.set(instanceId, operation);
    operation.promise = Promise.resolve().then(() => work(previous, operation.controller.signal)).then(result => { operation.result = result; operation.state = 'succeeded'; }, error => { operation.error = errorOf(error); operation.state = 'failed'; }).finally(() => {
      operation.finishedAt = new Date().toISOString(); if (this.busy.get(instanceId) === operation) this.busy.delete(instanceId);
      for (const [id, old] of this.operations) if (this.operations.size > 128 && old.state !== 'running') this.operations.delete(id);
    });
    return { operationId: operation.id };
  }
  async start(id, reviewId, accepted, restart = false) {
    if (accepted !== true) throw launcherError('TRUST_REQUIRED', 'Explicitly accept the displayed current local code and permissions.');
    const row = await this.maintainedRow(id); if (row.detached) throw launcherError('INSTANCE_DETACHED', 'Restore the quarantined software after review before starting.');
    const reviewed = this.reviewed(reviewId, id); await this.verifyReview(reviewed);
    return this.launch(restart ? 'restart' : 'start', id, async (_, signal) => {
      if (restart) await this.stopNow(id);
      try {
        const session = await startInstance({ ...optionsFor(row), ...reviewed.environment, trust: reviewed.plan.digest,
          ...(reviewed.isolation ? { isolation: reviewed.isolation.policy, isolationTrust: reviewed.isolation.digest } : {}), signal });
        this.sessions.set(id, session);
        void session.closed.then(state => { if (state.stoppedAt && !state.cleanupIncomplete && this.sessions.get(id) === session) this.sessions.delete(id); });
        return await this.instance(id);
      } catch (error) {
        if (error.runtimeSession) {
          const state = await error.runtimeSession.status();
          if (!state.stoppedAt || state.cleanupIncomplete) this.sessions.set(id, error.runtimeSession);
        }
        throw error;
      }
    });
  }
  async stopNow(id) {
    const session = this.sessions.get(id);
    if (session) {
      const state = await session.close(); if (!state.stoppedAt || state.cleanupIncomplete) throw launcherError('CLEANUP_INCOMPLETE', 'Owned process exits remain unconfirmed; retry stop.');
      this.sessions.delete(id); return state;
    }
    const row = this.row(id);
    try {
      const state = await stopInstance(optionsFor(row));
      if (!state.stoppedAt || state.cleanupIncomplete) throw launcherError('CLEANUP_INCOMPLETE', 'Owned process exits remain unconfirmed; retry stop.');
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const directory = instancePath(this.root, id);
      let state = null;
      try { state = await json(join(directory, 'status.json')); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      if (state?.runId || await hasRunArtifacts(directory)) throw launcherError('STOP_UNCONFIRMED', 'A run or owner exists but its control record is unavailable. Owned process exits remain unconfirmed.');
      return { state: 'imported', components: [] };
    }
  }
  stop(id) {
    this.row(id); this.busy.get(id)?.controller.abort();
    return this.launch('stop', id, async previous => { if (previous) await previous.promise; return this.stopNow(id); });
  }
  export(id, destination) { const row = this.row(id); return this.launch('export', id, () => exportInstance({ ...optionsFor(row), destination })); }
  storage(id) { return storageInstance(optionsFor(this.row(id))); }
  inspectBackup(backup) { return inspectBackup(backup); }
  backup(id, destination, accepted) {
    if (accepted !== true) throw launcherError('TRUST_REQUIRED', 'A private backup can contain application data and secrets. Accept the displayed backup destination.');
    const row = this.row(id); return this.launch('backup', id, (_, signal) => backupInstance({ ...optionsFor(row), destination, signal }));
  }
  async restore(input) {
    if (input.accepted !== true || !/^[a-f0-9]{64}$/.test(input.sha256 ?? '')) throw launcherError('BACKUP_REVIEW_REQUIRED', 'Inspect the private backup and explicitly confirm its current digest before restoring.');
    const env = this.environment(input); safeId(input.instanceId);
    const inspection = await inspectBackup(input.backup);
    if (inspection.sha256 !== input.sha256) throw launcherError('BACKUP_CHANGED', 'Backup changed after inspection. Inspect it again.');
    if (!inspection.compatible) throw launcherError('BACKUP_INCOMPATIBLE', 'Backup requires a compatible Hub version, OS and architecture: ' + inspection.incompatibilities.join('; '));
    return this.launch('restore', input.instanceId, (_, signal) => {
      const action = this.registryQueue.then(async () => {
        if (this.records.has(input.instanceId) || this.records.size >= 128) throw launcherError('INSTANCE_EXISTS', 'Choose a new instance ID. Existing instances are retained.');
        const restored = await restoreInstance({ root: this.root, instanceId: input.instanceId, backup: input.backup, expectedSha256: input.sha256, ...env, signal });
        this.records.set(input.instanceId, { root: this.root, instanceId: input.instanceId, pack: { id: restored.plan.pack.id, version: restored.plan.pack.version, title: restored.plan.pack.title },
          importedAt: new Date().toISOString(), restoredFrom: restored.restoredFrom, environment: env, permissions: restored.plan.permissions });
        await this.save(); return { instance: await this.instance(input.instanceId) };
      }); this.registryQueue = action.catch(() => {}); return action;
    });
  }
  detach(id, accepted) {
    if (accepted !== true) throw launcherError('TRUST_REQUIRED', 'Confirm that software will be detached while its private data is retained.');
    const row = this.row(id); return this.launch('detach', id, async () => { const result = await detachInstance(optionsFor(row)); row.detached = true; await this.save(); return result; });
  }
  async reattach(id, reviewId, accepted) {
    if (accepted !== true) throw launcherError('TRUST_REQUIRED', 'Accept the current software and environment review before reattaching.');
    const row = await this.maintainedRow(id), review = this.reviewed(reviewId, id); await this.verifyReview(review);
    if (!row.detached) throw launcherError('INSTANCE_ATTACHED', 'This instance software is already attached.');
    return this.launch('reattach', id, async () => { const result = await reattachInstance({ ...optionsFor(row), ...review.environment, trust: review.plan.digest });
      row.detached = false; row.environment = review.environment; row.permissions = result.plan.permissions; await this.save(); return result; });
  }
  authoring(input) { return inspectAuthoring(input.directory, this.environment(input)); }
  previewReplacement(input) { return previewReplacement(input.directory, { ...input, ...this.environment(input) }); }
  async commentDirectory(directory) {
    const source = await ordinaryPath(directory), key = createHash('sha256').update(process.platform === 'win32' ? source.toLowerCase() : source).digest('hex');
    const journal = join(this.root, 'creator-comments', key); await ordinaryPath(journal, { allowMissing: true }); await mkdir(journal, { recursive: true, mode: 0o700 });
    return journal;
  }
  async comments(input) { return readComments(await this.commentDirectory(input.directory)); }
  sources() { return this.sourceRegistry.list(); }
  saveSource(input) { return this.sourceRegistry.save(input); }
  deleteSource(id) { return this.sourceRegistry.delete(id); }
  async source(input) {
    const chosen = await this.sourceRegistry.resolve(input);
    try {
      const result = await readSourceIndex(chosen.source, { expectedSha256: chosen.expectedSha256, allowPrivateNetwork: chosen.allowPrivateNetwork });
      await this.sourceRegistry.assertCurrent(chosen); await this.sourceRegistry.observed(chosen, result);
      const receiptId = randomUUID(), created = Date.now(); this.sourceReviews.set(receiptId, { chosen, result, created });
      while (this.sourceReviews.size > 64) this.sourceReviews.delete(this.sourceReviews.keys().next().value);
      return { ...result, receiptId, sourceId: chosen.sourceId ?? null, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 10 * 60000).toISOString() };
    } catch (error) { await this.sourceRegistry.unavailable(chosen); throw error; }
  }
  creator(kind, input) {
    const key = '$creator-' + createHash('sha256').update(resolve(input.directory ?? this.root)).digest('hex');
    return this.launch(kind, key, async (_, signal) => {
      const options = { ...input, ...this.environment(input), signal };
      if (kind === 'derive') return derivePackage(input.directory, options);
      if (kind === 'rebuild') return rebuildPackage(input.directory, options);
      if (kind === 'proposal') return exportProposal(input.directory, options);
      if (kind === 'apply-proposal') return applyProposal(input.directory, input.proposalDirectory, options);
      if (kind === 'comment') return addComment(await this.commentDirectory(input.directory), options);
      if (kind === 'export-comments') return exportComments(await this.commentDirectory(input.directory), options);
      if (kind === 'import-comments') return importComments(await this.commentDirectory(input.directory), input.source, options);
      if (kind === 'publish') return publishArtifact(input.directory, options);
      throw launcherError('NOT_FOUND', 'Unknown creator operation', 404);
    });
  }
  rememberCompletion(kind, input, preview, instanceId = null) {
    const previewId = randomUUID(), createdAt = Date.now();
    this.completionReviews.set(previewId, { kind, input: structuredClone(input), preview, instanceId, createdAt });
    while (this.completionReviews.size > 64) this.completionReviews.delete(this.completionReviews.keys().next().value);
    return { previewId, preview, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + 10 * 60000).toISOString() };
  }
  completionReview(previewId, kind, instanceId = null) {
    const review = this.completionReviews.get(previewId);
    if (!review || review.kind !== kind || review.instanceId !== instanceId || Date.now() - review.createdAt > 10 * 60000)
      throw launcherError('REVIEW_REQUIRED', 'Inspect a current preview for this exact operation first.');
    return review;
  }
  async templateInspect(input) { return { inspection: await inspectTemplate(input.directory) }; }
  async templatePreview(input) {
    const preview = await previewTemplate(input.directory, { values: input.values, identity: input.identity });
    return this.rememberCompletion('template', input, preview);
  }
  templateInstantiate(input) {
    if (input.redistributionAcknowledged !== true) throw launcherError('LICENSE_ACKNOWLEDGEMENT_REQUIRED', 'Review redistribution and template licenses first.');
    const review = this.completionReview(input.previewId, 'template');
    const result = this.launch('instantiate-template', '$creator-' + resolve(input.destination), async (_, signal) => instantiateTemplate(review.input.directory, {
      values: review.input.values, identity: review.input.identity, destination: input.destination,
      expectedRevision: review.preview.templateRevision, expectedPreviewDigest: review.preview.previewDigest,
      expectedParameterDigest: review.preview.parameterDigest, redistributionAcknowledged: true, signal }));
    this.completionReviews.delete(input.previewId); return result;
  }
  templateCreate(input) {
    if (input.redistributionAcknowledged !== true) throw launcherError('LICENSE_ACKNOWLEDGEMENT_REQUIRED', 'Review redistribution and template licenses first.');
    return this.launch('create-template', '$creator-' + resolve(input.destination), async (_, signal) => createTemplate(input.directory, { ...input, signal }));
  }
  async upgradePreview(id, input) {
    const row = await this.maintainedRow(id); if (row.detached) throw launcherError('INSTANCE_DETACHED', 'Reattach software before upgrading.');
    if (this.busy.has(id)) throw launcherError('INSTANCE_BUSY', 'Wait for the current instance operation.');
    const options = { ...optionsFor(row), candidate: input.candidate, statePolicies: input.statePolicies };
    return this.rememberCompletion('upgrade', options, await previewUpgrade(options), id);
  }
  async stagedUpgradePreview(id, input) {
    const row = await this.maintainedRow(id);
    if (row.detached) throw launcherError('INSTANCE_DETACHED', 'Reattach software before preparing an upgrade.');
    if (this.busy.has(id) || this.busy.has(input.newInstanceId)) throw launcherError('INSTANCE_BUSY', 'Wait for the current instance operation.');
    safeId(input.newInstanceId);
    if (this.records.has(input.newInstanceId)) throw launcherError('INSTANCE_EXISTS', 'Choose a new instance ID.');
    const options = { ...optionsFor(row), candidate: input.candidate, newInstanceId: input.newInstanceId,
      backupDestination: input.backupDestination, statePolicy: input.statePolicy, ...(input.statePolicies ? { statePolicies: input.statePolicies } : {}) };
    return this.rememberCompletion('staged-upgrade', options, await previewStagedUpgrade(options), id);
  }
  async stagedUpgradeExecute(id, input) {
    if (input.accepted !== true) throw launcherError('TRUST_REQUIRED', 'Accept the candidate, data policy and private backup.');
    const review = this.completionReview(input.previewId, 'staged-upgrade', id), newId = review.input.newInstanceId;
    if (this.busy.has(newId) || this.records.has(newId) || this.records.size >= 128) throw launcherError('INSTANCE_EXISTS', 'Choose an available new instance ID within the instance limit.');
    const operation = this.launch('staged-upgrade', id, async (_, signal) => {
      const result = await createStagedUpgrade({ ...review.input, trust: review.preview.trustDigest, signal });
      this.records.set(newId, { root: this.root, instanceId: newId, pack: { id: result.plan.pack.id, version: result.plan.pack.version, title: result.plan.pack.title },
        importedAt: new Date().toISOString(), environment: this.row(id).environment, permissions: result.plan.permissions,
        sourceReceipt: null, sourceDigest: null, stagedFrom: id, backup: { destination: result.backup.destination, sha256: result.backup.sha256 } });
      await this.save(); return { ...result, instance: await this.instance(newId) };
    });
    const pending = this.operations.get(operation.operationId); this.busy.set(newId, pending);
    pending.promise.finally(() => { if (this.busy.get(newId) === pending) this.busy.delete(newId); });
    this.completionReviews.delete(input.previewId); return operation;
  }
  async rollbackPreview(id, input) {
    const row = this.row(id); if (this.busy.has(id)) throw launcherError('INSTANCE_BUSY', 'Wait for the current instance operation.');
    const options = { ...optionsFor(row), transactionId: input.transactionId };
    return this.rememberCompletion('rollback', options, await previewRollback(options), id);
  }
  async upgradeHistory(id) { return { history: await inspectUpgradeHistory(optionsFor(this.row(id))) }; }
  async completionExecute(id, kind, input) {
    if (input.accepted !== true) throw launcherError('TRUST_REQUIRED', 'Explicitly accept the displayed code, data policy and snapshot.');
    const review = this.completionReview(input.previewId, kind === 'upgrade' ? 'upgrade' : 'rollback', id);
    if (kind === 'recover-upgrade' && review.preview.recoveryRequired !== true) throw launcherError('RECOVERY_NOT_REQUIRED', 'This transaction is not interrupted; use reviewed rollback.');
    const operation = this.launch(kind, id, async (_, signal) => {
      const options = { ...review.input, trust: review.preview.trustDigest, signal };
      const result = await (kind === 'upgrade' ? upgradeInstance(options) : kind === 'recover-upgrade' ? recoverUpgrade(options) : rollbackUpgrade(options));
      const row = this.row(id), plan = await inspectPackage(join(instancePath(this.root, id), 'package'), row.environment);
      row.pack = { id: plan.pack.id, version: plan.pack.version, title: plan.pack.title }; row.permissions = plan.permissions;
      row.sourceReceipt = null; row.sourceDigest = null; row.updatedAt = new Date().toISOString(); await this.save();
      for (const [key, value] of this.reviews) if (value.instanceId === id) this.reviews.delete(key);
      return { ...result, instance: await this.instance(id), requiresNewExecutionReview: true };
    });
    this.completionReviews.delete(input.previewId); return operation;
  }
  fetchSource(input) {
    const key = '$source-cache';
    return this.launch('fetch-source', key, async (_, signal) => {
      const chosen = await this.sourceRegistry.resolve(input); let indexDigest = input.indexDigest;
      if (input.receiptId !== undefined) {
        const receipt = this.sourceReviews.get(input.receiptId);
        if (!receipt || Date.now() - receipt.created > 10 * 60000 || receipt.chosen.source !== chosen.source || receipt.chosen.revision !== chosen.revision
          || receipt.chosen.sourceId !== chosen.sourceId || receipt.chosen.allowPrivateNetwork !== chosen.allowPrivateNetwork
          || receipt.chosen.expectedSha256 !== chosen.expectedSha256) throw launcherError('SOURCE_REVIEW_REQUIRED', 'Inspect this current source configuration again.');
        indexDigest = receipt.result.digest;
      } else if (input.sourceId) throw launcherError('SOURCE_REVIEW_REQUIRED', 'Inspect the registered source and supply its current receiptId.');
      const result = await fetchSourceArtifact(chosen.source, indexDigest, input.entryId, { cacheRoot: join(this.root, 'source-cache'), allowPrivateNetwork: chosen.allowPrivateNetwork, signal });
      await this.sourceRegistry.assertCurrent(chosen);
      return { ...result, sourceReceipt: await this.sourceRegistry.recordFetch(chosen, { ...result, indexDigest }) };
    });
  }
  async logs(id) {
    const row = this.row(id);
    try { return await logsInstance(optionsFor(row)); } catch (error) { if (error.code === 'ENOENT') return { format: 'world-hub.runtime-logs/v1', instanceId: id, logs: {} }; throw error; }
  }
  async topology(id, runId) {
    const instance = await this.instance(id), status = instance.status;
    if (runId !== undefined && runId !== status.runId) throw launcherError('STALE_RUN', 'This link belongs to a different or ended instance run.');
    const hub = !status.stoppedAt && status.observation !== 'stale' ? loopbackUrl(status.hub?.url, { rootOnly: true }) : null;
    let snapshot = null;
    if (hub) {
      const response = await fetch(new URL('/status', hub), { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!response.ok) throw launcherError('HUB_UNAVAILABLE', 'The instance Hub is unavailable.'); snapshot = await response.json();
    }
    return mapTopology({ instanceId: id, status, snapshot, launcherUrl: this.url });
  }
  async hubs() {
    const rows = [{ id: 'default', managedBy: 'launcher', state: this.hub && !this.hub.exit ? 'running' : this.hubFailure ? 'failed' : 'stopped',
      url: this.hub?.url ?? null, managementUrl: this.hub && !this.hub.exit ? managementLink({ hubUrl: this.hub.url, launcherUrl: this.url }) : null,
      workbenchUrl: this.hub && !this.hub.exit ? managementLink({ hubUrl: this.hub.url, launcherUrl: this.url, workbench: true }) : null, ownership: 'external', error: this.hubFailure }];
    for (const instance of await this.instances()) rows.push({ id: instance.instanceId, managedBy: 'runtime', state: instance.status.state,
      url: instance.status.hub?.url ?? null, ...instance.links });
    return rows;
  }
  defaultHub(kind) {
    if (kind === 'stop') this.busy.get('$default')?.controller.abort();
    return this.launch(kind, '$default', async (previous, signal) => {
      if (kind === 'stop' && previous) await previous.promise;
      if (kind === 'stop') { if (this.hub) await this.hub.stop(5000); if (this.hub && !this.hub.exit) throw launcherError('CLEANUP_INCOMPLETE', 'Default Hub exit unconfirmed.'); return { stopped: true }; }
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
        this.hub.url = `http://127.0.0.1:${ready.port}`; return { url: this.hub.url };
      } catch (error) { await this.hub.stop(1000); throw error; }
    });
  }
  async close() {
    this.closing = true;
    for (const op of this.operations.values()) if (op.state === 'running') op.controller.abort();
    await this.registryQueue;
    await Promise.all([...this.operations.values()].filter(op => op.state === 'running').map(op => op.promise));
    await this.saveQueue;
    const errors = [];
    for (const [id] of this.preparationOwners) try { await this.clearPreparationOwner(id); } catch (error) { errors.push(error); }
    for (const [id] of this.sessions) try { await this.stopNow(id); } catch (error) { errors.push(error); }
    if (this.hub) try { await this.hub.stop(5000); if (!this.hub.exit) throw new Error('Default Hub exit unconfirmed'); } catch (error) { errors.push(error); }
    if (errors.length) { this.closing = false; throw launcherError('CLEANUP_INCOMPLETE', errors.map(e => e.message).join('; ')); }
  }
}
