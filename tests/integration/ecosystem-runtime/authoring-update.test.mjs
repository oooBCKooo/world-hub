import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLock } from '../../../scripts/runtime/package.mjs';
import { inspectAuthoring } from '../../../scripts/runtime/authoring.mjs';
import { updateSourcePackage } from '../../../scripts/runtime/authoring-update.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';

const environment = { nodePath: process.execPath };
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t, version = '1.0.0') {
  const root = await mkdtemp(join(tmpdir(), 'world-hub-source-update-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('world-hub-source-update-'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, 'source'), module = join(directory, 'modules', 'one');
  await mkdir(module, { recursive: true });
  await save(join(directory, 'pack.json'), {
    format: 'world-hub.pack/v1', id: 'update.fixture', version, title: 'Original source', license: 'MIT',
    topics: { data: 'authoring/update/data' },
    components: [{ id: 'one', module: 'update.module', after: [], settings: { label: 'Original' }, bridges: { main: { publish: ['data'], subscribe: ['data'] } } }],
    bindings: [], entry: { component: 'one' }, startupTimeoutMs: 1000, healthTimeoutMs: 1000, stopTimeoutMs: 1000
  });
  await save(join(module, 'module.json'), {
    format: 'world-hub.module/v1', id: 'update.module', version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
    runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [],
    permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' }
  });
  await writeFile(join(module, 'program.mjs'), 'throw new Error("Source authoring must never execute programs");\n');
  await createLock(directory, environment);
  const authoring = await inspectAuthoring(directory, environment);
  const pack = structuredClone(authoring.pack); pack.version = '1.0.1'; pack.components[0].settings.label = 'Updated';
  const options = { ...environment, pack, expectedRevision: authoring.revision, redistributionAcknowledged: true, assertUnused: async () => {} };
  return { root, directory, module, authoring, options };
}

test('SOURCE-UPDATE-01 source keeps its path, increments version and locks exact new contents while preserving the complete prior tree', { timeout: 30000 }, async t => {
  const app = await fixture(t);
  await mkdir(join(app.directory, 'personal-notes'));
  await writeFile(join(app.directory, 'personal-notes', 'retain.txt'), 'Unknown extra files stay in the recoverable previous tree.');
  const oldPack = await readFile(join(app.directory, 'pack.json')), oldLock = await readFile(join(app.directory, 'pack.lock'));
  let guards = 0;
  const result = await updateSourcePackage(app.directory, { ...app.options, assertUnused: async directory => { assert.equal(directory, app.directory); guards++; } });
  assert.equal(guards, 2); assert.equal(result.directory, app.directory); assert.equal(result.version, '1.0.1');
  assert.equal(result.updatedOriginal, true); assert.equal(result.startsModules, false);
  assert.equal(result.pack.components[0].settings.label, 'Updated');
  assert.notEqual(result.revision, app.authoring.revision);
  assert.equal((await inspectAuthoring(app.directory, environment)).revision, result.revision);
  const lock = await json(join(app.directory, 'pack.lock'));
  assert.equal(lock.pack.version, '1.0.1'); assert.equal(lock.pack.sha256, hash(await readFile(join(app.directory, 'pack.json'))));
  assert.deepEqual(await readFile(join(result.previousDirectory, 'pack.json')), oldPack);
  assert.deepEqual(await readFile(join(result.previousDirectory, 'pack.lock')), oldLock);
  assert.equal((await inspectAuthoring(result.previousDirectory, environment)).revision, app.authoring.revision);
  assert.match(await readFile(join(result.previousDirectory, 'personal-notes', 'retain.txt'), 'utf8'), /Unknown extra files/);
  await assert.rejects(lstat(join(app.directory, 'personal-notes')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(app.directory)).sort(), ['authoring.json', 'modules', 'pack.json', 'pack.lock']);
  assert.ok(!(await readdir(app.root)).some(name => name.endsWith('.source-update.lock')));
});

test('SOURCE-UPDATE-02 stale, same/lower versions, changed identity and missing guard/consent are rejected before moving source', { timeout: 30000 }, async t => {
  const app = await fixture(t), beforePack = await readFile(join(app.directory, 'pack.json')), beforeLock = await readFile(join(app.directory, 'pack.lock'));
  for (const version of ['1.0.0', '0.9.9', '1.0.0-rc.1']) {
    await assert.rejects(updateSourcePackage(app.directory, { ...app.options, pack: { ...app.options.pack, version } }), { code: 'SOURCE_UPDATE_VERSION_REQUIRED' });
  }
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, pack: { ...app.options.pack, id: 'another.pack' } }), { code: 'SOURCE_UPDATE_ID_CHANGED' });
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, expectedRevision: '0'.repeat(64) }), { code: 'SOURCE_UPDATE_REVISION_CHANGED' });
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, assertUnused: undefined }), { code: 'SOURCE_UPDATE_GUARD_REQUIRED' });
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, redistributionAcknowledged: false }), { code: 'SOURCE_UPDATE_REVIEW_REQUIRED' });
  assert.deepEqual(await readFile(join(app.directory, 'pack.json')), beforePack);
  assert.deepEqual(await readFile(join(app.directory, 'pack.lock')), beforeLock);
  assert.deepEqual(await readdir(app.root), ['source']);
});

