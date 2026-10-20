import test from 'node:test';
import assert from 'node:assert/strict';
import { createDynamicAssemblyUi } from '../../../tools/launcher/public/dynamic-assembly-ui.mjs';
import { runtimeDesignChange, renderLivePermissionMatrix, renderObservedExternalSessions } from '../../../tools/launcher/public/dynamic-modules-tab.mjs';
import { element } from './ui-dom.mjs';
const flush = () => new Promise(done => setImmediate(done));
const button = (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, disabled, onclick: action }, title);
const byText = (root, text) => root.querySelectorAll('button').find(row => row.textContent === text);
async function click(root, text) { const found = byText(root, text); assert.ok(found, `Missing ${text}`); await found.dispatch('click'); }
const deployment = { title: 'Current module', settings: [{ key: 'text', type: 'string', default: 'Initial' }], topics: { data: 'example/data' }, bridges: { main: { publish: ['data'], subscribe: ['data'] } } };
const manifest = { id: 'example.worker', version: '1.0.0', bridges: ['main'], provides: [], requires: [], runtime: { kind: 'node', entry: 'main.mjs' } };
function pack() { return { id: 'test.pack', version: '1.0.1', packType: 'mesh', lifecyclePolicy: 'independent', topics: { data: 'example/data' }, bindings: [], entry: { component: 'worker' }, components: [{ id: 'worker', module: manifest.id, after: [], autostart: false, settings: { text: 'Current saved' }, bridges: deployment.bridges }] }; }
function fixture({ language = 'en', modified = false, external = false, handler, result, summarized = false, context = {} } = {}) {
  const body = element('body'); globalThis.document = { body };
  const saved = pack(), live = structuredClone(saved); if (modified) live.components[0].settings.text = 'Unsaved runtime';
  const row = { componentId: 'worker', origin: 'baseline', ownership: 'managed', module: { id: manifest.id, version: '1.0.0' }, manifest, deployment, state: 'stopped', autostart: false, principal: 'pack.worker', topics: deployment.topics, bridges: deployment.bridges, settings: live.components[0].settings, after: [], bindings: [] };
  const assembly = { revision: 99, pack: live, programs: [row], external: external ? [{ componentId: 'outside', title: 'Outside', ownership: 'external', principal: 'pack.outside', communication: 'connected', topics: deployment.topics, bridges: deployment.bridges, bindings: [], provides: [], requires: [] }] : [] };
  const owner = { instanceId: 'pack one', packageDirectory: 'F:/saved/package', pack: saved, status: { runId: 'run-current', state: 'running', executionProfile: 'trusted-local', assembly: { revision: 99 }, components: [{ id: 'worker', process: 'stopped' }] } };
  if (summarized) owner.pack = { id: saved.id, version: saved.version, packType: saved.packType, lifecyclePolicy: saved.lifecyclePolicy, components: saved.components.map(row => ({ id: row.id, module: row.module, after: row.after, autostart: row.autostart })) };
  const calls = [], notices = [], opened = [], stopped = [], starts = []; let refreshed = 0;
  const state = { language, instances: [owner], reviews: new Map() };
  const api = async (path, input) => {
    calls.push({ path, input: input === undefined ? undefined : structuredClone(input) });
    if (handler) { const custom = await handler(path, input, assembly); if (custom !== undefined) return custom; }
    if (path === '/api/instances/pack%20one/assembly') return { assembly: structuredClone(assembly), runId: owner.status.runId };
    if (path === '/api/authoring/inspect') return { authoring: { pack: structuredClone(saved), directory: input.directory, revision: 'checked-current-source' } };
    if (path === '/api/deployment/inspect') return { manifest, deploymentReview: { deployment } };
    if (path.endsWith('/preview')) return { reviewId: 'review-current', preview: { runId: owner.status.runId, operation: input } };
    if (path.endsWith('/apply')) return { operationId: 'operation-current' };
    if (path === '/api/operations/operation-current') return { operation: { state: 'succeeded', result: result ?? {} } };
    throw new Error(`Unexpected ${path}`);
  };
  const ui = createDynamicAssemblyUi({ state, api, el: element, button, toast: text => notices.push(text), getModules: () => [{ id: manifest.id, version: '1.0.0', path: 'F:/new-module' }], refresh: async () => refreshed++, openCreatorFromInstance: async id => opened.push(id), stopInstance: async id => stopped.push(id), reviewInstance: async (...args) => starts.push(args), ...context });
  const node = ui.render(owner); body.append(node);
  return { body, state, owner, assembly, saved, calls, notices, opened, stopped, starts, ui, node, get refreshed() { return refreshed; } };
}

