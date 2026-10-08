#!/usr/bin/env node
// 数据面板：一座双向 mod 桥的两端。
//
//   输入：枢纽 → 面板桥 → 面板程序     （订阅来源主题，聚合成视图）
//   输出：面板程序 → 面板桥 → 枢纽     （发布命令，由枢纽路由给来源）
//
// 面板从不直接碰枢纽内部：它和来源程序一样，只是"接在枢纽上的一座桥"。
// 面板自己的状态（事件缓存、统计、待确认命令）活在面板进程里，由面板自己存盘。

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { parseArgs, parseFrom } from './lib/base-source.mjs';

const args = parseArgs(process.argv.slice(2), {
  events: '60',
  state: process.env.HUB_STATE_FILE ?? '.hub/dashboard/state.json',
  once: '',
  quiet: false,
  from: '',
  readOnStart: false,
});

const BRIDGE_ID = args.bridge ?? 'ui.dashboard';
const STATE_FILE = resolve(process.cwd(), String(args.state));
const MAX_EVENTS = Number(args.events) || 60;

// ── 面板本地状态（全部活在面板进程里；枢纽不参与） ──────────────────
const S = {
  startedAt: new Date().toISOString(),
  events: [],
  sources: new Map(), // id -> { lastSeen, readings, last, lastAck, intervalMs }
  totals: { received: 0, published: 0, acks: 0, denied: 0, overflows: 0, timeouts: 0 },
  pending: new Map(), // 命令 id -> { target, command, at }
  commandSeq: 0,
  handledSeq: 0,
};

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    S.handledSeq = Number.isSafeInteger(raw.handledSeq) ? raw.handledSeq : 0;
    S.events = Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [];
    for (const [id, s] of Object.entries(raw.sources ?? {})) {
      S.sources.set(id, {
        lastSeen: s.lastSeen ?? null,
        readings: s.readings ?? 0,
        last: s.last ?? null,
        lastAck: s.lastAck ?? null,
        intervalMs: s.intervalMs ?? null,
      });
    }
  } catch {
    /* 首次运行：没有历史 */
  }
}

function saveState(handledSeq = S.handledSeq) {
  const temp = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    fd = openSync(temp, 'wx');
    writeFileSync(
      fd,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          handledSeq,
          sources: Object.fromEntries(
            [...S.sources.entries()].map(([id, s]) => [
              id,
              { lastSeen: s.lastSeen, readings: s.readings, last: s.last, lastAck: s.lastAck, intervalMs: s.intervalMs },
            ]),
          ),
          events: S.events.slice(-MAX_EVENTS),
        },
        null,
        2,
      ),
      'utf8',
    );
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, STATE_FILE);
    S.handledSeq = handledSeq;
  } catch (err) {
    log('state_save_failed', { message: String(err.message) });
    throw err; // The delivery callback fails, so the bridge cannot ACK unsaved state.
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') log('state_temp_cleanup_failed', { message: err.message }); }
  }
}

const log = (event, fields = {}) =>
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), panel: 'dashboard', event, ...fields }) + '\n');

const C = { r: '\u001b[0m', d: '\u001b[2m', b: '\u001b[1m', red: '\u001b[31m', grn: '\u001b[32m', yel: '\u001b[33m', blu: '\u001b[34m', cyn: '\u001b[36m' };
const say = (text) => {
  if (!args.quiet) process.stdout.write(text + '\n');
};
const stamp = () => new Date().toISOString().slice(11, 19);
const colorOf = (level) => (level === 'alarm' ? C.red : level === 'warm' ? C.yel : C.grn);

/** 面板怎么理解一条载荷——这个理解完全属于面板，枢纽不知道也不关心。 */
function interpret(body) {
  switch (body.metric) {
    case 'temperature':
      return { text: `${body.celsius}${body.unit ?? '°C'}`, note: `湿度 ${body.humidity}% · ${body.location ?? ''}`, level: body.level };
    case 'tasks.completed':
      return { text: `${body.value}`, note: `步长 ${body.step} · 已重置 ${body.resets} 次`, level: null };
    default:
      return { text: JSON.stringify(body).slice(0, 48), note: body.kind ?? '', level: null };
  }
}

