import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { workspace, ROOT, environment, expectedText } from './helpers.mjs';

async function register(manager, id, module, bindings = []) {
  const review = await manager.localPrograms.preview({ programId: id,
    directory: join(ROOT, 'examples/ecosystem-pack/modules', module), bindings });
  await manager.localPrograms.register({ reviewId: review.reviewId, accepted: true });
}
async function start(manager, id, owned) {
  const review = await manager.localPrograms.reviewStart(id);
  await manager.localPrograms.start(id, { reviewId: review.reviewId, accepted: true });
  owned.add(manager.hub); owned.add(manager.localPrograms.handles.get(id));
}
function updateInput(snapshot, version = '0.1.1') {
  const pack = structuredClone(snapshot.pack); pack.version = version;
  return { directory: snapshot.directory, pack, expectedRevision: snapshot.composition.revision };
}

test('updating an original global composition requires stopped programs, persists a bumped version and wiring across restart, and retains program identities and private state', { timeout: 90000 }, async t => {
  const app = await workspace(t); let manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); const owned = new Set();
  app.cleanups.push(() => { for (const handle of owned) assert.ok(handle.exit && !handle.cleanupIncomplete); });
  app.cleanups.push(() => manager.close());
  await register(manager, 'first-source', 'source'); await register(manager, 'second-source', 'source');
  await register(manager, 'statistics', 'stats');
  await register(manager, 'browser', 'desk', [{ providerId: 'first-source', contract: { id: 'text.read', version: '1.0.0' } },
    { providerId: 'statistics', contract: { id: 'text.statistics', version: '1.0.0' } }]);
  for (const id of manager.localPrograms.records.keys()) await start(manager, id, owned);
  const snapshot = await manager.programAssembly({ entry: 'browser' }), input = updateInput(snapshot);
  assert.equal(snapshot.composition.version, '0.1.0'); assert.equal(snapshot.pack.id, snapshot.composition.id);
  await assert.rejects(manager.programAssemblyPreview(input), { code: 'GLOBAL_ASSEMBLY_RUNNING' });
  for (const id of [...manager.localPrograms.records.keys()].reverse()) await manager.localPrograms.stop(id);
  const ids = [...manager.localPrograms.records.keys()];
  const identities = await Promise.all(ids.map(id => readFile(manager.localPrograms.path(id, 'identity.json'))));
  const sourceState = await readFile(manager.localPrograms.path('second-source', 'state/source.json'));
  const originalSource = await readFile(manager.localPrograms.path('second-source', 'module/program.mjs'));
  const settings = input.pack.components.find(component => component.id === 'second-source').settings;
  settings.text = 'Changed public default; existing private data belongs to the program.';
  input.pack.bindings.find(binding => binding.contract.id === 'text.read').from = 'second-source';
  const sourceComponent = input.pack.components.find(component => component.id === 'second-source');
  input.pack.topics[sourceComponent.topicAliases.source] = 'updated/independent/text';
  // A saved draft remains usable after Launcher restart, without an in-memory
  // issuance token and without silently accepting a changed registry baseline.
  await manager.close(); manager = new LauncherManager({ root: app.root, ...environment }); await manager.initialize();
  const preview = await manager.programAssemblyPreview(input);
  assert.equal(preview.review.beforeVersion, '0.1.0'); assert.equal(preview.review.afterVersion, '0.1.1');
  const result = await manager.programAssemblyApply({ reviewId: preview.reviewId, accepted: true });
  assert.equal(result.version, '0.1.1'); assert.equal(result.startsModules, false); assert.equal(manager.hub, null);
  assert.ok(result.programs.every(program => program.state === 'stopped'));
  assert.equal(manager.localPrograms.row('browser').bindings.find(binding => binding.contract.id === 'text.read').providerId, 'second-source');
  assert.equal(manager.localPrograms.row('second-source').settings.text, settings.text);
  assert.equal(manager.localPrograms.row('browser').topics.source, 'updated/independent/text');
  for (const [index, id] of ids.entries()) assert.deepEqual(await readFile(manager.localPrograms.path(id, 'identity.json')), identities[index]);
  assert.deepEqual(await readFile(manager.localPrograms.path('second-source', 'state/source.json')), sourceState);
  assert.deepEqual(await readFile(manager.localPrograms.path('second-source', 'module/program.mjs')), originalSource);
  await manager.close(); manager = new LauncherManager({ root: app.root, ...environment }); await manager.initialize();
  assert.equal(manager.localPrograms.assembly.version, '0.1.1');
  for (const id of manager.localPrograms.records.keys()) await start(manager, id, owned);
  const text = 'Reviewed original composition update 🌍\r\n';
  const response = await fetch(new URL('/analyze', manager.localPrograms.row('browser').entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.deepEqual(value.result.output, expectedText(text));
  assert.equal(JSON.parse(await readFile(manager.localPrograms.path('second-source', 'state/source.json'))).text, text);
  assert.notEqual(JSON.parse(await readFile(manager.localPrograms.path('first-source', 'state/source.json'))).text, text);
  assert.equal(JSON.parse(await readFile(join(snapshot.directory, 'pack.json'))).version, '0.1.0', 'Applying the original never rewrites its source snapshot');
  app.record('stopped-original-update-real-communication', { initialVersion: '0.1.0', appliedVersion: result.version,
    selectedProvider: 'second-source', restartPersists: true, identitiesAndPrivateStateRetained: true, receipts: value.result.receipts.length });
});

test('global composition update rejects stale/expired/unaccepted reviews, unchanged versions, module changes and source tampering', { timeout: 45000 }, async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); app.cleanups.push(() => manager.close());
  await register(manager, 'one', 'source'); const snapshot = await manager.programAssembly();
  for (const version of ['0.1.0', '0.0.9', '0.1.1-beta'])
    await assert.rejects(manager.programAssemblyPreview(updateInput(snapshot, version)), { code: 'GLOBAL_ASSEMBLY_VERSION_REQUIRED' });
  const changedId = updateInput(snapshot); changedId.pack.id = 'new.id';
  await assert.rejects(manager.programAssemblyPreview(changedId), { code: 'GLOBAL_ASSEMBLY_ID_CHANGED' });
  const renamed = updateInput(snapshot); renamed.pack.components[0].id = 'renamed'; renamed.pack.entry.component = 'renamed';
  await assert.rejects(manager.programAssemblyPreview(renamed), /Updating the local Hub|existing managed modules/);
  const preview = await manager.programAssemblyPreview(updateInput(snapshot));
  await assert.rejects(manager.programAssemblyApply({ reviewId: preview.reviewId, accepted: false }), { code: 'GLOBAL_ASSEMBLY_REVIEW_REQUIRED' });
  manager.globalAssemblyReviews.get(preview.reviewId).createdAt -= 11 * 60000;
  await assert.rejects(manager.programAssemblyApply({ reviewId: preview.reviewId, accepted: true }), { code: 'GLOBAL_ASSEMBLY_REVIEW_REQUIRED' });
  const changed = await manager.programAssemblyPreview(updateInput(snapshot));
  manager.localPrograms.row('one').settings.text = 'A changed baseline';
  await assert.rejects(manager.programAssemblyApply({ reviewId: changed.reviewId, accepted: true }), { code: 'GLOBAL_ASSEMBLY_CHANGED' });
  manager.localPrograms.row('one').settings.text = snapshot.pack.components[0].settings.text;
  const tamper = await manager.programAssemblyPreview(updateInput(snapshot));
  const file = manager.localPrograms.path('one', 'module/program.mjs'), bytes = await readFile(file);
  await writeFile(file, Buffer.concat([bytes, Buffer.from('\n// changed code\n')]));
  await assert.rejects(manager.programAssemblyApply({ reviewId: tamper.reviewId, accepted: true }), { code: 'LOCAL_INSTALLED_CODE_CHANGED' });
  await writeFile(file, bytes);
  await register(manager, 'new-provider', 'source');
  await assert.rejects(manager.programAssemblyPreview(updateInput(snapshot)), { code: 'GLOBAL_ASSEMBLY_CHANGED' });
  assert.equal(manager.localPrograms.assembly.version, '0.1.0');
});

