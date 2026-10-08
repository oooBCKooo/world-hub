import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { MessageLog } from '../../src/hub/lib/store.mjs';
import { BlobStore } from '../../src/hub/lib/blob-store.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decoded = result => Buffer.from(result.data, 'base64');

async function logFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-capacity-observation-log-'));
  const config = { dir: join(root, 'log'), enabled: true, segmentMaxBytes: 2048, segmentMaxCount: 1, ...overrides };
  const log = new MessageLog(config); await log.open();
  t.after(async () => {
    await log.close();
    const target = resolve(root);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && basename(target).startsWith('hub-capacity-observation-log-'));
    await rm(target, { recursive: true, force: true });
  });
  return { log, config };
}

async function blobFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-capacity-observation-blob-'));
  const config = { dir: join(root, 'blobs'), maxObjectBytes: 8, maxTotalBytes: 8, maxObjects: 2, chunkBytes: 4, ...overrides };
  const store = new BlobStore(config); await store.open();
  t.after(async () => {
    await store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && basename(target).startsWith('hub-capacity-observation-blob-'));
    await rm(target, { recursive: true, force: true });
  });
  return { store, config, path: id => join(config.dir, `${id}.bin`) };
}

function message(log, principal, pad = 0, { legacy = false } = {}) {
  return { seq: log.nextSeq(), kind: 'message', topic: 'observation/arbitrary', from: legacy ? principal : `${principal}:1`,
    ...(legacy ? {} : { owner: principal }), body: { pad: 'x'.repeat(pad) } };
}

async function put(store, owner, text) {
  const bytes = Buffer.from(text), object = await store.begin(owner, { size: bytes.length, sha256: digest(bytes) });
  for (let offset = 0; offset < bytes.length; offset += store.chunkBytes) {
    await store.write(object.id, owner, { offset, data: bytes.subarray(offset, offset + store.chunkBytes).toString('base64') });
  }
  return store.commit(object.id, owner);
}

test('capacity observation: oldest unreleased stable owners identify global blockers; release and rotation refresh attribution', async t => {
  const { log } = await logFixture(t);
  const betaOne = message(log, 'beta'), alpha = message(log, 'alpha'), betaTwo = message(log, 'beta'), legacy = message(log, 'legacy', 0, { legacy: true });
  for (const record of [betaOne, alpha, betaTwo, legacy]) await log.append(record);
  await log.appendGap({ seq: log.nextSeq(), subscriptionId: 'observer', from: betaOne.seq, to: betaOne.seq, reason: 'test-only' });
  const full = log.retentionSnapshot();
  assert.deepEqual(full.oldestProtectedOwners, [
    { principal: 'alpha', firstSeq: alpha.seq, lastSeq: alpha.seq, count: 1 },
    { principal: 'beta', firstSeq: betaOne.seq, lastSeq: betaTwo.seq, count: 2 },
    { principal: 'legacy', firstSeq: legacy.seq, lastSeq: legacy.seq, count: 1 },
  ]);
  assert.equal(full.protectedCount, 4);
  assert.equal(full.unusedSegmentSlots, 0);
  assert.equal(full.nextRotationBlocked, true);
  assert.ok(full.activeSegmentTargetRemainingBytes > 0, 'rotation blocked does not mean the active segment has no target space');
  await assert.rejects(log.append(message(log, 'another-provider', 3000)), { code: 'LOG_CAPACITY' });
  assert.deepEqual(log.tail().filter(record => record.kind === 'message').map(record => record.seq), [betaOne.seq, alpha.seq, betaTwo.seq, legacy.seq]);
  await log.release([betaOne.seq, betaTwo.seq], 'beta');
  assert.deepEqual(log.retentionSnapshot().oldestProtectedOwners.map(owner => owner.principal), ['alpha', 'legacy']);
  assert.equal(log.retentionSnapshot().nextRotationBlocked, true);
  await log.release([alpha.seq], 'alpha');
  await log.release([legacy.seq], 'legacy');
  const permitted = log.retentionSnapshot();
  assert.deepEqual(permitted.oldestProtectedOwners, []);
  assert.equal(permitted.nextRotationBlocked, false);
  assert.equal(permitted.bytes, full.bytes, 'release changes protection without deleting historical bytes');
  const replacement = message(log, 'replacement', 3000);
  await log.append(replacement);
  const rotated = log.retentionSnapshot();
  assert.deepEqual(rotated.oldestProtectedOwners, [{ principal: 'replacement', firstSeq: replacement.seq, lastSeq: replacement.seq, count: 1 }]);
  assert.equal(rotated.activeSegmentTargetRemainingBytes, 0, 'oversized records exceed the rotation target without producing negative remaining bytes');
  assert.equal(rotated.protectedCount, 1);
  assert.equal(rotated.releasedCount, 0);
  assert.deepEqual(log.tail().map(record => record.seq), [replacement.seq]);
});

