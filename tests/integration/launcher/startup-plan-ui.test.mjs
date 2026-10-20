import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderPackLineage } from '../../../tools/launcher/public/pack-lineage-ui.mjs';
import { createStartupPlanEditor, resolveDraftStartupOrder } from '../../../tools/launcher/public/startup-plan-editor.mjs';
import { createStartupPlanUi } from '../../../tools/launcher/public/startup-plan-ui.mjs';
import { createPackParadigmUi } from '../../../tools/launcher/public/pack-paradigm-ui.mjs';
import { createDeploymentUi } from '../../../tools/launcher/public/deployment-ui.mjs';
import { createTaskUi } from '../../../tools/launcher/public/task-ui.mjs';
import { element } from './ui-dom.mjs';

const button = (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title);
const say = (language, zh, en) => language === 'zh' ? zh : en;
const flush = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const byText = (root, title) => root.querySelectorAll('button').find(node => node.textContent === title || node.textContent.includes(title));
async function click(root, title) { const node = byText(root, title); assert.ok(node, `Missing ${title}`); await node.dispatch('click'); return node; }
async function check(input, checked = true) { assert.ok(input); input.checked = checked; await input.dispatch('change'); }
function scene(language, call) {
  const body = element('body', {}, element('div', { class: 'topbar-actions' })), calls = [];
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  let refreshed = 0;
  const ctx = { state: { language, instances: [], auth: { token: 'inert-ui-test-session' } }, el: element, button, toast() {}, refresh: async () => refreshed++, date: String,
    api: async (path, input) => { calls.push({ path, input: input === undefined ? undefined : structuredClone(input) }); return call(path, input); } };
  return { body, calls, ctx, ui: createStartupPlanUi(ctx), get refreshed() { return refreshed; } };
}
const initial = () => ({ format: 'world-hub.launcher-startup-plan/v1', revision: 'rev-one', onFailure: 'continue-independent', members: [{ programId: 'source', enabled: false, after: [] }, { programId: 'desk', enabled: false, after: [] }] });
const programs = [{ programId: 'source', title: { zh: '来源', en: 'Source' }, state: 'stopped' }, { programId: 'desk', title: { zh: '界面', en: 'Desk' }, state: 'stopped' }];

test('STARTUP-PLAN-UI detail shortcuts route directly to the real Workbench editor without a save or execution API', async () => {
  for (const language of ['en', 'zh']) {
    const opened = [], instance = { id: 'test-pack', packageDirectory: 'F:/real-source' };
    const view = scene(language, async path => { throw new Error('Routing cannot call ' + path); });
    const ui = createStartupPlanUi({ ...view.ctx, openGlobalEditor: () => opened.push('global'), openPackEditor: row => opened.push(row) });
    await ui.open(); await ui.openPack(instance);
    assert.deepEqual(opened, ['global', instance]); assert.equal(view.body.querySelector('dialog'), null); assert.deepEqual(view.calls, []);
  }
});

test('STARTUP-EDITOR both languages precisely order drafts, reject dependency conflicts and restore the current saved customization', async () => {
  for (const language of ['en', 'zh']) {
    const savedPack = { startupOrder: ['source', 'spare', 'desk'], components: [{ id: 'source', settings: { text: 'keep' } }, { id: 'spare', autostart: false }, { id: 'desk', after: ['source'] }] };
    const pack = structuredClone(savedPack), changes = [];
    const editor = createStartupPlanEditor({ state: { language }, el: element, button, pack, savedPack, onChange: () => changes.push('draft') });
    assert.match(editor.querySelector('[data-startup-selected-order]').textContent, /1. source.*2. desk/);
    let position = editor.querySelector('[name="startupPosition:spare"]'); position.value = '0'; await position.dispatch('change');
    assert.deepEqual(pack.startupOrder, ['spare', 'source', 'desk']);
    position = editor.querySelector('[name="startupPosition:desk"]'); position.value = '0'; await position.dispatch('change');
    assert.deepEqual(pack.startupOrder, ['spare', 'source', 'desk']); assert.match(editor.querySelector('[data-startup-editor-status]').textContent, /STARTUP_ORDER_INVALID/);
    await check(editor.querySelector('[name="startupMember:spare"]')); assert.equal(pack.components[1].autostart, true);
    assert.match(editor.querySelector('[data-startup-selected-order]').textContent, /1. spare.*2. source.*3. desk/);
    await click(editor, say(language, '恢复默认', 'Restore defaults'));
    assert.deepEqual(pack.startupOrder, ['source', 'spare', 'desk']); assert.equal(pack.components[1].autostart, false); assert.equal(pack.components[0].settings.text, 'keep');
    assert.match(editor.textContent, say(language, /当前已保存版本/, /current saved version/)); assert.ok(changes.length >= 3);
  }
});

