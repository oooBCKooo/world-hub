import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createLock, inspectPackage, importPackage, startInstance, statusInstance, stopInstance,
  logsInstance, exportInstance } from '../../../scripts/runtime/runtime.mjs';
import { reserveEvidenceRun } from '../../helpers/evidence-run.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SAMPLE = join(ROOT, 'examples/ecosystem-pack');
const PYTHON = process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? 'C:/Python314/python.exe';
const runFile = promisify(execFile);
const environment = { nodePath: process.execPath, pythonPath: PYTHON };
const options = { timeout: 90000, concurrency: false };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const expected = text => ({ codePoints: [...text].length, lines: text.split('\n').length,
  utf8Bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) });

async function until(fn, { timeoutMs = 12000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; }
    catch (error) { last = error; }
    await pause(80);
  }
  throw new Error(`Timed out waiting for ${label}${last ? ': ' + last.message : ''}`);
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-runtime-test-'));
  const evidence = await reserveEvidenceRun(join(ROOT, '.artifacts/ecosystem-runtime'));
  const sessions = [], checkpoints = [], trackedPids = new Set(), cleanups = [];
  t.after(async () => {
    for (const cleanup of [...cleanups].reverse()) await cleanup();
    for (const session of [...sessions].reverse()) await session.close();
    for (const pid of trackedPids) assert.equal(alive(pid), false, `Owned runtime process ${pid} survived cleanup`);
    await save(join(evidence.directory, 'scene.json'), { name: t.name, checkpoints,
      processes: [...trackedPids].map(pid => ({ pid, aliveAfterCleanup: alive(pid) })) });
    t.diagnostic('RUNTIME_EVIDENCE ' + JSON.stringify({ report: join(evidence.directory, 'scene.json'), checkpoints: checkpoints.length }));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('world-hub-runtime-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'instances-root');
  const observePids = status => {
    if (status.hub?.pid) trackedPids.add(status.hub.pid);
    for (const component of status.components ?? []) if (component.pid) trackedPids.add(component.pid);
    return status;
  };
  const record = (label, details = {}) => checkpoints.push({ label, ...details });
  const start = async (instanceId, digest, extra = {}) => {
    try {
      const session = await startInstance({ root, instanceId, trust: digest, ...environment, ...extra });
      sessions.push(session); observePids(await session.status()); return session;
    } catch (error) {
      await statusInstance({ root, instanceId }).then(observePids).catch(() => {});
      for (const observed of await observations(join(root, 'instances', instanceId)).catch(() => [])) trackedPids.add(observed.pid);
      throw error;
    }
  };
  const status = async instanceId => observePids(await statusInstance({ root, instanceId }));
  return { directory, root, sessions, cleanups, record, trackedPids, observePids, start, status };
}

async function fixturePackage(app, { mode = 'normal', bridges = ['main'], extra = {} } = {}) {
  const directory = join(app.directory, 'package-' + randomUUID());
  const source = join(directory, 'modules/fixture');
  await mkdir(join(source, 'sdk'), { recursive: true });
  await copyFile(join(ROOT, 'tests/integration/ecosystem-runtime/fixtures/program.mjs'), join(source, 'program.mjs'));
  for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(ROOT, 'sdk/javascript', file), join(source, 'sdk', file));
  await save(join(source, 'package.json'), { imports: { '#bridge': './sdk/bridge-kit.mjs' } });
  await save(join(source, 'module.json'), { format: 'world-hub.module/v1', id: 'test.fixture', version: '1.0.0', license: 'MIT',
    platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges,
    provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback', 'loopback-listen'], processes: 'none' } });
  await save(join(directory, 'pack.json'), { format: 'world-hub.pack/v1', id: 'test.runtime', version: '1.0.0', title: 'Runtime acceptance fixture', license: 'MIT',
    topics: { input: 'acceptance/input', output: 'acceptance/output' },
    components: [{ id: 'fixture', module: 'test.fixture', after: [], settings: { mode }, bridges:
      Object.fromEntries(bridges.map(slot => [slot, { publish: ['input', 'output'], subscribe: ['input', 'output'] }])) }],
    bindings: [], entry: { component: 'fixture' }, startupTimeoutMs: 5000, healthTimeoutMs: 1000, stopTimeoutMs: 500, ...extra });
  await createLock(directory, environment); return directory;
}

async function samplePackage(app) {
  const directory = join(app.directory, 'sample-' + randomUUID());
  await cp(SAMPLE, directory, { recursive: true });
  await createLock(directory, environment); return directory;
}
const importTo = (app, directory, instanceId) => importPackage(directory, { root: app.root, instanceId, ...environment });
const requestJson = async (base, path, init) => {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000), ...init });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
};
const analyze = (session, text) => requestJson(session.ready.entryUrl, '/analyze', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
async function filesBelow(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const file = join(prefix, entry.name); if (entry.isDirectory()) result.push(...await filesBelow(root, file)); else result.push(file);
  }
  return result.sort();
}
async function observations(stateDir) {
  const paths = (await filesBelow(stateDir)).filter(file => file.endsWith('runtime-observed.json'));
  return Promise.all(paths.map(file => json(join(stateDir, file))));
}
async function bridgeConfigs(stateDir) {
  const configs = [];
  for (const file of (await filesBelow(stateDir)).filter(file => file.endsWith('.json') && !file.startsWith('package' + sep))) {
    const value = await json(join(stateDir, file));
    if (value.format === 'world-hub.run/v1') configs.push(value);
  }
  return configs;
}

