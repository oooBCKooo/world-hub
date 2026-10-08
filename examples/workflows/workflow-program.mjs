// An ordinary external verification application. Its local plan, round barriers,
// failure policy and final artifact are application business, never Hub logic.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const mods = new Map(), active = new Set(), handled = new Map();
let stopping = false;
const emit = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, program: config.name, pid: process.pid, ...fields }) + '\n');
const modFor = (id) => {
  const mod = id ? mods.get(id) : mods.values().next().value;
  if (!mod) throw new Error(`unknown workflow program mod ${id}`);
  return mod;
};
if (!Array.isArray(config.plan) || !config.plan.length || config.plan.some((round) =>
  typeof round.name !== 'string' || !Array.isArray(round.workers) || round.workers.length < 2 ||
  round.workers.some((worker) => typeof worker.target?.principal !== 'string' || typeof worker.topic !== 'string')))
  throw new Error('this verification workflow expects a local plan with at least two workers per round');

async function execute(message) {
  const flowId = randomUUID(), rounds = [];
  let previous = [], failure;
  const inputMod = modFor(config.inputMod), outputMod = modFor(config.outputMod ?? config.inputMod);
  for (let index = 0; index < config.plan.length; index++) {
    const round = config.plan[index];
    const input = { flowId, goal: structuredClone(message.body), round: round.name, index, previous: structuredClone(previous) };
    emit('round_started', { flowId, requestSeq: message.seq, index, round: round.name, workers: round.workers.map((worker) => worker.target.principal) });
    // Starting every promise before awaiting implements the program's own fan-out.
    // allSettled is the round barrier even when one worker refuses or times out.
    const settled = await Promise.allSettled(round.workers.map(async (worker) => {
      const call = await outputMod.call(worker.target, worker.topic, input, {
        timeoutMs: worker.timeoutMs ?? config.timeoutMs ?? 8000,
        correlation: flowId, headers: { workflow: { flowId, round: round.name, index, worker: worker.target.principal } },
      });
      const result = { worker: worker.target.principal, topic: worker.topic, requestSeq: call.request.seq,
        responseSeq: call.response.seq, responsePrincipal: call.response.fromPrincipal, result: call.response.body };
      emit('worker_returned', { flowId, index, round: round.name, ...result });
      return result;
    }));
    const workers = settled.map((entry, position) => {
      if (entry.status === 'fulfilled') return { ...entry.value, ok: entry.value.result?.ok !== false };
      return { worker: round.workers[position].target.principal, topic: round.workers[position].topic, ok: false,
        error: { code: entry.reason.code ?? (/call response timeout/.test(entry.reason.message) ? 'WORKER_CALL_TIMEOUT' : 'WORKER_CALL_FAILED'), message: entry.reason.message } };
    });
    const ok = workers.every((worker) => worker.ok);
    rounds.push({ name: round.name, index, input, ok, workers });
    emit('round_settled', { flowId, requestSeq: message.seq, index, round: round.name, ok,
      requestSeqs: workers.map((worker) => worker.requestSeq).filter(Number.isSafeInteger),
      responseSeqs: workers.map((worker) => worker.responseSeq).filter(Number.isSafeInteger) });
    if (!ok) {
      failure = { policy: 'stop-after-current-round', failedRound: round.name, index,
        workers: workers.filter((worker) => !worker.ok).map((worker) => ({ worker: worker.worker,
          error: worker.error ?? worker.result.error ?? { code: 'WORKER_BUSINESS_FAILURE', message: 'worker returned ok:false' } })) };
      break;
    }
    previous = workers.map(({ worker, result, requestSeq, responseSeq, responsePrincipal }) => ({ worker, result, requestSeq, responseSeq, responsePrincipal }));
  }
  const outcome = { ok: !failure, program: config.name, workflowPid: process.pid, flowId,
    originalRequestSeq: message.seq, goal: message.body, completedRounds: rounds.filter((round) => round.ok).length,
    rounds, ...(failure ? { failure } : { result: { contributions: rounds.flatMap((round) => round.workers.map((worker) => ({
      round: round.name, worker: worker.worker, result: worker.result, requestSeq: worker.requestSeq, responseSeq: worker.responseSeq,
    }))), finalRound: previous } }) };
  let artifact;
  if (config.artifact) {
    const path = resolve(config.dir, `${flowId}.workflow-result.json`);
    if (!path.startsWith(resolve(config.dir) + sep)) throw new Error('workflow artifact escaped its local directory');
    await writeFile(path, JSON.stringify(outcome, null, 2) + '\n', { flag: 'wx' });
    const provided = await inputMod.uploadFile(path);
    artifact = { id: provided.id, size: provided.size, sha256: provided.sha256 };
  }
  const response = await inputMod.respond(message, { ...outcome, ...(artifact ? { artifact } : {}) },
    { ...(artifact ? { attachments: [artifact.id] } : {}), correlation: flowId });
  emit(failure ? 'workflow_failed' : 'workflow_completed', { flowId, requestSeq: message.seq, responseSeq: response.seq,
    completedRounds: outcome.completedRounds, ...(failure ? { failure } : {}), artifact });
}

for (const descriptor of config.bridges) {
  const bridge = new Bridge({ ...descriptor, bridgeId: descriptor.id, url: config.url, reconnectMs: 40 });
  mods.set(descriptor.id, bridge);
  bridge.on('error', (frame) => emit('bridge_error', { mod: descriptor.id, frame }));
  bridge.on('denied', (frame) => emit('bridge_denied', { mod: descriptor.id, frame }));
  await bridge.connect();
}
await modFor(config.inputMod).registerChannels([{ name: config.topic, publish: true, subscribe: true }]);
await modFor(config.outputMod ?? config.inputMod).registerChannels([...new Set(config.plan.flatMap((round) => round.workers.map((worker) => worker.topic)))].map((name) => ({ name, publish: true, subscribe: true })));
modFor(config.inputMod).on('delivery', (message) => {
  if (stopping || message.operation !== 'request' || message.topic !== config.topic) return;
  if (handled.has(message.seq)) { emit('duplicate', { requestSeq: message.seq }); return; }
  const task = execute(message); handled.set(message.seq, task); active.add(task);
  task.catch((error) => { emit('fatal', { requestSeq: message.seq, message: error.stack }); process.exitCode = 1; }).finally(() => active.delete(task));
});
await modFor(config.inputMod).subscribe([config.topic], { from: 0, operations: ['request'] });
emit('ready', { mods: [...mods.keys()], rounds: config.plan.map((round) => ({ name: round.name, workers: round.workers.map((worker) => worker.target.principal) })) });

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([...active]);
  await Promise.all([...mods.values()].map((bridge) => bridge.close()));
  emit('stopped');
  if (process.connected) process.disconnect();
}
process.on('message', (message) => {
  if (message.type === 'stop') { stop().catch((error) => { emit('fatal', { message: error.stack }); process.exitCode = 1; }); return; }
  if (message.type !== 'command') return;
  const command = async () => {
    if (message.op !== 'blobStatus') throw new Error('unsupported workflow fixture control command');
    return modFor(config.inputMod).blobStatus(message.args.id);
  };
  command().then((value) => emit('result', { id: message.id, value }), (error) => emit('result', { id: message.id, error: { code: error.code, message: error.message } }));
});
process.on('disconnect', () => { if (!stopping) stop().catch(() => { process.exitCode = 1; }); });
process.on('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
