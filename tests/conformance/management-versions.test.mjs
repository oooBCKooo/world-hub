import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { json, nativeProgram, setup, okay, refused, endpoint, overview, preview, apply, rollbackPreview, moduleSource, importModule, groupSource, importGroup, stateFile } from '../helpers/module-versions-scene.mjs';

test('management versions: original instance identity, token, wiring and opaque state survive upgrade and code-only rollback', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0', { topic: 'author/new-default' });
  await importModule(scene, v1, 'original');
  const local = scene.owner.localPrograms, principal = local.row('original').principal, identity = structuredClone(local.identities.get('original'));
  const state = await stateFile(scene, 'original', 'existing user data');
  const outside = join(scene.root, 'external-business-effect.txt'); await writeFile(outside, 'already sent to another service');
  const review = await preview(scene, 'modules', 'original', v2.directory);
  const upgraded = await apply(scene, 'modules', 'original', review);
  assert.equal(local.row('original').module.version, '2.0.0'); assert.equal(local.row('original').topics.events, 'versions/communication');
  assert.equal(local.row('original').settings.label, '1.0.0'); assert.equal(local.row('original').principal, principal);
  assert.deepEqual(local.identities.get('original'), identity); assert.equal(await readFile(state, 'utf8'), 'existing user data');
  await writeFile(state, 'business data written after upgrade');
  const back = await rollbackPreview(scene, 'modules', 'original', upgraded.transactionId);
  await apply(scene, 'modules', 'original', back);
  assert.equal(local.row('original').module.version, '1.0.0'); assert.equal(local.row('original').principal, principal);
  assert.deepEqual(local.identities.get('original'), identity); assert.equal(await readFile(state, 'utf8'), 'business data written after upgrade');
  assert.equal(await readFile(outside, 'utf8'), 'already sent to another service');
  const history = await overview(scene, 'modules', 'original'); assert.equal(history.history.length, 2);
  assert.equal(JSON.stringify({ review, upgraded, back, history }).includes(identity.token), false);
  assert.equal(local.handles.size, 0); assert.equal(local.row('original').state, 'stopped');
});

test('management versions: fresh state and author configuration are explicit and rollback can restore the transaction snapshot', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0', { topic: 'author/version-two' });
  await importModule(scene, v1, 'original'); const path = await stateFile(scene, 'original', 'v1 state');
  const review = await preview(scene, 'modules', 'original', v2.directory, { dataPolicy: 'fresh', configurationPolicy: 'author' });
  refused(await scene.call(endpoint('modules', 'original', 'apply'), { reviewId: review.reviewId, accepted: true }));
  assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0'); assert.equal(await readFile(path, 'utf8'), 'v1 state');
  const upgraded = await apply(scene, 'modules', 'original', review);
  assert.equal(scene.owner.localPrograms.row('original').topics.events, 'author/version-two'); assert.equal(scene.owner.localPrograms.row('original').settings.label, '2.0.0');
  await assert.rejects(readFile(path), { code: 'ENOENT' }); await stateFile(scene, 'original', 'v2 newly created state');
  const back = await rollbackPreview(scene, 'modules', 'original', upgraded.transactionId, 'restore'); await apply(scene, 'modules', 'original', back);
  assert.equal(await readFile(path, 'utf8'), 'v1 state'); assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0');
});

test('management versions: stale revisions and changed candidate bytes cannot mutate the installed module', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); const revision = (await overview(scene, 'modules', 'original')).current.revision;
  refused(await scene.call(endpoint('modules', 'original', 'preview'), { path: v2.directory, expectedRevision: 'stale', dataPolicy: 'preserve', configurationPolicy: 'preserve' }));
  const review = await preview(scene, 'modules', 'original', v2.directory);
  await writeFile(join(v2.directory, 'program.mjs'), nativeProgram('2.0.0') + '\n// modified after review\n');
  refused(await scene.call(endpoint('modules', 'original', 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true }));
  assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0');
  assert.equal((await overview(scene, 'modules', 'original')).current.revision, revision);
  assert.equal((await overview(scene, 'modules', 'original')).history.length, 0);
  const altered = await moduleSource(scene, 'altered', '1.0.0', { moduleId: v1.manifest.id });
  const immutable = refused(await scene.call(endpoint('modules', 'original', 'preview'), { path: altered.directory, expectedRevision: revision }));
  assert.equal(immutable.error.code, 'VERSION_VERSION_IMMUTABLE');
  for (const action of ['preview', 'apply']) {
    const bypass = refused(await scene.call(`/manage/api/programs/original/configuration/${action}`, { directory: v2.directory, expectedRevision: revision }));
    assert.equal(bypass.error.code, 'VERSION_REVIEW_REQUIRED');
  }
  assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0');
});

