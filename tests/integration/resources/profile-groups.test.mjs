import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, okay, refused, moduleSource, importModule } from '../../helpers/module-versions-scene.mjs';
import { normalizeModuleGroup, moduleGroupWiringBaseline } from '../../../tools/launcher/module-groups.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';

const api = '/manage/api/resources/profiles';
async function scene(t) {
  const s = await setup(t);
  for (const id of ['a', 'b', 'c']) await importModule(s, await moduleSource(s, id, '1.0.0'), id);
  const captured = okay(await s.call(api + '/capture', { id: 'profile.a', title: 'Recipe A', version: '1.0.0', scope: 'local', programIds: ['a', 'b'] }));
  const profiles = { a: captured.profile };
  for (const id of ['b', 'c']) {
    const directory = join(s.root, 'recipe-' + id); await mkdir(directory);
    const manifest = structuredClone(captured.profile.manifest); manifest.id = 'profile.' + id; manifest.title = 'Recipe ' + id.toUpperCase();
    if (id === 'b') manifest.startupPlan.members[0].enabled = true;
    await writeFile(join(directory, 'configuration.json'), JSON.stringify(manifest));
    profiles[id] = okay(await s.call(api + '/import', { path: directory })).profile;
  }
  const addGroup = async (id, members = ['a', 'b'], profile) => {
    const source = profile?.manifest ?? { ...captured.profile.manifest, id: 'author.business' };
    const mapping = Object.fromEntries(source.modules.map(member => [member.id, member.id]));
    const group = normalizeModuleGroup({ id, title: profile ? source.title : 'Business group', memberProgramIds: members,
      startupPlan: { ...source.startupPlan, members: members.map(programId => ({ programId, enabled: source.startupPlan.members.find(row => row.programId === programId)?.enabled ?? false, after: [] })), startupOrder: members },
      origin: { id: source.id, version: source.version, members: mapping }, wiringBaseline: moduleGroupWiringBaseline(source) }, [...s.owner.localPrograms.records.keys()]);
    s.owner.localPrograms.groups.set(id, group); await s.owner.localPrograms.save(); return group;
  };
  const apply = async (profile, extra = {}) => {
    const preview = okay(await s.call(api + '/preview', { profileId: profile.profileId, ...extra }));
    assert.equal(preview.review.blocked, false, JSON.stringify(preview));
    return okay(await s.call(api + '/apply', { reviewId: preview.reviewId, accepted: true }));
  };
  return { ...s, get owner() { return s.owner; }, profiles, addGroup, apply };
}

test('profiles bind an exact business group without replacing its identity or author baseline', async t => {
  const s = await scene(t), business = await s.addGroup('text-desk');
  const result = await s.apply(s.profiles.b);
  assert.equal(result.profile.groupId, business.id); assert.equal(result.profile.ownsGroup, false);
  const groups = okay(await s.call('/manage/api/groups')).groups;
  assert.equal(groups.length, 1); assert.equal(groups[0].id, business.id); assert.equal(groups[0].title, business.title);
  assert.deepEqual(groups[0].origin, business.origin); assert.deepEqual(groups[0].wiringBaseline, business.wiringBaseline);
  assert.equal(groups[0].startupPlan.members[0].enabled, true);
  assert.deepEqual(groups[0].activeProfiles, [{ profileId: s.profiles.b.profileId, id: 'profile.b', title: 'Recipe B', version: '1.0.0', ownsGroup: false }]);
  assert.deepEqual(okay(await s.call('/manage/api/programs')).groups[0].activeProfiles, groups[0].activeProfiles);
  okay(await s.call('/manage/api/groups/save', { expectedRevision: groups[0].revision,
    group: { ...groups[0], activeProfiles: [{ profileId: 'forged' }] } }));
  assert.deepEqual(okay(await s.call('/manage/api/groups')).groups[0].activeProfiles, groups[0].activeProfiles, 'Read-only association cannot be overwritten by a group editor');
  okay(await s.call(api + '/deactivate', { profileIds: [s.profiles.b.profileId], accepted: true }));
  const deactivated = okay(await s.call('/manage/api/groups')).groups;
  assert.equal(deactivated.length, 1); assert.deepEqual(deactivated[0].activeProfiles, []);
  assert.equal(deactivated[0].startupPlan.members[0].enabled, true, 'Deactivation detaches the recipe; it does not silently undo configuration');
});

test('repeated recipe switches reuse one owned group and deactivation removes only its reference container', async t => {
  const s = await scene(t); let active, groupId;
  for (let index = 0; index < 8; index++) {
    const selected = index % 2 ? s.profiles.b : s.profiles.a;
    const result = await s.apply(selected, { replaceProfileIds: active ? [active] : [] });
    groupId ??= result.profile.groupId; assert.equal(result.profile.groupId, groupId);
    assert.equal(s.owner.localPrograms.groups.size, 1); active = selected.profileId;
  }
  await s.reload();
  assert.equal(s.owner.localPrograms.groups.size, 1);
  okay(await s.call(api + '/deactivate', { profileIds: [active], accepted: true }));
  assert.equal(s.owner.localPrograms.groups.size, 0); assert.equal(s.owner.localPrograms.records.size, 3);
  assert.equal(s.owner.localPrograms.row('a').state, 'stopped');
});

