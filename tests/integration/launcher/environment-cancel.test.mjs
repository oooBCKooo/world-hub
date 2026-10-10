import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { PYTHON_RECIPE } from '../../../tools/launcher/environment-prepare.mjs';
import { environment, workspace, samplePackage, ROOT, until, pause } from './helpers.mjs';

const options = { timeout: 120000, concurrency: false }, execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
let verifiedBytes;
async function cachedWheel() {
  if (verifiedBytes) return verifiedBytes;
  const file = process.env.WORLD_HUB_RUNTIME_TEST_WHEEL ?? join(ROOT, '.artifacts/phase16-followup/environment/environment-cache', PYTHON_RECIPE.filename);
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(PYTHON_RECIPE.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, 'Exact pinned official wheel must be available for first cache seeding');
    const chunks = []; let size = 0;
    for await (const block of response.body) { size += block.length; assert.ok(size <= PYTHON_RECIPE.size); chunks.push(block); }
    bytes = Buffer.concat(chunks);
  }
  assert.equal(bytes.length, PYTHON_RECIPE.size); assert.equal(sha(bytes), PYTHON_RECIPE.sha256);
  verifiedBytes = bytes; return bytes;
}
async function baseSnapshot() {
  const code = 'import sys,json,importlib.metadata; print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"packages":sorted((d.metadata["Name"],d.version) for d in importlib.metadata.distributions())},sort_keys=True))';
  const result = await execute(environment.pythonPath, ['-I', '-c', code], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(result.stdout); return { ...value, executableSha256: sha(await readFile(value.executable)) };
}
async function copiedDirectory(path) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await exists(path)) return; await pause(2); }
  throw new Error('The reviewed new venv directory was never created');
}
async function launcher(app) {
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment }); app.cleanups.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' };
  const call = async (path, value) => {
    const response = await fetch(new URL(path, server.url), { method: value === undefined ? 'GET' : 'POST', headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(45000), redirect: 'error' });
    const body = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`); assert.equal(body.ok, true); return body;
  };
  const wait = operationId => until(async () => { const { operation } = await call(`/api/operations/${operationId}`); return operation.state === 'running' ? false : operation; }, { timeoutMs: 30000 });
  return { server, call, wait };
}
async function ready(app, api) {
  const directory = await samplePackage(app), bytes = await cachedWheel(), cache = join(app.root, 'environment-cache');
  await mkdir(cache, { recursive: true }); await writeFile(join(cache, PYTHON_RECIPE.filename), bytes);
  const planned = await api.call('/api/environment/plan', { directory, ...environment });
  assert.equal(planned.plan.download.sha256, PYTHON_RECIPE.sha256); assert.equal(planned.plan.changesSystemEnvironment, false);
  assert.ok(planned.plan.actions.some(action => action.includes('without pip')));
  return { planned, directory, cache };
}
function blockRemoteFetch(t) {
  const realFetch = globalThis.fetch; let forbidden = 0;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol === 'https:') { forbidden++; throw new Error('Remote fetch intentionally disabled after exact-wheel cache verification'); }
    return realFetch(input, init);
  };
  t.after(() => { globalThis.fetch = realFetch; assert.equal(forbidden, 0, 'The verified cached recipe must not request a remote source'); });
}

test('ENVIRONMENT-CANCEL-01 HTTP cancellation after new venv ownership removes partial files and leaves the base interpreter and packages unchanged', options, async t => {
  const app = await workspace(t), api = await launcher(app), before = await baseSnapshot(), { planned, cache } = await ready(app, api);
  blockRemoteFetch(t);
  const accepted = await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true });
  await copiedDirectory(planned.plan.destination);
  await api.call(`/api/operations/${accepted.operationId}/cancel`, {});
  const operation = await api.wait(accepted.operationId);
  assert.equal(operation.state, 'failed'); assert.equal(operation.error.code, 'PREPARATION_CANCELLED');
  assert.notEqual(operation.error.cleanupIncomplete, true); assert.ok(operation.error.diagnostic.kind);
  assert.ok(operation.error.diagnostic.zh); assert.ok(operation.error.diagnostic.en);
  assert.equal(await exists(planned.plan.destination), false); assert.equal(api.server.manager.preparationOwners.size, 0);
  await pause(150); assert.equal(await exists(planned.plan.destination), false, 'No installer descendant may recreate the cleaned directory');
  assert.deepEqual(await baseSnapshot(), before);
  assert.equal(sha(await readFile(join(cache, PYTHON_RECIPE.filename))), PYTHON_RECIPE.sha256);
  assert.deepEqual(await readdir(join(app.root, 'environments')), []);
  app.record('actual-owned-venv-http-cancel-verified-offline-cache', { planDigest: planned.plan.digest, operationId: accepted.operationId,
    baseUnchanged: true, directoryRemoved: true, noRetainedPreparationOwner: true });
});

test('ENVIRONMENT-CANCEL-02 Launcher close waits for active venv preparation cancellation and confirmed directory cleanup', options, async t => {
  const app = await workspace(t), api = await launcher(app), before = await baseSnapshot(), { planned, cache } = await ready(app, api);
  blockRemoteFetch(t);
  const accepted = await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true });
  await copiedDirectory(planned.plan.destination);
  await api.server.close();
  const operation = api.server.manager.operation(accepted.operationId);
  assert.equal(operation.state, 'failed'); assert.equal(operation.error.code, 'PREPARATION_CANCELLED');
  assert.notEqual(operation.error.cleanupIncomplete, true); assert.equal(api.server.manager.preparationOwners.size, 0);
  assert.equal(await exists(planned.plan.destination), false); assert.equal(await exists(join(app.root, 'launcher-owner.lock')), false);
  await pause(150); assert.equal(await exists(planned.plan.destination), false);
  assert.deepEqual(await baseSnapshot(), before); assert.equal(sha(await readFile(join(cache, PYTHON_RECIPE.filename))), PYTHON_RECIPE.sha256);
  app.record('launcher-close-confirms-own-environment-tool-stop-before-cleanup', { operationId: accepted.operationId, baseUnchanged: true,
    directoryRemoved: true, launcherOwnershipReleased: true });
});
