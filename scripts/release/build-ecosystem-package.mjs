// Source-only reference pack distribution. Runtime, Hub and business remain separate.
import { mkdir, readFile, writeFile, lstat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_FILES, SDK_FILES, SDK_DOCUMENTATION_FILES, MODULE_CONTRACT_FILES,
  ECOSYSTEM_SCHEMA_FILES, ECOSYSTEM_RUNTIME_FILES, LAUNCHER_FILES, WORKSHOP_FILES } from './build-package.mjs';
import { zipDirectory } from './zip.mjs';
import { verifyPackage } from './verify-package.mjs';
import { collectFiles, ordinaryPath, readBounded, relativePath } from '../runtime/paths.mjs';
import { validatePack, validateModule } from '../runtime/package.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const packPrefix = 'examples/ecosystem-pack/';
const moduleFiles = {
  source: ['module.json', 'program.mjs', 'bridge-kit.mjs', 'blob-client.mjs', 'LICENSE'],
  stats: ['module.json', 'program.py', 'hub_bridge.py', 'requirements.txt', 'LICENSE'],
  desk: ['module.json', 'program.mjs', 'bridge-kit.mjs', 'blob-client.mjs', 'index.html', 'ui.js', 'LICENSE'],
};
export const ECOSYSTEM_PACK_FILES = Object.freeze(['README.md', 'pack.json', 'pack.lock',
  ...Object.entries(moduleFiles).flatMap(([id, names]) => names.map(name => `modules/${id}/${name}`))]
  .map(name => packPrefix + name));
const documentation = ['README.en.md', ...SDK_DOCUMENTATION_FILES,
  ...['README', 'onboarding', 'development', 'deployment', 'verification', 'repository', 'releases', 'npm']
    .map(name => `docs/${name}.md`),
  ...['index', 'boundaries', 'protocol', 'reliability-access', 'directed-and-bulk', 'management',
    'bridge-interoperability', 'manual-workbench', 'operations'].map(name => `docs/specs/${name}.md`),
  'docs/modules/provider-contract.md', 'docs/ecosystem/developer.md', 'docs/ecosystem/developer.en.md', 'docs/ecosystem/phase17.md', 'docs/ecosystem/pack-spec.md', 'docs/ecosystem/runtime.md', 'docs/ecosystem/launcher.md', 'docs/ecosystem/authoring.md', 'docs/ecosystem/sources.md', 'docs/ecosystem/workshop.md'];
export const ECOSYSTEM_SOURCE_FILES = Object.freeze([...new Set([
  ...APPLICATION_FILES, ...SDK_FILES, ...MODULE_CONTRACT_FILES, ...ECOSYSTEM_SCHEMA_FILES,
  ...ECOSYSTEM_RUNTIME_FILES, ...LAUNCHER_FILES, ...WORKSHOP_FILES, ...ECOSYSTEM_PACK_FILES, ...documentation,
  'bin/world-hub.mjs', 'scripts/launcher.mjs', 'scripts/launcher-support.mjs',
  'scripts/release/verify-package.mjs', 'config/hub.json', 'LICENSE',
])]);

