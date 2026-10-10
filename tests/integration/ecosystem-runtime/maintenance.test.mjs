import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock, importPackage, inspectPackage } from '../../../scripts/runtime/package.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { backupInstance, inspectBackup, restoreInstance, storageInstance, detachInstance, reattachInstance, backupLimits } from '../../../scripts/runtime/maintenance.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const environment = { nodePath: process.execPath, pythonPath: process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
const options = { timeout: 90000, concurrency: false };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-maintenance-'));
  const root = join(directory, 'runtime'), sessions = [], pids = new Set();
  t.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    for (const pid of pids) assert.equal(alive(pid), false, `Owned process ${pid} remained alive`);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('world-hub-maintenance-'));
    await rm(directory, { recursive: true, force: true });
  });
  const pack = join(directory, 'pack'); await cp(join(ROOT, 'examples/ecosystem-pack'), pack, { recursive: true });
  await createLock(pack, environment);
  const imported = await importPackage(pack, { root, instanceId: 'original', ...environment });
  const start = async (instanceId, digest, otherRoot = root) => {
    const session = await startInstance({ root: otherRoot, instanceId, trust: digest, ...environment });
    sessions.push(session); for (const pid of session.ready.pids) pids.add(pid); return session;
  };
  const archive = async extra => {
    const destination = join(directory, `snapshot-${randomUUID()}.whbackup`);
    const result = await backupInstance({ root, instanceId: 'original', destination, ...environment, ...extra });
    return { destination, result };
  };
  return { directory, root, pack, imported, start, archive };
}
async function request(base, path, init) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000), ...init });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
}
const analyze = (session, text) => request(session.ready.entryUrl, '/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
async function files(root, prefix = '') {
  if (!(await exists(root))) return [];
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const local = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, local)); else result.push(local);
  }
  return result.sort();
}
function decode(bytes) {
  const magic = Buffer.from('WORLD-HUB-INSTANCE-BACKUP/1\n');
  const length = bytes.readUInt32BE(magic.length), header = JSON.parse(bytes.subarray(magic.length + 4, magic.length + 4 + length));
  let position = magic.length + 4 + length;
  const bodies = header.files.map(file => { const body = bytes.subarray(position, position + file.bytes); position += file.bytes; return Buffer.from(body); });
  return { magic, header, bodies };
}
function encode(value) {
  const header = Buffer.from(JSON.stringify(value.header)), length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  return Buffer.concat([value.magic, length, header, ...value.bodies]);
}
async function altered(app, source, change) {
  const archive = decode(await readFile(source)); change(archive);
  const file = join(app.directory, `altered-${randomUUID()}.whbackup`); await writeFile(file, encode(archive)); return file;
}

