import { runtimeForBundle } from './runtime-helper.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';

const TIMEOUT = 12_000;
const TOPIC = 'cursor/topic';
const FILTERS = [TOPIC];
function argumentsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index], value = argv[++index];
    if (!['--bundle', '--evidence'].includes(option) || !value || !isAbsolute(value)) throw new Error('usage: node multi-hub-state-check.mjs --bundle <absolute unpacked root> --evidence <new absolute directory>; use package Node for a portable bundle');
    if (args[option.slice(2)]) throw new Error(`duplicate ${option}`);
    args[option.slice(2)] = resolve(value);
  }
  if (!args.bundle || !args.evidence || args.evidence === args.bundle || args.evidence.startsWith(args.bundle + sep)) throw new Error('bundle and a new evidence directory outside it are required');
  return args;
}
async function hash(path) {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex');
}
async function inventory(root) {
  const items = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), name = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink: ${path}`);
      if (entry.isDirectory()) { items.push({ path: name, kind: 'directory' }); await walk(path); }
      else items.push({ path: name, size: (await stat(path)).size, sha256: await hash(path) });
    }
  }
  await walk(root); return items;
}
function bounded(promise, milliseconds, label) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function eventually(read, accepts, label) {
  const deadline = Date.now() + TIMEOUT;
  do { const value = await read(); if (accepts(value)) return value; await delay(30); } while (Date.now() < deadline);
  throw new Error(`${label} was not observed`);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; } }
async function listening(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port }); let settled = false;
    const settle = value => { if (settled) return; settled = true; socket.destroy(); done(value); };
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false)); socket.setTimeout(1000, () => settle(false));
  });
}
async function readCursor(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function run() {
  const args = argumentsOf(process.argv.slice(2));
  const packagedRuntime = await runtimeForBundle(args.bundle);
  const manifest = JSON.parse(await readFile(join(args.bundle, 'manifest.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  if (manifest.runtime) assert.equal(resolve(process.execPath).toLowerCase(), resolve(packagedRuntime).toLowerCase(), 'portable acceptance must run with its bundled runtime');
  await mkdir(args.evidence, { recursive: false });
  const temporaryRoot = await mkdtemp(join(tmpdir(), '枢纽 多部署 游标检查 '));
  const copies = { a: join(temporaryRoot, '部署 A 整合包'), b: join(temporaryRoot, '部署 B 整合包') };
  const cwd = join(temporaryRoot, '消费者 工作目录'); await mkdir(cwd);
  const report = { passed: false, startedAt: new Date().toISOString(), bundle: args.bundle, evidence: args.evidence, pid: process.pid,
    runtime: process.version, executable: process.execPath, temporaryRoot, copies, cwd, checks: [], hubs: [], bridges: [], cleanupErrors: [] };
  const children = [], peers = [];
  const save = (name, value) => writeFile(join(args.evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  async function step(name, action) {
    try { const detail = await action(); report.checks.push({ name, passed: true, detail }); console.log(JSON.stringify({ event: 'check', name, passed: true })); return detail; }
    catch (error) { report.checks.push({ name, passed: false, error: error.message }); throw error; }
  }
  async function startHub(label, bundle) {
    const executable = await runtimeForBundle(bundle), launcher = join(bundle, 'scripts/launcher.mjs');
    const child = spawn(executable, [launcher, '--port', '0'], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const record = { label, pid: child.pid, executable, command: [launcher, '--port', '0'], stdout: '', stderr: '', messages: [], ready: null, exit: null };
    report.hubs.push(record);
    const owned = { child, record }; children.push(owned);
    let acceptReady, rejectReady;
    const ready = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; }); ready.catch(() => {});
    owned.exit = new Promise((done, reject) => {
      child.once('error', error => { rejectReady(error); reject(error); });
      child.once('close', (code, signal) => { record.exit = { code, signal }; if (!record.ready) rejectReady(new Error(`Hub ${label} exited before ready: ${record.stderr}`)); done(record.exit); });
    });
    child.stdout.on('data', chunk => { record.stdout += chunk.toString('utf8'); }); child.stderr.on('data', chunk => { record.stderr += chunk.toString('utf8'); });
    child.on('message', message => { record.messages.push(message); if (message?.type === 'ready') { record.ready = message; acceptReady(message); } });
    await bounded(ready, TIMEOUT, `Hub ${label} ready`); return owned;
  }
  async function stopHub(owned) {
    if (owned.record.exit) return owned.record.exit;
    if (owned.child.connected) owned.child.send({ type: 'stop' }); else owned.child.kill('SIGTERM');
    try { return await bounded(owned.exit, 8000, 'Hub IPC stop'); }
    catch (error) { owned.record.forcedStopReason = error.message; owned.child.kill('SIGKILL'); return bounded(owned.exit, 5000, 'forced owned Hub stop'); }
  }
  const json = async (hub, path = '/manage/api/state') => { const response = await fetch(hub.record.ready.httpBase + path, { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); return response.json(); };
  const diagnostics = async (hub, subscription) => (await json(hub)).hub.subscriptions.find(item => item.id === subscription);
  async function waitDiagnostic(hub, subscription, cursor, pending) {
    return eventually(() => diagnostics(hub, subscription), item => item?.cursor === cursor && item.pending === pending, `cursor=${cursor} pending=${pending}`);
  }
  async function closePeers(...records) {
    for (const item of records) await bounded(item.bridge.close(), 3000, 'SDK bridge close');
  }
  async function waitEmpty(...hubs) {
    for (const hub of hubs) await eventually(() => json(hub), state => state.hub.bridges.length === 0, 'closed bridge removal');
  }
  try {
    const before = await inventory(args.bundle);
    report.sourceHashes = {
      checker: await hash(fileURLToPath(import.meta.url)),
      sdk: await hash(join(args.bundle, 'sdk/javascript/bridge-kit.mjs')),
      launcher: await hash(join(args.bundle, 'scripts/launcher.mjs')),
      manifest: await hash(join(args.bundle, 'manifest.json')),
    };
    await cp(args.bundle, copies.a, { recursive: true, force: false, errorOnExist: true });
    await cp(args.bundle, copies.b, { recursive: true, force: false, errorOnExist: true });
    const [hubA, hubB] = await Promise.all([startHub('deployment-a', copies.a), startHub('deployment-b', copies.b)]);
    await step('two independent packaged launchers operate concurrently', async () => {
      assert.notEqual(hubA.record.ready.port, hubB.record.ready.port);
      for (const [hub, bundle] of [[hubA, copies.a], [hubB, copies.b]]) for (const type of ['log', 'blobs', 'management']) assert.ok(resolve(hub.record.ready.storage[type].path).startsWith(join(bundle, 'data') + sep));
      assert.equal((await json(hubA, '/status')).lastSeq, 0); assert.equal((await json(hubB, '/status')).lastSeq, 0);
      return { a: hubA.record.ready, b: hubB.record.ready };
    });
    const { Bridge } = await import(pathToFileURL(join(args.bundle, 'sdk/javascript/bridge-kit.mjs')).href);
    function make(hub, bridgeId, cursorFile, { autoAck = true, instanceId } = {}) {
      const bridge = new Bridge({ url: hub.record.ready.wsUrl, bridgeId, credential: 'ui.manual', cursorFile, autoAck, ...(instanceId === undefined ? {} : { instanceId }) });
      const record = { hub: hub.record.label, bridgeId, cursorFile, instanceId: instanceId ?? null, autoAck, loadedCursor: bridge.cursorOf(FILTERS), deliveries: [], caughtUp: [], errors: [], denied: [], receipts: [] };
      // Observe transport diagnostics before connect and catch its Promise in the
      // caller. Empty listeners are not a substitute for catching rejection.
      bridge.on('error', frame => record.errors.push(frame)); bridge.on('denied', frame => record.denied.push(frame));
      bridge.on('delivery', frame => { record.deliveries.push(frame); }); bridge.on('caughtUp', frame => { record.caughtUp.push(frame); });
      const peer = { bridge, record }; peers.push(peer); report.bridges.push(record); return peer;
    }
    async function connect(...records) { for (const peer of records) { peer.record.welcome = await bounded(peer.bridge.connect(), TIMEOUT, 'SDK connect'); } }
    async function subscribe(peer, from) { const receipt = await bounded(peer.bridge.subscribe(FILTERS, { from }), TIMEOUT, 'SDK subscribe'); peer.record.receipts.push({ from, ...receipt }); return receipt; }
    async function caughtUp(peer, subscription) { return eventually(() => peer.record.caughtUp.find(frame => frame.subscription === subscription), Boolean, 'caught_up for actual subscription'); }
    async function delivered(peer, sequences) {
      await eventually(() => peer.record.deliveries.map(frame => frame.seq), seq => seq.length >= sequences.length, 'expected deliveries');
      assert.deepEqual(peer.record.deliveries.map(frame => frame.seq), sequences);
    }
    const sharedLow = join(temporaryRoot, '消费者状态', '故意共用 lower.json');
    const lowA = make(hubA, 'cursor.shared-low', sharedLow), lowB = make(hubB, 'cursor.shared-low', sharedLow);
    await step('both SDK consumers load the same empty cursor before either writes', async () => {
      assert.equal(lowA.record.loadedCursor, null); assert.equal(lowB.record.loadedCursor, null); assert.equal(await readCursor(sharedLow), null);
      await connect(lowA, lowB); assert.equal(lowA.record.welcome.principal, lowB.record.welcome.principal); assert.notEqual(lowA.record.welcome.session, lowB.record.welcome.session);
      for (let number = 1; number <= 5; number++) assert.equal((await lowA.bridge.publishConfirmed(TOPIC, { deployment: 'a', number })).seq, number);
      assert.equal((await lowB.bridge.publishConfirmed(TOPIC, { deployment: 'b', number: 1 })).seq, 1);
      return { effectiveResumeCursorA: 0, effectiveResumeCursorB: 0, loadedA: null, loadedB: null, recordsA: 5, recordsB: 1 };
    });
    await step('shared-file 5 then 1 overwrite causes rewind and reread rather than proving skip', async () => {
      const a = await subscribe(lowA, 0); await delivered(lowA, [1, 2, 3, 4, 5]);
      await eventually(() => lowA.bridge.cursorOf(FILTERS), value => value === 5, 'A commits 5'); await waitDiagnostic(hubA, a.subscription, 5, 0);
      const afterA = await readCursor(sharedLow); assert.deepEqual(Object.values(afterA), [5]); await save('shared-file-after-a-five.json', afterA);
      const b = await subscribe(lowB, 0); await delivered(lowB, [1]);
      await eventually(() => lowB.bridge.cursorOf(FILTERS), value => value === 1, 'B commits 1'); await waitDiagnostic(hubB, b.subscription, 1, 0);
      const afterB = await readCursor(sharedLow); assert.deepEqual(Object.values(afterB), [1]); assert.deepEqual(Object.keys(afterB), Object.keys(afterA)); await save('shared-file-after-b-one.json', afterB);
      await closePeers(lowA, lowB); await waitEmpty(hubA, hubB);
      const reopenedA = make(hubA, 'cursor.shared-low', sharedLow, { autoAck: false }); assert.equal(reopenedA.record.loadedCursor, 1); await connect(reopenedA);
      const resumed = await subscribe(reopenedA, 'resume'); assert.equal(resumed.cursor, 1); await delivered(reopenedA, [2, 3, 4, 5]); await caughtUp(reopenedA, resumed.subscription);
      const state = await waitDiagnostic(hubA, resumed.subscription, 1, 4); await save('lower-overwrite-reread-state.json', state);
      await closePeers(reopenedA); await waitEmpty(hubA);
      return { afterA, afterB, resumedFrom: resumed.cursor, repeatedSequences: [2, 3, 4, 5], classification: 'overwrite and rewind/reread; this case alone does not demonstrate loss' };
    });
    const sharedHigh = join(temporaryRoot, '消费者状态', '故意共用 higher.json');
    await step('other-Hub high watermark can skip five retained unacknowledged records on resume', async () => {
      const publisherB = make(hubB, 'cursor.b-publisher', null); await connect(publisherB);
      for (let number = 2; number <= 5; number++) assert.equal((await publisherB.bridge.publishConfirmed(TOPIC, { deployment: 'b', number })).seq, number);
      await closePeers(publisherB); await waitEmpty(hubB);
      const sourceA = make(hubA, 'cursor.shared-high', sharedHigh), unfinishedB = make(hubB, 'cursor.shared-high', sharedHigh, { autoAck: false });
      assert.equal(sourceA.record.loadedCursor, null); assert.equal(unfinishedB.record.loadedCursor, null); await connect(sourceA, unfinishedB);
      const beforeB = await subscribe(unfinishedB, 0); await delivered(unfinishedB, [1, 2, 3, 4, 5]);
      assert.equal(unfinishedB.bridge.cursorOf(FILTERS), null); assert.equal(await readCursor(sharedHigh), null);
      const unacknowledged = await waitDiagnostic(hubB, beforeB.subscription, 0, 5); await save('b-retained-but-unacknowledged.json', unacknowledged);
      const a = await subscribe(sourceA, 0); await delivered(sourceA, [1, 2, 3, 4, 5]);
      await eventually(() => sourceA.bridge.cursorOf(FILTERS), value => value === 5, 'A commits high watermark'); await waitDiagnostic(hubA, a.subscription, 5, 0);
      const foreignWatermark = await readCursor(sharedHigh); assert.deepEqual(Object.values(foreignWatermark), [5]); await save('foreign-a-watermark-in-shared-file.json', foreignWatermark);
      await closePeers(sourceA, unfinishedB); await waitEmpty(hubA, hubB);
      const reopenedB = make(hubB, 'cursor.shared-high', sharedHigh, { autoAck: false }); assert.equal(reopenedB.record.loadedCursor, 5); await connect(reopenedB);
      const resumed = await subscribe(reopenedB, 'resume'); assert.equal(resumed.cursor, 5); await caughtUp(reopenedB, resumed.subscription);
      assert.deepEqual(reopenedB.record.deliveries, []); const skipped = await waitDiagnostic(hubB, resumed.subscription, 5, 0);
      const retained = await json(hubB, '/log?limit=50'); assert.deepEqual(retained.records.map(record => record.seq), [1, 2, 3, 4, 5]);
      assert.deepEqual(reopenedB.record.errors, [], 'no ahead/clamp warning is needed because both logs have lastSeq 5');
      await save('b-resume-five-no-delivery.json', { receipt: resumed, caughtUp: reopenedB.record.caughtUp, diagnostic: skipped, deliveries: [] }); await save('b-five-records-still-retained.json', retained);
      const replay = await reopenedB.bridge.replay(FILTERS, { from: 0 }); reopenedB.record.receipts.push({ explicitReplay: true, ...replay }); await delivered(reopenedB, [1, 2, 3, 4, 5]); await caughtUp(reopenedB, replay.subscription);
      await closePeers(reopenedB); await waitEmpty(hubB);
      return { bBefore: { cursor: 0, pending: 5, acknowledgedSequences: [] }, aSavedSharedCursor: 5, bAfterResume: { cursor: 5, pending: 0, delivered: [] }, explicitReplayRecovered: [1, 2, 3, 4, 5], releasedMessages: 0,
        classification: 'wrong external cursor silently skips still-retained work; no Hub deletion or payload loss occurred' };
    });
    await step('deployment plus bridge-instance cursor files keep simultaneous consumers independent', async () => {
      const bridgeId = 'cursor.isolated', instanceId = 'reader-one';
      const cursorA = join(temporaryRoot, '消费者状态', 'deployment-a', bridgeId, `${instanceId}.json`), cursorB = join(temporaryRoot, '消费者状态', 'deployment-b', bridgeId, `${instanceId}.json`);
      const isolatedA = make(hubA, bridgeId, cursorA, { instanceId }), isolatedB = make(hubB, bridgeId, cursorB, { instanceId, autoAck: false }); await connect(isolatedA, isolatedB);
      const a = await subscribe(isolatedA, 0), b = await subscribe(isolatedB, 0); await delivered(isolatedA, [1, 2, 3, 4, 5]); await delivered(isolatedB, [1, 2, 3, 4, 5]);
      assert.equal(isolatedB.bridge.ack(isolatedB.record.deliveries[0]), true);
      await eventually(() => isolatedA.bridge.cursorOf(FILTERS), value => value === 5, 'isolated A commits 5'); await waitDiagnostic(hubA, a.subscription, 5, 0); await waitDiagnostic(hubB, b.subscription, 1, 4);
      const fileA = await readCursor(cursorA), fileB = await readCursor(cursorB); assert.deepEqual(Object.values(fileA), [5]); assert.deepEqual(Object.values(fileB), [1]); assert.deepEqual(Object.keys(fileA), Object.keys(fileB));
      await save('independent-cursor-a-five.json', fileA); await save('independent-cursor-b-one.json', fileB);
      await closePeers(isolatedA, isolatedB); await waitEmpty(hubA, hubB);
      const resumedA = make(hubA, bridgeId, cursorA, { instanceId }), resumedB = make(hubB, bridgeId, cursorB, { instanceId });
      assert.equal(resumedA.record.loadedCursor, 5); assert.equal(resumedB.record.loadedCursor, 1); await connect(resumedA, resumedB);
      const resumeA = await subscribe(resumedA, 'resume'), resumeB = await subscribe(resumedB, 'resume'); assert.equal(resumeA.cursor, 5); assert.equal(resumeB.cursor, 1);
      await caughtUp(resumedA, resumeA.subscription); assert.deepEqual(resumedA.record.deliveries, []); await delivered(resumedB, [2, 3, 4, 5]);
      await eventually(() => resumedB.bridge.cursorOf(FILTERS), value => value === 5, 'isolated B finishes its own remaining records'); await waitDiagnostic(hubB, resumeB.subscription, 5, 0);
      assert.deepEqual(await readCursor(cursorA), fileA, 'B completion never modifies A cursor file');
      await save('independent-resume-summary.json', { cursorA, cursorB, resumeA, resumeB, deliveriesA: [], deliveriesB: [2, 3, 4, 5], finalA: await readCursor(cursorA), finalB: await readCursor(cursorB) });
      await closePeers(resumedA, resumedB); await waitEmpty(hubA, hubB);
      return { stableDeploymentIds: ['deployment-a', 'deployment-b'], bridgeId, instanceId, cursorA, cursorB, beforeResume: { a: 5, b: 1 }, afterResume: { a: 5, b: 5 }, requiredHubOrSdkChanges: 0 };
    });
    await step('supplied bundle and SDK stay unchanged throughout external-state tests', async () => {
      assert.deepEqual(await inventory(args.bundle), before); assert.equal(await hash(join(args.bundle, 'sdk/javascript/bridge-kit.mjs')), report.sourceHashes.sdk); assert.deepEqual(await readdir(cwd), []);
      await save('bridge-observations.json', report.bridges);
      return { unchangedFilesAndDirectories: before.length, configurationEdited: false, sourceEdited: false, cwdFilesCreated: 0 };
    });
    report.passed = true;
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; console.error(error.stack ?? error); }
  finally {
    for (const peer of peers) try { await bounded(peer.bridge.close(), 3000, 'SDK final close'); } catch (error) { report.cleanupErrors.push({ scope: 'bridge', message: error.message }); }
    for (const child of children) try { const exit = await stopHub(child); if (exit.code !== 0 || exit.signal !== null) report.cleanupErrors.push({ scope: 'Hub exit', pid: child.record.pid, exit }); } catch (error) { report.cleanupErrors.push({ scope: 'Hub stop', pid: child.record.pid, message: error.message }); }
    report.ownedHubsAfterStop = report.hubs.map(hub => ({ pid: hub.pid, alive: alive(hub.pid) }));
    report.listenersAfterStop = await Promise.all(report.hubs.filter(hub => hub.ready).map(async hub => ({ port: hub.ready.port, listening: await listening(hub.ready.port) })));
    report.passed &&= report.cleanupErrors.length === 0 && report.ownedHubsAfterStop.every(item => !item.alive) && report.listenersAfterStop.every(item => !item.listening);
    report.endedAt = new Date().toISOString(); await save('report.json', report);
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: join(args.evidence, 'report.json'), retainedTemporaryRoot: temporaryRoot }));
    if (!report.passed) process.exitCode = 1;
  }
}
run().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
