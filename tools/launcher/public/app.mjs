import { initialLanguage, localizeErrorMessage } from './i18n.mjs';
import { createPathUi } from './path-ui.mjs';
import { createIcon, createModuleAvatar } from './icons.mjs';
import { groupAssets, createAssetVersionSelection, renderAssetVersionSelector } from './asset-versions.mjs';
import { createGlobalDynamicModulesUi } from './global-dynamic-modules-tab.mjs';
import { createModuleWorkbench } from './module-workbench.mjs';

export const navigation = [
  ['modules', '模块中心', 'Module Center', 'modules', [
    ['programs', '已接入模块', 'Connected Modules', 'hubs'],
    ['sources', '在线获取', 'Get Modules', 'download']
  ]],
  ['communication', '系统与环境', 'Environment & System', 'environment', [
    ['environment', '环境与解释器探针', 'Environment & Diagnostics', 'environment']
  ]]
];
export function localEntryUrl(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function sameSourceArtifact(left, right) { return left?.entryId === right?.entryId && left?.sha256 === right?.sha256 && left?.kind === 'module' && right?.kind === 'module'; }
export function sourceFetchInput(observation, entry) {
  if (!observation?.receiptId || !observation?.sourceId || !entry?.entryId || entry.kind !== 'module') throw new Error('Inspect the module source before downloading.');
  return { sourceId: observation.sourceId, receiptId: observation.receiptId, entryId: entry.entryId };
}
export function canAcquireSourceModule(observation, entry) { return entry?.kind === 'module' && (!observation?.offline || entry.cached === true); }
export function moduleLibraryRows(known) { return (known?.objects ?? []).filter(row => row.kind === 'module'); }

const sessionKey = 'world-hub.launcher.session';
const $ = selector => document.querySelector(selector);
const state = { language: initialLanguage(), view: 'modules', auth: null, session: null, online: false, hubsUnavailable: true, hubsObservedAt: null,
  programs: [], groups: [], hubs: [], objects: [], sources: [], sourceIndex: null, sourceError: null, sourceId: null, operations: [], environment: null, topology: null };
const say = (zh, en) => state.language === 'zh' ? zh : en;
const title = row => typeof row?.title === 'string' ? row.title : row?.title?.[state.language] ?? row?.title?.en ?? row?.title?.zh ?? row?.module?.id ?? row?.programId ?? row?.id ?? '—';
const date = value => value ? new Date(value).toLocaleString(state.language === 'zh' ? 'zh-CN' : 'en-US') : '—';
const isLive = () => state.online && Date.now() - Date.parse(state.hubsObservedAt) < 12000;
const moduleSelection = createAssetVersionSelection({ storageKey: 'world-hub.module-version-selection/v2' });
const sourceSelection = createAssetVersionSelection({ storageKey: 'world-hub.module-source-selection/v2' });
let paths, communication, workbench, refreshing = false, toastTimer, environmentForm, activeTasks, navigationStamp = '', hubStamp = '', moduleSubtab = 'local', communicationSubtab = 'dynamic';

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (['disabled', 'hidden', 'checked', 'selected', 'multiple'].includes(key)) node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const button = (label, callback, className = 'button', disabled = false) => el('button', { type: 'button', class: className, disabled, onclick: event => { const result = callback(event); if (result?.catch) result.catch(error); } }, label);
const pill = (text, tone = '') => el('span', { class: `pill${tone ? ` pill-${tone}` : ''}` }, text);
const field = (label, input) => el('label', {}, [el('span', {}, label), input]);
const input = (name, value = '', attributes = {}) => { const node = el('input', { name, autocomplete: 'off', spellcheck: 'false', ...attributes }); node.value = value; return node; };
const json = (name, value) => { const node = el('textarea', { name, rows: '5', class: 'sh-json-editor', spellcheck: 'false', 'aria-label': name }); node.value = JSON.stringify(value, null, 2); return node; };
const details = (label, data) => el('details', {}, [el('summary', {}, label), el('pre', { class: 'review-digest' }, JSON.stringify(data, null, 2))]);
const info = text => el('p', { class: 'field-help' }, text);
const actions = children => el('div', { class: 'result-actions' }, children);
function empty(text, label, callback) { return el('section', { class: 'panel sh-empty' }, [createIcon('modules'), el('p', {}, text), label ? button(label, callback, 'button button-primary') : null]); }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = localizeErrorMessage(message, state.language); $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000); }
function dialog(titleText, children) {
  const node = el('dialog', { class: 'dialog sh-dialog', 'aria-label': titleText });
  const close = button('×', () => node.close(), 'icon-button'); close.setAttribute('aria-label', say('关闭', 'Close'));
  node.append(el('div', { class: 'dialog-heading' }, [el('h2', {}, titleText), close]), ...children); document.body.append(node);
  node.addEventListener('close', () => node.remove(), { once: true }); node.showModal(); paths?.enhance(node); return node;
}
function error(issue) {
  dialog(say('操作未完成', 'Operation did not complete'), [el('p', { class: 'notice notice-error', role: 'alert' }, localizeErrorMessage(issue.message ?? String(issue), state.language)),
    issue.code ? info(issue.code) : null, issue.guidance ? details(say('操作建议', 'Guidance'), issue.guidance) : null,
    issue.issues ? details(say('检查结果', 'Inspection issues'), issue.issues) : null].filter(Boolean));
}
async function run(action) { try { return await action(); } catch (issue) { error(issue); } }
function confirm({ title: label, message, action, danger = false }) {
  const node = dialog(label, [el('p', {}, message)]), accept = button(say('确认', 'Confirm'), () => run(async () => { accept.disabled = true; try { await action(); node.close(); } finally { accept.disabled = false; } }), danger ? 'button button-danger' : 'button button-primary');
  node.append(actions([button(say('取消', 'Cancel'), () => node.close(), 'button button-quiet'), accept]));
}
function reviewFacts(data) {
  const facts = [], add = (label, value) => { if (value !== undefined && value !== null && value !== '') facts.push(el('div', {}, [el('dt', {}, label), el('dd', {}, typeof value === 'string' ? value : JSON.stringify(value))])); };
  add(say('实例标识', 'Instance ID'), data?.programId); add(say('模块', 'Module'), data?.module ? `${data.module.id}@${data.module.version}` : data?.entryId);
  add(say('来源目录 / 地址', 'Source directory / URL'), data?.directory ?? data?.source); add('SHA-256', data?.sha256); add(say('许可证', 'License'), data?.license);
  if (data?.executionProfile === 'trusted-local' || data?.sandbox === false) add(say('执行环境', 'Execution environment'), say('可信本机执行 · 无操作系统沙箱', 'Trusted local execution · no OS sandbox'));
  if (data?.affected) { add(say('引用此实例的组', 'Groups referencing this instance'), data.affected.sharedWithGroups?.map(title).join(', ') || '—'); add(say('依赖消费者', 'Dependent consumers'), data.affected.consumers?.map(row => `${row.programId} (${row.state})`).join(', ') || '—'); }
  if (data?.order) add(say('本次启动顺序', 'Startup order'), data.order.join(' → ') || say('未选择自动启动成员', 'No automatic members selected'));
  if (data?.bridges) for (const [slot, rules] of Object.entries(data.bridges)) {
    add(`${slot} · ${say('发送', 'Publish')}`, (rules.publish ?? []).map(alias => data.topics?.[alias] ?? alias).join(', ') || '—');
    add(`${slot} · ${say('抽取', 'Subscribe')}`, (rules.subscribe ?? []).map(alias => data.topics?.[alias] ?? alias).join(', ') || '—');
  }
  if (data?.settings) for (const [key, value] of Object.entries(data.settings)) add(key, value);
  return el('dl', { class: 'definition-grid sh-review-facts' }, facts);
}
function review({ title: label, data, message, apply, extra }) {
  const accepted = input('accepted', '', { type: 'checkbox' }), node = dialog(label, [el('p', {}, message), reviewFacts(data), details(say('本次精确审阅与源码摘要', 'Exact review and source hashes'), data), ...(extra ? [extra] : [])]);
  const applyButton = button(say('应用本次审阅', 'Apply this review'), () => run(async () => {
    if (!accepted.checked) return; applyButton.disabled = true;
    try { await apply(); node.close(); await refresh(); } finally { applyButton.disabled = !accepted.checked; }
  }), 'button button-primary', true);
  accepted.addEventListener('change', () => { applyButton.disabled = !accepted.checked; });
  node.append(el('label', { class: 'sh-check sh-consent' }, [accepted, el('span', {}, say('我已核对源码、权限、接线与上述影响，同意本次操作。', 'I reviewed the source, permissions, wiring and effects above and approve this operation.'))]), actions([button(say('取消', 'Cancel'), () => node.close(), 'button button-quiet'), applyButton]));
}
async function api(path, body) {
  if (!state.auth?.token && path !== '/api/session') throw new Error(say('请从启动器重新打开此页面以建立本机会话。', 'Reopen this page from Launcher to create a local session.'));
  const headers = { Accept: 'application/json' }; if (state.auth?.token) headers.Authorization = `Bearer ${state.auth.token}`;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (state.auth?.csrfToken) headers['X-CSRF-Token'] = state.auth.csrfToken; }
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(path.includes('native-pick') ? 300000 : 90000) });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    if (response.status === 401) { state.online = false; state.auth = null; try { sessionStorage.removeItem(sessionKey); } catch {} }
    throw Object.assign(new Error(data.error?.message ?? `HTTP ${response.status}`), data.error ?? {}, { guidance: data.guidance, issues: data.issues });
  }
  return data;
}
async function operation(result) {
  if (!result?.operationId) return result;
  const id = result.operationId;
  for (;;) {
    const { operation: row } = await api(`/api/operations/${encodeURIComponent(id)}`);
    state.operations = [row, ...state.operations.filter(other => other.id !== row.id)]; renderTaskTrigger();
    if (row.state === 'succeeded') { await refresh(); return row.result; }
    if (['failed', 'cancelled'].includes(row.state)) throw Object.assign(new Error(row.error?.message ?? say('操作已取消。', 'Operation cancelled.')), row.error ?? {});
    await new Promise(done => setTimeout(done, 500));
  }
}
function safeLink(label, value) { const url = localEntryUrl(value); return url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'button button-quiet' }, label) : null; }
function hub() { return state.hubs.find(row => row.id === 'default' || row.hubId === 'default') ?? state.hubs[0] ?? { state: 'stopped' }; }
function programState(row) { return say(({ running: '运行中', stopped: '已停止', failed: '失败', starting: '启动中', stopping: '停止中', unknown: '归属未知' })[row.state] ?? row.state, row.state); }
function renderHub() {
  const row = hub(), live = isLive(), running = live && row.state === 'running';
  const stamp = JSON.stringify([row, live, state.language, state.programs.filter(program => program.state === 'running').length]); if (stamp === hubStamp) return; hubStamp = stamp;
  $('#hub-bar').replaceChildren(el('div', { class: 'sh-hub-heading' }, [
    createIcon('hubs'),
    el('div', {}, [
      el('strong', {}, say('世界枢纽', 'World Hub')),
      el('small', { class: 'mono' }, running ? row.url ?? 'launcher.default' : say('所有模块共享的世界通信枢纽', 'One communication hub for every module'))
    ]),
    pill(live ? running ? say('运行中', 'Running') : say('已停止', 'Stopped') : say('状态待刷新', 'Refresh required'), running ? 'teal' : 'amber')
  ]),
  actions([
    button(running ? say('停止世界枢纽…', 'Stop Hub…') : say('启动世界枢纽', 'Start Hub'), () => {
      const execute = () => run(async () => { await operation(await api(`/api/hubs/default/${running ? 'stop' : 'start'}`, {})); await refresh(); });
      if (running) confirm({ title: say('停止世界枢纽', 'Stop World Hub'), message: say(`这会停止世界枢纽及其 ${state.programs.filter(program => program.state === 'running').length} 个正在运行的受管模块。外部程序的进程不由 Launcher 终止。`, `This stops the Hub and its ${state.programs.filter(program => program.state === 'running').length} running managed modules. Launcher does not terminate external processes.`), action: execute, danger: true }); else execute();
    }, running ? 'button button-quiet' : 'button button-primary', !live),
    button(say('启动计划', 'Startup plan'), () => startPlan(), 'button button-quiet', !live || !state.programs.length),
    button(say('编排计划', 'Edit plan'), () => openWorkbench('global-plan'), 'button button-quiet'),
    ...(running ? [safeLink(say('内核看板 ↗', 'Communication workbench'), row.workbenchUrl), safeLink(say('流向拓扑 ↗', 'Information flow'), row.managementUrl)] : [])
  ]));
}
function renderStats() {
  const container = $('#topbar-stats');
  if (!container) return;
  const runningCount = state.programs.filter(row => row.state === 'running').length;
  const totalConnected = state.programs.length + (state.externalInventory?.programs?.length ?? 0);
  const metrics = [
    { label: say('已接入', 'Connected'), value: totalConnected, action: () => { moduleSubtab = 'programs'; moduleCategory = 'all'; navigate('modules'); } },
    { label: say('运行中', 'Running'), value: runningCount, isRunning: true, action: () => { moduleSubtab = 'programs'; navigate('modules'); } },
    { label: say('模块组', 'Groups'), value: state.groups.length, action: () => { moduleSubtab = 'programs'; moduleViewMode = 'folders'; navigate('modules'); } },
    { label: say('在线来源', 'Sources'), value: state.sources.length, action: () => { moduleSubtab = 'sources'; navigate('modules'); } }
  ];
  container.replaceChildren(...metrics.map(m => {
    const card = el('article', {
      class: `stat-card${m.isRunning && m.value > 0 ? ' is-running' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${m.label}: ${m.value}`,
      onclick: m.action
    }, [
      el('span', { class: 'stat-label' }, [
        m.isRunning && m.value > 0 ? el('span', { class: 'stat-live-dot' }) : null,
        m.label
      ].filter(Boolean)),
      el('strong', { class: 'stat-value' }, String(m.value))
    ]);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        m.action();
      }
    });
    return card;
  }));
}
function pageHeader(label, description, buttons = []) {
  const textChildren = [];
  if (label || description) {
    textChildren.push(el('div', { class: 'eyebrow' }, 'WORLD HUB · LOCAL WORKSPACE'));
    if (label) textChildren.push(el('h1', {}, label));
    if (description) textChildren.push(el('p', {}, description));
  }
  return el('div', { class: `sh-page-heading${textChildren.length ? '' : ' sh-actions-heading'}` }, [
    textChildren.length ? el('div', {}, textChildren) : null,
    actions(buttons)
  ].filter(Boolean));
}
async function importAndConnectModule() {
  const path = input('artifactPath', '', { 'data-path-purpose': 'source' }), kind = el('select', { 'aria-label': say('导入来源类型', 'Import source type') }, [el('option', { value: 'source' }, say('模块 ZIP 文件', 'Module ZIP file')), el('option', { value: 'module' }, say('模块目录', 'Module directory'))]), status = el('p', { role: 'status' });
  const known = state.objects.filter(obj => obj.kind === 'module');
  let presetSelect = null;
  if (known.length) {
    presetSelect = el('select', { 'aria-label': say('从已有本地制品中选择', 'From existing local artifacts') }, [
      el('option', { value: '' }, say('— 选择已有本地制品（可选） —', '— Choose existing local artifact (optional) —')),
      ...known.map(obj => el('option', { value: obj.path }, `${obj.id ?? obj.path}@${obj.version ?? '1.0'} (${obj.path})`))
    ]);
    presetSelect.addEventListener('change', () => {
      if (presetSelect.value) { path.value = presetSelect.value; kind.value = 'module'; path.dataset.pathPurpose = 'module'; }
    });
  }
  const node = dialog(say('接入本地模块', 'Connect local module'), [
    info(say('选择模块 ZIP、含 module.json 的目录，或直接选择已有本地制品。导入核验后直接引导接入世界枢纽。', 'Select a module ZIP, a directory containing module.json, or choose an existing local artifact. After import, it directly guides registration to World Hub.')),
    presetSelect ? field(say('从已有本地制品中选择', 'From existing local artifacts'), presetSelect) : null,
    field(say('导入来源类型', 'Import source type'), kind),
    field(say('模块 ZIP 或目录', 'Module ZIP or directory'), path),
    status
  ].filter(Boolean));
  kind.addEventListener('change', () => { path.dataset.pathPurpose = kind.value; path.value = ''; });
  const apply = button(say('检查并接入', 'Check & connect'), () => run(async () => {
    apply.disabled = true;
    try {
      const targetPath = path.value.trim();
      if (!targetPath) return;
      const result = await api('/api/artifacts/import', { path: targetPath, kind: 'module' });
      status.textContent = result.object?.path ?? '';
      await refresh();
      node.close();
      const moduleDirectory = result.object?.path ?? targetPath;
      await registerModule(moduleDirectory);
    } finally { apply.disabled = false; }
  }), 'button button-primary');
  node.append(actions([apply]));
}
const importModule = importAndConnectModule;
async function registerModule(directory) {
  const inspected = await api('/api/deployment/inspect', { directory }), manifest = inspected.manifest, declaration = inspected.deploymentReview?.deployment ?? inspected.deployment;
  const id = input('programId', manifest.id.replace(/[^a-z0-9._-]/g, '-').slice(0, 48) + '-' + (state.programs.length + 1), { pattern: '[a-z0-9][a-z0-9._-]{0,63}', maxlength: '64' });
  const settings = declaration ? Object.fromEntries((declaration.settings ?? []).map(row => [row.key, row.default])) : {};
  const topics = declaration?.topics ?? {}, bridges = declaration?.bridges ?? Object.fromEntries((manifest.bridges ?? []).map(slot => [slot, { publish: [], subscribe: [] }]));
  const settingNodes = (declaration?.settings ?? []).map(row => {
    const node = input(row.key, row.type === 'boolean' ? '' : String(row.default), { type: row.type === 'boolean' ? 'checkbox' : row.type === 'number' ? 'number' : 'text', ...(row.min !== undefined ? { min: row.min } : {}), ...(row.max !== undefined ? { max: row.max } : {}) });
    if (row.type === 'boolean') node.checked = row.default;
    return { row, node, field: field(title({ title: row.label }) || row.key, node) };
  });
  const topicNodes = Object.entries(topics).map(([alias, value]) => ({ alias, node: input(alias, value) })), bindings = (manifest.requires ?? []).map(contract => {
    const candidates = state.programs.filter(program => program.provides.some(value => value.id === contract.id && value.version === contract.version));
    const select = el('select', { 'aria-label': `${contract.id}@${contract.version}` }, [el('option', { value: '' }, say('选择能力提供者', 'Choose a provider')), ...candidates.map(program => el('option', { value: program.programId }, `${title(program)} · ${program.programId}`))]);
    return { contract, select };
  });
  const jsonSettings = declaration ? null : json('settings', settings), jsonTopics = declaration ? null : json('topics', topics), bridgeEditor = json('bridges', bridges);
  const node = dialog(say('登记独立模块实例', 'Register an independent module instance'), [el('p', {}, `${manifest.id}@${manifest.version}`), info(directory), field(say('实例标识（与其他实例不同）', 'Instance ID (unique)'), id),
    ...settingNodes.map(row => row.field), ...topicNodes.map(row => field(row.alias, row.node)), ...(declaration ? [] : [info(say('此模块没有默认接入声明，请填写公开参数、具体通道和枢纽桥权限。', 'This module has no default deployment declaration. Enter public settings, concrete topics and bridge permissions.')), field(say('公开参数 (JSON)', 'Public settings (JSON)'), jsonSettings), field(say('通道地址 (JSON)', 'Topic addresses (JSON)'), jsonTopics)]),
    ...bindings.map(row => field(`${row.contract.id}@${row.contract.version}`, row.select)), el('details', { open: !declaration }, [el('summary', {}, say('枢纽桥权限 (JSON)', 'Hub bridge permissions (JSON)')), bridgeEditor])]);
  const submit = button(say('审阅登记', 'Review registration'), () => run(async () => {
    const body = { programId: id.value.trim(), directory, settings: declaration ? Object.fromEntries(settingNodes.map(({ row, node }) => [row.key, row.type === 'boolean' ? node.checked : row.type === 'number' ? Number(node.value) : node.value])) : JSON.parse(jsonSettings.value),
      topics: declaration ? Object.fromEntries(topicNodes.map(row => [row.alias, row.node.value.trim()])) : JSON.parse(jsonTopics.value), bridges: JSON.parse(bridgeEditor.value), bindings: bindings.map(row => ({ providerId: row.select.value, contract: row.contract })) };
    const result = await api('/api/programs/preview', body);
    review({ title: say('审阅模块登记', 'Review module registration'), data: result.review, message: say('登记会复制已审阅的模块源码并创建独立身份和状态目录。不会启动程序；启动前另行审阅执行。', 'Registration copies reviewed source and creates an independent identity and state directory. It does not execute the program. Execution requires a separate start review.'), apply: async () => {
      await api('/api/programs/register', { reviewId: result.reviewId, accepted: true });
      recordApproved(id.value.trim(), result.review?.digest);
      node.close(); await refresh(); navigate('programs');
    } });
  }), 'button button-primary'); node.append(actions([submit]));
}
const approvedKey = id => `world-hub.approved-start.${id}`;
function getApproved(id) { try { return JSON.parse(localStorage.getItem(approvedKey(id)) || 'null'); } catch { return null; } }
export function recordApproved(id, digest) { if (!digest) return; try { localStorage.setItem(approvedKey(id), JSON.stringify({ digest, time: Date.now() })); } catch {} }

