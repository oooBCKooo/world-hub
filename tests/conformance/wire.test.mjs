// conformance/wire.test.mjs —— 线协议与桥契约的一致性。
//
// 每个用例自己拉起一个枢纽（独立进程），跑完自己收摊。
// 验证《通讯契约》中独立桥实现可观察到的线协议行为。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Harness, sleep, until, PROJECT_ROOT } from '../helpers/hub-harness.mjs';

const CONFIG = resolve(PROJECT_ROOT, 'examples/event-panel/hub.config.json');
const WIRE = '0.1';

/** 极简测试客户端：直接说线协议，不经过 bridge-kit（这样才是测协议本身）。 */
async function connectRaw(url, { bridge, token, credential, role = 'both', wire = WIRE } = {}) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.match(f));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(f);
    else inbox.push(f);
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('connect failed')), { once: true });
  });
  const api = {
    ws,
    send: (f) => ws.send(JSON.stringify(f)),
    wait(match, ms = 4000) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { match, resolve: res };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) waiters.splice(k, 1);
          rej(new Error('timeout waiting for frame'));
        }, ms).unref?.();
      });
    },
    hello: async () => {
      api.send({ type: 'hello', wire, bridge, credential, token, role });
      return api.wait((f) => f.type === 'welcome' || f.type === 'denied');
    },
    close: () => {
      try {
        ws.close(1000);
      } catch {}
    },
  };
  return api;
}

let h;
before(async () => {
  h = new Harness();
  await h.startHub({ configPath: CONFIG });
});
after(async () => {
  await h.stop();
});

test('握手：welcome 带回枢纽身份、线版本、契约哈希与权威 lastSeq', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.sensor-a' });
  const w = await c.hello();
  assert.equal(w.type, 'welcome');
  assert.equal(w.hubWire, WIRE);
  assert.match(w.wireHash, /^[0-9a-f]{16}$/);
  assert.equal(w.bridge, 'source.sensor-a');
  assert.ok(Number.isInteger(w.lastSeq));
  assert.ok(w.limits && Number.isInteger(w.limits.maxPendingDeliveries));
  c.close();
});

test('握手前发别的帧：HELLO_REQUIRED', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.sensor-a' });
  c.send({ type: 'publish', topic: 'source/sensor-a', body: {} });
  const err = await c.wait((f) => f.type === 'error');
  assert.equal(err.code, 'HELLO_REQUIRED');
  c.close();
});

test('线协议版本不符：拒绝并关闭', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.sensor-a', wire: '9.9' });
  const d = await c.hello();
  assert.equal(d.type, 'denied');
  assert.equal(d.code, 'WIRE_VERSION_UNSUPPORTED');
  c.close();
});

test('未在接线配置里登记的桥：拒绝（默认拒绝）', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'stranger.bridge' });
  const d = await c.hello();
  assert.equal(d.type, 'denied');
  assert.equal(d.code, 'BRIDGE_NOT_REGISTERED');
  c.close();
});

test('非法桥标识：拒绝', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'Bad_ID!' });
  const d = await c.hello();
  assert.equal(d.code, 'BRIDGE_ID_INVALID');
  c.close();
});

test('发布 → 权威序号 → 投递 → 确认，链路闭合', async () => {
  const p = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await p.hello();
  const c = await connectRaw(h.endpoint, { bridge: 'ui.dashboard', credential: 'ui.dashboard' });
  await c.hello();
  c.send({ type: 'subscribe', token: 't1', filters: ['source/ticker'], from: 'now' });
  const sub = await c.wait((f) => f.type === 'subscribed');
  assert.equal(sub.token, 't1', 'subscribed 必须回带请求标识');
  await c.wait((f) => f.type === 'caught_up');

  p.send({ type: 'publish', topic: 'source/ticker', body: { kind: 'count', value: 7 } });
  const pub = await p.wait((f) => f.type === 'published');
  const del = await c.wait((f) => f.type === 'delivery');
  assert.equal(del.seq, pub.seq);
  assert.equal(del.topic, 'source/ticker');
  assert.equal(del.from, 'source.ticker');
  assert.equal(del.body.value, 7);
  c.send({ type: 'ack', subscription: sub.subscription, seq: [del.seq] });
  await sleep(150);
  const snap = await h.status();
  const serverSub = snap.subscriptions.find((s) => s.id === sub.subscription);
  assert.equal(serverSub.cursor, del.seq, '确认后枢纽侧游标推进');
  p.close();
  c.close();
});

