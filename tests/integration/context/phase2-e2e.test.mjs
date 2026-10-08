import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhase2 } from '../../../examples/distributed-context/run-phase2.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { requireDshInstall } from '../../fixtures/dsh/installed-runtime.mjs';

const here = fileURLToPath(new URL('../../../examples/distributed-context/', import.meta.url));
const configTemplate = JSON.parse(readFileSync(join(here, 'programs.config.json'), 'utf8'));
async function until(fn, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`timeout: ${label}`);
}
const capture = run => {
  try { return readFileSync(run.modelFixture.capturePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const state = run => fetch(`${run.ui.ready.url}/api/state`).then(response => response.json());
const log = run => fetch(`${run.hub.ready.debugUrl}log?limit=500`).then(response => response.json());
const snapshot = run => fetch(`${run.hub.ready.debugUrl}status`).then(response => response.json());
async function setup(t) {
  const configDir = mkdtempSync(join(tmpdir(), 'peros-phase2-test-config-'));
  const config = structuredClone(configTemplate);
  const prefix = `new-kind-${process.pid}-${Date.now()}`;
  for (const key of Object.keys(config.channels)) config.channels[key] = `${prefix}/${key}`;
  config.harness.installRoot = requireDshInstall().installRoot;
  const contextText = '选定上下文：枢纽只转交信息。\nUnicode: 中文🙂 <script>ignored</script>';
  const systemPrompt = '提供者的系统提示词：保留角色和顺序，字面量 {{not_a_template}}。';
  const messages = [{ role: 'user', content: '导入的上一条用户问题' }, { role: 'assistant', content: '导入的上一条智能体回答' }];
  const systemFile = join(configDir, 'system.json'), dialogueFile = join(configDir, 'dialogue.json');
  writeFileSync(systemFile, JSON.stringify({ version: 1, systemPrompt }));
  writeFileSync(dialogueFile, JSON.stringify({ version: 1, messages }));
  config.context = { text: contextText };
  config.contextProviders[0].context = { file: systemFile, format: 'json' };
  config.contextProviders[1].context = { file: dialogueFile, format: 'json' };
  config.contextProviders[2].context = { text: contextText };
  // A fourth mod is added only in application configuration. No core changes
  // or finite business-kind registration are needed.
  config.peers['context.extra'] = { ...config.peers['context.notes'], bridgeId: 'new.independent.provider' };
  config.contextProviders.push({ id: 'new-source', peer: 'context.extra', context: { text: '新增第四个独立来源提供的资料' } });
  const hub = JSON.parse(readFileSync(join(here, 'hub.config.json'), 'utf8'));
  for (const peer of Object.values(hub.acl.bridges)) peer.allow = { publish: [`${prefix}/#`], subscribe: [`${prefix}/#`] };
  hub.acl.bridges['new.independent.provider'] = { allow: { publish: [`${prefix}/#`], subscribe: [`${prefix}/#`] } };
  hub.acl.bridges['test.observer'] = { allow: { publish: [`${prefix}/#`], subscribe: [`${prefix}/#`] } };
  const configFile = join(configDir, 'programs.json'), hubConfigFile = join(configDir, 'hub.json');
  writeFileSync(configFile, JSON.stringify(config)); writeFileSync(hubConfigFile, JSON.stringify(hub));
  const run = await startPhase2({ fixture: true, configFile, hubConfigFile, fixtureOptions: { responseDelayMs: 350 } });
  t.after(() => run.close());
  run.expected = { contextText, systemPrompt, messages };
  return run;
}

test('phase 2: distributed context providers, browser UI and genuine DSH communicate through unchanged hub', async t => {
  const run = await setup(t);
  const facts = { runDir: run.runDir, installed: JSON.parse(readFileSync(join(run.settings.harness.installRoot, 'package.json'))).version,
    model: 'deterministic test adapter; network disabled; no credentials', checks: [] };
  const check = async (name, fn) => t.test(name, async () => { await fn(); facts.checks.push(name); });
  let request, promptRecord;
  const observer = new Bridge({ url: run.hub.ready.endpoint, bridgeId: 'test.observer' });
  const observed = [];
  observer.on('delivery', message => { observed.push(message); });
  observer.on('error', () => {});
  await observer.connect();
  t.after(() => observer.close());
  await check('hub, configured context providers, UI, harness and DSH have separate PIDs', async () => {
    const pids = [...run.children.map(record => record.child.pid), run.harness.ready.dshPid];
    assert.equal(pids.length, run.settings.contextProviders.length + 4); assert.equal(new Set(pids).size, pids.length);
    const status = await snapshot(run);
    for (const role of [...run.settings.contextProviders.map(provider => provider.peer), 'ui', 'harness']) {
      const peer = status.bridges.find(peer => peer.declaredId === run.settings.peers[role].bridgeId);
      assert.ok(peer); assert.ok(peer.channels.length);
    }
  });
  await check('application channels are renamed by configuration and registered by mods', async () => {
    const status = await snapshot(run);
    const registered = status.bridges.flatMap(peer => peer.channels.map(channel => channel.name));
    for (const topic of Object.values(run.settings.channels)) assert.ok(registered.includes(topic));
    const futureTopic = `${Object.values(run.settings.channels)[0].split('/')[0]}/kind-never-seen-before`;
    await observer.registerChannels([{ name: futureTopic, publish: true, subscribe: true }]);
    await observer.subscribe([futureTopic], { from: 0 });
    await observer.publishConfirmed(futureTopic, { kind: 'a-new-kind-from-this-mod', opaque: ['中文', { noHubHandler: true }] });
    const delivered = await until(() => observed.find(record => record.topic === futureTopic), 'new opaque kind delivery');
    assert.equal(delivered.body.kind, 'a-new-kind-from-this-mod');
    await assert.rejects(observer.registerChannels([{ name: 'ungranted/topic', publish: true, subscribe: false }]), /CHANNEL_DENIED|PUBLISH_DENIED/);
  });
  await check('UI uses its own page/API and denies cross-origin invocation', async () => {
    const page = await fetch(run.ui.ready.url).then(response => response.text());
    assert.ok(page.includes('/api/prompt')); assert.ok(page.includes('textContent'));
    const denied = await fetch(`${run.ui.ready.url}/api/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: JSON.stringify({ text: 'do not dispatch' }) });
    assert.equal(denied.status, 403); assert.equal(capture(run).length, 0);
    const bad = await fetch(`${run.ui.ready.url}/api/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
    assert.equal(bad.status, 400);
  });
  await check('UI → context → UI → harness produces a prompt receipt separately from completion', async () => {
    const response = await fetch(`${run.ui.ready.url}/api/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '请回显收到的上下文与用户请求。', sessionId: 'test-session' }) });
    assert.equal(response.status, 202); request = await response.json();
    const busy = await fetch(`${run.ui.ready.url}/api/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'second while busy' }) });
    assert.equal(busy.status, 409);
    const completed = await until(async () => (await state(run)).requests.find(item => item.requestId === request.requestId && item.status === 'completed'), 'DSH completion');
    assert.ok(completed.context.text.includes(run.expected.contextText));
    assert.equal(completed.context.systemPrompt, run.expected.systemPrompt);
    assert.deepEqual(completed.context.messages, run.expected.messages);
    assert.equal(completed.context.provenance.length, 4);
    assert.ok(completed.context.text.includes('新增第四个独立来源提供的资料'));
    assert.ok(completed.messageId); assert.ok(completed.output.startsWith('fixture-echo: '));
    assert.ok(completed.output.includes(run.expected.contextText)); assert.ok(completed.output.includes(completed.text));
    assert.equal(capture(run).length, 1);
    assert.ok(capture(run)[0].promptText.includes(run.expected.contextText));
    facts.requestId = request.requestId; facts.output = completed.output;
  });
  await check('provider system prompt and dialogue reach the real agent loop with preserved roles', async () => {
    const modelMessages = capture(run)[0].messages;
    const content = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    assert.ok(modelMessages.some(message => message.role === 'system' && content(message) === run.expected.systemPrompt));
    const firstUser = modelMessages.findIndex(message => message.role === 'user' && content(message) === run.expected.messages[0].content);
    const firstAssistant = modelMessages.findIndex(message => message.role === 'assistant' && content(message) === run.expected.messages[1].content);
    assert.ok(firstUser > 0 && firstAssistant > firstUser);
    assert.equal(modelMessages.filter(message => message.role === 'user' && content(message).includes('请回显收到的上下文与用户请求。')).length, 1);
    assert.ok(!capture(run)[0].promptText.includes(run.expected.systemPrompt), 'system prompt must not be disguised as a user-message quote');
  });
  await check('Hub records both directions and never converts receipts into a business result', async () => {
    const records = (await log(run)).records;
    promptRecord = records.find(record => record.topic === run.settings.channels.harnessRequest && record.body.requestId === request.requestId);
    assert.ok(promptRecord);
    for (const key of ['contextRequest', 'contextResponse', 'harnessRequest', 'harnessResponse', 'harnessEvent']) assert.ok(records.some(record => record.topic === run.settings.channels[key]));
    assert.ok(records.some(record => record.body.kind === 'dsh.accepted'));
    assert.ok(records.some(record => record.body.frame?.params?.event?.type === 'turn/end'));
    assert.ok(records.every(record => record.type !== 'world_state'));
  });
  await check('duplicate intent does not invoke genuine DSH again', async () => {
    const receipt = await observer.publishConfirmed(promptRecord.topic, promptRecord.body, { id: 'test-repeat-intent' });
    await until(async () => (await snapshot(run)).subscriptions.some(sub => sub.bridgeId === run.settings.peers.harness.bridgeId && sub.cursor >= receipt.seq), 'repeat consumption ACK');
    assert.equal(capture(run).length, 1);
  });
  await check('UI reconnect restores its own display without reissuing the harness command', async () => {
    const oldPort = run.ui.ready.url;
    assert.equal((await run.ui.stop()).code, 0);
    run.ui = await startOwnedProgram(join(here, 'ui-program.mjs'), { args: ['--config', join(run.runDir, 'programs.runtime.json')] });
    run.children.push(run.ui);
    const restored = (await state(run)).requests.find(item => item.requestId === request.requestId);
    assert.equal(restored.status, 'completed'); assert.equal(restored.output, facts.output);
    assert.ok(oldPort); assert.equal(capture(run).length, 1);
  });
  await check('harness process restart retains deduplication but does not claim SDK session resume', async () => {
    const oldDshPid = run.harness.ready.dshPid;
    assert.equal((await run.harness.stop()).code, 0);
    run.harness = await startOwnedProgram(join(here, 'harness-program.mjs'), { args: ['--config', join(run.runDir, 'programs.runtime.json')] });
    run.children.push(run.harness);
    assert.notEqual(run.harness.ready.dshPid, oldDshPid);
    const receipt = await observer.publishConfirmed(promptRecord.topic, promptRecord.body, { id: 'test-repeat-after-restart' });
    await until(async () => (await snapshot(run)).subscriptions.some(sub => sub.bridgeId === run.settings.peers.harness.bridgeId && sub.cursor >= receipt.seq), 'restart repeat consumption ACK');
    assert.equal(capture(run).length, 1);
    facts.restartedDshPid = run.harness.ready.dshPid;
  });
  await check('dialogue provider receives the result and supplies the next turn without duplicate history', async () => {
    const response = await fetch(`${run.ui.ready.url}/api/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '第二轮独立用户消息', sessionId: request.sessionId }) });
    assert.equal(response.status, 202); const second = await response.json();
    const completed = await until(async () => (await state(run)).requests.find(item => item.requestId === second.requestId && item.status === 'completed'), 'distributed next turn');
    assert.deepEqual(completed.context.messages.slice(0, 2), run.expected.messages);
    assert.deepEqual(completed.context.messages.slice(2), [
      { role: 'user', content: '请回显收到的上下文与用户请求。' },
      { role: 'assistant', content: facts.output },
    ]);
    assert.equal(capture(run).length, 2);
    const content = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    assert.equal(capture(run)[1].messages.filter(message => message.role === 'assistant' && content(message) === facts.output).length, 1);
    assert.equal(capture(run)[1].messages.filter(message => message.role === 'user' && content(message).includes('第二轮独立用户消息')).length, 1);
    facts.secondRequestId = second.requestId;
  });
  await check('late ordinary reader extracts retained messages; reading and ACK do not delete them', async () => {
    await observer.subscribe(Object.values(run.settings.channels), { from: 0 });
    await until(() => observed.some(message => message.body.frame?.params?.event?.type === 'turn/end'), 'historical DSH completion');
    observer.flushAcks();
    const records = (await log(run)).records;
    assert.ok(records.some(record => record.seq === promptRecord.seq));
    const completion = observed.find(message => message.body.frame?.params?.event?.type === 'turn/end');
    assert.ok(records.some(record => record.seq === completion.seq));
    await assert.rejects(observer.release([promptRecord.seq]), /RELEASE_DENIED/);
  });
  await check('all owned processes exit normally including the real DSH child', async () => {
    await observer.close(); await run.close();
    assert.ok(run.children.every(record => record.exited?.code === 0));
    facts.exits = run.children.map(record => ({ pid: record.child.pid, ...record.exited }));
  });
  const evidenceDir = fileURLToPath(new URL('../../../.artifacts/evidence/distributed-context/', import.meta.url));
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `e2e-${Date.now()}-${process.pid}.json`), JSON.stringify(facts, null, 2), { flag: 'wx' });
});