async function startProgram(program, forceReview = false) {
  const result = await api(`/api/programs/${encodeURIComponent(program.programId)}/review`, {});
  const approved = getApproved(program.programId);
  const isIdentical = approved && approved.digest === result.review.digest;
  if (isIdentical && !forceReview) {
    toast(say(`正在启动模块 ${title(program)}…`, `Starting ${title(program)}…`));
    await operation(await api(`/api/programs/${encodeURIComponent(program.programId)}/start`, { reviewId: result.reviewId, accepted: true }));
    await refresh();
    return;
  }
  const isFirst = !approved;
  const reviewMessage = isFirst
    ? say('首次启动此模块，连接世界枢纽。请核对源码、解释器与通信权限。后续未发生变动时将直接启动。', 'First start for this module, connecting to World Hub. Check source, runtime and communication permissions. Future starts without changes will launch directly.')
    : say('⚠️ 检测到模块配置、源码或环境发生更新（与上次运行不同）。请审阅变更后启动：', '⚠️ Changes detected in module configuration or source since last run. Review changes to start:');
  review({
    title: isFirst ? say('首次启动审阅', 'Review and start module') : say('检测到变更 · 审阅启动', 'Review and start module'),
    data: result.review,
    message: reviewMessage,
    apply: async () => {
      recordApproved(program.programId, result.review.digest);
      await operation(await api(`/api/programs/${encodeURIComponent(program.programId)}/start`, { reviewId: result.reviewId, accepted: true }));
    }
  });
}
async function stopProgram(program) {
  const sharing = state.groups.filter(group => group.memberProgramIds.includes(program.programId)), consumers = state.programs.filter(row => row.bindings.some(binding => binding.providerId === program.programId));
  confirm({ title: say('停止模块实例', 'Stop module instance'), message: `${program.programId}\n${say('引用此实例的组', 'Groups referencing this instance')}: ${sharing.map(group => title(group)).join(', ') || '—'}\n${say('依赖此实例的消费者', 'Consumers depending on this instance')}: ${consumers.map(row => row.programId).join(', ') || '—'}`, action: async () => { await operation(await api(`/api/programs/${encodeURIComponent(program.programId)}/stop`, {})); await refresh(); if (state.view === 'workbench') renderView(); }, danger: true });
}
async function logs(program) { const result = await api(`/api/programs/${encodeURIComponent(program.programId)}/logs`); dialog(`${title(program)} · ${say('日志', 'Logs')}`, [el('pre', { class: 'sh-log' }, `stdout\n${result.logs.stdout ?? ''}\n\nstderr\n${result.logs.stderr ?? ''}`), result.logs.truncated ? info(say('仅显示有界日志尾部。', 'Only the bounded log tail is shown.')) : null].filter(Boolean)); }
const expandedPrograms = new Set();

