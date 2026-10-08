#!/usr/bin/env node
// This external UI owns workflow and presentation. All peer traffic uses its mod.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireStateLease, cliLifecycle, connectPeer, loadSettings, StateFile } from './lib/program-kit.mjs';

const MAX_REQUESTS = 128;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_ASSISTANT_BYTES = 1024 * 1024;
const TERMINAL = new Set(['completed', 'error', 'abandoned_unknown']);
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const fault = (code, message) => ({ code, message });
const httpFault = (status, code, message) => Object.assign(new Error(message), { status, code });
const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') : '';
function selectedContext(body) {
  const value = body.context ?? (typeof body.text === 'string' ? { version: 1, systemPrompt: '', messages: [], text: body.text } : null);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !['systemPrompt', 'messages', 'text'].some((key) => Object.hasOwn(value, key))
    || (value.systemPrompt !== undefined && typeof value.systemPrompt !== 'string')
    || (value.messages !== undefined && (!Array.isArray(value.messages) || value.messages.length > 256
      || !value.messages.every((entry) => entry && ['user', 'assistant'].includes(entry.role) && typeof entry.content === 'string')))
    || (value.text !== undefined && typeof value.text !== 'string')
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 512 * 1024) throw new Error('UI_CONTEXT_INVALID');
  return { ...structuredClone(value), source: structuredClone(body.source ?? value.source ?? {}) };
}
function composeContext(providerIds, parts) {
  const ordered = providerIds.map((providerId) => parts[providerId]);
  const materials = ordered.filter((part) => part.context.text !== undefined).map((part) => part.context.text);
  const context = { version: 1,
    systemPrompt: ordered.filter((part) => part.context.systemPrompt).map((part) => part.context.systemPrompt).join('\n\n'),
    messages: ordered.flatMap((part) => part.context.messages ?? []),
    ...(materials.length ? { text: materials.join('\n\n') } : {}),
    provenance: providerIds.map((providerId, index) => ({ providerId, source: structuredClone(ordered[index].source) })),
    ...(providerIds.length === 1 ? { source: structuredClone(ordered[0].source) } : {}),
  };
  if (context.messages.length > 256 || Buffer.byteLength(JSON.stringify(context), 'utf8') > 512 * 1024) {
    throw Object.assign(new Error('组合上下文超过界面容量'), { code: 'COMPOSED_CONTEXT_CAPACITY' });
  }
  return context;
}

function readJson(request) {
  return new Promise((resolveJson, rejectJson) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    request.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        done = true; chunks.length = 0;
        rejectJson(httpFault(413, 'BODY_TOO_LARGE', '请求正文过大'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      done = true;
      try { resolveJson(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectJson(httpFault(400, 'INVALID_JSON', '请求正文必须为 JSON')); }
    });
    request.on('error', (error) => { if (!done) { done = true; rejectJson(error); } });
    request.on('aborted', () => { if (!done) { done = true; rejectJson(httpFault(400, 'REQUEST_ABORTED', '请求已经中断')); } });
  });
}

export async function startUiProgram(settings) {
  const lease = await acquireStateLease(settings.stateDir, 'ui');
  try { return await startLeasedUi(settings, lease); }
  catch (error) { await lease.close(); throw error; }
}

