import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateConfig } from '../../../tools/mcp/config.mjs';
import { HubMcpService } from '../../../tools/mcp/service.mjs';
import { hubFixture, startAdapter, resultData, allowedTopic, assertNoSecrets } from './helpers.mjs';

const options = { timeout: 20000 };
const manageNames = ['hub_manage_operations', 'hub_manage_read', 'hub_manage_write'];
function managementConfig(f, operations, tools = manageNames) {
  return { format: 'world-hub.mcp/v1', management: { url: f.hub.httpBase, operations }, permissions: { tools }, limits: { requestTimeoutMs: 1500 } };
}
async function success(adapter, name, args = {}) {
  const result = await adapter.call(name, args), value = resultData(result);
  assert.equal(result.isError ?? false, false, JSON.stringify(value)); assert.equal(value.ok, true); return value;
}

test('management configuration requires an exact known operation allowlist and a fixed local HTTP origin', () => {
  const config = { format: 'world-hub.mcp/v1', management: { url: 'http://127.0.0.1:8790', operations: ['hub.state'] }, permissions: { tools: ['hub_manage_read'] } };
  assert.equal(validateConfig(config).bridge, undefined, 'a management-only client needs no fictional bridge');
  for (const url of ['http://example.com', 'http://127.0.0.1:8790/manage/api', 'http://user:password@127.0.0.1:8790', 'http://127.0.0.1:8790/?target=other', 'https://127.0.0.1:8790', ' http://127.0.0.1:8790', 'http://2130706433:8790', 'http://127.0.0.1:8790\\']) {
    assert.throws(() => validateConfig({ ...config, management: { ...config.management, url } }), /management.url/);
  }
  for (const operations of [undefined, ['*'], ['hub.#'], ['not.a.real.operation']]) assert.throws(() => validateConfig({ ...config, management: { ...config.management, operations } }), /management.operations/);
  assert.throws(() => validateConfig({ ...config, permissions: { tools: ['hub_manage_read', 'hub_identity'] } }), /bridge is required/);
});

test('default communication discovery grants no management authority or HTTP endpoint access', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f), listing = await adapter.client.listTools();
  assert.ok(listing.tools.every(tool => !manageNames.includes(tool.name)));
  assert.equal((await f.hub.status()).bridges.length, 0);
  const full = f.config(), service = new HubMcpService({ ...full, permissions: { ...full.permissions, tools: [...full.permissions.tools, ...manageNames] } });
  t.after(() => service.close());
  const failed = resultData(await service.result('hub_manage_read', { operation: 'hub.state' }));
  assert.equal(failed.error.code, 'MANAGEMENT_NOT_CONFIGURED');
  assert.equal(service.bridge, null, 'a denied management request must not open a bridge');
  assert.equal((await f.hub.status()).bridges.length, 0);
});

test('management-only stdio discovery and reads use HTTP without ever establishing a WebSocket bridge', options, async t => {
  const f = await hubFixture(t), config = managementConfig(f, ['hub.state', 'programs.list', 'annotations.save']), adapter = await startAdapter(f, config);
  const listing = await adapter.client.listTools();
  assert.deepEqual(listing.tools.map(tool => tool.name).sort(), [...manageNames].sort());
  const read = listing.tools.find(tool => tool.name === 'hub_manage_read'), write = listing.tools.find(tool => tool.name === 'hub_manage_write');
  assert.equal(read.annotations.readOnlyHint, true); assert.equal(read.annotations.destructiveHint, false);
  assert.equal(write.annotations.readOnlyHint, false); assert.equal(write.annotations.destructiveHint, true);
  assert.deepEqual(read.inputSchema.properties.operation.enum, ['hub.state', 'programs.list']);
  assert.deepEqual(write.inputSchema.properties.operation.enum, ['annotations.save']);
  const directory = await success(adapter, 'hub_manage_operations');
  assert.deepEqual(directory.operations.map(item => item.name), config.management.operations);
  const state = await success(adapter, 'hub_manage_read', { operation: 'hub.state' });
  assert.ok(state.result.hub); assert.equal(state.result.csrfToken, undefined);
  const rawState = await (await fetch(f.hub.httpBase + '/manage/api/state')).json();
  assert.equal(typeof rawState.csrfToken, 'string');
  assert.ok(!JSON.stringify(adapter.calls).includes(rawState.csrfToken));
  await success(adapter, 'hub_manage_read', { operation: 'programs.list' });
  assert.equal((await f.hub.status()).bridges.length, 0, 'management reads need no hello, welcome or bridge credential');
  assertNoSecrets([listing, adapter.calls, adapter.stderr], f.tokens);
});

