import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';
import { until } from '../../helpers/hub-harness.mjs';
import { verifyTextStatistics, expectedStatistics, checkStatisticsProtocol, checkStatisticsResponse } from '../../../tools/interop/text-statistics.mjs';
import { principalFor } from '../../../examples/purpose-demos/profiles.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const profile = 'capability-directory', prefix = 'demo/capability-directory';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');
const pythonPath = process.env.HUB_PYTHON ?? process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3');

async function pythonProgram(script, config) {
  const child = spawn(pythonPath, ['-B', script, '--config', config], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', buffer = '', resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { resolve({ code, signal }); rejectReady(new Error(stderr || 'Python exited before readiness')); }));
  child.once('error', rejectReady); child.stderr.on('data', b => { stderr = (stderr + b).slice(-4096); });
  child.stdout.on('data', b => { buffer += b; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { const event = JSON.parse(line); if (event.event === 'ready') resolveReady(event); } catch {} } });
  let timer; const stop = async () => {
    child.stdin.end('stop\n'); let kill;
    try { return await Promise.race([exited, new Promise((_, reject) => { kill = setTimeout(() => { child.kill(); reject(new Error('Python graceful stop failed')); }, 6000); })]); }
    finally { clearTimeout(kill); }
  };
  try { const event = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Python readiness timeout: ' + stderr)), 15000); })]); return { child, ready: event, stop }; }
  catch (error) { await stop(); throw error; } finally { clearTimeout(timer); }
}

test('INTEROP-01 one unchanged public consumer verifies JS and direct Python providers with layered reports and config-only replacement', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-interop-')), evidence = join(ROOT, '.artifacts/interop', randomUUID());
  await mkdir(evidence, { recursive: true }); const owned = [], bridges = [];
  t.after(async () => { for (const bridge of bridges) await bridge.close(); for (const program of [...owned].reverse()) assert.equal((await program.stop()).code, 0);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const commonToken = randomUUID(), providerToken = randomUUID();
  const principals = ['directory', 'source', 'composer', 'output', 'explorer'].map(id => principalFor(profile, id));
  const credentials = Object.fromEntries(principals.map(id => [id, { token: commonToken, maxConnections: 8,
    allow: { publish: [`${prefix}/#`, 'vendor/#'], subscribe: [`${prefix}/#`, 'vendor/#'] } }]));
  const providers = [{ language: 'javascript', id: 'vendor.javascript', kind: 'node', entry: 'provider.mjs' }, { language: 'python', id: 'vendor.python', kind: 'python', entry: 'provider.py' }];
  for (const p of providers) credentials[p.id] = { token: providerToken, maxConnections: 1, allow: { publish: ['vendor/#', `${prefix}/catalog/register`], subscribe: ['vendor/#', `${prefix}/catalog/register`] } };
  const hubConfig = join(directory, 'hub.json');
  await save(hubConfig, { transport: { host: '127.0.0.1', port: 0, path: '/bridge' }, log: { dir: join(directory, 'log') }, blobs: { dir: join(directory, 'blobs') }, management: { stateFile: join(directory, 'management.json') },
    acl: { defaultDeny: true, allowUnlistedBridges: false, credentials, bridges: {} } });
  const hub = await startOwnedProgram(join(ROOT, 'examples/distributed-context/hub-process.mjs'), { args: ['--config', hubConfig, '--quiet'] }); owned.push(hub);
  const catalogState = join(directory, 'programs/directory'); await mkdir(catalogState, { recursive: true });
  await save(join(catalogState, 'catalog-config.json'), { providers: Object.fromEntries(providers.map(p => [p.id, p.id])), topicPrefixes: ['vendor/'] });
  for (const id of ['directory', 'source', 'composer', 'output']) {
    const script = id === 'directory' ? 'directory.mjs' : 'composition.mjs';
    const program = await startOwnedProgram(join(ROOT, 'examples/capability-directory', script), { args: ['--profile', profile, '--peer', id, '--endpoint', hub.ready.endpoint, '--credential', commonToken, '--state-dir', join(directory, 'programs', id)] }); owned.push(program);
  }
  const protectedFiles = ['tools/interop/text-statistics.mjs', 'examples/capability-directory/composition.mjs'];
  const before = await Promise.all(protectedFiles.map(f => digest(join(ROOT, f)))); const reports = [];
  const controller = new Bridge({ url: hub.ready.endpoint, bridgeId: 'interop.controller', credential: principalFor(profile, 'explorer'), token: commonToken });
  controller.on('error', () => {}); bridges.push(controller); await controller.connect();
  const compose = body => controller.call({ principal: principalFor(profile, 'composer') }, `${prefix}/compose/run`, body, { timeoutMs: 10000 }).then(r => r.response.body);
  await compose({ command: 'configure', timeoutMs: 5000 });
  for (const p of providers) {
    const moduleDirectory = join(directory, p.id); await mkdir(moduleDirectory);
    const script = join(ROOT, 'tools/interop/providers', p.language, p.entry);
    // Bind the static declaration to the same exact implementation bytes.
    await writeFile(join(moduleDirectory, p.entry), await readFile(script));
    await save(join(moduleDirectory, 'module.json'), { format: 'world-hub.module/v1', id: p.id, version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], runtime: { kind: p.kind, entry: p.entry }, bridges: ['main'], provides: [{ id: 'text.statistics', version: '1.0.0' }], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
    const config = join(directory, `${p.language}.json`), topic = `vendor/${p.language}/statistics`;
    await save(config, { endpoint: hub.ready.endpoint, principal: p.id, credential: p.id, token: providerToken, moduleId: p.id, moduleVersion: '1.0.0', bridgeId: `${p.id}.bridge`, businessTopic: topic,
      directory: { principal: principalFor(profile, 'directory'), registerTopic: `${prefix}/catalog/register`, queryTopic: `${prefix}/catalog/query` }, allowedCallers: [principalFor(profile, 'composer')], leaseMs: 1000, renewEveryMs: 250,
      contractPath: join(ROOT, 'docs/modules/text-statistics.contract.json'), sdkDirectory: join(ROOT, 'sdk/python'), cursorFile: join(directory, p.language + '-cursor.json') });
    const program = p.kind === 'node' ? await startOwnedProgram(script, { args: ['--config', config] }) : await pythonProgram(script, config); owned.push(program);
    const consumerConfig = { endpoint: hub.ready.endpoint, target: { principal: p.id, session: program.ready.session }, topic, moduleId: p.id, moduleDirectory,
      caller: { bridgeId: `verify.${p.language}`, credential: principalFor(profile, 'composer'), principal: principalFor(profile, 'composer'), token: commonToken },
      deniedCaller: { bridgeId: `deny.${p.language}`, credential: principalFor(profile, 'explorer'), token: commonToken } };
    const privateWiring = join(directory, `verify-${p.language}.json`), reportPath = join(evidence, p.language + '.json');
    await save(privateWiring, consumerConfig);
    const cli = spawn(process.execPath, [join(ROOT, 'bin/world-hub-interop.mjs'), 'verify', '--config', privateWiring, '--report', reportPath], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let cliError = ''; cli.stderr.on('data', b => { cliError = (cliError + b).slice(-1024); }); cli.stdout.resume();
    const cliExit = await new Promise((resolve, reject) => { cli.once('error', reject); cli.once('exit', code => resolve(code)); });
    const report = JSON.parse(await readFile(reportPath, 'utf8')); assert.equal(cliExit, 0, cliError || JSON.stringify(report));
    assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.layers.protocol.cases.length, 13);
    // Invoke after the initial lease would expire; directory renewals must keep
    // the same public consumer able to select the live provider.
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal((await compose({ command: 'configure', provider: p.id })).ok, true);
    const result = await compose({ command: 'run', invocationId: 'swap-' + p.language }); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.selection.module.id, p.id); reports.push({ language: p.language, verificationPassed: report.passed, processor: result.selection, output: result.output });
  }
  assert.deepEqual(await Promise.all(protectedFiles.map(f => digest(join(ROOT, f)))), before);
  await save(join(evidence, 'report.json'), { format: 'world-hub.interop-reference/v1', passed: true, providers: reports,
    consumerChanged: false, sourceAndSinkChanged: false, authorship: { javascript: 'previous-separate-ai-docs-only', python: 'separate-ai-public-docs-only-without-reference-access', humanThirdPartyAcceptance: false },
    layers: ['static-module-declaration', 'real-bridge-request-correlation', 'exact-business-output'], consumerHashes: before });
  t.diagnostic('INTEROP_EVIDENCE ' + JSON.stringify({ directory: evidence, passed: true, unchangedConsumer: true }));
});

test('INTEROP-02 timeout is unknown, late response remains extractable, old session is not transferred, Hub ACL denial differs from business failure', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-interop-fault-')), owned = [], bridges = [];
  t.after(async () => { for (const b of bridges) await b.close(); for (const p of owned.reverse()) assert.equal((await p.stop()).code, 0); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const token = randomUUID(), credentials = Object.fromEntries(['caller', 'provider', 'denied'].map(id => [id, { token, maxConnections: 4, allow: { publish: id === 'denied' ? [] : ['fault/#'], subscribe: ['fault/#'] } }]));
  const path = join(directory, 'hub.json'); await save(path, { transport: { host: '127.0.0.1', port: 0, path: '/bridge' }, log: { dir: join(directory, 'log') }, acl: { defaultDeny: true, credentials, bridges: {} } });
  const hub = await startOwnedProgram(join(ROOT, 'examples/distributed-context/hub-process.mjs'), { args: ['--config', path, '--quiet'] }); owned.push(hub);
  const connect = async id => { const b = new Bridge({ url: hub.ready.endpoint, bridgeId: `${id}.${randomUUID().slice(0, 8)}`, credential: id, token }); b.on('error', () => {}); bridges.push(b); await b.connect(); return b; };
  const caller = await connect('caller'), provider = await connect('provider'), denied = await connect('denied'), requests = [];
  provider.on('delivery', d => { if (d.operation === 'request') requests.push(d); }); await provider.subscribe(['fault/statistics'], { from: 'now', operations: ['request'] });
  const target = { principal: 'provider', session: provider.welcome.session }, body = { contract: { id: 'text.statistics', version: '1.0.0' }, invocationId: 'late', text: 'late 🌍' };
  await assert.rejects(caller.call(target, 'fault/statistics', body, { timeoutMs: 150 }), error => /timeout|timed out/i.test(error.message));
  await until(() => requests.length === 1); const request = requests[0];
  const late = []; caller.on('delivery', d => { if (d.operation === 'response' && d.requestSeq === request.seq) late.push(d); });
  await caller.subscribe(['fault/statistics'], { from: request.seq, operations: ['response'] });
  const receipt = await provider.respond(request, { ok: true, kind: 'demo.capability-result', contract: body.contract, invocationId: body.invocationId, status: 'completed', provider: 'fault.module', executionId: randomUUID(), output: expectedStatistics(body.text) });
  await until(() => late.length === 1); assert.ok(receipt.seq > request.seq);
  checkStatisticsResponse({ request: { seq: request.seq }, response: late[0] }, { ...target, moduleId: 'fault.module', invocationId: body.invocationId, text: body.text });
  await provider.close(); const replacement = await connect('provider'); assert.notEqual(replacement.welcome.session, target.session);
  const redirected = []; replacement.on('delivery', d => redirected.push(d)); await replacement.subscribe(['fault/statistics'], { from: 'now', operations: ['request'] });
  await assert.rejects(caller.call(target, 'fault/statistics', { ...body, invocationId: 'old-session' }, { timeoutMs: 150 }), error => /timeout|timed out/i.test(error.message));
  assert.equal(redirected.length, 0);
  await assert.rejects(denied.requestTo({ principal: 'provider' }, 'fault/statistics', body), error => error.code === 'PUBLISH_DENIED');
  const exchange = { request: { seq: 1 }, response: { operation: 'response', requestSeq: 1, seq: 2, fromPrincipal: 'provider', body: { ok: true, provider: 'fault.module' } } };
  assert.equal(checkStatisticsProtocol(exchange, { principal: 'provider' }).requestCorrelationMatches, true);
  for (const seq of [undefined, 0, 1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...exchange, response: { ...exchange.response, seq } };
    assert.throws(() => checkStatisticsProtocol(invalid, { principal: 'provider' }), /correlation/);
    assert.throws(() => checkStatisticsResponse(invalid, { principal: 'provider', moduleId: 'fault.module', invocationId: 'bad', text: '' }), /correlation/);
  }
  assert.throws(() => checkStatisticsResponse(exchange, { principal: 'provider', moduleId: 'fault.module', invocationId: 'bad', text: '' }), /Business/);
  t.diagnostic('INTEROP_LIFECYCLE ' + JSON.stringify({ timeoutMeansCancellation: false, lateResponseValidated: true, oldSessionNotTransferred: true, hubDenialCode: 'PUBLISH_DENIED', businessValidationRejectsInvalidEnvelope: true }));
});
