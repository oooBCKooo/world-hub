// 测试与演示夹具：自己拉起枢纽、自己接程序、跑完自己收摊。
//
// 这样每个测试都是可重复的、端口自选的、不留后台进程的。
// 也顺带证明枢纽是个普通进程：能被 start/stop，不依赖宿主。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');
export const HUB_SERVER = join(HERE, '../../src/hub/hub-server.mjs');

/** 要一个空闲端口。 */
async function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

export class Harness {
  constructor(opts = {}) {
    this.opts = opts;
    this.hub = null;
    this.children = [];
    this.ready = null;
    this.stderr = '';
    this.stdout = '';
    this.port = null;
    // 每次运行都用独立的临时目录做日志，避免历史流水账污染断言。
    this.logDir = opts.logDir ?? null;
    this.tmp = null;
    /** 跨重启验证时保留临时目录（否则日志会连同目录一起被清掉）。 */
    this.keepTmp = opts.keepTmp === true;
  }

  get endpoint() {
    return `ws://127.0.0.1:${this.port}/bridge`;
  }
  get httpBase() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 拉起枢纽，等它自报 ready。 */
  async startHub({ configPath, extraArgs = [], env = {}, isolateLog = true } = {}) {
    this.port = this.opts.port ?? (await freePort());
    const args = [HUB_SERVER, '--port', String(this.port)];
    if (configPath) args.push('--config', configPath);
    if (isolateLog) {
      this.tmp = mkdtempSync(join(tmpdir(), 'hub-test-'));
      this.logDir = join(this.tmp, 'log');
    }
    // isolateLog:false 时复用调用方给的 logDir（用于跨重启的持久化验证）。
    if (this.logDir) args.push('--log-dir', this.logDir);
    args.push(...extraArgs);
    this.hub = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.ready = await new Promise((resolvePromise, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`hub did not become ready in 8s. stdout=${this.stdout} stderr=${this.stderr}`)), 8000);
      this.hub.stdout.on('data', (d) => {
        buf += d.toString();
        this.stdout += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.event === 'ready') {
              clearTimeout(timer);
              resolvePromise(obj);
            }
          } catch {
            /* 非 JSON 行忽略 */
          }
        }
      });
      this.hub.stderr.on('data', (d) => {
        this.stderr += d.toString();
      });
      this.hub.on('exit', (code) => {
        if (!this.port) return;
        clearTimeout(timer);
        reject(new Error(`hub exited early code=${code} stderr=${this.stderr}`));
      });
    });
    return this.ready;
  }

  /** 拉起一个外部程序（就是"独立进程里的桥"），并等它自报 ready 行。 */
  async spawnProgram(scriptRelPath, { args = [], env = {}, waitReady = true, cwd } = {}) {
    const script = resolve(PROJECT_ROOT, scriptRelPath);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: cwd ?? PROJECT_ROOT,
      env: { ...process.env, HUB_URL: this.endpoint, ...(this.tmp ? {
        HUB_CURSOR_FILE: join(this.tmp, `cursor-${this.children.length}.json`),
        HUB_STATE_FILE: join(this.tmp, `state-${this.children.length}.json`),
      } : {}), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rec = { child, stdout: '', stderr: '', lines: [], ready: null, exited: null };
    this.children.push(rec);
    const waiters = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      rec.stdout += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        rec.lines.push(line);
        for (const w of [...waiters]) {
          if (w.match(line)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(line);
          }
        }
      }
    });
    child.stderr.on('data', (d) => {
      rec.stderr += d.toString();
    });
    child.on('exit', (code, signal) => {
      rec.exited = { code, signal };
    });
    rec.waitLine = (match, timeoutMs = 8000) =>
      new Promise((resolvePromise, reject) => {
        const existing = rec.lines.find(match);
        if (existing) return resolvePromise(existing);
        const w = { match, resolve: resolvePromise };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timeout waiting for line. stderr=${rec.stderr}`));
        }, timeoutMs).unref?.();
      });
    if (waitReady) rec.ready = await rec.waitLine((l) => l.includes('"event":"ready"'));
    return rec;
  }

  async status() {
    const res = await fetch(`${this.httpBase}/status`);
    return res.json();
  }

  async log(limit = 200) {
    const res = await fetch(`${this.httpBase}/log?limit=${limit}`);
    return res.json();
  }

  async stop() {
    for (const rec of this.children) {
      if (!rec.exited) rec.child.kill('SIGKILL');
    }
    if (this.hub && !this.hub.killed) {
      this.hub.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          this.hub.kill('SIGKILL');
          r();
        }, 1500);
        this.hub.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    if (this.tmp && !this.keepTmp) {
      try {
        rmSync(this.tmp, { recursive: true, force: true });
      } catch {
        /* 临时目录清不掉不影响结论 */
      }
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立。 */
export async function until(fn, { timeoutMs = 5000, intervalMs = 40, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}