test('management operation permission and read/write classification fail before any HTTP or bridge operation', options, async t => {
  const f = await hubFixture(t), config = managementConfig(f, ['hub.state', 'annotations.save', 'environment.detect'], ['hub_manage_read']);
  const adapter = await startAdapter(f, config), listing = await adapter.client.listTools();
  assert.deepEqual(listing.tools.map(tool => tool.name), ['hub_manage_read']);
  const service = new HubMcpService(config); t.after(() => service.close());
  let requests = 0;
  service.management.execute = async () => { requests++; throw new Error('must not reach HTTP'); };
  for (const [name, operation, code] of [
    ['hub_manage_read', 'programs.list', 'LOCAL_PERMISSION_DENIED'],
    ['hub_manage_read', 'annotations.save', 'MANAGEMENT_OPERATION_KIND'],
    ['hub_manage_read', 'environment.detect', 'MANAGEMENT_OPERATION_KIND'],
    ['hub_manage_write', 'annotations.save', 'LOCAL_PERMISSION_DENIED'],
  ]) assert.equal(resultData(await service.result(name, { operation })).error.code, code);
  assert.equal(requests, 0); assert.equal(service.bridge, null);
  assert.equal((await f.hub.status()).bridges.length, 0);
});

test('management writes obtain CSRF privately, retain explicit review and acceptance, and never auto-apply', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f, managementConfig(f, ['hub.state', 'annotations.save', 'resources.cleanup.preview', 'resources.cleanup.apply']));
  const denied = await fetch(f.hub.httpBase + '/manage/api/annotation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'source', bridgeName: 'denied', programs: [] }) });
  assert.equal(denied.status, 403, 'the actual Hub still requires CSRF for raw POST requests');
  await success(adapter, 'hub_manage_write', { operation: 'annotations.save', input: { key: 'source', bridgeName: 'independent HTTP management', programs: [] } });
  const state = await success(adapter, 'hub_manage_read', { operation: 'hub.state' });
  assert.equal(state.result.bridges.find(row => row.key === 'source').label, 'independent HTTP management');
  const preview = await success(adapter, 'hub_manage_read', { operation: 'resources.cleanup.preview', input: { keepProfileIds: [] } });
  assert.equal(typeof preview.result.reviewId, 'string');
  for (const input of [{}, { accepted: true }, { reviewId: preview.result.reviewId }, { reviewId: preview.result.reviewId, accepted: false }]) {
    const failed = await adapter.call('hub_manage_write', { operation: 'resources.cleanup.apply', input });
    assert.equal(failed.isError, true); assert.match(resultData(failed).error.code, /REVIEW|ACCEPT|INPUT/);
  }
  const applied = await success(adapter, 'hub_manage_write', { operation: 'resources.cleanup.apply', input: { reviewId: preview.result.reviewId, accepted: true } });
  assert.ok(applied.result);
  const rawState = await (await fetch(f.hub.httpBase + '/manage/api/state')).json();
  assert.ok(!JSON.stringify(adapter.calls).includes(rawState.csrfToken));
  assert.equal((await f.hub.status()).bridges.length, 0);
});

