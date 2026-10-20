import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock, importPackage, startInstance } from '../../../scripts/runtime/runtime.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { confirmedStopped } from '../../../scripts/runtime/maintenance.mjs';
import { DynamicAssembly } from '../../../scripts/runtime/dynamic-assembly.mjs';
import { initModule } from '../../../scripts/runtime/developer.mjs';
import { publicRuntimeAssembly, createRuntimeAssemblySnapshot, runtimeAssemblyOperation } from '../../../tools/launcher/runtime-assembly.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = { timeout: 60000 };
async function setup(t, lifecyclePolicy = 'independent', { authorTopicAlias } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-dynamic-')), root = join(directory, 'instances'), pack = join(directory, 'pack');
  let session;
  t.after(async () => { await session?.close(); assert.ok(session?.children.every(handle => handle.exit && !handle.cleanupIncomplete)); await rm(directory, { recursive: true, force: true }); });
  const module = async (id, { provides = [], requires = [] } = {}) => {
    const source = join(directory, id); await mkdir(join(source, 'sdk'), { recursive: true });
    await copyFile(join(repository, 'tests/integration/ecosystem-runtime/fixtures/program.mjs'), join(source, 'program.mjs'));
    for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(repository, 'sdk/javascript', file), join(source, 'sdk', file));
    await save(join(source, 'package.json'), { imports: { '#bridge': './sdk/bridge-kit.mjs' } });
    await save(join(source, 'module.json'), { format: 'world-hub.module/v1', id, version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides, requires,
      permissions: { filesystem: 'instance-state', network: ['hub-loopback', 'loopback-listen'], processes: 'none' } });
    return source;
  };
  const source = await module('test.base');
  if (authorTopicAlias) await save(join(source, 'deployment.json'), { format: 'world-hub.deployment/v1', title: { en: 'Author alias fixture' },
    description: { en: 'Program-owned aliases remain distinct from pack keys.' }, topics: { [authorTopicAlias]: 'author/default' },
    bridges: { main: { publish: [authorTopicAlias], subscribe: [authorTopicAlias] } }, settings: [] });
  await mkdir(pack, { recursive: true });
  const { cp } = await import('node:fs/promises'); await cp(source, join(pack, 'modules/base'), { recursive: true });
  const component = (id, module, settings = {}) => ({ id, module, after: [], settings, bridges: { main: { publish: ['flow'], subscribe: ['flow'] } } });
  await save(join(pack, 'pack.json'), { format: 'world-hub.pack/v1', id: 'test.dynamic', version: '1.0.0', title: 'Dynamic run', license: 'MIT', topics: { flow: 'dynamic/flow' }, components: [component('base', 'test.base')], bindings: [], entry: { component: 'base' }, startupTimeoutMs: 5000, healthTimeoutMs: 1000, stopTimeoutMs: 500, lifecyclePolicy });
  await createLock(pack, { nodePath: process.execPath });
  const imported = await importPackage(pack, { root, instanceId: 'scene', nodePath: process.execPath });
  session = await startInstance({ root, instanceId: 'scene', trust: imported.digest, nodePath: process.execPath });
  const control = JSON.parse(await readFile(join(imported.stateDir, 'control.json'), 'utf8'));
  const request = async (path, body) => {
    const response = await fetch(control.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result;
  };
  const snapshot = () => request('/assembly');
  const review = async operation => { const current = await snapshot(); return request('/assembly/preview', { runId: current.runId, revision: current.revision, operation }); };
  const apply = saved => request('/assembly/apply', { runId: saved.runId, revision: saved.revision, digest: saved.digest, accepted: true });
  return { directory, root, stateDir: imported.stateDir, session, module, component, request, snapshot, review, apply, change: async operation => apply(await review(operation)) };
}

