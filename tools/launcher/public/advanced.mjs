// Optional maintenance, source distribution and creator tools. Remote content is always text.
export function createAdvancedUi(ctx) {
  const { state, api, el, button: baseButton, pill, t, toast, definition, display, date, errorContents, current, idOf, endpoint, operationFor, exitUnconfirmed, refresh, renderDetail, navigate, selectInstance, openImport, replaceInstance } = ctx;
  const $ = selector => document.querySelector(selector);
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const failureDialog = el('dialog', { class: 'dialog' }); document.body.append(failureDialog);
  function showFailure(failure) {
    failureDialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', {}, say('操作未完成', 'Operation incomplete')), baseButton('×', () => failureDialog.close(), 'icon-button')]), ...errorContents(failure));
    if (!failureDialog.open) failureDialog.showModal();
  }
  const button = (title, action, ...options) => baseButton(title, async event => { try { await action(event); } catch (failure) { showFailure(failure); } }, ...options);
  const labels = { sources: ['软件源', 'Software sources'], creator: ['创作工作台', 'Creator workspace'], storage: ['存储与备份', 'Storage & backups'] };
  const label = key => say(...labels[key]);
  const extra = { sources: [], index: null, source: '', indexes: {}, authoring: null, directory: '', edited: null, replacements: new Map(), storage: new Map(), storagePending: new Set(), comments: null, environmentPlan: null, action: null, actionRunning: false, loading: new Set() };
  const env = () => Object.keys(state.environmentSelection).length ? state.environmentSelection : Object.fromEntries(['nodePath', 'pythonPath'].map(key => [key, $('#environment-form').elements[key].value.trim()]).filter(([, value]) => value));
  const panel = (title, children = []) => el('section', { class: 'panel' }, [el('div', { class: 'panel-heading' }, el('h2', {}, title)), ...children]);
  const note = (text, warning = false) => el('div', { class: `notice${warning ? ' notice-warning' : ''}` }, text);
  function field(name, title, value = '', options = {}) {
    const control = el(options.multiline ? 'textarea' : 'input', { name, ...(options.multiline ? { rows: options.rows ?? 5 } : { type: options.type ?? 'text' }), required: options.required ?? true, autocomplete: 'off', spellcheck: 'false', ...(options.pattern ? { pattern: options.pattern } : {}), ...(options.readonly ? { readonly: true } : {}) });
    control.value = value ?? '';
    return el('label', {}, [el('span', {}, title), control]);
  }
  function form(fields, actionLabel, action, help = '') {
    const submit = el('button', { type: 'submit', class: 'button button-primary' }, actionLabel);
    const error = el('div', { class: 'notice notice-error', role: 'alert', hidden: true });
    const form = el('form', { class: 'advanced-form' }, [...fields, help ? el('p', { class: 'field-help' }, help) : null, error, submit]);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return; error.hidden = true; submit.disabled = true;
      try { await action(form, error); } catch (failure) { error.replaceChildren(...errorContents(failure)); error.hidden = false; }
      finally { submit.disabled = false; }
    });
    return form;
  }
  const value = (form, key) => form.elements[key]?.value.trim() ?? '';
  const jsonView = (title, object, open = false) => el('details', { class: 'json-details', ...(open ? { open: true } : {}) }, [el('summary', {}, title), el('pre', {}, JSON.stringify(object, null, 2))]);
  const heading = (title, subtitle, eyebrow) => el('div', { class: 'page-heading' }, el('div', {}, [el('div', { class: 'eyebrow' }, eyebrow), el('h1', {}, title), el('p', {}, subtitle)]));

  const actionDialog = el('dialog', { class: 'dialog', id: 'advanced-action-dialog' });
  document.body.append(actionDialog);
  function reviewAction(title, contents, consent, execute) {
    actionDialog.replaceChildren(); extra.action = execute;
    const check = el('input', { type: 'checkbox' }), submit = button(say('确认已审阅并继续', 'Confirm review and continue'), async () => {
      if (!check.checked || !extra.action || extra.actionRunning) return; submit.disabled = true; check.disabled = true; error.hidden = true; extra.actionRunning = true;
      close.disabled = true; dismiss.disabled = true;
      try { const run = extra.action; await run(); actionDialog.close(); }
      catch (failure) { error.replaceChildren(...errorContents(failure)); error.hidden = false; }
      finally { extra.actionRunning = false; submit.disabled = !check.checked; check.disabled = false; close.disabled = false; dismiss.disabled = false; }
    }, 'button button-primary', true);
    const error = el('div', { class: 'notice notice-error', role: 'alert', hidden: true });
    const close = button('×', () => actionDialog.close(), 'icon-button'), dismiss = button(t('cancel'), () => actionDialog.close(), 'button button-quiet');
    check.addEventListener('change', () => { submit.disabled = !check.checked || extra.actionRunning; });
    actionDialog.append(el('div', { class: 'dialog-heading' }, [el('h2', {}, title), close]), ...contents, el('label', { class: 'consent' }, [check, consent]), error, el('div', { class: 'dialog-footer' }, [dismiss, submit]));
    actionDialog.showModal();
  }
  actionDialog.addEventListener('close', () => { extra.action = null; });
  actionDialog.addEventListener('cancel', event => { if (extra.actionRunning) event.preventDefault(); });
  async function operation(data, kind, onSuccess = () => {}) {
    if (!data.operationId) { await onSuccess(data); return data; }
    const id = data.operationId;
    const status = el('div', { class: 'notice' }, t('processing'));
    const cancel = button(say('取消此操作', 'Cancel this operation'), async () => { await api(`/api/operations/${encodeURIComponent(id)}/cancel`, {}); cancel.disabled = true; cancel.textContent = say('等待取消与清理确认', 'Waiting for cancellation and cleanup'); }, 'button button-small button-quiet');
    if (['environment', 'backup', 'restore', 'fetch'].includes(kind)) status.append(' ', cancel);
    if (actionDialog.open) actionDialog.insertBefore(status, actionDialog.querySelector('.dialog-footer'));
    else { const host = kind === 'environment' ? $('#advanced-environment-results') : $('#advanced-progress'); host?.replaceChildren(status); }
    return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const { operation } = await api(`/api/operations/${encodeURIComponent(id)}`);
        if (operation.state === 'running') { setTimeout(poll, 800); return; }
        if (operation.state === 'failed' || operation.state === 'cancelled') { const failure = Object.assign(new Error(operation.error?.message ?? say('操作取消', 'Operation cancelled')), { guidance: operation.error?.guidance, diagnostic: operation.error?.diagnostic, incompleteDestination: operation.error?.incompleteDestination }); status.className = 'notice notice-error'; status.replaceChildren(...errorContents(failure)); reject(failure); return; }
        status.textContent = say('操作完成。', 'Operation completed.'); await onSuccess(operation.result); await refresh({ explicit: true }); resolve(operation.result);
      } catch (failure) { status.className = 'notice notice-error'; status.replaceChildren(...errorContents(failure)); reject(failure); }
    };
    void poll();
    });
  }

  function bytes(number = 0) { const n = Number(number); return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`; }
  function renderStorage(instance) {
    const id = idOf(instance), storage = extra.storage.get(id), stopped = !exitUnconfirmed(instance) && !operationFor(instance), detached = instance.detached === true || instance.status?.state === 'detached' || storage?.detached === true;
    const inspect = button(say('更新存储观察', 'Refresh storage observation'), () => loadStorage(id, true), 'button button-small button-quiet');
    const rows = storage ? Object.entries(storage.groups ?? {}).map(([group, stats]) => el('div', { class: 'runtime-row' }, [el('h3', {}, group), el('span', { class: 'mono subtle' }, `${bytes(stats.bytes)} · ${stats.files} ${say('文件', 'files')}`)])) : [el('p', { class: 'field-help' }, t('loading'))];
    const backup = form([field('destination', say('新的私有备份文件路径', 'New private backup file path'))], say('审阅并备份', 'Review backup'), async f => {
      const destination = value(f, 'destination');
      reviewAction(say('创建私有实例备份', 'Create private instance backup'), [note(say('备份仅在所属进程确认停止后进行。排除 Runtime 生成的运行配置、日志与临时目录；仍可能含个人数据及程序自行保存的秘密，仅作私人备份。', 'Backup requires confirmed process exit. Generated Runtime configuration, logs, and temporary directories are excluded. It may still contain personal data and secrets saved by applications. Keep it private.'), true), definition([[t('instanceId'), id], [t('destination'), destination], [say('一致性', 'Consistency'), storage?.consistency]])], say('我已确认备份目的地为私有目录，并理解数据和潜在秘密会被复制。', 'I reviewed the private destination and understand that data and possible secrets are copied.'), async () => {
        const data = await api(endpoint(id, 'backup'), { destination, accepted: true }); await operation(data, 'backup', result => toast(say(`私有备份已创建：${result.destination}`, `Private backup created: ${result.destination}`)));
      });
    }, say('备份保存实例数据；公开包导出只保存可共享程序组合。', 'Backups preserve instance data; package exports preserve shareable program compositions.'));
    backup.querySelector('[type=submit]').disabled = !stopped;
    const detach = button(detached ? say('恢复保留的软件', 'Reattach retained software') : say('保留数据卸载', 'Uninstall and retain data'), async () => {
      try {
      const review = detached ? await api(endpoint(id, 'review'), env()) : null;
      reviewAction(detached ? say('重新关联软件', 'Reattach software') : say('保留数据卸载', 'Uninstall and retain data'), [note(say('此操作必须在确认停止后进行。卸载将软件移入实例私有隔离目录并保留业务数据；它不会删除文件或释放磁盘空间。重新关联会重新检查软件与当前环境，之后仍需明确授权启动。', 'This requires confirmed process exit. Uninstall moves software to a private quarantine directory and preserves data. It does not delete files or free disk space. Reattaching rechecks software and the environment; execution still needs explicit review.'), true), definition([[t('instanceId'), id], [say('数据处理', 'Data handling'), say('保留在当前实例', 'Retained in this instance')]]), ...(review ? ctx.reviewView(review) : [])], say('我已审阅当前内容，理解软件保留在隔离目录，数据不会被删除。', 'I reviewed the current contents and understand that software is retained in quarantine and data is not deleted.'), async () => {
        await operation(await api(endpoint(id, detached ? 'reattach' : 'detach'), { ...(review ? { reviewId: review.reviewId } : {}), accepted: true }), detached ? 'reattach' : 'detach'); extra.storage.delete(id); await refresh({ explicit: true }); await loadStorage(id, true);
      });
      } catch (failure) { showFailure(failure); }
    }, 'button button-quiet', !stopped);
    return [panel(label('storage'), [el('div', { class: 'panel-heading' }, [storage ? pill(`${bytes(storage.bytes)} · ${storage.files} ${say('文件', 'files')}`) : null, inspect]), ...rows, note(say('运行期间的存储用量是即时观察，不能证明一致备份。独立目录不等于 OS 访问隔离。', 'Storage usage during a run is an observation, not proof of backup consistency. Independent directories are not OS access isolation.'))]), panel(say('备份与恢复', 'Backup & restore'), [backup, button(say('检查备份并恢复到新实例', 'Inspect backup and restore to a new instance'), openRestore, 'button button-quiet')]), panel(say('实例维护', 'Instance maintenance'), [detach, el('p', { class: 'field-help' }, say('请先停止实例并等待实际进程退出确认。', 'Stop the instance and wait for confirmed process exit first.'))])];
  }
  async function loadStorage(id, explicit = false) {
    if (!id || extra.storagePending.has(id)) return; extra.storagePending.add(id);
    try { const data = await api(endpoint(id, 'storage')); extra.storage.set(id, data.storage ?? data); if (state.selected === id && state.tab === 'storage') renderDetail(true); }
    catch (failure) { if (explicit) showFailure(failure); }
    finally { extra.storagePending.delete(id); }
  }
  const restoreDialog = el('dialog', { class: 'dialog', id: 'restore-dialog' }); document.body.append(restoreDialog);
  function openRestore() {
    let inspected = null;
    const review = el('div'), title = el('h2', {}, say('恢复到新实例', 'Restore to a new instance'));
    const restoreForm = form([field('backup', say('私有备份文件', 'Private backup file')), field('instanceId', t('instanceId'), '', { pattern: '[a-z0-9][a-z0-9._\\-]{0,63}' }), review], say('检查备份', 'Inspect backup'), async f => {
      const backup = value(f, 'backup'), instanceId = value(f, 'instanceId');
      if (!inspected || inspected.path !== backup) {
        const data = await api('/api/backups/inspect', { backup }); const inspection = data.inspection ?? data;
        inspected = { path: backup, inspection }; review.replaceChildren(...[note(say('恢复仅创建新实例，不覆盖已有实例。当前平台与锁兼容性须通过检查；备份含私人数据。恢复后需重新审阅代码与环境，再启动。', 'Restore creates a new instance and never overwrites an existing one. Platform and locked compatibility must pass. Backups contain private data. Review code and environment again before starting.'), true), definition([[say('来源实例', 'Source instance'), inspection.backup?.sourceInstanceId], [say('创建时间', 'Created'), date(inspection.backup?.createdAt)], [say('大小', 'Size'), bytes(inspection.backup?.bytes)], [say('兼容', 'Compatible'), inspection.compatible], [say('SHA-256', 'SHA-256'), inspection.sha256]]), inspection.incompatibilities?.length ? jsonView(say('兼容性诊断', 'Compatibility diagnostics'), inspection.incompatibilities, true) : null].filter(Boolean));
        f.querySelector('[type=submit]').textContent = say('审阅并恢复', 'Review and restore'); return;
      }
      const inspection = inspected.inspection; if (!inspection.compatible) throw new Error(say('备份与当前环境不兼容。', 'This backup is incompatible with the current environment.'));
      reviewAction(say('恢复私有备份', 'Restore private backup'), [definition([[say('备份', 'Backup'), backup], [t('instanceId'), instanceId], ['SHA-256', inspection.sha256]])], say('我已审阅此备份来源，允许将其中私有数据恢复到新的独立实例。', 'I reviewed this backup source and authorize restoring its private data into a new instance.'), async () => {
        const data = await api('/api/backups/restore', { backup, sha256: inspection.sha256, instanceId, ...env(), accepted: true });
        await operation(data, 'restore', async result => { const instance = result.instance ?? result; replaceInstance(instance); restoreDialog.close(); await refresh({ explicit: true }); await selectInstance(idOf(instance)); toast(say('已恢复新实例。启动前仍须审阅授权。', 'New instance restored. Review and authorize before execution.')); });
      });
    });
    restoreDialog.replaceChildren(el('div', { class: 'dialog-heading' }, [title, button('×', () => restoreDialog.close(), 'icon-button')]), restoreForm); restoreDialog.showModal();
  }

  let sourceLoading = false;
  async function loadSources() {
    if (sourceLoading) return; sourceLoading = true;
    try { const data = await api('/api/sources'); if (!Array.isArray(data.sources)) return; extra.sources = [...data.sources, ...extra.sources.filter(row => !row.id && !data.sources.some(source => source.source === row.source))]; extra.catalog = data; if (state.view === 'sources') renderSources(); }
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
    const root = $('#sources-content');
    let communityURL = 'https://peros.cn/workshop/';
    try { communityURL = localStorage.getItem('world-hub.launcher.community') ?? communityURL; } catch {}
    const community = form([field('community', say('可选社区地址（HTTPS）', 'Optional community URL (HTTPS)'), communityURL)], say('在独立页面打开社区', 'Open community in a separate page'), f => {
      const url = new URL(value(f, 'community'));
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443')) throw new Error(say('社区地址须为无凭据的 HTTPS 443 地址。', 'Use a HTTPS 443 community URL without credentials.'));
      try { localStorage.setItem('world-hub.launcher.community', url.href); } catch {}
      window.open(url.href, '_blank', 'noopener,noreferrer');
    }, say('社区提供账号、发布、评论与提案交换，在独立页面运行。复制其 index.json 地址到下面的软件源；社区登录不授予本机管理或程序执行权限。', 'The community provides accounts, publishing, comments and proposal exchange in a separate page. Copy its index.json URL into a source below. Community login does not grant local management or execution permissions.'));
    const sourceSelect = el('select', { name: 'source', 'aria-label': label('sources') }, [el('option', { value: '' }, say('选择软件源', 'Select a source')), ...extra.sources.filter(source => source.enabled !== false).map(source => el('option', { value: source.source }, source.name))]);
    sourceSelect.value = extra.source;
    const result = el('div', { id: 'source-results' });
    const browse = form([sourceSelect], say('读取来源索引', 'Read source index'), async f => {
      const selected = value(f, 'source'); if (!selected) throw new Error(say('请先添加或选择软件源。', 'Add or select a source first.'));
      const configured = extra.sources.find(item => item.source === selected);
      if (configured?.enabled === false) throw new Error(say('软件源已禁用。', 'This source is disabled.'));
      try {
        const data = await api('/api/sources/inspect', configured?.id ? { sourceId: configured.id } : { source: selected, ...(configured?.expectedSha256 ? { expectedSha256: configured.expectedSha256 } : {}), ...(configured?.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}) }); extra.index = data; rememberIndex(selected, data); void loadSources();
      } catch (failure) {
        if (['SOURCE_DISABLED', 'SOURCE_CHANGED', 'SOURCE_POLICY_CHANGED'].includes(failure.code) || !extra.indexes[selected]) throw failure;
        extra.index = extra.indexes[selected]; extra.index.cachedObservation = true; toast(say('来源当前不可用，显示上次索引观察。只能获取后台已验证的制品缓存；不会沿用执行授权。', 'Source unavailable: showing the last index observation. Fetching still requires the backend’s verified artifact cache. Execution authorization is not reused.'));
      }
      extra.source = selected; renderSources();
    });
    const privateNetwork = el('label', { class: 'consent' }, [el('input', { type: 'checkbox', name: 'allowPrivateNetwork' }), el('span', {}, say('使用我信任的私网或 DNS 代理来源；允许获取到本机缓存，运行仍须重新审阅授权。', 'Use a trusted private network or DNS proxy source. Fetching is allowed into the local cache; execution still needs fresh review and authorization.'))]);
    const add = form([field('name', say('显示名称', 'Display name')), field('source', say('本机索引文件或 HTTPS 索引地址', 'Local index file or HTTPS index URL')), field('expectedSha256', say('索引 SHA-256（可选）', 'Index SHA-256 (optional)'), '', { required: false }), privateNetwork], say('添加软件源', 'Add source'), async f => {
      const source = { name: value(f, 'name'), source: value(f, 'source'), expectedSha256: value(f, 'expectedSha256'), allowPrivateNetwork: f.elements.allowPrivateNetwork.checked === true };
      const saved = await api('/api/sources/save', { ...source, enabled: true, priority: 0 });
      extra.source = saved.source.source; extra.index = null; await loadSources(); renderSources();
    });
    const sourcesList = el('div', { class: 'stack' }, extra.sources.map(source => el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, source.name), el('p', {}, source.source), pill(source.enabled === false ? say('已禁用', 'Disabled') : say('已启用', 'Enabled')), el('p', { class: 'field-help' }, `${say('优先级仅排序', 'Priority only orders choices')}: ${source.priority ?? 0}`), source.observation ? jsonView(say('上次观察', 'Last observation'), source.observation) : null]),
      source.id ? button(source.enabled === false ? say('启用', 'Enable') : say('禁用', 'Disable'), () => changeSource(source, { enabled: source.enabled === false }), 'button button-small button-quiet') : button(say('迁移此浏览器来源配置', 'Migrate this browser source configuration'), async () => { await api('/api/sources/save', { name: source.name, source: source.source, enabled: true, priority: 0, ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}), allowPrivateNetwork: source.allowPrivateNetwork === true }); await loadSources(); }, 'button button-small button-quiet'),
      source.id ? form([field('priority', say('优先级', 'Priority'), source.priority ?? 0, { type: 'number' })], say('保存排序', 'Save ordering'), f => changeSource(source, { priority: Number(value(f, 'priority')) })) : null,
      source.id ? button(say('移除配置', 'Remove configuration'), async () => { await api(`/api/sources/${encodeURIComponent(source.id)}/delete`, {}); if (extra.source === source.source) { extra.source = ''; extra.index = null; } await loadSources(); }, 'button button-small button-quiet') : null ])));
    if (extra.catalog?.conflicts?.length) sourcesList.prepend(note(say('相同对象身份存在不同摘要，请明确选择来源与内容。优先级不会自动解决冲突。', 'The same artifact identity has different digests. Select its source and contents explicitly; priority does not resolve conflicts.'), true), jsonView(say('内容冲突', 'Content conflicts'), extra.catalog.conflicts, true));
    root.replaceChildren(heading(label('sources'), say('按合同、平台和许可查找模块与整合包，验证内容后缓存到本机。', 'Find modules and packs by contract, platform, and license, then verify and cache them locally.'), 'OPTIONAL DISTRIBUTION'), note(say('软件源是可选的。浏览和获取不会执行模块，不替代代码审阅或授权。摘要核对证明内容一致性，不证明代码安全；本地实例无需社区在线。', 'Sources are optional. Browsing and fetching do not execute modules or replace code review and authorization. Hashes establish content integrity, not code safety. Local instances work without community services.')), panel(say('托管社区（可选）', 'Hosted community (optional)'), [community]), panel(say('我的软件源', 'My sources'), [sourcesList, el('details', { class: 'json-details' }, [el('summary', {}, say('添加来源', 'Add a source')), add])]), panel(say('发现模块与整合包', 'Discover modules & packs'), [browse, result]));
    if (extra.index) renderSourceEntries(result);
  }
  function renderSourceEntries(target) {
    const data = extra.index, index = data.index ?? {}, entries = index.entries ?? [], allowPrivateNetwork = data.networkPolicy === 'trusted-private-ipv4';
    const search = el('input', { type: 'search', placeholder: say('名称或能力合同', 'Name or capability contract'), 'aria-label': say('筛选软件', 'Filter software') });
    const kind = el('select', { 'aria-label': say('对象种类', 'Object kind') }, [['', say('模块与整合包', 'Modules & packs')], ['pack', say('整合包', 'Pack')], ['module', say('模块', 'Module')]].map(([value, title]) => el('option', { value }, title)));
    const platform = el('input', { placeholder: say('平台，例如 win32-x64', 'Platform, e.g. win32-x64'), 'aria-label': say('平台筛选', 'Platform filter') });
    const license = el('input', { placeholder: say('许可，例如 MIT', 'License, e.g. MIT'), 'aria-label': say('许可筛选', 'License filter') });
    const cards = el('div', { class: 'pack-grid' });
    const filter = () => {
      const query = search.value.toLowerCase(), os = platform.value.toLowerCase(), permission = license.value.toLowerCase();
      const matches = entries.filter(entry => entry && (!kind.value || entry.kind === kind.value) && (!os || entry.platforms?.some(item => String(item).toLowerCase().includes(os))) && (!permission || String(entry.license).toLowerCase().includes(permission)) && JSON.stringify([entry.id, entry.title, entry.provides, entry.requires]).toLowerCase().includes(query));
      cards.replaceChildren(...matches.map(entry => el('article', { class: 'panel source-card' }, [el('div', { class: 'panel-heading' }, [el('h3', {}, entry.title ?? entry.id), pill(entry.kind)]), el('p', { class: 'mono subtle' }, `${entry.id} · ${entry.version}`), el('p', { class: 'field-help' }, `${entry.license ?? '—'} · ${(entry.platforms ?? []).join(', ')}`), jsonView(say('来源、摘要与合同', 'Source, digest & contracts'), { source: entry.source, sha256: entry.sha256, provides: entry.provides, requires: entry.requires }), button(say('验证并获取到缓存', 'Verify and fetch to cache'), () => reviewAction(say('获取软件制品', 'Fetch software artifact'), [note(say('内容会验证摘要后保存到新的本机缓存目录，不安装依赖、不导入实例、不启动程序。', 'Contents are hash-verified into a new local cache directory. This does not install dependencies, import an instance, or execute programs.')), definition([[say('来源索引', 'Source index'), extra.source], ['ID', entry.id], [say('许可', 'License'), entry.license], ['SHA-256', entry.sha256], [say('网络策略', 'Network policy'), allowPrivateNetwork ? say('可信私网／DNS 代理', 'Trusted private network / DNS proxy') : say('公共网络', 'Public network')]])], say('我已检查来源、网络策略和摘要，允许下载或复制该制品到本机缓存。', 'I reviewed the source, network policy, and digest and authorize downloading or copying this artifact to the local cache.'), async () => {
        const fetched = await operation(await api('/api/sources/fetch', { ...(data.sourceId && data.receiptId ? { sourceId: data.sourceId, receiptId: data.receiptId } : { source: extra.source, indexDigest: data.digest, ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}) }), entryId: entry.entryId }), 'fetch');
        if (fetched.sourceReceipt) target.append(jsonView(say('后台核对的来源收据（不证明代码安全）', 'Backend-verified source receipt (does not establish code safety)'), fetched.sourceReceipt, true));
        const fetchedView = el('div', { class: 'notice' }, [el('p', {}, `${say('已获取', 'Fetched')}: ${fetched.directory}`), fetched.kind === 'pack' ? button(t('importPack'), () => { openImport(); $('#import-form').elements.directory.value = fetched.directory; }, 'button button-small button-primary') : button(say('在创作工作台使用', 'Use in creator workspace'), () => { extra.moduleCandidate = fetched.directory; navigate('creator'); }, 'button button-small button-quiet')]); target.append(fetchedView);
      }), 'button button-small button-primary')])));
      if (!matches.length) cards.append(el('p', { class: 'field-help' }, say('没有匹配的制品。', 'No matching artifacts.')));
    };
    for (const input of [search, kind, platform, license]) input.addEventListener('input', filter);
    target.replaceChildren(...[data.cachedObservation ? note(say('这是本机保存的过时索引观察。后台只允许摘要一致的已验证缓存，不能据此直接运行软件。', 'This is a saved stale index observation. The backend only permits a hash-matching verified cache; this cannot authorize execution.'), true) : null, el('div', { class: 'source-filters' }, [search, kind, platform, license]), el('p', { class: 'review-digest' }, `${say('索引摘要', 'Index digest')}: ${data.digest}`), cards].filter(Boolean)); filter();
  }

  function currentModule(component) { const replaced = extra.replacements.get(component.id)?.preview?.candidate?.manifest;
    if (replaced) return replaced;
    const shared = [...extra.replacements.values()].find(row => row.preview?.candidate?.manifest?.id === component.module)?.preview?.candidate?.manifest;
    return shared ?? extra.authoring?.modules?.find(module => module.id === component.module); }
  const contracts = module => module?.provides ?? [];
  function graph() {
    const pack = extra.edited, graph = el('div', { class: 'composition-graph', role: 'group', 'aria-label': say('当前组件与能力绑定图', 'Current components and capability bindings') });
    const nodes = el('div', { class: 'composition-nodes' });
    for (const component of pack.components) {
      const manifest = currentModule(component);
      nodes.append(el('article', { class: 'composition-node' }, [el('div', { class: 'composition-node-heading' }, [el('strong', {}, component.id), pill(manifest?.runtime?.kind ?? component.module)]), el('p', { class: 'mono' }, manifest?.id ?? component.module), el('div', { class: 'module-permissions' }, (manifest?.provides ?? []).map(contract => el('span', { class: 'permission' }, `↑ ${contract.id}@${contract.version}`))), el('div', { class: 'module-permissions' }, (manifest?.requires ?? []).map(contract => el('span', { class: 'permission' }, `↓ ${contract.id}@${contract.version}`))), button(say('修改配置与模块', 'Edit settings & module'), () => editComponent(component.id), 'button button-small button-quiet')]));
    }
    graph.append(nodes, el('div', { class: 'composition-bindings' }, pack.bindings.map((binding, index) => el('div', { class: 'binding-row' }, [el('strong', {}, binding.from), el('span', { class: 'binding-arrow', 'aria-hidden': 'true' }, '→'), el('strong', {}, binding.to), el('span', { class: 'mono subtle' }, `${binding.contract.id}@${binding.contract.version}`), button(say('移除绑定', 'Remove binding'), () => { extra.edited.bindings.splice(index, 1); renderCreator(); }, 'button button-small button-quiet')]))));
    if (!pack.bindings.length) graph.append(el('p', { class: 'field-help' }, say('当前没有能力绑定。', 'No capability bindings in the current composition.')));
    return graph;
  }
  function bindingForm() {
    const pack = extra.edited;
    const from = el('select', { name: 'from' }, pack.components.map(c => el('option', { value: c.id }, c.id))), to = el('select', { name: 'to' }, pack.components.map(c => el('option', { value: c.id }, c.id))), contract = el('select', { name: 'contract' });
    const update = () => {
      const provider = currentModule(pack.components.find(c => c.id === from.value)), consumer = currentModule(pack.components.find(c => c.id === to.value));
      const compatible = contracts(provider).filter(p => consumer?.requires?.some(r => r.id === p.id && r.version === p.version));
      contract.replaceChildren(...compatible.map(c => el('option', { value: JSON.stringify({ id: c.id, version: c.version }) }, `${c.id}@${c.version}`)));
    };
    from.addEventListener('change', update); to.addEventListener('change', update); update();
    return form([el('div', { class: 'field-grid' }, [el('label', {}, [say('提供组件', 'Provider component'), from]), el('label', {}, [say('使用组件', 'Consumer component'), to])]), el('label', {}, [say('双方匹配的能力合同', 'Matching capability contract'), contract])], say('添加能力绑定', 'Add capability binding'), async f => {
      if (!contract.value || from.value === to.value) throw new Error(say('选择两个不同组件及匹配的合同。', 'Select two distinct components and a matching contract.'));
      const binding = { from: from.value, to: to.value, contract: JSON.parse(contract.value) };
      if (pack.bindings.some(b => JSON.stringify(b) === JSON.stringify(binding))) throw new Error(say('绑定已存在。', 'This binding already exists.'));
      pack.bindings.push(binding); renderCreator();
    }, say('只提供双方声明中 ID 和版本完全匹配的合同；派生时后台再次检查依赖、槽与所有绑定。', 'Only exact contract IDs and versions declared by both sides are offered. The backend revalidates dependencies, slots, and all bindings when deriving.'));
  }
  const componentDialog = el('dialog', { class: 'dialog' }); document.body.append(componentDialog);
  function editComponent(id) {
    const component = extra.edited.components.find(c => c.id === id), replacement = extra.replacements.get(id);
    let checkedPreview = null;
    const previewView = el('div', { class: 'stack' });
    const editor = form([field('settings', say('公开配置 JSON', 'Public settings JSON'), JSON.stringify(component.settings ?? {}, null, 2), { multiline: true }), field('after', say('启动依赖组件（逗号分隔）', 'Startup dependencies (comma-separated)'), (component.after ?? []).join(', '), { required: false }), field('moduleDirectory', say('替代模块目录（可选）', 'Replacement module directory (optional)'), replacement?.moduleDirectory ?? extra.moduleCandidate ?? '', { required: false })], say('保存草稿配置', 'Save draft settings'), async f => {
      const settings = JSON.parse(value(f, 'settings')); if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error(say('配置须为 JSON 对象。', 'Settings must be a JSON object.'));
      const moduleDirectory = value(f, 'moduleDirectory');
      if (moduleDirectory) {
        const data = await api('/api/authoring/preview', { directory: extra.directory, componentId: id, moduleDirectory, ...env() });
        const preview = data.preview;
        previewView.replaceChildren(note(say('这是声明兼容预检，未执行候选代码。业务正确性和状态兼容性仍需验证；生成派生包会再次检查。', 'This is a declaration preflight. Candidate code was not run. Business correctness and state compatibility still need verification; derivation checks again.'), true), jsonView(say('实际候选、差异与影响组件', 'Actual candidate, differences and affected components'), preview, true));
        if (!preview.compatible) throw new Error(say('声明不兼容，请查看预检结果。', 'Declarations are incompatible. See the preflight results.'));
        if (checkedPreview?.candidateDigest !== preview.candidateDigest || checkedPreview?.candidate?.directory !== preview.candidate?.directory || checkedPreview?.sourceRevision !== preview.sourceRevision) {
          checkedPreview = preview;
          toast(say('预检通过，请检查差异后再次点击保存。', 'Preflight passed. Review the differences, then save again.')); return;
        }
        extra.replacements.set(id, { componentId: id, moduleDirectory, preview });
      } else extra.replacements.delete(id);
      component.settings = settings; component.after = value(f, 'after').split(',').map(item => item.trim()).filter(Boolean);
      componentDialog.close(); renderCreator();
    }, say('公开配置会随包分享，不应包含密码或个人秘密。替代模块的桥槽和能力合同必须兼容；同一 Module ID 替换会影响所有引用，新 ID 只替换此组件。后台生成新锁并验证。', 'Public settings are shared with the pack; omit secrets. Replacement slots and contracts must be compatible. Replacing a shared Module ID affects every reference; a new ID affects this component. The backend generates and checks a new lock.'));
    componentDialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', {}, id), button('×', () => componentDialog.close(), 'icon-button')]), editor, previewView); componentDialog.showModal();
  }
  function editedBody(form) {
    const pack = structuredClone(extra.edited);
    if (form.elements.packId) pack.id = value(form, 'packId');
    if (form.elements.packTitle) pack.title = value(form, 'packTitle');
    if (form.elements.packVersion) pack.version = value(form, 'packVersion');
    return { directory: extra.directory, destination: value(form, 'destination'), expectedRevision: extra.authoring.revision, pack, replacements: [...extra.replacements.values()].map(({ componentId, moduleDirectory }) => ({ componentId, moduleDirectory })), redistributionAcknowledged: true, ...env() };
  }
  function renderCreator() {
    const root = $('#creator-content');
    const inspect = form([field('directory', say('本机整合包目录', 'Local pack directory'), extra.directory)], say('检查并打开创作草稿', 'Inspect and open a draft'), async f => {
      const directory = value(f, 'directory'), data = await api('/api/authoring/inspect', { directory, ...env() });
      extra.directory = directory; extra.authoring = data.authoring ?? data; extra.edited = structuredClone(extra.authoring.pack); extra.replacements.clear(); extra.comments = null; renderCreator();
    }, say('检查读取锁与完整来源。所有编辑在草稿中进行，派生只写入新目录，不更改已运行实例。', 'Inspection reads the lock and complete sources. Edits are drafts. Derivation writes a new directory and does not modify running instances.'));
    root.replaceChildren(heading(label('creator'), say('可视化组合独立模块，制作派生包与可分享的软件源。', 'Compose independent modules and create derived packs and shareable sources.'), 'CREATE · COMPOSE · COLLABORATE'), note(say('编辑不执行模块。新包仍需在导入时审阅环境与权限，并明确授权执行。许可证允许再分发才可分享；可获取不代表可再发布。', 'Editing does not execute modules. New packs still require environment and permission review and explicit execution authorization. Share only when licenses permit redistribution. Availability does not grant publishing rights.')), panel(say('选择创作来源', 'Choose a creation source'), [inspect, el('details', { class: 'json-details' }, [el('summary', {}, say('环境或 Hub 版本变化：复制并重建锁', 'Changed environment or Hub version: copy and rebuild lock')), rebuildForm()])]), el('div', { id: 'advanced-progress' }));
    if (!extra.authoring || !extra.edited) { root.append(publishPanel()); return; }
    const pack = extra.edited;
    root.append(panel(say('组件与能力组合', 'Components & capability composition'), [definition([[say('源包', 'Source pack'), `${extra.authoring.pack.id}@${extra.authoring.pack.version}`], [say('基线内容版本', 'Base content revision'), extra.authoring.revision]]), graph(), extra.replacements.size ? jsonView(say('待验证模块替换', 'Pending module replacements'), [...extra.replacements.values()], true) : null, el('details', { class: 'json-details' }, [el('summary', {}, say('添加匹配合同的连线', 'Connect a matching contract')), bindingForm()]) ]));
    const derive = form([el('div', { class: 'field-grid' }, [field('packId', say('新包 ID', 'New pack ID'), pack.id), field('packVersion', say('新包版本', 'New pack version'), pack.version)]), field('packTitle', say('包名称', 'Pack title'), pack.title), field('destination', say('新的派生包目录', 'New derived pack directory'))], say('检查并生成派生包', 'Validate and create derived pack'), async f => {
      const body = editedBody(f);
      reviewAction(say('生成派生整合包', 'Create derived pack'), [note(say('后台重新验证设置、部署依赖、能力合同和替换模块，生成新 pack.lock 与来源记录。目标必须为新目录，不覆盖当前包。不运行模块。', 'The backend revalidates settings, dependencies, capability contracts, and replacements, then creates a new pack.lock and provenance record. The destination must be new. Modules are not executed.')), jsonView(say('将写入的组合', 'Composition to write'), body, true)], say('我已检查公开配置与第三方许可，拥有复制和派生这些组件的权利。', 'I reviewed public settings and third-party licenses and have the right to copy and derive these components.'), async () => {
        const derived = await api('/api/authoring/derive', body); await operation(derived, 'derive', result => { toast(say(`已创建派生包：${result.directory}`, `Derived pack created: ${result.directory}`)); extra.directory = result.directory; extra.authoring = null; extra.edited = null; renderCreator(); });
      });
    });
    root.append(panel(say('派生与生成新锁', 'Derive & create a new lock'), [derive]), publishPanel(), proposalPanel(), commentsPanel());
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
    return panel(say('发布到可分享的软件源目录', 'Publish to a shareable source directory'), [form([field('directory', say('要发布的包或模块目录', 'Pack or module directory to publish'), extra.directory), el('label', {}, [say('制品类型', 'Artifact kind'), el('select', { name: 'kind' }, [el('option', { value: 'pack' }, say('整合包', 'Pack')), el('option', { value: 'module' }, say('模块', 'Module'))])]), field('destination', say('新的发布目录', 'New publication directory'))], say('审阅并生成索引与制品', 'Review and generate index & artifact'), async f => {
      const body = { directory: value(f, 'directory'), destination: value(f, 'destination'), kind: value(f, 'kind'), redistributionAcknowledged: true, ...env() };
      reviewAction(say('发布本机制品', 'Publish local artifact'), [note(say('生成新的索引和内容制品供你分享，不会上传公网。只发布公开包或模块，不包含实例数据；公开 settings 会包含在内。', 'Creates a new index and content artifact for you to share. Nothing is uploaded. Only public packs or modules are published; instance data is excluded. Public settings are included.'), true), definition([[t('source'), body.directory], [t('destination'), body.destination], [say('类型', 'Kind'), body.kind]])], say('我确认公开内容没有秘密，许可允许再分发，并已检查来源与版权。', 'I confirm the public contents contain no secrets, licenses permit redistribution, and sources and copyright were reviewed.'), async () => {
        const data = await api('/api/sources/publish', body); await operation(data, 'publish', result => toast(say(`索引已生成：${result.indexPath}`, `Index generated: ${result.indexPath}`)));
      });
    }, say('生成后将 indexPath 添加到软件源，即可验证获取流程。', 'Add the generated indexPath as a software source to verify fetching.'))]);
  }
  function proposalPanel() {
    const exportForm = form([field('destination', say('新的提案目录', 'New proposal directory'))], say('导出当前草稿为协作提案', 'Export this draft as a proposal'), async f => {
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
    const exchange = form([field('directory', say('评论交换文件或新的目标文件', 'Comment exchange file or new destination file'))], say('导出评论', 'Export comments'), async f => { const result = await operation(await api('/api/authoring/export-comments', { directory: extra.directory, destination: value(f, 'directory') }), 'comments'); toast(say(`评论已导出：${result.destination ?? value(f, 'directory')}`, `Comments exported: ${result.destination ?? value(f, 'directory')}`)); });
    exchange.append(button(say('审阅并导入评论', 'Review and import comments'), async () => {
      if (!extra.comments) await load(); const source = value(exchange, 'directory'), expectedRevision = extra.comments.revision;
      reviewAction(say('导入协作评论', 'Import collaboration comments'), [definition([[t('source'), source], [say('当前版本', 'Current revision'), expectedRevision]]), note(say('只导入纯文本评论，不执行代码。后台检查基线版本，冲突不覆盖现有评论。', 'Imports plain-text comments only. No code executes. The backend checks the base revision; conflicts do not overwrite current comments.'))], say('我已审阅评论来源，允许添加到此包的协作记录。', 'I reviewed this comment source and allow adding it to this pack’s collaboration record.'), async () => { extra.comments = await operation(await api('/api/authoring/import-comments', { directory: extra.directory, source, expectedRevision }), 'comments'); renderCommentList(); });
    }, 'button button-quiet'));
    return panel(say('本地讨论与评论交换', 'Local discussion & comment exchange'), [button(say('读取最新评论', 'Read current comments'), load, 'button button-small button-quiet'), list, add, exchange]);
  }

  function renderEnvironmentTools() {
    let mount = $('#advanced-environment');
    if (!mount) { mount = el('div', { id: 'advanced-environment' }); $('#view-environment').append(mount); }
    const discover = button(say('发现已安装解释器', 'Discover installed interpreters'), async () => {
      const data = await api('/api/environment', env()); state.environment = data;
      renderCandidates(data.candidates ?? {}); toast(say('选择已安装路径后再次检测。发现结果尚未执行探针。', 'Select an installed path and detect again. Discovery entries have not been probed.'));
    }, 'button button-quiet');
    const candidates = el('div', { id: 'environment-candidates' });
    const renderCandidates = groups => {
      candidates.replaceChildren(...['node', 'python'].flatMap(kind => (groups[kind] ?? []).map(candidate => el('div', { class: 'runtime-row' }, [el('div', {}, [el('h3', {}, kind), el('p', {}, candidate.path), el('p', {}, `${candidate.source} · ${say('尚未探测', 'Not probed')}`)]), button(say('选择此路径', 'Select this path'), () => { $('#environment-form').elements[`${kind}Path`].value = candidate.path; state.environmentSelection = {}; toast(say('已填入路径，请重新检测。', 'Path selected. Detect again to verify it.')); }, 'button button-small button-quiet')]))));
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
    mount.replaceChildren(panel(say('发现与选择环境', 'Discover & select environments'), [discover, candidates]), panel(say('经审阅的依赖准备', 'Reviewed dependency preparation'), [prepare, el('div', { id: 'advanced-environment-results' })]));
    if (state.environment?.candidates) renderCandidates(state.environment.candidates);
  }

  function languageChanged() {
    for (const element of document.querySelectorAll('[data-advanced-i18n]')) element.textContent = label(element.dataset.advancedI18n);
    for (const item of document.querySelectorAll('[data-view]')) {
      const name = labels[item.dataset.view] ? label(item.dataset.view) : t({ packs: 'myPacks', overview: 'overview', hubs: 'hubs', workbench: 'workbench', environment: 'environment' }[item.dataset.view]);
      item.title = name; item.setAttribute('aria-label', name);
    }
    if ($('#restore-entry')) $('#restore-entry').textContent = say('从私有备份恢复', 'Restore a private backup');
    if (state.view === 'sources') renderSources(); if (state.view === 'creator') renderCreator(); if (state.view === 'environment') renderEnvironmentTools();
  }
  try { const saved = JSON.parse(localStorage.getItem('world-hub.launcher.sources') ?? '[]'); if (Array.isArray(saved)) extra.sources = saved.filter(item => typeof item?.name === 'string' && typeof item?.source === 'string').slice(0, 32); } catch {}
  try { const saved = JSON.parse(localStorage.getItem('world-hub.launcher.source-indexes') ?? '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) extra.indexes = Object.fromEntries(Object.entries(saved).slice(0, 32).filter(([, entry]) => /^[a-f0-9]{64}$/.test(entry?.digest) && Array.isArray(entry?.index?.entries) && entry.index.entries.length <= 4096)); } catch {}
  function sessionReady() {
    const restore = button(say('从私有备份恢复', 'Restore a private backup'), openRestore, 'button button-quiet'); restore.id = 'restore-entry'; $('#view-packs .page-heading').append(restore);
    renderEnvironmentTools(); void loadSources();
  }
  return { label, languageChanged, sessionReady, renderStorage, loadStorage, openCreator(directory) { extra.directory = directory; extra.authoring = null; extra.edited = null; extra.replacements.clear(); navigate('creator'); }, navigate(view) { if (view === 'sources') { renderSources(); void loadSources(); } if (view === 'creator') renderCreator(); if (view === 'environment') renderEnvironmentTools(); } };
}
