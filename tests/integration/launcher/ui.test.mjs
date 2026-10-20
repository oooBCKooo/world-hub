import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { dirname, posix, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectAuthoring, previewAddition, previewReplacement, derivePackage } from '../../../scripts/runtime/authoring.mjs';
import { createLock, importPackage } from '../../../scripts/runtime/package.mjs';
import { initModule } from '../../../scripts/runtime/developer.mjs';
import { CreatorDrafts } from '../../../tools/launcher/creator-drafts.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { createAdvancedUi } from '../../../tools/launcher/public/advanced.mjs';
import { APPLICATION_FILES, SDK_FILES, ECOSYSTEM_RUNTIME_FILES, LAUNCHER_FILES } from '../../../scripts/release/build-package.mjs';

import { element } from './ui-dom.mjs';

function harness(api, overrides = {}) {
  const body = element('body');
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  globalThis.window = { addEventListener() {} }; globalThis.location = { origin: 'http://127.0.0.1:32100' };
  const environment = element('form', { id: 'environment-form' }, ['nodePath', 'pythonPath'].map(name => element('input', { name })));
  body.append(element('section', { id: 'view-environment' }, environment), element('section', { id: 'view-packs' }, element('div', { class: 'page-heading' })), ...['sources-content', 'creator-content', 'detail-content'].map(id => element('div', { id })), element('form', { id: 'import-form' }, element('input', { name: 'directory' })));
  const selected = [], imports = [], state = { language: 'en', environmentSelection: {}, view: 'packs', selected: 'first', tab: 'storage', reviews: new Map(), trustReview: null };
  const ctx = { state, api, el: element, button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, onclick: action, disabled }, title), pill: title => element('span', {}, title), t: key => key, toast() {}, definition: pairs => element('dl', {}, pairs.flatMap(([key, value]) => [element('dt', {}, key), element('dd', {}, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))])), display: String, date: String, errorContents: failure => [element('p', {}, failure.message)], current() {}, idOf: instance => instance.instanceId ?? instance.id, endpoint: (id, action) => `/api/instances/${id}/${action}`, operationFor: instance => instance.operation, exitUnconfirmed: instance => Boolean(instance.status?.runId && !instance.status.stoppedAt), refresh: async () => {}, renderDetail() {}, navigate() {}, selectInstance: async id => selected.push(id), openImport() { imports.push(true); }, replaceInstance() {}, reviewView: data => [element('pre', {}, JSON.stringify(data.review))] };
  Object.assign(ctx, overrides);
  const ui = createAdvancedUi(ctx); return { body, ui, ctx, state, selected, imports, mount: nodes => body.querySelector('#detail-content').replaceChildren(...nodes) };
}
const byText = (root, text) => {
  let btn = root.querySelectorAll('button').find(node => node.textContent === text || node.textContent.includes(text));
  if (!btn) {
    const main = root.querySelector('.source-card .pack-card-main') || root.querySelector('.source-card');
    if (main) {
      void main.dispatch('click');
      const dialogButtons = globalThis.document?.body?.querySelectorAll('.dialog button') ?? [];
      btn = [...dialogButtons].reverse().find(node => node.textContent === text || node.textContent.includes(text));
    }
  }
  return btn;
};
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
  await byText(root, 'Edit public settings').dispatch('click');
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
  assert.deepEqual(request.pack, { ...pack, version: '1.0.1' }); assert.deepEqual(request.replacements, [{ componentId: 'stats', moduleDirectory: 'python-module' }]);
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

test('storage inputs survive observation redraw and remain isolated between instances', async () => {
  const calls = [], scene = harness(async path => { calls.push(path); return {}; });
  const first = { instanceId: 'first', status: { state: 'imported' } }, second = { instanceId: 'second', status: { state: 'imported' } };
  scene.mount(scene.ui.renderStorage(first));
  const original = scene.body.querySelector('#detail-content').querySelectorAll('form');
  original.find(form => form.elements.destination).elements.destination.value = 'F:\\private\\first.json';
  original.find(form => form.elements.newInstanceId).elements.candidate.value = 'F:\\candidate\\first';
  scene.mount(scene.ui.renderStorage(first));
  let forms = scene.body.querySelector('#detail-content').querySelectorAll('form');
  assert.equal(forms.find(form => form.elements.destination).elements.destination.value, 'F:\\private\\first.json');
  assert.equal(forms.find(form => form.elements.newInstanceId).elements.candidate.value, 'F:\\candidate\\first');
  scene.mount(scene.ui.renderStorage(second));
  assert.equal(scene.body.querySelector('#detail-content').querySelectorAll('form').find(form => form.elements.destination).elements.destination.value, '');
  scene.mount(scene.ui.renderStorage(first));
  forms = scene.body.querySelector('#detail-content').querySelectorAll('form');
  assert.equal(forms.find(form => form.elements.destination).elements.destination.value, 'F:\\private\\first.json'); assert.deepEqual(calls, []);
});

