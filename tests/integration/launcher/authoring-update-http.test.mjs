import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { createLock, inspectPackage } from '../../../scripts/runtime/package.mjs';
import { fixturePackage, workspace, environment, until, json, save } from './helpers.mjs';

const options = { timeout: 120000, concurrency: false };
const exists = async file => {
  try { await lstat(file); return true; }
  catch (issue) { if (issue.code === 'ENOENT') return false; throw issue; }
};
async function apiFor(app) {
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close());
  async function call(path, body, expectedStatus = 200) {
    const response = await fetch(new URL(path, server.url), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${server.token}`, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(result));
    return result;
  }
  const operation = result => until(async () => {
    const row = (await call(`/api/operations/${result.operationId}`)).operation;
    return ['running', 'queued'].includes(row.state) ? false : row;
  }, { timeoutMs: 60000, label: `authoring operation ${result.operationId}` });
  async function success(path, body) {
    const row = await operation(await call(path, body, 202));
    assert.equal(row.state, 'succeeded', JSON.stringify(row)); return row.result;
  }
  async function failed(path, body, code) {
    const row = await operation(await call(path, body, 202));
    assert.equal(row.state, 'failed', JSON.stringify(row)); if (code) assert.equal(row.error.code, code); return row;
  }
  async function importPack(directory, instanceId) {
    const review = await call('/api/review', { directory, ...environment });
    await call('/api/instances', { reviewId: review.reviewId, instanceId });
    return (await call(`/api/instances/${instanceId}`)).instance;
  }
  async function start(instanceId) {
    const review = await call(`/api/instances/${instanceId}/review`, environment);
    const running = await success(`/api/instances/${instanceId}/start`, { reviewId: review.reviewId, accepted: true });
    app.trackSession(server.manager.sessions.get(instanceId)); return { review, running };
  }
  return { server, call, operation, success, failed, importPack, start };
}
async function sourceFixture(app) {
  const directory = await fixturePackage(app), pack = await json(join(directory, 'pack.json'));
  pack.version = '0.1.0'; await save(join(directory, 'pack.json'), pack); await createLock(directory, environment);
  return directory;
}
async function updateInput(api, directory) {
  const { authoring } = await api.call('/api/authoring/inspect', { directory, ...environment });
  const pack = structuredClone(authoring.pack); pack.version = '0.2.0'; pack.title = 'Updated through Workbench';
  return { directory, expectedRevision: authoring.revision, pack, redistributionAcknowledged: true, ...environment };
}

test('AUTHORING-UPDATE-HTTP-01 update replaces a standalone source at a higher version and retains its previous locked tree without execution', options, async t => {
  const app = await workspace(t), api = await apiFor(app), directory = await sourceFixture(app);
  const body = await updateInput(api, directory), oldPack = await readFile(join(directory, 'pack.json')), oldLock = await readFile(join(directory, 'pack.lock'));
  const { expectedRevision, ...withoutRevision } = body;
  const missing = await api.call('/api/authoring/update', withoutRevision, 400); assert.equal(missing.error.code, 'INVALID_INPUT');
  const withoutPack = { ...body }; delete withoutPack.pack;
  assert.equal((await api.call('/api/authoring/update', withoutPack, 400)).error.code, 'INVALID_INPUT');
  await api.failed('/api/authoring/update', { ...body, expectedRevision: '0'.repeat(64) }, 'SOURCE_UPDATE_REVISION_CHANGED');
  const result = await api.success('/api/authoring/update', body);
  assert.equal(result.directory, directory); assert.equal(result.version, '0.2.0'); assert.equal(result.startsModules, false);
  assert.equal(result.updatedOriginal, true); assert.ok(result.previousDirectory);
  assert.equal((await inspectPackage(directory, environment)).pack.version, '0.2.0');
  assert.deepEqual(await readFile(join(result.previousDirectory, 'pack.json')), oldPack);
  assert.deepEqual(await readFile(join(result.previousDirectory, 'pack.lock')), oldLock);
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  assert.deepEqual((await api.call('/api/programs')).programs, []);
  assert.equal(api.server.manager.sessions.size, 0); assert.equal(api.server.manager.hub, null);
  assert.equal(await exists(join(directory, 'runs')), false);
  app.record('source-save-keeps-target-and-retains-old-lock', { version: result.version, previousDirectory: result.previousDirectory, startsModules: result.startsModules });
});

test('AUTHORING-UPDATE-HTTP-02 managed deployment source cannot be overwritten and update candidates require the exact selected instance', options, async t => {
  const app = await workspace(t), api = await apiFor(app), directory = await sourceFixture(app);
  const original = await api.importPack(directory, 'original'), other = await api.importPack(directory, 'other');
  const body = await updateInput(api, original.packageDirectory), identity = await readFile(join(original.directory, 'instance.json'));
  const oldPack = await readFile(join(original.packageDirectory, 'pack.json')), oldLock = await readFile(join(original.packageDirectory, 'pack.lock'));
  await api.failed('/api/authoring/update', body, 'SOURCE_UPDATE_RUNTIME_DIRECTORY');
  await api.failed('/api/authoring/update-candidate', { ...body, instanceId: 'other' }, 'SOURCE_UPDATE_INSTANCE_CHANGED');
  const missing = { ...body, instanceId: 'original' }; delete missing.expectedRevision;
  assert.equal((await api.call('/api/authoring/update-candidate', missing, 400)).error.code, 'INVALID_INPUT');
  const withoutPack = { ...body, instanceId: 'original' }; delete withoutPack.pack;
  assert.equal((await api.call('/api/authoring/update-candidate', withoutPack, 400)).error.code, 'INVALID_INPUT');
  const cache = join(app.root, 'source-cache', 'immutable-artifact'); await cp(directory, cache, { recursive: true });
  const cachedInput = await updateInput(api, cache), cachedPack = await readFile(join(cache, 'pack.json')), cachedLock = await readFile(join(cache, 'pack.lock'));
  await api.failed('/api/authoring/update', cachedInput, 'SOURCE_UPDATE_MANAGED_DIRECTORY');
  assert.deepEqual(await readFile(join(cache, 'pack.json')), cachedPack); assert.deepEqual(await readFile(join(cache, 'pack.lock')), cachedLock);
  const candidate = await api.success('/api/authoring/update-candidate', { ...body, instanceId: 'original' });
  assert.equal(candidate.pack.version, '0.2.0'); assert.equal(candidate.targetInstanceId, 'original');
  assert.equal(candidate.requiresUpgradeReview, true); assert.equal(candidate.startsModules, false);
  assert.notEqual(candidate.directory, original.packageDirectory); assert.notEqual(candidate.directory, other.packageDirectory);
  assert.equal((await inspectPackage(candidate.directory, environment)).pack.version, '0.2.0');
  assert.deepEqual(await readFile(join(original.directory, 'instance.json')), identity);
  assert.deepEqual(await readFile(join(original.packageDirectory, 'pack.json')), oldPack);
  assert.deepEqual(await readFile(join(original.packageDirectory, 'pack.lock')), oldLock);
  assert.equal((await api.call('/api/instances/original')).instance.pack.version, '0.1.0');
  assert.equal(await exists(join(original.directory, 'runs')), false); assert.equal(api.server.manager.sessions.size, 0);
  app.record('managed-source-protection-and-separate-reviewed-candidate', { targetInstanceId: candidate.targetInstanceId, candidateVersion: candidate.pack.version, originalVersion: original.pack.version });
});

test('AUTHORING-UPDATE-HTTP-03 candidate follows the existing reviewed upgrade and restarts the same instance with provider-preserved data', options, async t => {
  const app = await workspace(t), api = await apiFor(app), directory = await sourceFixture(app);
  const original = await api.importPack(directory, 'original'), first = await api.start('original');
  const response = await fetch(first.running.links.entryUrl, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).connected, [true]);
  const dataPath = join(original.directory, 'programs', 'fixture', 'user-document.json');
  await writeFile(dataPath, JSON.stringify({ text: 'Provider-owned data survives a Workbench update 🌍', completed: 3 }) + '\n');
  const data = await readFile(dataPath), input = await updateInput(api, original.packageDirectory);
  const candidate = await api.success('/api/authoring/update-candidate', { ...input, instanceId: 'original' });
  assert.equal((await api.call('/api/instances/original')).instance.status.runId, first.running.status.runId);
  const policies = [{ componentId: 'fixture', mode: 'preserve', dataFormat: 'fixture.documents/v1' }];
  await api.call('/api/instances/original/upgrade-plan', { candidate: candidate.directory, statePolicies: policies }, 409);
  await api.success('/api/instances/original/stop', {});
  const preview = await api.call('/api/instances/original/upgrade-plan', { candidate: candidate.directory, statePolicies: policies });
  await api.call('/api/instances/original/upgrade', { previewId: preview.previewId, accepted: false }, 409);
  const upgraded = await api.success('/api/instances/original/upgrade', { previewId: preview.previewId, accepted: true });
  assert.equal(upgraded.instance.instanceId, 'original'); assert.equal(upgraded.instance.directory, original.directory);
  assert.equal(upgraded.instance.pack.version, '0.2.0'); assert.equal(upgraded.requiresNewExecutionReview, true);
  assert.deepEqual(await readFile(dataPath), data);
  assert.equal((await api.call('/api/instances')).instances.length, 1);
  await api.call('/api/instances/original/start', { reviewId: first.review.reviewId, accepted: true }, 409);
  const restarted = await api.start('original');
  assert.notEqual(restarted.running.status.runId, first.running.status.runId);
  assert.equal(restarted.running.instanceId, 'original');
  assert.deepEqual(await readFile(dataPath), data);
  const live = await fetch(restarted.running.links.entryUrl, { signal: AbortSignal.timeout(3000) });
  assert.equal(live.status, 200); assert.deepEqual((await live.json()).connected, [true]);
  await api.success('/api/instances/original/stop', {});
  app.record('candidate-upgrades-same-instance-with-new-execution-review', { instanceId: 'original', version: upgraded.instance.pack.version, transactionId: upgraded.transactionId, statePreserved: true });
});

test('AUTHORING-UPDATE-HTTP-04 a prerelease can become its same-core stable candidate and recovery diagnostics survive the operation channel', options, async t => {
  const app = await workspace(t), api = await apiFor(app), directory = await sourceFixture(app);
  const pack = await json(join(directory, 'pack.json')); pack.version = '0.1.0-beta';
  await save(join(directory, 'pack.json'), pack); await createLock(directory, environment);
  const original = await api.importPack(directory, 'prerelease'), body = await updateInput(api, original.packageDirectory);
  body.instanceId = 'prerelease'; body.pack.version = '0.1.0';
  await api.failed('/api/authoring/update-candidate', { ...body, pack: { ...body.pack, version: '0.1.0-alpha' } }, 'SOURCE_UPDATE_VERSION_REQUIRED');
  const candidate = await api.success('/api/authoring/update-candidate', body);
  assert.equal(candidate.pack.version, '0.1.0'); assert.equal(candidate.targetInstanceId, 'prerelease');
  assert.equal((await api.call('/api/instances/prerelease')).instance.pack.version, '0.1.0-beta');
  assert.equal((await inspectPackage(candidate.directory, environment)).pack.version, '0.1.0');
  // Exercise the real operation serializer with a failed transaction receipt;
  // this checks recovery guidance transport, not a simulated filesystem swap.
  const recovery = { sourceDirectory: directory, previousDirectory: join(app.directory, 'previous-source'),
    incompleteDestination: candidate.directory, rollbackError: { code: 'SOURCE_UPDATE_PATH_OCCUPIED', message: 'Source path changed; inspect the retained previous tree.' } };
  const receipt = api.server.manager.launch('update', '$recovery-diagnostics', async () => {
    throw Object.assign(new Error('Retain the source update recovery directories.'), { code: 'SOURCE_UPDATE_RECOVERY_REQUIRED', ...recovery });
  });
  const failed = await api.operation(receipt);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.sourceDirectory, recovery.sourceDirectory);
  assert.equal(failed.error.previousDirectory, recovery.previousDirectory); assert.equal(failed.error.incompleteDestination, recovery.incompleteDestination);
  assert.deepEqual(failed.error.rollbackError, recovery.rollbackError);
  app.record('same-core-stable-candidate-and-transported-recovery-guidance', { originalVersion: original.pack.version, candidateVersion: candidate.pack.version, recoveryFieldsRetained: true });
});
