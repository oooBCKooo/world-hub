import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, sleep, until, PROJECT_ROOT } from '../helpers/hub-harness.mjs';

const CONFIG = resolve(PROJECT_ROOT, 'examples/event-panel/hub.config.json');
const deferred = () => { let resolvePromise; const promise = new Promise((res) => { resolvePromise = res; }); return { promise, resolve: resolvePromise }; };

async function setup(t) {
  const h = new Harness();
  const clients = [];
  await h.startHub({ configPath: CONFIG });
  t.after(async () => { for (const c of clients) await c.close(); await h.stop(); });
  const make = (opts) => { const b = new Bridge({ url: h.endpoint, ...opts }); clients.push(b); return b; };
  const publisher = make({ bridgeId: 'source.ticker' });
  await publisher.connect();
  const panel = (opts = {}) => make({ bridgeId: 'ui.dashboard', credential: 'ui.dashboard', ...opts });
  return { h, publisher, panel };
}

test('diagnostic observer synchronous failure cannot reject a successful welcome or prevent normal ACK', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const errors = []; const messages = [];
  const c = panel({ onEvent: () => { throw new Error('diagnostic observer failed'); } });
  c.on('open', () => { throw new Error('open observer failed'); });
  c.on('error', (frame) => errors.push(frame));
  c.on('delivery', (frame) => messages.push(frame));
  const welcome = await c.connect();
  assert.equal(welcome.principal, 'ui.dashboard'); assert.equal(c.connected, true);
  assert.ok(errors.some((error) => error.code === 'EVENT_HANDLER_FAILED' && error.event === 'open'));
  assert.equal(errors.some((error) => error.code === 'RESTORE_FAILED'), false);
  await c.subscribe(['source/ticker'], { from: 0 });
  const accepted = await publisher.publishConfirmed('source/ticker', { value: 'opaque' });
  await until(async () => (await h.status()).subscriptions[0]?.cursor === accepted.seq);
  assert.equal(messages.length, 1); assert.equal(c.cursorOf(['source/ticker']), accepted.seq);
  assert.equal((await h.status()).storage.log.protectedCount, 1, 'successful consumption still does not release');
});

test('diagnostic observer asynchronous failure remains isolated while business delivery failure stays unacknowledged', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const errors = [];
  const c = panel({ onEvent: async () => { throw new Error('async diagnostic observer failed'); } });
  c.on('open', async () => { throw new Error('async open observer failed'); });
  c.on('error', (frame) => errors.push(frame));
  c.on('denied', (frame) => errors.push(frame));
  c.on('error', async () => { throw new Error('async error observer failed'); });
  c.on('delivery', async () => { throw new Error('business consumption failed'); });
  await c.connect();
  await until(() => errors.some((error) => error.code === 'EVENT_HANDLER_FAILED' && error.event === 'open'));
  await c.subscribe(['source/ticker'], { from: 0 });
  const accepted = await publisher.publishConfirmed('source/ticker', { value: 'opaque' });
  await until(() => errors.some((error) => error.code === 'DELIVERY_HANDLER_FAILED' && error.seq === accepted.seq));
  const subscription = (await h.status()).subscriptions[0];
  assert.equal(subscription.cursor, 0); assert.equal(subscription.pending, 1);
  assert.equal(c.cursorOf(['source/ticker']), null);
  await assert.rejects(c.publishConfirmed('source/ticker', {}), { code: 'PUBLISH_DENIED' });
  await until(() => errors.some((error) => error.code === 'PUBLISH_DENIED'));
  await sleep(20); // Allow rejected observer promises to settle inside this test.
  assert.equal(c.connected, true); assert.equal((await h.status()).storage.log.protectedCount, 1);
});

test('async consumption commits and ACKs only after completion; caught_up does not commit', async (t) => {
  const { h, publisher, panel } = await setup(t);
  await publisher.publishConfirmed('source/ticker', { value: 1 });
  const cursorFile = join(h.tmp, 'cursor.json');
  const c = panel({ cursorFile });
  const gate = deferred();
  let started = false; let caughtUp = false;
  c.on('delivery', async () => { started = true; await gate.promise; });
  c.on('caughtUp', () => { caughtUp = true; });
  await c.connect();
  await c.subscribe(['source/ticker'], { from: 0 });
  await until(() => started && caughtUp);
  const before = (await h.status()).subscriptions[0];
  assert.equal(before.cursor, 0);
  assert.equal(before.pending, 1);
  assert.equal(existsSync(cursorFile), false);
  gate.resolve();
  await until(async () => (await h.status()).subscriptions[0]?.cursor === 1);
  assert.equal(c.cursorOf(['source/ticker']), 1);
  assert.equal(JSON.parse(readFileSync(cursorFile, 'utf8'))['ui.dashboard|source/ticker'], 1);
});

