import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Exercise the real catalog rendering and handlers with the same small DOM
// surface used by presentation-ui.test.mjs. No copied filtering logic runs here.
class Element {
  constructor(tag = '#text', text = '') {
    this.tag = tag; this.textContent = text; this.children = []; this.attributes = {};
    this.listeners = {}; this.dataset = {}; this.classList = { toggle() {} };
    this.value = ''; this.disabled = false;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'value') this.value = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const text = node => walk(node).map(row => row.textContent).join('\n');
const named = (view, name) => walk(view).find(row => row.attributes.name === name);
const tab = (view, kind) => walk(view).find(row => row.tag === 'button' && row.dataset.kind === kind);
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = value => ({ ok: true, json: async () => value });
const source = await readFile(new URL('../../../tools/workshop/public/app.mjs', import.meta.url), 'utf8');
function harness(fetcher = async () => response({ total: 0, publications: [] })) {
  const view = new Element('main'), notice = new Element('div'), language = new Element('select'), account = new Element('span');
  const calls = [];
  const context = {
    Node: Element, URL, URLSearchParams, TextDecoder, Uint8Array, atob, btoa, Blob, setTimeout,
    navigator: { language: 'en' }, localStorage: { getItem: () => 'en' }, location: { hash: '#catalog' },
    renderArtifactConfiguration: () => null,
    document: {
      documentElement: { lang: 'en' }, createElement: tag => new Element(tag),
      createTextNode: value => new Element('#text', value),
      querySelector: selector => ({ '#view': view, '#notice': notice, '#language': language, '#account-indicator': account }[selector]),
      querySelectorAll: () => []
    },
    fetch: (url, options) => { calls.push({ url, options }); return fetcher(url, options); }
  };
  const script = source.slice(0, source.indexOf("$('#language').addEventListener"))
    .replace(/^import \{ renderArtifactConfiguration \} from [^\r\n]+\r?\n/m, '')
    .replace("const base = new URL('./', import.meta.url);", "const base = new URL('https://example.test/workshop/');");
  vm.runInNewContext(script + '\nglobalThis.ui={state,renderCatalog,loadRoute};', context);
  return { ...context.ui, view, notice, calls, context };
}
function edit(view, name, value) {
  const input = named(view, name); assert.ok(input, `${name} input is available`);
  input.value = value; input.listeners.input?.({ currentTarget: input, target: input });
}
function publication(kind) {
  return { entryId: `test.${kind}`, kind, id: `test.${kind}`, version: '1.0.0', title: `${kind} result`, owner: { username: 'author' } };
}

test('catalog offers one accessible type filter and no duplicate type select in either language', () => {
  const ui = harness();
  for (const language of ['en', 'zh']) {
    ui.state.language = language; ui.state.kind = 'configuration'; ui.renderCatalog();
    assert.equal(walk(ui.view).some(row => row.tag === 'select' && row.attributes.name === 'kind'), false);
    const tabs = walk(ui.view).filter(row => row.tag === 'button' && Object.hasOwn(row.dataset, 'kind'));
    assert.deepEqual(tabs.map(row => row.dataset.kind), ['', 'module', 'configuration', 'data']);
    for (const item of tabs) {
      assert.equal(item.attributes.type, 'button', 'type choices never implicitly submit a form');
      assert.equal(item.attributes['aria-pressed'], String(item.dataset.kind === 'configuration'));
    }
    const group = walk(ui.view).find(row => row.className === 'resource-tabs');
    assert.equal(group.attributes.role, 'group'); assert.ok(group.attributes['aria-label']);
  }
});

test('changing type applies current search and contract drafts and resets pagination', async () => {
  const ui = harness(); ui.state.offset = 48; ui.renderCatalog();
  edit(ui.view, 'search', '  latest draft  '); edit(ui.view, 'contract', '  example.text/v1  ');
  tab(ui.view, 'configuration').listeners.click(); await flush();
  assert.equal(ui.calls.length, 1);
  const params = ui.calls[0].url.searchParams;
  assert.equal(params.get('kind'), 'configuration'); assert.equal(params.get('search'), 'latest draft');
  assert.equal(params.get('contract'), 'example.text/v1'); assert.equal(params.get('offset'), '0');
  assert.equal(named(ui.view, 'search').value, 'latest draft'); assert.equal(named(ui.view, 'contract').value, 'example.text/v1');
  assert.equal(tab(ui.view, 'configuration').attributes['aria-pressed'], 'true');
});

test('submitting search preserves the selected type and sends the current exact contract', async () => {
  const ui = harness(); ui.state.kind = 'data'; ui.state.offset = 24; ui.renderCatalog();
  edit(ui.view, 'search', '  weather  '); edit(ui.view, 'contract', '  example.weather  ');
  const form = walk(ui.view).find(row => row.attributes.id === 'catalog-filter');
  let prevented = false; form.listeners.submit({ preventDefault() { prevented = true; } }); await flush();
  assert.equal(prevented, true); assert.equal(ui.calls.length, 1);
  const params = ui.calls[0].url.searchParams;
  assert.equal(params.get('kind'), 'data'); assert.equal(params.get('search'), 'weather');
  assert.equal(params.get('contract'), 'example.weather'); assert.equal(params.get('offset'), '0');
});

test('a late type result cannot replace the latest type result or clear its busy state', async () => {
  const pending = [], ui = harness(() => new Promise(resolve => pending.push(resolve)));
  ui.renderCatalog(); tab(ui.view, 'module').listeners.click(); tab(ui.view, 'data').listeners.click();
  assert.equal(ui.calls.length, 2); assert.equal(ui.view.attributes['aria-busy'], 'true');
  pending[0](response({ total: 1, publications: [publication('module')] })); await flush();
  assert.equal(ui.view.attributes['aria-busy'], 'true', 'the newest request still owns the loading state');
  pending[1](response({ total: 1, publications: [publication('data')] })); await flush();
  assert.match(text(ui.view), /data result/); assert.doesNotMatch(text(ui.view), /module result/);
  assert.equal(tab(ui.view, 'data').attributes['aria-pressed'], 'true'); assert.equal(ui.view.attributes['aria-busy'], 'false');
});

test('an obsolete catalog failure cannot replace a newer successful filter or show a false error', async () => {
  const pending = [], ui = harness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  ui.renderCatalog(); tab(ui.view, 'module').listeners.click(); tab(ui.view, 'configuration').listeners.click();
  pending[1].resolve(response({ total: 1, publications: [publication('configuration')] })); await flush();
  pending[0].reject(new Error('obsolete network failure')); await flush();
  assert.match(text(ui.view), /configuration result/); assert.equal(ui.notice.textContent, '');
  assert.equal(tab(ui.view, 'configuration').attributes['aria-pressed'], 'true'); assert.equal(ui.view.attributes['aria-busy'], 'false');
});
