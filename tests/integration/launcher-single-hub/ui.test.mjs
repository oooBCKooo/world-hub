import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Element, element as el } from './ui-dom.mjs';
import { createModuleWorkbench, configurationInput, movePlanMember } from '../../../tools/launcher/public/module-workbench.mjs';

const ui = await import('../../../tools/launcher/public/app.mjs');
const program = (id, extra = {}) => ({ programId: id, module: { id: 'example.text', version: '1.0.0' }, configurationRevision: `config-${id}`, title: id,
  settings: { label: 'Text', count: 2, show: true }, topics: { input: 'demo/input', output: 'demo/output' }, bridges: { main: { publish: ['output'], subscribe: ['input'] } }, bindings: [], requires: [], provides: [], state: 'stopped', ...extra });
const plan = ids => ({ format: 'world-hub.launcher-startup-plan/v1', revision: 'plan-1', members: ids.map(programId => ({ programId, enabled: true, after: [] })), onFailure: 'continue-independent', startupOrder: [...ids] });
function fixture({ programs = [program('alpha'), program('beta')], groups = [], language = 'en' } = {}) {
  const calls = [], reviews = [], confirmations = [], issues = [], stopped = [], state = { programs, groups, language };
  const ctx = { state, el, button: (label, callback, className = 'button', disabled = false) => el('button', { onclick: callback, class: className, disabled }, label), title: row => row.title ?? row.programId,
    api: async (path, body) => { calls.push({ path, body }); if (path.endsWith('/startup-plan')) return { plan: plan(state.programs.map(row => row.programId)) }; if (path.endsWith('/preview')) return { reviewId: 'review-1', review: { programId: 'alpha' } }; return {}; },
    review: value => reviews.push(value), confirm: value => confirmations.push(value), error: issue => issues.push(issue), toast() {}, refresh: async () => {}, run: async action => { try { return await action(); } catch (issue) { issues.push(issue); } }, stopProgram: row => stopped.push(row.programId) };
  const workbench = createModuleWorkbench(ctx); return { workbench, calls, reviews, confirmations, issues, stopped, state };
}
const findButton = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const settle = async () => { await new Promise(done => setImmediate(done)); };