test('STARTUP-EDITOR defaults retain new draft modules, exclude removed prerequisites visibly and restore saved failure policy', async () => {
  const savedPack = { components: [{ id: 'removed' }, { id: 'desk', after: ['removed'], autostart: true }] };
  const pack = { components: [{ id: 'desk', after: [], autostart: false, settings: { url: 'unchanged' } }, { id: 'new-local', after: ['desk'], autostart: false }], bindings: [{ from: 'new-local', to: 'desk' }] };
  const policy = { onFailure: 'stop-plan' }, savedPolicy = { onFailure: 'continue-independent' };
  const editor = createStartupPlanEditor({ state: { language: 'en' }, el: element, button, pack, savedPack, globalPlan: policy, savedGlobalPlan: savedPolicy });
  await click(editor, 'Restore defaults');
  assert.deepEqual(pack.components.map(row => row.id), ['desk', 'new-local']); assert.deepEqual(pack.components[0].after, []); assert.equal(pack.components[0].autostart, true); assert.equal(pack.components[1].autostart, false);
  assert.deepEqual(pack.components[1].after, ['desk']); assert.deepEqual(pack.startupOrder, ['desk', 'new-local']); assert.equal(policy.onFailure, 'continue-independent');
  assert.match(editor.textContent, /excluded.*desk → removed/); assert.match(editor.textContent, /New draft members.*new-local/); assert.equal(pack.components[0].settings.url, 'unchanged'); assert.deepEqual(pack.bindings, [{ from: 'new-local', to: 'desk' }]);
});

test('STARTUP-EDITOR rejects unknown, duplicate, cyclic and conflicting exact orders', () => {
  assert.throws(() => resolveDraftStartupOrder([{ id: 'a' }, { id: 'b' }], ['a', 'a']), /STARTUP_ORDER_INVALID/);
  assert.throws(() => resolveDraftStartupOrder([{ id: 'a', after: ['missing'] }]), /STARTUP_ORDER_INVALID/);
  assert.throws(() => resolveDraftStartupOrder([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }]), /STARTUP_ORDER_INVALID/);
  assert.throws(() => resolveDraftStartupOrder([{ id: 'a' }, { id: 'b', after: ['a'] }], ['b', 'a']), /STARTUP_ORDER_INVALID/);
  assert.deepEqual(resolveDraftStartupOrder([{ id: 'b', after: ['a'] }, { id: 'a' }, { id: 'manual', autostart: false }]), ['a', 'b', 'manual']);
  assert.deepEqual(resolveDraftStartupOrder([{ id: 'a', after: ['c'] }, { id: 'b' }, { id: 'c' }]), ['c', 'a', 'b'], 'Omitted order uses the same depth-first resolution as Runtime');
});

test('STARTUP-PLAN-UI bilingual execution requires concrete source review and explicit consent, and shows partial member results truthfully', async () => {
  for (const language of ['en', 'zh']) {
    const plan = initial(); plan.members[1] = { programId: 'desk', enabled: true, after: ['source'] };
    const view = scene(language, async (path, input) => {
      if (path.endsWith('/review')) return { reviewId: 'checked-plan', review: { plan, order: ['desk'], members: [{ ...plan.members[1], execution: { manifest: { id: 'external.desk', version: '7.2.1', permissions: { filesystem: 'instance-data' } } } }] } };
      if (path.endsWith('/start')) { assert.deepEqual(input, { reviewId: 'checked-plan', accepted: true }); return { operationId: 'plan-operation' }; }
      if (path === '/api/operations/plan-operation') return { operation: { state: 'partial', result: { plan, order: ['desk'], results: [{ programId: 'desk', state: 'blocked', blockedBy: ['source'] }], cancelled: false, halted: false } } };
      throw new Error(path);
    });
    await view.ui.reviewPlan(); const dialog = view.body.querySelector('dialog');
    assert.match(dialog.textContent, /external\.desk @7\.2\.1/);
    assert.equal(dialog.querySelector('[name=acceptStartupPlan]').checked, undefined);
    await click(dialog, say(language, '确认并执行启动计划', 'Confirm and run startup plan')); assert.equal(view.calls.length, 1);
    await check(dialog.querySelector('[name=acceptStartupPlan]')); await click(dialog, say(language, '确认并执行启动计划', 'Confirm and run startup plan'));
    assert.equal(view.refreshed, 1); assert.match(dialog.textContent, say(language, /部分完成/, /completed partially/));
    assert.equal(dialog.querySelector('[data-program-id=source]').attributes['data-startup-state'], 'skipped');
    assert.equal(dialog.querySelector('[data-program-id=desk]').attributes['data-startup-state'], 'blocked');
    assert.equal(view.calls.filter(call => call.path.endsWith('/start')).length, 1);
    dialog.close();
  }
});

