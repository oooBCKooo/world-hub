#!/usr/bin/env node
// Install the project's own declarative Skill; no Hub or user program runs.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from '../scripts/cli-entry.mjs';

export const SKILL_FILES = Object.freeze(['SKILL.md', 'LICENSE', 'NOTICE', 'references/setup.md', 'references/communication.md', 'references/modules.md', 'references/mcp.md', 'references/management.md']);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const HELP = `World Hub Skill

  world-hub-skill --path
  world-hub-skill --check
  world-hub-skill --install <new-skill-directory>

--path     Print the packaged Skill directory without changing files.
--check    Verify packaged files and report their exact SHA-256 digests.
--install  Copy the Skill into a new, explicit destination. Parent directories
           are created as needed; an existing destination is never replaced.

The Skill describes World Hub usage and module development. Installing it does
not start a Hub, grant permissions, or execute Skill instructions or scripts.
`;

async function material(root) {
  const source = join(root, 'skills', 'world-hub');
  const directories = new Set(['', 'references']);
  for (const relative of directories) {
    const info = await lstat(join(source, relative));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Packaged Skill directories must be ordinary directories.');
  }
  const files = [];
  for (const path of SKILL_FILES) {
    const filename = join(source, path), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 262144) throw new Error('Packaged Skill files must be ordinary bounded files.');
    const bytes = await readFile(filename);
    if (bytes.length > 262144) throw new Error('Packaged Skill file exceeds its byte limit.');
    files.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { source, files };
}

export async function runSkillCli(argv = process.argv.slice(2), { root = packageRoot, cwd = process.cwd(), output = text => process.stdout.write(text) } = {}) {
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) { output(HELP); return; }
  if (argv.length === 1 && argv[0] === '--path') { output(join(root, 'skills', 'world-hub') + '\n'); return; }
  if (!(argv.length === 1 && argv[0] === '--check') && !(argv.length === 2 && argv[0] === '--install' && argv[1] && !argv[1].startsWith('-'))) throw new Error('Use --path, --check, or --install <new-skill-directory>.');
  const { source, files } = await material(root);
  let destination;
  if (argv[0] === '--install') {
    destination = resolve(cwd, argv[1]);
    if (destination === source || destination.startsWith(source + sep) || source.startsWith(destination + sep)) throw new Error('Choose a destination outside the packaged Skill.');
    try { await lstat(destination); throw new Error('Skill destination already exists; choose a new directory.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(destination); // Exclusive creation also rejects a raced link or file.
    await mkdir(join(destination, 'references'));
    for (const file of files) await writeFile(join(destination, file.path), file.bytes, { flag: 'wx' });
  }
  const report = { format: 'world-hub.skill-installation/v1', name: 'world-hub', source, ...(destination ? { destination } : {}),
    installed: Boolean(destination), files: files.map(({ path, bytes, sha256 }) => ({ path, bytes: bytes.length, sha256 })), startsPrograms: false };
  output(JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (isDirectExecution(import.meta.url)) {
  runSkillCli().catch(error => { process.stderr.write(`World Hub Skill: ${error.message}\n`); process.exitCode = 2; });
}
