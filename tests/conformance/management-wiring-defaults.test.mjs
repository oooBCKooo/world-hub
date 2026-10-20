import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, okay, refused, moduleSource, importModule, groupSource, importGroup, configurationSource, stateFile, json,
  preview as previewVersion, apply as applyVersion } from '../helpers/module-versions-scene.mjs';

const endpoint = action => `/manage/api/wiring/defaults/${action}`;
const wiring = row => structuredClone({ topics: row.topics, bridges: row.bridges, bindings: row.bindings });
async function preview(scene, input = { scope: 'all' }) { return okay(await scene.call(endpoint('preview'), input)); }
async function apply(scene, reviewed) { return okay(await scene.call(endpoint('apply'), { reviewId: reviewed.reviewId, accepted: true })); }
async function configure(scene, id, changes) {
  const local = scene.owner.localPrograms, expectedRevision = local.public(local.row(id)).configurationRevision;
  const reviewed = okay(await scene.call(`/manage/api/programs/${id}/configuration/preview`, { expectedRevision, ...changes }));
  return okay(await scene.call(`/manage/api/programs/${id}/configuration/apply`, { reviewId: reviewed.reviewId, accepted: true }));
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function updateJson(path, change) { const value = await readJson(path); change(value); await writeFile(path, json(value)); return value; }
async function recipeGroup(scene, version, topic) {
  const source = await groupSource(scene, version, ['first', 'second']);
  source.manifest = await updateJson(join(source.directory, 'module-group.json'), value => {
    for (const member of value.modules) member.configuration.topics.events = topic;
  });
  return source;
}
function unchangedExceptWiring(before, after) {
  const omitted = ['topics', 'bridges', 'bindings', 'configuredAt', 'communication'];
  const publicPart = value => Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)));
  assert.deepEqual(publicPart(after), publicPart(before));
}

test('management wiring defaults: batch restoration preserves public settings, identity, private data, source and both startup plans', async t => {
  const scene = await setup(t), imported = await importGroup(scene, await recipeGroup(scene, '1.0.0', 'author/group-line'));
  const local = scene.owner.localPrograms, ids = imported.group.memberProgramIds;
  for (const [index, id] of ids.entries()) await configure(scene, id, { topics: { events: `custom/${index}` },
    bridges: { main: { publish: [], subscribe: ['events'] } }, settings: { label: `my setting ${index}` } });
  const global = okay(await scene.call('/manage/api/programs/startup-plan'));
  okay(await scene.call('/manage/api/programs/startup-plan/save', { expectedRevision: global.plan.revision,
    plan: { ...global.plan, members: ids.map((programId, index) => ({ programId, enabled: true, after: index ? [ids[0]] : [] })), startupOrder: ids } }));
  const before = new Map(ids.map(id => [id, structuredClone(local.row(id))])), startup = structuredClone(local.getStartupPlan()), group = structuredClone(local.groups.get(imported.group.id));
  const files = new Map();
  for (const id of ids) files.set(id, { state: await stateFile(scene, id, `opaque data ${id}`),
    identity: await readFile(local.path(id, 'identity.json')), source: await readFile(local.path(id, 'module', 'program.mjs')) });
  const reviewed = await preview(scene); assert.equal(reviewed.review.blocked, false);
  assert.equal(reviewed.review.programs.filter(row => row.changed).length, 2);
  assert.equal(JSON.stringify(reviewed).includes(local.identities.get(ids[0]).token), false);
  await apply(scene, reviewed);
  for (const id of ids) {
    assert.deepEqual(local.row(id).topics, { events: 'author/group-line' });
    assert.deepEqual(local.row(id).bridges, { main: { publish: ['events'], subscribe: ['events'] } });
    unchangedExceptWiring(before.get(id), local.row(id));
    assert.deepEqual(await readFile(local.path(id, 'identity.json')), files.get(id).identity);
    assert.deepEqual(await readFile(local.path(id, 'module', 'program.mjs')), files.get(id).source);
    assert.equal(await readFile(files.get(id).state, 'utf8'), `opaque data ${id}`);
  }
  assert.deepEqual(local.getStartupPlan(), startup); assert.deepEqual(local.groups.get(group.id), group);
});

