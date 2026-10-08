#!/usr/bin/env node
// 来源二：任务计数器。
//
// 和传感器完全不同的东西——它的状态是"已经数到几"，还能被面板重置。
// 枢纽对这两者的差别毫无感知：都只是某个主题上的 JSON。

import { parseArgs, startSource } from './lib/base-source.mjs';

const args = parseArgs(process.argv.slice(2), { intervalMs: '900' });

let count = Number(args.start) || 0;
let step = Number(args.step) || 1;
let resets = 0;

startSource({
  bridgeId: args.bridge ?? 'source.ticker',
  sourceId: args.id ?? 'ticker',
  displayName: args.name ?? '任务计数器',
  dataTopic: args.topic ?? 'source/ticker',
  commandTopic: args.commandTopic ?? 'cmd/ticker',
  intervalMs: Number(args.intervalMs) || 900,
  from: args.from,
  sample() {
    count += step;
    return {
      kind: 'count',
      metric: 'tasks.completed',
      value: count,
      step,
      resets,
    };
  },
  describe() {
    return { count, step, resets };
  },
  async onCommand(cmd, reply, ctx) {
    if (cmd.command === 'reset') {
      count = Number(cmd.to) || 0;
      resets++;
      await reply({ count, resets });
      return;
    }
    if (cmd.command === 'set_step') {
      step = Number(cmd.step) || step;
      await reply({ step });
      return;
    }
    if (cmd.command === 'read_now') {
      if (cmd.intervalMs) ctx.setInterval(Math.max(50, Number(cmd.intervalMs)));
      ctx.sample();
      await reply({ forced: true, intervalMs: ctx.intervalMs });
      return;
    }
    await reply({ ok: false, error: 'UNKNOWN_COMMAND' });
  },
});