test('DYNAMIC-TAB bilingual embedded inventory keeps stopped baseline members, external ownership and bridge declarations visible without dialogs', async () => {
  for (const language of ['zh', 'en']) {
    const view = fixture({ language, external: true }); await flush();
    assert.equal(view.body.querySelector('dialog'), null); assert.equal(view.node.querySelectorAll('.dynamic-managed-member').length, 1);
    const row = view.node.querySelector('.dynamic-managed-member'); assert.match(row.textContent, language === 'zh' ? /初始组合/ : /Initial composition/); assert.match(row.textContent, language === 'zh' ? /手动启动/ : /Manual start/);
    assert.equal(byText(row, language === 'zh' ? '启动' : 'Start').disabled, false);
    const outside = view.node.querySelector('.dynamic-external-member'); assert.equal(outside.querySelectorAll('button').length, 1); assert.doesNotMatch(outside.querySelector('button').textContent, /Stop|停止/);
    assert.ok(view.node.querySelector('[data-live-permissions]')); assert.match(view.node.querySelector('[data-live-permissions]').textContent, /example\/data/);
  }
});

test('DYNAMIC-TAB revision and process state alone are not design edits; current saved declarations are the comparison baseline', async () => {
  const clean = fixture(); await flush(); assert.equal(clean.node.querySelector('[data-dynamic-design-changed]'), null);
  clean.assembly.revision = 101; clean.assembly.programs[0].state = 'running'; await clean.ui.refresh(clean.owner); assert.equal(clean.node.querySelector('[data-dynamic-design-changed]'), null);
  assert.equal(runtimeDesignChange(clean.assembly, clean.saved).changed, false);
  const changed = fixture({ modified: true }); await flush(); assert.ok(changed.node.querySelector('[data-dynamic-design-changed]')); await click(changed.node, 'Load in workbench and save a version'); assert.deepEqual(changed.opened, ['pack one']); assert.equal(changed.calls.some(row => /\/apply$/.test(row.path)), false);
});

test('DYNAMIC-TAB direct member lifecycle performs fresh run-bound preview/apply exactly once and never requires a checkbox', async () => {
  const view = fixture(); await flush(); await click(view.node.querySelector('.dynamic-managed-member'), 'Start');
  assert.deepEqual(view.calls.find(row => row.path.endsWith('/preview')).input, { action: 'start', componentId: 'worker', expectedRevision: 99, expectedRunId: 'run-current' });
  assert.deepEqual(view.calls.find(row => row.path.endsWith('/apply')).input, { reviewId: 'review-current', accepted: true }); assert.equal(view.refreshed, 1);
  assert.equal(view.node.querySelector('[name=acceptAssemblyChange]'), null); assert.equal(view.body.querySelector('dialog'), null);
});

test('DYNAMIC-TAB inline configuration preserves draft through refresh and uses a separate preview confirmation without forced consent checkbox', async () => {
  const view = fixture(); await flush(); await click(view.node, 'Configure settings and wiring');
  const editor = view.node.querySelector('.dynamic-member-editor'), text = editor.querySelector('[name="setting:text"]'); text.value = 'Keep inline draft 🌍'; await text.dispatch('input');
  assert.equal(view.ui.render(view.owner), view.node); await view.ui.refresh(view.owner); assert.equal(text.value, 'Keep inline draft 🌍'); assert.equal(editor.open, true);
  await click(editor, 'Review configuration change'); const review = view.node.querySelector('.dynamic-assembly-review'); assert.ok(review); assert.equal(review.querySelector('[name=acceptAssemblyChange]'), null); assert.equal(view.calls.some(row => row.path.endsWith('/apply')), false);
  await click(review, 'Confirm and apply'); assert.equal(view.calls.filter(row => row.path.endsWith('/apply')).length, 1); assert.equal(view.calls.find(row => row.path.endsWith('/preview')).input.settings.text, 'Keep inline draft 🌍'); assert.equal(view.calls.some(row => row.input?.action === 'start'), false);
});

