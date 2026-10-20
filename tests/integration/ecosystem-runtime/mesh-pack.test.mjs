import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock, importPackage, startInstance } from '../../../scripts/runtime/runtime.mjs';
import { validatePack } from '../../../scripts/runtime/package.mjs';
import { effectivePackType, effectiveLifecyclePolicy, componentAutostarts, summarizePack } from '../../../scripts/runtime/pack-paradigms.mjs';
import { confirmedStopped } from '../../../scripts/runtime/maintenance.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { timeout: 60000 };
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(30); }
  throw new Error('Expected runtime lifecycle observation did not arrive');
}
async function fixture(t, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-mesh-')), root = join(directory, 'root'), packDirectory = join(directory, 'pack');
  const sessions = []; await mkdir(packDirectory);
  t.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    for (const session of sessions) if (session.children) assert.ok(session.children.every(handle => handle.exit && !handle.cleanupIncomplete), 'Every actual owned child must retire');
    await rm(directory, { recursive: true, force: true });
  });
  const contract = { id: 'mesh.fixture', version: '1.0.0' };
  const specifications = settings.components ?? [{ id: 'entry' }];
  for (const moduleId of new Set(specifications.map(component => component.module ?? 'mesh.fixture'))) {
    const source = join(packDirectory, 'modules', moduleId); await mkdir(join(source, 'sdk'), { recursive: true });
    const template = (await readFile(join(repository, 'tests/integration/ecosystem-runtime/fixtures/program.mjs'), 'utf8'))
      .replace("if (mode === 'early-exit') process.exit(19);", "if (mode === 'source-tamper-before-next') await writeFile(new URL('./' + 'unreviewed.txt', import.meta.url), 'changed after review');\nif (mode === 'early-exit') process.exit(19);")
      .replace('closed = true; clearInterval(keepalive);', "closed = true; clearInterval(keepalive); if (mode === 'staggered-pipe-failure') await new Promise(resolve => setTimeout(resolve, 4000));")
      .replace("const healthy = mode !== 'health-unready' || Date.now() - started <= 1500;", "const healthy = mode !== 'initial-health-unready' && (mode !== 'health-unready' || Date.now() - started <= 1500);");
    await writeFile(join(source, 'program.mjs'), template + "\nif (mode === 'exit-zero-after-ready') setTimeout(() => process.exit(0), 1200);\nif (mode === 'disconnect-after-ready') setTimeout(() => { void Promise.all(bridges.map(bridge => bridge.close('application disconnected'))); }, 1200);\nif (mode === 'staggered-pipe-failure') { const timer = setInterval(async () => { try { await readFile(join(config.stateDir, 'trigger-failure')); clearInterval(timer); process.stdout.write('X'.repeat(262144) + '\\n'); } catch {} }, 20); }\n");
    for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await writeFile(join(source, 'sdk', file), await readFile(join(repository, 'sdk/javascript', file)));
    await save(join(source, 'package.json'), { imports: { '#bridge': './sdk/bridge-kit.mjs' } });
    await save(join(source, 'module.json'), { format: 'world-hub.module/v1', id: moduleId, version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'],
      provides: moduleId === 'mesh.provider' ? [contract] : [], requires: moduleId === 'mesh.consumer' ? [contract] : [],
      permissions: { filesystem: 'instance-state', network: ['hub-loopback', 'loopback-listen'], processes: 'none' } });
  }
  const components = specifications.map(({ id, module = 'mesh.fixture', mode = 'normal', ...flags }) => ({ id, module, after: [], settings: { mode }, bridges: { main: { publish: ['events'], subscribe: ['events'] } }, ...flags }));
  const pack = { format: 'world-hub.pack/v1', id: 'test.presets', version: '1.0.0', title: 'Deployment presets fixture', license: 'MIT', topics: { events: 'mesh/events' }, components,
    bindings: settings.bindings ?? [], entry: { component: settings.entry ?? components[0].id }, startupTimeoutMs: 2500, healthTimeoutMs: 700, stopTimeoutMs: settings.stopTimeoutMs ?? 350,
    ...(settings.packType === null ? {} : { packType: settings.packType ?? 'mesh' }), ...(settings.lifecyclePolicy ? { lifecyclePolicy: settings.lifecyclePolicy } : {}),
    ...(settings.startupOrder ? { startupOrder: settings.startupOrder } : {}) };
  await save(join(packDirectory, 'pack.json'), pack); await createLock(packDirectory, { nodePath: process.execPath });
  const imported = await importPackage(packDirectory, { root, instanceId: 'scene', nodePath: process.execPath });
  const status = async () => JSON.parse(await readFile(join(imported.stateDir, 'status.json'), 'utf8'));
  const start = async extra => {
    try { const session = await startInstance({ root, instanceId: 'scene', nodePath: process.execPath, trust: imported.digest, ...extra }); sessions.push(session); return session; }
    catch (error) { if (error.runtimeSession) sessions.push(error.runtimeSession); throw error; }
  };
  const request = async (path, body) => {
    const control = JSON.parse(await readFile(join(imported.stateDir, 'control.json'), 'utf8'));
    const response = await fetch(control.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error.message), { code: value.error.code }); return value;
  };
  const change = async operation => {
    const current = await request('/assembly'), review = await request('/assembly/preview', { runId: current.runId, revision: current.revision, operation });
    return request('/assembly/apply', { runId: review.runId, revision: review.revision, digest: review.digest, accepted: true });
  };
  return { directory, root, pack, packDirectory, stateDir: imported.stateDir, status, start, request, change, contract };
}

