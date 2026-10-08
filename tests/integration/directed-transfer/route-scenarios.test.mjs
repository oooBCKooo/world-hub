import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../../../examples/directed-transfer/scene-harness.mjs';
import { until } from '../../helpers/hub-harness.mjs';

// The programs below are separate child processes. Their handlers and state
// live in scenario-peer; neither routing assertions nor program behavior are
// installed in the Hub. Topics are chosen by these programs for each scene.
function assertIndependent(scene, peers) {
  const pids = peers.map((peer) => peer.pid);
  assert.equal(new Set(pids).size, peers.length, 'each named program must run in a distinct process');
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.notEqual(pid, process.pid, 'a program must not be the test runner');
    assert.notEqual(pid, scene.harness.hub.pid, 'a program must not run inside the Hub');
  }
}

async function subscribe(peer, topic, operations, mod) {
  const receipt = await peer.cmd('subscribe', { mod, filters: [topic], from: 0, ...(operations ? { operations } : {}) });
  await peer.wait((event) => event.kind === 'caughtUp' && event.frame?.subscription === receipt.subscription);
  return receipt;
}

function deliveries(peer, requestSeq) {
  return peer.events('delivery').map((event) => event.message)
    .filter((message) => requestSeq === undefined || message.requestSeq === requestSeq);
}

async function received(peer, seq) {
  return (await peer.wait((event) => event.message?.seq === seq)).message;
}

async function programState(peer, topic, expected) {
  return until(async () => {
    const snapshot = await peer.cmd('snapshot');
    return JSON.stringify(snapshot.state) === JSON.stringify(expected) ? snapshot : false;
  }, { what: `${peer.name} applying its own ${topic} state` });
}

test('P4-S06 one real program uses two mods for different peers; closing one leaves the other working', { timeout: 30_000 }, async (t) => {
  const scene = await createScene(t, { principals: ['workbench.control', 'workbench.data', 'catalogue', 'journal'] });
  const catalogue = await scene.peer('catalogue');
  const journal = await scene.peer('journal');
  const workbench = await scene.peer('workbench', { bridges: [{ id: 'workbench.control' }, { id: 'workbench.data' }] });
  assertIndependent(scene, [catalogue, journal, workbench]);
  const queryTopic = 'mods/catalogue/程序自定义查询';
  const journalTopic = 'mods/journal/程序自定义写入';
  await catalogue.cmd('behavior', { topic: queryTopic, onRequest: { mode: 'echo' } });
  await journal.cmd('behavior', { topic: journalTopic, onInject: { mode: 'state' } });
  await catalogue.cmd('register', { channels: [{ name: queryTopic, publish: true, subscribe: true }] });
  await journal.cmd('register', { channels: [{ name: journalTopic, subscribe: true }] });
  await subscribe(catalogue, queryTopic, ['request']);
  await subscribe(journal, journalTopic, ['inject']);
  await workbench.cmd('register', { mod: 'workbench.control', channels: [{ name: queryTopic, publish: true, subscribe: true }] });
  await workbench.cmd('register', { mod: 'workbench.data', channels: [{ name: journalTopic, publish: true }] });

  const query = { lookup: 'program-chosen-catalogue-entry', revision: 1 };
  const result = await workbench.cmd('call', { mod: 'workbench.control', target: { principal: 'catalogue' }, topic: queryTopic, body: query, timeoutMs: 5000 });
  assert.deepEqual(result.response.body.input, query);
  assert.equal(result.response.body.program, 'catalogue');
  assert.equal(result.response.body.pid, catalogue.pid);
  assert.equal(result.response.requestSeq, result.request.seq);
  assert.equal(result.response.fromPrincipal, 'catalogue');
  const firstValue = { entry: 'before-control-disconnect', owner: 'external-journal' };
  const first = await workbench.cmd('inject', { mod: 'workbench.data', target: { principal: 'journal' }, topic: journalTopic, body: firstValue });
  await received(journal, first.seq);
  await programState(journal, journalTopic, firstValue);
  const before = await workbench.cmd('snapshot');
  assert.equal(before.pid, workbench.pid);
  assert.equal(before.mods.length, 2);
  const sessions = before.mods.map((mod) => mod.welcome.session);
  assert.equal(new Set(sessions).size, 2, 'the two mods must have separate authenticated sessions');

  await workbench.cmd('closeMod', { mod: 'workbench.control' });
  const secondValue = { entry: 'after-control-disconnect', revision: 2 };
  const second = await workbench.cmd('inject', { mod: 'workbench.data', target: { principal: 'journal' }, topic: journalTopic, body: secondValue });
  const delivered = await received(journal, second.seq);
  const finalJournal = await programState(journal, journalTopic, secondValue);
  const after = await workbench.cmd('snapshot');
  assert.equal(after.mods.find((mod) => mod.id === 'workbench.control').connected, false);
  assert.equal(after.mods.find((mod) => mod.id === 'workbench.data').connected, true);
  assert.equal(after.mods.find((mod) => mod.id === 'workbench.data').welcome.session, before.mods.find((mod) => mod.id === 'workbench.data').welcome.session);
  assert.equal(delivered.fromPrincipal, 'workbench.data');
  assert.ok(second.seq > first.seq);
  scene.record('two-mod-program-independent-disconnect', { hubPid: scene.harness.hub.pid, programPids: [workbench.pid, catalogue.pid, journal.pid], sessions, requestSeq: result.request.seq, responseSeq: result.response.seq, injectionSeqs: [first.seq, second.seq], journalState: finalJournal.state });
});

