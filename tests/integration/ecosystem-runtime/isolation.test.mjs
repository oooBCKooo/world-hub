import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { workspace, save } from '../launcher/helpers.mjs';
import { planIsolation, probeIsolation, ownIsolatedProcess, isolationSeccomp } from '../../../scripts/runtime/isolation.mjs';
import { channelChunks, collectChannelChunk } from '../../../scripts/runtime/isolation-channel.mjs';
import { createHttpTunnel, containerHttpRequest, internalHttpUrl, validateHttpRequest, httpFrames } from '../../../scripts/runtime/isolation-http.mjs';

async function options(t) {
  const app = await workspace(t), sourceDirectory = join(app.directory, 'module'), stateDirectory = join(app.directory, 'state'), configPath = join(app.directory, 'config.json');
  await mkdir(sourceDirectory); await mkdir(stateDirectory); await writeFile(join(sourceDirectory, 'program.mjs'), 'throw new Error("must not run on the host");');
  await save(configPath, { format: 'world-hub.run/v1', bridges: [{ endpoint: 'ws://127.0.0.1:65534/bridge', bridgeId: 'fixture', credential: 'fixture', token: 'fixture' }] });
  return { app, dockerPath: process.execPath, endpoint: process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock', image: 'node@sha256:' + 'a'.repeat(64), runtime: 'node', sourceDirectory, stateDirectory, configPath, adapterDirectory: join(app.directory, 'adapter'), entry: 'program.mjs' };
}
test('ISOLATION-01 static planning binds executable, image, source, config and adapter without executing modules', async t => {
  const input = await options(t), plan = await planIsolation(input);
  assert.equal(plan.startsPrograms, false); assert.equal(plan.sandbox, false); assert.equal(plan.network, 'none');
  assert.equal(plan.filesystem.otherHostFiles, 'not-mounted'); assert.match(plan.digest, /^[a-f0-9]{64}$/);
  await writeFile(join(input.sourceDirectory, 'program.mjs'), 'throw new Error("different reviewed content");');
  assert.notEqual((await planIsolation(input)).digest, plan.digest);
  await assert.rejects(ownIsolatedProcess(plan, { trust: plan.digest }), { code: 'ISOLATION_REVIEW_CHANGED' });
  await assert.rejects(ownIsolatedProcess(plan, {}), { code: 'ISOLATION_REVIEW_REQUIRED' });
  input.app.record('static-only-digest-review', { digest: plan.digest, programsStarted: false });
});
test('ISOLATION-02 provider and unsupported program shapes fail closed without trusted-local fallback', async t => {
  const input = await options(t), plan = await planIsolation(input);
  const probe = await probeIsolation(input); assert.equal(probe.available, false); assert.equal(probe.startsContainers, false); assert.equal(probe.installsProvider, false);
  await assert.rejects(ownIsolatedProcess(plan, { trust: plan.digest }), { code: 'ISOLATION_PROVIDER_UNAVAILABLE' });
  for (const change of [{ image: 'node:latest' }, { runtime: 'python' }, { network: 'bridge' }, { endpoint: 'tcp://127.0.0.1:2375' }, { entryUrl: 'http://127.0.0.1:1234' }, { limits: { user: 0 } }]) await assert.rejects(planIsolation({ ...input, ...change }), /required|profile|local|Invalid|cannot/);
  await assert.rejects(planIsolation({ ...input, stateDirectory: input.sourceDirectory }), { code: 'ISOLATION_MOUNT_OVERLAP' });
  input.app.record('provider-unavailable-no-fallback', { probe });
});
test('ISOLATION-03 subprocess denial is a seccomp rule, not a PID or manifest claim; opaque bridge frames stay bounded', () => {
  const seccomp = isolationSeccomp(); assert.equal(seccomp.defaultAction, 'SCMP_ACT_ERRNO');
  assert.equal(seccomp.syscalls.flatMap(row => row.names).some(name => ['fork', 'vfork'].includes(name)), false);
  const clone = seccomp.syscalls.find(row => row.names.includes('clone')); assert.deepEqual(clone.args, [{ index: 0, value: 65536, valueTwo: 65536, op: 'SCMP_CMP_MASKED_EQ' }]);
  const text = JSON.stringify({ body: '🌍'.repeat(200000) }); let pending = null, received;
  for (const chunk of channelChunks('fixture', text)) { assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 131072); const result = collectChannelChunk(pending, chunk); pending = result.pending; received = result.text; }
  assert.equal(received, text);
  assert.throws(() => collectChannelChunk(null, { operation: 'chunk', index: 1, final: false, text: 'x' }), /order/);
  assert.throws(() => channelChunks('fixture', 'x'.repeat(4 * 1024 * 1024 + 1)), /exceeds/);
});
test('ISOLATION-04 modern runtime planning binds Python versions and HTTP review, old profile remains headless', async t => {
  const input = await options(t); input.runtime = 'python';
  await writeFile(join(input.sourceDirectory, 'program.py'), 'raise Exception("must not execute on host")'); input.entry = 'program.py';
  await save(input.configPath, { format: 'world-hub.run/v1', componentId: 'ui', bridges: [{ endpoint: 'ws://127.0.0.1:65534/bridge', bridgeId: 'fixture', credential: 'fixture', token: 'fixture' }] });
  await assert.rejects(planIsolation(input), { code: 'ISOLATION_RUNTIME_UNSUPPORTED' });
  const modern = { ...input, profile: 'docker-runtime/v1', images: { python: 'python@sha256:' + 'b'.repeat(64) }, expectedRuntime: { version: '3.14.0', packages: { websockets: '15.0.1' } }, http: { components: ['ui'] } };
  const plan = await planIsolation(modern); assert.equal(plan.runtime, 'python'); assert.equal(plan.httpAllowed, true); assert.equal(plan.network, 'none'); assert.equal(plan.expectedRuntime.packages.websockets, '15.0.1');
  assert.notEqual((await planIsolation({ ...modern, http: { components: [] } })).digest, plan.digest);
  await assert.rejects(planIsolation({ ...modern, expectedRuntime: { version: '3.14.0', packages: {} } }), { code: 'ISOLATION_ENVIRONMENT_REQUIRED' });
  const unavailable = await probeIsolation({ profile: 'linux-existing-user/v1', setprivPath: process.execPath, user: { uid: 1000, gid: 1000 } });
  if (process.platform !== 'linux' || process.getuid?.() !== 0) { assert.equal(unavailable.available, false); assert.equal(unavailable.error.code, 'ISOLATION_USER_PRIVILEGE_REQUIRED'); }
  assert.equal(unavailable.sandbox, false); assert.equal(unavailable.createsAccounts, false); assert.equal(unavailable.changesHostPermissions, false);
});
test('ISOLATION-05 bounded HTTP tunnel addresses only its reviewed container entry and rejects host proxy, origins, upgrades and oversized bodies', async t => {
  let visits = 0; const target = createServer((request, response) => { visits++; if (request.url === '/redirect') { response.writeHead(302, { location: 'http://127.0.0.1:1/private' }); return response.end(); }
    response.writeHead(200, { 'content-type': 'application/json', 'content-security-policy': "default-src 'self'" }); response.end(JSON.stringify({ path: request.url })); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve)); const destination = 'http://127.0.0.1:' + target.address().port + '/'; let tunnel, incoming = new Map();
  tunnel = await createHttpTunnel(frame => { const result = collectChannelChunk(incoming.get(frame.connection), frame); if (result.pending) incoming.set(frame.connection, result.pending); else incoming.delete(frame.connection);
    if (result.text !== null) void containerHttpRequest(destination, JSON.parse(result.text)).then(response => { for (const chunk of httpFrames(frame.connection, response)) tunnel.receive(chunk); }); }, destination);
  t.after(async () => { await tunnel.close(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); });
  for (const value of ['http://example.com:80/', 'https://127.0.0.1:1234/', 'http://user@127.0.0.1:1234/', 'http://127.0.0.1:1234/?proxy=1']) assert.throws(() => internalHttpUrl(value));
  for (const frame of [{ operation: 'request', method: 'CONNECT', path: '/', headers: {}, body: '' }, { operation: 'request', method: 'GET', path: '//example.com/', headers: {}, body: '' }, { operation: 'request', method: 'GET', path: '/', headers: {}, body: 'not base64' }]) assert.throws(() => validateHttpRequest(frame));
  const successful = await fetch(new URL('/application?x=1', tunnel.url)); assert.equal(successful.status, 200); assert.deepEqual(await successful.json(), { path: '/application?x=1' }); assert.equal(successful.headers.get('content-security-policy'), "default-src 'self'");
  assert.equal((await fetch(tunnel.url, { headers: { origin: 'https://hostile.invalid' } })).status, 403);
  assert.equal((await fetch(tunnel.url, { method: 'POST', body: 'x'.repeat(1048577) })).status, 413);
  const redirected = await fetch(new URL('/redirect', tunnel.url), { redirect: 'manual' }); assert.equal(redirected.status, 302); assert.equal(redirected.headers.get('location'), null);
  const url = new URL(tunnel.url); const proxy = await new Promise((resolve, reject) => { const request = httpRequest({ hostname: '127.0.0.1', port: url.port, path: 'http://127.0.0.1:' + target.address().port + '/private' }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); request.once('error', reject); request.end(); });
  assert.equal(proxy, 403); assert.equal(visits, 2);
});
