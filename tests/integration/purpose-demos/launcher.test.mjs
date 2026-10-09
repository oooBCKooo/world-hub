import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { parseDemoArgs, checkDemo, startPurposeDemo, DEMO_TOKEN } from '../../../examples/purpose-demos/run-demo.mjs';
import { principalFor, bridgeFor } from '../../../examples/purpose-demos/profiles.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-purpose-launcher-'));
  t.ownedPurposeApps = [];
  t.after(async () => {
    for (const app of [...t.ownedPurposeApps].reverse()) {
      await app.close();
      for (const child of app.children) {
        assert.deepEqual(child.exited, { code: 0, signal: null }, child.stderr);
        assert.equal(alive(child.child.pid), false);
      }
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('world-hub-purpose-launcher-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function session(t, directory) {
  const app = await startPurposeDemo({ profile: 'event-desk', stateDirectory: directory });
  t.ownedPurposeApps.push(app);
  return app;
}

test('capability launcher isolates provider credentials and rejects the public demo token', async t => {
  const directory = await workspace(t);
  const app = await startPurposeDemo({ profile: 'capability-directory', stateDirectory: join(directory, 'isolated') });
  t.ownedPurposeApps.push(app);
  const config = JSON.parse(await readFile(join(app.ready.stateDirectory, 'hub.json'), 'utf8'));
  const principals = [...app.profile.peers.map(peer => principalFor(app.profile.id, peer.id)), principalFor(app.profile.id, 'explorer')];
  const tokens = principals.map(principal => config.acl.credentials[principal].token);
  assert.equal(new Set(tokens).size, principals.length);
  const publicReady = JSON.stringify(app.ready);
  for (const token of tokens) {
    assert.match(token, /^[a-f0-9-]{36}$/); assert.notEqual(token, DEMO_TOKEN); assert.equal(publicReady.includes(token), false);
  }
  const explorerSettings = JSON.parse(await readFile(join(app.ready.stateDirectory, 'explorer-settings.json'), 'utf8'));
  assert.equal(explorerSettings.credential, config.acl.credentials[principalFor(app.profile.id, 'explorer')].token);
  const socket = new WebSocket(app.ready.endpoint);
  const observed = await new Promise((resolveReceipt, rejectReceipt) => {
    const timer = setTimeout(() => { socket.close(); rejectReceipt(new Error('Public credential refusal was not received')); }, 5000);
    const finish = value => { clearTimeout(timer); socket.close(); resolveReceipt(value); };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', wire: '0.1',
      bridge: 'attempted-provider', credential: principalFor(app.profile.id, 'metrics-a'), token: DEMO_TOKEN, role: 'both' })));
    socket.addEventListener('message', event => finish(JSON.parse(event.data)));
    socket.addEventListener('error', () => { clearTimeout(timer); rejectReceipt(new Error('Unexpected socket failure')); });
  });
  assert.equal(observed.type, 'denied'); assert.equal(observed.code, 'BRIDGE_TOKEN_REJECTED');
});

test('purpose launcher rejects ambiguous arguments and mutually exclusive modes', () => {
  assert.deepEqual(parseDemoArgs(['--profile', 'event-desk', '--state-dir', '中文 空格', '--check']),
    { profile: 'event-desk', stateDirectory: '中文 空格', check: true, open: false, help: false });
  for (const args of [['--profile'], ['--state-dir', ''], ['--state-dir', '--open'], ['--profile', 'x', '--profile', 'x'],
    ['--unexpected'], ['--check', '--open']]) assert.throws(() => parseDemoArgs(args));
});

test('environment checks are read-only and existing session directories are never reused', async t => {
  const directory = await workspace(t), newSession = join(directory, '尚不存在的会话');
  const checked = await checkDemo({ profile: 'event-desk', stateDirectory: newSession });
  assert.equal(checked.passed, true); assert.equal(checked.persisted, false); assert.equal(checked.startsPrograms, false);
  await assert.rejects(lstat(newSession), { code: 'ENOENT' });
  const before = await readdir(directory);
  await assert.rejects(startPurposeDemo({ profile: 'event-desk', stateDirectory: directory }), /尚不存在/);
  await assert.rejects(startPurposeDemo({ profile: 'nonexistent', stateDirectory: newSession }), /未知/);
  assert.deepEqual(await readdir(directory), before);
});

