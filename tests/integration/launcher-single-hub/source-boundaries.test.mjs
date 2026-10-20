import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { publishArtifact, readSourceIndex, fetchSourceArtifact, validateSourceIndex } from '../../../scripts/runtime/sources.mjs';
import { collectFiles } from '../../../scripts/runtime/paths.mjs';
import { sameSourceArtifact } from '../../../tools/launcher/public/app.mjs';
import { workspace, ROOT } from '../launcher/helpers.mjs';

async function publication(t) {
  const app = await workspace(t), output = join(app.directory, 'publication');
  const published = await publishArtifact(join(ROOT, 'examples/ecosystem-pack/modules/source'), { kind: 'module', destination: output, redistributionAcknowledged: true });
  const inspected = await readSourceIndex(published.indexPath), entry = inspected.index.entries[0], options = { cacheRoot: join(app.root, 'source-cache') };
  return { app, published, inspected, entry, options };
}
async function http(t) {
  const value = await publication(t); let server = await createLauncherServer({ root: value.app.root });
  value.app.cleanups.push(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: {
      authorization: 'Bearer ' + server.token, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': server.csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  const finish = async response => {
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const operation = server.manager.operations.get(response.body.operationId); await operation.promise;
    return server.manager.operation(response.body.operationId);
  };
  const saved = await call('/api/sources/save', { name: 'Bound local source', source: value.published.indexPath });
  assert.equal(saved.status, 200); const sourceId = saved.body.source.id;
  return { ...value, call, finish, sourceId, server: () => server, restart: async () => { await server.close(); server = await createLauncherServer({ root: value.app.root }); } };
}

test('offline artifact cache is bound to exact source, index bytes, network policy and current index pin', async t => {
  const { published, inspected, entry, options, app } = await publication(t);
  const online = await fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, options);
  const files = await collectFiles(online.directory);
  await rename(published.indexPath, published.indexPath + '.offline');
  const offline = await fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, options);
  assert.equal(offline.offline, true); assert.equal(offline.cached, true); assert.equal(offline.startsModules, false);
  assert.equal(offline.requiresExecutionReview, true); assert.equal(offline.publisherEvidence.executionAuthorized, false);
  assert.deepEqual(await collectFiles(offline.directory), files);
  await assert.rejects(fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, { ...options, allowPrivateNetwork: true }), /network policy/i);
  await assert.rejects(fetchSourceArtifact(join(app.directory, 'other-source.json'), inspected.digest, entry.entryId, options), /reviewed source/i);
  await assert.rejects(fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, { ...options, expectedSha256: 'f'.repeat(64) }), /pin|hash|digest/i);
  const indexCache = join(options.cacheRoot, `index-${inspected.digest}.json`), before = await readFile(indexCache);
  const changed = JSON.parse(before); changed.indexBase64 = Buffer.from('{}').toString('base64'); await writeFile(indexCache, JSON.stringify(changed));
  await assert.rejects(fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, options), /index hash mismatch/i);
});

test('offline and cache-only acquisition never retrieve an uncached artifact or accept altered cache material', async t => {
  const { published, inspected, entry, options } = await publication(t);
  await assert.rejects(fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, { ...options, cacheOnly: true }), /cache/i);
  const online = await fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, options);
  await rename(published.indexPath, published.indexPath + '.offline');
  const artifact = join(options.cacheRoot, `${entry.sha256}.artifact.json`), original = await readFile(artifact);
  await writeFile(artifact, Buffer.concat([original, Buffer.from('\n')]));
  await assert.rejects(fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, { ...options, cacheOnly: true }), /artifact hash mismatch/i);
  await writeFile(artifact, original);
  await writeFile(join(online.directory, 'program.mjs'), '\n// changed extracted contents\n', { flag: 'a' });
  await assert.rejects(fetchSourceArtifact(published.indexPath, inspected.digest, entry.entryId, { ...options, cacheOnly: true }), /content hash mismatch|file set changed/i);
});

