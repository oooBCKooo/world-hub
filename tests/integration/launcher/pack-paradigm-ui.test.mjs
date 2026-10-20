import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackParadigmUi, packTypeOf, lifecyclePolicyOf, presentedPack } from '../../../tools/launcher/public/pack-paradigm-ui.mjs';
import { createDynamicAssemblyUi } from '../../../tools/launcher/public/dynamic-assembly-ui.mjs';
import { createDeploymentUi } from '../../../tools/launcher/public/deployment-ui.mjs';
import { element } from './ui-dom.mjs';

const say = (language, zh, en) => language === 'zh' ? zh : en;
const button = (label, action, className, disabled) => element('button', { type: 'button', onclick: action, class: className, disabled }, label);
const flush = () => new Promise(done => setImmediate(done));
function dom() { const body = element('body'); globalThis.document = { body }; return body; }
async function click(root, label) { const node = root.querySelectorAll('button').find(row => row.textContent === label); assert.ok(node, `Missing ${label}`); await node.dispatch('click'); return node; }
async function toggle(node, checked) { node.checked = checked; await node.dispatch('change'); }
const instance = () => ({ instanceId: 'mesh instance', pack: { packType: 'mesh' }, status: { runId: 'current-run', state: 'running', executionProfile: 'trusted-local', observation: 'live' } });

test('PARADIGM-UI presets are editable defaults; policy never guesses type and stale/ended runs cannot overwrite the current source', async () => {
  assert.equal(packTypeOf({ lifecyclePolicy: 'independent' }), 'atomic'); assert.equal(lifecyclePolicyOf({ packType: 'mesh' }), 'independent');
  assert.equal(lifecyclePolicyOf({ packType: 'mesh', lifecyclePolicy: 'fail-fast' }), 'fail-fast');
  const source = { packType: 'mesh', lifecyclePolicy: 'fail-fast' };
  assert.equal(presentedPack({ pack: source, status: { runId: 'old', observation: 'stale', pack: { packType: 'atomic' } } }).packType, 'mesh');
  assert.equal(presentedPack({ pack: source, status: { runId: 'old', observation: 'live', pack: { packType: 'atomic' } } }, undefined, { stale: true }).packType, 'mesh');
  assert.equal(presentedPack({ pack: source, status: { runId: 'old', stoppedAt: 'now', pack: { packType: 'atomic' } } }).packType, 'mesh');
  assert.equal(presentedPack({ pack: source, status: { runId: 'current', pack: { packType: 'atomic' }, assembly: { failurePolicy: 'independent' } } }).lifecyclePolicy, 'independent');
  for (const language of ['en', 'zh']) {
    const helper = createPackParadigmUi({ state: { language }, el: element, button }), pack = { components: [{ id: 'same', autostart: false }] };
    let changed = 0; const editor = helper.presetEditor(pack, () => changed++);
    assert.equal(editor.querySelectorAll('.pack-lifecycle-choice').length,2);
    assert.equal(editor.querySelector('.pack-lifecycle-choice').children[0].type,'radio','Compact choice labels retain the native focusable control');
    assert.equal(Object.hasOwn(pack, 'packType'), false, 'Rendering defaults does not materialize declarations');
    await toggle(editor.querySelectorAll('[name=packType]')[1], true); assert.equal(pack.packType, 'mesh'); assert.equal(pack.lifecyclePolicy, 'independent');
    const policy = editor.querySelector('[name=lifecyclePolicy]'); policy.value = 'fail-fast'; await policy.dispatch('change');
    assert.equal(pack.packType, 'mesh'); assert.equal(pack.lifecyclePolicy, 'fail-fast');
    await toggle(editor.querySelectorAll('[name=packType]')[0], true); assert.equal(pack.components[0].autostart, false, 'Switching preset retains the manual-start declaration');
    policy.value = 'independent'; await policy.dispatch('change'); assert.equal(pack.packType, 'atomic'); assert.equal(changed, 4);
    assert.match(editor.textContent, say(language, /之后可单独调整/, /adjust independently/));
    assert.match(helper.badge(pack).textContent, /Atomic/);
    const flags = helper.flagsEditor({}, pack); assert.deepEqual(flags.read(), {}, 'Untouched default member flags remain omitted');
    assert.equal(flags.node.querySelectorAll('.pack-lifecycle-choice').length,2);
    await toggle(flags.node.querySelector('[name=autostart]'), false); await toggle(flags.node.querySelector('[name=critical]'), true);
    assert.deepEqual(flags.read(), { autostart: false, critical: true });
    assert.match(flags.node.textContent, say(language, /未加入计划的成员保持停止/, /Members outside the plan remain stopped/));
    const meshFlags=helper.flagsEditor({autostart:false},{packType:'mesh'});
    assert.match(meshFlags.node.textContent,say(language,/启动前置不会自动补启动/,/Prerequisites never start automatically/));
    const observed = element('div', {}, helper.memberFlags({ autostart: false, critical: true, blockedBy: ['provider'] }, { packType: 'mesh' }));
    assert.match(observed.textContent, say(language, /手动启动/, /Manual start/)); assert.match(observed.textContent, /provider/);
    assert.doesNotMatch(observed.textContent, /已就绪|\bReady\b/);
  }
});

