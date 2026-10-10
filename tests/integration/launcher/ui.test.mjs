import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';
import { APPLICATION_FILES, SDK_FILES, ECOSYSTEM_RUNTIME_FILES, LAUNCHER_FILES } from '../../../scripts/release/build-package.mjs';

// A small inert DOM exercises the actual UI handlers without executing any pack or browser content.
class Element {
  constructor(tag = '#text', text = '') { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.text = text; this.dataset = {}; }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = value; if (name === 'id') this.id = value; if (name === 'value') this.value = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
  append(...items) { for (let child of items) { if (child === null || child === undefined) continue; if (!(child instanceof Element)) child = new Element('#text', String(child)); child.parent = this; this.children.push(child); } if (this.tagName === 'select' && !this.value) this.value = this.children[0]?.value ?? ''; }
  replaceChildren(...items) { this.children = []; this.text = ''; this.append(...items); }
  prepend(...items) { const old = this.children; this.children = []; this.append(...items); this.children.push(...old); }
  insertBefore(child, next) { child.parent = this; const index = this.children.indexOf(next); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get elements() { return Object.fromEntries(this.querySelectorAll('[name]').map(child => [child.attributes.name, child])); }
  matches(selector) { if (selector.startsWith('#')) return this.id === selector.slice(1); if (selector.startsWith('.')) return this.className?.split(' ').includes(selector.slice(1)); if (selector.startsWith('[')) { const [, name, value] = selector.match(/^\[([^=\]]+)(?:=([^\]]+))?\]$/) ?? []; return value ? this.attributes[name] === value.replaceAll('"', '') : name in this.attributes; } return this.tagName === selector; }
  querySelectorAll(selector) { const segments = selector.split(' '), found = []; const visit = node => { for (const child of node.children) { if (child.matches(segments.at(-1)) && (segments.length === 1 || hasAncestor(child, segments[0]))) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(kind, action) { (this.listeners[kind] ??= []).push(action); }
  async dispatch(kind) { if (kind === 'click' && this.disabled) return; for (const action of this.listeners[kind] ?? []) await action({ preventDefault() {}, target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; for (const action of this.listeners.close ?? []) action({}); }
}
function hasAncestor(element, selector) { for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) if (ancestor.matches(selector)) return true; return false; }
function element(tag, attributes = {}, children = []) {
  const node = new Element(tag);
  for (const [key, value] of Object.entries(attributes)) { if (value === false || value === undefined || value === null) continue; if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else if (['checked', 'disabled', 'hidden'].includes(key)) node[key] = value; else node.setAttribute(key, value); }
  node.append(...(Array.isArray(children) ? children : [children])); return node;
}
function harness(api, overrides = {}) {
  const body = element('body');
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  const environment = element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name })));
  body.append(element('section', { id: 'view-environment' }, environment), element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })), ...['sources-content', 'creator-content', 'detail-content'].map(id => element('div', { id })), element('form', { id: 'import-form' }, element('input', { name: 'directory' })));
  const selected = [], imports = [], state = { language: 'en', environmentSelection: {}, view: 'packs', selected: 'first', tab: 'storage' };
  const ctx = { state, api, el: element, button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title), pill: title => element('span', {}, title), t: key => key, toast() {}, definition: pairs => element('dl', {}, pairs.flatMap(([key, value]) => [element('dt', {}, key), element('dd', {}, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))])), display: String, date: String, errorContents: failure => [element('p', {}, failure.message)], current() {}, idOf: instance => instance.instanceId ?? instance.id, endpoint: (id, action) => `/api/instances/${id}/${action}`, operationFor: instance => instance.operation, exitUnconfirmed: instance => Boolean(instance.status?.runId && !instance.status.stoppedAt), refresh: async () => {}, renderDetail() {}, navigate() {}, selectInstance: async id => selected.push(id), openImport() { imports.push(true); }, replaceInstance() {}, reviewView: data => [element('pre', {}, JSON.stringify(data.review))] };
  Object.assign(ctx, overrides);
  const ui = createAdvancedUi(ctx); return { body, ui, ctx, state, selected, imports, mount: nodes => body.querySelector('#detail-content').replaceChildren(...nodes) };
}
const byText = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
async function consent(body) { const dialog = body.querySelector('#advanced-action-dialog'); const check = dialog.querySelector('[type=checkbox]'); const confirm = byText(dialog, 'Confirm review and continue'); assert.equal(confirm.disabled, true); assert.equal(check.checked, undefined); check.checked = true; await check.dispatch('change'); assert.equal(confirm.disabled, false); return confirm; }