test('RUNTIME-01 planning is read-only and import never silently refreshes or overwrites reviewed sources', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const beforePaths = await filesBelow(directory), before = await Promise.all(beforePaths.map(async file => [file, sha(await readFile(join(directory, file)))]));
  const plan = await inspectPackage(directory, environment);
  assert.match(plan.digest, /^[a-f0-9]{64}$/); assert.equal(plan.modules[0].manifest.permissions.processes, 'none');
  assert.deepEqual(await filesBelow(directory), beforePaths);
  assert.deepEqual(await Promise.all(beforePaths.map(async file => [file, sha(await readFile(join(directory, file)))])), before);
  await assert.rejects(lstat(app.root), { code: 'ENOENT' });
  const imported = await importTo(app, directory, 'reviewed'); assert.equal(imported.digest, plan.digest);
  await assert.rejects(importTo(app, directory, 'reviewed'), /exist|overwrite|already|已|存在/i);
  assert.equal((await observations(imported.stateDir)).length, 0, 'Planning and import must not execute module entries');
  app.record('read-only-plan-and-immutable-import', { digest: plan.digest, files: beforePaths.length });
});

test('RUNTIME-02 real JS to Python to JS flow isolates two instances and survives restart plus export rebuild', options, async t => {
  const app = await workspace(t), directory = await samplePackage(app);
  const one = await importTo(app, directory, 'one'), two = await importTo(app, directory, 'two');
  const first = await app.start('one', one.digest), second = await app.start('two', two.digest);
  assert.notEqual(first.ready.hubUrl, second.ready.hubUrl); assert.notEqual(first.ready.entryUrl, second.ready.entryUrl);
  assert.notEqual(first.ready.controlUrl, second.ready.controlUrl); assert.notEqual(first.ready.stateDir, second.ready.stateDir);
  const oneConfigs = await bridgeConfigs(first.ready.stateDir), twoConfigs = await bridgeConfigs(second.ready.stateDir);
  assert.equal(oneConfigs.length, 3); assert.equal(twoConfigs.length, 3);
  const oneTokens = new Set(oneConfigs.flatMap(config => config.bridges.map(bridge => bridge.token)));
  const twoTokens = new Set(twoConfigs.flatMap(config => config.bridges.map(bridge => bridge.token)));
  assert.equal(oneTokens.size, 3); assert.equal(twoTokens.size, 3);
  assert.ok([...oneTokens].every(token => !twoTokens.has(token)), 'Simultaneous instances must not share bridge credentials');
  const text = '世界枢纽 🌍\r\nCafé\n';
  const resultOne = (await analyze(first, text)).result, resultTwo = (await analyze(second, 'another instance')).result;
  assert.deepEqual(resultOne.output, expected(text)); assert.deepEqual(resultTwo.output, expected('another instance'));
  assert.equal(resultOne.receipts.length, 3);
  for (const receipt of resultOne.receipts) { assert.ok(receipt.responseSeq > receipt.requestSeq); assert.ok(receipt.fromPrincipal); assert.ok(receipt.senderSession); }
  const firstStatus = await first.status(); app.observePids(firstStatus);
  assert.equal(firstStatus.components.length, 3); assert.ok(firstStatus.components.every(component => component.communication === 'connected'));
  const sourceBefore = (await requestJson(first.ready.entryUrl, '/state')).results;
  const exported = join(app.directory, 'exported'); await exportInstance({ root: app.root, instanceId: 'one', destination: exported, ...environment });
  const exportedFiles = await filesBelow(exported);
  assert.ok(exportedFiles.includes('pack.json')); assert.ok(exportedFiles.includes('pack.lock'));
  assert.ok(exportedFiles.every(file => !/runtime-config|owner|credential|(^|[\\/])state([\\/]|$)/i.test(file)), exportedFiles.join('\n'));
  await first.close(); assert.equal((await app.status('one')).state, 'stopped');
  const finalLogs = await logsInstance({ root: app.root, instanceId: 'one' });
  assert.ok(finalLogs.logs.source); assert.ok(finalLogs.logs.stats); assert.ok(finalLogs.logs.desk);
  const restarted = await app.start('one', one.digest);
  assert.deepEqual((await requestJson(restarted.ready.entryUrl, '/state')).results, sourceBefore, 'Program-owned durable results should survive a supervisor restart');
  assert.deepEqual((await requestJson(second.ready.entryUrl, '/state')).results, [resultTwo], 'Another instance must not acquire first-instance results');
  const rebuiltRoot = join(app.directory, 'rebuilt-root');
  const rebuilt = await importPackage(exported, { root: rebuiltRoot, instanceId: 'rebuilt', ...environment });
  const third = await startInstance({ root: rebuiltRoot, instanceId: 'rebuilt', trust: rebuilt.digest, ...environment });
  app.sessions.push(third); app.observePids(await third.status());
  assert.deepEqual((await requestJson(third.ready.entryUrl, '/state')).results, [], 'Export must not carry prior instance business state');
  assert.deepEqual((await analyze(third, text)).result.output, expected(text));
  app.record('real-cross-language-isolation-restart-export', { output: resultOne.output,
    instances: [first.ready.instanceId, second.ready.instanceId, third.ready.instanceId], exportedFiles: exportedFiles.length });
});

