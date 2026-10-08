#!/usr/bin/env node
// 一键跑通三个程序：
//
//   1. 在临时目录起一个枢纽（用本目录的接线配置，端口改成随机空闲端口）；
//   2. 起 C（审计）——先上线的后来者，验证它能读到别人的历史；
//   3. 起 B（计费）——消费者 + 服务方；
//   4. 起 A（下单）——广播一条、定向问一次、再按游标补读一遍；
//   5. 打印 C 实际审计到的东西，然后收掉自己启动的全部进程。
//
// 每个程序的状态目录互相隔离；结束时不留下任何东西。
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const HUB_SERVER = join(ROOT, 'src/hub/hub-server.mjs');
const CONFIG = join(HERE, './hub.config.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((ok, bad) => {
    const srv = createServer();
    srv.once('error', bad);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

function start(name, args, env, sink, prefix = null) {
  const child = spawn(process.execPath, args, { cwd: HERE, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const feed = (stream, tag) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const text = prefix ? line.replace('"event"', `"program":"${prefix}","event"`) : line;
        sink.push({ name, tag, text });
        process.stdout.write(`  [${name}${tag === 'stderr' ? '!stderr' : ''}] ${line}\n`);
      }
    });
  };
  feed(child.stdout, 'out');
  feed(child.stderr, 'err');
  return child;
}

async function waitForReady(child, lines, timeoutMs, principal, event = 'ready') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = lines.find((l) => l.text.includes(`"event":"${event}"`)
      && (principal === undefined || l.text.includes(`"principal":"${principal}"`) || l.text.includes(`"program":"${principal}"`)));
    if (hit) return true;
    if (child.exitCode !== null) return false;
    await sleep(50);
  }
  return false;
}

const port = await freePort();
const workDir = await mkdtemp(join(tmpdir(), 'three-program-'));
const logDir = join(workDir, 'hub-log');
const lines = [];
const children = [];

// 演示每次都是全新的临时枢纽，所以统一从"此刻之后"起订，避免读到上次运行留下的游标。
// 生产程序一般让 B 默认用 'resume'（见 b-billing.mjs 的注释）。
const baseEnv = { ...process.env, HUB_URL: `ws://127.0.0.1:${port}/bridge`, HUB_FROM: 'now' };

console.log(`\n枢纽端口 :${port}\n临时目录 ${workDir}\n`);
console.log('─'.repeat(72));

