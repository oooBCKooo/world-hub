import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ManualBridge, parseManualEnvelope } from '../../src/management/manual-bridge.mjs';
import { Harness, until } from '../helpers/hub-harness.mjs';
import { attachWebSocketServer } from '../../src/hub/ws-server.mjs';

async function actualHub(t, { limits } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'hub-browser-mod-'));
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...(limits ? { limits } : {}), acl: { defaultDeny: true, allowUnlistedBridges: false, credentials: {
    owner: { token: 'explicit-test-token', maxConnections: 8, allow: { publish: ['#'], subscribe: ['#'] } },
    provider: { maxConnections: 8, allow: { publish: ['#'], subscribe: ['#'] } },
    reader: { maxConnections: 8, allow: { publish: [], subscribe: ['#'] } },
    stranger: { maxConnections: 8, allow: { publish: ['public/#'], subscribe: ['public/#'] } },
  } } }));
  const h = new Harness(); const clients = [];
  t.after(async () => { for (const client of clients) client.close(); await h.stop(); rmSync(configDir, { recursive: true, force: true }); });
  await h.startHub({ configPath });
  const make = async (credential, options = {}, extra = {}) => {
    const frames = []; const states = [];
    const client = new ManualBridge({ timeoutMs: 3000, onFrame: (raw, frame) => frames.push({ raw, frame }), onState: (state) => states.push(state), ...options });
    clients.push(client);
    const welcome = await client.connect({ url: h.endpoint, bridge: `browser-${clients.length}`, credential, ...(credential === 'owner' ? { token: 'explicit-test-token' } : {}), ...extra });
    return { client, frames, states, welcome };
  };
  return { h, make, clients };
}

for (const asynchronous of [false, true]) test(`browser diagnostic observers isolate ${asynchronous ? 'asynchronous' : 'synchronous'} failures while preserving receipts and explicit ACK`, async (t) => {
  const { h, make } = await actualHub(t);
  const observed = []; const sends = []; const states = []; const progress = [];
  const failingObserver = asynchronous
    ? async () => { throw new Error('async browser observer failed'); }
    : () => { throw new Error('browser observer failed'); };
  const owner = await make('owner', {
    onFrame: (raw, frame) => { observed.push(frame); return failingObserver(); },
    onSend: (raw, frame) => { sends.push(frame); return failingObserver(); },
    onState: (state) => { states.push(state); return failingObserver(); },
  });
  assert.equal(owner.client.connected, true); assert.equal(owner.welcome.principal, 'owner');
  assert.ok(states.some((state) => state.status === 'connected'));
  const subscription = await owner.client.subscribe({ filters: ['observer/test'], from: 'now' });
  const accepted = await owner.client.command('publish', { topic: 'observer/test', body: { opaque: true } });
  const delivered = await until(() => observed.find((frame) => frame.type === 'delivery' && frame.seq === accepted.seq));
  assert.ok(sends.some((frame) => frame.type === 'publish'));
  const before = (await h.status()).subscriptions.find((sub) => sub.id === subscription.subscription);
  assert.equal(before.pending, 1); assert.equal(before.cursor, 0, 'diagnostic observers do not ACK');
  owner.client.ack(delivered.subscription, [delivered.seq]);
  await until(async () => (await h.status()).subscriptions.find((sub) => sub.id === subscription.subscription)?.cursor === accepted.seq);
  assert.equal((await h.status()).storage.log.protectedCount, 1, 'manual ACK does not release');
  const object = await owner.client.uploadFile(new Blob(['opaque bytes']), (value) => { progress.push(value); return failingObserver(); });
  assert.equal(object.committed, true); assert.equal(progress.at(-1).stage, 'complete');
  const file = await owner.client.downloadBlob(object, () => failingObserver());
  assert.equal(await file.text(), 'opaque bytes');
  const reader = await make('reader', { onFrame: () => failingObserver(), onState: () => failingObserver() });
  await assert.rejects(reader.client.command('publish', { topic: 'observer/test', body: {} }), { code: 'PUBLISH_DENIED' });
  assert.equal(reader.client.pendingCount(), 0); assert.equal(reader.client.connected, true);
  await new Promise((resolve) => setTimeout(resolve, 20)); // Observe settled callbacks before test cleanup.
});

