import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import english from '../../src/management/canvas-i18n.mjs';

const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
const walk = node => [node, ...node.children.flatMap(walk)];
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = (value, ok = true) => ({ ok, json: async () => structuredClone(value) });
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.htmlWrites = 0;
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
      toggle: (value, enabled) => { const on = enabled ?? !classes.has(value); on ? classes.add(value) : classes.delete(value); } };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(value) { this.htmlWrites++; this.textContent = value; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type) { return this.listeners.get(type)?.({ target: this, stopPropagation() {} }); }
  querySelector(selector) { return walk(this).find(node => (node.attributes.class || '').split(' ').includes(selector.slice(1))); }
}
const row = (id = 'worker', extra = {}) => ({ programId: id, title: id, module: { id: `example.${id}`, version: '1.0.0' }, state: 'stopped',
  executionPolicy: { mode: 'resident', idleTimeoutMs: 60000, allowedCallers: [] }, executionPolicyRevision: `execution-${id}`, configurationRevision: `config-${id}`, ...extra });
function scene(handle) {
  const body = new Element('body'), requests = [], toasts = [];
  for (const id of ['ins-execution-policy', 'ins-plan-enabled', 'ins-plan-mode-note', 'btn-ins-save-plan-member']) { const node = new Element('div'); node.id = id; body.append(node); }
  const get = id => walk(body).find(node => node.id === id);
  const context = vm.createContext({ document: { body, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), getElementById: get,
    querySelectorAll: selector => walk(body).filter(node => (node.attributes.class || '').split(' ').includes(selector.slice(1))) },
    structuredClone, localStorage: { getItem: () => '0' }, console, setTimeout: () => 0, clearTimeout() {},
    window: { hubCanvas: { state: { data: { csrfToken: 'csrf-test' } }, toast: (...args) => toasts.push(args) } },
    fetch: async (url, init = {}) => {
      const request = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers }; requests.push(request);
      const response = await handle?.(request); if (response !== undefined) return response?.json ? response : reply(response);
      if (url.endsWith('/execution-policy')) return reply({ program: row('worker', { executionPolicy: request.body.policy, executionPolicyRevision: 'execution-next' }), startsModules: false, stopsModules: false });
      if (url.endsWith('/execution/status')) return reply({ available: true, programs: [] });
      return reply({});
    }
  });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController')
    + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;
  controller.data.programs = [row(), row('caller'), row('other')];
  controller.data.groups = [{ id: 'group', title: 'Shared group', revision: 'group-rev', memberProgramIds: ['worker', 'caller'], startupPlan: {
    format: 'world-hub.launcher-startup-plan/v1', revision: 'group-plan-rev', onFailure: 'continue-independent', startupOrder: ['caller', 'worker'],
    members: [{ programId: 'worker', enabled: false, after: ['caller'] }, { programId: 'caller', enabled: true, after: [] }] } }];
  controller.data.startupPlan = { format: 'world-hub.launcher-startup-plan/v1', revision: 'global-plan-rev', onFailure: 'continue-independent', startupOrder: ['caller', 'worker', 'other'],
    members: [{ programId: 'worker', enabled: false, after: ['caller'] }, { programId: 'caller', enabled: true, after: [] }] };
  controller.fetchModulesData = async () => ({ refreshed: true });
  controller.selectedModuleId = 'worker'; controller.renderExecutionPolicy(controller.data.programs[0]);
  return { controller, requests, toasts, get, body, context };
}

test('execution UI: independent policy handler sends exact CAS, chosen callers and idle policy without changing configuration or starting modules', async () => {
  const view = scene();
  view.get('ins-execution-mode').value = 'on-demand'; view.get('ins-execution-idle-seconds').value = '125';
  view.controller.executionCallerInputs.find(input => input.dataset.programId === 'caller').checked = true;
  await view.get('btn-ins-save-execution-policy').dispatch('click');
  assert.deepEqual(view.requests[0].body, { expectedRevision: 'execution-worker', policy: { mode: 'on-demand', idleTimeoutMs: 125000, allowedCallers: ['caller'] } });
  assert.equal(view.requests[0].headers['X-Management-Token'], 'csrf-test');
  assert.equal(view.requests.some(request => /\/(start|stop|configuration\/apply)$/.test(request.url)), false);
  assert.equal(view.controller.data.programs[0].executionPolicyRevision, 'execution-next');
  assert.match(view.get('ins-plan-mode-note').textContent, /按需模块不随编排启动/);
  assert.match(view.get('ins-execution-policy').textContent, /Shared group/);
});

