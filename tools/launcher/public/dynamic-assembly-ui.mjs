// Deployment controls belong to Launcher; the Hub still only routes communication.
import { createPackParadigmUi, lifecyclePolicyOf } from './pack-paradigm-ui.mjs';
import { runtimeDesignChange, renderLivePermissionMatrix, renderObservedExternalSessions, isFullPackDeclaration } from './dynamic-modules-tab.mjs';
export function createDynamicAssemblyUi(ctx) {
  const { state, api, el, button } = ctx;
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const label = value => typeof value === 'string' ? value : value?.[state.language] ?? value?.en ?? value?.zh ?? '';
  const copy = value => JSON.parse(JSON.stringify(value));
  const idOf = row => row.componentId ?? row.id;
  const endpoint = id => `/api/instances/${encodeURIComponent(id)}/assembly`;
  const field = (title, input) => el('label', {}, [el('span', {}, title), input]);
  const detail = (title, value) => el('details', {}, [el('summary', {}, title), el('pre', {}, JSON.stringify(value, null, 2))]);
  const contractEqual = (a, b) => a?.id === b?.id && a?.version === b?.version;
  const communicationLabel = value => ({ connected: say('已连接', 'Connected'), disconnected: say('未连接', 'Disconnected'), unknown: say('尚未观察', 'Not observed') }[value] ?? value);
  const paradigms = createPackParadigmUi(ctx);
  const cachedViews = new Map(), memberBusy = new Set();

  function dialog(title, className = '') {
    const node = el('dialog', { class: `dialog deployment-dialog ${className}`, 'aria-label': title });
    const content = el('div'), status = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' });
    const close = button(say('关闭', 'Close'), () => node.close(), 'button button-quiet');
    node.append(el('div', { class: 'dialog-heading' }, [el('h2', {}, title), close]), content, status);
    node.addEventListener('close', () => node.remove(), { once: true });
    document.body.append(node); node.showModal();
    return { node, content, status, close };
  }

  function inlineView(title, className, mount) {
    const node = el('section', { class: `panel dynamic-inline-editor ${className}`, 'aria-label': title });
    node.open = true;
    node.close = () => { if (!node.open) return; node.open = false; node.dispatchEvent(new Event('close')); node.remove(); };
    const content = el('div', { class: 'stack' }), status = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' });
    const close = button(say('取消', 'Cancel'), () => node.close(), 'button button-quiet');
    node.append(el('div', { class: 'dialog-heading' }, [el('h3', {}, title), close]), content, status); mount.append(node);
    return { node, content, status, close };
  }

  function jsonField(title, value, name) {
    const input = el('textarea', { name, rows: 5, 'aria-label': title }); input.value = JSON.stringify(value, null, 2);
    return { node: field(title, input), read: () => {
      try { return JSON.parse(input.value); }
      catch { throw new Error(say(`「${title}」必须是有效 JSON。`, `“${title}” must contain valid JSON.`)); }
    } };
  }

  function settingsEditor(deployment, initial) {
    const values = copy(initial ?? {}), declared = deployment?.settings ?? [], nodes = [];
    for (const item of declared) {
      if (!Object.hasOwn(values, item.key)) values[item.key] = item.default;
      const title = label(item.label) || item.key, multiline = item.type === 'string' && /[\r\n]/.test(values[item.key] ?? '');
      const input = el(multiline ? 'textarea' : 'input', { name: `setting:${item.key}`, 'aria-label': title,
        ...(multiline ? { rows: 4 } : { type: item.type === 'boolean' ? 'checkbox' : item.type === 'number' ? 'number' : 'text' }),
        ...(item.min !== undefined ? { min: item.min } : {}), ...(item.max !== undefined ? { max: item.max } : {}) });
      if (item.type === 'boolean') input.checked = values[item.key]; else input.value = values[item.key] ?? '';
      nodes.push(field(title, input));
      input.addEventListener('input', () => { values[item.key] = item.type === 'boolean' ? input.checked : item.type === 'number' ? Number(input.value) : input.value; });
      input.addEventListener('change', () => { values[item.key] = item.type === 'boolean' ? input.checked : item.type === 'number' ? Number(input.value) : input.value; });
    }
    // Undeclared public settings stay visible and editable without being discarded.
    const remaining = Object.fromEntries(Object.entries(values).filter(([key]) => !declared.some(item => item.key === key)));
    let advanced;
    if (Object.keys(remaining).length || !deployment) {
      advanced = jsonField(say('其他公开参数', 'Other public settings'), remaining, 'otherSettings');
      nodes.push(el('details', {}, [el('summary', {}, say('高级公开参数', 'Advanced public settings')), advanced.node]));
    }
    return { nodes, read: () => {
      const extra = advanced ? advanced.read() : {};
      if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).some(key => declared.some(item => item.key === key)))
        throw new Error(say('其他公开参数必须是对象，且不能覆盖上方已声明的参数。', 'Other public settings must be an object and must not override declared fields above.'));
      return { ...values, ...extra };
    } };
  }

  function communicationEditor(topics, bridges, slots) {
    const topicRows = el('div'), bridgeRows = el('div'), selected = copy(bridges ?? {}), topicInputs = [];
    const aliases = Object.keys(topics ?? {});
    for (const alias of aliases) {
      const input = el('input', { name: `topic:${alias}`, 'aria-label': `${say('通道', 'Topic')} · ${alias}` }); input.value = topics[alias];
      topicInputs.push([alias, input]); topicRows.append(field(alias, input));
    }
    for (const slot of slots ?? Object.keys(selected)) {
      selected[slot] ??= { publish: [], subscribe: [] };
      const directions = ['publish', 'subscribe'].map(direction => el('fieldset', {}, [el('legend', {}, direction === 'publish' ? say('发送', 'Publish') : say('抽取', 'Subscribe')),
        ...aliases.map(alias => {
          const input = el('input', { type: 'checkbox', name: `grant:${slot}:${direction}:${alias}`, 'aria-label': `${slot} · ${direction} · ${alias}`, checked: selected[slot][direction]?.includes(alias) });
          input.addEventListener('change', () => { selected[slot][direction] = input.checked ? [...new Set([...(selected[slot][direction] ?? []), alias])] : (selected[slot][direction] ?? []).filter(value => value !== alias); });
          return field(alias, input);
        })]));
      bridgeRows.append(el('fieldset', {}, [el('legend', {}, slot), ...directions]));
    }
    return { node: el('details', {}, [el('summary', {}, say('通道与模块桥权限', 'Topics and module bridge permissions')), topicRows, bridgeRows]),
      read: () => ({ topics: Object.fromEntries(topicInputs.map(([alias, input]) => [alias, input.value.trim()])), bridges: copy(selected) }) };
  }

  function providerEditor(componentId, requires, initial, programs) {
    const choices = [], nodes = [];
    for (const required of requires ?? []) {
      const providers = programs.filter(row => idOf(row) !== componentId && (row.manifest?.provides ?? row.provides ?? []).some(offered => contractEqual(offered, required)));
      const input = el('select', { name: `provider:${required.id}@${required.version}`, 'aria-label': `${required.id} @${required.version}` }, [
        el('option', { value: '' }, say('选择能力提供者', 'Choose capability provider')),
        ...providers.map(row => el('option', { value: idOf(row) }, `${label(row.title) || idOf(row)} · ${idOf(row)}`))]);
      const existing = (initial ?? []).find(binding => contractEqual(binding.contract, required));
      if (existing) input.value = existing.providerId ?? existing.from;
      else if (providers.length === 1) input.value = idOf(providers[0]);
      choices.push({ input, contract: copy(required) }); nodes.push(field(`${required.id} @${required.version}`, input));
      if (!providers.length) nodes.push(el('p', { class: 'field-help' }, say('尚无提供此精确契约版本的成员。请先添加提供者。', 'No member provides this exact contract version. Add a provider first.')));
    }
    return { nodes, read: () => choices.map(({ input, contract }) => {
      if (!input.value) throw new Error(say(`请选择 ${contract.id} @${contract.version} 的提供者。`, `Choose a provider for ${contract.id} @${contract.version}.`));
      return { providerId: input.value, contract };
    }) };
  }

  function dependencyEditor(componentId, initial, programs) {
    const selected = new Set(initial ?? []);
    const rows = programs.filter(row => idOf(row) !== componentId).map(row => {
      const id = idOf(row), input = el('input', { type: 'checkbox', name: `after:${id}`, checked: selected.has(id), 'aria-label': `${say('启动顺序依赖', 'Startup order dependency')} · ${id}` });
      input.addEventListener('change', () => { if (input.checked) selected.add(id); else selected.delete(id); });
      return field(label(row.title) || id, input);
    });
    return { node: el('details', {}, [el('summary', {}, say('启动顺序依赖', 'Startup order dependencies')), el('p', { class: 'field-help' }, say('这些成员必须先启动。能力提供者与启动顺序分别配置；独立启动不会自动启动依赖。', 'These members must start first. Capability providers and startup order are configured separately; an independent start does not automatically start dependencies.')), ...rows]), read: () => [...selected] };
  }

  async function waitOperation(result, status, inactive = () => false) {
    if (!result?.operationId) return result;
    for (;;) {
      const { operation } = await api(`/api/operations/${encodeURIComponent(result.operationId)}`);
      if (operation.state === 'succeeded') return operation.result;
      if (operation.state === 'failed' || operation.state === 'cancelled') throw new Error(operation.error?.message ?? say('操作失败或已取消。', 'Operation failed or was cancelled.'));
      if (!inactive()) status.textContent = say('正在应用已审阅的操作…', 'Applying the reviewed operation…');
      await new Promise(done => setTimeout(done, 500));
    }
  }

  function showConnection(connection, mount) {
    if (mount?.dynamicDisposed) return;
    const create = mount ? (title, className) => inlineView(title, className, mount) : dialog;
    const view = create(say('外部程序接入配置', 'External program connection configuration'), 'dynamic-connection-dialog');
    const secret = el('pre', { 'data-dynamic-secret': '' }); secret.hidden = true;
    const reveal = button(say('显示本次接入配置', 'Reveal connection configuration'), () => {
      secret.textContent = JSON.stringify(connection, null, 2); secret.hidden = false; reveal.disabled = true;
    }, 'button button-primary');
    view.content.append(el('p', {}, say('此配置包含私有接入凭据，仅交给你授权的外部程序。外部程序由你自行运行；Launcher 不拥有或停止其进程。关闭后不会在此界面重新显示凭据。', 'This configuration contains private credentials. Give it only to the external program you authorized. You run that program yourself; Launcher does not own or stop its process. Closing this view removes the displayed credentials.')), reveal, secret);
    view.node.addEventListener('close', () => { secret.textContent = ''; connection = null; });
  }

  async function reviewedOperation({ base, input, revision, runId, sourceView, onApplied, mount }) {
    if (mount?.dynamicDisposed) throw new Error(say('此运行视图已失效，请刷新后重新操作。', 'This run view expired. Refresh before trying again.'));
    const preview = await api(`${base}/preview`, { ...input, expectedRevision: revision, expectedRunId: runId });
    if (mount?.dynamicDisposed) return null;
    const reviewed = preview.review ?? preview.preview;
    if (!preview.reviewId || !reviewed) throw new Error(say('服务端未返回可确认的审阅。', 'The server returned no confirmable review.'));
    const review = mount ? inlineView(say('审阅组合变更', 'Review assembly change'), 'dynamic-assembly-review', mount) : dialog(say('审阅组合变更', 'Review assembly change'), 'dynamic-assembly-review');
    let applying = false;
    review.completed = new Promise(done => review.node.addEventListener('close', done, { once: true }));
    review.node.addEventListener('cancel', event => { if (applying) event.preventDefault(); });
    const accepted = el('input', { type: 'checkbox', name: 'acceptAssemblyChange', 'aria-label': say('我已审阅本次变更', 'I reviewed this change') });
    const confirm = button(say('确认并应用', 'Confirm and apply'), async () => {
      if ((!mount && !accepted.checked) || applying || mount?.dynamicDisposed) return;
      applying = true; confirm.disabled = true; accepted.disabled = true; review.close.disabled = true;
      try {
        const result = await waitOperation(await api(`${base}/apply`, { reviewId: preview.reviewId, accepted: true }), review.status, () => mount?.dynamicDisposed);
        if (mount?.dynamicDisposed) return;
        if (sourceView) sourceView.node.close();
        // Refresh cannot discard an already-issued one-time connection config.
        try { await onApplied?.(result); } catch (issue) { ctx.toast?.(issue.message); }
        const connection = result?.connection ?? result?.connectionConfig ?? result?.external?.connection;
        if (connection) showConnection(connection, mount);
        ctx.toast?.(say('已应用本次组合变更。', 'Assembly change applied.')); review.node.close();
      } catch (issue) { if (!mount?.dynamicDisposed) review.status.textContent = issue.message; }
      finally { applying = false; if (!mount?.dynamicDisposed) { accepted.disabled = false; review.close.disabled = false; confirm.disabled = !mount && !accepted.checked; } }
    }, 'button button-primary');
    confirm.disabled = !mount;
    accepted.addEventListener('change', () => { confirm.disabled = !accepted.checked || applying; });
    review.content.append(el('p', {}, say('仅执行审阅中列出的成员、权限和接线变更。已有程序保留自己的运行配置；需要重新载入时，单独审阅并重启受影响的程序。', 'Only the listed member, permission and wiring changes will be applied. Existing programs retain their running configuration; separately review and restart an affected program when it needs to reload.')),
      detail(say('本次操作及影响', 'Action and affected members'), reviewed), ...(!mount ? [field(say('我已审阅本次变更', 'I reviewed this change'), accepted)] : []), confirm);
    return review;
  }

  async function reviewComponentAction(instance, componentId, action, statusNode) {
    const instanceId = instance?.instanceId ?? instance?.id, key = `${instanceId}:${componentId}`;
    if (memberBusy.has(key)) return;
    memberBusy.add(key);
    try {
      const status = instance?.status ?? {};
      if (!['start', 'stop'].includes(action) || !status.runId || status.stoppedAt || status.state !== 'running' || status.executionProfile !== 'trusted-local' || status.sandbox === true
          || status.observation === 'stale' || ctx.isStale?.(status)) throw new Error(say('需要当前可信本机运行及新鲜状态，才能启停成员。', 'A current trusted local run and fresh observation are required to control members.'));
      if (action === 'start' && status.cleanupIncomplete) throw new Error(say('实例所属进程清理尚未确认完成，请先完成清理。', 'Owned process cleanup is not confirmed. Complete cleanup first.'));
      const base = endpoint(instanceId), current = await api(base), row = current.assembly?.programs?.find(program => idOf(program) === componentId);
      if (current.runId !== status.runId) throw new Error(say('运行已改变，请刷新后重试。', 'The run changed. Refresh and try again.'));
      if (!row || row.ownership !== 'managed' || current.assembly?.revision === undefined || current.assembly?.revision === null) throw new Error(say('该成员不是此 Launcher 已核验的受管进程，或缺少当前组合修订。', 'This member is not a verified Launcher-managed process, or the current assembly revision is missing.'));
      if (action === 'start' && row.cleanupIncomplete) throw new Error(say('此成员的进程清理尚未确认完成，请先完成清理。', 'This member’s process cleanup is not confirmed. Complete cleanup first.'));
      const preview = await api(`${base}/preview`, { action, componentId, expectedRevision: current.assembly.revision, expectedRunId: current.runId });
      if (!preview.reviewId || !(preview.review ?? preview.preview)) throw new Error(say('服务端未返回可应用的预检。', 'The server returned no applicable preflight.'));
      const result = await waitOperation(await api(`${base}/apply`, { reviewId: preview.reviewId, accepted: true }), statusNode ?? el('p'));
      await ctx.refresh?.({ explicit: true }); return result;
    } catch (issue) {
      if (statusNode) statusNode.textContent = issue.message; else ctx.toast?.(issue.message);
      return { error: issue };
    } finally { memberBusy.delete(key); }
  }

  async function createView(instance, { embedded = false, suppliedView } = {}) {
    const instanceId = typeof instance === 'string' ? instance : instance?.instanceId ?? instance?.id;
    if (!instanceId) throw new Error(say('未选择整合包实例。', 'No pack instance selected.'));
    const base = endpoint(instanceId), view = suppliedView ?? dialog(say('运行中的组合', 'Live assembly'), 'dynamic-assembly-dialog');
    const makeEditor = (title, className) => embedded ? inlineView(title, className, view.editors) : dialog(title, className);
    let snapshot, runId, savedPack = null;
    if (embedded) {
      if (instance.packageDirectory) {
        try {
          const checked = await api('/api/authoring/inspect', { directory: instance.packageDirectory }), candidate = (checked.authoring ?? checked).pack;
          if (isFullPackDeclaration(candidate) && candidate.id === instance.pack?.id && candidate.version === instance.pack?.version) savedPack = candidate;
          else view.baselineError = say('已保存来源未返回完整且匹配当前版本的组合声明。', 'The saved source did not return full declarations matching the current version.');
        } catch (issue) { view.baselineError = issue.message; }
      } else {
        const checked = state.reviews?.get(instanceId), candidate = checked?.review?.pack;
        if (isFullPackDeclaration(candidate) && candidate.id === instance.pack?.id && candidate.version === instance.pack?.version
            && checked.digest && checked.digest === instance.sourceDigest) savedPack = candidate;
      }
    }
    const report = issue => { view.status.textContent = issue.message; };

    async function reviewAction(input, sourceView = view) {
      return reviewedOperation({ base, input, revision: snapshot.revision, runId, ...(embedded ? { mount: view.editors } : {}), ...(sourceView !== view ? { sourceView } : {}), onApplied: async () => {
        try { await render(); await ctx.refresh?.({ explicit: true }); } catch (issue) { report(issue); }
      } });
    }

    async function configure(row) {
      const editor = makeEditor(say('调整成员配置', 'Configure member'), 'dynamic-member-editor');
      try {
        const directory = row.sourceDirectory ?? row.directory;
        const inspected = row.deployment ? null : directory ? await api('/api/deployment/inspect', { directory }) : null;
        const deployment = row.deployment ?? inspected?.deploymentReview?.deployment;
        const settings = settingsEditor(deployment, row.settings), manifest = row.manifest ?? inspected?.manifest ?? row;
        const communication = communicationEditor(row.topics, row.bridges, manifest.bridges);
        const providers = providerEditor(idOf(row), manifest.requires, row.bindings, [...snapshot.programs, ...(snapshot.external ?? [])]);
        const dependencies = dependencyEditor(idOf(row), row.after, snapshot.programs);
        const lifecycle = paradigms.flagsEditor(row, snapshot.pack);
        const submit = button(say('审阅配置变更', 'Review configuration change'), async () => {
          submit.disabled = true;
          try { await reviewAction({ action: 'configure', componentId: idOf(row), settings: settings.read(), ...communication.read(), bindings: providers.read(), after: dependencies.read(), ...lifecycle.read() }, editor); }
          catch (issue) { editor.status.textContent = issue.message; } finally { submit.disabled = false; }
        }, 'button button-primary');
        editor.content.append(el('p', { class: 'mono' }, idOf(row)), el('p', {}, say('参数和接线属于当前实例。正在运行的成员需要先停止再调整；其他程序不会自动重启。保存为组合版本请使用工作台。', 'Settings and wiring belong to this instance. Stop a running member before changing it; other programs are not restarted automatically. Use the workbench to save a composition version.')), ...settings.nodes, ...providers.nodes, lifecycle.node, dependencies.node, communication.node, submit);
      } catch (issue) { editor.status.textContent = issue.message; }
    }

    async function addManaged() {
      const editor = makeEditor(say('热挂载模块（仅本次运行）', 'Hot-plug module (this run only)'), 'dynamic-member-editor');
      try {
        const available = ctx.getModules ? await ctx.getModules() : (await api('/api/paths/known')).objects.filter(row => row.kind === 'module');
        const rows = available.filter(row => row.path || row.directory);
        const choose = el('select', { name: 'moduleVersion', 'aria-label': say('模块版本与来源', 'Module version and source') }, [el('option', { value: '' }, say('选择本地模块…', 'Choose a local module…')),
          ...rows.map((row, index) => el('option', { value: String(index) }, `${row.id ?? row.module?.id} @${row.version ?? row.module?.version} · ${row.path ?? row.directory}`))]);
        const directory = el('input', { name: 'moduleDirectory', 'data-path-purpose': 'module', 'aria-label': say('模块目录', 'Module directory') });
        choose.addEventListener('change', () => { if (choose.value !== '') directory.value = rows[Number(choose.value)].path ?? rows[Number(choose.value)].directory; });
        const configuration = el('div'); let ready;
        const inspect = button(say('读取接入默认值', 'Load deployment defaults'), async () => {
          inspect.disabled = true; ready = null; configuration.replaceChildren();
          try {
            const exactDirectory = directory.value.trim();
            const inspected = await api('/api/deployment/inspect', { directory: exactDirectory }), deployment = inspected.deploymentReview?.deployment;
            if (!deployment) throw new Error(say('此模块需要作者提供 deployment.json 接入默认值。', 'The author must supply deployment.json defaults for this module.'));
            const component = el('input', { name: 'componentId', value: `program.${Date.now().toString(36)}`, 'aria-label': say('成员标识', 'Member ID') });
            const settings = settingsEditor(deployment), communication = communicationEditor(deployment.topics, deployment.bridges, inspected.manifest.bridges);
            const providers = providerEditor('', inspected.manifest.requires, [], [...snapshot.programs, ...(snapshot.external ?? [])]);
            const dependencies = dependencyEditor('', [], snapshot.programs);
            const lifecycle = paradigms.flagsEditor({}, snapshot.pack);
            ready = { directory: exactDirectory, component, settings, communication, providers, dependencies, lifecycle };
            configuration.append(el('h3', {}, `${label(deployment.title) || inspected.manifest.id} @${inspected.manifest.version}`), field(say('成员标识', 'Member ID'), component), ...settings.nodes, ...providers.nodes, lifecycle.node, dependencies.node, communication.node);
          } catch (issue) { editor.status.textContent = issue.message; } finally { inspect.disabled = false; }
        }, 'button');
        const submit = button(say('审阅并添加', 'Review and add'), async () => {
          submit.disabled = true;
          try {
            if (!ready || ready.directory !== directory.value.trim()) throw new Error(say('请先读取当前所选目录的接入默认值。', 'Load deployment defaults for the currently selected folder first.'));
            await reviewAction({ action: 'add', componentId: ready.component.value.trim(), directory: ready.directory, settings: ready.settings.read(), ...ready.communication.read(), bindings: ready.providers.read(), after: ready.dependencies.read(), ...ready.lifecycle.read() }, editor);
          } catch (issue) { editor.status.textContent = issue.message; } finally { submit.disabled = false; }
        }, 'button button-primary');
        // path-ui enhances the declared module field with its authenticated
        // chooser and path status; a second local chooser duplicates that UI.
        editor.content.append(el('p', {}, say('选定一个确切的本地模块版本，审阅源码、权限、参数和提供者。添加后单独审阅启动。', 'Select an exact local module version and review its source, permissions, settings and providers. Review its start separately after adding.')), field(say('模块版本与来源', 'Module version and source'), choose), field(say('模块目录', 'Module directory'), directory), el('div', { class: 'result-actions' }, [inspect]), configuration, submit);
      } catch (issue) { editor.status.textContent = issue.message; }
    }

    async function admitExternal() {
      const editor = makeEditor(say('授权外部程序接入', 'Authorize external program'), 'dynamic-external-editor');
      const componentId = el('input', { name: 'componentId', 'aria-label': say('外部成员标识', 'External member ID') });
      const title = el('input', { name: 'externalTitle', 'aria-label': say('显示名称', 'Display name') });
      const topics = jsonField(say('通道别名与地址', 'Topic aliases and addresses'), {}, 'externalTopics');
      const bridges = jsonField(say('模块桥槽与收发权限', 'Bridge slots and publish/subscribe permissions'), {}, 'externalBridges');
      const provides = jsonField(say('提供的精确能力契约', 'Exact provided capability contracts'), [], 'externalProvides');
      const requires = jsonField(say('需要的精确能力契约', 'Exact required capability contracts'), [], 'externalRequires');
      const bindings = jsonField(say('选定的能力提供者', 'Selected capability providers'), [], 'externalBindings');
      const submit = button(say('审阅接入授权', 'Review connection authorization'), async () => {
        submit.disabled = true;
        try { await reviewAction({ action: 'admit-external', componentId: componentId.value.trim(), ...(title.value.trim() ? { title: title.value.trim() } : {}), topics: topics.read(), bridges: bridges.read(), provides: provides.read(), requires: requires.read(), bindings: bindings.read() }, editor); }
        catch (issue) { editor.status.textContent = issue.message; } finally { submit.disabled = false; }
      }, 'button button-primary');
      editor.content.append(el('p', {}, say('外部程序由其所有者运行。此操作只为当前实例签发经过审阅的接入身份和通信权限，不安装源码、不启动或接管进程。请按该程序作者的接入声明填写。', 'The owner runs this external program. This action only issues a reviewed identity and communication permissions for this instance. It does not install source, start, or adopt a process. Use the program author’s connection declaration.')), field(say('外部成员标识', 'External member ID'), componentId), field(say('显示名称', 'Display name'), title), topics.node, bridges.node, el('details', {}, [el('summary', {}, say('能力声明与接线', 'Capability declarations and wiring')), provides.node, requires.node, bindings.node]), submit);
    }

    async function reviewEntryRemoval(row) {
      const editor = makeEditor(say('选择新的入口成员', 'Choose a replacement entry'), 'dynamic-entry-removal');
      const candidates = snapshot.programs.filter(other => idOf(other) !== idOf(row));
      const selected = el('select', { name: 'replacementEntry', 'aria-label': say('新的入口成员', 'Replacement entry member') }, [el('option', { value: '' }, say('请选择受管成员', 'Choose a managed member')),
        ...candidates.map(other => el('option', { value: idOf(other) }, `${label(other.title ?? other.deployment?.title) || idOf(other)} · ${idOf(other)}`))]);
      const submit = button(say('审阅入口移除', 'Review entry removal'), async () => {
        submit.disabled = true;
        try {
          if (!candidates.some(other => idOf(other) === selected.value)) throw new Error(say('请明确选择一个保留的受管成员作为新入口。', 'Explicitly choose a remaining managed member as the replacement entry.'));
          await reviewAction({ action: 'remove', componentId: idOf(row), entry: selected.value }, editor);
        } catch (issue) { editor.status.textContent = issue.message; } finally { submit.disabled = false; }
      }, 'button button-primary');
      submit.disabled = !candidates.length;
      editor.content.append(el('p', {}, say('你正在移除当前入口。先停止此成员、处理仍引用它的依赖，再明确选择保留的受管成员作为新入口。新入口由该程序决定是否提供界面。', 'You are removing the current entry. Stop this member, handle dependencies that still reference it, then choose a remaining managed member as the new entry. The selected program determines whether it exposes an interface.')),
        candidates.length ? field(say('新的入口成员', 'Replacement entry member'), selected) : el('p', {}, say('需要至少保留一个受管成员才能替换入口。', 'At least one other managed member must remain to replace the entry.')), submit);
    }

    function restoreSavedRun() {
      const restore = makeEditor(say('恢复已保存组合', 'Restore the saved composition'), 'dynamic-restore-saved');
      restore.content.append(el('p', {}, say('恢复需要结束本次运行。临时接入授权与未固化装配随本次运行结束；业务数据不因此清空。停止后仍需单独审阅并启动已保存组合，不会自动重启。', 'Restoring requires ending this run. Temporary admissions and unsaved composition changes end with it; business data is not cleared by this action. After stopping, separately review and start the saved composition. Nothing restarts automatically.')),
        button(say('停止本次运行以恢复', 'Stop this run to restore'), async () => {
          try {
            if (!ctx.stopInstance) throw new Error(say('当前界面没有停止实例入口，请使用详情页的停止操作。', 'Use the instance detail Stop action to end this run.'));
            await ctx.stopInstance(instanceId);
          } catch (issue) { restore.status.textContent = issue.message; }
        }, 'button button-danger'));
    }

    function actionButton(title, action, row, disabled = false) {
      const node = button(title, async () => {
        node.disabled = true;
        try {
          if (embedded && ['start', 'stop'].includes(action)) { const outcome = await reviewComponentAction(view.instance ?? instance, idOf(row), action, view.status); if (!outcome?.error) await render(); }
          else if (action === 'remove' && snapshot.pack?.entry?.component === idOf(row)) await reviewEntryRemoval(row);
          else await reviewAction({ action, componentId: idOf(row) });
        } catch (issue) { report(issue); } finally { node.disabled = disabled; }
      }, action === 'start' ? 'button button-primary' : 'button button-quiet'); node.disabled = disabled; return node;
    }

    function programCard(row) {
      const module = row.module ?? row.manifest ?? {}, manifest = row.manifest;
      const stateLabels = { running: say('运行中', 'Running'), stopped: say('已停止', 'Stopped'), exited: say('已退出', 'Exited'), starting: say('启动中', 'Starting'), stopping: say('停止中', 'Stopping'), failed: say('需要处理', 'Needs attention'), removed: say('已移除', 'Removed') };
      const connected = row.communication ?? row.readiness?.communication;
      const active = ['running', 'starting', 'stopping', 'unknown'].includes(row.state);
      const added = ['dynamic', 'added'].includes(row.origin);
      const heading = `${label(row.title ?? row.deployment?.title) || module.id || idOf(row)} · ${idOf(row)}`;
      return el('article', { class: 'panel dynamic-managed-member', 'data-component-id': idOf(row) }, [el('h3', {}, heading),
        el('p', { class: 'mono' }, `${module.id ?? row.moduleId ?? '—'} @${module.version ?? '—'} · ${added ? say('本实例新增', 'Added to this instance') : say('初始组合', 'Initial composition')}`),
        el('div', { class: 'result-actions' }, paradigms.memberFlags(row, snapshot.pack)),
        el('p', {}, `${stateLabels[row.state] ?? row.state ?? say('状态未知', 'State unknown')}${connected ? ` · ${communicationLabel(connected)}` : ''}${row.pid ? ` · ${active ? 'PID' : say('上次 PID', 'Last PID')} ${row.pid}` : ''}`),
        row.readiness ? el('p', {}, `${say('就绪状态', 'Readiness')}: ${typeof row.readiness === 'string' ? ({ ready: say('已就绪', 'Ready'), 'not-ready': say('未就绪', 'Not ready') }[row.readiness] ?? row.readiness) : JSON.stringify(row.readiness)}`) : null,
        row.sourceDirectory || row.directory ? el('p', { class: 'mono' }, row.sourceDirectory ?? row.directory) : null,
        manifest?.runtime ? el('p', {}, `${say('执行环境', 'Runtime')}: ${manifest.runtime.kind} · ${manifest.runtime.entry ?? ''}`) : null,
        row.sourceFileCount !== undefined ? el('p', {}, `${say('源码文件', 'Source files')}: ${row.sourceFileCount} · ${say('模块桥槽', 'Bridge slots')}: ${(manifest?.bridges ?? Object.keys(row.bridges ?? {})).length}`) : null,
        row.error || row.failure ? el('p', { role: 'status' }, (row.error ?? row.failure).message ?? String(row.error ?? row.failure)) : null,
        detail(say('当前参数、接线与权限', 'Current settings, wiring and permissions'), { settings: row.settings, topics: row.topics, bridges: row.bridges, bindings: row.bindings, permissions: manifest?.permissions ?? row.permissions, readiness: row.readiness }),
        el('div', { class: 'result-actions' }, [actionButton(embedded ? say('启动', 'Start') : say('审阅启动', 'Review start'), 'start', row, active), actionButton(embedded ? say('停止', 'Stop') : say('审阅停止', 'Review stop'), 'stop', row, !active && row.state !== 'failed'),
          button(say('调整参数与接线', 'Configure settings and wiring'), () => configure(row), 'button button-quiet'), actionButton(say('审阅移除', 'Review removal'), 'remove', row),
          button(say('日志', 'Logs'), () => { if (ctx.openLogs) return ctx.openLogs(idOf(row)); state.logSelection = idOf(row); return ctx.changeTab?.('logs'); }, 'button button-quiet')])].filter(Boolean));
    }

    function externalCard(row) {
      return el('article', { class: 'panel dynamic-external-member', 'data-component-id': idOf(row) }, [el('h3', {}, label(row.title) || idOf(row)),
        el('p', {}, say('外部自运行 · 进程由外部所有者管理', 'Externally run · process managed by its owner')),
        el('p', {}, `${say('通信状态', 'Communication')}: ${communicationLabel(row.communication ?? row.state ?? 'unknown')}`),
        detail(say('接入声明与通信权限', 'Connection declarations and permissions'), { componentId: idOf(row), principal: row.principal, topics: row.topics, bridges: row.bridges, provides: row.provides, requires: row.requires, bindings: row.bindings }),
        actionButton(say('审阅撤销接入', 'Review connection revocation'), 'revoke-external', row)]);
    }

    async function render() {
      const result = await api(base);
      if (view.disposed) return;
      if (embedded && result.runId !== view.instance?.status?.runId) throw new Error(say('运行已改变，请刷新当前实例。', 'The run changed. Refresh the current instance.'));
      snapshot = result.assembly; runId = result.runId;
      if (!snapshot || !Array.isArray(snapshot.programs) || !Array.isArray(snapshot.external)) throw new Error(say('服务端未返回当前组合的受管成员和外部接入清单。', 'The server returned no managed-member and external-connection inventory for this assembly.'));
      const policy = el('select', { name: 'lifecyclePolicy', 'aria-label': say('成员故障策略', 'Member failure policy') }, [el('option', { value: 'fail-fast' }, say('任一成员意外故障时停止整组', 'Stop the assembly on any unexpected member failure')), el('option', { value: 'independent' }, say('普通故障独立，关键故障停止整组', 'Isolate ordinary failures; stop on critical failures'))]);
      policy.value = snapshot.policy ?? snapshot.failurePolicy ?? snapshot.lifecyclePolicy ?? lifecyclePolicyOf(snapshot.pack);
      const policyAction = button(say('审阅故障策略', 'Review failure policy'), async () => {
        policyAction.disabled = true;
        try { await reviewAction({ action: 'set-policy', policy: policy.value }); } catch (issue) { report(issue); } finally { policyAction.disabled = false; }
      }, 'button button-quiet');
      const changed = embedded ? runtimeDesignChange(snapshot, savedPack) : { known: false, changed: false };
      const instanceTitle = label(view.instance?.title ?? view.instance?.pack?.title ?? snapshot.pack?.title) || view.instance?.pack?.id || instanceId;

      const headerPanel = el('section', { class: 'panel dynamic-tab-header' }, [
        el('h2', {}, `${instanceTitle} · ${say('动态模块与权限', 'Dynamic Modules & Permissions')}`),
        el('p', {}, say('管理当前整合包运行期间的临时热挂载模块、外部程序接入授权与通信权限。这里所做变更仅随本次运行有效，不会改写底层整合包。保存组合请载入工作台。', 'Manage hot-plugged modules, external program admissions and live communication permissions for this run. Changes here apply only to the current run without modifying the underlying pack. Use the workbench to save a new composition.')),
        el('p', { class: 'mono subtle small', style: 'margin-top: 4px; margin-bottom: 12px;' }, `${instanceId}${result.runId ? ` · ${result.runId}` : ''} · ${say('组合修订', 'Assembly revision')} ${snapshot.revision}`),
        el('div', { class: 'dynamic-tab-toolbar result-actions' }, [
          button(say('热挂载模块（仅本次运行）', 'Hot-plug module (this run only)'), addManaged, 'button button-primary'),
          button(say('授权外部程序接入', 'Authorize external program'), admitExternal, 'button button-quiet'),
          button(say('载入工作台', 'Load in workbench'), async () => {
            try { await ctx.openCreatorFromInstance(instanceId); if (!embedded) view.node.close(); } catch (issue) { report(issue); }
          }, 'button button-quiet'),
          button(say('刷新状态', 'Refresh status'), async () => { try { await render(); } catch (issue) { report(issue); } }, 'button button-quiet')
        ])
      ]);

      const policyPanel = el('section', { class: 'panel dynamic-policy-panel' }, [
        el('div', { class: 'panel-heading', style: 'margin-bottom: 8px;' }, [
          el('div', { class: 'panel-heading-title' }, [
            el('h3', {}, say('运行故障策略与预设', 'Runtime Failure Policy & Preset')),
            el('p', { class: 'panel-subhead' }, say('定义成员意外故障时的整组行为；主动停止不算意外故障。', 'Define failure handling on unexpected member failures; intentional stop is not unexpected.'))
          ]),
          snapshot.pack ? paradigms.badge(snapshot.pack) : null
        ].filter(Boolean)),
        field(say('成员故障策略', 'Member failure policy'), policy),
        el('p', { class: 'field-help' }, say('独立策略保留其他普通成员；关键成员意外故障仍停止整组。首次启动按所选预设和 after 前置执行，主动停止不算意外故障。', 'Independent policy preserves other ordinary members; unexpected critical-member failures still stop the group. Initial startup follows the selected preset and after prerequisites. An intentional stop is not an unexpected failure.')),
        el('div', { class: 'result-actions' }, [policyAction])
      ]);

      const dynamicPrograms = snapshot.programs.filter(row => ['dynamic', 'added'].includes(row.origin));
      const baselinePrograms = snapshot.programs.filter(row => !['dynamic', 'added'].includes(row.origin));

      const baselinePanel = baselinePrograms.length ? el('details', { class: 'panel baseline-members-panel', open: false }, [
        el('summary', { style: 'cursor: pointer; font-weight: 600; padding: 4px 0;' }, [
          say('初始组合成员（受管进程诊断与接线微调）', 'Initial composition members (managed diagnostics & rewiring)'),
          el('span', { class: 'pill pill-subtle', style: 'margin-left: 8px;' }, `${baselinePrograms.length} ${say('个静态模块', 'static modules')}`)
        ]),
        el('div', { style: 'margin-top: 14px;' }, [
          el('p', { class: 'field-help', style: 'margin-bottom: 12px;' }, say('这些是整合包预设自带的静态成员。完整进程状态与常规启停已在「运行状态」页呈现；如需在本次运行中单独微调其参数接线、启停或移除入口，可在此展开操作。', 'These are preset members from the initial pack. Runtime status is presented in the "Status" tab; expand here to rewire settings, stop/start, or replace entries for this run.')),
          ...baselinePrograms.map(programCard)
        ])
      ]) : null;

      const managedSection = embedded ? [
        el('h3', {}, say('动态挂载模块（仅本次运行）', 'Live hot-plugged modules (this run only)')),
        ...(dynamicPrograms.length ? dynamicPrograms.map(programCard) : [el('p', { class: 'field-help' }, say('当前没有本次运行临时热挂载的模块。可使用上方「热挂载模块」添加。', 'No hot-plugged modules in this run. Use "Hot-plug module" above to add.'))])
      ] : [
        el('h3', {}, say('受管模块', 'Managed modules')),
        ...(snapshot.programs.length ? snapshot.programs.map(programCard) : [el('p', { class: 'field-help' }, say('当前没有受管成员。', 'No managed members.'))])
      ];

      view.content.replaceChildren(...[
        embedded && changed.changed ? el('div', { class: 'notice notice-info dynamic-dirty-banner', 'data-dynamic-design-changed': '' }, [
          el('p', {}, say(`当前运行组合有声明变更：新增 ${changed.added.length}，移除 ${changed.removed.length}。启停状态不计为改装。`, `The live composition has declaration changes: ${changed.added.length} added, ${changed.removed.length} removed. Start/stop state is not a customization.`)),
          button(say('载入工作台并保存版本', 'Load in workbench and save a version'), () => ctx.openCreatorFromInstance(instanceId), 'button button-small button-primary'),
          button(say('恢复已保存组合…', 'Restore saved composition…'), restoreSavedRun, 'button button-quiet')
        ]) : null,
        embedded && !changed.known ? el('p', { class: 'field-help' }, say('尚未获得可核验的当前已保存声明，无法判断组合是否有改装。', 'The current saved declarations could not be checked; customization status is unknown.')) : null,
        headerPanel,
        snapshot.external.length ? el('p', { class: 'field-help' }, say('保存到工作台时只收集受管源码，不包含外部程序源码或接入凭据。若受管成员仍依赖外部提供者，请先调整接线后再导出独立整合包。', 'The workbench collects managed source only, excluding external source and connection credentials. If managed members still depend on external providers, rewire them before exporting a self-contained pack.')) : null,
        ...managedSection,
        el('h3', {}, say('外部自运行程序', 'Externally run programs')),
        ...(snapshot.external.length ? snapshot.external.map(externalCard) : [el('p', { class: 'field-help' }, say('尚未授权外部程序接入。', 'No external programs authorized.'))]),
        embedded ? renderLivePermissionMatrix({ state, el }, snapshot) : null,
        embedded ? renderObservedExternalSessions({ state, el }, view.instance, snapshot) : null,
        policyPanel,
        embedded ? baselinePanel : null
      ].filter(Boolean));
      view.status.textContent = '';
    }

    view.reload = render;
    if (view.disposed) return view;
    try { await render(); } catch (issue) { report(issue); }
    return view;
  }

  function render(instance) {
    const id = instance?.instanceId ?? instance?.id, status = instance?.status ?? {};
    const key = JSON.stringify([status.runId ?? 'stopped', state.language, status.state, status.stoppedAt, status.executionProfile, status.sandbox, status.observation === 'stale' || Boolean(ctx.isStale?.(status))]);
    const observation = JSON.stringify([status.assembly?.revision, status.components?.map(row => [row.id, row.process, row.communication, row.readiness]), state.topology?.runId, state.topology?.observedAt]);
    const old = cachedViews.get(id);
    if (old?.key === key) { old.view.instance = instance; if (old.observation !== observation) { old.observation = observation; void old.view.reload?.().catch(issue => { old.view.status.textContent = issue.message; }); } return old.view.node; }
    if (old) { old.view.disposed = true; old.view.editors.dynamicDisposed = true; for (const secret of old.view.node.querySelectorAll('[data-dynamic-secret]')) secret.textContent = ''; old.view.editors.replaceChildren(); }
    const node = el('section', { class: 'dynamic-tab-wrap', 'data-dynamic-instance': id ?? '' }), content = el('div', { class: 'stack' }), editors = el('div', { class: 'dynamic-tab-editors' }), statusNode = el('p', { class: 'field-help', role: 'status' });
    node.append(content, editors, statusNode);
    const view = { node, content, editors, status: statusNode, instance };
    cachedViews.set(id, { key, observation, view });
    if (!id || status.state !== 'running' || status.stoppedAt) { content.append(el('div', { class: 'panel empty-dynamic-panel' }, [el('p', {}, say('实例当前未运行。启动后可在此热插拔模块、授权外部程序并查看动态权限。', 'Instance is not running. Start it to hot-plug modules, authorize external programs and inspect live permissions.'))])); return node; }
    if (status.executionProfile !== 'trusted-local' || status.sandbox === true || status.observation === 'stale' || ctx.isStale?.(status)) { content.append(el('p', { class: 'notice notice-warning' }, say('当前运行隔离模式或观测状态不支持动态管理。请刷新状态；隔离限制不会被绕过。', 'The current isolation profile or stale observation prevents dynamic management. Refresh status; isolation limits are not bypassed.'))); return node; }
    statusNode.textContent = say('正在读取当前运行组合…', 'Loading the current live composition…');
    void createView(instance, { embedded: true, suppliedView: view });
    return node;
  }
  async function refresh(instance) { const node = render(instance), cached = cachedViews.get(instance?.instanceId ?? instance?.id); await cached?.view.reload?.(); return node; }
  async function open(instance) { if (ctx.openDynamicTab) return ctx.openDynamicTab(typeof instance === 'string' ? instance : instance.instanceId ?? instance.id); return createView(instance); }
  function deactivate() {
    for (const { view } of cachedViews.values()) {
      view.disposed = true; view.editors.dynamicDisposed = true;
      for (const secret of view.node.querySelectorAll('[data-dynamic-secret]')) secret.textContent = '';
      view.editors.replaceChildren();
    }
    cachedViews.clear();
  }
  return { open, render, refresh, deactivate, reviewComponentAction };

}