function programCard(row) {
  const groups = state.groups.filter(group => group.memberProgramIds.includes(row.programId));
  const isRunning = row.state === 'running' && isLive();
  const bridgeEntries = Object.entries(row.bridges ?? {});
  const topicCount = Object.keys(row.topics ?? {}).length;
  const providesCount = (row.provides ?? []).length;
  const requiresCount = (row.requires ?? row.manifest?.requires ?? []).length;

  const isExpanded = expandedPrograms.has(row.programId);

  const chips = [];
  if (topicCount > 0) chips.push(el('span', { class: 'sh-spec-chip' }, `${topicCount} ${say('通道', 'topics')}`));
  if (bridgeEntries.length > 0) chips.push(el('span', { class: 'sh-spec-chip' }, `${bridgeEntries.length} ${say('桥槽', 'bridge slots')}`));
  if (providesCount > 0) chips.push(el('span', { class: 'sh-spec-chip' }, `${say('提供能力', 'provides')}: ${providesCount}`));
  if (requiresCount > 0) chips.push(el('span', { class: 'sh-spec-chip' }, `${say('依赖能力', 'requires')}: ${requiresCount}`));

  const chevron = el('span', { class: 'sh-program-chevron' }, isExpanded ? '▾' : '▸');
  const avatar = createModuleAvatar(row, 28);
  const titleText = el('h3', { class: 'sh-program-title' }, title(row));
  const idBadge = el('span', { class: 'mono sh-program-id' }, row.programId);
  const versionBadge = el('span', { class: 'sh-meta-tag mono sh-program-ver' }, `${row.module.id}@${row.module.version}`);
  const groupBadge = groups.length
    ? el('span', { class: 'sh-meta-tag sh-tag-accent sh-program-group-tag' }, `${say('组', 'Group')}: ${groups.map(title).join(', ')}`)
    : el('span', { class: 'sh-meta-tag subtle sh-program-group-tag' }, say('未分组', 'Ungrouped'));
  const statePill = pill(isLive() ? programState(row) : say('状态过期', 'Stale state'), isRunning ? 'teal' : '');

  const residentPill = pill(say('常驻受管', 'Managed'), 'neutral');
  const rowMain = el('div', { class: 'sh-program-row-main' }, [
    chevron,
    avatar,
    titleText,
    idBadge,
    versionBadge,
    groupBadge,
    residentPill,
    statePill
  ]);

  const detailToggleBtn = button(
    isExpanded ? say('收起 ▴', 'Collapse ▴') : say('详情 ▾', 'Details ▾'),
    () => toggle(),
    'button button-quiet sh-program-detail-toggle'
  );

  const rowActions = actions([
    isRunning
      ? button(say('停止…', 'Stop…'), () => stopProgram(row), 'button button-quiet', !isLive())
      : button(say('启动', 'Start'), () => startProgram(row), 'button button-primary', !isLive() || ['starting', 'stopping', 'unknown'].includes(row.state)),
    button(say('参数与接线', 'Configure & wire'), () => openWorkbench('configuration', row.programId), 'button button-quiet'),
    detailToggleBtn
  ]);
  rowActions.className = 'sh-program-row-actions result-actions';

  const rowEl = el('div', {
    class: 'sh-program-row',
    role: 'button',
    tabindex: '0',
    'aria-expanded': String(isExpanded)
  }, [rowMain, rowActions]);

  const detailEl = el('div', { class: 'sh-program-card-detail' }, [
    el('div', { class: 'sh-card-meta' }, [
      el('span', { class: 'sh-meta-tag mono' }, `${row.module.id}@${row.module.version}`),
      el('span', { class: 'sh-meta-tag' }, say('可信本机执行', 'Trusted Local')),
      row.sourceDirectory ? el('span', { class: 'sh-meta-tag mono' }, `${say('源码', 'Source')}: ${row.sourceDirectory}`) : null,
      groups.length
        ? el('span', { class: 'sh-meta-tag sh-tag-accent' }, `${say('引用组', 'Group')}: ${groups.map(title).join(', ')}`)
        : el('span', { class: 'sh-meta-tag subtle' }, say('未分组', 'Ungrouped'))
    ].filter(Boolean)),
    chips.length ? el('div', { class: 'sh-spec-chips' }, chips) : null,
    row.error ? el('p', { class: 'notice notice-error' }, row.error.message) : null,
    actions([
      safeLink(say('打开界面 ↗', 'Open interface'), row.entryUrl),
      button(say('新建实例', 'New instance'), () => registerModule(row.sourceDirectory), 'button button-quiet'),
      button(say('日志', 'Logs'), () => logs(row), 'button button-quiet'),
      button(say('移除登记', 'Unregister'), () => confirm({
        title: say('移除模块登记', 'Unregister module'),
        message: say('仅已停止且未被组引用的实例可移除。私有状态目录保留，消费者绑定需先调整。', 'Only stopped instances without group references can be removed. Private state is retained; adjust consumer bindings first.'),
        action: async () => { await api(`/api/programs/${encodeURIComponent(row.programId)}/remove`, {}); await refresh(); },
        danger: true
      }), 'button button-quiet', !isLive() || row.state === 'running')
    ]),
    details(say('通信声明与来源详情', 'Communication declaration and source'), {
      source: row.sourceDirectory,
      principal: row.principal,
      revision: row.configurationRevision,
      topics: row.topics,
      bridges: row.bridges,
      bindings: row.bindings,
      groups: groups.map(group => group.id)
    })
  ]);

  const card = el('article', {
    class: `panel sh-program-card ${isExpanded ? 'is-expanded' : 'is-compact'}`,
    'data-program-id': row.programId
  }, [
    rowEl,
    detailEl
  ]);

  function toggle() {
    if (expandedPrograms.has(row.programId)) {
      expandedPrograms.delete(row.programId);
    } else {
      expandedPrograms.add(row.programId);
    }
    const next = expandedPrograms.has(row.programId);
    card.className = `panel sh-program-card ${next ? 'is-expanded' : 'is-compact'}`;
    rowEl.setAttribute('aria-expanded', String(next));
    chevron.textContent = next ? '▾' : '▸';
    detailToggleBtn.textContent = next ? say('收起 ▴', 'Collapse ▴') : say('详情 ▾', 'Details ▾');
  }

  rowEl.addEventListener('click', (e) => {
    if (e.target?.closest?.('button, a, input, select, textarea')) return;
    toggle();
  });
  rowEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target?.closest?.('button, a, input, select, textarea')) return;
      e.preventDefault();
      toggle();
    }
  });

  return card;
}
const collapsedFolders = new Set();
let moduleViewMode = 'folders';

