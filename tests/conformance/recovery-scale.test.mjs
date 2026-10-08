import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { Harness, until } from '../helpers/hub-harness.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { Hub } from '../../src/hub/lib/hub.mjs';
import { startOwnedProgram } from '../helpers/owned-program.mjs';

const probeScript = fileURLToPath(new URL('../fixtures/recovery-probe.mjs', import.meta.url));
const execFileAsync = promisify(execFile);
const sequenceHash = (seq) => createHash('sha256').update(JSON.stringify(seq)).digest('hex');
const rawHash = (raw) => createHash('sha256').update(raw).digest('hex');
const diagnostic = (t, value) => t.diagnostic('RECOVERY_EVIDENCE_BASE64 ' + Buffer.from(JSON.stringify(value)).toString('base64'));
async function processRss(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { windowsHide: true, timeout: 10000 });
    const value = Number(stdout.trim()); assert.ok(Number.isSafeInteger(value) && value > 0); return value;
  }
  if (process.platform === 'linux') {
    const text = await readFile(`/proc/${pid}/status`, 'utf8'); const match = text.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    assert.ok(match, 'Linux VmRSS unavailable'); return Number(match[1]) * 1024;
  }
  return null;
}
async function ownedFixture(t, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'peros-recovery-probe-'));
  const programs = [], hubs = [];
  let current;
  const credentials = Object.fromEntries(['seed', 'all', 'rare', 'raw'].map((id) => [id, randomUUID()]));
  const logDir = join(root, 'log');
  const configPath = join(root, 'hub.json');
  await writeFile(configPath, JSON.stringify({ log: { dir: logDir, segmentMaxBytes: 2 * 1024 * 1024, segmentMaxCount: 48 },
    blobs: { dir: join(root, 'blobs') }, management: { stateFile: join(root, 'manage.json') },
    limits: { maxPayloadBytes: 128 * 1024, maxPendingDeliveries: 17, maxCatchUpMessages: 5000, catchUpBatchSize: 71, ...limits },
    acl: { bridges: Object.fromEntries(Object.entries(credentials).map(([id, token]) => [id, { token, allow: { publish: ['#'], subscribe: ['#'] } }])) } }));
  t.after(async () => {
    const closed = await Promise.allSettled(programs.map((program) => program.stop()));
    await current?.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('peros-recovery-probe-'));
    await rm(root, { recursive: true, force: true });
    for (const result of closed) { assert.equal(result.status, 'fulfilled'); assert.deepEqual(result.value, { code: 0, signal: null }); }
  });
  return {
    root, logDir, programs, hubs, get hub() { return current; },
    async start() {
      current = new Harness({ logDir, keepTmp: true }); const started = performance.now();
      await current.startHub({ configPath, isolateLog: false });
      const record = { pid: current.hub.pid, startupMs: performance.now() - started }; hubs.push(record); return record;
    },
    async stop() { await current.stop(); },
    async program(bridge, settings) {
      const path = join(root, `program-${programs.length}.json`);
      await writeFile(path, JSON.stringify({ endpoint: current.endpoint, bridge, token: credentials[bridge], window: 17, ...settings }));
      const program = await startOwnedProgram(probeScript, { args: [path] }); programs.push(program); return program;
    },
  };
}
async function event(program, type, timeoutMs = 60000) {
  return until(() => {
    if (program.exited) throw new Error(`probe exited: ${JSON.stringify(program.exited)} ${program.stderr}`);
    return program.lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((entry) => entry?.event === type);
  }, { timeoutMs, intervalMs: 5, what: type });
}
async function diskSample(logDir) {
  const files = (await readdir(logDir)).filter((name) => name.endsWith('.jsonl'));
  let bytes = 0; for (const file of files) bytes += (await stat(join(logDir, file))).size;
  return { bytes, segments: files.length };
}
test('REC-01 real hub cold restart replays 12000 matching records and sparse topics through a 17-message ACK window', { timeout: 180000 }, async (t) => {
  const samples = [];
  for (const sample of [{ count: 3000, padBytes: 256 }, { count: 12000, padBytes: 1024 }]) {
    const fixture = await ownedFixture(t); const initial = await fixture.start();
    const emptyRssBytes = await processRss(initial.pid);
    const producer = await fixture.program('seed', { mode: 'seed', ...sample }); const seeded = await event(producer, 'completed');
    assert.equal(seeded.count, sample.count); assert.equal((await fixture.hub.status()).lastSeq, sample.count);
    assert.deepEqual(await producer.stop(), { code: 0, signal: null });
    const disk = await diskSample(fixture.logDir); await fixture.stop();
    const restarted = await fixture.start(); assert.notEqual(restarted.pid, initial.pid);
    assert.equal((await fixture.hub.status()).lastSeq, sample.count);
    const coldRssBytes = await processRss(restarted.pid);
    const all = await fixture.program('all', { mode: 'consume', filters: ['scale/#'], ...sample, initialPauseMs: 500, ackDelayMs: 2 });
    await event(all, 'first_window');
    const observed = (await fixture.hub.status()).subscriptions.find((sub) => sub.bridgeId === all.ready.bridge);
    assert.equal(observed.windowLimit, 17); assert.equal(observed.pending, 17); assert.equal(observed.effectiveBatchLimit, 0);
    assert.equal(observed.catchUpTarget, sample.count); assert.equal(observed.catchUp, true);
    assert.ok(observed.scannedUpTo >= 17); assert.ok(Number.isFinite(Date.parse(observed.lastProgressAt)));
    const rare = await fixture.program('rare', { mode: 'consume', filters: ['scale/rare'], ...sample, initialPauseMs: 150, ackDelayMs: 2 });
    const completed = await Promise.all([event(all, 'completed'), event(rare, 'completed')]);
    const allSeq = Array.from({ length: sample.count }, (_, n) => n + 1);
    const rareSeq = allSeq.filter((seq) => (seq - 1) % 101 === 0);
    assert.equal(completed[0].count, sample.count); assert.equal(completed[0].sequenceHash, sequenceHash(allSeq));
    assert.equal(completed[1].count, rareSeq.length); assert.equal(completed[1].sequenceHash, sequenceHash(rareSeq));
    for (const result of completed) assert.equal(result.through, sample.count);
    const finalStatus = await until(async () => {
      const status = await fixture.hub.status(); return status.subscriptions.length === 2 && status.subscriptions.every((sub) => sub.pending === 0 && !sub.catchUp) && status;
    }, { what: 'final ACKs reach the actual hub' });
    for (const sub of finalStatus.subscriptions) { assert.equal(sub.scannedUpTo, sample.count); assert.equal(sub.catchUpTarget, sample.count); assert.equal(sub.effectiveBatchLimit, 17); }
    assert.equal(finalStatus.counters.catchUpTruncated, 0);
    assert.ok(!finalStatus.recent.some((entry) => entry.code === 'CATCHUP_STALLED'));
    const afterReplayRssBytes = await processRss(restarted.pid);
    assert.equal(new Set([process.pid, initial.pid, restarted.pid, producer.child.pid, all.child.pid, rare.child.pid]).size, 6);
    const details = { ...sample, disk, hubs: fixture.hubs, programPids: { producer: producer.child.pid, all: all.child.pid, rare: rare.child.pid },
      rss: { emptyRssBytes, coldRssBytes, afterReplayRssBytes, method: process.platform === 'win32' ? 'OS WorkingSet64 snapshots, not JS heap or peak memory' : 'OS RSS snapshots' },
      all: completed[0], rare: completed[1], blockedWindowSnapshot: observed, finalSubscriptions: finalStatus.subscriptions };
    samples.push(details);
  }
  diagnostic(t, { id: 'REC-01', platform: process.platform, node: process.version, scope: 'local samples only; no general memory ratio, load SLA or power-loss claim', samples });
});
test('REC-02 raw LF/CRLF formatting and precise numeric spellings survive real network publication, disk lines, hub restart and catch-up', { timeout: 60000 }, async (t) => {
  const rawBodies = [
    '{\n  "整数":9007199254740993, "nested": [1e+02, -0, "\\u4e16"], "line":"first\\nsecond"\n}',
    '{\r\n\t"n":9007199254740995, "escaped":"\\u0061", "unit":1e0, "value":-0\r\n}',
  ];
  const fixture = await ownedFixture(t); const original = await fixture.start();
  const provider = await fixture.program('seed', { mode: 'raw-seed', rawBodies }); await event(provider, 'completed');
  assert.deepEqual(await provider.stop(), { code: 0, signal: null });
  let records = 0;
  for (const name of (await readdir(fixture.logDir)).filter((name) => name.endsWith('.jsonl'))) {
    const text = await readFile(join(fixture.logDir, name), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      const record = JSON.parse(line); assert.equal(record.bodyRaw, rawBodies[records]); records++;
    }
  }
  assert.equal(records, rawBodies.length); await fixture.stop();
  const restarted = await fixture.start(); assert.notEqual(restarted.pid, original.pid);
  const receiver = await fixture.program('raw', { mode: 'raw-consume', filters: ['raw/#'], rawBodies });
  const completed = await event(receiver, 'completed');
  assert.equal(completed.count, rawBodies.length); assert.deepEqual(completed.rawHashes, rawBodies.map(rawHash));
  assert.equal(completed.through, rawBodies.length);
  diagnostic(t, { id: 'REC-02', hubs: fixture.hubs, programs: { producer: provider.child.pid, receiver: receiver.child.pid }, rawBodies, completed,
    persistence: 'JSONL bodyRaw is a JSON-escaped string; reloaded original text is forwarded as the body span' });
});
test('REC-03 configured catch-up batch can exceed 256 and still respects maxCatchUpMessages and remaining window', async () => {
  for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeConfig({ limits: { catchUpBatchSize: value } }), /catchUpBatchSize/);
  for (const settings of [{ catchUpBatchSize: 600, maxCatchUpMessages: 5000, maxPendingDeliveries: 700, count: 601, expected: [600, 100] },
    { catchUpBatchSize: 600, maxCatchUpMessages: 7, maxPendingDeliveries: 19, count: 19, expected: [7, 7, 5] }]) {
    const root = await mkdtemp(join(tmpdir(), 'peros-recovery-probe-'));
    const hub = await Hub.create(normalizeConfig({ log: { enabled: false, dir: join(root, 'log') }, blobs: { dir: join(root, 'blobs') }, management: { stateFile: join(root, 'manage.json') },
      limits: settings, acl: { bridges: { seed: { allow: { publish: ['#'], subscribe: ['#'] } }, all: { allow: { publish: ['#'], subscribe: ['#'] } } } } }));
    class Connection extends EventEmitter { constructor() { super(); this.frames = []; this.remoteAddress = '127.0.0.1'; } send(raw) { this.frames.push(JSON.parse(raw)); return true; } close() { this.emit('close'); } }
    const limits = [], originalRange = hub.log.range.bind(hub.log);
    hub.log.range = (args) => { limits.push(args.limit); return originalRange(args); };
    const input = async (conn, frame) => { conn.emit('message', JSON.stringify(frame)); await new Promise((resolve) => setImmediate(resolve)); };
    try {
      const provider = new Connection(); hub.onConnection(provider); await input(provider, { type: 'hello', wire: '0.1', bridge: 'seed' });
      for (let n = 0; n < settings.count; n++) await input(provider, { type: 'publish', topic: 'batch/test', body: { n } });
      await until(() => hub.log.lastSeq === settings.count);
      const reader = new Connection(); hub.onConnection(reader); await input(reader, { type: 'hello', wire: '0.1', bridge: 'all' });
      await input(reader, { type: 'subscribe', filters: ['#'], from: 0 });
      assert.deepEqual(limits, settings.expected);
      assert.equal(reader.frames.filter((frame) => frame.type === 'delivery').length, settings.count);
      const state = hub.snapshot().subscriptions[0]; assert.equal(state.windowLimit, settings.maxPendingDeliveries); assert.equal(state.effectiveBatchLimit, Math.min(settings.catchUpBatchSize, settings.maxCatchUpMessages, settings.maxPendingDeliveries - settings.count));
    } finally { await hub.stop(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); }
  }
});
