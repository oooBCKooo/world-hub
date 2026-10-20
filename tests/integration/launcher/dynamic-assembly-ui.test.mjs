import test from 'node:test';
import assert from 'node:assert/strict';
import { createDynamicAssemblyUi } from '../../../tools/launcher/public/dynamic-assembly-ui.mjs';
import { pathPurpose } from '../../../tools/launcher/public/path-ui.mjs';
import { element } from './ui-dom.mjs';

const contract = { id: 'test.text', version: '1.0.0' };
const manifest = (id, provides = [], requires = []) => ({ id, version: '1.0.0', runtime: { kind: 'node', entry: 'main.mjs' }, bridges: ['main'], provides, requires, permissions: { processes: 'none' } });
const defaults = { title: { zh: '客户端', en: 'Client' }, settings: [{ key: 'message', type: 'string', label: { zh: '消息', en: 'Message' }, default: 'Initial 🌍\r\nText' }], topics: { text: 'example/text' }, bridges: { main: { publish: ['text'], subscribe: ['text'] } } };
function assembly() {
  return { revision: 'revision-1', policy: 'fail-fast', programs: [
    { componentId: 'source.a', module: { id: 'test.source', version: '1.0.0' }, manifest: manifest('test.source', [contract]), state: 'running', origin: 'baseline', settings: { message: 'Preserve source' }, topics: defaults.topics, bridges: defaults.bridges, bindings: [], sourceDirectory: 'F:\\installed\\source-a' },
    { componentId: 'source.b', module: { id: 'test.source', version: '1.0.0' }, manifest: manifest('test.source', [{ ...contract, version: '2.0.0' }]), state: 'running', origin: 'dynamic', topics: defaults.topics, bridges: defaults.bridges, bindings: [] },
    { componentId: 'client', module: { id: 'test.client', version: '1.0.0' }, manifest: manifest('test.client', [], [contract]), deployment: defaults, state: 'stopped', origin: 'baseline', settings: { message: 'Current client' }, topics: defaults.topics, bridges: defaults.bridges, bindings: [{ providerId: 'source.a', contract }] }
  ], external: [{ componentId: 'external', title: 'Outside', principal: 'external.identity', communication: 'connected', topics: defaults.topics, bridges: defaults.bridges, provides: [], requires: [], bindings: [] }] };
}

function scene(language = 'en', options = {}) {
  const body = element('body'), requests = [], opened = [], selected = [], current = assembly();
  globalThis.document = { body };
  const api = async (path, input) => {
    requests.push({ path, input: input === undefined ? undefined : structuredClone(input) });
    if (options.api) { const result = await options.api(path, input, current); if (result !== undefined) return result; }
    if (path === '/api/instances/pack%20one/assembly') return { assembly: structuredClone(current), runId: 'run-one' };
    if (path === '/api/deployment/inspect') return { directory: input.directory, manifest: manifest('test.client', [], [contract]), deploymentReview: { deployment: defaults } };
    if (path.endsWith('/assembly/preview')) return { reviewId: 'exact-review', preview: { operation: structuredClone(input), affected: [input.componentId] } };
    if (path.endsWith('/assembly/apply')) { assert.deepEqual(input, { reviewId: 'exact-review', accepted: true }); return { operationId: 'assembly-operation' }; }
    if (path === '/api/operations/assembly-operation') return { operation: { state: 'succeeded', result: options.result ?? { assembly: current } } };
    throw new Error(`Unexpected action: ${path}`);
  };
  const ui = createDynamicAssemblyUi({ state: { language }, api, el: element,
    button: (title, action, className) => element('button', { type: 'button', class: className, onclick: action }, title),
    getModules: () => [{ id: 'test.client', version: '1.0.0', path: 'F:\\module-old' }, { id: 'test.client', version: '2.0.0', path: 'F:\\module-new' }],
    openPathPicker: (input, purpose) => { selected.push(purpose); input.value = 'F:\\picked-module'; },
    openCreatorFromInstance: async id => opened.push(id), refresh: async () => {}, toast() {} });
  return { ui, body, current, requests, opened, selected };
}