test('SOURCE-UPDATE-03 guard rechecks ownership after preparing the candidate without touching an active source', { timeout: 30000 }, async t => {
  const app = await fixture(t), before = await readFile(join(app.directory, 'pack.json'));
  let guards = 0;
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, assertUnused: async () => {
    if (++guards === 2) throw Object.assign(new Error('A managed process started during preparation.'), { code: 'SOURCE_IN_USE' });
  } }), { code: 'SOURCE_IN_USE' });
  assert.equal(guards, 2); assert.deepEqual(await readFile(join(app.directory, 'pack.json')), before);
  assert.ok(!(await readdir(app.root)).some(name => name.includes('.previous-') || name.endsWith('.source-update.lock')));
  const staged = (await readdir(app.root)).find(name => name.includes('.update-'));
  assert.equal((await inspectAuthoring(join(app.root, staged), environment)).pack.version, '1.0.1');
});

test('SOURCE-UPDATE-04 concurrent source edits and changed module bytes fail closed with the current source retained', { timeout: 30000 }, async t => {
  const app = await fixture(t);
  let guards = 0;
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, assertUnused: async () => {
    if (++guards === 2) {
      const pack = await json(join(app.directory, 'pack.json')); pack.title = 'Concurrent author change';
      await save(join(app.directory, 'pack.json'), pack); await createLock(app.directory, environment);
    }
  } }), { code: 'SOURCE_UPDATE_REVISION_CHANGED' });
  assert.equal((await json(join(app.directory, 'pack.json'))).title, 'Concurrent author change');
  assert.equal((await inspectAuthoring(app.directory, environment)).pack.version, '1.0.0');
  const fresh = await inspectAuthoring(app.directory, environment);
  await writeFile(join(app.module, 'program.mjs'), 'unreviewed change\n');
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, expectedRevision: fresh.revision }), /file hash|file set/i);
  assert.equal(await readFile(join(app.module, 'program.mjs'), 'utf8'), 'unreviewed change\n');
});

test('SOURCE-UPDATE-05 filesystem roots, symbolic source paths, runtime roots and redirected destinations are refused', { timeout: 30000 }, async t => {
  const app = await fixture(t);
  await assert.rejects(updateSourcePackage(parse(app.directory).root, app.options), { code: 'SOURCE_UPDATE_PATH' });
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, destination: join(app.root, 'different') }), { code: 'SOURCE_UPDATE_PATH' });
  const link = join(app.root, 'source-link'); await symlink(app.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(updateSourcePackage(link, app.options), /Symbolic|reparse|link/i);
  await save(join(app.directory, 'instance.json'), { retained: true });
  await assert.rejects(updateSourcePackage(app.directory, app.options), { code: 'SOURCE_UPDATE_RUNTIME_DIRECTORY' });
  assert.deepEqual(await json(join(app.directory, 'instance.json')), { retained: true });
  assert.equal((await json(join(app.directory, 'pack.json'))).version, '1.0.0');
});

test('SOURCE-UPDATE-06 composition version precedence handles prerelease and multi-digit numbers', { timeout: 30000 }, async t => {
  const app = await fixture(t, '1.0.0-rc.9');
  await assert.rejects(updateSourcePackage(app.directory, { ...app.options, pack: { ...app.options.pack, version: '1.0.0-rc.8' } }), { code: 'SOURCE_UPDATE_VERSION_REQUIRED' });
  const result = await updateSourcePackage(app.directory, { ...app.options, pack: { ...app.options.pack, version: '1.0.0-rc.10' } });
  assert.equal(result.version, '1.0.0-rc.10');
  const stable = await updateSourcePackage(app.directory, { ...app.options, expectedRevision: result.revision, pack: { ...result.pack, version: '1.0.0' } });
  assert.equal(stable.version, '1.0.0');
});

test('SOURCE-UPDATE-07 source inside a different Runtime or local-program registry cannot bypass ownership guards', {timeout:30000},async t=>{
  const app=await fixture(t), beforePack=await readFile(join(app.directory,'pack.json')),beforeLock=await readFile(join(app.directory,'pack.lock'));
  await save(join(app.root,'instance.json'),{format:'world-hub.instance/v1',instanceId:'another-launcher'});
  await assert.rejects(updateSourcePackage(app.directory,app.options),{code:'SOURCE_UPDATE_RUNTIME_DIRECTORY'});
  await rm(join(app.root,'instance.json'));
  await save(join(app.root,'registry.json'),{format:'world-hub.launcher-local-programs/v1',programs:[]});
  await assert.rejects(updateSourcePackage(app.directory,app.options),{code:'SOURCE_UPDATE_RUNTIME_DIRECTORY'});
  assert.deepEqual(await readFile(join(app.directory,'pack.json')),beforePack);
  assert.deepEqual(await readFile(join(app.directory,'pack.lock')),beforeLock);
  assert.ok(!(await readdir(app.root)).some(name=>name.includes('.update-')||name.includes('.previous-')));
});
