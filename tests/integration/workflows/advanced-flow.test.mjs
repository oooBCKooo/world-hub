import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../../../examples/directed-transfer/scene-harness.mjs';
import { startFlow } from '../../../examples/workflows/flow-scene.mjs';

// All handlers, branching decisions, limits and deduplication journals belong
// to independently running programs. The test conductor only triggers and checks.
const options = { timeout: 60_000 };
const target = (principal) => ({ principal });
const next = (principal, topic) => ({ target: target(principal), topic });
const complete = (program, flowId) => program.wait((event) => event.event === 'complete' && event.body?.flowId === flowId);
const handled = (program, flowId) => program.wait((event) => event.event === 'handled' && event.body?.flowId === flowId);
const messages = async (scene, flowId) => (await scene.harness.log(200)).records
  .filter((record) => record.kind === 'message' && (flowId === undefined || record.body?.flowId === flowId));

function separatePrograms(scene, programs) {
  assert.equal(new Set(programs.map((program) => program.pid)).size, programs.length);
  assert.ok(programs.every((program) => Number.isInteger(program.pid) && program.pid > 0));
  assert.ok(programs.every((program) => program.pid !== process.pid && program.pid !== scene.harness.hub.pid));
  scene.record('independent-flow-programs', { hubPid: scene.harness.hub.pid, programs: programs.map(({ name, pid }) => ({ name, pid })) });
}

async function retained(scene, expected) {
  const state = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(state.log.protectedCount, expected, 'program handling must not release accepted information');
  assert.equal(state.log.releasedCount, 0);
  return { protectedCount: state.log.protectedCount, releasedCount: state.log.releasedCount };
}

test('P5-F04 programs revisit previous programs and terminate either their finite route or their own loop budget', options, async (t) => {
  const topic = 'phase5/program-chosen/循环回访';
  const ids = ['loop.a', 'loop.b', 'loop.c', 'loop.d'];
  const scene = await createScene(t, { principals: ids });
  const budget = 6;
  const a = await startFlow(scene, 'loop.a', { rules: [{ topic, mode: 'relay', next: next('loop.b', topic), maxSteps: budget }] });
  const b = await startFlow(scene, 'loop.b', { rules: [{ topic, mode: 'relay', next: next('loop.c', topic), maxSteps: budget }] });
  const c = await startFlow(scene, 'loop.c', { rules: [{ topic, mode: 'relay', next: next('loop.a', topic), maxSteps: budget }] });
  const d = await startFlow(scene, 'loop.d', { rules: [{ topic, mode: 'relay', maxSteps: budget }] });
  separatePrograms(scene, [a, b, c, d]);

  const payload = { instruction: '程序可以再次拜访自己或上游', arbitraryKind: { list: [1, { text: '未硬编码到枢纽的业务' }], active: true } };
  const finiteId = 'finite-route-with-revisits';
  await a.cmd('start', { target: target('loop.b'), topic, body: { flowId: finiteId, payload, route: [next('loop.c', topic), next('loop.a', topic), next('loop.b', topic), next('loop.d', topic)] } });
  const finite = await complete(d, finiteId);
  assert.deepEqual(finite.body.payload, payload);
  assert.deepEqual(finite.body.trace.map((entry) => entry.program), ['loop.b', 'loop.c', 'loop.a', 'loop.b', 'loop.d']);
  const bVisits = finite.body.trace.filter((entry) => entry.program === 'loop.b');
  assert.equal(bVisits.length, 2);
  assert.equal(bVisits[0].pid, b.pid);
  assert.equal(bVisits[1].pid, b.pid);
  assert.notEqual(bVisits[0].receivedSeq, bVisits[1].receivedSeq, 'a legitimate revisit is a different accepted message');
  const finiteRecords = await messages(scene, finiteId);
  assert.equal(finiteRecords.length, 5);
  assert.deepEqual(finiteRecords.map((record) => record.target.principal), ['loop.b', 'loop.c', 'loop.a', 'loop.b', 'loop.d']);
  assert.ok(finiteRecords.every((record) => record.operation === 'inject'));
  assert.deepEqual(finite.body.trace.map((entry) => entry.receivedSeq), finiteRecords.map((record) => record.seq));
  assert.deepEqual(finite.body.trace.map((entry) => entry.fromPrincipal), finiteRecords.map((record) => record.fromPrincipal));

  const boundedId = 'program-budget-for-fixed-next-loop';
  await a.cmd('start', { target: target('loop.b'), topic, body: { flowId: boundedId, payload } });
  const stopped = await b.wait((event) => event.event === 'stopped' && event.body?.flowId === boundedId);
  assert.equal(stopped.body.trace.length, budget);
  assert.deepEqual(stopped.body.trace.map((entry) => entry.program), ['loop.b', 'loop.c', 'loop.a', 'loop.b', 'loop.c', 'loop.a']);
  assert.deepEqual(stopped.body.payload, payload);
  await Promise.all([a, b, c, d].map((program) => program.cmd('barrier')));
  const loopRecords = await messages(scene, boundedId);
  assert.equal(loopRecords.length, budget + 1, 'the stopping program receives the final message and sends no successor');
  assert.deepEqual(loopRecords.map((record) => record.target.principal), ['loop.b', 'loop.c', 'loop.a', 'loop.b', 'loop.c', 'loop.a', 'loop.b']);
  assert.equal(d.events().some((event) => event.body?.flowId === boundedId || event.message?.body?.flowId === boundedId), false);
  assert.equal(b.events('complete').some((event) => event.body?.flowId === boundedId), false);
  scene.record('application-revisit-and-loop-termination', { finiteTrace: finite.body.trace, finiteSeqs: finiteRecords.map(({ seq }) => seq), budget, stopped, boundedSeqs: loopRecords.map(({ seq }) => seq), retention: await retained(scene, 12) });
});

