import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';
import { element } from './ui-dom.mjs';

const text = (language, zh, en) => language === 'zh' ? zh : en;
function fixture() {
  const contract = { id: 'example.text', version: '1.0.0' };
  const pack = { format: 'world-hub.pack/v1', id: 'example.live', title: 'Actual live composition', version: '1.2.3', license: 'MIT', lifecyclePolicy: 'independent', topics: { data: 'example/data' },
    components: [
      { id: 'source', module: 'example.source', settings: { text: 'Baseline 🌍\r\n' }, after: [], topicAliases: { data: 'data' }, bridges: { main: { publish: ['data'], subscribe: ['data'] } } },
      { id: 'added', module: 'example.source', settings: { text: 'Added at runtime 🌍\r\n' }, after: [], topicAliases: { data: 'data' }, bridges: { main: { publish: ['data'], subscribe: ['data'] } } },
      { id: 'client', module: 'example.client', settings: { visible: true }, after: [], topicAliases: { data: 'data' }, bridges: { main: { publish: ['data'], subscribe: ['data'] } } }
    ], bindings: [{ from: 'added', to: 'client', contract }], entry: { component: 'client' }, startupTimeoutMs: 4000, healthTimeoutMs: 1000, stopTimeoutMs: 1000 };
  const directory = 'F:\\private-composition-snapshots\\snapshot-only';
  const origin = { source: 'runtime-assembly', targetInstanceId: 'installed same', runId: 'runtime-123', revision: 7, baselineDigest: 'a'.repeat(64) };
  const stateRequirements = [{ componentId: 'source', hasState: true, inCandidate: true }, { componentId: 'added', hasState: false, inCandidate: true }, { componentId: 'client', hasState: true, inCandidate: true }, { componentId: 'retired', hasState: true, inCandidate: false }];
  const modules = [{ id: 'example.source', version: '4.0.0', runtime: { kind: 'node' }, bridges: ['main'], provides: [contract], requires: [] }, { id: 'example.client', version: '3.0.0', runtime: { kind: 'node' }, bridges: ['main'], provides: [], requires: [contract] }];
  return { pack, directory, origin, stateRequirements, modules, revision: 'b'.repeat(64) };
}