test('failed or absent consumers never automatically ACK', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const failed = panel(); const absent = panel(); const errors = [];
  failed.on('delivery', async () => { throw new Error('application failed'); });
  failed.on('error', (frame) => errors.push(frame));
  await failed.connect(); await absent.connect();
  await failed.subscribe(['source/ticker'], { from: 0 });
  await absent.subscribe(['source/ticker'], { from: 0 });
  await publisher.publishConfirmed('source/ticker', { value: 1 });
  await until(() => errors.some((e) => e.code === 'DELIVERY_HANDLER_FAILED'));
  await until(async () => (await h.status()).subscriptions.every((s) => s.pending === 1));
  assert.ok((await h.status()).subscriptions.every((s) => s.cursor === 0));
  assert.equal(failed.cursorOf(['source/ticker']), null);
  assert.equal(absent.cursorOf(['source/ticker']), null);
});

test('explicit out-of-order ACK cannot skip unfinished deliveries', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const c = panel({ autoAck: false, cursorFile: join(h.tmp, 'manual.json') });
  const messages = [];
  c.on('delivery', (m) => messages.push(m));
  await c.connect(); await c.subscribe(['source/ticker'], { from: 0 });
  await publisher.publishConfirmed('source/ticker', { value: 1 });
  await publisher.publishConfirmed('source/ticker', { value: 2 });
  await until(() => messages.length === 2);
  assert.equal(c.ack(messages[1]), true);
  await sleep(40); // ACK2 is sent before the status request; it cannot advance the prefix.
  assert.equal((await h.status()).subscriptions[0].cursor, 0);
  assert.equal(c.cursorOf(['source/ticker']), null);
  assert.equal(c.ack(messages[1].subscription, 99999), false);
  assert.equal(c.ack(messages[0]), true);
  await until(async () => (await h.status()).subscriptions[0]?.cursor === 2);
  assert.equal(c.cursorOf(['source/ticker']), 2);
});

test('cursor persistence failure is observable and leaves delivery unacknowledged', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const blocker = join(h.tmp, 'blocker'); writeFileSync(blocker, 'file, not a directory');
  const c = panel({ cursorFile: join(blocker, 'cursor.json') }); const errors = [];
  c.on('error', (f) => errors.push(f)); c.on('delivery', () => {});
  await c.connect(); await c.subscribe(['source/ticker'], { from: 0 });
  await publisher.publishConfirmed('source/ticker', { value: 1 });
  await until(() => errors.some((e) => e.code === 'CURSOR_SAVE_FAILED'));
  const sub = (await h.status()).subscriptions[0];
  assert.equal(sub.cursor, 0); assert.equal(sub.pending, 1); assert.equal(c.cursorOf(['source/ticker']), null);
});

test('same filters/from are idempotent; changing from removes the old subscription first', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const c = panel(); const messages = [];
  c.on('delivery', (m) => messages.push(m));
  await c.connect(); const initial = await c.subscribe(['source/ticker'], { from: 0 });
  await publisher.publishConfirmed('source/ticker', { value: 1 });
  await until(() => c.cursorOf(['source/ticker']) === 1);
  const repeated = await c.subscribe(['source/ticker'], { from: 0 });
  assert.equal(repeated.subscription, initial.subscription);
  assert.equal((await h.status()).subscriptions.length, 1);
  const replaced = await c.subscribe(['source/ticker'], { from: 'now' });
  assert.notEqual(replaced.subscription, initial.subscription);
  assert.equal((await h.status()).subscriptions.length, 1);
  await publisher.publishConfirmed('source/ticker', { value: 2 });
  await until(() => c.cursorOf(['source/ticker']) === 2);
  assert.equal(messages.filter((m) => m.body.value === 2).length, 1);
  await assert.rejects(c.subscribe(['source/ticker'], { from: NaN }), /from must/);
});

test('changing from before subscribed waits for and removes the pending hub subscription', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const c = panel(); const messages = [];
  c.on('delivery', (m) => messages.push(m));
  await c.connect();
  const initial = c.subscribe(['source/ticker'], { from: 0 });
  const replacement = c.subscribe(['source/ticker'], { from: 'now' });
  const [first, second] = await Promise.all([initial, replacement]);
  assert.notEqual(first.subscription, second.subscription);
  const subs = (await h.status()).subscriptions;
  assert.equal(subs.length, 1); assert.equal(subs[0].id, second.subscription);
  assert.equal(c.subscriptions.length, 1);
  await publisher.publishConfirmed('source/ticker', { value: 1 });
  await until(() => c.cursorOf(['source/ticker']) === 1);
  assert.equal(messages.length, 1);
});

