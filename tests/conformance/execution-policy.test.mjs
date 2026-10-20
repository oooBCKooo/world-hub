import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_EXECUTION_POLICY, executionPolicy, executionPolicyRevision, validateExecutionPolicy } from '../../tools/launcher/execution-policy.mjs';
import { configurationRevision } from '../../tools/launcher/program-configuration.mjs';
import { setup, moduleSource, importModule, preview, apply, rollbackPreview } from '../helpers/module-versions-scene.mjs';

const policy = (mode = 'on-demand', allowedCallers = [], idleTimeoutMs = 60000) => ({ mode, idleTimeoutMs, allowedCallers });
const savePolicy = (local, id, next) => local.saveExecutionPolicy(id, { expectedRevision: executionPolicyRevision(local.row(id)), policy: next });
async function pair(t) {
  const scene = await setup(t), source = await moduleSource(scene, 'execution', '1.0.0');
  await importModule(scene, source, 'resident'); await importModule(scene, source, 'demand');
  return { scene, local: scene.owner.localPrograms, source };
}
function plan(ids, after = {}) {
  return { members: ids.map(programId => ({ programId, enabled: true, after: after[programId] ?? [] })), startupOrder: ids, onFailure: 'continue-independent' };
}

test('execution policy: defaults are detached values, canonical revisions bind instance identity', () => {
  const first = executionPolicy({ programId: 'first' }); first.allowedCallers.push('other');
  assert.deepEqual(executionPolicy({}), DEFAULT_EXECUTION_POLICY);
  assert.notEqual(executionPolicyRevision({ programId: 'first' }), executionPolicyRevision({ programId: 'second' }));
  assert.equal(executionPolicyRevision({ programId: 'first', executionPolicy: policy('on-demand', ['b', 'a']) }),
    executionPolicyRevision({ programId: 'first', executionPolicy: policy('on-demand', ['a', 'b']) }));
});

test('execution policy: rejects malformed modes, timeouts and caller identities without trusting author fields', () => {
  const context = { targetId: 'target', knownIds: ['target', 'caller'] };
  for (const value of [null, [], {}, { ...policy(), mode: 'automatic' }, policy('on-demand', [], 999), policy('on-demand', [], 86400001),
    policy('on-demand', [], 1000.5), policy('on-demand', ['caller', 'caller']), policy('on-demand', ['target']),
    policy('on-demand', ['missing']), policy('on-demand', ['unsafe/id']), { ...policy(), autoStart: true }]) {
    assert.throws(() => validateExecutionPolicy(value, context), { code: 'EXECUTION_POLICY_INVALID', status: 409 });
  }
  assert.deepEqual(validateExecutionPolicy(policy('on-demand', ['caller'], 1000), context), policy('on-demand', ['caller'], 1000));
  assert.throws(() => validateExecutionPolicy(policy(), { targetId: 'missing', knownIds: ['target'] }), { code: 'EXECUTION_POLICY_INVALID' });
});

test('execution policy: CAS metadata persists without launching, source changes, private token leakage or caller grant defaults', async t => {
  const { scene, local, source } = await pair(t), row = local.row('demand'), before = configurationRevision(row), identity = structuredClone(local.identities.get('demand'));
  const stale = executionPolicyRevision(row), saved = await savePolicy(local, 'demand', policy('on-demand', ['resident'], 2000));
  assert.equal(saved.startsModules, false); assert.equal(saved.stopsModules, false); assert.equal(saved.localOnly, true);
  assert.deepEqual(saved.program.executionPolicy, policy('on-demand', ['resident'], 2000));
  assert.notEqual(before, configurationRevision(row)); assert.strictEqual(local.row('demand'), row);
  assert.deepEqual(local.identities.get('demand'), identity); assert.equal(local.handles.size, 0);
  assert.equal(JSON.stringify(saved).includes(identity.token), false);
  await assert.rejects(local.saveExecutionPolicy('demand', { expectedRevision: stale, policy: policy('resident') }), { code: 'EXECUTION_POLICY_CHANGED' });
  await assert.rejects(local.configurationPreview('demand', { expectedRevision: configurationRevision(row), executionPolicy: policy('resident') }), { code: 'LOCAL_CONFIGURATION_INVALID' });
  const disk = JSON.parse(await readFile(join(local.directory, 'registry.json'), 'utf8'));
  assert.deepEqual(disk.programs.find(item => item.programId === 'demand').executionPolicy, policy('on-demand', ['resident'], 2000));
  assert.deepEqual(JSON.parse(await readFile(join(source.directory, 'deployment.json'), 'utf8')).executionPolicy, undefined);
});

test('execution policy: save failure restores the original live record object and version guards cover target and callers', async t => {
  const { local } = await pair(t), row = local.row('demand'), originalSave = local.save, originalGuard = local.versionRecoveryGuard;
  local.save = async () => { throw Object.assign(new Error('fixture save denied'), { code: 'EACCES' }); };
  for (const explicit of [true, false]) {
    if (!explicit) delete row.executionPolicy;
    const previous = row.executionPolicy;
    await assert.rejects(savePolicy(local, 'demand', policy('on-demand', ['resident'])), { code: 'EACCES' });
    assert.strictEqual(local.row('demand'), row); assert.deepEqual(executionPolicy(row), DEFAULT_EXECUTION_POLICY);
    assert.equal(Object.hasOwn(row, 'executionPolicy'), explicit); assert.strictEqual(row.executionPolicy, previous);
  }
  local.save = originalSave;
  const observed = [];
  local.versionRecoveryGuard = async id => { observed.push(id); if (id === 'resident') throw Object.assign(new Error('recover caller first'), { code: 'VERSION_RECOVERY_REQUIRED' }); };
  await assert.rejects(savePolicy(local, 'demand', policy('on-demand', ['resident'])), { code: 'VERSION_RECOVERY_REQUIRED' });
  assert.deepEqual(observed, ['demand', 'resident']); assert.deepEqual(executionPolicy(row), DEFAULT_EXECUTION_POLICY);
  local.versionRecoveryGuard = originalGuard;
});

