import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';
import { createCustomizationUi, packLineageLabels, renderPackLineage } from '../../../tools/launcher/public/pack-lineage-ui.mjs';
import { element } from './ui-dom.mjs';

const say = (lang, zh, en) => lang === 'zh' ? zh : en;
const clone = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), get resolve() { return resolve; } }; };
const flush = () => new Promise(done => setImmediate(done));
async function click(root, text) {
  const control = root.querySelectorAll('button').find(node => node.textContent === text || node.textContent.includes(text));
  assert.ok(control, `Missing ${text}: ${root.textContent.slice(0, 1800)}`);
  if (control.type === 'submit') await control.closest('form').dispatch('submit'); else await control.dispatch('click');
  return control;
}
async function accept(view) {
  const dialog = view.body.querySelector('#advanced-action-dialog'), check = dialog.querySelector('[type=checkbox]');
  assert.equal(dialog.open, true); check.checked = true; await check.dispatch('change');
  return click(dialog, say(view.state.language, '确认已审阅并继续', 'Confirm review and continue'));
}
function scene(language, { runtime = false, applyGate, running = false, baseline = false, draftCleanupFails = false, reloadFails = false } = {}) {
  const body = element('body'), calls = [], navigation = [], notices = [], drafts = [], replaced = [], selectedVersions = [];
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  globalThis.window = { addEventListener() {} }; globalThis.location = { origin: 'http://127.0.0.1:32100' };
  body.append(...['creator-content', 'detail-content', 'sources-content'].map(id => element('div', { id })), element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })), element('section', { id: 'view-environment' }, element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name })))), element('form', { id: 'import-form' }, element('input', { name: 'directory' })));
  const directory = 'F:\\instance\\package', snapshot = 'F:\\private-runtime-snapshot';
  const initial = { format: 'world-hub.pack/v1', id: 'test.composition', title: 'User title 🌍', version: '1.0.0', license: 'MIT', packType: 'mesh', lifecyclePolicy: 'independent', topics: { data: 'test/data' }, components: [{ id: 'source', module: 'test.source', after: [], settings: { text: 'Private? no: public setting' }, bridges: { main: { publish: ['data'], subscribe: ['data'] } } }], bindings: [], entry: { component: 'source' } };
  let pack = clone(initial), revision = 'a'.repeat(64), pending, committed = false;
  const instance = { instanceId: 'installed copy', packageDirectory: directory, pack: clone(pack), status: running ? { state: 'running', runId: 'owned-run' } : { state: 'stopped', runId: 'owned-run', stoppedAt: 'now' } };
  const state = { language, environmentSelection: {}, instances: [instance], selected: instance.instanceId, reviews: new Map(), view: 'packs', tab: 'storage' };
  const origin = { targetInstanceId: instance.instanceId, runId: 'owned-run', revision: 4, baselineDigest: 'b'.repeat(64) };
  const authoring = at => ({ directory: at, revision, pack: clone(pack), modules: [{ id: 'test.source', version: '1.0.0', runtime: { kind: 'node' }, bridges: ['main'], provides: [], requires: [] }] });
  const review = candidate => ({ current: { pack: clone(pack), digest: revision }, candidate: { pack: candidate, digest: 'c'.repeat(64) }, diff: { settings: { source: { text: 'Changed public 🌍' } } }, snapshot: { digest: 'd'.repeat(64), files: 12, bytes: 4096 }, statePolicies: [{ componentId: 'source', mode: 'preserve' }], stateCompatibility: 'opaque-bytes-preserved-business-not-validated', startsModules: false });
  const api = async (path, input) => {
    calls.push({ path, input: clone(input) });
    if (path.endsWith('/assembly/snapshot')) return { directory: snapshot, origin, stateRequirements: [{ componentId: 'source', hasState: true }] };
    if (path === '/api/authoring/inspect') { if (committed && reloadFails) throw new Error('Temporary source inspection failure'); return { authoring: authoring(input.directory) }; }
    if (path === '/api/creator-drafts/save') { drafts.push(clone(input.draft)); return { draft: input.draft }; }
    if (path === '/api/creator-drafts/delete') { if (draftCleanupFails) throw new Error('Draft store temporarily unavailable'); return { deleted: true }; }
    if (path.endsWith('/customization/preview') || path.endsWith('/assembly/save-preview')) {
      if (running) throw new Error('Stop this instance before saving a customization.');
      pending = clone(input); pending.pack.lineage = { format: 'world-hub.pack-lineage/v1', kind: 'customized', base: { id: initial.id, version: initial.version, sourceDigest: 'e'.repeat(64) }, revision: 1, customizedAt: '2026-10-16T12:00:00Z' };
      return { previewId: 'exact-preview', preview: review(pending.pack) };
    }
    if (path.endsWith('/customization/apply') || path.endsWith('/assembly/save-apply')) { if (applyGate) await applyGate.promise; pack = pending.pack; revision = 'f'.repeat(64); committed = true; return { operationId: 'customize-one' }; }
    if (path === '/api/operations/customize-one') return { operation: { state: 'succeeded', result: { instance: { ...instance, pack: clone(pack) }, pack: clone(pack), transactionId: 'transaction-one' } } };
    if (path.endsWith('/customization/history')) return { history: { instanceId: instance.instanceId, transactions: [{ transactionId: 'transaction-one', current: { pack: initial }, target: { pack: { ...initial, version: '1.0.1' } }, state: 'applied', createdAt: '2026-10-16T12:00:00Z', restorable: true }, { transactionId: 'missing-snapshot', state: 'applied', restorable: false }] }, baseline: baseline ? { transactionId: 'transaction-one', pack: initial, restorable: true } : null };
    if (path.endsWith('/customization/restore-preview')) return { previewId: 'restore-exact', preview: { transactionId: 'transaction-one', current: { pack: { ...initial, version: '1.0.1' } }, restores: { pack: initial }, snapshot: { sha256: '9'.repeat(64), bytes: 4096, files: 12 }, preservesLatestData: false, discardsCurrentData: true, recoveryRequired: false, requiresNewExecutionReview: true } };
    if (path.endsWith('/customization/restore')) return { operationId: 'restore-one' };
    if (path === '/api/operations/restore-one') return { operation: { state: 'succeeded', result: { instance: { ...instance, pack: initial } } } };
    if (path.endsWith('/storage')) return { storage: { bytes: 100, files: 2, groups: {} } };
    throw new Error(`Unexpected ${path}`);
  };
  let ui;
  ui = createAdvancedUi({ state, api, el: element, button: (title, action, klass = 'button', disabled = false) => element('button', { type: 'button', class: klass, onclick: action, disabled }, title), pill: title => element('span', {}, title), t: key => key, toast: text => notices.push(text), display: String, date: String,
    definition: pairs => element('dl', {}, pairs.flatMap(([key, value]) => [element('dt', {}, key), element('dd', {}, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))])),
    errorContents: error => [element('p', {}, error.message)], current: () => instance, idOf: row => row.instanceId, endpoint: (id, action) => `/api/instances/${encodeURIComponent(id)}/${action}`,
    operationFor: () => null, exitUnconfirmed: row => Boolean(row.status?.runId && !row.status.stoppedAt), refresh: async () => {}, renderDetail() {}, selectInstance: async (...args) => navigation.push(args), openImport() {}, replaceInstance: (row, options) => { replaced.push(row); selectedVersions.push(options?.selectVersion); },
    navigate(view) { state.view = view; ui.navigate(view); }, reviewView: () => [] });
  const root = body.querySelector('#creator-content');
  return { body, calls, navigation, notices, replaced, selectedVersions, state, ui, root, origin, instance, directory, snapshot, drafts,
    async open() { if (runtime) await ui.openCreatorFromInstance(instance.instanceId); else { ui.navigate('creator'); const form = root.querySelector('form'); form.elements.directory.value = directory; await form.dispatch('submit'); } } };
}

