import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, lstat, unlink, open } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { PathsService, knownLimits, runPickerProcess, nativePickerEncoding } from '../../../tools/launcher/paths-service.mjs';
import { workspace, fixturePackage, environment, save, json } from './helpers.mjs';

async function imported(t, id = 'delete-safe') {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); app.cleanups.push(() => manager.close());
  const directory = await fixturePackage(app), review = await manager.review(directory, environment);
  await manager.import(review.reviewId, id);
  const instance = await manager.instance(id), data = join(instance.directory, 'private-important.txt');
  await writeFile(data, 'retain this application data 🌍');
  return { app, manager, instance, data };
}

test('G-01 deletion requires confirmed exits and preserves failed/stale/unknown owners and private data', async t => {
  const { manager, instance, data } = await imported(t), directory = instance.directory;
  await assert.rejects(manager.deleteInstance(instance.id, false), { code: 'TRUST_REQUIRED' });
  await save(join(directory, 'status.json'), { format: 'world-hub.runtime-status/v1', instanceId: instance.id,
    state: 'failed', runId: 'failed-run', components: [], cleanupIncomplete: true });
  await save(join(directory, 'owner.lock'), { nonce: 'foreign-owner', pid: 1 });
  await assert.rejects(manager.deleteInstance(instance.id, true), { code: 'INSTANCE_LOCKED' });
  assert.equal((await json(join(directory, 'owner.lock'))).nonce, 'foreign-owner');
  await unlink(join(directory, 'owner.lock'));
  await assert.rejects(manager.deleteInstance(instance.id, true), { code: 'INSTANCE_NOT_STOPPED' });
  await save(join(directory, 'status.json'), { format: 'world-hub.runtime-status/v1', instanceId: instance.id,
    state: 'unknown', runId: 'unknown-run', stoppedAt: new Date().toISOString(), components: [] });
  await assert.rejects(manager.deleteInstance(instance.id, true), { code: 'INSTANCE_NOT_STOPPED' });
  await unlink(join(directory, 'status.json')); await save(join(directory, 'control.json'), { runId: 'lost-run' });
  await assert.rejects(manager.deleteInstance(instance.id, true), { code: 'INSTANCE_NOT_STOPPED' });
  assert.equal(await readFile(data, 'utf8'), 'retain this application data 🌍');
  assert.equal(manager.records.has(instance.id), true);
  await assert.rejects(lstat(join(directory, 'owner.lock')), { code: 'ENOENT' });
  await save(join(directory, 'status.json'), { format: 'world-hub.runtime-status/v1', instanceId: instance.id,
    state: 'failed', runId: 'failed-but-cleaned', stoppedAt: new Date().toISOString(), cleanupIncomplete: false,
    components: [{ process: 'failed', exit: { code: 1, signal: null } }] });
  assert.equal((await manager.deleteInstance(instance.id, true)).deleted, true);
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  assert.equal(manager.records.has(instance.id), false);
});

test('G-01 deletion reserves busy before queue waits, blocks backup/start/stop and settles before shutdown', async t => {
  const { manager, instance, data } = await imported(t);
  let release; manager.registryQueue = new Promise(resolve => { release = resolve; });
  const pending = manager.deleteInstance(instance.id, true);
  assert.equal(manager.busy.get(instance.id).kind, 'delete');
  assert.throws(() => manager.backup(instance.id, join(manager.root, 'blocked.whbackup'), true), { code: 'INSTANCE_BUSY' });
  assert.throws(() => manager.stop(instance.id), { code: 'INSTANCE_BUSY' });
  const reviewed = await manager.reviewInstance(instance.id, environment);
  await assert.rejects(manager.start(instance.id, reviewed.reviewId, true), { code: 'INSTANCE_BUSY' });
  await assert.rejects(manager.cancelOperation(manager.busy.get(instance.id).id), { code: 'CANCEL_UNAVAILABLE' });
  assert.equal(await readFile(data, 'utf8'), 'retain this application data 🌍');
  release(); assert.equal((await pending).deleted, true);
  assert.equal(manager.busy.has(instance.id), false);

  const second = await imported(t, 'closing-delete');
  let unblock; second.manager.registryQueue = new Promise(resolve => { unblock = resolve; });
  const deleting = second.manager.deleteInstance(second.instance.id, true);
  const closing = second.manager.close(); unblock();
  await assert.rejects(deleting, { code: 'MAINTENANCE_ABORTED' }); await closing;
  assert.equal(await readFile(second.data, 'utf8'), 'retain this application data 🌍');
  assert.equal(second.manager.busy.size, 0);
});

