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

test('TASK-UI-05 duplicate download operations of the same pack deduplicate the pending import badge count and mark older operations as duplicate download', async () => {
  const operations = [
    { id: 'pack-run-2', kind: 'fetch-source', state: 'succeeded', startedAt: '2026-10-13T12:00:00Z', result: { kind: 'pack', directory: '/cache/pack-a' } },
    { id: 'pack-run-1', kind: 'fetch-source', state: 'succeeded', startedAt: '2026-10-13T11:00:00Z', result: { kind: 'pack', directory: '/cache/pack-a' } },
    { id: 'pack-b-1', kind: 'fetch-source', state: 'succeeded', startedAt: '2026-10-13T10:00:00Z', result: { kind: 'pack', directory: '/cache/pack-b' } }
  ];
  const { body, ctx } = scene(async () => ({ operations })), ui = createTaskUi(ctx);
  await ui.open();
  const trigger = body.querySelector('#task-center-button');
  const badge = trigger.querySelector('.badge-pending-import');
  assert.equal(badge.textContent, '2 to import');
  const dialog = body.querySelector('#task-center-dialog');
  const cards = dialog.querySelectorAll('article');
  assert.equal(cards.length, 3);
  assert.ok(cards[0].className.includes('is-pending-import'));
  assert.ok(!cards[1].className.includes('is-pending-import'));
  assert.match(cards[1].textContent, /Duplicate download/);
  assert.ok(cards[2].className.includes('is-pending-import'));
  dialog.close();
});

test('TASK-UI-06 category filter tabs allow switching between all, pending, packs, modules, lifecycle, and failed tasks', async () => {
  const operations = [
    { id: 'pack-1', kind: 'fetch-source', state: 'succeeded', startedAt: '2026-10-13T12:00:00Z', result: { kind: 'pack', directory: '/cache/pack-1' } },
    { id: 'pack-2', kind: 'fetch-source', state: 'succeeded', startedAt: '2026-10-13T11:00:00Z', result: { kind: 'pack', directory: '/cache/pack-1' } },
    { id: 'mod-1', kind: 'fetch-source', state: 'succeeded', startedAt: '2026-10-13T10:00:00Z', result: { kind: 'module', directory: '/cache/mod-1' } },
    { id: 'start-1', kind: 'start', state: 'succeeded', startedAt: '2026-10-13T09:00:00Z' },
    { id: 'fail-1', kind: 'fetch-source', state: 'failed', startedAt: '2026-10-13T08:00:00Z' }
  ];
  const { body, ctx } = scene(async () => ({ operations })), ui = createTaskUi(ctx);
  await ui.open();
  const dialog = body.querySelector('#task-center-dialog');
  const filterPills = dialog.querySelectorAll('.task-filter-pill');
  assert.equal(filterPills.length, 6);
  assert.equal(dialog.querySelectorAll('article').length, 5);
  const pendingBtn = filterPills.find(btn => btn.dataset.filterId === 'pending');
  assert.match(pendingBtn.textContent, /1/);
  await pendingBtn.dispatch('click');
  assert.equal(dialog.querySelectorAll('article').length, 1);
  assert.ok(dialog.querySelectorAll('article')[0].className.includes('is-pending-import'));
  const packsBtn = filterPills.find(btn => btn.dataset.filterId === 'packs');
  await packsBtn.dispatch('click');
  assert.equal(dialog.querySelectorAll('article').length, 2);
  const failedBtn = filterPills.find(btn => btn.dataset.filterId === 'failed');
  await failedBtn.dispatch('click');
  assert.equal(dialog.querySelectorAll('article').length, 1);
  dialog.close();
});