function isFolderExpanded(id) {
  return !collapsedFolders.has(id);
}

function toggleFolder(id) {
  if (collapsedFolders.has(id)) collapsedFolders.delete(id);
  else collapsedFolders.add(id);
  renderView();
}

function groupFolder(group, memberRows) {
  const isExpanded = isFolderExpanded(group.id);
  const selectedCount = group.startupPlan?.members?.filter(row => row.enabled)?.length ?? 0;

  const chevron = el('span', { class: 'sh-folder-chevron' }, isExpanded ? '▾' : '▸');
  const icon = el('span', { class: 'sh-folder-icon' }, '📁');
  const titleNode = el('h2', { class: 'sh-folder-title' }, title(group));
  const idNode = el('p', { class: 'mono sh-folder-id' }, group.id);
  const countTag = el('span', { class: 'sh-spec-chip' }, `${memberRows.length} ${say('个模块', 'modules')}`);
  const planTag = el('span', { class: 'sh-spec-chip' }, `${say('计划选中', 'Selected for startup')}: ${selectedCount}/${group.memberProgramIds.length}`);

  const headerLeft = el('div', { class: 'sh-folder-info', role: 'button', 'aria-expanded': String(isExpanded), tabindex: '0' }, [
    chevron, icon, titleNode, idNode, countTag, planTag
  ]);
  headerLeft.addEventListener('click', () => toggleFolder(group.id));
  headerLeft.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder(group.id); } });

  const headerActions = actions([
    button(say('启动组', 'Review & start'), () => startPlan(group), 'button button-primary', !isLive()),
    button(say('停止组…', 'Stop group…'), () => stopGroup(group), 'button button-quiet', !isLive()),
    button(say('编辑成员', 'Edit members'), () => editGroup(group), 'button button-quiet'),
    button(say('启动计划', 'Startup plan'), () => openWorkbench('group', group.id), 'button button-quiet'),
    button(say('删除组', 'Delete group'), () => confirm({
      title: say('删除组引用', 'Delete group references'),
      message: say('只删除分组，不停止、不移除任何实例。', 'Delete only the group. All instances remain registered and keep running.'),
      action: async () => { await api(`/api/groups/${encodeURIComponent(group.id)}/remove`, { expectedRevision: group.revision }); await refresh(); }
    }), 'button button-quiet')
  ]);

  const head = el('header', { class: 'sh-folder-head' }, [headerLeft, headerActions]);

  const bodyChildren = [];
  if (isExpanded) {
    if (memberRows.length) {
      bodyChildren.push(el('div', { class: 'sh-card-grid sh-folder-grid' }, memberRows.map(programCard)));
    } else {
      bodyChildren.push(el('div', { class: 'sh-folder-empty' }, [
        info(say('该文件夹暂无模块，点击“编辑成员”勾选已有模块。', 'No members in this folder yet. Click "Edit members" to add modules.')),
        button(say('添加模块到组', 'Add modules to group'), () => editGroup(group), 'button button-quiet')
      ]));
    }
  }

  return el('article', { class: `panel sh-folder-panel sh-group-card${isExpanded ? ' is-open' : ' is-collapsed'}`, 'data-group-id': group.id }, [
    head,
    isExpanded ? el('div', { class: 'sh-folder-body' }, bodyChildren) : null
  ].filter(Boolean));
}

function ungroupedFolder(programs) {
  const isExpanded = isFolderExpanded('__ungrouped__');
  const chevron = el('span', { class: 'sh-folder-chevron' }, isExpanded ? '▾' : '▸');
  const icon = el('span', { class: 'sh-folder-icon' }, '📂');
  const titleNode = el('h2', { class: 'sh-folder-title' }, say('未分组模块', 'Ungrouped Modules'));
  const countTag = el('span', { class: 'sh-spec-chip' }, `${programs.length} ${say('个独立模块', 'standalone modules')}`);
  const hint = el('span', { class: 'subtle small' }, say('尚未归入任何模块组', 'Not assigned to any module group'));

  const headerLeft = el('div', { class: 'sh-folder-info', role: 'button', 'aria-expanded': String(isExpanded), tabindex: '0' }, [
    chevron, icon, titleNode, countTag, hint
  ]);
  headerLeft.addEventListener('click', () => toggleFolder('__ungrouped__'));
  headerLeft.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder('__ungrouped__'); } });

  const headerActions = actions([
    button(say('新建模块组归类', 'Create group for these'), () => editGroup(), 'button button-quiet')
  ]);

  const head = el('header', { class: 'sh-folder-head sh-ungrouped-head' }, [headerLeft, headerActions]);

  const bodyChildren = [];
  if (isExpanded) {
    bodyChildren.push(el('div', { class: 'sh-card-grid sh-folder-grid' }, programs.map(programCard)));
  }

  return el('article', { class: `panel sh-folder-panel sh-ungrouped-panel${isExpanded ? ' is-open' : ' is-collapsed'}` }, [
    head,
    isExpanded ? el('div', { class: 'sh-folder-body' }, bodyChildren) : null
  ].filter(Boolean));
}

let moduleCategory = 'all';

function openExternalAuthorize() {
  if (!isLive()) {
    error(new Error(say('请先启动世界枢纽，再授权临时接入。', 'Start World Hub first before authorizing external programs.')));
    return;
  }
  const programId = input('externalProgramId', '', { placeholder: say('例如: python-client', 'e.g. python-client') });
  const displayName = input('externalTitle', '', { placeholder: say('可选显示名称', 'Optional display name') });
  const publish = input('publishTopics', '', { placeholder: say('例如: data/metrics, events/in', 'e.g. data/metrics, events/in') });
  const subscribe = input('subscribeTopics', '', { placeholder: say('例如: commands/out', 'e.g. commands/out') });

  const parseTopics = str => [...new Set((str || '').split(/[\n,]/).map(p => p.trim()).filter(Boolean))];

  const node = dialog(say('授权外部程序接入', 'Authorize external program'), [
    el('p', { class: 'field-help' }, say(
      '为外部 Python/Node.js 或第三方自管理程序签发本轮通信凭据。权限按身份汇总，程序由外部自行运行管理。',
      'Issue credentials for this Hub run to an external program or script. The external process manages itself.'
    )),
    field(say('外部程序标识 (ID)', 'External program ID'), programId),
    field(say('显示名称', 'Display name'), displayName),
    field(say('允许发送的通道（逗号分隔）', 'Publish topics (comma separated)'), publish),
    field(say('允许抽取的通道（逗号分隔）', 'Subscribe topics (comma separated)'), subscribe),
    actions([
      button(say('取消', 'Cancel'), () => node.close(), 'button button-quiet'),
      button(say('预览并授权', 'Preview & authorize'), () => run(async () => {
        const id = programId.value.trim();
        if (!id) throw new Error(say('请提供外部程序标识。', 'Provide an external program ID.'));
        const reviewedRun = state.externalInventory?.runId;
        const result = await api('/api/programs/external/preview', {
          action: 'admit',
          programId: id,
          ...(displayName.value.trim() ? { title: displayName.value.trim() } : {}),
          expectedRunId: reviewedRun,
          expectedRevision: state.externalInventory?.revision,
          bridges: [{
            slot: 'main',
            publish: parseTopics(publish.value),
            subscribe: parseTopics(subscribe.value)
          }]
        });
        node.close();
        review({
          title: say('确认外部程序接入授权', 'Confirm external program authorization'),
          data: result.review ?? result.preview,
          message: say('本次凭据只在当前 Hub 运行期间有效。授权后请妥善保管连接配置。', 'Credentials are valid for this Hub run only.'),
          apply: async () => {
            const applied = await api('/api/programs/external/apply', { reviewId: result.reviewId, accepted: true });
            await refresh();
            const conn = applied?.connection ?? applied?.connectionConfig;
            if (conn) {
              const configText = JSON.stringify(conn, null, 2);
              dialog(say('新签发的连接配置凭据', 'New connection configuration'), [
                el('p', { class: 'notice notice-success' }, say('授权成功！请将以下连接配置传给外部程序。关闭后不再显示私钥。', 'Authorized! Provide this connection configuration to the external program. It will not be shown again.')),
                el('pre', { class: 'review-digest' }, configText),
                actions([button(say('复制并关闭', 'Copy & close'), async () => {
                  try { await navigator.clipboard.writeText(configText); } catch {}
                  toast(say('已复制到剪贴板。', 'Copied to clipboard.'));
                }, 'button button-primary')])
              ]);
            } else {
              toast(say('外部接入授权已签发。', 'External program authorized.'));
            }
          }
        });
      }), 'button button-primary')
    ])
  ]);
}