test('STARTUP-PLAN-UI cancel uses the existing operation and waits for its cleanup receipt without starting a second plan', async () => {
  const observation = deferred(); let cancelled = false;
  const plan = initial(); plan.members[0].enabled = true;
  const view = scene('en', async path => {
    if (path.endsWith('/review')) return { reviewId: 'checked', review: { plan, order: ['source'], members: [] } };
    if (path.endsWith('/start')) return { operationId: 'cancel-one' };
    if (path.endsWith('/cancel')) { cancelled = true; observation.resolve({ operation: { state: 'cancelled', result: { plan, cancelled: true, results: [{ programId: 'source', state: 'cancelled' }] } } }); return {}; }
    if (path === '/api/operations/cancel-one') return observation.promise;
    throw new Error(path);
  });
  await view.ui.reviewPlan(); const dialog = view.body.querySelector('dialog'); await check(dialog.querySelector('[name=acceptStartupPlan]'));
  const pending = byText(dialog, 'Confirm and run startup plan').dispatch('click'); await flush();
  const cancel = byText(dialog, 'Cancel this startup plan'); assert.equal(cancel.disabled, false); await cancel.dispatch('click'); await pending;
  assert.equal(cancelled, true); assert.equal(cancel.disabled, true); assert.match(dialog.textContent, /was cancelled/);
  assert.equal(view.calls.filter(call => call.path.endsWith('/start')).length, 1); assert.equal(view.refreshed, 1); dialog.close();
});

test('STARTUP-PLAN-UI a closed pending review cannot acquire execution controls', async () => {
  const pending = deferred();
  const view = scene('en', async path => { if (path.endsWith('/review')) return pending.promise; throw new Error('Unexpected ' + path); });
  const review = view.ui.reviewPlan(); await flush(); const checking = view.body.querySelector('dialog'); checking.close();
  pending.resolve({ reviewId: 'expired', review: { plan: initial(), order: [], members: [] } }); await review;
  assert.equal(view.body.querySelector('dialog'), null); assert.ok(view.calls.every(call => !call.path.endsWith('/start')));
});

test('STARTUP-PLAN-UI prerequisites are explicit independent choices and unresolved declarations remain visible until removed', async () => {
  const helper = createPackParadigmUi({ state: { language: 'en' }, el: element, button });
  const editor = helper.prerequisitesEditor({ id: 'desk', after: ['missing'] }, [{ id: 'desk' }, { id: 'source' }, { id: 'stats' }]);
  assert.deepEqual(editor.read(), ['missing']); assert.match(editor.node.textContent, /no longer in composition/);
  assert.equal(editor.node.querySelector('[name="startupAfter:desk"]'), null);
  await check(editor.node.querySelector('[name="startupAfter:source"]')); await check(editor.node.querySelector('[name="startupAfter:missing"]'), false);
  assert.deepEqual(editor.read(), ['source']);
});