test('MAINTENANCE-01 confirmed-stop backup and new-root restore preserve real JS/Python business data and regenerate runtime secrets', options, async t => {
  const app = await workspace(t), first = await app.start('original', app.imported.digest);
  const text = '持久业务 🌍\nIndependent modules';
  const result = (await analyze(first, text)).result;
  assert.equal(result.output.utf8Bytes, Buffer.byteLength(text));
  const beforeState = await request(first.ready.entryUrl, '/state');
  const oldControl = await json(join(app.imported.stateDir, 'control.json'));
  const status = await first.status(), oldRun = status.runId;
  const oldTokens = new Set();
  for (const id of ['source', 'stats', 'desk']) {
    const config = await json(join(app.imported.stateDir, 'runs', oldRun, id + '.json'));
    for (const bridge of config.bridges) oldTokens.add(bridge.token);
  }
  await assert.rejects(app.archive(), { code: 'INSTANCE_LOCKED' });
  await first.close();
  const hubFiles = await files(join(app.imported.stateDir, 'hub'));
  const durableHashes = await Promise.all(hubFiles.map(async f => [f, sha(await readFile(join(app.imported.stateDir, 'hub', f)))]));
  await writeFile(join(app.imported.stateDir, 'programs', 'source', 'tmp', 'throwaway.txt'), 'transient');
  const { destination, result: saved } = await app.archive();
  assert.equal(saved.private, true); assert.equal(saved.mayIncludeApplicationSecrets, true);
  assert.equal(saved.sha256, sha(await readFile(destination)));
  const view = await inspectBackup(destination);
  assert.equal(view.compatible, true); assert.equal(view.backup.consistency, 'confirmed-stopped');
  const decoded = decode(await readFile(destination));
  assert.ok(decoded.header.files.some(f => f.path === 'programs/desk/results.json'));
  assert.ok(decoded.header.files.some(f => f.path.startsWith('hub/log/')));
  assert.ok(decoded.header.files.every(f => !/^(?:runs\/|control\.json$|status\.json$|owner\.lock$|instance\.json$)/.test(f.path)));
  assert.ok(decoded.header.files.every(f => !/^programs\/[^/]+\/tmp\//.test(f.path)));
  for (const secret of [oldControl.token, ...oldTokens]) assert.equal((await readFile(destination)).includes(Buffer.from(secret)), false);
  const otherRoot = join(app.directory, 'relocated'), restored = await restoreInstance({ root: otherRoot, instanceId: 'restored', backup: destination, expectedSha256: view.sha256, ...environment });
  assert.equal(restored.startsModules, false); assert.equal(await exists(join(restored.stateDir, 'runs')), false);
  assert.equal((await json(join(restored.stateDir, 'instance.json'))).instanceId, 'restored');
  assert.deepEqual(await Promise.all(hubFiles.map(async f => [f, sha(await readFile(join(restored.stateDir, 'hub', f)))])), durableHashes);
  const second = await app.start('restored', restored.digest, otherRoot), freshStatus = await second.status();
  assert.notEqual(freshStatus.runId, oldRun);
  assert.notEqual((await json(join(restored.stateDir, 'control.json'))).token, oldControl.token);
  for (const id of ['source', 'stats', 'desk']) {
    const fresh = await json(join(restored.stateDir, 'runs', freshStatus.runId, id + '.json'));
    assert.equal(fresh.instanceId, 'restored'); assert.ok(fresh.bridges.every(b => !oldTokens.has(b.token)));
  }
  assert.deepEqual((await request(second.ready.entryUrl, '/state')).results, beforeState.results);
  const after = (await analyze(second, 'restored actual flow')).result;
  assert.equal(after.output.sha256, sha(Buffer.from('restored actual flow')));
  assert.ok(after.receipts[0].requestSeq > result.receipts.at(-1).responseSeq, 'Restored Hub keeps prior durable sequence state');
  t.diagnostic('Real JS → Python → JS business state recovered into another local root; this is not a claim of a second machine or live database snapshot');
});

test('MAINTENANCE-02 never-started snapshots, usage, retained-data uninstall and reviewed reattach remain separate from execution', options, async t => {
  const app = await workspace(t);
  await mkdir(join(app.imported.stateDir, 'programs', 'source'), { recursive: true });
  await mkdir(join(app.imported.stateDir, 'programs', 'source', 'empty-marker'), { recursive: true });
  await writeFile(join(app.imported.stateDir, 'programs', 'source', 'source.json'), JSON.stringify({ text: 'kept after uninstall', revision: 7 }));
  const before = await storageInstance({ root: app.root, instanceId: 'original' });
  assert.equal(before.consistency, 'stopped'); assert.ok(before.groups.package.bytes > 0); assert.ok(before.groups.programs.bytes > 0);
  const detached = await detachInstance({ root: app.root, instanceId: 'original' });
  assert.equal(detached.preservesData, true); assert.equal(detached.softwareRetainedInQuarantine, true);
  assert.equal(await exists(join(app.imported.stateDir, 'package')), false);
  assert.equal(await exists(join(app.imported.stateDir, 'runs')), false);
  await assert.rejects(startInstance({ root: app.root, instanceId: 'original', trust: app.imported.digest, ...environment }), { code: 'ENOENT' });
  assert.equal((await storageInstance({ root: app.root, instanceId: 'original' })).detached, true);
  const snapshot = await app.archive(), inspected = await inspectBackup(snapshot.destination);
  assert.equal(inspected.backup.consistency, 'never-started');
  const restored = await restoreInstance({ root: app.root, instanceId: 'copy', backup: snapshot.destination, expectedSha256: inspected.sha256, ...environment });
  assert.equal((await json(join(restored.stateDir, 'programs/source/source.json'))).revision, 7);
  assert.equal((await lstat(join(restored.stateDir, 'programs/source/empty-marker'))).isDirectory(), true);
  const review = await inspectPackage(join(app.imported.stateDir, 'detached-package'), environment);
  await assert.rejects(reattachInstance({ root: app.root, instanceId: 'original', trust: '0'.repeat(64), ...environment }), { code: 'REVIEW_CHANGED' });
  const reattached = await reattachInstance({ root: app.root, instanceId: 'original', trust: review.digest, ...environment });
  assert.equal(reattached.startsModules, false); assert.equal(await exists(join(app.imported.stateDir, 'detached.json')), false);
  assert.equal((await json(join(app.imported.stateDir, 'programs/source/source.json'))).revision, 7);
  assert.equal(await exists(join(app.imported.stateDir, 'runs')), false);
  await app.start('original', reattached.digest);
});

test('MAINTENANCE-03 existing owners, stale runs and unconfirmed cleanup are never guessed into a safe backup', options, async t => {
  const app = await workspace(t), lock = join(app.imported.stateDir, 'owner.lock');
  await save(lock, { nonce: 'some-other-owner', pid: process.pid });
  await assert.rejects(app.archive(), { code: 'INSTANCE_LOCKED' });
  assert.equal((await json(lock)).nonce, 'some-other-owner'); await unlink(lock);
  for (const status of [
    { state: 'running', runId: 'stale-running', stoppedAt: null },
    { state: 'failed', runId: 'unknown-cleanup', cleanupIncomplete: true, stoppedAt: null },
    { state: 'failed', runId: 'missing-terminal-proof', stoppedAt: new Date().toISOString(), components: [{ process: 'running', exit: null }] },
  ]) {
    await save(join(app.imported.stateDir, 'status.json'), { format: 'world-hub.runtime-status/v1', instanceId: 'original', components: [], ...status });
    await assert.rejects(app.archive(), { code: 'INSTANCE_NOT_STOPPED' });
    await assert.rejects(detachInstance({ root: app.root, instanceId: 'original' }), { code: 'INSTANCE_NOT_STOPPED' });
    assert.equal(await exists(lock), false, 'Only this maintenance owner is cleaned after rejection');
  }
});

test('MAINTENANCE-04 private backup cannot overwrite an existing file or be written into source data', options, async t => {
  const app = await workspace(t), target = join(app.directory, 'existing.whbackup');
  await writeFile(target, 'keep-me');
  await assert.rejects(backupInstance({ root: app.root, instanceId: 'original', destination: target, ...environment }), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'keep-me');
  await assert.rejects(backupInstance({ root: app.root, instanceId: 'original', destination: join(app.imported.stateDir, 'programs/backup.whbackup'), ...environment }), { code: 'BACKUP_PATH' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(app.archive({ signal: controller.signal }), { code: 'MAINTENANCE_ABORTED' });
  assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
});

test('MAINTENANCE-05 malformed, tampered and truncated backup payloads are rejected without extraction', options, async t => {
  const app = await workspace(t), snapshot = await app.archive();
  const badHash = await altered(app, snapshot.destination, v => { v.bodies.at(-1)[0] ^= 1; });
  await assert.rejects(inspectBackup(badHash), { code: 'BACKUP_HASH' });
  const source = await readFile(snapshot.destination);
  for (const bytes of [Buffer.from('not-a-backup'), source.subarray(0, source.length - 1), Buffer.concat([source, Buffer.from('unlisted')])]) {
    const path = join(app.directory, `malformed-${randomUUID()}`); await writeFile(path, bytes); await assert.rejects(inspectBackup(path));
  }
  const oversizedHeader = Buffer.from(source); oversizedHeader.writeUInt32BE(backupLimits.headerBytes + 1, Buffer.byteLength('WORLD-HUB-INSTANCE-BACKUP/1\n'));
  const headerPath = join(app.directory, 'oversized-header'); await writeFile(headerPath, oversizedHeader); await assert.rejects(inspectBackup(headerPath), { code: 'BACKUP_LIMIT' });
  await assert.rejects(restoreInstance({ root: app.root, instanceId: 'tampered', backup: badHash, ...environment }), { code: 'BACKUP_HASH' });
  assert.equal(await exists(join(app.root, 'instances/tampered')), false);
});

test('MAINTENANCE-06 traversal, case aliases, runtime records, undeclared state and path overlap are rejected', options, async t => {
  const app = await workspace(t), snapshot = await app.archive();
  const changes = [
    v => { v.header.files[0].path = '../../outside'; },
    v => { v.header.files[0].path = 'package/CON.txt'; },
    v => { v.header.files[0].path = 'runs/private.json'; },
    v => { v.header.files[0].path = 'programs/source/tmp/private.json'; },
    v => { v.header.files[0].path = v.header.files[1].path.toUpperCase(); },
    v => { v.header.files[0].path = 'hub/log'; v.header.files[1].path = 'hub/log/child'; },
    v => { v.header.files.push({ path: 'programs/undeclared/data.json', bytes: 2, sha256: sha(Buffer.from('{}')) }); v.bodies.push(Buffer.from('{}')); },
  ];
  for (const change of changes) {
    const file = await altered(app, snapshot.destination, change); await assert.rejects(inspectBackup(file));
    await assert.rejects(restoreInstance({ root: app.root, instanceId: 'unsafe', backup: file, ...environment }));
    assert.equal(await exists(join(app.root, 'instances/unsafe')), false);
  }
  assert.equal(await exists(join(app.directory, 'outside')), false);
});

test('MAINTENANCE-07 platform and Hub version compatibility are checked before creating restored instances', options, async t => {
  const app = await workspace(t), snapshot = await app.archive();
  for (const kind of ['platform', 'hubVersion']) {
    const file = await altered(app, snapshot.destination, v => {
      const index = v.header.files.findIndex(f => f.path === 'package/pack.lock'), lock = JSON.parse(v.bodies[index]);
      if (kind === 'platform') { v.header.platform = { os: 'unsupported', arch: 'unknown' }; lock.platform = v.header.platform; }
      else { v.header.hubVersion = '999.0.0'; lock.hubVersion = v.header.hubVersion; }
      const body = Buffer.from(JSON.stringify(lock)); v.bodies[index] = body; v.header.files[index].bytes = body.length; v.header.files[index].sha256 = sha(body);
    });
    const plan = await inspectBackup(file); assert.equal(plan.compatible, false); assert.equal(plan.incompatibilities.length, 1);
    await assert.rejects(restoreInstance({ root: app.root, instanceId: kind.toLowerCase(), backup: file, ...environment }), { code: 'BACKUP_INCOMPATIBLE' });
    assert.equal(await exists(join(app.root, 'instances', kind.toLowerCase())), false);
  }
});

test('MAINTENANCE-08 inspected hash, chosen environment and fresh destination are mandatory restore boundaries', options, async t => {
  const app = await workspace(t), snapshot = await app.archive();
  await assert.rejects(restoreInstance({ root: app.root, instanceId: 'wronghash', backup: snapshot.destination, expectedSha256: '0'.repeat(64), ...environment }), { code: 'BACKUP_CHANGED' });
  assert.equal(await exists(join(app.root, 'instances/wronghash')), false);
  await assert.rejects(restoreInstance({ root: app.root, instanceId: 'badenv', backup: snapshot.destination, nodePath: join(app.directory, 'missing-node'), pythonPath: environment.pythonPath }));
  assert.equal(await exists(join(app.root, 'instances/badenv')), false, 'Failed restore cleans only its newly-created ordinary directory');
  const identity = await readFile(join(app.imported.stateDir, 'instance.json'));
  await assert.rejects(restoreInstance({ root: app.root, instanceId: 'original', backup: snapshot.destination, ...environment }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(app.imported.stateDir, 'instance.json')), identity);
});

test('MAINTENANCE-09 links are rejected and private program-owned opaque data is retained without pretending to sanitize secrets', options, async t => {
  const app = await workspace(t), source = join(app.imported.stateDir, 'programs/source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'program-secret.txt'), 'private-provider-owned-value');
  const target = join(app.directory, 'external'); await mkdir(target); await writeFile(join(target, 'private.txt'), 'outside');
  const link = join(source, 'linked');
  try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit link creation'); return; } throw error; }
  await assert.rejects(app.archive(), { code: 'BACKUP_PATH' }); await assert.rejects(storageInstance({ root: app.root, instanceId: 'original' }));
  await unlink(link);
  const snapshot = await app.archive(), checked = await inspectBackup(snapshot.destination);
  assert.equal(checked.mayIncludeApplicationSecrets, true);
  const restored = await restoreInstance({ root: app.root, instanceId: 'opaque', backup: snapshot.destination, ...environment });
  assert.equal(await readFile(join(restored.stateDir, 'programs/source/program-secret.txt'), 'utf8'), 'private-provider-owned-value');
  assert.equal(await exists(join(restored.stateDir, 'programs/source/linked')), false);
});

test('MAINTENANCE-10 cancellation during real backup and restore copies cleans only the owned incomplete destination', options, async t => {
  const app = await workspace(t), source = join(app.imported.stateDir, 'programs/source');
  await mkdir(source, { recursive: true });
  const payload = join(source, 'bulk.bin'), block = Buffer.alloc(1024 * 1024, 77), output = await open(payload, 'wx');
  try { for (let i = 0; i < 64; i++) await output.write(block); } finally { await output.close(); }
  async function abortWhenPresent(path, controller) {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (await exists(path)) { controller.abort(); return; }
      await new Promise(done => setTimeout(done, 2));
    }
    throw new Error('The copy destination was never created');
  }
  const destination = join(app.directory, 'cancelled.whbackup'), backupController = new AbortController();
  const backup = backupInstance({ root: app.root, instanceId: 'original', destination, signal: backupController.signal, ...environment });
  const rejection = assert.rejects(backup, { code: 'MAINTENANCE_ABORTED' });
  await abortWhenPresent(destination, backupController); await rejection;
  assert.equal(await exists(destination), false); assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
  assert.equal((await lstat(payload)).size, 64 * 1024 * 1024);
  const snapshot = await app.archive(), restoreController = new AbortController(), stateDir = join(app.root, 'instances/cancelled');
  const restore = restoreInstance({ root: app.root, instanceId: 'cancelled', backup: snapshot.destination, signal: restoreController.signal, ...environment });
  const restoreRejection = assert.rejects(restore, { code: 'MAINTENANCE_ABORTED' });
  await abortWhenPresent(stateDir, restoreController); await restoreRejection;
  assert.equal(await exists(stateDir), false); assert.equal(await exists(snapshot.destination), true);
  assert.equal(await exists(app.imported.stateDir), true);
});

test('MAINTENANCE-11 source and untrusted header file-size limits stop before unbounded allocation or extraction', options, async t => {
  const app = await workspace(t), snapshot = await app.archive(), source = join(app.imported.stateDir, 'programs/source');
  await mkdir(source, { recursive: true });
  const oversized = join(source, 'oversized.bin'); await writeFile(oversized, ''); await truncate(oversized, backupLimits.fileBytes + 1);
  await assert.rejects(app.archive(), { code: 'BACKUP_LIMIT' });
  assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
  const invalid = await altered(app, snapshot.destination, archive => { archive.header.files[0].bytes = backupLimits.fileBytes + 1; });
  await assert.rejects(inspectBackup(invalid), { code: 'BACKUP_LIMIT' });
  await assert.rejects(restoreInstance({ root: app.root, instanceId: 'oversized', backup: invalid, ...environment }), { code: 'BACKUP_LIMIT' });
  assert.equal(await exists(join(app.root, 'instances/oversized')), false);
});

test('MAINTENANCE-12 missing status with historical run or control artifacts never becomes a never-started backup or uninstall', options, async t => {
  const app = await workspace(t), session = await app.start('original', app.imported.digest);
  await session.close();
  assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false);
  await unlink(join(app.imported.stateDir, 'status.json'));
  assert.ok((await readdir(join(app.imported.stateDir, 'runs'))).length > 0);
  await assert.rejects(app.archive(), { code: 'INSTANCE_NOT_STOPPED' });
  await assert.rejects(detachInstance({ root: app.root, instanceId: 'original' }), { code: 'INSTANCE_NOT_STOPPED' });
  await unlink(join(app.imported.stateDir, 'control.json'));
  await assert.rejects(app.archive(), { code: 'INSTANCE_NOT_STOPPED' });
  await assert.rejects(detachInstance({ root: app.root, instanceId: 'original' }), { code: 'INSTANCE_NOT_STOPPED' });
  const imported = await importPackage(app.pack, { root: app.root, instanceId: 'control-only', ...environment });
  await save(join(imported.stateDir, 'control.json'), { format: 'world-hub.runtime-control/v1', runId: 'unknown-run', url: 'http://127.0.0.1:1', token: 'not-live' });
  await assert.rejects(backupInstance({ root: app.root, instanceId: 'control-only', destination: join(app.directory, 'control-only.whbackup'), ...environment }), { code: 'INSTANCE_NOT_STOPPED' });
  await assert.rejects(detachInstance({ root: app.root, instanceId: 'control-only' }), { code: 'INSTANCE_NOT_STOPPED' });
  assert.equal(await exists(join(app.imported.stateDir, 'package')), true); assert.equal(await exists(join(imported.stateDir, 'package')), true);
  assert.equal(await exists(join(app.imported.stateDir, 'owner.lock')), false); assert.equal(await exists(join(imported.stateDir, 'owner.lock')), false);
});