test('creator edits survive component selection and language redraw; saved drafts restore only against the same base', async () => {
  const pack = { id: 'sample', version: '1.0.0', title: 'Original', components: [{ id: 'provider', module: 'provider', settings: { message: 'original' } }, { id: 'client', module: 'client' }], bindings: [{ from: 'provider', to: 'client', contract: { id: 'echo', version: '1' } }] };
  let revision = 'a'.repeat(64), savedDraft = null;
  const calls = [], api = async (path, request) => {
    calls.push([path, request]);
    if (path === '/api/creator-drafts') return { drafts: savedDraft ? [structuredClone(savedDraft)] : [] };
    if (path === '/api/creator-drafts/save') { savedDraft = structuredClone(request.draft); return { draft: savedDraft }; }
    if (path === '/api/operations') return { operations: [] };
    if (path === '/api/sources') return { sources: [], conflicts: [] };
    if (path.endsWith('/inspect')) return { authoring: { revision, pack: structuredClone(pack), modules: [{ id: 'provider', provides: [{ id: 'echo', version: '1' }] }, { id: 'client', requires: [{ id: 'echo', version: '1' }] }] } };
    throw new Error('Unexpected mutation: ' + path);
  };
  let scene = harness(api); scene.ui.navigate('creator');
  let root = scene.body.querySelector('#creator-content'); root.querySelector('form').elements.directory.value = 'F:\\packs\\source'; await root.querySelector('form').dispatch('submit');
  let derive = root.querySelectorAll('form').find(form => form.elements.packId); derive.elements.packId.value = 'my.design'; derive.elements.destination.value = 'F:\\outputs\\new-pack'; await derive.dispatch('input');
  const node = root.querySelector('.composition-nodes').children[1]; await (byText(node, 'Select & trace bindings') ?? node).dispatch('click');
  derive = root.querySelectorAll('form').find(form => form.elements.packId); assert.equal(derive.elements.packId.value, 'my.design'); assert.equal(derive.elements.destination.value, 'F:\\outputs\\new-pack');
  await byText(root, 'Remove binding').dispatch('click'); assert.equal(root.querySelectorAll('.binding-row').length, 0); await byText(root, 'Undo removal').dispatch('click'); assert.equal(root.querySelectorAll('.binding-row').length, 1);
  await (root.querySelector('.composition-nodes').children[0]).dispatch('click');
  await byText(root, 'Edit public settings').dispatch('click'); const editor = scene.body.querySelectorAll('dialog').find(dialog => dialog.open).querySelector('form'); editor.elements.settings.value = '{"message":"saved draft"}'; await editor.dispatch('submit');
  scene.state.language = 'zh'; scene.state.view = 'creator'; scene.ui.languageChanged();
  derive = root.querySelectorAll('form').find(form => form.elements.packId); assert.equal(derive.elements.packId.value, 'my.design'); assert.equal(derive.elements.destination.value, 'F:\\outputs\\new-pack');
  await byText(root, '立即保存草稿').dispatch('click'); assert.equal(savedDraft.pack.components[0].settings.message, 'saved draft'); assert.equal(savedDraft.pack.id, 'my.design');
  assert.equal(Object.hasOwn(savedDraft, 'reviewId'), false); assert.deepEqual(savedDraft.replacements, []);
  scene = harness(api); scene.ui.sessionReady(); await new Promise(resolve => setImmediate(resolve)); scene.ui.navigate('creator'); root = scene.body.querySelector('#creator-content');
  await byText(root, 'Recheck and restore').dispatch('click'); derive = root.querySelectorAll('form').find(form => form.elements.packId); assert.equal(derive.elements.packId.value, 'my.design'); assert.equal(derive.elements.destination.value, 'F:\\outputs\\new-pack');
  assert.match(root.textContent, /saved draft/); await byText(root, 'Save draft now').dispatch('click');
  revision = 'b'.repeat(64); scene = harness(api); scene.ui.sessionReady(); await new Promise(resolve => setImmediate(resolve)); scene.ui.navigate('creator'); root = scene.body.querySelector('#creator-content');
  await byText(root, 'Recheck and restore').dispatch('click'); assert.equal(root.querySelector('.composition-graph'), null); assert.ok(byText(root, 'Recheck and restore')); assert.match(scene.body.textContent, /Source contents changed/);
  assert.ok(calls.every(([path]) => !path.endsWith('/start') && !path.endsWith('/derive')));
});

