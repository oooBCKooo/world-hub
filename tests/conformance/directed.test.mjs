import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Harness, until } from '../helpers/hub-harness.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { parseEnvelope } from '../../src/hub/lib/wire-json.mjs';
import { Hub } from '../../src/hub/lib/hub.mjs';

class Client {
  constructor(url) {
    this.ws = new WebSocket(url); this.frames = []; this.raw = []; this.waiters = [];
    this.ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data); this.frames.push(frame); this.raw.push(event.data);
      for (const waiter of [...this.waiters]) if (waiter.matches(frame)) {
        clearTimeout(waiter.timer); this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(frame);
      }
    });
  }
  wait(matches) {
    const existing = this.frames.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, reject) => {
      const waiter = { matches, resolve: resolveWait };
      waiter.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(new Error('wire response timed out')); }, 5000);
      this.waiters.push(waiter);
    });
  }
  send(frame) { this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
  async hello(bridge, credential) {
    await new Promise((ok, fail) => { this.ws.addEventListener('open', ok, { once: true }); this.ws.addEventListener('error', fail, { once: true }); });
    this.send({ type: 'hello', wire: '0.1', bridge, ...(credential ? { credential } : {}) });
    this.welcome = await this.wait((f) => f.type === 'welcome'); return this;
  }
  async receipt(type, fields) {
    const requestToken = randomUUID(); this.send({ type, ...fields, requestToken });
    return this.wait((f) => f.requestToken === requestToken);
  }
  async subscribe(fields = {}) {
    const token = randomUUID(); this.send({ type: 'subscribe', filters: ['#'], ...fields, token });
    return this.wait((f) => f.token === token);
  }
  async caught(subscription) { return this.wait((f) => f.type === 'caught_up' && f.subscription === subscription); }
  deliveries(subscription) { return this.frames.filter((f) => f.type === 'delivery' && (!subscription || f.subscription === subscription)); }
  close() { if (this.ws.readyState < 2) this.ws.close(); }
}

