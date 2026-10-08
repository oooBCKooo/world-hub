// The controller only provisions external programs and verifies their live traffic.
// The autonomous workflow process owns the plan, parallel rounds and artifact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createScene } from '../../../examples/directed-transfer/scene-harness.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';

const principal = (name) => ({ principal: name });
const entry = 'phase5/workflow/program-owned-plan';
const workerTopic = (name) => `phase5/workflow/${name}/application-kind`;
const channel = (name) => ({ name, publish: true, subscribe: true });
const names = ['workflow.caller', 'workflow.in', 'workflow.out', 'worker.alpha', 'worker.beta', 'worker.gamma'];
const plan = [
  { name: 'collect', workers: ['worker.alpha', 'worker.beta'] },
  { name: 'compare', workers: ['worker.beta', 'worker.gamma'] },
  { name: 'finalize', workers: ['worker.alpha', 'worker.gamma'] },
].map((round) => ({ ...round, workers: round.workers.map((name) => ({ target: principal(name), topic: workerTopic(name) })) }));

async function startWorkflow(scene, localPlan = plan) {
  const hub = JSON.parse(await readFile(scene.configPath, 'utf8'));
  const configPath = join(scene.dir, 'external-workflow.json');
  await writeFile(configPath, JSON.stringify({ name: 'workflow.application', dir: scene.dir, url: scene.harness.endpoint,
    bridges: ['workflow.in', 'workflow.out'].map((id) => ({ id, token: hub.acl.bridges[id].token })),
    inputMod: 'workflow.in', outputMod: 'workflow.out', topic: entry, plan: localPlan, timeoutMs: 1800, artifact: true }));
  const program = await startOwnedProgram(fileURLToPath(new URL('../../../examples/workflows/workflow-program.mjs', import.meta.url)), { args: [configPath] });
  const events = () => program.lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  scene.ownCleanup(async () => {
    const exit = await program.stop();
    assert.deepEqual(exit, { code: 0, signal: null }, program.stderr);
    assert.equal(events().filter((event) => event.event === 'fatal').length, 0);
    scene.record('external-workflow-exit', { pid: program.child.pid, exit, events: events() });
  });
  return { name: 'workflow.application', pid: program.child.pid, events,
    async blobStatus(id) {
      const commandId = randomUUID(); program.child.send({ type: 'command', id: commandId, op: 'blobStatus', args: { id } });
      const deadline = Date.now() + 10000;
      for (;;) {
        const result = events().find((event) => event.event === 'result' && event.id === commandId);
        if (result?.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
        if (result) return result.value;
        if (Date.now() >= deadline || program.exited) throw new Error('workflow owner blob status timed out or exited');
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    },
  };
}

async function setup(t, localPlan = plan) {
  const scene = await createScene(t, { principals: names });
  const caller = await scene.peer('workflow.caller');
  const workers = [];
  for (const name of names.slice(3)) {
    const worker = await scene.peer(name); workers.push(worker);
    await worker.cmd('register', { channels: [channel(workerTopic(name))] });
    await worker.cmd('behavior', { topic: workerTopic(name), onRequest: { mode: 'echo', delayMs: name === 'worker.alpha' ? 500 : 250 } });
    await worker.cmd('subscribe', { filters: [workerTopic(name)], from: 0, operations: ['request'] });
  }
  const workflow = await startWorkflow(scene, localPlan);
  const programs = [caller, workflow, ...workers];
  assert.equal(new Set([scene.harness.hub.pid, ...programs.map((program) => program.pid)]).size, 6);
  assert.ok(programs.every((program) => program.pid !== process.pid));
  scene.record('workflow-programs-independent', { hubPid: scene.harness.hub.pid, programs: programs.map(({ name, pid }) => ({ name, pid })), localPlan });
  return { scene, caller, workflow, workers };
}

async function verifyArtifact(scene, caller, workflow, response) {
  const descriptor = response.body.artifact;
  assert.deepEqual(response.attachments, [descriptor]);
  const path = join(scene.dir, `${response.seq}.caller-result.json`);
  await caller.cmd('download', { messageSeq: response.seq, id: descriptor.id, path });
  const digest = await caller.cmd('fileHash', { path });
  assert.equal(digest.sha256, descriptor.sha256); assert.equal(digest.size, descriptor.size);
  const { artifact, ...outcome } = response.body;
  const content = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(content), outcome);
  assert.equal((await workflow.blobStatus(artifact.id)).released, false);
  return { ...digest, content };
}
async function protectedMessages(scene, expected) {
  const state = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(state.log.protectedCount, expected); assert.equal(state.log.releasedCount, 0);
}
const messages = async (scene) => (await scene.harness.log()).records.filter((record) => record.kind === 'message');

test('P5-W01 an autonomous workflow program runs three parallel multi-program rounds, then returns its generated artifact to the original caller', { timeout: 60000 }, async (t) => {
  const { scene, caller, workflow, workers } = await setup(t);
  const goal = { title: '汇总分布程序共同完成的成果', systemPrompt: '来源程序提供的系统提示词', dialogue: [{ role: 'user', content: '先收集，再比较，最后生成成果' }], sentinel: 'workflow-real-input' };
  const exchange = await caller.cmd('call', { target: principal('workflow.in'), topic: entry, body: goal, timeoutMs: 15000 });
  const outcome = exchange.response.body;
  assert.equal(outcome.ok, true); assert.equal(outcome.workflowPid, workflow.pid);
  assert.equal(outcome.originalRequestSeq, exchange.request.seq); assert.deepEqual(outcome.goal, goal);
  assert.equal(outcome.completedRounds, 3); assert.equal(outcome.rounds.length, 3);
  assert.equal(outcome.result.contributions.length, 6);
  assert.equal(exchange.response.fromPrincipal, 'workflow.in'); assert.equal(exchange.response.target.principal, 'workflow.caller');
  assert.equal(exchange.response.requestSeq, exchange.request.seq);
  const log = await messages(scene); assert.equal(log.length, 14);
  const workerPids = Object.fromEntries(workers.map(({ name, pid }) => [name, pid]));
  for (let index = 0; index < outcome.rounds.length; index++) {
    const round = outcome.rounds[index];
    assert.equal(round.name, plan[index].name); assert.equal(round.index, index); assert.equal(round.ok, true);
    assert.deepEqual(round.workers.map((worker) => worker.worker), plan[index].workers.map((worker) => worker.target.principal));
    assert.deepEqual(round.input.previous, index ? outcome.rounds[index - 1].workers.map(({ worker, result, requestSeq, responseSeq, responsePrincipal }) => ({ worker, result, requestSeq, responseSeq, responsePrincipal })) : []);
    for (const worker of round.workers) {
      assert.equal(worker.result.pid, workerPids[worker.worker]); assert.equal(worker.result.program, worker.worker);
      assert.deepEqual(worker.result.input, round.input);
      const request = log.find((message) => message.seq === worker.requestSeq), reply = log.find((message) => message.seq === worker.responseSeq);
      assert.equal(request.operation, 'request'); assert.equal(request.fromPrincipal, 'workflow.out');
      assert.equal(request.target.principal, worker.worker); assert.equal(request.topic, worker.topic);
      assert.deepEqual(request.body, round.input);
      assert.equal(reply.operation, 'response'); assert.equal(reply.fromPrincipal, worker.worker);
      assert.equal(reply.target.principal, 'workflow.out'); assert.equal(reply.requestSeq, request.seq);
      assert.equal(worker.responsePrincipal, worker.worker); assert.deepEqual(reply.body, worker.result);
    }
    // Both requests were accepted before either delayed real program replied.
    assert.ok(Math.max(...round.workers.map((worker) => worker.requestSeq)) < Math.min(...round.workers.map((worker) => worker.responseSeq)));
    if (index) assert.ok(Math.min(...round.workers.map((worker) => worker.requestSeq)) > Math.max(...outcome.rounds[index - 1].workers.map((worker) => worker.responseSeq)));
  }
  assert.deepEqual(outcome.result.contributions.map(({ round, worker }) => `${round}:${worker}`), ['collect:worker.alpha', 'collect:worker.beta', 'compare:worker.beta', 'compare:worker.gamma', 'finalize:worker.alpha', 'finalize:worker.gamma']);
  assert.ok(outcome.rounds[0].workers[1].responseSeq < outcome.rounds[0].workers[0].responseSeq, 'the second parallel worker actually replies before the first');
  const artifact = await verifyArtifact(scene, caller, workflow, exchange.response);
  await protectedMessages(scene, 14);
  scene.record('autonomous-three-round-workflow-artifact', { workflowPid: workflow.pid, goal, outcome, artifact, originalRequest: exchange.request,
    finalResponseSeq: exchange.response.seq, messages: log.map(({ seq, operation, requestSeq, fromPrincipal, target, headers }) => ({ seq, operation, requestSeq, fromPrincipal, target, headers })) });
});

test('P5-W02 the workflow program stops after a middle-round business refusal or timeout, returns an explicit failure artifact and never calls a later round', { timeout: 60000 }, async (t) => {
  const { scene, caller, workflow, workers } = await setup(t);
  const gamma = workers[2];
  const refusal = { ok: false, error: { code: 'PROGRAM_DECLINED_WORK', message: '这是工作程序自己的业务拒绝。' } };
  await gamma.cmd('behavior', { topic: workerTopic(gamma.name), onRequest: { mode: 'static', value: refusal, delayMs: 300 } });
  const refusalExchange = await caller.cmd('call', { target: principal('workflow.in'), topic: entry, body: { case: 'business-refusal' }, timeoutMs: 15000 });
  const refused = refusalExchange.response.body;
  assert.equal(refused.ok, false); assert.equal(refused.completedRounds, 1); assert.equal(refused.rounds.length, 2);
  assert.equal(refused.failure.failedRound, 'compare'); assert.equal(refused.failure.policy, 'stop-after-current-round');
  assert.equal(refused.failure.workers[0].error.code, refusal.error.code); assert.equal(refused.result, undefined);
  assert.equal(refused.rounds[1].workers.length, 2); assert.ok(refused.rounds[1].workers.every((worker) => Number.isSafeInteger(worker.responseSeq)));
  assert.equal(refusalExchange.response.fromPrincipal, 'workflow.in'); assert.equal(refusalExchange.response.requestSeq, refusalExchange.request.seq);
  await verifyArtifact(scene, caller, workflow, refusalExchange.response);

  // The same target remains connected and subscribes but chooses not to reply.
  await gamma.cmd('behavior', { topic: workerTopic(gamma.name) });
  const timedExchange = await caller.cmd('call', { target: principal('workflow.in'), topic: entry, body: { case: 'no-worker-response' }, timeoutMs: 15000 });
  const timed = timedExchange.response.body;
  assert.equal(timed.ok, false); assert.equal(timed.completedRounds, 1); assert.equal(timed.rounds.length, 2);
  assert.equal(timed.failure.failedRound, 'compare'); assert.equal(timed.failure.workers[0].worker, gamma.name);
  assert.equal(timed.failure.workers[0].error.code, 'WORKER_CALL_TIMEOUT'); assert.equal(timed.result, undefined);
  assert.equal(timedExchange.response.requestSeq, timedExchange.request.seq); assert.equal(timedExchange.response.fromPrincipal, 'workflow.in');
  await verifyArtifact(scene, caller, workflow, timedExchange.response);
  await Promise.all(workers.map((worker) => worker.cmd('barrier')));
  const log = await messages(scene); assert.equal(log.length, 19);
  for (const outcome of [refused, timed]) {
    const workerRequests = log.filter((message) => message.operation === 'request' && message.body?.flowId === outcome.flowId);
    assert.equal(workerRequests.length, 4);
    assert.deepEqual(workerRequests.map((message) => message.body.round), ['collect', 'collect', 'compare', 'compare']);
    assert.equal(workerRequests.filter((message) => message.body.round === 'finalize').length, 0);
    assert.equal(workflow.events().filter((event) => event.flowId === outcome.flowId && event.event === 'round_started' && event.round === 'finalize').length, 0);
    for (const worker of outcome.rounds.flatMap((round) => round.workers).filter((worker) => worker.responseSeq)) {
      const request = log.find((message) => message.seq === worker.requestSeq), response = log.find((message) => message.seq === worker.responseSeq);
      assert.equal(request.fromPrincipal, 'workflow.out'); assert.equal(request.target.principal, worker.worker);
      assert.equal(response.fromPrincipal, worker.worker); assert.equal(response.target.principal, 'workflow.out'); assert.equal(response.requestSeq, request.seq);
    }
  }
  const unanswered = log.find((message) => message.operation === 'request' && message.body?.flowId === timed.flowId && message.body.round === 'compare' && message.target.principal === gamma.name);
  assert.ok(unanswered); assert.equal(log.filter((message) => message.operation === 'response' && message.requestSeq === unanswered.seq).length, 0);
  assert.equal(gamma.events('delivery').filter((event) => event.message.seq === unanswered.seq).length, 1);
  await protectedMessages(scene, 19);
  scene.record('external-workflow-failure-policy', { workflowPid: workflow.pid, businessFailure: refused, timeoutFailure: timed,
    unansweredRequestSeq: unanswered.seq, laterRoundRequests: 0, messages: log.map(({ seq, operation, requestSeq, fromPrincipal, target, body }) => ({ seq, operation, requestSeq, fromPrincipal, target, flowId: body?.flowId, round: body?.round })) });
});
