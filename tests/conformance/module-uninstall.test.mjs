import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalPrograms } from '../../tools/launcher/local-programs.mjs';
import { ModuleUninstall } from '../../tools/launcher/module-uninstall.mjs';
import { normalizeModuleGroup } from '../../tools/launcher/module-groups.mjs';
import { publicStartupPlan, STARTUP_PLAN_FORMAT } from '../../tools/launcher/startup-plan.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { hash, ordinaryPath } from '../../scripts/runtime/paths.mjs';
import { ownProcess } from '../../scripts/runtime/process.mjs';

const contract = { id: 'uninstall.echo', version: '1.0.0' };
const base = resolve('.artifacts/module-uninstall-tests');
const processSource = `import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin}); const timer=setInterval(()=>{},10000);
input.on('line',line=>{if(JSON.parse(line).command==='stop'){clearInterval(timer);input.close();}});
input.on('close',()=>{clearInterval(timer);});
process.stdout.write(JSON.stringify({event:'module-ready'})+'\\n');
`;
async function fixture(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-')), revocations = [];
  const local = new LocalPrograms({ root, updateCredentials: async value => { revocations.push(structuredClone(value)); } });
  await local.initialize(); const uninstall = new ModuleUninstall({ localPrograms: local });
  t.after(async () => {
    for (const handle of local.handles.values()) if (!handle.exit) { try { await handle.stop(1000); } catch {} }
    const actual = await ordinaryPath(root); assert.equal(dirname(actual), await ordinaryPath(base));
    assert.ok(actual.startsWith(join(base, 'case-'))); await rm(actual, { recursive: true, force: false });
  });
  async function add(id, bindings = []) {
    const directory = local.path(id, 'module'); await mkdir(directory, { recursive: true });
    const manifest = { format: 'world-hub.module/v1', id: `uninstall.${id}`, version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
      runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [contract], requires: bindings.length ? [contract] : [],
      permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
    await writeFile(join(directory, 'module.json'), JSON.stringify(manifest)); await writeFile(join(directory, 'program.mjs'), processSource);
    const principal = `local.${id.slice(0, 35)}.${hash(id).slice(0, 8)}`;
    const row = { programId: id, principal, module: { id: manifest.id, version: manifest.version }, manifest, files: await collectSourceFiles(directory),
      environment: {}, settings: {}, topics: { events: 'uninstall/test' }, bridges: { main: { publish: ['events'], subscribe: ['events'] } }, bindings: structuredClone(bindings), state: 'stopped' };
    const identity = { programId: id, principal, token: randomBytes(32).toString('base64url') };
    await writeFile(local.path(id, 'identity.json'), JSON.stringify(identity)); await mkdir(local.path(id, 'state'));
    await writeFile(local.path(id, 'state', 'business.txt'), 'retain business data');
    local.records.set(id, row); local.identities.set(id, identity); await local.save(); return row;
  }
  function group(id, ids, after = {}, extra = {}) {
    const row = normalizeModuleGroup({ id, title: id, memberProgramIds: ids,
      startupPlan: { format: STARTUP_PLAN_FORMAT, members: ids.map(programId => ({ programId, enabled: true, after: after[programId] ?? [] })), startupOrder: ids,
        onFailure: 'continue-independent' }, ...extra }, [...local.records.keys()]);
    local.groups.set(id, row); return row;
  }
  async function running(id) {
    const handle = ownProcess(process.execPath, [local.path(id, 'module', 'program.mjs')], { cwd: local.path(id, 'module') });
    local.handles.set(id, handle); await handle.waitFor(event => event.event === 'module-ready', 5000);
    Object.assign(local.row(id), { state: 'running', pid: handle.pid, runId: 'run-' + id, communication: 'connected' }); return handle;
  }
  return { root, local, uninstall, revocations, add, group, running };
}
const binds = providerId => [{ providerId, contract }];

test('uninstall cyclic group in one registry commit, retaining source, identity, history and state', async t => {
  const scene = await fixture(t), { local, uninstall } = scene;
  await scene.add('a', binds('b')); await scene.add('b', binds('a')); scene.group('pair', ['a', 'b']);
  await mkdir(local.path('a', 'versions')); await writeFile(local.path('a', 'versions', 'history.json'), '["1.0.0"]');
  const review = await uninstall.preview('module-group', 'pair');
  assert.equal(review.review.blocked, false); assert.deepEqual(review.review.programIds, ['a', 'b']);
  const tokens = [...local.identities.values()].map(row => row.token);
  let saves = 0; const save = local.save.bind(local); local.save = async () => { saves++; await save(); };
  const result = await uninstall.apply('module-group', 'pair', { reviewId: review.reviewId, accepted: true });
  assert.equal(saves, 1); assert.equal(local.records.size, 0); assert.equal(local.identities.size, 0); assert.equal(local.groups.size, 0);
  assert.deepEqual(result.removedProgramIds, ['a', 'b']); assert.equal(result.retainsFiles, true); assert.equal(result.stopsHub, false);
  assert.deepEqual(scene.revocations[0].remove, ['local.a.' + hash('a').slice(0, 8), 'local.b.' + hash('b').slice(0, 8)]);
  for (const id of ['a', 'b']) {
    assert.equal(await readFile(local.path(id, 'state', 'business.txt'), 'utf8'), 'retain business data');
    assert.ok(await readFile(local.path(id, 'identity.json'))); assert.ok(await readFile(local.path(id, 'module', 'program.mjs')));
  }
  assert.equal(await readFile(local.path('a', 'versions', 'history.json'), 'utf8'), '["1.0.0"]');
  for (const token of tokens) assert.equal(JSON.stringify({ review, result }).includes(token), false);
});

test('default group uninstall retains shared members and transitive providers needed by retained consumers', async t => {
  const scene = await fixture(t), { uninstall, local } = scene;
  await scene.add('provider'); await scene.add('shared', binds('provider')); await scene.add('free'); await scene.add('external', binds('shared'));
  scene.group('whole', ['provider', 'shared', 'free']); scene.group('other', ['shared']);
  const before = await uninstall.preview('module-group', 'whole');
  assert.deepEqual(before.review.programIds, ['free']); assert.deepEqual(before.review.retainedPrograms.map(row => row.programId), ['provider', 'shared']);
  const forced = await uninstall.preview('module-group', 'whole', { programIds: ['shared'] }); assert.equal(forced.review.blocked, true);
  assert.ok(forced.review.blockers.some(row => row.code === 'UNINSTALL_SHARED_MEMBER'));
  await assert.rejects(uninstall.apply('module-group', 'whole', { reviewId: forced.reviewId, accepted: true }), { code: 'UNINSTALL_BLOCKED' });
  await uninstall.apply('module-group', 'whole', { reviewId: before.reviewId, accepted: true });
  assert.deepEqual([...local.records.keys()], ['provider', 'shared', 'external']); assert.deepEqual(local.groups.get('other').memberProgramIds, ['shared']);
  assert.equal(local.groups.has('whole'), false);
});

test('single uninstall detaches group membership and ordering references while preserving source origin mapping', async t => {
  const scene = await fixture(t), { uninstall, local } = scene;
  await scene.add('a'); await scene.add('b'); await scene.add('c');
  scene.group('first', ['a', 'b'], { b: ['a'] }, { origin: { id: 'author.group', version: '1.0.0', members: { 'original-a': 'a', 'original-b': 'b' } } });
  scene.group('second', ['a', 'c'], { c: ['a'] });
  local.startupPlanData = publicStartupPlan({ members: [{ programId: 'a', enabled: true, after: [] }, { programId: 'b', enabled: true, after: ['a'] }],
    startupOrder: ['a', 'b', 'c'], onFailure: 'continue-independent' }, ['a', 'b', 'c']);
  const review = await uninstall.preview('module', 'a'); assert.equal(review.review.groupsChanged.length, 2); assert.equal(review.review.startupReferences.length, 6);
  await uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true });
  assert.deepEqual(local.groups.get('first').memberProgramIds, ['b']); assert.deepEqual(local.groups.get('first').startupPlan.members[0].after, []);
  assert.equal(local.groups.get('first').origin.members['original-a'], 'a'); assert.deepEqual(local.groups.get('first').startupPlan.startupOrder, ['b']);
  assert.deepEqual(local.getStartupPlan().startupOrder, ['b', 'c']); assert.ok(local.getStartupPlan().members.every(row => !row.after.includes('a')));
});