test('主题过滤：# 匹配多层，+ 只匹配一层，不匹配的不投', async () => {
  // 用 ui.dashboard 作发布者：它的接线规则允许发布 cmd/#，这里临时给它加大权限不现实，
  // 所以改用 source.sensor-a（可发 source/sensor-a/#）来构造真实的通配符层级。
  const p = await connectRaw(h.endpoint, { bridge: 'source.sensor-a' });
  await p.hello();
  const c = await connectRaw(h.endpoint, { bridge: 'ui.dashboard', credential: 'ui.dashboard' });
  await c.hello();
  c.send({ type: 'subscribe', token: 'hash', filters: ['source/sensor-a/#'], from: 'now' });
  const sub = await c.wait((f) => f.type === 'subscribed');
  await c.wait((f) => f.type === 'caught_up');

  p.send({ type: 'publish', topic: 'source/sensor-a', body: { marker: 'one' } });
  const d1 = await c.wait((f) => f.type === 'delivery' && f.body?.marker === 'one');
  p.send({ type: 'publish', topic: 'source/sensor-a/deep/nested', body: { marker: 'deep' } });
  const d2 = await c.wait((f) => f.type === 'delivery' && f.body?.marker === 'deep');
  p.send({ type: 'publish', topic: 'source/sensor-b', body: { marker: 'no-match' } });
  await sleep(300);
  assert.equal(d1.topic, 'source/sensor-a');
  assert.equal(d2.topic, 'source/sensor-a/deep/nested');
  c.send({ type: 'ack', subscription: sub.subscription, seq: [d1.seq, d2.seq] });

  // + 只匹配恰好一层
  const c2 = await connectRaw(h.endpoint, { bridge: 'ui.dashboard', credential: 'ui.dashboard' });
  await c2.hello();
  const plusSeen = [];
  c2.ws.addEventListener('message', (e) => {
    const f = JSON.parse(e.data);
    if (f.type === 'delivery' && f.body?.marker) plusSeen.push(f.body.marker);
  });
  c2.send({ type: 'subscribe', token: 'plus', filters: ['source/+'], from: 'now' });
  await c2.wait((f) => f.type === 'subscribed');
  await c2.wait((f) => f.type === 'caught_up');
  p.send({ type: 'publish', topic: 'source/sensor-a', body: { marker: 'single' } });
  p.send({ type: 'publish', topic: 'source/sensor-a/deep', body: { marker: 'double' } });
  await sleep(400);
  assert.deepEqual(plusSeen, ['single'], `got=${JSON.stringify(plusSeen)}`);

  p.close();
  c.close();
  c2.close();
});

test('载荷必须是非空 JSON 对象；非对象被拒', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await c.hello();
  for (const bad of ['not-an-object', 42, [1, 2], null]) {
    c.send({ type: 'publish', topic: 'source/ticker', body: bad });
    const d = await c.wait((f) => f.type === 'denied');
    assert.equal(d.code, 'BODY_NOT_OBJECT', `body=${JSON.stringify(bad)}`);
  }
  c.close();
});

test('非法主题被拒（空段、空白、通配符出现在发布侧）', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await c.hello();
  for (const bad of ['', 'a//b', 'has space', 'wild/#', 'wild/+']) {
    c.send({ type: 'publish', topic: bad, body: {} });
    const d = await c.wait((f) => f.type === 'denied');
    assert.equal(d.code, 'TOPIC_INVALID', `topic=${JSON.stringify(bad)}`);
  }
  c.close();
});

test('权限：发布到未授权主题被拒（默认拒绝，不做通配放行）', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await c.hello();
  c.send({ type: 'publish', topic: 'source/sensor-a', body: { spoof: true } });
  const d = await c.wait((f) => f.type === 'denied');
  assert.equal(d.code, 'PUBLISH_DENIED');
  c.close();
});

test('权限：订阅未被规则覆盖的过滤器被拒', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await c.hello();
  // source.ticker 只被允许订阅 cmd/ticker
  c.send({ type: 'subscribe', token: 'nope', filters: ['source/#'], from: 'now' });
  const d = await c.wait((f) => f.type === 'denied');
  assert.equal(d.code, 'SUBSCRIBE_DENIED');
  c.close();
});

test('权限：更宽的过滤器不被更窄的规则覆盖（game/# 不覆盖 #）', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await c.hello();
  c.send({ type: 'subscribe', token: 'nope2', filters: ['#'], from: 'now' });
  const d = await c.wait((f) => f.type === 'denied');
  assert.equal(d.code, 'SUBSCRIBE_DENIED');
  c.close();
});