async function click(root, text) {
  const node = root.querySelectorAll('button').find(node => node.textContent === text);
  assert.ok(node, `Missing button ${text}`); await node.dispatch('click'); return node;
}
const openDialog = (scene, selector) => scene.body.querySelectorAll(selector ?? 'dialog').find(row => row.open);
async function accept(scene, language = 'en') {
  const dialog = openDialog(scene, '.dynamic-assembly-review'), check = dialog.querySelector('[name=acceptAssemblyChange]');
  assert.ok(check); check.checked = true; await check.dispatch('change');
  await click(dialog, language === 'zh' ? '确认并应用' : 'Confirm and apply');
}

test('DYNAMIC-UI bilingual member controls review the exact selected target and never manage external processes', async () => {
  for (const language of ['en', 'zh']) {
    const view = scene(language), original = structuredClone(view.current); await view.ui.open({ instanceId: 'pack one' });
    const dialog = openDialog(view), cards = dialog.querySelectorAll('.dynamic-managed-member');
    assert.deepEqual(cards.map(row => row.dataset.componentId), ['source.a', 'source.b', 'client']);
    assert.match(dialog.textContent, language === 'zh' ? /本实例新增/ : /Added to this instance/);
    assert.equal(dialog.querySelector('.dynamic-external-member').querySelectorAll('button').length, 1, 'External connections offer revocation, never process stop');
    await click(cards[1], language === 'zh' ? '审阅停止' : 'Review stop');
    const review = openDialog(view, '.dynamic-assembly-review'), confirm = review.querySelectorAll('button').find(node => node.textContent === (language === 'zh' ? '确认并应用' : 'Confirm and apply'));
    assert.equal(confirm.disabled, true); await confirm.dispatch('click');
    assert.equal(view.requests.filter(row => row.path.endsWith('/apply')).length, 0);
    assert.deepEqual(view.requests.find(row => row.path.endsWith('/preview')).input, { action: 'stop', componentId: 'source.b', expectedRevision: 'revision-1', expectedRunId: 'run-one' });
    await accept(view, language); assert.equal(view.requests.filter(row => row.path.endsWith('/apply')).length, 1);
    assert.deepEqual(view.current, original, 'Frontend review never mutates the inventory or another target');
    await click(dialog, language === 'zh' ? '载入工作台' : 'Load in workbench'); assert.deepEqual(view.opened, ['pack one']); assert.equal(dialog.open, false);
  }
});

test('DYNAMIC-UI add uses exact source/defaults and exact contract providers, preserves text, and requires a separate start', async () => {
  const view = scene(); await view.ui.open('pack one'); await click(openDialog(view), 'Hot-plug module (this run only)');
  const editor = openDialog(view, '.dynamic-member-editor'), versions = editor.querySelector('[name=moduleVersion]');
  assert.equal(versions.options.length, 3); assert.match(versions.options[2].textContent, /2\.0\.0/);
  versions.value = '1'; await versions.dispatch('change'); await click(editor, 'Load deployment defaults');
  assert.deepEqual(view.requests.find(row => row.path === '/api/deployment/inspect').input, { directory: 'F:\\module-new' });
  const input = editor.querySelector('[name=componentId]'); input.value = 'new.client';
  const text = editor.querySelector('[name="setting:message"]'); assert.equal(text.tagName, 'textarea'); text.value = 'Edited 🌏\r\nSecond line'; await text.dispatch('input');
  const provider = editor.querySelector('select').parent.parent.querySelectorAll('select').find(row => row.name.startsWith('provider:'));
  assert.ok(provider); assert.deepEqual(provider.options.map(row => row.value), ['', 'source.a'], 'A different contract version is not selectable');
  await click(editor, 'Review and add');
  const preview = view.requests.find(row => row.path.endsWith('/preview')).input;
  assert.equal(preview.directory, 'F:\\module-new'); assert.equal(preview.componentId, 'new.client'); assert.equal(preview.settings.message, text.value);
  assert.deepEqual(preview.bindings, [{ providerId: 'source.a', contract }]);
  assert.deepEqual(preview.topics, defaults.topics); assert.deepEqual(preview.bridges, defaults.bridges);
  assert.equal(view.requests.filter(row => row.path.endsWith('/apply')).length, 0); await accept(view);
  assert.equal(view.requests.filter(row => row.input?.action === 'start').length, 0, 'Add does not silently start the new member');
});