test('known historical recipe groups are cleaned when binding a business group, while prefix lookalikes survive', async t => {
  const s = await scene(t); const business = await s.addGroup('business');
  for (const profile of [s.profiles.a, s.profiles.c]) await s.addGroup('configuration-' + hash(profile.manifest.id).slice(0, 24), ['a', 'b'], profile);
  await s.addGroup('configuration-user-owned', ['b', 'c']);
  await s.apply(s.profiles.b);
  assert.deepEqual([...s.owner.localPrograms.groups.keys()].sort(), [business.id, 'configuration-user-owned']);
});

test('parallel mappings create independent groups and partial overlaps keep their own business boundary', async t => {
  const s = await scene(t); await s.addGroup('partial', ['b', 'c']);
  const first = await s.apply(s.profiles.a, { replaceProfileIds: [] });
  const second = await s.apply(s.profiles.c, { mapping: { a: 'second-a', b: 'second-b' }, replaceProfileIds: [] });
  assert.notEqual(first.profile.groupId, second.profile.groupId); assert.equal(s.owner.localPrograms.groups.size, 3);
  assert.deepEqual(s.owner.localPrograms.groups.get(first.profile.groupId).memberProgramIds, ['a', 'b']);
  assert.deepEqual(s.owner.localPrograms.groups.get(second.profile.groupId).memberProgramIds, ['second-a', 'second-b']);
  okay(await s.call(api + '/deactivate', { profileIds: [s.profiles.a.profileId], accepted: true }));
  assert.equal(s.owner.localPrograms.groups.has('partial'), true); assert.equal(s.owner.localPrograms.groups.has(second.profile.groupId), true);
});

test('an existing active recipe joins a later matching business group without leaving its auxiliary group behind', async t => {
  const s = await scene(t); const original = await s.apply(s.profiles.a);
  await s.addGroup('business');
  const preview = okay(await s.call(api + '/preview', { profileId: s.profiles.c.profileId, replaceProfileIds: [] }));
  assert.deepEqual(preview.review.group.rebindProfileIds, [s.profiles.a.profileId]);
  okay(await s.call(api + '/apply', { reviewId: preview.reviewId, accepted: true }));
  assert.equal(s.owner.localPrograms.groups.has(original.profile.groupId), false);
  const groups = okay(await s.call('/manage/api/groups')).groups;
  assert.equal(groups.length, 1); assert.equal(groups[0].id, 'business'); assert.equal(groups[0].activeProfiles.length, 2);
  assert.equal(s.owner.resources.profile(s.profiles.a.profileId).ownsGroup, false);
});

test('ambiguous equal business groups require an explicit target and cannot silently replace a group recipe', async t => {
  const s = await scene(t); await s.addGroup('business-one'); await s.addGroup('business-two');
  const ambiguous = okay(await s.call(api + '/preview', { profileId: s.profiles.a.profileId }));
  assert.ok(ambiguous.review.conflicts.some(row => row.code === 'CONFIGURATION_GROUP_CHOICE_REQUIRED'));
  refused(await s.call(api + '/apply', { reviewId: ambiguous.reviewId, accepted: true }));
  await s.apply(s.profiles.a, { groupId: 'business-two' });
  assert.equal(s.owner.resources.profile(s.profiles.a.profileId).groupId, 'business-two');
  const conflicting = okay(await s.call(api + '/preview', { profileId: s.profiles.b.profileId, groupId: 'business-two', replaceProfileIds: [] }));
  assert.ok(conflicting.review.conflicts.some(row => row.code === 'ACTIVE_CONFIGURATION_GROUP_CONFLICT'));
});

test('failed configuration/deactivation commits restore groups, profile associations and the saved registry', async t => {
  const s = await scene(t); await s.apply(s.profiles.a);
  const local = s.owner.localPrograms, beforeGroups = local.groups, beforeResources = structuredClone(s.owner.resources.state);
  const registry = await readFile(join(local.directory, 'registry.json'));
  const preview = okay(await s.call(api + '/preview', { profileId: s.profiles.b.profileId, replaceProfileIds: [s.profiles.a.profileId] }));
  const save = local.save; local.save = async () => { throw Object.assign(new Error('Injected save failure'), { code: 'EIO' }); };
  try {
    refused(await s.call(api + '/apply', { reviewId: preview.reviewId, accepted: true }));
    assert.equal(local.groups, beforeGroups); assert.deepEqual(s.owner.resources.state, beforeResources);
    refused(await s.call(api + '/deactivate', { profileIds: [s.profiles.a.profileId], accepted: true }));
    assert.equal(local.groups, beforeGroups); assert.deepEqual(s.owner.resources.state, beforeResources);
  } finally { local.save = save; }
  assert.deepEqual(await readFile(join(local.directory, 'registry.json')), registry);
});
