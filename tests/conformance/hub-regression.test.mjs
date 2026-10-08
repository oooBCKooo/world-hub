import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Hub } from '../../src/hub/lib/hub.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { Acl } from '../../src/hub/lib/acl.mjs';
import { parseEnvelope, stringifyEnvelope } from '../../src/hub/lib/wire-json.mjs';
import { until, sleep, Harness } from '../helpers/hub-harness.mjs';
import { basename, dirname, join, resolve } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

class Connection extends EventEmitter {
  remoteAddress = '127.0.0.1';
  frames = [];
  raw = [];
  closed = false;
  send(text) { this.raw.push(text); this.frames.push(JSON.parse(text)); }
  close() { this.closed = true; this.emit('close'); }
  async input(frame) {
    this.emit('message', typeof frame === 'string' ? frame : JSON.stringify(frame));
    await sleep(15);
  }
}
async function isolatedMemoryHub(raw) {
  const prefix = 'peros-hub-regression-';
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const cleanup = async () => {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()), 'fixture cleanup must stay directly inside temporary storage');
    assert.ok(basename(absolute).startsWith(prefix), 'fixture cleanup must use its dedicated directory prefix');
    await rm(absolute, { recursive: true, force: true });
  };
  let hub;
  try {
    hub = await Hub.create(normalizeConfig({ ...raw,
      log: { ...raw.log, enabled: false, dir: join(directory, 'log') },
      blobs: { ...raw.blobs, dir: join(directory, 'blobs') },
    }, null));
  } catch (error) { await cleanup(); throw error; }
  const stop = hub.stop.bind(hub);
  hub.stop = async () => { try { await stop(); } finally { await cleanup(); } };
  return hub;
}
async function fixture(limits = {}) {
  const hub = await isolatedMemoryHub({ limits,
    acl: { bridges: { a: { allow: { publish: ['#'], subscribe: ['#'] } }, b: { allow: { publish: ['#'], subscribe: ['#'] } } },
      credentials: { peers: { maxConnections: 4, allow: { publish: ['#'], subscribe: ['#'] } } } } });
  async function connect(bridge, credential) {
    const conn = new Connection(); hub.onConnection(conn);
    await conn.input({ type: 'hello', wire: '0.1', bridge, ...(credential ? { credential } : {}) });
    return conn;
  }
  return { hub, connect };
}

test('ACL: a one-level grant cannot cover a multi-level filter', () => {
  const acl = new Acl(normalizeConfig({ acl: { bridges: { a: { allow: { subscribe: ['arbitrary/+'] } } } } }, null));
  assert.equal(acl.canSubscribe('a', 'arbitrary/#').ok, false);
  assert.equal(acl.canSubscribe('a', 'arbitrary/one').ok, true);
});

test('ACK: unsent/duplicate/out-of-order acknowledgements cannot fabricate progress', async () => {
  const { hub, connect } = await fixture({ maxPendingDeliveries: 2 });
  try {
    const a = await connect('a'), b = await connect('b');
    await b.input({ type: 'subscribe', filters: ['#'] });
    const subscription = b.frames.find(f => f.type === 'subscribed').subscription;
    await a.input({ type: 'publish', topic: 'anything', body: { n: 1 } });
    await a.input({ type: 'publish', topic: 'anything', body: { n: 2 } });
    await b.input({ type: 'ack', subscription, seq: [9999, 9999] });
    assert.equal(hub.snapshot().subscriptions[0].cursor, 0);
    assert.equal(hub.snapshot().subscriptions[0].pending, 2);
    await b.input({ type: 'ack', subscription, seq: [2, 2] });
    assert.equal(hub.snapshot().subscriptions[0].cursor, 0);
    assert.equal(hub.snapshot().subscriptions[0].pending, 2);
    await b.input({ type: 'ack', subscription, seq: [1] });
    assert.equal(hub.snapshot().subscriptions[0].cursor, 2);
    assert.equal(hub.snapshot().subscriptions[0].pending, 0);
  } finally { await hub.stop(); }
});

test('catch-up: newer live traffic drains after historical acknowledgements', async () => {
  const { hub, connect } = await fixture({ maxPendingDeliveries: 1 });
  try {
    const a = await connect('a');
    await a.input({ type: 'publish', topic: 'anything', body: { n: 1 } });
    const b = await connect('b');
    await b.input({ type: 'subscribe', filters: ['#'], from: 0 });
    const subscription = b.frames.find(f => f.type === 'subscribed').subscription;
    await a.input({ type: 'publish', topic: 'anything', body: { n: 2 } });
    await b.input({ type: 'ack', subscription, seq: [1] });
    await until(() => b.frames.filter(f => f.type === 'delivery').length === 2);
    assert.deepEqual(b.frames.filter(f => f.type === 'delivery').map(f => f.seq), [1, 2]);
    assert.equal(hub.snapshot().subscriptions[0].queued, 0);
    assert.equal(b.frames.some(f => f.type === 'overflow'), false);
  } finally { await hub.stop(); }
});