test('TASK-UI-07 opening or cancelling import retains pending status; only a real matching instance clears it', async () => {
  const operations = [{ id: 'download', kind: 'fetch-source', state: 'succeeded', result: { kind: 'pack', directory: '/cache/pack' } }];
  const { body, ctx, imports } = scene(async () => ({ operations })), ui = createTaskUi(ctx);
  ctx.state.instances = [];
  await ui.open(); const dialog = body.querySelector('#task-center-dialog');
  await byText(dialog, 'Import and review').dispatch('click');
  assert.deepEqual(imports, ['/cache/pack']);
  assert.equal(body.querySelector('.badge-pending-import').textContent, '1 to import');
  // Closing the import without creating an instance, including a failed import,
  // leaves the only authoritative instance list unchanged.
  await ui.open(); assert.match(dialog.textContent, /Pending import/); dialog.close();
  ctx.state.instances = [{ instanceId: 'other', sourceDirectory: '/cache/other' }];
  await ui.check(); assert.equal(body.querySelector('.badge-pending-import').textContent, '1 to import');
  ctx.state.instances.push({ instanceId: 'created', sourceDirectory: '/cache/pack' });
  await ui.open(); assert.equal(body.querySelector('.badge-pending-import'), null);
  assert.doesNotMatch(dialog.textContent, /Pending import/);
  dialog.close();
  ctx.state.instances = []; await ui.check();
  assert.equal(body.querySelector('.badge-pending-import').textContent, '1 to import');
});

test('PATH-UI-04 an old native picker result cannot fill or close a newly opened target', async () => {
  const native = deferred();
  const { body, ctx } = scene(async (path, input) => {
    if (path === '/api/paths/known') return { places: [], recents: [], objects: [] };
    if (path === '/api/paths/browse') return { directory: '/collection', parent: '/', roots: [], offset: 0, nextOffset: null, entries: [] };
    if (path === '/api/paths/native-pick') return native.promise;
    if (path === '/api/paths/check') return { path: input.path, kind: 'directory', selectable: true };
    throw new Error('Unexpected request ' + path);
  });
  const ui = createPathUi(ctx), first = element('input'), second = element('input');
  first.dataset.pathPurpose = 'source'; second.dataset.pathPurpose = 'pack';
  await ui.open(first); const dialog = body.querySelector('#path-picker-dialog');
  const oldRequest = dialog.querySelector('.path-pick-native').dispatch('click');
  await turn(); dialog.close(); await ui.open(second);
  native.resolve({ path: '/old-a.txt', kind: 'file' }); await oldRequest;
  assert.equal(first.value, ''); assert.equal(second.value, ''); assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('[name=path-location]').value, '/collection');
  dialog.close(); ui.dispose();
});

test('PATH-UI-05 selecting a save parent preserves the new filename and validates the full output', async () => {
  const checks = [];
  const { body, ctx } = scene(async (path, input) => {
    if (path === '/api/paths/known') return { places: [], recents: [], objects: [] };
    if (path === '/api/paths/browse') return { directory: input.directory ?? '/collection', parent: '/', roots: [], offset: 0, nextOffset: null, entries: [] };
    if (path === '/api/paths/native-pick') return { path: '/new-parent', kind: 'directory', selectionMode: 'parent' };
    if (path === '/api/paths/check') { checks.push(input); return { path: input.path, kind: 'missing', parent: '/old-parent', selectable: true }; }
    if (path === '/api/paths/remember') return {};
    throw new Error('Unexpected request ' + path);
  });
  const ui = createPathUi(ctx), field = element('input');
  field.dataset.pathPurpose = 'save-file'; field.value = '/old-parent/新备份.json';
  await ui.open(field); const dialog = body.querySelector('#path-picker-dialog');
  await dialog.querySelector('.path-pick-native').dispatch('click');
  assert.equal(field.value, '/old-parent/新备份.json');
  assert.equal(dialog.querySelector('[name=path-new-name]').value, '新备份.json');
  await dialog.querySelector('.path-save').dispatch('click'); await turn();
  assert.equal(field.value, '/new-parent/新备份.json');
  assert.deepEqual(checks.at(-1), { path: '/new-parent/新备份.json', purpose: 'save-file' });
  assert.equal(dialog.open, false); ui.dispose();
});