test('dynamic add copies reviewed bytes, starts explicitly, stops/restarts/removes one module while its Hub and baseline survive', timeout, async t => {
  const app = await setup(t), original = await app.session.status(), source = await app.module('test.added');
  const saved = await app.review({ kind: 'add', directory: source, component: app.component('added', 'test.added') });
  assert.equal(saved.startsModules, false); await app.apply(saved);
  let status = await app.session.status(); assert.equal(status.components.find(row => row.id === 'added').process, 'stopped');
  await app.change({ kind: 'start', ids: ['added'] }); status = await app.session.status();
  assert.equal(status.hub.pid, original.hub.pid); assert.equal(status.components.find(row => row.id === 'base').pid, original.components[0].pid);
  assert.equal(status.components.find(row => row.id === 'added').communication, 'connected');
  const firstPid = status.components.find(row => row.id === 'added').pid;
  await app.change({ kind: 'stop', ids: ['added'] });
  await app.change({ kind: 'configure', components: [app.component('added', 'test.added', { label: 'edited' })] });
  await app.change({ kind: 'start', ids: ['added'] });
  assert.notEqual((await app.session.status()).components.find(row => row.id === 'added').pid, firstPid);
  await app.change({ kind: 'stop', ids: ['added'] }); await app.change({ kind: 'remove', ids: ['added'] });
  await assert.rejects(app.review({ kind: 'add', directory: source, component: app.component('added', 'test.added') }), { code: 'ASSEMBLY_STATE_POLICY_REQUIRED' });
  assert.deepEqual((await app.snapshot()).pack.components.map(row => row.id), ['base']);
  assert.equal((await app.session.status()).state, 'running'); assert.equal((await app.session.status()).hub.pid, original.hub.pid);
  await assert.rejects(app.apply(saved), { code: 'ASSEMBLY_CHANGED' });
});

test('dynamic source and binding reviews detect edits and require explicit affected provider restart', timeout, async t => {
  const app = await setup(t), capability = { id: 'test.lookup', version: '1.0.0' };
  const provider = await app.module('test.provider', { provides: [capability] });
  const saved = await app.review({ kind: 'add', directory: provider, component: app.component('provider', 'test.provider') });
  await writeFile(join(provider, 'new.txt'), 'changed'); await assert.rejects(app.apply(saved), { code: 'ASSEMBLY_REVIEW_CHANGED' });
  await app.change({ kind: 'add', directory: provider, component: app.component('provider', 'test.provider') });
  await app.change({ kind: 'start', ids: ['provider'] });
  const consumer = await app.module('test.consumer', { requires: [capability] });
  const add = { kind: 'add', directory: consumer, component: app.component('consumer', 'test.consumer'), bindings: [{ from: 'provider', to: 'consumer', contract: capability }] };
  await assert.rejects(app.review(add), { code: 'ASSEMBLY_RESTART_REQUIRED' });
  await app.change({ kind: 'stop', ids: ['provider'] }); await app.change(add); await app.change({ kind: 'start', ids: ['provider', 'consumer'] });
  assert.equal((await app.session.status()).components.find(row => row.id === 'consumer').communication, 'connected');
  await app.change({ kind: 'stop', ids: ['provider'] }); await assert.rejects(app.review({ kind: 'remove', ids: ['provider'] }), { code: 'ASSEMBLY_DEPENDENTS' });
  const snapshot = await app.snapshot(); assert.equal(snapshot.includesCredentials, false); assert.equal(snapshot.modules.length, 3);
});

test('independent failures preserve unrelated peers and explicit fail-fast policy still stops the full run', timeout, async t => {
  const app = await setup(t), source = await app.module('test.crasher');
  await app.change({ kind: 'add', directory: source, component: app.component('crasher', 'test.crasher', { mode: 'crash-after-ready' }) });
  await app.change({ kind: 'start', ids: ['crasher'] }); await pause(2800);
  let status = await app.session.status(); assert.equal(status.state, 'running'); assert.equal(status.components.find(row => row.id === 'crasher').process, 'failed'); assert.equal(status.components.find(row => row.id === 'base').process, 'running');
  await app.change({ kind: 'set-policy', policy: 'fail-fast' }); await app.change({ kind: 'start', ids: ['crasher'] });
  await Promise.race([app.session.closed, pause(10000).then(() => { throw new Error('Fail-fast did not close'); })]);
  status = await app.session.status(); assert.equal(status.state, 'failed'); assert.ok(status.stoppedAt);
});

