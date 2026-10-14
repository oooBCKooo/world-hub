import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Element, element } from './ui-dom.mjs';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';
import { groupAssets, createAssetVersionSelection, renderAssetVersionSelector } from '../../../tools/launcher/public/asset-versions.mjs';

const byText = (root, title) => root.querySelectorAll('button').find(node => node.textContent === title);
const choose = async (card, version, path) => {
  const select = card.querySelector('.asset-version-select');
  const option = select.options.find(node => node.textContent.includes(`v${version}`) && (!path || node.textContent.includes(path)));
  assert.ok(option, `Missing exact ${version} ${path}`); select.value = option.value; await select.dispatch('change');
};
function harness(initial, apiOther = async () => ({})) {
  let rows = initial; const store = new Map(), confirmations = [], calls = [];
  const body = element('body');
  body.append(...['modules-content', 'templates-content', 'sources-content', 'creator-content', 'detail-content', 'packs-asset-tabs', 'modules-asset-tabs', 'templates-asset-tabs', 'nav-count', 'nav-modules-count', 'nav-templates-count'].map(id => element('div', { id })), element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })), element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name }))));
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, val) => store.set(key, val) };
  globalThis.window = { addEventListener() {} }; globalThis.location = { origin: 'http://127.0.0.1:32100' };
  const state = { language: 'en', view: 'modules', instances: [], reviews: new Map(), environmentSelection: {} };
  const ctx = { state, api: async (path, data) => { calls.push([path, data]); if (path === '/api/paths/known') return { objects: rows }; return apiOther(path, data); }, el: element,
    button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title),
    pill: title => element('span', {}, title), t: key => key, toast() {}, date: String, display: String,
    definition: pairs => element('dl', {}, pairs.flatMap(([key, value]) => [element('dt', {}, key), element('dd', {}, String(value ?? ''))])),
    errorContents: error => [element('p', {}, error.message)], current() {}, idOf: row => row.instanceId,
    endpoint: (id, action) => `/api/instances/${id}/${action}`, operationFor() {}, exitUnconfirmed() {}, refresh: async () => {}, renderDetail() {}, navigate() {}, selectInstance() {}, openImport() {}, replaceInstance() {},
    confirmDialog: options => confirmations.push(options),
  };
  const ui = createAdvancedUi(ctx);
  return { body, ui, state, store, confirmations, calls, setRows: value => { rows = value; } };
}

for (const kind of ['module', 'template']) test(`${kind} cards group versions and directory copies, preserve selection across refresh and remove only the chosen directory`, async () => {
  const rows = [{ kind, id: 'project', version: '1.0.0', title: 'Old title', path: '/old' }, { kind, id: 'project', version: '2.0.0', title: 'New title', path: '/new' }, { kind, id: 'project', version: '2.0.0', title: 'Copy title', path: '/copy' }];
  const scene = harness(rows); scene.state.view = kind === 'module' ? 'modules' : 'templates'; await scene.ui.loadKnown();
  const list = () => scene.body.querySelector(kind === 'module' ? '#modules-list' : '#templates-list');
  const cards = () => list().querySelectorAll('article');
  assert.equal(cards().length, 1); assert.equal(cards()[0].querySelector('select').options.length, 3);
  assert.equal(scene.body.querySelector(kind === 'module' ? '#nav-modules-count' : '#nav-templates-count').textContent, '1');
  await choose(cards()[0], '1.0.0', '/old'); assert.match(cards()[0].querySelector('h3').textContent, /Old title/);
  scene.setRows([...rows, { ...rows[1], version: '3.0.0', title: 'Future title', path: '/future' }]); await scene.ui.loadKnown();
  assert.equal(cards()[0].querySelector('select').options.length, 4); assert.match(cards()[0].querySelector('h3').textContent, /Old title/);
  await byText(cards()[0], 'delete').dispatch('click'); assert.match(scene.confirmations[0].message, /1\.0\.0.*\/old/); scene.confirmations[0].onConfirm();
  assert.equal(cards().length, 1); assert.equal(cards()[0].querySelector('select').value, ''); assert.ok(cards()[0].querySelectorAll('button').every(button => button.disabled));
  const saved = JSON.parse(scene.store.get('world-hub.launcher.deleted-objects')); assert.equal(saved.length, 1); assert.ok(saved[0].startsWith('asset:')); assert.ok(!saved.includes(`${kind}:project`));
  await scene.ui.loadKnown(); assert.equal(cards()[0].querySelector('select').options.length, 4); // Placeholder + 3 surviving versions/directories.
  await choose(cards()[0], '2.0.0', '/copy'); assert.match(cards()[0].querySelector('h3').textContent, /Copy title/); assert.equal(Boolean(byText(cards()[0], 'delete').disabled), false);
  assert.deepEqual((kind === 'module' ? scene.ui.getModules() : scene.ui.getTemplates()).map(row => row.path).sort(), ['/copy', '/future', '/new']);
});

test('selected template scaffolding sends only that exact old directory, never the newest version', async () => {
  const rows = [{ kind: 'template', id: 'project', version: '1.0.0', path: '/old' }, { kind: 'template', id: 'project', version: '2.0.0', path: '/new' }];
  const scene = harness(rows, async (path, request) => {
    if (path === '/api/templates/inspect') return { inspection: { manifest: { id: 'project', version: request.directory === '/old' ? '1.0.0' : '2.0.0', parameters: [] } } };
    throw new Error(`Unexpected ${path}`);
  });
  scene.state.view = 'templates'; await scene.ui.loadKnown(); await choose(scene.body.querySelector('.template-card'), '1.0.0', '/old');
  await byText(scene.body.querySelector('.template-card'), 'Scaffold Pack').dispatch('click');
  assert.deepEqual(scene.calls.filter(([path]) => path === '/api/templates/inspect'), [['/api/templates/inspect', { directory: '/old' }]]);
  assert.match(scene.body.querySelector('.template-scaffold-dialog').textContent, /v1\.0\.0/);
});