test('RUNTIME-03 one external program owns multiple independent mod bridges with filtered environment and private credentials', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app, { bridges: ['input', 'output'] });
  const secret = 'parent-only-' + randomUUID(), previous = process.env.WORLD_HUB_TEST_PARENT_SECRET;
  process.env.WORLD_HUB_TEST_PARENT_SECRET = secret;
  t.after(() => { if (previous === undefined) delete process.env.WORLD_HUB_TEST_PARENT_SECRET; else process.env.WORLD_HUB_TEST_PARENT_SECRET = previous; });
  const imported = await importTo(app, directory, 'many'), session = await app.start('many', imported.digest);
  await assert.rejects(startInstance({ root: app.root, instanceId: 'many', trust: imported.digest, ...environment }), /lock|already|运行|锁/i);
  const status = await session.status(), observed = await observations(session.ready.stateDir);
  assert.equal(observed.length, 1); assert.equal(observed[0].parentSecret, null);
  assert.ok(resolve(observed[0].cwd).startsWith(resolve(session.ready.stateDir) + sep), 'Each component needs its own private state working directory');
  assert.equal(observed[0].bridges.length, 2);
  assert.equal(new Set(observed[0].bridges.map(bridge => bridge.bridgeId)).size, 2);
  const live = await requestJson(session.ready.hubUrl, '/status');
  assert.equal(live.bridges.length, 2); assert.equal(new Set(live.bridges.map(bridge => bridge.session)).size, 2);
  assert.equal(new Set(live.bridges.map(bridge => bridge.principal)).size, 1);
  assert.equal(status.components[0].communication, 'connected'); assert.equal(status.components[0].bridges.length, 2);
  const publicText = JSON.stringify({ ready: session.ready, status, logs: await logsInstance({ root: app.root, instanceId: 'many' }) });
  assert.equal(publicText.includes(secret), false);
  for (const bridge of observed[0].bridges) assert.equal(publicText.includes(bridge.token), false, 'Public supervisor surfaces must redact tokens');
  app.record('multi-bridge-filtered-environment', { bridgeIds: observed[0].bridges.map(bridge => bridge.bridgeId), bridges: live.bridges.length });
});

test('RUNTIME-04 exact lock coverage rejects changed pack, changed source, missing files, extra files, and unsafe lock paths', options, async t => {
  const app = await workspace(t);
  const mutations = [
    ['pack bytes', async directory => writeFile(join(directory, 'pack.json'), (await readFile(join(directory, 'pack.json'), 'utf8')) + '\n')],
    ['source bytes', directory => writeFile(join(directory, 'modules/fixture/program.mjs'), '\n// unreviewed code\n', { flag: 'a' })],
    ['missing file', directory => rm(join(directory, 'modules/fixture/sdk/blob-client.mjs'))],
    ['extra file', directory => writeFile(join(directory, 'modules/fixture/extra.mjs'), 'process.exit(0)\n')],
    ['absolute lock path', async directory => { const lock = await json(join(directory, 'pack.lock')); lock.modules[0].files[0].path = 'C:/outside.txt'; await save(join(directory, 'pack.lock'), lock); }],
    ['traversal lock path', async directory => { const lock = await json(join(directory, 'pack.lock')); lock.modules[0].files[0].path = '../outside.txt'; await save(join(directory, 'pack.lock'), lock); }],
    ['traversal module source', async directory => { const lock = await json(join(directory, 'pack.lock')); lock.modules[0].source = '../outside'; await save(join(directory, 'pack.lock'), lock); }],
    ['case-colliding lock file', async directory => { const lock = await json(join(directory, 'pack.lock')); const row = lock.modules[0].files.find(file => file.path === 'program.mjs'); lock.modules[0].files.push({ ...row, path: 'PROGRAM.mjs' }); await save(join(directory, 'pack.lock'), lock); }],
  ];
  for (const [label, mutate] of mutations) {
    const directory = await fixturePackage(app); await mutate(directory);
    await assert.rejects(inspectPackage(directory, environment), undefined, label);
    await assert.rejects(importTo(app, directory, 'bad-' + randomUUID().slice(0, 8)), undefined, label);
    app.record('locked-content-rejected', { mutation: label });
  }
  await assert.rejects(lstat(app.root), { code: 'ENOENT' });
});

