import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../../../examples/directed-transfer/scene-harness.mjs';
import { startFlow } from '../../../examples/workflows/flow-scene.mjs';

const options = { timeout: 60000 };
const next = (principal, topic) => ({ target: { principal }, topic });
async function messages(scene) { return (await scene.harness.log()).records.filter((record) => record.kind === 'message'); }
async function retained(scene, count) {
  const state = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(state.log.protectedCount, count); assert.equal(state.log.releasedCount, 0);
}
function distinct(scene, programs) {
  assert.equal(new Set([scene.harness.hub.pid, ...programs.map((program) => program.pid)]).size, programs.length + 1);
  assert.ok(programs.every((program) => program.pid !== process.pid));
  scene.record('independent-programs', { hubPid: scene.harness.hub.pid, programs: programs.map(({ name, pid }) => ({ name, pid })) });
}
async function linear(scene) {
  const a = await startFlow(scene, 'a');
  const b = await startFlow(scene, 'b', { bridges: [{ id: 'b.in' }, { id: 'b.out' }], rules: [{ topic: 'phase5/entry', inMod: 'b.in', outMod: 'b.out', mode: 'relay', tag: 'b' }] });
  const c = await startFlow(scene, 'c', { rules: [{ topic: 'phase5/new-kind/资料', mode: 'relay', tag: 'c' }] });
  const d = await startFlow(scene, 'd', { rules: [{ topic: 'phase5/process', mode: 'relay', tag: 'd' }] });
  const e = await startFlow(scene, 'e', { rules: [{ topic: 'phase5/final', mode: 'relay', tag: 'e' }] });
  distinct(scene, [a, b, c, d, e]);
  return { a, b, c, d, e, route: [next('c', 'phase5/new-kind/资料'), next('d', 'phase5/process'), next('e', 'phase5/final')] };
}

test('P5-F01 five independent programs pass information through the Hub at every hop using program-selected topics and two mods', options, async (t) => {
  const scene = await createScene(t, { principals: ['a', 'b.in', 'b.out', 'c', 'd', 'e'] });
  const { a, b, c, d, e, route } = await linear(scene);
  const payload = { kind: 'not-enumerated-in-hub', systemPrompt: '系统提示词来自外部程序', dialogue: [{ role: 'user', content: '逐跳转交这份信息' }], data: { n: 17 } };
  const receipt = await a.cmd('start', { ...next('b.in', 'phase5/entry'), body: { flowId: 'linear', payload, route, trace: [] } });
  const final = await e.wait((event) => event.event === 'complete' && event.body.flowId === 'linear');
  assert.deepEqual(final.body.payload, payload); assert.deepEqual(final.body.tags, ['b', 'c', 'd', 'e']);
  assert.deepEqual(final.body.trace.map((step) => step.program), ['b', 'c', 'd', 'e']);
  assert.deepEqual(final.body.trace.map((step) => step.pid), [b.pid, c.pid, d.pid, e.pid]);
  const log = await messages(scene);
  assert.deepEqual(log.map((item) => item.seq), [receipt.seq, receipt.seq + 1, receipt.seq + 2, receipt.seq + 3]);
  assert.deepEqual(log.map((item) => item.fromPrincipal), ['a', 'b.out', 'c', 'd']);
  assert.deepEqual(log.map((item) => item.target.principal), ['b.in', 'c', 'd', 'e']);
  assert.deepEqual(final.body.trace.map((step) => step.receivedSeq), log.map((item) => item.seq));
  assert.ok(log.every((item) => item.operation === 'inject'));
  assert.deepEqual(log[0].body.route, route); assert.equal(log[3].body.route.length, 0);
  await retained(scene, 4);
  scene.record('five-program-chain-completed', { receipt, messages: log, final, modsInB: (await b.cmd('snapshot')).mods });
});

