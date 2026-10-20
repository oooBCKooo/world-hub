import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import english from '../../src/management/canvas-i18n.mjs';

const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
const consoleHtml = await readFile(new URL('../../src/management/console.html', import.meta.url), 'utf8');
const walk = node => [node, ...node.children.flatMap(walk)];
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.value = ''; this._text = ''; this.htmlWrites = 0;
    const classes = new Set();
    this.classList = { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value), toggle: (value, enabled) => (enabled ?? !classes.has(value)) ? classes.add(value) : classes.delete(value) };
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
const reply = (value, ok = true) => ({ ok, json: async () => structuredClone(value) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const row = (id = 'one', extra = {}) => ({ programId: id, module: { id: `example.${id}`, version: '1.0.0' }, state: 'stopped',
  source: { kind: 'module', id: `example.${id}`, version: '1.0.0' },
  before: { topics: { events: 'custom/events' }, bridges: { main: { publish: ['events'], subscribe: [] } }, bindings: [] },
  after: { topics: { events: 'author/events' }, bridges: { main: { publish: ['events'], subscribe: [] } }, bindings: [] },
  affected: { sharedWithGroups: [], consumers: [] }, changed: true, ...extra });
const review = (extra = {}, envelope = {}) => ({ reviewId: 'review-one', expiresAt: new Date(Date.now() + 600000).toISOString(),
  review: { scope: 'all', programs: [row()], blocked: false, blockers: [], missingGroupSources: [], connections: [], requiresStop: [], groupBaselinesEstablished: [], ...extra }, ...envelope });
function scene(handle) {
  const body = new Element('body'), requests = [], toasts = [], events = [];
  const panel = new Element('div'); panel.id = 'bottom-exec-controls'; body.append(panel);
  const get = id => walk(body).find(node => node.id === id);
  const context = vm.createContext({ document: { body, getElementById: get, createElement: tag => new Element(tag), addEventListener() {}, querySelectorAll: () => [] },
    localStorage: { getItem: () => '0' }, console: { ...console, warn() {} }, confirm: () => true,
    window: { addEventListener() {}, hubCanvas: { state: { data: { csrfToken: 'test-token' } }, toast: (...args) => toasts.push(args) } },
    fetch: async (url, init = {}) => {
      const request = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers }; requests.push(request);
      const result = await handle?.(request); if (result !== undefined) return result?.json ? result : reply(result);
      if (url.endsWith('/preview')) return reply(review());
      if (url.endsWith('/apply')) return reply({ applied: true });
      throw new Error(`Unexpected request ${url}`);
    }
  });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;
  controller.data.programs = [row('one'), row('two')];
  controller.data.groups = [{ id: 'group-one', title: 'First group', memberProgramIds: ['one', 'two'] }];
  const realFetchModulesData = controller.fetchModulesData.bind(controller);
  controller.fetchModulesData = async () => { events.push('refresh'); };
  return { controller, get, body, requests, toasts, events, context, realFetchModulesData };
}
function accept(view) { view.get('wiring-defaults-ack').checked = true; view.get('wiring-defaults-ack').dispatch('change'); }

test('default wiring UI: one top button survives static and dynamic panel paths, binds, and appears only in wiring mode', async () => {
  assert.equal((consoleHtml.match(/id="btn-restore-default-wiring"/g) || []).length, 1);
  assert.equal((source.match(/id="btn-restore-default-wiring"/g) || []).length, 1);
  for (const existing of [false, true]) {
    const view = scene();
    if (existing) { const button = new Element('button'); button.id = 'btn-restore-default-wiring'; view.get('bottom-exec-controls').append(button); }
    view.controller.ensureWiringActionButtons(); view.controller.ensureWiringActionButtons();
    assert.equal(walk(view.body).filter(node => node.id === 'btn-restore-default-wiring').length, 1);
    view.controller.bindEvents();
    for (const mode of ['runtime', 'static', 'orchestration', 'wiring']) {
      view.controller.mode = mode; view.controller.updateGroupActionButtons();
      assert.equal(view.get('btn-restore-default-wiring').style.display, mode === 'wiring' ? 'inline-flex' : 'none');
    }
    await view.get('btn-restore-default-wiring').dispatch('click'); assert.equal(view.requests[0].url, '/manage/api/wiring/defaults/preview');
  }
});

test('default wiring UI: defaults scope to current group, otherwise focused module, otherwise all', async () => {
  for (const [groupFilter, focusedWiringModuleId, expected] of [
    ['group-one', 'one', { scope: 'group', targetId: 'group-one' }], ['all', 'one', { scope: 'module', targetId: 'one' }], ['all', null, { scope: 'all' }],
    ['deleted-group', 'deleted-module', { scope: 'all' }]
  ]) {
    const view = scene(); Object.assign(view.controller, { groupFilter, focusedWiringModuleId });
    await view.controller.openWiringDefaultsManager(); assert.deepEqual(view.requests[0].body, expected);
    assert.equal(view.get('wiring-defaults-scope').children.length, 1 + (groupFilter === 'group-one' ? 1 : 0) + (focusedWiringModuleId === 'one' ? 1 : 0));
  }
});

test('default wiring UI: scope change invalidates consent and rechecks the exact target', async () => {
  const view = scene(); view.controller.groupFilter = 'group-one'; view.controller.focusedWiringModuleId = 'one';
  await view.controller.openWiringDefaultsManager(); accept(view);
  view.get('wiring-defaults-scope').value = 'module:one'; await view.get('wiring-defaults-scope').dispatch('change');
  assert.deepEqual(view.requests[1].body, { scope: 'module', targetId: 'one' }); assert.equal(view.get('wiring-defaults-ack').checked, false);
  view.get('wiring-defaults-scope').value = 'all'; await view.get('wiring-defaults-scope').dispatch('change'); assert.deepEqual(view.requests[2].body, { scope: 'all' });
});

test('default wiring UI: queued manual wiring must finish before opening, previewing or applying defaults', async () => {
  const mutation = deferred(), view = scene();
  view.controller.pendingMutations = 1;
  view.controller.mutationQueue = mutation.promise.then(() => { view.controller.pendingMutations = 0; });
  await view.controller.openWiringDefaultsManager(); assert.equal(view.requests.length, 0); assert.match(view.toasts.at(-1)[0], /接线同步中/);
  mutation.resolve(); await view.controller.mutationQueue; await view.controller.openWiringDefaultsManager(); assert.equal(view.requests.length, 1);
  accept(view); view.controller.pendingMutations = 1; await view.controller.applyWiringDefaultsReview(); assert.equal(view.requests.length, 1);
  assert.equal(view.controller.wiringDefaultsSession.review, null); assert.match(view.get('wiring-defaults-error').textContent, /接线同步中/);
  await view.controller.previewWiringDefaults(); assert.equal(view.requests.length, 1);
  view.controller.pendingMutations = 0; await view.controller.previewWiringDefaults(); assert.equal(view.requests.length, 2);
});

test('default wiring UI: explains author version, exact before/after permissions and affected peers without publisher HTML', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const view = scene(() => review({ programs: [row('one', { source: { kind: 'module-group', id: unsafe, version: '2.3.4', groupId: 'group-one' },
    affected: { sharedWithGroups: [{ id: 'other', title: unsafe }], consumers: [{ programId: 'consumer', state: 'running' }] } })] }));
  await view.controller.openWiringDefaultsManager(); const box = view.get('wiring-defaults-review');
  assert.match(box.textContent, /2\.3\.4/); assert.match(box.textContent, /custom\/events.*author\/events/);
  assert.match(box.textContent, /桥发布 \/ 订阅权限/); assert.match(box.textContent, /能力提供者绑定/); assert.match(box.textContent, /consumer \(running\)/);
  assert.ok(box.textContent.includes(unsafe)); assert.equal(walk(view.get('wiring-defaults-modal')).some(node => node.htmlWrites), false);
  assert.match(view.get('wiring-defaults-modal').textContent, /参数、启动计划、版本、源码、实例身份与私有数据保持不变/);
});

