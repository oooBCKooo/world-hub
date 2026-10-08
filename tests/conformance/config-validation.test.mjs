import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, loadConfig, DEFAULT_LOG } from '../../src/hub/lib/store.mjs';
import { Acl } from '../../src/hub/lib/acl.mjs';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { until } from '../helpers/hub-harness.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const processes = [];
const evidence = process.env.PHASE10_CONFIG_EVIDENCE;
const secret = 'config-validation-test-token';

after(async () => {
  if (!evidence) return;
  const files = ['src/hub/lib/store.mjs', 'tests/conformance/config-validation.test.mjs'];
  const source = await Promise.all(files.map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex') })));
  await writeFile(join(resolve(evidence), 'validation-process-report.json'), JSON.stringify({
    at: new Date().toISOString(), node: process.version, source, processes,
    note: 'CLI exit and TAP assertions are recorded separately; these are owned test-process receipts.' }, null, 2) + '\n', { flag: 'wx' });
});

async function temporary(t, { cleanup = true } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'hub-config-validation-'));
  if (cleanup) t.after(async () => {
    assert.equal(dirname(resolve(path)), resolve(tmpdir()));
    assert.ok(basename(path).startsWith('hub-config-validation-'));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

async function inventory(root) {
  const result = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) { result.push({ path: path + '/', directory: true }); await visit(join(directory, entry.name), path + '/'); }
      else result.push({ path, sha256: createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex') });
    }
  }
  await visit(root); return result.sort((a, b) => a.path.localeCompare(b.path));
}

function execute(argv) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { pid: child.pid, argv, stdout: '', stderr: '', exit: null, forced: false }; processes.push(record);
    const timer = setTimeout(() => { record.forced = true; child.kill(); }, 8000);
    child.stdout.on('data', data => { record.stdout += data; });
    child.stderr.on('data', data => { record.stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); record.exit = { code, signal };
      if (record.forced) reject(new Error('owned config-check process exceeded 8s')); else accept(record); });
  });
}

function rawAcl(namespace, entry) { return { acl: { [namespace]: { probe: entry } } }; }

