import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HubMcpService } from '../../../tools/mcp/service.mjs';
import { until } from '../../helpers/hub-harness.mjs';
import { hubFixture, startAdapter, resultData, allowedTopic, secondTopic } from './helpers.mjs';

const options = { timeout: 20000 };
async function success(adapter, name, args = {}) {
  const result = await adapter.call(name, args), value = resultData(result);
  assert.equal(result.isError ?? false, false, JSON.stringify(value));
  assert.equal(value.ok, true); return value;
}

test('credential redaction handles quotes, backslashes and single-character tokens without corrupting JSON or protocol fields', async () => {
  for (const token of ['private"token', 'private\\token', ':', 'o', 'a']) {
    const service = new HubMcpService({ format: 'world-hub.mcp/v1', bridge: { url: 'ws://127.0.0.1:1', bridgeId: 'redaction.review', token } });
    try {
      service.execute = async () => ({ ok: true, echoed: token, nested: [{ value: `prefix ${token} suffix` }], untouched: 123 });
      const result = await service.result('hub_identity', {}), data = resultData(result);
      assert.equal(data.ok, true); assert.equal(data.untouched, 123);
      assert.equal(data.echoed, '[REDACTED]');
      const replaced = `prefix ${token} suffix`.split(token).join('[REDACTED]');
      assert.equal(data.nested[0].value, replaced);
      service.execute = async () => { throw Object.assign(new Error(`remote echoed ${token}`), { code: 'REMOTE_ERROR' }); };
      const failure = resultData(await service.result('hub_identity', {}));
      assert.equal(failure.error.message, `remote echoed ${token}`.split(token).join('[REDACTED]'));
      assert.equal(failure.error.code, 'REMOTE_ERROR'.split(token).join('[REDACTED]'));
    } finally { await service.close(); }
  }
});

test('real Hub delivery-window overflow is visible, stops that subscription, and can be explicitly replayed without provider release', options, async t => {
  const f = await hubFixture(t, { limits: { maxPendingDeliveries: 1 } }), source = await f.bridge('source'), adapter = await startAdapter(f);
  const subscription = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 'now' });
  const first = await source.publishConfirmed(allowedTopic, { ordinal: 1 });
  const buffered = await success(adapter, 'hub_pull', { subscription: subscription.subscription, waitMs: 1000 });
  assert.deepEqual(buffered.messages.map(row => row.seq), [first.seq]);
  const missing = await source.publishConfirmed(allowedTopic, { ordinal: 2 });
  const identity = await until(async () => {
    const value = await success(adapter, 'hub_identity');
    return value.subscriptions[0]?.stopped ? value : false;
  });
  assert.equal(identity.subscriptions[0].barrier.code, 'HUB_DELIVERY_GAP');
  assert.deepEqual(identity.subscriptions[0].barrier.dropped, [missing.seq, missing.seq]);
  const result = await adapter.call('hub_pull', { subscription: subscription.subscription, waitMs: 1000 }), failed = resultData(result);
  assert.equal(result.isError, true); assert.equal(failed.error.code, 'HUB_DELIVERY_GAP');
  assert.deepEqual(failed.error.details.dropped, [missing.seq, missing.seq]);
  assert.match(failed.error.details.recovery, /Unsubscribe/);
  await success(adapter, 'hub_unsubscribe', { subscription: subscription.subscription });
  const replay = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 0 });
  const seen = [];
  for (let index = 0; index < 2; index++) {
    const batch = await success(adapter, 'hub_pull', { subscription: replay.subscription, waitMs: 1000 });
    seen.push(...batch.messages.map(row => row.seq));
    await success(adapter, 'hub_ack', { subscription: replay.subscription, seqs: batch.messages.map(row => row.seq) });
  }
  assert.deepEqual(seen, [first.seq, missing.seq]);
  assert.deepEqual((await f.records()).map(row => row.seq), [first.seq, missing.seq], 'overflow and consumer ACK do not release provider information');
});

