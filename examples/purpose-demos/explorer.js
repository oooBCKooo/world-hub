// This UI interprets only its external demo programs' contracts. Hub wire
// envelopes remain available as evidence; the Hub does not interpret business.
import { createI18n } from '../../src/ui/language.mjs';
import { EXPLORER_EN, translateDemoText, displayDemoOutput } from './explorer-i18n.mjs';
export { translateDemoText, displayDemoOutput } from './explorer-i18n.mjs';
const format = value => JSON.stringify(value, null, 2);
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const seqOf = envelope => Number.isSafeInteger(envelope?.seq) ? envelope.seq : -1;

export function latestEnvelope(state, kinds) {
  const permitted = new Set(kinds);
  return [...array(state.events), ...array(state.results).map(result => result.response).filter(Boolean)]
    .filter(envelope => permitted.has(envelope?.body?.kind))
    .sort((a, b) => seqOf(b) - seqOf(a))[0] ?? null;
}

export function experimentProgress(experiment, results) {
  const ordered = [...array(results)].sort((a, b) => a.index - b.index);
  let cursor = 0;
  return array(experiment.steps).map(step => {
    const offset = ordered.slice(cursor).findIndex(result => result.action === step.action &&
      (result.operation === 'inject' || (result.response && result.response.body?.ok !== false)));
    if (offset < 0) { cursor = ordered.length; return null; }
    cursor += offset + 1;
    return ordered[cursor - 1];
  });
}

export function injectionEvidence(result, events, bridges) {
  if (result?.operation !== 'inject' || !Number.isSafeInteger(result.receipt?.seq) ||
    typeof result.target?.principal !== 'string' || typeof result.topic !== 'string') return null;
  const kinds = new Set(['demo.source-configured', 'demo.npc-configured', 'demo.traffic-source']);
  // A publish has an opaque runtime bridge origin. Only an authenticated Hub
  // status row can associate that bridge with the requested target principal.
  const targetBridges = new Set(array(bridges).filter(bridge => bridge?.authenticated === true &&
    bridge.principal === result.target.principal && typeof bridge.bridgeId === 'string').map(bridge => bridge.bridgeId));
  const prefix = result.topic.replace(/\/(?:control|plan)$/, '/');
  return array(events).find(event => seqOf(event) > seqOf(result.receipt) &&
    (event.operation ?? 'publish') === 'publish' && kinds.has(event.body?.kind) &&
    event.body.receivedSeq === result.receipt.seq && event.body.ok !== false &&
    targetBridges.has(event.from) &&
    typeof event.topic === 'string' && event.topic.startsWith(prefix)) ?? null;
}

export function deriveView(state) {
  const id = state.profile?.id;
  if (id === 'event-desk') {
    const summary = latestEnvelope(state, ['demo.multi-source-summary', 'demo.summary-updated']);
    const settings = {};
    for (const source of ['sensor', 'market', 'traffic']) {
      const candidates = [...array(state.events), ...array(state.results).map(result => result.response).filter(Boolean)]
        .filter(envelope => envelope.body?.source === source &&
          ['demo.source-configured', 'demo.source-snapshot', 'demo.traffic-source'].includes(envelope.body?.kind))
        .sort((a, b) => seqOf(b) - seqOf(a));
      if (candidates[0]) settings[source] = candidates[0];
    }
    return { type: 'events', summary, sources: Object.entries(object(summary?.body?.latest)).map(([id, item]) => ({ id, ...object(item) })), settings };
  }
  if (id === 'modular-assistant') {
    return { type: 'assistant', result: latestEnvelope(state, ['demo.distributed-assistant-result']) };
  }
  if (id === 'digital-world') {
    const latest = latestEnvelope(state, ['demo.world-run', 'demo.world-state', 'demo.world-round']);
    const run = latestEnvelope(state, ['demo.world-run']);
    const npc = latestEnvelope(state, ['demo.npc-configured']);
    return { type: 'world', latest, world: latest?.body?.finalState ?? latest?.body?.world ?? null, run, npc };
  }
  return { type: 'unknown' };
}