test('source project card downloads the selected exact version entry and receipt', async () => {
  let registered; const scene = harness([], async (path, request) => {
    if (path === '/api/sources') return { sources: registered ? [registered] : [], conflicts: [] };
    if (path.endsWith('/save')) { registered = { ...request, id: 'source.one' }; return { source: registered }; }
    if (path.endsWith('/inspect')) return { sourceId: 'source.one', receiptId: 'receipt.one', digest: 'a'.repeat(64), index: { entries: ['1.0.0', '2.0.0'].map((version, i) => ({ kind: 'module', id: 'project', entryId: `entry-${i}`, title: `Version ${version}`, version, sha256: String(i).repeat(64) })) } };
    if (path.endsWith('/fetch')) return { operationId: 'fetch-one' };
    if (path === '/api/operations/fetch-one') return { operation: { state: 'succeeded', result: { kind: 'module', id: 'project', version: '1.0.0', directory: '/downloaded' } } };
    return {};
  });
  scene.ui.navigate('sources'); const root = scene.body.querySelector('#sources-content');
  const add = root.querySelectorAll('form').find(form => form.elements.name); add.elements.name.value = 'test'; add.elements.source.value = 'https://source.example/index.json'; await add.dispatch('submit');
  const browse = root.querySelectorAll('form').find(form => form.elements.source?.tagName === 'select'); browse.elements.source.value = registered.source; await browse.dispatch('submit');
  assert.equal(root.querySelectorAll('.source-card').length, 1); await choose(root.querySelector('.source-card'), '1.0.0');
  assert.match(root.querySelector('.source-card').querySelector('h3').textContent, /1\.0\.0/);
  await byText(root, 'Verify and fetch to cache').dispatch('click'); const dialog = scene.body.querySelector('#advanced-action-dialog'), check = dialog.querySelector('[type=checkbox]');
  check.checked = true; await check.dispatch('change'); await byText(dialog, 'Confirm review and continue').dispatch('click');
  assert.deepEqual(scene.calls.find(([path]) => path.endsWith('/fetch'))[1], { sourceId: 'source.one', receiptId: 'receipt.one', entryId: 'entry-0' });
});

test('pack project cards retain independent instances, exact selected lifecycle operations, and unavailable selection disables all actions', async () => {
  // Exercise the production rendering functions in an inert document, excluding
  // boot/network. No alternate implementation of the card logic is used.
  const source = (await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('void boot();', '');
  const body = element('body', {}, ['packs-list', 'search', 'nav-count', 'collection-count'].map(id => element(id === 'search' ? 'input' : 'div', { id })));
  const actions = [], context = { initialLanguage: () => 'en', translate: (lang, key) => key, groupAssets, createAssetVersionSelection, renderAssetVersionSelector, Node: Element,
    document: { body, querySelector: selector => body.querySelector(selector), createElement: tag => element(tag), createTextNode: text => new Element('#text', text) },
    createIcon: () => element('span'), renderSquareArt: () => element('div'), URL, URLSearchParams, Date, actions,
  };
  runInNewContext(source + `\nadvanced={label:()=> 'Storage',renderAssetTabs(){}};reviewInstance=(id,kind)=>actions.push([kind,id]);selectInstance=id=>actions.push(['detail',id]);stopInstance=id=>actions.push(['stop',id]);confirmDeleteInstance=row=>actions.push(['delete',idOf(row)]);globalThis.expose={state,renderPacks,stats};`, context);
  const { state, renderPacks, stats } = context.expose;
  state.online = true; state.lastRefresh = new Date().toISOString();
  state.instances = [{ instanceId: 'old-run', pack: { id: 'project', title: 'Old', version: '1.0.0' }, status: { state: 'running' } }, { instanceId: 'new-run', pack: { id: 'project', title: 'New', version: '2.0.0' }, status: { state: 'stopped' } }, { instanceId: 'new-copy', pack: { id: 'project', title: 'Copy', version: '2.0.0' }, status: { state: 'failed' } }];
  renderPacks(); const card = () => body.querySelector('[data-pack-project]');
  assert.equal(body.querySelectorAll('[data-pack-project]').length, 1); assert.equal(card().querySelector('select').options.length, 3);
  assert.equal(body.querySelector('#nav-count').textContent, '1'); assert.match(body.querySelector('#collection-count').textContent, /1 projects.*3 independent instances/);
  assert.equal(stats()[0].querySelector('strong').textContent, '3'); assert.equal(stats()[1].querySelector('strong').textContent, '1');
  await choose(card(), '1.0.0', 'old-run'); await byText(card(), 'stop').dispatch('click'); assert.deepEqual(structuredClone(actions), [['stop', 'old-run']]);
  state.instances.push({ instanceId: 'future-run', pack: { id: 'project', title: 'Future', version: '3.0.0' }, status: { state: 'stopped' } }); renderPacks(); assert.equal(card().querySelector('h3').textContent, 'Old');
  state.instances = state.instances.filter(row => row.instanceId !== 'old-run'); renderPacks(); assert.equal(card().querySelector('select').value, ''); assert.ok(card().querySelectorAll('button').every(button => button.disabled));
  await choose(card(), '2.0.0', 'new-copy'); await byText(card(), 'start').dispatch('click'); await byText(card(), 'delete').dispatch('click');
  assert.deepEqual(structuredClone(actions), [['stop', 'old-run'], ['start', 'new-copy'], ['delete', 'new-copy']]);
});
