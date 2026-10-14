import { initialLanguage, translate, applyLanguage } from './i18n.mjs';
import { createAdvancedUi } from './advanced.mjs';
import { createPathUi } from './path-ui.mjs';
import { createTaskUi } from './task-ui.mjs';
import { createIcon, renderSquareArt } from './icons.mjs';
import { groupAssets, createAssetVersionSelection, renderAssetVersionSelector } from './asset-versions.mjs';

const $ = selector => document.querySelector(selector);
const sessionKey = 'world-hub.launcher.session';
const state = {
  language: initialLanguage(), view: 'packs', tab: 'status', instances: [], hubs: [],
  selected: null, session: null, auth: null, online: false, loading: false,
  reviews: new Map(), operations: new Map(), topology: null, logs: null,
  importReview: null, trustReview: null, trustKind: 'start', trustInstanceId: null, environment: null,
  environmentSelection: {}, isolationSelection: null, lastRefresh: null, renderStamp: '', detailStamp: '', headingStamp: '', topologyStamp: '', topologyLoading: false,
  logSelection: 'all', importRequest: 0, trustRequest: 0, logsRequest: 0, returnNotice: '',
  hubsObservedAt: null, hubsUnavailable: false, topologyUnavailable: false,
};
const t = (key, variables) => translate(state.language, key, variables);
const idOf = instance => instance?.instanceId ?? instance?.id;
const declaredModuleCount = instance => instance.moduleCount ?? state.reviews.get(idOf(instance))?.review?.pack?.components?.length ?? null;
function componentRuntimeKind(instance, component) {
  const review = state.reviews.get(idOf(instance))?.review;
  const componentDeclaration = review?.pack?.components?.find(row => row.id === component.id);
  const moduleId = componentDeclaration?.module ?? component.module;
  const module = review?.modules?.find(row => (row.manifest?.id ?? row.id) === moduleId);
  const kind = module?.manifest?.runtime?.kind ?? module?.runtime?.kind ?? component.runtime?.kind ?? component.runtimeKind;
  return ['node', 'python'].includes(kind) ? kind : null;
}
const current = () => state.instances.find(instance => idOf(instance) === state.selected);
const endpoint = (id, action = '') => `/api/instances/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
const running = instance => ['running', 'starting', 'stopping'].includes(instance?.status?.state) && !instance?.status?.stoppedAt;
const exitUnconfirmed = instance => Boolean(instance?.status?.runId) && (!instance?.status?.stoppedAt || instance?.status?.cleanupIncomplete === true);
const observationMaxAgeMs = 10000;
const freshObservation = value => Boolean(value) && Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) <= observationMaxAgeMs;
const observationLive = () => state.online && freshObservation(state.lastRefresh);
const isStale = status => status?.observation === 'stale' || status?.supervisorUnavailable === true || !observationLive();
const operationFor = instance => state.operations.get(idOf(instance)) ?? (instance?.operation?.state === 'running' ? instance.operation : null);
const stopBlocked = instance => { const operation = operationFor(instance); return operation && !['start', 'restart'].includes(operation.kind); };
const preparing = instance => ['start', 'restart'].includes(operationFor(instance)?.kind);
const deletionBlocked = instance => Boolean(operationFor(instance) || running(instance) || exitUnconfirmed(instance)
  || instance?.status?.cleanupIncomplete && !instance?.deletionPending || instance?.maintenanceUnknown || isStale(instance?.status)
  || !['imported', 'stopped', 'detached', 'failed', 'deletion-incomplete'].includes(instance?.status?.state));
let advanced, paths, tasks, restoringHistory = false, historyReady = false;
const say = (zh, en) => state.language === 'zh' ? zh : en;
const packVersionSelection = createAssetVersionSelection({storageKey:'world-hub.pack-version-selection/v1'});
function updateConnectionState(online = state.online) {
  state.online = Boolean(online);
  const stateLabel = $('#connection-state');
  if (stateLabel) stateLabel.textContent = t(state.online ? 'online' : 'offline');
  const dot = $('.local-indicator .status-dot');
  if (dot) dot.classList.toggle('offline', !state.online);
  const indicator = $('.local-indicator');
  if (indicator) indicator.classList.toggle('offline', !state.online);
}

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
function display(value) {
  if (value instanceof Node) return value;
  return typeof value === 'string' ? value : value === undefined || value === null ? '—' : JSON.stringify(value);
}
function date(value) {
  if (!value) return '—';
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? String(value) : instant.toLocaleString(state.language === 'zh' ? 'zh-CN' : 'en-US');
}
function definition(entries, className = 'definition-grid') {
  return el('dl', { class: className }, entries.map(([key, value]) => el('div', {}, [el('dt', {}, key), el('dd', {}, value instanceof Node ? value : display(value))])));
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
  constructor(data, status) { super(data?.error?.message ?? `HTTP ${status}`); this.code = data?.error?.code; this.status = status; this.guidance = data?.guidance; this.requirements = data?.requirements; this.compatibility = data?.error?.compatibility; this.diagnostic = data?.diagnostic ?? data?.error?.diagnostic; this.incompleteDestination = data?.incompleteDestination ?? data?.error?.incompleteDestination; }
}
async function api(path, body) {
  if (!state.auth?.token && path !== '/api/session') throw new Error(t('sessionRequired'));
  const headers = { Accept: 'application/json' };
  if (state.auth?.token) headers.Authorization = `Bearer ${state.auth.token}`;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (state.auth?.csrfToken) headers['X-CSRF-Token'] = state.auth.csrfToken; }
  const timeoutMs = path.includes('native-pick') ? 300000 : 35000;
  let response;
  try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { throw new Error(`${t('connectionFailed')} ${error.message}`); }
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    if (response.status === 401 && path !== '/api/session') { state.online = false; state.auth = null; try { sessionStorage.removeItem(sessionKey); localStorage.removeItem(sessionKey); } catch {} showNotice('#connection-notice', t('sessionExpired')); updateConnectionState(false); }
    throw new ApiError(data, response.status);
  }
  return data;
}

function errorContents(error) {
  const nodes = [error.diagnostic?.[state.language] ? el('p', {}, error.diagnostic[state.language]) : null, el('p', {}, error.message)].filter(Boolean);
  if (error.incompleteDestination) nodes.push(el('p', {}, `${t('destination')}: ${error.incompleteDestination}`));
  if (error.requirements) nodes.push(el('pre', { class: 'review-digest' }, JSON.stringify(error.requirements, null, 2)));
  if (error.compatibility) nodes.push(el('pre', { class: 'review-digest' }, JSON.stringify(error.compatibility, null, 2)));
  if (error.guidance?.length) nodes.push(guidance(error.guidance));
  if (error.diagnostic?.action?.view === 'sources' || ['PACK_LOCK_OBSOLETE', 'PACK_HUB_CONTRACT_UNSUPPORTED'].includes(error.code)) {
    const action = button(say('打开软件源，获取当前资源', 'Open Software Sources for current resources'), () => { action.closest('dialog')?.close(); navigate('sources'); }, 'button button-primary');
    action.setAttribute('data-repair-action', 'open-sources'); nodes.push(action);
  }
  return nodes;
}
function renderError(target, error) { const node = $(target); node.className = 'notice notice-error'; node.replaceChildren(...errorContents(error)); node.hidden = false; }
function operationError(error) {
  let dialog = $('#operation-error-dialog');
  if (!dialog) { dialog = el('dialog', { id: 'operation-error-dialog', class: 'dialog' }); document.body.append(dialog); }
  dialog.setAttribute('aria-labelledby', 'operation-error-title');
  const close = button('×', () => dialog.close(), 'icon-button'); close.setAttribute('aria-label', t('close'));
  dialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', { id: 'operation-error-title' }, t('operationFailed')), close]), ...errorContents(error));
  if (!dialog.open) dialog.showModal();
}

function confirmDialog({ title, message, danger = false, confirmText, onConfirm }) {
  const dialog = el('dialog', { class: 'dialog dialog-small confirm-dialog', 'aria-label': title });
  const close = button('×', () => dialog.close(), 'icon-button close-dialog');
  close.setAttribute('aria-label', t('close'));
  const cancelBtn = button(t('cancel'), () => dialog.close(), 'button button-quiet');
  const actionBtn = button(confirmText || t('confirmDelete'), async () => {
    dialog.close();
    await onConfirm();
  }, danger ? 'button button-danger' : 'button button-primary');
  dialog.replaceChildren(
    el('div', { class: 'dialog-heading' }, [el('h3', {}, title), close]),
    el('p', { class: 'dialog-description' }, message),
    el('div', { class: 'dialog-footer' }, [cancelBtn, actionBtn])
  );
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  return dialog;
}

function confirmDeleteInstance(instance) {
  const id = idOf(instance);
  const status = instance.status ?? {};
  if (deletionBlocked(instance)) {
    toast(say('请先确认实例进程已退出且没有正在进行的操作，再删除实例。', 'Confirm process exit and completion of instance operations before deletion.'));
    return;
  }
  const title = instance.pack?.title ?? instance.pack?.id ?? id;
  confirmDialog({
    title: t('deletePack'),
    message: (instance.deletionPending ? say(`上次删除尚未完成，剩余文件保留在 ${instance.retainedDirectory}。`, `Previous deletion is incomplete. Remaining files are retained at ${instance.retainedDirectory}.`) + '\n' : '')
      + say(`确认彻底删除整合包「${title}」(${id})？这将移除该实例的全部本地文件与运行时数据。此操作不可逆。`, `Permanently delete pack instance "${title}" (${id})? This will remove all local files and runtime data for this instance. This action cannot be undone.`),
    danger: true,
    confirmText: t('delete'),
    onConfirm: async () => {
      try {
        await api(endpoint(id, 'delete'), { accepted: true });
        toast(say(`已删除整合包「${id}」`, `Deleted pack "${id}"`));
        if (state.selected === id) {
          state.selected = null;
          navigate('packs');
        }
        await refresh({ explicit: true });
      } catch (err) {
        await refresh({ explicit: true });
        toast(err.message);
      }
    }
  });
}
function guidance(items) {
  const section = el('div', { class: 'review-section' }, el('h3', {}, t('repairSteps')));
  for (const item of items ?? []) {
    const content = typeof item === 'string' ? item : item[state.language] ?? ([item.message, item.command, item.detail].filter(Boolean).join('\n') || JSON.stringify(item));
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
function healthBadge(value) { const fresh = freshObservation(value?.lastCheckedAt); return pill(t(!value?.lastCheckedAt ? 'noHealthCheck' : !fresh ? 'healthUnknown' : value.ready === true ? 'healthPassed' : 'healthFailed'), !fresh ? '' : value.ready === true ? 'teal' : 'red'); }
function readinessBadge(value) { return pill(t(value === 'ready' ? 'ready' : value === 'not-ready' ? 'notReady' : 'unknown'), value === 'ready' ? 'teal' : ''); }

function stats() {
  const declared = state.instances.map(i => i.moduleCount ?? state.reviews.get(idOf(i))?.review?.pack?.components?.length ?? null);
  const counts = [state.instances.length, state.instances.filter(i => i.status?.state === 'running' && !isStale(i.status)).length, declared.some(n => n === null) ? t('unknown') : declared.reduce((a, b) => a + b, 0), state.instances.filter(i => i.status?.state === 'failed' || isStale(i.status) || i.status?.cleanupIncomplete).length];
  return [['totalInstances', 'independentlyManaged', 'packs'], ['runningInstances', 'observedProcesses', 'play'], ['moduleCount', 'declaredModules', 'creator'], ['attention', 'failuresAndUnknown', 'alert']].map(([label, note, iconName], index) => el('div', { class: 'stat' }, [el('div', { class: 'stat-top' }, [t(label), el('span', { class: 'stat-icon', 'aria-hidden': 'true' }, createIcon(iconName))]), el('strong', { class: 'stat-value' }, counts[index]), el('p', { class: 'stat-note' }, t(note))]));
}
function renderStats() { $('#pack-stats')?.replaceChildren(...stats()); $('#overview-stats')?.replaceChildren(...stats()); }
function packCard(instance) {
  const id = idOf(instance), status = instance.status ?? {}, busy = Boolean(operationFor(instance));
  const modules = status.components ?? [];
  const reviewCount = instance.moduleCount ?? state.reviews.get(id)?.review?.pack?.components?.length;
  const [label, tone] = statusLabel(instance);
  const facts = definition([[t('modules'), reviewCount ?? t('unknown')], [t('communication'), isStale(status) ? t('unknown') : modules.length ? `${modules.filter(c => c.communication === 'connected').length} / ${modules.length}` : t('unknown')]], 'pack-facts');
  const detached = instance.detached === true || status.state === 'detached';
  const isRunning = running(instance) || exitUnconfirmed(instance) || preparing(instance);
  const primary = detached ? button(advanced.label('storage'), () => selectInstance(id, 'storage'), 'button button-small button-quiet') : isRunning ? button(t('stop'), () => stopInstance(id), 'button button-small button-quiet', stopBlocked(instance) || status.state === 'stopping') : button(t('start'), () => reviewInstance(id, 'start'), 'button button-small button-primary', busy || isStale(status));
  const statusPill = pill(label, tone);
  if (isRunning && !isStale(status)) statusPill.prepend(el('span', { class: 'status-dot' }));

  const coverArt = renderSquareArt({
    icon: instance.pack?.icon ?? instance.icon,
    fallbackIcon: 'packs',
    tone: 'cyan',
    alt: instance.pack?.title ?? instance.pack?.id ?? id
  });

  return el('article', { class: `pack-card${isRunning ? ' is-running' : ''}` }, [
    el('div', { class: 'pack-card-main' }, [
      el('div', { class: 'pack-card-media' }, [coverArt]),
      el('div', { class: 'pack-card-content' }, [
        el('div', { class: 'pack-card-header-row' }, [
          el('h3', { class: 'pack-card-title' }, instance.pack?.title ?? instance.pack?.id ?? id),
          el('div', { class: 'pack-card-badges' }, [statusPill])
        ]),
        el('div', { class: 'pack-card-sub mono' }, [
          el('span', { class: 'pack-version' }, `v${instance.pack?.version ?? '—'}`),
          el('span', { class: 'subtle-dot' }, '·'),
          el('span', { class: 'pack-id' }, id)
        ]),
        facts
      ])
    ]),
    el('div', { class: 'pack-card-footer' }, [
      button(`${t('viewDetails')} →`, () => selectInstance(id), 'text-link'),
      el('div', { class: 'pack-card-actions' }, [
        button(t('delete'), () => confirmDeleteInstance(instance), 'button button-small button-danger-quiet pack-delete-btn', deletionBlocked(instance)),
        primary
      ])
    ])
  ]);
}
function packProjectCard(group) {
  const option = packVersionSelection.get(group), instance = option?.row;
  const card = instance ? packCard(instance) : el('article', { class: 'pack-card asset-unavailable' }, [
    el('div', { class: 'pack-card-content' }, [el('h3', { class: 'pack-card-title' }, group.title ?? group.id ?? t('unknown'))]),
    el('div', { class: 'pack-card-footer' }, [button(t('viewDetails'), () => {}, 'button button-small', true), button(t('start'), () => {}, 'button button-small button-primary', true)])
  ]);
  card.setAttribute('data-pack-project', group.id ?? group.key);
  const content = card.querySelector('.pack-card-content');
  content.append(renderAssetVersionSelector({ el, say }, group, packVersionSelection, { onChange: () => renderPacks() }));
  // Project grouping never merges lifecycle state: the selected instance still
  // owns every action, while other live instances remain visible in the summary.
  const live = group.options.filter(item => running(item.row) || exitUnconfirmed(item.row)).length;
  content.append(el('p', { class: 'field-help asset-instance-summary' }, say(`${group.options.length} 个独立实例 · ${live} 个运行中或待确认退出`, `${group.options.length} independent instances · ${live} running or awaiting confirmed exit`)));
  return card;
}
function defaultHubCard(hub) {
  const isRunning = hub.state === 'running';
  const busy = state.operations.has('hub:default');
  const observed = state.online && !state.hubsUnavailable && freshObservation(state.hubsObservedAt);
  const statusPill = pill(t(observed ? hub.state ?? 'unknown' : 'unknown'), observed && isRunning ? 'teal' : 'amber');
  if (isRunning && observed) statusPill.prepend(el('span', { class: 'status-dot' }));

  const primary = isRunning
    ? button(t('stopHub'), () => hubOperation('stop'), 'button button-small button-quiet', busy)
    : button(t('startHub'), () => hubOperation('start'), 'button button-small button-primary', busy);

  const actions = [];
  if (isRunning && observed && hub.workbenchUrl) {
    actions.push(localLink(`${t('openWorkbenchTarget')} →`, hub.workbenchUrl, 'text-link', true));
  } else {
    actions.push(el('span', { class: 'subtle small' }, t('defaultHubDescription')));
  }

  const facts = definition([
    [t('communication'), hub.url ? 'WebSocket' : t('hubWaiting')],
    [say('类别', 'Category'), say('系统开发枢纽', 'Dev Hub Socket')]
  ], 'pack-facts');

  const coverArt = renderSquareArt({
    fallbackIcon: 'hubs',
    tone: 'indigo',
    alt: t('defaultHub')
  });

  return el('article', { class: `pack-card pack-card-system${isRunning ? ' is-running' : ''}` }, [
    el('div', { class: 'pack-card-main' }, [
      el('div', { class: 'pack-card-media' }, [coverArt]),
      el('div', { class: 'pack-card-content' }, [
        el('div', { class: 'pack-card-header-row' }, [
          el('h3', { class: 'pack-card-title' }, t('defaultHub')),
          el('div', { class: 'pack-card-badges' }, [statusPill])
        ]),
        el('div', { class: 'pack-card-sub mono' }, [
          el('span', { class: 'pack-version' }, 'Dev Socket'),
          el('span', { class: 'subtle-dot' }, '·'),
          el('span', { class: 'pack-id' }, 'launcher.default')
        ]),
        facts
      ])
    ]),
    el('div', { class: 'pack-card-footer' }, [
      actions[0],
      primary
    ])
  ]);
}
function empty(title, description, action) { return el('div', { class: 'empty-state' }, [el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, createIcon('packs', 'icon-lg')), el('h3', {}, title), description ? el('p', {}, description) : null, action]); }
function renderPacks() {
  const search = $('#search').value.trim().toLocaleLowerCase();
  const projects = groupAssets(state.instances, { mode: 'instance' });
  const matches = projects.filter(group => group.options.some(({ row: i }) => `${idOf(i)} ${i.pack?.id ?? ''} ${i.pack?.title ?? ''} ${i.pack?.version ?? ''}`.toLocaleLowerCase().includes(search)));
  const defaultHub = resolveDefaultHub();
  const matchDefaultHub = !search || 'launcher.default 默认hub 本机开发 调试 socket dev'.toLocaleLowerCase().includes(search);
  $('#nav-count').textContent = String(projects.length);
  $('#collection-count').textContent = say(`${projects.length} 个项目 · ${state.instances.length} 个独立实例`, `${projects.length} projects · ${state.instances.length} independent instances`);
  advanced?.renderAssetTabs?.(state.view);

  const cards = matches.map(packProjectCard);
  if (matchDefaultHub) {const card=defaultHubCard(defaultHub);card.append(button(say('管理本机独立程序','Manage local independent programs'),()=>advanced.managePrograms(),'button button-quiet'));cards.push(card);}

  if (!cards.length) {
    $('#packs-list').replaceChildren(empty(t(search ? 'noSearchResults' : 'emptyTitle'), search ? null : t('emptyDescription'), search ? null : el('div', { class: 'result-actions' }, [button(t('importPack'), openImport, 'button button-primary'), button(say('查找本机整合包', 'Find local packs'), () => { openImport(); void paths.open($('#import-form').elements.directory, 'pack'); }, 'button'), button(say('从软件源获取', 'Fetch from sources'), () => navigate('sources'), 'button button-quiet')])));
  } else {
    $('#packs-list').replaceChildren(...cards);
  }
}
function renderOverview() {
  const target = $('#overview-content');
  if (!target) return;
  target.replaceChildren(el('div', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', {}, t('instances')), el('span', { class: 'subtle' }, date(state.lastRefresh))]), ...(state.instances.length ? state.instances.map(i => el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, i.pack?.title ?? idOf(i)), el('p', {}, idOf(i))]), el('div', {}, [pill(...statusLabel(i)), button(t('viewDetails'), () => selectInstance(idOf(i)), 'button button-small button-quiet')])])) : [el('p', {}, t('emptyDescription'))]), el('p', { class: 'observation-note' }, t('statusMeaning'))]));
}
function currentTitle(id) {
  const instance = state.instances.find(i => idOf(i) === id);
  return instance?.pack?.title ? `${instance.pack.title} · ${id}` : id;
}

function resolveInstanceHubs() {
  const map = new Map();
  for (const instance of state.instances) {
    const id = idOf(instance);
    map.set(id, {
      id,
      managedBy: 'runtime',
      state: instance.status?.state ?? 'stopped',
      url: instance.status?.hub?.url ?? null,
      managementUrl: instance.links?.managementUrl ?? null,
      workbenchUrl: instance.links?.workbenchUrl ?? null,
    });
  }
  for (const hub of state.hubs) {
    if (hub.id === 'default') continue;
    const existing = map.get(hub.id);
    map.set(hub.id, { ...existing, ...hub });
  }
  return [...map.values()];
}

function resolveDefaultHub() {
  const found = state.hubs.find(h => h.id === 'default');
  return found ?? { id: 'default', managedBy: 'launcher', state: 'stopped', url: null, managementUrl: null, workbenchUrl: null };
}

function renderCommunicationWorkbench() {
  const target = $('#workbench-list');
  if (!target) return;
  const observed = state.online && !state.hubsUnavailable && freshObservation(state.hubsObservedAt);
  const instanceHubs = resolveInstanceHubs();
  const defaultHub = resolveDefaultHub();

  // Section 1: 实例独立通信枢纽 (Instance Communication Hubs)
  const instanceSectionHeader = el('div', { class: 'hub-section-header' }, [
    el('div', { class: 'hub-section-title' }, [
      el('div', { class: 'hub-section-icon', 'aria-hidden': 'true' }, createIcon('packs')),
      el('div', {}, [
        el('h2', {}, t('instanceHubsTitle')),
        el('p', { class: 'field-help' }, t('instanceHubsSubtitle'))
      ])
    ]),
    instanceHubs.length ? pill(t('items', { count: instanceHubs.length })) : null
  ]);

  let instanceSectionContent;
  if (!instanceHubs.length) {
    instanceSectionContent = el('div', { class: 'empty-state-card' }, [
      el('h3', {}, t('noInstancesFound')),
      el('p', { class: 'field-help' }, t('noInstancesHubHint')),
      el('div', { class: 'result-actions' }, [
        button(t('importPack'), openImport, 'button button-primary')
      ])
    ]);
  } else {
    instanceSectionContent = instanceHubs.map(hub => {
      const instance = state.instances.find(i => idOf(i) === hub.id);
      const isRunning = hub.state === 'running';
      const busy = Boolean(instance && operationFor(instance));
      const actions = [];
      if (isRunning && observed) {
        if (hub.workbenchUrl) actions.push(localLink(t('openWorkbenchTarget'), hub.workbenchUrl, 'button button-primary', true));
        if (hub.managementUrl) actions.push(localLink(t('openTopologyTarget'), hub.managementUrl, 'button button-quiet', true));
        actions.push(button(t('viewInstance'), () => selectInstance(hub.id), 'button button-quiet'));
      } else {
        actions.push(button(t('startInstanceToConnect'), () => reviewInstance(hub.id, 'start'), 'button button-primary', busy));
        actions.push(button(t('viewInstance'), () => selectInstance(hub.id), 'button button-quiet'));
      }

      return el('article', { class: `link-card${isRunning ? ' is-running' : ''}` }, [
        el('div', { class: 'link-card-body' }, [
          el('div', { class: 'link-card-heading' }, [
            el('div', { class: 'link-card-symbol', 'aria-hidden': 'true' }, createIcon('hubs')),
            el('div', {}, [
              el('h3', {}, currentTitle(hub.id)),
              el('div', { class: 'link-card-id' }, `${hub.id} · WebSocket Bridge`)
            ]),
            pill(t(observed ? hub.state ?? 'unknown' : 'unknown'), observed && isRunning ? 'teal' : 'amber')
          ]),
          el('p', { class: 'link-card-desc' }, t(isRunning ? 'workbenchInstanceActive' : 'workbenchInstanceInactive')),
          el('div', { class: 'link-card-tags' }, [
            el('span', { class: 'link-metadata' }, hub.url ? `${hub.url}` : t('hubWaiting')),
            el('span', { class: 'observation-note' }, `${t('observedAt')}: ${date(state.hubsObservedAt)}`)
          ])
        ]),
        el('div', { class: 'link-card-actions' }, actions.filter(Boolean))
      ]);
    });
  }

  const instanceSection = el('section', { class: 'hub-section' }, [
    instanceSectionHeader,
    ...(Array.isArray(instanceSectionContent) ? instanceSectionContent : [instanceSectionContent])
  ]);

  // Section 2: 本机独立开发枢纽 (Local Development Hub)
  const defaultIsRunning = defaultHub.state === 'running';
  const defaultBusy = state.operations.has('hub:default');
  const defaultActions = [];
  if (defaultIsRunning && observed) {
    if (defaultHub.workbenchUrl) defaultActions.push(localLink(t('openWorkbenchTarget'), defaultHub.workbenchUrl, 'button button-primary', true));
    if (defaultHub.managementUrl) defaultActions.push(localLink(t('openTopologyTarget'), defaultHub.managementUrl, 'button button-quiet', true));
    defaultActions.push(button(t('stopHub'), () => hubOperation('stop'), 'button button-quiet', defaultBusy));
  } else {
    defaultActions.push(button(t('startHub'), () => hubOperation('start'), 'button button-primary', defaultBusy));
  }

  const defaultCard = el('article', { class: `link-card${defaultIsRunning ? ' is-running' : ''}` }, [
    el('div', { class: 'link-card-body' }, [
      el('div', { class: 'link-card-heading' }, [
        el('div', { class: 'link-card-symbol', 'aria-hidden': 'true' }, createIcon('creator')),
        el('div', {}, [
          el('h3', {}, t('defaultHub')),
          el('div', { class: 'link-card-id' }, 'launcher.default · Dev Socket')
        ]),
        pill(t(observed ? defaultHub.state ?? 'unknown' : 'unknown'), observed && defaultIsRunning ? 'teal' : 'amber')
      ]),
      el('p', { class: 'link-card-desc' }, t('defaultHubDescription')),
      el('div', { class: 'link-card-tags' }, [
        el('span', { class: 'link-metadata' }, defaultHub.url ? `${defaultHub.url}` : t('hubWaiting')),
        el('span', { class: 'observation-note' }, `${t('observedAt')}: ${date(state.hubsObservedAt)}`)
      ])
    ]),
    el('div', { class: 'link-card-actions' }, defaultActions.filter(Boolean))
  ]);

  const defaultSectionHeader = el('div', { class: 'hub-section-header' }, [
    el('div', { class: 'hub-section-title' }, [
      el('div', { class: 'hub-section-icon', 'aria-hidden': 'true' }, createIcon('creator')),
      el('div', {}, [
        el('h2', {}, t('devHubTitle')),
        el('p', { class: 'field-help' }, t('devHubSubtitle'))
      ])
    ])
  ]);

  const defaultSection = el('section', { class: 'hub-section' }, [
    defaultSectionHeader,
    defaultCard
  ]);

  target.replaceChildren(instanceSection, defaultSection);
}

function renderHubs() {
  renderCommunicationWorkbench();
}

function runtimeEnvironment(environment) {
  const nodes = [];
  for (const kind of ['node', 'python']) {
    const runtime = environment?.[kind];
    if (!runtime) continue;
    const available = runtime.available !== false && Boolean(runtime.version);
    const isNode = kind === 'node';
    const pkgEntries = runtime.packages && Object.keys(runtime.packages).length ? Object.entries(runtime.packages) : [];
    const pkgList = pkgEntries.length
      ? el('div', { class: 'runtime-pkg-grid' }, pkgEntries.map(([name, ver]) => el('span', { class: 'runtime-pkg-tag' }, `${name} ${display(ver)}`)))
      : null;
    nodes.push(el('div', { class: 'runtime-row' }, [
      el('div', { class: 'runtime-row-main' }, [
        el('div', { class: 'runtime-row-header' }, [
          el('span', { class: `runtime-kind-chip ${isNode ? 'badge-node' : 'badge-python'}` }, isNode ? 'Node.js' : 'Python'),
          el('h3', {}, `${isNode ? 'Node.js' : 'Python'} ${runtime.version ?? ''}`),
          pill(t(available ? 'available' : 'unavailable'), available ? 'teal' : 'red')
        ]),
        el('p', { class: 'runtime-path-text' }, runtime.executable ?? runtime.error ?? '—'),
        pkgList,
        runtime.error ? el('p', { class: 'runtime-error-text' }, runtime.error) : null
      ].filter(Boolean)),
      pill(t(available ? 'available' : 'unavailable'), available ? 'teal' : 'red')
    ]));
  }
  return nodes;
}
function updateEnvHero() {
  const activeProfile = state.isolationSelection?.profile ?? 'trusted-local';
  const profilePill = $('#env-active-profile-pill');
  if (profilePill) {
    const profileNames = {
      'trusted-local': t('trustedLocalProfile'),
      'docker-runtime/v1': t('dockerRuntimeProfile'),
      'docker-node-headless/v1': t('dockerHeadlessProfile'),
      'linux-existing-user/v1': t('linuxUserProfile')
    };
    profilePill.textContent = profileNames[activeProfile] ?? activeProfile;
  }
}
function setEnvironmentTab(tab = state.envTab ?? 'interpreters') {
  state.envTab = tab;
  for (const item of document.querySelectorAll('[data-env-tab]')) {
    const active = item.dataset.envTab === tab;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-selected', String(active));
    item.setAttribute('tabindex', active ? '0' : '-1');
  }
  for (const name of ['interpreters', 'isolation', 'dependencies']) {
    const panel = $(`#env-panel-${name}`);
    if (panel) { panel.hidden = tab !== name; panel.classList.toggle('is-hidden', tab !== name); }
  }
}
function renderEnvironment() {
  const target = $('#environment-results');
  target.replaceChildren(...(state.environment ? runtimeEnvironment(state.environment.environment) : [el('p', { class: 'field-help' }, t('detectFirst'))]));
  if (state.environment?.guidance?.length) target.append(guidance(state.environment.guidance));
  $('#diagnostic-info').replaceChildren(...definition([[t('instancesRoot'), state.session?.root], [t('launcherVersion'), state.session?.softwareVersion ?? state.session?.version], [t('platform'), state.environment?.environment?.platform ?? (state.session?.platform ?? '—')], [t('architecture'), state.environment?.environment?.arch ?? (state.session?.arch ?? '—')]]).children);
  updateEnvHero();
  setEnvironmentTab(state.envTab ?? 'interpreters');
}

