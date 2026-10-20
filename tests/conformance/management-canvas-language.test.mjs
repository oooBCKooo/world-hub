// These tests execute production UI handlers with a small DOM model, not a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createI18n, LANGUAGE_STORAGE_KEY } from '../../src/ui/language.mjs';
import english from '../../src/management/canvas-i18n.mjs';

const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
const walk = node => [node, ...node.children.flatMap(walk)];
const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.attributes = {}; this.style = {}; this.dataset = {};
    this.listeners = new Map(); this.value = ''; this.checked = false; this._text = ''; this.classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name), toggle: (name, force) => { const on = force ?? !this.classes.has(name); on ? this.classes.add(name) : this.classes.delete(name); return on; } };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...children); }
  add(option) { this.append(option); if (this.children.length === 1) this.value = option.value; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'class') this.className = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector === '*') return true;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) return attr[2] === undefined ? Object.hasOwn(this.attributes, attr[1]) : this.getAttribute(attr[1]) === attr[2];
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return this.children.flatMap(walk).filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) {
    value = String(value).replace(/<!--[\s\S]*?-->/g, '');
    this.replaceChildren(); const stack = [this]; let offset = 0;
    for (const match of String(value).matchAll(/<\/?([a-z][\w:-]*)\b([^>]*)>/gi)) {
      stack.at(-1)._text += decode(String(value).slice(offset, match.index));
      offset = match.index + match[0].length;
      if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      const node = new Element(match[1]);
      for (const attribute of match[2].matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) {
        const key = attribute[1], content = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
        node.setAttribute(key, content); if (key === 'id') node.id = content; if (key === 'value') node.value = content;
      }
      stack.at(-1).append(node);
      if (!['INPUT', 'IMG', 'BR', 'HR', 'META', 'LINK'].includes(node.tagName) && !match[0].endsWith('/>')) stack.push(node);
    }
    stack.at(-1)._text += decode(String(value).slice(offset));
  }
}

