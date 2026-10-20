import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';
import { element } from './ui-dom.mjs';

const clickText = (root, text) => {
  const found = root.querySelectorAll('button').find(node => node.textContent === text || node.textContent.includes(text));
  assert.ok(found, `Missing button: ${text}`);
  if(found.type==='submit') return found.closest('form').dispatch('submit');
  return found.dispatch('click');
};
function scene(language, api, overrides = {}) {
  const body = element('body');
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  globalThis.window = { addEventListener() {} }; globalThis.location = { origin: 'http://127.0.0.1:32100' };
  body.append(...['creator-content', 'detail-content', 'sources-content'].map(id => element('div', { id })),
    element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })),
    element('section', { id: 'view-environment' }, element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name })))),
    element('form', { id: 'import-form' }, element('input', { name: 'directory' })));
  const state = { language, environmentSelection: {}, view: 'packs', selected: 'launcher.default', tab: 'components', reviews: new Map(), trustReview: null };
  let ui;
  const ctx = { state, api, el: element,
    button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title),
    pill: title => element('span', {}, title), t: key => key, toast() {}, display: String, date: String,
    definition: pairs => element('dl', {}, pairs.flatMap(([key, value]) => [element('dt', {}, key), element('dd', {}, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))])),
    errorContents: failure => [element('p', {}, failure.message)], current() {}, idOf: instance => instance.instanceId ?? instance.id,
    endpoint: (id, action) => `/api/instances/${id}/${action}`, operationFor: instance => instance.operation, exitUnconfirmed: () => false,
    refresh: async () => {}, renderDetail() {}, navigate(view) { state.view = view; ui.navigate(view); }, selectInstance: async () => {}, openImport() {}, replaceInstance() {},
    reviewView: data => [element('pre', {}, JSON.stringify(data.review))] };
  Object.assign(ctx, overrides);
  ui = createAdvancedUi(ctx); return { body, state, ui, root: body.querySelector('#creator-content') };
}
function assembly() {
  const contract = { id: 'test.echo', version: '1.0.0' };
  const pack = { format: 'world-hub.pack/v1', id: 'global.hub.assembly', version: '0.1.0', title: 'Managed local Hub programs', license: 'MIT',
    topics: { t0: 'assembly/first', t1: 'assembly/unused-first', t2: 'assembly/second', t3: 'assembly/unused-second' },
    components: [
      { id: 'source-first', module: 'test.provider', after: [], settings: { text: 'Original 🌍\r\n' }, topicAliases: { source: 't0', unused: 't1' }, bridges: { main: { publish: ['t0'], subscribe: ['t0'] } } },
      { id: 'source-second', module: 'test.provider', after: [], settings: { text: 'Alternate 🌍\r\n' }, topicAliases: { source: 't2', unused: 't3' }, bridges: { main: { publish: ['t2'], subscribe: ['t2'] } } },
      { id: 'client', module: 'test.client', after: [], settings: { visible: true }, topicAliases: { source: 't0', alternate: 't2' }, bridges: { main: { publish: ['t0', 't2'], subscribe: ['t0', 't2'] } } },
    ], bindings: [{ from: 'source-first', to: 'client', contract }], entry: { component: 'client' }, startupTimeoutMs: 4000, healthTimeoutMs: 1000, stopTimeoutMs: 1000 };
  const modules = [{ id: 'test.provider', version: '1.0.0', runtime: { kind: 'node' }, bridges: ['main'], provides: [contract], requires: [] },
    { id: 'test.client', version: '1.0.0', runtime: { kind: 'node' }, bridges: ['main'], provides: [], requires: [contract] }];
  return { pack, modules, revision: 'a'.repeat(64), directory: 'F:\\managed-snapshots\\assembly',
    composition: { id: pack.id, version: pack.version, revision: 'c'.repeat(64), title: pack.title } };
}