test('STARTUP-PLAN-UI compose never turns capability providers into prerequisites; explicit choices and manual Atomic members survive preset rerenders', async () => {
  const contract = { id: 'arbitrary.text', version: '1.0.0' }, calls = [];
  const view = scene('en', async (path, input) => {
    calls.push({ path, input: structuredClone(input) });
    if (path === '/api/paths/known') return { objects: ['source', 'desk'].map(id => ({ kind: 'module', id, path: `F:\\${id}` })) };
    if (path === '/api/deployment/inspect') { const id = input.directory.includes('source') ? 'source' : 'desk'; return { manifest: { id, version: '1.0.0', provides: id === 'source' ? [contract] : [], requires: id === 'desk' ? [contract] : [] }, deploymentReview: { deployment: { title: id, settings: [{ key: 'text', type: 'string', default: 'keep', label: { en: 'Text' } }] } } }; }
    if (path === '/api/compositions/preview') return { reviewId: 'composition', preview: { sources: [] } };
    throw new Error(path);
  });
  const ui = createDeploymentUi(view.ctx); await ui.compose(); const dialog = view.body.querySelector('dialog');
  const picker = dialog.querySelectorAll('select').find(select => select.options.some(option => option.textContent.includes('source @')));
  picker.value = '0'; await click(dialog, 'Add module'); picker.value = '1'; await click(dialog, 'Add module');
  await click(dialog, 'Review composition');
  let preview = calls.filter(call => call.path === '/api/compositions/preview').at(-1).input;
  assert.deepEqual(preview.modules[1].providers, [{ from: 'program1', contract }]); assert.deepEqual(preview.modules[1].after, []);
  const review = view.body.querySelectorAll('dialog').at(-1); review.close();
  let desk = dialog.querySelectorAll('article').find(article => article.querySelector('h3').textContent.startsWith('desk @'));
  await check(desk.querySelector('[name="startupAfter:program1"]')); await check(desk.querySelector('[name=autostart]'), false);
  await check(dialog.querySelectorAll('[name=packType]')[1]); await check(dialog.querySelectorAll('[name=packType]')[0]);
  desk = dialog.querySelectorAll('article').find(article => article.querySelector('h3').textContent.startsWith('desk @'));
  assert.equal(desk.querySelector('[name="startupAfter:program1"]').checked, true); assert.equal(Boolean(desk.querySelector('[name=autostart]').checked), false);
  await click(dialog, 'Review composition'); preview = calls.filter(call => call.path === '/api/compositions/preview').at(-1).input;
  assert.equal(preview.packType, 'atomic'); assert.equal(preview.modules[1].autostart, false); assert.deepEqual(preview.modules[1].after, ['program1']); assert.equal(preview.modules[1].settings.text, 'keep');
  assert.ok(calls.every(call => !call.path.endsWith('/create')));
});

test('STARTUP-PLAN-UI task center distinguishes partial starts from path discovery and retains per-member results', async () => {
  const plan = initial(); plan.members[1].enabled = true;
  const view = scene('en', async () => ({ operations: [{ id: 'partial-plan', kind: 'local-startup-plan', instanceId: '$local-startup-plan', state: 'partial', result: { plan, results: [{ programId: 'source', state: 'already-running' }, { programId: 'desk', state: 'blocked', blockedBy: ['source'], error: { message: 'not ready' } }] } }] }));
  const tasks = createTaskUi(view.ctx); await tasks.open(); const dialog = view.body.querySelector('dialog');
  assert.match(dialog.textContent, /Run Global Hub startup plan/); assert.match(dialog.textContent, /Partially completed/); assert.match(dialog.textContent, /Blocked by prerequisites/); assert.doesNotMatch(dialog.textContent, /discovery is incomplete/);
  assert.equal(dialog.querySelectorAll('[data-startup-state]').length, 2); await click(dialog, 'Lifecycle'); assert.match(dialog.textContent, /partial-plan|startup plan/); dialog.close();
});

