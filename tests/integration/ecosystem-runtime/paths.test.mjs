import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ordinaryPath, privateJson, readBounded } from '../../../scripts/runtime/paths.mjs';
import { createLock, inspectPackage, importPackage, startInstance, exportInstance } from '../../../scripts/runtime/runtime.mjs';
import { reserveEvidenceRun } from '../../helpers/evidence-run.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const runFile = promisify(execFile);
const python = process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-8dot3-regression-'));
  const canonicalDirectory = await realpath(directory), canonicalTemporary = await realpath(tmpdir());
  const evidence = await reserveEvidenceRun(join(ROOT, '.artifacts/ecosystem-paths'));
  const sessions = [], checkpoints = [], pids = new Set();
  t.after(async () => {
    for (const session of [...sessions].reverse()) await session.close();
    for (const pid of pids) assert.equal(alive(pid), false, `Owned path-regression process ${pid} survived cleanup`);
    await writeFile(join(evidence.directory, 'scene.json'), JSON.stringify({ name: t.name, platform: process.platform,
      checkpoints, processes: [...pids].map(pid => ({ pid, aliveAfterCleanup: alive(pid) })) }, null, 2) + '\n');
    t.diagnostic('RUNTIME_PATHS_EVIDENCE ' + JSON.stringify({ scene: join(evidence.directory, 'scene.json'), checkpoints: checkpoints.length }));
    assert.ok(same(dirname(canonicalDirectory), canonicalTemporary));
    assert.ok(basename(canonicalDirectory).startsWith('world-hub-8dot3-regression-'));
    await rm(canonicalDirectory, { recursive: true, force: true });
  });
  return { directory: canonicalDirectory, sessions, pids, record: (label, details = {}) => checkpoints.push({ label, ...details }) };
}

async function shortPath(directory) {
  // Actual Win32 name resolution, not a manufactured spelling or mocked API.
  const program = `import ctypes,json,sys
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
paths={}
for name in ('GetLongPathNameW','GetShortPathNameW'):
    function=getattr(kernel,name)
    function.argtypes=[ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_uint]
    function.restype=ctypes.c_uint
    buffer=ctypes.create_unicode_buffer(32768)
    length=function(sys.argv[1],buffer,len(buffer))
    paths[name]={'path':buffer.value,'length':length,'error':ctypes.get_last_error()}
print(json.dumps(paths))`;
  const { stdout } = await runFile(python, ['-c', program, directory], { timeout: 10000, windowsHide: true });
  const paths = JSON.parse(stdout);
  for (const value of Object.values(paths)) assert.ok(value.length > 0 && value.length < 32768, JSON.stringify(paths));
  return { longPath: paths.GetLongPathNameW.path, shortPath: paths.GetShortPathNameW.path };
}

async function packageFixture(directory) {
  const source = join(directory, 'modules/fixture'); await mkdir(join(source, 'sdk'), { recursive: true });
  await copyFile(join(ROOT, 'tests/integration/ecosystem-runtime/fixtures/program.mjs'), join(source, 'program.mjs'));
  for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(ROOT, 'sdk/javascript', file), join(source, 'sdk', file));
  await privateJson(join(source, 'package.json'), { imports: { '#bridge': './sdk/bridge-kit.mjs' } });
  await privateJson(join(source, 'module.json'), { format: 'world-hub.module/v1', id: 'test.alias', version: '1.0.0', license: 'MIT',
    platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [],
    permissions: { filesystem: 'instance-state', network: ['hub-loopback', 'loopback-listen'], processes: 'none' } });
  await privateJson(join(directory, 'pack.json'), { format: 'world-hub.pack/v1', id: 'test.paths', version: '1.0.0', title: 'Native path regression', license: 'MIT',
    topics: { data: 'acceptance/path/data' }, components: [{ id: 'fixture', module: 'test.alias', after: [], settings: {},
      bridges: { main: { publish: ['data'], subscribe: ['data'] } } }], bindings: [], entry: { component: 'fixture' },
    startupTimeoutMs: 5000, healthTimeoutMs: 1000, stopTimeoutMs: 500 });
  await createLock(directory, { nodePath: process.execPath });
}

