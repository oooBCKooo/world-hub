import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection as tcpConnect } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Hub } from '../../src/hub/lib/hub.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { parseEnvelope } from '../../src/hub/lib/wire-json.mjs';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, until, sleep } from '../helpers/hub-harness.mjs';
import { ManagementState } from '../../src/management/management-state.mjs';
import { createManagementHttp } from '../../src/management/management-http.mjs';
import { attachWebSocketServer } from '../../src/hub/ws-server.mjs';

const acl = () => ({ bridges: {
  source: { token: 'private-source-token', allow: { publish: ['stream/#'], subscribe: [] } },
  reader: { token: 'private-reader-token', allow: { publish: ['reply/#'], subscribe: ['stream/#'] } },
  worker: { allow: { publish: [], subscribe: ['stream/#'] } },
}, credentials: { fleet: { token: 'private-fleet-token', maxConnections: 3, allow: { publish: ['stream/#'], subscribe: ['stream/#'] } } } });
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'hub-management-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function realFixture(t, { defaultManagementPath = false, aclConfiguration = acl() } = {}) {
  // Register cleanup after child/bridge shutdown, not while a log is open.
  const root = mkdtempSync(join(tmpdir(), 'hub-management-'));
  const logDir = join(root, 'actual-log');
  const stateFile = join(logDir, 'management.json');
  const configPath = join(root, 'hub.config.json');
  writeFileSync(configPath, JSON.stringify({ acl: aclConfiguration, log: { dir: './configured-log' },
    ...(defaultManagementPath ? {} : { management: { stateFile } }) }));
  let h = new Harness({ logDir, keepTmp: true });
  const bridges = [], children = [];
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close()));
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit)); child.kill('SIGKILL'); await exited;
    }
    await h.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true });
  });
  await h.startHub({ configPath, isolateLog: false });
  const run = { root, logDir, stateFile, configPath, children, get h() { return h; },
    async connect(bridgeId, credential) {
      const token = credential ? aclConfiguration.credentials[credential]?.token : aclConfiguration.bridges[bridgeId]?.token;
      const bridge = new Bridge({ url: h.endpoint, bridgeId, credential, token, reconnectMs: 30, cursorFile: join(root, `cursor-${bridges.length}.json`) });
      bridges.push(bridge); await bridge.connect(); return bridge;
    },
    async state() { const response = await fetch(`${h.httpBase}/manage/api/state`); assert.equal(response.status, 200); return response.json(); },
    async post(route, value, headers = {}) {
      const state = await this.state();
      const response = await fetch(`${h.httpBase}/manage/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json',
        origin: h.httpBase, 'x-management-token': state.csrfToken, ...headers }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    },
    async restart() { const port = h.port; await h.stop(); h = new Harness({ port, logDir, keepTmp: true }); await h.startHub({ configPath, isolateLog: false }); },
  };
  return run;
}
class Connection extends EventEmitter {
  remoteAddress = '127.0.0.1'; frames = []; raw = []; closed = false;
  send(text) { this.raw.push(text); this.frames.push(JSON.parse(text)); }
  close() { this.closed = true; this.emit('close'); }
  async input(frame) { this.emit('message', typeof frame === 'string' ? frame : JSON.stringify(frame)); await sleep(10); }
}
async function pureFixture(t) {
  const root = temporary(t);
  const config = normalizeConfig({ acl: acl(), log: { enabled: false, dir: root }, management: { stateFile: join(root, 'management.json') } }, null);
  const hub = await Hub.create(config); t.after(() => hub.stop());
  async function connect(id, credential) {
    const connection = new Connection(); hub.onConnection(connection);
    await connection.input({ type: 'hello', wire: '0.1', bridge: id, ...(credential ? { credential, token: config.acl.credentials[credential].token } : { token: config.acl.bridges[id]?.token }) });
    return connection;
  }
  return { root, hub, config, connect };
}
async function invoke(management, { method = 'GET', path = '/manage/api/state', remote = '127.0.0.1', host = '127.0.0.1:8790', headers = {}, rawBody = '' } = {}) {
  const req = Readable.from([Buffer.from(rawBody)]);
  Object.assign(req, { method, headers: { host, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers }, socket: { remoteAddress: remote, localPort: 8790 } });
  const result = { status: null, headers: {}, text: '' };
  const res = { writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; }, end(text) { result.text = text; } };
  assert.equal(await management.handle(req, res, new URL(path, 'http://127.0.0.1:8790')), true);
  result.body = JSON.parse(result.text); return result;
}

test('management state: a failed atomic save cannot apply a new admission policy', async t => {
  const { hub, config, connect } = await pureFixture(t);
  const state = await ManagementState.open(config.management.stateFile);
  const connected = await connect('reader');
  mkdirSync(config.management.stateFile); // A directory at the file target deterministically rejects rename on Windows/POSIX.
  let applied = false;
  await assert.rejects(state.update(next => { next.paused = ['reader']; }, next => { applied = true; hub.setPausedPrincipals(next.paused); }));
  assert.equal(applied, false); assert.deepEqual(state.value.paused, []); assert.equal(connected.closed, false);
  const replacement = await connect('reader');
  assert.ok(replacement.frames.some(frame => frame.type === 'welcome'), 'the previous ACL/admission policy still applies');
});

test('management trace: bounded events have monotonic IDs and record the actual delivery recipient', async t => {
  const { hub, connect } = await pureFixture(t);
  const source = await connect('source'), reader = await connect('reader');
  await reader.input({ type: 'subscribe', filters: ['stream/#'], from: 0 });
  await source.input({ type: 'publish', topic: 'stream/arbitrary', body: { untouched: true } });
  const delivery = hub.snapshot().recent.find(event => event.kind === 'delivery');
  assert.equal(delivery.to, 'reader'); assert.equal(delivery.from, 'source'); assert.equal(delivery.sent, true);
  assert.equal(reader.frames.find(frame => frame.type === 'delivery').seq, delivery.seq);
  for (let index = 0; index < 600; index++) hub.managementNote({ kind: 'management.test', index });
  const events = hub.snapshot().recent;
  assert.equal(events.length, 100); assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
  assert.ok(events.every((event, index) => index === 0 || event.eventId > events[index - 1].eventId));
  assert.deepEqual(events.map(event => event.index), Array.from({ length: 100 }, (_, index) => index + 500));
});

test('management pause persists across hub restart, blocks reconnects and resumes original ACL/cursor catch-up', async t => {
  const run = await realFixture(t);
  const source = await run.connect('source'), reader = await run.connect('reader');
  const deliveries = [], denied = [];
  reader.on('delivery', frame => deliveries.push(frame)); reader.on('denied', frame => denied.push(frame));
  await reader.subscribe(['stream/#'], { from: 0 });
  const first = await source.publishConfirmed('stream/one', { ordinal: 1 });
  await until(() => reader.cursorOf(['stream/#']) === first.seq);
  assert.equal((await run.post('bridge', { key: 'reader', action: 'pause' })).status, 200);
  await until(() => !reader.connected && denied.some(frame => frame.code === 'BRIDGE_PAUSED'));
  const second = await source.publishConfirmed('stream/two', { ordinal: 2 });
  await sleep(120); assert.deepEqual(deliveries.map(frame => frame.body.ordinal), [1]);
  assert.equal((await run.state()).bridges.find(bridge => bridge.key === 'reader').paused, true);
  assert.deepEqual(JSON.parse(readFileSync(run.stateFile, 'utf8')).paused, ['reader']);
  await run.restart();
  assert.equal((await run.state()).bridges.find(bridge => bridge.key === 'reader').paused, true);
  await until(() => source.connected);
  const third = await source.publishConfirmed('stream/three', { ordinal: 3 });
  assert.equal(reader.connected, false);
  assert.equal((await run.post('bridge', { key: 'reader', action: 'resume' })).status, 200);
  await until(() => reader.connected && reader.cursorOf(['stream/#']) === third.seq);
  assert.deepEqual(deliveries.map(frame => frame.seq), [first.seq, second.seq, third.seq]);
  await assert.rejects(reader.publishConfirmed('outside/grant', {}), /PUBLISH_DENIED/);
  await assert.rejects(reader.subscribe(['outside/#']), /SUBSCRIBE_DENIED/);
  assert.equal((await run.state()).bridges.find(bridge => bridge.key === 'reader').paused, false);
});

test('management pause never terminates the external program that owns its reconnecting bridge', async t => {
  const run = await realFixture(t);
  const script = join(run.root, 'external-program.mjs');
  const bridgeUrl = new URL('../../sdk/javascript/bridge-kit.mjs', import.meta.url).href;
  writeFileSync(script, `import { Bridge } from ${JSON.stringify(bridgeUrl)};\nconst bridge = new Bridge({url:${JSON.stringify(run.h.endpoint)},bridgeId:'worker',reconnectMs:30});\nbridge.on('denied', frame => console.log(JSON.stringify({event:'denied',code:frame.code})));\nbridge.on('open', () => console.log(JSON.stringify({event:'open'})));\nsetInterval(() => console.log(JSON.stringify({event:'alive',pid:process.pid})), 80);\nawait bridge.connect();\nconsole.log(JSON.stringify({event:'ready',pid:process.pid}));\n`, 'utf8');
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); run.children.push(child);
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  await until(() => output.includes('"event":"ready"'));
  await run.post('bridge', { key: 'worker', action: 'pause' });
  await until(() => output.includes('BRIDGE_PAUSED'));
  const oldLength = output.length;
  await until(() => output.slice(oldLength).includes('"event":"alive"'));
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  assert.equal((await run.state()).bridges.find(bridge => bridge.key === 'worker').instances.length, 0);
  await run.post('bridge', { key: 'worker', action: 'resume' });
  await until(async () => (await run.state()).bridges.find(bridge => bridge.key === 'worker').instances.length === 1);
  assert.equal(child.exitCode, null);
});

test('management credential pause gates all live instances while disconnect targets only selected current connections', async t => {
  const run = await realFixture(t);
  const one = await run.connect('arbitrary-one', 'fleet'), two = await run.connect('arbitrary-two', 'fleet');
  const snapshot = await run.state(), instances = snapshot.bridges.find(bridge => bridge.key === 'fleet').instances;
  assert.equal(instances.length, 2); assert.ok(instances.every(instance => typeof instance.connectionId === 'string'));
  const selected = instances.find(instance => instance.bridgeId === one.welcome.bridge);
  const oldIdentity = one.welcome.bridge, otherIdentity = two.welcome.bridge;
  const result = await run.post('bridge', { key: 'fleet', action: 'disconnect', connectionIds: [selected.connectionId] });
  assert.equal(result.status, 200); assert.equal(result.body.disconnected, 1);
  await until(() => one.connected && one.welcome.bridge !== oldIdentity);
  assert.equal(two.welcome.bridge, otherIdentity, 'another instance must not be disconnected');
  assert.equal((await run.state()).bridges.find(bridge => bridge.key === 'fleet').paused, false);
  const newIdentity = one.welcome.bridge;
  const stale = await run.post('bridge', { key: 'fleet', action: 'disconnect', connectionIds: [selected.connectionId] });
  assert.equal(stale.body.disconnected, 0); assert.equal(one.welcome.bridge, newIdentity, 'a stale click must not close a replacement connection');
  await run.post('bridge', { key: 'fleet', action: 'pause' });
  await until(() => !one.connected && !two.connected);
  await sleep(100); assert.equal((await run.state()).bridges.find(bridge => bridge.key === 'fleet').instances.length, 0);
  await run.post('bridge', { key: 'fleet', action: 'resume' });
  await until(() => one.connected && two.connected);
});

test('management annotations support N:M labels without changing routing, subscriptions, ACL or payloads', async t => {
  const run = await realFixture(t);
  const source = await run.connect('source'), reader = await run.connect('reader');
  const deliveries = []; reader.on('delivery', frame => deliveries.push(frame)); await reader.subscribe(['stream/#'], { from: 0 });
  const before = (await run.h.status()).subscriptions;
  const shared = { id: 'same-program', name: '同一外部程序' };
  assert.equal((await run.post('annotation', { key: 'source', bridgeName: '一座桥接多个程序', programs: [shared, { id: 'other-program', name: '其他程序' }] })).status, 200);
  assert.equal((await run.post('annotation', { key: 'reader', bridgeName: '另一个桥', programs: [shared] })).status, 200);
  const after = await run.state();
  assert.equal(after.bridges.find(bridge => bridge.key === 'source').programs.length, 2);
  assert.equal(after.bridges.find(bridge => bridge.key === 'reader').programs[0].id, shared.id);
  assert.deepEqual(after.hub.subscriptions, before);
  assert.equal(after.hub.lastSeq, 0, 'annotations are not published messages');
  const body = { kind: 'unknown-to-management', nested: { program: 'payload-owned-name' } };
  await source.publishConfirmed('stream/opaque', body);
  await until(() => deliveries.length === 1);
  assert.deepEqual(deliveries[0].body, body); assert.equal(Object.hasOwn(deliveries[0], 'programs'), false);
  const queried = await run.state();
  const actualDelivery = queried.events.find(event => event.kind === 'delivery' && event.seq === deliveries[0].seq);
  assert.equal(actualDelivery.to, reader.welcome.bridge, 'HTTP trace identifies the real socket recipient, not a program annotation');
  const messageResponse = await fetch(`${run.h.httpBase}/manage/api/message?seq=${deliveries[0].seq}`);
  assert.equal(messageResponse.status, 200);
  const inspected = await messageResponse.json();
  assert.deepEqual(inspected.record.body, body); assert.equal(Object.hasOwn(inspected.record, 'owner'), false);
  await assert.rejects(source.publishConfirmed('not/allowed', body), /PUBLISH_DENIED/);
  const durable = await ManagementState.open(run.stateFile);
  assert.equal(durable.value.annotations.source.programs[0].id, durable.value.annotations.reader.programs[0].id);
});

test('management access rejects non-loopback, rebinding hosts, foreign origins and missing/wrong operation tokens', async t => {
  const { hub, config } = await pureFixture(t);
  const management = await createManagementHttp(hub, config), token = management.snapshot().csrfToken;
  const cases = [
    { remote: '192.0.2.20', code: 'MANAGEMENT_LOCAL_ONLY' },
    { remote: '192.0.2.20', headers: { 'x-forwarded-for': '127.0.0.1' }, code: 'MANAGEMENT_LOCAL_ONLY' },
    { host: 'attacker.example:8790', code: 'HOST_REJECTED' },
    { host: '127.0.0.1:8791', code: 'HOST_REJECTED' },
    { headers: { origin: 'http://attacker.example:8790' }, code: 'ORIGIN_REJECTED' },
    { headers: { 'sec-fetch-site': 'cross-site' }, code: 'ORIGIN_REJECTED' },
    { method: 'POST', path: '/manage/api/bridge', rawBody: '{"key":"reader","action":"pause"}', code: 'MANAGEMENT_TOKEN_REQUIRED' },
    { method: 'POST', path: '/manage/api/bridge', headers: { 'x-management-token': 'wrong' }, rawBody: '{"key":"reader","action":"pause"}', code: 'MANAGEMENT_TOKEN_REQUIRED' },
  ];
  for (const { code, ...input } of cases) {
    const response = await invoke(management, input); assert.equal(response.status, 403); assert.equal(response.body.error.code, code);
    assert.deepEqual(management.state.value.paused, []);
  }
  assert.equal((await invoke(management, { remote: '::1', host: '[::1]:8790' })).status, 200);
  assert.equal((await invoke(management, { method: 'POST', path: '/manage/api/bridge', headers: { origin: 'http://127.0.0.1:8790', 'x-management-token': token }, rawBody: '{"key":"reader","action":"pause"}' })).status, 200);
});

test('management real HTTP rejects rebinding Host and foreign Origin without changing admission policy', async t => {
  const run = await realFixture(t);
  const response = await new Promise((resolveResponse, reject) => {
    const request = httpRequest(`${run.h.httpBase}/manage/api/state`, { headers: { host: `attacker.example:${run.h.port}` } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolveResponse({ status: res.statusCode, body: JSON.parse(text) }));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'HOST_REJECTED');
  const foreign = await run.post('bridge', { key: 'reader', action: 'pause' }, { origin: 'http://foreign.example' });
  assert.equal(foreign.status, 403); assert.equal(foreign.body.error.code, 'ORIGIN_REJECTED');
  const token = await run.post('bridge', { key: 'reader', action: 'pause' }, { 'x-management-token': 'wrong' });
  assert.equal(token.status, 403); assert.equal(token.body.error.code, 'MANAGEMENT_TOKEN_REQUIRED');
  assert.equal((await run.state()).bridges.find(bridge => bridge.key === 'reader').paused, false);
  assert.equal(existsSync(run.stateFile), false);
});

test('management rejects oversized/invalid bodies, unknown actions and invalid annotations without changing settings', async t => {
  const { hub, config } = await pureFixture(t);
  const management = await createManagementHttp(hub, config), token = management.snapshot().csrfToken;
  const original = management.state.value;
  const cases = [
    { path: '/manage/api/bridge', rawBody: JSON.stringify({ key: 'reader', action: 'pause', padding: 'x'.repeat(16 * 1024) }), status: 413, code: 'MANAGEMENT_BODY_TOO_LARGE' },
    { path: '/manage/api/bridge', rawBody: '{', status: 400, code: 'MANAGEMENT_BODY_INVALID' },
    { path: '/manage/api/bridge', rawBody: '[]', status: 400, code: 'MANAGEMENT_BODY_INVALID' },
    { path: '/manage/api/bridge', rawBody: '{"key":"reader","action":"launch-program"}', status: 400, code: 'MANAGEMENT_ACTION_INVALID' },
    { path: '/manage/api/bridge', rawBody: '{"key":"unknown","action":"pause"}', status: 404, code: 'MANAGEMENT_TARGET_UNKNOWN' },
    { path: '/manage/api/bridge', rawBody: '{"key":"reader","action":"disconnect"}', status: 400, code: 'MANAGEMENT_CONNECTIONS_REQUIRED' },
    { path: '/manage/api/annotation', rawBody: JSON.stringify({ key: 'reader', bridgeName: 'label', programs: [{ id: 'duplicate', name: 'a' }, { id: 'duplicate', name: 'b' }] }), status: 400, code: 'ANNOTATION_INVALID' },
  ];
  for (const { status, code, ...input } of cases) {
    const response = await invoke(management, { ...input, method: 'POST', headers: { 'x-management-token': token } });
    assert.equal(response.status, status); assert.equal(response.body.error.code, code); assert.deepEqual(management.state.value, original);
  }
  assert.equal(existsSync(config.management.stateFile), false, 'rejected input must not create a settings file');
});

test('management message lookup retains opaque raw JSON while state/settings exclude payloads, retention owners and ACL secrets', async t => {
  const { hub, config, connect } = await pureFixture(t);
  const management = await createManagementHttp(hub, config);
  const source = await connect('source'), reader = await connect('reader');
  await reader.input({ type: 'subscribe', filters: ['stream/#'], from: 0 });
  const rawBody = '{ "large":9007199254740993, "escaped":"\\u0061", "secretBody":"only-inspector-sees", "owner":"payload-owner" }';
  await source.input('{"type":"publish","topic":"stream/raw","body":' + rawBody + '}');
  const seq = hub.log.lastSeq;
  const state = await invoke(management);
  assert.equal(state.text.includes('only-inspector-sees'), false, 'polling state carries only message metadata');
  assert.equal(state.text.includes('"owner"'), false);
  for (const entry of Object.values(acl().bridges).concat(Object.values(acl().credentials))) if (entry.token) assert.equal(state.text.includes(entry.token), false);
  const inspected = await invoke(management, { path: `/manage/api/message?seq=${seq}` });
  assert.equal(inspected.status, 200); assert.equal(Object.hasOwn(inspected.body.record, 'owner'), false);
  assert.equal(parseEnvelope(inspected.text.slice('{"record":'.length, -1)).bodyRaw, rawBody);
  assert.equal(inspected.body.record.body.owner, 'payload-owner', 'management must not interpret business fields');
  const trace = state.body.events.find(event => event.kind === 'delivery');
  assert.equal(trace.seq, seq); assert.equal(trace.to, 'reader'); assert.equal(trace.from, 'source');
  for (const query of ['0', '1.5', 'no-number']) assert.equal((await invoke(management, { path: `/manage/api/message?seq=${query}` })).status, 400);
  assert.equal((await invoke(management, { path: `/manage/api/message?seq=${seq + 1}` })).status, 404);
  await management.state.update(next => { next.annotations.reader = { bridgeName: 'display label', programs: [{ id: 'p', name: 'program' }] }; });
  const saved = readFileSync(config.management.stateFile, 'utf8');
  assert.equal(saved.includes('only-inspector-sees'), false); assert.equal(saved.includes('"owner"'), false);
  assert.equal(saved.includes('private-'), false);
});

test('management HTTP cannot apply a pause after durable settings rename fails', async t => {
  const { hub, config, connect } = await pureFixture(t);
  const management = await createManagementHttp(hub, config), source = await connect('source');
  mkdirSync(config.management.stateFile);
  const response = await invoke(management, { method: 'POST', path: '/manage/api/bridge', headers: { 'x-management-token': management.snapshot().csrfToken }, rawBody: '{"key":"source","action":"pause"}' });
  assert.equal(response.status, 500); assert.equal(source.closed, false); assert.deepEqual(management.state.value.paused, []);
  assert.equal(hub.snapshot().recent.some(event => event.kind === 'management.pause'), false);
});

test('management corrupt persisted settings reject hub startup instead of admitting peers', async t => {
  const root = temporary(t), logDir = join(root, 'log'), stateFile = join(logDir, 'management.json');
  mkdirSync(logDir); writeFileSync(stateFile, '{broken-json');
  const configPath = join(root, 'hub.config.json'); writeFileSync(configPath, JSON.stringify({ acl: acl(), management: { stateFile } }));
  const h = new Harness({ logDir, keepTmp: true }); t.after(() => h.stop());
  await assert.rejects(ManagementState.open(stateFile), error => error.code === 'MANAGEMENT_STATE_CORRUPT');
  await assert.rejects(h.startHub({ configPath, isolateLog: false }), /hub exited early code=1.*管理设置无法读取/s);
  assert.equal(h.ready, null); assert.equal(readFileSync(stateFile, 'utf8'), '{broken-json');
});

test('management default settings follow the effective --log-dir override', async t => {
  const run = await realFixture(t, { defaultManagementPath: true });
  assert.equal((await run.post('bridge', { key: 'reader', action: 'pause' })).status, 200);
  assert.ok(existsSync(run.stateFile)); assert.deepEqual(JSON.parse(readFileSync(run.stateFile, 'utf8')).paused, ['reader']);
  assert.equal(existsSync(join(run.root, 'configured-log', 'management.json')), false);
});

test('management identity: invalid bridge or credential configuration rejects actual hub startup', async t => {
  const root = temporary(t);
  for (const [kind, identity] of [['bridges', 'forged:bridge'], ['credentials', 'fleet:west']]) {
    const configuredAcl = { bridges: {}, credentials: {} };
    configuredAcl[kind][identity] = { allow: { publish: ['#'], subscribe: ['#'] } };
    assert.throws(() => normalizeConfig({ acl: configuredAcl }, null), error => error.message.includes('ACL identity') && error.message.includes(identity) && error.message.includes('invalid'));
    const configPath = join(root, `${kind}.config.json`);
    writeFileSync(configPath, JSON.stringify({ acl: configuredAcl, management: { stateFile: join(root, `${kind}.management.json`) } }));
    const h = new Harness({ logDir: join(root, `${kind}.log`), keepTmp: true });
    t.after(async () => { if (h.hub && h.hub.exitCode === null && h.hub.signalCode === null) await h.stop(); });
    await assert.rejects(h.startHub({ configPath, isolateLog: false }), error => error.message.includes('ACL identity') && error.message.includes(identity) && error.message.includes('invalid'));
    assert.equal(h.hub.exitCode, 1); assert.equal(h.ready, null);
    assert.equal(h.stdout.includes('"event":"ready"'), false, 'an invalid identity must never expose a live hub');
  }
});

test('management identity: malformed hello credentials cannot forge an instance or a manageable principal', async t => {
  const { hub } = await pureFixture(t);
  for (const credential of ['fleet:west', 'Fleet', 'fleet/route', 'x'.repeat(65)]) {
    const connection = new Connection(); hub.onConnection(connection);
    await connection.input({ type: 'hello', wire: '0.1', bridge: 'reader', credential, token: 'private-reader-token' });
    assert.equal(connection.frames.find(frame => frame.type === 'denied')?.code, 'CREDENTIAL_ID_INVALID');
    assert.equal(connection.frames.some(frame => frame.type === 'welcome'), false); assert.equal(connection.closed, true);
  }
  assert.equal(hub.snapshot().bridges.length, 0);
});

test('management identity: dotted credential instances belong to their exact stable principal and remain manageable', async t => {
  const configuredAcl = acl(); configuredAcl.credentials['fleet.west'] = configuredAcl.credentials.fleet; delete configuredAcl.credentials.fleet;
  const run = await realFixture(t, { aclConfiguration: configuredAcl });
  const bridge = await run.connect('application-instance', 'fleet.west');
  const physicalId = bridge.welcome.bridge;
  assert.match(physicalId, /^fleet\.west:\d+$/);
  const snapshot = await run.state(), principal = snapshot.bridges.find(item => item.key === 'fleet.west');
  assert.equal(principal.kind, 'credential'); assert.equal(principal.manageable, true);
  assert.deepEqual(principal.instances.map(instance => instance.bridgeId), [physicalId]);
  assert.equal(snapshot.bridges.some(item => item.key === 'fleet' || item.key === physicalId), false);
  const denied = []; bridge.on('denied', frame => denied.push(frame));
  assert.equal((await run.post('bridge', { key: 'fleet.west', action: 'pause' })).status, 200);
  await until(() => !bridge.connected && denied.some(frame => frame.code === 'BRIDGE_PAUSED'));
  assert.deepEqual(JSON.parse(readFileSync(run.stateFile, 'utf8')).paused, ['fleet.west']);
  assert.equal((await run.state()).bridges.find(item => item.key === 'fleet.west').instances.length, 0);
  assert.equal((await run.post('bridge', { key: 'fleet.west', action: 'resume' })).status, 200);
  await until(() => bridge.connected);
  assert.notEqual(bridge.welcome.bridge, physicalId);
  const receipt = await bridge.publishConfirmed('stream/dotted-principal', { arbitrary: true });
  const message = await fetch(`${run.h.httpBase}/manage/api/message?seq=${receipt.seq}`).then(response => response.json());
  assert.equal(message.record.from, bridge.welcome.bridge);
  assert.equal((await run.state()).bridges.find(item => item.key === 'fleet.west').instances[0].bridgeId, bridge.welcome.bridge);
});

test('management malformed request URL returns 400 while the hub remains available to management and bridges', async t => {
  const run = await realFixture(t);
  const response = await new Promise((resolveResponse, reject) => {
    let text = '';
    const socket = tcpConnect({ host: '127.0.0.1', port: run.h.port }, () => {
      socket.write(`GET http://[::1/manage HTTP/1.1\r\nHost: 127.0.0.1:${run.h.port}\r\nConnection: close\r\n\r\n`);
    });
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('malformed request received no bounded response')); });
    socket.on('data', chunk => { text += chunk.toString('utf8'); });
    socket.once('error', reject); socket.once('end', () => resolveResponse(text));
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.ok(response.includes('"code":"REQUEST_URL_INVALID"'), 'the URL failure must be a controlled HTTP response');
  assert.equal(run.h.hub.exitCode, null, 'a socket response alone cannot prove that the hub survived');
  assert.equal((await run.state()).hub.hubId, 'local-hub');
  const source = await run.connect('source'), reader = await run.connect('reader');
  const deliveries = []; reader.on('delivery', frame => deliveries.push(frame)); await reader.subscribe(['stream/#'], { from: 0 });
  const receipt = await source.publishConfirmed('stream/after-malformed-url', { hubStillAvailable: true });
  await until(() => deliveries.some(frame => frame.seq === receipt.seq));
  assert.deepEqual(deliveries[0].body, { hubStillAvailable: true });
});