test('pack presets are explicit and independently overridable, with strict boolean declarations and public summary defaults', async t => {
  const app = await fixture(t, { packType: null, lifecyclePolicy: 'independent', components: [{ id: 'entry', autostart: false }] });
  assert.equal(effectivePackType(app.pack), 'atomic'); assert.equal(effectiveLifecyclePolicy(app.pack), 'independent'); assert.equal(componentAutostarts(app.pack, app.pack.components[0]), false);
  assert.equal(effectiveLifecyclePolicy({ packType: 'mesh' }), 'independent'); assert.equal(effectiveLifecyclePolicy({ packType: 'mesh', lifecyclePolicy: 'fail-fast' }), 'fail-fast');
  assert.equal(componentAutostarts({ packType: 'mesh' }, { autostart: false }), false);
  assert.equal(summarizePack(app.pack).components[0].critical, false);
  for (const patch of [{ packType: 'guess' }, { components: [{ ...app.pack.components[0], autostart: 1 }] }, { components: [{ ...app.pack.components[0], critical: 'true' }] }]) assert.throws(() => validatePack({ ...app.pack, ...patch }));
});

test('Runtime executes exact independent startup order, keeps manual members stopped and uses it for later multi-member starts', options, async t => {
  const app = await fixture(t, { components: [{ id: 'first' }, { id: 'second' }, { id: 'third' }, { id: 'manual', autostart: false }], startupOrder: ['second','manual','first','third'] });
  const session = await app.start();
  assert.deepEqual(session.children.filter(handle => handle.id !== '$hub').map(handle => handle.id), ['second','first','third']);
  assert.equal((await session.status()).components.find(row => row.id === 'manual').process, 'stopped');
  assert.deepEqual((await session.status()).pack.startupOrder, ['second','manual','first','third']);
  await app.change({ kind: 'stop', ids: ['first','second','third'] });
  await app.change({ kind: 'start', ids: ['first','manual','third','second'] });
  const handles = session.children.filter(handle => handle.id !== '$hub');
  assert.deepEqual(handles.slice(-4).map(handle => handle.id), ['second','manual','first','third']);
});

test('all-manual Mesh entry starts only its Hub and can later independently start and stop through the existing reviewed API', options, async t => {
  const app = await fixture(t, { components: [{ id: 'entry', autostart: false, critical: true }] }), session = await app.start();
  const initial = await session.status(); assert.equal(initial.state, 'running'); assert.equal(initial.entryUrl, null); assert.equal(session.children.length, 1);
  assert.equal(initial.components[0].process, 'stopped'); assert.equal(initial.components[0].neverStarted, true); assert.equal(initial.components[0].pid, null);
  assert.equal(initial.pack.packType, 'mesh'); assert.equal(initial.pack.lifecyclePolicy, 'independent');
  await app.change({ kind: 'start', ids: ['entry'] }); const started = await session.status(); assert.ok(started.entryUrl); assert.equal(started.hub.pid, initial.hub.pid);
  await app.change({ kind: 'stop', ids: ['entry'] }); await pause(900); assert.equal((await session.status()).state, 'running', 'Planned critical member Stop is not an unexpected failure');
  await session.close(); await confirmedStopped(app.stateDir, 'scene');
});