test('STATIC-ASSEMBLY-UI opens every managed occurrence in Creator, saves automatically, edits wiring/settings/entry and exports aliases without lifecycle commands', async () => {
  for (const language of ['en', 'zh']) {
    const original = assembly(), requests = [], saved = [];
    const api = async (path, input) => {
      requests.push([path, structuredClone(input)]);
      if (path === '/api/programs/assembly') return { directory: original.directory, composition: structuredClone(original.composition), pack: structuredClone(original.pack), programs: original.pack.components.map(component => ({ programId: component.id })),
        scope: 'managed-source-only', source: 'launcher.default', startsModules: false, altersPrograms: false, includesExternalBridges: false, includesPrivateState: false };
      if (path === '/api/authoring/inspect') return { authoring: structuredClone(original) };
      if (path === '/api/creator-drafts/save') { saved.push(structuredClone(input.draft)); return { draft: input.draft }; }
      if (path === '/api/authoring/derive') return { directory: 'F:\\exports\\independent-pack', startsModules: false };
      throw new Error('Unexpected API action: ' + path);
    };
    const { body, root, state, ui } = scene(language, api);
    await ui.openCreatorFromPrograms();
    assert.equal(state.view, 'creator');
    assert.deepEqual(root.querySelectorAll('.composition-node-id').map(node => node.textContent), ['source-first', 'source-second', 'client']);
    assert.equal(saved.length, 1, 'Entering static assembly immediately persists the complete editable draft');
    assert.deepEqual(saved[0].pack, original.pack); assert.equal(saved[0].baseRevision, original.revision);
    assert.ok(root.textContent.includes(language === 'zh' ? '静态装配' : 'Static assembly'));

    const sourceRow = root.querySelector('.composition-nodes').children[1];
    await sourceRow.querySelector('.composition-node-settings-btn').dispatch('click');
    const editorDialog = body.querySelectorAll('dialog').find(dialog => dialog.open), editor = editorDialog.querySelector('form');
    assert.deepEqual(JSON.parse(editor.elements.topicAliases.value), original.pack.components[1].topicAliases);
    editor.elements.settings.value = JSON.stringify({ text: 'Edited public text 🌍\r\n' }); await editor.dispatch('submit');
    assert.equal(editorDialog.open, false);

    // Use the actual graph controls to replace the selected capability provider.
    const picker = root.querySelector('.workflow-module-picker'); await clickText(picker, 'client');
    await clickText(root, language === 'zh' ? '移除连线' : 'Remove binding');
    const alternateNode = root.querySelectorAll('.workflow-node-card').find(node => node.querySelector('.workflow-node-id')?.textContent === 'source-second');
    assert.ok(alternateNode); await clickText(alternateNode, language === 'zh' ? '连线' : 'Wire');
    await clickText(root, language === 'zh' ? '立即保存草稿' : 'Save draft now');
    const edited = saved.at(-1).pack;
    assert.deepEqual(edited.bindings, [{ from: 'source-second', to: 'client', contract: original.pack.bindings[0].contract }]);
    assert.equal(edited.components[1].settings.text, 'Edited public text 🌍\r\n');
    assert.deepEqual(edited.components.map(component => component.topicAliases), original.pack.components.map(component => component.topicAliases));

    const derive = root.querySelector('#creator-derive-form');
    assert.equal(derive.elements.entryComponent.value, 'client');
    derive.elements.entryComponent.value = 'source-second'; await derive.elements.entryComponent.dispatch('change');
    derive.elements.packId.value = 'independent.copy'; derive.elements.destination.value = 'F:\\exports\\independent-pack';
    await derive.dispatch('submit');
    assert.equal(requests.filter(([path]) => path === '/api/authoring/derive').length, 0, 'Export still requires the concrete review');
    const review = body.querySelector('#advanced-action-dialog'), check = review.querySelector('[type=checkbox]');
    check.checked = true; await check.dispatch('change'); await clickText(review, language === 'zh' ? '确认已审阅并继续' : 'Confirm review and continue');
    const exported = requests.find(([path]) => path === '/api/authoring/derive')[1];
    assert.equal(exported.expectedRevision, original.revision); assert.equal(exported.pack.id, 'independent.copy');
    assert.deepEqual(exported.pack.entry, { component: 'source-second' });
    assert.deepEqual(exported.pack.bindings, edited.bindings);
    assert.deepEqual(exported.pack.components.map(component => component.topicAliases), original.pack.components.map(component => component.topicAliases));
    assert.equal(exported.pack.components[1].settings.text, 'Edited public text 🌍\r\n');
    assert.ok(requests.every(([path]) => !/\/(?:start|stop|register|remove)$/.test(path)), 'The source assembly and separate export send no program lifecycle commands');
  }
});