test('external admission grants only reviewed communication and revocation never owns its process or exports its token', timeout, async t => {
  const app = await setup(t);
  const granted = await app.change({ kind: 'admit-external', external: { id: 'outside.application', bridges: ['main'], provides: [], requires: [] }, component: app.component('outside', 'outside.application') });
  const slot = granted.admission.bridges[0];
  const bridge = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId, credential: slot.credential, token: slot.token, reconnectMs: 100 }); bridge.on('error', () => {});
  t.after(() => bridge.close('test cleanup')); await bridge.connect(); await bridge.registerChannels([{ name: 'dynamic/flow', publish: true, subscribe: true }]);
  await assert.rejects(bridge.registerChannels([{ name: 'forbidden/topic', publish: true, subscribe: true }]));
  const status = await app.session.status(), snapshot = await app.snapshot();
  assert.equal(status.components.find(row => row.id === 'outside').ownership, 'external'); assert.equal(status.components.find(row => row.id === 'outside').pid, null);
  assert.equal(snapshot.exportable, false); assert.ok(!JSON.stringify(snapshot).includes(slot.token)); assert.ok(!JSON.stringify(status).includes(slot.token));
  await assert.rejects(app.review({ kind: 'stop', ids: ['outside'] }), { code: 'ASSEMBLY_EXTERNAL_UNMANAGED' });
  await app.change({ kind: 'revoke-external', ids: ['outside'] }); await pause(150); assert.equal(bridge.connected, false);
  assert.equal((await app.session.status()).state, 'running'); assert.equal((await app.snapshot()).exportable, true);
});

test('whole-run Stop cancels an in-flight dynamic start and confirms every owned exit before releasing its lock', timeout, async t => {
  const app = await setup(t,'fail-fast'), source = await app.module('test.pending');
  const entry=join(source,'program.mjs'),code=await readFile(entry,'utf8');
  await writeFile(entry,code.replace('const bridges = [];','await new Promise(done => setTimeout(done, 1400));\nconst bridges = [];'));
  await app.change({ kind: 'add', directory: source, component: app.component('pending', 'test.pending', { mode: 'no-ready' }) });
  const review = await app.review({ kind: 'start', ids: ['pending'] }), pending = app.apply(review).then(() => ({ success: true }), error => ({ error }));
  const deadline = Date.now() + 5000;
  while (!(await app.session.status()).components.some(row => row.id === 'pending' && row.pid && row.process === 'running' && row.readiness === 'not-ready')) {
    assert.ok(Date.now() < deadline); await pause(25);
  }
  // Cross a normal monitoring interval while this process is alive but has not
  // connected yet. Startup has its own bounded checks, not steady-state health.
  await pause(700);
  const during=await app.session.status();assert.equal(during.state,'running');
  assert.equal(during.components.find(row=>row.id==='pending').readiness,'not-ready');
  const closed = await app.session.close(), outcome = await pending;
  assert.ok(outcome.error); assert.ok(closed.stoppedAt); assert.ok(app.session.children.every(handle => handle.exit && !handle.cleanupIncomplete));
  await confirmedStopped(app.stateDir, 'scene');
});

test('never-started modules and external identities remain truthful after shutdown and do not block stopped-instance maintenance', timeout, async t => {
  const app = await setup(t), source = await app.module('test.unstarted');
  await app.change({ kind: 'add', directory: source, component: app.component('unstarted', 'test.unstarted') });
  await app.change({ kind: 'stop', ids: ['unstarted'] });
  await app.change({ kind: 'admit-external', external: { id: 'external.owner', bridges: ['main'], provides: [], requires: [] }, component: app.component('external', 'external.owner') });
  const stopped = await app.session.close();
  const never = stopped.components.find(row => row.id === 'unstarted'), outside = stopped.components.find(row => row.id === 'external');
  assert.equal(never.pid, null); assert.equal(never.neverStarted, true); assert.equal(never.exit, null);
  assert.equal(outside.pid, null); assert.equal(outside.process, 'unmanaged'); assert.equal(outside.exit, undefined);
  assert.equal((await confirmedStopped(app.stateDir, 'scene')).status.runId, stopped.runId);
});

test('registered source mutation prevents execution and isolated profiles reject dynamic changes without a trusted-local fallback', timeout, async t => {
  const app = await setup(t), source = await app.module('test.changed');
  await app.change({ kind: 'add', directory: source, component: app.component('changed', 'test.changed') });
  const current = await app.snapshot(), registered = current.modules.find(module => module.manifest.id === 'test.changed');
  await writeFile(join(registered.directory, 'program.mjs'), 'throw new Error("unreviewed source must never run");');
  await assert.rejects(app.review({ kind: 'start', ids: ['changed'] }), { code: 'ASSEMBLY_SOURCE_CHANGED' });
  assert.equal((await app.session.status()).components.find(row => row.id === 'changed').pid, null);
  const assembly = new DynamicAssembly({ plan: { pack: current.pack, modules: current.modules.map(module => ({ ...module, source: 'module-placeholder' })), environment: {}, digest: current.baselineDigest }, stateDir: app.stateDir, runDir: app.directory, runId: current.runId,
    state: { executionProfile: 'docker-runtime/v1', components: [] }, peers: {}, tokens: new Map(), secrets: [], isClosing: () => false, signal: new AbortController().signal });
  await assert.rejects(assembly.preview({ runId: current.runId, revision: 0, operation: { kind: 'set-policy', policy: 'independent' } }), { code: 'ASSEMBLY_ISOLATION_UNSUPPORTED' });
});

