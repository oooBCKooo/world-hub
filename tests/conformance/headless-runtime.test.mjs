import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { REQUIRED_FILES, parseArgs, readyUrls } from '../../scripts/launcher-support.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));

test('headless CLI rejects browser opening and publishes only actual API endpoints', () => {
  assert.throws(() => parseArgs(['--open']), /world-hub-ui/);
  assert.equal(REQUIRED_FILES.some(file => /(?:\.html|\.css|src\/ui\/|src\/debug\/|canvas|manual-)/.test(file)), false);
  assert.deepEqual(readyUrls({ host: '127.0.0.1', port: 45678 }, '/bridge'), {
    bridgeUrl: 'ws://127.0.0.1:45678/bridge', managementApiUrl: 'http://127.0.0.1:45678/manage/api', statusUrl: 'http://127.0.0.1:45678/status',
  });
  assert.equal(readyUrls({ host: '192.0.2.5', port: 45678 }, '/bridge').managementApiUrl, null);
  assert.equal(readyUrls({ host: '::', port: 45678 }, '/bridge').statusUrl, 'http://[::1]:45678/status');
});

test('a distribution physically lacking all built-in UI starts, manages resources and carries real bridge traffic', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'world-hub-headless-'));
  let child, exited, output = '', errors = '';
  const bridges = [];
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close()));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.send({ type: 'stop' });
      const result = await Promise.race([exited, sleep(7000).then(() => null)]);
      if (!result) { child.kill(); await exited; }
    }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(basename(root), /^world-hub-headless-/);
    await rm(root, { recursive: true, force: true });
  });
  const distribution = join(root, 'distribution');
  await mkdir(distribution);
  for (const path of ['src/hub', 'scripts/runtime', 'sdk/javascript']) {
    await cp(join(ROOT, path), join(distribution, path), { recursive: true });
  }
  const managerFiles = ['management-http.mjs', 'management-modules.mjs', 'management-state.mjs', 'management-community.mjs'];
  for (const path of ['package.json', 'config/hub.json', 'bin/world-hub.mjs', 'scripts/launcher.mjs', 'scripts/launcher-support.mjs', 'scripts/cli-entry.mjs',
    ...managerFiles.map(name => `src/management/${name}`)]) {
    await mkdir(dirname(join(distribution, path)), { recursive: true });
    await cp(join(ROOT, path), join(distribution, path));
  }
  // Copy the non-UI lifecycle service dependency tree; never copy public assets.
  for (const item of await readdir(join(ROOT, 'tools/launcher'), { withFileTypes: true })) if (item.isFile()) {
    await mkdir(join(distribution, 'tools/launcher'), { recursive: true });
    await cp(join(ROOT, 'tools/launcher', item.name), join(distribution, 'tools/launcher', item.name));
  }
  assert.deepEqual((await readdir(join(distribution, 'src/management'))).sort(), managerFiles.sort());
  await assert.rejects(readFile(join(distribution, 'src/debug/page.mjs')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(distribution, 'src/ui/language.mjs')), { code: 'ENOENT' });
  const config = join(root, 'hub.json');
  await writeFile(config, JSON.stringify({ transport: { host: '127.0.0.1', port: 0 }, acl: { bridges: {
    source: { token: 'test-headless-source', allow: { publish: ['test/#'], subscribe: [] } },
    reader: { token: 'test-headless-reader', allow: { publish: [], subscribe: ['test/#'] } },
  } } }));
  child = fork(join(distribution, 'bin/world-hub.mjs'), ['--config', config, '--data-dir', join(root, 'data'), '--port', '0'], {
    cwd: root, silent: true, windowsHide: true,
  });
  exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  let ready;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && child.exitCode === null && !ready) {
    for (const line of output.split(/\r?\n/)) {
      try { const event = JSON.parse(line); if (event.event === 'ready') ready = event; } catch {}
    }
    if (!ready) await sleep(20);
  }
  assert.ok(ready, `headless process did not become ready: ${errors}`);
  assert.equal(Object.hasOwn(ready, 'managementUrl'), false);
  assert.equal(Object.hasOwn(ready, 'debugUrl'), false);
  assert.equal(ready.statusUrl, `http://127.0.0.1:${ready.port}/status`);
  assert.equal(ready.managementApiUrl, `http://127.0.0.1:${ready.port}/manage/api`);
  const base = new URL(ready.statusUrl).origin;
  const descriptorResponse = await fetch(base);
  assert.match(descriptorResponse.headers.get('content-type'), /^application\/json/);
  const descriptor = await descriptorResponse.json();
  assert.equal(descriptor.interface, 'headless');
  assert.deepEqual(descriptor.ui, { project: 'world-hub-ui', bundled: false });
  for (const path of ['/manage', '/manage/', '/manage/index.html', '/manage/console.html', '/manage/canvas-modes.mjs', '/ui/language.mjs']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal((await response.json()).error.code, 'UI_SEPARATE_PROJECT');
  }
  for (const path of ['/status', '/log', '/manage/api', '/manage/api/programs', '/manage/api/resources']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    await response.json();
  }
  const state = await fetch(base + '/manage/api/state').then(response => response.json());
  assert.ok(state.csrfToken);
  const mutation = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'source', action: 'pause' }) };
  assert.equal((await fetch(base + '/manage/api/bridge', mutation)).status, 403);
  assert.equal((await fetch(base + '/manage/api/bridge', { ...mutation, headers: { ...mutation.headers, 'x-management-token': state.csrfToken, origin: 'http://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/manage/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const paused = await fetch(base + '/manage/api/bridge', { ...mutation, headers: { ...mutation.headers, 'x-management-token': state.csrfToken } });
  assert.equal(paused.status, 200);
  const resumed = await fetch(base + '/manage/api/bridge', { ...mutation, headers: { ...mutation.headers, 'x-management-token': state.csrfToken }, body: JSON.stringify({ key: 'source', action: 'resume' }) });
  assert.equal(resumed.status, 200);
  const source = new Bridge({ url: ready.endpoint, bridgeId: 'source', token: 'test-headless-source' });
  const reader = new Bridge({ url: ready.endpoint, bridgeId: 'reader', token: 'test-headless-reader' });
  bridges.push(source, reader);
  await Promise.all(bridges.map(bridge => bridge.connect()));
  const deliveries = [];
  reader.on('delivery', frame => deliveries.push(frame));
  await reader.subscribe(['test/#'], { from: 0 });
  const receipt = await source.publishConfirmed('test/headless', { message: 'UI is an optional external client' });
  const deliveryDeadline = Date.now() + 3000;
  while (!deliveries.some(frame => frame.seq === receipt.seq) && Date.now() < deliveryDeadline) await sleep(10);
  assert.deepEqual(deliveries.find(frame => frame.seq === receipt.seq)?.body, { message: 'UI is an optional external client' });
  await Promise.all(bridges.map(bridge => bridge.close()));
  child.send({ type: 'stop' });
  const stopped = await Promise.race([exited, sleep(6000).then(() => null)]);
  assert.deepEqual(stopped, { code: 0, signal: null }, errors);
});
