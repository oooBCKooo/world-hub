import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { Bridge, defaultCursorPath } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, PROJECT_ROOT, until } from '../helpers/hub-harness.mjs';
import { cursorWorker } from './fixtures/cursor-process-helper.mjs';

const CONFIG = resolve(PROJECT_ROOT, 'examples/event-panel/hub.config.json');

async function actualHub(t, { restricted = false } = {}) {
  let configPath = CONFIG; let configDir;
  if (restricted) {
    configDir = mkdtempSync(join(tmpdir(), 'hub-onboarding-acl-')); configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ acl: { defaultDeny: true, credentials: {
      caller: { maxConnections: 8, allow: { publish: ['cmd/#'], subscribe: ['aux/#'] } },
      provider: { maxConnections: 8, allow: { publish: ['cmd/#'], subscribe: ['cmd/#'] } },
    } } }));
  }
  const h = new Harness(); const clients = []; const workers = [];
  t.after(async () => {
    for (const worker of workers) await worker.close();
    for (const client of clients) await client.close();
    await h.stop(); if (configDir) rmSync(configDir, { recursive: true, force: true });
  });
  await h.startHub({ configPath });
  const make = (opts = {}) => { const bridge = new Bridge({ url: h.endpoint, bridgeId: 'consumer', credential: 'ui.dashboard', ...opts }); clients.push(bridge); return bridge; };
  const publisher = make({ bridgeId: 'publisher', ...(restricted ? { credential: 'provider' } : {}) }); await publisher.connect();
  const worker = async (opts) => { const instance = await cursorWorker({ url: h.endpoint, credential: 'ui.dashboard', bridgeId: 'same-consumer', topic: 'cmd/cursor-probe', ...opts }); workers.push(instance); return instance; };
  return { h, make, publisher, worker, configPath };
}

test('changed explicit from re-reads history; same initial from reuses visibly without re-reading', async (t) => {
  const { h, make, publisher } = await actualHub(t);
  const accepted = await publisher.publishConfirmed('cmd/onboarding', { opaque: 'retained before connection' });
  const hooks = []; const events = []; const deliveries = [];
  const consumer = make({ onEvent: (event) => hooks.push(event) });
  consumer.on('subscriptionReused', (event) => events.push(event)); consumer.on('delivery', (frame) => deliveries.push(frame));
  await consumer.connect();
  const live = await consumer.subscribe(['cmd/onboarding']);
  assert.equal(live.cursor, accepted.seq);
  const history = await consumer.subscribe(['cmd/onboarding'], { from: 0 });
  assert.notEqual(history.subscription, live.subscription, 'omitted initial policy → explicit 0 already changes the subscription');
  await until(() => consumer.cursorOf(['cmd/onboarding']) === accepted.seq);
  const repeated = await consumer.subscribe(['cmd/onboarding'], { from: 0 });
  assert.equal(repeated.subscription, history.subscription); assert.equal(repeated.deduped, true);
  assert.equal(deliveries.length, 1); assert.equal(events.length, 1); assert.equal(hooks.length, 1);
  assert.equal(events[0].cursor, accepted.seq); assert.equal(events[0].from, 0);
  assert.equal(hooks[0].kind, 'subscription_reused');
  assert.equal((await h.status()).subscriptions.length, 1); assert.equal((await h.status()).storage.log.protectedCount, 1);
});