function permissions(declared) {
  if (!declared || !Object.keys(declared).length) return [pill(t('noPermissions'))];
  const labels = { filesystem: 'fileAccess', network: 'networkAccess', processes: 'subprocesses' };
  return Object.entries(declared).map(([key, value]) => {
    const isFilesystem = key === 'filesystem';
    const isNetwork = key === 'network';
    const iconName = isFilesystem ? 'folder' : isNetwork ? 'link' : 'task';
    const valStr = Array.isArray(value) ? value.join(', ') : display(value);
    return el('div', { class: 'perm-chip-card' }, [
      el('div', { class: 'perm-chip-header' }, [
        el('span', { class: 'perm-chip-icon', 'aria-hidden': 'true' }, createIcon(iconName)),
        el('span', { class: 'perm-chip-label' }, t(labels[key] ?? key))
      ]),
      el('span', { class: 'perm-chip-value mono' }, valStr)
    ]);
  });
}
function moduleView(module, review, full = true) {
  const manifest = module.manifest ?? module, source = module.source ?? '—';
  const sourceLocation = `${review.directory ?? ''}${review.directory ? ' / ' : ''}${source}`;
  if (!full) {
    return el('div', { class: 'review-module' }, [
      el('h4', {}, `${manifest.id ?? '—'} · ${manifest.version ?? '—'}`),
      el('p', {}, `${t('source')}: ${sourceLocation}`),
      el('div', { class: 'module-permissions' }, permissions(manifest.permissions)),
      el('p', { class: 'field-help' }, `${t('sourceFiles', { count: Object.keys(module.files ?? {}).length })} · ${t('declaredNotEnforced')}`)
    ]);
  }

  const runtimeKind = manifest.runtime?.kind ?? 'node';
  const isPython = runtimeKind === 'python';
  const fileCount = Object.keys(module.files ?? {}).length;

  const header = el('div', { class: 'module-card-header' }, [
    el('div', { class: 'module-card-title-group' }, [
      el('span', { class: `runtime-kind-chip ${isPython ? 'badge-python' : 'badge-node'}` }, isPython ? 'Python' : 'Node.js'),
      el('h3', {}, `${manifest.id ?? '—'} · v${manifest.version ?? '—'}`)
    ]),
    pill(`${runtimeKind} · ${manifest.runtime?.entry ?? '—'}`)
  ]);

  const sourceMeta = el('div', { class: 'module-card-meta' }, [
    el('div', { class: 'meta-item' }, [
      el('span', { class: 'subtle' }, `${t('source')}: `),
      el('span', { class: 'mono subtle' }, sourceLocation)
    ]),
    el('div', { class: 'meta-item' }, [
      el('span', { class: 'pill pill-subtle' }, `${t('sourceFiles', { count: fileCount })}`)
    ])
  ]);

  const permsGrid = el('div', { class: 'module-permissions-grid' }, permissions(manifest.permissions));

  const manifestDetails = el('details', { class: 'json-details module-manifest-details' }, [
    el('summary', {}, t('fullManifest')),
    el('pre', {}, JSON.stringify(manifest, null, 2))
  ]);

  return el('article', { class: 'panel module-card' }, [
    header,
    sourceMeta,
    permsGrid,
    manifestDetails,
    el('p', { class: 'field-help module-card-footer-note' }, t('declaredNotEnforced'))
  ]);
}
function reviewView(data, mode = 'execution') {
  const review = data.review;
  const nodes = [el('div', { class: 'review-summary' }, [el('div', {}, [el('h3', {}, review.pack?.title ?? review.pack?.id ?? '—'), el('p', {}, `${review.pack?.id ?? '—'} · v${review.pack?.version ?? '—'}`)]), pill(data.isolation ? data.isolation.profile : t('noSandbox'), 'amber')]), el('div', { class: `notice ${mode === 'execution' ? 'notice-warning' : ''}` }, mode === 'execution' && data.isolation ? (state.language === 'zh' ? '请核对执行模式与固定限制。Docker 模式隔离文件、网络与进程，并可开放审阅过的界面通道；已有 Linux 用户模式只分离账号，保留该账号的普通权限。协议内的信息与代码仍需信任。' : 'Inspect the execution profile and fixed restrictions. Docker isolates files, network, and processes with an optional reviewed UI tunnel. Existing Linux user mode separates accounts and retains their ordinary permissions. Protocol data and code still require trust.') : t(mode === 'execution' ? 'codeExecutionNotice' : 'importNoExecution')), el('div', { class: 'review-section' }, [el('h3', {}, t('source')), el('p', { class: 'review-digest' }, review.directory ?? '—')]), el('div', { class: 'review-section' }, [el('h3', {}, t('modulesPermissions')), el('div', { class: 'review-modules' }, (review.modules ?? []).map(module => moduleView(module, review, false)))]), el('div', { class: 'review-section' }, [el('h3', {}, t('executionOrder')), el('div', { class: 'review-order' }, (review.order ?? []).flatMap((id, i) => [i ? '→' : null, el('span', {}, id)]))]), el('div', { class: 'review-section' }, [el('h3', {}, t('environmentReview')), ...runtimeEnvironment(review.environment)])];
  nodes.push(el('div', { class: 'review-section', 'data-review-hub-compatibility': '' }, [
    el('h3', {}, say('Hub 与运行接口', 'Hub and Runtime API')),
    definition([
      [say('当前 Hub 发行版本', 'Installed Hub release'), review.hubVersion ?? review.hubCompatibility?.installedHubVersion ?? '—'],
      [say('生成锁时的发行版本（记录）', 'Lock generation release (metadata)'), review.lock?.hubVersion ?? '—'],
      [say('锁格式', 'Lock format'), review.lock?.format ?? '—'],
      [say('要求的线协议 / 当前线协议', 'Required / current wire protocol'), `${review.lock?.hubCompatibility?.wireVersion ?? '—'} / ${review.hubCompatibility?.actual?.wireVersion ?? '—'}`],
      [say('要求的 Runtime 接口 / 当前接口', 'Required / current Runtime API'), `${review.lock?.hubCompatibility?.runtimeApi ?? '—'} / ${review.hubCompatibility?.actual?.runtimeApi ?? '—'}`],
    ]),
    el('p', { class: 'field-help' }, say('兼容性由通讯和运行接口契约判断。生成锁时的发行版本仅作记录；执行授权仍绑定当前安装环境的审阅。', 'Compatibility is checked against communication and Runtime API contracts. The lock generation release is metadata; execution approval remains bound to a review of the current installed environment.')),
  ]));
  if (data.isolation) nodes.push(el('details', { class: 'json-details', open: true }, [el('summary', {}, data.isolation.profile), el('pre', {}, JSON.stringify(data.isolation, null, 2))]));
  for(const module of review.modules??[]) if(module.deployment?.dependencies) nodes.push(el('div',{class:'notice'},[el('h3',{},say('依赖准备','Dependency preparation')),el('p',{},say('启动时将在此实例的私有目录安装锁定的官方 npm 依赖；Electron 配方下载官方桌面运行时，不执行模块自定义安装命令。','Starting prepares locked official npm dependencies in this instance’s private directory. The Electron recipe downloads its official desktop runtime; module installation commands are not run.')),el('pre',{},JSON.stringify(module.deployment.dependencies,null,2))]));
  if (data.sourceReceipt?.publisherEvidence) nodes.push(advanced.publisherReport(data.sourceReceipt.publisherEvidence));
  if (data.sourceReceipt) nodes.push(el('details', { class: 'json-details', open: true }, [el('summary', {}, t('sourceReceipt')), el('p', {}, t('integrityNotIdentity')), el('pre', {}, JSON.stringify(data.sourceReceipt, null, 2))]));
  if (data.permissionDiff?.length) nodes.push(el('div', { class: 'notice notice-warning' }, [el('h3', {}, t('permissionChanges')), el('p', {}, t('changesRequireReview')), ...data.permissionDiff.map(change => el('div', { class: 'review-module' }, [el('h4', {}, change.module ?? '—'), ...Object.keys({ ...change.before, ...change.after }).filter(key => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key])).map(key => el('p', {}, `${key}: ${display(change.before?.[key])} → ${display(change.after?.[key])}`))]))]));
  nodes.push(el('p', { class: 'field-help' }, `${t('reviewValidUntil')}: ${date(data.expiresAt)}`), el('details', { class: 'json-details' }, [el('summary', {}, t('reviewFingerprint')), el('p', { class: 'review-digest' }, review.digest)]));
  return nodes;
}