test('DYNAMIC-TAB stopped, isolated and stale states never query mutable assembly or expose usable lifecycle actions', async () => {
  for (const scenario of ['stopped', 'isolated', 'stale']) {
    const view = fixture(); await flush(); const before = view.calls.length;
    if (scenario === 'stopped') Object.assign(view.owner.status, { state: 'stopped', stoppedAt: 'now' });
    if (scenario === 'isolated') view.owner.status.executionProfile = 'container';
    if (scenario === 'stale') view.owner.status.observation = 'stale';
    const node = view.ui.render(view.owner); await flush(); assert.equal(view.calls.length, before); assert.equal(node.querySelector('.dynamic-managed-member'), null);
    if (scenario === 'stopped') { assert.equal(byText(node, 'Review and start instance'), undefined); }
  }
});

test('DYNAMIC-TAB failed freshness/ownership/source checks never apply or silently retry lifecycle actions', async () => {
  for (const scenario of ['run', 'external', 'cleanup', 'revision', 'source']) {
    let gate = false;
    const view = fixture({ handler: async (path, input, assembly) => {
      if (!gate) return;
      if (path.endsWith('/assembly')) return { runId: scenario === 'run' ? 'different-run' : 'run-current', assembly: { ...assembly, programs: scenario === 'external' ? [] : [{ ...assembly.programs[0], cleanupIncomplete: scenario === 'cleanup' }] } };
      if (path.endsWith('/preview') && scenario === 'revision') throw new Error('Assembly changed; refresh first');
      if (path.endsWith('/apply') && scenario === 'source') throw new Error('Reviewed source changed');
    } }); await flush(); gate = true; const outcome = await view.ui.reviewComponentAction(view.owner, 'worker', 'start');
    assert.ok(outcome.error); assert.ok(view.notices.length); assert.equal(view.calls.filter(row => row.path.endsWith('/apply')).length, scenario === 'source' ? 1 : 0); assert.ok(view.calls.filter(row => row.path.endsWith('/preview')).length <= 1);
  }
});

test('DYNAMIC-TAB inline credentials survive observation refresh but are cleared on run/language change or leaving the tab', async () => {
  for (const invalidate of ['run', 'language', 'leave']) {
    const view = fixture({ result: { connection: { token: 'one-time-private', principal: 'new-external' } } }); await flush(); await click(view.node, 'Authorize external program');
    const editor = view.node.querySelector('.dynamic-external-editor'); editor.querySelector('[name=componentId]').value = 'outside'; editor.querySelector('[name=externalTopics]').value = JSON.stringify(deployment.topics); editor.querySelector('[name=externalBridges]').value = JSON.stringify(deployment.bridges);
    await click(editor, 'Review connection authorization'); await click(view.node.querySelector('.dynamic-assembly-review'), 'Confirm and apply');
    const connection = view.node.querySelector('.dynamic-connection-dialog'); await click(connection, 'Reveal connection configuration'); const secret = connection.querySelector('[data-dynamic-secret]'); assert.match(secret.textContent, /one-time-private/);
    await view.ui.refresh(view.owner); assert.match(secret.textContent, /one-time-private/);
    if (invalidate === 'run') { view.owner.status.runId = 'new-run'; view.ui.render(view.owner); }
    else if (invalidate === 'language') { view.state.language = 'zh'; view.ui.render(view.owner); }
    else view.ui.deactivate();
    assert.equal(secret.textContent, ''); assert.equal(view.node.querySelector('.dynamic-connection-dialog'), null);
  }
});

