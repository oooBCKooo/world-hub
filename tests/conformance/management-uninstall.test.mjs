import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, okay, refused, moduleSource, importModule, groupSource, importGroup, stateFile, json } from '../helpers/module-versions-scene.mjs';

const path = (collection, id, action) => `/manage/api/uninstall/${collection}/${encodeURIComponent(id)}/${action}`;
async function preview(scene, collection, id, input = {}) { return okay(await scene.call(path(collection, id, 'preview'), input)); }
async function apply(scene, collection, id, review, options = {}) {
  return okay(await scene.call(path(collection, id, 'apply'), { reviewId: review.reviewId, accepted: true, stopOwned: false, ...options }));
}
async function group(scene, id, ids) { return okay(await scene.call('/manage/api/groups/save', { group: { id, title: id, memberProgramIds: ids } })).group; }
async function configurePlan(scene, ids) {
  const current = okay(await scene.call('/manage/api/programs/startup-plan'));
  return okay(await scene.call('/manage/api/programs/startup-plan/save', { expectedRevision: current.plan.revision,
    plan: { format: current.plan.format, members: ids.map((programId, index) => ({ programId, enabled: true, after: index ? [ids[index - 1]] : [] })), startupOrder: ids, onFailure: 'continue-independent' } }));
}
function noPlanReference(plan, id) {
  assert.equal(plan.members.some(row => row.programId === id || row.after.includes(id)), false);
  assert.equal(plan.startupOrder?.includes(id) ?? false, false);
}

test('management uninstall: a grouped module is reviewed, detached and unregistered while its source, identity and data remain untouched', async t => {
  const scene = await setup(t), source = await groupSource(scene, '1.0.0', ['first', 'second']);
  const imported = await importGroup(scene, source), local = scene.owner.localPrograms;
  const [first, second] = imported.group.memberProgramIds;
  await configurePlan(scene, [first, second]);
  const original = local.groups.get(imported.group.id);
  okay(await scene.call('/manage/api/groups/save', { expectedRevision: original.revision, group: { ...original,
    startupPlan: { ...original.startupPlan, members: [{ programId: first, enabled: true, after: [] }, { programId: second, enabled: true, after: [first] }], startupOrder: [first, second] } } }));
  const state = await stateFile(scene, first, 'opaque private state'), identity = await readFile(local.path(first, 'identity.json'));
  const sourceBytes = await readFile(local.path(first, 'module', 'program.mjs'));
  const legacy = refused(await scene.call(`/manage/api/programs/${first}/remove`, {}));
  assert.equal(legacy.error.code, 'LOCAL_PROGRAM_IN_GROUP');
  const review = await preview(scene, 'modules', first);
  assert.equal(review.review.programs.find(row => row.programId === first).selected, true);
  assert.equal(JSON.stringify(review).includes(local.identities.get(first).token), false);
  await apply(scene, 'modules', first, review);
  assert.equal(local.records.has(first), false); assert.equal(local.identities.has(first), false); assert.ok(local.records.has(second));
  assert.deepEqual(local.groups.get(imported.group.id).memberProgramIds, [second]);
  noPlanReference(local.groups.get(imported.group.id).startupPlan, first); noPlanReference(local.getStartupPlan(), first);
  assert.deepEqual(await readFile(local.path(first, 'module', 'program.mjs')), sourceBytes);
  assert.deepEqual(await readFile(local.path(first, 'identity.json')), identity); assert.equal(await readFile(state, 'utf8'), 'opaque private state');
  await scene.reload(); assert.equal(scene.owner.localPrograms.records.has(first), false); assert.ok(scene.owner.localPrograms.records.has(second));
});

