import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Harness, until } from '../../helpers/hub-harness.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { startHarnessProgram } from '../../../examples/distributed-context/harness-program.mjs';
import { createDshFixture } from '../../fixtures/dsh/dsh-fixture.mjs';
import { requireDshInstall } from '../../fixtures/dsh/installed-runtime.mjs';

const { installRoot } = requireDshInstall();
const baseConfig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../examples/distributed-context/programs.config.json', import.meta.url)), 'utf8'));
const hubConfig = fileURLToPath(new URL('../../../examples/distributed-context/hub.config.json', import.meta.url));

async function setup(t, delay = 0, { holdResponse = false } = {}) {
  const fixture = await createDshFixture({ installRoot, responseDelayMs: delay, holdResponse });
  if (holdResponse) t.after(() => fixture.releaseResponse());
  const hub = new Harness();
  await hub.startHub({ configPath: hubConfig });
  t.after(() => hub.stop());
  const settings = structuredClone(baseConfig);
  settings.hub.url = hub.endpoint;
  settings.stateDir = join(fixture.root, 'application-state');
  settings.harness = { installRoot, home: fixture.home, cwd: fixture.workspace, profile: 'sdk-minimal',
    provider: 'peros-test', model: 'fixture', patch: fixture.patchPath, nodeArgs: fixture.args.slice(0, 2), env: fixture.env, inheritEnv: false };
  settings.onEvent = () => {};
  const messages = [];
  const client = new Bridge({ url: hub.endpoint, bridgeId: 'phase2.ui' });
  client.on('delivery', message => { messages.push(message); });
  await client.connect();
  await client.registerChannels([{ name: settings.channels.harnessRequest, publish: true, subscribe: false },
    { name: settings.channels.harnessResponse, publish: false, subscribe: true }, { name: settings.channels.harnessEvent, publish: false, subscribe: true }]);
  await client.subscribe([settings.channels.harnessResponse, settings.channels.harnessEvent], { from: 0 });
  t.after(() => client.close());
  return { fixture, hub, settings, client, messages };
}

test('real DSH application accepts once, carries context, rejects concurrent work and preserves dedup after restart', async t => {
  const { fixture, settings, client, messages } = await setup(t, 0, { holdResponse: true });
  let program = await startHarnessProgram(settings);
  t.after(() => program.close());
  const first = { kind: 'dsh.prompt', requestId: 'first', sessionId: 'conversation', text: '中文请求', context: { text: '独立上下文\n第二行', source: 'provider-program' } };
  await client.publishConfirmed(settings.channels.harnessRequest, first, { id: 'input-first' });
  try {
    await until(() => messages.find(message => message.body.kind === 'dsh.accepted' && message.body.requestId === 'first'));
    await until(() => existsSync(fixture.capturePath) && readFileSync(fixture.capturePath, 'utf8').trim());
    assert.equal(program.active?.requestId, 'first', 'the real model request remains active behind the fixture gate');
    assert.equal(readFileSync(fixture.capturePath, 'utf8').trim().split('\n').length, 1);
    assert.equal(messages.some(message => message.body.frame?.params?.event?.type === 'assistant/message'), false,
      'the test adapter cannot complete before the test releases its response');
    await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId: 'busy', sessionId: 'another', text: 'cannot run concurrently' });
    await until(() => messages.some(message => message.body.requestId === 'busy' && message.body.error?.code === 'BUSY'));
    assert.equal(program.active?.requestId, 'first');
    assert.equal(messages.some(message => message.body.frame?.params?.event?.type === 'assistant/message'), false);
    assert.equal(readFileSync(fixture.capturePath, 'utf8').trim().split('\n').length, 1, 'busy rejection never reaches the model');
  } finally { await fixture.releaseResponse(); }
  const assistant = await until(() => messages.find(message => message.body.frame?.params?.event?.type === 'assistant/message'));
  assert.equal(assistant.correlation, 'first');
  assert.equal(assistant.replyTo, 'input-first');
  const responseText = assistant.body.frame.params.event.data.message.content[0].text;
  assert.ok(responseText.includes('独立上下文\n第二行'));
  assert.ok(responseText.includes('中文请求'));
  await until(() => program.active === null && program.state.value.outbox.length === 0);
  const acceptedCount = messages.filter(message => message.body.kind === 'dsh.accepted').length;
  await client.publishConfirmed(settings.channels.harnessRequest, first);
  await until(() => messages.filter(message => message.body.kind === 'dsh.accepted').length > acceptedCount);
  assert.equal(readFileSync(fixture.capturePath, 'utf8').trim().split('\n').length, 1);
  await program.close();
  program = await startHarnessProgram(settings);
  const restartedCount = messages.filter(message => message.body.kind === 'dsh.accepted').length;
  await client.publishConfirmed(settings.channels.harnessRequest, first);
  await until(() => messages.filter(message => message.body.kind === 'dsh.accepted').length > restartedCount);
  assert.equal(readFileSync(fixture.capturePath, 'utf8').trim().split('\n').length, 1, 'restart must not repeat real DSH dispatch');
});

