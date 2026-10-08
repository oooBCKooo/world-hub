// No model is invoked here. The harness is a replaceable deterministic external
// program, and all provider selection and conversation policy are application code.
import { randomUUID } from 'node:crypto';
import { asObject, boundedText, channel, openState, respondOrPublish } from './common.mjs';

const providerSeeds = {
  system: { systemPrompt: '你是世界枢纽探索助手。解释模块关系并明确信息来源。' },
  dialogue: { messages: [{ role: 'user', content: '我想探索可以替换不同程序的智能系统。' }] },
  material: { text: '系统提示、用户对话、文档资料、界面和执行器可以由不同程序提供。世界枢纽仅完成约定消息的存储与转送。' },
};
export async function startAssistantPeer(context) {
  if (Object.hasOwn(providerSeeds, context.peer.id)) return startProvider(context);
  if (context.peer.id === 'harness') return startHarness(context);
  if (context.peer.id === 'composer') return startComposer(context);
  throw new Error('未实现的助手程序');
}

async function startProvider(context) {
  const id = context.peer.id, state = await openState(context.stateDir, 'context-state.json', { version: 1, revision: 0, ...providerSeeds[id] });
  const topic = context.topic(`context/${id}`), changed = context.topic(`context/${id}/updated`);
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(changed)], filters: [topic], onDelivery: async (message, bridge) => {
    const body = asObject(message.body), command = body.command ?? 'snapshot';
    const next = state.value;
    if (command === 'set' && id === 'system') next.systemPrompt = boundedText(body.systemPrompt, 'systemPrompt');
    else if (command === 'set' && id === 'material') next.text = boundedText(body.text, 'text');
    else if (['append-user', 'append-assistant'].includes(command) && id === 'dialogue') {
      if (next.messages.length >= 64) throw new Error('演示对话容量已满，请选择新的状态目录');
      next.messages.push({ role: command === 'append-user' ? 'user' : 'assistant', content: boundedText(body.content, 'content', 16384) });
    } else if (command !== 'snapshot') throw new Error(`${id} 来源不支持命令：${command}`);
    if (command !== 'snapshot') { next.revision++; await state.save(next); }
    await respondOrPublish(bridge, message, { ok: true, kind: 'demo.context-source', provider: id, ...state.value }, command !== 'snapshot' ? changed : null);
  } });
}

async function startHarness(context) {
  const topic = context.topic('harness/run'), complete = context.topic('harness/completed');
  const state = await openState(context.stateDir, 'harness-state.json', { version: 1, completed: 0, lastResult: null });
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(complete)], filters: [topic], onDelivery: async (message, bridge) => {
    const body = asObject(message.body), input = asObject(body.context);
    const systemPrompt = boundedText(input.systemPrompt, 'context.systemPrompt');
    const material = boundedText(input.material, 'context.material');
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 64 || input.messages.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string')) throw new Error('context.messages 需要有序的 user/assistant 对话');
    const user = [...input.messages].reverse().find(item => item.role === 'user');
    if (!user) throw new Error('context.messages 必须含用户消息');
    const result = { ok: true, kind: 'demo.template-result', mode: 'deterministic-template', modelInvoked: false, runId: body.runId,
      answer: `[确定性模板演示]\n系统提示：${systemPrompt}\n用户输入：${user.content}\n参考材料：${material}\n\n这个结果由独立模板程序拼接，用于验证多来源上下文通讯。`,
      context: structuredClone(input), sources: body.sources ?? [], at: new Date().toISOString() };
    const next = state.value; next.completed++; next.lastResult = result; await state.save(next);
    await respondOrPublish(bridge, message, result, complete);
  } });
}

async function startComposer(context) {
  const topic = context.topic('compose'), assembled = context.topic('context/assembled'), complete = context.topic('assistant/completed');
  const providerTopics = ['system', 'dialogue', 'material'].map(id => context.topic(`context/${id}`)), harnessTopic = context.topic('harness/run');
  const state = await openState(context.stateDir, 'last-result.json', { version: 1, completed: 0, lastResult: null });
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(assembled), channel(complete), ...[...providerTopics, harnessTopic].map(name => channel(name, { subscribe: true }))],
    filters: [topic], onDelivery: async (message, bridge) => {
      const body = asObject(message.body), prompt = boundedText(body.prompt, 'prompt'), runId = randomUUID();
      const responses = await Promise.all(['system', 'dialogue', 'material'].map(id => bridge.call(context.target(id), context.topic(`context/${id}`),
        id === 'dialogue' ? { command: 'append-user', content: prompt } : { command: 'snapshot' }, { timeoutMs: 12000 })));
      const sources = responses.map((result, index) => ({ provider: ['system', 'dialogue', 'material'][index], principal: result.response.fromPrincipal,
        bridge: result.response.from, requestSeq: result.request.seq, responseSeq: result.response.seq, revision: result.response.body.revision }));
      if (responses.some(result => result.response.body.ok !== true)) throw new Error(`上下文来源失败：${JSON.stringify(responses.map(result => result.response.body))}`);
      const input = { systemPrompt: responses[0].response.body.systemPrompt, messages: responses[1].response.body.messages, material: responses[2].response.body.text };
      await bridge.publishConfirmed(assembled, { kind: 'demo.context-assembled', runId, context: input, sources });
      const execution = await bridge.call(context.target('harness'), harnessTopic, { runId, context: input, sources }, { timeoutMs: 12000 });
      if (execution.response.body.ok !== true) throw new Error(`模板 harness 失败：${JSON.stringify(execution.response.body)}`);
      const dialogueReceipt = await bridge.call(context.target('dialogue'), context.topic('context/dialogue'), { command: 'append-assistant', content: execution.response.body.answer }, { timeoutMs: 12000 });
      if (dialogueReceipt.response.body.ok !== true) throw new Error('对话提供者未能保存模板回答');
      const result = { ...execution.response.body, kind: 'demo.distributed-assistant-result',
        harness: { principal: execution.response.fromPrincipal, bridge: execution.response.from, requestSeq: execution.request.seq, responseSeq: execution.response.seq },
        savedConversationRevision: dialogueReceipt.response.body.revision, savedBy: 'composer', resultFile: state.path };
      const next = state.value; next.completed++; next.lastResult = result; await state.save(next);
      await respondOrPublish(bridge, message, result, complete);
    } });
}
