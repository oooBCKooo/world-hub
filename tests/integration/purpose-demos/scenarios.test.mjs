import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPurposeDemo } from '../../../examples/purpose-demos/run-demo.mjs';
import { principalFor } from '../../../examples/purpose-demos/profiles.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await pause(80); }
  throw new Error('演示业务结果未在有限等待内出现');
}
async function client(session) {
  const base = session.ready.url;
  const state = async () => {
    const response = await fetch(new URL('api/state', base));
    assert.equal(response.status, 200); return response.json();
  };
  const token = (await state()).operationToken;
  const action = async (id, body) => {
    const response = await fetch(new URL('api/action', base), { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-token': token },
      body: JSON.stringify({ id, ...(body === undefined ? {} : { body }) }), signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  };
  return { state, action };
}
function responseBody(result) {
  assert.ok(result.receipt.seq > 0); assert.equal(result.response.operation, 'response');
  assert.equal(result.response.requestSeq, result.receipt.seq); assert.equal(result.response.fromPrincipal, result.target.principal);
  return result.response.body;
}
async function withSession(profile, run) {
  const parent = await mkdtemp(join(tmpdir(), `world-hub-purpose-${profile}-`));
  const session = await startPurposeDemo({ profile, stateDirectory: join(parent, 'session') });
  try { await run(session, await client(session)); }
  finally {
    await session.close();
    for (const child of session.children) {
      assert.ok(child.exited, `owned process ${child.child.pid} must exit`);
      assert.equal(child.exited.code, 0, `${child.stderr}\n${JSON.stringify(child.exited)}`);
    }
    for (const pid of session.ready.pids) assert.throws(() => process.kill(pid, 0), `owned pid ${pid} remains alive`);
    const stopped = JSON.parse(await readFile(join(session.ready.stateDirectory, 'stopped.json'), 'utf8'));
    assert.deepEqual(stopped.pids, session.ready.pids);
  }
}

test('多源事件台：独立来源、同程序双桥、请求与注入影响真实后续数据', { timeout: 60000 }, async () => {
  await withSession('event-desk', async (session, app) => {
    const sensor = session.ready.peers.find(peer => peer.id === 'sensor');
    assert.equal(sensor.ready.bridges.length, 2);
    assert.deepEqual(new Set(sensor.ready.bridges.map(bridge => bridge.principal)), new Set([principalFor('event-desk', 'sensor')]));
    assert.equal(new Set(sensor.ready.bridges.map(bridge => bridge.session)).size, 2);
    assert.equal(new Set(sensor.ready.bridges.map(bridge => bridge.bridgeId)).size, 2);
    assert.ok(sensor.ready.bridges.find(bridge => bridge.id === 'control').subscriptions.length);
    await until(app.state, data => data.events.some(event => event.body?.kind === 'demo.summary-updated' && event.body.latest.sensor && event.body.latest.market));
    const first = responseBody(await app.action('summary'));
    assert.equal(first.ok, true); assert.ok(first.latest.sensor.seq > 0 && first.latest.market.seq > 0);
    assert.notEqual(first.latest.sensor.from, first.latest.market.from);
    const configured = responseBody(await app.action('sensor-settings'));
    assert.equal(configured.offset, 3); assert.equal(configured.intervalMs, 900);
    assert.equal(responseBody(await app.action('sensor-reading')).offset, 3);
    const invalid = responseBody(await app.action('sensor-settings', { command: 'configure', intervalMs: 0 }));
    assert.equal(invalid.ok, false); assert.match(invalid.error, /intervalMs/);
    assert.equal(responseBody(await app.action('sensor-reading')).intervalMs, 900);
    const injected = await app.action('sensor-inject');
    assert.equal(injected.response, null);
    await until(app.state, data => data.events.some(event => event.body?.kind === 'demo.source-configured' && event.body.offset === 8 && event.body.receivedSeq === injected.receipt.seq));
    assert.equal(responseBody(await app.action('sensor-reading')).offset, 8);
    const market = responseBody(await app.action('market-settings')); assert.equal(market.base, 130);
    await until(app.state, data => data.events.some(event => event.body?.kind === 'demo.summary-updated'
      && event.body.latest.sensor?.value.temperature > 26 && event.body.latest.market?.value.price >= 126));
    const final = responseBody(await app.action('summary'));
    assert.ok(final.received > first.received); assert.ok(final.latest.sensor.value.temperature > 26); assert.ok(final.latest.market.value.price >= 126);
    assert.ok(session.children.every(child => !child.exited));
  });
});

test('分布上下文助手：三来源改值进入后续组装，模板执行与对话保存由外部程序完成', { timeout: 60000 }, async () => {
  await withSession('modular-assistant', async (session, app) => {
    const initial = responseBody(await app.action('compose'));
    assert.equal(initial.ok, true); assert.equal(initial.mode, 'deterministic-template'); assert.equal(initial.modelInvoked, false);
    const systemPrompt = '测试系统提示：保留完整来源并独立替换程序。';
    const text = '测试资料：界面、对话、材料与执行器各有自己的 mod。';
    const priorUser = '这条用户对话来自独立的 dialogue 程序。', prompt = '请展示三个来源的实际值。';
    assert.equal(responseBody(await app.action('system-update', { command: 'set', systemPrompt })).systemPrompt, systemPrompt);
    assert.equal(responseBody(await app.action('dialogue-update', { command: 'append-user', content: priorUser })).messages.at(-1).content, priorUser);
    assert.equal(responseBody(await app.action('material-update', { command: 'set', text })).text, text);
    const invalid = responseBody(await app.action('compose', { prompt: '' }));
    assert.equal(invalid.ok, false); assert.match(invalid.error, /prompt/);
    const result = responseBody(await app.action('compose', { prompt }));
    assert.equal(result.ok, true); assert.equal(result.context.systemPrompt, systemPrompt); assert.equal(result.context.material, text);
    assert.ok(result.context.messages.some(message => message.role === 'user' && message.content === priorUser));
    assert.equal(result.context.messages.at(-1).content, prompt);
    assert.ok(result.context.messages.some(message => message.role === 'assistant' && message.content === initial.answer));
    for (const part of [systemPrompt, text, prompt]) assert.ok(result.answer.includes(part));
    assert.deepEqual(result.sources.map(source => source.provider), ['system', 'dialogue', 'material']);
    for (const source of result.sources) { assert.equal(source.principal, principalFor('modular-assistant', source.provider)); assert.ok(source.requestSeq < source.responseSeq); assert.ok(source.bridge); }
    assert.equal(result.harness.principal, principalFor('modular-assistant', 'harness'));
    assert.ok(result.harness.requestSeq < result.harness.responseSeq);
    const state = await app.state();
    assert.ok(state.events.some(event => event.body?.kind === 'demo.context-assembled' && event.body.context.systemPrompt === systemPrompt && event.body.context.material === text));
    const saved = JSON.parse(await readFile(join(session.ready.stateDirectory, 'programs/composer/last-result.json'), 'utf8'));
    assert.equal(saved.completed, 2); assert.equal(saved.lastResult.answer, result.answer);
    const dialogue = JSON.parse(await readFile(join(session.ready.stateDirectory, 'programs/dialogue/context-state.json'), 'utf8'));
    assert.equal(dialogue.messages.at(-1).role, 'assistant'); assert.equal(dialogue.messages.at(-1).content, result.answer);
    assert.ok(session.children.every(child => !child.exited));
  });
});

test('数字世界：外部导演完成三轮多程序调用，状态、NPC倾向与结果可验证', { timeout: 60000 }, async () => {
  await withSession('digital-world', async (session, app) => {
    const result = responseBody(await app.action('advance'));
    assert.equal(result.ok, true); assert.equal(result.rounds, 3); assert.equal(result.timeline.length, 3); assert.equal(result.finalState.turn, 3);
    assert.deepEqual(result.initialState, { turn: 0, energy: 8, inventory: 0, position: 0, weather: '晴朗' });
    assert.deepEqual(result.timeline.map(step => step.world.turn), [1, 2, 3]);
    assert.deepEqual(result.receipts.map(receipt => receipt.program), ['state', 'npc', 'rules', 'state', 'npc', 'rules', 'state', 'npc', 'rules', 'state']);
    for (const receipt of result.receipts) { assert.equal(receipt.principal, principalFor('digital-world', receipt.program)); assert.ok(receipt.requestSeq < receipt.responseSeq); assert.ok(receipt.bridge); }
    const invalid = responseBody(await app.action('advance', { rounds: 0, action: 'scout' }));
    assert.equal(invalid.ok, false); assert.match(invalid.error, /rounds/);
    assert.equal(responseBody(await app.action('world-snapshot')).world.turn, 3);
    const injected = await app.action('npc-mood'); assert.equal(injected.response, null);
    await until(app.state, data => data.events.some(event => event.body?.kind === 'demo.npc-configured' && event.body.mood === 'friendly' && event.body.receivedSeq === injected.receipt.seq));
    const rested = responseBody(await app.action('rest'));
    assert.equal(rested.finalState.turn, 5); assert.ok(rested.finalState.energy > result.finalState.energy);
    assert.ok(rested.timeline.every(step => step.npc.includes('两份补给')));
    const world = responseBody(await app.action('world-snapshot')); assert.deepEqual(world.world, rested.finalState);
    const saved = JSON.parse(await readFile(join(session.ready.stateDirectory, 'programs/state/world-state.json'), 'utf8'));
    assert.deepEqual(saved.world, rested.finalState);
    const state = await app.state();
    assert.ok(state.events.filter(event => event.body?.kind === 'demo.world-round').length >= 5);
    const reset = responseBody(await app.action('reset')); assert.equal(reset.world.turn, 0); assert.equal(reset.world.energy, 8);
    assert.ok(session.children.every(child => !child.exited));
  });
});

test('事件来源扩展：独立交通入口在操作后注册新主题，外部汇总纳入真实第三来源，暂停保留既有读数', { timeout: 60000 }, async () => {
  await withSession('event-desk', async (session, app) => {
    const traffic = session.ready.peers.find(peer => peer.id === 'traffic');
    const aggregator = session.ready.peers.find(peer => peer.id === 'aggregator');
    assert.notEqual(traffic.pid, aggregator.pid);
    assert.equal(traffic.ready.programEntry, 'traffic-source.mjs');
    assert.ok(session.children.find(child => child.child.pid === traffic.pid).child.spawnargs.some(arg => arg.endsWith('traffic-source.mjs')));
    assert.ok(!traffic.ready.bridges[0].channels.some(channel => channel.name === 'demo/event-desk/traffic/sample'));
    await until(app.state, data => data.events.some(event => event.body?.kind === 'demo.summary-updated' && event.body.latest.sensor && event.body.latest.market));
    const before = responseBody(await app.action('summary'));
    assert.deepEqual(Object.keys(before.latest).sort(), ['market', 'sensor']);
    assert.equal(responseBody(await app.action('traffic-reading')).topicRegistered, false);
    const enabled = responseBody(await app.action('traffic-enable'));
    assert.equal(enabled.enabled, true); assert.equal(enabled.topicRegistered, true);
    assert.equal(enabled.principal, principalFor('event-desk', 'traffic'));
    assert.equal(enabled.declaredTopic, 'demo/event-desk/traffic/sample');
    await until(app.state, data => data.events.some(event => event.body?.kind === 'demo.summary-updated' && event.body.latest.traffic));
    const after = responseBody(await app.action('summary'));
    assert.deepEqual(Object.keys(after.latest).sort(), ['market', 'sensor', 'traffic']);
    assert.equal(after.latest.traffic.value.kind, 'demo.traffic-reading');
    assert.ok(after.latest.traffic.value.vehicles > 0);
    // Publish deliveries expose the actual bridge, while directed response
    // envelopes above prove the source's authenticated principal.
    assert.equal(after.latest.traffic.principal, undefined);
    assert.equal(after.latest.traffic.from, traffic.ready.bridges[0].bridgeId);
    assert.equal(after.latest.traffic.topic, enabled.declaredTopic);
    const disabled = responseBody(await app.action('traffic-disable'));
    assert.equal(disabled.enabled, false); assert.equal(disabled.topicRegistered, true);
    await pause(1400);
    assert.equal(responseBody(await app.action('traffic-reading')).count, disabled.count);
    assert.ok(responseBody(await app.action('summary')).latest.traffic.seq >= after.latest.traffic.seq);
    const state = await app.state();
    assert.ok(state.hubStatus.bridges.find(bridge => bridge.principal === traffic.ready.principal).channels.some(channel => channel.name === enabled.declaredTopic));
  });
});

test('真实组合与程序替换：第四个独立材料来源进入上下文，另一个入口的执行器遵守同一合同返回不同成果', { timeout: 60000 }, async () => {
  await withSession('modular-assistant', async (session, app) => {
    const original = session.ready.peers.find(peer => peer.id === 'harness');
    const replacement = session.ready.peers.find(peer => peer.id === 'checklist');
    const extension = session.ready.peers.find(peer => peer.id === 'extension');
    assert.notEqual(original.pid, replacement.pid);
    assert.equal(original.ready.programEntry, 'peer.mjs');
    assert.equal(replacement.ready.programEntry, 'checklist-harness.mjs');
    assert.equal(extension.ready.programEntry, 'extension-material.mjs');
    assert.ok(session.children.find(child => child.child.pid === replacement.pid).child.spawnargs.some(arg => arg.endsWith('checklist-harness.mjs')));
    const baseline = responseBody(await app.action('compose'));
    assert.equal(baseline.sources.length, 3); assert.equal(baseline.harnessProvider, 'harness');
    const text = '新材料源独立提供的约束：替换时保留合同和实际来源回执。';
    assert.equal(responseBody(await app.action('extension-update', { command: 'set', text })).text, text);
    const extended = responseBody(await app.action('compose-extension'));
    assert.deepEqual(extended.sources.map(source => source.provider), ['system', 'dialogue', 'material', 'extension']);
    const extensionReceipt = extended.sources.at(-1);
    assert.equal(extensionReceipt.principal, principalFor('modular-assistant', 'extension'));
    assert.equal(extensionReceipt.bridge, extension.ready.bridges[0].bridgeId);
    assert.ok(extensionReceipt.requestSeq < extensionReceipt.responseSeq);
    assert.equal(extended.context.materials.at(-1).text, text); assert.ok(extended.answer.includes(text));
    assert.equal(extended.executorImplementation, 'context-echo-template');
    const replaced = responseBody(await app.action('compose-checklist'));
    assert.equal(replaced.harnessProvider, 'checklist');
    assert.equal(replaced.harness.principal, principalFor('modular-assistant', 'checklist'));
    assert.equal(replaced.harness.bridge, replacement.ready.bridges[0].bridgeId);
    assert.ok(replaced.harness.requestSeq < replaced.harness.responseSeq);
    assert.equal(replaced.mode, 'deterministic-checklist'); assert.equal(replaced.executorImplementation, 'source-checklist');
    assert.equal(replaced.modelInvoked, false); assert.equal(replaced.checklist.length, 4);
    assert.deepEqual(replaced.context.materials, extended.context.materials);
    assert.deepEqual(replaced.context.systemPrompt, extended.context.systemPrompt);
    assert.notEqual(replaced.answer, extended.answer); assert.match(replaced.answer, /模块检查清单/); assert.ok(replaced.answer.includes(text));
    assert.ok(replaced.context.messages.some(item => item.role === 'assistant' && item.content === extended.answer));
    const templateState = JSON.parse(await readFile(join(session.ready.stateDirectory, 'programs/harness/harness-state.json'), 'utf8'));
    const checklistState = JSON.parse(await readFile(join(session.ready.stateDirectory, 'programs/checklist/checklist-state.json'), 'utf8'));
    assert.equal(templateState.completed, 2); assert.equal(checklistState.completed, 1);
    assert.equal(checklistState.lastResult.answer, replaced.answer);
    const invalid = responseBody(await app.action('compose', { prompt: '不能选择未接入程序', harnessProvider: 'missing' }));
    assert.equal(invalid.ok, false); assert.match(invalid.error, /harnessProvider/);
  });
});