function scene(language, original = fixture(), savedDraft, custom = {}) {
  const body = element('body'), requests = [], drafts = [], selected = [], replaced = [], notices = [];
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  globalThis.window = { addEventListener() {} }; globalThis.location = { origin: 'http://127.0.0.1:32100' };
  body.append(...['creator-content', 'detail-content', 'sources-content'].map(id => element('div', { id })),
    element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })),
    element('section', { id: 'view-environment' }, element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name })))),
    element('form', { id: 'import-form' }, element('input', { name: 'directory' })));
  const target = { instanceId: original.origin.targetInstanceId, packageDirectory: 'F:\\original-instance\\package', pack: { id: original.pack.id, version: '1.2.3' }, status: { state: 'running', runId: original.origin.runId } };
  const unrelated = { instanceId: 'other-instance', packageDirectory: 'F:\\other\\package', status: { state: 'running', runId: 'other-run' } };
  const state = { language, environmentSelection: {}, view: 'packs', selected: target.instanceId, tab: 'components', reviews: new Map(), trustReview: null, instances: [target, unrelated] };
  let ui, saveRequest;
  const api = async (path, input) => {
    requests.push({ path, input: input === undefined ? undefined : structuredClone(input) });
    if(custom.api){const result=await custom.api(path,input);if(result!==undefined)return result;}
    if (path === '/api/instances/installed%20same/assembly/snapshot') return { directory: original.directory, origin: original.origin, stateRequirements: original.stateRequirements, pack: original.pack };
    if (path === '/api/authoring/inspect') return { authoring: structuredClone(input.directory === target.packageDirectory && saveRequest ? { ...original, directory: target.packageDirectory, pack: saveRequest.pack, revision: 'e'.repeat(64) } : original) };
    if (path === '/api/creator-drafts/save') { drafts.push(structuredClone(input.draft)); savedDraft = input.draft; return { draft: input.draft }; }
    if (path === '/api/authoring/derive') return { directory: 'F:\\exported-new-composition', startsModules: false };
    if (path === '/api/instances/installed%20same/stop') { target.status = { ...target.status, state: 'stopped', stoppedAt: 'now' }; return { operationId: 'stop-operation' }; }
    if (path === '/api/operations/stop-operation') return { operation: { state: 'succeeded', result: { stopped: true } } };
    if (path === '/api/instances/installed%20same/assembly/save-preview') { saveRequest = structuredClone(input); return { previewId: 'save-next-version', preview: { current: { pack: original.pack }, candidate: { pack: input.pack }, snapshot: { digest: 'c'.repeat(64), files: 7, bytes: 123 }, targetInstanceId: target.instanceId, version: input.pack.version } }; }
    if (path === '/api/instances/installed%20same/assembly/save-apply') { assert.deepEqual(input, { previewId: 'save-next-version', accepted: true }); return { operationId: 'save-operation' }; }
    if (path === '/api/operations/save-operation') return { operation: { state: 'succeeded', result: { instance: { ...target, pack: { id: original.pack.id, version: saveRequest.pack.version } }, pack: { id: original.pack.id, version: saveRequest.pack.version } } } };
    if (path === '/api/creator-drafts') return { drafts: savedDraft ? [structuredClone(savedDraft)] : [] };
    if (path === '/api/creator-drafts/delete') { savedDraft = null; return { deleted: true }; }
    if (path === '/api/operations') return { operations: [] };
    if (path === '/api/sources') return { sources: [], conflicts: [] };
    if (path === '/api/paths/known') return { objects: [] };
    throw new Error(`Unexpected API ${path}`);
  };
  ui = createAdvancedUi({ state, api, el: element,
    button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title),
    pill: title => element('span', {}, title), t: key => key, toast: value => notices.push(value), display: String, date: String,
    definition: pairs => element('dl', {}, pairs.flatMap(([key, value]) => [element('dt', {}, key), element('dd', {}, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))])),
    errorContents: failure => [element('p', {}, failure.message)], current: () => state.instances.find(row => row.instanceId === state.selected), idOf: instance => instance.instanceId ?? instance.id,
    endpoint: (id, action) => `/api/instances/${encodeURIComponent(id)}/${action}`, operationFor: instance => instance.operation, exitUnconfirmed: instance => Boolean(instance.status?.runId && !instance.status.stoppedAt),
    refresh: async () => {}, renderDetail() {}, navigate(view) { state.view = view; ui.navigate(view); }, selectInstance: async (...args) => selected.push(args), openImport() {},
    replaceInstance: row => { replaced.push(row); const index = state.instances.findIndex(item => item.instanceId === row.instanceId); state.instances[index] = row; },
    reviewView: data => [element('pre', {}, JSON.stringify(data.review))] });
  return { ui, state, body, requests, drafts, selected, replaced, notices, root: body.querySelector('#creator-content'), original, get savedDraft() { return savedDraft; } };
}
async function click(root, label) {
  const button = root.querySelectorAll('button').find(row => row.textContent === label || row.textContent.includes(label));
  assert.ok(button, `Missing button: ${label}`);
  if(button.type==='submit') await button.closest('form').dispatch('submit'); else await button.dispatch('click');
  return button;
}
async function accept(view, language) {
  const review = view.body.querySelector('#advanced-action-dialog'); assert.equal(review.open, true, 'Review must remain visibly open');
  const check = review.querySelector('[type=checkbox]'); check.checked = true; await check.dispatch('change');
  await click(review, text(language, '确认已审阅并继续', 'Confirm review and continue'));
}