test('MCP management redaction is a second boundary after client response filtering', async () => {
  const service = new HubMcpService({ format: 'world-hub.mcp/v1', management: { url: 'http://127.0.0.1:1', operations: ['hub.state'] }, permissions: { tools: ['hub_manage_read'] } });
  try {
    service.management.execute = async () => ({ csrfToken: 'private-csrf', token: 'private-token', nested: { authorizationReceipt: 'private-receipt', credentialTokens: ['private-credential'], kept: 123 }, record: { body: { token: 'opaque application token', nested: { password: 'opaque data' } } } });
    assert.deepEqual(resultData(await service.result('hub_manage_read', { operation: 'hub.state' })).result, { nested: { kept: 123 }, record: { body: { token: 'opaque application token', nested: { password: 'opaque data' } } } });
    service.management.execute = async () => { throw Object.assign(new Error('The write outcome is unknown; inspect state before retrying.'), { code: 'MANAGEMENT_TIMEOUT', outcome: 'unknown', retrySafe: false }); };
    const failed = resultData(await service.result('hub_manage_read', { operation: 'hub.state' }));
    assert.equal(failed.error.outcome, 'unknown'); assert.equal(failed.error.retrySafe, false);
  } finally { await service.close(); }
});

test('oversized management write results preserve completion and identifiers without inviting a retry', async () => {
  const service = new HubMcpService({ format: 'world-hub.mcp/v1', management: { url: 'http://127.0.0.1:1', operations: ['resources.profiles.apply', 'hub.state'] },
    permissions: { tools: ['hub_manage_write', 'hub_manage_read'] }, limits: { maxResultBytes: 4096 } });
  let writes = 0;
  try {
    service.management.execute = async () => {
      writes++; return { profile: { profileId: 'profile-one', token: 'never-return-private' }, revision: 'a01', mapping: { one: 'instance-one' }, large: 'x'.repeat(6000) };
    };
    const failed = resultData(await service.result('hub_manage_write', { operation: 'resources.profiles.apply', input: { reviewId: 'review', accepted: true } }));
    assert.equal(failed.error.code, 'RESULT_LIMIT'); assert.equal(failed.error.outcome, 'applied'); assert.equal(failed.error.retrySafe, false);
    assert.deepEqual(failed.error.details, { operation: 'resources.profiles.apply', receipt: { revision: 'a01', profileId: 'profile-one' } });
    assert.equal(writes, 1); assert.ok(!JSON.stringify(failed).includes('never-return-private')); assert.ok(JSON.stringify(failed).length < 1024);
    const read = resultData(await service.result('hub_manage_read', { operation: 'hub.state' }));
    assert.equal(read.error.code, 'RESULT_LIMIT'); assert.equal(read.error.outcome, undefined);
  } finally { await service.close(); }
});

test('oversized failure diagnostics keep unknown write outcome and retry guidance bounded', async () => {
  const service = new HubMcpService({ format: 'world-hub.mcp/v1', management: { url: 'http://127.0.0.1:1', operations: ['resources.profiles.apply'] },
    permissions: { tools: ['hub_manage_write'] }, limits: { maxResultBytes: 1024 } });
  try {
    service.management.execute = async () => { throw Object.assign(new Error('Write connection ended. Inspect state before retrying.'), {
      code: 'MANAGEMENT_REQUEST_FAILED', outcome: 'unknown', retrySafe: false, details: { observation: 'x'.repeat(10000), token: 'private-secret' },
    }); };
    const result = await service.result('hub_manage_write', { operation: 'resources.profiles.apply', input: { reviewId: 'review', accepted: true } });
    const failed = resultData(result);
    assert.equal(failed.error.outcome, 'unknown'); assert.equal(failed.error.retrySafe, false); assert.equal(failed.error.operation, 'resources.profiles.apply');
    assert.equal(failed.error.diagnosticsOmitted, true); assert.equal(failed.error.details, undefined);
    assert.ok(JSON.stringify(result).length < 1024); assert.ok(!JSON.stringify(result).includes('private-secret'));
  } finally { await service.close(); }
});

