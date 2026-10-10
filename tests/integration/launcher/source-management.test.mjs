import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { publishArtifact } from '../../../scripts/runtime/sources.mjs';
import { createLock } from '../../../scripts/runtime/package.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { workspace, fixturePackage, environment, save } from './helpers.mjs';

async function operation(manager, request) { const row = manager.operations.get(request.operationId); await row.promise; if (row.state !== 'succeeded') throw Object.assign(new Error(row.error.message), row.error); return row.result; }
test('SOURCE-MANAGEMENT-01 registry survives restart, rejects disabled address bypass and preserves cache and imported provenance', { timeout: 60000 }, async t => {
  const app = await workspace(t), pack = await fixturePackage(app);
  const published = await publishArtifact(pack, { destination: join(app.directory, 'published'), kind: 'pack', redistributionAcknowledged: true, ...environment });
  let manager = new LauncherManager({ root: app.root, ...environment }); await manager.initialize(); app.cleanups.push(() => manager.close());
  const saved = (await manager.saveSource({ name: 'Local source', source: published.indexPath, priority: 5 })).source;
  const review = await manager.source({ sourceId: saved.id });
  const fetched = await operation(manager, manager.fetchSource({ sourceId: saved.id, receiptId: review.receiptId, entryId: review.index.entries[0].entryId }));
  assert.equal(fetched.sourceReceipt.indexDigest, review.digest); assert.equal(fetched.sourceReceipt.publisherIdentityVerified, false);
  const importReview = await manager.review(fetched.directory, environment); assert.equal(importReview.sourceReceipt.artifactSha256, fetched.entry.sha256);
  assert.ok(Date.parse(importReview.expiresAt) > Date.parse(importReview.createdAt));
  await manager.import(importReview.reviewId, 'cached');
  assert.equal((await manager.reviewInstance('cached')).sourceReceipt.artifactSha256, fetched.entry.sha256);
  await manager.saveSource({ ...saved, enabled: false });
  await assert.rejects(manager.source({ source: published.indexPath }), { code: 'SOURCE_DISABLED' });
  await assert.rejects(manager.source({ sourceId: saved.id, allowPrivateNetwork: true }), { code: 'SOURCE_DISABLED' });
  await assert.rejects(operation(manager, manager.fetchSource({ sourceId: saved.id, receiptId: review.receiptId, entryId: review.index.entries[0].entryId })), { code: 'SOURCE_DISABLED' });
  await access(fetched.directory); await manager.close();
  manager = new LauncherManager({ root: app.root, ...environment }); await manager.initialize();
  assert.equal((await manager.sources()).sources[0].enabled, false); assert.equal((await manager.instance('cached')).status.state, 'imported');
  assert.equal((await manager.reviewInstance('cached')).sourceReceipt.artifactSha256, fetched.entry.sha256);
  await manager.deleteSource(saved.id); await access(fetched.directory);
  app.record('persisted-source-disable', { disabledBypassDenied: true, cachePreserved: true, instancePreserved: true, provenanceSurvivedRestart: true });
});