test('P4-S07 independent programs sharing a credential both respond; a session target reaches only its selected mod', { timeout: 30_000 }, async (t) => {
  const scene = await createScene(t, { principals: ['caller'], credentials: { pool: { maxConnections: 4 } } });
  const caller = await scene.peer('caller');
  const one = await scene.peer('worker-one', { bridges: [{ id: 'worker-one.mod', credential: 'pool' }] });
  const two = await scene.peer('worker-two', { bridges: [{ id: 'worker-two.mod', credential: 'pool' }] });
  assertIndependent(scene, [caller, one, two]);
  const topic = 'independent-mods/information/自定义类型';
  for (const peer of [one, two]) {
    await peer.cmd('behavior', { topic, onRequest: { mode: 'echo' } });
    await peer.cmd('register', { channels: [{ name: topic, publish: true, subscribe: true }] });
    await subscribe(peer, topic, ['request']);
  }
  await subscribe(caller, topic, ['response']);
  const broadBody = { query: 'each program provides its own answer', phase: 'fanout' };
  const broad = await caller.cmd('request', { target: { principal: 'pool' }, topic, body: broadBody });
  await caller.wait((event) => event.message?.requestSeq === broad.seq && event.message.body?.program === one.name);
  await caller.wait((event) => event.message?.requestSeq === broad.seq && event.message.body?.program === two.name);
  const replies = deliveries(caller, broad.seq);
  assert.equal(replies.length, 2, 'the Hub must forward both program responses without choosing a winner');
  assert.deepEqual(new Set(replies.map((message) => message.body.pid)), new Set([one.pid, two.pid]));
  for (const message of replies) {
    assert.equal(message.operation, 'response');
    assert.equal(message.fromPrincipal, 'pool');
    assert.deepEqual(message.body.input, broadBody);
  }
  const snapshotOne = await one.cmd('snapshot');
  const snapshotTwo = await two.cmd('snapshot');
  const firstSession = snapshotOne.mods[0].welcome.session;
  const secondSession = snapshotTwo.mods[0].welcome.session;
  assert.notEqual(firstSession, secondSession);
  assert.equal(snapshotOne.mods[0].welcome.principal, 'pool');
  assert.equal(snapshotTwo.mods[0].welcome.principal, 'pool');

  const precise = await caller.cmd('request', { target: { principal: 'pool', session: firstSession }, topic, body: { phase: 'precise' } });
  const preciseReply = await caller.wait((event) => event.message?.requestSeq === precise.seq);
  assert.equal(preciseReply.message.body.pid, one.pid);
  await two.cmd('barrier');
  await assert.rejects(two.cmd('respond', { requestSeq: precise.seq, body: { forgedByOtherSession: true } }), { code: 'RESPONSE_DENIED' });
  await two.cmd('behavior', { topic }); // the program chooses not to answer its replay twice
  const replay = await two.cmd('subscribe', { filters: [topic], from: 0, operations: ['request', 'inject'] });
  await two.wait((event) => event.kind === 'caughtUp' && event.frame?.subscription === replay.subscription);
  assert.ok(replay.subscription);
  assert.equal(deliveries(two).some((message) => message.seq === precise.seq), false);
  assert.equal(deliveries(caller, precise.seq).length, 1);
  scene.record('shared-credential-fanout-and-precise-session', { hubPid: scene.harness.hub.pid, programPids: [caller.pid, one.pid, two.pid], providerSessions: [firstSession, secondSession], broadRequestSeq: broad.seq, broadResponseSeqs: replies.map((message) => message.seq), responseProgramPids: replies.map((message) => message.body.pid), preciseRequestSeq: precise.seq, preciseResponseSeq: preciseReply.message.seq });
});