async function fixture(t, { open = false, limits = {}, acl = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hub-directed-config-'));
  const configPath = join(base, 'hub.json');
  const allow = { publish: ['#'], subscribe: ['#'] };
  writeFileSync(configPath, JSON.stringify({ limits, log: { segmentMaxBytes: 128 * 1024, segmentMaxCount: 32 },
    acl: { allowUnlistedBridges: open,
      bridges: { caller: { allow }, outsider: { allow }, ...acl.bridges },
      credentials: { provider: { maxConnections: 4, allow }, ...acl.credentials } } }));
  const h = new Harness({ keepTmp: true }); const clients = [];
  await h.startHub({ configPath });
  t.after(async () => {
    clients.forEach((client) => client.close()); await h.stop();
    for (const directory of [h.tmp, base]) {
      const absolute = resolve(directory), temporaryRoot = resolve(tmpdir()) + sep;
      assert.ok(absolute.startsWith(temporaryRoot), 'test cleanup must stay inside temporary storage');
      rmSync(absolute, { recursive: true, force: true });
    }
  });
  async function connect(bridge, credential) {
    const client = new Client(h.endpoint); clients.push(client); return client.hello(bridge, credential);
  }
  async function restart() { clients.forEach((client) => client.close()); await h.stop(); h.opts.port = h.port; await h.startHub({ configPath, isolateLog: false }); }
  return { h, connect, restart };
}

test('directed wire announces stable principals, unrepeatable sessions and explicit capabilities', async (t) => {
  const { connect, h } = await fixture(t); const caller = await connect('caller'); const provider = await connect('adapter', 'provider');
  assert.equal(caller.welcome.principal, 'caller'); assert.equal(provider.welcome.principal, 'provider');
  assert.match(provider.welcome.session, /^[0-9a-f-]{36}$/); assert.notEqual(provider.welcome.session, caller.welcome.session);
  assert.ok(caller.welcome.features.includes('directed-v1')); assert.ok(caller.welcome.features.includes('blob-v1'));
  assert.equal(caller.welcome.blobLimits.chunkBytes, 256 * 1024); assert.equal(caller.welcome.blobLimits.dir, undefined);
  const bridge = (await h.status()).bridges.find((b) => b.bridgeId === provider.welcome.bridge);
  assert.equal(bridge.principal, 'provider'); assert.equal(bridge.session, provider.welcome.session);
});

test('requests and injections reach only the named principal in realtime and wildcard history', async (t) => {
  const { connect } = await fixture(t); const caller = await connect('caller'); const provider = await connect('adapter', 'provider'); const outsider = await connect('outsider');
  const psub = await provider.subscribe(); await provider.caught(psub.subscription);
  const osub = await outsider.subscribe(); await outsider.caught(osub.subscription);
  const request = await caller.receipt('request', { target: { principal: 'provider' }, topic: 'arbitrary/context', body: { value: 1 }, correlation: 'flow' });
  const injection = await caller.receipt('inject', { target: { principal: 'provider' }, topic: 'anything/新类型', body: { kind: 'not-enumerated', value: 2 } });
  assert.equal(request.type, 'published'); assert.equal(request.operation, 'request');
  await provider.wait((f) => f.type === 'delivery' && f.seq === injection.seq);
  assert.deepEqual(provider.deliveries().map((f) => f.operation), ['request', 'inject']);
  assert.equal(provider.deliveries()[0].fromPrincipal, 'caller'); assert.equal(provider.deliveries()[0].senderSession, caller.welcome.session);
  const history = await outsider.subscribe({ from: 0 }); await outsider.caught(history.subscription);
  assert.equal(outsider.deliveries().length, 0);
  const ownHistory = await provider.subscribe({ from: 0 }); await provider.caught(ownHistory.subscription);
  assert.deepEqual(provider.deliveries(ownHistory.subscription).map((f) => f.seq), [request.seq, injection.seq]);
});

test('responses are authenticated against the retained request and route back from its trusted metadata', async (t) => {
  const { connect, h } = await fixture(t); const caller = await connect('caller'); const provider = await connect('adapter', 'provider'); const outsider = await connect('outsider');
  const csub = await caller.subscribe({ operations: ['response'] }); await caller.caught(csub.subscription);
  const request = await caller.receipt('request', { target: { principal: 'provider' }, topic: 'opaque/call', body: { question: '?' }, correlation: 'original' });
  const forged = await outsider.receipt('respond', { requestSeq: request.seq, body: { answer: 'forged' } });
  assert.equal(forged.code, 'RESPONSE_DENIED');
  const redirected = await provider.receipt('respond', { requestSeq: request.seq, target: { principal: 'outsider' }, body: {} });
  assert.equal(redirected.code, 'FRAME_INVALID');
  const response = await provider.receipt('respond', { requestSeq: request.seq, body: { answer: 'own-program-result' }, correlation: 'spoofed' });
  assert.equal(response.operation, 'response'); assert.equal(response.requestSeq, request.seq);
  const delivered = await caller.wait((f) => f.type === 'delivery' && f.seq === response.seq);
  assert.equal(delivered.topic, 'opaque/call'); assert.deepEqual(delivered.target, { principal: 'caller' });
  assert.equal(delivered.fromPrincipal, 'provider'); assert.equal(delivered.requestSeq, request.seq); assert.equal(delivered.correlation, 'original');
  const unknown = await provider.receipt('respond', { requestSeq: 999999, body: {} }); assert.equal(unknown.code, 'REQUEST_NOT_FOUND');
  const fakeRelease = await provider.receipt('release', { seq: [request.seq] }); assert.equal(fakeRelease.code, 'RELEASE_DENIED');
  const fakeReplyRelease = await caller.receipt('release', { seq: [response.seq] }); assert.equal(fakeReplyRelease.code, 'RELEASE_DENIED');
  caller.send({ type: 'ack', subscription: csub.subscription, seq: [response.seq] });
  assert.equal((await h.log()).records.filter((entry) => entry.kind === 'message').length, 2);
  assert.equal((await fetch(`${h.httpBase}/manage/api/state`).then((r) => r.json())).log.protectedCount, 2);
});

test('a one-process set of bridges fans out by principal while precise sessions select one instance', async (t) => {
  const { connect } = await fixture(t); const caller = await connect('caller');
  const one = await connect('adapter.one', 'provider'), two = await connect('adapter.two', 'provider');
  const a = await one.subscribe(); await one.caught(a.subscription); const b = await two.subscribe(); await two.caught(b.subscription);
  const broad = await caller.receipt('request', { target: { principal: 'provider' }, topic: 'dynamic/test', body: {} });
  await one.wait((f) => f.type === 'delivery' && f.seq === broad.seq); await two.wait((f) => f.type === 'delivery' && f.seq === broad.seq);
  const narrow = await caller.receipt('request', { target: { principal: 'provider', session: one.welcome.session }, topic: 'dynamic/test', body: {} });
  await one.wait((f) => f.type === 'delivery' && f.seq === narrow.seq);
  const twoHistory = await two.subscribe({ from: 0 }); await two.caught(twoHistory.subscription);
  assert.deepEqual(two.deliveries(twoHistory.subscription).map((f) => f.seq), [broad.seq]);
  const denied = await two.receipt('respond', { requestSeq: narrow.seq, body: {} }); assert.equal(denied.code, 'RESPONSE_DENIED');
  const responseOne = await one.receipt('respond', { requestSeq: broad.seq, body: { n: 1 } });
  const responseTwo = await two.receipt('respond', { requestSeq: broad.seq, body: { n: 2 } });
  assert.equal(responseOne.type, 'published'); assert.equal(responseTwo.type, 'published');
});

test('offline requests and replies survive restart but old precise sessions never move to a new connection', async (t) => {
  const { connect, restart } = await fixture(t); const caller = await connect('caller'); const old = await connect('adapter', 'provider');
  const precise = await caller.receipt('request', { target: { principal: 'provider', session: old.welcome.session }, topic: 'offline/request', body: { precise: true } });
  const stable = await caller.receipt('request', { target: { principal: 'provider' }, topic: 'offline/request', body: { stable: true } });
  const oldSession = old.welcome.session; const oldInstance = old.welcome.bridge; await restart();
  const provider = await connect('adapter', 'provider'); assert.equal(provider.welcome.bridge, oldInstance); assert.notEqual(provider.welcome.session, oldSession);
  const psub = await provider.subscribe({ from: 0 }); await provider.caught(psub.subscription);
  assert.deepEqual(provider.deliveries().map((f) => f.seq), [stable.seq]);
  const preciseResponse = await provider.receipt('respond', { requestSeq: precise.seq, body: {} }); assert.equal(preciseResponse.code, 'RESPONSE_DENIED');
  const response = await provider.receipt('respond', { requestSeq: stable.seq, body: { result: 'later' } }); assert.equal(response.type, 'published');
  await restart(); const returned = await connect('caller'); const replies = await returned.subscribe({ from: 0, operations: ['response'] }); await returned.caught(replies.subscription);
  assert.deepEqual(returned.deliveries().map((f) => f.requestSeq), [stable.seq]); assert.equal(returned.deliveries()[0].body.result, 'later');
});

test('publish cannot impersonate new operations and addresses reject unknown or malformed identities', async (t) => {
  const { connect } = await fixture(t); const caller = await connect('caller');
  for (const fields of [{ target: { principal: 'provider' } }, { operation: 'response' }, { requestSeq: 1 }, { fromPrincipal: 'provider' }, { senderSession: randomUUID() }, { owner: 'provider' }]) {
    assert.equal((await caller.receipt('publish', { topic: 'opaque', body: {}, ...fields })).code, 'FRAME_INVALID');
  }
  for (const target of [{ principal: 'unknown' }, { principal: 'provider:1' }, { principal: 'provider', session: 'old-instance' }, { principal: 'provider', program: 'any-ui-note' }, 'provider']) {
    assert.ok(['TARGET_INVALID', 'TARGET_UNKNOWN'].includes((await caller.receipt('inject', { target, topic: 'opaque', body: {} })).code));
  }
  const normal = await caller.receipt('publish', { topic: 'opaque', body: {} }); assert.equal(normal.type, 'published'); assert.equal(normal.operation, undefined);
});

test('open development mode permits a lawful future loopback principal without inventing business kinds', async (t) => {
  const { connect } = await fixture(t, { open: true }); const caller = await connect('caller');
  const request = await caller.receipt('inject', { target: { principal: 'future' }, topic: 'future/whatever', body: { kind: 'arbitrary' } });
  const later = await connect('future'); assert.equal(later.welcome.authenticated, false);
  const sub = await later.subscribe({ from: 0 }); await later.caught(sub.subscription); assert.equal(later.deliveries()[0].seq, request.seq);
});

test('operations filters share realtime and history rules and prevent reply window starvation', async (t) => {
  const { connect } = await fixture(t, { limits: { maxPendingDeliveries: 2 } }); const caller = await connect('caller'); const provider = await connect('adapter', 'provider');
  const replies = await caller.subscribe({ operations: ['response'] }); assert.deepEqual(replies.operations, ['response']); await caller.caught(replies.subscription);
  for (let i = 0; i < 6; i++) {
    await provider.receipt('inject', { target: { principal: 'caller' }, topic: 'same/topic', body: { i } });
    await provider.receipt('publish', { topic: 'same/topic', body: { i } });
  }
  const request = await caller.receipt('request', { target: { principal: 'provider' }, topic: 'same/topic', body: {} });
  const response = await provider.receipt('respond', { requestSeq: request.seq, body: { result: true } });
  await caller.wait((f) => f.type === 'delivery' && f.seq === response.seq);
  assert.deepEqual(caller.deliveries(replies.subscription).map((f) => f.seq), [response.seq]);
  const history = await caller.subscribe({ from: 0, operations: ['response'] }); await caller.caught(history.subscription);
  assert.deepEqual(caller.deliveries(history.subscription).map((f) => f.seq), [response.seq]);
  for (const operations of [[], ['response', 'response'], ['arbitrary-business-kind'], 'response']) assert.equal((await caller.subscribe({ operations })).code, 'OPERATIONS_INVALID');
});

test('directed request and response publishing still enforce the authenticated sender topic ACL', async (t) => {
  const { connect } = await fixture(t, { acl: { credentials: { provider: { maxConnections: 4, allow: { publish: ['allowed/#'], subscribe: ['#'] } } } } });
  const caller = await connect('caller'); const provider = await connect('adapter', 'provider');
  assert.equal((await provider.receipt('inject', { target: { principal: 'caller' }, topic: 'forbidden', body: {} })).code, 'PUBLISH_DENIED');
  const request = await caller.receipt('request', { target: { principal: 'provider' }, topic: 'forbidden', body: {} });
  assert.equal((await provider.receipt('respond', { requestSeq: request.seq, body: {} })).code, 'PUBLISH_DENIED');
});

test('directed envelope forwarding preserves body JSON bytes and never reads application destination fields', async (t) => {
  const { connect } = await fixture(t); const caller = await connect('caller'); const provider = await connect('adapter', 'provider'); const outsider = await connect('outsider');
  const sub = await provider.subscribe(); await provider.caught(sub.subscription);
  const body = '{ "target":"outsider", "number":9007199254740993,\n "escaped":"\\u0061", "unit":1e0 }';
  const requestToken = randomUUID();
  caller.send('{"type":"inject","target":{"principal":"provider"},"topic":"raw/body","requestToken":"' + requestToken + '","body":' + body + '}');
  const receipt = await caller.wait((f) => f.requestToken === requestToken); await provider.wait((f) => f.type === 'delivery' && f.seq === receipt.seq);
  const text = provider.raw.find((raw) => { const frame = JSON.parse(raw); return frame.type === 'delivery' && frame.seq === receipt.seq; });
  assert.equal(parseEnvelope(text).bodyRaw, body);
  const o = await outsider.subscribe({ from: 0 }); await outsider.caught(o.subscription); assert.equal(outsider.deliveries().length, 0);
});

test('blob configuration validates capacity relationships and resolves private paths outside wire limits', () => {
  const config = normalizeConfig({ log: { dir: './logs' } }, join(tmpdir(), 'hub-config', 'config.json'));
  assert.equal(config.blobs.dir, resolve(tmpdir(), 'hub-config', 'logs', 'blobs')); assert.equal(config.blobs.explicitDir, false);
  const custom = normalizeConfig({ blobs: { dir: './opaque' } }, join(tmpdir(), 'hub-config', 'config.json'));
  assert.equal(custom.blobs.dir, resolve(tmpdir(), 'hub-config', 'opaque')); assert.equal(custom.blobs.explicitDir, true);
  for (const blobs of [{ chunkBytes: 512 * 1024 + 1 }, { maxObjectBytes: 4, maxTotalBytes: 3 }, { maxObjects: 0 }, { maxTotalBytes: Infinity }]) assert.throws(() => normalizeConfig({ blobs }));
});

for (const rejected of [false, true]) test(`attachment lease prevents capacity reclaim during ${rejected ? 'failed' : 'successful'} message append and then releases`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-directed-lease-'));
  const allow = { publish: ['#'], subscribe: ['#'] };
  const hub = await Hub.create(normalizeConfig({ log: { enabled: false, dir: join(directory, 'log') },
    blobs: { dir: join(directory, 'objects'), maxObjectBytes: 1, maxTotalBytes: 1, maxObjects: 1 },
    acl: { bridges: { receiver: { allow } }, credentials: { provider: { maxConnections: 3, allow } } } }));
  class LocalConnection extends EventEmitter {
    remoteAddress = '127.0.0.1'; frames = [];
    send(text) { this.frames.push(JSON.parse(text)); }
    close() { this.emit('close'); }
    async receipt(type, fields) {
      const requestToken = randomUUID(); this.emit('message', JSON.stringify({ type, ...fields, requestToken }));
      await until(() => this.frames.some((f) => f.requestToken === requestToken));
      return this.frames.find((f) => f.requestToken === requestToken);
    }
  }
  const connections = []; let releaseGate;
  t.after(async () => {
    releaseGate?.(); connections.forEach((connection) => connection.close()); await hub.stop();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true });
  });
  async function connect(bridge) {
    const connection = new LocalConnection(); connections.push(connection); hub.onConnection(connection);
    connection.emit('message', JSON.stringify({ type: 'hello', wire: '0.1', bridge, credential: 'provider' }));
    await until(() => connection.frames.some((f) => f.type === 'welcome')); return connection;
  }
  const one = await connect('adapter.one'), two = await connect('adapter.two');
  const sha256 = createHash('sha256').update(Buffer.from([1])).digest('hex');
  const object = await one.receipt('blob_begin', { size: 1, sha256 });
  await one.receipt('blob_chunk', { id: object.id, offset: 0, data: 'AQ==' }); await one.receipt('blob_commit', { id: object.id });
  const append = hub.log.append.bind(hub.log); let reached;
  const entered = new Promise((resolveEntered) => { reached = resolveEntered; });
  const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
  hub.log.append = async (entry) => {
    reached(); await gate;
    if (rejected) throw new Error('test append failed');
    return append(entry);
  };
  const pending = one.receipt('inject', { target: { principal: 'receiver' }, topic: 'arbitrary/bytes', body: {}, attachments: [object.id] });
  await entered;
  assert.equal((await two.receipt('blob_release', { id: object.id })).released, true, 'provider release remains an explicit concurrent policy');
  assert.equal((await two.receipt('blob_begin', { size: 1, sha256 })).code, 'BLOB_CAPACITY', 'append lease prevents reclaim until the transaction finishes');
  releaseGate();
  assert.equal((await pending).type, rejected ? 'error' : 'published');
  const replacement = await two.receipt('blob_begin', { size: 1, sha256 }); assert.equal(replacement.type, 'blob_result');
  assert.equal((await two.receipt('blob_status', { id: object.id })).code, 'BLOB_NOT_FOUND', 'both success and failure release the short append lease');
});