test('Node-only baseline dynamically adds an explicitly reviewed Python interpreter and exchanges real cross-language capability traffic', timeout, async t => {
  const app = await setup(t), pythonPath = process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'C:/Python314/python.exe' : 'python3');
  const source = join(app.directory, 'python-provider'); await initModule({ directory: source, id: 'test.python', runtime: 'python' });
  const granted = await app.change({ kind: 'admit-external', external: { id: 'test.caller', bridges: ['main'], provides: [], requires: [] }, component: app.component('caller', 'test.caller') });
  const slot = granted.admission.bridges[0], caller = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId, credential: slot.credential, token: slot.token }); caller.on('error', () => {}); t.after(() => caller.close());
  await caller.connect(); await caller.registerChannels([{ name: 'dynamic/flow', publish: true, subscribe: true }]);
  const operation = { kind: 'add', directory: source, pythonPath, component: app.component('python', 'test.python', { topicKey: 'flow', callerId: 'caller' }) };
  const saved = await app.review(operation); assert.equal(saved.environment.python.available, true); assert.match(saved.environment.python.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(app.review({ ...operation, pythonPath: join(app.directory, 'absent-python.exe') }), { code: 'ASSEMBLY_MODULE_INVALID' });
  await app.apply(saved); await app.change({ kind: 'start', ids: ['python'] });
  const text = '分布式上下文 🌍\r\nUnicode Café\n';
  const response = await caller.call({ principal: 'runtime.python' }, 'dynamic/flow', { contract: { id: 'text.statistics', version: '1.0.0' }, invocationId: 'dynamic-python-check', text }, { timeoutMs: 8000 });
  assert.equal(response.response.body.ok, true); assert.equal(response.response.body.output.utf8Bytes, Buffer.byteLength(text)); assert.equal(response.response.body.output.lines, text.split('\n').length);
  assert.equal((await app.session.status()).components.find(row => row.id === 'base').process, 'running');
  assert.equal((await app.snapshot()).modules.find(module => module.manifest.id === 'test.python').environment.python.executable, saved.environment.python.executable);
  await app.change({ kind: 'stop', ids: ['python'] });
  const reviewed = await app.review({ kind: 'start', ids: ['python'] });
  await app.change({ kind: 'set-policy', policy: 'independent' }); await assert.rejects(app.apply(reviewed), { code: 'ASSEMBLY_CHANGED' });
});

test('identical module instances retain their exact source paths and any changed source copy blocks source-only export', timeout, async t => {
  const app = await setup(t), initial = await app.snapshot(), baseline = initial.componentSources.find(source => source.componentId === 'base');
  await app.change({ kind: 'add', directory: baseline.directory, component: app.component('copy', 'test.base') });
  const snapshot = await app.snapshot(), sourceCopy = snapshot.componentSources.find(source => source.componentId === 'copy'), programs = publicRuntimeAssembly(snapshot).programs;
  assert.equal(snapshot.modules.length, 1, 'Distributed source remains deduplicated by module ID');
  assert.equal(snapshot.componentSources.length, 2); assert.notEqual(baseline.directory, sourceCopy.directory);
  assert.equal(programs.find(program => program.componentId === 'base').sourceDirectory, baseline.directory);
  assert.equal(programs.find(program => program.componentId === 'copy').sourceDirectory, sourceCopy.directory);
  await app.change({ kind: 'stop', ids: ['base'] });
  const beforeConfigure = await app.snapshot(), configure = await runtimeAssemblyOperation({ snapshot: beforeConfigure, input: { action: 'configure', componentId: 'base', settings: { label: 'Exact baseline source retained' } } });
  await app.change(configure);
  assert.equal(publicRuntimeAssembly(await app.snapshot()).programs.find(program => program.componentId === 'base').sourceDirectory, baseline.directory);
  const exportSnapshot = await app.snapshot(), exportPack = () => createRuntimeAssemblySnapshot({ root: app.root, snapshot: exportSnapshot, environment: { nodePath: process.execPath } });
  for (const source of [baseline, sourceCopy]) {
    const entry = join(source.directory, 'program.mjs'), bytes = await readFile(entry);
    await writeFile(entry, Buffer.concat([bytes, Buffer.from('\n// changed one component-owned source\n')]));
    await assert.rejects(exportPack(), { code: 'RUNTIME_ASSEMBLY_SOURCE_CHANGED' });
    await writeFile(entry, bytes);
  }
  const exported = await exportPack();
  assert.equal(exported.pack.components.length, 2);
  assert.equal(JSON.parse(await readFile(join(exported.directory, 'pack.lock'), 'utf8')).modules.length, 1);
  assert.equal(exported.includesPrivateState, false);
});

