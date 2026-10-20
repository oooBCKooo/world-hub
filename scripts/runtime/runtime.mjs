// Independent, optional local deployment supervisor. Business remains in peers.
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { inspectPackage, instancePath, repository, copyPackage } from './package.mjs';
import { hash, ordinaryPath, privateJson, readBounded } from './paths.mjs';
import { ownProcess } from './process.mjs';
import { assertNoIncompleteUpgrades } from './upgrade.mjs';
import { reviewIsolationPackage, planIsolation, ownIsolatedProcess } from './isolation.mjs';
import { writeExistingUserConfiguration } from './isolation-user.mjs';
import { prepareDependencies } from './dependency-prepare.mjs';
import { ownHostedProcess } from './host-process.mjs';
import { deploymentTopics } from './deployment.mjs';
import { RUNTIME_API } from './compatibility.mjs';
import { DynamicAssembly } from './dynamic-assembly.mjs';
import { assertNoIncompleteAssemblySaves } from './assembly-save.mjs';
import { effectivePackType, effectiveLifecyclePolicy, componentAutostarts, summarizePack } from './pack-paradigms.mjs';
import { collectSourceFiles } from './source-guidance.mjs';
export { inspectPackage, importPackage, createLock } from './package.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = value => value.length <= 64 ? value : value.slice(0, 47) + '.' + hash(value).slice(0, 16);
const json = async file => JSON.parse((await readBounded(file)).toString('utf8'));
// Preserve the normal persistent main module and encoded-source semantics when
// Python's Windows initialization cannot derive a long script import directory.
const longPythonEntry = `import sys
sys.path.pop(0)
import os,importlib.machinery
def _launch():
 entry=sys.argv[1]
 sys.argv=sys.argv[1:]
 sys.path.insert(0,os.path.dirname(entry))
 with open(entry,'rb') as source:
  code=compile(source.read(),entry,'exec')
 namespace=sys.modules['__main__'].__dict__
 initial={'__name__':'__main__','__file__':entry,'__spec__':None,'__package__':None,'__cached__':None,'__doc__':None,'__loader__':importlib.machinery.SourceFileLoader('__main__',entry),'__builtins__':__builtins__}
 namespace.clear()
 namespace.update(initial)
 exec(code,namespace)
_launch()
`;
const publicError = error => ({ code: error.code ?? 'RUNTIME_ERROR', message: String(error.message ?? error).slice(0, 2048) });
function bearerEquals(actual, wanted) { if (typeof actual !== 'string') return false; const a = Buffer.from(actual), b = Buffer.from(wanted); return a.length === b.length && timingSafeEqual(a, b); }
export async function startInstance(options) {
  const stateDir = instancePath(options.root, options.instanceId); await ordinaryPath(stateDir);
  await assertNoIncompleteUpgrades(stateDir);
  await assertNoIncompleteAssemblySaves(stateDir);
  const plan = await inspectPackage(join(stateDir, 'package'), options);
  const startupMode = options.startupMode ?? 'plan';
  if (!['plan', 'hub-only'].includes(startupMode)) throw Object.assign(new Error('Choose plan or hub-only startup.'), { code: 'STARTUP_MODE_INVALID' });
  if (options.signal?.aborted) throw new Error('Runtime startup aborted');
  if (options.trust !== plan.digest) throw new Error(`Local executable code and declared permissions must be explicitly trusted with current review digest: ${plan.digest}`);
  if (options.isolation && effectivePackType(plan.pack) === 'mesh') throw Object.assign(new Error('Mesh startup currently requires the explicitly reviewed trusted-local profile. No isolation policy was relaxed.'), { code: 'MESH_ISOLATION_UNSUPPORTED' });
  if (options.isolation && (startupMode === 'hub-only' || plan.pack.components.some(component => !componentAutostarts(plan.pack, component)))) throw Object.assign(new Error('Partial and Hub-only startup currently require the explicitly reviewed trusted-local profile. No isolation policy was relaxed.'), { code: 'STARTUP_PLAN_ISOLATION_UNSUPPORTED' });
  const isolation = options.isolation ? await reviewIsolationPackage(plan, options.isolation) : null;
  const userExecution = isolation?.profile === 'linux-existing-user/v1';
  if (isolation && options.isolationTrust !== isolation.digest) throw Object.assign(new Error('Review the current package isolation policy, Docker executable and image before starting'), { code: 'ISOLATION_REVIEW_REQUIRED' });
  if (!isolation && options.isolationTrust !== undefined) throw Object.assign(new Error('An isolation review cannot be used for trusted-local execution'), { code: 'ISOLATION_REVIEW_REQUIRED' });
  const recorded = await json(join(stateDir, 'instance.json'));
  if (recorded.hubVersion !== plan.hubVersion) throw Object.assign(new Error('Hub state belongs to another or unknown installed release; state migration must be explicit.'), { code: 'INSTANCE_HUB_STATE_VERSION' });
  if (recorded.instanceId !== options.instanceId || recorded.digest !== plan.digest) throw new Error('Instance review has changed; export/reimport and review this package/environment before starting');
  const lockFile = join(stateDir, 'owner.lock'), nonce = randomUUID();
  await ordinaryPath(lockFile, { allowMissing: true });
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Instance locked: ${lockFile}; stop its supervisor or inspect an abandoned lock manually. Stored PIDs are never killed.`); throw error; }
  await lock.writeFile(JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString() }) + '\n'); await lock.close();
  const runDir = join(stateDir, 'runs', nonce);
  const children = [], components = [], userConfigurationFiles = [], tokens = new Map(), peers = {}, startingComponents = new Set();
  const controlToken = randomUUID(); const secrets = [controlToken];
  for (const c of plan.pack.components) {
    const token = randomUUID(); tokens.set(c.id, token); secrets.push(token); peers[c.id] = { principal: identity(`runtime.${c.id}`) };
    components.push({ id: c.id, module: c.module, pid: null, process: 'stopped', neverStarted: true, ownership: 'managed', origin: 'baseline',
      principal: peers[c.id].principal, autostart: c.autostart ?? true, critical: c.critical ?? false,
      expectedBridges: Object.keys(c.bridges).map(slot => identity(`runtime.${c.id}.${slot}`)), communication: 'disconnected', readiness: 'not-ready', health: { ready: false, lastCheckedAt: null }, bridges: [] });
  }
  let hub, control, monitoring, assembly, closing = null, startupDone = false, persistQueue = Promise.resolve();
  const operationController = new AbortController();
  const startupController = new AbortController(); let startupCancelled = false;
  const cancelStartup = () => { startupCancelled = true; startupController.abort(); };
  let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
  const state = { format: 'world-hub.runtime-status/v1', instanceId: options.instanceId, state: 'starting', runId: nonce,
    pack: summarizePack(plan.pack), startupMode, reviewDigest: plan.digest, components, hub: null, sandbox: false,
    executionProfile: isolation?.profile ?? 'trusted-local', ...(isolation ? { isolation: { profile: isolation.profile, image: isolation.image ?? null, images: isolation.images ?? null, limits: isolation.limits ?? null, identitySeparation: userExecution, reviewDigest: isolation.digest, appliesTo: 'components', hubOnHost: true } } : {}), startedAt: new Date().toISOString() };
  const statusFile = join(stateDir, 'status.json');
  const snapshot = () => JSON.parse(JSON.stringify(state));
  const persist = () => { const value = snapshot(); persistQueue = persistQueue.catch(() => {}).then(() => privateJson(statusFile, value)); return persistQueue; };
  const logs = () => ({ format: 'world-hub.runtime-logs/v1', instanceId: options.instanceId, runId: nonce, observedAt: new Date().toISOString(),
    logs: Object.fromEntries(children.map(h => [h.id, { pid: h.pid, stdout: h.stdout, stderr: h.stderr, truncated: h.truncated }])) });
  const close = () => closing ??= (async () => {
    options.signal?.removeEventListener('abort', abort);
    clearInterval(monitoring); operationController.abort(); if (state.state !== 'failed') state.state = 'stopping';
    await assembly?.shutdown();
    const failures = [];
    const attempt = async operation => { try { await operation(); } catch (error) { failures.push(publicError(error)); } };
    // Journal failure must never prevent best-effort shutdown of owned children.
    await attempt(persist);
    for (const h of [...children].reverse()) {
      try { await h.stop(plan.pack.stopTimeoutMs); }
      catch (error) { failures.push(publicError(error)); }
      const c = components.find(c => c.id === h.id);
      if (c) { c.process = h.exit ? 'exited' : 'failed'; c.communication = h.exit ? 'disconnected' : 'unknown'; c.readiness = 'not-ready'; c.health.ready = false; c.exit = h.exit; c.forcedStop = h.forced === true; }
    }
    for (const row of components.filter(row => row.ownership === 'external')) { row.communication = 'disconnected'; row.readiness = 'not-ready'; row.health.ready = false; }
    if (state.hub) state.hub.exit = hub?.exit;
    const allExited = children.every(h => h.exit && !h.cleanupIncomplete);
    if (!allExited) { state.cleanupIncomplete = true; failures.push({ code: 'CLEANUP_INCOMPLETE', message: 'Some owned process exits are unconfirmed; ownership lock and supervisor retained' }); }
    if (allExited) { delete state.cleanupIncomplete; state.stoppedAt = new Date().toISOString(); }
    await attempt(() => privateJson(join(runDir, 'logs.json'), logs()));
    if (failures.length) { state.state = 'failed'; state.failure ??= failures[0]; state.cleanupErrors = failures; }
    else if (state.state !== 'failed') state.state = 'stopped';
    await attempt(() => privateJson(join(runDir, 'status.json'), snapshot()));
    await attempt(persist);
    if (allExited) {
      for (const file of userConfigurationFiles) await attempt(async () => { try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
      if (control) await attempt(() => new Promise(resolve => { control.close(resolve); control.closeAllConnections(); }));
      await attempt(async () => { if ((await json(lockFile)).nonce === nonce) await unlink(lockFile); });
    }
    if (failures.length) { state.state = 'failed'; state.failure ??= failures[0]; state.cleanupErrors = failures; }
    resolveClosed(snapshot());
    if (!allExited) closing = null; // Keep control available for another explicit stop attempt.
    return snapshot();
  })();
  const fail = error => {
    if (closing) return;
    state.state = 'failed'; state.failure = publicError(error);
    // Startup owns its cleanup after the current spawn was added to children.
    if (startupDone) void close().catch(error => { state.failure = publicError(error); resolveClosed(snapshot()); });
  };
  const componentFailure = (id, error) => {
    if (closing) return;
    const activePack = assembly?.pack ?? plan.pack, component = activePack.components.find(row => row.id === id);
    if ((!startupDone && effectivePackType(activePack) === 'atomic') || effectiveLifecyclePolicy(activePack) === 'fail-fast' || component?.critical) {
      return fail(component?.critical ? Object.assign(new Error(`Critical module failed: ${id}: ${error.message ?? error}`), { code: 'CRITICAL_COMPONENT_FAILED', cause: error }) : error);
    }
    const row = components.find(row => row.id === id);
    if (row && !['stopping', 'exited', 'stopped', 'failed'].includes(row.process)) {
      row.process = 'failed'; row.failure = publicError(error); row.readiness = 'not-ready'; row.health.ready = false;
      if (!startupDone && startingComponents.has(id)) return; // This start's catch owns its cleanup.
      void assembly?.enqueue(async () => {
        const handle = [...children].reverse().find(handle => handle.id === id);
        if (handle && (!handle.exit || handle.cleanupIncomplete)) await handle.stop(plan.pack.stopTimeoutMs);
        row.exit = handle?.exit ?? null; row.communication = 'disconnected'; delete row.entryUrl; await persist();
      }).catch(issue => { row.failure = publicError(issue); fail(issue); });
    }
  };
  const abort = () => { if (startupDone) void close(); else cancelStartup(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const checkCancelled = () => { if (startupCancelled || options.signal?.aborted) { const error = new Error('Runtime startup was stopped'); error.code = 'START_STOPPED'; throw error; } };
  const observeConnections = async () => {
    try {
    if (!state.hub || hub?.exit) return;
    const response = await fetch(state.hub.url + '/status', { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) throw new Error(`Hub communication observation failed: ${response.status}`);
    const live = await response.json(); const bridges = live.bridges;
    if (!Array.isArray(bridges)) throw new Error('Hub returned invalid connection observation');
    const at = new Date().toISOString();
    for (const c of components) {
      c.bridges = c.expectedBridges.map(id => { const b = bridges.find(b => b.principal === c.principal && b.declaredId === id); return { declaredId: id, bridgeId: b?.bridgeId ?? null, connected: Boolean(b), session: b?.session ?? null }; });
      c.communication = c.bridges.every(b => b.connected) ? 'connected' : 'disconnected'; c.communicationObservedAt = at;
    }
    } catch (error) { error.code ??= 'HUB_OBSERVATION_FAILED'; throw error; }
  };
  const probe = async h => {
    const id = randomUUID(); h.send({ command: 'health', id });
    const event = await h.waitFor(e => e.event === 'module-health' && e.id === id, plan.pack.healthTimeoutMs);
    const c = components.find(c => c.id === h.id); if (!c || !['starting', 'running'].includes(c.process)) return; c.health = { ready: event.ready === true, lastCheckedAt: new Date().toISOString() };
    if (event.ready !== true) throw new Error(`Module reports not ready: ${h.id}`);
  };
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 }); await mkdir(join(runDir, 'tmp'), { mode: 0o700 });
    await persist();
    control = createServer(async (request, response) => {
      const send = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${control.address().port}` || !bearerEquals(request.headers.authorization, `Bearer ${controlToken}`)) return send(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Private local Runtime authorization required' } });
      if (request.method === 'GET' && request.url === '/status') return send(200, snapshot());
      if (request.method === 'GET' && request.url === '/logs') return send(200, logs());
      if (request.method === 'POST' && request.url === '/stop') {
        send(202, { ok: true, accepted: true, state: 'stopping' });
        if (startupDone) void close().catch(fail); else cancelStartup();
        return;
      }
      if (request.method === 'GET' && request.url === '/assembly') {
        if (!startupDone || !assembly || closing) return send(409, { ok: false, error: { code: 'ASSEMBLY_UNAVAILABLE', message: 'Wait for this Runtime to be running.' } });
        return send(200, assembly.snapshot());
      }
      if (request.method === 'POST' && ['/assembly/preview', '/assembly/apply'].includes(request.url)) {
        try {
          if (!startupDone || !assembly || closing) throw Object.assign(new Error('Wait for this Runtime to be running'), { code: 'ASSEMBLY_UNAVAILABLE', status: 409 });
          const chunks = []; let length = 0;
          for await (const chunk of request) { length += chunk.length; if (length > 262144) throw Object.assign(new Error('Assembly request exceeds 256 KiB'), { code: 'ASSEMBLY_REQUEST_LIMIT', status: 413 }); chunks.push(chunk); }
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return send(200, await (request.url === '/assembly/preview' ? assembly.preview(input) : assembly.apply(input)));
        } catch (error) { return send(error.status ?? 400, { ok: false, error: publicError(error) }); }
      }
      send(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown Runtime control operation' } });
    });
    control.requestTimeout = 10000; control.headersTimeout = 10000; control.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    const controlUrl = `http://127.0.0.1:${control.address().port}`; state.controlUrl = controlUrl;
    await privateJson(join(stateDir, 'control.json'), { format: 'world-hub.runtime-control/v1', runId: nonce, url: controlUrl, token: controlToken });
    await persist(); checkCancelled();
    const credentials = {}, annotations = {};
    for (const c of plan.pack.components) {
      const publish = [...new Set(Object.values(c.bridges).flatMap(b => b.publish.map(k => plan.pack.topics[k])))];
      const subscribe = [...new Set(Object.values(c.bridges).flatMap(b => b.subscribe.map(k => plan.pack.topics[k])))];
      const principal = peers[c.id].principal;
      credentials[principal] = { token: tokens.get(c.id), maxConnections: Object.keys(c.bridges).length, allow: { publish, subscribe } };
      annotations[principal] = { programs: [{ id: c.id, name: c.id }], bridgeName: `Runtime: ${c.id}` };
    }
    const hubConfig = join(runDir, 'hub.json');
    await privateJson(hubConfig, { version: '0.1', hub: { id: identity(`pack.${options.instanceId}`) },
      transport: { host: '127.0.0.1', port: 0, path: '/bridge' },
      log: { dir: join(stateDir, 'hub', 'log') }, blobs: { dir: join(stateDir, 'hub', 'blobs') },
      management: { stateFile: join(stateDir, 'hub', 'management.json'), annotations },
      acl: { defaultDeny: true, allowUnlistedBridges: false, credentials, bridges: {} } });
    checkCancelled();
    hub = ownProcess(plan.environment.node.executable, [join(repository, 'scripts/runtime/hub-process.mjs'), '--config', hubConfig, '--quiet'],
      { cwd: runDir, temporary: join(runDir, 'tmp'), secrets, onFailure: fail, signal: startupController.signal });
    hub.id = '$hub'; children.push(hub);
    const ready = await hub.waitFor(e => e.event === 'ready', plan.pack.startupTimeoutMs);
    const hubUrl = `http://127.0.0.1:${ready.port}`, endpoint = `ws://127.0.0.1:${ready.port}/bridge`;
    if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new Error('Invalid Hub listening readiness');
    state.hub = { pid: hub.pid, url: hubUrl, endpoint };
    const startComponent = async (c, m, activePack) => {
      if (children.some(handle => handle.id === c.id && (!handle.exit || handle.cleanupIncomplete))) throw Object.assign(new Error('Previous owned process tree has not retired; stop it before restarting'), { code: 'CLEANUP_INCOMPLETE' });
      startingComponents.add(c.id);
      let executing = false;
      try {
      if (JSON.stringify(await collectSourceFiles(m.directory)) !== JSON.stringify(m.files)) throw Object.assign(new Error(`Reviewed module source changed before execution: ${c.id}`), { code: 'ASSEMBLY_SOURCE_CHANGED' });
      const reviewedRuntime = (m.environment ?? plan.environment)[m.manifest.runtime.kind];
      if (hash(await readBounded(reviewedRuntime.executable, 1024 * 1024 * 1024)) !== reviewedRuntime.sha256) throw Object.assign(new Error('Reviewed interpreter changed before execution'), { code: 'ASSEMBLY_SOURCE_CHANGED' });
      const deployed = m.deployment?.dependencies ? await prepareDependencies({directory:m.directory,manifest:m.manifest,review:m.deployment,stateDir:join(stateDir,'deployments',m.manifest.id),signal:startupDone ? operationController.signal : startupController.signal}) : null;
      const componentState = join(stateDir, 'programs', c.id); await ordinaryPath(join(stateDir, 'programs', c.id), { allowMissing: true });
      if (!userExecution) { await mkdir(componentState, { recursive: true, mode: 0o700 }); await mkdir(join(componentState, 'tmp'), { recursive: true, mode: 0o700 }); }
      const principal = peers[c.id].principal;
      const bridges = Object.entries(c.bridges).map(([slot, acl]) => ({ slot, endpoint, bridgeId: identity(`runtime.${c.id}.${slot}`),
        credential: principal, principal, token: tokens.get(c.id), publish: acl.publish.map(k => activePack.topics[k]), subscribe: acl.subscribe.map(k => activePack.topics[k]) }));
      const config = userExecution ? join(componentState, `.runtime-${nonce}.json`) : join(runDir, `${c.id}.json`);
      const configuration = { format: RUNTIME_API, instanceId: options.instanceId, componentId: c.id,
        module: { id: m.manifest.id, version: m.manifest.version }, stateDir: componentState, settings: c.settings, topics: deploymentTopics(activePack,c,m.deployment?.deployment), peers, bindings:activePack.bindings, bridges,
        ...(deployed ? {deployment:deployed} : {}) };
      if (userExecution) { await writeExistingUserConfiguration(isolation.policy, config, configuration, plan.environment.node.executable); userConfigurationFiles.push(config); }
      else await privateJson(config, configuration);
      if (startupDone) { if (operationController.signal.aborted) throw Object.assign(new Error('Dynamic module start was stopped'), { code: 'START_STOPPED' }); } else checkCancelled();
      const row = components.find(row => row.id === c.id) ?? { id: c.id, module: c.module, pid: null, process: 'starting', principal, expectedBridges: bridges.map(b => b.bridgeId),
        communication: 'unknown', readiness: 'not-ready', health: { ready: false, lastCheckedAt: null }, bridges: [] };
      Object.assign(row, { process: 'starting', communication: 'unknown', readiness: 'not-ready', ownership: 'managed', origin: assembly?.records.get(c.id)?.origin ?? 'baseline', principal, expectedBridges: bridges.map(b => b.bridgeId), health: { ready: false, lastCheckedAt: null } });
      delete row.exit; delete row.failure; delete row.entryUrl; delete row.blockedBy;
      if (!components.includes(row)) components.push(row);
      const executable = (m.environment ?? plan.environment)[m.manifest.runtime.kind].executable;
      const entry = deployed ? join(deployed.directory,m.manifest.runtime.entry) : join(m.directory, m.manifest.runtime.entry);
      // Restore normal local imports without adding state cwd as an import
      // source or shortening the lifetime of the program's main module.
      const pythonArgs = m.manifest.runtime.kind === 'python'
        ? ['-B', '-s', ...(process.platform === 'win32' && entry.length >= 248
          ? ['-c', longPythonEntry] : [])] : [];
      const processOptions = { cwd: componentState, temporary: join(componentState, 'tmp'), secrets, onFailure: error => componentFailure(c.id, error), signal: startupDone ? operationController.signal : startupController.signal };
      const isolatedPlan = isolation ? await planIsolation({ ...isolation.policy, sourceDirectory: m.directory, stateDirectory: componentState,
        configPath: config, adapterDirectory: join(runDir, c.id + '-isolation'), entry: m.manifest.runtime.entry, runtime: m.manifest.runtime.kind,
        expectedRuntime: { version: plan.environment[m.manifest.runtime.kind].version, packages: plan.environment[m.manifest.runtime.kind].packages }, runtimeExecutable: executable, nodeExecutable: plan.environment.node.executable }) : null;
      executing = true;
      const h = isolatedPlan ? await ownIsolatedProcess(isolatedPlan, { ...processOptions, trust: isolatedPlan.digest })
        : await ownHostedProcess(executable, [...pythonArgs, entry, '--runtime-config', config], {...processOptions,ownedChildren:m.manifest.permissions.processes==='owned-children'});
      h.id = c.id; children.push(h); row.pid = h.pid; row.neverStarted = false;
      // Process liveness and application readiness are separate observations.
      // A connected program may never report module-ready, but its bridge still
      // belongs to this actual owned process during the startup window.
      row.process = 'running';
      if (isolation) {
        const actual = await h.waitFor(event => event.event === 'isolation-ready', plan.pack.startupTimeoutMs);
        const expected = isolation.expectedRuntimes[m.manifest.runtime.kind], user = userExecution ? isolation.provider.user.uid : isolation.limits.user;
        if (actual.runtime !== m.manifest.runtime.kind || actual.runtimeVersion !== expected.version || actual.user !== user || JSON.stringify(actual.packages) !== JSON.stringify(expected.packages)) throw Object.assign(new Error('Actual runtime, dependency version or UID differs from the reviewed locked environment'), { code: 'ISOLATION_ENVIRONMENT_MISMATCH' });
        row.isolation = h.isolation;
      }
      const application = await h.waitFor(e => e.event === 'module-ready', plan.pack.startupTimeoutMs); row.readiness = 'ready';
      if (application.entryUrl !== undefined) {
        if (typeof application.entryUrl !== 'string') throw new Error('Module reported an undeclared or invalid loopback entry URL');
        const url = new URL(application.entryUrl);
        // Trusted local programs may each have an interface. The pack entry
        // selects the primary interface; isolated HTTP policies remain explicit.
        if ((isolation && c.id !== plan.pack.entry.component) || !m.manifest.permissions.network.includes('loopback-listen') || url.protocol !== 'http:'
            || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) === 0 || url.username || url.password || url.search || url.hash) throw new Error('Module reported an undeclared or invalid loopback entry URL');
        if (isolation && !userExecution) row.entryUrl = await h.exposeHttp(url.href);
        else row.entryUrl = url.href;
      }
      await probe(h);
      const deadline = Date.now() + plan.pack.startupTimeoutMs;
      while (true) {
        await observeConnections(); if (row.communication === 'connected') break;
        if (h.exit || state.failure) throw new Error(state.failure?.message ?? `Module exited: ${c.id}`);
        if (Date.now() >= deadline) throw new Error(`Module communication connection timeout: ${c.id}`);
        await delay(50);
      }
      row.process = 'running';
      state.entryUrl = components.find(row => row.id === activePack.entry.component)?.entryUrl ?? null;
      await persist();
      } catch (error) {
        // A hosted owner can fail before its async startup returns. Retain the
        // exact still-owned handle supplied by that adapter, so cleanup and a
        // later Stop retry never have to rediscover ownership from a PID.
        if (error.ownedHandle && !children.includes(error.ownedHandle)) {
          const owned = error.ownedHandle; owned.id = c.id; children.push(owned);
          const row = components.find(row => row.id === c.id);
          if (row) { row.pid = owned.pid; row.neverStarted = false; row.process = 'failed'; row.failure = publicError(error); row.readiness = 'not-ready'; row.health.ready = false; }
        }
        const handle = [...children].reverse().find(handle => handle.id === c.id);
        try {
          if (handle && (!handle.exit || handle.cleanupIncomplete)) await handle.stop(plan.pack.stopTimeoutMs);
          if (handle && (!handle.exit || handle.cleanupIncomplete)) throw Object.assign(new Error('Owned process tree retirement remains unconfirmed'), { code: 'CLEANUP_INCOMPLETE' });
        } catch (cleanupError) {
          // A failed optional start is recoverable; losing proof that its owned
          // tree retired is not. Schedule shutdown without awaiting this same
          // assembly queue, and retain ownership until an explicit retry works.
          fail(cleanupError); throw cleanupError;
        }
        const row = components.find(row => row.id === c.id);
        if (row) { row.process = handle?.exit ? 'failed' : 'stopped'; row.failure = publicError(error); row.readiness = 'not-ready'; row.health.ready = false; row.communication = 'disconnected'; row.exit = handle?.exit ?? null; }
        error.moduleExecutionFailure = executing && !['ASSEMBLY_SOURCE_CHANGED', 'ISOLATION_REVIEW_CHANGED', 'ISOLATION_ENVIRONMENT_MISMATCH', 'HUB_OBSERVATION_FAILED', 'START_STOPPED', 'CLEANUP_INCOMPLETE', 'HOST_CLEANUP_INCOMPLETE'].includes(error.code);
        if (error.moduleExecutionFailure) componentFailure(c.id, error);
        else if (startupDone && !closing && !operationController.signal.aborted) fail(error);
        await persist(); throw error;
      } finally { startingComponents.delete(c.id); }
    };
    const stopComponent = async id => {
      const handles = children.filter(handle => handle.id === id);
      const row = components.find(row => row.id === id); if (row) row.process = 'stopping';
      for (const handle of [...handles].reverse()) await handle.stop(plan.pack.stopTimeoutMs);
      if (handles.some(handle => !handle.exit || handle.cleanupIncomplete)) throw Object.assign(new Error('Owned process tree retirement remains unconfirmed'), { code: 'CLEANUP_INCOMPLETE' });
      if (row) { row.process = row.neverStarted ? 'stopped' : 'exited'; row.exit = row.neverStarted ? null : handles.at(-1)?.exit ?? null; row.readiness = 'not-ready'; row.health.ready = false; row.communication = 'disconnected'; delete row.entryUrl; }
      state.entryUrl = components.find(row => row.id === (assembly?.pack ?? plan.pack).entry.component)?.entryUrl ?? null;
      await updateCredentials({ credentials: {}, remove: [peers[id].principal] }); await persist();
    };
    const updateCredentials = async change => {
      if (!hub || hub.exit || closing) throw Object.assign(new Error('Owned Hub is unavailable or stopping'), { code: 'ASSEMBLY_STOPPING' });
      const id = randomUUID(); hub.send({ command: 'credentials-update', id, change });
      const result = await hub.waitFor(event => event.event === 'credentials-updated' && event.id === id, 5000);
      if (!result.ok) throw Object.assign(new Error('Owned Hub rejected this credential change'), { code: 'ASSEMBLY_CREDENTIALS_INVALID' });
    };
    assembly = new DynamicAssembly({ plan, stateDir, runDir, runId: nonce, state, peers, tokens, secrets,
      start: startComponent, stop: stopComponent, credentials: updateCredentials, persist, isClosing: () => Boolean(closing), hasOwnedProcess: id => children.some(handle => handle.id === id && (!handle.exit || handle.cleanupIncomplete)), signal: operationController.signal });
    for (const id of plan.order) {
      checkCancelled(); if (state.failure) throw new Error(state.failure.message);
      const c = plan.pack.components.find(c => c.id === id), source = assembly.records.get(id).module;
      if (startupMode === 'hub-only' || !componentAutostarts(plan.pack, c)) continue;
      const unavailable = c.after.filter(id => { const row = components.find(component => component.id === id); return row?.process !== 'running' || row.readiness !== 'ready' || row.health.ready !== true || row.communication !== 'connected'; });
      if (unavailable.length) {
        const row = components.find(row => row.id === id); row.blockedBy = unavailable;
        row.failure = { code: 'COMPONENT_START_BLOCKED', message: `Explicit startup dependencies are unavailable: ${unavailable.join(', ')}` }; await persist();
        if (c.critical) throw Object.assign(new Error(`Critical module startup blocked: ${id}`), { code: 'CRITICAL_COMPONENT_FAILED' });
        if (effectivePackType(plan.pack) === 'atomic') throw Object.assign(new Error(`Selected module startup blocked: ${id}`), { code: 'COMPONENT_START_BLOCKED' });
        continue;
      }
      try { await startComponent(c, source, plan.pack); }
      catch (error) {
        checkCancelled();
        if (effectivePackType(plan.pack) !== 'mesh' || effectiveLifecyclePolicy(plan.pack) !== 'independent' || c.critical || !error.moduleExecutionFailure || state.failure || hub.exit)
          throw error;
      }
    }
    // A ready optional member can exit while a later member is starting. Its
    // retirement belongs to this same run and must settle before pack-ready.
    let retirementQueue;
    do {
      retirementQueue = assembly.queue;
      await retirementQueue;
    } while (retirementQueue !== assembly.queue);
    const entryUrl = components.find(c => c.id === plan.pack.entry.component)?.entryUrl ?? null;
    checkCancelled();
    if (state.failure || hub.exit || effectivePackType(plan.pack) === 'atomic' && children.some(h => h.exit)) throw new Error(state.failure?.message ?? 'Program exited during startup');
    state.state = 'running'; state.sandbox = Boolean(isolation && !userExecution); state.identitySeparation = userExecution; state.entryUrl = entryUrl; state.controlUrl = controlUrl; startupDone = true; await persist();
    let checking = false;
    monitoring = setInterval(async () => {
      if (checking || closing) return; checking = true;
      try {
        await observeConnections();
        for (const row of components.filter(row => row.ownership !== 'external' && row.process === 'running' && !startingComponents.has(row.id))) {
          // Another reviewed action can stop a later member while an earlier
          // health probe is awaited; recheck the current lifecycle state.
          if (row.process !== 'running' || startingComponents.has(row.id)) continue;
          if (row.communication !== 'connected') { componentFailure(row.id, new Error(`Module communication disconnected: ${row.id}`)); continue; }
          const handle = [...children].reverse().find(handle => handle.id === row.id && !handle.exit);
          if (handle) try { await probe(handle); } catch (error) { if (!closing && row.process === 'running') componentFailure(row.id, error); }
        }
        if (!closing) await persist();
      } catch (error) { if (!closing) fail(error); } finally { checking = false; }
    }, 500);
    const runtimeReady = { event: 'pack-ready', instanceId: options.instanceId, startupMode, entryUrl, hubUrl, hubEndpoint: endpoint, controlUrl, stateDir, pids: children.map(h => h.pid) };
    return { ready: runtimeReady, status: async () => { if (!closing) await observeConnections(); return snapshot(); }, close, closed, children };
  } catch (error) {
    if (startupCancelled) { state.state = 'stopping'; error.code = 'START_STOPPED'; }
    else { state.state = 'failed'; state.failure ??= publicError(error); }
    await close();
    // A failed startup can still own children whose exits are unconfirmed.
    // Preserve this exact owner's retry handle rather than rediscovering it by PID.
    Object.defineProperty(error, 'runtimeSession', { value: { close, closed, status: async () => snapshot() } });
    throw error;
  }
}
async function controlRequest(options, path, method = 'GET', expectedRunId = null) {
  const directory = instancePath(options.root, options.instanceId); await ordinaryPath(directory);
  const control = await json(join(directory, 'control.json'));
  const current = await json(join(directory, 'status.json'));
  if (control.runId !== current.runId) throw new Error('Runtime startup control is not yet available for this run; no stale supervisor or PID was used');
  if (expectedRunId && current.runId !== expectedRunId) throw new Error('Runtime instance restarted before control action; no different run was stopped');
  const target = new URL(control.url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid local Runtime control URL');
  const response = await fetch(control.url + path, { method, headers: { authorization: `Bearer ${control.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
  const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? `Runtime HTTP ${response.status}`); return value;
}
export async function statusInstance(options) {
  const file = join(instancePath(options.root, options.instanceId), 'status.json');
  const state = await json(file);
  if (['stopped', 'failed'].includes(state.state)) return state;
  try { return await controlRequest(options, '/status'); }
  catch (error) { return { ...state, observation: 'stale', supervisorUnavailable: true, controlError: error.message }; }
}
export async function logsInstance(options) {
  try { return await controlRequest(options, '/logs'); }
  catch (error) {
    const directory = instancePath(options.root, options.instanceId), state = await json(join(directory, 'status.json'));
    if (!['stopped', 'failed'].includes(state.state)) throw error;
    const saved = await json(join(directory, 'runs', state.runId, 'logs.json'));
    // Older saved logs did not include their run identity. The historical path
    // supplies that exact identity, never the identity of a newer live run.
    return { ...saved, runId: saved.runId ?? state.runId, observedAt: saved.observedAt ?? state.stoppedAt ?? null };
  }
}
export async function stopInstance(options) {
  const directory = instancePath(options.root, options.instanceId), file = join(directory, 'status.json');
  let state = await json(file);
  if (['stopped', 'failed'].includes(state.state) && state.stoppedAt && !state.cleanupIncomplete) return state;
  const runId = state.runId;
  await controlRequest(options, '/stop', 'POST', runId);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    state = await json(file);
    if (state.runId !== runId) {
      const terminal = await json(join(directory, 'runs', runId, 'status.json'));
      if (terminal.runId === runId && terminal.stoppedAt && !terminal.cleanupIncomplete) return terminal;
      throw new Error('Requested Runtime run has no confirmed terminal state; a newer run was not stopped');
    }
    if (state.stoppedAt && !state.cleanupIncomplete) return state;
    await delay(100);
  }
  throw new Error('Runtime stop deadline exceeded; no stored PID was killed');
}
export async function exportInstance(options) {
  const stateDir = instancePath(options.root, options.instanceId); await ordinaryPath(stateDir);
  const plan = await inspectPackage(join(stateDir, 'package'), options);
  await copyPackage(plan, options.destination);
  const exported = await inspectPackage(options.destination, options);
  if (exported.digest !== plan.digest) throw new Error('Exported package review mismatch');
  return { destination: exported.directory, digest: exported.digest, includesRuntimeState: false };
}
