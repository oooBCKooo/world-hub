import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScene } from '../../../examples/directed-transfer/scene-harness.mjs';
import { createDshFixture } from '../../fixtures/dsh/dsh-fixture.mjs';
import { requireDshInstall } from '../../fixtures/dsh/installed-runtime.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';

const script = fileURLToPath(new URL('../../../examples/directed-transfer/dsh-scenario-program.mjs', import.meta.url));
const { installRoot } = requireDshInstall();
const channel = (name) => ({ name, publish: true, subscribe: true });
const messageText = (message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

test('SC-APP-DSH-01 distributed context is called by an external UI, run by actual local DSH, responded and injected back into display and next-turn dialogue', { timeout: 60_000 }, async (t) => {
  const owned = [];
  const stopOwned = async () => {
    for (const program of [...owned].reverse()) {
      const exit = await program.stop();
      assert.equal(exit.code, 0, `owned external program ${program.child.pid} must stop normally`);
      assert.equal(exit.signal, null);
    }
  };
  try {
  // No skip: absence of the installed local harness is a reported failure.
  const installed = JSON.parse(await readFile(join(installRoot, 'package.json'), 'utf8'));
  assert.equal(installed.name, '@deepseek-ai/dsh');
  const names = ['dsh.source.system', 'dsh.source.dialogue', 'dsh.source.notes', 'dsh.ui.control', 'dsh.ui.output', 'dsh.harness', 'dsh.display', 'dsh.trigger'];
  const topics = { system: 'scenario/actual-dsh/system', dialogue: 'scenario/actual-dsh/dialogue', notes: 'scenario/actual-dsh/notes',
    invoke: 'scenario/actual-dsh/ui-command', harness: 'scenario/actual-dsh/run', display: 'scenario/actual-dsh/display', writeDialogue: 'scenario/actual-dsh/update-dialogue' };
  const scene = await createScene(t, { principals: names });
  scene.ownCleanup(stopOwned);
  const fixture = await createDshFixture({ installRoot, tempRoot: scene.dir, responsePrefix: 'phase4-real-dsh: ', responseDelayMs: 40 });
  const acl = JSON.parse(await readFile(scene.configPath, 'utf8')).acl.bridges;
  const system = await scene.peer('dsh.source.system');
  const dialogue = await scene.peer('dsh.source.dialogue');
  const notes = await scene.peer('dsh.source.notes');
  const display = await scene.peer('dsh.display');
  const trigger = await scene.peer('dsh.trigger');
  const systemPrompt = '独立来源程序的系统提示词：保留 {{literal}}，按提供资料回答。';
  const imported = [{ role: 'user', content: '上一轮用户问题来自对话程序。' }, { role: 'assistant', content: '上一轮助手回答也来自对话程序。' }];
  const material = '独立资料程序：甲方案每周一次，乙方案每天一次。中文🙂';
  await system.cmd('behavior', { topic: topics.system, onRequest: { mode: 'static', value: { systemPrompt } } });
  await system.cmd('register', { channels: [channel(topics.system)] });
  await system.cmd('subscribe', { filters: [topics.system], from: 0, operations: ['request'] });
  await notes.cmd('behavior', { topic: topics.notes, onRequest: { mode: 'static', value: { text: material } } });
  await notes.cmd('register', { channels: [channel(topics.notes)] });
  await notes.cmd('subscribe', { filters: [topics.notes], from: 0, operations: ['request'] });
  await dialogue.cmd('behavior', { topic: topics.dialogue, onRequest: { mode: 'state' } });
  await dialogue.cmd('behavior', { topic: topics.writeDialogue, onInject: { mode: 'state' } });
  await dialogue.cmd('register', { channels: [channel(topics.dialogue), channel(topics.writeDialogue)] });
  await dialogue.cmd('subscribe', { filters: [topics.dialogue, topics.writeDialogue], from: 0, operations: ['request', 'inject'] });
  await display.cmd('behavior', { topic: topics.display, onInject: { mode: 'state' } });
  await display.cmd('register', { channels: [channel(topics.display)] });
  await display.cmd('subscribe', { filters: [topics.display], from: 0, operations: ['inject'] });
  const seed = await trigger.cmd('inject', { target: { principal: 'dsh.source.dialogue' }, topic: topics.writeDialogue, body: { version: 1, messages: imported } });
  await dialogue.wait((event) => event.kind === 'handled' && event.messageSeq === seed.seq);

  const mod = (id) => ({ id, token: acl[id].token });
  const common = { dir: scene.dir, url: scene.harness.endpoint };
  const harnessPath = join(scene.dir, 'dsh-harness.json');
  await writeFile(harnessPath, JSON.stringify({ ...common, mods: [mod('dsh.harness')], topic: topics.harness, installRoot: resolve(installRoot), fixture }));
  const harness = await startOwnedProgram(script, { args: ['harness', harnessPath], timeoutMs: 20_000 });
  owned.push(harness);
  const uiPath = join(scene.dir, 'dsh-ui.json');
  await writeFile(uiPath, JSON.stringify({ ...common, mods: [mod('dsh.ui.control'), mod('dsh.ui.output')], topic: topics.invoke,
    sources: [
      { role: 'system', principal: 'dsh.source.system', topic: topics.system },
      { role: 'dialogue', principal: 'dsh.source.dialogue', topic: topics.dialogue },
      { role: 'notes', principal: 'dsh.source.notes', topic: topics.notes },
    ], harness: { principal: 'dsh.harness', topic: topics.harness },
    outputs: [{ role: 'display', principal: 'dsh.display', topic: topics.display }, { role: 'dialogue', principal: 'dsh.source.dialogue', topic: topics.writeDialogue }] }));
  const ui = await startOwnedProgram(script, { args: ['ui', uiPath] });
  owned.push(ui);
  const processes = [scene.harness.hub.pid, system.pid, dialogue.pid, notes.pid, display.pid, trigger.pid, harness.child.pid, harness.ready.dshPid, ui.child.pid];
  assert.equal(new Set(processes).size, processes.length);
  assert.ok(processes.every((pid) => Number.isInteger(pid) && pid !== process.pid));

  const current = '第一轮：请比较甲乙方案。';
  const first = await trigger.cmd('call', { target: { principal: 'dsh.ui.control' }, topic: topics.invoke, body: { text: current }, timeoutMs: 40_000 }, { timeoutMs: 45_000 });
  const result = first.response.body;
  assert.equal(first.response.requestSeq, first.request.seq);
  assert.equal(first.response.fromPrincipal, 'dsh.ui.control');
  assert.equal(result.uiPid, ui.child.pid);
  assert.equal(result.dsh.response.fromPrincipal, 'dsh.harness');
  assert.equal(result.dsh.response.requestSeq, result.dsh.request.seq);
  assert.equal(result.dsh.response.body.dshPid, harness.ready.dshPid);
  assert.equal(result.dsh.response.body.harnessPid, harness.child.pid);
  assert.equal(result.context.systemPrompt, systemPrompt);
  assert.deepEqual(result.context.messages, imported);
  assert.equal(result.context.text, material);
  assert.ok(result.output.startsWith('phase4-real-dsh: '));
  assert.ok(result.output.includes(current));
  assert.ok(result.output.includes(material));
  assert.equal(result.sources.length, 3);
  for (const source of result.sources) assert.equal(source.response.requestSeq, source.request.seq);
  const displaySeq = result.injections.find((injection) => injection.role === 'display').receipt.seq;
  const dialogueSeq = result.injections.find((injection) => injection.role === 'dialogue').receipt.seq;
  const displayed = await display.wait((event) => event.kind === 'handled' && event.messageSeq === displaySeq);
  await dialogue.wait((event) => event.kind === 'handled' && event.messageSeq === dialogueSeq);
  assert.equal(displayed.result.output, result.output);
  const displayDelivery = display.events('delivery').find((event) => event.message.seq === displaySeq).message;
  assert.equal(displayDelivery.operation, 'inject');
  assert.equal(displayDelivery.fromPrincipal, 'dsh.ui.output');
  assert.deepEqual((await dialogue.cmd('snapshot')).state.messages, [...imported, { role: 'user', content: current }, { role: 'assistant', content: result.output }]);

  const secondText = '第二轮：上一轮的回答已经由对话程序保存。';
  const second = await trigger.cmd('call', { target: { principal: 'dsh.ui.control' }, topic: topics.invoke, body: { text: secondText }, timeoutMs: 40_000 }, { timeoutMs: 45_000 });
  assert.deepEqual(second.response.body.context.messages, [...imported, { role: 'user', content: current }, { role: 'assistant', content: result.output }]);
  const secondOutput = second.response.body.output;
  const secondDisplaySeq = second.response.body.injections.find((injection) => injection.role === 'display').receipt.seq;
  const secondDialogueSeq = second.response.body.injections.find((injection) => injection.role === 'dialogue').receipt.seq;
  const secondDisplayed = await display.wait((event) => event.kind === 'handled' && event.messageSeq === secondDisplaySeq);
  const secondDialogue = await dialogue.wait((event) => event.kind === 'handled' && event.messageSeq === secondDialogueSeq);
  assert.equal(secondDisplayed.result.output, secondOutput);
  assert.equal((await display.cmd('snapshot')).state.output, secondOutput);
  const completeHistory = [...imported, { role: 'user', content: current }, { role: 'assistant', content: result.output },
    { role: 'user', content: secondText }, { role: 'assistant', content: secondOutput }];
  assert.equal(completeHistory.length, 6);
  assert.deepEqual(secondDialogue.result.messages, completeHistory);
  assert.deepEqual((await dialogue.cmd('snapshot')).state.messages, completeHistory);
  for (const [receiver, seq] of [[display, secondDisplaySeq], [dialogue, secondDialogueSeq]]) {
    const message = receiver.events('delivery').find((event) => event.message.seq === seq).message;
    assert.equal(message.operation, 'inject');
    assert.equal(message.fromPrincipal, 'dsh.ui.output');
  }
  const capture = (await readFile(fixture.capturePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(capture.length, 2);
  assert.ok(capture[0].messages.some((message) => message.role === 'system' && messageText(message) === systemPrompt));
  const userIndex = capture[0].messages.findIndex((message) => message.role === 'user' && messageText(message) === imported[0].content);
  const assistantIndex = capture[0].messages.findIndex((message) => message.role === 'assistant' && messageText(message) === imported[1].content);
  assert.ok(userIndex > 0 && assistantIndex > userIndex);
  assert.ok(capture[1].messages.some((message) => message.role === 'system' && messageText(message) === systemPrompt));
  const secondModelDialogue = capture[1].messages.filter((message) => ['user', 'assistant'].includes(message.role))
    .map((message) => ({ role: message.role, content: messageText(message) }));
  assert.equal(secondModelDialogue.length, 5, 'the actual second model request has four historical messages followed by one current user message');
  assert.deepEqual(secondModelDialogue.slice(0, 4), completeHistory.slice(0, 4));
  assert.equal(secondModelDialogue[4].role, 'user');
  assert.ok(secondModelDialogue[4].content.includes(secondText));
  assert.equal(capture[1].messages.filter((message) => message.role === 'assistant' && messageText(message) === result.output).length, 1);
  assert.equal(capture[1].messages.filter((message) => message.role === 'user' && messageText(message).includes(secondText)).length, 1);
  assert.ok(!capture[0].promptText.includes(systemPrompt));
  const records = (await scene.harness.log()).records.filter((record) => record.kind === 'message');
  assert.ok(records.every((record) => ['request', 'response', 'inject'].includes(record.operation)), 'this scenario uses the new directed protocol, without old publish-only application requests');
  assert.equal(records.filter((record) => record.topic === topics.harness && record.operation === 'request').length, 2);
  assert.equal(records.filter((record) => record.topic === topics.harness && record.operation === 'response').length, 2);
  const protectedState = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(protectedState.log.releasedCount, 0);
  assert.equal(protectedState.log.protectedCount, records.length);
  scene.record('real-dsh-new-rpc-and-injection', { installedVersion: installed.version, processes, dshPid: harness.ready.dshPid,
    programs: [{ name: 'ui-composer', pid: ui.child.pid, mods: ['dsh.ui.control', 'dsh.ui.output'] }, { name: 'dsh-harness', pid: harness.child.pid, dshPid: harness.ready.dshPid }],
    model: { provider: 'peros-test', model: 'fixture', adapter: 'local deterministic adapter running inside the genuine DSH process', captures: capture.length },
    network: 'fixture preloader blocks fetch/WebSocket/http/https/net/tls in the genuine DSH child; no user DSH home or model credentials', first, second,
    modelCapture: capture, communicationOperations: records.map(({ seq, operation, topic, fromPrincipal, target, requestSeq }) => ({ seq, operation, topic, fromPrincipal, target, requestSeq })) });
  await ui.stop();
  await harness.stop();
  assert.deepEqual(ui.exited, { code: 0, signal: null });
  assert.deepEqual(harness.exited, { code: 0, signal: null });
  const dshStopped = harness.lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((event) => event?.event === 'dsh_stopped');
  assert.deepEqual(dshStopped?.exit, { code: 0, signal: null });
  scene.record('owned-dsh-programs-exited', { ui: { pid: ui.child.pid, ...ui.exited }, harness: { pid: harness.child.pid, ...harness.exited }, dsh: { pid: harness.ready.dshPid, ...dshStopped.exit } });
  } finally { await stopOwned(); }
});