test('management versions: changing only a candidate group root manifest invalidates its review without partial registration', async t => {
  const scene = await setup(t), v1 = await groupSource(scene, '1.0.0', ['first', 'second']), v2 = await groupSource(scene, '2.0.0', ['first', 'third']);
  const imported = await importGroup(scene, v1), id = imported.group.id, local = scene.owner.localPrograms;
  const before = structuredClone(local.groups.get(id)), rows = JSON.stringify([...local.records.values()]);
  for (const [field, value] of [['license', 'Apache-2.0'], ['version', '9.0.0']]) {
    await writeFile(join(v2.directory, 'module-group.json'), json(v2.manifest));
    const review = await preview(scene, 'groups', id, v2.directory, { configurationPolicy: 'author' });
    await writeFile(join(v2.directory, 'module-group.json'), json({ ...v2.manifest, [field]: value }));
    const invalid = refused(await scene.call(endpoint('groups', id, 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true }));
    assert.equal(invalid.error.code, 'VERSION_REVIEW_CHANGED'); assert.deepEqual(local.groups.get(id), before);
    assert.equal(JSON.stringify([...local.records.values()]), rows); assert.equal((await overview(scene, 'groups', id)).history.length, 0);
  }
});

test('management versions: running owned modules reject version changes without being killed', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); okay(await scene.call('/manage/api/programs/original/start', {}));
  const handle = scene.owner.localPrograms.handles.get('original'), revision = (await overview(scene, 'modules', 'original')).current.revision;
  refused(await scene.call(endpoint('modules', 'original', 'preview'), { path: v2.directory, expectedRevision: revision, dataPolicy: 'preserve', configurationPolicy: 'preserve' }));
  assert.equal(scene.owner.localPrograms.handles.get('original'), handle); assert.equal(handle.exit, null);
  assert.equal(scene.owner.localPrograms.row('original').state, 'running'); assert.equal(scene.hub.snapshot().bridges.length, 1);
});

test('management versions: an upgraded real child process reconnects with its original identity and communicates with a running peer', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0'), peer = await moduleSource(scene, 'peer', '1.0.0');
  await importModule(scene, v1, 'original'); await importModule(scene, peer, 'peer');
  okay(await scene.call('/manage/api/programs/peer/start', {})); okay(await scene.call('/manage/api/programs/original/start', {}));
  const principal = scene.owner.localPrograms.row('original').principal, peerHandle = scene.owner.localPrograms.handles.get('peer');
  okay(await scene.call('/manage/api/programs/original/stop', {}));
  const review = await preview(scene, 'modules', 'original', v2.directory); await apply(scene, 'modules', 'original', review);
  okay(await scene.call('/manage/api/programs/original/start', {}));
  const observed = () => peerHandle.stdout.split('\n').some(line => { try { const event = JSON.parse(line); return event.event === 'received' && event.body.member === 'original' && event.body.version === '2.0.0'; } catch { return false; } });
  const deadline = Date.now() + 5000; while (!observed() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(observed(), peerHandle.stdout); assert.equal(scene.owner.localPrograms.row('original').principal, principal);
  assert.equal(scene.owner.localPrograms.handles.get('peer'), peerHandle); assert.equal(peerHandle.exit, null);
  assert.equal(scene.hub.snapshot().bridges.length, 2);
});