async function startLeasedUi(settings, lease) {
  const host = settings.ui?.host ?? '127.0.0.1';
  const port = Number(settings.ui?.port ?? 8130);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('UI_LOOPBACK_REQUIRED: UI host must be loopback');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('UI_PORT_INVALID');
  const state = new StateFile(join(settings.stateDir, 'ui-state.json'), { version: 1, requests: [] });
  if (state.value.version !== 1 || !Array.isArray(state.value.requests) || state.value.requests.length > MAX_REQUESTS) throw new Error('UI_STATE_INVALID');
  const csrfToken = randomBytes(24).toString('hex');
  const providerIds = settings.contextProviders ? settings.contextProviders.map((provider) => provider.id) : ['context'];
  if (!providerIds.length || providerIds.some((id) => !identifier(id)) || new Set(providerIds).size !== providerIds.length) throw new Error('UI_CONTEXT_PROVIDERS_INVALID');
  const diagnostics = { connected: false, bridge: null, channels: settings.channels, contextProviders: providerIds, lastEvent: null, events: [] };
  let bridge;
  let ready;
  const connected = new Promise((resolveReady) => { ready = resolveReady; });
  let tail = Promise.resolve();
  const serialize = (work) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const update = (requestId, modify) => {
    const next = structuredClone(state.value);
    const request = next.requests.find((entry) => entry.requestId === requestId);
    if (!request) return null;
    modify(request);
    request.updatedAt = new Date().toISOString();
    state.commit(next);
    return request;
  };
  // A publication receipt cannot be reconstructed from a crash window.
  const recovered = structuredClone(state.value);
  let recoveryChanged = false;
  for (const request of recovered.requests) {
    if (request.status === 'context_publishing') {
      request.status = 'context_publish_unknown';
      request.error = fault('CONTEXT_PUBLICATION_UNKNOWN', '界面重启时上下文发布结果尚未确认；仍可接收稍后的结果');
      recoveryChanged = true;
    } else if (['harness_publishing', 'harness_pending', 'accepted', 'running'].includes(request.status)) {
      request.status = 'unknown';
      request.error = fault('HARNESS_OUTCOME_UNKNOWN', '界面重启，尚未确认 harness 最终结果；不会自动重新调用');
      recoveryChanged = true;
    }
  }
  if (recoveryChanged) state.commit(recovered);

  const onDelivery = (message) => serialize(async () => {
    await connected;
    const body = message.body;
    if (!identifier(body?.requestId) || !identifier(body?.sessionId)) throw new Error('UI_DELIVERY_INVALID');
    const current = state.value.requests.find((entry) => entry.requestId === body.requestId);
    if (!current) return; // This UI's own history contains only requests it created.
    if (current.sessionId !== body.sessionId) throw new Error('UI_SESSION_CONFLICT');
    if (message.topic === settings.channels.contextResponse && body.kind === 'context.result') {
      if (!['context_pending', 'context_publishing', 'context_publish_unknown'].includes(current.status)) return;
      const providerId = body.providerId ?? 'context';
      if (!providerIds.includes(providerId)) { diagnostics.lastIgnoredProvider = { providerId, at: new Date().toISOString() }; return; }
      if (!Object.hasOwn(current.contextParts ?? {}, providerId)) {
        const part = body.ok ? { ok: true, context: selectedContext(body), source: structuredClone(body.source ?? body.context?.source ?? {}) }
          : { ok: false, error: body.error ?? fault('CONTEXT_FAILED', '上下文程序没有提供结果'), source: structuredClone(body.source ?? {}) };
        update(body.requestId, (request) => {
          request.contextParts ??= {};
          Object.defineProperty(request.contextParts, providerId, { value: part, enumerable: true, configurable: true, writable: true });
          if (!part.ok) { request.status = 'error'; request.error = { ...part.error, providerId }; }
        });
      }
      const collected = state.value.requests.find((entry) => entry.requestId === body.requestId);
      if (collected.status === 'error') return;
      if (!providerIds.every((id) => Object.hasOwn(collected.contextParts, id))) return;
      let context;
      try { context = composeContext(providerIds, collected.contextParts); }
      catch (error) {
        update(body.requestId, (request) => { request.status = 'error'; request.error = fault(error.code ?? 'COMPOSED_CONTEXT_INVALID', error.message); });
        return;
      }
      update(body.requestId, (request) => {
        request.context = context;
        request.status = 'harness_publishing';
        delete request.error;
      });
      try {
        await bridge.publishConfirmed(settings.channels.harnessRequest, {
          kind: 'dsh.prompt', requestId: body.requestId, sessionId: current.sessionId, text: current.text,
          context,
        }, { id: `harness.${body.requestId}`, correlation: message.id });
        update(body.requestId, (request) => { request.status = 'harness_pending'; });
      } catch (error) {
        // Save uncertainty and finish consuming the context response. Replaying it
        // must not automatically repeat a potentially accepted model/tool turn.
        update(body.requestId, (request) => {
          request.status = 'unknown';
          request.error = fault('HARNESS_PUBLICATION_UNKNOWN', `harness 请求发布结果不确定：${String(error.message).slice(0, 512)}`);
        });
      }
      return;
    }
    if (message.topic === settings.channels.harnessResponse) {
      if (body.kind === 'dsh.accepted') {
        if (!identifier(body.messageId) || !identifier(body.sdkSessionId)) throw new Error('UI_ACCEPTED_INVALID');
        if (current.sdkSessionId && current.sdkSessionId !== body.sdkSessionId) throw new Error('UI_SDK_SESSION_CONFLICT');
        update(body.requestId, (request) => {
          request.messageId = body.messageId;
          request.sdkSessionId = body.sdkSessionId;
          if (!TERMINAL.has(request.status) && request.status !== 'unknown') request.status = 'accepted';
          if (request.status === 'accepted') delete request.error;
        });
      } else if (body.kind === 'dsh.error') {
        update(body.requestId, (request) => {
          const error = body.error ?? fault('DSH_ERROR', 'dsh 返回错误');
          if (request.status === 'abandoned_unknown') request.lateError = error;
          else { request.status = error.code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'error'; request.error = error; }
        });
      } else throw new Error('UI_HARNESS_RESPONSE_INVALID');
      return;
    }
    if (message.topic === settings.channels.harnessEvent && body.kind === 'dsh.notification') {
      const frame = body.frame;
      if (!frame || typeof frame !== 'object' || !identifier(body.eventId) || !identifier(body.sdkSessionId)) throw new Error('UI_NOTIFICATION_INVALID');
      if (current.sdkSessionId && current.sdkSessionId !== body.sdkSessionId) throw new Error('UI_SDK_SESSION_CONFLICT');
      if (current.eventIds?.includes(body.eventId)) return;
      if (current.error?.code === 'NOTIFICATION_CAPACITY' || current.lateError?.code === 'NOTIFICATION_CAPACITY') return;
      const mainSession = frame.params?.sessionId === body.sdkSessionId;
      const event = mainSession && frame.method === 'session.event' ? frame.params?.event : null;
      if (event?.type === 'assistant/message' && !identifier(event.data?.message?.id)) throw new Error('UI_ASSISTANT_MESSAGE_INVALID');
      // Event deduplication and its displayed effect share one durable commit.
      update(body.requestId, (request) => {
        request.sdkSessionId = body.sdkSessionId;
        request.eventIds ??= [];
        if (request.eventIds.length >= 256) {
          const error = fault('NOTIFICATION_CAPACITY', '本次请求的通知记录超过界面容量');
          if (['abandoned_unknown', 'unknown'].includes(request.status)) request.lateError = error;
          else { request.status = 'error'; request.error = error; }
          return;
        }
        request.eventIds.push(body.eventId);
        if (event?.type === 'assistant/message') {
          const sdkMessage = event.data.message;
          const content = textContent(sdkMessage.content);
            request.assistantMessages ??= [];
            const previous = request.assistantMessages.find((entry) => entry.id === sdkMessage.id);
            if (previous) previous.text = content;
            else request.assistantMessages.push({ id: sdkMessage.id, text: content });
            request.output = request.assistantMessages.map((entry) => entry.text).join('\n\n');
            if (request.assistantMessages.length > 64 || Buffer.byteLength(request.output, 'utf8') > MAX_ASSISTANT_BYTES) {
              // Store a bounded explicit failure, rather than silently discard a turn.
              request.assistantMessages = [];
              request.output = '';
              const error = fault('OUTPUT_CAPACITY', 'harness 输出超过此界面配置的显示容量');
              if (['abandoned_unknown', 'unknown'].includes(request.status)) request.lateError = error;
              else { request.status = 'error'; request.error = error; }
            } else if (!TERMINAL.has(request.status) && request.status !== 'unknown') { request.status = 'running'; delete request.error; }
        } else if (event?.type === 'turn/end') {
            if (request.status === 'abandoned_unknown') { request.lateOutcome = event.data?.reason?.kind ?? 'unknown'; return; }
            if (request.status === 'error') return;
            if (event.data?.reason?.kind === 'completed') { request.status = 'completed'; delete request.error; }
            else { request.status = 'error'; request.error = fault('TURN_ENDED', `dsh 结束原因：${String(event.data?.reason?.kind ?? 'unknown')}`); }
        } else if (mainSession && frame.method === 'session.status' && frame.params?.status === 'running' && !TERMINAL.has(request.status) && request.status !== 'unknown') {
          request.status = 'running'; delete request.error;
        }
      });
      // Other SDK events are communications diagnostics, not invented app behavior.
      diagnostics.lastSdkEvent = { method: frame.method, type: frame.params?.event?.type, at: new Date().toISOString() };
      return;
    }
    throw new Error('UI_TOPIC_PAYLOAD_MISMATCH');
  });

  bridge = await connectPeer(settings, 'ui', onDelivery, { onEvent(event) {
    diagnostics.connected = event.event === 'open' ? true : event.event === 'close' ? false : diagnostics.connected;
    const summary = { kind: event.event, code: event.code, at: new Date().toISOString() };
    diagnostics.lastEvent = summary;
    diagnostics.events.push(summary);
    diagnostics.events = diagnostics.events.slice(-24);
  } });
  diagnostics.connected = bridge.connected;
  diagnostics.bridge = bridge.bridgeId;
  ready();
  let page;
  try { page = await readFile(new URL('./ui.html', import.meta.url)); }
  catch (error) { await bridge.close(); throw error; }
  let actualPort;
  let closing = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      if (response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': type });
      response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const acceptedHosts = new Set([`127.0.0.1:${actualPort}`, `[::1]:${actualPort}`, `localhost:${actualPort}`]);
      if (!acceptedHosts.has(request.headers.host?.toLowerCase())) throw httpFault(403, 'HOST_DENIED', '界面只接受本机访问');
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
      if (request.method === 'GET' && pathname === '/') { send(200, page, 'text/html; charset=utf-8'); return; }
      if (request.method === 'GET' && pathname === '/api/state') {
        send(200, { ...state.value, diagnostics: { ...diagnostics, connected: bridge.connected }, csrfToken }); return;
      }
      if (request.method !== 'POST' || !['/api/prompt', '/api/end-wait'].includes(pathname)) { send(404, { error: fault('NOT_FOUND', '没有这个界面接口') }); return; }
      if (closing) throw httpFault(503, 'UI_CLOSING', '界面正在关闭');
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw httpFault(403, 'ORIGIN_DENIED', '拒绝跨来源请求');
      if (request.headers.origin) {
        if (request.headers.origin !== `http://${request.headers.host}`) throw httpFault(403, 'ORIGIN_DENIED', '拒绝跨来源请求');
        const supplied = Buffer.from(String(request.headers['x-ui-token'] ?? ''));
        const expected = Buffer.from(csrfToken);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw httpFault(403, 'CSRF_DENIED', '界面请求令牌无效');
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw httpFault(415, 'CONTENT_TYPE_REQUIRED', '接口要求 application/json');
      const payload = await readJson(request);
      if (pathname === '/api/end-wait') {
        if (!identifier(payload?.requestId)) throw httpFault(400, 'REQUEST_ID_REQUIRED', '请求编号无效');
        const ended = await serialize(async () => {
          const next = structuredClone(state.value);
          const saved = next.requests.find((entry) => entry.requestId === payload.requestId);
          if (!saved) throw httpFault(404, 'REQUEST_NOT_FOUND', '没有此请求记录');
          if (!['unknown', 'context_publish_unknown', 'context_pending'].includes(saved.status)) throw httpFault(409, 'END_WAIT_NOT_ALLOWED', '只有等待上下文或结果未知的请求可以结束界面等待');
          saved.waitEndedFrom = saved.status;
          if (saved.status === 'context_pending') {
            const missing = providerIds.filter((id) => !Object.hasOwn(saved.contextParts ?? {}, id));
            saved.error = fault('CONTEXT_WAIT_ENDED', `用户已结束界面等待；尚未收到的上下文来源：${missing.join('、') || '未确认'}`);
          }
          saved.status = 'abandoned_unknown';
          saved.updatedAt = new Date().toISOString();
          saved.waitEndedAt = saved.updatedAt;
          next.nextSessionId = randomUUID();
          state.commit(next);
          return { requestId: saved.requestId, sessionId: saved.sessionId, status: saved.status };
        });
        send(200, ended);
        return;
      }
      if (typeof payload?.text !== 'string' || !payload.text.trim()) throw httpFault(400, 'PROMPT_REQUIRED', '请输入提示文本');
      if (Buffer.byteLength(payload.text, 'utf8') > MAX_PROMPT_BYTES) throw httpFault(413, 'PROMPT_TOO_LARGE', '提示文本过大');
      if (payload.sessionId !== undefined && !identifier(payload.sessionId)) throw httpFault(400, 'SESSION_INVALID', '会话编号无效');
      const accepted = await serialize(async () => {
        if (state.value.requests.some((entry) => !TERMINAL.has(entry.status))) throw httpFault(409, 'BUSY', '已有请求尚未确认结束');
        if (state.value.requests.length >= MAX_REQUESTS) throw httpFault(409, 'UI_CAPACITY', '界面请求记录已满；请为新的运行选择独立状态目录');
        const requestId = randomUUID();
        const sessionId = payload.sessionId ?? state.value.nextSessionId ?? state.value.requests.at(-1)?.sessionId ?? randomUUID();
        const entry = { requestId, sessionId, text: payload.text, status: 'context_publishing', contextParts: {}, output: '', assistantMessages: [], at: new Date().toISOString() };
        const next = { ...structuredClone(state.value), requests: [...structuredClone(state.value.requests), entry] };
        delete next.nextSessionId;
        state.commit(next);
        try {
          await bridge.publishConfirmed(settings.channels.contextRequest, { kind: 'context.request', requestId, sessionId, text: payload.text }, { id: `request.${requestId}` });
          update(requestId, (saved) => { saved.status = 'context_pending'; });
        } catch (error) {
          update(requestId, (saved) => { saved.status = 'context_publish_unknown'; saved.error = fault('CONTEXT_PUBLICATION_UNKNOWN', String(error.message).slice(0, 512)); });
          throw httpFault(503, 'CONTEXT_PUBLICATION_UNKNOWN', `上下文请求结果不确定，编号 ${requestId}`);
        }
        return { requestId, sessionId, status: 'context_pending' };
      });
      send(202, accepted);
    } catch (error) {
      send(error.status ?? 500, { error: fault(error.code ?? 'UI_INTERNAL', error.status ? error.message : '界面处理失败；请查看程序日志') });
      if (!error.status) process.stderr.write(`[ui] ${error.stack ?? error}\n`);
    }
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, host, () => { server.off('error', rejectListen); resolveListen(); });
    });
  } catch (error) { await bridge.close(); throw error; }
  actualPort = server.address().port;
  const url = `http://${host === '::1' ? '[::1]' : host}:${actualPort}`;
  return {
    bridge, server, state, diagnostics, url, address: server.address(),
    async close() {
      if (closing) return;
      closing = true;
      const stopped = new Promise((resolveClose) => server.close(resolveClose));
      server.closeIdleConnections();
      try {
        await bridge.close();
        await tail;
        await stopped;
      } finally { await lease.close(); }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startUiProgram(loadSettings()).then((program) => cliLifecycle(program, { program: 'ui', url: program.url }))
    .catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