test('DYNAMIC-TAB restore is an explicit stop-then-reviewed-start path and never clears business data or restarts automatically', async () => {
  const view = fixture({ modified: true }); await flush(); await click(view.node, 'Restore saved composition…'); const restore = view.node.querySelector('.dynamic-restore-saved'); assert.match(restore.textContent, /business data is not cleared/);
  assert.deepEqual(view.stopped, []); await click(restore, 'Stop this run to restore'); assert.deepEqual(view.stopped, ['pack one']); assert.deepEqual(view.starts, []);
  Object.assign(view.owner.status, { state: 'stopped', stoppedAt: 'now' }); const stopped = view.ui.render(view.owner); assert.equal(byText(stopped, 'Review and start instance'), undefined);
  assert.ok(view.calls.every(row => !/delete|restore|reset/.test(row.path)));
});

test('DYNAMIC-TAB permission view separates slot declarations and principal union; external observations require exact live run', () => {
  const { assembly, state, owner } = fixture(); assembly.programs[0].bridges = { read: { publish: [], subscribe: ['data'] }, write: { publish: ['other'], subscribe: [] } }; assembly.programs[0].topics.other = 'example/other';
  const matrix = renderLivePermissionMatrix({ state, el: element }, assembly); assert.match(matrix.textContent, /not an additional observation of Hub ACL/); assert.match(matrix.querySelector('[data-principal-grant-union]').textContent, /Union publish: example\/other.*Union subscribe: example\/data/);
  state.topology = { instanceId: 'pack one', runId: 'old-run', observation: 'live', bridges: [{ principal: 'unlisted', ownership: 'external', session: 8 }] }; assert.equal(renderObservedExternalSessions({ state, el: element }, owner, assembly), null);
  state.topology.runId = owner.status.runId; const observed = renderObservedExternalSessions({ state, el: element }, owner, assembly); assert.match(observed.textContent, /unlisted.*session 8/); assert.equal(observed.querySelectorAll('button').length, 0);
});


test('DYNAMIC-TAB leaving while an inline preview is pending discards its controls and never applies stale permission consent', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const view = fixture({ handler: async path => path.endsWith('/preview') ? gate : undefined }); await flush();
  await click(view.node, 'Configure settings and wiring'); const editor = view.node.querySelector('.dynamic-member-editor');
  const pending = byText(editor, 'Review configuration change').dispatch('click'); await flush(); view.ui.deactivate();
  release({ reviewId: 'old-page-review', preview: { kind: 'configure' } }); await pending;
  assert.equal(view.node.querySelector('.dynamic-assembly-review'), null); assert.equal(view.node.querySelector('.dynamic-member-editor'), null); assert.equal(view.calls.some(row => row.path.endsWith('/apply')), false);
});

test('DYNAMIC-TAB repeated direct lifecycle clicks share one owned-member operation instead of dispatching twice', async () => {
  let block = false, release;
  const gate = new Promise(done => { release = done; });
  const view = fixture({ handler: async (path, input, assembly) => {
    if (block && path.endsWith('/assembly')) { await gate; return { assembly, runId: 'run-current' }; }
  } }); await flush(); block = true; const before = view.calls.filter(row => row.path.endsWith('/assembly')).length;
  const first = view.ui.reviewComponentAction(view.owner, 'worker', 'start'); await flush(); const second = view.ui.reviewComponentAction(view.owner, 'worker', 'start'); await second; release(); await first;
  assert.equal(view.calls.filter(row => row.path.endsWith('/assembly')).length, before + 1); assert.equal(view.calls.filter(row => row.path.endsWith('/preview')).length, 1); assert.equal(view.calls.filter(row => row.path.endsWith('/apply')).length, 1);
});


test('DYNAMIC-TAB leaving during accepted admission allows the operation to finish without refreshing old editors or exposing its token', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const view = fixture({ handler: async path => path.endsWith('/apply') ? gate : undefined, result: { connection: { token: 'must-not-appear-after-leaving' } } }); await flush();
  await click(view.node, 'Authorize external program'); const editor = view.node.querySelector('.dynamic-external-editor');
  editor.querySelector('[name=componentId]').value = 'outside'; editor.querySelector('[name=externalTopics]').value = JSON.stringify(deployment.topics); editor.querySelector('[name=externalBridges]').value = JSON.stringify(deployment.bridges);
  await click(editor, 'Review connection authorization'); const review = view.node.querySelector('.dynamic-assembly-review'); const pending = byText(review, 'Confirm and apply').dispatch('click'); await flush();
  const inventoryReads = view.calls.filter(row => row.path.endsWith('/assembly')).length;
  view.ui.deactivate(); const oldStatus = review.querySelector('[role=status]').textContent;
  release({ operationId: 'operation-current' }); await pending;
  assert.equal(view.calls.filter(row => row.path.endsWith('/apply')).length, 1); assert.equal(view.calls.filter(row => row.path.endsWith('/assembly')).length, inventoryReads); assert.equal(view.refreshed, 0);
  assert.equal(view.node.querySelector('.dynamic-connection-dialog'), null); assert.doesNotMatch(view.body.textContent, /must-not-appear-after-leaving/); assert.equal(review.querySelector('[role=status]').textContent, oldStatus);
});


