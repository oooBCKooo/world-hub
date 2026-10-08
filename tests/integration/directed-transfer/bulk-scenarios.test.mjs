// These scenarios coordinate separate ordinary program processes; only their
// external mod bridges touch the Hub. The coordinator checks files and receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createScene } from '../../../examples/directed-transfer/scene-harness.mjs';

const MiB = 1024 * 1024;
const BYTES = 6 * MiB + 19;
const HALF = 2 * MiB;
const delivery = event => event.message ?? event.delivery ?? event;
const received = (peer, seq, operation) => peer.wait(event => event.kind === 'delivery' &&
  delivery(event).seq === seq && (!operation || delivery(event).operation === operation));
const makeFile = (scene, peer, name, size = BYTES, seed = 11) => peer.cmd('generate', {
  path: join(scene.dir, name), size, seed,
}, { timeoutMs: 30_000 });
const requireError = async (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code, error.message); return true;
});
const subscribe = (peer, topic, operations) => peer.cmd('subscribe', {
  filters: [topic], from: 0, ...(operations ? { operations } : {}),
});
const checkDestination = async (peer, path, source) => {
  const downloaded = await peer.cmd('fileHash', { path });
  assert.equal(downloaded.size, source.size);
  assert.equal(downloaded.sha256, source.sha256);
  return downloaded;
};

test('P4-B01 actual programs: a requested 6 MiB report returns as an attachment and the caller verifies its bytes', { timeout: 60_000 }, async t => {
  const scene = await createScene(t, { principals: ['report.provider', 'report.caller'] });
  const provider = await scene.peer('report.provider');
  const caller = await scene.peer('report.caller');
  assert.notEqual(provider.pid, caller.pid);
  const source = await makeFile(scene, provider, 'report.bin');
  const object = await provider.cmd('upload', { path: source.path }, { timeoutMs: 30_000 });
  const topic = 'external/report/export-on-request';
  await provider.cmd('register', { channels: [{ name: topic, publish: true, subscribe: true }] });
  await caller.cmd('register', { channels: [{ name: topic, publish: true, subscribe: true }] });
  await subscribe(provider, topic, ['request']);
  const pending = caller.cmd('call', {
    target: { principal: 'report.provider' }, topic, body: { query: 'report-generated-by-an-external-program', format: 'opaque' }, timeoutMs: 20_000,
  }, { timeoutMs: 30_000 });
  pending.catch(() => {});
  const requestEvent = await provider.wait(event => event.kind === 'delivery' && delivery(event).operation === 'request' && delivery(event).topic === topic);
  const request = delivery(requestEvent);
  const responseReceipt = await provider.cmd('respond', {
    requestSeq: request.seq, body: { report: 'selected-by-provider', bytes: source.size }, attachments: [object.id],
  });
  const result = await pending;
  assert.equal(result.request.seq, request.seq);
  assert.equal(result.response.seq, responseReceipt.seq);
  assert.equal(result.response.requestSeq, request.seq);
  assert.equal(result.response.fromPrincipal, 'report.provider');
  assert.deepEqual(result.response.attachments, [{ id: object.id, size: source.size, sha256: source.sha256 }]);
  const path = join(scene.dir, 'caller-report.bin');
  await caller.cmd('download', { messageSeq: result.response.seq, id: object.id, path }, { timeoutMs: 30_000 });
  await checkDestination(caller, path, source);
  assert.equal((await provider.cmd('blobStatus', { id: object.id })).released, false, 'returning and downloading do not choose the provider retention policy');
  scene.record('requested-large-report', { bytes: source.size, sha256: source.sha256, requestSeq: request.seq, responseSeq: responseReceipt.seq, providerPid: provider.pid, callerPid: caller.pid, objectId: object.id });
});