test('composed context preserves literal system and dialogue roles in actual DSH model requests', async t => {
  const { fixture, settings, client, messages } = await setup(t);
  const program = await startHarnessProgram(settings);
  t.after(() => program.close());
  const context = { version: 1, systemPrompt: 'provider A system\n\nprovider B {{literal}}',
    messages: [{ role: 'user', content: 'provider A previous question' }, { role: 'assistant', content: 'provider A previous answer' },
      { role: 'user', content: 'provider B previous question' }], text: 'provider C reference material' };
  const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const captures = () => readFileSync(fixture.capturePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const physicalSessions = [];
  for (const [index, current] of ['current question one', 'current question two'].entries()) {
    const requestId = `snapshot-${index}`;
    await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId, sessionId: 'same-logical-conversation', text: current, context });
    const receipt = await until(() => messages.find(message => message.body.kind === 'dsh.accepted' && message.body.requestId === requestId));
    physicalSessions.push(receipt.body.sdkSessionId);
    await until(() => program.active === null && program.state.value.outbox.length === 0);
    const actual = captures()[index].messages;
    assert.deepEqual(actual.map(message => message.role), ['system', 'user', 'assistant', 'user', 'user']);
    assert.deepEqual(actual.map(textOf), [context.systemPrompt, ...context.messages.map(message => message.content), `${context.text}\n${current}`]);
    assert.equal(actual.filter(message => message.role === 'user').flatMap(message => message.content).filter(block => block.text === current).length, 1, 'current user input appears once');
    assert.equal(captures().length, index + 1, 'one physical model request per application request');
  }
  assert.notEqual(physicalSessions[0], physicalSessions[1], 'complete context snapshots use fresh physical DSH sessions');
  await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId: 'empty-system', sessionId: 'same-logical-conversation', text: 'empty system is intentional',
    context: { version: 1, systemPrompt: '', messages: [] } });
  await until(() => messages.some(message => message.body.kind === 'dsh.accepted' && message.body.requestId === 'empty-system'));
  await until(() => program.active === null && program.state.value.outbox.length === 0);
  const empty = captures()[2].messages;
  // DSH reserves an empty system surface node but omits it from an LLM call.
  // This must not reactivate its default identity or any previous snapshot.
  assert.deepEqual(empty.map(message => message.role), ['user']);
  assert.deepEqual(empty.map(textOf), ['empty system is intentional']);
});