test('RUNTIME-05 symbolic links and junctions cannot escape a deployment package', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const outside = join(app.directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'payload.mjs'), 'process.exit(0)');
  await symlink(outside, join(directory, 'modules/fixture/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createLock(directory, environment), /symbolic|symlink|link|junction|链接/i);
  await assert.rejects(inspectPackage(directory, environment));
  app.record('outside-package-link-rejected');
});

test('RUNTIME-06 cyclic deployment, incompatible contracts, unsafe topics, permissions, and platform are rejected', options, async t => {
  const app = await workspace(t);
  const mutateAndRelock = async (label, mutate) => {
    const directory = await fixturePackage(app); await mutate(directory);
    await assert.rejects(async () => { await createLock(directory, environment); await inspectPackage(directory, environment); }, undefined, label);
    app.record('invalid-deployment-rejected', { mutation: label });
  };
  await mutateAndRelock('self-cycle', async directory => { const pack = await json(join(directory, 'pack.json')); pack.components[0].after = ['fixture']; await save(join(directory, 'pack.json'), pack); });
  await mutateAndRelock('unknown binding', async directory => { const pack = await json(join(directory, 'pack.json')); pack.bindings = [{ from: 'fixture', to: 'missing', contract: { id: 'x', version: '1.0.0' } }]; await save(join(directory, 'pack.json'), pack); });
  await mutateAndRelock('two-component cycle', async directory => { const pack = await json(join(directory, 'pack.json'));
    const second = structuredClone(pack.components[0]); second.id = 'second'; second.after = ['fixture'];
    pack.components[0].after = ['second']; pack.components.push(second); await save(join(directory, 'pack.json'), pack); });
  await mutateAndRelock('declared contract version mismatch', async directory => { const pack = await json(join(directory, 'pack.json'));
    const second = structuredClone(pack.components[0]); second.id = 'second'; pack.components.push(second);
    pack.bindings = [{ from: 'fixture', to: 'second', contract: { id: 'business.versioned', version: '1.0.0' } }];
    const module = await json(join(directory, 'modules/fixture/module.json'));
    module.provides = [{ id: 'business.versioned', version: '2.0.0' }]; module.requires = [];
    await save(join(directory, 'modules/fixture/module.json'), module); await save(join(directory, 'pack.json'), pack); });
  await mutateAndRelock('unbound required contract', async directory => { const module = await json(join(directory, 'modules/fixture/module.json')); module.requires = [{ id: 'business.required', version: '1.0.0' }]; await save(join(directory, 'modules/fixture/module.json'), module); });
  await mutateAndRelock('wildcard topic', async directory => { const pack = await json(join(directory, 'pack.json')); pack.topics.input = 'unbounded/#'; await save(join(directory, 'pack.json'), pack); });
  await mutateAndRelock('unsafe permission', async directory => { const module = await json(join(directory, 'modules/fixture/module.json')); module.permissions.processes = 'any'; await save(join(directory, 'modules/fixture/module.json'), module); });
  await mutateAndRelock('unsupported platform', async directory => { const module = await json(join(directory, 'modules/fixture/module.json')); module.platforms = [process.platform === 'win32' ? 'linux-arm64' : 'win32-arm64']; await save(join(directory, 'modules/fixture/module.json'), module); });
});

test('RUNTIME-07 runtime version drift and missing Python dependencies are refused before module startup', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const lock = await json(join(directory, 'pack.lock')); lock.runtimes.node.version = '1.0.0'; await save(join(directory, 'pack.lock'), lock);
  await assert.rejects(inspectPackage(directory, environment), /version|runtime|版本/i);
  const sample = await samplePackage(app), pythonLock = await json(join(sample, 'pack.lock'));
  pythonLock.runtimes.python.packages['world_hub_nonexistent_dependency'] = '1.0.0'; await save(join(sample, 'pack.lock'), pythonLock);
  await assert.rejects(inspectPackage(sample, environment), /package|dependency|websockets|unsupported|unknown|依赖/i);
  await assert.rejects(inspectPackage(sample, { ...environment, pythonPath: join(app.directory, 'missing-python.exe') }));
  const cleanSample = await samplePackage(app), venv = join(app.directory, 'empty-python-environment');
  await runFile(PYTHON, ['-m', 'venv', '--without-pip', venv], { timeout: 15000 });
  const barePython = process.platform === 'win32' ? join(venv, 'Scripts/python.exe') : join(venv, 'bin/python');
  await assert.rejects(inspectPackage(cleanSample, { ...environment, pythonPath: barePython }), /websockets|package|dependency|ModuleNotFound|模块|依赖/i);
  await assert.rejects(lstat(app.root), { code: 'ENOENT' });
  app.record('environment-drift-and-missing-interpreter-rejected');
});

