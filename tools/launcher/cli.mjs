import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createLauncherServer } from './server.mjs';
import { processCwd } from '../../scripts/runtime/paths.mjs';

async function openLauncherPage(url) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password
    || target.pathname !== '/' || target.search || !/^#launch=[A-Za-z0-9_-]{43}$/.test(target.hash)) throw new Error('Invalid local Launcher address');
  const response = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Launcher page is unavailable');
  await response.body?.cancel();
  const [command, argv] = process.platform === 'win32'
    ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', target.href]]
    : process.platform === 'darwin' ? ['open', [target.href]] : ['xdg-open', [target.href]];
  await new Promise((yes, no) => { const child = spawn(command, argv, { cwd: processCwd(), shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', no); child.once('spawn', () => { child.unref(); yes(); }); });
}

export function parseUiArgs(args) {
  const options = {}, seen = new Set(), names = { '--root': 'root', '--node': 'nodePath', '--python': 'pythonPath', '--port': 'port' };
  for (let index = 0; index < args.length; index++) {
    const option = args[index]; if (seen.has(option)) throw new Error(`Repeated option: ${option}`); seen.add(option);
    if (option === '--open' || option === '--help') { options[option.slice(2)] = true; continue; }
    if (!names[option] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${option}`);
    options[names[option]] = args[++index];
  }
  if (options.port !== undefined) { options.port = Number(options.port); if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port'); }
  return options;
}
export async function runUiCli(args = process.argv.slice(2)) {
  const options = parseUiArgs(args);
  if (options.help) { process.stdout.write('World Hub unified local interface\n\nworld-hub ui [--open] [--root directory] [--port number] [--node executable] [--python executable]\n\nManage reviewed packs, private backups, creator tools and optional sources. Explicit finite dependency preparation; no OS sandbox.\n'); return; }
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const launcher = await createLauncherServer({ ...options, version });
  process.stdout.write(JSON.stringify({ event: 'launcher-ready', version, url: launcher.url, launchUrl: launcher.launchUrl, root: launcher.root }) + '\n');
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runUiCli().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 2; });