test('management wiring defaults: imported group recipe survives reload while module scope explicitly uses module defaults', async t => {
  const scene = await setup(t), source = await recipeGroup(scene, '1.0.0', 'recipe/not-module-default');
  const imported = await importGroup(scene, source), id = imported.group.memberProgramIds[0];
  await configure(scene, id, { topics: { events: 'my/line' } }); await scene.reload();
  const grouped = await preview(scene, { scope: 'group', targetId: imported.group.id });
  const groupProgram = grouped.review.programs.find(row => row.programId === id);
  assert.equal(groupProgram.after.topics.events, 'recipe/not-module-default'); assert.equal(groupProgram.source.groupId, imported.group.id);
  await apply(scene, grouped);
  const single = await preview(scene, { scope: 'module', targetId: id });
  assert.equal(single.review.programs.length, 1); assert.equal(single.review.programs[0].after.topics.events, 'versions/communication');
  await apply(scene, single); assert.equal(scene.owner.localPrograms.row(id).topics.events, 'versions/communication');
});

test('management wiring defaults: group update stores new author recipe even when current public configuration is preserved', async t => {
  const scene = await setup(t), v1 = await recipeGroup(scene, '1.0.0', 'recipe/one');
  const imported = await importGroup(scene, v1), id = imported.group.origin.members.first;
  await configure(scene, id, { topics: { events: 'my/preserved-line' }, settings: { label: 'local setting' } });
  const v2 = await recipeGroup(scene, '2.0.0', 'recipe/two');
  await applyVersion(scene, 'groups', imported.group.id, await previewVersion(scene, 'groups', imported.group.id, v2.directory));
  assert.equal(scene.owner.localPrograms.row(id).topics.events, 'my/preserved-line');
  await scene.reload();
  const reviewed = await preview(scene, { scope: 'group', targetId: imported.group.id });
  assert.equal(reviewed.review.programs.find(row => row.programId === id).after.topics.events, 'recipe/two');
  await apply(scene, reviewed); assert.equal(scene.owner.localPrograms.row(id).settings.label, 'local setting');
});

test('management wiring defaults: a legacy group must reselect its exact source before establishing a persistent wiring baseline', async t => {
  const scene = await setup(t), source = await recipeGroup(scene, '1.0.0', 'recipe/recovered');
  const imported = await importGroup(scene, source), local = scene.owner.localPrograms;
  // Represent an existing registry written before wiring baselines existed,
  // without inventing fields rejected by the current group validator.
  const registryPath = join(local.directory, 'registry.json');
  await updateJson(registryPath, value => { for (const group of value.groups) delete group.wiringBaseline; });
  await scene.reload();
  const missing = await preview(scene, { scope: 'group', targetId: imported.group.id });
  assert.ok(missing.review.blocked); assert.equal(missing.review.missingGroupSources[0].groupId, imported.group.id);
  refused(await scene.call(endpoint('apply'), { reviewId: missing.reviewId, accepted: true }));
  const exact = await configurationSource(scene, source);
  const wrong = await recipeGroup(scene, '2.0.0', 'recipe/wrong');
  const wrongConfiguration = await configurationSource(scene, wrong);
  const wrongResult = await scene.call(endpoint('preview'), { scope: 'group', targetId: imported.group.id, groupSources: { [imported.group.id]: wrongConfiguration.directory } });
  if (wrongResult.status === 200) assert.ok(wrongResult.body.review.blocked); else refused(wrongResult);
  const stale = await preview(scene, { scope: 'group', targetId: imported.group.id, groupSources: { [imported.group.id]: exact.directory } });
  const sourceMarker = join(exact.directory, 'configuration.json'), originalMarker = await readFile(sourceMarker);
  await updateJson(sourceMarker, value => { value.modules[0].configuration.topics.events = 'changed/after-review'; });
  try { refused(await scene.call(endpoint('apply'), { reviewId: stale.reviewId, accepted: true })); }
  finally { await writeFile(sourceMarker, originalMarker); }
  assert.equal(scene.owner.localPrograms.groups.get(imported.group.id).wiringBaseline, undefined);
  const reviewed = await preview(scene, { scope: 'group', targetId: imported.group.id, groupSources: { [imported.group.id]: exact.directory } });
  assert.equal(reviewed.review.blocked, false); assert.deepEqual(reviewed.review.groupBaselinesEstablished, [imported.group.id]);
  await apply(scene, reviewed); await scene.reload();
  const persisted = await preview(scene, { scope: 'group', targetId: imported.group.id });
  assert.deepEqual(persisted.review.missingGroupSources, []); assert.equal(persisted.review.blocked, false);
});