function renderBoard() {
  const rows = [...S.sources.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out = ['', `${C.b}┌─来源总览${'─'.repeat(60)}${C.r}`];
  if (rows.length === 0) out.push(`│ ${C.d}（还没有来源接入）${C.r}`);
  for (const [id, s] of rows) {
    const ageMs = s.lastSeen ? Date.now() - new Date(s.lastSeen).getTime() : Infinity;
    const alive = ageMs < 5000;
    const dot = alive ? `${C.grn}●${C.r}` : `${C.yel}○${C.r}`;
    const view = s.last ? interpret(s.last) : { text: '—', note: '（未上报）' };
    const age = Number.isFinite(ageMs) ? `${(ageMs / 1000).toFixed(1)}s前` : '从未';
    const ack = s.lastAck ? `${C.blu}✓${s.lastAck.command}${C.r}` : `${C.d}—${C.r}`;
    out.push(
      `│ ${dot} ${C.b}${id.padEnd(11)}${C.r} ${String(view.text).padEnd(11)} ${C.d}${String(view.note).slice(0, 26).padEnd(28)}${C.r} ${String(s.readings).padStart(4)}条 ${ack} ${C.d}${age}${C.r}`,
    );
  }
  out.push(`${C.b}└${'─'.repeat(70)}${C.r}`);
  out.push(
    `${C.d}收到 ${S.totals.received} · 回传 ${S.totals.published} · 确认 ${S.totals.acks} · 超时 ${S.totals.timeouts} · 拒绝 ${S.totals.denied}${C.r}`,
  );
  return out.join('\n');
}

// ── 面板桥 ─────────────────────────────────────────────────────────
loadState();

const bridge = new Bridge({
  bridgeId: BRIDGE_ID,
  url: process.env.HUB_URL ?? 'ws://127.0.0.1:8790/bridge',
  // 凭据模式：同一个 ui.dashboard 凭据可以开多个面板实例，
  // 枢纽会给每条连接分配独立身份（ui.dashboard:1、ui.dashboard:2 …）。
  credential: args.credential ?? BRIDGE_ID,
  token: process.env.HUB_TOKEN,
  role: 'both',
  displayName: args.name ?? '数据面板',
  cursorFile: process.env.HUB_CURSOR_FILE ?? resolve(process.cwd(), `.hub/cursors/${BRIDGE_ID}.json`),
});

bridge.on('open', async (info) => {
  log('ready', {
    event: 'ready',
    hub: info.hub,
    bridge: BRIDGE_ID,
    identity: bridge.welcome?.bridge ?? null,
    credential: args.credential ?? BRIDGE_ID,
    lastSeq: info.lastSeq,
    authenticated: info.authenticated,
    stateFile: STATE_FILE,
    pid: process.pid,
  });
  say(`${C.b}数据面板${C.r} ${C.d}已接入枢纽 ${info.hub}（桥 ${BRIDGE_ID}）${C.r}`);

  const from = parseFrom(args.from);
  try {
    await bridge.registerChannels([
      { name: 'source/#', subscribe: true },
    ]);
    const sub = await bridge.subscribe(['source/#'], { from });
    log('subscribed', { subscription: sub.subscription, cursor: sub.cursor, filters: sub.filters, from });
  } catch (err) {
    log('subscribe_failed', { message: String(err.message) });
  }
  if (args.readOnStart) await broadcast('read_now');
});

bridge.on('delivery', (msg) => {
  if (msg.seq <= S.handledSeq) return; // Replay between state commit and bridge cursor commit.
  S.totals.received++;
  const body = msg.body ?? {};
  const id = body.source ?? msg.topic.split('/')[1] ?? msg.from;
  if (!S.sources.has(id)) S.sources.set(id, { lastSeen: null, readings: 0, last: null, lastAck: null, intervalMs: null });
  const s = S.sources.get(id);
  s.lastSeen = msg.at;

  if (body.kind === 'ack') {
    // 来源对面板回传的命令的确认：往返回路在这里闭合。
    S.totals.acks++;
    const wait = S.pending.get(body.replyTo);
    if (wait) {
      S.pending.delete(body.replyTo);
      wait.reply = body;
      const detail = Object.entries(body)
        .filter(([k]) => !['kind', 'source', 'seq', 'at', 'replyTo', 'command', 'ok'].includes(k))
        .map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      s.lastAck = { command: body.command, ok: body.ok !== false, at: msg.at };
      say(`${C.d}${stamp()}${C.r} ${C.blu}◀ 回执${C.r} ${wait.target} ${C.b}${body.command}${C.r} ${C.d}${detail}${C.r}`);
      log('command_acked', { target: wait.target, command: body.command, reply: body, hubSeq: msg.seq });
      wait.settle?.(body);
    }
    saveState(msg.seq);
    return;
  }

  s.readings++;
  s.last = body;
  const view = interpret(body);
  S.events.push({ seq: msg.seq, at: msg.at, from: msg.from, topic: msg.topic, body });
  if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
  say(`${C.d}${stamp()}${C.r} ${colorOf(view.level)}●${C.r} ${C.b}${id}${C.r} ${colorOf(view.level)}${view.text}${C.r} ${C.d}${view.note}${C.r}`);
  log('source_event', { source: id, hubSeq: msg.seq, topic: msg.topic, body });
  saveState(msg.seq);
});

bridge.on('caughtUp', (frame) => {
  log('caught_up', { subscription: frame.subscription, cursor: frame.cursor });
  say(`${C.d}${stamp()} 补课完成，游标 ${frame.cursor}${C.r}`);
});
bridge.on('subscribed', (frame) => log('subscribed_ack', frame));
bridge.on('denied', (frame) => {
  S.totals.denied++;
  say(`${C.d}${stamp()}${C.r} ${C.red}被拒${C.r} ${frame.code} ${C.d}${frame.message}${C.r}`);
  log('denied', frame);
});
bridge.on('overflow', (frame) => {
  S.totals.overflows++;
  say(`${C.d}${stamp()}${C.r} ${C.yel}缺口${C.r} ${frame.subscription} 丢了 ${frame.dropped?.[0]}–${frame.dropped?.[1]}`);
  log('overflow', frame);
});
bridge.on('error', (frame) => log('bridge_error', frame));
bridge.on('close', (info) => log('disconnected', info));

// ── 回传方向 ───────────────────────────────────────────────────────
/**
 * 面板回传一条命令。
 * 路径：面板 → 面板桥 → 枢纽 → 来源桥 → 来源程序 → 来源桥 → 枢纽 → 面板桥 → 面板
 */
function send(target, command, payload = {}, { timeoutMs = 5000 } = {}) {
  const id = `c-${Date.now().toString(36)}-${++S.commandSeq}`;
  say(`${C.d}${stamp()}${C.r} ${C.cyn}▶ 回传${C.r} ${target} ${C.b}${command}${C.r} ${C.d}${Object.keys(payload).length ? JSON.stringify(payload) : ''}${C.r}`);
  log('command_sent', { target, command, id, payload });
  const rec = { target, command, at: Date.now(), id, reply: null };
  S.pending.set(id, rec);
  return new Promise((res) => {
    rec.settle = (reply) => { clearTimeout(rec.timer); res({ ok: true, target, command, id, ...(reply ?? {}) }); };
    rec.timer = setTimeout(() => {
      if (S.pending.delete(id)) {
        S.totals.timeouts++;
        say(`${C.d}${stamp()}${C.r} ${C.red}✗ 无回应${C.r} ${target} ${command}`);
        log('command_timeout', { target, command, id, timeoutMs });
        res({ ok: false, target, command, id, error: 'TIMEOUT' });
      }
    }, timeoutMs);
    rec.timer.unref?.();
    bridge.registerChannels([{ name: `cmd/${target}`, publish: true }], { timeoutMs }).then(() =>
      bridge.publishConfirmed(`cmd/${target}`, { command, ...payload }, { id, correlation: id, timeoutMs }),
    ).then(() => {
      S.totals.published++;
    }).catch((err) => {
      if (!S.pending.delete(id)) return;
      clearTimeout(rec.timer);
      log('command_publish_failed', { target, command, id, message: err.message });
      res({ ok: false, target, command, id, error: 'PUBLISH_FAILED', message: err.message });
    });
  });
}

const targets = () => [...S.sources.keys()];
/** 现在还活着的来源（用于回传）。陈旧来源不发给它，免得白等超时。 */
const aliveTargets = () => targets().filter((id) => isAlive(S.sources.get(id)));
const isAlive = (s) => !!s?.lastSeen && Date.now() - new Date(s.lastSeen).getTime() < 5000;
async function broadcast(command, payload = {}, list = null) {
  const out = [];
  for (const t of list ?? aliveTargets()) out.push({ target: t, result: await send(t, command, payload) });
  return out;
}

// ── 输入：每行一条回传命令 ──────────────────────────────────────────
//   <来源> <命令> [k=v ...]      例：sensor-a calibrate to=33
//   :read / :board / :sources / :quit
if (!args.once) {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line === ':quit') return void (await shutdown());
      if (line === ':board') return void say(renderBoard());
      if (line === ':sources') return void say(targets().join('\n'));
      if (line === ':read') return void (await broadcast('read_now'));
      const [target, command, ...rest] = line.split(/\s+/);
      if (!target || !command) continue;
      const payload = {};
      for (const kv of rest) {
        const [k, v] = kv.split('=');
        if (!k) continue;
        payload[k] = v === undefined ? true : Number.isNaN(Number(v)) ? v : Number(v);
      }
      await send(target, command, payload);
    }
  });
}