test('channel names are declared by mods, and publication receipts are independently correlated', async (t) => {
  const { h, publisher } = await setup(t);
  const arbitrary = 'source/ticker/external-widget-73';
  const registration = await publisher.registerChannels([{ name: arbitrary, publish: true }]);
  assert.ok(registration.channels.some((c) => c.name === arbitrary && c.publish));
  assert.ok(publisher.channels.some((c) => c.name === arbitrary));
  const receipts = []; publisher.on('published', (f) => receipts.push(f));
  const accepted = publisher.publishConfirmed(arbitrary, { arbitrary: 'opaque' });
  const rejected = publisher.publishConfirmed('forbidden/foreign', { arbitrary: 'opaque' });
  const settled = await Promise.allSettled([accepted, rejected]);
  assert.equal(settled[0].status, 'fulfilled'); assert.equal(settled[1].status, 'rejected');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].seq, settled[0].value.seq);
  assert.ok(receipts[0].requestToken);
  assert.equal((await h.log(10)).records.filter((r) => r.kind === 'message').length, 1);
});

test('release is a correlated provider request, not a consumer ACK or permission to release foreign messages', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const consumer = panel(); const messages = [];
  consumer.on('delivery', (m) => messages.push(m));
  await consumer.connect(); await consumer.subscribe(['source/ticker'], { from: 0 });
  const accepted = await publisher.publishConfirmed('source/ticker', { value: 1 });
  await until(() => consumer.cursorOf(['source/ticker']) === accepted.seq);
  assert.equal(messages.length, 1);
  assert.ok((await h.log(10)).records.some((r) => r.kind === 'message' && r.seq === accepted.seq));
  await assert.rejects(consumer.release([accepted.seq]));
  const releaseEvents = []; publisher.on('released', (frame) => releaseEvents.push(frame));
  const receipt = await publisher.release([accepted.seq]);
  assert.equal(receipt.type, 'released'); assert.deepEqual(receipt.seq, [accepted.seq]);
  assert.ok(receipt.requestToken);
  assert.equal(releaseEvents.length, 1); assert.equal(releaseEvents[0].requestToken, receipt.requestToken);
  assert.equal(consumer.cursorOf(['source/ticker']), accepted.seq);
});

test('reconnect restores declarations and one subscription before repeated open registrations', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const c = panel({ reconnectMs: 50 }); const messages = []; let opens = 0;
  const errors = []; const registrations = [];
  c.on('registered', (e) => registrations.push(e));
  c.on('error', (e) => errors.push(e)); publisher.on('error', (e) => errors.push(e));
  c.on('delivery', (m) => messages.push(m));
  c.on('open', async () => { opens++; await c.subscribe(['source/ticker'], { from: 0 }); });
  await c.connect();
  await c.registerChannels([{ name: 'source/ticker', subscribe: true }]);
  await until(async () => (await h.status()).subscriptions.length === 1);
  await publisher.publishConfirmed('source/ticker', { value: 1 });
  await until(() => c.cursorOf(['source/ticker']) === 1);
  const oldHub = h.hub;
  const exited = new Promise((res) => oldHub.once('exit', res)); oldHub.kill('SIGTERM'); await exited;
  h.opts.port = h.port;
  await h.startHub({ configPath: CONFIG, isolateLog: false });
  await until(() => opens === 2 && publisher.connected).catch(async (err) => {
    throw new Error(`${err.message}; opens=${opens}; panelConnected=${c.connected}; publisherConnected=${publisher.connected}; registrations=${JSON.stringify(registrations)}; errors=${JSON.stringify(errors)}; status=${JSON.stringify(await h.status())}`);
  });
  await until(async () => (await h.status()).subscriptions.length === 1);
  assert.ok(c.channels.some((channel) => channel.name === 'source/ticker'));
  await publisher.publishConfirmed('source/ticker', { value: 2 });
  await until(() => c.cursorOf(['source/ticker']) === 2);
  assert.equal(messages.filter((m) => m.body.value === 1).length, 1);
  assert.equal(messages.filter((m) => m.body.value === 2).length, 1);
});