test('management versions: group upgrades preserve logical member identities, add instances and only detach removed running members', async t => {
  const scene = await setup(t), v1 = await groupSource(scene, '1.0.0', ['first', 'second']), v2 = await groupSource(scene, '2.0.0', ['first', 'third']);
  const imported = await importGroup(scene, v1), id = imported.group.id, local = scene.owner.localPrograms;
  const before = local.groups.get(id), mapping = structuredClone(before.origin.members), firstIdentity = structuredClone(local.identities.get(mapping.first));
  const shared = okay(await scene.call('/manage/api/groups/save', { group: { id: 'other-group', title: 'Other group', memberProgramIds: [mapping.first, mapping.second] } }));
  const state = await stateFile(scene, mapping.first, 'shared instance business state');
  okay(await scene.call(`/manage/api/programs/${mapping.second}/start`, {})); const removedHandle = local.handles.get(mapping.second);
  const review = await preview(scene, 'groups', id, v2.directory, { configurationPolicy: 'author' });
  assert.ok(review.review.removedMembers.some(row => row.programId === mapping.second && row.retainedRegistered === true));
  assert.ok(review.review.programs.find(row => row.programId === mapping.first).affected.sharedWithGroups.some(group => group.id === shared.group.id));
  const upgraded = await apply(scene, 'groups', id, review), after = local.groups.get(id);
  assert.equal(after.origin.version, '2.0.0'); assert.equal(after.origin.members.first, mapping.first); assert.ok(after.origin.members.third);
  assert.deepEqual(local.identities.get(mapping.first), firstIdentity); assert.equal(local.row(mapping.first).module.version, '2.0.0');
  assert.equal(after.memberProgramIds.includes(mapping.second), false); assert.ok(local.records.has(mapping.second));
  assert.equal(local.handles.get(mapping.second), removedHandle); assert.equal(removedHandle.exit, null);
  assert.equal(local.row(mapping.second).state, 'running'); assert.deepEqual(local.groups.get(shared.group.id).memberProgramIds, [mapping.first, mapping.second]);
  assert.equal(await readFile(state, 'utf8'), 'shared instance business state');
  const back = await rollbackPreview(scene, 'groups', id, upgraded.transactionId); await apply(scene, 'groups', id, back);
  const restored = local.groups.get(id); assert.equal(restored.origin.version, '1.0.0'); assert.equal(restored.origin.members.first, mapping.first);
  assert.equal(restored.origin.members.second, mapping.second); assert.ok(local.records.has(after.origin.members.third));
  assert.equal(local.row(mapping.second).state, 'running');
});

test('management versions: a group transaction fails atomically when its final registry write fails', async t => {
  const scene = await setup(t), v1 = await groupSource(scene, '1.0.0', ['first', 'second']), v2 = await groupSource(scene, '2.0.0', ['first', 'third']);
  const imported = await importGroup(scene, v1), id = imported.group.id, local = scene.owner.localPrograms;
  const before = structuredClone(local.groups.get(id)), beforeRows = JSON.stringify([...local.records.values()]), ids = new Map(local.identities);
  const review = await preview(scene, 'groups', id, v2.directory, { configurationPolicy: 'author' });
  const save = local.save; local.save = async () => { throw new Error('fixture final registry write failed'); };
  try { refused(await scene.call(endpoint('groups', id, 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true })); }
  finally { local.save = save; }
  assert.deepEqual(local.groups.get(id), before); assert.equal(JSON.stringify([...local.records.values()]), beforeRows);
  assert.deepEqual(local.identities, ids);
  for (const programId of before.memberProgramIds) assert.equal(JSON.parse(await readFile(local.path(programId, 'module', 'module.json'))).version, '1.0.0');
});

test('management versions: history and rollback snapshots persist through management restart without exposing private tokens', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); const identity = structuredClone(scene.owner.localPrograms.identities.get('original'));
  const state = await stateFile(scene, 'original', 'persisted v1 state');
  const upgraded = await apply(scene, 'modules', 'original', await preview(scene, 'modules', 'original', v2.directory));
  await writeFile(state, 'persisted v2 state'); await scene.reload();
  const observed = await overview(scene, 'modules', 'original'); assert.equal(observed.current.version, '2.0.0');
  assert.ok(observed.history.some(row => row.id === upgraded.transactionId)); assert.equal(JSON.stringify(observed).includes(identity.token), false);
  assert.deepEqual(scene.owner.localPrograms.identities.get('original'), identity);
  await apply(scene, 'modules', 'original', await rollbackPreview(scene, 'modules', 'original', upgraded.transactionId, 'restore'));
  assert.equal(await readFile(state, 'utf8'), 'persisted v1 state'); assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0');
});

