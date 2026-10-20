import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { inspectAuthoring } from '../../../scripts/runtime/authoring.mjs';
import { createLock, inspectPackage } from '../../../scripts/runtime/package.mjs';
import { inspectBackup } from '../../../scripts/runtime/maintenance.mjs';
import { workspace, fixturePackage, environment, until } from './helpers.mjs';

function api(server) { return async (path, body, expected = 200) => {
  const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(90000),
    headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}; }
async function operation(call, started, expected = 'succeeded') {
  const row = await until(async () => { const value = (await call('/api/operations/' + started.operationId)).operation; return value.state !== 'running' && value; }, { timeoutMs: 65000 });
  assert.equal(row.state, expected, JSON.stringify(row)); return expected === 'succeeded' ? row.result : row;
}
async function setup(t, { two = false } = {}) {
  const app = await workspace(t), directory = await fixturePackage(app);
  if (two) {
    const pack = JSON.parse(await readFile(join(directory, 'pack.json'), 'utf8'));
    pack.components.push({ ...structuredClone(pack.components[0]), id: 'removed', autostart: false });
    await writeFile(join(directory, 'pack.json'), JSON.stringify(pack)); await createLock(directory, environment);
  }
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment }); app.cleanups.push(() => server.close());
  const call = api(server), review = await call('/api/review', { directory });
  await call('/api/instances', { reviewId: review.reviewId, instanceId: 'custom' });
  return { app, server, call, directory, state: join(app.root, 'instances/custom'), base: '/api/instances/custom/customization' };
}
async function preview(call, base, state, transform) {
  const source = await inspectAuthoring(join(state, 'package'), environment), pack = structuredClone(source.pack);
  transform(pack);
  return call(base + '/preview', { directory: source.directory, expectedRevision: source.revision, pack, redistributionAcknowledged: true });
}
async function start(call, app, server) {
  const review = await call('/api/instances/custom/review', {});
  const result = await operation(call, await call('/api/instances/custom/start', { reviewId: review.reviewId, accepted: true }, 202));
  app.trackSession(server.manager.sessions.get('custom')); return result;
}

test('Workbench direct customization snapshots topology, opaque state and versions; baseline restore snapshots latest data and requires fresh execution review', { timeout: 90000 }, async t => {
  const { app, server, call, state, base } = await setup(t, { two: true });
  const payload = Buffer.from([0, 255, 11, 0, 206, 227]);
  for (const id of ['fixture', 'removed']) { await mkdir(join(state, 'programs', id), { recursive: true }); await writeFile(join(state, 'programs', id, 'opaque.bin'), payload); }
  const oldReview = await call('/api/instances/custom/review', {});
  const first = await preview(call, base, state, pack => {
    pack.version = '1.0.1'; pack.components = pack.components.filter(row => row.id !== 'removed');
    pack.components[0].settings.label = 'user customization';
    pack.components.push({ ...structuredClone(pack.components[0]), id: 'new-one', autostart: false, after: ['fixture'] });
  });
  assert.equal(first.preview.startsModules, false); assert.equal(first.preview.runsMigrations, false);
  assert.deepEqual(first.preview.statePolicies.map(row => [row.componentId, row.mode]), [['fixture', 'preserve-opaque'], ['new-one', 'fresh'], ['removed', 'archive-removed']]);
  assert.equal((await call('/api/instances/custom/upgrade-plan', { candidate: first.preview.candidate.directory,
    statePolicies: ['fixture','removed'].map(componentId => ({ componentId, mode: 'preserve', dataFormat: 'provider-state/v1' })) }, 409)).error.code, 'UPGRADE_COMPONENTS_CHANGED');
  assert.equal((await call(base + '/apply', { previewId: first.previewId, accepted: false }, 409)).error.code, 'TRUST_REQUIRED');
  const applied = await operation(call, await call(base + '/apply', { previewId: first.previewId, accepted: true }, 202));
  assert.equal(applied.instance.instanceId, 'custom'); assert.equal(applied.pack.version, '1.0.1');
  assert.equal(applied.pack.lineage.base.version, '1.0.0'); assert.equal(applied.pack.lineage.revision, 1);
  assert.deepEqual(await readFile(join(state, 'programs/fixture/opaque.bin')), payload);
  assert.deepEqual((await readdir(join(state, 'programs'))).sort(), ['fixture', 'new-one']);
  assert.deepEqual(await readdir(join(state, 'programs/new-one')), []);
  assert.deepEqual(await readFile(join(state, 'upgrades', applied.transactionId, 'removed-programs/removed/opaque.bin')), payload);
  assert.equal(server.manager.sessions.size, 0);
  assert.equal((await call('/api/instances/custom/start', { reviewId: oldReview.reviewId, accepted: true }, 409)).error.code, 'REVIEW_REQUIRED');
  const second = await preview(call, base, state, pack => { pack.version = '1.0.2'; pack.components[0].after = []; pack.components[0].settings.label = 'second change'; });
  const again = await operation(call, await call(base + '/apply', { previewId: second.previewId, accepted: true }, 202));
  assert.equal(again.pack.lineage.base.version, '1.0.0'); assert.equal(again.pack.lineage.revision, 2);
  const history = await call(base + '/history');
  assert.equal(history.history.transactions.filter(row => row.restorable).length, 2);
  assert.equal(history.baseline.transactionId, applied.transactionId); assert.equal(history.baseline.pack.version, '1.0.0');
  await writeFile(join(state, 'programs/fixture/opaque.bin'), 'latest data');
  const restore = await call(base + '/restore-preview', { transactionId: history.baseline.transactionId });
  assert.equal(restore.preview.discardsCurrentData, true);
  assert.equal((await call(base + '/restore', { previewId: restore.previewId, accepted: false }, 409)).error.code, 'TRUST_REQUIRED');
  const restored = await operation(call, await call(base + '/restore', { previewId: restore.previewId, accepted: true }, 202));
  assert.equal(restored.pack.version, '1.0.0'); assert.equal(restored.pack.lineage, undefined);
  assert.deepEqual(await readFile(join(state, 'programs/fixture/opaque.bin')), payload);
  assert.deepEqual(await readFile(join(state, 'programs/removed/opaque.bin')), payload);
  const latest = await inspectBackup(join(state, 'upgrades', restored.restoreTransactionId, 'snapshot.whbackup'));
  assert.equal(latest.pack.version, '1.0.2'); assert.equal(latest.compatible, true);
  await start(call, app, server); await operation(call, await call('/api/instances/custom/stop', {}, 202));
  const recustom = await preview(call, base, state, pack => { pack.version = '1.0.3'; pack.components[0].settings.label = 'customize after baseline restore'; });
  const reapplied = await operation(call, await call(base + '/apply', { previewId: recustom.previewId, accepted: true }, 202));
  assert.equal((await call(base + '/history')).baseline.transactionId, reapplied.transactionId);
  app.record('direct-customization-baseline-and-execution', { versions: ['1.0.0', '1.0.1', '1.0.2', '1.0.0'], restoredTransactionId: restored.transactionId, latestDataRetained: true, noAutomaticExecution: true });
});