test('P5-F05 an external fork creates two branches and an external join merges their complete bodies before forwarding', options, async (t) => {
  const topicFork = 'phase5/任意信息类型/fork';
  const topicBranch = 'phase5/任意信息类型/branch';
  const topicJoin = 'phase5/任意信息类型/join';
  const topicResult = 'phase5/任意信息类型/result';
  const ids = ['fork.seed', 'fork.splitter', 'fork.c', 'fork.d', 'fork.merge', 'fork.result'];
  const scene = await createScene(t, { principals: ids });
  const seed = await startFlow(scene, 'fork.seed', { rules: [] });
  const splitter = await startFlow(scene, 'fork.splitter', { rules: [{ topic: topicFork, mode: 'fork', branches: [{ id: 'c', ...next('fork.c', topicBranch) }, { id: 'd', ...next('fork.d', topicBranch) }] }] });
  const c = await startFlow(scene, 'fork.c', { rules: [{ topic: topicBranch, mode: 'relay', tag: 'c-program-contribution', next: next('fork.merge', topicJoin) }] });
  const d = await startFlow(scene, 'fork.d', { rules: [{ topic: topicBranch, mode: 'relay', tag: 'd-program-contribution', next: next('fork.merge', topicJoin) }] });
  const merge = await startFlow(scene, 'fork.merge', { rules: [{ topic: topicJoin, mode: 'join', expectedBranches: ['c', 'd'], next: next('fork.result', topicResult) }] });
  const result = await startFlow(scene, 'fork.result', { rules: [{ topic: topicResult, mode: 'relay' }] });
  separatePrograms(scene, [seed, splitter, c, d, merge, result]);
  const flowId = 'independent-fork-and-join';
  const payload = { comparison: ['甲', '乙'], data: { retain: ['provider', 'chosen', 'content'] } };
  await seed.cmd('start', { target: target('fork.splitter'), topic: topicFork, body: { flowId, payload } });
  const final = await complete(result, flowId);
  await handled(merge, flowId);
  assert.deepEqual(final.body.payload, payload);
  assert.deepEqual(Object.keys(final.body.branches).sort(), ['c', 'd']);
  for (const [id, program] of [['c', c], ['d', d]]) {
    const branch = final.body.branches[id];
    assert.equal(branch.flowId, flowId);
    assert.equal(branch.branch, id);
    assert.deepEqual(branch.payload, payload);
    assert.deepEqual(branch.tags, [`${id}-program-contribution`]);
    assert.deepEqual(branch.trace.map((entry) => entry.program), ['fork.splitter', program.name]);
    assert.equal(branch.trace[1].pid, program.pid);
    assert.notEqual(branch.trace[1].pid, scene.harness.hub.pid);
  }
  assert.deepEqual(final.body.trace.map((entry) => entry.program), ['fork.splitter', 'fork.merge', 'fork.result']);
  assert.equal(final.body.trace[1].pid, merge.pid, 'the joining result is produced by its external program');
  assert.ok(merge.events('waiting').some((event) => event.body?.flowId === flowId || event.flowId === flowId));
  const records = await messages(scene, flowId);
  assert.equal(records.length, 6);
  assert.ok(records.every((record) => record.operation === 'inject'));
  const findEdges = (from, to) => records.filter((record) => record.fromPrincipal === from && record.target.principal === to);
  for (const [from, to] of [['fork.seed', 'fork.splitter'], ['fork.splitter', 'fork.c'], ['fork.splitter', 'fork.d'], ['fork.c', 'fork.merge'], ['fork.d', 'fork.merge'], ['fork.merge', 'fork.result']]) assert.equal(findEdges(from, to).length, 1);
  const mergeOutput = findEdges('fork.merge', 'fork.result')[0];
  assert.ok(mergeOutput.seq > findEdges('fork.c', 'fork.merge')[0].seq);
  assert.ok(mergeOutput.seq > findEdges('fork.d', 'fork.merge')[0].seq, 'the program waits for both branch deliveries before sending the joined value');
  assert.deepEqual(mergeOutput.body.branches, final.body.branches);
  assert.equal(merge.events('handled').filter((event) => event.body?.flowId === flowId && event.receipts?.length > 0).length, 1);
  scene.record('fork-and-join-outside-hub', { programPids: { splitter: splitter.pid, branches: [c.pid, d.pid], merge: merge.pid, result: result.pid }, messages: records, joinedBody: final.body, retention: await retained(scene, 6) });
});

