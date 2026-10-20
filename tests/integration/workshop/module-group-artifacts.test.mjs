import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { publishArtifact, validateArtifactBytes, readSourceIndex, fetchSourceArtifact, attachPublisherEvidence } from '../../../scripts/runtime/sources.mjs';
import { generatePublisherKey, signPublisherEvidence } from '../../../scripts/runtime/publisher-trust.mjs';
import { readModuleGroup, validateModuleGroup } from '../../../scripts/runtime/module-group.mjs';
import { hash, ordinaryPath } from '../../../scripts/runtime/paths.mjs';
import { importLocalArtifact } from '../../../tools/launcher/local-artifacts.mjs';
import { zipDirectory } from '../../../scripts/release/zip.mjs';
import { PathsService } from '../../../tools/launcher/paths-service.mjs';
import { SourceRegistry } from '../../../tools/launcher/source-registry.mjs';
import { verifyStoredPublisherEvidence, readPublisherTrust } from '../../../scripts/runtime/publisher-store.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const contract = { id: 'text.convert', version: '1.0.0' };
async function fixture(t) {
  const base = resolve('.artifacts/module-group-artifact-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')), directory = join(root, 'group');
  t.after(async () => { const target = await ordinaryPath(root); assert.equal(dirname(target), await ordinaryPath(base)); assert.ok(target.startsWith(join(base, 'case-'))); await rm(target, { recursive: true, force: false }); });
  const config = (publish, subscribe, bindings = []) => ({ topics: { value: 'demo/value' }, bridges: { main: { publish, subscribe } }, settings: { text: 'Demo' }, bindings });
  const group = { format: 'world-hub.module-group/v1', id: 'text-desk', version: '1.2.3', title: 'Text desk', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], provides: [contract], requires: [],
    modules: [{ id: 'source', path: 'modules/source', moduleId: 'text.source', version: '2.0.0', configuration: config(['value'], []) },
      { id: 'screen', path: 'modules/screen', moduleId: 'text.screen', version: '3.0.0', configuration: config([], ['value'], [{ providerId: 'source', contract }]) }],
    startupPlan: { members: [{ programId: 'source', enabled: true, after: [] }, { programId: 'screen', enabled: false, after: ['source'] }], onFailure: 'continue-independent', startupOrder: ['source', 'screen'] } };
  await mkdir(directory);
  await writeFile(join(directory, 'module-group.json'), json(group));
  await writeFile(join(directory, 'README.md'), '# Independent text modules\n');
  for (const member of group.modules) {
    const path = join(directory, member.path); await mkdir(path, { recursive: true });
    const manifest = { format: 'world-hub.module/v1', id: member.moduleId, version: member.version, license: 'MIT', platforms: group.platforms,
      runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: member.id === 'source' ? [contract] : [], requires: member.id === 'screen' ? [contract] : [],
      permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
    await writeFile(join(path, 'module.json'), json(manifest));
    await writeFile(join(path, 'program.mjs'), "throw new Error('Downloading a group must never execute its modules');\n");
    await writeFile(join(path, 'deployment.json'), json({ format: 'world-hub.deployment/v1', title: { en: member.id }, description: { en: 'Public defaults' }, topics: member.configuration.topics, bridges: member.configuration.bridges,
      settings: [{ key: 'text', label: { en: 'Text' }, type: 'string', default: 'Demo' }] }));
  }
  const publication = await publishArtifact(directory, { kind: 'module-group', redistributionAcknowledged: true, destination: join(root, 'publication') });
  const artifact = JSON.parse(await readFile(publication.artifactPath));
  return { root, directory, group, publication, artifact };
}
function changeFile(artifact, path, update) {
  const file = artifact.files.find(file => file.path === path), value = JSON.parse(Buffer.from(file.base64, 'base64'));
  update(value); const bytes = Buffer.from(json(value)); file.base64 = bytes.toString('base64'); file.sha256 = hash(bytes);
}