test('direct customization rejects wrong source, stale source, unchanged versions, running instances and drift after review', { timeout: 90000 }, async t => {
  const { app, server, call, state, base, directory } = await setup(t);
  const source = await inspectAuthoring(join(state, 'package'), environment);
  const body = { directory: source.directory, expectedRevision: source.revision, pack: { ...source.pack, version: '1.0.1' }, redistributionAcknowledged: true };
  const packBytes = await readFile(join(state, 'package/pack.json'));
  assert.equal((await call('/api/instances/custom/startup-plan', { packType: 'mesh' }, 404)).error.code, 'NOT_FOUND');
  assert.deepEqual(await readFile(join(state, 'package/pack.json')), packBytes);
  assert.equal((await call(base + '/preview', { ...body, directory }, 409)).error.code, 'SOURCE_UPDATE_INSTANCE_CHANGED');
  assert.equal((await call(base + '/preview', { ...body, expectedRevision: '0'.repeat(64) }, 409)).error.code, 'SOURCE_UPDATE_REVISION_CHANGED');
  assert.equal((await call(base + '/preview', { ...body, pack: source.pack }, 409)).error.code, 'SOURCE_UPDATE_VERSION_REQUIRED');
  await mkdir(join(state, 'programs/unexplained'), { recursive: true });
  assert.equal((await call(base + '/preview', body, 409)).error.code, 'UPGRADE_STATE_UNKNOWN');
  await rename(join(state, 'programs/unexplained'), join(app.directory, 'retained-unexplained-state'));
  await start(call, app, server);
  assert.equal((await call('/api/instances/custom/startup-plan', { packType: 'mesh' }, 404)).error.code, 'NOT_FOUND');
  assert.deepEqual(await readFile(join(state, 'package/pack.json')), packBytes);
  assert.equal((await call(base + '/preview', body, 409)).error.code, 'INSTANCE_LOCKED');
  await operation(call, await call('/api/instances/custom/stop', {}, 202));
  let review = await call(base + '/preview', body);
  await writeFile(join(state, 'programs/fixture/drift.bin'), 'new data after review');
  let failed = await operation(call, await call(base + '/apply', { previewId: review.previewId, accepted: true }, 202), 'failed');
  assert.equal(failed.error.code, 'UPGRADE_TRUST_REQUIRED');
  assert.equal((await inspectPackage(join(state, 'package'), environment)).pack.version, '1.0.0');
  review = await call(base + '/preview', body);
  const candidate = join(review.preview.candidate.directory, 'modules/test.fixture/program.mjs');
  await writeFile(candidate, (await readFile(candidate, 'utf8')) + '\n// changed after review\n');
  failed = await operation(call, await call(base + '/apply', { previewId: review.previewId, accepted: true }, 202), 'failed');
  assert.equal(failed.state, 'failed');
  review = await call(base + '/preview', body);
  await writeFile(join(state, 'package/modules/fixture/program.mjs'), '// unreviewed installed source');
  failed = await operation(call, await call(base + '/apply', { previewId: review.previewId, accepted: true }, 202), 'failed');
  assert.equal(failed.state, 'failed');
  app.record('customization-safety-rejections', { running: true, source: true, data: true, candidate: true });
});