function renderDetailHeading(instance) {
  const id = idOf(instance), status = instance.status ?? {}, busy = Boolean(operationFor(instance));
  const isRunning = running(instance);
  const [label, tone] = statusLabel(instance);
  const statusPill = pill(label, tone);
  if (isRunning && !isStale(status)) statusPill.prepend(el('span', { class: 'status-dot' }));

  const heading = el('div', { class: 'detail-hero' }, [
    el('div', { class: 'detail-hero-left' }, [
      el('div', { class: `detail-hero-symbol${isRunning ? ' is-running' : ''}`, 'aria-hidden': 'true' }, createIcon('packs', 'icon-xl')),
      el('div', { class: 'detail-hero-body' }, [
        el('div', { class: 'detail-hero-title-row' }, [
          el('h1', {}, instance.pack?.title ?? instance.pack?.id ?? id),
          statusPill
        ]),
        el('div', { class: 'detail-hero-meta' }, [
          el('span', { class: 'hero-meta-id mono' }, id),
          el('span', { class: 'hero-meta-pill' }, `v${instance.pack?.version ?? '—'}`),
          el('span', { class: 'hero-meta-tag' }, declaredModuleCount(instance) === null
            ? `${t('moduleCount')}: ${t('unknown')}` : `${declaredModuleCount(instance)} ${say('个模块', 'modules')}`),
          status.executionProfile
            ? el('span', { class: 'hero-meta-profile' }, status.executionProfile)
            : null
        ].filter(Boolean))
      ])
    ]),
    el('div', { class: 'detail-hero-right' }, [
      el('div', { class: 'hero-obs-tag subtle mono' }, `${say('观测于', 'Observed')}: ${date(state.lastRefresh)}`)
    ])
  ]);
  $('#detail-heading').replaceChildren(heading);

  const primaryActions = [];
  if (running(instance) || exitUnconfirmed(instance) || preparing(instance)) {
    const stopBtn = button(t('stop'), () => stopInstance(id), 'button button-danger', stopBlocked(instance) || status.state === 'stopping');
    stopBtn.prepend(createIcon('stop', 'button-icon'));
    primaryActions.push(stopBtn);
    if (status.state === 'running' && !isStale(status)) {
      const restartBtn = button(t('restart'), () => reviewInstance(id, 'restart'), 'button', busy);
      restartBtn.prepend(createIcon('restart', 'button-icon'));
      primaryActions.push(restartBtn);
    }
  } else if (!instance.detached && status.state !== 'detached' && !instance.deletionPending) {
    const startBtn = button(t('start'), () => reviewInstance(id, 'start'), 'button button-primary', busy || isStale(status));
    startBtn.prepend(createIcon('play', 'button-icon'));
    primaryActions.push(startBtn);
  }

  if (status.state === 'running' && !isStale(status)) {
    const entry = localLink(t('openApp'), instance.links?.entryUrl, 'button button-primary', true);
    if (entry) {
      entry.prepend(createIcon('arrowRight', 'button-icon'));
      primaryActions.push(entry);
    }
    const workbench = localLink(t('openWorkbenchTarget'), instance.links?.workbenchUrl, 'button button-quiet', true);
    if (workbench) {
      workbench.prepend(createIcon('workbench', 'button-icon'));
      primaryActions.push(workbench);
    }
  }

  const topology = !isStale(status) && localLink(t('topology'), instance.links?.managementUrl);
  if (topology) {
    topology.prepend(createIcon('hubs', 'button-icon'));
    primaryActions.push(topology);
  }

  const toolActions = [];
  const reviewBtn = button(t('review'), () => reviewInstance(id, 'review'), 'button button-quiet', busy || instance.deletionPending);
  reviewBtn.prepend(createIcon('inspect', 'button-icon'));
  toolActions.push(reviewBtn);

  const exportBtn = button(t('exportPackage'), () => { $('#export-error').hidden = true; $('#export-dialog').showModal(); }, 'button button-quiet', busy || instance.detached || status.state === 'detached' || instance.deletionPending);
  exportBtn.prepend(createIcon('file', 'button-icon'));
  toolActions.push(exportBtn);

  const createBtn = button(t('createFromPack'), () => advanced.openCreator(instance.packageDirectory), 'button button-quiet', busy || instance.deletionPending);
  createBtn.prepend(createIcon('creator', 'button-icon'));
  toolActions.push(createBtn);

  const deleteBtn = button(t('delete'), () => confirmDeleteInstance(instance), 'button button-danger-quiet', deletionBlocked(instance));
  deleteBtn.prepend(createIcon('trash', 'button-icon'));
  toolActions.push(deleteBtn);

  $('#detail-actions').replaceChildren(
    el('div', { class: 'detail-actions-group detail-actions-primary' }, primaryActions),
    el('div', { class: 'detail-actions-group detail-actions-secondary' }, toolActions)
  );

  const notices = [];
  if (instance.deletionPending) notices.push(el('div', { class: 'notice notice-error' }, say(`删除尚未完成。剩余文件及删除记录保留在 ${instance.retainedDirectory}。核对后可再次明确确认删除。`, `Deletion is incomplete. Remaining files and the deletion journal are retained at ${instance.retainedDirectory}. Inspect them before explicitly retrying deletion.`)));
  if (isStale(status)) notices.push(el('div', { class: 'notice notice-warning' }, `${t('observationUnknown')} ${t('observedAt')}: ${date(state.lastRefresh)}. ${t('staleMeaning')}`));
  if ((status.cleanupIncomplete || status.state === 'failed') && exitUnconfirmed(instance)) notices.push(el('div', { class: 'notice notice-error' }, t('cleanupMeaning')));
  if (status.failure) notices.push(el('div', { class: 'notice notice-error' }, `${t('startupFailure')}: ${status.failure.message ?? display(status.failure)}`));
  if (operationFor(instance)) notices.push(el('div', { class: 'notice' }, `${t('processing')} ${t(operationFor(instance).kind)}`));
  $('#detail-notice').replaceChildren(...notices);
}