test('STARTUP-PLAN-UI the actual instance Hub-only review clearly binds this run without changing the saved plan or sending a mutable mode at start', async () => {
  const source = await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8');
  for(const language of ['en','zh']) {
    const selectors = new Map(['#trust-dialog','#trust-consent','#trust-submit','#trust-error','#trust-review','.consent'].map(key => [key,element(key==='#trust-dialog'?'dialog':'div')]));
    const state={language,instances:[{instanceId:'selected instance',environment:{nodePath:'C:/node.exe'}}],environmentSelection:{},reviews:new Map(),trustRequest:0};
    const calls=[],completed=[],sandbox=vm.createContext({state,el:element,$:selector=>selectors.get(selector),idOf:row=>row.instanceId,operationFor:()=>null,endpoint:(id,action)=>`/api/instances/${encodeURIComponent(id)}/${action}`,
      t:key=>key==='codeExecutionNotice'?say(language,'启动将执行下列模块','Starting executes the modules listed below'):key,say:(zh,en)=>say(language,zh,en),pill:title=>element('span',{},title),definition:rows=>element('dl',{},rows.map(row=>element('dd',{},row.join(': ')))),runtimeEnvironment:()=>[],moduleView:()=>element('article'),display:String,date:String,
      renderDetail(){},renderError(_target,error){throw error;},reviewExpired:()=>false,invalidateExecutionReview(){throw new Error('Unexpected invalidation');},followOperation:async(...args)=>completed.push(args),
      api:async(path,input)=>{calls.push({path,input:structuredClone(input)});if(path.endsWith('/review'))return {reviewId:'mode-bound-review',startupMode:input.startupMode??'plan',review:{pack:{id:'current',version:'1.0.0'},digest:'digest',startupMode:input.startupMode??'plan',order:['source','desk'],initialOrder:input.startupMode==='hub-only'?[]:['source'],modules:[]}};return {operationId:'started-hub'};}});
    vm.runInContext(source.slice(source.indexOf('function reviewView('),source.indexOf('function updateTabVisibility(')),sandbox);
    vm.runInContext(source.slice(source.indexOf('async function reviewInstance('),source.indexOf('async function stopInstance(')),sandbox);
    await sandbox.reviewInstance('selected instance','start',{startupMode:'hub-only'});
    assert.deepEqual(calls[0],{path:'/api/instances/selected%20instance/review',input:{nodePath:'C:/node.exe',startupMode:'hub-only'}});
    assert.equal(state.trustStartupMode,'hub-only');const content=selectors.get('#trust-review');assert.equal(content.querySelector('[data-review-startup-mode]').attributes['data-review-startup-mode'],'hub-only');
    assert.match(content.textContent,say(language,/本次不启动任何模块/,/No modules start in this run/));assert.doesNotMatch(content.querySelector('.review-order').textContent,/source|desk/);
    assert.match(content.textContent,say(language,/下面的模块清单供核对已安装来源和权限/,/module list below is for inspecting installed sources and permissions/));
    assert.match(content.textContent,say(language,/之后启动模块仍需单独审阅授权/,/starting a module later still requires a separate execution review and authorization/));
    assert.doesNotMatch(content.textContent,/启动将执行下列模块|Starting executes the modules listed below/);
    const ordinary=element('div',{},sandbox.reviewView({review:{pack:{},modules:[],startupMode:'plan'}}));
    assert.match(ordinary.textContent,say(language,/启动将执行下列模块/,/Starting executes the modules listed below/));
    const isolated=element('div',{},sandbox.reviewView({isolation:{profile:'docker'},review:{pack:{},modules:[],startupMode:'plan'}}));
    assert.match(isolated.textContent,say(language,/请核对执行模式与固定限制/,/Inspect the execution profile and fixed restrictions/));
    selectors.get('#trust-consent').checked=true;await sandbox.authorizeExecution();
    assert.deepEqual(calls[1],{path:'/api/instances/selected%20instance/start',input:{reviewId:'mode-bound-review',accepted:true}});assert.equal(completed.length,1);
  }
});

test('STARTUP-PLAN-UI Global Hub stopped registrations stay stopped without inventing an exited process or a PID', async () => {
  const source=await readFile(new URL('../../../tools/launcher/public/app.mjs',import.meta.url),'utf8');
  for(const language of ['zh','en']) {
    const sandbox=vm.createContext({state:{language,lastRefresh:'2026-10-15T00:00:00Z'},el:element,button,pill:title=>element('span',{},title),
      say:(zh,en)=>say(language,zh,en),t:key=>({processExited:say(language,'已退出','Exited'),processRunning:say(language,'运行中','Running')})[key]??key,
      createIcon:()=>element('span'),date:String,freshObservation:()=>true,programTitle:program=>program.programId,
      refresh(){},changeTab(){},loadGlobalTopology(){}});
    vm.runInContext(source.slice(source.indexOf('function processBadge('),source.indexOf('function stats(')),sandbox);
    vm.runInContext(source.slice(source.indexOf('function renderGlobalHubStatus('),source.indexOf('function renderGlobalHubModules(')),sandbox);
    const rendered=element('div',{},sandbox.renderGlobalHubStatus({},true,true,false,[
      {programId:'registered-not-running',state:'stopped',pid:null},
      {programId:'explicit-exit-observation',state:'exited',pid:null}
    ]));
    const [stopped,exited]=rendered.querySelectorAll('.component-row');
    assert.match(stopped.children[1].textContent,say(language,/未启动 \/ 已停止/,/Not started \/ stopped/));
    assert.doesNotMatch(stopped.children[1].textContent,/已退出|Exited|PID/);
    assert.match(exited.children[1].textContent,say(language,/已退出/,/Exited/));
  }
});