test('browser mod authenticates itself, observes denial, and never retains a hello token in callbacks', async (t) => {
  const { h, make, clients } = await actualHub(t);
  const frames = []; const client = new ManualBridge({ timeoutMs: 3000, onFrame: (raw) => frames.push(raw) }); clients.push(client);
  await assert.rejects(client.connect({ url: h.endpoint, bridge: 'browser-denied', credential: 'owner', token: 'wrong-explicit-token' }), { code: 'BRIDGE_TOKEN_REJECTED' });
  assert.equal(client.connected, false); assert.ok(frames.some((f) => f.includes('BRIDGE_TOKEN_REJECTED')));
  assert.ok(frames.every((f) => !f.includes('wrong-explicit-token')));
  const { client: owner, frames: accepted, welcome } = await make('owner');
  assert.equal(welcome.principal, 'owner'); assert.equal(welcome.authenticated, true); assert.ok(owner.connected);
  assert.ok(accepted.every(({ raw }) => !raw.includes('explicit-test-token')));
  const { client: reader } = await make('reader');
  await assert.rejects(reader.command('publish', { topic: 'private/no-right', body: {} }), { code: 'PUBLISH_DENIED' });
  const { client: stranger } = await make('stranger');
  await assert.rejects(stranger.subscribe({ filters: ['private/#'], from: 0 }), { code: 'SUBSCRIBE_DENIED' });
  await assert.rejects(owner.connect({ url: h.endpoint, bridge: 'Browser-Invalid', credential: 'owner' }), { code: 'BRIDGE_INVALID' });
  assert.ok(owner.connected, 'local invalid options do not destroy the current valid connection');
});

test('dynamic registration and bidirectional raw body preserve 4001-digit numbers and Unicode without reserializing', async (t) => {
  const { h, make } = await actualHub(t); const { client: owner } = await make('owner'); const { client: reader, frames } = await make('reader');
  const topic = 'phase8/自由来源/new-kind';
  const declaration = await owner.command('register', { channels: [{ name: topic, publish: true, subscribe: true }] });
  assert.ok(declaration.channels.some((channel) => channel.name === topic));
  const live = await reader.subscribe({ filters: [topic], from: 'now' }); assert.equal(live.barrier.subscription, live.subscription);
  const bodyRaw = `{  "big":9007199254740993,"huge":${'9'.repeat(4001)},"decimal":1.2300e+02,"unicode":"中文😀","escaped":"\\uD800","nested":[{}, {"body":1}] }`;
  const accepted = await owner.command('publish', { topic }, { bodyRaw });
  const delivered = await until(() => frames.find(({ frame }) => frame.type === 'delivery' && frame.seq === accepted.seq));
  assert.equal(delivered.frame.bodyRaw, bodyRaw); assert.ok(delivered.raw.includes(bodyRaw));
  assert.equal(delivered.frame.body.huge, Infinity, 'decoded body is explicitly diagnostic, original text remains available');
  const unrounded = '{ "body": {"array":[9007199254740993]}, "topic": "phase8/raw-send", "type": "publish", "requestToken":"raw-user" }';
  owner.sendRaw(unrounded);
  await until(async () => (await h.log()).records.some((record) => record.topic === 'phase8/raw-send'));
  const { client: echo, frames: echoFrames } = await make('provider');
  const subscriptionPromise = echo.subscribe({ filters: ['phase8/raw-send'], from: 0 });
  const echoDelivery = await until(() => echoFrames.find(({ frame }) => frame.type === 'delivery' && frame.topic === 'phase8/raw-send'));
  assert.equal(echoDelivery.frame.bodyRaw, '{"array":[9007199254740993]}'); echo.ack(echoDelivery.frame.subscription, [echoDelivery.frame.seq]); await subscriptionPromise;
  assert.throws(() => parseManualEnvelope('{"type":"publish","type":"inject"}'), { code: 'FRAME_INVALID' });
});

