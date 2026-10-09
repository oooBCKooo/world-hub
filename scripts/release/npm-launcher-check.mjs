// Copied beside a clean npm installation, after npm-runtime-check generated its pack.
// All service, UI, Runtime and SDK files used here come from the installed tarball.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const workspace = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(fileURLToPath(import.meta.resolve('world-hub/package.json')));
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const { createLauncherServer } = await import(pathToFileURL(join(packageRoot, 'tools/launcher/server.mjs')));
const launcher = await createLauncherServer({ root: join(workspace, 'launcher-acceptance/instances'), nodePath: process.execPath, version: pkg.version });
const origin = new URL(launcher.url).origin;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let credentials, finalStatus;
async function request(path, body, expected = 200) {
  const response = await fetch(new URL(path, launcher.url), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(credentials ? { Authorization: `Bearer ${credentials.token}`, 'X-CSRF-Token': credentials.csrfToken } : {}),
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
async function complete(operationId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const { operation } = await request(`/api/operations/${operationId}`);
    if (operation.state === 'failed') throw new Error(operation.error?.message ?? 'Installed Launcher operation failed');
    if (operation.state === 'succeeded') return operation.result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Installed Launcher operation deadline exceeded');
}
try {
  await request('/api/instances', undefined, 401);
  const code = new URLSearchParams(new URL(launcher.launchUrl).hash.slice(1)).get('launch');
  credentials = await request('/api/session', { code });
  assert.equal(credentials.softwareVersion, pkg.version);
  assert.equal((await request('/api/instances')).instances.length, 0);
  for (const [url, path] of [['/', 'index.html'], ['/app.mjs', 'app.mjs'], ['/style.css', 'style.css'], ['/i18n.mjs', 'i18n.mjs']]) {
    const response = await fetch(new URL(url, launcher.url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(join(packageRoot, 'tools/launcher/public', path))), path);
  }
  const reviewed = await request('/api/review', { directory: join(workspace, 'runtime-acceptance/pack'), nodePath: process.execPath });
  const imported = await request('/api/instances', { reviewId: reviewed.reviewId, instanceId: 'installed-ui' });
  assert.equal(imported.instance.status.state, 'imported');
  const review = await request('/api/instances/installed-ui/review', {});
  await request('/api/instances/installed-ui/start', { reviewId: review.reviewId, accepted: false }, 409);
  assert.equal((await request('/api/instances/installed-ui')).instance.status.state, 'imported');
  await complete((await request('/api/instances/installed-ui/start', { reviewId: review.reviewId, accepted: true }, 202)).operationId);
  const { instance } = await request('/api/instances/installed-ui');
  assert.equal(instance.status.state, 'running');
  assert.equal(instance.status.components[0].process, 'running');
  assert.equal(instance.status.components[0].communication, 'connected');
  assert.equal(instance.status.components[0].readiness, 'ready');
  assert.equal(instance.status.components[0].health.ready, true);
  const { topology } = await request(`/api/instances/installed-ui/topology?runId=${encodeURIComponent(instance.status.runId)}`);
  assert.equal(topology.bridges.length, 1); assert.equal(topology.bridges[0].ownership, 'managed');
  assert.equal(topology.bridges[0].componentId, 'peer'); assert.equal(topology.bridges[0].moduleId, 'npm.peer');
  assert.equal(topology.bridges[0].pid, instance.status.components[0].pid);
  const { logs } = await request('/api/instances/installed-ui/logs'); assert.equal(logs.instanceId, 'installed-ui');
  await complete((await request('/api/instances/installed-ui/stop', {}, 202)).operationId);
  finalStatus = (await request('/api/instances/installed-ui')).instance.status;
  assert.equal(finalStatus.state, 'stopped'); assert.ok(finalStatus.stoppedAt); assert.equal(finalStatus.cleanupIncomplete, undefined);
  const exported = await complete((await request('/api/instances/installed-ui/export', { destination: join(workspace, 'launcher-acceptance/export') }, 202)).operationId);
  assert.equal(exported.includesRuntimeState, false);
} finally { await launcher.close(); }
console.log(JSON.stringify({ passed: true, version: pkg.version, authenticated: true, staticAssets: 4, explicitExecution: true,
  imported: true, started: true, observed: true, mapped: true, logs: true, stopped: Boolean(finalStatus.stoppedAt), exported: true }));
