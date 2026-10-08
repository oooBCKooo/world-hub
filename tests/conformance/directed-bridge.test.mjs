import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, sleep, until } from '../helpers/hub-harness.mjs';

// A controllable transport is needed to force delivery-before-receipt races.
function fakeBridge(t, handler, opts = {}, features = ['directed-v1', 'blob-v1']) {
  const actualWebSocket = globalThis.WebSocket;
  const sent = []; let socket; let sequence = 0;
  class FakeSocket extends EventTarget {
    readyState = 0;
    constructor() {
      super(); socket = this;
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    emit(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
    send(raw) {
      const frame = JSON.parse(raw); sent.push(frame);
      if (frame.type === 'hello') this.emit({ type: 'welcome', hub: 'fixture', wire: '0.1', principal: 'caller', session: 'caller-session', lastSeq: 0, features });
      else if (frame.type === 'subscribe') this.emit({ type: 'subscribed', token: frame.token, subscription: `sub-${++sequence}`, filters: frame.filters, cursor: 0 });
      else if (frame.type === 'unsubscribe') this.emit({ type: 'unsubscribed', subscription: frame.subscription });
      else handler?.(this, frame, sent);
    }
    close(code = 1000, reason = '') {
      this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
    }
  }
  globalThis.WebSocket = FakeSocket;
  const socketHandle = setInterval(() => {}, 1000); // Simulate the real socket's live event-loop handle.
  const bridge = new Bridge({ url: 'ws://fixture.invalid/bridge', bridgeId: 'caller', ...opts });
  t.after(async () => { await bridge.close(); clearInterval(socketHandle); globalThis.WebSocket = actualWebSocket; });
  return { bridge, sent, socket: () => socket };
}

const respondBeforeReceipt = (socket, request, sent, count = 1) => {
  const sub = sent.findLast((frame) => frame.type === 'subscribe');
  const id = `sub-${sent.filter((frame) => frame.type === 'subscribe').length}`;
  for (let n = 0; n < count; n++) socket.emit({ type: 'delivery', subscription: id, seq: 20 + n,
    topic: request.topic, operation: 'response', requestSeq: 10, fromPrincipal: 'provider', from: `provider:instance-${n}`,
    target: { principal: 'caller' }, body: { answer: n }, correlation: request.correlation });
  assert.deepEqual(sub.operations, ['response']);
  socket.emit({ type: 'published', requestToken: request.requestToken, seq: 10, operation: 'request' });
};

test('call handles response before acceptance receipt and keeps the program subscription/cursor independent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'directed-sdk-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cursorFile = join(dir, 'cursor.json');
  const { bridge, sent } = fakeBridge(t, (socket, frame, records) => {
    if (frame.type === 'request') respondBeforeReceipt(socket, frame, records, 2);
  }, { cursorFile });
  const deliveries = []; bridge.on('delivery', (message) => deliveries.push(message));
  await bridge.connect(); const program = await bridge.subscribe(['opaque/arbitrary'], { from: 0 });
  const result = await bridge.call({ principal: 'provider' }, 'opaque/arbitrary', { query: 'anything' });
  assert.equal(result.request.seq, 10); assert.equal(result.response.body.answer, 0);
  await until(() => bridge.subscriptions.length === 1);
  assert.equal(bridge.subscriptions[0].id, program.subscription);
  assert.equal(bridge.cursorOf(['opaque/arbitrary']), null);
  assert.equal(existsSync(cursorFile), false, 'transient call cursors must not accumulate UUID keys in a cursor file');
  assert.equal(deliveries.length, 1, 'first response is the call policy; later replies remain in Hub history');
  assert.equal(sent.filter((frame) => frame.type === 'ack').length, 1);
});

test('manual calls return an ACKable frame and retain a bounded slot until caller ACKs', async (t) => {
  const { bridge, sent } = fakeBridge(t, (socket, frame, records) => {
    if (frame.type === 'request') respondBeforeReceipt(socket, frame, records);
  }, { autoAck: false, maxPendingCalls: 1 });
  await bridge.connect();
  const result = await bridge.call({ principal: 'provider' }, 'arbitrary/topic', {});
  assert.equal(sent.some((frame) => frame.type === 'ack'), false);
  assert.equal(bridge.subscriptions.length, 1);
  await assert.rejects(bridge.call({ principal: 'provider' }, 'arbitrary/topic', {}), { code: 'CALL_LIMIT' });
  assert.equal(bridge.ack(result.response), true);
  await until(() => bridge.subscriptions.length === 0);
  const next = await bridge.call({ principal: 'provider' }, 'arbitrary/topic', {});
  assert.equal(bridge.ack(next.response), true);
});

test('call never consumes unrelated requests; external response-handler failure prevents automatic ACK', async (t) => {
  const errors = []; const messages = [];
  const { bridge, sent } = fakeBridge(t, (socket, frame, records) => {
    if (frame.type !== 'request') return;
    const sub = `sub-${records.filter((record) => record.type === 'subscribe').length}`;
    socket.emit({ type: 'delivery', subscription: sub, seq: 11, topic: frame.topic, operation: 'request', body: { business: 'outside the call' } });
    respondBeforeReceipt(socket, frame, records);
  }, { maxPendingCalls: 1 });
  bridge.on('error', (error) => errors.push(error));
  bridge.on('delivery', (message) => { messages.push(message); throw new Error('program response handling failed'); });
  await bridge.connect();
  const result = await bridge.call({ principal: 'provider' }, 'arbitrary/topic', {});
  await until(() => errors.some((error) => error.code === 'DELIVERY_HANDLER_FAILED'));
  assert.equal(messages.length, 1); assert.equal(messages[0].operation, 'response');
  assert.equal(sent.some((frame) => frame.type === 'ack'), false);
  await assert.rejects(bridge.call({ principal: 'provider' }, 'arbitrary/topic', {}), { code: 'CALL_LIMIT' });
  assert.equal(bridge.ack(result.response), true, 'program may explicitly acknowledge its returned response');
  await until(() => bridge.subscriptions.length === 0);
});

test('explicit removal of a completed manual-call subscription frees its slot without releasing messages', async (t) => {
  const { bridge, sent } = fakeBridge(t, (socket, frame, records) => {
    if (frame.type === 'request') respondBeforeReceipt(socket, frame, records);
  }, { autoAck: false, maxPendingCalls: 1 });
  await bridge.connect();
  const first = await bridge.call({ principal: 'provider' }, 'arbitrary/topic', {});
  await bridge.unsubscribe(first.response.subscription);
  const second = await bridge.call({ principal: 'provider' }, 'arbitrary/topic', {});
  assert.equal(second.response.body.answer, 0);
  assert.equal(sent.some((frame) => frame.type === 'ack' || frame.type === 'release'), false);
});

test('call timeout rejects promptly while receipt is pending and sends no cancellation or release', async (t) => {
  const { bridge, sent } = fakeBridge(t, () => {});
  await bridge.connect();
  const start = Date.now();
  await assert.rejects(bridge.call({ principal: 'provider' }, 'arbitrary/topic', {}, { timeoutMs: 40, receiptTimeoutMs: 1000 }), /call response timeout/);
  assert.ok(Date.now() - start < 600);
  assert.equal(bridge.subscriptions.length, 0);
  assert.ok(sent.some((frame) => frame.type === 'request'));
  assert.equal(sent.some((frame) => frame.type === 'release' || frame.type === 'cancel'), false);
});

test('disconnect rejects pending call and retires its subscription instead of reconnecting the local wait', async (t) => {
  const { bridge, socket } = fakeBridge(t, (ws, frame) => {
    if (frame.type === 'request') ws.emit({ type: 'published', requestToken: frame.requestToken, seq: 10, operation: 'request' });
  }, { reconnectMs: 10000 });
  await bridge.connect();
  const call = bridge.call({ principal: 'provider' }, 'arbitrary/topic', {});
  await until(() => bridge.subscriptions.length === 1);
  socket().close(1006, 'lost');
  await assert.rejects(call, /connection closed/);
  assert.equal(bridge.subscriptions.length, 0);
});

test('SDK rejects unsupported Hub features and restricts communication helper frame types', async (t) => {
  const { bridge, sent } = fakeBridge(t, (socket, frame) => {
    if (frame.type === 'publish') socket.emit({ type: 'published', requestToken: frame.requestToken, seq: 1 });
  }, {}, []);
  await bridge.connect();
  await assert.rejects(bridge.sendTo({ principal: 'provider' }, 't', {}), { code: 'FEATURE_UNSUPPORTED' });
  await assert.rejects(bridge.requestTo({ principal: 'provider' }, 't', {}), { code: 'FEATURE_UNSUPPORTED' });
  await assert.rejects(bridge.respond(1, {}), { code: 'FEATURE_UNSUPPORTED' });
  await assert.rejects(bridge.call({ principal: 'provider' }, 't', {}), { code: 'FEATURE_UNSUPPORTED' });
  await assert.rejects(bridge.blobStatus('blob'), { code: 'FEATURE_UNSUPPORTED' });
  await assert.rejects(bridge.communicationRequest('publish', {}), /unsupported communication request/);
  await assert.rejects(bridge.publishConfirmed('t', {}, { attachments: ['blob'] }), { code: 'FEATURE_UNSUPPORTED' });
  assert.equal(bridge.publish('t', {}, { attachments: ['blob'] }), false);
  await bridge.publishConfirmed('t', {});
  assert.deepEqual(sent.map((frame) => frame.type), ['hello', 'publish']);
});

test('blob helper resolves blob_result and cannot override its whitelisted frame type', async (t) => {
  const { bridge, sent } = fakeBridge(t, (socket, frame) => socket.emit({ type: 'blob_result', requestToken: frame.requestToken, operation: frame.type, id: frame.id, offset: 7 }));
  await bridge.connect();
  const result = await bridge.communicationRequest('blob_status', { id: 'blob', type: 'publish', requestToken: 'forged' });
  assert.equal(result.operation, 'blob_status'); assert.equal(result.offset, 7);
  assert.equal(sent.at(-1).type, 'blob_status'); assert.notEqual(sent.at(-1).requestToken, 'forged');
});

test('SDK operation filters deduplicate independently and reject non-protocol categories', async (t) => {
  const { bridge } = fakeBridge(t);
  await bridge.connect();
  const ordinary = await bridge.subscribe(['arbitrary/topic'], { from: 0 });
  const requests = await bridge.subscribe(['arbitrary/topic'], { from: 0, operations: ['request'] });
  const again = await bridge.subscribe(['arbitrary/topic'], { from: 0, operations: ['request', 'request'] });
  assert.notEqual(ordinary.subscription, requests.subscription); assert.equal(requests.subscription, again.subscription);
  assert.equal(bridge.subscriptions.length, 2);
  await assert.rejects(bridge.subscribe(['arbitrary/topic'], { operations: ['system_prompt'] }), /protocol operations/);
  await assert.rejects(bridge.subscribe(['arbitrary/topic'], { operations: [] }), /protocol operations/);
});

async function actualHub(t) {
  const dir = mkdtempSync(join(tmpdir(), 'directed-sdk-config-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ hub: { id: 'sdk-tests' }, acl: { defaultDeny: true, credentials: {
    caller: { maxConnections: 8, allow: { publish: ['#'], subscribe: ['#'] } },
    provider: { maxConnections: 8, allow: { publish: ['#'], subscribe: ['#'] } },
    other: { maxConnections: 8, allow: { publish: ['#'], subscribe: ['#'] } },
  } } }));
  const h = new Harness(); const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await h.stop(); rmSync(dir, { recursive: true, force: true }); });
  await h.startHub({ configPath });
  const make = (credential, bridgeId = credential, opts = {}) => { const bridge = new Bridge({ url: h.endpoint, credential, bridgeId, ...opts }); clients.push(bridge); return bridge; };
  return { h, make };
}

