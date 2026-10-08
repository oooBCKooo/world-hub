#!/usr/bin/env node
// An independent harness implementation. It shares the request/response
// contract with the template harness, not its business algorithm or process.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPurposePeerMain } from './peer.mjs';
import { asObject, boundedText, channel, openState, respondOrPublish } from './common.mjs';

export async function startChecklistHarness(context) {
  if (context.profile.id !== 'modular-assistant' || context.peer.id !== 'checklist') throw new Error('此入口只运行独立 checklist 执行器');
  const state = await openState(context.stateDir, 'checklist-state.json', { version: 1, completed: 0, lastResult: null });
  const topic = context.topic('harness/run'), completed = context.topic('harness/checklist/completed');
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(completed)], filters: [topic],
    onDelivery: async (message, bridge) => {
      const body = asObject(message.body), input = asObject(body.context);
      const systemPrompt = boundedText(input.systemPrompt, 'context.systemPrompt');
      const material = boundedText(input.material, 'context.material', 16384);
      if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 64 || input.messages.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string')) throw new Error('context.messages 需要有序的 user/assistant 对话');
      const user = [...input.messages].reverse().find(item => item.role === 'user');
      if (!user) throw new Error('context.messages 必须含用户消息');
      const sources = Array.isArray(body.sources) ? structuredClone(body.sources) : [];
      const checklist = sources.map(source => ({ provider: source.provider, principal: source.principal,
        requestSeq: source.requestSeq, responseSeq: source.responseSeq,
        check: `替换 ${source.provider} 程序时，保留上下文约定并检查其实际回应。` }));
      const answer = `[独立清单执行器 · 非模型]\n请求：${user.content}\n\n模块检查清单：\n${checklist.map((item, index) => `${index + 1}. ${item.check}`).join('\n')}\n\n系统约束：${systemPrompt}\n材料约束：${material}\n\n组装、选择执行器和对话保存由外部程序负责；枢纽无需改动。`;
      const result = { ok: true, kind: 'demo.checklist-result', mode: 'deterministic-checklist', executorImplementation: 'source-checklist',
        modelInvoked: false, runId: body.runId, answer, checklist, context: structuredClone(input), sources, at: new Date().toISOString() };
      await state.save({ ...state.value, completed: state.value.completed + 1, lastResult: result });
      await respondOrPublish(bridge, message, result, completed);
    } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPurposePeerMain(startChecklistHarness);
