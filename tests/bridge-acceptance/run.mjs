// Candidate adapters are test bindings. Every bridge opens its own WebSocket.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness } from '../helpers/hub-harness.mjs';
import { parseEnvelope } from '../../src/hub/lib/wire-json.mjs';
import { Peer, ROOT } from '../../examples/cross-language/scene-harness.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CHECKS = [
  ['BA-01', 'base', '认证握手、原始拒绝与非零退出'],
  ['BA-02', 'base', '动态主题、任意kind与双向发布'],
  ['BA-03', 'base', '双向JSON正文原文保真'],
  ['BA-04', 'base', '并发订阅token→subscription→barrier'],
  ['BA-05', 'base', '裸wire水位与非法游标'],
  ['BA-06', 'base', '分订阅ACK、历史保留与提供者释放'],
  ['BA-D1', 'directed', '请求回应、注入、可信关联与旁观遮挡'],
  ['BA-B1', 'blob', '双向1MiB+37附件分块、SHA256与释放权'],
  ['BA-07', 'base', '有限正常关闭与退出0'],
];
const deadline = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
};

class Adapter extends Peer {
  wait(match, options) {
    return super.wait((row) => {
      try {
        if (row.event === 'frame' && (!row.frame || Array.isArray(row.frame) || typeof row.frame.type !== 'string' || typeof row.raw !== 'string')) throw new Error('malformed adapter frame output');
        return match(row);
      } catch (failure) { this.fail(failure); return false; }
    }, options);
  }
  async close() {
    if (this.ended) return this.ended;
    try { await deadline(this.command({ action: 'close' }), 4000, 'close acknowledgement'); }
    catch { this.child.kill(); }
    this.child.stdin.end();
    try { return await deadline(this.exit, 4000, 'process exit'); }
    catch { this.child.kill(); return deadline(this.exit, 4000, 'killed process exit'); }
  }
}