test('CUSTOMIZATION-LINEAGE source, customized and self-created labels remain neutral in both languages without altering pack titles', () => {
  for (const language of ['zh', 'en']) {
    const pack = { id: 'arbitrary.third-party', title: 'Original public title', version: '2.0.1' };
    assert.match(renderPackLineage(element, pack, language).textContent, say(language, /来源版本 v2\.0\.1/, /Source version v2\.0\.1/));
    pack.lineage = { format: 'world-hub.pack-lineage/v1', kind: 'customized', base: { id: pack.id, version: '1.9.0', sourceDigest: 'a'.repeat(64) }, revision: 3 };
    const labels = packLineageLabels(pack, language);
    assert.match(labels[0].text, /v1\.9\.0/); assert.match(labels[1].text, /v2\.0\.1.*3/);
    assert.doesNotMatch(labels.map(row => row.text).join(' '), /官方|正式|Official/i);
    pack.lineage = { format: 'world-hub.pack-lineage/v1', kind: 'self-created' };
    assert.match(packLineageLabels(pack, language)[0].text, say(language, /自建 v2\.0\.1/, /Self-created v2\.0\.1/));
    assert.equal(pack.title, 'Original public title');
  }
});

test('CUSTOMIZATION-DIFF ordinary review shows added, removed, real source and declaration changes without exposing raw values or mislabeling a relocated identical source', async () => {
  for (const language of ['zh', 'en']) {
    const baseline = { module: { id: 'test.source', version: '1.0.0', source: 'modules/old' }, codeSha256: 'a'.repeat(64), settingsSha256: 'b'.repeat(64) };
    const preview = { current: { pack: { version: '1.0.0' } }, candidate: { pack: { version: '1.0.1' } }, snapshot: { digest: 'd'.repeat(64), files: 10, bytes: 99 }, diff: { format: 'world-hub.upgrade-diff/v1', declarations: 'exact-checked', components: [
      { id: 'spare', change: 'removed', before: baseline, after: null, changedDimensions: ['module', 'startup'] },
      { id: 'extra', change: 'added', before: null, after: baseline, changedDimensions: ['module', 'startup'] },
      { id: 'provider', change: 'changed', before: baseline, after: { ...baseline, codeSha256: 'c'.repeat(64) }, changedDimensions: [] },
      { id: 'configured', change: 'changed', before: baseline, after: { ...baseline, settingsSha256: 'e'.repeat(64) }, changedDimensions: ['settingsSha256', 'startup', 'bridges'] },
      { id: 'moved-identical', change: 'changed', before: baseline, after: { ...baseline, module: { ...baseline.module, source: 'modules/new' } }, changedDimensions: ['module'] }
    ], bindings: { changed: true, before: [], after: [{ from: 'extra', to: 'configured' }] }, topics: { changed: false }, lifecycle: { changed: false }, startupOrder: { changed: true, before: ['provider', 'configured'], after: ['configured', 'provider'] } } };
    const root = element('div');
    const ui = createCustomizationUi({ state: { language }, api: async () => ({ previewId: 'review-diff', preview }), el: element, button() {}, idOf: row => row.instanceId, endpoint: (id, action) => `/api/instances/${id}/${action}`, note: text => element('p', {}, text), jsonView: (_title, data) => element('details', {}, element('pre', {}, JSON.stringify(data))), definition: pairs => element('dl', {}, pairs.flatMap(([title, value]) => [element('dt', {}, title), element('dd', {}, value)])), reviewAction: (_title, contents) => root.replaceChildren(...contents) });
    await ui.save({ instanceId: 'installed' }, {});
    const summary = root.querySelector('.customization-change-summary'); assert.ok(summary);
    const pairs = Object.fromEntries(summary.querySelectorAll('dt').map((term, index) => [term.textContent, summary.querySelectorAll('dd')[index].textContent]));
    assert.equal(pairs[say(language, '移除模块', 'Removed modules')], 'spare');
    assert.equal(pairs[say(language, '新增模块', 'Added modules')], 'extra');
    assert.equal(pairs[say(language, '源码替换', 'Source replacements')], 'provider');
    assert.equal(pairs[say(language, '配置与声明变化', 'Configuration and declaration changes')], 'configured');
    assert.equal(pairs[say(language, '能力接线', 'Capability wiring')], say(language, '有变化', 'Changed'));
    assert.equal(pairs[say(language, '执行顺序', 'Execution order')], 'provider → configured ⇒ configured → provider');
    assert.doesNotMatch(summary.textContent, /modules\/old|modules\/new|aaaaaaaa|settingsSha256|moved-identical/);
    assert.equal(root.querySelector('details').open, undefined, 'Advanced raw data stays collapsed; the change summary is directly visible');
  }
});

