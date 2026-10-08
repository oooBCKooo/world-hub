// Real external programs exchange application-chosen data over the live Hub.
// The test controller only starts programs, triggers actions and checks evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../../../examples/directed-transfer/scene-harness.mjs';

const options = { timeout: 60_000 };
const channel = (name) => ({ name, publish: true, subscribe: true });
const target = (principal) => ({ principal });

async function listen(peer, topic, behavior, operations, extra = {}) {
  await peer.cmd('register', { channels: [channel(topic)], ...extra });
  if (behavior) await peer.cmd('behavior', { topic, ...behavior, ...extra });
  return peer.cmd('subscribe', { filters: [topic], from: 0, operations, ...extra });
}

function assertDistinctPrograms(scene, programs) {
  assert.equal(new Set(programs.map((program) => program.pid)).size, programs.length);
  assert.ok(programs.every((program) => Number.isInteger(program.pid) && program.pid !== process.pid));
  assert.ok(programs.every((program) => program.pid !== scene.harness.hub.pid));
  scene.record('separate-program-processes', { hubPid: scene.harness.hub.pid, programs: programs.map(({ name, pid }) => ({ name, pid })) });
}

test('SC-CALL-01 three distributed context programs are composed by a fourth program and injected through its second mod into a fifth', options, async (t) => {
  const topicSystem = 'scenario/distributed/system-prompt';
  const topicDialogue = 'scenario/distributed/user-dialogue';
  const topicDocuments = 'scenario/distributed/资料';
  const topicView = 'scenario/interface/assembled-context';
  const scene = await createScene(t, { principals: ['context.system', 'context.dialogue', 'context.documents', 'composer.control', 'composer.output', 'context.interface'] });
  const system = await scene.peer('context.system');
  const dialogue = await scene.peer('context.dialogue');
  const documents = await scene.peer('context.documents');
  const composer = await scene.peer('context.composer', { bridges: [{ id: 'composer.control' }, { id: 'composer.output' }] });
  const view = await scene.peer('context.interface');
  assertDistinctPrograms(scene, [system, dialogue, documents, composer, view]);

  const values = [
    { kind: 'provider-chosen-system-prompt', systemPrompt: '你是外部程序配置的助手。只依据提供的资料回答。', source: 'context.system' },
    { kind: 'provider-chosen-conversation', dialogue: [{ role: 'user', content: '请比较两份计划。' }, { role: 'assistant', content: '请提供计划。' }, { role: 'user', content: '现在资料程序已提供。' }], source: 'context.dialogue' },
    { kind: 'new-kind-not-enumerated-in-hub', documents: [{ title: '计划甲', text: '每周一次，预算 100。' }, { title: '计划乙', text: '每天一次，预算 300。' }], source: 'context.documents' },
  ];
  await listen(system, topicSystem, { onRequest: { mode: 'static', value: values[0] } }, ['request']);
  await listen(dialogue, topicDialogue, { onRequest: { mode: 'static', value: values[1] } }, ['request']);
  await listen(documents, topicDocuments, { onRequest: { mode: 'static', value: values[2] } }, ['request']);
  await listen(view, topicView, { onInject: { mode: 'state' } }, ['inject']);
  await composer.cmd('register', { mod: 'composer.control', channels: [topicSystem, topicDialogue, topicDocuments].map(channel) });
  await composer.cmd('register', { mod: 'composer.output', channels: [channel(topicView)] });

  const combined = await composer.cmd('compose', {
    mod: 'composer.control', outputMod: 'composer.output',
    sources: [
      { target: target('context.system'), topic: topicSystem, body: { scope: 'selected-system-prompt' } },
      { target: target('context.dialogue'), topic: topicDialogue, body: { scope: 'selected-dialogue' } },
      { target: target('context.documents'), topic: topicDocuments, body: { scope: 'selected-documents' } },
    ],
    target: target('context.interface'), topic: topicView,
  });
  const delivered = await view.wait((event) => event.kind === 'delivery' && event.message.seq === combined.receipt.seq);
  assert.deepEqual(combined.body.contexts, values);
  assert.equal(combined.body.pid, composer.pid);
  assert.equal(combined.body.program, composer.name);
  assert.deepEqual(delivered.message.body, combined.body);
  assert.equal(delivered.message.operation, 'inject');
  assert.equal(delivered.message.fromPrincipal, 'composer.output');
  assert.deepEqual(delivered.message.target, target('context.interface'));
  assert.equal(combined.calls.length, 3);
  combined.calls.forEach((call, index) => {
    assert.equal(call.response.requestSeq, call.request.seq);
    assert.equal(call.response.fromPrincipal, ['context.system', 'context.dialogue', 'context.documents'][index]);
  });
  const composerSnapshot = await composer.cmd('snapshot');
  assert.equal(composerSnapshot.mods.length, 2);
  assert.ok(composerSnapshot.mods.every((mod) => mod.connected));
  scene.record('distributed-context-composed-outside-hub', { composerPid: composer.pid, mods: composerSnapshot.mods.map((mod) => mod.id), contexts: combined.body.contexts, calls: combined.calls, injection: combined.receipt, receiverPid: view.pid });
});

