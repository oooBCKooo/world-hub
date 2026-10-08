import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Harness } from '../../tests/helpers/hub-harness.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURE_TOKEN = 'phase7-local-test-token';
export const LANGUAGES = ['javascript', 'python', 'powershell'];
const script = (name) => fileURLToPath(new URL(name, import.meta.url));
export class Peer {
  constructor(language, child, args) {
    this.language = language; this.child = child; this.args = args; this.events = []; this.waiters = []; this.number = 0; this.eventBytes = 0; this.stderr = ''; this.ended = null;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let value;
      try { value = JSON.parse(line); } catch { this.fail(new Error(`invalid ${language} output: ${line.slice(0, 200)}`)); return; }
      const row = { ...value, index: ++this.number, bytes: Buffer.byteLength(line) };
      this.events.push(row); this.eventBytes += row.bytes;
      while (this.events.length > 256 || this.eventBytes > 16 * 1024 * 1024) this.eventBytes -= this.events.shift().bytes;
      for (const waiter of [...this.waiters]) if (row.index > waiter.after && waiter.match(row)) waiter.finish(null, row);
    });
    child.stderr.on('data', (text) => { this.stderr = (this.stderr + text).slice(-16000); });
    child.once('error', (error) => this.fail(error));
    child.stdin.on('error', (error) => this.fail(error));
    this.exit = new Promise((done) => child.once('close', (code, signal) => {
      this.ended = { code, signal };
      if (this.proof) Object.assign(this.proof, { exitCode: code, exitSignal: signal });
      this.fail(new Error(`${language} exited ${code}/${signal}; ${this.stderr}`)); done(this.ended);
    }));
  }
  fail(error) { this.failure = error; for (const waiter of [...this.waiters]) waiter.finish(error); }
  wait(match, { after = 0, timeoutMs = 10000 } = {}) {
    const existing = this.events.find((row) => row.index > after && match(row));
    if (existing) return Promise.resolve(existing);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((done, reject) => {
      const waiter = { after, match, finish: (error, row) => {
        clearTimeout(waiter.timer); this.waiters.splice(this.waiters.indexOf(waiter), 1); error ? reject(error) : done(row);
      } };
      waiter.timer = setTimeout(() => waiter.finish(new Error(`${this.language} wait timed out; ${this.stderr}; recent=${JSON.stringify(this.events.slice(-3)).slice(0, 1000)}`)), timeoutMs);
      this.waiters.push(waiter);
    });
  }
  frame(match, opts) { return this.wait((row) => row.event === 'frame' && match(row.frame), opts); }
  async command(fields) {
    const id = randomUUID();
    const reply = this.wait((row) => row.id === id);
    this.child.stdin.write(JSON.stringify({ id, ...fields }) + '\n', (error) => { if (error) this.fail(error); });
    const row = await reply;
    if (!row.ok) throw Object.assign(new Error(row.error?.message ?? 'worker command failed'), { code: row.error?.code });
    return row;
  }
  send(frame) { return this.command(typeof frame === 'string' ? { action: 'send', raw: frame } : { action: 'send', frame }); }
  async receipt(type, fields) {
    const requestToken = randomUUID();
    await this.send({ type, ...fields, requestToken });
    return (await this.frame((f) => f.requestToken === requestToken)).frame;
  }
  async subscribe(fields) {
    const token = randomUUID();
    await this.send({ type: 'subscribe', ...fields, token });
    const receipt = (await this.frame((f) => f.token === token && f.type === 'subscribed')).frame;
    const barrier = (await this.frame((f) => ['caught_up', 'catchup_truncated'].includes(f.type) && f.subscription === receipt.subscription)).frame;
    if (barrier.type !== 'caught_up') throw new Error('unexpected history gap');
    return { ...receipt, through: barrier.through };
  }
  deliveries(subscription) { return this.events.filter((row) => row.event === 'frame' && row.frame.type === 'delivery' && (!subscription || row.frame.subscription === subscription)); }
  async close() {
    if (this.ended) return this.ended;
    try { await this.command({ action: 'close' }); } catch { this.child.kill(); }
    const timer = setTimeout(() => this.child.kill(), 3000);
    const end = await this.exit; clearTimeout(timer); return end;
  }
}

