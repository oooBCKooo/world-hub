// conformance/core.test.mjs —— 枢纽的机制：背压、补课、重连、持久化、上限。
//
// 这一组测的是"十字路口在压力与异常下还立不立得住"，而不是快乐路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Harness, sleep, until, PROJECT_ROOT } from '../helpers/hub-harness.mjs';

const BASE_CONFIG = resolve(PROJECT_ROOT, 'examples/event-panel/hub.config.json');
const WIRE = '0.1';

/** 生成一份带覆盖项的临时配置（用于把窗口/上限调小，逼出边界行为）。 */
function makeConfig(overrides = {}) {
  const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8'));
  const merged = {
    ...base,
    limits: { ...base.limits, ...(overrides.limits ?? {}) },
  };
  const dir = mkdtempSync(join(tmpdir(), 'hub-cfg-'));
  const path = join(dir, 'hub.config.json');
  writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8');
  return path;
}

async function rawOn(endpoint, bridgeId, { credential, token } = {}) {
  const ws = new WebSocket(endpoint);
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
    identity: null,
    send: (f) => ws.send(JSON.stringify(f)),
    wait(match, ms = 5000) {
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
    async subscribe(filters, { token: t = 'tok', from = 'now', ack = true } = {}) {
      api.autoAck = ack;
      api.send({ type: 'subscribe', token: t, filters, from });
      const sub = await api.wait((f) => f.type === 'subscribed');
      api.hubSub = sub.subscription;
      await api.wait((f) => f.type === 'caught_up');
      return sub;
    },
    deliveries: [],
    overflow: [],
    track() {
      ws.addEventListener('message', (e) => {
        const f = JSON.parse(e.data);
        if (f.type === 'delivery') {
          api.deliveries.push(f);
          if (api.autoAck !== false) api.send({ type: 'ack', subscription: f.subscription, seq: [f.seq] });
        }
        if (f.type === 'overflow') api.overflow.push(f);
      });
      return api;
    },
    byTopic(topic) {
      return api.deliveries.filter((f) => f.topic === topic);
    },
    close: () => {
      try {
        ws.close(1000);
      } catch {}
    },
  };
  api.send({ type: 'hello', wire: WIRE, bridge: bridgeId, credential, token });
  const w = await api.wait((f) => f.type === 'welcome' || f.type === 'denied');
  assert.equal(w.type, 'welcome', `${bridgeId} 应被接纳：${JSON.stringify(w)}`);
  api.identity = w.bridge;
  return api;
}

const producer = (endpoint) => rawOn(endpoint, 'source.ticker');
const subscriber = (endpoint) => rawOn(endpoint, 'ui.dashboard', { credential: 'ui.dashboard' });

function logRecords(logDir) {
  const out = [];
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith('log-') || !name.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(logDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行 */
      }
    }
  }
  return out;
}

// ── 背压 ──────────────────────────────────────────────────────────────
test('背压：订阅者不确认 → 窗口满后停止投递并上报缺口，不静默丢弃', async () => {
  const h = new Harness();
  await h.startHub({ configPath: makeConfig({ limits: { maxPendingDeliveries: 3 } }) });
  try {
    const p = await producer(h.endpoint);
    const c = await subscriber(h.endpoint).then((x) => x.track());
    await c.subscribe(['source/ticker'], { ack: false }); // 故意不确认

    for (let i = 0; i < 12; i++) {
      p.send({ type: 'publish', topic: 'source/ticker', body: { i } });
      await p.wait((f) => f.type === 'published');
    }
    await sleep(400);

    assert.ok(c.deliveries.length <= 3, `未确认时投递数必须被窗口挡住，实际 ${c.deliveries.length}`);
    assert.ok(c.overflow.length >= 1, '溢出的部分必须上报缺口，而不是静默丢弃');
    const gap = c.overflow[0];
    assert.ok(Array.isArray(gap.dropped) && gap.dropped[0] <= gap.dropped[1], JSON.stringify(gap));
    assert.ok(gap.reason.length > 0, '缺口必须说明原因');

    const gaps = logRecords(h.logDir).filter((r) => r.kind === 'gap');
    assert.ok(gaps.length >= 1, '缺口必须写进流水账，补课时才有据可查');
    assert.equal(gaps[0].subscriptionId, c.hubSub);

    // 确认之后窗口重新打开，投递恢复。
    const before = c.deliveries.length;
    c.autoAck = true;
    c.send({ type: 'ack', subscription: c.hubSub, seq: c.deliveries.map((d) => d.seq) });
    await sleep(150);
    p.send({ type: 'publish', topic: 'source/ticker', body: { after: 'ack' } });
    await until(async () => c.deliveries.length > before, { what: 'delivery resumes after ack' });
    assert.ok(c.deliveries.some((d) => d.body?.after === 'ack'), '确认后应立即恢复投递');
    p.close();
    c.close();
  } finally {
    await h.stop();
  }
});

