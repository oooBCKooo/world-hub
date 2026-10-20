import { localizeErrorMessage } from './i18n.mjs';

export function createTaskUi({ state, api, el, button, toast, date, selectInstance, openImport, openCreator, createIcon, onPendingChange }) {
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  let dialog, timer, request = 0, stamp = '', operations = [], loadingEpoch = null, currentFilter = 'all', lastPendingStamp = '';
  const READ_STORAGE_KEY = 'world-hub.launcher.read-operations';
  function getReadOperations() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(READ_STORAGE_KEY) : null;
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  }
  function markOperationsAsRead(ids) {
    try {
      if (typeof localStorage === 'undefined' || !ids?.length) return;
      const set = getReadOperations();
      for (const id of ids) if (id) set.add(id);
      localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...set].slice(-256)));
    } catch {}
  }

  // Only server records prove that an import succeeded. Older browser markers
  // were written when a dialog opened, including cancelled and failed imports.
  try { localStorage.removeItem('world-hub.launcher.imported-packs'); } catch {}
  const pathKey = path => {
    const normalized = String(path).replaceAll('\\', '/').replace(/\/$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  };

  const KIND_SYMBOLS = {
    'fetch-pack': '📦',
    'fetch-module': '🧩',
    'fetch-template': '📋',
    fetch: '📥',
    'fetch-source': '📥',
    'instantiate-template': '✨',
    export: '📤',
    derive: '🌿',
    rebuild: '🔨',
    publish: '🚀',
    'create-template': '📋',
    start: '▶️',
    stop: '⏹️',
    delete: '🗑️',
    restart: '🔄',
    'local-startup-plan': '▶️',
    backup: '💾',
    restore: '⏮️',
    detach: '✂️',
    reattach: '🔗',
    upgrade: '🆙',
    'staged-upgrade': '🧪',
    'rollback-upgrade': '⏪',
    'recover-upgrade': '🩹',
    'prepare-environment': '⚙️',
    'discover-paths': '🔍',
    proposal: '📑',
    'apply-proposal': '✅',
    comment: '💬',
    'export-comments': '💬',
    'import-comments': '💬',
  };

  const DISMISSED_PENDING_KEY = 'world-hub.launcher.dismissed-pending-packs';
  function getDismissedPendingMap() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISSED_PENDING_KEY) : null;
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function saveDismissedPendingMap(map) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(DISMISSED_PENDING_KEY, JSON.stringify(map));
    } catch {}
  }
  function isDismissedPending(packPath, operation) {
    if (!packPath) return false;
    const map = getDismissedPendingMap();
    const key = pathKey(packPath);
    const record = map[key];
    if (!record) return false;
    if (record.operationId && operation?.id && record.operationId === operation.id) {
      return true;
    }
    const opTime = Date.parse(operation?.finishedAt ?? operation?.startedAt ?? '');
    if (record.dismissedAt && Number.isFinite(opTime)) {
      return opTime <= record.dismissedAt;
    }
    return true;
  }
  function dismissPendingPack(packPath, opId) {
    if (!packPath) return;
    const map = getDismissedPendingMap();
    const key = pathKey(packPath);
    map[key] = {
      dismissedAt: Date.now(),
      operationId: opId ?? null
    };
    saveDismissedPendingMap(map);
    updateTrigger();
    onPendingChange?.(getPendingPacks().length);
  }
  function undismissPendingPack(packPath) {
    if (!packPath) return;
    const map = getDismissedPendingMap();
    const key = pathKey(packPath);
    if (map[key]) {
      delete map[key];
      saveDismissedPendingMap(map);
      updateTrigger();
      onPendingChange?.(getPendingPacks().length);
    }
  }

  function getPackPath(operation) {
    const result = operation.result ?? {};
    return ['derive', 'export', 'instantiate-template', 'rebuild', 'apply-proposal'].includes(operation.kind)
      ? result.directory ?? result.destination
      : ['fetch-source', 'fetch'].includes(operation.kind) && (result.kind ?? result.entry?.kind) === 'pack'
        ? result.directory
        : null;
  }

  function isPackPendingImport(operation) {
    if (operation.state !== 'succeeded') return false;
    const packPath = getPackPath(operation);
    if (!packPath) return false;
    if (isDismissedPending(packPath, operation)) return false;
    const result = operation.result ?? {};
    const digest = result.packDigest ?? result.digest;
    if (state.instances.some(row => row.sourceDirectory && pathKey(row.sourceDirectory) === pathKey(packPath)
      && (!digest || row.sourceDigest === digest))) return false;
    return true;
  }

  function getPendingPacks() {
    const seen = new Set();
    const list = [];
    for (const op of operations) {
      if (isPackPendingImport(op)) {
        const packPath = getPackPath(op);
        const key = packPath && pathKey(packPath);
        if (key && !seen.has(key)) {
          seen.add(key);
          const result = op.result ?? {};
          const entry = result.entry ?? result;
          list.push({
            path: packPath,
            title: entry.title ?? entry.id ?? entry.entryId ?? say('待审阅导入的整合包', 'Pack Pending Import'),
            id: entry.id ?? result.id,
            version: entry.version ?? result.version,
            operation: op
          });
        }
      }
    }
    return list;
  }

  const trigger = button('', () => { if (dialog?.open) dialog.close(); else void open(); }, 'button button-quiet');
  trigger.id = 'task-center-button';
  function updateTrigger() {
    const icon = createIcon ? createIcon('task', 'button-icon') : null;
    const readSet = getReadOperations();
    const uniquePendingPacks = new Set();
    for (const op of operations) {
      if (isPackPendingImport(op)) {
        const path = getPackPath(op) && pathKey(getPackPath(op));
        if (path) uniquePendingPacks.add(path);
      }
    }
    const pendingCount = uniquePendingPacks.size;
    const unreadOps = operations.filter(op => op.state !== 'running' && !readSet.has(op.id));
    const runningOps = operations.filter(op => op.state === 'running');

    let badge = null;
    if (pendingCount > 0) {
      trigger.className = 'button button-quiet has-pending-import';
      badge = el('span', { class: 'task-badge badge-pending-import' }, `${pendingCount} ${say('待导入', 'to import')}`);
    } else if (unreadOps.length > 0) {
      trigger.className = 'button button-quiet has-unread-tasks';
      badge = el('span', { class: 'task-badge badge-unread' }, String(unreadOps.length));
    } else if (runningOps.length > 0) {
      trigger.className = 'button button-quiet has-running-tasks';
      badge = el('span', { class: 'task-badge badge-running' }, `${runningOps.length} ${say('进行中', 'running')}`);
    } else {
      trigger.className = 'button button-quiet';
    }

    trigger.replaceChildren(...[icon, say('任务与结果', 'Tasks & results'), badge].filter(Boolean));
    const currentPendingStamp = JSON.stringify(getPendingPacks().map(p => [p.path, p.title, p.version]));
    if (currentPendingStamp !== lastPendingStamp) {
      lastPendingStamp = currentPendingStamp;
      onPendingChange?.(pendingCount);
    }
  }
  updateTrigger();
  document.querySelector('.topbar-actions').prepend(trigger);
  const labels = {
    delete: ['删除实例', 'Delete instance'],
    start: ['启动', 'Start'], stop: ['停止', 'Stop'], restart: ['重启', 'Restart'], export: ['导出整合包', 'Export pack'], backup: ['备份', 'Backup'], restore: ['恢复', 'Restore'], fetch: ['获取制品', 'Fetch artifact'],
    'fetch-source': ['获取制品', 'Fetch artifact'], 'instantiate-template': ['生成模板包', 'Create pack from template'], 'discover-paths': ['目录识别', 'Path discovery'], derive: ['生成派生包', 'Create derived pack'], publish: ['发布制品', 'Publish artifact'],
    'prepare-environment': ['准备依赖环境', 'Prepare dependencies'], detach: ['隔离实例软件', 'Detach instance software'], reattach: ['恢复实例软件', 'Restore instance software'],
    rebuild: ['重建整合包', 'Rebuild pack'], 'create-template': ['制作模板', 'Create template'], proposal: ['生成协作提案', 'Create collaboration proposal'], 'apply-proposal': ['应用协作提案', 'Apply collaboration proposal'],
    comment: ['添加评论', 'Add comment'], 'export-comments': ['导出评论', 'Export comments'], 'import-comments': ['导入评论', 'Import comments'],
    'staged-upgrade': ['创建候选试用实例', 'Create candidate trial instance'], upgrade: ['升级实例', 'Upgrade instance'], 'rollback-upgrade': ['回退实例升级', 'Roll back instance upgrade'], 'recover-upgrade': ['恢复中断的升级', 'Recover interrupted upgrade'],
    'local-startup-plan': ['执行世界枢纽启动计划', 'Run World Hub startup plan']
  };
  function operationTitle(operation) {
    const baseLabel = labels[operation.kind] ? say(...labels[operation.kind]) : operation.kind;
    const result = operation.result ?? {};
    const entry = result.entry ?? result;
    if (['fetch-source', 'fetch'].includes(operation.kind)) {
      const kind = result.kind ?? entry.kind;
      const symbol = kind === 'pack' ? '📦' : kind === 'module' ? '🧩' : kind === 'template' ? '📋' : (KIND_SYMBOLS[operation.kind] ?? '📥');
      const kindPrefix = kind === 'pack' ? say('获取整合包', 'Fetch pack')
        : kind === 'module' ? say('获取模块', 'Fetch module')
        : kind === 'template' ? say('获取模板', 'Fetch template')
        : baseLabel;
      const title = entry.title ?? entry.id ?? entry.entryId;
      if (title) {
        const idInfo = entry.id && entry.title && entry.id !== entry.title
          ? ` (${entry.id}${entry.version ? `@${entry.version}` : ''})`
          : (entry.version ? ` v${entry.version}` : '');
        return `${symbol} ${kindPrefix} · ${title}${idInfo}`;
      }
      return `${symbol} ${kindPrefix}`;
    }
    const symbol = KIND_SYMBOLS[operation.kind] ?? '⚡';
    const instanceId = operation.instanceId ?? result.instanceId ?? result.instance?.instanceId;
    if (instanceId && !instanceId.startsWith('$') && instanceId !== '$default') {
      return `${symbol} ${baseLabel} · ${instanceId}`;
    }
    const packName = result.pack?.title ?? result.pack?.id ?? result.title ?? result.id;
    if (packName) {
      return `${symbol} ${baseLabel} · ${packName}${result.version ? ` v${result.version}` : ''}`;
    }
    return `${symbol} ${baseLabel}`;
  }
  function copyButton(path, opId) {
    const btn = button(say('复制路径', 'Copy path'), async () => {
      try {
        await navigator.clipboard.writeText(path);
        toast(say('路径已复制', 'Path copied'));
      } catch {
        toast(say('无法复制，请选择显示的路径。', 'Copy unavailable; select the displayed path.'));
      }
    }, 'button button-small copy-path-button');
    btn.dataset.taskAction = `copy-${opId}`;
    return btn;
  }
  function resultActions(operation, isDuplicate = false, isPending = false) {
    const result = operation.result ?? {};
    const actions = [];
    const packPath = getPackPath(operation);
    if (packPath) {
      actions.push(button(say('导入并审阅', 'Import and review'), () => {
        dialog.close();
        openImport(packPath);
      }, isDuplicate ? 'button button-small' : 'button button-small button-primary'));
      if (isPending) {
        actions.push(button(say('取消待导入', 'Dismiss import'), () => {
          dismissPendingPack(packPath, operation.id);
          render();
          toast(say('已取消整合包待审阅导入', 'Pending import dismissed'));
        }, 'button button-small button-danger-quiet'));
      }
    }
    const instanceId = result.instance?.instanceId ?? result.instanceId;
    if (instanceId && state.instances.some(row => (row.instanceId ?? row.id) === instanceId)) actions.push(button(say('查看实例', 'View instance'), () => { dialog.close(); void selectInstance(instanceId, 'storage'); }, 'button button-small button-primary'));
    for (const [index, action] of actions.entries()) action.dataset.taskAction = `result-${operation.id}-${index}`;
    return actions;
  }
  function matchesCategory(op, category, pendingOpIds) {
    if (category === 'all') return true;
    if (category === 'pending') {
      return pendingOpIds.has(op.id) || op.state === 'running';
    }
    if (category === 'packs') {
      const result = op.result ?? {};
      const entry = result.entry ?? result;
      const kind = result.kind ?? entry.kind;
      return ['export', 'derive', 'rebuild', 'instantiate-template', 'apply-proposal', 'staged-upgrade', 'upgrade', 'rollback-upgrade', 'recover-upgrade'].includes(op.kind)
        || (['fetch-source', 'fetch'].includes(op.kind) && kind === 'pack');
    }
    if (category === 'modules') {
      const result = op.result ?? {};
      const entry = result.entry ?? result;
      const kind = result.kind ?? entry.kind;
      return op.kind === 'create-template'
        || (['fetch-source', 'fetch'].includes(op.kind) && ['module', 'template'].includes(kind));
    }
    if (category === 'lifecycle') {
      return ['start', 'stop', 'restart', 'local-startup-plan', 'backup', 'restore', 'detach', 'reattach', 'prepare-environment', 'discover-paths', 'comment', 'export-comments', 'import-comments', 'proposal'].includes(op.kind);
    }
    if (category === 'failed') {
      return op.state === 'failed';
    }
    return true;
  }
  function render() {
    const next = JSON.stringify([operations, state.language, currentFilter, state.instances.map(row => [row.instanceId ?? row.id, row.sourceDirectory, row.sourceDigest])]); if (next === stamp) return; stamp = next;
    const root = dialog.querySelector('.task-list'), active = document.activeElement;
    root.setAttribute('aria-labelledby', `task-filter-${currentFilter}`);
    const focusedAction = active?.dataset?.taskAction;
    const focusedFilter = active?.dataset?.filterId;
    const readSet = getReadOperations();

    const seenPendingPacks = new Set();
    const pendingOpIds = new Set();
    for (const op of operations) {
      const packPath = getPackPath(op) && pathKey(getPackPath(op));
      const isPendingCandidate = isPackPendingImport(op);
      if (isPendingCandidate && packPath && !seenPendingPacks.has(packPath)) {
        seenPendingPacks.add(packPath);
        pendingOpIds.add(op.id);
      }
    }

    const categories = [
      { id: 'all', label: say('全部', 'All'), count: operations.length },
      { id: 'pending', label: say('待处理', 'Action needed'), count: pendingOpIds.size + operations.filter(op => op.state === 'running' && !pendingOpIds.has(op.id)).length, isPending: true },
      { id: 'packs', label: say('整合包', 'Packs'), count: operations.filter(op => matchesCategory(op, 'packs', pendingOpIds)).length },
      { id: 'modules', label: say('模块与模板', 'Modules & Templates'), count: operations.filter(op => matchesCategory(op, 'modules', pendingOpIds)).length },
      { id: 'lifecycle', label: say('运行控制', 'Lifecycle'), count: operations.filter(op => matchesCategory(op, 'lifecycle', pendingOpIds)).length },
      { id: 'failed', label: say('失败', 'Failed'), count: operations.filter(op => op.state === 'failed').length, isFailed: true }
    ];

    const summaryEl = dialog.querySelector('.task-summary');
    if (summaryEl) {
      summaryEl.className = 'task-summary task-filter-bar';
      summaryEl.setAttribute('role', 'tablist');
      const pills = categories.map(cat => {
        const isActive = currentFilter === cat.id;
        const btnClasses = [
          'task-filter-pill',
          isActive ? 'is-active' : '',
          cat.isPending && cat.count > 0 ? 'has-pending' : '',
          cat.isFailed ? 'is-failed-pill' : '',
          cat.isFailed && cat.count > 0 ? 'has-failed' : ''
        ].filter(Boolean).join(' ');
        const btn = button([
          cat.label,
          ' ',
          el('span', { class: 'task-filter-count' }, String(cat.count))
        ], () => {
          if (currentFilter !== cat.id) {
            currentFilter = cat.id;
            stamp = '';
            render();
          }
        }, btnClasses);
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(isActive));
        btn.setAttribute('tabindex', isActive ? '0' : '-1');
        btn.setAttribute('id', `task-filter-${cat.id}`);
        btn.setAttribute('aria-controls', 'task-center-list');
        btn.dataset.filterId = cat.id;
        return btn;
      });
      summaryEl.replaceChildren(...pills);
    }

    const filtered = operations.filter(op => matchesCategory(op, currentFilter, pendingOpIds));
    const renderedPendingPacks = new Set();
    root.replaceChildren(...filtered.map(operation => {
      const result = operation.result, path = result?.directory ?? result?.destination ?? result?.backup ?? result?.indexPath;
      const planOperation = operation.kind === 'local-startup-plan';
      const planResult = planOperation ? result ?? operation.progress : null;
      const partial = operation.state === 'partial' || result?.cancelled || result?.partial || planResult?.results?.some(row => ['failed', 'blocked', 'cancelled', 'not-started'].includes(row.state));
      const status = operation.state === 'running' ? say('进行中', 'Running') : operation.state === 'failed' ? say('失败', 'Failed') : operation.state === 'cancelled' || result?.cancelled ? say('已取消', 'Cancelled') : partial ? say('部分完成', 'Partially completed') : say('已完成', 'Completed');
      const packPath = getPackPath(operation) && pathKey(getPackPath(operation));
      const isPendingCandidate = isPackPendingImport(operation);
      const isDuplicatePending = Boolean(isPendingCandidate && packPath && renderedPendingPacks.has(packPath));
      const isPending = Boolean(isPendingCandidate && packPath && !renderedPendingPacks.has(packPath));
      if (isPendingCandidate && packPath) renderedPendingPacks.add(packPath);
      const isUnread = !readSet.has(operation.id) && operation.state !== 'running';
      const badges = [];
      if (isPending) badges.push(el('span', { class: 'pill pill-teal pill-pending-badge' }, say('待审阅导入', 'Pending import')));
      else if (isDuplicatePending) badges.push(el('span', { class: 'pill pill-duplicate-badge' }, say('重复下载', 'Duplicate download')));
      else if (isUnread) badges.push(el('span', { class: 'pill pill-amber pill-new-badge' }, say('新结果', 'New')));
      badges.push(el('span', { class: 'pill' }, status));

      const actions = resultActions(operation, isDuplicatePending, isPending);
      const card = el('article', { class: ['task-card', 'panel', isPending ? 'is-pending-import' : ''].filter(Boolean).join(' '), 'aria-busy': String(operation.state === 'running') }, [
        el('div', { class: 'panel-heading' }, [el('h3', {}, operationTitle(operation)), el('div', { class: 'task-card-badges' }, badges)]),
        el('p', { class: 'subtle' }, `${state.instances.some(row => (row.instanceId ?? row.id) === operation.instanceId) ? operation.instanceId + ' · ' : ''}${date(operation.startedAt)}${operation.finishedAt ? ` → ${date(operation.finishedAt)}` : ''}`),
        isPending ? el('p', { class: 'task-import-hint' }, say('整合包已保存到本机。导入并审阅后可创建实例；运行仍需明确授权。', 'Pack saved locally. Import and review it to create an instance; execution needs explicit authorization.')) : null,
        path ? el('div', { class: 'task-path-row' }, [el('span', { class: 'mono task-path' }, path), copyButton(path, operation.id)]) : null,
        partial ? el('p', {}, planOperation ? say('启动计划未全部完成。请检查各成员的失败、受阻或取消结果；计划外模块保持原状态。', 'The startup plan did not complete in full. Check failed, blocked or cancelled members. Programs outside the plan retain their state.') : operation.kind==='discover-paths' ? say('任务被取消或达到处理边界；结果不是完整扫描。', 'The task was cancelled or reached a processing limit; discovery is incomplete.') : say('任务仅部分完成，请检查完整结果。', 'The task completed only partially. Check its full result.')) : null,
        planResult ? el('div', { class: 'startup-plan-progress' }, (planResult.results ?? []).map(row => el('div', { class: 'startup-plan-progress-row', 'data-startup-state': row.state }, [
          el('strong', { class: 'mono' }, row.programId), el('span', { class: 'pill' }, ({started:say('已启动','Started'),'already-running':say('原已运行','Already running'),blocked:say('启动前置未就绪','Blocked by prerequisites'),failed:say('启动失败','Start failed'),cancelled:say('已取消','Cancelled'),'not-started':say('尚未启动','Not started'),starting:say('启动中','Starting')})[row.state]??row.state),
          row.blockedBy?.length ? el('p', { class:'field-help' }, `${say('等待','Waiting for')}: ${row.blockedBy.join(', ')}`) : null, row.error?.message ? el('p', { class:'field-help' }, localizeErrorMessage(row.error.message, state.language)) : null
        ].filter(Boolean)))) : null,
        operation.error ? el('div', { class: 'notice notice-error' }, localizeErrorMessage(operation.error.message, state.language)) : null,
        result ? el('details', { class: 'task-result-details' }, [
          el('summary', { class: 'task-result-summary' }, [
            el('span', { class: 'task-result-summary-label' }, [createIcon ? createIcon('inspect', 'task-result-icon') : null, say('查看完整结果', 'Full result')].filter(Boolean)),
            el('span', { class: 'task-result-chevron', 'aria-hidden': 'true' }, '▾')
          ]),
          el('pre', { class: 'review-digest' }, JSON.stringify(result, null, 2))
        ]) : null,
        actions.length ? el('div', { class: 'task-actions-row' }, actions) : null
      ]);
      if (operation.state === 'running' && !['stop', 'detach', 'reattach', 'delete'].includes(operation.kind)) { const cancel = button(operation.cancelRequestedAt ? say('已请求取消', 'Cancellation requested') : say('取消任务', 'Cancel task'), async () => { cancel.disabled = true; try { await api(`/api/operations/${encodeURIComponent(operation.id)}/cancel`, {}); await refresh(); } catch (error) { dialog.querySelector('.task-error').textContent = localizeErrorMessage(error.message, state.language); cancel.disabled = false; } }, 'button button-small', Boolean(operation.cancelRequestedAt)); cancel.dataset.taskAction = `cancel-${operation.id}`; card.append(cancel); }
      return card;
    }));
    if (!filtered.length) {
      const emptyMessages = {
        pending: say('当前任务记录中没有待导入结果或进行中的任务。', 'No pending import results or running tasks in the current task history.'),
        packs: say('当前没有整合包相关任务。', 'No integration pack tasks.'),
        modules: say('当前没有模块或模板任务。', 'No module or template tasks.'),
        lifecycle: say('当前没有实例运行控制或管理任务。', 'No lifecycle or management tasks.'),
        failed: say('当前没有失败的任务。', 'No failed tasks.'),
        all: say('当前没有任务。导出、获取、备份、生成和目录识别的结果会出现在这里。', 'No tasks yet. Results of exports, fetches, backups, authoring and discovery appear here.')
      };
      root.append(el('p', { class: 'field-help empty-task-filter-note' }, emptyMessages[currentFilter] ?? emptyMessages.all));
    }
    if (focusedAction) {
      [...root.querySelectorAll('[data-task-action]')].find(node => node.dataset.taskAction === focusedAction)?.focus({ preventScroll: true });
    } else if (focusedFilter && summaryEl) {
      summaryEl.querySelector(`[data-filter-id="${focusedFilter}"]`)?.focus({ preventScroll: true });
    }
    markOperationsAsRead(operations.map(op => op.id));
    updateTrigger();
  }
  async function refresh() {
    if (loadingEpoch === request || !dialog?.open || !state.auth?.token) return;
    clearTimeout(timer);
    const current = request; loadingEpoch = current;
    try { const data = await api('/api/operations'); if (current !== request || !dialog.open) return; operations = data.operations ?? []; render(); dialog.querySelector('.task-error').textContent = ''; }
    catch (error) { if (current === request && dialog.open) dialog.querySelector('.task-error').textContent = error.message; }
    finally { if (loadingEpoch === current) loadingEpoch = null; if (current === request && dialog.open) timer = setTimeout(() => void refresh(), 1200); }
  }
  async function check() {
    if (!state.auth?.token || dialog?.open) return;
    try {
      const data = await api('/api/operations');
      operations = data.operations ?? [];
      updateTrigger();
    } catch {}
  }
  async function open() {
    if (!dialog) {
      dialog = el('dialog', { id: 'task-center-dialog', class: 'dialog task-center', 'aria-labelledby': 'task-center-title' });
      document.body.append(dialog);
      const handleClose = () => { request++; clearTimeout(timer); updateTrigger(); };
      dialog.addEventListener('close', handleClose);
      dialog.addEventListener('cancel', handleClose);
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      });
    }
    clearTimeout(timer); request++; stamp = ''; currentFilter = 'all';
    const close = button(createIcon ? createIcon('close') : '×', () => dialog.close(), 'icon-button close-dialog');
    close.setAttribute('aria-label', say('关闭任务中心', 'Close task center'));
    close.setAttribute('data-dialog', 'task-center-dialog');
    const footerClose = button(say('关闭', 'Close'), () => dialog.close(), 'button button-primary');
    footerClose.setAttribute('data-dialog', 'task-center-dialog');
    dialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [el('h2', { id: 'task-center-title' }, say('任务与结果', 'Tasks & results')), close]),
      el('p', { class: 'field-help' }, say('保留当前 Launcher 进程最近 128 项任务。刷新页面后可继续查看；重启 Launcher 后任务历史不保留。结果可能包含私有路径，请按用途分享。', 'Keeps the latest 128 tasks in this Launcher process. Survives page refresh; restarting Launcher clears task history. Results may contain private paths; share selectively.')),
      el('div', { class: 'task-summary task-filter-bar', role: 'tablist' }),
      el('div', { class: 'task-error notice-error', role: 'alert' }),
      el('div', { class: 'task-list', id: 'task-center-list', role: 'tabpanel', 'aria-labelledby': `task-filter-${currentFilter}` }),
      el('div', { class: 'dialog-footer' }, [footerClose])
    );
    if (!dialog.open) dialog.showModal();
    await refresh();
  }
  return {
    open,
    check,
    getPendingPacks,
    isPendingPack(path) {
      const key = path && pathKey(path);
      return Boolean(key && getPendingPacks().some(p => pathKey(p.path) === key));
    },
    dismissPendingPack(path, opId) {
      dismissPendingPack(path, opId);
    },
    undismissPendingPack(path) {
      undismissPendingPack(path);
    },
    pathKey,
    languageChanged() { updateTrigger(); if (dialog?.open) { dialog.close(); void open(); } }
  };
}