test('DYNAMIC-UI chosen directory must be inspected again and delegates one validated picker to path-ui', async () => {
  const view = scene(); await view.ui.open('pack one'); await click(openDialog(view), 'Hot-plug module (this run only)');
  const editor = openDialog(view, '.dynamic-member-editor'), directory = editor.querySelector('[name=moduleDirectory]');
  assert.equal(directory.dataset.pathPurpose, 'module'); assert.equal(pathPurpose(directory), 'module');
  assert.equal(editor.querySelectorAll('button').some(row => /Choose folder|Browse/.test(row.textContent)), false, 'Only the shared path-ui enhancer supplies a directory picker');
  directory.value = 'F:\\picked-module';
  await click(editor, 'Load deployment defaults'); editor.querySelector('[name=moduleDirectory]').value = 'F:\\unreviewed';
  await click(editor, 'Review and add'); assert.match(editor.textContent, /currently selected folder/); assert.equal(view.requests.filter(row => row.path.endsWith('/preview')).length, 0);
});

test('DYNAMIC-UI configuration preserves current public values and leaves edits visible when backend requires stopping the member', async () => {
  const view = scene('en', { api: async (path, input) => {
    if (path.endsWith('/preview')) throw new Error('Stop client before configuring this member.');
  } });
  await view.ui.open('pack one'); const card = openDialog(view).querySelectorAll('.dynamic-managed-member')[2];
  await click(card, 'Configure settings and wiring'); const editor = openDialog(view, '.dynamic-member-editor');
  assert.match(editor.textContent, /other programs are not restarted automatically/);
  const text = editor.querySelector('[name="setting:message"]'); assert.equal(text.value, 'Current client'); text.value = 'Keep my edit'; await text.dispatch('input');
  await click(editor, 'Review configuration change'); assert.match(editor.textContent, /Stop client before/); assert.equal(text.value, 'Keep my edit'); assert.equal(editor.open, true);
  assert.equal(view.requests.find(row => row.path.endsWith('/preview')).input.settings.message, 'Keep my edit');
  assert.equal(view.requests.some(row => row.path.endsWith('/apply')), false); assert.equal(view.current.programs[2].settings.message, 'Current client');
});

test('DYNAMIC-UI external authorization is reviewed and credentials are explicitly revealed then removed on close', async () => {
  const token = 'private-token-not-in-inventory', view = scene('en', { result: { connection: { token, principal: 'third-party', hubUrl: 'ws://127.0.0.1:9200' } } });
  await view.ui.open('pack one'); await click(openDialog(view), 'Authorize external program');
  const editor = openDialog(view, '.dynamic-external-editor'); editor.querySelector('[name=componentId]').value = 'external.new';
  editor.querySelector('[name=externalTopics]').value = JSON.stringify(defaults.topics);
  editor.querySelector('[name=externalBridges]').value = JSON.stringify(defaults.bridges);
  await click(editor, 'Review connection authorization'); assert.equal(view.body.textContent.includes(token), false);
  assert.equal(view.requests.find(row => row.path.endsWith('/preview')).input.action, 'admit-external');
  await accept(view); const connection = openDialog(view, '.dynamic-connection-dialog'); assert.ok(connection);
  assert.equal(connection.textContent.includes(token), false); await click(connection, 'Reveal connection configuration'); assert.equal(connection.textContent.includes(token), true);
  const revealed = connection.querySelector('pre'); connection.close(); assert.equal(revealed.textContent, ''); assert.equal(view.body.textContent.includes(token), false);
  assert.equal(view.requests.some(row => /\/(start|stop)$/.test(row.path)), false);
});

test('DYNAMIC-UI failure policy and external revocation use separate explicit reviews', async () => {
  const view = scene(); await view.ui.open('pack one'); const dialog = openDialog(view);
  const policy = dialog.querySelector('[name=lifecyclePolicy]'); assert.equal(policy.value, 'fail-fast'); policy.value = 'independent';
  await click(dialog, 'Review failure policy'); assert.deepEqual(view.requests.find(row => row.path.endsWith('/preview')).input, { action: 'set-policy', policy: 'independent', expectedRevision: 'revision-1', expectedRunId: 'run-one' });
  assert.equal(view.requests.some(row => row.path.endsWith('/apply')), false); await accept(view);
  await click(dialog.querySelector('.dynamic-external-member'), 'Review connection revocation');
  assert.deepEqual(view.requests.filter(row => row.path.endsWith('/preview')).at(-1).input, { action: 'revoke-external', componentId: 'external', expectedRevision: 'revision-1', expectedRunId: 'run-one' });
  assert.equal(view.requests.filter(row => row.path.endsWith('/apply')).length, 1, 'Revocation has not yet been accepted');
});