test('execution UI: default caller authorization is empty and resident mode remains independent from plan enrollment', async () => {
  const view = scene();
  assert.equal(view.controller.executionCallerInputs.every(input => !input.checked), true);
  assert.equal(view.controller.executionCallerInputs.some(input => input.dataset.programId === 'worker'), false);
  assert.match(view.get('ins-execution-policy').textContent, /默认不授权任何调用者/);
  await view.controller.saveExecutionPolicy(); assert.equal(view.requests[0].body.policy.mode, 'resident');
  assert.deepEqual(view.requests[0].body.policy.allowedCallers, []);
  assert.equal(view.controller.data.startupPlan.members[0].enabled, false);
});

test('execution UI: invalid mode or noninteger and out-of-range idle values never issue a save', async () => {
  for (const value of ['', '0', '1.5', '-2', '86401', 'Infinity']) {
    const view = scene(); view.get('ins-execution-idle-seconds').value = value; await view.controller.saveExecutionPolicy();
    assert.equal(view.requests.length, 0); assert.match(view.get('ins-execution-policy-error').textContent, /1 至 86400/);
  }
  const view = scene(); view.get('ins-execution-mode').value = 'invalid'; await view.controller.saveExecutionPolicy(); assert.equal(view.requests.length, 0);
});

test('execution UI: historical missing caller stays visible and must be explicitly deselected before saving', async () => {
  const view = scene(); const prog = row('worker', { executionPolicy: { mode: 'on-demand', idleTimeoutMs: 1000, allowedCallers: ['uninstalled'] } });
  view.controller.data.programs[0] = prog; view.controller.renderExecutionPolicy(prog);
  assert.match(view.get('ins-execution-callers').textContent, /uninstalled（已卸载，请取消授权）/);
  await view.controller.saveExecutionPolicy(); assert.equal(view.requests.length, 0);
  view.controller.executionCallerInputs.find(input => input.dataset.programId === 'uninstalled').checked = false;
  await view.controller.saveExecutionPolicy(); assert.deepEqual(view.requests[0].body.policy.allowedCallers, []);
});

test('execution UI: nested save errors preserve policy data, revision and editable draft without fake success', async () => {
  const view = scene(() => reply({ error: { code: 'EXECUTION_POLICY_CHANGED', message: '运行策略已被其他窗口更改' } }, false));
  view.get('ins-execution-mode').value = 'on-demand'; await view.controller.saveExecutionPolicy();
  assert.match(view.get('ins-execution-policy-error').textContent, /其他窗口更改/);
  assert.equal(view.controller.data.programs[0].executionPolicy.mode, 'resident'); assert.equal(view.controller.data.programs[0].executionPolicyRevision, 'execution-worker');
  assert.equal(view.get('ins-execution-mode').value, 'on-demand'); assert.equal(view.toasts.length, 0); assert.equal(view.get('btn-ins-save-execution-policy').disabled, false);
});

test('execution UI: in-flight policy save prevents duplicate requests and ignores late response after switching modules', async () => {
  const pending = deferred(), view = scene(request => request.url.endsWith('/execution-policy') ? pending.promise : undefined);
  const saving = view.controller.saveExecutionPolicy(); await view.controller.saveExecutionPolicy(); assert.equal(view.requests.length, 1);
  view.controller.selectedModuleId = 'other'; view.controller.renderExecutionPolicy(view.controller.data.programs[2]);
  view.get('ins-execution-mode').value = 'on-demand'; pending.resolve({ program: row('worker', { executionPolicyRevision: 'late' }) }); await saving;
  assert.equal(view.controller.executionPolicySession.programId, 'other'); assert.equal(view.get('ins-execution-mode').value, 'on-demand');
  assert.equal(view.controller.data.programs[2].executionPolicyRevision, 'execution-other'); assert.equal(view.get('ins-execution-policy-error').textContent, '');
});

test('execution UI: committed policy with failed list refresh reports saved state and does not retry apply', async () => {
  const view = scene(); view.controller.fetchModulesData = async () => ({ refreshed: false, error: new Error('temporarily offline') });
  await view.controller.saveExecutionPolicy(); assert.match(view.get('ins-execution-policy-error').textContent, /已保存.*列表刷新失败.*temporarily offline/);
  assert.equal(view.requests.filter(request => request.url.endsWith('/execution-policy')).length, 1); assert.equal(view.get('btn-ins-save-execution-policy').disabled, false);
});