test('real Hub request/respond crosses independently named bridges of the same provider and retains all replies', async (t) => {
  const { h, make } = await actualHub(t);
  const caller = make('caller'); const one = make('provider', 'same.program.mod-a'); const two = make('provider', 'same.program.mod-b');
  const requests = [];
  for (const provider of [one, two]) {
    provider.on('delivery', async (message) => {
      requests.push(message); await provider.respond(message, { bridge: provider.bridgeId });
    });
    await provider.connect(); await provider.subscribe(['external/new-kind'], { from: 0, operations: ['request'] });
  }
  await caller.connect();
  const result = await caller.call({ principal: 'provider' }, 'external/new-kind', { query: 'opaque' });
  assert.equal(result.response.operation, 'response'); assert.equal(result.response.requestSeq, result.request.seq);
  assert.equal(result.response.fromPrincipal, 'provider');
  await until(() => requests.length === 2);
  await until(async () => (await h.log(100)).records.filter((record) => record.kind === 'message' && record.operation === 'response').length === 2);
  assert.ok((await h.log(100)).records.some((record) => record.kind === 'message' && record.seq === result.request.seq));
  await until(() => caller.subscriptions.length === 0);
});

test('real directed injection supports stable-principal fanout and exact-session selection without third-party delivery', async (t) => {
  const { make } = await actualHub(t);
  const caller = make('caller'); const one = make('provider', 'program.mod-a'); const two = make('provider', 'program.mod-b'); const third = make('other');
  const received = new Map([[one, []], [two, []], [third, []]]);
  for (const client of [one, two, third]) {
    client.on('delivery', (message) => received.get(client).push(message));
    await client.connect(); await client.subscribe(['opaque/new-channel'], { from: 0 });
  }
  await caller.connect();
  await caller.sendTo({ principal: 'provider' }, 'opaque/new-channel', { mode: 'all provider mods' });
  await until(() => received.get(one).length === 1 && received.get(two).length === 1);
  await caller.sendTo({ principal: 'provider', session: two.welcome.session }, 'opaque/new-channel', { mode: 'one mod session' });
  await until(() => received.get(two).length === 2);
  await sleep(40);
  assert.equal(received.get(one).length, 1); assert.equal(received.get(third).length, 0);
  assert.equal(received.get(two)[1].operation, 'inject');
});