test('P5-F02 twelve simultaneous information flows reach their own terminal values without crossing histories', options, async (t) => {
  const scene = await createScene(t, { principals: ['a', 'b.in', 'b.out', 'c', 'd', 'e'] });
  const { a, e, route } = await linear(scene);
  const starts = await Promise.all(Array.from({ length: 12 }, (_, i) => a.cmd('start', { ...next('b.in', 'phase5/entry'), body: { flowId: `concurrent-${i}`, payload: { value: i, sentinel: `private-${i}` }, route, trace: [] } })));
  const finals = await Promise.all(Array.from({ length: 12 }, (_, i) => e.wait((event) => event.event === 'complete' && event.body.flowId === `concurrent-${i}`)));
  const log = await messages(scene);
  assert.equal(log.length, 48); assert.equal(new Set(log.map((item) => item.seq)).size, 48);
  for (let i = 0; i < finals.length; i++) {
    const final = finals[i]; assert.deepEqual(final.body.payload, { value: i, sentinel: `private-${i}` });
    assert.deepEqual(final.body.trace.map((step) => step.program), ['b', 'c', 'd', 'e']);
    const own = log.filter((item) => item.body.flowId === `concurrent-${i}`);
    assert.equal(own.length, 4); assert.equal(own[0].seq, starts[i].seq);
    assert.deepEqual(final.body.trace.map((step) => step.receivedSeq), own.map((item) => item.seq));
  }
  await retained(scene, 48);
  scene.record('concurrent-flows-independent', { startedSeqs: starts.map((item) => item.seq), completed: finals.map((item) => ({ inputSeq: item.inputSeq, body: item.body })), messages: log.map((item) => ({ seq: item.seq, flowId: item.body.flowId, fromPrincipal: item.fromPrincipal, target: item.target })) });
});

test('P5-F03 nested calls pass A to B to C to D to E and authenticated responses return through each owning program', options, async (t) => {
  const names = ['rpc.a', 'rpc.b', 'rpc.c', 'rpc.d', 'rpc.e'];
  const scene = await createScene(t, { principals: names });
  const programs = [];
  for (let i = 0; i < names.length; i++) programs.push(await startFlow(scene, names[i], { rules: i === 0 ? [] : [{ topic: `phase5/rpc/${i}`, mode: 'delegate', next: i === 4 ? undefined : next(names[i + 1], `phase5/rpc/${i + 1}`) }] }));
  distinct(scene, programs);
  const result = await programs[0].cmd('start', { mode: 'call', ...next('rpc.b', 'phase5/rpc/1'), body: { flowId: 'rpc', payload: { query: 'provided-by-external-programs' }, trace: [] }, timeoutMs: 10000 });
  assert.deepEqual(result.response.body.trace.map((step) => step.program), names.slice(1));
  assert.deepEqual(result.response.body.trace.map((step) => step.pid), programs.slice(1).map((program) => program.pid));
  const log = await messages(scene);
  assert.deepEqual(log.map((item) => item.operation), ['request', 'request', 'request', 'request', 'response', 'response', 'response', 'response']);
  for (let i = 0; i < 4; i++) {
    assert.equal(log[i].fromPrincipal, names[i]); assert.equal(log[i].target.principal, names[i + 1]);
    const reply = log[7 - i]; assert.equal(reply.requestSeq, log[i].seq);
    assert.equal(reply.fromPrincipal, names[i + 1]); assert.equal(reply.target.principal, names[i]);
  }
  assert.equal(result.response.requestSeq, result.request.seq); await retained(scene, 8);
  scene.record('nested-call-and-return', { result, messages: log });
});

test('P5-F07 a permission refusal at the middle hop cannot fabricate delivery to the final program', options, async (t) => {
  const scene = await createScene(t, { principals: ['deny.a', 'deny.b', 'deny.c', 'deny.d'], acl: { bridges: { 'deny.c': { allow: { publish: ['phase5/deny/c'], subscribe: ['phase5/deny/c'] } } } } });
  const a = await startFlow(scene, 'deny.a');
  const b = await startFlow(scene, 'deny.b', { rules: [{ topic: 'phase5/deny/b', mode: 'relay' }] });
  const c = await startFlow(scene, 'deny.c', { rules: [{ topic: 'phase5/deny/c', mode: 'relay' }] });
  const d = await startFlow(scene, 'deny.d', { rules: [{ topic: 'phase5/deny/private-d', mode: 'relay' }] });
  distinct(scene, [a, b, c, d]);
  await a.cmd('start', { ...next('deny.b', 'phase5/deny/b'), body: { flowId: 'denied', trace: [], route: [next('deny.c', 'phase5/deny/c'), next('deny.d', 'phase5/deny/private-d')] } });
  const failure = await c.wait((event) => event.event === 'failed');
  assert.ok(failure.error.code); assert.equal(failure.receipts.length, 0);
  await d.cmd('barrier'); assert.equal(d.events('received').filter((event) => event.message.operation === 'inject').length, 0);
  assert.equal(d.events('complete').length, 0);
  const log = await messages(scene); assert.equal(log.length, 2);
  assert.deepEqual(log.map((item) => item.target.principal), ['deny.b', 'deny.c']); await retained(scene, 2);
  scene.record('middle-hop-refused', { failure, messages: log, finalProgramDeliveries: 0 });
});