function target(root, local) {
  relativePath(local);
  const full = resolve(root, ...local.split('/'));
  if (!full.startsWith(resolve(root) + sep)) throw new Error('Package path escapes source root');
  return full;
}
async function reserveOutput(output, sourceRoot) {
  if (sourceRoot === output || sourceRoot.startsWith(output + sep)) throw new Error('Output must not contain source repository');
  for (const path of [output, output + '.zip', output + '.zip.sha256', output + '.build.json']) {
    await ordinaryPath(path, { allowMissing: true });
    try { await lstat(path); throw new Error('Refusing to overwrite existing build target: ' + path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function validateReferencePack(inputs, sourceRoot, version) {
  const packBytes = inputs.get(packPrefix + 'pack.json');
  const pack = JSON.parse(packBytes); validatePack(pack);
  const lock = JSON.parse(inputs.get(packPrefix + 'pack.lock'));
  if (!exactKeys(lock, ['format', 'pack', 'hubVersion', 'platform', 'runtimes', 'modules'])
      || !exactKeys(lock.pack, ['id', 'version', 'sha256']) || lock.format !== 'world-hub.pack-lock/v1' || lock.pack?.id !== pack.id || lock.pack?.version !== pack.version
      || lock.pack?.sha256 !== hash(packBytes) || lock.hubVersion !== version) throw new Error('Sample pack lock identity or hash mismatch');
  if (!exactKeys(lock.runtimes, ['node', 'python']) || !exactKeys(lock.runtimes.node, ['version'])
      || !exactKeys(lock.runtimes.python, ['version', 'packages']) || lock.runtimes?.node?.version !== '22.23.2' || lock.runtimes?.python?.version !== '3.14.0'
      || lock.runtimes.python.packages?.websockets !== '15.0.1' || Object.keys(lock.runtimes.python.packages).length !== 1)
    throw new Error('Source distribution requires the explicit Node 22.23.2 / Python 3.14.0 / websockets 15.0.1 reference lock');
  if (!exactKeys(lock.platform, ['os', 'arch']) || typeof lock.platform.os !== 'string' || typeof lock.platform.arch !== 'string'
      || !Array.isArray(lock.modules) || lock.modules.length !== 3) throw new Error('Invalid sample platform or module set');
  const seen = new Set(), manifests = new Map();
  for (const locked of lock.modules) {
    if (!exactKeys(locked, ['id', 'version', 'source', 'files']) || typeof locked.source !== 'string') throw new Error('Unsafe locked module source');
    relativePath(locked.source);
    const id = locked.source.startsWith('modules/') ? locked.source.slice(8) : null;
    if (!Object.hasOwn(moduleFiles, id) || seen.has(id)) throw new Error('Sample lock has unexpected or duplicate module source');
    seen.add(id);
    if (!Array.isArray(locked.files) || locked.files.length !== moduleFiles[id].length) throw new Error('Locked sample module file set mismatch');
    const actual = await collectFiles(target(sourceRoot, packPrefix + locked.source));
    if (actual.length !== moduleFiles[id].length) throw new Error('Sample module includes undeclared or generated files');
    const fileSet = new Set();
    for (const file of locked.files) {
      if (!exactKeys(file, ['path', 'sha256'])) throw new Error('Unsafe locked sample file');
      relativePath(file.path);
      if (!moduleFiles[id].includes(file.path) || fileSet.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Unsafe or undeclared locked sample file');
      fileSet.add(file.path);
      const local = packPrefix + locked.source + '/' + file.path;
      if (hash(inputs.get(local)) !== file.sha256 || actual.find(item => item.path === file.path)?.sha256 !== file.sha256)
        throw new Error('Locked sample module SHA-256 mismatch: ' + local);
    }
    const manifest = JSON.parse(inputs.get(packPrefix + locked.source + '/module.json')); validateModule(manifest);
    if (manifests.has(manifest.id)) throw new Error('Duplicate locked sample module identity');
    manifests.set(manifest.id, manifest);
    if (manifest.id !== locked.id || manifest.version !== locked.version || !manifest.platforms.includes(`${lock.platform.os}-${lock.platform.arch}`))
      throw new Error('Locked sample module identity or platform mismatch');
    if (!pack.components.some(component => component.module === manifest.id)) throw new Error('Locked sample module is unused');
    if (hash(inputs.get(packPrefix + locked.source + '/LICENSE')) !== hash(inputs.get('LICENSE'))) throw new Error('Sample module MIT license differs');
  }
  if (seen.size !== 3) throw new Error('Sample modules missing');
  for (const component of pack.components) {
    const module = manifests.get(component.module);
    if (!module || Object.keys(component.bridges).length !== module.bridges.length
        || module.bridges.some(slot => !Object.hasOwn(component.bridges, slot))) throw new Error('Missing sample component or bridge declaration');
    for (const required of module.requires) {
      if (!pack.bindings.some(binding => binding.to === component.id && binding.contract.id === required.id
          && binding.contract.version === required.version)) throw new Error('Unbound sample required capability');
    }
  }
  for (const binding of pack.bindings) {
    const from = manifests.get(pack.components.find(component => component.id === binding.from)?.module);
    const to = manifests.get(pack.components.find(component => component.id === binding.to)?.module);
    const matches = contract => contract.id === binding.contract.id && contract.version === binding.contract.version;
    if (!from?.provides.some(matches) || !to?.requires.some(matches)) throw new Error('Incompatible sample capability binding');
  }
  return { pack, lock };
}
function readme(version, lock) {
  return `# World Hub ${version} 跨语言整合包源码分发\n\n本包包含 Hub、可选外部 Runtime CLI、开放 module／pack／lock schema 与三个真实程序：JavaScript 原文来源、Python 统计、JavaScript 浏览器文本台。业务不运行在 Hub 内核。\n\n这是源码包，不携带 Python、Node 或第三方依赖二进制。当前样例锁要求 ${lock.platform.os}-${lock.platform.arch}、预安装 Node 22.23.2、Python 3.14.0 与 websockets 15.0.1。没有 Python 便携运行时；运行检查会明确拒绝不匹配环境。\n\n1. 完整解压到新目录。\n2. 运行 \`node scripts/release/verify-package.mjs --root .\` 校验本包文件。哈希清单不提供发布者签名保证。\n3. 按[文本台包说明](examples/ecosystem-pack/README.md)执行 plan、import，并检查权限与实际 review digest。\n4. 用 \`node bin/world-hub-pack.mjs start --root data/pack-runtime --instance text-one --trust <审阅摘要>\` 启动，打开实际 entryUrl。\n5. 停止、重启和导出见[外部 Runtime](docs/ecosystem/runtime.md)。Runtime 不自动安装依赖、不提供 OS 沙箱、不自动重试业务。\n\n检查完整性后运行产生的实例配置、凭据、日志、来源和成果位于用户选择的 Runtime 根目录。使用包内 \`data/\` 可保留整体完整性校验；该目录只包含运行产物，不参与原始制品清单。导出复制锁定的公开程序包，不复制实例数据和秘密。修改程序后需要明确重锁、审阅和重建，禁止用新哈希掩盖不明变更。\n\n[开放部署规范](docs/ecosystem/pack-spec.md)、[文本统计业务契约](docs/modules/text-statistics.contract.json)。各模块携带自己的桥和 MIT LICENSE，外部 Python 库遵循自身许可。`;
}

export async function buildEcosystemPackage({ sourceRoot = repository, output } = {}) {
  sourceRoot = await ordinaryPath(sourceRoot);
  const pkg = JSON.parse(await readBounded(join(sourceRoot, 'package.json')));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  output = resolve(output ?? join(sourceRoot, 'dist', `world-hub-${version}-ecosystem-source`));
  await reserveOutput(output, sourceRoot);
  // Load and validate every input before creating output. No interpreter/module is executed.
  const inputs = new Map();
  for (const local of ECOSYSTEM_SOURCE_FILES) inputs.set(local, await readBounded(target(sourceRoot, local), 8 * 1024 * 1024));
  const { lock } = await validateReferencePack(inputs, sourceRoot, version);
  await mkdir(dirname(output), { recursive: true }); await mkdir(output);
  const files = [];
  async function add(local, bytes, role) {
    const full = target(output, local); await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes, { flag: 'wx' });
    files.push({ path: local, size: Buffer.byteLength(bytes), sha256: hash(bytes), role });
  }
  for (const [local, bytes] of inputs) {
    const role = local === 'LICENSE' || local.endsWith('/LICENSE') ? 'license'
      : ECOSYSTEM_PACK_FILES.includes(local) ? (local.endsWith('.md') ? 'locked-pack-documentation' : 'locked-pack')
        : MODULE_CONTRACT_FILES.includes(local) || ECOSYSTEM_SCHEMA_FILES.includes(local) ? 'documentation-contract'
          : documentation.includes(local) ? 'documentation' : local.startsWith('scripts/') || local.startsWith('bin/') || local.startsWith('tools/launcher/') && !local.startsWith('tools/launcher/public/') ? 'tooling'
            : local === 'config/hub.json' ? 'configuration' : 'application';
    await add(local, bytes, role);
  }
  await add('README.md', readme(version, lock) + '\n\n## 可选统一 Launcher\n\n运行 `node bin/world-hub.mjs ui --root ./data/launcher --open`，从一次性授权入口进入“我的整合包”。选择包内 `examples/ecosystem-pack` 本机目录，检查锁定环境和模块来源后创建实例；点击启动，审阅当前权限并明确授权即可运行，无需手工输入审阅摘要。界面提供停止、重启、四种状态、组件日志、Hub 拓扑与工作台双向导航及公开包导出，还提供私人备份／新实例恢复、保留数据卸载、可视化组合／派生／重建锁、静态软件源缓存与发布、评论和提案交换。上述 Runtime CLI 继续可用。Launcher 与 Runtime 都在 Hub 通信内核之外；检查不安装依赖，有限依赖准备须另行审阅授权，当前没有 OS 沙箱。详情见[统一 Launcher](docs/ecosystem/launcher.md)。\n', 'documentation');
  await add('package.json', JSON.stringify({ name: 'world-hub-ecosystem-bundle', version, private: true,
    type: 'module', license: 'MIT', engines: { node: '>=22.4.0' },
    scripts: { ui: 'node bin/world-hub.mjs ui --open', check: 'node scripts/launcher.mjs --check', 'verify:package': 'node scripts/release/verify-package.mjs --root .' } }, null, 2) + '\n', 'tooling');
  // Adapt copied general guides only. The entire locked pack remains byte-exact.
  for (const item of files.filter(item => item.role === 'documentation')) {
    const full = target(output, item.path); let content = await readFile(full, 'utf8');
    for (const match of [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]) {
      if (/^(?:https?:|mailto:|#)/i.test(match[2])) continue;
      try { await access(resolve(dirname(full), match[2].replace(/#.*$/, '').replace(/:\d+$/, ''))); }
      catch { content = content.replace(match[0], item.path === 'README.en.md' ? `${match[1]} (source repository file; not included in this bundle)` : `${match[1]}（源码仓库文件，未随此包）`); }
    }
    await writeFile(full, content); item.size = Buffer.byteLength(content); item.sha256 = hash(content);
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = { schemaVersion: 1, version, kind: 'ecosystem-source', wire: '0.1', builtAt: new Date().toISOString(),
    runtime: null, externalRuntimes: lock.runtimes, platform: lock.platform, mutable: ['data/**'], files,
    sourcePolicy: 'Explicit Hub/SDK/optional Launcher/external Runtime/schema/documentation/three-module locked sample allowlist; no data, credentials, feedback, history, dependency caches, downloaded binaries or test evidence' };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const integrity = await verifyPackage(output);
  if (!integrity.passed) throw new Error('Ecosystem source package integrity failed: ' + JSON.stringify(integrity.failed));
  const archive = output + '.zip', zipped = await zipDirectory(output, archive), archiveSha256 = hash(await readFile(archive));
  await writeFile(archive + '.sha256', archiveSha256 + '  ' + basename(archive) + '\n', { flag: 'wx' });
  const result = { passed: true, version, kind: 'ecosystem-source', directory: output, archive, archiveSha256,
    archiveBytes: zipped.bytes, files: files.length, runtimeVerified: false, bundledPython: false, bundledNode: false,
    platform: lock.platform, externalRuntimes: lock.runtimes, excludedUserData: true, mutable: ['data/**'] };
  await writeFile(output + '.build.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
export function parseEcosystemBuildArguments(args) {
  if (!args.length) return {};
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) throw new Error('Usage: build-ecosystem-package.mjs [--output new-directory]');
  return { output: args[1] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildEcosystemPackage(parseEcosystemBuildArguments(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