test('背压：窗口满时流程账里记录了 pending 占用，可观测', async () => {
  const h = new Harness();
  await h.startHub({ configPath: makeConfig({ limits: { maxPendingDeliveries: 2 } }) });
  try {
    const p = await producer(h.endpoint);
    const c = await subscriber(h.endpoint).then((x) => x.track());
    await c.subscribe(['source/ticker'], { ack: false });
    for (let i = 0; i < 6; i++) {
      p.send({ type: 'publish', topic: 'source/ticker', body: { i } });
      await p.wait((f) => f.type === 'published');
    }
    await sleep(300);
    const snap = await h.status();
    const sub = snap.subscriptions.find((s) => s.id === c.hubSub);
    assert.equal(sub.pending, 2, '窗口占用必须如实反映在订阅表上');
    assert.ok(snap.counters.dropped > 0, '丢弃计数必须如实增加');
    p.close();
    c.close();
  } finally {
    await h.stop();
  }
});

// ── 补课 ──────────────────────────────────────────────────────────────
test('补课：小窗口下大量历史也能补齐，且不重复不丢序', async () => {
  const h = new Harness();
  await h.startHub({ configPath: makeConfig({ limits: { maxPendingDeliveries: 2 } }) });
  try {
    const p = await producer(h.endpoint);
    const N = 40;
    for (let i = 0; i < N; i++) {
      p.send({ type: 'publish', topic: 'source/ticker', body: { n: i } });
      await p.wait((f) => f.type === 'published');
    }
    const c = await subscriber(h.endpoint).then((x) => x.track());
    await c.subscribe(['source/ticker'], { from: 0 });
    await until(async () => c.deliveries.filter((d) => typeof d.body?.n === 'number').length >= N, {
      what: `${N} 条补课`,
      timeoutMs: 15000,
    });
    await sleep(200);
    const nums = c.deliveries.filter((d) => typeof d.body?.n === 'number').map((d) => d.body.n);
    assert.deepEqual(nums, Array.from({ length: N }, (_, i) => i), '补课必须按序且不重不漏');
    p.close();
    c.close();
  } finally {
    await h.stop();
  }
});

test('补课：提供者释放的历史被轮转后明确告知截断，不假装补齐', async () => {
  const h = new Harness();
  // 只有提供者明确释放的历史才允许轮转；尚受保护信息不能被窗口淘汰。
  const cfg = makeConfig({ limits: { maxPendingDeliveries: 8, maxCatchUpMessages: 2 } });
  const raw = JSON.parse(readFileSync(cfg, 'utf8'));
  raw.log = { ...raw.log, segmentMaxBytes: 1024, segmentMaxCount: 2 };
  writeFileSync(cfg, JSON.stringify(raw, null, 2), 'utf8');
  await h.startHub({ configPath: cfg });
  try {
    const p = await producer(h.endpoint);
    for (let i = 0; i < 40; i++) {
      p.send({ type: 'publish', topic: 'source/ticker', body: { pad: 'x'.repeat(200), i } });
      const accepted = await p.wait((f) => f.type === 'published');
      p.send({ type: 'release', seq: [accepted.seq], requestToken: `release-${i}` });
      const released = await p.wait((f) => f.type === 'released');
      assert.deepEqual(released.seq, [accepted.seq]);
    }
    const c = await subscriber(h.endpoint).then((x) => x.track());
    c.send({ type: 'subscribe', token: 'old', filters: ['source/ticker'], from: 1 });
    let sawTruncated = false;
    c.ws.addEventListener('message', (e) => {
      const f = JSON.parse(e.data);
      if (f.type === 'catchup_truncated') sawTruncated = true;
    });
    await sleep(900);
    const sub = (await h.status()).subscriptions.find((s) => s.bridgeId === c.identity);
    assert.ok(sub, '订阅应当存在');
    assert.ok(sawTruncated, '保留窗口缺失必须明确报告，推进游标不能代替缺口通知');
    p.close();
    c.close();
  } finally {
    await h.stop();
  }
});

