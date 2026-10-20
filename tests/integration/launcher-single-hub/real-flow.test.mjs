import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { ModuleGroups } from '../../../tools/launcher/module-groups.mjs';
import { workspace, ROOT, environment, expectedText } from '../launcher/helpers.mjs';

test('one Hub runs shared module groups, reuses members, saves one instance and upgrades reviewed module source without replacing identity or state', { timeout: 150000 }, async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); const local = manager.localPrograms, groups = new ModuleGroups({ localPrograms: local }), owned = new Set();
  app.cleanups.push(async () => {
    await manager.close();
    for (const handle of owned) { assert.ok(handle.exit && !handle.cleanupIncomplete); assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null); }
  });
  const register = async (programId, name, bindings = []) => {
    const preview = await local.preview({ programId, directory: join(ROOT, 'examples/ecosystem-pack/modules', name), bindings });
    await local.register({ reviewId: preview.reviewId, accepted: true });
  };
  const bindings = source => [{ providerId: source, contract: { id: 'text.read', version: '1.0.0' } },
    { providerId: 'stats', contract: { id: 'text.statistics', version: '1.0.0' } }];
  await register('source', 'source'); await register('stats', 'stats'); await register('desk-one', 'desk', bindings('source')); await register('desk-two', 'desk', bindings('source'));
  const saveGroup = async (id, desk) => (await groups.save({ group: { id, title: id, memberProgramIds: ['source', 'stats', desk],
    startupPlan: { members: [{ programId: 'source', enabled: true, after: [] }, { programId: 'stats', enabled: true, after: [] },
      { programId: desk, enabled: true, after: ['source', 'stats'] }], startupOrder: ['source', 'stats', desk], onFailure: 'stop-plan' } } })).group;
  const first = await saveGroup('first', 'desk-one'), second = await saveGroup('second', 'desk-two');
  const startGroup = async group => {
    const review = await groups.reviewStart({ groupId: group.id, expectedRevision: group.revision });
    const result = await groups.applyStart({ reviewId: review.reviewId, accepted: true });
    owned.add(manager.hub); for (const handle of local.handles.values()) owned.add(handle);
    assert.equal(result.partial, false); return result;
  };
  await startGroup(first); const sourceHandle = local.handles.get('source'), statsHandle = local.handles.get('stats'), hub = manager.hub;
  const reused = await startGroup(second);
  assert.equal(local.handles.get('source'), sourceHandle); assert.equal(local.handles.get('stats'), statsHandle);
  assert.deepEqual(reused.results.filter(row => row.state === 'already-running').map(row => row.programId), ['source', 'stats']);
  assert.equal(manager.hub, hub); assert.equal(new Set((await local.programs()).map(row => row.hubUrl)).size, 1);
  const analyze = async (id, text) => {
    const response = await fetch(new URL('/analyze', local.row(id).entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.deepEqual(value.result.output, expectedText(text));
  };
  await analyze('desk-one', 'One shared Hub across module groups 🌍\n'); await analyze('desk-two', 'Second group uses the same provider\n');
  const stop = await groups.stopPreview({ groupId: first.id, expectedRevision: first.revision });
  assert.ok(stop.review.programs.find(row => row.programId === 'source').sharedWithGroups.some(group => group.id === 'second'));
  await groups.applyStop({ reviewId: stop.reviewId, accepted: true, programIds: ['desk-one'] });
  assert.equal(local.row('source').state, 'running'); assert.equal(local.row('desk-two').state, 'running'); assert.equal(hub.exit, null);
  await register('replacement-source', 'source');
  const identity = await readFile(local.path('replacement-source', 'identity.json'));
  const upgradeSource = join(app.directory, 'source-v2'); await cp(join(ROOT, 'examples/ecosystem-pack/modules/source'), upgradeSource, { recursive: true });
  const manifestFile = join(upgradeSource, 'module.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.version = '2.0.0'; await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const upgrade = await local.configurationPreview('replacement-source', { directory: upgradeSource,
    expectedRevision: local.public(local.row('replacement-source')).configurationRevision, settings: { text: 'Initial state from reviewed v2' } });
  const upgraded = await local.configurationApply('replacement-source', { reviewId: upgrade.reviewId, accepted: true });
  assert.equal(upgraded.program.module.version, '2.0.0'); assert.deepEqual(await readFile(local.path('replacement-source', 'identity.json')), identity);
  let review = await local.reviewStart('replacement-source'); await local.start('replacement-source', { reviewId: review.reviewId, accepted: true }); owned.add(local.handles.get('replacement-source'));
  const configure = await local.configurationPreview('desk-one', { expectedRevision: local.public(local.row('desk-one')).configurationRevision, bindings: bindings('replacement-source') });
  assert.equal(configure.review.affected.sharedWithGroups[0].id, 'first');
  assert.ok(configure.review.affected.providers.some(row => row.programId === 'source' && row.state === 'running'));
  await local.configurationApply('desk-one', { reviewId: configure.reviewId, accepted: true });
  assert.equal(local.handles.get('source'), sourceHandle); assert.equal(local.row('desk-two').state, 'running');
  // This example provider authorizes consumers from its own reviewed runtime
  // snapshot. The displayed affected-provider boundary requires an explicit
  // provider restart; saving a consumer must never silently restart it.
  await local.stop('replacement-source');
  review = await local.reviewStart('replacement-source'); await local.start('replacement-source', { reviewId: review.reviewId, accepted: true }); owned.add(local.handles.get('replacement-source'));
  review = await local.reviewStart('desk-one'); await local.start('desk-one', { reviewId: review.reviewId, accepted: true }); owned.add(local.handles.get('desk-one'));
  const text = 'Changed provider through direct instance configuration ✅\n'; await analyze('desk-one', text);
  assert.equal(JSON.parse(await readFile(local.path('replacement-source', 'state/source.json'), 'utf8')).text, text);
  const state = await readFile(local.path('replacement-source', 'state/source.json'));
  await local.stop('replacement-source');
  const stateReview = await local.configurationPreview('replacement-source', { expectedRevision: local.public(local.row('replacement-source')).configurationRevision,
    settings: { text: 'A new default must not replace business state' } });
  await local.configurationApply('replacement-source', { reviewId: stateReview.reviewId, accepted: true });
  assert.deepEqual(await readFile(local.path('replacement-source', 'state/source.json')), state);
  await groups.remove({ groupId: first.id, expectedRevision: first.revision }); assert.ok(local.records.has('desk-one'));
  app.trackSession({ children: [...owned] });
  app.record('single-hub-module-groups-real-communication', { oneHub: true, sharedProcessesReused: true, independentSourceUpgrade: true,
    directInstanceConfiguration: true, unaffectedGroupRunning: true, privateIdentityAndStateRetained: true, processCount: owned.size });
});