test('Mesh noncritical initial process/readiness/health failures retire only those members while unrelated programs and Hub stay running', options, async t => {
  const app = await fixture(t, { components: [{ id: 'during-bootstrap', mode: 'exit-zero-after-ready' }, { id: 'bad-pipe', mode: 'oversize-line' }, { id: 'early', mode: 'early-exit' }, { id: 'unready', mode: 'no-ready' }, { id: 'unhealthy', mode: 'initial-health-unready' }, { id: 'healthy' }], entry: 'healthy' });
  const session = await app.start(), state = await session.status(); assert.equal(state.state, 'running'); assert.ok(state.entryUrl);
  for (const id of ['during-bootstrap', 'bad-pipe', 'early', 'unready', 'unhealthy']) { const row = state.components.find(row => row.id === id); assert.equal(row.process, 'failed'); assert.ok(row.exit); assert.equal(row.health.ready, false); }
  assert.equal(state.components.find(row => row.id === 'healthy').process, 'running'); assert.equal(state.pack.lifecyclePolicy, 'independent');
  assert.ok(session.children.filter(handle => ['during-bootstrap', 'bad-pipe', 'early', 'unready', 'unhealthy'].includes(handle.id)).every(handle => handle.exit && !handle.cleanupIncomplete));
});

test('Mesh after dependencies block without implicitly starting manual members, and an explicit ordered start clears the block', options, async t => {
  const app = await fixture(t, { components: [{ id: 'manual', autostart: false }, { id: 'dependent', after: ['manual'] }, { id: 'unrelated' }], entry: 'unrelated' });
  const session = await app.start(), initial = await session.status();
  const blocked = initial.components.find(row => row.id === 'dependent'); assert.equal(blocked.process, 'stopped'); assert.equal(blocked.pid, null); assert.deepEqual(blocked.blockedBy, ['manual']);
  assert.equal(initial.components.find(row => row.id === 'manual').pid, null); assert.equal(initial.components.find(row => row.id === 'unrelated').process, 'running');
  await assert.rejects(app.change({ kind: 'start', ids: ['dependent'] }), { code: 'ASSEMBLY_PROVIDER_STOPPED' });
  await app.change({ kind: 'start', ids: ['manual', 'dependent'] }); const current = await session.status();
  assert.equal(current.components.find(row => row.id === 'dependent').process, 'running'); assert.equal(current.components.find(row => row.id === 'dependent').blockedBy, undefined); assert.equal(current.hub.pid, initial.hub.pid);
});

test('critical requested startup failures and blocked initial startup stop the entire Mesh run', options, async t => {
  for (const components of [[{ id: 'unrelated' }, { id: 'critical', mode: 'early-exit', critical: true }], [{ id: 'manual', autostart: false }, { id: 'critical', critical: true, after: ['manual'] }]]) {
    const app = await fixture(t, { components }); await assert.rejects(app.start()); const state = await app.status(); assert.equal(state.state, 'failed'); assert.ok(state.stoppedAt); await confirmedStopped(app.stateDir, 'scene');
  }
});

test('critical runtime exit including code zero, health and communication failure stops an independent Mesh run', options, async t => {
  for (const mode of ['exit-zero-after-ready', 'health-unready', 'disconnect-after-ready']) {
    const app = await fixture(t, { components: [{ id: 'healthy' }, { id: 'critical', mode, critical: true }] }), session = await app.start();
    await until(async () => (await app.status()).stoppedAt); const state = await app.status(); assert.equal(state.state, 'failed'); assert.equal(state.failure.code, 'CRITICAL_COMPONENT_FAILED');
    if (mode === 'exit-zero-after-ready') assert.equal(session.children.find(handle => handle.id === 'critical').exit.code, 0);
  }
});

