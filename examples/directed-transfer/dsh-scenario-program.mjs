// These ordinary external fixture programs own prompt composition and DSH.
// The Hub sees only registered topics, targets, requests, responses and injections.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { JsonRpcProcess } from '../distributed-context/lib/jsonrpc-process.mjs';

const [role, configPath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const bridges = [];
let rpc;
let active;
let closing = false;
let dshExit;
const emit = (event, fields = {}) => console.log(JSON.stringify({ event, program: role, pid: process.pid, ...fields }));
const textOf = (content = []) => content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const target = (principal) => ({ principal });

async function make(mod) {
  const bridge = new Bridge({ url: config.url, bridgeId: mod.id, token: mod.token, reconnectMs: 40 });
  bridges.push(bridge);
  bridge.on('error', (frame) => emit('bridge_error', { bridge: mod.id, frame }));
  bridge.on('denied', (frame) => emit('bridge_denied', { bridge: mod.id, frame }));
  await bridge.connect();
  return bridge;
}

async function stop() {
  if (closing) return;
  closing = true;
  await Promise.all(bridges.map((bridge) => bridge.close()));
  if (rpc) {
    if (rpc.state === 'running') await rpc.request('shutdown', undefined, { timeoutMs: 5000 }).catch(() => {});
    await rpc.close();
    emit('dsh_stopped', { dshPid: rpc.pid, exit: dshExit });
  }
  if (process.connected) process.disconnect();
}

async function runDsh(body) {
  if (active) throw new Error('this external harness fixture handles one request at a time');
  const sessionId = `phase4-real-${randomUUID()}`;
  let resolveTurn, rejectTurn;
  const done = new Promise((resolveDone, rejectDone) => { resolveTurn = resolveDone; rejectTurn = rejectDone; });
  done.catch(() => {});
  const timer = setTimeout(() => rejectTurn(new Error('actual DSH turn did not complete')), 30_000);
  active = { sessionId, output: '', messages: new Map(), seenRunning: false, resolveTurn, rejectTurn };
  try {
    const receipt = await rpc.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: body.text }], context: body.context });
    const output = await done;
    return { output, sessionId, dshPid: rpc.pid, messageId: receipt.messageId };
  } finally { clearTimeout(timer); active = undefined; }
}

async function startHarness() {
  const contextPatch = join(config.dir, 'phase4-context.patch.yml');
  await writeFile(contextPatch, JSON.stringify([
    { id: 'sdk-jsonrpc-server', disabled: true },
    { insert: [{ id: 'phase4-context-server', name: new URL('../distributed-context/dsh-context-plugin.mjs', import.meta.url).href, config: { installRoot: resolve(config.installRoot) } }] },
  ], null, 2));
  rpc = new JsonRpcProcess({ command: config.fixture.executable, args: [...config.fixture.args, '--patch', contextPatch],
    cwd: config.fixture.workspace, env: config.fixture.env, requestTimeoutMs: 30_000, closeTimeoutMs: 2000 });
  rpc.on('stderr', (data) => { process.stderr.write(data); });
  rpc.on('request', (frame) => rpc.respondError(frame.id, { code: -32601, message: 'This external fixture has no reverse RPC handler' }));
  rpc.on('transportError', (error) => { if (!closing) active?.rejectTurn(error); });
  rpc.on('exit', (exit) => { dshExit = exit; if (!closing) active?.rejectTurn(new Error(`actual DSH exited ${JSON.stringify(exit)}`)); });
  rpc.on('notification', (frame) => {
    const turn = active;
    if (!turn || frame.params?.sessionId !== turn.sessionId) return;
    const event = frame.method === 'session.event' ? frame.params?.event : null;
    if (event?.type === 'assistant/message') {
      const message = event.data?.message;
      turn.messages.set(message.id, textOf(message.content));
      turn.output = [...turn.messages.values()].join('\n\n');
    }
    if (frame.method === 'session.status' && frame.params.status === 'running') turn.seenRunning = true;
    if (frame.method === 'session.status' && frame.params.status === 'idle' && turn.seenRunning) {
      if (!turn.output) turn.rejectTurn(new Error('actual DSH completed without assistant text'));
      else turn.resolveTurn(turn.output);
    }
  });
  await rpc.start();
  const initialized = await rpc.request('initialize', config.fixture.initialize);
  if (initialized?.capabilities?.contextSnapshot !== true) throw new Error('actual DSH did not load the role-preserving external context plugin');
  const bridge = await make(config.mods[0]);
  await bridge.registerChannels([{ name: config.topic, publish: true, subscribe: true }]);
  bridge.on('delivery', async (message) => {
    if (message.operation !== 'request' || message.topic !== config.topic) return;
    const result = await runDsh(message.body);
    const body = { ...result, program: 'external-dsh-harness', harnessPid: process.pid };
    const receipt = await bridge.respond(message, body);
    emit('handled', { requestSeq: message.seq, responseSeq: receipt.seq, dshPid: rpc.pid, body });
  });
  await bridge.subscribe([config.topic], { from: 0, operations: ['request'] });
  emit('ready', { bridgeId: config.mods[0].id, dshPid: rpc.pid, server: initialized.serverInfo.name, network: 'prohibited-by-fixture-guard' });
}

