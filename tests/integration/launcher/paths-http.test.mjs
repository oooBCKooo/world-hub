import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, truncate, rm } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { discoveryLimits } from '../../../tools/launcher/paths-service.mjs';
import { environment, workspace, until } from './helpers.mjs';

async function launcher(app) {
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment }); app.cleanups.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' };
  const request = async (path, body, overrides) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: overrides ?? headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const call = async (path, body) => { const response = await request(path, body); assert.ok(response.status < 400, JSON.stringify(response)); return response.body; };
  const wait = async operationId => until(async () => { const { operation } = await call(`/api/operations/${operationId}`); return operation.state === 'running' ? false : operation; });
  return { server, headers, call, request, wait };
}
const save = (path, value) => writeFile(path, JSON.stringify(value));

test('PATHS-HTTP-01 authenticated bounded browsing selects Unicode directories and files without following links or reading large archives', async t => {
  const app = await workspace(t), api = await launcher(app), collection = join(app.directory, '项目 空格'); await mkdir(collection);
  const pack = join(collection, '整合 包'), module = join(collection, '候选 模块'); await mkdir(pack); await mkdir(module);
  await save(join(pack, 'pack.json'), { format: 'world-hub.pack/v1', id: 'demo.unlocked', version: '1.0.0' });
  await save(join(module, 'module.json'), { format: 'world-hub.module/v1', id: 'demo.module', version: '1.0.0' });
  const backup = join(collection, 'private.whbackup'); await writeFile(backup, 'not parsed'); await truncate(backup, 512 * 1024 * 1024);
  const source = join(collection, 'index.json'); await save(source, { format: 'world-hub.source-index/v1', id: 'demo.source', entries: [] });
  const outside = join(app.directory, 'outside'), linked = join(collection, 'linked'); await mkdir(outside);
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (let index = 0; index < 105; index++) await writeFile(join(collection, `item-${index}.txt`), 'x');
  const unauthenticated = await api.request('/api/paths/known', undefined, {}); assert.equal(unauthenticated.status, 401);
  const noCsrf = await api.request('/api/paths/browse', { directory: collection }, { authorization: api.headers.authorization, 'content-type': 'application/json' }); assert.equal(noCsrf.status, 403);
  const wrongOrigin = await api.request('/api/paths/browse', { directory: collection }, { ...api.headers, origin: 'https://example.com' }); assert.equal(wrongOrigin.status, 403);
  const first = await api.call('/api/paths/browse', { directory: collection, purpose: 'pack' });
  assert.equal(first.entries.length, 100); assert.equal(first.truncated, true); assert.equal(first.nextOffset, 100);
  const second = await api.call('/api/paths/browse', { directory: collection, purpose: 'pack', offset: first.nextOffset });
  const entries = [...first.entries, ...second.entries]; assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length);
  assert.equal(entries.find(entry => entry.path === linked).kind, 'blocked'); assert.equal(entries.find(entry => entry.path === linked).selectable, false);
  assert.deepEqual(entries.find(entry => entry.path === pack).object.warnings, ['PACK_LOCK_MISSING']);
  assert.equal(entries.find(entry => entry.path === pack).selectable, true); assert.equal(entries.find(entry => entry.path === backup).selectable, false);
  assert.ok((await api.request('/api/paths/browse', { directory: linked })).status >= 400);
  const chosen = await api.call('/api/paths/check', { path: backup, purpose: 'backup' }); assert.equal(chosen.selectable, true); assert.equal(chosen.object.checked, false);
  assert.equal((await api.call('/api/paths/check', { path: source, purpose: 'source' })).object.kind, 'source');
  assert.equal((await api.call('/api/paths/check', { path: join(collection, 'new pack'), purpose: 'save-directory' })).selectable, true);
  assert.equal((await api.call('/api/paths/check', { path: pack, purpose: 'save-directory' })).selectable, false);
  assert.equal((await api.call('/api/paths/check', { path: join(collection, 'missing-parent', 'new'), purpose: 'save-file' })).parentExists, false);
  if (process.platform === 'win32') for (const name of ['CON', 'aux.json', 'CONIN$', 'LPT1.txt', 'new:name', 'ending.', 'ending ', 'a*b', 'a?b', 'a|b', 'a<b', 'a>b', 'a"b', 'nested:name/new']) {
    const invalid = await api.request('/api/paths/check', { path: join(collection, name), purpose: 'save-file' }); assert.equal(invalid.status, 400, name); assert.equal(invalid.body.error.code, 'PATH_NAME_INVALID', name);
    const invalidDirectory = await api.request('/api/paths/check', { path: join(collection, name), purpose: 'save-directory' }); assert.equal(invalidDirectory.status, 400, name);
  }
  await api.call('/api/paths/remember', { path: pack, purpose: 'pack' }); await api.call('/api/paths/remember', { path: pack, purpose: 'pack' });
  const known = await api.call('/api/paths/known'); assert.equal(known.recents.length, 1); assert.ok(known.objects.some(object => object.id === 'demo.unlocked'));
  assert.equal(known.startsModules, false); assert.deepEqual(api.server.manager.sessions.size, 0);
  const cached = join(app.root, 'source-cache', 'c'.repeat(64)); await mkdir(cached, { recursive: true });
  await save(join(cached, 'pack.json'), { format: 'world-hub.pack/v1', id: 'demo.cached', version: '1.0.0' });
  await api.server.close(); const restarted = await launcher(app), recovered = await restarted.call('/api/paths/known'); assert.equal(recovered.recents[0].path, pack);
  const cachedObject = recovered.objects.find(object => object.id === 'demo.cached'); assert.equal(cachedObject.origin, 'cache'); assert.equal(cachedObject.checked, false); assert.equal(cachedObject.requiresReview, true);
  app.record('bounded-directory-and-file-choice', { pages: 2, missingLockRecognized: true, linksBlocked: true, archiveBytes: 512 * 1024 * 1024, recentsSurviveRestart: true });
});