test('management uninstall: an installed capability consumer blocks deleting its provider without silently changing consumer bindings', async t => {
  const scene = await setup(t), contract = { id: 'uninstall.service', version: '1.0.0' };
  await importModule(scene, await moduleSource(scene, 'provider', '1.0.0', { provides: [contract] }), 'provider');
  await importModule(scene, await moduleSource(scene, 'consumer', '1.0.0', { requires: [contract] }), 'consumer', { bindings: [{ providerId: 'provider', contract }] });
  const local = scene.owner.localPrograms, before = structuredClone(local.row('consumer'));
  const review = await preview(scene, 'modules', 'provider'); assert.ok(review.review.blocked);
  refused(await scene.call(path('modules', 'provider', 'apply'), { reviewId: review.reviewId, accepted: true, stopOwned: true }));
  assert.ok(local.records.has('provider')); assert.deepEqual(local.row('consumer'), before);
});

test('management uninstall: default group selection retains shared modules and the dependency closure needed by external consumers', async t => {
  const scene = await setup(t), one = { id: 'uninstall.first', version: '1.0.0' }, two = { id: 'uninstall.second', version: '1.0.0' };
  await importModule(scene, await moduleSource(scene, 'one', '1.0.0', { provides: [one] }), 'one');
  await importModule(scene, await moduleSource(scene, 'two', '1.0.0', { provides: [two], requires: [one] }), 'two', { bindings: [{ providerId: 'one', contract: one }] });
  await importModule(scene, await moduleSource(scene, 'outside', '1.0.0', { requires: [two] }), 'outside', { bindings: [{ providerId: 'two', contract: two }] });
  for (const id of ['exclusive', 'shared']) await importModule(scene, await moduleSource(scene, id, '1.0.0'), id);
  await group(scene, 'selected', ['one', 'two', 'exclusive', 'shared']); await group(scene, 'other', ['shared']);
  const local = scene.owner.localPrograms, beforeOutside = structuredClone(local.row('outside'));
  const invalid = await preview(scene, 'groups', 'selected', { programIds: ['one'] }); assert.ok(invalid.review.blocked);
  refused(await scene.call(path('groups', 'selected', 'apply'), { reviewId: invalid.reviewId, accepted: true, stopOwned: true }));
  const review = await preview(scene, 'groups', 'selected');
  assert.deepEqual(review.review.programs.filter(row => row.selected).map(row => row.programId), ['exclusive']);
  await apply(scene, 'groups', 'selected', review);
  assert.equal(local.groups.has('selected'), false); assert.equal(local.records.has('exclusive'), false);
  for (const id of ['one', 'two', 'outside', 'shared']) assert.ok(local.records.has(id), id);
  assert.deepEqual(local.row('outside'), beforeOutside); assert.deepEqual(local.groups.get('other').memberProgramIds, ['shared']);
});

