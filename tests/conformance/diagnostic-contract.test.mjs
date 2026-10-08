import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, until } from '../helpers/hub-harness.mjs';
import { DIAGNOSTIC_SCHEMA, diagnosticEntries, validateRegistry, assertDiagnosticContract } from './diagnostic-contract.mjs';

async function evidenceReferences(schema = DIAGNOSTIC_SCHEMA) {
  for (const entry of validateRegistry(schema)) {
    const source = await readFile(new URL(entry.evidence.file, import.meta.url), 'utf8');
    assert.ok(source.includes(`test('${entry.evidence.test}'`) || source.includes(`test("${entry.evidence.test}"`),
      `${entry.path}: named executable evidence does not exist`);
  }
}
async function fixture(t, { smallLog = false } = {}) {
  const prefix = 'hub-diagnostic-contract-';
  const root = await mkdtemp(join(tmpdir(), prefix)), configPath = join(root, 'hub.json');
  const logDir = join(root, 'log'), bridges = [];
  let h;
  await writeFile(configPath, JSON.stringify({
    log: { segmentMaxBytes: smallLog ? 4096 : 1024 * 1024, segmentMaxCount: smallLog ? 1 : 8 },
    limits: { maxPendingDeliveries: 1 },
    acl: { bridges: {
      source: { token: 'diagnostic-source', allow: { publish: ['neutral/#'], subscribe: [] } },
      reader: { token: 'diagnostic-reader', allow: { publish: [], subscribe: ['neutral/#'] } },
    } },
  }));
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close())); await h?.stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  async function start() { h = new Harness({ logDir, keepTmp: true }); await h.startHub({ configPath, isolateLog: false }); return h; }
  await start();
  return { logDir, get h() { return h; }, async restart() { await Promise.all(bridges.map(bridge => bridge.close())); await h.stop(); return start(); },
    async connect(id) {
      const bridge = new Bridge({ url: h.endpoint, bridgeId: id, token: `diagnostic-${id}`, autoAck: false, cursorFile: join(root, `${id}.cursor`) });
      bridges.push(bridge); await bridge.connect(); return bridge;
    } };
}

test('diagnostic registry requires a purpose, a value rule and an existing executable evidence case for every leaf', async () => {
  await evidenceReferences();
  const entries = diagnosticEntries();
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length);
  for (const key of ['purpose', 'rule', 'evidence']) {
    const schema = structuredClone(DIAGNOSTIC_SCHEMA); delete schema.fields.counters.fields.accepted[key];
    assert.throws(() => validateRegistry(schema), /counters.accepted:/);
  }
  const missingCase = structuredClone(DIAGNOSTIC_SCHEMA);
  missingCase.fields.counters.fields.accepted.evidence.test = 'a case that was never implemented';
  await assert.rejects(evidenceReferences(missingCase), /named executable evidence does not exist/);
  const emptyNamespace = structuredClone(DIAGNOSTIC_SCHEMA);
  emptyNamespace.fields.storage.fields.blobs.fields.workflowState = { fields: {} };
  assert.throws(() => validateRegistry(emptyNamespace), /empty diagnostic namespaces cannot be registered/);
});