test('real provider-released retention gaps are explicit and require the consumer to choose a new starting sequence', options, async t => {
  const f = await hubFixture(t, { log: { segmentMaxBytes: 1, segmentMaxCount: 1 } }), source = await f.bridge('source');
  const removed = await source.publishConfirmed(allowedTopic, { older: true });
  await source.release([removed.seq]);
  const retained = await source.publishConfirmed(allowedTopic, { retained: true });
  assert.deepEqual((await f.records()).map(row => row.seq), [retained.seq]);
  const adapter = await startAdapter(f), subscription = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 0 });
  const identity = await until(async () => {
    const value = await success(adapter, 'hub_identity');
    return value.subscriptions[0]?.stopped ? value : false;
  });
  const barrier = identity.subscriptions[0].barrier;
  assert.equal(barrier.code, 'CATCHUP_TRUNCATED'); assert.equal(barrier.oldestAvailable, retained.seq);
  const failed = await adapter.call('hub_pull', { subscription: subscription.subscription, waitMs: 1000 });
  assert.equal(failed.isError, true); assert.equal(resultData(failed).error.code, 'CATCHUP_TRUNCATED');
  await success(adapter, 'hub_unsubscribe', { subscription: subscription.subscription });
  const accepted = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: barrier.oldestAvailable - 1 });
  const batch = await success(adapter, 'hub_pull', { subscription: accepted.subscription, waitMs: 1000 });
  assert.deepEqual(batch.messages.map(row => row.seq), [retained.seq]);
});

test('responses obey the local target-principal allowlist even when an unlisted program can request this bridge', options, async t => {
  const f = await hubFixture(t), full = f.config(), adapter = await startAdapter(f, { ...full, permissions: { ...full.permissions, targetPrincipals: ['source'] } });
  const provider = await f.bridge('provider'), source = await f.bridge('source');
  const subscription = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], operations: ['request'], from: 'now' });
  const rejectedRequest = await provider.requestTo({ principal: 'mcp.tools' }, allowedTopic, { origin: 'not locally allowed' });
  await success(adapter, 'hub_pull', { subscription: subscription.subscription, waitMs: 1000 });
  const denied = await adapter.call('hub_respond', { requestSeq: rejectedRequest.seq, body: { result: 'must not leave this bridge' } });
  assert.equal(denied.isError, true); assert.equal(resultData(denied).error.code, 'LOCAL_PERMISSION_DENIED');
  assert.equal((await f.records()).filter(row => row.operation === 'response').length, 0);
  const permittedRequest = await source.requestTo({ principal: 'mcp.tools' }, allowedTopic, { origin: 'locally allowed' });
  await until(async () => {
    const pulled = await success(adapter, 'hub_pull', { subscription: subscription.subscription });
    return pulled.messages.some(row => row.seq === permittedRequest.seq);
  });
  await success(adapter, 'hub_respond', { requestSeq: permittedRequest.seq, body: { result: 'permitted response' } });
  const responses = (await f.records()).filter(row => row.operation === 'response');
  assert.equal(responses.length, 1); assert.equal(responses[0].requestSeq, permittedRequest.seq);
});

test('stdio transport input overflow exits an already connected adapter and closes its Hub socket', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f);
  await success(adapter, 'hub_identity');
  // Retain the stdin writer, as a malfunctioning host may leave it open after
  // exceeding framing limits. Transport closure must still retire the service.
  const child = adapter.transport._process;
  child.stdin.write('x'.repeat(2 * 1024 * 1024 + 1));
  await until(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 3000, what: 'transport overflow shutdown' });
  await until(async () => (await f.hub.status()).bridges.length === 0);
  assert.equal(child.signalCode, null); assert.equal(child.exitCode, 0);
  assert.match(adapter.stderr, /transport error/);
});