test('global composition HTTP review/apply is explicit and a failed registry write restores every in-memory setting and version', { timeout: 30000 }, async t => {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close()); const manager = server.manager;
  await register(manager, 'source', 'source'); const snapshot = await manager.programAssembly(), input = updateInput(snapshot);
  input.pack.components[0].settings.text = 'After reviewed apply';
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: 'POST', headers: { authorization: 'Bearer ' + server.token,
      'x-csrf-token': server.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  const preview = await call('/api/programs/assembly/preview', input); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const registry = await readFile(join(app.root, 'local-programs/registry.json')), before = structuredClone(await manager.localPrograms.programs());
  const save = manager.localPrograms.save; manager.localPrograms.save = async () => { throw Object.assign(new Error('Injected registry write failure'), { code: 'EACCES' }); };
  const failed = await call('/api/programs/assembly/apply', { reviewId: preview.body.reviewId, accepted: true });
  manager.localPrograms.save = save;
  assert.equal(failed.status, 409); assert.equal(failed.body.error.code, 'EACCES');
  assert.deepEqual(await manager.localPrograms.programs(), before); assert.equal(manager.localPrograms.assembly.version, '0.1.0');
  assert.deepEqual(await readFile(join(app.root, 'local-programs/registry.json')), registry);
  const applied = await call('/api/programs/assembly/apply', { reviewId: preview.body.reviewId, accepted: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.composition.version, '0.1.1');
  assert.equal(applied.body.programs[0].settings.text, 'After reviewed apply'); assert.equal(manager.hub, null);
  const overview=await fetch(new URL('/api/programs',server.url),{headers:{authorization:'Bearer '+server.token}});
  assert.equal(overview.status,200);
  const visible=await overview.json();
  assert.equal(visible.composition.version,'0.1.1');
  assert.equal(visible.programs[0].settings.text,'After reviewed apply');
});

test('even a version-only global update retires previous execution and registration consent after persistence succeeds', { timeout: 30000 }, async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); app.cleanups.push(() => manager.close()); await register(manager, 'source', 'source');
  const priorStart = await manager.localPrograms.reviewStart('source');
  const priorRegistration = await manager.localPrograms.preview({ programId: 'pending-source', directory: join(ROOT, 'examples/ecosystem-pack/modules/source') });
  const snapshot = await manager.programAssembly(), preview = await manager.programAssemblyPreview(updateInput(snapshot));
  const save = manager.localPrograms.save;
  manager.localPrograms.save = async () => { throw new Error('Injected unsuccessful save'); };
  await assert.rejects(manager.programAssemblyApply({ reviewId: preview.reviewId, accepted: true }), /Injected unsuccessful save/);
  manager.localPrograms.save = save;
  assert.ok(manager.localPrograms.reviews.has(priorStart.reviewId), 'An unsuccessful update must retain prior review records');
  assert.ok(manager.localPrograms.reviews.has(priorRegistration.reviewId));
  await manager.programAssemblyApply({ reviewId: preview.reviewId, accepted: true });
  assert.equal(manager.localPrograms.reviews.size, 0);
  await assert.rejects(manager.localPrograms.start('source', { reviewId: priorStart.reviewId, accepted: true }), { code: 'LOCAL_REVIEW_REQUIRED' });
  await assert.rejects(manager.localPrograms.register({ reviewId: priorRegistration.reviewId, accepted: true }), { code: 'LOCAL_REVIEW_REQUIRED' });
  assert.equal(manager.hub, null); assert.equal(manager.localPrograms.handles.size, 0);
  const fresh = await manager.localPrograms.reviewStart('source');
  assert.equal(fresh.review.digest, priorStart.review.digest, 'This regression specifically covers unchanged configuration digests');
  assert.ok(manager.localPrograms.reviews.has(fresh.reviewId));
});
