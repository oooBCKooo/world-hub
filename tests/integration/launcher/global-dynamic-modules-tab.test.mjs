import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGlobalDynamicModulesUi } from '../../../tools/launcher/public/global-dynamic-modules-tab.mjs';
import { translate } from '../../../tools/launcher/public/i18n.mjs';
import { element } from './ui-dom.mjs';

const tick = () => new Promise(done => setImmediate(done));
const find = (root, text) => root.querySelectorAll('button').find(row => row.textContent === text);
function scene(overrides = {}) {
  const requests = [], root = element('div'), state = { language: 'en', online: true, hubsObservedAt: new Date().toISOString() };
  let inventory = { observation: 'live', runId: 'hub-run-1', revision: 0, programs: [], observedSessions: [] };
  const ctx = { state, el: element, button: (label, handler, className, disabled) => element('button', { onclick: handler, class: className, disabled }, label),
    api: async (path, body) => {
      requests.push({ path, body });
      const result = await overrides.api?.(path, body);
      if (result !== undefined) return result;
      if (path === '/api/programs/external') return structuredClone(inventory);
      if (path.endsWith('/preview')) return { reviewId: 'external-review', review: { action: body.action } };
      if (path.endsWith('/apply')) return { runId: 'hub-run-1', revision: 1 };
      if (path.endsWith('/review')) return { reviewId: 'start-review', review: { programId: 'managed' } };
      if (/\/(start|stop)$/.test(path)) return { operationId: 'local-operation' };
      if (path === '/api/operations/local-operation') return { operation: { state: 'succeeded', result: {} } };
      throw new Error(`Unexpected ${path}`);
    }, refresh: async () => {}, toast() {}, ...overrides.ctx };
  const ui = createGlobalDynamicModulesUi(ctx);
  const mount = (programs = [], hub = { state: 'running' }) => { root.replaceChildren(...ui.render(programs, hub)); };
  return { root, state, ui, requests, mount, setInventory: value => { inventory = value; } };
}

test('Global dynamic page renders inline, keeps typed grants on refresh, and applies only a chosen preview', async () => {
  const view = scene(); view.mount(); await tick();
  await find(view.root, 'Authorize external program').dispatch('click');
  view.root.querySelector('[name=externalProgramId]').value = 'external.test';
  view.root.querySelector('[name=publishTopics]').value = 'metrics/in, metrics/in';
  view.root.querySelector('[name=subscribeTopics]').value = 'metrics/out';
  view.mount(); await view.ui.refresh();
  assert.equal(view.root.querySelector('[name=externalProgramId]').value, 'external.test');
  await find(view.root, 'Preview connection authorization').dispatch('click');
  assert.deepEqual(view.requests.find(row => row.path.endsWith('/preview')).body, {
    action: 'admit', programId: 'external.test', expectedRunId: 'hub-run-1', expectedRevision: 0,
    bridges: [{ slot: 'main', publish: ['metrics/in'], subscribe: ['metrics/out'] }]
  });
  assert.equal(view.requests.some(row => row.path.endsWith('/apply')), false);
  assert.equal(view.root.querySelectorAll('dialog').length, 0);
  assert.equal(view.root.querySelectorAll('[type=checkbox]').length, 0);
  await find(view.root, 'Apply this reviewed change').dispatch('click');
  assert.deepEqual(view.requests.find(row => row.path.endsWith('/apply')).body, { reviewId: 'external-review', accepted: true });
});

test('Global one-time connection config survives a failed inventory refresh and is cleared on leaving', async () => {
  let count = 0;
  const view = scene({ api: (path) => {
    if (path === '/api/programs/external' && ++count > 1) throw new Error('temporary inventory outage');
    if (path.endsWith('/apply')) return { connection: { token: 'one-time-secret' } };
  } });
  view.mount(); await tick(); await find(view.root, 'Authorize external program').dispatch('click');
  await find(view.root, 'Preview connection authorization').dispatch('click');
  await find(view.root, 'Apply this reviewed change').dispatch('click');
  assert.doesNotMatch(view.root.textContent, /one-time-secret/);
  await find(view.root, 'Reveal connection configuration').dispatch('click');
  assert.match(view.root.textContent, /one-time-secret/); assert.match(view.root.textContent, /temporary inventory outage/);
  view.ui.deactivate(); assert.doesNotMatch(view.root.textContent, /one-time-secret/);
});

