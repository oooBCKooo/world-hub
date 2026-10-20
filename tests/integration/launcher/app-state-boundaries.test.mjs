import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { localizeErrorMessage } from '../../../tools/launcher/public/i18n.mjs';

const source = await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8');
function storage(entries = {}) {
  const values = new Map(Object.entries(entries)), reads = [];
  return { values, reads, getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); }, removeItem(key) { values.delete(key); } };
}
const sessionKey = 'world-hub.launcher.session';
function bootScene({ hash = '#launch=one-use-code', api } = {}) {
  const localStorage = storage({ [sessionKey]: JSON.stringify({ token: 'legacy-persistent-credential', csrfToken: 'legacy-csrf' }) });
  const sessionStorage = storage(), location = { hash, pathname: '/', search: '' }, notices = [], calls = [];
  const fields = { elements: { nodePath: {}, pythonPath: {} } }, version = {};
  const state = { language: 'en', auth: null };
  const context = { state, sessionKey, localStorage, sessionStorage, location, URLSearchParams, localizeErrorMessage,
    document: { documentElement: { dataset: {} } },
    history: { replaceState(_state, _title, url) { location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } },
    api: async (path, body) => { calls.push({ path, body }); return api(path, body); },
    $: selector => selector === '#environment-form' ? fields : version,
    t: key => key, showNotice: (_node, text) => notices.push(text), updateConnectionState() {},
    createAdvancedUi: () => ({ sessionReady() {} }), createPathUi: () => ({ sessionReady() {} }), createTaskUi: () => ({}), createGlobalDynamicModulesUi: () => ({}),
    initializeEvents() {}, languageChanged() {}, navigate() {}, resolveReturnHint: async () => false,
    setInterval() {}, refresh: async () => {}, stopInstance() {},
  };
  for (const name of ['el','button','pill','toast','definition','display','date','guidance','errorContents','current','idOf','endpoint','operationFor','exitUnconfirmed','renderDetail','changeTab','selectInstance','openImport','replaceInstance','reviewView','createIcon','renderSquareArt','setEnvironmentTab','confirmDialog']) context[name] = () => {};
  const sandbox = vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const localizeMsg ='), source.indexOf('const packVersionSelection')), sandbox);
  // boot passes the production freshness predicate to the advanced UI. Keep
  // its real observation dependencies instead of substituting a permissive stub.
  vm.runInContext(source.slice(source.indexOf('const observationMaxAgeMs'), source.indexOf('const operationFor')), sandbox);
  vm.runInContext(source.slice(source.indexOf('async function boot()'), source.lastIndexOf('void boot();')), sandbox);
  return { sandbox, state, localStorage, sessionStorage, location, notices, calls };
}

test('APP-AUTH-01 a pending or failed bootstrap cleans the one-use URL before the network finishes and ignores persistent credentials', async () => {
  let reject;
  const pending = new Promise((_resolve, no) => { reject = no; });
  const scene = bootScene({ api: () => pending });
  const boot = scene.sandbox.boot();
  assert.equal(scene.location.hash, '');
  assert.equal(scene.localStorage.values.has(sessionKey), false);
  assert.equal(scene.localStorage.reads.includes(sessionKey), false);
  assert.equal(scene.calls.length, 1);
  assert.equal(scene.calls[0].body.code, 'one-use-code');
  reject(new Error('Network unavailable')); await boot;
  assert.equal(scene.sessionStorage.values.has(sessionKey), false);
  assert.deepEqual(scene.notices, ['Network unavailable']);
});

test('APP-AUTH-02 successful UI authorization is stored only in the tab session', async () => {
  const scene = bootScene({ api: async () => ({ token: 'new-ui-session', csrfToken: 'ui-csrf', defaults: {} }) });
  await scene.sandbox.boot();
  assert.deepEqual(JSON.parse(scene.sessionStorage.values.get(sessionKey)), { token: 'new-ui-session', csrfToken: 'ui-csrf' });
  assert.equal(scene.localStorage.values.has(sessionKey), false);
  assert.equal(scene.location.hash, '');
});

test('APP-AUTH-03 a fresh tab without bootstrap cannot regain management access from old persistent storage', async () => {
  const scene = bootScene({ hash: '#packs', api: async () => { throw new Error('Must not attempt legacy authorization'); } });
  await scene.sandbox.boot();
  assert.equal(scene.calls.length, 0);
  assert.deepEqual(scene.notices, ['sessionRequired']);
  assert.equal(scene.state.auth, null);
});

test('APP-STATE-01 declared modules survive an empty process list and runtime badges use declarations rather than names', () => {
  const state = { reviews: new Map([['instance', { review: { pack: { components: [{ id: 'stats', module: 'vendor.statistics' }] },
    modules: [{ manifest: { id: 'vendor.statistics', runtime: { kind: 'python' } } }] } }]]) };
  const sandbox = vm.createContext({ state, idOf: row => row.instanceId });
  const start = source.indexOf('const declaredModuleCount'), end = source.indexOf('const current =');
  vm.runInContext(source.slice(start, end) + '\nthis.count = declaredModuleCount; this.runtime = componentRuntimeKind;', sandbox);
  const instance = { instanceId: 'instance', moduleCount: 3, status: { components: [] } };
  assert.equal(sandbox.count(instance), 3);
  assert.equal(sandbox.runtime(instance, { id: 'stats', module: 'vendor.statistics' }), 'python');
  assert.equal(sandbox.runtime({ instanceId: 'unreviewed' }, { id: 'unknown', module: 'python-looking-id.py' }), null);
  assert.equal(sandbox.count({ instanceId: 'unreviewed', status: { components: [] } }), null);
});
