import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createLauncherServer } from './server.mjs';
import { processCwd } from '../../scripts/runtime/paths.mjs';
import { inspectLauncherOwner, cleanLauncherOwner, defaultLauncherRoot } from './owner-lock.mjs';
import { isDirectExecution } from '../../scripts/cli-entry.mjs';

async function openLauncherPage(url) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password
    || target.pathname !== '/' || target.search || !/^#launch=[A-Za-z0-9_-]{43}$/.test(target.hash)) throw new Error('Invalid local Launcher address');
  const response = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Launcher page is unavailable');
  await response.body?.cancel();
  const [command, argv] = process.platform === 'win32'
    ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/c', 'start', '', target.href]]
    : process.platform === 'darwin' ? ['open', [target.href]] : ['xdg-open', [target.href]];
  await new Promise((yes, no) => { const child = spawn(command, argv, { cwd: processCwd(), shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', no); child.once('spawn', () => { child.unref(); yes(); }); });
}

export function parseUiArgs(args) {
  const options = {}, seen = new Set(), names = { '--root': 'root', '--node': 'nodePath', '--python': 'pythonPath', '--port': 'port' };
  for (let index = 0; index < args.length; index++) {
    const option = args[index]; if (seen.has(option)) throw new Error(`Repeated option: ${option}`); seen.add(option);
    if (['--open', '--help', '--inspect-lock', '--clean-lock'].includes(option)) { options[option.slice(2)] = true; continue; }
    if (!names[option] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${option}`);
    options[names[option]] = args[++index];
  }
  if (options.port !== undefined) { options.port = Number(options.port); if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port'); }
  if (options['inspect-lock'] && options['clean-lock']) throw new Error('Choose --inspect-lock or --clean-lock.');
  if ((options['inspect-lock'] || options['clean-lock']) && ['open', 'port', 'nodePath', 'pythonPath'].some(key => options[key] !== undefined)) throw new Error('Lock inspection/cleanup is a separate operation; use only --root.');
  return options;
}
export async function runUiCli(args = process.argv.slice(2)) {
  const options = parseUiArgs(args);
  if (options.help) { process.stdout.write('World Hub unified local interface\n\nworld-hub ui [--open] [--root directory] [--port number] [--node executable] [--python executable]\nworld-hub ui --inspect-lock [--root directory]\nworld-hub ui --clean-lock [--root directory]\n\nInspect is read-only. Cleanup only retires valid metadata when the recorded PID is explicitly absent (Windows/Linux). Live, reused, inaccessible and malformed owners are retained. No process is killed. Startup recovers the same proven dead Launcher locks automatically.\nManage module instances, module groups, wiring and one local Hub. Dependencies are prepared only through reviewed module declarations; no OS sandbox.\n'); return; }
  if (options['inspect-lock'] || options['clean-lock']) {
    const inspect = options['inspect-lock'] ? inspectLauncherOwner : cleanLauncherOwner;
    process.stdout.write(JSON.stringify(await inspect(options.root ?? defaultLauncherRoot()), null, 2) + '\n'); return;
  }
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const launcher = await createLauncherServer({ ...options, version });
  process.stdout.write(JSON.stringify({ event: 'launcher-ready', version, url: launcher.url, launchUrl: launcher.launchUrl, root: launcher.root,
    ...(launcher.ownerRecovery ? { ownerRecovery: launcher.ownerRecovery } : {}) }) + '\n');
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    try { await launcher.close(); process.stdout.write(JSON.stringify({ event: 'launcher-stopped' }) + '\n'); }
    catch (error) { closing = false; process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  if (options.open) {
    try { await openLauncherPage(launcher.launchUrl); }
    catch (error) { process.stderr.write(`Open the launchUrl in your browser: ${error.message}\n`); }
  }
  return launcher;
}
if (isDirectExecution(import.meta.url)) runUiCli().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 2; });