test('DYNAMIC-UI invalid external declaration stays editable without sending a preview', async () => {
  const view = scene(); await view.ui.open('pack one'); await click(openDialog(view), 'Authorize external program'); const editor = openDialog(view, '.dynamic-external-editor');
  editor.querySelector('[name=externalTopics]').value = '{invalid'; await click(editor, 'Review connection authorization');
  assert.match(editor.textContent, /must contain valid JSON/); assert.equal(editor.open, true); assert.equal(view.requests.some(row => row.path.endsWith('/preview')), false);
});

test('DYNAMIC-UI incomplete inventory is an explicit error instead of pretending the assembly is empty', async () => {
  const view = scene('en', { api: async path => path.endsWith('/assembly') ? { assembly: { programs: [] } } : undefined });
  await view.ui.open('pack one'); const dialog = openDialog(view); assert.match(dialog.textContent, /no managed-member and external-connection inventory/);
  assert.equal(dialog.querySelectorAll('.dynamic-managed-member').length, 0); assert.equal(dialog.querySelectorAll('button').length, 1);
});

test('DYNAMIC-UI a refresh outage after accepted admission still exposes the one-time configuration and never resubmits', async () => {
  let reads = 0;
  const token = 'one-time-recoverable', view = scene('en', { result: { connection: { token } }, api: async path => {
    if (path.endsWith('/assembly') && ++reads > 1) throw new Error('Inventory temporarily unavailable');
  } });
  await view.ui.open('pack one'); await click(openDialog(view), 'Authorize external program'); const editor = openDialog(view, '.dynamic-external-editor');
  editor.querySelector('[name=componentId]').value = 'outside'; await click(editor, 'Review connection authorization'); await accept(view);
  assert.match(view.body.textContent, /Inventory temporarily unavailable/);
  const connection = openDialog(view, '.dynamic-connection-dialog'); assert.ok(connection); await click(connection, 'Reveal connection configuration'); assert.match(connection.textContent, /one-time-recoverable/);
  assert.equal(view.requests.filter(row => row.path.endsWith('/apply')).length, 1);
});

test('DYNAMIC-UI missing deployment defaults refuses a novice add without inventing settings or bridge permissions', async () => {
  const view = scene('en', { api: async path => path === '/api/deployment/inspect' ? { manifest: manifest('without.defaults') } : undefined });
  await view.ui.open('pack one'); await click(openDialog(view), 'Hot-plug module (this run only)'); const editor = openDialog(view, '.dynamic-member-editor');
  editor.querySelector('[name=moduleDirectory]').value = 'F:\\no-defaults'; await click(editor, 'Load deployment defaults');
  assert.match(editor.textContent, /author must supply deployment\.json/); await click(editor, 'Review and add');
  assert.equal(view.requests.some(row => row.path.endsWith('/preview')), false); assert.equal(editor.open, true);
});

test('DYNAMIC-UI removing the current entry requires an explicit remaining managed replacement before review', async () => {
  const view = scene(); view.current.pack = { entry: { component: 'client' } }; await view.ui.open('pack one');
  await click(openDialog(view).querySelectorAll('.dynamic-managed-member')[2], 'Review removal');
  const editor = openDialog(view, '.dynamic-entry-removal'), select = editor.querySelector('[name=replacementEntry]');
  assert.deepEqual(select.options.map(row => row.value), ['', 'source.a', 'source.b'], 'External processes cannot become managed entry candidates');
  await click(editor, 'Review entry removal'); assert.match(editor.textContent, /Explicitly choose/); assert.equal(view.requests.some(row => row.path.endsWith('/preview')), false);
  select.value = 'source.b'; await click(editor, 'Review entry removal');
  assert.deepEqual(view.requests.find(row => row.path.endsWith('/preview')).input, { action: 'remove', componentId: 'client', entry: 'source.b', expectedRevision: 'revision-1', expectedRunId: 'run-one' });
  assert.equal(view.requests.some(row => row.path.endsWith('/apply')), false); await accept(view); assert.equal(view.requests.filter(row => row.path.endsWith('/apply')).length, 1);
});
