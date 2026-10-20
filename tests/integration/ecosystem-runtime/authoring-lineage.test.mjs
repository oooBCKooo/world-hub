import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createLock } from '../../../scripts/runtime/package.mjs';
import { derivePackage, inspectAuthoring } from '../../../scripts/runtime/authoring.mjs';
import { PACK_LINEAGE_FORMAT } from '../../../scripts/runtime/pack-lineage.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';

const environment = { nodePath: process.execPath }, options = { timeout: 30000 };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), path));
    else files.push({ path, sha256: hash(await readFile(join(directory, entry.name))) });
  }
  return files;
}
async function fixture(t, { lineage, reversedModuleOrder = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-author-lineage-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('hub-author-lineage-'));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'source'), moduleIds = reversedModuleOrder ? ['lineage.zeta', 'lineage.alpha'] : ['lineage.module'];
  for (const id of moduleIds) {
    const directory = join(source, 'modules', id); await mkdir(directory, { recursive: true });
    await save(join(directory, 'module.json'), { format: 'world-hub.module/v1', id, version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
      runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [],
      permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
    await writeFile(join(directory, 'program.mjs'), 'throw new Error("Lineage authoring must never execute the module");\n');
  }
  const pack = { format: 'world-hub.pack/v1', id: 'lineage.source', version: '1.0.0', title: 'Source baseline', license: 'MIT', topics: { data: 'lineage/authoring/data' },
    components: moduleIds.map((module, index) => ({ id: 'member-' + index, module, after: [], settings: { label: 'Source' }, bridges: { main: { publish: ['data'], subscribe: ['data'] } } })),
    bindings: [], entry: { component: 'member-0' }, startupTimeoutMs: 1000, healthTimeoutMs: 1000, stopTimeoutMs: 1000, ...(lineage ? { lineage } : {}) };
  await save(join(source, 'pack.json'), pack); await createLock(source, environment);
  const original = await inspectAuthoring(source, environment), before = await inventory(source);
  const derive = (directory, target, patch = {}) => derivePackage(directory, { ...environment, redistributionAcknowledged: true, destination: join(root, target), ...patch });
  const assertSourceUnchanged = async () => assert.deepEqual(await inventory(source), before);
  return { root, source, original, derive, assertSourceUnchanged };
}
function assertBase(result, original) {
  assert.equal(result.pack.lineage.format, PACK_LINEAGE_FORMAT); assert.equal(result.pack.lineage.kind, 'customized');
  assert.deepEqual(result.pack.lineage.base, { id: original.pack.id, version: original.pack.version, sourceDigest: original.revision });
  assert.equal(new Date(result.pack.lineage.customizedAt).toISOString(), result.pack.lineage.customizedAt);
}

test('AUTHOR-LINEAGE-01 first and repeated same-ID derivations retain the inspected source baseline and source bytes', options, async t => {
  const app = await fixture(t), changed = structuredClone(app.original.pack);
  changed.version = '1.0.1'; changed.components[0].settings.label = 'First customization';
  const first = await app.derive(app.source, 'first', { pack: changed, expectedRevision: app.original.revision });
  assertBase(first, app.original); assert.equal(first.pack.lineage.revision, 1); assert.equal(first.pack.version, '1.0.1');
  assert.equal(first.startsModules, false); assert.equal(first.requiresNewExecutionReview, true);
  assert.deepEqual(first.modules, app.original.modules, 'Changing composition settings must not alter module IDs, versions or source declarations');
  const firstBytes = await inventory(first.directory), next = structuredClone(first.pack);
  next.version = '1.0.2'; next.components[0].settings.label = 'Second customization';
  const second = await app.derive(first.directory, 'second', { pack: next, expectedRevision: first.revision });
  assertBase(second, app.original); assert.equal(second.pack.lineage.revision, 2); assert.equal(second.pack.version, '1.0.2');
  assert.deepEqual(await inventory(first.directory), firstBytes, 'Derivation must not rewrite a previous customized source');
  await app.assertSourceUnchanged();
});

test('AUTHOR-LINEAGE-02 exact copies do not fabricate customization even when component order differs from lock module order', options, async t => {
  const app = await fixture(t, { reversedModuleOrder: true });
  assert.notDeepEqual(app.original.pack.components.map(row => row.module), app.original.review.modules.map(row => row.manifest.id), 'The fixture must exercise different declaration and lock iteration orders');
  const clone = await app.derive(app.source, 'clone', { expectedRevision: app.original.revision });
  assert.equal(Object.hasOwn(clone.pack, 'lineage'), false); assert.deepEqual(clone.pack, app.original.pack);
  const changed = structuredClone(app.original.pack); changed.version = '1.0.1';
  const customized = await app.derive(app.source, 'customized', { pack: changed });
  const customizedBytes = await inventory(customized.directory), copied = await app.derive(customized.directory, 'customized-clone');
  assert.deepEqual(copied.pack.lineage, customized.pack.lineage, 'An exact customized copy must not increment revision or replace the timestamp');
  assert.deepEqual(await inventory(customized.directory), customizedBytes); await app.assertSourceUnchanged();
});

test('AUTHOR-LINEAGE-03 edited source claims cannot replace the actual baseline and unsupported claims fail before writing a package', options, async t => {
  const app = await fixture(t), draft = structuredClone(app.original.pack);
  draft.version = '1.0.1';
  draft.lineage = { format: PACK_LINEAGE_FORMAT, kind: 'customized', base: { id: 'fake.publisher', version: '9.9.9', sourceDigest: 'f'.repeat(64) }, revision: 42, customizedAt: '2020-01-01T00:00:00.000Z' };
  const edited = structuredClone(draft), result = await app.derive(app.source, 'claim-overridden', { pack: draft });
  assertBase(result, app.original); assert.equal(result.pack.lineage.revision, 1); assert.deepEqual(draft, edited, 'Authoring must not mutate the caller draft');
  const lineageOnly = await app.derive(app.source, 'claim-only', { pack: { ...app.original.pack, lineage: draft.lineage } });
  assert.equal(Object.hasOwn(lineageOnly.pack, 'lineage'), false, 'Editing only the declaration cannot create a trusted source identity');
  const invalid = { ...draft, lineage: { ...draft.lineage, official: true } };
  await assert.rejects(app.derive(app.source, 'claim-rejected', { pack: invalid }), { code: 'PACK_LINEAGE_INVALID' });
  await assert.rejects(lstat(join(app.root, 'claim-rejected')), { code: 'ENOENT' });
  await app.assertSourceUnchanged();
});

test('AUTHOR-LINEAGE-04 a composition version-only change still records customization while leaving module version and bytes intact', options, async t => {
  const app = await fixture(t), next = { ...app.original.pack, version: '1.0.1' };
  const result = await app.derive(app.source, 'version-only', { pack: next });
  assertBase(result, app.original); assert.equal(result.pack.lineage.revision, 1);
  assert.deepEqual(result.review.modules, app.original.review.modules);
  assert.equal(result.modules[0].version, '1.0.0');
  assert.notEqual(result.review.lock.pack.sha256, app.original.review.lock.pack.sha256);
  await app.assertSourceUnchanged();
});

test('AUTHOR-LINEAGE-05 changing module source bytes records customization without trusting module ID/version alone', options, async t => {
  const app = await fixture(t), replacement = join(app.root, 'replacement'); await mkdir(replacement);
  const beforeModule = app.original.review.modules[0], beforeDirectory = join(app.source, beforeModule.source);
  await writeFile(join(replacement, 'module.json'), await readFile(join(beforeDirectory, 'module.json')));
  await writeFile(join(replacement, 'program.mjs'), 'throw new Error("Changed source is reviewed but never executed");\n');
  // Exercise the module-content comparison alone: an independent derivation
  // can keep the declaration identity, while in-place save requires a version
  // bump in the separate update transaction.
  const result = await app.derive(app.source, 'replacement-change', { replacements: [{ componentId: 'member-0', moduleDirectory: replacement }] });
  assertBase(result, app.original); assert.equal(result.pack.lineage.revision, 1);
  assert.equal(result.modules[0].id, beforeModule.manifest.id); assert.equal(result.modules[0].version, beforeModule.manifest.version);
  assert.notDeepEqual(result.review.modules[0].files, beforeModule.files); await app.assertSourceUnchanged();
});

test('AUTHOR-LINEAGE-06 runtime snapshot derivation binds the actual installed baseline instead of a transient snapshot revision', options, async t => {
  const app = await fixture(t), snapshot = await app.derive(app.source, 'runtime-snapshot');
  const transient = structuredClone(snapshot.pack); transient.components[0].settings.label = 'Live runtime wiring';
  await save(join(snapshot.directory, 'pack.json'), transient); await createLock(snapshot.directory, environment);
  const inspectedSnapshot = await inspectAuthoring(snapshot.directory, environment), snapshotBefore = await inventory(snapshot.directory);
  assert.notEqual(inspectedSnapshot.revision, app.original.revision);
  const result = await app.derive(snapshot.directory, 'saved-runtime', { expectedRevision: inspectedSnapshot.revision, pack: { ...transient, version: '1.0.1' },
    lineageSource: { pack: app.original.pack, revision: app.original.revision } });
  assertBase(result, app.original); assert.notEqual(result.pack.lineage.base.sourceDigest, inspectedSnapshot.revision);
  assert.equal(result.pack.components[0].settings.label, 'Live runtime wiring'); assert.equal(result.pack.lineage.revision, 1);
  assert.deepEqual(await inventory(snapshot.directory), snapshotBefore); await app.assertSourceUnchanged();
});

test('AUTHOR-LINEAGE-07 self-created saves keep that identity but a new derived ID records the self-created source', options, async t => {
  const app = await fixture(t, { lineage: { format: PACK_LINEAGE_FORMAT, kind: 'self-created' } });
  const changed = { ...app.original.pack, version: '1.0.1', title: 'Revised self-created composition' };
  const sameId = await app.derive(app.source, 'self-created-next', { pack: changed });
  assert.deepEqual(sameId.pack.lineage, app.original.pack.lineage);
  const newId = await app.derive(sameId.directory, 'derived-id', { pack: { ...sameId.pack, id: 'lineage.fork', version: '0.1.0' } });
  assertBase(newId, sameId); assert.equal(newId.pack.lineage.revision, 1); assert.equal(newId.pack.id, 'lineage.fork');
  await app.assertSourceUnchanged();
});