function renderStatus(instance) {
  const status = instance.status ?? {}, components = status.components ?? [];
  const isRunning = status.state === 'running';
  const observed = !isStale(status) && freshObservation(state.lastRefresh);
  const hubUrl = status.hub?.url ?? instance.links?.hubUrl ?? null;
  const runningComps = components.filter(c => c.process === 'running').length;
  const readyComps = components.filter(c => c.readiness === 'ready').length;
  const commComps = components.filter(c => c.communication === 'connected').length;

  const metricCards = el('div', { class: 'detail-metric-strip' }, [
    el('div', { class: 'detail-metric-card' }, [
      el('div', { class: 'metric-header' }, [
        el('span', { class: 'metric-label' }, say('运行状态', 'Runtime State')),
        el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, createIcon(isRunning ? 'play' : 'stop'))
      ]),
      el('div', { class: 'metric-value-row' }, [
        pill(...statusLabel(instance))
      ]),
      el('p', { class: 'metric-sub mono' }, status.runId ? `Run: ${status.runId.slice(0, 18)}` : say('未在运行', 'Not running'))
    ]),
    el('div', { class: 'detail-metric-card' }, [
      el('div', { class: 'metric-header' }, [
        el('span', { class: 'metric-label' }, say('活跃进程 / 模块', 'Active Modules')),
        el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, createIcon('task'))
      ]),
      el('div', { class: 'metric-value-row' }, [
        el('strong', { class: 'metric-value' }, `${observed ? runningComps : t('unknown')} / ${declaredModuleCount(instance) ?? t('unknown')}`),
        observed ? pill(runningComps === components.length && components.length > 0 ? say('全部在线', 'All Online') : runningComps > 0 ? say('部分在线', 'Partial') : say('已停止', 'Stopped'), runningComps === components.length && components.length > 0 ? 'teal' : runningComps > 0 ? 'amber' : '') : pill(t('observationUnknown'), 'amber')
      ]),
      el('p', { class: 'metric-sub' }, `${components.filter(c => c.pid).length} ${say('个已记录的进程 PID', 'recorded process PIDs')}`)
    ]),
    el('div', { class: 'detail-metric-card' }, [
      el('div', { class: 'metric-header' }, [
        el('span', { class: 'metric-label' }, say('通信总线与就绪', 'Bus & Ready State')),
        el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, createIcon('hubs'))
      ]),
      el('div', { class: 'metric-value-row' }, [
        el('strong', { class: 'metric-value' }, `${observed ? commComps : t('unknown')} / ${components.length}`),
        observed ? pill(commComps > 0 ? say('总线连通', 'Bus Online') : say('未连接', 'Offline'), commComps > 0 ? 'teal' : '') : pill(t('observationUnknown'), 'amber')
      ]),
      el('p', { class: 'metric-sub' }, `${readyComps} ${say('个模块自报就绪', 'modules ready')}`)
    ]),
    el('div', { class: 'detail-metric-card' }, [
      el('div', { class: 'metric-header' }, [
        el('span', { class: 'metric-label' }, say('隔离执行等级', 'Isolation Profile')),
        el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, createIcon('shield'))
      ]),
      el('div', { class: 'metric-value-row' }, [
        pill(status.executionProfile ?? (status.runId ? t('unknown') : say('尚未运行', 'Not run')), status.executionProfile ? 'teal' : '')
      ]),
      el('p', { class: 'metric-sub' }, (status.executionProfile ?? '').startsWith('docker-') ? say('Docker 容器隔离', 'Docker isolation')
        : status.executionProfile === 'trusted-local' ? say('可信本机 · 无 OS 沙箱', 'Trusted local · No OS sandbox')
        : status.executionProfile === 'linux-existing-user/v1' ? say('已有用户身份分离 · 无 OS 沙箱', 'Existing-user identity separation · No OS sandbox')
        : say('暂无本次运行的保护记录。', 'No protection record for this run.'))
    ])
  ]);

  const observationNotice = el('div', { class: `notice ${isStale(status) ? 'notice-warning' : 'notice-info'} observation-banner` }, [
    el('div', { class: 'observation-banner-main' }, [
      el('span', { class: 'observation-banner-title' }, isStale(status) ? t('observationUnknown') : t('currentObservation')),
      el('span', { class: 'subtle mono' }, `${t('runId')}: ${status.runId ?? '—'} · ${t('observedAt')}: ${date(state.lastRefresh)}`)
    ]),
    isStale(status) ? button(t('refresh'), () => refresh({ explicit: true }), 'button button-small button-primary') : null
  ]);

  const headers = ['modules', 'process', 'communication', 'readiness', 'health', 'businessResult'];
  const table = el('table', { class: 'component-matrix-table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col' }, t('modules')),
      el('th', { scope: 'col' }, t('process')),
      el('th', { scope: 'col' }, t('communication')),
      el('th', { scope: 'col' }, t('readiness')),
      el('th', { scope: 'col' }, t('health')),
      el('th', { scope: 'col', class: 'th-actions' }, say('日志直达', 'Logs'))
    ])),
    el('tbody', {}, components.map(c => el('tr', { class: 'component-row' }, [
      el('td', { class: 'td-component-info' }, [
        el('div', { class: 'component-name-wrap' }, [
          el('span', { class: 'component-id-badge mono' }, c.id),
          componentRuntimeKind(instance, c) === 'python' ? el('span', { class: 'runtime-kind-chip badge-python' }, 'Python')
            : componentRuntimeKind(instance, c) === 'node' ? el('span', { class: 'runtime-kind-chip badge-node' }, 'JS')
            : el('span', { class: 'runtime-kind-chip' }, t('unknown'))
        ]),
        el('div', { class: 'component-module-name subtle' }, c.module)
      ]),
      el('td', {}, [
        processBadge(isStale(status) ? null : c.process),
        c.pid ? el('div', { class: 'component-pid-pill mono subtle' }, `PID ${c.pid}`) : null
      ]),
      el('td', {}, commBadge(isStale(status) ? null : c.communication)),
      el('td', {}, readinessBadge(isStale(status) || c.process !== 'running' ? null : c.readiness)),
      el('td', {}, isStale(status) || c.process !== 'running' ? pill(t('healthUnknown')) : healthBadge(c.health)),
      el('td', { class: 'td-actions' }, [
        button(say('日志', 'Logs'), () => {
          state.logSelection = c.id;
          changeTab('logs');
        }, 'button button-small button-quiet')
      ])
    ])))
  ]);

  const componentsPanel = el('div', { class: 'panel component-matrix-panel' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', { class: 'panel-heading-title' }, [
        el('div', { class: 'panel-icon', 'aria-hidden': 'true' }, createIcon('task')),
        el('div', {}, [
          el('h2', {}, say('模块进程与健康诊断', 'Module Processes & Health')),
          el('p', { class: 'panel-subhead' }, say('各模块进程运行状态、总线通信与健康探针反馈。', 'Per-module runtime state, bus connectivity and health probes.'))
        ])
      ]),
      components.length ? pill(`${components.length} ${say('个模块', 'modules')}`) : null
    ]),
    components.length ? el('div', { class: 'status-table-wrap' }, table) : el('div', { class: 'empty-state-card' }, [
      el('p', {}, isStale(status) ? t('unknown') : t('notStarted'))
    ]),
    el('p', { class: 'observation-note' }, t('statusMeaning'))
  ]);

  const topologyPanel = el('div', { class: 'panel topology-panel' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', { class: 'panel-heading-title' }, [
        el('div', { class: 'panel-icon', 'aria-hidden': 'true' }, createIcon('hubs')),
        el('div', {}, [
          el('h2', {}, t('bridgeOwnership')),
          el('p', { class: 'panel-subhead' }, say('网桥身份归属与通信路由映射关系。', 'Bridge identity ownership and routing mapping.'))
        ])
      ]),
      button(t('refreshTopology'), () => loadTopology(idOf(instance), true), 'button button-small button-quiet')
    ]),
    el('div', { id: 'bridge-mapping' }, topologyView(instance)),
    el('p', { class: 'observation-note' }, t('mappingNotice'))
  ]);

  return [metricCards, observationNotice, componentsPanel, topologyPanel];
}