test('a fresh Hub welcome after disconnect must authenticate again even without active MCP subscriptions', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f);
  assert.equal((await success(adapter, 'hub_identity')).authenticated, true);
  const port = f.hub.port;
  await f.hub.stop();
  // Reuse only this fixture's owned port/state and deliberately downgrade its
  // loopback credential. A previously trusted connection cannot trust it now.
  f.hub.opts.port = port;
  const path = join(f.root, 'hub.json'), config = JSON.parse(await readFile(path, 'utf8'));
  delete config.acl.credentials['mcp.tools'].token;
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await f.hub.startHub({ configPath: path, isolateLog: false });
  const result = await adapter.call('hub_identity'), value = resultData(result);
  assert.equal(result.isError, true); assert.equal(value.error.code, 'HUB_IDENTITY_MISMATCH');
  await until(async () => (await f.hub.status()).bridges.length === 0);
  assert.equal((await f.records()).length, 0);
});

test('concurrent unsubscribe of one populated inbox cannot subtract buffered deliveries twice', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f), source = await f.bridge('source');
  const subscription = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 'now' });
  await source.publishConfirmed(allowedTopic, { retained: 'after concurrent removal' });
  const batch = await success(adapter, 'hub_pull', { subscription: subscription.subscription, waitMs: 1000 });
  assert.equal(batch.messages.length, 1);
  const results = await Promise.all([
    adapter.call('hub_unsubscribe', { subscription: subscription.subscription }),
    adapter.call('hub_unsubscribe', { subscription: subscription.subscription }),
  ]);
  assert.ok(results.some(result => resultData(result).ok));
  const identity = await success(adapter, 'hub_identity');
  assert.equal(identity.bufferedMessages, 0); assert.equal(identity.bufferedBytes, 0); assert.deepEqual(identity.subscriptions, []);
  assert.equal((await f.records()).length, 1);
});

test('MCP uploads an opaque blob, publishes its UUID, and reads the received attachment using the actual Hub protocol', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f), source = await f.bridge('source'), observed = [];
  source.on('delivery', frame => { observed.push(frame); });
  await source.subscribe([allowedTopic], { from: 'now' });
  const bytes = Buffer.from('opaque bytes \u0000 \u4f60\u597d'), hash = createHash('sha256').update(bytes).digest('hex');
  const uploaded = await success(adapter, 'hub_blob_upload', { data: bytes.toString('base64') });
  assert.equal(uploaded.blob.sha256, hash); assert.equal(uploaded.blob.size, bytes.length);
  const accepted = await success(adapter, 'hub_publish', { topic: allowedTopic, body: { anyKind: 'not-enumerated-by-hub' }, options: { attachments: [uploaded.blob.id] } });
  await until(() => observed.some(frame => frame.seq === accepted.receipt.seq));
  const publication = observed.find(frame => frame.seq === accepted.receipt.seq);
  assert.deepEqual(publication.attachments.map(item => item.id), [uploaded.blob.id]);
  const subscription = await success(adapter, 'hub_subscribe', { topics: [allowedTopic], from: 0 });
  const received = await success(adapter, 'hub_pull', { subscription: subscription.subscription, waitMs: 1000 });
  assert.deepEqual(received.messages.map(frame => frame.seq), [accepted.receipt.seq]);
  const read = await success(adapter, 'hub_blob_read', { messageSeq: accepted.receipt.seq, id: uploaded.blob.id });
  assert.deepEqual(Buffer.from(read.chunk.data, 'base64'), bytes); assert.equal(read.chunk.sha256, hash);
  await success(adapter, 'hub_ack', { subscription: subscription.subscription, seqs: [accepted.receipt.seq] });
  const afterAck = await success(adapter, 'hub_blob_read', { messageSeq: accepted.receipt.seq, id: uploaded.blob.id });
  assert.deepEqual(Buffer.from(afterAck.chunk.data, 'base64'), bytes, 'consumer ACK does not revoke provider retention or recent attachment authorization');
});