test('explicit replay restarts its exact subscription, keeps overlapping subscriptions, and remains live', async (t) => {
  const { h, make, publisher } = await actualHub(t);
  const first = await publisher.publishConfirmed('cmd/onboarding', { opaque: 1 });
  const second = await publisher.publishConfirmed('cmd/onboarding', { opaque: 2 });
  const consumer = make(); const deliveries = [];
  consumer.on('delivery', (frame) => deliveries.push(frame)); await consumer.connect();
  const ordinary = await consumer.subscribe(['cmd/onboarding'], { from: 0 });
  const operation = await consumer.subscribe(['cmd/onboarding'], { from: 0, operations: ['publish'] });
  await until(() => consumer.cursorOf(['cmd/onboarding']) === second.seq && consumer.cursorOf(['cmd/onboarding'], { operations: ['publish'] }) === second.seq);
  const replayed = await consumer.replay(['cmd/onboarding']);
  assert.notEqual(replayed.subscription, ordinary.subscription);
  await until(() => deliveries.filter((frame) => frame.subscription === replayed.subscription).length === 2);
  assert.ok(consumer.subscriptions.some((sub) => sub.id === operation.subscription));
  assert.equal(deliveries.filter((frame) => frame.seq === first.seq).length, 3, 'overlap stays visible; no global business deduplication');
  const third = await publisher.publishConfirmed('cmd/onboarding', { opaque: 3 });
  await until(() => consumer.cursorOf(['cmd/onboarding']) === third.seq && consumer.cursorOf(['cmd/onboarding'], { operations: ['publish'] }) === third.seq);
  const afterFirst = await consumer.replay(['cmd/onboarding'], { from: first.seq });
  await until(() => deliveries.filter((frame) => frame.subscription === afterFirst.subscription).length === 2);
  assert.deepEqual(deliveries.filter((frame) => frame.subscription === afterFirst.subscription).map((frame) => frame.seq), [second.seq, third.seq]);
  assert.equal((await h.status()).subscriptions.length, 2); assert.equal((await h.status()).storage.log.protectedCount, 3);
});

test('invalid replay is rejected before removing an existing subscription; pending initial setup is removed safely', async (t) => {
  const { h, make } = await actualHub(t); const consumer = make();
  await consumer.connect();
  const initial = consumer.subscribe(['cmd/onboarding'], { from: 0 });
  const replacement = consumer.replay(['cmd/onboarding']);
  const [one, two] = await Promise.all([initial, replacement]);
  assert.notEqual(one.subscription, two.subscription);
  for (const opts of [{ from: 'now' }, { from: null }, { from: -1 }, { operations: ['business-workflow'] }]) await assert.rejects(consumer.replay(['cmd/onboarding'], opts));
  assert.equal(consumer.subscriptions.length, 1); assert.equal(consumer.subscriptions[0].id, two.subscription);
  assert.equal((await h.status()).subscriptions.length, 1);
});

test('replay reconnect resumes its completed cursor instead of restarting its initial history again', async (t) => {
  const { h, make, publisher, configPath } = await actualHub(t);
  const first = await publisher.publishConfirmed('cmd/onboarding', { opaque: 1 });
  const consumer = make({ cursorFile: join(h.tmp, 'replay.json'), reconnectMs: 50 });
  const deliveries = []; let opens = 0;
  consumer.on('delivery', (frame) => deliveries.push(frame)); consumer.on('open', () => opens++);
  await consumer.connect(); await consumer.replay(['cmd/onboarding']);
  await until(() => consumer.cursorOf(['cmd/onboarding']) === first.seq);
  const oldHub = h.hub; const exited = new Promise((resolve) => oldHub.once('exit', resolve)); oldHub.kill('SIGTERM'); await exited;
  h.opts.port = h.port; await h.startHub({ configPath, isolateLog: false });
  await until(() => opens === 2 && publisher.connected);
  await until(async () => (await h.status()).subscriptions.length === 1);
  const next = await publisher.publishConfirmed('cmd/onboarding', { opaque: 2 });
  await until(() => consumer.cursorOf(['cmd/onboarding']) === next.seq);
  assert.deepEqual(deliveries.map((frame) => frame.seq), [first.seq, next.seq]);
  assert.equal(JSON.parse(readFileSync(join(h.tmp, 'replay.json'), 'utf8'))['consumer|cmd/onboarding'], next.seq);
});