test('default wiring UI: apply requires acknowledgment and sends only the reviewed token with CSRF', async () => {
  const view = scene(); await view.controller.openWiringDefaultsManager();
  await view.controller.applyWiringDefaultsReview(); assert.equal(view.requests.length, 1); accept(view);
  assert.equal(view.get('btn-apply-wiring-defaults').disabled, false); await view.controller.applyWiringDefaultsReview();
  assert.deepEqual(view.requests[1].body, { reviewId: 'review-one', accepted: true }); assert.equal(view.requests[1].headers['X-Management-Token'], 'test-token');
  assert.deepEqual(view.events, ['refresh']); assert.equal(view.controller.wiringDefaultsSession, null); assert.match(view.toasts[0][0], /已恢复/);
});

test('default wiring UI: blocked, no-op, changed-running and unresolved providers cannot be applied', async () => {
  for (const extra of [{ blocked: true, blockers: [{ code: 'CONFLICT', message: 'different group recipes' }] },
    { programs: [row('one', { changed: false, state: 'running' })] }, { requiresStop: ['one'] },
    { connections: [{ programId: 'one', id: 'peer', provider: { moduleId: 'example.peer', version: '1.0.0' }, status: 'missing', candidates: [] }] }]) {
    const view = scene(() => review(extra)); await view.controller.openWiringDefaultsManager(); accept(view); await view.controller.applyWiringDefaultsReview();
    assert.equal(view.get('btn-apply-wiring-defaults').disabled, true); assert.equal(view.requests.length, 1);
    if (extra.requiresStop) assert.match(view.get('wiring-defaults-review').textContent, /先停止.*one.*重新审阅/);
    if (extra.programs) assert.match(view.get('wiring-defaults-review').textContent, /已是默认接线/);
  }
});

