import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ownProcess } from '../../../scripts/runtime/process.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { PYTHON_RECIPE } from '../../../tools/launcher/environment-prepare.mjs';
import { workspace, fixturePackage, samplePackage, environment, until, json, alive, ROOT } from './helpers.mjs';

const options = { timeout: 120000, concurrency: false };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pipeError = message => Object.assign(new Error(message ?? 'read ENOTCONN'), { code: 'ENOTCONN', syscall: 'read' });
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function captureSpawns(app, match, inject) {
  const original = childProcess.spawn, captured = [];
  childProcess.spawn = function (...args) {
    const child = original.apply(this, args);
    if (match(args)) {
      captured.push({ child, args }); if (child.pid) app.trackedPids.add(child.pid);
      if (inject) child.once('spawn', () => queueMicrotask(() => inject(child, args)));
    }
    return child;
  };
  syncBuiltinESMExports();
  app.cleanups.push(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  return captured;
}
async function apiFor(app) {
  const server = await createLauncherServer({ root: app.root, ...environment }); app.cleanups.push(() => server.close());
  const call = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const done = id => until(async () => { const { operation } = await call('/api/operations/' + id);
    return operation.state === 'running' ? false : operation; }, { timeoutMs: 30000, label: 'owned pipe failure cleanup' });
  return { server, call, done };
}
async function importFixture(app, api, id) {
  const directory = await fixturePackage(app), reviewed = await api.call('/api/review', { directory });
  await api.call('/api/instances', { reviewId: reviewed.reviewId, instanceId: id });
  return api.call('/api/instances/' + id + '/review', {});
}

test('PIPE-01 Hub stdout failure during real startup fails the operation while Launcher stays available and owned exit is confirmed', options, async t => {
  const app = await workspace(t); let injected = 0;
  const captured = captureSpawns(app, args => args[1].some(value => String(value).endsWith('hub-process.mjs')), child => {
    injected++; child.stdout.destroy(pipeError());
  });
  const api = await apiFor(app), reviewed = await importFixture(app, api, 'pipe-start');
  const accepted = await api.call('/api/instances/pipe-start/start', { reviewId: reviewed.reviewId, accepted: true }, 202);
  const operation = await api.done(accepted.operationId);
  assert.equal(operation.state, 'failed'); assert.match(operation.error.message, /stdout pipe failed.*ENOTCONN/);
  assert.equal(injected, 1); assert.equal(captured.length, 1);
  const state = (await api.call('/api/instances/pipe-start')).instance.status;
  assert.equal(state.state, 'failed'); assert.ok(state.stoppedAt); assert.notEqual(state.cleanupIncomplete, true);
  assert.equal(alive(captured[0].child.pid), false); assert.equal(await exists(join(app.root, 'instances/pipe-start/owner.lock')), false);
  assert.equal((await api.call('/api/session')).root, app.root);
  app.record('real-hub-startup-pipe-error', { stream: 'stdout', error: operation.error, state,
    injectedEvent: true, actualOsFailureClaim: false, launcherAvailable: true, childExited: true });
});

test('PIPE-02 running component stderr failure stops exact owned children and stores bounded redacted diagnostics without crashing Launcher', options, async t => {
  const app = await workspace(t), captured = captureSpawns(app, args => args[1].includes('--runtime-config'));
  const api = await apiFor(app), reviewed = await importFixture(app, api, 'pipe-running');
  const started = await api.done((await api.call('/api/instances/pipe-running/start', { reviewId: reviewed.reviewId, accepted: true }, 202)).operationId);
  assert.equal(started.state, 'succeeded'); const running = app.observe(started.result.status);
  assert.equal(captured.length, 1); const { child, args } = captured[0];
  const config = await json(args[1][args[1].indexOf('--runtime-config') + 1]);
  const secret = config.bridges[0].token;
  child.stderr.destroy(pipeError('🌍'.repeat(1600) + ' read ENOTCONN ' + secret));
  const state = app.observe(await until(async () => { const current = (await api.call('/api/instances/pipe-running')).instance.status;
    return current.stoppedAt && !current.cleanupIncomplete ? current : false; }, { timeoutMs: 15000 }));
  assert.equal(state.state, 'failed'); assert.match(state.failure.message, /ENOTCONN.*\[redacted\]/);
  assert.ok(Buffer.byteLength(state.failure.message) <= 2048); assert.equal(JSON.stringify(state).includes(secret), false);
  assert.ok(state.components.every(component => component.exit)); assert.equal(alive(child.pid), false);
  assert.equal(await exists(join(app.root, 'instances/pipe-running/owner.lock')), false);
  const { logs } = await api.call('/api/instances/pipe-running/logs'); assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.match(logs.logs.fixture.stderr, /\[redacted\]/); assert.equal((await api.call('/api/session')).root, app.root);
  app.record('real-running-component-pipe-error', { stream: 'stderr', runId: running.runId, failure: state.failure,
    diagnosticBounded: true, diagnosticRedacted: true, launcherAvailable: true, allOwnedChildrenExited: true });
});

test('PIPE-03 output errors during and after real graceful stop remain diagnostics without rewriting a successful exit or reporting new failure', options, async t => {
  const app = await workspace(t), failures = [];
  const handle = ownProcess(process.execPath, ['-e',
    "process.stdout.write(JSON.stringify({event:'ready'})+'\\n'); process.stdin.once('data',()=>setTimeout(()=>process.exit(0),120)); setInterval(()=>{},1000);"],
  { cwd: app.directory, secrets: ['private-test-secret'], onFailure: error => failures.push(error) });
  app.trackedPids.add(handle.pid); app.cleanups.push(() => handle.stop(1000));
  await handle.waitFor(event => event.event === 'ready', 5000);
  const stopping = handle.stop(2000); assert.equal(handle.stopping, true);
  for (const stream of ['stdout', 'stderr']) handle.child[stream].destroy(pipeError('read ENOTCONN private-test-secret'));
  const exit = await stopping; assert.equal(exit.code, 0); assert.equal(handle.error, undefined); assert.equal(exit.error, undefined);
  for (const stream of ['stdout', 'stderr']) assert.doesNotThrow(() => handle.child[stream].emit('error', pipeError('late read ENOTCONN')));
  assert.equal(failures.length, 0); assert.equal(handle.error, undefined); assert.equal(alive(handle.pid), false);
  assert.match(handle.stderr, /\[redacted\]/); assert.equal(handle.stderr.includes('private-test-secret'), false);
  app.record('graceful-stop-and-late-pipe-events', { streams: ['stdout', 'stderr'], exit, noFalseFailure: true, childExited: true });
});

let wheelBytes;
async function verifiedWheel() {
  if (wheelBytes) return wheelBytes;
  try { wheelBytes = await readFile(process.env.WORLD_HUB_RUNTIME_TEST_WHEEL ?? join(ROOT, '.artifacts/phase16-followup/environment/environment-cache', PYTHON_RECIPE.filename)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(PYTHON_RECIPE.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); const chunks = []; let size = 0;
    for await (const block of response.body) { size += block.length; assert.ok(size <= PYTHON_RECIPE.size); chunks.push(block); }
    wheelBytes = Buffer.concat(chunks);
  }
  assert.equal(wheelBytes.length, PYTHON_RECIPE.size); assert.equal(hash(wheelBytes), PYTHON_RECIPE.sha256); return wheelBytes;
}
for (const stream of ['stdout', 'stderr']) test(`PIPE-ENV-${stream} real venv tool output failure uses confirmed child stop and cleans its private directory while Launcher remains available`, options, async t => {
  const app = await workspace(t); let injected = 0;
  const captured = captureSpawns(app, args => args[1].includes('venv') && args[1].includes('--without-pip'), child => {
    injected++; child[stream].destroy(pipeError());
  });
  const api = await apiFor(app), directory = await samplePackage(app), cache = join(app.root, 'environment-cache');
  await mkdir(cache); await writeFile(join(cache, PYTHON_RECIPE.filename), await verifiedWheel());
  const before = (await api.call('/api/environment', {})).environment;
  const planned = await api.call('/api/environment/plan', { directory });
  const accepted = await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true }, 202);
  const operation = await api.done(accepted.operationId);
  assert.equal(operation.state, 'failed'); assert.equal(operation.error.code, 'PREPARATION_PIPE_FAILED');
  assert.match(operation.error.message, new RegExp(stream + ' pipe failed')); assert.notEqual(operation.error.cleanupIncomplete, true);
  assert.equal(injected, 1); assert.equal(captured.length, 1); assert.equal(alive(captured[0].child.pid), false);
  assert.equal(await exists(planned.plan.destination), false); assert.equal(api.server.manager.preparationOwners.size, 0);
  assert.deepEqual((await api.call('/api/environment', {})).environment, before);
  assert.equal(hash(await readFile(join(cache, PYTHON_RECIPE.filename))), PYTHON_RECIPE.sha256);
  assert.equal((await api.call('/api/session')).root, app.root);
  // Late pipe events after the tool's close must not start new cancellation timers.
  assert.doesNotThrow(() => captured[0].child[stream].emit('error', pipeError('late read ENOTCONN')));
  assert.equal(operation.error.code, 'PREPARATION_PIPE_FAILED');
  app.record('real-private-venv-output-pipe-error', { stream, error: operation.error, childExited: true,
    partialDirectoryRemoved: true, baseUnchanged: true, launcherAvailable: true, noRetainedPreparationOwner: true });
});
