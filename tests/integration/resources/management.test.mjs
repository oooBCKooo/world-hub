import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, okay, refused, moduleSource, importModule, stateFile } from '../../helpers/module-versions-scene.mjs';
import { collectSourceFiles } from '../../../scripts/runtime/source-guidance.mjs';
import { sourceFilesDigest } from '../../../scripts/runtime/resource-artifacts.mjs';

const api = '/manage/api/resources';
const capture = async (s, id, ids, scope = 'local') => okay(await s.call(api + '/profiles/capture', { id, title: id, version: '1.0.0', scope, programIds: ids }));

test('capture exports references only; applying an unchanged global profile preserves a real running bridge and row', async t => {
  const s = await setup(t), source = await moduleSource(s, 'one', '1.0.0'); await importModule(s, source, 'one');
  const captured = await capture(s, 'global.one', ['one'], 'global');
  const artifact = JSON.parse(await readFile(captured.artifactPath));
  assert.equal(artifact.kind, 'configuration'); assert.deepEqual(artifact.files.map(file => file.path), ['configuration.json']);
  assert.equal(captured.profile.manifest.modules[0].module.digest, sourceFilesDigest(await collectSourceFiles(source.directory)));
  okay(await s.call('/manage/api/programs/one/start', {}));
  const row = s.owner.localPrograms.row('one'), handle = s.owner.localPrograms.handles.get('one'), principal = row.principal;
  assert.ok(s.hub.snapshot().bridges.some(bridge => bridge.principal === principal));
  const preview = okay(await s.call(api + '/profiles/preview', { profileId: captured.profile.profileId }));
  assert.deepEqual(preview.review.changes, []); assert.deepEqual(preview.review.requiresStop, []);
  okay(await s.call(api + '/profiles/apply', { reviewId: preview.reviewId, accepted: true }));
  assert.equal(s.owner.localPrograms.row('one'), row); assert.equal(s.owner.localPrograms.handles.get('one'), handle);
  assert.ok(s.hub.snapshot().bridges.some(bridge => bridge.principal === principal)); assert.equal(handle.exit, null);
  const state = okay(await s.call(api)); assert.equal(state.profiles[0].active, true); assert.equal(state.bodies.length, 1);
});

test('an imported configuration resolves separately cached bodies, creates peer instances and survives a registry restart', async t => {
  const s = await setup(t), source = await moduleSource(s, 'new', '1.0.0');
  const ref = { id: 'versions.new', version: '1.0.0', digest: sourceFilesDigest(await collectSourceFiles(source.directory)) };
  const folder = join(s.root, 'configuration'); await mkdir(folder);
  await writeFile(join(folder, 'configuration.json'), JSON.stringify({ format: 'world-hub.configuration/v1', id: 'new.profile', version: '1.0.0', title: 'New', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], provides: [], requires: [], scope: 'local',
    modules: [{ id: 'role', module: ref, configuration: { topics: { events: 'resource/new/events' }, bridges: { main: { publish: ['events'], subscribe: ['events'] } }, settings: { label: 'new' }, bindings: [] } }],
    startupPlan: { members: [{ programId: 'role', enabled: false, after: [] }], onFailure: 'continue-independent', startupOrder: ['role'] } }));
  const imported = okay(await s.call(api + '/profiles/import', { path: folder }));
  const missing = okay(await s.call(api + '/profiles/preview', { profileId: imported.profile.profileId }));
  assert.equal(missing.review.blocked, true); assert.equal(missing.review.missingModules.length, 1);
  refused(await s.call(api + '/profiles/apply', { reviewId: missing.reviewId, accepted: true }));
  okay(await s.call(api + '/bodies/import', { path: source.directory }));
  okay(await s.call(api + '/bodies/import', { path: source.directory }));
  const ready = okay(await s.call(api + '/profiles/preview', { profileId: imported.profile.profileId }));
  assert.equal(ready.review.blocked, false);
  const result = okay(await s.call(api + '/profiles/apply', { reviewId: ready.reviewId, accepted: true }));
  const instance = result.mapping.role; assert.equal(s.owner.localPrograms.row(instance).state, 'stopped');
  await stateFile(s, instance, 'durable-private-data');
  await s.reload();
  const state = okay(await s.call(api)); assert.equal(state.bodies.length, 1); assert.equal(state.profiles[0].active, true);
  assert.equal(await readFile(await stateFile(s, instance), 'utf8'), 'durable-private-data');
});