test('RUNTIME-CREATOR bilingual live snapshot persists its real origin and exports a higher-version independent source without changing the run', async () => {
  for (const language of ['en', 'zh']) {
    const original = fixture(), view = scene(language, original); await view.ui.openCreatorFromInstance('installed same');
    assert.equal(view.state.view, 'creator'); assert.deepEqual(view.root.querySelectorAll('.composition-node-id').map(row => row.textContent), ['source', 'added', 'client']);
    assert.equal(view.drafts.length, 1); assert.deepEqual(view.drafts[0].pack, original.pack);
    assert.deepEqual(view.drafts[0].origin, { kind: 'pack-runtime', target: original.origin, stateRequirements: original.stateRequirements });
    const form = view.root.querySelector('#creator-derive-form'); assert.equal(form.elements.packVersion.value, '1.2.4');
    form.elements.packId.value = 'independent.copy'; form.elements.destination.value = 'F:\\independent-copy'; await form.dispatch('submit');
    assert.equal(view.requests.some(row => row.path === '/api/authoring/derive'), false); await accept(view, language);
    const derived = view.requests.find(row => row.path === '/api/authoring/derive').input;
    assert.equal(derived.pack.id, 'independent.copy'); assert.equal(derived.pack.version, '1.2.4'); assert.equal(derived.directory, original.directory);
    assert.deepEqual(derived.pack.bindings, original.pack.bindings); assert.equal(derived.pack.components[1].settings.text, 'Added at runtime 🌍\r\n');
    assert.ok(view.requests.every(row => !/\/(?:start|stop|save-preview|save-apply)$/.test(row.path)));
    assert.deepEqual(original.modules.map(row => row.version), ['4.0.0', '3.0.0']);
  }
});

test('RUNTIME-CREATOR both save exits reject an unchanged version before stopping or preparing any candidate', async () => {
  const view = scene('en'); await view.ui.openCreatorFromInstance('installed same'); const form = view.root.querySelector('#creator-derive-form');
  form.elements.packVersion.value = '1.2.3'; form.elements.destination.value = 'F:\\copy'; await form.dispatch('input'); await form.dispatch('submit');
  await click(view.root, 'Update current composition'); assert.match(view.body.textContent, /composition version higher/);
  assert.ok(view.requests.every(row => !/\/(?:derive|stop|save-preview|save-apply)$/.test(row.path)));
});

test('RUNTIME-CREATOR saving the original instance reviews exact runtime origin and full snapshot without automatic stop or start', async () => {
  for (const language of ['en', 'zh']) {
    const view = scene(language); await view.ui.openCreatorFromInstance('installed same');
    Object.assign(view.state.instances[0].status, { state: 'stopped', stoppedAt: 'now' });
    await click(view.root, text(language, '更新当前组合', 'Update current composition'));
    const first = view.body.querySelector('#advanced-action-dialog'); assert.equal(first.open, true);
    assert.equal(first.querySelectorAll('select').length, 0);
    assert.match(first.textContent, text(language, /不透明数据字节/, /opaque bytes/));
    const mutations = view.requests.filter(row => /\/(?:stop|save-preview|save-apply)$/.test(row.path));
    assert.deepEqual(mutations.map(row => row.path), ['/api/instances/installed%20same/assembly/save-preview']);
    const pending = mutations[0].input; assert.equal(pending.pack.version, '1.2.4'); assert.equal(Object.hasOwn(pending, 'destination'), false); assert.deepEqual(pending.origin, view.original.origin);
    assert.equal(Object.hasOwn(pending, 'statePolicies'), false);
    const second = view.body.querySelector('#advanced-action-dialog');
    assert.equal(view.requests.some(row => row.path.endsWith('/save-apply')), false); await accept(view, language);
    assert.deepEqual(view.selected, []); assert.equal(view.state.view, 'creator'); assert.equal(view.replaced.length, 1); assert.equal(view.replaced[0].instanceId, 'installed same'); assert.equal(view.replaced[0].pack.version, '1.2.4');
    assert.equal(view.state.instances.find(row => row.instanceId === 'other-instance').status.state, 'running');
    assert.equal(view.requests.some(row => /\/(?:start|restart)$/.test(row.path)), false); assert.equal(second.open, false);
    assert.ok(view.notices.some(value => value.includes(text(language, '启动前请重新审阅', 'Review again before starting'))));
  }
});

