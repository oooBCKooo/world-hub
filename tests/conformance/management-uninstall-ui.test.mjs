import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
const walk = node => [node, ...node.children.flatMap(walk)];
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this.listeners = new Map(); this.attributes = {}; this.value = ''; this._text = ''; this.htmlWrites = 0;
    const classes = new Set();
    this.classList = { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value), toggle: (value, enabled) => { const on = enabled ?? !classes.has(value); on ? classes.add(value) : classes.delete(value); } };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.htmlWrites++; this.replaceChildren(); this._text = String(value); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const reply = (value, ok = true) => ({ ok, json: async () => structuredClone(value) });
const moduleRow = (id, extra = {}) => ({ programId: id, module: { id: `example.${id}`, version: '1.0.0' }, state: 'stopped', selected: true,
  canRemove: true, ownsProcess: false, groups: [], consumers: [], blockers: [], ...extra });
const review = (rows = [moduleRow('one')], extra = {}, envelope = {}) => ({ reviewId: 'review-one', expiresAt: new Date(Date.now() + 600000).toISOString(),
  review: { kind: 'module', targetId: 'one', programs: rows, programIds: rows.filter(row => row.selected).map(row => row.programId),
    retainedPrograms: rows.filter(row => !row.selected), requiresStop: [], stopOrder: [], groupsChanged: [], startupReferences: [], blocked: false,
    blockers: [], retainsFiles: true, ...extra }, ...envelope });

function scene(handle) {
  const body = new Element('body'), requests = [], toasts = [], events = [], confirmations = [];
  for (const id of ['group-manager-modal', 'group-list-box']) { const element = new Element('div'); element.id = id; body.append(element); }
  const get = id => walk(body).find(node => node.id === id);
  get('group-manager-modal').classList.add('hidden');
  const context = vm.createContext({
    document: { body, getElementById: get, createElement: tag => new Element(tag) }, localStorage: { getItem: () => '0' }, console,
    confirm: text => { confirmations.push(text); return true; },
    window: { hubCanvas: { state: { data: { csrfToken: 'csrf-test' } }, toast: (...args) => toasts.push(args), closeInspector: () => events.push('close-inspector') } },
    fetch: async (url, init = {}) => {
      const request = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers }; requests.push(request);
      const result = await handle?.(request); if (result !== undefined) return result?.json ? result : reply(result);
      if (url.endsWith('/preview')) return reply(review());
      if (url.endsWith('/apply') || url.endsWith('/remove')) return reply({ removed: true });
      throw new Error(`Unexpected request ${url}`);
    }
  });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController')
    + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;
  controller.data.programs = [moduleRow('one'), moduleRow('two'), moduleRow('shared')];
  controller.data.groups = [{ id: 'group-one', revision: 'rev-one', title: 'Example group', memberProgramIds: ['one', 'two', 'shared'] }];
  controller.fetchModulesData = async () => events.push('refresh');
  return { controller, get, body, requests, toasts, events, confirmations };
}
function accept(view) { view.get('uninstall-ack').checked = true; view.get('uninstall-ack').dispatch('change'); }

test('uninstall UI: inspector and card share reviewed module uninstall, retain files and remove group references', async () => {
  for (const entry of ['removeSelectedModule', 'removeProgramDirectly']) {
    const view = scene(request => request.url.endsWith('/preview') ? review([moduleRow('one', { groups: [{ id: 'group-one', title: 'Example group' }] })], {
      groupsChanged: [{ id: 'group-one', title: 'Example group', removed: false, removedProgramIds: ['one'] }], startupReferences: [{ programId: 'one' }] }) : undefined);
    view.controller.selectedModuleId = 'one'; view.controller.focusedWiringModuleId = 'one';
    await view.controller[entry]('one');
    assert.equal(view.requests.length, 1); assert.equal(view.requests[0].url, '/manage/api/uninstall/modules/one/preview');
    assert.equal(view.get('btn-apply-uninstall').disabled, true);
    assert.match(view.get('module-uninstall-modal').textContent, /源码、实例身份和本地数据保留/);
    assert.match(view.get('uninstall-effects').textContent, /更新分组：Example group/);
    await view.controller.applyUninstallReview(); assert.equal(view.requests.length, 1);
    accept(view); await view.controller.applyUninstallReview();
    assert.deepEqual(view.requests[1].body, { reviewId: 'review-one', accepted: true, stopOwned: true });
    assert.equal(view.requests[1].headers['X-Management-Token'], 'csrf-test');
    assert.equal(view.controller.selectedModuleId, null); assert.equal(view.controller.focusedWiringModuleId, null);
    assert.deepEqual(view.events, ['close-inspector', 'refresh']); assert.equal(view.controller.uninstallSession, null);
    assert.equal(view.confirmations.length, 0); assert.match(view.toasts.at(-1)[0], /本地数据保留/);
  }
});