test('restoring a saved draft refuses a replacement which became incompatible without applying or executing it', async () => {
  const calls = [], revision = 'a'.repeat(64), directory = 'F:\\packs\\source';
  const pack = { id: 'sample', version: '1.0.0', components: [{ id: 'provider', module: 'new.provider' }], bindings: [] };
  const draft = { format: 'world-hub.creator-draft/v1', directory, baseRevision: revision, pack, replacements: [{ componentId: 'provider', moduleDirectory: 'F:\\modules\\replacement' }], formValues: {}, selection: '', updatedAt: '2026-10-11T00:00:00Z' };
  const scene = harness(async (path, request) => {
    calls.push([path, request]);
    if (path === '/api/creator-drafts') return { drafts: [draft] };
    if (path === '/api/operations') return { operations: [] };
    if (path === '/api/sources') return { sources: [], conflicts: [] };
    if (path.endsWith('/inspect')) return { authoring: { revision, pack: { ...pack, components: [{ id: 'provider', module: 'old.provider' }] }, modules: [] } };
    if (path.endsWith('/preview')) return { preview: { compatible: false } };
    throw new Error('Unexpected mutation: ' + path);
  });
  scene.ui.sessionReady(); await new Promise(resolve => setImmediate(resolve)); scene.ui.navigate('creator');
  const root = scene.body.querySelector('#creator-content'); await byText(root, 'Recheck and restore').dispatch('click');
  assert.match(scene.body.textContent, /Candidate provider changed or is incompatible/);
  assert.equal(root.querySelector('.composition-graph'), null); assert.ok(byText(root, 'Recheck and restore'));
  assert.deepEqual(calls.find(([path]) => path.endsWith('/preview'))[1], { directory, componentId: 'provider', moduleDirectory: 'F:\\modules\\replacement', pack, replacements: draft.replacements, expectedRevision: revision });
  assert.ok(calls.every(([path]) => !path.endsWith('/derive') && !path.endsWith('/save') && !path.endsWith('/start')));
});

test('creator draft can be discarded and returns to launchpad, or safely exited back to launchpad with draft preserved', async () => {
  const directory = 'F:\\packs\\source', revision = 'a'.repeat(64);
  const pack = { id: 'sample', version: '1.0.0', title: 'Original', components: [{ id: 'provider', module: 'provider' }], bindings: [] };
  const calls = [];
  let drafts = [];
  const api = async (path, request) => {
    calls.push([path, request]);
    if (path === '/api/creator-drafts') return { drafts: structuredClone(drafts) };
    if (path === '/api/creator-drafts/save') { drafts = [request.draft]; return { draft: request.draft }; }
    if (path === '/api/creator-drafts/delete') { drafts = drafts.filter(d => d.directory !== request.directory); return { deleted: true }; }
    if (path === '/api/operations') return { operations: [] };
    if (path === '/api/sources') return { sources: [], conflicts: [] };
    if (path.endsWith('/inspect')) return { authoring: { revision, directory, pack: structuredClone(pack), modules: [{ id: 'provider', provides: [] }] } };
    throw new Error('Unexpected mutation: ' + path);
  };
  const scene = harness(api);
  scene.ui.navigate('creator');
  const root = scene.body.querySelector('#creator-content');
  root.querySelector('form').elements.directory.value = directory;
  await root.querySelector('form').dispatch('submit');

  assert.ok(root.querySelector('.creator-pack-top-actions'));
  assert.equal(root.querySelector('.studio-launchpad'), null);

  await byText(root, 'Discard draft').dispatch('click');

  assert.ok(calls.some(([path, body]) => path === '/api/creator-drafts/delete' && body.directory === directory));
  assert.equal(root.querySelector('.creator-pack-top-actions'), null);
  assert.ok(root.querySelector('.studio-launchpad'));

  root.querySelector('form').elements.directory.value = directory;
  await root.querySelector('form').dispatch('submit');
  assert.ok(root.querySelector('.creator-pack-top-actions'));

  await byText(root, '← Back to Launchpad').dispatch('click');
  assert.equal(root.querySelector('.creator-pack-top-actions'), null);
  assert.ok(root.querySelector('.studio-launchpad'));
  assert.ok(calls.some(([path]) => path === '/api/creator-drafts/save'));
});