test('G-01 interrupted deletion retains a locked quarantine and restart can explicitly complete cleanup', async t => {
  const { manager, instance, data } = await imported(t, 'retry-delete');
  const originalRemove = manager.removeDeletionDirectory;
  let retained;
  manager.removeDeletionDirectory = async directory => {
    retained = directory;
    await assert.rejects(lstat(instance.directory), { code: 'ENOENT' });
    await assert.rejects(open(join(instance.directory, 'owner.lock'), 'wx'), { code: 'ENOENT' }, 'An external owner cannot enter the old path during recursive removal');
    assert.equal((await json(join(directory, 'owner.lock'))).format, 'world-hub.maintenance-owner/v1');
    assert.equal(await readFile(join(directory, 'private-important.txt'), 'utf8'), 'retain this application data 🌍');
    throw Object.assign(new Error('Simulated transient cleanup denial'), { code: 'EPERM' });
  };
  await assert.rejects(manager.deleteInstance(instance.id, true), { code: 'DELETION_INCOMPLETE' });
  assert.equal((await manager.instance(instance.id)).deletionPending, true);
  assert.equal((await manager.instance(instance.id)).retainedDirectory, retained);
  await assert.rejects(manager.reviewInstance(instance.id), { code: 'DELETION_INCOMPLETE' });
  assert.equal(manager.busy.has(instance.id), false);
  manager.removeDeletionDirectory = originalRemove;
  await manager.close();
  const reopened = new LauncherManager({ root: manager.root, ...environment }); await reopened.initialize(); t.after(() => reopened.close());
  assert.equal((await reopened.instance(instance.id)).deletionPending, true);
  assert.equal((await json(join(manager.root, 'launcher-instances.json'))).instances[0].deletion.transactionId.length, 36);
  assert.equal((await reopened.deleteInstance(instance.id, true)).deleted, true);
  await assert.rejects(lstat(retained), { code: 'ENOENT' });
  await assert.rejects(lstat(data), { code: 'ENOENT' });
  assert.equal(reopened.records.has(instance.id), false);
});