test('old async consumption cannot ACK or block a restored connection with reused subscription IDs', async (t) => {
  const { h, publisher, panel } = await setup(t);
  const c = panel({ reconnectMs: 50 });
  const oldGate = deferred(); const newGate = deferred(); const errors = [];
  let calls = 0; let opens = 0; let staleAck;
  c.on('open', () => opens++); c.on('error', (e) => errors.push(e));
  c.on('delivery', async (m) => {
    const call = ++calls;
    if (call === 1) {
      await oldGate.promise;
      staleAck = c.ack(m);
      throw new Error('previous connection failed');
    }
    if (call === 2) await newGate.promise;
  });
  await c.connect(); await c.subscribe(['source/ticker'], { from: 0 });
  await publisher.publishConfirmed('source/ticker', { value: 1 }); await until(() => calls === 1);
  const oldHub = h.hub;
  const exited = new Promise((res) => oldHub.once('exit', res)); oldHub.kill('SIGTERM'); await exited;
  h.opts.port = h.port;
  await h.startHub({ configPath: CONFIG, isolateLog: false });
  await until(() => opens === 2 && publisher.connected && calls === 2);
  oldGate.resolve();
  await until(() => errors.some((e) => e.code === 'DELIVERY_HANDLER_FAILED'));
  assert.equal(staleAck, false);
  assert.equal(errors.find((e) => e.code === 'DELIVERY_HANDLER_FAILED').stale, true);
  assert.equal((await h.status()).subscriptions[0].cursor, 0);
  assert.equal((await h.status()).subscriptions[0].pending, 1);
  newGate.resolve();
  await until(() => c.cursorOf(['source/ticker']) === 1);
  await publisher.publishConfirmed('source/ticker', { value: 2 });
  await until(() => c.cursorOf(['source/ticker']) === 2);
  assert.equal(calls, 3);
});

test('both source programs read_now actually sample, and source resume policy recovers offline commands', async (t) => {
  const { h, panel } = await setup(t);
  const c = panel(); const messages = [];
  c.on('delivery', (m) => messages.push(m)); await c.connect(); await c.subscribe(['source/#'], { from: 0 });
  for (const source of ['sensor-a', 'ticker']) {
    const cursorFile = join(h.tmp, `${source}.json`);
    let program = await h.spawnProgram(`examples/event-panel/${source}.mjs`, { args: ['--intervalMs', '60000'], env: { HUB_CURSOR_FILE: cursorFile } });
    await program.waitLine((l) => l.includes('"event":"subscribed"'));
    const id = `read-${source}`;
    await c.publishConfirmed(`cmd/${source}`, { command: 'read_now' }, { id });
    await until(() => messages.some((m) => m.body.replyTo === id));
    assert.equal(messages.filter((m) => m.body.source === source && m.body.metric).length, 1);
    await until(() => existsSync(cursorFile));
    program.child.kill('SIGKILL');
    await until(async () => program.exited && !(await h.status()).bridges.some((b) => b.bridgeId === `source.${source}`));
    const offlineId = `offline-${source}`;
    await c.publishConfirmed(`cmd/${source}`, { command: 'ping' }, { id: offlineId });
    program = await h.spawnProgram(`examples/event-panel/${source}.mjs`, { args: ['--intervalMs', '60000'], env: { HUB_CURSOR_FILE: cursorFile } });
    await program.waitLine((l) => l.includes(offlineId));
    await until(() => messages.some((m) => m.body.replyTo === offlineId));
    program.child.kill('SIGKILL'); await until(() => program.exited);
  }
});

test('panel atomically stores displayed state before its cursor, and restores after force termination', async (t) => {
  const { h, publisher } = await setup(t);
  const cursorFile = join(h.tmp, 'panel-cursor.json'); const stateFile = join(h.tmp, 'state.json');
  const options = { args: ['--quiet', '--state', stateFile], env: { HUB_CURSOR_FILE: cursorFile }, cwd: h.tmp };
  const panel = await h.spawnProgram('examples/event-panel/dashboard.mjs', options);
  await panel.waitLine((l) => l.includes('"event":"subscribed"'));
  await publisher.publishConfirmed('source/ticker', { kind: 'count', source: 'ticker', metric: 'tasks.completed', value: 42 });
  await until(() => existsSync(cursorFile));
  const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(stored.sources.ticker.last.value, 42); assert.equal(stored.handledSeq, 1);
  panel.child.kill('SIGKILL'); await until(() => panel.exited);
  const restored = await h.spawnProgram('examples/event-panel/dashboard.mjs', { ...options, args: ['--state', stateFile] });
  await restored.waitLine((l) => l.includes('"event":"subscribed"'));
  restored.child.stdin.write(':board\n');
  await restored.waitLine((l) => l.includes('ticker') && l.includes('42'));
  assert.equal(restored.lines.filter((l) => l.includes('"event":"source_event"')).length, 0);
});