async function acceptReview(body, language = 'en') {
  const review = body.querySelector('#advanced-action-dialog'), check = review.querySelector('[type=checkbox]');
  assert.ok(check); check.checked = true; await check.dispatch('change');
  await clickText(review, language === 'zh' ? '确认已审阅并继续' : 'Confirm review and continue');
}
async function editSecondSettings(view, text) {
  await view.root.querySelector('.composition-nodes').children[1].querySelector('.composition-node-settings-btn').dispatch('click');
  const editor = view.body.querySelectorAll('dialog').find(dialog => dialog.open).querySelector('form');
  editor.elements.settings.value = JSON.stringify({ text }); await editor.dispatch('submit');
  await clickText(view.root, 'Save draft now');
}

test('STATIC-ASSEMBLY-UPDATE global update previews the next version, applies only after review, reloads a fresh origin and retains it in the saved draft', async () => {
  let current = assembly(), pending, storedDraft;
  const requests = [], snapshots = [];
  const api = async (path, input) => {
    requests.push([path, structuredClone(input)]);
    if (path === '/api/programs/assembly') { snapshots.push(structuredClone(current)); return structuredClone(current); }
    if (path === '/api/authoring/inspect') return { authoring: structuredClone(current) };
    if (path === '/api/creator-drafts/save') { storedDraft = structuredClone(input.draft); return { draft: input.draft }; }
    if (path === '/api/programs/assembly/preview') { pending = structuredClone(input); return { reviewId: 'new-composition-review', review: { version: input.pack.version, previousVersion: current.pack.version } }; }
    if (path === '/api/programs/assembly/apply') {
      assert.deepEqual(input, { reviewId: 'new-composition-review', accepted: true });
      current = { ...current, directory: 'F:\\managed-snapshots\\assembly-next', revision: 'b'.repeat(64), pack: structuredClone(pending.pack),
        composition: { ...current.composition, version: pending.pack.version, revision: 'd'.repeat(64) } };
      return { version: current.pack.version };
    }
    if (path === '/api/creator-drafts') return { drafts: storedDraft ? [structuredClone(storedDraft)] : [] };
    if (path === '/api/operations') return { operations: [] };
    if (path === '/api/sources') return { sources: [], conflicts: [] };
    if (path === '/api/paths/known') return { objects: [] };
    throw new Error('Unexpected API action: ' + path);
  };
  let view = scene('en', api); await view.ui.openCreatorFromPrograms();
  assert.equal(view.root.querySelector('#creator-derive-form').elements.packVersion.value, '0.1.1');
  assert.deepEqual(storedDraft.origin, { kind: 'global-hub', composition: snapshots[0].composition, startupPlan: { onFailure: 'continue-independent' }, savedStartupPlan: { onFailure: 'continue-independent' } });
  await editSecondSettings(view, 'Updated current global composition 🌍');
  await clickText(view.root, 'Update current composition');
  assert.equal(requests.filter(([path]) => path.endsWith('/apply')).length, 0);
  assert.equal(pending.pack.version, '0.1.1'); assert.equal(Object.hasOwn(pending, 'destination'), false);
  assert.equal(pending.expectedRevision, snapshots[0].composition.revision);
  assert.equal(pending.pack.components[1].settings.text, 'Updated current global composition 🌍');
  await acceptReview(view.body);
  assert.equal(snapshots.length, 2, 'Accepted global update reloads newly registered configuration');
  assert.equal(storedDraft.pack.version, '0.1.1'); assert.deepEqual(storedDraft.origin.composition, current.composition);
  assert.equal(view.root.querySelector('#creator-derive-form').elements.packVersion.value, '0.1.2');
  assert.ok(requests.every(([path]) => !/\/(?:start|stop|register|remove)$/.test(path)));

  // Restoring the saved draft must keep its update destination as the global
  // composition instead of treating it as an ordinary standalone source pack.
  view = scene('en', api); view.ui.sessionReady(); await new Promise(resolve => setImmediate(resolve)); view.ui.navigate('creator');
  await clickText(view.root, 'Recheck and restore');
  await clickText(view.root, 'Update current composition');
  assert.equal(requests.at(-1)[0], '/api/programs/assembly/preview');
  assert.equal(requests.at(-1)[1].expectedRevision, current.composition.revision);
});