test('creator removal requires confirmation and removes exactly its component, bindings, dependencies and draft source', async () => {
  const directory = 'F:\\packs\\source', revision = 'a'.repeat(64);
  const pack = { id: 'sample', version: '1.0.0', title: 'Original', components: [{ id: 'provider', module: 'provider', after: ['consumer'] }, { id: 'consumer', module: 'consumer', after: [] }], entry: { component: 'consumer' }, bindings: [{ from: 'provider', to: 'consumer', contract: { id: 'test', version: '1.0.0' } }] };
  const calls = [];
  const api = async (path, request) => {
    calls.push([path, request]);
    if (path === '/api/creator-drafts') return { drafts: [] };
    if (path === '/api/creator-drafts/save') return { draft: request.draft };
    if (path === '/api/operations') return { operations: [] };
    if (path === '/api/sources') return { sources: [], conflicts: [] };
    if (path === '/api/paths/known') return { objects: [{ kind: 'module', id: 'extra.mod', title: 'Extra Module', runtime: { kind: 'node' } }] };
    if (path.endsWith('/inspect')) return { authoring: { revision, directory, pack: structuredClone(pack), modules: [{ id: 'provider', provides: [] }, { id: 'consumer', requires: [] }] } };
    throw new Error('Unexpected mutation: ' + path);
  };
  let confirmation;
  const scene = harness(api, { confirmDialog: options => { confirmation = options; } });
  scene.ui.navigate('creator');
  const root = scene.body.querySelector('#creator-content');
  root.querySelector('form').elements.directory.value = directory;
  await root.querySelector('form').dispatch('submit');

  const scrollWrap = root.querySelector('.composition-nodes-scroll-wrap');
  assert.ok(scrollWrap, 'composition-nodes-scroll-wrap should be rendered');
  const addTriggerBtn = scrollWrap.querySelector('.node-add-trigger-btn');
  assert.ok(addTriggerBtn, 'Add module trigger button should exist in nodes bar');

  const deleteBtns = scrollWrap.querySelectorAll('.composition-node-delete-btn');
  assert.equal(deleteBtns.length, 2, 'Each component should have a delete button');

  // Trigger delete on consumer node
  await deleteBtns[1].dispatch('click');
  assert.ok(confirmation, 'Removal must open a confirmation');
  assert.equal(root.querySelectorAll('.composition-node').length, 2, 'No changes before confirmation');
  await confirmation.onConfirm();
  assert.deepEqual(root.querySelectorAll('.composition-node-id').map(node => node.textContent), ['provider']);
  await byText(root, 'Save draft now').dispatch('click');
  const saved = calls.filter(([path]) => path === '/api/creator-drafts/save').at(-1)[1].draft;
  assert.deepEqual(saved.pack.components.map(component => component.id), ['provider']);
  assert.deepEqual(saved.pack.components[0].after, []);
  assert.deepEqual(saved.pack.bindings, []);
  assert.equal(saved.pack.entry.component, 'provider');
  assert.deepEqual(saved.replacements, []);
});


