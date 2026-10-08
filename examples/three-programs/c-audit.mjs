#!/usr/bin/env node
// 程序 C：审计。
//
// 只订阅 "#"，什么都不发。它是"后来者也能读"的验证：
// 全项目没有任何代码为它做特殊安排，A 发布时也不需要知道它在不在线。
import { makeBridge, makeLog, installShutdown } from './_common.mjs';

const log = makeLog('C.app.audit');
const bridge = makeBridge('app.audit', { role: 'in', displayName: '审计程序' });
installShutdown(bridge, log);

bridge.on('denied', (f) => log('denied', { code: f.code, message: f.message }));
bridge.on('error', (f) => log('error', { code: f.code, message: f.message }));
bridge.on('overflow', (f) => log('overflow', f));
bridge.on('close', (i) => log('disconnected', { code: i.code }));

const seen = [];

bridge.on('open', async (info) => {
  log('ready', { principal: info.principal, pid: process.pid });
  // from: 0 = 把枢纽留存的、我有权读的全部历史读一遍再追平。
  // 非破坏抽取：A、B 各自的游标不受影响。
  const sub = await bridge.subscribe(['#'], { from: 0 });
  log('listening', { subscription: sub.subscription, cursor: sub.cursor, catchUpTo: sub.catchUpTo });
});

bridge.on('delivery', (msg) => {
  seen.push({ seq: msg.seq, topic: msg.topic, from: msg.from });
  log('audited', { seq: msg.seq, topic: msg.topic, from: msg.from, kind: msg.body?.kind ?? null });
});

bridge.on('caughtUp', (frame) => {
  log('caught_up', { subscription: frame.subscription, through: frame.through, count: seen.length });
});

bridge.connect().catch((err) => {
  log('connect_failed', { message: String(err.message) });
  process.exitCode = 1;
});