test('RUNTIME-13 replacement uses only explicit package wiring and new module identity while caller code is unchanged', options, async t => {
  const app = await workspace(t), directory = await samplePackage(app);
  const pack = await json(join(directory, 'pack.json')), stats = pack.components.find(component => component.id === 'stats');
  const plan = await inspectPackage(directory, environment), statsModule = plan.modules.find(module => module.manifest.id === stats.module);
  const deskModule = plan.modules.find(module => module.manifest.id === pack.components.find(component => component.id === 'desk').module);
  const deskFiles = await filesBelow(join(directory, deskModule.source));
  const deskBefore = await Promise.all(deskFiles.map(async file => [file, sha(await readFile(join(directory, deskModule.source, file)))]));
  const manifestPath = join(directory, statsModule.source, 'module.json'), manifest = await json(manifestPath);
  manifest.id = 'third-party.statistics'; await save(manifestPath, manifest); stats.module = manifest.id;
  pack.topics.stats = 'vendor/statistics/independent'; pack.topics.source = 'vendor/source/independent';
  await save(join(directory, 'pack.json'), pack); await createLock(directory, environment);
  const imported = await importTo(app, directory, 'replacement'), session = await app.start('replacement', imported.digest);
  const text = 'Configured external replacement 🌍\n', result = (await analyze(session, text)).result;
  assert.deepEqual(result.output, expected(text)); assert.equal(result.provider, manifest.id);
  assert.deepEqual(await Promise.all(deskFiles.map(async file => [file, sha(await readFile(join(directory, deskModule.source, file)))])), deskBefore);
  app.record('configured-module-and-topic-replacement', { provider: result.provider, output: result.output, unchangedCallerFiles: deskFiles.length });
});

test('RUNTIME-14 foreground CLI imports, plans, starts, observes, stops, and exports a real isolated instance', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), cli = join(ROOT, 'bin/world-hub-pack.mjs');
  const common = ['--root', app.root, '--instance', 'cli'];
  const interpreters = ['--node', process.execPath, '--python', PYTHON];
  const planned = await runFile(process.execPath, [cli, 'plan', directory, '--node', process.execPath, '--python', PYTHON], { cwd: app.directory, timeout: 15000 });
  const plan = JSON.parse(planned.stdout); assert.match(plan.digest, /^[a-f0-9]{64}$/);
  const imported = await runFile(process.execPath, [cli, 'import', directory, ...common, ...interpreters], { cwd: app.directory, timeout: 15000 });
  assert.equal(JSON.parse(imported.stdout).digest, plan.digest);
  const child = spawn(process.execPath, [cli, 'start', ...common, ...interpreters, '--trust', plan.digest], { cwd: app.directory, stdio: ['ignore', 'pipe', 'pipe'] });
  app.trackedPids.add(child.pid);
  const lines = []; let pending = '', stderr = '', ended;
  const exit = new Promise(resolvePromise => child.once('close', (code, signal) => { ended = { code, signal }; resolvePromise(ended); }));
  child.stdout.on('data', chunk => {
    pending += chunk.toString(); let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try { lines.push(JSON.parse(line)); } catch { /* Human diagnostics do not constitute ready evidence. */ }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65536); });
  app.cleanups.push(async () => {
    if (!ended) { await stopInstance({ root: app.root, instanceId: 'cli' }).catch(() => {}); await Promise.race([exit, pause(5000)]); }
    if (!ended) { child.kill('SIGKILL'); await exit; }
  });
  const ready = await until(async () => {
    if (ended) throw new Error(`CLI exited before ready: ${JSON.stringify(ended)} ${stderr}`);
    return lines.find(line => line.event === 'pack-ready');
  }, { label: 'foreground CLI readiness' });
  const statusCommand = await runFile(process.execPath, [cli, 'status', ...common], { cwd: app.directory, timeout: 10000 });
  const running = app.observePids(JSON.parse(statusCommand.stdout)); assert.equal(running.state, 'running');
  const logsCommand = await runFile(process.execPath, [cli, 'logs', ...common], { cwd: app.directory, timeout: 10000 });
  assert.ok(JSON.parse(logsCommand.stdout).logs.fixture);
  const denied = await fetch(new URL('/status', ready.controlUrl), { signal: AbortSignal.timeout(3000) });
  assert.ok([401, 403].includes(denied.status), 'Private supervisor control requires local authentication');
  await runFile(process.execPath, [cli, 'stop', ...common], { cwd: app.directory, timeout: 10000 });
  const closed = await exit; assert.equal(closed.code, 0, stderr);
  assert.equal((await app.status('cli')).state, 'stopped');
  const destination = join(app.directory, 'cli-export');
  await runFile(process.execPath, [cli, 'export', ...common, ...interpreters, '--destination', destination], { cwd: app.directory, timeout: 10000 });
  assert.equal((await inspectPackage(destination, environment)).digest, plan.digest);
  app.record('cli-foreground-lifecycle', { ready, exit: closed, exportDigest: plan.digest });
});

