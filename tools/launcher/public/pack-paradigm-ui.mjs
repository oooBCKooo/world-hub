// A pack type selects deployment defaults. It never assigns business meaning
// to communication topics, contracts, or external programs.
export const packTypeOf = pack => pack?.packType ?? 'atomic';
export const lifecyclePolicyOf = pack => pack?.lifecyclePolicy ?? (packTypeOf(pack) === 'mesh' ? 'independent' : 'fail-fast');
export function presentedPack(instance, review, { stale = false } = {}) {
  const pack = { ...(review?.pack ?? {}), ...(instance?.pack ?? {}) };
  // Only a current run can override its source declaration. An ended run can
  // describe the previous version after an in-place composition save.
  if (!stale && instance?.status?.runId && !instance.status.stoppedAt && instance.status.observation !== 'stale') {
    Object.assign(pack, instance.status.pack ?? {});
    const policy = instance.status.assembly?.failurePolicy;
    if (policy !== undefined) pack.lifecyclePolicy = policy;
  }
  return pack;
}

export function createPackParadigmUi(ctx) {
  const { state, el, button } = ctx;
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const memberBusy = new Set();
  const field = (title, input) => ['radio','checkbox'].includes(input.type)
    ? el('label', {class:'pack-lifecycle-choice'}, [input, el('span', {}, title)])
    : el('label', {}, [el('span', {}, title), input]);

  function presetEditor(pack, onChange, { isGlobalHub = false } = {}) {
    const atomic = el('input', { type: 'radio', name: 'packType', value: 'atomic', checked: packTypeOf(pack) === 'atomic', 'aria-label': say('严格型预设 Atomic', 'Atomic preset') });
    const mesh = el('input', { type: 'radio', name: 'packType', value: 'mesh', checked: packTypeOf(pack) === 'mesh', 'aria-label': say('松弛型预设 Mesh', 'Mesh preset') });
    const policy = el('select', { name: 'lifecyclePolicy', 'aria-label': say('故障策略（可单独调整）', 'Failure policy (independently adjustable)') }, [
      el('option', { value: 'fail-fast' }, say('任一成员意外故障时停止整组', 'Stop the assembly on any unexpected member failure')),
      el('option', { value: 'independent' }, say('普通成员故障独立，关键成员故障停止整组', 'Isolate ordinary failures; stop the assembly on critical failures'))
    ]);
    policy.value = lifecyclePolicyOf(pack);

    const atomicSpan = el('span', {});
    const meshSpan = el('span', {});
    const policyBadge = el('span', { class: 'pill', style: 'font-size: 11px; padding: 2px 7px; margin-left: 8px;' });

    function updateDisplay() {
      const type = packTypeOf(pack);
      const policyVal = lifecyclePolicyOf(pack);
      const isAtomic = type === 'atomic';
      const isMesh = type === 'mesh';
      const defaultPolicy = isMesh ? 'independent' : 'fail-fast';
      const isOverridden = policyVal !== defaultPolicy;

      if (isAtomic && isOverridden) {
        atomicSpan.textContent = say(
          '严格型 Atomic · 计划内成员全部就绪（故障策略已覆盖：普通故障独立）',
          'Atomic · require all planned members ready (custom policy: isolate ordinary failures)'
        );
      } else {
        atomicSpan.textContent = say(
          '严格型 Atomic · 计划内成员全部就绪、意外故障整组停止',
          'Atomic · require all planned members ready; stop the group on failure'
        );
      }

      if (isMesh && isOverridden) {
        meshSpan.textContent = say(
          '松弛型 Mesh · 按启动计划运行（故障策略已覆盖：整组停止）',
          'Mesh · run the startup plan (custom policy: stop group on failure)'
        );
      } else {
        meshSpan.textContent = say(
          '松弛型 Mesh · 按启动计划运行、普通故障独立',
          'Mesh · run the startup plan; isolate ordinary failures'
        );
      }

      if (isOverridden) {
        policyBadge.textContent = say('已单独覆盖', 'Custom override');
        policyBadge.className = 'pill pill-amber';
      } else {
        policyBadge.textContent = say('预设默认', 'Preset default');
        policyBadge.className = 'pill pill-teal';
      }
    }

    updateDisplay();

    function choose(type) {
      atomic.checked = type === 'atomic';
      mesh.checked = type === 'mesh';
      pack.packType = type;
      pack.lifecyclePolicy = type === 'mesh' ? 'independent' : 'fail-fast';
      policy.value = pack.lifecyclePolicy;
      updateDisplay();
      onChange?.();
    }

    atomic.addEventListener('change', () => { if (atomic.checked) choose('atomic'); });
    mesh.addEventListener('change', () => { if (mesh.checked) choose('mesh'); });
    policy.addEventListener('change', () => {
      pack.lifecyclePolicy = policy.value;
      updateDisplay();
      onChange?.();
    });

    const globalHubBanner = isGlobalHub ? el('div', { class: 'notice notice-info', style: 'margin-bottom: 12px;' }, [
      el('strong', {}, say('🌐 全局 Hub 模式说明', '🌐 Local Global Hub Notice')),
      el('p', {}, say(
        '全局 Hub 的程序可以加入启动计划，按明确的前置关系启动，也可以各自启停。更新当前全局 Hub 组合可保存启动计划；以下整合包预设和关键成员声明仅在「另存为新组合…」导出时生效。',
        'Global Hub programs can join a startup plan with explicit prerequisites, or start and stop individually. Updating the local Hub composition can save that plan. The pack presets and critical-member declarations below apply when exporting via "Save as new composition…".'
      ))
    ]) : null;

    const legendChildren = [
      say('组合运行预设', 'Composition runtime preset'),
      isGlobalHub ? el('span', { class: 'pill pill-amber', style: 'font-size: 11px; padding: 2px 7px; margin-left: 8px;' }, say('仅另存为整合包生效', 'Applies to derived packs only')) : null
    ].filter(Boolean);

    return el('fieldset', { class: 'panel pack-paradigm-editor', 'aria-label': say('组合运行预设', 'Composition runtime preset') }, [
      el('legend', {}, legendChildren),
      globalHubBanner,
      el('div', { class: 'field-grid' }, [
        el('label', { class: 'pack-lifecycle-choice' }, [atomic, atomicSpan]),
        el('label', { class: 'pack-lifecycle-choice' }, [mesh, meshSpan])
      ]),
      el('p', { class: 'field-help' }, say('切换预设会选用它的默认故障策略，之后可单独调整。两种预设都保留动态装配、授权外部接入和独立控制能力。编辑只修改草稿。', 'Choosing a preset selects its default failure policy, which you can then adjust independently. Both presets retain dynamic assembly, authorized external admission and independent controls. These edits only change the draft.')),
      el('label', {}, [
        el('div', { style: 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;' }, [
          el('span', {}, say('故障策略（可单独调整）', 'Failure policy (independently adjustable)')),
          policyBadge
        ]),
        policy
      ]),
      el('p', { class: 'field-help' }, say('两种预设都只启动加入初始计划的成员；其他成员可稍后单独启动。启动前置与能力契约接线分别配置，前置不会被暗中加入计划。', 'Both presets start only members included in the initial plan. Other members can be started individually later. Startup prerequisites are separate from capability bindings and do not silently add members to the plan.'))
    ].filter(Boolean));
  }

  function flagsEditor(component, pack) {
    const autostart = el('input', { name: 'autostart', type: 'checkbox', checked: component.autostart !== false, 'aria-label': say('加入初始启动计划', 'Include in the initial startup plan') });
    const critical = el('input', { name: 'critical', type: 'checkbox', checked: component.critical === true, 'aria-label': say('独立故障策略下的关键成员', 'Critical member under independent failure policy') });
    const node = el('fieldset', { class: 'component-lifecycle-fields' }, [el('legend', {}, say('成员启动与故障声明', 'Member startup and failure declarations')),
      field(say('加入初始启动计划', 'Include in the initial startup plan'), autostart),
      field(say('独立故障策略下的关键成员', 'Critical member under independent failure policy'), critical),
      el('p', { class: 'field-help' }, say('未加入计划的成员保持停止，可稍后单独审阅启动。启动前置不会自动补启动；请先启动所需前置，再单独审阅启动受阻成员。Atomic 要求本次计划内成员全部就绪，Mesh 按所选故障策略处理。', 'Members outside the plan remain stopped and can be reviewed and started individually later. Prerequisites never start automatically: start them first, then separately review a blocked member’s start. Atomic requires all members of this plan to become ready; Mesh uses the selected failure policy.')),
      el('p', { class: 'field-help' }, say('关键成员在 independent 策略下意外故障仍停止整组；用户主动停止不算意外故障。', 'Under independent policy, an unexpected critical-member failure still stops the group. An intentional stop is not an unexpected failure.'))
    ]);
    return { node, read: () => ({
      ...(Object.hasOwn(component, 'autostart') || Boolean(autostart.checked) !== (component.autostart !== false) ? { autostart: Boolean(autostart.checked) } : {}),
      ...(Object.hasOwn(component, 'critical') || Boolean(critical.checked) !== (component.critical === true) ? { critical: Boolean(critical.checked) } : {})
    }) };
  }

  function badge(pack) {
    return el('span', { class: `pill${packTypeOf(pack) === 'mesh' ? ' pill-teal' : ''} pack-paradigm-badge`, 'data-pack-type': packTypeOf(pack) }, packTypeOf(pack) === 'mesh' ? say('松弛型预设 · Mesh', 'Mesh preset') : say('严格型预设 · Atomic', 'Atomic preset'));
  }
  function prerequisitesEditor(component, components = []) {
    const id = component.id ?? component.componentId;
    const selected = new Set(component.after ?? []);
    const candidates = components.filter(other => (other.id ?? other.componentId) !== id);
    // Keep an unresolved declaration visible. Removing a prerequisite is always
    // an explicit user choice, including when its source member was removed.
    const ids = [...new Set([...candidates.map(other => other.id ?? other.componentId), ...selected])];
    const fields = ids.map(prerequisite => {
      const other = candidates.find(row => (row.id ?? row.componentId) === prerequisite);
      const input = el('input', { type: 'checkbox', name: `startupAfter:${prerequisite}`, checked: selected.has(prerequisite), 'aria-label': `${say('等待', 'Wait for')} ${prerequisite}` });
      return { id: prerequisite, input, node: field(`${prerequisite}${other ? '' : say('（成员已不在组合中）', ' (member no longer in composition)')}`, input) };
    });
    const node = el('fieldset', { class: 'startup-prerequisites component-lifecycle-fields' }, [
      el('legend', {}, say('启动前置', 'Startup prerequisites')),
      el('p', { class: 'field-help' }, say('在所选模块就绪后启动此模块。这里配置启动先后；能力接线另行配置，不会自动添加启动前置或启动计划外模块。', 'Start this member after the selected members are ready. This configures launch order separately from capability wiring. It never adds prerequisites implicitly or starts members outside the plan.')),
      fields.length ? el('div', { class: 'startup-prerequisite-choices' }, fields.map(row => row.node)) : el('p', { class: 'field-help' }, say('暂无其他模块，可直接启动。', 'No other members; this member can start directly.'))
    ]);
    return { node, read: () => fields.filter(row => row.input.checked).map(row => row.id) };
  }
  function memberFlags(component, pack) {
    if(component.ownership==='external'||component.process==='unmanaged')return [el('span',{class:'pill'},say('外部自管生命周期','Externally managed lifecycle'))];
    const nodes = [];
    if (component.autostart === false) nodes.push(el('span', { class: 'pill pill-amber' }, say('计划外 · 手动启动', 'Outside initial plan · Manual start')));
    if (component.critical === true) nodes.push(el('span', { class: 'pill' }, say('关键成员', 'Critical member')));
    const blocked = component.blockedBy;
    if (Array.isArray(blocked) && blocked.length || typeof blocked === 'string' && blocked) nodes.push(el('span', { class: 'pill pill-amber', title: say('先启动所需前置，再单独审阅启动此成员；前置就绪不会自动补启动。', 'Start the prerequisites, then separately review this member’s start. Ready prerequisites do not trigger an automatic start.') }, `${say('等待启动前置', 'Waiting for prerequisites')}: ${Array.isArray(blocked) ? blocked.join(', ') : blocked}`));
    return nodes;
  }

  function memberActions(instance, component, pack, { stale = false, busy = false } = {}) {
    const instanceId = instance.instanceId ?? instance.id, componentId = component.id ?? component.componentId;
    const key = JSON.stringify([instanceId, instance.status?.runId, componentId]);
    const nodes = [], status = instance.status ?? {}, external = component.ownership === 'external' || component.process === 'unmanaged';
    const permitted = !external && !stale && !status.stoppedAt && status.state === 'running'
      && status.executionProfile === 'trusted-local' && status.sandbox !== true;
    const active = ['running', 'starting', 'stopping'].includes(component.process);
    if (!external) {
      const action = active ? 'stop' : 'start';
      const possible = active ? ['running', 'starting'].includes(component.process) : ['stopped', 'failed', 'blocked', 'exited'].includes(component.process) && !component.cleanupIncomplete && !status.cleanupIncomplete;
      const title = action === 'stop' ? say('停止', 'Stop') : say('审阅启动', 'Review start');
      const control = button(title, async () => {
        if (!permitted || busy || !possible || memberBusy.has(key)) return;
        memberBusy.add(key); control.disabled = true; control.setAttribute('aria-busy', 'true');
        try { await ctx.reviewComponentAction(instance, componentId, action); }
        finally { memberBusy.delete(key); control.setAttribute('aria-busy', 'false'); control.disabled = !permitted || busy || !possible; }
      }, 'button button-small button-quiet', !permitted || busy || !possible || memberBusy.has(key));
      control.setAttribute('data-component-action', action); control.setAttribute('data-component-id', componentId);
      control.disabled = !permitted || busy || !possible || memberBusy.has(key);
      if (!permitted) control.setAttribute('title', say('需要当前可信本机运行及新鲜状态；外部进程由其所有者控制。', 'Requires a current trusted local run and fresh observation; external processes remain owner-managed.'));
      nodes.push(control);
    }
    nodes.push(button(say('日志', 'Logs'), () => ctx.openLogs(componentId), 'button button-small button-quiet'));
    return nodes;
  }
  return { presetEditor, flagsEditor, prerequisitesEditor, badge, memberFlags, memberActions };
}