test('management wiring defaults: exact default connections use candidate provider topics and replace edited capability bindings', async t => {
  const scene = await setup(t), contract = { id: 'defaults.text', version: '1.0.0' };
  const provider = await moduleSource(scene, 'provider', '1.0.0', { topic: 'author/provider', provides: [contract] });
  const other = await moduleSource(scene, 'other', '1.0.0', { provides: [contract] });
  const consumer = await moduleSource(scene, 'consumer', '1.0.0', { topic: 'author/consumer', requires: [contract] });
  await updateJson(join(consumer.directory, 'deployment.json'), value => { value.connections = [{ id: 'text', provider: { moduleId: provider.manifest.id, version: '1.0.0' }, contracts: [contract], topics: { events: 'events' } }]; });
  await importModule(scene, provider, 'provider'); await importModule(scene, other, 'other'); await importModule(scene, consumer, 'consumer');
  await configure(scene, 'provider', { topics: { events: 'custom/provider' } });
  await configure(scene, 'consumer', { topics: { events: 'custom/consumer' }, bindings: [{ providerId: 'other', contract }] });
  const reviewed = await preview(scene); assert.equal(reviewed.review.blocked, false);
  const row = reviewed.review.programs.find(row => row.programId === 'consumer');
  assert.equal(row.after.topics.events, 'author/provider'); assert.deepEqual(row.after.bindings, [{ providerId: 'provider', contract }]);
  await apply(scene, reviewed);
  assert.equal(scene.owner.localPrograms.row('consumer').topics.events, scene.owner.localPrograms.row('provider').topics.events);
});

test('management wiring defaults: ambiguous providers require an explicit selection and missing providers are never installed', async t => {
  const scene = await setup(t), provider = await moduleSource(scene, 'provider', '1.0.0');
  const consumer = await moduleSource(scene, 'consumer', '1.0.0');
  await updateJson(join(consumer.directory, 'deployment.json'), value => { value.connections = [{ id: 'line', provider: { moduleId: provider.manifest.id, version: '1.0.0' }, contracts: [], topics: { events: 'events' } }]; });
  await importModule(scene, provider, 'one'); await importModule(scene, consumer, 'consumer'); await importModule(scene, provider, 'two');
  const ambiguous = await preview(scene, { scope: 'module', targetId: 'consumer' });
  assert.ok(ambiguous.review.blocked); assert.equal(ambiguous.review.connections[0].status, 'ambiguous');
  const selected = await preview(scene, { scope: 'module', targetId: 'consumer', connectionSelections: { consumer: { line: 'two' } } });
  assert.equal(selected.review.blocked, false); await apply(scene, selected);
  for (const id of ['one', 'two']) okay(await scene.call(`/manage/api/programs/${id}/remove`, {}));
  const missing = await preview(scene, { scope: 'module', targetId: 'consumer' });
  assert.ok(missing.review.blocked); assert.equal(missing.review.connections[0].status, 'missing');
  assert.deepEqual([...scene.owner.localPrograms.records.keys()], ['consumer']);
});