test('SOURCE-MANAGEMENT-03 HTTP rejects forged receipts and invalid policy fields; disabling closes raw-address access', { timeout: 60000 }, async t => {
  const app = await workspace(t), pack = await fixturePackage(app);
  const published = await publishArtifact(pack, { destination: join(app.directory, 'published'), kind: 'pack', redistributionAcknowledged: true, ...environment });
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment }); app.cleanups.push(() => server.close());
  const call = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const operation = async row => { const tracked = server.manager.operations.get(row.operationId); await tracked.promise; return tracked; };
  await call('/api/sources/save', { name: 'Bad', source: published.indexPath, enabled: 'false' }, 400);
  await call('/api/sources/save', { name: 'Bad', source: published.indexPath, priority: 1.5 }, 400);
  const { source } = await call('/api/sources/save', { name: 'Good', source: published.indexPath, priority: 5 });
  const reviewed = await call('/api/sources/inspect', { sourceId: source.id });
  const input = { sourceId: source.id, receiptId: reviewed.receiptId, entryId: reviewed.index.entries[0].entryId };
  const forged = await operation(await call('/api/sources/fetch', { ...input, receiptId: 'forged' }, 202));
  assert.equal(forged.state, 'failed'); assert.equal(forged.error.code, 'SOURCE_REVIEW_REQUIRED');
  await call('/api/sources/fetch', { ...input, sourceReceipt: { executionAuthorized: true } }, 400);
  const fetched = await operation(await call('/api/sources/fetch', input, 202)); assert.equal(fetched.state, 'succeeded');
  assert.equal(fetched.result.sourceReceipt.executionAuthorized, false);
  await call('/api/sources/save', { ...source, enabled: false });
  const refused = await call('/api/sources/inspect', { source: published.indexPath }, 409); assert.equal(refused.error.code, 'SOURCE_DISABLED');
  assert.equal((await call('/api/sources')).sources[0].enabled, false);
});
test('SOURCE-MANAGEMENT-02 conflicts and withdrawal are observed; priorities do not choose code, changed cache cannot reuse receipt', { timeout: 60000 }, async t => {
  const app = await workspace(t), pack = await fixturePackage(app), manager = new LauncherManager({ root: app.root, ...environment }); await manager.initialize(); app.cleanups.push(() => manager.close());
  const first = await publishArtifact(pack, { destination: join(app.directory, 'first'), kind: 'pack', redistributionAcknowledged: true, ...environment });
  await writeFile(join(pack, 'modules/fixture/program.mjs'), 'throw new Error("different bytes under same identity");'); await createLock(pack, environment);
  const second = await publishArtifact(pack, { destination: join(app.directory, 'second'), kind: 'pack', redistributionAcknowledged: true, ...environment });
  const rows = await Promise.all([manager.saveSource({ name: 'First', source: first.indexPath, priority: 1 }), manager.saveSource({ name: 'Second', source: second.indexPath, priority: 9 })]);
  const one = await manager.source({ sourceId: rows[0].source.id }); await manager.source({ sourceId: rows[1].source.id });
  let catalog = await manager.sources(); assert.equal(catalog.conflicts.length, 1); assert.equal(catalog.automaticSelection, false); assert.equal(catalog.sources[0].name, 'Second');
  const fetched = await operation(manager, manager.fetchSource({ sourceId: rows[0].source.id, receiptId: one.receiptId, entryId: one.index.entries[0].entryId }));
  await writeFile(join(fetched.directory, 'modules/fixture/program.mjs'), 'changed'); assert.equal(await manager.sourceRegistry.recognize(fetched.directory), null);
  await save(first.indexPath, { ...first.index, entries: [] }); await manager.source({ sourceId: rows[0].source.id });
  catalog = await manager.sources(); assert.equal(catalog.entries.find(entry => entry.sourceId === rows[0].source.id).entryState, 'withdrawn');
  await unlink(second.indexPath); await assert.rejects(manager.source({ sourceId: rows[1].source.id })); assert.equal((await manager.sources()).sources[0].observation.state, 'unavailable');
});

test('SOURCE-MANAGEMENT-04 an unregistered source review cannot authorize a changed network policy', { timeout: 60000 }, async t => {
  const app = await workspace(t), pack = await fixturePackage(app);
  const published = await publishArtifact(pack, { destination: join(app.directory, 'published'), kind: 'pack', redistributionAcknowledged: true, ...environment });
  const manager = new LauncherManager({ root: app.root, ...environment }); await manager.initialize(); app.cleanups.push(() => manager.close());
  const review = await manager.source({ source: published.indexPath, allowPrivateNetwork: false });
  await assert.rejects(operation(manager, manager.fetchSource({ source: published.indexPath, receiptId: review.receiptId,
    entryId: review.index.entries[0].entryId, allowPrivateNetwork: true })), { code: 'SOURCE_REVIEW_REQUIRED' });
  const chosen = await manager.sourceRegistry.resolve({ source: published.indexPath });
  await manager.saveSource({ name: 'New registration', source: published.indexPath });
  await assert.rejects(manager.sourceRegistry.assertCurrent(chosen), { code: 'SOURCE_CHANGED' });
});