test('explicit failure policy overrides the preset and Atomic requires every selected initial member even with independent post-start policy', options, async t => {
  const mesh = await fixture(t, { lifecyclePolicy: 'fail-fast', components: [{ id: 'healthy' }, { id: 'failing', mode: 'early-exit' }] }); await assert.rejects(mesh.start()); assert.ok((await mesh.status()).stoppedAt);
  const atomic = await fixture(t, { packType: 'atomic', lifecyclePolicy: 'independent', components: [{ id: 'manual-flag', autostart: false }, { id: 'healthy' }, { id: 'failing', mode: 'early-exit' }] }); await assert.rejects(atomic.start());
  assert.equal((await atomic.status()).components.find(row => row.id === 'manual-flag').neverStarted, true);
  assert.equal((await atomic.status()).components.find(row => row.id === 'manual-flag').pid, null);
  assert.ok((await atomic.status()).components.find(row => row.id === 'healthy').exit, 'Already started selected members retire when another selected start fails');
  const configured = await fixture(t, { packType: 'atomic', lifecyclePolicy: 'independent', components: [{ id: 'healthy' }, { id: 'failing', mode: 'crash-after-ready' }] }), session = await configured.start();
  await until(async () => (await session.status()).components.find(row => row.id === 'failing').process === 'failed'); assert.equal((await session.status()).state, 'running');
  await configured.change({ kind: 'set-policy', policy: 'fail-fast' }); assert.equal((await session.status()).pack.lifecyclePolicy, 'fail-fast');
  await configured.change({ kind: 'start', ids: ['failing'] }); await until(async () => (await configured.status()).stoppedAt); assert.equal((await configured.status()).state, 'failed');
});

test('both presets keep capability bindings exact without treating them as implicit initial or reviewed startup dependencies', options, async t => {
  const binding = { from: 'provider', to: 'consumer', contract: { id: 'mesh.fixture', version: '1.0.0' } };
  for (const packType of ['atomic', 'mesh']) {
    const app = await fixture(t, { packType, components: [{ id: 'provider', module: 'mesh.provider', autostart: false }, { id: 'consumer', module: 'mesh.consumer' }], bindings: [binding], entry: 'consumer' });
    const session = await app.start(), initial = await session.status(); assert.equal(initial.components.find(row => row.id === 'provider').pid, null); assert.equal(initial.components.find(row => row.id === 'consumer').process, 'running');
    await app.change({ kind: 'stop', ids: ['consumer'] }); await app.change({ kind: 'start', ids: ['consumer'] });
    const current = await session.status(); assert.equal(current.components.find(row => row.id === 'provider').pid, null); assert.equal(current.components.find(row => row.id === 'consumer').process, 'running');
    await session.close(); await confirmedStopped(app.stateDir, 'scene');
  }
});

test('Atomic saved startup selects only requested members, waits for explicit prerequisites, and allows manual members later', options, async t => {
  const app = await fixture(t, { packType: 'atomic', components: [{ id: 'last', after: ['first'] }, { id: 'manual', autostart: false, critical: true, after: ['last'] }, { id: 'first' }], entry: 'manual' });
  const session = await app.start(), initial = await session.status();
  assert.equal(initial.state, 'running'); assert.equal(initial.startupMode, 'plan'); assert.equal(session.ready.startupMode, 'plan'); assert.equal(initial.entryUrl, null);
  assert.deepEqual(session.children.map(child => child.id), ['$hub', 'first', 'last']);
  assert.equal(initial.components.find(row => row.id === 'manual').neverStarted, true);
  const result = await fetch(initial.components.find(row => row.id === 'last').entryUrl).then(response => response.json()); assert.deepEqual(result.connected, [true]);
  await app.change({ kind: 'start', ids: ['manual'] }); const started = await session.status(); assert.ok(started.entryUrl); assert.equal(started.hub.pid, initial.hub.pid);
  await app.change({ kind: 'stop', ids: ['manual'] }); await pause(900);
  assert.equal((await session.status()).state, 'running', 'A planned critical Stop does not trigger Atomic group failure');
  assert.ok(session.children.filter(child => ['first', 'last'].includes(child.id)).every(child => !child.exit));
});

test('an Atomic selected member blocked by an unselected prerequisite retires the actual initial group and never starts that prerequisite', options, async t => {
  const app = await fixture(t, { packType: 'atomic', lifecyclePolicy: 'independent', components: [{ id: 'healthy' }, { id: 'manual', autostart: false }, { id: 'blocked', after: ['manual'] }] });
  await assert.rejects(app.start(), { code: 'COMPONENT_START_BLOCKED' }); const state = await app.status();
  assert.equal(state.state, 'failed'); assert.ok(state.stoppedAt); assert.ok(state.hub.exit);
  assert.ok(state.components.find(row => row.id === 'healthy').exit); assert.deepEqual(state.components.find(row => row.id === 'blocked').blockedBy, ['manual']);
  assert.equal(state.components.find(row => row.id === 'manual').pid, null); assert.equal(state.components.find(row => row.id === 'manual').neverStarted, true);
  await confirmedStopped(app.stateDir, 'scene');
});

