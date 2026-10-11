import test from 'node:test';
import assert from 'node:assert/strict';
import { element } from './ui-dom.mjs';
import { createPathUi } from '../../../tools/launcher/public/path-ui.mjs';
import { createTaskUi } from '../../../tools/launcher/public/task-ui.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const byText = (root, title) => root.querySelectorAll('button').find(node => node.textContent === title);
function scene(api) {
  const body = element('body', {}, element('div', { class: 'topbar-actions' }));
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const state = { language: 'en', auth: { token: 'inert-test-session' }, instances: [{ instanceId: 'example' }] }, imports = [];
  const ctx = { state, api, el: element, button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title), toast() {}, date: String, selectInstance() {}, openImport: path => imports.push(path), openCreator() {} };
  return { body, ctx, imports };
}

test('TASK-UI-01 a refreshed task center offers pack actions for fetch/export/template results but never for fetched modules', async () => {
  const operations = [
    { id: 'pack', kind: 'fetch-source', state: 'succeeded', result: { kind: 'pack', directory: '/cache/pack' } },
    { id: 'module', kind: 'fetch-source', state: 'succeeded', result: { kind: 'module', directory: '/cache/module' } },
    { id: 'export', kind: 'export', state: 'succeeded', result: { destination: '/output/export' } },
    { id: 'template', kind: 'instantiate-template', state: 'succeeded', result: { directory: '/output/template' } }
  ];
  const { body, ctx, imports } = scene(async () => ({ operations })), ui = createTaskUi(ctx);
  await ui.open(); const dialog = body.querySelector('#task-center-dialog'), cards = dialog.querySelectorAll('article');
  assert.equal(cards.length, 4); assert.equal(byText(cards[1], 'Import and review'), undefined);
  await byText(cards[0], 'Import and review').dispatch('click'); assert.deepEqual(imports, ['/cache/pack']);
  await ui.open(); await byText(dialog.querySelectorAll('article')[2], 'Import and review').dispatch('click');
  assert.deepEqual(imports, ['/cache/pack', '/output/export']);
  await ui.open(); await byText(dialog.querySelectorAll('article')[3], 'Import and review').dispatch('click');
  assert.deepEqual(imports, ['/cache/pack', '/output/export', '/output/template']);
  assert.equal(dialog.open, false);
});

test('TASK-UI-02 closing and reopening while an earlier list is pending cannot lose or replace the new task list', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const { body, ctx } = scene(() => (++calls === 1 ? first.promise : second.promise)), ui = createTaskUi(ctx);
  const oldOpen = ui.open(), dialog = body.querySelector('#task-center-dialog');
  dialog.close(); const newOpen = ui.open(); assert.equal(calls, 2);
  second.resolve({ operations: [{ id: 'new', kind: 'export', state: 'succeeded', result: { destination: '/new' } }] }); await newOpen;
  first.resolve({ operations: [{ id: 'old', kind: 'export', state: 'succeeded', result: { destination: '/old' } }] }); await oldOpen;
  assert.match(dialog.textContent, /\/new/); assert.doesNotMatch(dialog.textContent, /\/old/); dialog.close();
});

test('TASK-UI-04 another task completing does not remove keyboard focus from a saved output action', async () => {
  let operations = [{ id: 'saved', kind: 'derive', state: 'succeeded', result: { directory: '/saved-output' } }, { id: 'pending', kind: 'fetch-source', state: 'running' }];
  const { body, ctx } = scene(async path => {
    if (path.endsWith('/cancel')) { operations = [operations[0], { ...operations[1], state: 'failed', error: { message: 'Cancelled' } }]; return {}; }
    return { operations };
  }), ui = createTaskUi(ctx); await ui.open(); const dialog = body.querySelector('#task-center-dialog');
  try {
    byText(dialog.querySelectorAll('article')[0], 'Copy path').focus();
    await byText(dialog, 'Cancel task').dispatch('click');
    assert.equal(document.activeElement, byText(dialog.querySelectorAll('article')[0], 'Copy path'));
    assert.match(dialog.textContent, /Cancelled/);
  } finally { dialog.close(); }
});

test('PATH-UI-03 an old selection check cannot write its result into a different reopened field', async () => {
  const selection = deferred();
  const { body, ctx } = scene(async (path, input) => {
    if (path === '/api/paths/known') return { places: [], recents: [], objects: [] };
    if (path === '/api/paths/browse') return { directory: '/collection', parent: '/', roots: [{ name: '/', path: '/' }], offset: 0, nextOffset: null, entries: [{ name: 'sample', path: '/collection/sample', kind: 'directory', selectable: true }] };
    if (path === '/api/paths/check' && input.path === '/collection/sample') return selection.promise;
    if (path === '/api/paths/check') return { path: input.path, kind: 'directory', selectable: true };
    throw new Error('Unexpected mutation ' + path);
  });
  const ui = createPathUi(ctx), first = element('input'), second = element('input'); first.dataset.pathPurpose = 'pack'; second.dataset.pathPurpose = 'module';
  await ui.open(first); const dialog = body.querySelector('#path-picker-dialog');
  await byText(dialog, 'Select').dispatch('click'); await turn(); dialog.close();
  await ui.open(second); selection.resolve({ path: '/collection/sample', selectable: true }); await turn();
  assert.equal(first.value, ''); assert.equal(second.value, ''); assert.equal(dialog.open, true);
  dialog.close(); ui.dispose();
});
