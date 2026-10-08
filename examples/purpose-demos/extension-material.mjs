#!/usr/bin/env node
// A separate external source program. Its context contract matches a document
// or database adapter; its state and business do not live in the Hub.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPurposePeerMain } from './peer.mjs';
import { asObject, boundedText, channel, openState, respondOrPublish } from './common.mjs';

export async function startExtensionMaterial(context) {
  if (context.profile.id !== 'modular-assistant' || context.peer.id !== 'extension') throw new Error('此入口只运行独立 extension 材料程序');
  const state = await openState(context.stateDir, 'extension-state.json', { version: 1, revision: 0,
    text: '扩展约束：每个结果标记实际信息来源；系统提示、对话、材料和执行器可以分别替换，世界状态始终由外部程序持有。' });
  const topic = context.topic('context/extension'), changed = context.topic('context/extension/updated');
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(changed)], filters: [topic],
    onDelivery: async (message, bridge) => {
      const body = asObject(message.body), command = body.command ?? 'snapshot';
      if (command === 'set') await state.save({ ...state.value, revision: state.value.revision + 1, text: boundedText(body.text, 'text') });
      else if (command !== 'snapshot') throw new Error('扩展材料程序仅支持 snapshot 或 set');
      await respondOrPublish(bridge, message, { ok: true, kind: 'demo.context-source', provider: 'extension',
        implementation: 'independent-extension-material', ...state.value }, command === 'set' ? changed : null);
    } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPurposePeerMain(startExtensionMaterial);