function externalProgramCard(program) {
  const connections = (state.externalInventory?.observedSessions ?? []).filter(s => s.principal === program.principal || (program.connections ?? []).some(c => c.connectionId === s.connectionId));
  const activeCount = connections.length;
  const isExpanded = expandedCards.has(`ext:${program.programId}`);
  const chevron = el('span', { class: 'sh-program-chevron' }, isExpanded ? '▾' : '▸');
  const avatar = el('div', { class: 'sh-program-avatar' }, '⚡');
  const titleText = el('span', { class: 'sh-program-name' }, title(program));
  const idBadge = el('span', { class: 'sh-program-id mono' }, program.programId);
  const typePill = pill(say('临时接入', 'Ephemeral'), 'warning');
  const selfPill = pill(say('进程自管', 'Self-managed'), 'neutral');
  const statePill = activeCount ? pill(say(`${activeCount} 个连接`, `${activeCount} active`), 'teal') : pill(say('未连接', 'Disconnected'), '');

  const rowMain = el('div', { class: 'sh-program-row-main' }, [
    chevron,
    avatar,
    titleText,
    idBadge,
    typePill,
    selfPill,
    statePill
  ]);

  const detailToggleBtn = button(
    isExpanded ? say('收起 ▴', 'Collapse ▴') : say('连接与权限 ▾', 'Connections ▾'),
    () => {
      if (isExpanded) expandedCards.delete(`ext:${program.programId}`);
      else expandedCards.add(`ext:${program.programId}`);
      renderView();
    },
    'button button-quiet sh-program-detail-toggle'
  );

  const rowActions = actions([
    button(say('撤销授权', 'Revoke'), () => run(async () => {
      const reviewedRun = state.externalInventory?.runId;
      const result = await api('/api/programs/external/preview', { action: 'revoke', programId: program.programId, expectedRunId: reviewedRun, expectedRevision: state.externalInventory?.revision });
      review({
        title: say('撤销外部程序授权', 'Revoke external program authorization'),
        data: result.review ?? result.preview,
        message: say('撤销将关闭该外部程序的所有连接并吊销本轮通信权限。', 'Revoking closes all connections and cancels communication rights for this Hub run.'),
        apply: async () => {
          await api('/api/programs/external/apply', { reviewId: result.reviewId, accepted: true });
          await refresh();
          toast(say('外部授权已撤销。', 'External authorization revoked.'));
        }
      });
    }), 'button button-quiet'),
    detailToggleBtn
  ]);
  rowActions.className = 'sh-program-row-actions result-actions';

  const rowEl = el('div', {
    class: 'sh-program-row',
    role: 'button',
    tabindex: '0',
    'aria-expanded': String(isExpanded)
  }, [rowMain, rowActions]);
  rowMain.addEventListener('click', () => {
    if (isExpanded) expandedCards.delete(`ext:${program.programId}`);
    else expandedCards.add(`ext:${program.programId}`);
    renderView();
  });

  const detailEl = el('div', { class: 'sh-program-card-detail' }, [
    el('div', { class: 'sh-card-meta' }, [
      el('span', { class: 'sh-meta-tag' }, say('外部自运行程序', 'Externally run')),
      el('span', { class: 'sh-meta-tag' }, say('凭据仅限本轮 Hub 有效', 'Current run credentials')),
      el('span', { class: 'sh-meta-tag mono' }, `${say('主体标识', 'Principal')}: ${program.principal ?? '—'}`)
    ]),
    details(say('桥槽声明与有效授权', 'Slot declarations and effective grants'), { bridges: program.bridges, effectiveAllow: program.effectiveAllow, principal: program.principal }),
    connections.length
      ? el('div', { class: 'sh-spec-chips' }, connections.map(s => el('div', { class: 'sh-spec-chip' }, [
          el('span', {}, `${s.declaredId ?? 'bridge'} · ${s.remoteAddress ?? '127.0.0.1'} (${say('已发', 'Sent')} ${s.published ?? 0} / ${say('已收', 'Recv')} ${s.delivered ?? 0})`),
          s.connectionId ? button(say('断开', 'Disconnect'), () => run(async () => {
            const reviewedRun = state.externalInventory?.runId;
            const res = await api('/api/programs/external/preview', { action: 'disconnect', principal: s.principal ?? program.principal, connectionIds: [s.connectionId], expectedRunId: reviewedRun, expectedRevision: state.externalInventory?.revision });
            review({
              title: say('断开连接', 'Disconnect connection'),
              data: res.review ?? res.preview,
              message: say('确认断开该连接？外部程序可使用原凭据重新连接。', 'Disconnect this session? The program may reconnect with its credentials.'),
              apply: async () => {
                await api('/api/programs/external/apply', { reviewId: res.reviewId, accepted: true });
                await refresh();
                toast(say('已断开连接。', 'Connection disconnected.'));
              }
            });
          }), 'button button-quiet') : null
        ].filter(Boolean))))
      : info(say('当前没有活跃连接。使用此程序的主体凭证接入世界枢纽后将在此显示。', 'No active connections. Connections appear here once the program authenticates.'))
  ]);

  return el('article', { class: `panel sh-program-card sh-external-card${isExpanded ? ' is-expanded' : ' is-collapsed'}` }, [
    rowEl,
    isExpanded ? detailEl : null
  ].filter(Boolean));
}

