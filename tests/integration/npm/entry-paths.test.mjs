import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectExecution } from '../../../scripts/cli-entry.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const packageInfo = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
let evidence, linkedRoot, cwd;
before(async () => {
  const parent = join(repository, '.artifacts/cli-entry');
  await mkdir(parent, { recursive: true });
  evidence = await mkdtemp(join(parent, 'paths-'));
  linkedRoot = join(evidence, 'linked package');
  await symlink(repository, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  cwd = join(evidence, 'unrelated working directory'); await mkdir(cwd);
});

function execute(entry, args, flags = []) {
  const result = spawnSync(process.execPath, [...flags, entry, ...args], {
    cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  return result;
}
const checks = [
  { entry: 'bin/world-hub.mjs', args: ['--check', '--port', '0'], check: output => {
    const value = JSON.parse(output); assert.equal(value.persisted, false); assert.equal(value.transport.port, 0);
  } },
  { entry: 'bin/world-hub.mjs', args: ['ui', '--help'], check: output => assert.match(output, /world-hub ui/) },
  { entry: 'bin/world-hub-pack.mjs', args: ['--version'], check: output => assert.equal(output.trim(), packageInfo.version) },
  { entry: 'bin/world-hub-interop.mjs', args: ['--help'], check: output => assert.match(output, /world-hub-interop verify/) },
  { entry: 'tools/workshop/cli.mjs', args: ['--help'], check: output => assert.match(output, /World Hub Workshop/) },
  { entry: 'tools/launcher/cli.mjs', args: ['--help'], check: output => assert.match(output, /world-hub ui/) },
  { entry: 'scripts/launcher.mjs', args: ['--check'], check: output => assert.equal(JSON.parse(output).persisted, false) },
];
for (const variant of ['direct', 'directory link', 'preserved main link']) {
  for (const row of checks) test(`${row.entry} ${row.args.join(' ')} executes through ${variant}`, async () => {
    const entry = join(variant === 'direct' ? repository : linkedRoot, row.entry);
    const result = execute(entry, row.args, variant === 'preserved main link' ? ['--preserve-symlinks-main'] : []);
    assert.equal(result.status, 0, result.stderr); assert.notEqual(result.stdout, '', 'CLI must not silently exit');
    row.check(result.stdout); assert.deepEqual(await readdir(cwd), [], 'Read-only invocations must not create state');
  });
}

test('entry identification handles missing entries, unrelated modules and both aliases of the same file', async () => {
  const main = join(repository, 'bin/world-hub.mjs'), alias = join(linkedRoot, 'bin/world-hub.mjs');
  assert.equal(isDirectExecution(pathToFileURL(main), main), true);
  assert.equal(isDirectExecution(pathToFileURL(main), alias), true);
  assert.equal(isDirectExecution(pathToFileURL(alias), main), true);
  assert.equal(isDirectExecution(pathToFileURL(alias), alias), true);
  assert.equal(isDirectExecution(pathToFileURL(main), join(evidence, 'absent.mjs')), false);
  assert.equal(isDirectExecution(pathToFileURL(main), join(repository, 'bin/world-hub-pack.mjs')), false);
  assert.equal(isDirectExecution(pathToFileURL(main), ''), false);
  assert.equal(isDirectExecution('https://example.invalid/script.mjs', main), false);
  if (process.platform === 'win32') {
    assert.equal(isDirectExecution(pathToFileURL(main), main.toUpperCase()), true);
    assert.equal(isDirectExecution(pathToFileURL(main), '\\\\?\\' + main), true);
  }
});

const guardedEntries = [
  ...new Set(checks.map(row => row.entry)),
  'scripts/deploy/workshop-deployment.mjs',
  ...['build-demo-packages', 'build-ecosystem-package', 'build-independent-author-kit', 'build-package',
    'demo-package-acceptance', 'ecosystem-package-acceptance', 'npm-package-acceptance', 'prepare-runtime',
    'verify-demo-package', 'verify-package'].map(name => `scripts/release/${name}.mjs`),
  ...['composition', 'directory', 'processor-a', 'processor-b'].map(name => `examples/capability-directory/${name}.mjs`),
  ...['context-program', 'ui-program'].map(name => `examples/distributed-context/${name}.mjs`),
  ...['checklist-harness', 'explorer', 'extension-material', 'peer', 'run-demo', 'traffic-source'].map(name => `examples/purpose-demos/${name}.mjs`),
];
for (const flags of [[], ['--preserve-symlinks-main', '--preserve-symlinks']]) {
  test(`importing CLI modules has no output, state or command execution (${flags.length ? 'preserved links' : 'default'})`, async () => {
    const importer = join(cwd, flags.length ? 'importer-preserved.mjs' : 'importer.mjs');
    await writeFile(importer, `for (const url of ${JSON.stringify(guardedEntries.map(entry => pathToFileURL(join(linkedRoot, entry)).href))}) await import(url);\nconsole.log('imports-only');\n`);
    try {
      const result = execute(importer, ['--should-not-be-parsed'], flags);
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'imports-only\n'); assert.equal(result.stderr, '');
      assert.deepEqual(await readdir(cwd), [importer.split(/[\\/]/).at(-1)]);
    } finally {
      // Only this ordinary fixture file is removed. The source directory link is retained as evidence.
      await import('node:fs/promises').then(fs => fs.unlink(importer));
    }
  });
}

test('actual npm link into an isolated global prefix executes the generated commands', { timeout: 60000 }, async () => {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  let npmCli;
  for (const candidate of candidates) { try { await access(candidate); npmCli = candidate; break; } catch {} }
  assert.ok(npmCli, 'npm-cli.js must be available alongside the acceptance Node runtime');
  const prefix = join(evidence, 'npm prefix'), cache = join(evidence, 'npm cache');
  const sourceManifest = await readFile(join(repository, 'package.json'));
  const result = spawnSync(process.execPath, [npmCli, 'link', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], {
    cwd: repository, encoding: 'utf8', shell: false, windowsHide: true, timeout: 45000,
    env: { ...process.env, npm_config_prefix: prefix },
  });
  assert.equal(result.error, undefined, String(result.error)); assert.equal(result.status, 0, result.stderr);
  await writeFile(join(evidence, 'npm-link-result.json'), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, prefix }, null, 2) + '\n');
  const packageRoot = process.platform === 'win32' ? join(prefix, 'node_modules/world-hub') : join(prefix, 'lib/node_modules/world-hub');
  assert.equal(await realpath(packageRoot), await realpath(repository));
  assert.deepEqual(await readFile(join(repository, 'package.json')), sourceManifest, 'Linking must not alter source metadata');
  for (const row of checks.filter(row => Object.values(packageInfo.bin).includes(row.entry))) {
    const direct = execute(join(packageRoot, row.entry), row.args);
    assert.equal(direct.status, 0, direct.stderr); row.check(direct.stdout);
    const name = Object.entries(packageInfo.bin).find(([, entry]) => entry === row.entry)[0];
    const wrapper = process.platform === 'win32' ? join(prefix, name + '.cmd') : join(prefix, 'bin', name);
    let wrapped;
    if (process.platform === 'win32') {
      const command = `\"\"${wrapper}\" ${row.args.join(' ')}\"`;
      wrapped = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe'), ['/d', '/s', '/c', command], {
        cwd, encoding: 'utf8', shell: false, windowsHide: true, windowsVerbatimArguments: true, timeout: 15000,
      });
    } else wrapped = spawnSync(wrapper, row.args, { cwd, encoding: 'utf8', shell: false, timeout: 15000 });
    assert.equal(wrapped.error, undefined, String(wrapped.error)); assert.equal(wrapped.status, 0, wrapped.stderr); row.check(wrapped.stdout);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test('the linked npm entry serves the actual Hub and stops its owned process cleanly', { timeout: 30000 }, async () => {
  const runtimeCwd = join(evidence, 'linked real runtime'); await mkdir(runtimeCwd);
  const program = await startOwnedProgram(join(linkedRoot, 'bin/world-hub.mjs'), { cwd: runtimeCwd, args: ['--port', '0'] });
  try {
    const status = await fetch(`http://127.0.0.1:${program.ready.port}/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(status.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${program.ready.port}/manage`, { signal: AbortSignal.timeout(5000) })).status, 200);
    const config = JSON.parse(await readFile(join(runtimeCwd, 'world-hub-data/hub.json'), 'utf8'));
    assert.equal(config.log.dir, './log');
  } finally {
    assert.equal((await program.stop()).code, 0, program.stderr);
    await writeFile(join(evidence, 'linked-runtime-lifecycle.json'), JSON.stringify({ pid: program.child.pid, ready: program.ready,
      exit: program.exited, lines: program.lines, stderr: program.stderr }, null, 2) + '\n');
  }
  await assert.rejects(fetch(`http://127.0.0.1:${program.ready.port}/status`, { signal: AbortSignal.timeout(1000) }));
  assert.ok(!(await readdir(join(runtimeCwd, 'world-hub-data/log'))).includes('.world-hub-package.lock'));
});