test('uninstall UI: group management provides dissolve group action while group uninstall is accessed via uninstall manager', async () => {
  const view = scene(request => request.url.endsWith('/preview') ? review([moduleRow('one')], { kind: 'module-group', targetId: 'group-one' }) : undefined);
  view.controller.openGroupModal();
  const buttons = walk(view.get('group-list-box')).filter(node => node.tag === 'button');
  assert.deepEqual(buttons.map(node => node.textContent), ['解散分组']);
  await view.controller.openUninstallManager('groups', 'group-one');
  assert.equal(view.requests[0].url, '/manage/api/uninstall/groups/group-one/preview');
  assert.match(view.get('uninstall-manager-title').textContent, /整组/);
});

test('uninstall UI: retained shared providers are shown and never sent as selected or stopped', async () => {
  const shared = moduleRow('shared', { selected: false, canRemove: false, state: 'running', ownsProcess: true,
    groups: [{ id: 'other', title: 'Other group' }], blockers: [{ code: 'UNINSTALL_SHARED_MEMBER', programId: 'shared' }] });
  const view = scene(request => request.url.endsWith('/preview') ? review([moduleRow('one', { state: 'running', ownsProcess: true }), shared], {
    kind: 'module-group', targetId: 'group-one', requiresStop: ['one'], stopOrder: ['one'], groupsChanged: [{ id: 'group-one', removed: true }] }) : undefined);
  view.controller.groupFilter = 'group-one'; await view.controller.openUninstallManager('groups', 'group-one');
  assert.match(view.get('uninstall-retained').textContent, /shared.*其他模块组/);
  assert.equal(view.controller.uninstallMemberInputs[1].checked, false); assert.equal(view.controller.uninstallMemberInputs[1].disabled, true);
  accept(view); view.get('uninstall-stop-owned').checked = false; view.get('uninstall-stop-owned').dispatch('change');
  assert.equal(view.get('btn-apply-uninstall').disabled, true); await view.controller.applyUninstallReview(); assert.equal(view.requests.length, 1);
  view.get('uninstall-stop-owned').checked = true; view.get('uninstall-stop-owned').dispatch('change');
  await view.controller.applyUninstallReview(); assert.equal(view.controller.groupFilter, 'all');
  assert.equal(view.requests.some(request => request.url.includes('/shared/')), false);
});

test('uninstall UI: changing group selection invalidates consent and rechecks dependencies before apply', async () => {
  const view = scene(request => {
    if (!request.url.endsWith('/preview')) return;
    if (request.body.programIds) return review([moduleRow('one', { selected: false }), moduleRow('two', { canRemove: false,
      blockers: [{ code: 'UNINSTALL_PROVIDER_IN_USE', consumerIds: ['one'] }] })], {
      kind: 'module-group', programIds: ['two'], blocked: true, blockers: [{ code: 'UNINSTALL_PROVIDER_IN_USE', consumerIds: ['one'] }] });
    return review([moduleRow('one'), moduleRow('two')], { kind: 'module-group' });
  });
  await view.controller.openUninstallManager('groups', 'group-one'); accept(view);
  const input = view.controller.uninstallMemberInputs[0]; input.checked = false; await input.dispatch('change');
  assert.deepEqual(view.requests[1].body, { programIds: ['two'] });
  assert.equal(view.get('uninstall-ack').checked, false); assert.equal(view.get('btn-apply-uninstall').disabled, true);
  assert.match(view.get('uninstall-effects').textContent, /one.*调整能力接线/);
  assert.equal(view.controller.uninstallMemberInputs[1].disabled, false, 'blocked selected provider must remain uncheckable by user');
  accept(view); await view.controller.applyUninstallReview(); assert.equal(view.requests.length, 2);
});

