// The controller only owns lifecycle and checks evidence. Catalog, selection,
// processing and durable output are ordinary independent application programs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';
import { reserveEvidenceRun } from '../../helpers/evidence-run.mjs';
import { until } from '../../helpers/hub-harness.mjs';
import { getProfile, principalFor } from '../../../examples/purpose-demos/profiles.mjs';
import { DEMO_TOKEN } from '../../../examples/purpose-demos/run-demo.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROFILE = 'capability-directory';
const PREFIX = `demo/${PROFILE}`;
const CONTRACT = { id: 'text.statistics', version: '1.0.0' };
const INPUT_TEXT = '世界枢纽\nWorld Hub 🌍\n';
const EXPECTED_OUTPUT = { codePoints: [...INPUT_TEXT].length, lines: INPUT_TEXT.split('\n').length,
  utf8Bytes: Buffer.byteLength(INPUT_TEXT, 'utf8'), sha256: createHash('sha256').update(INPUT_TEXT, 'utf8').digest('hex') };
const options = { timeout: 60000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

function bodyOf(result, expectedPrincipal) {
  assert.ok(result.request.seq > 0);
  assert.equal(result.response.operation, 'response');
  assert.equal(result.response.requestSeq, result.request.seq);
  assert.equal(result.response.fromPrincipal, expectedPrincipal);
  assert.ok(result.response.seq > result.request.seq);
  return result.response.body;
}

async function scene(t, { skip = [], extraCredentials = {}, extraTopics = [], catalogConfig = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-capability-test-'));
  const evidence = await reserveEvidenceRun(join(ROOT, '.artifacts/capability-directory'));
  const profile = getProfile(PROFILE), owned = [], programs = new Map(), bridges = [];
  const checkpoints = [];
  const credentials = { ...Object.fromEntries([...profile.peers.map(peer => peer.id), 'explorer', 'stranger'].map(id => [principalFor(PROFILE, id), {
    token: DEMO_TOKEN, maxConnections: 8, allow: { publish: [`${PREFIX}/#`, ...extraTopics], subscribe: [`${PREFIX}/#`, ...extraTopics] },
  }])), ...extraCredentials };
  const configFile = join(directory, 'hub.json');
  await writeFile(configFile, JSON.stringify({ transport: { host: '127.0.0.1', port: 0, path: '/bridge' },
    log: { dir: join(directory, 'log') }, blobs: { dir: join(directory, 'blobs') },
    management: { stateFile: join(directory, 'management.json') },
    acl: { defaultDeny: true, allowUnlistedBridges: false, credentials, bridges: {} },
  }));
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close('capability test finished')));
    for (const program of [...owned].reverse()) await program.stop();
    for (const program of owned) {
      assert.deepEqual(program.exited, { code: 0, signal: null }, program.stderr);
      assert.equal(alive(program.child.pid), false, `owned pid ${program.child.pid} remains alive`);
    }
    const report = { name: t.name, checkpoints,
      processes: owned.map(program => ({ pid: program.child.pid, ready: program.ready, exit: program.exited, stderr: program.stderr })) };
    await writeFile(join(evidence.directory, 'scene.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    t.diagnostic('ECOSYSTEM_EVIDENCE ' + JSON.stringify({ scene: join(evidence.directory, 'scene.json'),
      checkpoints: checkpoints.length, processes: owned.map(program => ({ pid: program.child.pid, peer: program.ready.peer, exit: program.exited })) }));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('world-hub-capability-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const hub = await startOwnedProgram(join(ROOT, 'examples/distributed-context/hub-process.mjs'),
    { args: ['--config', configFile, '--quiet'], cwd: ROOT });
  owned.push(hub);
  if (catalogConfig) {
    await mkdir(join(directory, 'programs/directory'), { recursive: true });
    await writeFile(join(directory, 'programs/directory/catalog-config.json'), JSON.stringify(catalogConfig));
  }
  async function start(id, entry, cwd = ROOT) {
    const peer = profile.peers.find(value => value.id === id);
    assert.ok(peer, `profile must declare ${id}`);
    const stateDir = join(directory, 'programs', id); await mkdir(stateDir, { recursive: true });
    const script = entry ?? join(ROOT, 'examples/purpose-demos', peer.entryFile ?? 'peer.mjs');
    const program = await startOwnedProgram(script, { args: ['--profile', PROFILE, '--peer', id,
      '--endpoint', hub.ready.endpoint, '--credential', DEMO_TOKEN, '--state-dir', stateDir], cwd });
    owned.push(program); programs.set(id, program); return program;
  }
  for (const peer of profile.peers) if (!skip.includes(peer.id)) await start(peer.id);
  const connect = async (id = 'explorer') => {
    const bridge = new Bridge({ url: hub.ready.endpoint, bridgeId: `ecosystem-test-${id}-${randomUUID().slice(0, 8)}`,
      credential: principalFor(PROFILE, id), token: DEMO_TOKEN });
    bridge.on('error', error => checkpoints.push({ label: 'bridge-diagnostic', code: error.code, message: error.message }));
    bridges.push(bridge); await bridge.connect();
    await bridge.registerChannels(['catalog/query', 'catalog/register', 'compose/run', 'source/read', 'output/read', 'output/commit',
      'provider/metrics-a', 'provider/metrics-b', 'text/statistics'].map(suffix => ({ name: `${PREFIX}/${suffix}`, publish: true, subscribe: true })));
    return bridge;
  };
  const bridge = await connect();
  const call = async (id, suffix, body, caller = bridge) => {
    const principal = principalFor(PROFILE, id);
    return bodyOf(await caller.call({ principal }, `${PREFIX}/${suffix}`, body, { timeoutMs: 15000 }), principal);
  };
  const catalog = async () => call('directory', 'catalog/query', { capability: 'text.statistics' });
  const provider = (id, body) => call(id, `provider/${id}`, body);
  const compose = body => call('composer', 'compose/run', body);
  const sink = () => call('output', 'output/read', { command: 'snapshot' });
  const log = async () => {
    const response = await fetch(new URL('/log?limit=400', hub.ready.managementUrl), { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); return (await response.json()).records.filter(row => row.kind === 'message');
  };
  const discovery = async ids => until(async () => {
    const result = await catalog();
    return ids.every(id => result.entries.some(entry => entry.module.id === id && entry.state === 'lease-valid')) ? result : false;
  }, { timeoutMs: 8000, what: 'live capability advertisements' });
  checkpoints.push({ label: 'independent-programs', hubPid: hub.child.pid, programs: [...programs].map(([id, p]) => ({ id, pid: p.child.pid })),
    scope: 'This controlled fixture deliberately shares its public test token. The actual isolatedCredentials launcher generates independent per-principal credentials.' });
  const pids = owned.map(program => program.child.pid);
  assert.equal(new Set(pids).size, pids.length); assert.ok(pids.every(pid => pid !== process.pid));
  return { directory, profile, hub, owned, programs, bridges, start, connect, call, catalog, provider, compose, sink, log, discovery,
    record: (label, value = {}) => checkpoints.push({ label, ...value }) };
}

