import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { zipDirectory } from './zip.mjs';
import { validateModule } from '../runtime/package.mjs';
import { collectFiles as collectSourceFiles } from '../runtime/paths.mjs';
import { isDirectExecution } from '../cli-entry.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildSoftUiModules({ outputDirectory = join(repository, '.artifacts', 'soft-ui-modules') } = {}) {
  outputDirectory = resolve(outputDirectory); await mkdir(outputDirectory, { recursive: true }); const results = [];
  for (const name of ['desktop', 'counter']) {
    const directory = join(repository, 'examples', 'soft-ui-modules', name), manifest = validateModule(JSON.parse(await readFile(join(directory, 'module.json'), 'utf8')));
    const files = await collectSourceFiles(directory);
    if (files.some(file => /(?:^|\/)(?:node_modules|\.soft-ui-local|\.soft-ui-state|\.env)(?:\/|$)/.test(file.path))) throw new Error('Private state and dependencies cannot be included in source modules.');
    const archive = join(outputDirectory, `world-hub-soft-ui-${name}-${manifest.version}.zip`);
    const zip = await zipDirectory(directory, archive), sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(archive + '.sha256', `${sha256}  world-hub-soft-ui-${name}-${manifest.version}.zip\n`, { flag: 'wx' });
    results.push({ module: manifest.id, version: manifest.version, archive, sha256, files: files.length, ...zip });
  }
  return { format: 'world-hub.soft-ui-delivery/v1', packages: results };
}
if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2); if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Use --output <new output directory>');
  console.log(JSON.stringify(await buildSoftUiModules(args.length ? { outputDirectory: args[1] } : {}), null, 2));
}
