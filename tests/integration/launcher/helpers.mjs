import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock } from '../../../scripts/runtime/index.mjs';
import { reserveEvidenceRun } from '../../helpers/evidence-run.mjs';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const environment = { nodePath: process.execPath,
  pythonPath: process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
export const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
export const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const expectedText = text => ({ codePoints: [...text].length, lines: text.split('\n').length,
  utf8Bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(Buffer.from(text)).digest('hex') });

export async function until(fn, { timeoutMs = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await pause(80);
  }
  throw new Error(`Timed out waiting for ${label}${last ? ': ' + last.message : ''}`);
}

export async function filesBelow(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const file = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(root, file)); else result.push(file);
  }
  return result.sort();
}

export async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-launcher-test-'));
  const evidence = await reserveEvidenceRun(join(ROOT, '.artifacts/launcher'));
  const checkpoints = [], trackedPids = new Set(), cleanups = [];
  const observe = status => {
    if (status.hub?.pid) trackedPids.add(status.hub.pid);
    for (const component of status.components ?? []) if (component.pid) trackedPids.add(component.pid);
    return status;
  };
  const record = (label, details = {}) => checkpoints.push({ label, ...details });
  t.after(async () => {
    for (const cleanup of [...cleanups].reverse()) await cleanup();
    await save(join(evidence.directory, 'scene.json'), { name: t.name, checkpoints,
      processes: [...trackedPids].map(pid => ({ pid, aliveAfterCleanup: alive(pid) })) });
    t.diagnostic('LAUNCHER_EVIDENCE ' + JSON.stringify({ report: join(evidence.directory, 'scene.json'), checkpoints: checkpoints.length }));
    for (const pid of trackedPids) assert.equal(alive(pid), false, `Owned runtime process ${pid} survived cleanup`);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('world-hub-launcher-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root: join(directory, 'instances-root'), cleanups, observe, record, trackedPids };
}

export async function samplePackage(app) {
  const directory = join(app.directory, 'sample-' + randomUUID());
  await cp(join(ROOT, 'examples/ecosystem-pack'), directory, { recursive: true });
  await createLock(directory, environment);
  return directory;
}

export async function fixturePackage(app, { mode = 'normal', bridges = ['main'], startupTimeoutMs = 4000 } = {}) {
  const directory = join(app.directory, 'package-' + randomUUID()), source = join(directory, 'modules/fixture');
  await mkdir(join(source, 'sdk'), { recursive: true });
  await copyFile(join(ROOT, 'tests/integration/ecosystem-runtime/fixtures/program.mjs'), join(source, 'program.mjs'));
  if (mode === 'initial-health-unready') {
    const program = await readFile(join(source, 'program.mjs'), 'utf8');
    assert.ok(program.includes('ready: healthy &&'));
    await writeFile(join(source, 'program.mjs'), program.replace('ready: healthy &&', 'ready: false &&'));
  }
  for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(ROOT, 'sdk/javascript', file), join(source, 'sdk', file));
  await save(join(source, 'package.json'), { imports: { '#bridge': './sdk/bridge-kit.mjs' } });
  await save(join(source, 'module.json'), { format: 'world-hub.module/v1', id: 'test.fixture', version: '1.0.0', license: 'MIT',
    platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges,
    provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback', 'loopback-listen'], processes: 'none' } });
  await save(join(directory, 'pack.json'), { format: 'world-hub.pack/v1', id: 'test.launcher', version: '1.0.0', title: 'Launcher acceptance fixture', license: 'MIT',
    topics: { input: 'acceptance/input', output: 'acceptance/output' },
    components: [{ id: 'fixture', module: 'test.fixture', after: [], settings: { mode }, bridges:
      Object.fromEntries(bridges.map(slot => [slot, { publish: ['input', 'output'], subscribe: ['input', 'output'] }])) }],
    bindings: [], entry: { component: 'fixture' }, startupTimeoutMs, healthTimeoutMs: 1000, stopTimeoutMs: 500 });
  await createLock(directory, environment);
  return directory;
}

export async function requestJson(base, path, init = {}, expectedStatus = 200) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20000), redirect: 'error', ...init });
  const value = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(value));
  return value;
}

export const analyze = (entryUrl, text) => requestJson(entryUrl, '/analyze', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
