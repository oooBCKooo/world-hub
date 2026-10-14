import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { diagnose } from '../../../tools/launcher/diagnostics.mjs';
import { element } from './ui-dom.mjs';
import { workspace, fixturePackage, environment, json, save } from './helpers.mjs';

const options = { timeout: 30000, concurrency: false };
const source = await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8');
const installedHubVersion = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')).version;

function ui(language = 'en') {
  const state = { language }, visits = [];
  const context = vm.createContext({ state, el: element, t: key => key,
    say: (zh, en) => language === 'zh' ? zh : en, display: String, date: String,
    button: (title, action, className) => element('button', { type: 'button', class: className, onclick: action }, title),
    pill: title => element('span', {}, title), navigate: view => visits.push(view),
    definition: rows => element('dl', {}, rows.flatMap(([name, value]) => [element('dt', {}, name), element('dd', {}, value)])),
    guidance: rows => element('div', {}, rows.map(row => row[language] ?? row)),
    moduleView: () => element('div'), runtimeEnvironment: () => [] });
  vm.runInContext(source.slice(source.indexOf('class ApiError'), source.indexOf('async function api(')) + '\nthis.ApiError = ApiError;', context);
  vm.runInContext(source.slice(source.indexOf('function errorContents('), source.indexOf('function renderError(')) + '\nthis.errorContents = errorContents;', context);
  vm.runInContext(source.slice(source.indexOf('function reviewView('), source.indexOf('function renderDetailHeading(')) + '\nthis.reviewView = reviewView;', context);
  return { context, visits };
}

async function apiFor(app) {
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close());
  const call = async (path, request, status = 200) => {
    const response = await fetch(new URL(path, server.url), { method: request === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(request === undefined ? {} : { body: JSON.stringify(request) }), signal: AbortSignal.timeout(15000) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  return { server, call };
}

test('COMPATIBILITY-UI-01 current contracts allow different release metadata and the review distinguishes actual release', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), api = await apiFor(app);
  const lockFile = join(directory, 'pack.lock'), lock = await json(lockFile);
  lock.hubVersion = '0.18.0'; await save(lockFile, lock); const before = await readFile(lockFile);
  const result = await api.call('/api/review', { directory });
  assert.equal(result.review.lock.format, 'world-hub.pack-lock/v2');
  assert.equal(result.review.lock.hubVersion, '0.18.0');
  assert.equal(result.review.hubVersion, installedHubVersion);
  assert.equal(result.review.hubCompatibility.compatible, true);
  assert.deepEqual(await readFile(lockFile), before);
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  for (const language of ['zh', 'en']) {
    const { context } = ui(language), body = element('div', {}, context.reviewView(result, 'import'));
    const section = body.querySelector('[data-review-hub-compatibility]');
    assert.ok(section);
    assert.match(section.textContent, language === 'zh' ? /当前 Hub 发行版本/ : /Installed Hub release/);
    assert.match(section.textContent, language === 'zh' ? /生成锁时的发行版本（记录）/ : /Lock generation release \(metadata\)/);
    assert.ok(section.textContent.includes(installedHubVersion)); assert.ok(section.textContent.includes('0.18.0'));
    assert.match(section.textContent, /0\.1 \/ 0\.1/);
    assert.match(section.textContent, /world-hub\.run\/v1 \/ world-hub\.run\/v1/);
  }
  app.record('current-format-release-metadata-review', { installedHubVersion, generatedWith: lock.hubVersion, originalLockUnchanged: true, startsModules: false });
});

