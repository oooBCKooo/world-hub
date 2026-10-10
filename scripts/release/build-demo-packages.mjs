import { mkdir, readFile, writeFile, lstat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, basename, sep, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_FILES, SDK_FILES, MODULE_CONTRACT_FILES, DOCUMENTATION_IMAGE_FILES } from './build-package.mjs';
import { zipDirectory } from './zip.mjs';
import { verifyDemoPackage } from './verify-demo-package.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const pinnedNodeVersion = '22.23.2';
const pinnedNodeSha = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4';
const pinnedLicenseSha = 'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export const DEMO_PROFILE_IDS = Object.freeze(['event-desk', 'modular-assistant', 'digital-world', 'capability-directory']);
export const DEMO_FILES = Object.freeze([
  ...['profiles.mjs', 'peer.mjs', 'common.mjs', 'event-desk.mjs', 'modular-assistant.mjs',
    'digital-world.mjs', 'traffic-source.mjs', 'extension-material.mjs', 'checklist-harness.mjs',
    'run-demo.mjs', 'explorer.mjs', 'explorer.html', 'explorer.css', 'explorer.js', 'explorer-i18n.mjs']
    .map(name => `examples/purpose-demos/${name}`),
  ...['directory.mjs', 'composition.mjs', 'processor-a.mjs', 'processor-b.mjs', 'contract.json']
    .map(name => `examples/capability-directory/${name}`),
]);
const lifecycleFiles = ['tests/helpers/owned-program.mjs', 'examples/distributed-context/hub-process.mjs'];
const documentationFiles = [
  'README.en.md',
  'examples/capability-directory/README.md',
  'examples/purpose-demos/README.md', 'sdk/javascript/README.md', 'sdk/python/README.md',
  'sdk/powershell/README.md', 'docs/README.md', 'docs/onboarding.md', 'docs/development.md',
  'docs/deployment.md', 'docs/verification.md', 'docs/repository.md', 'docs/releases.md', 'docs/npm.md',
  'docs/examples/distributed-context.md', 'docs/examples/workflows.md', 'docs/examples/purpose-demos.md',
  'docs/examples/capability-directory.md',
  'docs/modules/provider-contract.md', 'docs/ecosystem/interop.md',
  ...['index', 'boundaries', 'protocol', 'reliability-access', 'directed-and-bulk', 'management',
    'bridge-interoperability', 'manual-workbench', 'operations'].map(name => `docs/specs/${name}.md`),
];
export const DEMO_SOURCE_FILES = Object.freeze([
  ...APPLICATION_FILES, ...SDK_FILES, ...DEMO_FILES, ...lifecycleFiles,
  'scripts/release/verify-package.mjs', 'scripts/release/verify-demo-package.mjs',
  'config/hub.json', 'LICENSE', ...documentationFiles, ...MODULE_CONTRACT_FILES, ...DOCUMENTATION_IMAGE_FILES,
]);

const profileDetails = {
  'event-desk': {
    title: '多来源事件与双向控制台',
    purpose: '传感器和行情程序提供事件，再启用独立交通来源；汇总程序纳入新增主题，同一个传感器程序分别通过数据桥与控制桥接入。',
    actions: '按界面实验路线，先读取两个来源，再接入独立交通来源，观察第三张来源卡片；修改传感器参数并对照后续读数。',
    modules: 'event-desk.mjs',
  },
  'modular-assistant': {
    title: '分布式上下文与模块化智能助手',
    purpose: '从三个程序抽取系统提示、用户对话和材料，再加入独立扩展材料；组合程序选择模板或清单执行器返回成果。',
    actions: '先组合三个上下文来源，再加入独立扩展材料；切换清单执行器，对照来源、执行器身份和成果形式。',
    modules: 'modular-assistant.mjs',
  },
  'digital-world': {
    title: '外部程序组成的动态数字世界',
    purpose: '世界状态、规则、NPC 和导演分别运行；导演每轮调用多个程序，世界状态由状态程序持有。',
    actions: '查看起始世界状态，推进三个回合或运行休整回合；对照每轮行动、状态变化和各程序返回的步骤回执。',
    modules: 'digital-world.mjs',
  },
  'capability-directory': {
    title: '外部能力目录与可替换处理器',
    purpose: '独立目录保存能力清单与租约；组装程序依照公开合同发现能力，仅改自身配置即可在两个独立统计处理器之间切换。Hub 不理解清单、合同、权限声明或组合策略。',
    actions: '查询能力目录，运行原实现，切换到另一处理器后再次运行；对照提供者身份、真实调用回执与输出，继续试验版本冲突、授权拒绝、超时和租约失效。',
    modules: '../capability-directory/composition.mjs',
  },
};