test('missing or changed retained snapshot disables the real baseline restore action', { timeout: 45000 }, async t => {
  const { app, call, state, base } = await setup(t);
  const review = await preview(call, base, state, pack => { pack.version = '1.0.1'; });
  const result = await operation(call, await call(base + '/apply', { previewId: review.previewId, accepted: true }, 202));
  assert.equal((await call(base + '/history')).baseline.restorable, true);
  const snapshot = join(state, 'upgrades', result.transactionId, 'snapshot.whbackup');
  await rename(snapshot, snapshot + '.retained');
  const unavailable = await call(base + '/history');
  assert.equal(unavailable.baseline, null); assert.equal(unavailable.history.transactions[0].restorable, false);
  await call(base + '/restore-preview', { transactionId: result.transactionId }, 409);
  app.record('baseline-checks-real-snapshot', { missingSnapshotDisabled: true });
});

test('runtime snapshot direct save preserves newly attached module state and restores the original source with all old opaque state', { timeout: 90000 }, async t => {
  const { app, server, call, state, directory, base } = await setup(t);
  await start(call, app, server);
  const assembly = '/api/instances/custom/assembly';
  const act = async input => {
    const snapshot = await call(assembly), review = await call(assembly + '/preview', { ...input, expectedRevision: snapshot.assembly.revision });
    return operation(call, await call(assembly + '/apply', { reviewId: review.reviewId, accepted: true }, 202));
  };
  await act({ action: 'add', componentId: 'attached', directory: join(directory, 'modules/fixture'), settings: { mode: 'normal' },
    topics: { input: 'acceptance/input', output: 'acceptance/output' }, bridges: { main: { publish: ['input', 'output'], subscribe: ['input', 'output'] } } });
  await act({ action: 'start', componentId: 'attached' }); app.trackSession(server.manager.sessions.get('custom'));
  await writeFile(join(state, 'programs/attached/opaque.bin'), Buffer.from([0, 7, 254]));
  const snapshot = await call(assembly + '/snapshot', {}), authoring = await inspectAuthoring(snapshot.directory, environment);
  await operation(call, await call('/api/instances/custom/stop', {}, 202));
  const body = { directory: snapshot.directory, expectedRevision: authoring.revision, pack: { ...snapshot.pack, version: '1.0.1' }, origin: snapshot.origin, redistributionAcknowledged: true };
  assert.equal((await call(assembly + '/save-preview', { ...body, origin: { ...body.origin, revision: body.origin.revision + 1 } }, 409)).error.code, 'ASSEMBLY_SAVE_STALE');
  const review = await call(assembly + '/save-preview', body);
  assert.equal(review.preview.statePolicies.find(row => row.componentId === 'attached').mode, 'preserve-opaque');
  const result = await operation(call, await call(assembly + '/save-apply', { previewId: review.previewId, accepted: true }, 202));
  assert.deepEqual(await readFile(join(state, 'programs/attached/opaque.bin')), Buffer.from([0, 7, 254]));
  assert.equal(result.pack.lineage.base.version, '1.0.0');
  const originalSnapshot = await inspectBackup(join(state, 'upgrades', result.transactionId, 'snapshot.whbackup'));
  assert.ok(originalSnapshot.backup.programStateRoots.includes('attached'));
  const restore = await call(base + '/restore-preview', { transactionId: result.transactionId });
  const restored = await operation(call, await call(base + '/restore', { previewId: restore.previewId, accepted: true }, 202));
  assert.equal(restored.pack.version, '1.0.0'); assert.equal(restored.pack.components.length, 1);
  assert.deepEqual(await readFile(join(state, 'programs/attached/opaque.bin')), Buffer.from([0, 7, 254]));
  await start(call, app, server); await operation(call, await call('/api/instances/custom/stop', {}, 202));
  const next = await preview(call, base, state, pack => { pack.version = '1.0.2'; pack.components[0].settings.label = 'after baseline recovery'; });
  assert.equal(next.preview.statePolicies.find(row => row.componentId === 'attached').mode, 'archive-removed');
  const savedAgain = await operation(call, await call(base + '/apply', { previewId: next.previewId, accepted: true }, 202));
  assert.deepEqual(await readFile(join(state, 'upgrades', savedAgain.transactionId, 'removed-programs/attached/opaque.bin')), Buffer.from([0, 7, 254]));
  assert.deepEqual(await readdir(join(state, 'programs')), ['fixture']);
  app.record('runtime-customization-opaque-snapshot', { attachedStateRetained: true, rollbackAllOldRoots: true, originalRestarts: true });
});