test('call subscribe denial names the called topic and principal while preserving the original denial frame', async (t) => {
  const { h, make } = await actualHub(t, { restricted: true });
  const caller = make({ credential: 'caller', maxPendingCalls: 1 }); await caller.connect();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(caller.call({ principal: 'provider' }, 'cmd/private-call', { opaque: true }), (error) => {
      assert.equal(error.code, 'SUBSCRIBE_DENIED'); assert.equal(error.topic, 'cmd/private-call'); assert.equal(error.targetPrincipal, 'provider');
      assert.match(error.message, /subscribe permission for the called topic "cmd\/private-call"/); assert.match(error.message, /principal "provider"/);
      assert.equal(error.frame.type, 'denied'); assert.equal(error.frame.code, 'SUBSCRIBE_DENIED'); assert.equal(error.frame.filter, 'cmd/private-call');
      assert.equal(error.cause.frame, error.frame); return true;
    });
    await until(() => caller.subscriptions.length === 0);
  }
  assert.equal((await h.log()).records.filter((record) => record.kind === 'message').length, 0, 'no request was sent before the denied response subscription');
});

test('separate stable instance paths and keys isolate two real processes and survive restart independently', async (t) => {
  const { h, publisher, worker } = await actualHub(t);
  const first = await publisher.publishConfirmed('cmd/cursor-probe', { record: 1 });
  const second = await publisher.publishConfirmed('cmd/cursor-probe', { record: 2 });
  const options = (instanceId) => ({ instanceId, cursorFile: join(h.tmp, basename(defaultCursorPath('same-consumer', instanceId))) });
  const fastOptions = options('fast'); const slowOptions = options('slow');
  const fast = await worker(fastOptions); const slow = await worker(slowOptions);
  assert.notEqual(fast.child.pid, slow.child.pid); assert.notEqual(fastOptions.cursorFile, slowOptions.cursorFile);
  for (const instance of [fast, slow]) await instance.wait((event) => event.event === 'delivery' && event.seq === second.seq);
  assert.equal((await fast.command({ type: 'ack', seq: first.seq })).acknowledged, true);
  assert.equal((await fast.command({ type: 'ack', seq: second.seq })).acknowledged, true);
  assert.equal((await slow.command({ type: 'ack', seq: first.seq })).acknowledged, true);
  const fastKey = JSON.stringify(['same-consumer', 'fast', ['cmd/cursor-probe'], null]); const slowKey = JSON.stringify(['same-consumer', 'slow', ['cmd/cursor-probe'], null]);
  assert.deepEqual(JSON.parse(readFileSync(fastOptions.cursorFile, 'utf8')), { [fastKey]: second.seq });
  assert.deepEqual(JSON.parse(readFileSync(slowOptions.cursorFile, 'utf8')), { [slowKey]: first.seq });
  await fast.close(); await slow.close();
  const restoredFast = await worker(fastOptions); const restoredSlow = await worker(slowOptions);
  assert.equal(restoredFast.ready.subscription.cursor, second.seq);
  await restoredSlow.wait((event) => event.event === 'delivery' && event.seq === second.seq);
  assert.deepEqual(restoredFast.events.filter((event) => event.event === 'delivery'), []);
  assert.deepEqual(restoredSlow.events.filter((event) => event.event === 'delivery').map((event) => event.seq), [second.seq]);
  assert.equal((await restoredSlow.command({ type: 'ack', seq: second.seq })).acknowledged, true);
  assert.deepEqual(JSON.parse(readFileSync(fastOptions.cursorFile, 'utf8')), { [fastKey]: second.seq });
  assert.deepEqual(JSON.parse(readFileSync(slowOptions.cursorFile, 'utf8')), { [slowKey]: second.seq });
  assert.equal((await h.status()).storage.log.protectedCount, 2);
});