function scene(language = 'en') {
  const body = new Element('body'), requests = [], values = new Map([[LANGUAGE_STORAGE_KEY, language]]);
  const environment = new EventTarget();
  Object.assign(environment, { CustomEvent, navigator: { languages: ['zh-CN'] }, location: { href: 'http://localhost/manage' },
    document: { documentElement: { lang: 'zh-CN' } }, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  const i18n = createI18n(english, { environment });
  const get = id => walk(body).find(node => node.id === id) ?? null;
  const add = (id, parent = body, tag = 'div') => { const node = new Element(tag); node.id = id; parent.append(node); return node; };
  const document = { body, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), getElementById: get,
    querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  const context = vm.createContext({ document, console, structuredClone,
    localStorage: { getItem: () => '0' }, setTimeout: () => 0, clearTimeout() {},
    Option: function(text, value, defaultSelected, selected) { const option = new Element('option'); option.textContent = text; option.value = value; option.defaultSelected = defaultSelected; option.selected = selected; return option; },
    fetch: async (...args) => { requests.push(args); throw new Error('Language updates must not make a request'); },
    window: { hubCanvas: { translate: i18n.t, applyLabels: root => i18n.apply(root), get language() { return i18n.language; }, state: { data: { csrfToken: 'test' } } } } });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController')
    + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;
  // Unrelated graph/layout rendering is exercised elsewhere. Keep the production
  // language traversal and text/attribute bindings under test here.
  controller.updateGroupActionButtons = () => {}; controller.updateModeUI = () => {}; controller.render = () => {};
  i18n.onChange(() => controller.renderLanguage());
  return { controller, body, get, add, i18n, requests, context };
}

test('canvas language: English version modal buttons, strategy labels and options render in English initially', () => {
  const view = scene(); view.controller.ensureVersionModal();
  assert.equal(view.get('version-manager-title').textContent, english['模块版本管理']);
  assert.equal(view.get('btn-version-apply').textContent, english['🚀 确认应用已审阅的版本']);
  assert.equal(view.get('btn-version-preview').textContent, english['🔍 审阅版本变更 (Preview & Pre-Flight) ➔']);
  assert.equal(/[\u3400-\u9fff]/.test(view.get('module-version-modal').textContent), false, 'all built-in version modal copy is translated');
  for (const id of ['version-configuration-policy', 'version-data-policy', 'version-rollback-data']) {
    assert.equal(view.get(id).children.length, 2);
    assert.equal(/[\u3400-\u9fff]/.test(view.get(id).textContent), false, `${id} options`);
  }
  assert.equal(/[\u3400-\u9fff]/.test(view.get('version-source-path').getAttribute('placeholder')), false);
  assert.deepEqual(view.requests, []);
});

test('canvas language: switching preserves open version form, strategies, review, acknowledgement, and active tab', () => {
  const view = scene(); view.controller.ensureVersionModal();
  const modal = view.get('module-version-modal'); modal.classList.remove('hidden');
  const session = { kind: 'modules', targetId: '实例中文', epoch: 12, busy: false, review: { reviewId: 'review-id', fingerprint: 'untouched' } };
  view.controller.versionSession = session;
  view.get('version-source-path').value = 'F:\\下载\\用户修改的制品.zip';
  view.get('version-configuration-policy').value = 'author'; view.get('version-data-policy').value = 'fresh';
  view.get('version-rollback-data').value = 'restore'; view.get('version-establish-origin').checked = true; view.get('version-data-ack').checked = true;
  view.controller.switchVersionModalTab('review');
  const input = view.get('version-source-path'), ack = view.get('version-data-ack'), review = session.review;
  view.i18n.setLanguage('zh-CN');
  assert.equal(view.get('version-manager-title').textContent, '模块版本管理');
  assert.equal(view.get('btn-version-community').textContent, '🌐 前往工坊下载...');
  assert.match(view.get('version-configuration-policy').textContent, /保留当前参数/);
  view.i18n.setLanguage('en');
  assert.equal(view.get('version-manager-title').textContent, english['模块版本管理']);
  assert.equal(view.get('btn-version-community').textContent, english['🌐 前往工坊下载...']);
  assert.equal(view.get('version-source-path'), input); assert.equal(view.get('version-data-ack'), ack);
  assert.equal(input.value, 'F:\\下载\\用户修改的制品.zip');
  assert.equal(view.get('version-configuration-policy').value, 'author'); assert.equal(view.get('version-data-policy').value, 'fresh');
  assert.equal(view.get('version-rollback-data').value, 'restore'); assert.equal(view.get('version-establish-origin').checked, true);
  assert.equal(ack.checked, true); assert.equal(view.controller.versionSession, session); assert.equal(session.review, review);
  assert.equal(session.review.reviewId, 'review-id'); assert.equal(modal.classList.contains('hidden'), false);
  assert.equal(view.get('panel-vm-review').classList.contains('hidden'), false); assert.equal(view.get('tab-vm-review').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(view.requests, []);
});

test('canvas language: uninstall and execution policy labels switch without replacing unsaved controls', () => {
  const view = scene(); view.controller.ensureUninstallModal();
  const inspector = view.add('inspector-drawer'); view.add('ins-execution-policy', inspector); view.add('ins-plan-mode-note', inspector);
  const program = { programId: 'worker中文', executionPolicyRevision: 'policy-1', executionPolicy: { mode: 'on-demand', idleTimeoutMs: 60000, allowedCallers: ['caller中文'] } };
  view.controller.data.programs = [program, { programId: 'caller中文', title: '用户中文标题' }];
  view.controller.renderExecutionPolicy(program);
  assert.equal(view.get('uninstall-manager-title').textContent, english['审阅卸载']);
  assert.equal(view.get('btn-ins-save-execution-policy').textContent, english['保存运行策略']);
  assert.equal(/[\u3400-\u9fff]/.test(view.get('ins-execution-mode').textContent), false);
  const input = view.get('ins-execution-idle-seconds'), mode = view.get('ins-execution-mode'), caller = view.controller.executionCallerInputs[0];
  input.value = '125'; mode.value = 'resident'; caller.checked = false;
  view.get('uninstall-ack').checked = true; view.get('uninstall-stop-owned').checked = false;
  view.i18n.setLanguage('zh-CN'); assert.equal(view.get('btn-ins-save-execution-policy').textContent, '保存运行策略');
  view.i18n.setLanguage('en'); assert.equal(view.get('btn-ins-save-execution-policy').textContent, english['保存运行策略']);
  assert.equal(view.get('ins-execution-idle-seconds'), input); assert.equal(input.value, '125'); assert.equal(mode.value, 'resident'); assert.equal(caller.checked, false);
  assert.equal(view.get('uninstall-ack').checked, true); assert.equal(view.get('uninstall-stop-owned').checked, false);
  assert.match(view.get('ins-execution-callers').textContent, /用户中文标题 · caller中文/);
  assert.deepEqual(view.requests, []);
});

test('canvas language: review JSON, identifiers and user data remain unchanged while captions switch', () => {
  const view = scene(); view.controller.ensureVersionModal();
  const review = { action: 'update', before: { id: '模块中文', version: '1.0.0' }, after: { id: '模块中文', version: '2.0.0' }, dataPolicy: 'preserve', configurationPolicy: 'preserve', programs: [
    { programId: '用户实例', before: { id: '模块中文', version: '1.0.0' }, after: { id: '模块中文', version: '2.0.0' },
      settings: { prompt: '保留当前实例数据' }, topics: { 输入: '用户/主题' }, bridges: {}, bindings: [], manifest: { permissions: {} } },
  ] };
  view.controller.renderVersionReview(review);
  const raw = view.get('version-review').querySelector('pre'), original = raw.textContent;
  assert.equal(original, JSON.stringify(review, null, 2));
  assert.ok(view.get('version-review').textContent.includes(english['目标版本：']));
  view.i18n.setLanguage('zh-CN');
  assert.match(view.get('version-review').textContent, /目标版本：/);
  assert.equal(raw.textContent, original);
  view.i18n.setLanguage('en');
  assert.ok(view.get('version-review').textContent.includes(english['目标版本：']));
  assert.equal(raw.textContent, original); assert.equal(view.get('version-review').querySelector('pre'), raw);
  assert.match(view.get('version-review').textContent, /用户实例/); assert.match(view.get('version-review').textContent, /用户\/主题/);
  assert.match(view.get('version-review').textContent, /保留当前实例数据/);
  assert.deepEqual(view.requests, []);
});

test('canvas language: publisher bilingual titles prefer English and preserve custom plain titles', () => {
  const view = scene(), inspector = view.add('inspector-drawer'); view.add('ins-execution-policy', inspector);
  const worker = { programId: 'worker', executionPolicy: { mode: 'resident' } };
  view.controller.data.programs = [worker, { programId: 'bilingual', title: { zh: '发布者中文名称', en: 'Publisher English title' } }, { programId: 'custom', title: '用户自定义中文' }];
  view.controller.renderExecutionPolicy(worker);
  assert.match(view.get('ins-execution-callers').textContent, /Publisher English title/);
  assert.doesNotMatch(view.get('ins-execution-callers').textContent, /发布者中文名称/);
  assert.match(view.get('ins-execution-callers').textContent, /用户自定义中文/);
  view.i18n.setLanguage('zh-CN');
  assert.match(view.get('ins-execution-callers').textContent, /发布者中文名称/);
  assert.match(view.get('ins-execution-callers').textContent, /用户自定义中文/);
});

test('canvas language: its scoped traversal never overwrites independent workbench text or Chinese raw frames', () => {
  const view = scene();
  const dialog = view.add('manual-console'), label = view.add('manual-owned-label', dialog);
  label.setAttribute('data-i18n', '手动通讯工作台'); label.textContent = 'Manual communication workbench';
  const raw = view.add('manual-owned-wire-frame', dialog, 'pre'); raw.textContent = '{"type":"delivery","body":{"text":"用户原始中文"}}';
  const original = raw.textContent;
  view.controller.ensureVersionModal();
  view.i18n.setLanguage('zh-CN'); view.i18n.setLanguage('en');
  assert.equal(label.textContent, 'Manual communication workbench');
  assert.equal(raw.textContent, original); assert.deepEqual(view.requests, []);
});

test('canvas language: injected dialogs translate in both directions without rebuilding pending form controls', () => {
  const view = scene(); view.controller.injectModals();
  for (const id of ['modal-module-workshop', 'wiring-matrix-modal', 'modal-workshop-lightbox', 'modal-module-package', 'import-module-modal']) {
    assert.doesNotMatch(view.get(id).textContent, /[\u3400-\u9fff]/, `${id} built-in English labels`);
  }
  const source = view.get('inp-workshop-source-url'), search = view.get('inp-ws-search');
  source.value = 'F:\\我的来源\\index.json'; search.value = '我的模块';
  view.i18n.setLanguage('zh-CN');
  assert.match(view.get('modal-module-workshop').textContent, /本地缓存总计/);
  view.i18n.setLanguage('en');
  assert.doesNotMatch(view.get('modal-module-workshop').textContent, /[\u3400-\u9fff]/);
  assert.equal(view.get('inp-workshop-source-url'), source); assert.equal(source.value, 'F:\\我的来源\\index.json');
  assert.equal(view.get('inp-ws-search'), search); assert.equal(search.value, '我的模块');
  assert.deepEqual(view.requests, []);
});

test('canvas language: open Workshop catalog, details, version selection and cache labels refresh in place', () => {
  const view = scene(); view.controller.injectModals();
  const entry = { kind: 'module', id: 'third.party', version: '2.0.0', entryId: 'release-2', title: '用户自定义标题',
    description: { zh: '发布者描述中文', en: 'Publisher English description' } };
  const versions = [entry, { ...entry, version: '1.0.0', entryId: 'release-1' }];
  view.controller.workshopEntries = versions; view.controller.workshopVersionSelections = new Map();
  view.controller.renderWorkshopCards(); view.controller.openWorkshopDetailModal(entry, versions);
  view.controller.cachedArtifacts = [{ id: 'third.party', title: '用户自定义标题', kind: 'module', version: '2.0.0', directory: 'F:\\用户缓存' }];
  view.controller.renderWorkshopCacheList();
  const card = view.get('workshop-entries-box').children[0], version = view.get('ws-detail-version-select'), cacheCard = view.get('workshop-cached-entries-box').children[0];
  version.value = 'release-1';
  assert.match(view.get('ws-detail-body').textContent, /Publisher English description/);
  view.i18n.setLanguage('zh-CN');
  assert.match(view.get('ws-detail-body').textContent, /发布者描述中文/);
  view.i18n.setLanguage('en');
  assert.equal(view.get('workshop-entries-box').children[0], card); assert.equal(view.get('ws-detail-version-select'), version);
  assert.equal(version.value, 'release-1'); assert.equal(view.get('workshop-cached-entries-box').children[0], cacheCard);
  for (const id of ['workshop-entries-box', 'ws-detail-body', 'workshop-cached-entries-box']) {
    assert.doesNotMatch(view.get(id).textContent.replaceAll('用户自定义标题', ''), /[\u3400-\u9fff]/, id);
  }
  assert.deepEqual(view.requests, []);
});

test('canvas language: environment diagnostic fallbacks update when no runtime was detected', async () => {
  const view = scene('zh-CN'); view.controller.injectModals();
  view.context.fetch = async () => ({ ok: true, json: async () => ({ environment: { node: { available: false }, python: { available: false } }, candidates: {} }) });
  await view.controller.probeEnvironment();
  assert.match(view.get('env-detect-cards').textContent, /未知/);
  const cards = view.get('env-detect-cards').children.slice();
  view.i18n.setLanguage('en');
  assert.doesNotMatch(view.get('env-detect-cards').textContent, /[\u3400-\u9fff]/);
  assert.equal(view.get('env-detect-cards').children[0], cards[0]);
});

test('author execution defaults UI: scaffold sends only mode and timeout and preserves the draft during language changes', async () => {
  const view = scene(); view.controller.injectModals();
  view.get('inp-scaffold-id').value = 'author-example';
  view.get('sel-scaffold-execution-mode').value = 'on-demand'; view.get('inp-scaffold-idle-seconds').value = '90';
  view.get('inp-scaffold-dir').value = 'F:\\开发者模块';
  view.i18n.setLanguage('zh-CN'); view.i18n.setLanguage('en');
  assert.equal(view.get('sel-scaffold-execution-mode').value, 'on-demand'); assert.equal(view.get('inp-scaffold-idle-seconds').value, '90');
  assert.doesNotMatch(view.get('modal-module-scaffold').textContent, /[\u3400-\u9fff]/);
  const submitted = [];
  view.context.fetch = async (url, request) => { submitted.push({ url, body: JSON.parse(request.body) }); return { ok: false, json: async () => ({ message: 'test response' }) }; };
  await view.controller.doScaffoldModule();
  assert.equal(submitted.length, 1); assert.equal(submitted[0].url, '/manage/api/creator/scaffold');
  assert.deepEqual(submitted[0].body.executionDefaults, { mode: 'on-demand', idleTimeoutMs: 90000 });
  assert.equal(submitted[0].body.directory, 'F:\\开发者模块');
  submitted.length = 0; view.get('inp-scaffold-idle-seconds').value = '0';
  await view.controller.doScaffoldModule(); assert.equal(submitted.length, 0);
});

test('author execution defaults UI: version reviews disclose author defaults for additions and retained local caller permissions', () => {
  const view = scene(); view.controller.ensureVersionModal();
  const review = { action: 'update', before: { id: 'group', version: '1.0.0' }, after: { id: 'group', version: '2.0.0' }, dataPolicy: 'preserve', programs: [
    { programId: 'existing', before: { id: 'module', version: '1.0.0' }, after: { id: 'module', version: '2.0.0' },
      executionPolicy: { mode: 'resident', idleTimeoutMs: 3000, allowedCallers: ['用户调用者'] }, executionPolicySource: 'local' },
    { programId: 'added', before: null, after: { id: 'new', version: '1.0.0' },
      executionPolicy: { mode: 'on-demand', idleTimeoutMs: 12000, allowedCallers: [] }, executionPolicySource: 'module-group' }
  ] };
  view.controller.renderVersionReview(review);
  const text = view.get('version-review').textContent;
  assert.match(text, /Current local policy retained/); assert.match(text, /Module group author defaults/);
  assert.match(text, /On demand/i); assert.match(text, /12 seconds/); assert.match(text, /用户调用者/);
  view.i18n.setLanguage('zh-CN'); assert.match(view.get('version-review').textContent, /模块组作者默认/);
  assert.match(view.get('version-review').textContent, /保留本机策略/);
  assert.deepEqual(view.requests, []);
});

test('canvas language: selectGroup renders bilingual metadata and status while keeping member controls intact on switches', () => {
  const view = scene(), inspector = view.add('inspector-drawer');
  const groupContent = view.add('ins-group-content', inspector);
  for (const id of ['ins-title', 'ins-key', 'ins-grp-name', 'ins-grp-desc', 'ins-grp-status', 'ins-grp-meta', 'ins-grp-members-list', 'ins-grp-members-count']) view.add(id, groupContent);
  const group = { id: '组中文', title: { zh: '模块组中文标题', en: 'Publisher group title' }, description: { zh: '模块组中文描述', en: 'Publisher group description' },
    memberProgramIds: ['running', 'stopped', 'failed'] };
  view.controller.data.groups = [group];
  view.controller.data.programs = [{ programId: 'running', state: 'running', title: '用户中文模块' },
    { programId: 'stopped', state: 'stopped', title: { zh: '发布者成员中文名称', en: 'Publisher member title' } }, { programId: 'failed', state: 'failed' }];
  view.context.window.hubCanvas.openInspector = () => {};
  view.controller.selectGroup(group.id);
  assert.equal(view.get('ins-title').textContent, 'Publisher group title');
  assert.equal(view.get('ins-grp-name').textContent, 'Publisher group title');
  assert.equal(view.get('ins-grp-desc').textContent, 'Publisher group description');
  assert.equal(/[\u3400-\u9fff]/.test(view.get('ins-grp-status').textContent), false);
  assert.match(view.get('ins-key').textContent, /组中文/);
  const list = view.get('ins-grp-members-list'), memberCard = list.children[0], button = memberCard.querySelector('[data-btn-inspect]');
  assert.match(list.textContent, /Publisher member title/);
  const input = view.add('unsaved-member-control', memberCard, 'input'); input.value = '用户未保存中文参数';
  view.i18n.setLanguage('zh-CN');
  assert.equal(view.get('ins-title').textContent, '模块组中文标题'); assert.equal(view.get('ins-grp-name').textContent, '模块组中文标题');
  assert.equal(view.get('ins-grp-desc').textContent, '模块组中文描述'); assert.match(view.get('ins-grp-status').textContent, /1 运行中 · 1 已停止 · 1 异常/);
  assert.match(list.textContent, /发布者成员中文名称/);
  view.i18n.setLanguage('en');
  assert.equal(view.get('ins-title').textContent, 'Publisher group title'); assert.equal(view.get('ins-grp-desc').textContent, 'Publisher group description');
  assert.equal(list.children[0], memberCard); assert.equal(memberCard.querySelector('[data-btn-inspect]'), button);
  assert.equal(view.get('unsaved-member-control'), input); assert.equal(input.value, '用户未保存中文参数');
  assert.match(memberCard.textContent, /用户中文模块/); assert.equal(view.controller.selectedGroupId, '组中文');
  assert.match(list.textContent, /Publisher member title/);
  assert.deepEqual(view.requests, []);
});

test('canvas language: dynamic notifications retain a recomputable factory and legacy toast receives a string', () => {
  const view = scene(), notifications = [], legacy = [];
  const hub = view.context.window.hubCanvas;
  hub.notify = (...args) => notifications.push(args); hub.toast = (...args) => legacy.push(args);
  view.context.rawModuleId = '用户模块中文';
  vm.runInContext("canvasToast(() => t('已移除启动依赖: {from} → {to}', { from: rawModuleId, to: 'target' }), 'error', false)", view.context);
  assert.equal(notifications.length, 1); assert.equal(typeof notifications[0][0], 'function');
  const [factory, kind, autoClear] = notifications[0];
  assert.equal(kind, 'error'); assert.equal(autoClear, false); assert.equal(legacy.length, 0);
  assert.equal(factory(), view.i18n.t('已移除启动依赖: {from} → {to}', { from: '用户模块中文', to: 'target' }));
  assert.match(factory(), /用户模块中文/);
  view.i18n.setLanguage('zh-CN'); assert.equal(factory(), '已移除启动依赖: 用户模块中文 → target');
  view.i18n.setLanguage('en'); assert.doesNotMatch(factory(), /已移除启动依赖/); assert.match(factory(), /用户模块中文/);
  delete hub.notify;
  vm.runInContext("canvasToast(() => t('已移除启动依赖: {from} → {to}', { from: rawModuleId, to: 'target' }), 'neutral')", view.context);
  assert.equal(legacy.length, 1); assert.equal(typeof legacy[0][0], 'string'); assert.match(legacy[0][0], /用户模块中文/);
  assert.deepEqual(view.requests, []);
});

test('canvas language: template-owned placeholder and accessibility labels switch while input values stay untouched', () => {
  const view = scene(), panel = view.add('import-module-modal');
  view.context.bindingTestPanel = panel;
  vm.runInContext("setCanvasHtml(bindingTestPanel, () => `<input id=\"binding-test-input\" value=\"用户中文参数\" ${canvasAttribute('placeholder', () => t('默认使用系统 PATH'))} ${canvasAttribute('aria-label', () => t('模块组范围筛选'))} ${canvasAttribute('title', () => t('选择本地目录或制品文件 (自动适应)'))} >`)", view.context);
  const input = view.get('binding-test-input');
  assert.equal(input.value, '用户中文参数'); assert.equal(input.getAttribute('placeholder'), english['默认使用系统 PATH']);
  input.value = '用户正在输入的未保存内容';
  view.i18n.setLanguage('zh-CN');
  assert.equal(input.getAttribute('placeholder'), '默认使用系统 PATH'); assert.equal(input.getAttribute('aria-label'), '模块组范围筛选');
  assert.equal(input.getAttribute('title'), '选择本地目录或制品文件 (自动适应)');
  view.i18n.setLanguage('en');
  assert.equal(view.get('binding-test-input'), input); assert.equal(input.value, '用户正在输入的未保存内容');
  assert.equal(input.getAttribute('aria-label'), english['模块组范围筛选']); assert.equal(input.getAttribute('placeholder'), english['默认使用系统 PATH']);
  assert.deepEqual(view.requests, []);
});