test('RUNTIME-CREATOR restored draft retains its Runtime destination and never falls through to source or global Hub update APIs', async () => {
  const first = scene('en'); await first.ui.openCreatorFromInstance('installed same');
  const view = scene('en', first.original, structuredClone(first.savedDraft)); view.ui.sessionReady(); await new Promise(done => setImmediate(done)); view.ui.navigate('creator');
  await click(view.root, 'Recheck and restore'); await click(view.root, 'Update current composition'); await accept(view, 'en');
  assert.equal(view.requests.some(row => row.path.endsWith('/assembly/save-preview')), true);
  assert.ok(view.requests.every(row => !['/api/authoring/update', '/api/authoring/update-candidate', '/api/programs/assembly/preview'].includes(row.path)));
  assert.deepEqual(view.requests.find(row => row.path.endsWith('/assembly/save-preview')).input.origin, first.original.origin);
});

test('PARADIGM-CREATOR preset and custom policy changes preserve occurrence flags and typed metadata across redraw, draft restore and new-version export', async () => {
  for (const language of ['en', 'zh']) {
    const original = fixture(); original.pack.components[1].autostart = false; original.pack.components[1].critical = true;
    const view = scene(language, original); await view.ui.openCreatorFromInstance('installed same');
    let derive = view.root.querySelector('#creator-derive-form');
    derive.elements.packTitle.value = 'Keep my title 🌏'; derive.elements.packVersion.value = '1.2.9'; derive.elements.destination.value = 'F:\\keep-destination'; await derive.dispatch('input');
    const choosePreset = async (target, mode) => { const node = target.root.querySelectorAll('[name=packType]').find(row => row.value === mode); node.checked = true; await node.dispatch('change'); };
    await choosePreset(view, 'mesh'); let policy = view.root.querySelector('[name=lifecyclePolicy]'); assert.equal(policy.value, 'independent');
    policy.value = 'fail-fast'; await policy.dispatch('change');
    assert.equal(view.root.querySelector('#creator-derive-form').elements.packTitle.value, 'Keep my title 🌏');
    assert.equal(view.root.querySelector('#creator-derive-form').elements.packVersion.value, '1.2.9');
    assert.match(view.root.querySelectorAll('.composition-node')[1].textContent, text(language, /手动启动/, /Manual start/));
    const flagColumn=view.root.querySelectorAll('.composition-node')[1].querySelector('.composition-node-lifecycle-flags');
    assert.ok(flagColumn);assert.equal(flagColumn.querySelectorAll('.pill').length,2,'Occurrence badges remain grouped in their own metadata column');
    await view.root.querySelectorAll('.composition-node')[1].querySelector('.composition-node-settings-btn').dispatch('click');
    const editor = view.body.querySelectorAll('dialog').find(row => row.open).querySelector('form');
    assert.equal(editor.elements.autostart, undefined); assert.equal(editor.elements.critical, undefined); await editor.dispatch('submit');
    const startupMember = view.root.querySelector('[name="startupMember:added"]'); assert.equal(Boolean(startupMember.checked), false);
    const startupCritical = view.root.querySelector('[name="startupCritical:added"]'); assert.equal(startupCritical.checked, true); startupCritical.checked = false; await startupCritical.dispatch('change');
    await choosePreset(view, 'atomic'); assert.match(view.root.querySelectorAll('.composition-node')[1].textContent, text(language, /计划外.*手动启动/, /Outside initial plan.*Manual start/));
    await choosePreset(view, 'mesh'); policy = view.root.querySelector('[name=lifecyclePolicy]'); policy.value = 'fail-fast'; await policy.dispatch('change');
    await click(view.root, text(language, '立即保存草稿', 'Save draft now'));
    const saved = structuredClone(view.savedDraft); assert.equal(saved.pack.packType, 'mesh'); assert.equal(saved.pack.lifecyclePolicy, 'fail-fast');
    assert.equal(saved.pack.components[1].autostart, false); assert.equal(saved.pack.components[1].critical, false); assert.equal(Object.hasOwn(saved.pack.components[0], 'autostart'), false, 'Rendering never materializes default flags on another occurrence');
    const restored = scene(language, original, saved); restored.ui.sessionReady(); await new Promise(done => setImmediate(done)); restored.ui.navigate('creator');
    await click(restored.root, text(language, '重新检查并恢复', 'Recheck and restore'));
    assert.equal(restored.root.querySelector('[name=lifecyclePolicy]').value, 'fail-fast');
    derive = restored.root.querySelector('#creator-derive-form'); assert.equal(derive.elements.packTitle.value, 'Keep my title 🌏'); assert.equal(derive.elements.packVersion.value, '1.2.9');
    derive.elements.packId.value = 'mesh.export'; await derive.dispatch('submit');
    assert.equal(restored.requests.some(row => row.path === '/api/authoring/derive'), false); await accept(restored, language);
    const output = restored.requests.find(row => row.path === '/api/authoring/derive').input.pack;
    assert.equal(output.packType, 'mesh'); assert.equal(output.lifecyclePolicy, 'fail-fast'); assert.equal(output.version, '1.2.9');
    assert.equal(output.components[1].autostart, false); assert.equal(output.components[1].critical, false); assert.deepEqual(output.bindings, original.pack.bindings);
    assert.ok(restored.requests.every(row => !/\/(?:start|stop)$/.test(row.path)));
  }
});

