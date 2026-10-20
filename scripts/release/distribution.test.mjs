import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, cp, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPackage, AGENT_FILES, APPLICATION_FILES, SDK_FILES, SDK_DOCUMENTATION_FILES, MODULE_CONTRACT_FILES, DOCUMENTATION_IMAGE_FILES,
  ECOSYSTEM_SCHEMA_FILES, ECOSYSTEM_RUNTIME_FILES, LAUNCHER_FILES, WORKSHOP_FILES, BUNDLED_TEMPLATE_FILES } from './build-package.mjs';
import { verifyPackage } from './verify-package.mjs';
import { inspectPackageZip } from './inspect-package-zip.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let temporaryRoot, bundle, built;
before(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'world-hub-distribution-'));
  bundle = join(temporaryRoot, '中文 空格 源码包');
  built = await buildPackage({ sourceRoot: repository, output: bundle });
});
after(async () => {
  if (!temporaryRoot) return;
  assert.equal(dirname(resolve(temporaryRoot)), resolve(tmpdir()));
  assert.ok(basename(temporaryRoot).startsWith('world-hub-distribution-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});

test('source distribution is independent of local runtime caches and copies only declared runtime files', async () => {
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.kind, 'source');
  const metadata = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'));
  assert.equal(metadata.exports['./management'], './sdk/javascript/management-client.mjs');
  const commands = spawnSync(process.execPath, ['bin/world-hub.mjs', 'operations', '--json'], { cwd: bundle, encoding: 'utf8', windowsHide: true });
  assert.equal(commands.status, 0, commands.stderr);
  assert.ok(JSON.parse(commands.stdout).operations.some(operation => operation.name === 'resources.profiles.apply'));
  assert.equal(manifest.runtime, null);
  assert.equal(built.runtimeVerified, false);
  assert.equal((await verifyPackage(bundle)).passed, true);
  const zip = inspectPackageZip(await readFile(built.archive));
  assert.equal(zip.root, basename(bundle));
  assert.equal(zip.entries.length, manifest.files.length + 1);
  for (const path of [...APPLICATION_FILES, ...SDK_FILES, ...DOCUMENTATION_IMAGE_FILES, ...ECOSYSTEM_SCHEMA_FILES, ...ECOSYSTEM_RUNTIME_FILES, ...LAUNCHER_FILES, ...WORKSHOP_FILES, ...BUNDLED_TEMPLATE_FILES, ...AGENT_FILES]) {
    assert.equal(hash(await readFile(join(bundle, path))), hash(await readFile(join(repository, path))), path);
  }
  assert.ok(manifest.files.every(item => !/(?:\.local|\.artifacts|node_modules|__pycache__|\.bak|worker\.py|ProtocolWorker\.cs|harness-program|programs\.config)/.test(item.path)));
  assert.ok(manifest.files.some(item => item.path === 'README.en.md' && item.role === 'documentation'));
  assert.ok(!manifest.files.some(item => item.path.startsWith('examples/ecosystem-pack/modules/')), 'Business pack modules use a separate source distribution');
  assert.deepEqual(manifest.files.filter(item => item.role === 'documentation-image').map(item => item.path).sort(), [...DOCUMENTATION_IMAGE_FILES].sort());
  const chineseReadme = await readFile(join(bundle, 'README.md'), 'utf8');
  const englishReadme = await readFile(join(bundle, 'README.en.md'), 'utf8');
  assert.match(chineseReadme, /\[English\]\(README\.en\.md\)/);
  for (const match of englishReadme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|mailto:|#)/i.test(match[1])) continue;
    await access(resolve(bundle, match[1].replace(/#.*$/, '').replace(/:\d+$/, '')));
  }
  const start = await readFile(join(bundle, 'start.cmd'), 'utf8');
  const verify = await readFile(join(bundle, 'verify.cmd'), 'utf8');
  assert.ok(start.includes('%~dp0scripts\\launcher.mjs'));
  assert.ok(verify.includes('%~dp0scripts\\release\\verify-package.mjs'));
  assert.doesNotMatch(start, /--open/);
  for (const path of ['ui.cmd', 'demo.cmd']) await assert.rejects(access(join(bundle, path)), { code: 'ENOENT' });
  assert.ok(manifest.files.every(item => !/\.(?:html|css|png|jpe?g)$/i.test(item.path)));
  assert.ok(manifest.files.every(item => !/^(?:src\/(?:ui|debug)\/|tools\/workshop\/public\/)/.test(item.path)));
  assert.equal(JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8')).scripts.ui, undefined);
  const uiHelp = spawnSync(process.execPath, [join(bundle, 'bin/world-hub.mjs'), '--help'],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  assert.equal(uiHelp.error, undefined);
  assert.equal(uiHelp.status, 0, uiHelp.stderr);
  assert.match(uiHelp.stdout, /world-hub \[--config/);
  assert.doesNotMatch(uiHelp.stdout, /world-hub ui/);
});

test('Hub bundles preserve self-contained provider documentation, SDK guides and the machine contract', async () => {
  for (const path of [...SDK_DOCUMENTATION_FILES, ...MODULE_CONTRACT_FILES]) {
    await access(join(bundle, path));
  }
  const guidePath = 'docs/modules/provider-contract.md';
  const guide = await readFile(join(bundle, guidePath), 'utf8');
  assert.equal(guide, await readFile(join(repository, guidePath), 'utf8'), 'Provider guide links must survive bundle adaptation intact');
  for (const match of guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|mailto:|#)/i.test(match[1])) continue;
    await access(resolve(dirname(join(bundle, guidePath)), match[1].replace(/#.*$/, '').replace(/:\d+$/, '')));
  }
  const contract = await readFile(join(bundle, 'docs/modules/text-statistics.contract.json'), 'utf8');
  assert.equal(contract, await readFile(join(repository, 'docs/modules/text-statistics.contract.json'), 'utf8'));
  assert.deepEqual(JSON.parse(contract), JSON.parse(await readFile(join(repository, 'examples/capability-directory/contract.json'), 'utf8')),
    'The compatibility example contract must agree with the public machine contract');
});

test('source package check works from an unrelated cwd without creating persistent data', async () => {
  const cwd = join(temporaryRoot, '工作目录');
  await import('node:fs/promises').then(fs => fs.mkdir(cwd));
  const result = spawnSync(process.execPath, [join(bundle, 'scripts/launcher.mjs'), '--check'],
    { cwd, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const checked = JSON.parse(result.stdout);
  assert.equal(checked.persisted, false);
  assert.equal(checked.bundleRoot, resolve(bundle));
  assert.ok([checked.storage.log.path, checked.storage.blobs.path, checked.storage.management.path].every(path => path.startsWith(resolve(bundle) + sep)));
  assert.deepEqual(await readdir(cwd), []);
  assert.equal((await verifyPackage(bundle)).passed, true);
});

test('current distribution ships native management and excludes retired product entries', async () => {
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./runtime'], undefined);
  for (const path of ['bin/world-hub-pack.mjs', 'scripts/runtime/runtime.mjs', 'scripts/runtime/index.mjs', 'scripts/runtime/template.mjs', 'tools/launcher/cli.mjs', 'tools/launcher/server.mjs', 'tools/launcher/manager.mjs', 'tools/launcher/public/app.mjs', 'tools/launcher/public/index.html', 'docs/ecosystem/launcher.md', 'docs/ecosystem/launcher-deployment.md', 'docs/ecosystem/pack-spec.md']) {
    assert.ok(!manifest.files.some(item => item.path === path), path);
    await assert.rejects(access(join(bundle, path)), { code: 'ENOENT' });
  }
  for (const path of ['tools/launcher/module-groups.mjs', 'tools/launcher/module-versions.mjs', 'tools/launcher/module-uninstall.mjs', 'tools/launcher/wiring-defaults.mjs', 'tools/launcher/execution-policy.mjs', 'tools/launcher/demand-lifecycle.mjs', 'sdk/javascript/lifecycle-client.mjs'])
    assert.ok(manifest.files.some(item => item.path === path));
  for (const path of ['src/management/management-modules.mjs', 'src/management/management-community.mjs', 'scripts/runtime/module-group.mjs']) {
    assert.ok(manifest.files.some(item => item.path === path), path);
  }
});

test('building over an existing target or archive is refused without modifying the existing package', async () => {
  const before = hash(await readFile(join(bundle, 'manifest.json')));
  await assert.rejects(buildPackage({ sourceRoot: repository, output: bundle }), /Refusing to overwrite/);
  assert.equal(hash(await readFile(join(bundle, 'manifest.json'))), before);
  const output = join(temporaryRoot, 'reserved-output');
  await writeFile(output + '.zip', 'reserved', { flag: 'wx' });
  await assert.rejects(buildPackage({ sourceRoot: repository, output }), /Refusing to overwrite/);
  assert.equal(await readFile(output + '.zip', 'utf8'), 'reserved');
});

test('config opt-in cannot hide runtime damage and unsafe manifest paths are rejected', async () => {
  const changed = join(temporaryRoot, '独立 损坏包');
  await cp(bundle, changed, { recursive: true, force: false, errorOnExist: true });
  const config = join(changed, 'config/hub.json');
  await writeFile(config, (await readFile(config, 'utf8')) + '\n');
  assert.equal((await verifyPackage(changed)).passed, false);
  assert.equal((await verifyPackage(changed, { allowConfigChange: true })).passed, true);
  await writeFile(join(changed, 'src/management/management-http.mjs'), '\n// damaged test copy\n', { flag: 'a' });
  const damaged = await verifyPackage(changed, { allowConfigChange: true });
  assert.equal(damaged.passed, false);
  assert.ok(damaged.failed.some(item => item.path === 'src/management/management-http.mjs'));
  const manifest = JSON.parse(await readFile(join(changed, 'manifest.json'), 'utf8'));
  manifest.files[0].path = '../outside.mjs';
  await writeFile(join(changed, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyPackage(changed), /Unsafe/);
});
