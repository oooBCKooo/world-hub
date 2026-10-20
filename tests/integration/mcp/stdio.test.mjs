import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { until, sleep } from '../../helpers/hub-harness.mjs';
import { hubFixture, startAdapter, resultData, assertNoSecrets, repository, allowedTopic, secondTopic } from './helpers.mjs';

const options = { timeout: 20000 };
const call = async (adapter, name, args = {}, opts) => {
  const result = await adapter.call(name, args, opts), value = resultData(result);
  assert.equal(result.isError ?? false, false, JSON.stringify(value)); assert.equal(value.ok, true); return value;
};

test('SDK modern discovery is lazy, identity is authenticated, and channels are registered on the real Hub', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f);
  const listing = await adapter.client.listTools();
  for (const name of ['hub_identity', 'hub_publish', 'hub_pull', 'hub_call', 'hub_inject', 'hub_respond']) assert.ok(listing.tools.some(tool => tool.name === name));
  assertNoSecrets(listing, f.tokens);
  assert.equal((await f.hub.status()).bridges.length, 0, 'MCP discovery does not connect a Hub bridge');
  const identity = await call(adapter, 'hub_identity');
  assert.equal(identity.principal, 'mcp.tools'); assert.equal(identity.authenticated, true); assert.equal(identity.connected, true);
  assert.equal(typeof identity.session, 'string');
  await call(adapter, 'hub_register_channels', { channels: [{ name: allowedTopic, publish: true, subscribe: true }] });
  const observed = (await f.hub.status()).bridges.find(bridge => bridge.principal === 'mcp.tools');
  assert.equal(observed.session, identity.session);
  assert.deepEqual(observed.channels, [{ name: allowedTopic, publish: true, subscribe: true }]);
  assertNoSecrets(adapter.stderr, f.tokens);
});

test('MCP publication reaches a normal bridge and information can be pulled again after ACK', options, async t => {
  const f = await hubFixture(t), source = await f.bridge('source'), deliveries = [];
  source.on('delivery', message => { deliveries.push(message); });
  await source.subscribe([allowedTopic], { from: 'now' });
  const adapter = await startAdapter(f), body = { arbitraryKind: 'not-enumerated-in-hub', nested: ['你好', 23] };
  const published = await call(adapter, 'hub_publish', { topic: allowedTopic, body });
  await until(() => deliveries.some(message => message.seq === published.receipt.seq));
  assert.deepEqual(deliveries.find(message => message.seq === published.receipt.seq).body, body);
  const record = await f.awaitRecord(row => row.seq === published.receipt.seq);
  assert.deepEqual(record.body, body);
  const subscription = await call(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 0 });
  const first = await call(adapter, 'hub_pull', { subscription: subscription.subscription, maxMessages: 5, waitMs: 500 });
  assert.deepEqual(first.messages.map(message => message.seq), [published.receipt.seq]);
  await call(adapter, 'hub_ack', { subscription: subscription.subscription, seqs: [published.receipt.seq] });
  await call(adapter, 'hub_unsubscribe', { subscription: subscription.subscription });
  const again = await call(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 0 });
  const second = await call(adapter, 'hub_pull', { subscription: again.subscription, maxMessages: 5, waitMs: 500 });
  assert.deepEqual(second.messages.map(message => message.seq), [published.receipt.seq], 'ACK never decides provider retention');
  assert.ok((await f.records()).some(row => row.seq === published.receipt.seq));
});

