import test from 'node:test';
import assert from 'node:assert/strict';
import { DemandLifecycle } from '../../tools/launcher/demand-lifecycle.mjs';
import { acquireManagedLease, callManaged, withManagedModule } from '../../sdk/javascript/lifecycle-client.mjs';

const issue = code => Object.assign(new Error(code), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function scene(t, { realClock = false, leaseTtlMs = 30000, renewAfterMs = 10000, BridgeClass, connectTimeoutMs } = {}) {
  let clock = 100000, starts = 0, stops = 0, inspections = 0, queue = Promise.resolve();
  const calls = [], records = new Map(['caller', 'other', 'target'].map(id => [id, { programId: id, principal: `local.${id}`, state: 'stopped', runId: null,
    executionPolicy: { mode: id === 'target' ? 'on-demand' : 'resident', idleTimeoutMs: 1000, allowedCallers: id === 'target' ? ['caller'] : [] } }]));
  const local = { root: 'demand-fixture', records, identities: new Map([...records].map(([id, row]) => [id, { principal: row.principal, token: `secret-${id}` }])),
    handles: new Map(), reviews: new Map(), startControllers: new Set(), closing: false, startsPaused: false,
    enqueue(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; },
    async assertVersionReady() {},
    async reviewStart(id) { inspections++; if (local.reviewError) throw issue(local.reviewError); const reviewId = `${id}-${inspections}`; this.reviews.set(reviewId, {}); await local.onReview?.(id); return { reviewId, review: {} }; },
    async startNow(id, { startReason, signal }) {
      starts++; await local.onStarting?.(id, { signal }); const row = records.get(id), handle = { pid: starts, exit: null, cleanupIncomplete: false, stopping: false };
      local.handles.set(id, handle); row.state = 'running'; row.runId = `run-${starts}`;
      await local.lifecycleStarted(id, { reason: startReason, handle, runId: row.runId });
    },
    async stopNow(id) {
      stops++; const row = records.get(id), handle = local.handles.get(id); if (handle) handle.exit = { code: 0 };
      row.state = 'stopped'; await local.lifecycleStopped(id, { handle, runId: row.runId });
    }
  };
  const owner = { localPrograms: local, connection: () => ({ endpoint: 'ws://127.0.0.1:1/bridge' }), async updateCredentials(change) { calls.push(change); } };
  const broker = new DemandLifecycle(owner, { now: realClock ? Date.now : () => clock, leaseTtlMs, renewAfterMs, tickIntervalMs: 1000000, ...(BridgeClass ? { BridgeClass } : {}), ...(connectTimeoutMs ? { connectTimeoutMs } : {}) });
  // Unit tests exercise the supervisor and its ordinary-message contract. A
  // separate native HTTP fixture verifies actual authenticated Bridge traffic.
  broker.available = true; broker.bridge = { connected: true, ack() { return true; }, async close() {} };
  t.after(() => broker.close());
  const command = (body, fromPrincipal = 'local.caller') => broker.command({ fromPrincipal, body });
  return { broker, local, owner, calls, command, get starts() { return starts; }, get stops() { return stops; }, get inspections() { return inspections; },
    now: () => realClock ? Date.now() : clock, advance(ms) { clock += ms; },
    client: { async registerChannels() {}, async call(target, topic, body) {
      if (topic === broker.topic) return { response: { body: { ok: true, ...await command(body) } } };
      return { request: { seq: 40 }, response: { body, fromPrincipal: target.principal } };
    } }
  };
}
const denied = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code); return true; });