test('module-group publish, source fetch, directory, JSON and ZIP import preserve independent members without executing', async t => {
  const { root, directory, group, publication, artifact } = await fixture(t);
  const validated = validateArtifactBytes(await readFile(publication.artifactPath));
  assert.equal(validated.entry.kind, 'module-group'); assert.equal(validated.entry.title, group.title); assert.equal(validated.modules.length, 2);
  const index = await readSourceIndex(publication.indexPath), fetched = await fetchSourceArtifact(index.source, index.digest, index.index.entries[0].entryId, { cacheRoot: join(root, 'cache') });
  assert.equal(fetched.kind, 'module-group'); assert.equal(fetched.startsModules, false); assert.equal(fetched.requiresExecutionReview, true);
  const read = await readModuleGroup(fetched.directory);
  assert.deepEqual(read.manifest, group); assert.equal(read.modules[0].manifest.id, 'text.source'); assert.equal(read.modules[1].deployment.settings[0].key, 'text');
  assert.equal(read.modules[0].directory, join(fetched.directory, 'modules/source'));
  assert.equal((await importLocalArtifact({ root, path: directory })).object.kind, 'module-group');
  const imported = await importLocalArtifact({ root, path: publication.artifactPath, kind: 'module-group' });
  assert.equal(imported.object.memberCount, 2); assert.equal(imported.startsModules, false); assert.deepEqual((await readModuleGroup(imported.object.path)).manifest, group);
  const archive = join(root, 'text-desk.zip'); await zipDirectory(directory, archive);
  const zipped = await importLocalArtifact({ root, path: archive });
  assert.equal(zipped.object.kind, 'module-group'); assert.equal(zipped.object.memberCount, 2); assert.equal(zipped.object.requiresReview, true);
  assert.deepEqual((await readModuleGroup(zipped.object.path)).manifest.startupPlan, group.startupPlan);
  await assert.rejects(importLocalArtifact({ root, path: publication.artifactPath, kind: 'module' }), /Choose a module distribution/);
  assert.deepEqual(JSON.parse(await readFile(publication.artifactPath)), artifact);
});

test('module-group validator rejects foreign identity, unsafe references, private fields and impossible startup or capability wiring', async t => {
  const { artifact } = await fixture(t);
  const mutations = [
    value => { value.modules[0].path = '../outside'; },
    value => { value.modules[1].path = 'modules/source/subdir'; },
    value => { value.modules[1].id = value.modules[0].id; },
    value => { value.modules[0].moduleId = 'unrelated.source'; },
    value => { value.modules[0].version = '99.0.0'; },
    value => { value.modules[0].configuration.settings.apiToken = 'private'; },
    value => { value.modules[0].configuration.settings.nested = { password: 'private' }; },
    value => { value.modules[0].configuration.topics.value = 'demo/#'; },
    value => { value.modules[0].configuration.bridges.other = value.modules[0].configuration.bridges.main; },
    value => { value.modules[1].configuration.bindings[0].providerId = 'missing'; },
    value => { value.modules[1].configuration.bindings[0].contract.version = '99.0.0'; },
    value => { value.startupPlan.startupOrder = ['screen', 'source']; },
    value => { value.startupPlan.members[0].after = ['screen']; },
    value => { value.startupPlan.members[1].enabled = 'yes'; },
    value => { value.hub = { port: 51780 }; },
    value => { value.runtime = { entry: 'program.mjs' }; }
  ];
  for (const mutation of mutations) { const changed = structuredClone(artifact); changeFile(changed, 'module-group.json', mutation); assert.throws(() => validateArtifactBytes(changed)); }
  const direct = JSON.parse(Buffer.from(artifact.files[0].base64, 'base64').toString());
  assert.throws(() => validateModuleGroup({ ...direct, format: 'world-hub.pack/v1' }));
});