function programs() {
  const content = el('div', { class: 'sh-programs-container' });
  const viewToolbar = el('div', { class: 'sh-view-toolbar' });
  const filter = input('programSearch', '', { type: 'search', 'aria-label': say('搜索模块实例', 'Search module instances'), placeholder: say('搜索名称或实例标识', 'Search names or instance IDs') });
  filter.value = state.programSearch ?? '';

  let drawContent;

  const drawToolbar = () => {
    const categoryToggle = el('div', { class: 'sh-category-toggle' }, [
      button([el('span', {}, say('全部', 'All')), el('small', { class: 'pill-count' }, String(state.programs.length + (state.externalInventory?.programs?.length ?? 0)))], () => { moduleCategory = 'all'; draw(); }, `button button-quiet${moduleCategory === 'all' ? ' is-active' : ''}`),
      button([el('span', {}, say('📁 常驻受管', '📁 Resident')), el('small', { class: 'pill-count' }, String(state.programs.length))], () => { moduleCategory = 'resident'; draw(); }, `button button-quiet${moduleCategory === 'resident' ? ' is-active' : ''}`),
      button([el('span', {}, say('⚡ 临时接入', '⚡ Ephemeral')), el('small', { class: 'pill-count' }, String(state.externalInventory?.programs?.length ?? 0))], () => { moduleCategory = 'ephemeral'; draw(); }, `button button-quiet${moduleCategory === 'ephemeral' ? ' is-active' : ''}`)
    ]);

    const modeToggle = state.groups.length && moduleCategory !== 'ephemeral' ? el('div', { class: 'sh-view-mode-toggle' }, [
      button([el('span', {}, '📁 '), el('span', {}, say('按文件夹折叠', 'Folders'))], () => { moduleViewMode = 'folders'; draw(); }, `button button-quiet${moduleViewMode === 'folders' ? ' is-active' : ''}`),
      button([el('span', {}, '▦ '), el('span', {}, say('平铺所有', 'Flat Grid'))], () => { moduleViewMode = 'flat'; draw(); }, `button button-quiet${moduleViewMode === 'flat' ? ' is-active' : ''}`),
      moduleViewMode === 'folders' ? button(say('全部展开', 'Expand all'), () => { collapsedFolders.clear(); drawContent(); }, 'button button-quiet') : null,
      moduleViewMode === 'folders' ? button(say('全部折叠', 'Collapse all'), () => { for (const g of state.groups) collapsedFolders.add(g.id); collapsedFolders.add('__ungrouped__'); drawContent(); }, 'button button-quiet') : null
    ].filter(Boolean)) : null;

    const toolbarActions = el('div', { class: 'sh-page-heading sh-toolbar-actions' }, [
      button(say('接入本地模块', 'Connect local module'), () => importAndConnectModule(), 'button button-primary'),
      button(say('新建模块组', 'New module group'), () => editGroup(), 'button button-quiet'),
      button(say('授权临时接入', 'Authorize external'), openExternalAuthorize, 'button button-quiet')
    ]);

    const row1 = el('div', { class: 'sh-toolbar-row sh-toolbar-row-primary' }, [
      field(say('筛选实例', 'Filter instances'), filter),
      categoryToggle
    ]);
    const row2 = el('div', { class: 'sh-toolbar-row sh-toolbar-row-secondary' }, [
      toolbarActions,
      modeToggle
    ].filter(Boolean));

    viewToolbar.replaceChildren(row1, row2);
  };

  drawContent = () => {
    state.programSearch = filter.value;
    const query = filter.value.toLowerCase().trim();
    const matchesQuery = row => `${title(row)} ${row.programId} ${row.module?.id ?? ''}`.toLowerCase().includes(query);
    const filteredPrograms = state.programs.filter(matchesQuery);
    const externalList = (state.externalInventory?.programs ?? []).filter(matchesQuery);

    if (moduleCategory === 'ephemeral') {
      if (!isLive()) {
        content.replaceChildren(
          el('div', { class: 'notice notice-warning' }, [
            info(say('世界枢纽当前未运行。启动世界枢纽后可接入外部临时程序并观察通信。', 'World Hub is stopped. Start World Hub to authorize external ephemeral programs.'))
          ]),
          empty(say('世界枢纽已停止。', 'World Hub is stopped.'))
        );
        return;
      }
      if (!externalList.length) {
        content.replaceChildren(empty(
          say('当前没有临时接入的外部程序。可为外部 Python/Node.js 脚本或第三方程序签发通信凭据。', 'No external programs authorized in this run. You can issue credentials for external scripts.'),
          say('授权外部程序接入', 'Authorize external program'),
          () => openExternalAuthorize()
        ));
        return;
      }
      content.replaceChildren(el('div', { class: 'sh-card-grid' }, externalList.map(externalProgramCard)));
      return;
    }

    const residentNodes = [];
    if (!state.programs.length && moduleCategory === 'resident') {
      content.replaceChildren(empty(
        say('暂无常驻受管模块。可从本地接入模块或从在线获取。', 'No resident managed modules. Connect a local module or get online.'),
        say('从本地接入模块', 'Connect module from local'),
        () => importAndConnectModule()
      ));
      return;
    }

    if (moduleViewMode === 'flat' || !state.groups.length) {
      const flatGrid = el('div', { class: 'sh-card-grid' });
      if (filteredPrograms.length) {
        flatGrid.replaceChildren(...filteredPrograms.map(programCard));
      } else if (state.programs.length) {
        flatGrid.replaceChildren(empty(say('暂无匹配的模块实例。', 'No matching module instances.')));
      }
      residentNodes.push(flatGrid);
    } else {
      const folderNodes = [];
      for (const group of state.groups) {
        const memberRows = state.programs
          .filter(row => group.memberProgramIds.includes(row.programId))
          .filter(matchesQuery);
        const groupMatches = title(group).toLowerCase().includes(query) || group.id.toLowerCase().includes(query);
        if (query && !groupMatches && !memberRows.length) continue;
        folderNodes.push(groupFolder(group, memberRows));
      }

      const ungrouped = state.programs
        .filter(row => !state.groups.some(group => group.memberProgramIds.includes(row.programId)))
        .filter(matchesQuery);
      if (ungrouped.length) {
        folderNodes.push(ungroupedFolder(ungrouped));
      }

      if (!folderNodes.length && state.programs.length) {
        residentNodes.push(empty(say('暂无匹配的分组或模块实例。', 'No matching groups or module instances.')));
      } else {
        residentNodes.push(...folderNodes);
      }
    }

    const allNodes = [...residentNodes];
    if (moduleCategory === 'all' && externalList.length) {
      allNodes.push(el('section', { class: 'sh-external-section' }, [
        el('div', { class: 'sh-section-header' }, [
          el('div', {}, [
            el('h3', {}, say('⚡ 外部临时接入（本轮有效）', '⚡ External Ephemeral Access (Current Run)')),
            info(say('外部独立程序按需通过通信 Token 连入世界枢纽，Launcher 不托管其进程。', 'External self-managed programs connect via communication token without process adoption.'))
          ]),
          button(say('授权外部程序接入', 'Authorize external program'), openExternalAuthorize, 'button button-quiet')
        ]),
        el('div', { class: 'sh-card-grid' }, externalList.map(externalProgramCard))
      ]));
    }

    if (!allNodes.length) {
      content.replaceChildren(empty(
        say('暂无接入模块。可接入本地模块或在线获取模块。', 'No connected modules. Connect a local module or get modules online.'),
        say('从本地接入模块', 'Connect module from local'),
        () => importAndConnectModule()
      ));
    } else {
      content.replaceChildren(...allNodes);
    }
  };

  const draw = () => {
    drawToolbar();
    drawContent();
  };

  filter.addEventListener('input', () => { drawContent(); });
  draw();

  return [
    viewToolbar,
    content
  ];
}
async function startPlan(group) {
  const result = group ? await api(`/api/groups/${encodeURIComponent(group.id)}/start/preview`, { expectedRevision: group.revision }) : await api('/api/programs/startup-plan/review', {});
  review({ title: group ? `${title(group)} · ${say('启动计划', 'Startup plan')}` : say('全局启动计划', 'Global startup plan'), data: result.review, message: say('只启动已勾选成员，遵循精确顺序与前置关系。已运行的共享实例不会重复启动，计划外模块不受影响。', 'Start only selected members in the exact order and prerequisites. Running shared instances are reused. Other modules remain unaffected.'), apply: async () => operation(await api(group ? `/api/groups/${encodeURIComponent(group.id)}/start/apply` : '/api/programs/startup-plan/start', { reviewId: result.reviewId, accepted: true })) });
}
function editGroup(group) {
  const id = input('groupId', group?.id ?? '', { disabled: Boolean(group), placeholder: 'my-group' }), label = input('groupTitle', group?.title ?? ''), members = new Set(group?.memberProgramIds ?? []);
  const node = dialog(group ? say('编辑模块组', 'Edit module group') : say('新建模块组', 'New module group'), [field(say('组标识', 'Group ID'), id), field(say('组名称', 'Group name'), label), info(say('勾选已有实例；加入组不复制模块、不启动进程、不增加权限。', 'Select existing instances. Joining a group does not copy modules, start processes or grant permissions.')),
    el('div', { class: 'sh-group-members' }, state.programs.map(program => { const check = input(program.programId, '', { type: 'checkbox', checked: members.has(program.programId) }); check.addEventListener('change', () => { if (check.checked) members.add(program.programId); else members.delete(program.programId); }); return el('label', { class: 'sh-check' }, [check, el('span', {}, `${title(program)} · ${program.programId}`)]); }))]);
  node.append(actions([button(say('保存引用', 'Save references'), () => run(async () => {
    const selected = [...members], oldPlan = group?.startupPlan;
    const plan = { format: 'world-hub.launcher-startup-plan/v1', onFailure: oldPlan?.onFailure ?? 'continue-independent', members: selected.map(programId => { const old = oldPlan?.members.find(row => row.programId === programId); return { programId, enabled: old?.enabled ?? false, after: (old?.after ?? []).filter(other => members.has(other)) }; }), startupOrder: [...(oldPlan?.startupOrder ?? []).filter(programId => members.has(programId)), ...selected.filter(programId => !oldPlan?.startupOrder?.includes(programId))] };
    await api('/api/groups/save', { group: { id: id.value.trim(), title: label.value.trim(), memberProgramIds: selected, startupPlan: plan }, ...(group ? { expectedRevision: group.revision } : {}) }); node.close(); await refresh();
  }), 'button button-primary')]));
}
async function stopGroup(group) {
  const result = await api(`/api/groups/${encodeURIComponent(group.id)}/stop/preview`, { expectedRevision: group.revision });
  const selected = new Set(result.review.programs.filter(row => row.ownsProcess && !row.sharedWithGroups.length).map(row => row.programId));
  const choices = el('section', {}, result.review.programs.map(row => { const check = input(`stop-${row.programId}`, '', { type: 'checkbox', checked: selected.has(row.programId) }); check.addEventListener('change', () => { if (check.checked) selected.add(row.programId); else selected.delete(row.programId); }); return el('label', { class: 'sh-check' }, [check, el('span', {}, `${row.programId}${row.sharedWithGroups.length ? ` · ${say('其他引用组', 'Other groups')}: ${row.sharedWithGroups.map(title).join(', ')}` : ''}`)]); }));
  review({ title: say('审阅停止模块组', 'Review stopping module group'), data: result.review, extra: choices, message: say('勾选要停止的具体实例。共享成员默认保留运行，停止会影响其他引用组与消费者；Hub 保持运行。', 'Select the exact instances to stop. Shared members remain running by default. Stopping them affects other groups and consumers. The Hub remains running.'), apply: async () => operation(await api(`/api/groups/${encodeURIComponent(group.id)}/stop/apply`, { reviewId: result.reviewId, accepted: true, programIds: [...selected] })) });
}
function openWorkbench(mode = 'configuration', id) { workbench.open(mode, id); navigate('workbench'); }