function topologyView(instance) {
  const topology = state.topology?.instanceId === idOf(instance) ? state.topology : null;
  if (!topology || topology.runId !== instance.status?.runId) return [el('p', { class: 'field-help' }, t('topologyUnavailable'))];
  const observed = !isStale(instance.status) && !state.topologyUnavailable && topology.observation === 'live' && freshObservation(topology.observedAt);
  const note = el('div', { class: 'observation-banner subtle-banner' }, [
    el('span', {}, `${observed ? t('currentObservation') : t('observationUnknown')}`),
    el('span', { class: 'mono' }, `${t('observedAt')}: ${date(topology.observedAt)}`)
  ]);
  if (!topology.bridges?.length) return [note, el('p', { class: 'field-help' }, t(observed ? 'noBridges' : 'topologyUnavailable'))];
  return [
    note,
    el('div', { class: 'bridge-cards-list' }, topology.bridges.map(bridge => {
      const isManaged = bridge.ownership === 'managed';
      const actions = [];
      if (isManaged) {
        actions.push(button(t('logs'), () => { state.logSelection = bridge.componentId; changeTab('logs'); }, 'button button-small button-quiet'));
      }
      if (observed && bridge.managementUrl) {
        actions.push(localLink(t('topology'), bridge.managementUrl, 'button button-small button-quiet', true));
      }
      return el('div', { class: `runtime-row bridge-row-card${isManaged ? ' is-managed' : ''}` }, [
        el('div', { class: 'bridge-info-main' }, [
          el('div', { class: 'bridge-title-row' }, [
            el('h3', { class: 'mono' }, bridge.bridgeId ?? bridge.declaredId ?? '—'),
            pill(t(!observed ? 'mappingUnknown' : isManaged ? 'managedBridge' : 'externalUnknown'), observed && isManaged ? 'teal' : 'amber')
          ]),
          el('div', { class: 'bridge-meta-row subtle' }, [
            el('span', {}, `${t('principal')}: ${bridge.principal ?? '—'}`),
            el('span', {}, `${t('bridgeSession')}: ${bridge.session ?? '—'}`)
          ]),
          isManaged ? el('div', { class: 'bridge-comp-row mono small' }, [
            el('span', { class: 'pill pill-subtle' }, bridge.componentId ?? '—'),
            el('span', { class: 'subtle' }, bridge.moduleId ?? '—'),
            bridge.pid ? el('span', { class: 'subtle' }, `PID ${bridge.pid}`) : null
          ].filter(Boolean)) : null
        ]),
        el('div', { class: 'bridge-actions-col' }, actions)
      ]);
    }))
  ];
}

function renderModules(instance) {
  const review = state.reviews.get(idOf(instance))?.review;
  if (!review) return [empty(t('noModuleReview'), t('probeNotice'), button(t('review'), () => reviewInstance(idOf(instance), 'review'), 'button button-primary'))];

  const hero = el('div', { class: 'module-security-hero' }, [
    el('div', { class: 'module-security-icon', 'aria-hidden': 'true' }, createIcon('shield')),
    el('div', { class: 'module-security-content' }, [
      el('div', { class: 'eyebrow' }, say('安全基线与隔离边界', 'SECURITY BASELINE & BOUNDARY')),
      el('h2', {}, say('模块声明与权限审阅', 'Module Declarations & Permission Review')),
      el('p', {}, t('sandboxNotice')),
      el('div', { class: 'module-security-badges' }, [
        pill(instance.status?.executionProfile ?? (instance.status?.runId ? t('unknown') : say('尚未运行', 'Not run')))
      ])
    ])
  ]);

  let orderRow = null;
  if (review.order?.length) {
    orderRow = el('div', { class: 'panel module-order-panel' }, [
      el('h3', {}, t('executionOrder')),
      el('div', { class: 'review-order' }, review.order.flatMap((id, i) => [
        i ? el('span', { class: 'order-arrow', 'aria-hidden': 'true' }, '→') : null,
        el('span', { class: 'order-step-chip mono' }, id)
      ]).filter(Boolean))
    ]);
  }

  const moduleCards = (review.modules ?? []).map(module => moduleView(module, review, true));
  return [hero, orderRow, ...moduleCards, el('p', { class: 'observation-note' }, t('sourceSafeText'))].filter(Boolean);
}

function renderLogs(instance) {
  const matching = state.logs?.instanceId === idOf(instance) && state.logs?.runId === instance.status?.runId;
  const logs = matching ? state.logs.logs ?? {} : {};
  const selection = state.logSelection;
  const select = el('select', { id: 'log-component', 'aria-label': t('modules'), class: 'log-select' }, [
    el('option', { value: 'all' }, t('allComponents')),
    ...Object.keys(logs).map(id => el('option', { value: id }, id))
  ]);
  select.value = Object.hasOwn(logs, selection) || selection === 'all' ? selection : 'all';
  select.addEventListener('change', () => { state.logSelection = select.value; renderDetail(true); });

  let fullLogText = '';
  const panels = [];
  for (const [id, values] of Object.entries(logs)) {
    if (select.value !== 'all' && select.value !== id) continue;
    for (const stream of ['stdout', 'stderr']) {
      if (values[stream]) {
        fullLogText += `[${id} / ${stream}]\n${values[stream]}\n\n`;
        const isStderr = stream === 'stderr';
        panels.push(el('div', { class: `terminal-stream-block${isStderr ? ' is-stderr' : ''}` }, [
          el('div', { class: 'terminal-stream-header' }, [
            el('span', { class: `terminal-stream-badge ${isStderr ? 'badge-stderr' : 'badge-stdout'}` }, stream.toUpperCase()),
            el('span', { class: 'terminal-stream-comp mono' }, id),
            values.truncated ? pill(t('truncated'), 'amber') : null
          ].filter(Boolean)),
          el('pre', { class: 'terminal-stream-pre' }, values[stream])
        ]));
      }
    }
  }

  const copyBtn = button(say('复制当前日志', 'Copy Logs'), async () => {
    if (!fullLogText.trim()) {
      toast(t('noLogs'));
      return;
    }
    try {
      await navigator.clipboard.writeText(fullLogText);
      toast(t('copied'));
    } catch {
      toast(t('copyUnavailable'));
    }
  }, 'button button-small button-quiet');
  copyBtn.prepend(createIcon('copy', 'button-icon'));

  const refreshBtn = button(t('refreshLogs'), () => loadLogs(idOf(instance), true), 'button button-small button-quiet');
  refreshBtn.prepend(createIcon('refresh', 'button-icon'));

  const toolbar = el('div', { class: 'terminal-toolbar' }, [
    el('div', { class: 'terminal-toolbar-left' }, [
      el('label', { class: 'log-select-label' }, [
        el('span', { class: 'log-select-icon', 'aria-hidden': 'true' }, createIcon('task')),
        select
      ]),
      matching ? el('span', { class: 'terminal-run-chip mono' }, `Run: ${state.logs?.runId?.slice(0, 16) ?? '—'}`) : null
    ].filter(Boolean)),
    el('div', { class: 'terminal-toolbar-right' }, [
      copyBtn,
      refreshBtn
    ])
  ]);

  const windowBar = el('div', { class: 'terminal-window-header' }, [
    el('div', { class: 'terminal-dots' }, [
      el('span', { class: 'dot dot-red' }),
      el('span', { class: 'dot dot-yellow' }),
      el('span', { class: 'dot dot-green' })
    ]),
    el('div', { class: 'terminal-window-title mono' }, `logs://${idOf(instance)}/${select.value} · ${matching ? date(state.logs.observedAt) : 'inactive'}`)
  ]);

  const terminalContent = panels.length
    ? el('div', { class: 'terminal-body' }, panels)
    : el('div', { class: 'terminal-empty' }, [
        el('div', { class: 'terminal-empty-prompt mono' }, '$ world-hub instance logs --stream'),
        el('p', { class: 'terminal-empty-text subtle' }, t('noLogs'))
      ]);

  const consoleWindow = el('div', { class: 'terminal-window' }, [
    windowBar,
    terminalContent
  ]);

  const privacyNotice = el('div', { class: 'notice notice-info' }, t('privacyNotice'));

  return [toolbar, privacyNotice, consoleWindow];
}