function entryPath(root, local) {
  if (typeof local !== 'string' || local.includes('\\') || local.startsWith('/') || /^[a-z]:/i.test(local)
    || local.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe package path');
  const full = resolve(root, ...local.split('/'));
  if (!full.startsWith(resolve(root) + sep)) throw new Error('Package path escapes root');
  return full;
}

// Check every existing component: rejecting only the leaf would still permit a
// symlinked parent to redirect a build outside the requested destination.
async function rejectSymlinkComponents(path) {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symbolic link path is not allowed: ' + current);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function regularFile(path) {
  await rejectSymlinkComponents(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Source must be a regular file: ' + path);
  return readFile(path);
}

function wrapper(mode, profile) {
  const script = mode === 'verify' ? 'scripts\\release\\verify-demo-package.mjs' : 'examples\\purpose-demos\\run-demo.mjs';
  const args = mode === 'verify' ? '' : `--profile ${profile} ${mode === 'check' ? '--check' : '--open'} `;
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nset "DEMO_NODE=%~dp0runtime\\node.exe"\r\nif exist "%DEMO_NODE%" goto runtime_ready\r\nset "DEMO_NODE=node"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo Node.js 22.4.0 or newer is required. This source package has no bundled runtime.\r\n  exit /b 1\r\n)\r\n:runtime_ready\r\n"%DEMO_NODE%" "%~dp0${script}" ${args}%*\r\nset "DEMO_RESULT=%ERRORLEVEL%"\r\nif not "%DEMO_RESULT%"=="0" (\r\n  echo Command failed with exit code %DEMO_RESULT%.\r\n  if "%~1"=="" pause\r\n)\r\nexit /b %DEMO_RESULT%\r\n`;
}

function bundleReadme(version, kind, profile) {
  const detail = profileDetails[profile];
  return `# 世界枢纽 ${version} 用途演示：${detail.title}\n\n${detail.purpose}\n\n${kind === 'windows-x64-portable'
    ? 'Windows x64 便携包，自带经官方 SHA-256 核对的 Node 22.23.2 与完整许可证。无需安装 npm 依赖。'
    : '源码包，需要 Node 22.4.0 或更高版本。无需安装 npm 依赖。'}\n\n## 运行与探索\n\n1. 完整解压到可写目录；不要在 ZIP 预览窗口中启动。\n2. 首次先运行 \`check.cmd\` 检查环境，再运行 \`verify.cmd\` 检查包内源文件与 SHA-256 清单。\n3. 双击 \`start.cmd\`，浏览器打开演示界面；启动终端显示界面和枢纽的实际地址。默认使用空闲本机端口，不占用正式枢纽的数据目录。\n4. ${detail.actions}\n5. 在启动终端按 Ctrl+C，等待演示所属子进程收起。\n\n从其他工作目录也可运行这些脚本。终端直接启动：\`node examples/purpose-demos/run-demo.mjs --profile ${profile}\`；便携包可把 \`node\` 替换为 \`runtime\\node.exe\`。加 \`--open\` 自动打开浏览器。本包的 \`demo-profile.json\` 固定 \`${profile}\`，启动其他 profile 会被拒绝。\n\n## 业务与数据边界\n\n四个演示均由独立外部程序通过 mod 桥通讯。枢纽只负责接入、路由、保存与传送；上下文组合、模型调用、回合推进、NPC、世界状态、能力目录和合同选择都在外部程序。\n\n智能助手演示包含模板与清单两种确定性本地执行器，没有真实智能模型、模型联网请求或全局 DSH 依赖。它展示预置独立程序之间的来源扩展与执行器切换；自己的程序仍需实现桥与应用通讯合同。事件与数字世界也是演示数据和简化业务。\n\n本包只附源码与参考接线，不附旧数据、私人配置、凭据、全局工具或测试证据。运行时新增数据均位于 \`data/\` 下。提供者未释放的枢纽记录仍保留；读取、ACK、停止与重启不等于释放。参考 \`config/hub.json\` 用于查看正常接线形态，演示启动器创建本次演示自己的配置。\n\n## 开发者修改入口\n\n- [完整探索指南](examples/purpose-demos/README.md)：各场景程序、桥、主题与操作。\n- [用途说明](docs/examples/purpose-demos.md)：适用方向与验证范围。\n- [场景注册](examples/purpose-demos/profiles.mjs)：外部程序声明与接线。\n- [当前业务模块](examples/purpose-demos/${detail.modules})：本场景的业务实现；替换独立程序或桥适配层。\n- [程序启动入口](examples/purpose-demos/peer.mjs)、[浏览器程序](examples/purpose-demos/explorer.mjs)、[桥 SDK](sdk/javascript/README.md)。\n- [提供者接入契约](docs/modules/provider-contract.md)与[机器契约](docs/modules/text-statistics.contract.json)：从零实现并接入独立能力模块。\n- [通讯规格](docs/specs/protocol.md)与[枢纽边界](docs/specs/boundaries.md)。\n\n修改源码后完整性检查会提示差异，这是正常的修改检测。重新发布请在源码仓库运行 \`npm run build:demos\` 构建新包，禁止覆盖现有包；不要手动改 SHA 清单来掩盖未知损坏。\`verify.cmd\` 只检查文件完整性，端到端场景验收由源码仓库的测试命令执行。只有 \`data/**\` 可作为新增运行数据，包内配置、profile 与源码均参与校验。清单随文件一起被篡改时不提供发布者签名保证。\n\n这些本机示例展示有限资源下的组合能力；未宣称无限容量、跨机器可靠性、完整智能系统或完整数字世界已通过验收。\n`;
}