test('SC-CALL-02 one program injects its chosen state and another queries the receiver while a wildcard observer cannot extract directed data', options, async (t) => {
  const topicWrite = 'scenario/private-state/write';
  const topicRead = 'scenario/private-state/read';
  const scene = await createScene(t, { principals: ['state.writer', 'state.reader', 'state.store', 'state.observer'] });
  const writer = await scene.peer('state.writer');
  const reader = await scene.peer('state.reader');
  const store = await scene.peer('state.store');
  const observer = await scene.peer('state.observer');
  assertDistinctPrograms(scene, [writer, reader, store, observer]);
  await listen(store, topicWrite, { onInject: { mode: 'state' } }, ['inject']);
  await listen(store, topicRead, { onRequest: { mode: 'state' } }, ['request']);
  const realtime = await observer.cmd('subscribe', { filters: ['#'], from: 0 });
  await observer.wait((event) => event.kind === 'caughtUp' && event.frame.subscription === realtime.subscription);
  const state = { revision: 7, title: '外部程序自己的状态', task: { enabled: true, values: ['alpha', 'beta'] } };
  const injection = await writer.cmd('inject', { target: target('state.store'), topic: topicWrite, body: state });
  await store.wait((event) => event.kind === 'delivery' && event.message.seq === injection.seq);
  await store.wait((event) => event.kind === 'handled' && event.messageSeq === injection.seq);
  assert.deepEqual((await store.cmd('snapshot')).state, state);
  const result = await reader.cmd('call', { target: target('state.store'), topic: topicRead, body: { query: 'current-program-state' }, timeoutMs: 5000 });
  assert.deepEqual(result.response.body.state, state);
  assert.equal(result.response.body.pid, store.pid);
  assert.equal(result.response.fromPrincipal, 'state.store');
  assert.equal(result.response.requestSeq, result.request.seq);
  const observed = await observer.cmd('snapshot');
  assert.equal(observed.deliveries.length, 0);
  const history = await observer.cmd('subscribe', { filters: ['#'], from: 0, operations: ['request', 'inject', 'response'] });
  await observer.wait((event) => event.kind === 'caughtUp' && event.frame.subscription === history.subscription);
  assert.equal((await observer.cmd('snapshot')).deliveries.length, 0);
  const log = await scene.harness.log();
  assert.equal(log.records.filter((record) => record.kind === 'message').length, 3);
  scene.record('application-state-stays-in-receiver-program', { state, receiverPid: store.pid, injection, result, observerPid: observer.pid, observerDeliveries: 0 });
});

test('SC-CALL-03 an ordinary program delegates an incoming request to another program and returns its own authenticated response', options, async (t) => {
  const topicEntry = 'scenario/delegation/entry';
  const topicLeaf = 'scenario/delegation/leaf-information';
  const scene = await createScene(t, { principals: ['chain.a', 'chain.b', 'chain.c'] });
  const caller = await scene.peer('chain.a');
  const delegate = await scene.peer('chain.b');
  const leaf = await scene.peer('chain.c');
  assertDistinctPrograms(scene, [caller, delegate, leaf]);
  const leafValue = { result: '外部 C 程序提供的资料', detail: { owner: 'chain.c', number: 37 } };
  await listen(leaf, topicLeaf, { onRequest: { mode: 'static', value: leafValue } }, ['request']);
  await delegate.cmd('register', { channels: [channel(topicLeaf)] });
  await listen(delegate, topicEntry, { onRequest: { mode: 'delegate', target: target('chain.c'), topic: topicLeaf, body: { query: 'chosen-by-delegating-program-b' } } }, ['request']);
  const result = await caller.cmd('call', { target: target('chain.b'), topic: topicEntry, body: { query: 'chosen-by-a' }, timeoutMs: 5000 });
  assert.deepEqual(result.response.body.upstream, leafValue);
  assert.equal(result.response.body.program, delegate.name);
  assert.equal(result.response.body.pid, delegate.pid);
  assert.equal(result.response.fromPrincipal, 'chain.b');
  assert.equal(result.response.requestSeq, result.request.seq);
  const leafRequest = await leaf.wait((event) => event.kind === 'delivery' && event.message.operation === 'request');
  assert.equal(leafRequest.message.fromPrincipal, 'chain.b');
  assert.deepEqual(leafRequest.message.body, { query: 'chosen-by-delegating-program-b' });
  assert.notEqual(leafRequest.message.seq, result.request.seq);
  const messages = (await scene.harness.log()).records.filter((record) => record.kind === 'message');
  assert.deepEqual(messages.map((message) => message.operation), ['request', 'request', 'response', 'response']);
  assert.equal(messages[2].requestSeq, leafRequest.message.seq);
  assert.equal(messages[3].requestSeq, result.request.seq);
  assert.deepEqual(messages[2].target, target('chain.b'));
  assert.deepEqual(messages[3].target, target('chain.a'));
  scene.record('delegation-chosen-by-program-b', { pids: { caller: caller.pid, delegate: delegate.pid, leaf: leaf.pid }, originalRequest: result.request.seq, delegatedRequest: leafRequest.message.seq, messages });
});