function renderDetails(instance) {
  const status = instance.status ?? {};
  const id = idOf(instance);
  const hubUrl = status.links?.hub ?? status.hub?.url ?? instance.hubUrl;
  const isRunning = running(instance);
  const observed = observationLive() && status.observedAt;

  const cardIdentity = el('div', { class: 'panel spec-card' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', { class: 'panel-heading-title' }, [
        el('div', { class: 'panel-icon', 'aria-hidden': 'true' }, createIcon('file')),
        el('div', {}, [
          el('h2', {}, say('实例标识与本地路径', 'Instance Identity & Paths')),
          el('p', { class: 'panel-subhead' }, say('本实例在磁盘上的独立目录结构与版本标识。', 'Independent disk directory structure and version metadata.'))
        ])
      ])
    ]),
    definition([
      [t('instanceId'), el('span', { class: 'mono bold' }, id)],
      [say('整合包 ID', 'Pack ID'), el('span', { class: 'mono' }, instance.pack?.id ?? id)],
      [say('整合包标题', 'Pack Title'), instance.pack?.title ?? '—'],
      [say('版本号', 'Version'), `v${instance.pack?.version ?? '—'}`],
      [t('importedAt'), date(instance.importedAt)],
      [t('instanceDirectory'), el('span', { class: 'mono' }, instance.directory ?? '—')]
    ])
  ]);

  const cardExecution = el('div', { class: 'panel spec-card' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', { class: 'panel-heading-title' }, [
        el('div', { class: 'panel-icon', 'aria-hidden': 'true' }, createIcon('shield')),
        el('div', {}, [
          el('h2', {}, say('执行模式与解释器绑定', 'Execution Profile & Interpreters')),
          el('p', { class: 'panel-subhead' }, say('运行环境隔离模式、保护参数以及解释器探针。', 'Isolation profile, protection parameters and interpreter probes.'))
        ])
      ])
    ]),
    definition([
      [say('该次运行的执行模式', 'Execution profile for this run'), status.executionProfile ?? t('unknown')],
      [say('该次运行的保护参数', 'Protection parameters for this run'), status.isolation ?? t('unknown')],
      [t('boundEnvironment'), instance.environment ? el('span', { class: 'mono' }, typeof instance.environment === 'object' ? JSON.stringify(instance.environment) : String(instance.environment)) : t('unknown')]
    ])
  ]);

  const cardLifecycle = el('div', { class: 'panel spec-card' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', { class: 'panel-heading-title' }, [
        el('div', { class: 'panel-icon', 'aria-hidden': 'true' }, createIcon('clock')),
        el('div', {}, [
          el('h2', {}, say('运行生命周期与观察时间戳', 'Runtime Lifecycle & Observation')),
          el('p', { class: 'panel-subhead' }, say('进程生命周期标记与最近一次通信检测记录。', 'Lifecycle markers and the latest communication observation.'))
        ])
      ])
    ]),
    definition([
      [t('runId'), el('span', { class: 'mono' }, status.runId ?? t('notStarted'))],
      [t('observedAt'), date(status.components?.[0]?.communicationObservedAt ?? status.observedAt)],
      [t('stoppedAt'), date(status.stoppedAt)]
    ])
  ]);

  const hubVal = hubUrl
    ? el('div', { class: 'comm-val-inline' }, [
        el('code', { class: 'mono comm-endpoint-code' }, hubUrl),
        button(say('复制', 'Copy'), async () => {
          try {
            await navigator.clipboard.writeText(hubUrl);
            toast(t('copied'));
          } catch {
            toast(t('copyUnavailable'));
          }
        }, 'button button-small button-quiet')
      ])
    : el('span', { class: 'subtle mono' }, t('hubWaiting'));

  const commActions = [];
  if (instance.links?.workbenchUrl && isRunning) {
    const wbLink = localLink(t('openWorkbenchTarget'), instance.links.workbenchUrl, 'button button-small button-primary', true);
    if (wbLink) {
      wbLink.prepend(createIcon('workbench', 'button-icon'));
      commActions.push(wbLink);
    }
  }
  if (instance.links?.managementUrl && isRunning) {
    const topoLink = localLink(t('topology'), instance.links.managementUrl, 'button button-small button-quiet', true);
    if (topoLink) {
      topoLink.prepend(createIcon('hubs', 'button-icon'));
      commActions.push(topoLink);
    }
  }

  const cardComm = el('div', { class: 'panel spec-card' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', { class: 'panel-heading-title' }, [
        el('div', { class: 'panel-icon', 'aria-hidden': 'true' }, createIcon('workbench')),
        el('div', {}, [
          el('h2', {}, say('通信端点与调试工作台', 'Communication Endpoints & Workbench')),
          el('p', { class: 'panel-subhead' }, say('实例独立的 WebSocket 通信总线与工作台调试通道。', 'Instance-isolated WebSocket bus and workbench debugging channel.'))
        ])
      ]),
      pill(t(observed && isRunning ? 'running' : isRunning ? 'running' : 'stopped'), isRunning ? 'teal' : '')
    ]),
    definition([
      [say('WebSocket 调试端点', 'WebSocket Endpoint'), hubVal],
      [say('通信工作台地址', 'Workbench URL'), instance.links?.workbenchUrl ? localLink(instance.links.workbenchUrl, instance.links.workbenchUrl, 'text-link mono', true) : el('span', { class: 'subtle' }, t('unknown'))],
      [say('拓扑管理端点', 'Topology URL'), instance.links?.managementUrl ? localLink(instance.links.managementUrl, instance.links.managementUrl, 'text-link mono', true) : el('span', { class: 'subtle' }, t('unknown'))],
      [say('观察时间', 'Observed At'), el('span', { class: 'mono' }, date(state.hubsObservedAt ?? status.observedAt ?? state.lastRefresh))]
    ]),
    commActions.length ? el('div', { class: 'spec-card-actions' }, commActions) : null
  ].filter(Boolean));

  const advisory = el('div', { class: 'notice notice-warning' }, [
    el('p', {}, t('isolationNotice'))
  ]);

  return [
    el('div', { class: 'instance-spec-grid' }, [cardIdentity, cardExecution, cardLifecycle, cardComm]),
    advisory
  ];
}
function focusedButton(root) { const active = document.activeElement; if (!root.contains(active) || !['BUTTON', 'A'].includes(active.tagName)) return null; return { tag: active.tagName, text: active.textContent, href: active.getAttribute('href') }; }
function restoreButton(root, focus) { if (focus) [...root.querySelectorAll('button,a')].find(node => node.tagName === focus.tag && node.textContent === focus.text && node.getAttribute('href') === focus.href)?.focus({ preventScroll: true }); }
function renderDetail(force = false) {
  if (state.view !== 'detail') return;
  const instance = current();
  if (!instance) { navigate('packs'); return; }
  const headingStamp = JSON.stringify([instance.pack, instance.links, instance.status?.state, instance.status?.observation, instance.status?.cleanupIncomplete, instance.status?.stoppedAt, instance.status?.failure, isStale(instance.status), state.language, state.operations.get(state.selected)]);
  if (force || headingStamp !== state.headingStamp) { const focus = focusedButton($('#detail-actions')); renderDetailHeading(instance); restoreButton($('#detail-actions'), focus); state.headingStamp = headingStamp; }
  const content = state.tab === 'status'
    ? [instance.status?.components?.map(c => [c.id, c.module, c.pid, c.process, c.communication, c.readiness, Boolean(c.health?.lastCheckedAt), c.health?.ready]), instance.status?.runId, instance.status?.observation, state.topology]
    : state.tab === 'logs' ? state.logs : state.tab === 'modules' ? state.reviews.get(state.selected)?.reviewId
    : state.tab === 'storage' ? [instance.pack, instance.detached, instance.stagedFrom, instance.environment, instance.status?.state, instance.status?.runId, instance.status?.stoppedAt, instance.status?.cleanupIncomplete, operationFor(instance)]
    : [instance.pack, instance.directory, instance.importedAt, instance.environment, instance.status?.runId, instance.status?.stoppedAt, instance.status?.executionProfile, instance.status?.isolation];
  const stamp = JSON.stringify([state.selected, content, state.tab, state.language, isStale(instance.status), state.topologyUnavailable]);
  if (!force && stamp === state.detailStamp) return;
  state.detailStamp = stamp;
  const saved = advanced?.preserve($('#detail-content'));
  const children = state.tab === 'status' ? renderStatus(instance) : state.tab === 'modules' ? renderModules(instance) : state.tab === 'logs' ? renderLogs(instance) : state.tab === 'storage' ? advanced.renderStorage(instance) : renderDetails(instance);
  $('#detail-content').replaceChildren(...children);
  if (saved) advanced.reinstate($('#detail-content'), saved);
}
function renderAll(force = false) {
  const stamp = JSON.stringify([state.instances.map(i => [idOf(i), i.pack, i.moduleCount, i.status?.state, i.status?.observation, i.status?.cleanupIncomplete, i.status?.components?.map(c => [c.id, c.communication]), state.reviews.get(idOf(i))?.reviewId]), state.hubs, [...state.operations.entries()], state.language, observationLive(), state.hubsUnavailable, freshObservation(state.hubsObservedAt)]);
  if (force || stamp !== state.renderStamp) { const root = $(`#view-${state.view}`), focus = root && focusedButton(root); renderStats(); renderPacks(); renderOverview(); renderHubs(); if (root) restoreButton(root, focus); state.renderStamp = stamp; }
  renderDetail(force);
}

