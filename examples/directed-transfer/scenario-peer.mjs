// Ordinary external programs used for executable phase-four scenarios.
// Application state, delegation, context composition and files all live here.
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

let configuration;
const mods = new Map();
const behaviors = new Map();
const deliveries = [];
const receipts = [];
const events = [];
const pauses = new Map();
let state = {};
let stopping = false;
const emit = (kind, details = {}) => {
  const event = { kind, program: configuration?.name, pid: process.pid, ...details };
  events.push(event);
  if (process.connected) process.send(event);
};
const localPath = (path) => {
  const target = resolve(path);
  if (!target.startsWith(resolve(configuration.dir) + sep)) throw new Error('fixture file must stay inside the scene directory');
  return target;
};
const getMod = (id) => {
  const bridge = id ? mods.get(id) : mods.values().next().value;
  if (!bridge) throw new Error(`unknown mod ${id}`);
  return bridge;
};
const options = (args) => Object.fromEntries(['attachments', 'timeoutMs', 'id', 'correlation', 'replyTo', 'headers'].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(localPath(path))) hash.update(block);
  return { path, size: (await stat(path)).size, sha256: hash.digest('hex') };
}
async function initialize(config) {
  configuration = config;
  for (const mod of config.bridges) {
    const bridge = new Bridge({ url: config.url, bridgeId: mod.id, credential: mod.credential, token: mod.token, autoAck: mod.autoAck,
      reconnectMs: 40, maxPendingCalls: 32 });
    mods.set(mod.id, bridge);
    const originalRequest = bridge.communicationRequest.bind(bridge);
    bridge.communicationRequest = async (...args) => {
      const pause = pauses.get(mod.id);
      if (pause?.pending) {
        pause.pending = false;
        emit('paused', { ...pause, mod: mod.id });
        await new Promise(() => {}); // the conductor terminates this real process
      }
      return originalRequest(...args);
    };
    for (const kind of ['open', 'close', 'error', 'denied', 'published', 'registered', 'released', 'subscribed', 'unsubscribed', 'caughtUp', 'overflow']) {
      bridge.on(kind, (frame) => { if (kind === 'published') receipts.push(frame); emit(kind, { mod: mod.id, frame }); });
    }
    bridge.on('delivery', async (message) => {
      deliveries.push({ mod: mod.id, message }); emit('delivery', { mod: mod.id, message });
      const behavior = behaviors.get(`${mod.id}|${message.topic}`);
      if (message.operation === 'inject' && behavior?.onInject?.mode === 'state') {
        state = structuredClone(message.body);
        emit('handled', { mod: mod.id, messageSeq: message.seq, operation: message.operation, result: state });
      }
      if (message.operation !== 'request' || !behavior?.onRequest) return;
      const handler = behavior.onRequest;
      const delayMs = handler.delayMs ?? behavior.delayMs;
      if (delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      let body;
      if (handler.mode === 'static') body = handler.value;
      else if (handler.mode === 'echo') body = { input: message.body, program: config.name, pid: process.pid };
      else if (handler.mode === 'state') body = { state, program: config.name, pid: process.pid };
      else if (handler.mode === 'delegate') {
        const upstream = await bridge.call(handler.target, handler.topic, handler.body ?? message.body, { timeoutMs: handler.timeoutMs ?? 8000 });
        body = { upstream: upstream.response.body, program: config.name, pid: process.pid };
        emit('delegated', { mod: mod.id, requestSeq: upstream.request.seq, responseSeq: upstream.response.seq, originalSeq: message.seq });
      } else throw new Error(`unknown external request handler ${handler.mode}`);
      const receipt = await bridge.respond(message, body, { attachments: handler.attachments });
      emit('handled', { mod: mod.id, messageSeq: message.seq, operation: message.operation, result: body, receipt });
    });
    await bridge.connect();
  }
  emit('ready', { mods: [...mods].map(([id, bridge]) => ({ id, welcome: bridge.welcome })) });
}
async function command(op, args, commandId) {
  if (op === 'snapshot') return { pid: process.pid, program: configuration.name, state, deliveries, receipts,
    mods: [...mods].map(([id, bridge]) => ({ id, connected: bridge.connected, welcome: bridge.welcome, subscriptions: bridge.subscriptions, channels: bridge.channels })) };
  if (op === 'generate') {
    if (!Number.isSafeInteger(args.size) || args.size < 0) throw new Error('file size must be a nonnegative safe integer');
    const path = localPath(args.path), file = await open(path, args.overwrite ? 'w' : 'wx');
    const buffer = Buffer.alloc(256 * 1024); const hash = createHash('sha256');
    for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 31 + Math.floor(i / 997) + (args.seed ?? 0)) & 255;
    try {
      for (let offset = 0; offset < args.size;) {
        const part = buffer.subarray(0, Math.min(buffer.length, args.size - offset));
        for (let written = 0; written < part.length;) { const result = await file.write(part, written, part.length - written, offset + written); if (!result.bytesWritten) throw new Error('file write made no progress'); written += result.bytesWritten; }
        offset += part.length; hash.update(part);
      }
      await file.sync();
    } finally { await file.close(); }
    return { path, size: args.size, sha256: hash.digest('hex') };
  }
  if (op === 'fileHash') return digestFile(args.path);
  if (op === 'modify') {
    const handle = await open(localPath(args.path), 'r+');
    try { return await handle.write(Buffer.from(args.value), 0, args.value.length, args.offset); }
    finally { await handle.close(); }
  }
  if (op === 'stop') { stopping = true; await Promise.all([...mods.values()].map((bridge) => bridge.close())); return { stopped: true }; }
  const bridge = getMod(args.mod);
  switch (op) {
    case 'behavior': behaviors.set(`${args.mod ?? mods.keys().next().value}|${args.topic}`, { onRequest: args.onRequest, onInject: args.onInject, delayMs: args.delayMs }); return { configured: true };
    case 'register': return bridge.registerChannels(args.channels);
    case 'subscribe': return bridge.subscribe(args.filters, { from: args.from, operations: args.operations });
    case 'unsubscribe': return bridge.unsubscribe(args.subscription);
    case 'publish': return bridge.publishConfirmed(args.topic, args.body, options(args));
    case 'request': return bridge.requestTo(args.target, args.topic, args.body, options(args));
    case 'inject': return bridge.sendTo(args.target, args.topic, args.body, options(args));
    case 'call': return bridge.call(args.target, args.topic, args.body, options(args));
    case 'respond': return bridge.respond(args.requestSeq, args.body, options(args));
    case 'release': return bridge.release(args.seq);
    case 'releaseBlob': return bridge.releaseBlob(args.id);
    case 'blobStatus': return bridge.blobStatus(args.id);
    case 'blob': return bridge.communicationRequest(args.type, args.fields, { timeoutMs: args.timeoutMs ?? 30_000 });
    case 'ack': {
      const delivery = deliveries.find(({ mod, message }) => (!args.mod || mod === args.mod) && message.seq === (args.seq ?? args.message?.seq) && (!args.subscription || message.subscription === args.subscription));
      if (!delivery) throw new Error('ACK must refer to an actual received delivery');
      return { acknowledged: bridge.ack(delivery.message) };
    }
    case 'closeMod': await bridge.close(); return { closed: true };
    case 'barrier': {
      const filter = args.topic ?? `__scene/barrier/${randomUUID()}`;
      const start = events.length;
      const sub = await bridge.subscribe([filter], { from: 0 });
      let timer, deadline;
      try { return await Promise.race([new Promise((resolveBarrier) => {
        const poll = () => { const found = events.slice(start).find((event) => event.kind === 'caughtUp' && event.mod === (args.mod ?? mods.keys().next().value) && event.frame.subscription === sub.subscription); if (found) resolveBarrier(found.frame); else timer = setTimeout(poll, 5); }; poll();
      }), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('catch-up barrier timed out')), 8000); })]); }
      finally { clearTimeout(timer); clearTimeout(deadline); await bridge.unsubscribe(sub.subscription); }
    }
    case 'compose': {
      const calls = [];
      for (const source of args.sources) calls.push(await bridge.call(source.target, source.topic, source.body ?? {}, { timeoutMs: 8000 }));
      const body = { contexts: calls.map((result) => result.response.body), program: configuration.name, pid: process.pid };
      const receipt = await getMod(args.outputMod ?? args.mod).sendTo(args.target, args.topic, body);
      return { calls, body, receipt };
    }
    case 'upload':
    case 'download': {
      const id = args.mod ?? mods.keys().next().value;
      const pause = { operation: op, commandId, path: args.path, id: args.id, offset: 0, pending: false };
      if (args.pauseAt) pauses.set(id, pause);
      const onProgress = (progress) => { Object.assign(pause, progress); if (args.pauseAt && progress.offset >= args.pauseAt) pause.pending = true; };
      try {
        if (op === 'upload') return await bridge.uploadFile(localPath(args.path), { id: args.id, onProgress });
        return await bridge.downloadFile(args.messageSeq, args.id, localPath(args.path), { resume: args.resume, onProgress });
      } finally { pauses.delete(id); }
    }
    default: throw new Error(`unknown program command ${op}`);
  }
}
process.on('message', async (message) => {
  if (message.kind === 'init') {
    try { await initialize(message.configuration); }
    catch (error) { emit('fatal', { message: error.stack ?? error.message }); process.exitCode = 1; await Promise.all([...mods.values()].map((bridge) => bridge.close())); process.disconnect(); }
    return;
  }
  if (message.kind !== 'command') return;
  try {
    const value = await command(message.op, message.args, message.commandId);
    if (process.connected) process.send({ kind: 'result', commandId: message.commandId, value }, () => { if (message.op === 'stop') { process.disconnect(); process.exit(0); } });
  } catch (error) { if (process.connected) process.send({ kind: 'result', commandId: message.commandId, error: { code: error.code, message: error.message } }); }
});
process.on('disconnect', () => { if (!stopping) Promise.all([...mods.values()].map((bridge) => bridge.close())).finally(() => process.exit()); });