test('P4-S08 a wildcard outsider cannot read private live/history traffic or impersonate its provider', { timeout: 30_000 }, async (t) => {
  const scene = await createScene(t, { principals: ['caller', 'provider', 'outsider'] });
  const caller = await scene.peer('caller');
  const provider = await scene.peer('provider');
  const outsider = await scene.peer('outsider');
  assertIndependent(scene, [caller, provider, outsider]);
  const topic = 'mods/private/information';
  await subscribe(caller, topic, ['response']);
  await subscribe(provider, topic, ['request', 'inject']);
  await subscribe(outsider, '#');
  const query = { selectedByCaller: 'private-record', answerMustComeFrom: 'provider' };
  const request = await caller.cmd('request', { target: { principal: 'provider' }, topic, body: query });
  const privateValue = { localState: 'private-injection', programDecidesMeaning: true };
  const injection = await caller.cmd('inject', { target: { principal: 'provider' }, topic, body: privateValue });
  await received(provider, request.seq);
  await received(provider, injection.seq);
  await assert.rejects(outsider.cmd('respond', { requestSeq: request.seq, body: { result: 'forged', principal: 'provider' } }), { code: 'RESPONSE_DENIED' });
  await caller.cmd('publish', { topic, body: { result: 'a publication is not a response' }, correlation: 'same-looking' });
  const valid = await provider.cmd('respond', { requestSeq: request.seq, body: { result: 'provided-by-external-program', providerPid: provider.pid, query } });
  const response = await received(caller, valid.seq);
  assert.equal(response.operation, 'response');
  assert.equal(response.requestSeq, request.seq);
  assert.equal(response.fromPrincipal, 'provider');
  assert.equal(response.body.providerPid, provider.pid);
  assert.deepEqual(response.body.query, query);

  const liveMarker = await caller.cmd('publish', { topic: 'public/barrier', body: { visible: 'public marker after private traffic' } });
  await received(outsider, liveMarker.seq);
  const history = await outsider.cmd('subscribe', { filters: ['#'], from: 0, operations: ['request', 'inject', 'response'] });
  await outsider.wait((event) => event.kind === 'caughtUp' && event.frame?.subscription === history.subscription);
  const privateSeqs = [request.seq, injection.seq, valid.seq];
  assert.equal(deliveries(outsider).some((message) => privateSeqs.includes(message.seq)), false, 'private records must be absent from both live and historical deliveries');
  assert.equal(deliveries(outsider).filter((message) => message.subscription === history.subscription).length, 0);
  assert.deepEqual(deliveries(caller, request.seq).map((message) => message.seq), [valid.seq]);
  const records = (await scene.harness.log(100)).records.filter((record) => record.kind === 'message');
  for (const seq of privateSeqs) assert.ok(records.some((record) => record.seq === seq), 'rejected outsider access must not delete retained messages');
  scene.record('private-addressing-and-authenticated-response', { hubPid: scene.harness.hub.pid, programPids: [caller.pid, provider.pid, outsider.pid], requestSeq: request.seq, injectionSeq: injection.seq, responseSeq: valid.seq, publicMarkerSeq: liveMarker.seq, outsiderReceivedSeqs: deliveries(outsider).map((message) => message.seq), result: response.body });
});