test('all-manual Atomic starts its Hub and reviewed multi-start orders only explicitly selected prerequisites', options, async t => {
  const app = await fixture(t, { packType: 'atomic', components: [{ id: 'consumer', autostart: false, after: ['provider'] }, { id: 'provider', autostart: false }] });
  const session = await app.start(), initial = await session.status(); assert.equal(initial.state, 'running'); assert.equal(initial.entryUrl, null);
  assert.deepEqual(session.children.map(child => child.id), ['$hub']); assert.ok(initial.components.every(row => row.pid === null && row.neverStarted));
  await assert.rejects(app.change({ kind: 'start', ids: ['consumer'] }), { code: 'ASSEMBLY_PROVIDER_STOPPED' });
  assert.equal((await session.status()).state, 'running'); assert.equal(session.children.length, 1, 'Read-only review rejection cannot implicitly launch a prerequisite');
  await app.change({ kind: 'start', ids: ['consumer', 'provider'] }); assert.deepEqual(session.children.map(child => child.id), ['$hub', 'provider', 'consumer']);
  const current = await session.status(); assert.ok(current.entryUrl); assert.equal(current.hub.pid, initial.hub.pid);
});

test('temporary hub-only startup does not alter the saved plan and later reviewed starts work for either preset', options, async t => {
  for (const packType of ['atomic', 'mesh']) {
    const app = await fixture(t, { packType, components: [{ id: 'last', after: ['first'] }, { id: 'first' }] });
    const original = await readFile(join(app.stateDir, 'package', 'pack.json'), 'utf8'), session = await app.start({ startupMode: 'hub-only' }), initial = await session.status();
    assert.equal(initial.startupMode, 'hub-only'); assert.equal(session.ready.startupMode, 'hub-only'); assert.equal(initial.entryUrl, null);
    assert.deepEqual(session.children.map(child => child.id), ['$hub']); assert.ok(initial.components.every(row => row.autostart && row.pid === null && row.neverStarted));
    await app.change({ kind: 'start', ids: ['last', 'first'] }); assert.deepEqual(session.children.map(child => child.id), ['$hub', 'first', 'last']); assert.ok((await session.status()).entryUrl);
    assert.equal(await readFile(join(app.stateDir, 'package', 'pack.json'), 'utf8'), original);
    await session.close(); const planned = await app.start(); assert.equal((await planned.status()).startupMode, 'plan'); assert.deepEqual(planned.children.map(child => child.id), ['$hub', 'first', 'last']);
    await planned.close(); await confirmedStopped(app.stateDir, 'scene');
  }
});

test('invalid startup modes and unsupported isolated partial or hub-only startup reject before any ownership or process exists', options, async t => {
  const full = await fixture(t, { packType: 'atomic' });
  await assert.rejects(full.start({ startupMode: 'guess' }), { code: 'STARTUP_MODE_INVALID' });
  await assert.rejects(full.start({ startupMode: 'hub-only', isolation: { profile: 'docker-runtime/v1' } }), { code: 'STARTUP_PLAN_ISOLATION_UNSUPPORTED' });
  const partial = await fixture(t, { packType: 'atomic', components: [{ id: 'entry', autostart: false }] });
  await assert.rejects(partial.start({ isolation: { profile: 'docker-runtime/v1' } }), { code: 'STARTUP_PLAN_ISOLATION_UNSUPPORTED' });
  for (const app of [full, partial]) {
    await assert.rejects(readFile(join(app.stateDir, 'owner.lock')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(app.stateDir, 'status.json')), { code: 'ENOENT' });
  }
});