test('management versions: a selected older release is installed in place and a different source identity is refused', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  const other = await moduleSource(scene, 'other', '1.0.0');
  await importModule(scene, v2, 'original'); const identity = structuredClone(scene.owner.localPrograms.identities.get('original'));
  const review = await preview(scene, 'modules', 'original', v1.directory); await apply(scene, 'modules', 'original', review);
  assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0'); assert.deepEqual(scene.owner.localPrograms.identities.get('original'), identity);
  const current = await overview(scene, 'modules', 'original');
  const invalid = refused(await scene.call(endpoint('modules', 'original', 'preview'), { path: other.directory, expectedRevision: current.current.revision }));
  assert.equal(invalid.error.code, 'VERSION_SOURCE_ID_CHANGED'); assert.equal((await overview(scene, 'modules', 'original')).history.length, 1);
});

test('management versions: changing a provider preserves shared consumers and refuses removal of their required contract', async t => {
  const scene = await setup(t), contract = { id: 'versions.service', version: '1.0.0' };
  const v1 = await moduleSource(scene, 'provider', '1.0.0', { provides: [contract] });
  const v2 = await moduleSource(scene, 'provider', '2.0.0', { provides: [contract] });
  const broken = await moduleSource(scene, 'provider', '3.0.0');
  const consumer = await moduleSource(scene, 'consumer', '1.0.0', { requires: [contract] });
  await importModule(scene, v1, 'provider'); await importModule(scene, consumer, 'consumer', { bindings: [{ providerId: 'provider', contract }] });
  okay(await scene.call('/manage/api/groups/save', { group: { id: 'shared', title: 'Shared provider', memberProgramIds: ['provider'] } }));
  const before = structuredClone(scene.owner.localPrograms.row('consumer'));
  const review = await preview(scene, 'modules', 'provider', v2.directory);
  assert.deepEqual(review.review.programs[0].affected.consumers.map(row => row.programId), ['consumer']);
  assert.ok(review.review.programs[0].affected.sharedWithGroups.some(row => row.id === 'shared'));
  await apply(scene, 'modules', 'provider', review); assert.deepEqual(scene.owner.localPrograms.row('consumer'), before);
  const observed = await overview(scene, 'modules', 'provider');
  const invalid = refused(await scene.call(endpoint('modules', 'provider', 'preview'), { path: broken.directory, expectedRevision: observed.current.revision }));
  assert.equal(invalid.error.code, 'LOCAL_PROVIDER_CONTRACT_IN_USE'); assert.equal(scene.owner.localPrograms.row('provider').module.version, '2.0.0');
  assert.deepEqual(scene.owner.localPrograms.row('consumer'), before);
});

test('management versions: changing state or peer configuration after review prevents stale application', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  const peer = await moduleSource(scene, 'peer', '1.0.0'); await importModule(scene, v1, 'original'); await importModule(scene, peer, 'peer');
  const state = await stateFile(scene, 'original', 'before review'), review = await preview(scene, 'modules', 'original', v2.directory);
  await writeFile(state, 'external edit after review');
  const changed = refused(await scene.call(endpoint('modules', 'original', 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true }));
  assert.equal(changed.error.code, 'VERSION_REVIEW_CHANGED'); assert.equal(await readFile(state, 'utf8'), 'external edit after review');
  const again = await preview(scene, 'modules', 'original', v2.directory);
  const local = scene.owner.localPrograms, peerBefore = local.row('peer');
  local.records.set('peer', { ...peerBefore, settings: { label: 'peer changed after review' } });
  const peerChanged = refused(await scene.call(endpoint('modules', 'original', 'apply'), { reviewId: again.reviewId, accepted: true, dataAcknowledged: true }));
  assert.equal(peerChanged.error.code, 'VERSION_REVIEW_CHANGED'); assert.equal(local.row('original').module.version, '1.0.0');
});

