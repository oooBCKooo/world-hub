import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { environment, workspace, samplePackage, json, save, requestJson, analyze, expectedText, until, pause } from './helpers.mjs';

const options = { timeout: 120000, concurrency: false };
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function copyingTo(path) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await exists(path)) return; await pause(2); }
  throw new Error(`No actual copy destination was created: ${path}`);
}
async function launcher(app) {
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' };
  const request = async (path, value, overrideHeaders) => {
    const response = await fetch(new URL(path, server.url), { method: value === undefined ? 'GET' : 'POST',
      headers: overrideHeaders ?? headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(45000), redirect: 'error' });
    return { status: response.status, body: await response.json() };
  };
  const call = async (path, body) => { const result = await request(path, body); assert.ok(result.status < 400, `${path}: ${JSON.stringify(result)}`); assert.equal(result.body.ok, true); return result.body; };
  const rejected = async (path, body, expectedCode, overrideHeaders) => {
    const result = await request(path, body, overrideHeaders); assert.ok(result.status >= 400, `${path}: ${JSON.stringify(result)}`);
    assert.equal(result.body.ok, false); if (expectedCode) assert.equal(result.body.error.code, expectedCode); return result;
  };
  const state = async id => { const instance = (await call(`/api/instances/${id}`)).instance; app.observe(instance.status); return instance; };
  const wait = async operationId => until(async () => {
    const { operation } = await call(`/api/operations/${operationId}`);
    return operation.state === 'running' ? false : operation;
  }, { timeoutMs: 60000, label: `operation ${operationId}` });
  const operate = async (path, body) => {
    const accepted = await call(path, body), operation = await wait(accepted.operationId);
    assert.equal(operation.state, 'succeeded', JSON.stringify(operation)); return operation;
  };
  const importPack = async (directory, instanceId = 'original') => {
    const review = await call('/api/review', { directory, ...environment });
    await call('/api/instances', { reviewId: review.reviewId, instanceId });
    return call(`/api/instances/${instanceId}/review`, environment);
  };
  const start = async (instanceId, reviewed) => {
    await operate(`/api/instances/${instanceId}/start`, { reviewId: reviewed.reviewId, accepted: true });
    return state(instanceId);
  };
  return { server, headers, request, call, rejected, state, wait, operate, importPack, start };
}
async function snapshot(app, api, instanceId = 'original') {
  const destination = join(app.directory, instanceId + '.whbackup');
  const operation = await api.operate(`/api/instances/${instanceId}/backup`, { destination, accepted: true });
  const checked = (await api.call('/api/backups/inspect', { backup: destination })).inspection;
  return { destination, checked, operation };
}

test('MAINTENANCE-HTTP-01 private backup and fresh-instance restore preserve real business results and require a new instance-bound execution review', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await samplePackage(app);
  const reviewed = await api.importPack(directory), first = await api.start('original', reviewed);
  const text = 'HTTP 私有恢复 🌍\nshared contract', result = (await analyze(first.links.entryUrl, text)).result;
  assert.deepEqual(result.output, expectedText(text));
  const priorState = await requestJson(first.links.entryUrl, '/state'), control = await json(join(first.directory, 'control.json'));
  const live = (await api.call('/api/instances/original/storage')).storage;
  assert.equal(live.consistency, 'live-or-unknown'); assert.ok(live.groups.programs.bytes > 0);
  const attempted = await api.call('/api/instances/original/backup', { destination: join(app.directory, 'while-running.whbackup'), accepted: true });
  const refused = await api.wait(attempted.operationId); assert.equal(refused.state, 'failed'); assert.equal(refused.error.code, 'INSTANCE_LOCKED');
  await api.operate('/api/instances/original/stop', {});
  const saved = await snapshot(app, api);
  assert.equal(saved.checked.compatible, true); assert.equal(saved.checked.mayIncludeApplicationSecrets, true);
  assert.equal(saved.checked.sha256, sha(await readFile(saved.destination)));
  await api.rejected('/api/backups/restore', { backup: saved.destination, sha256: saved.checked.sha256, instanceId: 'restored', accepted: false }, 'BACKUP_REVIEW_REQUIRED');
  const operation = await api.operate('/api/backups/restore', { backup: saved.destination, sha256: saved.checked.sha256, instanceId: 'restored', accepted: true, ...environment });
  const restored = operation.result.instance; assert.equal(restored.status.state, 'imported');
  assert.equal(await exists(join(restored.directory, 'runs')), false);
  await api.rejected('/api/instances/restored/start', { reviewId: reviewed.reviewId, accepted: true }, 'REVIEW_REQUIRED');
  assert.equal(await exists(join(restored.directory, 'runs')), false);
  const freshReview = await api.call('/api/instances/restored/review', environment), second = await api.start('restored', freshReview);
  assert.notEqual(second.status.runId, first.status.runId);
  assert.notEqual((await json(join(second.directory, 'control.json'))).token, control.token);
  assert.deepEqual((await requestJson(second.links.entryUrl, '/state')).results, priorState.results);
  assert.deepEqual((await analyze(second.links.entryUrl, 'new actual request')).result.output, expectedText('new actual request'));
  app.record('real-http-stopped-backup-and-restored-flow', { originalRunId: first.status.runId, restoredRunId: second.status.runId,
    backupSha256: saved.checked.sha256, originalOutput: result.output });
});

