import { runtimeForBundle } from './runtime-helper.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createConnection } from 'node:net';

// This checks a built, unpacked bundle. It never deletes the supplied bundle or
// its data; every writable scenario runs in a retained, independently owned copy.
const TIMEOUT = 15_000;
function argumentsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--bundle', '--evidence'].includes(key)) throw new Error(`unknown argument: ${key}`);
    const value = argv[++index];
    if (!value || !isAbsolute(value)) throw new Error(`${key} requires an absolute path`);
    result[key.slice(2)] = resolve(value);
  }
  if (!result.bundle || !result.evidence) throw new Error('usage: node package-acceptance.mjs --bundle <absolute unpacked root> --evidence <new absolute directory>');
  if (result.evidence === result.bundle || result.evidence.startsWith(result.bundle + sep)) throw new Error('evidence must be outside the supplied bundle');
  return result;
}
const hash = async (path) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};
const inside = (root, path) => path === root || path.startsWith(root + sep);
async function inventory(root, { includeDirectories = false } = {}) {
  const files = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink in acceptance tree: ${path}`);
      if (entry.isDirectory()) {
        if (includeDirectories) files.push({ path: relative(root, path).split(sep).join('/'), kind: 'directory' });
        await walk(path);
      }
      else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), size: (await stat(path)).size, sha256: await hash(path) });
    }
  }
  await walk(root);
  return files;
}
async function integrity(bundle, { allowEditableConfiguration = false } = {}) {
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'manifest schema');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  const paths = new Set();
  const verified = [], editable = [];
  for (const file of manifest.files) {
    assert.equal(typeof file.path, 'string');
    assert.ok(!isAbsolute(file.path) && !file.path.includes('\\') && !file.path.split('/').includes('..'), 'manifest paths stay bundle-relative');
    assert.ok(!paths.has(file.path), `duplicate manifest file ${file.path}`); paths.add(file.path);
    assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(Number.isSafeInteger(file.size) && file.size >= 0);
    const path = resolve(bundle, file.path);
    assert.ok(inside(bundle, path));
    if (allowEditableConfiguration && file.path === 'config/hub.json') { editable.push(file.path); continue; }
    assert.equal((await stat(path)).size, file.size, `${file.path} size`);
    assert.equal(await hash(path), file.sha256, `${file.path} sha256`);
    verified.push(file.path);
  }
  const extras = (await inventory(bundle)).filter(file => !paths.has(file.path) && file.path !== 'manifest.json' && !file.path.startsWith('data/'));
  assert.deepEqual(extras, [], 'only data may be added outside the original manifest');
  return { schemaVersion: manifest.schemaVersion, version: manifest.version, kind: manifest.kind, verifiedCount: verified.length, editable };
}
function bounded(promise, milliseconds, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} timed out after ${milliseconds} ms`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function eventually(read, predicate, description) {
  const deadline = Date.now() + TIMEOUT;
  do { const value = await read(); if (predicate(value)) return value; await delay(40); } while (Date.now() < deadline);
  throw new Error(`${description} did not become true`);
}
async function listening(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const settle = value => { if (settled) return; settled = true; socket.destroy(); done(value); };
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false)); socket.setTimeout(1000, () => settle(false));
  });
}
async function run() {
  const args = argumentsOf(process.argv.slice(2));
  await mkdir(args.evidence, { recursive: false });
  const startedAt = new Date().toISOString();
  const results = [], processes = [], peers = [], ports = new Set();
  const session = randomUUID();
  const temporaryRoot = join(tmpdir(), `枢纽 分发 验收 ${session}`);
  const firstBundle = join(temporaryRoot, '初始 包目录');
  const movedBundle = join(temporaryRoot, '搬迁 后整合包');
  const persistedBundle = join(temporaryRoot, '带消息与附件 再搬迁');
  const negativeBundle = join(temporaryRoot, '损坏 包副本');
  const foreignCwd = join(temporaryRoot, '与包无关 中文 工作目录');
  const report = { passed: false, startedAt, evidence: args.evidence, suppliedBundle: args.bundle, runtime: process.version, temporaryRoot,
    retainedCopies: [firstBundle, movedBundle, persistedBundle, negativeBundle], foreignCwd, results, children: [], noListeners: false };
  const save = async (name, value) => writeFile(join(args.evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  async function step(name, action) {
    const at = new Date().toISOString();
    report.activeStep = name;
    try {
      const detail = await action(); results.push({ name, passed: true, at, detail });
      console.log(JSON.stringify({ event: 'acceptance', name, passed: true }));
      report.activeStep = null;
      return detail;
    } catch (error) {
      results.push({ name, passed: false, at, error: error.message }); throw error;
    }
  }
  async function command(bundle, extra) {
    const runtime = await runtimeForBundle(bundle);
    return { runtime, launcher: join(bundle, 'scripts/launcher.mjs'), extra };
  }
  async function start(bundle, extra = [], { expectReady = false } = {}) {
    const spec = await command(bundle, extra);
    let executable;
    try { await stat(spec.runtime); executable = spec.runtime; }
    catch (error) { if (error.code !== 'ENOENT') throw error; executable = process.execPath; }
    const child = spawn(executable, [spec.launcher, ...extra], { cwd: foreignCwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const record = { pid: child.pid, executable, args: [spec.launcher, ...extra], cwd: foreignCwd, stdout: '', stderr: '', messages: [], exit: null, ready: null };
    const processRecord = { child, record }; processes.push(processRecord); report.children.push(record);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { record.stdout += value; }); child.stderr.on('data', value => { record.stderr += value; });
    let acceptReady, rejectReady;
    const ready = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; });
    // A short check process has no ready event; its rejection is still observed.
    ready.catch(() => {});
    processRecord.exited = new Promise((done, reject) => {
      child.once('error', error => { rejectReady(error); reject(error); });
      child.once('close', (code, signal) => { record.exit = { code, signal }; if (!record.ready) rejectReady(new Error(`launcher exited before ready (${code}): ${record.stderr || record.stdout}`)); done(record.exit); });
    });
    child.on('message', message => {
      record.messages.push(message);
      if (message?.type === 'ready' || message?.event === 'ready') {
        record.ready = message;
        if (Number.isInteger(message.port)) ports.add(message.port);
        acceptReady(message);
      }
    });
    if (expectReady) await bounded(ready, TIMEOUT, 'launcher ready');
    else await bounded(processRecord.exited, TIMEOUT, 'launcher check/negative exit');
    return processRecord;
  }
  async function stop(processRecord) {
    if (processRecord.record.exit) return processRecord.record.exit;
    if (processRecord.child.connected) processRecord.child.send({ type: 'stop' });
    else processRecord.child.kill('SIGTERM');
    try { return await bounded(processRecord.exited, 8000, 'graceful launcher stop'); }
    catch (error) {
      processRecord.record.stopFallback = error.message;
      processRecord.child.kill('SIGKILL');
      return bounded(processRecord.exited, 5000, 'owned launcher forced stop');
    }
  }
  const endpointOf = processRecord => {
    const ready = processRecord.record.ready;
    const port = ready?.port;
    assert.ok(Number.isInteger(port) && port > 0);
    const base = ready.httpUrl ? new URL(ready.httpUrl).origin : ready.managementUrl ? new URL(ready.managementUrl).origin : `http://127.0.0.1:${port}`;
    return { base, ws: ready.wsUrl ?? ready.endpoint ?? `ws://127.0.0.1:${port}/bridge`, port };
  };
  async function json(base, path) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(TIMEOUT) });
    assert.equal(response.status, 200, path); return response.json();
  }
  async function post(base, path, value) {
    const state = await json(base, '/manage/api/state');
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-management-token': state.csrfToken }, body: JSON.stringify(value), signal: AbortSignal.timeout(TIMEOUT) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  }
  async function connect(endpoint, config, suffix = randomUUID().replaceAll('-', '').slice(0, 12)) {
    const ws = new WebSocket(endpoint);
    const frames = []; let closed = null;
    const peer = { ws, frames, bridge: `package-${suffix}`, welcome: null, get closed() { return closed; }, send(frame) { ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); },
      async close() {
        if (ws.readyState === WebSocket.CLOSED) return;
        const done = new Promise(resolveClose => ws.addEventListener('close', resolveClose, { once: true }));
        ws.close(); await bounded(done, 5000, 'test bridge close');
      },
      async frame(predicate, description) { return eventually(() => frames.find(entry => predicate(entry.frame)), entry => !!entry, description); },
    };
    peers.push(peer);
    ws.addEventListener('close', event => { closed = { code: event.code, reason: event.reason }; });
    await bounded(new Promise((accept, reject) => {
      ws.addEventListener('open', () => peer.send({ type: 'hello', wire: '0.1', bridge: peer.bridge, credential: 'ui.manual', ...(config.acl?.credentials?.['ui.manual']?.token ? { token: config.acl.credentials['ui.manual'].token } : {}), displayName: '分发真实整合包验收 mod' }));
      ws.addEventListener('error', () => reject(new Error('acceptance mod socket error')));
      ws.addEventListener('message', event => {
        const raw = String(event.data), frame = JSON.parse(raw); frames.push({ raw, frame });
        if (frame.type === 'welcome') { peer.welcome = frame; accept(); }
        else if (frame.type === 'denied' && !peer.welcome) reject(new Error(`acceptance mod denied: ${frame.code}`));
      });
      ws.addEventListener('close', () => { if (!peer.welcome) reject(new Error('acceptance mod closed before welcome')); });
    }), TIMEOUT, 'mod welcome');
    return peer;
  }
  let blobToken = 0;
  async function blobRequest(peer, type, value) {
    const requestToken = `package-blob-${++blobToken}`;
    peer.send({ type, requestToken, ...value });
    const result = await peer.frame(frame => frame.requestToken === requestToken, type);
    assert.equal(result.frame.type, 'blob_result', JSON.stringify(result.frame));
    assert.equal(result.frame.operation, type);
    return result.frame;
  }
  async function readBlob(peer, object, messageSeq) {
    const parts = []; let offset = 0;
    do {
      const result = await blobRequest(peer, 'blob_read', { id: object.id, messageSeq, offset, length: 64 * 1024 });
      const block = Buffer.from(result.data, 'base64'); assert.equal(block.length, result.bytes); assert.equal(result.offset, offset);
      parts.push(block); offset += block.length;
      if (result.eof) break;
      assert.ok(block.length > 0 && offset < object.size, 'blob reader makes bounded progress');
    } while (true);
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, object.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), object.sha256);
    return bytes;
  }
  try {
    await mkdir(foreignCwd, { recursive: true });
    await step('original manifest and source bundle', async () => {
      report.originalInventory = await inventory(args.bundle);
      const detail = await integrity(args.bundle); await save('supplied-manifest-check.json', detail); return detail;
    });
    await step('independent Chinese-space extraction and relocation', async () => {
      await cp(args.bundle, firstBundle, { recursive: true, errorOnExist: true, force: false });
      assert.deepEqual(await inventory(firstBundle), report.originalInventory);
      await cp(firstBundle, movedBundle, { recursive: true, errorOnExist: true, force: false });
      assert.deepEqual(await inventory(movedBundle), report.originalInventory);
      return { firstBundle, relocatedBundle: movedBundle, unrelatedCwd: foreignCwd };
    });
    const configPath = join(movedBundle, 'config/hub.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const logDir = resolve(dirname(configPath), config.log?.dir ?? './.hub/log');
    const dataDir = join(movedBundle, 'data');
    assert.ok(inside(dataDir, logDir), 'default communications data remains inside the relocated package/data');
    assert.ok(config.acl?.credentials?.['ui.manual'], 'bundle permits a real own ui.manual credential');
    await step('readonly --check from unrelated cwd', async () => {
      const before = await inventory(movedBundle, { includeDirectories: true });
      const variants = [];
      for (const extra of [['--check'], ['--check', '--config', 'config/hub.json'], ['--check', '--config', configPath]]) {
        const checked = await start(movedBundle, extra);
        assert.equal(checked.record.exit.code, 0, checked.record.stderr); assert.equal(checked.record.exit.signal, null);
        assert.equal(checked.record.ready, null, '--check never listens');
        const detail = JSON.parse(checked.record.stdout); assert.equal(resolve(detail.configPath), configPath);
        report.bundleRuntime = { version: detail.nodeVersion, executable: detail.nodeExecutable };
        variants.push({ args: extra, pid: checked.record.pid, exit: checked.record.exit, check: detail });
      }
      assert.deepEqual(await inventory(movedBundle, { includeDirectories: true }), before, '--check does not create or change files or directories');
      assert.deepEqual(await inventory(foreignCwd, { includeDirectories: true }), [], 'foreign cwd remains empty');
      return { variants, noFilesOrDirectoriesChanged: true };
    });
    const running = await start(movedBundle, ['--port', '0'], { expectReady: true });
    const endpoint = endpointOf(running);
    await step('real IPC launch and HTTP surfaces', async () => {
      assert.ok(running.record.ready.logDir ? inside(dataDir, resolve(running.record.ready.logDir)) : true);
      for (const kind of ['log', 'blobs', 'management']) assert.ok(inside(dataDir, resolve(running.record.ready.storage[kind].path)), `${kind} path stays package-local`);
      const assets = [];
      for (const [path, mime] of [['/manage', 'text/html'], ['/manage/manual-bridge.mjs', 'javascript'], ['/manage/manual-console.mjs', 'javascript'], ['/manage/manual-console.css', 'text/css']]) {
        const response = await fetch(endpoint.base + path, { signal: AbortSignal.timeout(TIMEOUT) });
        const body = await response.text(); assert.equal(response.status, 200, path); assert.ok((response.headers.get('content-type') ?? '').includes(mime)); assert.ok(body.length > 0);
        assets.push({ path, status: response.status, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
      }
      const state = await json(endpoint.base, '/manage/api/state'), status = await json(endpoint.base, '/status');
      await save('startup-state.json', state); await save('startup-status.json', status);
      return { ready: running.record.ready, assets };
    });
    await step('duplicate same data and occupied port cannot touch original hub', async () => {
      const before = await inventory(dataDir);
      const firstStatus = await json(endpoint.base, '/status');
      const samePort = await start(movedBundle, ['--port', String(endpoint.port)]);
      assert.notEqual(samePort.record.exit.code, 0, 'second launch must fail'); assert.equal(samePort.record.exit.signal, null);
      assert.match(samePort.record.stderr, /已被占用|EADDRINUSE|port/i, 'port conflict gives an actionable cause');
      assert.deepEqual(await inventory(dataDir), before, 'failed second launch never overwrites data');
      const anotherPort = await start(movedBundle, ['--port', '0']);
      assert.notEqual(anotherPort.record.exit.code, 0, 'same data cannot be opened concurrently even on another port');
      assert.match(anotherPort.record.stderr, /运行锁|PACKAGE_DATA_LOCKED/, 'data lock conflict is explicit');
      assert.deepEqual(await inventory(dataDir), before);
      assert.equal(running.record.exit, null); assert.equal(await listening(endpoint.port), true);
      assert.equal((await json(endpoint.base, '/status')).lastSeq, firstStatus.lastSeq, 'the original hub still serves its unchanged history');
      return { samePort: { exit: samePort.record.exit, stderr: samePort.record.stderr, stdout: samePort.record.stdout }, anotherPort: { exit: anotherPort.record.exit, stderr: anotherPort.record.stderr, stdout: anotherPort.record.stdout }, dataFilesUnchanged: before.length };
    });
    const peer = await connect(endpoint.ws, config);
    const otherPeer = await connect(endpoint.ws, config);
    const topic = `package-test/${session}/arbitrary-information`;
    const kind = `provider-defined-${session}`;
    const rawBody = '{\n  "信息种类":' + JSON.stringify(kind) + ', "整数":9007199254740993,  "指数":1.2300e+02,\n  "文本":"中文 🧭 双  space", "嵌套":{"保留":"原文"}\n}';
    let sequence, subscription;
    let otherSubscription;
    await step('one credential permits independent simultaneous mod bridges', async () => {
      assert.equal(peer.welcome.principal, 'ui.manual'); assert.equal(otherPeer.welcome.principal, 'ui.manual');
      assert.notEqual(peer.bridge, otherPeer.bridge); assert.notEqual(peer.welcome.bridge, otherPeer.welcome.bridge); assert.notEqual(peer.welcome.session, otherPeer.welcome.session);
      otherPeer.send({ type: 'register', requestToken: 'package-other-register', channels: [{ name: topic, subscribe: true }] });
      await otherPeer.frame(frame => frame.type === 'registered' && frame.requestToken === 'package-other-register', 'other registered');
      otherPeer.send({ type: 'subscribe', token: 'package-other-subscribe', filters: [topic], from: 'now' });
      otherSubscription = (await otherPeer.frame(frame => frame.type === 'subscribed' && frame.token === 'package-other-subscribe', 'other subscribed')).frame.subscription;
      const state = await json(endpoint.base, '/manage/api/state'); assert.equal(state.bridges.find(item => item.key === 'ui.manual').instances.length, 2);
      return { first: peer.welcome, second: otherPeer.welcome, instances: 2 };
    });
    await step('own mod dynamic channels raw publish delivery and explicit ACK', async () => {
      peer.send({ type: 'register', requestToken: 'package-register', channels: [{ name: topic, publish: true, subscribe: true }] });
      const registration = await peer.frame(frame => frame.type === 'registered' && frame.requestToken === 'package-register', 'registered');
      assert.ok(registration.frame.channels.some(channel => channel.name === topic && channel.publish && channel.subscribe));
      peer.send({ type: 'subscribe', token: 'package-subscribe', filters: [topic], from: 'now' });
      subscription = (await peer.frame(frame => frame.type === 'subscribed' && frame.token === 'package-subscribe', 'subscribed')).frame.subscription;
      assert.equal(typeof subscription, 'string');
      const prefix = JSON.stringify({ type: 'publish', requestToken: 'package-raw', topic, headers: { kind } });
      peer.send(prefix.slice(0, -1) + ',"body":' + rawBody + '}');
      const published = await peer.frame(frame => frame.type === 'published' && frame.requestToken === 'package-raw', 'published'); sequence = published.frame.seq;
      const delivered = await peer.frame(frame => frame.type === 'delivery' && frame.seq === sequence && frame.subscription === subscription, 'delivery');
      assert.equal(delivered.frame.body['信息种类'], kind); assert.equal(delivered.frame.headers.kind, kind);
      assert.ok(delivered.raw.includes('"body":' + rawBody), 'delivery preserves every JSON body byte');
      const crossBridge = await otherPeer.frame(frame => frame.type === 'delivery' && frame.seq === sequence && frame.subscription === otherSubscription, 'cross-bridge delivery');
      assert.ok(crossBridge.raw.includes('"body":' + rawBody));
      const pending = await eventually(() => json(endpoint.base, '/manage/api/state'), state => state.hub.subscriptions.some(item => item.id === subscription && item.pending === 1), 'pending before explicit ACK');
      peer.send({ type: 'ack', subscription, seq: [sequence] });
      otherPeer.send({ type: 'ack', subscription: otherSubscription, seq: [sequence] });
      const acknowledged = await eventually(() => json(endpoint.base, '/manage/api/state'), state => [subscription, otherSubscription].every(id => state.hub.subscriptions.some(item => item.id === id && item.cursor === sequence && item.pending === 0)), 'ACK diagnostics on both mod bridges');
      await save('mod-frames.json', peer.frames); await save('pending-before-ack.json', pending); await save('state-after-ack.json', acknowledged);
      const files = (await inventory(logDir)).filter(file => /^log-\d+\.jsonl$/.test(file.path));
      const records = [];
      for (const file of files) for (const line of (await readFile(join(logDir, file.path), 'utf8')).split(/\r?\n/)) if (line.trim()) records.push(JSON.parse(line));
      const record = records.find(item => item.seq === sequence); assert.ok(record); assert.equal(record.bodyRaw, rawBody); assert.equal(record.owner, 'ui.manual'); assert.equal(record.kind, 'message'); assert.equal(record.headers.kind, kind);
      await save('disk-message.json', record);
      return { bridge: peer.welcome.bridge, declaredBridge: peer.bridge, principal: peer.welcome.principal, topic, kind, sequence, subscription, rawBodySha256: createHash('sha256').update(rawBody).digest('hex') };
    });
    const blobTopic = topic + '/opaque-attachment';
    const blobBytes = Buffer.from(Array.from({ length: 128 * 1024 + 17 }, (_, index) => index % 251));
    const blobSha256 = createHash('sha256').update(blobBytes).digest('hex');
    let blobObject, blobSequence;
    await step('small chunked binary attachment crosses real mod bridges', async () => {
      otherPeer.send({ type: 'subscribe', token: 'package-blob-subscribe', filters: [blobTopic], from: 'now' });
      const blobSubscription = (await otherPeer.frame(frame => frame.type === 'subscribed' && frame.token === 'package-blob-subscribe', 'blob subscribed')).frame.subscription;
      blobObject = await blobRequest(peer, 'blob_begin', { size: blobBytes.length, sha256: blobSha256 });
      const chunkSize = Math.min(64 * 1024, peer.welcome.blobLimits.chunkBytes); assert.ok(chunkSize > 0);
      let chunks = 0;
      for (let offset = 0; offset < blobBytes.length; offset += chunkSize) {
        const block = blobBytes.subarray(offset, offset + chunkSize);
        const result = await blobRequest(peer, 'blob_chunk', { id: blobObject.id, offset, data: block.toString('base64') });
        assert.equal(result.offset, offset + block.length); chunks++;
      }
      blobObject = await blobRequest(peer, 'blob_commit', { id: blobObject.id });
      assert.equal(blobObject.committed, true); assert.equal(blobObject.released, false); assert.equal(blobObject.sha256, blobSha256);
      peer.send({ type: 'publish', requestToken: 'package-blob-publish', topic: blobTopic, body: { '信息种类': kind, objectId: blobObject.id }, attachments: [blobObject.id] });
      blobSequence = (await peer.frame(frame => frame.type === 'published' && frame.requestToken === 'package-blob-publish', 'blob published')).frame.seq;
      const delivered = await otherPeer.frame(frame => frame.type === 'delivery' && frame.seq === blobSequence && frame.subscription === blobSubscription, 'blob cross-bridge delivery');
      assert.deepEqual(delivered.frame.attachments, [{ id: blobObject.id, size: blobBytes.length, sha256: blobSha256 }]);
      assert.equal(delivered.frame.body.objectId, blobObject.id);
      const downloaded = await readBlob(otherPeer, blobObject, blobSequence); assert.deepEqual(downloaded, blobBytes);
      otherPeer.send({ type: 'ack', subscription: blobSubscription, seq: [blobSequence] });
      await eventually(() => json(endpoint.base, '/manage/api/state'), state => state.hub.subscriptions.some(item => item.id === blobSubscription && item.cursor === blobSequence && item.pending === 0), 'blob ACK');
      await writeFile(join(args.evidence, 'blob-source.bin'), blobBytes, { flag: 'wx' });
      await writeFile(join(args.evidence, 'blob-downloaded-before-restart.bin'), downloaded, { flag: 'wx' });
      await save('mod-other-frames.json', otherPeer.frames); await save('mod-provider-blob-frames.json', peer.frames);
      const protectedObject = await blobRequest(peer, 'blob_status', { id: blobObject.id }); assert.equal(protectedObject.released, false, 'reads and ACK never release the provider object');
      return { id: blobObject.id, sequence: blobSequence, size: blobBytes.length, sha256: blobSha256, chunks, readPreservesProviderProtection: true };
    });
    await step('management changes use CSRF and persist across graceful restart', async () => {
      const rejected = await fetch(endpoint.base + '/manage/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json', origin: endpoint.base }, body: JSON.stringify({ key: 'ui.manual', action: 'pause' }), signal: AbortSignal.timeout(TIMEOUT) });
      assert.equal(rejected.status, 403); const rejection = await rejected.json(); assert.equal(rejection.error.code, 'MANAGEMENT_TOKEN_REQUIRED');
      await post(endpoint.base, '/manage/api/annotation', { key: 'ui.manual', bridgeName: '分发搬迁后的手动桥', programs: [{ id: 'package-check-program', name: '仅测试通讯的外部程序注记' }] });
      await post(endpoint.base, '/manage/api/bridge', { key: 'ui.manual', action: 'pause' });
      const paused = await json(endpoint.base, '/manage/api/state'); assert.equal(paused.bridges.find(item => item.key === 'ui.manual').paused, true);
      await save('paused-state-before-restart.json', paused);
      await peer.close(); await otherPeer.close(); const exit = await stop(running); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
      assert.equal(await listening(endpoint.port), false);
      const durableBeforeMove = await inventory(join(movedBundle, 'data'));
      await cp(movedBundle, persistedBundle, { recursive: true, errorOnExist: true, force: false });
      assert.deepEqual(await inventory(join(persistedBundle, 'data')), durableBeforeMove, 'all message, blob and management data moves with the package');
      const restarted = await start(persistedBundle, ['--port', '0'], { expectReady: true });
      const restoredEndpoint = endpointOf(restarted), restored = await json(restoredEndpoint.base, '/manage/api/state');
      for (const kind of ['log', 'blobs', 'management']) assert.ok(inside(join(persistedBundle, 'data'), resolve(restarted.record.ready.storage[kind].path)), `${kind} path follows the relocated bundle`);
      const bridge = restored.bridges.find(item => item.key === 'ui.manual');
      assert.equal(bridge.paused, true); assert.equal(bridge.label, '分发搬迁后的手动桥'); assert.equal(bridge.programs[0].id, 'package-check-program');
      assert.ok(restored.hub.lastSeq >= blobSequence); assert.ok(restored.log.records.some(item => item.seq === sequence)); assert.ok(restored.log.records.some(item => item.seq === blobSequence));
      await save('restored-state-before-resume.json', restored);
      await post(restoredEndpoint.base, '/manage/api/bridge', { key: 'ui.manual', action: 'resume' });
      const resumed = await json(restoredEndpoint.base, '/manage/api/state'); assert.equal(resumed.bridges.find(item => item.key === 'ui.manual').paused, false);
      const historyPeer = await connect(restoredEndpoint.ws, config);
      historyPeer.send({ type: 'subscribe', token: 'package-history', filters: [topic, blobTopic], from: 0 });
      const historySubscription = (await historyPeer.frame(frame => frame.type === 'subscribed' && frame.token === 'package-history', 'history subscribed')).frame.subscription;
      const history = await historyPeer.frame(frame => frame.type === 'delivery' && frame.seq === sequence && frame.subscription === historySubscription, 'history delivery after restart');
      assert.ok(history.raw.includes('"body":' + rawBody));
      const attachedHistory = await historyPeer.frame(frame => frame.type === 'delivery' && frame.seq === blobSequence && frame.subscription === historySubscription, 'attachment history after relocation');
      assert.equal(attachedHistory.frame.body.objectId, blobObject.id); assert.equal(attachedHistory.frame.attachments[0].id, blobObject.id);
      const downloadedAfterMove = await readBlob(historyPeer, blobObject, blobSequence); assert.deepEqual(downloadedAfterMove, blobBytes);
      await writeFile(join(args.evidence, 'blob-downloaded-after-relocation.bin'), downloadedAfterMove, { flag: 'wx' });
      historyPeer.send({ type: 'ack', subscription: historySubscription, seq: [sequence, blobSequence] });
      await eventually(() => json(restoredEndpoint.base, '/manage/api/state'), state => state.hub.subscriptions.some(item => item.id === historySubscription && item.cursor === blobSequence && item.pending === 0), 'history ACK');
      await save('mod-history-frames.json', historyPeer.frames); await save('resumed-state.json', resumed);
      await historyPeer.close(); const finalExit = await stop(restarted); assert.equal(finalExit.code, 0); assert.equal(finalExit.signal, null);
      assert.equal(await listening(restoredEndpoint.port), false);
      return { pausedPersisted: true, annotationPersisted: true, rawHistoryReplayed: true, blobReplayedAfterRelocation: { id: blobObject.id, sha256: blobSha256, bytes: downloadedAfterMove.length }, persistedBundle, resumed: true, releasesRequested: 0, exit, finalExit };
    });
    await step('missing UI asset and corrupt editable config fail readonly check', async () => {
      await cp(args.bundle, negativeBundle, { recursive: true, errorOnExist: true, force: false });
      const negativeConfig = join(negativeBundle, 'config/hub.json');
      const originalConfig = await readFile(negativeConfig);
      await writeFile(negativeConfig, '{ broken JSON');
      const corruptBefore = await inventory(negativeBundle, { includeDirectories: true });
      const corrupt = await start(negativeBundle, ['--check']); assert.notEqual(corrupt.record.exit.code, 0); assert.deepEqual(await inventory(negativeBundle, { includeDirectories: true }), corruptBefore);
      await writeFile(negativeConfig, originalConfig);
      const manifest = JSON.parse(await readFile(join(negativeBundle, 'manifest.json'), 'utf8'));
      const asset = manifest.files.find(file => file.path === 'src/management/manual-console.mjs'); assert.ok(asset, 'manifest names the manual UI module');
      await unlink(join(negativeBundle, asset.path));
      const missingBefore = await inventory(negativeBundle, { includeDirectories: true });
      const missing = await start(negativeBundle, ['--check']); assert.notEqual(missing.record.exit.code, 0); assert.deepEqual(await inventory(negativeBundle, { includeDirectories: true }), missingBefore);
      return { corruptConfig: { exit: corrupt.record.exit, stdout: corrupt.record.stdout, stderr: corrupt.record.stderr }, missingAsset: { path: asset.path, exit: missing.record.exit, stdout: missing.record.stdout, stderr: missing.record.stderr } };
    });
    await step('original remains untouched and relocated immutable files remain valid', async () => {
      assert.deepEqual(await inventory(args.bundle), report.originalInventory, 'supplied extraction never changed');
      assert.deepEqual(await inventory(foreignCwd, { includeDirectories: true }), [], 'no accidental data in process cwd');
      const detail = await integrity(movedBundle); await save('relocated-manifest-check.json', detail);
      await save('persisted-relocation-manifest-check.json', await integrity(persistedBundle));
      await save('relocated-data-inventory.json', await inventory(dataDir));
      return detail;
    });
    report.passed = true;
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    console.error(error.stack ?? error);
  } finally {
    const cleanupErrors = [];
    for (const peer of peers) try { await peer.close(); } catch (error) { cleanupErrors.push({ scope: 'mod', message: error.message }); }
    for (const processRecord of processes) try { await stop(processRecord); } catch (error) { cleanupErrors.push({ scope: 'owned launcher', pid: processRecord.child.pid, message: error.message }); }
    const listeners = await Promise.all([...ports].map(async port => ({ port, listening: await listening(port) })));
    report.listenersAfterStop = listeners; report.noListeners = listeners.every(item => !item.listening);
    report.cleanupErrors = cleanupErrors; report.passed &&= report.noListeners && cleanupErrors.length === 0;
    report.endedAt = new Date().toISOString();
    await save('report.json', report);
    console.log(JSON.stringify({ passed: report.passed, checks: results.length, report: join(args.evidence, 'report.json'), retainedCopies: report.retainedCopies }));
    if (!report.passed) process.exitCode = 1;
  }
}
run().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