test('uninstall UI: empty group selection is a reviewed group-only removal and stopped programs need no stop consent', async () => {
  const view = scene(request => request.url.endsWith('/preview') ? review([moduleRow('one', { selected: false })], {
    kind: 'module-group', programIds: [], groupsChanged: [{ id: 'group-one', removed: true }] }) : undefined);
  await view.controller.openUninstallManager('groups', 'group-one');
  assert.match(view.get('uninstall-effects').textContent, /仅移除此分组/);
  view.get('uninstall-stop-owned').checked = false; accept(view);
  assert.equal(view.get('btn-apply-uninstall').disabled, false); await view.controller.applyUninstallReview();
  assert.equal(view.requests[1].body.stopOwned, false);
});

test('uninstall UI: nested preview/apply errors remain visible without false success or deleting current selection', async () => {
  const previewError = scene(() => reply({ error: { code: 'MISSING', message: '具体审阅失败原因' } }, false));
  await previewError.controller.removeProgramDirectly('one');
  assert.match(previewError.get('uninstall-error').textContent, /具体审阅失败原因/);
  assert.equal(previewError.get('btn-apply-uninstall').disabled, true);
  const applyError = scene(request => request.url.endsWith('/apply') ? reply({ error: { message: '登记保存失败' } }, false) : undefined);
  applyError.controller.selectedModuleId = 'one'; await applyError.controller.removeSelectedModule(); accept(applyError);
  await applyError.controller.applyUninstallReview();
  assert.match(applyError.get('uninstall-error').textContent, /登记保存失败/);
  assert.equal(applyError.controller.selectedModuleId, 'one'); assert.deepEqual(applyError.events, []); assert.deepEqual(applyError.toasts, []);
  assert.equal(applyError.controller.uninstallSession.review, null); assert.equal(applyError.get('btn-apply-uninstall').disabled, true);
});

test('uninstall UI: foreign process and other backend blockers cannot be bypassed by checking acknowledgment', async () => {
  const view = scene(request => request.url.endsWith('/preview') ? review([moduleRow('one', { state: 'unknown', canRemove: false,
    blockers: [{ code: 'LOCAL_PROCESS_OWNERSHIP_UNKNOWN' }] })], { blocked: true, blockers: [{ code: 'LOCAL_PROCESS_OWNERSHIP_UNKNOWN' }] }) : undefined);
  await view.controller.removeProgramDirectly('one'); accept(view); await view.controller.applyUninstallReview();
  assert.equal(view.requests.length, 1); assert.equal(view.get('btn-apply-uninstall').disabled, true);
  assert.match(view.get('uninstall-effects').textContent, /进程归属未知/);
});

test('uninstall UI: refresh failure after committed removal reports completion accurately without a second apply', async () => {
  const view = scene();
  view.controller.fetchModulesData = async () => { throw new Error('连接暂时断开'); };
  await view.controller.removeProgramDirectly('one'); accept(view); await view.controller.applyUninstallReview();
  assert.equal(view.controller.uninstallSession, null); assert.match(view.toasts.at(-1)[0], /卸载已完成，但列表刷新失败/);
  assert.equal(view.requests.filter(request => request.url.endsWith('/apply')).length, 1);
  const group = scene(); group.controller.fetchModulesData = async () => { throw new Error('连接暂时断开'); };
  await group.controller.removeModuleGroupOnly('group-one', 'rev-one');
  assert.match(group.toasts.at(-1)[0], /分组已删除，模块保留；列表刷新失败/);
  assert.doesNotMatch(group.toasts.at(-1)[0], /删除分组失败/);
});

test('uninstall UI: stale previews after target changes or closure never replace current target review', async () => {
  const old = deferred();
  const view = scene(request => request.url.includes('/one/preview') ? old.promise : review([moduleRow('two')], { targetId: 'two' }, { reviewId: 'review-two' }));
  const loading = view.controller.openUninstallManager('modules', 'one'); await view.controller.openUninstallManager('modules', 'two');
  old.resolve(review()); await loading;
  assert.equal(view.controller.uninstallSession.targetId, 'two'); assert.equal(view.controller.uninstallSession.review.reviewId, 'review-two');
  assert.match(view.get('uninstall-programs').textContent, /example.two/);
  const late = deferred(), closed = scene(() => late.promise);
  const pending = closed.controller.openUninstallManager('modules', 'one'); closed.controller.closeUninstallManager(); late.resolve(review()); await pending;
  assert.equal(closed.controller.uninstallSession, null); assert.equal(closed.get('module-uninstall-modal').classList.contains('hidden'), true);
});