test('MAINTENANCE-HTTP-02 retained-data uninstall survives Launcher restart and only a fresh current review can reattach software', options, async t => {
  const app = await workspace(t), firstApi = await launcher(app), directory = await samplePackage(app);
  const originalReview = await firstApi.importPack(directory), first = await firstApi.start('original', originalReview);
  const result = (await analyze(first.links.entryUrl, 'persist across retained uninstall')).result;
  await firstApi.operate('/api/instances/original/stop', {});
  await firstApi.rejected('/api/instances/original/detach', { accepted: false }, 'TRUST_REQUIRED');
  await firstApi.operate('/api/instances/original/detach', { accepted: true });
  assert.equal((await firstApi.state('original')).status.state, 'detached');
  assert.equal((await firstApi.call('/api/instances/original/storage')).storage.detached, true);
  await firstApi.rejected('/api/instances/original/start', { reviewId: originalReview.reviewId, accepted: true }, 'INSTANCE_DETACHED');
  const saved = await snapshot(app, firstApi);
  await firstApi.server.close();
  const api = await launcher(app), instance = await api.state('original');
  assert.equal(instance.detached, true); assert.equal(instance.status.state, 'detached');
  const freshReview = await api.call('/api/instances/original/review', environment);
  assert.match(freshReview.review.directory, /detached-package$/);
  await api.rejected('/api/instances/original/reattach', { reviewId: freshReview.reviewId, accepted: false }, 'TRUST_REQUIRED');
  await api.operate('/api/instances/original/reattach', { reviewId: freshReview.reviewId, accepted: true });
  assert.equal((await api.state('original')).detached, false);
  await api.rejected('/api/instances/original/start', { reviewId: freshReview.reviewId, accepted: true });
  const startReview = await api.call('/api/instances/original/review', environment), restarted = await api.start('original', startReview);
  assert.equal((await requestJson(restarted.links.entryUrl, '/state')).results[0].output.sha256, result.output.sha256);
  app.record('detached-data-preserved-across-launcher-restart', { backupSha256: saved.checked.sha256, newRunId: restarted.status.runId });
});

test('MAINTENANCE-HTTP-03 every private maintenance mutation retains bearer, exact-Origin and CSRF boundaries', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await samplePackage(app);
  await api.importPack(directory); const saved = await snapshot(app, api), denied = [];
  for (const [path, body] of [
    ['/api/instances/original/backup', { destination: join(app.directory, 'cross-site.whbackup'), accepted: true }],
    ['/api/backups/inspect', { backup: saved.destination }],
    ['/api/backups/restore', { backup: saved.destination, sha256: saved.checked.sha256, instanceId: 'foreign', accepted: true }],
    ['/api/instances/original/detach', { accepted: true }],
    ['/api/instances/original/reattach', { reviewId: 'irrelevant', accepted: true }],
  ]) for (const headers of [
    { 'content-type': 'application/json' },
    { ...api.headers, 'x-csrf-token': 'wrong' },
    { ...api.headers, origin: 'http://foreign.invalid' },
    { ...api.headers, 'sec-fetch-site': 'same-site' },
  ]) {
    const result = await api.rejected(path, body, undefined, headers); denied.push({ path, status: result.status, code: result.body.error.code });
  }
  assert.equal((await api.state('original')).status.state, 'imported');
  assert.equal(await exists(join(app.directory, 'cross-site.whbackup')), false);
  assert.equal(await exists(join(app.root, 'instances/foreign')), false);
  assert.equal((await api.call('/api/instances')).instances.length, 1);
  await api.rejected('/api/backups/restore', { backup: saved.destination, sha256: saved.checked.sha256, instanceId: 'bad', accepted: true, runShell: 'x' });
  app.record('maintenance-protected-http-before-file-mutation', { denied });
});