test('P4-B02 actual programs: killed uploader and restarted Hub resume the confirmed prefix before a different program receives the attachment', { timeout: 60_000 }, async t => {
  const scene = await createScene(t, { principals: ['transfer.provider', 'transfer.receiver'] });
  let provider = await scene.peer('transfer.provider');
  const firstPid = provider.pid;
  const source = await makeFile(scene, provider, 'upload-restart.bin', BYTES, 21);
  const pending = provider.cmd('upload', { path: source.path, pauseAt: HALF }, { timeoutMs: 30_000 });
  pending.catch(() => {});
  const paused = await provider.wait(event => event.kind === 'paused' && event.operation === 'upload');
  assert.equal(paused.offset, HALF);
  assert.ok(paused.offset < source.size);
  const objectId = paused.id;
  assert.equal((await provider.cmd('blobStatus', { id: objectId })).offset, HALF);
  await provider.kill();
  await assert.rejects(pending, /exit|kill|closed|stopped|disconnect/i);
  await scene.restart();
  provider = await scene.peer('transfer.provider');
  assert.notEqual(provider.pid, firstPid);
  const restored = await provider.cmd('blobStatus', { id: objectId });
  assert.equal(restored.offset, HALF);
  assert.equal(restored.committed, false);
  assert.equal(restored.released, false);
  const completed = await provider.cmd('upload', { path: source.path, id: objectId }, { timeoutMs: 30_000 });
  assert.equal(completed.id, objectId);
  assert.equal(completed.offset, source.size);
  assert.equal(completed.sha256, source.sha256);
  assert.equal(completed.committed, true);
  const receipt = await provider.cmd('inject', {
    target: { principal: 'transfer.receiver' }, topic: 'external/archive/object', body: { purpose: 'chosen-by-provider-after-resumption' }, attachments: [objectId],
  });
  // The intended receiving program starts only after the upload and injection.
  const receiver = await scene.peer('transfer.receiver');
  await subscribe(receiver, 'external/archive/object', ['inject']);
  const message = delivery(await received(receiver, receipt.seq, 'inject'));
  assert.equal(message.attachments[0].id, objectId);
  const destination = join(scene.dir, 'received-after-upload-restart.bin');
  await receiver.cmd('download', { messageSeq: receipt.seq, id: objectId, path: destination }, { timeoutMs: 30_000 });
  await checkDestination(receiver, destination, source);
  scene.record('upload-process-and-hub-restart', { bytes: source.size, sha256: source.sha256, objectId, confirmedBeforeKill: paused.offset, originalProviderPid: firstPid, resumedProviderPid: provider.pid, receiverPid: receiver.pid, injectionSeq: receipt.seq });
});

test('P4-B03 actual programs: killed receiver retains a real partial file and resumes it after a Hub restart', { timeout: 60_000 }, async t => {
  const scene = await createScene(t, { principals: ['download.provider', 'download.receiver'] });
  const provider = await scene.peer('download.provider');
  let receiver = await scene.peer('download.receiver');
  const firstPid = receiver.pid;
  const source = await makeFile(scene, provider, 'download-restart.bin', BYTES, 31);
  const object = await provider.cmd('upload', { path: source.path }, { timeoutMs: 30_000 });
  await subscribe(receiver, 'external/media/chosen-object', ['inject']);
  const receipt = await provider.cmd('inject', { target: { principal: 'download.receiver' }, topic: 'external/media/chosen-object', body: { arbitraryType: 'media' }, attachments: [object.id] });
  await received(receiver, receipt.seq, 'inject');
  const destination = join(scene.dir, 'receiver-resumed.bin');
  const partial = `${destination}.${object.id}.partial`;
  const pending = receiver.cmd('download', { messageSeq: receipt.seq, id: object.id, path: destination, pauseAt: HALF }, { timeoutMs: 30_000 });
  pending.catch(() => {});
  const paused = await receiver.wait(event => event.kind === 'paused' && event.operation === 'download');
  assert.equal(paused.offset, HALF);
  assert.equal((await stat(partial)).size, HALF);
  await receiver.kill();
  await assert.rejects(pending, /exit|kill|closed|stopped|disconnect/i);
  await provider.close();
  await scene.restart();
  receiver = await scene.peer('download.receiver');
  assert.notEqual(receiver.pid, firstPid);
  await subscribe(receiver, 'external/media/chosen-object', ['inject']);
  await received(receiver, receipt.seq, 'inject');
  const resumed = await receiver.cmd('download', { messageSeq: receipt.seq, id: object.id, path: destination, resume: true }, { timeoutMs: 30_000 });
  assert.equal(resumed.id, object.id);
  await checkDestination(receiver, destination, source);
  await assert.rejects(stat(partial), { code: 'ENOENT' });
  const newProvider = await scene.peer('download.provider');
  assert.equal((await newProvider.cmd('blobStatus', { id: object.id })).released, false);
  scene.record('download-process-and-hub-restart', { bytes: source.size, sha256: source.sha256, objectId: object.id, partialBeforeKill: paused.offset, originalReceiverPid: firstPid, resumedReceiverPid: receiver.pid, messageSeq: receipt.seq });
});