async function inspectSource(id = state.sourceId) {
  const selected = state.sources.find(row => row.id === id); if (!selected) return;
  try { const result = await api('/api/sources/inspect', { sourceId: selected.id }); state.sourceId = id; state.sourceIndex = result; state.sourceError = null; }
  catch (issue) { state.sourceError = issue.message; }
  if (state.view === 'sources') renderView();
}
async function fetchModule(entry) {
  const observed = state.sourceIndex;
  review({
    title: observed.offline ? say('检查缓存制品并接入', 'Inspect cached artifact & connect') : say('审阅模块下载并接入', 'Review module download & connect'),
    data: { title: title(entry), entryId: entry.entryId, version: entry.version, license: entry.license, sha256: entry.sha256, sourceId: observed.sourceId, source: observed.source },
    message: observed.offline
      ? say('来源不可用。本次仅请求后端重新核验已有缓存的完整性，核验后将直接引导接入世界枢纽。', 'The source is unavailable. Rechecking existing cache integrity before guiding connection to World Hub.')
      : say('下载并核验模块制品到本机缓存，核验后将直接引导接入世界枢纽。', 'Download and verify module into local cache, then directly guide connection to World Hub.'),
    apply: async () => {
      const fresh = await api('/api/sources/inspect', { sourceId: observed.sourceId }), current = fresh.index.entries.find(row => sameSourceArtifact(entry, row));
      if (!current || !canAcquireSourceModule(fresh, current)) throw new Error(say('来源制品已改变或没有可核验缓存，请重新选择并审阅。', 'The source artifact changed or no cache is available for verification. Select and review again.'));
      const result = await operation(await api('/api/sources/fetch', sourceFetchInput(fresh, current)));
      state.sourceIndex = fresh; state.sourceError = null;
      await refresh();
      toast(say('模块已下载，正在准备接入…', 'Module downloaded, preparing connection…'));
      if (result.directory) {
        await registerModule(result.directory);
      }
      return result;
    }
  });
}
function addSource() {
  const name = input('sourceName'), source = input('source', '', { 'data-path-purpose': 'source' }), pin = input('expectedSha256'), privateNetwork = input('privateNetwork', '', { type: 'checkbox' });
  const node = dialog(say('添加下载源', 'Add download source'), [field(say('名称', 'Name'), name), field(say('索引地址或本机索引文件', 'Index URL or local index file'), source), field(say('索引 SHA-256（可选）', 'Index SHA-256 (optional)'), pin), el('label', { class: 'sh-check' }, [privateNetwork, el('span', {}, say('信任此来源的私网或 DNS 代理连接', 'Trust private network or DNS proxy connections for this source'))])]);
  node.append(actions([button(say('保存来源', 'Save source'), () => run(async () => { const result = await api('/api/sources/save', { name: name.value.trim(), source: source.value.trim(), enabled: true, priority: 0, allowPrivateNetwork: privateNetwork.checked, ...(pin.value.trim() ? { expectedSha256: pin.value.trim() } : {}) }); node.close(); await refresh(); await inspectSource(result.source?.id ?? state.sources.at(-1)?.id); }), 'button button-primary')]));
}
function sources() {
  const selector = el('select', { 'aria-label': say('下载来源', 'Download source') }, [el('option', { value: '' }, say('选择来源', 'Choose a source')), ...state.sources.map(row => el('option', { value: row.id, disabled: row.enabled === false }, row.name))]); selector.value = state.sourceId ?? ''; selector.addEventListener('change', () => { state.sourceIndex = null; state.sourceError = null; state.sourceId = selector.value; void run(() => inspectSource()); });
  const entries = (state.sourceIndex?.index?.entries ?? []).filter(row => row.kind === 'module').map(row => ({ ...row, sourceId: state.sourceIndex.sourceId, source: state.sourceIndex.source, indexDigest: state.sourceIndex.digest }));
  return [
    el('section', { class: 'panel' }, [
      field(say('下载来源', 'Download source'), selector),
      actions([
        button(say('刷新索引', 'Refresh index'), () => inspectSource(), 'button button-primary', !state.sourceId),
        button(say('管理来源', 'Manage sources'), manageSources, 'button button-quiet'),
        button(say('添加下载源', 'Add source'), addSource, 'button button-quiet'),
        ...(!state.sources.some(row => row.source === 'https://peros.cn/workshop/index.json') ? [
          button(say('添加官方来源', 'Add official source'), () => run(async () => {
            const result = await api('/api/sources/save', { name: say('官方模块社区', 'Official module community'), source: 'https://peros.cn/workshop/index.json', enabled: true, priority: 0, allowPrivateNetwork: false });
            await refresh(); await inspectSource(result.source.id);
          }), 'button button-quiet')
        ] : [])
      ]),
      state.sourceError ? el('p', { role: 'alert', class: 'notice notice-error' }, state.sourceError) : null,
      state.sourceIndex?.offline ? el('p', { role: 'status', class: 'notice notice-warning' }, say('来源当前不可用，显示上次索引观察。仅可请求后台重新核验已有缓存；存在标记不表示缓存已通过核验，也不会沿用执行授权。', 'The source is unavailable. Showing its last index observation. Only existing cache may be requested for fresh backend integrity verification. A presence flag is not verification, and execution authorization is never reused.')) : null
    ]),
    entries.length ? el('div', { class: 'sh-card-grid' }, groupAssets(entries, { mode: 'source', kind: 'module' }).map(group => { const chosen = sourceSelection.get(group); return el('article', { class: 'panel sh-module-card' }, [el('h2', {}, title(chosen.row)), el('p', { class: 'mono' }, group.id), renderAssetVersionSelector({ el, say }, group, sourceSelection, { onChange: renderView }), info(chosen.row.description ? title({ title: chosen.row.description }) : ''), info(`SHA-256 ${chosen.sha256}`), button(state.sourceIndex?.offline ? chosen.row.cached ? say('检查缓存并接入', 'Verify cache & connect') : say('无可用缓存', 'No available cache') : say('下载并接入', 'Download & connect'), () => fetchModule(sourceSelection.get(group).row), 'button button-primary', Boolean(state.sourceError) || !canAcquireSourceModule(state.sourceIndex, chosen.row))]); })) : empty(say('选择下载来源并刷新索引。', 'Select a source and refresh its index.'))];
}
function manageSources() { dialog(say('下载来源', 'Download sources'), state.sources.map(row => el('section', { class: 'panel' }, [el('h3', {}, row.name), info(row.source), info(`${say('网络策略', 'Network policy')}: ${row.allowPrivateNetwork ? say('可信私网／DNS 代理', 'Trusted private network / DNS proxy') : say('公共网络', 'Public network')}`), actions([button(row.enabled === false ? say('启用', 'Enable') : say('暂停', 'Disable'), async () => { await api('/api/sources/save', { ...Object.fromEntries(['id', 'name', 'source', 'enabled', 'priority', 'expectedSha256', 'allowPrivateNetwork', 'revision'].filter(key => row[key] !== undefined).map(key => [key, row[key]])), enabled: row.enabled === false }); await refresh(); toast(say('来源已更新。', 'Source updated.')); }, 'button button-quiet'), button(say('移除来源', 'Remove source'), () => confirm({ title: say('移除下载来源', 'Remove download source'), message: row.source, action: async () => { await api(`/api/sources/${encodeURIComponent(row.id)}/delete`, {}); if (state.sourceId === row.id) { state.sourceId = null; state.sourceIndex = null; } await refresh(); } }), 'button button-quiet')])]))); }
function environment() {
  if (!environmentForm) {
    const nodePath = input('nodePath', state.session?.defaults?.nodePath ?? '', { 'data-path-purpose': 'executable' }), pythonPath = input('pythonPath', state.session?.defaults?.pythonPath ?? '', { 'data-path-purpose': 'executable' }), result = el('div');
    const discover = async () => { const data = await api('/api/paths/known'); const candidates = data.objects.filter(row => row.kind === 'executable'); result.replaceChildren(...candidates.map(row => button(row.path ?? row, () => { (String(row.path ?? row).toLowerCase().includes('python') ? pythonPath : nodePath).value = row.path ?? row; }, 'button button-quiet'))); if (!candidates.length) result.append(info(say('未发现候选，可使用系统选择器定位解释器。', 'No candidates found. Use the system picker to locate a runtime.'))); };
    const runProbe = async () => { const data = await api('/api/environment', { ...(nodePath.value.trim() ? { nodePath: nodePath.value.trim() } : {}), ...(pythonPath.value.trim() ? { pythonPath: pythonPath.value.trim() } : {}) }); state.environment = data; result.replaceChildren(details(say('固定解释器探针结果', 'Fixed interpreter probe results'), data)); };
    const directory = input('moduleDirectory', '', { 'data-path-purpose': 'module' });
    const dependencies = button(say('检查模块依赖声明', 'Inspect module dependency declaration'), () => run(async () => { const found = await api('/api/deployment/inspect', { directory: directory.value.trim() }); result.replaceChildren(details(say('已锁定的依赖声明', 'Locked dependency declaration'), found.deploymentReview?.dependencies ?? null)); }), 'button button-primary');
    environmentForm = el('div', {}, [el('section', { class: 'panel' }, [el('h2', {}, say('解释器与环境探针', 'Runtimes and environment probes')), el('div', { class: 'sh-editor-grid' }, [field(say('Node.js（留空使用 Launcher 的 Node.js）', 'Node.js (leave blank to use Launcher runtime)'), nodePath), field(say('Python（留空从 PATH 检测）', 'Python (leave blank to detect on PATH)'), pythonPath)]), actions([button(say('运行固定探针', 'Run fixed probes'), () => run(runProbe), 'button button-primary'), button(say('发现解释器', 'Discover runtimes'), () => run(discover), 'button button-quiet')]), result]), el('section', { class: 'panel' }, [el('h2', {}, say('模块依赖', 'Module dependencies')), field(say('模块目录', 'Module directory'), directory), info(say('模块依赖在启动审阅中核对并准备；这里仅检查锁定声明，不执行安装。', 'Module dependencies are reviewed and prepared during startup. This page only inspects the locked declaration.')), dependencies]), el('section', { class: 'panel' }, [el('h2', {}, say('执行边界', 'Execution boundary')), info(say('受管模块在可信本机环境执行；通信授权不等于操作系统沙箱。外部程序继续自行管理进程。', 'Managed modules execute in the trusted local environment. Communication authorization is not an OS sandbox. External programs retain process ownership.'))])]);
  }
  return [environmentForm];
}
function renderTaskTrigger() { const active = state.operations.filter(row => ['queued', 'running'].includes(row.state)).length; $('#tasks').textContent = `${say('任务', 'Tasks')}${active ? ` · ${active}` : ''}`; }
async function showTasks() {
  const { operations = [] } = await api('/api/operations'); state.operations = operations; renderTaskTrigger();
  const content = el('div'), node = dialog(say('任务与操作记录', 'Tasks and operation history'), [content]);
  const draw = () => content.replaceChildren(...(state.operations.length ? state.operations.map(row => el('section', { class: 'panel' }, [el('h3', {}, `${row.kind} · ${row.state}`), info(date(row.finishedAt ?? row.startedAt)), row.error ? el('p', { class: 'notice notice-error' }, row.error.message) : null, details(say('操作结果', 'Operation result'), row.result ?? {}), ['queued', 'running'].includes(row.state) ? button(say('取消任务', 'Cancel task'), async () => { await api(`/api/operations/${encodeURIComponent(row.id)}/cancel`, {}); toast(say('取消已请求，等待服务端确认清理。', 'Cancellation requested; waiting for confirmed cleanup.')); }, 'button button-quiet') : null])) : [info(say('还没有操作记录。', 'No operation history yet.'))])); draw(); activeTasks = { node, draw }; node.addEventListener('close', () => { activeTasks = null; });
}

