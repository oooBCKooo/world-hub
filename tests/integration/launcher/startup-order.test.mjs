import test from 'node:test';
import assert from 'node:assert/strict';
import { startupPlan, publicStartupPlan, STARTUP_PLAN_FORMAT } from '../../../tools/launcher/startup-plan.mjs';

const ids = ['first','second','manual'];
const plan = () => ({ members: ids.map(programId => ({ programId, enabled: programId !== 'manual', after: [] })), onFailure: 'continue-independent' });

test('Global plan exact execution order survives normalization and public serialization including disabled members', () => {
  const value = { ...plan(), startupOrder: ['second','manual','first'] }, normalized = startupPlan(value, ids);
  assert.deepEqual(normalized.order, ['second','first']);
  assert.deepEqual(normalized.startupOrder, ['second','manual','first']);
  const serialized = publicStartupPlan(value, ids);
  assert.equal(serialized.format, STARTUP_PLAN_FORMAT); assert.equal(Object.hasOwn(serialized, 'order'), false);
  assert.deepEqual(serialized.startupOrder, value.startupOrder);
  assert.deepEqual(startupPlan(serialized, ids), normalized);
  assert.notEqual(normalized.revision, startupPlan({ ...plan(), startupOrder: ids }, ids).revision);
});

test('Global exact order rejects incomplete/duplicate/unknown lists and precedence conflicts involving disabled members', () => {
  for (const startupOrder of [['first','second'], ['first','first','manual'], ['first','second','unknown'], null, undefined])
    assert.throws(() => startupPlan({ ...plan(), startupOrder }, ids), error => error.code === 'STARTUP_ORDER_INVALID');
  const value = plan(); value.members[0].after = ['manual']; value.startupOrder = ['first','second','manual'];
  assert.throws(() => startupPlan(value, ids), error => error.code === 'STARTUP_ORDER_INVALID' && /manual.*first/.test(error.message));
  value.startupOrder = ['manual','second','first']; assert.deepEqual(startupPlan(value, ids).order, ['second','first']);
});

test('Global omitted exact order preserves graph-derived defaults without selecting prerequisites', () => {
  const value = plan(); value.members[0].after = ['manual'];
  const normalized = startupPlan(value, ids);
  assert.deepEqual(normalized.order, ['first','second']);
  assert.equal(normalized.members.find(row => row.programId === 'manual').enabled, false);
  assert.equal(Object.hasOwn(publicStartupPlan(value, ids), 'startupOrder'), false);
});