test('concurrent subscribe tokens associate exact send barriers; manual ACK and release remain separate', async (t) => {
  const { h, make } = await actualHub(t); const { client: owner } = await make('owner'); const { client: reader, frames } = await make('reader');
  const one = await owner.command('publish', { topic: 'phase8/a', body: { value: 1 } });
  const two = await owner.command('publish', { topic: 'phase8/b', body: { value: 2 } });
  let finishedA = false; let finishedB = false;
  const promiseA = reader.subscribe({ filters: ['phase8/a'], from: 0 }).then((value) => { finishedA = true; return value; });
  const promiseB = reader.subscribe({ filters: ['phase8/b'], from: 0 }).then((value) => { finishedB = true; return value; });
  await until(() => frames.filter(({ frame }) => frame.type === 'delivery').length === 2);
  const a = frames.find(({ frame }) => frame.type === 'delivery' && frame.seq === one.seq).frame;
  const b = frames.find(({ frame }) => frame.type === 'delivery' && frame.seq === two.seq).frame;
  const before = await h.status();
  assert.equal(before.subscriptions.find((sub) => sub.id === a.subscription).pending, 1);
  const subB = await promiseB;
  assert.deepEqual(subB.filters, ['phase8/b']); assert.equal(subB.barrier.subscription, b.subscription);
  const subA = await promiseA;
  assert.deepEqual(subA.filters, ['phase8/a']); assert.equal(subA.barrier.subscription, a.subscription); assert.notEqual(subA.token, subB.token);
  assert.ok(finishedA && finishedB); assert.equal(subA.barrier.cursor, 0, 'send barrier is not an ACK cursor');
  reader.ack(b.subscription, [two.seq]); reader.ack(a.subscription, [one.seq]);
  await until(async () => (await h.status()).subscriptions.every((sub) => sub.pending === 0));
  assert.equal((await h.status()).storage.log.protectedCount, 2, 'ACK and caught_up do not release information');
  await assert.rejects(reader.command('release', { seq: [one.seq] }), { code: 'RELEASE_DENIED' });
  assert.equal((await h.status()).storage.log.protectedCount, 2);
  const released = await owner.command('release', { seq: [one.seq] }); assert.deepEqual(released.seq, [one.seq]);
  assert.equal((await h.status()).storage.log.protectedCount, 1);
  await reader.unsubscribe(subA.subscription); await reader.unsubscribe(subB.subscription);
  assert.equal((await h.status()).subscriptions.length, 0);
});

