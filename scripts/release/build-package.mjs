import { mkdir, readFile, writeFile, readdir, lstat, access } from 'node:fs/promises';
import { isDirectExecution } from '../cli-entry.mjs';
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
  ...['console.html', 'canvas-i18n.mjs', 'canvas-modes.mjs', 'management-http.mjs', 'management-modules.mjs', 'management-community.mjs', 'management-state.mjs', 'manual-bridge.mjs', 'manual-console.mjs', 'manual-i18n.mjs', 'manual-experience-state.mjs', 'manual-console.css', 'resource-console.mjs', 'launcher-link.mjs'].map(name => `src/management/${name}`),
];
export const SDK_FILES = ['sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs', 'sdk/javascript/lifecycle-client.mjs',
  'sdk/python/hub_bridge.py', 'sdk/python/requirements.txt',
  'sdk/powershell/HubBridge.psm1', 'sdk/powershell/HubBridge.cs'];
export const SDK_DOCUMENTATION_FILES = Object.freeze(['sdk/javascript/README.md', 'sdk/javascript/LIFECYCLE.md', 'sdk/python/README.md', 'sdk/powershell/README.md']);
export const MODULE_CONTRACT_FILES = Object.freeze(['docs/modules/text-statistics.contract.json']);
export const AGENT_FILES = Object.freeze(['bin/world-hub-skill.mjs', 'bin/world-hub-mcp.mjs',
  ...['SKILL.md','references/setup.md','references/communication.md','references/modules.md','references/mcp.md'].map(name => `skills/world-hub/${name}`),
  ...['package.json','package-lock.json','cli.mjs','config.mjs','service.mjs'].map(name => `tools/mcp/${name}`)]);
export const ECOSYSTEM_SCHEMA_FILES = Object.freeze(['docs/ecosystem/module.schema.json', 'docs/ecosystem/module-group.schema.json', 'docs/ecosystem/configuration.schema.json', 'docs/ecosystem/data.schema.json', 'docs/ecosystem/deployment.schema.json', 'docs/ecosystem/publisher-vectors.json', 'docs/ecosystem/publisher-vector-check.py']);
// No pack runtime or template entry is distributed. These files are retained
// only as shared validation, source, interpreter and owned-process support.
export const SHARED_RUNTIME_FILES = Object.freeze([
  ...['paths','process','hub-process','host-process','host-owner-linux','package','compatibility','source-guidance','deployment','execution-defaults','default-connections','host-profile','startup-order','pack-lineage','developer','dependency-prepare','sources','resource-artifacts','module-group','publisher-trust','publisher-store'].map(name => `scripts/runtime/${name}.mjs`), 'scripts/runtime/host-owner-windows.ps1']);
export const ECOSYSTEM_RUNTIME_FILES = SHARED_RUNTIME_FILES;
export const BUNDLED_TEMPLATE_FILES = Object.freeze([]);
// The old Launcher UI and server are retired. These helpers are imported by
// communication management and retain their internal paths without shipping
// an additional user-facing application.
export const LAUNCHER_FILES = Object.freeze(['bin/world-hub.mjs', 'scripts/cli-entry.mjs',
  ...['owner-lock','local-artifacts','local-programs','resources','program-configuration','module-groups','module-versions','module-uninstall','wiring-defaults','execution-policy','demand-lifecycle','global-external-programs','startup-plan','source-registry','paths-service','environment','topology'].map(name => `tools/launcher/${name}.mjs`)]);
export const CURRENT_DOCUMENTATION_FILES = Object.freeze([
  ...['README','deployment','development','npm','onboarding','releases','repository','verification'].map(name => `docs/${name}.md`),
  ...['modules','developer','developer.en','external-programs','external-programs.en','sources','trust','workshop','interop','agents','agents.en'].map(name => `docs/ecosystem/${name}.md`),
  ...['index','boundaries','protocol','reliability-access','directed-and-bulk','bridge-interoperability','management','manual-workbench','module-resources','operations'].map(name => `docs/specs/${name}.md`),
  'docs/modules/provider-contract.md',
  ...['capability-directory','distributed-context','workflows'].map(name => `docs/examples/${name}.md`)]);
export const SOFT_UI_MODULE_FILES = Object.freeze(['examples/soft-ui-modules/README.md',
  ...['desktop','counter'].flatMap(name=>['README.md','LICENSE','module.json','deployment.json','program.mjs','state.mjs','bridge-kit.mjs','blob-client.mjs'].map(file=>`examples/soft-ui-modules/${name}/${file}`)),
  ...['config.mjs','host.mjs','model.mjs','package.json','package-lock.json','desktop/main.cjs','desktop/manager-preload.cjs','desktop/view-preload.cjs','desktop/manager.html','desktop/manager.js','desktop/manager.css','desktop/view.html','desktop/view.js','desktop/view.css','desktop/assets/tray.png'].map(file=>'examples/soft-ui-modules/desktop/'+file)]);
export const WORKSHOP_FILES = Object.freeze(['tools/workshop/cli.mjs', 'tools/workshop/store.mjs', 'tools/workshop/server.mjs', 'tools/workshop/media.mjs', 'tools/workshop/artifact-configuration.mjs',
  ...['index.html', 'app.mjs', 'artifact-config-view.mjs', 'style.css'].map(name => `tools/workshop/public/${name}`)]);
