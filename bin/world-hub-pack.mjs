#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPackage, createLock, importPackage, startInstance, statusInstance, logsInstance, stopInstance, exportInstance } from '../scripts/runtime/index.mjs';

export const HELP = `World Hub optional local pack Runtime (trusted local code; no OS sandbox)

  world-hub-pack plan <pack-directory> [--node executable] [--python executable]
  world-hub-pack lock <pack-directory> [--node executable] [--python executable]
  world-hub-pack import <pack-directory> --root directory --instance id [--node executable] [--python executable]
  world-hub-pack start --root directory --instance id --trust review-digest [--node executable] [--python executable]
  world-hub-pack status|logs|stop --root directory --instance id
  world-hub-pack export --root directory --instance id --destination new-directory [--node executable] [--python executable]

lock explicitly pins local module bytes/platform/runtime versions. It is an authoring action.
plan/import/export do not run modules or install dependencies. start keeps the supervisor in this terminal.
Review declared permissions and code before supplying the exact trust digest. Ctrl+C stops owned processes.
`;
export function parseArgs(argv) {
  if (argv.length === 0 || argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const command = argv[0];
  const operations = ['plan', 'lock', 'import', 'start', 'status', 'logs', 'stop', 'export'];
  if (!operations.includes(command)) throw new Error('Unknown operation; use --help');
  let index = 1, packDirectory;
  if (['plan', 'lock', 'import'].includes(command)) { packDirectory = argv[index++]; if (!packDirectory || packDirectory.startsWith('--')) throw new Error('Missing pack directory'); }
  const accepted = ['plan', 'lock'].includes(command) ? ['--node', '--python']
    : command === 'import' ? ['--root', '--instance', '--node', '--python']
      : command === 'start' ? ['--root', '--instance', '--trust', '--node', '--python']
        : command === 'export' ? ['--root', '--instance', '--destination', '--node', '--python'] : ['--root', '--instance'];
  const options = {}, seen = new Set();
  const keys = { '--root': 'root', '--instance': 'instanceId', '--node': 'nodePath', '--python': 'pythonPath', '--trust': 'trust', '--destination': 'destination' };
  for (; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!accepted.includes(key) || seen.has(key) || !value || value.startsWith('--')) throw new Error(`Unknown, duplicate or incomplete option: ${key}`);
    seen.add(key); options[keys[key]] = value;
  }
  if (!['plan', 'lock'].includes(command) && (!options.root || !options.instanceId)) throw new Error('--root and --instance are required');
  if (command === 'start' && !options.trust) throw new Error('--trust must be the reviewed digest from import/plan');
  if (command === 'export' && !options.destination) throw new Error('--destination is required');
  return { command, packDirectory, options };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP); return; }
  const print = value => console.log(JSON.stringify(value));
  const { command, packDirectory, options } = args;
  if (command === 'plan') { const plan = await inspectPackage(packDirectory, options); print(plan); }
  else if (command === 'lock') print(await createLock(packDirectory, options));
  else if (command === 'import') { const result = await importPackage(packDirectory, options); print(result); }
  else if (command === 'status') print(await statusInstance(options));
  else if (command === 'logs') print(await logsInstance(options));
  else if (command === 'stop') print(await stopInstance(options));
  else if (command === 'export') print(await exportInstance(options));
  else {
    let session, interrupted = false; const controller = new AbortController();
    const stop = () => { interrupted = true; if (session) void session.close().catch(error => { console.error(error.message); process.exitCode = 1; }); else controller.abort(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      session = await startInstance({ ...options, signal: controller.signal }); print(session.ready);
      if (interrupted) await session.close();
      const terminal = await session.closed; print({ event: 'pack-stopped', ...terminal });
      if (terminal.state === 'failed') process.exitCode = 1;
    } catch (error) { if (error.code !== 'START_STOPPED') throw error; print({ event: 'pack-stopped', ...(await statusInstance(options)) }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, error: { code: 'PACK_RUNTIME_ERROR', message: error.message } })); process.exitCode = 1; });
}
