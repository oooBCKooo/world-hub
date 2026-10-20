import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const counterPath = 'F:\\downloads\\counter.zip';
const desktopPath = 'F:\\cache\\desktop';
const provider = { moduleId: 'example.soft-ui-desktop', version: '0.3.0' };
const contract = { id: 'soft-ui.windows', version: '1.0.0' };
const sourceUrl = 'https://example.test/workshop/index.json';
const sourceDigest = 'f'.repeat(64);
const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');

// Only the DOM surface used by the real import and Workshop handlers is modeled.
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.style = {}; this.attributes = {};
    this.value = ''; this._text = ''; this.className = ''; this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
      toggle: (value, enabled) => { if (enabled ?? !classes.has(value)) classes.add(value); else classes.delete(value); }
    };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  prepend(...children) { for (const child of children.reverse()) { child.parent = this; this.children.unshift(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  closest(selector) { if (selector === '.hub-modal-body') return this.modalBody ?? this.parent?.closest(selector); return null; }
  add(option) { this.append(option); if (this.children.length === 1) this.value = option.value; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  setAttribute(key, value) { this.attributes[key] = value; }
  set textContent(text) { this.replaceChildren(); this._text = String(text); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(text) { this.replaceChildren(); this._text = String(text); }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const outsideDetails = node => node.tag === 'details' ? '' : node._text + node.children.map(outsideDetails).join('');
const click = { stopPropagation() {} };
function review(moduleId = 'example.soft-ui-counter', version = '0.3.1') {
  return { module: { id: moduleId, version }, manifest: { id: moduleId, runtime: { kind: 'node' }, permissions: {} },
    topics: { commands: 'chosen/desktop/commands', events: 'chosen/desktop/events' },
    bridges: { main: { publish: ['commands'], subscribe: ['events'] } }, settings: {}, bindings: [] };
}
function resolution(status, extra = {}) {
  return { id: 'desktop', provider, contracts: [contract], topics: { commands: 'commands', events: 'events' }, status, ...extra };
}
const missing = () => ({ kind: 'module', selectionRequired: true, requiredProviders: [], defaultConnections: [resolution('missing', { candidates: [] })] });
function ready() {
  return { kind: 'module', reviewId: 'counter-review', review: { ...review(),
    bindings: [{ providerId: 'desktop-one', contract }],
    defaultConnections: [resolution('resolved', { providerId: 'desktop-one' })] } };
}
const entry = (id, version, kind = 'module') => ({ kind, id, version, entryId: `${kind}.${id}.${version}`,
  title: id, license: 'MIT', platforms: ['win32-x64'], provides: [contract], sha256: 'a'.repeat(64) });

async function scene(preview, { apply = () => ({ ok: true }) } = {}) {
  const body = new Element('body'), modalBody = new Element('section'); modalBody.className = 'hub-modal-body'; body.append(modalBody);
  const elements = {};
  for (const id of ['inp-import-path', 'btn-confirm-import', 'import-preview-box', 'import-prev-title', 'import-prev-runtime', 'import-prev-desc',
    'import-module-modal', 'import-known-paths', 'modal-module-workshop', 'modal-workshop-detail', 'modal-workshop-lightbox',
    'inp-ws-search', 'sel-ws-type', 'sel-ws-contract', 'sel-ws-sort', 'inp-workshop-private-network', 'inp-workshop-source-url',
    'workshop-entries-box', 'ws-results-counter', 'btn-ws-search-clear', 'btn-ws-reset-filters']) {
    const element = new Element(id.startsWith('inp-') ? 'input' : 'div'); element.id = id; elements[id] = element; modalBody.append(element);
  }
  elements['inp-import-path'].value = counterPath;
  elements['inp-import-path'].modalBody = modalBody;
  elements['sel-ws-type'].value = 'all'; elements['sel-ws-contract'].value = 'all'; elements['sel-ws-sort'].value = 'default';
  elements['inp-workshop-source-url'].value = sourceUrl;
  const requests = [], toasts = [], events = [];
  let previewCount = 0;
  const context = vm.createContext({
    document: { getElementById: id => walk(body).find(element => element.id === id), createElement: tag => new Element(tag) },
    Option: function(text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    window: { hubCanvas: { state: { data: { csrfToken: 'test-only' } }, toast: (...args) => toasts.push(args) } },
    localStorage: { getItem: () => '0' }, console,
    fetch: async (url, init = {}) => {
      const request = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined }; requests.push(request);
      let result;
      if (url === '/manage/api/artifacts/preview') result = await preview(request.body, ++previewCount);
      else if (url === '/manage/api/artifacts/apply') result = await apply(request.body);
      else if (url === '/manage/api/workshop/fetch') result = { directory: desktopPath };
      else if (url === '/manage/api/paths/known') result = { objects: [] };
      else if (url === '/manage/api/workshop/sources') result = { sources: [] };
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => structuredClone(result) };
    }
  });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController')
    + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;
  controller.fetchModulesData = async () => { events.push('refresh'); };
  controller.autoLayout = () => { events.push('layout'); };
  controller.workshopData = { source: sourceUrl, digest: sourceDigest };
  controller.workshopEntries = [entry(provider.moduleId, '0.4.0'), entry(provider.moduleId, provider.version),
    entry('unrelated.desktop', provider.version), entry(provider.moduleId, provider.version, 'module-group')];
  controller.data.programs = [{ programId: 'desktop-one', module: { id: provider.moduleId, version: provider.version } }];
  return { controller, elements, requests, toasts, events, body, find: id => walk(body).find(element => element.id === id) };
}

test('default connections UI: missing provider identifies its exact module version and offers discovery', async () => {
  const view = await scene(missing);
  await view.controller.inspectImportModule();
  const panel = view.find('import-provider-selection');
  assert.match(panel.textContent, /example\.soft-ui-desktop @ 0\.3\.0/);
  assert.match(panel.textContent, /已下载但未导入的模块还不能接线/);
  assert.equal(walk(panel).filter(node => node.tag === 'button' && node.textContent === '查找所需模块').length, 1);
  assert.equal(view.elements['btn-confirm-import'].disabled, true);
  assert.equal(view.controller.currentImportReview, null);
});

test('default connections UI: discovery retains the original import and downloads only the specified provider version', async () => {
  const view = await scene(body => body.path === desktopPath
    ? { kind: 'module', reviewId: 'desktop-review', review: review(provider.moduleId, provider.version) } : missing());
  await view.controller.inspectImportModule();
  walk(view.find('import-provider-selection')).find(node => node.tag === 'button').onclick();
  assert.equal(view.controller.pendingDependencyImports[0].path, counterPath);
  assert.equal(view.elements['inp-import-path'].value, counterPath);
  assert.equal(view.elements['inp-ws-search'].value, provider.moduleId);
  assert.equal(view.elements['sel-ws-type'].value, 'module');
  const cards = view.elements['workshop-entries-box'].children;
  assert.equal(cards.length, 1);
  const versions = walk(cards[0]).find(node => node.tag === 'select');
  assert.equal(versions.children.length, 1);
  assert.equal(versions.value, `module.${provider.moduleId}.${provider.version}`);
  await walk(cards[0]).find(node => node.tag === 'button').onclick(click);
  // The real download handler starts the import inspection after opening the modal.
  await new Promise(resolve => setImmediate(resolve));
  const download = view.requests.find(request => request.url === '/manage/api/workshop/fetch');
  assert.deepEqual(download.body, { source: sourceUrl, entryId: `module.${provider.moduleId}.${provider.version}`, digest: sourceDigest, allowPrivateNetwork: false });
  assert.equal(view.elements['inp-import-path'].value, desktopPath);
  assert.equal(view.controller.currentImportReview?.reviewId, 'desktop-review');
  assert.equal(view.controller.pendingDependencyImports[0].path, counterPath);
  assert.equal(view.toasts.some(([message]) => message.startsWith('下载异常:')), false);
});

test('default connections UI: ambiguous target selections are submitted separately from capability bindings', async () => {
  const candidates = ['desktop-one', 'desktop-two'].map(programId => ({ programId, module: { id: provider.moduleId, version: provider.version }, state: 'stopped' }));
  const view = await scene((body, number) => number === 1 ? { kind: 'module', selectionRequired: true,
    requiredProviders: [], defaultConnections: [resolution('ambiguous', { candidates })] } : ready());
  await view.controller.inspectImportModule();
  const select = walk(view.find('import-provider-selection')).find(node => node.tag === 'select');
  assert.equal(select.children.length, 3);
  select.value = 'desktop-two';
  await view.controller.inspectImportModule();
  const request = view.requests.filter(item => item.url === '/manage/api/artifacts/preview')[1];
  assert.deepEqual(request.body.connectionSelections, { desktop: 'desktop-two' });
  assert.deepEqual(request.body.bindings, [], 'a default target selection must not masquerade as an explicit capability binding');
  assert.equal(view.find('import-provider-selection'), undefined);
  assert.equal(view.elements['btn-confirm-import'].disabled, false);
});

test('default connections UI: resolved targets, alias mappings and capability wiring are visible without raw JSON', async () => {
  const view = await scene(ready);
  await view.controller.inspectImportModule();
  const text = outsideDetails(view.find('import-review-details'));
  assert.match(text, /默认接线已准备：desktop → example\.soft-ui-desktop @ 0\.3\.0 \(desktop-one\)/);
  assert.match(text, /commands → commands、events → events/);
  assert.match(text, /能力接线：soft-ui\.windows @ 1\.0\.0 → example\.soft-ui-desktop \(desktop-one\)/);
  assert.match(text, /chosen\/desktop\/commands/);
  assert.equal(view.controller.currentImportReview.reviewId, 'counter-review');
});

test('default connections UI: group review exposes publisher prewiring and startup order outside optional JSON', async () => {
  const desktop = review(provider.moduleId, provider.version), counter = review();
  counter.bindings = [{ providerId: 'group-desktop', contract }];
  const group = { kind: 'module-group', reviewId: 'group-review', review: {
    manifest: { id: 'example.soft-ui-group', title: 'Prewired desk', startupPlan: {
      startupOrder: ['desktop', 'counter'], members: [{ programId: 'desktop', enabled: true }, { programId: 'counter', enabled: true }] } },
    members: [{ programId: 'group-desktop', review: desktop }, { programId: 'group-counter', review: counter }] } };
  const view = await scene(() => group);
  await view.controller.inspectImportModule();
  assert.match(view.elements['import-prev-desc'].textContent, /将还原作者预置的主题、能力绑定和启动计划，无需重新手动接线/);
  const text = outsideDetails(view.find('import-review-details'));
  assert.match(text, /soft-ui\.windows @ 1\.0\.0 → example\.soft-ui-desktop \(group-desktop\)/);
  assert.match(text, /启动计划：desktop → counter/);
  assert.equal(view.elements['btn-confirm-import'].disabled, false);
});

test('default connections UI: importing the missing provider resumes and reinspects the original module', async () => {
  let installed = false;
  const view = await scene(body => body.path === desktopPath
    ? { kind: 'module', reviewId: 'desktop-review', review: review(provider.moduleId, provider.version) }
    : installed ? ready() : missing(), {
    apply: body => { assert.deepEqual(body, { kind: 'module', reviewId: 'desktop-review', accepted: true }); installed = true; return { ok: true }; }
  });
  await view.controller.inspectImportModule();
  walk(view.find('import-provider-selection')).find(node => node.tag === 'button').onclick();
  const download = walk(view.elements['workshop-entries-box']).find(node => node.tag === 'button');
  await download.onclick(click);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.controller.currentImportReview?.reviewId, 'desktop-review', 'download must prepare the provider import review');
  await view.controller.confirmImportModule();
  assert.equal(installed, true);
  assert.equal(view.elements['inp-import-path'].value, counterPath);
  assert.equal(view.controller.currentImportReview?.reviewId, 'counter-review');
  assert.equal(view.controller.currentImportReview?.sourcePath, counterPath);
  assert.equal(view.controller.pendingDependencyImports.length, 0);
  assert.equal(view.requests.filter(item => item.url === '/manage/api/artifacts/preview' && item.body.path === counterPath).length, 2);
  assert.equal(view.toasts.some(([message]) => /导入异常|下载异常/.test(message)), false);
});
