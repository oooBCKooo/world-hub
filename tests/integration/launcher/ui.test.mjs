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
function harness(api) {
  const body = element('body');
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  const environment = element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name })));
  body.append(element('section', { id: 'view-environment' }, environment), element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })), ...['sources-content', 'creator-content', 'detail-content'].map(id => element('div', { id })));
  const selected = [], state = { language: 'en', environmentSelection: {}, view: 'packs', selected: 'first', tab: 'storage' };
  const ctx = { state, api, el: element, button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title), pill: title => element('span', {}, title), t: key => key, toast() {}, definition: pairs => element('dl', {}, pairs.flatMap(([key, value]) => [element('dt', {}, key), element('dd', {}, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))])), display: String, date: String, errorContents: failure => [element('p', {}, failure.message)], current() {}, idOf: instance => instance.instanceId ?? instance.id, endpoint: (id, action) => `/api/instances/${id}/${action}`, operationFor: instance => instance.operation, exitUnconfirmed: instance => Boolean(instance.status?.runId && !instance.status.stoppedAt), refresh: async () => {}, renderDetail() {}, navigate() {}, selectInstance: async id => selected.push(id), openImport() {}, replaceInstance() {}, reviewView: data => [element('pre', {}, JSON.stringify(data.review))] };
  const ui = createAdvancedUi(ctx); return { body, ui, state, selected, mount: nodes => body.querySelector('#detail-content').replaceChildren(...nodes) };
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

test('creator derives the displayed composition against its inspected revision and preserves untrusted text', async () => {
  const calls = [], untrusted = '<script>globalThis.executed=true</script>', pack = { id: 'sample', version: '1.0.0', title: untrusted, components: [{ id: 'provider', module: 'provider', settings: { message: untrusted } }, { id: 'client', module: 'client' }], bindings: [{ from: 'provider', to: 'client', contract: { id: 'echo', version: '1' } }] };
  const { body, ui } = harness(async (path, request) => { calls.push([path, request]); if (path.endsWith('/inspect')) return { authoring: { revision: 'revision-1', pack, modules: [{ id: 'provider', provides: [{ id: 'echo', version: '1' }] }, { id: 'client', requires: [{ id: 'echo', version: '1' }] }] } }; if (path.endsWith('/derive')) return { operationId: 'derive-1' }; return { operation: { state: 'succeeded', result: { directory: 'new-derived' } } }; });
  ui.navigate('creator'); const root = body.querySelector('#creator-content'), inspect = root.querySelector('form'); inspect.elements.directory.value = 'source-pack'; await inspect.dispatch('submit');
  const graph = root.querySelector('.composition-graph'); assert.match(graph.textContent, /provider→clientecho@1/); assert.equal(graph.querySelectorAll('script').length, 0);
  const derive = root.querySelectorAll('form').find(form => form.elements.packId); derive.elements.destination.value = 'new-derived'; await derive.dispatch('submit'); assert.equal(calls.length, 1);
  const dialog = body.querySelector('#advanced-action-dialog'); assert.match(dialog.textContent, /<script>/); assert.equal(dialog.querySelectorAll('script').length, 0); await (await consent(body)).dispatch('click');
  const [, request] = calls.find(([path]) => path.endsWith('/derive')); assert.equal(request.expectedRevision, 'revision-1'); assert.equal(request.redistributionAcknowledged, true); assert.equal(request.pack.components[0].settings.message, untrusted); assert.equal(request.destination, 'new-derived'); assert.ok(calls.every(([path]) => !path.endsWith('/start')));
});

test('software source network policy defaults closed and fetch uses the inspected policy receipt', async () => {
  for (const privateOptIn of [false, true]) {
    const calls = [], digest = 'b'.repeat(64);
    const { body, ui } = harness(async (path, request) => {
      calls.push([path, request]);
      if (path.endsWith('/inspect')) return { digest, networkPolicy: privateOptIn ? 'trusted-private-ipv4' : 'public-ipv4', index: { entries: [{ entryId: 'module-1', kind: 'module', id: 'module', title: '<img src=x onerror=alert(1)>', version: '1.0.0', license: 'MIT', platforms: ['win32-x64'], sha256: 'c'.repeat(64) }] } };
      if (path.endsWith('/fetch')) return { operationId: 'fetch-1' };
      return { operation: { state: 'succeeded', result: { kind: 'module', directory: 'verified-cache' } } };
    });
    ui.navigate('sources'); const root = body.querySelector('#sources-content'), add = root.querySelectorAll('form').find(form => form.elements.name);
    assert.equal(add.elements.allowPrivateNetwork.checked, undefined); add.elements.allowPrivateNetwork.checked = privateOptIn; add.elements.name.value = 'my-source'; add.elements.source.value = 'https://source.example/index.json'; await add.dispatch('submit');
    assert.equal(calls[0][1].allowPrivateNetwork, privateOptIn || undefined); assert.equal(root.querySelectorAll('img').length, 0);
    await byText(root, 'Verify and fetch to cache').dispatch('click'); assert.equal(calls.length, 1); assert.match(body.querySelector('#advanced-action-dialog').textContent, privateOptIn ? /Trusted private network/ : /Public network/);
    await (await consent(body)).dispatch('click'); const [, request] = calls.find(([path]) => path.endsWith('/fetch')); assert.equal(request.indexDigest, digest); assert.equal(request.allowPrivateNetwork, privateOptIn || undefined); assert.ok(calls.every(([path]) => !path.endsWith('/start')));
  }
});

test('UI source modules have no markup execution sinks or private credential links', async () => {
  for (const filename of ['app.mjs', 'advanced.mjs']) { const source = await readFile(new URL(`../../../tools/launcher/public/${filename}`, import.meta.url), 'utf8'); assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/); }
  const app = await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8'); assert.match(app, /url\.hostname !== '127\.0\.0\.1'/); assert.match(app, /noopener noreferrer/); assert.match(app, /redirect: 'error'/);
});

test('distribution allowlists close over every optional Launcher and Runtime module import', async () => {
  const files = new Set([...APPLICATION_FILES, ...SDK_FILES, ...ECOSYSTEM_RUNTIME_FILES, ...LAUNCHER_FILES, 'scripts/launcher.mjs', 'scripts/launcher-support.mjs', 'scripts/release/verify-package.mjs']);
  for (const file of [...ECOSYSTEM_RUNTIME_FILES, ...LAUNCHER_FILES].filter(file => file.endsWith('.mjs'))) {
    const source = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = posix.normalize(posix.join(dirname(file).replaceAll('\\', '/'), match[1])); assert.ok(files.has(target), `${file} imports omitted distribution file ${target}`);
    }
  }
  for (const path of ['tools/launcher/public/advanced.mjs', 'tools/launcher/environment-prepare.mjs', 'tools/launcher/diagnostics.mjs', 'scripts/runtime/maintenance.mjs', 'scripts/runtime/authoring.mjs', 'scripts/runtime/sources.mjs']) assert.ok(files.has(path), path);
});