test('save and delete failures preserve Creator edits, report failure and never claim a successful save or discard', async () => {
  const directory = 'F:\\packs\\save-failure', pack = { id: 'sample', version: '1.0.0', title: 'Original', components: [{ id: 'provider', module: 'provider' }], bindings: [] };
  let failure = 'save', persisted = [], toasts = [];
  const scene = harness(async (path, request) => {
    if (path.endsWith('/inspect')) return { authoring: { directory, revision: 'a'.repeat(64), pack: structuredClone(pack), modules: [{ id: 'provider', provides: [] }] } };
    if (path === '/api/creator-drafts/save') { if (failure === 'save') throw new Error('Disk unavailable'); persisted = [structuredClone(request.draft)]; return { draft: request.draft }; }
    if (path === '/api/creator-drafts/delete') { if (failure === 'delete') throw new Error('Authentication expired'); persisted = []; return { deleted: true }; }
    return {};
  }, { toast: text => toasts.push(text) });
  scene.ui.navigate('creator'); const root = scene.body.querySelector('#creator-content'); root.querySelector('form').elements.directory.value = directory; await root.querySelector('form').dispatch('submit');
  let derive = root.querySelector('#creator-derive-form'); derive.elements.packTitle.value = 'Unsaved changes'; await derive.dispatch('input');
  await byText(root, 'Save draft now').dispatch('click');
  assert.ok(root.querySelector('.creator-pack-top-actions')); assert.match(scene.body.textContent, /Disk unavailable/);
  assert.equal(persisted.length, 0); assert.equal(toasts.includes('Draft saved'), false);
  await byText(root, '← Back to Launchpad').dispatch('click');
  assert.ok(root.querySelector('.creator-pack-top-actions')); assert.equal(root.querySelector('#creator-derive-form').elements.packTitle.value, 'Unsaved changes');
  failure = ''; await byText(root, 'Save draft now').dispatch('click'); assert.equal(persisted[0].pack.title, 'Unsaved changes');
  failure = 'delete'; await byText(root, 'Discard draft').dispatch('click');
  assert.equal(persisted.length, 1); assert.ok(root.querySelector('.creator-pack-top-actions')); assert.match(scene.body.textContent, /Authentication expired/);
  assert.equal(toasts.some(text => /Draft discarded/.test(text)), false);
  failure = ''; await byText(root, '← Back to Launchpad').dispatch('click'); assert.ok(root.querySelector('.studio-launchpad')); assert.equal(persisted[0].pack.title, 'Unsaved changes');
});