test('new independent topics admit managed and external members without restarting implicit-alias baseline programs', timeout, async t => {
  const app = await setup(t), initial = await app.session.status(), source = await app.module('test.independent');
  const component = (id, module) => ({ id, module, after: [], settings: {}, bridges: { main: { publish: ['events'], subscribe: ['events'] } }, topicAliases: { events: 'events' } });
  await app.change({ kind: 'add', directory: source, component: component('independent', 'test.independent'), topics: { events: 'dynamic/independent-events' } });
  await app.change({ kind: 'start', ids: ['independent'] });
  const admitted = await app.change({ kind: 'admit-external', external: { id: 'outside.independent', bridges: ['main'], provides: [], requires: [] },
    component: component('external', 'outside.independent') });
  const slot = admitted.admission.bridges[0], bridge = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId, credential: slot.credential, token: slot.token });
  bridge.on('error', () => {}); t.after(() => bridge.close()); await bridge.connect(); await bridge.registerChannels([{ name: 'dynamic/independent-events', publish: true, subscribe: true }]);
  let received; bridge.on('delivery', message => { received = message.body; }); await bridge.subscribe(['dynamic/independent-events'], { from: 'now' });
  await bridge.publish('dynamic/independent-events', { value: '新通道独立收发 🌍' });
  const deadline = Date.now() + 5000; while (!received) { assert.ok(Date.now() < deadline); await pause(25); }
  assert.equal(received.value, '新通道独立收发 🌍');
  const current = await app.session.status(); assert.equal(current.hub.pid, initial.hub.pid); assert.equal(current.components.find(row => row.id === 'base').pid, initial.components[0].pid);
  assert.equal(current.components.find(row => row.id === 'base').process, 'running'); assert.equal(current.components.find(row => row.id === 'independent').communication, 'connected');
  await assert.rejects(app.review({ kind: 'configure', components: [], topics: { flow: 'dynamic/changed-existing', events: 'dynamic/independent-events' } }), { code: 'ASSEMBLY_RESTART_REQUIRED' });
  const activeRun = JSON.parse(await readFile(join(app.stateDir, 'runs', current.runId, 'base.json'), 'utf8'));
  assert.deepEqual(activeRun.topics, { flow: 'dynamic/flow' }, 'Unrelated program retains its original launch-time topic snapshot');
});

test('a newly introduced pack topic cannot overwrite an existing author alias without retiring that program configuration', timeout, async t => {
  const app = await setup(t, 'independent', { authorTopicAlias: 'author-message' });
  const initial = await app.snapshot(); assert.equal(Object.hasOwn(initial.pack.topics, 'author-message'), false);
  const component = { id: 'external', module: 'outside.collision', after: [], settings: {}, bridges: { main: { publish: ['author-message'], subscribe: ['author-message'] } }, topicAliases: { events: 'author-message' } };
  const operation = { kind: 'admit-external', external: { id: 'outside.collision', bridges: ['main'], provides: [], requires: [] }, component,
    topics: { 'author-message': 'dynamic/unrelated-name-collision' } };
  await assert.rejects(app.review(operation), { code: 'ASSEMBLY_RESTART_REQUIRED' });
  assert.equal((await app.session.status()).components.find(row => row.id === 'base').process, 'running');
  await app.change({ kind: 'stop', ids: ['base'] });
  await assert.rejects(app.review(operation), { code: 'DEPLOYMENT_INVALID' }, 'Stopping does not waive the author topic collision validation');
});
