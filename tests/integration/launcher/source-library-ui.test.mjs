import test from 'node:test';
import assert from 'node:assert/strict';
import { element } from './ui-dom.mjs';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';

const buttonByText = (root, text) => root.querySelectorAll('button').find(button => button.textContent === text);
const storage = entries => {
  const values = new Map(entries);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

function scene(kind, { knownFailure = false, saved, hidden = false } = {}) {
  const store = saved ?? storage(), session = storage(), body = element('body'), calls = [], visits = [], toasts = [];
  body.append(...['modules-content', 'templates-content', 'sources-content', 'creator-content', 'detail-content', 'packs-asset-tabs', 'modules-asset-tabs', 'templates-asset-tabs', 'nav-count', 'nav-modules-count', 'nav-templates-count', 'environment-results', 'environment-discovery-slot', 'env-isolation-slot', 'env-dependencies-slot'].map(id => element('div', { id })), element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })), element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name }))));
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  body.append(element('section', { id: 'view-environment' }));
  globalThis.localStorage = store; globalThis.sessionStorage = session;
  globalThis.window = { addEventListener() {} }; globalThis.location = { origin: 'http://127.0.0.1:32100' };
  const source = { id: 'source.one', name: 'Test official source', source: 'https://source.example/index.json', enabled: true, priority: 0 };
  const entry = { kind, id: 'demo.project', entryId: 'entry.new', title: 'New official title', version: '2.0.0', sha256: 'b'.repeat(64), license: 'MIT', provides: [], requires: [], platforms: ['win32-x64'], source: { url: 'https://source.example/artifact.json' } };
  const old = { kind, id: entry.id, title: 'Previous selected title', version: '1.0.0', path: '/previous-source' };
  const result = { kind, entry, directory: '/verified-download', cached: false, startsModules: false, requiresExecutionReview: true };
  const state = { language: 'en', view: kind === 'module' ? 'modules' : 'templates', instances: [{ instanceId: 'existing-run', pack: { id: 'unrelated.pack', version: '1.0.0' }, status: { state: 'running' } }], reviews: new Map(), environmentSelection: {} };
  let downloaded = false, ui;
  if (hidden) store.setItem('world-hub.launcher.deleted-objects', JSON.stringify([`${kind}:${entry.id}`]));
  const api = async (path, input) => {
    calls.push({ path, input });
    if (path === '/api/paths/known') {
      if (downloaded && knownFailure) throw new Error('Discovery temporarily unavailable');
      return { objects: [old] }; // Newly fetched metadata must also work before discovery catches up.
    }
    if (path === '/api/sources') return { sources: [source], conflicts: [] };
    if (path === '/api/sources/inspect') return { sourceId: source.id, receiptId: 'receipt.current', digest: 'a'.repeat(64), index: { entries: [entry] } };
    if (path === '/api/sources/fetch') { downloaded = true; return { operationId: 'fetch-current' }; }
    if (path === '/api/operations/fetch-current') return { operation: { state: 'succeeded', result } };
    if (path === '/api/operations') return { operations: [] };
    return {};
  };
  const ctx = { state, api, el: element,
    button: (text, callback, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: callback, disabled }, text),
    pill: text => element('span', {}, text), t: key => key, toast: text => toasts.push(text), date: String, display: String,
    definition: rows => element('dl', {}, rows.flatMap(([name, value]) => [element('dt', {}, name), element('dd', {}, String(value ?? ''))])),
    errorContents: error => [element('p', {}, error.message)], current() {}, idOf: row => row.instanceId, endpoint: (id, action) => `/api/instances/${id}/${action}`,
    operationFor() {}, exitUnconfirmed() {}, refresh: async () => {}, renderDetail() {}, navigate: view => { visits.push(view); state.view = view; ui.navigate(view); }, selectInstance() {}, openImport() {}, replaceInstance() {}, confirmDialog() {} };
  ui = createAdvancedUi(ctx);
  return { body, state, ui, store, calls, visits, toasts, entry, result, source, setDownloaded: () => { downloaded = true; } };
}

