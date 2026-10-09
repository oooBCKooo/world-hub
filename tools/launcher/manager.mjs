import { mkdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectPackage, importPackage, instancePath, safeId } from '../../scripts/runtime/package.mjs';
import { startInstance, statusInstance, stopInstance, logsInstance, exportInstance } from '../../scripts/runtime/runtime.mjs';
import { ordinaryPath, privateJson, readBounded } from '../../scripts/runtime/paths.mjs';
import { ownProcess } from '../../scripts/runtime/process.mjs';
import { detectEnvironment } from './environment.mjs';
import { loopbackUrl, mapTopology, managementLink } from './topology.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export function launcherError(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
const errorOf = error => ({ code: error.code ?? 'LAUNCHER_ERROR', message: String(error.message).slice(0, 2048) });
const json = async path => JSON.parse((await readBounded(path)).toString('utf8'));
const optionsFor = row => ({ root: row.root, instanceId: row.instanceId, ...row.environment });

export class LauncherManager {
  constructor(options) {
    this.root = resolve(options.root); this.defaults = { nodePath: options.nodePath ?? process.execPath,
      pythonPath: options.pythonPath ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
    this.records = new Map(); this.reviews = new Map(); this.operations = new Map(); this.sessions = new Map();
    this.busy = new Map(); this.registryQueue = Promise.resolve(); this.url = ''; this.hub = null; this.hubFailure = null; this.closing = false;
  }
  async initialize() {
    await ordinaryPath(this.root, { allowMissing: true }); await mkdir(this.root, { recursive: true, mode: 0o700 });
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
  async save() { await privateJson(join(this.root, 'launcher-instances.json'), { format: 'world-hub.launcher-instances/v1', instances: [...this.records.values()] }); }
  environment(input = {}) { return { nodePath: input.nodePath ?? this.defaults.nodePath, pythonPath: input.pythonPath ?? this.defaults.pythonPath }; }
  async detect(input) { return { environment: await detectEnvironment(this.environment(input)), guidance: ['Install required dependencies in your selected environment, then check again. No automatic installation.'] }; }
  async review(directory, environment, instanceId = null) {
    const chosen = this.environment(environment), plan = await inspectPackage(directory, chosen);
    const old = instanceId ? this.records.get(instanceId)?.permissions ?? [] : [];
    const names = new Set([...old, ...plan.permissions].map(p => p.module));
    const permissionDiff = [...names].map(module => ({ module, before: old.find(p => p.module === module)?.declared ?? null,
      after: plan.permissions.find(p => p.module === module)?.declared ?? null })).filter(p => JSON.stringify(p.before) !== JSON.stringify(p.after));
    const reviewId = randomUUID();
    this.reviews.set(reviewId, { reviewId, plan, environment: chosen, instanceId, createdAt: Date.now() });
    while (this.reviews.size > 64) this.reviews.delete(this.reviews.keys().next().value);
    return { reviewId, review: plan, permissionDiff };
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
    return actual;
  }
  row(id) { safeId(id); const row = this.records.get(id); if (!row) throw launcherError('INSTANCE_NOT_FOUND', 'Unknown Launcher instance', 404); return row; }
  async import(reviewId, instanceId) {
    if (this.closing) throw launcherError('LAUNCHER_STOPPING', 'Launcher is stopping.');
    const action = this.registryQueue.then(() => this.importNow(reviewId, instanceId));
    this.registryQueue = action.catch(() => {}); return action;
  }
  async importNow(reviewId, instanceId) {
    safeId(instanceId); if (this.records.size >= 128) throw launcherError('INSTANCE_LIMIT', 'Launcher supports at most 128 tracked instances.');
    if (this.records.has(instanceId)) throw launcherError('INSTANCE_EXISTS', 'Choose a new instance ID; existing data is retained.');
    const reviewed = this.reviewed(reviewId, null); await this.verifyReview(reviewed);
    const imported = await importPackage(reviewed.plan.directory, { root: this.root, instanceId, ...reviewed.environment });
    if (imported.digest !== reviewed.plan.digest) throw launcherError('REVIEW_CHANGED', 'Source changed during import; incomplete instance is retained for inspection. Choose a new instance ID after review.');
    this.records.set(instanceId, { root: this.root, instanceId, pack: { id: imported.plan.pack.id, version: imported.plan.pack.version, title: imported.plan.pack.title },
      importedAt: new Date().toISOString(), environment: reviewed.environment, permissions: imported.plan.permissions });
    await this.save(); return this.instance(instanceId);
  }
  async instance(id) {
    const row = this.row(id), stateDir = instancePath(this.root, id);
    let status;
    try { status = await statusInstance(optionsFor(row)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      status = { state: this.busy.get(id)?.kind === 'start' ? 'starting' : 'imported', instanceId: id, components: [], sandbox: false };
    }
    const hub = !status.stoppedAt && status.observation !== 'stale' ? loopbackUrl(status.hub?.url) : null;
    const links = { entryUrl: status.state === 'running' ? loopbackUrl(status.entryUrl)?.href ?? null : null,
      managementUrl: hub ? managementLink({ hubUrl: hub.href, launcherUrl: this.url, instanceId: id, runId: status.runId }) : null,
      workbenchUrl: hub ? managementLink({ hubUrl: hub.href, launcherUrl: this.url, instanceId: id, runId: status.runId, workbench: true }) : null };
    return { id, instanceId: id, directory: stateDir, packageDirectory: join(stateDir, 'package'), ...row, status, links,
      operation: this.busy.get(id) ? this.publicOperation(this.busy.get(id)) : null };
  }
  async instances() { return Promise.all([...this.records.keys()].map(id => this.instance(id))); }
  async reviewInstance(id, environment = {}) {
    const row = this.row(id);
    return this.review(join(instancePath(this.root, id), 'package'), { ...row.environment, ...environment }, id);
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
    const row = this.row(id), reviewed = this.reviewed(reviewId, id); await this.verifyReview(reviewed);
    return this.launch(restart ? 'restart' : 'start', id, async (_, signal) => {
      if (restart) await this.stopNow(id);
      try {
        const session = await startInstance({ ...optionsFor(row), ...reviewed.environment, trust: reviewed.plan.digest, signal });
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
    } catch (error) { if (error.code === 'ENOENT') return { state: 'imported', components: [] }; throw error; }
  }
  stop(id) {
    this.row(id); this.busy.get(id)?.controller.abort();
    return this.launch('stop', id, async previous => { if (previous) await previous.promise; return this.stopNow(id); });
  }
  export(id, destination) { const row = this.row(id); return this.launch('export', id, () => exportInstance({ ...optionsFor(row), destination })); }
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
    const errors = [];
    for (const [id] of this.sessions) try { await this.stopNow(id); } catch (error) { errors.push(error); }
    if (this.hub) try { await this.hub.stop(5000); if (!this.hub.exit) throw new Error('Default Hub exit unconfirmed'); } catch (error) { errors.push(error); }
    if (errors.length) { this.closing = false; throw launcherError('CLEANUP_INCOMPLETE', errors.map(e => e.message).join('; ')); }
  }
}