test('owned running module requires stop consent and only stops the selected owned handle', async t => {
  const scene = await fixture(t), { uninstall, local } = scene;
  await scene.add('a'); await scene.add('b'); const a = await scene.running('a'), b = await scene.running('b');
  const review = await uninstall.preview('module', 'a'); assert.deepEqual(review.review.requiresStop, ['a']);
  await assert.rejects(uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true }), { code: 'UNINSTALL_STOP_REQUIRED' });
  assert.equal(a.exit, null); assert.equal(b.exit, null); assert.equal(scene.revocations.length, 0);
  const result = await uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true, stopOwned: true });
  assert.ok(a.exit); assert.equal(b.exit, null); assert.deepEqual(result.stoppedProgramIds, ['a']); assert.equal(local.row('b').state, 'running');
});

test('unknown ownership blocks removal, failed module without owned process remains removable', async t => {
  const scene = await fixture(t), { uninstall, local } = scene;
  await scene.add('a'); Object.assign(local.row('a'), { state: 'unknown', pid: process.pid });
  const blocked = await uninstall.preview('module', 'a'); assert.equal(blocked.review.blocked, true);
  await assert.rejects(uninstall.apply('module', 'a', { reviewId: blocked.reviewId, accepted: true, stopOwned: true }), { code: 'UNINSTALL_BLOCKED' });
  local.row('a').state = 'failed'; const review = await uninstall.preview('module', 'a'); assert.equal(review.review.blocked, false);
  await uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true }); assert.equal(local.records.size, 0);
});