test('module-group publication requires a complete provider binding for every consumer contract', async t => {
  const { artifact, directory, root } = await fixture(t);
  const unbound = structuredClone(artifact);
  changeFile(unbound, 'module-group.json', value => { value.modules[1].configuration.bindings = []; });
  assert.throws(() => validateArtifactBytes(unbound), { code: 'MODULE_GROUP_INVALID', message: /screen.*text\.convert@1\.0\.0/ });

  const otherContract = { id: 'text.describe', version: '2.0.0' }, complete = structuredClone(artifact);
  changeFile(complete, 'modules/source/module.json', value => { value.provides.push(otherContract); });
  changeFile(complete, 'modules/screen/module.json', value => { value.requires.push(otherContract); });
  changeFile(complete, 'module-group.json', value => { value.modules[1].configuration.bindings.push({ providerId: 'source', contract: otherContract }); });
  assert.equal(validateArtifactBytes(complete).modules[1].manifest.requires.length, 2);
  for (const required of [contract, otherContract]) {
    const partial = structuredClone(complete);
    changeFile(partial, 'module-group.json', value => { value.modules[1].configuration.bindings = value.modules[1].configuration.bindings.filter(binding => binding.contract.id !== required.id); });
    assert.throws(() => validateArtifactBytes(partial), error => error.code === 'MODULE_GROUP_INVALID' && error.message.includes(`${required.id}@${required.version}`));
  }

  const groupPath = join(directory, 'module-group.json'), group = JSON.parse(await readFile(groupPath));
  group.modules[1].configuration.bindings = [];
  await writeFile(groupPath, json(group));
  await assert.rejects(readModuleGroup(directory), { code: 'MODULE_GROUP_INVALID', message: /required capability binding/ });
  await assert.rejects(publishArtifact(directory, { kind: 'module-group', redistributionAcknowledged: true, destination: join(root, 'incomplete-publication') }), { code: 'MODULE_GROUP_INVALID', message: /required capability binding/ });
});

test('module-group publication preserves explicit pub/sub wiring without requiring capability bindings', async t => {
  const { artifact } = await fixture(t), pubsubOnly = structuredClone(artifact);
  changeFile(pubsubOnly, 'modules/screen/module.json', value => { value.requires = []; });
  changeFile(pubsubOnly, 'module-group.json', value => { value.modules[1].configuration.bindings = []; });
  const validated = validateArtifactBytes(pubsubOnly);
  assert.deepEqual(validated.modules[1].manifest.requires, []);
  assert.deepEqual(validated.modules[1].member.configuration.bindings, []);
  assert.deepEqual(validated.modules[0].member.configuration.bridges.main.publish, ['value']);
  assert.deepEqual(validated.modules[1].member.configuration.bridges.main.subscribe, ['value']);
  assert.equal(validated.modules[0].member.configuration.topics.value, validated.modules[1].member.configuration.topics.value);
});

test('module-group checks every embedded source, deployment declaration, source hash and private file boundary', async t => {
  const { artifact, root, directory } = await fixture(t);
  const add = (artifact, path, text = 'private') => { const bytes = Buffer.from(text); artifact.files.push({ path, base64: bytes.toString('base64'), sha256: hash(bytes) }); };
  for (const path of ['outside.mjs', 'modules/source/pack.json', 'modules/source/pack.lock', 'modules/source/template.json', 'modules/source/.env', 'modules/source/.state/data.json', 'modules/source/state/data.json', 'modules/source/identity.json', 'modules/source/subdir/module.json']) {
    const changed = structuredClone(artifact); add(changed, path); assert.throws(() => validateArtifactBytes(changed), /private|outside|nested|generated/);
  }
  const missing = structuredClone(artifact); missing.files = missing.files.filter(file => file.path !== 'modules/source/program.mjs'); assert.throws(() => validateArtifactBytes(missing), /entry is missing/);
  const wrongDefault = structuredClone(artifact); changeFile(wrongDefault, 'modules/source/deployment.json', value => { value.dependencies = { kind: 'execute-anything' }; }); assert.throws(() => validateArtifactBytes(wrongDefault), /dependency/);
  const mismatched = structuredClone(artifact); changeFile(mismatched, 'modules/source/module.json', value => { value.id = 'another.module'; }); assert.throws(() => validateArtifactBytes(mismatched), /identity/);
  const corrupt = structuredClone(artifact); corrupt.files[0].sha256 = '0'.repeat(64); assert.throws(() => validateArtifactBytes(corrupt), /hash/);
  const tooLarge = structuredClone(artifact); tooLarge.files[0].base64 = 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4); assert.throws(() => validateArtifactBytes(tooLarge), /artifact file/);
  await writeFile(join(directory, 'outside.mjs'), 'throw new Error("outside source")'); const zip = join(root, 'invalid.zip'); await zipDirectory(directory, zip);
  await assert.rejects(importLocalArtifact({ root, path: zip }), /outside declared module/);
});