test('default wiring UI: unchanged running peers do not block stopped changed modules', async () => {
  const view = scene(() => review({ programs: [row(), row('two', { changed: false, state: 'running' })] }));
  await view.controller.openWiringDefaultsManager(); accept(view); assert.equal(view.get('btn-apply-wiring-defaults').disabled, false);
  await view.controller.applyWiringDefaultsReview(); assert.equal(view.requests.length, 2);
});

test('default wiring UI: verified baseline can be saved even when wiring already matches', async () => {
  const view = scene(request => request.url.endsWith('/preview') ? review({ programs: [row('one', { changed: false, state: 'running' })], groupBaselinesEstablished: ['group-one'] }) : undefined);
  await view.controller.openWiringDefaultsManager(); accept(view); assert.equal(view.get('btn-apply-wiring-defaults').disabled, false);
  assert.match(view.get('btn-apply-wiring-defaults').textContent, /保存作者默认接线配方/); await view.controller.applyWiringDefaultsReview(); assert.equal(view.requests.length, 2);
});

test('default wiring UI: missing original group recipe shows exact release and native source chooser triggers fresh review', async () => {
  const artifact = 'F:\\downloads\\group-one.zip';
  const missing = { missingGroupSources: [{ groupId: 'group-one', id: 'author.group', version: '1.2.3' }], blocked: true };
  const view = scene(request => request.url === '/manage/api/paths/native-pick' ? { cancelled: false, path: artifact }
    : request.url.endsWith('/preview') ? review(request.body.groupSources ? { groupBaselinesEstablished: ['group-one'] } : missing) : undefined);
  view.controller.groupFilter = 'group-one'; await view.controller.openWiringDefaultsManager();
  assert.match(view.get('wiring-defaults-sources').textContent, /author\.group @ 1\.2\.3/); accept(view); assert.equal(view.get('btn-apply-wiring-defaults').disabled, true);
  const pick = walk(view.get('wiring-defaults-sources')).find(node => node.tag === 'button' && node.textContent === '选择 ZIP / JSON'); await pick.onclick();
  assert.deepEqual(view.requests[1].body, { purpose: 'file', initialPath: '' });
  assert.deepEqual(view.requests[2].body, { scope: 'group', targetId: 'group-one', groupSources: { 'group-one': artifact } });
  assert.equal(view.get('wiring-defaults-ack').checked, false); accept(view); assert.equal(view.get('btn-apply-wiring-defaults').disabled, false);
});

