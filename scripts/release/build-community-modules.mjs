// Assemble current community artifacts from independent module source trees.
// This never reads the historical pack/lock or starts programs and services.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from '../cli-entry.mjs';
import { collectFiles, hash, ordinaryPath, readBounded } from '../runtime/paths.mjs';
import { readDeployment } from '../runtime/deployment.mjs';
import { readModuleGroup, validateModuleGroup } from '../runtime/module-group.mjs';
import { publishArtifact, validateArtifactBytes } from '../runtime/sources.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const members = ['source', 'stats', 'desk'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function buildCommunityModules({ output, sourceRoot = repository } = {}) {
  sourceRoot = resolve(sourceRoot);
  output = resolve(output ?? join(sourceRoot, '.local/community-modules-text-desk'));
  if (output === sourceRoot || sourceRoot.startsWith(output + sep)) throw new Error('Output must not contain the source repository');
  await ordinaryPath(output, { allowMissing: true });
  for (const target of [join(output, 'stage'), join(output, 'artifacts')]) {
    await ordinaryPath(target, { allowMissing: true });
    try { await access(target); throw new Error('Refusing to overwrite existing community build target: ' + target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const recipeDirectory = join(sourceRoot, 'examples/module-groups/text-desk');
  const recipeBytes = await readBounded(join(recipeDirectory, 'module-group.json'));
  const recipe = validateModuleGroup(JSON.parse(recipeBytes.toString('utf8')));
  if (recipe.id !== 'demo.text-desk' || recipe.version !== '1.0.0' || recipe.modules.length !== members.length
      || !members.every(id => recipe.modules.some(member => member.id === id && member.path === 'modules/' + id))) throw new Error('Review the supported text-desk recipe before changing the build input');
  const sources = [];
  for (const id of members) {
    const member = recipe.modules.find(member => member.id === id);
    const directory = join(sourceRoot, 'examples/ecosystem-pack/modules', id);
    const manifest = JSON.parse((await readBounded(join(directory, 'module.json'))).toString('utf8'));
    const deployment = await readDeployment(directory, manifest);
    if (!deployment || manifest.id !== member.moduleId || manifest.version !== member.version
        || !same(deployment.topics, member.configuration.topics)
        || !same(deployment.bridges, member.configuration.bridges)
        || !same(Object.fromEntries(deployment.settings.map(field => [field.key, field.default])), member.configuration.settings)) throw new Error('Recipe differs from member identity or deployment defaults: ' + id);
    sources.push({ id, member, directory, manifest, deployment, files: await collectFiles(directory) });
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const stage = join(output, 'stage/text-desk'), artifacts = join(output, 'artifacts');
  await mkdir(stage, { recursive: true, mode: 0o700 });
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await writeFile(join(stage, 'module-group.json'), recipeBytes, { flag: 'wx' });
  await writeFile(join(stage, 'README.md'), await readBounded(join(recipeDirectory, 'README.md')), { flag: 'wx' });
  for (const source of sources) for (const file of source.files) {
    const destination = join(stage, source.member.path, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, await readBounded(join(source.directory, file.path), 8 * 1024 * 1024), { flag: 'wx' });
  }
  await readModuleGroup(stage);
  const entries = [];
  const add = async (kind, directory, title) => {
    const manifest = JSON.parse((await readBounded(join(directory, kind === 'module-group' ? 'module-group.json' : 'module.json'))).toString('utf8'));
    const published = await publishArtifact(directory, {
      kind, destination: join(artifacts, kind + '.' + manifest.id + '.' + manifest.version), redistributionAcknowledged: true
    });
    const bytes = await readFile(published.artifactPath), validated = validateArtifactBytes(bytes);
    if (validated.artifact.kind !== kind || validated.artifact.id !== manifest.id || validated.artifact.version !== manifest.version) throw new Error('Built artifact identity changed');
    entries.push({ kind, id: manifest.id, version: manifest.version, title, artifactPath: published.artifactPath, sha256: hash(bytes) });
  };
  for (const source of sources) await add('module', join(stage, source.member.path), source.deployment.title.en + ' / ' + source.deployment.title.zh);
  await add('module-group', stage, recipe.title);
  const manifest = { format: 'world-hub.community-build/v1', entries };
  const manifestPath = join(artifacts, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { passed: true, stage, manifestPath, entries, startsModules: false, publishedRemotely: false };
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw new Error('Usage: node scripts/release/build-community-modules.mjs [--output <new-directory>]');
  try { console.log(JSON.stringify(await buildCommunityModules({ output: args[1] }))); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