test('G-01 Windows deletion accepts root case and available short-name aliases while rejecting other collections', { skip: process.platform !== 'win32' }, async t => {
  const app = await workspace(t), root = join(app.directory, 'MixedCaseLauncherRoot');
  await mkdir(root);
  const shortScript = "$ProgressPreference = 'SilentlyContinue'; $fso = New-Object -ComObject Scripting.FileSystemObject; [Console]::Out.Write($fso.GetFolder($env:WH_PATH_ALIAS_TEST).ShortPath)";
  let shortRoot;
  try {
    shortRoot = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(shortScript, 'utf16le').toString('base64')],
      { env: { ...process.env, WH_PATH_ALIAS_TEST: root }, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { t.diagnostic('8.3 root lookup is unavailable; root case is still exercised.'); }
  const aliases = [root.toLowerCase()];
  if (shortRoot && shortRoot.toLowerCase() !== root.toLowerCase()) aliases.push(shortRoot);
  else t.diagnostic('This volume has no distinct 8.3 root alias.');
  const source = await fixturePackage(app);
  for (const [index, alias] of aliases.entries()) {
    const manager = new LauncherManager({ root: alias, ...environment }); await manager.initialize();
    app.cleanups.push(() => manager.close());
    const id = `alias-${index}`, review = await manager.review(source, environment);
    await manager.import(review.reviewId, id);
    assert.equal((await manager.deleteInstance(id, true)).deleted, true);
    assert.equal(manager.records.has(id), false);
    await assert.rejects(lstat(join(root, 'instances', id)), { code: 'ENOENT' });
    const outside = join(app.directory, `.delete-outside-${index}`); await mkdir(outside);
    const privateFile = join(outside, 'private.txt'); await writeFile(privateFile, 'outside collection');
    await assert.rejects(manager.removeDeletionDirectory(outside), { code: 'DELETION_INCOMPLETE' });
    assert.equal(await readFile(privateFile, 'utf8'), 'outside collection');
    await manager.close();
  }
});

test('G-05 native helper uses UTF-8, bounds output/time and confirms child exit', { concurrency: false }, async () => {
  const children = new Set(), text = 'F:\\中文 空格\\模板 🌍';
  if (process.platform === 'win32') {
    const script = nativePickerEncoding + '\n[Console]::Out.Write($env:WH_PICKER_UTF8_TEST)';
    const result = await runPickerProcess('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, WH_PICKER_UTF8_TEST: text } }, { children });
    assert.equal(result, text);
  } else {
    assert.equal(await runPickerProcess(process.execPath, ['-e', 'process.stdout.write(process.env.WH_PICKER_UTF8_TEST)'],
      { env: { ...process.env, WH_PICKER_UTF8_TEST: text } }, { children }), text);
  }
  await assert.rejects(runPickerProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {}, { children, timeoutMs: 150 }), { code: 'NATIVE_PICK_TIMEOUT' });
  assert.equal(children.size, 0);
  await assert.rejects(runPickerProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(32768));setTimeout(() => {}, 60000)'], {}, { children }), { code: 'NATIVE_PICK_OUTPUT_LIMIT' });
  assert.equal(children.size, 0);
  assert.equal(await runPickerProcess(process.execPath, ['-e', 'process.exit(0)'], {}, { children }), null);
  assert.equal(children.size, 0);
});

test('G-13 save-file native selection returns an existing parent and leaves output naming/checking to the caller', { concurrency: false }, async t => {
  const app = await workspace(t); await mkdir(app.root);
  const service = new PathsService(app.root), previous = process.env.WH_NATIVE_PICK_RESULT;
  try {
    process.env.WH_NATIVE_PICK_RESULT = app.root;
    const picked = await service.nativePick({ purpose: 'save-file', initialPath: join(app.root, 'new backup.whbackup') });
    assert.equal(picked.selectionMode, 'parent'); assert.equal(picked.purpose, 'save-file');
    assert.equal(picked.path, app.root); assert.equal(picked.kind, 'directory'); assert.equal(picked.selectable, true);
    const destination = join(picked.path, '新的备份 🌍.whbackup'), checked = await service.check({ path: destination, purpose: 'save-file' });
    assert.equal(checked.selectable, true); assert.equal(checked.exists, false);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    process.env.WH_NATIVE_PICK_RESULT = '';
    assert.equal((await service.nativePick({ purpose: 'save-file' })).cancelled, true);
  } finally { if (previous === undefined) delete process.env.WH_NATIVE_PICK_RESULT; else process.env.WH_NATIVE_PICK_RESULT = previous; }
});

test('G-12/G-14 known candidates identify real absolute templates and stop enumeration at explicit bounds', async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); app.cleanups.push(() => manager.close());
  const { candidates } = await manager.builtinTemplates();
  const template = candidates.find(candidate => candidate.id === 'demo.text-template');
  assert.ok(template); assert.equal(isAbsolute(template.directory), true); assert.equal(template.origin, 'builtin');
  assert.equal(template.componentCount, 3); assert.deepEqual(template.runtimeKinds.sort(), ['node', 'python']);
  assert.equal(template.checked, false); assert.equal(template.startsModules, false);
  assert.equal((await manager.templateInspect({ directory: template.directory })).inspection.manifest.id, template.id);
  const modules = join(app.directory, 'modules'); await mkdir(modules);
  for (let index = 0; index < knownLimits.entries + 20; index++) await writeFile(join(modules, `${index}.not-a-module`), '');
  manager.defaults.packDirectory = app.directory;
  const known = await manager.paths.known(manager);
  assert.ok(known.objects.some(candidate => candidate.path === template.path));
  assert.equal(known.partial, true); assert.equal(known.truncated, true);
  assert.ok(known.scannedEntries <= knownLimits.entries); assert.ok(known.scannedDirectories <= knownLimits.directories);
  assert.ok(known.scannedEntries < knownLimits.entries + 20); assert.equal(known.objects.length <= knownLimits.objects, true);
});
