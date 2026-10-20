// Shared draft-only startup editor for standalone packs and the local Hub.
// Capability bindings are deliberately absent: only explicit after declarations order starts.
export function resolveDraftStartupOrder(components, startupOrder) {
  const ids = components.map(row => row.id), known = new Set(ids);
  if (known.size !== ids.length || ids.some(id => !id)) throw new Error('STARTUP_ORDER_INVALID: duplicate or missing module ID');
  for (const component of components) {
    const after = component.after ?? [];
    if (!Array.isArray(after) || new Set(after).size !== after.length || after.some(id => id === component.id || !known.has(id))) throw new Error(`STARTUP_ORDER_INVALID: ${component.id} has an unknown, repeated or self prerequisite`);
  }
  if (startupOrder !== undefined) {
    if (!Array.isArray(startupOrder) || startupOrder.length !== ids.length || new Set(startupOrder).size !== ids.length || startupOrder.some(id => !known.has(id))) throw new Error('STARTUP_ORDER_INVALID: order must include every current module exactly once');
    const index = new Map(startupOrder.map((id, i) => [id, i]));
    for (const component of components) for (const id of component.after ?? []) if (index.get(id) >= index.get(component.id)) throw new Error(`STARTUP_ORDER_INVALID: ${component.id} must follow ${id}`);
    return [...startupOrder];
  }
  const order = [], visiting = new Set(), visited = new Set(), byId = new Map(components.map(row => [row.id, row]));
  const visit = row => {
    if (visiting.has(row.id)) throw new Error('STARTUP_ORDER_INVALID: prerequisite cycle');
    if (visited.has(row.id)) return;
    visiting.add(row.id);
    for (const id of row.after ?? []) visit(byId.get(id));
    visiting.delete(row.id); visited.add(row.id); order.push(row.id);
  };
  for (const row of components) visit(row);
  return order;
}