test('instance naming encodes separators safely, limits path length, and leaves legacy paths and keys compatible', async (t) => {
  assert.equal(defaultCursorPath('same-consumer'), join(process.cwd(), '.hub', 'cursors', 'same-consumer.json'));
  assert.equal(defaultCursorPath('same-consumer', '../a|b'), join(process.cwd(), '.hub', 'cursors', 'instances', 'b-same-consumer', 'i-..%2Fa%7Cb.json'));
  assert.notEqual(defaultCursorPath('a', 'b'), defaultCursorPath('a--instance-b'));
  assert.notEqual(defaultCursorPath('same-consumer', 'a|b'), defaultCursorPath('same-consumer', 'a%7Cb'));
  for (const instanceId of ['', null, 4, 'x'.repeat(65), '\uD800']) {
    assert.throws(() => defaultCursorPath('same-consumer', instanceId), /instanceId/);
    assert.throws(() => new Bridge({ bridgeId: 'same-consumer', instanceId }), /instanceId/);
  }
  for (const bridgeId of ['../a', 'x'.repeat(65), '']) assert.throws(() => defaultCursorPath(bridgeId, 'safe'), /bridgeId/);
  const { h, make, publisher } = await actualHub(t); const consumer = make({ instanceId: '../a|b' });
  consumer.on('delivery', () => {}); await consumer.connect(); await consumer.subscribe(['cmd/onboarding'], { from: 0 });
  const receipt = await publisher.publishConfirmed('cmd/onboarding', {}); await until(() => consumer.cursorOf(['cmd/onboarding']) === receipt.seq);
  assert.equal(consumer.cursorOf(['cmd/onboarding']), receipt.seq);
  for (const instanceId of ['*', 'CON']) {
    const path = defaultCursorPath('con', instanceId);
    assert.equal(path, join(process.cwd(), '.hub', 'cursors', 'instances', 'b-con', instanceId === '*' ? 'i-%2A.json' : 'i-CON.json'));
    const cursorFile = join(h.tmp, relative(join(process.cwd(), '.hub', 'cursors'), path));
    const windowsConsumer = make({ bridgeId: 'con', instanceId, cursorFile }); windowsConsumer.on('delivery', () => {});
    await windowsConsumer.connect(); await windowsConsumer.subscribe(['cmd/windows-instance'], { from: 0 });
    const accepted = await publisher.publishConfirmed('cmd/windows-instance', { instanceId });
    await until(() => windowsConsumer.cursorOf(['cmd/windows-instance']) === accepted.seq);
    assert.deepEqual(JSON.parse(readFileSync(cursorFile, 'utf8')), { [JSON.stringify(['con', instanceId, ['cmd/windows-instance'], null])]: accepted.seq });
    await windowsConsumer.close();
  }
});

test('instance cursor namespaces cannot collide with a legacy topic-shaped cursor key', async (t) => {
  const { h, make, publisher } = await actualHub(t); const cursorFile = join(h.tmp, 'sequential-namespaces.json');
  const modern = make({ bridgeId: 'a', instanceId: 'b', cursorFile }); modern.on('delivery', () => {});
  await modern.connect(); await modern.subscribe(['cmd/onboarding'], { from: 0 });
  const one = await publisher.publishConfirmed('cmd/onboarding', {}); await until(() => modern.cursorOf(['cmd/onboarding']) === one.seq); await modern.close();
  const legacy = make({ bridgeId: 'a', cursorFile }); legacy.on('delivery', () => {});
  await legacy.connect(); await legacy.subscribe(['cmd/onboarding|instance:b'], { from: 0 });
  const two = await publisher.publishConfirmed('cmd/onboarding|instance:b', {}); await until(() => legacy.cursorOf(['cmd/onboarding|instance:b']) === two.seq);
  assert.deepEqual(JSON.parse(readFileSync(cursorFile, 'utf8')), {
    [JSON.stringify(['a', 'b', ['cmd/onboarding'], null])]: one.seq,
    'a|cmd/onboarding|instance:b': two.seq,
  });
});

test('subscription reuse observer failures remain observable without changing the successful subscription', async (t) => {
  const { h, make } = await actualHub(t); const errors = [];
  const consumer = make({ onEvent: () => { throw new Error('observer failed'); } });
  consumer.on('error', (frame) => errors.push(frame)); await consumer.connect();
  const first = await consumer.subscribe(['cmd/onboarding'], { from: 0 });
  const again = await consumer.subscribe(['cmd/onboarding'], { from: 0 });
  assert.equal(again.subscription, first.subscription); assert.equal(again.deduped, true);
  assert.ok(errors.some((error) => error.code === 'EVENT_HANDLER_FAILED' && error.event === 'subscriptionReused'));
  assert.equal((await h.status()).subscriptions.length, 1);
});