test('P5-F06 a retained offline intermediate hop survives Hub restart and a program journal suppresses replay forwarding', options, async (t) => {
  const topic = 'phase5/offline/restart/业务自选';
  const ids = ['resume.a', 'resume.b', 'resume.c', 'resume.d'];
  const scene = await createScene(t, { principals: ids });
  const a = await startFlow(scene, 'resume.a', { rules: [] });
  const ruleB = { topic, mode: 'relay', next: next('resume.c', topic) };
  const originalB = await startFlow(scene, 'resume.b', { rules: [ruleB], journal: 'resume-b.json' });
  const d = await startFlow(scene, 'resume.d', { rules: [{ topic, mode: 'relay' }] });
  separatePrograms(scene, [a, originalB, d]);
  const flowId = 'offline-hop-with-program-replay-journal';
  const payload = { futureConsumer: 'resume.c', storedUntilExtracted: true, unrelatedBusiness: { amount: 107 } };
  await a.cmd('start', { target: target('resume.b'), topic, body: { flowId, payload } });
  const forwarded = await handled(originalB, flowId);
  assert.equal(forwarded.receipts.length, 1);
  const before = await messages(scene, flowId);
  assert.equal(before.length, 2);
  assert.equal(before[0].target.principal, 'resume.b');
  assert.equal(before[1].fromPrincipal, 'resume.b');
  assert.equal(before[1].target.principal, 'resume.c');
  assert.equal(before[1].seq, forwarded.receipts[0].seq);
  assert.deepEqual(before[1].body.trace.map((entry) => entry.program), ['resume.b']);
  assert.equal(d.events('complete').some((event) => event.body?.flowId === flowId), false, 'an offline intermediate program has not run its next step');
  const originalHubPid = scene.harness.hub.pid;
  await originalB.stop(); // Controlled restart, after completion and journal checkpoint.
  await scene.restart();
  assert.notEqual(scene.harness.hub.pid, originalHubPid);
  const replacementB = await startFlow(scene, 'resume.b', { rules: [ruleB], journal: 'resume-b.json' });
  assert.notEqual(replacementB.pid, originalB.pid);
  const duplicate = await replacementB.wait((event) => event.event === 'duplicate' && event.inputSeq === before[0].seq);
  await replacementB.cmd('barrier');
  const afterReplay = await messages(scene, flowId);
  assert.deepEqual(afterReplay.map(({ seq }) => seq), before.map(({ seq }) => seq));
  assert.equal(replacementB.events('handled').some((event) => event.inputSeq === before[0].seq), false, 'the external program journal avoids applying the old input again');

  const c = await startFlow(scene, 'resume.c', { rules: [{ topic, mode: 'relay', next: next('resume.d', topic) }] });
  separatePrograms(scene, [a, replacementB, c, d]);
  const acceptedOffline = await c.wait((event) => event.event === 'received' && event.message?.seq === before[1].seq);
  assert.deepEqual(acceptedOffline.message.body, before[1].body);
  const final = await complete(d, flowId);
  assert.deepEqual(final.body.payload, payload);
  assert.deepEqual(final.body.trace.map((entry) => entry.program), ['resume.b', 'resume.c', 'resume.d']);
  assert.deepEqual(final.body.trace.map((entry) => entry.pid), [originalB.pid, c.pid, d.pid]);
  const records = await messages(scene, flowId);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.target.principal), ['resume.b', 'resume.c', 'resume.d']);
  assert.equal(records.filter((record) => record.fromPrincipal === 'resume.b').length, 1);
  assert.deepEqual(records.slice(0, 2).map(({ seq }) => seq), before.map(({ seq }) => seq), 'old history is retained even when its consumer journal suppresses a replay');
  const journal = await replacementB.cmd('snapshot');
  assert.ok(journal.seen.some((entry) => entry.inputSeq === before[0].seq));
  scene.record('offline-hop-restart-and-external-deduplication', { hubPids: [originalHubPid, scene.harness.hub.pid], originalBPid: originalB.pid, replacementBPid: replacementB.pid, offlineConsumerPid: c.pid, originalForward: before[1].seq, duplicate, finalBody: final.body, retainedSeqs: records.map(({ seq }) => seq), seenInputs: journal.seen.map(({ inputSeq }) => inputSeq), guarantee: 'controlled program restart after completed journal checkpoint; no crash-window exactly-once claim', retention: await retained(scene, 3) });
});
