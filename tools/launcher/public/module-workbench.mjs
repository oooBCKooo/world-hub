// Configuration belongs to a particular installed program. Groups only reference it.
const copy = value => JSON.parse(JSON.stringify(value));

export function configurationInput(program, draft) {
  return { expectedRevision: program.configurationRevision, settings: draft.settings, topics: draft.topics, bridges: draft.bridges, bindings: draft.bindings,
    ...(draft.directory?.trim() ? { directory: draft.directory.trim() } : {}) };
}

export function movePlanMember(plan, id, position) {
  const ids = plan.startupOrder ?? plan.members.map(row => row.programId), at = ids.indexOf(id);
  if (at < 0 || !Number.isInteger(position) || position < 0 || position >= ids.length) return copy(plan);
  const order = [...ids]; order.splice(at, 1); order.splice(position, 0, id);
  return { ...copy(plan), startupOrder: order };
}

function topoSortOrder(order, members) {
  const inDegree = new Map(order.map(id => [id, 0]));
  const graph = new Map(order.map(id => [id, []]));
  const memberMap = new Map(members.map(m => [m.programId, m]));

  for (const id of order) {
    const member = memberMap.get(id);
    for (const prereq of member?.after ?? []) {
      if (graph.has(prereq) && prereq !== id) {
        graph.get(prereq).push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }

  const queue = order.filter(id => (inDegree.get(id) ?? 0) === 0);
  const sorted = [];

  while (queue.length) {
    const current = queue.shift();
    sorted.push(current);
    for (const neighbor of graph.get(current) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  for (const id of order) {
    if (!sorted.includes(id)) sorted.push(id);
  }
  return sorted;
}

export function createModuleWorkbench(ctx) {
  const { state, api, el, button, review, run, refresh } = ctx;
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  let root, mode = 'configuration', selected = null, draft, base, dirty = false, generation = 0;
  const field = (label, control) => el('label', {}, [el('span', {}, label), control]);
  const jsonEditor = (name, value) => { const node = el('textarea', { name, rows: '7', spellcheck: 'false', class: 'sh-json-editor', 'aria-label': name }); node.value = JSON.stringify(value, null, 2); node.addEventListener('input', () => { dirty = true; }); return node; };
  const message = text => el('p', { class: 'field-help' }, text);

  function choose(kind, id) { mode = kind; selected = id ?? null; draft = null; base = null; dirty = false; generation++; return render(); }
  function chooseSafely(kind, id) {
    if (!dirty) return choose(kind, id);
    ctx.confirm({ title: say('放弃未保存的修改？', 'Discard unsaved changes?'), message: say('切换编辑对象会放弃当前草稿。', 'Switching the editor discards the current draft.'), action: () => choose(kind, id) });
  }

  function configuration() {
    const programs = state.programs ?? [];
    if (!programs.length) return [message(say('先从模块库登记一个实例。', 'Register an instance from Module Library first.'))];
    if (!programs.some(row => row.programId === selected)) { selected = programs[0].programId; draft = null; }
    const program = programs.find(row => row.programId === selected);
    if (!draft) { base = copy(program); draft = copy({ settings: program.settings, topics: program.topics, bridges: program.bridges, bindings: program.bindings }); }

    const selector = el('select', { 'aria-label': say('编辑模块实例', 'Edit module instance') }, programs.map(row => el('option', { value: row.programId }, `${ctx.title(row)} · ${row.programId} (${row.state === 'running' ? say('运行中', 'running') : say('已停止', 'stopped')})`)));
    selector.value = selected;
    selector.addEventListener('change', () => { const id = selector.value; selector.value = selected; chooseSafely('configuration', id); });

    const editors = Object.fromEntries(['settings', 'topics', 'bridges', 'bindings'].map(key => [key, jsonEditor(key, draft[key])]));
    for (const [key, editor] of Object.entries(editors)) editor.addEventListener('input', () => { draft[key] = editor.value; });
    for (const [key, editor] of Object.entries(editors)) if (typeof draft[key] === 'string') editor.value = draft[key];
    const parse = key => typeof draft[key] === 'string' ? JSON.parse(draft[key]) : copy(draft[key]);
    const sync = (key, value) => { draft[key] = value; editors[key].value = JSON.stringify(value, null, 2); dirty = true; };

    const simple = el('div', { class: 'sh-simple-config' });
    try {
      const settings = parse('settings'), topics = parse('topics'), bridges = parse('bridges'), bindings = parse('bindings');

      // --- Section 1: Settings ---
      const parameters = Object.entries(settings).map(([key, value]) => {
        if (value !== null && typeof value === 'object') return message(`${key}: ${say('请在高级配置编辑此结构', 'Edit this structure in Advanced configuration')}`);
        const isBool = typeof value === 'boolean', isNum = typeof value === 'number';
        const node = el('input', { name: `setting-${key}`, type: isBool ? 'checkbox' : isNum ? 'number' : 'text' });
        if (isBool) node.checked = value; else node.value = value ?? '';
        node.addEventListener(isBool ? 'change' : 'input', () => { settings[key] = isBool ? node.checked : isNum ? Number(node.value) : node.value; sync('settings', settings); });
        return isBool
          ? el('label', { class: 'sh-check' }, [node, el('span', {}, key)])
          : field(key, node);
      });
      simple.append(
        el('div', { class: 'sh-section-card panel' }, [
          el('h3', {}, say('模块公开参数', 'Module settings')),
          message(say('模块在 module.json 中声明的配置项，按实例独立生效。', 'Public settings declared in module.json, applied per instance.')),
          parameters.length ? el('div', { class: 'sh-editor-grid' }, parameters) : el('div', { class: 'notice notice-info' }, say('此实例没有公开参数，使用默认即可。', 'This instance has no custom public settings.'))
        ])
      );

      // --- Section 2: Topic Wiring ---
      const knownAddresses = [...new Set(state.programs.flatMap(p => Object.values(p.topics ?? {})))].filter(Boolean);
      const aliasInput = el('input', { name: 'newTopicAlias', placeholder: say('通道别名（内部代码引用名）', 'New topic alias'), 'aria-label': say('新的通道别名', 'New topic alias') });
      const addressInput = el('input', { name: 'newTopicAddress', placeholder: say('具体总线通道地址（如 sample/text/read）', 'Concrete topic address'), 'aria-label': say('具体通道地址', 'Concrete topic address') });

      const suggestionPills = knownAddresses.length ? el('div', { class: 'sh-topic-suggestions' }, [
        el('span', { class: 'field-help' }, say('💡 快速填入已有通道:', '💡 Fill known topic:')),
        ...knownAddresses.map(addr => button(addr, () => { addressInput.value = addr; }, 'clickable-pill'))
      ]) : null;

      const topicRows = Object.entries(topics).map(([alias, value]) => {
        const node = el('input', { name: `topic-${alias}` }); node.value = value;
        node.addEventListener('input', () => { topics[alias] = node.value; sync('topics', topics); });
        return el('div', { class: 'sh-topic-row' }, [
          field(alias, node),
          button(say('移除别名', 'Remove alias'), () => {
            delete topics[alias];
            for (const rules of Object.values(bridges)) for (const direction of ['publish', 'subscribe']) rules[direction] = rules[direction].filter(v => v !== alias);
            sync('topics', topics); sync('bridges', bridges); render();
          }, 'button button-quiet')
        ]);
      });

      simple.append(
        el('div', { class: 'sh-section-card panel' }, [
          el('h3', {}, say('通道接线', 'Topic wiring')),
          message(say('相互通信的实例填写相同的具体通道地址。模块代码按“别名”引用，World Hub 按“具体地址”流转。', 'Communicating instances use the same concrete topic address. Code refers to aliases; World Hub routes concrete addresses.')),
          suggestionPills,
          topicRows.length ? el('div', { class: 'sh-topic-list' }, topicRows) : el('div', { class: 'notice notice-info' }, say('当前暂无通道接线。', 'No wired topics currently.')),
          el('div', { class: 'sh-topic-add' }, [
            aliasInput,
            addressInput,
            button(say('增加通道', 'Add topic'), () => {
              const key = aliasInput.value.trim();
              if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key) || Object.hasOwn(topics, key) || !addressInput.value.trim()) {
                ctx.error(new Error(say('输入不同的有效别名和具体地址。', 'Enter a distinct valid alias and a concrete address.')));
                return;
              }
              topics[key] = addressInput.value.trim();
              sync('topics', topics);
              render();
            }, 'button button-primary')
          ])
        ].filter(Boolean))
      );

      // --- Section 3: Bridge Permissions ---
      const bridgeSlots = Object.entries(bridges).map(([slot, rules]) => {
        const aliases = Object.keys(topics);
        return el('fieldset', { class: 'sh-bridge-fields' }, [
          el('legend', {}, slot),
          el('div', { class: 'sh-bridge-columns' }, ['publish', 'subscribe'].map(direction => {
            const isPub = direction === 'publish';
            return el('div', { class: 'sh-bridge-col' }, [
              el('div', { class: 'sh-bridge-col-header' }, [
                el('strong', {}, isPub ? say('允许发送 (Publish)', 'Allow publish') : say('允许抽取 (Subscribe)', 'Allow subscribe')),
                el('div', { class: 'result-actions' }, [
                  button(say('全选', 'All'), () => { rules[direction] = [...aliases]; sync('bridges', bridges); render(); }, 'button button-quiet'),
                  button(say('清空', 'Clear'), () => { rules[direction] = []; sync('bridges', bridges); render(); }, 'button button-quiet')
                ])
              ]),
              aliases.length ? el('div', { class: 'sh-bridge-options' }, aliases.map(alias => {
                const check = el('input', { type: 'checkbox', checked: rules[direction].includes(alias), 'aria-label': `${slot} ${direction} ${alias}` });
                check.addEventListener('change', () => {
                  rules[direction] = check.checked ? [...new Set([...rules[direction], alias])] : rules[direction].filter(v => v !== alias);
                  sync('bridges', bridges);
                });
                return el('label', { class: 'sh-check' }, [check, el('span', {}, alias)]);
              })) : message(say('无通道别名可授权', 'No aliases to authorize'))
            ]);
          }))
        ]);
      });

      simple.append(
        el('div', { class: 'sh-section-card panel' }, [
          el('h3', {}, say('枢纽桥通信权限', 'Hub bridge permissions')),
          message(say('声明插槽是否允许向世界枢纽发送或抽取具体别名的消息，保障进程隔离安全。', 'Declare publish and subscribe permissions per slot for secure process isolation.')),
          ...bridgeSlots
        ])
      );

      // --- Section 4: Capability Providers ---
      const required = program.requires ?? program.manifest?.requires ?? [];
      if (required.length) {
        simple.append(
          el('div', { class: 'sh-section-card panel' }, [
            el('h3', {}, say('能力提供者绑定', 'Capability providers')),
            message(say('本模块声明了协议依赖，请选择当前工作区提供该协议的具体模块实例。', 'This module declares contracts; select providing instances in this workspace.')),
            ...required.map(contract => {
              const providers = programs.filter(row => row.programId !== program.programId && (row.provides ?? []).some(v => v.id === contract.id && v.version === contract.version));
              const select = el('select', { 'aria-label': `${contract.id}@${contract.version}` }, [
                el('option', { value: '' }, say('— 选择提供者实例 —', '— Choose provider instance —')),
                ...providers.map(row => el('option', { value: row.programId }, `${ctx.title(row)} · ${row.programId} (${row.state === 'running' ? say('运行中', 'running') : say('已停止', 'stopped')})`))
              ]);
              select.value = bindings.find(row => row.contract.id === contract.id && row.contract.version === contract.version)?.providerId ?? '';
              select.addEventListener('change', () => {
                const next = parse('bindings').filter(row => row.contract.id !== contract.id || row.contract.version !== contract.version);
                if (select.value) next.push({ providerId: select.value, contract });
                sync('bindings', next);
              });
              return field(`${contract.id}@${contract.version}`, select);
            })
          ])
        );
      }
    } catch {
      simple.append(message(say('高级 JSON 草稿尚未有效，修正后点击“更新表单”。', 'The advanced JSON draft is invalid. Correct it and select “Update form”.')));
    }

    const source = el('input', { name: 'moduleDirectory', 'data-path-purpose': 'module', placeholder: say('保留当前模块源码', 'Keep the current module source') });
    source.value = draft.directory ?? '';
    source.addEventListener('input', () => { dirty = true; draft.directory = source.value; });

    const actions = el('div', { class: 'result-actions' }, [
      button(say('恢复已保存配置', 'Restore saved configuration'), () => { draft = null; dirty = false; render(); }, 'button button-quiet'),
      button(say('审阅并保存本实例', 'Review and save this instance'), () => run(async () => {
        const parsed = Object.fromEntries(Object.entries(editors).map(([key, node]) => [key, JSON.parse(node.value)]));
        const capture = generation, target = base.programId, result = await api(`/api/programs/${encodeURIComponent(target)}/configuration/preview`, configurationInput(base, { ...parsed, directory: source.value }));
        if (capture !== generation) return;
        review({
          title: say('审阅模块配置变更', 'Review module configuration'),
          data: result.review,
          message: say('核对本实例、共享组与消费者的影响。本实例需先停止；保存保留身份与状态，不停止其他实例。运行中的提供者与消费者仍保留原配置，按应用需要另行重启。', 'Check this instance and affected groups and consumers. Stop this instance first. Saving preserves identity and state without stopping other instances. Running peers keep their previous configuration; restart them separately if their application requires it.'),
          apply: async () => {
            await api(`/api/programs/${encodeURIComponent(target)}/configuration/apply`, { reviewId: result.reviewId, accepted: true });
            dirty = false; draft = null; await refresh(); render();
          }
        });
      }), 'button button-primary', program.state !== 'stopped')
    ]);

    return [
      el('section', { class: 'panel' }, [
        el('h2', {}, say('实例参数与接线', 'Instance configuration and wiring')),
        field(say('模块实例', 'Module instance'), selector),
        message(`${base.module.id}@${base.module.version} · ${say('配置修订', 'Configuration revision')}: ${base.configurationRevision ?? '—'}`),
        message(say('每个模块自己定义参数和通道。模块组引用同一实例时，共享这里的配置。', 'Each module defines its parameters and topics. Groups referencing this instance share this configuration.')),
        ...(program.state !== 'stopped' ? [el('div', { class: 'notice notice-warning' }, [
          message(say('先停止这个实例，其他模块可以继续运行。', 'Stop this instance first. Other modules can keep running.')),
          button(say('停止本实例…', 'Stop this instance…'), () => ctx.stopProgram(program), 'button button-quiet')
        ])] : []),
        simple,
        el('details', {}, [
          el('summary', {}, say('高级配置 (JSON)', 'Advanced configuration (JSON)')),
          el('div', { class: 'sh-editor-grid' }, [
            field(say('公开参数 (JSON)', 'Public settings (JSON)'), editors.settings),
            field(say('通道别名 → 地址 (JSON)', 'Topic aliases → addresses (JSON)'), editors.topics),
            field(say('枢纽桥发送 / 抽取权限 (JSON)', 'Bridge publish / subscribe permissions (JSON)'), editors.bridges),
            field(say('能力提供者绑定 (JSON)', 'Capability provider bindings (JSON)'), editors.bindings)
          ]),
          button(say('更新表单', 'Update form'), () => { try { for (const [key, editor] of Object.entries(editors)) draft[key] = JSON.parse(editor.value); render(); } catch (error) { ctx.error(error); } }, 'button button-quiet')
        ]),
        el('details', {}, [
          el('summary', {}, say('更换本实例的模块版本', 'Replace this instance’s module version')),
          message(say('选择新版本模块目录，仍保留本实例标识与状态。源码与解释器会重新审阅。', 'Select a new module directory while retaining this instance ID and state. Source and runtime are reviewed again.')),
          field(say('模块来源目录', 'Module source directory'), source)
        ]),
        actions
      ])
    ];
  }

  function planEditor(plan, programs, changed) {
    const order = [...(plan.startupOrder ?? plan.members.map(row => row.programId))], rows = el('div', { class: 'sh-plan-rows' });

    function draw() {
      rows.replaceChildren(...order.map((id, index) => {
        const member = plan.members.find(row => row.programId === id), program = programs.find(row => row.programId === id);
        const peers = order.filter(other => other !== id);

        const enabled = el('input', { type: 'checkbox', checked: member.enabled, 'aria-label': `${say('随计划启动', 'Start with plan')} ${id}` });
        enabled.addEventListener('change', () => { member.enabled = enabled.checked; changed(); draw(); });

        const after = el('select', { multiple: true, 'aria-label': `${say('前置模块', 'Prerequisites')} ${id}` }, peers.map(other => el('option', { value: other, selected: member.after.includes(other) }, other)));
        after.addEventListener('change', () => { member.after = [...after.selectedOptions].map(option => option.value); changed(); draw(); });

        // Companion interactive chips for 1-click toggling without Ctrl key
        const prereqChips = peers.map(other => {
          const isPrereq = member.after.includes(other);
          const peerProg = programs.find(p => p.programId === other);
          const peerLabel = ctx.title(peerProg ?? { programId: other });
          const chip = button([
            isPrereq ? '✓ ' : '+ ',
            peerLabel,
            isPrereq ? el('span', { class: 'sh-chip-x' }, ' ×') : null
          ].filter(Boolean), () => {
            if (isPrereq) member.after = member.after.filter(x => x !== other);
            else member.after = [...new Set([...member.after, other])];
            for (const opt of after.options) opt.selected = member.after.includes(opt.value);
            changed(); draw();
          }, `sh-prereq-chip${isPrereq ? ' is-selected' : ''}`);
          return chip;
        });

        // Sequence warnings
        const invalidOrder = member.after.filter(other => order.indexOf(other) > index);
        const disabledPrereqs = member.after.filter(other => !plan.members.find(m => m.programId === other)?.enabled);

        const position = el('input', { type: 'number', min: '1', max: String(order.length), value: String(index + 1), 'aria-label': `${say('执行位置', 'Position')} ${id}` });
        const move = target => { if (target < 0 || target >= order.length) return; order.splice(index, 1); order.splice(target, 0, id); plan.startupOrder = [...order]; changed(); draw(); };
        position.addEventListener('change', () => { const at = Number(position.value) - 1; if (Number.isInteger(at) && at >= 0 && at < order.length) move(at); else position.value = String(index + 1); });

        const stepBadge = el('div', { class: 'sh-plan-step-num' }, `#${index + 1}`);

        return el('article', { class: `sh-plan-row${member.enabled ? '' : ' is-disabled'}` }, [
          stepBadge,
          el('div', { class: 'sh-plan-member-main' }, [
            el('label', { class: 'sh-check' }, [
              enabled,
              el('span', {}, [
                el('strong', {}, ctx.title(program ?? { programId: id })),
                el('small', { class: 'mono' }, id)
              ])
            ]),
            invalidOrder.length ? el('div', { class: 'sh-plan-warning' }, `⚠️ ${say('前置模块排在当前模块之后:', 'Prerequisite ordered after this step:')} ${invalidOrder.join(', ')}`) : null,
            disabledPrereqs.length ? el('div', { class: 'sh-plan-warning' }, `⚠️ ${say('前置模块未勾选启动:', 'Prerequisite is not enabled:')} ${disabledPrereqs.join(', ')}`) : null
          ].filter(Boolean)),
          el('div', { class: 'sh-plan-order' }, [
            position,
            button('↑', () => move(index - 1), 'button button-quiet', index === 0),
            button('↓', () => move(index + 1), 'button button-quiet', index === order.length - 1)
          ]),
          el('div', { class: 'sh-plan-prereq-col' }, [
            field(say('前置模块（点击直接切换）', 'Prerequisites (click to toggle)'), after),
            prereqChips.length ? el('div', { class: 'sh-prereq-chips' }, prereqChips) : el('span', { class: 'field-help' }, say('无其他模块可依赖', 'No peers available'))
          ])
        ]);
      }));
    }
    draw();

    const failure = el('select', { 'aria-label': say('计划失败策略', 'Plan failure policy') }, [
      el('option', { value: 'continue-independent' }, say('继续独立分支（推荐：无依赖的独立模块继续执行）', 'Continue independent branches (recommended)')),
      el('option', { value: 'stop-plan' }, say('停止本次计划（严格：任何模块失败立即终止）', 'Stop this plan (strict)'))
    ]);
    failure.value = plan.onFailure;
    failure.addEventListener('change', () => { plan.onFailure = failure.value; changed(); });

    const toolbar = el('div', { class: 'sh-plan-toolbar' }, [
      button(say('全部随计划启动', 'Enable all'), () => { for (const m of plan.members) m.enabled = true; changed(); draw(); }, 'button button-quiet'),
      button(say('全部取消勾选', 'Disable all'), () => { for (const m of plan.members) m.enabled = false; changed(); draw(); }, 'button button-quiet'),
      button(say('按依赖拓扑自动排序', 'Auto-sort by prerequisites'), () => {
        const sorted = topoSortOrder(order, plan.members);
        order.splice(0, order.length, ...sorted);
        plan.startupOrder = [...order];
        changed(); draw();
        ctx.toast(say('已按前置依赖自动排定最优启动顺序', 'Auto-sorted by prerequisites'));
      }, 'button button-quiet')
    ]);

    return [
      message(say('勾选随计划启动的模块。点击下方前置芯片直接添加/移除依赖，支持一键按依赖自动排序。', 'Select members to start with the plan. Click prerequisite chips directly to toggle dependencies, or auto-sort by topological dependency.')),
      toolbar,
      rows,
      field(say('启动失败后', 'If startup fails'), failure)
    ];
  }

  async function loadPlan(kind, id, capture) {
    await Promise.resolve();
    try {
      const data = kind === 'global-plan' ? await api('/api/programs/startup-plan') : null;
      if (capture !== generation || mode !== kind || selected !== id) return;
      const group = kind === 'group' ? state.groups.find(row => row.id === id) : null;
      if (kind === 'group' && !group) return;
      base = copy(group ?? data.plan); draft = copy(group ?? data.plan); dirty = false; render();
    } catch (error) { ctx.error(error); }
  }

  function plan() {
    if (mode === 'group' && !selected) selected = state.groups?.[0]?.id ?? null;
    if (mode === 'group' && !selected && !state.groups?.length) {
      return choose('global-plan', null);
    }
    if (!draft) { void loadPlan(mode, selected, generation); return [message(say('正在读取已保存计划…', 'Loading saved plan…'))]; }
    const group = mode === 'group' ? state.groups?.find(row => row.id === selected) : null;
    const isGroup = Boolean(group && mode === 'group');
    const programs = isGroup ? state.programs.filter(row => draft.memberProgramIds.includes(row.programId)) : state.programs;
    const planValue = isGroup ? draft.startupPlan : draft;

    const targetOptions = [
      ...(state.groups ?? []).map(row => el('option', { value: `group:${row.id}` }, `📁 ${typeof row.title === 'string' ? row.title : row.id} (${say('模块组', 'Group')})`)),
      el('option', { value: 'global' }, `🌐 ${say('世界枢纽全局计划', 'World Hub Global Plan')}`)
    ];
    const targetSelector = el('select', { 'aria-label': say('编排对象', 'Plan target') }, targetOptions);
    targetSelector.value = isGroup ? `group:${selected}` : 'global';
    targetSelector.addEventListener('change', () => {
      const val = targetSelector.value;
      if (val === 'global') {
        chooseSafely('global-plan', null);
      } else if (val.startsWith('group:')) {
        chooseSafely('group', val.slice(6));
      }
    });

    const titleText = isGroup
      ? `📁 ${ctx.title(group)} · ${say('模块组启动计划', 'Module group startup plan')}`
      : `🌐 ${say('世界枢纽全局启动计划', 'Global startup plan')}`;

    return [
      el('section', { class: 'panel' }, [
        el('h2', {}, titleText),
        (state.groups ?? []).length ? field(say('计划编排对象', 'Plan target'), targetSelector) : null,
        message(isGroup
          ? say('模块组负责内部成员的依赖编排。随世界枢纽启动时将直接按组内计划运行。', 'Groups organize internal dependencies and start with World Hub.')
          : say('世界枢纽面向全局模块启动。勾选需要随枢纽启动的模块。', 'World Hub schedules global module startup. Select members to start with Hub.')),
        ...planEditor(planValue, programs, () => { dirty = true; }),
        el('div', { class: 'result-actions' }, [
          button(say('恢复当前保存的计划', 'Restore the currently saved plan'), () => { draft = null; dirty = false; generation++; render(); }, 'button button-quiet'),
          button(say('保存计划', 'Save plan'), () => run(async () => {
            if (isGroup) await api('/api/groups/save', { group: { id: base.id, title: draft.title, memberProgramIds: draft.memberProgramIds, startupPlan: draft.startupPlan }, expectedRevision: base.revision });
            else await api('/api/programs/startup-plan/save', { plan: planValue, expectedRevision: base.revision });
            draft = null; dirty = false; generation++; await refresh(); render(); ctx.toast(say('计划已保存，尚未启动。', 'Plan saved. No module was started.'));
          }), 'button button-primary')
        ])
      ].filter(Boolean))
    ];
  }

  function render() {
    if (!root) root = el('div', { class: 'sh-workbench' });
    const backTarget = 'modules';
    const backLabel = say('← 返回已接入模块', '← Back to Connected Modules');
    const topBar = el('div', { class: 'sh-workbench-topbar', style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;' }, [
      button(backLabel, () => ctx.navigate?.(backTarget), 'button button-quiet'),
      el('span', { class: 'field-help mono', style: 'margin:0;' }, say('工作台 · 深度配置与编排', 'Workbench · In-depth Configuration & Orchestration'))
    ]);
    const isPlan = mode === 'group' || mode === 'global-plan';
    const tabs = el('div', { class: 'view-subtabs creator-tabs', role: 'tablist', 'aria-label': say('工作台', 'Workbench') }, [
      button(say('实例参数与接线', 'Configuration & wiring'), () => chooseSafely('configuration', null), `view-subtab${mode === 'configuration' ? ' is-active' : ''}`),
      button(say('启动计划编排', 'Startup plan'), () => chooseSafely(isPlan ? mode : (state.groups?.[0]?.id ? 'group' : 'global-plan'), mode === 'group' ? selected : null), `view-subtab${isPlan ? ' is-active' : ''}`)
    ]);
    root.replaceChildren(topBar, tabs, ...(mode === 'configuration' ? configuration() : plan())); ctx.paths?.enhance(root); return root;
  }

  return { render, open: chooseSafely, dirty: () => dirty, mode: () => mode };
}