test('management wiring defaults: configuration, source and group changes invalidate exact reviewed batches', async t => {
  const scene = await setup(t), imported = await importGroup(scene, await recipeGroup(scene, '1.0.0', 'recipe/default'));
  const local = scene.owner.localPrograms, id = imported.group.memberProgramIds[0];
  await configure(scene, id, { topics: { events: 'custom/line' } });
  const configReview = await preview(scene); await configure(scene, id, { settings: { label: 'changed after review' } });
  refused(await scene.call(endpoint('apply'), { reviewId: configReview.reviewId, accepted: true })); assert.equal(local.row(id).topics.events, 'custom/line');
  const sourceReview = await preview(scene), sourcePath = local.path(id, 'module', 'program.mjs'), sourceBytes = await readFile(sourcePath);
  await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\n// external source change\n')]));
  try { refused(await scene.call(endpoint('apply'), { reviewId: sourceReview.reviewId, accepted: true })); }
  finally { await writeFile(sourcePath, sourceBytes); }
  const groupReview = await preview(scene), group = local.groups.get(imported.group.id);
  okay(await scene.call('/manage/api/groups/save', { expectedRevision: group.revision, group: { ...group, title: 'renamed after review' } }));
  refused(await scene.call(endpoint('apply'), { reviewId: groupReview.reviewId, accepted: true })); assert.equal(local.row(id).topics.events, 'custom/line');
});

