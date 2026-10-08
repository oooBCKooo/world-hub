// This external application owns DSH, prompt composition and execution policy.
// The hub only transports the registered channels used by its mod bridge.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { JsonRpcProcess } from './lib/jsonrpc-process.mjs';
import { StateFile, acquireStateLease, connectPeer, loadSettings, isMain, cliLifecycle } from './lib/program-kit.mjs';

const MAX_REQUESTS = 256;
const MAX_OUTBOX = 128;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 240 * 1024;
const unfinished = record => ['dispatching', 'accepted'].includes(record.phase);
const fault = (code, message) => Object.assign(new Error(message), { code });
const errorFact = error => ({ code: error?.code ?? 'DSH_ERROR', message: String(error?.message ?? error).slice(0, 4096) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

function validateConfig(settings) {
  const config = settings.harness;
  if (!object(config)) throw new TypeError('harness settings are required');
  for (const key of ['installRoot', 'home', 'cwd', 'profile', 'provider', 'model']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new TypeError(`harness.${key} is required`);
  }
  if (config.nodeArgs !== undefined && (!Array.isArray(config.nodeArgs) || config.nodeArgs.some(v => typeof v !== 'string'))) throw new TypeError('harness.nodeArgs must be strings');
  if (config.env !== undefined && !object(config.env)) throw new TypeError('harness.env must be an object');
  for (const key of ['harnessRequest', 'harnessResponse', 'harnessEvent']) {
    if (typeof settings.channels?.[key] !== 'string' || !settings.channels[key]) throw new TypeError(`channels.${key} is required`);
  }
  if (config.reasoningEffort !== undefined && (typeof config.reasoningEffort !== 'string' || !config.reasoningEffort)) throw new TypeError('harness.reasoningEffort must be a nonempty string');
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1)) throw new TypeError('harness.maxTokens must be a positive safe integer');
  return config;
}

