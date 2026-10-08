import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MessageLog } from '../../src/hub/lib/store.mjs';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, until } from '../helpers/hub-harness.mjs';
import { assertDiagnosticContract } from './diagnostic-contract.mjs';

const record = (log, owner, padding = '') => ({ seq: log.nextSeq(), kind: 'message', topic: 'capacity/errors',
  from: `${owner}:1`, owner, body: { padding } });

test('LOG_CAPACITY carries current detached communication attribution and changes only after provider release', async t => {
  const log = new MessageLog({ enabled: false, dir: '', segmentMaxBytes: 1024, segmentMaxCount: 1 });
  await log.open(); t.after(() => log.close());
  const alpha = record(log, 'alpha'), beta = record(log, 'beta');
  await log.append(alpha); await log.append(beta);
  let firstError;
  await assert.rejects(log.append(record(log, 'waiting', 'x'.repeat(2048))), error => {
    firstError = error;
    assert.equal(error.code, 'LOG_CAPACITY');
    assert.deepEqual(error.logCapacity, log.retentionSnapshot());
    assert.deepEqual(error.logCapacity.oldestProtectedOwners, [
      { principal: 'alpha', firstSeq: alpha.seq, lastSeq: alpha.seq, count: 1 },
      { principal: 'beta', firstSeq: beta.seq, lastSeq: beta.seq, count: 1 },
    ]);
    assert.equal(error.logCapacity.unusedSegmentSlots, 0);
    assert.equal(error.logCapacity.nextRotationBlocked, true);
    assert.ok(!JSON.stringify(error.logCapacity).includes('padding'), 'diagnostics never include opaque message bodies');
    return true;
  });
  firstError.logCapacity.oldestProtectedOwners[0].count = 999;
  assert.equal(log.retentionSnapshot().oldestProtectedOwners[0].count, 1, 'error metadata cannot mutate retention');
  await log.release([alpha.seq], 'alpha');
  await assert.rejects(log.append(record(log, 'waiting', 'x'.repeat(2048))), error => {
    assert.equal(error.code, 'LOG_CAPACITY');
    assert.deepEqual(error.logCapacity.oldestProtectedOwners, [{ principal: 'beta', firstSeq: beta.seq, lastSeq: beta.seq, count: 1 }]);
    assert.equal(error.logCapacity.protectedCount, 1);
    assert.equal(error.logCapacity.releasedCount, 1);
    return true;
  });
  await log.release([beta.seq], 'beta');
  const recovered = record(log, 'waiting', 'x'.repeat(2048)); await log.append(recovered);
  assert.deepEqual(log.tail().map(entry => entry.seq), [recovered.seq]);
});

test('LOG_CAPACITY remains the original failure when optional diagnostic collection throws', async t => {
  const log = new MessageLog({ enabled: false, dir: '', segmentMaxBytes: 256, segmentMaxCount: 1 });
  await log.open(); t.after(() => log.close());
  const kept = record(log, 'source'); await log.append(kept);
  log.retentionSnapshot = () => { throw new Error('test-only diagnostic collector failure'); };
  await assert.rejects(log.append(record(log, 'waiting', 'x'.repeat(512))), error => {
    assert.equal(error.code, 'LOG_CAPACITY');
    assert.equal(error.logCapacity, undefined);
    assert.ok(!error.message.includes('collector'), 'secondary diagnostics must not replace the capacity failure');
    return true;
  });
  assert.deepEqual(log.tail().map(entry => entry.seq), [kept.seq]);
});

test('real LOG_CAPACITY error frames and SDK errors expose the same existing log summary while reads and owner release still work', async t => {
  const prefix = 'hub-capacity-error-';
  const root = await mkdtemp(join(tmpdir(), prefix)), configPath = join(root, 'config.json');
  const h = new Harness({ logDir: join(root, 'log'), keepTmp: true }), bridges = [];
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close())); await h.stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(configPath, JSON.stringify({ log: { segmentMaxBytes: 1024, segmentMaxCount: 1 }, acl: { bridges: {
    source: { token: 'capacity-source-secret', allow: { publish: ['capacity/#'], subscribe: [] } },
    reader: { token: 'capacity-reader-secret', allow: { publish: [], subscribe: ['capacity/#'] } },
  } } }));
  await h.startHub({ configPath, isolateLog: false });
  for (const id of ['source', 'reader']) {
    const bridge = new Bridge({ url: h.endpoint, bridgeId: id, token: `capacity-${id}-secret`, cursorFile: join(root, `${id}.json`) });
    bridges.push(bridge); await bridge.connect();
  }
  const [source, reader] = bridges, received = [], errors = [];
  reader.on('delivery', frame => received.push(frame)); source.on('error', frame => errors.push(frame));
  const kept = await source.publishConfirmed('capacity/data', { arbitraryBusiness: 'private retained body' });
  let rejection;
  await assert.rejects(source.publishConfirmed('capacity/data', { padding: 'x'.repeat(2048), providerId: 'invented' }), error => {
    rejection = error; assert.equal(error.code, 'LOG_CAPACITY');
    assert.equal(error.frame.type, 'error'); assert.equal(error.frame.code, 'LOG_CAPACITY');
    assert.ok(typeof error.frame.requestToken === 'string');
    return true;
  });
  await until(() => errors.some(frame => frame.code === 'LOG_CAPACITY'));
  const wireError = errors.find(frame => frame.code === 'LOG_CAPACITY'), status = await h.status();
  assert.deepEqual(rejection.frame, wireError, 'promise rejection retains the actual wire error frame');
  assert.deepEqual(wireError.logCapacity, status.storage.log);
  assertDiagnosticContract({ ...status, storage: { ...status.storage, log: wireError.logCapacity } });
  assert.deepEqual(wireError.logCapacity.oldestProtectedOwners, [{ principal: 'source', firstSeq: kept.seq, lastSeq: kept.seq, count: 1 }]);
  assert.equal(status.counters.accepted, 1); assert.equal(status.counters.denied, 1);
  assert.ok(!JSON.stringify(wireError).includes('private retained body'));
  assert.ok(!JSON.stringify(wireError).includes('secret'));
  await reader.subscribe(['capacity/#'], { from: 0 }); await until(() => received.length === 1);
  assert.deepEqual(received[0].body, { arbitraryBusiness: 'private retained body' });
  await until(async () => (await h.status()).subscriptions.every(sub => sub.pending === 0));
  assert.equal((await h.status()).storage.log.protectedCount, 1, 'ACK never grants cleanup permission');
  await source.release([kept.seq]);
  const recovered = await source.publishConfirmed('capacity/data', { padding: 'x'.repeat(2048) });
  assert.ok(recovered.seq > kept.seq); assert.equal((await h.status()).storage.log.protectedCount, 1);
});