test('retention cleanup respects selected overlapping configurations, dependency closure and preserves removed instance data', async t => {
  const s = await setup(t);
  for (const name of ['a', 'b', 'c', 'd']) await importModule(s, await moduleSource(s, name, '1.0.0'), name);
  const a = await capture(s, 'profile.a', ['a', 'b', 'c']), b = await capture(s, 'profile.b', ['b', 'c', 'd']);
  const originalIdentity = structuredClone(s.owner.localPrograms.identities.get('d'));
  await stateFile(s, 'd', 'keep me');
  const both = okay(await s.call(api + '/cleanup/preview', { keepProfileIds: [a.profile.profileId, b.profile.profileId], removeUnreferencedBodies: true }));
  assert.deepEqual(both.review.removable, []); assert.deepEqual(both.review.removableBodies, []);
  const one = okay(await s.call(api + '/cleanup/preview', { keepProfileIds: [a.profile.profileId], removeUnreferencedBodies: true }));
  assert.deepEqual(one.review.removable.map(row => row.programId), ['d']);
  const result = okay(await s.call(api + '/cleanup/apply', { reviewId: one.reviewId, accepted: true }));
  assert.deepEqual(result.removedProgramIds, ['d']); assert.equal(result.preservesData, true);
  assert.equal(await readFile(await stateFile(s, 'd'), 'utf8'), 'keep me');
  const state = okay(await s.call(api)); assert.equal(state.profiles.length, 2);
  assert.equal(state.profiles.find(p => p.profileId === b.profile.profileId).missingModules.length, 1);
  assert.equal(state.bodies.length, 3);
  okay(await s.call(api + '/bodies/import', { path: (await moduleSource(s, 'd', '1.0.0')).directory }));
  const back = okay(await s.call(api + '/profiles/preview', { profileId: b.profile.profileId }));
  assert.equal(back.review.blocked, false); assert.deepEqual(back.review.restores.map(row => row.programId), ['d']);
  assert.equal(JSON.stringify(back).includes(originalIdentity.token), false);
  okay(await s.call(api + '/profiles/apply', { reviewId: back.reviewId, accepted: true }));
  assert.deepEqual(s.owner.localPrograms.identities.get('d'), originalIdentity);
  assert.equal(await readFile(await stateFile(s, 'd'), 'utf8'), 'keep me');
  assert.equal(s.owner.localPrograms.row('d').state, 'stopped');
  okay(await s.call(api + '/profiles/deactivate', { profileIds: [b.profile.profileId], accepted: true }));
  const nextCleanup = okay(await s.call(api + '/cleanup/preview', { keepProfileIds: [a.profile.profileId] }));
  okay(await s.call(api + '/cleanup/apply', { reviewId: nextCleanup.reviewId, accepted: true }));
  const returnReview = okay(await s.call(api + '/profiles/preview', { profileId: b.profile.profileId }));
  const identityPath = s.owner.localPrograms.path('d', 'identity.json');
  const altered = { ...originalIdentity, token: 'x'.repeat(43) }; await writeFile(identityPath, JSON.stringify(altered));
  refused(await s.call(api + '/profiles/apply', { reviewId: returnReview.reviewId, accepted: true }));
  assert.equal(s.owner.localPrograms.records.has('d'), false); assert.equal(await readFile(await stateFile(s, 'd'), 'utf8'), 'keep me');
});

