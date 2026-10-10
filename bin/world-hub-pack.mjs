#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPackage, createLock, importPackage, startInstance, statusInstance, logsInstance, stopInstance, exportInstance,
  backupInstance, inspectBackup, restoreInstance, storageInstance, detachInstance, reattachInstance,
  inspectAuthoring, previewReplacement, derivePackage, rebuildPackage, exportProposal, applyProposal, readSourceIndex, fetchSourceArtifact, publishArtifact } from '../scripts/runtime/index.mjs';
import { readBounded } from '../scripts/runtime/paths.mjs';

export const HELP = `World Hub optional local pack Runtime (trusted local code; no OS sandbox)

  world-hub-pack plan <pack-directory> [--node executable] [--python executable]
  world-hub-pack lock <pack-directory> [--node executable] [--python executable]
  world-hub-pack import <pack-directory> --root directory --instance id [--node executable] [--python executable]
  world-hub-pack start --root directory --instance id --trust review-digest [--node executable] [--python executable]
  world-hub-pack status|logs|stop --root directory --instance id
  world-hub-pack export --root directory --instance id --destination new-directory [--node executable] [--python executable]
  world-hub-pack storage|detach --root directory --instance id
  world-hub-pack backup --root directory --instance id --destination new-private.whbackup [--node executable] [--python executable]
  world-hub-pack inspect-backup <private.whbackup>
  world-hub-pack restore --root directory --instance new-id --backup private.whbackup --sha256 inspected-digest [--node executable] [--python executable]
  world-hub-pack reattach --root directory --instance id --trust current-review-digest [--node executable] [--python executable]
  world-hub-pack authoring <pack-directory> [--node executable] [--python executable]
  world-hub-pack init-module <new-directory> --id module-id --runtime node|python
  world-hub-pack validate-module <module-directory>
  world-hub-pack doctor-module <module-directory> [--node executable] [--python executable]
  world-hub-pack preview-replacement <pack-directory> --component component-id --module module-directory [--node executable] [--python executable]
  world-hub-pack rebuild <pack-directory> --destination new-directory --acknowledge-licenses true [--node executable] [--python executable]
  world-hub-pack derive|proposal <pack-directory> --destination new-directory --manifest edited-pack.json --revision inspected-revision --acknowledge-licenses true [--replacements replacements.json] [--node executable] [--python executable]
  world-hub-pack apply-proposal <pack-directory> --proposal proposal-directory --destination new-directory --acknowledge-licenses true [--node executable] [--python executable]
  world-hub-pack source <index-path-or-https-url> [--sha256 index-digest]
  world-hub-pack fetch-source <index-path-or-https-url> --index-digest reviewed-index-digest --entry entry-id --cache directory
  world-hub-pack publish <source-directory> --destination new-directory --kind pack|module --acknowledge-licenses true [--node executable] [--python executable]
  world-hub-pack completion powershell|bash|zsh|fish
  world-hub-pack --version

lock explicitly pins local module bytes/platform/runtime versions. It is an authoring action.
plan/import/export do not run modules or install dependencies. start keeps the supervisor in this terminal.
Review declared permissions and code before supplying the exact trust digest. Ctrl+C stops owned processes.
Backups are private and may contain application secrets. Stop and confirm owned process exits before maintenance.
Creator/source actions produce local artifacts only; they never grant execution permission or run modules.
init-module generates an optional text.statistics author sample, not a universal application shape.
validate-module checks declarations/files; doctor-module additionally probes the selected interpreter and dependency.
These checks and replacement previews do not establish business correctness or operating-system isolation.
`;
const operations = ['plan', 'lock', 'import', 'start', 'status', 'logs', 'stop', 'export', 'storage', 'backup', 'inspect-backup', 'restore', 'detach', 'reattach',
  'authoring', 'derive', 'rebuild', 'proposal', 'apply-proposal', 'source', 'fetch-source', 'publish', 'init-module', 'validate-module', 'doctor-module', 'preview-replacement'];