test('RUNTIME-08 reviewed digest is mandatory and copied package tampering is detected before any module starts', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), imported = await importTo(app, directory, 'trust');
  await assert.rejects(startInstance({ root: app.root, instanceId: 'trust', ...environment }), /trust|digest|review|授权|确认/i);
  await assert.rejects(startInstance({ root: app.root, instanceId: 'trust', trust: '0'.repeat(64), ...environment }), /trust|digest|review|授权|确认/i);
  const staleOwner = join(imported.stateDir, 'owner.lock');
  await save(staleOwner, { pid: process.pid, nonce: 'foreign-owner', startedAt: '2000-01-01T00:00:00.000Z' });
  await assert.rejects(startInstance({ root: app.root, instanceId: 'trust', trust: imported.digest, ...environment }), /lock|owner|锁/i);
  assert.equal(alive(process.pid), true, 'Stored owner PIDs must never be used as a kill target');
  await rm(staleOwner);
  const packageDir = join(app.root, 'instances/trust/package');
  await writeFile(join(packageDir, 'modules/fixture/program.mjs'), '\n// post-review modification\n', { flag: 'a' });
  await assert.rejects(startInstance({ root: app.root, instanceId: 'trust', trust: imported.digest, ...environment }));
  assert.equal((await observations(imported.stateDir)).length, 0);
  app.record('missing-wrong-and-stale-trust-rejected');
});

test('RUNTIME-09 an early exit and startup readiness timeout clean up every process actually owned by the run', options, async t => {
  const app = await workspace(t);
  for (const mode of ['early-exit', 'no-ready']) {
    const directory = await fixturePackage(app, { mode, extra: { startupTimeoutMs: 1800 } });
    const id = mode, imported = await importTo(app, directory, id);
    await assert.rejects(app.start(id, imported.digest), /exit|ready|start|timeout|超时|就绪/i);
    const status = await app.status(id); assert.equal(status.state, 'failed');
    for (const observed of await observations(imported.stateDir)) app.trackedPids.add(observed.pid);
    for (const pid of app.trackedPids) assert.equal(alive(pid), false, `Failed startup retained child ${pid}`);
    app.record('startup-failure-cleanup', { mode, state: status.state });
  }
});

test('RUNTIME-10 crash and health probe failure fail the instance and terminate the remaining owned processes', options, async t => {
  const app = await workspace(t);
  for (const mode of ['crash-after-ready', 'health-unready', 'health-timeout']) {
    const directory = await fixturePackage(app, { mode }), imported = await importTo(app, directory, mode);
    const session = await app.start(mode, imported.digest);
    const failed = await until(async () => { const status = await app.status(mode); return status.state === 'failed' ? status : false; }, { label: mode });
    await session.closed;
    for (const observed of await observations(imported.stateDir)) app.trackedPids.add(observed.pid);
    for (const pid of app.trackedPids) assert.equal(alive(pid), false, `Failed instance retained owned child ${pid}`);
    assert.ok(failed.failure?.message, 'Failure state must explain the observed cause');
    app.record('post-start-failure-cleanup', { mode, failure: failed.failure.message });
  }
});

test('RUNTIME-11 bounded logs redact credentials while repeated valid log lines do not break health supervision', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app, { mode: 'flood' }), imported = await importTo(app, directory, 'flood');
  const session = await app.start('flood', imported.digest);
  const logResult = await until(async () => { const result = await logsInstance({ root: app.root, instanceId: 'flood' });
    return result.logs?.fixture?.truncated ? result : false; }, { label: 'bounded log truncation' });
  const observed = await observations(session.ready.stateDir), row = logResult.logs.fixture;
  assert.ok(Buffer.byteLength(row.stdout) <= 65536); assert.ok(Buffer.byteLength(row.stderr) <= 65536);
  for (const bridge of observed[0].bridges) assert.equal(JSON.stringify(logResult).includes(bridge.token), false);
  await pause(1200); assert.equal((await session.status()).state, 'running');
  await session.close();
  const persistedLogs = await logsInstance({ root: app.root, instanceId: 'flood' });
  assert.equal(JSON.stringify(persistedLogs).includes(observed[0].bridges[0].token), false);
  app.record('bounded-and-redacted-log-flood', { stdoutBytes: Buffer.byteLength(row.stdout), stderrBytes: Buffer.byteLength(row.stderr) });
});

test('RUNTIME-12 oversized protocol lines and uncooperative stop cannot retain module or Hub processes', options, async t => {
  const app = await workspace(t);
  const badDir = await fixturePackage(app, { mode: 'oversize-line' }), badImport = await importTo(app, badDir, 'oversize');
  const badSession = await app.start('oversize', badImport.digest);
  await until(async () => (await app.status('oversize')).state === 'failed', { label: 'oversized stdout refusal' });
  await badSession.closed;
  const slowDir = await fixturePackage(app, { mode: 'ignore-stop' }), slowImport = await importTo(app, slowDir, 'slow-stop');
  const slowSession = await app.start('slow-stop', slowImport.digest), started = Date.now();
  await stopInstance({ root: app.root, instanceId: 'slow-stop' }); await slowSession.closed;
  const stopped = await app.status('slow-stop'); assert.ok(['stopped', 'failed'].includes(stopped.state));
  assert.ok(Date.now() - started < 8000, 'Stop deadline must bound an uncooperative external program');
  for (const pid of app.trackedPids) assert.equal(alive(pid), false, `Stopping retained owned child ${pid}`);
  app.record('oversized-line-and-stop-deadline-cleanup', { stopDurationMs: Date.now() - started, state: stopped.state });
});