test('management message inspection preserves opaque payload fields and exact JSON through rawJSON', options, async t => {
  const f = await hubFixture(t), socket = new WebSocket(f.hub.endpoint);
  t.after(() => socket.close());
  const welcomed = new Promise((resolve, reject) => {
    socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)); if (value.type === 'welcome') resolve(value); else if (value.type === 'denied' || value.type === 'error') reject(new Error(value.code)); });
    socket.addEventListener('error', () => reject(new Error('raw fixture bridge connection failed')), { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', wire: '0.1', bridge: 'raw.opaque.inspect', credential: 'source', token: f.tokens.source })), { once: true });
  });
  await welcomed;
  const body = '{ "n":9007199254740993, "escaped":"\\u0061", "unit":1e0, "token":"business-data", "nested":{"password":"opaque"} }';
  socket.send('{"type":"publish","topic":' + JSON.stringify(allowedTopic) + ',"body":' + body + '}');
  const record = await f.awaitRecord(row => row.body?.token === 'business-data');
  const adapter = await startAdapter(f, managementConfig(f, ['messages.get'], ['hub_manage_read']));
  const inspected = await success(adapter, 'hub_manage_read', { operation: 'messages.get', input: { seq: record.seq } });
  assert.equal(inspected.result.record.body.token, 'business-data'); assert.equal(inspected.result.record.body.nested.password, 'opaque');
  assert.ok(inspected.result.rawJSON.includes(body), 'the exact payload span survives outside parsed JavaScript numeric values');
  assert.equal((await f.hub.status()).bridges.length, 1, 'the only bridge is the separate raw publisher');
});

test('blob status, attachment use and provider release are bound to this upload session, never another bridge', options, async t => {
  const f = await hubFixture(t), adapter = await startAdapter(f), samePrincipal = await f.bridge('mcp.tools', 'same.principal.other.bridge');
  const bytes = Buffer.from('provider owns opaque bytes'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const foreign = await samePrincipal.uploadStream([bytes], { size: bytes.length, sha256 });
  for (const name of ['hub_blob_status', 'hub_blob_release']) {
    const failed = await adapter.call(name, { id: foreign.id });
    assert.equal(failed.isError, true); assert.equal(resultData(failed).error.code, 'BLOB_NOT_UPLOADED');
  }
  const borrowed = await adapter.call('hub_publish', { topic: allowedTopic, body: {}, options: { attachments: [foreign.id] } });
  assert.equal(resultData(borrowed).error.code, 'BLOB_NOT_UPLOADED');
  const uploaded = await success(adapter, 'hub_blob_upload', { data: bytes.toString('base64') });
  const status = await success(adapter, 'hub_blob_status', { id: uploaded.blob.id });
  assert.equal(status.blob.committed, true); assert.equal(status.blob.released, false); assert.equal(status.blob.sha256, sha256);
  await success(adapter, 'hub_publish', { topic: allowedTopic, body: {}, options: { attachments: [uploaded.blob.id] } });
  const released = await success(adapter, 'hub_blob_release', { id: uploaded.blob.id });
  assert.equal(released.blob.released, true);
  assert.equal((await success(adapter, 'hub_blob_status', { id: uploaded.blob.id })).blob.sha256, sha256, 'provider release allows later cleanup, not immediate deletion');
  await adapter.close();
  const fresh = await startAdapter(f);
  for (const name of ['hub_blob_status', 'hub_blob_release']) assert.equal(resultData(await fresh.call(name, { id: uploaded.blob.id })).error.code, 'BLOB_NOT_UPLOADED');
  assert.equal((await f.records()).length, 1);
});

test('upload ownership list is bounded and retirement drops all blob grants', options, async t => {
  const f = await hubFixture(t), full = f.config(), adapter = await startAdapter(f, { ...full, limits: { ...full.limits, maxBufferedMessages: 2, maxReadMessages: 2 } });
  const ids = [];
  for (const byte of ['one', 'two', 'three']) ids.push((await success(adapter, 'hub_blob_upload', { data: Buffer.from(byte).toString('base64') })).blob.id);
  assert.equal(resultData(await adapter.call('hub_blob_status', { id: ids[0] })).error.code, 'BLOB_NOT_UPLOADED');
  for (const id of ids.slice(1)) assert.equal((await success(adapter, 'hub_blob_status', { id })).blob.id, id);
  const service = new HubMcpService(f.config());
  await service.execute('hub_blob_upload', { data: Buffer.from('clear grants').toString('base64') });
  assert.equal(service.providerBlobs.size, 1);
  await service.close(); assert.equal(service.providerBlobs.size, 0); assert.equal(service.attachmentReads.size, 0);
});
