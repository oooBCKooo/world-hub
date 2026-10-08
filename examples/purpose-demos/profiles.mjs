// All programs, bridge identities and information types below belong to these
// external examples. Adding a profile does not change the Hub protocol.
export const principalFor = (profileId, peerId) => `demo.${profileId}.${peerId}`;
export const bridgeFor = (profileId, peerId, bridgeId = 'main') => `demo.${profileId}.${peerId}.${bridgeId}`;
export const topicFor = (profileId, suffix) => `demo/${profileId}/${suffix}`;
const peer = (id, label, bridges = [{ id: 'main', label: '双向桥' }]) => ({ id, label, bridges });
const action = (profileId, id, label, description, peerId, suffix, body, operation = 'request', bridgeId = 'main') => ({
  id, label, description, operation, target: { principal: principalFor(profileId, peerId) }, declaredBridge: bridgeFor(profileId, peerId, bridgeId),
  topic: topicFor(profileId, suffix), body,
});

export const PROFILES = {
  'event-desk': {
    id: 'event-desk', title: '多源事件台',
    description: '两种事件来源独立发布，汇总程序读取；界面可反向请求和注入采样参数。传感器程序连接两条不同的 mod 桥。',
    peers: [peer('sensor', '环境传感器', [{ id: 'metrics', label: '采样输出桥' }, { id: 'control', label: '参数双向桥' }]), peer('market', '行情事件源'), peer('aggregator', '独立汇总程序')],
    actions: [
      action('event-desk', 'summary', '读取多源汇总', '从汇总程序抽取最新环境和行情数据。', 'aggregator', 'summary', { command: 'snapshot' }),
      action('event-desk', 'sensor-settings', '调节采样参数', '修改环境来源的周期与偏移；业务参数由来源程序处理。', 'sensor', 'sensor/control', { command: 'configure', intervalMs: 900, offset: 3 }, 'request', 'control'),
      action('event-desk', 'sensor-reading', '请求环境读数', '读取环境程序当前的采样与参数。', 'sensor', 'sensor/control', { command: 'snapshot' }, 'request', 'control'),
      action('event-desk', 'sensor-inject', '注入环境偏移', '单向注入参数。枢纽接受回执之后，由来源程序发布实际变更事件。', 'sensor', 'sensor/control', { command: 'configure', offset: 8 }, 'inject', 'control'),
      action('event-desk', 'market-settings', '调节行情参数', '修改独立行情来源的基础数值。', 'market', 'market/control', { command: 'configure', base: 130, intervalMs: 1600 }),
    ],
    observeFilters: ['demo/event-desk/#'],
    defaultAction: 'summary', sourceFile: 'event-desk.mjs',
  },
  'modular-assistant': {
    id: 'modular-assistant', title: '分布上下文助手',
    description: '系统提示、用户对话和参考材料分别由独立程序提供；组装程序调用确定性模板 harness，展示来源及完整上下文。无真实模型调用。',
    peers: [peer('system', '系统提示提供者'), peer('dialogue', '用户对话提供者'), peer('material', '参考材料提供者'), peer('composer', '上下文组装程序'), peer('harness', '确定性模板 harness')],
    actions: [
      action('modular-assistant', 'compose', '运行分布上下文', '组装三个来源，再调用外部模板 harness，保存结果。这里演示通讯与组装，不评估模型能力。', 'composer', 'compose', { prompt: '请根据材料说明，哪些模块可以被独立替换？' }),
      action('modular-assistant', 'system-update', '修改系统提示', '由系统提示程序保存配置，下一次组装读取新值。', 'system', 'context/system', { command: 'set', systemPrompt: '你是模块探索助手。回答时标注所用信息来源。' }),
      action('modular-assistant', 'dialogue-update', '增加用户对话', '用户对话由对话提供者持有，枢纽不负责维护会话。', 'dialogue', 'context/dialogue', { command: 'append-user', content: '我希望界面、上下文和执行器都可以独立替换。' }),
      action('modular-assistant', 'material-update', '修改参考材料', '由参考材料程序保存文本。可把它替换为文档、数据库或其他已授权来源的桥。', 'material', 'context/material', { command: 'set', text: '世界枢纽只转送消息。程序拥有业务、状态和策略。mod 桥注册主题并完成适配。' }),
    ],
    observeFilters: ['demo/modular-assistant/#'], defaultAction: 'compose', sourceFile: 'modular-assistant.mjs',
  },
  'digital-world': {
    id: 'digital-world', title: '外部数字世界',
    description: '状态、规则、NPC 和导演分成独立程序；导演经枢纽逐轮调用它们推进小世界。世界逻辑全部运行在外部程序。',
    peers: [peer('state', '世界状态程序'), peer('rules', '行动规则程序'), peer('npc', 'NPC 行为程序'), peer('director', '多轮导演程序')],
    actions: [
      action('digital-world', 'advance', '推进 3 轮世界', '每轮依次请求 NPC 决策、规则计算和状态提交，返回完整轮次记录。', 'director', 'director/run', { rounds: 3, action: 'scout' }),
      action('digital-world', 'rest', '运行休整回合', '同样的通讯链路，选择不同的外部业务行动。', 'director', 'director/run', { rounds: 2, action: 'rest' }),
      action('digital-world', 'world-snapshot', '读取世界状态', '世界状态由 state 程序保存，界面通过其 mod 抽取。', 'state', 'world/state', { command: 'snapshot' }),
      action('digital-world', 'npc-mood', '注入 NPC 倾向', '单向注入友好倾向；NPC 程序发布实际设置事件。', 'npc', 'npc/plan', { command: 'configure', mood: 'friendly' }, 'inject'),
      action('digital-world', 'reset', '重置演示世界', '仅重置 state 程序的演示状态；枢纽的通讯记录继续保留。', 'state', 'world/state', { command: 'reset' }),
    ],
    observeFilters: ['demo/digital-world/#'], defaultAction: 'advance', sourceFile: 'digital-world.mjs',
  },
};

export function getProfile(id) {
  if (!Object.hasOwn(PROFILES, id)) throw new Error(`未知用途演示：${id}。可选：${Object.keys(PROFILES).join(', ')}`);
  return PROFILES[id];
}