export class Scene {
  static async create() {
    const self = new Scene(); self.peers = []; self.hubs = []; self.processes = []; self.tmp = await mkdtemp(join(tmpdir(), 'hub-phase7-'));
    const allow = { publish: ['#'], subscribe: ['#'] };
    const ids = [...LANGUAGES.map((language) => `phase7.${language}`), 'phase7.python.service', 'phase7.powershell.service', 'phase7.workflow'];
    const bridges = Object.fromEntries(ids.map((id) => [id, { token: FIXTURE_TOKEN, allow }]));
    bridges['phase7.restricted'] = { token: FIXTURE_TOKEN, allow: { publish: ['allowed/#'], subscribe: ['allowed/#'] } };
    self.config = join(self.tmp, 'hub.json');
    await writeFile(self.config, JSON.stringify({ hub: { id: 'phase7-cross-language' }, log: { enabled: true, segmentMaxBytes: 1024 * 1024, segmentMaxCount: 32 },
      acl: { allowUnlistedBridges: false, bridges, credentials: { 'phase7.shared': { token: FIXTURE_TOKEN, maxConnections: 4, allow } } } }));
    try { await self.startHub(); return self; } catch (error) { await self.close(); throw error; }
  }
  async startHub(port) {
    this.h = new Harness({ keepTmp: true, logDir: join(this.tmp, 'log'), ...(port ? { port } : {}) });
    await this.h.startHub({ configPath: this.config, isolateLog: false });
    this.hubs.push({ pid: this.h.hub.pid, endpoint: this.h.endpoint, lastSeq: this.h.ready.lastSeq });
  }
  async peer(language, { bridge = `phase7.${language}`, credential, echoTopic, token = FIXTURE_TOKEN, expectReady = true } = {}) {
    const common = ['--url', this.h.endpoint, '--bridge', bridge, ...(credential ? ['--credential', credential] : []), ...(token ? ['--token', token] : []), ...(echoTopic ? ['--echo-topic', echoTopic] : [])];
    let executable, args;
    if (language === 'javascript') { executable = process.execPath; args = [script('./js-worker.mjs'), ...common]; }
    else if (language === 'python') { executable = process.env.PHASE7_PYTHON ?? 'python'; args = ['-u', script('../../tests/fixtures/python/worker.py'), ...common]; }
    else { executable = process.env.PHASE7_POWERSHELL ?? 'pwsh'; args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script('../../tests/fixtures/powershell/worker.ps1'), ...common.map((value) => value.startsWith('--') ? '-' + value.slice(2).replace('echo-topic', 'EchoTopic') : value)]; }
    const child = spawn(executable, args, { cwd: ROOT, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    const peer = new Peer(language, child, args); this.peers.push(peer);
    const proof = { language, executable, pid: child.pid, bridge, ...(credential ? { credential } : {}) }; this.processes.push(proof);
    peer.proof = proof;
    if (expectReady) { peer.ready = await peer.wait((row) => row.event === 'ready', { timeoutMs: 15000 }); proof.version = peer.ready.version; proof.dependencyVersion = peer.ready.dependencyVersion; proof.principal = peer.ready.welcome.principal; }
    return peer;
  }
  async workflow() {
    const args = [script('./workflow-program.mjs'), '--url', this.h.endpoint, '--token', FIXTURE_TOKEN];
    const child = spawn(process.execPath, args, { cwd: ROOT, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill(), 25000);
    let code;
    try { code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code) => done(code)); }); }
    finally { clearTimeout(timer); }
    this.processes.push({ language: 'javascript', program: 'workflow', pid: child.pid, version: process.version, exitCode: code });
    if (code !== 0) throw new Error(`workflow failed ${code}: ${stderr}`);
    return JSON.parse(stdout.trim());
  }
  async restart() {
    await Promise.all(this.peers.map((peer) => peer.close()));
    const port = this.h.port; await this.h.stop(); await this.startHub(port);
  }
  async close() {
    const results = await Promise.allSettled((this.peers ?? []).map((peer) => peer.close()));
    if (this.h) await this.h.stop();
    if (this.tmp) { const target = resolve(this.tmp); if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('cleanup target outside temporary storage'); await rm(target, { recursive: true, force: true }); }
    if (results.some((row) => row.status === 'rejected') || this.peers.some((peer) => peer.ready && peer.ended?.code !== 0)) throw new Error('a ready language process failed during cleanup');
  }
}