test('source, configuration, identity, run identity, group plan and owned handle changes invalidate review', async t => {
  for (const change of ['source', 'configuration', 'identity', 'run', 'group', 'handle']) await t.test(change, async t => {
    const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a'); scene.group('g', ['a']);
    const review = await uninstall.preview('module', 'a');
    if (change === 'source') await writeFile(local.path('a', 'module', 'program.mjs'), '// changed source');
    if (change === 'configuration') local.row('a').settings.changed = true;
    if (change === 'identity') local.identities.get('a').token = randomBytes(32).toString('base64url');
    if (change === 'run') local.row('a').runId = 'another-run';
    if (change === 'group') scene.group('g', ['a'], {}, { title: 'Changed title' });
    if (change === 'handle') local.handles.set('a', { pid: 123, exit: { code: 0 } });
    await assert.rejects(uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true, stopOwned: true }), { code: 'UNINSTALL_REVIEW_CHANGED' });
    assert.equal(local.records.size, 1); assert.equal(scene.revocations.length, 0);
  });
});

test('registry failure restores maps and plans, retains files, leaves stopped process stopped and credentials revoked', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a'); scene.group('g', ['a']);
  const handle = await scene.running('a'), group = structuredClone(local.groups.get('g')), plan = structuredClone(local.startupPlanData);
  const review = await uninstall.preview('module', 'a'), save = local.save.bind(local);
  local.save = async () => { if (!local.records.has('a')) throw Object.assign(new Error('disk write failed'), { code: 'ENOSPC' }); await save(); };
  await assert.rejects(uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true, stopOwned: true }), error => {
    assert.equal(error.code, 'UNINSTALL_SAVE_FAILED'); assert.equal(error.credentialsRevoked, true); assert.equal(error.registrationsRetained, true); assert.deepEqual(error.stoppedProgramIds, ['a']); return true;
  });
  assert.equal(local.row('a').state, 'stopped'); assert.ok(handle.exit); assert.equal(local.handles.get('a'), handle); assert.ok(local.identities.has('a'));
  assert.deepEqual(local.groups.get('g'), group); assert.deepEqual(local.startupPlanData, plan); assert.equal(scene.revocations.length, 1);
  assert.equal(await readFile(local.path('a', 'state', 'business.txt'), 'utf8'), 'retain business data');
});

