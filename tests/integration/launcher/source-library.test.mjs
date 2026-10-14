import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { createLock } from '../../../scripts/runtime/package.mjs';
import { createTemplate } from '../../../scripts/runtime/template.mjs';
import { publishArtifact } from '../../../scripts/runtime/sources.mjs';
import { knownLimits } from '../../../tools/launcher/paths-service.mjs';
import { workspace, fixturePackage, environment, until } from './helpers.mjs';

async function launcher(app) {
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close());
  const call = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30000),
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const finish = async (request, expected = 'succeeded') => until(async () => {
    const { operation } = await call('/api/operations/' + request.operationId);
    if (operation.state === 'running') return null;
    assert.equal(operation.state, expected, JSON.stringify(operation)); return operation;
  }, { label: 'verified resource download' });
  const fetchPublication = async (publication, expected) => {
    const reviewed = await call('/api/sources/inspect', { source: publication.indexPath });
    return finish(await call('/api/sources/fetch', { source: publication.indexPath, receiptId: reviewed.receiptId, entryId: reviewed.index.entries[0].entryId }, 202), expected);
  };
  return { server, call, finish, fetchPublication };
}
async function publication(app, kind) {
  const pack = await fixturePackage(app), module = join(pack, 'modules/fixture'), marker = join(app.directory, 'MODULE_MUST_NOT_EXECUTE');
  await writeFile(join(module, 'program.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('Library downloads never execute module code');\n`);
  await createLock(pack, environment);
  let directory = module;
  if (kind === 'template') {
    directory = join(app.directory, 'source-template');
    await createTemplate(pack, { destination: directory, redistributionAcknowledged: true,
      template: { format: 'world-hub.template/v1', id: 'library.template', version: '1.0.0', title: 'Downloaded template', license: 'MIT', base: 'base', parameters: [] } });
  }
  const output = await publishArtifact(directory, { kind, destination: join(app.directory, 'publication-' + kind), redistributionAcknowledged: true, ...environment });
  return { ...output, marker };
}

test('verified module and template downloads immediately enter persistent libraries ahead of bounded discovery scans', { timeout: 90000 }, async t => {
  const app = await workspace(t), api = await launcher(app), fetched = [];
  for (const kind of ['module', 'template']) {
    const published = await publication(app, kind), first = (await api.fetchPublication(published)).result;
    assert.equal(first.kind, kind); assert.ok(first.id); assert.equal(first.version, '1.0.0'); assert.ok(first.title);
    assert.equal(first.libraryRegistered, true); assert.equal(first.startsModules, false);
    if (kind === 'module') assert.equal(first.runtime.kind, 'node');
    const known = await api.call('/api/paths/known');
    assert.ok(known.objects.some(object => object.kind === kind && object.path === first.directory && object.id === first.id && object.libraryRegistered));
    const repeated = (await api.fetchPublication(published)).result;
    assert.equal(repeated.cached, true); assert.equal(repeated.directory, first.directory);
    assert.equal(api.server.manager.paths.library.filter(row => row.path === first.directory).length, 1);
    await assert.rejects(access(published.marker), { code: 'ENOENT' }); fetched.push(first);
  }
  // Ordinary path history does not evict a downloaded module or template.
  for (let index = 0; index < 33; index++) {
    const path = join(app.directory, 'chosen-' + index); await mkdir(path);
    await api.call('/api/paths/remember', { path, purpose: 'directory' });
  }
  assert.ok(fetched.every(item => !api.server.manager.paths.recents.some(row => row.path === item.directory)));
  await api.server.close(); const restarted = await launcher(app);
  const noisy = join(app.directory, 'noisy'), modules = join(noisy, 'modules'); await mkdir(modules, { recursive: true });
  for (let index = 0; index < knownLimits.entries + 20; index++) await writeFile(join(modules, index + '.noise'), '');
  restarted.server.manager.defaults.packDirectory = noisy;
  const recovered = await restarted.call('/api/paths/known');
  assert.equal(recovered.partial, true); assert.ok(recovered.scannedEntries <= knownLimits.entries);
  for (const first of fetched) {
    assert.equal(recovered.objects.filter(object => object.path === first.directory).length, 1);
    assert.ok(recovered.objects.findIndex(object => object.path === first.directory) < 2, 'Registered downloads precede opportunistic enumeration');
  }
  assert.equal((await restarted.call('/api/instances')).instances.length, 0);
  await assert.rejects(access(join(app.root, 'instances')), { code: 'ENOENT' });
  assert.equal(restarted.server.manager.hub, null);
  app.record('downloads-enter-library-without-execution', { downloaded: fetched.map(item => ({ kind: item.kind, id: item.id, version: item.version })), persistentAfterRestart: true, priorityBeforeFullScan: true, duplicateCacheEntry: false });
});

test('failed content verification creates no successful library registration', { timeout: 30000 }, async t => {
  const app = await workspace(t), api = await launcher(app), published = await publication(app, 'module');
  await writeFile(published.artifactPath, (await readFile(published.artifactPath, 'utf8')) + ' ');
  const failed = await api.fetchPublication(published, 'failed');
  assert.match(failed.error.message, /Downloaded artifact hash mismatch/);
  assert.deepEqual(api.server.manager.paths.library, []); assert.deepEqual(api.server.manager.paths.recents, []);
  assert.equal((await api.call('/api/paths/known')).objects.some(object => object.origin === 'cache' && object.kind === 'module'), false);
  await assert.rejects(access(published.marker), { code: 'ENOENT' });
});

test('a full downloaded-resource library rejects a new registration without evicting existing entries', { timeout: 30000 }, async t => {
  const app = await workspace(t), api = await launcher(app), published = await publication(app, 'module');
  const existing = Array.from({ length: knownLimits.objects }, (_, index) => ({ path: join(app.directory, 'kept-' + index), purpose: 'module', usedAt: new Date().toISOString() }));
  api.server.manager.paths.library = existing;
  const failed = await api.fetchPublication(published, 'failed');
  assert.equal(failed.error.code, 'PATH_LIBRARY_FULL');
  assert.deepEqual(api.server.manager.paths.library, existing); assert.deepEqual(api.server.manager.paths.recents, []);
  assert.equal(failed.result, undefined);
});

test('a failed persistent-library save cannot report registration success or change the in-memory library', { timeout: 30000 }, async t => {
  const app = await workspace(t), api = await launcher(app), published = await publication(app, 'module');
  await mkdir(join(app.root, 'launcher-paths.json'));
  const failed = await api.fetchPublication(published, 'failed');
  assert.ok(failed.error); assert.equal(failed.result, undefined);
  assert.deepEqual(api.server.manager.paths.library, []); assert.deepEqual(api.server.manager.paths.recents, []);
});