async function fetchThroughSourceCard(scene) {
  scene.state.view = 'sources'; scene.ui.navigate('sources');
  // Source loading is deferred once to the microtask queue by the real view.
  await new Promise(resolve => setImmediate(resolve));
  const root = scene.body.querySelector('#sources-content');
  const browse = root.querySelectorAll('form').find(form => form.elements.source?.tagName === 'select'); assert.ok(browse);
  browse.elements.source.value = scene.source.source; await browse.dispatch('submit');
  const card = root.querySelector('.source-card'); assert.ok(card);
  if (card.querySelector('.pack-card-main')) await card.querySelector('.pack-card-main').dispatch('click');
  const fetch = scene.body.querySelectorAll('button').find(button => button.textContent.includes('Verify and fetch to cache')); assert.ok(fetch);
  await fetch.dispatch('click');
  const review = scene.body.querySelector('#advanced-action-dialog');
  const check = review.querySelector('[type=checkbox]'); check.checked = true; await check.dispatch('change');
  await buttonByText(review, 'Confirm review and continue').dispatch('click');
}

for (const kind of ['module', 'template']) for (const knownFailure of [false, true]) test(`SOURCE-LIBRARY ${kind} entry-only download is visible and selected despite ${knownFailure ? 'discovery failure' : 'delayed discovery'}`, async () => {
  const current = scene(kind, { knownFailure }); await current.ui.loadKnown();
  const before = JSON.stringify(current.state.instances);
  assert.equal((kind === 'module' ? current.ui.getModules() : current.ui.getTemplates())[0].version, '1.0.0');
  await fetchThroughSourceCard(current);
  const expectedView = kind === 'module' ? 'modules' : 'templates';
  assert.equal(current.visits.at(-1), expectedView);
  const list = current.body.querySelector(kind === 'module' ? '#modules-list' : '#templates-list');
  const cards = list.querySelectorAll('article'); assert.equal(cards.length, 1);
  assert.ok(cards[0].textContent.includes('New official title'));
  assert.ok(cards[0].textContent.includes('@v2.0.0'));
  const rows = kind === 'module' ? current.ui.getModules() : current.ui.getTemplates();
  const downloaded = rows.find(row => row.path === current.result.directory); assert.ok(downloaded);
  assert.equal(downloaded.id, current.entry.id); assert.equal(downloaded.version, current.entry.version); assert.equal(downloaded.title, current.entry.title);
  assert.equal(JSON.stringify(current.state.instances), before);
  assert.equal(current.calls.filter(call => /\/api\/(?:instances|programs).*\/(?:start|restart)$/.test(call.path)).length, 0);
  const savedResults = [...current.store.values].find(([key]) => key.startsWith('world-hub.launcher.results:'))?.[1]; assert.ok(savedResults);
  assert.ok(JSON.parse(savedResults).some(row => row.result.entry?.id === current.entry.id));
  const restart = scene(kind, { knownFailure, saved: current.store }); restart.setDownloaded();
  // A fresh UI tab can reconstruct metadata from recorded download results.
  restart.ui.sessionReady(); restart.ui.navigate(expectedView); await new Promise(resolve => setImmediate(resolve));
  const restoredRows = kind === 'module' ? restart.ui.getModules() : restart.ui.getTemplates();
  assert.ok(restoredRows.some(row => row.path === current.result.directory && row.id === current.entry.id && row.version === current.entry.version));
  const restoredList = restart.body.querySelector(kind === 'module' ? '#modules-list' : '#templates-list');
  assert.ok(restoredList.textContent.includes(current.entry.title));
});

for (const kind of ['module', 'template']) test(`SOURCE-LIBRARY explicit ${kind} download reveals its selected asset after prior hide`, async () => {
  const current = scene(kind, { hidden: true }); await current.ui.loadKnown();
  assert.equal((kind === 'module' ? current.ui.getModules() : current.ui.getTemplates()).length, 0);
  await fetchThroughSourceCard(current);
  const rows = kind === 'module' ? current.ui.getModules() : current.ui.getTemplates();
  assert.ok(rows.some(row => row.path === current.result.directory && row.id === current.entry.id));
  const list = current.body.querySelector(kind === 'module' ? '#modules-list' : '#templates-list');
  assert.ok(list.textContent.includes(current.entry.title));
});
