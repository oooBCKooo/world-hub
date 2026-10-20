// Executed outside the installed npm tree. All product code comes from that tree.
// The filename is retained internally; the retired Launcher is never started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(fileURLToPath(import.meta.resolve('world-hub/package.json')));
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(pkg.exports['./runtime'], undefined);
await assert.rejects(import('world-hub/runtime'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
for (const file of ['bin/world-hub-pack.mjs', 'tools/launcher/cli.mjs', 'tools/launcher/server.mjs', 'tools/launcher/manager.mjs', 'tools/launcher/public/index.html']) {
  await assert.rejects(access(join(packageRoot, file)), { code: 'ENOENT' });
}
const child = spawn(process.execPath, [join(packageRoot, 'bin/world-hub.mjs'), '--port', '0', '--data-dir', join(workspace, 'headless-data')], {
  cwd: workspace, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
});
let stderr = '', readyObserved = false, resolveReady, rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
child.stdout.on('data', () => {});
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-65536); });
child.once('error', rejectReady);
child.on('message', message => {
  if (message?.type === 'ready') { readyObserved = true; resolveReady(message); }
  if (message?.type === 'error') rejectReady(new Error(message.message));
});
const exit = new Promise(resolveExit => child.once('exit', (code, signal) => {
  resolveExit({ code, signal });
  if (!readyObserved) rejectReady(new Error(`Installed native management exited before ready (${code ?? signal}): ${stderr}`));
}));
const startupTimer = setTimeout(() => rejectReady(new Error('Installed native management startup deadline exceeded')), 20000);
let endpoint, result;
async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return exit;
  if (child.connected) child.send({ type: 'stop' });
  else child.kill();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { return await exit; } finally { clearTimeout(deadline); }
}
try {
  const receipt = await ready; clearTimeout(startupTimer);
  assert.ok(Number.isInteger(receipt.port) && receipt.port > 0);
  endpoint = `http://127.0.0.1:${receipt.port}`;
  const request = async (path, body, token, expected = 200) => {
    const response = await fetch(new URL(path, endpoint), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: body === undefined ? {} : { origin: endpoint, 'content-type': 'application/json', ...(token ? { 'x-management-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  assert.equal(receipt.managementUrl, undefined);
  assert.equal(receipt.debugUrl, undefined);
  assert.equal(receipt.statusUrl, endpoint + '/status');
  assert.equal(receipt.managementApiUrl, endpoint + '/manage/api');
  const removedRoutes = ['/manage', '/debug', '/ui/language.mjs', '/manage/canvas-modes.mjs', '/manage/manual-console.mjs'];
  for (const path of removedRoutes) {
    const response = await fetch(endpoint + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 404, path);
  }
  const snapshot = await request('/manage/api/state');
  assert.equal(typeof snapshot.csrfToken, 'string');
  const programs = await request('/manage/api/programs');
  assert.deepEqual(programs.programs, []); assert.deepEqual(programs.groups, []);
  assert.deepEqual((await request('/manage/api/groups')).groups, []);
  await request('/manage/api/layout', { nodes: {} }, undefined, 403);
  const layout = await request('/manage/api/layout', { nodes: { 'npm-native-probe': { x: 25, y: -50 } } }, snapshot.csrfToken);
  assert.equal(layout.ok, true);
  assert.deepEqual((await request('/manage/api/layout')).layout.nodes['npm-native-probe'], { x: 25, y: -50 });
  const crossOrigin = await fetch(endpoint + '/manage/api/programs', { headers: { origin: 'https://external.invalid' }, signal: AbortSignal.timeout(5000) });
  assert.equal(crossOrigin.status, 403);
  result = { passed: true, version: pkg.version, nativeManagement: true, rejectedUiRoutes: removedRoutes.length, csrfRejected: true, crossOriginRejected: true, removedEntries: true };
} finally {
  clearTimeout(startupTimer);
  const stopped = await stop(); assert.equal(stopped.code, 0, stderr);
  if (endpoint) await assert.rejects(fetch(endpoint + '/status', { signal: AbortSignal.timeout(1000) }));
}
console.log(JSON.stringify({ ...result, stopped: true }));
