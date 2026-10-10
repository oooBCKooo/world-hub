import { mkdir, readFile, writeFile, readdir, lstat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';
import { verifyPackage } from './verify-package.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const expectedNodeSha = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4';
export const APPLICATION_FILES = [
  'src/hub/hub-server.mjs', 'src/hub/ws-server.mjs',
  ...['acl', 'address', 'blob-protocol', 'blob-store', 'hub', 'identity', 'router', 'store', 'topic', 'wire-json'].map(name => `src/hub/lib/${name}.mjs`),
  'src/debug/page.mjs',
  'src/ui/language.mjs',
  ...['console.html', 'canvas-i18n.mjs', 'management-http.mjs', 'management-state.mjs', 'manual-bridge.mjs', 'manual-console.mjs', 'manual-i18n.mjs', 'manual-experience-state.mjs', 'manual-console.css', 'launcher-link.mjs'].map(name => `src/management/${name}`),
];
export const SDK_FILES = ['sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs',
  'sdk/python/hub_bridge.py', 'sdk/python/requirements.txt',
  'sdk/powershell/HubBridge.psm1', 'sdk/powershell/HubBridge.cs'];
export const SDK_DOCUMENTATION_FILES = Object.freeze(['sdk/javascript/README.md', 'sdk/python/README.md', 'sdk/powershell/README.md']);
export const MODULE_CONTRACT_FILES = Object.freeze(['docs/modules/text-statistics.contract.json']);
export const ECOSYSTEM_SCHEMA_FILES = Object.freeze(['docs/ecosystem/module.schema.json', 'docs/ecosystem/pack.schema.json', 'docs/ecosystem/pack-lock.schema.json', 'docs/ecosystem/template.schema.json', 'docs/ecosystem/template.example.json']);
export const ECOSYSTEM_RUNTIME_FILES = Object.freeze(['bin/world-hub-pack.mjs',
  ...['index', 'runtime', 'package', 'paths', 'process', 'hub-process', 'maintenance', 'authoring', 'sources', 'developer', 'template', 'upgrade', 'completion-cli', 'isolation', 'isolation-wrapper', 'isolation-channel'].map(name => `scripts/runtime/${name}.mjs`),
  'scripts/runtime/templates/node/program.mjs', 'scripts/runtime/templates/node/logic.mjs', 'scripts/runtime/templates/node/logic.test.mjs',
  'scripts/runtime/templates/python/program.py', 'scripts/runtime/templates/python/logic.py', 'scripts/runtime/templates/python/test_logic.py']);
export const LAUNCHER_FILES = Object.freeze(['bin/world-hub.mjs',
  ...['cli', 'server', 'manager', 'source-registry', 'environment', 'environment-prepare', 'diagnostics', 'topology'].map(name => `tools/launcher/${name}.mjs`),
  ...['index.html', 'app.mjs', 'style.css', 'i18n.mjs', 'advanced.mjs', 'completion-ui.mjs'].map(name => `tools/launcher/public/${name}`)]);
export const WORKSHOP_FILES = Object.freeze(['tools/workshop/cli.mjs', 'tools/workshop/store.mjs', 'tools/workshop/server.mjs',
  ...['index.html', 'app.mjs', 'style.css'].map(name => `tools/workshop/public/${name}`)]);
export const DOCUMENTATION_IMAGE_FILES = Object.freeze(
  ['hub-topology', 'hub-workbench', 'hub-launcher', 'demo-event-desk', 'demo-modular-assistant', 'demo-digital-world', 'demo-capability-directory']
    .flatMap(name => [`docs/images/${name}.jpg`, `docs/images/${name}-en.jpg`]));
const EXAMPLE_FILES = ['examples/management/run-management-demo.mjs', 'examples/management/demo-peer.mjs', 'examples/distributed-context/hub-process.mjs', 'tests/helpers/owned-program.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const entryPath = (root, relative) => {
  const path = resolve(root, ...relative.split('/'));
  if (!path.startsWith(resolve(root) + sep) || relative.includes('\\') || relative.split('/').some(item => item === '..')) throw new Error('Package path escapes root');
  return path;
};

const wrapper = (mode) => `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nset "HUB_NODE=%~dp0runtime\\node.exe"\r\nif exist "%HUB_NODE%" goto runtime_ready\r\nset "HUB_NODE=node"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo Node.js 22.4.0 or newer is required. This source package has no bundled runtime.\r\n  exit /b 1\r\n)\r\n:runtime_ready\r\n"%HUB_NODE%" "%~dp0scripts\\${mode === 'verify' ? 'release\\verify-package' : 'launcher'}.mjs" ${mode === 'check' ? '--check ' : mode === 'start' ? '--open ' : ''}%*\r\nset "HUB_RESULT=%ERRORLEVEL%"\r\nif not "%HUB_RESULT%"=="0" (\r\n  echo Command failed with exit code %HUB_RESULT%.\r\n  if "%~1"=="" pause\r\n)\r\nexit /b %HUB_RESULT%\r\n`;
const demoWrapper = `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nset "HUB_NODE=%~dp0runtime\\node.exe"\r\nif not exist "%HUB_NODE%" set "HUB_NODE=node"\r\n"%HUB_NODE%" "%~dp0examples\\management\\run-management-demo.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`;
const uiWrapper = `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nset "HUB_NODE=%~dp0runtime\\node.exe"\r\nif not exist "%HUB_NODE%" set "HUB_NODE=node"\r\n"%HUB_NODE%" "%~dp0bin\\world-hub.mjs" ui --open %*\r\nexit /b %ERRORLEVEL%\r\n`;

const portableReadme = (version, kind) => `# 世界枢纽 ${version} 整合包\n\n${kind === 'windows-x64-portable' ? 'Windows x64 便携包，自带经过官方 SHA-256 核对的 Node 22.23.2。枢纽和管理界面无需安装 npm、Python、PowerShell 7 或 DSH。' : '源码整合包，需本机 Node 22.4.0 或更高版本；启动枢纽无需安装 npm 依赖。'}\n\n## 启动与停止\n\n1. 完整解压到可写目录；不要在压缩包预览中启动。\n2. 双击 \`start.cmd\`。成功后启动窗口给出当前地址，并打开默认浏览器管理界面。默认地址为 http://127.0.0.1:8790/manage。窗口保持运行。\n3. 点击“通讯工作台”，页面生成 bridge 标识；本机参考 credential 为 \`ui.manual\`，token 留空。连接后可自选主题、订阅、发布任意 JSON 和手动 ACK。\n4. 停止时在启动窗口按 Ctrl+C，等待退出；不要同时运行使用同一份数据的第二个枢纽。\n\n不自动打开浏览器：\`runtime\\node.exe scripts\\launcher.mjs\`（源码包把前缀换成本机 node）。自选端口：加 \`--port 8791\`；自选配置：加 \`--config config\\hub.json\`。相对配置路径以整合包根目录为基准。支持中文及空格目录，从其他工作目录启动也使用包内配置。\n\n## 配置和持久数据\n\n- \`config/hub.json\`：用户接线配置；默认监听 127.0.0.1，未登记身份被拒绝。新增桥、credential、token 和主题权限由部署方编辑配置后重启。配置中的相对数据路径以配置目录为基准。\n- \`data/log/\`：已接纳消息、释放元数据和日志段；\`data/blobs/\`：附件与对象元数据；\`data/management.json\`：暂停状态及程序／桥注记。目录在首次启动时创建，包内不附旧运行数据。\n- 程序游标、上下文、harness、业务状态由外部程序保存，枢纽不会替它们管理。\n\n\`ui.manual\` 是已配置的本机参考身份，无 token 时显示未认证。它不是身份防伪、多租户或公网方案。正式接线可配置 token 和主题权限，不应把本机管理端点公开给不可信访问者。通道和正文 kind 不内置穷举。\n\n数据目录有启动锁，防止重复实例打开同一份数据。正常停止会释放本启动器自己的锁。异常退出留下锁时，先确认对应枢纽已停止，再只移走错误提示所列 \`.world-hub-package.lock\`；不要删除日志、对象或管理状态。启动器不会按锁中的 PID 杀进程，也不会自动清理遗留锁。\n\n## 检查、迁移与升级\n\n\`check.cmd\` 只读检查环境、配置和必需文件，不启动枢纽，不创建数据目录。首次运行 \`verify.cmd\` 检查全部原始文件；编辑过配置后用 \`verify.cmd --allow-config-change\`，该选项仅放过配置内容变化，仍检查程序和 Node 文件。SHA-256 清单用于发现损坏，与清单一起被更改时不提供发布者签名保证。\n\n升级请解压到新目录，先停止旧版本，保留完整旧包作回退，再将自己的 \`config/\` 和完整 \`data/\` 复制到新包。修改过的外部数据路径须自行迁移。不要用新包覆盖正在运行的目录，也不要以新默认配置替换自己的接线。原记录未由提供者释放时仍保留；读取、ACK、停止、升级都不等于释放。移动整个包时先停止，保持三个数据区域和配置一起移动。\n\n## 接入与可选演示\n\n[接入材料](docs/onboarding.md)列出 JS、浏览器、Python 和 PowerShell 桥。各语言源文件不会随 Hub 自动载入；Python／PowerShell 程序的运行环境由该程序自行安排。\n\n[提供者接入契约](docs/modules/provider-contract.md)、[机器契约](docs/modules/text-statistics.contract.json)和[JS SDK](sdk/javascript/README.md)可用于独立实现可替换的统计模块；能力目录与组装器由外部程序部署。\n\n双击 \`demo.cmd\` 可启动独立临时枢纽与三个测试程序，在终端给出的另一地址查看真实信息流，Ctrl+C 收起该演示自己的进程。演示不读取本包正式 data，不自动启动 DSH、模型或工作流；其他验证程序在源码仓库 examples/ 与 tests/ 中保留，不作为整合包必装业务。\n\n[现行规格入口](docs/specs/index.md)。浏览器附件便利层单文件上限仍为 64 MiB，Hub 默认对象上限 1 GiB、池 2 GiB；日志容量和提供者释放策略见[部署与容量说明](docs/deployment.md)。打包不增加断电耐久、跨机、Linux 或长期高负载的验收结论。\n`;
// The editable source document is copied into docs/onboarding.md at build time.

export async function buildPackage({ output, runtimeDirectory = null, sourceRoot = repository }) {
  sourceRoot = resolve(sourceRoot);
  const packageInfo = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  output = resolve(output ?? join(sourceRoot, 'dist', 'world-hub-' + packageInfo.version + (runtimeDirectory ? '-win-x64' : '-source')));
  if (output === sourceRoot || sourceRoot.startsWith(output + sep)) throw new Error('Output must not contain the source repository');
  for (const target of [output, output + '.zip', output + '.zip.sha256', output + '.build.json']) {
    try { await lstat(target); throw new Error('Refusing to overwrite existing build target: ' + target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const { version } = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version');
  const kind = runtimeDirectory ? 'windows-x64-portable' : 'source';
  let provenance = null;
  if (runtimeDirectory) {
    runtimeDirectory = resolve(runtimeDirectory);
    provenance = JSON.parse(await readFile(join(runtimeDirectory, 'provenance.json'), 'utf8'));
    if (provenance.version !== '22.23.2' || provenance.platform !== 'win32' || provenance.arch !== 'x64' || provenance.sha256 !== expectedNodeSha || hash(await readFile(join(runtimeDirectory, 'node.exe'))) !== expectedNodeSha) throw new Error('Runtime checksum is not the pinned official Node 22.23.2 Windows x64 binary');
    if (hash(await readFile(join(runtimeDirectory, 'LICENSE'))) !== provenance.licenseSha256) throw new Error('Runtime license changed');
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false }); // Existing deployments are never overwritten.
  const files = [];
  const add = async (path, bytes, role) => {
    const full = entryPath(output, path); await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes, { flag: 'wx' }); files.push({ path, size: Buffer.byteLength(bytes), sha256: hash(bytes), role });
  };
  const copy = async (path, role) => {
    const full = entryPath(sourceRoot, path); const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source must be a regular file: ${path}`);
    await add(path, await readFile(full), role);
  };
  for (const path of [...APPLICATION_FILES, ...SDK_FILES]) await copy(path, 'application');
  for (const path of SDK_DOCUMENTATION_FILES) await copy(path, 'documentation');
  for (const path of MODULE_CONTRACT_FILES) await copy(path, 'documentation-contract');
  for (const path of ECOSYSTEM_SCHEMA_FILES) await copy(path, 'documentation-contract');
  for (const path of ECOSYSTEM_RUNTIME_FILES) await copy(path, 'tooling');
  for (const path of LAUNCHER_FILES) await copy(path, path.startsWith('tools/launcher/public/') ? 'application' : 'tooling');
  for (const path of WORKSHOP_FILES) await copy(path, path.includes('/public/') ? 'application' : 'tooling');
  for (const path of EXAMPLE_FILES) await copy(path, 'example');
  await copy('scripts/launcher.mjs', 'tooling');
  await copy('scripts/launcher-support.mjs', 'tooling');
  await copy('scripts/release/verify-package.mjs', 'tooling');
  await copy('config/hub.json', 'configuration');
  await copy('LICENSE', 'license');
  await add('package.json', JSON.stringify({ name: 'world-hub-bundle', version, private: true, type: 'module', license: 'MIT', engines: { node: '>=22.4.0' }, scripts: { start: 'node scripts/launcher.mjs', ui: 'node bin/world-hub.mjs ui --open', check: 'node scripts/launcher.mjs --check', 'verify:package': 'node scripts/release/verify-package.mjs' } }, null, 2) + '\n', 'tooling');
  await add('README.md', portableReadme(version, kind).replace('\n\n', '\n\n[English](README.en.md)\n\n')
    + '\n## 可选统一 Launcher 与外部程序包 Runtime\n\n双击 `ui.cmd` 或运行 `node bin/world-hub.mjs ui --open`，打开默认显示“我的整合包”的统一 Launcher；原 `start.cmd` 继续直接启动 Hub 管理。Launcher 提供本机目录检查、导入、明确授权当前代码、启停、模块权限、日志、真实桥归属与公开包导出，还提供私人备份／新实例恢复、保留数据卸载、创作派生／重建锁、软件源缓存与发布、评论和提案交换。首次访问使用终端打开的一次性授权入口，终端保持运行；环境检查只运行固定探针，有限依赖准备须另行审阅授权。实例根目录可用 `--root <自己的目录>` 选择，包含私人运行配置与凭据，不能作为公开包分享。完整操作见[Launcher](docs/ecosystem/launcher.md)。\n\n本包另外携带 `bin/world-hub-pack.mjs`、独立 Runtime 与开放部署 Schema；可用 `node bin/world-hub-pack.mjs --help` 查看本地程序包检查、导入、启停和导出。便携包可把 node 换成 runtime\\node.exe。业务模块包另行取得，默认 Hub 启动不执行它们。按目标包锁准备自己的 Python 与依赖；本包没有 Python 便携运行时。默认可信本机模式权限是声明；可选有限 Node 无界面容器模式须另行准备 Linux Docker 与摘要镜像，并逐包审阅。见 docs/ecosystem/isolation.md。完整说明见[外部 Runtime](docs/ecosystem/runtime.md)与[开放部署规范](docs/ecosystem/pack-spec.md)。\n', 'documentation');
  await copy('README.en.md', 'documentation');
  await add('start.cmd', wrapper('start'), 'tooling');
  await add('check.cmd', wrapper('check'), 'tooling');
  await add('verify.cmd', wrapper('verify'), 'tooling');
  await add('demo.cmd', demoWrapper, 'example');
  await add('ui.cmd', uiWrapper, 'tooling');
  async function copyDocs(local) {
    for (const entry of (await readdir(entryPath(sourceRoot, local), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = local + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Documentation symlink is not allowed: ' + path);
      if (entry.isDirectory()) await copyDocs(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) await copy(path, 'documentation');
    }
  }
  await copyDocs('docs');
  for (const path of DOCUMENTATION_IMAGE_FILES) await copy(path, 'documentation-image');
  // Only package documentation copies are adapted; protocol and executable bytes stay exact.
  for (const item of files.filter(item => item.role === 'documentation')) {
    const full = entryPath(output, item.path); let text = await readFile(full, 'utf8');
    const matches = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
    for (const match of matches) {
      const href = match[2]; if (/^(?:https?:|mailto:|#)/i.test(href)) continue;
      const clean = href.replace(/#.*$/, '').replace(/:\d+$/, '');
      try { await access(resolve(dirname(full), clean)); }
      catch {
        text = text.replace(match[0], item.path === 'README.en.md'
          ? `${match[1]} (source repository file; not included in this bundle)`
          : `${match[1]}（源码仓库文件，未随分发包）`);
      }
    }
    await writeFile(full, text); item.size = Buffer.byteLength(text); item.sha256 = hash(text);
  }
  if (runtimeDirectory) for (const name of ['node.exe', 'LICENSE', 'SHASUMS256.txt', 'provenance.json']) await add('runtime/' + name, await readFile(join(runtimeDirectory, name)), 'runtime');
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = { schemaVersion: 1, version, kind, wire: '0.1', builtAt: new Date().toISOString(), runtime: provenance, mutable: ['config/hub.json', 'data/**'], files, sourcePolicy: 'Explicit application/SDK/optional Launcher/Runtime/example/image/machine-contract allowlist and current documentation markdown; no local data, historical files, evidence, dependency modules, model credentials, backup files or global tool wrappers' };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const integrity = await verifyPackage(output);
  if (!integrity.passed) throw new Error('New package integrity failed: ' + JSON.stringify(integrity.failed));
  const archive = output + '.zip'; const zip = await zipDirectory(output, archive); const archiveSha256 = hash(await readFile(archive));
  await writeFile(archive + '.sha256', archiveSha256 + '  ' + basename(archive) + '\n', { flag: 'wx' });
  const result = { passed: true, version, kind, directory: output, archive, archiveSha256, archiveBytes: zip.bytes, files: files.length, runtimeVerified: Boolean(provenance), applicationFiles: APPLICATION_FILES.map(path => ({ path, sha256: files.find(item => item.path === path).sha256 })), excludedUserData: true };
  await writeFile(output + '.build.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') options.output = args[++i];
    else if (args[i] === '--runtime') options.runtimeDirectory = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  try { console.log(JSON.stringify(await buildPackage(options))); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
