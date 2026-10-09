// All programs, bridge identities and information types below belong to these
// external examples. Adding a profile does not change the Hub protocol.
export const principalFor = (profileId, peerId) => `demo.${profileId}.${peerId}`;
export const bridgeFor = (profileId, peerId, bridgeId = 'main') => `demo.${profileId}.${peerId}.${bridgeId}`;
export const topicFor = (profileId, suffix) => `demo/${profileId}/${suffix}`;
const peer = (id, label, bridges = [{ id: 'main', label: '双向桥' }], details = {}) => ({ id, label, bridges, ...details });
const action = (profileId, id, label, description, peerId, suffix, body, operation = 'request', bridgeId = 'main') => ({
  id, label, description, operation, target: { principal: principalFor(profileId, peerId) }, declaredBridge: bridgeFor(profileId, peerId, bridgeId),
  topic: topicFor(profileId, suffix), body,
});

export const PROFILES = {
  'capability-directory': {
    id: 'capability-directory', title: '能力发现与模块替换',
    description: '独立目录公布能力合同和租约。组装程序只改自己的配置，便可在两份独立文本统计程序之间切换；版本、授权和超时由外部程序解释。',
    explorerMaxConnections: 2, isolatedCredentials: true,
    peers: [
      peer('directory', '外部能力目录', undefined, { entryFile: '../capability-directory/directory.mjs', implementation: 'external-capability-catalog' }),
      peer('source', '原文提供者', undefined, { entryFile: '../capability-directory/composition.mjs', implementation: 'independent-text-source' }),
      peer('composer', '配置式组装程序', undefined, { entryFile: '../capability-directory/composition.mjs', implementation: 'configured-capability-consumer' }),
      peer('metrics-a', '统计实现 A', undefined, { entryFile: '../capability-directory/processor-a.mjs', implementation: 'buffer-statistics' }),
      peer('metrics-b', '统计实现 B', undefined, { entryFile: '../capability-directory/processor-b.mjs', implementation: 'unicode-scan-statistics' }),
      peer('output', '独立成果保存者', undefined, { entryFile: '../capability-directory/composition.mjs', implementation: 'idempotent-result-sink' }),
    ],
    actions: [
      action('capability-directory', 'discovery', '发现可用能力', '通过目录程序自己的桥查询合同、地址、授权声明与租约。', 'directory', 'catalog/query', { capability: 'text.statistics' }),
      action('capability-directory', 'run', '运行当前组合', '目录发现、读取原文、调用选定处理器、保存成果；每一步均有真实收据。', 'composer', 'compose/run', { command: 'run' }),
      action('capability-directory', 'select-b', '仅改配置换成 B', '组装程序保存 metrics-b 配置，来源和输出程序源码保持不变。', 'composer', 'compose/run', { command: 'configure', provider: 'metrics-b' }),
      action('capability-directory', 'select-a', '换回实现 A', '保存 metrics-a 配置，下次运行使用原实现。', 'composer', 'compose/run', { command: 'configure', provider: 'metrics-a' }),
      action('capability-directory', 'output-read', '读取已保存成果', '由独立成果程序返回持久记录；通讯接纳本身不代表业务完成。', 'output', 'output/read', { command: 'snapshot' }),
      action('capability-directory', 'source-update', '修改原文来源', '原文及其修订号由来源程序保存，两处理器遵守相同 UTF-8 与 Unicode 合同。', 'source', 'source/read', { command: 'set', text: '世界枢纽\nWorld Hub 🌍\n' }),
      action('capability-directory', 'version-conflict', '尝试不兼容版本', '组装程序要求 2.0.0 合同；目录仍显示 1.0.0 时应在调用处理器之前拒绝。', 'composer', 'compose/run', { command: 'configure', contractVersion: '2.0.0' }),
      action('capability-directory', 'restore-version', '恢复合同版本', '恢复明确的 1.0.0 合同，下次运行重新发现。', 'composer', 'compose/run', { command: 'configure', contractVersion: '1.0.0' }),
      action('capability-directory', 'deny-b', '让 B 拒绝业务授权', 'B 自己撤销组装程序的业务授权，Hub 仍按通讯权限转交请求与回应。', 'metrics-b', 'provider/metrics-b', { command: 'configure', allowComposer: false }),
      action('capability-directory', 'allow-b', '恢复 B 的业务授权', 'B 自己重新授权组装程序。能力广告不授予业务权限。', 'metrics-b', 'provider/metrics-b', { command: 'configure', allowComposer: true }),
      action('capability-directory', 'slow-b', '模拟 B 的慢处理', 'B 延迟 1500 毫秒；组装程序等待 800 毫秒后返回结果未知，不自动重试或撤销。', 'metrics-b', 'provider/metrics-b', { command: 'configure', delayMs: 1500 }),
      action('capability-directory', 'restore-b', '恢复 B 的响应速度', '清除 B 的演示延迟。之前超时的已接纳请求可能仍完成。', 'metrics-b', 'provider/metrics-b', { command: 'configure', delayMs: 0 }),
      action('capability-directory', 'suspend-b', '暂停 B 的能力续约', 'B 停止向目录续约；1800 毫秒后目录标记租约失效，不推断进程是否存活。', 'metrics-b', 'provider/metrics-b', { command: 'configure', announcing: false }),
      action('capability-directory', 'resume-b', '恢复 B 的能力续约', 'B 重新注册，目录从真实信封绑定当前通讯会话。', 'metrics-b', 'provider/metrics-b', { command: 'configure', announcing: true }),
    ],
    experiments: [{ id: 'discover-and-replace', title: '发现能力，只改配置替换实现', description: '两处理器独立实现同一公开合同；组装程序自行查目录、校验版本和解释业务结果。',
      steps: [{ action: 'discovery', label: '查看两个能力提供者', expect: '目录显示各自模块版本、合同、会话和租约。' },
        { action: 'run', label: '运行原实现 A', expect: '得到原文的统计值与目录、来源、处理器和输出的收据。' },
        { action: 'select-b', label: '仅改组装配置', expect: '配置里的 provider 变为 metrics-b。' },
        { action: 'run', label: '运行独立实现 B', expect: '统计结果相同，处理器主体与独立实现改变。' }],
      takeaway: '能力目录、兼容性、授权和组合策略都是可选外部程序；Hub 不理解统计业务，也不选择处理器。' }],
    observeFilters: ['demo/capability-directory/#'], defaultAction: 'discovery', sourceFile: '../capability-directory/composition.mjs',
  },
  'event-desk': {
    id: 'event-desk', title: '多源事件台',
    description: '先观察环境和行情，再启用一个独立交通程序：它通过自己的桥注册新主题，汇总程序会纳入第三种信息。传感器程序同时连接数据桥和控制桥。',
    peers: [peer('sensor', '环境传感器', [{ id: 'metrics', label: '采样输出桥' }, { id: 'control', label: '参数双向桥' }]),
      peer('market', '行情事件源'), peer('aggregator', '独立汇总程序'),
      peer('traffic', '可接入的交通来源', undefined, { entryFile: 'traffic-source.mjs', implementation: 'independent-traffic-source', description: '独立入口与进程；初始只监听控制请求，启用时注册自己的 traffic/sample 主题并开始提供读数。' })],
    actions: [
      action('event-desk', 'summary', '读取多源汇总', '从汇总程序抽取最新环境和行情数据。', 'aggregator', 'summary', { command: 'snapshot' }),
      action('event-desk', 'sensor-settings', '调节采样参数', '修改环境来源的周期与偏移；业务参数由来源程序处理。', 'sensor', 'sensor/control', { command: 'configure', intervalMs: 900, offset: 3 }, 'request', 'control'),
      action('event-desk', 'sensor-reading', '请求环境读数', '读取环境程序当前的采样与参数。', 'sensor', 'sensor/control', { command: 'snapshot' }, 'request', 'control'),
      action('event-desk', 'sensor-inject', '注入环境偏移', '单向注入参数。枢纽接受回执之后，由来源程序发布实际变更事件。', 'sensor', 'sensor/control', { command: 'configure', offset: 8 }, 'inject', 'control'),
      action('event-desk', 'market-settings', '调节行情参数', '修改独立行情来源的基础数值。', 'market', 'market/control', { command: 'configure', base: 130, intervalMs: 1600 }),
      action('event-desk', 'traffic-enable', '启用第三种来源', '请求独立交通程序注册新主题并开始发布；汇总业务在外部程序中自动纳入新来源。', 'traffic', 'traffic/control', { command: 'enable' }),
      action('event-desk', 'traffic-reading', '读取交通来源', '抽取独立交通程序当前状态、真实注册主题和最新读数。', 'traffic', 'traffic/control', { command: 'snapshot' }),
      action('event-desk', 'traffic-disable', '暂停交通输出', '交通程序暂停发布；已有枢纽记录与汇总中的最近读数仍保留。', 'traffic', 'traffic/control', { command: 'disable' }),
    ],
    experiments: [{ id: 'add-source', title: '把第三种来源接进来', description: '观察两种信息变成三种信息，新主题由交通程序的 mod 桥注册。',
      steps: [{ action: 'summary', label: '先读取两源', expect: '汇总中出现环境与行情，交通尚未输出。' },
        { action: 'traffic-enable', label: '启用独立交通程序', expect: '返回它自己的 principal、桥与新增 traffic/sample 主题。' },
        { action: 'summary', label: '再读取汇总', expect: '交通读数与环境、行情一起出现在汇总中；必要时稍等一轮采样后重试。' }],
      takeaway: '新增信息种类由外部来源声明；汇总程序用自己的订阅约定接收，枢纽无需新增交通业务。' }],
    observeFilters: ['demo/event-desk/#'],
    defaultAction: 'summary', sourceFile: 'event-desk.mjs',
  },
  'modular-assistant': {
    id: 'modular-assistant', title: '分布上下文助手',
    description: '先组合系统提示、用户对话与材料，再加入第四个独立来源，最后把模板执行器换成另一个独立清单执行器。两种执行器都不调用真实模型。',
    peers: [peer('system', '系统提示提供者'), peer('dialogue', '用户对话提供者'), peer('material', '参考材料提供者'), peer('composer', '上下文组装程序'),
      peer('harness', '模板执行器', undefined, { implementation: 'context-echo-template', description: '原执行器按模板完整回显上下文；独立进程，非真实模型。' }),
      peer('extension', '扩展材料提供者', undefined, { entryFile: 'extension-material.mjs', implementation: 'independent-extension-material', description: '新加入的独立来源通过相同 context-source 合同提供额外约束，不改枢纽。' }),
      peer('checklist', '可替换的清单执行器', undefined, { entryFile: 'checklist-harness.mjs', implementation: 'source-checklist', description: '另一份独立程序实现相同 harness/run 合同，把来源与接线转成检查清单；非真实模型。' })],
    actions: [
      action('modular-assistant', 'compose', '运行分布上下文', '组装三个来源，再调用外部模板 harness，保存结果。这里演示通讯与组装，不评估模型能力。', 'composer', 'compose', { prompt: '请根据材料说明，哪些模块可以被独立替换？' }),
      action('modular-assistant', 'system-update', '修改系统提示', '由系统提示程序保存配置，下一次组装读取新值。', 'system', 'context/system', { command: 'set', systemPrompt: '你是模块探索助手。回答时标注所用信息来源。' }),
      action('modular-assistant', 'dialogue-update', '增加用户对话', '用户对话由对话提供者持有，枢纽不负责维护会话。', 'dialogue', 'context/dialogue', { command: 'append-user', content: '我希望界面、上下文和执行器都可以独立替换。' }),
      action('modular-assistant', 'material-update', '修改参考材料', '由参考材料程序保存文本。可把它替换为文档、数据库或其他已授权来源的桥。', 'material', 'context/material', { command: 'set', text: '世界枢纽只转送消息。程序拥有业务、状态和策略。mod 桥注册主题并完成适配。' }),
      action('modular-assistant', 'compose-extension', '加入第四个上下文来源', '组装程序实际请求独立扩展材料进程，并将它的文本与来源回执纳入执行上下文。', 'composer', 'compose', { prompt: '请列出可以独立替换的模块，并考虑新增的扩展约束。', materialProviders: ['material', 'extension'], harnessProvider: 'harness' }),
      action('modular-assistant', 'compose-checklist', '换用独立清单执行器', '保持上下文合同，组装程序改为调用 checklist principal；不同程序入口生成不同形式的结果。', 'composer', 'compose', { prompt: '请列出可以独立替换的模块，并考虑新增的扩展约束。', materialProviders: ['material', 'extension'], harnessProvider: 'checklist' }),
      action('modular-assistant', 'extension-update', '修改扩展来源', '新提供者保存自己持有的材料，后续组装会读取真实更新。', 'extension', 'context/extension', { command: 'set', text: '扩展约束：敏感材料仅由获准程序读取；替换模块时保留通讯合同并验证结果来源。' }),
    ],
    experiments: [{ id: 'compose-and-replace', title: '加一个来源，再换一个执行器', description: '亲手观察真实来源从三个变成四个，再由另一份独立程序处理同一上下文合同。',
      steps: [{ action: 'compose', label: '运行原三源组合', expect: '来源为 system、dialogue、material，执行器为 harness。' },
        { action: 'compose-extension', label: '加入独立扩展材料', expect: 'sources 多出 extension，context.materials 与模板回答含扩展约束。' },
        { action: 'compose-checklist', label: '切换到清单执行器', expect: '执行器 principal 变为 checklist，返回 source-checklist 结果与来源检查清单。' }],
      takeaway: '组装与选择由 composer 程序负责。Hub 只传约定信息，不认识材料、执行器或上下文含义。' }],
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
    experiments: [{ id: 'world-rounds', title: '看多程序逐轮产生世界变化', description: '导演循环调用 NPC、规则和状态，所有业务状态与策略均在外部程序。',
      steps: [{ action: 'advance', label: '推进三个回合', expect: '世界回合、位置、体力随逐轮回执变化。' },
        { action: 'npc-mood', label: '注入 NPC 友好倾向', expect: '界面显示注入接纳回执；NPC 随后发布自己已修改的事件。' },
        { action: 'rest', label: '继续运行休整回合', expect: '导演读取 NPC 新策略，世界出现补给和体力恢复。' }],
      takeaway: '多轮流程由导演决定，状态由 state 程序持有；枢纽不推进世界，也不执行规则。' }],
    observeFilters: ['demo/digital-world/#'], defaultAction: 'advance', sourceFile: 'digital-world.mjs',
  },
};

export function getProfile(id) {
  if (!Object.hasOwn(PROFILES, id)) throw new Error(`未知用途演示：${id}。可选：${Object.keys(PROFILES).join(', ')}`);
  return PROFILES[id];
}