test('RUNTIME-15 stdout and stderr redact credentials split across real pipe chunks', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app, { mode: 'split-secret' });
  const imported = await importTo(app, directory, 'split-secret'), session = await app.start('split-secret', imported.digest);
  const logs = await until(async () => {
    const result = await logsInstance({ root: app.root, instanceId: 'split-secret' });
    const row = result.logs.fixture;
    return row.stdout.includes('split-secret-finished') && row.stderr.includes('split-secret-finished') ? result : false;
  }, { label: 'split token logs' });
  const observed = await observations(session.ready.stateDir), token = observed[0].bridges[0].token;
  assert.equal(JSON.stringify(logs).includes(token), false, 'Pipe chunk boundaries must not bypass credential redaction');
  await session.close();
  assert.equal(JSON.stringify(await logsInstance({ root: app.root, instanceId: 'split-secret' })).includes(token), false);
  app.record('cross-chunk-credential-redaction', { streams: ['stdout', 'stderr'] });
});

test('RUNTIME-16 a restart exposes fresh starting state and can be stopped before application readiness', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app, { mode: 'delay-restart', extra: { startupTimeoutMs: 20000 } });
  const imported = await importTo(app, directory, 'restart-stop'), first = await app.start('restart-stop', imported.digest);
  const before = await first.status(); await first.close();
  assert.ok((await app.status('restart-stop')).stoppedAt);
  const controller = new AbortController();
  const restart = app.start('restart-stop', imported.digest, { signal: controller.signal }).then(session => ({ session }), error => ({ error }));
  app.cleanups.push(async () => { controller.abort(); const result = await restart; if (result.session) await result.session.close(); });
  const starting = await until(async () => { const value = await app.status('restart-stop');
    return value.state === 'starting' && value.components.some(component => component.pid) ? value : false;
  }, { label: 'fresh restart startup with owned module' });
  assert.notEqual(starting.runId, before.runId); assert.equal(starting.stoppedAt, undefined);
  assert.ok(starting.components.some(component => component.readiness === 'not-ready'));
  const beganStop = Date.now(), stopped = await stopInstance({ root: app.root, instanceId: 'restart-stop' });
  const result = await restart;
  assert.ok(result.error); assert.equal(result.error.code, 'START_STOPPED'); assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.runId, starting.runId); assert.ok(stopped.stoppedAt);
  assert.ok(Date.now() - beganStop < 5000, 'Stopping startup must not wait for the full application readiness deadline');
  for (const pid of app.trackedPids) assert.equal(alive(pid), false);
  app.record('stop-during-fresh-restart-startup', { priorRunId: before.runId, stoppedRunId: stopped.runId, durationMs: Date.now() - beganStop });
});

test('RUNTIME-17 a broken status journal cannot prevent owned children from closing', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), imported = await importTo(app, directory, 'journal');
  const session = await app.start('journal', imported.digest), statusFile = join(imported.stateDir, 'status.json');
  // A directory at the journal destination produces a real filesystem write error.
  await rm(statusFile); await mkdir(statusFile);
  const terminal = await session.close(); await session.closed;
  assert.equal(terminal.state, 'failed'); assert.ok(terminal.cleanupErrors?.length);
  assert.ok(terminal.stoppedAt); assert.equal(terminal.cleanupIncomplete, undefined);
  for (const pid of app.trackedPids) assert.equal(alive(pid), false, 'A failed state write must not retain external processes');
  await assert.rejects(lstat(join(imported.stateDir, 'owner.lock')), { code: 'ENOENT' });
  app.record('journal-failure-still-closes-owned-children', { cleanupErrors: terminal.cleanupErrors.length, confirmedStopped: Boolean(terminal.stoppedAt) });
});

test('RUNTIME-18 abrupt foreground supervisor death closes ordinary programs through pipe EOF', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app, { mode: 'no-ready', extra: { startupTimeoutMs: 20000 } });
  const imported = await importTo(app, directory, 'parent-eof'), cli = join(ROOT, 'bin/world-hub-pack.mjs');
  const child = spawn(process.execPath, [cli, 'start', '--root', app.root, '--instance', 'parent-eof', '--trust', imported.digest,
    '--node', process.execPath], { cwd: app.directory, stdio: ['ignore', 'pipe', 'pipe'] });
  app.trackedPids.add(child.pid); let ended = false, stderr = '';
  const closed = new Promise(resolvePromise => child.once('close', (code, signal) => { ended = true; resolvePromise({ code, signal }); }));
  child.stdout.resume(); child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  app.cleanups.push(async () => { if (!ended) child.kill('SIGKILL'); await closed; });
  const starting = await until(async () => {
    if (ended) throw new Error('Supervisor exited before the controlled death: ' + stderr);
    const value = await app.status('parent-eof'); return value.hub?.pid && value.components.some(component => component.pid) ? value : false;
  }, { label: 'supervisor-owned Hub and program before readiness' });
  child.kill('SIGKILL'); await closed;
  for (const observed of await observations(imported.stateDir)) app.trackedPids.add(observed.pid);
  await until(async () => [...app.trackedPids].every(pid => !alive(pid)), { timeoutMs: 8000, label: 'parent EOF child exits' });
  const stale = await app.status('parent-eof'); assert.equal(stale.supervisorUnavailable, true); assert.equal(stale.observation, 'stale');
  assert.equal(stale.stoppedAt, undefined, 'An absent supervisor cannot claim that it confirmed child exits');
  await lstat(join(imported.stateDir, 'owner.lock'));
  app.record('parent-death-eof-cleanup-and-honest-stale-state', { runId: starting.runId, state: stale.state, supervisorUnavailable: stale.supervisorUnavailable });
});

