import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateModuleGroup } from '../../../scripts/runtime/module-group.mjs';
import { executionPolicy, executionPolicyRevision } from '../../../tools/launcher/execution-policy.mjs';
import { json, setup, okay, refused, preview, apply, rollbackPreview, moduleSource, importModule, groupSource, importGroup } from '../../helpers/module-versions-scene.mjs';

async function defaults(directory, value) {
  const path = join(directory, 'deployment.json'), deployment = JSON.parse(await readFile(path, 'utf8'));
  deployment.executionDefaults = value; await writeFile(path, json(deployment));
}
async function saveGroup(source) { await writeFile(join(source.directory, 'module-group.json'), json(source.manifest)); }
const policy = (mode, idleTimeoutMs = 60000, allowedCallers = []) => ({ mode, idleTimeoutMs, allowedCallers });

test('author execution defaults: module review discloses and registers exact defaults without granting wake callers or starting', async t => {
  const scene = await setup(t), source = await moduleSource(scene, 'authored', '1.0.0');
  await defaults(source.directory, { mode: 'on-demand', idleTimeoutMs: 17000 });
  const reviewed = okay(await scene.call('/manage/api/artifacts/preview', { path: source.directory, programId: 'authored' }));
  assert.deepEqual(reviewed.review.executionPolicy, policy('on-demand', 17000));
  assert.equal(reviewed.review.executionPolicySource, 'module');
  const installed = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: reviewed.reviewId, accepted: true,
    executionDefaults: { mode: 'resident', idleTimeoutMs: 1000, allowedCallers: ['intruder'] } }));
  assert.deepEqual(installed.program.executionPolicy, policy('on-demand', 17000));
  assert.equal(installed.program.state, 'stopped'); assert.equal(scene.owner.localPrograms.handles.size, 0);
  await scene.reload();
  assert.deepEqual(executionPolicy(scene.owner.localPrograms.row('authored')), policy('on-demand', 17000));
});

test('author execution defaults: absent defaults remain system resident; omitted author timeout means 60 seconds', async t => {
  const scene = await setup(t), plain = await moduleSource(scene, 'plain', '1.0.0'), demand = await moduleSource(scene, 'demand', '1.0.0');
  await defaults(demand.directory, { mode: 'on-demand' });
  for (const [source, id, expected, origin] of [[plain, 'plain', policy('resident'), 'system'], [demand, 'demand', policy('on-demand'), 'module']]) {
    const reviewed = okay(await scene.call('/manage/api/artifacts/preview', { path: source.directory, programId: id }));
    assert.equal(reviewed.review.executionPolicySource, origin); assert.deepEqual(reviewed.review.executionPolicy, expected);
    const result = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: reviewed.reviewId, accepted: true }));
    assert.deepEqual(result.program.executionPolicy, expected);
  }
});

test('author execution defaults: an import body cannot impersonate the reviewed author defaults', async t => {
  const scene = await setup(t), source = await moduleSource(scene, 'forged', '1.0.0');
  await defaults(source.directory, { mode: 'resident', idleTimeoutMs: 18000 });
  const result = refused(await scene.call('/manage/api/artifacts/preview', { path: source.directory, programId: 'forged', executionDefaults: { mode: 'on-demand' } }));
  assert.equal(result.error.code, 'LOCAL_EXECUTION_DEFAULTS_SOURCE_REQUIRED');
  assert.equal(scene.owner.localPrograms.records.size, 0);
});

test('author execution defaults: reviewed source changes cannot silently change the initial policy', async t => {
  const scene = await setup(t), source = await moduleSource(scene, 'review-change', '1.0.0');
  await defaults(source.directory, { mode: 'on-demand', idleTimeoutMs: 3000 });
  const reviewed = okay(await scene.call('/manage/api/artifacts/preview', { path: source.directory, programId: 'review-change' }));
  await defaults(reviewed.review.directory, { mode: 'resident', idleTimeoutMs: 99000 });
  const result = refused(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: reviewed.reviewId, accepted: true }));
  assert.equal(result.error.code, 'LOCAL_REVIEW_CHANGED'); assert.equal(scene.owner.localPrograms.records.has('review-change'), false);
});