test('SC-CALL-04 an offline target joins after the caller times out; the original request and late reply remain extractable', options, async (t) => {
  const topic = 'scenario/offline/future-information';
  const scene = await createScene(t, { principals: ['late.caller', 'late.provider'] });
  const caller = await scene.peer('late.caller');
  await caller.cmd('register', { channels: [channel(topic)] });
  await assert.rejects(caller.cmd('call', { target: target('late.provider'), topic, body: { query: 'please-handle-whenever-you-connect' }, timeoutMs: 350 }), /call response timeout/);
  const retainedBefore = (await scene.harness.log()).records.filter((record) => record.kind === 'message');
  assert.equal(retainedBefore.length, 1);
  const request = retainedBefore[0];
  assert.equal(request.operation, 'request');
  assert.deepEqual(request.target, target('late.provider'));
  const beforeState = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(beforeState.log.protectedCount, 1);
  assert.equal(beforeState.log.releasedCount, 0);

  const provider = await scene.peer('late.provider');
  assertDistinctPrograms(scene, [caller, provider]);
  await listen(provider, topic, { onRequest: { mode: 'echo' } }, ['request']);
  const acceptedLater = await provider.wait((event) => event.kind === 'delivery' && event.message.seq === request.seq);
  assert.equal(acceptedLater.message.operation, 'request');
  assert.deepEqual(acceptedLater.message.body, request.body);
  await caller.cmd('subscribe', { filters: [topic], from: 0, operations: ['response'] });
  const lateReply = await caller.wait((event) => event.kind === 'delivery' && event.message.operation === 'response' && event.message.requestSeq === request.seq);
  assert.equal(lateReply.message.fromPrincipal, 'late.provider');
  assert.equal(lateReply.message.body.pid, provider.pid);
  assert.deepEqual(lateReply.message.body.input, request.body);
  const afterState = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(afterState.log.protectedCount, 2);
  assert.equal(afterState.log.releasedCount, 0);
  assert.equal((await scene.harness.log()).records.filter((record) => record.kind === 'message').length, 2);
  scene.record('local-timeout-does-not-cancel-or-release', { timedOutRequest: request, providerJoinedPid: provider.pid, lateReply: lateReply.message, protectedBefore: beforeState.log.protectedCount, protectedAfter: afterState.log.protectedCount, releasedAfter: afterState.log.releasedCount });
});

test('SC-CALL-05 a receiving program refuses a business request through a normal response body without turning it into a Hub denial', options, async (t) => {
  const topic = 'scenario/program-defined/refusal';
  const scene = await createScene(t, { principals: ['refusal.caller', 'refusal.provider'] });
  const caller = await scene.peer('refusal.caller');
  const provider = await scene.peer('refusal.provider');
  assertDistinctPrograms(scene, [caller, provider]);
  const refusal = { ok: false, error: { code: 'PROGRAM_DECLINES_THIS_QUERY', message: '这是提供程序自己的处理决定。', retryable: false }, businessType: 'unlimited-new-application-type' };
  await listen(provider, topic, { onRequest: { mode: 'static', value: refusal } }, ['request']);
  const result = await caller.cmd('call', { target: target('refusal.provider'), topic, body: { query: 'application-may-decline' }, timeoutMs: 5000 });
  assert.deepEqual(result.response.body, refusal);
  assert.equal(result.response.operation, 'response');
  assert.equal(result.response.fromPrincipal, 'refusal.provider');
  assert.equal(result.response.requestSeq, result.request.seq);
  assert.equal(caller.events('denied').length, 0);
  assert.equal(provider.events('denied').length, 0);
  const messages = (await scene.harness.log()).records.filter((record) => record.kind === 'message');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].operation, 'response');
  assert.deepEqual(messages[1].body, refusal);
  scene.record('business-refusal-is-an-opaque-program-response', { callerPid: caller.pid, providerPid: provider.pid, result, hubDeniedEvents: 0 });
});
