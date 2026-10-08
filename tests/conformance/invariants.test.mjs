// conformance/invariants.test.mjs —— 枢纽的六条语义中立不变量。
//
// 这是整个项目最重要的一组测试。它验证的不是"枢纽能跑"，而是"枢纽不会变成别的东西"：
//   I1 零世界状态    枢纽只写接线配置与流水账；业务状态没有落脚点
//   I2 载荷不可读    载荷对枢纽是不透明字节：不解析、不规范、不改写、不补键
//   I3 不加载外部码  枢纽进程从不执行任何外部程序的代码
//   I4 零定时语义    枢纽没有 tick：没有桥接入时不推进任何东西
//   I5 无出站调用    枢纽不主动连任何外部程序，只应答已接入的桥
//   I6 不臆造不广播  枢纽不产生、不复制自己造的消息
//
// 每条都以"可观察事实"为证据。见《定位与边界》。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Harness, sleep, PROJECT_ROOT } from '../helpers/hub-harness.mjs';
import { assertDiagnosticContract } from './diagnostic-contract.mjs';

const CONFIG = resolve(PROJECT_ROOT, 'examples/event-panel/hub.config.json');
const REF_DIR = resolve(PROJECT_ROOT, 'src/hub');
const WIRE = '0.1';
const ALLOWED_DELIVERY_KEYS = new Set([
  'type',
  'subscription',
  'seq',
  'at',
  'topic',
  'from',
  'body',
  'id',
  'correlation',
  'replyTo',
  'headers',
  'operation',
  'target',
  'requestSeq',
  'fromPrincipal',
  'senderSession',
  'attachments',
]);

let h;
before(async () => {
  h = new Harness();
  await h.startHub({ configPath: CONFIG });
});
after(async () => {
  await h.stop();
});

/** 直说线协议的测试客户端（不经过 bridge-kit，测的是枢纽而不是 kit）。 */
async function rawOn(endpoint, bridgeId, { credential } = {}) {
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
    /** 订阅并等待补课结束。 */
    async subscribe(filters, token = 'tok') {
      api.send({ type: 'subscribe', token, filters, from: 'now' });
      const sub = await api.wait((f) => f.type === 'subscribed');
      await api.wait((f) => f.type === 'caught_up');
      return sub;
    },
    seen: [],
    track() {
      ws.addEventListener('message', (e) => {
        const f = JSON.parse(e.data);
        if (f.type === 'delivery') api.seen.push(f);
      });
      return api;
    },
    close: () => {
      try {
        ws.close(1000);
      } catch {}
    },
  };
  api.send({ type: 'hello', wire: WIRE, bridge: bridgeId, credential });
  const w = await api.wait((f) => f.type === 'welcome' || f.type === 'denied');
  assert.equal(w.type, 'welcome', `${bridgeId} 应当被接纳：${JSON.stringify(w)}`);
  api.identity = w.bridge;
  return api;
}


function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function readAllRecords(logDir) {
  const out = [];
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith('log-') || !name.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(logDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行（进程被杀）忽略 */
      }
    }
  }
  return out;
}

function ps(command) {
  return execFileSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  }).trim();
}

