// Distribution-only checks and presentation. This module does not create a Hub
// or write storage; the original server remains the sole runtime implementation.
import { access, readFile, stat } from 'node:fs/promises';
import { constants, closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const REQUIRED_FILES = [
  'package.json',
  'src/hub/hub-server.mjs',
  'src/hub/ws-server.mjs',
  ...['acl', 'address', 'blob-protocol', 'blob-store', 'hub', 'identity', 'router', 'store', 'topic', 'wire-json']
    .map(name => `src/hub/lib/${name}.mjs`),
  'src/debug/page.mjs',
  ...['management-http.mjs', 'management-state.mjs', 'console.html', 'manual-bridge.mjs', 'manual-console.mjs', 'manual-experience-state.mjs', 'manual-console.css']
    .map(name => `src/management/${name}`),
];

export function parseArgs(argv) {
  const args = { config: 'config/hub.json', port: null, check: false, open: false, help: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    const canonical = option === '-c' ? '--config' : option === '-p' ? '--port' : option === '-h' ? '--help' : option;
    if (!['--config', '--port', '--check', '--open', '--help'].includes(canonical)) {
      throw new Error(`未知参数：${option}。使用 --help 查看用法。`);
    }
    if (seen.has(canonical)) throw new Error(`参数重复：${canonical}`);
    seen.add(canonical);
    if (canonical === '--config' || canonical === '--port') {
      const value = argv[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`${canonical} 缺少值`);
      if (canonical === '--config') args.config = value;
      else {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535) {
          throw new Error('--port 必须为 0 至 65535 的整数（0 由系统选择端口）');
        }
        args.port = Number(value);
      }
    } else args[canonical.slice(2)] = true;
  }
  if (args.check && args.open) throw new Error('--check 与 --open 不能一起使用；环境检查不会启动枢纽。');
  return args;
}