test('STATIC-ASSEMBLY-UPDATE refusal while programs run preserves the edited draft and displays the reason without applying or starting anything', async () => {
  const original = assembly(), requests = [], drafts = [];
  const api = async (path, input) => {
    requests.push([path, structuredClone(input)]);
    if (path === '/api/programs/assembly') return structuredClone(original);
    if (path === '/api/authoring/inspect') return { authoring: structuredClone(original) };
    if (path === '/api/creator-drafts/save') { drafts.push(structuredClone(input.draft)); return { draft: input.draft }; }
    if (path === '/api/programs/assembly/preview') throw Object.assign(new Error('Stop managed programs before updating this composition.'), { code: 'GLOBAL_ASSEMBLY_RUNNING' });
    throw new Error('Unexpected API action: ' + path);
  };
  const view = scene('en', api); await view.ui.openCreatorFromPrograms(); await editSecondSettings(view, 'Retain this draft');
  await clickText(view.root, 'Update current composition');
  assert.match(view.body.textContent, /Stop managed programs before updating/);
  assert.equal(view.root.querySelectorAll('.composition-node-id').length, 3);
  await clickText(view.root, 'Save draft now');
  assert.equal(drafts.at(-1).pack.components[1].settings.text, 'Retain this draft');
  assert.deepEqual(drafts.at(-1).origin.composition, original.composition);
  assert.ok(requests.every(([path]) => !/\/(?:apply|start|stop|update)$/.test(path)));
});

test('STATIC-ASSEMBLY-UPDATE standalone source update keeps its directory and reloads the new version only after explicit review', async () => {
  let current = assembly(), pending, lastDraft;
  const directory = current.directory, requests = [];
  const api = async (path, input) => {
    requests.push([path, structuredClone(input)]);
    if (path === '/api/authoring/inspect') return { authoring: structuredClone(current) };
    if (path === '/api/creator-drafts/save') { lastDraft = structuredClone(input.draft); return { draft: input.draft }; }
    if (path === '/api/authoring/update') { pending = structuredClone(input); current = { ...current, pack: structuredClone(input.pack), revision: 'b'.repeat(64) }; return { operationId: 'update-source' }; }
    if (path === '/api/operations/update-source') return { operation: { state: 'succeeded', result: { directory, version: current.pack.version } } };
    throw new Error('Unexpected API action: ' + path);
  };
  const view = scene('en', api); view.ui.navigate('creator');
  const inspect = view.root.querySelector('form'); inspect.elements.directory.value = directory; await inspect.dispatch('submit');
  const form = view.root.querySelector('#creator-derive-form'); assert.equal(form.elements.packVersion.value, '0.1.1'); assert.equal(form.elements.destination.value, '');
  await clickText(view.root, 'Update current composition');
  assert.equal(requests.filter(([path]) => path === '/api/authoring/update').length, 0);
  await acceptReview(view.body);
  assert.equal(pending.directory, directory); assert.equal(Object.hasOwn(pending, 'destination'), false);
  assert.equal(pending.pack.id, current.pack.id); assert.equal(pending.pack.version, '0.1.1');
  assert.equal(lastDraft.directory, directory); assert.equal(lastDraft.baseRevision, current.revision); assert.equal(lastDraft.pack.version, '0.1.1');
  assert.equal(view.root.querySelector('#creator-derive-form').elements.packVersion.value, '0.1.2');
  assert.ok(requests.every(([path]) => !/\/(?:start|stop|derive|apply)$/.test(path)));
});