function recordRoute() {
  if (restoringHistory) return;
  const url = `${location.pathname}${state.view === 'detail' ? `?instance=${encodeURIComponent(state.selected)}` : ''}#${state.view === 'detail' ? state.tab : state.view}`;
  if (url === `${location.pathname}${location.search}${location.hash}` && historyReady) return;
  history[historyReady ? 'pushState' : 'replaceState']({ view: state.view, instance: state.selected, tab: state.tab }, '', url);
  historyReady = true;
}
function closeMenu() { $('.sidebar').dataset.menuOpen = 'false'; $('#sidebar-menu-toggle').setAttribute('aria-expanded', 'false'); $('#sidebar-menu-toggle').setAttribute('aria-label', t('menuOpen')); }
function focusPage() { window.scrollTo(0, 0); const target = $(`#view-${state.view} h1`) ?? $(`#view-${state.view} h2`) ?? $('#main'); target?.setAttribute('tabindex', '-1'); target?.focus({ preventScroll: true }); }
function navigate(view, updateHash = true) {
  if (['overview', 'workbench', 'hubs'].includes(view)) view = 'packs';
  state.view = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  const myViews = ['packs', 'modules', 'templates', 'detail'];
  for (const item of document.querySelectorAll('[data-view]')) { const selected = item.dataset.view === (myViews.includes(view) ? 'packs' : view); item.classList.toggle('active', selected); if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
  $('#breadcrumb').textContent = view === 'detail' ? currentTitle(state.selected) : ['sources', 'creator', 'modules', 'templates'].includes(view) ? advanced.label(view) : t({ packs: 'myPacks', environment: 'environment' }[view] ?? 'myPacks');
  if (updateHash) recordRoute();
  closeMenu();
  if (view === 'environment') renderEnvironment();
  advanced?.navigate(view);
  renderAll(true);
  if (['packs', 'modules', 'templates'].includes(view)) advanced?.renderAssetTabs?.(view);
  if (updateHash) focusPage();
}
async function restoreHistory() {
  if (restoringHistory || !state.auth?.token) return;
  restoringHistory = true;
  try {
    const id = new URLSearchParams(location.search).get('instance'), hash = location.hash.slice(1);
    if (id && state.instances.some(i => idOf(i) === id)) await selectInstance(id, ['status', 'modules', 'logs', 'storage', 'details'].includes(hash) ? hash : 'status');
    else navigate(['packs', 'environment', 'sources', 'creator', 'modules', 'templates'].includes(hash) ? hash : 'packs', false);
    focusPage();
  } finally { restoringHistory = false; }
}
async function selectInstance(id, tab = 'status', componentId = null) {
  state.selected = id; state.topology = null; state.topologyUnavailable = false; state.logs = null; state.logsRequest++; state.detailStamp = ''; state.headingStamp = ''; state.topologyStamp = '';
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
  if (updateHash) { recordRoute(); if (tab === 'logs') void loadLogs(state.selected, true); if (tab === 'status') void loadTopology(state.selected, true); }
  if (tab === 'storage') advanced?.loadStorage(state.selected);
}
function invalidateChangedRun(instance) {
  const previous = state.instances.find(item => idOf(item) === idOf(instance));
  if (state.selected === idOf(instance) && previous?.status?.runId !== instance.status?.runId) {
    state.logs = null; state.logsRequest++; state.topology = null; state.topologyUnavailable = false; state.topologyStamp = '';
  }
}
function replaceInstance(instance) { invalidateChangedRun(instance); const id = idOf(instance), index = state.instances.findIndex(i => idOf(i) === id); if (index === -1) state.instances.push(instance); else state.instances[index] = instance; }

async function refresh({ explicit = false } = {}) {
  const refreshBtn = $('#refresh');
  if (explicit && refreshBtn) {
    refreshBtn.classList.add('is-spinning');
    setTimeout(() => refreshBtn.classList.remove('is-spinning'), 600);
  }
  if (state.loading || !state.auth?.token) return;
  state.loading = true;
  try {
    const results = await Promise.allSettled([api('/api/instances'), api('/api/hubs')]);
    if (results[0].status === 'rejected') throw results[0].reason;
    const instances = results[0].value.instances ?? []; instances.forEach(invalidateChangedRun); state.instances = instances;
    if (results[1].status === 'fulfilled') { state.hubs = results[1].value.hubs ?? []; state.hubsObservedAt = new Date().toISOString(); state.hubsUnavailable = false; }
    else { state.hubsUnavailable = true; if (explicit) toast(results[1].reason.message); }
    state.online = true; state.lastRefresh = new Date().toISOString(); showNotice('#connection-notice', state.returnNotice, state.returnNotice ? 'warning' : ''); renderAll(explicit); void tasks?.check?.();
    if (state.view === 'detail' && state.tab === 'status') {
      const instance = current(), topologyStamp = JSON.stringify([instance?.status?.runId, instance?.status?.components?.map(c => c.bridges)]);
      if (topologyStamp !== state.topologyStamp && !state.topologyLoading) { state.topologyStamp = topologyStamp; void loadTopology(state.selected); }
    }
  } catch (error) { state.online = false; state.topologyUnavailable = true; showNotice('#connection-notice', `${t('observationUnknown')} ${error.message}`); renderAll(true); }
  finally { state.loading = false; updateConnectionState(); }
}
async function loadTopology(id, explicit = false) {
  const instance = current(); if (!id || !instance?.status?.runId || !running(instance)) return;
  const runId = instance.status.runId;
  if (state.topologyLoading) return;
  state.topologyLoading = true;
  try {
    const data = await api(`${endpoint(id, 'topology')}?runId=${encodeURIComponent(runId)}`);
    if (state.selected !== id || current()?.status?.runId !== data.topology?.runId) return;
    state.topology = data.topology; state.topologyUnavailable = false; renderDetail(true);
  } catch (error) { if (state.selected === id && current()?.status?.runId === runId) { state.topologyUnavailable = true; state.topologyStamp = ''; renderDetail(true); if (explicit) toast(error.message); } }
  finally { state.topologyLoading = false; }
}
async function loadLogs(id, explicit = false) {
  if (!id) return;
  const runId = state.instances.find(instance => idOf(instance) === id)?.status?.runId, request = ++state.logsRequest;
  try { const data = await api(endpoint(id, 'logs')); if (request !== state.logsRequest || state.selected !== id || current()?.status?.runId !== runId || data.logs?.instanceId !== id || data.logs?.runId !== runId) return; state.logs = data.logs; renderDetail(true); }
  catch (error) { if (explicit) toast(error.message); }
}

function importIdentity() {
  const original = $('#import-form').elements.instanceId;
  let section = $('#import-identity-review');
  if (!section) {
    const input = el('input', { name: 'reviewInstanceId', required: true, pattern: '[a-z0-9][a-z0-9._\\-]{0,63}', maxlength: '64', autocomplete: 'off', spellcheck: 'false' });
    section = el('label', { id: 'import-identity-review', hidden: true }, [el('span', { class: 'identity-review-label' }, t('instanceId')), input]);
    $('#import-review').before(section);
    input.addEventListener('input', () => { original.value = input.value; validateIdentity(); });
  }
  section.querySelector('input').value = original.value; section.querySelector('span').textContent = t('instanceId');
  original.disabled = Boolean(state.importReview);
  return section;
}
function validateIdentity() {
  const input = $('#import-form').elements.instanceId, id = input.value.trim(), exists = state.instances.some(i => idOf(i) === id);
  let note = $('#import-id-hint');
  if (!note) { note = el('p', { id: 'import-id-hint', class: 'field-help', role: 'status' }); $('#import-error').before(note); }
  note.textContent = exists ? say('该实例 ID 已存在。换个 ID 后可继续，已完成的来源审阅可保留。', 'This instance ID already exists. Choose another ID to continue; a completed source review can be kept.') : '';
  input.setAttribute('aria-invalid', String(exists)); $('#import-identity-review')?.querySelector('input').setAttribute('aria-invalid', String(exists));
  return !exists;
}
function suggestIdentity() {
  const form = $('#import-form'), base = (form.elements.directory.value.split(/[/\\]/).filter(Boolean).at(-1) ?? 'pack').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 50) || 'pack';
  let id = base, count = 1; while (state.instances.some(i => idOf(i) === id)) id = `${base}-${++count}`;
  form.elements.instanceId.value = id; return id;
}
function openImport(selectedDirectory) {
  state.importRequest++;
  state.importReview = null;
  $('#import-review').hidden = true; $('#import-fields').hidden = false; $('#import-error').hidden = true; $('#import-back').hidden = true;
  $('#import-submit').textContent = t('checkPackage'); $('#import-submit').disabled = false;
  $('#step-select').classList.add('active'); $('#step-review').classList.remove('active'); $('#step-create').classList.remove('active');
  for (const kind of ['nodePath', 'pythonPath']) $('#import-form').elements[kind].value = state.environmentSelection[kind] ?? state.session?.defaults?.[kind] ?? '';
  const directory = state.session?.defaults?.packDirectory;
  if (typeof selectedDirectory === 'string') $('#import-form').elements.directory.value = selectedDirectory;
  if (directory && !$('#import-form').elements.directory.value) $('#import-form').elements.directory.value = directory;
  if (!$('#import-form').elements.instanceId.value || state.instances.some(i => idOf(i) === $('#import-form').elements.instanceId.value.trim())) suggestIdentity();
  importIdentity().hidden = true; validateIdentity();
  $('#import-dialog').showModal();
}
function environmentOptions(form) { return Object.fromEntries(['nodePath', 'pythonPath'].map(key => [key, form.elements[key]?.value.trim()]).filter(([, value]) => value)); }
const reviewExpired = review => Boolean(review?.expiresAt) && (!Number.isFinite(Date.parse(review.expiresAt)) || Date.now() >= Date.parse(review.expiresAt));
function invalidateExecutionReview(error) {
  if (state.trustInstanceId) state.reviews.delete(state.trustInstanceId);
  state.trustReview = null; $('#trust-consent').checked = false; $('#trust-consent').disabled = true; $('#trust-submit').disabled = true;
  if (error) renderError('#trust-error', error); else showNotice('#trust-error', t('reviewExpired'), 'warning');
  $('#trust-error').append(button(t('checkAgain'), () => reviewInstance(state.trustInstanceId, state.trustKind), 'button button-small button-primary'));
}
async function importSubmit(event) {
  event.preventDefault(); const form = event.currentTarget, submit = $('#import-submit');
  if (submit.disabled) return;
  const request = state.importRequest;
  $('#import-error').hidden = true; submit.disabled = true;
  try {
    if (!validateIdentity()) { const active = state.importReview ? $('#import-identity-review input') : form.elements.instanceId; active.focus(); throw new Error(say('请先选择未使用的实例 ID。', 'Choose an unused instance ID first.')); }
    if (reviewExpired(state.importReview)) { state.importReview = null; $('#import-review').hidden = true; $('#import-fields').hidden = false; $('#import-back').hidden = true; importIdentity().hidden = true; throw new Error(t('reviewExpired')); }
    if (!state.importReview) {
      submit.textContent = t('checking');
      const data = await api('/api/review', { directory: form.elements.directory.value.trim(), ...environmentOptions(form), ...(state.isolationSelection ? { isolation: state.isolationSelection } : {}) });
      if (request !== state.importRequest || !$('#import-dialog').open) return;
      state.importReview = data; $('#import-review').replaceChildren(...reviewView(data, 'import')); $('#import-review').hidden = false; $('#import-fields').hidden = true; $('#import-back').hidden = false;
      importIdentity().hidden = false;
      $('#step-review').classList.add('active'); $('#step-create').classList.add('active'); submit.textContent = t('confirmImport');
    } else {
      submit.textContent = t('importing');
      const data = await api('/api/instances', { reviewId: state.importReview.reviewId, instanceId: form.elements.instanceId.value.trim() });
      const id = idOf(data.instance); state.reviews.set(id, state.importReview); replaceInstance(data.instance); $('#import-dialog').close(); state.importReview = null; renderAll(true); void tasks?.check(); toast(t('importedSuccess', { id })); await selectInstance(id);
    }
  } catch (error) { if (request === state.importRequest) { if (['REVIEW_REQUIRED', 'REVIEW_CHANGED'].includes(error.code)) { state.importReview = null; $('#import-review').hidden = true; $('#import-fields').hidden = false; $('#import-back').hidden = true; importIdentity().hidden = true; } if (error.code === 'INSTANCE_EXISTS') validateIdentity(); renderError('#import-error', error); } }
  finally { if (request === state.importRequest) { submit.disabled = false; submit.textContent = t(state.importReview ? 'confirmImport' : 'checkPackage'); } }
}
async function reviewInstance(id, kind) {
  const instance = state.instances.find(i => idOf(i) === id); if (!instance || operationFor(instance)) return;
  const request = ++state.trustRequest;
  state.trustReview = null; state.trustKind = kind; state.trustInstanceId = id; $('#trust-consent').checked = false; $('#trust-consent').disabled = true; $('#trust-submit').disabled = true; $('#trust-error').hidden = true;
  $('#trust-review').replaceChildren(el('p', { class: 'dialog-description' }, t('checking')));
  $('#trust-submit').textContent = t(kind === 'restart' ? 'trustAndRestart' : 'trustAndStart');
  $('.consent').hidden = kind === 'review'; $('#trust-submit').hidden = kind === 'review'; if (!$('#trust-dialog').open) $('#trust-dialog').showModal();
  try {
    const selected = Object.keys(state.environmentSelection).length ? state.environmentSelection : instance.environment ?? {};
    const data = await api(endpoint(id, 'review'), { ...selected, ...(state.isolationSelection ? { isolation: state.isolationSelection } : {}) });
    if (request !== state.trustRequest || !$('#trust-dialog').open) return;
    state.reviews.set(id, data); state.trustReview = { ...data, instanceId: id }; $('#trust-consent').disabled = false;
    $('#trust-review').replaceChildren(...reviewView(data), el('p', { class: 'field-help' }, t('reviewEnvironmentHint'))); renderDetail(true);
  } catch (error) { if (request !== state.trustRequest) return; $('#trust-review').replaceChildren(el('p', {}, t('envMissing'))); renderError('#trust-error', error); }
}
async function authorizeExecution() {
  const review = state.trustReview;
  if (!review || !$('#trust-consent').checked) return;
  if (reviewExpired(review)) { invalidateExecutionReview(); return; }
  $('#trust-submit').disabled = true; $('#trust-error').hidden = true;
  try {
    const data = await api(endpoint(review.instanceId, state.trustKind), { reviewId: review.reviewId, accepted: true });
    $('#trust-dialog').close(); state.trustReview = null; await followOperation(data.operationId, review.instanceId, state.trustKind);
  } catch (error) { if (['REVIEW_REQUIRED', 'REVIEW_CHANGED'].includes(error.code) || error.status === 401) invalidateExecutionReview(error); else { renderError('#trust-error', error); $('#trust-submit').disabled = !$('#trust-consent').checked; } }
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
      else if (kind === 'export') { toast(t('exportedSuccess', { destination: operation.result?.destination ?? state.exportDestination ?? '—' })); void tasks?.open(); }
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
  try {
    state.environment = await api('/api/environment', selection);
    state.environmentSelection = selection;
    renderEnvironment();
    advanced?.renderEnvironmentTools?.();
    toast(t('detected'));
  }
  catch (error) { $('#environment-results').replaceChildren(el('div', { class: 'notice notice-error' }, errorContents(error))); }
  finally { submit.disabled = false; }
}