test('manual directed request/respond and injection follow authenticated principals, with outsider response denied', async (t) => {
  const { make } = await actualHub(t); const caller = await make('owner'); const provider = await make('provider'); const outsider = await make('stranger');
  const own = await caller.client.subscribe({ filters: ['phase8/call'], from: 'now', operations: ['response'] });
  const incoming = await provider.client.subscribe({ filters: ['phase8/call'], from: 'now', operations: ['request', 'inject'] });
  const request = await caller.client.command('request', { topic: 'phase8/call', target: { principal: 'provider' }, correlation: 'user-selected-call', bodyRaw: ' {"query":9007199254740993} ' });
  const delivery = await until(() => provider.frames.find(({ frame }) => frame.type === 'delivery' && frame.seq === request.seq));
  assert.equal(delivery.frame.operation, 'request'); assert.equal(delivery.frame.target.principal, 'provider');
  await assert.rejects(outsider.client.command('respond', { requestSeq: request.seq, body: {} }), { code: 'RESPONSE_DENIED' });
  const result = await provider.client.command('respond', { requestSeq: request.seq, bodyRaw: '{"answer":[9007199254740993]}' });
  const answer = await until(() => caller.frames.find(({ frame }) => frame.type === 'delivery' && frame.seq === result.seq));
  assert.equal(answer.frame.subscription, own.subscription); assert.equal(answer.frame.requestSeq, request.seq); assert.equal(answer.frame.bodyRaw, '{"answer":[9007199254740993]}');
  const inject = await caller.client.command('inject', { topic: 'phase8/call', target: { principal: 'provider', session: provider.welcome.session }, body: { input: true } });
  const injected = await until(() => provider.frames.find(({ frame }) => frame.type === 'delivery' && frame.seq === inject.seq));
  assert.equal(injected.frame.subscription, incoming.subscription); assert.equal(injected.frame.operation, 'inject');
  provider.client.ack(incoming.subscription, [request.seq, inject.seq]); caller.client.ack(own.subscription, [result.seq]);
});

test('history beyond the negotiated delivery window remains incomplete until the user advances it with ACK', async (t) => {
  const { h, make } = await actualHub(t, { limits: { maxPendingDeliveries: 2, catchUpBatchSize: 2, maxCatchUpMessages: 10 } });
  const owner = await make('owner'); const reader = await make('reader'); const seqs = [];
  for (let index = 0; index < 3; index++) seqs.push((await owner.client.command('publish', { topic: 'phase8/window', body: { index } })).seq);
  let finished = false;
  const subscription = reader.client.subscribe({ filters: ['phase8/window'], from: 0 }).then((value) => { finished = true; return value; });
  await until(() => reader.frames.filter(({ frame }) => frame.type === 'delivery').length === 2);
  assert.equal(finished, false); assert.equal(reader.frames.some(({ frame }) => frame.type === 'caught_up'), false);
  const initial = reader.frames.find(({ frame }) => frame.type === 'subscribed').frame;
  assert.equal((await h.status()).subscriptions[0].pending, 2);
  reader.client.ack(initial.subscription, [seqs[0]]);
  await until(() => reader.frames.filter(({ frame }) => frame.type === 'delivery').length === 3);
  assert.equal(finished, false, 'history is scanned but the full window still delays the send barrier');
  reader.client.ack(initial.subscription, [seqs[1]]);
  const complete = await subscription;
  assert.equal(complete.barrier.subscription, initial.subscription); assert.equal(complete.barrier.through, seqs[2]);
  assert.deepEqual(reader.frames.filter(({ frame }) => frame.type === 'delivery').map(({ frame }) => frame.seq), seqs);
  assert.equal((await h.status()).storage.log.protectedCount, 3);
});

