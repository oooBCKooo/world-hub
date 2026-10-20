import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalPrograms } from '../../tools/launcher/local-programs.mjs';
import { WiringDefaults } from '../../tools/launcher/wiring-defaults.mjs';
import { ModuleGroups, normalizeModuleGroup, moduleGroupWiringBaseline } from '../../tools/launcher/module-groups.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { hash, ordinaryPath } from '../../scripts/runtime/paths.mjs';
import { publishArtifact } from '../../scripts/runtime/sources.mjs';
import { zipDirectory } from '../../scripts/release/zip.mjs';

const base = resolve('.artifacts/wiring-defaults-tests'), contract = { id: 'defaults.echo', version: '1.0.0' };
const json = value => JSON.stringify(value, null, 2) + '\n', clone = value => structuredClone(value);
const bridge = { main: { publish: ['events'], subscribe: ['events'] } }, bindings = providerId => [{ providerId, contract }];
async function fixture(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-')), revocations = [];
  const local = new LocalPrograms({ root, updateCredentials: async value => { revocations.push(clone(value)); } });
  await local.initialize(); const defaults = new WiringDefaults({ root, localPrograms: local });
  t.after(async () => {
    const actual = await ordinaryPath(root); assert.equal(dirname(actual), await ordinaryPath(base));
    assert.ok(actual.startsWith(join(base, 'case-'))); await rm(actual, { recursive: true, force: false });
  });
  async function add(id, options = {}) {
    const directory = local.path(id, 'module'); await mkdir(directory, { recursive: true });
    const manifest = { format: 'world-hub.module/v1', id: options.moduleId ?? `defaults.${id}`, version: options.version ?? '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
      runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: options.provides ?? [], requires: options.requires ?? [],
      permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
    const deployment = { format: 'world-hub.deployment/v1', title: { en: id }, description: { en: 'Wiring default fixture' }, topics: { events: options.topic ?? `author/${id}` }, bridges: clone(bridge),
      settings: [{ key: 'label', type: 'string', label: { en: 'Label' }, default: 'author' }], ...(options.connections ? { connections: options.connections } : {}) };
    await writeFile(join(directory, 'module.json'), json(manifest)); await writeFile(join(directory, 'program.mjs'), 'process.exit(0);\n');
    if (!options.noDeployment) await writeFile(join(directory, 'deployment.json'), json(deployment));
    const principal = `local.${id.slice(0, 35)}.${hash(id).slice(0, 8)}`;
    const row = { programId: id, principal, module: { id: manifest.id, version: manifest.version }, manifest, deployment: options.noDeployment ? null : deployment,
      files: await collectSourceFiles(directory), environment: {}, settings: { label: 'my setting' }, topics: { events: options.currentTopic ?? `custom/${id}` }, bridges: clone(bridge),
      bindings: options.bindings ?? [], state: 'stopped' };
    const identity = { programId: id, principal, token: randomBytes(32).toString('base64url') };
    await writeFile(local.path(id, 'identity.json'), json(identity)); await mkdir(local.path(id, 'state')); await writeFile(local.path(id, 'state', 'private.txt'), 'private application state');
    local.records.set(id, row); local.identities.set(id, identity); await local.save(); return row;
  }
  function group(id, ids, options = {}) {
    const members = options.members ?? ids.map(programId => ({ id: programId, moduleId: local.row(programId).module.id, version: local.row(programId).module.version,
      configuration: { topics: { events: options.topic ?? `group/${id}` }, bridges: clone(bridge), bindings: options.bindings?.[programId] ?? [], settings: {} } }));
    const origin = options.local ? undefined : { id: options.originId ?? `defaults.group.${id}`, version: options.version ?? '1.0.0', members: options.mapping ?? Object.fromEntries(ids.map(programId => [programId, programId])) };
    const row = normalizeModuleGroup({ id, title: id, memberProgramIds: ids, ...(origin ? { origin } : {}),
      ...(origin && !options.missingBaseline ? { wiringBaseline: moduleGroupWiringBaseline({ id: origin.id, version: origin.version, modules: members }) } : {}) }, [...local.records.keys()]);
    local.groups.set(id, row); return row;
  }
  async function sourceFor(group, { topic = `group/${group.id}`, suffix = 'source' } = {}) {
    const directory = join(root, suffix), modules = []; await mkdir(directory, { recursive: true });
    for (const [logical, id] of Object.entries(group.origin.members)) {
      const row = local.row(id), relative = `modules/${logical}`; await cp(local.path(id, 'module'), join(directory, relative), { recursive: true });
      modules.push({ id: logical, path: relative, moduleId: row.module.id, version: row.module.version,
        configuration: { topics: { events: topic }, bridges: clone(bridge), bindings: [], settings: { label: 'author' } } });
    }
    const manifest = { format: 'world-hub.module-group/v1', id: group.origin.id, version: group.origin.version, title: group.title, license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
      provides: [], requires: [], modules, startupPlan: { members: modules.map(member => ({ programId: member.id, enabled: false, after: [] })), startupOrder: modules.map(member => member.id), onFailure: 'continue-independent' } };
    await writeFile(join(directory, 'module-group.json'), json(manifest)); return { directory, manifest };
  }
  const apply = reviewed => defaults.apply({ reviewId: reviewed.reviewId, accepted: true });
  return { root, local, defaults, revocations, add, group, sourceFor, apply };
}
const connection = (moduleId, { id = 'link', contracts = [], topics = { events: 'events' } } = {}) => ({ id, provider: { moduleId, version: '1.0.0' }, contracts, topics });

test('restore only author wiring, keeping settings, source, identity, private data and startup plan', async t => {
  const scene = await fixture(t), { local, defaults } = scene; const old = await scene.add('one');
  old.bridges = { main: { publish: [], subscribe: ['events'] } };
  const source = json(old.files), identity = await readFile(local.path('one', 'identity.json'), 'utf8'), startup = json(local.startupPlanData);
  const review = await defaults.preview({ scope: 'module', targetId: 'one' });
  assert.equal(review.review.blocked, false); assert.equal(review.review.programs[0].changed, true);
  assert.deepEqual(review.review.programs[0].source, { kind: 'module', id: 'defaults.one', version: '1.0.0' });
  assert.deepEqual(review.review.programs[0].after, { topics: { events: 'author/one' }, bridges: bridge, bindings: [] });
  assert.equal(JSON.stringify(review).includes(local.identities.get('one').token), false);
  const applied = await scene.apply(review); assert.deepEqual(applied.programIds, ['one']);
  assert.deepEqual(local.row('one').settings, { label: 'my setting' }); assert.equal(json(local.row('one').files), source);
  assert.equal(await readFile(local.path('one', 'identity.json'), 'utf8'), identity); assert.equal(json(local.startupPlanData), startup);
  assert.equal(await readFile(local.path('one', 'state', 'private.txt'), 'utf8'), 'private application state');
  assert.deepEqual(scene.revocations[0].remove, [old.principal]); assert.equal(applied.startsModules, false);
});

test('whole batch restores provider topic before resolving module default connections', async t => {
  const scene = await fixture(t), { defaults, local } = scene;
  await scene.add('consumer', { requires: [contract], bindings: bindings('provider'), connections: [connection('defaults.provider', { contracts: [contract] })] });
  await scene.add('provider', { provides: [contract], topic: 'author/shared' });
  const review = await defaults.preview({ scope: 'all' }); assert.equal(review.review.blocked, false, json(review));
  assert.equal(review.review.connections[0].providerId, 'provider');
  assert.equal(review.review.programs.find(row => row.programId === 'consumer').after.topics.events, 'author/shared');
  await scene.apply(review); assert.equal(local.row('consumer').topics.events, local.row('provider').topics.events);
});

test('inverse-order multi-hop connections converge to final author topics', async t => {
  const scene = await fixture(t);
  await scene.add('a', { connections: [connection('defaults.b')] });
  await scene.add('b', { connections: [connection('defaults.c')] });
  await scene.add('c', { topic: 'author/final' });
  const result = await scene.defaults.preview({ scope: 'all' }); assert.equal(result.review.blocked, false, json(result));
  for (const row of result.review.programs) assert.equal(row.after.topics.events, 'author/final');
});

test('conflicting connection cycle is blocked instead of selecting by registry order', async t => {
  const scene = await fixture(t);
  await scene.add('a', { connections: [connection('defaults.b')] }); await scene.add('b', { connections: [connection('defaults.a')] });
  const reviewed = await scene.defaults.preview({ scope: 'all' });
  assert.ok(reviewed.review.blockers.some(row => row.code === 'WIRING_CONNECTION_CYCLE'));
  await assert.rejects(scene.apply(reviewed), { code: 'WIRING_DEFAULTS_BLOCKED' }); assert.equal(scene.revocations.length, 0);
});

test('ambiguous and missing default providers block, exact selection resolves without retaining old connection binding', async t => {
  const scene = await fixture(t); await scene.add('left', { moduleId: 'defaults.provider', provides: [contract] }); await scene.add('right', { moduleId: 'defaults.provider', provides: [contract] });
  await scene.add('consumer', { requires: [contract], bindings: bindings('left'), connections: [connection('defaults.provider', { contracts: [contract] })] });
  const ambiguous = await scene.defaults.preview({ scope: 'module', targetId: 'consumer' });
  assert.equal(ambiguous.review.connections[0].status, 'ambiguous'); assert.equal(ambiguous.review.connections[0].candidates.length, 2);
  const chosen = await scene.defaults.preview({ scope: 'module', targetId: 'consumer', connectionSelections: { consumer: { link: 'right' } } });
  assert.equal(chosen.review.blocked, false, json(chosen)); assert.deepEqual(chosen.review.programs[0].after.bindings, bindings('right'));
  await scene.apply(chosen); assert.deepEqual(scene.local.row('consumer').bindings, bindings('right'));
  scene.local.records.delete('left'); scene.local.records.delete('right'); scene.local.identities.delete('left'); scene.local.identities.delete('right');
  const missing = await scene.defaults.preview({ scope: 'module', targetId: 'consumer' }); assert.equal(missing.review.connections[0].status, 'missing'); assert.equal(missing.review.blocked, true);
});

test('retain existing required contract choices not covered by author connections', async t => {
  const scene = await fixture(t); await scene.add('provider', { provides: [contract] }); await scene.add('consumer', { requires: [contract], bindings: bindings('provider') });
  const reviewed = await scene.defaults.preview({ scope: 'module', targetId: 'consumer' });
  assert.equal(reviewed.review.blocked, false); assert.deepEqual(reviewed.review.programs[0].after.bindings, bindings('provider'));
  scene.local.row('consumer').bindings = [];
  const missing = await scene.defaults.preview({ scope: 'module', targetId: 'consumer' });
  assert.ok(missing.review.blockers.some(row => row.code === 'LOCAL_PROVIDER_REQUIRED'));
});

test('group recipe outranks module defaults and maps logical capability providers', async t => {
  const scene = await fixture(t); await scene.add('instance-p', { provides: [contract] }); await scene.add('instance-c', { requires: [contract], bindings: bindings('instance-p') });
  scene.group('pair', ['instance-p', 'instance-c'], { mapping: { provider: 'instance-p', consumer: 'instance-c' }, members: [
    { id: 'provider', moduleId: 'defaults.instance-p', version: '1.0.0', configuration: { topics: { events: 'group/channel' }, bridges: bridge, bindings: [], settings: {} } },
    { id: 'consumer', moduleId: 'defaults.instance-c', version: '1.0.0', configuration: { topics: { events: 'group/channel' }, bridges: bridge, bindings: bindings('provider'), settings: {} } }
  ] });
  const reviewed = await scene.defaults.preview({ scope: 'group', targetId: 'pair' }); assert.equal(reviewed.review.blocked, false, json(reviewed));
  assert.ok(reviewed.review.programs.every(row => row.source.kind === 'module-group' && row.after.topics.events === 'group/channel'));
  assert.deepEqual(reviewed.review.programs[1].after.bindings, bindings('instance-p'));
  const standalone = await scene.defaults.preview({ scope: 'module', targetId: 'instance-c' }); assert.equal(standalone.review.programs[0].source.kind, 'module');
  assert.equal(standalone.review.programs[0].after.topics.events, 'author/instance-c');
});

test('all-scope shared group recipe conflict blocks, explicit group restores its recipe and lists affected group', async t => {
  const scene = await fixture(t); await scene.add('shared'); scene.group('left', ['shared']); scene.group('right', ['shared']);
  const all = await scene.defaults.preview({ scope: 'all' }); assert.ok(all.review.blockers.some(row => row.code === 'WIRING_GROUP_DEFAULT_CONFLICT'));
  const left = await scene.defaults.preview({ scope: 'group', targetId: 'left' }); assert.equal(left.review.blocked, false, json(left));
  assert.deepEqual(left.review.programs[0].affected.sharedWithGroups, [{ id: 'right', title: 'right' }]);
  await scene.apply(left); assert.equal(scene.local.row('shared').topics.events, 'group/left');
});

test('detached author provider and independently changed member version block without re-adding members', async t => {
  const scene = await fixture(t); await scene.add('provider', { provides: [contract] }); await scene.add('consumer', { requires: [contract], bindings: bindings('provider') });
  const group = scene.group('pair', ['provider', 'consumer'], { bindings: { consumer: bindings('provider') } });
  scene.local.groups.set('pair', normalizeModuleGroup({ ...group, memberProgramIds: ['consumer'], startupPlan: undefined }, [...scene.local.records.keys()]));
  const reviewed = await scene.defaults.preview({ scope: 'group', targetId: 'pair' });
  assert.ok(reviewed.review.blockers.some(row => row.code === 'WIRING_GROUP_PROVIDER_MISSING'));
  assert.deepEqual(scene.local.groups.get('pair').memberProgramIds, ['consumer']);
  scene.local.row('consumer').module.version = '2.0.0';
  const mismatch = await scene.defaults.preview({ scope: 'group', targetId: 'pair' });
  assert.ok(mismatch.review.blockers.some(row => row.code === 'WIRING_GROUP_MEMBER_VERSION_MISMATCH'));
});

test('local-only group uses member author defaults and new local members use their own defaults', async t => {
  const scene = await fixture(t); await scene.add('first'); await scene.add('extra');
  const group = scene.group('local', ['first'], { local: true });
  scene.local.groups.set('local', normalizeModuleGroup({ ...group, memberProgramIds: ['first', 'extra'], startupPlan: undefined }, [...scene.local.records.keys()]));
  const reviewed = await scene.defaults.preview({ scope: 'group', targetId: 'local' }); assert.equal(reviewed.review.blocked, false);
  assert.ok(reviewed.review.programs.every(row => row.source.kind === 'module'));
});

test('old group needs exact author artifact to establish reviewed baseline; ordinary group save cannot replace it', async t => {
  const scene = await fixture(t); await scene.add('one'); const group = scene.group('old', ['one'], { missingBaseline: true });
  const absent = await scene.defaults.preview({ scope: 'group', targetId: 'old' }); assert.deepEqual(absent.review.missingGroupSources, [{ groupId: 'old', id: group.origin.id, version: '1.0.0' }]);
  const source = await scene.sourceFor(group), reviewed = await scene.defaults.preview({ scope: 'group', targetId: 'old', groupSources: { old: source.directory } });
  assert.equal(reviewed.review.blocked, false, json(reviewed)); assert.deepEqual(reviewed.review.groupBaselinesEstablished, ['old']);
  await scene.apply(reviewed); const current = scene.local.groups.get('old'); assert.ok(current.wiringBaseline);
  const edited = clone(current); edited.wiringBaseline.members[0].topics.events = 'forged/topic';
  await new ModuleGroups({ localPrograms: scene.local }).save({ group: edited, expectedRevision: current.revision });
  assert.equal(scene.local.groups.get('old').wiringBaseline.members[0].topics.events, 'group/old');
  assert.notEqual(current.revision, group.revision);
});

test('provided old-group artifact must match author member source bytes and exact source version', async t => {
  const scene = await fixture(t); await scene.add('one'); const group = scene.group('old', ['one'], { missingBaseline: true }), source = await scene.sourceFor(group);
  await writeFile(join(source.directory, 'modules', 'one', 'program.mjs'), 'changed source at same version\n');
  const wrongBytes = await scene.defaults.preview({ scope: 'group', targetId: 'old', groupSources: { old: source.directory } });
  assert.ok(wrongBytes.review.blockers.some(row => row.code === 'WIRING_GROUP_SOURCE_MEMBER_MISMATCH'));
  source.manifest.version = '2.0.0'; await writeFile(join(source.directory, 'module-group.json'), json(source.manifest));
  const wrongVersion = await scene.defaults.preview({ scope: 'group', targetId: 'old', groupSources: { old: source.directory } });
  assert.ok(wrongVersion.review.blockers.some(row => row.code === 'WIRING_GROUP_SOURCE_MISMATCH'));
});

test('changed running module blocks; unchanged running member does not prevent restoring a stopped peer', async t => {
  const scene = await fixture(t); const one = await scene.add('one', { currentTopic: 'author/one' }), two = await scene.add('two'); one.state = 'running';
  scene.local.handles.set('one', { pid: 100, exit: null });
  const reviewed = await scene.defaults.preview({ scope: 'all' }); assert.equal(reviewed.review.blocked, false); assert.deepEqual(reviewed.review.requiresStop, []);
  await scene.apply(reviewed); assert.equal(scene.local.row('one').state, 'running'); assert.equal(scene.local.row('two').topics.events, 'author/two');
  two.topics.events = 'custom/two'; two.state = 'unknown'; scene.local.records.set('two', two);
  const blocked = await scene.defaults.preview({ scope: 'all' }); assert.deepEqual(blocked.review.requiresStop, ['two']);
});

test('missing defaults, modified installed source and pending version recovery are explicit blockers', async t => {
  const scene = await fixture(t); await scene.add('missing', { noDeployment: true }); await scene.add('changed'); await scene.add('pending');
  await writeFile(scene.local.path('changed', 'module', 'program.mjs'), '// external code edit\n');
  scene.local.versionRecoveryGuard = async id => { if (id === 'pending') throw Object.assign(new Error('Recover pending version.'), { code: 'VERSION_RECOVERY_REQUIRED' }); };
  const reviewed = await scene.defaults.preview({ scope: 'all' });
  for (const code of ['WIRING_MODULE_DEFAULTS_MISSING', 'LOCAL_INSTALLED_CODE_CHANGED', 'VERSION_RECOVERY_REQUIRED']) assert.ok(reviewed.review.blockers.some(row => row.code === code), code);
});

for (const mutation of ['source', 'wiring', 'identity', 'group', 'handle', 'pending']) test(`stale review rejects ${mutation} changes before revocation`, async t => {
  const scene = await fixture(t); await scene.add('one'); const reviewed = await scene.defaults.preview({ scope: 'module', targetId: 'one' });
  if (mutation === 'source') await writeFile(scene.local.path('one', 'module', 'program.mjs'), '// mutation\n');
  if (mutation === 'wiring') scene.local.row('one').topics.events = 'changed/topic';
  if (mutation === 'identity') scene.local.identities.get('one').token = randomBytes(32).toString('base64url');
  if (mutation === 'group') scene.group('new', ['one'], { local: true });
  if (mutation === 'handle') scene.local.handles.set('one', { pid: 1, exit: { code: 0 } });
  if (mutation === 'pending') scene.local.versionRecoveryGuard = async () => { throw Object.assign(new Error('pending'), { code: 'VERSION_RECOVERY_REQUIRED' }); };
  await assert.rejects(scene.apply(reviewed), { code: 'WIRING_REVIEW_CHANGED' }); assert.equal(scene.revocations.length, 0); assert.equal(scene.local.row('one').topics.events.startsWith('author/'), false);
});

test('source artifact changes after old-group review reject apply', async t => {
  const scene = await fixture(t); await scene.add('one'); const group = scene.group('old', ['one'], { missingBaseline: true }), source = await scene.sourceFor(group);
  const reviewed = await scene.defaults.preview({ scope: 'group', targetId: 'old', groupSources: { old: source.directory } });
  source.manifest.modules[0].configuration.topics.events = 'changed/recipe'; await writeFile(join(source.directory, 'module-group.json'), json(source.manifest));
  await assert.rejects(scene.apply(reviewed), { code: 'WIRING_REVIEW_CHANGED' }); assert.equal(scene.local.groups.get('old').wiringBaseline, undefined);
});

test('communication observation time alone does not invalidate a review', async t => {
  const scene = await fixture(t); await scene.add('one'); const reviewed = await scene.defaults.preview({ scope: 'module', targetId: 'one' });
  scene.local.row('one').communicationObservedAt = new Date().toISOString(); await scene.apply(reviewed); assert.equal(scene.local.row('one').topics.events, 'author/one');
});

test('credential revocation await is followed by stale recheck with no wiring commit', async t => {
  const scene = await fixture(t); await scene.add('one'); const reviewed = await scene.defaults.preview({ scope: 'module', targetId: 'one' });
  scene.local.updateCredentials = async () => { scene.local.row('one').topics.events = 'outside/edit'; };
  await assert.rejects(scene.apply(reviewed), { code: 'WIRING_REVIEW_CHANGED' }); assert.equal(scene.local.row('one').topics.events, 'outside/edit');
});

test('one atomic registry save failure restores every module wiring and group baseline; revoked grants stay revoked', async t => {
  const scene = await fixture(t); await scene.add('one'); await scene.add('two'); const group = scene.group('old', ['one', 'two'], { missingBaseline: true }), source = await scene.sourceFor(group);
  const reviewed = await scene.defaults.preview({ scope: 'group', targetId: 'old', groupSources: { old: source.directory } });
  let calls = 0; scene.local.save = async () => { calls++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(scene.apply(reviewed), error => error.code === 'WIRING_SAVE_FAILED' && error.credentialsRevoked === true);
  assert.equal(calls, 1); assert.equal(scene.local.row('one').topics.events, 'custom/one'); assert.equal(scene.local.row('two').topics.events, 'custom/two');
  assert.equal(scene.local.groups.get('old').wiringBaseline, undefined); assert.equal(scene.revocations[0].remove.length, 2);
});

test('expired, unaccepted and malformed review requests never change wiring', async t => {
  const scene = await fixture(t); await scene.add('one'); const reviewed = await scene.defaults.preview({ scope: 'module', targetId: 'one' });
  await assert.rejects(scene.defaults.apply({ reviewId: reviewed.reviewId, accepted: false }), { code: 'TRUST_REQUIRED' });
  scene.defaults.reviews.get(reviewed.reviewId).createdAt -= 600001;
  await assert.rejects(scene.apply(reviewed), { code: 'WIRING_REVIEW_REQUIRED' });
  await assert.rejects(scene.defaults.preview({ scope: 'all', programIds: ['one'] }), { code: 'WIRING_DEFAULTS_INPUT_INVALID' });
  assert.equal(scene.local.row('one').topics.events, 'custom/one');
});

test('semantic map and ACL order differences do not change running wiring or cause shared-group conflicts', async t => {
  const scene = await fixture(t), row = await scene.add('shared');
  const topics = { events: 'author/shared', other: 'author/other' }, bridges = { main: { publish: ['events', 'other'], subscribe: ['events', 'other'] } };
  row.deployment.topics = topics; row.deployment.bridges = bridges;
  await writeFile(scene.local.path('shared', 'module', 'deployment.json'), json(row.deployment)); row.files = await collectSourceFiles(scene.local.path('shared', 'module'));
  row.topics = { other: 'author/other', events: 'author/shared' }; row.bridges = { main: { subscribe: ['other', 'events'], publish: ['other', 'events'] } }; row.state = 'running';
  scene.local.handles.set('shared', { pid: 1, exit: null });
  const module = await scene.defaults.preview({ scope: 'module', targetId: 'shared' });
  assert.equal(module.review.programs[0].changed, false); assert.equal(module.review.blocked, false); assert.deepEqual(module.review.requiresStop, []);
  const members = config => [{ id: 'shared', moduleId: row.module.id, version: row.module.version, configuration: { ...config, bindings: [], settings: {} } }];
  scene.group('left', ['shared'], { members: members({ topics, bridges }) });
  scene.group('right', ['shared'], { members: members({ topics: row.topics, bridges: row.bridges }) });
  const all = await scene.defaults.preview({ scope: 'all' });
  assert.equal(all.review.programs[0].changed, false); assert.equal(all.review.blocked, false, json(all));
});

for (const format of ['zip', 'json']) test(`establish old-group baseline from ${format} artifact with original bytes rechecked at apply`, async t => {
  const scene = await fixture(t); await scene.add('one'); const group = scene.group('old', ['one'], { missingBaseline: true }), source = await scene.sourceFor(group);
  let path;
  if (format === 'zip') { path = join(scene.root, 'author-group.zip'); await zipDirectory(source.directory, path); }
  else path = (await publishArtifact(source.directory, { kind: 'module-group', destination: join(scene.root, 'published'), redistributionAcknowledged: true })).artifactPath;
  const input = { scope: 'group', targetId: 'old', groupSources: { old: path } }, reviewed = await scene.defaults.preview(input);
  assert.equal(reviewed.review.blocked, false, json(reviewed));
  const bytes = await readFile(path);
  if (format === 'zip') { bytes.writeUInt16LE(1, 10); await writeFile(path, bytes); } else await writeFile(path, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(scene.apply(reviewed), { code: 'WIRING_REVIEW_CHANGED' }); assert.equal(scene.revocations.length, 0);
  const current = await scene.defaults.preview(input); assert.equal(current.review.blocked, false, json(current)); await scene.apply(current);
  assert.equal(scene.local.groups.get('old').wiringBaseline.id, group.origin.id); assert.equal(scene.local.row('one').topics.events, 'group/old');
});

test('a credential update failure retains current wiring without a registry save or automatic reauthorization', async t => {
  const scene = await fixture(t); await scene.add('one'); const reviewed = await scene.defaults.preview({ scope: 'module', targetId: 'one' });
  let saved = 0, grants = 0; scene.local.save = async () => { saved++; }; scene.local.updateCredentials = async () => { grants++; throw Object.assign(new Error('unavailable'), { code: 'EIO' }); };
  await assert.rejects(scene.apply(reviewed), error => error.code === 'WIRING_CREDENTIALS_FAILED' && error.credentialsMayBeRevoked === true);
  assert.equal(saved, 0); assert.equal(grants, 1); assert.equal(scene.local.row('one').topics.events, 'custom/one');
});

test('constructor instance IDs do not inherit choices from the input dictionary prototype', async t => {
  const scene = await fixture(t); await scene.add('constructor'); await scene.add('other');
  const reviewed = await scene.defaults.preview({ scope: 'all', connectionSelections: { other: {} } });
  assert.equal(reviewed.review.blocked, false, json(reviewed)); await scene.apply(reviewed);
  assert.equal(scene.local.row('constructor').topics.events, 'author/constructor');
});

test('constructor group ID reports missing author source and accepts an explicit source path', async t => {
  const scene = await fixture(t); await scene.add('one'); const group = scene.group('constructor', ['one'], { missingBaseline: true });
  const absent = await scene.defaults.preview({ scope: 'group', targetId: 'constructor', groupSources: {} });
  assert.deepEqual(absent.review.missingGroupSources, [{ groupId: 'constructor', id: group.origin.id, version: group.origin.version }]);
  const source = await scene.sourceFor(group);
  const reviewed = await scene.defaults.preview({ scope: 'group', targetId: 'constructor', groupSources: { constructor: source.directory } });
  assert.equal(reviewed.review.blocked, false, json(reviewed)); await scene.apply(reviewed);
  assert.ok(scene.local.groups.get('constructor').wiringBaseline);
});

test('explicit constructor connection ID and constructor provider instance choices are honored', async t => {
  const scene = await fixture(t); await scene.add('constructor', { moduleId: 'defaults.provider', provides: [contract] }); await scene.add('second', { moduleId: 'defaults.provider', provides: [contract] });
  await scene.add('consumer', { requires: [contract], bindings: bindings('second'), connections: [connection('defaults.provider', { id: 'constructor', contracts: [contract] })] });
  const reviewed = await scene.defaults.preview({ scope: 'module', targetId: 'consumer', connectionSelections: { consumer: { constructor: 'constructor' } } });
  assert.equal(reviewed.review.blocked, false, json(reviewed)); await scene.apply(reviewed);
  assert.deepEqual(scene.local.row('consumer').bindings, bindings('constructor'));
});