test('management wiring defaults: running edited targets stay running on refusal while unchanged peers continue real communication after restore', async t => {
  const scene = await setup(t); for (const id of ['changed', 'peer']) await importModule(scene, await moduleSource(scene, id, '1.0.0'), id);
  await configure(scene, 'changed', { topics: { events: 'custom/running' } });
  for (const id of ['changed', 'peer']) okay(await scene.call(`/manage/api/programs/${id}/start`, {}));
  const local = scene.owner.localPrograms, changedHandle = local.handles.get('changed'), peerHandle = local.handles.get('peer');
  const blocked = await preview(scene); assert.ok(blocked.review.blocked); assert.ok(blocked.review.requiresStop.includes('changed'));
  assert.equal(blocked.review.requiresStop.includes('peer'), false);
  refused(await scene.call(endpoint('apply'), { reviewId: blocked.reviewId, accepted: true }));
  assert.equal(changedHandle.exit, null); assert.equal(peerHandle.exit, null);
  okay(await scene.call('/manage/api/programs/changed/stop', {}));
  const reviewed = await preview(scene); assert.equal(reviewed.review.blocked, false); await apply(scene, reviewed);
  assert.equal(local.row('changed').state, 'stopped'); assert.equal(local.row('peer').state, 'running'); assert.equal(peerHandle.exit, null);
  await importModule(scene, await moduleSource(scene, 'probe', '1.0.0'), 'probe'); okay(await scene.call('/manage/api/programs/probe/start', {}));
  const observed = () => peerHandle.stdout.split('\n').some(line => { try { const event = JSON.parse(line); return event.event === 'received' && event.body.member === 'probe'; } catch { return false; } });
  const deadline = Date.now() + 5000; while (!observed() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(observed(), peerHandle.stdout); assert.equal(local.handles.get('peer'), peerHandle);
});

test('management wiring defaults: registry write failure rolls back the entire batch without restoring revoked credentials', async t => {
  const scene = await setup(t); for (const id of ['one', 'two']) {
    await importModule(scene, await moduleSource(scene, id, '1.0.0'), id); await configure(scene, id, { topics: { events: `custom/${id}` } });
  }
  const local = scene.owner.localPrograms, before = structuredClone([...local.records]), registry = await readFile(join(local.directory, 'registry.json'));
  const reviewed = await preview(scene), save = local.save, update = local.updateCredentials, revoked = [];
  local.save = async () => { throw new Error('fixture wiring registry write failed'); };
  local.updateCredentials = async (input, options) => { revoked.push(...(input.remove ?? [])); return update.call(local, input, options); };
  try { refused(await scene.call(endpoint('apply'), { reviewId: reviewed.reviewId, accepted: true })); }
  finally { local.save = save; local.updateCredentials = update; }
  assert.deepEqual([...local.records], before); assert.deepEqual(await readFile(join(local.directory, 'registry.json')), registry);
  for (const [, row] of before) assert.ok(revoked.includes(row.principal));
});

test('management wiring defaults: object and ACL ordering does not require stopping an otherwise unchanged running instance', async t => {
  const scene = await setup(t), source = await moduleSource(scene, 'ordered', '1.0.0');
  await updateJson(join(source.directory, 'deployment.json'), value => {
    value.topics = { events: 'versions/communication', second: 'versions/secondary' };
    value.bridges.main = { publish: ['events', 'second'], subscribe: ['events', 'second'] };
  });
  await importModule(scene, source, 'ordered');
  await configure(scene, 'ordered', { topics: { second: 'versions/secondary', events: 'versions/communication' },
    bridges: { main: { subscribe: ['second', 'events'], publish: ['second', 'events'] } } });
  okay(await scene.call('/manage/api/programs/ordered/start', {}));
  const local = scene.owner.localPrograms, handle = local.handles.get('ordered'), reviewed = await preview(scene);
  assert.equal(reviewed.review.programs[0].changed, false); assert.equal(reviewed.review.blocked, false); assert.deepEqual(reviewed.review.requiresStop, []);
  await apply(scene, reviewed); assert.equal(handle.exit, null); assert.equal(local.row('ordered').state, 'running');
});

test('management wiring defaults: CSRF, explicit acceptance and interrupted version transactions guard restoration', async t => {
  const scene = await setup(t); await importModule(scene, await moduleSource(scene, 'only', '1.0.0'), 'only');
  await configure(scene, 'only', { topics: { events: 'custom/only' } });
  const response = await fetch(scene.base + endpoint('preview'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-management-token': 'invalid' }, body: JSON.stringify({ scope: 'all' }) });
  assert.equal(response.status, 403);
  const reviewed = await preview(scene); refused(await scene.call(endpoint('apply'), { reviewId: reviewed.reviewId, accepted: false }));
  const marker = scene.owner.localPrograms.path('only', 'version-transaction.json'); await writeFile(marker, json({ transactionId: '00000000-0000-0000-0000-000000000000' }));
  const guarded = await scene.call(endpoint('preview'), { scope: 'all' });
  if (guarded.status === 200) assert.ok(guarded.body.review.blocked); else refused(guarded);
  refused(await scene.call(endpoint('apply'), { reviewId: reviewed.reviewId, accepted: true }));
  assert.equal(scene.owner.localPrograms.row('only').topics.events, 'custom/only');
});

test('management wiring defaults: conflicting shared group recipes block global restore, while an explicit group lists the shared impact', async t => {
  const scene = await setup(t), source = await recipeGroup(scene, '1.0.0', 'recipe/first');
  const imported = await importGroup(scene, source), otherDirectory = join(scene.root, 'other-group'); await cp(source.directory, otherDirectory, { recursive: true });
  await updateJson(join(otherDirectory, 'module-group.json'), value => { value.id = 'defaults.other-group'; value.title = 'Other source group'; for (const member of value.modules) member.configuration.topics.events = 'recipe/second'; });
  const localGroup = okay(await scene.call('/manage/api/groups/save', { group: { id: 'shared-group', title: 'Shared group', memberProgramIds: imported.group.memberProgramIds } })).group;
  await applyVersion(scene, 'groups', localGroup.id, await previewVersion(scene, 'groups', localGroup.id, otherDirectory, { establishOrigin: true }));
  const global = await preview(scene); assert.ok(global.review.blocked); assert.ok(global.review.blockers.length);
  refused(await scene.call(endpoint('apply'), { reviewId: global.reviewId, accepted: true }));
  const selected = await preview(scene, { scope: 'group', targetId: localGroup.id }); assert.equal(selected.review.blocked, false);
  for (const row of selected.review.programs) {
    assert.equal(row.after.topics.events, 'recipe/second');
    assert.ok(row.affected.sharedWithGroups.some(group => (typeof group === 'string' ? group : group.id) === imported.group.id));
  }
  await apply(scene, selected);
  assert.equal(scene.owner.localPrograms.row(imported.group.memberProgramIds[0]).topics.events, 'recipe/second');
});