test('Mesh isolation requests fail before any owned process starts and never fall back to trusted-local', options, async t => {
  const app = await fixture(t, { components: [{ id: 'entry', autostart: false }] });
  await assert.rejects(app.start({ isolation: { profile: 'docker-runtime/v1' } }), { code: 'MESH_ISOLATION_UNSUPPORTED' });
  await assert.rejects(readFile(join(app.stateDir, 'owner.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(app.stateDir, 'status.json')), { code: 'ENOENT' });
});

test('Mesh optional startup never treats changed reviewed source as a tolerable program failure', options, async t => {
  const app = await fixture(t, { components: [{ id: 'tamper', mode: 'source-tamper-before-next' }, { id: 'optional' }] });
  await assert.rejects(app.start(), { code: 'ASSEMBLY_SOURCE_CHANGED' });
  const state = await app.status(); assert.equal(state.state, 'failed'); assert.equal(state.failure.code, 'ASSEMBLY_SOURCE_CHANGED'); assert.ok(state.stoppedAt);
  assert.equal(state.components.find(row => row.id === 'optional').pid, null); await confirmedStopped(app.stateDir, 'scene');
});

test('an unconfirmed owned cleanup during a reviewed optional start immediately fails the Mesh run and retains its owner for Stop retry', options, async t => {
  const app = await fixture(t, { components: [{ id: 'healthy' }, { id: 'optional', mode: 'no-ready', autostart: false }] }), session = await app.start();
  const pending = app.change({ kind: 'start', ids: ['optional'] }).then(result => ({ result }), error => ({ error }));
  const handle = await until(() => session.children.find(child => child.id === 'optional'));
  const realStop = handle.stop;
  // This is the existing owned handle returned to embedders, not a Runtime
  // test entry point. Make its retirement provider refuse confirmation while
  // the real process stays alive, then restore it for the explicit retry.
  handle.stop = async () => { handle.cleanupIncomplete = true; throw Object.assign(new Error('Owned retirement provider cannot confirm this process tree'), { code: 'HOST_CLEANUP_INCOMPLETE' }); };
  try {
    const outcome = await pending; assert.equal(outcome.error?.code, 'HOST_CLEANUP_INCOMPLETE');
    const state = await until(async () => { const current = await app.status(); return current.cleanupIncomplete && current; });
    assert.equal(state.state, 'failed'); assert.equal(state.failure.code, 'HOST_CLEANUP_INCOMPLETE');
    assert.equal(state.stoppedAt, undefined); assert.equal(handle.exit, null);
    await readFile(join(app.stateDir, 'owner.lock'));
    assert.ok(session.children.filter(child => child.id !== 'optional').every(child => child.exit), 'Unrelated owned members and Hub were stopped despite the failed retirement');
  } finally {
    handle.stop = async timeout => {
      const result = await realStop(timeout);
      assert.ok(handle.exit, 'The recovered provider clears its injected uncertainty only after the real owned exit');
      delete handle.cleanupIncomplete; return result;
    };
  }
  await session.close(); await confirmedStopped(app.stateDir, 'scene');
});

test('Mesh bootstrap drains newly queued retirement work from two ready members before announcing the workspace ready', options, async t => {
  const app = await fixture(t, { components: [{ id: 'first', mode: 'staggered-pipe-failure' }, { id: 'second', mode: 'staggered-pipe-failure' }, { id: 'waiting', mode: 'no-ready' }, { id: 'healthy' }], entry: 'healthy', stopTimeoutMs: 5000 });
  const starting = app.start();
  const startingState = await until(async () => {
    const state = await app.request('/status').catch(() => null);
    return state?.components.find(row => row.id === 'waiting' && row.pid) && state.components.find(row => row.id === 'second')?.readiness === 'ready' && state;
  });
  const originalFirstState = startingState.components.find(row => row.id === 'first'), originalSecondState = startingState.components.find(row => row.id === 'second');
  assert.ok(originalFirstState.pid); assert.ok(originalSecondState.pid);
  await writeFile(join(app.stateDir, 'programs/first/trigger-failure'), 'first ready member fails');
  await until(async () => (await app.request('/status')).components.find(row => row.id === 'first')?.process === 'failed');
  await until(async () => {
    const state = await app.request('/status');
    return state.state === 'starting' && state.components.find(row => row.id === 'healthy')?.readiness === 'ready'
      && !state.components.find(row => row.id === 'first')?.exit;
  });
  // The first real process is still acknowledging its graceful Stop. The
  // second failure now appends retirement work while bootstrap awaits it.
  await writeFile(join(app.stateDir, 'programs/second/trigger-failure'), 'second ready member fails later');
  const session = await starting, state = await session.status();
  assert.equal(state.state, 'running'); assert.equal(state.components.find(row => row.id === 'healthy').process, 'running');
  for (const id of ['first', 'second']) {
    const row = state.components.find(component => component.id === id), handle = session.children.find(child => child.id === id);
    assert.equal(row.process, 'failed'); assert.ok(row.exit); assert.ok(handle.exit); assert.equal(handle.cleanupIncomplete, undefined);
  }
});