test('detached private backup is explicitly authorized and cancellation remains inside the modal', async () => {
  const calls = []; let cancelled = false;
  const { body, ui, mount } = harness(async (path, request) => { calls.push([path, request]); if (path.endsWith('/backup')) return { operationId: 'backup-1' }; if (path.endsWith('/cancel')) { cancelled = true; return { ok: true }; } return { operation: { state: cancelled ? 'cancelled' : 'running' } }; });
  mount(ui.renderStorage({ instanceId: 'first', detached: true, status: { state: 'detached', runId: 'ended', stoppedAt: 'now' } }));
  const form = body.querySelector('#detail-content').querySelector('form'); form.elements.destination.value = 'private-backup.json'; assert.equal(form.querySelector('[type=submit]').disabled, false);
  await form.dispatch('submit'); assert.equal(calls.length, 0);
  const dialog = body.querySelector('#advanced-action-dialog'); assert.match(dialog.textContent, /personal data and secrets/);
  const confirm = await consent(body), running = confirm.dispatch('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][1].accepted, true); assert.equal(calls[0][0], '/api/instances/first/backup');
  const cancel = byText(dialog, 'Cancel this operation'); assert.ok(cancel); assert.equal(dialog.open, true); await cancel.dispatch('click'); await running;
  assert.equal(cancelled, true); assert.match(dialog.textContent, /Operation cancelled/);
});

test('restore sends the inspected digest to a new instance only after a second explicit review', async () => {
  const calls = [], digest = 'a'.repeat(64);
  const { body, ui, mount, selected } = harness(async (path, request) => { calls.push([path, request]); if (path.endsWith('/inspect')) return { inspection: { compatible: true, sha256: digest, backup: { sourceInstanceId: 'old', files: 3, bytes: 42 } } }; if (path.endsWith('/restore')) return { operationId: 'restore-1' }; return { operation: { state: 'succeeded', result: { instance: { instanceId: 'new-instance' } } } }; });
  mount(ui.renderStorage({ instanceId: 'first', status: { state: 'imported' } })); await byText(body, 'Inspect backup and restore to a new instance').dispatch('click');
  const form = body.querySelector('#restore-dialog').querySelector('form'); form.elements.backup.value = 'private.json'; form.elements.instanceId.value = 'new-instance'; await form.dispatch('submit');
  assert.equal(calls.length, 1); assert.doesNotMatch(form.textContent, /null/); await form.dispatch('submit'); assert.equal(calls.length, 1);
  await (await consent(body)).dispatch('click'); assert.deepEqual(calls[1][1], { backup: 'private.json', sha256: digest, instanceId: 'new-instance', accepted: true }); assert.deepEqual(selected, ['new-instance']); assert.ok(calls.every(([path]) => !path.endsWith('/start')));
});

test('candidate trial requires acceptance, survives refresh redraw, and keeps the return-to-old action after remount', async () => {
  const calls = [], instances = { first: { instanceId: 'first', status: { state: 'imported' } } };
  const candidate = { instanceId: 'first-trial', stagedFrom: 'first', status: { state: 'imported' } };
  const preview = { instanceId: 'first', newInstanceId: candidate.instanceId,
    current: { pack: { id: 'sample', version: '1.0.0' } }, candidate: { pack: { id: 'sample', version: '1.1.0' } },
    backupDestination: 'private-before-trial.whbackup', snapshot: { files: 3 }, diff: { components: [], candidate: { interpreters: {} } } };
  let scene, refreshes = 0;
  scene = harness(async (path, request) => {
    calls.push([path, request]);
    if (path.endsWith('/staged-upgrade-plan')) return { previewId: 'trial-review', preview };
    if (path.endsWith('/staged-upgrade')) { instances[candidate.instanceId] = candidate; return { operationId: 'trial-operation' }; }
    if (path === '/api/operations/trial-operation') return { operation: { state: 'succeeded', result: { newInstanceId: candidate.instanceId, instance: candidate, startsModules: false } } };
    throw new Error('Unexpected operation: ' + path);
  }, {
    refresh: async () => { refreshes++; scene.mount(scene.ui.renderStorage(instances[scene.state.selected])); },
    selectInstance: async id => { scene.selected.push(id); scene.state.selected = id; scene.mount(scene.ui.renderStorage(instances[id])); },
  });
  const { body } = scene; scene.mount(scene.ui.renderStorage(instances.first));
  const form = body.querySelector('#detail-content').querySelectorAll('form').find(row => row.elements.newInstanceId);
  form.elements.candidate.value = 'candidate-pack'; form.elements.newInstanceId.value = candidate.instanceId;
  form.elements.backupDestination.value = preview.backupDestination;
  await form.dispatch('submit');
  assert.deepEqual(calls[0], ['/api/instances/first/staged-upgrade-plan', { candidate: 'candidate-pack', newInstanceId: candidate.instanceId, backupDestination: preview.backupDestination, statePolicy: 'fresh' }]);
  assert.match(body.querySelector('#advanced-action-dialog').textContent, /application behavior is unverified/);
  const confirm = byText(body.querySelector('#advanced-action-dialog'), 'Confirm review and continue');
  await confirm.dispatch('click'); assert.equal(calls.length, 1); assert.deepEqual(scene.selected, []);
  await (await consent(body)).dispatch('click');
  assert.deepEqual(calls.find(([path]) => path.endsWith('/staged-upgrade'))[1], { previewId: 'trial-review', accepted: true });
  assert.deepEqual(scene.selected, [candidate.instanceId]); assert.ok(refreshes >= 2);
  assert.ok(byText(body.querySelector('#detail-content'), 'Return to old instance'));
  // A new UI mounting only the persisted candidate record must retain navigation.
  scene.ui = createAdvancedUi(scene.ctx); scene.mount(scene.ui.renderStorage(candidate));
  const returned = byText(body.querySelector('#detail-content'), 'Return to old instance'); assert.ok(returned);
  await returned.dispatch('click'); assert.deepEqual(scene.selected, [candidate.instanceId, 'first']);
  assert.equal(scene.state.selected, 'first');
  assert.equal(byText(body.querySelector('#detail-content'), 'Return to old instance'), undefined);
  assert.ok(calls.every(([path]) => !path.endsWith('/start') && !path.endsWith('/stop')));
});

test('creator derives the displayed composition against its inspected revision and preserves untrusted text', async () => {
  const calls = [], untrusted = '<script>globalThis.executed=true</script>', pack = { id: 'sample', version: '1.0.0', title: untrusted, components: [{ id: 'provider', module: 'provider', settings: { message: untrusted } }, { id: 'client', module: 'client' }], bindings: [{ from: 'provider', to: 'client', contract: { id: 'echo', version: '1' } }] };
  const { body, ui } = harness(async (path, request) => { calls.push([path, request]); if (path.endsWith('/inspect')) return { authoring: { revision: 'revision-1', pack, modules: [{ id: 'provider', provides: [{ id: 'echo', version: '1' }] }, { id: 'client', requires: [{ id: 'echo', version: '1' }] }] } }; if (path.endsWith('/derive')) return { operationId: 'derive-1' }; return { operation: { state: 'succeeded', result: { directory: 'new-derived' } } }; });
  ui.navigate('creator'); const root = body.querySelector('#creator-content'), inspect = root.querySelector('form'); inspect.elements.directory.value = 'source-pack'; await inspect.dispatch('submit');
  const graph = root.querySelector('.composition-graph'); assert.match(graph.textContent, /provider→clientecho@1/); assert.equal(graph.querySelectorAll('script').length, 0);
  const derive = root.querySelectorAll('form').find(form => form.elements.packId); derive.elements.destination.value = 'new-derived'; await derive.dispatch('submit'); assert.equal(calls.length, 1);
  const dialog = body.querySelector('#advanced-action-dialog'); assert.match(dialog.textContent, /<script>/); assert.equal(dialog.querySelectorAll('script').length, 0); await (await consent(body)).dispatch('click');
  const [, request] = calls.find(([path]) => path.endsWith('/derive')); assert.equal(request.expectedRevision, 'revision-1'); assert.equal(request.redistributionAcknowledged, true); assert.equal(request.pack.components[0].settings.message, untrusted); assert.equal(request.destination, 'new-derived'); assert.ok(calls.every(([path]) => !path.endsWith('/start')));
});

test('replacement needs a current second preview and displays the actual candidate in the graph', async () => {
  let revision = 'base-1'; const calls = [];
  const pack = { id: 'sample', version: '1.0.0', components: [{ id: 'stats', module: 'old.stats' }], bindings: [] };
  const { body, ui } = harness(async (path, request) => {
    calls.push([path, request]);
    if (path.endsWith('/inspect')) return { authoring: { revision, pack, modules: [{ id: 'old.stats', runtime: { kind: 'python' } }] } };
    if (path.endsWith('/preview')) return { preview: { compatible: true, sourceRevision: revision, candidateDigest: 'candidate',
      candidate: { directory: 'new-module', manifest: { id: 'new.stats', runtime: { kind: 'node' }, provides: [] } } } };
    throw new Error('Unexpected mutation: ' + path);
  });
  ui.navigate('creator'); const root = body.querySelector('#creator-content'), inspect = root.querySelector('form');
  inspect.elements.directory.value = 'source-pack'; await inspect.dispatch('submit');
  await byText(root, 'Edit settings & module').dispatch('click');
  const dialog = body.querySelectorAll('dialog').find(node => node.open), editor = dialog.querySelector('form');
  editor.elements.moduleDirectory.value = 'new-module'; await editor.dispatch('submit');
  assert.equal(dialog.open, true); assert.match(root.querySelector('.composition-graph').textContent, /old.stats/);
  revision = 'base-2'; await editor.dispatch('submit'); assert.equal(dialog.open, true);
  await editor.dispatch('submit'); assert.equal(dialog.open, false);
  assert.match(root.querySelector('.composition-graph').textContent, /new.stats/); assert.match(root.querySelector('.composition-graph').textContent, /node/);
  assert.equal(calls.filter(([path]) => path.endsWith('/preview')).length, 3);
  assert.ok(calls.every(([path]) => !path.endsWith('/derive') && !path.endsWith('/start')));
});

test('guided replacement preserves consumer code and settings without JSON editing, rechecks changed contents, and hands the new pack to import', async () => {
  const calls = [], pack = { id: 'sample', version: '1.0.0', title: 'Statistics', components: [{ id: 'stats', module: 'old.stats', after: [], settings: { providerOption: 'unchanged' } }, { id: 'client', module: 'consumer', after: ['stats'], settings: { text: '你好 🌍' } }], bindings: [{ from: 'stats', to: 'client', contract: { id: 'text.statistics', version: '1.0.0' } }] };
  let candidateDigest = 'candidate-1';
  const { body, ui, imports } = harness(async (path, request) => {
    calls.push([path, request]);
    if (path.endsWith('/inspect')) return { authoring: { revision: 'base', pack, modules: [{ id: 'old.stats', runtime: { kind: 'node' }, provides: [{ id: 'text.statistics', version: '1.0.0' }] }, { id: 'consumer', requires: [{ id: 'text.statistics', version: '1.0.0' }] }] } };
    if (path.endsWith('/preview')) return { preview: { compatible: true, declarationCompatible: true, businessValidated: false, sourceRevision: 'base', candidateDigest, affectedComponents: ['stats'], candidate: { directory: 'python-module', manifest: { id: 'python.stats', version: '1.0.0', runtime: { kind: 'python' }, provides: [{ id: 'text.statistics', version: '1.0.0' }] } }, differences: { runtime: { before: { kind: 'node', entry: 'program.mjs' }, after: { kind: 'python', entry: 'program.py' }, changed: true }, permissions: { before: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' }, after: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' }, changed: false }, license: { before: 'MIT', after: 'MIT', changed: false } }, diagnostics: [] } };
    if (path.endsWith('/derive')) return { operationId: 'derive-guided' };
    return { operation: { state: 'succeeded', result: { directory: 'new-derived' } } };
  });
  ui.navigate('creator'); const root = body.querySelector('#creator-content'), inspect = root.querySelector('form'); inspect.elements.directory.value = 'source-pack'; await inspect.dispatch('submit');
  const guided = root.querySelectorAll('form').find(form => form.elements.componentId);
  assert.deepEqual(Object.keys(guided.elements).sort(), ['componentId', 'moduleDirectory']);
  guided.elements.moduleDirectory.value = 'python-module'; await guided.dispatch('submit');
  assert.match(root.textContent, /Exact declarations match; business behavior unverified/);
  assert.match(root.textContent, /Declared permissions/); assert.match(root.textContent, /Runtime entry/); assert.match(root.textContent, /License/);
  candidateDigest = 'candidate-2'; await byText(root, 'Use this candidate module').dispatch('click');
  assert.match(root.textContent, /Contents or environment changed/); assert.match(root.querySelector('.composition-graph').textContent, /old.stats/);
  await guided.dispatch('submit'); await byText(root, 'Use this candidate module').dispatch('click');
  assert.match(root.querySelector('.composition-graph').textContent, /python.stats/);
  const derive = root.querySelectorAll('form').find(form => form.elements.packId); derive.elements.destination.value = 'new-derived'; await derive.dispatch('submit');
  assert.equal(calls.some(([path]) => path.endsWith('/derive')), false); await (await consent(body)).dispatch('click');
  const [, request] = calls.find(([path]) => path.endsWith('/derive'));
  assert.deepEqual(request.pack, pack); assert.deepEqual(request.replacements, [{ componentId: 'stats', moduleDirectory: 'python-module' }]);
  assert.match(root.textContent, /New instances use new data directories/);
  await byText(root, 'Import and review execution').dispatch('click'); assert.equal(imports.length, 1); assert.equal(body.querySelector('#import-form').elements.directory.value, 'new-derived');
  assert.ok(calls.every(([path]) => !path.endsWith('/start') && !path.endsWith('/upgrade') && path !== '/api/instances'));
});