function validateReceipts(result) {
  for (const receipt of result.receipts) {
    if (!receipt.response) continue;
    assert.equal(receipt.response.requestSeq, receipt.request.seq);
    assert.equal(receipt.requestSeq, receipt.request.seq);
    assert.equal(receipt.responseSeq, receipt.response.seq);
    assert.ok(receipt.responseSeq > receipt.requestSeq);
    assert.equal(receipt.response.operation, 'response');
  }
}

test('ECOSYSTEM-01 independent processors replace by configuration while source and sink stay unchanged', options, async t => {
  const app = await scene(t); await app.discovery(['metrics-a', 'metrics-b']);
  const sourceFiles = ['composition.mjs'].map(name => join(ROOT, 'examples/capability-directory', name));
  const before = await Promise.all(sourceFiles.map(hash));
  const initialSource = await app.call('source', 'source/read', { command: 'read' });
  assert.equal(initialSource.text, INPUT_TEXT);
  const first = await app.compose({ command: 'run', invocationId: 'replacement-a' });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.status, 'completed');
  assert.deepEqual(first.output, EXPECTED_OUTPUT);
  assert.equal(first.selection.module.id, 'metrics-a'); validateReceipts(first);
  const configured = await app.compose({ command: 'configure', provider: 'metrics-b' });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  const second = await app.compose({ command: 'run', invocationId: 'replacement-b' });
  assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(second.status, 'completed');
  assert.deepEqual(second.output, EXPECTED_OUTPUT);
  assert.equal(second.selection.module.id, 'metrics-b'); validateReceipts(second);
  assert.deepEqual(first.output, second.output, 'same public contract has the same business result for both independent implementations');
  assert.deepEqual(await Promise.all(sourceFiles.map(hash)), before);
  assert.equal((await app.call('source', 'source/read', { command: 'read' })).text, INPUT_TEXT);
  const persisted = JSON.parse(await readFile(join(app.directory, 'programs/composer/composition-config.json'), 'utf8'));
  assert.equal(persisted.provider, 'metrics-b');
  const records = (await app.sink()).records;
  assert.equal(records.length, 2); assert.deepEqual(records.map(row => row.invocationId), ['replacement-a', 'replacement-b']);
  assert.deepEqual(records.map(row => row.output), [first.output, second.output]);
  const repeated = await app.compose({ command: 'run', invocationId: 'replacement-b' });
  assert.equal(repeated.ok, true, JSON.stringify(repeated)); assert.equal(repeated.sink.cached, true);
  assert.equal((await app.sink()).records.length, 2, 'output program applies its persistent idempotency policy');
  for (const [index, text] of ['', 'é e\u0301\r\n🌍'].entries()) {
    assert.equal((await app.call('source', 'source/read', { command: 'set', text })).ok, true);
    const expected = { codePoints: [...text].length, lines: text.split('\n').length, utf8Bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex') };
    for (const provider of ['metrics-a', 'metrics-b']) {
      assert.equal((await app.compose({ command: 'configure', provider })).ok, true);
      const checked = await app.compose({ command: 'run', invocationId: `unicode-${index}-${provider}` });
      assert.equal(checked.ok, true, JSON.stringify(checked)); assert.deepEqual(checked.output, expected);
    }
  }
  app.record('configuration-only-replacement', { sourceHashes: before, first, second, repeated });
});

