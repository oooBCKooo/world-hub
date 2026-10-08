#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness } from '../../tests/helpers/hub-harness.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const bytes = Number(arg('--bytes') ?? 100 * 1024 * 1024);
if (!Number.isSafeInteger(bytes) || bytes <= 4 * 1024 * 1024) throw new Error('--bytes must exceed 4 MiB');
const evidence = arg('--evidence');
const dir = await mkdtemp(join(tmpdir(), 'peros-phase4-'));
const peers = [];
const harness = new Harness();
const events = [];
const memory = [];
let sampling = false;
let closing = false;
let timer;
function bounded(promise, ms, label) {
  let deadline;
  return Promise.race([promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(deadline));
}
async function sample() {
  if (sampling || !harness.hub) return;
  sampling = true;
  const pids = [harness.hub.pid, ...peers.map((peer) => peer.child.pid)];
  try {
    if (process.platform === 'win32') {
      const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10_000 });
      const values = JSON.parse(result.stdout || '[]');
      for (const entry of Array.isArray(values) ? values : [values]) memory.push({ at: Date.now(), pid: entry.Id, rss: entry.WorkingSet64 });
    } else if (process.platform === 'linux') {
      for (const pid of pids) {
        const text = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
        const match = text.match(/^VmRSS:\s+(\d+)\s+kB/m);
        if (match) memory.push({ at: Date.now(), pid, rss: Number(match[1]) * 1024 });
      }
    }
  } catch { /* An exited fixture may disappear between process sampling and lookup. */ }
  finally { sampling = false; }
}
function launch(role) {
  const child = spawn(process.execPath, [join(here, './fixture-peer.mjs'), role, harness.endpoint, dir, String(bytes)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  let becameReady = false;
  let completed = false;
  let resolveReady, rejectReady, resolveDone, rejectDone;
  const ready = new Promise((r, j) => { resolveReady = r; rejectReady = j; });
  const done = new Promise((r, j) => { resolveDone = r; rejectDone = j; });
  ready.catch(() => {}); done.catch(() => {});
  child.stderr.on('data', (value) => { stderr += value.toString(); });
  child.stdout.on('data', (value) => {
    buffer += value.toString();
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line); events.push(entry);
        if (entry.event === 'ready') { becameReady = true; resolveReady(entry); }
        if (entry.event === 'done') { completed = true; resolveDone(entry); }
        if (entry.event === 'failed') { const error = new Error(entry.message); rejectReady(error); rejectDone(error); }
      } catch (error) { rejectDone(error); }
    }
  });
  child.on('error', (error) => { rejectReady(error); rejectDone(error); });
  child.on('exit', (code) => {
    if (!closing && (code !== 0 || (role === 'caller' ? !completed : !becameReady || !completed))) {
      const error = new Error(`${role} exited before its expected completion (${code}): ${stderr}`); rejectReady(error); rejectDone(error);
    }
  });
  const peer = { role, child, ready, done }; peers.push(peer); return peer;
}
try {
  const configPath = join(dir, 'hub.json');
  const allow = { publish: ['chosen/#'], subscribe: ['chosen/#'] };
  await writeFile(configPath, JSON.stringify({ acl: { bridges: Object.fromEntries(['fixture.provider', 'fixture.receiver', 'fixture.caller.control', 'fixture.caller.bulk'].map((id) => [id, { allow }])) }, blobs: { maxObjectBytes: Math.max(bytes, 1024 ** 3), maxTotalBytes: Math.max(bytes * 2, 2 * 1024 ** 3) } }));
  await harness.startHub({ configPath });
  const provider = launch('provider'); const receiver = launch('receiver');
  await bounded(Promise.all([provider.ready, receiver.ready]), 10_000, 'phase4 programs becoming ready');
  await sample(); timer = setInterval(() => void sample(), 750); timer.unref();
  const caller = launch('caller');
  const completed = await bounded(Promise.race([caller.done, provider.done, receiver.done]), 150_000, 'phase4 transfer');
  await sample();
  const peaks = Object.fromEntries([['hub', harness.hub.pid], ...peers.map((p) => [p.role, p.child.pid])].map(([name, pid]) => {
    const samples = memory.filter((entry) => entry.pid === pid);
    return [name, { pid, samples: samples.length, baselineRss: samples[0]?.rss ?? null, peakRss: samples.length ? Math.max(...samples.map((entry) => entry.rss)) : null }];
  }));
  const report = { passed: true, bytes, chunkBytes: 256 * 1024, completed, peaks, events, memory, limitations: ['RSS is sampled process working set, not a proven heap upper bound', 'No power-loss, cross-host or long-duration load acceptance'] };
  if (evidence) { const path = resolve(evidence); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2)); }
  process.stdout.write(JSON.stringify({ passed: report.passed, bytes, completed, peaks }) + '\n');
} catch (error) {
  process.stderr.write((error.stack ?? String(error)) + '\n'); process.exitCode = 1;
} finally {
  clearInterval(timer);
  closing = true;
  for (const peer of peers) if (peer.child.exitCode === null) peer.child.kill();
  await Promise.all(peers.map((peer) => peer.child.exitCode !== null ? undefined : new Promise((resolve) => peer.child.once('exit', resolve))));
  await harness.stop();
  if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !basename(dir).startsWith('peros-phase4-')) throw new Error('fixture cleanup target escaped its generated temporary root');
  await rm(dir, { recursive: true, force: true });
}