test('capacity observation: unused segments and active target are distinct; only the oldest segment contributes blocker owners', async t => {
  const { log, config } = await logFixture(t, { segmentMaxBytes: 512, segmentMaxCount: 3, enabled: false });
  const empty = log.retentionSnapshot();
  assert.equal(empty.unusedSegmentSlots, 2);
  assert.equal(empty.activeSegmentTargetRemainingBytes, config.segmentMaxBytes);
  assert.deepEqual(empty.oldestProtectedOwners, []);
  const first = message(log, 'first'); await log.append(first);
  const firstSnapshot = log.retentionSnapshot();
  assert.equal(firstSnapshot.activeSegmentTargetRemainingBytes, config.segmentMaxBytes - firstSnapshot.bytes);
  const second = message(log, 'second', 1024); await log.append(second);
  const snapshot = log.retentionSnapshot();
  assert.equal(snapshot.segmentCount, 2);
  assert.equal(snapshot.unusedSegmentSlots, 1);
  assert.equal(snapshot.activeSegmentTargetRemainingBytes, 0);
  assert.equal(snapshot.nextRotationBlocked, false);
  assert.equal(snapshot.protectedCount, 2);
  assert.deepEqual(snapshot.oldestProtectedOwners, [{ principal: 'first', firstSeq: first.seq, lastSeq: first.seq, count: 1 }]);
});

test('capacity observation: partial upload reserves declared bytes and zero-byte objects consume slots', async t => {
  const { store } = await blobFixture(t, { maxObjectBytes: 10, maxTotalBytes: 10, maxObjects: 2, chunkBytes: 3 });
  const partial = await store.begin('one', { size: 6, sha256: digest('abcdef') });
  await store.write(partial.id, 'one', { offset: 0, data: Buffer.from('abc').toString('base64') });
  const snapshot = store.snapshot();
  assert.equal(snapshot.reservedBytes, 6);
  assert.equal(snapshot.reservedBytesExact, '6');
  assert.equal(snapshot.remainingBytes, '4');
  assert.equal(snapshot.writtenBytes, 3);
  assert.equal(snapshot.remainingObjectSlots, 1);
  assert.equal(snapshot.uploadingCount, 1);
  assert.equal(snapshot.releasedBytes, '0');
  assert.equal(snapshot.reclaimableBytes, '0');
  await assert.rejects(store.begin('other', { size: 6, sha256: digest('uvwxyz') }), { code: 'BLOB_CAPACITY' });
  await store.begin('other', { size: 0, sha256: digest('') });
  assert.equal(store.snapshot().remainingBytes, '4');
  assert.equal(store.snapshot().remainingObjectSlots, 0);
  await assert.rejects(store.begin('third', { size: 0, sha256: digest('') }), { code: 'BLOB_CAPACITY' });
});