test('after Launcher restart, observed offline modules receive a fresh acquisition receipt and cached bytes rejoin library without execution', async t => {
  const scene = await http(t), { call, finish, sourceId } = scene;
  let inspected = await call('/api/sources/inspect', { sourceId }); assert.equal(inspected.status, 200);
  const entry = inspected.body.index.entries[0], oldReceiptId = inspected.body.receiptId;
  let fetched = await finish(await call('/api/sources/fetch', { sourceId, receiptId: oldReceiptId, entryId: entry.entryId }));
  assert.equal(fetched.state, 'succeeded', JSON.stringify(fetched.error));
  const directory = fetched.result.directory, before = await collectFiles(directory);
  assert.equal((await call('/api/paths/forget', { path: directory, purpose: 'module' })).body.deletesFiles, false);
  assert.equal((await call('/api/paths/known')).body.objects.some(row => row.path === directory), false);
  await rename(scene.published.indexPath, scene.published.indexPath + '.offline'); await scene.restart();
  const stale = await finish(await call('/api/sources/fetch', { sourceId, receiptId: oldReceiptId, entryId: entry.entryId }));
  assert.equal(stale.state, 'failed'); assert.equal(stale.error.code, 'SOURCE_REVIEW_REQUIRED');
  inspected = await call('/api/sources/inspect', { sourceId }); assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(inspected.body.offline, true); assert.equal(inspected.body.cacheOnly, true); assert.notEqual(inspected.body.receiptId, oldReceiptId);
  const cachedEntry = inspected.body.index.entries.find(row => row.entryId === entry.entryId);
  assert.equal(cachedEntry.cached, true); assert.equal(cachedEntry.cachedVerified, false);
  fetched = await finish(await call('/api/sources/fetch', { sourceId, receiptId: inspected.body.receiptId, entryId: entry.entryId }));
  assert.equal(fetched.state, 'succeeded', JSON.stringify(fetched.error));
  assert.equal(fetched.result.cached, true); assert.equal(fetched.result.offline, true);
  assert.equal(fetched.result.sourceReceipt.integrityVerified, true); assert.equal(fetched.result.sourceReceipt.executionAuthorized, false);
  assert.equal(fetched.result.sourceReceipt.codeSafetyVerified, false); assert.deepEqual(await collectFiles(directory), before);
  assert.equal((await call('/api/paths/known')).body.objects.find(row => row.path === directory).libraryRegistered, true);
  assert.equal((await call('/api/programs')).body.programs.length, 0); assert.equal(scene.server().manager.hub, null);
});

test('offline source inspection rejects a changed pin, changed network policy and disabled source instead of reusing old authority', async t => {
  const scene = await http(t), { call, sourceId, finish } = scene;
  let inspected = await call('/api/sources/inspect', { sourceId }); const entry = inspected.body.index.entries[0];
  assert.equal((await finish(await call('/api/sources/fetch', { sourceId, receiptId: inspected.body.receiptId, entryId: entry.entryId }))).state, 'succeeded');
  await rename(scene.published.indexPath, scene.published.indexPath + '.offline');
  let source = (await call('/api/sources')).body.sources.find(row => row.id === sourceId);
  assert.equal((await call('/api/sources/save', { ...sourceRecord(source), expectedSha256: 'e'.repeat(64) })).status, 200);
  let result = await call('/api/sources/inspect', { sourceId }); assert.notEqual(result.status, 200, 'new pin cannot authorize an old observation');
  source = (await call('/api/sources')).body.sources.find(row => row.id === sourceId);
  assert.equal((await call('/api/sources/save', { ...sourceRecord(source), expectedSha256: '', allowPrivateNetwork: true })).status, 200);
  result = await call('/api/sources/inspect', { sourceId }); assert.notEqual(result.status, 200, 'changed network policy cannot reuse another policy cache');
  source = (await call('/api/sources')).body.sources.find(row => row.id === sourceId);
  assert.equal((await call('/api/sources/save', { ...sourceRecord(source), allowPrivateNetwork: false, enabled: false })).status, 200);
  result = await call('/api/sources/inspect', { sourceId }); assert.equal(result.body.error.code, 'SOURCE_DISABLED');
  assert.equal(scene.server().manager.hub, null);
});
function sourceRecord(row) { return Object.fromEntries(['id', 'name', 'source', 'enabled', 'priority', 'expectedSha256', 'allowPrivateNetwork', 'revision'].filter(key => row[key] !== undefined).map(key => [key, row[key]])); }