test('explorer serves actual assets, rejects invalid operations, and exports program results without operation tokens', async t => {
  const directory = await workspace(t); const app = await session(t, join(directory, '中文 空格 会话'));
  const base = app.ready.url;
  const response = await fetch(base), page = await response.text();
  assert.equal(response.status, 200); assert.match(page, /id="programs"/);
  assert.match(page, /id="dashboard"/); assert.match(page, /运行这个操作/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const asset of ['explorer.css', 'explorer.js', 'explorer-i18n.mjs', '/src/ui/language.mjs']) {
    const resource = await fetch(new URL(asset, base));
    assert.equal(resource.status, 200, asset);
    if (asset.endsWith('.mjs') || asset.endsWith('.js')) assert.match(resource.headers.get('content-type'), /javascript/);
  }
  const state = await (await fetch(new URL('api/state', base))).json();
  assert.equal(state.explorer.connected, true); assert.equal(state.hubStatus.bridges.length, 6);
  const management = await (await fetch(new URL('/manage/api/state', app.ready.managementUrl))).json();
  const expectedPrincipals = [...app.profile.peers.map(peer => principalFor(app.profile.id, peer.id)),
    principalFor(app.profile.id, 'explorer'), 'ui.manual'].sort();
  assert.deepEqual(management.bridges.map(entry => entry.key).sort(), expectedPrincipals,
    'declared instance IDs must not create additional offline annotation principals');
  for (const peer of app.profile.peers) {
    const principal = principalFor(app.profile.id, peer.id), annotated = management.bridges.find(entry => entry.key === principal);
    assert.equal(annotated.kind, 'credential'); assert.equal(annotated.manageable, true);
    assert.deepEqual(annotated.programs, [{ id: principal, name: peer.label }]);
    assert.equal(annotated.instances.length, peer.bridges.length);
    assert.deepEqual(annotated.instances.map(instance => instance.declaredId).sort(),
      peer.bridges.map(bridge => bridgeFor(app.profile.id, peer.id, bridge.id)).sort());
    assert.ok(annotated.instances.every(instance => instance.principal === principal));
  }
  const sensor = management.bridges.find(entry => entry.key === principalFor(app.profile.id, 'sensor'));
  assert.equal(new Set(sensor.instances.map(instance => instance.bridgeId)).size, 2);
  assert.equal(new Set(sensor.instances.map(instance => instance.session)).size, 2);
  const explorer = management.bridges.find(entry => entry.key === principalFor(app.profile.id, 'explorer'));
  assert.deepEqual(explorer.programs, [{ id: explorer.key, name: '用途探索界面' }]);
  assert.equal(explorer.instances.length, 1);
  const action = state.profile.actions.find(value => value.id === 'sensor-reading');
  const post = (body, headers = {}) => fetch(new URL('api/action', base), { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-demo-token': state.operationToken, ...headers }, body });
  assert.equal((await post(JSON.stringify({ id: action.id }), { 'x-demo-token': 'wrong' })).status, 403);
  assert.equal((await post(JSON.stringify({ id: action.id }), { origin: 'http://external.invalid' })).status, 403);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ id: 'not-a-profile-action' }))).status, 400);
  const valid = await post(JSON.stringify({ id: action.id, body: action.body }));
  assert.equal(valid.status, 200);
  const result = (await valid.json()).result;
  assert.equal(result.response.body.ok, true);
  assert.equal(result.response.fromPrincipal, action.target.principal);
  assert.ok(result.response.seq > result.receipt.seq);
  const exported = await (await fetch(new URL('api/export', base))).json();
  assert.equal(exported.results.length, 1); assert.equal(exported.operationToken, undefined);
  assert.equal(exported.results[0].response.seq, result.response.seq);
  const file = JSON.parse(await readFile(join(app.ready.stateDirectory, 'explorer-results.json'), 'utf8'));
  assert.equal(file.results[0].receipt.seq, result.receipt.seq);
  assert.equal(file.operationToken, undefined);
});

test('two simultaneous copies use distinct ports and preserve separate business and Hub data', async t => {
  const directory = await workspace(t);
  const first = await session(t, join(directory, 'first'));
  const second = await session(t, join(directory, 'second'));
  assert.notEqual(first.ready.endpoint, second.ready.endpoint); assert.notEqual(first.ready.url, second.ready.url);
  assert.notEqual(first.ready.stateDirectory, second.ready.stateDirectory);
  const command = async (app, id, body) => {
    const state = await (await fetch(new URL('api/state', app.ready.url))).json();
    const response = await fetch(new URL('api/action', app.ready.url), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-demo-token': state.operationToken }, body: JSON.stringify({ id, body }) });
    assert.equal(response.status, 200); return (await response.json()).result.response.body;
  };
  const changed = await command(first, 'sensor-settings', { command: 'configure', offset: 15 });
  assert.equal(changed.ok, true); assert.equal(changed.offset, 15);
  const independent = await command(second, 'sensor-reading', { command: 'snapshot' });
  assert.equal(independent.offset, 0);
  await first.close();
  for (const child of first.children) assert.equal(alive(child.child.pid), false);
  assert.equal((await fetch(second.ready.url)).status, 200);
  assert.equal((await command(second, 'sensor-reading', { command: 'snapshot' })).ok, true);
  assert.ok((await readdir(first.ready.stateDirectory)).includes('stopped.json'));
});
