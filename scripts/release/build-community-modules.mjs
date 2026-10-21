// Build public module bodies, an independent configuration and a sample dataset.
// Only source files are read. No program, account or remote publication is used.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from '../cli-entry.mjs';
import { collectFiles, hash, ordinaryPath, readBounded } from '../runtime/paths.mjs';
import { readDeployment } from '../runtime/deployment.mjs';
import { sourceFilesDigest, validateConfiguration, validateData } from '../runtime/resource-artifacts.mjs';
import { publishArtifact, validateArtifactBytes, validateSourceIndex } from '../runtime/sources.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const logicalIds = ['source', 'stats', 'desk'];
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sameContract = (a, b) => a.id === b.id && a.version === b.version;

export async function buildCommunityModules({ output, sourceRoot = repository } = {}) {
  sourceRoot = resolve(sourceRoot);
  output = resolve(output ?? join(sourceRoot, '.local/community-resources-text-desk'));
  if (output === sourceRoot || sourceRoot.startsWith(output + sep)) throw new Error('Output must not contain the source repository');
  await ordinaryPath(output, { allowMissing: true });
  for (const name of ['stage', 'artifacts', 'index.json', 'manifest.json']) {
    const target = join(output, name); await ordinaryPath(target, { allowMissing: true });
    try { await access(target); throw new Error('Refusing to overwrite existing community build target: ' + target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const inputs = [];
  for (const id of logicalIds) {
    const directory = join(sourceRoot, 'examples/ecosystem-pack/modules', id);
    const manifest = JSON.parse((await readBounded(join(directory, 'module.json'))).toString('utf8'));
    const deployment = await readDeployment(directory, manifest);
    if (manifest.id !== 'demo.' + id || !deployment) throw new Error('Unexpected sample module or missing deployment: ' + id);
    const files = await collectFiles(directory);
    if (files.some(file => /\.(?:html|css|png|jpe?g)$/i.test(file.path))) throw new Error('Community example sources must be headless: ' + id);
    inputs.push({ id, manifest, deployment, files: await Promise.all(files.map(async file => ({ ...file, bytes: await readBounded(join(directory, file.path), 8 * 1024 * 1024) }))) });
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const stage = join(output, 'stage'), artifacts = join(output, 'artifacts');
  await mkdir(stage, { recursive: true, mode: 0o700 }); await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const entries = [], bodies = new Map();
  async function add(kind, directory, manifest, title) {
    const relativeArtifact = `artifacts/${kind}.${manifest.id}.${manifest.version}`;
    const published = await publishArtifact(directory, { kind, destination: join(output, relativeArtifact), redistributionAcknowledged: true });
    const bytes = await readFile(published.artifactPath), validated = validateArtifactBytes(bytes);
    if (validated.artifact.kind !== kind || validated.artifact.id !== manifest.id || validated.artifact.version !== manifest.version) throw new Error('Built artifact identity changed');
    entries.push({ ...validated.entry, title, source: { path: `${relativeArtifact}/artifact.json` } });
    return { bytes, validated };
  }
  for (const input of inputs) {
    const directory = join(stage, 'bodies', input.id);
    for (const file of input.files) {
      if (hash(file.bytes) !== file.sha256) throw new Error('Source changed during inspection: ' + file.path);
      const destination = join(directory, file.path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.bytes, { flag: 'wx' });
    }
    const result = await add('module', directory, input.manifest, input.deployment.title.en + ' / ' + input.deployment.title.zh);
    const pinnedFiles = result.validated.artifact.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    bodies.set(input.id, { ...input, reference: { id: input.manifest.id, version: input.manifest.version, digest: sourceFilesDigest(pinnedFiles) } });
  }
  const platforms = inputs[0].manifest.platforms.filter(platform => inputs.every(input => input.manifest.platforms.includes(platform)));
  if (!platforms.length) throw new Error('Sample modules have no common platform');
  const metadata = { version: '1.0.0', license: 'Apache-2.0', platforms, provides: [], requires: [], scope: 'local' };
  const data = validateData({ format: 'world-hub.module-data/v1', ...metadata, id: 'demo.text-desk.sample-data',
    title: 'Text desk sample data / 文本台示例数据', purpose: 'dataset',
    instances: [{ id: 'source', module: bodies.get('source').reference, path: 'data/source', dataFormat: { id: 'demo.source.text-state', version: '1.0.0' } }] });
  const dataDirectory = join(stage, 'data'); await mkdir(join(dataDirectory, 'data/source'), { recursive: true, mode: 0o700 });
  await writeFile(join(dataDirectory, 'data.json'), encode(data), { flag: 'wx' });
  await writeFile(join(dataDirectory, 'data/source/source.json'), encode({ text: '互联万物，自由组合。\nHello World Hub 🌍\n', revision: 0 }), { flag: 'wx' });
  const dataset = await add('data', dataDirectory, data, data.title);
  const modules = logicalIds.map(id => {
    const body = bodies.get(id), deployment = body.deployment;
    const bindings = body.manifest.requires.map(contract => {
      const providers = logicalIds.filter(other => other !== id && bodies.get(other).manifest.provides.some(provided => sameContract(provided, contract)));
      if (providers.length !== 1) throw new Error('Sample capability requires exactly one provider: ' + contract.id);
      return { providerId: providers[0], contract };
    });
    return { id, module: body.reference, configuration: {
      topics: deployment.topics, bridges: deployment.bridges,
      settings: Object.fromEntries(deployment.settings.map(field => [field.key, field.default])), bindings,
      executionDefaults: { mode: 'resident', idleTimeoutMs: 60000 }
    } };
  });
  const configuration = validateConfiguration({ format: 'world-hub.configuration/v1', ...metadata, id: 'demo.text-desk',
    title: 'Cross-language text desk configuration / 跨语言文本台配置', modules,
    startupPlan: { members: modules.map(member => ({ programId: member.id, enabled: true, after: [...new Set(member.configuration.bindings.map(binding => binding.providerId))] })),
      startupOrder: logicalIds, onFailure: 'continue-independent' },
    data: [{ instanceId: 'source', id: data.id, version: data.version, sha256: hash(dataset.bytes) }] });
  const configurationDirectory = join(stage, 'configuration'); await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(configurationDirectory, 'configuration.json'), encode(configuration), { flag: 'wx' });
  await add('configuration', configurationDirectory, configuration, configuration.title);
  const index = validateSourceIndex({ format: 'world-hub.source-index/v1', id: 'official-text-desk-resources',
    title: 'Text desk module bodies, configuration and sample data', entries });
  const indexPath = join(output, 'index.json'); await writeFile(indexPath, encode(index), { flag: 'wx', mode: 0o600 });
  const manifest = { format: 'world-hub.community-build/v1', entries: entries.map(entry => ({ kind: entry.kind, id: entry.id, version: entry.version,
    title: entry.title, artifactPath: entry.source.path, sha256: entry.sha256 })) };
  const manifestPath = join(output, 'manifest.json'); await writeFile(manifestPath, encode(manifest), { flag: 'wx', mode: 0o600 });
  return { passed: true, stage, manifestPath, indexPath, entries: manifest.entries, startsModules: false, publishedRemotely: false };
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--'))) throw new Error('Usage: node scripts/release/build-community-modules.mjs [--output <new-directory>]');
  try { console.log(JSON.stringify(await buildCommunityModules({ output: args[1] }))); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
