import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildCommunityModules } from './build-community-modules.mjs';
import { hash } from '../runtime/paths.mjs';
import { sourceFilesDigest } from '../runtime/resource-artifacts.mjs';
import { validateArtifactBytes, validateSourceIndex } from '../runtime/sources.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
let temporary, output, built, index, artifacts;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'world-hub-community-'));
  output = join(temporary, '中文 community resources');
  built = await buildCommunityModules({ sourceRoot: repository, output });
  index = validateSourceIndex(JSON.parse(await readFile(built.indexPath, 'utf8')));
  artifacts = new Map();
  for (const entry of index.entries) {
    const bytes = await readFile(join(output, entry.source.path));
    assert.equal(hash(bytes), entry.sha256);
    artifacts.set(entry.id, { entry, bytes, ...validateArtifactBytes(bytes) });
  }
});
after(async () => {
  if (!temporary) return;
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith('world-hub-community-'));
  await rm(temporary, { recursive: true, force: false });
});

test('community builder produces only current downloadable kinds without executing or publishing', async () => {
  assert.equal(built.passed, true); assert.equal(built.startsModules, false); assert.equal(built.publishedRemotely, false);
  assert.deepEqual(index.entries.map(entry => entry.kind), ['module', 'module', 'module', 'data', 'configuration']);
  assert.equal(index.entries.length, 5);
  const manifestText = await readFile(built.manifestPath, 'utf8');
  assert.doesNotMatch(manifestText, /[A-Za-z]:[\\/]|module-group|pack\.lock|\\\\/);
  for (const entry of built.entries) {
    assert.equal(entry.artifactPath.startsWith('artifacts/'), true);
    await access(join(output, entry.artifactPath));
  }
  for (const artifact of artifacts.values()) {
    assert.ok(artifact.artifact.files.every(file => !/\.(?:html|css|png|jpe?g)$/i.test(file.path)));
  }
});

test('configuration pins exact independent bodies and routes, while data remains a separately pinned dataset', () => {
  const configured = artifacts.get('demo.text-desk');
  assert.deepEqual(configured.decoded.map(file => file.path), ['configuration.json']);
  const configuration = configured.manifest;
  for (const member of configuration.modules) {
    const body = artifacts.get(member.module.id);
    assert.equal(member.module.version, body.artifact.version);
    assert.equal(member.module.digest, sourceFilesDigest(body.artifact.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en'))));
    for (const binding of member.configuration.bindings) {
      const provider = configuration.modules.find(candidate => candidate.id === binding.providerId);
      assert.ok(provider);
      assert.ok(artifacts.get(provider.module.id).manifest.provides.some(contract => contract.id === binding.contract.id && contract.version === binding.contract.version));
    }
  }
  assert.deepEqual(configuration.startupPlan.members.find(member => member.programId === 'desk').after, ['source', 'stats']);
  const dataset = artifacts.get('demo.text-desk.sample-data');
  assert.equal(dataset.manifest.purpose, 'dataset');
  assert.equal(configuration.data[0].sha256, hash(dataset.bytes));
  assert.equal(dataset.manifest.instances[0].module.digest, configuration.modules.find(member => member.id === 'source').module.digest);
  assert.deepEqual(dataset.decoded.map(file => file.path).sort(), ['data.json', 'data/source/source.json']);
  const sample = JSON.parse(dataset.decoded.find(file => file.path === 'data/source/source.json').bytes);
  assert.deepEqual(Object.keys(sample).sort(), ['revision', 'text']);
  assert.equal(sample.revision, 0); assert.match(sample.text, /Hello World Hub/);
});

test('community source builds never overwrite prior outputs or use an ancestor as destination', async () => {
  const before = hash(await readFile(built.manifestPath));
  await assert.rejects(buildCommunityModules({ sourceRoot: repository, output }), /Refusing to overwrite/);
  assert.equal(hash(await readFile(built.manifestPath)), before);
  await assert.rejects(buildCommunityModules({ sourceRoot: repository, output: repository }), /must not contain/);
});
