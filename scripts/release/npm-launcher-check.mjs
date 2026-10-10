// Copied beside a clean npm installation, after npm-runtime-check generated its pack.
// All service, UI, Runtime and SDK files used here come from the installed tarball.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
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
let credentials, finalStatus, restoredStatus;
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
  for (const [url, path] of [['/', 'index.html'], ['/app.mjs', 'app.mjs'], ['/style.css', 'style.css'], ['/i18n.mjs', 'i18n.mjs'], ['/advanced.mjs', 'advanced.mjs']]) {
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

  // These calls exercise the installed maintenance/authoring/source dependency
  // closure and its current authorization contract, using only disposable data.
  const fixture = JSON.stringify({ text: 'Installed maintenance 世界', saved: true });
  await writeFile(join(imported.instance.directory, 'programs/peer/business.json'), fixture, { flag: 'wx' });
  const { storage } = await request('/api/instances/installed-ui/storage');
  assert.equal(storage.consistency, 'stopped');
  const backup = join(workspace, 'launcher-acceptance/private.whbackup');
  await request('/api/instances/installed-ui/backup', { destination: backup, accepted: false }, 409);
  const saved = await complete((await request('/api/instances/installed-ui/backup', { destination: backup, accepted: true }, 202)).operationId);
  const { inspection } = await request('/api/backups/inspect', { backup });
  assert.equal(inspection.sha256, saved.sha256); assert.equal(inspection.compatible, true);
  const restored = await complete((await request('/api/backups/restore', { backup, sha256: inspection.sha256,
    instanceId: 'installed-restored', nodePath: process.execPath, accepted: true }, 202)).operationId);
  assert.equal(restored.instance.status.state, 'imported');
  assert.equal(await readFile(join(restored.instance.directory, 'programs/peer/business.json'), 'utf8'), fixture);
  await request('/api/instances/installed-restored/start', { reviewId: review.reviewId, accepted: true }, 409);
  const freshReview = await request('/api/instances/installed-restored/review', {});
  await complete((await request('/api/instances/installed-restored/start', { reviewId: freshReview.reviewId, accepted: true }, 202)).operationId);
  const restoredRunning = (await request('/api/instances/installed-restored')).instance.status;
  assert.equal(restoredRunning.state, 'running'); assert.notEqual(restoredRunning.runId, instance.status.runId);
  await complete((await request('/api/instances/installed-restored/stop', {}, 202)).operationId);
  restoredStatus = (await request('/api/instances/installed-restored')).instance.status;
  assert.ok(restoredStatus.stoppedAt); assert.equal(restoredStatus.cleanupIncomplete, undefined);

  const sourceDirectory = exported.directory ?? exported.destination;
  const { authoring } = await request('/api/authoring/inspect', { directory: sourceDirectory });
  const pack = structuredClone(authoring.pack); pack.version = '1.1.0'; pack.components[0].settings = { label: 'Derived installed package' };
  const derivedDirectory = join(workspace, 'launcher-acceptance/derived');
  const derived = await complete((await request('/api/authoring/derive', { directory: sourceDirectory,
    destination: derivedDirectory, pack, expectedRevision: authoring.revision, redistributionAcknowledged: true }, 202)).operationId);
  assert.equal(derived.pack.version, '1.1.0'); assert.equal(derived.requiresNewExecutionReview, true);
  const publication = await complete((await request('/api/sources/publish', { directory: derivedDirectory,
    destination: join(workspace, 'launcher-acceptance/published'), kind: 'pack', redistributionAcknowledged: true }, 202)).operationId);
  const source = await request('/api/sources/inspect', { source: publication.indexPath });
  const fetched = await complete((await request('/api/sources/fetch', { source: publication.indexPath,
    indexDigest: source.digest, entryId: source.index.entries[0].entryId }, 202)).operationId);
  assert.equal(fetched.startsModules, false); assert.equal(fetched.requiresExecutionReview, true);
  const { comments } = await request('/api/authoring/read-comments', { directory: derivedDirectory });
  const comment = '<script>plain data only</script> Installed creator comment';
  const added = await complete((await request('/api/authoring/comments', { directory: derivedDirectory,
    author: 'Installed developer', text: comment, expectedRevision: comments.revision }, 202)).operationId);
  assert.equal(added.comments[0].text, comment);
  const proposal = await complete((await request('/api/authoring/proposal', { directory: sourceDirectory,
    destination: join(workspace, 'launcher-acceptance/proposal'), pack, expectedRevision: authoring.revision,
    redistributionAcknowledged: true }, 202)).operationId);
  const applied = await complete((await request('/api/authoring/apply-proposal', { directory: sourceDirectory,
    destination: join(workspace, 'launcher-acceptance/applied'), proposalDirectory: proposal.directory,
    redistributionAcknowledged: true }, 202)).operationId);
  assert.equal(applied.pack.version, '1.1.0');
  assert.equal((await request('/api/instances')).instances.length, 2, 'Creator and retrieval never import or start another instance');
} finally { await launcher.close(); }
console.log(JSON.stringify({ passed: true, version: pkg.version, authenticated: true, staticAssets: 5, explicitExecution: true,
  imported: true, started: true, observed: true, mapped: true, logs: true, stopped: Boolean(finalStatus.stoppedAt), exported: true,
  storage: true, privateBackup: true, restoredData: true, restoredFreshReview: true, restoredStopped: Boolean(restoredStatus.stoppedAt),
  derived: true, publishedLocally: true, verifiedSourceRetrieval: true, comments: true, proposal: true, creatorDoesNotRunCode: true }));
