import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createLock, importPackage, inspectPackage } from '../../../scripts/runtime/package.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { previewUpgrade, upgradeInstance, previewRollback, rollbackUpgrade, recoverUpgrade, inspectUpgradeHistory, assertNoIncompleteUpgrades } from '../../../scripts/runtime/upgrade.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const environment = { nodePath: process.execPath, pythonPath: process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
const options = { timeout: 120000, concurrency: false };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const preserve = ['source', 'stats', 'desk'].map(componentId => ({ componentId, mode: 'preserve', dataFormat: 'provider-defined-v1' }));
async function workspace(t, migration) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-upgrade-')), root = join(directory, 'runtime'), sessions = [];
  t.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[\\/]/).at(-1).startsWith('world-hub-upgrade-'));
    await rm(directory, { recursive: true, force: true });
  });
  const pack = join(directory, 'original'); await cp(join(ROOT, 'examples/ecosystem-pack'), pack, { recursive: true }); await createLock(pack, environment);
  const imported = await importPackage(pack, { root, instanceId: 'sample', ...environment });
  const candidate = join(directory, 'candidate'); await cp(pack, candidate, { recursive: true });
  const manifest = await json(join(candidate, 'pack.json')); manifest.version = '9.0.0'; manifest.title += ' upgraded'; await save(join(candidate, 'pack.json'), manifest);
  const module = await json(join(candidate, 'modules/source/module.json')); module.version = '2.0.0'; await save(join(candidate, 'modules/source/module.json'), module);
  if (migration) await writeFile(join(candidate, 'modules/source/migrate.mjs'), migration);
  await createLock(candidate, environment);
  const state = join(imported.stateDir, 'programs/source'); await mkdir(state, { recursive: true });
  await save(join(state, 'provider.json'), { format: 'provider-v1', count: 4, text: '持久 🌍' });
  await mkdir(join(imported.stateDir, 'hub/log'), { recursive: true }); await writeFile(join(imported.stateDir, 'hub/log', 'fixture-state.txt'), 'opaque Hub state');
  const upgrade = { root, instanceId: 'sample', candidate, statePolicies: preserve, ...environment };
  return { directory, root, imported, candidate, state, upgrade, sessions,
    start: async digest => { const session = await startInstance({ root, instanceId: 'sample', trust: digest, ...environment }); sessions.push(session); return session; } };
}
const migration = `import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const file=join(config.dataDirectory,'provider.json'); const data=JSON.parse(await readFile(file,'utf8'));
if(data.format!==config.fromFormat) throw Error('Provider refuses unknown format');
await writeFile(file,JSON.stringify({...data,format:config.toFormat,count:data.count+10})+'\\n');
`;
function migratePolicies() { return preserve.map(p => p.componentId === 'source' ? { componentId: 'source', mode: 'migrate', fromFormat: 'provider-v1', toFormat: 'provider-v2', runtime: 'node', entry: 'migrate.mjs', timeoutMs: 10000 } : p); }

