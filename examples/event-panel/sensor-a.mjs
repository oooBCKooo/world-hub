#!/usr/bin/env node
// 来源一：设备传感器（温度 + 湿度）。
//
// 它有自己的"业务状态"（基准温度会漂移），这个状态完全活在它自己的进程里，
// 枢纽对它一无所知。面板看到的只是它发出来的读数。

import { parseArgs, startSource } from './lib/base-source.mjs';

const args = parseArgs(process.argv.slice(2), { intervalMs: '1500' });
const intervalMs = Number(args.intervalMs) || 1500;

let baseline = 22.5;
let humidity = 48;
let noise = 0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 2) => Number(v.toFixed(d));

const bridge = startSource({
  bridgeId: args.bridge ?? 'source.sensor-a',
  sourceId: args.id ?? 'sensor-a',
  displayName: args.name ?? '机房温湿度探头',
  dataTopic: args.topic ?? 'source/sensor-a',
  commandTopic: args.commandTopic ?? 'cmd/sensor-a',
  intervalMs,
  from: args.from,
  sample() {
    // 随机游走：这台设备的真实状态由它自己推进。
    baseline = clamp(baseline + (Math.random() - 0.5) * 0.6, 15, 42);
    humidity = clamp(humidity + (Math.random() - 0.5) * 3, 20, 90);
    noise = clamp(noise + (Math.random() - 0.5) * 0.2, 0, 3);
    const level = baseline >= 32 ? 'alarm' : baseline >= 28 ? 'warm' : 'normal';
    return {
      kind: 'reading',
      metric: 'temperature',
      celsius: round(baseline + noise, 2),
      humidity: round(humidity, 1),
      level,
      unit: '°C',
      location: 'rack-A1',
    };
  },
  describe() {
    return { device: 'thermo-hygro-01', baseline: round(baseline), humidity: round(humidity, 1), firmware: '2.4.1' };
  },
  async onCommand(cmd, reply, ctx) {
    if (cmd.command === 'calibrate') {
      baseline = Number(cmd.to) || baseline;
      await reply({ baseline: round(baseline) });
      return;
    }
    if (cmd.command === 'read_now') {
      // 面板点"立即采集"：程序立刻补一次读数并确认。
      if (cmd.intervalMs) ctx.setInterval(Math.max(50, Number(cmd.intervalMs)));
      ctx.sample();
      await reply({ forced: true, intervalMs: ctx.intervalMs });
      return;
    }
    await reply({ ok: false, error: 'UNKNOWN_COMMAND' });
  },
});

void bridge;