async function prepareRuntimeFiles(runtimeDirectory) {
  if (!runtimeDirectory) return { provenance: null, files: new Map() };
  const directory = resolve(runtimeDirectory);
  const files = new Map();
  for (const name of ['node.exe', 'LICENSE', 'SHASUMS256.txt', 'provenance.json']) {
    files.set(name, await regularFile(join(directory, name)));
  }
  const provenance = JSON.parse(files.get('provenance.json').toString('utf8'));
  if (provenance.version !== pinnedNodeVersion || provenance.platform !== 'win32' || provenance.arch !== 'x64'
    || provenance.sha256 !== pinnedNodeSha || hash(files.get('node.exe')) !== pinnedNodeSha
    || provenance.checksumUrl !== `https://nodejs.org/dist/v${pinnedNodeVersion}/SHASUMS256.txt`
    || provenance.executableUrl !== `https://nodejs.org/dist/v${pinnedNodeVersion}/win-x64/node.exe`) {
    throw new Error('Runtime checksum/provenance is not the pinned official Node 22.23.2 Windows x64 runtime');
  }
  const officialChecksum = files.get('SHASUMS256.txt').toString('utf8').split(/\r?\n/)
    .find(line => /^[a-f0-9]{64}\s+win-x64\/node\.exe$/.test(line.trim()))?.trim().split(/\s+/)[0];
  if (officialChecksum !== pinnedNodeSha) throw new Error('Runtime SHASUMS256 does not contain the pinned Node checksum');
  if (provenance.licenseSha256 !== pinnedLicenseSha || hash(files.get('LICENSE')) !== pinnedLicenseSha
    || provenance.licenseUrl !== `https://raw.githubusercontent.com/nodejs/node/v${pinnedNodeVersion}/LICENSE`) {
    throw new Error('Runtime license differs from the pinned official Node license');
  }
  return { provenance, files };
}