const STORIES = {
  'event-desk': {
    purpose: '用途：把独立来源接成一张能查看、能回控、还能继续扩展的数据台。',
    empty: '先读取汇总，再把一个新的信息来源接进来。',
    next: '改变来源参数，观察读数变化；再按顶部路线启用第三种信息。所有读数均为本地演示数据。',
    roles: { sensor: '产生环境读数；自己保存采样参数。两座桥分别传读数与参数。', market: '独立产生模拟行情；接受自己的参数请求。', aggregator: '订阅各来源，自己维护最新读数与汇总。', traffic: '预置的新来源；收到启用请求后才注册采样主题并输出。' },
    fallback: [{ id: 'parameters', title: '从查看到反向控制', description: '先读取当前数据，再修改来源自己的采样参数。', steps: [{ action: 'summary', label: '读取多源汇总', expect: '查看真实来源与读数。' }, { action: 'sensor-settings', label: '修改采样参数', expect: '来源程序回应保存后的参数。' }, { action: 'sensor-reading', label: '再次读取来源', expect: '检查返回参数与后续读数。' }], takeaway: '界面与来源是同类外部程序，均通过自己的 mod 收发信息。' }],
  },
  'modular-assistant': {
    purpose: '用途：把分散在不同程序的系统提示、对话与材料组合，再交给可替换的执行器。',
    empty: '从三个上下文来源开始，得到一次完整的助手执行结果。',
    next: '顶部路线会继续加入第四个材料来源，再换一份独立执行器实现。这里使用本地确定性程序，不调用模型。',
    roles: { system: '保存并提供系统提示词；只负责自己的上下文片段。', dialogue: '保存有序的用户与助手对话；会话策略在程序中。', material: '提供一份独立参考材料。', extension: '提供额外材料；由组装程序选择是否调用。', composer: '调用选定来源、组装上下文、选择执行器并保存对话。', harness: '独立模板程序，按确定规则回显收到的上下文。', checklist: '另一个独立程序，把同一合同的上下文转成清单。' },
    fallback: [{ id: 'context', title: '从分布来源到一次执行', description: '改变某个来源，再读取一次完整组合。', steps: [{ action: 'compose', label: '运行原组合', expect: '查看三个真实来源的回执。' }, { action: 'material-update', label: '修改材料来源', expect: '提供者保存自己的文本。' }, { action: 'compose', label: '再次组合', expect: '执行器收到新的参考材料。' }], takeaway: '上下文和执行器由外部程序组合，Hub 不选择模型或内容。' }],
  },
  'digital-world': {
    purpose: '用途：让世界状态、规则、NPC 与多轮导演独立协作，逐轮产生一段可观察的世界变化。',
    empty: '推进几个回合，看多个程序的协作如何改变世界。',
    next: '选择探索、休整或交易，再修改 NPC 倾向。世界状态和规则保存在外部程序，不在枢纽中运行。',
    roles: { state: '持有世界状态与修订号；接受逐轮提交。', rules: '计算行动后的提案，不自己持有世界。', npc: '依据自己的倾向返回本轮行动与补给。', director: '决定轮数和行动，逐轮调用 NPC、规则与状态。' },
    fallback: [{ id: 'rounds', title: '从行动到多轮世界变化', description: '外部导演逐轮调用世界模块。', steps: [{ action: 'advance', label: '推进世界', expect: '读取实际逐轮状态。' }, { action: 'npc-mood', label: '改变 NPC 倾向', expect: '注入接纳后观察 NPC 发布。' }, { action: 'rest', label: '再运行休整', expect: '观察新倾向与恢复的体力。' }], takeaway: '流程由导演控制，世界由外部程序推进。' }],
  },
};

const FIELD_INFO = {
  intervalMs: ['采样间隔（毫秒）', '来源程序支持 250–10000 毫秒。', 250, 10000],
  offset: ['环境读数偏移（°C）', '由环境来源处理；可设为 -20 到 20。', -20, 20],
  base: ['模拟行情基础值', '这是一组演示数值。', 1, 100000],
  rounds: ['运行多少个回合？', '外部导演逐轮调用其他程序，最多 12 轮。', 1, 12],
  prompt: ['这次用户输入', '组装程序交给对话提供者保存，再组装上下文。'],
  systemPrompt: ['系统提示词', '由独立系统提示提供者保存。'],
  content: ['追加的用户对话', '由对话提供者保存有序对话。'],
  text: ['参考材料正文', '由当前材料提供者保存；下次组装再读取。'],
  action: ['这一轮做什么？', '规则程序解释这些行动。'],
  mood: ['NPC 倾向', 'NPC 程序保存并解释自己的策略。'],
};
const CHOICES = { action: [['scout', '探索'], ['rest', '休整'], ['trade', '交易']], mood: [['friendly', '友好 · 提供补给'], ['curious', '好奇 · 交替探索'], ['quiet', '安静 · 暂不互动']] };
const WORLD_ACTIONS = { scout: '探索', rest: '休整', trade: '交易' };

