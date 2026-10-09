#!/usr/bin/env node
// Pack and install in disposable prefixes. This command never publishes to npm.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedProgram } from '../../tests/helpers/owned-program.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nonce = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
const safe = value => value.replaceAll('\\', '/');

async function findNpmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  for (const path of candidates) {
    if (!path.endsWith('npm-cli.js')) continue;
    try { await access(path); return path; } catch {}
  }
  throw new Error('Cannot locate npm-cli.js beside Node; run this command through npm run test:npm');
}

async function tree(directory, prefix = '') {
  const entries = [];
  for (const item of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = safe(join(prefix, item.name));
    assert.equal(item.isSymbolicLink(), false, `Unexpected symlink in installed package: ${path}`);
    if (item.isDirectory()) entries.push(...await tree(directory, path));
    else if (item.isFile()) { const bytes = await readFile(join(directory, path)); entries.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
    else throw new Error(`Unexpected installed entry: ${path}`);
  }
  return entries;
}

function allowedPackageFile(path) {
  if (path.split('/').some(part => ['.local', '.artifacts', 'data', 'dist', 'node_modules', '__pycache__', '.venv', '.hub', '.state', 'generated'].includes(part))
      || /(?:\.py[co]|\.log|\.bak|\.tmp|\.tgz|\.zip|\.local\.json)$/i.test(path)) return false;
  return ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'config/hub.json', 'bin/world-hub.mjs',
    'scripts/launcher.mjs', 'scripts/launcher-support.mjs',
    'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs', 'sdk/javascript/README.md',
    'sdk/python/hub_bridge.py', 'sdk/python/requirements.txt', 'sdk/python/README.md',
    'sdk/powershell/HubBridge.psm1', 'sdk/powershell/HubBridge.cs', 'sdk/powershell/README.md',
    'docs/images/hub-topology.jpg', 'docs/images/hub-workbench.jpg',
    'docs/images/demo-event-desk.jpg', 'docs/images/demo-modular-assistant.jpg', 'docs/images/demo-digital-world.jpg',
    'docs/images/hub-topology-en.jpg', 'docs/images/hub-workbench-en.jpg',
    'docs/images/demo-event-desk-en.jpg', 'docs/images/demo-modular-assistant-en.jpg', 'docs/images/demo-digital-world-en.jpg',
    'docs/images/demo-capability-directory.jpg', 'docs/images/demo-capability-directory-en.jpg',
    'docs/modules/text-statistics.contract.json'].includes(path)
    || /^src\/.+\.(?:mjs|js|html|css|json)$/.test(path)
    || /^docs\/.+\.md$/.test(path);
}