test('default wiring UI: path edits invalidate the prior token and are reviewed before apply', async () => {
  const view = scene(() => review({ blocked: true, missingGroupSources: [{ groupId: 'group-one', id: 'author.group', version: '1.0.0' }] }));
  await view.controller.openWiringDefaultsManager(); accept(view);
  const input = view.controller.wiringDefaultsInputs.find(node => node.tag === 'input'); input.value = 'F:\\download\\author-group'; await input.dispatch('input');
  assert.equal(view.controller.wiringDefaultsSession.review, null); assert.equal(view.get('wiring-defaults-ack').checked, false);
  await input.dispatch('change'); assert.equal(view.requests[1].body.groupSources['group-one'], input.value);
});

test('default wiring UI: incorrect source remains editable after backend returns a source error without missing metadata', async () => {
  let previews = 0;
  const view = scene(() => review(++previews === 1
    ? { blocked: true, missingGroupSources: [{ groupId: 'group-one', id: 'author.group', version: '1.2.3' }] }
    : previews === 2 ? { blocked: true, blockers: [{ code: 'SOURCE_INVALID', message: 'wrong source version' }] } : {}));
  await view.controller.openWiringDefaultsManager();
  let input = view.controller.wiringDefaultsInputs.find(node => node.tag === 'input'); input.value = 'F:\\wrong.zip'; await input.dispatch('input'); await input.dispatch('change');
  assert.match(view.get('wiring-defaults-review').textContent, /wrong source version/);
  input = view.controller.wiringDefaultsInputs.find(node => node.tag === 'input'); assert.equal(input.value, 'F:\\wrong.zip');
  assert.match(view.get('wiring-defaults-sources').textContent, /author\.group @ 1\.2\.3/);
  input.value = 'F:\\correct.zip'; await input.dispatch('input'); await input.dispatch('change');
  assert.equal(view.requests[2].body.groupSources['group-one'], 'F:\\correct.zip');
});

test('default wiring UI: provider selection rechecks exact instance without importing or starting anything', async () => {
  const connection = { programId: 'one', id: 'peer', provider: { moduleId: 'example.peer', version: '3.0.0' }, status: 'ambiguous', contracts: [], topics: {},
    candidates: ['peer-a', 'peer-b'].map(programId => ({ programId, module: { id: 'example.peer', version: '3.0.0' }, state: 'stopped' })) };
  const view = scene(request => review({ connections: [{ ...connection, ...(request.body.connectionSelections ? { status: 'resolved', providerId: 'peer-b' } : {}) }], blocked: !request.body.connectionSelections }));
  await view.controller.openWiringDefaultsManager(); accept(view);
  const select = view.controller.wiringDefaultsInputs.find(node => node.tag === 'select'); select.value = 'peer-b'; await select.dispatch('change');
  assert.deepEqual(view.requests[1].body, { scope: 'all', connectionSelections: { one: { peer: 'peer-b' } } });
  assert.equal(view.get('wiring-defaults-ack').checked, false); assert.match(view.get('wiring-defaults-connections').textContent, /已匹配实例：peer-b/);
  const change = view.controller.wiringDefaultsInputs.find(node => node.tag === 'select'); assert.equal(change.value, 'peer-b');
  change.value = 'peer-a'; await change.dispatch('change'); assert.equal(view.requests[2].body.connectionSelections.one.peer, 'peer-a');
  assert.equal(view.requests.some(request => /start|import|download|fetch/.test(request.url)), false);
});

test('default wiring UI: valid constructor instance and connection IDs remain ordinary selections without prototype mutation', async () => {
  const connection = { programId: 'constructor', id: 'constructor', provider: { moduleId: 'example.peer', version: '1.0.0' }, status: 'ambiguous',
    candidates: ['peer-a', 'peer-b'].map(programId => ({ programId, module: { id: 'example.peer', version: '1.0.0' }, state: 'stopped' })) };
  const view = scene(() => review({ connections: [connection] }));
  await view.controller.openWiringDefaultsManager();
  const select = view.controller.wiringDefaultsInputs.find(node => node.tag === 'select'); select.value = 'peer-a'; await select.dispatch('change');
  assert.deepEqual(view.requests[1].body.connectionSelections, { constructor: { constructor: 'peer-a' } });
  const session = view.controller.wiringDefaultsSession;
  assert.equal(Object.getPrototypeOf(session.connectionSelections), null); assert.equal(Object.getPrototypeOf(session.connectionSelections.constructor), null);
  assert.equal(Object.getPrototypeOf(session.groupSources), null); assert.equal(Object.getPrototypeOf(session.sourceDefinitions), null);
  assert.equal(vm.runInContext('Object.hasOwn(Object, "constructor")', view.context), false);
  assert.equal(vm.runInContext('Object.prototype["peer-a"]', view.context), undefined);
});