test('call and injection use trusted Hub identities and exact target sessions rather than self-reported body fields', options, async t => {
  const f = await hubFixture(t), provider = await f.bridge('provider', 'provider.one'), other = await f.bridge('provider', 'provider.two');
  const received = [], others = [];
  provider.on('delivery', async message => {
    received.push(message);
    if (message.operation === 'request') await provider.respond(message, { ok: true, answer: message.body.value * 2, claimedSender: message.body.fromPrincipal });
  });
  other.on('delivery', message => { others.push(message); });
  for (const bridge of [provider, other]) await bridge.subscribe([allowedTopic], { operations: ['request', 'inject'], from: 'now' });
  const adapter = await startAdapter(f);
  const result = await call(adapter, 'hub_call', { target: { principal: 'provider', session: provider.welcome.session }, topic: allowedTopic,
    body: { value: 21, fromPrincipal: 'source' }, options: { timeoutMs: 1500 } });
  assert.equal(result.response.body.answer, 42); assert.equal(result.response.fromPrincipal, 'provider');
  assert.equal(result.response.requestSeq, result.request.seq);
  assert.equal(received[0].fromPrincipal, 'mcp.tools'); assert.equal(received[0].body.fromPrincipal, 'source');
  const injected = await call(adapter, 'hub_inject', { target: { principal: 'provider', session: provider.welcome.session }, topic: allowedTopic,
    body: { action: 'a-program-defined-effect' } });
  await until(() => received.some(message => message.seq === injected.receipt.seq));
  assert.equal(received.find(message => message.seq === injected.receipt.seq).operation, 'inject');
  await sleep(60); assert.equal(others.length, 0);
  const records = await f.records();
  assert.equal(records.filter(row => row.operation === 'request').length, 1);
  assert.equal(records.filter(row => row.operation === 'response').length, 1);
  assert.equal(records.filter(row => row.operation === 'inject').length, 1);
});

test('an external caller can request an MCP bridge and receive a trusted response; unrelated response claims fail', options, async t => {
  const f = await hubFixture(t), source = await f.bridge('source'), provider = await f.bridge('provider'), adapter = await startAdapter(f);
  await call(adapter, 'hub_subscribe', { topics: [secondTopic], operations: ['request'], from: 'now' });
  const pending = source.call({ principal: 'mcp.tools' }, secondTopic, { question: 'opaque request' }, { timeoutMs: 3000 });
  const identity = await call(adapter, 'hub_identity'), subscription = identity.subscriptions[0];
  const id = typeof subscription === 'string' ? subscription : subscription.id ?? subscription.subscription;
  const pulled = await call(adapter, 'hub_pull', { subscription: id, maxMessages: 5, waitMs: 1000 });
  assert.equal(pulled.messages.length, 1); const request = pulled.messages[0];
  assert.equal(request.fromPrincipal, 'source'); assert.equal(request.target.principal, 'mcp.tools');
  await assert.rejects(provider.respond(request.seq, { forged: true }), { code: 'RESPONSE_DENIED' });
  const response = await call(adapter, 'hub_respond', { requestSeq: request.seq, body: { independent: 'program-result' } });
  const result = await pending;
  assert.equal(result.response.seq, response.receipt.seq); assert.equal(result.response.fromPrincipal, 'mcp.tools');
  assert.deepEqual(result.response.body, { independent: 'program-result' });
});

test('local tool, topic, and target permissions narrow authority without writing any denied message to the Hub', options, async t => {
  const f = await hubFixture(t), full = f.config();
  const adapter = await startAdapter(f, { ...full, permissions: { ...full.permissions, tools: ['hub_identity', 'hub_publish', 'hub_call'] } });
  await call(adapter, 'hub_identity');
  for (const [name, args] of [
    ['hub_inject', { target: { principal: 'provider' }, topic: allowedTopic, body: {} }],
    ['hub_publish', { topic: 'undeclared/new/topic', body: {} }],
    ['hub_call', { target: { principal: 'not-authorized' }, topic: allowedTopic, body: {} }]
  ]) {
    const result = await adapter.call(name, args), data = resultData(result);
    assert.equal(result.isError, true); assert.equal(data.ok, false); assert.match(data.error.code, /DENIED|PERMISSION|NOT_ALLOWED/);
  }
  assert.equal((await f.records()).length, 0);
  assertNoSecrets(adapter.stderr, f.tokens);
});

