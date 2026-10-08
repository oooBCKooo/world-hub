// Actual external language processes, real WebSockets, isolated durable Hub.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnvelope } from '../../src/hub/lib/wire-json.mjs';
import { Scene, ROOT, LANGUAGES } from './scene-harness.mjs';
import { reserveEvidenceRun, saveLatestEvidence } from '../../tests/helpers/evidence-run.mjs';

const argv = process.argv.slice(2), demo = argv.includes('--demo');
if (demo) argv.splice(argv.indexOf('--demo'), 1);
if (!(argv.length === 0 || argv.length === 2 && argv[0] === '--evidence')) throw new Error('usage: run-cross-language.mjs [--demo] [--evidence directory]');
const evidenceRun = await reserveEvidenceRun(resolve(ROOT, argv[1] ?? `.artifacts/evidence/phase7${demo ? '-demo' : ''}`));
const directory = evidenceRun.directory;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hubFiles = ['src/hub/hub-server.mjs', 'src/hub/ws-server.mjs', 'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs',
  ...(await readdir(join(ROOT, 'src/hub/lib'))).filter((name) => name.endsWith('.mjs')).map((name) => `src/hub/lib/${name}`)];
const hubHashes = await Promise.all(hubFiles.map(async (path) => ({ path, sha256: hash(await readFile(join(ROOT, path))) })));
const scenes = [], originals = [], startedAt = new Date().toISOString();
let scene, peers, error;
const topicRoot = `phase7/run-${randomUUID()}`;
const at = (label) => `${topicRoot}/${label}`;
const delivery = (peer, seq, subscription) => peer.frame((f) => f.type === 'delivery' && f.seq === seq && (!subscription || f.subscription === subscription));
async function run(id, title, body) {
  const begin = Date.now();
  try { const proof = await body(); scenes.push({ id, title, passed: true, elapsedMs: Date.now() - begin, proof }); console.log(`${id} 通过 ${title}`); }
  catch (failure) { scenes.push({ id, title, passed: false, elapsedMs: Date.now() - begin, error: String(failure.stack ?? failure) }); throw failure; }
}
function accepted(receipt, type = 'published') { assert.equal(receipt.type, type); return receipt; }
async function normalSet() { return Promise.all(LANGUAGES.map((language) => scene.peer(language))); }