test('data snapshot import/export and explicit restore preserve application bytes and retain a preimage', async t => {
  const s = await setup(t); await importModule(s, await moduleSource(s, 'data', '1.0.0'), 'data');
  const original = Buffer.from([0, 255, 8, 10]); const path = await stateFile(s, 'data'); await writeFile(path, original);
  const snapshot = okay(await s.call(api + '/data/export', { scope: 'global', id: 'private.snapshot', title: 'Snapshot', version: '1.0.0', purpose: 'backup' }));
  await writeFile(path, 'newer');
  const imported = okay(await s.call(api + '/data/import', { path: snapshot.artifactPath }));
  assert.equal(imported.deduped, true);
  const preview = okay(await s.call(api + '/data/preview', { dataId: snapshot.data.dataId, mapping: { data: 'data' } }));
  refused(await s.call(api + '/data/apply', { reviewId: preview.reviewId, accepted: true }));
  const result = okay(await s.call(api + '/data/apply', { reviewId: preview.reviewId, accepted: true, dataCompatibilityAcknowledged: true }));
  assert.deepEqual(await readFile(path), original);
  assert.equal(await readFile(join(result.retainedPreviousData[0].path, 'application.txt'), 'utf8'), 'newer');
});

test('stale configuration and cleanup reviews cannot apply over edited resources or new preservation choices', async t => {
  const s = await setup(t); await importModule(s, await moduleSource(s, 'one', '1.0.0'), 'one');
  const saved = await capture(s, 'saved.one', ['one']);
  const cleanup = okay(await s.call(api + '/cleanup/preview', { keepProfileIds: [] }));
  const state = okay(await s.call(api));
  okay(await s.call(api + '/profiles/retain', { profileIds: [saved.profile.profileId], expectedRevision: state.revision }));
  refused(await s.call(api + '/cleanup/apply', { reviewId: cleanup.reviewId, accepted: true }));
  assert.ok(s.owner.localPrograms.records.has('one'));
});

test('a global body collection imports into a second Hub without instances and supplies separately exported configurations', async t => {
  const first = await setup(t);
  for (const id of ['a', 'b']) await importModule(first, await moduleSource(first, id, '1.0.0'), id);
  const saved = await capture(first, 'portable.all', [], 'global');
  const bodies = okay(await first.call(api + '/bodies/export', { scope: 'global' }));
  const config = okay(await first.call(api + '/profiles/export', { profileId: saved.profile.profileId }));
  const second = await setup(t);
  const imported = okay(await second.call(api + '/bodies/import', { path: bodies.directory }));
  assert.equal(imported.bodies.length, 2); assert.equal(second.owner.localPrograms.records.size, 0);
  okay(await second.call(api + '/bodies/import', { path: bodies.indexPath }));
  const profile = okay(await second.call(api + '/profiles/import', { path: config.artifactPath }));
  const preview = okay(await second.call(api + '/profiles/preview', { profileId: profile.profile.profileId }));
  assert.equal(preview.review.blocked, false);
  const applied = okay(await second.call(api + '/profiles/apply', { reviewId: preview.reviewId, accepted: true }));
  assert.equal(Object.keys(applied.mapping).length, 2); assert.equal(second.owner.resources.state.bodies.length, 2);
});

test('active and retained configurations protect direct uninstall; releasing them permits reviewed removal', async t => {
  const s = await setup(t); await importModule(s, await moduleSource(s, 'protected', '1.0.0'), 'protected');
  const config = await capture(s, 'protected.config', ['protected']);
  okay(await s.call(api + '/profiles/retain', { profileIds: [config.profile.profileId] }));
  const direct = refused(await s.call('/manage/api/programs/protected/remove', {})); assert.equal(direct.error.code, 'RESOURCE_CONFIGURATION_IN_USE');
  const uninstall = okay(await s.call('/manage/api/uninstall/modules/protected/preview', {}));
  assert.ok(uninstall.review.blockers.some(row => row.code === 'RESOURCE_CONFIGURATION_IN_USE'));
  const review = okay(await s.call(api + '/profiles/preview', { profileId: config.profile.profileId }));
  okay(await s.call(api + '/profiles/apply', { reviewId: review.reviewId, accepted: true }));
  okay(await s.call(api + '/profiles/deactivate', { profileIds: [config.profile.profileId], accepted: true }));
  okay(await s.call(api + '/profiles/retain', { profileIds: [] }));
  const available = okay(await s.call('/manage/api/uninstall/modules/protected/preview', {}));
  assert.equal(available.review.blocked, false);
  okay(await s.call('/manage/api/uninstall/modules/protected/apply', { reviewId: available.reviewId, accepted: true }));
  assert.equal(s.owner.localPrograms.records.size, 0); assert.equal(s.owner.resources.state.profiles.length, 1);
});

