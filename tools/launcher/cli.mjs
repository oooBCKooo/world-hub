import { readFile } from 'node:fs/promises';
import { createLauncherServer } from './server.mjs';
import { inspectLauncherOwner, cleanLauncherOwner, defaultLauncherRoot } from './owner-lock.mjs';
import { isDirectExecution } from '../../scripts/cli-entry.mjs';

export function parseUiArgs(args) {
  const options = {}, seen = new Set(), names = { '--root': 'root', '--node': 'nodePath', '--python': 'pythonPath', '--port': 'port' };
  for (let index = 0; index < args.length; index++) {
    const option = args[index]; if (seen.has(option)) throw new Error(`Repeated option: ${option}`); seen.add(option);
    if (['--help', '--inspect-lock', '--clean-lock'].includes(option)) { options[option.slice(2)] = true; continue; }
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
  if (options.help) { process.stdout.write('World Hub local module administration API\n\nnode tools/launcher/cli.mjs [--root directory] [--port number] [--node executable] [--python executable]\nnode tools/launcher/cli.mjs --inspect-lock [--root directory]\nnode tools/launcher/cli.mjs --clean-lock [--root directory]\n\nAPI only; graphical clients are separate projects. Inspection is read-only. Cleanup retires only metadata whose owner is proven absent and never kills a process.\n'); return; }
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
  return launcher;
}
if (isDirectExecution(import.meta.url)) runUiCli().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 2; });