test('STATIC-ASSEMBLY-UPDATE an installed source reviews a snapshot and applies directly while retaining Creator', async () => {
  const original = assembly(), requests = [], selected = [];
  const instance = { instanceId: 'installed-copy', packageDirectory: original.directory, status: { state: 'stopped', runId: 'ended', stoppedAt: 'now' } };
  const api = async (path, input) => {
    requests.push([path, structuredClone(input)]);
    if (path === '/api/authoring/inspect') return { authoring: structuredClone(original) };
    if (path.endsWith('/customization/preview')) return { previewId: 'customization-one', preview: { current: { pack: original.pack }, candidate: { pack: input.pack }, snapshot: { digest: 'd'.repeat(64), files: 3, bytes: 40 } } };
    if (path.endsWith('/customization/apply')) { original.pack.version = '0.1.1'; return { operationId: 'apply-customization' }; }
    if (path === '/api/operations/apply-customization') return { operation: { state: 'succeeded', result: { instance: { ...instance, pack: original.pack } } } };
    if (path === '/api/creator-drafts/delete') return { deleted: true };
    if (path === '/api/creator-drafts/save') return { draft: input.draft };
    throw new Error('Unexpected API action: ' + path);
  };
  let view;
  view = scene('en', api, { selectInstance: async (id, tab) => { selected.push([id, tab]); view.body.querySelector('#detail-content').replaceChildren(...view.ui.renderStorage(instance)); } });
  view.state.instances = [instance]; view.ui.navigate('creator');
  const inspect = view.root.querySelector('form'); inspect.elements.directory.value = original.directory; await inspect.dispatch('submit');
  await clickText(view.root, 'Update current composition');
  assert.equal(requests.filter(([path]) => path.endsWith('/customization/apply')).length, 0);
  await acceptReview(view.body);
  const request = requests.find(([path]) => path.endsWith('/customization/preview'))[1];
  assert.equal(request.pack.version, '0.1.1'); assert.equal(Object.hasOwn(request, 'destination'), false);
  assert.deepEqual(selected, []); assert.equal(view.state.view, 'creator');
  assert.equal(view.body.querySelector('#storage-upgrade-dialog'), null);
  assert.ok(requests.every(([path]) => !/update-candidate|\/(?:start|stop)$/.test(path)));
});

test('STATIC-ASSEMBLY-VERSION both save exits require a higher composition version without touching module versions',async()=>{
  const original=assembly(),requests=[];
  const view=scene('en',async(path,input)=>{
    requests.push([path,input]);
    if(path==='/api/programs/assembly')return structuredClone(original);
    if(path==='/api/authoring/inspect')return {authoring:structuredClone(original)};
    if(path==='/api/creator-drafts/save')return {draft:input.draft};
    throw new Error('Unexpected '+path);
  });
  await view.ui.openCreatorFromPrograms();
  for(const version of ['0.1.0','0.0.9']){
    const form=view.root.querySelector('#creator-derive-form');
    form.elements.packVersion.value=version;form.elements.destination.value='F:\\another-pack';await form.dispatch('input');
    await form.dispatch('submit');
    assert.match(view.body.textContent,/Use a composition version higher/);
    await clickText(view.root,'Update current composition');
    assert.match(view.body.textContent,/Use a composition version higher/);
  }
  assert.ok(requests.every(([path])=>!['/api/authoring/derive','/api/programs/assembly/preview','/api/programs/assembly/apply'].includes(path)));
  assert.ok(original.modules.every(module=>module.version==='1.0.0'));
});