test('guided mismatch explains contract and platform causes in both languages and can be abandoned without changing the draft', async () => {
  for (const language of ['en', 'zh']) {
    const calls = [], pack = { id: 'sample', version: '1.0.0', title: 'Statistics', components: [{ id: 'stats', module: 'old.stats' }], bindings: [] };
    const { body, ui, state } = harness(async (path, request) => {
      calls.push([path, request]);
      if (path.endsWith('/inspect')) return { authoring: { revision: 'base', pack, modules: [{ id: 'old.stats', provides: [{ id: 'text.statistics', version: '1.0.0' }] }] } };
      if (path.endsWith('/preview')) return { preview: { compatible: false, declarationCompatible: false, sourceRevision: 'base', candidateDigest: 'candidate', candidate: { directory: 'incompatible-module', manifest: { id: '<script>unsafe</script>', version: '2.0.0' } }, diagnostics: [{ code: 'CONTRACT_INCOMPATIBLE', message: 'Technical contract failure' }, { code: 'PLATFORM_UNSUPPORTED', moduleId: 'new.stats' }], differences: {} } };
      throw new Error('Unexpected mutation: ' + path);
    });
    state.language = language; ui.navigate('creator'); const root = body.querySelector('#creator-content'), inspect = root.querySelector('form'); inspect.elements.directory.value = 'source-pack'; await inspect.dispatch('submit');
    const guided = root.querySelectorAll('form').find(form => form.elements.componentId); guided.elements.moduleDirectory.value = 'incompatible-module'; await guided.dispatch('submit');
    assert.match(root.textContent, language === 'en' ? /contract ID or exact version does not match/ : /合同 ID 或精确版本不匹配/);
    assert.match(root.textContent, language === 'en' ? /does not declare support for this platform/ : /没有声明支持当前平台/);
    assert.equal(byText(root, language === 'en' ? 'Use this candidate module' : '使用此候选模块'), undefined); assert.equal(root.querySelectorAll('script').length, 0);
    await byText(root, language === 'en' ? 'Cancel candidate preview' : '取消候选预览').dispatch('click');
    assert.match(root.querySelector('.composition-graph').textContent, /old.stats/); assert.equal(calls.length, 2);
  }
});