test('single-hub navigation exposes only modules, references and one communication hub', async () => {
  assert.deepEqual(ui.navigation.map(row => row[0]), ['modules', 'communication']);
  const [source, html] = await Promise.all(['app.mjs', 'index.html'].map(file => readFile(new URL(`../../../tools/launcher/public/${file}`, import.meta.url), 'utf8')));
  assert.doesNotMatch(source + html, /\/api\/(?:instances|compositions|templates|authoring|backups)|#packs|createAdvancedUi|deployment-ui/);
  assert.match(source, /global-dynamic-modules-tab/); assert.match(source, /module-workbench/); assert.match(html, /id="hub-bar"/); assert.match(html, /id="topbar-stats"/);
});
test('module library excludes any other kind without merging registered instances', () => {
  const first = { kind: 'module', id: 'a', path: 'C:/a' }, second = { kind: 'module', id: 'a', path: 'C:/b' };
  assert.deepEqual(ui.moduleLibraryRows({ objects: [first, { kind: 'source' }, second] }), [first, second]);
});
test('program entry links accept only concrete loopback HTTP URLs', () => {
  assert.equal(ui.localEntryUrl('http://127.0.0.1:4000/ui'), 'http://127.0.0.1:4000/ui');
  for (const value of ['javascript:alert(1)', 'https://example.com', 'http://localhost:4000', 'http://user:pass@127.0.0.1', 'file:///C:/a']) assert.equal(ui.localEntryUrl(value), null);
});
test('download receipt remains exact to the reviewed module artifact', () => {
  const original = { kind: 'module', entryId: 'a', sha256: '123' }, changed = { ...original, sha256: '456' };
  assert.equal(ui.sameSourceArtifact(original, { ...original }), true); assert.equal(ui.sameSourceArtifact(original, changed), false);
  assert.deepEqual(ui.sourceFetchInput({ sourceId: 'source-a', receiptId: 'receipt-current' }, original), { sourceId: 'source-a', receiptId: 'receipt-current', entryId: 'a' });
  assert.throws(() => ui.sourceFetchInput({ sourceId: 'source-a' }, original));
});
test('offline source only enables cache re-verification for a present module artifact', () => {
  assert.equal(ui.canAcquireSourceModule({ offline: true }, { kind: 'module', cached: true }), true);
  assert.equal(ui.canAcquireSourceModule({ offline: true }, { kind: 'module', cached: false }), false);
  assert.equal(ui.canAcquireSourceModule({ offline: true }, { kind: 'module' }), false);
  assert.equal(ui.canAcquireSourceModule({}, { kind: 'module' }), true);
  assert.equal(ui.canAcquireSourceModule({}, { kind: 'source', cached: true }), false);
});
test('configuration payload addresses one exact instance revision and preserves selected source', () => {
  assert.deepEqual(configurationInput(program('alpha'), { settings: {}, topics: {}, bridges: {}, bindings: [], directory: '  C:/module-v2 ' }), {
    expectedRevision: 'config-alpha', settings: {}, topics: {}, bridges: {}, bindings: [], directory: 'C:/module-v2' });
});
test('exact startup position moves a reference without duplicating or mutating source plan', () => {
  const original = plan(['a', 'b', 'c']); assert.deepEqual(movePlanMember(original, 'c', 0).startupOrder, ['c', 'a', 'b']);
  assert.deepEqual(original.startupOrder, ['a', 'b', 'c']); assert.deepEqual(movePlanMember(original, 'a', 9), original);
});
test('plain parameter and topic controls update only the reviewed instance', async () => {
  const f = fixture(), root = f.workbench.render(), label = root.querySelector('[name="setting-label"]'), topic = root.querySelector('[name="topic-input"]');
  label.value = 'Independent'; await label.dispatch('input'); topic.value = 'another/input'; await topic.dispatch('input');
  await findButton(root, 'Review and save this instance').dispatch('click');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/programs/alpha/configuration/preview');
  assert.equal(f.calls[0].body.settings.label, 'Independent'); assert.equal(f.calls[0].body.topics.input, 'another/input');
  assert.equal(f.state.programs[1].settings.label, 'Text'); assert.equal(f.reviews.length, 1);
  await f.reviews[0].apply(); assert.deepEqual(f.calls[1], { path: '/api/programs/alpha/configuration/apply', body: { reviewId: 'review-1', accepted: true } });
  assert.equal(f.calls.some(row => /hub|startup|groups/.test(row.path)), false);
});
test('advanced invalid JSON draft survives render and never reaches configuration API', async () => {
  const f = fixture(), root = f.workbench.render(), settings = root.querySelector('[name="settings"]'); settings.value = '{invalid'; await settings.dispatch('input');
  f.state.language = 'zh'; f.workbench.render(); assert.equal(root.querySelector('[name="settings"]').value, '{invalid');
  await findButton(root, '审阅并保存本实例').dispatch('click'); assert.equal(f.calls.length, 0); assert.equal(f.issues.length, 1);
});
test('dirty workbench switching requires discard confirmation and keeps current object until accepted', async () => {
  const f = fixture(), root = f.workbench.render(), label = root.querySelector('[name="setting-label"]'); label.value = 'Draft'; await label.dispatch('input');
  f.workbench.open('configuration', 'beta'); assert.equal(f.confirmations.length, 1); assert.equal(root.querySelector('[name="setting-label"]').value, 'Draft');
  f.confirmations[0].action(); assert.equal(root.querySelector('select').value, 'beta'); assert.equal(root.querySelector('[name="setting-label"]').value, 'Text');
});
test('running instance must be stopped explicitly; the form does not stop peers or Hub', async () => {
  const f = fixture({ programs: [program('alpha', { state: 'running' }), program('beta', { state: 'running' })] }), root = f.workbench.render();
  assert.equal(findButton(root, 'Review and save this instance').disabled, true); await findButton(root, 'Stop this instance…').dispatch('click');
  assert.deepEqual(f.stopped, ['alpha']); assert.equal(f.calls.length, 0);
});
test('unchecking a bridge permission modifies its exact slot and topic only', async () => {
  const f = fixture(), root = f.workbench.render(), permission = root.querySelectorAll('input').find(row => row.attributes['aria-label'] === 'main publish output'); permission.checked = false; await permission.dispatch('change');
  await findButton(root, 'Review and save this instance').dispatch('click'); assert.deepEqual(f.calls[0].body.bridges, { main: { publish: [], subscribe: ['input'] } });
});
test('global plan has member selection, exact position and current-saved reset; saving does not start', async () => {
  const f = fixture(); f.workbench.open('global-plan'); await settle(); const root = f.workbench.render();
  const position = root.querySelectorAll('input').find(row => row.attributes['aria-label'] === 'Position beta'); position.value = '1'; await position.dispatch('change');
  const enabled = root.querySelectorAll('input').find(row => row.attributes['aria-label'] === 'Start with plan alpha'); enabled.checked = false; await enabled.dispatch('change');
  await findButton(root, 'Save plan').dispatch('click'); const saved = f.calls.find(row => row.path.endsWith('/save'));
  assert.deepEqual(saved.body.plan.startupOrder, ['beta', 'alpha']); assert.equal(saved.body.plan.members.find(row => row.programId === 'alpha').enabled, false); assert.equal(saved.body.expectedRevision, 'plan-1');
  assert.equal(f.calls.some(row => /start$|start\/apply/.test(row.path)), false);
  await settle(); assert.ok(findButton(root, 'Restore the currently saved plan'));
});
test('module group plan saves references with its own revision without global configuration updates', async () => {
  const group = { id: 'group-a', title: 'Group A', memberProgramIds: ['alpha'], revision: 'group-rev', startupPlan: plan(['alpha']) }, f = fixture({ groups: [group] });
  f.workbench.open('group', 'group-a'); await settle(); const root = f.workbench.render(); await findButton(root, 'Save plan').dispatch('click');
  assert.equal(f.calls[0].path, '/api/groups/save'); assert.equal(f.calls[0].body.expectedRevision, 'group-rev'); assert.deepEqual(f.calls[0].body.group.memberProgramIds, ['alpha']);
  assert.equal(f.calls.some(row => /configuration|hubs|startup-plan/.test(row.path)), false);
});