test('stop failure preserves all registrations and never revokes credentials or stops unrelated instances', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a'); await scene.add('b'); scene.group('g', ['a', 'b']);
  local.row('a').state = 'running'; local.handles.set('a', { pid: 123, exit: null, stop: async () => { throw new Error('stop failed'); } });
  const review = await uninstall.preview('module-group', 'g');
  await assert.rejects(uninstall.apply('module-group', 'g', { reviewId: review.reviewId, accepted: true, stopOwned: true }), { code: 'UNINSTALL_STOP_FAILED' });
  assert.equal(local.records.size, 2); assert.equal(local.groups.size, 1); assert.equal(scene.revocations.length, 0);
  local.handles.delete('a');
});

test('pending member and group version transactions block uninstall and group detachment', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a'); await scene.add('b'); scene.group('g', ['a', 'b']);
  local.assertVersionReady = async id => { if (id === 'b') throw Object.assign(new Error('pending version'), { code: 'VERSION_RECOVERY_REQUIRED' }); };
  const review = await uninstall.preview('module', 'a'); assert.equal(review.review.blocked, true); assert.ok(review.review.blockers.some(row => row.programId === 'b'));
  local.assertVersionReady = async () => {}; local.versionGroupRecoveryGuard = async () => { throw Object.assign(new Error('pending group'), { code: 'VERSION_RECOVERY_REQUIRED' }); };
  const next = await uninstall.preview('module', 'a'); assert.ok(next.review.blockers.some(row => row.groupId === 'g'));
});

test('peer wiring changes during owned stop invalidate removal after stopping and retain registrations', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a'); await scene.add('b');
  local.row('a').state = 'running';
  const handle = { pid: 123, exit: null, stop: async () => { handle.exit = { code: 0 }; local.row('b').settings.changedDuringStop = true; }, stdout: '', stderr: '', truncated: false };
  local.handles.set('a', handle); const review = await uninstall.preview('module', 'a');
  await assert.rejects(uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true, stopOwned: true }), { code: 'UNINSTALL_REVIEW_CHANGED' });
  assert.equal(local.records.size, 2); assert.equal(local.row('a').state, 'stopped'); assert.equal(scene.revocations.length, 0);
});

test('empty group selection removes only the group; empty standalone selection is rejected', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a'); scene.group('g', ['a']);
  await assert.rejects(uninstall.preview('module', 'a', { programIds: [] }), { code: 'UNINSTALL_SELECTION_INVALID' });
  const review = await uninstall.preview('module-group', 'g', { programIds: [] }); const result = await uninstall.apply('module-group', 'g', { reviewId: review.reviewId, accepted: true });
  assert.deepEqual(result.removedProgramIds, []); assert.equal(local.records.size, 1); assert.equal(local.groups.size, 0); assert.equal(scene.revocations.length, 0);
});

test('unreadable source can be unregistered without reconstructing or deleting application directories', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a');
  const directory = await ordinaryPath(local.path('a', 'module')); assert.equal(dirname(directory), await ordinaryPath(local.path('a')));
  await rm(directory, { recursive: true, force: false });
  const review = await uninstall.preview('module', 'a'); assert.equal(review.review.blocked, false);
  const result = await uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true });
  assert.deepEqual(result.removedProgramIds, ['a']);
  await assert.rejects(readFile(local.path('a', 'module', 'program.mjs')), { code: 'ENOENT' });
  assert.equal(await readFile(local.path('a', 'state', 'business.txt'), 'utf8'), 'retain business data');
  assert.ok(await readFile(local.path('a', 'identity.json')));
});

test('health observation timestamps do not invalidate uninstall review', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a'); await scene.add('b');
  local.row('b').communicationObservedAt = '2026-10-19T01:00:00.000Z';
  const review = await uninstall.preview('module', 'a');
  local.row('b').communicationObservedAt = '2026-10-19T01:00:01.000Z';
  const result = await uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true });
  assert.deepEqual(result.removedProgramIds, ['a']); assert.ok(local.records.has('b'));
});

test('selected stopped module becoming unknown during credential revocation retains registration', async t => {
  const scene = await fixture(t), { uninstall, local } = scene; await scene.add('a');
  const review = await uninstall.preview('module', 'a');
  local.updateCredentials = async () => { local.row('a').state = 'unknown'; };
  await assert.rejects(uninstall.apply('module', 'a', { reviewId: review.reviewId, accepted: true }), { code: 'UNINSTALL_REVIEW_CHANGED' });
  assert.ok(local.records.has('a')); assert.equal(local.row('a').state, 'unknown');
});