test('Global exact session disconnect includes principal and connection ID, with no external process controls', async () => {
  const view = scene();
  view.setInventory({ observation: 'live', runId: 'hub-run-1', revision: 2, programs: [{ programId: 'outside', principal: 'external.outside', title: '<script>bad</script>', bridges: [], effectiveAllow: { publish: ['a'], subscribe: [] },
    connections: [{ connectionId: 'connection-1', bridgeId: 'bridge-1', session: 'session-1', principal: 'external.outside', authenticated: true, published: 2, delivered: 3 }] }], observedSessions: [] });
  view.mount(); await tick();
  const card = view.root.querySelector('.dynamic-external-member');
  assert.equal(card.querySelectorAll('script').length, 0); assert.match(card.textContent, /<script>bad<\/script>/);
  assert.equal(find(card, 'Start'), undefined); assert.equal(find(card, 'Stop'), undefined);
  assert.match(card.textContent, /External PID, process health and business readiness are unknown/);
  await find(card, 'Disconnect this connection').dispatch('click');
  assert.deepEqual(view.requests.find(row => row.path.endsWith('/preview')).body, { action: 'disconnect', principal: 'external.outside', connectionIds: ['connection-1'], expectedRunId: 'hub-run-1', expectedRevision: 2 });
});

test('Global dynamic tab focuses on runtime admissions and wiring matrix without duplicating static managed module cards', async () => {
  const view = scene(); view.mount([{ programId: 'managed', title: 'Managed', module: { id: 'source', version: '1' }, state: 'stopped', topics: { test: 'test/topic' }, bridges: {} }]); await tick();
  assert.equal(view.root.querySelectorAll('.dynamic-managed-member').length, 0);
  assert.equal(find(view.root, 'Add managed module'), undefined);
  assert.ok(find(view.root, 'Authorize external program'));
  assert.match(view.root.querySelector('.dynamic-permissions-matrix').textContent, /Managed · Managed declaration/);
});

test('Global unavailable observation blocks mutations and never invents external sessions', async () => {
  const view = scene(); view.state.online = false; view.mount(); await tick();
  assert.equal(find(view.root, 'Authorize external program').disabled, true);
  assert.equal(view.requests.length, 0); assert.equal(view.root.querySelectorAll('.dynamic-observed-session').length, 0);
  assert.match(view.root.textContent, /observation has expired/);
  view.state.online = true; view.mount(); await view.ui.refresh();
  assert.equal(find(view.root, 'Authorize external program').disabled, false);
});

test('Global changed run invalidates an unfinished permission review and clears one-time display', async () => {
  const view = scene(); view.mount(); await tick();
  await find(view.root, 'Authorize external program').dispatch('click');
  await find(view.root, 'Preview connection authorization').dispatch('click');
  const staleApply = find(view.root, 'Apply this reviewed change');
  view.setInventory({ observation: 'live', runId: 'hub-run-2', revision: 0, programs: [], observedSessions: [] });
  await view.ui.refresh(); await staleApply.dispatch('click');
  assert.equal(view.requests.some(row => row.path.endsWith('/apply')), false);
  assert.equal(view.root.querySelector('[name=externalProgramId]'), null);
});

test('Global leaving during apply cannot reveal a late credential or erase a new editor after reentry', async () => {
  let complete;
  const view = scene({ api: path => path.endsWith('/apply') ? new Promise(done => { complete = done; }) : undefined });
  view.mount(); await tick(); await find(view.root, 'Authorize external program').dispatch('click');
  await find(view.root, 'Preview connection authorization').dispatch('click');
  const pending = find(view.root, 'Apply this reviewed change').dispatch('click'); await tick();
  view.ui.deactivate(); complete({ connection: { token: 'late-private-token' } }); await pending;
  assert.doesNotMatch(view.root.textContent, /late-private-token/);
  view.mount(); await tick(); await find(view.root, 'Authorize external program').dispatch('click');
  assert.ok(view.root.querySelector('[name=externalProgramId]'));
  assert.equal(view.requests.filter(row => row.path === '/api/programs/external').length, 2);
});

test('Dynamic tab is present in both language dictionaries, routes, launch return and distribution', async () => {
  const [html, app, advanced, build] = await Promise.all(['tools/launcher/public/index.html', 'tools/launcher/public/app.mjs', 'tools/launcher/public/advanced.mjs', 'scripts/release/build-package.mjs'].map(path => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')));
  assert.ok(html.indexOf('id="tab-modules"') < html.indexOf('id="tab-dynamic-modules"'));
  assert.ok(html.indexOf('id="tab-dynamic-modules"') < html.indexOf('id="tab-logs"'));
  assert.equal(translate('zh', 'dynamicModulesPermissions'), '动态模块与权限');
  assert.equal(translate('en', 'dynamicModulesPermissions'), 'Dynamic Modules & Permissions');
  assert.match(app, /globalDynamic\?\.render\(programs, defaultHub\)/);
  assert.match(app, /renderDynamicModules\?\.\(instance\)/);
  assert.match(app, /'status', 'modules', 'dynamic-modules', 'logs', 'storage', 'details'/);
  assert.match(advanced, /openDynamicTab:[^\n]+'dynamic-modules'/);
  assert.match(build, /global-dynamic-modules-tab\.mjs/); assert.match(build, /dynamic-modules-tab\.mjs/);
});
