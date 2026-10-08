import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { JsonRpcProcess, JsonRpcRemoteError } from '../../../examples/distributed-context/lib/jsonrpc-process.mjs';

const fixture = fileURLToPath(new URL('../../fixtures/jsonrpc-child.mjs', import.meta.url));
async function start(t, mode = 'normal', options = {}) {
  const transport = new JsonRpcProcess({ command: process.execPath, args: [fixture, mode], requestTimeoutMs: 2_000, closeTimeoutMs: 80, ...options });
  t.after(() => transport.close());
  await transport.start();
  return transport;
}

test('real child roundtrip uses increasing IDs and preserves Unicode parameters', async t => {
  const transport = await start(t);
  const values = await Promise.all([transport.request('echo', { text: '中文🙂', nested: { multiline: 'a\nb' } }), transport.request('echo', ['second'])]);
  assert.equal(values[0].id, 1);
  assert.equal(values[1].id, 2);
  assert.deepEqual(values[0].params, { text: '中文🙂', nested: { multiline: 'a\nb' } });
  assert.deepEqual(values[1].params, ['second']);
  assert.equal(transport.pendingRequests, 0);
  assert.equal(await transport.request('split'), '🙂中文');
});

test('notifications and reverse requests stay under caller control', async t => {
  const transport = await start(t);
  const notification = once(transport, 'notification');
  transport.notify('notify');
  assert.deepEqual((await notification)[0], { jsonrpc: '2.0', method: 'changed', params: { text: '中文\n🙂' } });
  transport.once('request', frame => {
    assert.equal(frame.method, 'confirm');
    transport.respond(frame.id, { accepted: frame.params.value });
  });
  assert.deepEqual(await transport.request('reverse', { test: true }), { jsonrpc: '2.0', id: 'server-1', result: { accepted: { test: true } } });
  transport.once('request', frame => transport.respondError(frame.id, { code: -32601, message: 'Caller denies this reverse request' }));
  assert.deepEqual(await transport.request('reverse', {}), { jsonrpc: '2.0', id: 'server-2', error: { code: -32601, message: 'Caller denies this reverse request' } });
  assert.throws(() => transport.respond('unknown', null), { code: 'RPC_UNKNOWN_REQUEST' });
});

test('remote errors preserve code and data without killing the transport', async t => {
  const transport = await start(t);
  await assert.rejects(transport.request('error'), error => error instanceof JsonRpcRemoteError && error.code === -32001 && error.data.reason === 'test');
  assert.equal((await transport.request('echo', {})).id, 2);
});

test('request timeout removes its waiter and late responses cannot resolve another request', async t => {
  const transport = await start(t);
  const orphan = once(transport, 'orphanResponse');
  await assert.rejects(transport.request('late', {}, { timeoutMs: 30 }), { code: 'RPC_TIMEOUT' });
  assert.equal(transport.pendingRequests, 0);
  assert.equal((await transport.request('echo', { ok: true })).id, 2);
  assert.equal((await orphan)[0].id, 1);
});

test('child exit rejects pending requests and closes lifecycle', async t => {
  const transport = await start(t, 'exit');
  const exited = once(transport, 'exit');
  await assert.rejects(transport.request('echo', {}), error => ['RPC_EXIT', 'RPC_EOF'].includes(error.code));
  assert.equal((await exited)[0].code, 12);
  await transport.close();
  assert.equal(transport.state, 'closed');
  assert.equal(transport.pendingRequests, 0);
});

test('stdout EOF with an incomplete final line rejects waiters', async t => {
  const transport = await start(t, 'eof');
  await assert.rejects(transport.request('echo', {}), { code: 'RPC_EOF' });
  await transport.close();
  assert.equal(transport.state, 'closed');
});

test('close kills only its own child when stdin EOF is ignored', async t => {
  const transport = await start(t, 'stubborn');
  await transport.request('echo', {});
  const exited = once(transport, 'exit');
  await transport.close();
  const { code, signal } = (await exited)[0];
  assert.ok(signal === 'SIGKILL' || code !== 0);
  assert.equal(transport.state, 'closed');
});

