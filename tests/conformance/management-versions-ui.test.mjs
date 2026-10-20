import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
const walk = node => [node, ...node.children.flatMap(walk)];
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.value = ''; this._text = ''; this.htmlWrites = 0;
    const classes = new Set();
    this.classList = { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value), toggle: (value, enabled) => { const added = enabled ?? !classes.has(value); added ? classes.add(value) : classes.delete(value); return added; } };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  prepend(...children) { for (const child of children.reverse()) { child.parent = this; this.children.unshift(child); } }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  add(option) { this.append(option); if (this.children.length === 1) this.value = option.value; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type) { this.listeners.get(type)?.({ target: this }); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.htmlWrites++; this.replaceChildren(); this._text = String(value); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = value => ({ ok: true, json: async () => structuredClone(value) });
const identity = 'test.module', installed = 'installed-one', groupId = 'group-one', artifact = 'F:\\downloads\\module-2.zip';
const historyId = 'history-transaction';
const overview = (extra = {}) => ({ revision: 'revision-one', current: { id: identity, version: '1.0.0', revision: 'revision-one' }, history: [], recoveryRequired: [], ...extra });
const releaseReview = (extra = {}) => ({ reviewId: 'review-two', review: { action: 'update', before: { id: identity, version: '1.0.0' }, after: { id: identity, version: '2.0.0' },
  dataPolicy: 'preserve', configurationPolicy: 'preserve', programs: [{ programId: installed, before: { id: identity, version: '1.0.0' }, after: { id: identity, version: '2.0.0' },
    settings: { title: 'new' }, topics: { events: 'new/events' }, bridges: { main: { publish: ['events'], subscribe: [] } }, bindings: [], manifest: { permissions: {} },
    affected: { sharedWithGroups: [{ id: groupId, title: 'Shared group' }], consumers: [{ programId: 'consumer-one' }] } }], ...extra } });

function scene({ request: handle, programs, groups, confirmResult = true } = {}) {
  const body = new Element('body'), requests = [], toasts = [], confirmations = [], events = [];
  const ids = ['modal-module-workshop', 'modal-workshop-detail', 'modal-workshop-lightbox', 'inp-ws-search', 'sel-ws-type', 'sel-ws-contract', 'sel-ws-sort',
    'inp-workshop-private-network', 'inp-workshop-source-url', 'workshop-entries-box', 'ws-results-counter', 'btn-ws-search-clear', 'btn-ws-reset-filters'];
  for (const id of ids) { const node = new Element('div'); node.id = id; body.append(node); }
  const get = id => walk(body).find(node => node.id === id);
  get('sel-ws-type').value = 'all'; get('sel-ws-contract').value = 'all'; get('sel-ws-sort').value = 'default';
  const context = vm.createContext({
    document: { body, getElementById: get, createElement: tag => new Element(tag) },
    Option: function(text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    localStorage: { getItem: () => '0' }, console,
    confirm: text => { confirmations.push(text); return confirmResult; },
    window: { hubCanvas: { state: { data: { csrfToken: 'test-csrf' } }, toast: (...args) => toasts.push(args) } },
    fetch: async (url, init = {}) => {
      const request = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers }; requests.push(request);
      const custom = await handle?.(request); if (custom !== undefined) return custom?.json ? custom : reply(custom);
      if (url === '/manage/api/paths/known') return reply({ objects: [] });
      if (url === '/manage/api/workshop/sources') return reply({ sources: [] });
      if (/\/versions\/(modules|groups)\/[^/]+$/.test(url)) return reply(overview());
      if (url.endsWith('/preview') || url.endsWith('/rollback-preview')) return reply(releaseReview());
      if (url.endsWith('/apply') || url.endsWith('/recover')) return reply({ ok: true });
      if (url === '/manage/api/workshop/fetch') return reply({ directory: artifact });
      throw new Error(`Unexpected request ${url}`);
    }
  });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController')
    + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;
  controller.data.programs = programs ?? [{ programId: installed, state: 'stopped', module: { id: identity, version: '1.0.0' }, settings: {}, topics: {}, bridges: {}, bindings: [], manifest: { permissions: {} } }];
  controller.data.groups = groups ?? [{ id: groupId, memberProgramIds: [installed] }];
  controller.fetchModulesData = async () => events.push('refresh');
  controller.workshopData = { source: 'https://example.test/index.json', digest: 'f'.repeat(64) };
  controller.workshopEntries = [{ kind: 'module', id: identity, version: '2.0.0', entryId: 'module.test.module.2.0.0', title: 'Module', platforms: ['win32-x64'] },
    { kind: 'module', id: 'other.module', version: '2.0.0', entryId: 'other-module', title: 'Other module', platforms: ['win32-x64'] },
    { kind: 'module-group', id: identity, version: '2.0.0', entryId: 'other-kind', title: 'Group', platforms: ['win32-x64'] }];
  return { controller, get, body, requests, toasts, confirmations, events };
}

async function selected(view, kind = 'modules', target = installed) {
  await view.controller.openVersionManager(kind, target);
  view.get('version-source-path').value = artifact;
  view.get('version-source-path').dispatch('input');
}

test('version UI: single-module updates require a known stopped target without automatically stopping programs', async () => {
  const view = scene({ programs: [{ programId: installed, state: 'running' }] });
  await selected(view);
  assert.equal(view.get('btn-version-preview').disabled, true);
  assert.match(view.get('version-state-note').textContent, /完全停止/);
  await view.controller.previewVersionUpdate();
  assert.match(view.get('version-error').textContent, /先停止/);
  await selected(view, 'modules', 'unknown-instance');
  assert.equal(view.get('btn-version-preview').disabled, true);
  assert.equal(view.requests.some(item => item.url.endsWith('/preview') || item.url.endsWith('/stop')), false);
});

test('version UI: group update may detach a running member and replace only stopped members without stopping the detached program', async () => {
  const stoppedId = 'remaining-stopped', addedId = 'new-member';
  const view = scene({ programs: [{ programId: installed, state: 'running' }, { programId: stoppedId, state: 'stopped' }],
    groups: [{ id: groupId, memberProgramIds: [installed, stoppedId] }], request: request => request.url.endsWith('/preview')
      ? releaseReview({ programs: [{ programId: stoppedId, before: { id: identity, version: '1.0.0' }, after: { id: identity, version: '2.0.0' } },
        { programId: addedId, before: null, after: { id: 'new.module', version: '1.0.0' }, change: 'add' }],
        removedMembers: [{ programId: installed, retainedRegistered: true, state: 'running' }] }) : undefined });
  await selected(view, 'groups', groupId);
  assert.equal(view.get('btn-version-preview').disabled, false);
  assert.match(view.get('version-state-note').textContent, /仅移出组且保留独立注册的成员可继续运行/);
  await view.controller.previewVersionUpdate();
  assert.equal(view.controller.versionSession.review.reviewId, 'review-two');
  view.get('version-data-ack').checked = true; view.get('version-data-ack').dispatch('change');
  assert.equal(view.get('btn-version-apply').disabled, false);
  await view.controller.applyVersionReview();
  assert.equal(view.requests.some(item => item.url === `/manage/api/versions/groups/${groupId}/apply`), true);
  assert.equal(view.requests.some(item => item.url.endsWith('/stop')), false);
  assert.equal(view.controller.data.programs.find(program => program.programId === installed).state, 'running');
});

test('version UI: group candidate requiring a running member replacement is refused by the backend and shown to the user', async () => {
  const view = scene({ programs: [{ programId: installed, state: 'running' }], request: request => request.url.endsWith('/preview')
    ? { ok: false, json: async () => ({ error: { message: `Stop module instance ${installed} before replacing its version.` } }) } : undefined });
  await selected(view, 'groups', groupId);
  assert.equal(view.get('btn-version-preview').disabled, false, 'the backend must inspect the actual candidate membership');
  await view.controller.previewVersionUpdate();
  assert.equal(view.requests.some(item => item.url.endsWith('/preview')), true);
  assert.match(view.get('version-error').textContent, /Stop module instance installed-one/);
  assert.equal(view.controller.versionSession.review, null);
  assert.equal(view.get('btn-version-apply').disabled, true);
  assert.equal(view.requests.some(item => item.url.endsWith('/stop')), false);
});

test('version UI: apply is blocked when a reviewed group member starts running after preview', async () => {
  const view = scene(); await selected(view, 'groups', groupId); await view.controller.previewVersionUpdate();
  view.controller.data.programs[0].state = 'running'; view.get('version-data-ack').checked = true;
  await view.controller.applyVersionReview();
  assert.equal(view.requests.some(item => item.url.endsWith('/apply')), false);
  assert.equal(view.controller.versionSession.review, null);
  assert.match(view.get('version-error').textContent, /目标状态已变化/);
});

test('version UI: candidate and policy edits discard prior reviews and explicit acknowledgement', async () => {
  const view = scene(); await selected(view);
  for (const [id, value, event] of [['version-source-path', 'F:\\other.zip', 'input'], ['version-configuration-policy', 'author', 'change'],
    ['version-data-policy', 'fresh', 'change'], ['version-rollback-data', 'restore', 'change'], ['version-establish-origin', true, 'change']]) {
    await view.controller.previewVersionUpdate();
    view.get('version-data-ack').checked = true; view.get('version-data-ack').dispatch('change');
    assert.equal(view.get('btn-version-apply').disabled, false);
    if (typeof value === 'boolean') view.get(id).checked = value; else view.get(id).value = value;
    view.get(id).dispatch(event);
    assert.equal(view.controller.versionSession.review, null, id);
    assert.equal(view.get('version-data-ack').checked, false, id);
    assert.equal(view.get('btn-version-apply').disabled, true, id);
  }
  await view.controller.applyVersionReview();
  assert.equal(view.requests.some(item => item.url.endsWith('/apply')), false);
});

test('version UI: update sends exact revision and selected strategies and cannot apply without acknowledgement', async () => {
  const view = scene(); await selected(view);
  view.get('version-configuration-policy').value = 'author'; view.get('version-data-policy').value = 'fresh';
  await view.controller.previewVersionUpdate();
  assert.deepEqual(view.requests.find(item => item.url.endsWith('/preview')).body,
    { path: artifact, expectedRevision: 'revision-one', configurationPolicy: 'author', dataPolicy: 'fresh' });
  await view.controller.applyVersionReview();
  assert.equal(view.requests.some(item => item.url.endsWith('/apply')), false);
  view.get('version-data-ack').checked = true; await view.controller.applyVersionReview();
  const applied = view.requests.find(item => item.url.endsWith('/apply'));
  assert.deepEqual(applied.body, { reviewId: 'review-two', accepted: true, dataAcknowledged: true });
  assert.equal(applied.headers['X-Management-Token'], 'test-csrf');
  assert.equal(view.controller.versionSession.review, null);
});

test('version UI: pending apply prevents repeated submissions and cannot be closed or replaced mid-transaction', async () => {
  const waiting = deferred();
  const view = scene({ request: request => request.url.endsWith('/apply') ? waiting.promise : undefined });
  await selected(view); await view.controller.previewVersionUpdate(); view.get('version-data-ack').checked = true;
  const active = view.controller.versionSession, applying = view.controller.applyVersionReview();
  await view.controller.applyVersionReview(); view.controller.closeVersionManager(); await view.controller.openVersionManager('modules', 'other-instance');
  assert.equal(view.controller.versionSession, active);
  assert.equal(view.get('btn-version-apply').disabled, true);
  assert.equal(view.get('version-source-path').disabled, true);
  assert.equal(view.requests.filter(item => item.url.endsWith('/apply')).length, 1);
  waiting.resolve({ ok: true }); await applying;
  assert.equal(view.controller.versionSession.targetId, installed);
  assert.equal(view.get('version-source-path').disabled, false);
});

test('version UI: closing or switching targets discards late overview and preview responses', async () => {
  const preview = deferred();
  const view = scene({ request: request => request.url.endsWith('/preview') ? preview.promise : undefined });
  await selected(view); const pending = view.controller.previewVersionUpdate();
  view.controller.closeVersionManager(); await view.controller.openVersionManager('modules', 'other-instance');
  preview.resolve(releaseReview()); await pending;
  assert.equal(view.controller.versionSession.targetId, 'other-instance');
  assert.equal(view.controller.versionSession.review, null);
  assert.equal(view.get('version-review').textContent, '');
  const delayed = deferred(), late = scene({ request: request => request.url.endsWith('/modules/old-instance') ? delayed.promise : undefined });
  const old = late.controller.openVersionManager('modules', 'old-instance');
  await late.controller.openVersionManager('modules', installed);
  delayed.resolve(overview({ current: { id: 'wrong.target', version: '9.0.0' } })); await old;
  assert.match(late.get('version-current').textContent, /test\.module @ 1\.0\.0/);
  assert.equal(late.get('version-current').textContent.includes('wrong.target'), false);
});

test('version UI: a late preview cannot restore a review invalidated by a candidate edit', async () => {
  const delayed = deferred(), view = scene({ request: request => request.url.endsWith('/preview') ? delayed.promise : undefined });
  await selected(view); const pending = view.controller.previewVersionUpdate();
  view.get('version-source-path').value = 'F:\\another.zip'; view.get('version-source-path').dispatch('input');
  delayed.resolve(releaseReview()); await pending;
  assert.equal(view.controller.versionSession.review, null);
  assert.equal(view.get('btn-version-apply').disabled, true);
  assert.equal(view.get('version-error').textContent, '');
});

test('version UI: Workshop version selection stays within source identity and returns to the existing target review', async () => {
  const view = scene(); await selected(view); const session = view.controller.versionSession;
  view.controller.openVersionWorkshop();
  assert.equal(view.get('module-version-modal').classList.contains('hidden'), true);
  assert.equal(view.get('workshop-entries-box').children.length, 1, 'other source identities and group artifacts cannot replace this module');
  view.controller.resetWorkshopFilters();
  assert.equal(view.get('workshop-entries-box').children.length, 1, 'resetting search must retain the version target boundary');
  await view.controller.fetchWorkshopModule('https://example.test/index.json', 'other-module', 'f'.repeat(64));
  assert.equal(view.requests.some(item => item.url === '/manage/api/workshop/fetch'), false);
  await view.controller.fetchWorkshopModule('https://example.test/index.json', 'module.test.module.2.0.0', 'f'.repeat(64));
  assert.equal(view.controller.versionSession, session);
  assert.equal(view.controller.versionSession.review.reviewId, 'review-two');
  assert.equal(view.get('version-source-path').value, artifact);
  assert.equal(view.get('module-version-modal').classList.contains('hidden'), false);
  assert.equal(view.requests.some(item => item.url === '/manage/api/artifacts/preview' || item.url === '/manage/api/artifacts/apply'), false);
  assert.equal(view.requests.filter(item => item.url.endsWith(`/modules/${installed}/preview`)).length, 1);
});

test('version UI: cancelling Workshop returns to version management and a late download only fills the cache', async () => {
  const delayed = deferred(), view = scene({ request: request => request.url === '/manage/api/workshop/fetch' ? delayed.promise : undefined });
  await selected(view); view.controller.openVersionWorkshop();
  const pending = view.controller.fetchWorkshopModule('https://example.test/index.json', 'module.test.module.2.0.0', 'f'.repeat(64));
  await view.controller.fetchWorkshopModule('https://example.test/index.json', 'module.test.module.2.0.0', 'f'.repeat(64));
  assert.equal(view.requests.filter(item => item.url === '/manage/api/workshop/fetch').length, 1);
  view.controller.closeOnlineWorkshopModal();
  assert.equal(view.controller.versionWorkshopTarget, null);
  assert.equal(view.get('module-version-modal').classList.contains('hidden'), false);
  await view.controller.openVersionManager('groups', groupId);
  delayed.resolve({ directory: artifact }); await pending;
  assert.equal(view.controller.versionSession.targetId, groupId);
  assert.equal(view.get('version-source-path').value, '');
  assert.equal(view.requests.some(item => item.url.endsWith('/preview')), false);
});

test('version UI: history rollback shows historical configuration and selected data restore as separate decisions', async () => {
  const view = scene({ request: request => {
    if (/\/modules\/installed-one$/.test(request.url)) return overview({ history: [{ id: historyId, action: 'update', before: { version: '1.0.0' }, after: { version: '2.0.0' }, status: 'committed' }] });
    if (request.url.endsWith('/rollback-preview')) return releaseReview({ action: 'rollback', configurationPolicy: 'historical', dataPolicy: 'restore' });
  } });
  await selected(view); view.get('version-rollback-data').value = 'restore'; view.get('version-rollback-data').dispatch('change');
  await walk(view.get('version-history')).find(node => node.tag === 'button').onclick();
  assert.deepEqual(view.requests.find(item => item.url.endsWith('/rollback-preview')).body,
    { transactionId: historyId, expectedRevision: 'revision-one', dataPolicy: 'restore' });
  assert.match(view.get('version-review').textContent, /恢复此次历史变更前的本地数据快照/);
  assert.match(view.get('version-review').textContent, /恢复该次历史变更前的参数、主题、接线与启动计划/);
  assert.equal(view.get('version-data-ack').checked, false);
  assert.equal(view.get('btn-version-apply').disabled, true);
});

test('version UI: interrupted transaction recovery explicitly discloses local data restore and blocks new updates', async () => {
  const view = scene({ request: request => /\/modules\/installed-one$/.test(request.url)
    ? overview({ recoveryRequired: [{ transactionId: historyId, status: 'switching' }] }) : undefined });
  await selected(view);
  assert.equal(view.get('btn-version-preview').disabled, true);
  assert.match(view.get('version-recovery').textContent, /本地实例数据快照/);
  await view.controller.previewVersionUpdate();
  assert.equal(view.requests.some(item => item.url.endsWith('/preview')), false);
  await walk(view.get('version-recovery')).find(node => node.tag === 'button').onclick();
  assert.match(view.confirmations[0], /软件、配置与本地实例数据快照/);
  assert.deepEqual(view.requests.find(item => item.url.endsWith('/recover')).body, { transactionId: historyId, accepted: true });
});

test('version UI: a group can recover an affected member transaction through that transaction target', async () => {
  const view = scene({ request: request => /\/groups\/group-one$/.test(request.url)
    ? overview({ recoveryRequired: [{ transactionId: historyId, kind: 'module', targetId: installed, status: 'switching', programIds: [installed] }] }) : undefined });
  await selected(view, 'groups', groupId);
  await walk(view.get('version-recovery')).find(node => node.tag === 'button').onclick();
  const recovery = view.requests.find(item => item.url.endsWith('/recover'));
  assert.equal(recovery.url, `/manage/api/versions/modules/${installed}/recover`);
  assert.equal(view.controller.versionSession.targetId, groupId, 'the current view stays on the original group');
});

test('version UI: cleanup of a committed transaction is distinct from restoring an interrupted transaction', async () => {
  const view = scene({ request: request => /\/modules\/installed-one$/.test(request.url)
    ? overview({ recoveryRequired: [{ transactionId: historyId, kind: 'module', targetId: installed, status: 'committed', programIds: [installed] }] }) : undefined });
  await selected(view);
  assert.match(view.get('version-recovery').textContent, /版本切换已完成/);
  assert.match(view.get('version-recovery').textContent, /清理不会改变软件、配置或本地实例数据/);
  const button = walk(view.get('version-recovery')).find(node => node.tag === 'button');
  assert.equal(button.textContent, '清理事务标记');
  await button.onclick();
  assert.match(view.confirmations[0], /不会改变软件、配置或本地实例数据/);
  assert.equal(view.confirmations[0].includes('还原变更前'), false);
});

test('version UI: successful version switch with pending cleanup reports completion and next action accurately', async () => {
  const view = scene({ request: request => request.url.endsWith('/apply') ? { ok: true, cleanupPending: true } : undefined });
  await selected(view); await view.controller.previewVersionUpdate(); view.get('version-data-ack').checked = true;
  await view.controller.applyVersionReview();
  assert.equal(view.toasts.some(([message]) => /版本切换已完成.*清理残留事务标记/.test(message)), true);
});

test('version UI: review source names, settings, topics and error messages render as text', async () => {
  const hostile = '<img src=x onerror=alert(1)>', view = scene({ request: request => request.url.endsWith('/preview')
    ? releaseReview({ after: { id: hostile, version: hostile }, programs: [{ programId: hostile, after: { id: hostile, version: hostile },
      settings: { name: hostile }, topics: { sample: hostile }, bridges: {}, bindings: [], manifest: { permissions: {} } }] }) : undefined });
  await selected(view); await view.controller.previewVersionUpdate();
  assert.match(view.get('version-review').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(walk(view.get('module-version-modal')).some(node => node.tag === 'img' || node.htmlWrites), false);
  assert.match(view.get('version-review').textContent, /实例身份保留/);
});

test('version UI: before configuration comes from the reviewed backend snapshot instead of stale background data', async () => {
  const reviewed = releaseReview();
  reviewed.review.programs[0].previousConfiguration = { settings: { title: 'reviewed-before' }, topics: { events: 'reviewed/events' },
    bridges: { main: { publish: ['events'], subscribe: [] } }, bindings: [{ providerId: 'reviewed-provider', contract: { id: 'read', version: '1.0.0' } }],
    permissions: { notice: 'reviewed-permissions' } };
  const view = scene({ request: request => request.url.endsWith('/preview') ? reviewed : undefined });
  view.controller.data.programs[0].settings = { title: 'stale-background-parameters' };
  view.controller.data.programs[0].manifest.permissions = { notice: 'stale-background-permissions' };
  await selected(view); await view.controller.previewVersionUpdate();
  assert.match(view.get('version-review').textContent, /reviewed-before/);
  assert.match(view.get('version-review').textContent, /reviewed\/events/);
  assert.match(view.get('version-review').textContent, /reviewed-provider/);
  assert.match(view.get('version-review').textContent, /reviewed-permissions/);
  assert.equal(view.get('version-review').textContent.includes('stale-background'), false);
});
