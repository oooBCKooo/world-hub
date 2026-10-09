import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, mkdir, cp, lstat, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildDemoPackages, DEMO_PROFILE_IDS, DEMO_SOURCE_FILES, parseDemoBuildArguments } from './build-demo-packages.mjs';
import { verifyDemoPackage } from './verify-demo-package.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let temporaryRoot, built, version;
before(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'world-hub-demo-distribution-'));
  version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
  built = await buildDemoPackages({ sourceRoot: repository, outputRoot: join(temporaryRoot, '中文 空格 源码整合包') });
});
after(async () => {
  if (!temporaryRoot) return;
  assert.equal(dirname(resolve(temporaryRoot)), resolve(tmpdir()));
  assert.ok(basename(temporaryRoot).startsWith('world-hub-demo-distribution-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});

test('builder arguments reject missing, unknown, duplicate and invalid profiles', () => {
  assert.deepEqual(parseDemoBuildArguments([]), {});
  assert.deepEqual(parseDemoBuildArguments(['--profile', 'digital-world', '--output-root', '中文 目录', '--runtime', 'runtime']),
    { profile: 'digital-world', outputRoot: '中文 目录', runtimeDirectory: 'runtime' });
  for (const args of [['--profile'], ['--runtime', ''], ['--output-root', '--profile', 'all'],
    ['--profile', 'all', '--profile', 'event-desk'], ['--unknown', 'value'], ['--profile', '../digital-world']]) {
    assert.throws(() => parseDemoBuildArguments(args), /Missing|Unknown|Duplicate/);
  }
});

test('all profiles are separate source packages with exact allowlist and fixed startup selection', async () => {
  assert.equal(built.passed, true);
  assert.deepEqual(built.packages.map(item => item.profile), DEMO_PROFILE_IDS);
  for (const result of built.packages) {
    assert.equal(result.kind, 'source');
    assert.equal(result.runtimeVerified, false);
    assert.equal(result.excludedUserData, true);
    assert.equal(basename(result.directory), `world-hub-${version}-${result.profile}-source`);
    const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));
    const profile = JSON.parse(await readFile(join(result.directory, 'demo-profile.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(join(result.directory, 'package.json'), 'utf8'));
    assert.equal(manifest.purposeProfile, result.profile);
    assert.equal(profile.profile, result.profile);
    assert.equal(profile.version, version);
    assert.equal(manifest.runtime, null);
    assert.deepEqual(manifest.mutable, ['data/**']);
    assert.ok(pkg.scripts.start.endsWith(`--profile ${result.profile} --open`));
    assert.ok(pkg.scripts.check.endsWith(`--profile ${result.profile} --check`));
    assert.equal(pkg.scripts['verify:package'], 'node scripts/release/verify-demo-package.mjs');
    const expected = [...DEMO_SOURCE_FILES, 'package.json', 'demo-profile.json', 'README.md',
      'start.cmd', 'check.cmd', 'verify.cmd'].sort();
    assert.deepEqual(manifest.files.map(item => item.path).sort(), expected);
    assert.ok(manifest.files.some(item => item.path === 'README.en.md' && item.role === 'documentation'));
    const chineseReadme = await readFile(join(result.directory, 'README.md'), 'utf8');
    const englishReadme = await readFile(join(result.directory, 'README.en.md'), 'utf8');
    assert.match(chineseReadme, /\[English\]\(README\.en\.md\)/);
    for (const match of englishReadme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|mailto:|#)/i.test(match[1])) continue;
      await access(resolve(result.directory, match[1].replace(/#.*$/, '').replace(/:\d+$/, '')));
    }
    assert.ok(manifest.files.every(item => !/(?:^|\/)(?:\.local|\.artifacts|data|node_modules|fixtures|conformance|integration)(?:\/|$)/.test(item.path)));
    for (const item of manifest.files.filter(item => item.role !== 'documentation')) {
      if (!DEMO_SOURCE_FILES.includes(item.path)) continue;
      assert.equal(hash(await readFile(join(result.directory, item.path))), hash(await readFile(join(repository, item.path))), item.path);
    }
    assert.equal((await verifyDemoPackage(result.directory)).passed, true);
    const archive = await readFile(result.archive);
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.equal(hash(archive), result.archiveSha256);
    assert.equal((await readFile(result.archive + '.sha256', 'utf8')).trim(), `${result.archiveSha256}  ${basename(result.archive)}`);
  }
});

test('source check runs from unrelated cwd without creating data and rejects another profile', async () => {
  const cwd = join(temporaryRoot, '外部 工作目录');
  await mkdir(cwd);
  for (const result of built.packages) {
    const script = join(result.directory, 'examples/purpose-demos/run-demo.mjs');
    const checked = spawnSync(process.execPath, [script, '--profile', result.profile, '--check'],
      { cwd, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    assert.equal(checked.error, undefined);
    assert.equal(checked.status, 0, checked.stderr);
    const receipt = JSON.parse(checked.stdout.trim());
    assert.equal(receipt.passed, true);
    assert.equal(receipt.persisted, false);
    assert.equal(receipt.profile, result.profile);
    assert.deepEqual(await readdir(cwd), []);
    await assert.rejects(lstat(join(result.directory, 'data')), { code: 'ENOENT' });
    const other = DEMO_PROFILE_IDS.find(profile => profile !== result.profile);
    const mismatched = spawnSync(process.execPath, [script, '--profile', other, '--check'],
      { cwd, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    assert.equal(mismatched.error, undefined);
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /profile|场景/i);
    await assert.rejects(lstat(join(result.directory, 'data')), { code: 'ENOENT' });
  }
});

test('Windows wrappers preserve absolute paths, fixed profile, runtime priority and exit codes', async () => {
  for (const result of built.packages) {
    for (const mode of ['start', 'check', 'verify']) {
      const text = await readFile(join(result.directory, mode + '.cmd'), 'utf8');
      assert.ok(text.includes('setlocal DisableDelayedExpansion'));
      assert.ok(text.includes('chcp 65001 >nul'));
      assert.ok(text.includes('set "DEMO_NODE=%~dp0runtime\\node.exe"'));
      assert.ok(text.includes('if exist "%DEMO_NODE%" goto runtime_ready'));
      assert.ok(text.includes('where node >nul 2>nul'));
      assert.ok(text.includes('exit /b %DEMO_RESULT%'));
      if (mode === 'verify') assert.ok(text.includes('%~dp0scripts\\release\\verify-demo-package.mjs'));
      else assert.ok(text.includes(`%~dp0examples\\purpose-demos\\run-demo.mjs" --profile ${result.profile} --${mode === 'start' ? 'open' : 'check'}`));
    }
  }
});

test('overwriting any directory or neighboring archive/report is refused before all-profile writes', async () => {
  const original = built.packages[0];
  const before = hash(await readFile(join(original.directory, 'manifest.json')));
  await assert.rejects(buildDemoPackages({ sourceRoot: repository, profile: original.profile, outputRoot: dirname(original.directory) }), /Refusing to overwrite/);
  assert.equal(hash(await readFile(join(original.directory, 'manifest.json'))), before);
  for (const suffix of ['', '.zip', '.zip.sha256', '.build.json']) {
    const outputRoot = join(temporaryRoot, 'reserved-' + (suffix || 'directory').replaceAll('.', '-'));
    await mkdir(outputRoot);
    const directory = join(outputRoot, `world-hub-${version}-modular-assistant-source`);
    if (suffix) await writeFile(directory + suffix, 'preserved target', { flag: 'wx' });
    else await mkdir(directory);
    await assert.rejects(buildDemoPackages({ sourceRoot: repository, outputRoot }), /Refusing to overwrite/);
    assert.deepEqual(await readdir(outputRoot), [basename(directory + suffix)]);
    if (suffix) assert.equal(await readFile(directory + suffix, 'utf8'), 'preserved target');
  }
});

test('single-profile selection creates only its own package and adjacent artifacts', async () => {
  const outputRoot = join(temporaryRoot, '仅 世界场景');
  const single = await buildDemoPackages({ sourceRoot: repository, profile: 'digital-world', outputRoot });
  assert.equal(single.packages.length, 1);
  assert.equal(single.packages[0].profile, 'digital-world');
  assert.deepEqual((await readdir(outputRoot)).sort(), [
    `world-hub-${version}-digital-world-source`, `world-hub-${version}-digital-world-source.build.json`,
    `world-hub-${version}-digital-world-source.zip`, `world-hub-${version}-digital-world-source.zip.sha256`,
  ].sort());
  const invalidOutput = join(temporaryRoot, '无效 选择');
  await assert.rejects(buildDemoPackages({ sourceRoot: repository, profile: '../outside', outputRoot: invalidOutput }), /Unknown demo profile/);
  await assert.rejects(lstat(invalidOutput), { code: 'ENOENT' });
});

test('data is allowed but source/config damage and extra files fail verification without bypass', async () => {
  const changed = join(temporaryRoot, '修改 检查');
  await cp(built.packages[0].directory, changed, { recursive: true, force: false, errorOnExist: true });
  await mkdir(join(changed, 'data', 'runs'), { recursive: true });
  await writeFile(join(changed, 'data/runs/owned-demo-state.json'), '{"onlyThisRun":true}\n');
  assert.equal((await verifyDemoPackage(changed)).passed, true);
  await writeFile(join(changed, 'config/hub.json'), '\n', { flag: 'a' });
  let checked = await verifyDemoPackage(changed);
  assert.equal(checked.passed, false);
  assert.ok(checked.failed.some(item => item.path === 'config/hub.json'));
  const bypass = spawnSync(process.execPath, [join(changed, 'scripts/release/verify-demo-package.mjs'), '--allow-config-change'],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  assert.equal(bypass.status, 1);
  assert.match(bypass.stderr, /bypass is not supported/);
  await writeFile(join(changed, 'examples/purpose-demos/peer.mjs'), '\n// changed copy\n', { flag: 'a' });
  await writeFile(join(changed, 'unlisted.json'), '{}\n');
  checked = await verifyDemoPackage(changed);
  assert.ok(checked.failed.some(item => item.path === 'examples/purpose-demos/peer.mjs'));
  assert.ok(checked.failed.some(item => item.path === 'unlisted.json'));
});

test('unsafe manifest entries and a mismatched fixed profile are rejected', async () => {
  const changed = join(temporaryRoot, '非法 清单');
  await cp(built.packages[1].directory, changed, { recursive: true, force: false, errorOnExist: true });
  const profilePath = join(changed, 'demo-profile.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  await writeFile(profilePath, JSON.stringify({ ...profile, profile: 'event-desk' }));
  await assert.rejects(verifyDemoPackage(changed), /mismatched demo package profile/);
  await writeFile(profilePath, JSON.stringify(profile));
  const manifestPath = join(changed, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[0].path = '../outside.mjs';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyDemoPackage(changed), /Unsafe/);
});

test('output ancestors, symlinked paths and unverified runtimes cannot redirect a build', async () => {
  for (const outputRoot of [repository, dirname(repository)]) {
    await assert.rejects(buildDemoPackages({ sourceRoot: repository, outputRoot }), /must not contain the source/);
  }
  const actual = join(temporaryRoot, 'junction-target');
  const redirected = join(temporaryRoot, 'redirected-output');
  await mkdir(actual);
  await symlink(actual, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildDemoPackages({ sourceRoot: repository, outputRoot: redirected }), /Symbolic link path/);
  assert.deepEqual(await readdir(actual), []);
  const sourceLink = join(temporaryRoot, 'redirected-source');
  await symlink(repository, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');
  const rejectedOutput = join(temporaryRoot, 'rejected-source-output');
  await assert.rejects(buildDemoPackages({ sourceRoot: sourceLink, outputRoot: rejectedOutput }), /Symbolic link path/);
  await assert.rejects(lstat(rejectedOutput), { code: 'ENOENT' });
  const runtime = join(temporaryRoot, 'invalid-runtime');
  await mkdir(runtime);
  for (const name of ['node.exe', 'LICENSE', 'SHASUMS256.txt']) await writeFile(join(runtime, name), 'unverified');
  await writeFile(join(runtime, 'provenance.json'), JSON.stringify({ version: '22.23.2', platform: 'win32', arch: 'x64' }));
  const runtimeOutput = join(temporaryRoot, 'invalid-runtime-output');
  await assert.rejects(buildDemoPackages({ sourceRoot: repository, runtimeDirectory: runtime, outputRoot: runtimeOutput }), /Runtime checksum\/provenance/);
  await assert.rejects(lstat(runtimeOutput), { code: 'ENOENT' });
});
