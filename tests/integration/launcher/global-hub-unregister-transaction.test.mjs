import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { workspace, ROOT, environment } from './helpers.mjs';

test('failed global unregister restores exact registry map order, identities, retained handles and explicit startup plan before retry', { timeout: 15000 }, async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); app.cleanups.push(() => manager.close());
  for (const programId of ['a', 'b', 'c']) {
    const review = await manager.localPrograms.preview({ programId, directory: join(ROOT, 'examples/ecosystem-pack/modules/source') });
    await manager.localPrograms.register({ reviewId: review.reviewId, accepted: true });
  }
  const original = manager.localPrograms.getStartupPlan();
  await manager.programStartupPlanSave({ plan: { ...original, startupOrder: ['b', 'a', 'c'], members: original.members.map(row => ({ ...row, enabled: row.programId !== 'c' })) }, expectedRevision: original.revision });
  const programs = manager.localPrograms, maps = Object.fromEntries(['records', 'identities', 'handles'].map(key => [key, programs[key]]));
  const credentialCalls = []; programs.updateCredentials = async change => { credentialCalls.push(structuredClone(change)); };
  const retained = { exit: { code: 0 }, cleanupIncomplete: false }; programs.handles.set('b', retained);
  const before = { startupPlanData: programs.startupPlanData, records: [...programs.records], identities: [...programs.identities], handles: [...programs.handles], plan: programs.getStartupPlan() };
  const registryPath = join(app.root, 'local-programs/registry.json'), registry = await readFile(registryPath), identity = await readFile(programs.path('b', 'identity.json'));
  const save = programs.save; programs.save = async () => { throw Object.assign(new Error('Injected registry permission error'), { code: 'EACCES' }); };
  await assert.rejects(programs.remove('b'), { code: 'EACCES' }); programs.save = save;
  assert.equal(programs.startupPlanData, before.startupPlanData);
  assert.deepEqual(programs.getStartupPlan(), before.plan);
  for (const key of ['records', 'identities', 'handles']) {
    assert.equal(programs[key], maps[key], 'Restore the existing Map identity');
    assert.deepEqual([...programs[key].keys()], before[key].map(([id]) => id), 'Restore exact declaration order');
    for (const [id, value] of before[key]) assert.equal(programs[key].get(id), value, 'Retain original ownership and identity references');
  }
  assert.deepEqual(await readFile(registryPath), registry); assert.deepEqual(await readFile(programs.path('b', 'identity.json')), identity);
  assert.equal(manager.hub, null); assert.equal(programs.handles.get('b'), retained);
  const result = await programs.remove('b'); assert.equal(result.removed, true);
  assert.deepEqual([...programs.records.keys()], ['a', 'c']); assert.deepEqual(programs.getStartupPlan().startupOrder, ['a', 'c']);
  assert.equal(programs.identities.has('b'), false); assert.equal(programs.handles.has('b'), false);
  await access(result.retainedDirectory); assert.deepEqual(await readFile(programs.path('b', 'identity.json')), identity);
  assert.equal(manager.hub, null);
  assert.equal(credentialCalls.length, 2); assert.ok(credentialCalls.every(change => change.remove.length === 1 && change.remove[0] === before.records[1][1].principal));
});