async function requireFile(file, label) {
  let info;
  try { info = await stat(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label}缺失：${file}`);
    throw error;
  }
  if (!info.isFile()) throw new Error(`${label}必须为文件：${file}`);
  await access(file, constants.R_OK);
}

async function inspectStoragePath(file, expectedDirectory) {
  try {
    const info = await stat(file);
    if (expectedDirectory ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`${expectedDirectory ? '数据目录' : '管理状态文件'}类型错误：${file}`);
    }
    await access(expectedDirectory ? file : dirname(file), constants.W_OK);
    return { path: file, exists: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let ancestor = dirname(file);
  while (true) {
    try {
      const info = await stat(ancestor);
      if (!info.isDirectory()) throw new Error(`数据路径的父级不是目录：${ancestor}`);
      await access(ancestor, constants.W_OK);
      return { path: file, exists: false, writableAncestor: ancestor };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`无法找到数据路径的父目录：${file}`);
      ancestor = parent;
    }
  }
}

export async function checkEnvironment(bundleRoot, args, { nodeVersion = process.versions.node, rawConfig, configPath: suppliedConfigPath } = {}) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 4)) {
    throw new Error(`需要 Node.js 22.4.0 或更高版本，当前为 ${nodeVersion}；便携运行时固定为 22.23.2`);
  }
  const root = resolve(bundleRoot);
  for (const item of REQUIRED_FILES) await requireFile(resolve(root, item), '整合包文件');
  const configPath = suppliedConfigPath ?? resolve(root, args.config);
  if (rawConfig === undefined) await requireFile(configPath, '配置文件');
  const raw = rawConfig === undefined ? JSON.parse(await readFile(configPath, 'utf8')) : rawConfig;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置文件的根必须为 JSON 对象');
  // Loading the original normalizer keeps config semantics identical and performs
  // no persistence. Do not import hub-server here: that is an executable entry.
  const { normalizeConfig } = await import(pathToFileURL(join(root, 'src/hub/lib/store.mjs')).href);
  const config = normalizeConfig(raw, configPath);
  const port = args.port ?? config.transport.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('transport.port 必须为 0 至 65535 的整数');
  if (typeof config.transport.host !== 'string' || !config.transport.host.trim()) throw new Error('transport.host 必须为非空字符串');
  if (typeof config.transport.path !== 'string' || !/^\/[^\s?#]*$/.test(config.transport.path)
      || new URL(config.transport.path, 'ws://127.0.0.1').pathname !== config.transport.path) {
    throw new Error('transport.path 必须是以 / 开头且不含空白、查询或片段的路径，并保持 URL 规范化后的路径不变；中文请使用百分号编码，避免反斜线和 dot 段');
  }
  if (config.log.enabled !== true && config.log.enabled !== false) throw new Error('log.enabled 必须为布尔值');
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const storage = {
    log: config.log.enabled ? await inspectStoragePath(config.log.dir, true) : { path: config.log.dir, enabled: false },
    management: await inspectStoragePath(config.management.stateFile, false),
    blobs: await inspectStoragePath(config.blobs.dir, true),
  };
  return {
    event: 'checked', ok: true, version: packageInfo.version, bundleRoot: root,
    nodeVersion, nodeExecutable: process.execPath, configPath,
    transport: { ...config.transport, port }, storage, requiredFiles: REQUIRED_FILES.length,
    // The check is a current access check, not a guarantee against later changes
    // in permissions, free space, port availability or concurrent processes.
    persisted: false,
  };
}

export async function checkPortAvailable({ host, port }) {
  if (port === 0) return;
  const server = createServer();
  await new Promise((resolveProbe, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') reject(new Error(`启动失败：${host}:${port} 已被占用。请关闭占用程序或使用 --port 指定另一端口。`));
      else reject(new Error(`无法监听 ${host}:${port}：${error.message}`));
    });
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolveProbe()));
  });
}

export function acquireDataLocks(checked) {
  const nonce = randomUUID();
  const requested = [checked.storage.blobs.path, dirname(checked.storage.management.path)];
  if (checked.storage.log.enabled !== false) requested.push(checked.storage.log.path);
  const held = [];
  const release = () => {
    for (const lock of held.splice(0).reverse()) {
      try {
        // Never remove another invocation's lock, including one replaced while
        // this launcher was running. PID liveness is deliberately not inferred.
        const current = JSON.parse(readFileSync(lock.path, 'utf8'));
        if (current.nonce === nonce) unlinkSync(lock.path);
      } catch (error) {
        if (error.code !== 'ENOENT') process.stderr.write(`运行锁未移除：${lock.path}（${error.message}）\n`);
      }
    }
  };
  try {
    const directories = [];
    for (const directory of requested) {
      mkdirSync(directory, { recursive: true });
      directories.push(realpathSync(directory));
    }
    for (const directory of [...new Set(directories)].sort()) {
      const file = join(directory, '.world-hub-package.lock');
      let fd;
      try { fd = openSync(file, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const locked = new Error(`数据目录已被运行锁保护：${file}。请先正常停止占用该数据的枢纽；若为异常退出遗留，确认没有枢纽运行后手动移走该锁，再启动。不会自动删除锁或终止 PID。`);
        locked.code = 'PACKAGE_DATA_LOCKED';
        throw locked;
      }
      try {
        writeFileSync(fd, JSON.stringify({ version: 1, nonce, pid: process.pid, at: new Date().toISOString(),
          configPath: checked.configPath, nodeExecutable: process.execPath }) + '\n', 'utf8');
        held.push({ path: file });
      } catch (error) {
        // This file was just exclusively created by this invocation. Remove it
        // even if no complete nonce record could be written.
        try { unlinkSync(file); } catch {}
        throw error;
      } finally { closeSync(fd); }
    }
    return { paths: held.map(lock => lock.path), release };
  } catch (error) { release(); throw error; }
}

export function readyUrls(ready, bridgePath) {
  const host = ready.host;
  const wrap = value => value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  const bridgeUrl = `ws://${wrap(host)}:${ready.port}${bridgePath}`;
  const localHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(localHost);
  const base = loopback ? `http://${wrap(localHost)}:${ready.port}` : null;
  return { bridgeUrl, managementUrl: base ? `${base}/manage` : null, statusUrl: base ? `${base}/status` : null };
}

export async function openManagementPage(url) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || target.username || target.password || target.pathname !== '/manage' || target.search || target.hash) {
    throw new Error('自动打开仅支持当前枢纽的本机管理地址');
  }
  const response = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok || !String(response.headers.get('content-type')).includes('text/html')) {
    await response.body?.cancel();
    throw new Error(`管理入口尚不可用：HTTP ${response.status}`);
  }
  await response.body?.cancel();
  const [command, argv] = process.platform === 'win32'
    ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', target.href]]
    : process.platform === 'darwin' ? ['open', [target.href]] : ['xdg-open', [target.href]];
  await new Promise((resolveOpen, reject) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveOpen(); });
  });
}

// Observe the original machine-readable ready line without rewriting it. Restore
// stdout before presentation so launcher messages cannot be parsed as Hub events.
export function observeReady(stdout, onReady) {
  const original = stdout.write;
  let pending = '';
  const restore = () => { if (stdout.write === wrapped) stdout.write = original; };
  function wrapped(chunk, ...rest) {
    const result = original.call(stdout, chunk, ...rest);
    pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (pending.length > 128 * 1024) pending = pending.slice(-128 * 1024);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event !== 'ready') continue;
      restore();
      // Queue outside the Hub's logging call; a presentation/open failure must
      // never reject the actual server startup.
      queueMicrotask(() => onReady(event));
      break;
    }
    return result;
  }
  stdout.write = wrapped;
  return restore;
}