test('MAINTENANCE-HTTP-04 restore refuses a changed review digest and an existing instance without overwriting its identity', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await samplePackage(app);
  await api.importPack(directory); const saved = await snapshot(app, api);
  await api.rejected('/api/backups/restore', { backup: saved.destination, sha256: '0'.repeat(64), instanceId: 'mismatch', accepted: true }, 'BACKUP_CHANGED');
  assert.equal(await exists(join(app.root, 'instances/mismatch')), false);
  const original = await api.state('original'), identity = await readFile(join(original.directory, 'instance.json'));
  const accepted = await api.call('/api/backups/restore', { backup: saved.destination, sha256: saved.checked.sha256, instanceId: 'original', accepted: true });
  const failed = await api.wait(accepted.operationId); assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'INSTANCE_EXISTS');
  assert.deepEqual(await readFile(join(original.directory, 'instance.json')), identity);
  app.record('restore-review-bound-to-file-and-new-instance', { code: failed.error.code });
});

test('MAINTENANCE-HTTP-05 copy cancellation and Launcher close wait for private partial-backup cleanup', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await samplePackage(app);
  await api.importPack(directory); const instance = await api.state('original'), state = join(instance.directory, 'programs/source');
  await mkdir(state, { recursive: true });
  const writer = await open(join(state, 'bulk.bin'), 'wx'), block = Buffer.alloc(1024 * 1024, 88);
  try { for (let n = 0; n < 64; n++) await writer.write(block); } finally { await writer.close(); }
  const destination = join(app.directory, 'cancelled.whbackup'), accepted = await api.call('/api/instances/original/backup', { destination, accepted: true });
  await copyingTo(destination);
  await api.call(`/api/operations/${accepted.operationId}/cancel`, {});
  const failed = await api.wait(accepted.operationId); assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'MAINTENANCE_ABORTED');
  assert.equal(await exists(destination), false); assert.equal(await exists(join(instance.directory, 'owner.lock')), false);
  const closingDestination = join(app.directory, 'closing.whbackup'), closing = await api.call('/api/instances/original/backup', { destination: closingDestination, accepted: true });
  await copyingTo(closingDestination);
  await api.server.close();
  assert.equal(await exists(closingDestination), false); assert.equal(await exists(join(instance.directory, 'owner.lock')), false);
  assert.equal(await exists(join(app.root, 'launcher-owner.lock')), false);
  assert.equal((await lstat(join(state, 'bulk.bin'))).size, 64 * 1024 * 1024);
  const persisted = await json(join(app.root, 'launcher-instances.json')); assert.equal(persisted.instances.length, 1);
  const operation = api.server.manager.operation(closing.operationId); assert.equal(operation.state, 'failed'); assert.equal(operation.error.code, 'MAINTENANCE_ABORTED');
  app.record('managed-copy-cancel-and-close-clean-owned-output', { operations: [accepted.operationId, closing.operationId] });
});

test('MAINTENANCE-HTTP-06 on-disk detached state reconciles a stale registry flag after Launcher restart', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await samplePackage(app);
  await api.importPack(directory); await api.operate('/api/instances/original/detach', { accepted: true }); await api.server.close();
  const file = join(app.root, 'launcher-instances.json'), registry = await json(file);
  registry.instances[0].detached = false; await save(file, registry);
  const reopened = await launcher(app), actual = await reopened.state('original');
  assert.equal(actual.detached, true, 'A failed old registry write must not hide actual retained-software state');
  assert.equal(actual.status.state, 'detached');
  const review = await reopened.call('/api/instances/original/review', environment);
  await reopened.operate('/api/instances/original/reattach', { reviewId: review.reviewId, accepted: true });
  await reopened.server.close();
  const stale = await json(file); stale.instances[0].detached = true; await save(file, stale);
  const final = await launcher(app), attached = await final.state('original');
  assert.equal(attached.detached, false); assert.equal(attached.status.state, 'imported');
  app.record('filesystem-state-reconciles-stale-registry-in-both-directions');
});

test('MAINTENANCE-HTTP-07 missing control files for an existing external supervisor never become a successful imported-state stop', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await samplePackage(app);
  const review = await api.importPack(directory);
  const external = await startInstance({ root: app.root, instanceId: 'original', trust: review.review.digest, ...environment });
  app.cleanups.push(() => external.close()); app.observe(await external.status());
  const stateDir = external.ready.stateDir;
  await unlink(join(stateDir, 'control.json'));
  const accepted = await api.call('/api/instances/original/stop', {}), failed = await api.wait(accepted.operationId);
  assert.equal(failed.state, 'failed', 'A missing control record is not proof of no run or confirmed process exit');
  const observed = await api.state('original'); assert.equal(Boolean(observed.status.stoppedAt), false);
  assert.equal(await exists(join(stateDir, 'owner.lock')), true);
  assert.deepEqual((await analyze(external.ready.entryUrl, 'external supervisor remains active')).result.output, expectedText('external supervisor remains active'));
  await external.close();
  await api.operate('/api/instances/original/stop', {});
  app.record('missing-control-is-unconfirmed-until-exact-owner-stops', { stoppedAt: (await api.state('original')).status.stoppedAt });
});