test('default wiring UI: nested API errors stay visible without fake success', async () => {
  for (const phase of ['preview', 'apply']) {
    const view = scene(request => request.url.endsWith(`/${phase}`) ? reply({ error: { message: '底层具体错误' } }, false) : undefined);
    await view.controller.openWiringDefaultsManager();
    if (phase === 'apply') { accept(view); await view.controller.applyWiringDefaultsReview(); }
    assert.match(view.get('wiring-defaults-error').textContent, /底层具体错误/); assert.equal(view.get('btn-apply-wiring-defaults').disabled, true); assert.deepEqual(view.toasts, []);
  }
});

test('default wiring UI: late target/scope responses and closed modal do not replace the current review', async () => {
  const old = deferred(); let count = 0;
  const view = scene(() => ++count === 1 ? old.promise : review({}, { reviewId: 'latest' }));
  const loading = view.controller.openWiringDefaultsManager(); view.controller.focusedWiringModuleId = 'one'; await view.controller.openWiringDefaultsManager();
  old.resolve(review()); await loading; assert.equal(view.controller.wiringDefaultsSession.review.reviewId, 'latest');
  const late = deferred(), closed = scene(() => late.promise); const pending = closed.controller.openWiringDefaultsManager(); closed.controller.closeWiringDefaultsManager(); late.resolve(review()); await pending;
  assert.equal(closed.controller.wiringDefaultsSession, null); assert.equal(closed.get('wiring-defaults-modal').classList.contains('hidden'), true);
});

test('default wiring UI: stale same-modal responses and expired reviews cannot authorize apply', async () => {
  const stale = deferred(); let count = 0;
  const view = scene(() => ++count === 1 ? stale.promise : review({}, { reviewId: 'latest' }));
  const first = view.controller.openWiringDefaultsManager(); await view.controller.previewWiringDefaults(); stale.resolve(review()); await first;
  assert.equal(view.controller.wiringDefaultsSession.review.reviewId, 'latest');
  view.controller.wiringDefaultsSession.review.expiresAt = new Date(Date.now() - 1).toISOString(); accept(view);
  assert.equal(view.get('btn-apply-wiring-defaults').disabled, true); await view.controller.applyWiringDefaultsReview();
  assert.match(view.get('wiring-defaults-error').textContent, /已过期/); assert.equal(view.requests.some(request => request.url.endsWith('/apply')), false);
});

test('default wiring UI: control mutation without change event cannot reuse an acknowledged review', async () => {
  const view = scene(); view.controller.focusedWiringModuleId = 'one'; await view.controller.openWiringDefaultsManager(); accept(view);
  view.get('wiring-defaults-scope').value = 'all'; await view.controller.applyWiringDefaultsReview();
  assert.equal(view.controller.wiringDefaultsSession.review, null); assert.equal(view.requests.length, 1);
});

test('default wiring UI: apply is single-shot and target or closure cannot change until completion', async () => {
  const pending = deferred(), view = scene(request => request.url.endsWith('/apply') ? pending.promise : undefined);
  await view.controller.openWiringDefaultsManager(); accept(view); const applying = view.controller.applyWiringDefaultsReview();
  await view.controller.applyWiringDefaultsReview(); const original = view.controller.wiringDefaultsSession;
  view.controller.closeWiringDefaultsManager(); view.controller.groupFilter = 'group-one'; await view.controller.openWiringDefaultsManager();
  assert.equal(view.controller.wiringDefaultsSession, original); assert.equal(view.get('btn-close-wiring-defaults').disabled, true); assert.equal(view.get('wiring-defaults-scope').disabled, true);
  assert.equal(view.requests.filter(request => request.url.endsWith('/apply')).length, 1); pending.resolve({ applied: true }); await applying;
  assert.equal(view.controller.wiringDefaultsSession, null); assert.deepEqual(view.events, ['refresh']);
});