test('management versions: restoring an absent historical state removes only the active instance state', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original');
  await assert.rejects(lstat(scene.owner.localPrograms.path('original', 'state')), { code: 'ENOENT' });
  const updated = await apply(scene, 'modules', 'original', await preview(scene, 'modules', 'original', v2.directory, { dataPolicy: 'fresh' }));
  const state = await stateFile(scene, 'original', 'created after update'), outside = join(scene.root, 'outside-state.txt'); await writeFile(outside, 'keep');
  await apply(scene, 'modules', 'original', await rollbackPreview(scene, 'modules', 'original', updated.transactionId, 'restore'));
  await assert.rejects(readFile(state), { code: 'ENOENT' }); assert.equal(await readFile(outside, 'utf8'), 'keep');
  await assert.rejects(lstat(scene.owner.localPrograms.path('original', 'state')), { code: 'ENOENT' });
  assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0');
});

test('management versions: an interrupted final save blocks execution and can recover after management restart', async t => {
  const scene = await setup(t), v1 = await groupSource(scene, '1.0.0', ['first']), v2 = await groupSource(scene, '2.0.0', ['first', 'second']);
  const imported = await importGroup(scene, v1), id = imported.group.id, original = imported.group.origin.members.first;
  const identity = structuredClone(scene.owner.localPrograms.identities.get(original)), state = await stateFile(scene, original, 'recover original');
  const review = await preview(scene, 'groups', id, v2.directory, { configurationPolicy: 'author', dataPolicy: 'fresh' });
  const local = scene.owner.localPrograms, save = local.save;
  local.save = async () => { throw new Error('fixture persistent storage outage'); };
  let failure; try { failure = refused(await scene.call(endpoint('groups', id, 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true })); }
  finally { local.save = save; }
  assert.equal(failure.error.code, 'VERSION_RECOVERY_REQUIRED');
  await scene.reload(); assert.deepEqual(scene.owner.localPrograms.identities.get(original), identity);
  const pending = (await overview(scene, 'groups', id)).recoveryRequired; assert.equal(pending.length, 1);
  const blocked = refused(await scene.call(`/manage/api/programs/${original}/start`, {})); assert.equal(blocked.error.code, 'VERSION_RECOVERY_REQUIRED');
  assert.equal(scene.owner.localPrograms.handles.size, 0);
  refused(await scene.call(endpoint('groups', id, 'recover'), { transactionId: pending[0].transactionId }));
  okay(await scene.call(endpoint('groups', id, 'recover'), { transactionId: pending[0].transactionId, accepted: true }));
  assert.equal((await overview(scene, 'groups', id)).recoveryRequired.length, 0); assert.equal(await readFile(state, 'utf8'), 'recover original');
  assert.equal(scene.owner.localPrograms.row(original).module.version, '1.0.0'); assert.equal(scene.owner.localPrograms.records.size, 1);
  okay(await scene.call(`/manage/api/programs/${original}/start`, {})); assert.equal(scene.owner.localPrograms.row(original).state, 'running');
});

test('management versions: failure to clear a committed marker retains the new version until explicit recovery cleanup', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); const review = await preview(scene, 'modules', 'original', v2.directory), versions = scene.owner.versions;
  const clear = versions.clearMarker; versions.clearMarker = async () => { throw new Error('fixture marker unlink outage'); };
  let updated; try { updated = await apply(scene, 'modules', 'original', review); } finally { versions.clearMarker = clear; }
  assert.equal(updated.cleanupPending, true);
  assert.equal(scene.owner.localPrograms.row('original').module.version, '2.0.0');
  const observed = await overview(scene, 'modules', 'original'); assert.ok(observed.history.some(row => row.id === updated.transactionId && row.status === 'committed'));
  assert.equal(observed.history.length, 1); assert.equal(observed.recoveryRequired[0].transactionId, updated.transactionId);
  assert.equal(observed.recoveryRequired[0].status, 'committed');
  const blocked = refused(await scene.call('/manage/api/programs/original/start', {})); assert.equal(blocked.error.code, 'VERSION_RECOVERY_REQUIRED');
  okay(await scene.call(endpoint('modules', 'original', 'recover'), { transactionId: updated.transactionId, accepted: true }));
  assert.equal(scene.owner.localPrograms.row('original').module.version, '2.0.0'); okay(await scene.call('/manage/api/programs/original/start', {}));
});

