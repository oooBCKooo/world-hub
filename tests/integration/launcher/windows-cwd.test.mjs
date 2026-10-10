import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, stat, writeFile, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { ownProcess } from '../../../scripts/runtime/process.mjs';
import { createLock, inspectPackage, importPackage, startInstance, statusInstance } from '../../../scripts/runtime/index.mjs';
import { planPythonEnvironment } from '../../../tools/launcher/environment-prepare.mjs';
import { probe } from '../../../tools/launcher/environment.mjs';
import { workspace, fixturePackage, samplePackage, environment, analyze, expectedText, alive, json } from './helpers.mjs';

const options = { timeout: 120000, concurrency: false, skip: process.platform !== 'win32' };
const text = '独立程序的相对路径读写 🌍\nUnicode and spaces remain intact';

async function deepDirectory(app, leaf) {
  let directory = join(app.directory, '中文 spaces');
  while (directory.length < 345) directory = join(directory, '深层目录 with spaces');
  directory = join(directory, leaf);
  const suffix = relative(resolve(app.directory), resolve(directory));
  assert.ok(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep),
    'Deep test directory must stay inside the helper-owned temporary workspace');
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  assert.ok(canonical.length >= 300, `Physical cwd is too short to exercise Windows MAX_PATH: ${canonical.length}`);
  return directory;
}

async function samePhysicalDirectory(actual, expected) {
  // A child can report an 8.3 spelling or a \\?\ prefix. Resolve both physically
  // instead of making the program's literal cwd spelling part of the contract.
  const [actualCanonical, expectedCanonical, actualStat, expectedStat] = await Promise.all([
    realpath(actual), realpath(expected), stat(actual), stat(expected),
  ]);
  assert.equal(actualCanonical.toLowerCase(), expectedCanonical.toLowerCase());
  assert.deepEqual({ dev: actualStat.dev, ino: actualStat.ino }, { dev: expectedStat.dev, ino: expectedStat.ino });
  return expectedCanonical;
}