function composeInput(body) {
  if (!object(body) || body.kind !== 'dsh.prompt' || !id(body.requestId) || !id(body.sessionId) || typeof body.text !== 'string' || !body.text) {
    throw fault('INVALID_REQUEST', 'dsh.prompt requires requestId, sessionId and nonempty text');
  }
  let context;
  if (body.context !== undefined) {
    if (!object(body.context)) throw fault('INVALID_REQUEST', 'context must be an object');
    const snapshot = body.context.version !== undefined || body.context.systemPrompt !== undefined || body.context.messages !== undefined;
    if (snapshot && (body.context.version !== 1 || typeof body.context.systemPrompt !== 'string' || !Array.isArray(body.context.messages) || body.context.messages.length > 256 || body.context.messages.some(message => !object(message) || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string'))) {
      throw fault('INVALID_REQUEST', 'context requires version 1, systemPrompt and user/assistant messages');
    }
    if (!snapshot && typeof body.context.text !== 'string') throw fault('INVALID_REQUEST', 'legacy context must contain text');
    if (body.context.text !== undefined && typeof body.context.text !== 'string') throw fault('INVALID_REQUEST', 'context.text must be a string');
    context = structuredClone(body.context);
  }
  const input = { contentBlocks: [{ type: 'text', text: body.text }], ...(context === undefined ? {} : { context }) };
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_PROMPT_BYTES) throw fault('PROMPT_TOO_LARGE', `context and current prompt exceed ${MAX_PROMPT_BYTES} bytes`);
  return input;
}

/** Starts one configured DSH child; incoming messages cannot change its executable or arguments. */
export async function startHarnessProgram(settings) {
  const config = validateConfig(settings);
  mkdirSync(resolve(config.home), { recursive: true });
  mkdirSync(resolve(config.cwd), { recursive: true });
  const lease = await acquireStateLease(settings.stateDir, 'harness');
  try { return await startLeasedHarness(settings, config, lease); }
  catch (error) { await lease.close(); throw error; }
}

async function startLeasedHarness(settings, config, lease) {
  const state = new StateFile(join(settings.stateDir, 'harness.state.json'), { version: 1, requests: [], outbox: [], lastFailure: null });
  if (state.value.version !== 1 || !Array.isArray(state.value.requests) || !Array.isArray(state.value.outbox) || state.value.requests.length > MAX_REQUESTS || state.value.outbox.length > MAX_OUTBOX) throw new Error('invalid or oversized harness application state');
  const bootId = randomUUID();
  const sdkOwners = new Map();
  const events = new EventEmitter();
  let bridge;
  let active;
  let accepting = true;
  let closing = false;
  let fatalError;
  let flushTask;
  let closeTask;
  let sdkStopTask;
  let retryTimer;
  let retryDelayMs = 250;
  let payloadBudget = MAX_EVENT_BYTES;
  const env = { ...(config.inheritEnv === false ? {} : process.env), ...(config.env ?? {}), DSH_HOME: resolve(config.home) };
  const args = [...(config.nodeArgs ?? []), join(resolve(config.installRoot), 'lib', 'bin.js'), '--profile', config.profile];
  if (config.patch) args.push('--patch', resolve(config.patch));
  const runtimeDir = join(resolve(config.home), 'runtime', 'peros-context');
  mkdirSync(runtimeDir, { recursive: true });
  const contextPatch = join(runtimeDir, 'context.patch.yml');
  writeFileSync(contextPatch, JSON.stringify([
    { id: 'sdk-jsonrpc-server', disabled: true },
    { insert: [{ id: 'peros-context-server', name: new URL('./dsh-context-plugin.mjs', import.meta.url).href,
      config: { installRoot: resolve(config.installRoot) } }] },
  ], null, 2), 'utf8');
  // CLI --patch is repeatable and preserves argv order. Keep provider/tool
  // overlays, then replace only the application stdio server with this plugin.
  args.push('--patch', contextPatch);
  const rpc = new JsonRpcProcess({ command: process.execPath, args, cwd: resolve(config.cwd), env,
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000, closeTimeoutMs: config.closeTimeoutMs ?? 2_000 });

  const report = info => {
    events.emit('event', info);
    if (typeof settings.onEvent === 'function') settings.onEvent({ program: 'harness', ...info });
    else if (['failure', 'outboxBlocked', 'error', 'denied', 'overflow'].includes(info.event)) console.error(JSON.stringify({ program: 'harness', ...info }));
  };
  const commit = change => {
    const next = structuredClone(state.value);
    change(next);
    state.commit(next);
  };
  const find = requestId => state.value.requests.find(record => record.requestId === requestId);
  const envelope = (channel, body, record) => ({ eventId: randomUUID(), channel, body,
    meta: { correlation: record.requestId, ...(record.inputId ? { replyTo: record.inputId } : {}) } });
  const append = (next, entry) => {
    if (next.outbox.length >= MAX_OUTBOX) throw fault('OUTBOX_FULL', `harness durable outbox is full (${MAX_OUTBOX})`);
    if (Buffer.byteLength(JSON.stringify(entry.body), 'utf8') > payloadBudget) throw fault('EVENT_TOO_LARGE', `DSH event exceeds transport budget (${payloadBudget} bytes)`);
    next.outbox.push(entry);
  };
  const errorBody = (record, error) => ({ kind: 'dsh.error', requestId: record.requestId, sessionId: record.sessionId, error: errorFact(error) });
  const queueResponse = (next, record, body) => {
    record.response = body;
    record.pendingResponse = true;
    if (next.outbox.some(entry => entry.channel === settings.channels.harnessResponse && entry.body.requestId === record.requestId && JSON.stringify(entry.body) === JSON.stringify(body))) {
      record.pendingResponse = false;
    } else if (next.outbox.length < MAX_OUTBOX) {
      append(next, envelope(settings.channels.harnessResponse, body, record));
      record.pendingResponse = false;
    }
  };
  const refill = () => {
    if (!state.value.requests.some(record => record.pendingResponse) || state.value.outbox.length >= MAX_OUTBOX) return;
    commit(next => {
      for (const record of next.requests) {
        if (!record.pendingResponse || next.outbox.length >= MAX_OUTBOX) continue;
        append(next, envelope(settings.channels.harnessResponse, record.response, record));
        record.pendingResponse = false;
      }
    });
  };
  const scheduleRetry = () => {
    if (retryTimer || closing || !bridge?.connected) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void flushOutbox(); }, retryDelayMs);
    retryTimer.unref?.();
    retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
  };
  const flushOutbox = () => {
    if (flushTask) return flushTask;
    if (!bridge?.connected || closing) return Promise.resolve();
    flushTask = (async () => {
      while (!closing && bridge?.connected) {
        refill();
        const entry = state.value.outbox[0];
        if (!entry) break;
        try {
          // Hub acceptance can be uncertain on disconnect. Retain the original
          // eventId so another publication remains deduplicable by the UI.
          await bridge.publishConfirmed(entry.channel, entry.body, { ...entry.meta, id: entry.eventId });
          commit(next => { next.outbox = next.outbox.filter(item => item.eventId !== entry.eventId); });
        } catch (error) {
          report({ event: 'outboxBlocked', error: errorFact(error), pending: state.value.outbox.length });
          scheduleRetry();
          break;
        }
      }
    })().catch(error => failProgram(error)).finally(() => {
      flushTask = undefined;
      if (state.value.outbox.length || state.value.requests.some(record => record.pendingResponse)) scheduleRetry();
      else { clearTimeout(retryTimer); retryTimer = undefined; retryDelayMs = 250; }
    });
    return flushTask;
  };
  const stopSdk = () => {
    sdkStopTask ??= (async () => {
      if (rpc.state === 'running') {
        try { await rpc.request('shutdown', undefined, { timeoutMs: config.shutdownTimeoutMs ?? 5_000 }); }
        catch (error) { if (!fatalError && !closing) report({ event: 'error', error: errorFact(error) }); }
      }
      await rpc.close();
    })();
    return sdkStopTask;
  };
  const markUnknown = (next, record, error) => {
    record.phase = 'unknown';
    queueResponse(next, record, errorBody(record, error));
  };
  function failProgram(error) {
    if (fatalError || closing) return;
    fatalError = error;
    accepting = false;
    try {
      commit(next => {
        next.lastFailure = errorFact(error);
        if (active) {
          const record = next.requests.find(item => item.requestId === active.requestId);
          if (record && unfinished(record)) markUnknown(next, record, fault('UNKNOWN_OUTCOME', `DSH execution or notification transport failed: ${errorFact(error).message}`));
        }
      });
    } catch (saveError) { report({ event: 'failure', error: errorFact(saveError), original: errorFact(error) }); }
    report({ event: 'failure', error: errorFact(error), requestId: active?.requestId });
    // Do not run more tools after transport or persistence fails. Existing
    // results and the explicit uncertain outcome stay durable for next boot.
    void stopSdk().catch(stopError => report({ event: 'failure', error: errorFact(stopError) }));
    void flushOutbox();
  }

  // A previous process may have dispatched real tools. Recovery never repeats
  // that intent: it records uncertainty and reports it to the requesting app.
  if (state.value.requests.some(unfinished)) commit(next => {
    for (const record of next.requests) if (unfinished(record)) markUnknown(next, record, fault('UNKNOWN_OUTCOME', 'Previous harness process stopped before a confirmed completion; the request was not replayed'));
  });

  const queueSimpleError = (message, error) => {
    const body = message.body ?? {};
    const record = { requestId: id(body.requestId) ? body.requestId : `invalid-${message.seq ?? randomUUID()}`,
      sessionId: id(body.sessionId) ? body.sessionId : '', inputId: message.id };
    commit(next => append(next, envelope(settings.channels.harnessResponse, errorBody(record, error), record)));
    void flushOutbox();
  };
  const onDelivery = async message => {
    if (message.topic !== settings.channels.harnessRequest) return;
    if (!accepting || closing) throw fatalError ?? fault('HARNESS_STOPPED', 'Harness is stopping');
    let input;
    try { input = composeInput(message.body); }
    catch (error) { try { queueSimpleError(message, error); } catch (queueError) { failProgram(queueError); throw queueError; } return; }
    const body = message.body;
    const fingerprint = createHash('sha256').update(JSON.stringify({ sessionId: body.sessionId, input })).digest('hex');
    const existing = find(body.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) queueSimpleError(message, fault('REQUEST_ID_CONFLICT', 'requestId already identifies a different prompt'));
      else if (existing.response) commit(next => {
        const record = next.requests.find(item => item.requestId === body.requestId);
        queueResponse(next, record, record.response);
      });
      void flushOutbox();
      return;
    }
    if (active) { queueSimpleError(message, fault('BUSY', 'Another prompt is still executing; submit a new request after its completion')); return; }
    if (state.value.requests.length >= MAX_REQUESTS) { queueSimpleError(message, fault('REQUEST_LIMIT', `Request deduplication table is full (${MAX_REQUESTS}); requests are not evicted automatically`)); return; }
    if (state.value.outbox.length >= MAX_OUTBOX) {
      const error = fault('OUTBOX_FULL', 'Result transport has not drained; no additional prompt was dispatched');
      failProgram(error); throw error;
    }
    // Provider snapshots are authoritative for each request. A fresh physical
    // session imports that history once, without accumulating a second copy.
    const sdkSessionId = `peros-${bootId}-${randomUUID()}`;
    const record = { requestId: body.requestId, sessionId: body.sessionId, inputId: message.id, fingerprint,
      sdkSessionId, phase: 'dispatching', intent: { text: body.text, ...(body.context === undefined ? {} : { context: body.context }) }, response: null, pendingResponse: false, completionObserved: false };
    // Durable intent and notification ownership precede the SDK call, whose
    // early notifications may arrive before the enqueue receipt.
    commit(next => { next.requests.push(record); });
    active = { requestId: body.requestId, sessionId: body.sessionId, sdkSessionId, seenRunning: false };
    sdkOwners.set(sdkSessionId, body.requestId);
    let receiptArrived = false;
    try {
      const receipt = await rpc.request('session/prompt', { sessionId: sdkSessionId, ...input });
      receiptArrived = true;
      if (typeof receipt?.messageId !== 'string' || !receipt.messageId) throw fault('INVALID_DSH_RECEIPT', 'DSH did not return a messageId');
      commit(next => {
        const saved = next.requests.find(item => item.requestId === body.requestId);
        if (saved.phase === 'unknown') return;
        saved.phase = saved.completionObserved ? 'completed' : 'accepted';
        queueResponse(next, saved, { kind: 'dsh.accepted', requestId: saved.requestId, sessionId: saved.sessionId, sdkSessionId: saved.sdkSessionId, messageId: receipt.messageId });
      });
      if (find(body.requestId)?.completionObserved && active?.requestId === body.requestId) active = undefined;
      void flushOutbox();
    } catch (error) {
      if (fatalError || closing) return;
      if (receiptArrived) {
        // Failure to persist an acknowledged dispatch is a local transport
        // failure, not a DSH rejection. Real tools may already be running.
        failProgram(error);
        throw error;
      }
      const uncertain = error.code === 'RPC_TIMEOUT' || error.name === 'JsonRpcTransportError';
      commit(next => {
        const saved = next.requests.find(item => item.requestId === body.requestId);
        if (uncertain) markUnknown(next, saved, fault('UNKNOWN_OUTCOME', `SDK receipt was not confirmed: ${errorFact(error).message}`));
        else { saved.phase = 'failed'; queueResponse(next, saved, errorBody(saved, error)); }
      });
      if (active?.requestId === body.requestId) active = undefined;
      if (uncertain) { accepting = false; void stopSdk(); }
      void flushOutbox();
    }
  };

  rpc.on('request', frame => {
    try { rpc.respondError(frame.id, { code: -32601, message: `No reverse request handler: ${frame.method}` }); }
    catch (error) { failProgram(error); }
  });
  rpc.on('notification', frame => {
    try {
      const sdkSession = frame.params?.sessionId ?? frame.params?.parentSessionId;
      const requestId = sdkOwners.get(sdkSession);
      const record = find(requestId);
      if (!record) throw fault('UNOWNED_DSH_EVENT', `DSH notification has no known requesting application: ${frame.method}`);
      if (frame.method === 'subagent.started' && typeof frame.params?.childSessionId === 'string') sdkOwners.set(frame.params.childSessionId, requestId);
      const eventId = randomUUID();
      const body = { kind: 'dsh.notification', requestId: record.requestId, sessionId: record.sessionId, sdkSessionId: record.sdkSessionId, frame, eventId };
      commit(next => {
        const saved = next.requests.find(item => item.requestId === record.requestId);
        append(next, { ...envelope(settings.channels.harnessEvent, body, saved), eventId });
        if (frame.method === 'session.status' && frame.params.sessionId === active?.sdkSessionId) {
          if (frame.params.status === 'running') active.seenRunning = true;
          if (frame.params.status === 'idle' && active.seenRunning && unfinished(saved)) {
            saved.completionObserved = true;
            if (saved.phase === 'accepted') saved.phase = 'completed';
          }
        }
      });
      if (active?.requestId === record.requestId && find(record.requestId).phase === 'completed') active = undefined;
      void flushOutbox();
    } catch (error) { failProgram(error); }
  });
  rpc.on('transportError', error => { if (!closing && !sdkStopTask) failProgram(error); });
  rpc.on('exit', ({ code, signal }) => { if (!closing && !sdkStopTask) failProgram(fault('DSH_EXIT', `DSH child exited (${signal ?? code})`)); });

  const close = () => {
    closeTask ??= (async () => {
      accepting = false;
      closing = true;
      clearTimeout(retryTimer); retryTimer = undefined;
      try {
        await bridge?.close('harness program stopped');
        if (active && unfinished(find(active.requestId) ?? {})) commit(next => {
          const record = next.requests.find(item => item.requestId === active.requestId);
          markUnknown(next, record, fault('UNKNOWN_OUTCOME', 'Harness stopped before confirming completion; the request was not replayed'));
        });
      } finally {
        // A disk failure cannot leave this program's real tool executor alive.
        try {
          await stopSdk();
          await flushTask;
        } finally { await lease.close(); }
      }
    })();
    return closeTask;
  };

  try {
    await rpc.start();
    const initialized = await rpc.request('initialize', { cwd: resolve(config.cwd), provider: config.provider, model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }) });
    if (initialized?.serverInfo?.name !== 'peros-dsh-context-runtime' || initialized.capabilities?.contextSnapshot !== true) throw fault('INVALID_DSH_SERVER', 'Configured DSH profile did not load the role-preserving context runtime');
    bridge = await connectPeer(settings, 'harness', async message => {
      try { await onDelivery(message); }
      catch (error) { if (!closing) failProgram(error); throw error; }
    }, { onEvent: info => {
      report(info);
      if (info.event === 'open') {
        if (Number.isSafeInteger(info.limits?.maxPayloadBytes) && info.limits.maxPayloadBytes > 0) payloadBudget = Math.min(MAX_EVENT_BYTES, info.limits.maxPayloadBytes);
        void flushOutbox();
      }
    } });
    await flushOutbox();
    if (fatalError) throw fatalError;
    const program = { bridge, rpc, close, flushOutbox, state,
      get active() { return active ? { ...active } : null; },
      get failure() { return fatalError; },
      on(event, handler) { events.on(event, handler); return this; } };
    return program;
  } catch (error) { await close(); throw error; }
}

if (isMain(import.meta.url)) {
  startHarnessProgram(loadSettings()).then(program => {
    program.on('event', info => { if (info.event === 'failure') process.exitCode = 1; });
    cliLifecycle(program, { program: 'harness', dshPid: program.rpc.pid });
  })
    .catch(error => { console.error(JSON.stringify({ program: 'harness', event: 'startupFailed', error: errorFact(error) })); process.exitCode = 1; });
}