for (const [mode, expected] of [['malformed', 'RPC_FRAME'], ['invalid-utf8', 'RPC_FRAME'], ['line-limit', 'RPC_LINE_LIMIT'], ['buffer-limit', 'RPC_BUFFER_LIMIT']]) {
  test(`${mode} fails boundedly and rejects all active waiters`, async t => {
    // Pipes can merge both replies into one chunk. Isolate the selected limit
    // so its error does not depend on the OS deciding where to split stdout.
    const limits = mode === 'line-limit' ? { maxLineBytes: 256, maxBufferBytes: 2048 }
      : mode === 'buffer-limit' ? { maxLineBytes: 512, maxBufferBytes: 512 }
      : { maxLineBytes: 256, maxBufferBytes: 512 };
    const transport = await start(t, mode, limits);
    const observed = once(transport, 'transportError');
    const outcomes = await Promise.allSettled([transport.request('echo', {}), transport.request('echo', {})]);
    assert.deepEqual(outcomes.map(item => item.reason.code), [expected, expected]);
    assert.equal((await observed)[0].code, expected);
    await transport.close();
    assert.equal(transport.pendingRequests, 0);
  });
}

test('stderr is streamed separately and is never accepted as JSON-RPC input', async t => {
  const stderr = new PassThrough();
  const chunks = [];
  stderr.on('data', chunk => chunks.push(chunk));
  const transport = await start(t, 'normal', { stderr, env: { ...process.env, SHOULD_NEVER_BE_PRINTED: 'private-test-value' } });
  const diagnostic = once(transport, 'stderr');
  assert.equal(await transport.request('stderr'), true);
  assert.match((await diagnostic)[0].toString('utf8'), /diagnostic from child/);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'diagnostic from child\n');
  assert.equal(Buffer.concat(chunks).toString('utf8').includes('private-test-value'), false);
});

test('close sends stdin EOF, rejects waiters, and remains idempotent', async t => {
  const transport = await start(t, 'timeout', { closeTimeoutMs: 1_000 });
  const exited = once(transport, 'exit');
  const result = assert.rejects(transport.request('wait'), { code: 'RPC_CLOSED' });
  await transport.close();
  await result;
  assert.deepEqual((await exited)[0], { code: 0, signal: null });
  await transport.close();
  assert.equal(transport.state, 'closed');
  await assert.rejects(transport.request('echo', {}), { code: 'RPC_CLOSED' });
  await assert.rejects(transport.start(), { code: 'RPC_STATE' });
});

test('outgoing frames and waiter count are bounded before writing', async t => {
  const transport = await start(t, 'timeout', { maxLineBytes: 256, maxBufferBytes: 512, maxPendingRequests: 1 });
  await assert.rejects(transport.request('echo', { huge: 'x'.repeat(400) }), { code: 'RPC_LINE_LIMIT' });
  assert.equal(transport.pendingRequests, 0);
  const waiting = assert.rejects(transport.request('wait'), { code: 'RPC_CLOSED' });
  await assert.rejects(transport.request('another'), { code: 'RPC_PENDING_LIMIT' });
  await transport.close();
  await waiting;
});

test('spawn failure is rejected and transport can be closed', async () => {
  const transport = new JsonRpcProcess({ command: 'this-command-does-not-exist-world-hub-test', closeTimeoutMs: 50 });
  await assert.rejects(transport.start(), { code: 'RPC_SPAWN' });
  await transport.close();
  assert.equal(transport.state, 'closed');
});

test('constructor and methods reject invalid communication configuration', async t => {
  assert.throws(() => new JsonRpcProcess({ command: process.execPath, args: [42] }), TypeError);
  assert.throws(() => new JsonRpcProcess({ command: process.execPath, maxLineBytes: 512, maxBufferBytes: 256 }), TypeError);
  const transport = await start(t);
  await assert.rejects(transport.request('', {}), TypeError);
  await assert.rejects(transport.request('echo', 42), TypeError);
  await assert.rejects(transport.request('echo', {}, { timeoutMs: 0 }), TypeError);
  assert.throws(() => transport.respondError('unknown', { code: 'wrong', message: '' }), TypeError);
});