test('UNIFIED-STARTUP Global Hub shortcut inspects the exact source, edits only its draft and reviews order plus failure policy on normal Save', async () => {
  for (const language of ['en', 'zh']) {
    const original = assembly(), requests = [], saved = [];
    original.pack.startupOrder = ['source-first', 'source-second', 'client'];
    original.pack.components[1].autostart = false;
    original.pack.components[2].after = ['source-first'];
    original.startupPlan = { onFailure: 'continue-independent' };
    original.composition.lineage = { format: 'world-hub.pack-lineage/v1', kind: 'customized', base: { id: original.pack.id, version: '0.0.7' }, revision: 4 };
    const api = async (path, input) => {
      requests.push([path, structuredClone(input)]);
      if (path === '/api/programs/assembly') return structuredClone(original);
      if (path === '/api/authoring/inspect') { assert.equal(input.directory, original.directory); return { authoring: structuredClone(original) }; }
      if (path === '/api/creator-drafts/save') { saved.push(structuredClone(input.draft)); return { draft: input.draft }; }
      if (path === '/api/programs/assembly/preview') return { reviewId: 'review-only', review: { startupOrder: input.pack.startupOrder, onFailure: input.startupPlan.onFailure } };
      throw new Error('Unexpected API action: ' + path);
    };
    const view = scene(language, api); await view.ui.openStartupPlan();
    const tabs = view.root.querySelector('.creator-tabs'); assert.equal(tabs.querySelectorAll('button').length, 4);
    const active = tabs.querySelectorAll('button').find(row => row.attributes['aria-pressed'] === 'true'); assert.match(active.textContent, /Startup plan|启动计划/);
    const editor = view.root.querySelector('[data-startup-plan-editor]'); assert.ok(editor);
    assert.match(view.root.querySelector('[data-pack-lineage]').textContent, /0.0.7.*4/);
    let position = editor.querySelector('[name="startupPosition:source-second"]'); position.value = '0'; await position.dispatch('change');
    const failure = editor.querySelector('[name=startupPlanOnFailure]'); failure.value = 'stop-plan'; await failure.dispatch('change');
    await clickText(view.root, language === 'zh' ? '立即保存草稿' : 'Save draft now');
    assert.deepEqual(saved.at(-1).pack.startupOrder, ['source-second', 'source-first', 'client']); assert.equal(saved.at(-1).origin.startupPlan.onFailure, 'stop-plan'); assert.equal(saved.at(-1).origin.savedStartupPlan.onFailure, 'continue-independent');
    assert.ok(requests.every(([path]) => !/startup-plan\/(?:save|start)|assembly\/(?:preview|apply)$|\/(?:start|stop)$/.test(path)));
    await clickText(editor, language === 'zh' ? '恢复默认' : 'Restore defaults');
    await clickText(view.root, language === 'zh' ? '立即保存草稿' : 'Save draft now');
    assert.deepEqual(saved.at(-1).pack.startupOrder, original.pack.startupOrder); assert.equal(saved.at(-1).origin.startupPlan.onFailure, 'continue-independent');
    position = editor.querySelector('[name="startupPosition:source-second"]'); position.value = '0'; await position.dispatch('change');
    const changedFailure = editor.querySelector('[name=startupPlanOnFailure]'); changedFailure.value = 'stop-plan'; await changedFailure.dispatch('change');
    await clickText(view.root, language === 'zh' ? '更新当前组合' : 'Update current composition');
    const preview = requests.find(([path]) => path === '/api/programs/assembly/preview')[1];
    assert.deepEqual(preview.pack.startupOrder, ['source-second', 'source-first', 'client']); assert.deepEqual(preview.startupPlan, { onFailure: 'stop-plan' }); assert.equal(preview.pack.version, '0.1.1');
    const summary = view.body.querySelector('[data-global-composition-review]'); assert.ok(summary);
    assert.match(summary.textContent, /source-first → source-second → client ⇒ source-second → source-first → client/);
    assert.match(summary.textContent, language === 'zh' ? /继续互不依赖的成员 ⇒ 停止后续启动/ : /Continue independent members ⇒ Stop subsequent starts/);
    assert.match(summary.textContent, language === 'zh' ? /来源基线 v0.0.7.*本地改装 v0.1.0.*修订 4/ : /Source baseline v0.0.7.*Local customization v0.1.0.*Rev 4/);
    assert.ok(summary.querySelectorAll('details').length === 0, 'The concrete plan summary is visible without opening raw JSON');
    assert.equal(view.body.querySelector('#advanced-action-dialog').open, true); assert.ok(requests.every(([path]) => !/\/(?:apply|start|stop)$/.test(path)));
  }
});