function moduleCenter() {
  const tabs = el('div', { class: 'view-subtabs', role: 'tablist', 'aria-label': say('模块中心', 'Module Center') }, [
    button(say('已接入模块', 'Connected Modules'), () => { moduleSubtab = 'programs'; renderShell(); renderView(); }, `view-subtab${moduleSubtab === 'programs' ? ' is-active' : ''}`),
    button(say('在线获取', 'Get Modules'), () => { moduleSubtab = 'sources'; renderShell(); renderView(); }, `view-subtab${moduleSubtab === 'sources' ? ' is-active' : ''}`)
  ]);
  const content = moduleSubtab === 'sources' ? sources() : programs();
  return [tabs, info(say('模块由程序及其枢纽桥组成；一个程序可以通过多座枢纽桥接入同一枢纽。', 'A module combines a program with its hub bridges. A program can connect to the same Hub through several hub bridges.')), ...(Array.isArray(content) ? content : [content])];
}
function communicationCenter() {
  return environment();
}
function renderView() {
  if (!$('#view-content')) return;
  const views = {
    overview: () => { moduleSubtab = 'programs'; return moduleCenter(); },
    modules: moduleCenter,
    programs: () => { moduleSubtab = 'programs'; return moduleCenter(); },
    groups: () => { moduleSubtab = 'programs'; return moduleCenter(); },
    communication: communicationCenter,
    workbench: () => [workbench.render()],
    sources: () => { moduleSubtab = 'sources'; return moduleCenter(); },
    dynamic: () => { moduleSubtab = 'programs'; moduleCategory = 'ephemeral'; return moduleCenter(); },
    environment: () => { return communicationCenter(); }
  };
  $('#view-content').replaceChildren(...views[state.view]()); paths?.enhance($('#view-content'));
}
function renderShell() {
  document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en'; $('#language').value = state.language;
  $('#workspace-label').textContent = say('本机模块工作空间', 'Local module workspace'); $('#local-description').textContent = say('世界枢纽 · 模块自由组合', 'World Hub · freely connected modules');
  $('#connection-state').textContent = state.online ? say('本机会话已连接', 'Local session connected') : say('本机会话未连接', 'Local session offline');
  const currentNavKey = state.view === 'workbench' ? 'modules' : state.view;
  const currentSubKey = state.view === 'modules' ? (moduleSubtab === 'groups' ? 'programs' : moduleSubtab) : state.view === 'communication' ? 'environment' : state.view === 'workbench' ? 'programs' : '';
  const stamp = `${state.language}:${state.view}:${moduleSubtab}:${communicationSubtab}:${workbench?.mode?.()}`;
  if (navigationStamp !== stamp) {
    navigationStamp = stamp;
    const navNodes = [];
    for (const [key, zh, en, icon, children] of navigation) {
      const isTopActive = currentNavKey === key;
      const topBtn = button([createIcon(icon), el('span', {}, say(zh, en))], () => {
        if (key === 'modules') {
          if (state.view !== 'modules') moduleSubtab = 'programs';
          navigate('modules');
        } else if (key === 'communication') {
          communicationSubtab = 'environment';
          navigate('communication');
        } else {
          navigate(key);
        }
      }, `nav-item${isTopActive ? ' active' : ''}`);
      topBtn.dataset.view = key;
      if (isTopActive) topBtn.setAttribute('aria-current', 'page');
      navNodes.push(topBtn);

      if (children && children.length) {
        const subButtons = children.map(([subKey, subZh, subEn]) => {
          const isSubActive = isTopActive && currentSubKey === subKey;
          const subBtn = button([el('span', { class: 'nav-dot' }), el('span', {}, say(subZh, subEn))], () => {
            if (key === 'modules') {
              moduleSubtab = subKey;
              navigate('modules');
            } else if (key === 'communication') {
              communicationSubtab = subKey;
              navigate('communication');
            }
          }, `nav-sub-item${isSubActive ? ' active' : ''}`);
          subBtn.dataset.view = subKey;
          if (isSubActive) subBtn.setAttribute('aria-current', 'page');
          return subBtn;
        });
        navNodes.push(el('div', { class: 'nav-sub-group' }, subButtons));
      }
    }
    $('#navigation').replaceChildren(...navNodes);
  }
  const current = navigation.find(row => row[0] === state.view);
  let breadcrumbText = current ? say(current[1], current[2]) : '—';
  if (state.view === 'modules') {
    const sub = navigation.find(r => r[0] === 'modules')?.[4]?.find(s => s[0] === moduleSubtab);
    breadcrumbText = `${say('模块中心', 'Module Center')}${sub ? ` / ${say(sub[1], sub[2])}` : ''}`;
  } else if (state.view === 'communication') {
    breadcrumbText = say('系统与环境', 'Environment & System');
  } else if (state.view === 'workbench') {
    breadcrumbText = ['group', 'global-plan'].includes(workbench?.mode?.()) ? say('启动计划编排', 'Startup plan') : say('实例参数与接线', 'Configuration & wiring');
  }
  $('#breadcrumb').textContent = breadcrumbText;
  renderTaskTrigger(); renderHub(); renderStats();
}
function navigate(view, updateHistory = true, subview = null) {
  if (view === 'overview' || view === 'programs' || view === 'groups' || view === 'library') {
    moduleSubtab = 'programs';
    view = 'modules';
  } else if (view === 'sources') {
    moduleSubtab = 'sources';
    view = 'modules';
  } else if (view === 'dynamic') {
    moduleSubtab = 'programs';
    moduleCategory = 'ephemeral';
    view = 'modules';
  } else if (view === 'environment') {
    communicationSubtab = 'environment';
    view = 'communication';
  }
  if (subview) {
    if (view === 'modules') moduleSubtab = ['groups', 'library'].includes(subview) ? 'programs' : subview;
    if (view === 'communication') communicationSubtab = subview;
  }
  if (!navigation.some(row => row[0] === view) && view !== 'workbench') {
    view = 'modules';
    moduleSubtab = 'programs';
  }
  state.view = view;
  if (updateHistory) history.pushState(null, '', `#${view === 'modules' ? moduleSubtab : view === 'communication' ? 'environment' : view}`);
  renderShell(); renderView();
  $('.sidebar')?.classList.remove('is-open'); $('#sidebar-menu-toggle').setAttribute('aria-expanded', 'false');
}
async function refresh() {
  if (refreshing || !state.auth?.token) return;
  refreshing = true;
  try {
    const previous = JSON.stringify([state.programs, state.groups, state.objects, state.online, state.hubsUnavailable, state.externalInventory]);
    const results = await Promise.allSettled([api('/api/programs'), api('/api/hubs'), api('/api/groups'), api('/api/paths/known'), api('/api/sources'), api('/api/operations'), api('/api/programs/external')]);
    const [programData, hubData, groupData, pathData, sourceData, operationData, externalData] = results;
    if (programData.status === 'fulfilled') state.programs = programData.value.programs ?? [];
    if (hubData.status === 'fulfilled') { state.hubs = hubData.value.hubs ?? []; state.hubsObservedAt = new Date().toISOString(); state.hubsUnavailable = false; } else state.hubsUnavailable = true;
    if (groupData.status === 'fulfilled') state.groups = groupData.value.groups ?? [];
    if (pathData.status === 'fulfilled') state.objects = moduleLibraryRows(pathData.value);
    if (sourceData.status === 'fulfilled') state.sources = sourceData.value.sources ?? [];
    if (operationData.status === 'fulfilled') state.operations = operationData.value.operations ?? [];
    if (externalData.status === 'fulfilled') state.externalInventory = externalData.value ?? null;
    state.online = programData.status === 'fulfilled' && hubData.status === 'fulfilled';
    const failure = results.find(result => result.status === 'rejected'); $('#connection-notice').hidden = !failure; $('#connection-notice').textContent = failure ? localizeErrorMessage(failure.reason.message, state.language) : '';
    renderShell();
    // Polling never rebuilds open editors, focused filters, source choices or consent dialogs.
    const changed = previous !== JSON.stringify([state.programs, state.groups, state.objects, state.online, state.hubsUnavailable, state.externalInventory]);
    if (changed && ['groups', 'modules'].includes(state.view)) renderView();
    else if (changed && state.view === 'programs' && !$('#view-content input:focus')) renderView();
    activeTasks?.draw();
  } finally { refreshing = false; }
}
async function boot() {
  const launchCode = new URLSearchParams(location.hash.slice(1)).get('launch'), hashTarget = location.hash.slice(1);
  const initialView = ['sources', 'environment', 'workbench', 'library', 'programs'].includes(hashTarget) || navigation.some(row => row[0] === hashTarget) ? hashTarget : 'modules';
  if (launchCode) history.replaceState(null, '', location.pathname + location.search);
  try { localStorage.removeItem(sessionKey); const theme = localStorage.getItem('world-hub.launcher.theme'); if (['dark', 'light'].includes(theme)) document.documentElement.dataset.theme = theme; state.auth = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null'); } catch {}
  const ctx = { state, api, el, button, toast, date, refresh, navigate, title, run, review, confirm, error, stopProgram };
  paths = createPathUi(ctx); ctx.paths = paths; workbench = createModuleWorkbench(ctx);
  communication = createGlobalDynamicModulesUi({ ...ctx, openCreatorFromPrograms: () => openWorkbench() });
  $('#language').addEventListener('change', () => { state.language = $('#language').value === 'en' ? 'en' : 'zh'; try { localStorage.setItem('world-hub.launcher.language', state.language); } catch {} environmentForm = null; paths.languageChanged(); renderShell(); renderView(); });
  $('#theme').addEventListener('click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('world-hub.launcher.theme', document.documentElement.dataset.theme); } catch {} });
  $('#refresh').addEventListener('click', () => void run(async () => { await refresh(); if (state.view === 'workbench') return; renderView(); })); $('#tasks').addEventListener('click', () => void run(showTasks));
  $('#sidebar-menu-toggle').addEventListener('click', () => { const expanded = $('#sidebar-menu-toggle').getAttribute('aria-expanded') !== 'true'; $('.sidebar').classList.toggle('is-open', expanded); $('#sidebar-menu-toggle').setAttribute('aria-expanded', String(expanded)); });
  window.addEventListener('popstate', () => navigate(location.hash.slice(1), false)); navigate(initialView, false);
  try {
    if (state.auth?.token) try { state.session = await api('/api/session'); state.auth.csrfToken = state.session.csrfToken; } catch { state.auth = null; }
    if (!state.auth) { if (!launchCode) throw new Error(say('请使用启动器提供的新链接打开页面。', 'Open this page using a fresh link from Launcher.')); state.session = await api('/api/session', { code: launchCode }); state.auth = { token: state.session.token, csrfToken: state.session.csrfToken }; }
    sessionStorage.setItem(sessionKey, JSON.stringify(state.auth)); $('#version').textContent = `v${state.session.softwareVersion}`; paths.sessionReady(); await refresh(); renderView();
    setInterval(() => { if (!document.hidden && state.auth?.token) void refresh(); }, 4000);
  } catch (issue) { state.online = false; $('#connection-notice').textContent = localizeErrorMessage(issue.message, state.language); $('#connection-notice').hidden = false; renderShell(); }
}
if (typeof document !== 'undefined' && document.querySelector('#single-hub-app')) void boot();