test('execution UI: status distinguishes active leases, uncertain tasks, manual pins and idle-stop waiting', async () => {
  const view = scene();
  assert.match(view.controller.executionStatusText({ activeLeaseCount: 2, uncertainLeaseCount: 1, autoStarted: true }), /进行中的调用：2.*状态未知的调用：1.*暂停自动停止/);
  assert.match(view.controller.executionStatusText({ pinned: true, autoStarted: true, idleStopAt: Date.now() }), /手动启动，保持运行/);
  assert.doesNotMatch(view.controller.executionStatusText({ pinned: true, idleStopAt: Date.now() }), /等待空闲停止/);
  assert.match(view.controller.executionStatusText({ autoStarted: true, idleStopAt: Date.now() }), /等待空闲停止/);
  await view.controller.refreshExecutionStatus(); assert.match(view.get('ins-execution-status').textContent, /暂无按需运行记录/);
});

test('execution UI: stale status responses cannot replace newer requests or another module drawer', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const view = scene(() => ++count === 1 ? first.promise : second.promise);
  const old = view.controller.refreshExecutionStatus(), fresh = view.controller.refreshExecutionStatus();
  second.resolve({ available: true, programs: [{ programId: 'worker', activeLeaseCount: 4 }] }); await fresh;
  first.resolve({ available: false }); await old; assert.match(view.get('ins-execution-status').textContent, /进行中的调用：4/);
  const pending = deferred(), changed = scene(() => pending.promise), updating = changed.controller.refreshExecutionStatus();
  changed.controller.selectedModuleId = 'other'; changed.controller.renderExecutionPolicy(changed.controller.data.programs[2]);
  pending.resolve({ available: false }); await updating; assert.match(changed.get('ins-execution-status').textContent, /正在读取/);
});

test('execution UI: global and group plan getters preserve disabled members, return clones and add missing members disabled', () => {
  const view = scene(); const before = plain(view.controller.data);
  const global = view.controller.getActivePlan(); assert.equal(global.members.find(member => member.programId === 'worker').enabled, false);
  assert.equal(global.members.find(member => member.programId === 'other').enabled, false); global.members[0].after = [];
  view.controller.groupFilter = 'group'; const group = view.controller.getActivePlan(); group.members[1].enabled = false;
  assert.deepEqual(plain(view.controller.data), before);
  delete view.controller.data.groups[0].startupPlan;
  assert.equal(view.controller.getActivePlan().members.every(member => !member.enabled), true);
});

test('execution UI: saving group enrollment retains exact startupOrder, disabled selections and plan metadata', async () => {
  const view = scene(); view.controller.groupFilter = 'group'; view.get('ins-plan-enabled').checked = true;
  await view.controller.saveSelectedPlanMembership();
  const request = view.requests[0]; assert.equal(request.url, '/manage/api/groups/save'); assert.equal(request.body.expectedRevision, 'group-rev');
  assert.deepEqual(request.body.group.startupPlan.startupOrder, ['caller', 'worker']); assert.equal(request.body.group.startupPlan.revision, 'group-plan-rev');
  assert.equal(request.body.group.startupPlan.members[0].enabled, true); assert.equal(view.controller.data.groups[0].startupPlan.members[0].enabled, false, 'data changes only after a successful refresh');
  assert.equal(view.requests.some(request => request.url.endsWith('/start')), false);
});

test('execution UI: adding a dependency never enables a module and global plan saves preserve revision and ordering', async () => {
  const view = scene(); await view.controller.connectDependency('other', 'caller');
  const request = view.requests[0]; assert.equal(request.url, '/manage/api/programs/startup-plan/save');
  assert.equal(request.body.expectedRevision, 'global-plan-rev'); assert.deepEqual(request.body.plan.startupOrder, ['caller', 'worker', 'other']);
  const other = request.body.plan.members.find(member => member.programId === 'other'); assert.equal(other.enabled, false); assert.deepEqual(other.after, ['caller']);
  assert.equal(view.controller.data.startupPlan.members.some(member => member.programId === 'other'), false);
});

test('execution UI: plan save failures expose nested errors without false dependency success', async () => {
  const view = scene(() => reply({ error: { message: '计划修订已改变' } }, false));
  await view.controller.connectDependency('other', 'caller'); assert.match(view.toasts.at(-1)[0], /计划修订已改变/);
  assert.equal(view.toasts.some(([text]) => text.includes('已添加启动依赖')), false);
  assert.equal(view.controller.data.startupPlan.members.some(member => member.programId === 'other'), false);
});