test('CUSTOMIZATION-PLAN running and stopped shortcuts inspect the exact composition and open the shared Workbench startup tab', async () => {
  for (const language of ['zh', 'en']) for (const running of [false, true]) {
    const view = scene(language, { running }), before = clone(view.instance);
    await view.ui.openPackStartupPlan(view.instance);
    assert.equal(view.body.querySelector('.pack-startup-plan-dialog'), null); assert.equal(view.state.view, 'creator');
    assert.equal(view.root.querySelector('[data-creator-startup-tab]').className, 'creator-tab-panel');
    assert.ok(view.root.querySelector('[data-startup-plan-editor]'));
    if (running) {
      assert.ok(view.calls.some(row => row.path.endsWith('/assembly/snapshot')));
      assert.ok(view.calls.some(row => row.path === '/api/authoring/inspect' && row.input.directory === view.snapshot));
    } else {
      assert.ok(view.calls.some(row => row.path === '/api/authoring/inspect' && row.input.directory === view.directory));
      assert.equal(view.calls.some(row => row.path.endsWith('/assembly/snapshot')), false);
    }
    assert.ok(view.calls.every(row => !/startup-plan\/save$|\/(?:start|stop)$/.test(row.path))); assert.deepEqual(view.instance, before);
  }
});

test('CUSTOMIZATION-PLAN unavailable exact source stays explicit; missing cached declarations are re-inspected instead of invented', async () => {
  for (const language of ['zh', 'en']) {
    const missingSource = scene(language); delete missingSource.instance.packageDirectory;
    await missingSource.ui.openPackStartupPlan(missingSource.instance);
    assert.equal(missingSource.state.view, 'packs'); assert.match(missingSource.body.textContent, say(language, /没有可用的真实来源/, /No exact source/)); assert.deepEqual(missingSource.calls, []);
    const uncached = scene(language); delete uncached.instance.pack; await uncached.ui.openPackStartupPlan(uncached.instance);
    assert.equal(uncached.state.view, 'creator'); assert.ok(uncached.root.querySelector('[data-startup-plan-editor]'));
    assert.ok(uncached.calls.some(row => row.path === '/api/authoring/inspect' && row.input.directory === uncached.directory));
  }
});