test('Hub ACL remains authoritative after adapter authorization and errors do not expose credentials', options, async t => {
  const f = await hubFixture(t, { mcpAllow: { publish: [secondTopic], subscribe: [secondTopic] } }), adapter = await startAdapter(f);
  const result = await adapter.call('hub_publish', { topic: allowedTopic, body: { request: 'adapter allows but Hub refuses' } }), data = resultData(result);
  assert.equal(result.isError, true); assert.equal(data.ok, false); assert.equal(data.error.code, 'PUBLISH_DENIED');
  assert.equal((await f.records()).length, 0); assertNoSecrets(adapter.stderr, f.tokens);
  const bad = f.config(); bad.bridge = { ...bad.bridge, bridgeId: 'bad-auth', token: 'wrong-token' };
  const invalid = await startAdapter(f, bad), auth = await invalid.call('hub_identity'), error = resultData(auth);
  assert.equal(auth.isError, true); assert.equal(error.ok, false); assert.match(error.error.code, /AUTH|CONNECT|DENIED|REJECTED/);
  assertNoSecrets([adapter.calls, invalid.calls, adapter.stderr, invalid.stderr], f.tokens);
});

test('an accepted call timeout leaves exactly one retained request and does not retry or release it', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f);
  const result = await adapter.call('hub_call', { target: { principal: 'provider' }, topic: allowedTopic,
    body: { invocation: 'only-once-despite-timeout' }, options: { timeoutMs: 100 } }), data = resultData(result);
  assert.equal(result.isError, true); assert.equal(data.ok, false); assert.match(data.error.code, /TIMEOUT/);
  await sleep(200);
  const records = (await f.records()).filter(row => row.operation === 'request');
  assert.equal(records.length, 1); assert.deepEqual(records[0].body, { invocation: 'only-once-despite-timeout' });
  const provider = await f.bridge('provider'), received = [];
  provider.on('delivery', message => { received.push(message); });
  await provider.subscribe([allowedTopic], { from: 0, operations: ['request'] });
  await until(() => received.length === 1);
  assert.equal(received[0].seq, records[0].seq, 'accepted request remains available to an offline provider');
  const identity = await call(adapter, 'hub_identity'); assert.equal(identity.subscriptions.length, 0);
});

test('MCP cancellation stops local waiting, preserves one accepted request, and keeps unrelated tools usable', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f), controller = new AbortController();
  const pending = adapter.call('hub_call', { target: { principal: 'provider' }, topic: allowedTopic,
    body: { invocation: 'cancel-one-local-wait' }, options: { timeoutMs: 10000 } }, { signal: controller.signal, timeout: 12000 });
  const rejection = assert.rejects(pending, error => { assert.match(error.message, /abort|cancel/i); return true; });
  await f.awaitRecord(row => row.operation === 'request'); controller.abort(); await rejection;
  await until(async () => (await call(adapter, 'hub_identity')).subscriptions.length === 0);
  const result = await call(adapter, 'hub_publish', { topic: secondTopic, body: { after: 'cancel' } });
  assert.ok(result.receipt.seq > 0);
  const records = await f.records(); assert.equal(records.filter(row => row.operation === 'request').length, 1);
});

test('legacy initialize is explicitly rejected and cannot establish a Hub connection', options, async t => {
  const f = await hubFixture(t);
  await assert.rejects(startAdapter(f, f.config(), { legacy: true }), error => { assert.match(error.message, /legacy|initialize|unsupported|not found/i); return true; });
  assert.equal((await f.hub.status()).bridges.length, 0);
  assert.equal((await f.records()).length, 0);
});

test('stdin EOF exits the owned stdio server and retires its authenticated Hub connection', options, async t => {
  const f = await hubFixture(t), configFile = join(f.root, 'raw-stdio.json');
  await writeFile(configFile, JSON.stringify(f.config()), { mode: 0o600 });
  const child = spawn(process.execPath, [join(repository, 'tools/mcp/cli.mjs'), '--config', configFile], { cwd: f.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes.toString(); }); child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  let exit; const exited = new Promise(resolveExit => { child.once('exit', (code, signal) => { exit = { code, signal }; resolveExit(exit); }); });
  t.after(async () => { if (!exit) { child.kill('SIGKILL'); await exited; } });
  child.stdin.end();
  await until(() => exit, { timeoutMs: 3000, what: 'MCP stdio EOF shutdown' });
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  assertNoSecrets(stdout + stderr, f.tokens); assert.equal((await f.hub.status()).bridges.length, 0);
});
