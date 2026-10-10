import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, fixturePackage, environment, json, save, filesBelow } from '../launcher/helpers.mjs';
import { createLock, inspectAuthoring, previewReplacement, derivePackage } from '../../../scripts/runtime/index.mjs';

test('PREVIEW-01 replacement checks actual declarations, shared identity and permissions without writing or executing code', { timeout: 45000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const pack = await json(join(directory, 'pack.json'));
  pack.components.push({ ...structuredClone(pack.components[0]), id: 'second' });
  await save(join(directory, 'pack.json'), pack); await createLock(directory, environment);
  const original = await inspectAuthoring(directory, environment), replacement = join(app.directory, 'replacement');
  await cp(join(directory, 'modules/fixture'), replacement, { recursive: true });
  // A preview must never execute even an intentionally throwing candidate.
  await writeFile(join(replacement, 'program.mjs'), 'throw new Error("Must never run in preflight");\n');
  const manifest = await json(join(replacement, 'module.json')); manifest.version = '2.0.0';
  manifest.permissions.network = ['hub-loopback']; await save(join(replacement, 'module.json'), manifest);
  const beforeFiles = await filesBelow(app.directory), beforeLock = await readFile(join(directory, 'pack.lock'));
  const preview = await previewReplacement(directory, { ...environment, componentId: 'fixture', moduleDirectory: replacement });
  assert.equal(preview.compatible, true); assert.equal(preview.businessValidated, false); assert.equal(preview.stateCompatibility, 'unknown');
  assert.deepEqual(preview.affectedComponents, ['fixture', 'second']); assert.equal(preview.differences.permissions.changed, true);
  assert.equal(preview.sourceRevision, original.revision); assert.match(preview.candidateDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.writesFiles, false); assert.equal(preview.startsModules, false);
  assert.deepEqual(await filesBelow(app.directory), beforeFiles); assert.deepEqual(await readFile(join(directory, 'pack.lock')), beforeLock);
  manifest.id = 'candidate.new'; await save(join(replacement, 'module.json'), manifest);
  const isolated = await previewReplacement(directory, { ...environment, componentId: 'fixture', moduleDirectory: replacement });
  assert.deepEqual(isolated.affectedComponents, ['fixture']); assert.notEqual(isolated.candidateDigest, preview.candidateDigest);
  app.record('read-only-preflight', { sharedIdentityAffectsAllReferences: true, newIdentityAffectsOne: true, businessValidated: false });
});

test('PREVIEW-02 preview and derivation share bridge, contract and platform checks; later changes are rechecked', { timeout: 45000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), replacement = join(app.directory, 'candidate');
  await cp(join(directory, 'modules/fixture'), replacement, { recursive: true });
  const manifest = await json(join(replacement, 'module.json'));
  const input = { ...environment, componentId: 'fixture', moduleDirectory: replacement };
  assert.equal((await previewReplacement(directory, input)).compatible, true);
  manifest.bridges = ['wrong']; manifest.requires = [{ id: 'missing.contract', version: '1.0.0' }];
  manifest.platforms = ['unsupported-cpu']; await save(join(replacement, 'module.json'), manifest);
  const denied = await previewReplacement(directory, input);
  assert.equal(denied.compatible, false);
  assert.deepEqual(new Set(denied.diagnostics.map(row => row.code)), new Set(['PLATFORM_UNSUPPORTED', 'BRIDGE_SLOTS_MISMATCH', 'CONTRACT_UNBOUND']));
  await assert.rejects(derivePackage(directory, { ...environment, destination: join(app.directory, 'denied'), redistributionAcknowledged: true,
    replacements: [{ componentId: 'fixture', moduleDirectory: replacement }] }), /platform is unsupported/);
  assert.equal((await filesBelow(app.directory)).some(path => path.startsWith('denied')), false);
});