function languageChanged() {
  applyLanguage(state.language); $('#language').value = state.language;
  for (const item of document.querySelectorAll('[data-view]')) item.setAttribute('aria-label', ['creator', 'sources'].includes(item.dataset.view) ? advanced.label(item.dataset.view) : t({packs:'my',overview:'overview',hubs:'hubs',workbench:'workbench',environment:'environment'}[item.dataset.view]));
  $('#theme').title = t('toggleTheme'); $('#theme').setAttribute('aria-label', t('toggleTheme')); $('#navigation').setAttribute('aria-label', t('useNavigation')); $('#creator-navigation').setAttribute('aria-label', t('createNavigation')); $('#system-navigation').setAttribute('aria-label', t('systemNavigation')); $('#search').setAttribute('aria-label', t('searchInstances'));
  for (const close of document.querySelectorAll('.close-dialog.icon-button')) close.setAttribute('aria-label', t('close'));
  updateConnectionState();
  renderAll(true); renderEnvironment();
  if (state.importReview) { $('#import-review').replaceChildren(...reviewView(state.importReview, 'import')); $('#import-submit').textContent = t('confirmImport'); }
  if (state.trustReview) { $('#trust-review').replaceChildren(...reviewView(state.trustReview)); $('#trust-submit').textContent = t(state.trustKind === 'restart' ? 'trustAndRestart' : 'trustAndStart'); }
  advanced?.languageChanged();
  paths?.languageChanged(); tasks?.languageChanged(); importIdentity(); validateIdentity();
  const menu = $('#sidebar-menu-toggle'); menu.setAttribute('aria-label', t(menu.getAttribute('aria-expanded') === 'true' ? 'menuClose' : 'menuOpen'));
  const refreshBtn = $('#refresh'); if (refreshBtn) { refreshBtn.title = t('refresh'); refreshBtn.setAttribute('aria-label', t('refresh')); }
  $('#breadcrumb').textContent = state.view === 'detail' ? currentTitle(state.selected) : ['sources', 'creator', 'modules', 'templates'].includes(state.view) ? advanced.label(state.view) : t({ packs: 'myPacks', environment: 'environment' }[state.view] ?? 'myPacks');
  updateNavAndThemeIcons();
}
function updateNavAndThemeIcons() {
  const refreshBtn = $('#refresh');
  if (refreshBtn && !refreshBtn.querySelector('svg')) refreshBtn.replaceChildren(createIcon('refresh'));
  const navIcons = { packs: 'packs', modules: 'modules', templates: 'templates', overview: 'overview', hubs: 'hubs', workbench: 'workbench', sources: 'sources', creator: 'creator', environment: 'environment' };
  for (const item of document.querySelectorAll('.nav-item[data-view]')) {
    const iconSpan = item.querySelector('.nav-icon');
    const iconName = navIcons[item.dataset.view];
    if (iconSpan && iconName && !iconSpan.querySelector('svg')) iconSpan.replaceChildren(createIcon(iconName));
  }
  const isLight = document.documentElement.dataset.theme === 'light';
  const themeBtn = $('#theme');
  if (themeBtn) themeBtn.replaceChildren(createIcon(isLight ? 'themeDark' : 'themeLight'));
  for (const closeBtn of document.querySelectorAll('.close-dialog.icon-button')) {
    if (!closeBtn.querySelector('svg')) closeBtn.replaceChildren(createIcon('close'));
  }
  const backBtn = $('#back-to-packs');
  if (backBtn && !backBtn.querySelector('svg')) {
    const arrow = backBtn.querySelector('span[aria-hidden=true]');
    if (arrow) arrow.replaceChildren(createIcon('arrowLeft'));
  }
  const searchField = $('.search-field');
  if (searchField && !searchField.querySelector('svg')) {
    const searchIcon = searchField.querySelector('span[aria-hidden=true]');
    if (searchIcon) searchIcon.replaceChildren(createIcon('search'));
  }
  const importBtn = document.querySelector('[data-action=import]');
  if (importBtn && !importBtn.querySelector('svg')) {
    const plusIcon = importBtn.querySelector('span[aria-hidden=true]');
    if (plusIcon) plusIcon.replaceChildren(createIcon('plus'));
  }
  const detailTabIcons = {
    'tab-status': 'sparkle',
    'tab-modules': 'shield',
    'tab-logs': 'workbench',
    'tab-storage': 'database',
    'tab-details': 'inspect'
  };
  for (const [id, iconName] of Object.entries(detailTabIcons)) {
    const tabBtn = $(`#${id}`);
    const iconSpan = tabBtn?.querySelector('.tab-icon');
    if (iconSpan && !iconSpan.querySelector('svg')) {
      iconSpan.replaceChildren(createIcon(iconName));
    }
  }
}
function initializeEvents() {
  document.addEventListener('keydown', handleTabKeydown);
  $('#sidebar-menu-toggle').addEventListener('click', () => { const open = $('#sidebar-menu-toggle').getAttribute('aria-expanded') !== 'true'; $('.sidebar').dataset.menuOpen = String(open); $('#sidebar-menu-toggle').setAttribute('aria-expanded', String(open)); $('#sidebar-menu-toggle').setAttribute('aria-label', t(open ? 'menuClose' : 'menuOpen')); });
  window.addEventListener('popstate', () => void restoreHistory());
  for (const item of document.querySelectorAll('[data-view]')) item.addEventListener('click', () => navigate(item.dataset.view));
  for (const item of document.querySelectorAll('[data-action=import]')) item.addEventListener('click', openImport);

  const importDropdownTrigger = $('#import-dropdown-trigger');
  const importDropdownMenu = $('#import-dropdown-menu');
  if (importDropdownTrigger && importDropdownMenu) {
    importDropdownTrigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const isHidden = importDropdownMenu.hidden;
      importDropdownMenu.hidden = !isHidden;
      importDropdownTrigger.setAttribute('aria-expanded', String(isHidden));
    });
    $('#action-import-new')?.addEventListener('click', () => {
      importDropdownMenu.hidden = true;
      importDropdownTrigger.setAttribute('aria-expanded', 'false');
      openImport();
    });
    $('#restore-entry')?.addEventListener('click', () => {
      importDropdownMenu.hidden = true;
      importDropdownTrigger.setAttribute('aria-expanded', 'false');
      advanced?.openRestore?.();
    });
    document.addEventListener('click', (event) => {
      if (!event.target?.closest?.('#import-dropdown-wrap')) {
        if (!importDropdownMenu.hidden) {
          importDropdownMenu.hidden = true;
          importDropdownTrigger.setAttribute('aria-expanded', 'false');
        }
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !importDropdownMenu.hidden) {
        importDropdownMenu.hidden = true;
        importDropdownTrigger.setAttribute('aria-expanded', 'false');
        importDropdownTrigger.focus();
      }
    });
  }
  $('#packs-workshop-btn')?.addEventListener('click', () => navigate('sources'));

  for (const item of document.querySelectorAll('[data-tab]')) item.addEventListener('click', () => changeTab(item.dataset.tab));
  $('.detail-tabs').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const tabs = [...document.querySelectorAll('[data-tab]')], index = tabs.findIndex(tab => tab.dataset.tab === state.tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); changeTab(tabs[next].dataset.tab); tabs[next].focus(); });
  for (const item of document.querySelectorAll('.close-dialog')) item.addEventListener('click', () => $(`#${item.dataset.dialog}`).close());
  $('#trust-dialog').addEventListener('close', () => { state.trustRequest++; state.trustReview = null; $('#trust-consent').checked = false; $('#trust-consent').disabled = true; $('#trust-submit').disabled = true; });
  $('#import-dialog').addEventListener('close', () => { state.importRequest++; });
  $('#language').addEventListener('change', event => { state.language = event.target.value; try { localStorage.setItem('world-hub.launcher.language', state.language); } catch {} languageChanged(); });
  $('#theme').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('world-hub.launcher.theme', theme); } catch {} updateNavAndThemeIcons(); });
  $('#refresh').addEventListener('click', () => refresh({ explicit: true })); $('#search').addEventListener('input', renderPacks); $('#back-to-packs').addEventListener('click', () => navigate('packs'));
  $('#import-form').elements.instanceId.addEventListener('input', validateIdentity);
  $('#import-form').addEventListener('submit', importSubmit); $('#import-back').addEventListener('click', () => { state.importReview = null; $('#import-review').hidden = true; $('#import-fields').hidden = false; importIdentity().hidden = true; $('#import-back').hidden = true; $('#import-submit').textContent = t('checkPackage'); $('#import-error').hidden = true; $('#step-review').classList.remove('active'); $('#step-create').classList.remove('active'); });
  $('#trust-consent').addEventListener('change', event => { if (reviewExpired(state.trustReview)) invalidateExecutionReview(); else $('#trust-submit').disabled = !event.target.checked || !state.trustReview; }); $('#trust-submit').addEventListener('click', authorizeExecution); $('#export-form').addEventListener('submit', exportSubmit); $('#environment-form').addEventListener('submit', detectEnvironment);
  for (const item of document.querySelectorAll('[data-env-tab]')) item.addEventListener('click', () => setEnvironmentTab(item.dataset.envTab));
  $('.brand').addEventListener('click', event => { event.preventDefault(); navigate('packs'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}

function handleTabKeydown(event) {
  if (event.defaultPrevented) return;
  const selected = event.target?.closest?.('[role="tab"]');
  const list = selected?.closest('[role="tablist"]');
  if (!list) return;
  const vertical = list.getAttribute('aria-orientation') === 'vertical';
  const previous = vertical ? 'ArrowUp' : 'ArrowLeft', following = vertical ? 'ArrowDown' : 'ArrowRight';
  if (![previous, following, 'Home', 'End'].includes(event.key)) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')].filter(tab => tab.closest('[role="tablist"]') === list && !tab.disabled);
  const index = tabs.indexOf(selected); if (index < 0 || !tabs.length) return;
  const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === following ? 1 : -1) + tabs.length) % tabs.length];
  event.preventDefault();
  next.click();
  const fresh = next.id ? document.getElementById(next.id) : next;
  if (fresh?.isConnected !== false) fresh?.focus();
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
  await selectInstance(hints.instance, ['status', 'modules', 'logs', 'storage', 'details'].includes(hints.tab) ? hints.tab : 'status', componentId); return true;
}

async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1)), launchCode = hash.get('launch');
  if (launchCode) history.replaceState(null, '', `${location.pathname}${location.search}`);
  const queries = new URLSearchParams(location.search), hints = Object.fromEntries(queries); hints.tab = location.hash.slice(1);
  const initialView = ['packs', 'environment', 'sources', 'creator', 'modules', 'templates'].includes(hints.tab) ? hints.tab : 'packs';
  try { const theme = localStorage.getItem('world-hub.launcher.theme'); if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme; } catch {}
  try { localStorage.removeItem(sessionKey); } catch { /* Remove credentials persisted by older UI builds. */ }
  try { state.auth = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null'); } catch { state.auth = null; }
  advanced = createAdvancedUi({ state, api, el, button, pill, t, toast, definition, display, date, guidance, errorContents, current, idOf, endpoint, operationFor, exitUnconfirmed, refresh, renderDetail, navigate, changeTab, selectInstance, openImport, replaceInstance, reviewView, createIcon, renderSquareArt, setEnvironmentTab, confirmDialog, openPathPicker: (input, purpose) => paths?.open(input, purpose) });
  paths = createPathUi({ state, api, el, button, toast });
  tasks = createTaskUi({ state, api, el, button, toast, date, selectInstance, openImport, openCreator: directory => advanced.openCreator(directory), createIcon });
  initializeEvents(); languageChanged(); navigate(initialView, false);
  try {
    if (state.auth?.token) {
      try {
        state.session = await api('/api/session');
        if (state.session.csrfToken) state.auth.csrfToken = state.session.csrfToken;
      } catch {
        state.auth = null;
        try { sessionStorage.removeItem(sessionKey); localStorage.removeItem(sessionKey); } catch {}
      }
    }
    if (!state.auth?.token) {
      if (!launchCode) throw new Error(t('sessionRequired'));
      const session = await api('/api/session', { code: launchCode });
      state.auth = { token: session.token, csrfToken: session.csrfToken };
      state.session = session;
    }
    try { sessionStorage.setItem(sessionKey, JSON.stringify(state.auth)); } catch {}
    $('#version').textContent = state.session.softwareVersion ? `v${state.session.softwareVersion}` : 'LOCAL';
    for (const kind of ['nodePath', 'pythonPath']) $('#environment-form').elements[kind].value = state.session.defaults?.[kind] ?? '';
    advanced.sessionReady(); paths.sessionReady();
    await refresh({ explicit: true });
    if (!await resolveReturnHint(hints)) navigate(initialView);
    setInterval(() => { if (!document.hidden) { if (reviewExpired(state.trustReview)) invalidateExecutionReview(); renderAll(); if (state.auth?.token) void refresh(); } }, 1000);
  } catch (error) { showNotice('#connection-notice', error.message); updateConnectionState(false); }
}

void boot();