test('an interrupted multi-directory data restore fences instances across restart and explicitly restores the preimage', async t => {
  const s = await setup(t); await importModule(s, await moduleSource(s, 'recover', '1.0.0'), 'recover');
  await stateFile(s, 'recover', 'original');
  const local = s.owner.localPrograms, transaction = join(s.owner.resources.root, 'data-transactions', 'interruption');
  const stage = join(transaction, 'recover', 'after'), backup = join(transaction, 'recover', 'before'), state = local.path('recover', 'state');
  await mkdir(stage, { recursive: true }); await writeFile(join(stage, 'application.txt'), 'interrupted replacement');
  await writeFile(join(s.owner.resources.root, 'pending-data.json'), JSON.stringify({ format: 'world-hub.data-transaction/v1', ids: ['recover'], moves: [{ programId: 'recover', stage, backup, state }] }));
  await rename(state, backup); await rename(stage, state); await s.reload();
  const overview = okay(await s.call(api)); assert.equal(overview.recoveryRequired, true);
  const blocked = refused(await s.call('/manage/api/programs/recover/start', {})); assert.equal(blocked.error.code, 'RESOURCE_RECOVERY_REQUIRED');
  refused(await s.call(api + '/data/recover', {}));
  okay(await s.call(api + '/data/recover', { accepted: true }));
  assert.equal(await readFile(await stateFile(s, 'recover'), 'utf8'), 'original');
  assert.equal(okay(await s.call(api)).recoveryRequired, false); assert.equal(s.owner.localPrograms.row('recover').state, 'stopped');
});

test('failed cleanup commit leaves every registered body on disk and preserves application data', async t => {
  const s = await setup(t); await importModule(s, await moduleSource(s, 'removable', '1.0.0'), 'removable');
  const captured = await capture(s, 'unused.config', ['removable']); await stateFile(s, 'removable', 'private');
  const preview = okay(await s.call(api + '/cleanup/preview', { removeUnreferencedBodies: true }));
  const local = s.owner.localPrograms, save = local.save; local.save = async () => { throw Object.assign(new Error('write failure'), { code: 'EIO' }); };
  try { refused(await s.call(api + '/cleanup/apply', { reviewId: preview.reviewId, accepted: true })); } finally { local.save = save; }
  assert.ok(local.records.has('removable')); assert.equal(await readFile(await stateFile(s, 'removable'), 'utf8'), 'private');
  const body = await s.owner.resources.body(captured.profile.manifest.modules[0].module); assert.ok(body);
});

test('configuration preparation downloads exact pins only from enabled configured sources without creating instances', async t => {
  const first = await setup(t); await importModule(first, await moduleSource(first, 'download', '1.0.0'), 'download');
  const configuration = await capture(first, 'download.config', ['download']);
  const bodies = okay(await first.call(api + '/bodies/export', { scope: 'global' }));
  const second = await setup(t), imported = okay(await second.call(api + '/profiles/import', { path: configuration.artifactPath }));
  const source = okay(await second.call(api + '/sources/save', { name: 'Explicit local source', source: bodies.indexPath, enabled: true }));
  const prepared = okay(await second.call(api + '/profiles/prepare', { profileId: imported.profile.profileId, accepted: true }));
  assert.equal(prepared.fetched.length, 1); assert.equal(prepared.fetched[0].sourceId, source.source.id);
  assert.deepEqual(prepared.missingModules, []); assert.equal(second.owner.localPrograms.records.size, 0);
  assert.equal(second.owner.localPrograms.handles.size, 0);
  const sourceRecord = okay(await second.call(api)).sources[0];
  okay(await second.call(api + '/sources/save', { ...sourceRecord, enabled: false }));
  assert.equal(okay(await second.call(api)).sources[0].enabled, false);
  okay(await second.call(api + '/sources/remove', { sourceId: source.source.id }));
  assert.deepEqual(okay(await second.call(api)).sources, []); assert.equal(second.owner.resources.state.bodies.length, 1);
});
