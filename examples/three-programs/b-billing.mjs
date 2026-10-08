#!/usr/bin/env node
// 程序 B：计费。
//
// 它同时扮演两种角色：
//   - 消费者：订阅 order/new，自己不产生订单，但能看到 A 发的每一条；
//   - 服务方：收到定向请求就回话，回话由枢纽核对"你是不是原请求的目标"。
import { makeBridge, makeLog, installShutdown } from './_common.mjs';

const log = makeLog('B.app.billing');
const bridge = makeBridge('app.billing', { displayName: '计费程序' });
installShutdown(bridge, log);

bridge.on('denied', (f) => log('denied', { code: f.code, message: f.message }));
bridge.on('error', (f) => log('error', { code: f.code, message: f.message }));
bridge.on('overflow', (f) => log('overflow', f));
bridge.on('close', (i) => log('disconnected', { code: i.code }));

let charged = 0;

bridge.on('open', async (info) => {
  log('ready', { principal: info.principal, features: info.features, pid: process.pid });

  await bridge.registerChannels([
    { name: 'order/new', subscribe: true },
    { name: 'billing/charge', publish: true, subscribe: true },
  ]);

  // from 是"初始策略"，三种取值：
  //   'resume' —— 接着磁盘保存的已确认游标继续；程序仍须应对重复投递；
  //   0        —— 把枢纽留存的、自己有权读的历史全部重读一遍；
  //   'now'    —— 只要此刻之后的新消息。
  // 演示每次都是干净环境，这里用 HUB_FROM 可覆盖，默认 now。
  const sub = await bridge.subscribe(['order/new'], { from: process.env.HUB_FROM ?? 'now' });
  log('listening', { subscription: sub.subscription, cursor: sub.cursor });

  // 定向请求的接收侧：operations:['request'] 表示这条订阅只接定向请求，
  // 不把普通广播混进来。定向能力靠 welcome.features 协商。
  await bridge.subscribe(['billing/charge'], { from: process.env.HUB_FROM ?? 'now', operations: ['request'] });
  log('service_ready', { topic: 'billing/charge' });
});

// 普通广播：只是"知道了"。
bridge.on('delivery', async (msg) => {
  // 定向请求也会走 delivery 事件，用 operation 区分。这里只处理普通发布。
  if (msg.operation && msg.operation !== 'publish') return;
  log('order_seen', { topic: msg.topic, from: msg.from, seq: msg.seq, body: msg.body });
});

// 定向请求：回话。
bridge.on('delivery', async (msg) => {
  if (msg.operation !== 'request') return;
  const body = msg.body ?? {};
  log('request_received', { seq: msg.seq, fromPrincipal: msg.fromPrincipal, ask: body.ask });

  charged += 1;
  // 先把业务结果留在自己这里（真实程序应当在应答前完成自己的持久化），
  // 再回话。requestSeq 绑定原请求，枢纽从原请求推导应答目标和主题。
  await bridge.publishConfirmed('billing/charge', {
    kind: 'charge',
    orderId: body.orderId,
    amount: 4200,
    fee: 12.6,
    chargedCount: charged,
  });

  await bridge.respond(msg, {
    kind: 'answer',
    orderId: body.orderId,
    approved: true,
    fee: 12.6,
    note: '计费程序自己的判断，枢纽不参与',
  });
  log('responded', { requestSeq: msg.seq });
});

bridge.connect().catch((err) => {
  log('connect_failed', { message: String(err.message) });
  process.exitCode = 1;
});