export function parseArgs(argv) {
  if (argv.length === 0 || argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv.length === 1 && ['--version', '-V'].includes(argv[0])) return { version: true };
  if (argv[0] === 'completion') {
    if (argv.length !== 2 || !['powershell', 'bash', 'zsh', 'fish'].includes(argv[1])) throw new Error('Use completion powershell|bash|zsh|fish');
    return { completion: argv[1] };
  }
  if (argv.length === 2 && operations.includes(argv[0]) && ['--help', '-h'].includes(argv[1])) return { help: true };
  const command = argv[0];
  if (!operations.includes(command)) throw new Error('Unknown operation; use --help');
  let index = 1, packDirectory;
  const positional = ['plan', 'lock', 'import', 'inspect-backup', 'authoring', 'derive', 'rebuild', 'proposal', 'apply-proposal', 'source', 'fetch-source', 'publish', 'init-module', 'validate-module', 'doctor-module', 'preview-replacement'];
  if (positional.includes(command)) { packDirectory = argv[index++]; if (!packDirectory || packDirectory.startsWith('--')) throw new Error('Missing source path'); }
  const accepted = ['plan', 'lock', 'authoring', 'doctor-module'].includes(command) ? ['--node', '--python']
    : command === 'init-module' ? ['--id', '--runtime']
    : command === 'validate-module' ? []
    : command === 'preview-replacement' ? ['--component', '--module', '--node', '--python']
    : command === 'inspect-backup' ? []
    : command === 'source' ? ['--sha256']
    : command === 'fetch-source' ? ['--index-digest', '--entry', '--cache']
    : command === 'publish' ? ['--destination', '--kind', '--acknowledge-licenses', '--node', '--python']
    : command === 'rebuild' ? ['--destination', '--acknowledge-licenses', '--node', '--python']
    : ['derive', 'proposal'].includes(command) ? ['--destination', '--manifest', '--replacements', '--revision', '--acknowledge-licenses', '--node', '--python']
    : command === 'apply-proposal' ? ['--destination', '--proposal', '--acknowledge-licenses', '--node', '--python']
    : command === 'import' ? ['--root', '--instance', '--node', '--python']
      : command === 'start' ? ['--root', '--instance', '--trust', '--node', '--python']
        : ['export', 'backup'].includes(command) ? ['--root', '--instance', '--destination', '--node', '--python']
          : command === 'restore' ? ['--root', '--instance', '--backup', '--sha256', '--node', '--python']
          : command === 'reattach' ? ['--root', '--instance', '--trust', '--node', '--python'] : ['--root', '--instance'];
  const options = {}, seen = new Set();
  const keys = { '--root': 'root', '--instance': 'instanceId', '--node': 'nodePath', '--python': 'pythonPath', '--trust': 'trust', '--destination': 'destination',
    '--backup': 'backup', '--sha256': 'expectedSha256', '--manifest': 'manifestFile', '--replacements': 'replacementsFile', '--revision': 'expectedRevision',
    '--proposal': 'proposalDirectory', '--index-digest': 'indexDigest', '--entry': 'entryId', '--cache': 'cacheRoot', '--kind': 'kind', '--acknowledge-licenses': 'redistributionAcknowledged',
    '--id': 'id', '--runtime': 'runtime', '--component': 'componentId', '--module': 'moduleDirectory' };
  for (; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!accepted.includes(key) || seen.has(key) || !value || value.startsWith('--')) throw new Error(`Unknown, duplicate or incomplete option: ${key}`);
    seen.add(key); options[keys[key]] = value;
  }
  if (!positional.includes(command) || command === 'import') if (!options.root || !options.instanceId) throw new Error('--root and --instance are required');
  if (['start', 'reattach'].includes(command) && !options.trust) throw new Error('--trust must be the reviewed current digest');
  if (command === 'init-module' && (!options.id || !['node', 'python'].includes(options.runtime))) throw new Error('--id and --runtime node|python are required');
  if (command === 'preview-replacement' && (!options.componentId || !options.moduleDirectory)) throw new Error('--component and --module are required');
  if (['export', 'backup', 'derive', 'rebuild', 'proposal', 'apply-proposal', 'publish'].includes(command) && !options.destination) throw new Error('--destination is required');
  if (command === 'restore' && (!options.backup || !options.expectedSha256)) throw new Error('--backup and --sha256 are required');
  if (['derive', 'proposal'].includes(command) && (!options.manifestFile || !options.expectedRevision)) throw new Error('--manifest and --revision are required');
  if (command === 'apply-proposal' && !options.proposalDirectory) throw new Error('--proposal is required');
  if (command === 'fetch-source' && (!options.indexDigest || !options.entryId || !options.cacheRoot)) throw new Error('--index-digest, --entry and --cache are required');
  if (['derive', 'rebuild', 'proposal', 'apply-proposal', 'publish'].includes(command)) {
    if (options.redistributionAcknowledged !== 'true') throw new Error('--acknowledge-licenses true is required after reviewing redistribution rights');
    options.redistributionAcknowledged = true;
  }
  return { command, packDirectory, options };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.version) { process.stdout.write(JSON.parse((await readBounded(fileURLToPath(new URL('../package.json', import.meta.url)))).toString()).version + '\n'); return; }
  if (args.completion) { process.stdout.write(completionScript(args.completion)); return; }
  const print = value => console.log(JSON.stringify(value));
  const { command, packDirectory, options } = args;
  if (command === 'plan') { const plan = await inspectPackage(packDirectory, options); print(plan); }
  else if (command === 'lock') print(await createLock(packDirectory, options));
  else if (command === 'import') { const result = await importPackage(packDirectory, options); print(result); }
  else if (command === 'status') print(await statusInstance(options));
  else if (command === 'logs') print(await logsInstance(options));
  else if (command === 'stop') print(await stopInstance(options));
  else if (command === 'export') print(await exportInstance(options));
  else if (command === 'storage') print(await storageInstance(options));
  else if (command === 'backup') print(await backupInstance(options));
  else if (command === 'inspect-backup') print(await inspectBackup(packDirectory));
  else if (command === 'restore') print(await restoreInstance(options));
  else if (command === 'detach') print(await detachInstance(options));
  else if (command === 'reattach') print(await reattachInstance(options));
  else if (command === 'authoring') print(await inspectAuthoring(packDirectory, options));
  else if (command === 'preview-replacement') { const value = await previewReplacement(packDirectory, options); print(value); if (!value.compatible) process.exitCode = 1; }
  else if (['init-module', 'validate-module', 'doctor-module'].includes(command)) {
    const developer = await import('../scripts/runtime/developer.mjs');
    const fn = command === 'init-module' ? developer.initModule : command === 'validate-module' ? developer.validateModuleDirectory : developer.doctorModule;
    const value = await fn({ ...options, directory: packDirectory }); print(value);
    if (value.ok === false || value.valid === false) process.exitCode = 1;
  }
  else if (command === 'rebuild') print(await rebuildPackage(packDirectory, options));
  else if (['derive', 'proposal'].includes(command)) {
    options.pack = JSON.parse((await readBounded(options.manifestFile)).toString('utf8'));
    if (options.replacementsFile) options.replacements = JSON.parse((await readBounded(options.replacementsFile)).toString('utf8'));
    print(await (command === 'derive' ? derivePackage : exportProposal)(packDirectory, options));
  }
  else if (command === 'apply-proposal') print(await applyProposal(packDirectory, options.proposalDirectory, options));
  else if (command === 'source') print(await readSourceIndex(packDirectory, options));
  else if (command === 'fetch-source') print(await fetchSourceArtifact(packDirectory, options.indexDigest, options.entryId, options));
  else if (command === 'publish') print(await publishArtifact(packDirectory, options));
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
export function completionScript(shell) {
  const commands = [...operations, 'completion'];
  const words = [...commands, '--help', '--version', '--node', '--python', '--id', '--runtime', '--component', '--module', '--destination', '--root', '--instance'];
  if (shell === 'powershell') return `Register-ArgumentCompleter -Native -CommandName world-hub-pack -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  @(${words.map(word => `'${word}'`).join(', ')}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
  if (shell === 'bash') return `complete -W '${words.join(' ')}' world-hub-pack\n`;
  if (shell === 'zsh') return `#compdef world-hub-pack\n_arguments '*:command or option:(${words.join(' ')})'\n`;
  return commands.map(command => `complete -c world-hub-pack -f -a '${command}'`).join('\n') + '\n';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, error: { code: 'PACK_RUNTIME_ERROR', message: error.message } })); process.exitCode = 1; });
}