test('the context plugin exits its owned DSH process after client stdio EOF during a long response', async t => {
  const fixture = await createDshFixture({ installRoot, responseDelayMs: 15_000 });
  const patch = join(fixture.root, 'context.patch.yml');
  writeFileSync(patch, JSON.stringify([{ id: 'sdk-jsonrpc-server', disabled: true }, { insert: [{ id: 'peros-context-server',
    name: new URL('../../../examples/distributed-context/dsh-context-plugin.mjs', import.meta.url).href, config: { installRoot } }] }]), 'utf8');
  const child = spawn(fixture.executable, [...fixture.args, '--patch', patch], { cwd: fixture.workspace, env: fixture.env,
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let buffer = '';
  let outcome;
  let stderr = '';
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { outcome = { code, signal }; resolve(); }));
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
  t.after(async () => { if (!outcome) child.kill('SIGKILL'); await exited; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: fixture.initialize }) + '\n');
  const initialized = await until(() => frames.find(frame => frame.id === 'init'), { timeoutMs: 6000 });
  assert.equal(initialized.result?.serverInfo.name, 'peros-dsh-context-runtime');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'prompt', method: 'session/prompt', params: { sessionId: 'owned-eof-test',
    contentBlocks: [{ type: 'text', text: 'wait long enough to prove the client EOF shuts down DSH' }], context: { version: 1, systemPrompt: 'literal', messages: [] } } }) + '\n');
  await until(() => frames.some(frame => frame.id === 'prompt' && frame.result?.messageId) && existsSync(fixture.capturePath), { timeoutMs: 6000 });
  const closedAt = Date.now();
  // On Windows, destroy this parent's pipe handle after writable finish.
  child.stdin.end(() => child.stdin.destroy());
  await until(() => outcome, { timeoutMs: 7500 });
  assert.ok(Date.now() - closedAt < 7500, 'launcher shutdown must be bounded, even when the adapter ignores abort');
  assert.equal(outcome.code, 0, stderr);
  assert.equal(frames.some(frame => frame.params?.event?.type === 'assistant/message'), false, 'the delayed model response must not complete after losing its client');
});

test('unfinished intent becomes UNKNOWN_OUTCOME on restart without a model call', async t => {
  const { fixture, settings, client, messages } = await setup(t);
  let program = await startHarnessProgram(settings);
  await program.close();
  program.state.commit({ ...program.state.value, requests: [{ requestId: 'interrupted', sessionId: 'old-conversation', inputId: 'old-input', phase: 'dispatching', fingerprint: 'irrelevant', sdkSessionId: 'old-process-session', intent: { text: 'must never be replayed' }, response: null, pendingResponse: false }] });
  program = await startHarnessProgram(settings);
  t.after(() => program.close());
  const reply = await until(() => messages.find(message => message.body.requestId === 'interrupted' && message.body.error?.code === 'UNKNOWN_OUTCOME'));
  assert.equal(reply.replyTo, 'old-input');
  assert.equal(existsSync(fixture.capturePath), false, 'initialization and uncertain recovery make no model call');
  assert.equal(program.state.value.requests[0].phase, 'unknown');
});

test('blocked results stay durable and retry without a reconnect', async t => {
  const { settings, client, messages } = await setup(t);
  const program = await startHarnessProgram(settings);
  t.after(() => program.close());
  const publish = program.bridge.publishConfirmed.bind(program.bridge);
  let blocked = true;
  program.bridge.publishConfirmed = (...args) => blocked ? Promise.reject(new Error('simulated hub capacity rejection')) : publish(...args);
  await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId: 'blocked', sessionId: 'one', text: 'retain my result' });
  await until(() => program.active === null && program.state.value.requests.length === 1 && program.state.value.outbox.length > 0);
  const durableEventId = program.state.value.outbox.find(entry => entry.body.kind === 'dsh.notification').body.eventId;
  blocked = false;
  await until(() => program.state.value.outbox.length === 0, { timeoutMs: 6000 });
  assert.ok(messages.some(message => message.body.eventId === durableEventId));
  assert.ok(messages.some(message => message.body.requestId === 'blocked' && message.body.kind === 'dsh.accepted'));
});

test('close still stops its DSH child when uncertain-outcome persistence fails', async t => {
  const { settings, client, messages } = await setup(t, 2000);
  const program = await startHarnessProgram(settings);
  t.after(() => program.close().catch(() => {}));
  await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId: 'close-fail', sessionId: 'one', text: 'will stop before completion' });
  await until(() => messages.some(message => message.body.kind === 'dsh.accepted'));
  assert.ok(program.active);
  program.state.commit = () => { throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' }); };
  await assert.rejects(program.close(), /simulated disk failure/);
  assert.equal(program.rpc.state, 'closed');
});