test('CUSTOMIZATION-SAVE both installed-source and runtime workbenches review and apply directly, lock pending consent and reload clean source without navigation', async () => {
  for (const language of ['zh', 'en']) for (const runtime of [false, true]) {
    const gate = deferred(), view = scene(language, { runtime, applyGate: gate }); await view.open();
    await click(view.root, say(language, '更新当前组合', 'Update current composition'));
    const preview = view.calls.find(row => /\/(?:customization\/preview|assembly\/save-preview)$/.test(row.path));
    assert.ok(preview); assert.equal(preview.input.pack.version, '1.0.1'); assert.equal('destination' in preview.input, false); assert.equal('statePolicies' in preview.input, false);
    if (runtime) assert.deepEqual(preview.input.origin, view.origin);
    const dialog = view.body.querySelector('#advanced-action-dialog');
    assert.match(dialog.textContent, /4096/); assert.match(dialog.textContent, say(language, /不透明数据字节/, /opaque bytes/));
    assert.match(dialog.textContent, say(language, /Hub 持久日志仍保留/, /persistent Hub logs are retained/));
    assert.equal(dialog.querySelector('.dialog-footer').querySelectorAll('button').at(-1).disabled, true);
    assert.equal(view.calls.some(row => /\/(?:apply|save-apply)$/.test(row.path)), false);
    const accepting = accept(view); await flush();
    assert.equal(dialog.attributes['aria-busy'], 'true'); assert.equal(dialog.querySelector('[type=checkbox]').disabled, true);
    gate.resolve(); await accepting;
    const apply = view.calls.find(row => /\/(?:customization\/apply|assembly\/save-apply)$/.test(row.path));
    assert.deepEqual(apply.input, { previewId: 'exact-preview', accepted: true });
    assert.equal(view.state.view, 'creator'); assert.deepEqual(view.navigation, []); assert.equal(view.replaced.length, 1);
    assert.deepEqual(view.calls.find(row => row.path === '/api/creator-drafts/delete').input, { directory: runtime ? view.snapshot : view.directory });
    if (runtime) assert.ok(view.calls.some(row => row.path === '/api/creator-drafts/delete' && row.input.directory === view.directory), 'Both runtime snapshot and installed-source stale drafts are cleared');
    assert.equal(view.root.querySelector('#creator-save-form').elements.packVersion.value, '1.0.2');
    assert.match(view.root.querySelector('[data-pack-lineage]').textContent, say(language, /来源基线.*本地改装/, /Source baseline.*Local customization/));
    assert.equal(view.body.querySelector('#storage-upgrade-dialog'), null);
    assert.ok(view.calls.every(row => !/update-candidate|\/(?:start|stop)$/.test(row.path)));
  }
});