// ── once 模式：跑一段固定剧本，产出可断言的报告 ─────────────────────
async function runOnce() {
  const waitFor = async (pred, ms, what) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    log('once_wait_timeout', { what });
    return false;
  };

  await waitFor(() => S.sources.size >= 1 && [...S.sources.values()].some((s) => s.readings > 0), 8000, 'sources reporting');
  await waitFor(() => S.totals.received >= 4, 6000, 'enough events');
  await waitFor(() => aliveTargets().length >= 1, 6000, 'at least one live source');

  // 回传一：探活（只发当前活着的桥；陈旧来源不发给它，免得白等超时）
  const pings = await broadcast('ping');
  // 回传二：改变来源行为（业务效果只可能发生在来源进程内）
  const setIntervals = await broadcast('set_interval', { intervalMs: Number(args.intervalMs) || 300 });
  await new Promise((r) => setTimeout(r, 600));
  // 回传三：触发一次即时采集
  const reads = await broadcast('read_now');
  await new Promise((r) => setTimeout(r, 500));

  saveState();
  say(renderBoard());
  if (args.once === 'demo') {
    say(`\n${C.d}最近流水：${C.r}`);
    for (const e of S.events.slice(-8)) {
      const v = interpret(e.body);
      say(`  ${C.d}#${e.seq} ${e.topic}${C.r} ${v.text} ${C.d}${v.note}${C.r}`);
    }
    say('');
  }

  process.stdout.write(
    JSON.stringify({
      event: 'report',
      bridge: BRIDGE_ID,
      sources: Object.fromEntries(
        [...S.sources.entries()].map(([id, s]) => [
          id,
          { readings: s.readings, last: s.last, lastAck: s.lastAck, lastSeen: s.lastSeen, alive: isAlive(s) },
        ]),
      ),
      totals: S.totals,
      pings,
      setIntervals,
      reads,
      pending: S.pending.size,
      stateFile: STATE_FILE,
      bufferedEvents: S.events.length,
    }) + '\n',
  );
  await shutdown();
}

if (args.once) {
  setTimeout(() => {
    runOnce().catch(async (err) => {
      log('once_failed', { message: String(err?.stack ?? err) });
      await shutdown(1);
    });
  }, 250);
}

let closing = false;
async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  try { saveState(); }
  catch { exitCode = 1; }
  finally { await bridge.close(); }
  process.exit(exitCode);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await bridge.connect().catch((err) => {
  log('connect_failed', { message: String(err.message) });
  process.exitCode = 1;
});