class Fixture {
  static async create(manifest) {
    const self = new Fixture(); self.manifest = manifest; self.peers = []; self.processes = [];
    self.tmp = await mkdtemp(join(tmpdir(), 'hub-bridge-acceptance-'));
    self.tokens = Object.fromEntries(['candidate', 'reference', 'observer', 'restricted'].map((role) => [role, randomUUID()]));
    const all = { publish: ['#'], subscribe: ['#'] };
    const identities = Object.fromEntries(Object.entries(self.tokens).map(([role, token]) => [`fixture.${role}`, { token, maxConnections: 4, allow: role === 'restricted' ? { publish: ['allowed/#'], subscribe: ['allowed/#'] } : all }]));
    const configPath = join(self.tmp, 'hub.json');
    await writeFile(configPath, JSON.stringify({ hub: { id: 'arbitrary-bridge-acceptance' }, log: { enabled: true, segmentMaxBytes: 1024 * 1024, segmentMaxCount: 16 }, acl: { allowUnlistedBridges: false, bridges: {}, credentials: identities } }));
    self.h = new Harness({ keepTmp: true, logDir: join(self.tmp, 'log') });
    try { await self.h.startHub({ configPath, isolateLog: false }); return self; }
    catch (error) { await self.close(); throw error; }
  }
  async peer(role, { candidate = role === 'candidate', expectReady = true, rejected = false } = {}) {
    const bridge = `fixture.${role}`, credential = bridge;
    const values = { root: ROOT.replace(/[\\/]$/, ''), url: this.h.endpoint, bridge, token: rejected ? randomUUID() : this.tokens[role], credential };
    const substitute = (text) => text.replace(/\{(root|url|bridge|token|credential)\}/g, (_, key) => values[key]);
    let executable, args, cwd;
    if (candidate) {
      executable = this.manifest.command;
      if (executable === 'python') executable = process.env.PHASE7_PYTHON ?? executable;
      if (executable === 'pwsh') executable = process.env.PHASE7_POWERSHELL ?? executable;
      args = this.manifest.args.map(substitute); cwd = resolve(ROOT, substitute(this.manifest.cwd ?? '{root}'));
    } else {
      executable = process.execPath;
      args = [fileURLToPath(new URL('../../examples/cross-language/js-worker.mjs', import.meta.url)), '--url', values.url, '--bridge', bridge, '--credential', credential, '--token', values.token];
      cwd = ROOT;
    }
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    const peer = new Adapter(candidate ? this.manifest.name : `fixture-${role}`, child, args); this.peers.push(peer);
    // Bound diagnostic output independently of the bridge's own frame limits.
    let lineBytes = 0, totalBytes = 0;
    child.stdout.on('data', (chunk) => {
      totalBytes += Buffer.byteLength(chunk);
      const pieces = String(chunk).split('\n');
      for (let i = 0; i < pieces.length; i++) {
        lineBytes += Buffer.byteLength(pieces[i]);
        if (lineBytes > 32 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024) {
          peer.fail(new Error('adapter diagnostic output exceeded test resource limit')); child.kill(); return;
        }
        if (i < pieces.length - 1) lineBytes = 0;
      }
    });
    const proof = { role, candidate, executable, pid: child.pid, bridge, credential, rejected, expectedReady: expectReady };
    this.processes.push(proof); peer.proof = proof;
    if (expectReady) {
      peer.ready = await peer.wait((row) => row.event === 'ready', { timeoutMs: 15000 });
      assert.equal(peer.ready.pid, child.pid, 'ready PID must identify the launched bridge');
      assert.ok(typeof peer.ready.language === 'string' && peer.ready.language.length > 0);
      assert.ok(typeof peer.ready.version === 'string' && peer.ready.version.length > 0);
      assert.equal(peer.ready.welcome.type, 'welcome');
      assert.equal(peer.ready.welcome.hubWire, '0.1');
      assert.equal(peer.ready.welcome.authenticated, true);
      assert.equal(peer.ready.welcome.principal, credential);
      Object.assign(proof, { language: peer.ready.language, version: peer.ready.version, dependencyVersion: peer.ready.dependencyVersion, principal: peer.ready.welcome.principal, session: peer.ready.welcome.session });
    }
    return peer;
  }
  async close() {
    const outcomes = await Promise.allSettled(this.peers.map((peer) => peer.close()));
    if (this.h) {
      const hubExit = this.h.hub && this.h.hub.exitCode === null && this.h.hub.signalCode === null
        ? new Promise((done) => this.h.hub.once('close', (code, signal) => done({ code, signal })))
        : Promise.resolve({ code: this.h.hub?.exitCode, signal: this.h.hub?.signalCode });
      await this.h.stop(); this.hubExit = await deadline(hubExit, 5000, 'hub cleanup exit');
    }
    const target = resolve(this.tmp), prefix = resolve(tmpdir()) + sep;
    if (!target.startsWith(prefix)) throw new Error('temporary cleanup target outside tmpdir');
    await rm(target, { recursive: true, force: true });
    this.cleanupCompleted = outcomes.every((row) => row.status === 'fulfilled');
    const bad = outcomes.some((row) => row.status === 'rejected') || this.peers.some((peer) => peer.ready && (peer.ended?.code !== 0 || peer.ended?.signal !== null));
    if (bad) throw new Error('a ready adapter failed to exit normally during cleanup');
  }
}