test('invalid log rotation targets are rejected during normalization, including memory-only logging', () => {
  for (const field of ['segmentMaxBytes', 'segmentMaxCount']) {
    for (const value of [0, -1, 0.5, '8', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      for (const enabled of [true, false]) assert.throws(() => normalizeConfig({ log: { enabled, [field]: value } }), error => error.message.includes(`log.${field}`));
    }
  }
  assert.throws(() => normalizeConfig({ log: { enabled: 'false' } }), /log.enabled/);
  assert.deepEqual(normalizeConfig({}).log, { ...DEFAULT_LOG, dir: resolve(ROOT, DEFAULT_LOG.dir) });
  assert.equal(normalizeConfig({ log: { segmentMaxBytes: 1, segmentMaxCount: 1 } }).log.segmentMaxBytes, 1);
});

test('ACL maps, entries and allow lists must have the configured communications shape', () => {
  for (const value of [null, false, 1, 'text', []]) {
    assert.throws(() => normalizeConfig({ acl: value }), /acl must be/);
    assert.throws(() => normalizeConfig({ log: value }), /log must be/);
    for (const namespace of ['bridges', 'credentials']) {
      assert.throws(() => normalizeConfig({ acl: { [namespace]: value } }), error => error.message.includes(`acl.${namespace}`));
      assert.throws(() => normalizeConfig(rawAcl(namespace, value)), error => error.message.includes(`acl.${namespace}.probe`));
      assert.throws(() => normalizeConfig(rawAcl(namespace, { allow: value })), error => error.message.includes('.allow'));
      for (const operation of ['publish', 'subscribe']) {
        // An empty rules array is valid and denies that operation.
        if (Array.isArray(value)) continue;
        assert.throws(() => normalizeConfig(rawAcl(namespace, { allow: { [operation]: value } })), error => error.message.includes(`.allow.${operation}`));
      }
    }
  }
});

test('malformed ACL wildcards cannot become broad authorization or a runtime method error', () => {
  const invalid = ['#/private', 'private/#/more', 'private/a+', 'private/+b', 'private//data', '', 'x'.repeat(513), 7, null, {}];
  for (const namespace of ['bridges', 'credentials']) {
    for (const operation of ['publish', 'subscribe']) {
      for (const filter of invalid) assert.throws(() => normalizeConfig(rawAcl(namespace, { allow: { [operation]: [filter] } })), error => error.message.includes(`.allow.${operation}[0]`));
    }
  }
});

test('token types and explicit credential connection quotas fail visibly without printing secrets', () => {
  for (const namespace of ['bridges', 'credentials']) {
    for (const token of [1, true, [], { private: secret }]) assert.throws(() => normalizeConfig(rawAcl(namespace, { token })), error => error.message.includes('.token') && !error.message.includes(secret));
    for (const token of [undefined, null, '', secret]) assert.equal(normalizeConfig(rawAcl(namespace, { token })).acl[namespace].probe.token, token ?? null);
  }
  for (const maxConnections of [0, -1, 0.5, '4', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeConfig(rawAcl('credentials', { maxConnections })), /maxConnections/);
  }
  assert.equal(normalizeConfig(rawAcl('credentials', {})).acl.credentials.probe.maxConnections, 1);
});

test('valid ACL filters, conservative defaults and unknown program fields retain their meanings', () => {
  const body = { possibleBusiness: { allow: 'opaque', segmentMaxCount: 0 }, kind: 'anything/new' };
  const config = normalizeConfig({ ...body, log: { customProgramData: body }, acl: {
    bridges: { probe: { program: body, allow: { publish: ['private/+', 'exact/topic'], subscribe: ['private/#'], unknownProgramField: body } }, empty: {} },
    credentials: { fleet: { maxConnections: 3, token: secret, allow: { publish: ['#'], subscribe: ['private/+/data'] } } },
  } });
  const acl = new Acl(config);
  assert.equal(acl.canPublish('probe', 'private/data').ok, true);
  assert.equal(acl.canPublish('probe', 'private/deeper/data').ok, false);
  assert.equal(acl.canPublish('probe', 'unrelated/confidential').ok, false);
  assert.equal(acl.canSubscribe('probe', 'private/+/data').ok, true);
  assert.equal(acl.canSubscribe('probe', '#').ok, false);
  assert.equal(acl.canPublish('empty', 'private/data').ok, false);
  assert.equal(acl.canPublish('unlisted', 'private/data').ok, false);
  assert.deepEqual(config.acl.bridges.probe.allow.publish, ['private/+', 'exact/topic']);
  assert.equal(config.acl.defaultDeny, true); assert.equal(config.acl.allowUnlistedBridges, false);
  assert.equal(config.acl.credentials.fleet.maxConnections, 3);
});

test('loadConfig validates bad ACL and log files before creating any persistent data', async t => {
  const directory = await temporary(t), path = join(directory, 'hub.json');
  for (const bad of [{ log: { segmentMaxCount: 0 } }, rawAcl('bridges', { allow: { publish: ['#/private'] } })]) {
    await writeFile(path, JSON.stringify({ ...bad, management: { stateFile: './never-created/manage.json' } }));
    const before = await inventory(directory);
    assert.throws(() => loadConfig(path));
    assert.deepEqual(await inventory(directory), before);
  }
});

test('real launcher --check rejects typed bad config with exit 2 and no writes; original entry also rejects before ready', async t => {
  const directory = await temporary(t), path = join(directory, 'hub.json');
  for (const bad of [{ log: { segmentMaxBytes: 0 } }, rawAcl('credentials', { allow: { subscribe: 'private/#' } })]) {
    const config = { ...bad, log: { dir: './never-created/log', ...bad.log }, blobs: { dir: './never-created/blobs' }, management: { stateFile: './never-created/manage.json' } };
    await writeFile(path, JSON.stringify(config));
    const before = await inventory(directory);
    const checked = await execute([join(ROOT, 'scripts/launcher.mjs'), '--check', '--config', path]);
    assert.equal(checked.exit.code, 2, checked.stderr); assert.equal(checked.exit.signal, null);
    assert.match(checked.stderr, /log.segmentMaxBytes|allow.subscribe/); assert.ok(!checked.stdout.includes('ready'));
    const original = await execute([join(ROOT, 'src/hub/hub-server.mjs'), '--config', path, '--port', '0']);
    assert.equal(original.exit.code, 1); assert.equal(original.exit.signal, null);
    assert.match(original.stderr, /log.segmentMaxBytes|allow.subscribe/); assert.ok(!original.stdout.includes('ready'));
    assert.deepEqual(await inventory(directory), before, 'both entrypoints reject before data or locks appear');
  }
});

test('valid file config still governs real publishing, subscriptions and management without exposing tokens', async t => {
  const directory = await temporary(t, { cleanup: false }), path = join(directory, 'hub.json');
  await writeFile(path, JSON.stringify({ log: { dir: './log', segmentMaxBytes: 4096, segmentMaxCount: 2 },
    blobs: { dir: './blobs' }, management: { stateFile: './management.json' },
    acl: { bridges: { source: { token: secret, allow: { publish: ['neutral/+/data'], subscribe: [] } } },
      credentials: { readers: { token: secret, maxConnections: 2, allow: { publish: [], subscribe: ['neutral/#'] } } } } }));
  const child = fork(join(ROOT, 'examples/distributed-context/hub-process.mjs'), ['--config', path, '--port', '0'],
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const record = { pid: child.pid, purpose: 'actual valid configuration Hub', stdout: '', stderr: '', exit: null, forced: false }; processes.push(record);
  const exited = new Promise(done => child.once('exit', (code, signal) => { record.exit = { code, signal }; done(record.exit); }));
  const clients = [];
  t.after(async () => {
    try {
      await Promise.all(clients.map(bridge => bridge.close()));
      if (!record.exit) {
        const timer = setTimeout(() => { record.forced = true; child.kill(); }, 7000);
        if (child.connected) child.send({ type: 'stop' }); else child.kill();
        await exited; clearTimeout(timer);
      }
      assert.equal(record.forced, false, 'Hub stops via owned IPC');
      assert.equal(record.exit?.code, 0); assert.equal(record.exit?.signal, null);
      assert.ok(record.stdout.includes('"event":"stopped"'));
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('hub-config-validation-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const ready = await new Promise((accept, reject) => {
    let pending = ''; const timer = setTimeout(() => reject(new Error('valid Hub ready timeout')), 8000);
    child.stdout.on('data', data => { record.stdout += data; pending += data;
      let newline; while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'ready') { clearTimeout(timer); accept(event); }
      }
    });
    child.stderr.on('data', data => { record.stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(record.stderr)); });
  });
  record.port = ready.port;
  const make = options => { const bridge = new Bridge({ url: `ws://127.0.0.1:${ready.port}/bridge`, token: secret, autoAck: false, reconnectMs: 0, ...options }); bridge.on('error', () => {}); clients.push(bridge); return bridge; };
  const source = make({ bridgeId: 'source' }), reader = make({ bridgeId: 'reader-instance', credential: 'readers' });
  await source.connect(); const welcome = await reader.connect(); assert.equal(welcome.principal, 'readers');
  const deliveries = []; reader.on('delivery', frame => deliveries.push(frame));
  await reader.subscribe(['neutral/#'], { from: 0 });
  const body = { kind: 'unregistered-business-kind', context: { system: 'opaque', user: ['任意文本'] } };
  const accepted = await source.publishConfirmed('neutral/one/data', body);
  await until(() => deliveries.some(frame => frame.seq === accepted.seq));
  assert.deepEqual(deliveries[0].body, body);
  await assert.rejects(source.publishConfirmed('private/data', body), { code: 'PUBLISH_DENIED' });
  await assert.rejects(reader.subscribe(['#']), { code: 'SUBSCRIBE_DENIED' });
  const response = await fetch(`http://127.0.0.1:${ready.port}/manage/api/state`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); const state = await response.json();
  assert.deepEqual(state.bridges.find(entry => entry.key === 'source').allow, { publish: ['neutral/+/data'], subscribe: [] });
  assert.deepEqual(state.bridges.find(entry => entry.key === 'readers').allow, { publish: [], subscribe: ['neutral/#'] });
  assert.equal(state.hub.storage.log.protectedCount, 1, 'reading does not release the provider message');
  assert.ok(!JSON.stringify(state).includes(secret));
});