test('browser file transport exceeds 1 MiB, checks digest, obeys retained-message read rights, and releases only explicitly', async (t) => {
  const { h, make } = await actualHub(t); const owner = await make('owner'); const reader = await make('reader'); const stranger = await make('stranger');
  const data = Uint8Array.from({ length: 1024 * 1024 + 37 }, (_, at) => at % 251); const hash = createHash('sha256').update(data).digest('hex');
  const uploadProgress = []; const object = await owner.client.uploadFile(new Blob([data]), (progress) => uploadProgress.push(progress));
  assert.equal(object.sha256, hash); assert.equal(object.size, data.length); assert.equal(object.committed, true);
  assert.ok(uploadProgress.filter((p) => p.stage === 'uploading' && p.offset > 0).length > 4);
  await assert.rejects(reader.client.command('blob_status', { id: object.id }), { code: 'BLOB_OWNER_DENIED' });
  await assert.rejects(reader.client.downloadBlob({ ...object }), { code: 'BLOB_DENIED' });
  const accepted = await owner.client.command('publish', { topic: 'private/file', attachments: [object.id], body: { name: 'opaque.bin' } });
  const downloadProgress = []; const file = await reader.client.downloadBlob({ ...object, messageSeq: accepted.seq }, (progress) => downloadProgress.push(progress));
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), data); assert.equal(downloadProgress.at(-1).stage, 'complete');
  await assert.rejects(reader.client.downloadBlob({ ...object, messageSeq: accepted.seq, sha256: '0'.repeat(64) }), { code: 'BLOB_CONTENT_CHANGED' });
  await assert.rejects(stranger.client.downloadBlob({ ...object, messageSeq: accepted.seq }), { code: 'BLOB_DENIED' });
  await assert.rejects(reader.client.command('blob_release', { id: object.id }), { code: 'BLOB_OWNER_DENIED' });
  const before = await h.status(); assert.equal(before.storage.blobs.protectedCount, 1); assert.equal(before.storage.log.protectedCount, 1);
  const released = await owner.client.command('blob_release', { id: object.id }); assert.equal(released.released, true);
  assert.equal((await h.status()).storage.log.protectedCount, 1, 'object release does not release the message');
  await owner.client.command('release', { seq: [accepted.seq] }); assert.equal((await h.status()).storage.log.protectedCount, 0);
});

test('cancel or disconnect aborts file operations without automatically releasing incomplete objects', async (t) => {
  const { h, make } = await actualHub(t); const owner = await make('owner'); const controller = new AbortController();
  const file = new Blob([new Uint8Array(1024 * 1024 + 37)]); let id;
  await assert.rejects(owner.client.uploadFile(file, (progress) => { if (progress.id) id = progress.id; if (progress.offset > 0) controller.abort(); }, { signal: controller.signal }), { code: 'ABORTED' });
  const partial = await owner.client.command('blob_status', { id }); assert.equal(partial.committed, false); assert.equal(partial.released, false); assert.ok(partial.offset > 0);
  assert.equal((await h.status()).storage.blobs.protectedCount, 1);
  let disconnectedId;
  await assert.rejects(owner.client.uploadFile(file, (progress) => { if (progress.id) disconnectedId = progress.id; if (progress.offset > 0) owner.client.close(); }), { code: 'DISCONNECTED' });
  assert.ok(disconnectedId); assert.equal(owner.client.connected, false);
  await until(async () => (await h.status()).bridges.length === 0);
  assert.equal((await h.status()).storage.blobs.protectedCount, 2);
  await owner.client.connect({ url: h.endpoint, bridge: 'browser-restored', credential: 'owner', token: 'explicit-test-token' });
  for (const objectId of [id, disconnectedId]) { const state = await owner.client.command('blob_status', { id: objectId }); assert.equal(state.released, false); await owner.client.command('blob_release', { id: objectId }); }
});