test('management versions: a group member removed and later reintroduced reuses its original instance and data', async t => {
  const scene = await setup(t), v1 = await groupSource(scene, '1.0.0', ['first', 'second']);
  const v2 = await groupSource(scene, '2.0.0', ['first', 'third']), v3 = await groupSource(scene, '3.0.0', ['first', 'second']);
  const imported = await importGroup(scene, v1), id = imported.group.id, local = scene.owner.localPrograms;
  const second = imported.group.origin.members.second, identity = structuredClone(local.identities.get(second));
  const state = await stateFile(scene, second, 'second existing user content');
  await apply(scene, 'groups', id, await preview(scene, 'groups', id, v2.directory, { configurationPolicy: 'author' }));
  assert.equal(local.groups.get(id).memberProgramIds.includes(second), false); assert.equal(await readFile(state, 'utf8'), 'second existing user content');
  const next = await preview(scene, 'groups', id, v3.directory, { configurationPolicy: 'author' });
  assert.equal(next.review.programs.find(row => row.after.id === 'versions.second').programId, second);
  assert.equal(next.review.programs.find(row => row.programId === second).change, 'update');
  await apply(scene, 'groups', id, next);
  assert.equal(local.groups.get(id).origin.members.second, second); assert.equal(local.row(second).module.version, '3.0.0');
  assert.deepEqual(local.identities.get(second), identity); assert.equal(await readFile(state, 'utf8'), 'second existing user content');
  assert.equal(local.records.size, 3);
});

test('management versions: a pending journal fences starts and edits even when no per-instance marker was written', async t => {
  const scene = await setup(t), v1 = await groupSource(scene, '1.0.0', ['first']), v2 = await groupSource(scene, '2.0.0', ['first']);
  const imported = await importGroup(scene, v1), id = imported.group.id, programId = imported.group.origin.members.first;
  const updated = await apply(scene, 'groups', id, await preview(scene, 'groups', id, v2.directory));
  const journalPath = join(scene.owner.versions.directory, updated.transactionId, 'journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')); journal.status = 'preparing'; await writeFile(journalPath, json(journal));
  await scene.reload();
  const observed = await overview(scene, 'groups', id); assert.equal(observed.recoveryRequired.length, 1);
  const blockedStart = refused(await scene.call(`/manage/api/programs/${programId}/start`, {})); assert.equal(blockedStart.error.code, 'VERSION_RECOVERY_REQUIRED');
  const local = scene.owner.localPrograms, group = local.groups.get(id);
  const blockedGroup = refused(await scene.call(`/manage/api/groups/${id}/remove`, { expectedRevision: group.revision }));
  assert.equal(blockedGroup.error.code, 'VERSION_RECOVERY_REQUIRED');
  const blockedConfig = refused(await scene.call(`/manage/api/programs/${programId}/configuration/preview`, { expectedRevision: (await overview(scene, 'modules', programId)).current.revision, settings: { label: 'blocked' } }));
  assert.equal(blockedConfig.error.code, 'VERSION_RECOVERY_REQUIRED');
  assert.ok(local.groups.has(id)); assert.equal(local.handles.size, 0);
  okay(await scene.call(endpoint('groups', id, 'recover'), { transactionId: updated.transactionId, accepted: true }));
  assert.equal(local.row(programId).module.version, '1.0.0'); assert.equal((await overview(scene, 'groups', id)).recoveryRequired.length, 0);
});