test('ECOSYSTEM-10 a configurable trusted catalog can return a module without a demo-derived address or topic', options, async t => {
  const principal = 'catalog.vendor', queryTopic = 'vendor/catalog/query';
  const app = await scene(t, { extraTopics: ['vendor/#'], extraCredentials: {
    [principal]: { token: randomUUID(), maxConnections: 1, allow: { publish: ['vendor/#'], subscribe: ['vendor/#'] } },
  } });
  const advertised = (await app.discovery(['metrics-a'])).entries.find(entry => entry.module.id === 'metrics-a');
  const credential = JSON.parse(await readFile(join(app.directory, 'hub.json'), 'utf8')).acl.credentials[principal];
  const directory = new Bridge({ url: app.hub.ready.endpoint, bridgeId: 'vendor.catalog.main', credential: principal, token: credential.token });
  directory.on('error', () => {}); app.bridges.push(directory); await directory.connect();
  let variant = 'normal';
  directory.on('delivery', async message => {
    if (message.operation !== 'request' || !message.topic.startsWith('vendor/catalog/')) return;
    const entry = { ...advertised, expiresAt: Date.now() + 10000, state: 'lease-valid' };
    if (variant === 'missing-expiry') delete entry.expiresAt;
    if (variant === 'invalid-time') entry.registeredAt = 'not-a-time';
    const entries = variant === 'ambiguous' ? [entry, structuredClone(entry)]
      : variant === 'retired-entry' ? [{ ...entry, principal: 'retired.provider', state: 'lease-expired', expiresAt: 0 }, entry]
      : variant === 'bad-topic' ? [{ ...entry, capabilities: [{ ...entry.capabilities[0], topic: 'vendor/+' }] }]
        : [entry];
    const body = { ok: true, kind: 'demo.capability-directory', epoch: 'vendor-catalog', queriedAt: Date.now(), entries };
    if (variant === 'missing-query-time') delete body.queriedAt;
    await directory.respond(message, body);
  });
  await directory.registerChannels([{ name: queryTopic, publish: true, subscribe: true }]);
  await directory.subscribe(['vendor/catalog/+'], { from: 'now', operations: ['request'] });
  for (const invalid of [{ provider: '../escape' }, { directory: { principal, queryTopic: 'vendor/#' } },
    { directory: { principal, queryTopic, extra: true } }]) {
    const refused = await app.compose({ command: 'configure', ...invalid });
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'CONFIG_INVALID');
  }
  const configured = await app.compose({ command: 'configure', directory: { principal, queryTopic } });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  const result = await app.compose({ command: 'run', invocationId: 'configured-catalog' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.output, EXPECTED_OUTPUT);
  assert.equal(result.receipts[0].response.fromPrincipal, principal);
  assert.equal(result.selection.catalogEpoch, 'vendor-catalog');
  await app.programs.get('composer').stop(); await app.start('composer');
  const restored = await app.compose({ command: 'run', invocationId: 'catalog-config-restored' });
  assert.equal(restored.ok, true, JSON.stringify(restored)); assert.deepEqual(restored.config.directory, { principal, queryTopic });
  const baseline = (await app.provider('metrics-a', { command: 'snapshot' })).statistics.requests;
  for (const [selected, code] of [['ambiguous', 'PROVIDER_AMBIGUOUS'], ['bad-topic', 'PROVIDER_ADDRESS_MISMATCH'],
    ['missing-expiry', 'PROVIDER_DESCRIPTOR_INVALID'], ['invalid-time', 'PROVIDER_DESCRIPTOR_INVALID'], ['missing-query-time', 'CATALOG_INVALID']]) {
    variant = selected;
    const refused = await app.compose({ command: 'run', invocationId: `catalog-${selected}` });
    assert.equal(refused.ok, false); assert.equal(refused.error.code, code, JSON.stringify(refused));
  }
  assert.equal((await app.provider('metrics-a', { command: 'snapshot' })).statistics.requests, baseline);
  assert.equal((await app.sink()).records.length, 2);
  variant = 'retired-entry';
  const replaced = await app.compose({ command: 'run', invocationId: 'retired-entry-does-not-block' });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  variant = 'normal';
  assert.equal((await app.compose({ command: 'configure', provider: 'not-registered' })).ok, true);
  for (let index = 0; index < 140; index++) {
    const queryTopic = `vendor/catalog/query-${index}`;
    assert.equal((await app.compose({ command: 'configure', directory: { principal, queryTopic } })).ok, true);
    const unseen = await app.compose({ command: 'run', invocationId: `switch-topic-${index}` });
    assert.equal(unseen.error.code, 'PROVIDER_UNAVAILABLE', JSON.stringify(unseen));
  }
  assert.equal((await app.compose({ command: 'configure', provider: 'metrics-a', directory: { principal, queryTopic } })).ok, true);
  const afterSwitching = await app.compose({ command: 'run', invocationId: 'after-many-topic-switches' });
  assert.equal(afterSwitching.ok, true, JSON.stringify(afterSwitching));
  app.record('configured-catalog-and-address-validation', { configured, result, restored,
    replaced, afterSwitching, changedQueryTopics: 140,
    scope: 'The alternate catalog is a controlled public-SDK bridge, not the independently authored provider.' });
});