test('COMPATIBILITY-UI-02 discontinued format is rejected with a localized route to current resources', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), api = await apiFor(app);
  const lockFile = join(directory, 'pack.lock'), lock = await json(lockFile);
  lock.format = 'world-hub.pack-lock/v1'; lock.hubVersion = '0.18.0'; delete lock.hubCompatibility;
  await save(lockFile, lock); const before = await readFile(lockFile);
  const result = await api.call('/api/review', { directory }, 422);
  assert.equal(result.error.code, 'PACK_LOCK_OBSOLETE');
  assert.equal(result.requirements.format, lock.format);
  assert.equal(result.requirements.generatedWithHubVersion, '0.18.0');
  assert.equal(result.requirements.installedHubVersion, installedHubVersion);
  assert.equal(result.requirements.hubCompatibility, null);
  assert.deepEqual(result.requirements.currentHubCompatibility, { wireVersion: '0.1', runtimeApi: 'world-hub.run/v1' });
  assert.equal(result.guidance, undefined);
  assert.deepEqual(await readFile(lockFile), before);
  for (const language of ['zh', 'en']) {
    const { context, visits } = ui(language), dialog = element('dialog', {}, context.errorContents(new context.ApiError(result, 422)));
    dialog.showModal();
    assert.match(dialog.textContent, language === 'zh' ? /已停用.*锁格式/ : /discontinued.*lock format/);
    const action = dialog.querySelector('[data-repair-action="open-sources"]'); assert.ok(action);
    assert.match(action.textContent, language === 'zh' ? /获取当前资源/ : /current resources/);
    assert.equal(dialog.querySelectorAll('button').length, 1);
    await action.dispatch('click'); assert.deepEqual(visits, ['sources']); assert.equal(dialog.open, false);
  }
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  app.record('obsolete-format-refused-with-current-source-route', { originalLockUnchanged: true, startsModules: false });
});

test('COMPATIBILITY-UI-03 unknown contracts remain blocked and exact runtime requirements stay actionable', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), api = await apiFor(app);
  const lockFile = join(directory, 'pack.lock'), lock = await json(lockFile);
  const unknown = structuredClone(lock); unknown.hubCompatibility.runtimeApi = 'world-hub.run/v999';
  await save(lockFile, unknown); const before = await readFile(lockFile);
  const refused = await api.call('/api/review', { directory }, 422);
  assert.equal(refused.error.code, 'PACK_HUB_CONTRACT_UNSUPPORTED');
  assert.deepEqual(refused.error.compatibility.required, unknown.hubCompatibility);
  assert.deepEqual(refused.error.compatibility.actual, lock.hubCompatibility);
  assert.equal(refused.error.compatibility.compatible, false);
  assert.deepEqual(refused.requirements.hubCompatibility, unknown.hubCompatibility);
  assert.equal(refused.guidance, undefined);
  assert.deepEqual(await readFile(lockFile), before);
  for (const language of ['zh', 'en']) {
    const { context } = ui(language), body = element('div', {}, context.errorContents(new context.ApiError(refused, 422)));
    assert.match(body.textContent, language === 'zh' ? /契约当前不受支持/ : /unsupported Hub communication or Runtime API contract/);
    assert.match(body.textContent, /world-hub\.run\/v999/);
    assert.equal(body.querySelectorAll('button').length, 1);
    assert.doesNotMatch(body.querySelector('button').textContent, /忽略|Ignore|Force|Rebuild|重建/);
  }
  const wrongNode = structuredClone(lock); wrongNode.runtimes.node.version = '1.0.0'; await save(lockFile, wrongNode);
  const environmentFailure = await api.call('/api/review', { directory }, 422);
  assert.match(environmentFailure.error.message, /node version mismatch/);
  assert.equal(environmentFailure.diagnostic.kind, 'compatibility');
  assert.equal(environmentFailure.diagnostic.action, undefined);
  assert.equal(environmentFailure.requirements.runtimes.node.version, '1.0.0');
  assert.ok(environmentFailure.guidance[0].zh); assert.ok(environmentFailure.guidance[0].en);
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  app.record('unsupported-contract-and-interpreter-blocks', { contract: unknown.hubCompatibility.runtimeApi, startsModules: false });
});

test('COMPATIBILITY-UI-04 diagnostic recovery choices are based on contract error codes', () => {
  const obsolete = diagnose({ code: 'PACK_LOCK_OBSOLETE', message: 'unsupported format' });
  const unsupported = diagnose({ code: 'PACK_HUB_CONTRACT_UNSUPPORTED', message: 'unsupported contract' });
  assert.equal(obsolete.action.view, 'sources'); assert.equal(unsupported.action.view, 'sources');
  assert.doesNotMatch(obsolete.zh + obsolete.en + unsupported.zh + unsupported.en, /重建源码锁|rebuild.*lock|ignore/i);
  const interpreter = diagnose({ code: 'INTERPRETER_VERSION', message: 'version mismatch' });
  assert.equal(interpreter.kind, 'compatibility'); assert.equal(interpreter.action, undefined);
});