test('PARADIGM-UI row actions allow confirmed exited starts, keep per-member busy state, and disable stale/isolation/cleanup/external actions', async () => {
  for (const language of ['en', 'zh']) {
    const invocations = [], logs = []; let done;
    const helper = createPackParadigmUi({ state: { language }, el: element, button,
      reviewComponentAction: (...args) => { invocations.push(args); return new Promise(resolve => { done = resolve; }); }, openLogs: id => logs.push(id) });
    const owner = instance(), exited = { id: 'chosen', process: 'exited', ownership: 'managed', cleanupIncomplete: false };
    const one = element('div', {}, helper.memberActions(owner, exited, owner.pack));
    const running = one.querySelector('[data-component-action]'); assert.equal(running.disabled, false);
    const pending = running.dispatch('click'); await flush(); assert.equal(running.disabled, true); assert.equal(running.attributes['aria-busy'], 'true');
    const rerendered = element('div', {}, helper.memberActions(owner, exited, owner.pack)); assert.equal(rerendered.querySelector('[data-component-action]').disabled, true);
    const other = element('div', {}, helper.memberActions(owner, { ...exited, id: 'other' }, owner.pack)); assert.equal(other.querySelector('[data-component-action]').disabled, false);
    assert.deepEqual(invocations.map(([, id, action]) => [id, action]), [['chosen', 'start']]); done(); await pending; assert.equal(running.disabled, false);
    await click(one, say(language, '日志', 'Logs')); assert.deepEqual(logs, ['chosen']);
    for (const [row, current, options] of [[exited, owner, { stale: true }], [exited, { ...owner, status: { ...owner.status, executionProfile: 'docker' } }, {}], [{ ...exited, cleanupIncomplete: true }, owner, {}], [exited, { ...owner, status: { ...owner.status, cleanupIncomplete: true } }, {}]]) {
      const disabled = element('div', {}, helper.memberActions(current, row, owner.pack, options)); assert.equal(disabled.querySelector('[data-component-action]').disabled, true);
    }
    const external = element('div', {}, helper.memberActions(owner, { id: 'outside', process: 'unmanaged', ownership: 'external' }, owner.pack));
    assert.equal(external.querySelector('[data-component-action]'), null); assert.equal(external.querySelectorAll('button').length, 1);
    const externalFlags=element('div',{},helper.memberFlags({ownership:'external',autostart:false,critical:true},owner.pack));
    assert.match(externalFlags.textContent,say(language,/外部自管生命周期/,/Externally managed lifecycle/));assert.doesNotMatch(externalFlags.textContent,/关键成员|Critical member|Manual start/);
    const atomic = element('div', {}, helper.memberActions(owner, exited, { packType: 'atomic', lifecyclePolicy: 'independent' })); assert.equal(atomic.querySelector('[data-component-action]').disabled, false, 'Both presets allow reviewed individual member starts');
  }
});

test('PARADIGM-UI inline controls directly apply a fresh run-bound preflight after the user clicks in both languages', async () => {
  for (const language of ['en', 'zh']) {
    const body = dom(), calls = [], owner = instance(); let refreshes = 0;
    const api = async (path, input) => {
      calls.push({ path, input });
      if (path.endsWith('/assembly')) return { runId: 'current-run', assembly: { revision: 4, programs: [{ componentId: 'chosen', ownership: 'managed', state: 'exited' }] } };
      if (path.endsWith('/preview')) return { reviewId: 'current-review', review: { runId: 'current-run', revision: 4, operation: input } };
      if (path.endsWith('/apply')) return { operationId: 'chosen-start' };
      if (path === '/api/operations/chosen-start') return { operation: { state: 'succeeded', result: {} } };
      throw new Error(path);
    };
    const dynamic = createDynamicAssemblyUi({ state: { language }, api, el: element, button, refresh: async () => refreshes++ });
    const helper = createPackParadigmUi({ state: { language }, el: element, button, reviewComponentAction: dynamic.reviewComponentAction, openLogs() {} });
    const row = element('div', {}, helper.memberActions(owner, { id: 'chosen', process: 'exited', ownership: 'managed' }, owner.pack)); body.append(row);
    const pending = row.querySelector('[data-component-action]').dispatch('click'); await flush();
    assert.deepEqual(calls[1], { path: '/api/instances/mesh%20instance/assembly/preview', input: { action: 'start', componentId: 'chosen', expectedRevision: 4, expectedRunId: 'current-run' } });
    await pending; assert.equal(body.querySelector('.dynamic-assembly-review'), null, 'The direct member action does not open a second consent dialog');
    assert.deepEqual(calls.find(call => call.path.endsWith('/apply')).input, { reviewId: 'current-review', accepted: true }); assert.equal(refreshes, 1);
  }
});