test('execution UI: on-demand modules remain visible in static, runtime and orchestration and can still be started directly', async () => {
  const view = scene(), prog = row('worker', { executionPolicy: { mode: 'on-demand', idleTimeoutMs: 60000, allowedCallers: [] } });
  assert.match(view.controller.createStaticModuleCard(prog, { x: 0, y: 0 }).textContent, /按需/);
  for (const mode of ['runtime', 'orchestration']) { view.controller.mode = mode; assert.match(view.controller.createModuleCard(prog, { x: 0, y: 0 }).textContent, /按需/); }
  view.controller.updateStartupHighlightState = () => {};
  view.controller.selectModule = () => {};
  await view.controller.startProgram(prog.programId); assert.equal(view.requests[0].url, '/manage/api/programs/worker/start');
});

test('execution UI: publisher text and errors use text nodes and English policy copy does not alter caller IDs or drafts', () => {
  const view = scene(); view.context.window.hubCanvas.translate = (key, params = {}) => (english[key] || key).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? params[name] : token);
  view.controller.data.programs[1].title = '<img src=x onerror=alert(1)>';
  view.controller.renderExecutionPolicy(view.controller.data.programs[0]);
  assert.match(view.get('ins-execution-policy').textContent, /Module execution policy/);
  assert.match(view.get('ins-execution-callers').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(walk(view.get('ins-execution-policy')).reduce((count, node) => count + node.htmlWrites, 0), 0);
  assert.equal(view.controller.executionCallerInputs[0].dataset.programId, 'caller');
  assert.match(view.controller.executionStatusText({ activeLeaseCount: 2, pinned: true }), /Active calls: 2.*Manually started/);
});

test('execution UI: a disabled wake service is normal while unavailable service preserves active and unknown task warnings', async () => {
  const view = scene(() => ({ enabled: true, available: false, lastError: { message: 'bridge disconnected' },
    programs: [{ programId: 'worker', activeLeaseCount: 2, uncertainLeaseCount: 1 }] }));
  await view.controller.refreshExecutionStatus();
  assert.match(view.get('ins-execution-status').textContent, /服务当前不可用.*进行中的调用：2.*状态未知的调用：1.*暂停自动停止.*bridge disconnected/);
  assert.match(view.controller.executionServiceStatus({ enabled: false, available: false }, 'worker'), /未启用；常驻模块按计划运行/);
  assert.doesNotMatch(view.controller.executionServiceStatus({ enabled: false, available: false }, 'worker'), /不可用/);
  assert.match(view.get('ins-execution-policy').textContent, /首次启用按需唤醒后.*已在运行的调用者需要重启/);
});

test('execution UI: group startup keeps actual result states and reports demand and unselected modules as skipped', async () => {
  const view = scene(() => ({ results: [{ programId: 'caller', state: 'already-running', ok: true }],
    skipped: [{ programId: 'worker', reason: 'on-demand' }, { programId: 'other', reason: 'not-selected' }] }));
  await view.controller.startGroupById('group');
  assert.match(view.toasts.at(-1)[0], /已启动或保持运行 1 个，按需跳过 1 个，未选中 1 个/);
  assert.equal(view.toasts.at(-1)[1], 'neutral'); assert.doesNotMatch(view.toasts.at(-1)[0], /全部上线/);
});

test('execution UI: an on-demand or unselected card is never highlighted as waiting for a resident startup plan', () => {
  const view = scene(); view.controller.mode = 'orchestration';
  view.controller.data.programs[0].executionPolicy.mode = 'on-demand';
  const demand = view.controller.createModuleCard(view.controller.data.programs[0], { x: 0, y: 0 });
  const unselected = view.controller.createModuleCard(view.controller.data.programs[2], { x: 1, y: 1 });
  view.body.append(demand, unselected); view.controller.updateStartupHighlightState({ startingProgramId: 'caller', results: [] });
  assert.equal(demand.classList.contains('is-pending'), false); assert.equal(unselected.classList.contains('is-pending'), false);
  assert.match(demand.querySelector('.cmn-stage-desc').textContent, /不随计划启动/);
  assert.match(unselected.querySelector('.cmn-stage-desc').textContent, /未加入常驻启动计划/);
});