export function describeResult(result, { language = 'zh-CN', translate } = {}) {
  const t = translate ?? ((text, params) => translateDemoText(text, language, params));
  if (!result) return t('尚未发起操作。');
  if (!result.response) return t('枢纽已接纳注入；目标程序的执行效果尚需观察。');
  const body = object(result.response.body);
  if (body.ok === false) return t('目标程序返回了业务拒绝：{error}', { error: body.error ? displayDemoOutput(body.error, language) : t('请展开原始回应查看原因') });
  if (body.kind === 'demo.multi-source-summary') return t('汇总程序返回了 {count} 个来源的最近读数。', { count: Object.keys(object(body.latest)).length });
  if (body.kind === 'demo.source-configured') return t('来源程序已经保存参数；后续采样由它按新参数产生。');
  if (body.kind === 'demo.source-snapshot') return t('来源程序返回了自己保存的当前读数与采样参数。');
  if (body.kind === 'demo.traffic-source') return t(body.enabled ? '交通程序已启用，采样主题由自己的桥注册。' : '交通程序当前暂停输出；已有读数和记录仍保留。');
  if (body.kind === 'demo.context-source') return t('上下文提供者保存了自己的内容，当前修订号为 {revision}。下一次组装会再次请求来源。', { revision: body.revision });
  if (body.kind === 'demo.distributed-assistant-result') return t('组装程序返回了 {count} 个来源的上下文与独立执行器的成果。', { count: array(body.sources).length });
  if (body.kind === 'demo.world-run') return t('导演返回了 {rounds} 个实际运行回合和 {count} 次程序调用回执。', { rounds: body.rounds, count: array(body.receipts).length });
  if (body.kind === 'demo.world-state') return t('状态程序返回了自己持有的世界，修订号为 {revision}。', { revision: body.revision });
  return t('目标程序已回应，业务内容请查看成果与原始回应。');
}