async function checkBuildTargets(directory) {
  await rejectSymlinkComponents(directory);
  for (const target of [directory, directory + '.zip', directory + '.zip.sha256', directory + '.build.json']) {
    try { await lstat(target); throw new Error('Refusing to overwrite existing build target: ' + target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function buildDemoPackages({ profile = 'all', outputRoot, runtimeDirectory = null, sourceRoot = repository } = {}) {
  if (typeof profile !== 'string' || (profile !== 'all' && !DEMO_PROFILE_IDS.includes(profile))) {
    throw new Error('Unknown demo profile: ' + profile);
  }
  sourceRoot = resolve(sourceRoot);
  const sourcePackage = JSON.parse((await regularFile(join(sourceRoot, 'package.json'))).toString('utf8'));
  const { version } = sourcePackage;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version');
  outputRoot = resolve(outputRoot ?? join(sourceRoot, 'dist', 'purpose-demos'));
  const sourceFromOutput = relative(outputRoot, sourceRoot);
  if (!sourceFromOutput || (!sourceFromOutput.startsWith('..' + sep) && sourceFromOutput !== '..' && !isAbsolute(sourceFromOutput))) {
    throw new Error('Output root must not contain the source repository');
  }
  await rejectSymlinkComponents(outputRoot);
  const kind = runtimeDirectory ? 'windows-x64-portable' : 'source';
  const suffix = runtimeDirectory ? 'win-x64' : 'source';
  const selected = profile === 'all' ? [...DEMO_PROFILE_IDS] : [profile];
  const targets = selected.map(id => ({ id, directory: join(outputRoot, `world-hub-${version}-${id}-${suffix}`) }));
  // Preflight the whole selection, including adjacent ZIP/report targets, before
  // creating the first directory: one reserved profile never leaves partial peers.
  for (const target of targets) await checkBuildTargets(target.directory);
  const runtime = await prepareRuntimeFiles(runtimeDirectory);
  const inputs = new Map();
  for (const local of DEMO_SOURCE_FILES) inputs.set(local, await regularFile(entryPath(sourceRoot, local)));
  const results = [];
  for (const { id, directory } of targets) {
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { recursive: false });
    const files = [];
    async function add(local, bytes, role) {
      const target = entryPath(directory, local);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
      files.push({ path: local, size: Buffer.byteLength(bytes), sha256: hash(bytes), role });
    }
    for (const [local, bytes] of inputs) {
      const role = local === 'LICENSE' ? 'license' : documentationFiles.includes(local) ? 'documentation'
        : MODULE_CONTRACT_FILES.includes(local) ? 'documentation-contract'
        : DOCUMENTATION_IMAGE_FILES.includes(local) ? 'documentation-image' : DEMO_FILES.includes(local) ? 'example'
        : lifecycleFiles.includes(local) || local.startsWith('scripts/') ? 'tooling'
          : local === 'config/hub.json' ? 'configuration' : 'application';
      await add(local, bytes, role);
    }
    await add('package.json', JSON.stringify({ name: `world-hub-demo-${id}`, version, private: true, type: 'module', license: 'MIT',
      engines: { node: '>=22.4.0' }, scripts: {
        start: `node examples/purpose-demos/run-demo.mjs --profile ${id} --open`,
        check: `node examples/purpose-demos/run-demo.mjs --profile ${id} --check`,
        'verify:package': 'node scripts/release/verify-demo-package.mjs',
      } }, null, 2) + '\n', 'tooling');
    await add('demo-profile.json', JSON.stringify({ schemaVersion: 1, profile: id, version, wire: '0.1' }, null, 2) + '\n', 'configuration');
    await add('README.md', bundleReadme(version, kind, id).replace('\n\n', '\n\n[English](README.en.md)\n\n'), 'documentation');
    for (const mode of ['start', 'check', 'verify']) await add(mode + '.cmd', wrapper(mode, id), 'tooling');
    for (const [name, bytes] of runtime.files) await add('runtime/' + name, bytes, 'runtime');
    // Source documentation may link to conformance tests or core-only tools.
    // Keep copied guides navigable without inventing files outside the allowlist.
    for (const item of files.filter(item => item.role === 'documentation')) {
      const target = entryPath(directory, item.path);
      let content = await readFile(target, 'utf8');
      for (const match of [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]) {
        if (/^(?:https?:|mailto:|#)/i.test(match[2])) continue;
        const clean = match[2].replace(/#.*$/, '').replace(/:\d+$/, '');
        try { await access(resolve(dirname(target), clean)); }
        catch {
          content = content.replace(match[0], item.path === 'README.en.md'
            ? `${match[1]} (source repository file; not included in this demo bundle)`
            : `${match[1]}（源码仓库文件，未随演示包）`);
        }
      }
      await writeFile(target, content);
      item.size = Buffer.byteLength(content); item.sha256 = hash(content);
    }
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifest = { schemaVersion: 1, version, kind, purposeProfile: id, wire: '0.1',
      builtAt: new Date().toISOString(), runtime: runtime.provenance, mutable: ['data/**'], files,
      sourcePolicy: 'Explicit Hub/SDK/demo/documentation allowlist and two lifecycle helpers; no business in Hub, personal configuration, historical files, data, test suites, evidence, dependency modules, global DSH or model credentials' };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    const integrity = await verifyDemoPackage(directory);
    if (!integrity.passed) throw new Error('New demo package integrity failed: ' + JSON.stringify(integrity.failed));
    const archive = directory + '.zip';
    const zipped = await zipDirectory(directory, archive);
    const archiveSha256 = hash(await readFile(archive));
    await writeFile(archive + '.sha256', archiveSha256 + '  ' + basename(archive) + '\n', { flag: 'wx' });
    const result = { passed: true, version, profile: id, kind, directory, archive, archiveSha256,
      archiveBytes: zipped.bytes, files: files.length, runtimeVerified: Boolean(runtime.provenance),
      excludedUserData: true, mutable: ['data/**'] };
    await writeFile(directory + '.build.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    results.push(result);
  }
  return { passed: true, version, packages: results };
}

export function parseDemoBuildArguments(args) {
  const options = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    const key = { '--profile': 'profile', '--output-root': 'outputRoot', '--runtime': 'runtimeDirectory' }[argument];
    if (!key) throw new Error('Unknown argument: ' + argument);
    if (seen.has(key)) throw new Error('Duplicate argument: ' + argument);
    seen.add(key);
    const value = args[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error('Missing value for ' + argument);
    options[key] = value;
  }
  if (options.profile && options.profile !== 'all' && !DEMO_PROFILE_IDS.includes(options.profile)) throw new Error('Unknown demo profile: ' + options.profile);
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildDemoPackages(parseDemoBuildArguments(process.argv.slice(2))))); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