test('CUSTOMIZATION-SAVE post-commit draft cleanup or source reload failures report that the new version is already applied without offering a second apply', async () => {
  for (const language of ['zh', 'en']) for (const reloadFails of [false, true]) {
    const view = scene(language, { runtime: true, draftCleanupFails: true, reloadFails }); await view.open();
    await click(view.root, say(language, '更新当前组合', 'Update current composition')); await accept(view);
    assert.equal(view.replaced[0].pack.version, '1.0.1'); assert.deepEqual(view.selectedVersions, [true]);
    assert.equal(view.body.querySelector('#advanced-action-dialog').open, false);
    assert.match(view.root.textContent, say(language, /改装保存已生效.*旧草稿清理失败/, /Customization is already applied.*Old draft cleanup failed/));
    assert.equal(view.calls.filter(row => row.path.endsWith('/assembly/save-apply')).length, 1);
    assert.equal(view.state.view, 'creator'); assert.deepEqual(view.navigation, []);
    if (reloadFails) assert.match(view.root.textContent, say(language, /新版本已生效.*重新载入失败/, /new version is applied.*reload failed/));
    else assert.equal(view.root.querySelector('#creator-save-form').elements.packVersion.value, '1.0.2');
    assert.ok(view.notices.some(value => /already applied|保存已生效/.test(value)));
  }
});

test('CUSTOMIZATION-SAVE running refusal retains editable draft and sends no stop, apply, candidate wizard or restart', async () => {
  for (const language of ['zh', 'en']) {
    const view = scene(language, { runtime: true, running: true }); await view.open();
    await click(view.root, say(language, '更新当前组合', 'Update current composition'));
    assert.match(view.body.textContent, /Stop this instance/); assert.ok(view.root.querySelector('#creator-save-form'));
    assert.ok(view.calls.every(row => !/update-candidate|\/(?:apply|save-apply|stop|start)$/.test(row.path)));
    assert.deepEqual(view.navigation, []);
  }
});

test('CUSTOMIZATION-HISTORY baseline is available only with a retained snapshot; restore requires new full-data consent and cannot auto-start', async () => {
  for (const language of ['zh', 'en']) for (const baseline of [false, true]) {
    const view = scene(language, { baseline }); view.body.querySelector('#detail-content').replaceChildren(...view.ui.renderStorage(view.instance));
    await click(view.body.querySelector('#detail-content'), say(language, '改装历史与恢复', 'Customization history & restore'));
    const history = view.body.querySelector('.customization-history-dialog'); assert.ok(history.open);
    assert.equal(Boolean(history.querySelector('.customization-baseline')), baseline);
    if (!baseline) assert.match(history.textContent, say(language, /没有可用的来源基线快照/, /No source baseline snapshot/));
    assert.equal(history.querySelectorAll('.customization-history-row').at(-1).querySelector('button').disabled, true);
    await click(history, say(language, '恢复此快照', 'Restore this snapshot'));
    assert.deepEqual(view.calls.find(row => row.path.endsWith('/restore-preview')).input, { transactionId: 'transaction-one' });
    const review = view.body.querySelector('#advanced-action-dialog');
    assert.match(review.querySelectorAll('[data-pack-lineage]')[0].textContent, /v1\.0\.1/);
    assert.match(review.querySelectorAll('[data-pack-lineage]')[1].textContent, /v1\.0\.0/);
    assert.doesNotMatch(review.querySelectorAll('[data-pack-lineage]').map(node => node.textContent).join(''), /v—/);
    assert.match(review.querySelector('dl').textContent, /9999999999999999999999999999999999999999999999999999999999999999/);
    assert.match(review.textContent, say(language, /之后新增的数据也会被替换/, /including later data changes/));
    assert.match(review.textContent, say(language, /外部系统副作用无法撤销/, /External side effects cannot be undone/));
    assert.equal(view.calls.some(row => row.path.endsWith('/customization/restore')), false);
    await accept(view);
    assert.deepEqual(view.calls.find(row => row.path.endsWith('/customization/restore')).input, { previewId: 'restore-exact', accepted: true });
    assert.equal(view.replaced.length, 1); assert.deepEqual(view.selectedVersions, [true]); assert.ok(view.calls.every(row => !/\/(?:start|stop)$/.test(row.path)));
  }
});