test('requestTo remains available while provider is offline; ordinary subscriptions restore replies after local call timeout', async (t) => {
  const { h, make } = await actualHub(t);
  const caller = make('caller'); const replies = [];
  caller.on('delivery', (message) => replies.push(message));
  await caller.connect();
  await assert.rejects(caller.call({ principal: 'provider' }, 'opaque/offline', { query: 'later' }, { timeoutMs: 60 }), /call response timeout/);
  const records = (await h.log(100)).records.filter((record) => record.kind === 'message');
  assert.equal(records.length, 1); assert.equal(records[0].operation, 'request');
  await caller.subscribe(['opaque/offline'], { from: 0, operations: ['response'] });
  const provider = make('provider'); const requests = [];
  provider.on('delivery', async (message) => { requests.push(message); await provider.respond(message, { available: true }); });
  await provider.connect(); await provider.subscribe(['opaque/offline'], { from: 0, operations: ['request'] });
  await until(() => replies.length === 1);
  assert.equal(requests[0].seq, records[0].seq); assert.equal(replies[0].requestSeq, records[0].seq);
  assert.ok((await h.log(100)).records.some((record) => record.kind === 'message' && record.seq === records[0].seq));
});

test('ordinary correlation-matched publications and unauthorized responders cannot resolve a call', async (t) => {
  const { make } = await actualHub(t);
  const caller = make('caller'); const provider = make('provider'); const other = make('other');
  const requests = [];
  provider.on('delivery', (message) => requests.push(message));
  await provider.connect(); await provider.subscribe(['opaque/private'], { from: 0, operations: ['request'] });
  await caller.connect(); await other.connect();
  let settled = false;
  const call = caller.call({ principal: 'provider' }, 'opaque/private', {}, { correlation: 'same', timeoutMs: 2000 }).then((result) => { settled = true; return result; });
  await until(() => requests.length === 1);
  await other.publishConfirmed('opaque/private', { forged: true }, { correlation: 'same' });
  await assert.rejects(other.respond(requests[0].seq, { forged: true }));
  await sleep(40); assert.equal(settled, false);
  await provider.respond(requests[0], { legitimate: true });
  const result = await call;
  assert.deepEqual(result.response.body, { legitimate: true });
});
