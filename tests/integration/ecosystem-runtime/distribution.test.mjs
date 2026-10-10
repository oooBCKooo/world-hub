import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, cp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEcosystemPackage, ECOSYSTEM_SOURCE_FILES, ECOSYSTEM_PACK_FILES,
  parseEcosystemBuildArguments } from '../../../scripts/release/build-ecosystem-package.mjs';
import { ECOSYSTEM_RUNTIME_FILES, ECOSYSTEM_SCHEMA_FILES, LAUNCHER_FILES } from '../../../scripts/release/build-package.mjs';
import { verifyPackage } from '../../../scripts/release/verify-package.mjs';
import { createLock } from '../../../scripts/runtime/package.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const pythonPath = process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let temporary, source, bundle, built;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'world-hub-ecosystem-distribution-'));
  source = join(temporary, 'source'); await mkdir(source);
  for (const local of [...ECOSYSTEM_SOURCE_FILES.filter(path => !path.endsWith('/pack.lock')), 'package.json']) {
    await mkdir(dirname(join(source, local)), { recursive: true });
    await copyFile(join(repository, local), join(source, local));
  }
  await createLock(join(source, 'examples/ecosystem-pack'), { nodePath: process.execPath, pythonPath });
  bundle = join(temporary, '中文 空格 跨语言源码包');
  built = await buildEcosystemPackage({ sourceRoot: source, output: bundle });
});
after(async () => {
  if (!temporary) return;
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith('world-hub-ecosystem-distribution-'));
  await rm(temporary, { recursive: true, force: true });
});

test('ecosystem source distribution carries exact locked programs, Runtime and schemas without binary runtimes or private data', async () => {
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(built.kind, 'ecosystem-source'); assert.equal(built.bundledPython, false); assert.equal(built.bundledNode, false);
  assert.equal(manifest.runtime, null); assert.equal(manifest.externalRuntimes.node.version, '22.23.2');
  assert.equal(manifest.externalRuntimes.python.version, '3.14.0');
  assert.equal(manifest.externalRuntimes.python.packages.websockets, '15.0.1');
  assert.deepEqual(manifest.mutable, ['data/**']);
  assert.equal((await verifyPackage(bundle)).passed, true);
  for (const local of [...ECOSYSTEM_PACK_FILES, ...ECOSYSTEM_RUNTIME_FILES, ...ECOSYSTEM_SCHEMA_FILES, ...LAUNCHER_FILES]) {
    assert.equal(hash(await readFile(join(bundle, local))), hash(await readFile(join(source, local))), local);
  }
  assert.ok(manifest.files.every(item => !/(?:\.local|\.artifacts|node_modules|__pycache__|\/data\/|node\.exe|python\.exe|\/tests\/|\.pyc$)/.test(item.path)));
  assert.equal(hash(await readFile(built.archive)), built.archiveSha256);
  const pack = JSON.parse(await readFile(join(bundle, 'examples/ecosystem-pack/pack.json'), 'utf8'));
  assert.equal(pack.components.length, 3);
  const python = JSON.parse(await readFile(join(bundle, 'examples/ecosystem-pack/modules/stats/module.json'), 'utf8'));
  assert.equal(python.runtime.kind, 'python');
  const readme = await readFile(join(bundle, 'README.md'), 'utf8');
  assert.match(readme, /没有 Python 便携运行时/);
});

test('distributed Runtime CLI is self-contained and can inspect the byte-exact sample from an unrelated cwd', async () => {
  const cwd = join(temporary, 'different cwd'); await mkdir(cwd);
  const result = spawnSync(process.execPath, [join(bundle, 'bin/world-hub-pack.mjs'), 'plan',
    join(bundle, 'examples/ecosystem-pack'), '--node', process.execPath, '--python', pythonPath],
  { cwd, shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.startsModules, false); assert.equal(plan.sandbox, false);
  assert.equal(plan.modules.length, 3); assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal((await verifyPackage(bundle)).passed, true, 'Inspection must not mutate packaged files');
  const guide = await readFile(join(bundle, 'examples/ecosystem-pack/README.md'), 'utf8');
  for (const match of guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    await access(resolve(bundle, 'examples/ecosystem-pack', match[1].replace(/#.*$/, '')));
  }
});

test('ecosystem builder rejects overwritten destinations, locked file damage and extra module cache before creating output', async () => {
  await assert.rejects(buildEcosystemPackage({ sourceRoot: source, output: bundle }), /Refusing to overwrite/);
  const changed = join(temporary, 'changed'); await cp(source, changed, { recursive: true });
  await writeFile(join(changed, 'examples/ecosystem-pack/modules/stats/program.py'), '\n# changed\n', { flag: 'a' });
  const target = join(temporary, 'rejected-build');
  await assert.rejects(buildEcosystemPackage({ sourceRoot: changed, output: target }), /SHA-256 mismatch/);
  await assert.rejects(access(target), { code: 'ENOENT' });
  const extra = join(temporary, 'extra'); await cp(source, extra, { recursive: true });
  await writeFile(join(extra, 'examples/ecosystem-pack/modules/source/private.json'), '{"runtime":"generated"}');
  await assert.rejects(buildEcosystemPackage({ sourceRoot: extra, output: target }), /undeclared or generated files/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});

test('ecosystem source builder exposes a strict source-only command-line interface', () => {
  assert.deepEqual(parseEcosystemBuildArguments([]), {});
  assert.deepEqual(parseEcosystemBuildArguments(['--output', 'new-directory']), { output: 'new-directory' });
  assert.throws(() => parseEcosystemBuildArguments(['--runtime', 'python-directory']), /Usage/);
  assert.throws(() => parseEcosystemBuildArguments(['--output']), /Usage/);
});
