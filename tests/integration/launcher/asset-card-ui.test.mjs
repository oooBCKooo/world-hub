import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Element, element } from './ui-dom.mjs';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';
import { groupAssets, createAssetVersionSelection, renderAssetVersionSelector } from '../../../tools/launcher/public/asset-versions.mjs';
import { createPackParadigmUi, presentedPack, packTypeOf, lifecyclePolicyOf } from '../../../tools/launcher/public/pack-paradigm-ui.mjs';
import { renderPackLineage } from '../../../tools/launcher/public/pack-lineage-ui.mjs';
import { localizeErrorMessage } from '../../../tools/launcher/public/i18n.mjs';
const paradigmDependencies={createPackParadigmUi,presentedPack,packTypeOf,lifecyclePolicyOf,renderPackLineage,localizeErrorMessage};

const byText = (root, title) => {
  let btn = root.querySelectorAll('button').find(node => node.textContent === title || node.textContent.includes(title));
  if (!btn) {
    const dialogButtons = globalThis.document?.body?.querySelectorAll('.dialog button') ?? [];
    btn = [...dialogButtons].reverse().find(node => node.textContent === title || node.textContent.includes(title));
  }
  return btn;
};
const selectOf = async (card) => {
  let select = card.querySelector('.asset-version-select');
  if (!select) {
    const main = card.querySelector('.pack-card-main');
    if (main) {
      await main.dispatch('click');
      const dialogs = globalThis.document.body.querySelectorAll('.dialog .asset-version-select');
      select = dialogs.at(-1) || card.querySelector('.asset-version-select');
    }
  }
  return select;
};
const choose = async (card, version, path) => {
  const select = await selectOf(card);
  const option = select.options.find(node => node.textContent.includes(`v${version}`) && (!path || node.textContent.includes(path) || node.attributes?.title?.includes(path) || node.value?.includes(path)));
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
  assert.equal(cards().length, 1); assert.equal((await selectOf(cards()[0])).options.length, 3);
  assert.equal(scene.body.querySelector(kind === 'module' ? '#nav-modules-count' : '#nav-templates-count').textContent, '1');
  await choose(cards()[0], '1.0.0', '/old'); assert.match(cards()[0].querySelector('h3').textContent, /Old title/);
  scene.setRows([...rows, { ...rows[1], version: '3.0.0', title: 'Future title', path: '/future' }]); await scene.ui.loadKnown();
  assert.equal((await selectOf(cards()[0])).options.length, 4); assert.match(cards()[0].querySelector('h3').textContent, /Old title/);
  await byText(cards()[0], 'delete').dispatch('click'); assert.match(scene.confirmations[0].message, /1\.0\.0.*\/old/); scene.confirmations[0].onConfirm();
  assert.equal(cards().length, 1); assert.match(cards()[0].querySelector('h3').textContent, /Future title/); assert.notEqual((await selectOf(cards()[0])).value, ''); assert.ok(cards()[0].querySelector('.pack-card-main'));
  assert.match(cards()[0].textContent, /automatically|自动/i);
  const saved = JSON.parse(scene.store.get('world-hub.launcher.deleted-objects')); assert.equal(saved.length, 1); assert.ok(saved[0].startsWith('asset:')); assert.ok(!saved.includes(`${kind}:project`));
  await scene.ui.loadKnown(); assert.equal((await selectOf(cards()[0])).options.length, 3); // Three surviving versions/directories, no unavailable placeholder.
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
  await (byText(scene.body.querySelector('.template-card'), 'Use') || byText(scene.body.querySelector('.template-card'), 'Scaffold Pack')).dispatch('click');
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

test('pack project cards retain independent instances and fallback actions address the available exact instance', async () => {
  // Exercise the production rendering functions in an inert document, excluding
  // boot/network. No alternate implementation of the card logic is used.
  const source = (await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('void boot();', '');
  const body = element('body', {}, ['packs-list', 'search', 'nav-count', 'collection-count'].map(id => element(id === 'search' ? 'input' : 'div', { id })));
  const actions = [], context = { ...paradigmDependencies, initialLanguage: () => 'en', translate: (lang, key) => key, groupAssets, createAssetVersionSelection, renderAssetVersionSelector, Node: Element,
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
  await choose(card(), '1.0.0', 'old-run'); await card().querySelector('.pack-card-main').dispatch('click'); assert.deepEqual(structuredClone(actions), [['detail', 'old-run']]);
  state.instances.push({ instanceId: 'future-run', pack: { id: 'project', title: 'Future', version: '3.0.0' }, status: { state: 'stopped' } }); renderPacks(); assert.equal(card().querySelector('h3').textContent, 'Old');
  state.instances = state.instances.filter(row => row.instanceId !== 'old-run'); renderPacks(); assert.notEqual(card().querySelector('select').value, ''); assert.equal(card().querySelector('h3').textContent, 'Future');
  assert.ok(card().querySelector('.pack-card-main')); assert.match(card().textContent, /automatically|自动/i);
  await card().querySelector('.pack-card-main').dispatch('click'); assert.deepEqual(structuredClone(actions), [['detail', 'old-run'], ['detail', 'future-run']]);
  await choose(card(), '2.0.0', 'new-copy'); await card().querySelector('.pack-card-main').dispatch('click');
  assert.deepEqual(structuredClone(actions), [['detail', 'old-run'], ['detail', 'future-run'], ['detail', 'new-copy']]);
});

test('pack, module, and template cards omit footers and show special pending import card that triggers openImport', async () => {
  const source = (await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('void boot();', '');
  const body = element('body', {}, ['packs-list', 'search', 'nav-count', 'collection-count'].map(id => element(id === 'search' ? 'input' : 'div', { id })));
  const imports = [], context = { ...paradigmDependencies, initialLanguage: () => 'en', translate: (lang, key) => key, groupAssets, createAssetVersionSelection, renderAssetVersionSelector, Node: Element,
    document: { body, querySelector: selector => body.querySelector(selector), createElement: tag => element(tag), createTextNode: text => new Element('#text', text) },
    createIcon: () => element('span'), renderSquareArt: () => element('div'), URL, URLSearchParams, Date,
    imports
  };
  runInNewContext(source + `\nopenImport=path=>imports.push(path);advanced={label:()=> 'Storage',renderAssetTabs(){}};tasks={getPendingPacks:()=>[{path:'/downloaded/my-pack',title:'Downloaded Pack',id:'pack-dl',version:'1.2.0'}]};globalThis.expose={state,renderPacks};`, context);
  const { state, renderPacks } = context.expose;
  state.online = true; state.lastRefresh = new Date().toISOString();
  state.instances = [{ instanceId: 'live-1', pack: { id: 'live-pack', title: 'Live Pack', version: '1.0.0' }, status: { state: 'running' } }];

  renderPacks();

  // Assert no card on packs page has .pack-card-footer
  assert.equal(body.querySelectorAll('.pack-card-footer').length, 0);

  // Assert special pending card exists
  const pendingCard = body.querySelector('.pack-card-pending-import');
  assert.ok(pendingCard, 'Pending pack card should be rendered');
  assert.match(pendingCard.textContent, /Downloaded Pack/);
  assert.match(pendingCard.textContent, /v1\.2\.0/);

  // Assert clicking pending card triggers openImport with the pack path
  await pendingCard.querySelector('.pack-card-main').dispatch('click');
  assert.deepEqual(imports, ['/downloaded/my-pack']);

  // Assert modules and templates also have no footers
  const scene = harness([{ kind: 'module', id: 'm1', version: '1.0.0', path: '/mod' }, { kind: 'template', id: 't1', version: '1.0.0', path: '/tpl' }]);
  scene.state.view = 'modules';
  await scene.ui.loadKnown();
  assert.equal(scene.body.querySelectorAll('.pack-card-footer').length, 0);

  scene.state.view = 'templates';
  await scene.ui.loadKnown();
  assert.equal(scene.body.querySelectorAll('.pack-card-footer').length, 0);
});

test('global hub card click opens Global Hub detail page with dedicated controls and tabs', async () => {
  const source = (await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('void boot();', '');
  const body = element('body', {}, [
    'packs-list', 'search', 'nav-count', 'collection-count',
    'detail-heading', 'detail-actions', 'detail-notice', 'detail-content',
    'tab-status', 'tab-modules', 'tab-dynamic-modules', 'tab-logs', 'tab-storage', 'tab-details',
    'view-packs', 'view-detail', 'breadcrumb'
  ].map(id => element(id === 'search' ? 'input' : id.startsWith('tab-') ? 'button' : 'div', { id, ...(id.startsWith('tab-') ? { 'data-tab': id.replace('tab-', '') } : {}) })));

  const operations = [];
  const context = {
    ...paradigmDependencies, initialLanguage: () => 'en', translate: (lang, key) => key, groupAssets, createAssetVersionSelection, renderAssetVersionSelector, Node: Element,
    document: { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), createElement: tag => element(tag), createTextNode: text => new Element('#text', text) },
    createIcon: () => element('span'), renderSquareArt: () => element('div'), URL, URLSearchParams, Date,
    history: { pushState() {}, replaceState() {} },
    location: { pathname: '/', search: '', hash: '' },
    window: { scrollTo() {} }, operations
  };
  runInNewContext(source + `\napi=async()=>({instance:{instanceId:'inst-1',pack:{id:'pack-1',title:'Pack One',version:'1.0.0'},status:{state:'running'}}});advanced={label:()=> 'Storage',renderAssetTabs(){},renderDynamicModules:()=>[el('p',{},'Pack live modules')],compose:()=>operations.push(['compose']),managePrograms:()=>operations.push(['manage-programs'])};globalDynamic={render:()=>[el('p',{},'Global live sessions')]};globalThis.expose={state,renderPacks,selectInstance,renderDetail,changeTab,hubOperation};`, context);
  const { state, renderPacks, selectInstance, renderDetail, changeTab } = context.expose;
  state.online = true; state.lastRefresh = new Date().toISOString();
  state.hubsObservedAt = new Date().toISOString();
  state.hubs = [{ id: 'default', state: 'running', url: 'http://127.0.0.1:4000', workbenchUrl: 'http://127.0.0.1:4000/workbench', managementUrl: 'http://127.0.0.1:4000/topology' }];
  state.instances = [{ instanceId: 'inst-1', pack: { id: 'pack-1', title: 'Pack One', version: '1.0.0' }, status: { state: 'running' } }];

  renderPacks();

  // Find Global Hub card
  const hubCard = body.querySelector('[data-hub-card="default"]');
  assert.ok(hubCard, 'Global Hub card should be rendered');
  assert.match(hubCard.textContent, /launcher\.default/);
  assert.match(hubCard.textContent, /v0\.19\.0/);
  assert.match(hubCard.textContent, /0\.1\.0/);
  assert.match(hubCard.textContent, /Kernel v0\.19\.0/);
  assert.match(hubCard.textContent, /Source version v0\.1\.0/);
  state.globalComposition = { id: 'global.hub.assembly', version: '0.1.3', lineage: { format: 'world-hub.pack-lineage/v1', kind: 'customized', base: { id: 'global.hub.assembly', version: '0.1.0' }, revision: 3 } };
  renderPacks();
  const customizedGlobal = body.querySelector('[data-hub-card="default"]');
  assert.match(customizedGlobal.textContent, /Source baseline v0\.1\.0.*Local customization v0\.1\.3.*Rev 3/);
  assert.match(customizedGlobal.textContent, /Kernel v0\.19\.0/);


  // Find Pack card
  const packCard = body.querySelector('[data-pack-project="pack-1"]');
  assert.ok(packCard, 'Pack card should be rendered');
  assert.match(packCard.textContent, /1\.0\.0/);
  assert.match(packCard.textContent, /Source version|来源版本/);
  assert.match(packCard.textContent, /Kernel v0\.19\.0/);

  const packFacts = packCard.querySelector('.pack-facts');
  assert.ok(packFacts, 'Pack facts should be rendered in pack card media');

  // Verify stopped pack shows 0 / <total> instead of unknown
  state.instances = [{ instanceId: 'inst-1', pack: { id: 'pack-1', title: 'Pack One', version: '1.0.0', components: [{}, {}, {}] }, status: { state: 'stopped' } }];
  renderPacks();
  const stoppedCard = body.querySelector('[data-pack-project="pack-1"]');
  const stoppedFacts = stoppedCard.querySelector('.pack-facts');
  assert.match(stoppedFacts.textContent, /3/);
  assert.match(stoppedFacts.textContent, /0 \/ 3/);

  const hubFacts = hubCard.querySelector('.pack-facts');
  assert.ok(hubFacts, 'Global Hub facts should be rendered');
  const dts = [...hubFacts.querySelectorAll('dt')].map(node => node.textContent);
  assert.ok(dts.includes('modules') || dts.includes('Modules') || dts.includes('模块'), 'Global Hub card should include modules fact');
  assert.ok(dts.includes('communication') || dts.includes('Communication') || dts.includes('通信'), 'Global Hub card should include communication fact');

  // Click Global Hub card to select launcher.default
  await hubCard.querySelector('.pack-card-main').dispatch('click');
  assert.equal(state.selected, 'launcher.default');
  assert.equal(state.view, 'detail');

  // Verify Global Hub Detail heading
  const heading = body.querySelector('#detail-heading');
  assert.match(heading.textContent, /Global Hub|defaultHub/);
  assert.match(heading.textContent, /launcher\.default/);
  assert.match(heading.textContent, /Kernel v0\.19\.0/);

  // Both scopes use the same six detail tabs.
  assert.equal(Boolean(body.querySelector('#tab-logs').hidden), false);
  assert.equal(Boolean(body.querySelector('#tab-storage').hidden), false);
  assert.equal(Boolean(body.querySelector('#tab-status').hidden), false);
  assert.equal(Boolean(body.querySelector('#tab-modules').hidden), false);
  assert.equal(Boolean(body.querySelector('#tab-dynamic-modules').hidden), false);
  assert.equal(Boolean(body.querySelector('#tab-details').hidden), false);

  // Verify actions: Stop Hub, Workbench link, Static Assembly
  const actions = body.querySelector('#detail-actions');
  const actionNodes = [...actions.querySelectorAll('button'), ...actions.querySelectorAll('a')];
  assert.ok(actionNodes.length > 0, `No actions found: ${actions.textContent}`);
  assert.ok(actionNodes.some(n => n.textContent.includes('Stop Hub') || n.textContent.includes('stopHub')));
  assert.ok(actionNodes.some(n => n.textContent.includes('Workbench') || n.textContent.includes('通信工作台')));
  assert.ok(actionNodes.some(n => n.textContent.includes('staticAssembly') || n.textContent.includes('静态装配')));
  assert.ok(!actionNodes.some(n => n.textContent.includes('Add Module') || n.textContent.includes('接入新模块')));

  // Verify Tab 1 (status) content
  const statusContent = body.querySelector('#detail-content');
  assert.match(statusContent.textContent, /ws:\/\/127\.0\.0\.1:4000\/bridge/);

  // Switch to Tab 2 (modules/programs)
  changeTab('modules');
  const programsContent = body.querySelector('#detail-content');
  assert.match(programsContent.textContent, /Independent Local Programs|独立本地程序/);

  changeTab('dynamic-modules');
  assert.equal(state.tab, 'dynamic-modules');
  assert.equal(body.querySelector('#detail-content').textContent, 'Global live sessions');
  assert.equal(body.querySelector('#tab-dynamic-modules').attributes['aria-selected'], 'true');
  assert.equal(body.querySelector('#detail-content').attributes['aria-labelledby'], 'tab-dynamic-modules');

  // Switch to Tab 3 (details)
  changeTab('details');
  const detailsContent = body.querySelector('#detail-content');
  assert.match(detailsContent.textContent, /launcher\.default/);
  assert.match(detailsContent.textContent, /WebSocket/);
  assert.match(detailsContent.textContent, /trusted-local/);

  // Select normal pack instance and verify tabs are restored
  await selectInstance('inst-1');
  assert.equal(state.selected, 'inst-1');
  assert.equal(body.querySelector('#tab-logs').hidden, false);
  assert.equal(body.querySelector('#tab-storage').hidden, false);
  assert.match(body.querySelector('#detail-heading').textContent, /Kernel v0\.19\.0/);
  changeTab('dynamic-modules');
  assert.equal(body.querySelector('#detail-content').textContent, 'Pack live modules');
});

test('pending review import pack card can be cancelled and dismissed from card', async () => {
  const source = (await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('void boot();', '');
  const body = element('body', {}, ['packs-list', 'search', 'nav-count', 'collection-count', 'toast'].map(id => element(id === 'search' ? 'input' : 'div', { id })));
  const dismissCalls = [], confirmations = [];
  let pendingList = [{ path: '/downloaded/my-pack', title: 'Downloaded Pack', id: 'pack-dl', version: '1.2.0', operation: { id: 'op-1' } }];
  const context = {
    ...paradigmDependencies, initialLanguage: () => 'en', translate: (lang, key) => key, groupAssets, createAssetVersionSelection, renderAssetVersionSelector, Node: Element,
    document: { body, querySelector: selector => body.querySelector(selector), createElement: tag => element(tag), createTextNode: text => new Element('#text', text) },
    createIcon: () => element('span'), renderSquareArt: () => element('div'), URL, URLSearchParams, Date,
    setTimeout: (fn) => fn(), clearTimeout: () => {},
    dismissCalls,
    pendingList
  };
  runInNewContext(source + `\nadvanced={label:()=> 'Storage',renderAssetTabs(){}};tasks={getPendingPacks:()=>pendingList,isPendingPack:p=>pendingList.some(x=>x.path===p),dismissPendingPack:(p,id)=>{dismissCalls.push([p,id]);pendingList.length=0;}};\nglobalThis.expose={state,renderPacks};`, context);
  const { state, renderPacks } = context.expose;
  state.online = true; state.lastRefresh = new Date().toISOString();
  state.instances = [];

  renderPacks();

  const pendingCard = body.querySelector('.pack-card-pending-import');
  assert.ok(pendingCard, 'Pending pack card should be rendered');
  assert.match(pendingCard.textContent, /Kernel v0\.19\.0/);
  const cancelBtn = pendingCard.querySelector('.pack-card-cancel-btn');
  assert.ok(cancelBtn, 'Cancel button should be present on pending card');

  // Click cancel button on card
  await cancelBtn.dispatch('click');
  const confirmModal = body.querySelector('.confirm-dialog');
  assert.ok(confirmModal, 'Confirm dialog should be opened');
  assert.match(confirmModal.textContent, /Downloaded Pack/);

  // Click confirm button in modal
  const confirmActionBtn = confirmModal.querySelectorAll('button').find(b => b.className?.includes('button-danger'));
  assert.ok(confirmActionBtn, 'Confirm button should exist');
  await confirmActionBtn.dispatch('click');
  assert.deepEqual(structuredClone(dismissCalls), [['/downloaded/my-pack', 'op-1']]);

  // Re-render packs after dismissal
  renderPacks(true);
  assert.equal(body.querySelector('.pack-card-pending-import'), null);
});

test('task-ui tracks pending packs and supports dismissing them', async () => {
  const { createTaskUi } = await import('../../../tools/launcher/public/task-ui.mjs');
  const store = new Map();
  const body = element('body');
  const topbarActions = element('div', { class: 'topbar-actions' });
  body.append(topbarActions);
  const origDoc = globalThis.document;
  const origStorage = globalThis.localStorage;
  try {
    globalThis.document = {
      body,
      querySelector: selector => selector === '.topbar-actions' ? topbarActions : body.querySelector(selector),
      querySelectorAll: selector => body.querySelectorAll(selector),
      createElement: tag => element(tag),
      createTextNode: text => new Element('#text', text)
    };
    globalThis.localStorage = {
      getItem: key => store.get(key) ?? null,
      setItem: (key, val) => store.set(key, val),
      removeItem: key => store.delete(key)
    };
    const state = {
      language: 'zh',
      instances: [],
      auth: { token: 't1' }
    };
    let pendingCounts = [];
    const op = {
      id: 'op-pack-1',
      kind: 'fetch-source',
      state: 'succeeded',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date(Date.now() - 1000).toISOString(),
      result: {
        kind: 'pack',
        id: 'sample-pack',
        version: '1.0.0',
        directory: '/cache/sample-pack',
        entry: { id: 'sample-pack', title: 'Sample Pack', version: '1.0.0' }
      }
    };
    const taskUi = createTaskUi({
      state,
      api: async () => ({ operations: [op] }),
      el: element,
      button: (title, action, className) => element('button', { class: className, onclick: action }, title),
      toast() {},
      date: () => '',
      selectInstance() {},
      openImport() {},
      openCreator() {},
      createIcon: () => element('span'),
      onPendingChange: count => pendingCounts.push(count)
    });

    await taskUi.check();
    assert.equal(taskUi.isPendingPack('/cache/sample-pack'), true);
    assert.equal(taskUi.getPendingPacks().length, 1);
    assert.equal(taskUi.getPendingPacks()[0].path, '/cache/sample-pack');

    // Dismiss the pending pack
    taskUi.dismissPendingPack('/cache/sample-pack', 'op-pack-1');
    assert.equal(taskUi.isPendingPack('/cache/sample-pack'), false);
    assert.equal(taskUi.getPendingPacks().length, 0);

    // Verify dismissal persisted to localStorage
    const saved = JSON.parse(store.get('world-hub.launcher.dismissed-pending-packs'));
    assert.ok(saved['/cache/sample-pack']);
    assert.equal(saved['/cache/sample-pack'].operationId, 'op-pack-1');
  } finally {
    globalThis.document = origDoc;
    globalThis.localStorage = origStorage;
  }
});


test('source cards retain the same artifact on index refresh, then automatically fall back to a surviving entry with a fresh exact download review', async () => {
  let digest = 'a'.repeat(64), receiptId = 'receipt.one', versions = ['1.0.0', '2.0.0'];
  const sourceRow = { id: 'source.one', source: 'https://source.example/index.json', name: 'Test source', enabled: true };
  const scene = harness([], async (path, request) => {
    if (path === '/api/sources') return { sources: [sourceRow], conflicts: [] };
    if (path === '/api/sources/inspect') return { sourceId: sourceRow.id, receiptId, digest, index: { entries: versions.map(version => ({ kind: 'module', id: 'project', entryId: `entry-${version}`, title: `Artifact ${version}`, version, sha256: version[0].repeat(64), license: 'MIT' })) } };
    if (path === '/api/sources/fetch') return { operationId: 'fetch-fallback' };
    if (path === '/api/operations/fetch-fallback') return { operation: { state: 'succeeded', result: { kind: 'module', id: 'project', version: '3.0.0', directory: '/downloaded-fallback' } } };
    return {};
  });
  scene.state.view = 'sources'; scene.ui.navigate('sources'); await new Promise(done => setImmediate(done));
  const root = scene.body.querySelector('#sources-content');
  const inspect = async () => { const form = root.querySelectorAll('form').find(row => row.elements.source?.tagName === 'select'); await form.dispatch('submit'); };
  await inspect(); await choose(root.querySelector('.source-card'), '1.0.0');
  const reviewsBefore = scene.calls.filter(([path]) => path.endsWith('/fetch')).length;
  await root.querySelector('.source-card').querySelector('.pack-card-main').dispatch('click');
  const oldDetails = scene.body.querySelector('.source-details-dialog'); assert.equal(oldDetails.open, true);
  digest = 'b'.repeat(64); receiptId = 'receipt.two'; versions.push('3.0.0'); await inspect();
  assert.equal(oldDetails.open, false, 'A refreshed source index closes the old exact artifact detail instead of retargeting its actions');
  assert.match(root.querySelector('.source-card').querySelector('h3').textContent, /Artifact 1.0.0/, 'The same source artifact survives a new index digest even when a newer version exists');
  assert.match(root.querySelector('.source-card').textContent, /automatically|自动/i, 'Source cards expose the fallback notice despite version-only labels');
  digest = 'c'.repeat(64); receiptId = 'receipt.three'; versions = ['2.0.0', '3.0.0']; await inspect();
  const card = root.querySelector('.source-card'); assert.match(card.querySelector('h3').textContent, /Artifact 3.0.0/); assert.match(card.textContent, /automatically|自动/i);
  assert.equal(scene.calls.filter(([path]) => path.endsWith('/fetch')).length, reviewsBefore, 'A fallback selection is never download or execution consent');
  await root.querySelector('.source-card').querySelector('.pack-card-main').dispatch('click'); await byText(root, 'Verify and fetch to cache').dispatch('click');
  const review = scene.body.querySelector('#advanced-action-dialog'), check = review.querySelector('[type=checkbox]'); assert.equal(Boolean(check.checked), false); assert.match(review.textContent, /Artifact 3.0.0/); assert.doesNotMatch(review.textContent, /Artifact 1.0.0/);
  check.checked = true; await check.dispatch('change'); await byText(review, 'Confirm review and continue').dispatch('click');
  assert.deepEqual(scene.calls.find(([path]) => path.endsWith('/fetch'))[1], { sourceId: 'source.one', receiptId: 'receipt.three', entryId: 'entry-3.0.0' });
  assert.ok(scene.calls.every(([path]) => !/\/(?:start|restart)$/.test(path)));
});

for (const kind of ['module', 'template']) test(`${kind} fallback prefers an updated artifact at the remembered exact path over an unrelated newer version`, async () => {
  const rows = [{ kind, id: 'project', version: '1.0.0', title: 'Remembered original', path: '/remembered' }, { kind, id: 'project', version: '9.0.0', title: 'Unrelated latest', path: '/latest' }];
  const view = harness(rows); view.state.view = kind === 'module' ? 'modules' : 'templates'; await view.ui.loadKnown();
  const card = () => view.body.querySelector(kind === 'module' ? '.module-card' : '.template-card'); await choose(card(), '1.0.0', '/remembered');
  view.setRows([{ ...rows[0], version: '1.0.1', title: 'Updated same path' }, rows[1]]); await view.ui.loadKnown();
  assert.match(card().querySelector('h3').textContent, /Updated same path/); assert.match(card().textContent, /automatically|自动/i); const select = await selectOf(card()); assert.match(select.options.find(option => option.value === select.value)?.textContent ?? '', /1.0.1/);
  const detail = view.body.querySelector(kind === 'module' ? '.module-detail-dialog' : '.template-detail-dialog'); assert.equal(detail.querySelectorAll('[data-asset-auto-selected]').length, 1, 'The exact artifact detail shows one fallback notice through its version selector');
  await byText(card(), 'delete').dispatch('click'); assert.match(view.confirmations[0].message, /1.0.1.*\/remembered/);
  assert.ok(view.calls.every(([path]) => !/\/(?:start|restart|instantiate)$/.test(path)));
});


for (const kind of ['module', 'template']) test(`${kind} inventory refresh closes stale exact details but keeps unrelated dialogs and unchanged details`, async () => {
  const rows = [{ kind, id: 'project', version: '1.0.0', title: 'Original', path: '/remembered' }];
  const view = harness(rows); view.state.view = kind === 'module' ? 'modules' : 'templates'; await view.ui.loadKnown();
  const card = () => view.body.querySelector(kind === 'module' ? '.module-card' : '.template-card');
  await card().querySelector('.pack-card-main').dispatch('click');
  const detail = view.body.querySelector(kind === 'module' ? '.module-detail-dialog' : '.template-detail-dialog'); assert.equal(detail.open, true);
  const unrelated = element('dialog', { class: 'settings-editor' }); view.body.append(unrelated); unrelated.showModal();
  view.setRows([...rows, { ...rows[0], path: '/latest', version: '2.0.0' }]); await view.ui.loadKnown(); assert.equal(detail.open, true, 'Adding a newer option cannot invalidate the still-existing inspected artifact');
  view.setRows([{ ...rows[0], path: '/latest', version: '2.0.0' }]); await view.ui.loadKnown(); assert.equal(detail.open, false); assert.equal(unrelated.open, true);
  assert.ok(card().querySelector('.pack-card-main')); assert.match(card().querySelector('h3').textContent, /Original/);
  assert.ok(view.calls.every(([path]) => !/\/(?:start|restart|instantiate)$/.test(path)));
});

test('a source inventory fallback never silently retargets a pending exact download review', async () => {
  let digest = 'a'.repeat(64), version = '1.0.0';
  const sourceRow = { id: 'source.pending', source: 'https://pending.example/index.json', name: 'Pending source', enabled: true };
  const view = harness([], async path => {
    if (path === '/api/sources') return { sources: [sourceRow], conflicts: [] };
    if (path === '/api/sources/inspect') return { sourceId: sourceRow.id, receiptId: `receipt-${version}`, digest, index: { entries: [{ kind: 'module', id: 'project', entryId: `entry-${version}`, title: `Exact ${version}`, version, sha256: version[0].repeat(64), license: 'MIT' }] } };
    return {};
  });
  view.state.view = 'sources'; view.ui.navigate('sources'); await new Promise(done => setImmediate(done));
  const root = view.body.querySelector('#sources-content');
  const inspect = async () => { const form = root.querySelectorAll('form').find(row => row.elements.source?.tagName === 'select'); await form.dispatch('submit'); };
  await inspect(); await root.querySelector('.source-card').querySelector('.pack-card-main').dispatch('click'); await byText(root, 'Verify and fetch to cache').dispatch('click');
  const review = view.body.querySelector('#advanced-action-dialog'); assert.equal(review.open, true); assert.match(review.textContent, /Exact 1.0.0/);
  digest = 'b'.repeat(64); version = '2.0.0'; await inspect();
  assert.match(root.querySelector('.source-card').textContent, /Exact 2.0.0/); assert.equal(review.open, true); assert.match(review.textContent, /Exact 1.0.0/); assert.doesNotMatch(review.textContent, /Exact 2.0.0/);
  assert.equal(Boolean(review.querySelector('[type=checkbox]').checked), false); assert.ok(view.calls.every(([path]) => !/\/(?:fetch|start|restart)$/.test(path)));
});


test('automatic-selection status remains visible despite compact card CSS hiding ordinary picker help', async () => {
  const css = await readFile(new URL('../../../tools/launcher/public/style.css', import.meta.url), 'utf8');
  const hiddenHelp = css.indexOf('.pack-card .asset-version-picker .field-help,');
  const explicitNotice = css.match(/\.pack-card \.asset-version-picker \.asset-selection-notice\s*\{[^}]*display:\s*block\s*!important/);
  assert.ok(hiddenHelp >= 0, 'The compact-card help rule is exercised');
  assert.ok(explicitNotice && explicitNotice.index > hiddenHelp, 'The fallback status explicitly overrides compact-card hidden help');
});