test('UNIFIED-STARTUP stopped pack shortcut inspects its actual directory and opens the same draft editor without a generic home or lifecycle command', async () => {
  const original = assembly(), requests = [];
  const api = async (path, input) => {
    requests.push([path, structuredClone(input)]);
    if (path === '/api/authoring/inspect') { assert.equal(input.directory, original.directory); return { authoring: structuredClone(original) }; }
    if (path === '/api/creator-drafts/save') return { draft: input.draft };
    throw new Error('Unexpected API action: ' + path);
  };
  const view = scene('en', api); await view.ui.openPackStartupPlan({ instanceId: 'actual-pack', packageDirectory: original.directory, pack: original.pack, status: { state: 'stopped' } });
  assert.equal(view.state.view, 'creator'); assert.equal(view.root.querySelector('[data-creator-startup-tab]').className, 'creator-tab-panel'); assert.ok(view.root.querySelector('[data-startup-plan-editor]'));
  assert.equal(view.root.querySelectorAll('.composition-node-id').length, 3); assert.deepEqual(requests.map(row => row[0]), ['/api/authoring/inspect']);
});


test('UNIFIED-RESULTS saved authoring results remain reachable on reload and in Tools without changing the startup plan', async () => {
  for (const language of ['en', 'zh']) {
    const original = assembly(), requests = [], drafts = [];
    const records = [
      { kind: 'publish', at: '2026-10-16T00:00:00Z', result: { indexPath: 'F:/published/index.json', kind: 'pack', directory: 'F:/published/source' } },
      { kind: 'create-template', at: '2026-10-16T00:00:00Z', result: { directory: 'F:/templates/reusable', kind: 'template' } },
      { kind: 'derive', at: '2026-10-16T00:00:00Z', result: { directory: 'F:/derived/new-pack', kind: 'pack' } }
    ];
    const api = async (path, input) => {
      requests.push([path, structuredClone(input)]);
      if (path === '/api/authoring/inspect') return { authoring: structuredClone(original) };
      if (path === '/api/creator-drafts/save') { drafts.push(structuredClone(input.draft)); return { draft: input.draft }; }
      if (path === '/api/creator-drafts') return { drafts: [] };
      if (path === '/api/operations') return { operations: [] };
      if (path === '/api/sources') return { sources: [], conflicts: [] };
      if (path === '/api/paths/known') return { objects: [] };
      throw new Error('Unexpected API action: ' + path);
    };
    const view = scene(language, api);
    globalThis.localStorage = { getItem(key) { return key.startsWith('world-hub.launcher.results:') ? JSON.stringify(records) : null; }, setItem() {} };
    view.ui.sessionReady(); await new Promise(done => setImmediate(done)); view.ui.navigate('creator');
    let recent = view.root.querySelector('.creator-recent-results'); assert.ok(recent); assert.equal(recent.open, undefined); assert.match(recent.querySelector('summary').textContent, /Recent workbench results|最近工作台成果/);
    const labels = recent.querySelectorAll('button').map(row => row.textContent);
    assert.ok(labels.some(title => title.includes(language === 'zh' ? '添加为软件源' : 'Add as a software source')));
    assert.ok(labels.some(title => title.includes(language === 'zh' ? '填写参数生成包' : 'Instantiate template')));
    assert.ok(labels.some(title => title.includes('importPack')));
    await view.ui.openPackStartupPlan({ instanceId: 'actual', packageDirectory: original.directory, pack: original.pack, status: { state: 'stopped' } });
    assert.equal(view.root.querySelector('[data-creator-startup-tab]').className, 'creator-tab-panel');
    recent = view.root.querySelector('.creator-recent-results'); assert.ok(recent); assert.match(recent.parent.className, /is-hidden/); assert.equal(recent.open, undefined);
    await clickText(view.root, language === 'zh' ? '进阶协作工具' : 'Advanced & Collaboration');
    recent = view.root.querySelector('.creator-recent-results'); assert.doesNotMatch(recent.parent.className, /is-hidden/); assert.equal(view.root.querySelectorAll('.creator-recent-results').length, 1);
    await clickText(view.root, language === 'zh' ? '立即保存草稿' : 'Save draft now');
    assert.deepEqual(drafts.at(-1).pack, original.pack);
    assert.ok(requests.every(([path]) => !/startup-plan\/save$|\/(?:derive|publish|instantiate|start|stop|apply)$/.test(path)));
  }
});