test('UPGRADE-01 exact stopped review preserves opaque state, replaces software and requires fresh execution review', options, async t => {
  const app = await workspace(t), identity = await json(join(app.imported.stateDir, 'instance.json'));
  // Hub fixture is intentionally opaque; remove it before actual Runtime execution.
  const preview = await previewUpgrade(app.upgrade);
  assert.equal(preview.startsModules, false); assert.equal(preview.runsMigrations, false); assert.equal(preview.sandbox, false);
  await assert.rejects(upgradeInstance(app.upgrade), { code: 'UPGRADE_TRUST_REQUIRED' });
  const result = await upgradeInstance({ ...app.upgrade, trust: preview.trustDigest });
  assert.equal(result.state, 'committed'); assert.notEqual(result.digest, identity.digest);
  assert.deepEqual(await json(join(app.state, 'provider.json')), { format: 'provider-v1', count: 4, text: '持久 🌍' });
  assert.equal(await readFile(join(app.imported.stateDir, 'hub/log/fixture-state.txt'), 'utf8'), 'opaque Hub state');
  assert.equal((await inspectPackage(join(app.imported.stateDir, 'package'), environment)).pack.version, '9.0.0');
  await assert.rejects(app.start(app.imported.digest), /trusted|review/i);
  await rm(join(app.imported.stateDir, 'hub/log/fixture-state.txt'));
  const session = await app.start(result.digest);
  const response = await fetch(new URL('/analyze', session.ready.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '升级后真实跨语言 🌍' }) });
  const business = await response.json(); assert.equal(response.status, 200); assert.equal(business.result.output.utf8Bytes, Buffer.byteLength('升级后真实跨语言 🌍'));
  await session.close();
  assert.equal((await inspectUpgradeHistory({ root: app.root, instanceId: 'sample' })).transactions[0].state, 'committed');
});
test('UPGRADE-02 provider-defined migration transforms only staged state and full rollback restores original software and data', options, async t => {
  const app = await workspace(t, migration); app.upgrade.statePolicies = migratePolicies();
  const preview = await previewUpgrade(app.upgrade); assert.equal(preview.runsMigrations, true);
  const result = await upgradeInstance({ ...app.upgrade, trust: preview.trustDigest });
  assert.deepEqual(await json(join(app.state, 'provider.json')), { format: 'provider-v2', count: 14, text: '持久 🌍' });
  const rollback = { root: app.root, instanceId: 'sample', transactionId: result.transactionId, ...environment };
  const review = await previewRollback(rollback); assert.equal(review.discardsCurrentData, true); assert.equal(review.runsMigrations, false);
  await assert.rejects(rollbackUpgrade(rollback), { code: 'UPGRADE_TRUST_REQUIRED' });
  const restored = await rollbackUpgrade({ ...rollback, trust: review.trustDigest });
  assert.equal(restored.digest, app.imported.digest); assert.equal(restored.restoresAllPersistentData, true); assert.ok(restored.latestDataSnapshot.sha256);
  assert.deepEqual(await json(join(app.state, 'provider.json')), { format: 'provider-v1', count: 4, text: '持久 🌍' });
  assert.equal(await readFile(join(app.imported.stateDir, 'hub/log/fixture-state.txt'), 'utf8'), 'opaque Hub state');
  assert.equal((await inspectPackage(join(app.imported.stateDir, 'package'), environment)).pack.version, (await json(join(app.directory, 'original/pack.json'))).version);
});
test('UPGRADE-03 failed author migration cannot replace original values and records a private aborted snapshot', options, async t => {
  const app = await workspace(t, migration + `throw Error('provider deliberately rejects conversion');\n`); app.upgrade.statePolicies = migratePolicies();
  const before = await readFile(join(app.state, 'provider.json')), preview = await previewUpgrade(app.upgrade);
  await assert.rejects(upgradeInstance({ ...app.upgrade, trust: preview.trustDigest }), error => error.code === 'UPGRADE_MIGRATION_FAILED' && error.preservesOriginalData === true && !!error.transactionId);
  assert.deepEqual(await readFile(join(app.state, 'provider.json')), before);
  assert.equal((await json(join(app.imported.stateDir, 'instance.json'))).digest, app.imported.digest);
  assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
  const history = await inspectUpgradeHistory({ root: app.root, instanceId: 'sample' }); assert.equal(history.transactions[0].state, 'aborted');
  await assertNoIncompleteUpgrades(app.imported.stateDir);
});
test('UPGRADE-04 missing provider policy, unlocked migration and changed data reject stale upgrade confirmations', options, async t => {
  const app = await workspace(t);
  await assert.rejects(previewUpgrade({ ...app.upgrade, statePolicies: [] }), { code: 'UPGRADE_POLICY_REQUIRED' });
  await assert.rejects(previewUpgrade({ ...app.upgrade, statePolicies: migratePolicies() }), { code: 'UPGRADE_POLICY_INVALID' });
  const preview = await previewUpgrade(app.upgrade); await writeFile(join(app.state, 'new-state.txt'), 'written after review');
  await assert.rejects(upgradeInstance({ ...app.upgrade, trust: preview.trustDigest }), { code: 'UPGRADE_TRUST_REQUIRED' });
  assert.equal(await readFile(join(app.state, 'new-state.txt'), 'utf8'), 'written after review');
});
test('UPGRADE-05 a new stopped run and new data invalidate old data rollback review; explicit new review preserves latest snapshot', options, async t => {
  const app = await workspace(t), preview = await previewUpgrade(app.upgrade), result = await upgradeInstance({ ...app.upgrade, trust: preview.trustDigest });
  const options = { root: app.root, instanceId: 'sample', transactionId: result.transactionId, ...environment }, review = await previewRollback(options);
  await rm(join(app.imported.stateDir, 'hub/log/fixture-state.txt'));
  const session = await app.start(result.digest);
  const actual = await fetch(new URL('/analyze', session.ready.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'later actual program result' }) });
  assert.equal(actual.status, 200); await session.close();
  await save(join(app.state, 'provider.json'), { format: 'provider-v1', count: 99, text: 'new user values' });
  await assert.rejects(rollbackUpgrade({ ...options, trust: review.trustDigest }), { code: 'UPGRADE_TRUST_REQUIRED' });
  assert.equal((await json(join(app.state, 'provider.json'))).count, 99);
  const current = await previewRollback(options); assert.equal(current.latestRunChanged, true);
  const restored = await rollbackUpgrade({ ...options, trust: current.trustDigest }); assert.ok(restored.latestDataSnapshot.sha256);
  assert.equal((await json(join(app.state, 'provider.json'))).count, 4);
});
test('UPGRADE-06 migration scope detection rejects writes to staged opaque Hub or another provider', options, async t => {
  const app = await workspace(t, migration + `await writeFile(join(config.dataDirectory,'../../hub/log/fixture-state.txt'),'unexpected Hub rewrite');\n`); app.upgrade.statePolicies = migratePolicies();
  const preview = await previewUpgrade(app.upgrade);
  await assert.rejects(upgradeInstance({ ...app.upgrade, trust: preview.trustDigest }), { code: 'UPGRADE_MIGRATION_SCOPE' });
  assert.equal(await readFile(join(app.imported.stateDir, 'hub/log/fixture-state.txt'), 'utf8'), 'opaque Hub state');
});
test('UPGRADE-07 cancelled owned migration confirms process exit and leaves original data active', options, async t => {
  const app = await workspace(t, `import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';const c=JSON.parse(await readFile(process.argv[2]));await writeFile(join(c.dataDirectory,'staged-only.txt'),'private');setInterval(()=>{},1000);`);
  app.upgrade.statePolicies = migratePolicies(); const preview = await previewUpgrade(app.upgrade), controller = new AbortController();
  const pending = upgradeInstance({ ...app.upgrade, trust: preview.trustDigest, signal: controller.signal });
  let owner;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const history = await inspectUpgradeHistory({ root: app.root, instanceId: 'sample' }).catch(() => ({ transactions: [] }));
    if (history.transactions[0]) {
      const journal = await json(join(app.imported.stateDir, 'upgrades', history.transactions[0].transactionId, 'transaction.json'));
      if (journal.migrationOwner?.pid) { owner = journal.migrationOwner; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(owner?.pid); controller.abort(); await assert.rejects(pending, { code: 'UPGRADE_ABORTED' });
  assert.throws(() => process.kill(owner.pid, 0), error => error.code === 'ESRCH');
  assert.equal(await exists(join(app.state, 'staged-only.txt')), false); assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
});
async function crashAfterRename(app, destinationSuffix) {
  const script = join(app.directory, 'crash-transaction.mjs');
  const moduleUrl = pathToFileURL(join(ROOT, 'scripts/runtime/upgrade.mjs')).href;
  await writeFile(script, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.rename;
fs.rename=async(from,to)=>{const result=await original(from,to);if(to.replaceAll('\\\\','/').endsWith(${JSON.stringify(destinationSuffix)}))process.exit(77);return result;};syncBuiltinESMExports();
const {previewUpgrade,upgradeInstance}=await import(${JSON.stringify(moduleUrl)});const options=${JSON.stringify(app.upgrade)};const review=await previewUpgrade(options);await upgradeInstance({...options,trust:review.trustDigest});process.exit(0);\n`);
  const child = spawn(process.execPath, [script], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 77, stderr);
  const owner = await json(join(app.imported.stateDir, 'owner.lock'));
  assert.equal(owner.pid, child.pid); assert.ok(owner.transactionId);
  return { root: app.root, instanceId: 'sample', transactionId: owner.transactionId, ...environment };
}
test('UPGRADE-08 real owner crash after package evacuation requires explicit recovery and restores exact original groups', options, async t => {
  const app = await workspace(t), before = await readFile(join(app.state, 'provider.json'));
  const recovery = await crashAfterRename(app, '/old/package');
  await assert.rejects(assertNoIncompleteUpgrades(app.imported.stateDir), { code: 'UPGRADE_RECOVERY_REQUIRED' });
  assert.equal(await exists(join(app.imported.stateDir, 'package')), false);
  const review = await previewRollback(recovery); assert.equal(review.recoveryRequired, true);
  assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), true, 'Read-only review preserves abandoned ownership');
  const result = await recoverUpgrade({ ...recovery, trust: review.trustDigest }); assert.equal(result.recovered, true);
  assert.equal((await inspectPackage(join(app.imported.stateDir, 'package'), environment)).digest, app.imported.digest);
  assert.deepEqual(await readFile(join(app.state, 'provider.json')), before); assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
  await assertNoIncompleteUpgrades(app.imported.stateDir);
});
test('UPGRADE-09 crash after migrated data installation restores originals; external later writes are never overwritten', options, async t => {
  const app = await workspace(t, migration); app.upgrade.statePolicies = migratePolicies();
  const recovery = await crashAfterRename(app, '/sample/programs');
  assert.equal((await json(join(app.state, 'provider.json'))).count, 14);
  const review = await previewRollback(recovery); await save(join(app.state, 'provider.json'), { format: 'provider-v2', count: 777 });
  await assert.rejects(recoverUpgrade({ ...recovery, trust: review.trustDigest }), { code: 'UPGRADE_TRUST_REQUIRED' });
  const fresh = await previewRollback(recovery);
  await assert.rejects(recoverUpgrade({ ...recovery, trust: fresh.trustDigest }), { code: 'UPGRADE_RECOVERY_CONFLICT' });
  assert.equal((await json(join(app.state, 'provider.json'))).count, 777);
});
test('UPGRADE-10 real crash after staged migration installation restores original data and software without rerunning migration', options, async t => {
  const app = await workspace(t, migration); app.upgrade.statePolicies = migratePolicies();
  const recovery = await crashAfterRename(app, '/sample/programs');
  assert.equal((await json(join(app.state, 'provider.json'))).count, 14);
  const review = await previewRollback(recovery), result = await recoverUpgrade({ ...recovery, trust: review.trustDigest });
  assert.equal(result.preservesOriginalData, true); assert.equal(result.digest, app.imported.digest);
  assert.equal((await json(join(app.state, 'provider.json'))).count, 4);
  assert.equal((await inspectPackage(join(app.imported.stateDir, 'package'), environment)).digest, app.imported.digest);
  assert.equal(await readFile(join(app.imported.stateDir, 'hub/log/fixture-state.txt'), 'utf8'), 'opaque Hub state');
  await assertNoIncompleteUpgrades(app.imported.stateDir);
});
test('UPGRADE-11 I/O failure after actual package evacuation automatically restores original groups before reporting failure', options, async t => {
  const app = await workspace(t), script = join(app.directory, 'rename-failure.mjs'), resultFile = join(app.directory, 'failure-result.json');
  await writeFile(script, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';let failed=false;const original=fs.rename;
fs.rename=async(from,to)=>{const result=await original(from,to);if(!failed&&to.replaceAll('\\\\','/').endsWith('/old/package')){failed=true;throw Object.assign(Error('Injected I/O failure after rename'),{code:'EIO'});}return result;};syncBuiltinESMExports();
const {previewUpgrade,upgradeInstance}=await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/runtime/upgrade.mjs')).href)});const options=${JSON.stringify(app.upgrade)};const review=await previewUpgrade(options);try{await upgradeInstance({...options,trust:review.trustDigest});process.exitCode=2;}catch(error){await fs.writeFile(${JSON.stringify(resultFile)},JSON.stringify({code:error.code,rolledBack:error.rolledBack,preservesOriginalData:error.preservesOriginalData}));}\n`);
  const child = spawn(process.execPath, [script], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.resume();
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); assert.equal(code, 0, stderr);
  assert.deepEqual(await json(resultFile), { code: 'EIO', rolledBack: true, preservesOriginalData: true });
  assert.equal((await inspectPackage(join(app.imported.stateDir, 'package'), environment)).digest, app.imported.digest);
  assert.equal((await json(join(app.state, 'provider.json'))).count, 4); assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
  await assertNoIncompleteUpgrades(app.imported.stateDir);
});