test('P4-S09 after Hub restart new program sessions cannot claim old precise traffic; stable offline injection is later applied', { timeout: 40_000 }, async (t) => {
  const scene = await createScene(t, { principals: ['caller', 'provider'] });
  const caller = await scene.peer('caller');
  const old = await scene.peer('provider-old', { bridges: [{ id: 'provider' }] });
  assertIndependent(scene, [caller, old]);
  const topic = 'mods/offline/state';
  const oldSnapshot = await old.cmd('snapshot');
  const oldSession = oldSnapshot.mods[0].welcome.session;
  const oldHubPid = scene.harness.hub.pid;
  await old.kill();
  const precise = await caller.cmd('request', { target: { principal: 'provider', session: oldSession }, topic, body: { belongsToOldSession: true } });
  const stableValue = { restored: 'provided while the consumer was offline', count: 73 };
  const stable = await caller.cmd('inject', { target: { principal: 'provider' }, topic, body: stableValue });
  const before = (await scene.harness.log(100)).records.filter((record) => record.kind === 'message');
  assert.deepEqual(before.map((record) => record.seq), [precise.seq, stable.seq]);
  await scene.restart();
  assert.notEqual(scene.harness.hub.pid, oldHubPid);
  await until(async () => (await caller.cmd('snapshot')).mods[0].connected, { what: 'caller reconnecting to the restarted Hub' });
  const replacement = await scene.peer('provider-new', { bridges: [{ id: 'provider' }] });
  assertIndependent(scene, [caller, replacement]);
  assert.notEqual(replacement.pid, old.pid);
  const replacementSnapshot = await replacement.cmd('snapshot');
  const newSession = replacementSnapshot.mods[0].welcome.session;
  assert.notEqual(newSession, oldSession);
  await replacement.cmd('behavior', { topic, onInject: { mode: 'state' }, onRequest: { mode: 'state' } });
  await subscribe(replacement, topic, ['request', 'inject']);
  const stored = await received(replacement, stable.seq);
  const state = await programState(replacement, topic, stableValue);
  assert.equal(stored.operation, 'inject');
  assert.equal(stored.fromPrincipal, 'caller');
  assert.equal(deliveries(replacement).some((message) => message.seq === precise.seq), false);
  await assert.rejects(replacement.cmd('respond', { requestSeq: precise.seq, body: { newSessionMustNotAnswer: true } }), { code: 'RESPONSE_DENIED' });
  const readBack = await caller.cmd('call', { target: { principal: 'provider' }, topic, body: { query: 'program-owned-state' }, timeoutMs: 5000 });
  assert.equal(readBack.response.body.pid, replacement.pid);
  assert.equal(readBack.response.body.program, replacement.name);
  assert.deepEqual(readBack.response.body.state, stableValue);
  assert.equal(readBack.response.requestSeq, readBack.request.seq);
  const after = (await scene.harness.log(100)).records.filter((record) => record.kind === 'message');
  for (const seq of [precise.seq, stable.seq]) assert.ok(after.some((record) => record.seq === seq));
  scene.record('restart-stable-offline-vs-old-session', { hubPids: [oldHubPid, scene.harness.hub.pid], programPids: [caller.pid, old.pid, replacement.pid], sessions: [oldSession, newSession], preciseRequestSeq: precise.seq, stableInjectionSeq: stable.seq, receivedSeqs: deliveries(replacement).map((message) => message.seq), appliedState: state.state, readBackRequestSeq: readBack.request.seq, readBackResponseSeq: readBack.response.seq, readBackProgramPid: readBack.response.body.pid });
});