test('uninstall UI: stale selection responses and expired reviews cannot authorize an uninstall', async () => {
  const late = deferred(); let selections = 0;
  const view = scene(request => {
    if (!request.url.endsWith('/preview') || !request.body.programIds) return review([moduleRow('one'), moduleRow('two')], { kind: 'module-group' });
    if (++selections === 1) return late.promise;
    return review([moduleRow('one', { selected: false }), moduleRow('two', { selected: false })], { kind: 'module-group', programIds: [] }, { reviewId: 'latest' });
  });
  await view.controller.openUninstallManager('groups', 'group-one');
  const prior = view.controller.previewUninstall(['one']); await view.controller.previewUninstall([]); late.resolve(review()); await prior;
  assert.equal(view.controller.uninstallSession.review.reviewId, 'latest');
  view.controller.uninstallSession.review.expiresAt = new Date(Date.now() - 1).toISOString(); accept(view);
  assert.equal(view.get('btn-apply-uninstall').disabled, true); await view.controller.applyUninstallReview();
  assert.match(view.get('uninstall-error').textContent, /已过期/); assert.equal(view.requests.some(request => request.url.endsWith('/apply')), false);
});

test('uninstall UI: in-flight apply is single-shot, cannot close or redirect to another target', async () => {
  const applying = deferred(), view = scene(request => request.url.endsWith('/apply') ? applying.promise : undefined);
  await view.controller.removeProgramDirectly('one'); accept(view);
  const pending = view.controller.applyUninstallReview(); await view.controller.applyUninstallReview();
  view.controller.closeUninstallManager(); await view.controller.openUninstallManager('modules', 'two');
  assert.equal(view.controller.uninstallSession.targetId, 'one'); assert.equal(view.requests.filter(request => request.url.endsWith('/apply')).length, 1);
  assert.equal(view.get('btn-close-uninstall').disabled, true); applying.resolve({ removed: true }); await pending;
  assert.equal(view.controller.uninstallSession, null); assert.deepEqual(view.events, ['refresh']);
});

test('uninstall UI: group-only delete checks nested API error and guards duplicate submissions', async () => {
  const failed = scene(() => reply({ error: { message: '分组修订已变化' } }, false)); failed.controller.groupFilter = 'group-one';
  await failed.controller.removeModuleGroupOnly('group-one', 'rev-one', 'Example group');
  assert.match(failed.toasts.at(-1)[0], /分组修订已变化/); assert.equal(failed.controller.groupFilter, 'group-one'); assert.deepEqual(failed.events, []);
  const pending = deferred(), view = scene(() => pending.promise); view.controller.groupFilter = 'group-one';
  const removing = view.controller.removeModuleGroupOnly('group-one', 'rev-one', 'Example group');
  await view.controller.removeModuleGroupOnly('group-one', 'rev-one'); assert.equal(view.requests.length, 1);
  assert.deepEqual(view.requests[0].body, { expectedRevision: 'rev-one' });
  pending.resolve({ removed: true }); await removing;
  assert.equal(view.controller.groupFilter, 'all'); assert.deepEqual(view.events, ['refresh']); assert.match(view.toasts.at(-1)[0], /模块保留/);
});

test('uninstall UI: all publisher labels use text nodes and target paths are encoded', async () => {
  const view = scene(request => request.url.endsWith('/preview') ? review([moduleRow('one', { module: { id: '<img src=x onerror=bad()>', version: '1.0.0' } })]) : undefined);
  await view.controller.openUninstallManager('modules', 'one/other');
  assert.equal(view.requests[0].url, '/manage/api/uninstall/modules/one%2Fother/preview');
  assert.match(view.get('uninstall-programs').textContent, /<img src=x/);
  assert.equal(walk(view.get('module-uninstall-modal')).reduce((sum, node) => sum + node.htmlWrites, 0), 0);
});