export async function acceptNpmPackage({ sourceRoot = root, evidenceRoot = join(root, '.artifacts/npm'), archive: suppliedArchive } = {}) {
  const directory = join(resolve(evidenceRoot), `acceptance-${nonce}`);
  await mkdir(directory, { recursive: true });
  const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const npmCli = await findNpmCli();
  const report = { passed: false, package: `${pkg.name}@${pkg.version}`, startedAt: new Date().toISOString(),
    evidence: directory, node: process.version, npmCli, checks: [], processes: [], limitations: [
      'Installs are into isolated local and global prefixes; no user-wide installation is changed.',
      'The archive is installed and tested locally; this command does not publish or change a registry.',
    ] };
  const save = (file, value) => writeFile(join(directory, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const owned = [];
  let counter = 0;
  async function execute(label, command, args, { cwd = sourceRoot, timeout = 60_000 } = {}) {
    const key = String(++counter).padStart(2, '0');
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const row = { label, command, args, cwd, pid: child.pid, passed: false }; report.checks.push(row);
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    try {
      row.exit = await new Promise(resolveExit => {
        child.once('error', error => resolveExit({ code: null, error: error.message }));
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      });
    } finally { clearTimeout(timer); }
    row.timedOut = timedOut; row.stdout = `${key}.stdout.txt`; row.stderr = `${key}.stderr.txt`;
    await save(row.stdout, stdout); await save(row.stderr, stderr);
    row.passed = row.exit.code === 0 && !timedOut;
    if (!row.passed) throw new Error(`${label}: ${stderr || stdout || row.exit.error}`);
    return stdout;
  }
  const npm = (label, args, options) => execute(label, process.execPath, [npmCli, ...args], options);
  try {
    assert.equal(pkg.private, undefined, 'Remove private rather than publishing a private project manifest');
    assert.equal(pkg.license, 'MIT'); assert.equal(pkg.bin?.['world-hub'], 'bin/world-hub.mjs');
    assert.equal(pkg.exports?.['.'], './sdk/javascript/bridge-kit.mjs');
    assert.equal(pkg.exports?.['./blob'], './sdk/javascript/blob-client.mjs');
    assert.deepEqual(pkg.dependencies ?? {}, {}); assert.deepEqual(pkg.optionalDependencies ?? {}, {});
    await access(join(sourceRoot, 'LICENSE'));
    let archive;
    if (suppliedArchive) archive = resolve(suppliedArchive);
    else {
      const packed = JSON.parse(await npm('Build the exact npm tarball without lifecycle scripts', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
      assert.equal(packed.length, 1); report.pack = packed[0];
      const forbidden = report.pack.files.filter(file => !allowedPackageFile(file.path));
      assert.deepEqual(forbidden.map(file => file.path), [], 'Unexpected or generated source in npm allowlist');
      assert.ok(report.pack.files.some(file => file.path === 'LICENSE'));
      assert.ok(report.pack.files.some(file => file.path === 'bin/world-hub.mjs'));
      assert.ok(report.pack.files.some(file => file.path === 'README.en.md'));
      for (const path of ['docs/modules/provider-contract.md', 'docs/modules/text-statistics.contract.json', 'sdk/javascript/README.md']) {
        assert.ok(report.pack.files.some(file => file.path === path), `Independent provider material is absent from the tarball: ${path}`);
      }
      archive = join(directory, report.pack.filename);
    }
    const archiveBytes = await readFile(archive);
    report.archive = archive; report.archiveBytes = archiveBytes.length; report.archiveSha256 = hash(archiveBytes);
    report.archiveIntegrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
    const testing = join(directory, '中文 空格 测试');
    const localApp = join(testing, 'local app'), globalPrefix = join(testing, 'global prefix'), workspace = join(testing, '调用 工作目录');
    await Promise.all([mkdir(localApp, { recursive: true }), mkdir(globalPrefix, { recursive: true }), mkdir(workspace, { recursive: true })]);
    await writeFile(join(localApp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await npm('Install tarball locally with no scripts, dependencies or online registry access',
      ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--save=false', archive], { cwd: localApp });
    await npm('Install tarball into an isolated global prefix', ['install', '--global', '--prefix', globalPrefix,
      '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: workspace });
    const localPackage = join(localApp, 'node_modules', ...pkg.name.split('/'));
    const globalPackage = join(globalPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', ...pkg.name.split('/'));
    const beforeLocal = await tree(localPackage), beforeGlobal = await tree(globalPackage);
    for (const installation of [localPackage, globalPackage]) {
      const installed = JSON.parse(await readFile(join(installation, 'package.json'), 'utf8'));
      assert.equal(installed.name, pkg.name); assert.equal(installed.version, pkg.version); assert.equal(installed.license, 'MIT');
      assert.deepEqual(installed.bin, pkg.bin); assert.deepEqual(installed.exports, pkg.exports);
      assert.deepEqual(installed.dependencies ?? {}, {}); assert.deepEqual(installed.optionalDependencies ?? {}, {});
      for (const path of ['docs/modules/provider-contract.md', 'docs/modules/text-statistics.contract.json', 'sdk/javascript/README.md']) {
        assert.equal(hash(await readFile(join(installation, path))), hash(await readFile(join(sourceRoot, path))),
          `Provider material changed during npm packaging: ${path}`);
      }
      const guide = await readFile(join(installation, 'docs/modules/provider-contract.md'), 'utf8');
      for (const match of guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^(?:https?:|mailto:|#)/i.test(match[1])) continue;
        await access(resolve(installation, 'docs/modules', match[1].replace(/#.*$/, '').replace(/:\d+$/, '')));
      }
    }
    assert.deepEqual(JSON.parse(await readFile(join(localPackage, 'docs/modules/text-statistics.contract.json'), 'utf8')),
      JSON.parse(await readFile(join(sourceRoot, 'examples/capability-directory/contract.json'), 'utf8')),
      'The public machine contract and compatibility example disagree');
    for (const entries of [beforeLocal, beforeGlobal]) {
      assert.ok(entries.some(file => file.path === 'README.en.md'), 'English README is absent from the installed package');
      for (const path of ['docs/modules/provider-contract.md', 'docs/modules/text-statistics.contract.json', 'sdk/javascript/README.md']) {
        assert.ok(entries.some(file => file.path === path), `Independent provider material is absent from the installed package: ${path}`);
      }
      assert.deepEqual(entries.filter(file => !allowedPackageFile(file.path)).map(file => file.path), [], 'Unexpected or generated installed file');
      assert.ok(entries.every(file => !file.path.split('/').some(part => ['.local', '.artifacts', 'data', 'dist', 'node_modules'].includes(part))
        && !/^(?:tests|examples)\//.test(file.path)));
    }
    const directChecked = JSON.parse(await execute('Check installed CLI from a different cwd without writing data', process.execPath,
      [join(localPackage, 'bin/world-hub.mjs'), '--check', '--port', '0'], { cwd: workspace }));
    assert.equal(directChecked.persisted, false); assert.equal(directChecked.configPath, join(workspace, 'world-hub-data/hub.json'));
    assert.deepEqual(await readdir(workspace), []);
    const execChecked = JSON.parse(await npm('Resolve the installed executable through npm exec',
      ['exec', '--offline', '--prefix', localApp, '--', 'world-hub', '--check', '--port', '0'], { cwd: workspace }));
    assert.equal(execChecked.persisted, false); assert.equal(execChecked.bundleRoot, resolve(localPackage));
    assert.deepEqual(await readdir(workspace), []);
    const shim = process.platform === 'win32' ? join(globalPrefix, 'world-hub.cmd') : join(globalPrefix, 'bin/world-hub');
    await access(shim); report.globalShim = shim;
    if (process.platform === 'win32') {
      const wrapper = join(directory, 'invoke-global.ps1');
      await writeFile(wrapper, 'param([Parameter(Mandatory=$true)][string]$Shim)\n& $Shim --check --port 0\nexit $LASTEXITCODE\n');
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const checked = JSON.parse(await execute('Run the actual isolated global Windows shim', powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, shim], { cwd: workspace }));
      assert.equal(checked.persisted, false);
    } else {
      const checked = JSON.parse(await execute('Run the actual isolated global shim', shim, ['--check', '--port', '0'], { cwd: workspace }));
      assert.equal(checked.persisted, false);
    }
    assert.deepEqual(await readdir(workspace), []);
    const server = await startOwnedProgram(join(localPackage, 'bin/world-hub.mjs'), { cwd: workspace, args: ['--port', '0'] });
    owned.push(server); report.processes.push({ role: 'installed-default-hub', pid: server.child.pid, port: server.ready.port });
    const manage = await fetch(`http://127.0.0.1:${server.ready.port}/manage`, { signal: AbortSignal.timeout(5000) });
    assert.equal(manage.status, 200); assert.match(manage.headers.get('content-type'), /text\/html/);
    assert.match(await manage.text(), /世界枢纽|world-hub/i);
    report.checks.push({ label: 'Installed default Hub serves its real management interface', passed: true, port: server.ready.port });
    for (const [url, path] of [
      ['/ui/language.mjs', 'src/ui/language.mjs'],
      ['/manage/canvas-i18n.mjs', 'src/management/canvas-i18n.mjs'],
      ['/manage/manual-i18n.mjs', 'src/management/manual-i18n.mjs'],
    ]) {
      const asset = await fetch(`http://127.0.0.1:${server.ready.port}${url}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /text\/javascript/);
      assert.equal(await asset.text(), await readFile(join(sourceRoot, path), 'utf8'), `Installed UI asset differs: ${path}`);
    }
    report.checks.push({ label: 'Installed bilingual UI serves the exact shared language module and both dictionaries', passed: true });
    const probe = join(localApp, 'sdk-probe.mjs');
    await writeFile(probe, `import assert from 'node:assert/strict';
import { Bridge, WIRE_VERSION } from ${JSON.stringify(pkg.name)};
import { Bridge as SubpathBridge } from ${JSON.stringify(pkg.name + '/bridge')};
import { uploadFile, uploadStream, downloadFile, readAttachment } from ${JSON.stringify(pkg.name + '/blob')};
assert.equal(Bridge, SubpathBridge); assert.equal(WIRE_VERSION, '0.1');
for (const value of [uploadFile, uploadStream, downloadFile, readAttachment]) assert.equal(typeof value, 'function');
const bridge = new Bridge({ url: process.argv[2], bridgeId: 'npm-test', credential: 'ui.manual', reconnectMs: 100 });
bridge.on('error', () => {}); bridge.on('denied', () => {});
let resolveDelivery; const delivered = new Promise(resolve => { resolveDelivery = resolve; });
const deadline = setTimeout(() => { process.stderr.write('SDK delivery timeout\\n'); process.exitCode = 1; bridge.close(); }, 5000);
bridge.on('delivery', message => { if (message.topic === 'npm/test/roundtrip') resolveDelivery(message); });
try { await bridge.connect(); await bridge.registerChannels([{ name: 'npm/test/roundtrip', publish: true, subscribe: true }]);
  await bridge.subscribe(['npm/test/roundtrip'], { from: 0 }); const receipt = await bridge.publishConfirmed('npm/test/roundtrip', { source: 'installed-sdk', value: 13 });
  const result = await delivered; assert.deepEqual(result.body, { source: 'installed-sdk', value: 13 }); assert.equal(result.seq, receipt.seq);
  console.log(JSON.stringify({ passed: true, wire: WIRE_VERSION, seq: receipt.seq }));
} finally { clearTimeout(deadline); await bridge.close(); }
`);
    const sdk = JSON.parse(await execute('Import package exports and exchange information through a real installed bridge', process.execPath,
      [probe, `ws://127.0.0.1:${server.ready.port}/bridge`], { cwd: localApp }));
    assert.equal(sdk.passed, true);
    const custom = JSON.parse(await readFile(join(sourceRoot, 'config/hub.json'), 'utf8'));
    custom.transport.port = 0; custom.hub.id = 'npm-custom-config';
    const customPath = join(workspace, '自定义 配置.json'); const customBytes = JSON.stringify(custom, null, 2) + '\n';
    await writeFile(customPath, customBytes);
    const customServer = await startOwnedProgram(join(globalPackage, 'bin/world-hub.mjs'), { cwd: workspace,
      args: ['--config', relative(workspace, customPath), '--data-dir', '第二份 数据', '--port', '0'] });
    owned.push(customServer); report.processes.push({ role: 'isolated-global-custom-hub', pid: customServer.child.pid, port: customServer.ready.port });
    assert.notEqual(server.ready.port, customServer.ready.port);
    const customStatus = await fetch(`http://127.0.0.1:${customServer.ready.port}/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(customStatus.status, 200); assert.equal(await readFile(customPath, 'utf8'), customBytes);
    report.checks.push({ label: 'Custom config, explicit data root and two simultaneous assigned ports are independent', passed: true });
    for (const record of owned.reverse()) {
      const exit = await record.stop(); assert.equal(exit.code, 0, record.stderr);
      const row = report.processes.find(item => item.pid === record.child.pid); row.exit = exit;
      await assert.rejects(fetch(`http://127.0.0.1:${record.ready.port}/status`, { signal: AbortSignal.timeout(1000) }));
    }
    owned.length = 0;
    assert.deepEqual(await tree(localPackage), beforeLocal); assert.deepEqual(await tree(globalPackage), beforeGlobal);
    report.installationTrees = { local: beforeLocal, global: beforeGlobal };
    report.checks.push({ label: 'Read-only checks and complete runtime lifecycle never modify either installation tree', passed: true });
    for (const dir of [join(workspace, 'world-hub-data/log'), join(workspace, 'world-hub-data/blobs'),
      join(workspace, '第二份 数据/log'), join(workspace, '第二份 数据/blobs')]) {
      assert.ok(!(await readdir(dir)).includes('.world-hub-package.lock'), `Residual running lock: ${dir}`);
    }
    report.checks.push({ label: 'Owned Hub processes stopped and storage locks and listeners were released', passed: true });
    report.passed = true;
  } catch (error) { report.error = error.stack ?? String(error); }
  finally {
    for (const record of owned.reverse()) {
      const exit = await record.stop(); const row = report.processes.find(item => item.pid === record.child.pid);
      if (row) row.exit = exit;
    }
    report.finishedAt = new Date().toISOString(); await save('report.json', report);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const seen = new Set(); const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index], value = argv[index + 1];
    if (!['--evidence', '--archive'].includes(option) || !value || value.startsWith('--') || seen.has(option)) throw new Error('usage: npm-package-acceptance.mjs [--evidence directory] [--archive existing.tgz]');
    seen.add(option); options[option === '--evidence' ? 'evidenceRoot' : 'archive'] = value;
  }
  const report = await acceptNpmPackage(options);
  process.stdout.write(JSON.stringify({ passed: report.passed, package: report.package, archive: report.archive,
    sha256: report.archiveSha256, checks: report.checks.length, report: join(report.evidence, 'report.json'), ...(report.error ? { error: report.error } : {}) }, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}