try {
  console.log('\n▶ 1. 起枢纽');
  // --log-dir 把流水账/管理状态/附件目录全部落到本次临时目录，不污染项目里的 .hub/
  const hub = start('hub', [HUB_SERVER, '--config', CONFIG, '--port', String(port), '--log-dir', logDir], { ...process.env }, lines, 'hub');
  children.push(hub);
  const hubReady = await waitForReady(hub, lines, 15000, undefined);
  if (!hubReady) throw new Error('枢纽没有就绪：' + JSON.stringify(lines.slice(-5), null, 2));
  const ready = lines.find((l) => l.text.includes('"event":"ready"'));
  const info = JSON.parse(ready.text);
  console.log(`  ready: ${info.endpoint}  (pid ${info.pid})`);
  console.log(`  已登记桥: ${info.registeredBridges.join(', ')}`);
  console.log(`  人看的调试页: ${info.debugUrl}`);

  console.log('\n▶ 2. 起 C（审计，只订 "#"，从 0 读全部历史）');
  const c = start('C.audit', [join(HERE, './c-audit.mjs')], { ...baseEnv, HUB_CURSOR_FILE: join(workDir, 'cursor-c.json') }, lines, 'app.audit');
  children.push(c);
  if (!(await waitForReady(c, lines, 15000, 'app.audit', 'listening'))) throw new Error('C 没有完成订阅');

  console.log('\n▶ 3. 起 B（计费，订 order/new + 接定向 billing/charge）');
  const b = start('B.billing', [join(HERE, './b-billing.mjs')], { ...baseEnv, HUB_CURSOR_FILE: join(workDir, 'cursor-b.json') }, lines, 'app.billing');
  children.push(b);
  if (!(await waitForReady(b, lines, 15000, 'app.billing', 'service_ready'))) throw new Error('B 没有完成订阅');

  console.log('\n▶ 4. 起 A（下单，广播一条 → 定向问一次 → 按游标补读）');
  const a = start('A.order', [join(HERE, './a-order.mjs')], { ...baseEnv, HUB_CURSOR_FILE: join(workDir, 'cursor-a.json') }, lines, 'app.order');
  children.push(a);
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('A 未在30秒内完成通讯')), 30000);
    a.once('error', err => { clearTimeout(timer); fail(err); });
    a.once('exit', code => { clearTimeout(timer); code === 0 ? ok() : fail(new Error(`A 通讯失败，退出码${code}`)); });
  });
  console.log(`  A 退出码 ${a.exitCode}`);

  const observed = (name, event) => lines.filter(line => line.name === name)
    .map(line => { try { return JSON.parse(line.text); } catch { return null; } })
    .filter(value => value?.event === event);
  const observationDeadline = Date.now() + 5000;
  while (observed('C.audit', 'audited').length < 2 && Date.now() < observationDeadline) await sleep(25);

  console.log('\n▶ 5. 枢纽的实际流水（前 12 条）');
  const res = await fetch(`http://127.0.0.1:${port}/log?limit=60`);
  const { lastSeq, records } = await res.json();
  const messages = records.filter(record => record.kind === 'message');
  const request = messages.find(record => record.operation === 'request');
  const response = messages.find(record => record.operation === 'response');
  assert.equal(observed('A.order', 'call_answered').length, 1, '调用必须有实际应答');
  assert.equal(observed('B.billing', 'order_seen').length, 1, 'B必须实际收到广播');
  assert.equal(observed('B.billing', 'request_received').length, 1, 'B必须实际收到请求');
  assert.equal(observed('B.billing', 'responded').length, 1, 'B必须获得应答回执');
  assert.equal(messages.length, 4, '只应有两条广播、一条请求、一条应答');
  assert.ok(request && response, '请求和应答必须留存');
  assert.equal(response.requestSeq, request.seq);
  assert.deepEqual(response.target, { principal: 'app.order' });
  const history = observed('A.order', 'catchup_subscribed')[0];
  assert.ok(history, 'A必须建立历史抽取订阅');
  const replayed = observed('A.order', 'answer_in').filter(value => value.subscription === history.subscription);
  assert.deepEqual(replayed.map(value => value.seq), messages.filter(record => record.topic === 'billing/charge' && record.operation !== 'request').map(record => record.seq));
  const auditedSeqs = observed('C.audit', 'audited').map(value => value.seq);
  assert.deepEqual(auditedSeqs, messages.filter(record => (record.operation ?? 'publish') === 'publish').map(record => record.seq), 'C只有主题权限，不能旁观别人的定向对话');
  assert.equal(lines.some(line => /"event":"(?:run_failed|call_failed|connect_failed|denied|error)"/.test(line.text)), false);
  for (const r of records.slice(0, 12)) {
    console.log(`  seq=${r.seq} ${r.kind ?? 'msg'} topic=${r.topic ?? '-'} from=${r.from ?? '-'}`);
  }
  console.log(`  … 共 ${records.length} 条记录，lastSeq=${lastSeq}`);

  console.log('\n▶ 6. C 的审计结果（它只订 "#"，什么都不发）');
  const audited = lines.filter((l) => l.name === 'C.audit' && l.text.includes('"event":"audited"'));
  console.log(`  C 实时审计到 ${audited.length} 条：`);
  for (const l of audited) {
    const o = JSON.parse(l.text);
    console.log(`    seq=${o.seq} topic=${o.topic} from=${o.from} kind=${o.kind}`);
  }
  console.log(`  注：C 上线时枢纽里还没有历史，所以它先收到 caught_up(through=0)，随后靠实时投递收齐。`);
  console.log(`  后来者读历史的能力由 A 的第 3 步演示：A 退订后用 from:0 重订，seq=3 和 seq=4 被重新投递了一遍。`);

  console.log('\n▶ 7. A 与 B 的关键交互');
  for (const l of lines) {
    if (!l.text.includes('"event"')) continue;
    const o = JSON.parse(l.text);
    if (['published', 'call_answered', 'request_received', 'responded', 'order_seen', 'catchup_subscribed', 'answer_in'].includes(o.event)) {
      console.log(`  ${l.name.padEnd(10)} ${o.event.padEnd(18)} ${JSON.stringify({ ...o, at: undefined, program: undefined, event: undefined })}`);
    }
  }

  console.log('\n' + '─'.repeat(72));
  console.log('三个程序互不认识对方的实现，全部经枢纽转交；枢纽自己零业务状态。\n');
  console.log(JSON.stringify({ event: 'three_program_verification', passed: true, pids: children.map(child => child.pid),
    messageCount: messages.length, requestSeq: request.seq, responseSeq: response.seq,
    replayed: replayed.map(value => value.seq), auditBroadcastOnly: auditedSeqs }));
} finally {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  await sleep(300);
  await rm(workDir, { recursive: true, force: true });
}