test('raw blob IDs cannot bypass local subscribe-topic grants even when the Hub credential allows the private topic', options, async t => {
  const f = await hubFixture(t), source = await f.bridge('source'), full = f.config();
  const adapter = await startAdapter(f, { ...full, permissions: { ...full.permissions, subscribeTopics: [allowedTopic] } });
  const bytes = Buffer.from('not authorized by the local MCP topic grant'), hash = createHash('sha256').update(bytes).digest('hex');
  const uploaded = await source.uploadStream([bytes], { size: bytes.length, sha256: hash });
  const privatePublication = await source.publishConfirmed(secondTopic, { private: true }, { attachments: [uploaded.id] });
  const result = await adapter.call('hub_blob_read', { messageSeq: privatePublication.seq, id: uploaded.id });
  assert.equal(result.isError, true); assert.equal(resultData(result).error.code, 'ATTACHMENT_NOT_RECEIVED');
  assert.ok(!JSON.stringify(result).includes(bytes.toString('base64')));
  assert.equal((await f.records()).length, 1);
});

test('an authenticated call response authorizes its attachment without requiring a separate user subscription', options, async t => {
  const f = await hubFixture(t), provider = await f.bridge('provider'), adapter = await startAdapter(f);
  const bytes = Buffer.from('program-selected call result bytes'), hash = createHash('sha256').update(bytes).digest('hex');
  const object = await provider.uploadStream([bytes], { size: bytes.length, sha256: hash });
  provider.on('delivery', async frame => {
    if (frame.operation === 'request') await provider.respond(frame, { result: 'opaque attachment' }, { attachments: [object.id] });
  });
  await provider.subscribe([allowedTopic], { operations: ['request'], from: 'now' });
  const call = await success(adapter, 'hub_call', { target: { principal: 'provider' }, topic: allowedTopic, body: { request: 'bytes' } });
  assert.deepEqual(call.response.attachments.map(item => item.id), [object.id]);
  const chunk = await success(adapter, 'hub_blob_read', { messageSeq: call.response.seq, id: object.id });
  assert.deepEqual(Buffer.from(chunk.chunk.data, 'base64'), bytes);
});

test('provider release is limited to recent successful publications of this MCP connection and cannot bypass local topic grants', options, async t => {
  const f = await hubFixture(t), full = f.config();
  const adapter = await startAdapter(f, { ...full, permissions: { ...full.permissions, publishTopics: [allowedTopic] } });
  const samePrincipal = await f.bridge('mcp.tools', 'another.program.bridge');
  const privateReceipt = await samePrincipal.publishConfirmed(secondTopic, { private: 'protected' });
  const otherReceipt = await samePrincipal.publishConfirmed(allowedTopic, { otherBridge: 'protected' });
  for (const seq of [privateReceipt.seq, otherReceipt.seq]) {
    const denied = await adapter.call('hub_release', { seqs: [seq] });
    assert.equal(denied.isError, true); assert.equal(resultData(denied).error.code, 'MESSAGE_NOT_PUBLISHED');
  }
  const own = await success(adapter, 'hub_publish', { topic: allowedTopic, body: { providerPolicy: 'now disposable' } });
  const released = await success(adapter, 'hub_release', { seqs: [own.receipt.seq] });
  assert.deepEqual(released.receipt.seq, [own.receipt.seq]);
  assert.deepEqual((await f.records()).map(row => row.seq), [privateReceipt.seq, otherReceipt.seq, own.receipt.seq], 'release is permission for later cleanup, not immediate deletion');
  await adapter.close();
  const fresh = await startAdapter(f, { ...full, permissions: { ...full.permissions, publishTopics: [allowedTopic] } });
  const old = await fresh.call('hub_release', { seqs: [own.receipt.seq] });
  assert.equal(old.isError, true); assert.equal(resultData(old).error.code, 'MESSAGE_NOT_PUBLISHED');
});