// ── 重连与游标 ────────────────────────────────────────────────────────
test('重连：凭游标补齐掉线期间的消息，且不重复收到已确认的', async () => {
  const h = new Harness();
  await h.startHub({ configPath: BASE_CONFIG });
  try {
    const p = await producer(h.endpoint);
    const c1 = await subscriber(h.endpoint).then((x) => x.track());
    await c1.subscribe(['source/ticker'], { from: 'now' });
    p.send({ type: 'publish', topic: 'source/ticker', body: { mark: 'before-drop' } });
    await until(async () => c1.byTopic('source/ticker').length === 1, { what: 'first delivery' });
    const lastSeq = c1.deliveries[0].seq;
    c1.send({ type: 'ack', subscription: c1.hubSub, seq: [lastSeq] });
    await sleep(150);
    c1.close(); // 掉线
    await sleep(200);

    // 掉线期间继续产生消息
    for (let i = 0; i < 3; i++) {
      p.send({ type: 'publish', topic: 'source/ticker', body: { mark: `during-${i}` } });
      await p.wait((f) => f.type === 'published');
    }

    // 重连：从已确认的游标继续
    const c2 = await subscriber(h.endpoint).then((x) => x.track());
    await c2.subscribe(['source/ticker'], { from: lastSeq });
    await until(async () => c2.byTopic('source/ticker').length >= 3, { what: 'catch-up after reconnect', timeoutMs: 8000 });
    await sleep(200);
    const marks = c2.byTopic('source/ticker').map((d) => d.body.mark);
    assert.ok(!marks.includes('before-drop'), `不得重复投递已确认的消息：${JSON.stringify(marks)}`);
    assert.deepEqual(marks, ['during-0', 'during-1', 'during-2'], '掉线期间的消息必须按序补齐');
    p.close();
    c2.close();
  } finally {
    await h.stop();
  }
});