test('P4-B04 actual programs: two providers occupy shared capacity; read and ACK retain it until one provider explicitly releases its object', { timeout: 90_000 }, async t => {
  const scene = await createScene(t, {
    principals: ['capacity.a', 'capacity.b', 'capacity.c', 'capacity.receiver'],
    blobs: { maxObjectBytes: BYTES, maxTotalBytes: BYTES * 2, maxObjects: 8 },
  });
  const a = await scene.peer('capacity.a'); const b = await scene.peer('capacity.b'); const c = await scene.peer('capacity.c');
  const receiver = await scene.peer('capacity.receiver', { bridges: [{ id: 'capacity.receiver', autoAck: false }] });
  const sourceA = await makeFile(scene, a, 'capacity-a.bin', BYTES, 41);
  const sourceB = await makeFile(scene, b, 'capacity-b.bin', BYTES, 51);
  const [objectA, objectB] = await Promise.all([
    a.cmd('upload', { path: sourceA.path }, { timeoutMs: 30_000 }),
    b.cmd('upload', { path: sourceB.path }, { timeoutMs: 30_000 }),
  ]);
  await subscribe(receiver, 'external/capacity/object', ['inject']);
  const receiptA = await a.cmd('inject', { target: { principal: 'capacity.receiver' }, topic: 'external/capacity/object', body: { providerPolicy: 'kept' }, attachments: [objectA.id] });
  const messageA = delivery(await received(receiver, receiptA.seq, 'inject'));
  await requireError(c.cmd('blob', { type: 'blob_begin', fields: { size: sourceB.size, sha256: sourceB.sha256 } }), 'BLOB_CAPACITY');
  const pathA = join(scene.dir, 'capacity-a-read.bin');
  await receiver.cmd('download', { messageSeq: receiptA.seq, id: objectA.id, path: pathA }, { timeoutMs: 30_000 });
  await checkDestination(receiver, pathA, sourceA);
  assert.deepEqual(await receiver.cmd('ack', { message: messageA }), { acknowledged: true });
  await receiver.cmd('barrier'); // Same-connection receipt proves Hub handled the prior ACK.
  await requireError(c.cmd('blob', { type: 'blob_begin', fields: { size: sourceB.size, sha256: sourceB.sha256 } }), 'BLOB_CAPACITY');
  assert.equal((await a.cmd('blobStatus', { id: objectA.id })).released, false);
  assert.equal((await b.cmd('blobStatus', { id: objectB.id })).released, false);
  await requireError(b.cmd('releaseBlob', { id: objectA.id }), 'BLOB_OWNER_DENIED');
  await a.cmd('releaseBlob', { id: objectA.id });
  const admitted = await c.cmd('blob', { type: 'blob_begin', fields: { size: sourceB.size, sha256: sourceB.sha256 } });
  assert.equal(admitted.offset, 0);
  await requireError(receiver.cmd('blob', { type: 'blob_read', fields: { messageSeq: receiptA.seq, id: objectA.id, offset: 0 } }), 'BLOB_NOT_FOUND');
  const receiptB = await b.cmd('inject', { target: { principal: 'capacity.receiver' }, topic: 'external/capacity/object', body: { providerPolicy: 'still-kept' }, attachments: [objectB.id] });
  await received(receiver, receiptB.seq, 'inject');
  const pathB = join(scene.dir, 'capacity-b-read.bin');
  await receiver.cmd('download', { messageSeq: receiptB.seq, id: objectB.id, path: pathB }, { timeoutMs: 30_000 });
  await checkDestination(receiver, pathB, sourceB);
  assert.equal((await b.cmd('blobStatus', { id: objectB.id })).released, false);
  // Object and message releases are separate. Check the message via a real
  // program replay rather than infer its removal from object disappearance.
  await receiver.close();
  const replay = await scene.peer('capacity.receiver');
  await subscribe(replay, 'external/capacity/object', ['inject']);
  const retainedA = delivery(await received(replay, receiptA.seq, 'inject'));
  assert.equal(retainedA.body.providerPolicy, 'kept');
  assert.equal(retainedA.attachments[0].id, objectA.id);
  scene.record('shared-capacity-provider-release', { bytesPerObject: BYTES, providerAPid: a.pid, providerBPid: b.pid, requestingProviderPid: c.pid, releasedObjectId: objectA.id, protectedObjectId: objectB.id, admittedObjectId: admitted.id, retainedMessageSeq: receiptA.seq, oldMessageVisibleInReplay: true });
});

