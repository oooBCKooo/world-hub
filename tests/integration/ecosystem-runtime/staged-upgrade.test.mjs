import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock, importPackage, inspectPackage } from '../../../scripts/runtime/package.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { inspectBackup } from '../../../scripts/runtime/maintenance.mjs';
import { previewStagedUpgrade, createStagedUpgrade } from '../../../scripts/runtime/staged-upgrade.mjs';
import { previewUpgrade } from '../../../scripts/runtime/upgrade.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const environment = { nodePath: process.execPath, pythonPath: process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
const options = { timeout: 120000, concurrency: false };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const preserve = ['source', 'stats', 'desk'].map(componentId => ({ componentId, mode: 'preserve', dataFormat: 'provider-v1' }));
async function fixture(t, programSuffix = '') {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-staged-')), root = join(directory, 'runtime'), sessions = [];
  t.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[\\/]/).at(-1).startsWith('world-hub-staged-'));
    await rm(directory, { recursive: true, force: true });
  });
  const old = join(directory, 'old'); await cp(join(ROOT, 'examples/ecosystem-pack'), old, { recursive: true }); await createLock(old, environment);
  const imported = await importPackage(old, { root, instanceId: 'old', ...environment });
  const candidate = join(directory, 'candidate'); await cp(old, candidate, { recursive: true });
  const pack = await json(join(candidate, 'pack.json')); pack.version = '9.0.0'; await save(join(candidate, 'pack.json'), pack);
  const module = await json(join(candidate, 'modules/source/module.json')); module.version = '2.0.0'; await save(join(candidate, 'modules/source/module.json'), module);
  const source = join(candidate, 'modules/source/program.mjs'); await writeFile(source, (await readFile(source, 'utf8')) + '\n// new candidate code\n' + programSuffix);
  await createLock(candidate, environment);
  const state = join(imported.stateDir, 'programs/source'); await mkdir(state, { recursive: true }); await save(join(state, 'provider.json'), { format: 'provider-v1', count: 4, text: '私有旧状态 🌍' });
  const input = { root, instanceId: 'old', candidate, newInstanceId: 'trial', backupDestination: join(directory, 'old.whbackup'), statePolicy: 'fresh', ...environment };
  return { directory, root, imported, candidate, state, input,
    start: async (instanceId, digest) => { const session = await startInstance({ root, instanceId, trust: digest, ...environment }); sessions.push(session); return session; } };
}
async function business(app, instanceId, digest, text) {
  const session = await app.start(instanceId, digest);
  try {
    const response = await fetch(new URL('/analyze', session.ready.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.result.output.utf8Bytes, Buffer.byteLength(text)); assert.equal(result.result.output.codePoints, [...text].length);
    assert.deepEqual(result.result.receipts.map(receipt => receipt.step), ['source-set', 'source-read', 'python-statistics']); return result;
  } finally { await session.close(); }
}

test('STAGED-01 reviewed old backup and fresh new instance preserve the old instance and require separate execution/business checks', options, async t => {
  const app = await fixture(t); await business(app, 'old', app.imported.digest, 'old real business 🌍');
  const before = await readFile(join(app.state, 'provider.json')), identity = await readFile(join(app.imported.stateDir, 'instance.json'));
  const preview = await previewStagedUpgrade(app.input);
  assert.equal(preview.startsModules, false); assert.equal(preview.runsMigrations, false); assert.equal(preview.backup.consistency, 'confirmed-stopped');
  assert.equal(preview.data.programState, 'not-inherited'); assert.equal(preview.diff.applicationBehavior, 'not-validated');
  assert.ok(preview.diff.components.find(c => c.id === 'source').code.changed.includes('program.mjs'));
  assert.equal(await exists(app.input.backupDestination), false); assert.equal(await exists(preview.targetDirectory), false);
  await assert.rejects(createStagedUpgrade(app.input), { code: 'UPGRADE_TRUST_REQUIRED' });
  const result = await createStagedUpgrade({ ...app.input, trust: preview.trustDigest });
  assert.equal(result.oldInstancePreserved, true); assert.equal(result.startsModules, false); assert.equal(result.businessValidation, 'not-run');
  assert.equal(result.cutover, 'manual'); assert.equal(result.rollbackBoundary.externalApiSideEffects, 'not-restored');
  assert.deepEqual(await readFile(join(app.state, 'provider.json')), before); assert.deepEqual(await readFile(join(app.imported.stateDir, 'instance.json')), identity);
  assert.equal((await inspectBackup(result.backup.destination)).backup.sourceInstanceId, 'old');
  assert.equal(await exists(join(result.stateDir, 'programs/source/provider.json')), false);
  await assert.rejects(app.start('trial', app.imported.digest), /trusted|review/i);
  await business(app, 'trial', result.digest, 'new real cross-language business\n🌍');
  await business(app, 'old', app.imported.digest, 'return to old without overwrite');
});

test('STAGED-02 provider declarations copy application and Hub state but do not claim validated business migration', options, async t => {
  const app = await fixture(t); app.input.statePolicy = 'provider'; app.input.statePolicies = preserve;
  await business(app, 'old', app.imported.digest, 'opaque Hub receipts before copy 🌍');
  const preview = await previewStagedUpgrade(app.input);
  assert.equal(preview.data.migration, 'provider-preservation-declared'); assert.equal(preview.runsMigrations, false);
  const result = await createStagedUpgrade({ ...app.input, trust: preview.trustDigest });
  assert.equal(result.stateCompatibility, 'provider-declared-business-validation-pending');
  assert.deepEqual(await json(join(result.stateDir, 'programs/source/provider.json')), await json(join(app.state, 'provider.json')));
  await business(app, 'trial', result.digest, 'copied instance real business 🌍');
  assert.equal((await json(join(app.state, 'provider.json'))).count, 4);
});

test('STAGED-03 stale data, existing target and absent provider policies reject before writing the reviewed backup', options, async t => {
  const app = await fixture(t), preview = await previewStagedUpgrade(app.input);
  await save(join(app.state, 'provider.json'), { format: 'provider-v1', count: 99 });
  await assert.rejects(createStagedUpgrade({ ...app.input, trust: preview.trustDigest }), { code: 'UPGRADE_TRUST_REQUIRED' });
  assert.equal(await exists(app.input.backupDestination), false);
  await assert.rejects(previewStagedUpgrade({ ...app.input, statePolicy: 'provider' }), { code: 'UPGRADE_POLICY_REQUIRED' });
  await assert.rejects(previewStagedUpgrade({ ...app.input, statePolicy: 'fresh', statePolicies: preserve }), { code: 'UPGRADE_POLICY_INVALID' });
  await assert.rejects(previewStagedUpgrade({ ...app.input, newInstanceId: 'old' }), { code: 'UPGRADE_TARGET_INVALID' });
  await mkdir(join(app.root, 'instances/trial'));
  await assert.rejects(previewStagedUpgrade(app.input), { code: 'UPGRADE_TARGET_EXISTS' });
});

test('STAGED-04 failed candidate start leaves old stopped state and business runnable without automatic cutover', options, async t => {
  const app = await fixture(t, `throw Error('candidate startup deliberately fails');\n`), preview = await previewStagedUpgrade(app.input);
  const result = await createStagedUpgrade({ ...app.input, trust: preview.trustDigest });
  const before = await readFile(join(app.state, 'provider.json'));
  await assert.rejects(app.start('trial', result.digest), /deliberately|exited|failed/i);
  assert.deepEqual(await readFile(join(app.state, 'provider.json')), before);
  assert.equal((await inspectPackage(join(app.imported.stateDir, 'package'), environment)).digest, app.imported.digest);
  await business(app, 'old', app.imported.digest, 'old works after candidate failed 🌍');
});

test('STAGED-05 failed provider migration retains new private diagnostic state while the original application data is unchanged', options, async t => {
  const app = await fixture(t); const migration = join(app.candidate, 'modules/source/migrate.mjs');
  await writeFile(migration, `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const c=JSON.parse(await readFile(process.argv[2],'utf8'));await writeFile(join(c.dataDirectory,'provider.json'),'partial new state');throw Error('provider refuses migration');\n`);
  await createLock(app.candidate, environment);
  app.input.statePolicy = 'provider'; app.input.statePolicies = preserve.map(p => p.componentId !== 'source' ? p : { componentId: 'source', mode: 'migrate', fromFormat: 'provider-v1', toFormat: 'provider-v2', runtime: 'node', entry: 'migrate.mjs', timeoutMs: 10000 });
  const preview = await previewStagedUpgrade(app.input); assert.equal(preview.runsMigrations, true);
  await assert.rejects(createStagedUpgrade({ ...app.input, trust: preview.trustDigest }), error => error.code === 'UPGRADE_MIGRATION_FAILED' && error.oldInstancePreserved === true && error.candidateMayNeedRecovery === true && !!error.backup.sha256);
  assert.equal((await json(join(app.state, 'provider.json'))).count, 4);
  assert.equal((await json(join(app.root, 'instances/trial/programs/source/provider.json'))).count, 4);
  await business(app, 'old', app.imported.digest, 'old works after migration refused 🌍');
});

test('STAGED-06 in-place and staged previews expose human-readable code, contracts, permissions, dependency, platform, runtime and license differences', options, async t => {
  const app = await fixture(t);
  const pack = await json(join(app.candidate, 'pack.json')); pack.components.find(c => c.id === 'source').after = ['stats']; await save(join(app.candidate, 'pack.json'), pack);
  const module = await json(join(app.candidate, 'modules/source/module.json'));
  module.license = 'Apache-2.0'; module.platforms = [`${process.platform}-${process.arch}`]; module.permissions.network.push('loopback-listen');
  module.provides.push({ id: 'provider.extra', version: '1.0.0' }); await save(join(app.candidate, 'modules/source/module.json'), module);
  await createLock(app.candidate, environment);
  const staged = await previewStagedUpgrade(app.input), inplace = await previewUpgrade({ ...app.input, statePolicies: preserve });
  const source = staged.diff.components.find(c => c.id === 'source');
  for (const key of ['module', 'license', 'contracts', 'permissions', 'dependencies', 'platforms']) assert.ok(source.changedDimensions.includes(key), key);
  assert.equal(source.before.runtime.pin.version, source.after.runtime.pin.version); assert.equal(staged.diff.current.platform.os, process.platform);
  assert.deepEqual(staged.diff, inplace.diff); assert.equal(inplace.stateCompatibility, 'provider-declared-not-business-validated');
  assert.equal(inplace.rollbackBoundary.alreadySentMessages, 'not-retracted');
  const session = await app.start('old', app.imported.digest);
  await assert.rejects(previewStagedUpgrade(app.input), { code: 'INSTANCE_LOCKED' }); await session.close();
});