test('游标越界：from > lastSeq 被夹紧并明确告知', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'ui.dashboard', credential: 'ui.dashboard' });
  await c.hello();
  c.send({ type: 'subscribe', token: 'ahead', filters: ['source/#'], from: 10_000_000 });
  const err = await c.wait((f) => f.type === 'error');
  assert.equal(err.code, 'CURSOR_AHEAD');
  const sub = await c.wait((f) => f.type === 'subscribed');
  assert.ok(sub.cursor <= 10_000_000);
  c.close();
});

test('解订不属于自己的订阅被拒', async () => {
  const a = await connectRaw(h.endpoint, { bridge: 'ui.dashboard', credential: 'ui.dashboard' });
  await a.hello();
  a.send({ type: 'subscribe', token: 't', filters: ['source/#'], from: 'now' });
  await a.wait((f) => f.type === 'subscribed');
  const b = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await b.hello();
  b.send({ type: 'unsubscribe', subscription: 'sub-1' });
  const err = await b.wait((f) => f.type === 'error');
  assert.equal(err.code, 'SUBSCRIPTION_NOT_FOUND');
  a.close();
  b.close();
});

test('未知帧类型：明确报错，不静默丢弃', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await c.hello();
  c.send({ type: 'definitely_not_a_frame' });
  const err = await c.wait((f) => f.type === 'error');
  assert.equal(err.code, 'FRAME_UNKNOWN');
  c.close();
});

test('同一 bridgeId 重复接入：接管旧连接（重连语义）', async () => {
  const first = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await first.hello();
  const firstClosed = new Promise((res) => first.ws.addEventListener('close', (e) => res(e), { once: true }));
  const second = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  const w = await second.hello();
  assert.equal(w.type, 'welcome');
  const e = await firstClosed;
  assert.ok(e.code === 1000 || e.code === 1006);
  const snap = await h.status();
  assert.equal(snap.bridges.filter((b) => b.bridgeId === 'source.ticker').length, 1, '接线图上只有一条登记');
  second.close();
});

test('补课：新桥凭游标拿到接入之前的消息，且不重复', async () => {
  const p = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await p.hello();
  const before = (await h.status()).lastSeq;
  for (let i = 0; i < 5; i++) {
    p.send({ type: 'publish', topic: 'source/ticker', body: { marker: `m${i}` } });
    await p.wait((f) => f.type === 'published');
  }

  const late = await connectRaw(h.endpoint, { bridge: 'ui.dashboard', credential: 'ui.dashboard' });
  await late.hello();
  const got = [];
  late.ws.addEventListener('message', (e) => {
    const f = JSON.parse(e.data);
    if (f.type === 'delivery' && f.body?.marker) got.push(f.body.marker);
  });
  late.send({ type: 'subscribe', token: 'back', filters: ['source/ticker'], from: before });
  const sub = await late.wait((f) => f.type === 'subscribed');
  await late.wait((f) => f.type === 'caught_up', 8000);
  assert.deepEqual(got, ['m0', 'm1', 'm2', 'm3', 'm4'], `got=${JSON.stringify(got)}`);
  assert.equal(new Set(got).size, got.length, '补课不得重复投递');
  late.send({ type: 'ack', subscription: sub.subscription, seq: [] });
  p.close();
  late.close();
});

test('流水账：序号严格递增，且记录发布者与大小', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'source.ticker' });
  await c.hello();
  c.send({ type: 'publish', topic: 'source/ticker', body: { probe: 'log-check' } });
  const pub = await c.wait((f) => f.type === 'published');
  const log = await h.log(500);
  const rec = log.records.find((r) => r.seq === pub.seq);
  assert.ok(rec, '发布的序号必须在流水账里找得到');
  assert.equal(rec.topic, 'source/ticker');
  assert.equal(rec.from, 'source.ticker');
  assert.ok(rec.bytes > 0);
  assert.equal(rec.body.probe, 'log-check');
  const seqs = log.records.filter((r) => typeof r.seq === 'number').map((r) => r.seq);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), '序号严格递增');
  c.close();
});

test('桥断开后：枢纽侧订阅被清理', async () => {
  const c = await connectRaw(h.endpoint, { bridge: 'ui.dashboard', credential: 'ui.dashboard' });
  await c.hello();
  c.send({ type: 'subscribe', token: 'z', filters: ['source/#'], from: 'now' });
  await c.wait((f) => f.type === 'subscribed');
  await until(async () => (await h.status()).subscriptions.length > 0, { what: 'subscription registered' });
  c.close();
  await until(
    async () => (await h.status()).subscriptions.every((s) => s.bridgeId !== 'ui.dashboard'),
    { what: 'subscription cleaned up' },
  );
});
