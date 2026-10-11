export function createTaskUi({ state, api, el, button, toast, date, selectInstance, openImport, openCreator }) {
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  let dialog, timer, request = 0, stamp = '', operations = [], loadingEpoch = null;
  const trigger = button(say('任务与结果', 'Tasks & results'), () => void open(), 'button button-quiet'); trigger.id = 'task-center-button'; document.querySelector('.topbar-actions').prepend(trigger);
  const labels = {
    start: ['启动', 'Start'], stop: ['停止', 'Stop'], restart: ['重启', 'Restart'], export: ['导出整合包', 'Export pack'], backup: ['备份', 'Backup'], restore: ['恢复', 'Restore'], fetch: ['获取制品', 'Fetch artifact'],
    'fetch-source': ['获取制品', 'Fetch artifact'], 'instantiate-template': ['生成模板包', 'Create pack from template'], 'discover-paths': ['目录识别', 'Path discovery'], derive: ['生成派生包', 'Create derived pack'], publish: ['发布制品', 'Publish artifact'],
    'prepare-environment': ['准备依赖环境', 'Prepare dependencies'], detach: ['隔离实例软件', 'Detach instance software'], reattach: ['恢复实例软件', 'Restore instance software'],
    rebuild: ['重建整合包', 'Rebuild pack'], 'create-template': ['制作模板', 'Create template'], proposal: ['生成协作提案', 'Create collaboration proposal'], 'apply-proposal': ['应用协作提案', 'Apply collaboration proposal'],
    comment: ['添加评论', 'Add comment'], 'export-comments': ['导出评论', 'Export comments'], 'import-comments': ['导入评论', 'Import comments'],
    'staged-upgrade': ['创建候选试用实例', 'Create candidate trial instance'], upgrade: ['升级实例', 'Upgrade instance'], 'rollback-upgrade': ['回退实例升级', 'Roll back instance upgrade'], 'recover-upgrade': ['恢复中断的升级', 'Recover interrupted upgrade']
  };
  function resultActions(operation) {
    const result = operation.result ?? {}, path = result.directory ?? result.destination ?? result.backup ?? result.indexPath;
    const actions = [];
    if (path) actions.push(button(say('复制路径', 'Copy path'), async () => { try { await navigator.clipboard.writeText(path); toast(say('路径已复制', 'Path copied')); } catch { toast(say('无法复制，请选择显示的路径。', 'Copy unavailable; select the displayed path.')); } }, 'button button-small'));
    const packPath = ['derive', 'export', 'instantiate-template', 'rebuild', 'apply-proposal'].includes(operation.kind) ? result.directory ?? result.destination : operation.kind === 'fetch-source' && (result.kind ?? result.entry?.kind) === 'pack' ? result.directory : null;
    if (packPath) {
      actions.push(button(say('导入并审阅', 'Import and review'), () => { dialog.close(); openImport(packPath); }, 'button button-small button-primary'), button(say('打开创作', 'Open Creator'), () => { dialog.close(); openCreator(packPath); }, 'button button-small'));
    }
    const instanceId = result.instance?.instanceId ?? result.instanceId;
    if (instanceId && state.instances.some(row => (row.instanceId ?? row.id) === instanceId)) actions.push(button(say('查看实例', 'View instance'), () => { dialog.close(); void selectInstance(instanceId, 'storage'); }, 'button button-small button-primary'));
    for (const [index, action] of actions.entries()) action.dataset.taskAction = `result-${operation.id}-${index}`;
    return actions;
  }
  function render() {
    const next = JSON.stringify([operations, state.language]); if (next === stamp) return; stamp = next;
    const root = dialog.querySelector('.task-list'), active = document.activeElement, focused = active?.dataset.taskAction;
    root.replaceChildren(...operations.map(operation => {
      const result = operation.result, path = result?.directory ?? result?.destination ?? result?.backup ?? result?.indexPath;
      const partial = result?.cancelled || result?.partial, status = operation.state === 'running' ? say('进行中', 'Running') : operation.state === 'failed' ? say('失败', 'Failed') : partial ? say('部分结果', 'Partial result') : say('已完成', 'Completed');
      const card = el('article', { class: 'task-card panel', 'aria-busy': String(operation.state === 'running') }, [
        el('div', { class: 'panel-heading' }, [el('h3', {}, labels[operation.kind] ? say(...labels[operation.kind]) : operation.kind), el('span', { class: 'pill' }, status)]),
        el('p', { class: 'subtle' }, `${state.instances.some(row => (row.instanceId ?? row.id) === operation.instanceId) ? operation.instanceId + ' · ' : ''}${date(operation.startedAt)}${operation.finishedAt ? ` → ${date(operation.finishedAt)}` : ''}`),
        path ? el('p', { class: 'mono' }, path) : null,
        partial ? el('p', {}, say('任务被取消或达到处理边界；结果不是完整扫描。', 'The task was cancelled or reached a processing limit; discovery is incomplete.')) : null,
        operation.error ? el('div', { class: 'notice notice-error' }, operation.error.message) : null,
        result ? el('details', {}, [el('summary', {}, say('查看完整结果', 'Full result')), el('pre', { class: 'review-digest' }, JSON.stringify(result, null, 2))]) : null,
        el('div', { class: 'path-control-row' }, resultActions(operation))
      ]);
      if (operation.state === 'running' && !['stop', 'detach', 'reattach'].includes(operation.kind)) { const cancel = button(operation.cancelRequestedAt ? say('已请求取消', 'Cancellation requested') : say('取消任务', 'Cancel task'), async () => { cancel.disabled = true; try { await api(`/api/operations/${encodeURIComponent(operation.id)}/cancel`, {}); await refresh(); } catch (error) { dialog.querySelector('.task-error').textContent = error.message; cancel.disabled = false; } }, 'button button-small', Boolean(operation.cancelRequestedAt)); cancel.dataset.taskAction = `cancel-${operation.id}`; card.append(cancel); }
      return card;
    }));
    if (!operations.length) root.append(el('p', {}, say('当前没有任务。导出、获取、备份、生成和目录识别的结果会出现在这里。', 'No tasks yet. Results of exports, fetches, backups, authoring and discovery appear here.')));
    if (focused) [...root.querySelectorAll('[data-task-action]')].find(node => node.dataset.taskAction === focused)?.focus({ preventScroll: true });
    dialog.querySelector('.task-summary').textContent = `${operations.filter(op => op.state === 'running').length} ${say('项进行中', 'running')}, ${operations.length} ${say('项任务', 'tasks')}`;
  }
  async function refresh() {
    if (loadingEpoch === request || !dialog?.open || !state.auth?.token) return;
    clearTimeout(timer);
    const current = request; loadingEpoch = current;
    try { const data = await api('/api/operations'); if (current !== request || !dialog.open) return; operations = data.operations ?? []; render(); dialog.querySelector('.task-error').textContent = ''; }
    catch (error) { if (current === request && dialog.open) dialog.querySelector('.task-error').textContent = error.message; }
    finally { if (loadingEpoch === current) loadingEpoch = null; if (current === request && dialog.open) timer = setTimeout(() => void refresh(), 1200); }
  }
  async function open() {
    if (!dialog) { dialog = el('dialog', { id: 'task-center-dialog', class: 'dialog task-center', 'aria-labelledby': 'task-center-title' }); document.body.append(dialog); dialog.addEventListener('close', () => { request++; clearTimeout(timer); }); }
    clearTimeout(timer); request++; stamp = ''; const close = button('×', () => dialog.close(), 'icon-button'); close.setAttribute('aria-label', say('关闭任务中心', 'Close task center'));
    dialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', { id: 'task-center-title' }, say('任务与结果', 'Tasks & results')), close]), el('p', { class: 'field-help' }, say('保留当前 Launcher 进程最近 128 项任务。刷新页面后可继续查看；重启 Launcher 后任务历史不保留。结果可能包含私有路径，请按用途分享。', 'Keeps the latest 128 tasks in this Launcher process. Survives page refresh; restarting Launcher clears task history. Results may contain private paths; share selectively.')), el('p', { class: 'task-summary', role: 'status' }), el('div', { class: 'task-error notice-error', role: 'alert' }), el('div', { class: 'task-list' }));
    dialog.showModal(); await refresh();
  }
  return { open, languageChanged() { trigger.textContent = say('任务与结果', 'Tasks & results'); if (dialog?.open) { dialog.close(); void open(); } } };
}
