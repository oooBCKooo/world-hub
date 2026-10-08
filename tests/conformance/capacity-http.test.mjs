import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, until } from '../helpers/hub-harness.mjs';

test('capacity diagnostics survive a full log: accepted publish, failed gap, owner release and shared HTTP views', async t => {
  const prefix = 'hub-capacity-http-';
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const h = new Harness({ logDir: join(directory, 'log'), keepTmp: true });
  const bridges = [];
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close()));
    await h.stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({
    log: { segmentMaxBytes: 4096, segmentMaxCount: 1 },
    blobs: { maxObjectBytes: 1024, maxTotalBytes: 1024, maxObjects: 2 },
    limits: { maxPendingDeliveries: 1 },
    acl: { bridges: {
      source: { token: 'test-source', allow: { publish: ['#'], subscribe: ['#'] } },
      reader: { token: 'test-reader', allow: { publish: [], subscribe: ['#'] } },
    } },
  }));
  await h.startHub({ configPath, isolateLog: false });
  assert.equal(h.ready.storage.log.unusedSegmentSlots, 0);
  assert.equal(h.ready.storage.blobs.remainingBytes, '1024');
  for (const id of ['source', 'reader']) {
    const bridge = new Bridge({ url: h.endpoint, bridgeId: id, token: `test-${id}`, autoAck: false,
      cursorFile: join(directory, `${id}-cursor.json`) });
    bridges.push(bridge); await bridge.connect();
  }
  const [source, reader] = bridges;
  const deliveries = [], overflows = [];
  reader.on('delivery', frame => deliveries.push(frame));
  reader.on('overflow', frame => overflows.push(frame));
  await reader.subscribe(['capacity/#']);
  const first = await source.publishConfirmed('capacity/data', { padding: '' });
  await until(() => deliveries.length === 1);
  const firstBytes = (await h.status()).storage.log.bytes;
  // The same ASCII padding occurs in both compatibility body and bodyRaw.
  // Leave fewer bytes than a gap record, while allowing the second message.
  const padding = 'x'.repeat(Math.floor((4096 - 2 * firstBytes - 24) / 2));
  const second = await source.publishConfirmed('capacity/data', { padding });
  const failed = await until(async () => {
    const status = await h.status(); return status.counters.gapLogFailures === 1 && status;
  });
  await until(() => overflows.length === 1, { what: 'actual WebSocket overflow receipt' });
  assert.equal(failed.counters.accepted, 2, 'gap failure must not reject an accepted publish');
  assert.equal(failed.lastGapLogFailure.code, 'LOG_CAPACITY');
  assert.deepEqual([failed.lastGapLogFailure.from, failed.lastGapLogFailure.to], [second.seq, second.seq]);
  assert.equal(failed.storage.log.retainedCount, 2);
  assert.equal(failed.storage.log.nextRotationBlocked, true);
  assert.deepEqual(failed.storage.log.oldestProtectedOwners, [{ principal: 'source', firstSeq: first.seq, lastSeq: second.seq, count: 2 }]);
  assert.ok(failed.storage.log.activeSegmentTargetRemainingBytes < 40);
  await assert.rejects(source.publishConfirmed('capacity/data', { padding: 'cannot-fit'.repeat(100) }), { code: 'LOG_CAPACITY' });
  await reader.subscribe(['capacity/data'], { from: first.seq });
  await until(() => deliveries.some(frame => frame.seq === second.seq));
  const replayed = deliveries.find(frame => frame.seq === second.seq);
  assert.equal(replayed.body.padding, padding, 'full capacity still permits actual network history reads');
  const reservation = await source.communicationRequest('blob_begin', { size: 1024, sha256: '0'.repeat(64) });
  const response = await fetch(`${h.httpBase}/manage/api/state`);
  assert.equal(response.status, 200);
  const managed = await response.json(), status = await h.status();
  const { records, ...managedLog } = managed.log;
  assert.deepEqual(managedLog, status.storage.log);
  assert.deepEqual(managed.blobs, status.storage.blobs);
  assert.equal(managed.blobs.reservedBytesExact, '1024');
  assert.equal(managed.blobs.remainingBytes, '0');
  assert.equal(managed.blobs.remainingObjectSlots, 1);
  assert.equal(managed.blobs.uploadingCount, 1);
  assert.ok(records.some(record => record.seq === second.seq));
  assert.ok(!JSON.stringify(status).includes('test-source'), 'capacity snapshots never expose ACL secrets');
  // Reading/ACK and owner release remain possible when publication cannot rotate.
  assert.equal(reader.ack(deliveries[0]), true);
  assert.equal(reader.ack(replayed), true);
  await until(async () => {
    const snapshot = await h.status();
    return snapshot.subscriptions.find(sub => sub.id === deliveries[0].subscription)?.cursor === first.seq
      && snapshot.subscriptions.find(sub => sub.id === replayed.subscription)?.cursor === second.seq
      && snapshot.subscriptions.every(sub => sub.pending === 0);
  }, { what: 'Hub applies ACKs while publication capacity is blocked' });
  await source.release([first.seq, second.seq]);
  const released = (await h.status()).storage.log;
  assert.equal(released.protectedCount, 0);
  assert.deepEqual(released.oldestProtectedOwners, []);
  await source.releaseBlob(reservation.id);
  assert.equal((await h.status()).storage.blobs.reclaimableBytes, '1024');
  await source.communicationRequest('blob_begin', { size: 1024, sha256: '1'.repeat(64) });
  const recovered = await source.publishConfirmed('capacity/data', { padding: 'capacity recovered' });
  assert.ok(recovered.seq > second.seq);
  assert.equal((await h.status()).storage.log.protectedCount, 1);
  assert.equal(h.hub.pid, h.ready.pid, 'capacity recovery does not restart Hub');
});
