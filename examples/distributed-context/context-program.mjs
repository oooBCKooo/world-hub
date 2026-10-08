#!/usr/bin/env node
// Context selection is this external program's business. The hub sees only envelopes.
import { open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireStateLease, cliLifecycle, connectPeer, loadSettings, StateFile } from './lib/program-kit.mjs';

const MAX_RECORDS = 256;
const MAX_CONVERSATIONS = 128;
const MAX_MESSAGES = 256;
const MAX_TEXT_BYTES = 512 * 1024;
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const fault = (code, message) => ({ code, message });
const owns = (table, key) => Object.hasOwn(table ?? {}, key);
const getOwn = (table, key) => owns(table, key) ? table[key] : undefined;
const put = (table, key, value) => Object.defineProperty(table, key, { value, enumerable: true, configurable: true, writable: true });
const messageText = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') : '';
const visibleContext = (conversation) => ({ version: 1,
  ...(conversation.systemPrompt === undefined ? {} : { systemPrompt: conversation.systemPrompt }),
  ...(conversation.messages === undefined ? {} : { messages: conversation.messages.map(({ role, content }) => ({ role, content })) }),
  ...(conversation.text === undefined ? {} : { text: conversation.text }) });
const validContext = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && (value.version === undefined || value.version === 1)
  && ['systemPrompt', 'messages', 'text'].some((key) => Object.hasOwn(value, key))
  && (value.systemPrompt === undefined || typeof value.systemPrompt === 'string')
  && (value.messages === undefined || (Array.isArray(value.messages) && value.messages.length <= MAX_MESSAGES
    && value.messages.every((entry) => entry && ['user', 'assistant'].includes(entry.role) && typeof entry.content === 'string')))
  && (value.text === undefined || typeof value.text === 'string');

export async function startContextProgram(settings) {
  const lease = await acquireStateLease(settings.stateDir, 'context');
  try { return await startLeasedContext(settings, lease); }
  catch (error) { await lease.close(); throw error; }
}