for (const code of ['ENOENT', 'EACCES']) {
  test(`management page: request-time ${code} returns 500 while bridge traffic continues and the page can recover`, async t => {
    const root = temporary(t);
    const config = normalizeConfig({ acl: acl(), log: { enabled: false, dir: root } }, null);
    const hub = await Hub.create(config);
    const management = await createManagementHttp(hub, config);
    const escapedErrors = [], bridges = [];
    const server = createServer((req, res) => {
      management.handle(req, res, new URL(req.url, 'http://127.0.0.1')).catch(error => {
        // Capture unexpected escapes so a regression fails promptly rather than
        // taking down the test runner or leaving a fetch waiting for a response.
        escapedErrors.push(error); res.destroy();
      });
    });
    const wss = attachWebSocketServer(server, { path: config.transport.path, maxPayload: 4 * 1024 * 1024 });
    wss.on('connection', connection => hub.onConnection(connection));
    const originalReadFile = fsPromises.readFile;
    t.after(async () => {
      fsPromises.readFile = originalReadFile; syncBuiltinESMExports();
      await Promise.all(bridges.map(bridge => bridge.close()));
      wss.closeAll(1001, 'test finished');
      await new Promise(resolveClose => server.close(resolveClose));
      await hub.stop();
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const id of ['source', 'reader']) {
      const bridge = new Bridge({ url: base.replace('http:', 'ws:') + config.transport.path,
        bridgeId: id, token: config.acl.bridges[id].token });
      bridges.push(bridge); await bridge.connect();
    }
    const [source, reader] = bridges, deliveries = [];
    reader.on('delivery', frame => deliveries.push(frame));
    await reader.subscribe(['stream/#'], { from: 0 });
    const before = await source.publishConfirmed('stream/before-page-failure', { stage: 'before' });
    await until(() => deliveries.some(frame => frame.seq === before.seq));

    // Fault only this page read in the isolated test process. No production
    // injection option is added and no workspace HTML is moved or rewritten.
    const pageUrl = new URL('../../src/management/console.html', import.meta.url).href;
    let failing = true, failedReads = 0;
    fsPromises.readFile = async (path, ...args) => {
      if (failing && path instanceof URL && path.href === pageUrl) {
        failedReads++;
        throw Object.assign(new Error(`injected ${code} for the management page`), { code });
      }
      return originalReadFile(path, ...args);
    };
    syncBuiltinESMExports();

    const failure = await fetch(`${base}/manage`, { signal: AbortSignal.timeout(5000) });
    assert.equal(failure.status, 500);
    assert.match(failure.headers.get('content-type'), /^application\/json/);
    assert.equal((await failure.json()).error.code, code);
    assert.equal(failedReads, 1);
    assert.deepEqual(escapedErrors, [], 'the page error must stay inside the HTTP handler');
    const during = await source.publishConfirmed('stream/during-page-failure', { stage: 'during' });
    await until(() => deliveries.some(frame => frame.seq === during.seq));
    const stateResponse = await fetch(`${base}/manage/api/state`);
    assert.equal(stateResponse.status, 200);
    const current = await stateResponse.json();
    assert.equal(current.bridges.filter(bridge => bridge.instances.length).length, 2);
    assert.equal(current.log.protectedCount, 2, 'a page fault must not release or remove messages');
    assert.deepEqual(management.state.value.paused, []);
    assert.equal(source.connected, true); assert.equal(reader.connected, true);

    failing = false;
    const page = await fetch(`${base}/manage`, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /<html(?:\s|>)/i);
    const inspected = await fetch(`${base}/manage/api/message?seq=${during.seq}`).then(response => response.json());
    assert.deepEqual(inspected.record.body, { stage: 'during' });
    const after = await source.publishConfirmed('stream/after-page-recovery', { stage: 'after' });
    await until(() => deliveries.some(frame => frame.seq === after.seq));
    assert.deepEqual(deliveries.map(frame => frame.body.stage), ['before', 'during', 'after']);
    assert.deepEqual(escapedErrors, []);
  });
}
