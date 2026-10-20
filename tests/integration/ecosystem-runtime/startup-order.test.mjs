import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStartupOrder } from '../../../scripts/runtime/startup-order.mjs';
import { validatePack } from '../../../scripts/runtime/package.mjs';
import { summarizePack } from '../../../scripts/runtime/pack-paradigms.mjs';
import { DynamicAssembly } from '../../../scripts/runtime/dynamic-assembly.mjs';

const component = (id, after = [], autostart = true) => ({ id, module: 'order.fixture', after, autostart,
  settings: {}, bridges: { main: { publish: ['events'], subscribe: ['events'] } } });
const pack = () => ({ format: 'world-hub.pack/v1', id: 'exact.order', version: '1.0.0', title: 'Exact order', license: 'MIT',
  topics: { events: 'order/events' }, components: [component('first'), component('second'), component('manual', [], false)],
  bindings: [], entry: { component: 'first' }, startupTimeoutMs: 500, healthTimeoutMs: 500, stopTimeoutMs: 500 });
const invalid = operation => assert.throws(operation, error => error.code === 'STARTUP_ORDER_INVALID');

test('pack exact startup order controls independent members and includes manual members without selecting them', () => {
  const value = pack(); value.startupOrder = ['second', 'manual', 'first'];
  assert.deepEqual(validatePack(value).map(row => row.id), value.startupOrder);
  assert.equal(value.components.find(row => row.id === 'manual').autostart, false);
  const summary = summarizePack(value); assert.deepEqual(summary.startupOrder, value.startupOrder);
  summary.startupOrder.reverse(); assert.deepEqual(value.startupOrder, ['second', 'manual', 'first']);
});

test('exact startup order rejects missing, duplicate, unknown, extra and malformed values', () => {
  for (const startupOrder of [['first','second'], ['first','first','manual'], ['first','second','unknown'],
    ['first','second','manual','extra'], [], null, 'first', undefined]) {
    const value = { ...pack(), startupOrder }; invalid(() => validatePack(value));
  }
});

test('exact startup order rejects after conflicts even when both members are manual', () => {
  const value = pack(); value.components[0].after = ['manual']; value.components[0].autostart = false;
  value.startupOrder = ['first','second','manual']; invalid(() => validatePack(value));
  value.startupOrder = ['manual','second','first']; assert.deepEqual(validatePack(value).map(row => row.id), value.startupOrder);
});

test('omitted startup order retains declaration-derived topological defaults and never follows capability routes', () => {
  const value = pack(); value.components[0].after = ['manual'];
  value.bindings = [{ from: 'first', to: 'second', contract: { id: 'order.contract', version: '1.0.0' } }];
  assert.deepEqual(validatePack(value).map(row => row.id), ['manual','first','second']);
  assert.equal(Object.hasOwn(summarizePack(value), 'startupOrder'), false);
  assert.deepEqual(resolveStartupOrder(value.components).map(row => row.id), ['manual','first','second']);
});

test('dynamic external admission appends to exact order and removal removes only that member', async () => {
  const value = pack(); value.startupOrder = ['second','first','manual'];
  const manifest = { id: 'order.fixture', version: '1.0.0', bridges: ['main'], provides: [], requires: [] };
  const assembly = new DynamicAssembly({ plan: { pack: value, digest: 'baseline', modules: [{ manifest, source: 'modules/fixture', files: [] }], environment: {} },
    stateDir: 'unused', runDir: 'unused', runId: 'order-test', state: { components: [] }, peers: {}, tokens: new Map(), secrets: [],
    signal: new AbortController().signal, hasOwnedProcess: () => false });
  const external = component('external'); external.module = 'external';
  const added = await assembly.prepare({ kind: 'admit-external', component: external,
    external: { id: 'external', bridges: ['main'], provides: [], requires: [] } });
  assert.deepEqual(added.next.startupOrder, ['second','first','manual','external']);
  assembly.pack = added.next; assembly.records = added.records;
  const removed = await assembly.prepare({ kind: 'revoke-external', ids: ['external'] });
  assert.deepEqual(removed.next.startupOrder, ['second','first','manual']);
});