const argv = process.argv.slice(2), options = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--bridge', '--evidence'].includes(argv[i]) || argv[i + 1] === undefined || options[argv[i]]) throw new Error('usage: run.mjs --bridge manifest.json [--evidence directory]');
  options[argv[i]] = argv[i + 1];
}
if (!options['--bridge']) throw new Error('--bridge manifest.json is required');
const manifestPath = resolve(options['--bridge']);
const evidenceBase = resolve(ROOT, options['--evidence'] ?? '.artifacts/evidence/bridge-acceptance/runs');
await mkdir(evidenceBase, { recursive: true });
// Always allocate a fresh run; never overwrite any previous report, even with --evidence.
const directory = join(evidenceBase, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
await mkdir(directory);
const startedAt = new Date().toISOString(), checks = [];
let manifest, fixture, candidate, reference, observer, error, expectedChecks = [];
let sourceSnapshots = [], candidateSources = [];
const at = (label) => `acceptance/${randomUUID()}/${label}`;
const accepted = (row, type = 'published') => { assert.equal(row.type, type); return row; };
const delivery = (peer, seq, sub) => peer.frame((frame) => frame.type === 'delivery' && frame.seq === seq && frame.subscription === sub);
const state = async () => deadline(fetch(`${fixture.h.httpBase}/manage/api/state`).then((response) => response.json()), 5000, 'manage state');
async function run(id, body) {
  const [, profile, title] = CHECKS.find((row) => row[0] === id), begin = Date.now();
  try { const proof = await body(); checks.push({ id, profile, title, passed: true, elapsedMs: Date.now() - begin, proof }); console.log(`${id} passed ${title}`); }
  catch (failure) { checks.push({ id, profile, title, passed: false, elapsedMs: Date.now() - begin, error: String(failure.stack ?? failure) }); throw failure; }
}

try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(manifest && typeof manifest.name === 'string' && manifest.name.length > 0 && manifest.name.length <= 200, 'manifest.name must be a nonempty string of at most 200 characters');
  assert.ok(typeof manifest.command === 'string' && manifest.command.length > 0, 'manifest.command must be an executable');
  assert.ok(Array.isArray(manifest.args) && manifest.args.length <= 128 && manifest.args.every((value) => typeof value === 'string'), 'manifest.args must be an argv string array');
  assert.ok(manifest.cwd === undefined || typeof manifest.cwd === 'string', 'manifest.cwd must be a string');
  assert.ok(manifest.sources === undefined || Array.isArray(manifest.sources) && manifest.sources.length <= 256 && manifest.sources.every((value) => typeof value === 'string'), 'optional manifest.sources must be a string path array');
  assert.ok(Array.isArray(manifest.profiles) && manifest.profiles.includes('base') && new Set(manifest.profiles).size === manifest.profiles.length && manifest.profiles.every((value) => ['base', 'directed', 'blob'].includes(value)), 'manifest.profiles must include base and may additionally select directed/blob');
  expectedChecks = CHECKS.filter(([, profile]) => manifest.profiles.includes(profile)).map(([id]) => id);
  candidateSources = [...new Set((manifest.sources ?? []).map((path) => resolve(ROOT, path.replaceAll('{root}', ROOT.replace(/[\\/]$/, '')))))];
  const runtimeSources = ['src/hub/hub-server.mjs', 'src/hub/ws-server.mjs', 'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs', 'tests/helpers/hub-harness.mjs', 'examples/cross-language/js-worker.mjs', 'examples/cross-language/scene-harness.mjs',
    ...(await readdir(join(ROOT, 'src/hub/lib'))).filter((name) => name.endsWith('.mjs')).map((name) => `src/hub/lib/${name}`)];
  const sourcePaths = [...new Set([manifestPath, fileURLToPath(import.meta.url), ...runtimeSources.map((path) => resolve(ROOT, path)), ...candidateSources])];
  sourceSnapshots = await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: hash(await readFile(path)), candidateDeclared: candidateSources.includes(path) })));
  fixture = await Fixture.create(manifest);
  await run('BA-01', async () => {
    [candidate, reference, observer] = await Promise.all([fixture.peer('candidate'), fixture.peer('reference'), fixture.peer('observer')]);
    assert.equal(new Set([fixture.h.hub.pid, candidate.child.pid, reference.child.pid, observer.child.pid]).size, 4);
    const denied = await fixture.peer('candidate', { candidate: true, rejected: true, expectReady: false });
    const frame = await denied.frame((value) => value.type === 'denied');
    assert.equal(frame.frame.code, 'BRIDGE_TOKEN_REJECTED'); assert.equal(JSON.parse(frame.raw).code, frame.frame.code);
    const exit = await deadline(denied.exit, 15000, 'denied process exit'); assert.ok(Number.isInteger(exit.code) && exit.code !== 0); assert.equal(exit.signal, null);
    assert.equal(denied.events.some((row) => row.event === 'ready'), false);
    return { ready: candidate.ready, denied: { code: frame.frame.code, raw: frame.raw, pid: denied.child.pid, exitCode: exit.code }, independentPids: [fixture.h.hub.pid, candidate.child.pid, reference.child.pid, observer.child.pid] };
  });
  await run('BA-02', async () => {
    const pairs = [];
    for (const [source, target] of [[candidate, reference], [reference, candidate]]) {
      const topic = at('任意新主题'), kind = `任意kind-${randomUUID()}`;
      const registration = accepted(await source.receipt('register', { channels: [{ name: topic, publish: true, subscribe: true }] }), 'registered');
      assert.ok(registration.channels.some((channel) => channel.name === topic && channel.publish && channel.subscribe));
      const sub = await target.subscribe({ filters: [topic], from: 'now' });
      const body = { kind, text: '中文🌍𠮷', flags: [true, false, null], number: 9007199254740991 };
      const receipt = accepted(await source.receipt('publish', { topic, body }));
      assert.deepEqual((await delivery(target, receipt.seq, sub.subscription)).frame.body, body);
      pairs.push({ source: source.proof.role, target: target.proof.role, topic, kind, seq: receipt.seq });
    }
    const restricted = await fixture.peer('restricted', { candidate: true });
    const denial = await restricted.receipt('publish', { topic: at('forbidden'), body: {} });
    assert.equal(denial.type, 'denied'); assert.equal(denial.code, 'PUBLISH_DENIED'); await restricted.close();
    return { pairs, topicDenial: denial.code };
  });
  await run('BA-03', async () => {
    const bodyRaw = '{ "big":9007199254740993, "huge":' + '7'.repeat(4001) + ', "decimal":0.1234567890123456789012345, "exponent":1e0, "largeExponent":1e400, "escaped":"\\u4e2d", "lone":"\\ud800", "text":"中文🌍𠮷é", "array":[ 1,  true , null ] }';
    const proof = [];
    for (const [source, target] of [[candidate, reference], [reference, candidate]]) {
      const topic = at('raw'), sub = await target.subscribe({ filters: [topic], from: 'now' }), requestToken = randomUUID();
      await source.send(`{"type":"publish","topic":${JSON.stringify(topic)},"body":${bodyRaw},"requestToken":${JSON.stringify(requestToken)}}`);
      const receipt = accepted((await source.frame((value) => value.requestToken === requestToken)).frame);
      const received = await delivery(target, receipt.seq, sub.subscription);
      assert.equal(parseEnvelope(received.raw).bodyRaw, bodyRaw);
      proof.push({ source: source.proof.role, target: target.proof.role, seq: receipt.seq, bytes: Buffer.byteLength(bodyRaw), sha256: hash(bodyRaw), integerDigits: 4001 });
    }
    return proof;
  });
  await run('BA-04', async () => {
    const topics = [at('parallel-a'), at('parallel-b')], tokens = topics.map(() => randomUUID());
    await Promise.all(topics.map((topic, index) => candidate.send({ type: 'subscribe', filters: [topic], from: 'now', token: tokens[index] })));
    const subs = await Promise.all(tokens.map(async (token) => {
      const subscribed = (await candidate.frame((frame) => frame.type === 'subscribed' && frame.token === token)).frame;
      const barrier = (await candidate.frame((frame) => frame.type === 'caught_up' && frame.subscription === subscribed.subscription)).frame;
      assert.equal(barrier.subscription, subscribed.subscription); assert.equal(barrier.token, undefined);
      return { token, subscription: subscribed.subscription, through: barrier.through };
    }));
    assert.notEqual(subs[0].subscription, subs[1].subscription);
    for (let index = 0; index < 2; index++) {
      const receipt = accepted(await reference.receipt('publish', { topic: topics[index], body: { index } }));
      assert.equal((await delivery(candidate, receipt.seq, subs[index].subscription)).frame.body.index, index);
    }
    return subs;
  });
  await run('BA-05', async () => {
    const topic = at('watermark'), welcomeSeq = candidate.ready.welcome.lastSeq;
    const receipt = accepted(await reference.receipt('publish', { topic, body: { marker: 'after-welcome-before-subscribe' } }));
    const omitted = await candidate.subscribe({ filters: [topic] });
    const now = await candidate.subscribe({ filters: [topic], from: 'now' });
    assert.equal(omitted.cursor, receipt.seq); assert.equal(now.cursor, receipt.seq);
    assert.equal(candidate.deliveries(omitted.subscription).length, 0); assert.equal(candidate.deliveries(now.subscription).length, 0);
    const snapshot = await candidate.subscribe({ filters: [topic], from: welcomeSeq });
    await delivery(candidate, receipt.seq, snapshot.subscription);
    const invalid = [];
    for (const from of [true, 'resume', 9007199254740992, -1]) {
      const token = randomUUID(); await candidate.send({ type: 'subscribe', filters: [topic], token, from });
      const row = (await candidate.frame((frame) => frame.type === 'error' && frame.token === token)).frame;
      assert.equal(row.code, 'CURSOR_INVALID'); invalid.push({ from, code: row.code });
    }
    return { welcomeSeq, publishedSeq: receipt.seq, omittedCursor: omitted.cursor, nowCursor: now.cursor, snapshotCursor: snapshot.cursor, invalid };
  });
  await run('BA-06', async () => {
    const topic = at('ack'), first = await candidate.subscribe({ filters: [topic], from: 'now' }), second = await candidate.subscribe({ filters: [topic, at('extra')], from: 'now' });
    const receipt = accepted(await reference.receipt('publish', { topic, body: { retained: true } }));
    await Promise.all([delivery(candidate, receipt.seq, first.subscription), delivery(candidate, receipt.seq, second.subscription)]);
    await candidate.send({ type: 'ack', subscription: first.subscription, seq: [receipt.seq] });
    accepted(await candidate.receipt('register', { channels: [{ name: at('ack-barrier'), subscribe: true }] }), 'registered');
    const firstState = await deadline(fixture.h.status(), 5000, 'first ACK state');
    assert.equal(firstState.subscriptions.find((sub) => sub.id === first.subscription).cursor, receipt.seq);
    assert.equal(firstState.subscriptions.find((sub) => sub.id === second.subscription).cursor, second.cursor);
    await candidate.send({ type: 'ack', subscription: second.subscription, seq: [receipt.seq] });
    accepted(await candidate.receipt('register', { channels: [{ name: at('ack-barrier'), subscribe: true }] }), 'registered');
    const secondState = await deadline(fixture.h.status(), 5000, 'second ACK state'); assert.equal(secondState.subscriptions.find((sub) => sub.id === second.subscription).cursor, receipt.seq);
    const history = await candidate.subscribe({ filters: [topic], from: 0 }); await delivery(candidate, receipt.seq, history.subscription);
    const ownTopic = at('candidate-owned'), own = accepted(await candidate.receipt('publish', { topic: ownTopic, body: {} }));
    const before = await state(), mixed = await candidate.receipt('release', { seq: [own.seq, receipt.seq] });
    assert.equal(mixed.code, 'RELEASE_DENIED'); const after = await state(); assert.equal(after.log.protectedCount, before.log.protectedCount);
    const afterDenied = await candidate.subscribe({ filters: [topic, ownTopic], from: 0 });
    await Promise.all([delivery(candidate, receipt.seq, afterDenied.subscription), delivery(candidate, own.seq, afterDenied.subscription)]);
    assert.equal((await candidate.receipt('release', { seq: [receipt.seq] })).code, 'RELEASE_DENIED');
    assert.deepEqual(accepted(await candidate.receipt('release', { seq: [own.seq] }), 'released').seq, [own.seq]);
    assert.deepEqual(accepted(await reference.receipt('release', { seq: [receipt.seq] }), 'released').seq, [receipt.seq]);
    return { seq: receipt.seq, firstSubscription: first.subscription, secondSubscription: second.subscription, firstAckCursor: receipt.seq, otherCursorBeforeOwnAck: second.cursor, secondAckCursor: receipt.seq, historyReplayedAfterAck: true, mixedRelease: mixed.code, bothRetainedAfterMixedDenial: [own.seq, receipt.seq], protectedBefore: before.log.protectedCount, protectedAfter: after.log.protectedCount, ownerReleases: [own.seq, receipt.seq] };
  });
  if (manifest.profiles.includes('directed')) await run('BA-D1', async () => {
    assert.ok(candidate.ready.welcome.features.includes('directed-v1'));
    const rows = [];
    for (const [source, target] of [[candidate, reference], [reference, candidate]]) {
      const topic = at('directed'), correlation = randomUUID();
      const live = await observer.subscribe({ filters: [topic], from: 'now' });
      const requestSub = await target.subscribe({ filters: [topic], operations: ['request'], from: 'now' });
      const responseSub = await source.subscribe({ filters: [topic], operations: ['response'], from: 'now' });
      const injectSub = await target.subscribe({ filters: [topic], operations: ['inject'], from: 'now' });
      const request = accepted(await source.receipt('request', { topic, target: { principal: target.ready.welcome.principal }, correlation, body: { question: 'external test controller defines the request' } }));
      const q = (await delivery(target, request.seq, requestSub.subscription)).frame;
      assert.equal(q.operation, 'request'); assert.equal(q.fromPrincipal, source.ready.welcome.principal); assert.equal(q.correlation, correlation);
      const forged = await observer.receipt('respond', { requestSeq: request.seq, body: { fake: true } }); assert.equal(forged.code, 'RESPONSE_DENIED');
      const response = accepted(await target.receipt('respond', { requestSeq: q.seq, body: { answer: target.proof.role } }));
      const r = (await delivery(source, response.seq, responseSub.subscription)).frame;
      assert.equal(r.operation, 'response'); assert.equal(r.requestSeq, request.seq); assert.equal(r.correlation, correlation); assert.equal(r.fromPrincipal, target.ready.welcome.principal); assert.deepEqual(r.body, { answer: target.proof.role });
      const injection = accepted(await source.receipt('inject', { topic, target: { principal: target.ready.welcome.principal }, body: { injectedBy: source.proof.role } }));
      const injected = (await delivery(target, injection.seq, injectSub.subscription)).frame;
      assert.equal(injected.operation, 'inject'); assert.equal(injected.fromPrincipal, source.ready.welcome.principal); assert.equal(injected.body.injectedBy, source.proof.role);
      const history = await observer.subscribe({ filters: [topic], from: 0 });
      for (const seq of [request.seq, response.seq, injection.seq]) {
        assert.equal(observer.deliveries(live.subscription).some((row) => row.frame.seq === seq), false);
        assert.equal(observer.deliveries(history.subscription).some((row) => row.frame.seq === seq), false);
      }
      rows.push({ source: source.proof.role, target: target.proof.role, correlation, requestSeq: request.seq, responseSeq: response.seq, injectSeq: injection.seq, forgedResponse: forged.code, observerScanThrough: history.through });
    }
    return rows;
  });
  if (manifest.profiles.includes('blob')) await run('BA-B1', async () => {
    assert.ok(candidate.ready.welcome.features.includes('blob-v1'));
    const stranger = await fixture.peer('restricted', { candidate: false });
    const bytes = Buffer.alloc(1024 * 1024 + 37);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + Math.floor(i / 1024)) & 255;
    const sha256 = hash(bytes), rows = [];
    for (const [source, target] of [[candidate, reference], [reference, candidate]]) {
      const begin = accepted(await source.receipt('blob_begin', { size: bytes.length, sha256 }), 'blob_result');
      const chunkBytes = Math.min(128 * 1024, source.ready.welcome.blobLimits.chunkBytes, target.ready.welcome.blobLimits.chunkBytes);
      assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes > 0);
      let chunks = 0;
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        const block = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
        const result = accepted(await source.receipt('blob_chunk', { id: begin.id, offset, data: block.toString('base64') }), 'blob_result');
        assert.equal(result.offset, offset + block.length); chunks++;
      }
      accepted(await source.receipt('blob_commit', { id: begin.id }), 'blob_result');
      const topic = at('blob'), sub = await target.subscribe({ filters: [topic], from: 'now' });
      // Broadcast attachment access is message based; blob profile doesn't depend on directed profile.
      const message = accepted(await source.receipt('publish', { topic, body: { externalControllerSample: true }, attachments: [begin.id] }));
      const received = (await delivery(target, message.seq, sub.subscription)).frame;
      assert.deepEqual(received.attachments, [{ id: begin.id, size: bytes.length, sha256 }]);
      // Broadcast read rights use topic ACL; restricted has no right to this message topic.
      assert.equal((await stranger.receipt('blob_read', { id: begin.id, messageSeq: message.seq, offset: 0 })).code, 'BLOB_DENIED');
      assert.equal((await target.receipt('blob_release', { id: begin.id })).code, 'BLOB_OWNER_DENIED');
      const digest = createHash('sha256'); let offset = 0, readChunks = 0;
      while (offset < bytes.length) {
        const block = accepted(await target.receipt('blob_read', { id: begin.id, messageSeq: message.seq, offset, length: chunkBytes }), 'blob_result');
        const data = Buffer.from(block.data, 'base64'); assert.equal(data.toString('base64'), block.data); assert.equal(block.offset, offset); assert.equal(block.bytes, data.length); assert.ok(data.length > 0);
        digest.update(data); offset += data.length; readChunks++; assert.equal(block.eof, offset === bytes.length);
      }
      assert.equal(offset, bytes.length); assert.equal(digest.digest('hex'), sha256);
      await target.send({ type: 'ack', subscription: sub.subscription, seq: [message.seq] });
      accepted(await target.receipt('register', { channels: [{ name: at('blob-ack-barrier'), subscribe: true }] }), 'registered');
      const ackState = await deadline(fixture.h.status(), 5000, 'blob ACK state');
      assert.equal(ackState.subscriptions.find((subscription) => subscription.id === sub.subscription).cursor, message.seq);
      assert.equal(accepted(await source.receipt('blob_status', { id: begin.id }), 'blob_result').released, false);
      accepted(await source.receipt('blob_release', { id: begin.id }), 'blob_result');
      assert.equal(accepted(await source.receipt('blob_status', { id: begin.id }), 'blob_result').released, true);
      rows.push({ source: source.proof.role, target: target.proof.role, id: begin.id, messageSeq: message.seq, bytes: offset, sha256, uploadChunks: chunks, readChunks, ackCursor: message.seq, retainedAfterAck: true, ownerReleased: true });
    }
    await stranger.close(); return rows;
  });
  await run('BA-07', async () => {
    const begin = Date.now(), exit = await candidate.close(); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
    return { pid: candidate.child.pid, exitCode: exit.code, elapsedMs: Date.now() - begin, maximumWaitMs: 12000 };
  });
} catch (failure) { error = String(failure.stack ?? failure); console.error(error); }
finally {
  if (fixture) try { await fixture.close(); }
  catch (failure) { error = [error, String(failure.stack ?? failure)].filter(Boolean).join('\n'); console.error(failure); }
}