test('execution policy: startup review skips on-demand without editing enabled, exact order or independent manual start', async t => {
  const { scene, local } = await pair(t);
  await savePolicy(local, 'demand', policy('on-demand', ['resident']));
  const supplied = plan(['resident', 'demand']), review = await local.reviewStartupPlan({ planData: supplied });
  assert.deepEqual(review.review.order, ['resident']); assert.deepEqual(review.review.plan.members, supplied.members);
  assert.deepEqual(review.review.plan.startupOrder, ['resident', 'demand']);
  assert.deepEqual(review.review.skipped, [{ programId: 'demand', reason: 'on-demand' }]);
  const started = await local.startStartupPlan({ reviewId: review.reviewId, accepted: true, planData: supplied });
  assert.deepEqual(started.order, ['resident']); assert.equal(local.row('resident').state, 'running');
  assert.equal(local.row('demand').state, 'stopped'); assert.equal(local.handles.has('demand'), false);
  const direct = await local.reviewStart('demand'); await local.start('demand', { reviewId: direct.reviewId, accepted: true, startReason: 'demand' });
  assert.equal(local.row('demand').state, 'running');
  const lifetime = scene.owner.demandLifecycle.state('demand').programs[0];
  assert.equal(lifetime.pinned, true); assert.equal(lifetime.autoStarted, false);
  const owned = local.handles.get('resident'), runId = local.row('resident').runId;
  await savePolicy(local, 'resident', policy('on-demand'));
  assert.strictEqual(local.handles.get('resident'), owned); assert.equal(owned.exit, null); assert.equal(local.row('resident').runId, runId);
  assert.equal(local.row('resident').state, 'running');
  assert.deepEqual(local.getStartupPlan().members.map(item => item.enabled), [false, false]);
});

test('execution policy: resident prerequisite on demand is blocked without auto-start and group scope uses the same instance policy', async t => {
  const { scene, local } = await pair(t); await savePolicy(local, 'demand', policy());
  const supplied = plan(['demand', 'resident'], { resident: ['demand'] });
  const { group } = await scene.owner.moduleGroups.save({ group: { id: 'mixed', title: 'Mixed lifecycle', memberProgramIds: ['resident', 'demand'], startupPlan: supplied } });
  const reviewed = await scene.owner.moduleGroups.reviewStart({ groupId: group.id, expectedRevision: group.revision });
  assert.deepEqual(reviewed.review.order, ['resident']); assert.equal(reviewed.review.members.find(item => item.programId === 'demand').skipped, 'on-demand');
  const result = await scene.owner.moduleGroups.applyStart({ reviewId: reviewed.reviewId, accepted: true });
  assert.deepEqual(result.results, [{ programId: 'resident', state: 'blocked', blockedBy: ['demand'] }]);
  assert.equal(local.handles.size, 0); assert.equal(local.row('demand').state, 'stopped');
  assert.deepEqual(local.groups.get('mixed').startupPlan, group.startupPlan);
  assert.deepEqual(local.groups.get('mixed').startupPlan.startupOrder, supplied.startupOrder);
});

test('execution policy: changing any reviewed instance mode invalidates a previous startup review before creating a child', async t => {
  const { local } = await pair(t), supplied = plan(['resident', 'demand']);
  const reviewed = await local.reviewStartupPlan({ planData: supplied });
  await savePolicy(local, 'demand', policy());
  await assert.rejects(local.startStartupPlan({ reviewId: reviewed.reviewId, accepted: true, planData: supplied }), { code: 'LOCAL_STARTUP_PLAN_CHANGED' });
  assert.equal(local.handles.size, 0);
  const next = await local.reviewStartupPlan({ planData: supplied });
  await savePolicy(local, 'demand', policy('on-demand', ['resident']));
  await assert.rejects(local.startStartupPlan({ reviewId: next.reviewId, accepted: true, planData: supplied }), { code: 'LOCAL_STARTUP_PLAN_CHANGED' });
  assert.equal(local.handles.size, 0);
});

test('execution policy: author updates retain local authorization and rollback retains current policy instead of old caller grants', async t => {
  const { scene, local } = await pair(t), v2 = await moduleSource(scene, 'execution', '2.0.0');
  await savePolicy(local, 'demand', policy('on-demand', ['resident'], 3000));
  const update = await preview(scene, 'modules', 'demand', v2.directory, { configurationPolicy: 'author' });
  assert.deepEqual(update.review.programs[0].executionPolicy, policy('on-demand', ['resident'], 3000));
  const upgraded = await apply(scene, 'modules', 'demand', update);
  assert.deepEqual(executionPolicy(local.row('demand')), policy('on-demand', ['resident'], 3000));
  await savePolicy(local, 'demand', policy('resident', [], 1000));
  const rollback = await rollbackPreview(scene, 'modules', 'demand', upgraded.transactionId);
  assert.deepEqual(rollback.review.programs[0].executionPolicy, policy('resident', [], 1000));
  await apply(scene, 'modules', 'demand', rollback);
  assert.equal(local.row('demand').module.version, '1.0.0');
  assert.deepEqual(executionPolicy(local.row('demand')), policy('resident', [], 1000));
});