export const INTEROP_FILES = Object.freeze(['bin/world-hub-interop.mjs', 'tools/interop/text-statistics.mjs',
  ...['javascript', 'python'].flatMap(language => ['authorship.json', 'README.md', language === 'javascript' ? 'provider.mjs' : 'provider.py'].map(file => `tools/interop/providers/${language}/${file}`))]);
export const DOCUMENTATION_IMAGE_FILES = Object.freeze(
  ['hub-topology', 'hub-workbench', 'demo-event-desk', 'demo-modular-assistant', 'demo-digital-world', 'demo-capability-directory']
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
const uiWrapper = `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nset "HUB_NODE=%~dp0runtime\\node.exe"\r\nif not exist "%HUB_NODE%" set "HUB_NODE=node"\r\n"%HUB_NODE%" "%~dp0bin\\world-hub.mjs" --open %*\r\nexit /b %ERRORLEVEL%\r\n`;

const portableReadme = (version, kind) => `## 此发行的启动入口\n\n世界枢纽 ${version}，${kind === 'windows-x64-portable' ? 'Windows x64 便携包，附经过校验的 Node 22.23.2。' : '源码分发，需 Node 22.4.0 或以上。'}\n\n完整解压后双击 ui.cmd 打开通信管理界面；或者运行 node bin/world-hub.mjs --open。便携包可把 node 换成 runtime\\node.exe。模块、模块组、接线、启动计划和信息流都在同一个界面管理，使用同一个本机 Hub。start.cmd 使用发行目录的参考配置启动通信服务；不要用不同入口重复占用同一监听端口。check.cmd 只读检查，verify.cmd 检查发行文件。\n\n单模块和模块组另行导入与审阅，导入不自动启动程序。本发行不执行旧整合包或模板，不自动迁移或删除私人数据。升级前停止所属进程，把新发行解压到新目录并保留自己的配置与完整数据目录。\n`;
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
  for (const path of SHARED_RUNTIME_FILES) await copy(path, 'shared-runtime-support');
  for (const path of SOFT_UI_MODULE_FILES) await copy(path, 'optional-module-source');
  for (const path of INTEROP_FILES) await copy(path, 'tooling');
  for (const path of AGENT_FILES) await copy(path, path.startsWith('skills/') ? 'agent-skill' : 'optional-agent-tool');
  for (const path of LAUNCHER_FILES) await copy(path, path.startsWith('tools/launcher/public/') ? 'application' : 'tooling');
  for (const path of WORKSHOP_FILES) await copy(path, path.includes('/public/') ? 'application' : 'tooling');
  for (const path of EXAMPLE_FILES) await copy(path, 'example');
  await copy('scripts/launcher.mjs', 'tooling');
  await copy('scripts/launcher-support.mjs', 'tooling');
  await copy('scripts/release/verify-package.mjs', 'tooling');
  await copy('config/hub.json', 'configuration');
  await copy('LICENSE', 'license');
  await add('package.json', JSON.stringify({ name: 'world-hub', version, private: true, type: 'module', license: 'MIT', engines: { node: '>=22.4.0' }, exports: { '.': './sdk/javascript/bridge-kit.mjs', './bridge': './sdk/javascript/bridge-kit.mjs', './blob': './sdk/javascript/blob-client.mjs', './lifecycle': './sdk/javascript/lifecycle-client.mjs', './workshop': './tools/workshop/server.mjs' }, scripts: { start: 'node scripts/launcher.mjs', ui: 'node bin/world-hub.mjs --open', check: 'node scripts/launcher.mjs --check', 'verify:package': 'node scripts/release/verify-package.mjs' } }, null, 2) + '\n', 'tooling');
  await add('README.md', (await readFile(join(sourceRoot, 'README.md'), 'utf8')) + '\n' + portableReadme(version, kind), 'documentation');
  await copy('README.en.md', 'documentation');
  await add('start.cmd', wrapper('start'), 'tooling');
  await add('check.cmd', wrapper('check'), 'tooling');
  await add('verify.cmd', wrapper('verify'), 'tooling');
  await add('demo.cmd', demoWrapper, 'example');
  await add('ui.cmd', uiWrapper, 'tooling');
  for (const path of CURRENT_DOCUMENTATION_FILES) await copy(path, 'documentation');
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
  const manifest = { schemaVersion: 1, version, kind, wire: '0.1', builtAt: new Date().toISOString(), runtime: provenance, mutable: ['config/hub.json', 'data/**'], files, sourcePolicy: 'Explicit communication-management/application/SDK/shared-runtime/example/image/machine-contract/current-documentation allowlist; no local data, historical files, evidence, dependency modules, model credentials, backup files or global tool wrappers' };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const integrity = await verifyPackage(output);
  if (!integrity.passed) throw new Error('New package integrity failed: ' + JSON.stringify(integrity.failed));
  const archive = output + '.zip'; const zip = await zipDirectory(output, archive); const archiveSha256 = hash(await readFile(archive));
  await writeFile(archive + '.sha256', archiveSha256 + '  ' + basename(archive) + '\n', { flag: 'wx' });
  const result = { passed: true, version, kind, directory: output, archive, archiveSha256, archiveBytes: zip.bytes, files: files.length, runtimeVerified: Boolean(provenance), applicationFiles: APPLICATION_FILES.map(path => ({ path, sha256: files.find(item => item.path === path).sha256 })), excludedUserData: true };
  await writeFile(output + '.build.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') options.output = args[++i];
    else if (args[i] === '--runtime') options.runtimeDirectory = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  try { console.log(JSON.stringify(await buildPackage(options))); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