test('software source network policy defaults closed and fetch uses the inspected policy receipt', async () => {
  for (const privateOptIn of [false, true]) {
    const calls = [], digest = 'b'.repeat(64); let registered;
    const { body, ui } = harness(async (path, request) => {
      calls.push([path, request]);
      if (path === '/api/sources') return { sources: registered ? [registered] : [], conflicts: [] };
      if (path.endsWith('/save')) { registered = { ...request, id: 'source.one' }; return { source: registered }; }
      if (path.endsWith('/inspect')) return { sourceId: 'source.one', receiptId: 'receipt.one', digest, networkPolicy: privateOptIn ? 'trusted-private-ipv4' : 'public-ipv4', index: { entries: [{ entryId: 'module-1', kind: 'module', id: 'module', title: '<img src=x onerror=alert(1)>', version: '1.0.0', license: 'MIT', platforms: ['win32-x64'], sha256: 'c'.repeat(64) }] } };
      if (path.endsWith('/fetch')) return { operationId: 'fetch-1' };
      return { operation: { state: 'succeeded', result: { kind: 'module', directory: 'verified-cache' } } };
    });
    ui.navigate('sources'); const root = body.querySelector('#sources-content'), add = root.querySelectorAll('form').find(form => form.elements.name);
    assert.equal(add.elements.allowPrivateNetwork.checked, undefined); add.elements.allowPrivateNetwork.checked = privateOptIn; add.elements.name.value = 'my-source'; add.elements.source.value = 'https://source.example/index.json'; await add.dispatch('submit');
    assert.equal(calls.find(([path]) => path.endsWith('/save'))[1].allowPrivateNetwork, privateOptIn); assert.equal(root.querySelectorAll('img').length, 0);
    const browse = root.querySelectorAll('form').find(form => form.elements.source?.tagName === 'select'); browse.elements.source.value = registered.source; await browse.dispatch('submit');
    assert.deepEqual(calls.find(([path]) => path.endsWith('/inspect'))[1], { sourceId: 'source.one' });
    await byText(root, 'Verify and fetch to cache').dispatch('click'); assert.equal(calls.some(([path]) => path.endsWith('/fetch')), false); assert.match(body.querySelector('#advanced-action-dialog').textContent, privateOptIn ? /Trusted private network/ : /Public network/);
    await (await consent(body)).dispatch('click'); const [, request] = calls.find(([path]) => path.endsWith('/fetch')); assert.deepEqual(request, { sourceId: 'source.one', receiptId: 'receipt.one', entryId: 'module-1' }); assert.ok(calls.every(([path]) => !path.endsWith('/start')));
  }
});