test('PARADIGM-CREATOR original-instance save preserves Mesh/custom failure policy and per-occurrence startup declarations', async () => {
  for (const language of ['en', 'zh']) {
    const original = fixture(); original.pack.packType = 'mesh'; original.pack.lifecyclePolicy = 'fail-fast'; original.pack.components[1].autostart = false; original.pack.components[1].critical = true;
    const view = scene(language, original); await view.ui.openCreatorFromInstance('installed same');
    await click(view.root, text(language, '更新当前组合', 'Update current composition'));
    const pending = view.requests.find(row => row.path.endsWith('/assembly/save-preview')).input;
    assert.equal(pending.pack.packType, 'mesh'); assert.equal(pending.pack.lifecyclePolicy, 'fail-fast'); assert.equal(pending.pack.version, '1.2.4');
    assert.equal(pending.pack.components[1].autostart, false); assert.equal(pending.pack.components[1].critical, true);
    assert.equal(Object.hasOwn(pending.pack.components[0], 'critical'), false); assert.equal(view.requests.some(row => row.path.endsWith('/save-apply')), false);
    await accept(view, language); assert.equal(view.replaced[0].instanceId, original.origin.targetInstanceId); assert.equal(view.requests.some(row => row.path.endsWith('/start')), false);
  }
});

test('PARADIGM-CREATOR adding a new occurrence reviews its actual autostart/critical declarations before storing the draft', async () => {
  for(const language of ['en','zh']){
    const original=fixture();original.pack.packType='mesh';
    const manifest={id:'example.extra',version:'1.0.0',license:'MIT',runtime:{kind:'node'},bridges:['main'],provides:[],requires:[],permissions:{network:[],processes:'none',filesystem:'instance-state'}};
    const directory='F:\\extra-source';
    const view=scene(language,original,undefined,{api:async(path,input)=>{
      if(path==='/api/paths/known')return {objects:[{kind:'module',id:manifest.id,version:manifest.version,path:directory,runtime:manifest.runtime}]};
      if(path==='/api/authoring/addition-preview')return {preview:{compatible:true,environmentCompatible:true,candidateDigest:'d'.repeat(64),sourceRevision:original.revision,
        candidate:{directory,manifest},component:input.component??{id:input.componentId,module:manifest.id,after:[],settings:{},bridges:{main:{publish:[],subscribe:[]}}},differences:{},diagnostics:[]}};
    }});
    await view.ui.openCreatorFromInstance('installed same');await view.ui.loadKnown();await click(view.root,text(language,'添加模块','Add Module'));
    const picker=view.body.querySelectorAll('dialog').find(row=>row.open);await click(picker,text(language,'装配此模块','Add to Assembly'));
    const editor=view.body.querySelectorAll('dialog').find(row=>row.open).querySelector('form');
    editor.elements.autostart.checked=false;editor.elements.critical.checked=true;await editor.dispatch('submit');
    assert.equal(view.root.querySelectorAll('.composition-node-id').some(row=>row.textContent==='extra'),false,'A changed lifecycle declaration needs a current second preview');
    const preview=view.requests.filter(row=>row.path==='/api/authoring/addition-preview').at(-1).input;
    assert.equal(preview.component.autostart,false);assert.equal(preview.component.critical,true);
    await editor.dispatch('submit');await click(view.root,text(language,'立即保存草稿','Save draft now'));
    const added=view.savedDraft.pack.components.find(row=>row.id==='extra');assert.equal(added.autostart,false);assert.equal(added.critical,true);
    assert.equal(view.savedDraft.replacements.find(row=>row.componentId==='extra').moduleDirectory,directory);
    assert.ok(view.requests.every(row=>!row.path.endsWith('/start')));
  }
});