test('PATHS-HTTP-02 discovery is bounded, cancellable, task-listed and never scans whole roots or generated directories', async t => {
  const app = await workspace(t), api = await launcher(app), directory = join(app.directory, 'discovery'); await mkdir(directory);
  await save(join(directory, 'pack.json'), { format: 'world-hub.pack/v1', id: 'demo.discovery', version: '1.0.0' });
  let deep = directory; for (let index = 0; index < 6; index++) { deep = join(deep, 'deep'); await mkdir(deep); }
  await save(join(deep, 'module.json'), { format: 'world-hub.module/v1', id: 'demo.too-deep' });
  const generated = join(directory, 'node_modules'); await mkdir(generated); await save(join(generated, 'module.json'), { format: 'world-hub.module/v1', id: 'demo.generated' });
  const oversized = join(directory, 'oversized'); await mkdir(oversized); await writeFile(join(oversized, 'module.json'), ' '.repeat(discoveryLimits.declarationBytes + 1));
  const started = await api.call('/api/paths/discover', { directory }), operation = await api.wait(started.operationId);
  assert.equal(operation.state, 'succeeded'); assert.ok(operation.result.objects.some(object => object.id === 'demo.discovery'));
  assert.equal(operation.result.objects.some(object => ['demo.too-deep', 'demo.generated'].includes(object.id)), false);
  assert.ok(operation.result.objects.some(object => object.warnings.includes('DECLARATION_TOO_LARGE')));
  assert.equal(operation.result.partial, true); assert.equal(operation.result.startsModules, false);
  assert.ok(operation.result.scannedEntries <= discoveryLimits.entries); assert.ok(operation.result.scannedDirectories <= discoveryLimits.directories);
  assert.ok((await api.call('/api/operations')).operations.some(item => item.id === started.operationId && item.result.directory === directory));
  const rootScan = await api.call('/api/paths/discover', { directory: parse(directory).root }); assert.equal((await api.wait(rootScan.operationId)).error.code, 'SCAN_ROOT_REFUSED');
  const aborted = new AbortController(); aborted.abort(); const cancelled = await api.server.manager.paths.discover({ directory }, aborted.signal);
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.partial, true); assert.equal(cancelled.scannedEntries, 0);
  const large = join(directory, 'large'); await mkdir(large); for (let index = 0; index < discoveryLimits.entries + 10; index++) await writeFile(join(large, String(index)), '');
  const bounded = await api.server.manager.paths.discover({ directory: large }); assert.equal(bounded.partial, true); assert.ok(bounded.scannedEntries <= discoveryLimits.entries);
  const cancellable = join(app.directory, 'cancellable'); await mkdir(cancellable);
  for (let index = 0; index < 128; index++) { const module = join(cancellable, String(index)); await mkdir(module); await save(join(module, 'module.json'), { format: 'world-hub.module/v1', id: `demo.cancel.${index}` }); }
  const pending = await api.call('/api/paths/discover', { directory: cancellable });
  const requested = await api.call(`/api/operations/${pending.operationId}/cancel`, {}); assert.ok(requested.operation.cancelRequestedAt);
  const terminal = await api.wait(pending.operationId); assert.equal(terminal.result.cancelled, true); assert.equal(terminal.result.partial, true);
  assert.ok(terminal.result.objects.length < 128); assert.ok((await api.call('/api/operations')).operations.some(item => item.id === pending.operationId && item.result.cancelled));
  app.record('bounded-discovery-tasks', { partial: operation.result.partial, generatedSkipped: true, cancelledPartial: true, boundedEntries: bounded.scannedEntries, httpCancellation: true });
});