test('UI source modules have no markup execution sinks or private credential links', async () => {
  for (const filename of ['app.mjs', 'advanced.mjs']) { const source = await readFile(new URL(`../../../tools/launcher/public/${filename}`, import.meta.url), 'utf8'); assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/); }
  const app = await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8'); assert.match(app, /url\.hostname !== '127\.0\.0\.1'/); assert.match(app, /noopener noreferrer/); assert.match(app, /redirect: 'error'/);
});

test('distribution allowlists close over every optional Launcher and Runtime module import', async () => {
  const files = new Set([...APPLICATION_FILES, ...SDK_FILES, ...ECOSYSTEM_RUNTIME_FILES, ...LAUNCHER_FILES, 'scripts/launcher.mjs', 'scripts/launcher-support.mjs', 'scripts/release/verify-package.mjs']);
  // Author templates materialize their SDK imports into a new module directory;
  // generated-module and installed-package tests validate that complete tree.
  for (const file of [...ECOSYSTEM_RUNTIME_FILES, ...LAUNCHER_FILES].filter(file => file.endsWith('.mjs') && !file.startsWith('scripts/runtime/templates/'))) {
    const source = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = posix.normalize(posix.join(dirname(file).replaceAll('\\', '/'), match[1])); assert.ok(files.has(target), `${file} imports omitted distribution file ${target}`);
    }
  }
  for (const path of ['tools/launcher/public/advanced.mjs', 'tools/launcher/environment-prepare.mjs', 'tools/launcher/diagnostics.mjs', 'scripts/runtime/maintenance.mjs', 'scripts/runtime/authoring.mjs', 'scripts/runtime/sources.mjs']) assert.ok(files.has(path), path);
});