function captureSpawns(app) {
  const original = childProcess.spawn, captured = [];
  childProcess.spawn = function (...args) {
    const child = original.apply(this, args);
    captured.push({ child, cwd: args[2]?.cwd });
    if (child.pid) app.trackedPids.add(child.pid);
    return child;
  };
  syncBuiltinESMExports();
  app.cleanups.push(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  return captured;
}

const nodeProgram = String.raw`
const fs = require('node:fs');
const input = fs.readFileSync('input 中文.txt', 'utf8');
fs.writeFileSync('node 输出.txt', input, 'utf8');
process.stdout.write(JSON.stringify({ event: 'ready', cwd: process.cwd(), text: input }) + '\n');
const keepalive = setInterval(() => {}, 1000);
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  if (JSON.parse(line).command === 'stop') { clearInterval(keepalive); process.exit(0); }
});`;
const pythonProgram = String.raw`
import json, os, pathlib, sys
text = pathlib.Path('input 中文.txt').read_text(encoding='utf-8')
pathlib.Path('python 输出.txt').write_text(text, encoding='utf-8', newline='')
print(json.dumps({'event': 'ready', 'cwd': os.getcwd(), 'text': text}, ensure_ascii=False), flush=True)
for line in sys.stdin:
    if json.loads(line).get('command') == 'stop':
        sys.exit(0)
`;

for (const kind of ['node', 'python']) test(`WIN-CWD-${kind} actual child preserves a Unicode working directory longer than 300 characters, relative I/O and graceful ownership`, options, async t => {
  const app = await workspace(t), directory = await deepDirectory(app, kind);
  await writeFile(join(directory, 'input 中文.txt'), text, 'utf8');
  const interpreter = await probe(kind === 'node' ? environment.nodePath : environment.pythonPath, kind);
  assert.equal(interpreter.available, true, 'Select and resolve the actual interpreter before filtering its process environment');
  const handle = ownProcess(interpreter.executable,
    kind === 'node' ? ['-e', nodeProgram] : ['-B', '-s', '-c', pythonProgram], { cwd: directory });
  if (handle.pid) app.trackedPids.add(handle.pid);
  app.cleanups.push(() => handle.stop(2000));
  const ready = await handle.waitFor(event => event.event === 'ready', 15000);
  assert.equal(ready.text, text);
  const canonical = await samePhysicalDirectory(ready.cwd, directory);
  assert.equal(await readFile(join(directory, `${kind} 输出.txt`), 'utf8'), text);
  const exit = await handle.stop(2000);
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  assert.equal(handle.forced, undefined); assert.equal(handle.error, undefined); assert.equal(alive(handle.pid), false);
  app.record('real-deep-working-directory-and-graceful-stop', { kind, cwdLength: directory.length,
    canonicalCwdLength: canonical.length, reportedCwdLength: ready.cwd.length, namespacedCwdLength: toNamespacedPath(directory).length,
    unicodeAndSpaces: true, relativeReadWrite: true, physicalDirectoryPreserved: true, forcedStop: false, exit });
});

test('WIN-CWD-runtime actual deep instance starts Hub and JS/Python programs, communicates through bridges and closes every owned child', options, async t => {
  const app = await workspace(t), root = await deepDirectory(app, 'instances root'), directory = await samplePackage(app);
  const statsFile = join(directory, 'modules/stats/program.py'), statsSource = await readFile(statsFile, 'utf8');
  const importLine = 'from hub_bridge import Bridge, BridgeError';
  assert.ok(statsSource.includes(importLine));
  await writeFile(statsFile, statsSource.replace(importLine, `try:
    import world_hub_state_only_probe
except ModuleNotFoundError as error:
    assert error.name == 'world_hub_state_only_probe'
else:
    raise RuntimeError('Unreviewed state-only helper was imported')
Path('cwd-security-check.json').write_text(json.dumps({'cwd': str(Path.cwd()), 'argv': sys.argv,
    'file': __file__, 'importPath': sys.path, 'stateOnlyImportRejected': True}), encoding='utf-8')

${importLine}`));
  await createLock(directory, environment);
  const imported = await importPackage(directory, { root, instanceId: 'deep-desk', ...environment });
  const statsState = join(imported.stateDir, 'programs/stats'); await mkdir(statsState, { recursive: true });
  await writeFile(join(statsState, 'world_hub_state_only_probe.py'),
    "from pathlib import Path\nPath('unreviewed-imported.json').write_text('unsafe')\nraise RuntimeError('Unreviewed state helper executed')\n");
  await writeFile(join(statsState, 'runpy.py'), "raise RuntimeError('State shadowed standard-library bootstrap')\n");
  const captured = captureSpawns(app);
  let session;
  try {
    session = await startInstance({ root, instanceId: 'deep-desk', trust: imported.digest, ...environment });
  } catch (error) {
    if (error.runtimeSession) app.cleanups.push(() => error.runtimeSession.close());
    app.observe(await statusInstance({ root, instanceId: 'deep-desk' }));
    app.record('deep-runtime-startup-failure', { rootCwdLength: (await realpath(root)).length, error: error.stack ?? String(error) });
    throw error;
  }
  app.cleanups.push(() => session.close());
  const running = app.observe(await session.status());
  assert.equal(running.state, 'running'); assert.equal(running.components.length, 3);
  assert.equal(captured.length, 4, 'The real Runtime must own exactly one Hub and three programs');
  assert.ok(running.components.every(component => component.readiness === 'ready' && component.health.ready && component.communication === 'connected'));
  const result = (await analyze(session.ready.entryUrl, text)).result;
  assert.deepEqual(result.output, expectedText(text)); assert.equal(result.receipts.length, 3);
  const pythonObservation = await json(join(statsState, 'cwd-security-check.json'));
  assert.equal(pythonObservation.stateOnlyImportRejected, true); assert.equal(pythonObservation.importPath.includes(''), false);
  await samePhysicalDirectory(pythonObservation.cwd, statsState);
  await samePhysicalDirectory(pythonObservation.importPath[0], join(imported.stateDir, 'package/modules/stats'));
  assert.equal(await realpath(pythonObservation.file), await realpath(join(imported.stateDir, 'package/modules/stats/program.py')));
  assert.equal(await realpath(pythonObservation.argv[0]), await realpath(pythonObservation.file));
  assert.deepEqual(pythonObservation.argv.slice(1), ['--runtime-config', join(session.ready.stateDir, 'runs', running.runId, 'stats.json')]);
  await assert.rejects(lstat(join(statsState, 'unreviewed-imported.json')), { code: 'ENOENT' });
  const componentCwdLengths = [];
  for (const child of session.children.filter(child => child.id !== '$hub')) {
    const config = await json(join(session.ready.stateDir, 'runs', running.runId, child.id + '.json'));
    const cwd = await realpath(config.stateDir);
    assert.ok(cwd.length >= 300); componentCwdLengths.push({ component: child.id, cwdLength: cwd.length });
    // Verify the actual spawn invocation still uses the declared private state.
    const actual = captured.find(row => row.child === child.child);
    assert.ok(actual, 'Every Runtime child must be an actual captured spawn');
    await samePhysicalDirectory(actual.cwd, config.stateDir);
  }
  const hubSpawn = captured.find(row => row.child === session.children.find(child => child.id === '$hub').child);
  await samePhysicalDirectory(hubSpawn.cwd, join(session.ready.stateDir, 'runs', running.runId));
  const stopped = app.observe(await session.close());
  assert.equal(stopped.state, 'stopped'); assert.notEqual(stopped.cleanupIncomplete, true);
  assert.ok(stopped.components.every(component => component.exit?.code === 0 && !component.forcedStop));
  assert.equal(stopped.hub.exit.code, 0);
  for (const child of session.children) { assert.equal(child.exit.code, 0); assert.equal(child.forced, undefined); assert.equal(alive(child.pid), false); }
  await assert.rejects(lstat(join(session.ready.stateDir, 'owner.lock')), { code: 'ENOENT' });
  app.record('real-deep-runtime-cross-language-flow', { rootCwdLength: (await realpath(root)).length,
    componentCwdLengths, output: result.output, receiptCount: result.receipts.length,
    pythonEntryArgvAndCwdPreserved: true, stateOnlyHelperRejected: true, stateRunpyShadowRejected: true,
    hubAndAllProgramsReady: true, allOwnedChildrenExited: true, gracefulStops: true });
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
test('WIN-CWD-environment unsupported long Windows venv paths are refused before any process, download or environment creation', options, async t => {
  const app = await workspace(t), root = await deepDirectory(app, 'private environment root'), directory = await samplePackage(app);
  const base = await probe(environment.pythonPath, 'python'); assert.equal(base.available, true);
  const executableSha256 = sha256(await readFile(base.executable)), lockSha256 = sha256(await readFile(join(directory, 'pack.lock')));
  const existing = join(root, 'existing private venv'), existingExecutable = join(existing, 'Scripts/python.exe');
  await mkdir(dirname(existingExecutable), { recursive: true });
  await copyFile(base.executable, existingExecutable);
  await writeFile(join(existing, 'pyvenv.cfg'), 'home = ' + dirname(base.executable) + '\ninclude-system-site-packages = false\n');
  assert.ok((await realpath(existingExecutable)).length >= 300);
  const originalFetch = globalThis.fetch, originalSpawn = childProcess.spawn, originalSync = childProcess.spawnSync;
  let requests = 0, processAttempts = 0;
  childProcess.spawn = childProcess.spawnSync = () => { processAttempts++; throw new Error('Long venv guard must precede process execution'); };
  syncBuiltinESMExports();
  app.cleanups.push(() => { childProcess.spawn = originalSpawn; childProcess.spawnSync = originalSync; syncBuiltinESMExports(); });
  globalThis.fetch = (input, init) => {
    requests++; throw new Error('Long venv guard must precede remote requests');
  };
  app.cleanups.push(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(planPythonEnvironment({ root, directory, ...environment }), { code: 'ENVIRONMENT_PATH_TOO_LONG' });
  const existingProbe = await probe(existingExecutable, 'python');
  assert.equal(existingProbe.available, false); assert.match(existingProbe.error, /virtual-environment.*too long/i);
  assert.equal(processAttempts, 0); assert.equal(requests, 0);
  for (const name of ['environments', 'environment-cache']) await assert.rejects(lstat(join(root, name)), { code: 'ENOENT' });
  assert.equal(sha256(await readFile(join(directory, 'pack.lock'))), lockSha256);
  assert.equal(sha256(await readFile(existingExecutable)), executableSha256);
  childProcess.spawn = originalSpawn; childProcess.spawnSync = originalSync; syncBuiltinESMExports(); globalThis.fetch = originalFetch;
  assert.deepEqual(await probe(environment.pythonPath, 'python'), base);
  assert.equal(sha256(await readFile(base.executable)), executableSha256);
  app.record('real-long-venv-profile-refusal', { rootCwdLength: (await realpath(root)).length,
    existingExecutableLength: (await realpath(existingExecutable)).length, planningErrorCode: 'ENVIRONMENT_PATH_TOO_LONG',
    existingProbe, processAttempts, requests, noEnvironmentDirectoryCreated: true,
    lockAndSelectedBaseProbeAndExecutableUnchanged: true, limitation: 'Windows venv interpreter paths must be shorter than 248 characters' });
});

test('WIN-CWD-long-entry a long Python basename under a short code directory preserves local imports, argv and the main module after entry returns', options, async t => {
  const app = await workspace(t), directory = await samplePackage(app), moduleDir = join(directory, 'modules/stats');
  const originalFile = join(moduleDir, 'program.py'), originalSource = await readFile(originalFile, 'utf8');
  const entryName = 'program_中文 with spaces_' + 'x'.repeat(175) + '.py';
  let source = originalSource.replace('from hub_bridge import Bridge, BridgeError', `try:
    import world_hub_state_only_probe
except ModuleNotFoundError as error:
    assert error.name == 'world_hub_state_only_probe'
else:
    raise RuntimeError('State-only helper became importable')

from hub_bridge import Bridge, BridgeError`);
  source = source.replace('def result_for(message, config, caller):', `def result_for(message, config, caller):
    import __main__
    assert __main__.CONTRACT == CONTRACT
    Path('persistent-main.json').write_text(json.dumps({'contract': __main__.CONTRACT,
        'name': __main__.__name__, 'file': __main__.__file__, 'argv': sys.argv, 'cwd': str(Path.cwd()),
        'importPath': sys.path, 'loader': type(__main__.__loader__).__name__, 'stateOnlyImportRejected': True}), encoding='utf-8')`);
  const handlers = '    signal.signal(signal.SIGINT, stop)\n    signal.signal(signal.SIGTERM, stop)\n';
  assert.ok(source.includes(handlers)); source = source.replace(handlers, '');
  const bottom = source.indexOf('\nif __name__ == "__main__":');
  assert.ok(bottom > 0); source = source.slice(0, bottom) + `
if __name__ == '__main__':
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    def service():
        try:
            main()
        except Exception:
            if not stopping.is_set():
                emit({'event': 'module-diagnostic', 'code': 'PYTHON_MODULE_FAILED'})
                stop()
        finally:
            stop()
    threading.Thread(target=service, name='external-provider-service', daemon=False).start()
    Path('entry-returned.json').write_text(json.dumps({'argv': sys.argv, 'file': __file__}), encoding='utf-8')
`;
  await writeFile(join(moduleDir, entryName), source, 'utf8'); await unlink(originalFile);
  const manifestFile = join(moduleDir, 'module.json'), manifest = await json(manifestFile);
  manifest.runtime.entry = entryName; await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  await createLock(directory, environment);
  const imported = await importPackage(directory, { root: app.root, instanceId: 'long-entry', ...environment });
  const entry = join(imported.stateDir, 'package/modules/stats', entryName), codeDir = await realpath(dirname(entry));
  assert.ok(codeDir.length < 248, `Code directory must isolate the long-basename case: ${codeDir.length}`);
  assert.ok((await realpath(entry)).length > 260); assert.ok(entryName.length <= 240);
  const statsState = join(imported.stateDir, 'programs/stats'); await mkdir(statsState, { recursive: true });
  await writeFile(join(statsState, 'world_hub_state_only_probe.py'),
    "from pathlib import Path\nPath('unreviewed-imported.json').write_text('unsafe')\nraise RuntimeError('State-only helper executed')\n");
  await writeFile(join(statsState, 'tokenize.py'), "raise RuntimeError('State shadowed the source loader')\n");
  const captured = captureSpawns(app); let session;
  try { session = await startInstance({ root: app.root, instanceId: 'long-entry', trust: imported.digest, ...environment }); }
  catch (error) {
    if (error.runtimeSession) app.cleanups.push(() => error.runtimeSession.close());
    app.observe(await statusInstance({ root: app.root, instanceId: 'long-entry' }));
    app.record('long-basename-runtime-failure', { codeDirLength: codeDir.length, entryLength: entry.length, error: error.stack ?? String(error) });
    throw error;
  }
  app.cleanups.push(() => session.close()); const running = app.observe(await session.status());
  assert.equal(running.state, 'running'); assert.equal(captured.length, 4);
  const returned = await json(join(statsState, 'entry-returned.json'));
  assert.equal(await realpath(returned.file), await realpath(entry));
  // The request is handled by a non-daemon worker after the entry returned.
  // A temporary runpy main module would have been restored by this point.
  const result = (await analyze(session.ready.entryUrl, text)).result;
  assert.deepEqual(result.output, expectedText(text)); assert.equal(result.receipts.length, 3);
  const observed = await json(join(statsState, 'persistent-main.json'));
  assert.deepEqual(observed.contract, { id: 'text.statistics', version: '1.0.0' });
  assert.equal(observed.name, '__main__'); assert.equal(observed.loader, 'SourceFileLoader');
  assert.equal(observed.stateOnlyImportRejected, true); assert.equal(observed.importPath.includes(''), false);
  await samePhysicalDirectory(observed.importPath[0], codeDir); await samePhysicalDirectory(observed.cwd, statsState);
  assert.equal(await realpath(observed.file), await realpath(entry)); assert.equal(await realpath(observed.argv[0]), await realpath(entry));
  assert.deepEqual(observed.argv.slice(1), ['--runtime-config', join(imported.stateDir, 'runs', running.runId, 'stats.json')]);
  await assert.rejects(lstat(join(statsState, 'unreviewed-imported.json')), { code: 'ENOENT' });
  const stopped = app.observe(await session.close());
  assert.equal(stopped.state, 'stopped'); assert.notEqual(stopped.cleanupIncomplete, true);
  for (const child of session.children) { assert.equal(child.exit.code, 0); assert.equal(child.forced, undefined); assert.equal(alive(child.pid), false); }
  await assert.rejects(lstat(join(imported.stateDir, 'owner.lock')), { code: 'ENOENT' });
  app.record('real-long-basename-persistent-main-worker', { codeDirLength: codeDir.length,
    entryLength: (await realpath(entry)).length, basenameLength: entryName.length,
    persistentMainContract: observed.contract, sourceLoaderPreserved: true, argvAndCwdPreserved: true,
    stateOnlyHelperRejected: true, stateTokenizeShadowRejected: true, output: result.output,
    allOwnedChildrenExited: true, gracefulStops: true });
});

test('WIN-CWD-node-package a normally reviewed package-imports module is refused at a long destination before creating an instance or starting programs', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), root = await deepDirectory(app, 'node package root');
  const packageJson = join(directory, 'modules/fixture/package.json'), sourcePackageBytes = await readFile(packageJson);
  assert.equal(JSON.parse(sourcePackageBytes.toString('utf8')).imports['#bridge'], './sdk/bridge-kit.mjs');
  const sourcePackagePath = await realpath(packageJson); assert.ok(sourcePackagePath.length < 248);
  const sourceLockSha256 = sha256(await readFile(join(directory, 'pack.lock'))), captured = captureSpawns(app);
  const plan = await inspectPackage(directory, environment);
  assert.equal(plan.startsModules, false); assert.equal(plan.modules.length, 1);
  assert.equal(plan.modules[0].manifest.runtime.kind, 'node');
  assert.ok(plan.modules[0].files.some(file => file.path === 'package.json'));
  const instanceId = 'refused-node-package', stateDir = join(root, 'instances', instanceId);
  const destinationPackagePath = join(await realpath(root), 'instances', instanceId, 'package/modules/fixture/package.json');
  assert.ok(destinationPackagePath.length >= 248);
  await assert.rejects(importPackage(directory, { root, instanceId, ...environment }), { code: 'NODE_PACKAGE_PATH_TOO_LONG' });
  assert.equal(captured.length, 0, 'Read-only review and import refusal must start no owned Hub or module');
  assert.equal(app.trackedPids.size, 0);
  await assert.rejects(lstat(stateDir), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, 'instances')), { code: 'ENOENT' });
  assert.equal(sha256(await readFile(join(directory, 'pack.lock'))), sourceLockSha256);
  assert.deepEqual(await readFile(packageJson), sourcePackageBytes);
  await assert.rejects(lstat(join(directory, 'modules/fixture/runtime-observed.json')), { code: 'ENOENT' });
  app.record('real-node-package-scope-profile-refusal-before-import', { sourcePackagePathLength: sourcePackagePath.length,
    destinationPackagePathLength: destinationPackagePath.length, sourceReviewDigest: plan.digest,
    sourceAcceptedForReadOnlyReview: true, errorCode: 'NODE_PACKAGE_PATH_TOO_LONG', ownedProcessCount: captured.length,
    instanceDirectoryCreated: false, sourcePackageAndLockUnchanged: true,
    limitation: 'Windows Node module package.json paths must be shorter than 248 characters; no code or cwd rewrite' });
});