async function startLeasedContext(settings, lease) {
  const providerId = settings.contextProviderId ?? 'context';
  if (!identifier(providerId)) throw new Error('CONTEXT_PROVIDER_INVALID');
  const trackDialogue = settings.trackDialogue ?? settings.contextProviderId === undefined;
  const state = new StateFile(join(settings.stateDir, 'context-state.json'), { version: 1, results: {}, conversations: {}, observations: {}, intents: {} });
  if (state.value.version !== 1 || !state.value.results || typeof state.value.results !== 'object' || Array.isArray(state.value.results)) {
    throw new Error('CONTEXT_STATE_INVALID: context state requires version 1 and a results table');
  }
  const diagnostics = { connected: false, lastEvent: null };
  let bridge;
  let ready;
  const connected = new Promise((resolveReady) => { ready = resolveReady; });
  let tail = Promise.resolve();
  const serialize = (work) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const readSeed = async () => {
    let text;
    let source;
    try {
      if (settings.context?.file) {
        const file = await open(settings.context.file, 'r');
        try {
          if (!(await file.stat()).isFile()) throw new Error('选定路径不是普通文件');
          // Read at most one byte beyond the limit even if the selected file grows.
          const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            const chunk = await file.read(buffer, bytes, buffer.length - bytes, null);
            if (!chunk.bytesRead) break;
            bytes += chunk.bytesRead;
          }
          if (bytes > MAX_TEXT_BYTES) return { error: fault('CONTEXT_TOO_LARGE', `选定上下文超过 ${MAX_TEXT_BYTES} 字节`) };
          text = buffer.subarray(0, bytes).toString('utf8');
        } finally { await file.close(); }
        source = { kind: 'selected-file', path: settings.context.file };
      } else {
        text = String(settings.context?.text ?? '');
        source = { kind: 'configured-text' };
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        return { error: fault('CONTEXT_TOO_LARGE', `选定上下文超过 ${MAX_TEXT_BYTES} 字节`) };
      }
      if (settings.context?.format === 'json') {
        let value;
        try { value = JSON.parse(text); }
        catch { return { error: fault('INVALID_CONTEXT', '选定上下文文件不是有效 JSON') }; }
        if (!validContext(value)) return { error: fault('INVALID_CONTEXT', '上下文至少提供 systemPrompt 字符串、有序 user/assistant messages 或 text 字符串之一') };
        return { conversation: { ...(value.systemPrompt === undefined ? {} : { systemPrompt: value.systemPrompt }),
          ...(value.messages === undefined ? {} : { messages: value.messages.map(({ role, content }) => ({ role, content })) }),
          ...(value.text === undefined ? {} : { text: value.text }), source } };
      }
      return { conversation: { ...(trackDialogue ? { systemPrompt: '', messages: [] } : {}), text, source } };
    } catch (error) {
      return { error: fault('CONTEXT_READ_FAILED', `无法读取选定上下文：${String(error.message).slice(0, 512)}`) };
    }
  };
  const observeAssistant = async (message) => {
    const body = message.body;
    if (body?.kind !== 'dsh.notification' || !identifier(body.requestId) || !identifier(body.sessionId)) throw new Error('CONTEXT_NOTIFICATION_INVALID');
    const frame = body.frame;
    const event = frame?.params?.event;
    if (!trackDialogue || frame?.method !== 'session.event' || frame.params?.sessionId !== body.sdkSessionId || event?.type !== 'assistant/message') {
      diagnostics.lastSdkEvent = { method: frame?.method, type: event?.type, at: new Date().toISOString() };
      return;
    }
    if (!identifier(body.sdkSessionId) || !identifier(body.eventId) || !identifier(event.data?.message?.id)) throw new Error('CONTEXT_ASSISTANT_INVALID');
    const result = getOwn(state.value.results, body.requestId);
    if (!result?.ok || result.sessionId !== body.sessionId) return;
    const conversation = getOwn(state.value.conversations, body.sessionId);
    if (!conversation) return; // Older static snapshots did not track a conversation.
    const observation = getOwn(state.value.observations, body.requestId) ?? { sdkSessionId: body.sdkSessionId, eventIds: [] };
    if (observation.sdkSessionId !== body.sdkSessionId) throw new Error('CONTEXT_SDK_SESSION_CONFLICT');
    if (observation.eventIds.includes(body.eventId)) return;
    if (conversation.error) { diagnostics.lastBusinessError = conversation.error; return; }
    const next = structuredClone(state.value);
    next.observations ??= {};
    const savedConversation = getOwn(next.conversations, body.sessionId);
    const sdkMessage = event.data.message;
    const content = messageText(sdkMessage.content);
    const previous = savedConversation.messages.find((entry) => entry.role === 'assistant' && entry.requestId === body.requestId && entry.messageId === sdkMessage.id);
    if (previous) previous.content = content;
    else savedConversation.messages.push({ role: 'assistant', content, requestId: body.requestId, messageId: sdkMessage.id });
    const seen = structuredClone(observation);
    seen.eventIds.push(body.eventId);
    if (savedConversation.messages.length > MAX_MESSAGES || seen.eventIds.length > 256
      || Buffer.byteLength(JSON.stringify(visibleContext(savedConversation)), 'utf8') > MAX_TEXT_BYTES) {
      // Keep all previously saved history. The provider explicitly rejects further
      // context requests for this conversation instead of truncating its meaning.
      const preserved = structuredClone(conversation);
      preserved.error = fault('CONVERSATION_CAPACITY', '对话历史容量已满；此会话不能继续提供完整上下文');
      put(next.conversations, body.sessionId, preserved);
      diagnostics.lastBusinessError = preserved.error;
      state.commit(next);
      process.stderr.write(`${JSON.stringify({ program: 'context', requestId: body.requestId, sessionId: body.sessionId, error: preserved.error })}\n`);
      return;
    }
    put(next.observations, body.requestId, seen);
    state.commit(next);
  };
  const onDelivery = (message) => serialize(async () => {
    await connected;
    if (message.topic === settings.channels.harnessEvent) { await observeAssistant(message); return; }
    if (message.topic !== settings.channels.contextRequest) return;
    const body = message.body;
    if (body?.kind !== 'context.request' || !identifier(body.requestId) || !identifier(body.sessionId)) {
      throw new Error('CONTEXT_REQUEST_INVALID: expected requestId and sessionId');
    }
    const request = { requestId: body.requestId, sessionId: body.sessionId, providerId };
    if (body.text !== undefined && (typeof body.text !== 'string' || Buffer.byteLength(body.text, 'utf8') > 32 * 1024)) throw new Error('CONTEXT_PROMPT_INVALID');
    const prior = getOwn(state.value.results, request.requestId);
    const priorIntent = getOwn(state.value.intents, request.requestId);
    let result;
    if (prior && (prior.sessionId !== request.sessionId || (priorIntent && priorIntent.text !== body.text))) {
      result = { ...request, kind: 'context.result', ok: false, error: fault('REQUEST_ID_CONFLICT', '请求编号已经用于另一会话') };
    } else if (prior) {
      result = { ...prior, providerId };
    } else if (Object.keys(state.value.results).length >= MAX_RECORDS) {
      result = { ...request, kind: 'context.result', ok: false, error: fault('CONTEXT_CAPACITY', '上下文请求记录已满；请为新的运行选择独立状态目录') };
    } else {
      const next = structuredClone(state.value);
      next.conversations ??= {}; next.observations ??= {}; next.intents ??= {};
      let conversation = trackDialogue ? getOwn(next.conversations, request.sessionId) : null;
      let error = conversation?.error;
      if (trackDialogue && !conversation && Object.keys(next.conversations).length >= MAX_CONVERSATIONS) error = fault('CONVERSATIONS_CAPACITY', '上下文会话记录已满');
      if (!conversation && !error) {
        const seed = await readSeed();
        conversation = seed.conversation;
        error = seed.error;
      }
      if (!error) {
        conversation = structuredClone(conversation);
        if (trackDialogue) conversation.messages ??= [];
        const snapshot = visibleContext(conversation);
        if (trackDialogue && body.text !== undefined) conversation.messages.push({ role: 'user', content: body.text, requestId: request.requestId });
        if ((conversation.messages?.length ?? 0) > MAX_MESSAGES || Buffer.byteLength(JSON.stringify(visibleContext(conversation)), 'utf8') > MAX_TEXT_BYTES) {
          error = fault('CONVERSATION_CAPACITY', '对话历史容量不足以保存本次用户消息');
        } else {
          result = { ...request, kind: 'context.result', ok: true, context: snapshot, source: conversation.source,
            ...(snapshot.text === undefined ? {} : { text: snapshot.text }) };
          if (trackDialogue) put(next.conversations, request.sessionId, conversation);
        }
      }
      if (error) result = { ...request, kind: 'context.result', ok: false, error };
      put(next.results, request.requestId, result);
      put(next.intents, request.requestId, { sessionId: request.sessionId, ...(body.text === undefined ? {} : { text: body.text }) });
      state.commit(next);
    }
    // A replay can republish the saved result. Consumers correlate and deduplicate it.
    // Publication failure fails the delivery callback and therefore does not ACK.
    await bridge.publishConfirmed(settings.channels.contextResponse, result, {
      correlation: message.id,
      id: `context.${request.requestId}`,
    });
  });
  bridge = await connectPeer(settings, settings.contextPeer ?? 'context', onDelivery, { onEvent(event) {
    diagnostics.connected = event.event === 'open' ? true : event.event === 'close' ? false : diagnostics.connected;
    diagnostics.lastEvent = { kind: event.event, code: event.code, at: new Date().toISOString() };
  } });
  diagnostics.connected = bridge.connected;
  ready();
  let closeTask;
  return { bridge, state, diagnostics, close() {
    closeTask ??= (async () => { try { await bridge.close(); await tail; } finally { await lease.close(); } })();
    return closeTask;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startContextProgram(loadSettings()).then((program) => cliLifecycle(program, { program: 'context' }))
    .catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