test('new module completes real preflight, persistent draft restore, derivation, import and an explicitly started four-module runtime', { timeout: 90000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'world-hub-creator-ui-'));
  t.after(async () => { assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.ok(basename(temporary).startsWith('world-hub-creator-ui-')); await rm(temporary, { recursive: true, force: true }); });
  const repository = fileURLToPath(new URL('../../../', import.meta.url)), directory = join(temporary, 'source'), moduleDirectory = join(temporary, 'additional-module'), privateRoot = join(temporary, 'launcher');
  const environment = { nodePath: process.execPath, pythonPath: process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
  await cp(join(repository, 'examples/ecosystem-pack'), directory, { recursive: true }); await createLock(directory, environment);
  await initModule({ directory: moduleDirectory, id: 'thirdparty.additional', runtime: 'node' }); await mkdir(privateRoot);
  let registry = new CreatorDrafts(privateRoot); await registry.initialize(); let result;
  const calls = [], api = async (path, request) => {
    calls.push([path, request]);
    if (path === '/api/creator-drafts') return registry.list();
    if (path === '/api/creator-drafts/save') return registry.save(request.draft);
    if (path === '/api/creator-drafts/delete') return registry.delete(request.directory);
    if (path === '/api/paths/known') return { objects: [{ kind: 'module', id: 'thirdparty.additional', path: moduleDirectory, runtime: { kind: 'node' } }] };
    if (path === '/api/authoring/inspect') return { authoring: await inspectAuthoring(request.directory, request) };
    if (path === '/api/authoring/addition-preview') return { preview: await previewAddition(request.directory, request) };
    if (path === '/api/authoring/preview') return { preview: await previewReplacement(request.directory, request) };
    if (path === '/api/authoring/derive') { result = await derivePackage(request.directory, request); return result; }
    return {};
  };
  let scene = harness(api); Object.assign(scene.state.environmentSelection, environment); await scene.ui.loadKnown(); scene.ui.navigate('creator');
  let root = scene.body.querySelector('#creator-content'); root.querySelector('form').elements.directory.value = directory; await root.querySelector('form').dispatch('submit');
  await root.querySelector('.node-add-trigger-btn').dispatch('click');
  const addModal = scene.body.querySelector('.add-module-dialog');
  assert.ok(addModal);
  assert.ok(addModal.querySelector('.add-module-toolbar'));
  assert.ok(addModal.querySelector('.add-module-search-input'));
  const addItems = addModal.querySelectorAll('.add-module-item');
  assert.ok(addItems.length > 0);
  assert.ok(addItems[0].querySelector('.module-avatar'));
  assert.ok(addItems[0].querySelector('.add-module-item-left'));
  assert.ok(addItems[0].querySelector('.add-module-item-ident'));
  assert.ok(addItems[0].querySelector('.add-module-item-right'));
  const searchInput = addModal.querySelector('.add-module-search-input');
  assert.ok(searchInput);
  searchInput.value = 'nonexistent-query-xyz';
  searchInput.dispatchEvent(new Event('input'));
  assert.equal(addItems.every(item => item.hidden || item.style?.display === 'none'), true);
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input'));
  assert.equal(addItems.some(item => !item.hidden && item.style?.display !== 'none'), true);
  await byText(addModal, 'Add to Assembly').dispatch('click');
  const dialog = scene.body.querySelectorAll('dialog').find(dialog => dialog.open && dialog.attributes['aria-label'] === 'Configure and review a new module'); assert.ok(dialog);
  const addition = dialog.querySelector('form'); assert.deepEqual(JSON.parse(addition.elements.bridges.value), { main: { publish: [], subscribe: [] } });
  addition.elements.bridges.value = JSON.stringify({ main: { publish: ['stats'], subscribe: ['stats'] } });
  addition.elements.settings.value = JSON.stringify({ topicKey: 'stats', callerId: 'desk' });
  await addition.dispatch('submit'); assert.equal(root.querySelectorAll('.composition-node').length, 3, 'Changes require reviewing the updated preflight first');
  await addition.dispatch('submit'); assert.equal(root.querySelectorAll('.composition-node').length, 4);
  await byText(root, 'Save draft now').dispatch('click');
  const saved = (await registry.list()).drafts[0]; assert.equal(saved.pack.components.find(component => component.id === 'additional').module, 'thirdparty.additional'); assert.match(saved.replacements[0].candidateDigest, /^[a-f0-9]{64}$/);
  registry = new CreatorDrafts(privateRoot); await registry.initialize(); scene = harness(api); Object.assign(scene.state.environmentSelection, environment); scene.ui.sessionReady(); await new Promise(resolve => setImmediate(resolve)); scene.ui.navigate('creator');
  root = scene.body.querySelector('#creator-content'); await byText(root, 'Recheck and restore').dispatch('click');
  assert.equal(root.querySelectorAll('.composition-node').length, 4); assert.equal(scene.state.reviews.size, 0); assert.equal(scene.state.trustReview, null);
  const derive = root.querySelector('#creator-derive-form'); derive.elements.destination.value = join(temporary, 'derived'); await derive.dispatch('submit'); assert.equal(result, undefined);
  await (await consent(scene.body)).dispatch('click'); assert.ok(result?.directory); assert.equal(result.pack.components.length, 4);
  assert.equal(result.pack.components.find(component => component.id === 'additional').module, 'thirdparty.additional');
  assert.equal((await inspectAuthoring(directory, environment)).pack.components.length, 3, 'Original source remains unchanged');
  assert.ok(calls.every(([path]) => !path.endsWith('/start')), 'Authoring grants no execution consent');
  const runtimeRoot = join(temporary, 'runtime'), imported = await importPackage(result.directory, { root: runtimeRoot, instanceId: 'four-modules', ...environment });
  assert.equal(imported.instanceId, 'four-modules');
  await assert.rejects(readFile(join(runtimeRoot, 'instances', 'four-modules', 'status.json')), { code: 'ENOENT' }, 'Import must not create a running status or start processes');
  const session = await startInstance({ root: runtimeRoot, instanceId: 'four-modules', trust: imported.digest, ...environment }); t.after(() => session.close());
  const status = await session.status(); assert.equal(status.state, 'running'); assert.equal(status.components.length, 4);
  const response = await fetch(new URL('/analyze', session.ready.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 200);
  await session.close(); assert.equal((await session.status()).state, 'stopped');
});

test('UI source modules have no markup execution sinks or private credential links', async () => {
  for (const filename of ['app.mjs', 'advanced.mjs', 'icons.mjs']) { const source = await readFile(new URL(`../../../tools/launcher/public/${filename}`, import.meta.url), 'utf8'); assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/); }
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