test('catch-up: scan completion never confirms an unacknowledged delivery', async () => {
  const { hub, connect } = await fixture({ maxPendingDeliveries: 2 });
  try {
    const a = await connect('a');
    await a.input({ type: 'publish', topic: 'anything', body: {} });
    const b = await connect('b');
    await b.input({ type: 'subscribe', filters: ['#'], from: 0 });
    assert.deepEqual(b.frames.filter(f => f.type === 'delivery').map(f => f.seq), [1]);
    assert.equal(hub.snapshot().subscriptions[0].cursor, 0);
    assert.equal(hub.snapshot().subscriptions[0].pending, 1);
    const caught = b.frames.find(f => f.type === 'caught_up');
    assert.equal(caught.through, 1);
    assert.equal(caught.cursor, 0);
  } finally { await hub.stop(); }
});

test('instances: closing an earlier peer never reuses a live identity', async () => {
  const { hub, connect } = await fixture();
  try {
    const a = await connect('a', 'peers'), b = await connect('a', 'peers');
    a.close();
    const c = await connect('a', 'peers');
    assert.notEqual(b.frames[0].bridge, c.frames[0].bridge);
    assert.equal(hub.snapshot().bridges.length, 2);
    assert.equal(b.closed, false);
  } finally { await hub.stop(); }
});

test('mod-defined channels: arbitrary new names, future topics and kinds need no hub code change', async () => {
  const { hub, connect } = await fixture();
  try {
    const a = await connect('a'), b = await connect('b');
    const name = 'new-information/' + '自由命名/never-built-into-hub';
    await a.input({ type: 'register', requestToken: 'reg-a', channels: [{ name, publish: true }] });
    assert.equal(a.frames.find(f => f.type === 'registered').requestToken, 'reg-a');
    await b.input({ type: 'register', requestToken: 'reg-b', channels: [{ name: 'new-information/#', subscribe: true }] });
    await b.input({ type: 'subscribe', filters: ['new-information/#'] });
    await a.input({ type: 'publish', topic: name, body: { kind: 'a-type-the-hub-has-never-seen', anything: ['任意程序形态'] } });
    assert.equal(b.frames.find(f => f.type === 'delivery').body.kind, 'a-type-the-hub-has-never-seen');
    assert.equal(hub.snapshot().bridges.find(f => f.bridgeId === 'a').channels[0].name, name);
  } finally { await hub.stop(); }
});

test('opaque payload: integers, escapes and whitespace are forwarded byte for byte; IDs are intact', async () => {
  const { hub, connect } = await fixture();
  try {
    const a = await connect('a'), b = await connect('b');
    const token = 't'.repeat(78), id = 'i'.repeat(121);
    await b.input({ type: 'subscribe', filters: ['#'], token });
    assert.equal(b.frames.find(f => f.type === 'subscribed').token, token);
    const body = '{ "n":9007199254740993,\n "escaped":"\\u0061", "unit":1e0 }';
    await a.input('{"type":"publish","topic":"anything","id":"' + id + '","body":' + body + '}');
    const text = b.raw.find(raw => JSON.parse(raw).type === 'delivery');
    assert.equal(parseEnvelope(text).bodyRaw, body);
    assert.equal(JSON.parse(text).id, id);
    assert.equal(parseEnvelope(stringifyEnvelope(hub.log.tail(1)[0])).bodyRaw, body);
  } finally { await hub.stop(); }
});

test('catch-up: a full window with no progress triggers a transport timeout', async () => {
  const { hub, connect } = await fixture({ maxPendingDeliveries: 1, catchUpIdleMs: 60 });
  try {
    const a = await connect('a');
    await a.input({ type: 'publish', topic: 'anything', body: {} });
    await a.input({ type: 'publish', topic: 'anything', body: {} });
    const b = await connect('b');
    await b.input({ type: 'subscribe', filters: ['#'], from: 0 });
    await until(() => b.closed);
    assert.equal(b.frames.some(f => f.code === 'CATCHUP_STALLED'), true);
  } finally { await hub.stop(); }
});