export function createStartupPlanEditor({ state, el, button, pack, savedPack, onChange, globalPlan, savedGlobalPlan, paradigms }) {
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const root = el('section', { class: 'startup-plan-editor stack', 'data-startup-plan-editor': '' });
  let message = '', failed = false;
  function commit(change) {
    const candidate = structuredClone(pack);
    try {
      change(candidate);
      resolveDraftStartupOrder(candidate.components, candidate.startupOrder);
      pack.components = candidate.components;
      if (candidate.startupOrder === undefined) delete pack.startupOrder; else pack.startupOrder = candidate.startupOrder;
      for (const key of ['packType', 'lifecyclePolicy']) { if (Object.hasOwn(candidate, key)) pack[key] = candidate[key]; else delete pack[key]; }
      message = say('已修改工作台草稿；保存当前组合并审阅后才会应用。', 'Workbench draft changed. Save and review the current composition to apply it.'); failed = false;
      onChange?.(); render();
    } catch (error) {
      message = `${say('不能应用此调整；原顺序保持不变。请先调整启动前置。', 'This change cannot be applied; the previous order is retained. Adjust prerequisites first.')} ${error.message}`;
      failed = true; render();
    }
  }
  function move(id, target) {
    commit(candidate => { const order = resolveDraftStartupOrder(candidate.components, candidate.startupOrder), index = order.indexOf(id); order.splice(index, 1); order.splice(target, 0, id); candidate.startupOrder = order; });
  }
  function reset() {
    let removed = [], kept = [];
    commit(candidate => {
      const currentIds = new Set(candidate.components.map(row => row.id));
      const saved = new Map((savedPack?.components ?? []).map(row => [row.id, row]));
      for (const component of candidate.components) {
        const baseline = saved.get(component.id);
        if (!baseline) { kept.push(component.id); continue; }
        if (Object.hasOwn(baseline, 'autostart')) component.autostart = baseline.autostart; else delete component.autostart;
        if (!globalPlan) { if (Object.hasOwn(baseline, 'critical')) component.critical = baseline.critical; else delete component.critical; }
        removed.push(...(baseline.after ?? []).filter(id => !currentIds.has(id)).map(id => `${component.id} → ${id}`));
        component.after = (baseline.after ?? []).filter(id => currentIds.has(id));
      }
      const preference = [...(savedPack?.startupOrder ?? (savedPack?.components ?? []).map(row => row.id)).filter(id => currentIds.has(id)), ...candidate.components.filter(row => !saved.has(row.id)).map(row => row.id)];
      // Removed/added draft members can change the graph. Restore the saved relative
      // preference with a stable topological pass, without resurrecting a member.
      const preferred = preference.map(id => candidate.components.find(row => row.id === id));
      candidate.startupOrder = resolveDraftStartupOrder(preferred);
      if (!globalPlan) for (const key of ['packType', 'lifecyclePolicy']) { if (Object.hasOwn(savedPack ?? {}, key)) candidate[key] = savedPack[key]; else delete candidate[key]; }
    });
    if (failed) return;
    if (globalPlan) globalPlan.onFailure = savedGlobalPlan?.onFailure ?? 'continue-independent';
    message = say('已恢复当前已保存版本的启动计划，仅修改草稿。', 'Restored the startup plan of the current saved version in the draft only.');
    if (kept.length) message += ` ${say('草稿新增模块保留原启动声明', 'New draft members retain their current declarations')}: ${kept.join(', ')}.`;
    if (removed.length) message += ` ${say('已移除的模块不会恢复；这些前置已排除', 'Removed modules were not restored; these prerequisites were excluded')}: ${removed.join(', ')}.`;
    onChange?.(); render();
  }
  function render() {
    let order;
    try { order = resolveDraftStartupOrder(pack.components, pack.startupOrder); }
    catch (error) { order = pack.components.map(row => row.id); message = error.message; failed = true; }
    const selected = order.filter(id => pack.components.find(row => row.id === id).autostart !== false);
    const orderPreview = el('div', { class: 'review-order', 'data-startup-selected-order': '' }, selected.length ? selected.flatMap((id, i) => [i ? el('span', { 'aria-hidden': 'true' }, '→') : null, el('span', { class: 'order-step-chip mono' }, `${i + 1}. ${id}`)]).filter(Boolean) : say('仅启动 Hub；暂无初始启动成员', 'Hub only; no initial members selected'));
    const rows = order.map((id, index) => {
      const component = pack.components.find(row => row.id === id);
      const enabled = el('input', { type: 'checkbox', name: `startupMember:${id}`, checked: component.autostart !== false, 'aria-label': `${say('加入初始启动计划', 'Include in initial startup plan')}: ${id}` });
      enabled.addEventListener('change', () => commit(candidate => { candidate.components.find(row => row.id === id).autostart = enabled.checked; }));
      const position = el('select', { name: `startupPosition:${id}`, 'aria-label': `${say('执行位置', 'Execution position')}: ${id}` }, order.map((other, i) => el('option', { value: String(i) }, `${i + 1} · ${other}`)));
      position.value = String(index); position.addEventListener('change', () => move(id, Number(position.value)));
      const after = el('details', { class: 'startup-plan-prereqs-details' }, [el('summary', {}, `${say('启动前置', 'Startup prerequisites')}: ${(component.after ?? []).join(', ') || say('无', 'None')}`), el('div', { class: 'startup-prerequisite-choices' }, order.filter(other => other !== id).map(other => {
        const check = el('input', { type: 'checkbox', name: `startupAfter:${id}:${other}`, checked: component.after?.includes(other), 'aria-label': `${id} ${say('等待', 'waits for')} ${other}` });
        check.addEventListener('change', () => commit(candidate => { const row = candidate.components.find(item => item.id === id); row.after = check.checked ? [...(row.after ?? []), other] : (row.after ?? []).filter(value => value !== other); }));
        return el('label', { class: 'pack-lifecycle-choice' }, [check, el('span', {}, other)]);
      }))]);
      let critical;
      if (!globalPlan) {
        const check = el('input', { type: 'checkbox', name: `startupCritical:${id}`, checked: component.critical === true, 'aria-label': `${say('关键成员', 'Critical member')}: ${id}` });
        check.addEventListener('change', () => commit(candidate => { candidate.components.find(row => row.id === id).critical = check.checked; }));
        critical = el('label', { class: 'pack-lifecycle-choice' }, [check, el('span', {}, say('关键成员（独立策略下意外故障停止整组）', 'Critical member (unexpected failure stops the group under independent policy)'))]);
      }
      return el('article', { class: 'panel startup-plan-member startup-plan-editor-row', 'data-component-id': id }, [
        el('label', { class: 'pack-lifecycle-choice startup-plan-editor-member' }, [enabled, el('strong', { class: 'mono' }, id), el('span', { class: 'pill' }, component.autostart === false ? say('计划外 · 手动启动', 'Outside plan · Manual start') : say('初始启动', 'Initial start'))]),
        el('div', { class: 'startup-plan-position-actions' }, [el('span', { class: 'startup-plan-position-number' }, `#${index + 1}`), position, button(say('上移', 'Move up'), () => move(id, index - 1), 'button button-small button-quiet', index === 0), button(say('下移', 'Move down'), () => move(id, index + 1), 'button button-small button-quiet', index === order.length - 1)]), critical, after
      ].filter(Boolean));
    });
    let failurePolicy;
    if (globalPlan) {
      const select = el('select', { name: 'startupPlanOnFailure', 'aria-label': say('计划失败处理', 'Plan failure handling') }, [el('option', { value: 'continue-independent' }, say('继续互不依赖的成员', 'Continue independent members')), el('option', { value: 'stop-plan' }, say('停止后续启动，保留已完成成员', 'Stop subsequent starts; retain completed members'))]);
      select.value = globalPlan.onFailure ?? 'continue-independent'; select.addEventListener('change', () => { globalPlan.onFailure = select.value; onChange?.(); });
      failurePolicy = el('label', {}, [el('span', {}, say('计划失败处理', 'Plan failure handling')), select]);
    }
    root.replaceChildren(el('div', { class: 'startup-plan-editor-heading' }, [el('div', {}, [el('h3', {}, say('初始启动计划与执行顺序', 'Initial startup plan and execution order')), el('p', { class: 'field-help' }, say('勾选初始启动成员，用上移、下移或位置选择精确排序。前置必须排在成员之前；计划外前置须已就绪，不会自动启动。能力接线不决定启动顺序。', 'Select initial members and set exact positions using Move up, Move down, or the position selector. Prerequisites must precede their members. Prerequisites outside the plan must already be ready and are never started implicitly. Capability wiring does not set launch order.'))]), button(say('恢复默认', 'Restore defaults'), reset, 'button button-quiet')]),
      el('p', { class: 'field-help' }, say('恢复默认以当前已保存版本为准，保留草稿新增模块及其声明；不恢复最初来源，也不修改参数、源码或接线。编辑后请使用上方“保存”或“另存”。', 'Defaults come from the current saved version. Newly added draft members and their declarations are retained. Settings, source and wiring are unchanged. Use Save or Save as above to apply draft changes.')),
      el('div', { class: 'panel' }, [el('strong', {}, say('实际所选执行顺序', 'Selected execution order')), orderPreview]),
      ...(failurePolicy ? [failurePolicy] : paradigms ? [paradigms.presetEditor(pack, () => { onChange?.(); render(); })] : []), ...rows,
      el('p', { class: `field-help${failed ? ' notice notice-error' : ''}`, role: 'status', 'data-startup-editor-status': '' }, message));
  }
  render(); return root;
}