test('PATHS-HTTP-03 static module counts survive browser refresh and become unknown when declaration is unavailable', async t => {
  const app = await workspace(t), api = await launcher(app), packageDirectory = join(app.root, 'instances', 'static', 'package'); await mkdir(packageDirectory, { recursive: true });
  await save(join(packageDirectory, 'pack.json'), { format: 'world-hub.pack/v1', components: [{ id: 'a', module: 'demo.a' }, { id: 'b', module: 'demo.b' }, { id: 'c', module: 'demo.c' }] });
  api.server.manager.records.set('static', { instanceId: 'static', root: app.root, environment, pack: { id: 'demo.static', version: '1.0.0' } }); await api.server.manager.save();
  assert.equal((await api.call('/api/instances')).instances[0].moduleCount, 3); assert.equal((await api.call('/api/instances/static')).instance.moduleCount, 3);
  await api.server.close(); const restarted = await launcher(app); assert.equal((await restarted.call('/api/instances')).instances[0].moduleCount, 3);
  await rm(join(packageDirectory, 'pack.json')); assert.equal((await restarted.call('/api/instances')).instances[0].moduleCount, null);
  app.record('static-declaration-count', { count: 3, survivesRestart: true, unavailableCount: null });
});

test('PATHS-HTTP-04 private Creator drafts survive restart with no review authority and strict bounds', async t => {
  const app = await workspace(t), api = await launcher(app), source = join(app.directory, 'draft source'); await mkdir(source);
  const draft = { format: 'world-hub.creator-draft/v1', directory: source, baseRevision: 'a'.repeat(64),
    pack: { format: 'world-hub.pack/v1', components: [{ id: 'module', settings: { token: 'private business setting' } }] },
    replacements: [{ componentId: 'module', moduleDirectory: join(source, 'not-yet-present') }], formValues: { author: '作者', target: join(app.directory, 'new pack') }, selection: 'module', updatedAt: new Date().toISOString() };
  const saved = await api.call('/api/creator-drafts/save', { draft }); assert.equal(saved.draft.pack.components[0].settings.token, 'private business setting');
  assert.equal((await api.request('/api/creator-drafts/save', { draft: { ...draft, reviewId: 'forbidden-authority' } })).body.error.code, 'DRAFT_INVALID');
  assert.equal((await api.request('/api/creator-drafts/save', { draft: { ...draft, formValues: { text: 'a'.repeat(32768) } } })).status, 413);
  await api.server.close(); const restarted = await launcher(app); assert.equal((await restarted.call('/api/creator-drafts')).drafts[0].selection, 'module');
  assert.equal(restarted.server.manager.reviews.size, 0); assert.equal(restarted.server.manager.sessions.size, 0);
  assert.equal((await restarted.request('/api/creator-drafts/delete', { directory: source }, { authorization: restarted.headers.authorization, 'content-type': 'application/json' })).status, 403);
  await restarted.call('/api/creator-drafts/delete', { directory: source }); assert.equal((await restarted.call('/api/creator-drafts')).drafts.length, 0);
  app.record('private-draft-restoration', { retainsProgramSettings: true, refreshedAuthorizationRequired: true, requestBound: 32768, deletion: true });
});
