#!/usr/bin/env node
// 程序 A：下单。
//
// 它做三件事，正好覆盖三种通讯形态：
//   1. 广播一条订单事件（谁在听、听不听得到，A 不关心也查不到）；
//   2. 向程序 B 定向要一次计费结果，等它回话；
//   3. 按游标把自己有权读的历史重读一遍（非破坏抽取）。
import { makeBridge, makeLog, installShutdown, until } from './_common.mjs';

const log = makeLog('A.app.order');
const bridge = makeBridge('app.order', { displayName: '下单程序' });
installShutdown(bridge, log);
const received = [], caught = new Set();
bridge.on('caughtUp', frame => caught.add(frame.subscription));

bridge.on('denied', (f) => log('denied', { code: f.code, message: f.message }));
bridge.on('error', (f) => log('error', { code: f.code, message: f.message }));
bridge.on('overflow', (f) => log('overflow', f));
bridge.on('close', (i) => log('disconnected', { code: i.code }));

// 收到计费结果（B 回的定向应答和 B 自己发的广播都落在这个通道上）。
bridge.on('delivery', (msg) => {
  received.push(msg);
  log('answer_in', { seq: msg.seq, subscription: msg.subscription, topic: msg.topic, operation: msg.operation ?? 'publish', from: msg.fromPrincipal ?? msg.from, body: msg.body });
});

// 程序 B 的定向身份。四期起枢纽在 welcome 里给每个连接分配稳定 principal。
// 真实部署先从受信配置获得；程序广告也须核对枢纽认证的 fromPrincipal。
const BILLING = { principal: process.env.BILLING_PRINCIPAL ?? 'app.billing' };

async function run(info) {
  log('ready', {
    principal: info.principal,
    features: info.features,
    authenticated: info.authenticated,
    hub: info.hub,
    pid: process.pid,
  });

  // 显式声明自己要用的通道（可选；publish/subscribe 也会隐式声明）。
  // 声明必须落在自己 ACL 的允许范围内，否则整批被拒。
  await bridge.registerChannels([
    { name: 'order/new', publish: true },
    { name: 'billing/charge', publish: true, subscribe: true },
  ]);

  // 应答继承请求主题；本程序和 call 的临时订阅会重叠，重复投递是正常的。
  const live = await bridge.subscribe(['billing/charge'], { operations: ['response'], from: 'now' });
  log('listening', { subscription: live.subscription, filters: live.filters, cursor: live.cursor });

  // 1) 广播：发出去就不管了。此刻 B 和 C 都在听。
  const receipt = await bridge.publishConfirmed('order/new', {
    kind: 'order',
    orderId: 'SO-1001',
    amount: 4200,
    currency: 'CNY',
  });
  log('published', { topic: 'order/new', seq: receipt.seq, note: '枢纽已受理，不代表谁消费了' });

  // 2) 定向请求：只发给 B，并等它回应。超时不会撤销请求，也不清理枢纽里的记录。
  try {
    const { request, response } = await bridge.call(BILLING, 'billing/charge', {
      kind: 'query',
      orderId: 'SO-1001',
      ask: 'charge',
    });
    log('call_answered', {
      requestSeq: request.seq,
      respondedBy: response.fromPrincipal,
      answer: response.body,
    });
  } catch (err) {
    log('call_failed', { code: err.code ?? null, message: String(err.message) });
    throw err;
  }

  // 3) 历史抽取：改成从 0 重读。
  //    replay 是显式重读；这里只保留一个历史订阅，避免与已有实时订阅重叠。
  //    非破坏抽取：读多少遍都不清理记录，B 和 C 各自的游标也不受 A 影响。
  await bridge.unsubscribe(live.subscription);
  const history = await bridge.replay(['billing/charge'], { from: 0 });
  log('catchup_subscribed', { subscription: history.subscription, cursor: history.cursor, catchUpTo: history.catchUpTo });
  await until(() => caught.has(history.subscription)
    && received.some(msg => msg.subscription === history.subscription && (msg.operation ?? 'publish') === 'publish')
    && received.some(msg => msg.subscription === history.subscription && msg.operation === 'response'));
  await bridge.close();
  log('done', {});
  process.exit(0);
}
bridge.on('open', info => run(info).catch(async err => {
  log('run_failed', { message: String(err.message) });
  await bridge.close();
  process.exitCode = 1;
}));

bridge.connect().catch((err) => {
  log('connect_failed', { message: String(err.message) });
  process.exitCode = 1;
});