test('management uninstall: authorized group uninstall stops only selected owned children and a shared child still exchanges real Hub messages', async t => {
  const scene = await setup(t), imported = await importGroup(scene, await groupSource(scene, '1.0.0', ['shared', 'exclusive']));
  const local = scene.owner.localPrograms, { shared, exclusive } = imported.group.origin.members;
  await group(scene, 'other', [shared]);
  for (const id of [shared, exclusive]) okay(await scene.call(`/manage/api/programs/${id}/start`, {}));
  const sharedHandle = local.handles.get(shared), exclusiveHandle = local.handles.get(exclusive), privateToken = local.identities.get(exclusive).token;
  const review = await preview(scene, 'groups', imported.group.id);
  assert.deepEqual(review.review.requiresStop, [exclusive]); assert.equal(JSON.stringify(review).includes(privateToken), false);
  const observedAt = local.row(shared).communicationObservedAt, observationDeadline = Date.now() + 3500;
  while (local.row(shared).communicationObservedAt === observedAt && Date.now() < observationDeadline) await new Promise(done => setTimeout(done, 25));
  assert.notEqual(local.row(shared).communicationObservedAt, observedAt, 'a healthy shared child must complete another observation tick before apply');
  refused(await scene.call(path('groups', imported.group.id, 'apply'), { reviewId: review.reviewId, accepted: true, stopOwned: false }));
  assert.equal(exclusiveHandle.exit, null); assert.equal(sharedHandle.exit, null);
  await apply(scene, 'groups', imported.group.id, review, { stopOwned: true });
  assert.ok(exclusiveHandle.exit); assert.equal(local.records.has(exclusive), false); assert.equal(sharedHandle.exit, null);
  assert.equal(local.handles.get(shared), sharedHandle); assert.equal(local.row(shared).state, 'running');
  assert.equal(scene.hub.snapshot().bridges.length, 1);
  await importModule(scene, await moduleSource(scene, 'probe', '1.0.0'), 'probe'); okay(await scene.call('/manage/api/programs/probe/start', {}));
  const observed = () => sharedHandle.stdout.split('\n').some(line => { try { const event = JSON.parse(line); return event.event === 'received' && event.body.member === 'probe'; } catch { return false; } });
  const deadline = Date.now() + 5000; while (!observed() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(observed(), sharedHandle.stdout); assert.equal(scene.hub.snapshot().bridges.length, 2);
});

test('management uninstall: stale group and module reviews cannot unregister changed targets', async t => {
  const scene = await setup(t); await importModule(scene, await moduleSource(scene, 'source', '1.0.0'), 'source');
  const current = await group(scene, 'selected', ['source']), staleGroup = await preview(scene, 'groups', current.id);
  okay(await scene.call('/manage/api/groups/save', { expectedRevision: current.revision, group: { ...current, title: 'Changed after review' } }));
  refused(await scene.call(path('groups', current.id, 'apply'), { reviewId: staleGroup.reviewId, accepted: true, stopOwned: true }));
  assert.ok(scene.owner.localPrograms.groups.has(current.id)); assert.ok(scene.owner.localPrograms.records.has('source'));
  const staleModule = await preview(scene, 'modules', 'source');
  const configuration = okay(await scene.call('/manage/api/programs/source/configuration/preview', { settings: { label: 'Changed after review' }, expectedRevision: scene.owner.localPrograms.public(scene.owner.localPrograms.row('source')).configurationRevision }));
  okay(await scene.call('/manage/api/programs/source/configuration/apply', { reviewId: configuration.reviewId, accepted: true }));
  refused(await scene.call(path('modules', 'source', 'apply'), { reviewId: staleModule.reviewId, accepted: true, stopOwned: true }));
  assert.ok(scene.owner.localPrograms.records.has('source'));
});

test('management uninstall: invalid CSRF and missing review acceptance never remove registrations', async t => {
  const scene = await setup(t); await importModule(scene, await moduleSource(scene, 'source', '1.0.0'), 'source');
  const response = await fetch(scene.base + path('modules', 'source', 'preview'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-management-token': 'invalid' }, body: '{}' });
  assert.equal(response.status, 403); const review = await preview(scene, 'modules', 'source');
  refused(await scene.call(path('modules', 'source', 'apply'), { reviewId: review.reviewId, stopOwned: true }));
  assert.ok(scene.owner.localPrograms.records.has('source')); await apply(scene, 'modules', 'source', review);
});

test('management uninstall: a failed registry commit restores the entire group, all registrations and startup plans', async t => {
  const scene = await setup(t), imported = await importGroup(scene, await groupSource(scene, '1.0.0', ['first', 'second']));
  const local = scene.owner.localPrograms, ids = imported.group.memberProgramIds; await configurePlan(scene, ids);
  const before = { records: structuredClone([...local.records]), identities: structuredClone([...local.identities]), groups: structuredClone([...local.groups]), plan: structuredClone(local.startupPlanData) };
  const review = await preview(scene, 'groups', imported.group.id), save = local.save;
  local.save = async () => { throw new Error('fixture registry write failure'); };
  try { refused(await scene.call(path('groups', imported.group.id, 'apply'), { reviewId: review.reviewId, accepted: true, stopOwned: true })); }
  finally { local.save = save; }
  assert.deepEqual([...local.records], before.records); assert.deepEqual([...local.identities], before.identities);
  assert.deepEqual([...local.groups], before.groups); assert.deepEqual(local.startupPlanData, before.plan);
  await scene.reload(); assert.deepEqual([...scene.owner.localPrograms.groups], before.groups);
  assert.deepEqual([...scene.owner.localPrograms.records.keys()], ids);
});

test('management uninstall: interrupted version guards and unknown process ownership prevent destructive unregister operations', async t => {
  const scene = await setup(t); await importModule(scene, await moduleSource(scene, 'source', '1.0.0'), 'source');
  const local = scene.owner.localPrograms;
  await importModule(scene, await moduleSource(scene, 'foreign', '1.0.0'), 'foreign');
  await writeFile(local.path('source', 'version-transaction.json'), json({ transactionId: 'interrupted-fixture' }));
  const pending = await preview(scene, 'modules', 'source'); assert.equal(pending.review.blocked, true);
  assert.ok(pending.review.blockers.some(row => row.code === 'VERSION_RECOVERY_REQUIRED'));
  refused(await scene.call(path('modules', 'source', 'apply'), { reviewId: pending.reviewId, accepted: true, stopOwned: true }));
  // A second ordinary instance carries a live unrelated PID but no owned handle.
  const foreign = local.row('foreign'); local.records.set('foreign', { ...foreign, state: 'unknown', pid: process.pid }); await local.save();
  const review = await preview(scene, 'modules', 'foreign'); assert.ok(review.review.blocked);
  refused(await scene.call(path('modules', 'foreign', 'apply'), { reviewId: review.reviewId, accepted: true, stopOwned: true }));
  assert.equal(local.row('foreign').pid, process.pid); assert.equal(local.row('foreign').state, 'unknown'); assert.ok(local.records.has('source'));
});

test('management uninstall: an explicit empty group selection removes only the group without stopping or unregistering its modules', async t => {
  const scene = await setup(t), imported = await importGroup(scene, await groupSource(scene, '1.0.0', ['first']));
  const local = scene.owner.localPrograms, [id] = imported.group.memberProgramIds;
  okay(await scene.call(`/manage/api/programs/${id}/start`, {})); const handle = local.handles.get(id);
  const review = await preview(scene, 'groups', imported.group.id, { programIds: [] });
  assert.deepEqual(review.review.programIds, []); assert.deepEqual(review.review.requiresStop, []);
  await apply(scene, 'groups', imported.group.id, review);
  assert.equal(local.groups.has(imported.group.id), false); assert.ok(local.records.has(id));
  assert.equal(local.handles.get(id), handle); assert.equal(handle.exit, null); assert.equal(scene.hub.snapshot().bridges.length, 1);
});

test('management uninstall: final save failure after an authorized stop retains registrations without resurrecting exited children', async t => {
  const scene = await setup(t), imported = await importGroup(scene, await groupSource(scene, '1.0.0', ['first', 'second']));
  const local = scene.owner.localPrograms, ids = imported.group.memberProgramIds;
  for (const id of ids) okay(await scene.call(`/manage/api/programs/${id}/start`, {}));
  const handles = ids.map(id => local.handles.get(id)), before = structuredClone([...local.groups]);
  const review = await preview(scene, 'groups', imported.group.id), save = local.save;
  local.save = async function () { if (ids.some(id => !this.records.has(id))) throw new Error('fixture final unregister write failure'); return save.call(this); };
  try {
    const failed = refused(await scene.call(path('groups', imported.group.id, 'apply'), { reviewId: review.reviewId, accepted: true, stopOwned: true }));
    assert.equal(failed.error.code, 'UNINSTALL_SAVE_FAILED');
  } finally { local.save = save; }
  assert.deepEqual([...local.groups], before);
  for (const [index, id] of ids.entries()) { assert.ok(local.records.has(id)); assert.equal(local.row(id).state, 'stopped'); assert.equal(local.handles.get(id), handles[index]); assert.ok(handles[index].exit); }
  assert.equal(scene.hub.snapshot().bridges.length, 0);
  await scene.reload(); assert.deepEqual([...scene.owner.localPrograms.groups], before);
  for (const id of ids) assert.equal(scene.owner.localPrograms.row(id).state, 'stopped');
});
