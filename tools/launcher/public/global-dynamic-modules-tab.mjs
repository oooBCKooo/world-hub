// Launcher owns local processes; the Hub supplies communication observations.
export function createGlobalDynamicModulesUi(ctx) {
  const { state, api, el, button } = ctx;
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const title = row => typeof row.title === 'string' ? row.title : row.title?.[state.language] ?? row.title?.en ?? row.title?.zh ?? row.programId;
  const base = '/api/programs/external';
  let view, language, programs = [], hub, inventory, loading = false, generation = 0, busy = false, active = false;
  const observed = () => state.online !== false && !state.hubsUnavailable && hub?.state === 'running'
    && (!state.hubsObservedAt || Date.now() - Date.parse(state.hubsObservedAt) <= 10000);
  const issue = error => { if (view) { view.status.textContent = error.message; view.status.hidden = false; } };
  const data = (label, value) => el('details', {}, [el('summary', {}, label), el('pre', {}, JSON.stringify(value, null, 2))]);
  const field = (label, input) => el('label', {}, [el('span', {}, label), input]);
  const input = (name, label, value = '') => { const node = el('input', { name, 'aria-label': label, autocomplete: 'off' }); node.value = value; return node; };
  const topics = value => [...new Set(value.split(/[\n,]/).map(part => part.trim()).filter(Boolean))];

  function clearEditor() {
    view?.editor.replaceChildren();
    view?.secret.replaceChildren();
  }

  async function wait(result, status) {
    while (result?.operationId) {
      const { operation } = await api(`/api/operations/${encodeURIComponent(result.operationId)}`);
      if (operation.state === 'succeeded') return operation.result;
      if (['failed', 'cancelled'].includes(operation.state)) throw new Error(operation.error?.message ?? say('操作未完成。', 'Operation did not complete.'));
      status.textContent = say('正在执行…', 'Working…');
      await new Promise(done => setTimeout(done, 400));
    }
    return result;
  }

  function action(label, callback, { disabled = false, primary = false } = {}) {
    const node = button(label, async () => {
      if (busy || !observed()) { issue(new Error(say('请先刷新并启动世界枢纽。', 'Refresh and start World Hub first.'))); return; }
      busy = true; node.disabled = true;
      try { await callback(); }
      catch (error) { issue(error); }
      finally { busy = false; if (view) { node.disabled = disabled || !observed(); } }
    }, primary ? 'button button-primary' : 'button button-quiet', disabled || !observed());
    return node;
  }

  function revealConnection(connection) {
    const secret = el('pre', { hidden: true }), notice = el('p', {}, say('本次凭据只在当前 Hub 运行期间有效。仅交给你授权的程序；离开此页或关闭配置后不再显示。外部程序仍由其所有者运行。', 'These credentials last for this Hub run only. Share them only with the authorized program. Leaving this page or closing this configuration hides them. The owner still runs the external process.'));
    const reveal = button(say('显示本次连接配置', 'Reveal connection configuration'), () => {
      secret.textContent = JSON.stringify(connection, null, 2); secret.hidden = false; reveal.disabled = true;
    }, 'button button-primary');
    const close = button(say('关闭连接配置', 'Close connection configuration'), () => { secret.textContent = ''; connection = null; view.secret.replaceChildren(); }, 'button button-quiet');
    view.secret.replaceChildren(el('section', { class: 'panel dynamic-connection-inline' }, [el('h3', {}, say('新签发的连接配置', 'New connection configuration')), notice, reveal, close, secret]));
  }

  async function preview(inputData) {
    if (!inventory || inventory.observation !== 'live') throw new Error(say('请先刷新当前 Hub 授权清单。', 'Refresh the current Hub authorizations first.'));
    const capture = generation, reviewedRun = inventory.runId;
    const result = await api(`${base}/preview`, { ...inputData, expectedRunId: reviewedRun, expectedRevision: inventory.revision });
    if (capture !== generation || !result.reviewId) throw new Error(say('运行已改变，请重新审阅。', 'The run changed. Review again.'));
    const status = el('p', { role: 'status', 'aria-live': 'polite' });
    const confirm = action(say('确认并应用本次变更', 'Apply this reviewed change'), async () => {
      if (capture !== generation || inventory?.runId !== reviewedRun) throw new Error(say('运行已改变，请重新审阅。', 'The run changed. Review again.'));
      const applied = await api(`${base}/apply`, { reviewId: result.reviewId, accepted: true });
      if (capture !== generation) return;
      const connection = applied.connection ?? applied.connectionConfig;
      view.editor.replaceChildren();
      // Keep a one-time result even if the subsequent observation refresh fails.
      if (connection && capture === generation) revealConnection(connection);
      try { await refresh(); } catch (error) { issue(error); }
      ctx.toast?.(say('通信权限变更已应用。', 'Communication permission change applied.'));
    }, { primary: true });
    const cancel = button(say('返回编辑', 'Back to editing'), () => review.remove(), 'button button-quiet');
    const review = el('section', { class: 'panel dynamic-inline-review', 'aria-label': say('审阅通信变更', 'Review communication change') }, [
      el('h3', {}, say('本次通信权限变更', 'This communication permission change')),
      data(say('操作与影响', 'Action and effect'), result.review ?? result.preview), status, el('div', { class: 'result-actions' }, [confirm, cancel])]);
    view.editor.querySelector('.dynamic-inline-review')?.remove(); view.editor.append(review);
  }

  function authorize() {
    clearEditor();
    const programId = input('externalProgramId', say('外部程序标识', 'External program ID'));
    const displayName = input('externalTitle', say('显示名称', 'Display name'));
    const slotRows = el('div', { class: 'dynamic-slot-rows' }), slots = [];
    function addSlot() {
      const slot = input('bridgeSlot', say('枢纽桥槽标识', 'Hub bridge slot'), slots.length ? '' : 'main');
      const publish = input('publishTopics', say('允许发送的通道（逗号分隔）', 'Publish topics (comma separated)'));
      const subscribe = input('subscribeTopics', say('允许抽取的通道（逗号分隔）', 'Subscribe topics (comma separated)'));
      const row = el('fieldset', {}, [el('legend', {}, say('枢纽桥权限', 'Hub bridge permissions')), field(say('枢纽桥槽', 'Hub bridge slot'), slot), field(say('允许发送', 'Allow publish'), publish), field(say('允许抽取', 'Allow subscribe'), subscribe)]);
      const entry = { slot, publish, subscribe, row }; slots.push(entry);
      row.append(button(say('移除此桥槽', 'Remove this slot'), () => { slots.splice(slots.indexOf(entry), 1); row.remove(); }, 'button button-quiet'));
      slotRows.append(row);
    }
    addSlot();
    const submit = action(say('预览接入授权', 'Preview connection authorization'), async () => {
      await preview({ action: 'admit', programId: programId.value.trim(), ...(displayName.value.trim() ? { title: displayName.value.trim() } : {}),
        bridges: slots.map(row => ({ slot: row.slot.value.trim(), publish: topics(row.publish.value), subscribe: topics(row.subscribe.value) })) });
    }, { primary: true });
    view.editor.append(el('section', { class: 'panel dynamic-external-editor' }, [el('h3', {}, say('授权外部程序接入', 'Authorize external program')),
      el('p', { class: 'field-help' }, say('填写程序需要的具体通道地址，权限按身份汇总。桥槽是程序接线声明；此处不安装或启动外部程序，也不提供进程管理。', 'Enter the exact topics required by the program. Permissions are combined per identity. Slots describe program wiring. This does not install, start or manage the external process.')),
      field(say('外部程序标识', 'External program ID'), programId), field(say('显示名称', 'Display name'), displayName), slotRows,
      el('div', { class: 'result-actions' }, [button(say('增加桥槽', 'Add bridge slot'), addSlot, 'button button-quiet'), submit,
        button(say('取消', 'Cancel'), clearEditor, 'button button-quiet')])]));
  }

  function sessionCard(row, programId) {
    const id = row.connectionId ?? row.bridgeId, connectionIds = row.connectionId ? [row.connectionId] : [];
    return el('article', { class: 'panel dynamic-observed-session', 'data-connection-id': id }, [
      el('h3', {}, `${row.declaredId ?? row.bridgeId ?? say('枢纽桥', 'Hub bridge')} · ${row.authenticated ? say('已认证连接', 'Authenticated connection') : say('未认证', 'Unauthenticated')}`),
      el('p', { class: 'mono' }, `${row.principal ?? '—'} · ${row.session ?? '—'}`),
      el('p', {}, `${say('连接时间', 'Connected since')}: ${row.since ? ctx.date?.(row.since) ?? row.since : '—'} · ${say('远端地址', 'Remote address')}: ${row.remoteAddress ?? '—'}`),
      el('p', {}, `${say('已发送 / 已递送', 'Published / delivered')}: ${row.published ?? '—'} / ${row.delivered ?? '—'}`),
      data(say('已观察通道与订阅', 'Observed channels and subscriptions'), { channels: row.channels ?? [], subscriptions: row.subscriptions ?? [] }),
      el('p', { class: 'field-help' }, say('连接与收发计数是通信观察。外部进程 PID、进程健康和业务就绪未知。', 'Connections and counters are communication observations. External PID, process health and business readiness are unknown.')),
      action(say('断开本次连接', 'Disconnect this connection'), () => preview({ action: 'disconnect', principal: row.principal, connectionIds }), { disabled: !connectionIds.length || !row.principal })]);
  }

  function renderInventory() {
    if (!view) return;
    const live = observed() && inventory?.observation === 'live';
    const rows = inventory?.programs ?? [];
    view.external.replaceChildren(el('h3', {}, say('外部接入授权（仅本轮）', 'External authorizations (this run only)')),
      ...(rows.length ? rows.map(row => el('article', { class: 'panel dynamic-external-member', 'data-program-id': row.programId }, [
        el('h3', {}, title(row)), el('p', { class: 'mono' }, row.programId),
        el('p', {}, say('外部自运行 · 进程由外部所有者管理', 'Externally run · process managed by its owner')),
        row.authorization === 'unknown' ? el('p', { role: 'status', class: 'notice notice-warning' }, say('上次签发未能确认，已保留此授权记录以便撤销。请撤销后重新授权。', 'The last authorization could not be confirmed. Its record was retained for revocation. Revoke it before issuing a new grant.')) : null,
        data(say('桥槽声明与身份有效授权', 'Slot declarations and effective identity grants'), { bridges: row.bridges, effectiveAllow: row.effectiveAllow, principal: row.principal }),
        ...(row.connections ?? []).map(session => sessionCard(session, row.programId)),
        action(say('撤销本轮授权', 'Revoke this run authorization'), () => preview({ action: 'revoke', programId: row.programId }), { disabled: !live })])) : [el('p', { class: 'field-help' }, say('暂无本轮签发的外部接入授权。', 'No external authorizations issued in this run.'))]),
      el('h3', {}, say('其他外部连接', 'Other external connections')),
      ...((inventory?.observedSessions ?? []).filter(session => !rows.some(row => row.principal === session.principal)).length ? inventory.observedSessions.filter(session => !rows.some(row => row.principal === session.principal)).map(row => sessionCard(row)) : [el('p', { class: 'field-help' }, say('暂无其他已观察连接。', 'No other connections observed.'))]));
    view.matrix.replaceChildren(el('h3', {}, say('通信权限与接线', 'Communication permissions and wiring')),
      el('p', { class: 'field-help' }, say('枢纽桥槽权限是程序声明；身份授权是 Hub 的通信边界；当前连接的通道注册与订阅是运行观察。它们不代表进程或业务就绪。', 'Slot permissions are program declarations. Identity grants are the Hub communication boundary. Registered channels and subscriptions are observations of current connections. They do not establish process or business readiness.')),
      ...programs.map(row => data(`${title(row)} · ${say('受管模块声明', 'Managed declaration')}`, { topics: row.topics, bridges: row.bridges, bindings: row.bindings })),
      ...rows.map(row => data(`${title(row)} · ${say('本轮有效授权', 'Run grants')}`, { principal: row.principal, effectiveAllow: row.effectiveAllow, bridges: row.bridges })),
      ...(!live ? [el('p', { role: 'status' }, say('当前权限观察不可用，请刷新。', 'Current permission observation is unavailable. Refresh to inspect it.'))] : []));
  }

  async function refresh() {
    if (!view || loading) return;
    if (!observed()) { inventory = null; renderInventory(); return; }
    loading = true; const capture = generation;
    try {
      const next = await api(base);
      if (capture !== generation) return;
      if (!next || !Array.isArray(next.programs) || !Array.isArray(next.observedSessions)) throw new Error(say('服务端未返回完整外部接入清单。', 'The server returned no complete external inventory.'));
      if (inventory?.runId && inventory.runId !== next.runId) { generation++; clearEditor(); }
      inventory = next; view.status.textContent = ''; renderInventory();
    } catch (error) { if (capture === generation) { inventory = null; renderInventory(); issue(error); } }
    finally { loading = false; }
  }

  function render(currentPrograms, defaultHub) {
    programs = currentPrograms; hub = defaultHub;
    if (!view || language !== state.language) {
      if (view) clearEditor();
      generation++; language = state.language; inventory = null;
      const root = el('div', { class: 'dynamic-tab-wrap global-dynamic-tab' });
      view = { root, status: el('p', { role: 'status', 'aria-live': 'polite', class: 'dynamic-tab-status' }), external: el('div'), matrix: el('section', { class: 'panel dynamic-permissions-matrix' }), editor: el('div', { class: 'dynamic-inline-editor' }), secret: el('div') };
      view.authorize = action(say('授权外部程序接入', 'Authorize external program'), authorize, { primary: true });
      const toolbar = el('div', { class: 'dynamic-tab-toolbar result-actions' }, [
        view.authorize,
        button(say('载入工作台', 'Load in workbench'), () => ctx.openCreatorFromPrograms?.(), 'button button-quiet'),
        button(say('刷新状态', 'Refresh status'), () => { void ctx.refresh?.({ explicit: true }); void refresh(); }, 'button button-quiet')]);
      root.append(el('section', { class: 'panel' }, [el('h2', {}, say('世界枢纽 · 动态接入与通信观察', 'World Hub · Dynamic Access & Live Topology')),
        el('p', {}, say('管理当前 Hub 运行期间的外部程序接入授权与实时通信连接。外部程序仅按身份授予通信权限，不接管进程。调参接线与保存组合请前往工作台。', 'Manage external program admissions and live communication connections for the current Hub run. External programs are granted topic permissions by identity without process adoption. Use the workbench to configure wiring and save compositions.')), toolbar]),
        view.status, view.editor, view.secret, view.external, view.matrix);
      void refresh();
    }
    if (!active) { active = true; void refresh(); }
    if (!observed()) {
      generation++; inventory = null; clearEditor();
      view.status.textContent = say('世界枢纽当前未运行或观察已过期。启动并刷新后可管理本轮连接与授权。', 'World Hub is stopped or observation has expired. Start and refresh it to manage current connections and authorizations.');
    }
    view.authorize.disabled = !observed();
    renderInventory(); return [view.root];
  }

  function deactivate() { generation++; active = false; inventory = null; clearEditor(); }
  return { render, refresh, deactivate, authorize };
}