// ── I1 零世界状态 ────────────────────────────────────────────────────
test('I1 零世界状态：枢纽只写通讯日志与提供者释放元数据', async () => {
  const p = await rawOn(h.endpoint, 'source.ticker');
  const c = await rawOn(h.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' });
  await c.subscribe(['source/#'], 'i1');
  for (let i = 0; i < 5; i++) {
    p.send({ type: 'publish', topic: 'source/ticker', body: { i, probe: 'i1' } });
    await p.wait((f) => f.type === 'published');
  }
  await sleep(200);

  const files = walk(h.tmp);
  assert.ok(files.length > 0, '流水账应当确实落盘了');
  for (const f of files) {
    const rel = f.slice(h.logDir.length).replace(/\\/g, '/');
    assert.match(rel, /^\/(log-\d{6}\.jsonl|manifest\.json|releases\.json|blobs\/(objects\.json|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(bin|new|gc)))$/, `枢纽只允许写通讯存储文件，实际发现 ${rel}`);
  }
  const manifest = JSON.parse(readFileSync(join(h.logDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ['lastSeq', 'sealedSegmentIndex', 'sealedThrough', 'segmentIndex'],
    'manifest 只记流水账自身的续接线索',
  );
  p.close();
  c.close();
});

test('I1 零世界状态：枢纽的状态面恰好是接线图 + 订阅表 + 流水账', async () => {
  const c = await rawOn(h.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' });
  await c.subscribe(['source/#'], 'i1b');
  await sleep(150);
  const snap = await h.status();
  assert.deepEqual(
    Object.keys(snap).sort(),
    [
      'bridges',
      'connections',
      'counters',
      'hubId',
      'lastGapLogFailure',
      'lastSeq',
      'logDir',
      'logEnabled',
      'now',
      'recent',
      'startedAt',
      'storage',
      'subscriptions',
      'wireHash',
      'wireVersion',
    ],
    '现行快照只有通讯结构；新增通讯字段需说明用途并验收',
  );
  assert.ok(snap.bridges.length >= 1);
  assert.deepEqual(
    Object.keys(snap.bridges[0]).sort(),
    [
      'authenticated',
      'bridgeId',
      'channels',
      'declaredId',
      'delivered',
      'displayName',
      'principal',
      'published',
      'remoteAddress',
      'role',
      'session',
      'since',
      'subscriptions',
    ],
    '接线图上关于一座桥的字段只能有接线信息与计数',
  );
  assert.deepEqual(
    Object.keys(snap.subscriptions[0]).sort(),
    ['bridgeId', 'catchUp', 'catchUpTarget', 'cursor', 'effectiveBatchLimit', 'filters', 'id', 'lastProgressAt',
      'pending', 'queued', 'scannedUpTo', 'sentUpTo', 'windowLimit'],
    '订阅表上只能有订阅信息与游标',
  );
  assert.deepEqual(Object.keys(snap.storage).sort(), ['blobs', 'log'], 'storage only describes communication retention capacity');
  assertDiagnosticContract(snap); // Leaf purposes, evidence and communication value relationships are checked together.
  assert.equal(snap.lastGapLogFailure, null, 'no gap failure may be invented');
  c.close();
});

// ── I2 载荷不可读 ────────────────────────────────────────────────────
test('I2 载荷不可读：高熵与非常规结构的载荷原字节往返', async () => {
  const p = await rawOn(h.endpoint, 'source.ticker');
  const c = await rawOn(h.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' });
  await c.subscribe(['source/ticker'], 'i2');

  const payload = {
    secret: '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ' + 'x'.repeat(64),
    unicode: '十字路口 🚦 \u0000 零宽\u200b字符',
    nested: { deep: [{ a: null, b: [1, 2, 3], c: { d: true } }] },
    number: 1.7976931348623157e308,
    bigintish: '9007199254740993',
    'key/slash': 'slash',
    'key with space': 'space',
  };
  p.send({ type: 'publish', topic: 'source/ticker', body: payload });
  const pub = await p.wait((f) => f.type === 'published');
  const del = await c.wait((f) => f.type === 'delivery');
  assert.deepEqual(del.body, payload, '往返必须逐字段一致');

  const rec = readAllRecords(h.logDir).find((r) => r.seq === pub.seq);
  assert.ok(rec, '发布的序号必须在流水账里');
  assert.deepEqual(rec.body, payload);
  const raw = readdirSync(h.logDir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => readFileSync(join(h.logDir, n), 'utf8'))
    .join('');
  assert.ok(raw.includes(payload.secret), '高熵载荷必须以原字节写入流水账（没有被规范化/截断/丢弃）');
  p.close();
  c.close();
});

test('I2 载荷不可读：枢纽不改写信封，也不给载荷补键', async () => {
  const p = await rawOn(h.endpoint, 'source.ticker');
  const c = await rawOn(h.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' });
  await c.subscribe(['source/ticker'], 'i2b');

  p.send({
    type: 'publish',
    topic: 'source/ticker',
    body: { only: 'this' },
    id: 'my-own-id',
    correlation: 'corr-1',
    replyTo: 'reply-1',
    headers: { 'x-trace': 'abc', 'x-custom': 'keep' },
  });
  await p.wait((f) => f.type === 'published');
  const del = await c.wait((f) => f.type === 'delivery');
  assert.deepEqual(del.body, { only: 'this' }, '枢纽不得向载荷补充任何键');
  assert.equal(del.id, 'my-own-id');
  assert.equal(del.correlation, 'corr-1');
  assert.equal(del.replyTo, 'reply-1');
  assert.deepEqual(del.headers, { 'x-trace': 'abc', 'x-custom': 'keep' });
  for (const k of Object.keys(del)) {
    assert.ok(ALLOWED_DELIVERY_KEYS.has(k), `投递帧不得凭空多出字段 ${k}`);
  }
  p.close();
  c.close();
});

// ── I3 不加载外部码 ──────────────────────────────────────────────────
test('I3 不加载外部码：枢纽源码里没有动态求值/动态加载/子进程', () => {
  const files = [
    'hub-server.mjs',
    'ws-server.mjs',
    'lib/hub.mjs',
    'lib/router.mjs',
    'lib/acl.mjs',
    'lib/store.mjs',
    'lib/topic.mjs',
    'lib/wire-json.mjs',
    '..\\debug\\page.mjs',
  ];
  const banned = [
    [/\beval\s*\(/, 'eval('],
    [/new\s+Function\s*\(/, 'new Function('],
    [/\bchild_process\b/, 'child_process'],
    [/\bworker_threads\b/, 'worker_threads'],
    [/\bvm\./, 'vm 模块'],
  ];
  let checked = 0;
  for (const rel of files) {
    const p = resolve(REF_DIR, rel);
    if (!existsSync(p)) continue;
    checked++;
    const src = readFileSync(p, 'utf8');
    for (const [re, label] of banned) {
      assert.ok(!re.test(src), `${rel} 里出现了 ${label}——枢纽不得执行外部代码`);
    }
  }
  assert.ok(checked >= 7, `应当检查到枢纽的全部源文件，实际 ${checked}`);
});

test('I3 不加载外部码：枢纽进程没有子进程', async () => {
  const p = await rawOn(h.endpoint, 'source.ticker');
  await sleep(250);
  const pid = h.ready.pid;
  const count = ps(`@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").Count`);
  assert.equal(Number(count), 0, '枢纽进程不该有子进程');
  assert.equal(ps(`(Get-Process -Id ${pid}).ProcessName`).toLowerCase(), 'node');
  p.close();
});

test('I3 不加载外部码：任意载荷都不会被执行', async () => {
  const p = await rawOn(h.endpoint, 'source.ticker');
  const marker = join(h.tmp, 'pwned-by-payload.marker');
  p.send({
    type: 'publish',
    topic: 'source/ticker',
    body: {
      constructor: { prototype: { polluted: true } },
      code: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pwned')`,
      fn: 'function(){ return process.env }',
      import: 'node:child_process',
    },
  });
  await p.wait((f) => f.type === 'published');
  await sleep(400);
  assert.equal(existsSync(marker), false, '载荷内容绝不能被当作代码执行');
  const snap = await h.status();
  assert.ok(snap.bridges.length >= 1, '枢纽应仍然健康');
  p.close();
});

// ── I4 零定时语义 ────────────────────────────────────────────────────
test('I4 零定时语义：没有桥接入时枢纽不产生任何消息、序号不动', async () => {
  const h2 = new Harness();
  await h2.startHub({ configPath: CONFIG });
  try {
    const s1 = await h2.status();
    await sleep(1600);
    const s2 = await h2.status();
    assert.equal(s2.lastSeq, s1.lastSeq, '空转期间序号不得推进——枢纽没有 tick');
    assert.equal(s2.counters.accepted, 0, '枢纽不能自己产生消息');
    assert.equal(s2.counters.delivered, 0);
    assert.equal((await h2.log(50)).records.length, 0, '空转期间流水账必须为空');
  } finally {
    await h2.stop();
  }
});

test('I4 零定时语义：枢纽源码里的时间调用逐行白名单，只允许时间戳与停滞看门狗', () => {
  // 白名单是"逐行允许的精确用法"，不是"看起来像就放过"。
  // 任何新增的时间调用都必须在这里显式登记，否则测试失败——这是防跑偏的闸门。
  const ALLOWED = [
    /new Date\(\)\.toISOString\(\)/, // 时间戳（记录/快照/日志），可出现在任意表达式里
    /sub\.catchUpDeadline = Date\.now\(\) \+ CATCHUP_IDLE_MS;/,
    /if \(Date\.now\(\) > sub\.catchUpDeadline\) \{/,
    /this\.#pingTimer = setInterval\(\(\) => this\.ping\(\), pingIntervalMs\);/, // 传输层心跳，默认关闭
    /setTimeout\(\(\) => this\.#socket\.destroy\(\), 50\)\.unref\?\.\(\);/, // 关闭握手后的强制回收
    /setTimeout\(\(r\) => \{/, // 关闭流程里的等待，与业务推进无关
    /setTimeout\(resolve/,
    /sub\.idleTimer = setTimeout\(\(\) => \{/, // transport flow-control timeout, never a business tick
  ];
  const files = [
    'hub-server.mjs',
    'ws-server.mjs',
    'lib/hub.mjs',
    'lib/router.mjs',
    'lib/store.mjs',
    'lib/topic.mjs',
    'lib/acl.mjs',
  ];
  let total = 0;
  for (const rel of files) {
    const path = resolve(REF_DIR, rel);
    if (!existsSync(path)) continue;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/setInterval\s*\(|setTimeout\s*\(|Date\.now\s*\(|new Date\s*\(/.test(line)) return;
        total++;
        assert.ok(
          ALLOWED.some((re) => re.test(line.trim())),
          `${rel}:${i + 1} 出现未登记的时间调用：${line.trim()}\n` +
            '（枢纽不得按时间推进业务；通讯计时用途须在《可靠性与访问边界》及测试白名单中说明）',
        );
      });
  }
  assert.ok(total >= 8, `应当至少检查到 8 处已登记的时间调用，实际 ${total}`);
});

test('I4 零定时语义：传输层心跳默认不启用（没有桥时枢纽完全静止）', () => {
  const src = readFileSync(resolve(REF_DIR, 'hub-server.mjs'), 'utf8');
  assert.ok(
    !/pingIntervalMs\s*:/.test(src),
    '枢纽不得默认开启 WebSocket 心跳定时器；需要时由配置显式打开',
  );
});

// ── I5 无出站调用 ────────────────────────────────────────────────────
test('I5 无出站调用：枢纽不主动发起任何连接', async () => {
  const { createServer } = await import('node:http');
  const hits = [];
  const trap = createServer((req, res) => {
    hits.push(req.url);
    res.end('trap');
  });
  await new Promise((r) => trap.listen(0, '127.0.0.1', r));
  const trapPort = trap.address().port;

  const p = await rawOn(h.endpoint, 'source.ticker');
  const c = await rawOn(h.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' });
  await c.subscribe(['#'], 'i5');
  p.send({
    type: 'publish',
    topic: 'source/ticker',
    body: { probe: 'i5', callback: `http://127.0.0.1:${trapPort}/should-not-be-called` },
  });
  await p.wait((f) => f.type === 'published');
  await sleep(700);

  assert.deepEqual(hits, [], '枢纽不得对外发起任何请求');
  await new Promise((r) => trap.close(r));
  p.close();
  c.close();
});

// ── I6 不臆造不广播 ──────────────────────────────────────────────────
test('I6 不臆造：无订阅者时消息只进流水账，序号恰好 +1', async () => {
  const h2 = new Harness();
  await h2.startHub({ configPath: CONFIG });
  try {
    const producer = await rawOn(h2.endpoint, 'source.ticker');
    const before = (await h2.status()).lastSeq;
    producer.send({ type: 'publish', topic: 'source/ticker', body: { nobody: 'listening' } });
    const pub = await producer.wait((f) => f.type === 'published');
    assert.equal(pub.seq, before + 1, '一条发布只能推进一个序号：枢纽不得为它造出额外消息');
    await sleep(250);
    const after = await h2.status();
    assert.equal(after.lastSeq, pub.seq, '无订阅者时枢纽不得产生任何补发/回执消息');
    assert.equal(after.counters.delivered, 0);
    assert.equal(after.counters.accepted, 1);
    producer.close();
  } finally {
    await h2.stop();
  }
});

test('I6 不复制：同一消息对每个匹配订阅只投一次，流水账只记一条', async () => {
  const h2 = new Harness();
  await h2.startHub({ configPath: CONFIG });
  try {
    const producer = await rawOn(h2.endpoint, 'source.ticker');
    // 两个面板实例共用同一个凭据：枢纽给每条连接分配独立实例身份。
    const a = await rawOn(h2.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' }).then((c) => c.track());
    const b = await rawOn(h2.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' }).then((c) => c.track());
    assert.notEqual(a.identity, b.identity, '同一凭据的两条连接必须拿到不同实例身份');
    await a.subscribe(['source/ticker'], 'a');
    await b.subscribe(['source/ticker'], 'b');
    producer.send({ type: 'publish', topic: 'source/ticker', body: { mark: 'once' } });
    const pub = await producer.wait((f) => f.type === 'published');
    await sleep(350);
    assert.deepEqual(a.seen.map((f) => f.seq), [pub.seq], '实例 A 恰好收到一次');
    assert.deepEqual(b.seen.map((f) => f.seq), [pub.seq], '实例 B 恰好收到一次');
    assert.equal(readAllRecords(h2.logDir).filter((r) => r.seq === pub.seq).length, 1, '流水账里只有一条');
    const snap = await h2.status();
    assert.equal(snap.bridges.length, 3, '接线图上应当有 3 条独立登记');
    producer.close();
    a.close();
    b.close();
  } finally {
    await h2.stop();
  }
});

test('I6 不复制：凭据配额用完后再接入被明确拒绝', async () => {
  const h2 = new Harness();
  await h2.startHub({ configPath: CONFIG });
  try {
    const open = [];
    for (let i = 0; i < 8; i++) {
      open.push(await rawOn(h2.endpoint, 'ui.dashboard', { credential: 'ui.dashboard' }));
    }
    const ws = new WebSocket(h2.endpoint);
    const got = await new Promise((res) => {
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'hello', wire: WIRE, bridge: 'ui.dashboard', credential: 'ui.dashboard' }));
      });
      ws.addEventListener('message', (e) => res(JSON.parse(e.data)));
      ws.addEventListener('error', () => res({ type: 'socket_error' }));
      setTimeout(() => res({ type: 'timeout' }), 3000).unref?.();
    });
    assert.equal(got.type, 'denied', JSON.stringify(got));
    assert.equal(got.code, 'CREDENTIAL_QUOTA_EXCEEDED');
    for (const c of open) c.close();
  } finally {
    await h2.stop();
  }
});
