// 来源程序的共用骨架。
//
// 一座"输入 mod 桥"要做的事，全在这里：
//   1. 连上枢纽，声明身份
//   2. 订阅发给自己的命令主题（枢纽 → 本程序）
//   3. 按自己的节奏采集/产生数据，发布到数据主题（本程序 → 枢纽）
//   4. 收到命令就执行，并把结果回发（双向）
//
// 注意这里没有任何"世界"概念：程序不知道谁在看它，枢纽也不知道它发的是什么。

import { Bridge, defaultCursorPath } from '../../../sdk/javascript/bridge-kit.mjs';

/** The application chooses whether to resume old traffic or only accept new traffic. */
export function parseFrom(value, fallback = 'resume') {
  if (value === undefined || value === '') return fallback;
  if (value === 'now' || value === 'resume') return value;
  if (value === 'all') return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('from must be now, resume, all, or a nonnegative safe integer');
  return n;
}

export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/** 程序自己的日志：一行一条 JSON，机器可断言、人也看得懂。 */
export function makeLogger(sourceId) {
  return (event, fields = {}) => {
    process.stdout.write(
      JSON.stringify({ at: new Date().toISOString(), source: sourceId, event, ...fields }) + '\n',
    );
  };
}

/**
 * 起一座来源桥。
 *
 * @param {object} spec
 * @param {string} spec.bridgeId
 * @param {string} spec.sourceId
 * @param {string} spec.dataTopic        数据发布主题，如 source/sensor-a
 * @param {string} spec.commandTopic     命令订阅主题，如 cmd/sensor-a
 * @param {string} [spec.token]
 * @param {number} [spec.intervalMs]     采集节奏
 * @param {() => object} spec.sample     采集一次，返回要发布的载荷
 * @param {(cmd: object, reply: (payload: object) => void) => void} [spec.onCommand]
 * @param {() => object} [spec.describe] 自我描述（health 命令用）
 */
export function startSource(spec) {
  const log = makeLogger(spec.sourceId);
  const bridge = new Bridge({
    bridgeId: spec.bridgeId,
    url: process.env.HUB_URL ?? 'ws://127.0.0.1:8790/bridge',
    token: spec.token ?? process.env.HUB_TOKEN,
    role: 'in',
    displayName: spec.displayName ?? spec.sourceId,
    cursorFile: process.env.HUB_CURSOR_FILE ?? defaultCursorPath(spec.bridgeId),
  });

  let intervalMs = spec.intervalMs ?? 1000;
  let timer = null;
  let samples = 0;
  let emits = 0;
  let held = false;
  const startedAt = Date.now();

  const publish = (payload) => {
    const body = { ...payload, source: spec.sourceId, seq: ++emits, at: new Date().toISOString() };
    bridge.publish(spec.dataTopic, body);
    return body;
  };

  /** 采集一次（只有这条路会推进"读数"计数）。 */
  const emit = (payload, opts = {}) => {
    samples++;
    const body = { ...payload, source: spec.sourceId, seq: ++emits, at: new Date().toISOString() };
    bridge.publish(spec.dataTopic, body, opts);
    return body;
  };

  const schedule = () => {
    clearInterval(timer);
    if (held) return;
    timer = setInterval(() => emit(spec.sample()), intervalMs);
  };

  bridge.on('open', async (info) => {
    log('ready', {
      event: 'ready',
      hub: info.hub,
      bridge: spec.bridgeId,
      dataTopic: spec.dataTopic,
      commandTopic: spec.commandTopic,
      intervalMs,
      authenticated: info.authenticated,
      pid: process.pid,
    });
    await bridge.registerChannels([
      { name: spec.dataTopic, publish: true },
      { name: spec.commandTopic, subscribe: true },
    ]);
    const sub = await bridge.subscribe([spec.commandTopic], { from: parseFrom(spec.from) });
    log('subscribed', { subscription: sub.subscription, filters: sub.filters });
    schedule();
  });

  bridge.on('delivery', async (msg) => {
    const cmd = msg.body ?? {};
    log('command_received', { topic: msg.topic, command: cmd.command, from: msg.from, id: msg.id });
    // 回执走 publish（不进读数计数）：回执不是一次采集。
    const reply = async (payload) => {
      if (!msg.id) return;
      const body = { kind: 'ack', replyTo: msg.id, command: cmd.command, ok: true, ...payload,
        source: spec.sourceId, seq: ++emits, at: new Date().toISOString() };
      await bridge.publishConfirmed(spec.dataTopic, body, { replyTo: msg.id, correlation: msg.correlation });
    };
    if (cmd.command === 'ping') {
      await reply({ pong: true, uptimeMs: Date.now() - startedAt, samples });
      return;
    }
    if (cmd.command === 'set_interval') {
      intervalMs = Math.max(50, Number(cmd.intervalMs) || intervalMs);
      schedule();
      await reply({ intervalMs });
      return;
    }
    if (cmd.command === 'hold') {
      held = true;
      schedule();
      await reply({ held });
      return;
    }
    if (cmd.command === 'resume') {
      held = false;
      schedule();
      await reply({ held });
      return;
    }
    if (cmd.command === 'health') {
      await reply({
        uptimeMs: Date.now() - startedAt,
        samples,
        intervalMs,
        held,
        pid: process.pid,
        ...(spec.describe ? spec.describe() : {}),
      });
      return;
    }
    if (spec.onCommand) {
      await spec.onCommand(cmd, reply, {
        emit,
        sample: () => emit(spec.sample()),
        get intervalMs() {
          return intervalMs;
        },
        setInterval: (v) => {
          intervalMs = v;
          schedule();
        },
      });
      return;
    }
    log('command_unknown', { command: cmd.command });
    if (msg.id) await reply({ ok: false, error: 'UNKNOWN_COMMAND' });
  });

  bridge.on('denied', (frame) => log('denied', { code: frame.code, message: frame.message }));
  bridge.on('error', (frame) => log('error', { code: frame.code, message: frame.message }));
  bridge.on('overflow', (frame) => log('overflow', frame));
  bridge.on('close', (info) => log('disconnected', { code: info.code, reason: info.reason }));

  // 信号处理先注册，再连接。晚注册会让"连接未完成时收到的 SIGTERM"丢掉，
  // 程序就变成杀不掉的僵尸——这是实测踩到的坑。
  const shutdown = async (signal) => {
    clearInterval(timer);
    log('bye', { samples, signal: signal ?? 'SIGINT' });
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  bridge.connect().catch((err) => {
    log('connect_failed', { message: String(err.message) });
    process.exitCode = 1;
  });

  return bridge;
}