function startUi() {
  const i18n = createI18n(EXPLORER_EN);
  const t = i18n.t;
  const outputText = value => displayDemoOutput(value, i18n.language);
  const TIME = value => value ? new Date(value).toLocaleTimeString(i18n.language, { hour12: false }) : t('尚无时间');
  const resultDescription = result => describeResult(result, { language: i18n.language, translate: t });
  const $ = id => document.getElementById(id);
  const node = (tag, value = '', className) => {
    const element = document.createElement(tag); element.textContent = String(value ?? '');
    if (className) element.className = className; return element;
  };
  let current, selection = null, busy = false, connectionStopped = false, programsKey = '', eventsKey = '', dashboardKey = '', experimentsKey = '', actionKey = '';
  let messageContent = { source: '', params: {}, error: false };
  let pollFailure = null;
  function showMessage() {
    $('message').textContent = messageContent.result ? resultDescription(messageContent.result) : outputText(t(messageContent.source, messageContent.params));
    $('message').classList.toggle('error', messageContent.error);
  }
  function setMessage(source, error = false, params = {}) { messageContent = { source, params, error }; showMessage(); }
  function setResultMessage(result) { messageContent = { result, error: result.response?.body?.ok === false }; showMessage(); }
  const story = () => STORIES[current.profile.id] ?? { purpose: '', roles: {}, fallback: [], empty: '发起操作，查看程序返回。', next: '' };
  const labelFor = id => t(current.profile.peers.find(peer => peer.id === id)?.label ?? id);
  const principalLabel = principal => t(current.profile.peers.find(peer => principal === 'demo.' + current.profile.id + '.' + peer.id)?.label ?? principal);
  const section = (title, ...content) => { const wrap = node('section', '', 'result-section'); wrap.append(node('h3', t(title)), ...content); return wrap; };
  const details = (title, content, key) => { const wrap = node('details', '', 'advanced'); if (key) wrap.dataset.panel = key; wrap.append(node('summary', t(title)), content); return wrap; };
  const empty = () => { const wrap = node('div', '', 'empty-result'); wrap.append(node('strong', t(story().empty)), node('p', t(story().next))); return wrap; };
  const provenance = envelope => node('div', (envelope?.fromPrincipal ? t('回应程序 {principal} · ', { principal: envelope.fromPrincipal }) : '') +
    (envelope?.from ? t('来源桥 {bridge} · ', { bridge: envelope.from }) : '') + t('信息 #{seq}', { seq: envelope?.seq }), 'result-provenance');
  const metric = (label, value, unit = '', note = '') => {
    const wrap = node('div', '', 'metric'); const number = node('strong', value ?? '—', 'metric-value');
    if (unit) number.append(node('small', t(unit))); wrap.append(node('div', t(label), 'metric-label'), number);
    if (note) wrap.append(node('div', t(note), 'metric-note')); return wrap;
  };
  const contractNote = body => {
    const parts = [];
    if (Array.isArray(body.materialProviders)) parts.push(t('选择材料：{providers}', { providers: body.materialProviders.map(labelFor).join(i18n.language === 'en' ? ', ' : '、') }));
    if (body.harnessProvider) parts.push(t('选择执行器：{provider}', { provider: labelFor(body.harnessProvider) }));
    if (!parts.length && Object.keys(body).every(key => key === 'command')) parts.push(t('此操作无需额外参数，直接运行即可。'));
    return parts.join(' · ');
  };

  function renderFields(body) {
    $('fields').replaceChildren();
    for (const [key, value] of Object.entries(object(body))) {
      if (key === 'command' || key === 'materialProviders' || key === 'harnessProvider') continue;
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      const info = FIELD_INFO[key] ?? [key, '这是目标程序约定的输入字段。'];
      const wrap = node('div', '', 'field'), label = node('label', t(info[0])); label.dataset.i18n = info[0];
      const id = 'field-' + key.replace(/[^a-z0-9_-]/gi, '-'); label.htmlFor = id;
      let input;
      if (CHOICES[key]) {
        input = node('select'); for (const [entry, title] of CHOICES[key]) { const option = node('option', t(title)); option.dataset.i18n = title; option.value = entry; input.append(option); }
      } else if (['prompt', 'systemPrompt', 'content', 'text'].includes(key)) { input = node('textarea'); input.rows = key === 'prompt' ? 3 : 4; }
      else { input = node('input'); input.type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'checkbox' : 'text'; }
      input.id = id; input.dataset.field = key;
      if (input.type === 'checkbox') input.checked = value; else input.value = String(value);
      if (typeof value === 'number') { input.step = '1'; if (info[2] !== undefined) input.min = String(info[2]); if (info[3] !== undefined) input.max = String(info[3]); }
      input.addEventListener('input', () => {
        let value;
        try { value = JSON.parse($('body').value); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
        catch { setMessage('请先修正展开的 JSON，再修改表单。', true); return; }
        value[key] = input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.type === 'checkbox' ? input.checked : input.value;
        $('body').value = format(value);
      });
      const hint = node('small', t(info[1])); hint.dataset.i18n = info[1];
      wrap.append(label, input, hint); $('fields').append(wrap);
    }
    const note = contractNote(object(body)); if (note) $('fields').append(node('p', note, 'fixed-fields'));
  }

  function renderActionPresentation() {
    if (!selection) return;
    $('action-description').textContent = t(selection.description);
    $('route').replaceChildren();
    const target = principalLabel(selection.target.principal);
    ['界面程序', '双向 mod', '枢纽', target].forEach((value, index) => {
      if (index) $('route').append(node('span', '→', 'route-arrow'));
      $('route').append(node('span', t(value), 'route-node'));
    });
    $('route').append(node('span', t(selection.operation === 'inject' ? '单向注入' : '请求并等待回应') + ' · ' + selection.topic, 'route-contract'));
  }

  function chooseAction() {
    selection = current.profile.actions.find(action => action.id === $('action').value);
    if (!selection) return;
    $('body').value = format(selection.body); renderActionPresentation();
    renderFields(selection.body); setMessage('');
    programsKey = ''; renderPrograms();
  }

  function renderPrograms() {
    const live = array(current.hubStatus?.bridges);
    const peers = [...current.profile.peers, { id: 'explorer', label: '用途探索界面', description: '发起请求与注入，解释程序返回的成果；也是一个外部程序。', bridges: [{ id: 'web', label: '双向界面桥' }] }];
    const key = format([i18n.language, peers, live.map(bridge => [bridge.principal, bridge.bridgeId, bridge.declaredId, bridge.bridge, bridge.id]), selection?.target]);
    if (key === programsKey) return;
    const expanded = new Set([...$('programs').querySelectorAll('details[open][data-peer]')].map(item => item.dataset.peer));
    programsKey = key; $('programs').replaceChildren();
    for (const peer of peers) {
      const principal = 'demo.' + current.profile.id + '.' + peer.id;
      const card = node('div', '', 'program' + (selection?.target.principal === principal ? ' is-target' : ''));
      card.append(node('strong', t(peer.label)), node('p', t(peer.description ?? story().roles[peer.id] ?? '通过自己的桥收发约定信息，业务与状态由此程序负责。')));
      for (const bridge of array(peer.bridges)) {
        const name = principal + '.' + bridge.id;
        const online = live.some(item => item.principal === principal &&
          [item.declaredId, item.bridge, item.id, item.bridgeId].some(id => id === name || id?.startsWith(name + '~')));
        const row = node('div', t(online ? '{bridge} · 在线' : '{bridge} · 未连接', { bridge: t(bridge.label) }), 'bridge' + (online ? '' : ' off')); row.title = name; card.append(row);
      }
      const technical = node('details', '', 'program-technical'); technical.dataset.peer = peer.id; technical.open = expanded.has(peer.id);
      technical.append(node('summary', t('身份与程序入口')), node('code', principal));
      const process = array(current.peers).find(item => item.peer === peer.id || item.id === peer.id);
      const ready = process?.ready ?? process;
      const entry = ready?.programEntry ?? peer.entryFile ?? (peer.id === 'explorer' ? 'explorer.mjs' : current.profile.sourceFile);
      if (entry) technical.append(node('code', t('入口：{entry}', { entry })));
      if (ready?.implementation ?? peer.implementation) technical.append(node('code', t('实现：{implementation}', { implementation: ready?.implementation ?? peer.implementation })));
      card.append(technical); $('programs').append(card);
    }
  }

  function renderExperiments() {
    const experiments = array(current.profile.experiments).length ? current.profile.experiments : story().fallback;
    const key = format([i18n.language, experiments, current.results.map(result => [result.index, result.action, Boolean(result.response), result.response?.body?.ok]), busy, current.active]);
    if (key === experimentsKey) return;
    experimentsKey = key; $('experiments').replaceChildren();
    for (const experiment of experiments) {
      const progress = experimentProgress(experiment, current.results), card = node('article', '', 'experiment'), top = node('div', '', 'experiment-top'), copy = node('div');
      copy.append(node('h3', t(experiment.title)), node('p', t(experiment.description)));
      top.append(copy, node('span', t('{completed} / {total} 步已操作', { completed: progress.filter(Boolean).length, total: experiment.steps.length }), 'badge')); card.append(top);
      const steps = node('div', '', 'experiment-steps');
      experiment.steps.forEach((step, index) => {
        const result = progress[index], button = node('button', '', 'experiment-step' + (result ? ' is-done' : '')); button.type = 'button';
        button.disabled = busy || current.active || !current.profile.actions.some(action => action.id === step.action);
        const description = node('span', '', 'step-copy'); description.append(node('strong', t(step.label)), node('small', t(step.expect)));
        if (result) description.append(node('small', t(result.operation === 'inject' ? '注入已接纳 · 效果看后续发布' : '已收到目标程序回应'), 'step-status'));
        button.append(node('span', index + 1, 'step-number'), description);
        button.addEventListener('click', () => { $('action').value = step.action; chooseAction(); $('action-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('send').focus({ preventScroll: true }); });
        steps.append(button);
      });
      card.append(steps, node('div', t('观察重点：{takeaway}', { takeaway: t(experiment.takeaway) }), 'takeaway')); $('experiments').append(card);
    }
  }

  function renderEventsDashboard(view) {
    if (!view.summary || !view.sources.length) return empty();
    const wrap = node('div'); wrap.append(node('div', t('{count} 个来源已进入独立汇总程序 · 汇总程序已接收 {received} 条来源信息', { count: view.sources.length, received: view.summary.body.received ?? '—' }), 'result-banner'));
    const grid = node('div', '', 'metric-grid');
    for (const source of view.sources) {
      const value = object(source.value), name = labelFor(source.id);
      let card;
      if (value.temperature !== undefined) card = metric(name, value.temperature, value.unit ?? '°C');
      else if (value.price !== undefined) card = metric(name, value.price, value.currency ?? '');
      else if (value.vehicles !== undefined) card = metric(name, value.vehicles, '辆', t('路况：{congestion}', { congestion: outputText(value.congestion) }));
      else card = metric(name, value.value ?? t('已接入'), value.unit ?? '', value.kind ?? t('来源自定义信息'));
      card.append(node('div', t('来源信息 #{seq} · 第 {number} 次采样', { seq: source.seq, number: value.number ?? '—' }), 'metric-note'),
        node('div', TIME(value.at), 'metric-note'), node('div', source.from ?? '', 'metric-note')); grid.append(card);
    }
    wrap.append(grid, provenance(view.summary));
    const settings = node('div', '', 'source-settings');
    if (view.settings.sensor) { const value = view.settings.sensor.body; settings.append(node('span', t('环境：间隔 {interval} ms · 偏移 {offset} °C', { interval: value.intervalMs, offset: value.offset }), 'setting')); }
    if (view.settings.market) { const value = view.settings.market.body; settings.append(node('span', t('行情：基础值 {base} · 间隔 {interval} ms', { base: value.base, interval: value.intervalMs }), 'setting')); }
    if (view.settings.traffic) { const value = view.settings.traffic.body; settings.append(node('span', t('交通：{output} · 主题{registered}', { output: t(value.enabled ? '正在输出' : '输出暂停'), registered: t(value.topicRegistered ? '已注册' : '尚未注册') }), 'setting')); }
    if (settings.children.length) wrap.append(section('来源程序回应的当前参数', settings));
    wrap.append(node('p', t('这是汇总程序返回的最近读数。暂停某个来源的输出后，已有读数继续保留；查看、回应和退出均不自动释放信息。'), 'hint'));
    return wrap;
  }

  function sourceCards(sources) {
    const grid = node('div', '', 'source-grid');
    for (const source of sources) {
      const card = node('div', '', 'source');
      card.append(node('strong', labelFor(source.provider ?? source.program)), node('small', source.principal ?? t('未附程序身份')),
        node('div', t('请求 #{request} → 回应 #{response}', { request: source.requestSeq, response: source.responseSeq }), 'seq'));
      if (source.revision !== undefined) card.append(node('small', t('来源修订号 {revision}', { revision: source.revision })));
      if (source.bridge) card.append(node('small', t('桥 {bridge}', { bridge: source.bridge }))); grid.append(card);
    }
    return grid;
  }

  function renderAssistantDashboard(view) {
    if (!view.result) return empty();
    const body = view.result.body, context = object(body.context), wrap = node('div');
    wrap.append(node('div', t('{count} 个独立上下文来源 → 组装程序 → {executor}', { count: array(body.sources).length, executor: labelFor(body.harnessProvider ?? 'harness') }), 'result-banner'));
    wrap.append(section('实际调用的上下文来源', sourceCards(array(body.sources))));
    const input = node('div');
    const system = node('div', '', 'context-block'); system.append(node('h4', t('系统提示词')), node('div', context.systemPrompt ?? t('未附系统提示'), 'context-text')); input.append(system);
    const conversation = node('div', '', 'conversation context-text');
    for (const message of array(context.messages)) { const chat = node('div', '', 'chat' + (message.role === 'assistant' ? ' assistant' : '')); chat.append(node('small', t(message.role === 'assistant' ? '助手对话' : '用户对话')), node('div', message.content)); conversation.append(chat); }
    input.append(details(t('用户与助手对话（{count} 条，按实际顺序）', { count: array(context.messages).length }), conversation, 'conversation'));
    const materials = Array.isArray(context.materials) ? context.materials : [{ provider: 'material', text: context.material }];
    for (const material of materials) {
      const block = node('div', '', 'context-block'); block.append(node('h4', labelFor(material.provider ?? 'material')), node('div', material.text ?? material.content ?? '', 'context-text')); input.append(block);
    }
    wrap.append(section('组装后交给执行器的上下文', input));
    const answer = node('div', '', 'answer');
    answer.append(node('h3', t('执行器输出')), node('small', labelFor(body.harnessProvider ?? 'harness') + ' · ' + (body.executorImplementation ?? body.mode ?? t('外部执行器')) +
      (body.modelInvoked === false ? t(' · 未调用模型') : '')), node('p', body.answer ?? t('程序没有附文字输出')));
    wrap.append(section('独立执行器返回的成果', answer));
    if (body.harness) { const receipts = sourceCards([{ provider: body.harnessProvider ?? 'harness', ...body.harness }]); wrap.append(section('程序返回的执行器调用回执', receipts)); }
    wrap.append(provenance(view.result), node('p', t('对话保存修订号 {revision} · 来源内容、执行器选择与会话保存由外部程序负责。', { revision: body.savedConversationRevision ?? t('未附') }), 'hint'));
    return wrap;
  }

  function worldText(world) {
    return t('回合 {turn} · 位置 {position} 格\n体力 {energy} · 补给 {inventory}\n天气：{weather}', { ...world, weather: outputText(world.weather) });
  }

  function renderWorldDashboard(view) {
    if (!view.world) return empty();
    const wrap = node('div'), world = view.world, grid = node('div', '', 'metric-grid');
    grid.append(metric('世界回合', world.turn, '轮'), metric('路径位置', world.position, '格'), metric('体力', world.energy, '', '由外部规则计算'), metric('库存补给', world.inventory, '份'));
    wrap.append(section('当前世界状态', grid), node('p', t('天气：{weather} · 状态由 state 程序保存。', { weather: outputText(world.weather) }), 'hint'), provenance(view.latest));
    if (view.npc) wrap.append(node('p', t('NPC 已发布的当前倾向：{mood}', { mood: t({ friendly: '友好', curious: '好奇', quiet: '安静' }[view.npc.body.mood] ?? view.npc.body.mood) }), 'hint'));
    if (view.run) {
      const run = view.run.body;
      if (run.initialState && run.finalState) {
        const compare = node('div', '', 'world-compare');
        for (const [label, value] of [['此次运行前', run.initialState], ['此次运行后', run.finalState]]) { const item = node('div'); item.append(node('small', t(label)), node('p', worldText(value), 'context-text')); compare.append(item); }
        wrap.append(compare);
      }
      const timeline = node('div', '', 'timeline');
      for (const step of array(run.timeline)) {
        const card = node('div', '', 'world-step'), copy = node('div');
        copy.append(node('h4', t('第 {round} 步 · 世界回合 {turn} · {action}', { round: step.round, turn: step.world.turn, action: t(WORLD_ACTIONS[step.action] ?? step.action) })),
          node('p', outputText(step.description)), node('p', outputText(step.npc)), node('small', t('位置 {position} · 体力 {energy} · 补给 {inventory} · {weather} · 修订 {revision}', { ...step.world, weather: outputText(step.world.weather), revision: step.revision })));
        card.append(node('div', step.round, 'turn-number'), copy); timeline.append(card);
      }
      wrap.append(section('导演返回的逐轮行动', timeline), node('p', t('以上是最近一次导演运行的记录；当前状态可能已被后续读取、提交或重置更新。'), 'hint'));
      const receiptList = node('div', '', 'receipt-list');
      for (const receipt of array(run.receipts)) {
        const item = node('div', '', 'receipt'); item.append(node('span', labelFor(receipt.program) + ' · ' + receipt.principal),
          node('small', t('请求 #{request} → 回应 #{response}', { request: receipt.requestSeq, response: receipt.responseSeq }))); receiptList.append(item);
      }
      wrap.append(details(t('程序返回的调用回执（{count} 次）', { count: array(run.receipts).length }), receiptList, 'world-receipts'));
    }
    return wrap;
  }

  function renderOperationResult() {
    const result = current.results.at(-1), container = $('operation-result'); container.replaceChildren();
    if (!result) { $('result').textContent = t('尚未发起操作。'); return; }
    $('result-label').textContent = t(result.label); $('result').textContent = format(result);
    const card = node('div', '', 'operation-result'); card.append(node('strong', t('最近操作 · {label}', { label: t(result.label) })), node('p', resultDescription(result)));
    if (result.operation === 'inject') {
      const evidence = injectionEvidence(result, current.events, current.hubStatus?.bridges);
      card.append(node('p', evidence ? t('目标桥随后发布了设置更新 #{seq}；这里只确认可见发布。', { seq: evidence.seq }) : t('尚未观察到目标桥的设置更新；枢纽接纳不等于目标业务执行完成。'), evidence ? '' : 'pending'));
    }
    const receipt = t('接纳信息 #{seq}', { seq: result.receipt?.seq }) + (result.response ? t(' · 回应 #{seq} · {origin}', { seq: result.response.seq, origin: result.response.fromPrincipal ?? result.response.from }) : '');
    card.append(node('p', receipt, 'result-provenance')); container.append(card);
  }

  function renderDashboard() {
    const view = deriveView(current), key = format([i18n.language, view]);
    if (key !== dashboardKey) {
      const open = new Set([...$('dashboard').querySelectorAll('details[open][data-panel]')].map(item => item.dataset.panel));
      dashboardKey = key;
      const content = view.type === 'events' ? renderEventsDashboard(view) : view.type === 'assistant' ? renderAssistantDashboard(view) : view.type === 'world' ? renderWorldDashboard(view) : empty();
      $('dashboard').replaceChildren(content); for (const item of $('dashboard').querySelectorAll('details[data-panel]')) item.open = open.has(item.dataset.panel);
    }
    renderOperationResult();
  }

  const EVENT_LABELS = {
    'demo.environment-reading': '环境来源发布读数', 'demo.market-reading': '行情来源发布模拟数据', 'demo.traffic-reading': '交通来源发布读数',
    'demo.summary-updated': '汇总程序更新最近读数', 'demo.multi-source-summary': '汇总程序回应查询', 'demo.source-configured': '来源程序公布新参数',
    'demo.source-snapshot': '来源程序回应快照', 'demo.traffic-source': '交通程序公布状态', 'demo.context-source': '上下文提供者回应',
    'demo.context-assembled': '组装程序发布上下文', 'demo.template-result': '模板执行器发布成果', 'demo.checklist-result': '清单执行器发布成果',
    'demo.distributed-assistant-result': '组装程序返回完整成果', 'demo.world-round': '导演发布一个回合', 'demo.world-run': '导演返回多轮成果',
    'demo.world-state': '状态程序公布世界', 'demo.npc-configured': 'NPC 公布自己的倾向',
  };
  function renderEvents() {
    const key = i18n.language + ':' + current.events.map(event => event.seq).join(',');
    $('flow-summary').textContent = t('已观察到最近 {count} 条信息 · 展开查看来源与原始信封', { count: current.events.length });
    if (key === eventsKey) return;
    const expanded = new Set([...$('events').querySelectorAll('details[open]')].map(item => item.dataset.seq)); eventsKey = key; $('events').replaceChildren();
    for (const event of [...current.events].reverse()) {
      const wrap = node('details', '', 'event'); wrap.dataset.seq = String(event.seq); wrap.open = expanded.has(String(event.seq));
      const summary = node('summary'), description = node('span', t(EVENT_LABELS[event.body?.kind] ?? (event.operation === 'response' ? '程序回应' : '程序发布')), 'event-description');
      description.append(node('span', event.fromPrincipal ?? event.from ?? '', 'event-origin'));
      summary.append(node('span', '#' + event.seq, 'seq'), description, node('span', event.topic, 'topic'), node('span', TIME(event.receivedAt), 'time'));
      wrap.append(summary, node('pre', format(event))); $('events').append(wrap);
    }
    if (!current.events.length) $('events').append(node('p', t('等待外部程序发布，或从上方发起操作。')));
  }

  function render(state) {
    current = state; $('title').textContent = t(state.profile.title); document.title = t(state.profile.title) + ' · World Hub';
    $('description').textContent = t(state.profile.description); $('purpose').textContent = t(story().purpose);
    try { const url = new URL(state.managementUrl); if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { url.searchParams.set('lang', i18n.language); $('manage').href = url.href; } else $('manage').removeAttribute('href'); }
    catch { $('manage').removeAttribute('href'); }
    $('endpoint').textContent = state.endpoint; $('profile').textContent = 'PROFILE / ' + state.profile.id;
    const connected = state.explorer.connected && !state.hubStatusError && !connectionStopped;
    $('connection').textContent = t(connectionStopped ? '会话已停止' : connected ? 'mod 已连接' : '通讯中断'); $('connection').classList.toggle('off', !connected);
    $('count').textContent = state.hubStatus?.lastSeq ?? state.events.at(-1)?.seq ?? 0;
    $('hub-count').textContent = t('{count} 个桥连接', { count: array(state.hubStatus?.bridges).length });
    const key = format([state.profile.id, state.profile.actions]);
    if (key !== actionKey) {
      actionKey = key; $('action').replaceChildren(...state.profile.actions.map(action => { const option = node('option', t(action.label)); option.value = action.id; option.dataset.i18n = action.label; return option; }));
      $('action').value = state.profile.defaultAction ?? state.profile.actions[0]?.id; chooseAction();
    }
    renderPrograms(); renderExperiments(); renderDashboard(); renderEvents();
    $('failures').textContent = connectionStopped && pollFailure ? outputText(t(pollFailure.source, pollFailure.params)) : outputText(state.failures.at(-1)?.message ?? state.hubStatusError ?? '');
    $('send').disabled = busy || state.active || !connected;
  }

  async function refresh() {
    try { const response = await fetch('/api/state'); if (!response.ok) throw Object.assign(new Error('状态请求失败 {status}'), { translationParams: { status: response.status } }); connectionStopped = false; pollFailure = null; render(await response.json()); }
    catch (error) { connectionStopped = true; pollFailure = { source: error.message, params: error.translationParams ?? {} }; $('connection').textContent = t('会话已停止'); $('connection').classList.add('off'); $('failures').textContent = outputText(t(pollFailure.source, pollFailure.params)); $('send').disabled = true; }
  }

  $('action').addEventListener('change', chooseAction);
  $('body').addEventListener('change', () => {
    try { const body = JSON.parse($('body').value); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); renderFields(body); setMessage(''); }
    catch { setMessage('请填写有效的 JSON 对象。', true); }
  });
  $('send').addEventListener('click', async () => {
    if (busy || !selection) return;
    let body;
    try { body = JSON.parse($('body').value); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
    catch { setMessage('请先修正 JSON 格式，需要一个对象。', true); return; }
    const selected = selection;
    busy = true; $('send').disabled = true; setMessage('经界面桥发出信息，等待目标程序…'); renderExperiments();
    try {
      const response = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-token': current.operationToken }, body: JSON.stringify({ id: selected.id, body }) });
      const value = await response.json(); if (!response.ok || !value.ok) throw new Error(value.error ?? '操作失败');
      setResultMessage(value.result);
    } catch (error) { setMessage(error.message, true); }
    finally { busy = false; await refresh(); }
  });
  $('language').value = i18n.language;
  $('language').addEventListener('change', event => i18n.setLanguage(event.target.value));
  i18n.onChange(() => {
    i18n.apply(document); $('language').value = i18n.language;
    // Translation changes presentation only. Keep editable input nodes, their
    // values (including incomplete JSON), selection, and expanded panels intact.
    renderActionPresentation();
    const fixed = $('fields').querySelector('.fixed-fields');
    if (fixed) { try { fixed.textContent = contractNote(object(JSON.parse($('body').value))); } catch { fixed.textContent = contractNote(object(selection?.body)); } }
    if (current) render(current);
    else {
      document.title = 'World Hub · ' + t('用途探索'); $('result').textContent = t('尚未发起操作。');
      if (connectionStopped) { $('connection').textContent = t('会话已停止'); $('failures').textContent = outputText(t(pollFailure.source, pollFailure.params)); }
    }
    showMessage();
  });
  i18n.apply(document); $('result').textContent = t('尚未发起操作。'); document.title = 'World Hub · ' + t('用途探索');
  void refresh(); setInterval(() => void refresh(), 1200);
}

if (typeof document !== 'undefined') startUi();
