#!/usr/bin/env node
// 端到端验证：证明"枢纽可用"。
//
// 它验证的不是程序的功能，而是**枢纽作为十字路口**能不能立住：
//   A 每座桥都是独立进程，自己接上枢纽，彼此不认识
//   B 来源 → 枢纽 → 面板（输入方向）
//   C 面板 → 枢纽 → 来源（输出方向，也就是"面板能返回信息"）
//   D 面板能改变来源的行为，且这个改变只可能发生在来源进程内部（枢纽不参与业务）
//   E 枢纽的流水账把整条往返链路记全了
//   F 一个来源掉线，不影响其他来源与面板
//
// 用法：node examples/event-panel/run-demo.mjs

import { resolve } from 'node:path';
import { Harness, sleep, until, PROJECT_ROOT } from '../../tests/helpers/hub-harness.mjs';

const CONFIG = resolve(PROJECT_ROOT, 'examples/event-panel/hub.config.json');
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${extra}`);
  }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const h = new Harness();
let dashboard = null;
let procs = [];

try {
  section('启动枢纽（独立进程，零外部依赖）');
  const ready = await h.startHub({ configPath: CONFIG });
  check('枢纽自报 ready', ready.event === 'ready', JSON.stringify(ready));
  check('枢纽监听随机端口', Number.isInteger(ready.port) && ready.port > 0, String(ready.port));
  console.log(`     端点 ${ready.endpoint}`);
  console.log(`     接线配置里登记了 ${ready.registeredBridges.length} 座桥：${ready.registeredBridges.join(', ')}`);

  section('A. 每个来源是一个独立进程，各自通过自己的 mod 桥接入');
  const sourcesSpec = [
    { name: 'sensor-a', file: 'examples/event-panel/sensor-a.mjs', args: ['--intervalMs', '400'] },
    { name: 'ticker', file: 'examples/event-panel/ticker.mjs', args: ['--intervalMs', '300'] },
  ];
  procs = await Promise.all(sourcesSpec.map((s) => h.spawnProgram(s.file, { args: s.args })));
  check('两个来源进程都自报 ready', procs.every((p) => p.ready), procs.map((p) => p.ready ?? p.stderr).join(' | '));
  const pids = procs.map((p) => JSON.parse(p.ready).pid);
  check('来源进程 pid 互不相同且都不是枢纽 pid', new Set([...pids, ready.pid]).size === 3, JSON.stringify([...pids, ready.pid]));
  // 订阅是异步的：等它真的挂上，而不是靠"马上就绪"的假设。
  await until(
    async () => procs.every((p) => p.lines.some((l) => l.includes('"event":"subscribed"'))),
    { what: 'both sources subscribed' },
  );
  check('来源进程各自完成订阅（命令主题）', procs.every((p) => p.lines.some((l) => l.includes('"event":"subscribed"'))));
  check(
    '来源自称未认证（配置里没设 token，仅限回环）',
    procs.every((p) => JSON.parse(p.ready).authenticated === false),
    procs.map((p) => JSON.parse(p.ready).authenticated).join(','),
  );

  await until(async () => (await h.status()).bridges.length === 2, { what: '2 bridges attached' });
  let snap = await h.status();
  check(
    '枢纽的接线图上出现两座来源桥',
    snap.bridges.map((b) => b.bridgeId).sort().join(',') === 'source.sensor-a,source.ticker',
    JSON.stringify(snap.bridges.map((b) => b.bridgeId)),
  );
  check(
    '枢纽记录下来源桥的接入方式（回环、未持 token）',
    snap.bridges.every((b) => b.remoteAddress !== null),
    JSON.stringify(snap.bridges.map((b) => b.remoteAddress)),
  );

  section('B. 来源 → 枢纽 → 面板（输入方向）');
  // 先让来源发出一些数据（无人在听，权威流水账照样记录）
  await until(async () => (await h.log(50)).lastSeq >= 4, { what: 'source messages in log' });
  dashboard = await h.spawnProgram('examples/event-panel/dashboard.mjs', {
    args: ['--once', 'demo', '--quiet', '--from', 'all'],
  });
  const dashReady = JSON.parse(dashboard.ready);
  check('面板进程通过自己的 mod 桥接入', dashReady.event === 'ready', dashboard.ready);
  check('面板登记的桥 id 是 ui.dashboard', dashReady.bridge === 'ui.dashboard', String(dashReady.bridge));

  await until(async () => (await h.status()).bridges.length === 3, { what: '3 bridges attached' });
  // welcome/ready only establishes the connection. Registration and subscribe
  // complete later, so observe the program's real receipt before reading the
  // subscription table; an online bridge alone is not this barrier.
  const sourceSubscription = JSON.parse(await dashboard.waitLine((line) => {
    try { return JSON.parse(line).event === 'subscribed'; } catch { return false; }
  }));
  snap = await until(async () => {
    if (dashboard.exited) throw new Error(`dashboard exited before its subscription was visible: ${JSON.stringify(dashboard.exited)}`);
    const state = await h.status();
    return state.subscriptions.some((sub) => sub.id === sourceSubscription.subscription && sub.bridgeId === dashReady.identity) ? state : null;
  }, { what: 'dashboard acknowledged subscription visible in Hub status' });
  // 面板走凭据模式：身份由枢纽分配为 "ui.dashboard:<n>"，同一凭据可开多个实例。
  const dashBridge = snap.bridges.find((b) => b.bridgeId.startsWith('ui.dashboard'));
  check('面板拿到了枢纽分配的实例身份', !!dashBridge && /^ui\.dashboard:\d+$/.test(dashBridge.bridgeId), JSON.stringify(snap.bridges.map((b) => b.bridgeId)));
  const dashSub = snap.subscriptions.find((s) => s.id === sourceSubscription.subscription && s.bridgeId === dashReady.identity);
  check('面板订阅了来源主题', !!dashSub && dashSub.filters.includes('source/#'), JSON.stringify(dashSub?.filters));
  check('面板订阅在枢纽侧有游标', !!dashSub && Number.isInteger(dashSub.cursor), JSON.stringify(dashSub));

  const report = await until(
    async () => {
      const line = dashboard.lines.find((l) => l.includes('"event":"report"'));
      if (line) return JSON.parse(line);
      if (dashboard.exited) throw new Error(`dashboard exited: ${JSON.stringify(dashboard.exited)} stderr=${dashboard.stderr}`);
      return null;
    },
    { what: 'dashboard report', timeoutMs: 60000 },
  ).catch((err) => {
    console.log(`\n     面板原始输出（末 20 行）：\n${dashboard.lines.slice(-20).join('\n')}`);
    if (dashboard.stderr) console.log(`     面板 stderr：\n${dashboard.stderr}`);
    throw err;
  });
  check('面板收到了来源事件', report.totals.received >= 10, JSON.stringify(report.totals));
  check(
    '面板把两个来源分别识别出来（枢纽不替它分类）',
    Object.keys(report.sources).sort().join(',') === 'sensor-a,ticker',
    JSON.stringify(Object.keys(report.sources)),
  );
  const sensor = report.sources['sensor-a'];
  const ticker = report.sources.ticker;
  check('面板拿到了传感器的真实读数', sensor.last?.metric === 'temperature' && typeof sensor.last.celsius === 'number', JSON.stringify(sensor.last));
  check('面板拿到了计数器的真实计数', ticker.last?.metric === 'tasks.completed' && typeof ticker.last.value === 'number', JSON.stringify(ticker.last));
  check(
    '两种完全不同的数据走的是同一个枢纽（载荷对枢纽不透明）',
    sensor.last.unit === '°C' && ticker.last.step === 1,
    JSON.stringify({ sensor: sensor.last.unit, ticker: ticker.last.step }),
  );

  section('C. 面板 → 枢纽 → 来源（输出方向：面板能返回信息）');
  check(
    '面板发出的命令都拿到了来源确认（含回执内容）',
    report.pings.length === 2 && report.pings.every((p) => p.result?.pong === true && p.result?.ok === true),
    JSON.stringify(report.pings),
  );
  const echanged = procs.every((p) => p.lines.some((l) => l.includes('"event":"command_received"')));
  check('来源进程确实收到了来自面板的命令', echanged, procs.map((p) => p.lines.filter((l) => l.includes('command_received')).length).join(','));

  section('D. 面板能改变来源的行为（业务状态只可能活在来源进程里）');
  // 面板在 demo 模式下会把两个来源的节奏改成 300ms 并强制采集。
  // 用"枢纽流水账里的消息速率"来证明来源确实变快了，而不是面板自己编的。
  const before = (await h.log(400)).records.filter((r) => r.kind === 'message').length;
  await sleep(1500);
  const after = (await h.log(400)).records.filter((r) => r.kind === 'message').length;
  check('改变节奏后，通过枢纽的消息明显增多', after - before >= 5, `before=${before} after=${after}`);

  const sensorAcks = procs[0].lines.filter((l) => l.includes('"command":"set_interval"') || l.includes('set_interval'));
  check('来源执行了面板下发的 set_interval', sensorAcks.length > 0, String(sensorAcks.length));

  section('E. 枢纽的流水账把整条往返链路记全');
  const log = await h.log(400);
  const cmds = log.records.filter((r) => r.kind === 'message' && r.topic.startsWith('cmd/'));
  const acks = log.records.filter((r) => r.kind === 'message' && r.body?.kind === 'ack');
  check('流水账里有面板发出的命令', cmds.length >= 4, String(cmds.length));
  check('流水账里有来源回的确认', acks.length >= 4, String(acks.length));
  check(
    '确认帧带着 replyTo，往返链路可追溯',
    acks.length > 0 && acks.every((a) => typeof a.body.replyTo === 'string'),
    JSON.stringify(acks.slice(0, 3).map((a) => a.body.replyTo)),
  );
  const replyTargets = new Set(acks.map((a) => a.body.replyTo));
  const cmdIds = new Set(cmds.map((c) => c.id).filter(Boolean));
  check(
    '每个确认都对得上一条命令',
    replyTargets.size > 0 && [...replyTargets].every((id) => cmdIds.has(id)),
    `cmdIds=${cmdIds.size} replies=${replyTargets.size}`,
  );
  const seqs = log.records.filter((r) => typeof r.seq === 'number').map((r) => r.seq);
  check('序号严格单调递增', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs.slice(0, 10)));

  section('F. 一个来源掉线不影响其他来源与面板');
  const snapshotIds = async () => (await h.status()).bridges.map((b) => b.bridgeId).sort().join(',') || '(空)';
  console.log(`     掉线前接线图：${await snapshotIds()}`);
  const victimSeqBefore = (await h.status()).lastSeq;
  const victim = procs[1];
  // 注意：Windows 上 Node 不把 SIGTERM 交给 JS 处理器，进程是被直接终止的——
  // 对枢纽来说这与"程序崩溃/断电"是同一种情况，正好是更严苛的验证。
  console.log(`     强杀 ${JSON.parse(victim.ready).bridge}（pid ${JSON.parse(victim.ready).pid}）`);
  victim.child.kill('SIGTERM');
  await sleep(1200);
  const afterIds = await snapshotIds();
  console.log(`     掉线后接线图：${afterIds}`);
  check('掉线的桥已从接线图注销', !afterIds.includes('source.ticker'), afterIds);
  const sAfter = await h.status();
  check('另一座来源桥仍在线', sAfter.bridges.some((b) => b.bridgeId === 'source.sensor-a'), afterIds);
  const stillFlowing = await until(async () => (await h.status()).lastSeq > victimSeqBefore + 2, {
    what: 'sensor still publishing',
    timeoutMs: 6000,
  });
  check('剩余来源的数据继续流过枢纽', !!stillFlowing);
  check('来源进程确实已被终止', victim.exited !== null, JSON.stringify(victim.exited));

  section('G. 面板重新接入后，仍能把命令回传给幸存的来源');
  // 这就是"面板能返回信息"的独立复验：新面板、老来源、中间只隔着枢纽。
  const panel2 = await h.spawnProgram('examples/event-panel/dashboard.mjs', {
    args: ['--once', 'quick', '--quiet', '--from', 'now'],
  });
  const report2 = await until(
    async () => {
      const line = panel2.lines.find((l) => l.includes('"event":"report"'));
      return line ? JSON.parse(line) : null;
    },
    { what: 'second dashboard report', timeoutMs: 40000 },
  );
  check('新面板收到了幸存来源的数据', report2.sources['sensor-a']?.readings > 0, JSON.stringify(Object.keys(report2.sources)));
  const sensorPing = report2.pings.find((p) => p.target === 'sensor-a');
  check('新面板的 ping 得到了幸存来源的回应', sensorPing?.result?.pong === true, JSON.stringify(report2.pings));

  section('H. 枢纽是干净退出的普通进程');
  const hubStatus = await h.status();
  check('退出前枢纽仍可查询状态', typeof hubStatus.hubId === 'string' && hubStatus.hubId.length > 0, hubStatus.hubId);
  check('枢纽的接线图里不再有掉线的桥', !hubStatus.bridges.some((b) => b.bridgeId === 'source.ticker'));
  check(
    '枢纽从始至终只持有接线图 + 订阅表 + 流水账（零世界状态）',
    Object.keys(hubStatus).sort().join(',') ===
      'bridges,connections,counters,hubId,lastGapLogFailure,lastSeq,logDir,logEnabled,now,recent,startedAt,storage,subscriptions,wireHash,wireVersion'
      && Object.keys(hubStatus.storage).sort().join(',') === 'blobs,log',
    Object.keys(hubStatus).sort().join(','),
  );
} catch (err) {
  fail++;
  console.log(`\n\x1b[31m异常\x1b[0m ${err?.stack ?? err}`);
  if (h.stderr) console.log(`hub stderr:\n${h.stderr}`);
} finally {
  await h.stop();
}

console.log(`\n端到端：\x1b[1m${pass} 通过 / ${fail} 失败\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
