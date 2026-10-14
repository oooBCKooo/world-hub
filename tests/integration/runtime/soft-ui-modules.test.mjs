import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { ownProcess } from '../../../scripts/runtime/process.mjs';
import { startHost } from '../../../examples/soft-ui-modules/desktop/host.mjs';
import { boundPrincipals } from '../../../examples/soft-ui-modules/desktop/config.mjs';
import { inspectDeployment } from '../../../scripts/runtime/deployment.mjs';
const root = resolve(import.meta.dirname, '../../..'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await callback(); if (value) return value; await delay(20); } throw new Error('Module integration condition timed out'); }
test('both formal module declarations and pinned deployment recipes inspect successfully', async () => {
  for (const name of ['desktop', 'counter']) { const directory = join(root, 'examples/soft-ui-modules', name), manifest = JSON.parse(await readFile(join(directory, 'module.json'), 'utf8')); if (name === 'desktop' && !['win32', 'linux'].includes(process.platform)) { await assert.rejects(inspectDeployment({ directory, manifest }), { code: 'HOST_LIFECYCLE_UNSUPPORTED' }); continue; } const inspected = await inspectDeployment({ directory, manifest }); assert.equal(inspected.deployment.format, 'world-hub.deployment/v1'); if (name === 'desktop') assert.deepEqual(inspected.dependencies.recipes, ['electron']); }
});
test('binding selects exact providers and consumers rather than hardcoded IDs', () => {
  const config = { componentId: 'window-service', peers: { shopper: { principal: 'customer.abc' }, other: { principal: 'other.xyz' } }, bindings: [{ from: 'window-service', to: 'shopper', contract: { id: 'soft-ui.windows', version: '1.0.0' } }] };
  assert.deepEqual(boundPrincipals(config, 'provider'), ['customer.abc']);
  assert.throws(() => boundPrincipals({ ...config, bindings: [] }, 'provider'), /binding/);
});
test('formal Host and Counter modules authenticate arbitrary bindings and preserve two-way business state', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-soft-module-')), hostState = join(directory, 'native-owner'), counterState = join(directory, 'business-owner');
  for (const path of [hostState, counterState, join(hostState, 'tmp'), join(counterState, 'tmp')]) await mkdir(path, { recursive: true });
  const principals = { windows: 'windows.' + randomUUID(), counter: 'counter.' + randomUUID() }, tokens = { windows: randomBytes(24).toString('base64url'), counter: randomBytes(24).toString('base64url') };
  const commands = 'custom/descriptions/' + randomUUID(), events = 'custom/interactions/' + randomUUID();
  const hubFile = join(directory, 'hub.json');
  await writeFile(hubFile, JSON.stringify({ version: '0.1', hub: { id: randomUUID() }, transport: { host: '127.0.0.1', port: 0, path: '/bridge' },
    log: { enabled: true, dir: join(directory, 'hub-log') }, acl: { defaultDeny: true, allowUnlistedBridges: false, bridges: {}, credentials: {
      [principals.windows]: { token: tokens.windows, maxConnections: 1, allow: { publish: [events], subscribe: [commands] } },
      [principals.counter]: { token: tokens.counter, maxConnections: 1, allow: { publish: [commands], subscribe: [events] } } } } }));
  const hub = ownProcess(process.execPath, [join(root, 'src/hub/hub-server.mjs'), '--config', hubFile, '--quiet'], { cwd: directory, temporary: join(hostState, 'tmp') });
  let host, counter;
  t.after(async () => { if (counter) await counter.stop(5000); await host?.close(); await hub.stop(1000); assert.ok(hub.exit); });
  const welcome = await hub.waitFor(frame => frame.event === 'ready', 10000);
  const common = { format: 'world-hub.run/v1', instanceId: randomUUID(), topics: { commands, events }, peers: { 'window-provider': { principal: principals.windows }, 'customer-app': { principal: principals.counter } },
    bindings: [{ from: 'window-provider', to: 'customer-app', contract: { id: 'soft-ui.windows', version: '1.0.0' } }] };
  const bridge = (role, pub, sub) => ({ slot: 'main', endpoint: welcome.endpoint, bridgeId: role + '.' + randomUUID(), credential: principals[role], principal: principals[role], token: tokens[role], publish: [pub], subscribe: [sub] });
  const hostConfig = { ...common, componentId: 'window-provider', stateDir: hostState, settings: {}, bridges: [bridge('windows', events, commands)] };
  const counterConfig = { ...common, componentId: 'customer-app', stateDir: counterState, settings: { title: 'Arbitrary business', 'view-id': 'customer-view', 'initial-count': 7 }, bridges: [bridge('counter', commands, events)] };
  const counterFile = join(directory, 'counter-run.json'); await writeFile(counterFile, JSON.stringify(counterConfig), { mode: 0o600 });
  const startCounter = async () => { counter = ownProcess(process.execPath, [join(root, 'examples/soft-ui-modules/counter/program.mjs'), '--runtime-config', counterFile], { cwd: counterState, temporary: join(counterState, 'tmp'), secrets: [tokens.counter] }); await counter.waitFor(frame => frame.event === 'module-ready', 10000); };
  host = await startHost(hostConfig);
  const api = (path, body) => fetch(host.origin + path, { method: body ? 'POST' : 'GET', headers: { 'X-Soft-UI-Token': host.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const view = async () => (await (await api('/api/views')).json()).views[0];
  const count = item => item.root.children.find(node => node.type === 'metric').value;
  await startCounter(); const first = await until(async () => await view()); assert.equal(count(first), 7); assert.equal(first.principal, principals.counter);
  const event = { key: first.key, action: 'click', elementId: 'inc', revision: first.revision, eventId: randomUUID() };
  assert.equal((await api('/api/event', event)).status, 200);
  const updated = await until(async () => { const current = await view(); return count(current) === 8 ? current : null; });
  assert.equal((await api('/api/event', event)).status, 409);
  await counter.stop(5000); await startCounter();
  const resumed = await until(async () => { const current = await view(); return current.revision > updated.revision ? current : null; }); assert.equal(count(resumed), 8);
  await host.close(); host = await startHost(hostConfig);
  const restored = await view(); assert.equal(count(restored), 8); assert.equal(restored.revision, resumed.revision);
  const snapshot = JSON.parse(await readFile(join(counterState, 'counter.json'), 'utf8')); assert.equal(snapshot.count, 8); assert.equal(snapshot.pending, null);
});