test('author execution defaults: group override precedes module defaults and registration uses the reviewed member policies', async t => {
  const scene = await setup(t), source = await groupSource(scene, '1.0.0', ['override', 'inherited', 'fallback']);
  await defaults(join(source.directory, 'modules/override'), { mode: 'resident', idleTimeoutMs: 8000 });
  await defaults(join(source.directory, 'modules/inherited'), { mode: 'on-demand', idleTimeoutMs: 19000 });
  source.manifest.modules[0].configuration.executionDefaults = { mode: 'on-demand', idleTimeoutMs: 23000 }; await saveGroup(source);
  const reviewed = okay(await scene.call('/manage/api/artifacts/preview', { path: source.directory }));
  const expected = [policy('on-demand', 23000), policy('on-demand', 19000), policy('resident')];
  assert.deepEqual(reviewed.review.members.map(member => member.review.executionPolicy), expected);
  assert.deepEqual(reviewed.review.members.map(member => member.review.executionPolicySource), ['module-group', 'module', 'system']);
  const result = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module-group', reviewId: reviewed.reviewId, accepted: true }));
  assert.deepEqual(result.programs.map(program => program.executionPolicy), expected);
  assert.ok(result.programs.every(program => program.state === 'stopped')); assert.equal(scene.owner.localPrograms.handles.size, 0);
});

test('author execution defaults: group recipes reject caller authorization and malformed execution defaults', async t => {
  const scene = await setup(t), source = await groupSource(scene, '1.0.0', ['first']);
  for (const value of [null, {}, { mode: 'unknown' }, { mode: 'on-demand', allowedCallers: [] }, { mode: 'resident', idleTimeoutMs: 999 }, { mode: 'on-demand', idleTimeoutMs: 1000.5 }]) {
    const manifest = structuredClone(source.manifest); manifest.modules[0].configuration.executionDefaults = value;
    assert.throws(() => validateModuleGroup(manifest));
  }
  source.manifest.modules[0].configuration.executionDefaults = { mode: 'on-demand', allowedCallers: ['author-selected-local-id'] }; await saveGroup(source);
  refused(await scene.call('/manage/api/artifacts/preview', { path: source.directory }));
  assert.equal(scene.owner.localPrograms.records.size, 0);
});