test('source acquisition rejects retired pack/template kinds before artifact retrieval', async t => {
  const { root, publication } = await fixture(t), source = JSON.parse(await readFile(publication.indexPath));
  source.entries[0].kind = 'pack'; source.entries[0].entryId = 'pack.retired.1.0.0'; source.entries[0].source.path = 'does-not-exist.json';
  const path = join(root, 'retired.json'); await writeFile(path, json(source)); const index = await readSourceIndex(path);
  await assert.rejects(fetchSourceArtifact(path, index.digest, source.entries[0].entryId, { cacheRoot: join(root, 'retired-cache') }), /Only current module and module-group/);
});

test('module-group publisher evidence binds the exact group bytes and never grants execution on acquisition', async t => {
  const { root, publication } = await fixture(t), entry = publication.index.entries[0], key = generatePublisherKey(), now = Date.now();
  const evidence = signPublisherEvidence({ payload: { type: 'artifact', issuer: 'group.author', keyId: key.keyId, sequence: 1,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
    subject: { kind: entry.kind, id: entry.id, version: entry.version, sha256: entry.sha256 }, details: {} }, privateKeys: [key.privateKeyPem] });
  const attached = await attachPublisherEvidence(publication.directory, { evidenceBytes: Buffer.from(json(evidence)) }), index = await readSourceIndex(attached.indexPath);
  const result = await fetchSourceArtifact(index.source, index.digest, entry.entryId, { cacheRoot: join(root, 'signed-cache') });
  assert.equal(result.publisherEvidence.signatureStatus, 'verified'); assert.equal(result.publisherEvidence.publisherIdentity, 'unanchored-key');
  assert.equal(result.publisherEvidence.executionAuthorized, false); assert.equal(result.startsModules, false);
  const registry = new SourceRegistry(join(root, 'trust')); await registry.initialize();
  const change = { action: 'anchor', issuer: 'group.author', publicKey: key.publicKey, role: 'publisher', identityBasis: { type: 'public-key-fingerprint', note: 'Explicit group fixture anchor' } };
  const preview = await registry.previewPublisherTrust(change); await registry.applyPublisherTrust({ change, reviewDigest: preview.reviewDigest });
  const notice = signPublisherEvidence({ payload: { type: 'risk-notice', issuer: 'group.author', keyId: key.keyId, sequence: 2,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), subject: { kind: 'publisher', id: 'group.author' },
    details: { artifacts: [{ kind: entry.kind, id: entry.id, version: entry.version, sha256: entry.sha256 }], severity: 'info', message: 'Group test advisory', links: [] } }, privateKeys: [key.privateKeyPem] });
  const observed = await verifyStoredPublisherEvidence({ root: registry.root, evidenceBytes: Buffer.from(json(notice)), observe: true }); assert.equal(observed.accepted, true);
  assert.equal((await readPublisherTrust({ root: registry.root })).issuers[0].notices[0].artifacts[0].kind, 'module-group');
});

test('module-group library observation survives restart and removing a reference keeps source bytes', async t => {
  const { root, directory, group } = await fixture(t), paths = new PathsService(root); await paths.initialize();
  const checked = await paths.check({ path: directory, purpose: 'module-group' });
  assert.equal(checked.object.kind, 'module-group'); assert.equal(checked.object.checked, false); assert.equal(checked.object.startsModules, false); assert.equal(checked.object.memberCount, 2);
  await paths.remember({ path: directory, purpose: 'module-group', library: true });
  const restored = new PathsService(root); await restored.initialize(); assert.equal(restored.library.length, 1); assert.equal(restored.library[0].purpose, 'module-group');
  const forgotten = await restored.forget({ path: directory, purpose: 'module-group' }); assert.equal(forgotten.deletesFiles, false); assert.equal(restored.library.length, 0);
  assert.deepEqual((await readModuleGroup(directory)).manifest, group);
  const third = new PathsService(root); await third.initialize(); assert.equal(third.library.length, 0); assert.ok(third.hidden.includes(directory));
});