const notExecuted = CHECKS.filter(([, profile]) => Array.isArray(manifest?.profiles) && !manifest.profiles.includes(profile)).map(([id, profile, title]) => ({ id, profile, title, reason: 'profile not selected' }));
const selectedButNotReached = expectedChecks.filter((id) => !checks.some((row) => row.id === id));
const sources = await Promise.all(sourceSnapshots.map(async (source) => {
  try { const afterSha256 = hash(await readFile(source.path)); return { ...source, afterSha256, unchanged: afterSha256 === source.sha256 }; }
  catch (failure) { return { ...source, unchanged: false, unavailable: String(failure.message) }; }
}));
const passed = !error && expectedChecks.length > 0 && checks.length === expectedChecks.length && checks.every((row) => row.passed) && sources.every((source) => source.unchanged);
const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
const recordedCandidateSources = sources.filter((source) => source.candidateDeclared).length;
const report = { passed, startedAt, endedAt: new Date().toISOString(), manifestPath, candidate: manifest?.name, selectedProfiles: manifest?.profiles, expectedChecks, executedChecks: checks.length, passedChecks: checks.filter((row) => row.passed).length, checks, notExecuted, selectedButNotReached,
  version, wire: '0.1', node: process.version, platform: process.platform, arch: process.arch, hub: fixture ? { pid: fixture.h.hub.pid, endpoint: fixture.h.endpoint, exit: fixture.hubExit } : undefined, processes: fixture?.processes, sources, candidateSourceRecord: { declared: candidateSources.length, recorded: recordedCandidateSources, status: candidateSources.length ? (recordedCandidateSources === candidateSources.length ? 'declared files hashed; no source audit implied' : 'declared candidate files not fully recorded; see error/sources') : 'candidate source files not declared or recorded' }, cleanupCompleted: fixture?.cleanupCompleted ?? !fixture, ...(error ? { error } : {}),
  scope: 'This manifest-selected test adapter opens its own WebSocket; NDJSON is a test binding, not a Hub protocol or mandated program shape.',
  limitations: ['Only this candidate manifest, selected profiles and recorded local runtime/platform were executed', 'No acceptance claim for arbitrary third-party bridges, other platforms or business workflow', 'No reconnect, durable candidate cursors, crash recovery, interrupted upload, out-of-order ACK or long-duration acceptance', 'Attachment chunks are generated and checked by the external controller; no automatic file SDK is provided', 'Diagnostic parsed body may be lossy; original JSON claims use the raw string only'] };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed, executed: report.executedChecks, expected: expectedChecks.length, notExecuted: notExecuted.length, report: join(directory, 'report.json') }));
if (!passed) process.exitCode = 1;
