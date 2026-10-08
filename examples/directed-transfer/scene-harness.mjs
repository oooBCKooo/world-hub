// Test conductor only. Every participating program runs in its own process.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Harness } from '../../tests/helpers/hub-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export async function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
class Peer {
  #child; #events = []; #pending = new Map(); #waiters = new Set(); #closed = false; #ready;
  constructor(name, configuration) {
    this.name = name; this.stderr = ''; this.exit = null; this.expectedKill = false;
    this.#child = spawn(process.execPath, [join(here, './scenario-peer.mjs')], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    this.pid = this.#child.pid;
    this.#ready = new Promise((resolveReady, rejectReady) => {
      this.#child.on('message', (event) => {
        if (event.kind === 'result') {
          const waiting = this.#pending.get(event.commandId);
          if (!waiting) return;
          this.#pending.delete(event.commandId); clearTimeout(waiting.timer);
          if (event.error) waiting.reject(Object.assign(new Error(event.error.message), { code: event.error.code }));
          else waiting.resolve(event.value);
          return;
        }
        this.#events.push(event);
        if (event.kind === 'ready') resolveReady(event);
        if (event.kind === 'fatal') rejectReady(new Error(event.message));
        for (const waiter of [...this.#waiters]) if (waiter.predicate(event)) {
          clearTimeout(waiter.timer); this.#waiters.delete(waiter); waiter.resolve(event);
        }
      });
      this.#child.stderr.on('data', (text) => { this.stderr += text.toString(); });
      this.#child.stdout.on('data', (text) => { this.stderr += `[stdout] ${text}`; });
      this.#child.on('error', (error) => { rejectReady(error); this.#reject(error); });
      this.#child.on('exit', (code, signal) => {
        this.exit = { code, signal }; this.#closed = true;
        const error = new Error(`${name} exited (${code}, ${signal}): ${this.stderr}`);
        rejectReady(error); this.#reject(error);
      });
    });
    this.#ready.catch(() => {});
    this.#child.send({ kind: 'init', configuration: { ...configuration, name } });
  }
  async ready() { return bounded(this.#ready, 10_000, `${this.name} ready`); }
  #reject(error) {
    for (const wait of this.#pending.values()) { clearTimeout(wait.timer); wait.reject(error); }
    this.#pending.clear();
    for (const wait of this.#waiters) { clearTimeout(wait.timer); wait.reject(error); }
    this.#waiters.clear();
  }
  events(kind) { return this.#events.filter((event) => kind === undefined || event.kind === kind); }
  wait(predicate, { timeoutMs = 10_000 } = {}) {
    const found = this.#events.find(predicate);
    if (found) return Promise.resolve(found);
    if (this.#closed) return Promise.reject(new Error(`${this.name} has exited`));
    return new Promise((resolveWait, reject) => {
      const waiter = { predicate, resolve: resolveWait, reject };
      waiter.timer = setTimeout(() => { this.#waiters.delete(waiter); reject(new Error(`${this.name} event timeout; recent=${JSON.stringify(this.#events.slice(-4))}`)); }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }
  cmd(op, args = {}, { timeoutMs = 30_000 } = {}) {
    if (this.#closed || !this.#child.connected) return Promise.reject(new Error(`${this.name} has exited`));
    const commandId = randomUUID();
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(commandId); reject(new Error(`${this.name}.${op} command timeout`)); }, timeoutMs);
      this.#pending.set(commandId, { resolve: resolveCommand, reject, timer });
      this.#child.send({ kind: 'command', commandId, op, args }, (error) => {
        if (!error) return;
        clearTimeout(timer); this.#pending.delete(commandId); reject(error);
      });
    });
  }
  async kill({ expected = true } = {}) {
    if (this.exit) return this.exit;
    this.expectedKill = expected;
    const done = new Promise((resolveExit) => this.#child.once('exit', () => resolveExit(this.exit)));
    this.#child.kill('SIGKILL');
    return bounded(done, 5000, `${this.name} killed`);
  }
  async close() {
    if (this.exit) return;
    await this.cmd('stop', {}, { timeoutMs: 3000 }).catch(() => {});
    if (this.exit) return;
    const done = new Promise((resolveExit) => this.#child.once('exit', resolveExit));
    await bounded(done, 1500, `${this.name} closed`).catch(() => this.kill({ expected: false }));
  }
}

export async function createScene(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'peros-phase4-scene-'));
  const peers = [];
  const checkpoints = [];
  const hubRuns = [];
  const ownedCleanups = [];
  let harness;
  let completedCleanup = false;
  const cleanup = async () => {
    if (completedCleanup) return;
    completedCleanup = true;
    const externalClosing = await Promise.allSettled(ownedCleanups.map((close) => close()));
    const closing = await Promise.allSettled(peers.map((peer) => peer.close()));
    const cleanupErrors = [...externalClosing, ...closing].filter((result) => result.status === 'rejected').map((result) => result.reason);
    try { await harness?.stop(); } catch (error) { cleanupErrors.push(error); }
    t.diagnostic('SCENE_EVIDENCE ' + JSON.stringify({ name: t.name, checkpoints, hubs: hubRuns, programs: peers.map((peer) => ({ name: peer.name, pid: peer.pid, exit: peer.exit, expectedKill: peer.expectedKill,
      deliveries: peer.events('delivery').map(({ message, mod }) => ({ mod, seq: message.seq, topic: message.topic, operation: message.operation, fromPrincipal: message.fromPrincipal, requestSeq: message.requestSeq,
        target: message.target, attachments: message.attachments })), errors: peer.events('error').map((e) => e.frame), paused: peer.events('paused') })) }));
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !basename(dir).startsWith('peros-phase4-scene-')) throw new Error('scene cleanup escaped generated temporary directory');
    await rm(dir, { recursive: true, force: true });
    const unexpected = peers.filter((peer) => !peer.expectedKill && (!peer.exit || peer.exit.code !== 0 || peer.exit.signal !== null));
    if (unexpected.length) throw new Error(`unexpected program exits: ${JSON.stringify(unexpected.map((peer) => ({ name: peer.name, exit: peer.exit, stderr: peer.stderr })))}`);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'scene process cleanup failed');
  };
  t.after(cleanup);
  const allow = { publish: ['#'], subscribe: ['#'] };
  const bridges = Object.fromEntries((options.principals ?? []).map((id) => [id, { allow }]));
  const credentials = Object.fromEntries(Object.entries(options.credentials ?? {}).map(([id, entry]) => [id, { allow, ...entry }]));
  const acl = { ...options.acl, bridges: { ...bridges, ...options.acl?.bridges }, credentials: { ...credentials, ...options.acl?.credentials } };
  for (const entry of [...Object.values(acl.bridges), ...Object.values(acl.credentials)]) entry.token ??= randomUUID();
  const config = { acl, log: { ...options.log, dir: join(dir, 'log') }, blobs: { ...options.blobs, dir: join(dir, 'blobs') },
    limits: options.limits, management: { stateFile: join(dir, 'management.json') } };
  const configPath = join(dir, 'hub.json');
  await writeFile(configPath, JSON.stringify(config));
  harness = new Harness({ logDir: config.log.dir, keepTmp: true });
  await harness.startHub({ configPath, isolateLog: false });
  hubRuns.push({ pid: harness.hub.pid, endpoint: harness.endpoint });
  return {
    dir, configPath, get harness() { return harness; },
    ownCleanup(close) { ownedCleanups.push(close); },
    record(label, data = {}) { checkpoints.push({ label, ...data }); },
    async peer(name, opts = {}) {
      const mods = (opts.bridges ?? [{ id: name, autoAck: opts.autoAck }]).map((mod) => ({ ...mod,
        token: mod.token ?? (mod.credential ? acl.credentials[mod.credential]?.token : acl.bridges[mod.id]?.token) }));
      const peer = new Peer(name, { dir, url: harness.endpoint, bridges: mods }); peers.push(peer);
      await peer.ready();
      return peer;
    },
    async restart() {
      const port = harness.port;
      await harness.stop();
      harness = new Harness({ port, logDir: config.log.dir, keepTmp: true });
      await harness.startHub({ configPath, isolateLog: false });
      hubRuns.push({ pid: harness.hub.pid, endpoint: harness.endpoint });
      return harness.ready;
    },
  };
}