test('diagnostic guards reject unknown nested fields and plausible numeric lies while payload fields remain unrestricted', async t => {
  const run = await fixture(t), snapshot = await run.h.status(); assertDiagnosticContract(snapshot);
  for (const change of [
    copy => { copy.counters.completedBusinessTasks = 0; },
    copy => { copy.storage.blobs.workflowState = {}; },
    copy => { copy.storage.blobs.limits.systemPrompt = ''; },
    copy => { copy.storage.log.capacity.approvalCount = 0; },
    copy => { copy.storage.log.oldestProtectedOwners = [{ principal: 'source', firstSeq: 1, lastSeq: 1, count: 1, workflowState: {} }]; },
  ]) {
    const copy = structuredClone(snapshot); change(copy);
    assert.throws(() => assertDiagnosticContract(copy), /unregistered diagnostic field/);
  }
  const missing = structuredClone(snapshot); delete missing.storage.blobs.reclaimableBytes;
  assert.throws(() => assertDiagnosticContract(missing), /registered field missing/);
  const wrongGap = structuredClone(snapshot); wrongGap.counters.gapLogFailures = 1;
  assert.throws(() => assertDiagnosticContract(wrongGap), /nonzero gap failures require their latest detail/);
  const wrongCapacity = structuredClone(snapshot); wrongCapacity.storage.blobs.remainingBytes = '1';
  assert.throws(() => assertDiagnosticContract(wrongCapacity), /remaining reservation cannot invent capacity/);
  const wrongRelease = structuredClone(snapshot); wrongRelease.storage.blobs.reclaimableBytes = '1';
  assert.throws(() => assertDiagnosticContract(wrongRelease), /reclaimable requires provider release/);
  // A failed diagnostic may be unable to allocate a seq at all (e.g. high-water
  // exhaustion). This is a shape boundary case, not an actual exhaustion run.
  const allocationFailure = structuredClone(snapshot);
  allocationFailure.storage.log.lastSeq = Number.MAX_SAFE_INTEGER;
  allocationFailure.counters.gapLogFailures = 1;
  allocationFailure.lastGapLogFailure = { at: snapshot.now, subscription: 'sub-shape-only', from: Number.MAX_SAFE_INTEGER,
    to: Number.MAX_SAFE_INTEGER, reason: 'subscriber window full', code: 'HUB_INTERNAL' };
  assertDiagnosticContract(allocationFailure);
  allocationFailure.lastGapLogFailure.seq = -1;
  assert.throws(() => assertDiagnosticContract(allocationFailure), /allocatedSequence rule failed/);
});

test('diagnostic values depend on transport actions, not payload business claims', async t => {
  const run = await fixture(t), source = await run.connect('source'), reader = await run.connect('reader');
  const deliveries = []; reader.on('delivery', frame => deliveries.push(frame)); await reader.subscribe(['neutral/#']);
  const before = await run.h.status(); assertDiagnosticContract(before);
  const body = { kind: 'arbitrary.new.application', completedBusinessTasks: 999, providerId: 'invented',
    workflowState: { finished: true }, counters: { accepted: 999, gapLogFailures: 999 },
    storage: { blobs: { remainingBytes: '99999999' } }, systemPrompt: 'self-created opaque test text' };
  const accepted = await source.publishConfirmed('neutral/arbitrary', body);
  await until(() => deliveries.length === 1);
  assert.deepEqual(deliveries[0].body, body, 'diagnostic governance must never restrict application payload schemas');
  await assert.rejects(source.publishConfirmed('outside/permission', body), { code: 'PUBLISH_DENIED' });
  const after = await run.h.status(); assertDiagnosticContract(after);
  assert.equal(after.counters.accepted, before.counters.accepted + 1);
  assert.equal(after.counters.delivered, before.counters.delivered + 1);
  assert.equal(after.counters.denied, before.counters.denied + 1);
  assert.equal(after.counters.gapLogFailures, 0);
  assert.equal(after.storage.log.retainedCount, 1);
  assert.deepEqual(after.storage.log.oldestProtectedOwners, [{ principal: 'source', firstSeq: accepted.seq, lastSeq: accepted.seq, count: 1 }]);
  assert.equal(after.storage.blobs.reservedBytesExact, '0');
  assert.equal(after.storage.log.maintenanceError, null);
  assert.equal(reader.ack(deliveries[0]), true);
  await until(async () => (await run.h.status()).subscriptions[0].cursor === accepted.seq);
  assert.equal((await run.h.status()).storage.log.protectedCount, 1, 'transport ACK does not decide data value');
});