test('ECOSYSTEM-02 version mismatch and expired advertisements prevent a processor invocation', options, async t => {
  const app = await scene(t); await app.discovery(['metrics-a', 'metrics-b']);
  const before = await app.provider('metrics-a', { command: 'snapshot' });
  assert.equal((await app.compose({ command: 'configure', contractVersion: '2.0.0' })).ok, true);
  const incompatible = await app.compose({ command: 'run', invocationId: 'bad-version' });
  assert.equal(incompatible.ok, false); assert.equal(incompatible.error.code, 'CONTRACT_MISMATCH');
  assert.equal((await app.provider('metrics-a', { command: 'snapshot' })).statistics.requests, before.statistics.requests);
  assert.equal((await app.sink()).records.length, 0);
  assert.equal((await app.compose({ command: 'configure', contractVersion: '1.0.0' })).ok, true);
  assert.equal((await app.provider('metrics-a', { command: 'configure', announcing: false })).ok, true);
  const expired = await until(async () => {
    const catalog = await app.catalog(); return catalog.entries.find(entry => entry.module.id === 'metrics-a' && entry.state === 'lease-expired');
  }, { timeoutMs: 6000, what: 'provider advertisement lease expiration' });
  const offline = await app.compose({ command: 'run', invocationId: 'expired-provider' });
  assert.equal(offline.ok, false); assert.equal(offline.error.code, 'LEASE_EXPIRED');
  assert.equal((await app.provider('metrics-a', { command: 'snapshot' })).statistics.requests, before.statistics.requests);
  assert.equal((await app.sink()).records.length, 0);
  assert.equal((await app.provider('metrics-a', { command: 'configure', announcing: true })).ok, true);
  await app.discovery(['metrics-a']);
  assert.equal((await app.compose({ command: 'run', invocationId: 'back-online' })).ok, true);
  app.record('external-version-and-lease-policy', { incompatible, expired, offline });
});

test('ECOSYSTEM-03 application refusal and accepted timeout remain distinct from communication completion', options, async t => {
  const app = await scene(t); await app.discovery(['metrics-a']);
  assert.equal((await app.provider('metrics-a', { command: 'configure', allowComposer: false })).ok, true);
  const denied = await app.compose({ command: 'run', invocationId: 'refused' });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'PERMISSION_DENIED'); validateReceipts(denied);
  const refusal = denied.receipts.find(row => row.stage === 'processor');
  assert.ok(refusal.request.seq > 0); assert.equal(refusal.response.body.ok, false);
  assert.equal(refusal.response.body.error.code, 'PERMISSION_DENIED');
  assert.equal((await app.sink()).records.length, 0);
  assert.equal((await app.provider('metrics-a', { command: 'configure', allowComposer: true, delayMs: 900 })).ok, true);
  assert.equal((await app.compose({ command: 'configure', timeoutMs: 150 })).ok, true);
  const timedOut = await app.compose({ command: 'run', invocationId: 'uncertain' });
  assert.equal(timedOut.ok, false); assert.equal(timedOut.status, 'uncertain');
  assert.equal(timedOut.error.code, 'PROCESSOR_TIMEOUT');
  const accepted = timedOut.receipts.find(row => row.stage === 'processor');
  assert.ok(accepted.request.seq > 0); assert.equal(accepted.response ?? null, null);
  const late = await until(async () => (await app.log()).find(row => row.operation === 'response' && row.requestSeq === accepted.request.seq),
    { timeoutMs: 5000, what: 'retained late provider response' });
  assert.equal(late.body.ok, true); assert.equal(late.fromPrincipal, principalFor(PROFILE, 'metrics-a'));
  assert.equal((await app.sink()).records.length, 0, 'late transport response does not secretly commit a business result');
  const retained = await app.log();
  assert.equal(retained.filter(row => row.operation === 'request' && row.seq === accepted.request.seq).length, 1);
  assert.equal(retained.filter(row => row.operation === 'request' && row.body?.invocationId === 'uncertain' && row.topic === `${PREFIX}/text/statistics`).length, 1);
  app.record('communication-is-not-business-success', { denied, timedOut, late });
});

test('ECOSYSTEM-04 catalog rejects untrusted advertisements and module identity impersonation', options, async t => {
  const app = await scene(t); const catalog = await app.discovery(['metrics-a', 'metrics-b']);
  const real = catalog.entries.find(entry => entry.module.id === 'metrics-a');
  const manifest = { manifestVersion: 1, module: real.module, capabilities: real.capabilities, leaseMs: 1800 };
  const stranger = await app.connect('stranger');
  const rejected = await app.call('directory', 'catalog/register', manifest, stranger);
  assert.equal(rejected.ok, false); assert.ok(rejected.error?.code, JSON.stringify(rejected));
  const legitimate = await app.connect('metrics-b');
  const impersonated = await app.call('directory', 'catalog/register', manifest, legitimate);
  assert.equal(impersonated.ok, false); assert.ok(impersonated.error?.code, JSON.stringify(impersonated));
  const after = await app.catalog();
  assert.equal(after.entries.filter(entry => entry.module.id === 'metrics-a').length, 1);
  assert.equal(after.entries.find(entry => entry.module.id === 'metrics-a').principal, principalFor(PROFILE, 'metrics-a'));
  assert.equal(after.entries.find(entry => entry.module.id === 'metrics-a').session, real.session);
  app.record('registration-authenticates-source', { rejected, impersonated, real, after });
});