async function controlledTransport(t, { replyWelcome = false, replyFrame } = {}) {
  const server = createServer(); const ws = attachWebSocketServer(server);
  ws.on('message', (conn, raw) => {
    const frame = JSON.parse(raw);
    if (frame.type === 'hello' && replyWelcome) conn.send(JSON.stringify({ type: 'welcome', hubWire: '0.1', principal: frame.bridge, bridge: frame.bridge, features: [], lastSeq: 0, limits: {} }));
    else if (replyFrame) replyFrame(conn, frame);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { ws.closeAll(); await new Promise((resolve) => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/bridge`, ws };
}

test('silent/closed controlled WebSocket rejects finite pending operations and closes timed-out handshakes', async (t) => {
  const silent = await controlledTransport(t); const client = new ManualBridge({ timeoutMs: 80 }); t.after(() => client.close());
  await assert.rejects(client.connect({ url: silent.url, bridge: 'silent' }), { code: 'TIMEOUT' });
  await until(() => silent.ws.connections.size === 0); assert.equal(client.connected, false);
  const transport = await controlledTransport(t, { replyWelcome: true }); const pending = new ManualBridge({ timeoutMs: 200, maxPending: 1 }); t.after(() => pending.close());
  await pending.connect({ url: transport.url, bridge: 'controlled' });
  await assert.rejects(pending.command('blob_status', { id: 'id' }), { code: 'FEATURE_UNSUPPORTED' });
  await assert.rejects(pending.command('request', { target: { principal: 'other' }, topic: 'a', body: {} }), { code: 'FEATURE_UNSUPPORTED' });
  const timed = pending.command('register', { channels: [{ name: 'a', publish: true }] });
  await assert.rejects(pending.command('register', { channels: [{ name: 'b', publish: true }] }), { code: 'PENDING_LIMIT' });
  await assert.rejects(timed, { code: 'TIMEOUT' }); assert.equal(pending.pendingCount(), 0);
  const closed = pending.command('register', { channels: [{ name: 'a', publish: true }] }); transport.ws.closeAll(1013, 'controlled disconnect');
  await assert.rejects(closed, { code: 'DISCONNECTED' }); assert.equal(pending.pendingCount(), 0); assert.equal(pending.connected, false);
});

test('local frame/file limits and failed digest reject explicitly; receipt operation mismatches do not resolve a different request', async (t) => {
  const { make } = await actualHub(t); const owner = await make('owner', { maxFrameBytes: 8192, maxBlobBytes: 1024 });
  assert.throws(() => owner.client.sendRaw(JSON.stringify({ type: 'publish', topic: 'a', body: 'x'.repeat(8192) })), { code: 'FRAME_TOO_LARGE' });
  await assert.rejects(owner.client.uploadFile(new Blob([new Uint8Array(1025)])), { code: 'BLOB_LOCAL_LIMIT' });
  await assert.rejects(owner.client.command('publish', { topic: 'a' }, { bodyRaw: '{bad json}' }), { code: 'BODY_INVALID' });
  await assert.rejects(owner.client.subscribe({ filters: ['a'], from: true }), { code: 'CURSOR_INVALID' });
  const constrained = await make('owner', { maxBufferedBytes: 512 });
  await assert.rejects(constrained.client.command('publish', { topic: 'a', body: { value: 'x'.repeat(512) } }), { code: 'SEND_BUFFER_FULL' });
  assert.equal(constrained.client.pendingCount(), 0);
  const transport = await controlledTransport(t, { replyWelcome: true, replyFrame: (conn, frame) => conn.send(JSON.stringify({ type: 'released', requestToken: frame.requestToken, seq: [] })) });
  const client = new ManualBridge({ timeoutMs: 500 }); t.after(() => client.close()); await client.connect({ url: transport.url, bridge: 'wrong-receipt' });
  await assert.rejects(client.command('register', { channels: [{ name: 'a', publish: true }] }), { code: 'RECEIPT_INVALID' });
  // SHA mismatch is exercised using a controlled byte source, distinct from the
  // real-Hub descriptor mismatch/permission cases above.
  const expected = createHash('sha256').update('expected').digest('hex');
  const forged = await controlledTransport(t, { replyFrame: (conn, frame) => {
    if (frame.type === 'hello') conn.send(JSON.stringify({ type: 'welcome', hubWire: '0.1', features: ['blob-v1'], blobLimits: { chunkBytes: 16 }, limits: {} }));
    else conn.send(JSON.stringify({ type: 'blob_result', operation: 'blob_read', requestToken: frame.requestToken, id: frame.id, offset: 0, size: 8, sha256: expected, bytes: 8, data: Buffer.from('forged!!').toString('base64'), eof: true }));
  } });
  const downloader = new ManualBridge({ timeoutMs: 500 }); t.after(() => downloader.close()); await downloader.connect({ url: forged.url, bridge: 'bad-checksum' });
  await assert.rejects(downloader.downloadBlob({ id: 'test-object', size: 8, sha256: expected }), { code: 'BLOB_HASH_MISMATCH' });
});