test('gap diagnostics count only failed persistence, increment again on a later failure and reset on a real restart', async t => {
  const run = await fixture(t, { smallLog: true }), source = await run.connect('source'), reader = await run.connect('reader');
  const overflows = []; reader.on('overflow', frame => overflows.push(frame)); await reader.subscribe(['neutral/#']);
  let stage = 'calibrate committed writes', calculation;
  try {
    const sampleLength = 64;
    const first = await source.publishConfirmed('neutral/data', { padding: 'x'.repeat(sampleLength) });
    const second = await source.publishConfirmed('neutral/data', { padding: '' });
    const saved = await until(async () => {
      // Allocation advances lastSeq before asynchronous append completes. Observe
      // the committed gap, then sample bytes for the next capacity calculation.
      const history = await run.h.log();
      if (!history.records.some(record => record.kind === 'gap' && record.from === second.seq && record.to === second.seq)) return false;
      const snap = await run.h.status(); return snap.counters.dropped === 1 && snap;
    });
    assertDiagnosticContract(saved); assert.equal(saved.counters.gapLogFailures, 0); assert.equal(saved.lastGapLogFailure, null);
    // Calibrate from actual committed bytes, without duplicating MessageLog's
    // serialization algorithm or hardcoding its body/bodyRaw multiplier.
    const lines = (await readFile(join(run.logDir, 'log-000000.jsonl'), 'utf8')).trimEnd().split('\n');
    const committed = lines.map(line => ({ record: JSON.parse(line), bytes: Buffer.byteLength(line + '\n') }));
    const firstBytes = committed.find(entry => entry.record.seq === first.seq).bytes;
    const emptyMessageBytes = committed.find(entry => entry.record.seq === second.seq).bytes;
    const gapBytes = committed.find(entry => entry.record.kind === 'gap').bytes;
    const paddingUnitBytes = (firstBytes - emptyMessageBytes) / sampleLength;
    const remaining = saved.storage.log.activeSegmentTargetRemainingBytes;
    const reserve = Math.floor(gapBytes / 2);
    const paddingLength = Math.floor((remaining - emptyMessageBytes - reserve) / paddingUnitBytes);
    calculation = { firstBytes, emptyMessageBytes, gapBytes, paddingUnitBytes, remaining, reserve, paddingLength,
      capacity: saved.storage.log.capacity, bytesBefore: saved.storage.log.bytes };
    assert.ok(Number.isSafeInteger(paddingUnitBytes) && paddingUnitBytes > 0, 'actual ASCII calibration must have a positive integral size');
    assert.ok(paddingLength > 0 && reserve >= 32 && reserve < gapBytes, 'fixture leaves a broad margin for the message and insufficient room for the next gap');
    stage = 'first failed gap after accepted message';
    const third = await source.publishConfirmed('neutral/data', { padding: 'x'.repeat(paddingLength) });
    const failedOnce = await until(async () => { const snap = await run.h.status(); return snap.counters.gapLogFailures === 1 && snap; });
    assertDiagnosticContract(failedOnce);
    assert.deepEqual([failedOnce.lastGapLogFailure.from, failedOnce.lastGapLogFailure.to], [third.seq, third.seq]);
    assert.equal(failedOnce.counters.accepted, 3);
    assert.ok(failedOnce.storage.log.activeSegmentTargetRemainingBytes >= 32);
    assert.ok(failedOnce.storage.log.activeSegmentTargetRemainingBytes < gapBytes);
    stage = 'provider release and second failed gap';
    await source.release([first.seq, second.seq, third.seq]);
    const fourth = await source.publishConfirmed('neutral/data', { padding: 'z'.repeat(saved.storage.log.capacity.segmentMaxBytes + 1024) });
    const failedTwice = await until(async () => { const snap = await run.h.status(); return snap.counters.gapLogFailures === 2 && snap; });
    assertDiagnosticContract(failedTwice);
    assert.deepEqual([failedTwice.lastGapLogFailure.from, failedTwice.lastGapLogFailure.to], [fourth.seq, fourth.seq]);
    assert.equal(failedTwice.lastGapLogFailure.code, 'LOG_CAPACITY');
    await until(() => overflows.length === 3);
    stage = 'real restart';
    const oldPid = run.h.ready.pid; await run.restart(); assert.notEqual(run.h.ready.pid, oldPid);
    const restarted = await run.h.status(); assertDiagnosticContract(restarted);
    assert.equal(restarted.counters.gapLogFailures, 0); assert.equal(restarted.lastGapLogFailure, null);
    assert.equal(restarted.storage.log.protectedCount, 1, 'restart does not clear provider protection');
  } catch (error) {
    // Preserve useful evidence before fixture cleanup; never replace the failure
    // with a resource-contention guess or a secondary diagnostic exception.
    const status = await run.h.status().catch(failure => ({ collectionError: failure.message }));
    const history = await run.h.log().catch(failure => ({ collectionError: failure.message }));
    t.diagnostic(JSON.stringify({ stage, error: { code: error.code, message: error.message, frame: error.frame }, calculation,
      counters: status.counters, log: status.storage?.log, lastGapLogFailure: status.lastGapLogFailure, overflows,
      records: history.records?.map(record => ({ kind: record.kind, seq: record.seq, from: record.from, to: record.to })),
      pid: run.h.ready?.pid, stderr: run.h.stderr }));
    throw error;
  }
});