test('RUNTIME-19 Hub parent EOF during startup exits without leaving a listener behind', options, async t => {
  const app = await workspace(t), hubConfig = join(app.directory, 'early-eof-hub.json');
  await save(hubConfig, { transport: { host: '127.0.0.1', port: 0, path: '/bridge' }, log: { dir: join(app.directory, 'early-eof-log') },
    blobs: { dir: join(app.directory, 'early-eof-blobs') }, management: { stateFile: join(app.directory, 'early-eof-management.json') },
    acl: { defaultDeny: true, allowUnlistedBridges: false, credentials: {}, bridges: {} } });
  const child = spawn(process.execPath, [join(ROOT, 'scripts/runtime/hub-process.mjs'), '--config', hubConfig, '--quiet'],
    { cwd: app.directory, stdio: ['pipe', 'pipe', 'pipe'] });
  app.trackedPids.add(child.pid); let ended = false, stderr = '';
  const closed = new Promise(resolvePromise => child.once('close', (code, signal) => { ended = true; resolvePromise({ code, signal }); }));
  child.stdout.resume(); child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  app.cleanups.push(async () => { if (!ended) child.kill('SIGKILL'); await closed; });
  child.stdin.end();
  await until(async () => ended, { timeoutMs: 5000, label: 'Hub exit after parent EOF during asynchronous startup' });
  const exit = await closed;
  assert.equal(exit.code, 0, stderr); assert.equal(alive(child.pid), false);
  app.record('early-parent-eof-ordinary-hub-exit', { exit });
});

test('RUNTIME-20 a delayed stop response remains bound to its original run after the instance restarts', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), imported = await importTo(app, directory, 'stop-restart');
  const runA = await app.start('stop-restart', imported.digest), statusA = await runA.status();
  const controlFile = join(imported.stateDir, 'control.json'), originalControl = await json(controlFile);
  let releaseReply, forwardedReply, relayError;
  const delayedReply = new Promise(resolvePromise => { releaseReply = resolvePromise; });
  const forwarded = new Promise(resolvePromise => { forwardedReply = resolvePromise; });
  // Real transport latency holds the acknowledgement after A accepts stop. It
  // provides a deterministic race without replacing any Runtime function.
  const relay = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/stop');
      const upstream = await fetch(new URL('/stop', originalControl.url), { method: 'POST',
        headers: { authorization: request.headers.authorization }, signal: AbortSignal.timeout(3000), redirect: 'error' });
      const body = await upstream.json(); assert.equal(upstream.status, 202); assert.equal(body.accepted, true);
      forwardedReply(); await delayedReply;
      response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    } catch (error) { relayError = error; forwardedReply(); response.writeHead(502); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolvePromise, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolvePromise); });
  app.cleanups.push(async () => { releaseReply(); relay.closeAllConnections(); await new Promise(resolvePromise => relay.close(resolvePromise)); });
  await save(controlFile, { ...originalControl, url: `http://127.0.0.1:${relay.address().port}` });
  let stopSettled = false;
  const stopping = stopInstance({ root: app.root, instanceId: 'stop-restart' }).then(value => ({ value }), error => ({ error }))
    .finally(() => { stopSettled = true; });
  app.cleanups.push(async () => { releaseReply(); await stopping; });
  await forwarded; if (relayError) throw relayError;
  await runA.closed;
  assert.equal(stopSettled, false, 'The original stop call must still be waiting when A closes');
  const runB = await app.start('stop-restart', imported.digest), statusB = await runB.status();
  assert.notEqual(statusB.runId, statusA.runId); assert.equal(statusB.state, 'running');
  assert.equal(stopSettled, false, 'The original stop call must overlap the completed restart');
  releaseReply();
  const outcome = await stopping; if (outcome.error) throw outcome.error;
  assert.equal(outcome.value.runId, statusA.runId); assert.equal(outcome.value.state, 'stopped'); assert.ok(outcome.value.stoppedAt);
  const stillRunning = await app.status('stop-restart');
  assert.equal(stillRunning.runId, statusB.runId); assert.equal(stillRunning.state, 'running');
  assert.ok(stillRunning.components.every(component => component.pid && alive(component.pid)));
  assert.equal(alive(stillRunning.hub.pid), true);
  app.record('stop-call-remains-bound-across-restart', { stoppedRunId: outcome.value.runId, currentRunId: stillRunning.runId,
    stoppedState: outcome.value.state, currentState: stillRunning.state, transportDelayWasReal: true });
});
