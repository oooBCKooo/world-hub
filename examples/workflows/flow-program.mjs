// Ordinary external verification program. The Hub never executes these rules.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const mods = new Map(), seen = new Map(), joins = new Map(), active = new Set();
let stopping = false, journalTail = Promise.resolve();
const emit = (event, data = {}) => process.stdout.write(JSON.stringify({ event, program: config.name, pid: process.pid, ...data }) + '\n');
if (config.journal) {
  try {
    const saved = JSON.parse(await readFile(config.journal, 'utf8'));
    for (const item of saved.seen) seen.set(item.inputSeq, item.result);
    for (const item of saved.joins) joins.set(item.flowId, item.parts);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function checkpoint() {
  if (!config.journal) return;
  journalTail = journalTail.then(async () => {
    const data = { seen: [...seen].map(([inputSeq, result]) => ({ inputSeq, result })), joins: [...joins].map(([flowId, parts]) => ({ flowId, parts })) };
    await writeFile(config.journal + '.tmp', JSON.stringify(data));
    await rename(config.journal + '.tmp', config.journal);
  });
  await journalTail;
}
const modFor = (id) => {
  const mod = id ? mods.get(id) : mods.values().next().value;
  if (!mod) throw new Error(`unknown external mod: ${id}`);
  return mod;
};
async function processMessage(rule, inputMod, message) {
  if (seen.has(message.seq)) { emit('duplicate', { inputSeq: message.seq }); return; }
  const input = structuredClone(message.body);
  const trace = Array.isArray(input.trace) ? input.trace : [];
  let result;
  if (trace.length >= (rule.maxSteps ?? 32)) {
    result = { event: 'stopped', inputSeq: message.seq, body: input, reason: 'external-program-step-budget', receipts: [] };
  } else {
    const step = { program: config.name, pid: process.pid, receivedSeq: message.seq, fromPrincipal: message.fromPrincipal, inMod: inputMod };
    let body = { ...input, trace: [...trace, step] };
    if (rule.tag !== undefined) body.tags = [...(body.tags ?? []), rule.tag];
    const output = modFor(rule.outMod ?? inputMod), receipts = [];
    try {
      if (rule.mode === 'delegate') {
        if (message.operation !== 'request') throw new Error('delegate fixture expects a request');
        if (rule.next) {
          const downstream = await output.call(rule.next.target, rule.next.topic, body, { timeoutMs: rule.timeoutMs ?? 8000 });
          body = downstream.response.body;
          receipts.push({ ...downstream.request, responseSeq: downstream.response.seq, responsePrincipal: downstream.response.fromPrincipal });
        }
        receipts.push(await modFor(inputMod).respond(message, body));
      } else if (rule.mode === 'fork') {
        for (const branch of rule.branches) receipts.push(await output.sendTo(branch.target, branch.topic, { ...structuredClone(body), branch: branch.id }));
      } else {
        if (rule.mode === 'join') {
          if (!rule.expectedBranches.includes(input.branch)) throw new Error('unexpected branch for external join');
          const parts = joins.get(input.flowId) ?? {};
          parts[input.branch] ??= input; joins.set(input.flowId, parts);
          if (!rule.expectedBranches.every((id) => parts[id])) {
            result = { event: 'waiting', inputSeq: message.seq, flowId: input.flowId, branches: Object.keys(parts), receipts };
          } else {
            const traces = rule.expectedBranches.map((id) => parts[id].trace ?? []);
            const common = [];
            for (let i = 0; i < traces[0].length && traces.every((items) => JSON.stringify(items[i]) === JSON.stringify(traces[0][i])); i++) common.push(traces[0][i]);
            body = { ...input, trace: [...common, step], branches: structuredClone(parts) };
            delete body.branch; joins.delete(input.flowId);
          }
        }
        if (!result) {
          const next = body.route?.length ? body.route.shift() : rule.next;
          if (next) receipts.push(await output.sendTo(next.target, next.topic, body));
        }
      }
      result ??= { event: receipts.length ? 'handled' : 'complete', inputSeq: message.seq, body, receipts };
    } catch (error) {
      result = { event: 'failed', inputSeq: message.seq, body, receipts, error: { code: error.code, message: error.message } };
    }
  }
  seen.set(message.seq, result);
  await checkpoint();
  emit(result.event, result);
}
for (const descriptor of config.bridges) {
  const bridge = new Bridge({ ...descriptor, bridgeId: descriptor.id, url: config.url, reconnectMs: 40 });
  mods.set(descriptor.id, bridge);
  bridge.on('error', (frame) => emit('bridgeError', { mod: descriptor.id, frame }));
  bridge.on('delivery', (message) => emit('received', { mod: descriptor.id, message }));
  await bridge.connect();
}
for (const rule of config.rules) {
  const inputId = rule.inMod ?? mods.keys().next().value;
  const input = modFor(inputId), output = modFor(rule.outMod ?? inputId);
  const nextTopics = [rule.next?.topic, ...(rule.branches ?? []).map((branch) => branch.topic)].filter(Boolean);
  await input.registerChannels([{ name: rule.topic, publish: true, subscribe: true }]);
  if (nextTopics.length) await output.registerChannels(nextTopics.map((name) => ({ name, publish: true, subscribe: true })));
  input.on('delivery', async (message) => {
    if (stopping || message.topic !== rule.topic || !['inject', 'request'].includes(message.operation)) return;
    const task = processMessage(rule, inputId, message); active.add(task);
    try { await task; } catch (error) { emit('fatal', { message: error.stack }); process.exitCode = 1; }
    finally { active.delete(task); }
  });
  await input.subscribe([rule.topic], { from: 0, operations: [rule.mode === 'delegate' ? 'request' : 'inject'] });
}
emit('ready', { mods: [...mods.keys()] });
async function command(op, args) {
  const bridge = modFor(args.mod);
  if (op === 'snapshot') return { seen: [...seen].map(([inputSeq, result]) => ({ inputSeq, result })), joins: [...joins], mods: [...mods].map(([id, mod]) => ({ id, connected: mod.connected, session: mod.welcome?.session })) };
  if (op === 'start') {
    await bridge.registerChannels([{ name: args.topic, publish: true, subscribe: true }]);
    return args.mode === 'call' ? bridge.call(args.target, args.topic, args.body, { timeoutMs: args.timeoutMs ?? 10000 }) : bridge.sendTo(args.target, args.topic, args.body);
  }
  if (op === 'barrier') {
    const topic = args.topic ?? `__flow/barrier/${process.pid}/${Date.now()}`;
    let timer, deadline;
    // caught_up carries a subscription id; install the matching listener before subscribe.
    const frames = []; let capturing = true;
    bridge.on('caughtUp', (frame) => { if (capturing) frames.push(frame); });
    try {
      const sub = await bridge.subscribe([topic], { from: 0 });
      const wait = new Promise((resolve, reject) => {
        const poll = () => { const frame = frames.find((item) => item.subscription === sub.subscription); if (frame) resolve(frame); else timer = setTimeout(poll, 5); }; poll();
        deadline = setTimeout(() => reject(new Error('flow barrier timed out')), 8000);
      });
      const result = await wait; await bridge.unsubscribe(sub.subscription); return result;
    } finally { clearTimeout(timer); clearTimeout(deadline); capturing = false; }
  }
  throw new Error(`unknown flow fixture command ${op}`);
}
async function stop() {
  if (stopping) return; stopping = true;
  await Promise.allSettled([...active]); await journalTail;
  await Promise.all([...mods.values()].map((bridge) => bridge.close()));
  process.disconnect?.();
}
process.on('message', async (message) => {
  if (message.type === 'stop') { await stop(); return; }
  if (message.type !== 'command') return;
  try { emit('result', { id: message.id, value: await command(message.op, message.args) }); }
  catch (error) { emit('result', { id: message.id, error: { code: error.code, message: error.message } }); }
});
process.on('disconnect', () => { if (!stopping) stop().catch(() => { process.exitCode = 1; }); });
process.on('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