test('ECOSYSTEM-05 provider and catalog restart renew discovery without replaying stale advertisements', options, async t => {
  const app = await scene(t); const initial = await app.discovery(['metrics-a', 'metrics-b']);
  const firstEntry = initial.entries.find(entry => entry.module.id === 'metrics-a');
  const first = await app.compose({ command: 'run', invocationId: 'before-restart' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const provider = app.programs.get('metrics-a'); await provider.stop();
  assert.equal(alive(provider.child.pid), false);
  await until(async () => (await app.catalog()).entries.find(entry => entry.module.id === 'metrics-a' && entry.state === 'lease-expired'),
    { timeoutMs: 6000, what: 'stopped provider lease expiration' });
  const replacement = await app.start('metrics-a');
  const renewed = await until(async () => {
    const result = await app.catalog(), entry = result.entries.find(value => value.module.id === 'metrics-a');
    return entry?.state === 'lease-valid' && entry.session !== firstEntry.session ? entry : false;
  }, { timeoutMs: 8000, what: 'restarted provider new authenticated session' });
  assert.equal(renewed.principal, firstEntry.principal); assert.notEqual(replacement.child.pid, provider.child.pid);
  const directory = app.programs.get('directory'); await directory.stop();
  for (const id of ['metrics-a', 'metrics-b']) assert.equal((await app.provider(id, { command: 'configure', announcing: false })).ok, true);
  const advertiser = await app.connect('metrics-a');
  const queuedAdvertisement = await advertiser.requestTo({ principal: principalFor(PROFILE, 'directory') }, `${PREFIX}/catalog/register`, {
    manifestVersion: 1, module: renewed.module, capabilities: renewed.capabilities, leaseMs: 1800,
  });
  const restartedDirectory = await app.start('directory');
  const stale = await app.catalog();
  assert.notEqual(stale.epoch, initial.epoch);
  assert.ok(stale.entries.every(entry => entry.state === 'lease-expired'), 'stored descriptors and queued old advertisements do not become fresh leases');
  for (const id of ['metrics-a', 'metrics-b']) assert.equal((await app.provider(id, { command: 'configure', announcing: true })).ok, true);
  const recovered = await until(async () => {
    const result = await app.catalog(); return result.epoch !== initial.epoch && result.entries.length === 2
      && result.entries.every(entry => entry.state === 'lease-valid') ? result : false;
  }, { timeoutMs: 8000, what: 'new catalog epoch with live reannouncements' });
  assert.notEqual(restartedDirectory.child.pid, directory.child.pid);
  assert.ok(recovered.entries.every(entry => entry.registeredAt > renewed.registeredAt));
  const second = await app.compose({ command: 'run', invocationId: 'after-restart' });
  assert.equal(second.ok, true, JSON.stringify(second)); assert.deepEqual(second.output, first.output);
  assert.equal((await app.sink()).records.length, 2);
  app.record('external-program-recovery', { firstEntry, renewed, oldEpoch: initial.epoch, queuedAdvertisement, stale, catalog: recovered, second });
});

test('ECOSYSTEM-06 isolated processor requires only its public contract and the exported SDK implementation', options, async t => {
  const app = await scene(t, { skip: ['metrics-b'] });
  const isolated = join(app.directory, 'independent-checkout');
  const files = ['examples/capability-directory/processor-b.mjs', 'examples/capability-directory/contract.json',
    'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs'];
  for (const file of files) { const target = join(isolated, file); await mkdir(dirname(target), { recursive: true }); await copyFile(join(ROOT, file), target); }
  assert.deepEqual((await readdir(isolated)).sort(), ['examples', 'sdk']);
  const standalone = await app.start('metrics-b', join(isolated, files[0]), isolated);
  const catalog = await app.discovery(['metrics-a', 'metrics-b']);
  assert.equal((await app.compose({ command: 'configure', provider: 'metrics-b' })).ok, true);
  const result = await app.compose({ command: 'run', invocationId: 'independent-sdk-contract' });
  assert.equal(result.ok, true, JSON.stringify(result)); validateReceipts(result);
  assert.deepEqual(result.output, EXPECTED_OUTPUT);
  assert.equal(result.selection.module.id, 'metrics-b');
  assert.equal(result.selection.principal, principalFor(PROFILE, 'metrics-b'));
  assert.equal((await app.sink()).records.length, 1);
  app.record('isolated-implementation-contract-check', { files, pid: standalone.child.pid, catalog, result,
    scope: 'Separate implementation and isolated imports; this does not claim independent third-party developer acceptance.' });
});

test('ECOSYSTEM-07 matching JSON shape with incompatible semantics is rejected before processing', options, async t => {
  const app = await scene(t); const catalog = await app.discovery(['metrics-a']);
  assert.equal((await app.provider('metrics-a', { command: 'configure', announcing: false })).ok, true);
  const real = catalog.entries.find(entry => entry.module.id === 'metrics-a');
  const capabilities = structuredClone(real.capabilities);
  capabilities[0].semantics = 'normalized-unicode-v2';
  const alternate = await app.connect('metrics-a');
  const advertised = await app.call('directory', 'catalog/register', {
    manifestVersion: 1, module: real.module, capabilities, leaseMs: 1800,
  }, alternate);
  assert.equal(advertised.ok, true, JSON.stringify(advertised));
  assert.equal(advertised.entry.principal, principalFor(PROFILE, 'metrics-a'));
  assert.equal(advertised.entry.session, alternate.welcome.session, 'directory binds the actual source session');
  const before = await app.provider('metrics-a', { command: 'snapshot' });
  const result = await app.compose({ command: 'run', invocationId: 'semantic-mismatch' });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'CONTRACT_MISMATCH');
  assert.equal((await app.provider('metrics-a', { command: 'snapshot' })).statistics.requests, before.statistics.requests);
  assert.equal((await app.sink()).records.length, 0);
  app.record('schema-shape-does-not-establish-semantics', { advertised, result });
});

test('ECOSYSTEM-08 sink authority, contract validation and persistent duplicate policy belong to the external application', options, async t => {
  const app = await scene(t); await app.discovery(['metrics-a']);
  const first = await app.compose({ command: 'run', invocationId: 'durable-output' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const firstRecord = (await app.sink()).records[0];
  const payload = { invocationId: firstRecord.invocationId, contract: CONTRACT, output: firstRecord.output, processor: firstRecord.processor };
  const denied = await app.call('output', 'output/commit', payload);
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'PERMISSION_DENIED');
  const trusted = await app.connect('composer');
  const invalid = await app.call('output', 'output/commit', {
    ...payload, invocationId: 'invalid-output', output: { ...payload.output, utf8Bytes: 16385 },
  }, trusted);
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'OUTPUT_INVALID');
  for (const id of ['metrics-a', 'metrics-b']) {
    const refusedInput = await app.call(id, 'text/statistics', { contract: CONTRACT, invocationId: `invalid-${id}`, text: '\ud800' }, trusted);
    assert.equal(refusedInput.ok, false); assert.equal(refusedInput.status, 'failed'); assert.equal(refusedInput.error.code, 'INPUT_INVALID');
  }
  const beforeRestart = await app.provider('metrics-a', { command: 'snapshot' });
  const oldSink = app.programs.get('output'); await oldSink.stop(); const newSink = await app.start('output');
  assert.notEqual(newSink.child.pid, oldSink.child.pid);
  const repeated = await app.compose({ command: 'run', invocationId: 'durable-output' });
  assert.equal(repeated.ok, true, JSON.stringify(repeated)); assert.equal(repeated.sink.cached, true);
  assert.equal((await app.provider('metrics-a', { command: 'snapshot' })).statistics.executions, beforeRestart.statistics.executions + 1,
    'the sink deduplicates result commits; this is not exactly-once processor execution');
  assert.deepEqual((await app.sink()).records, [firstRecord]);
  assert.equal((await app.call('source', 'source/read', { command: 'set', text: 'different input' })).ok, true);
  const conflict = await app.compose({ command: 'run', invocationId: 'durable-output' });
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual((await app.sink()).records, [firstRecord]);
  app.record('external-output-policy-and-restart', { denied, invalid, repeated, conflict, record: firstRecord });
});

test('ECOSYSTEM-09 an authenticated provider response still has to satisfy the complete public result contract', options, async t => {
  const app = await scene(t); const catalog = await app.discovery(['metrics-a']);
  const descriptor = catalog.entries.find(entry => entry.module.id === 'metrics-a');
  await app.programs.get('metrics-a').stop();
  // Replace the real provider with a controlled SDK bridge using its configured
  // fixture identity. Every malformed body travels through actual Hub requests
  // and authenticated responses; the test never invokes an internal validator.
  const replacement = await app.connect('metrics-a');
  assert.notEqual(replacement.welcome.session, descriptor.session);
  let variant;
  const observed = [];
  replacement.on('delivery', async message => {
    if (message.operation !== 'request' || message.topic !== `${PREFIX}/text/statistics`) return;
    const complete = { ok: true, kind: 'demo.capability-result', contract: CONTRACT,
      invocationId: message.body.invocationId, status: 'completed', provider: 'metrics-a', executionId: randomUUID(), output: EXPECTED_OUTPUT };
    let response;
    if (variant === 'missing-execution') { const { executionId, ...incomplete } = complete; response = incomplete; }
    else if (variant === 'invalid-execution') response = { ...complete, executionId: 'no-execution-id' };
    else if (variant === 'extra-field') response = { ...complete, unexpected: true };
    else if (variant === 'incomplete-failure') response = { ok: false, status: 'failed', error: { code: 'PERMISSION_DENIED', message: 'An incomplete body must not be mistaken for a business refusal.' } };
    else {
      response = { ok: false, kind: 'demo.capability-result', contract: CONTRACT, invocationId: message.body.invocationId,
        status: 'failed', provider: 'metrics-a', error: { code: 'PERMISSION_DENIED', message: 'Explicit business refusal.', retryable: false } };
      if (variant === 'wrong-failure-invocation') response.invocationId = 'a-different-request';
    }
    const receipt = await replacement.respond(message, response);
    observed.push({ variant, request: message, response, receipt });
  });
  await replacement.subscribe([`${PREFIX}/text/statistics`], { from: 'now', operations: ['request'] });
  const registered = await app.call('directory', 'catalog/register', { manifestVersion: 1, module: descriptor.module,
    capabilities: descriptor.capabilities, leaseMs: 10000 }, replacement);
  assert.equal(registered.ok, true, JSON.stringify(registered));
  assert.equal(registered.entry.session, replacement.welcome.session);
  for (const malformed of ['missing-execution', 'invalid-execution', 'extra-field', 'incomplete-failure', 'wrong-failure-invocation']) {
    variant = malformed;
    const result = await app.compose({ command: 'run', invocationId: `malformed-${malformed}` });
    assert.equal(result.ok, false); assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'RESULT_INVALID', JSON.stringify(result)); validateReceipts(result);
    const processed = result.receipts.find(receipt => receipt.stage === 'processor');
    assert.ok(processed.request.seq > 0); assert.ok(processed.response.seq > processed.request.seq);
    assert.equal(processed.response.senderSession, replacement.welcome.session);
    assert.equal((await app.sink()).records.length, 0, 'authenticated delivery cannot bypass the consumer result contract');
  }
  variant = 'complete-refusal';
  const refused = await app.compose({ command: 'run', invocationId: 'complete-business-refusal' });
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'PERMISSION_DENIED');
  assert.equal((await app.sink()).records.length, 0);
  assert.equal(observed.length, 6);
  app.record('trusted-identity-does-not-prove-valid-business-result', { registered, observed, refused,
    scope: 'The controlled replacement is an SDK bridge in the test process, not another independently implemented demonstration program.' });
});