test('management versions: prepared application caches follow reviewed source across upgrade and reuse the original cache on rollback', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); const local = scene.owner.localPrograms, preparations = [];
  local.prepareDependencies = async ({ directory, manifest, stateDir }) => {
    const app = join(stateDir, 'app'), receipt = join(stateDir, 'prepared.json');
    let existing;
    try { existing = JSON.parse(await readFile(receipt, 'utf8')); } catch (issue) { if (issue.code !== 'ENOENT') throw issue; }
    if (existing) assert.equal(existing.version, manifest.version, 'a copied application cache cannot be reused for another source version');
    else {
      await mkdir(app, { recursive: true });
      for (const file of ['module.json', 'deployment.json', 'program.mjs', 'bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(directory, file), join(app, file));
      await writeFile(receipt, json({ version: manifest.version }));
    }
    preparations.push({ version: manifest.version, directory: stateDir }); return { directory: app };
  };
  okay(await scene.call('/manage/api/programs/original/start', {})); okay(await scene.call('/manage/api/programs/original/stop', {}));
  const updated = await apply(scene, 'modules', 'original', await preview(scene, 'modules', 'original', v2.directory));
  okay(await scene.call('/manage/api/programs/original/start', {}));
  assert.ok(local.handles.get('original').stdout.split('\n').some(line => { try { return JSON.parse(line).body?.version === '2.0.0'; } catch { return false; } }));
  okay(await scene.call('/manage/api/programs/original/stop', {}));
  await apply(scene, 'modules', 'original', await rollbackPreview(scene, 'modules', 'original', updated.transactionId));
  okay(await scene.call('/manage/api/programs/original/start', {}));
  const v1Caches = new Set(preparations.filter(row => row.version === '1.0.0').map(row => row.directory));
  const v2Caches = new Set(preparations.filter(row => row.version === '2.0.0').map(row => row.directory));
  assert.equal(v1Caches.size, 1); assert.equal(v2Caches.size, 1); assert.notEqual([...v1Caches][0], [...v2Caches][0]);
  assert.equal(preparations.at(-1).directory, preparations[0].directory); assert.equal(local.row('original').module.version, '1.0.0');
});

test('management versions: changed historical metadata is refused before rollback can alter the current instance', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); const state = await stateFile(scene, 'original', 'unchanged private state');
  const updated = await apply(scene, 'modules', 'original', await preview(scene, 'modules', 'original', v2.directory));
  const path = join(scene.owner.versions.directory, updated.transactionId, 'before.json'), metadata = JSON.parse(await readFile(path, 'utf8'));
  metadata.records[0].settings.label = 'modified historical metadata'; await writeFile(path, json(metadata));
  const observed = await overview(scene, 'modules', 'original');
  const invalid = refused(await scene.call(endpoint('modules', 'original', 'rollback-preview'), { transactionId: updated.transactionId, expectedRevision: observed.current.revision, dataPolicy: 'preserve' }));
  assert.equal(invalid.error.code, 'VERSION_SNAPSHOT_CHANGED'); assert.equal(scene.owner.localPrograms.row('original').module.version, '2.0.0');
  assert.equal(await readFile(state, 'utf8'), 'unchanged private state'); assert.equal((await overview(scene, 'modules', 'original')).history.length, 1);
});

test('management versions: changing the private identity after review refuses application without replacing that identity', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); const review = await preview(scene, 'modules', 'original', v2.directory);
  const path = scene.owner.localPrograms.path('original', 'identity.json'), identity = JSON.parse(await readFile(path, 'utf8'));
  identity.token = (identity.token[0] === 'A' ? 'B' : 'A') + identity.token.slice(1); await writeFile(path, json(identity));
  const invalid = refused(await scene.call(endpoint('modules', 'original', 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true }));
  assert.equal(invalid.error.code, 'VERSION_IDENTITY_CHANGED'); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), identity);
  assert.equal(scene.owner.localPrograms.row('original').module.version, '1.0.0'); assert.equal((await overview(scene, 'modules', 'original')).history.length, 0);
});