test('RUNTIME-PATHS-01 ordinary paths resolve and writes through a symbolic parent are rejected', { timeout: 30000 }, async t => {
  const app = await workspace(t), file = join(app.directory, 'existing.txt'); await writeFile(file, 'existing ordinary file');
  assert.ok(same(await ordinaryPath(file), await realpath(file))); assert.equal((await readBounded(file)).toString(), 'existing ordinary file');
  const future = join(app.directory, 'new parent', 'private.json');
  assert.ok(same(await ordinaryPath(future, { allowMissing: true }), future));
  await privateJson(future, { marker: 'ordinary-write' });
  assert.deepEqual(JSON.parse((await readBounded(future)).toString()), { marker: 'ordinary-write' });
  const outside = join(app.directory, 'outside'); await mkdir(outside);
  const link = join(app.directory, 'symbolic-parent'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ordinaryPath(join(link, 'new.json'), { allowMissing: true }), /symbolic|link|reparse/i);
  await assert.rejects(privateJson(join(link, 'new.json'), { marker: 'must-not-write' }), /symbolic|link|reparse/i);
  await assert.rejects(lstat(join(outside, 'new.json')), { code: 'ENOENT' });
  app.record('ordinary-read-write-and-link-refusal', { symbolicParentType: process.platform === 'win32' ? 'junction' : 'symlink' });
});

if (process.platform === 'win32') test('RUNTIME-PATHS-02 native Windows 8.3 aliases support file IO and real import/start/export while junctions remain refused', { timeout: 60000 }, async t => {
  const app = await workspace(t), paths = await shortPath(app.directory);
  if (same(paths.shortPath, paths.longPath)) {
    app.record('windows-short-name-unavailable', paths);
    assert.equal(/~\d/.test(process.env.TEMP ?? ''), false, 'A Windows runner already using 8.3 TEMP aliases must execute the regression');
    t.skip('Windows volume does not provide an 8.3 alias for the newly created temporary directory'); return;
  }
  assert.match(paths.shortPath, /~\d/); assert.ok(same(await realpath(paths.shortPath), app.directory));
  const file = join(app.directory, 'existing.txt'); await writeFile(file, 'native alias read');
  const aliasFile = join(paths.shortPath, 'existing.txt');
  assert.ok(same(await ordinaryPath(aliasFile), await realpath(file)));
  assert.equal((await readBounded(aliasFile)).toString(), 'native alias read');
  const missing = join(paths.shortPath, 'future parent', 'nested', 'private.json');
  assert.ok(same(await ordinaryPath(missing, { allowMissing: true }), join(app.directory, 'future parent', 'nested', 'private.json')));
  await privateJson(missing, { marker: 'native-short-write' });
  assert.deepEqual(JSON.parse(await readFile(join(app.directory, 'future parent', 'nested', 'private.json'), 'utf8')), { marker: 'native-short-write' });
  const pack = join(paths.shortPath, 'source package'); await packageFixture(pack);
  const root = join(paths.shortPath, 'deployment root'), instanceId = 'alias', environment = { nodePath: process.execPath };
  const imported = await importPackage(pack, { root, instanceId, ...environment });
  const session = await startInstance({ root, instanceId, trust: imported.digest, ...environment }); app.sessions.push(session);
  const status = await session.status(); app.pids.add(status.hub.pid); status.components.forEach(component => app.pids.add(component.pid));
  assert.equal(status.state, 'running'); assert.equal(status.components[0].communication, 'connected');
  const response = await fetch(session.ready.entryUrl, { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).connected, [true]);
  const exported = join(paths.shortPath, 'export destination');
  const result = await exportInstance({ root, instanceId, destination: exported, ...environment }); assert.equal(result.digest, imported.digest);
  assert.equal((await inspectPackage(exported, environment)).digest, imported.digest);
  await session.close();
  const outside = join(app.directory, 'outside-alias'); await mkdir(outside);
  const junction = join(paths.shortPath, 'alias-junction'); await symlink(outside, junction, 'junction');
  await assert.rejects(ordinaryPath(join(junction, 'new.json'), { allowMissing: true }), /symbolic|link|reparse/i);
  await assert.rejects(privateJson(join(junction, 'new.json'), { marker: 'must-not-write' }), /symbolic|link|reparse/i);
  await assert.rejects(importPackage(pack, { root: junction, instanceId: 'blocked', ...environment }), /symbolic|link|reparse/i);
  await assert.rejects(lstat(join(outside, 'new.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(outside, 'instances')), { code: 'ENOENT' });
  app.record('native-alias-deploy-with-junction-refusal', { ...paths, importedDigest: imported.digest, state: status.state,
    ordinaryFilesRead: 1, privateFilesWritten: 1, actualExternalProcesses: app.pids.size });
});