test('capacity observation: release retains reservation and bytes until a new begin reclaims only permitted objects', async t => {
  const { store, path } = await blobFixture(t);
  const a = await put(store, 'a', 'abcd'), b = await put(store, 'b', 'efgh');
  await assert.rejects(store.begin('c', { size: 4, sha256: digest('ijkl') }), { code: 'BLOB_CAPACITY' });
  await store.release(a.id, 'a');
  const released = store.snapshot();
  assert.equal(released.reservedBytesExact, '8');
  assert.equal(released.remainingBytes, '0');
  assert.equal(released.remainingObjectSlots, 0);
  assert.equal(released.releasedBytes, '4');
  assert.equal(released.reclaimableBytes, '4');
  assert.equal(released.reclaimableObjectCount, 1);
  assert.equal(released.releasedCount, 1);
  assert.equal((await stat(path(a.id))).size, 4);
  assert.deepEqual(decoded(await store.read(a.id)), Buffer.from('abcd'));
  const c = await put(store, 'c', 'ijkl');
  const reclaimed = store.snapshot();
  assert.equal(reclaimed.reservedBytesExact, '8');
  assert.equal(reclaimed.releasedBytes, '0');
  assert.equal(reclaimed.reclaimableBytes, '0');
  assert.equal(reclaimed.reclaimableObjectCount, 0);
  assert.throws(() => store.get(a.id), { code: 'BLOB_NOT_FOUND' });
  await assert.rejects(stat(path(a.id)), { code: 'ENOENT' });
  assert.equal(digest(decoded(await store.read(b.id))), b.sha256, 'protected provider bytes remain intact');
  assert.equal(digest(decoded(await store.read(c.id))), c.sha256);
});

test('capacity observation: a released object with an append pin is excluded from reclaimable capacity until the lease ends', async t => {
  const { store } = await blobFixture(t);
  const a = await put(store, 'a', 'abcd'), b = await put(store, 'b', 'efgh');
  const lease = await store.pinAttachments('a', [a.id]);
  t.after(() => lease.release());
  await store.release(a.id, 'a');
  const pinned = store.snapshot();
  assert.equal(pinned.pinnedCount, 1);
  assert.equal(pinned.releasedBytes, '4');
  assert.equal(pinned.reclaimableBytes, '0');
  assert.equal(pinned.reclaimableObjectCount, 0);
  await assert.rejects(store.begin('c', { size: 4, sha256: digest('ijkl') }), { code: 'BLOB_CAPACITY' });
  assert.deepEqual(decoded(await store.read(a.id)), Buffer.from('abcd'));
  lease.release();
  assert.equal(store.snapshot().pinnedCount, 0);
  assert.equal(store.snapshot().reclaimableBytes, '4');
  await put(store, 'c', 'ijkl');
  assert.equal(digest(decoded(await store.read(b.id))), b.sha256);
});

test('capacity observation: restart restores partial reservations and provider release while temporary pins do not persist', async t => {
  const { store, config } = await blobFixture(t);
  const completed = await put(store, 'a', 'abcd');
  const partial = await store.begin('b', { size: 4, sha256: digest('efgh') });
  await store.write(partial.id, 'b', { offset: 0, data: Buffer.from('ef').toString('base64') });
  await store.release(completed.id, 'a');
  await store.close();
  const recovered = new BlobStore(config); await recovered.open();
  t.after(() => recovered.close());
  const snapshot = recovered.snapshot();
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.reservedBytesExact, '8');
  assert.equal(snapshot.remainingBytes, '0');
  assert.equal(snapshot.remainingObjectSlots, 0);
  assert.equal(snapshot.writtenBytes, 6);
  assert.equal(snapshot.uploadingCount, 1);
  assert.equal(snapshot.releasedBytes, '4');
  assert.equal(snapshot.reclaimableBytes, '4');
  assert.equal(snapshot.pinnedCount, 0);
  assert.equal(digest(decoded(await recovered.read(completed.id))), completed.sha256);
  await recovered.write(partial.id, 'b', { offset: 2, data: Buffer.from('gh').toString('base64') });
  await recovered.commit(partial.id, 'b');
  assert.equal(digest(decoded(await recovered.read(partial.id))), partial.sha256);
});
