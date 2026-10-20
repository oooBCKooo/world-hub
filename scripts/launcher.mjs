#!/usr/bin/env node
// Foreground portable-package entry. The Hub runs in this same process so its
// original Ctrl+C shutdown flushes storage on Windows as well as Unix.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectExecution } from './cli-entry.mjs';
import { acquireDataLocks, checkEnvironment, checkPortAvailable, observeReady, parseArgs, readyUrls } from './launcher-support.mjs';

export const BUNDLE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HELP = `世界枢纽（无界面，前台运行）

  node scripts/launcher.mjs [--config <path>] [--port <n>]
  node scripts/launcher.mjs --check [--config <path>]

  --config, -c <path>  默认 config/hub.json；相对路径以整合包根目录为基准
  --port, -p <n>       仅本次启动覆盖监听端口；0 至 65535，0 为系统分配
  --check             只读检查 Node、配置、必需资源与数据路径，不启动、不落盘
  --help, -h          显示帮助

启动后使用 Ctrl+C，等待 stopped 行后关闭终端。请不要直接关闭窗口或强杀进程。
本入口运行无界面枢纽和管理 JSON API；其他程序通过自己的枢纽桥接入。
可选界面由独立 world-hub-ui 项目提供。
源码仓库和整合包均使用 config/hub.json；可明确传入自己的配置路径。
`;

export async function runLauncher(argv = process.argv.slice(2), { bundleRoot = BUNDLE_ROOT } = {}) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP); return; }
  const checked = await checkEnvironment(bundleRoot, args);
  if (args.check) { process.stdout.write(JSON.stringify(checked, null, 2) + '\n'); return; }
  await checkPortAvailable(checked.transport);
  const locks = acquireDataLocks(checked);
  process.once('exit', locks.release);
  let readySeen = false, requestedStop = false, stopping = false;
  const send = event => {
    if (!process.connected || typeof process.send !== 'function') return;
    try { process.send(event, () => {}); } catch {}
  };
  const stop = () => {
    requestedStop = true;
    if (!readySeen || stopping) return;
    stopping = true;
    setTimeout(() => {
      process.stderr.write('正常停机超过 5 秒，入口将以错误状态退出；请检查数据后再启动。\n');
      process.exit(1);
    }, 5000).unref();
    // Only a direct parent IPC channel can request this. The Hub's original
    // signal handler performs close/flush; no network management stop API exists.
    process.emit('SIGTERM');
  };
  if (typeof process.send === 'function') {
    process.on('message', message => { if (message?.type === 'stop') stop(); });
    process.once('disconnect', stop);
  }
  process.stderr.write(`世界枢纽 ${checked.version}，前台运行。配置：${checked.configPath}\n`);
  process.stderr.write(`数据目录：${checked.storage.log.path}；使用 Ctrl+C 等待正常停机。\n`);
  const restore = observeReady(process.stdout, ready => {
    readySeen = true;
    const urls = readyUrls(ready, checked.transport.path);
    process.stderr.write(`已就绪（PID ${ready.pid}）\nmod 通讯：${urls.bridgeUrl}\n`);
    if (urls.managementApiUrl) process.stderr.write(`管理 API：${urls.managementApiUrl}\n只读状态：${urls.statusUrl}\n`);
    else process.stderr.write('当前监听地址不提供本机回环管理 API；管理 API 需要监听回环或通配地址。\n');
    const httpUrl = urls.managementApiUrl ? new URL(urls.managementApiUrl).origin : null;
    send({ type: 'ready', pid: ready.pid, port: ready.port, httpUrl, httpBase: httpUrl, wsUrl: urls.bridgeUrl,
      managementApiUrl: urls.managementApiUrl, statusUrl: urls.statusUrl, configPath: checked.configPath,
      dataRoot: dirname(checked.storage.management.path), storage: checked.storage, locks: locks.paths });
    if (requestedStop) stop();
  });
  const entry = resolve(bundleRoot, 'src/hub/hub-server.mjs');
  const originalArgv = process.argv;
  process.argv = [process.execPath, entry, '--config', checked.configPath];
  if (args.port !== null) process.argv.push('--port', String(args.port));
  try {
    // Its main() parses argv synchronously during evaluation. Import the original
    // entry only once; do not fork another server or introduce an IPC stop path.
    await import(pathToFileURL(entry).href);
  } catch (error) {
    restore();
    process.removeListener('exit', locks.release);
    locks.release();
    throw error;
  } finally { process.argv = originalArgv; }
}

if (isDirectExecution(import.meta.url)) {
  runLauncher().catch(error => {
    process.stderr.write(`整合包启动失败：${error.message}\n`);
    if (process.connected && typeof process.send === 'function') {
      try { process.send({ type: 'error', message: error.message, code: error.code ?? 'PACKAGE_START_FAILED' }, () => {}); } catch {}
      process.disconnect();
    }
    process.exitCode = 2;
  });
}
