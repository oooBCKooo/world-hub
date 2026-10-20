import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalPrograms } from '../../../tools/launcher/local-programs.mjs';
import { ModuleGroups } from '../../../tools/launcher/module-groups.mjs';
import { inspectDeployment } from '../../../scripts/runtime/deployment.mjs';
import { workspace, ROOT, environment } from '../launcher/helpers.mjs';

async function local(t) {
  const app = await workspace(t), changes = [];
  const programs = new LocalPrograms({ root: app.root, environment, inspectDeployment, updateCredentials: async change => { changes.push(change); } });
  await programs.initialize(); app.cleanups.push(() => programs.close());
  const register = async (id, name = 'source', bindings = []) => {
    const review = await programs.preview({ programId: id, directory: join(ROOT, 'examples/ecosystem-pack/modules', name), bindings });
    return programs.register({ reviewId: review.reviewId, accepted: true });
  };
  return { app, programs, changes, register };
}
const contract = { id: 'text.read', version: '1.0.0' };

test('direct configuration modifies only one stopped instance and retains identity, private state and revision across restart', async t => {
  const { app, programs, register } = await local(t);
  await register('selected'); await register('unrelated');
  const other = programs.row('unrelated'); other.state = 'running';
  const identity = await readFile(programs.path('selected', 'identity.json'));
  await mkdir(programs.path('selected', 'state'), { recursive: true });
  await writeFile(programs.path('selected', 'state/user-data.json'), 'private business data');
  const before = programs.public(programs.row('selected')), review = await programs.configurationPreview('selected', {
    expectedRevision: before.configurationRevision, settings: { text: 'New author configuration' }, topics: { source: 'custom/text' }
  });
  assert.equal(review.review.startsModules, false); assert.equal(review.review.stopsOtherModules, false);
  const result = await programs.configurationApply('selected', { reviewId: review.reviewId, accepted: true });
  assert.notEqual(result.configurationRevision, before.configurationRevision);
  assert.equal(programs.row('unrelated'), other); assert.equal(other.state, 'running');
  assert.deepEqual(await readFile(programs.path('selected', 'identity.json')), identity);
  assert.equal(await readFile(programs.path('selected', 'state/user-data.json'), 'utf8'), 'private business data');
  other.state = 'stopped'; await programs.save();
  const reopened = new LocalPrograms({ root: app.root, environment, inspectDeployment, updateCredentials: async () => {} }); await reopened.initialize();
  assert.equal(reopened.public(reopened.row('selected')).configurationRevision, result.configurationRevision);
  assert.equal(reopened.row('selected').topics.source, 'custom/text'); await reopened.close();
});

test('configuration review rejects stale revisions, unaccepted, changed source, peer changes and live target', async t => {
  const { programs, register } = await local(t); await register('selected');
  const input = () => ({ expectedRevision: programs.public(programs.row('selected')).configurationRevision, settings: { text: 'Changed' } });
  await assert.rejects(programs.configurationPreview('selected', { ...input(), expectedRevision: 'stale' }), { code: 'LOCAL_CONFIGURATION_CHANGED' });
  let review = await programs.configurationPreview('selected', input());
  await assert.rejects(programs.configurationApply('selected', { reviewId: review.reviewId, accepted: false }), { code: 'TRUST_REQUIRED' });
  programs.row('selected').settings.text = 'Concurrently changed';
  await assert.rejects(programs.configurationApply('selected', { reviewId: review.reviewId, accepted: true }), { code: 'LOCAL_CONFIGURATION_CHANGED' });
  review = await programs.configurationPreview('selected', input());
  await register('new-peer');
  await assert.rejects(programs.configurationApply('selected', { reviewId: review.reviewId, accepted: true }), { code: 'LOCAL_REVIEW_CHANGED' });
  programs.row('selected').state = 'running';
  await assert.rejects(programs.configurationPreview('selected', input()), { code: 'LOCAL_CONFIGURATION_REQUIRES_STOPPED' });
  programs.row('selected').state = 'stopped'; review = await programs.configurationPreview('selected', input());
  await writeFile(programs.path('selected', 'module/program.mjs'), '\n// injected source\n', { flag: 'a' });
  await assert.rejects(programs.configurationApply('selected', { reviewId: review.reviewId, accepted: true }), { code: 'LOCAL_INSTALLED_CODE_CHANGED' });
});

test('explicit module source update retains instance identity and state while configuration rollback restores source and registry', async t => {
  const { app, programs, register } = await local(t); await register('selected');
  const source = join(app.directory, 'upgraded-source'); await cp(join(ROOT, 'examples/ecosystem-pack/modules/source'), source, { recursive: true });
  const manifestPath = join(source, 'module.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '2.0.0'; await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const initialSource = await readFile(programs.path('selected', 'module/module.json')), initialRegistry = await readFile(join(programs.directory, 'registry.json'));
  const identity = await readFile(programs.path('selected', 'identity.json'));
  const input = { expectedRevision: programs.public(programs.row('selected')).configurationRevision, directory: source };
  let review = await programs.configurationPreview('selected', input); assert.equal(review.review.replacesSource, true);
  const save = programs.save; programs.save = async () => { throw Object.assign(new Error('Injected registry failure'), { code: 'EACCES' }); };
  await assert.rejects(programs.configurationApply('selected', { reviewId: review.reviewId, accepted: true }), { code: 'EACCES' }); programs.save = save;
  assert.deepEqual(await readFile(programs.path('selected', 'module/module.json')), initialSource);
  assert.deepEqual(await readFile(join(programs.directory, 'registry.json')), initialRegistry);
  review = await programs.configurationPreview('selected', input);
  const result = await programs.configurationApply('selected', { reviewId: review.reviewId, accepted: true });
  assert.equal(result.program.programId, 'selected'); assert.equal(result.program.module.version, '2.0.0');
  assert.deepEqual(await readFile(programs.path('selected', 'identity.json')), identity);
  assert.deepEqual(await readFile(join(result.retainedSourceDirectory, 'module.json')), initialSource);
});

test('provider and shared group impacts are displayed, and replacing a used contract is rejected', async t => {
  const { app, programs, register } = await local(t); await register('source'); await register('stats', 'stats');
  await register('consumer', 'desk', [{ providerId: 'source', contract }, { providerId: 'stats', contract: { id: 'text.statistics', version: '1.0.0' } }]);
  const groups = new ModuleGroups({ localPrograms: programs });
  await groups.save({ group: { id: 'team', title: 'Shared modules', memberProgramIds: ['source', 'consumer'] } });
  programs.row('consumer').state = 'running';
  const input = { expectedRevision: programs.public(programs.row('source')).configurationRevision, settings: { text: 'Changed provider setting' } };
  const review = await programs.configurationPreview('source', input);
  assert.equal(review.review.affected.consumers[0].programId, 'consumer'); assert.equal(review.review.affected.consumers[0].state, 'running');
  assert.equal(review.review.affected.sharedWithGroups[0].id, 'team');
  await programs.configurationApply('source', { reviewId: review.reviewId, accepted: true });
  assert.equal(programs.row('consumer').state, 'running'); programs.row('consumer').state = 'stopped';
  const source = join(app.directory, 'invalid-contract-source'); await cp(join(ROOT, 'examples/ecosystem-pack/modules/source'), source, { recursive: true });
  const path = join(source, 'module.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = '2.0.0'; manifest.provides = []; await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  await assert.rejects(programs.configurationPreview('source', { directory: source, expectedRevision: programs.public(programs.row('source')).configurationRevision }), { code: 'LOCAL_PROVIDER_CONTRACT_IN_USE' });
});
