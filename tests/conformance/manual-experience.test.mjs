import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { AnnotationDrafts, LatestRead, boundedJson, matchesLog, reconcileRows } from '../../src/management/manual-experience-state.mjs';
import { createI18n } from '../../src/ui/language.mjs';
import { manualEnglish } from '../../src/management/manual-i18n.mjs';

const source = readFileSync(new URL('../../src/management/manual-console.mjs', import.meta.url), 'utf8');
const draftValue = name => ({ bridgeName: name, programs: [{ id: 'custom:program', name: '程序' }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function functionSource(name, next) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf(next, start);
  assert.ok(end > start);
  return source.slice(start, end);
}
function withPresentation(context, i18n = createI18n(manualEnglish)) {
  context.i18n = i18n;
  runInContext(source.slice(source.indexOf('const t ='), source.indexOf('// This page is one ordinary external mod.')), context);
  runInContext(functionSource('uiError', 'const safeError ='), context);
  return context;
}

test('per-subject drafts survive switching and saved version cannot remove newer edits', () => {
  const drafts = new AnnotationDrafts();
  drafts.edit('a', draftValue('A unsaved')); drafts.edit('b', draftValue('B unsaved'));
  const submitted = drafts.snapshot('a', {});
  drafts.edit('a', draftValue('A typed while saving'));
  assert.equal(drafts.settle(submitted), false);
  assert.equal(drafts.get('a').value.bridgeName, 'A typed while saving');
  assert.equal(drafts.get('b').value.bridgeName, 'B unsaved');
  const snapshot = drafts.snapshot('a', {}); assert.equal(drafts.settle(snapshot), true);
  assert.equal(drafts.get('a'), null);
  assert.equal(drafts.get('b').value.bridgeName, 'B unsaved');
});

test('draft snapshots are isolated and a previously clean submission cannot discard subsequent input', () => {
  const drafts = new AnnotationDrafts(); const submitted = drafts.snapshot('a', draftValue('clean'));
  drafts.edit('a', draftValue('new input'));
  assert.equal(drafts.settle(submitted), false);
  const obtained = drafts.get('a'); obtained.value.programs[0].name = 'changed outside store';
  assert.equal(drafts.get('a').value.programs[0].name, '程序');
});

test('draft cap refuses the next subject without silently evicting existing unsaved work', () => {
  const drafts = new AnnotationDrafts(2);
  drafts.edit('a', draftValue('A')); drafts.edit('b', draftValue('B'));
  assert.throws(() => drafts.edit('c', draftValue('C')), { code: 'DRAFT_LIMIT' });
  drafts.edit('a', draftValue('A newer'));
  assert.equal(drafts.entries.size, 2); assert.equal(drafts.get('b').value.bridgeName, 'B');
  drafts.discard('b'); drafts.edit('c', draftValue('C')); assert.equal(drafts.entries.size, 2);
});

test('actual refresh handler applies only newest response and ignores superseded failures', async () => {
  const one = deferred(), two = deferred(), three = deferred(), four = deferred();
  const waits = [one, two, three, four], applied = [], failures = [];
  const context = createContext({ managementMutation: false, managementReads: new LatestRead(), fetch: () => {},
    boundedJson: () => waits.shift().promise, applyManagementState: value => applied.push(value), staleManagement: error => failures.push(error) });
  runInContext('async ' + functionSource('refreshManagement', 'async function managementPost'), context);
  const older = context.refreshManagement(), newer = context.refreshManagement();
  two.resolve({ hub: 'new' }); await newer; one.resolve({ hub: 'old' }); assert.equal(await older, null);
  assert.deepEqual(applied, [{ hub: 'new' }]);
  const superseded = context.refreshManagement(), current = context.refreshManagement();
  four.resolve({ hub: 'current' }); await current; three.reject(new Error('obsolete transport error')); assert.equal(await superseded, null);
  assert.equal(failures.length, 0); assert.deepEqual(applied, [{ hub: 'new' }, { hub: 'current' }]);
});

test('finite HTTP wait aborts a stalled request and sends exactly once', async () => {
  let calls = 0, signal;
  const before = Date.now();
  await assert.rejects(boundedJson((_path, options) => { calls++; signal = options.signal; return new Promise(() => {}); }, '/manage/api/annotation', { method: 'POST' }, 25), { code: 'MANAGEMENT_TIMEOUT' });
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.ok(Date.now() - before < 1000);
});

test('finite HTTP wait includes stalled JSON body reading and surfaces server rejection', async () => {
  await assert.rejects(boundedJson(async () => ({ ok: true, json: () => new Promise(() => {}) }), '/manage/api/state', {}, 25), { code: 'MANAGEMENT_TIMEOUT' });
  await assert.rejects(boundedJson(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'MANAGEMENT_TOKEN_REQUIRED', message: 'expired token' } }) }), '/manage/api/bridge'), { code: 'MANAGEMENT_TOKEN_REQUIRED', message: 'expired token' });
});