test('lifecycle is opt-in, does not connect on construction, and discloses no private credentials', async t => {
  const s = scene(t); s.local.records.get('target').executionPolicy.mode = 'resident';
  assert.equal(s.broker.enabled(), false); assert.equal(s.broker.descriptor(), null);
  await s.broker.connect(); await s.broker.tick(); assert.equal(s.calls.length, 0);
  const serialized = JSON.stringify(s.broker.state()); assert.doesNotMatch(serialized, /leaseId|token|secret-/);
});
test('a caller is resolved from authenticated principal, never a request body', async t => {
  const s = scene(t);
  await denied(s.command({ action: 'acquire', programId: 'target' }, 'forged'), 'LIFECYCLE_CALLER_DENIED');
  await denied(s.command({ action: 'acquire', programId: 'target', callerId: 'caller' }), 'LIFECYCLE_REQUEST_INVALID');
  await denied(s.command({ action: 'acquire', programId: 'target' }, 'local.other'), 'LIFECYCLE_TRIGGER_DENIED');
  assert.equal(s.starts, 0);
});
test('on-demand activation never starts a resident module implicitly', async t => {
  const s = scene(t);
  await denied(s.command({ action: 'acquire', programId: 'other' }), 'DEMAND_MODE_REQUIRED');
  await denied(s.command({ action: 'acquire', programId: 'missing' }), 'LIFECYCLE_TARGET_MISSING');
  assert.equal(s.starts, 0);
});
test('concurrent acquisitions share one ready owned process and protect all active work', async t => {
  const s = scene(t); s.local.onStarting = () => delay(5);
  const grants = await Promise.all(Array.from({ length: 12 }, () => s.command({ action: 'acquire', programId: 'target' })));
  assert.equal(s.starts, 1); assert.equal(new Set(grants.map(row => row.leaseId)).size, 12); assert.equal(s.inspections, 12);
  assert.equal(s.broker.state('target').programs[0].activeLeaseCount, 12);
  s.advance(5000); await s.broker.tick(); assert.equal(s.stops, 0);
  for (const grant of grants) await s.command({ action: 'release', leaseId: grant.leaseId, completed: true });
  s.advance(999); await s.broker.tick(); assert.equal(s.stops, 0);
  s.advance(1); await s.broker.tick(); assert.equal(s.stops, 1); assert.equal(s.local.records.get('target').state, 'stopped');
});
test('renew extends protection and the idle clock begins only after confirmed completion', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  s.advance(29000); await s.command({ action: 'renew', leaseId: grant.leaseId });
  s.advance(20000); await s.broker.tick(); assert.equal(s.stops, 0); assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 0);
  await s.command({ action: 'release', leaseId: grant.leaseId, completed: true });
  assert.equal(s.broker.state('target').programs[0].idleSince, new Date(s.now()).toISOString());
  s.advance(1000); await s.broker.tick(); assert.equal(s.stops, 1);
});
test('an expired lease is uncertain, not completed; explicit completion can resolve it', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  s.advance(30000); await s.broker.tick();
  assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 1);
  await denied(s.command({ action: 'renew', leaseId: grant.leaseId }), 'LIFECYCLE_LEASE_UNCERTAIN');
  s.advance(1000000); await s.broker.tick(); assert.equal(s.stops, 0);
  await s.command({ action: 'release', leaseId: grant.leaseId, completed: true });
  s.advance(1000); await s.broker.tick(); assert.equal(s.stops, 1);
});
test('an explicitly uncertain result holds the process until completion or an explicit owned stop', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  const released = await s.command({ action: 'release', leaseId: grant.leaseId, completed: false }); assert.equal(released.uncertain, true);
  s.advance(100000); await s.broker.tick(); assert.equal(s.stops, 0);
  await s.local.enqueue(() => s.local.stopNow('target'));
  assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 0);
  await denied(s.command({ action: 'release', leaseId: grant.leaseId, completed: true }), 'LIFECYCLE_LEASE_MISSING');
});
test('each renew and release checks current caller identity, trigger permission and version guard', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  await denied(s.command({ action: 'renew', leaseId: grant.leaseId }, 'local.other'), 'LIFECYCLE_LEASE_MISSING');
  s.local.records.get('target').executionPolicy.allowedCallers = [];
  await denied(s.command({ action: 'renew', leaseId: grant.leaseId }), 'LIFECYCLE_TRIGGER_DENIED');
  await denied(s.command({ action: 'release', leaseId: grant.leaseId, completed: true }), 'LIFECYCLE_TRIGGER_DENIED');
  s.local.records.get('target').executionPolicy.allowedCallers = ['caller']; s.local.assertVersionReady = async () => { throw issue('VERSION_RECOVERY_REQUIRED'); };
  await denied(s.command({ action: 'release', leaseId: grant.leaseId, completed: true }), 'VERSION_RECOVERY_REQUIRED');
  assert.equal(s.broker.leases.size, 1);
});
test('policy, installed source and pending version changes cannot reuse an earlier launch review', async t => {
  const s = scene(t); s.local.onReview = () => { s.local.records.get('target').executionPolicy.allowedCallers = []; };
  await denied(s.command({ action: 'acquire', programId: 'target' }), 'LIFECYCLE_TRIGGER_DENIED'); assert.equal(s.starts, 0); assert.equal(s.broker.leases.size, 0);
  s.local.onReview = null; s.local.records.get('target').executionPolicy.allowedCallers = ['caller']; s.local.reviewError = 'LOCAL_INSTALLED_CODE_CHANGED';
  await denied(s.command({ action: 'acquire', programId: 'target' }), 'LOCAL_INSTALLED_CODE_CHANGED');
  s.local.reviewError = null; s.local.assertVersionReady = async () => { throw issue('VERSION_RECOVERY_REQUIRED'); };
  await denied(s.command({ action: 'acquire', programId: 'target' }), 'VERSION_RECOVERY_REQUIRED'); assert.equal(s.starts, 0);
});
test('a caller with an unfinished version transaction cannot acquire, renew or release a managed run', async t => {
  const s = scene(t); s.local.assertVersionReady = async id => { if (id === 'caller') throw issue('VERSION_RECOVERY_REQUIRED'); };
  await denied(s.command({ action: 'acquire', programId: 'target' }), 'VERSION_RECOVERY_REQUIRED'); assert.equal(s.starts, 0);
  s.local.assertVersionReady = async () => {}; const grant = await s.command({ action: 'acquire', programId: 'target' });
  s.local.assertVersionReady = async id => { if (id === 'caller') throw issue('VERSION_RECOVERY_REQUIRED'); };
  await denied(s.command({ action: 'renew', leaseId: grant.leaseId }), 'VERSION_RECOVERY_REQUIRED');
  await denied(s.command({ action: 'release', leaseId: grant.leaseId, completed: true }), 'VERSION_RECOVERY_REQUIRED'); assert.equal(s.broker.leases.size, 1);
});
test('already running targets still undergo source review and are never adopted from a PID', async t => {
  const s = scene(t); s.local.records.get('target').state = 'unknown'; s.local.records.get('target').pid = process.pid;
  await denied(s.command({ action: 'acquire', programId: 'target' }), 'LOCAL_PROCESS_OWNERSHIP_UNKNOWN');
  s.local.records.get('target').state = 'running'; await denied(s.command({ action: 'acquire', programId: 'target' }), 'LOCAL_PROCESS_OWNERSHIP_UNKNOWN');
  s.local.records.get('target').state = 'stopped'; const grant = await s.command({ action: 'acquire', programId: 'target' });
  s.local.reviewError = 'LOCAL_INSTALLED_CODE_CHANGED'; await denied(s.command({ action: 'acquire', programId: 'target' }), 'LOCAL_INSTALLED_CODE_CHANGED');
  assert.equal(s.starts, 1); assert.equal(s.broker.leases.size, 1); await s.command({ action: 'release', leaseId: grant.leaseId, completed: true });
});
test('manual startup pins an automatically started run instead of letting idle stop it', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  s.broker.started('target', { reason: 'manual', handle: s.local.handles.get('target'), runId: s.local.records.get('target').runId });
  await s.command({ action: 'release', leaseId: grant.leaseId, completed: true }); s.advance(100000); await s.broker.tick();
  assert.equal(s.stops, 0); assert.equal(s.broker.state('target').programs[0].pinned, true); assert.equal(s.broker.state('target').programs[0].autoStarted, false);
});
test('idle stop checks original process ownership and policy again after async version inspection', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  await s.command({ action: 'release', leaseId: grant.leaseId, completed: true }); s.advance(1000);
  s.local.assertVersionReady = async () => { s.local.records.get('target').executionPolicy.mode = 'resident'; };
  await s.broker.tick(); assert.equal(s.stops, 0);
  s.local.records.get('target').executionPolicy.mode = 'on-demand'; s.local.assertVersionReady = async () => {};
  s.local.handles.set('target', { exit: null, pid: 500 }); await s.broker.tick(); assert.equal(s.stops, 0);
});
test('a reserved pending acquisition prevents queued idle-stop races', async t => {
  const s = scene(t), first = await s.command({ action: 'acquire', programId: 'target' });
  await s.command({ action: 'release', leaseId: first.leaseId, completed: true }); s.advance(1000);
  const ticking = s.broker.tick(), acquiring = s.command({ action: 'acquire', programId: 'target' });
  await Promise.all([ticking, acquiring]); assert.equal(s.stops, 0); assert.equal(s.starts, 1);
});
test('an explicit stop may cancel a queued activation, which must not return a nonexistent lease', async t => {
  const s = scene(t); const stopping = s.local.enqueue(() => s.local.stopNow('target'));
  const acquiring = s.command({ action: 'acquire', programId: 'target' });
  await stopping; await denied(acquiring, 'LIFECYCLE_ACTIVATION_CANCELLED'); assert.equal(s.starts, 0); assert.equal(s.broker.leases.size, 0);
});
test('a slow unrelated cold start cannot block renewals or completed releases for running work', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  s.local.records.set('slow', { programId: 'slow', principal: 'local.slow', state: 'stopped', executionPolicy: { mode: 'on-demand', allowedCallers: ['caller'], idleTimeoutMs: 1000 } });
  s.local.identities.set('slow', { principal: 'local.slow', token: 'secret-slow' });
  let started, unblock;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { unblock = resolve; });
  s.local.onStarting = async id => { if (id === 'slow') { started(); await gate; } };
  const slow = s.command({ action: 'acquire', programId: 'slow' }); await entered;
  s.advance(29000); await s.command({ action: 'renew', leaseId: grant.leaseId }); s.advance(29000);
  assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 0);
  await s.command({ action: 'release', leaseId: grant.leaseId, completed: true });
  assert.equal(s.broker.state('target').programs[0].activeLeaseCount, 0); unblock(); await slow;
});
test('lease update rechecks the owned run after async guards and cannot resurrect a manually stopped lease', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  s.local.assertVersionReady = async () => { await s.local.stopNow('target'); };
  await denied(s.command({ action: 'renew', leaseId: grant.leaseId }), 'LIFECYCLE_LEASE_MISSING');
  assert.equal(s.broker.leases.size, 0); assert.equal(s.local.records.get('target').state, 'stopped');
});
test('a queued request loses trigger authority if its caller is unregistered or replaced before activation', async t => {
  const s = scene(t); let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const preceding = s.local.enqueue(async () => { await gate; s.local.records.delete('caller'); s.local.identities.delete('caller'); });
  const acquiring = s.command({ action: 'acquire', programId: 'target' }); unblock(); await preceding;
  await denied(acquiring, 'LIFECYCLE_CALLER_DENIED'); assert.equal(s.starts, 0); assert.equal(s.broker.leases.size, 0);
});
test('a caller identity rotation cannot inherit leases or a queued automatic activation', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' });
  s.local.identities.get('caller').token = 'replacement-secret';
  await denied(s.command({ action: 'release', leaseId: grant.leaseId, completed: true }), 'LIFECYCLE_CALLER_DENIED');
  assert.equal(s.broker.leases.size, 1);
});
test('per caller and target bounds include uncertain work and failed acquisition removes only its own reservation', async t => {
  const s = scene(t), grants = await Promise.all(Array.from({ length: 32 }, () => s.command({ action: 'acquire', programId: 'target' })));
  for (const grant of grants) await s.command({ action: 'release', leaseId: grant.leaseId, completed: false });
  await denied(s.command({ action: 'acquire', programId: 'target' }), 'LIFECYCLE_LEASE_LIMIT'); assert.equal(s.broker.leases.size, 32); assert.equal(s.starts, 1);
});
test('duplicate transport request sequences never launch or allocate twice; evicted old requests do not replay', async t => {
  const s = scene(t), responses = [];
  s.broker.bridge.respond = async (message, body) => { responses.push({ message, body }); };
  const message = { seq: 42, operation: 'request', topic: s.broker.topic, target: { principal: s.broker.principal }, fromPrincipal: 'local.caller', body: { action: 'acquire', programId: 'target' } };
  await Promise.all([s.broker.deliver(message), s.broker.deliver(message)]);
  assert.equal(s.starts, 1); assert.equal(s.broker.leases.size, 1); assert.equal(responses[0].body.leaseId, responses[1].body.leaseId);
  s.broker.requests.delete(42); s.broker.requestFloor = 42; await s.broker.deliver(message);
  assert.equal(responses.at(-1).body.error.code, 'LIFECYCLE_REQUEST_REPLAY'); assert.equal(s.broker.leases.size, 1);
});
test('non-request, wrong-topic and undirected traffic never activates processes', async t => {
  const s = scene(t);
  for (const extra of [{ operation: 'publish' }, { topic: 'unrelated' }, { target: { principal: 'unrelated' } }]) await s.broker.deliver({ seq: 1, operation: 'request', topic: s.broker.topic, target: { principal: s.broker.principal }, fromPrincipal: 'local.caller', body: { action: 'acquire', programId: 'target' }, ...extra });
  assert.equal(s.starts, 0);
});
test('SDK callManaged preserves the exact business body, response and one-call semantics', async t => {
  const s = scene(t), original = { arbitrary: ['data', 5], system: 'opaque application data' }, calls = [], realCall = s.client.call;
  s.client.call = async (...args) => { calls.push(args); return realCall(...args); };
  const result = await callManaged(s.client, s.broker.descriptor(), 'target', 'app/requests', original);
  const business = calls.filter(([, topic]) => topic !== s.broker.topic); assert.equal(business.length, 1); assert.equal(business[0][2], original);
  assert.equal(result.response.body, original); assert.equal(result.response.fromPrincipal, 'local.target'); assert.equal(s.broker.leases.size, 0); assert.equal(s.starts, 1);
});
test('SDK heartbeat protects a long-running request and releases only after its real response', async t => {
  const s = scene(t, { realClock: true, leaseTtlMs: 60, renewAfterMs: 10 }), realCall = s.client.call;
  let renews = 0, business = 0;
  s.client.call = async (target, topic, body, opts) => {
    if (topic === s.broker.topic) { if (body.action === 'renew') renews++; return realCall(target, topic, body, opts); }
    business++; await delay(160); s.broker.expire(); assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 0);
    assert.equal(s.broker.leases.size, 1); return { request: { seq: 8 }, response: { body: 'done' } };
  };
  const result = await callManaged(s.client, s.broker.descriptor(), 'target', 'work', {}, { timeoutMs: 1000 });
  assert.equal(result.response.body, 'done'); assert.equal(business, 1); assert.ok(renews >= 5); assert.equal(s.broker.leases.size, 0);
});
test('SDK timeout marks uncertainty without automatically repeating or cancelling business work', async t => {
  const s = scene(t), realCall = s.client.call; let business = 0;
  s.client.call = async (target, topic, body, opts) => { if (topic === s.broker.topic) return realCall(target, topic, body, opts); business++; throw issue('APPLICATION_TIMEOUT'); };
  await denied(callManaged(s.client, s.broker.descriptor(), 'target', 'work', {}), 'APPLICATION_TIMEOUT');
  assert.equal(business, 1); assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 1);
  s.advance(100000); await s.broker.tick(); assert.equal(s.stops, 0);
});
test('only confirmed lifecycle requests and supervisor-owned lifecycle responses are voluntarily released', async t => {
  const s = scene(t), realCall = s.client.call, released = [];
  let sequence = 100;
  s.client.release = async seqs => { released.push([...seqs]); };
  s.client.call = async (...args) => { const result = await realCall(...args); if (args[1] === s.broker.topic) result.request = { seq: ++sequence }; return result; };
  const result = await callManaged(s.client, s.broker.descriptor(), 'target', 'business', { keep: 'application message' });
  assert.equal(result.request.seq, 40); assert.deepEqual(released, [[101], [102]]); assert.ok(!released.flat().includes(40));
  const brokerReleased = [], acknowledgments = [];
  s.broker.bridge.respond = async () => ({ seq: 901 }); s.broker.bridge.release = async seqs => { brokerReleased.push([...seqs]); };
  s.broker.bridge.ack = message => { acknowledgments.push(message.seq); };
  await s.broker.deliver({ seq: 501, operation: 'request', topic: s.broker.topic, target: { principal: s.broker.principal }, fromPrincipal: 'local.other', body: { action: 'acquire', programId: 'target' } });
  assert.deepEqual(brokerReleased, [[901]]); assert.deepEqual(acknowledgments, [501]);
});
test('refused control calls release their own received request and cleanup errors never change known business results', async t => {
  const s = scene(t), released = [], diagnostics = [];
  s.client.call = async () => ({ request: { seq: 702 }, response: { body: { ok: false, error: { code: 'LIFECYCLE_TRIGGER_DENIED', message: 'Denied' } } } });
  s.client.release = async seqs => { released.push([...seqs]); throw issue('CONTROL_CLEANUP_FAILED'); };
  await denied(callManaged(s.client, s.broker.descriptor(), 'target', 'business', {}, { onLifecycleError: error => diagnostics.push(error.code) }), 'LIFECYCLE_TRIGGER_DENIED');
  assert.deepEqual(released, [[702]]); assert.deepEqual(diagnostics, ['CONTROL_CLEANUP_FAILED']); assert.equal(s.starts, 0);
});
test('public and control error diagnostics redact known identity credentials and lease IDs', async t => {
  const s = scene(t), grant = await s.command({ action: 'acquire', programId: 'target' }), secrets = [s.broker.token, 'secret-caller', 'secret-target', grant.leaseId];
  s.local.reviewStart = async () => { throw new Error(secrets.join(' / ')); };
  const responses = []; s.broker.bridge.respond = async (request, body) => { responses.push(body); };
  await s.broker.deliver({ seq: 42, operation: 'request', topic: s.broker.topic, target: { principal: s.broker.principal }, fromPrincipal: 'local.caller', body: { action: 'acquire', programId: 'target' } });
  const visible = JSON.stringify({ state: s.broker.state(), responses });
  for (const secret of secrets) assert.ok(!visible.includes(secret));
  assert.match(visible, /redacted/);
});
test('a lost heartbeat stops the heartbeat loop instead of accumulating protected timeout requests forever', async t => {
  const s = scene(t, { realClock: true, leaseTtlMs: 90, renewAfterMs: 10 }), realCall = s.client.call;
  let renews = 0;
  s.client.call = async (target, topic, body, opts) => { if (topic === s.broker.topic && body.action === 'renew') { renews++; throw issue('SOCKET_CLOSED'); } return realCall(target, topic, body, opts); };
  const lease = await acquireManagedLease(s.client, s.broker.descriptor(), 'target'); await delay(70);
  assert.equal(renews, 1); assert.equal(lease.lastError.code, 'SOCKET_CLOSED'); await lease.release({ completed: false });
});
test('SDK release failures preserve known business results and leave the supervisor conservative', async t => {
  const s = scene(t), realCall = s.client.call, warnings = [];
  s.client.call = async (target, topic, body, opts) => { if (topic === s.broker.topic && body.action === 'release') throw issue('SOCKET_CLOSED'); return realCall(target, topic, body, opts); };
  const result = await callManaged(s.client, s.broker.descriptor(), 'target', 'work', 'done', { onLifecycleError: warning => warnings.push(warning.code) });
  assert.equal(result.response.body, 'done'); assert.deepEqual(warnings, ['SOCKET_CLOSED']); s.advance(30000); assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 1);
});
test('streaming tasks use explicit leases or a callback whose resolution defines completion', async t => {
  const s = scene(t), lease = await acquireManagedLease(s.client, s.broker.descriptor(), 'target');
  assert.equal(typeof lease.leaseId, 'string'); assert.deepEqual(lease.target, { principal: 'local.target' });
  await denied(lease.release(), 'LIFECYCLE_COMPLETION_REQUIRED'); await lease.release({ completed: false });
  assert.equal(s.broker.state('target').programs[0].uncertainLeaseCount, 1); await lease.release({ completed: true });
  const result = await withManagedModule(s.client, s.broker.descriptor(), 'target', async ({ target }) => { assert.equal(target.principal, 'local.target'); return 'stream finished'; });
  assert.equal(result, 'stream finished'); assert.equal(s.broker.leases.size, 0);
});
test('SDK requires a managed runtime descriptor and never manufactures a default control channel', async t => {
  const s = scene(t); await denied(callManaged(s.client, null, 'target', 'work', {}), 'LIFECYCLE_CONFIG_REQUIRED'); assert.equal(s.starts, 0);
});
test('invalid SDK control options fail before acquiring or starting a target', async t => {
  const s = scene(t); await denied(acquireManagedLease(s.client, s.broker.descriptor(), 'target', { controlTimeoutMs: -1 }), 'LIFECYCLE_OPTIONS_INVALID');
  await denied(callManaged(s.client, s.broker.descriptor(), 'target', 'business', {}, { receiptTimeoutMs: 0 }), 'LIFECYCLE_OPTIONS_INVALID');
  assert.equal(s.starts, 0); assert.equal(s.broker.leases.size, 0);
});
test('broker uses its own narrow credential and a now-only ordinary request subscription', async t => {
  const observed = { sockets: 0, channels: [], subscription: null };
  class RecordingBridge {
    constructor(options) { this.options = options; this.connected = false; this.subscriptions = []; this.handlers = {}; observed.sockets++; }
    on(name, fn) { this.handlers[name] = fn; return this; }
    async connect() { this.connected = true; return { authenticated: true, principal: this.options.credential }; }
    async registerChannels(channels) { observed.channels.push(...channels); }
    async subscribe(filters, options) { observed.subscription = { filters, options }; this.subscriptions.push({ filters }); }
    async close() { this.connected = false; this.handlers.close?.(); }
  }
  const s = scene(t, { BridgeClass: RecordingBridge }); s.broker.available = false;
  await Promise.all([s.broker.connect(), s.broker.connect()]);
  assert.equal(observed.sockets, 1); assert.equal(s.broker.state().available, true);
  assert.deepEqual(observed.subscription, { filters: [s.broker.topic], options: { operations: ['request'], from: 'now' } });
  const credential = s.calls[0].credentials[s.broker.principal];
  assert.deepEqual(credential.allow, { publish: [s.broker.topic], subscribe: [s.broker.topic] }); assert.equal(credential.maxConnections, 1);
  assert.equal(observed.channels.length, 1); assert.doesNotMatch(JSON.stringify(s.broker.state()), new RegExp(credential.token));
  assert.equal(s.broker.bridge.options.autoAck, false);
});
test('a failed lifecycle authentication stays unavailable without preventing the shared Hub from running', async t => {
  class WrongBridge {
    constructor() { this.connected = true; }
    on() { return this; }
    async connect() { return { authenticated: false, principal: 'anonymous' }; }
    async close() { this.connected = false; }
  }
  const s = scene(t, { BridgeClass: WrongBridge }); s.broker.available = false;
  await denied(s.broker.connect(), 'LIFECYCLE_IDENTITY_INVALID');
  assert.equal(s.broker.state().available, false); assert.equal(s.starts, 0); assert.equal(s.stops, 0); assert.equal(s.local.closing, false);
});
test('shutdown revokes only the supervisor credential and does not stop unrelated or pinned processes', async t => {
  const s = scene(t); await s.command({ action: 'acquire', programId: 'target' });
  await s.broker.close(); assert.equal(s.stops, 0); assert.deepEqual(s.calls.at(-1).remove, [s.broker.principal]);
  await denied(s.command({ action: 'acquire', programId: 'target' }), 'LIFECYCLE_CLOSED');
});
test('shutdown cancels only broker-owned cold starts before dependency preparation can spawn a process', async t => {
  const s = scene(t), manual = new AbortController(); s.local.startControllers.add(manual);
  let entered;
  const entering = new Promise(resolve => { entered = resolve; });
  s.local.onStarting = async (id, { signal }) => { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(issue('START_STOPPED')), { once: true })); };
  const acquiring = s.command({ action: 'acquire', programId: 'target' });
  await entering; assert.equal(s.broker.controllers.size, 1); await s.broker.close();
  await denied(acquiring, 'START_STOPPED'); assert.equal(s.local.handles.size, 0); assert.equal(s.broker.leases.size, 0);
  assert.equal(manual.signal.aborted, false); assert.equal(s.local.startControllers.size, 1); assert.equal(s.broker.controllers.size, 0);
});