test('STARTUP-PLAN-UI review and export buttons are in detail-nav-actions, and Global Hub removes redundant refresh button', async () => {
  const source = await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8');
  for (const language of ['zh', 'en']) {
    const navActions = element('div', { id: 'detail-nav-actions' });
    const detailActions = element('div', { id: 'detail-actions' });
    const detailHeading = element('div', { id: 'detail-heading' });
    const detailNotice = element('div', { id: 'detail-notice' });
    const elementsMap = new Map([
      ['#detail-nav-actions', navActions],
      ['#detail-actions', detailActions],
      ['#detail-heading', detailHeading],
      ['#detail-notice', detailNotice]
    ]);
    const sandbox = vm.createContext({
      state: { language, lastRefresh: '2026-10-15T00:00:00Z', operations: new Map() },
      $: sel => elementsMap.get(sel) ?? null,
      el: element,
      button,
      pill: title => element('span', {}, title),
      say: (zh, en) => say(language, zh, en),
      t: key => ({
        review: say(language, '重新审阅', 'Review current contents'),
        exportPackage: say(language, '导出整合包', 'Export pack'),
        staticAssembly: say(language, '载入装配工作台', 'Load workbench'),
        delete: say(language, '删除', 'Delete'),
        start: say(language, '启动', 'Start'),
        stop: say(language, '停止', 'Stop')
      })[key] ?? key,
      createIcon: () => element('span'),
      date: String,
      updateTabVisibility() {},
      idOf: () => 'instance-1',
      operationFor: () => null,
      running: () => false,
      exitUnconfirmed: () => false,
      preparing: () => false,
      stopBlocked: () => false,
      effectivePack: () => ({ id: 'pack-1' }),
      packTypeOf: () => 'atomic',
      statusLabel: () => ['stopped', 'default'],
      isStale: () => false,
      renderPackLineage,
      packParadigms: { badge: () => element('span') },
      lifecyclePolicyOf: () => 'group',
      declaredModuleCount: () => 1,
      reviewInstance() {},
      stopInstance() {},
      confirmDeleteInstance() {},
      localLink: () => null,
      advanced: {
        openStartupPlan() {},
        openPackStartupPlan() {},
        openCreator() {},
        openCreatorFromPrograms() {}
      },
      deletionBlocked: () => false,
      hubOperation() {}
    });

    vm.runInContext(source.slice(source.indexOf('function renderDetailHeading('), source.indexOf('function renderStatus(')), sandbox);
    vm.runInContext(source.slice(source.indexOf('function renderGlobalHubDetailHeading('), source.indexOf('function renderGlobalHubStatus(')), sandbox);

    // 1. Render pack instance heading
    sandbox.renderDetailHeading({ instanceId: 'instance-1', pack: { id: 'pack-1' } });
    const navButtons = navActions.querySelectorAll('button');
    assert.equal(navButtons.length, 2);
    assert.match(navButtons[0].textContent, say(language, /导出整合包/, /Export pack/));
    assert.match(navButtons[1].textContent, say(language, /删除/, /Delete/));

    const packActions = detailActions.querySelectorAll('button');
    assert.ok(packActions.some(b => say(language, /启动计划/, /Startup plan/).test(b.textContent)));
    assert.ok(!packActions.some(b => say(language, /重新审阅/, /Review current contents/).test(b.textContent)));
    assert.ok(!packActions.some(b => say(language, /导出整合包/, /Export pack/).test(b.textContent)));
    assert.ok(!packActions.some(b => say(language, /删除/, /Delete/).test(b.textContent)));

    // 2. Render Global Hub heading
    sandbox.renderGlobalHubDetailHeading({ state: 'stopped' }, true, false, false, []);
    assert.equal(navActions.children.length, 0);
    const hubActions = detailActions.querySelectorAll('button');
    assert.ok(!hubActions.some(b => say(language, /刷新状态/, /Refresh Status/).test(b.textContent)));
    assert.ok(hubActions.some(b => say(language, /启动计划/, /Startup plan/).test(b.textContent)));
  }
});
