import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ManagementClient, MANAGEMENT_OPERATIONS, getManagementOperation } from '../../../sdk/javascript/management-client.mjs';

async function server(t, handler) {
  const instance = createServer(handler); await new Promise(done => instance.listen(0, '127.0.0.1', done));
  t.after(async () => { instance.closeAllConnections(); await new Promise(done => instance.close(done)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const collect = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8')); };

test('catalog is machine-readable, immutable and includes current three-resource controls', () => {
  assert.ok(MANAGEMENT_OPERATIONS.length >= 75);
  assert.equal(new Set(MANAGEMENT_OPERATIONS.map(row => row.name)).size, MANAGEMENT_OPERATIONS.length);
  assert.equal(new Set(MANAGEMENT_OPERATIONS.map(row => row.command.join(' '))).size, MANAGEMENT_OPERATIONS.length);
  assert.ok(MANAGEMENT_OPERATIONS.every(row => row.schema.type === 'object' && typeof row.readOnly === 'boolean'));
  assert.ok(['resources.bodies.import', 'resources.profiles.apply', 'resources.data.apply', 'resources.cleanup.apply', 'external.apply', 'sources.save', 'execution.status'].every(name => getManagementOperation(name)));
  assert.equal(getManagementOperation('artifacts.preview').readOnly, false);
  assert.equal(getManagementOperation('workshop.inspect').readOnly, false);
  assert.equal(getManagementOperation('environment.detect').readOnly, false, 'interpreter probes execute a local program');
  assert.equal(MANAGEMENT_OPERATIONS.some(row => /native-pick|\/layout|quick-grant|quick-revoke|\/programs\/:programId\/remove/.test(row.path)), false);
  assert.throws(() => { getManagementOperation('hub.status').path = 'https://attacker.invalid'; }, TypeError);
  assert.ok(JSON.parse(JSON.stringify(MANAGEMENT_OPERATIONS)).length);
});

test('high-use command help documents complete bodies, conditional choices and executable probe authority', () => {
  const policy = getManagementOperation('programs.execution.save').schema;
  assert.ok(policy.required.includes('expectedRevision')); assert.ok(policy.required.includes('policy'));
  assert.deepEqual(policy.properties.policy.properties.mode.enum, ['resident', 'on-demand']);
  const selection = getManagementOperation('resources.profiles.preview').schema;
  assert.ok(selection.required.includes('profileId')); assert.ok(!selection.required.includes('expectedRevision'));
  assert.equal(selection.properties.mapping.additionalProperties.type, 'string'); assert.ok(selection.properties.groupId.description);
  assert.equal(getManagementOperation('external.preview').schema.properties.expectedRevision.type, 'integer');
  assert.equal(policy.properties.expectedRevision.type, 'string');
  for (const name of ['programs.inspect', 'programs.preview', 'programs.review', 'programs.configuration.preview', 'startup.review', 'groups.review', 'resources.profiles.preview', 'versions.modules.preview', 'versions.groups.rollback-preview']) assert.equal(getManagementOperation(name).readOnly, false, `${name} may execute a runtime probe`);
  assert.equal(getManagementOperation('resources.cleanup.preview').readOnly, true);
  assert.equal(getManagementOperation('groups.stop.preview').readOnly, true);
  for (const name of ['resources.profiles.capture', 'resources.data.export', 'workshop.fetch', 'creator.package', 'external.preview']) assert.ok(Object.keys(getManagementOperation(name).schema.properties).length >= 3, name);
  assert.ok(getManagementOperation('artifacts.preview').schema.anyOf.some(choice => choice.required.includes('directory')));
  assert.ok(!getManagementOperation('workshop.inspect').schema.required.includes('source'), 'official source selection is optional in the actual API');
});

test('client rejects non-loopback, alternate numeric hosts, credentials, paths, fragments and URL ambiguity', () => {
  for (const url of ['https://127.0.0.1:8790', 'http://example.com', 'http://0.0.0.0', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]', 'http://user:secret@localhost', 'http://localhost/manage', 'http://localhost/?x=1', 'http://localhost/#x', 'http://localhost/../', ' http://localhost', 'http://localhost\\@attacker.invalid']) {
    assert.throws(() => new ManagementClient({ url }), { code: 'MANAGEMENT_URL_INVALID' }, url);
  }
  assert.equal(new ManagementClient({ url: 'http://localhost:8790' }).url, 'http://127.0.0.1:8790');
  assert.equal(new ManagementClient({ url: 'http://[::1]:8790/' }).url, 'http://[::1]:8790');
});

test('inputs cannot alter routes or query parameters and no request is sent before validation', async () => {
  let calls = 0; const client = new ManagementClient({ fetchImpl: () => { calls++; throw new Error('unexpected'); } });
  for (const input of [null, [], 'text', 12]) await assert.rejects(client.execute('hub.state', input), { code: 'MANAGEMENT_INPUT_INVALID' });
  for (const programId of ['../external', 'a/b', 'a%2fb', '.', '..', 'a?x=1', 'a#b']) await assert.rejects(client.execute('programs.logs', { programId }), { code: 'MANAGEMENT_INPUT_INVALID' });
  await assert.rejects(client.execute('hub.status', { url: 'http://attacker.invalid' }), { code: 'MANAGEMENT_INPUT_INVALID' });
  await assert.rejects(client.execute('not-a-route', {}), { code: 'MANAGEMENT_OPERATION_UNKNOWN' });
  await assert.rejects(client.execute('messages.get', { seq: 1.5 }), { code: 'MANAGEMENT_INPUT_INVALID' });
  assert.equal(calls, 0);
});

test('explicit review and acceptance are mandatory and never manufactured', async () => {
  let calls = 0; const client = new ManagementClient({ fetchImpl: () => { calls++; throw new Error('unexpected'); } });
  for (const name of ['programs.configuration.apply', 'programs.start', 'resources.profiles.apply', 'resources.data.apply', 'resources.cleanup.apply', 'external.apply']) {
    const input = { programId: 'demo', accepted: true };
    await assert.rejects(client.execute(name, input), { code: 'MANAGEMENT_REVIEW_REQUIRED' });
    await assert.rejects(client.execute(name, { ...input, reviewId: 'review', accepted: false }), { code: 'MANAGEMENT_ACCEPTANCE_REQUIRED' });
  }
  assert.equal(calls, 0);
});

test('POST acquires a fresh CSRF token, strips route fields and never exposes authorization output', async t => {
  const requests = [];
  const url = await server(t, async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.method === 'GET') return json(res, { csrfToken: 'private-csrf', hub: { ready: true } });
    assert.equal(req.headers['x-management-token'], 'private-csrf');
    assert.deepEqual(await collect(req), { reviewId: 'r', accepted: true });
    json(res, { ok: true, connection: { endpoint: 'ws://127.0.0.1:1234/bridge', bridges: [{ token: 'private-grant', credential: 'private-credential', slot: 'main' }] }, authorizationReceipt: 'private-receipt', csrfToken: 'private-csrf', snippets: { node: 'private-grant' } });
  });
  const client = new ManagementClient({ url });
  const result = await client.execute('programs.configuration.apply', { programId: 'demo', reviewId: 'r', accepted: true });
  assert.equal(result.ok, true); assert.equal(result.connection.bridges[0].slot, 'main');
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.deepEqual(requests, [{ method: 'GET', path: '/manage/api/state' }, { method: 'POST', path: '/manage/api/programs/demo/configuration/apply' }]);
  const privateResult = await client.execute('external.apply', { reviewId: 'r', accepted: true }, { includeSecrets: true });
  assert.equal(privateResult.connection.bridges[0].token, 'private-grant');
  assert.equal('csrfToken' in privateResult, false);
  await assert.rejects(client.execute('hub.state', {}, { includeSecrets: true }), { code: 'MANAGEMENT_OPTIONS_INVALID' });
});

test('state removes only management secrets while message and log original JSON remain lossless', async t => {
  const raw = '{"record":{"seq":1,"body":{"token":"ordinary business text","value":9007199254740993,"exp":1e+99,"escaped":"\\u4e16"}}}';
  const url = await server(t, (req, res) => {
    if (req.url === '/manage/api/state') return json(res, { csrfToken: 'secret', bridges: [] });
    if (req.url === '/manage/api/message?seq=1') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(raw); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"records":[' + raw.slice(10, -1) + ']}');
  });
  const client = new ManagementClient({ url });
  assert.deepEqual(await client.execute('hub.state'), { bridges: [] });
  const message = await client.execute('messages.get', { seq: 1 });
  assert.equal(message.record.body.token, 'ordinary business text'); assert.equal(message.rawJSON, raw);
  assert.match((await client.execute('hub.log', { limit: 2 })).rawJSON, /9007199254740993/);
});

test('redirects are never followed, including CSRF requests', async t => {
  let calls = 0;
  const url = await server(t, (req, res) => { calls++; res.writeHead(302, { location: 'http://attacker.invalid/' }); res.end(); });
  const client = new ManagementClient({ url });
  await assert.rejects(client.execute('hub.state'), { code: 'MANAGEMENT_REDIRECT_REJECTED', status: 302 });
  await assert.rejects(client.execute('annotations.save', { key: 'x' }), { code: 'MANAGEMENT_REDIRECT_REJECTED' });
  assert.equal(calls, 2);
});

test('HTTP 200 semantic errors and HTTP failure codes retain sanitized diagnostics', async t => {
  const url = await server(t, (req, res) => {
    if (req.method === 'GET') return json(res, { csrfToken: 'private-csrf' });
    if (req.url === '/manage/api/workshop/inspect') return json(res, { ok: false, error: 'SOURCE_UNAVAILABLE', message: 'offline private-csrf', token: 'hidden' });
    json(res, { error: { code: 'RESOURCE_REVIEW_CHANGED', message: 'stale private-csrf', stoppedProgramIds: ['one'], csrfToken: 'private-csrf' } }, 409);
  });
  const client = new ManagementClient({ url });
  await assert.rejects(client.execute('workshop.inspect', {}), error => error.code === 'SOURCE_UNAVAILABLE' && error.status === 200 && error.message === 'offline [redacted]' && !JSON.stringify(error.details).includes('hidden'));
  await assert.rejects(client.execute('resources.cleanup.apply', { reviewId: 'r', accepted: true }), error => error.code === 'RESOURCE_REVIEW_CHANGED' && error.status === 409 && error.details.stoppedProgramIds[0] === 'one' && !JSON.stringify(error).includes('private-csrf'));
});

test('writes with lost responses are never retried and report unknown outcome', async t => {
  let writes = 0;
  const url = await server(t, (req, res) => {
    if (req.method === 'GET') return json(res, { csrfToken: 'csrf' });
    writes++; req.socket.destroy();
  });
  await assert.rejects(new ManagementClient({ url }).execute('annotations.save', { key: 'x' }), error => error.code === 'MANAGEMENT_REQUEST_FAILED' && error.outcome === 'unknown' && error.retrySafe === false && /before.*retry/.test(error.message));
  assert.equal(writes, 1);
});

test('write timeout and caller abort preserve unknown outcome without retry', async t => {
  let writes = 0;
  const url = await server(t, (req, res) => { if (req.method === 'GET') json(res, { csrfToken: 'csrf' }); else writes++; });
  await assert.rejects(new ManagementClient({ url, timeoutMs: 120 }).execute('annotations.save', { key: 'x' }), { code: 'MANAGEMENT_TIMEOUT', outcome: 'unknown', retrySafe: false });
  const controller = new AbortController();
  const pending = new ManagementClient({ url }).execute('annotations.save', { key: 'x' }, { signal: controller.signal });
  const deadline = Date.now() + 2000; while (writes < 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  controller.abort(); await assert.rejects(pending, { code: 'MANAGEMENT_ABORTED', outcome: 'unknown' });
  assert.equal(writes, 2);
});

test('CSRF lookup failure cannot submit a mutation and oversized/invalid JSON are bounded', async t => {
  let posts = 0;
  const url = await server(t, (req, res) => { if (req.method === 'POST') posts++; json(res, { ready: true }); });
  await assert.rejects(new ManagementClient({ url }).execute('annotations.save', { key: 'x' }), { code: 'MANAGEMENT_CSRF_MISSING' });
  assert.equal(posts, 0);
  const oversized = await server(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: 'x'.repeat(300) })); });
  await assert.rejects(new ManagementClient({ url: oversized, maxResponseBytes: 100 }).execute('hub.state'), { code: 'MANAGEMENT_RESPONSE_TOO_LARGE' });
  const invalid = await server(t, (req, res) => { res.end(Buffer.from([0xff])); });
  await assert.rejects(new ManagementClient({ url: invalid }).execute('hub.state'), { code: 'MANAGEMENT_RESPONSE_INVALID' });
});