test('debug: network listeners never expose log bodies outside loopback', async (context) => {
  const address = Object.values(networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
  if (!address) return context.skip('no non-loopback IPv4 interface');
  const h = new Harness();
  try {
    await h.startHub({ configPath: resolve('examples/event-panel/hub.config.json'), extraArgs: ['--host', '0.0.0.0'] });
    const response = await fetch(`http://${address}:${h.port}/log`);
    assert.equal(response.status, 403);
    assert.equal((await fetch(h.httpBase + '/log')).status, 200);
  } finally { await h.stop(); }
});

test('catch-up timeout is rearmed after a previously acknowledged window', async () => {
  const { hub, connect } = await fixture({ maxPendingDeliveries: 1, catchUpIdleMs: 60 });
  try {
    const a = await connect('a');
    for (let n = 1; n <= 3; n++) await a.input({ type: 'publish', topic: 'anything', body: { n } });
    const b = await connect('b');
    await b.input({ type: 'subscribe', filters: ['#'], from: 0 });
    const subscription = b.frames.find(f => f.type === 'subscribed').subscription;
    await b.input({ type: 'ack', subscription, seq: [1] });
    assert.equal(b.frames.filter(f => f.type === 'delivery').length, 2);
    await until(() => b.closed);
    assert.equal(b.frames.some(f => f.code === 'CATCHUP_STALLED'), true);
  } finally { await hub.stop(); }
});

test('closed connections cannot resurrect identities or queued subscriptions', async () => {
  const { hub } = await fixture();
  try {
    const conn = new Connection(); hub.onConnection(conn);
    conn.emit('message', JSON.stringify({ type: 'hello', wire: '0.1', bridge: 'a' }));
    conn.emit('message', JSON.stringify({ type: 'subscribe', filters: ['#'] }));
    conn.close();
    await sleep(30);
    assert.equal(hub.snapshot().connections.length, 0);
    assert.equal(hub.snapshot().bridges.length, 0);
    assert.equal(hub.snapshot().subscriptions.length, 0);
    assert.equal(conn.frames.length, 0);
  } finally { await hub.stop(); }
});

test('input queues are bounded before JSON interpretation or storage', async () => {
  const { hub, connect } = await fixture({ maxQueuedFrames: 2 });
  try {
    const a = await connect('a');
    for (let i = 0; i < 10; i++) a.emit('message', JSON.stringify({ type: 'publish', topic: 'anything', body: { i } }));
    await sleep(30);
    assert.equal(a.closed, true);
    assert.equal(a.frames.some(f => f.code === 'INGRESS_OVERFLOW'), true);
    assert.equal(hub.snapshot().bridges.length, 0);
  } finally { await hub.stop(); }
});

test('mod registration: a denied direction rejects the entire declaration batch', async () => {
  const hub = await isolatedMemoryHub({
    acl: { bridges: { a: { allow: { publish: ['allowed/#'], subscribe: ['allowed/#'] } } } } });
  try {
    const a = new Connection(); hub.onConnection(a);
    await a.input({ type: 'hello', wire: '0.1', bridge: 'a' });
    await a.input({ type: 'register', requestToken: 'whole-batch', channels: [
      { name: 'allowed/one', publish: true }, { name: 'forbidden/two', publish: true },
    ] });
    assert.equal(a.frames.find(f => f.type === 'denied').requestToken, 'whole-batch');
    assert.deepEqual(hub.snapshot().bridges[0].channels, []);
    assert.equal(a.frames.some(f => f.type === 'registered'), false);
  } finally { await hub.stop(); }
});

test('frame IDs: oversized references are rejected before accepting, and legacy delivery remains accepted', async () => {
  const { hub, connect } = await fixture();
  try {
    const a = await connect('a'), b = await connect('b');
    await a.input({ type: 'publish', topic: 'anything', body: {}, id: 'i'.repeat(513), requestToken: 'bad-id' });
    assert.equal(a.frames.find(f => f.code === 'FRAME_INVALID').requestToken, 'bad-id');
    assert.equal(hub.counters.accepted, 0);
    await b.input({ type: 'subscribe', filters: ['#'], token: 'legacy', delivery: 'at_least_once' });
    assert.ok(b.frames.find(f => f.type === 'subscribed' && f.token === 'legacy'));
    await a.input({ type: 'publish', topic: 'anything', body: {} });
    assert.equal(b.frames.filter(f => f.type === 'delivery').length, 1);
    assert.equal(hub.snapshot().subscriptions[0].pending, 1, 'legacy mode keeps the same confirmation window');
  } finally { await hub.stop(); }
});