test('default wiring UI: refresh failure after commit states restoration completed and never sends a second apply', async () => {
  const view = scene(); view.controller.fetchModulesData = async () => { throw new Error('暂时离线'); };
  await view.controller.openWiringDefaultsManager(); accept(view); await view.controller.applyWiringDefaultsReview();
  assert.match(view.toasts.at(-1)[0], /已恢复，但画布刷新失败.*暂时离线/); assert.equal(view.controller.wiringDefaultsSession, null);
  assert.equal(view.requests.filter(request => request.url.endsWith('/apply')).length, 1);
});

test('module view refresh: actual network and non-OK failures return a failed result without throwing to existing callers', async () => {
  for (const failure of ['network', 'http']) {
    const view = scene(request => {
      if (request.url !== '/manage/api/programs') return;
      if (failure === 'network') throw new Error('network unavailable');
      return reply({ error: { message: 'server unavailable' } }, false);
    });
    const result = await view.realFetchModulesData(); assert.equal(result.refreshed, false);
    assert.match(result.error.message, /unavailable/);
  }
  const view = scene(request => request.url === '/manage/api/programs' ? { programs: [], groups: [], startupPlan: { members: [] } } : undefined);
  view.controller.render = () => {}; const result = await view.realFetchModulesData(); assert.equal(result.refreshed, true);
});

test('default wiring UI: actual failed list fetch after commit reports completion and not restoration failure', async () => {
  for (const failure of ['network', 'http']) {
    const view = scene(request => {
      if (request.url !== '/manage/api/programs') return;
      if (failure === 'network') throw new Error('network unavailable');
      return reply({ error: { message: 'server unavailable' } }, false);
    });
    view.controller.fetchModulesData = view.realFetchModulesData;
    await view.controller.openWiringDefaultsManager(); accept(view); await view.controller.applyWiringDefaultsReview();
    assert.match(view.toasts.at(-1)[0], /已恢复，但画布刷新失败.*unavailable/); assert.doesNotMatch(view.toasts.at(-1)[0], /恢复默认接线失败/);
    assert.equal(view.controller.wiringDefaultsSession, null);
  }
});

test('uninstall UI: actual failed list fetch after module or group removal reports committed removal', async () => {
  for (const kind of ['module', 'group-only']) {
    const view = scene(request => request.url === '/manage/api/programs' ? reply({ error: { message: 'server unavailable' } }, false)
      : request.url.endsWith('/remove') ? { removed: true } : undefined);
    view.controller.fetchModulesData = view.realFetchModulesData;
    if (kind === 'module') {
      view.controller.ensureUninstallModal();
      view.controller.uninstallSession = { kind: 'modules', targetId: 'one', busy: false, loading: false,
        review: { reviewId: 'remove-one', expiresAt: new Date(Date.now() + 600000).toISOString(), review: { programIds: ['one'], requiresStop: [], groupsChanged: [], blockers: [] } } };
      view.get('uninstall-ack').checked = true; await view.controller.applyUninstallReview();
      assert.match(view.toasts.at(-1)[0], /卸载已完成，但列表刷新失败.*server unavailable/);
    } else {
      await view.controller.removeModuleGroupOnly('group-one', 'revision');
      assert.match(view.toasts.at(-1)[0], /分组已删除，模块保留；列表刷新失败.*server unavailable/);
    }
  }
});

test('default wiring UI: new static and dynamic copy has English translations while author data stays original', async () => {
  const view = scene(); view.context.window.hubCanvas.translate = (key, params = {}) => (english[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? String(params[name]) : token);
  await view.controller.openWiringDefaultsManager(); assert.equal(view.get('wiring-defaults-title').textContent, 'Restore default wiring');
  assert.match(view.get('wiring-defaults-review').textContent, /Author source: example\.one @ 1\.0\.0/);
  assert.match(view.get('wiring-defaults-review').textContent, /custom\/events.*author\/events/);
  assert.equal(english['↺ 恢复默认接线'], '↺ Restore default wiring'); assert.match(consoleHtml, /#bottom-exec-controls.*#wiring-defaults-modal/);
});