test('ECOSYSTEM-11 a docs-only AI author implements a new provider without existing application code', options, async t => {
  const authorship = JSON.parse(await readFile(join(ROOT, 'tests/fixtures/independent-provider/authorship.json'), 'utf8'));
  assert.equal(await hash(join(ROOT, 'tests/fixtures/independent-provider/provider.mjs')), authorship.implementationSha256,
    'The independently authored implementation must remain the artifact recorded in its provenance');
  const principal = 'vendor.acme', moduleId = 'vendor-stats', businessTopic = 'vendor/statistics/v1';
  const token = randomUUID();
  const app = await scene(t, { skip: ['metrics-a', 'metrics-b'], extraTopics: ['vendor/#'],
    extraCredentials: { [principal]: { token, maxConnections: 1,
      allow: { publish: [`${PREFIX}/catalog/register`, businessTopic], subscribe: [`${PREFIX}/catalog/register`, businessTopic] } } },
    catalogConfig: { providers: { [principal]: moduleId }, topicPrefixes: ['vendor/'] },
  });
  const before = await hash(join(ROOT, 'examples/capability-directory/composition.mjs'));
  const isolated = join(app.directory, 'docs-only-provider'); await mkdir(isolated, { recursive: true });
  const packageFiles = ['package.json', 'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs'];
  for (const file of packageFiles) {
    const target = join(isolated, 'node_modules/world-hub', file); await mkdir(dirname(target), { recursive: true });
    await copyFile(join(ROOT, file), target);
  }
  await copyFile(join(ROOT, 'tests/fixtures/independent-provider/provider.mjs'), join(isolated, 'provider.mjs'));
  await copyFile(join(ROOT, 'docs/modules/text-statistics.contract.json'), join(isolated, 'contract.json'));
  const wiring = { endpoint: app.hub.ready.endpoint, bridgeId: 'vendor.stats.mod', credential: principal, token, principal,
    moduleId, moduleVersion: '1.0.0', businessTopic, allowedCallers: [principalFor(PROFILE, 'composer')],
    directory: { principal: principalFor(PROFILE, 'directory'), registerTopic: `${PREFIX}/catalog/register`, queryTopic: `${PREFIX}/catalog/query` },
    leaseMs: 1800, renewEveryMs: 600, contractPath: 'contract.json', cursorFile: 'state/cursor.json',
  };
  const configPath = join(isolated, 'wiring.json'); await writeFile(configPath, JSON.stringify(wiring));
  const start = async () => {
    const program = await startOwnedProgram(join(isolated, 'provider.mjs'), { args: ['--config', configPath], cwd: isolated });
    app.owned.push(program); return program;
  };
  const provider = await start();
  const catalog = await app.discovery([moduleId]); const entry = catalog.entries.find(row => row.module.id === moduleId);
  assert.equal(entry.principal, principal); assert.equal(entry.capabilities[0].topic, businessTopic);
  assert.equal((await app.compose({ command: 'configure', provider: moduleId })).ok, true);
  const result = await app.compose({ command: 'run', invocationId: 'docs-only-first' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.output, EXPECTED_OUTPUT); validateReceipts(result);
  assert.equal(result.selection.module.id, moduleId); assert.equal(result.selection.principal, principal);
  assert.equal(result.receipts.find(row => row.stage === 'processor').response.topic, businessTopic);
  assert.equal((await app.sink()).records[0].processor.module.id, moduleId);
  const caller = await app.connect('composer');
  await caller.registerChannels([{ name: businessTopic, publish: true, subscribe: true }]);
  const invoke = async (body, bridge = caller) => bodyOf(await bridge.call({ principal, session: entry.session }, businessTopic, body,
    { timeoutMs: 5000 }), principal);
  const verified = [];
  for (const [index, text] of ['', 'é e\u0301\r\n🌍', 'a'.repeat(16384), '界'.repeat(5461) + 'a'].entries()) {
    const invocationId = index === 0 ? '🌍'.repeat(256) : `docs-edge-${index}`;
    const answer = await invoke({ contract: CONTRACT, invocationId, text });
    assert.equal(answer.ok, true, JSON.stringify(answer)); assert.equal(answer.provider, moduleId); assert.equal(answer.invocationId, invocationId);
    assert.deepEqual(Object.keys(answer).sort(), ['ok', 'kind', 'contract', 'invocationId', 'status', 'provider', 'executionId', 'output'].sort());
    assert.match(answer.executionId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    assert.deepEqual(answer.output, { codePoints: [...text].length, lines: text.split('\n').length, utf8Bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex') });
    verified.push({ name: `valid-${index}`, invocationCodePoints: [...invocationId].length, output: answer.output });
  }
  for (const [body, code] of [
    [{ contract: CONTRACT, invocationId: 'invalid-surrogate', text: '\ud800' }, 'INPUT_INVALID'],
    [{ contract: CONTRACT, invocationId: 'too-many-bytes', text: '界'.repeat(5462) }, 'INPUT_INVALID'],
    [{ contract: CONTRACT, invocationId: '🌍'.repeat(257), text: '' }, 'INPUT_INVALID'],
    [{ contract: CONTRACT, invocationId: '', text: '' }, 'INPUT_INVALID'],
    [{ contract: CONTRACT, invocationId: 'extra-field', text: '', additional: true }, 'INPUT_INVALID'],
    [{ contract: { ...CONTRACT, additional: true }, invocationId: 'extra-contract-field', text: '' }, 'INPUT_INVALID'],
    [{ contract: { ...CONTRACT, version: '2.0.0' }, invocationId: 'wrong-version', text: '' }, 'CONTRACT_MISMATCH'],
  ]) {
    const answer = await invoke(body); assert.equal(answer.ok, false); assert.equal(answer.status, 'failed');
    assert.equal(answer.error.code, code); assert.equal(answer.provider, moduleId); assert.equal(answer.error.retryable, false);
    assert.deepEqual(answer.contract, CONTRACT);
    assert.deepEqual(Object.keys(answer).sort(), ['ok', 'kind', 'contract', 'invocationId', 'status', 'provider', 'error'].sort());
    assert.deepEqual(Object.keys(answer.error).sort(), ['code', 'message', 'retryable']);
    assert.equal(answer.invocationId, [...body.invocationId].length > 256 ? '' : body.invocationId);
    verified.push({ name: body.invocationId.length > 256 ? 'id-over-limit' : body.invocationId, error: answer.error });
  }
  const explorer = await app.connect('explorer'); await explorer.registerChannels([{ name: businessTopic, publish: true, subscribe: true }]);
  const denied = await invoke({ contract: CONTRACT, invocationId: 'body-cannot-authorize', text: '',
    fromPrincipal: principalFor(PROFILE, 'composer') }, explorer);
  assert.equal(denied.error.code, 'PERMISSION_DENIED'); assert.equal(denied.provider, moduleId);
  assert.equal((await app.compose({ command: 'configure', contractVersion: '2.0.0' })).ok, true);
  const mismatch = await app.compose({ command: 'run', invocationId: 'docs-version-rejected' });
  assert.equal(mismatch.error.code, 'CONTRACT_MISMATCH'); assert.ok(mismatch.receipts.every(row => row.stage !== 'processor'));
  assert.equal((await app.compose({ command: 'configure', contractVersion: '1.0.0' })).ok, true);
  await provider.stop();
  await until(async () => (await app.catalog()).entries.find(row => row.module.id === moduleId && row.state === 'lease-expired'),
    { timeoutMs: 6000, what: 'docs-only provider lease expiry' });
  const expired = await app.compose({ command: 'run', invocationId: 'docs-lease-expired' }); assert.equal(expired.error.code, 'LEASE_EXPIRED');
  const restarted = await start();
  const renewed = await until(async () => {
    const entry = (await app.catalog()).entries.find(row => row.module.id === moduleId);
    return entry?.state === 'lease-valid' && entry.session !== catalog.entries[0].session ? entry : false;
  }, { timeoutMs: 6000, what: 'docs-only provider new session advertisement' });
  assert.notEqual(restarted.child.pid, provider.child.pid); assert.notEqual(renewed.session, entry.session);
  await app.programs.get('directory').stop(); await app.start('directory');
  const recovered = await until(async () => {
    const listed = await app.catalog(); return listed.epoch !== catalog.epoch
      && listed.entries.some(row => row.module.id === moduleId && row.state === 'lease-valid') ? listed : false;
  }, { timeoutMs: 6000, what: 'docs-only provider re-registers with restarted catalog' });
  const again = await app.compose({ command: 'run', invocationId: 'docs-only-recovered' });
  assert.equal(again.ok, true, JSON.stringify(again)); assert.deepEqual(again.output, EXPECTED_OUTPUT);
  assert.equal((await app.sink()).records.length, 2); assert.equal(await hash(join(ROOT, 'examples/capability-directory/composition.mjs')), before);
  assert.deepEqual((await readdir(join(isolated, 'node_modules/world-hub'))).sort(), ['package.json', 'sdk']);
  app.record('docs-only-new-module-through-public-sdk', { authorship, moduleId, principal, businessTopic, packageFiles, result, verified, denied,
    mismatch, expired, renewed, recovered, again,
    scope: 'A separate AI author received only frozen public provider/SDK documentation and the machine contract. This is not a human third-party acceptance claim.' });
});
