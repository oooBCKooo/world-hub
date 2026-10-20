import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from '../../helpers/hub-harness.mjs';
import { hubFixture, startAdapter, resultData, allowedTopic, secondTopic } from './helpers.mjs';

const options = { timeout: 20000 };
async function success(adapter, name, args = {}) {
  const result = await adapter.call(name, args), value = resultData(result);
  assert.equal(result.isError ?? false, false, JSON.stringify(value));
  assert.equal(value.ok, true); return value;
}

test('real historical caught-up waterlines include nonmatching sequences without claiming ACK or business completion', options, async t => {
  const f = await hubFixture(t), source = await f.bridge('source'), expected = [];
  await source.publishConfirmed(secondTopic, { unrelatedPrefix: true });
  let through;
  for (let index = 0; index < 32; index++) {
    expected.push((await source.publishConfirmed(allowedTopic, { historical: index })).seq);
    through = (await source.publishConfirmed(secondTopic, { nonmatching: index })).seq;
  }
  const adapter = await startAdapter(f), subscription = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 0 });
  const first = await until(async () => {
    const batch = await success(adapter, 'hub_pull', { subscription: subscription.subscription, maxMessages: 1 });
    return batch.caughtUp ? batch : false;
  });
  assert.deepEqual(first.caughtUp, { type: 'caught_up', subscription: subscription.subscription, cursor: 0, through });
  assert.equal(first.messages.length, 1); assert.equal(first.remaining, expected.length - 1,
    'all matching deliveries preceding the wire barrier are buffered before the barrier becomes observable');
  const identity = await success(adapter, 'hub_identity');
  assert.deepEqual(identity.subscriptions[0].caughtUp, first.caughtUp);
  assert.equal(identity.subscriptions[0].buffered, expected.length, 'a sent/scanned barrier does not acknowledge received information');
  const seen = [];
  for (let index = 0; index < expected.length; index++) {
    const batch = index ? await success(adapter, 'hub_pull', { subscription: subscription.subscription, maxMessages: 1 }) : first;
    seen.push(...batch.messages.map(message => message.seq));
    assert.ok(batch.messages.every(message => message.seq <= batch.caughtUp.through));
    await success(adapter, 'hub_ack', { subscription: subscription.subscription, seqs: batch.messages.map(message => message.seq) });
  }
  assert.deepEqual(seen, expected);
  const drained = await success(adapter, 'hub_pull', { subscription: subscription.subscription });
  assert.deepEqual(drained.messages, []); assert.equal(drained.remaining, 0);
  assert.deepEqual(drained.caughtUp, first.caughtUp, 'cursor remains the actual barrier-time observation, not a synthetic later ACK cursor');

  // Only after handling every matching delivery through this captured barrier
  // can an external consumer choose to save through as its own replay cursor.
  const checkpoint = drained.caughtUp.through;
  await success(adapter, 'hub_unsubscribe', { subscription: subscription.subscription });
  const future = await source.publishConfirmed(allowedTopic, { afterCheckpoint: true });
  const unrelatedFuture = await source.publishConfirmed(secondTopic, { afterCheckpoint: 'nonmatching' });
  const replay = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: checkpoint });
  const resumed = await until(async () => {
    const batch = await success(adapter, 'hub_pull', { subscription: replay.subscription });
    return batch.caughtUp ? batch : false;
  });
  assert.deepEqual(resumed.messages.map(message => message.seq), [future.seq]);
  assert.equal(resumed.caughtUp.through, unrelatedFuture.seq);
  assert.equal(resumed.caughtUp.cursor, checkpoint, 'the later matching delivery is still unacknowledged');
  assert.equal((await f.records()).length, 67, 'observing a scan barrier never releases provider information');
});

test('immediate empty and nonmatching historical scans bind each token to the correct subscription and remain live', options, async t => {
  const f = await hubFixture(t), source = await f.bridge('source');
  let watermark;
  for (let index = 0; index < 3; index++) watermark = (await source.publishConfirmed(secondTopic, { historicalOnlyOnOtherTopic: index })).seq;
  const adapter = await startAdapter(f);
  const historical = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 0 });
  const emptyNow = await success(adapter, 'hub_subscribe', { topics: [secondTopic], from: 'now' });
  const identity = await until(async () => {
    const value = await success(adapter, 'hub_identity');
    return value.subscriptions.length === 2 && value.subscriptions.every(sub => sub.caughtUp) ? value : false;
  });
  const states = new Map(identity.subscriptions.map(sub => [sub.subscription, sub]));
  assert.deepEqual(states.get(historical.subscription).caughtUp,
    { type: 'caught_up', subscription: historical.subscription, cursor: 0, through: watermark });
  assert.deepEqual(states.get(emptyNow.subscription).caughtUp,
    { type: 'caught_up', subscription: emptyNow.subscription, cursor: watermark, through: watermark });
  for (const subscription of [historical, emptyNow]) {
    const read = await success(adapter, 'hub_pull', { subscription: subscription.subscription });
    assert.deepEqual(read.messages, []); assert.equal(read.remaining, 0);
    assert.equal(read.caughtUp.through, watermark);
  }
  const pending = success(adapter, 'hub_pull', { subscription: historical.subscription, waitMs: 1000 });
  const live = await source.publishConfirmed(allowedTopic, { liveAfterEmptyHistory: true });
  const read = await pending;
  assert.deepEqual(read.messages.map(message => message.seq), [live.seq]);
  assert.equal(read.caughtUp.through, watermark,
    'the earlier historical barrier does not assert that later live information cannot arrive');
});

test('a waiting pull reports removal instead of returning success from a retired subscription', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f);
  const subscription = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 'now' });
  await until(async () => (await success(adapter, 'hub_identity')).subscriptions[0]?.caughtUp);
  const waiting = adapter.call('hub_pull', { subscription: subscription.subscription, waitMs: 2000 });
  await success(adapter, 'hub_unsubscribe', { subscription: subscription.subscription });
  const result = await waiting;
  assert.equal(result.isError, true); assert.equal(resultData(result).error.code, 'SUBSCRIPTION_UNKNOWN');
});
