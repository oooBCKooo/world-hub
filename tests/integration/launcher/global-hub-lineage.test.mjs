import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { CreatorDrafts } from '../../../tools/launcher/creator-drafts.mjs';
import { workspace, ROOT, environment } from './helpers.mjs';

async function register(manager, id) {
  const checked = await manager.localPrograms.preview({ programId: id, directory: join(ROOT, 'examples/ecosystem-pack/modules/source') });
  return manager.localPrograms.register({ reviewId: checked.reviewId, accepted: true });
}
function call(server, path, body) {
  return fetch(new URL(path, server.url), { method: 'POST', headers: { authorization: 'Bearer ' + server.token,
    'x-csrf-token': server.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    .then(async response => ({ status: response.status, body: await response.json() }));
}
function next(snapshot, version) {
  return { directory: snapshot.directory, pack: { ...structuredClone(snapshot.pack), version }, expectedRevision: snapshot.composition.revision };
}

test('global workbench saves exact order and failure policy as reviewed local revisions, retaining its first baseline across restart and added members', { timeout: 45000 }, async t => {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close()); const manager = server.manager;
  await register(manager, 'first'); await register(manager, 'second');
  const initial = await manager.programAssembly();
  assert.equal(initial.composition.lineage, undefined); assert.equal(initial.pack.lineage, undefined, 'A global source version is not labelled self-created by snapshotting');
  const input = next(initial, '0.1.1');
  input.pack.startupOrder = ['second', 'first']; input.pack.components.forEach(row => { row.autostart = row.id === 'second'; });
  input.startupPlan = { onFailure: 'stop-plan' };
  const preview = await call(server, '/api/programs/assembly/preview', input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.review.startupPlan.startupOrder, ['second', 'first']);
  assert.equal(preview.body.review.startupPlan.onFailure, 'stop-plan');
  assert.deepEqual(preview.body.review.lineage.base, { id: initial.composition.id, version: '0.1.0', sourceDigest: initial.composition.revision });
  assert.equal(preview.body.review.lineage.revision, 1);
  assert.equal(manager.localPrograms.assembly.version, '0.1.0', 'Preview leaves the current saved version intact');
  const unaccepted = await call(server, '/api/programs/assembly/apply', { reviewId: preview.body.reviewId, accepted: false });
  assert.equal(unaccepted.status, 409);
  const applied = await call(server, '/api/programs/assembly/apply', { reviewId: preview.body.reviewId, accepted: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.composition.lineage, preview.body.review.lineage);
  assert.equal(typeof applied.body.composition.revision, 'string'); assert.match(applied.body.composition.revision, /^[a-f0-9]{64}$/);
  assert.equal(manager.hub, null); assert.equal(manager.localPrograms.handles.size, 0);
  await server.close();
  const reopened = new LauncherManager({ root: app.root, ...environment }); await reopened.initialize(); app.cleanups.push(() => reopened.close());
  assert.deepEqual(reopened.localPrograms.assembly.lineage, applied.body.composition.lineage);
  await register(reopened, 'later');
  assert.deepEqual(reopened.localPrograms.getStartupPlan().startupOrder, ['second', 'first', 'later']);
  assert.equal(reopened.localPrograms.getStartupPlan().members.find(row => row.programId === 'later').enabled, false);
  const current = await reopened.programAssembly();
  assert.deepEqual(current.pack.lineage, applied.body.composition.lineage);
  assert.deepEqual(current.pack.startupOrder, ['second', 'first', 'later']);
  assert.equal(current.startupPlan.onFailure, 'stop-plan');
  const second = next(current, '0.1.2'); second.pack.startupOrder = ['later', 'second', 'first'];
  second.pack.components.find(row => row.id === 'later').autostart = true;
  second.startupPlan = { onFailure: 'continue-independent' };
  const checked = await reopened.programAssemblyPreview(second);
  assert.deepEqual(checked.review.lineage.base, applied.body.composition.lineage.base);
  assert.equal(checked.review.lineage.revision, 2);
  const result = await reopened.programAssemblyApply({ reviewId: checked.reviewId, accepted: true });
  assert.equal(result.version, '0.1.2'); assert.equal(result.composition.lineage.revision, 2);
  const saved = await reopened.programAssembly();
  assert.deepEqual(saved.pack.startupOrder, ['later', 'second', 'first']);
  assert.equal(saved.pack.components.find(row => row.id === 'later').autostart, true);
  assert.equal(saved.startupPlan.onFailure, 'continue-independent', 'The current saved version supplies workbench defaults, including newly added members');
  assert.deepEqual(saved.pack.lineage.base, initial.composition.lineage?.base ?? applied.body.composition.lineage.base);
  const registry = JSON.parse(await readFile(join(app.root, 'local-programs/registry.json'), 'utf8'));
  assert.equal(registry.assembly.lineage.revision, 2); assert.deepEqual(registry.startupPlan.startupOrder, saved.pack.startupOrder);
  assert.equal(reopened.hub, null); assert.equal(reopened.localPrograms.handles.size, 0);
  app.record('reviewed-global-version-lineage-order-policy', { revisions: 2, addedMemberRetained: true, executionStarted: false });
});

test('global order and policy changes reject stale reviews and retain full lineage and plan on failed persistence', { timeout: 30000 }, async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); app.cleanups.push(() => manager.close()); await register(manager, 'one'); await register(manager, 'two');
  const snapshot = await manager.programAssembly(), input = next(snapshot, '0.1.1');
  input.pack.startupOrder = ['two', 'one']; input.startupPlan = { onFailure: 'stop-plan' };
  await assert.rejects(manager.programAssemblyPreview({ ...input, startupPlan: { onFailure: 'kill-all' } }), { code: 'LOCAL_STARTUP_PLAN_INVALID' });
  await assert.rejects(manager.programAssemblyPreview({ ...input, startupPlan: { onFailure: 'stop-plan', members: [] } }), { code: 'LOCAL_STARTUP_PLAN_INVALID' });
  const checked = await manager.programAssemblyPreview(input), before = await readFile(join(app.root, 'local-programs/registry.json'));
  const originalSave = manager.localPrograms.save;
  manager.localPrograms.save = async () => { throw Object.assign(new Error('Injected atomic write failure'), { code: 'EACCES' }); };
  await assert.rejects(manager.programAssemblyApply({ reviewId: checked.reviewId, accepted: true }), { code: 'EACCES' });
  manager.localPrograms.save = originalSave;
  assert.deepEqual(await readFile(join(app.root, 'local-programs/registry.json')), before);
  assert.equal(manager.localPrograms.assembly.lineage, undefined); assert.equal(manager.localPrograms.assembly.version, '0.1.0');
  assert.equal(manager.localPrograms.getStartupPlan().onFailure, 'continue-independent');
  assert.equal(manager.localPrograms.getStartupPlan().startupOrder, undefined);
  const plan = manager.localPrograms.getStartupPlan();
  await manager.programStartupPlanSave({ plan: { ...plan, startupOrder: ['one', 'two'] }, expectedRevision: plan.revision });
  await assert.rejects(manager.programAssemblyApply({ reviewId: checked.reviewId, accepted: true }), { code: 'GLOBAL_ASSEMBLY_CHANGED' });
  const fresh = await manager.programAssembly(), crafted = next(fresh, '0.1.1');
  crafted.pack.lineage = { format: 'world-hub.pack-lineage/v1', kind: 'customized', base: { id: 'invented.base', version: '99.0.0', sourceDigest: 'a'.repeat(64) }, revision: 77, customizedAt: '2026-01-01T00:00:00.000Z' };
  const canonical = await manager.programAssemblyPreview(crafted);
  assert.equal(canonical.review.lineage.base.id, fresh.composition.id); assert.equal(canonical.review.lineage.base.version, '0.1.0');
  assert.equal(canonical.review.lineage.revision, 1, 'Browser lineage cannot fabricate a baseline or ordinal revision');
});

test('global creator drafts retain strict source metadata and the current saved failure policy', { timeout: 15000 }, async t => {
  const app = await workspace(t), drafts = new CreatorDrafts(app.root); await drafts.initialize();
  const composition = { id: 'global.hub.assembly', title: 'Global Hub assembly', version: '0.1.2', revision: 'b'.repeat(64), lineage: {
    format: 'world-hub.pack-lineage/v1', kind: 'customized', base: { id: 'global.hub.assembly', version: '0.1.0', sourceDigest: 'a'.repeat(64) }, revision: 2, customizedAt: '2026-10-16T00:00:00.000Z' } };
  const draft = { format: 'world-hub.creator-draft/v1', directory: app.directory, baseRevision: 'c'.repeat(64), pack: {}, replacements: [], formValues: {}, selection: '', updatedAt: '',
    origin: { kind: 'global-hub', composition, startupPlan: { onFailure: 'stop-plan' }, savedStartupPlan: { onFailure: 'continue-independent' } } };
  await drafts.save(draft); const reopened = new CreatorDrafts(app.root); await reopened.initialize();
  assert.deepEqual((await reopened.list()).drafts[0].origin, draft.origin);
  await assert.rejects(drafts.save({ ...draft, origin: { ...draft.origin, startupPlan: { onFailure: 'stop-plan', members: [] } } }), { code: 'DRAFT_INVALID' });
  await assert.rejects(drafts.save({ ...draft, origin: { ...draft.origin, savedStartupPlan: { onFailure: 'stop-plan', members: [] } } }), { code: 'DRAFT_INVALID' });
  await assert.rejects(drafts.save({ ...draft, origin: { ...draft.origin, savedStartupPlan: { onFailure: 'kill-all' } } }), { code: 'DRAFT_INVALID' });
  await assert.rejects(drafts.save({ ...draft, origin: { ...draft.origin, composition: { ...composition, lineage: { ...composition.lineage, revision: 'hash-is-not-a-number' } } } }), { code: 'DRAFT_INVALID' });
});

test('global reviewed startup executes independent members in the saved exact order while an unselected member stays stopped', { timeout: 45000 }, async t => {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment }), handles = new Set();
  app.cleanups.push(() => {
    for (const handle of handles) {
      assert.ok(handle.exit && !handle.cleanupIncomplete, 'Actual owned process has a confirmed cleanup receipt');
      assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null, 'Actual ChildProcess confirmed exit');
    }
  });
  app.cleanups.push(() => server.close()); const manager = server.manager;
  for (const id of ['a', 'b', 'c', 'spare']) await register(manager, id);
  const snapshot = await manager.programAssembly(), input = next(snapshot, '0.1.1');
  input.pack.startupOrder = ['b', 'a', 'c', 'spare']; input.startupPlan = { onFailure: 'continue-independent' };
  for (const component of input.pack.components) { component.autostart = component.id !== 'spare'; assert.deepEqual(component.after, []); }
  const reviewed = await call(server, '/api/programs/assembly/preview', input); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const applied = await call(server, '/api/programs/assembly/apply', { reviewId: reviewed.body.reviewId, accepted: true }); assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const plan = await call(server, '/api/programs/startup-plan/review', {}); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual(plan.body.review.order, ['b', 'a', 'c']);
  const started = await call(server, '/api/programs/startup-plan/start', { reviewId: plan.body.reviewId, accepted: true }); assert.equal(started.status, 202, JSON.stringify(started.body));
  const operation = manager.operations.get(started.body.operationId);
  try { await operation.promise; }
  finally { if (manager.hub) handles.add(manager.hub); for (const handle of manager.localPrograms.handles.values()) handles.add(handle); }
  assert.equal(operation.state, 'succeeded', JSON.stringify(operation.error));
  assert.equal(operation.result.partial, false); assert.deepEqual(operation.result.results.map(row => [row.programId, row.state]), [['b', 'started'], ['a', 'started'], ['c', 'started']]);
  const rows = ['b', 'a', 'c'].map(id => manager.localPrograms.row(id));
  assert.ok(rows[0].startedAt < rows[1].startedAt && rows[1].startedAt < rows[2].startedAt, 'Observed process starts follow B, A, C without after edges');
  assert.equal(manager.localPrograms.row('spare').state, 'stopped'); assert.equal(manager.localPrograms.handles.has('spare'), false);
  app.record('global-exact-independent-start-order', { order: operation.result.order, starts: rows.map(row => ({ id: row.programId, startedAt: row.startedAt })), spare: 'stopped' });
});
