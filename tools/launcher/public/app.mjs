import { initialLanguage, translate, applyLanguage } from './i18n.mjs';
import { createAdvancedUi } from './advanced.mjs';

const $ = selector => document.querySelector(selector);
const sessionKey = 'world-hub.launcher.session';
const state = {
  language: initialLanguage(), view: 'packs', tab: 'status', instances: [], hubs: [],
  selected: null, session: null, auth: null, online: false, loading: false,
  reviews: new Map(), operations: new Map(), topology: null, logs: null,
  importReview: null, trustReview: null, trustKind: 'start', environment: null,
  environmentSelection: {}, lastRefresh: null, renderStamp: '', detailStamp: '', headingStamp: '', topologyStamp: '', topologyLoading: false,
  logSelection: 'all', importRequest: 0, trustRequest: 0, returnNotice: '',
};
const t = (key, variables) => translate(state.language, key, variables);
const idOf = instance => instance?.instanceId ?? instance?.id;
const current = () => state.instances.find(instance => idOf(instance) === state.selected);
const endpoint = (id, action = '') => `/api/instances/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
const running = instance => ['running', 'starting', 'stopping'].includes(instance?.status?.state) && !instance?.status?.stoppedAt;
const exitUnconfirmed = instance => Boolean(instance?.status?.runId) && (!instance?.status?.stoppedAt || instance?.status?.cleanupIncomplete === true);
const isStale = status => status?.observation === 'stale' || status?.supervisorUnavailable === true;
const operationFor = instance => state.operations.get(idOf(instance)) ?? (instance?.operation?.state === 'running' ? instance.operation : null);
const stopBlocked = instance => { const operation = operationFor(instance); return operation && !['start', 'restart'].includes(operation.kind); };
const preparing = instance => ['start', 'restart'].includes(operationFor(instance)?.kind);
let advanced;

// Every remote string is inserted through textContent/text nodes. Pack content never becomes markup.
function el(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'disabled' || key === 'hidden' || key === 'checked') element[key] = Boolean(value);
    else element.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
const button = (label, callback, className = 'button', disabled = false) => el('button', { type: 'button', class: className, onclick: callback, disabled }, label);
const pill = (label, tone = '') => el('span', { class: `pill${tone ? ` pill-${tone}` : ''}` }, label);
function localLink(label, value, className = 'button button-quiet', newTab = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) return null;
    return el('a', { href: url.href, ...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : { rel: 'noreferrer' }), class: className }, label);
  } catch { return null; }
}
function display(value) { return typeof value === 'string' ? value : value === undefined || value === null ? '—' : JSON.stringify(value); }
function date(value) {
  if (!value) return '—';
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? String(value) : instant.toLocaleString(state.language === 'zh' ? 'zh-CN' : 'en-US');
}
function definition(entries, className = 'definition-grid') {
  return el('dl', { class: className }, entries.map(([key, value]) => el('div', {}, [el('dt', {}, key), el('dd', {}, display(value))])));
}
function showNotice(target, message, tone = 'error') {
  const node = typeof target === 'string' ? $(target) : target;
  node.className = `notice${tone ? ` notice-${tone}` : ''}`;
  node.textContent = message;
  node.hidden = !message;
}
let toastTimer;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }

class ApiError extends Error {
  constructor(data, status) { super(data?.error?.message ?? `HTTP ${status}`); this.code = data?.error?.code; this.status = status; this.guidance = data?.guidance; this.requirements = data?.requirements; this.diagnostic = data?.diagnostic ?? data?.error?.diagnostic; this.incompleteDestination = data?.incompleteDestination ?? data?.error?.incompleteDestination; }
}
async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (state.auth?.token) headers.Authorization = `Bearer ${state.auth.token}`;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (state.auth?.csrfToken) headers['X-CSRF-Token'] = state.auth.csrfToken; }
  let response;
  try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(35000) }); }
  catch (error) { throw new Error(`${t('connectionFailed')} ${error.message}`); }
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    if (response.status === 401) { state.online = false; state.auth = null; try { sessionStorage.removeItem(sessionKey); } catch {} showNotice('#connection-notice', t('sessionExpired')); }
    throw new ApiError(data, response.status);
  }
  return data;
}

function errorContents(error) {
  const nodes = [error.diagnostic?.[state.language] ? el('p', {}, error.diagnostic[state.language]) : null, el('p', {}, error.message)].filter(Boolean);
  if (error.incompleteDestination) nodes.push(el('p', {}, `${t('destination')}: ${error.incompleteDestination}`));
  if (error.requirements) nodes.push(el('pre', { class: 'review-digest' }, JSON.stringify(error.requirements, null, 2)));
  if (error.guidance?.length) nodes.push(guidance(error.guidance));
  return nodes;
}
function renderError(target, error) { const node = $(target); node.className = 'notice notice-error'; node.replaceChildren(...errorContents(error)); node.hidden = false; }
function operationError(error) {
  let dialog = $('#operation-error-dialog');
  if (!dialog) { dialog = el('dialog', { id: 'operation-error-dialog', class: 'dialog' }); document.body.append(dialog); }
  dialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', {}, t('operationFailed')), button('×', () => dialog.close(), 'icon-button')]), ...errorContents(error));
  if (!dialog.open) dialog.showModal();
}
function guidance(items) {
  const section = el('div', { class: 'review-section' }, el('h3', {}, t('repairSteps')));
  for (const item of items ?? []) {
    const content = typeof item === 'string' ? item : [item.message, item.command, item.detail].filter(Boolean).join('\n') || JSON.stringify(item);
    const pre = el('pre', { class: 'review-digest' }, content);
    const copy = button(t('copy'), async () => {
      try { await navigator.clipboard.writeText(content); toast(t('copied')); } catch { toast(t('copyUnavailable')); }
    }, 'button button-small button-quiet');
    section.append(el('div', { class: 'log-panel' }, [pre, copy]));
  }
  return section;
}

function statusLabel(instance) {
  const status = instance?.status ?? {};
  if (status.cleanupIncomplete && !status.stoppedAt) return [t('cleanupIncomplete'), 'amber'];
  if (isStale(status)) return [t('stale'), 'amber'];
  const key = status.state ?? 'imported';
  return [t(key), key === 'running' ? 'teal' : key === 'failed' ? 'red' : ['starting', 'stopping'].includes(key) ? 'amber' : ''];
}
function processBadge(value) { return pill(t(value === 'running' ? 'processRunning' : value === 'exited' ? 'processExited' : ['starting', 'failed'].includes(value) ? value : 'unknown'), value === 'running' ? 'teal' : value === 'failed' ? 'red' : ''); }
function commBadge(value) { return pill(t(value === 'connected' ? 'connected' : value === 'disconnected' ? 'disconnected' : 'unknown'), value === 'connected' ? 'teal' : ''); }
function healthBadge(value) { return pill(t(!value?.lastCheckedAt ? 'noHealthCheck' : value.ready === true ? 'healthPassed' : 'healthFailed'), !value?.lastCheckedAt ? '' : value.ready === true ? 'teal' : 'red'); }
function readinessBadge(value) { return pill(t(value === 'ready' ? 'ready' : value === 'not-ready' ? 'notReady' : 'unknown'), value === 'ready' ? 'teal' : ''); }

function stats() {
  const counts = [state.instances.length, state.instances.filter(i => i.status?.state === 'running' && !isStale(i.status)).length, state.instances.reduce((n, i) => n + (i.status?.components?.length || state.reviews.get(idOf(i))?.review?.pack?.components?.length || 0), 0), state.instances.filter(i => i.status?.state === 'failed' || isStale(i.status) || i.status?.cleanupIncomplete).length];
  return [['totalInstances', 'independentlyManaged', '◇'], ['runningInstances', 'observedProcesses', '▶'], ['moduleCount', 'declaredModules', '⌘'], ['attention', 'failuresAndUnknown', '◌']].map(([label, note, icon], index) => el('div', { class: 'stat' }, [el('div', { class: 'stat-top' }, [t(label), el('span', { class: 'stat-icon', 'aria-hidden': 'true' }, icon)]), el('strong', { class: 'stat-value' }, counts[index]), el('p', { class: 'stat-note' }, t(note))]));
}
function renderStats() { $('#pack-stats').replaceChildren(...stats()); $('#overview-stats').replaceChildren(...stats()); }
function packCard(instance) {
  const id = idOf(instance), status = instance.status ?? {}, busy = Boolean(operationFor(instance));
  const modules = status.components ?? [];
  const reviewCount = state.reviews.get(id)?.review?.pack?.components?.length;
  const [label, tone] = statusLabel(instance);
  const facts = definition([[t('modules'), `${modules.length || reviewCount || '—'}`], [t('communication'), isStale(status) ? t('unknown') : modules.length ? `${modules.filter(c => c.communication === 'connected').length} / ${modules.length}` : '—']], 'pack-facts');
  const detached = instance.detached === true || status.state === 'detached';
  const primary = detached ? button(advanced.label('storage'), () => selectInstance(id, 'storage'), 'button button-small button-quiet') : running(instance) || exitUnconfirmed(instance) || preparing(instance) ? button(t('stop'), () => stopInstance(id), 'button button-small button-quiet', stopBlocked(instance) || status.state === 'stopping') : button(t('start'), () => reviewInstance(id, 'start'), 'button button-small button-primary', busy);
  return el('article', { class: 'pack-card' }, [el('div', { class: 'pack-card-top' }, [el('div', { class: 'pack-title-row' }, [el('div', { class: 'pack-symbol', 'aria-hidden': 'true' }, '◇'), el('div', {}, [el('h3', {}, instance.pack?.title ?? instance.pack?.id ?? id), el('div', { class: 'pack-version' }, `v${instance.pack?.version ?? '—'}`)]), pill(label, tone)]), el('div', { class: 'pack-id' }, id), facts]), el('div', { class: 'pack-card-footer' }, [button(`${t('viewDetails')} →`, () => selectInstance(id), 'text-link'), primary])]);
}
function empty(title, description, action) { return el('div', { class: 'empty-state' }, [el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '◇'), el('h3', {}, title), description ? el('p', {}, description) : null, action]); }
function renderPacks() {
  const search = $('#search').value.trim().toLocaleLowerCase();
  const instances = state.instances.filter(i => `${idOf(i)} ${i.pack?.id ?? ''} ${i.pack?.title ?? ''}`.toLocaleLowerCase().includes(search));
  $('#nav-count').textContent = String(state.instances.length);
  $('#collection-count').textContent = t('items', { count: state.instances.length });
  $('#packs-list').replaceChildren(...(instances.length ? instances.map(packCard) : [empty(t(search ? 'noSearchResults' : 'emptyTitle'), search ? null : t('emptyDescription'), search ? null : button(t('importPack'), openImport, 'button button-primary'))]));
}
function renderOverview() {
  $('#overview-content').replaceChildren(el('div', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', {}, t('instances')), el('span', { class: 'subtle' }, date(state.lastRefresh))]), ...(state.instances.length ? state.instances.map(i => el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, i.pack?.title ?? idOf(i)), el('p', {}, idOf(i))]), el('div', {}, [pill(...statusLabel(i)), button(t('viewDetails'), () => selectInstance(idOf(i)), 'button button-small button-quiet')])])) : [el('p', {}, t('emptyDescription'))]), el('p', { class: 'observation-note' }, t('statusMeaning'))]));
}
function hubCards(workbench = false) {
  const hubs = state.hubs;
  if (!hubs.length) return [empty(t('noRunningHub'), null)];
  return hubs.map(hub => {
    const isDefault = hub.id === 'default', busy = state.operations.has(`hub:${hub.id}`);
    const actions = [];
    if (hub.managementUrl) actions.push(localLink(t('topology'), hub.managementUrl));
    if (hub.workbenchUrl) actions.push(localLink(t('openWorkbench'), hub.workbenchUrl, 'button button-primary'));
    if (isDefault) actions.push(button(t(hub.state === 'running' ? 'stopHub' : 'startHub'), () => hubOperation(hub.state === 'running' ? 'stop' : 'start'), `button${hub.state === 'running' ? ' button-quiet' : ' button-primary'}`, busy));
    else actions.push(button(t('viewInstance'), () => selectInstance(hub.id), 'button button-quiet'));
    return el('article', { class: 'link-card' }, [el('div', {}, [el('div', { class: 'module-header' }, [el('h3', {}, isDefault ? t('defaultHub') : currentTitle(hub.id)), pill(t(hub.state ?? 'unknown'), hub.state === 'running' ? 'teal' : '')]), el('p', {}, isDefault ? t('defaultHubDescription') : t('independentHub')), el('p', { class: 'link-metadata' }, hub.url ?? t('hubWaiting'))]), el('div', { class: 'link-card-actions' }, actions.filter(Boolean))]);
  });
}
function currentTitle(id) { const instance = state.instances.find(i => idOf(i) === id); return instance?.pack?.title ? `${instance.pack.title} · ${id}` : id; }
function renderHubs() { $('#hubs-list').replaceChildren(...hubCards()); $('#workbench-list').replaceChildren(...hubCards(true)); }

function runtimeEnvironment(environment) {
  const nodes = [];
  for (const kind of ['node', 'python']) {
    const runtime = environment?.[kind];
    if (!runtime) continue;
    const available = runtime.available !== false && Boolean(runtime.version);
    nodes.push(el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, `${kind === 'node' ? 'Node.js' : 'Python'} ${runtime.version ?? ''}`), el('p', {}, runtime.executable ?? runtime.error ?? '—'), runtime.packages && Object.keys(runtime.packages).length ? el('p', {}, Object.entries(runtime.packages).map(([name, version]) => `${name} ${display(version)}`).join(' · ')) : null, runtime.error ? el('p', {}, runtime.error) : null]), pill(t(available ? 'available' : 'unavailable'), available ? 'teal' : 'red')]));
  }
  return nodes;
}
function renderEnvironment() {
  const target = $('#environment-results');
  target.replaceChildren(...(state.environment ? runtimeEnvironment(state.environment.environment) : [el('p', { class: 'field-help' }, t('detectFirst'))]));
  if (state.environment?.guidance?.length) target.append(guidance(state.environment.guidance));
  $('#diagnostic-info').replaceChildren(...definition([[t('instancesRoot'), state.session?.root], [t('launcherVersion'), state.session?.softwareVersion ?? state.session?.version], [t('platform'), state.environment?.environment?.platform], [t('architecture'), state.environment?.environment?.arch]]).children);
}

function permissions(declared) {
  if (!declared || !Object.keys(declared).length) return [pill(t('noPermissions'))];
  const labels = { filesystem: 'fileAccess', network: 'networkAccess', processes: 'subprocesses' };
  return Object.entries(declared).map(([key, value]) => el('span', { class: 'permission' }, `${t(labels[key] ?? key)}: ${Array.isArray(value) ? value.join(', ') : display(value)}`));
}
function moduleView(module, review, full = true) {
  const manifest = module.manifest ?? module, source = module.source ?? '—';
  const sourceLocation = `${review.directory ?? ''}${review.directory ? ' / ' : ''}${source}`;
  const panel = el('article', { class: full ? 'panel module-card' : 'review-module' }, [el(full ? 'div' : 'h4', { class: full ? 'module-header' : '' }, full ? [el('h3', {}, `${manifest.id ?? '—'} · ${manifest.version ?? '—'}`), pill(`${manifest.runtime?.kind ?? '—'} · ${manifest.runtime?.entry ?? '—'}`)] : `${manifest.id ?? '—'} · ${manifest.version ?? '—'}`), el('p', { class: full ? 'module-source' : '' }, `${t('source')}: ${sourceLocation}`), el('div', { class: 'module-permissions' }, permissions(manifest.permissions)), el('p', { class: 'field-help' }, `${t('sourceFiles', { count: Object.keys(module.files ?? {}).length })} · ${t('declaredNotEnforced')}`)]);
  if (full) panel.append(el('details', { class: 'json-details' }, [el('summary', {}, t('fullManifest')), el('pre', {}, JSON.stringify(manifest, null, 2))]));
  return panel;
}
function reviewView(data, mode = 'execution') {
  const review = data.review;
  const nodes = [el('div', { class: 'review-summary' }, [el('div', {}, [el('h3', {}, review.pack?.title ?? review.pack?.id ?? '—'), el('p', {}, `${review.pack?.id ?? '—'} · v${review.pack?.version ?? '—'}`)]), pill(t('noSandbox'), 'amber')]), el('div', { class: `notice ${mode === 'execution' ? 'notice-warning' : ''}` }, t(mode === 'execution' ? 'codeExecutionNotice' : 'importNoExecution')), el('div', { class: 'review-section' }, [el('h3', {}, t('source')), el('p', { class: 'review-digest' }, review.directory ?? '—')]), el('div', { class: 'review-section' }, [el('h3', {}, t('modulesPermissions')), el('div', { class: 'review-modules' }, (review.modules ?? []).map(module => moduleView(module, review, false)))]), el('div', { class: 'review-section' }, [el('h3', {}, t('executionOrder')), el('div', { class: 'review-order' }, (review.order ?? []).flatMap((id, i) => [i ? '→' : null, el('span', {}, id)]))]), el('div', { class: 'review-section' }, [el('h3', {}, t('environmentReview')), ...runtimeEnvironment(review.environment)])];
  if (data.permissionDiff?.length) nodes.push(el('div', { class: 'notice notice-warning' }, [el('h3', {}, t('permissionChanges')), el('p', {}, t('changesRequireReview')), ...data.permissionDiff.map(change => el('div', { class: 'review-module' }, [el('h4', {}, change.module ?? '—'), ...Object.keys({ ...change.before, ...change.after }).filter(key => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key])).map(key => el('p', {}, `${key}: ${display(change.before?.[key])} → ${display(change.after?.[key])}`))]))]));
  nodes.push(el('details', { class: 'json-details' }, [el('summary', {}, t('reviewFingerprint')), el('p', { class: 'review-digest' }, review.digest)]));
  return nodes;
}

function renderDetailHeading(instance) {
  const id = idOf(instance), status = instance.status ?? {}, busy = Boolean(operationFor(instance));
  $('#detail-heading').replaceChildren(el('div', { class: 'detail-title' }, [el('div', { class: 'pack-symbol', 'aria-hidden': 'true' }, '◇'), el('div', {}, [el('h1', {}, instance.pack?.title ?? instance.pack?.id ?? id), el('p', {}, `${id} · v${instance.pack?.version ?? '—'}`)]), pill(...statusLabel(instance))]));
  const actions = [];
  if (running(instance) || exitUnconfirmed(instance) || preparing(instance)) {
    actions.push(button(t('stop'), () => stopInstance(id), 'button button-danger', stopBlocked(instance) || status.state === 'stopping'));
    if (status.state === 'running' && !isStale(status)) actions.push(button(t('restart'), () => reviewInstance(id, 'restart'), 'button', busy));
  } else if (!instance.detached && status.state !== 'detached') actions.push(button(t('start'), () => reviewInstance(id, 'start'), 'button button-primary', busy));
  if (status.state === 'running' && !isStale(status)) { const entry = localLink(t('openApp'), instance.links?.entryUrl, 'button button-primary', true); if (entry) actions.push(entry); }
  const topology = localLink(t('topology'), instance.links?.managementUrl); if (topology) actions.push(topology);
  actions.push(button(t('review'), () => reviewInstance(id, 'review'), 'button button-quiet', busy), button(t('exportPackage'), () => { $('#export-error').hidden = true; $('#export-dialog').showModal(); }, 'button button-quiet', busy || instance.detached || status.state === 'detached'));
  $('#detail-actions').replaceChildren(...actions);
  const notices = [];
  if (isStale(status)) notices.push(el('div', { class: 'notice notice-warning' }, t('staleMeaning')));
  if ((status.cleanupIncomplete || status.state === 'failed') && exitUnconfirmed(instance)) notices.push(el('div', { class: 'notice notice-error' }, t('cleanupMeaning')));
  if (status.failure) notices.push(el('div', { class: 'notice notice-error' }, `${t('startupFailure')}: ${status.failure.message ?? display(status.failure)}`));
  if (operationFor(instance)) notices.push(el('div', { class: 'notice' }, `${t('processing')} ${t(operationFor(instance).kind)}`));
  $('#detail-notice').replaceChildren(...notices);
}
function renderStatus(instance) {
  const status = instance.status ?? {}, components = status.components ?? [];
  const headers = ['modules', 'process', 'communication', 'readiness', 'health', 'businessResult'];
  const table = el('table', {}, [el('thead', {}, el('tr', {}, headers.map(key => el('th', { scope: 'col' }, t(key))))), el('tbody', {}, components.map(c => el('tr', {}, [el('td', {}, [el('div', {}, c.id), el('small', { class: 'subtle' }, c.module)]), el('td', {}, [processBadge(isStale(status) ? null : c.process), el('div', { class: 'subtle mono' }, `PID ${c.pid ?? '—'}`)]), el('td', {}, commBadge(isStale(status) ? null : c.communication)), el('td', {}, readinessBadge(isStale(status) ? null : c.readiness)), el('td', {}, healthBadge(isStale(status) ? null : c.health)), el('td', { class: 'subtle' }, t('businessUnknown'))]))) ]);
  const nodes = [components.length ? el('div', { class: 'status-table-wrap' }, table) : el('div', { class: 'panel' }, el('p', {}, t('notStarted'))), el('p', { class: 'observation-note' }, t('statusMeaning'))];
  nodes.push(el('div', { class: 'panel topology-panel' }, [el('div', { class: 'panel-heading' }, [el('h2', {}, t('bridgeOwnership')), button(t('refreshTopology'), () => loadTopology(idOf(instance), true), 'button button-small button-quiet')]), el('div', { id: 'bridge-mapping' }, topologyView(instance)), el('p', { class: 'observation-note' }, t('mappingNotice'))]));
  return nodes;
}
function topologyView(instance) {
  const topology = state.topology?.instanceId === idOf(instance) ? state.topology : null;
  if (!topology || topology.runId !== instance.status?.runId) return [el('p', { class: 'field-help' }, t('topologyUnavailable'))];
  if (!topology.bridges?.length) return [el('p', { class: 'field-help' }, t('noBridges'))];
  return topology.bridges.map(bridge => el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, bridge.bridgeId ?? bridge.declaredId ?? '—'), el('p', {}, `${t('principal')}: ${bridge.principal ?? '—'} · ${t('bridgeSession')}: ${bridge.session ?? '—'}`), bridge.ownership === 'managed' ? el('p', {}, `${bridge.componentId ?? '—'} · ${bridge.moduleId ?? '—'} · PID ${bridge.pid ?? '—'}`) : null]), el('div', {}, [pill(t(bridge.ownership === 'managed' ? 'managedBridge' : 'externalUnknown'), bridge.ownership === 'managed' ? 'teal' : 'amber'), bridge.ownership === 'managed' ? button(t('logs'), () => { state.logSelection = bridge.componentId; changeTab('logs'); }, 'button button-small button-quiet') : null, localLink(t('topology'), bridge.managementUrl, 'button button-small button-quiet')]) ]));
}
function renderModules(instance) {
  const review = state.reviews.get(idOf(instance))?.review;
  if (!review) return [empty(t('noModuleReview'), t('probeNotice'), button(t('review'), () => reviewInstance(idOf(instance), 'review'), 'button button-primary'))];
  return [el('div', { class: 'notice notice-warning' }, t('sandboxNotice')), ...(review.modules ?? []).map(module => moduleView(module, review)), el('p', { class: 'observation-note' }, t('sourceSafeText'))];
}
function renderLogs(instance) {
  const logs = state.logs?.instanceId === idOf(instance) ? state.logs.logs ?? {} : {};
  const selection = state.logSelection;
  const select = el('select', { id: 'log-component', 'aria-label': t('modules') }, [el('option', { value: 'all' }, t('allComponents')), ...Object.keys(logs).map(id => el('option', { value: id }, id))]);
  select.value = Object.hasOwn(logs, selection) || selection === 'all' ? selection : 'all';
  select.addEventListener('change', () => { state.logSelection = select.value; renderDetail(true); });
  const panels = [];
  for (const [id, values] of Object.entries(logs)) {
    if (select.value !== 'all' && select.value !== id) continue;
    for (const stream of ['stdout', 'stderr']) if (values[stream]) panels.push(el('section', { class: `log-panel${stream === 'stderr' ? ' log-stderr' : ''}` }, [el('h3', {}, `${id} / ${t(stream)}${values.truncated ? ` · ${t('truncated')}` : ''}`), el('pre', {}, values[stream])]));
  }
  return [el('div', { class: 'log-toolbar' }, [select, button(t('refreshLogs'), () => loadLogs(idOf(instance), true), 'button button-small button-quiet')]), el('div', { class: 'notice' }, t('privacyNotice')), ...(panels.length ? panels : [el('div', { class: 'panel' }, el('p', {}, t('noLogs')))])];
}
function renderDetails(instance) {
  const status = instance.status ?? {};
  return [el('div', { class: 'panel' }, [el('h2', {}, t('instanceDetails')), definition([[t('instanceId'), idOf(instance)], [t('importedAt'), date(instance.importedAt)], [t('instanceDirectory'), instance.directory], [t('runId'), status.runId], [t('observedAt'), date(status.components?.[0]?.communicationObservedAt)], [t('stoppedAt'), date(status.stoppedAt)], [t('boundEnvironment'), instance.environment]]), el('p', { class: 'observation-note' }, t('isolationNotice'))])];
}
function renderDetail(force = false) {
  if (state.view !== 'detail') return;
  const instance = current();
  if (!instance) { navigate('packs'); return; }
  const headingStamp = JSON.stringify([instance.pack, instance.links, instance.status?.state, instance.status?.observation, instance.status?.cleanupIncomplete, instance.status?.stoppedAt, instance.status?.failure, state.language, state.operations.get(state.selected)]);
  if (force || headingStamp !== state.headingStamp) { renderDetailHeading(instance); state.headingStamp = headingStamp; }
  const content = state.tab === 'status'
    ? [instance.status?.components?.map(c => [c.id, c.module, c.pid, c.process, c.communication, c.readiness, Boolean(c.health?.lastCheckedAt), c.health?.ready]), instance.status?.runId, instance.status?.observation, state.topology]
    : state.tab === 'logs' ? state.logs : state.tab === 'modules' ? state.reviews.get(state.selected)?.reviewId : instance;
  const stamp = JSON.stringify([state.selected, content, state.tab, state.language]);
  if (!force && stamp === state.detailStamp) return;
  state.detailStamp = stamp;
  const children = state.tab === 'status' ? renderStatus(instance) : state.tab === 'modules' ? renderModules(instance) : state.tab === 'logs' ? renderLogs(instance) : state.tab === 'storage' ? advanced.renderStorage(instance) : renderDetails(instance);
  $('#detail-content').replaceChildren(...children);
}
function renderAll(force = false) {
  const stamp = JSON.stringify([state.instances.map(i => [idOf(i), i.pack, i.status?.state, i.status?.observation, i.status?.cleanupIncomplete, i.status?.components?.map(c => [c.id, c.communication]), state.reviews.get(idOf(i))?.reviewId]), state.hubs, [...state.operations.entries()], state.language]);
  if (force || stamp !== state.renderStamp) { renderStats(); renderPacks(); renderOverview(); renderHubs(); state.renderStamp = stamp; }
  renderDetail(force);
}

function navigate(view, updateHash = true) {
  state.view = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  for (const item of document.querySelectorAll('[data-view]')) { const selected = item.dataset.view === (view === 'detail' ? 'packs' : view); item.classList.toggle('active', selected); if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
  $('#breadcrumb').textContent = view === 'detail' ? currentTitle(state.selected) : ['sources', 'creator'].includes(view) ? advanced.label(view) : t({ packs: 'myPacks', overview: 'overview', hubs: 'hubs', workbench: 'workbench', environment: 'environment' }[view]);
  if (updateHash) history.replaceState(null, '', `${location.pathname}${view === 'detail' ? `?instance=${encodeURIComponent(state.selected)}` : ''}#${view === 'detail' ? state.tab : view}`);
  if (view === 'environment') renderEnvironment();
  advanced?.navigate(view);
  renderAll(true);
}
async function selectInstance(id, tab = 'status', componentId = null) {
  state.selected = id; state.topology = null; state.logs = null; state.detailStamp = ''; state.headingStamp = ''; state.topologyStamp = '';
  state.logSelection = componentId ?? 'all';
  changeTab(tab, false); navigate('detail');
  try { const result = await api(endpoint(id)); replaceInstance(result.instance); renderDetail(true); if (tab === 'logs') await loadLogs(id); else if (tab === 'status') await loadTopology(id); }
  catch (error) { toast(error.message); }
}
function changeTab(tab, updateHash = true) {
  state.tab = tab;
  $('#detail-content').setAttribute('aria-labelledby', `tab-${tab}`);
  for (const button of document.querySelectorAll('[data-tab]')) { const selected = button.dataset.tab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
  renderDetail(true);
  if (updateHash) { history.replaceState(null, '', `${location.pathname}?instance=${encodeURIComponent(state.selected)}#${tab}`); if (tab === 'logs') void loadLogs(state.selected, true); if (tab === 'status') void loadTopology(state.selected, true); }
  if (tab === 'storage') advanced?.loadStorage(state.selected);
}
function replaceInstance(instance) { const id = idOf(instance), index = state.instances.findIndex(i => idOf(i) === id); if (index === -1) state.instances.push(instance); else state.instances[index] = instance; }

async function refresh({ explicit = false } = {}) {
  if (state.loading || !state.auth?.token) return;
  state.loading = true;
  try {
    const results = await Promise.allSettled([api('/api/instances'), api('/api/hubs')]);
    if (results[0].status === 'rejected') throw results[0].reason;
    state.instances = results[0].value.instances ?? [];
    if (results[1].status === 'fulfilled') state.hubs = results[1].value.hubs ?? [];
    else if (explicit) toast(results[1].reason.message);
    state.online = true; state.lastRefresh = new Date().toISOString(); showNotice('#connection-notice', state.returnNotice, state.returnNotice ? 'warning' : ''); renderAll(explicit);
    if (state.view === 'detail' && state.tab === 'status') {
      const instance = current(), topologyStamp = JSON.stringify([instance?.status?.runId, instance?.status?.components?.map(c => c.bridges)]);
      if (topologyStamp !== state.topologyStamp && !state.topologyLoading) { state.topologyStamp = topologyStamp; void loadTopology(state.selected); }
    }
  } catch (error) { state.online = false; showNotice('#connection-notice', error.message); }
  finally { state.loading = false; $('#connection-state').textContent = t(state.online ? 'online' : 'offline'); }
}
async function loadTopology(id, explicit = false) {
  const instance = current(); if (!id || !instance?.status?.runId || !running(instance)) return;
  if (state.topologyLoading) return;
  state.topologyLoading = true;
  try {
    const data = await api(`${endpoint(id, 'topology')}?runId=${encodeURIComponent(instance.status.runId)}`);
    if (state.selected !== id || current()?.status?.runId !== data.topology?.runId) return;
    state.topology = data.topology; renderDetail(true);
  } catch (error) { if (explicit) toast(error.message); }
  finally { state.topologyLoading = false; }
}
async function loadLogs(id, explicit = false) {
  if (!id) return;
  try { const data = await api(endpoint(id, 'logs')); if (state.selected !== id) return; state.logs = data.logs; renderDetail(true); }
  catch (error) { if (explicit) toast(error.message); }
}

function openImport() {
  state.importRequest++;
  state.importReview = null;
  $('#import-review').hidden = true; $('#import-fields').hidden = false; $('#import-error').hidden = true; $('#import-back').hidden = true;
  $('#import-submit').textContent = t('checkPackage'); $('#import-submit').disabled = false;
  $('#step-select').classList.add('active'); $('#step-review').classList.remove('active'); $('#step-create').classList.remove('active');
  for (const kind of ['nodePath', 'pythonPath']) $('#import-form').elements[kind].value = state.environmentSelection[kind] ?? state.session?.defaults?.[kind] ?? '';
  const directory = state.session?.defaults?.packDirectory;
  if (directory && !$('#import-form').elements.directory.value) $('#import-form').elements.directory.value = directory;
  $('#import-dialog').showModal();
}
function environmentOptions(form) { return Object.fromEntries(['nodePath', 'pythonPath'].map(key => [key, form.elements[key]?.value.trim()]).filter(([, value]) => value)); }
async function importSubmit(event) {
  event.preventDefault(); const form = event.currentTarget, submit = $('#import-submit');
  if (submit.disabled) return;
  const request = state.importRequest;
  $('#import-error').hidden = true; submit.disabled = true;
  try {
    if (!state.importReview) {
      submit.textContent = t('checking');
      const data = await api('/api/review', { directory: form.elements.directory.value.trim(), ...environmentOptions(form) });
      if (request !== state.importRequest || !$('#import-dialog').open) return;
      state.importReview = data; $('#import-review').replaceChildren(...reviewView(data, 'import')); $('#import-review').hidden = false; $('#import-fields').hidden = true; $('#import-back').hidden = false;
      $('#step-review').classList.add('active'); $('#step-create').classList.add('active'); submit.textContent = t('confirmImport');
    } else {
      submit.textContent = t('importing');
      const data = await api('/api/instances', { reviewId: state.importReview.reviewId, instanceId: form.elements.instanceId.value.trim() });
      const id = idOf(data.instance); state.reviews.set(id, state.importReview); replaceInstance(data.instance); $('#import-dialog').close(); state.importReview = null; renderAll(true); toast(t('importedSuccess', { id })); await selectInstance(id);
    }
  } catch (error) { if (request === state.importRequest) renderError('#import-error', error); }
  finally { if (request === state.importRequest) { submit.disabled = false; submit.textContent = t(state.importReview ? 'confirmImport' : 'checkPackage'); } }
}
async function reviewInstance(id, kind) {
  const instance = state.instances.find(i => idOf(i) === id); if (!instance || operationFor(instance)) return;
  const request = ++state.trustRequest;
  state.trustReview = null; state.trustKind = kind; $('#trust-consent').checked = false; $('#trust-submit').disabled = true; $('#trust-error').hidden = true;
  $('#trust-review').replaceChildren(el('p', { class: 'dialog-description' }, t('checking')));
  $('#trust-submit').textContent = t(kind === 'restart' ? 'trustAndRestart' : 'trustAndStart');
  $('.consent').hidden = kind === 'review'; $('#trust-submit').hidden = kind === 'review'; $('#trust-dialog').showModal();
  try {
    const selected = Object.keys(state.environmentSelection).length ? state.environmentSelection : instance.environment ?? {};
    const data = await api(endpoint(id, 'review'), selected);
    if (request !== state.trustRequest || !$('#trust-dialog').open) return;
    state.reviews.set(id, data); state.trustReview = { ...data, instanceId: id };
    $('#trust-review').replaceChildren(...reviewView(data), el('p', { class: 'field-help' }, t('reviewEnvironmentHint'))); renderDetail(true);
  } catch (error) { if (request !== state.trustRequest) return; $('#trust-review').replaceChildren(el('p', {}, t('envMissing'))); renderError('#trust-error', error); }
}
async function authorizeExecution() {
  const review = state.trustReview;
  if (!review || !$('#trust-consent').checked) return;
  $('#trust-submit').disabled = true; $('#trust-error').hidden = true;
  try {
    const data = await api(endpoint(review.instanceId, state.trustKind), { reviewId: review.reviewId, accepted: true });
    $('#trust-dialog').close(); state.trustReview = null; await followOperation(data.operationId, review.instanceId, state.trustKind);
  } catch (error) { renderError('#trust-error', error); $('#trust-submit').disabled = false; }
}
async function stopInstance(id) {
  const instance = state.instances.find(i => idOf(i) === id);
  if (stopBlocked(instance)) return;
  try { const data = await api(endpoint(id, 'stop'), {}); await followOperation(data.operationId, id, 'stop'); }
  catch (error) { toast(error.message); }
}
async function hubOperation(kind) {
  if (state.operations.has('hub:default')) return;
  try { const data = await api(`/api/hubs/default/${kind}`, {}); await followOperation(data.operationId, 'hub:default', kind); }
  catch (error) { operationError(error); }
}
async function followOperation(operationId, instanceId, kind) {
  if (!operationId) { await refresh({ explicit: true }); return; }
  state.operations.set(instanceId, { operationId, kind }); renderAll(true);
  if (!instanceId.startsWith('hub:') && ['start', 'stop', 'restart'].includes(kind)) toast(t(`${kind}Accepted`, { id: instanceId }));
  // Lifecycle completion is taken from the operation and refreshed status, never a stored PID.
  const poll = async () => {
    try {
      const data = await api(`/api/operations/${encodeURIComponent(operationId)}`), operation = data.operation;
      if (operation.state === 'running') { await refresh(); setTimeout(poll, 1000); return; }
      if (state.operations.get(instanceId)?.operationId === operationId) state.operations.delete(instanceId);
      if (operation.state === 'failed') operationError(Object.assign(new Error(operation.error?.message ?? t('operationFailed')), operation.error ?? {}));
      else if (kind === 'export') toast(t('exportedSuccess', { destination: operation.result?.destination ?? state.exportDestination ?? '—' }));
      else if (instanceId === 'hub:default') toast(t(kind === 'start' ? 'defaultHubStarted' : 'defaultHubStopped'));
      await refresh({ explicit: true });
      if (state.selected === instanceId) { if (state.tab === 'logs') await loadLogs(instanceId); if (state.tab === 'status') await loadTopology(instanceId); }
    } catch (error) { if (state.operations.get(instanceId)?.operationId === operationId) state.operations.delete(instanceId); renderAll(true); operationError(error); }
  };
  void poll();
}
async function exportSubmit(event) {
  event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('[type=submit]');
  if (!state.selected) return; const id = state.selected;
  submit.disabled = true; $('#export-error').hidden = true;
  try { state.exportDestination = form.elements.destination.value.trim(); const data = await api(endpoint(id, 'export'), { destination: state.exportDestination }); $('#export-dialog').close(); await followOperation(data.operationId, id, 'export'); }
  catch (error) { renderError('#export-error', error); }
  finally { submit.disabled = false; }
}
async function detectEnvironment(event) {
  event?.preventDefault(); const form = $('#environment-form'), submit = form.querySelector('[type=submit]'); submit.disabled = true;
  const selection = environmentOptions(form);
  try { state.environment = await api('/api/environment', selection); state.environmentSelection = selection; renderEnvironment(); toast(t('detected')); }
  catch (error) { $('#environment-results').replaceChildren(el('div', { class: 'notice notice-error' }, errorContents(error))); }
  finally { submit.disabled = false; }
}

function languageChanged() {
  applyLanguage(state.language); $('#language').value = state.language;
  for (const item of document.querySelectorAll('[data-view]')) item.setAttribute('aria-label', t({packs:'myPacks',overview:'overview',hubs:'hubs',workbench:'workbench',environment:'environment'}[item.dataset.view]));
  $('#theme').title = t('toggleTheme'); $('#theme').setAttribute('aria-label', t('toggleTheme')); $('#navigation').setAttribute('aria-label', t('mainNavigation')); $('.sidebar nav:nth-of-type(2)').setAttribute('aria-label', t('systemNavigation')); $('#search').setAttribute('aria-label', t('searchInstances'));
  for (const close of document.querySelectorAll('.close-dialog')) close.setAttribute('aria-label', t('close'));
  $('#connection-state').textContent = t(state.online ? 'online' : 'offline');
  renderAll(true); renderEnvironment();
  if (state.importReview) { $('#import-review').replaceChildren(...reviewView(state.importReview, 'import')); $('#import-submit').textContent = t('confirmImport'); }
  if (state.trustReview) { $('#trust-review').replaceChildren(...reviewView(state.trustReview)); $('#trust-submit').textContent = t(state.trustKind === 'restart' ? 'trustAndRestart' : 'trustAndStart'); }
  advanced?.languageChanged();
  $('#breadcrumb').textContent = state.view === 'detail' ? currentTitle(state.selected) : ['sources', 'creator'].includes(state.view) ? advanced.label(state.view) : t({ packs: 'myPacks', overview: 'overview', hubs: 'hubs', workbench: 'workbench', environment: 'environment' }[state.view]);
}
function initializeEvents() {
  for (const item of document.querySelectorAll('[data-view]')) item.addEventListener('click', () => navigate(item.dataset.view));
  for (const item of document.querySelectorAll('[data-action=import]')) item.addEventListener('click', openImport);
  for (const item of document.querySelectorAll('[data-tab]')) item.addEventListener('click', () => changeTab(item.dataset.tab));
  $('.detail-tabs').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const tabs = [...document.querySelectorAll('[data-tab]')], index = tabs.findIndex(tab => tab.dataset.tab === state.tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); changeTab(tabs[next].dataset.tab); tabs[next].focus(); });
  for (const item of document.querySelectorAll('.close-dialog')) item.addEventListener('click', () => $(`#${item.dataset.dialog}`).close());
  $('#trust-dialog').addEventListener('close', () => { state.trustRequest++; state.trustReview = null; $('#trust-consent').checked = false; $('#trust-submit').disabled = true; });
  $('#import-dialog').addEventListener('close', () => { state.importRequest++; });
  $('#language').addEventListener('change', event => { state.language = event.target.value; try { localStorage.setItem('world-hub.launcher.language', state.language); } catch {} languageChanged(); });
  $('#theme').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('world-hub.launcher.theme', theme); } catch {} });
  $('#refresh').addEventListener('click', () => refresh({ explicit: true })); $('#search').addEventListener('input', renderPacks); $('#back-to-packs').addEventListener('click', () => navigate('packs'));
  $('#import-form').addEventListener('submit', importSubmit); $('#import-back').addEventListener('click', () => { state.importReview = null; $('#import-review').hidden = true; $('#import-fields').hidden = false; $('#import-back').hidden = true; $('#import-submit').textContent = t('checkPackage'); $('#import-error').hidden = true; $('#step-review').classList.remove('active'); $('#step-create').classList.remove('active'); });
  $('#trust-consent').addEventListener('change', event => { $('#trust-submit').disabled = !event.target.checked || !state.trustReview; }); $('#trust-submit').addEventListener('click', authorizeExecution); $('#export-form').addEventListener('submit', exportSubmit); $('#environment-form').addEventListener('submit', detectEnvironment);
  $('.brand').addEventListener('click', event => { event.preventDefault(); navigate('packs'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}

async function resolveReturnHint(hints) {
  if (!hints.instance) return false;
  const instance = state.instances.find(i => idOf(i) === hints.instance); if (!instance) { state.returnNotice = t('reviewChanged'); showNotice('#connection-notice', state.returnNotice, 'warning'); return false; }
  let componentId;
  // Full bridge hints are validated against the live server mapping; no ownership is inferred from names.
  if (hints.runId || hints.hubOrigin || hints.bridgeId || hints.session) {
    try {
      const data = await api(`${endpoint(hints.instance, 'topology')}?runId=${encodeURIComponent(hints.runId ?? '')}`), topology = data.topology;
      if (!hints.runId || !hints.hubOrigin || topology.runId !== hints.runId || new URL(topology.hub.url).origin !== hints.hubOrigin) throw new Error(t('staleMeaning'));
      if (hints.bridgeId || hints.session) {
        const matched = topology.bridges.find(bridge => bridge.bridgeId === hints.bridgeId && String(bridge.session) === hints.session && bridge.ownership === 'managed');
        if (!hints.bridgeId || !hints.session || !matched) throw new Error(t('externalUnknown'));
        componentId = matched.componentId;
      }
    } catch (error) { state.returnNotice = error.message; showNotice('#connection-notice', state.returnNotice, 'warning'); return false; }
  }
  await selectInstance(hints.instance, ['status', 'modules', 'logs', 'details'].includes(hints.tab) ? hints.tab : 'status', componentId); return true;
}

async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1)), launchCode = hash.get('launch');
  const queries = new URLSearchParams(location.search), hints = Object.fromEntries(queries); hints.tab = location.hash.slice(1);
  const initialView = ['packs', 'overview', 'hubs', 'workbench', 'environment', 'sources', 'creator'].includes(hints.tab) ? hints.tab : 'packs';
  // Consume the launch capability immediately; it is never stored or left in browser history.
  if (launchCode) history.replaceState(null, '', `${location.pathname}${location.search}`);
  try { const theme = localStorage.getItem('world-hub.launcher.theme'); if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme; } catch {}
  advanced = createAdvancedUi({ state, api, el, button, pill, t, toast, definition, display, date, guidance, errorContents, current, idOf, endpoint, operationFor, exitUnconfirmed, refresh, renderDetail, navigate, changeTab, selectInstance, openImport, replaceInstance, reviewView });
  initializeEvents(); languageChanged(); navigate(initialView, false);
  try {
    if (launchCode) {
      const session = await api('/api/session', { code: launchCode }); state.auth = { token: session.token, csrfToken: session.csrfToken }; state.session = session;
    } else {
      try { state.auth = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null'); } catch { state.auth = null; }
      if (!state.auth?.token) throw new Error(t('sessionRequired'));
      state.session = await api('/api/session');
      if (state.session.csrfToken) state.auth.csrfToken = state.session.csrfToken;
    }
    try { sessionStorage.setItem(sessionKey, JSON.stringify(state.auth)); } catch {}
    $('#version').textContent = state.session.softwareVersion ? `v${state.session.softwareVersion}` : 'LOCAL';
    for (const kind of ['nodePath', 'pythonPath']) $('#environment-form').elements[kind].value = state.session.defaults?.[kind] ?? '';
    advanced.sessionReady();
    await refresh({ explicit: true });
    if (!await resolveReturnHint(hints)) navigate(initialView);
    setInterval(() => { if (!document.hidden && state.auth?.token) void refresh(); }, 1000);
  } catch (error) { showNotice('#connection-notice', error.message); $('#connection-state').textContent = t('offline'); }
}

void boot();