test('P4-B05 actual programs: changed source cannot resume another upload, and a corrupted partial cannot become a successful downloaded file', { timeout: 90_000 }, async t => {
  const scene = await createScene(t, { principals: ['integrity.provider', 'integrity.receiver'] });
  let provider = await scene.peer('integrity.provider');
  const source = await makeFile(scene, provider, 'integrity-source.bin', BYTES, 61);
  const pending = provider.cmd('upload', { path: source.path, pauseAt: HALF }, { timeoutMs: 30_000 });
  pending.catch(() => {});
  const paused = await provider.wait(event => event.kind === 'paused' && event.operation === 'upload');
  assert.equal(paused.offset, HALF);
  await provider.kill();
  await assert.rejects(pending, /exit|kill|closed|stopped|disconnect/i);
  provider = await scene.peer('integrity.provider');
  await provider.cmd('modify', { path: source.path, offset: 0, value: [0] });
  const changed = await provider.cmd('fileHash', { path: source.path });
  assert.notEqual(changed.sha256, source.sha256);
  await requireError(provider.cmd('upload', { path: source.path, id: paused.id }, { timeoutMs: 30_000 }), 'BLOB_RESUME_MISMATCH');
  assert.equal((await provider.cmd('blobStatus', { id: paused.id })).offset, HALF);
  // Regenerating the exact original source is a provider policy, not a Hub fix.
  await provider.cmd('generate', { path: source.path, size: BYTES, seed: 61, overwrite: true });
  const object = await provider.cmd('upload', { path: source.path, id: paused.id }, { timeoutMs: 30_000 });
  assert.equal(object.committed, true);
  assert.equal(object.sha256, source.sha256);
  let receiver = await scene.peer('integrity.receiver');
  await subscribe(receiver, 'external/integrity/object', ['inject']);
  const receipt = await provider.cmd('inject', { target: { principal: 'integrity.receiver' }, topic: 'external/integrity/object', body: { chosenFormat: 'arbitrary-bytes' }, attachments: [object.id] });
  await received(receiver, receipt.seq, 'inject');
  const destination = join(scene.dir, 'integrity-download.bin');
  const partial = `${destination}.${object.id}.partial`;
  const reading = receiver.cmd('download', { messageSeq: receipt.seq, id: object.id, path: destination, pauseAt: HALF }, { timeoutMs: 30_000 });
  reading.catch(() => {});
  await receiver.wait(event => event.kind === 'paused' && event.operation === 'download');
  await receiver.kill();
  await assert.rejects(reading, /exit|kill|closed|stopped|disconnect/i);
  receiver = await scene.peer('integrity.receiver');
  await receiver.cmd('modify', { path: partial, offset: 0, value: [0] });
  await requireError(receiver.cmd('download', { messageSeq: receipt.seq, id: object.id, path: destination, resume: true }, { timeoutMs: 30_000 }), 'BLOB_HASH_MISMATCH');
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  assert.equal((await stat(partial)).size, source.size, 'failed verified download keeps its partial for explicit program recovery');
  assert.equal((await provider.cmd('blobStatus', { id: object.id })).released, false);
  const goodDestination = join(scene.dir, 'integrity-redownload.bin');
  await receiver.cmd('download', { messageSeq: receipt.seq, id: object.id, path: goodDestination }, { timeoutMs: 30_000 });
  await checkDestination(receiver, goodDestination, source);
  scene.record('source-and-partial-integrity', { bytes: source.size, sha256: source.sha256, changedSha256: changed.sha256, objectId: object.id, confirmedUploadOffsetUnaffected: HALF, failedDestinationAbsent: true, preservedPartialBytes: source.size, freshDownloadVerified: true });
});