test('actual management mutation disables stale operations and never retries unknown result', async () => {
  const pending = deferred(); let calls = 0, stale = 0;
  const node = { textContent: '' };
  const context = withPresentation(createContext({ managementMutation: false, managementFresh: true, managementState: { csrfToken: 'local-only-token' }, managementReads: new LatestRead(),
    boundedJson: () => { calls++; return pending.promise; }, fetch: () => {}, $: () => node, updateControls() {}, staleManagement() { stale++; }, addLog() {}, format: JSON.stringify }));
  runInContext('async ' + functionSource('managementPost', "$('managed-key').onchange"), context);
  const first = context.managementPost('/manage/api/annotation', { key: 'a' });
  assert.equal(context.managementFresh, false); assert.equal(context.managementMutation, true);
  await assert.rejects(context.managementPost('/manage/api/bridge', { key: 'a' }), { code: 'MANAGEMENT_STATE_STALE' });
  pending.reject(Object.assign(new Error('unknown result'), { code: 'MANAGEMENT_TIMEOUT' }));
  await assert.rejects(first, { code: 'MANAGEMENT_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(stale, 1); assert.equal(context.managementMutation, false); assert.equal(context.managementFresh, false);
});

test('actual annotation submit preserves edits typed after HTTP submission and preserves other subjects', async () => {
  const drafts = new AnnotationDrafts(), pending = deferred(); let formValue = draftValue('submitted'), posted, refreshed;
  drafts.edit('a', formValue); drafts.edit('b', draftValue('other subject')); let saving;
  const form = {}, context = createContext({
    $: id => id === 'annotation-form' ? form : {}, managedEntry: () => ({ key: 'a' }),
    captureAnnotation: () => drafts.edit('a', formValue), drafts, annotationValue: () => formValue,
    annotationKey: 'a', annotationBase: draftValue('initial'),
    perform: (_button, callback) => { saving = callback(); return saving; },
    managementPost: (_path, value) => { posted = value; return pending.promise; },
    refreshManagement: async reset => { refreshed = reset; }, renderDraftStatus() {}, notice() {},
  });
  const start = source.indexOf("$('annotation-form').onsubmit =");
  const end = source.indexOf("$('open-capacity').onclick", start);
  runInContext(source.slice(start, end), context);
  form.onsubmit({ preventDefault() {}, submitter: {} });
  formValue = draftValue('new input while HTTP pending'); drafts.edit('a', formValue);
  pending.resolve({ ok: true }); await saving;
  assert.equal(posted.bridgeName, 'submitted'); assert.equal(refreshed, false);
  assert.equal(drafts.get('a').value.bridgeName, 'new input while HTTP pending'); assert.equal(drafts.get('b').value.bridgeName, 'other subject');
});

test('actual capture treats reverting to old server value during save as a newer edit', () => {
  const drafts = new AnnotationDrafts(); const baseline = draftValue('old server value');
  drafts.edit('a', draftValue('submitted value')); const submitted = drafts.snapshot('a', {});
  const context = createContext({ annotationKey: 'a', annotationBase: baseline, annotationValue: () => baseline, drafts, renderDraftStatus() {} });
  runInContext(functionSource('captureAnnotation', 'function editAnnotation'), context);
  context.captureAnnotation(); assert.equal(drafts.settle(submitted), false);
  assert.equal(drafts.get('a').value.bridgeName, 'old server value');
});

test('local direction/text filter leaves exact received text and retained entries unchanged', () => {
  const raw = '{"type":"delivery","topic":"User/Chosen","body":{"n":123456789012345678901234567890,"s":"<img src=x>"}}';
  const item = Object.freeze({ localId: 1, direction: 'receive', type: 'delivery', raw });
  const items = Object.freeze([item]);
  assert.equal(matchesLog(item, 'receive', 'user/chosen'), true);
  assert.equal(matchesLog(item, 'send', 'user/chosen'), false);
  assert.equal(matchesLog(item, 'all', 'missing'), false);
  assert.equal(matchesLog(item, 'all', ' <IMG '), true);
  assert.equal(items[0].raw, raw); assert.equal(items.length, 1);
});

class NodeModel {
  constructor(document, tag = 'div') { this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.hidden = false; this.open = false; this.scrollTop = 0; this.clientHeight = 10; this.dataset = {}; this.classList = { toggle() {}, add() {}, remove() {} }; this._value = ''; this.listeners = new Map(); this.selectionStart = 0; this.selectionEnd = 0; }
  get value() { return this.tagName === 'SELECT' ? (this.children.find(child => child.value === this._value) ?? this.children[0])?.value ?? '' : this._value; }
  set value(value) { this._value = value; }
  get options() { return this.children; }
  get scrollHeight() { return this.children.filter(row => !row.hidden).length * 10; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { if (!this.parentElement) return null; return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  insertBefore(node, next) { if (node.parentElement) node.remove(); const index = next ? this.children.indexOf(next) : this.children.length; assert.ok(index >= 0); this.children.splice(index, 0, node); node.parentElement = this; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  matches(selector) { return selector.split(',').some(part => { const attribute = part.match(/^\[([^\]]+)\]$/); return attribute ? this.getAttribute(attribute[1]) !== null : this.tagName.toLowerCase() === part; }); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  setAttribute(name, value) { this[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this, name) ? String(this[name]) : null; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  remove() { if (this.parentElement) { const parent = this.parentElement; if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; } }
  focus() { this.ownerDocument.activeElement = this; }
}
function listHarness() {
  const document = { activeElement: null }, container = new NodeModel(document), empty = new NodeModel(document), fallback = new NodeModel(document), cache = new Map();
  container.append(empty);
  return { document, container, empty, cache, focusFallback: fallback, create: () => new NodeModel(document) };
}

test('bounded log reconciliation keeps open detail nodes and focus when unrelated frames arrive or filters change', () => {
  const h = listHarness(); const entries = [{ localId: 1 }, { localId: 2 }];
  reconcileRows({ ...h, entries });
  const first = h.cache.get(1); first.open = true; first.focus(); h.container.scrollTop = 7;
  entries.push({ localId: 3 }); reconcileRows({ ...h, entries });
  assert.equal(h.cache.get(1), first); assert.equal(first.open, true); assert.equal(h.document.activeElement, first); assert.equal(h.container.scrollTop, 7);
  reconcileRows({ ...h, entries, visible: item => item.localId !== 1 }); assert.equal(first.hidden, true); assert.equal(h.document.activeElement, h.focusFallback);
  reconcileRows({ ...h, entries }); assert.equal(first.hidden, false); assert.equal(first.open, true); assert.equal(h.cache.get(1), first);
});

test('eviction removes only expired nodes and restores focus; prepended delivery keeps reading position', () => {
  const h = listHarness(); let entries = [{ localId: 2 }, { localId: 1 }]; reconcileRows({ ...h, entries });
  const reading = h.cache.get(1); reading.open = true; reading.focus(); h.container.scrollTop = 5;
  entries = [{ localId: 3 }, ...entries]; reconcileRows({ ...h, entries, prepend: true });
  assert.equal(h.cache.get(1), reading); assert.equal(reading.open, true); assert.equal(h.document.activeElement, reading); assert.equal(h.container.scrollTop, 15);
  entries = entries.slice(0, 2); reconcileRows({ ...h, entries, prepend: true });
  assert.equal(h.cache.size, 2); assert.equal(h.cache.has(1), false); assert.equal(h.document.activeElement, h.focusFallback);
});

test('actual managed-instance render keeps expanded diagnosis while updated cursor and replacement identities remain distinct', () => {
  const document = { activeElement: null }; document.createElement = () => new NodeModel(document);
  const nodes = new Map(); const $ = id => { if (!nodes.has(id)) nodes.set(id, new NodeModel(document)); return nodes.get(id); };
  const entry = { key: 'a', kind: 'bridge', manageable: true, paused: false, instances: [{ connectionId: 'connection-one', bridgeId: 'a', session: 'session-one', authenticated: true }] };
  const context = withPresentation(createContext({ $, document, managedEntry: () => entry, managedRowsKey: null, managedRows: new Map(), managedEmpty: document.createElement(), managementFresh: true,
    annotationKey: 'a', showAnnotation() {}, reconcileRows, perform() {}, managementPost() {}, refreshManagement() {}, notice() {},
    managementState: { hub: { subscriptions: [{ id: 'sub', bridgeId: 'a', cursor: 1 }] } }, format: JSON.stringify }));
  runInContext(functionSource('renderManagedEntry', 'function applyManagementState'), context);
  context.renderManagedEntry(); const first = context.managedRows.get('connection-one'), details = first.children[2];
  details.open = true; first.mcParts.disconnect.focus();
  context.managementState.hub.subscriptions[0].cursor = 9; context.renderManagedEntry();
  assert.equal(context.managedRows.get('connection-one'), first); assert.equal(details.open, true);
  assert.equal(document.activeElement, first.mcParts.disconnect); assert.match(first.mcParts.pre.textContent, /"cursor":9/);
  entry.instances = [{ connectionId: 'connection-two', bridgeId: 'a', session: 'session-two', authenticated: true }]; context.renderManagedEntry();
  assert.equal(context.managedRows.has('connection-one'), false); assert.equal(context.managedRows.size, 1);
  assert.equal(context.managedRows.get('connection-two').mcParts.values[1].textContent, 'session-two');
});

function annotationDomHarness() {
  const document = { activeElement: null }; document.createElement = tag => new NodeModel(document, tag);
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, document.createElement(id === 'managed-key' ? 'select' : id === 'annotation-form' ? 'form' : 'div')); return nodes.get(id); };
  const name = document.createElement('input'); nodes.set('annotation-name', name);
  $('annotation-form').append(name, $('annotation-rows'));
  const state = { csrfToken: 'test-only', bridges: ['a', 'b'].map(key => ({ key, kind: 'bridge', manageable: true, paused: false,
    label: key.toUpperCase(), annotation: { bridgeName: key.toUpperCase() }, programs: [{ id: `program.${key}`, name: `Program ${key}` }], instances: [] })), hub: { subscriptions: [] } };
  const post = deferred(), messages = [], failures = []; let posted, calls = 0;
  const context = withPresentation(createContext({ $, document, structuredClone, AnnotationDrafts, LatestRead, boundedJson, reconcileRows, managementMutation: false,
    managementFresh: false, managementState: null, annotationKey: null, annotationBase: null, drafts: new AnnotationDrafts(), managementReads: new LatestRead(),
    managedRows: new Map(), managedRowsKey: null, managedEmpty: document.createElement('p'), busyButtons: new Set(),
    textValue: id => $(id).value.trim(), updateControls() {}, safeError: error => { failures.push(error); return error.message; },
    notice: message => messages.push(message), addLog() {}, format: JSON.stringify,
    fetch: async (_path, options) => {
      calls++;
      if (options.method === 'POST') { posted = JSON.parse(options.body); return post.promise; }
      return { ok: true, json: async () => structuredClone(state) };
    },
  }));
  runInContext(source.slice(source.indexOf('const managedEntry ='), source.indexOf("$('open-capacity').onclick")), context);
  runInContext('async ' + functionSource('perform', 'function requireFeature'), context);
  context.applyManagementState(structuredClone(state));
  return { context, document, $, state, post, messages, failures, get posted() { return posted; }, get calls() { return calls; } };
}

test('save-to-refresh DOM chain preserves newer program-name input node, focus and selection', async () => {
  const h = annotationDomHarness();
  const nameInput = h.$('annotation-rows').querySelectorAll('input').find(input => input.dataset.field === 'name');
  nameInput.value = 'submitted name'; h.context.captureAnnotation();
  const saving = h.context.perform(h.$('annotation-save'), async () => {
    // Invoke the actual installed submit callback and await its actual perform.
    let inner;
    const actualPerform = h.context.perform;
    h.context.perform = (button, callback) => { inner = actualPerform(button, callback); return inner; };
    h.$('annotation-form').onsubmit({ preventDefault() {}, submitter: null });
    h.context.perform = actualPerform;
    nameInput.value = 'typed while save pending'; nameInput.focus(); nameInput.selectionStart = 6; nameInput.selectionEnd = 11;
    h.context.captureAnnotation();
    h.state.bridges[0].programs[0].name = h.posted.programs[0].name;
    h.post.resolve({ ok: true, json: async () => ({ ok: true }) }); await inner;
  });
  await saving;
  assert.equal(h.failures.length, 0); assert.equal(h.calls, 2);
  assert.equal(h.$('annotation-rows').querySelectorAll('input').find(input => input.dataset.field === 'name'), nameInput);
  assert.equal(h.document.activeElement, nameInput); assert.equal(nameInput.value, 'typed while save pending');
  assert.equal(nameInput.selectionStart, 6); assert.equal(nameInput.selectionEnd, 11);
  assert.equal(h.context.drafts.get('a').value.programs[0].name, 'typed while save pending');
});

test('save-to-refresh DOM chain keeps another selected subject input and its focus', async () => {
  const h = annotationDomHarness();
  h.$('annotation-name').value = 'submitted A'; h.context.captureAnnotation();
  let saving; const actualPerform = h.context.perform;
  h.context.perform = (button, callback) => { saving = actualPerform(button, callback); return saving; };
  h.$('annotation-form').onsubmit({ preventDefault() {}, submitter: null }); h.context.perform = actualPerform;
  h.$('managed-key').value = 'b'; h.$('managed-key').onchange();
  const otherInput = h.$('annotation-rows').querySelectorAll('input').find(input => input.dataset.field === 'name');
  otherInput.value = 'B continued input'; otherInput.focus(); otherInput.selectionStart = 2; otherInput.selectionEnd = 4; h.context.captureAnnotation();
  h.state.bridges[0].annotation.bridgeName = 'submitted A';
  h.post.resolve({ ok: true, json: async () => ({ ok: true }) }); await saving;
  assert.equal(h.failures.length, 0); assert.equal(h.$('managed-key').value, 'b');
  assert.equal(h.$('annotation-rows').querySelectorAll('input').find(input => input.dataset.field === 'name'), otherInput);
  assert.equal(h.document.activeElement, otherInput); assert.equal(otherInput.selectionStart, 2); assert.equal(otherInput.selectionEnd, 4);
  assert.equal(h.context.drafts.get('b').value.programs[0].name, 'B continued input');
  assert.equal(h.context.drafts.get('a'), null);
});

test('actual workbench language switch updates English state without losing drafts, token, subscriptions or raw data', () => {
  const h = annotationDomHarness(), dialog = new NodeModel(h.document, 'dialog');
  h.context.dialog = dialog;
  const token = new NodeModel(h.document, 'input'), body = new NodeModel(h.document, 'textarea'), raw = new NodeModel(h.document, 'pre');
  token.value = 'private-token-kept-in-input'; body.value = '{"body":"用户原文","n":123456789012345678901234567890}'; raw.textContent = body.value;
  const heading = new NodeModel(h.document, 'h2'); heading.setAttribute('data-i18n', '手动通讯工作台'); heading.textContent = '手动通讯工作台';
  const descriptor = new NodeModel(h.document, 'pre'); descriptor.setAttribute('data-i18n', '上传成功后显示可信附件描述符。');
  h.context.uiData(descriptor, '{"id":"provider-owned-object","name":"保留原文"}');
  dialog.append(heading, h.$('annotation-form'), h.$('annotation-dirty'), h.$('managed-summary'), h.$('management-status'), h.$('language'), token, body, raw, descriptor);
  const input = h.$('annotation-rows').querySelectorAll('input').find(node => node.dataset.field === 'name');
  input.value = '程序用户自己的注记'; input.focus(); input.selectionStart = 2; input.selectionEnd = 5; h.context.captureAnnotation();
  const subscriptions = new Map([['sub-kept', { cursor: 7, filters: ['程序/自定/主题'] }]]);
  const deliveries = [{ raw: body.value }], logItems = [{ raw: body.value }], bridge = { connected: true, session: 'existing-session', subscriptions };
  Object.assign(h.context, { bridge, subscriptions, deliveries, logItems });
  const baselineDraft = structuredClone(h.context.drafts.get('a')), baselineLog = JSON.stringify(logItems), beforeHttp = h.calls;
  h.context.i18n.onChange(h.context.refreshLanguage);
  h.context.i18n.setLanguage('en');
  assert.equal(heading.textContent, 'Manual communication workbench');
  assert.match(h.$('annotation-dirty').textContent, /Unsaved page drafts/);
  assert.match(h.$('managed-summary').textContent, /Not paused.*0 online instances/);
  assert.equal(h.$('language').value, 'en'); assert.equal(dialog.lang, 'en');
  assert.equal(h.$('annotation-rows').querySelectorAll('input').find(node => node.dataset.field === 'name'), input);
  assert.equal(h.document.activeElement, input); assert.equal(input.value, '程序用户自己的注记');
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 5);
  assert.equal(token.value, 'private-token-kept-in-input'); assert.equal(raw.textContent, body.value);
  assert.equal(descriptor.textContent, '{"id":"provider-owned-object","name":"保留原文"}');
  assert.deepEqual(h.context.drafts.get('a'), baselineDraft); assert.equal(h.context.bridge, bridge); assert.equal(bridge.connected, true);
  assert.equal(h.context.subscriptions, subscriptions); assert.equal(subscriptions.get('sub-kept').cursor, 7);
  assert.equal(JSON.stringify(logItems), baselineLog); assert.equal(h.calls, beforeHttp);
  h.context.i18n.setLanguage('zh-CN');
  assert.equal(heading.textContent, '手动通讯工作台'); assert.match(h.$('annotation-dirty').textContent, /未保存的本页草稿/);
  assert.equal(h.document.activeElement, input); assert.equal(input.selectionStart, 2); assert.equal(input.value, '程序用户自己的注记');
  assert.equal(token.value, 'private-token-kept-in-input'); assert.equal(descriptor.textContent, '{"id":"provider-owned-object","name":"保留原文"}');
  assert.equal(JSON.stringify(logItems), baselineLog); assert.equal(h.calls, beforeHttp);
});