test('author execution defaults: updates and rollbacks retain current local policies while added members receive author defaults', async t => {
  const scene = await setup(t), first = await groupSource(scene, '1.0.0', ['kept', 'peer']);
  await defaults(join(first.directory, 'modules/kept'), { mode: 'on-demand', idleTimeoutMs: 7000 });
  const imported = await importGroup(scene, first), id = imported.group.id, mapping = imported.group.origin.members;
  const local = scene.owner.localPrograms, original = local.row(mapping.kept);
  await local.saveExecutionPolicy(original.programId, { expectedRevision: executionPolicyRevision(original), policy: policy('resident', 12000, [mapping.peer]) });
  const next = await groupSource(scene, '2.0.0', ['kept', 'peer', 'new-group', 'new-module']);
  next.manifest.modules.find(member => member.id === 'kept').configuration.executionDefaults = { mode: 'on-demand', idleTimeoutMs: 1000 };
  next.manifest.modules.find(member => member.id === 'new-group').configuration.executionDefaults = { mode: 'on-demand', idleTimeoutMs: 24000 };
  await defaults(join(next.directory, 'modules/new-module'), { mode: 'on-demand', idleTimeoutMs: 25000 }); await saveGroup(next);
  const reviewed = await preview(scene, 'groups', id, next.directory, { configurationPolicy: 'author' });
  const keptReview = reviewed.review.programs.find(program => program.programId === mapping.kept);
  assert.deepEqual(keptReview.executionPolicy, policy('resident', 12000, [mapping.peer])); assert.equal(keptReview.executionPolicySource, 'local');
  assert.deepEqual(reviewed.review.programs.filter(program => program.change === 'add').map(program => program.executionPolicy), [policy('on-demand', 24000), policy('on-demand', 25000)]);
  assert.deepEqual(reviewed.review.programs.filter(program => program.change === 'add').map(program => program.executionPolicySource), ['module-group', 'module']);
  const updated = await apply(scene, 'groups', id, reviewed);
  assert.deepEqual(executionPolicy(local.row(mapping.kept)), policy('resident', 12000, [mapping.peer]));
  await local.saveExecutionPolicy(mapping.kept, { expectedRevision: executionPolicyRevision(local.row(mapping.kept)), policy: policy('on-demand', 33000) });
  const rollback = await rollbackPreview(scene, 'groups', id, updated.transactionId);
  assert.deepEqual(rollback.review.programs.find(program => program.programId === mapping.kept).executionPolicy, policy('on-demand', 33000));
  await apply(scene, 'groups', id, rollback);
  assert.deepEqual(executionPolicy(local.row(mapping.kept)), policy('on-demand', 33000));
});

test('author execution defaults: author-configuration updates never apply new defaults to a pre-policy local instance', async t => {
  const scene = await setup(t), first = await moduleSource(scene, 'old-row', '1.0.0'), next = await moduleSource(scene, 'old-row', '2.0.0');
  await importModule(scene, first, 'old-row');
  const row = scene.owner.localPrograms.row('old-row'); delete row.executionPolicy; await scene.owner.localPrograms.save();
  await defaults(next.directory, { mode: 'on-demand', idleTimeoutMs: 9000 });
  const reviewed = await preview(scene, 'modules', 'old-row', next.directory, { configurationPolicy: 'author' });
  assert.deepEqual(reviewed.review.programs[0].executionPolicy, policy('resident'));
  await apply(scene, 'modules', 'old-row', reviewed);
  assert.deepEqual(executionPolicy(scene.owner.localPrograms.row('old-row')), policy('resident'));
});

test('author execution defaults: explicit group export includes execution defaults but excludes all local caller grants', async t => {
  const scene = await setup(t), source = await groupSource(scene, '1.0.0', ['callee', 'caller']);
  const imported = await importGroup(scene, source), group = imported.group, mapping = group.origin.members, local = scene.owner.localPrograms;
  await local.saveExecutionPolicy(mapping.callee, { expectedRevision: executionPolicyRevision(local.row(mapping.callee)), policy: policy('on-demand', 49000, [mapping.caller]) });
  const result = okay(await scene.call(`/manage/api/groups/${group.id}/export`, { expectedRevision: group.revision, destination: join(scene.root, 'exported'),
    version: '2.0.0', redistributionAcknowledged: true }));
  const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8'));
  const manifest = JSON.parse(Buffer.from(artifact.files.find(file => file.path === 'module-group.json').base64, 'base64').toString('utf8'));
  assert.deepEqual(manifest.modules.find(member => member.id === 'callee').configuration.executionDefaults, { mode: 'on-demand', idleTimeoutMs: 49000 });
  assert.deepEqual(manifest.modules.find(member => member.id === 'caller').configuration.executionDefaults, { mode: 'resident', idleTimeoutMs: 60000 });
  assert.equal(JSON.stringify(manifest).includes('allowedCallers'), false); assert.equal(JSON.stringify(manifest).includes(mapping.caller), false);
  const reimported = await importGroup(scene, { directory: result.artifactPath });
  assert.deepEqual(reimported.programs.find(program => program.programId === reimported.group.origin.members.callee).executionPolicy, policy('on-demand', 49000));
});