test('PARADIGM-UI stale clicks and changed runs refuse even the same revision; failed direct apply reports its reason without retry', async () => {
  for (const scenario of ['stale', 'changed-run', 'external', 'instance-cleanup', 'member-cleanup', 'failed']) {
    const body = dom(), calls = [], notices = [], owner = instance(); if (scenario === 'stale') owner.status.observation = 'stale';
    if(scenario==='instance-cleanup')owner.status.cleanupIncomplete=true;
    const dynamic = createDynamicAssemblyUi({ state: { language: 'en' }, el: element, button, toast: text => notices.push(text), api: async (path, input) => {
      calls.push({ path, input });
      if (path.endsWith('/assembly')) return { runId: scenario === 'changed-run' ? 'different-run' : 'current-run', assembly: { revision: 0, programs: scenario === 'external' ? [] : [{ componentId: 'chosen', ownership: 'managed', cleanupIncomplete:scenario==='member-cleanup' }] } };
      if (path.endsWith('/preview')) return { reviewId: 'review', review: { kind: 'start' } };
      if (path.endsWith('/apply')) throw new Error('Reviewed source changed');
      throw new Error(path);
    } });
    const outcome = await dynamic.reviewComponentAction(owner, 'chosen', 'start');
    assert.ok(outcome.error); assert.ok(notices.length); assert.equal(body.querySelector('dialog'), null);
    if (scenario !== 'failed') assert.equal(calls.some(call => call.path.endsWith('/preview')), false);
    else { assert.match(notices.at(-1), /Reviewed source changed/); assert.equal(calls.filter(call => call.path.endsWith('/apply')).length, 1); }
    if (scenario === 'stale'||scenario==='instance-cleanup') assert.equal(calls.length, 0);
  }
});

test('PARADIGM-UI blank composition selects Mesh and preserves settings/providers/flags through preset changes before review', async () => {
  for (const language of ['en', 'zh']) {
    const body = dom(), calls = [], settings = [{ key: 'text', type: 'string', label: { en: 'Text', zh: '文本' }, default: 'Original text' }];
    const ui = createDeploymentUi({ state: { language }, api: async (path, input) => {
      calls.push({ path, input: structuredClone(input) });
      if (path === '/api/paths/known') return { objects: [{ kind: 'module', id: 'source', version: '1.0.0', path: 'F:\\source' }] };
      if (path === '/api/deployment/inspect') return { manifest: { id: 'source', version: '1.0.0', requires: [], provides: [] }, deploymentReview: { deployment: { title: { en: 'Source', zh: '来源' }, settings, topics: { text: 'sample/text' }, bridges: { main: { publish: ['text'], subscribe: ['text'] } } } } };
      if (path === '/api/compositions/preview') return { reviewId: 'new-pack-review', preview: { sources: [] } };
      throw new Error(path);
    }, el: element, button });
    await ui.compose(); const dialog = body.querySelector('dialog'), picker = dialog.querySelectorAll('select').find(row => row.options.some(option => option.textContent.includes('source @')));
    picker.value = '0'; await click(dialog, say(language, '添加模块', 'Add module'));
    const text = dialog.querySelectorAll('input').find(row => row.attributes['aria-label'] === say(language, '文本', 'Text')); text.value = 'Keep custom text'; await text.dispatch('change');
    await toggle(dialog.querySelector('[name=autostart]'), false); await toggle(dialog.querySelector('[name=critical]'), true);
    await toggle(dialog.querySelectorAll('[name=packType]')[1], true);
    assert.equal(Boolean(dialog.querySelector('[name=autostart]').checked), false); assert.equal(dialog.querySelector('[name=critical]').checked, true);
    const policy = dialog.querySelector('[name=lifecyclePolicy]'); policy.value = 'fail-fast'; await policy.dispatch('change');
    await click(dialog, say(language, '审阅组合', 'Review composition'));
    const preview = calls.find(call => call.path === '/api/compositions/preview').input;
    assert.equal(preview.packType, 'mesh'); assert.equal(preview.lifecyclePolicy, 'fail-fast'); assert.equal(preview.modules[0].autostart, false); assert.equal(preview.modules[0].critical, true); assert.equal(preview.modules[0].settings.text, 'Keep custom text');
    assert.equal(calls.some(call => call.path === '/api/compositions/create'), false);
  }
});