async function startUi() {
  const control = await make(config.mods[0]);
  const output = await make(config.mods[1]);
  const inputTopics = [config.topic, config.harness.topic, ...config.sources.map((source) => source.topic)];
  await control.registerChannels([...new Set(inputTopics)].map((name) => ({ name, publish: true, subscribe: true })));
  await output.registerChannels([...new Set(config.outputs.map((destination) => destination.topic))].map((name) => ({ name, publish: true, subscribe: false })));
  control.on('delivery', async (message) => {
    if (message.operation !== 'request' || message.topic !== config.topic) return;
    const sourceCalls = [];
    for (const source of config.sources) {
      const result = await control.call(target(source.principal), source.topic, { query: 'selected-context-for-this-turn' });
      sourceCalls.push({ source: source.role, ...result });
    }
    const selected = Object.fromEntries(sourceCalls.map((call) => [call.source, call.response.body.state ?? call.response.body]));
    const context = { version: 1, systemPrompt: selected.system.systemPrompt, messages: selected.dialogue.messages, text: selected.notes.text };
    const dsh = await control.call(target(config.harness.principal), config.harness.topic, { text: message.body.text, context }, { timeoutMs: 35_000 });
    const history = { version: 1, messages: [...context.messages, { role: 'user', content: message.body.text }, { role: 'assistant', content: dsh.response.body.output }] };
    const injections = [];
    for (const destination of config.outputs) {
      const body = destination.role === 'dialogue' ? history : { text: message.body.text, output: dsh.response.body.output, context, dsh: dsh.response.body };
      injections.push({ role: destination.role, receipt: await output.sendTo(target(destination.principal), destination.topic, body) });
    }
    const body = { text: message.body.text, output: dsh.response.body.output, context, sources: sourceCalls, dsh, injections,
      program: 'external-ui-composer', uiPid: process.pid, outputBridge: config.mods[1].id };
    const response = await control.respond(message, body);
    emit('handled', { requestSeq: message.seq, responseSeq: response.seq, sourcePrincipals: config.sources.map((source) => source.principal), dshPid: dsh.response.body.dshPid });
  });
  await control.subscribe([config.topic], { from: 0, operations: ['request'] });
  emit('ready', { bridges: config.mods.map((mod) => mod.id) });
}

process.on('message', (message) => { if (message.type === 'stop') void stop(); });
process.on('disconnect', () => { if (!closing) void stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
try {
  if (role === 'harness') await startHarness();
  else if (role === 'ui') await startUi();
  else throw new Error('expected an external ui or harness fixture role');
} catch (error) { emit('failed', { message: error.stack ?? error.message }); process.exitCode = 1; await stop(); }