test('hiding one module reference preserves all bytes, other versions, installed instances and hidden status across restart and discovery', async t => {
  const scene = await http(t), { call, sourceId, finish, app } = scene;
  const inspected = await call('/api/sources/inspect', { sourceId }), entry = inspected.body.index.entries[0];
  const fetched = await finish(await call('/api/sources/fetch', { sourceId, receiptId: inspected.body.receiptId, entryId: entry.entryId }));
  assert.equal(fetched.state, 'succeeded'); const directory = fetched.result.directory, before = await collectFiles(directory);
  const other = join(app.directory, 'other-version'); await cp(directory, other, { recursive: true });
  // The registry returns canonical paths; Windows TEMP can use different case or an 8.3 name.
  const canonicalOther = await realpath(other);
  const manifestFile = join(other, 'module.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8')); manifest.version = '2.0.0'; await writeFile(manifestFile, JSON.stringify(manifest));
  assert.equal((await scene.server().manager.paths.remember({ path: other, purpose: 'module', library: true })).path, canonicalOther);
  const registration = await call('/api/programs/preview', { directory, programId: 'retained-instance' }); assert.equal(registration.status, 200);
  assert.equal((await call('/api/programs/register', { reviewId: registration.body.reviewId, accepted: true })).status, 200);
  const removed = await call('/api/paths/forget', { path: directory, purpose: 'module' });
  assert.deepEqual([removed.body.deletesFiles, removed.body.removesInstances], [false, false]);
  await scene.restart(); await scene.server().manager.paths.discover({ directory: join(app.root, 'source-cache') });
  const known = (await call('/api/paths/known')).body.objects;
  assert.equal(known.some(row => row.path === directory), false);
  assert.ok(known.some(row => row.path === canonicalOther && row.version === '2.0.0' && row.libraryRegistered === true));
  assert.deepEqual(await collectFiles(directory), before); assert.equal((await call('/api/programs')).body.programs[0].programId, 'retained-instance');
  assert.equal(scene.server().manager.hub, null);
});

test('mixed catalogs are readable but retired entries cannot be acquired, and private URLs never weaken into loopback access', async t => {
  const scene = await http(t), { call, sourceId, finish } = scene;
  const index = JSON.parse(await readFile(scene.published.indexPath, 'utf8')), module = index.entries[0];
  index.entries.push({ ...module, entryId: 'retired.pack', kind: 'pack', id: 'old.pack' }, { ...module, entryId: 'retired.template', kind: 'template', id: 'old.template' });
  await writeFile(scene.published.indexPath, JSON.stringify(index));
  const inspected = await call('/api/sources/inspect', { sourceId }); assert.equal(inspected.status, 200);
  for (const entryId of ['retired.pack', 'retired.template']) {
    const result = await finish(await call('/api/sources/fetch', { sourceId, receiptId: inspected.body.receiptId, entryId }));
    assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'MODULE_REQUIRED');
  }
  assert.equal(sameSourceArtifact(module, { ...module, kind: 'pack' }), false);
  for (const url of ['http://example.test/index.json', 'https://localhost/artifact', 'https://127.0.0.1/artifact', 'https://169.254.169.254/artifact', 'https://example.test:444/artifact']) {
    assert.throws(() => validateSourceIndex({ ...index, entries: [{ ...module, source: { url } }] }, { allowPrivateNetwork: true }), /HTTPS|local|private|ports/i, url);
  }
  assert.equal(scene.server().manager.hub, null);
});
