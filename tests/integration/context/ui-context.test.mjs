import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { Harness, until, sleep, PROJECT_ROOT } from '../../helpers/hub-harness.mjs';
import { loadSettings } from '../../../examples/distributed-context/lib/program-kit.mjs';
import { startContextProgram } from '../../../examples/distributed-context/context-program.mjs';
import { startUiProgram } from '../../../examples/distributed-context/ui-program.mjs';

async function setup(t, { context = true, contextSettings, providers } = {}) {
  const h = new Harness();
  await h.startHub({ configPath: resolve(PROJECT_ROOT, 'examples/distributed-context/hub.config.json') });
  const settings = loadSettings([]);
  settings.hub.url = h.endpoint;
  settings.stateDir = join(h.tmp, 'program-state');
  settings.ui.port = 0;
  settings.context = contextSettings ?? { text: '选定测试上下文 <script>不会执行</script>' };
  if (providers) settings.contextProviders = providers;
  else delete settings.contextProviders;
  settings.peers.context.subscribe = ['contextRequest', 'harnessEvent'];
  let contextProgram = context ? await startContextProgram(settings) : null;
  let ui = await startUiProgram(settings);
  const harness = new Bridge({ url: h.endpoint, bridgeId: 'phase2.harness' });
  const commands = [];
  harness.on('delivery', (message) => { commands.push(message); });
  await harness.connect();
  await harness.subscribe([settings.channels.harnessRequest, settings.channels.contextRequest, settings.channels.contextResponse], { from: 0 });
  t.after(async () => { await ui.close(); if (contextProgram) await contextProgram.close(); await harness.close(); await h.stop(); });
  return { h, settings, get ui() { return ui; }, get context() { return contextProgram; }, harness, commands,
    async restartUi() { await ui.close(); ui = await startUiProgram(settings); return ui; },
    async restartContext() { await contextProgram.close(); contextProgram = await startContextProgram(settings); return contextProgram; },
  };
}
const post = (ui, payload, headers = {}) => fetch(`${ui.url}/api/prompt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
});
const requestState = async (ui, id) => (await (await fetch(`${ui.url}/api/state`)).json()).requests.find((entry) => entry.requestId === id);
const sdkSessionId = (request) => `sdk.${request.requestId}`;
const notification = (request, eventId, frame) => {
  const snapshot = structuredClone(frame);
  if (snapshot.params?.sessionId === request.sessionId) snapshot.params.sessionId = sdkSessionId(request);
  return { kind: 'dsh.notification', requestId: request.requestId, sessionId: request.sessionId, sdkSessionId: sdkSessionId(request), eventId, frame: snapshot };
};
const endWait = (ui, requestId, headers = {}) => fetch(`${ui.url}/api/end-wait`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ requestId }),
});
const rawHostStatus = (ui, host) => new Promise((resolveStatus, reject) => {
  const request = httpRequest(`${ui.url}/api/state`, { headers: { Host: host } }, (response) => {
    response.resume(); response.on('end', () => resolveStatus(response.statusCode));
  });
  request.once('error', reject); request.end();
});

test('provider configuration rejects shared state directories and bridge identities before programs start', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'peros-provider-config-test-'));
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = loadSettings([]);
  const cases = [
    ['dot', (config) => { config.contextProviders[0].id = '.'; }, /safe independent directory/],
    ['parent', (config) => { config.contextProviders[0].id = '..'; }, /safe independent directory/],
    ['duplicate-id', (config) => { config.contextProviders[1].id = config.contextProviders[0].id; }, /state directories must be distinct/],
    ['same-peer', (config) => { config.contextProviders[1].peer = config.contextProviders[0].peer; }, /bridge identities must be independent/],
    ['same-bridge', (config) => { config.peers[config.contextProviders[1].peer].bridgeId = config.peers[config.contextProviders[0].peer].bridgeId; }, /bridge identities must be independent/],
    ...['ui', 'harness'].flatMap((name) => [
      [`${name}-peer`, (config) => { config.contextProviders[0].peer = name; }, /bridge identities must be independent/],
      [`${name}-bridge`, (config) => { config.peers[config.contextProviders[0].peer].bridgeId = config.peers[name].bridgeId; }, /bridge identities must be independent/],
    ]),
  ];
  if (process.platform === 'win32') cases.push(['directory-case', (config) => { config.contextProviders[1].id = config.contextProviders[0].id.toUpperCase(); }, /state directories must be distinct/]);
  for (const [name, change, expected] of cases) {
    const config = structuredClone(base);
    change(config);
    const path = join(directory, `${name}.json`);
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => loadSettings(['--config', path]), expected, name);
  }
  const valid = structuredClone(base);
  // The legacy peer is not a participating provider and must not constrain the
  // identity choices of independently configured active sources.
  valid.peers.context.bridgeId = valid.peers[valid.contextProviders[0].peer].bridgeId;
  const path = join(directory, 'unused-legacy-identity.json');
  writeFileSync(path, JSON.stringify(valid));
  assert.doesNotThrow(() => loadSettings(['--config', path]));
});

test('context, prompt, accepted, snapshots and turn/end traverse ordinary mod peers and restore UI history', async (t) => {
  const env = await setup(t);
  const response = await post(env.ui, { text: '请根据上下文回答' });
  assert.equal(response.status, 202);
  const request = await response.json();
  await until(() => env.commands.some((message) => message.topic === env.settings.channels.harnessRequest));
  const command = env.commands.find((message) => message.topic === env.settings.channels.harnessRequest).body;
  assert.equal(command.text, '请根据上下文回答');
  assert.equal(command.context.text, env.settings.context.text);
  assert.equal(command.kind, 'dsh.prompt');
  assert.equal((await post(env.ui, { text: '第二条' })).status, 409);
  await env.harness.publishConfirmed(env.settings.channels.harnessResponse, { kind: 'dsh.accepted', ...request, sdkSessionId: sdkSessionId(request), messageId: 'dsh-user-message' });
  await until(async () => (await requestState(env.ui, request.requestId)).status === 'accepted');
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'child-message-1', { method: 'session.event', params: { sessionId: 'sdk-child-session', event: { type: 'assistant/message', data: { message: { id: 'child-message', content: [{ type: 'text', text: '子智能体输出不应混入主输出' }] } } } } }));
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'child-end-1', { method: 'session.event', params: { sessionId: 'sdk-child-session', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
  await until(async () => (await requestState(env.ui, request.requestId)).eventIds?.includes('child-end-1'));
  assert.equal((await requestState(env.ui, request.requestId)).status, 'accepted', 'child turn/end cannot finish the main request');
  assert.equal((await requestState(env.ui, request.requestId)).output, '', 'child output belongs only to diagnostics');
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'idle-1', { method: 'session.status', params: { sessionId: request.sessionId, status: 'idle' } }));
  await sleep(30);
  assert.equal((await requestState(env.ui, request.requestId)).status, 'accepted', 'idle and accepted cannot invent a completed turn');
  const snapshot = { method: 'session.event', params: { sessionId: request.sessionId, event: { type: 'assistant/message', data: { message: { id: 'assistant-1', content: [{ type: 'text', text: '中文返回 <img src=x onerror=alert(1)>' }] } } } } };
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'message-1', snapshot));
  await until(async () => (await requestState(env.ui, request.requestId)).output === '中文返回 <img src=x onerror=alert(1)>');
  const altered = structuredClone(snapshot); altered.params.event.data.message.content[0].text = '重复通知不能覆盖原结果';
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'message-1', altered));
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'end-1', { method: 'session.event', params: { sessionId: request.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
  await until(async () => (await requestState(env.ui, request.requestId)).status === 'completed');
  let saved = await requestState(env.ui, request.requestId);
  assert.equal(saved.output, '中文返回 <img src=x onerror=alert(1)>');
  assert.equal(saved.assistantMessages.length, 1);
  assert.deepEqual(saved.eventIds, ['child-message-1', 'child-end-1', 'idle-1', 'message-1', 'end-1']);
  assert.equal((await endWait(env.ui, request.requestId)).status, 409, 'known completed request is not an unknown wait');
  await env.restartUi();
  saved = await requestState(env.ui, request.requestId);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.context.text, env.settings.context.text);
  assert.equal(saved.output, '中文返回 <img src=x onerror=alert(1)>');
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'message-1', altered));
  await sleep(40);
  assert.equal((await requestState(env.ui, request.requestId)).output, saved.output);
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 1);
});

test('context program persists its selected snapshot and serves the same result after source change and restart', async (t) => {
  const env = await setup(t, { context: false });
  const file = join(env.h.tmp, 'selected.txt');
  writeFileSync(file, '第一次选择的内容');
  env.settings.context = { file };
  const context = await startContextProgram(env.settings);
  t.after(() => context.close());
  const request = { kind: 'context.request', requestId: 'context-history', sessionId: 'session-history' };
  await env.harness.publishConfirmed(env.settings.channels.contextRequest, request);
  await until(() => env.commands.some((message) => message.body.kind === 'context.result'));
  const first = env.commands.find((message) => message.body.kind === 'context.result').body;
  assert.equal(first.text, '第一次选择的内容');
  writeFileSync(file, '此后变更的内容');
  await context.close();
  const restarted = await startContextProgram(env.settings);
  t.after(() => restarted.close());
  await env.harness.publishConfirmed(env.settings.channels.contextRequest, request);
  await until(() => env.commands.filter((message) => message.body.kind === 'context.result').length >= 2);
  assert.deepEqual(env.commands.filter((message) => message.body.kind === 'context.result').at(-1).body, first);
  assert.equal(JSON.parse(readFileSync(join(env.settings.stateDir, 'context-state.json'), 'utf8')).results['context-history'].text, first.text);
});

test('structured context preserves system and history roles, appends current user once, and records only main assistant for the next turn', async (t) => {
  const env = await setup(t, { context: false });
  const file = join(env.h.tmp, 'conversation.json');
  const seed = { systemPrompt: '系统提示词：保持中文及角色顺序。', messages: [
    { role: 'user', content: '历史问题' }, { role: 'assistant', content: '历史回答' },
  ], text: '选定附加材料' };
  writeFileSync(file, JSON.stringify(seed));
  env.settings.context = { file, format: 'json' };
  let provider = await startContextProgram(env.settings);
  t.after(() => provider.close());
  const first = await (await post(env.ui, { text: '本轮用户问题' })).json();
  await until(() => env.commands.some((message) => message.topic === env.settings.channels.harnessRequest));
  const firstCommand = env.commands.find((message) => message.topic === env.settings.channels.harnessRequest).body;
  assert.deepEqual(firstCommand.context, { version: 1, ...seed, source: { kind: 'selected-file', path: file }, provenance: [{ providerId: 'context', source: { kind: 'selected-file', path: file } }] });
  assert.equal(firstCommand.text, '本轮用户问题');
  const contextRequest = env.commands.find((message) => message.topic === env.settings.channels.contextRequest).body;
  assert.equal(contextRequest.text, firstCommand.text);
  assert.equal(firstCommand.context.messages.some((message) => message.content === firstCommand.text), false, 'current user is carried separately, not duplicated in the snapshot');
  assert.equal((await requestState(env.ui, first.requestId)).context.systemPrompt, seed.systemPrompt);
  assert.deepEqual((await requestState(env.ui, first.requestId)).context.messages, seed.messages);
  await env.harness.publishConfirmed(env.settings.channels.harnessResponse, { kind: 'dsh.accepted', ...first, sdkSessionId: sdkSessionId(first), messageId: 'first-user-message' });
  const assistant = notification(first, 'main-answer-1', { method: 'session.event', params: { sessionId: first.sessionId, event: { type: 'assistant/message', data: { message: { id: 'first-assistant-message', content: [{ type: 'text', text: '本轮主助手回答' }] } } } } });
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, assistant);
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, assistant);
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(first, 'child-answer-1', { method: 'session.event', params: { sessionId: 'child-sdk-session', event: { type: 'assistant/message', data: { message: { id: 'child-assistant', content: [{ type: 'text', text: '不能混入历史的子助手回答' }] } } } } }));
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(first, 'main-end-1', { method: 'session.event', params: { sessionId: first.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
  await until(async () => (await requestState(env.ui, first.requestId)).status === 'completed');
  const second = await (await post(env.ui, { text: '第二轮用户问题' })).json();
  assert.equal(second.sessionId, first.sessionId);
  await until(() => env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length === 2);
  const secondCommand = env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).at(-1).body;
  const expected = [...seed.messages, { role: 'user', content: '本轮用户问题' }, { role: 'assistant', content: '本轮主助手回答' }];
  assert.deepEqual(secondCommand.context.messages, expected);
  assert.equal(secondCommand.context.systemPrompt, seed.systemPrompt);
  assert.equal(secondCommand.context.text, seed.text);
  assert.equal(secondCommand.context.source.path, file);
  assert.equal(provider.state.value.conversations[first.sessionId].messages.length, 5);
  await provider.close();
  provider = await startContextProgram(env.settings);
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, assistant);
  const secondContextRequest = env.commands.filter((message) => message.topic === env.settings.channels.contextRequest).at(-1).body;
  await env.harness.publishConfirmed(env.settings.channels.contextRequest, secondContextRequest);
  await until(() => env.commands.filter((message) => message.topic === env.settings.channels.contextResponse && message.body.requestId === second.requestId).length >= 2);
  assert.equal(provider.state.value.conversations[first.sessionId].messages.length, 5, 'replayed request and assistant notification cannot append history twice');
  assert.deepEqual(env.commands.filter((message) => message.topic === env.settings.channels.contextResponse && message.body.requestId === second.requestId).at(-1).body.context.messages, expected);
  const html = await (await fetch(env.ui.url)).text();
  assert.ok(html.includes('系统提示词') && html.includes('本次交互之前的对话历史') && html.includes('选定附加材料'));
});

test('invalid selected JSON is an explicit context business error without plain-text fallback', async (t) => {
  const env = await setup(t, { context: false });
  const file = join(env.h.tmp, 'invalid-context.json');
  writeFileSync(file, 'this is not JSON');
  env.settings.context = { file, format: 'json' };
  const provider = await startContextProgram(env.settings);
  t.after(() => provider.close());
  await env.harness.publishConfirmed(env.settings.channels.contextRequest, { kind: 'context.request', requestId: 'invalid-json-1', sessionId: 'invalid-session-1', text: '当前输入' });
  await until(() => env.commands.some((message) => message.body.requestId === 'invalid-json-1' && message.body.kind === 'context.result'));
  const invalid = env.commands.find((message) => message.body.requestId === 'invalid-json-1' && message.body.kind === 'context.result').body;
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_CONTEXT');
  assert.equal(invalid.context, undefined);
  writeFileSync(file, JSON.stringify({ systemPrompt: '系统', messages: [{ role: 'system', content: '错误角色' }] }));
  await env.harness.publishConfirmed(env.settings.channels.contextRequest, { kind: 'context.request', requestId: 'invalid-json-2', sessionId: 'invalid-session-2', text: '当前输入' });
  await until(() => env.commands.some((message) => message.body.requestId === 'invalid-json-2' && message.body.kind === 'context.result'));
  assert.equal(env.commands.find((message) => message.body.requestId === 'invalid-json-2' && message.body.kind === 'context.result').body.error.code, 'INVALID_CONTEXT');
});

test('UI waits for configured mod providers, composes in config order, and accepts a newly configured provider without hub code changes', async (t) => {
  const providers = [{ id: 'first', peer: 'custom.first' }, { id: 'second', peer: 'custom.second' }];
  const env = await setup(t, { context: false, providers });
  const sources = [];
  const makeSource = async (id, peerName) => {
    const peer = env.settings.peers[peerName];
    const bridge = new Bridge({ url: env.h.endpoint, bridgeId: peer.bridgeId, credential: peer.credential, token: peer.token, displayName: `external.${id}` });
    bridge.on('delivery', () => {});
    await bridge.connect();
    await bridge.registerChannels([{ name: env.settings.channels.contextResponse, publish: true }, { name: env.settings.channels.contextRequest, subscribe: true }]);
    await bridge.subscribe([env.settings.channels.contextRequest], { from: 0 });
    sources.push(bridge);
    return bridge;
  };
  t.after(async () => { for (const source of sources) await source.close(); });
  const firstSource = await makeSource('first', 'context.system');
  const secondSource = await makeSource('second', 'context.dialogue');
  const futureSource = await makeSource('remote-memory-v2', 'context.notes');
  const reply = (source, request, providerId, context, ok = true) => source.publishConfirmed(env.settings.channels.contextResponse, {
    kind: 'context.result', requestId: request.requestId, sessionId: request.sessionId, providerId, ok,
    ...(ok ? { context: { version: 1, ...context } } : { error: { code: 'REMOTE_CONTEXT_FAILED', message: '新增来源提供失败' } }),
    source: { kind: 'remote-mod', name: providerId },
  });
  const first = await (await post(env.ui, { text: '组合两个程序的上下文' })).json();
  await reply(secondSource, first, 'second', { systemPrompt: '系统B', messages: [{ role: 'assistant', content: '历史B' }], text: '材料B' });
  await until(async () => Object.hasOwn((await requestState(env.ui, first.requestId)).contextParts, 'second'));
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 0, 'a missing configured program prevents dispatch');
  await reply(futureSource, first, 'future', { systemPrompt: '未配置的系统内容' });
  await env.restartUi();
  await reply(secondSource, first, 'second', { systemPrompt: '重复结果不得覆盖B' });
  await reply(firstSource, first, 'first', { systemPrompt: '系统A', messages: [{ role: 'user', content: '历史A' }], text: '材料A' });
  await until(() => env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length === 1);
  const merged = env.commands.find((message) => message.topic === env.settings.channels.harnessRequest).body.context;
  assert.equal(merged.systemPrompt, '系统A\n\n系统B');
  assert.deepEqual(merged.messages, [{ role: 'user', content: '历史A' }, { role: 'assistant', content: '历史B' }]);
  assert.equal(merged.text, '材料A\n\n材料B');
  assert.deepEqual(merged.provenance, [{ providerId: 'first', source: { kind: 'remote-mod', name: 'first' } }, { providerId: 'second', source: { kind: 'remote-mod', name: 'second' } }]);
  assert.equal(Object.hasOwn((await requestState(env.ui, first.requestId)).contextParts, 'future'), false);
  await reply(firstSource, first, 'first', { systemPrompt: '不会再次执行' });
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(first, 'finish-multi-1', { method: 'session.event', params: { sessionId: first.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
  await until(async () => (await requestState(env.ui, first.requestId)).status === 'completed');
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 1);
  env.settings.contextProviders.push({ id: 'future', peer: 'arbitrary.new-provider' });
  await env.restartUi();
  const failed = await (await post(env.ui, { text: '加入第三个来源' })).json();
  await reply(firstSource, failed, 'first', { systemPrompt: '系统A' });
  await reply(secondSource, failed, 'second', { messages: [{ role: 'user', content: '历史B' }] });
  await until(async () => Object.keys((await requestState(env.ui, failed.requestId)).contextParts).length === 2);
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 1);
  await reply(futureSource, failed, 'future', {}, false);
  await until(async () => (await requestState(env.ui, failed.requestId)).status === 'error');
  assert.equal((await requestState(env.ui, failed.requestId)).error.providerId, 'future');
  const next = await (await post(env.ui, { text: '新增来源已可用' })).json();
  await reply(futureSource, next, 'future', { systemPrompt: '系统F', text: '远程材料' });
  await reply(secondSource, next, 'second', { messages: [{ role: 'assistant', content: '远程历史' }] });
  await reply(firstSource, next, 'first', { systemPrompt: '系统A' });
  await until(() => env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length === 2);
  const expanded = env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).at(-1).body.context;
  assert.equal(expanded.systemPrompt, '系统A\n\n系统F');
  assert.deepEqual(expanded.messages, [{ role: 'assistant', content: '远程历史' }]);
  assert.deepEqual(expanded.provenance.map((entry) => entry.providerId), ['first', 'second', 'future']);
});

test('independent partial-context programs keep system and dialogue business separate while the UI combines both', async (t) => {
  const env = await setup(t, { context: false, providers: [{ id: 'system', peer: 'context.system' }, { id: 'dialogue', peer: 'context.dialogue' }, { id: 'notes', peer: 'context.notes' }] });
  const systemFile = join(env.h.tmp, 'system-only.json');
  const dialogueFile = join(env.h.tmp, 'dialogue-only.json');
  writeFileSync(systemFile, JSON.stringify({ systemPrompt: '独立系统提示词程序' }));
  writeFileSync(dialogueFile, JSON.stringify({ messages: [{ role: 'user', content: '独立对话程序的历史' }] }));
  const system = await startContextProgram({ ...env.settings, stateDir: join(env.settings.stateDir, 'system'), contextPeer: 'context.system', contextProviderId: 'system', trackDialogue: false, context: { file: systemFile, format: 'json' } });
  const dialogue = await startContextProgram({ ...env.settings, stateDir: join(env.settings.stateDir, 'dialogue'), contextPeer: 'context.dialogue', contextProviderId: 'dialogue', trackDialogue: true, context: { file: dialogueFile, format: 'json' } });
  const notes = await startContextProgram({ ...env.settings, stateDir: join(env.settings.stateDir, 'notes'), contextPeer: 'context.notes', contextProviderId: 'notes', trackDialogue: false, context: { text: '普通文本程序提供的材料' } });
  t.after(async () => { await system.close(); await dialogue.close(); await notes.close(); });
  const first = await (await post(env.ui, { text: '分布程序提供第一轮上下文' })).json();
  await until(() => env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length === 1);
  const initial = env.commands.find((message) => message.topic === env.settings.channels.harnessRequest).body.context;
  assert.equal(initial.systemPrompt, '独立系统提示词程序');
  assert.equal(initial.text, '普通文本程序提供的材料');
  assert.deepEqual(initial.messages, [{ role: 'user', content: '独立对话程序的历史' }]);
  assert.deepEqual(system.state.value.conversations, {});
  assert.equal(system.state.value.results[first.requestId].context.messages, undefined);
  assert.equal(dialogue.state.value.results[first.requestId].context.systemPrompt, undefined);
  assert.equal(notes.state.value.results[first.requestId].context.systemPrompt, undefined);
  assert.equal(notes.state.value.results[first.requestId].context.messages, undefined);
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(first, 'distributed-answer-1', { method: 'session.event', params: { sessionId: first.sessionId, event: { type: 'assistant/message', data: { message: { id: 'distributed-assistant', content: [{ type: 'text', text: '第一轮主助手回答' }] } } } } }));
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(first, 'distributed-end-1', { method: 'session.event', params: { sessionId: first.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
  await until(async () => (await requestState(env.ui, first.requestId)).status === 'completed');
  await post(env.ui, { text: '第二轮分布上下文' });
  await until(() => env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length === 2);
  const next = env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).at(-1).body.context;
  assert.deepEqual(next.messages, [
    { role: 'user', content: '独立对话程序的历史' }, { role: 'user', content: '分布程序提供第一轮上下文' }, { role: 'assistant', content: '第一轮主助手回答' },
  ]);
  assert.equal(next.systemPrompt, '独立系统提示词程序');
  assert.deepEqual(system.state.value.conversations, {}, 'non-dialogue program must not inherit conversation tracking');
});

test('ending an incomplete context wait preserves received parts, blocks late dispatch, and permits a fresh combined request', async (t) => {
  const env = await setup(t, { context: false, providers: [{ id: 'one' }, { id: 'two' }] });
  const reply = (request, providerId, context) => env.harness.publishConfirmed(env.settings.channels.contextResponse, {
    kind: 'context.result', requestId: request.requestId, sessionId: request.sessionId, providerId, ok: true,
    context: { version: 1, ...context }, source: { name: providerId },
  });
  const first = await (await post(env.ui, { text: '第二个来源暂时离线' })).json();
  await reply(first, 'one', { systemPrompt: '先收到的系统提示词' });
  await until(async () => Object.hasOwn((await requestState(env.ui, first.requestId)).contextParts, 'one'));
  assert.equal((await requestState(env.ui, first.requestId)).status, 'context_pending');
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 0);
  assert.equal((await post(env.ui, { text: '结束等待前仍忙' })).status, 409);
  const receivedPart = structuredClone((await requestState(env.ui, first.requestId)).contextParts.one);
  assert.equal((await endWait(env.ui, first.requestId)).status, 200);
  const ended = await requestState(env.ui, first.requestId);
  assert.equal(ended.status, 'abandoned_unknown');
  assert.equal(ended.waitEndedFrom, 'context_pending');
  assert.equal(ended.error.code, 'CONTEXT_WAIT_ENDED');
  assert.ok(ended.error.message.includes('two'));
  assert.deepEqual(ended.contextParts.one, receivedPart);
  await reply(first, 'two', { messages: [{ role: 'assistant', content: '迟到的历史' }] });
  await env.restartUi();
  await reply(first, 'one', { systemPrompt: '迟到的重复响应' });
  await reply(first, 'two', { text: '重启后的迟到响应' });
  const nextResponse = await post(env.ui, { text: '使用新的逻辑会话重新发起' });
  assert.equal(nextResponse.status, 202);
  const next = await nextResponse.json();
  assert.notEqual(next.requestId, first.requestId);
  assert.notEqual(next.sessionId, first.sessionId);
  await reply(next, 'two', { messages: [{ role: 'user', content: '新会话历史' }], text: '新资料' });
  await reply(next, 'one', { systemPrompt: '新会话系统提示词' });
  await until(() => env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length === 1);
  const dispatched = env.commands.find((message) => message.topic === env.settings.channels.harnessRequest).body;
  assert.equal(dispatched.requestId, next.requestId);
  assert.equal(dispatched.context.systemPrompt, '新会话系统提示词');
  assert.deepEqual(dispatched.context.messages, [{ role: 'user', content: '新会话历史' }]);
  assert.equal(dispatched.context.text, '新资料');
  assert.deepEqual((await requestState(env.ui, first.requestId)).contextParts, { one: receivedPart });
  assert.equal((await requestState(env.ui, first.requestId)).status, 'abandoned_unknown');
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest && message.body.requestId === first.requestId).length, 0);
});

test('conversation capacity preserves prior history and refuses new context instead of truncating messages', async (t) => {
  const env = await setup(t, { context: false });
  const file = join(env.h.tmp, 'full-context.json');
  const messages = Array.from({ length: 255 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `历史${index}` }));
  writeFileSync(file, JSON.stringify({ systemPrompt: '容量测试', messages }));
  env.settings.context = { file, format: 'json' };
  const provider = await startContextProgram(env.settings);
  t.after(() => provider.close());
  const request = { kind: 'context.request', requestId: 'full-request-1', sessionId: 'full-conversation', text: '第256条消息' };
  await env.harness.publishConfirmed(env.settings.channels.contextRequest, request);
  await until(() => env.commands.some((message) => message.body.requestId === request.requestId && message.body.kind === 'context.result'));
  assert.equal(provider.state.value.conversations[request.sessionId].messages.length, 256);
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'over-capacity-answer', { method: 'session.event', params: { sessionId: request.sessionId, event: { type: 'assistant/message', data: { message: { id: 'overflow-assistant', content: [{ type: 'text', text: '第257条消息' }] } } } } }));
  await until(() => provider.state.value.conversations[request.sessionId].error?.code === 'CONVERSATION_CAPACITY');
  assert.equal(provider.state.value.conversations[request.sessionId].messages.length, 256);
  assert.deepEqual(provider.state.value.conversations[request.sessionId].messages.slice(0, 255), messages);
  await env.harness.publishConfirmed(env.settings.channels.contextRequest, { ...request, requestId: 'full-request-2', text: '继续对话' });
  await until(() => env.commands.some((message) => message.body.requestId === 'full-request-2' && message.body.kind === 'context.result'));
  const rejected = env.commands.find((message) => message.body.requestId === 'full-request-2' && message.body.kind === 'context.result').body;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'CONVERSATION_CAPACITY');
  assert.equal(provider.state.value.conversations[request.sessionId].messages.length, 256);
});

test('lost harness publication receipt becomes durable unknown and context replays cannot repeat the call', async (t) => {
  const env = await setup(t);
  const originalPublish = env.ui.bridge.publishConfirmed.bind(env.ui.bridge);
  env.ui.bridge.publishConfirmed = async (topic, body, options) => {
    const receipt = await originalPublish(topic, body, options);
    if (topic === env.settings.channels.harnessRequest) throw new Error('simulated lost receipt after acceptance');
    return receipt;
  };
  const request = await (await post(env.ui, { text: '最多调用一次' })).json();
  await until(async () => (await requestState(env.ui, request.requestId)).status === 'unknown');
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 1);
  const result = env.commands.find((message) => message.body.kind === 'context.result').body;
  await env.harness.publishConfirmed(env.settings.channels.contextResponse, result);
  await env.restartUi();
  await env.harness.publishConfirmed(env.settings.channels.contextResponse, result);
  await sleep(60);
  assert.equal((await requestState(env.ui, request.requestId)).status, 'unknown');
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 1);
  assert.equal((await post(env.ui, { text: '不能覆盖不确定结果' })).status, 409);
  const unknownError = (await requestState(env.ui, request.requestId)).error;
  await env.harness.publishConfirmed(env.settings.channels.harnessResponse, { kind: 'dsh.accepted', ...request, sdkSessionId: sdkSessionId(request), messageId: 'late-accepted' });
  await until(async () => (await requestState(env.ui, request.requestId)).messageId === 'late-accepted');
  assert.equal((await requestState(env.ui, request.requestId)).status, 'unknown', 'late accepted must not erase uncertainty');
  assert.deepEqual((await requestState(env.ui, request.requestId)).error, unknownError);
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'late-running', { method: 'session.status', params: { sessionId: request.sessionId, status: 'running' } }));
  await until(async () => (await requestState(env.ui, request.requestId)).eventIds?.includes('late-running'));
  assert.equal((await requestState(env.ui, request.requestId)).status, 'unknown', 'a running status cannot confirm the final outcome');
  assert.deepEqual((await requestState(env.ui, request.requestId)).error, unknownError);
  const csrf = (await (await fetch(`${env.ui.url}/api/state`)).json()).csrfToken;
  assert.equal((await endWait(env.ui, request.requestId, { Origin: 'http://evil.test', 'X-UI-Token': csrf })).status, 403);
  assert.equal((await endWait(env.ui, request.requestId, { Origin: env.ui.url, 'X-UI-Token': csrf })).status, 200);
  assert.equal((await requestState(env.ui, request.requestId)).status, 'abandoned_unknown');
  assert.deepEqual((await requestState(env.ui, request.requestId)).error, unknownError);
  await env.harness.publishConfirmed(env.settings.channels.contextResponse, result);
  const nextResponse = await post(env.ui, { text: '这是显式的新请求' });
  assert.equal(nextResponse.status, 202);
  const nextRequest = await nextResponse.json();
  assert.notEqual(nextRequest.requestId, request.requestId);
  assert.notEqual(nextRequest.sessionId, request.sessionId);
  await until(() => env.commands.some((message) => message.topic === env.settings.channels.harnessRequest && message.body.requestId === nextRequest.requestId));
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest && message.body.requestId === request.requestId).length, 1);
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'late-message', { method: 'session.event', params: { sessionId: request.sessionId, event: { type: 'assistant/message', data: { message: { id: 'late-output', content: [{ type: 'text', text: '结束等待后收到的结果' }] } } } } }));
  await env.harness.publishConfirmed(env.settings.channels.harnessEvent, notification(request, 'late-end', { method: 'session.event', params: { sessionId: request.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
  await until(async () => (await requestState(env.ui, request.requestId)).lateOutcome === 'completed');
  const abandoned = await requestState(env.ui, request.requestId);
  assert.equal(abandoned.status, 'abandoned_unknown');
  assert.equal(abandoned.output, '结束等待后收到的结果');
  assert.deepEqual(abandoned.error, unknownError);
});

test('ending an unknown context publication permits a fresh request and ignores the old late context result', async (t) => {
  const env = await setup(t, { context: false });
  const original = env.ui.bridge.publishConfirmed.bind(env.ui.bridge);
  env.ui.bridge.publishConfirmed = async (topic, body, options) => {
    const receipt = await original(topic, body, options);
    if (topic === env.settings.channels.contextRequest) throw new Error('simulated lost context receipt');
    return receipt;
  };
  assert.equal((await post(env.ui, { text: '上下文发布未知' })).status, 503);
  const request = env.ui.state.value.requests[0];
  assert.equal(request.status, 'context_publish_unknown');
  assert.equal((await endWait(env.ui, request.requestId)).status, 200);
  await env.harness.publishConfirmed(env.settings.channels.contextResponse, { kind: 'context.result', requestId: request.requestId, sessionId: request.sessionId, ok: true, text: '迟到上下文', source: {} });
  env.ui.bridge.publishConfirmed = original;
  assert.equal((await post(env.ui, { text: '新的上下文请求' })).status, 202);
  await sleep(40);
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 0);
  assert.equal((await requestState(env.ui, request.requestId)).status, 'abandoned_unknown');
});

test('UI HTTP accepts local CLI and same-origin token, rejects cross-origin, missing browser token, rebinding and oversized input', async (t) => {
  const env = await setup(t, { context: false });
  const data = await (await fetch(`${env.ui.url}/api/state`)).json();
  assert.equal(typeof data.csrfToken, 'string');
  assert.equal((await post(env.ui, { text: 'x' }, { Origin: 'http://evil.test', 'X-UI-Token': data.csrfToken })).status, 403);
  assert.equal((await post(env.ui, { text: 'x' }, { Origin: env.ui.url })).status, 403);
  assert.equal((await post(env.ui, { text: 'x' }, { Origin: env.ui.url, 'X-UI-Token': 'é'.repeat(data.csrfToken.length) })).status, 403);
  assert.equal((await post(env.ui, { text: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(await rawHostStatus(env.ui, 'evil.test'), 403);
  assert.equal((await post(env.ui, { text: 'x'.repeat(65536) })).status, 413);
  assert.equal((await post(env.ui, { text: 'x'.repeat(32769) })).status, 413);
  assert.equal((await post(env.ui, { text: '浏览器同来源请求' }, { Origin: env.ui.url, 'X-UI-Token': data.csrfToken, 'Sec-Fetch-Site': 'same-origin' })).status, 202);
  assert.equal(env.ui.state.value.requests.length, 1);
  const html = await (await fetch(env.ui.url)).text();
  assert.ok(html.includes('node.textContent=text'));
  assert.ok(!html.includes('innerHTML'));
});

test('application persistence failure leaves context delivery unacknowledged and does not publish a harness call', async (t) => {
  const env = await setup(t, { context: false });
  const request = await (await post(env.ui, { text: '存储失败测试' })).json();
  const errors = [];
  env.ui.bridge.on('error', (error) => errors.push(error));
  env.ui.state.commit = () => { throw new Error('simulated application disk write failure'); };
  const receipt = await env.harness.publishConfirmed(env.settings.channels.contextResponse, { kind: 'context.result', ...request, ok: true, text: '上下文', source: { kind: 'configured-text' } });
  await until(() => errors.some((error) => error.code === 'DELIVERY_HANDLER_FAILED'));
  const subscription = (await env.h.status()).subscriptions.find((entry) => entry.bridgeId === 'phase2.ui');
  assert.ok(subscription.pending >= 1);
  assert.ok(subscription.cursor < receipt.seq);
  assert.equal(env.commands.filter((message) => message.topic === env.settings.channels.harnessRequest).length, 0);
});