test('DYNAMIC-TAB summarized instance metadata is never mistaken for full saved declarations and the installed source is checked once per run', async () => {
  const view = fixture({ summarized: true }); await flush();
  assert.equal(view.owner.pack.topics, undefined); assert.equal(view.owner.pack.components[0].settings, undefined);
  assert.equal(view.node.querySelector('[data-dynamic-design-changed]'), null); assert.doesNotMatch(view.node.textContent, /customization status is unknown/);
  assert.deepEqual(view.calls.find(row => row.path === '/api/authoring/inspect').input, { directory: 'F:/saved/package' });
  await view.ui.refresh(view.owner); view.ui.render(view.owner); await flush(); assert.equal(view.calls.filter(row => row.path === '/api/authoring/inspect').length, 1);
  assert.deepEqual(runtimeDesignChange(view.assembly, view.owner.pack), { known: false, changed: false });
});

test('DYNAMIC-TAB missing or mismatched full saved baseline stays unknown rather than inventing a customization from summary fields', async () => {
  for (const scenario of ['failure', 'summary', 'different-version']) {
    const view = fixture({ summarized: true, handler: async path => {
      if (path !== '/api/authoring/inspect') return;
      if (scenario === 'failure') throw new Error('Saved source unavailable');
      if (scenario === 'summary') return { authoring: { pack: { id: 'test.pack', version: '1.0.1', components: [{ id: 'worker', module: manifest.id }] } } };
      return { authoring: { pack: { ...pack(), version: '9.0.0' } } };
    } }); await flush();
    assert.equal(view.node.querySelector('[data-dynamic-design-changed]'), null); assert.match(view.node.textContent, /customization status is unknown/); assert.ok(view.node.querySelector('.dynamic-managed-member'));
  }
});


test('DYNAMIC-TAB exited members use localized state and label a retained PID as historical', async () => {
  for (const language of ['en', 'zh']) {
    const view = fixture({ language }); await flush(); view.assembly.programs[0].state = 'exited'; view.assembly.programs[0].pid = 12345; await view.ui.refresh(view.owner);
    const card = view.node.querySelector('.dynamic-managed-member'); assert.match(card.textContent, language === 'zh' ? /已退出.*上次 PID 12345/ : /Exited.*Last PID 12345/);
    assert.equal(byText(card, language === 'zh' ? '启动' : 'Start').disabled, false);
  }
});


test('DYNAMIC-TAB member log shortcut targets the exact chosen member and changes only the selected log view', async () => {
  for (const language of ['en', 'zh']) {
    const tabs = [], view = fixture({ language, context: { changeTab: tab => tabs.push(tab) } }); await flush();
    view.assembly.programs.push({ ...structuredClone(view.assembly.programs[0]), componentId: 'chosen.other' }); await view.ui.refresh(view.owner);
    const before = view.calls.length, card = view.node.querySelectorAll('.dynamic-managed-member').find(row => row.dataset.componentId === 'chosen.other');
    await click(card, language === 'zh' ? '日志' : 'Logs'); assert.equal(view.state.logSelection, 'chosen.other'); assert.deepEqual(tabs, ['logs']); assert.equal(view.calls.length, before);
  }
  const opened = [], delegated = fixture({ context: { openLogs: id => opened.push(id) } }); await flush(); const before = delegated.calls.length;
  await click(delegated.node.querySelector('.dynamic-managed-member'), 'Logs'); assert.deepEqual(opened, ['worker']); assert.equal(delegated.calls.length, before);
});
