// External DSH profile plugin. Communication and context composition live in
// this application; neither the hub nor the installed DSH packages import it.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'peros-dsh-context-runtime';
export const inject = ['agents', 'llm', 'systemPrompt', 'sdkAppStartup', 'loader'];
const MAX_SESSIONS = 256;
const MAX_CONTEXT_BYTES = 64 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Loads the public APIs from the user's configured, unmodified DSH installation. */
export async function apply(ctx, config) {
  if (!object(config) || typeof config.installRoot !== 'string' || !config.installRoot) throw new TypeError('context runtime requires installRoot');
  const root = resolve(config.installRoot);
  const load = packageName => import(pathToFileURL(join(root, 'node_modules', '@deepseek-ai', packageName, 'lib', 'index.js')).href);
  const [{ JsonRpcLineTransport }, { HarnessSdkJsonRpcServer }, { createUserMessage, createAssistantMessage, createSystemMessage }] = await Promise.all([
    load('dsh-sdk-protocol'), load('dsh-sdk-jsonrpc-server'), load('dsh-llm'),
  ]);
  const appExit = ctx.get('appExit');
  if (typeof appExit !== 'function') throw new Error('context runtime requires the DSH launcher bounded exit controller');
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  // Only public initialization, notification subscriptions and disposal are
  // reused. Stock SDK prompt creation cannot accept role-preserving history.
  const notifications = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: config.maxTokensAsSuccess === true });
  const records = new Map();
  const creating = new Map();
  let route;
  let stopping = false;
  let shutdownTask;
  let exitTask;

  const validateContext = (context, contentBlocks) => {
    if (context !== undefined && !object(context)) throw new TypeError('context must be an object');
    if (!Array.isArray(contentBlocks) || !contentBlocks.length || contentBlocks.some(block => !object(block) || block.type !== 'text' || typeof block.text !== 'string')) throw new TypeError('contentBlocks must contain text blocks');
    const structured = context !== undefined && (context.version !== undefined || context.systemPrompt !== undefined || context.messages !== undefined);
    if (structured) {
      if (context.version !== 1 || typeof context.systemPrompt !== 'string' || !Array.isArray(context.messages) || context.messages.length > 256 || context.messages.some(message => !object(message) || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) throw new TypeError('context snapshot requires version 1, literal systemPrompt and user/assistant messages');
    }
    if (context?.text !== undefined && typeof context.text !== 'string') throw new TypeError('context.text must be a string');
    if (Buffer.byteLength(JSON.stringify({ context, contentBlocks }), 'utf8') > MAX_CONTEXT_BYTES) throw new RangeError('context snapshot and current prompt exceed 64 KiB');
    return structured;
  };
  const importSeed = context => {
    const seed = [];
    const time = Date.now();
    const add = (type, data, surface = false) => seed.push({ type, seq: seed.length, time, data, ...(surface ? { surfaceOp: 'append' } : {}) });
    // The native session format requires step-scoped system/assistant facts.
    // These closed boundaries encode imported history; no old tools are run.
    add('turn/start', { turn: 1 });
    add('step/start', { turn: 1, step: 1 });
    add('system/message', { turn: 1, step: 1, message: createSystemMessage(context.systemPrompt) }, true);
    for (const message of context.messages) {
      const content = [{ type: 'text', text: message.content }];
      if (message.role === 'user') add('user/message', createUserMessage({ content, source: { kind: 'user' } }), true);
      else add('assistant/message', { turn: 1, step: 1,
        message: createAssistantMessage({ content, source: { provider: 'peros-context', model: 'imported-conversation' } }), stream: [] }, true);
    }
    add('step/end', { turn: 1, step: 1 });
    add('turn/end', { turn: 1, reason: { kind: 'completed' } });
    return seed;
  };
  const shutdown = () => {
    shutdownTask ??= (async () => {
      stopping = true;
      await Promise.allSettled([...creating.values()]);
      const handles = [...records.values()];
      records.clear();
      const disposed = await Promise.allSettled(handles.map(handle => handle.dispose()));
      await notifications.shutdown();
      const failures = disposed.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Context runtime agent disposal failed');
      return {};
    })();
    return shutdownTask;
  };
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      try { await transport.flush(); }
      finally { appExit(0); }
    })();
    return exitTask;
  };
  const prompt = async params => {
    if (!route || stopping) throw new Error('Context runtime is not ready');
    if (!object(params) || typeof params.sessionId !== 'string' || !params.sessionId || params.sessionId.length > 256) throw new TypeError('sessionId must be a nonempty string');
    if (records.has(params.sessionId) || creating.has(params.sessionId)) throw new Error('A context snapshot requires a fresh physical sessionId');
    if (records.size + creating.size >= MAX_SESSIONS) throw new Error('Context runtime physical session limit reached');
    const structured = validateContext(params.context, params.contentBlocks);
    const context = params.context === undefined ? undefined : structuredClone(params.context);
    const blocks = structuredClone(params.contentBlocks);
    if (context?.text) blocks.unshift({ type: 'text', text: context.text });
    const creation = ctx.agents.create({
      sessionId: params.sessionId,
      meta: { cwd: route.cwd },
      agentOptions: { provider: route.provider, model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }) },
      ...(structured ? {
        seed: importSeed(context),
        setup(agentCtx) {
          agentCtx.systemPrompt.section({ name: 'peros:provided-system', order: 0, text: context.systemPrompt, interpolate: false, complete: true });
        },
      } : {}),
    });
    creating.set(params.sessionId, creation);
    try {
      const handle = await creation;
      records.set(params.sessionId, handle);
      if (stopping) throw new Error('Context runtime is stopping');
      const message = createUserMessage({ content: blocks, source: { kind: 'user' } });
      handle.agent.followup(message);
      return { messageId: message.id };
    } finally { creating.delete(params.sessionId); }
  };

  transport.onRequest(async (method, params) => {
    switch (method) {
      case 'initialize': {
        if (route || stopping) throw new Error('Context runtime cannot be reinitialized');
        await ctx.get('loader')?.await();
        await notifications.initialize(params);
        route = structuredClone(params);
        route.cwd = resolve(route.cwd);
        return { serverInfo: { name: 'peros-dsh-context-runtime', version: '1' }, capabilities: { contextSnapshot: true } };
      }
      case 'session/prompt': return prompt(params);
      case 'shutdown': {
        const result = await shutdown();
        setImmediate(() => { void disposeAndExit().catch(error => { console.error(error.message); process.exit(1); }); });
        return result;
      }
      default: throw new Error(`unknown Peros DSH context runtime method: ${method}`);
    }
  });
  ctx.effect(() => {
    // sdkAppStartup already delegates stdin EOF to appExit after appReady.
    // The public transport has no close/error hook and only fails waiters on
    // input errors. Delegate broken pipes to the same bounded launcher owner.
    const ioFailure = () => { stopping = true; appExit(1); };
    const inputClosed = () => { if (!process.stdin.readableEnded) ioFailure(); };
    process.stdin.on('error', ioFailure);
    process.stdin.on('close', inputClosed);
    process.stdout.on('error', ioFailure);
    process.stdout.on('close', ioFailure);
    transport.start();
    return async () => {
      stopping = true;
      transport.close();
      try { await shutdown(); }
      finally {
        process.stdin.off('error', ioFailure);
        process.stdin.off('close', inputClosed);
        process.stdout.off('error', ioFailure);
        process.stdout.off('close', ioFailure);
      }
    };
  }, 'peros.context-stdio');
}
