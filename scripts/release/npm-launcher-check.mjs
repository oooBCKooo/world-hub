// Executed outside the installed npm tree. All product code comes from that tree.
// The filename is retained internally; the retired Launcher is never started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const workspace = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(fileURLToPath(import.meta.resolve('world-hub/package.json')));
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(pkg.exports['./runtime'], undefined);
await assert.rejects(import('world-hub/runtime'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
for (const file of ['bin/world-hub-pack.mjs', 'tools/launcher/cli.mjs', 'tools/launcher/server.mjs', 'tools/launcher/manager.mjs', 'tools/launcher/public/index.html']) {
  await assert.rejects(access(join(packageRoot, file)), { code: 'ENOENT' });
}
const child = spawn(process.execPath, [join(packageRoot, 'bin/world-hub.mjs'), '--port', '0', '--data-dir', join(workspace, 'native-ui-data')], {
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
  const page = await fetch(endpoint + '/manage', { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(hash(Buffer.from(await page.arrayBuffer())), hash(await readFile(join(packageRoot, 'src/management/console.html'))));
  const assets = [
    ['/ui/language.mjs', 'src/ui/language.mjs'],
    ['/manage/canvas-i18n.mjs', 'src/management/canvas-i18n.mjs'],
    ['/manage/canvas-modes.mjs', 'src/management/canvas-modes.mjs'],
    ['/manage/manual-i18n.mjs', 'src/management/manual-i18n.mjs'],
    ['/manage/manual-bridge.mjs', 'src/management/manual-bridge.mjs'],
    ['/manage/manual-console.mjs', 'src/management/manual-console.mjs'],
    ['/manage/manual-experience-state.mjs', 'src/management/manual-experience-state.mjs'],
    ['/manage/manual-console.css', 'src/management/manual-console.css']
  ];
  for (const [path, source] of assets) {
    const response = await fetch(endpoint + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, path); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(join(packageRoot, source))), source);
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
  result = { passed: true, version: pkg.version, nativeManagement: true, exactAssets: assets.length + 1, csrfRejected: true, crossOriginRejected: true, removedEntries: true };
} finally {
  clearTimeout(startupTimer);
  const stopped = await stop(); assert.equal(stopped.code, 0, stderr);
  if (endpoint) await assert.rejects(fetch(endpoint + '/status', { signal: AbortSignal.timeout(1000) }));
}
console.log(JSON.stringify({ ...result, stopped: true }));