test('failure to persist the SDK receipt stops the child and marks uncertainty', async t => {
  const { settings, client } = await setup(t, 2000);
  const program = await startHarnessProgram(settings);
  t.after(() => program.close());
  const save = program.state.commit.bind(program.state);
  program.state.commit = next => {
    if (next.requests.some(record => record.phase === 'accepted')) throw Object.assign(new Error('receipt disk failure'), { code: 'EIO' });
    return save(next);
  };
  await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId: 'receipt-fail', sessionId: 'one', text: 'cannot continue after receipt storage fails' });
  await until(() => program.failure && program.rpc.state === 'closed', { timeoutMs: 8000 });
  assert.equal(program.failure.code, 'EIO');
  assert.equal(program.state.value.requests[0].phase, 'unknown');
  assert.equal(program.state.value.requests[0].response.error.code, 'UNKNOWN_OUTCOME');
});

test('child notifications retain the main SDK identity and never complete the main request', async t => {
  const { settings, client, messages } = await setup(t, 1000);
  const program = await startHarnessProgram(settings);
  t.after(() => program.close());
  await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId: 'parent-request', sessionId: 'app-conversation', text: 'parent prompt' });
  const receipt = await until(() => messages.find(message => message.body.kind === 'dsh.accepted'));
  const mainSession = program.active.sdkSessionId;
  assert.equal(receipt.body.sdkSessionId, mainSession);
  const start = { jsonrpc: '2.0', method: 'subagent.started', params: { parentSessionId: mainSession, childSessionId: 'fixture-child' } };
  const childMessage = { jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'fixture-child', event: { type: 'assistant/message', seq: 1, data: { message: { id: 'child-message', content: [{ type: 'text', text: 'child diagnostic only' }] } } } } };
  const childEnd = { jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'fixture-child', event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } } } };
  const childIdle = { jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'fixture-child', status: 'idle' } };
  for (const frame of [start, childMessage, childEnd, childIdle]) program.rpc.emit('notification', frame);
  const forwarded = await until(() => messages.find(message => message.body.frame?.params?.event?.data?.message?.id === 'child-message'));
  assert.equal(forwarded.body.sdkSessionId, mainSession);
  assert.equal(forwarded.body.sessionId, 'app-conversation');
  assert.deepEqual(forwarded.body.frame, childMessage);
  assert.ok(program.active, 'child completion must not clear the main active request');
  await until(() => program.active === null);
  program.rpc.emit('notification', { jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'unknown-foreign-session', status: 'idle' } });
  await until(() => program.rpc.state === 'closed');
  assert.equal(program.failure.code, 'UNOWNED_DSH_EVENT', 'an unknown session must not inherit the active request');
});

test('one harness process exclusively owns its application state until close', async t => {
  const { settings, client } = await setup(t);
  let program = await startHarnessProgram(settings);
  t.after(() => program.close());
  await client.publishConfirmed(settings.channels.harnessRequest, { kind: 'dsh.prompt', requestId: 'lease-journal', sessionId: 'one', text: 'persist state before the duplicate owner attempt' });
  await until(() => program.active === null && program.state.value.requests.length === 1 && program.state.value.outbox.length === 0);
  const journal = readFileSync(program.state.path, 'utf8');
  await assert.rejects(startHarnessProgram(settings), error => error.code === 'STATE_IN_USE');
  assert.equal(readFileSync(program.state.path, 'utf8'), journal, 'second owner must not read/repair/write the first journal');
  assert.equal(program.rpc.state, 'running');
  await program.close();
  program = await startHarnessProgram(settings);
  assert.equal(program.rpc.state, 'running');
  assert.equal(program.state.value.requests[0].phase, 'completed');
  await program.close();
  writeFileSync(program.state.path, '{', 'utf8');
  await assert.rejects(startHarnessProgram(settings), /application state cannot be read/);
  writeFileSync(program.state.path, journal, 'utf8');
  program = await startHarnessProgram(settings);
  assert.equal(program.rpc.state, 'running', 'state-construction failure must release the lease');
});