try {
  scene = await Scene.create();
  if (!demo) {
    peers = await normalSet();
    await run('P7-01', '三种语言独立直连与六个方向广播', async () => {
      assert.equal(new Set([scene.h.hub.pid, ...peers.map((p) => p.child.pid)]).size, 4);
      for (const peer of peers) {
        assert.equal(peer.ready.welcome.authenticated, true);
        assert.ok(peer.ready.welcome.features.includes('directed-v1'));
        assert.ok(peer.ready.welcome.features.includes('blob-v1'));
      }
      const pairs = [];
      for (const source of peers) for (const target of peers) if (source !== target) {
        const topic = at(`pair/${source.language}/${target.language}`);
        const sub = await target.subscribe({ filters: [topic], from: 'now' });
        const body = { kind: `任意新种类-${randomUUID()}`, 来源: source.language, 文本: '中文 🌍 é \n 引号"', n: 9007199254740991, flags: [true, false, null] };
        const receipt = accepted(await source.receipt('publish', { topic, body }));
        const row = await delivery(target, receipt.seq, sub.subscription);
        assert.deepEqual(row.frame.body, body); assert.equal(row.frame.fromPrincipal, undefined);
        pairs.push({ source: source.language, target: target.language, seq: receipt.seq, subscription: sub.subscription });
      }
      return { independentPids: peers.map((p) => ({ language: p.language, pid: p.child.pid })), pairs };
    });
    await run('P7-02', 'mod动态注册与并发订阅回执配对', async () => {
      const proof = [];
      for (const peer of peers) {
        const topics = [at(`并发/${peer.language}/一`), at(`并发/${peer.language}/二`)];
        const registration = accepted(await peer.receipt('register', { channels: topics.map((name) => ({ name, publish: true, subscribe: true })) }), 'registered');
        for (const topic of topics) assert.ok(registration.channels.some((channel) => channel.name === topic && channel.publish && channel.subscribe));
        const subs = await Promise.all(topics.map((topic) => peer.subscribe({ filters: [topic], from: 'now' })));
        assert.notEqual(subs[0].subscription, subs[1].subscription);
        const delivered = [];
        for (let i = 0; i < topics.length; i++) {
          const r = accepted(await peer.receipt('publish', { topic: topics[i], body: { index: i } }));
          assert.equal((await delivery(peer, r.seq, subs[i].subscription)).frame.body.index, i);
          delivered.push(r.seq);
        }
        proof.push({ language: peer.language, topics, subscriptions: subs.map((sub) => ({ token: sub.token, subscription: sub.subscription })), delivered });
      }
      return proof;
    });
    await run('P7-03', '三语言JSON正文原文与UTF-8保真', async () => {
      const proof = [];
      for (let i = 0; i < peers.length; i++) {
        const source = peers[i], target = peers[(i + 1) % peers.length], topic = at(`原文/${source.language}`);
        const bodyRaw = '{ "big":9007199254740993, "decimal":0.123456789012345678901, "exponent":1e0, "escaped":"\\u4e2d", "lone":"\\ud800", "text":"中文🌍𠮷é", "padding":"' + '界🌍'.repeat(5000) + '" }';
        const sub = await target.subscribe({ filters: [topic], from: 'now' });
        const token = randomUUID();
        await source.send(`{"type":"publish","topic":${JSON.stringify(topic)},"body":${bodyRaw},"requestToken":${JSON.stringify(token)}}`);
        const receipt = accepted((await source.frame((f) => f.requestToken === token)).frame);
        const row = await delivery(target, receipt.seq, sub.subscription);
        assert.equal(parseEnvelope(row.raw).bodyRaw, bodyRaw);
        originals.push({ source: source.language, topic, seq: receipt.seq, bodyRaw });
        proof.push({ source: source.language, target: target.language, seq: receipt.seq, bytes: Buffer.byteLength(bodyRaw), sha256: hash(Buffer.from(bodyRaw)) });
      }
      return proof;
    });
    await run('P7-04', '裸wire水位与非法resume／非安全游标', async () => {
      const proof = [];
      for (const peer of peers) {
        const topic = at(`water/${peer.language}`), welcomeSeq = peer.ready.welcome.lastSeq;
        const receipt = accepted(await peers[0].receipt('publish', { topic, body: { marker: peer.language } }));
        const omitted = await peer.subscribe({ filters: [topic] });
        assert.equal(omitted.cursor, receipt.seq); assert.equal(peer.deliveries(omitted.subscription).length, 0);
        const now = await peer.subscribe({ filters: [topic], from: 'now' });
        assert.equal(now.cursor, receipt.seq); assert.equal(peer.deliveries(now.subscription).length, 0);
        const snapshot = await peer.subscribe({ filters: [topic], from: welcomeSeq });
        await delivery(peer, receipt.seq, snapshot.subscription);
        for (const from of ['resume', true, 9007199254740992]) {
          const token = randomUUID(); await peer.send({ type: 'subscribe', filters: [topic], token, from });
          assert.equal((await peer.frame((f) => f.token === token && f.type === 'error')).frame.code, 'CURSOR_INVALID');
        }
        proof.push({ language: peer.language, welcomeSeq, publishedSeq: receipt.seq, omittedCursor: omitted.cursor, nowCursor: now.cursor, snapshotCursor: snapshot.cursor });
      }
      return proof;
    });
    await run('P7-05', '六方向定向请求／可信回应', async () => {
      const proof = [];
      for (const source of peers) for (const target of peers) if (source !== target) {
        const topic = at(`call/${source.language}/${target.language}`);
        const rsub = await source.subscribe({ filters: [topic], operations: ['response'], from: 'now' });
        const qsub = await target.subscribe({ filters: [topic], operations: ['request'], from: 'now' });
        const request = accepted(await source.receipt('request', { target: { principal: target.ready.welcome.principal }, topic, correlation: randomUUID(), body: { question: '请提供信息', from: source.language } }));
        const q = (await delivery(target, request.seq, qsub.subscription)).frame;
        assert.equal(q.fromPrincipal, source.ready.welcome.principal); assert.equal(q.operation, 'request');
        const response = accepted(await target.receipt('respond', { requestSeq: q.seq, body: { answer: '程序自己返回', language: target.language } }));
        const r = (await delivery(source, response.seq, rsub.subscription)).frame;
        assert.equal(r.operation, 'response'); assert.equal(r.requestSeq, request.seq); assert.equal(r.fromPrincipal, target.ready.welcome.principal); assert.equal(r.correlation, q.correlation);
        proof.push({ source: source.language, target: target.language, requestSeq: request.seq, responseSeq: response.seq });
      }
      return proof;
    });
    await run('P7-06', '六方向注入与旁观实时／历史遮挡', async () => {
      const proof = [];
      for (const source of peers) for (const target of peers) if (source !== target) {
        const observer = peers.find((p) => p !== source && p !== target), topic = at(`inject/${source.language}/${target.language}`);
        const osub = await observer.subscribe({ filters: ['#'], operations: ['inject'], from: 'now' });
        const tsub = await target.subscribe({ filters: [topic], operations: ['inject'], from: 'now' });
        const r = accepted(await source.receipt('inject', { target: { principal: target.ready.welcome.principal }, topic, body: { injectedBy: source.language } }));
        assert.equal((await delivery(target, r.seq, tsub.subscription)).frame.operation, 'inject');
        const history = await observer.subscribe({ filters: ['#'], operations: ['inject'], from: 0 });
        assert.equal(observer.deliveries(osub.subscription).some((row) => row.frame.seq === r.seq), false);
        assert.equal(observer.deliveries(history.subscription).some((row) => row.frame.seq === r.seq), false);
        proof.push({ source: source.language, target: target.language, observer: observer.language, seq: r.seq, scanThrough: history.through });
      }
      return proof;
    });
    await run('P7-07', '跨语言拒绝帧、伪回应与提供者释放权', async () => {
      const restricted = await scene.peer('python', { bridge: 'phase7.restricted' });
      const denied = await restricted.receipt('publish', { topic: at('not-allowed'), body: {} });
      assert.equal(denied.code, 'PUBLISH_DENIED'); assert.equal(denied.type, 'denied');
      const request = accepted(await peers[0].receipt('request', { target: { principal: peers[1].ready.welcome.principal }, topic: at('forged'), body: {} }));
      const fake = await peers[2].receipt('respond', { requestSeq: request.seq, body: {} }); assert.equal(fake.code, 'RESPONSE_DENIED');
      const own = accepted(await peers[2].receipt('publish', { topic: at('owned'), body: {} }));
      const before = await fetch(`${scene.h.httpBase}/manage/api/state`).then((r) => r.json());
      const mixed = await peers[2].receipt('release', { seq: [own.seq, request.seq] }); assert.equal(mixed.code, 'RELEASE_DENIED');
      const state = await fetch(`${scene.h.httpBase}/manage/api/state`).then((r) => r.json());
      assert.equal(state.log.protectedCount, before.log.protectedCount);
      await restricted.close();
      return { publishDenied: denied.code, forgedResponse: fake.code, mixedRelease: mixed.code, protectedBefore: before.log.protectedCount, protectedAfter: state.log.protectedCount };
    });
    await run('P7-08', 'ACK按订阅确认且历史读取不释放', async () => {
      const proof = [];
      for (let i = 0; i < peers.length; i++) {
        const publisher = peers[i], reader = peers[(i + 1) % peers.length], topic = at(`ack/${publisher.language}`);
        const first = await reader.subscribe({ filters: [topic], from: 'now' });
        const second = await reader.subscribe({ filters: [topic, at('extra')], from: 'now' });
        const r = accepted(await publisher.receipt('publish', { topic, body: { retained: true } }));
        await Promise.all([delivery(reader, r.seq, first.subscription), delivery(reader, r.seq, second.subscription)]);
        await reader.send({ type: 'ack', subscription: first.subscription, seq: [r.seq] });
        accepted(await reader.receipt('register', { channels: [{ name: at(`barrier/${reader.language}`), subscribe: true }] }), 'registered');
        const firstState = await scene.h.status();
        const firstCursor = firstState.subscriptions.find((sub) => sub.id === first.subscription).cursor;
        const secondCursor = firstState.subscriptions.find((sub) => sub.id === second.subscription).cursor;
        assert.equal(firstCursor, r.seq); assert.equal(secondCursor, second.cursor);
        await reader.send({ type: 'ack', subscription: second.subscription, seq: [r.seq] });
        accepted(await reader.receipt('register', { channels: [{ name: at(`barrier/${reader.language}`), subscribe: true }] }), 'registered');
        const secondState = await scene.h.status();
        assert.equal(secondState.subscriptions.find((sub) => sub.id === second.subscription).cursor, r.seq);
        const historical = await reader.subscribe({ filters: [topic], from: 0 });
        await delivery(reader, r.seq, historical.subscription);
        const mark = reader.number;
        await reader.send({ type: 'ack', subscription: historical.subscription, seq: [r.seq + 100000] });
        assert.equal((await reader.frame((f) => f.type === 'error' && f.code === 'ACK_INVALID', { after: mark })).frame.code, 'ACK_INVALID');
        const wrongRelease = await reader.receipt('release', { seq: [r.seq] }); assert.equal(wrongRelease.code, 'RELEASE_DENIED');
        accepted(await publisher.receipt('release', { seq: [r.seq] }), 'released');
        proof.push({ publisher: publisher.language, reader: reader.language, seq: r.seq, subscriptions: [first.subscription, second.subscription, historical.subscription], firstAckCursor: firstCursor, otherCursorBeforeOwnAck: secondCursor, otherCursorAfterOwnAck: r.seq });
      }
      return proof;
    });
    await run('P7-09', '稳定principal离线后抽取与旧session遮挡', async () => {
      const source = peers[1], old = peers[2], oldSession = old.ready.welcome.session;
      await old.close();
      const topic = at('offline');
      const stable = accepted(await source.receipt('inject', { target: { principal: 'phase7.powershell' }, topic, body: { offline: 'stable' } }));
      const precise = accepted(await source.receipt('inject', { target: { principal: 'phase7.powershell', session: oldSession }, topic, body: { offline: 'old-session' } }));
      const replacement = await scene.peer('powershell'); peers[2] = replacement;
      assert.notEqual(replacement.ready.welcome.session, oldSession);
      const sub = await replacement.subscribe({ filters: [topic], from: 0 });
      await delivery(replacement, stable.seq, sub.subscription);
      assert.equal(replacement.deliveries(sub.subscription).some((row) => row.frame.seq === precise.seq), false);
      return { oldSession, newSession: replacement.ready.welcome.session, stableSeq: stable.seq, hiddenPreciseSeq: precise.seq, through: sub.through };
    });
    await run('P7-10', '共享principal多mod扇出与精确session', async () => {
      const one = await scene.peer('python', { bridge: 'shared-python', credential: 'phase7.shared' });
      const two = await scene.peer('powershell', { bridge: 'shared-powershell', credential: 'phase7.shared' });
      const topic = at('shared');
      const [s1, s2] = await Promise.all([one.subscribe({ filters: [topic], from: 'now' }), two.subscribe({ filters: [topic], from: 'now' })]);
      const broad = accepted(await peers[0].receipt('inject', { target: { principal: 'phase7.shared' }, topic, body: {} }));
      await Promise.all([delivery(one, broad.seq, s1.subscription), delivery(two, broad.seq, s2.subscription)]);
      const narrow = accepted(await peers[0].receipt('inject', { target: { principal: 'phase7.shared', session: one.ready.welcome.session }, topic, body: {} }));
      await delivery(one, narrow.seq, s1.subscription);
      const h2 = await two.subscribe({ filters: [topic], from: 0 });
      assert.deepEqual(two.deliveries(h2.subscription).map((row) => row.frame.seq), [broad.seq]);
      await Promise.all([one.close(), two.close()]);
      return { principals: [one.ready.welcome.principal, two.ready.welcome.principal], languages: [one.language, two.language], broadSeq: broad.seq, narrowSeq: narrow.seq };
    });
    await run('P7-11', '5MiB分块附件三语言循环与越权拒绝', async () => {
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 37);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + Math.floor(i / 1024)) & 255;
      const sha256 = hash(bytes), proof = [];
      for (let i = 0; i < peers.length; i++) {
        const source = peers[i], target = peers[(i + 1) % peers.length], stranger = peers[(i + 2) % peers.length];
        const descriptor = accepted(await source.receipt('blob_begin', { size: bytes.length, sha256 }), 'blob_result');
        const chunkBytes = Math.min(128 * 1024, source.ready.welcome.blobLimits.chunkBytes);
        let chunks = 0;
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          const block = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
          const chunk = accepted(await source.receipt('blob_chunk', { id: descriptor.id, offset, data: block.toString('base64') }), 'blob_result');
          assert.equal(chunk.offset, offset + block.length); chunks++;
          if (offset === 0) {
            const duplicate = accepted(await source.receipt('blob_chunk', { id: descriptor.id, offset: 0, data: block.toString('base64') }), 'blob_result');
            assert.equal(duplicate.offset, block.length);
            const conflict = await source.receipt('blob_chunk', { id: descriptor.id, offset: 0, data: Buffer.alloc(block.length).toString('base64') });
            assert.match(conflict.code, /CONFLICT/);
          }
        }
        accepted(await source.receipt('blob_commit', { id: descriptor.id }), 'blob_result');
        const topic = at(`blob/${source.language}`), sub = await target.subscribe({ filters: [topic], from: 'now' });
        const message = accepted(await source.receipt('inject', { target: { principal: target.ready.welcome.principal }, topic, body: { opaque: true }, attachments: [descriptor.id] }));
        const delivered = (await delivery(target, message.seq, sub.subscription)).frame;
        assert.deepEqual(delivered.attachments, [{ id: descriptor.id, size: bytes.length, sha256 }]);
        assert.equal((await stranger.receipt('blob_read', { id: descriptor.id, messageSeq: message.seq, offset: 0 })).code, 'BLOB_DENIED');
        assert.equal((await target.receipt('blob_release', { id: descriptor.id })).code, 'BLOB_OWNER_DENIED');
        const digest = createHash('sha256'); let offset = 0, blocks = 0;
        for (;;) {
          const block = accepted(await target.receipt('blob_read', { id: descriptor.id, messageSeq: message.seq, offset, length: chunkBytes }), 'blob_result');
          const data = Buffer.from(block.data, 'base64'); assert.equal(data.toString('base64'), block.data); assert.equal(block.bytes, data.length); assert.equal(block.offset, offset);
          digest.update(data); offset += data.length; blocks++;
          if (block.eof) break;
          assert.ok(data.length > 0);
        }
        assert.equal(offset, bytes.length); assert.equal(digest.digest('hex'), sha256);
        await target.send({ type: 'ack', subscription: sub.subscription, seq: [message.seq] });
        const status = accepted(await source.receipt('blob_status', { id: descriptor.id }), 'blob_result'); assert.equal(status.released, false);
        accepted(await source.receipt('blob_release', { id: descriptor.id }), 'blob_result');
        proof.push({ source: source.language, target: target.language, id: descriptor.id, messageSeq: message.seq, bytes: offset, sha256, uploadChunks: chunks, readChunks: blocks, retainedAfterAck: !status.released });
      }
      return proof;
    });
  }
  await run('P7-12', '独立工作流三轮、每轮Python与PowerShell返回成果', async () => {
    await scene.peer('python', { bridge: 'phase7.python.service', echoTopic: 'phase7/workflow' });
    await scene.peer('powershell', { bridge: 'phase7.powershell.service', echoTopic: 'phase7/workflow' });
    const result = await scene.workflow();
    assert.equal(result.rounds, 3); assert.equal(result.programsPerRound, 2); assert.equal(result.trace.length, 6);
    assert.deepEqual(result.result.steps, ['javascript', 'python', 'powershell', 'javascript:round-1', 'python', 'powershell', 'javascript:round-2', 'python', 'powershell', 'javascript:round-3']);
    assert.equal(new Set(result.trace.flatMap((row) => [row.requestSeq, row.responseSeq])).size, 12);
    await writeFile(join(directory, 'workflow-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  });
  if (!demo) {
    await run('P7-13', '三语言握手拒绝均非零退出', async () => {
      const proof = [];
      for (const language of LANGUAGES) {
        const peer = await scene.peer(language, { bridge: 'phase7.unregistered', expectReady: false });
        const row = await peer.frame((f) => f.type === 'denied'); assert.equal(row.frame.code, 'BRIDGE_NOT_REGISTERED');
        const timeout = setTimeout(() => peer.child.kill(), 10000);
        const exit = await peer.exit; clearTimeout(timeout);
        assert.notEqual(exit.code, 0); assert.equal(exit.signal, null);
        proof.push({ language, pid: peer.child.pid, code: row.frame.code, exitCode: exit.code });
      }
      return proof;
    });
    await run('P7-14', '真实磁盘重启后三语言历史原文重读', async () => {
      const oldPid = scene.h.hub.pid; await scene.restart(); peers = await normalSet();
      assert.notEqual(oldPid, scene.h.hub.pid);
      const proof = [];
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i], target = peers[(i + 2) % peers.length];
        const sub = await target.subscribe({ filters: [original.topic], from: 0 });
        const row = await delivery(target, original.seq, sub.subscription);
        assert.equal(parseEnvelope(row.raw).bodyRaw, original.bodyRaw);
        proof.push({ originalSource: original.source, reader: target.language, seq: original.seq, sha256: hash(Buffer.from(parseEnvelope(row.raw).bodyRaw)), through: sub.through });
      }
      return { oldHubPid: oldPid, newHubPid: scene.h.hub.pid, records: proof };
    });
  }
} catch (failure) { error = String(failure.stack ?? failure); console.error(error); }
finally {
  if (scene) try { await scene.close(); }
  catch (cleanupError) { error = [error, String(cleanupError.stack ?? cleanupError)].filter(Boolean).join('\n'); console.error(cleanupError); }
}

const unchangedHub = [];
for (const source of hubHashes) unchangedHub.push({ ...source, unchanged: hash(await readFile(join(ROOT, source.path))) === source.sha256 });
const sourceFiles = ['package.json', 'scripts/verify.mjs', 'examples/cross-language/run-cross-language.mjs', 'tests/helpers/evidence-run.mjs', 'examples/cross-language/scene-harness.mjs', 'examples/cross-language/js-worker.mjs', 'examples/cross-language/workflow-program.mjs'];
for (const language of ['python', 'powershell']) {
  for (const area of [`sdk/${language}`, `tests/fixtures/${language}`]) {
    for (const name of await readdir(join(ROOT, area))) if (/\.(py|ps1|psm1|cs|txt)$/.test(name)) sourceFiles.push(`${area}/${name}`);
  }
}
const sources = await Promise.all(sourceFiles.map(async (path) => ({ path, sha256: hash(await readFile(join(ROOT, path))) })));
const expectedScenes = demo ? ['P7-12'] : Array.from({ length: 14 }, (_, i) => `P7-${String(i + 1).padStart(2, '0')}`);
const passed = !error && scenes.length === expectedScenes.length && expectedScenes.every((id) => scenes.some((row) => row.id === id && row.passed)) && unchangedHub.every((row) => row.unchanged);
const report = { passed, version: JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version, wire: '0.1', node: process.version, platform: process.platform, arch: process.arch, demo, startedAt, endedAt: new Date().toISOString(), expectedScenes, passedScenes: scenes.filter((row) => row.passed).length, scenes,
  hubs: scene?.hubs, processes: scene?.processes, sources, unchangedHub, ...(error ? { error } : {}),
  scope: 'Actual local JS, Python and PowerShell processes use their own WebSocket mod bridges; external fixture programs define every business action.',
  limitations: ['PowerShell transport is C# ClientWebSocket hosted by pwsh, not a standalone .NET SDK acceptance', 'Only recorded Windows/Node/Python/PowerShell versions tested', 'No Linux, cross-machine, arbitrary third-party program or long-duration acceptance', 'Cross-language out-of-order/duplicate ACK, interrupted-upload resume and bad SHA-256 not executed in these 14 scenes', 'Reference bridges expose complete wire frames; no implicit ACK/release, persistent cursors, reconnect or exactly-once business guarantee'] };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await saveLatestEvidence(evidenceRun, report);
console.log(JSON.stringify({ passed, scenes: report.passedScenes, expected: expectedScenes.length, report: join(directory, 'report.json') }));
if (!passed) process.exitCode = 1;
