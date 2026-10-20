import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalPrograms } from '../../../tools/launcher/local-programs.mjs';
import { ModuleGroups, normalizeModuleGroup } from '../../../tools/launcher/module-groups.mjs';
import { inspectDeployment } from '../../../scripts/runtime/deployment.mjs';
import { workspace, ROOT, environment } from '../launcher/helpers.mjs';
async function setup(t) {
  const app = await workspace(t), programs = new LocalPrograms({ root: app.root, environment, inspectDeployment, updateCredentials: async () => {} });
  await programs.initialize(); app.cleanups.push(() => programs.close());
  for (const id of ['one', 'two', 'outside']) {
    const preview = await programs.preview({ programId: id, directory: join(ROOT, 'examples/ecosystem-pack/modules/source') });
    await programs.register({ reviewId: preview.reviewId, accepted: true });
  }
  return { app, programs, groups: new ModuleGroups({ localPrograms: programs }) };
}
const plan = (ids, enabled = ids) => ({ members: ids.map(programId => ({ programId, enabled: enabled.includes(programId), after: [] })), startupOrder: ids, onFailure: 'continue-independent' });

test('module groups persist references without copying process, identity, Hub or credentials, and deletion leaves members', async t => {
  const { app, programs, groups } = await setup(t);
  const identities = [...programs.identities], first = (await groups.save({ group: { id: 'first', title: 'First', memberProgramIds: ['one', 'two'], startupPlan: plan(['one', 'two'], ['two']) } })).group;
  await groups.save({ group: { id: 'second', title: 'Second', memberProgramIds: ['one'] } });
  assert.deepEqual([...programs.identities], identities); assert.equal(programs.handles.size, 0);
  const saved = JSON.parse(await readFile(join(programs.directory, 'registry.json'), 'utf8'));
  assert.equal(saved.groups.length, 2); assert.equal(saved.assembly, undefined);
  assert.ok(saved.groups.every(group => !Object.hasOwn(group, 'token') && !Object.hasOwn(group, 'hub') && !Object.hasOwn(group, 'processes')));
  const reopened = new LocalPrograms({ root: app.root, environment, inspectDeployment, updateCredentials: async () => {} }); await reopened.initialize();
  assert.equal(reopened.groups.get('first').revision, first.revision); await reopened.close();
  await assert.rejects(groups.save({ group: { ...first, title: 'Changed' }, expectedRevision: 'stale' }), { code: 'MODULE_GROUP_CHANGED' });
  await assert.rejects(programs.remove('one'), { code: 'LOCAL_PROGRAM_IN_GROUP' });
  await groups.remove({ groupId: 'first', expectedRevision: first.revision });
  assert.ok(programs.records.has('one')); assert.ok(programs.records.has('two'));
});

test('group startup reviews only enabled members and exact saved order; outside prerequisites are never auto-started', async t => {
  const { programs, groups } = await setup(t);
  const group = (await groups.save({ group: { id: 'selected', title: 'Selected', memberProgramIds: ['one', 'two'], startupPlan: plan(['two', 'one'], ['one']) } })).group;
  const review = await groups.reviewStart({ groupId: group.id, expectedRevision: group.revision });
  assert.deepEqual(review.review.order, ['one']); assert.equal(review.review.groupId, 'selected');
  assert.equal(review.review.members.find(row => row.programId === 'two').execution, undefined);
  assert.ok(!review.review.members.some(row => row.programId === 'outside'));
  assert.throws(() => normalizeModuleGroup({ ...group, startupPlan: { ...plan(['one', 'two']), members: [{ programId: 'one', enabled: true, after: ['outside'] }] } }, [...programs.records.keys()]), /prerequisites/);
  const edited = await groups.save({ group: { ...group, title: 'Changed' }, expectedRevision: group.revision });
  assert.notEqual(edited.group.revision, group.revision);
  assert.throws(() => groups.applyStart({ reviewId: review.reviewId, accepted: true }), { code: 'MODULE_GROUP_CHANGED' });
});

test('shared stop requires exact review and explicit member choices and never stops the shared Hub', async t => {
  const { programs, groups } = await setup(t);
  const first = (await groups.save({ group: { id: 'first', title: 'First', memberProgramIds: ['one', 'two'] } })).group;
  await groups.save({ group: { id: 'second', title: 'Second', memberProgramIds: ['one', 'outside'] } });
  programs.row('outside').bindings = [{ providerId: 'one', contract: { id: 'text.read', version: '1.0.0' } }];
  let review = await groups.stopPreview({ groupId: 'first', expectedRevision: first.revision });
  assert.equal(review.review.stopsHub, false);
  assert.equal(review.review.programs.find(row => row.programId === 'one').sharedWithGroups[0].id, 'second');
  assert.equal(review.review.programs.find(row => row.programId === 'one').consumers[0].programId, 'outside');
  await assert.rejects(groups.applyStop({ reviewId: review.reviewId, accepted: true }), { code: 'MODULE_GROUP_STOP_SELECTION_REQUIRED' });
  await assert.rejects(groups.applyStop({ reviewId: review.reviewId, accepted: true, programIds: ['outside'] }), { code: 'MODULE_GROUP_STOP_SELECTION_REQUIRED' });
  const stopped = [], stopNow = programs.stopNow; programs.stopNow = async id => { stopped.push(id); return { program: { state: 'stopped' } }; };
  const result = await groups.applyStop({ reviewId: review.reviewId, accepted: true, programIds: ['two'] });
  programs.stopNow = stopNow;
  assert.deepEqual(stopped, ['two']); assert.equal(result.stopsHub, false); assert.ok(!stopped.includes('one'));
  review = await groups.stopPreview({ groupId: 'first', expectedRevision: first.revision });
  programs.row('one').state = 'running';
  await assert.rejects(groups.applyStop({ reviewId: review.reviewId, accepted: true, programIds: ['one'] }), { code: 'MODULE_GROUP_CHANGED' });
  programs.row('one').state = 'stopped';
  review = await groups.stopPreview({ groupId: 'first', expectedRevision: first.revision });
  programs.row('outside').settings.text = 'Consumer configuration changed while reviewing';
  await assert.rejects(groups.applyStop({ reviewId: review.reviewId, accepted: true, programIds: ['one'] }), { code: 'MODULE_GROUP_CHANGED' });
  review = await groups.stopPreview({ groupId: 'first', expectedRevision: first.revision });
  programs.closing = true;
  await assert.rejects(groups.applyStop({ reviewId: review.reviewId, accepted: true, programIds: ['one'] }), { code: 'LAUNCHER_STOPPING' });
  await assert.rejects(groups.remove({ groupId: 'first', expectedRevision: first.revision }), { code: 'LAUNCHER_STOPPING' });
  programs.closing = false;
});

test('stopping the shared Hub cancels a queued group start before acquiring any process', async t => {
  const { programs, groups } = await setup(t);
  const group = (await groups.save({ group: { id: 'queued', title: 'Queued', memberProgramIds: ['one'], startupPlan: plan(['one']) } })).group;
  const review = await groups.reviewStart({ groupId: group.id, expectedRevision: group.revision });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  void programs.enqueue(() => blocked);
  const start = groups.applyStart({ reviewId: review.reviewId, accepted: true });
  programs.pauseStarts(); release();
  await assert.rejects(start, { code: 'START_STOPPED' });
  assert.equal(programs.handles.size, 0); assert.equal(programs.row('one').state, 'stopped');
  programs.resumeStarts();
});