// ── 持久化 ────────────────────────────────────────────────────────────
test('持久化：枢纽重启后老消息仍在，新桥凭游标可补到', async () => {
  const h = new Harness({ keepTmp: true });
  const ready = await h.startHub({ configPath: BASE_CONFIG });
  const logDir = h.logDir;
  const tmp = h.tmp;
  let lastSeq;
  try {
    const p = await producer(h.endpoint);
    for (let i = 0; i < 4; i++) {
      p.send({ type: 'publish', topic: 'source/ticker', body: { durable: i } });
      await p.wait((f) => f.type === 'published');
    }
    lastSeq = (await h.status()).lastSeq;
    assert.equal(lastSeq, 4, '应当恰好写了 4 条');
    p.close();
  } finally {
    await h.stop();
  }

  // 用同一个流水账目录重启：模拟枢纽崩溃/重启后客户端继续用旧游标。
  const h2 = new Harness({ logDir, keepTmp: true });
  h2.tmp = tmp;
  try {
    const ready2 = await h2.startHub({ configPath: BASE_CONFIG, isolateLog: false });
    assert.equal(ready2.logDir, logDir, '必须复用同一流水账目录');
    const s = await h2.status();
    assert.equal(s.bridges.length, 0, '重启后不该有任何桥');
    assert.equal(s.lastSeq, lastSeq, '序号必须延续，不能倒退');
    const c = await subscriber(h2.endpoint).then((x) => x.track());
    await c.subscribe(['source/ticker'], { from: 0 });
    await until(async () => c.byTopic('source/ticker').filter((d) => typeof d.body?.durable === 'number').length >= 4, {
      what: '历史消息从磁盘补回',
      timeoutMs: 8000,
    });
    assert.deepEqual(
      c.byTopic('source/ticker').filter((d) => typeof d.body?.durable === 'number').map((d) => d.body.durable),
      [0, 1, 2, 3],
      '重启前写入的消息必须能补齐',
    );
    c.close();
  } finally {
    await h2.stop();
    const { rmSync } = await import('node:fs');
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

// ── 上限 ──────────────────────────────────────────────────────────────
test('上限：每桥订阅数超限被拒', async () => {
  const h = new Harness();
  await h.startHub({ configPath: makeConfig({ limits: { maxSubscriptionsPerBridge: 2 } }) });
  try {
    const c = await subscriber(h.endpoint).then((x) => x.track());
    await c.subscribe(['source/ticker'], { token: 's1' });
    await c.subscribe(['source/sensor-a'], { token: 's2' });
    c.send({ type: 'subscribe', token: 's3', filters: ['source/sensor-b'], from: 'now' });
    const err = await c.wait((f) => f.type === 'error');
    assert.equal(err.code, 'TOO_MANY_SUBSCRIPTIONS');
    c.close();
  } finally {
    await h.stop();
  }
});

test('上限：单条订阅的过滤器数量超限被拒', async () => {
  const h = new Harness();
  await h.startHub({ configPath: makeConfig({ limits: { maxFiltersPerSubscription: 2 } }) });
  try {
    const c = await subscriber(h.endpoint).then((x) => x.track());
    c.send({ type: 'subscribe', token: 'many', filters: ['a/#', 'b/#', 'c/#'], from: 'now' });
    const err = await c.wait((f) => f.type === 'error');
    assert.equal(err.code, 'TOO_MANY_FILTERS');
    c.close();
  } finally {
    await h.stop();
  }
});

test('上限：载荷超限被拒（限额来自配置）', async () => {
  const h = new Harness();
  await h.startHub({ configPath: makeConfig({ limits: { maxPayloadBytes: 512 } }) });
  try {
    const p = await producer(h.endpoint);
    p.send({ type: 'publish', topic: 'source/ticker', body: { pad: 'x'.repeat(600) } });
    const d = await p.wait((f) => f.type === 'denied');
    assert.equal(d.code, 'PAYLOAD_TOO_LARGE');
    assert.match(d.message, /limit is 512/);
    p.close();
  } finally {
    await h.stop();
  }
});

test('上限：误报凭据被拒（token 校验真的在起作用）', async () => {
  // 造一份带 token 的配置，验证错误 token 会被拒。
  const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8'));
  base.acl.bridges['source.ticker'] = {
    token: 'correct-horse',
    allow: { publish: ['source/ticker/#'], subscribe: ['cmd/ticker'] },
  };
  delete base.acl.credentials;
  base.acl.credentials = { 'ui.dashboard': { maxConnections: 2, allow: { publish: ['cmd/#'], subscribe: ['#'] } } };
  const dir = mkdtempSync(join(tmpdir(), 'hub-token-'));
  const path = join(dir, 'hub.config.json');
  writeFileSync(path, JSON.stringify(base, null, 2), 'utf8');

  const h = new Harness();
  await h.startHub({ configPath: path });
  try {
    await assert.rejects(
      () => rawOn(h.endpoint, 'source.ticker', { token: 'wrong' }),
      /BRIDGE_TOKEN_REJECTED/,
      '错误 token 必须被拒',
    );
    const ok = await rawOn(h.endpoint, 'source.ticker', { token: 'correct-horse' });
    assert.ok(ok.identity);
    ok.close();
  } finally {
    await h.stop();
  }
});
