// Optional maintenance, source distribution and creator tools. Remote content is always text.
import { createCompletionUi } from './completion-ui.mjs';
import { createPublisherUi } from './publisher-ui.mjs';
import { createIsolationPanel } from './isolation-ui.mjs';
import { createDeploymentUi } from './deployment-ui.mjs';
import { createDynamicAssemblyUi } from './dynamic-assembly-ui.mjs';
import { createPackParadigmUi } from './pack-paradigm-ui.mjs';
import { createStartupPlanUi } from './startup-plan-ui.mjs';
import { createStartupPlanEditor, resolveDraftStartupOrder } from './startup-plan-editor.mjs';
import { createCustomizationUi, renderPackLineage } from './pack-lineage-ui.mjs';
import { createModuleAvatar } from './icons.mjs';
import { groupAssets, createAssetVersionSelection, renderAssetVersionSelector, renderAssetSelectionNotice, compareAssetVersions } from './asset-versions.mjs';
export function createAdvancedUi(ctx) {
  const { state, api, el, button: baseButton, pill, t, toast, definition, display, date, errorContents, current, idOf, endpoint, operationFor, exitUnconfirmed, refresh, renderDetail, navigate, selectInstance, openImport, replaceInstance, createIcon, renderSquareArt: baseRenderSquareArt, setEnvironmentTab, confirmDialog: baseConfirmDialog, localizeErrorMessage: baseLocalizeErrorMessage } = ctx;
  const localizeErrorMessage = (msg, lang) => baseLocalizeErrorMessage ? baseLocalizeErrorMessage(msg, lang ?? state.language) : msg;
  const renderSquareArt = baseRenderSquareArt ?? (({ tone = 'cyan', fallbackIcon = 'modules' } = {}) => el('div', { class: `card-square-art tone-${tone}` }, [createIcon ? createIcon(fallbackIcon, 'icon-art') : null]));
  const $ = selector => document.querySelector(selector);
  const deploymentUi = createDeploymentUi({...ctx,loadKnown:()=>loadKnown()});
  const dynamicAssemblyUi = createDynamicAssemblyUi({...ctx,getModules:()=>getModules(),openCreatorFromInstance:id=>openCreatorFromInstance(id,{throwOnFailure:true}),openDynamicTab:instance=>selectInstance(typeof instance==='string'?instance:idOf(instance),'dynamic-modules')});
  const paradigms = createPackParadigmUi(ctx);
  const startupPlanUi = createStartupPlanUi({ ...ctx, openGlobalEditor: () => openCreatorFromPrograms({ tab: 'startup' }), openPackEditor: instance => openCreatorForPack(instance, { tab: 'startup' }) });
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const assetVersionSelection = createAssetVersionSelection();
  function trackAssetDetails(dialog, group, selected) {
    dialog.dataset.assetSelectionMode = group.mode;
    dialog.dataset.assetGroupKey = group.key;
    dialog.dataset.assetOptionKey = selected?.key ?? '';
  }
  function closeStaleAssetDetails(mode, groups) {
    const current = new Map(groups.map(group => [group.key, group]));
    for (const dialog of document.querySelectorAll('dialog')) {
      if (!dialog.open || dialog.dataset.assetSelectionMode !== mode) continue;
      if (current.get(dialog.dataset.assetGroupKey)?.options.some(option => option.key === dialog.dataset.assetOptionKey)) continue;
      dialog.close();
      toast(say('所选制品详情已变化或不再可用，已关闭旧详情；请从当前卡片重新打开并审阅。', 'The selected artifact details changed or are no longer available. Old details were closed; reopen the current card and review it.'));
    }
  }
  const runtimeKind = mod => ['node', 'python'].includes(mod?.runtime?.kind) ? mod.runtime.kind
    : ['node', 'python'].includes(mod?.runtime) ? mod.runtime : null;
  const runtimeLabel = mod => runtimeKind(mod) === 'python' ? 'Python'
    : runtimeKind(mod) === 'node' ? 'Node.js' : say('运行环境未识别', 'Runtime not identified');
  const askConfirm = opts => baseConfirmDialog ? baseConfirmDialog(opts) : (window.confirm(opts.message) ? void opts.onConfirm() : null);
  function getDeletedObjects() {
    try {
      const raw = localStorage.getItem('world-hub.launcher.deleted-objects');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  }
  function assetDeletionKey(kind, row) {
    const path = row.path ?? row.directory ?? null;
    const canonicalPath = /^[a-z]:[\\/]/i.test(path ?? '') ? path.replaceAll('\\', '/').toLowerCase() : path;
    return `asset:${JSON.stringify([kind, row.id ?? null, row.version ?? null, canonicalPath])}`;
  }
  function saveDeletedObject(kind, row) {
    try {
      const set = getDeletedObjects();
      set.add(assetDeletionKey(kind, row));
      localStorage.setItem('world-hub.launcher.deleted-objects', JSON.stringify([...set]));
    } catch {}
  }
  function isDeletedObject(kind, row) {
    const saved = getDeletedObjects();
    // Keep historical hidden entries compatible. New removals never write the
    // old kind:ID key that would hide every version of the project.
    return saved.has(assetDeletionKey(kind, row)) || saved.has(`${kind}:${String(row.path ?? row.id).toLowerCase()}`) || saved.has(`${kind}:${String(row.id).toLowerCase()}`);
  }
  const failureDialog = el('dialog', { class: 'dialog' }); document.body.append(failureDialog);
  const closeButton = dialog => { const close = baseButton(createIcon ? createIcon('close') : '×', () => dialog.close(), 'icon-button'); close.setAttribute('aria-label', say('关闭', 'Close')); return close; };
  function showFailure(failure) {
    failureDialog.setAttribute('aria-label', say('操作未完成', 'Operation incomplete'));
    failureDialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', {}, say('操作未完成', 'Operation incomplete')), closeButton(failureDialog)]), ...errorContents(failure));
    if (!failureDialog.open) failureDialog.showModal();
  }
  const button = (title, action, ...options) => baseButton(title, async event => { try { await action(event); } catch (failure) { showFailure(failure); } }, ...options);
  const labels = { sources: ['下载', 'Downloads'], creator: ['工作台', 'Workbench'], storage: ['存储与备份', 'Storage & backups'], modules: ['我的模块', 'My modules'], templates: ['我的模板', 'My templates'] };
  const label = key => say(...labels[key]);
  const OFFICIAL_WORKSHOP_SOURCE = 'https://peros.cn/workshop/index.json';
  const defaultOfficialSource = () => ({ name: say('Peros 官方工坊', 'Peros Official Workshop'), source: OFFICIAL_WORKSHOP_SOURCE, enabled: true, priority: 0 });
  const extra = { sources: [], index: null, source: '', indexes: {}, authoring: null, directory: '', edited: null, replacements: new Map(), storage: new Map(), storagePending: new Set(), comments: null, environmentPlan: null, action: null, actionRunning: false, loading: new Set(), derived: null, moduleCandidate: '', moduleCandidateReceipt: null, compositionComponent: '', formScope: '', formValues: {}, results: [], drafts: [], draftStatus: '', draftError: '', removedBinding: null, known: null, knownObjects: [], modulesSearch: '', templatesSearch: '', topologyMode: 'focused' };
  let draftTimer = null, draftSaveQueue = Promise.resolve();
  const storageKey = suffix => `world-hub.launcher.${suffix}:${state.session?.root ?? location.origin}`;
  const sameDirectory = (a, b) => /^[a-z]:[\\/]/i.test(a ?? '') && /^[a-z]:[\\/]/i.test(b ?? '') ? a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase() : a === b;
  const hash = text => { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return (value >>> 0).toString(36); };
  function formIdentity(node) { return `${node.dataset.formScope}:${node.dataset.formKey}`; }
  function rememberForm(node) {
    const values = {};
    for (const control of node.elements) if (control.name && !['submit', 'button', 'password'].includes(control.type)) values[control.name] = control.type === 'checkbox' ? control.checked : control.value;
    const changed = JSON.stringify(extra.formValues[formIdentity(node)]) !== JSON.stringify(values); extra.formValues[formIdentity(node)] = values;
    if (changed && node.dataset.formScope.startsWith('creator:') && extra.edited) scheduleDraft();
  }
  function restoreForm(node) {
    for (const [name, stored] of Object.entries(extra.formValues[formIdentity(node)] ?? {})) { const control = node.elements[name]; if (!control || ['submit', 'button', 'password'].includes(control.type)) continue; if (control.type === 'checkbox') control.checked = stored === true; else if (control.tagName !== 'SELECT' || [...control.options].some(option => option.value === stored)) control.value = stored; }
  }
  function captureForms(root) { for (const node of root?.querySelectorAll('form[data-form-key]') ?? []) rememberForm(node); }
  function restoreForms(root) { for (const node of root?.querySelectorAll('form[data-form-key]') ?? []) restoreForm(node); }
  function rememberResult(kind, result) {
    if (!result || typeof result !== 'object') return;
    if (kind === 'fetch') result = { ...result.entry, ...result };
    const row = { kind, result, at: new Date().toISOString() }, key = result.directory ?? result.destination ?? result.indexPath ?? result.instanceId ?? result.pythonPath;
    extra.results = [row, ...extra.results.filter(item => item.kind !== kind || (item.result.directory ?? item.result.destination ?? item.result.indexPath ?? item.result.instanceId ?? item.result.pythonPath) !== key)].slice(0, 32);
    try { localStorage.setItem(storageKey('results'), JSON.stringify(extra.results)); } catch {}
    for (const mount of document.querySelectorAll('[data-result-library]')) renderResults(mount);
  }
  function renderResults(root) {
    const rows = extra.results.filter(row => !root.dataset.resultKinds || root.dataset.resultKinds.split(',').includes(row.kind));
    root.replaceChildren(...rows.map(({ kind, result, at }) => {
      const directory = result.directory, path = result.indexPath ?? directory ?? result.destination ?? result.pythonPath;
      const names = { fetch: ['已获取软件', 'Fetched software'], derive: ['派生包', 'Derived pack'], rebuild: ['重建包', 'Rebuilt pack'], publish: ['发布制品', 'Publication'], proposal: ['协作提案', 'Collaboration proposal'], 'apply-proposal': ['提案应用结果', 'Applied proposal'], 'create-template': ['新模板', 'Created template'], 'instantiate-template': ['模板生成包', 'Instantiated pack'], backup: ['私有备份', 'Private backup'], comments: ['评论交换文件', 'Comment exchange file'], environment: ['依赖环境', 'Dependency environment'] };
      const actions = [path ? button(say('复制路径', 'Copy path'), () => navigator.clipboard.writeText(path), 'button button-small button-quiet') : null];
      if (directory && (result.kind === 'pack' || ['derive', 'rebuild', 'instantiate-template', 'apply-proposal'].includes(kind))) {
        actions.push(button(t('importPack'), () => { openImport(); $('#import-form').elements.directory.value = directory; $('#import-form').elements.directory.dispatchEvent(new Event('input', { bubbles: true })); }, 'button button-small button-primary'));
        actions.push(button(say('在工作台中打开', 'Open in workbench'), () => { extra.directory = directory; extra.authoring = null; extra.edited = null; extra.resetCreator = true; navigate('creator'); }, 'button button-small button-quiet'));
      }
      if (directory && (result.kind === 'template' || kind === 'create-template')) actions.push(button(say('填写参数生成包', 'Instantiate template'), () => completion.openTemplate(directory), 'button button-small button-primary'));
      if (directory && result.kind === 'module') actions.push(button(say('添加到整合包', 'Add to Pack'), () => {
        addModuleToPackFlow({
          id: result.id,
          title: result.title,
          path: directory,
          runtime: result.runtime,
          provides: result.provides ?? [],
          requires: result.requires ?? []
        });
      }, 'button button-small button-primary'));
      if (result.indexPath) actions.push(button(say('添加为软件源', 'Add as a software source'), async () => { await api('/api/sources/save', { name: result.index?.title ?? say('本机发布制品', 'Local publication'), source: result.indexPath, enabled: true, priority: 0 }); extra.source = result.indexPath; await loadSources(); navigate('sources'); }, 'button button-small button-primary'));
      if (result.pythonPath) actions.push(button(say('选择新 Python 路径', 'Select new Python path'), () => { const input = $('#environment-form').elements.pythonPath; input.value = result.pythonPath; input.dispatchEvent(new Event('input', { bubbles: true })); state.environmentSelection = {}; toast(say('已填入路径，请重新检测与审阅。', 'Path filled in. Detect and review again.')); }, 'button button-small button-primary'));
      if(result.previousDirectory)actions.push(button(say('复制旧来源恢复目录','Copy previous source recovery directory'),()=>navigator.clipboard.writeText(result.previousDirectory),'button button-small button-quiet'));
      return el('article', { class: 'result-card' }, [el('h3', {}, result.cachedObservation ? say('本机缓存候选', 'Local cached candidate') : names[kind] ? say(...names[kind]) : kind), result.id ? el('p', {}, `${result.id}${result.version ? `@${result.version}` : ''} · ${result.kind ?? ''}`) : null, el('p', { class: 'mono result-path' }, path ?? say('操作完成', 'Operation completed')), el('p', { class: 'field-help' }, result.cachedObservation ? say('来自缓存目录的轻量发现；尚未完整检查内容、环境或发布者。', 'Lightweight discovery from the cache directory; contents, environment, and publisher have not been fully checked.') : `${date(at)} · ${say('本机结果记录；使用前仍须重新检查', 'Local result record; check again before use')}`), el('div', { class: 'result-actions' }, actions.filter(Boolean)), result.sourceReceipt ? jsonView(say('来源收据', 'Source receipt'), result.sourceReceipt) : null].filter(Boolean));
    }));
    if (!rows.length) root.append(el('p', { class: 'field-help' }, say('完成的获取与生成操作会保留在这里。', 'Completed fetches and generated outputs remain here.')));
  }
  function resultLibrary(kinds = '') {
    const root = el('div', { class: 'result-library', 'data-result-library': '', ...(kinds ? { 'data-result-kinds': kinds } : {}) });
    renderResults(root);
    const rows = extra.results.filter(row => !kinds || kinds.split(',').includes(row.kind));
    if (!rows.length) {
      return el('div', { class: 'result-library-empty is-hidden', 'data-result-library': '', ...(kinds ? { 'data-result-kinds': kinds } : {}) }, [root]);
    }
    return panel(say('已获取与生成的结果', 'Fetched & generated results'), [root]);
  }
  function workbenchResults() {
    const kinds = 'derive,update,rebuild,publish,proposal,apply-proposal,create-template,instantiate-template';
    if (!extra.results.some(row => kinds.split(',').includes(row.kind))) return null;
    return el('details', { class: 'creator-section creator-recent-results', 'data-section-key': 'recent-workbench-results' }, [
      el('summary', {}, say('最近工作台成果', 'Recent workbench results')),
      resultLibrary(kinds)
    ]);
  }
  function preserve(root) {
    captureForms(root);
    const active = document.activeElement, form = active?.closest?.('form[data-form-key]');
    const generic = root?.contains(active) && ['H1', 'BUTTON', 'SUMMARY'].includes(active?.tagName) ? { tag: active.tagName, text: active.textContent, index: [...root.querySelectorAll(active.tagName.toLowerCase())].filter(node => node.textContent === active.textContent).indexOf(active) } : null;
    return { active: root?.contains(active) ? active.dataset?.focusKey ? { focusKey: active.dataset.focusKey } : form && active.name ? { key: formIdentity(form), name: active.name, start: active.selectionStart, end: active.selectionEnd } : generic : null, details: Object.fromEntries([...root?.querySelectorAll('details[data-section-key]') ?? []].map(node => [node.dataset.sectionKey, node.open])) };
  }
  function reinstate(root, saved) {
    restoreForms(root);
    for (const node of root?.querySelectorAll('details[data-section-key]') ?? []) if (Object.hasOwn(saved.details, node.dataset.sectionKey)) node.open = saved.details[node.dataset.sectionKey];
    if (!saved.active) return;
    if (saved.active.tag) { const target = saved.active.tag === 'H1' ? root.querySelector('h1') : [...root.querySelectorAll(saved.active.tag.toLowerCase())].filter(node => node.textContent === saved.active.text)[saved.active.index]; if (target) { if (saved.active.tag === 'H1') target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); } return; }
    if (saved.active.focusKey) { const target = [...root.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === saved.active.focusKey) ?? root.querySelector('.composition-undo button'); target?.focus({ preventScroll: true }); return; }
    const form = [...root.querySelectorAll('form[data-form-key]')].find(node => formIdentity(node) === saved.active.key), input = form?.elements[saved.active.name];
    if (input) { input.focus({ preventScroll: true }); try { input.setSelectionRange(saved.active.start, saved.active.end); } catch {} }
  }
  function folded(key, title, children) { return el('details', { class: 'creator-section', 'data-section-key': key }, [el('summary', {}, title), ...children]); }
  function canvasDrawer(key, icon, title, children) {
    return el('details', { class: 'canvas-inline-drawer', 'data-section-key': key }, [
      el('summary', { class: 'canvas-inline-summary' }, [
        el('span', { class: 'drawer-icon', 'aria-hidden': 'true' }, icon),
        el('span', { class: 'drawer-title' }, title),
        el('span', { class: 'drawer-chevron', 'aria-hidden': 'true' }, '▾')
      ]),
      el('div', { class: 'canvas-inline-body' }, children)
    ]);
  }
  function openModal(title, bodyNodes, description = '', dialogClass = '') {
    const dialog = el('dialog', { class: `dialog${dialogClass ? ` ${dialogClass}` : ''}`, 'aria-label': title });
    document.body.append(dialog);
    const close = button('×', () => dialog.close(), 'icon-button');
    close.setAttribute('aria-label', say('关闭', 'Close'));
    const heading = el('div', { class: 'dialog-heading' }, [
      el('div', {}, [
        el('h2', {}, title),
        description ? el('p', { class: 'dialog-description' }, description) : null
      ].filter(Boolean)),
      close
    ]);
    dialog.append(heading, ...bodyNodes);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
    return dialog;
  }
  function openTemplatesModal() {
    return openModal(say('模板 · 制作、检查与脚手架', 'Templates · Create, Inspect & Scaffold'), [completion.templatePanel()]);
  }
  function openCreateTemplateModal(baseDirectory = '') {
    return completion.openCreateTemplateModal ? completion.openCreateTemplateModal(baseDirectory) : openModal(say('制作新模板 · 从整合包导出', 'Create Template · Export from Base Pack'), [completion.createTemplatePanel(baseDirectory)]);
  }
  function openProposalsModal() {
    return openModal(say('协作提案与冲突检查', 'Collaboration Proposals & Conflict Checks'), [proposalPanel()]);
  }
  function openPublishModal() {
    return openModal(say('发布到可分享的软件源目录', 'Publish to Shareable Source Directory'), [publishPanel()]);
  }
  function openCommentsModal() {
    return openModal(say('讨论 · 本地评论与交换', 'Discussion · Local Comments & Exchange'), [commentsPanel()]);
  }
  function openRebuildModal() {
    return openModal(say('环境或 Hub 版本变化：复制并重建锁', 'Changed Environment: Copy & Rebuild Lock'), [rebuildForm()]);
  }
  function openSecurityAuditModal() {
    publisher.load?.();
    return openModal(
      say('🛡️ 数字签名与发布者证书审计', '🛡️ Security Signatures & Publisher Trust Audit'),
      [publisher.trustPanel()],
      say('分别审阅内容完整性、签名证据、发布者信任和运行保护模式。下载或有效签名不会授予执行许可；trusted-local 不提供 OS 沙箱。', 'Review integrity, signature evidence, publisher trust, and the selected execution profile separately. Downloads and valid signatures grant no execution permission; trusted-local provides no OS sandbox.'),
      'security-audit-dialog'
    );
  }
  function draftSnapshot() {
    if (!extra.authoring || !extra.edited) return null;
    return { format: 'world-hub.creator-draft/v1', directory: extra.directory, baseRevision: extra.authoring.revision, pack: structuredClone(extra.edited), replacements: [...extra.replacements.values()].map(({ componentId, moduleDirectory, preview }) => ({ componentId, moduleDirectory, ...(preview?.candidateDigest ? { candidateDigest: preview.candidateDigest } : {}) })), formValues: Object.fromEntries(Object.entries(extra.formValues).filter(([key]) => key.startsWith(`creator:${extra.directory}:`))), selection: extra.compositionComponent, updatedAt: new Date().toISOString(), ...(extra.runtimeAssembly && sameDirectory(extra.directory,extra.runtimeAssembly.directory) ? {origin:{kind:'pack-runtime',target:structuredClone(extra.runtimeAssembly.origin),stateRequirements:structuredClone(extra.runtimeAssembly.stateRequirements)}} : extra.assembly && sameDirectory(extra.directory,extra.assembly.directory) ? {origin:{kind:'global-hub',composition:structuredClone(extra.assembly.composition),startupPlan:{onFailure:extra.assembly.startupPlan?.onFailure??'continue-independent'},savedStartupPlan:{onFailure:extra.assembly.savedStartupPlan?.onFailure??extra.assembly.startupPlan?.onFailure??'continue-independent'}}} : {}) };
  }
  function draftStatus() {
    for (const node of document.querySelectorAll('[data-draft-status]')) node.textContent = extra.draftError ? `${say('保存失败，当前页面仍保留修改', 'Save failed; edits remain in this page')}: ${extra.draftError}` : extra.draftStatus === 'saving' ? say('正在保存草稿…', 'Saving draft…') : extra.draftStatus === 'pending' ? say('有待保存的修改', 'Changes waiting to save') : extra.draftStatus === 'saved' ? say('草稿已保存；尚未生成包', 'Draft saved; pack not generated') : say('已检查来源；编辑会自动保存草稿', 'Source checked; edits are saved as a draft');
  }
  function scheduleDraft() { extra.draftRevision = (extra.draftRevision ?? 0) + 1; extra.draftStatus = 'pending'; draftStatus(); clearTimeout(draftTimer); draftTimer = setTimeout(() => { void saveDraft().catch(() => {}); }, 450); }
  async function saveDraft() {
    clearTimeout(draftTimer); const draft = draftSnapshot(), revision = extra.draftRevision; if (!draft) return;
    extra.draftStatus = 'saving'; extra.draftError = ''; draftStatus();
    draftSaveQueue = draftSaveQueue.catch(() => {}).then(async () => { try { const saved = await api('/api/creator-drafts/save', { draft }); extra.drafts = [saved.draft ?? draft, ...extra.drafts.filter(item => !sameDirectory(item.directory, draft.directory))].slice(0, 32); if (revision === extra.draftRevision) { extra.draftStatus = 'saved'; extra.draftError = ''; } return saved; } catch (failure) { extra.draftStatus = 'failed'; extra.draftError = failure.message; throw failure; } finally { draftStatus(); } });
    await draftSaveQueue;
  }
  async function loadDrafts() { const data = await api('/api/creator-drafts'); extra.drafts = data.drafts ?? []; }
  function clearCreatorForms(directory) { for (const key of Object.keys(extra.formValues)) if (key.startsWith(`creator:${directory}:`)) delete extra.formValues[key]; }
  async function discardDraft(directory) {
    clearTimeout(draftTimer); await draftSaveQueue.catch(() => {});
    const targetDir = directory || extra.directory;
    if (targetDir) await api('/api/creator-drafts/delete', { directory: targetDir });
    extra.drafts = extra.drafts.filter(draft => !sameDirectory(draft.directory, targetDir));
    if (targetDir) clearCreatorForms(targetDir);
    const wasActive = !targetDir || sameDirectory(targetDir, extra.directory);
    if (wasActive) {
      extra.authoring = null;
      extra.edited = null;
      extra.directory = '';
      extra.replacements.clear();
      extra.comments = null;
      extra.derived = null;
      extra.removedBinding = null;
      extra.draftStatus = '';
      extra.draftError = '';
    }
    extra.resetCreator = true;
    renderCreator();
    toast(wasActive
      ? say('已放弃当前草稿，已返回装配工坊首页', 'Draft discarded; returned to launchpad')
      : say('已放弃保存的草稿', 'Saved draft discarded')
    );
  }
  async function restoreDraft(draft) {
    const data = await api('/api/authoring/inspect', { directory: draft.directory, ...env() }), authoring = data.authoring ?? data;
    if (authoring.revision !== draft.baseRevision) {
      showFailure(new Error(say('来源内容已改变，保存的草稿不能直接应用。旧草稿已保留，请审阅差异后重新装配。', 'Source contents changed. The saved draft cannot be applied directly. It is retained; review the differences before creating a new draft.'))); failureDialog.append(jsonView(say('来源变化与保存的草稿', 'Changed source and retained draft'), { savedBase: draft.baseRevision, currentBase: authoring.revision, savedDraft: draft }, true)); return;
    }
    const replacements = new Map();
    for (const row of draft.replacements ?? []) {
      const { preview } = await api('/api/authoring/preview', { directory: draft.directory, componentId: row.componentId, moduleDirectory: row.moduleDirectory, pack: draft.pack, replacements: draft.replacements.map(({ componentId, moduleDirectory }) => ({ componentId, moduleDirectory })), expectedRevision: draft.baseRevision, ...env() });
      if (preview.environmentCompatible === false || (preview.compatible !== true && (!preview.diagnostics?.length || preview.diagnostics.some(item => item.code !== 'CONTRACT_UNBOUND')))
          || (row.candidateDigest && row.candidateDigest !== preview.candidateDigest)) throw new Error(say(`草稿中的候选模块 ${row.componentId} 已改变或不兼容；旧草稿保留，请重新检查候选。`, `Candidate ${row.componentId} changed or is incompatible. The saved draft is retained; inspect the candidate again.`));
      replacements.set(row.componentId, { ...row, preview });
    }
    const savedStartupPack = draft.origin?.kind === 'pack-runtime' ? await inspectSavedStartupPack(draft.origin.target.targetInstanceId) : null;
    extra.directory = draft.directory; extra.authoring = authoring; extra.edited = structuredClone(draft.pack); extra.replacements = replacements; extra.formValues = { ...extra.formValues, ...draft.formValues }; extra.compositionComponent = draft.selection ?? ''; extra.comments = null; extra.derived = null; extra.draftStatus = 'saved'; extra.draftError = ''; extra.removedBinding = null;
    extra.assembly = draft.origin?.kind === 'global-hub' ? {directory:draft.directory,composition:structuredClone(draft.origin.composition),startupPlan:structuredClone(draft.origin.startupPlan??{onFailure:'continue-independent'}),savedStartupPlan:structuredClone(draft.origin.savedStartupPlan??draft.origin.startupPlan??{onFailure:'continue-independent'})} : null;
    extra.runtimeAssembly = draft.origin?.kind === 'pack-runtime' ? {directory:draft.directory,origin:structuredClone(draft.origin.target),stateRequirements:structuredClone(draft.origin.stateRequirements),savedStartupPack} : null;
    state.reviews.clear(); state.trustReview = null; extra.resetCreator = true; renderCreator();
    toast(say('草稿已恢复并重新检查来源与候选；执行授权不会恢复。', 'Draft restored and source and candidates rechecked. Execution authorization is not restored.'));
  }
  function draftPanel() {
    if (extra.authoring) return el('div', { class: 'draft-bar' }, [el('span', { role: 'status', 'aria-live': 'polite', 'data-draft-status': '' }), button(say('立即保存草稿', 'Save draft now'), async () => { captureForms($('#creator-content')); await saveDraft(); }, 'button button-small button-quiet'), button(say('放弃此草稿', 'Discard this draft'), () => reviewAction(say('放弃装配草稿', 'Discard creator draft'), [note(say('只放弃当前来源的草稿配置、绑定、替换与表单输入。已生成包和实例保留。', 'Discard draft settings, bindings, replacements, and form inputs for this source. Generated packs and instances remain.'))], say('我确认放弃这些草稿修改。', 'I confirm discarding these draft changes.'), () => discardDraft(extra.directory)), 'button button-small button-quiet')]);
    if (!extra.drafts.length) return null;
    return panel(say('继续已保存的草稿', 'Continue a saved draft'), extra.drafts.map(draft => el('article', { class: 'result-card' }, [el('h3', {}, `${draft.pack.id}@${draft.pack.version}`), el('p', { class: 'mono' }, draft.directory), el('p', { class: 'field-help' }, date(draft.updatedAt)), button(say('重新检查并恢复', 'Recheck and restore'), () => restoreDraft(draft), 'button button-small button-primary'), button(say('放弃', 'Discard'), () => reviewAction(say('放弃已保存草稿', 'Discard saved draft'), [definition([[t('source'), draft.directory]])], say('我确认放弃这个草稿。', 'I confirm discarding this draft.'), () => discardDraft(draft.directory)), 'button button-small button-quiet'), jsonView(say('保存的公开草稿内容', 'Saved public draft contents'), draft)])));
  }
  const env = () => Object.keys(state.environmentSelection).length ? state.environmentSelection : Object.fromEntries(['nodePath', 'pythonPath'].map(key => [key, $('#environment-form').elements[key].value.trim()]).filter(([, value]) => value));
  const panel = (title, children = []) => el('section', { class: 'panel' }, [el('div', { class: 'panel-heading' }, el('h2', {}, title)), ...children]);
  const note = (text, warning = false) => el('div', { class: `notice${warning ? ' notice-warning' : ''}` }, text);
  function field(name, title, value = '', options = {}) {
    const control = el(options.multiline ? 'textarea' : 'input', { name, ...(options.multiline ? { rows: options.rows ?? 5 } : { type: options.type ?? 'text' }), required: options.required ?? true, autocomplete: 'off', spellcheck: 'false', ...(options.pattern ? { pattern: options.pattern } : {}), ...(options.readonly ? { readonly: true } : {}) });
    control.value = value ?? '';
    if (options.pathPurpose) control.dataset.pathPurpose = options.pathPurpose;
    return el('label', {}, [el('span', {}, title), control]);
  }
  function form(fields, actionLabel, action, help = '', key = '') {
    const submit = el('button', { type: 'submit', class: 'button button-primary' }, actionLabel);
    const error = el('div', { class: 'notice notice-error', role: 'alert', hidden: true });
    const form = el('form', { class: 'advanced-form', 'data-form-key': key || `advanced-${hash(action.toString())}`, 'data-form-scope': extra.formScope || 'advanced' }, [...fields, help ? el('p', { class: 'field-help' }, help) : null, error, submit]);
    restoreForm(form);
    form.addEventListener('input', () => rememberForm(form)); form.addEventListener('change', () => rememberForm(form));
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return; rememberForm(form); error.hidden = true; submit.disabled = true; form.setAttribute('aria-busy', 'true');
      try { await action(form, error); } catch (failure) { error.replaceChildren(...errorContents(failure)); error.hidden = false; }
      finally { submit.disabled = false; form.setAttribute('aria-busy', 'false'); rememberForm(form); }
    });
    return form;
  }
  const value = (form, key) => form.elements[key]?.value.trim() ?? '';
  const jsonView = (title, object, open = false) => el('details', { class: 'json-details', ...(open ? { open: true } : {}) }, [el('summary', {}, title), el('pre', {}, JSON.stringify(object, null, 2))]);
  const completion = createCompletionUi({ ...ctx, button, say, panel, note, field, form, value, env, jsonView, reviewAction, operation, closeButton });
  const publisher = createPublisherUi({ ...ctx, button, say, panel, note, field, form, value, jsonView, reviewAction });
  const customization = createCustomizationUi({ ...ctx, button, note, jsonView, reviewAction, operation,
    onApplied: async (result, instance) => {
      clearTimeout(draftTimer); await draftSaveQueue.catch(() => {});
      const oldDirectory = extra.directory, directory = result.instance?.packageDirectory ?? instance.packageDirectory ?? result.directory ?? oldDirectory;
      const issues = [], directories = [oldDirectory, directory].filter((value, index, rows) => rows.findIndex(row => sameDirectory(row, value)) === index);
      for (const targetDirectory of directories) {
        try {
          await api('/api/creator-drafts/delete', { directory: targetDirectory });
          extra.drafts = extra.drafts.filter(draft => !sameDirectory(draft.directory, targetDirectory));
        } catch (failure) { issues.push(say(`旧草稿清理失败，记录仍保留，可在草稿箱重试删除：${failure.message}`, `Old draft cleanup failed; its record remains available for deletion in the draft library: ${failure.message}`)); }
        clearCreatorForms(targetDirectory);
      }
      extra.runtimeAssembly = null; extra.assembly = null;
      extra.authoring = null; extra.edited = null; extra.replacements.clear();
      extra.creatorPostApplyWarning = '';
      try { await loadPackIntoCreator(directory, () => navigate('creator'), { ignoreSavedDraft: true }); }
      catch (failure) {
        issues.push(say(`新版本已生效，但工作台重新载入失败。请重新检查实例目录：${failure.message}`, `The new version is applied, but Workbench reload failed. Inspect the instance directory again: ${failure.message}`));
        extra.directory = directory; navigate('creator');
      }
      if (issues.length) {
        extra.creatorPostApplyWarning = `${say('改装保存已生效。', 'Customization is already applied.')} ${issues.join(' ')}`;
        $('#creator-content')?.prepend(note(extra.creatorPostApplyWarning, true));
        return { warning: extra.creatorPostApplyWarning };
      }
    },
    onRestored: async (_result, instance) => { extra.storage.delete(idOf(instance)); await refresh({ explicit: true }); await loadStorage(idOf(instance), true); }
  });
  const heading = (title, subtitle, eyebrow) => el('div', { class: 'page-heading' }, el('div', {}, [el('div', { class: 'eyebrow' }, eyebrow), el('h1', {}, title), el('p', {}, subtitle)]));

  const actionDialog = el('dialog', { class: 'dialog', id: 'advanced-action-dialog' });
  document.body.append(actionDialog);
  function reviewAction(title, contents, consent, execute) {
    actionDialog.replaceChildren(); actionDialog.setAttribute('aria-label', title); extra.action = execute;
    const check = el('input', { type: 'checkbox' }), submit = button(say('确认已审阅并继续', 'Confirm review and continue'), async () => {
      if (!check.checked || !extra.action || extra.actionRunning) return; submit.disabled = true; check.disabled = true; error.hidden = true; extra.actionRunning = true;
      close.disabled = true; dismiss.disabled = true; actionDialog.setAttribute('aria-busy', 'true');
      try { const run = extra.action; await run(); if (extra.action === run) actionDialog.close(); }
      catch (failure) { error.replaceChildren(...errorContents(failure)); error.hidden = false; }
      finally { extra.actionRunning = false; submit.disabled = !check.checked; check.disabled = false; close.disabled = false; dismiss.disabled = false; actionDialog.setAttribute('aria-busy', 'false'); }
    }, 'button button-primary', true);
    const error = el('div', { class: 'notice notice-error', role: 'alert', hidden: true });
    const close = closeButton(actionDialog), dismiss = button(t('cancel'), () => actionDialog.close(), 'button button-quiet');
    check.addEventListener('change', () => { submit.disabled = !check.checked || extra.actionRunning; });
    actionDialog.append(el('div', { class: 'dialog-heading' }, [el('h2', {}, title), close]), ...contents, el('label', { class: 'consent' }, [check, consent]), error, el('div', { class: 'dialog-footer' }, [dismiss, submit]));
    actionDialog.showModal();
  }
  actionDialog.addEventListener('close', () => { extra.action = null; });
  actionDialog.addEventListener('cancel', event => { if (extra.actionRunning) event.preventDefault(); });
  async function operation(data, kind, onSuccess = () => {}) {
    if (!data.operationId) { rememberResult(kind, data); await onSuccess(data); return data; }
    const id = data.operationId;
    const status = el('div', { class: 'notice', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, t('processing'));
    const cancel = button(say('取消此操作', 'Cancel this operation'), async () => { await api(`/api/operations/${encodeURIComponent(id)}/cancel`, {}); cancel.disabled = true; cancel.textContent = say('取消请求已发送，等待清理确认', 'Cancellation requested; awaiting cleanup confirmation'); }, 'button button-small button-quiet');
    if (['environment', 'backup', 'restore', 'fetch'].includes(kind)) status.append(' ', cancel);
    if (actionDialog.open) {
      actionDialog.querySelectorAll('.notice[role="status"]').forEach(n => n.remove());
      actionDialog.insertBefore(status, actionDialog.querySelector('.dialog-footer'));
    }
    else { const host = kind === 'environment' ? $('#advanced-environment-results') : $('#advanced-progress'); host?.replaceChildren(status); }
    return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const { operation } = await api(`/api/operations/${encodeURIComponent(id)}`);
        if (operation.state === 'running') { setTimeout(poll, 800); return; }
        if (operation.state === 'failed' || operation.state === 'cancelled') { const failure = Object.assign(new Error(operation.error?.message ?? say('操作取消', 'Operation cancelled')), { code: operation.error?.code, guidance: operation.error?.guidance, diagnostic: operation.error?.diagnostic, incompleteDestination: operation.error?.incompleteDestination, previousDirectory:operation.error?.previousDirectory, sourceDirectory:operation.error?.sourceDirectory, rollbackError:operation.error?.rollbackError }); if (actionDialog.open) status.remove(); else { status.className = 'notice notice-error'; status.setAttribute('aria-busy', 'false'); status.replaceChildren(...errorContents(failure)); } reject(failure); return; }
        status.textContent = say('操作完成。', 'Operation completed.'); status.setAttribute('aria-busy', 'false'); rememberResult(kind, operation.result); await onSuccess(operation.result); await refresh({ explicit: true }); resolve(operation.result);
      } catch (failure) { status.className = 'notice notice-error'; status.setAttribute('aria-busy', 'false'); status.replaceChildren(...errorContents(failure)); reject(failure); }
    };
    void poll();
    });
  }

  function bytes(number = 0) { const n = Number(number); return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`; }
  function renderStorage(instance) {
    captureForms($('#detail-content')); extra.formScope = `storage:${idOf(instance)}`;
    const id = idOf(instance), storage = extra.storage.get(id), stopped = !exitUnconfirmed(instance) && !operationFor(instance), detached = instance.detached === true || instance.status?.state === 'detached' || storage?.detached === true;
    const inspect = button(say('更新存储观察', 'Refresh storage observation'), () => loadStorage(id, true), 'button button-small button-quiet');

    const storageStats = storage ? el('div', { class: 'storage-metric-strip' }, [
      el('div', { class: 'detail-metric-card' }, [
        el('div', { class: 'metric-header' }, [
          el('span', { class: 'metric-label' }, say('总存储占用', 'Total Storage')),
          el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('database') : null)
        ]),
        el('div', { class: 'metric-value-row' }, [
          el('strong', { class: 'metric-value' }, bytes(storage.bytes))
        ]),
        el('p', { class: 'metric-sub' }, `${storage.files} ${say('个数据与配置实体', 'files & entities')}`)
      ]),
      el('div', { class: 'detail-metric-card' }, [
        el('div', { class: 'metric-header' }, [
          el('span', { class: 'metric-label' }, say('存储分区数', 'Storage Groups')),
          el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('folder') : null)
        ]),
        el('div', { class: 'metric-value-row' }, [
          el('strong', { class: 'metric-value' }, Object.keys(storage.groups ?? {}).length)
        ]),
        el('p', { class: 'metric-sub' }, say('实例持久层分区', 'Instance state partitions'))
      ]),
      el('div', { class: 'detail-metric-card' }, [
        el('div', { class: 'metric-header' }, [
          el('span', { class: 'metric-label' }, say('数据一致性', 'Consistency')),
          el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('check') : null)
        ]),
        el('div', { class: 'metric-value-row' }, [
          pill(storage.consistency ?? say('就绪', 'Ready'), 'teal')
        ]),
        el('p', { class: 'metric-sub' }, say('退出前即时观察', 'Snapshot on process exit'))
      ])
    ]) : null;

    const rows = storage ? Object.entries(storage.groups ?? {}).map(([group, stats]) => el('div', { class: 'runtime-row storage-group-row' }, [
      el('div', { class: 'storage-group-info' }, [
        el('h3', {}, group),
        el('span', { class: 'subtle mono' }, `${stats.files} ${say('个数据文件', 'files')}`)
      ]),
      pill(bytes(stats.bytes), 'teal')
    ])) : [el('p', { class: 'field-help' }, t('loading'))];

    const backup = form([field('destination', say('新的私有备份文件路径', 'New private backup file path'))], say('审阅并开始备份', 'Review backup'), async f => {
      const destination = value(f, 'destination');
      reviewAction(say('创建私有实例备份', 'Create private instance backup'), [note(say('备份仅在所属进程确认停止后进行。排除 Runtime 生成的运行配置、日志与临时目录；仍可能含个人数据及程序自行保存的秘密，仅作私人备份。', 'Backup requires confirmed process exit. Generated Runtime configuration, logs, and temporary directories are excluded. It may still contain personal data and secrets saved by applications. Keep it private.'), true), definition([[t('instanceId'), id], [t('destination'), destination], [say('一致性', 'Consistency'), storage?.consistency]])], say('我已确认备份目的地为私有目录，并理解数据和潜在秘密会被复制。', 'I reviewed the private destination and understand that data and possible secrets are copied.'), async () => {
        const data = await api(endpoint(id, 'backup'), { destination, accepted: true }); await operation(data, 'backup', result => toast(say(`私有备份已创建：${result.destination}`, `Private backup created: ${result.destination}`)));
      });
    }, say('完整打包保存当前实例的业务数据与配置；若仅需共享程序组合，请使用详情页顶部的「导出整合包」。', 'Backups preserve instance data; package exports preserve shareable program compositions.'));
    backup.querySelector('[type=submit]').disabled = !stopped;

    const detach = button(detached ? say('解除封存并恢复运行', 'Reattach retained software') : say('封存程序并保留数据', 'Uninstall and retain data'), async () => {
      try {
      const review = detached ? await api(endpoint(id, 'review'), env()) : null;
      reviewAction(detached ? say('重新关联软件', 'Reattach software') : say('封存程序并保留数据', 'Uninstall and retain data'), [note(say('此操作必须在确认停止后进行。卸载将软件移入实例私有隔离目录并保留业务数据；它不会删除文件或释放磁盘空间。重新关联会重新检查软件与当前环境，之后仍需明确授权启动。', 'This requires confirmed process exit. Uninstall moves software to a private quarantine directory and preserves data. It does not delete files or free disk space. Reattaching rechecks software and the environment; execution still needs explicit review.'), true), definition([[t('instanceId'), id], [say('数据处理', 'Data handling'), say('保留在当前实例', 'Retained in this instance')]]), ...(review ? ctx.reviewView(review) : [])], say('我已审阅当前内容，理解软件保留在隔离目录，数据不会被删除。', 'I reviewed the current contents and understand that software is retained in quarantine and data is not deleted.'), async () => {
        await operation(await api(endpoint(id, detached ? 'reattach' : 'detach'), { ...(review ? { reviewId: review.reviewId } : {}), accepted: true }), detached ? 'reattach' : 'detach'); extra.storage.delete(id); await refresh({ explicit: true }); await loadStorage(id, true);
      });
      } catch (failure) { showFailure(failure); }
    }, 'button button-quiet', !stopped);

    const backupDialog = el('dialog', { class: 'dialog storage-modal', id: 'storage-backup-dialog', 'aria-label': say('创建私有数据备份', 'Create private instance backup') });
    backupDialog.append(
      el('div', { class: 'dialog-heading' }, [
        el('h2', {}, say('创建私有数据备份', 'Create private instance backup')),
        closeButton(backupDialog)
      ]),
      backup
    );

    const maint = completion.maintenance(instance);

    const storagePanel = panel(label('storage'), [
      el('div', { class: 'panel-heading' }, [
        storage ? pill(`${bytes(storage.bytes)} · ${storage.files} ${say('文件', 'files')}`) : null,
        inspect
      ]),
      storageStats,
      el('div', { class: 'storage-groups-list' }, rows),
      note(say('运行期间的存储用量是即时观察，不能证明一致备份。独立目录不等于 OS 访问隔离。', 'Storage usage during a run is an observation, not proof of backup consistency. Independent directories are not OS access isolation.'))
    ]);

    const opsPanel = panel(say('备份恢复与运维向导', 'Operations & Maintenance Wizard'), [
      el('div', { class: 'storage-ops-grid' }, [
        el('div', { class: 'storage-op-card' }, [
          el('div', { class: 'storage-op-card-header' }, [
            el('div', { class: 'storage-op-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('database') : null),
            el('div', {}, [
              el('h3', {}, say('完整数据备份与还原', 'Backup & restore')),
              el('p', {}, say('完整归档当前实例的业务数据与配置；或从备份文件无损恢复为一个全新的独立实例。', 'Backups preserve instance data; package exports preserve shareable program compositions.'))
            ])
          ]),
          el('div', { class: 'storage-op-card-actions' }, [
            button(say('创建私有备份...', 'Create private backup...'), () => backupDialog.showModal(), 'button button-primary', !stopped),
            button(say('从备份恢复到新实例...', 'Inspect backup and restore to a new instance'), openRestore, 'button button-quiet')
          ])
        ]),

        el('div', { class: 'storage-op-card' }, [
          el('div', { class: 'storage-op-card-header' }, [
            el('div', { class: 'storage-op-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('sparkle') : null),
            el('div', {}, [
              el('h3', {}, say('安全灰度试用新版本', 'Candidate trial with the old instance retained')),
              el('p', {}, say('旧实例安全留底并自动备份，以全新空白数据启动新版本试运行；不满意可随时一键返回旧实例。', 'Old instance must be stopped. Test candidate pack with fresh data while retaining old.'))
            ])
          ]),
          maint.candidateOrigin?.length ? el('div', { class: 'storage-candidate-box' }, maint.candidateOrigin) : null,
          el('div', { class: 'storage-op-card-actions' }, [
            button(say('新版本试运行向导...', 'Candidate trial wizard...'), () => maint.trialDialog.showModal(), 'button button-primary', !stopped)
          ])
        ]),

        el('div', { class: 'storage-op-card' }, [
          el('div', { class: 'storage-op-card-header' }, [
            el('div', { class: 'storage-op-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('refresh') : null),
            el('div', {}, [
              el('h3', {}, say('原地升级与事务回退', 'Upgrade and data rollback')),
              el('p', {}, say('在当前实例原地更新程序版本并支持数据迁移。升级前自动记录完整快照，故障时随时一键回滚。', 'Stop and confirm process exit first. Requires provider-defined state policies.'))
            ])
          ]),
          el('div', { class: 'storage-op-card-actions' }, [
            button(say('版本升级向导...', 'Upgrade wizard...'), () => maint.upgradeDialog.showModal(), 'button button-primary', !stopped),
            customization.historyButton(instance, !stopped || detached),
            maint.history
          ])
        ]),

        el('div', { class: 'storage-op-card' }, [
          el('div', { class: 'storage-op-card-header' }, [
            el('div', { class: 'storage-op-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('shield') : null),
            el('div', {}, [
              el('h3', {}, say('程序封存与数据保留', 'Instance maintenance')),
              el('p', {}, say('安全切断软件执行，将程序剥离并移入隔离目录，完整保留所有业务数据；日后可随时重新激活。', 'Uninstall moves software to quarantine and retains data.'))
            ])
          ]),
          el('div', { class: 'storage-op-card-actions' }, [
            detach
          ]),
          el('p', { class: 'field-help' }, say('操作须知：请先在上方停止实例，确保所有后台进程已完全退出。', 'Stop the instance and wait for confirmed process exit first.'))
        ])
      ])
    ]);

    return [
      storagePanel,
      opsPanel,
      backupDialog,
      maint.trialDialog,
      maint.upgradeDialog,
      maint.historyDialog,
      resultLibrary('backup,restore,staged-upgrade,upgrade,rollback-upgrade,recover-upgrade')
    ];
  }
  async function loadStorage(id, explicit = false) {
    if (!id || extra.storagePending.has(id)) return; extra.storagePending.add(id);
    try { const data = await api(endpoint(id, 'storage')); extra.storage.set(id, data.storage ?? data); if (state.selected === id && state.tab === 'storage') renderDetail(true); }
    catch (failure) { if (explicit) showFailure(failure); }
    finally { extra.storagePending.delete(id); }
  }
  const restoreDialog = el('dialog', { class: 'dialog', id: 'restore-dialog' }); document.body.append(restoreDialog);
  function openRestore() {
    captureForms(restoreDialog); extra.formScope = 'restore'; restoreDialog.setAttribute('aria-label', say('从备份文件恢复到新实例', 'Restore to a new instance'));
    let inspected = null;
    const review = el('div'), title = el('h2', {}, say('从备份文件恢复到新实例', 'Restore to a new instance'));
    const restoreForm = form([field('backup', say('私有备份文件路径', 'Private backup file')), field('instanceId', t('instanceId'), '', { pattern: '[a-z0-9][a-z0-9._\\-]{0,63}' }), review], say('检查备份文件', 'Inspect backup'), async f => {
      const backup = value(f, 'backup'), instanceId = value(f, 'instanceId');
      if (!inspected || inspected.path !== backup) {
        const data = await api('/api/backups/inspect', { backup }); const inspection = data.inspection ?? data;
        inspected = { path: backup, inspection }; review.replaceChildren(...[note(say('恢复操作始终创建新的独立实例，绝不会覆盖已有实例。备份可能包含个人数据与配置；恢复完成后需在实例页重新审阅并授权启动。', 'Restore creates a new instance and never overwrites an existing one. Platform and locked compatibility must pass. Backups contain private data. Review code and environment again before starting.'), true), definition([[say('来源实例', 'Source instance'), inspection.backup?.sourceInstanceId], [say('创建时间', 'Created'), date(inspection.backup?.createdAt)], [say('大小', 'Size'), bytes(inspection.backup?.bytes)], [say('兼容', 'Compatible'), inspection.compatible], [say('SHA-256', 'SHA-256'), inspection.sha256]]), inspection.incompatibilities?.length ? jsonView(say('兼容性诊断', 'Compatibility diagnostics'), inspection.incompatibilities, true) : null].filter(Boolean));
        f.querySelector('[type=submit]').textContent = say('审阅并确认恢复', 'Review and restore'); return;
      }
      const inspection = inspected.inspection; if (!inspection.compatible) throw new Error(say('备份与当前环境不兼容。', 'This backup is incompatible with the current environment.'));
      reviewAction(say('恢复私有备份', 'Restore private backup'), [definition([[say('备份', 'Backup'), backup], [t('instanceId'), instanceId], ['SHA-256', inspection.sha256]])], say('我已审阅此备份来源，允许将其中私有数据恢复到新的独立实例。', 'I reviewed this backup source and authorize restoring its private data into a new instance.'), async () => {
        const data = await api('/api/backups/restore', { backup, sha256: inspection.sha256, instanceId, ...env(), accepted: true });
        await operation(data, 'restore', async result => { const instance = result.instance ?? result; replaceInstance(instance); restoreDialog.close(); await refresh({ explicit: true }); await selectInstance(idOf(instance)); toast(say('已恢复新实例。启动前仍须审阅授权。', 'New instance restored. Review and authorize before execution.')); });
      });
    });
    restoreDialog.replaceChildren(el('div', { class: 'dialog-heading' }, [title, closeButton(restoreDialog)]), restoreForm); restoreDialog.showModal();
  }

  let sourceLoading = false;
  let inspectingSource = false;
  async function fetchSourceIndex(selected, isAuto = false) {
    if (!selected || inspectingSource) return;
    const configured = extra.sources.find(item => item.source === selected);
    if (configured?.enabled === false) {
      if (!isAuto) throw new Error(say('下载源已禁用。', 'This source is disabled.'));
      return;
    }
    inspectingSource = true;
    extra.sourceError = null;
    if (state.view === 'sources' && (!isAuto || !extra.index)) renderSources();
    try {
      const data = await api('/api/sources/inspect', configured?.id ? { sourceId: configured.id } : { source: selected, ...(configured?.expectedSha256 ? { expectedSha256: configured.expectedSha256 } : {}), ...(configured?.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}) });
      closeStaleAssetDetails('source', groupAssets((data.index?.entries ?? []).map(entry => ({ ...entry, sourceId: data.sourceId ?? selected, indexDigest: data.digest })), { mode: 'source' }));
      extra.index = data;
      extra.sourceError = null;
      rememberIndex(selected, data);
      void loadSources();
    } catch (failure) {
      extra.sourceError = failure;
      if (['SOURCE_DISABLED', 'SOURCE_CHANGED', 'SOURCE_POLICY_CHANGED'].includes(failure.code) || !extra.indexes[selected]) {
        if (!isAuto) throw failure;
      } else {
        extra.index = { ...extra.indexes[selected], cachedObservation: true };
        if (!isAuto) toast(say('来源当前不可用，显示上次索引观察。只能获取后台已验证的制品缓存；不会沿用执行授权。', 'Source unavailable: showing the last index observation. Fetching still requires the backend’s verified artifact cache. Execution authorization is not reused.'));
      }
    } finally {
      inspectingSource = false;
      extra.source = selected;
      renderSources();
    }
  }

  async function loadSources() {
    if (state.session === null && 'session' in state) return;
    if (sourceLoading) return; sourceLoading = true;
    try {
      const data = await api('/api/sources');
      if (!Array.isArray(data.sources)) return;
      const combined = [...data.sources, ...extra.sources.filter(row => !row.id && !data.sources.some(source => source.source === row.source))];
      if (!combined.length) combined.push(defaultOfficialSource());
      extra.sources = combined;
      if (!extra.source && combined.length) {
        extra.source = combined.find(s => s.enabled !== false)?.source ?? combined[0].source;
        if (!extra.index && extra.indexes[extra.source]) extra.index = extra.indexes[extra.source];
      }
      extra.catalog = data;
      if (state.view === 'sources') renderSources();
      if (state.session && extra.source && !extra.index && !inspectingSource) {
        void fetchSourceIndex(extra.source, true);
      }
    }
    catch (failure) { toast(failure.message); } finally { sourceLoading = false; }
  }
  async function changeSource(source, changes) {
    const input = Object.fromEntries(['id', 'name', 'source', 'enabled', 'priority', 'expectedSha256', 'allowPrivateNetwork', 'revision'].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    await api('/api/sources/save', { ...input, ...changes });
    if (extra.source === source.source) { extra.index = null; delete extra.indexes[source.source]; }
    await loadSources();
  }
  function rememberIndex(source, data) { extra.indexes[source] = data; try { localStorage.setItem('world-hub.launcher.source-indexes', JSON.stringify(extra.indexes)); } catch {} }
  function renderSources() {
    const root = $('#sources-content'), saved = preserve(root); extra.formScope = 'sources';
    let communityURL = 'https://peros.cn/workshop/';
    try { communityURL = localStorage.getItem('world-hub.launcher.community') ?? communityURL; } catch {}
    const community = form([field('community', say('社区服务地址（HTTPS）', 'Community URL (HTTPS)'), communityURL)], say('在独立页面打开社区', 'Open community in a separate page'), f => {
      const url = new URL(value(f, 'community'));
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443')) throw new Error(say('社区地址须为无凭据的 HTTPS 443 地址。', 'Use a HTTPS 443 community URL without credentials.'));
      try { localStorage.setItem('world-hub.launcher.community', url.href); } catch {}
      window.open(url.href, '_blank', 'noopener,noreferrer');
    }, say('社区提供账号、发布、讨论与协作提案交换，在独立网页中运行。社区登录不授予本机管理或程序执行权限。', 'The community provides accounts, publishing, and proposal exchange in a separate page. Community login does not grant local management or execution permissions.'));

    const usableSources = extra.sources.filter(source => source.enabled !== false);
    if (!extra.source && usableSources.length) {
      extra.source = usableSources.find(source => /peros\.cn/i.test(source.source) || source.name.toLowerCase().includes('peros'))?.source ?? usableSources[0].source;
    }
    const sourceSelect = el('select', { name: 'source', 'aria-label': label('sources') }, usableSources.map(source => {
      const isOff = /peros\.cn/i.test(source.source) || source.name.toLowerCase().includes('peros');
      return el('option', { value: source.source, selected: source.source === extra.source }, isOff ? `⭐ ${source.name} (官方工坊)` : source.name);
    }));
    sourceSelect.value = extra.source;
    const result = el('div', { id: 'source-results', class: 'source-results-container' });
    const browse = form([sourceSelect], say('读取来源索引', 'Read source index'), async f => {
      const selected = value(f, 'source') || extra.source;
      if (!selected) throw new Error(say('请先添加或选择下载源。', 'Add or select a download source first.'));
      await fetchSourceIndex(selected, false);
    });
    const browseSubmit = browse.querySelector('button[type=submit]');
    if (browseSubmit) { browseSubmit.hidden = true; if (browseSubmit.style) browseSubmit.style.display = 'none'; }
    sourceSelect.addEventListener('change', () => {
      if (sourceSelect.value) {
        extra.source = sourceSelect.value;
        extra.index = null;
        renderSources();
        void fetchSourceIndex(sourceSelect.value, false);
      }
    });

    const privateNetwork = el('label', { class: 'consent' }, [el('input', { type: 'checkbox', name: 'allowPrivateNetwork' }), el('span', {}, say('使用我信任的私网或 DNS 代理来源（内网调试时勾选）', 'Use a trusted private network or DNS proxy source.'))]);
    const add = form([
      field('name', say('来源名称', 'Display name')),
      field('source', say('下载源地址（HTTPS 网址或本地索引文件）', 'Local index file or HTTPS index URL')),
      el('details', { class: 'sources-add-details' }, [
        el('summary', {}, say('高级网络与安全选项（可选）', 'Advanced Network & Security Options (Optional)')),
        field('expectedSha256', say('索引 SHA-256（可选固定哈希）', 'Index SHA-256 (optional)'), '', { required: false }),
        privateNetwork
      ])
    ], say('＋ 添加下载源', 'Add source'), async f => {
      let rawSource = value(f, 'source');
      if (/^https?:\/\/peros\.cn\/workshop\/?$/i.test(rawSource)) rawSource = OFFICIAL_WORKSHOP_SOURCE;
      const source = { name: value(f, 'name'), source: rawSource, expectedSha256: value(f, 'expectedSha256'), allowPrivateNetwork: f.elements.allowPrivateNetwork.checked === true };
      const saved = await api('/api/sources/save', { ...source, enabled: true, priority: 0 });
      extra.source = saved.source.source; extra.index = null; await loadSources(); renderSources();
    });

    const sourcesList = el('div', { class: 'stack sources-list-stack' }, extra.sources.map(source => {
      const isOfficial = /peros\.cn/i.test(source.source) || source.name.toLowerCase().includes('peros');
      const isActive = source.source === extra.source;
      return el('div', { class: `runtime-row source-row-card${isOfficial ? ' official-source-card' : ''}${isActive ? ' is-active-source' : ''}` }, [
        el('div', { class: 'source-info-main' }, [
          el('div', { class: 'source-title-row' }, [
            el('h3', {}, source.name),
            isActive ? pill(say('🎯 当前生效', 'Active Source'), 'purple') : null,
            isOfficial ? pill(say('官方内置', 'Official'), 'teal') : pill(say('自定义源', 'Custom'), 'blue'),
            pill(source.enabled === false ? say('已暂停', 'Disabled') : say('已启用', 'Enabled'), source.enabled === false ? 'amber' : 'emerald')
          ].filter(Boolean)),
          el('p', { class: 'mono subtle source-url-chip' }, source.source),
          el('details', { class: 'source-row-advanced' }, [
            el('summary', {}, say('高级排序与观察', 'Advanced & Diagnostics')),
            el('p', { class: 'field-help' }, `${say('优先级仅排序', 'Priority only orders choices')}: ${source.priority ?? 0}`),
            source.id ? form([field('priority', say('优先级', 'Priority'), source.priority ?? 0, { type: 'number' })], say('保存排序', 'Save ordering'), f => changeSource(source, { priority: Number(value(f, 'priority')) })) : null,
            source.observation ? jsonView(say('上次观察', 'Last observation'), source.observation) : null
          ])
        ]),
        el('div', { class: 'source-row-actions' }, [
          !isActive && source.enabled !== false ? button(say('🎯 设为当前活动源', 'Use as Active Source'), () => {
            extra.source = source.source;
            extra.index = null;
            renderSources();
            void fetchSourceIndex(source.source, false);
          }, 'button button-small button-quiet') : null,
          source.id ? button(source.enabled === false ? say('启用此源', 'Enable') : say('暂停此源', 'Disable'), () => changeSource(source, { enabled: source.enabled === false }), 'button button-small button-quiet') : button(say('保存到持久配置', 'Save to persistent config'), async () => { await api('/api/sources/save', { name: source.name, source: source.source, enabled: true, priority: 0, ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}), allowPrivateNetwork: source.allowPrivateNetwork === true }); await loadSources(); }, 'button button-small button-quiet'),
          source.id ? button(say('移除配置', 'Remove configuration'), async () => { await api(`/api/sources/${encodeURIComponent(source.id)}/delete`, {}); if (extra.source === source.source) { extra.source = ''; extra.index = null; } await loadSources(); }, 'button button-small button-quiet') : button(say('移除', 'Remove'), () => { extra.sources = extra.sources.filter(s => s.source !== source.source); if (extra.source === source.source) { extra.source = ''; extra.index = null; } renderSources(); }, 'button button-small button-quiet')
        ].filter(Boolean))
      ]);
    }));

    if (!extra.sources.length) {
      sourcesList.append(el('div', { class: 'empty-prompt' }, [
        el('p', { class: 'field-help' }, say('暂无已配置下载源。可在右侧添加新来源，或使用官方工坊。', 'No sources configured yet. Add a source on the right, or use the official workshop.'))
      ]));
    }
    if (extra.catalog?.conflicts?.length) sourcesList.prepend(note(say('相同对象身份存在不同摘要，请明确选择来源与内容。优先级不会自动解决冲突。', 'The same artifact identity has different digests. Select its source and contents explicitly; priority does not resolve conflicts.'), true), jsonView(say('内容冲突', 'Content conflicts'), extra.catalog.conflicts, true));

    const enabledCount = extra.sources.filter(s => s.enabled !== false).length;
    extra.sourcesTab = extra.sourcesTab ?? (extra.showSourcesMgmt ? 'manage' : 'marketplace');

    const tabsBar = el('div', { class: 'view-subtabs sources-tabs', role: 'group', 'aria-label': say('下载功能视图', 'Download views') }, [
      el('div', { class: 'view-subtabs-group' }, [
        button(t('sourcesTabMarketplace'), () => {
          extra.sourcesTab = 'marketplace';
          extra.showSourcesMgmt = false;
          renderSources();
        }, `view-subtab${extra.sourcesTab !== 'manage' ? ' is-active' : ''}`),
        button(`${t('sourcesTabManage')} (${extra.sources.length})`, () => {
          extra.sourcesTab = 'manage';
          extra.showSourcesMgmt = true;
          renderSources();
        }, `view-subtab${extra.sourcesTab === 'manage' ? ' is-active' : ''}`)
      ]),
      el('div', { class: 'view-subtabs-actions' }, [
        el('span', { class: 'status-chip active' }, [el('span', { class: 'status-dot' }), `${enabledCount} ${t('sourcesActiveCount')}`]),
        button(say('🛡️ 签名与证书审计', '🛡️ Security & Signatures'), openSecurityAuditModal, 'button button-small button-quiet')
      ])
    ]);
    const tabButtons = tabsBar.querySelectorAll('.view-subtab');
    tabButtons[0]?.setAttribute('aria-pressed', String(extra.sourcesTab !== 'manage'));
    tabButtons[1]?.setAttribute('aria-pressed', String(extra.sourcesTab === 'manage'));

    const communityHub = el('div', { class: 'community-hub-card' }, [
      el('div', { class: 'community-hub-top' }, [
        el('div', { class: 'community-hub-icon', 'aria-hidden': 'true' }, '🌐'),
        el('div', {}, [
          el('h4', { class: 'community-hub-title' }, say('Peros 官方社区工坊', 'Peros Official Workshop')),
          el('p', { class: 'field-help' }, say('在浏览器中访问官方社区，探索更多装配者分享的整合包、参与版本讨论与使用交流。', 'Visit the official community in your browser to discover packs shared by creators and participate in discussions.'))
        ])
      ]),
      button(say('🌐 打开社区工坊网页 (peros.cn)', '🌐 Open Workshop Website'), () => {
        let targetUrl = 'https://peros.cn/workshop/';
        try { targetUrl = localStorage.getItem('world-hub.launcher.community') ?? targetUrl; } catch {}
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }, 'button button-primary'),
      el('details', { class: 'community-hub-details-wrap' }, [
        el('summary', {}, say('自定义社区服务地址（高级设置）', 'Custom Community URL (Advanced)')),
        community
      ])
    ]);

    const activeSourceCard = el('div', { class: 'active-source-card marketplace-toolbar sources-browser-toolbar' }, [
      el('div', { class: 'active-source-card-header' }, [
        el('div', { class: 'active-source-icon-wrap', 'aria-hidden': 'true' }, '🎯'),
        el('div', { class: 'active-source-lead' }, [
          el('h3', {}, say('当前活动下载源', 'Active Download Source')),
          el('p', { class: 'field-help' }, say('设置在“浏览与下载”中默认检索和展示的内容来源。支持快速切换或重新同步。', 'Select the active repository used for browsing and downloads in the Marketplace.'))
        ])
      ]),
      el('div', { class: 'active-source-selector-row' }, [
        el('div', { class: 'sources-source-selector-wrap' }, [
          el('span', { class: 'field-help' }, say('当前生效源：', 'Active source: ')),
          browse
        ]),
        el('div', { class: 'sources-browser-actions active-source-actions' }, [
          button(say('🛍️ 浏览此源内容', '🛍️ Browse Downloads'), () => {
            extra.sourcesTab = 'marketplace';
            extra.showSourcesMgmt = false;
            renderSources();
          }, 'button button-primary'),
          button(say('🔄 重新读取', '🔄 Refresh'), () => {
            extra.index = null;
            if (typeof browse.requestSubmit === 'function') browse.requestSubmit();
            else browse.dispatchEvent(new Event('submit', { cancelable: true }));
          }, 'button button-small button-quiet')
        ])
      ]),
      el('div', { class: 'active-source-status-bar' }, [
        extra.sourceError ? el('span', { class: 'status-indicator-error' }, [
          el('span', { class: 'status-dot dot-error' }),
          `${say('连接异常', 'Connection error')}: ${extra.sourceError.diagnostic?.[state.language] ?? localizeErrorMessage(extra.sourceError.message)}`
        ]) : extra.index?.cachedObservation ? el('span', { class: 'status-indicator-error' }, say('显示上次索引观察；当前连接尚未验证。', 'Showing the last index observation; the current connection is unverified.')) : extra.index ? el('span', { class: 'status-indicator-ready' }, [
          el('span', { class: 'status-dot dot-ready' }),
          `${say('索引已就绪', 'Index ready')} · ${say('共', '')} ${extra.index?.index?.entries?.length ?? 0} ${say('个可用项 (整合包 / 模块 / 模板)', 'items available')} · SHA-256 ${say('核验通过', 'verified')}`
        ]) : inspectingSource ? el('span', { class: 'status-indicator-loading' }, [
          el('span', { class: 'status-dot dot-loading' }),
          say('正在连接下载源并获取最新索引…', 'Connecting to source and fetching latest index…')
        ]) : el('span', { class: 'subtle field-help' }, say('就绪，可随时读取最新内容。', 'Ready to synchronize contents.'))
      ])
    ]);

    const mgmtPanel = el('div', { class: 'sources-mgmt-panel' }, [
      activeSourceCard,
      el('div', { class: 'sources-split-grid' }, [
        el('div', { class: 'sources-col-mgmt' }, [
          panel(say('已配置的下载源', 'Configured Sources'), [sourcesList]),
          communityHub
        ]),
        el('div', { class: 'sources-col-catalog' }, [
          panel(say('＋ 添加自定义下载源', '＋ Add Custom Source'), [add])
        ])
      ])
    ]);

    const mainStage = el('div', { class: 'marketplace-stage' }, [
      result
    ]);

    const marketPanel = el('div', { class: `sources-tab-panel${extra.sourcesTab === 'manage' ? ' is-hidden' : ''}` }, [
      mainStage
    ]);

    const mgmtContainer = el('div', { class: `sources-tab-panel${extra.sourcesTab !== 'manage' ? ' is-hidden' : ''}` }, [
      mgmtPanel
    ]);

    root.replaceChildren(
      tabsBar,
      marketPanel,
      mgmtContainer
    );

    if (extra.index) renderSourceEntries(result);
    else if (inspectingSource) {
      result.replaceChildren(
        el('div', { class: 'marketplace-spotlight' }, [
          el('div', { class: 'marketplace-spotlight-icon', 'aria-hidden': 'true' }, '⏳'),
          el('h2', {}, say('正在加载下载源内容…', 'Loading downloads...')),
          el('p', {}, say('正在连接下载源并获取最新整合包与模块索引，请稍候。', 'Connecting to source and fetching latest packages and modules, please wait...'))
        ])
      );
    } else if (extra.sourceError) {
      result.replaceChildren(
        el('div', { class: 'marketplace-spotlight' }, [
          el('div', { class: 'marketplace-spotlight-icon', 'aria-hidden': 'true' }, '⚠️'),
          el('h2', {}, say('无法连接到当前下载源', 'Unable to connect to source')),
          el('p', { class: 'field-help' }, `${say('来源地址', 'Source')}: ${extra.source}`),
          el('p', { class: 'notice notice-warning' }, extra.sourceError.diagnostic?.[state.language] ?? localizeErrorMessage(extra.sourceError.message)),
          el('div', { class: 'spotlight-btn-group' }, [
            button(say('🔄 重试加载', '🔄 Retry'), () => {
              void fetchSourceIndex(extra.source, false);
            }, 'button button-primary'),
            button(say('⚙️ 切换下载源', '⚙️ Switch Source'), () => {
              extra.sourcesTab = 'manage';
              extra.showSourcesMgmt = true;
              renderSources();
            }, 'button button-quiet')
          ])
        ])
      );
    } else {
      result.replaceChildren(
        el('div', { class: 'marketplace-spotlight' }, [
          el('div', { class: 'marketplace-spotlight-icon', 'aria-hidden': 'true' }, '📦'),
          el('h2', {}, t('spotlightTitle')),
          el('p', {}, t('spotlightDesc')),
          el('div', { class: 'spotlight-btn-group' }, [
            extra.sources.length ? button(t('spotlightInspectFirst'), () => {
              void fetchSourceIndex(extra.source, false);
            }, 'button button-primary') : null,
            button(t('sourcesConfigToggle'), () => {
              extra.sourcesTab = 'manage';
              extra.showSourcesMgmt = true;
              renderSources();
            }, 'button button-quiet')
          ].filter(Boolean)),
          el('div', { class: 'marketplace-preview-grid' }, [
            el('div', { class: 'spotlight-card' }, [
              el('h4', {}, say('📦 完整整合包 (Packs)', '📦 Full Packs')),
              el('p', {}, say('独立打包的完整跨语言应用，下载后可直接在“我的整合包”中导入并运行。', 'Self-contained polyglot applications ready to import and run immediately.')),
              el('span', { class: 'mono subtle' }, say('开箱即用 · 独立环境', 'Out of the box · Isolated'))
            ]),
            el('div', { class: 'spotlight-card' }, [
              el('h4', {}, say('🧩 功能扩展模块 (Modules)', '🧩 Feature Modules')),
              el('p', {}, say('提供特定能力的轻量化模块（如文本读取、数据分析），可在工作台自由装配。', 'Lightweight components providing specific capabilities for composition in Studio.')),
              el('span', { class: 'mono subtle' }, say('跨语言装配 · 能力互联', 'Polyglot wiring · Capabilities'))
            ]),
            el('div', { class: 'spotlight-card' }, [
              el('h4', {}, say('📋 起步模板 (Templates)', '📋 Templates')),
              el('p', {}, say('带有标准骨架的项目模板，用于快速派生和装配你自己的专属整合包。', 'Project skeletons for rapidly deriving and authoring custom packs.')),
              el('span', { class: 'mono subtle' }, say('快速起步 · 规范骨架', 'Quick start · Scaffolding'))
            ])
          ])
        ].filter(Boolean))
      );
    }

    reinstate(root, saved);
  }
  function renderSourceEntries(target) {
    const data = extra.index, source = extra.source, index = data.index ?? {}, entries = index.entries ?? [], allowPrivateNetwork = data.networkPolicy === 'trusted-private-ipv4';
    const search = el('input', { type: 'search', placeholder: t('marketplaceSearchPlaceholder'), 'aria-label': say('筛选软件', 'Filter software'), class: 'marketplace-search-input' });
    const kind = el('select', { 'aria-label': say('对象种类', 'Object kind'), class: 'source-kind-select' }, [['', t('filterAll')], ['pack', t('filterPacks')], ['module', t('filterModules')], ['template', t('filterTemplates')]].map(([val, title]) => el('option', { value: val }, title)));
    const platform = el('input', { placeholder: say('平台（如 win32-x64）', 'Platform (e.g. win32-x64)'), 'aria-label': say('平台筛选', 'Platform filter') });
    const license = el('input', { placeholder: say('协议（如 MIT）', 'License (e.g. MIT)'), 'aria-label': say('许可筛选', 'License filter') });
    [search, kind, platform, license].forEach((input, idx) => { input.value = extra.sourceFilters?.[idx] ?? ''; });

    const catPills = [
      { val: '', label: t('filterAll') },
      { val: 'pack', label: t('filterPacks') },
      { val: 'module', label: t('filterModules') },
      { val: 'template', label: t('filterTemplates') }
    ];
    const catContainer = el('div', { class: 'sources-cat-pills' }, catPills.map(item => {
      const active = (kind.value || '') === item.val;
      const pillBtn = button(item.label, () => {
        kind.value = item.val;
        updateCatPills();
        extra.sourceFilters = [search, kind, platform, license].map(c => c.value);
        filter();
      }, `sources-cat-pill${active ? ' is-active' : ''}`);
      pillBtn.dataset.catVal = item.val;
      return pillBtn;
    }));
    function updateCatPills() {
      for (const btn of catContainer.querySelectorAll('.sources-cat-pill')) {
        btn.classList.toggle('is-active', (kind.value || '') === btn.dataset.catVal);
      }
    }

    const countChip = el('span', { class: 'subtle field-help' }, '');
    const cards = el('div', { class: 'marketplace-cards-grid pack-grid' });
    function executeDownload(entry, selected) {
      if (!selected) return;
      return reviewAction(say('获取软件制品', 'Fetch software artifact'), [
        note(say('内容会经过 SHA-256 完整性核验后安全保存到本机缓存目录。不安装额外依赖、不导入实例、不启动程序。', 'Contents are hash-verified into a new local cache directory. This does not install dependencies, import an instance, or execute programs.')),
        definition([
          [say('内容名称', 'Title'), entry.title ?? entry.id],
          [say('来源索引', 'Source index'), source],
          ['ID', entry.id],
          [say('许可协议', 'License'), entry.license ?? '—'],
          ['SHA-256', entry.sha256],
          [say('网络策略', 'Network policy'), allowPrivateNetwork ? say('可信私网／DNS 代理', 'Trusted private network / DNS proxy') : say('公共网络', 'Public network')]
        ])
      ], say('我已检查来源、网络策略和摘要，允许下载或复制该制品到本机缓存。', 'I reviewed the source, network policy, and digest and authorize downloading or copying this artifact to the local cache.'), async () => {
        const currentData = () => extra.index || data;
        const ensureFreshReceipt = async () => {
          const cur = currentData();
          const isExpiringSoon = !cur?.receiptId || (cur.expiresAt && Date.parse(cur.expiresAt) - Date.now() < 30000);
          if (isExpiringSoon && (cur?.sourceId || source)) {
            const inspected = await api('/api/sources/inspect', {
              source,
              sourceId: cur?.sourceId ?? data.sourceId,
              ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {})
            });
            Object.assign(data, inspected);
            extra.index = inspected;
            return inspected;
          }
          return cur;
        };

        const performFetch = async () => {
          await ensureFreshReceipt();
          const cur = currentData();
          const fetchPayload = {
            ...(cur.sourceId && cur.receiptId
              ? { sourceId: cur.sourceId, receiptId: cur.receiptId }
              : { source, ...(cur.receiptId ? { receiptId: cur.receiptId } : { indexDigest: cur.digest }), ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}) }),
            entryId: entry.entryId
          };
          const res = await api('/api/sources/fetch', fetchPayload);
          return await operation(res, 'fetch');
        };

        let fetched;
        try {
          fetched = await performFetch();
        } catch (fetchError) {
          const isReviewRequired = fetchError.code === 'SOURCE_REVIEW_REQUIRED' ||
            /inspect.*source|source.*receipt/i.test(fetchError.message);
          if (isReviewRequired && (data.sourceId || source)) {
            const inspected = await api('/api/sources/inspect', {
              source,
              sourceId: data.sourceId,
              ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {})
            });
            Object.assign(data, inspected);
            extra.index = inspected;
            fetched = await performFetch();
          } else {
            throw fetchError;
          }
        }
        const downloaded = { ...fetched.entry, ...fetched, path: fetched.directory };
        if (['module', 'template'].includes(downloaded.kind)) {
          const hidden = getDeletedObjects();
          for (const key of [assetDeletionKey(downloaded.kind, downloaded), `${downloaded.kind}:${String(downloaded.id).toLowerCase()}`, `${downloaded.kind}:${String(downloaded.path).toLowerCase()}`]) hidden.delete(key);
          try { localStorage.setItem('world-hub.launcher.deleted-objects', JSON.stringify([...hidden])); } catch {}
        }
        await loadKnown();
        if (['module', 'template'].includes(downloaded.kind)) {
          const group = groupAssets(downloaded.kind === 'module' ? getModules() : getTemplates(), { kind: downloaded.kind }).find(item => item.id === downloaded.id);
          const option = group?.options.find(item => sameDirectory(item.path, downloaded.directory));
          if (option) assetVersionSelection.select(group, option.key);
          navigate(downloaded.kind === 'module' ? 'modules' : 'templates');
        }
        const targetHint = entry.kind === 'module'
          ? say('已自动收录至“我的模块”，可在模块列表查看或装配。', 'Cataloged in My Modules.')
          : entry.kind === 'template'
            ? say('已自动收录至“我的模板”，可直接使用模板生成新包。', 'Cataloged in My Templates.')
            : say('可点击右上角“任务与结果”一键【导入并审阅】为实例。', 'Click "Tasks & results" in topbar to Import and review.');
        toast(`${say('已成功下载', 'Fetched')}: ${entry.title ?? entry.id}。${targetHint}`);
        renderSources();
      });
    }

    function openSourceDetails(group) {
      const existing = document.querySelector('.source-details-dialog, .module-detail-dialog, .template-detail-dialog');
      if (existing) existing.remove();
      const dialog = el('dialog', { class: 'dialog source-details-dialog module-detail-dialog', 'aria-label': say('制品详情', 'Artifact Details') });
      const mountTarget = document.body;
      mountTarget.append(dialog);
      if (extra.source && extra.index?.expiresAt && Date.parse(extra.index.expiresAt) - Date.now() < 60000) {
        void fetchSourceIndex(extra.source, true);
      }

      function renderDetails() {
        const selected = assetVersionSelection.get(group);
        trackAssetDetails(dialog, group, selected);
        const entry = selected?.row ?? { id: group.id, title: group.title, kind: group.kind };
        const titleText = entry.title || entry.id;
        const kindLabel = { pack: say('📦 完整整合包', 'Pack'), module: say('🧩 功能模块', 'Module'), template: say('📋 起步模板', 'Template') }[entry.kind] ?? entry.kind;
        const kindTone = { pack: 'purple', module: 'teal', template: 'amber' }[entry.kind] ?? 'cyan';
        const kindBadge = pill(kindLabel, kindTone);

        let platformText = say('🌐 全平台通用', 'Universal');
        if (entry.platforms?.length) {
          const pList = entry.platforms.map(p => {
            const str = String(p).toLowerCase();
            if (str.includes('win32')) return '💻 Windows';
            if (str.includes('linux')) return '🐧 Linux';
            if (str.includes('darwin')) return '🍎 macOS';
            return str;
          });
          platformText = [...new Set(pList)].join(' · ');
        }

        const descText = entry.description || (entry.kind === 'pack' ? say('完整整合包，包含多个已编排好的模块。', 'Full integration pack with orchestrated modules.') : entry.kind === 'module' ? say('即插即用的功能模块。', 'Plug-and-play functional module.') : say('起步脚手架模板。', 'Starter scaffolding template.'));

        const providesList = (entry.provides ?? []).map(p => el('div', { class: 'marketplace-cap-item' }, [el('span', { class: 'marketplace-cap-badge-provides' }, '✨ ' + say('提供能力', 'Provides')), el('span', {}, `${typeof p === 'string' ? p : p.id}${p.version ? `@${p.version}` : ''}`)]));
        const requiresList = (entry.requires ?? []).map(r => el('div', { class: 'marketplace-cap-item' }, [el('span', { class: 'marketplace-cap-badge-requires' }, '🔗 ' + say('需要依赖', 'Requires')), el('span', {}, `${typeof r === 'string' ? r : r.id}${r.version ? `@${r.version}` : ''}`)]));
        const capsBox = (providesList.length || requiresList.length) ? el('div', { class: 'marketplace-card-caps' }, [...providesList, ...requiresList]) : null;

        const techDetails = el('details', { class: 'source-card-details', open: false }, [
          el('summary', {}, say('🔍 查看技术参数与校验指纹', 'View Technical Parameters & Hash')),
          el('p', { class: 'source-card-digest mono subtle' }, `SHA-256: ${entry.sha256 ?? '—'}`),
          jsonView(say('来源、摘要与合同', 'Source, digest & contracts'), { source: entry.source, sha256: entry.sha256, provides: entry.provides, requires: entry.requires })
        ]);

        const versionSelector = renderAssetVersionSelector({ el, say }, group, assetVersionSelection, {
          onChange: () => {
            filter();
            renderDetails();
          },
          versionOnly: true
        });

        const closeBtn = button('×', () => dialog.close(), 'icon-button');
        closeBtn.setAttribute('aria-label', say('关闭', 'Close'));

        const heading = el('div', { class: 'dialog-heading' }, [
          el('div', { class: 'module-detail-header-info' }, [
            el('div', { class: 'module-detail-title-row' }, [
              el('h2', {}, titleText),
              kindBadge
            ]),
            el('p', { class: 'pack-card-sub mono' }, `${entry.id}@${entry.version ?? '—'}`)
          ]),
          closeBtn
        ]);

        const body = el('div', { class: 'module-detail-body' }, [
          el('div', { class: 'module-detail-section' }, [
            el('p', { class: 'module-card-desc' }, descText)
          ]),
          el('div', { class: 'module-detail-section' }, [
            el('div', { class: 'source-meta-badges' }, [
              el('span', { class: 'source-meta-tag' }, platformText),
              el('span', { class: 'source-meta-tag' }, `📜 ${entry.license ?? say('标准许可', 'Standard')}`)
            ])
          ]),
          versionSelector ? el('div', { class: 'module-detail-section' }, [
            el('span', { class: 'field-label' }, say('版本选择', 'Version selection')),
            versionSelector
          ]) : null,
          capsBox ? el('div', { class: 'module-detail-section' }, [
            el('span', { class: 'field-label' }, say('依赖与提供能力契约', 'Capability & Dependency Contracts')),
            capsBox
          ]) : null,
          el('div', { class: 'module-detail-section' }, [
            techDetails
          ])
        ].filter(Boolean));

        const actions = el('div', { class: 'dialog-footer module-detail-actions' }, [
          button(say('关闭', 'Close'), () => dialog.close(), 'button button-secondary button-small'),
          button(say('立即下载', 'Verify and fetch to cache'), () => {
            dialog.close();
            executeDownload(entry, selected);
          }, 'button button-primary button-small', !selected)
        ]);

        dialog.replaceChildren(heading, body, actions);
      }

      renderDetails();
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      dialog.showModal();
      return dialog;
    }

    const filter = () => {
      const query = search.value.toLowerCase(), os = platform.value.toLowerCase(), permission = license.value.toLowerCase();
      const sourceRows = entries.map(entry => ({ ...entry, sourceId: data.sourceId ?? source, indexDigest: data.digest }));
      const matches = groupAssets(sourceRows, { mode: 'source' }).filter(group => group.options.some(({ row: entry }) => entry && (!kind.value || entry.kind === kind.value) && (!os || entry.platforms?.some(item => String(item).toLowerCase().includes(os))) && (!permission || String(entry.license).toLowerCase().includes(permission)) && JSON.stringify([entry.id, entry.title, entry.version, entry.provides, entry.requires]).toLowerCase().includes(query)));
      countChip.textContent = say(`共 ${matches.length} 个项目 · ${matches.reduce((sum, group) => sum + group.options.length, 0)} 个版本来源选项`, `Showing ${matches.length} projects · ${matches.reduce((sum, group) => sum + group.options.length, 0)} version/source options`);
      cards.replaceChildren(...matches.map(group => {
        const selected = assetVersionSelection.get(group);
        const entry = selected?.row ?? { id: group.id, title: group.title, kind: group.kind };
        const kindLabel = { pack: say('📦 完整整合包', 'Pack'), module: say('🧩 功能模块', 'Module'), template: say('📋 起步模板', 'Template') }[entry.kind] ?? entry.kind;
        const kindTone = { pack: 'purple', module: 'teal', template: 'amber' }[entry.kind] ?? 'cyan';
        const fallbackIcon = entry.kind === 'template' ? 'templates' : entry.kind === 'module' ? 'modules' : 'packs';
        const titleText = entry.title ?? entry.id;

        let platformText = say('🌐 全平台通用', 'Universal');
        if (entry.platforms?.length) {
          const pList = entry.platforms.map(p => {
            const str = String(p).toLowerCase();
            if (str.includes('win32')) return '💻 Windows';
            if (str.includes('linux')) return '🐧 Linux';
            if (str.includes('darwin')) return '🍎 macOS';
            return str;
          });
          platformText = [...new Set(pList)].join(' · ');
        }

        const descText = entry.description || (entry.kind === 'pack' ? say('完整整合包，包含多个已编排好的模块。', 'Full integration pack with orchestrated modules.') : entry.kind === 'module' ? say('即插即用的功能模块。', 'Plug-and-play functional module.') : say('起步脚手架模板。', 'Starter scaffolding template.'));

        const coverArt = renderSquareArt({
          icon: entry.icon ?? entry.metadata?.icon ?? entry.image,
          fallbackIcon,
          tone: kindTone,
          alt: titleText,
          moduleId: entry.kind === 'module' ? entry.id : ''
        });

        const cardMain = el('div', {
          class: 'pack-card-main',
          role: 'button',
          tabindex: '0',
          'aria-label': say(`查看「${titleText}」详细信息`, `View details for "${titleText}"`),
          title: say('点击查看详细信息', 'Click to view details'),
          onclick: () => openSourceDetails(group),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openSourceDetails(group);
            }
          }
        }, [
          el('div', { class: 'pack-card-media' }, [coverArt]),
          el('div', { class: 'pack-card-content' }, [
            el('div', { class: 'pack-card-header-row' }, [
              el('h3', { class: 'marketplace-card-title pack-card-title' }, titleText),
              el('div', { class: 'pack-card-badges' }, [pill(kindLabel, kindTone)])
            ]),
            el('div', { class: 'pack-card-sub mono' }, `${entry.id}@${entry.version ?? '—'}`),
            el('div', { class: 'source-meta-badges' }, [
              el('span', { class: 'source-meta-tag' }, platformText),
              el('span', { class: 'source-meta-tag' }, `📜 ${entry.license ?? say('标准许可', 'Standard')}`)
            ]),
            el('p', { class: 'source-card-desc' }, descText),
            renderAssetSelectionNotice({ el, say }, group, assetVersionSelection, selected)
          ])
        ]);

        return el('article', { class: 'pack-card marketplace-card source-card panel', 'data-source-entry-id': entry.id }, [
          cardMain
        ]);
      }));
      if (!matches.length) cards.append(el('p', { class: 'field-help' }, say('没有匹配的内容。可尝试切换分类或清空搜索关键词。', 'No matching items. Try another category or clear search keywords.')));
    };

    for (const input of [search, kind, platform, license]) input.addEventListener('input', () => {
      extra.sourceFilters = [search, kind, platform, license].map(control => control.value);
      updateCatPills();
      filter();
    });

    const filterHeader = el('div', { class: 'sources-filter-section' }, [
      el('div', { class: 'sources-filter-row' }, [
        catContainer,
        el('div', { class: 'sources-search-field-wrap' }, [search])
      ]),
      el('details', { class: 'source-advanced-filters-drawer' }, [
        el('summary', {}, say('⚙️ 高级筛选（系统架构与开源协议）', '⚙️ Advanced Filters (Platform & License)')),
        el('div', { class: 'source-advanced-filters-grid' }, [
          el('label', {}, [say('适用架构或平台（如 win32-x64）', 'Platform (e.g. win32-x64)'), platform]),
          el('label', {}, [say('开源协议过滤（如 MIT）', 'License filter (e.g. MIT)'), license])
        ])
      ]),
      el('div', { class: 'sources-status-bar-row' }, [
        countChip,
        el('span', { class: 'source-index-digest mono subtle' }, `${say('索引摘要', 'Index digest')}: ${data.digest?.slice(0, 16)}...`)
      ])
    ]);

    const activeSourceObj = extra.sources.find(s => s.source === extra.source);
    const sourceName = activeSourceObj?.name ?? extra.source;
    const isOff = /peros\.cn/i.test(extra.source) || (sourceName && sourceName.toLowerCase().includes('peros'));
    const sourceOriginBanner = el('div', { class: 'marketplace-active-source-banner' }, [
      el('span', { class: 'source-origin-chip' }, [
        el('span', { class: 'status-dot' }),
        `${say('当前下载源', 'Active Source')}: ${isOff ? '⭐ ' : ''}${sourceName}`
      ]),
      button(say('⚙️ 切换/管理下载源', '⚙️ Switch / Manage Source'), () => {
        extra.sourcesTab = 'manage';
        extra.showSourcesMgmt = true;
        renderSources();
      }, 'button button-small button-quiet')
    ]);

    target.replaceChildren(...[
      sourceOriginBanner,
      data.cachedObservation ? el('div', { class: 'notice notice-warning source-cached-observation', role: 'status' }, [
        el('p', {}, say('来源当前不可用，以下显示上次索引观察。后台只允许摘要一致的已验证制品缓存；不会沿用执行授权。', 'The source is currently unavailable. Entries below are the last index observation. The backend only permits hash-matching verified artifact caches; execution authorization is not reused.')),
        extra.sourceError ? el('p', { class: 'source-cached-failure' }, extra.sourceError.diagnostic?.[state.language] ?? localizeErrorMessage(extra.sourceError.message)) : null
      ].filter(Boolean)) : null,
      filterHeader,
      cards
    ].filter(Boolean));
    filter();
  }

  function currentModule(component) { const replaced = extra.replacements.get(component.id)?.preview?.candidate?.manifest;
    if (replaced) return replaced;
    const shared = [...extra.replacements.values()].find(row => row.preview?.candidate?.manifest?.id === component.module)?.preview?.candidate?.manifest;
    return shared ?? extra.authoring?.modules?.find(module => module.id === component.module); }
  const contracts = module => module?.provides ?? [];
  function svgEl(tag, attributes = {}, children = []) {
    if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null || value === false) continue;
        node.setAttribute(key, String(value));
      }
      for (const child of Array.isArray(children) ? children : [children]) {
        if (child === null || child === undefined) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
      return node;
    }
    return el(tag, attributes, children);
  }
  function renderTopologyDiagram(pack, selected) {
    const canvas = el('div', { class: 'workflow-canvas-container', role: 'region', 'aria-label': say('模块通信工作流拓扑画布', 'Module Communication Workflow Canvas') });

    if (!pack.components.length) {
      canvas.append(el('div', { class: 'topology-empty-state' }, [
        el('div', { class: 'topology-empty-icon' }, '🕸️'),
        el('h4', {}, say('暂无工作流节点', 'No Workflow Nodes')),
        el('p', { class: 'subtle' }, say('当前整合包中未检测到功能模块。', 'No modules detected in current pack.'))
      ]));
      return canvas;
    }

    const topologyMode = extra.topologyMode || 'focused';
    const isFocused = topologyMode === 'focused';
    const focusedComp = pack.components.find(c => c.id === selected) || pack.components[0];
    const focusedId = focusedComp?.id;

    // Count open/broadcast capabilities across all components
    let totalBroadcastCount = 0;
    let totalSubscribeCount = 0;
    for (const c of pack.components) {
      const m = currentModule(c);
      const provs = m?.provides ?? [];
      const reqs = m?.requires ?? [];
      totalBroadcastCount += provs.filter(p => !pack.bindings.some(b => b.from === c.id && b.contract.id === p.id)).length;
      totalSubscribeCount += reqs.filter(r => !pack.bindings.some(b => b.to === c.id && b.contract.id === r.id)).length;
    }

    // Canvas Header & Toolbar
    const toolbar = el('div', { class: 'workflow-canvas-toolbar' }, [
      el('div', { class: 'workflow-canvas-toolbar-top' }, [
        el('div', { class: 'workflow-canvas-title' }, [
          el('span', { class: 'workflow-canvas-icon', 'aria-hidden': 'true' }, '🕸️'),
          el('strong', {}, say('工作流拓扑连线画布', 'Workflow Topology Graph')),
          pill(`${pack.components.length} ${say('个模块', 'modules')}`, 'teal'),
          pill(`${pack.bindings.length} ${say('条专供连线', 'dedicated bindings')}`, 'accent'),
          (totalBroadcastCount || totalSubscribeCount) ? pill(`${totalBroadcastCount + totalSubscribeCount} ${say('项未绑定声明', 'unbound declarations')}`, 'amber') : null
        ].filter(Boolean)),
        el('div', { class: 'workflow-mode-toggle' }, [
          button(say('🔍 模块聚焦工作流', '🔍 Focused Module Flow'), () => {
            extra.topologyMode = 'focused';
            renderCreator();
          }, `button button-small${isFocused ? ' is-active button-primary' : ' button-quiet'}`),
          button(say('🌐 全景连线总览', '🌐 Full Overview'), () => {
            extra.topologyMode = 'overview';
            renderCreator();
          }, `button button-small${!isFocused ? ' is-active button-primary' : ' button-quiet'}`)
        ])
      ]),
      // Module focus selector pills
      el('div', { class: 'workflow-module-picker' }, [
        el('span', { class: 'workflow-picker-label' }, say('当前聚焦模块:', 'Focused Module:')),
        ...pack.components.map(comp => button(comp.id, () => {
          extra.compositionComponent = comp.id;
          extra.topologyMode = 'focused';
          renderCreator();
        }, `button button-small${comp.id === focusedId && isFocused ? ' is-active button-primary' : ' button-quiet'}`))
      ]),
      // Legend explaining Dedicated, Available Matches, and Bus
      el('div', { class: 'workflow-canvas-legend' }, [
        el('span', { class: 'legend-item' }, [el('span', { class: 'legend-wire dedicated' }), say('定向专供/专消 (实线光缆 · 点击✕断开)', 'Dedicated Binding (Solid Cable)')]),
        el('span', { class: 'legend-item' }, [el('span', { class: 'legend-socket clickable' }), say('⚡ 匹配可连 (点击直接连线/依次连接)', 'Matching Available (Click to Connect)')]),
        el('span', { class: 'legend-item' }, [el('span', { class: 'legend-socket' }), say('未绑定声明：无实际通信证据', 'Unbound declarations: no observed communication')])
      ])
    ]);
    canvas.append(toolbar);

    // Direct wiring interactive mode banner
    if (extra.wiringPort) {
      const p = extra.wiringPort;
      const wiringBanner = el('div', { class: 'workflow-wiring-bar' }, [
        el('div', {}, [
          el('strong', {}, say('⚡ 端口对接模式中：', '⚡ Direct Port Wiring: ')),
          say(`已选定端口「${p.compId} · ${p.contract.id}@${p.contract.version}」，请点击对应模块的目标端口以完成连线。`, `Selected port "${p.compId} · ${p.contract.id}@${p.contract.version}". Click target matching port to complete connection.`)
        ]),
        button(say('取消选择 (Esc)', 'Cancel (Esc)'), () => {
          extra.wiringPort = null;
          renderCreator();
        }, 'button button-small button-quiet')
      ]);
      canvas.append(wiringBanner);
    }

    if (isFocused) {
      canvas.append(el('div', { class: 'workflow-canvas-scroll', tabindex: 0, role: 'region', 'aria-label': say('静态合同画布局部滚动', 'Scroll static contract canvas') }, renderFocusedTopology(pack, focusedComp)));
    } else {
      canvas.append(el('div', { class: 'workflow-canvas-scroll', tabindex: 0, role: 'region', 'aria-label': say('静态合同画布局部滚动', 'Scroll static contract canvas') }, renderOverviewTopology(pack, selected)));
    }

    // Direct on-canvas shortcuts guidance
    const shortcutsBar = el('div', { class: 'workflow-shortcuts-bar' }, [
      el('span', {}, say('💡 图上直连操作：', '💡 Direct On-Canvas Wiring:')),
      el('span', {}, [say('点击端口旁 ', 'Click '), el('span', { class: 'workflow-kbd' }, say('⚡ 连线', '⚡ Connect')), say(' 添加草稿绑定', ' to add a draft binding')]),
      el('span', {}, [say('点击端口端点可依次选中对接', 'Click sockets to pair sequentially')]),
      el('span', {}, [say('点击线缆上的 ', 'Click cable '), el('span', { class: 'workflow-kbd' }, say('✕ 移除连线', '✕ Remove binding')), say(' 移除草稿绑定', ' to remove a draft binding')]),
      el('span', {}, [say('按 ', 'Press '), el('span', { class: 'workflow-kbd' }, 'Esc'), say(' 取消端点选择', ' to cancel selection')])
    ]);
    canvas.append(shortcutsBar);

    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', e => {
      if (e.key === 'Escape' && extra.wiringPort) {
        extra.wiringPort = null;
        renderCreator();
      }
    });

    return canvas;
  }

  function renderFocusedTopology(pack, focusedComp) {
    const focusedId = focusedComp.id;
    const focusedManifest = currentModule(focusedComp);
    const focusedProvides = contracts(focusedManifest);
    const focusedRequires = focusedManifest?.requires ?? [];

    function connectPorts(fromId, toId, contract) {
      const binding = { from: fromId, to: toId, contract: { id: contract.id, version: contract.version } };
      if (!pack.bindings.some(b => b.from === binding.from && b.to === binding.to && b.contract.id === binding.contract.id)) {
        pack.bindings.push(binding);
        extra.wiringPort = null;
        scheduleDraft();
        renderCreator();
      }
    }

    function toggleWiringPort(compId, role, contract) {
      if (!extra.wiringPort) {
        extra.wiringPort = { compId, role, contract };
        renderCreator();
        return;
      }
      if (extra.wiringPort.compId === compId && extra.wiringPort.contract.id === contract.id) {
        extra.wiringPort = null;
        renderCreator();
        return;
      }
      if (extra.wiringPort.role !== role && extra.wiringPort.contract.id === contract.id && extra.wiringPort.contract.version === contract.version) {
        const fromId = role === 'to' ? extra.wiringPort.compId : compId;
        const toId = role === 'to' ? compId : extra.wiringPort.compId;
        connectPorts(fromId, toId, contract);
        return;
      }
      extra.wiringPort = { compId, role, contract };
      renderCreator();
    }

    // Upstream modules: all other modules in pack providing at least one contract matching focusedRequires
    const upstreamComps = pack.components.filter(c => {
      if (c.id === focusedId) return false;
      const m = currentModule(c);
      return contracts(m).some(p => focusedRequires.some(r => r.id === p.id && r.version === p.version));
    });

    // Downstream modules: all other modules in pack requiring at least one contract matching focusedProvides
    const downstreamComps = pack.components.filter(c => {
      if (c.id === focusedId) return false;
      const m = currentModule(c);
      return (m?.requires ?? []).some(r => focusedProvides.some(p => p.id === r.id && p.version === r.version));
    });

    // Active dedicated bindings
    const inBindings = pack.bindings.filter(b => b.to === focusedId);
    const outBindings = pack.bindings.filter(b => b.from === focusedId);

    const boundReqKeys = new Set(inBindings.map(b => `${b.contract.id}@${b.contract.version}`));
    const openRequires = focusedRequires.filter(r => !boundReqKeys.has(`${r.id}@${r.version}`));

    const boundProvKeys = new Set(outBindings.map(b => `${b.contract.id}@${b.contract.version}`));
    const openProvides = focusedProvides.filter(p => !boundProvKeys.has(`${p.id}@${p.version}`));

    const hasHubBusIn = openRequires.length > 0;
    const hasHubBusOut = openProvides.length > 0;

    const nodeCoords = new Map();
    const nodeWidth = 240;
    const centerWidth = 340;

    const leftCount = upstreamComps.length + (hasHubBusIn ? 1 : 0);
    const rightCount = downstreamComps.length + (hasHubBusOut ? 1 : 0);
    const centerPortCount = Math.max(focusedRequires.length, focusedProvides.length, 1);
    const centerH = Math.max(160, 84 + centerPortCount * 32 + 16);
    const sideH = Math.max(leftCount, rightCount, 1) * 165 + 40;
    const canvasHeight = Math.max(420, centerH + 60, sideH);
    const canvasWidth = 1040;

    // 1. Left Column: Upstream Providers (X = 30)
    let leftY = 30;
    upstreamComps.forEach(comp => {
      const manifest = currentModule(comp);
      const relevantProvides = contracts(manifest).filter(p => focusedRequires.some(r => r.id === p.id && r.version === p.version));
      const h = Math.max(105, 78 + relevantProvides.length * 32 + 10);
      const outPorts = new Map();
      relevantProvides.forEach((p, pIdx) => {
        outPorts.set(`${p.id}@${p.version}`, { x: 30 + nodeWidth, y: leftY + 76 + pIdx * 32 });
      });
      nodeCoords.set(comp.id, { x: 30, y: leftY, w: nodeWidth, h, inPorts: new Map(), outPorts, comp, role: 'provider', relevantProvides });
      leftY += h + 24;
    });

    if (hasHubBusIn) {
      const h = Math.max(105, 78 + openRequires.length * 32 + 10);
      const outPorts = new Map();
      openRequires.forEach((r, rIdx) => {
        outPorts.set(`${r.id}@${r.version}`, { x: 30 + nodeWidth, y: leftY + 76 + rIdx * 32 });
      });
      nodeCoords.set('$hub-bus-in', {
        x: 30, y: leftY, w: nodeWidth, h, inPorts: new Map(), outPorts,
        comp: { id: '$hub-bus-in', title: say('⚠ 未绑定的必需合同', '⚠ Unbound required contracts'), module: say('声明缺口：没有已配置的提供者', 'Declaration gap: no configured provider') },
        role: 'hub-bus', isVirtual: true, busKind: 'in', contracts: openRequires
      });
      leftY += h + 24;
    }

    // 2. Middle Column: Focused Component (X = 350)
    const centerY = Math.max(30, (canvasHeight - centerH) / 2);
    const inPorts = new Map();
    const outPorts = new Map();

    focusedRequires.forEach((r, rIdx) => {
      inPorts.set(`${r.id}@${r.version}`, { x: 350, y: centerY + 78 + rIdx * 32 });
    });

    focusedProvides.forEach((p, pIdx) => {
      outPorts.set(`${p.id}@${p.version}`, { x: 350 + centerWidth, y: centerY + 78 + pIdx * 32 });
    });

    nodeCoords.set(focusedId, {
      x: 350, y: centerY, w: centerWidth, h: centerH, inPorts, outPorts,
      comp: focusedComp, role: 'focused-core'
    });

    // 3. Right Column: Downstream Targets (X = 770)
    let rightY = 30;
    downstreamComps.forEach(comp => {
      const manifest = currentModule(comp);
      const relevantRequires = (manifest?.requires ?? []).filter(r => focusedProvides.some(p => p.id === r.id && p.version === r.version));
      const h = Math.max(105, 78 + relevantRequires.length * 32 + 10);
      const inPortsTarget = new Map();
      relevantRequires.forEach((r, rIdx) => {
        inPortsTarget.set(`${r.id}@${r.version}`, { x: 770, y: rightY + 76 + rIdx * 32 });
      });
      nodeCoords.set(comp.id, { x: 770, y: rightY, w: nodeWidth, h, inPorts: inPortsTarget, outPorts: new Map(), comp, role: 'consumer', relevantRequires });
      rightY += h + 24;
    });

    if (hasHubBusOut) {
      const h = Math.max(105, 78 + openProvides.length * 32 + 10);
      const inPortsBus = new Map();
      openProvides.forEach((p, pIdx) => {
        inPortsBus.set(`${p.id}@${p.version}`, { x: 770, y: rightY + 76 + pIdx * 32 });
      });
      nodeCoords.set('$hub-bus-out', {
        x: 770, y: rightY, w: nodeWidth, h, inPorts: inPortsBus, outPorts: new Map(),
        comp: { id: '$hub-bus-out', title: say('未指定消费者的提供合同', 'Provided contracts without consumers'), module: say('仅声明能力；没有广播或订阅证据', 'Capability declaration only; no broadcast or subscription evidence') },
        role: 'hub-bus', isVirtual: true, busKind: 'out', contracts: openProvides
      });
      rightY += h + 24;
    }

    const viewport = el('div', {
      class: 'workflow-canvas-viewport',
      style: `height: ${canvasHeight}px; width: ${canvasWidth}px;`
    });

    const svg = svgEl('svg', {
      class: 'workflow-canvas-svg',
      viewBox: `0 0 ${canvasWidth} ${canvasHeight}`,
      preserveAspectRatio: 'none'
    });

    const cableBadges = [];

    // Draw Active Incoming Dedicated Cables (Left -> Center)
    inBindings.forEach(b => {
      const fromCoord = nodeCoords.get(b.from);
      const contractKey = `${b.contract.id}@${b.contract.version}`;
      const startPt = fromCoord?.outPorts?.get(contractKey) ?? { x: 270, y: centerY + 60 };
      const endPt = inPorts.get(contractKey) ?? { x: 350, y: centerY + 60 };

      const dx = Math.max(50, Math.abs(endPt.x - startPt.x) * 0.45);
      const pathD = `M ${startPt.x} ${startPt.y} C ${startPt.x + dx} ${startPt.y}, ${endPt.x - dx} ${endPt.y}, ${endPt.x} ${endPt.y}`;

      svg.append(
        svgEl('path', { d: pathD, class: 'workflow-cable-glow is-active' }),
        svgEl('path', { d: pathD, class: 'workflow-cable-line is-active' }),
        svgEl('path', { d: pathD, class: 'workflow-cable-flow is-active' })
      );

      const midX = (startPt.x + endPt.x) / 2;
      const midY = (startPt.y + endPt.y) / 2;
      const index = pack.bindings.findIndex(row => row.from === b.from && row.to === b.to && row.contract.id === b.contract.id);

      const cutBtn = button(say('移除连线', 'Remove binding'), () => {
        if (index >= 0) {
          extra.removedBinding = { binding: structuredClone(b), index };
          extra.edited.bindings.splice(index, 1);
          scheduleDraft();
          renderCreator();
        }
      }, 'button button-small binding-row workflow-cable-cut-btn is-active');
      cutBtn.style = `left: ${midX}px; top: ${midY}px;`;
      cutBtn.title = `${b.from} → ${b.to} (${contractKey}) · ${say('点击移除此专供接线', 'Click to disconnect')}`;
      cableBadges.push(cutBtn);
    });

    // Draw Active Outgoing Dedicated Cables (Center -> Right)
    outBindings.forEach(b => {
      const toCoord = nodeCoords.get(b.to);
      const contractKey = `${b.contract.id}@${b.contract.version}`;
      const startPt = outPorts.get(contractKey) ?? { x: 690, y: centerY + 60 };
      const endPt = toCoord?.inPorts?.get(contractKey) ?? { x: 770, y: centerY + 60 };

      const dx = Math.max(50, Math.abs(endPt.x - startPt.x) * 0.45);
      const pathD = `M ${startPt.x} ${startPt.y} C ${startPt.x + dx} ${startPt.y}, ${endPt.x - dx} ${endPt.y}, ${endPt.x} ${endPt.y}`;

      svg.append(
        svgEl('path', { d: pathD, class: 'workflow-cable-glow is-active' }),
        svgEl('path', { d: pathD, class: 'workflow-cable-line is-active' }),
        svgEl('path', { d: pathD, class: 'workflow-cable-flow is-active' })
      );

      const midX = (startPt.x + endPt.x) / 2;
      const midY = (startPt.y + endPt.y) / 2;
      const index = pack.bindings.findIndex(row => row.from === b.from && row.to === b.to && row.contract.id === b.contract.id);

      const cutBtn = button(say('移除连线', 'Remove binding'), () => {
        if (index >= 0) {
          extra.removedBinding = { binding: structuredClone(b), index };
          extra.edited.bindings.splice(index, 1);
          scheduleDraft();
          renderCreator();
        }
      }, 'button button-small binding-row workflow-cable-cut-btn is-active');
      cutBtn.style = `left: ${midX}px; top: ${midY}px;`;
      cutBtn.title = `${b.from} → ${b.to} (${contractKey}) · ${say('点击移除此专供接线', 'Click to disconnect')}`;
      cableBadges.push(cutBtn);
    });

    viewport.append(svg);

    // Empty Column Placeholders
    if (!upstreamComps.length && !hasHubBusIn) {
      const emptyLeft = el('div', {
        class: 'workflow-empty-col-card',
        style: `left: 30px; top: ${centerY}px; width: ${nodeWidth}px; min-height: 110px;`
      }, [
        el('strong', {}, say('🌱 根级独立源节点', 'Root Source Node')),
        el('span', {}, say('整合包内暂无能为此模块提供输入能力的模块', 'No upstream providers in pack.'))
      ]);
      viewport.append(emptyLeft);
    }

    if (!downstreamComps.length && !hasHubBusOut) {
      const emptyRight = el('div', {
        class: 'workflow-empty-col-card',
        style: `left: 770px; top: ${centerY}px; width: ${nodeWidth}px; min-height: 110px;`
      }, [
        el('strong', {}, say('🏁 终端出口节点', 'Terminal Output Node')),
        el('span', {}, say('整合包内暂无能消费此模块输出能力的模块', 'No downstream consumers in pack.'))
      ]);
      viewport.append(emptyRight);
    }

    // Render HTML Cards
    for (const [id, coord] of nodeCoords.entries()) {
      if (coord.isVirtual) {
        const isOut = coord.busKind === 'in'; // bus providing to core
        const busCard = el('div', {
          class: 'workflow-node-card role-hub-bus',
          style: `left: ${coord.x}px; top: ${coord.y}px; width: ${coord.w}px; min-height: ${coord.h}px;`,
          title: `${coord.comp.title} · ${coord.comp.module}`
        }, [
          el('div', { class: 'workflow-node-header' }, [
            el('span', { class: 'workflow-node-dot provider', 'aria-hidden': 'true' }),
            el('strong', { class: 'workflow-node-id mono' }, coord.comp.title),
            pill(say('未绑定声明', 'Unbound declaration'), 'amber')
          ]),
          el('div', { class: 'workflow-node-sub mono subtle' }, coord.comp.module),
          el('div', { class: 'workflow-node-ports' }, coord.contracts.map(c => {
            return el('div', { class: `workflow-port-item ${isOut ? 'out' : 'in'} ${coord.busKind === 'in' ? 'subscribe' : 'broadcast'}` }, [
              isOut ? null : el('span', { class: 'workflow-socket in broadcast' }),
              el('span', { class: 'workflow-port-name mono' }, `${isOut ? '↑' : '↓'} ${c.id}@${c.version}`),
              el('span', { class: `port-semantic-badge ${coord.busKind === 'in' ? 'subscribe' : 'broadcast'}` }, isOut ? say('缺少绑定', 'Binding missing') : say('尚无消费者', 'No consumer assigned')),
              isOut ? el('span', { class: 'workflow-socket out subscribe' }) : null
            ].filter(Boolean));
          }))
        ]);
        viewport.append(busCard);
        continue;
      }

      if (coord.role === 'focused-core') {
        const manifest = currentModule(coord.comp);
        const coreCard = el('div', {
          class: 'workflow-node-card role-intermediate is-focused-core',
          style: `left: ${coord.x}px; top: ${coord.y}px; width: ${coord.w}px; min-height: ${coord.h}px;`
        }, [
          el('div', { class: 'workflow-node-header' }, [
            el('span', { class: 'workflow-node-dot intermediate', 'aria-hidden': 'true' }),
            el('strong', { class: 'workflow-node-id mono' }, coord.comp.id),
            el('span', { class: 'workflow-focus-tag' }, say('🎯 核心焦点', 'Focused')),
            pill(manifest?.runtime?.kind ?? coord.comp.module, 'teal')
          ]),
          el('div', { class: 'workflow-node-sub mono subtle' }, manifest?.id ?? coord.comp.module),

          el('div', { class: 'workflow-focused-ports-grid' }, [
            el('div', { class: 'workflow-focused-port-col in-col' }, [
              el('div', { class: 'workflow-ports-col-title' }, say('输入接收 (Requires)', 'Inputs (Requires)')),
              ...focusedRequires.map(r => {
                const boundIn = inBindings.find(b => b.contract.id === r.id);
                const isWiringThis = extra.wiringPort?.compId === focusedId && extra.wiringPort?.contract?.id === r.id;
                return el('div', { class: `workflow-port-item in ${boundIn ? 'is-wired' : 'is-unbound'}` }, [
                  el('span', {
                    class: `workflow-socket in dedicated clickable${isWiringThis ? ' is-wiring-source' : ''}`,
                    title: say('点击选择此输入端口进行依次对接', 'Click to pair input port'),
                    onclick: (e) => { e.stopPropagation(); toggleWiringPort(focusedId, 'to', r); }
                  }),
                  el('span', { class: 'workflow-port-name mono' }, `↓ ${r.id}@${r.version}`),
                  boundIn
                    ? el('span', { class: 'port-semantic-badge dedicated' }, `[${say('专消', 'Ded.')} 🡐 ${boundIn.from}]`)
                    : el('span', { class: 'port-semantic-badge subscribe' }, say('缺少必需绑定', 'Required binding missing'))
                ]);
              })
            ]),

            el('div', { class: 'workflow-focused-port-col out-col' }, [
              el('div', { class: 'workflow-ports-col-title' }, say('输出供给 (Provides)', 'Outputs (Provides)')),
              ...focusedProvides.map(p => {
                const boundOut = outBindings.find(b => b.contract.id === p.id);
                const isWiringThis = extra.wiringPort?.compId === focusedId && extra.wiringPort?.contract?.id === p.id;
                return el('div', { class: `workflow-port-item out ${boundOut ? 'is-wired' : 'is-unbound'}` }, [
                  boundOut
                    ? el('span', { class: 'port-semantic-badge dedicated' }, `[${say('专供', 'Ded.')} ➔ ${boundOut.to}]`)
                    : el('span', { class: 'port-semantic-badge broadcast' }, say('尚无消费者', 'No consumer assigned')),
                  el('span', { class: 'workflow-port-name mono' }, `↑ ${p.id}@${p.version}`),
                  el('span', {
                    class: `workflow-socket out dedicated clickable${isWiringThis ? ' is-wiring-source' : ''}`,
                    title: say('点击选择此输出端口进行依次对接', 'Click to pair output port'),
                    onclick: (e) => { e.stopPropagation(); toggleWiringPort(focusedId, 'from', p); }
                  })
                ]);
              })
            ])
          ])
        ]);
        viewport.append(coreCard);
        continue;
      }

      // Upstream or Downstream Module Cards (Click to Trace or Connect!)
      const comp = coord.comp;
      const manifest = currentModule(comp);
      const isUpstream = coord.role === 'provider';
      const relevantContracts = isUpstream ? coord.relevantProvides : coord.relevantRequires;

      const card = el('div', {
        class: `workflow-node-card role-${coord.role}`,
        role: 'button',
        tabindex: '0',
        style: `left: ${coord.x}px; top: ${coord.y}px; width: ${coord.w}px; min-height: ${coord.h}px;`,
        title: `${comp.id} (${say('点击切换中心焦点', 'Click to focus this module')})`
      }, [
        el('div', { class: 'workflow-node-header' }, [
          el('span', { class: `workflow-node-dot ${coord.role}`, 'aria-hidden': 'true' }),
          el('strong', { class: 'workflow-node-id mono' }, comp.id),
          pill(say(isUpstream ? '上游供给源' : '下游消费方', isUpstream ? 'Upstream Source' : 'Downstream Target'), isUpstream ? 'teal' : 'accent')
        ]),
        el('div', { class: 'workflow-node-sub mono subtle' }, manifest?.id ?? comp.module),
        el('div', { class: 'workflow-node-ports' }, relevantContracts.map(c => {
          const isBound = isUpstream
            ? inBindings.some(b => b.from === comp.id && b.contract.id === c.id)
            : outBindings.some(b => b.to === comp.id && b.contract.id === c.id);
          const isWiringThis = extra.wiringPort?.compId === comp.id && extra.wiringPort?.contract?.id === c.id;

          return el('div', { class: `workflow-port-item ${isUpstream ? 'out' : 'in'} ${isBound ? 'is-wired' : 'is-unbound'}` }, [
            isUpstream ? null : el('span', {
              class: `workflow-socket in dedicated clickable${isWiringThis ? ' is-wiring-source' : ''}`,
              title: say('点击选择此端口依次对接', 'Click to pair port'),
              onclick: (e) => { e.stopPropagation(); toggleWiringPort(comp.id, 'to', c); }
            }),
            el('span', { class: 'workflow-port-name mono' }, `${isUpstream ? '↑' : '↓'} ${c.id}@${c.version}`),
            isBound
              ? el('span', { class: 'port-semantic-badge dedicated' }, say(isUpstream ? '专供已连' : '专消已连', 'Dedicated'))
              : button(say('⚡ 连线', '⚡ Wire'), (e) => {
                  e.stopPropagation();
                  isUpstream ? connectPorts(comp.id, focusedId, c) : connectPorts(focusedId, comp.id, c);
                }, 'workflow-port-connect-btn'),
            isUpstream ? el('span', {
              class: `workflow-socket out dedicated clickable${isWiringThis ? ' is-wiring-source' : ''}`,
              title: say('点击选择此端口依次对接', 'Click to pair port'),
              onclick: (e) => { e.stopPropagation(); toggleWiringPort(comp.id, 'from', c); }
            }) : null
          ].filter(Boolean));
        }))
      ]);

      card.addEventListener('click', () => {
        extra.compositionComponent = comp.id;
        renderCreator();
      });

      viewport.append(card);
    }

    const badgesLayer = el('div', {
      class: 'composition-bindings workflow-badges-layer',
      role: 'list',
      'aria-label': say('声明的能力绑定', 'Declared capability bindings')
    }, cableBadges);

    viewport.append(badgesLayer);
    return viewport;
  }

  function renderOverviewTopology(pack, selected) {
    const providers = [];
    const intermediates = [];
    const consumers = [];
    const standalone = [];

    for (const comp of pack.components) {
      const manifest = currentModule(comp);
      const hasProvides = (manifest?.provides?.length ?? 0) > 0;
      const hasRequires = (manifest?.requires?.length ?? 0) > 0;
      if (hasProvides && !hasRequires) providers.push(comp);
      else if (hasProvides && hasRequires) intermediates.push(comp);
      else if (hasRequires && !hasProvides) consumers.push(comp);
      else standalone.push(comp);
    }

    const hasIntermediates = intermediates.length > 0;
    const canvasWidth = hasIntermediates ? 860 : 780;
    const maxNodesInCol = Math.max(providers.length, consumers.length, intermediates.length, 1);
    const canvasHeight = Math.max(380, maxNodesInCol * 160 + 50 + (standalone.length ? 120 : 0));

    const nodeCoords = new Map();
    const nodeWidth = 230;

    providers.forEach((comp, idx) => {
      const manifest = currentModule(comp);
      const provides = manifest?.provides ?? [];
      const h = Math.max(105, 78 + provides.length * 26 + 10);
      const x = 30;
      const y = 30 + idx * 160;
      const outPorts = new Map();
      provides.forEach((p, pIdx) => {
        outPorts.set(`${p.id}@${p.version}`, { x: x + nodeWidth, y: y + 78 + pIdx * 26 });
      });
      nodeCoords.set(comp.id, { x, y, w: nodeWidth, h, inPorts: new Map(), outPorts, comp, role: 'provider' });
    });

    intermediates.forEach((comp, idx) => {
      const manifest = currentModule(comp);
      const provides = manifest?.provides ?? [];
      const requires = manifest?.requires ?? [];
      const h = Math.max(115, 78 + Math.max(provides.length, requires.length) * 26 + 10);
      const x = 310;
      const y = 30 + idx * 165;
      const inPorts = new Map();
      const outPorts = new Map();
      requires.forEach((r, rIdx) => {
        inPorts.set(`${r.id}@${r.version}`, { x, y: y + 78 + rIdx * 26 });
      });
      provides.forEach((p, pIdx) => {
        outPorts.set(`${p.id}@${p.version}`, { x: x + nodeWidth, y: y + 78 + pIdx * 26 });
      });
      nodeCoords.set(comp.id, { x, y, w: nodeWidth, h, inPorts, outPorts, comp, role: 'intermediate' });
    });

    const consumerX = hasIntermediates ? 590 : 500;
    const consumerW = 250;
    consumers.forEach((comp, idx) => {
      const manifest = currentModule(comp);
      const requires = manifest?.requires ?? [];
      const h = Math.max(105, 78 + requires.length * 26 + 10);
      const x = consumerX;
      const y = 30 + idx * 160;
      const inPorts = new Map();
      requires.forEach((r, rIdx) => {
        inPorts.set(`${r.id}@${r.version}`, { x, y: y + 78 + rIdx * 26 });
      });
      nodeCoords.set(comp.id, { x, y, w: consumerW, h, inPorts, outPorts: new Map(), comp, role: 'consumer' });
    });

    standalone.forEach((comp, idx) => {
      const x = 30 + idx * 260;
      const y = canvasHeight - 95;
      nodeCoords.set(comp.id, { x, y, w: 230, h: 80, inPorts: new Map(), outPorts: new Map(), comp, role: 'standalone' });
    });

    const viewport = el('div', {
      class: 'workflow-canvas-viewport',
      style: `height: ${canvasHeight}px; width: ${canvasWidth}px;`
    });

    const svg = svgEl('svg', {
      class: 'workflow-canvas-svg',
      viewBox: `0 0 ${canvasWidth} ${canvasHeight}`,
      preserveAspectRatio: 'none'
    });

    const cableBadges = [];

    for (let index = 0; index < pack.bindings.length; index++) {
      const binding = pack.bindings[index];
      const isCurrent = binding.from === selected || binding.to === selected;
      const fromCoord = nodeCoords.get(binding.from);
      const toCoord = nodeCoords.get(binding.to);

      const contractKey = `${binding.contract.id}@${binding.contract.version}`;
      const startPt = fromCoord?.outPorts?.get(contractKey) ?? (fromCoord ? { x: fromCoord.x + fromCoord.w, y: fromCoord.y + fromCoord.h / 2 } : { x: 270, y: 120 });
      const endPt = toCoord?.inPorts?.get(contractKey) ?? (toCoord ? { x: toCoord.x, y: toCoord.y + toCoord.h / 2 } : { x: 590, y: 120 });

      const dx = Math.max(80, Math.abs(endPt.x - startPt.x) * 0.45);
      const pathD = `M ${startPt.x} ${startPt.y} C ${startPt.x + dx} ${startPt.y}, ${endPt.x - dx} ${endPt.y}, ${endPt.x} ${endPt.y}`;

      const glow = svgEl('path', { d: pathD, class: `workflow-cable-glow${isCurrent ? ' is-active' : ''}` });
      const line = svgEl('path', { d: pathD, class: `workflow-cable-line${isCurrent ? ' is-active' : ''}` });
      const flow = svgEl('path', { d: pathD, class: `workflow-cable-flow${isCurrent ? ' is-active' : ''}` });

      svg.append(glow, line, flow);

      const midX = (startPt.x + endPt.x) / 2;
      const midY = (startPt.y + endPt.y) / 2;

      const cutBtn = button(say('移除连线', 'Remove binding'), () => {
        extra.removedBinding = { binding: structuredClone(binding), index };
        extra.edited.bindings.splice(index, 1);
        scheduleDraft();
        renderCreator();
      }, `button button-small binding-row workflow-cable-cut-btn${isCurrent ? ' is-active' : ''}`);
      cutBtn.style = `left: ${midX}px; top: ${midY}px;`;
      cutBtn.setAttribute('title', `${binding.from} → ${binding.to} (${contractKey}) · ${say('点击移除此接线', 'Click to disconnect')}`);
      cutBtn.setAttribute('aria-label', `${say('移除连线', 'Remove binding')}: ${binding.from} → ${binding.to} ${contractKey}`);

      cableBadges.push(cutBtn);
    }

    viewport.append(svg);

    for (const [id, coord] of nodeCoords.entries()) {
      const comp = coord.comp;
      const manifest = currentModule(comp);
      const isSelected = id === selected;
      const providesList = manifest?.provides ?? [];
      const requiresList = manifest?.requires ?? [];

      const card = el('div', {
        class: `workflow-node-card role-${coord.role}${isSelected ? ' is-selected' : ''}`,
        role: 'button',
        tabindex: '0',
        'aria-pressed': String(isSelected),
        style: `left: ${coord.x}px; top: ${coord.y}px; width: ${coord.w}px; min-height: ${coord.h}px;`,
        title: `${comp.id} (${say('点击切换聚焦此模块', 'Click to focus this module')})`
      }, [
        el('div', { class: 'workflow-node-header' }, [
          el('span', { class: `workflow-node-dot ${coord.role}`, 'aria-hidden': 'true' }),
          el('strong', { class: 'workflow-node-id mono' }, comp.id),
          pill(manifest?.runtime?.kind ?? comp.module, 'teal')
        ]),
        el('div', { class: 'workflow-node-sub mono subtle' }, manifest?.id ?? comp.module),

        requiresList.length ? el('div', { class: 'workflow-node-ports input-ports' }, requiresList.map(req => {
          const isBound = pack.bindings.some(b => b.to === comp.id && b.contract.id === req.id);
          return el('div', { class: `workflow-port-item in${isBound ? ' is-wired' : ''}` }, [
            el('span', { class: 'workflow-socket in', title: say('输入端口', 'Input socket') }),
            el('span', { class: 'workflow-port-name mono' }, `↓ ${req.id}@${req.version}`)
          ]);
        })) : null,

        providesList.length ? el('div', { class: 'workflow-node-ports output-ports' }, providesList.map(prov => {
          const isBound = pack.bindings.some(b => b.from === comp.id && b.contract.id === prov.id);
          return el('div', { class: `workflow-port-item out${isBound ? ' is-wired' : ''}` }, [
            el('span', { class: 'workflow-port-name mono' }, `↑ ${prov.id}@${prov.version}`),
            el('span', { class: 'workflow-socket out', title: say('输出端口', 'Output socket') })
          ]);
        })) : null
      ]);

      card.addEventListener('click', () => {
        extra.compositionComponent = comp.id;
        extra.topologyMode = 'focused';
        renderCreator();
      });

      viewport.append(card);
    }

    const bindingsContainer = el('div', {
      class: 'composition-bindings workflow-badges-layer',
      role: 'list',
      'aria-label': say('声明的能力绑定', 'Declared capability bindings')
    }, cableBadges);

    viewport.append(bindingsContainer);
    return viewport;
  }

  function confirmRemoveComponent(componentId) {
    askConfirm({
      title: say('从装配工作台移除模块', 'Remove Module from Assembly'),
      message: say(`确认从当前装配草稿中移除模块「${componentId}」？相关契约连接与依赖也将被清理。`, `Remove module "${componentId}" from the draft assembly? Associated contract connections and dependencies will also be removed.`),
      danger: true,
      confirmText: t('delete'),
      onConfirm: () => {
        removeComponent(componentId);
      }
    });
  }

  function removeComponent(componentId) {
    const pack = extra.edited;
    if (pack.components.length <= 1) throw new Error(say('整合包至少需要一个模块；请先添加替代模块再移除。', 'A pack needs at least one module. Add another module before removing this one.'));
    pack.components = pack.components.filter(c => c.id !== componentId);
    if (pack.startupOrder) pack.startupOrder = pack.startupOrder.filter(id => id !== componentId);
    pack.bindings = (pack.bindings ?? []).filter(b => b.from !== componentId && b.to !== componentId);
    extra.replacements.delete(componentId);
    for (const c of pack.components) {
      if (Array.isArray(c.after)) {
        c.after = c.after.filter(a => a !== componentId);
      }
    }
    if (extra.compositionComponent === componentId) {
      extra.compositionComponent = pack.components[0]?.id ?? '';
    }
    if (pack.entry?.component === componentId && pack.components.length) pack.entry.component = pack.components[0].id;
    scheduleDraft();
    renderCreator();
    toast(say(`已从装配中移除模块「${componentId}」`, `Removed module "${componentId}" from assembly`));
  }

  async function addComponentToPack(mod) {
    if (!extra.edited || !extra.authoring) throw new Error(say('先打开一个整合包草稿。', 'Open a pack draft first.'));
    if (!mod.path) throw new Error(say('模块来源路径不可用，请重新选择真实本机目录。', 'The module source path is unavailable. Select a real local directory.'));
    const pack = extra.edited;
    const baseId = ((mod.id ? mod.id.split('.').at(-1) : 'module').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'module').slice(0, 52);
    let candidateId = baseId;
    let counter = 2;
    while (pack.components.some(c => c.id === candidateId)) {
      candidateId = `${baseId}-${counter++}`;
    }

    const sourceDirectory = extra.directory, expectedRevision = extra.authoring.revision;
    const sources = [...extra.replacements.values()].map(({ componentId, moduleDirectory }) => ({ componentId, moduleDirectory }));
    const inspect = async (nextPack, component) => (await api('/api/authoring/addition-preview', {
      directory: sourceDirectory, componentId: candidateId, moduleDirectory: mod.path, expectedRevision,
      pack: nextPack, replacements: sources, ...(component ? { component } : {}), ...env()
    })).preview;
    let checked = await inspect(structuredClone(pack));
    if (extra.directory !== sourceDirectory || extra.edited !== pack) throw new Error(say('当前草稿已改变，请重新选择模块。', 'The active draft changed. Select the module again.'));
    if (!checked?.component || !checked.candidate?.manifest) throw new Error(say('预检未返回完整模块声明。', 'Preflight returned no complete module declaration.'));
    if (checked.pack?.topics) {
      pack.topics = { ...checked.pack.topics, ...pack.topics };
    }
    const dialog = el('dialog', { class: 'dialog add-module-config-dialog', 'aria-label': say('配置并审阅新增模块', 'Configure and review a new module') });
    const details = el('div', { class: 'stack' }, replacementView(checked, checked.component));
    const lifecycle = paradigms.flagsEditor(checked.component, pack);
    const prerequisites = paradigms.prerequisitesEditor(checked.component, pack.components);

    const reviewBadge = el('span', { class: 'pill pill-teal', style: 'font-size: 11px; padding: 2px 7px; margin-left: 6px;' });
    function updateReviewBadge(preview) {
      const isUnboundOnly = (preview.diagnostics ?? []).length > 0 && (preview.diagnostics ?? []).every(item => ['CONTRACT_UNBOUND', 'TOPIC_ALIASES_INVALID'].includes(item.code));
      if (preview.compatible) {
        reviewBadge.textContent = say('通过', 'Passed');
        reviewBadge.className = 'pill pill-teal';
      } else if (isUnboundOnly) {
        reviewBadge.textContent = say('待接线', 'Unbound');
        reviewBadge.className = 'pill pill-amber';
      } else {
        reviewBadge.textContent = say('需注意', 'Notice');
        reviewBadge.className = 'pill pill-amber';
      }
    }
    updateReviewBadge(checked);

    const tabParamsBtn = button([
      createIcon ? createIcon('settings', 'tab-icon') : '⚙️',
      say('基础与参数', 'Settings & Lifecycle')
    ].filter(Boolean), () => switchTab('params'), 'view-subtab is-active');
    tabParamsBtn.setAttribute('role', 'tab');
    tabParamsBtn.setAttribute('aria-selected', 'true');
    tabParamsBtn.setAttribute('aria-controls', `addition-panel-params-${candidateId}`);

    const tabPermsBtn = button([
      createIcon ? createIcon('hubs', 'tab-icon') : '🌐',
      say('通信与权限', 'Topics & Permissions')
    ].filter(Boolean), () => switchTab('permissions'), 'view-subtab');
    tabPermsBtn.setAttribute('role', 'tab');
    tabPermsBtn.setAttribute('aria-selected', 'false');
    tabPermsBtn.setAttribute('aria-controls', `addition-panel-perms-${candidateId}`);

    const tabReviewBtn = button([
      createIcon ? createIcon('inspect', 'tab-icon') : '🔍',
      say('预检与差异审阅', 'Preflight Review'),
      reviewBadge
    ].filter(Boolean), () => switchTab('review'), 'view-subtab');
    tabReviewBtn.setAttribute('role', 'tab');
    tabReviewBtn.setAttribute('aria-selected', 'false');
    tabReviewBtn.setAttribute('aria-controls', `addition-panel-review-${candidateId}`);

    const tabsBar = el('div', { class: 'view-subtabs dialog-tabs', role: 'tablist', 'aria-label': say('模块配置选项卡', 'Module configuration tabs') }, [
      el('div', { class: 'view-subtabs-group' }, [tabParamsBtn, tabPermsBtn, tabReviewBtn])
    ]);

    const panelParams = el('div', { class: 'dialog-tab-panel', id: `addition-panel-params-${candidateId}`, role: 'tabpanel' }, [
      definition([[say('组件 ID', 'Component ID'), candidateId], [say('模块 ID', 'Module ID'), checked.candidate.manifest.id], [say('模块许可', 'Module license'), checked.candidate.manifest.license], [say('实际源目录', 'Actual source directory'), checked.candidate.directory]]),
      field('settings', say('公开配置 JSON', 'Public settings JSON'), JSON.stringify(checked.component.settings, null, 2), { multiline: true }),
      prerequisites.node,
      lifecycle.node,
      el('div', { class: 'dialog-tab-nav-row' }, [
        button(say('下一步：通信与权限 →', 'Next: Topics & Permissions →'), () => switchTab('permissions'), 'button button-small button-quiet')
      ])
    ]);

    const panelPerms = el('div', { class: 'dialog-tab-panel', id: `addition-panel-perms-${candidateId}`, role: 'tabpanel', hidden: true }, [
      note(say('桥槽来自真实 module.json。默认没有主题权限；请配置发布/订阅主题。必需合同可在通信画布显式绑定，未绑定会阻止生成。此操作不运行模块。', 'Bridge slots come from the real module.json. Topic access is empty by default; configure publish/subscribe keys. Bind required contracts explicitly on the canvas; unbound contracts block generation. No module is executed.')),
      field('topics', say('整合包主题映射 JSON', 'Pack topic mapping JSON'), JSON.stringify(pack.topics, null, 2), { multiline: true }),
      field('bridges', say('桥槽发布/订阅权限 JSON', 'Bridge slot publish/subscribe ACL JSON'), JSON.stringify(checked.component.bridges, null, 2), { multiline: true }),
      el('div', { class: 'dialog-tab-nav-row' }, [
        button(say('← 上一步：基础与参数', '← Back: Settings'), () => switchTab('params'), 'button button-small button-quiet button-prev'),
        button(say('下一步：预检与审阅 →', 'Next: Preflight Review →'), () => switchTab('review'), 'button button-small button-quiet')
      ])
    ]);

    const panelReview = el('div', { class: 'dialog-tab-panel', id: `addition-panel-review-${candidateId}`, role: 'tabpanel', hidden: true }, [
      details,
      el('div', { class: 'dialog-tab-nav-row' }, [
        button(say('← 上一步：通信与权限', '← Back: Permissions'), () => switchTab('permissions'), 'button button-small button-quiet button-prev')
      ])
    ]);

    function switchTab(tab) {
      tabParamsBtn.classList.toggle('is-active', tab === 'params');
      tabParamsBtn.setAttribute('aria-selected', String(tab === 'params'));
      tabPermsBtn.classList.toggle('is-active', tab === 'permissions');
      tabPermsBtn.setAttribute('aria-selected', String(tab === 'permissions'));
      tabReviewBtn.classList.toggle('is-active', tab === 'review');
      tabReviewBtn.setAttribute('aria-selected', String(tab === 'review'));

      panelParams.hidden = tab !== 'params';
      panelPerms.hidden = tab !== 'permissions';
      panelReview.hidden = tab !== 'review';
      dialog.scrollTop = 0;
    }

    const editor = form([
      tabsBar,
      panelParams,
      panelPerms,
      panelReview
    ], say('检查并加入草稿', 'Check and add to draft'), async f => {
      if (extra.directory !== sourceDirectory || extra.edited !== pack) throw new Error(say('当前草稿已改变，请重新选择模块。', 'The active draft changed. Select the module again.'));
      const component = { ...structuredClone(checked.component), settings: JSON.parse(value(f, 'settings')), bridges: JSON.parse(value(f, 'bridges')), after: prerequisites.read(), ...lifecycle.read() };
      const nextPack = { ...structuredClone(pack), topics: JSON.parse(value(f, 'topics')) };
      const preview = await inspect(nextPack, component);
      details.replaceChildren(...replacementView(preview, component));
      updateReviewBadge(preview);
      if (preview.environmentCompatible === false || preview.diagnostics?.some(item => !['CONTRACT_UNBOUND', 'TOPIC_ALIASES_INVALID'].includes(item.code))) {
        switchTab('review');
        throw new Error(say('新增模块预检不通过，请修正配置或环境后重试。', 'The new module failed preflight. Correct its configuration or environment and retry.'));
      }
      if (!sameReplacementReview(checked, preview)) {
        checked = preview;
        switchTab('review');
        toast(say('候选或配置已变化，请审阅完整预检结果后再次加入。', 'Candidate or configuration changed. Review the full preflight, then add again.'));
        return;
      }
      pack.topics = { ...(preview.pack?.topics ?? {}), ...nextPack.topics }; pack.components.push(preview.component);
      if (pack.startupOrder) pack.startupOrder.push(preview.component.id);
      extra.replacements.set(candidateId, { componentId: candidateId, moduleDirectory: preview.candidate.directory, preview });
      extra.compositionComponent = candidateId;
      scheduleDraft(); dialog.close(); renderCreator();
      toast(say(`已添加模块「${candidateId}」到草稿；生成与运行另需审阅`, `Added module "${candidateId}" to the draft; generation and execution require separate review`));
    }, '', `addition-${candidateId}`);

    const submitBtn = editor.querySelector('button[type=submit]');
    const cancelBtn = button(t('cancel'), () => dialog.close(), 'button button-quiet');
    const footer = el('div', { class: 'dialog-footer addition-dialog-footer' }, [cancelBtn, submitBtn]);
    editor.append(footer);

    dialog.replaceChildren(el('div', { class: 'dialog-heading' }, [
      el('div', {}, [
        el('h2', {}, say('配置并审阅新增模块', 'Configure and review a new module')),
        el('p', { class: 'field-help mono', style: 'margin: 4px 0 0 0;' }, `${candidateId} · ${checked.candidate.manifest.id}@${checked.candidate.manifest.version ?? '1.0.0'}`)
      ]),
      closeButton(dialog)
    ]), editor);
    dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
  }

  async function loadPackIntoCreator(dir, onLoaded, { ignoreSavedDraft = false } = {}) {
    let directory = dir;
    let data;
    try {
      data = await api('/api/authoring/inspect', { directory, ...env() });
    } catch (err) {
      if (!directory.endsWith('/package') && !directory.endsWith('\\package')) {
        const sep = directory.includes('/') ? '/' : '\\';
        const candidate = `${directory}${sep}package`;
        data = await api('/api/authoring/inspect', { directory: candidate, ...env() });
        directory = candidate;
      } else {
        throw err;
      }
    }
    const authoring = data.authoring ?? data, sourceDirectory = authoring.directory ?? directory;
    const existing = !ignoreSavedDraft && extra.drafts.find(draft => sameDirectory(draft.directory, sourceDirectory));
    if (existing) {
      await restoreDraft(existing);
    } else {
      extra.directory = sourceDirectory;
      extra.authoring = authoring;
      extra.edited = structuredClone(extra.authoring.pack);
      extra.replacements.clear();
      extra.comments = null;
      extra.derived = null;
      extra.removedBinding = null;
      extra.draftStatus = '';
      extra.draftError = '';
      extra.resetCreator = true;
      extra.creatorTab = 'assembly';
    }
    if (onLoaded) await onLoaded();
    else renderCreator();
  }

  async function openCreatorFromPrograms({ tab = 'assembly' } = {}) {
    if (extra.loading.has('global-assembly')) return;
    extra.loading.add('global-assembly');
    try {
      if (extra.edited) {
        captureForms($('#creator-content'));
        await saveDraft();
      }
      const snapshot = await api('/api/programs/assembly', {});
      await loadPackIntoCreator(snapshot.directory, () => {
        const draftPlan = extra.assembly && sameDirectory(extra.assembly.directory, extra.directory) ? extra.assembly.startupPlan : null;
        extra.assembly = { ...snapshot, directory: extra.directory, startupPlan: structuredClone(draftPlan ?? snapshot.startupPlan ?? { onFailure: 'continue-independent' }), savedStartupPlan: structuredClone(snapshot.startupPlan ?? { onFailure: 'continue-independent' }) };
        extra.runtimeAssembly = null;
        extra.creatorTab = tab;
        navigate('creator');
      });
      await saveDraft();
      toast(say('已载入本机 Hub 的受管模块、接线与公开参数。当前运行配置保持原样。', 'Managed modules, bindings, and public settings loaded. Current running configuration is unchanged.'));
    } catch (failure) { showFailure(failure); }
    finally { extra.loading.delete('global-assembly'); }
  }
  async function inspectSavedStartupPack(instanceId) {
    const instance = (state.instances ?? []).find(row => idOf(row) === instanceId);
    if (!instance?.packageDirectory) throw new Error(say('找不到原实例的已保存来源；无法恢复当前版本的默认启动计划。', 'The original instance saved source is unavailable; its current startup defaults cannot be checked.'));
    const response = await api('/api/authoring/inspect', { directory: instance.packageDirectory, ...env() });
    const pack = (response.authoring ?? response).pack;
    if (!pack?.components) throw new Error(say('已保存来源没有返回完整启动声明。', 'The saved source did not return complete startup declarations.'));
    return structuredClone(pack);
  }
  async function openCreatorFromInstance(instanceId, { throwOnFailure = false, tab = 'assembly' } = {}) {
    try{
      if(extra.edited){captureForms($('#creator-content'));await saveDraft();}
      const snapshot=await api(`/api/instances/${encodeURIComponent(instanceId)}/assembly/snapshot`,{});
      const savedStartupPack=await inspectSavedStartupPack(instanceId);
      await loadPackIntoCreator(snapshot.directory,()=>{
        extra.assembly=null;
        extra.runtimeAssembly={directory:extra.directory,origin:snapshot.origin,stateRequirements:snapshot.stateRequirements??[],savedStartupPack};
        extra.creatorTab=tab;navigate('creator');
      });
      await saveDraft();
      toast(say('已载入本次运行的实际装配；可另存，或停止后审阅保存到原实例。','Loaded the actual run composition. Save as new, or stop and review saving it to the original instance.'));
    }catch(failure){if(throwOnFailure)throw failure;showFailure(failure);}
  }

  async function openCreatorForPack(instance, { tab = 'assembly' } = {}) {
    if (exitUnconfirmed(instance) || ['running', 'starting', 'stopping'].includes(instance.status?.state)) return openCreatorFromInstance(idOf(instance), { throwOnFailure: true, tab });
    if (!instance.packageDirectory) throw new Error(say('此实例没有可用的真实来源目录，请重新检查。', 'No exact source directory is available for this instance. Inspect it again.'));
    if (extra.edited) { captureForms($('#creator-content')); await saveDraft(); }
    await loadPackIntoCreator(instance.packageDirectory, () => {
      extra.assembly = null; extra.runtimeAssembly = null; extra.creatorTab = tab; navigate('creator');
    });
  }

  function openSelectPackModal(mod, instances) {
    const dialog = el('dialog', { class: 'dialog add-to-pack-dialog', 'aria-label': say('选择要装配的整合包', 'Select a pack for composition') });
    const closeBtn = closeButton(dialog);

    const title = mod.title || friendlyModuleName(mod.id);
    const body = el('div', { class: 'stack' }, [
      el('p', { class: 'field-help' }, say(`请选择要将功能模块「${title}」添加到哪个整合包工程：`, `Select a pack to add module "${title}" to:`)),
      ...instances.map(inst => {
        const dir = inst.packageDirectory || inst.directory;
        return el('div', { class: 'add-module-item' }, [
          el('div', { class: 'add-module-item-left' }, [
            renderSquareArt({ tone: 'blue', fallbackIcon: 'hubs' }),
            el('div', { class: 'add-module-item-ident' }, [
              el('div', { class: 'add-module-item-title-row' }, [
                el('strong', { class: 'add-module-item-title' }, inst.manifest?.title || inst.id || inst.instanceId)
              ]),
              el('div', { class: 'add-module-item-sub mono subtle' }, dir)
            ])
          ]),
          el('div', { class: 'add-module-item-right' }, [
            button(say('装配到此包', 'Add to Pack'), async () => {
              dialog.close();
              await loadPackIntoCreator(dir, async () => {
                navigate('creator');
                await addComponentToPack(mod);
              });
            }, 'button button-primary button-small add-module-action-btn')
          ])
        ]);
      })
    ]);

    dialog.append(
      el('div', { class: 'dialog-header' }, [
        el('h3', {}, say('添加到整合包', 'Add to Pack')),
        closeBtn
      ]),
      body
    );
    document.body.append(dialog);
    dialog.showModal();
  }

  async function addModuleToPackFlow(mod) {
    if (extra.edited) {
      navigate('creator');
      await addComponentToPack(mod);
      return;
    }
    const instances = (state.instances ?? []).filter(i => i.packageDirectory || i.directory);
    if (instances.length === 0) {
      navigate('creator');
      throw new Error(say('先在工作台打开一个本机整合包，或检查真实模板生成新包后再添加模块。', 'Open a local pack in the workbench, or inspect a real template and generate a pack before adding a module.'));
    }
    if (instances.length === 1) {
      const dir = instances[0].packageDirectory || instances[0].directory;
      await loadPackIntoCreator(dir, async () => {
        navigate('creator');
        await addComponentToPack(mod);
      });
      return;
    }
    openSelectPackModal(mod, instances);
  }

  async function addModuleToGlobalHubFlow(mod) {
    if (extra.assembly) {
      navigate('creator');
      await addComponentToPack(mod);
      return;
    }
    const { programs } = await api('/api/programs');
    if (!programs.length) {
      await deploymentUi.register(mod);
      return;
    }
    await openCreatorFromPrograms();
    navigate('creator');
    await addComponentToPack(mod);
  }

  function openAddModuleModal() {
    const dialog = el('dialog', { class: 'dialog add-module-dialog', 'aria-label': say('添加功能模块到工作台', 'Add a module to Creator') });
    const closeBtn = closeButton(dialog);

    const availableModules = getModules();

    async function addChosen(mod) {
      dialog.close();
      await addComponentToPack(mod);
    }

    const cardRecords = availableModules.map(mod => {
      const kind = runtimeKind(mod);
      const isPython = kind === 'python';
      const runtimeBadge = el('span', { class: `runtime-kind-chip ${isPython ? 'badge-python' : kind === 'node' ? 'badge-node' : ''}` }, runtimeLabel(mod));
      const title = mod.title || friendlyModuleName(mod.id);
      const providesList = Array.isArray(mod.provides) ? mod.provides.map(p => typeof p === 'string' ? p : p.id) : [];
      const requiresList = Array.isArray(mod.requires) ? mod.requires.map(r => typeof r === 'string' ? r : r.id) : [];

      const avatar = createModuleAvatar(mod, 36);

      const ident = el('div', { class: 'add-module-item-ident' }, [
        el('div', { class: 'add-module-item-title-row' }, [
          el('strong', { class: 'add-module-item-title' }, title),
          runtimeBadge,
          mod.version ? el('span', { class: 'pill pill-subtle mono' }, `v${mod.version}`) : null
        ].filter(Boolean)),
        el('div', { class: 'add-module-item-sub mono subtle' }, [
          el('span', { class: 'add-module-id' }, mod.id),
          (mod.path || mod.description) ? el('span', { class: 'subtle-dot' }, '·') : null,
          mod.path ? el('span', { class: 'add-module-path', title: mod.path }, mod.path)
            : (mod.description ? el('span', { class: 'add-module-desc', title: mod.description }, mod.description) : null)
        ].filter(Boolean))
      ]);

      const contracts = el('div', { class: 'add-module-contracts' }, [
        ...providesList.map(c => pill(c, 'teal')),
        ...requiresList.map(c => pill(c, 'amber'))
      ]);

      const addBtn = button(say('装配此模块', 'Add to Assembly'), () => addChosen(mod), 'button button-primary button-small add-module-action-btn');

      const card = el('div', { class: 'add-module-item' }, [
        el('div', { class: 'add-module-item-left' }, [
          avatar,
          ident
        ]),
        el('div', { class: 'add-module-item-right' }, [
          contracts,
          addBtn
        ])
      ]);

      const searchText = [
        title,
        mod.id,
        kind ?? '',
        ...providesList,
        ...requiresList,
        mod.path ?? '',
        mod.description ?? ''
      ].join(' ').toLowerCase();

      return { el: card, text: searchText };
    });

    const searchInput = el('input', {
      type: 'search',
      class: 'input add-module-search-input',
      placeholder: say('搜索模块名称、ID 或契约…', 'Search module name, ID, or contract…'),
      'aria-label': say('搜索模块', 'Search modules')
    });

    const countBadge = el('span', { class: 'pill pill-subtle mono add-module-count-badge' }, `${availableModules.length}`);

    const searchBox = el('div', { class: 'add-module-search-box' }, [
      createIcon ? createIcon('search', 'add-module-search-icon') : null,
      searchInput,
      countBadge
    ].filter(Boolean));

    const browseBtn = button([
      createIcon ? createIcon('folder', 'button-icon') : null,
      say('从本地目录浏览选择模块…', 'Browse local module directory…')
    ].filter(Boolean), () => {
      if (ctx.openPathPicker) {
        const dummy = el('input', { type: 'hidden' });
        dummy.addEventListener('change', async () => {
          if (dummy.value) {
            try {
              const res = await api('/api/paths/check', { path: dummy.value, purpose: 'module' });
              if (res?.object && res.object.kind === 'module') {
                dialog.close();
                await addComponentToPack({
                  id: res.object.id ?? 'custom.module',
                  title: res.object.title,
                  path: res.path,
                  runtime: res.object.runtime,
                  provides: res.object.provides ?? [],
                  requires: res.object.requires ?? []
                });
              } else {
                toast(say('所选目录不是有效的模块目录（缺少合法的 module.json）', 'Selected folder is not a valid module folder (missing valid module.json)'));
              }
            } catch (err) {
              toast(err.message);
            }
          }
        });
        document.body.append(dummy);
        ctx.openPathPicker(dummy, 'module');
      }
    }, 'button button-quiet add-module-browse-btn');

    const toolbar = el('div', { class: 'add-module-toolbar' }, [
      searchBox,
      browseBtn
    ]);

    const noResultsNote = el('p', { class: 'subtle empty-note add-module-no-match', style: 'display: none;' }, say('未找到匹配的功能模块。', 'No matching modules found.'));
    const emptyListNote = el('p', { class: 'subtle empty-note' }, say('暂无可用模块，请点击上方按钮从本地目录选择。', 'No available modules found. Browse from a local directory above.'));

    const listContainer = el('div', { class: 'add-module-list' }, cardRecords.length ? [
      ...cardRecords.map(r => r.el),
      noResultsNote
    ] : [
      emptyListNote
    ]);

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      let matchCount = 0;
      for (const rec of cardRecords) {
        const matched = !q || rec.text.includes(q);
        if (rec.el.style) rec.el.style.display = matched ? '' : 'none';
        else rec.el.hidden = !matched;
        if (matched) matchCount++;
      }
      countBadge.textContent = q ? `${matchCount} / ${cardRecords.length}` : `${cardRecords.length}`;
      if (noResultsNote.style) noResultsNote.style.display = (matchCount === 0 && cardRecords.length > 0) ? '' : 'none';
      else noResultsNote.hidden = !(matchCount === 0 && cardRecords.length > 0);
    });

    const content = el('div', { class: 'add-module-modal-content' }, [
      el('p', { class: 'dialog-description' }, say('从本地已识别的模块库中选择，或直接从本机文件夹浏览引入功能模块。', 'Choose from your local module library, or browse a local folder.')),
      toolbar,
      listContainer
    ]);

    dialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [
        el('h3', {}, say('添加功能模块到工作台', 'Add Module to Workbench')),
        closeBtn
      ]),
      content
    );

    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  function graph() {
    const pack = extra.edited, graph = el('div', { class: 'composition-graph', role: 'group', 'aria-label': say('当前模块与能力绑定图', 'Current modules and capability bindings') });
    const selected = extra.compositionComponent, associated = new Set(pack.bindings.filter(binding => binding.from === selected || binding.to === selected).flatMap(binding => [binding.from, binding.to]));

    // Scrollable Single-line Modules List
    const nodesScrollWrap = el('div', { class: 'composition-nodes-scroll-wrap' });
    const nodesBar = el('div', { class: 'composition-nodes-bar' }, [
      el('div', { class: 'composition-nodes-bar-info' }, [
        el('span', {}, `${pack.components.length} ${say('个功能模块已载入 · 单击整行快速选中', 'modules loaded · click row to select')}`),
        el('span', { class: 'mono subtle' }, `${say('当前焦点', 'Focused')}: ${selected}`)
      ]),
      el('div', { class: 'composition-nodes-bar-actions' }, [
        button([
          createIcon ? createIcon('plus', 'button-icon') : null,
          say('添加模块', 'Add Module')
        ].filter(Boolean), () => openAddModuleModal(), 'button button-small button-primary node-add-trigger-btn')
      ])
    ]);
    nodesScrollWrap.append(nodesBar);

    const nodes = el('div', { class: 'composition-nodes' });
    for (const component of pack.components) {
      const manifest = currentModule(component);
      const isSelected = component.id === selected;
      const isRelated = associated.has(component.id);

      const providesList = manifest?.provides ?? [];
      const requiresList = manifest?.requires ?? [];

      const removeBtn = button([
        createIcon ? createIcon('trash', 'icon-sm') : '✕'
      ], (e) => {
        e.stopPropagation();
        confirmRemoveComponent(component.id);
      }, 'icon-button composition-node-delete-btn', false, {
        title: say(`从装配中移除模块 ${component.id}`, `Remove module ${component.id}`),
        'aria-label': say(`删除模块 ${component.id}`, `Delete module ${component.id}`)
      });
      removeBtn.setAttribute('aria-label', say(`删除模块 ${component.id}`, `Delete module ${component.id}`));

      const rowLead = el('div', { class: 'composition-node-row-lead' }, [
        el('span', { class: 'composition-node-indicator', 'aria-hidden': 'true' }),
        createModuleAvatar(manifest ?? component, 24),
        el('strong', { class: 'composition-node-id mono' }, component.id),
        pill(manifest?.runtime?.kind ?? component.module, 'teal'),
        el('span', { class: 'mono subtle composition-node-module-id' }, manifest?.id ?? component.module)
      ]);
      const occurrenceFlags = paradigms.memberFlags(component, pack);
      if(occurrenceFlags.length){
        rowLead.classList.add('has-lifecycle-flags');
        rowLead.append(el('div',{class:'composition-node-lifecycle-flags'},occurrenceFlags));
      }

      const editSettingsBtn = button(say('修改公开配置', 'Edit public settings'), (e) => {
        e?.stopPropagation?.();
        editComponent(component.id);
      }, 'button button-small button-quiet composition-node-settings-btn', false, {
        title: say(`修改模块 ${component.id} 的公开配置`, `Edit public settings for module ${component.id}`),
        'aria-label': say(`修改模块 ${component.id} 公开配置`, `Edit public settings for module ${component.id}`)
      });

      const rowActions = el('div', { class: 'composition-node-actions' }, [editSettingsBtn, removeBtn]);

      const row = el('article', {
        class: `composition-node${isSelected ? ' selected' : isRelated ? ' related' : ''}`,
        role: 'button',
        tabindex: '0',
        'aria-pressed': String(isSelected),
        'aria-label': `${component.id} (${manifest?.id ?? component.module})`
      }, [
        rowLead,
        el('div', { class: 'composition-node-contracts-summary' }, [
          ...providesList.map(contract => el('span', { class: 'permission permission-tag provides', title: `${say('提供契约', 'Provides contract')}: ${contract.id}@${contract.version}` }, `↑ ${contract.id}@${contract.version}`)),
          ...requiresList.map(contract => el('span', { class: 'permission permission-tag requires', title: `${say('要求契约', 'Requires contract')}: ${contract.id}@${contract.version}` }, `↓ ${contract.id}@${contract.version}`)),
          !providesList.length && !requiresList.length ? el('span', { class: 'field-help subtle' }, say('无额外契约', 'No contracts')) : null
        ].filter(Boolean)),
        rowActions
      ]);

      row.addEventListener('click', () => {
        extra.compositionComponent = component.id;
        renderCreator();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          extra.compositionComponent = component.id;
          renderCreator();
        }
      });

      nodes.append(row);
    }

    const addCard = button([
      createIcon ? createIcon('plus', 'icon-sm') : '+',
      say(' ＋ 添加模块到装配…', ' ＋ Add Module to Assembly…')
    ], () => openAddModuleModal(), 'composition-node-add-card');
    nodes.append(addCard);

    nodesScrollWrap.append(nodes);
    graph.append(nodesScrollWrap);

    // Semantic bindings data for accessibility and test consistency
    const a11yBindings = el('div', { class: 'sr-only', 'aria-hidden': 'true' }, pack.bindings.map(b => `${b.from}→${b.to}${b.contract.id}@${b.contract.version}`));
    graph.append(a11yBindings);

    return graph;
  }
  function bindingForm(selectedId) {
    const pack = extra.edited;
    const comps = pack.components;

    // Helper: find all exact contract matches between a base module and all other modules in pack
    function getMatchesFor(baseId) {
      const baseComp = comps.find(c => c.id === baseId);
      if (!baseComp) return [];
      const baseManifest = currentModule(baseComp);
      const baseProvides = contracts(baseManifest);
      const baseRequires = baseManifest?.requires ?? [];

      const list = [];
      for (const other of comps) {
        if (other.id === baseId) continue;
        const otherManifest = currentModule(other);
        const otherProvides = contracts(otherManifest);
        const otherRequires = otherManifest?.requires ?? [];

        // 1. other provides to base (other is upstream provider)
        const incoming = otherProvides.filter(p => baseRequires.some(r => r.id === p.id && r.version === p.version));
        if (incoming.length) {
          list.push({
            otherId: other.id,
            role: 'upstream',
            fromId: other.id,
            toId: baseId,
            contracts: incoming
          });
        }

        // 2. base provides to other (other is downstream consumer)
        const outgoing = baseProvides.filter(p => otherRequires.some(r => r.id === p.id && r.version === p.version));
        if (outgoing.length) {
          list.push({
            otherId: other.id,
            role: 'downstream',
            fromId: baseId,
            toId: other.id,
            contracts: outgoing
          });
        }
      }
      return list;
    }

    const initialBase = (comps.some(c => c.id === extra.compositionComponent) ? extra.compositionComponent : null)
      || (comps.some(c => c.id === selectedId) ? selectedId : null)
      || comps[0]?.id || '';

    const baseSelect = el('select', { name: 'baseModule', 'aria-label': say('当前选中的基准模块', 'Selected base module') },
      comps.map(c => el('option', { value: c.id, selected: c.id === initialBase }, `${c.id} (${c.module})`))
    );

    const targetSelect = el('select', { name: 'targetModule', 'aria-label': say('完全匹配的目标模块', 'Completely matching target module') });
    const contractSelect = el('select', { name: 'contract', 'aria-label': say('双方匹配的能力合同', 'Matching capability contract') });
    const flowPreview = el('div', { class: 'binding-flow-preview' });

    let currentMatches = [];
    let activeMatch = null;

    function refreshTargets() {
      const baseId = baseSelect.value;
      currentMatches = getMatchesFor(baseId);

      if (!currentMatches.length) {
        targetSelect.replaceChildren(
          el('option', { value: '', disabled: true, selected: true }, say(`（当前整合包中暂无可与「${baseId}」匹配连线的其他模块）`, `(No compatible modules matching with "${baseId}" in current pack)`))
        );
        targetSelect.disabled = true;
        activeMatch = null;
        refreshContracts();
        return;
      }

      targetSelect.disabled = false;
      targetSelect.replaceChildren(...currentMatches.map((m, idx) => {
        const contractsSummary = m.contracts.map(c => `${c.id}@${c.version}`).join(', ');
        const labelText = m.role === 'upstream'
          ? say(`📥 ${m.otherId} (作为上游提供方 · 供给 ${contractsSummary})`, `📥 ${m.otherId} (as Upstream Provider · provides ${contractsSummary})`)
          : say(`📤 ${m.otherId} (作为下游使用方 · 需 ${contractsSummary})`, `📤 ${m.otherId} (as Downstream Consumer · requires ${contractsSummary})`);
        return el('option', { value: String(idx), selected: idx === 0 }, labelText);
      }));

      activeMatch = currentMatches[0] || null;
      refreshContracts();
    }

    function refreshContracts() {
      if (!activeMatch || !activeMatch.contracts.length) {
        contractSelect.replaceChildren(
          el('option', { value: '', disabled: true, selected: true }, say('（两模块之间暂无完全匹配的能力合同）', '(No matching capability contracts between selected modules)'))
        );
        contractSelect.disabled = true;
        flowPreview.replaceChildren(
          el('div', { class: 'subtle' }, say('请选择上方存在兼容契约的模块以建立连线。', 'Select matching modules above to establish connection.'))
        );
        return;
      }

      contractSelect.disabled = false;
      contractSelect.replaceChildren(...activeMatch.contracts.map((c, idx) => {
        const isBound = pack.bindings.some(b => b.from === activeMatch.fromId && b.to === activeMatch.toId && b.contract.id === c.id);
        const boundTag = isBound ? say(' [已建立连线]', ' [Already Connected]') : '';
        return el('option', {
          value: JSON.stringify({ id: c.id, version: c.version }),
          selected: idx === 0
        }, `${c.id}@${c.version}${boundTag}`);
      }));

      updateFlowState();
    }

    function updateFlowState() {
      if (!activeMatch || !contractSelect.value) {
        flowPreview.replaceChildren();
        return;
      }
      let c;
      try { c = JSON.parse(contractSelect.value); } catch { return; }
      const isBound = pack.bindings.some(b => b.from === activeMatch.fromId && b.to === activeMatch.toId && b.contract.id === c.id);

      flowPreview.replaceChildren(
        el('div', { class: 'binding-flow-badge-row' }, [
          el('span', { class: 'flow-node provider' }, `📤 ${activeMatch.fromId}`),
          el('span', { class: 'flow-arrow', 'aria-hidden': 'true' }, '➔'),
          el('span', { class: 'flow-node consumer' }, `📥 ${activeMatch.toId}`),
          el('span', { class: 'flow-contract' }, `${c.id}@${c.version}`),
          isBound
            ? el('span', { class: 'pill pill-accent' }, say('已建立连线 (可在上方切断)', 'Already connected'))
            : el('span', { class: 'pill pill-teal' }, say('✨ 契约完全吻合 · 就绪可连', 'Ready to connect'))
        ])
      );
    }

    baseSelect.addEventListener('change', () => {
      extra.compositionComponent = baseSelect.value;
      refreshTargets();
    });

    targetSelect.addEventListener('change', () => {
      const idx = parseInt(targetSelect.value, 10);
      activeMatch = currentMatches[idx] || null;
      refreshContracts();
    });

    contractSelect.addEventListener('change', updateFlowState);

    refreshTargets();

    return form([
      el('div', { class: 'field-grid' }, [
        el('label', {}, [say('当前选中的基准模块', 'Selected Base Module'), baseSelect]),
        el('label', {}, [say('完全匹配的目标模块 (智能匹配)', 'Completely Matching Target Module'), targetSelect])
      ]),
      el('label', {}, [say('双方匹配的能力合同', 'Matching Capability Contract'), contractSelect]),
      flowPreview
    ], say('添加模块能力连线', 'Connect Capability Contract'), async f => {
      if (!activeMatch || !contractSelect.value) {
        throw new Error(say('请选择两个存在匹配合同的模块。', 'Select two modules with a matching contract.'));
      }
      const binding = { from: activeMatch.fromId, to: activeMatch.toId, contract: JSON.parse(contractSelect.value) };
      if (pack.bindings.some(b => JSON.stringify(b) === JSON.stringify(binding))) {
        throw new Error(say('该通信连线已存在。', 'This binding already exists.'));
      }
      pack.bindings.push(binding);
      scheduleDraft();
      renderCreator();
    }, say('只展示与选中模块在契约 ID 及版本上 100% 完全匹配的模块，杜绝盲目试错；派生时后台再次检查依赖、槽与所有绑定。', 'Only modules with 100% exact contract ID and version match to the selected module are shown, eliminating guesswork. The backend revalidates dependencies, slots, and all bindings when deriving.'));
  }
  function readableDeclaration(value) {
    if (value === undefined || value === null) return say('未声明', 'Not declared');
    if (Array.isArray(value)) return value.length ? value.map(readableDeclaration).join(' · ') : say('无', 'None');
    if (typeof value === 'object') {
      if (!Object.keys(value).length) return say('无', 'None');
      if (value.id && value.version && Object.keys(value).every(key => ['id', 'version'].includes(key))) return `${value.id}@${value.version}`;
      const names = { provides: ['提供', 'Provides'], requires: ['要求', 'Requires'], kind: ['解释器', 'Interpreter'], entry: ['入口', 'Entry'], filesystem: ['文件访问', 'File access'], network: ['网络访问', 'Network access'], processes: ['子进程', 'Child processes'], after: ['在这些模块后启动', 'Starts after'], components: ['在这些模块后启动', 'Starts after'], contracts: ['要求的能力合同', 'Required contracts'], requirements: ['解释器依赖声明', 'Interpreter dependency declaration'] };
      return Object.entries(value).map(([key, item]) => `${names[key] ? say(...names[key]) : key}: ${readableDeclaration(item)}`).join(' · ');
    }
    return String(value);
  }
  function diagnosticView(diagnostic) {
    const reasons = {
      PLATFORM_UNSUPPORTED: ['候选模块没有声明支持当前平台。', 'The candidate does not declare support for this platform.'],
      BRIDGE_SLOTS_MISMATCH: ['候选桥槽与模块接线不同，需要作者适配。', 'Candidate bridge slots differ from this module’s wiring and require author adaptation.'],
      CONTRACT_UNBOUND: ['候选要求的能力尚未连到提供者（可在画布中连接提供者）。', 'A capability required by the candidate is not connected to a provider yet (can be wired on the canvas).'],
      CONTRACT_INCOMPATIBLE: ['双方合同 ID 或精确版本不匹配。', 'The contract ID or exact version does not match between components.'],
      RUNTIME_UNAVAILABLE: ['所需解释器不可用，请到环境页选择并检测。', 'The required interpreter is unavailable. Select and check it in Environment.'],
      RUNTIME_INCOMPATIBLE: ['候选解释器或依赖与当前环境不匹配。', 'The candidate interpreter or dependencies do not match this environment.'],
      DEPENDENCY_UNAVAILABLE: ['候选依赖不可用，请先准备匹配环境。', 'A candidate dependency is unavailable. Prepare a matching environment first.'],
      INTERPRETER_UNAVAILABLE: ['所需解释器不可用，请到环境页选择并检测。', 'The required interpreter is unavailable. Select and check it in Environment.'],
      INTERPRETER_VERSION: ['所选解释器版本不符合 SDK 要求，请选择支持的解释器。', 'The selected interpreter version does not meet SDK requirements. Choose a supported interpreter.'],
      DEPENDENCY_MISMATCH: ['候选声明的依赖版本与所选环境不同，请准备匹配环境。', 'The candidate’s declared dependency version differs from the selected environment. Prepare a matching environment.'],
      DEPENDENCY_ORDER_INVALID: ['模块启动顺序不满足依赖，需要作者调整。', 'The module startup order does not satisfy its dependencies and requires author changes.']
    };
    const isUnboundOnly = ['CONTRACT_UNBOUND', 'TOPIC_ALIASES_INVALID'].includes(diagnostic.code);
    return el('div', { class: `notice${isUnboundOnly ? '' : ' notice-warning'}` }, [el('strong', {}, reasons[diagnostic.code] ? say(...reasons[diagnostic.code]) : diagnostic.message ?? diagnostic.code), el('p', { class: 'field-help' }, [diagnostic.componentId, diagnostic.moduleId, diagnostic.code].filter(Boolean).join(' · '))]);
  }
  function replacementView(preview, component) {
    const declarationCompatible = preview.declarationCompatible ?? preview.compatible;
    const compatible = preview.compatible === true;
    const hasOnlyContractUnbound = (preview.diagnostics ?? []).length > 0 && (preview.diagnostics ?? []).every(item => ['CONTRACT_UNBOUND', 'TOPIC_ALIASES_INVALID'].includes(item.code));
    const unsupported = preview.environmentCompatible === false || (preview.diagnostics ?? []).some(item => item.layer === 'environment' || ['PLATFORM_UNSUPPORTED', 'RUNTIME_UNAVAILABLE', 'RUNTIME_INCOMPATIBLE', 'DEPENDENCY_UNAVAILABLE'].includes(item.code));
    const status = compatible ? say('精确声明匹配；业务未经验证', 'Exact declarations match; business behavior unverified') : hasOnlyContractUnbound ? say('契约尚未接线，可在画布中连接提供者', 'Contract unbound; connect a provider on the canvas') : declarationCompatible && unsupported ? say('声明匹配；当前环境不可运行', 'Declarations match; current environment cannot run it') : unsupported ? say('当前平台或运行环境不兼容', 'Incompatible platform or runtime environment') : say('需要作者人工适配', 'Author adaptation required');
    const names = { identity: ['模块身份', 'Module identity'], contracts: ['能力合同', 'Capability contracts'], bridges: ['桥槽', 'Bridge slots'], permissions: ['声明权限', 'Declared permissions'], platforms: ['支持平台', 'Supported platforms'], runtime: ['运行入口', 'Runtime entry'], license: ['许可证', 'License'], startupDependencies: ['启动依赖', 'Startup dependencies'] };
    const changes = Object.entries(preview.differences ?? {}).map(([key, change]) => el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, names[key] ? say(...names[key]) : key), el('p', { class: 'field-help' }, `${say('原来', 'Before')}: ${readableDeclaration(change.before)}`), el('p', { class: 'field-help' }, `${say('候选', 'Candidate')}: ${readableDeclaration(change.after)}`)]), pill(change.changed ? say('有变化', 'Changed') : say('相同', 'Unchanged'))]));
    if (!Object.hasOwn(preview.differences ?? {}, 'startupDependencies')) changes.push(el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, say('模块启动依赖', 'Module startup dependencies')), el('p', { class: 'field-help' }, readableDeclaration(component?.after ?? []))]), pill(say('本次保持原配置', 'Existing configuration retained'))]));
    const sourceReceipt = preview.candidate?.directory === extra.moduleCandidate ? extra.moduleCandidateReceipt : null;
    return [note(status, !compatible && !hasOnlyContractUnbound), definition([[say('实际候选', 'Actual candidate'), `${preview.candidate?.manifest?.id ?? '—'}@${preview.candidate?.manifest?.version ?? '—'}`], [say('影响模块', 'Affected modules'), (preview.affectedComponents ?? []).join(', ') || component?.id], [say('内容摘要', 'Content digest'), preview.candidateDigest], [say('来源观察', 'Source observation'), sourceReceipt ? say('已有软件源获取收据；身份由来源声明', 'A source retrieval receipt exists; publisher identity is source-declared') : say('本地目录；发布者身份尚未验证', 'Local directory; publisher identity unverified')], [say('执行授权', 'Execution authorization'), say('尚未授予；派生后逐实例审阅', 'Not granted; review each derived instance')], [say('业务与状态', 'Business & state'), say('未运行候选；数据格式兼容未知', 'Candidate not executed; data format compatibility unknown')]]), ...(preview.diagnostics ?? []).map(diagnosticView), ...changes,
      ...(preview.environment ? [definition([[say('所选解释器', 'Selected interpreter'), preview.environment.interpreter?.available ? `${preview.environment.runtime} ${preview.environment.interpreter.version} · ${preview.environment.interpreter.executable}` : say('不可用', 'Unavailable')], [say('已检查的 SDK 依赖', 'Checked SDK dependencies'), readableDeclaration(preview.environment.interpreter?.packages ?? {})], [say('其他应用依赖', 'Other application dependencies'), preview.environment.otherDependenciesChecked ? say('已检查', 'Checked') : say('未验证；由程序作者另行验收', 'Unverified; program authors must validate them')]]), jsonView(say('所选解释器与依赖检查', 'Selected interpreter and dependency checks'), preview.environment)] : []),
      note(say('声明检查只证明这份接线可以成立。新实例健康或桥连接成功仍不能证明业务正确；请运行对应合同的应用验收。新目录派生不迁移旧实例数据，不撤销外部 API、已发消息或其他程序状态。', 'Declaration checks establish this wiring only. Instance health or bridge connection does not prove business correctness; run the application acceptance for the contract. Deriving into a new directory does not migrate old instance data or undo external APIs, sent messages, or other programs’ state.')),
      ...(!compatible && !hasOnlyContractUnbound ? [button(say('准备或选择环境', 'Prepare or select environment'), () => navigate('environment'), 'button button-small button-quiet'), note(say('可以更换候选或取消本次预览。若需要改合同或桥槽，请交由模块作者适配后重新检查。', 'Choose another candidate or cancel this preview. Ask the module author to adapt incompatible contracts or bridge slots, then check again.'))] : hasOnlyContractUnbound ? [note(say('该模块要求的能力契约尚未连接到提供者。可以先加入草稿，稍后在通信画布中添加提供者模块并连线。', 'The required capability contracts are not yet connected. You can add it to the draft first, and wire them on the canvas after adding a provider module.'))] : []), jsonView(say('查看技术诊断', 'View technical diagnostics'), preview)].filter(Boolean);
  }
  function sameReplacementReview(previous, next) {
    return previous?.candidateDigest === next.candidateDigest && previous?.candidate?.directory === next.candidate?.directory && previous?.sourceRevision === next.sourceRevision && JSON.stringify(previous?.differences) === JSON.stringify(next.differences) && JSON.stringify(previous?.environment) === JSON.stringify(next.environment) && JSON.stringify(previous?.component) === JSON.stringify(next.component);
  }
  const candidateSources = () => [...extra.replacements.values()].map(({ componentId, moduleDirectory }) => ({ componentId, moduleDirectory }));
  const previewInput = (componentId, moduleDirectory, pack = extra.edited) => ({ directory: extra.directory, componentId, moduleDirectory, pack, replacements: candidateSources(), expectedRevision: extra.authoring.revision, ...env() });
  async function recheckDraftCandidates() {
    for (const row of extra.replacements.values()) {
      const { preview } = await api('/api/authoring/preview', previewInput(row.componentId, row.moduleDirectory));
      const unchanged = sameReplacementReview(row.preview, preview); row.preview = preview;
      if (!preview.compatible) throw new Error(say('草稿有未通过的模块、主题权限、依赖或合同检查；请修正后再生成。', 'A module, topic ACL, dependency, or contract check failed. Correct the draft before generating a pack.'));
      if (!unchanged) { scheduleDraft(); renderCreator(); throw new Error(say('候选内容或配置已变化，预检记录已更新。请审阅后再次生成。', 'Candidate content or configuration changed. Preflight records were refreshed; review them before generating again.')); }
    }
  }
  function getCompatibleModulesFor(targetCompId) {
    const pack = extra.edited;
    if (!pack) return [];
    const comp = pack.components.find(c => c.id === targetCompId);
    if (!comp) return [];
    const compManifest = currentModule(comp);
    const available = getModules();

    const outgoing = pack.bindings.filter(b => b.from === comp.id);
    const incoming = pack.bindings.filter(b => b.to === comp.id);
    const compProvides = contracts(compManifest);

    return available.filter(mod => {
      if (!mod || !mod.path) return false;
      const currentDir = extra.replacements.get(comp.id)?.moduleDirectory ?? compManifest?.path;
      if (currentDir && sameDirectory(mod.path, currentDir)) return false;

      const modProvides = (mod.provides ?? []).map(p => typeof p === 'string' ? { id: p, version: '1.0.0' } : p);
      const modRequires = (mod.requires ?? []).map(r => typeof r === 'string' ? { id: r, version: '1.0.0' } : r);

      for (const b of outgoing) {
        const match = modProvides.some(p => p.id === b.contract.id && (!b.contract.version || p.version === b.contract.version));
        if (!match) return false;
      }

      if (outgoing.length === 0 && compProvides.length > 0) {
        const match = compProvides.every(cp => modProvides.some(p => p.id === cp.id && (!cp.version || p.version === cp.version)));
        if (!match) return false;
      }

      for (const b of incoming) {
        if (modRequires.length > 0) {
          const match = modRequires.some(r => r.id === b.contract.id && (!b.contract.version || r.version === b.contract.version));
          if (!match) return false;
        }
      }

      return true;
    });
  }
  function replacementPanel() {
    const choices = extra.edited.components;
    const pack = extra.edited;
    const chosen = choices.find(component => component.id === extra.compositionComponent) ?? choices.find(component => currentModule(component)?.provides?.length) ?? choices[0];
    extra.compositionComponent = chosen.id;

    const target = el('select', {
      name: 'componentId',
      class: 'input replacement-node-select',
      'aria-label': say('选择要替换的工作流节点', 'Select workflow node to replace')
    }, choices.map(component => el('option', { value: component.id, selected: component.id === chosen.id }, `${component.id} · ${currentModule(component)?.id ?? component.module}`)));
    target.value = chosen.id;

    const results = el('div', { class: 'stack', 'aria-live': 'polite' });
    let checked = null;

    const candidateInput = el('input', {
      type: 'text',
      name: 'moduleDirectory',
      class: 'input module-dir-path-input',
      autocomplete: 'off',
      hidden: true,
      'data-path-enhanced': 'true'
    });

    const originalCardBody = el('div', { class: 'replacement-card-body' });
    const candidateCardBody = el('div', { class: 'replacement-card-body' });

    function updateOriginalCard() {
      const currentTargetId = target.value;
      const comp = choices.find(c => c.id === currentTargetId);
      const mod = currentModule(comp);
      const isPy = (mod?.runtime?.kind === 'python') || (typeof mod?.runtime === 'string' && mod?.runtime?.includes('python'));
      const providesList = (mod?.provides ?? []).map(p => typeof p === 'string' ? p : `${p.id}@${p.version || '1.0.0'}`);
      const requiresList = (mod?.requires ?? []).map(r => typeof r === 'string' ? r : `${r.id}@${r.version || '1.0.0'}`);

      const outgoing = pack.bindings.filter(b => b.from === currentTargetId);
      const incoming = pack.bindings.filter(b => b.to === currentTargetId);

      originalCardBody.replaceChildren(
        el('div', { class: 'replacement-node-hero' }, [
          el('div', { class: 'replacement-node-avatar' }, isPy ? '🐍' : '🟢'),
          el('div', { class: 'replacement-node-main' }, [
            el('div', { class: 'replacement-node-title-row' }, [
              el('strong', { class: 'replacement-node-name mono' }, currentTargetId),
              pill(runtimeLabel(mod), isPy ? 'accent' : 'teal')
            ]),
            el('span', { class: 'replacement-node-module-id mono' }, mod?.id ?? comp?.module)
          ])
        ]),
        el('div', { class: 'replacement-contracts-box' }, [
          el('div', { class: 'replacement-contracts-group' }, [
            el('span', { class: 'subtle' }, say('输出契约 (Provides):', 'Provides:')),
            ...(providesList.length ? providesList.map(p => el('span', { class: 'pill pill-teal mono' }, p)) : [el('span', { class: 'subtle' }, say('无', 'None'))])
          ]),
          el('div', { class: 'replacement-contracts-group' }, [
            el('span', { class: 'subtle' }, say('输入契约 (Requires):', 'Requires:')),
            ...(requiresList.length ? requiresList.map(r => el('span', { class: 'pill mono' }, r)) : [el('span', { class: 'subtle' }, say('无', 'None'))])
          ]),
          el('div', { class: 'replacement-contracts-group' }, [
            el('span', { class: 'subtle' }, say('活动拓扑连线:', 'Active Wiring:')),
            el('span', { class: 'mono subtle' }, `${outgoing.length} ${say('条供出', 'outgoing')} · ${incoming.length} ${say('条接入', 'incoming')}`)
          ])
        ])
      );
    }

    function updateCandidateCard() {
      const currentPath = candidateInput.value.trim();
      const allMods = getModules();
      const foundMod = allMods.find(m => sameDirectory(m.path, currentPath));

      if (foundMod) {
        const isPy = (foundMod.runtime?.kind === 'python') || (typeof foundMod.runtime === 'string' && foundMod.runtime.includes('python'));
        const providesList = (foundMod.provides ?? []).map(p => typeof p === 'string' ? p : `${p.id}@${p.version || '1.0.0'}`);
        const requiresList = (foundMod.requires ?? []).map(r => typeof r === 'string' ? r : `${r.id}@${r.version || '1.0.0'}`);

        candidateCardBody.replaceChildren(
          candidateInput,
          el('div', { class: 'candidate-selected-card' }, [
            el('div', { class: 'candidate-selected-header' }, [
              el('div', { class: 'replacement-node-hero' }, [
                el('div', { class: 'replacement-node-avatar' }, isPy ? '🐍' : '🟢'),
                el('div', { class: 'replacement-node-main' }, [
                  el('div', { class: 'replacement-node-title-row' }, [
                    el('strong', { class: 'replacement-node-name' }, foundMod.title || friendlyModuleName(foundMod.id)),
                    pill(runtimeLabel(foundMod), isPy ? 'accent' : 'teal'),
                    pill(say('声明契约匹配', 'Declared contracts match'), 'teal')
                  ]),
                  el('span', { class: 'replacement-node-module-id mono' }, `${foundMod.id}@${foundMod.version || '1.0.0'}`)
                ])
              ])
            ]),
            el('p', { class: 'candidate-selected-path mono field-help', title: foundMod.path }, foundMod.path),
            el('div', { class: 'replacement-contracts-box' }, [
              el('div', { class: 'replacement-contracts-group' }, [
                el('span', { class: 'subtle' }, say('输出契约 (Provides):', 'Provides:')),
                ...(providesList.length ? providesList.map(p => el('span', { class: 'pill pill-teal mono' }, p)) : [el('span', { class: 'subtle' }, say('无', 'None'))])
              ]),
              el('div', { class: 'replacement-contracts-group' }, [
                el('span', { class: 'subtle' }, say('输入需求 (Requires):', 'Requires:')),
                ...(requiresList.length ? requiresList.map(r => el('span', { class: 'pill mono' }, r)) : [el('span', { class: 'subtle' }, say('无', 'None'))])
              ])
            ])
          ])
        );
      } else if (currentPath) {
        candidateCardBody.replaceChildren(
          candidateInput,
          el('div', { class: 'candidate-selected-card' }, [
            el('div', { class: 'candidate-selected-header' }, [
              el('div', { class: 'replacement-node-hero' }, [
                el('div', { class: 'replacement-node-avatar' }, '📦'),
                el('div', { class: 'replacement-node-main' }, [
                  el('div', { class: 'replacement-node-title-row' }, [
                    el('strong', { class: 'replacement-node-name' }, say('外部候选模块目录', 'External Candidate Directory')),
                    pill(say('已指定路径', 'Path Specified'), 'teal')
                  ]),
                  el('span', { class: 'replacement-node-module-id mono' }, currentPath)
                ])
              ])
            ]),
            el('p', { class: 'candidate-selected-path mono field-help', title: currentPath }, currentPath)
          ])
        );
      } else {
        candidateCardBody.replaceChildren(
          candidateInput,
          el('div', { class: 'candidate-empty-slot' }, [
            el('span', { class: 'candidate-empty-slot-icon' }, '🔄'),
            el('strong', { class: 'candidate-empty-slot-title' }, say('尚未选择替换候选模块', 'No Replacement Module Selected')),
            el('p', { class: 'candidate-empty-slot-desc' }, say('继承性替换要求候选模块必须满足当前节点已有所有输入、输出能力契约及活动接线。请点击上方或下方按钮选择模块：', 'Inherited replacement requires candidates to satisfy all existing input and output contracts of this node.')),
            el('div', { class: 'candidate-empty-slot-actions' }, [
              button(say('选择…', 'Browse…'), (e) => {
                e?.stopPropagation?.();
                if (ctx.openPathPicker) ctx.openPathPicker(candidateInput, 'module');
              }, 'button button-small button-quiet'),
              button(say('从我的', 'From Mine'), (e) => {
                e?.stopPropagation?.();
                openCompatibleModal();
              }, 'button button-small button-primary')
            ])
          ])
        );
      }
    }

    function openCompatibleModal() {
      const currentTargetId = target.value;
      const compatibleMods = getCompatibleModulesFor(currentTargetId);

      let modalDialog = null;
      const listNodes = [];
      if (compatibleMods.length > 0) {
        for (const mod of compatibleMods) {
          const isPy = (mod.runtime?.kind === 'python') || (typeof mod.runtime === 'string' && mod.runtime.includes('python'));
          const providesList = (mod.provides ?? []).map(p => typeof p === 'string' ? p : `${p.id}@${p.version || '1.0.0'}`);
          const requiresList = (mod.requires ?? []).map(r => typeof r === 'string' ? r : `${r.id}@${r.version || '1.0.0'}`);

          const itemNode = el('div', { class: 'compatible-module-item' }, [
            el('div', { class: 'compatible-module-item-main' }, [
              el('div', { class: 'compatible-module-title-row' }, [
                el('span', {}, isPy ? '🐍' : '🟢'),
                el('strong', {}, mod.title || friendlyModuleName(mod.id)),
                el('span', { class: 'mono subtle' }, `${mod.id}@${mod.version || '1.0.0'}`),
                pill(runtimeLabel(mod), isPy ? 'accent' : 'teal')
              ]),
              el('p', { class: 'field-help compatible-module-path mono', title: mod.path }, mod.path),
              providesList.length ? el('div', { class: 'candidate-contracts-row' }, [
                el('span', { class: 'subtle' }, say('提供契约: ', 'Provides: ')),
                ...providesList.map(p => el('span', { class: 'pill pill-teal mono' }, p))
              ]) : null,
              requiresList.length ? el('div', { class: 'candidate-contracts-row' }, [
                el('span', { class: 'subtle' }, say('依赖契约: ', 'Requires: ')),
                ...requiresList.map(r => el('span', { class: 'pill mono' }, r))
              ]) : null
            ].filter(Boolean)),
            button(say('选用此模块', 'Select Module'), () => {
              candidateInput.value = mod.path;
              updateCandidateCard();
              reset();
              modalDialog?.close?.();
            }, 'button button-small button-primary')
          ]);
          listNodes.push(itemNode);
        }
      } else {
        listNodes.push(
          el('div', { class: 'notice notice-warning' }, [
            el('strong', {}, say('暂无可完全兼容替换该节点的模块', 'No fully compatible modules found')),
            el('p', {}, say('继承性替换要求候选模块必须满足当前节点已有所有输入、输出能力契约及活动接线。若需引入新功能模块，请前往「模块组装」添加并新建连线。', 'Inherited replacement requires the candidate to satisfy all existing input and output capability contracts and active bindings of this node. To introduce unrelated modules, add them in "Assembly & Customization" instead.'))
          ])
        );
      }

      const body = [
        el('div', { class: 'compatible-modules-body' }, [
          el('p', { class: 'field-help' }, say(`以下展示与节点「${currentTargetId}」在当前装配中 100% 接口兼容的候选模块：`, `Showing modules that are 100% contract-compatible with node "${currentTargetId}":`)),
          el('div', { class: 'compatible-modules-list' }, listNodes)
        ])
      ];

      modalDialog = openModal(
        say('选择完全兼容的替换模块', 'Select Fully Compatible Module'),
        body,
        say('只展示满足现有接口契约的可用模块，杜绝运行时通信错误', 'Lists modules satisfying existing interface contracts to avoid runtime wiring errors'),
        'compatible-modules-dialog'
      );
    }

    function refreshCandidates() {
      const currentTargetId = target.value;
      const compatibleMods = getCompatibleModulesFor(currentTargetId);
      const currentSavedPath = extra.replacements.get(currentTargetId)?.moduleDirectory ?? extra.moduleCandidate ?? '';

      if (currentSavedPath) {
        candidateInput.value = currentSavedPath;
      } else if (compatibleMods[0]?.path) {
        candidateInput.value = compatibleMods[0].path;
      } else {
        candidateInput.value = '';
      }
      updateOriginalCard();
      updateCandidateCard();
    }

    refreshCandidates();

    candidateInput.addEventListener('input', () => {
      updateCandidateCard();
      reset();
    });

    const leftCard = el('div', { class: 'replacement-card original-node-card' }, [
      el('div', { class: 'replacement-card-header' }, [
        el('span', { class: 'replacement-card-tag original' }, [
          el('span', { class: 'tag-dot' }),
          say('原工作流节点', 'Original Node')
        ]),
        target
      ]),
      originalCardBody
    ]);

    const centerArrow = el('div', { class: 'replacement-flow-arrow' }, [
      el('div', { class: 'replacement-flow-arrow-circle', title: say('继承性替换为', 'Inherited Replacement') }, [
        el('span', { class: 'replacement-arrow-icon', 'aria-hidden': 'true' }, '➔')
      ]),
      el('span', { class: 'replacement-arrow-badge' }, say('继承性替换', 'Inherited Replace')),
      el('span', { class: 'replacement-arrow-hint' }, say('保持连线与公开配置不变', 'Keeps wiring & settings'))
    ]);

    const rightCard = el('div', { class: 'replacement-card candidate-node-card' }, [
      el('div', { class: 'replacement-card-header' }, [
        el('span', { class: 'replacement-card-tag candidate' }, [
          el('span', { class: 'tag-dot candidate' }),
          say('替换目标候选', 'Replacement Candidate')
        ]),
        el('div', { class: 'candidate-source-toggles' }, [
          button(say('选择…', 'Browse…'), (e) => {
            e?.preventDefault?.();
            if (ctx.openPathPicker) {
              ctx.openPathPicker(candidateInput, 'module');
            }
          }, 'button button-small button-quiet'),
          button(say('从我的', 'From Mine'), (e) => {
            e?.preventDefault?.();
            openCompatibleModal();
          }, 'button button-small button-primary'),
          button(say('清空', 'Clear'), (e) => {
            e?.preventDefault?.();
            candidateInput.value = '';
            updateCandidateCard();
            reset();
          }, 'button button-small button-quiet')
        ])
      ]),
      candidateCardBody
    ]);

    const flowContainer = el('div', { class: 'replacement-flow-container' }, [
      leftCard,
      centerArrow,
      rightCard
    ]);

    const load = async f => (await api('/api/authoring/preview', previewInput(value(f, 'componentId'), value(f, 'moduleDirectory')))).preview;
    const previewForm = form([
      flowContainer
    ], say('检查候选与影响', 'Check candidate and impact'), async f => {
      checked = { input: `${value(f, 'componentId')}\n${value(f, 'moduleDirectory')}`, preview: await load(f) };
      const component = choices.find(item => item.id === value(f, 'componentId'));
      results.replaceChildren(...replacementView(checked.preview, component));
      if (checked.preview.compatible) results.append(button(say('使用此候选模块', 'Use this candidate module'), async () => {
        if (!checked || checked.input !== `${value(f, 'componentId')}\n${value(f, 'moduleDirectory')}`) throw new Error(say('选择已改变，请重新检查候选。', 'Your selection changed. Check the candidate again.'));
        const next = await load(f);
        if (!next.compatible || !sameReplacementReview(checked.preview, next)) {
          checked = null; results.replaceChildren(...replacementView(next, component), note(say('内容或环境已改变。请重新检查并审阅后再使用。', 'Contents or environment changed. Check and review again before using the candidate.'), true)); return;
        }
        const componentId = value(f, 'componentId'), moduleDirectory = next.candidate?.directory ?? value(f, 'moduleDirectory');
        extra.replacements.set(componentId, { componentId, moduleDirectory, preview: next }); extra.compositionComponent = componentId; scheduleDraft(); renderCreator();
        toast(say('候选已加入草稿，配置与消费者源码保持原样。请生成新包。', 'Candidate added to the draft. Existing settings and consumer source are preserved. Create a new pack next.'));
      }, 'button button-primary'));
      results.append(button(say('取消候选预览', 'Cancel candidate preview'), () => { checked = null; results.replaceChildren(note(say('已取消预览，未修改草稿或现有实例。', 'Preview cancelled. Draft and existing instances were not changed.'))); }, 'button button-quiet'));
    }, say('候选按已有接线与声明契约筛选；仍需重新检查内容、环境、权限与配置。继承会保留原连线与公开配置，业务兼容性由程序验证。', 'Candidates are filtered by existing bindings and declared contracts. Contents, environment, permissions and settings still require rechecking. Inheritance retains bindings and public settings; applications verify business compatibility.'), `replacement-${chosen.id}`);
    target.value = chosen.id;
    const reset = () => { checked = null; results.replaceChildren(); };
    target.addEventListener('change', () => { extra.compositionComponent = target.value; refreshCandidates(); reset(); });
    const section = panel(say('继承性替换选中为其他模块', 'Inherited replacement of selected with other module'), [previewForm, results]); section.id = 'creator-replacement'; return section;
  }
  function derivedNextSteps() {
    if (!extra.derived) return null;
    const result = extra.derived;
    return panel(say('新包已创建：继续使用', 'New pack created: continue using it'), [definition([[say('新包目录', 'New pack directory'), result.directory], [say('旧来源', 'Previous source'), result.sourceDirectory], [say('实例数据', 'Instance data'), say('新实例使用新数据目录；旧实例保留', 'New instances use new data directories; previous instances are retained')]]), note(say('接下来检查并导入一个新的实例 ID，然后明确审阅并启动。导入不是执行授权。运行后核对应用结果；不通过时停止新实例，再选择旧实例重新审阅启动。', 'Next, check and import a new instance ID, then explicitly review and start it. Import is not execution authorization. Verify application results after running. If validation fails, stop the new instance, select the previous instance, and review it before starting.')), button(say('导入并审阅运行', 'Import and review execution'), () => { openImport(); $('#import-form').elements.directory.value = result.directory; }, 'button button-primary'), button(say('返回已有实例', 'Return to existing instances'), () => navigate('packs'), 'button button-quiet')]);
  }
  const componentDialog = el('dialog', { class: 'dialog' }); document.body.append(componentDialog);
  function editComponent(id) {
    captureForms(componentDialog); extra.formScope = `creator:${extra.directory}`; componentDialog.setAttribute('aria-label', say(`模块 ${id} 的公开配置`, `Public settings for module ${id}`));
    const component = extra.edited.components.find(c => c.id === id), replacement = extra.replacements.get(id);
    let checkedPreview = null;
    const previewView = el('div', { class: 'stack' });
    const editor = form([field('settings', say('公开配置 JSON', 'Public settings JSON'), JSON.stringify(component.settings ?? {}, null, 2), { multiline: true }), note(say('启动成员、顺序、前置和故障策略统一在工作台「启动计划」中调整。', 'Edit membership, order, prerequisites and failure policy in the Workbench Startup plan tab.')), field('topics', say('整合包主题映射 JSON', 'Pack topic mapping JSON'), JSON.stringify(extra.edited.topics ?? {}, null, 2), { multiline: true }), field('bridges', say('桥槽发布/订阅权限 JSON', 'Bridge slot publish/subscribe ACL JSON'), JSON.stringify(component.bridges ?? {}, null, 2), { multiline: true }), field('moduleDirectory', say('替代模块目录（可选）', 'Replacement module directory (optional)'), replacement?.moduleDirectory ?? extra.moduleCandidate ?? '', { required: false })], say('保存草稿配置', 'Save draft settings'), async f => {
      const settings = JSON.parse(value(f, 'settings')); if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error(say('配置须为 JSON 对象。', 'Settings must be a JSON object.'));
      const moduleDirectory = value(f, 'moduleDirectory');
      const after = component.after ?? [], bridges = JSON.parse(value(f, 'bridges')), topics = JSON.parse(value(f, 'topics'));
      const pack = structuredClone(extra.edited), changed = pack.components.find(component => component.id === id); Object.assign(changed, { settings, after, bridges }); pack.topics = topics;
      if (f.elements.topicAliases) {
        const aliases=JSON.parse(value(f,'topicAliases'));
        if(!aliases || Array.isArray(aliases) || typeof aliases!=='object' || !Object.keys(aliases).length) throw new Error(say('程序主题别名必须是非空映射。', 'Program topic aliases must be a nonempty map.'));
        changed.topicAliases=aliases;
      }
      if (moduleDirectory) {
        const data = await api('/api/authoring/preview', previewInput(id, moduleDirectory, pack));
        const preview = data.preview;
        previewView.replaceChildren(...replacementView(preview, component));
        if (preview.environmentCompatible === false || (preview.compatible !== true && (!preview.diagnostics?.length || preview.diagnostics.some(item => item.code !== 'CONTRACT_UNBOUND')))) throw new Error(say('声明不兼容，请查看预检结果。', 'Declarations are incompatible. See the preflight results.'));
        if (!sameReplacementReview(checkedPreview, preview)) {
          checkedPreview = preview;
          toast(say('预检通过，请检查差异后再次点击保存。', 'Preflight passed. Review the differences, then save again.')); return;
        }
        extra.replacements.set(id, { componentId: id, moduleDirectory: preview.candidate?.directory ?? moduleDirectory, preview });
      } else {
        if (replacement && !extra.authoring.pack.components.some(component => component.id === id)) throw new Error(say('新增模块需要保留真实来源目录；如要取消，请移除此新增模块。', 'An added module needs its real source directory. Remove the added component to cancel it.'));
        extra.replacements.delete(id);
      }
      Object.assign(component, { settings, after, bridges, ...(Object.hasOwn(changed,'autostart') ? {autostart:changed.autostart} : {}), ...(Object.hasOwn(changed,'critical') ? {critical:changed.critical} : {}), ...(changed.topicAliases ? {topicAliases:changed.topicAliases} : {}) }); extra.edited.topics = topics; scheduleDraft();
      componentDialog.close(); renderCreator();
    }, say('公开配置会随包分享，不应包含密码或个人秘密。替代模块的桥槽和能力合同必须兼容；同一 Module ID 替换会影响所有引用，新 ID 只替换此模块。后台生成新锁并验证。', 'Public settings are shared with the pack; omit secrets. Replacement slots and contracts must be compatible. Replacing a shared Module ID affects every reference; a new ID affects this module. The backend generates and checks a new lock.'), `component-${id}`);
    if (component.topicAliases) editor.insertBefore(field('topicAliases', say('程序主题别名 → 包主题键 JSON', 'Program topic alias → pack topic key JSON'), JSON.stringify(component.topicAliases,null,2), {multiline:true}),editor.querySelector('button'));
    restoreForm(editor);
    componentDialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', {}, id), closeButton(componentDialog)]), editor, previewView); componentDialog.showModal();
  }
  function editedBody(form) {
    if ([...extra.replacements.values()].some(row => row.preview?.compatible !== true)) throw new Error(say('有替换候选未通过当前环境检查，请重新选择并检查候选。', 'A replacement has not passed checks in this environment. Select and check it again.'));
    const pack = structuredClone(extra.edited);
    resolveDraftStartupOrder(pack.components, pack.startupOrder);
    if (form.elements.packId) pack.id = value(form, 'packId');
    if (form.elements.packTitle) pack.title = value(form, 'packTitle');
    if (form.elements.packVersion) pack.version = value(form, 'packVersion');
    if(form.elements.packVersion && compareAssetVersions(pack.version,extra.authoring.pack.version)>=0)throw new Error(say('请使用高于来源版本的组合新版本；另存与更新均不改模块自身版本。','Use a composition version higher than the source version. Saving and updating retain module versions.'));
    return { directory: extra.directory, destination: value(form, 'destination'), expectedRevision: extra.authoring.revision, pack, replacements: candidateSources(), reviewedCandidates: [...extra.replacements.values()].map(({ componentId, preview }) => ({ componentId, candidateDigest: preview.candidateDigest })), redistributionAcknowledged: true, ...env() };
  }
  function nextCompositionVersion(version) {
    const match=/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version??'');
    return match ? `${match[1]}.${match[2]}.${BigInt(match[3])+1n}` : version;
  }
  async function saveRuntimeComposition(body,source) {
    const target = (state.instances ?? []).find(instance => idOf(instance) === source.origin.targetInstanceId);
    if (!target) throw new Error(say('原实例已不可用，请重新载入。', 'The original instance is unavailable. Load it again.'));
    await customization.save(target, { ...body, origin: source.origin }, true);
  }
  async function updateCurrentComposition(f) {
    await recheckDraftCandidates();
    const body=editedBody(f), origin=extra.assembly && sameDirectory(extra.directory,extra.assembly.directory) ? extra.assembly : null;
    delete body.destination;
    if(extra.runtimeAssembly && sameDirectory(extra.directory,extra.runtimeAssembly.directory)) {
      await saveRuntimeComposition(body,extra.runtimeAssembly);return;
    }
    const sourceInstance=(state.instances??[]).find(instance=>sameDirectory(instance.packageDirectory??'',body.directory));
    if (origin) {
      if(body.pack.packType!==extra.authoring.pack.packType || body.pack.lifecyclePolicy!==extra.authoring.pack.lifecyclePolicy || body.pack.components.some(component=>component.critical!==undefined))throw new Error(say('全局 Hub 可保存启动成员、精确顺序、前置与计划失败处理；整合包生命周期预设和关键成员声明请另存为新整合包。','Global Hub can save plan membership, exact order, prerequisites and plan failure handling. Save pack lifecycle presets and critical-member declarations as a standalone pack.'));
      if(body.replacements.length)throw new Error(say('更新本机 Hub 现有组合支持公开参数与接线；增删或替换源码请另存为新组合。', 'Update the local Hub to change existing public settings and wiring. Save as new for source additions, removals, or replacements.'));
      const preview=await api('/api/programs/assembly/preview',{directory:body.directory,pack:body.pack,expectedRevision:origin.composition.revision,startupPlan:{onFailure:origin.startupPlan?.onFailure??'continue-independent'}});
      const checked = preview.review, savedPack = extra.authoring.pack;
      const reviewedPlan = checked.startupPlan ?? { members: body.pack.components.map(row => ({ programId: row.id, enabled: row.autostart !== false, after: row.after ?? [] })), startupOrder: body.pack.startupOrder, onFailure: origin.startupPlan?.onFailure };
      const beforeOrder = resolveDraftStartupOrder(savedPack.components, savedPack.startupOrder);
      const afterMembers = reviewedPlan.members.map(row => ({ id: row.programId, after: row.after ?? [], autostart: row.enabled }));
      const afterOrder = resolveDraftStartupOrder(afterMembers, reviewedPlan.startupOrder);
      const orderText = ids => ids.join(' → ') || say('仅 Hub，无初始成员', 'Hub only; no initial members');
      const failureText = value => value === 'stop-plan' ? say('停止后续启动，保留已完成成员', 'Stop subsequent starts; retain completed members') : say('继续互不依赖的成员', 'Continue independent members');
      const reviewSummary = el('section', { class: 'panel global-composition-review-summary', 'data-global-composition-review': '' }, [
        el('h3', {}, say('本次版本与启动计划变化', 'Version and startup plan changes')),
        el('div', { class: 'global-composition-lineage-review' }, [
          el('p', {}, [say('当前：', 'Current: '), renderPackLineage(el, { id: body.pack.id, version: checked.beforeVersion ?? savedPack.version, lineage: checked.beforeLineage ?? origin.composition.lineage }, state.language)]),
          el('p', {}, [say('保存后：', 'After saving: '), renderPackLineage(el, { id: body.pack.id, version: checked.afterVersion ?? body.pack.version, lineage: checked.lineage }, state.language)])
        ]),
        definition([
          [say('完整执行顺序（含手动成员）', 'Complete execution order (including manual members)'), `${orderText(beforeOrder)} ⇒ ${orderText(afterOrder)}`],
          [say('实际初始启动成员与顺序', 'Initial members and execution order'), `${orderText(beforeOrder.filter(id => savedPack.components.find(row => row.id === id).autostart !== false))} ⇒ ${orderText(afterOrder.filter(id => afterMembers.find(row => row.id === id).autostart !== false))}`],
          [say('计划失败处理', 'Plan failure handling'), `${failureText(origin.savedStartupPlan?.onFailure)} ⇒ ${failureText(reviewedPlan.onFailure)}`]
        ])
      ]);
      reviewAction(say('更新本机 Hub 当前组合', 'Update current local Hub composition'), [
        note(say('先停止所有 Launcher 托管程序。更新保存公开参数、接线、初始启动成员、精确顺序、前置与计划失败处理，保留私有数据及身份。保存不运行程序；之后可审阅执行启动计划或单独启动。', 'Stop all Launcher-managed programs first. This saves public settings, wiring, startup membership, exact order, prerequisites and plan failure handling while preserving private data and identities. Saving starts nothing. Review the plan or individual programs before starting.')),
        reviewSummary, jsonView(say('完整版本与配置审阅', 'Full version and configuration review'), checked, true)
      ], say('我已检查新版本的参数、接线与启动计划，确认更新当前组合。', 'I reviewed this version, its settings, wiring and startup plan, and confirm updating the current composition.'), async()=>{
        const result=await api('/api/programs/assembly/apply',{reviewId:preview.reviewId,accepted:true});
        extra.edited=null; extra.authoring=null;
        await openCreatorFromPrograms();
        toast(say(`本机 Hub 组合已更新至 ${result.version}；请重新审阅并启动程序。`,`Local Hub composition updated to ${result.version}. Review and start its programs again.`));
      });
      return;
    }
    if (sourceInstance) { await customization.save(sourceInstance, body); return; }
    reviewAction(say('更新当前组合版本','Update current composition version'),[note(say('更新保留当前包 ID 和目录，要求更高版本，重新生成锁；原来源作为可恢复副本保留。','Keep the current pack ID and directory with a higher version and regenerated lock. Previous source is retained as a recoverable copy.')),jsonView(say('更新内容','Update contents'),body)],say('我已检查公开配置、源码与许可，确认准备此版本更新。','I reviewed the public settings, source and licenses, and confirm preparing this version update.'),async()=>{
      const accepted=await api('/api/authoring/update',body);
      await operation(accepted,'update',async result=>{
          extra.drafts=extra.drafts.filter(draft=>!sameDirectory(draft.directory,result.directory));clearCreatorForms(result.directory);
          await loadPackIntoCreator(result.directory,()=>navigate('creator'));await saveDraft();
          toast(say(`当前组合已更新至 ${result.version}`,`Current composition updated to ${result.version}`));
      });
    });
  }
  function renderCreator() {
    const root = $('#creator-content'), saved = extra.resetCreator ? { active: null, details: {} } : preserve(root); extra.resetCreator = false; extra.formScope = `creator:${extra.directory}`; root.classList.add('creator-workspace');

    const inspect = form([field('directory', say('本机整合包目录', 'Local pack directory'), extra.directory, { pathPurpose: 'pack' })], say('检查并打开装配草稿', 'Inspect and open a draft'), async f => {
      let directory = value(f, 'directory');
      if (!directory) throw new Error(say('请输入或选择整合包目录', 'Please enter or select a pack directory'));
      let data;
      try {
        data = await api('/api/authoring/inspect', { directory, ...env() });
      } catch (err) {
        if (!directory.endsWith('/package') && !directory.endsWith('\\package')) {
          const sep = directory.includes('/') ? '/' : '\\';
          try {
            const candidate = `${directory}${sep}package`;
            data = await api('/api/authoring/inspect', { directory: candidate, ...env() });
            directory = candidate;
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }
      const authoring = data.authoring ?? data, sourceDirectory = authoring.directory ?? directory;
      if (extra.authoring && sameDirectory(extra.directory, sourceDirectory)) {
        if (extra.authoring.revision !== authoring.revision) throw new Error(say('来源基线已改变，当前草稿保留。请审阅已保存草稿与新来源的差异。', 'The source base changed. This draft is retained; review its differences against the new source.'));
        extra.authoring = authoring; renderCreator(); return;
      }
      if (extra.edited) { captureForms(root); await saveDraft(); if (extra.draftError) throw new Error(extra.draftError); }
      const existing = extra.drafts.find(draft => sameDirectory(draft.directory, sourceDirectory));
      if (existing) { await restoreDraft(existing); return; }
      extra.directory = sourceDirectory; extra.authoring = authoring; extra.edited = structuredClone(extra.authoring.pack); extra.replacements.clear(); extra.comments = null; extra.derived = null; extra.removedBinding = null; extra.draftStatus = ''; extra.draftError = ''; extra.resetCreator = true; extra.creatorTab = 'assembly'; renderCreator();
    }, say('检查读取锁与完整来源。所有编辑在草稿中进行，派生只写入新目录，不更改已运行实例。', 'Inspection reads the lock and complete sources. Edits are drafts. Derivation writes a new directory and does not modify running instances.'));

    if (!extra.authoring || !extra.edited) {
      const hero = el('div', { class: 'studio-launchpad-hero' }, [
        el('div', { class: 'studio-launchpad-hero-main' }, [
          el('div', { class: 'studio-launchpad-hero-icon', 'aria-hidden': 'true' }, '🎛️'),
          el('div', {}, [
            el('h2', {}, say('整合包定制与装配工坊', 'Pack Customizer & Creator Studio')),
            el('p', {}, say('像搭积木一样自由组装与改装您的整合包。你可以调整模块参数、插拔式替换新功能模块，或基于官方模板快速搭建全新工程。', 'Assemble and customize packs like building blocks. Modify module settings, swap modules, or build brand new packs from official templates.'))
          ])
        ]),
        el('div', { class: 'studio-launchpad-hero-badges' }, [
          el('span', { class: 'status-chip active' }, [el('span', { class: 'status-dot' }), say('可视化装配草稿', 'Visual composition draft')]),
          el('span', { class: 'pill pill-teal' }, say('编辑草稿不执行程序', 'Draft edits do not execute programs'))
        ])
      ]);

      // Dialog 1: Drafts Dialog
      const draftsDialog = el('dialog', { class: 'dialog creator-launchpad-dialog', id: 'creator-drafts-dialog', 'aria-label': say('装配草稿箱', 'Creator Drafts') });
      const closeDrafts = button('×', () => draftsDialog.close(), 'icon-button');
      closeDrafts.setAttribute('aria-label', say('关闭', 'Close'));
      const draftsHeading = el('div', { class: 'dialog-heading' }, [
        el('div', {}, [
          el('h2', {}, say('装配草稿箱', 'Creator Drafts')),
          el('p', { class: 'dialog-description' }, say('这里列出本机保存的整合包装配草稿。恢复草稿可继续修改参数与连线；放弃草稿将彻底删除对应记录。', 'Saved creator drafts. Restoring lets you continue customizing settings and wiring; discarding deletes the draft.'))
        ]),
        closeDrafts
      ]);
      const draftsList = el('div', { class: 'creator-dialog-list' });
      if (!extra.drafts.length) {
        draftsList.append(el('div', { class: 'notice' }, [
          el('strong', {}, say('当前暂无保存的草稿', 'No saved drafts found')),
          el('p', {}, say('在工作台修改参数、连线或替换模块时，未派生的更改会自动保存在草稿箱中。', 'When editing a pack in Studio, uncommitted changes will be autosaved here.'))
        ]));
      } else {
        extra.drafts.forEach(draft => {
          const title = draft.pack.title ?? draft.pack.id ?? 'pack';
          const draftItem = el('div', { class: 'creator-dialog-row-item' }, [
            el('div', { class: 'creator-dialog-row-lead' }, [
              el('div', { class: 'creator-dialog-row-icon', 'aria-hidden': 'true' }, '🗂️'),
              el('div', { class: 'creator-dialog-row-info' }, [
                el('div', { class: 'creator-dialog-row-title-row' }, [
                  el('h4', { class: 'creator-dialog-row-title' }, title),
                  el('span', { class: 'mono creator-dialog-row-version' }, `${draft.pack.id}@${draft.pack.version}`)
                ]),
                el('p', { class: 'mono creator-dialog-row-sub', title: draft.directory }, draft.directory),
                el('p', { class: 'field-help creator-dialog-row-time' }, date(draft.updatedAt))
              ])
            ]),
            el('div', { class: 'creator-dialog-row-actions' }, [
              button(say('重新检查并恢复', 'Recheck and restore'), async () => {
                draftsDialog.close();
                await restoreDraft(draft);
              }, 'button button-small button-primary'),
              button(say('放弃', 'Discard'), () => reviewAction(say('放弃已保存草稿', 'Discard saved draft'), [definition([[t('source'), draft.directory]])], say('我确认放弃这个草稿。', 'I confirm discarding this draft.'), () => {
                discardDraft(draft.directory);
                draftsDialog.close();
                renderCreator();
              }), 'button button-small button-quiet')
            ])
          ]);
          draftsList.append(draftItem);
          draftsList.append(jsonView(say('保存的公开草稿内容', 'Saved public draft contents'), draft));
        });
      }
      const draftsFooter = el('div', { class: 'dialog-footer' }, [
        button(say('关闭', 'Close'), () => draftsDialog.close(), 'button button-quiet')
      ]);
      draftsDialog.append(draftsHeading, draftsList, draftsFooter);

      // Dialog 2: Option 1 - Existing Packs Dialog
      const instancesDialog = el('dialog', { class: 'dialog creator-launchpad-dialog', id: 'creator-instances-dialog', 'aria-label': say('从已有整合包改装', 'Customize Existing Pack') });
      const closeInstances = button('×', () => instancesDialog.close(), 'icon-button');
      closeInstances.setAttribute('aria-label', say('关闭', 'Close'));
      const instancesHeading = el('div', { class: 'dialog-heading' }, [
        el('div', {}, [
          el('h2', {}, say('途径 1 · 从已有整合包改装', 'Option 1 · Start from an Existing Pack')),
          el('p', { class: 'dialog-description' }, say('选择你已安装或导入的整合包，立即在可视化画布中改装模块与公开配置：', 'Choose an installed pack to customize its modules and public settings:'))
        ]),
        closeInstances
      ]);
      const instancesToolbar = el('div', { class: 'add-module-toolbar' });
      const instancesSearchInput = el('input', {
        type: 'text',
        class: 'add-module-search-input',
        placeholder: say('搜索已安装整合包名称、ID 或路径…', 'Search installed packs by name, ID or path…'),
        'aria-label': say('搜索整合包', 'Search packs')
      });
      const instancesCountBadge = el('span', { class: 'pill pill-quiet mono' }, `${state.instances?.length ?? 0}`);
      instancesToolbar.append(instancesSearchInput, instancesCountBadge);
      const instancesList = el('div', { class: 'creator-dialog-list' });
      const renderInstancesList = (filterText = '') => {
        instancesList.replaceChildren();
        const q = filterText.toLowerCase().trim();
        const filtered = (state.instances ?? []).filter(inst => {
          if (!q) return true;
          const title = (inst.pack?.title ?? inst.pack?.id ?? idOf(inst)).toLowerCase();
          const id = (inst.pack?.id ?? idOf(inst)).toLowerCase();
          const dir = (inst.packageDirectory ?? inst.directory ?? '').toLowerCase();
          return title.includes(q) || id.includes(q) || dir.includes(q);
        });
        instancesCountBadge.textContent = `${filtered.length} / ${state.instances?.length ?? 0}`;
        if (!filtered.length) {
          instancesList.append(el('div', { class: 'notice' }, [
            el('strong', {}, say('未找到匹配的整合包实例', 'No matching packs found')),
            el('p', {}, say('你可以尝试其他搜索关键词，或前往「🛍️ 我的」与「下载」安装整合包。', 'Try different search keywords, or install packs from Marketplace.'))
          ]));
          return;
        }
        filtered.forEach(inst => {
          const title = inst.pack?.title ?? inst.pack?.id ?? idOf(inst);
          const compCount = inst.moduleCount ?? inst.pack?.components?.length ?? null;
          const dir = inst.packageDirectory ?? (inst.directory ? (inst.directory.endsWith('/package') || inst.directory.endsWith('\\package') ? inst.directory : `${inst.directory}\\package`) : idOf(inst));
          const avatar = renderSquareArt({
            icon: inst.pack?.icon ?? inst.icon,
            fallbackIcon: 'packs',
            tone: 'cyan',
            alt: title
          });
          avatar.classList.add('creator-dialog-row-avatar');
          const item = el('div', { class: 'creator-dialog-row-item' }, [
            el('div', { class: 'creator-dialog-row-lead' }, [
              avatar,
              el('div', { class: 'creator-dialog-row-info' }, [
                el('div', { class: 'creator-dialog-row-title-row' }, [
                  el('h4', { class: 'creator-dialog-row-title' }, title),
                  el('span', { class: 'mono creator-dialog-row-version' }, `${inst.pack?.id ?? idOf(inst)}@${inst.pack?.version ?? '1.0.0'}`),
                  pill(compCount === null ? say('模块未知', 'Modules unknown') : `${compCount} ${say('模块', 'modules')}`, 'cyan')
                ]),
                el('p', { class: 'mono creator-dialog-row-sub', title: dir }, dir)
              ])
            ]),
            el('div', { class: 'creator-dialog-row-actions' }, [
              button(say('✨ 载入改装', '✨ Load & Customize'), () => {
                instancesDialog.close();
                inspect.elements.directory.value = dir;
                inspect.elements.directory.dispatchEvent(new Event('input', { bubbles: true }));
                inspect.querySelector('button[type=submit]')?.click();
              }, 'button button-small button-primary')
            ])
          ]);
          instancesList.append(item);
        });
      };
      instancesSearchInput.addEventListener('input', () => renderInstancesList(instancesSearchInput.value));
      renderInstancesList('');
      const instancesFooter = el('div', { class: 'dialog-footer' }, [
        button(say('关闭', 'Close'), () => instancesDialog.close(), 'button button-quiet')
      ]);
      instancesDialog.append(instancesHeading, instancesToolbar, instancesList, instancesFooter);

      // Dialog 3: Option 2 - Templates Dialog
      const templatesDialog = el('dialog', { class: 'dialog creator-launchpad-dialog', id: 'creator-templates-dialog', 'aria-label': say('从规范模板创建', 'Create from Template') });
      const closeTemplates = button('×', () => templatesDialog.close(), 'icon-button');
      closeTemplates.setAttribute('aria-label', say('关闭', 'Close'));
      const templatesHeading = el('div', { class: 'dialog-heading' }, [
        el('div', {}, [
          el('h2', {}, say('途径 2 · 从已识别模板创建整合包', 'Option 2 · Create from a Discovered Template')),
          el('p', { class: 'dialog-description' }, say('这里展示后端识别的真实模板目录。检查实际参数与平台后，再审阅生成。', 'These are real template directories discovered by the backend. Inspect parameters and platforms, then review generation.'))
        ]),
        closeTemplates
      ]);
      const templatesList = el('div', { class: 'creator-dialog-list' });
      const templates = getTemplates();
      if (!templates.length) {
        templatesList.append(note(say('尚无已识别模板；可在模板库浏览本机目录或下载模板。', 'No templates have been discovered yet. Browse a local directory or download a template from the template library.')));
      } else {
        templates.forEach(template => {
          const item = el('div', { class: 'creator-dialog-row-item' }, [
            el('div', { class: 'creator-dialog-row-lead' }, [
              el('div', { class: 'creator-dialog-row-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('templates') : '📐'),
              el('div', { class: 'creator-dialog-row-info' }, [
                el('div', { class: 'creator-dialog-row-title-row' }, [
                  el('h4', { class: 'creator-dialog-row-title' }, template.title || template.id),
                  el('span', { class: 'mono creator-dialog-row-version' }, `${template.id}@${template.version ?? '—'}`)
                ]),
                el('p', { class: 'field-help' }, template.description || say('实际本机模板；参数和基础整合包将在检查后显示。', 'A real local template; parameters and base pack are shown after inspection.')),
                el('p', { class: 'mono creator-dialog-row-sub', title: template.path }, template.path)
              ])
            ]),
            el('div', { class: 'creator-dialog-row-actions' }, [
              button(say('检查模板并配置生成', 'Inspect template and configure generation'), () => {
                templatesDialog.close();
                completion.openTemplate(template.path);
              }, 'button button-small button-primary')
            ])
          ]);
          templatesList.append(item);
        });
      }
      const templatesFooter = el('div', { class: 'dialog-footer' }, [
        button(say('关闭', 'Close'), () => templatesDialog.close(), 'button button-quiet')
      ]);
      templatesDialog.append(templatesHeading, templatesList, templatesFooter);

      // Dialog 4: Option 3 - Inspect Local Directory Dialog
      const inspectDialog = el('dialog', { class: 'dialog creator-launchpad-dialog dialog-small', id: 'creator-inspect-dialog', 'aria-label': say('从本机已有目录载入', 'Load from Local Directory') });
      const closeInspect = button('×', () => inspectDialog.close(), 'icon-button');
      closeInspect.setAttribute('aria-label', say('关闭', 'Close'));
      const inspectHeading = el('div', { class: 'dialog-heading' }, [
        el('div', {}, [
          el('h2', {}, say('途径 3 · 从本机已有目录载入', 'Option 3 · Load from Local Directory')),
          el('p', { class: 'dialog-description' }, say('输入包含 pack.json 和 pack.lock 的本地整合包根目录，直接载入可视化草稿进行审阅与改装：', 'Enter a pack directory containing pack.json and pack.lock to review and customize:'))
        ]),
        closeInspect
      ]);
      inspectDialog.append(inspectHeading, inspect);

      // Dialog 5: Tools Dialog - Advanced Maintenance & Team Tools
      const toolsDialog = el('dialog', { class: 'dialog creator-launchpad-dialog', id: 'creator-tools-dialog', 'aria-label': say('进阶维护与团队协作工具', 'Maintenance & Team Tools') });
      const closeTools = button('×', () => toolsDialog.close(), 'icon-button');
      closeTools.setAttribute('aria-label', say('关闭', 'Close'));
      const toolsHeading = el('div', { class: 'dialog-heading' }, [
        el('div', {}, [
          el('h2', {}, say('🛠️ 进阶维护与团队协作工具', '🛠️ Maintenance & Team Collaboration Tools')),
          el('p', { class: 'dialog-description' }, say('提供跨机器/跨环境工程维护、团队改动提案合并与本地软件源制品生成等专业工具：', 'Specialized tools for lock rebuilding, proposal merging, and repository artifact publishing:'))
        ]),
        closeTools
      ]);
      const toolsList = el('div', { class: 'creator-tools-dialog-list' }, [
        el('div', { class: 'creator-tool-card' }, [
          el('div', { class: 'creator-tool-card-head' }, [
            el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '⚙️'),
            el('div', {}, [
              el('h4', {}, say('环境锁无损重建 (Rebuild Lock)', 'Rebuild Locked Environment')),
              el('p', {}, say('当 Hub 核心或 Python/Node 解释器版本更新时，基于源码更新依赖锁定文件。', 'Update locked dependencies when interpreter or Hub versions change.'))
            ])
          ]),
          button(say('⚙️ 打开环境锁重建向导...', '⚙️ Open Lock Rebuild Wizard...'), () => {
            toolsDialog.close();
            openRebuildModal();
          }, 'button button-primary')
        ]),
        el('div', { class: 'creator-tool-card' }, [
          el('div', { class: 'creator-tool-card-head' }, [
            el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '🤝'),
            el('div', {}, [
              el('h4', {}, say('团队协作提案 (Proposals)', 'Team Proposals')),
              el('p', {}, say('审查并合并外部团队成员发来的改动提案，写入独立新目录。', 'Review and merge incoming proposals into a new directory.'))
            ])
          ]),
          button(say('🤝 打开协作提案向导...', '🤝 Open Proposals Wizard...'), () => {
            toolsDialog.close();
            openProposalsModal();
          }, 'button button-primary')
        ]),
        el('div', { class: 'creator-tool-card' }, [
          el('div', { class: 'creator-tool-card-head' }, [
            el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '📦'),
            el('div', {}, [
              el('h4', {}, say('本地软件源发布 (Publish)', 'Local Repository Publishing')),
              el('p', {}, say('将本机制作好的整合包生成分发索引与制品，供团队或局域网共享。', 'Generate index and release artifacts for local or network distribution.'))
            ])
          ]),
          button(say('📦 打开本地发布向导...', '📦 Open Publish Wizard...'), () => {
            toolsDialog.close();
            openPublishModal();
          }, 'button button-primary')
        ])
      ]);
      const toolsFooter = el('div', { class: 'dialog-footer' }, [
        button(say('关闭', 'Close'), () => toolsDialog.close(), 'button button-quiet')
      ]);
      toolsDialog.append(toolsHeading, toolsList, toolsFooter);

      // Dashboard Cards
      const cardDraftsActions = [
        button(say('打开草稿箱…', 'Open Drafts…'), () => draftsDialog.showModal(), 'button button-small button-quiet')
      ];
      if (extra.drafts.length) {
        cardDraftsActions.push(
          button(say('重新检查并恢复', 'Recheck and restore'), async () => {
            await restoreDraft(extra.drafts[0]);
          }, 'button button-small button-primary')
        );
      }
      const cardDrafts = el('div', { class: 'creator-dashboard-card' }, [
        el('div', { class: 'creator-dashboard-card-head' }, [
          el('div', { class: 'creator-dashboard-card-icon', 'aria-hidden': 'true' }, '🗂️'),
          extra.drafts.length
            ? pill(`${extra.drafts.length} ${say('份草稿待恢复', 'drafts')}`, 'amber')
            : pill(say('暂无草稿', 'No drafts'), 'quiet')
        ]),
        el('div', { class: 'creator-dashboard-card-body' }, [
          el('h3', {}, say('装配草稿箱', 'Creator Drafts')),
          el('p', {}, say('保存的可视化装配草稿、连线与临时参数。可在弹窗中查看、恢复到工作台或放弃。', 'Saved composition drafts, wiring, and parameters. View, restore, or discard saved drafts.'))
        ]),
        el('div', { class: 'creator-dashboard-card-actions' }, cardDraftsActions)
      ]);

      const cardBlank = el('div', { class: 'creator-dashboard-card' }, [
        el('div', { class: 'creator-dashboard-card-head' }, [
          el('div', { class: 'creator-dashboard-card-icon', 'aria-hidden': 'true' }, '⚡'),
          pill(say('零依赖起步', 'Blank Canvas'), 'teal')
        ]),
        el('div', { class: 'creator-dashboard-card-body' }, [
          el('h3', {}, say('从空白组合开始', 'Start Blank Composition')),
          el('p', {}, say('直接从 0 加入独立功能模块并配置能力插头，无需已有整合包或模板即可自由装配。', 'Add independent modules and wire capability contracts from scratch without a base pack or template.'))
        ]),
        el('div', { class: 'creator-dashboard-card-actions' }, [
          button(say('新建整合包', 'Create pack'), () => deploymentUi.compose(), 'button button-small button-primary')
        ])
      ]);

      const cardPacks = el('div', { class: 'creator-dashboard-card' }, [
        el('div', { class: 'creator-dashboard-card-head' }, [
          el('div', { class: 'creator-dashboard-card-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('packs') : '📦'),
          pill(`${state.instances?.length ?? 0} ${say('个已安装实例', 'instances')}`, 'cyan')
        ]),
        el('div', { class: 'creator-dashboard-card-body' }, [
          el('h3', {}, say('途径 1 · 从已有整合包改装', 'Option 1 · From Existing Pack')),
          el('p', {}, say('选择你已安装或导入的整合包，立即在可视化画布中改装模块、公开参数与能力连接。', 'Choose an installed pack to customize its modules and public settings in the visual canvas.'))
        ]),
        el('div', { class: 'creator-dashboard-card-actions' }, [
          button(say('选择整合包…', 'Select Pack…'), () => {
            renderInstancesList(instancesSearchInput.value);
            instancesDialog.showModal();
          }, 'button button-small button-primary')
        ])
      ]);

      const cardTemplates = el('div', { class: 'creator-dashboard-card' }, [
        el('div', { class: 'creator-dashboard-card-head' }, [
          el('div', { class: 'creator-dashboard-card-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('templates') : '📐'),
          pill(`${getTemplates().length} ${say('个可用模板', 'templates')}`, 'purple')
        ]),
        el('div', { class: 'creator-dashboard-card-body' }, [
          el('h3', {}, say('途径 2 · 从已识别模板创建', 'Option 2 · From Discovered Template')),
          el('p', {}, say('基于官方与社区规范骨架，检查真实参数与平台兼容性后，脚手架生成全新工程。', 'Inspect parameters and platform targets, then scaffold a brand new pack from local templates.'))
        ]),
        el('div', { class: 'creator-dashboard-card-actions' }, [
          button(say('选择模板…', 'Browse Templates…'), () => templatesDialog.showModal(), 'button button-small button-primary')
        ])
      ]);

      const cardInspect = el('div', { class: 'creator-dashboard-card' }, [
        el('div', { class: 'creator-dashboard-card-head' }, [
          el('div', { class: 'creator-dashboard-card-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('sources') : '📁'),
          pill(say('开发者与解压包', 'Local Directory'), 'indigo')
        ]),
        el('div', { class: 'creator-dashboard-card-body' }, [
          el('h3', {}, say('途径 3 · 从本机已有目录载入', 'Option 3 · Load from Local Directory')),
          el('p', {}, say('输入包含 pack.json 和 pack.lock 的本地目录路径，直接载入草稿进行审阅与改装。', 'Enter a pack directory containing pack.json and pack.lock to review and customize in the draft.'))
        ]),
        el('div', { class: 'creator-dashboard-card-actions' }, [
          button(say('载入本地目录…', 'Load Local Directory…'), () => inspectDialog.showModal(), 'button button-small button-primary')
        ])
      ]);

      const cardTools = el('div', { class: 'creator-dashboard-card' }, [
        el('div', { class: 'creator-dashboard-card-head' }, [
          el('div', { class: 'creator-dashboard-card-icon', 'aria-hidden': 'true' }, '🛠️'),
          pill(say('3 项工程工具', '3 Tools'), 'amber')
        ]),
        el('div', { class: 'creator-dashboard-card-body' }, [
          el('h3', {}, say('进阶维护与团队协作', 'Maintenance & Team Tools')),
          el('p', {}, say('环境锁无损重建、团队改动提案合并与本地软件源制品发布等专业工程维护工具。', 'Specialized tools for lock rebuilding, proposal merging, and repository artifact publishing.'))
        ]),
        el('div', { class: 'creator-dashboard-card-actions' }, [
          button(say('打开维护工具箱…', 'Open Toolset…'), () => toolsDialog.showModal(), 'button button-small button-quiet')
        ])
      ]);

      const dashboardGrid = el('div', { class: 'creator-dashboard-grid' }, [
        cardDrafts,
        cardBlank,
        cardPacks,
        cardTemplates,
        cardInspect,
        cardTools
      ]);

      const launchpad = el('div', { class: 'studio-launchpad', id: 'creator-source' }, [
        hero,
        dashboardGrid,
        draftsDialog,
        instancesDialog,
        templatesDialog,
        inspectDialog,
        toolsDialog
      ]);

      root.replaceChildren(...[
        extra.creatorPostApplyWarning ? note(extra.creatorPostApplyWarning, true) : null,
        derivedNextSteps(),
        launchpad,
        workbenchResults(),
        el('div', { id: 'advanced-progress', role: 'status', 'aria-live': 'polite' })
      ].filter(Boolean));
      reinstate(root, saved);
      return;
    }

    extra.creatorTab = extra.creatorTab ?? 'assembly';
    if (!['assembly', 'connections', 'startup', 'tools'].includes(extra.creatorTab)) {
      extra.creatorTab = 'assembly';
    }

    const pack = extra.edited;
    if (!pack.components.some(component => component.id === extra.compositionComponent))
      extra.compositionComponent = pack.components.find(component => currentModule(component)?.provides?.length)?.id ?? pack.components[0]?.id ?? '';

    const chosenComponent = pack.components.find(c => c.id === extra.compositionComponent) ?? pack.components[0];
    const chosenModule = currentModule(chosenComponent);
    const isGlobalHub = Boolean(extra.assembly && sameDirectory(extra.directory, extra.assembly.directory));

    // Save Modal Dialog
    const saveDialog = el('dialog', { class: 'dialog creator-save-dialog', id: 'creator-save-dialog', 'aria-label': say('保存组合与版本', 'Save composition & version') });
    const saveNotice = extra.runtimeAssembly && sameDirectory(extra.directory, extra.runtimeAssembly.directory)
      ? say('更新无需填写新目录。请先停止实例，再审阅差异与软件和持久数据快照，直接保存为原实例的新改装版本；不自动停机或启动。', 'Updating needs no new destination. Stop the instance first, then review the differences and software and persistent-data snapshot before saving the next customization in place. Nothing stops or starts automatically.')
      : isGlobalHub
        ? say('更新无需填写新目录。保存已登记的受管源码、公开参数与契约接线。更新保留私有身份与运行数据，之后逐一重新审阅启动。', 'Updating needs no new destination. Saves registered managed sources, public settings and capability wiring. Preserves private identities and data.')
        : say('更新无需填写新目录。递增组合版本并审阅差异。已安装实例先停止，应用前保存软件与持久数据快照，直接在工作台更新；之后需重新审阅启动。', 'Updating needs no new destination. Increase the composition version and review differences. Stop installed instances first; a snapshot of software and persistent data is saved before applying directly in Workbench. Review again before starting.');

    const saveForm = form([
      el('div', { class: 'field-grid' }, [
        field('packVersion', say('组合新版本', 'New composition version'), pack.version === extra.authoring.pack.version ? nextCompositionVersion(pack.version) : pack.version),
        field('packTitle', say('包名称', 'Pack title'), pack.title)
      ]),
      el('p', { class: 'field-help' }, saveNotice)
    ], say('更新当前组合…', 'Update current composition…'), async f => {
      await updateCurrentComposition(f);
      saveDialog.close();
    }, '', 'creator-save');
    saveForm.id = 'creator-save-form';
    saveForm.addEventListener('input', () => {
      if (saveForm.elements.packVersion) pack.version = value(saveForm, 'packVersion');
      if (saveForm.elements.packTitle) pack.title = value(saveForm, 'packTitle');
      if (derive?.elements?.packVersion) derive.elements.packVersion.value = pack.version;
      if (derive?.elements?.packTitle) derive.elements.packTitle.value = pack.title;
      scheduleDraft();
    });

    const saveSubmitBtn = saveForm.querySelector('button[type=submit]');
    const saveCancelBtn = button(t('cancel'), () => saveDialog.close(), 'button button-quiet');
    const saveFooter = el('div', { class: 'dialog-footer' }, [saveCancelBtn, saveSubmitBtn]);
    saveForm.append(saveFooter);

    saveDialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [
        el('div', {}, [
          el('h2', {}, say('保存组合与版本', 'Save composition & version')),
          el('p', { class: 'dialog-description mono' }, `${pack.id} · ${extra.directory}`)
        ]),
        closeButton(saveDialog)
      ]),
      note(isGlobalHub
        ? say('编辑草稿不执行程序。更新当前组合先核对来源、递增版本并审阅应用，保留来源基线记录、私有身份与运行数据。', 'Draft edits do not execute programs. Updating checks the source, increases the version, and applies upon review while preserving source baseline metadata, private identities and runtime data.')
        : say('编辑草稿不执行程序。更新当前组合先核对来源、递增版本并审阅应用。原来源保留为可恢复副本。', 'Draft edits do not execute programs. Updating checks the source, increases the version, and applies upon review. Previous source is retained as a recoverable copy.')),
      saveForm
    );

    // Save As (Derive) Modal Dialog
    const deriveDialog = el('dialog', { class: 'dialog creator-derive-dialog', id: 'creator-derive-dialog', 'aria-label': say('另存为新组合', 'Save as new composition') });
    const entrySelect = el('select', { name: 'entryComponent', 'aria-label': say('新整合包的启动入口', 'New pack entry component') }, pack.components.map(component => el('option', { value: component.id }, component.id)));
    entrySelect.value = pack.entry?.component ?? pack.components[0]?.id;
    entrySelect.addEventListener('change', () => { pack.entry = { component: entrySelect.value }; scheduleDraft(); });

    const derive = form([
      el('div', { class: 'field-grid' }, [
        field('packId', say('新包 ID', 'New pack ID'), pack.id),
        field('packVersion', say('组合新版本', 'New composition version'), pack.version === extra.authoring.pack.version ? nextCompositionVersion(pack.version) : pack.version)
      ]),
      field('packTitle', say('包名称', 'Pack title'), pack.title),
      el('label', {}, [el('span', {}, say('启动入口程序', 'Entry program')), entrySelect, el('span', { class: 'field-help' }, say('选择负责提供整合包打开入口的程序；纯后台组合可以没有界面 URL。', 'Choose the program that supplies the pack entry URL. A background-only pack may have no interface URL.'))]),
      field('destination', say('新的派生包目录', 'New derived pack directory'))
    ], say('生成派生整合包…', 'Create derived pack…'), async f => {
      await recheckDraftCandidates();
      const body = editedBody(f);
      reviewAction(say('生成派生整合包', 'Create derived pack'), [
        note(say('后台重新验证设置、部署依赖、能力合同和替换模块，生成新 pack.lock 与来源记录。目标必须为新目录，不覆盖当前包。不运行模块。', 'The backend revalidates settings, dependencies, capability contracts, and replacements, then creates a new pack.lock and provenance record. The destination must be new. Modules are not executed.')),
        definition([[say('新包', 'New pack'), `${body.pack.id}@${body.pack.version}`], [say('新目录', 'New directory'), body.destination], [say('替换模块', 'Replacement modules'), body.replacements.map(row => row.componentId).join(', ') || say('无', 'None')], [say('数据策略', 'Data handling'), say('不复制旧实例运行数据', 'Existing instance data is not copied')]]),
        jsonView(say('将写入的组合', 'Composition to write'), body)
      ], say('我已检查公开配置与第三方许可，拥有复制和派生这些模块的权利。', 'I reviewed public settings and third-party licenses and have the right to copy and derive these modules.'), async () => {
        const derived = await api('/api/authoring/derive', body);
        await operation(derived, 'derive', result => {
          toast(say(`已创建派生包：${result.directory}`, `Derived pack created: ${result.directory}`));
          extra.derived = { ...result, sourceDirectory: body.directory };
          extra.directory = result.directory;
          extra.authoring = null;
          extra.edited = null;
          extra.replacements.clear();
          renderCreator();
        });
      });
      deriveDialog.close();
    }, '', 'creator-derive');
    derive.id = 'creator-derive-form';
    derive.addEventListener('input', () => {
      pack.id = value(derive, 'packId');
      pack.version = value(derive, 'packVersion');
      pack.title = value(derive, 'packTitle');
      if (saveForm?.elements?.packVersion) saveForm.elements.packVersion.value = pack.version;
      if (saveForm?.elements?.packTitle) saveForm.elements.packTitle.value = pack.title;
      scheduleDraft();
    });

    const deriveSubmitBtn = derive.querySelector('button[type=submit]');
    const deriveCancelBtn = button(t('cancel'), () => deriveDialog.close(), 'button button-quiet');
    const deriveFooter = el('div', { class: 'dialog-footer' }, [deriveCancelBtn, deriveSubmitBtn]);
    derive.append(deriveFooter);

    deriveDialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [
        el('div', {}, [
          el('h2', {}, say('另存为新组合', 'Save as new composition')),
          el('p', { class: 'dialog-description' }, say('从当前草稿派生并生成独立新整合包，写入新目录。原整合包与旧实例保持原样。', 'Derive an independent new pack into a new directory from this draft. Original pack and instances remain untouched.'))
        ]),
        closeButton(deriveDialog)
      ]),
      note(say('编辑不执行程序。另存生成独立新包；目标必须为新目录，不覆盖当前包。不运行模块。', 'Editing does not execute programs. Save as new creates an independent pack; the destination must be a new directory.')),
      derive
    );

    // Universal Header Bar
    const packMetaBar = el('div', { class: 'creator-active-pack-bar' }, [
      el('div', { class: 'creator-pack-lead' }, [
        el('div', { class: 'creator-pack-identity' }, [
          el('span', { class: 'creator-pack-icon', 'aria-hidden': 'true' }, '📦'),
          el('div', { class: 'creator-pack-info' }, [
            el('div', { class: 'creator-pack-title-row' }, [
              el('h2', { class: 'creator-pack-title' }, pack.title ? `${pack.title} ` : pack.id),
              el('span', { class: 'creator-pack-ver mono' }, pack.id),
              renderPackLineage(el, isGlobalHub ? extra.assembly.composition ?? extra.authoring.pack : extra.authoring.pack, state.language)
            ]),
            el('div', { class: 'creator-pack-meta-row' }, [
              el('span', { class: 'creator-pack-path mono', title: extra.directory }, extra.directory),
              el('span', { class: 'creator-pack-meta-divider', 'aria-hidden': 'true' }, '·'),
              el('span', { class: 'creator-draft-status-text', role: 'status', 'aria-live': 'polite', 'data-draft-status': '' }),
              el('span', { class: 'status-chip active' }, [el('span', { class: 'status-dot' }), say('装配草稿', 'Composition draft')]),
              el('span', { class: 'pill pill-teal' }, say('编辑草稿不执行程序', 'Draft edits do not execute programs'))
            ])
          ])
        ])
      ]),
      el('div', { class: 'creator-pack-top-actions' }, [
        button(say('← 返回工坊首页', '← Back to Launchpad'), async () => {
          captureForms(root);
          await saveDraft();
          extra.authoring = null;
          extra.edited = null;
          extra.resetCreator = true;
          renderCreator();
        }, 'button button-small button-quiet'),
        button(say('立即保存草稿', 'Save draft now'), async () => {
          captureForms(root);
          await saveDraft();
          toast(say('草稿已保存', 'Draft saved'));
        }, 'button button-small button-quiet'),
        button(say('放弃此草稿', 'Discard draft'), async () => {
          await discardDraft(extra.directory);
        }, 'button button-small button-quiet'),
        button(say('保存', 'Save'), () => {
          captureForms(root);
          if (saveForm.elements.packVersion) saveForm.elements.packVersion.value = pack.version === extra.authoring.pack.version ? nextCompositionVersion(pack.version) : pack.version;
          if (saveForm.elements.packTitle) saveForm.elements.packTitle.value = pack.title;
          saveDialog.showModal();
          saveForm.elements.packVersion?.focus();
        }, 'button button-small button-primary'),
        button(say('另存', 'Save as…'), () => {
          captureForms(root);
          if (derive.elements.packId) derive.elements.packId.value = pack.id;
          if (derive.elements.packVersion) derive.elements.packVersion.value = pack.version === extra.authoring.pack.version ? nextCompositionVersion(pack.version) : pack.version;
          if (derive.elements.packTitle) derive.elements.packTitle.value = pack.title;
          deriveDialog.showModal();
          derive.elements.destination?.focus();
        }, 'button button-small')
      ])
    ]);

    // Workflow Sub-tabs
    const tabsBar = el('div', { class: 'view-subtabs creator-tabs', role: 'group', 'aria-label': say('工作台功能视图', 'Workbench views') }, [
      el('div', { class: 'view-subtabs-group' }, [
        button(say('🧩 模块组装与改装', '🧩 Assembly & Customization'), () => {
          extra.creatorTab = 'assembly';
          renderCreator();
        }, `view-subtab${extra.creatorTab === 'assembly' ? ' is-active' : ''}`),
        button(say('🔗 模块通信与接口', '🔗 Module Connections & Interfaces'), () => {
          extra.creatorTab = 'connections';
          renderCreator();
        }, `view-subtab${extra.creatorTab === 'connections' ? ' is-active' : ''}`),
        button(say('▶ 启动计划', '▶ Startup plan'), () => { extra.creatorTab = 'startup'; renderCreator(); }, `view-subtab${extra.creatorTab === 'startup' ? ' is-active' : ''}`),
        button(say('🛠️ 进阶协作工具', '🛠️ Advanced & Collaboration'), () => {
          extra.creatorTab = 'tools';
          renderCreator();
        }, `view-subtab${extra.creatorTab === 'tools' ? ' is-active' : ''}`)
      ])
    ]);

    tabsBar.querySelectorAll('.view-subtab').forEach((node, index) => node.setAttribute('aria-pressed', String(['assembly', 'connections', 'startup', 'tools'][index] === extra.creatorTab)));

    // Sub-tab 1: Assembly & Customization
    const assemblyGuide = el('div', { class: 'creator-guide-banner' }, [
      el('div', { class: 'creator-guide-icon', 'aria-hidden': 'true' }, '🧩'),
      el('div', {}, [
        el('h3', {}, say('可视化模块组装与替换草稿', 'Visual assembly and module replacement draft')),
        el('p', {}, say('浏览与管理整合包内所有运行节点。点击“⚙️ 修改公开配置”可调整节点参数；点击“添加模块”可扩充新功能；节点间的契约连线与继承性替换可在「🔗 模块通信与接口」中配置。', 'Manage all modules in this pack. Click "⚙️ Edit Settings" to customize node parameters, or "Add Module" to expand the pack. Configure wiring connections and inherited replacements under "🔗 Module Connections & Interfaces".'))
      ])
    ]);

    const canvasCol = el('div', { class: 'studio-canvas-col', id: 'creator-composition' }, [
      graph(),
      ...[...extra.replacements.values()].map(row => el('div', { class: 'notice' }, [
        el('strong', {}, `${row.componentId} → ${row.preview?.candidate?.manifest?.id ?? row.moduleDirectory}`),
        el('p', {}, row.preview?.compatible ? say('已加入草稿；业务仍须运行验证。', 'Added to the draft; business behavior still requires runtime validation.') : (row.preview?.diagnostics ?? []).length > 0 && (row.preview?.diagnostics ?? []).every(item => ['CONTRACT_UNBOUND', 'TOPIC_ALIASES_INVALID'].includes(item.code)) ? say('已加入草稿；契约尚未接线，可在「🔗 模块通信与接口」中连接提供者。', 'Added to draft. Contracts unbound; connect a provider under "🔗 Module Connections & Interfaces".') : say('候选需要重新检查；暂不能生成包。', 'Candidate requires another check; pack creation is blocked.')),
        button(say('放弃此候选', 'Discard this candidate'), () => { if (!extra.authoring.pack.components.some(component => component.id === row.componentId)) removeComponent(row.componentId); else { extra.replacements.delete(row.componentId); scheduleDraft(); renderCreator(); } }, 'button button-small button-quiet'),
        jsonView(say('替换预检记录', 'Replacement preflight record'), row.preview)
      ]))
    ]);

    const panelAssembly = el('div', { class: `creator-tab-panel${extra.creatorTab === 'assembly' ? '' : ' is-hidden'}` }, [
      assemblyGuide,
      canvasCol
    ]);

    // Sub-tab 2: Connections & Interfaces
    const connectionsGuide = el('div', { class: 'creator-guide-banner' }, [
      el('div', { class: 'creator-guide-icon', 'aria-hidden': 'true' }, '🔗'),
      el('div', {}, [
        el('h3', {}, say('模块通信拓扑与接口连线规范 (Capability Contracts)', 'Module Topology & Capability Contracts')),
        el('p', {}, say('模块之间通过严格的“能力合同接口”互相通信。提供者（Provides ↑）输出数据，消费者（Requires ↓）接收数据。双方接口 ID 与版本精确匹配时才能建立连线，杜绝隐式协议错误。', 'Modules interact through declared capability contracts. Providers output data and consumers receive data. Connections require exact contract ID and version match.'))
      ])
    ]);

    const topologyPanel = panel(say('🕸️ 模块通信拓扑与连线图 (Topology Wiring)', 'Module Communication Topology & Wiring Diagram'), [
      el('div', { class: 'topology-panel-header' }, [
        el('span', { class: 'field-help' }, say('静态展示草稿的能力声明与显式合同绑定，不代表已运行的信息流。未绑定合同显示为缺口；连线编辑只修改草稿。', 'Static draft capability declarations and explicit contract bindings, not observed runtime flows. Unbound contracts are gaps; wiring edits only change the draft.')),
        pill(`${pack.bindings.length} ${say('条草稿合同绑定', 'draft contract bindings')}`, 'teal')
      ]),
      renderTopologyDiagram(pack, chosenComponent.id),
      extra.removedBinding ? el('div', { class: 'notice composition-undo', role: 'status' }, [
        say('连线已移除，尚未生成新包。', 'Binding removed; a new pack has not been generated.'),
        button(say('撤销移除', 'Undo removal'), () => {
          const { binding, index } = extra.removedBinding;
          if (!pack.bindings.some(row => JSON.stringify(row) === JSON.stringify(binding))) pack.bindings.splice(Math.min(index, pack.bindings.length), 0, binding);
          extra.removedBinding = null;
          scheduleDraft();
          renderCreator();
        }, 'button button-small button-quiet')
      ]) : null
    ]);

    const baselineDrawer = canvasDrawer('baseline', '📜', say('基线内容版本与高级声明', 'Base content revision & advanced declaration'), [
      jsonView(say('基线内容版本与高级组合声明', 'Base content revision & advanced composition'), { revision: extra.authoring.revision, pack })
    ]);

    const panelConnections = el('div', { class: `creator-tab-panel${extra.creatorTab === 'connections' ? '' : ' is-hidden'}` }, [
      connectionsGuide,
      topologyPanel,
      replacementPanel(),
      baselineDrawer
    ]);

    const panelStartup = el('div', { class: `creator-tab-panel${extra.creatorTab === 'startup' ? '' : ' is-hidden'}`, 'data-creator-startup-tab': '' }, [createStartupPlanEditor({ state, el, button, paradigms, pack, savedPack: extra.runtimeAssembly && sameDirectory(extra.directory, extra.runtimeAssembly.directory) ? extra.runtimeAssembly.savedStartupPack : extra.authoring.pack, onChange: scheduleDraft, ...(isGlobalHub ? { globalPlan: extra.assembly.startupPlan, savedGlobalPlan: extra.assembly.savedStartupPlan } : {}) })]);

    // Sub-tab 4: Advanced Tools
    const toolsGuide = el('div', { class: 'creator-guide-banner' }, [
      el('div', { class: 'creator-guide-icon', 'aria-hidden': 'true' }, '🛠️'),
      el('div', {}, [
        el('h3', {}, say('整合包进阶工具与团队协作箱', 'Advanced Pack Tools & Team Collaboration')),
        el('p', {}, say('提供模板脚手架、团队协作提案合并、本地软件源发布、评论讨论与环境锁重建等进阶工具。', 'Tools for templates scaffolding, team proposals, local repository publishing, comments, and environment lock rebuilding.'))
      ])
    ]);

    const toolsGrid = el('div', { class: 'creator-tools-grid' }, [
      el('div', { class: 'creator-tool-card' }, [
        el('div', { class: 'creator-tool-card-head' }, [
          el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '📋'),
          el('div', {}, [
            el('h4', {}, say('模板与脚手架工坊', 'Templates & Scaffolding')),
            el('p', {}, say('将当前定制包制作成可复用的工程模板，或从空白模板创建新工程。', 'Create templates from this pack or scaffold new projects.'))
          ])
        ]),
        button(say('📋 从当前包制作模板...', '📋 Export as Template...'), () => openCreateTemplateModal(extra.directory), 'button button-primary')
      ]),
      el('div', { class: 'creator-tool-card' }, [
        el('div', { class: 'creator-tool-card-head' }, [
          el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '🤝'),
          el('div', {}, [
            el('h4', {}, say('团队协作提案 (Proposals)', 'Team Proposals')),
            el('p', {}, say('将草稿导出为轻量差异提案文件发给团队，或审查并应用他人发来的改动提案。', 'Export draft proposals to teammates or review and merge incoming proposals.'))
          ])
        ]),
        button(say('🤝 打开协作提案向导...', '🤝 Open Proposals Wizard...'), openProposalsModal, 'button button-quiet')
      ]),
      el('div', { class: 'creator-tool-card' }, [
        el('div', { class: 'creator-tool-card-head' }, [
          el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '📦'),
          el('div', {}, [
            el('h4', {}, say('本地软件源发布 (Publish)', 'Local Repository Publishing')),
            el('p', {}, say('将自制整合包生成标准分发索引与制品，供局域网或团队下载使用。', 'Generate index and release artifacts for local or network distribution.'))
          ])
        ]),
        button(say('📦 打开本地发布向导...', '📦 Open Publish Wizard...'), openPublishModal, 'button button-quiet')
      ]),
      el('div', { class: 'creator-tool-card' }, [
        el('div', { class: 'creator-tool-card-head' }, [
          el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '💬'),
          el('div', {}, [
            el('h4', {}, say('协作讨论留言板 (Comments)', 'Collaboration Discussion')),
            el('p', {}, say('在此整合包中记录开发备忘或本地讨论，支持跨机器导出与导入留言。', 'Record discussion notes and import or export team comments.'))
          ])
        ]),
        button(say('💬 打开讨论留言板...', '💬 Open Discussion Board...'), openCommentsModal, 'button button-quiet')
      ]),
      el('div', { class: 'creator-tool-card' }, [
        el('div', { class: 'creator-tool-card-head' }, [
          el('div', { class: 'creator-tool-icon', 'aria-hidden': 'true' }, '⚙️'),
          el('div', {}, [
            el('h4', {}, say('环境锁无损重建 (Rebuild Lock)', 'Rebuild Locked Environment')),
            el('p', {}, say('当 Python/Node 解释器版本或 Hub 核心环境变动时，安全基于原始源码更新依赖锁。', 'Update locked dependencies when interpreter or Hub versions change.'))
          ])
        ]),
        button(say('⚙️ 打开环境锁重建向导...', '⚙️ Open Lock Rebuild Wizard...'), openRebuildModal, 'button button-quiet')
      ])
    ]);

    const panelTools = el('div', { class: `creator-tab-panel${extra.creatorTab === 'tools' ? '' : ' is-hidden'}` }, [
      toolsGuide,
      toolsGrid,
      workbenchResults()
    ].filter(Boolean));

    const hiddenSourceForm = el('div', { id: 'creator-source', class: 'is-hidden' }, [inspect]);

    root.replaceChildren(...[
      extra.creatorPostApplyWarning ? note(extra.creatorPostApplyWarning, true) : null,
      hiddenSourceForm,
      packMetaBar,
      derivedNextSteps(),
      extra.runtimeAssembly && sameDirectory(extra.directory,extra.runtimeAssembly.directory)?note(say('这是实际运行装配的源码草稿。可另存新包，或先停止原实例，再审阅软件与持久数据快照并直接保存下一改装版本。私有运行数据不打入可分享的源码包。','This source draft represents the actual runtime composition. Save as new, or stop the original instance, then review a software and persistent-data snapshot and apply its next customization directly. Private runtime data is excluded from shareable source packs.')):null,
      extra.assembly && sameDirectory(extra.directory, extra.assembly.directory) ? note(say('本机 Hub 静态装配草稿：包含已登记的受管源码、公开参数与契约接线。编辑只改变草稿，可另存新组合，或停止受管程序并审阅后更新当前组合。私有身份和运行数据保留；外部程序不纳入源码打包。', 'Static assembly draft from the local Hub: registered managed sources, public settings and capability wiring. Edits affect the draft. Save as new, or stop managed programs and review an update to the current composition. Private identities and runtime data are retained; external program source is excluded.')) : null,
      tabsBar,
      panelAssembly,
      panelConnections,
      panelStartup,
      panelTools,
      saveDialog,
      deriveDialog
    ].filter(Boolean));
    reinstate(root, saved);
    draftStatus();
  }
  function rebuildForm() {
    return form([field('directory', say('仍有完整旧锁的来源目录', 'Source directory with its complete old lock'), extra.directory), field('destination', say('新的重建包目录', 'New rebuilt pack directory'))], say('审阅并复制重建锁', 'Review, copy, and rebuild lock'), async f => {
      const body = { directory: value(f, 'directory'), destination: value(f, 'destination'), redistributionAcknowledged: true, ...env() };
      reviewAction(say('显式重建锁定环境', 'Explicitly rebuild the locked environment'), [note(say('用于旧包锁定的 Hub 或解释器版本已变化。后台先验证旧锁对应的源文件摘要，再复制到新目录，并明确生成当前所选环境的新锁；不能用它绕过未知源码或权限变化。原包保留，不安装依赖、不执行模块。新包仍需重新检查和授权。', 'Use when the Hub or interpreter version pinned by an old pack has changed. The backend verifies source files against the old lock, copies into a new directory, then explicitly creates a lock for the selected current environment. This cannot bypass unknown source or permission changes. The original is retained. Dependencies are not installed and modules are not executed. The new pack still requires review and authorization.'), true), definition([[t('source'), body.directory], [t('destination'), body.destination], [t('environmentReview'), env()]])], say('我已检查原始来源、当前环境与复制许可，明确允许创建新的锁文件，并会重新审阅新包。', 'I reviewed the original sources, current environment, and copying rights, explicitly authorize a new lock, and will review the new pack.'), async () => {
        const result = await operation(await api('/api/authoring/rebuild', body), 'rebuild'); extra.directory = result.directory; extra.authoring = null; extra.edited = null; renderCreator(); toast(say(`已重建到新目录：${result.directory}`, `Rebuilt in a new directory: ${result.directory}`));
      });
    });
  }
  function publishPanel() {
    return panel(say('发布到可分享的软件源目录', 'Publish to a shareable source directory'), [form([field('directory', say('要发布的包或模块目录', 'Pack or module directory to publish'), extra.directory), el('label', {}, [say('制品类型', 'Artifact kind'), el('select', { name: 'kind' }, [el('option', { value: 'pack' }, say('整合包', 'Pack')), el('option', { value: 'module' }, say('模块', 'Module')), el('option', { value: 'template' }, say('模板', 'Template'))])]), field('destination', say('新的发布目录', 'New publication directory'))], say('审阅并生成索引与制品', 'Review and generate index & artifact'), async f => {
      const body = { directory: value(f, 'directory'), destination: value(f, 'destination'), kind: value(f, 'kind'), redistributionAcknowledged: true, ...env() };
      reviewAction(say('发布本机制品', 'Publish local artifact'), [note(say('生成新的索引和内容制品供你分享，不会上传公网。只发布公开包或模块，不包含实例数据；公开 settings 会包含在内。', 'Creates a new index and content artifact for you to share. Nothing is uploaded. Only public packs or modules are published; instance data is excluded. Public settings are included.'), true), definition([[t('source'), body.directory], [t('destination'), body.destination], [say('类型', 'Kind'), body.kind]])], say('我确认公开内容没有秘密，许可允许再分发，并已检查来源与版权。', 'I confirm the public contents contain no secrets, licenses permit redistribution, and sources and copyright were reviewed.'), async () => {
        const data = await api('/api/sources/publish', body); await operation(data, 'publish', result => toast(say(`索引已生成：${result.indexPath}`, `Index generated: ${result.indexPath}`)));
      });
    }, say('生成后将 indexPath 添加到软件源，即可验证获取流程。', 'Add the generated indexPath as a software source to verify fetching.'))]);
  }
  function proposalPanel() {
    const exportForm = form([field('destination', say('新的提案目录', 'New proposal directory'))], say('导出当前草稿为协作提案', 'Export this draft as a proposal'), async f => {
      await recheckDraftCandidates();
      const body = editedBody(f);
      reviewAction(say('导出协作提案', 'Export collaboration proposal'), [note(say('提案携带基线内容版本和派生修改。接收方应用时会核对基线；源码变化会报冲突，不自动合并。公开配置与替换模块会随提案分享。', 'A proposal contains the base content revision and derived changes. Applying it checks the base; changed sources produce a conflict without automatic merging. Public settings and replacement modules are shared.'), true), jsonView(say('提案内容', 'Proposal contents'), body, true)], say('我已审阅提案内容，确认其无私人秘密并符合再分发许可。', 'I reviewed the proposal, confirmed it has no private secrets, and verified redistribution rights.'), async () => { const result = await operation(await api('/api/authoring/proposal', body), 'proposal'); toast(say(`提案已导出：${result.directory}`, `Proposal exported: ${result.directory}`)); });
    });
    const apply = form([field('proposalDirectory', say('收到的提案目录', 'Received proposal directory')), field('destination', say('新的应用结果目录', 'New result directory'))], say('检查基线并应用到新目录', 'Check base and apply to a new directory'), async f => {
      const body = { directory: extra.directory, proposalDirectory: value(f, 'proposalDirectory'), destination: value(f, 'destination'), redistributionAcknowledged: true, ...env() };
      reviewAction(say('应用外部协作提案', 'Apply external collaboration proposal'), [note(say('提案是第三方输入，不是执行授权。后台验证当前源版本和提案内容，冲突会拒绝。结果写入新目录，不更改当前源，不启动模块。', 'A proposal is third-party input, not execution authorization. The backend verifies the current source revision and proposal; conflicts are rejected. Results go to a new directory. Sources remain unchanged and modules are not started.'), true), definition([[t('source'), extra.directory], [say('提案', 'Proposal'), body.proposalDirectory], [t('destination'), body.destination]])], say('我信任提案来源，已检查其许可并允许复制到新的本机目录。', 'I trust this proposal source, reviewed its license, and allow copying into a new local directory.'), async () => { const result = await operation(await api('/api/authoring/apply-proposal', body), 'proposal'); toast(say(`提案已应用：${result.directory}`, `Proposal applied: ${result.directory}`)); });
    });
    return panel(say('协作提案与冲突检查', 'Collaboration proposals & conflict checks'), [exportForm, el('hr', { class: 'advanced-rule' }), apply]);
  }
  function commentsPanel() {
    const list = el('div', { class: 'stack' });
    const load = async () => { const data = await api('/api/authoring/read-comments', { directory: extra.directory }); extra.comments = data.comments; renderCommentList(); };
    const renderCommentList = () => {
      list.replaceChildren(...(extra.comments?.comments ?? []).map(comment => el('article', { class: 'review-module' }, [el('h4', {}, comment.author), el('p', { class: 'comment-text' }, comment.text), el('p', { class: 'review-digest' }, date(comment.createdAt ?? comment.at))])));
      if (!extra.comments?.comments?.length) list.append(el('p', { class: 'field-help' }, say('读取评论以获取当前版本，再添加或导入。', 'Read comments to obtain the current revision before adding or importing.')));
    };
    renderCommentList();
    const add = form([field('author', say('署名（本地自报）', 'Author (locally declared)')), field('text', say('评论内容', 'Comment text'), '', { multiline: true, rows: 3 })], say('按当前版本添加评论', 'Add comment at current revision'), async f => {
      if (!extra.comments) await load();
      extra.comments = await operation(await api('/api/authoring/comments', { directory: extra.directory, author: value(f, 'author'), text: value(f, 'text'), expectedRevision: extra.comments.revision }), 'comments'); renderCommentList(); f.elements.text.value = '';
    }, say('署名不是账号认证。评论是纯文本；并发修改会报版本冲突，重新读取后再决定。', 'Author names are not authenticated accounts. Comments are plain text. Concurrent edits cause revision conflicts; reload before deciding.'));
    const exchange = form([field('destination', say('新的评论导出文件', 'New comment export file'), '', { pathPurpose: 'save-file' })], say('导出评论', 'Export comments'), async f => { const result = await operation(await api('/api/authoring/export-comments', { directory: extra.directory, destination: value(f, 'destination') }), 'comments'); toast(say(`评论已导出：${result.destination ?? value(f, 'destination')}`, `Comments exported: ${result.destination ?? value(f, 'destination')}`)); });
    const importComments = form([field('source', say('收到的评论交换文件', 'Received comment exchange file'), '', { pathPurpose: 'comments' })], say('审阅并导入评论', 'Review and import comments'), async f => {
      if (!extra.comments) await load(); const source = value(f, 'source'), expectedRevision = extra.comments.revision;
      reviewAction(say('导入协作评论', 'Import collaboration comments'), [definition([[t('source'), source], [say('当前版本', 'Current revision'), expectedRevision]]), note(say('只导入纯文本评论，不执行代码。后台检查基线版本，冲突不覆盖现有评论。', 'Imports plain-text comments only. No code executes. The backend checks the base revision; conflicts do not overwrite current comments.'))], say('我已审阅评论来源，允许添加到此包的协作记录。', 'I reviewed this comment source and allow adding it to this pack’s collaboration record.'), async () => { extra.comments = await operation(await api('/api/authoring/import-comments', { directory: extra.directory, source, expectedRevision }), 'comments'); renderCommentList(); });
    });
    return panel(say('本地讨论与评论交换', 'Local discussion & comment exchange'), [button(say('读取最新评论', 'Read current comments'), load, 'button button-small button-quiet'), list, add, exchange, importComments]);
  }

  function isolationPanel() {
    return createIsolationPanel({ ...ctx, button, say, panel, note, field, form, value, jsonView });
  }
  function renderEnvironmentTools() {
    let mount = $('#advanced-environment');
    if (!mount) { mount = el('div', { id: 'advanced-environment' }); $('#view-environment').append(mount); }
    const saved = preserve(mount); extra.formScope = 'environment';
    const discover = button(say('发现已安装解释器', 'Discover installed interpreters'), async () => {
      const data = await api('/api/environment', env()); state.environment = data;
      renderCandidates(data.candidates ?? {}); toast(say('选择已安装路径后再次检测。发现结果尚未执行探针。', 'Select an installed path and detect again. Discovery entries have not been probed.'));
    }, 'button button-quiet');
    const candidates = el('div', { id: 'environment-candidates' });
    const renderCandidates = (groups = {}) => {
      candidates.replaceChildren(...['node', 'python'].flatMap(kind => (groups[kind] ?? []).map(candidate => el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, kind), el('p', {}, candidate.path), el('p', {}, `${candidate.source} · ${say('尚未探测', 'Not probed')}`)]), button(say('选择此路径', 'Select this path'), () => { $('#environment-form').elements[`${kind}Path`].value = candidate.path; state.environmentSelection = {}; toast(say('已填入路径，请重新检测。', 'Path selected. Detect again to verify it.')); }, 'button button-small button-quiet')]))));

      for (const kind of ['node', 'python']) {
        const slot = $(`#${kind}-candidates-slot`);
        if (!slot) continue;
        const items = groups[kind] ?? [];
        if (!items.length) {
          slot.replaceChildren();
          continue;
        }
        const form = $('#environment-form');
        const currentVal = form?.elements[`${kind}Path`]?.value?.trim()?.toLowerCase() ?? '';
        const chips = items.map(candidate => {
          const isSelected = Boolean(currentVal && candidate.path.toLowerCase() === currentVal);
          const labelName = candidate.path.split(/[/\\]/).pop() || candidate.path;
          const chip = el('button', {
            type: 'button',
            class: `candidate-chip${isSelected ? ' is-selected' : ''}`,
            title: `${candidate.path} (${candidate.source})`
          }, [
            el('span', { class: 'candidate-chip-icon', 'aria-hidden': 'true' }, '⚡'),
            el('span', { class: 'candidate-chip-name' }, labelName),
            el('span', { class: 'candidate-chip-source' }, candidate.source)
          ]);
          chip.addEventListener('click', () => {
            if (form?.elements[`${kind}Path`]) {
              form.elements[`${kind}Path`].value = candidate.path;
              form.elements[`${kind}Path`].dispatchEvent(new Event('input', { bubbles: true }));
              form.elements[`${kind}Path`].dispatchEvent(new Event('change', { bubbles: true }));
            }
            state.environmentSelection = {};
            renderCandidates(state.environment?.candidates ?? groups);
            toast(say(`已选用 ${kind === 'node' ? 'Node.js' : 'Python'} 候选路径，重新检测后生效。`, `Selected ${kind === 'node' ? 'Node.js' : 'Python'} candidate path. Detect again to verify.`));
          });
          return chip;
        });
        slot.replaceChildren(
          el('div', { class: 'env-candidates-bar' }, [
            el('span', { class: 'env-candidates-label' }, say('发现候选:', 'Discovered:')),
            el('div', { class: 'env-candidates-chips' }, chips)
          ])
        );
      }
    };


    const prepare = form([field('directory', say('需要准备依赖的包目录', 'Pack directory requiring dependencies'))], say('审阅隔离依赖准备方案', 'Review isolated dependency preparation'), async f => {
      const data = await api('/api/environment/plan', { directory: value(f, 'directory'), ...env() }); extra.environmentPlan = data;
      const plan = data.plan;
      reviewAction(say('准备独立 Python 环境', 'Prepare an independent Python environment'), [note(say('只按下列有限声明式方案创建不含 pip 的新 Python venv，将校验后的固定 wheel 内容复制到新环境。不运行 ensurepip、pip 或模块安装脚本，不改变系统环境；虚拟环境不是 OS 沙箱。下载依赖会访问显示的来源。', 'Creates a new Python venv without pip and copies the verified fixed wheel contents into it according to the limited plan below. It does not run ensurepip, pip, or module install scripts, or change the system environment. A venv is not an OS sandbox. Downloads contact the displayed source.'), true), definition([[t('source'), plan.directory], [say('基础解释器', 'Base interpreter'), plan.base?.executable], [t('destination'), plan.destination], [say('下载', 'Download'), plan.download?.url], ['SHA-256', plan.download?.sha256]]), jsonView(say('完整操作与锁定要求', 'Complete actions & lock requirements'), plan, true)], say('我已审阅解释器、下载来源、依赖摘要和操作，允许创建这个新环境。', 'I reviewed the interpreter, download source, dependency digest, and actions and allow this new environment to be created.'), async () => {
        const data = await api('/api/environment/prepare', { planId: extra.environmentPlan.planId, accepted: true }); await operation(data, 'environment', result => {
          $('#advanced-environment-results').replaceChildren(note(say('依赖环境已准备。请明确选择新解释器，再重新检查包并导入新实例；现有授权不自动迁移。', 'Dependency environment prepared. Explicitly select the new interpreter, inspect the pack again, and import a new instance. Existing authorizations are not transferred.')), definition([[t('pythonPath'), result.pythonPath]]), button(say('选择新 Python 路径', 'Select new Python path'), () => { $('#environment-form').elements.pythonPath.value = result.pythonPath; state.environmentSelection = {}; toast(say('已选择。请重新检测与审阅。', 'Selected. Detect and review again.')); }, 'button button-primary'));
        });
      });
    }, say('当前有限方案只准备支持且锁定的 Python 依赖，未知依赖显示可复制的手动指引。Node 使用已安装解释器。', 'The limited recipe prepares supported locked Python dependencies only. Unknown dependencies provide copyable manual guidance. Node uses an installed interpreter.'));
    const discoverySlot = $('#environment-discovery-slot');
    const isolationSlot = $('#env-isolation-slot');
    const dependenciesSlot = $('#env-dependencies-slot');
    if (discoverySlot) {
      discoverySlot.replaceChildren();
    }
    if (isolationSlot && dependenciesSlot) {
      isolationSlot.replaceChildren(isolationPanel());
      dependenciesSlot.replaceChildren(
        el('div', { class: 'env-dependencies-grid' }, [
          panel(say('经审阅的依赖准备', 'Reviewed dependency preparation'), [prepare, el('div', { id: 'advanced-environment-results', role: 'status', 'aria-live': 'polite' })]),
          resultLibrary('environment')
        ])
      );
      mount.replaceChildren();
    } else {
      mount.replaceChildren(isolationPanel(), panel(say('发现与选择环境', 'Discover & select environments'), [discover, candidates]), panel(say('经审阅的依赖准备', 'Reviewed dependency preparation'), [prepare, el('div', { id: 'advanced-environment-results', role: 'status', 'aria-live': 'polite' })]), resultLibrary('environment'));
    }
    if (state.environment?.candidates) renderCandidates(state.environment.candidates);
    else renderCandidates({});
    reinstate(mount, saved);
  }

  async function loadKnown() {
    try {
      const data = await api('/api/paths/known');
      extra.known = data;
      extra.knownObjects = data.objects ?? [];
      for (const row of (data.objects ?? []).filter(item => item.origin === 'cache').reverse()) {
        if (!extra.results.some(item => item.kind === 'fetch' && sameDirectory(item.result?.directory, row.path))) {
          rememberResult('fetch', { directory: row.path, kind: row.kind, id: row.id, version: row.version, cachedObservation: true });
        }
      }
      updateModuleAndTemplateCounts();
      closeStaleAssetDetails('local', [...groupAssets(getModules(), { kind: 'module' }), ...groupAssets(getTemplates(), { kind: 'template' })]);
      if (state.view === 'modules') renderModules();
      if (state.view === 'templates') renderTemplates();
      if (state.view === 'creator' && !extra.edited) renderCreator();
      if (state.view === 'packs') renderAssetTabs('packs');
      return data;
    } catch {
      return null;
    }
  }

  function getModules() {
    const list = [];
    const seen = new Set();
    const add = mod => {
      if (!mod || !mod.id) return;
      const key = assetDeletionKey('module', mod);
      if (isDeletedObject('module', mod)) return;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(mod);
    };
    for (const obj of extra.knownObjects) {
      if (obj.kind === 'module') add(obj);
    }
    for (const row of extra.results) {
      if (row.kind === 'fetch' && row.result?.kind === 'module') {
        add({
          kind: 'module',
          id: row.result.id ?? row.result.entry?.id,
          version: row.result.version ?? row.result.entry?.version,
          path: row.result.directory,
          title: row.result.title ?? row.result.entry?.title,
          runtime: row.result.runtime,
          origin: 'cache'
        });
      }
    }
    return list;
  }

  function getTemplates() {
    const list = [];
    const seen = new Set();
    const add = tpl => {
      if (!tpl || !tpl.id) return;
      const key = assetDeletionKey('template', tpl);
      if (isDeletedObject('template', tpl)) return;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(tpl);
    };
    for (const obj of extra.knownObjects) {
      if (obj.kind === 'template') add(obj);
    }
    for (const row of extra.results) {
      if (row.kind === 'create-template' && row.result?.directory) {
        add({
          kind: 'template',
          id: row.result.id ?? 'custom.template',
          version: row.result.version ?? '1.0.0',
          path: row.result.directory,
          title: row.result.title ?? say('自定义工程模板', 'Custom Project Template'),
          origin: 'created'
        });
      }
      if (row.kind === 'fetch' && row.result?.kind === 'template') {
        add({
          kind: 'template',
          id: row.result.id ?? row.result.entry?.id,
          version: row.result.version ?? row.result.entry?.version,
          path: row.result.directory,
          title: row.result.title ?? row.result.entry?.title,
          origin: 'cache'
        });
      }
    }
    return list;
  }

  function updateModuleAndTemplateCounts() {
    const modulesCount = groupAssets(getModules(), { kind: 'module' }).length;
    const templatesCount = groupAssets(getTemplates(), { kind: 'template' }).length;
    const packsCount = groupAssets(state.instances ?? [], { mode: 'instance' }).length;
    const navModules = $('#nav-modules-count');
    if (navModules) navModules.textContent = String(modulesCount);
    const navTemplates = $('#nav-templates-count');
    if (navTemplates) navTemplates.textContent = String(templatesCount);
    const navPacks = $('#nav-count');
    if (navPacks) navPacks.textContent = String(packsCount);
  }

  function renderAssetTabs(explicitView) {
    const activeView = ['packs', 'modules', 'templates'].includes(explicitView ?? state.view)
      ? (explicitView ?? state.view)
      : 'packs';
    const packsCount = groupAssets(state.instances ?? [], { mode: 'instance' }).length;
    const modulesCount = groupAssets(getModules(), { kind: 'module' }).length;
    const templatesCount = groupAssets(getTemplates(), { kind: 'template' }).length;
    updateModuleAndTemplateCounts();

    for (const viewName of ['packs', 'modules', 'templates']) {
      const slot = $(`#${viewName}-asset-tabs`);
      if (!slot) continue;
      const tabDefs = [
        { key: 'packs', icon: 'packs', title: say('我的整合包', 'My Packs'), count: packsCount },
        { key: 'modules', icon: 'modules', title: say('我的模块', 'My Modules'), count: modulesCount },
        { key: 'templates', icon: 'templates', title: say('我的模板', 'My Templates'), count: templatesCount }
      ];
      const bar = el('div', { class: 'asset-tabs-bar', role: 'group', 'aria-label': say('资产分类导航', 'Asset Type Tabs') },
        tabDefs.map(tab => {
          const active = tab.key === activeView;
          const btn = button([
            createIcon ? createIcon(tab.icon, 'tab-icon') : null,
            el('span', { class: 'asset-tab-label' }, tab.title),
            el('span', { class: 'asset-tab-count' }, String(tab.count))
          ].filter(Boolean), () => navigate(tab.key), `view-subtab asset-subtab${active ? ' is-active' : ''}`);
          btn.setAttribute('aria-pressed', String(active));
          return btn;
        })
      );
      slot.replaceChildren(bar);
    }
  }

  function friendlyModuleName(id) {
    if (id === 'demo.desk') return say('工作台可视化前台', 'Interactive Desk UI');
    if (id === 'demo.source') return say('文本读取数据源', 'Text Read Source');
    if (id === 'demo.stats') return say('Python 文本统计模块', 'Python Text Statistics');
    return id;
  }
  function friendlyModuleDesc(id) {
    if (id === 'demo.desk') return say('提供可视化工作台 UI，用于交互式展示与控制。', 'Interactive desk UI for monitoring and control.');
    if (id === 'demo.source') return say('提供 text.read 契约，保存文本并回应读取请求。', 'Provides text.read, storing text and answering read requests.');
    if (id === 'demo.stats') return say('提供 text.statistics 契约，使用 Python 统计字符、行和 UTF-8 字节。', 'Provides text.statistics, counting code points, lines and UTF-8 bytes with Python.');
    return say('独立功能模块，可在工作台中装配。', 'Independent modular component for Studio assembly.');
  }

  function confirmDeleteModule(mod) {
    const name = mod.title || mod.id;
    askConfirm({
      title: t('deleteModule'),
      message: say(`确认从模块库中移除「${name}」的所选版本 ${mod.version ?? '—'}（${mod.path ?? '—'}）？其他版本与目录保留。`, `Remove the selected version ${mod.version ?? '—'} of "${name}" (${mod.path ?? '—'})? Other versions and directories remain.`),
      danger: true,
      confirmText: t('delete'),
      onConfirm: () => {
        const key = assetDeletionKey('module', mod);
        saveDeletedObject('module', mod);
        extra.knownObjects = extra.knownObjects.filter(item => item.kind !== 'module' || assetDeletionKey('module', item) !== key);
        extra.results = extra.results.filter(row => row.result?.kind !== 'module' || assetDeletionKey('module', { ...row.result, path: row.result.directory }) !== key);
        updateModuleAndTemplateCounts();
        if (state.view === 'modules') renderModules();
        toast(say(`已移除模块「${name}」`, `Removed module "${name}"`));
      }
    });
  }

  function confirmDeleteTemplate(tpl) {
    const name = tpl.title || tpl.id;
    askConfirm({
      title: t('deleteTemplate'),
      message: say(`确认从模板库中移除「${name}」的所选版本 ${tpl.version ?? '—'}（${tpl.path ?? '—'}）？其他版本与目录保留。`, `Remove the selected version ${tpl.version ?? '—'} of "${name}" (${tpl.path ?? '—'})? Other versions and directories remain.`),
      danger: true,
      confirmText: t('delete'),
      onConfirm: () => {
        const key = assetDeletionKey('template', tpl);
        saveDeletedObject('template', tpl);
        extra.knownObjects = extra.knownObjects.filter(item => item.kind !== 'template' || assetDeletionKey('template', item) !== key);
        extra.results = extra.results.filter(row => !['create-template', 'fetch'].includes(row.kind) || assetDeletionKey('template', { ...row.result, path: row.result?.directory }) !== key);
        updateModuleAndTemplateCounts();
        if (state.view === 'templates') renderTemplates();
        toast(say(`已移除模板「${name}」`, `Removed template "${name}"`));
      }
    });
  }

  function renderModules() {
    renderAssetTabs('modules');
    const root = $('#modules-content');
    if (!root) return;

    const modules = groupAssets(getModules(), { kind: 'module' });
    const hero = el('div', { class: 'page-heading modules-hero' }, [
      el('div', {}, [
        el('div', { class: 'eyebrow' }, 'YOUR LOCAL MODULES / 本地功能模块'),
        el('h1', {}, t('modulesTitle')),
        el('p', {}, t('modulesSubtitle'))
      ])
    ]);

    const searchInput = el('input', {
      type: 'search',
      id: 'modules-search',
      class: 'search-input',
      placeholder: say('搜索模块名称、契约或语言…', 'Search module name, contract, or runtime…'),
      value: extra.modulesSearch
    });
    searchInput.addEventListener('input', e => {
      extra.modulesSearch = e.target.value.trim().toLowerCase();
      renderModulesList(listContainer);
    });

    const importModuleBtn = button([
      createIcon ? createIcon('plus') : '＋',
      el('span', {}, t('importModule'))
    ], () => deploymentUi.importArtifact('module'), 'button button-primary');

    const marketplaceBtn = button([
      createIcon ? createIcon('sources') : '🛍️',
      el('span', {}, say('从工坊获取更多模块', 'Get More from Marketplace'))
    ], () => {
      navigate('sources');
    }, 'button button-quiet');

    const toolbar = el('div', { class: 'collection-toolbar' }, [
      el('div', {}, [
        el('h2', {}, t('modules')),
        el('span', { id: 'modules-collection-count', class: 'count-label' }, t('modulesCountLabel', { count: modules.length }))
      ]),
      el('div', { class: 'collection-toolbar-actions' }, [
        el('label', { class: 'search-field' }, [
          el('span', { 'aria-hidden': 'true' }, createIcon ? createIcon('search') : '⌕'),
          searchInput
        ]),
        importModuleBtn,
        marketplaceBtn
      ])
    ]);

    const listContainer = el('div', { id: 'modules-list', class: 'pack-grid' });
    renderModulesList(listContainer);

    root.replaceChildren(hero, toolbar, listContainer);
  }

  function createModuleAddToDropdown(mod, disabled = false, onAction = null) {
    const wrap = el('div', { class: 'dropdown-wrap module-add-dropdown' });
    const trigger = el('button', {
      class: 'button button-primary button-small dropdown-trigger',
      type: 'button',
      disabled,
      'aria-haspopup': 'true',
      'aria-expanded': 'false'
    }, [
      createIcon ? createIcon('plus') : null,
      el('span', {}, say('添加到', 'Add to')),
      el('span', { class: 'dropdown-caret', 'aria-hidden': 'true' }, '▾')
    ].filter(Boolean));

    const menu = el('div', { class: 'dropdown-menu module-add-menu', hidden: true });

    const itemPack = el('button', {
      class: 'dropdown-item',
      type: 'button',
      disabled,
      onclick: (e) => {
        e.stopPropagation();
        closeMenu();
        if (onAction) onAction();
        addModuleToPackFlow(mod);
      }
    }, [
      el('span', { class: 'dropdown-item-icon' }, '📦'),
      el('div', { class: 'dropdown-item-text' }, [
        el('strong', {}, say('独立Hub(整合包)', 'Standalone Hub (Pack)')),
        el('small', {}, say('装配进独立整合包工作台', 'Assemble into a standalone pack workspace'))
      ])
    ]);

    const itemHub = el('button', {
      class: 'dropdown-item',
      type: 'button',
      disabled,
      onclick: (e) => {
        e.stopPropagation();
        closeMenu();
        if (onAction) onAction();
        addModuleToGlobalHubFlow(mod);
      }
    }, [
      el('span', { class: 'dropdown-item-icon' }, '🌐'),
      el('div', { class: 'dropdown-item-text' }, [
        el('strong', {}, say('全局Hub', 'Global Hub')),
        el('small', {}, say('在工作台中装配至全局 Hub', 'Assemble into Global Hub in workbench'))
      ])
    ]);

    menu.append(itemPack, itemHub);

    function closeMenu() {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      try {
        const card = wrap.closest('.pack-card');
        if (card && card.classList?.remove) card.classList.remove('has-dropdown-open');
      } catch {}
    }

    trigger.onclick = (e) => {
      e.stopPropagation();
      if (disabled) return;
      const willOpen = menu.hidden;
      try {
        document.querySelectorAll('.module-add-menu:not([hidden])').forEach(m => {
          m.hidden = true;
          m.parentElement?.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
          const card = m.closest('.pack-card');
          if (card && card.classList?.remove) card.classList.remove('has-dropdown-open');
        });
      } catch {}
      menu.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        try {
          const card = wrap.closest('.pack-card');
          if (card && card.classList?.add) card.classList.add('has-dropdown-open');
        } catch {}
      }
    };

    wrap.append(trigger, menu);
    return wrap;
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.module-add-dropdown')) {
        try {
          document.querySelectorAll('.module-add-menu:not([hidden])').forEach(m => {
            m.hidden = true;
            m.parentElement?.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
            const card = m.closest('.pack-card');
            if (card && card.classList?.remove) card.classList.remove('has-dropdown-open');
          });
        } catch {}
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        try {
          document.querySelectorAll('.module-add-menu:not([hidden])').forEach(m => {
            m.hidden = true;
            m.parentElement?.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
            const card = m.closest('.pack-card');
            if (card && card.classList?.remove) card.classList.remove('has-dropdown-open');
          });
        } catch {}
      }
    });
  }

  function openModuleDetails(group) {
    const existing = document.querySelector('.module-detail-dialog');
    if (existing) existing.remove();
    const dialog = el('dialog', { class: 'dialog module-detail-dialog', 'aria-label': say('模块详情', 'Module Details') });
    document.body.append(dialog);

    function renderDetails() {
      const selected = assetVersionSelection.get(group);
      trackAssetDetails(dialog, group, selected);
      const mod = selected?.row;

      const titleText = mod?.title || group.title || friendlyModuleName(group.id);
      const descText = mod ? (mod.description || friendlyModuleDesc(mod.id)) : say('原选项已不可用，请在下方重新选择可用版本。', 'Previous selection unavailable; please choose an available version below.');
      const kind = mod ? runtimeKind(mod) : '';
      const runtimeBadge = kind ? el('span', { class: `runtime-kind-chip ${kind === 'python' ? 'badge-python' : kind === 'node' ? 'badge-node' : ''}` }, runtimeLabel(mod)) : null;

      const providesList = Array.isArray(mod?.provides) ? mod.provides.map(p => typeof p === 'string' ? p : p.id) : [];
      const requiresList = Array.isArray(mod?.requires) ? mod.requires.map(r => typeof r === 'string' ? r : r.id) : [];

      const contractTags = [];
      if (providesList.length) {
        contractTags.push(el('div', { class: 'contract-tag-group' }, [
          el('span', { class: 'badge-label' }, say('提供契约', 'Provides')),
          ...providesList.map(c => pill(c, 'teal'))
        ]));
      }
      if (requiresList.length) {
        contractTags.push(el('div', { class: 'contract-tag-group' }, [
          el('span', { class: 'badge-label' }, say('依赖契约', 'Requires')),
          ...requiresList.map(c => pill(c, 'amber'))
        ]));
      }
      if (!contractTags.length && mod) {
        contractTags.push(el('span', { class: 'subtle' }, say('通用微服务 · 无强制契约', 'General microservice · No strict contract')));
      }

      const versionSelector = renderAssetVersionSelector({ el, say }, group, assetVersionSelection, {
        onChange: () => {
          renderDetails();
          if (state.view === 'modules') renderModules();
        }
      });

      const copyBtn = mod?.path ? button(say('复制路径', 'Copy Path'), async () => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(mod.path);
          }
          toast(say('已复制路径到剪贴板', 'Path copied to clipboard'));
        } catch {
          toast(say('无法自动复制，请手动复制', 'Could not copy automatically; please copy manually'));
        }
      }, 'button button-small button-quiet') : null;

      const pathSection = mod?.path ? el('div', { class: 'module-detail-section' }, [
        el('span', { class: 'field-label' }, say('路径', 'Path')),
        el('div', { class: 'module-path-box' }, [
          el('code', { class: 'mono field-help' }, mod.path),
          copyBtn
        ])
      ]) : null;

      const closeBtn = button('×', () => dialog.close(), 'icon-button');
      closeBtn.setAttribute('aria-label', say('关闭', 'Close'));

      const heading = el('div', { class: 'dialog-heading' }, [
        el('div', { class: 'module-detail-header-info' }, [
          el('div', { class: 'module-detail-title-row' }, [
            el('h2', {}, titleText),
            runtimeBadge
          ].filter(Boolean)),
          el('p', { class: 'pack-card-sub mono' }, `${group.id}${mod?.version ? ` @v${mod.version}` : ''}`)
        ]),
        closeBtn
      ]);

      const body = el('div', { class: 'module-detail-body' }, [
        el('div', { class: 'module-detail-section' }, [
          el('p', { class: 'module-card-desc' }, descText)
        ]),
        versionSelector ? el('div', { class: 'module-detail-section' }, [versionSelector]) : null,
        pathSection,
        contractTags.length ? el('div', { class: 'module-detail-section' }, [
          el('span', { class: 'field-label' }, say('契约契合与通信接口', 'Contracts & Interfaces')),
          el('div', { class: 'module-contracts-row' }, contractTags)
        ]) : null,
        mod?.entry || mod?.runtime?.entry ? el('div', { class: 'module-detail-section' }, [
          el('span', { class: 'field-label' }, say('启动入口', 'Entry point')),
          el('code', { class: 'mono field-help' }, mod.entry || mod.runtime?.entry)
        ]) : null
      ].filter(Boolean));

      const actions = el('div', { class: 'dialog-footer module-detail-actions' }, [
        button(t('delete'), () => {
          dialog.close();
          confirmDeleteModule(mod);
        }, 'button button-danger-quiet button-small module-delete-btn', !mod),
        createModuleAddToDropdown(mod, !mod, () => dialog.close()),
        button(say('关闭', 'Close'), () => dialog.close(), 'button button-secondary button-small')
      ]);

      dialog.replaceChildren(heading, body, actions);
    }

    renderDetails();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
    return dialog;
  }

  function renderModulesList(container) {
    const q = extra.modulesSearch;
    const modules = groupAssets(getModules(), { kind: 'module' }).filter(group => group.options.some(({ row: m }) => {
      if (!q) return true;
      const haystack = `${m.id} ${m.title ?? ''} ${m.version ?? ''} ${m.path ?? ''} ${m.description ?? ''} ${m.runtime?.kind ?? ''} ${m.provides?.map(p => typeof p === 'string' ? p : p.id).join(' ') ?? ''} ${m.requires?.map(r => typeof r === 'string' ? r : r.id).join(' ') ?? ''}`.toLowerCase();
      return haystack.includes(q);
    }));

    const countLabel = $('#modules-collection-count');
    if (countLabel) countLabel.textContent = t('modulesCountLabel', { count: modules.length });

    if (!modules.length) {
      container.replaceChildren(
        el('div', { class: 'empty-state' }, [
          el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('modules', 'icon-lg') : '🧩'),
          el('h3', {}, q ? t('noSearchResults') : t('noModulesFound')),
          el('p', {}, q ? null : t('noModulesHint')),
          el('div', { class: 'result-actions' }, [
            button(t('importModule'), () => deploymentUi.importArtifact('module'), 'button button-primary'),
            button(say('前往工坊浏览模块', 'Browse Marketplace'), () => navigate('sources'), 'button button-quiet')
          ])
        ])
      );
      return;
    }

    const cards = modules.map(group => {
      const selected = assetVersionSelection.get(group);
      const mod = selected?.row ?? { id: group.id, title: group.title, description: say('原选项已不可用，请重新选择。', 'Previous selection unavailable; choose again.') };
      const kind = runtimeKind(mod);
      const runtimeBadge = el('span', { class: `runtime-kind-chip ${kind === 'python' ? 'badge-python' : kind === 'node' ? 'badge-node' : ''}` }, runtimeLabel(mod));
      const titleText = mod.title || friendlyModuleName(mod.id);
      const descText = mod.description || friendlyModuleDesc(mod.id);

      const coverArt = renderSquareArt({
        icon: mod.icon ?? mod.metadata?.icon ?? mod.image,
        fallbackIcon: 'modules',
        tone: mod.runtime?.kind === 'python' ? 'python' : 'node',
        alt: titleText,
        moduleId: mod.id
      });

      const cardMain = el('div', {
        class: 'pack-card-main',
        role: 'button',
        tabindex: '0',
        'aria-label': say(`查看「${titleText}」详细信息`, `View details for "${titleText}"`),
        title: say('点击查看详细信息', 'Click to view details'),
        onclick: () => openModuleDetails(group),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openModuleDetails(group);
          }
        }
      }, [
        el('div', { class: 'pack-card-media' }, [coverArt]),
        el('div', { class: 'pack-card-content' }, [
          el('div', { class: 'pack-card-header-row' }, [
            el('h3', { class: 'pack-card-title' }, titleText),
            el('div', { class: 'pack-card-badges' }, [runtimeBadge])
          ]),
          el('div', { class: 'pack-card-sub mono' }, `${mod.id}${mod.version ? ` @v${mod.version}` : ''}`),
          el('p', { class: 'module-card-desc' }, descText),
          renderAssetSelectionNotice({ el, say }, group, assetVersionSelection, selected)
        ])
      ]);

      return el('article', { class: 'pack-card module-card', 'data-module-id': mod.id }, [
        cardMain
      ]);
    });

    container.replaceChildren(...cards);
  }

  function renderTemplates() {
    renderAssetTabs('templates');
    const root = $('#templates-content');
    if (!root) return;

    const templates = groupAssets(getTemplates(), { kind: 'template' });
    const hero = el('div', { class: 'page-heading templates-hero' }, [
      el('div', {}, [
        el('div', { class: 'eyebrow' }, 'PACK TEMPLATES & SCAFFOLDING / 整合包起步模板'),
        el('h1', {}, t('templatesTitle')),
        el('p', {}, t('templatesSubtitle'))
      ])
    ]);

    const searchInput = el('input', {
      type: 'search',
      id: 'templates-search',
      class: 'search-input',
      placeholder: say('搜索模板名称、ID 或参数…', 'Search template name, ID, or parameters…'),
      value: extra.templatesSearch
    });
    searchInput.addEventListener('input', e => {
      extra.templatesSearch = e.target.value.trim().toLowerCase();
      renderTemplatesList(listContainer);
    });

    const createTemplateBtn = button([
      createIcon ? createIcon('plus') : '＋',
      el('span', {}, t('createTemplate'))
    ], () => {
      openCreateTemplateModal();
    }, 'button button-primary');

    const marketplaceBtn = button([
      createIcon ? createIcon('sources') : '🛍️',
      el('span', {}, say('从工坊获取更多模板', 'Get More from Marketplace'))
    ], () => {
      navigate('sources');
    }, 'button button-quiet');

    const toolbar = el('div', { class: 'collection-toolbar' }, [
      el('div', {}, [
        el('h2', {}, t('myTemplates')),
        el('span', { id: 'templates-collection-count', class: 'count-label' }, t('templatesCountLabel', { count: templates.length }))
      ]),
      el('div', { class: 'collection-toolbar-actions' }, [
        el('label', { class: 'search-field' }, [
          el('span', { 'aria-hidden': 'true' }, createIcon ? createIcon('search') : '⌕'),
          searchInput
        ]),
        createTemplateBtn,
        marketplaceBtn
      ])
    ]);

    const listContainer = el('div', { id: 'templates-list', class: 'pack-grid' });
    renderTemplatesList(listContainer);

    root.replaceChildren(hero, toolbar, listContainer);
  }

  function openTemplateDetails(group) {
    const existing = document.querySelector('.template-detail-dialog, .module-detail-dialog');
    if (existing) existing.remove();
    const dialog = el('dialog', { class: 'dialog template-detail-dialog module-detail-dialog', 'aria-label': say('模板详情', 'Template Details') });
    document.body.append(dialog);

    function renderDetails() {
      const selected = assetVersionSelection.get(group);
      trackAssetDetails(dialog, group, selected);
      const tpl = selected?.row;

      const titleText = tpl?.title || group.title || group.id;
      const isOfficial = tpl?.origin === 'builtin';
      const originBadge = el('span', { class: `runtime-kind-chip ${isOfficial ? 'badge-official' : 'badge-local'}` }, isOfficial ? say('官方起步', 'Official Starter') : say('自定义模板', 'Custom Template'));
      const descText = tpl ? (tpl.description || say('开箱即用的工程骨架，可配置参数并直接生成锁定整合包。', 'Ready-to-use project skeleton with configurable parameters.')) : say('原选项已不可用，请在下方重新选择可用版本。', 'Previous selection unavailable; please choose an available version below.');

      const paramsSummary = (tpl?.parameters ?? []).map(p => `${p.name} (${p.type ?? 'string'})`);
      const targetPath = tpl?.path;

      const versionSelector = renderAssetVersionSelector({ el, say }, group, assetVersionSelection, {
        onChange: () => {
          renderDetails();
          if (state.view === 'templates') renderTemplates();
        }
      });

      const copyBtn = tpl?.path ? button(say('复制路径', 'Copy Path'), async () => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(tpl.path);
          }
          toast(say('已复制路径到剪贴板', 'Path copied to clipboard'));
        } catch {
          toast(say('无法自动复制，请手动复制', 'Could not copy automatically; please copy manually'));
        }
      }, 'button button-small button-quiet') : null;

      const pathSection = tpl?.path ? el('div', { class: 'module-detail-section' }, [
        el('span', { class: 'field-label' }, say('路径', 'Path')),
        el('div', { class: 'module-path-box' }, [
          el('code', { class: 'mono field-help' }, tpl.path),
          copyBtn
        ])
      ]) : null;

      const closeBtn = button('×', () => dialog.close(), 'icon-button');
      closeBtn.setAttribute('aria-label', say('关闭', 'Close'));

      const heading = el('div', { class: 'dialog-heading' }, [
        el('div', { class: 'module-detail-header-info' }, [
          el('div', { class: 'module-detail-title-row' }, [
            el('h2', {}, titleText),
            originBadge
          ].filter(Boolean)),
          el('p', { class: 'pack-card-sub mono' }, `${group.id}${tpl?.version ? ` @v${tpl.version}` : ''}`)
        ]),
        closeBtn
      ]);

      const body = el('div', { class: 'module-detail-body' }, [
        el('div', { class: 'module-detail-section' }, [
          el('p', { class: 'module-card-desc' }, descText)
        ]),
        versionSelector ? el('div', { class: 'module-detail-section' }, [versionSelector]) : null,
        pathSection,
        paramsSummary.length ? el('div', { class: 'module-detail-section' }, [
          el('span', { class: 'field-label' }, say('可配参数', 'Parameters')),
          el('div', { class: 'template-params-summary' }, [
            ...paramsSummary.map(p => pill(p, 'teal'))
          ])
        ]) : null
      ].filter(Boolean));

      const actions = el('div', { class: 'dialog-footer module-detail-actions' }, [
        button(t('delete'), () => {
          dialog.close();
          confirmDeleteTemplate(tpl);
        }, 'button button-danger-quiet button-small template-delete-btn', !tpl),
        button([
          createIcon ? createIcon('sparkle') : null,
          say('使用', 'Use')
        ].filter(Boolean), () => {
          dialog.close();
          completion.openTemplate(targetPath);
        }, 'button button-primary button-small template-use-btn', !tpl || !targetPath),
        button(say('关闭', 'Close'), () => dialog.close(), 'button button-secondary button-small')
      ]);

      dialog.replaceChildren(heading, body, actions);
    }

    renderDetails();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
    return dialog;
  }

  function renderTemplatesList(container) {
    const q = extra.templatesSearch;
    const templates = groupAssets(getTemplates(), { kind: 'template' }).filter(group => group.options.some(({ row: t }) => {
      if (!q) return true;
      const haystack = `${t.id} ${t.title ?? ''} ${t.version ?? ''} ${t.path ?? ''} ${t.description ?? ''} ${t.parameters?.map(p => p.name).join(' ') ?? ''}`.toLowerCase();
      return haystack.includes(q);
    }));

    const countLabel = $('#templates-collection-count');
    if (countLabel) countLabel.textContent = t('templatesCountLabel', { count: templates.length });

    if (!templates.length) {
      container.replaceChildren(
        el('div', { class: 'empty-state' }, [
          el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, createIcon ? createIcon('templates', 'icon-lg') : '📋'),
          el('h3', {}, q ? t('noSearchResults') : t('noTemplatesFound')),
          el('p', {}, q ? null : t('noTemplatesHint')),
          el('div', { class: 'result-actions' }, [
            button(t('createTemplate'), () => openCreateTemplateModal(), 'button button-primary'),
            button(say('前往工坊浏览模板', 'Browse Marketplace'), () => navigate('sources'), 'button button-quiet')
          ])
        ])
      );
      return;
    }

    const cards = templates.map(group => {
      const selected = assetVersionSelection.get(group);
      const tpl = selected?.row ?? { id: group.id, title: group.title, description: say('原选项已不可用，请重新选择。', 'Previous selection unavailable; choose again.') };
      const isOfficial = tpl.origin === 'builtin';
      const originBadge = el('span', { class: `runtime-kind-chip ${isOfficial ? 'badge-official' : 'badge-local'}` }, isOfficial ? say('官方起步', 'Official Starter') : say('自定义模板', 'Custom Template'));
      const titleText = tpl.title || tpl.id;
      const descText = tpl.description || say('开箱即用的工程骨架，可配置参数并直接生成锁定整合包。', 'Ready-to-use project skeleton with configurable parameters.');

      const targetPath = tpl.path;

      const coverArt = renderSquareArt({
        icon: tpl.icon ?? tpl.metadata?.icon ?? tpl.image,
        fallbackIcon: 'templates',
        tone: 'purple',
        alt: titleText
      });

      const cardMain = el('div', {
        class: 'pack-card-main',
        role: 'button',
        tabindex: '0',
        'aria-label': say(`查看「${titleText}」详细信息`, `View details for "${titleText}"`),
        title: say('点击查看详细信息', 'Click to view details'),
        onclick: () => openTemplateDetails(group),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openTemplateDetails(group);
          }
        }
      }, [
        el('div', { class: 'pack-card-media' }, [coverArt]),
        el('div', { class: 'pack-card-content' }, [
          el('div', { class: 'pack-card-header-row' }, [
            el('h3', { class: 'pack-card-title' }, titleText),
            el('div', { class: 'pack-card-badges' }, [originBadge])
          ]),
          el('div', { class: 'pack-card-sub mono' }, `${tpl.id}${tpl.version ? ` @v${tpl.version}` : ''}`),
          el('p', { class: 'template-card-desc' }, descText),
          renderAssetSelectionNotice({ el, say }, group, assetVersionSelection, selected)
        ])
      ]);

      return el('article', { class: 'pack-card template-card', 'data-template-id': tpl.id }, [
        cardMain
      ]);
    });

    container.replaceChildren(...cards);
  }

  function languageChanged() {
    for (const element of document.querySelectorAll('[data-advanced-i18n]')) element.textContent = label(element.dataset.advancedI18n);
    for (const item of document.querySelectorAll('[data-view]')) {
      const name = labels[item.dataset.view] ? label(item.dataset.view) : t({ packs: 'my', overview: 'overview', hubs: 'hubs', workbench: 'workbench', environment: 'environment' }[item.dataset.view]);
      item.title = name; item.setAttribute('aria-label', name);
    }
    const restoreLabel = $('#restore-entry strong') ?? $('#restore-entry');
    if (restoreLabel) restoreLabel.textContent = say('从私有备份恢复', 'Restore a private backup');
    if (state.view === 'sources') renderSources();
    if (state.view === 'creator') renderCreator();
    if (state.view === 'environment') renderEnvironmentTools();
    if (state.view === 'modules') renderModules();
    if (state.view === 'templates') renderTemplates();
    updateModuleAndTemplateCounts();
  }
  try { const saved = JSON.parse(localStorage.getItem('world-hub.launcher.sources') ?? '[]'); if (Array.isArray(saved) && saved.length) extra.sources = saved.filter(item => typeof item?.name === 'string' && typeof item?.source === 'string').slice(0, 32); else if (!extra.sources.length) extra.sources = [defaultOfficialSource()]; } catch {}
  try { const saved = JSON.parse(localStorage.getItem('world-hub.launcher.source-indexes') ?? '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) extra.indexes = Object.fromEntries(Object.entries(saved).slice(0, 32).filter(([, entry]) => /^[a-f0-9]{64}$/.test(entry?.digest) && Array.isArray(entry?.index?.entries) && entry.index.entries.length <= 4096)); } catch {}
  function sessionReady() {
    const existingRestore = $('#restore-entry');
    if (existingRestore) {
      existingRestore.onclick = () => {
        const menu = $('#import-dropdown-menu');
        if (menu) menu.hidden = true;
        $('#import-dropdown-trigger')?.setAttribute('aria-expanded', 'false');
        openRestore();
      };
    } else {
      const restore = button(say('从私有备份恢复', 'Restore a private backup'), openRestore, 'button button-quiet');
      restore.id = 'restore-entry';
      ($('#packs-restore-slot') ?? $('#view-packs .page-heading') ?? $('#view-packs'))?.append(restore);
    }
    try { const saved = JSON.parse(localStorage.getItem(storageKey('results')) ?? '[]'); if (Array.isArray(saved)) extra.results = saved.filter(row => typeof row?.kind === 'string' && row.result && typeof row.result === 'object' && typeof row.at === 'string').slice(0, 32); } catch {}
    renderEnvironmentTools(); void loadSources(); void loadDrafts().then(() => { if (state.view === 'creator') renderCreator(); }).catch(failure => { extra.draftError = failure.message; draftStatus(); });
    void api('/api/operations').then(({ operations = [] }) => { for (const row of operations.reverse()) { const kind = { 'fetch-source': 'fetch', 'prepare-environment': 'environment' }[row.kind] ?? row.kind; if (row.state === 'succeeded' && ['fetch', 'derive', 'rebuild', 'publish', 'proposal', 'apply-proposal', 'create-template', 'instantiate-template', 'backup', 'environment'].includes(kind)) rememberResult(kind, row.result); } }).catch(() => {});
    void loadKnown();
  }
  window.addEventListener('beforeunload', event => { if (extra.edited && ['pending', 'saving', 'failed'].includes(extra.draftStatus)) { event.preventDefault(); event.returnValue = ''; } });
  if (typeof window !== 'undefined' && !globalThis.process?.versions?.node) {
    window.addEventListener('focus', () => {
      if (state.view === 'sources' && extra.source && !inspectingSource) {
        const expiresAtMs = extra.index?.expiresAt ? Date.parse(extra.index.expiresAt) : 0;
        if (expiresAtMs && expiresAtMs - Date.now() < 60000) {
          void fetchSourceIndex(extra.source, true);
        }
      }
    });
    const timer = setInterval(() => {
      if (state.view === 'sources' && (typeof document === 'undefined' || !document.hidden) && extra.source && !inspectingSource) {
        const expiresAtMs = extra.index?.expiresAt ? Date.parse(extra.index.expiresAt) : 0;
        if (expiresAtMs && expiresAtMs - Date.now() < 2 * 60000) {
          void fetchSourceIndex(extra.source, true);
        }
      }
    }, 30000);
    timer?.unref?.();
  }
  const advancedSelf = {
    managePrograms: deploymentUi.managePrograms,
    reviewAndStartProgram: deploymentUi.reviewAndStartProgram,
    stopProgram: deploymentUi.stopProgram,
    removeProgram: deploymentUi.removeProgram,
    registerProgram: deploymentUi.register,
    compose: deploymentUi.compose,
    openStartupPlan: startupPlanUi.open,
    openStartupPlanReview: startupPlanUi.reviewPlan,
    openPackStartupPlan: async instance => { try { await startupPlanUi.openPack(instance); } catch (failure) { showFailure(failure); } },
    openDynamicAssembly: instance=>dynamicAssemblyUi.open(instance),
    renderDynamicModules: instance=>[dynamicAssemblyUi.render(instance)],
    refreshDynamicModules: instance=>dynamicAssemblyUi.refresh(instance),
    deactivateDynamicModules: ()=>dynamicAssemblyUi.deactivate?.(),
    reviewComponentAction: (instance, componentId, action)=>dynamicAssemblyUi.reviewComponentAction(instance, componentId, action),
    openCreatorFromInstance,
    openCreatorFromPrograms,
    openCreatorForPack,
    label,
    languageChanged,
    sessionReady,
    preserve,
    reinstate,
    renderStorage,
    loadStorage,
    renderEnvironmentTools,
    publisherReport: publisher.reportView,
    openRestore,
    refreshSources() {
      extra.index = null;
      extra.sourceError = null;
      void loadSources().then(() => {
        if (extra.source) void fetchSourceIndex(extra.source, true);
      });
    },
    async openCreator(directory, { throwOnFailure = false } = {}) {
      try {
        if (extra.edited) {
          captureForms($('#creator-content'));
          await saveDraft();
          if (extra.draftError) throw new Error(extra.draftError);
        }
        extra.directory = directory;
        extra.authoring = null;
        extra.edited = null;
        extra.replacements.clear();
        extra.derived = null;
        extra.resetCreator = true;
        navigate('creator');
      } catch (failure) {
        if (throwOnFailure) throw failure;
        showFailure(failure);
      }
    },
    renderAssetTabs,
    getModules,
    getTemplates,
    renderModules,
    renderTemplates,
    loadKnown,
    navigate(view) {
      if (view === 'sources') {
        renderSources();
        if (state.session || !('session' in state)) void loadSources();
        const isExpiring = extra.index?.expiresAt && Date.parse(extra.index.expiresAt) - Date.now() < 60000;
        if (state.session && extra.source && (!extra.index || isExpiring) && !inspectingSource) {
          void fetchSourceIndex(extra.source, true);
        }
      }
      if (view === 'creator') renderCreator();
      if (view === 'environment') renderEnvironmentTools();
      if (view === 'modules') {
        renderModules();
        if (!extra.known) void loadKnown();
      }
      if (view === 'templates') {
        renderTemplates();
        if (!extra.known) void loadKnown();
      }
      if (view === 'packs') {
        renderAssetTabs('packs');
      }
    }
  };
  return advancedSelf;
}