test('UNIFIED-STARTUP running pack shortcut uses the actual runtime composition then opens the shared startup draft tab', async () => {
  const view = scene('en'); await view.ui.openPackStartupPlan(view.state.instances[0]);
  assert.equal(view.state.view, 'creator'); assert.equal(view.root.querySelector('[data-creator-startup-tab]').className, 'creator-tab-panel');
  assert.ok(view.root.querySelector('[data-startup-plan-editor]')); assert.deepEqual(view.savedDraft.origin.target, view.original.origin);
  assert.deepEqual(view.requests.slice(0, 2).map(row => row.path), ['/api/instances/installed%20same/assembly/snapshot', '/api/authoring/inspect']);
  assert.ok(view.requests.every(row => !/\/(?:start|stop|save-apply)$/.test(row.path)));
});


test('UNIFIED-STARTUP runtime defaults come from the checked installed current version, retaining new runtime members after restore and draft reload', async () => {
  const original = fixture(), stored = structuredClone(original.pack);
  stored.components = stored.components.filter(row => row.id !== 'added'); stored.components[0].autostart = false; stored.components[1].after = ['source']; stored.startupOrder = ['source', 'client']; stored.packType = 'atomic'; stored.lifecyclePolicy = 'fail-fast';
  const custom = { api: async (path, input) => path === '/api/authoring/inspect' && input.directory.includes('original-instance') ? { authoring: { ...original, directory: input.directory, pack: stored } } : undefined };
  const view = scene('en', original, undefined, custom); await view.ui.openPackStartupPlan(view.state.instances[0]);
  const editor = view.root.querySelector('[data-startup-plan-editor]'); await click(editor, 'Restore defaults'); await click(view.root, 'Save draft now');
  const draft = structuredClone(view.savedDraft); assert.equal(draft.pack.components[0].autostart, false); assert.deepEqual(draft.pack.components.find(row => row.id === 'client').after, ['source']); assert.ok(draft.pack.components.some(row => row.id === 'added')); assert.equal(draft.pack.components.find(row => row.id === 'added').settings.text, original.pack.components[1].settings.text);
  assert.equal(draft.pack.packType, 'atomic'); assert.equal(draft.pack.lifecyclePolicy, 'fail-fast'); assert.deepEqual(draft.pack.startupOrder, ['source', 'client', 'added']);
  assert.match(editor.textContent, /New draft members.*added/);
  const restored = scene('en', original, draft, custom); restored.ui.sessionReady(); await new Promise(done => setImmediate(done)); restored.ui.navigate('creator'); await click(restored.root, 'Recheck and restore');
  assert.ok(restored.requests.some(row => row.path === '/api/authoring/inspect' && row.input.directory.includes('original-instance')));
  await click(restored.root.querySelector('[data-startup-plan-editor]'), 'Restore defaults'); await click(restored.root, 'Save draft now'); assert.equal(restored.savedDraft.pack.components[0].autostart, false);
  assert.ok(restored.requests.every(row => !/\/(?:start|stop|save-apply)$/.test(row.path)));
});