for (const change of ['source', 'fresh-state', 'preserved-state']) test(`management versions: interrupted recovery ${change === 'preserved-state' ? 'preserves' : 'refuses to overwrite'} externally changed ${change}`, async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  await importModule(scene, v1, 'original'); const state = await stateFile(scene, 'original', 'state before transaction');
  const policy = change === 'preserved-state' ? 'preserve' : 'fresh';
  const review = await preview(scene, 'modules', 'original', v2.directory, { dataPolicy: policy }), local = scene.owner.localPrograms, save = local.save;
  local.save = async () => { throw new Error('fixture recovery storage outage'); };
  let invalid; try { invalid = refused(await scene.call(endpoint('modules', 'original', 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true })); }
  finally { local.save = save; }
  assert.equal(invalid.error.code, 'VERSION_RECOVERY_REQUIRED'); const pending = (await overview(scene, 'modules', 'original')).recoveryRequired[0];
  const modifiedPath = change === 'source' ? local.path('original', 'module', 'program.mjs') : state;
  const edited = change === 'source' ? nativeProgram('1.0.0') + '\n// changed outside the interrupted transaction\n' : 'external state written after the interruption';
  await writeFile(modifiedPath, edited);
  const result = await scene.call(endpoint('modules', 'original', 'recover'), { transactionId: pending.transactionId, accepted: true });
  if (change === 'preserved-state') { okay(result); assert.equal((await overview(scene, 'modules', 'original')).recoveryRequired.length, 0); }
  else { assert.equal(refused(result).error.code, 'VERSION_RECOVERY_CONFLICT'); assert.equal((await overview(scene, 'modules', 'original')).recoveryRequired.length, 1); }
  assert.equal(await readFile(modifiedPath, 'utf8'), edited); assert.equal(local.row('original').module.version, '1.0.0'); assert.equal(local.handles.size, 0);
});

test('management versions: recovery after a durable new registry write removes added members from registration and startup plans', async t => {
  const scene = await setup(t), v1 = await groupSource(scene, '1.0.0', ['first']), v2 = await groupSource(scene, '2.0.0', ['first', 'second']);
  const imported = await importGroup(scene, v1), id = imported.group.id, first = imported.group.origin.members.first, local = scene.owner.localPrograms;
  await local.saveStartupPlan({ expectedRevision: local.getStartupPlan().revision, plan: { members: [{ programId: first, enabled: true, after: [] }], startupOrder: [first], onFailure: 'continue-independent' } });
  const review = await preview(scene, 'groups', id, v2.directory, { configurationPolicy: 'author', dataPolicy: 'fresh' });
  const save = local.save, versions = scene.owner.versions, restore = versions.restoreBefore;
  local.save = async () => { await save.call(local); throw new Error('fixture interruption after durable registry write'); };
  versions.restoreBefore = async () => { throw new Error('fixture interruption before file rollback'); };
  try { assert.equal(refused(await scene.call(endpoint('groups', id, 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true })).error.code, 'VERSION_RECOVERY_REQUIRED'); }
  finally { local.save = save; versions.restoreBefore = restore; }
  await scene.reload(); const restarted = scene.owner.localPrograms, next = restarted.groups.get(id), added = next.origin.members.second;
  assert.ok(added); assert.ok(restarted.identities.get(added)); assert.equal(restarted.row(first).module.version, '2.0.0');
  assert.ok(restarted.getStartupPlan().members.some(member => member.programId === added));
  const pending = (await overview(scene, 'groups', id)).recoveryRequired[0]; assert.equal(pending.status, 'switching');
  okay(await scene.call(endpoint('groups', id, 'recover'), { transactionId: pending.transactionId, accepted: true }));
  assert.equal(restarted.row(first).module.version, '1.0.0'); assert.equal(restarted.records.has(added), false); assert.equal(restarted.identities.has(added), false);
  const plan = restarted.getStartupPlan(); assert.equal(plan.members.some(member => member.programId === added || member.after.includes(added)), false);
  assert.equal(plan.startupOrder.includes(added), false); assert.deepEqual(restarted.groups.get(id).memberProgramIds, [first]);
  await scene.reload(); assert.equal(scene.owner.localPrograms.records.size, 1); assert.equal((await overview(scene, 'groups', id)).recoveryRequired.length, 0);
});
