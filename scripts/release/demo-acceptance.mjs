import { runtimeForBundle } from './runtime-helper.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createConnection } from 'node:net';

function argumentsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index], value = argv[++index];
    if (!['--bundle', '--evidence'].includes(option) || !value || !isAbsolute(value)) throw new Error('usage: node demo-acceptance.mjs --bundle <absolute bundle root> --evidence <new absolute directory>');
    args[option.slice(2)] = resolve(value);
  }
  if (!args.bundle || !args.evidence || args.evidence === args.bundle || args.evidence.startsWith(args.bundle + sep)) throw new Error('a bundle and a new evidence directory outside it are required');
  return args;
}
async function hash(path) {
  const value = createHash('sha256'); for await (const block of createReadStream(path)) value.update(block); return value.digest('hex');
}
async function dataInventory(root) {
  try { await stat(root); } catch (error) { if (error.code === 'ENOENT') return { exists: false, entries: [] }; throw error; }
  const entries = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), name = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`unexpected data symlink: ${path}`);
      if (entry.isDirectory()) { entries.push({ path: name, type: 'directory' }); await walk(path); }
      else entries.push({ path: name, size: (await stat(path)).size, sha256: await hash(path) });
    }
  }
  await walk(root); return { exists: true, entries };
}
function bounded(promise, milliseconds, label) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function eventually(read, accepts, label) {
  const deadline = Date.now() + 15_000;
  do { const value = await read(); if (accepts(value)) return value; await delay(100); } while (Date.now() < deadline);
  throw new Error(`${label} was not observed`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
async function listening(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port }); let settled = false;
    const settle = value => { if (settled) return; settled = true; socket.destroy(); done(value); };
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false)); socket.setTimeout(1000, () => settle(false));
  });
}
async function run() {
  const args = argumentsOf(process.argv.slice(2)); await mkdir(args.evidence, { recursive: false });
  const cwd = await mkdtemp(join(tmpdir(), '枢纽 分发 示例 隔离 cwd '));
  const executable = await runtimeForBundle(args.bundle), entry = join(args.bundle, 'examples/management/run-management-demo.mjs');
  await stat(executable); await stat(entry);
  const configPath = join(args.bundle, 'config/hub.json'), dataPath = join(args.bundle, 'data');
  const before = { configurationSha256: await hash(configPath), data: await dataInventory(dataPath) };
  const report = { passed: false, startedAt: new Date().toISOString(), bundle: args.bundle, executable, entry, cwd, before,
    stdout: '', stderr: '', ready: null, exit: null, childPids: [], checks: [] };
  const save = (name, value) => writeFile(join(args.evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  let child, exited, port = null;
  try {
    const nodeVersion = spawn(executable, ['--version'], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let version = ''; nodeVersion.stdout.on('data', bytes => { version += bytes; });
    const versionExit = await bounded(new Promise((done, reject) => { nodeVersion.once('error', reject); nodeVersion.once('close', (code, signal) => done({ code, signal })); }), 5000, 'package Node version');
    assert.equal(versionExit.code, 0); report.packagedNodeVersion = version.trim();
    child = spawn(executable, [entry], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); report.pid = child.pid;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let resolveReady, rejectReady, buffer = '';
    const ready = new Promise((accept, reject) => { resolveReady = accept; rejectReady = reject; }); ready.catch(() => {});
    exited = new Promise((done, reject) => {
      child.once('error', error => { rejectReady(error); reject(error); });
      child.once('close', (code, signal) => { report.exit = { code, signal }; if (!report.ready) rejectReady(new Error(`demo exited before ready: ${code}: ${report.stderr}`)); done(report.exit); });
    });
    child.stdout.on('data', text => {
      report.stdout += text; buffer += text;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const value = JSON.parse(line); if (value.event === 'ready') { report.ready = value; resolveReady(value); } } catch { /* Diagnostics never count as a ready receipt. */ }
      }
    });
    child.stderr.on('data', text => { report.stderr += text; });
    const demoReady = await bounded(ready, 20_000, 'all demo programs ready');
    assert.equal(demoReady.pid, child.pid); assert.ok(Array.isArray(demoReady.pids) && demoReady.pids.length === 4);
    report.childPids = demoReady.pids; assert.equal(new Set([child.pid, ...demoReady.pids]).size, 5);
    const base = new URL(demoReady.url).origin; port = Number(new URL(demoReady.url).port);
    const json = async path => { const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200, path); return response.json(); };
    const manage = await fetch(base + '/manage', { signal: AbortSignal.timeout(5000) }); assert.equal(manage.status, 200); assert.match(await manage.text(), /btn-manual-console/);
    const status = await json('/status');
    const identities = ['sample.alpha', 'sample.beta', 'sample.panel'];
    assert.deepEqual(status.bridges.map(bridge => bridge.bridgeId).sort(), identities);
    for (const identity of identities) {
      const bridge = status.bridges.find(item => item.bridgeId === identity);
      assert.ok(bridge.channels.length > 0); assert.ok(bridge.subscriptions.length > 0); assert.equal(bridge.authenticated, false, 'the demo explicitly uses tokenless loopback ACL entries');
    }
    report.checks.push({ name: 'three actual independent mod bridges and registered channels', passed: true });
    const state = await json('/manage/api/state');
    for (const [identity, program] of [['sample.alpha', 'program.alpha'], ['sample.beta', 'program.beta'], ['sample.panel', 'program.panel']]) {
      const bridge = state.bridges.find(item => item.key === identity);
      assert.equal(bridge.instances.length, 1); assert.equal(bridge.programs[0].id, program); assert.ok(bridge.label !== identity);
    }
    report.checks.push({ name: 'external-program annotations displayed in management state', passed: true });
    const records = await eventually(() => json('/log?limit=50'), log => identities.every(identity => log.records.some(record => record.from === identity)), 'messages from both providers and return messages from the observer');
    const sampleRecords = records.records.filter(record => record.body?.kind === 'sample');
    assert.ok(sampleRecords.some(record => record.from === 'sample.alpha' && record.body.source === 'sample.alpha'));
    assert.ok(sampleRecords.some(record => record.from === 'sample.beta' && record.body.source === 'sample.beta'));
    assert.ok(records.records.some(record => record.from === 'sample.panel' && record.body?.kind === 'sample-feedback' && sampleRecords.some(source => source.seq === record.body.receivedSequence)));
    const eventState = await json('/manage/api/state'); assert.ok(eventState.events.some(event => event.kind === 'message')); assert.ok(eventState.events.some(event => event.kind === 'delivery' && event.sent));
    report.checks.push({ name: 'provider events and observer replies use real Hub message flow', passed: true });
    await save('status.json', status); await save('management-state.json', state); await save('log-records.json', records); await save('state-with-message-events.json', eventState);
    const disk = [];
    for (const file of await readdir(join(demoReady.evidenceDir, 'log'))) {
      if (!/^log-\d+\.jsonl$/.test(file)) continue;
      for (const line of (await readFile(join(demoReady.evidenceDir, 'log', file), 'utf8')).split(/\r?\n/)) if (line.trim()) disk.push(JSON.parse(line));
    }
    assert.ok(identities.every(identity => disk.some(record => record.owner === identity)));
    await save('actual-disk-log.json', disk); report.fixtureDirectory = demoReady.evidenceDir;
    child.send({ type: 'stop' }); const exit = await bounded(exited, 10_000, 'demo IPC graceful stop'); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
    await eventually(() => demoReady.pids.map(pid => ({ pid, alive: alive(pid) })), states => states.every(state => !state.alive), 'all nested owned processes stop');
    assert.equal(await listening(port), false);
    report.checks.push({ name: 'IPC stops the demo launcher, Hub and all three external programs', passed: true });
    report.after = { configurationSha256: await hash(configPath), data: await dataInventory(dataPath) }; assert.deepEqual(report.after, before);
    assert.deepEqual(await readdir(cwd), []); report.checks.push({ name: 'demo leaves default package configuration, data and unrelated cwd untouched', passed: true });
    report.passed = true;
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; console.error(error.stack ?? error); }
  finally {
    if (child && !report.exit) {
      try { if (child.connected) child.send({ type: 'stop' }); else child.kill('SIGTERM'); await bounded(exited, 10_000, 'cleanup demo stop'); }
      catch (error) { report.cleanupError = error.message; child.kill('SIGKILL'); try { await bounded(exited, 5000, 'forced owned parent stop'); } catch {} }
    }
    report.ownedProcessesAfterStop = [...new Set([report.pid, ...report.childPids].filter(Number.isInteger))].map(pid => ({ pid, alive: alive(pid) }));
    report.listenerAfterStop = port === null ? null : { port, listening: await listening(port) };
    report.passed &&= !report.cleanupError && report.ownedProcessesAfterStop.every(item => !item.alive) && report.listenerAfterStop?.listening === false;
    report.endedAt = new Date().toISOString(); await save('report.json', report);
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: join(args.evidence, 'report.json'), retainedFixture: report.fixtureDirectory ?? null }));
    if (!report.passed) process.exitCode = 1;
  }
}
run().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
