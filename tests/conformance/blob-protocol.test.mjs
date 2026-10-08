import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat, link } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, until } from '../helpers/hub-harness.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'peros-blob-wire-'));
  let harness = new Harness({ keepTmp: true, logDir: join(dir, 'log') });
  const configPath = join(dir, 'config.json');
  const all = { publish: ['#'], subscribe: ['#'] };
  await writeFile(configPath, JSON.stringify({ acl: { bridges: {
    sender: { allow: all }, receiver: { allow: all }, stranger: { allow: all }, restricted: { allow: { subscribe: ['allowed/#'] } },
  } }, ...overrides }));
  const bridges = [];
  await harness.startHub({ configPath, isolateLog: false });
  const make = async (id) => { const bridge = new Bridge({ url: harness.endpoint, bridgeId: id }); bridges.push(bridge); await bridge.connect(); return bridge; };
  t.after(async () => {
    for (const bridge of bridges) await bridge.close();
    await harness.stop();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, make, get harness() { return harness; }, async restart() {
    for (const bridge of bridges) await bridge.close();
    await harness.stop();
    harness = new Harness({ keepTmp: true, logDir: join(dir, 'log') });
    await harness.startHub({ configPath, isolateLog: false });
  } };
}

test('blob wire: >4 MiB directed attachment roundtrip, raw management visibility and non-destructive reads', async (t) => {
  const f = await fixture(t);
  const sender = await f.make('sender'); const receiver = await f.make('receiver'); const stranger = await f.make('stranger');
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 73);
  const source = join(f.dir, 'source.bin'); await writeFile(source, bytes);
  const uploaded = await sender.uploadFile(source);
  assert.equal(uploaded.size, bytes.length); assert.equal(uploaded.sha256, hash(bytes));
  let delivered;
  receiver.on('delivery', (message) => { delivered = message; });
  await receiver.subscribe(['arbitrary/large'], { from: 0 });
  const receipt = await sender.sendTo({ principal: 'receiver' }, 'arbitrary/large', { kind: 'not-hardcoded-in-hub' }, { attachments: [uploaded.id] });
  await until(() => delivered?.seq === receipt.seq);
  assert.deepEqual(delivered.attachments, [{ id: uploaded.id, size: bytes.length, sha256: hash(bytes) }]);
  const downloaded = join(f.dir, 'downloaded.bin');
  await receiver.downloadFile(receipt.seq, uploaded.id, downloaded);
  assert.deepEqual(await readFile(downloaded), bytes);
  let count = 0; const digest = createHash('sha256');
  for await (const block of receiver.readAttachment(receipt.seq, uploaded.id)) { count += block.length; digest.update(block); }
  assert.equal(count, bytes.length); assert.equal(digest.digest('hex'), uploaded.sha256);
  await assert.rejects(stranger.communicationRequest('blob_read', { id: uploaded.id, messageSeq: receipt.seq, offset: 0 }), /BLOB_DENIED/);
  await assert.rejects(receiver.publishConfirmed('arbitrary/forward', {}, { attachments: [uploaded.id] }), /BLOB_DENIED/);
  await assert.rejects(receiver.releaseBlob(uploaded.id), /BLOB_OWNER_DENIED/);
  const raw = await fetch(`${f.harness.httpBase}/manage/api/message?seq=${receipt.seq}`).then((response) => { assert.equal(response.status, 200); return response.json(); });
  assert.equal(raw.record.operation, 'inject'); assert.equal(raw.record.attachments[0].id, uploaded.id);
  assert.equal((await sender.blobStatus(uploaded.id)).released, false);
});

test('blob wire: references require retained attachment metadata, topic permission and exact target session', async (t) => {
  const f = await fixture(t);
  const sender = await f.make('sender'); const receiver = await f.make('receiver'); const stranger = await f.make('stranger'); const restricted = await f.make('restricted');
  const content = Buffer.from('binary-content');
  const object = await sender.uploadStream([content], { size: content.length, sha256: hash(content) });
  const bodyOnly = await sender.publishConfirmed('private/data', { objectId: object.id });
  await assert.rejects(stranger.communicationRequest('blob_read', { id: object.id, messageSeq: bodyOnly.seq, offset: 0 }), /BLOB_DENIED/);
  const withObject = await sender.publishConfirmed('private/data', {}, { attachments: [object.id] });
  await assert.rejects(restricted.communicationRequest('blob_read', { id: object.id, messageSeq: withObject.seq, offset: 0 }), /BLOB_DENIED/);
  const session = receiver.welcome.session;
  const directed = await sender.sendTo({ principal: 'receiver', session }, 'private/data', {}, { attachments: [object.id] });
  await receiver.close();
  const replacement = await f.make('receiver'); assert.notEqual(replacement.welcome.session, session);
  await assert.rejects(replacement.communicationRequest('blob_read', { id: object.id, messageSeq: directed.seq, offset: 0 }), /BLOB_DENIED/);
  assert.equal((await sender.communicationRequest('blob_read', { id: object.id, offset: 0 })).bytes, content.length, 'provider may read its own object');
});

test('blob wire: partial upload resumes after Hub restart, duplicate blocks are idempotent and conflicts fail', async (t) => {
  const f = await fixture(t);
  let sender = await f.make('sender');
  const bytes = Buffer.alloc(1024 * 1024 + 3, 17); const source = join(f.dir, 'resume.bin'); await writeFile(source, bytes);
  const object = await sender.communicationRequest('blob_begin', { size: bytes.length, sha256: hash(bytes) });
  const data = bytes.subarray(0, 128 * 1024).toString('base64');
  await sender.communicationRequest('blob_chunk', { id: object.id, offset: 0, data });
  await f.restart(); sender = await f.make('sender');
  assert.equal((await sender.blobStatus(object.id)).offset, 128 * 1024);
  assert.equal((await sender.communicationRequest('blob_chunk', { id: object.id, offset: 0, data })).offset, 128 * 1024);
  await assert.rejects(sender.communicationRequest('blob_chunk', { id: object.id, offset: 0, data: Buffer.alloc(1024, 0).toString('base64') }), /BLOB_.*CONFLICT/);
  const committed = await sender.uploadFile(source, { id: object.id }); assert.equal(committed.committed, true);
  const receipt = await sender.sendTo({ principal: 'receiver' }, 'later/object', {}, { attachments: [object.id] });
  await f.restart();
  const receiver = await f.make('receiver'); let delivered;
  receiver.on('delivery', (message) => { delivered = message; });
  await receiver.subscribe(['later/object'], { from: 0 }); await until(() => delivered?.seq === receipt.seq);
  let length = 0; const digest = createHash('sha256');
  for await (const block of receiver.readAttachment(receipt.seq, object.id)) { length += block.length; digest.update(block); }
  assert.equal(length, bytes.length); assert.equal(digest.digest('hex'), hash(bytes));
});

test('blob wire: reading/ACK do not free reservations, explicit provider release enables capacity and blocks new references', async (t) => {
  const f = await fixture(t, { blobs: { maxObjectBytes: 1024, maxTotalBytes: 1024, maxObjects: 1 } });
  const sender = await f.make('sender'); const receiver = await f.make('receiver');
  const bytes = Buffer.alloc(1024, 8);
  const object = await sender.uploadStream([bytes], { size: bytes.length, sha256: hash(bytes) });
  let delivered; receiver.on('delivery', (message) => { delivered = message; }); await receiver.subscribe(['read/test'], { from: 0 });
  const receipt = await sender.publishConfirmed('read/test', {}, { attachments: [object.id] });
  await until(() => delivered?.seq === receipt.seq && receiver.cursorOf(['read/test']) === receipt.seq);
  for await (const _ of receiver.readAttachment(receipt.seq, object.id)) { /* deliberate non-destructive read */ }
  await assert.rejects(sender.communicationRequest('blob_begin', { size: 1, sha256: hash(Buffer.from([1])) }), /BLOB_CAPACITY/);
  await sender.releaseBlob(object.id);
  await assert.rejects(sender.publishConfirmed('read/test', {}, { attachments: [object.id] }), /BLOB_RELEASED/);
  await sender.communicationRequest('blob_begin', { size: 1, sha256: hash(Buffer.from([1])) });
  await assert.rejects(receiver.communicationRequest('blob_read', { id: object.id, messageSeq: receipt.seq, offset: 0 }), /BLOB_NOT_FOUND/);
});

test('blob SDK: interrupted download resumes with checksum, existing destination and bad prefix remain untouched', async (t) => {
  const f = await fixture(t); const sender = await f.make('sender'); const receiver = await f.make('receiver');
  const bytes = Buffer.alloc(1024 * 1024 + 5, 42);
  const object = await sender.uploadStream([bytes], { size: bytes.length, sha256: hash(bytes) });
  const receipt = await sender.sendTo({ principal: 'receiver' }, 'download/test', {}, { attachments: [object.id] });
  const destination = join(f.dir, 'resumed.bin'); const partial = `${destination}.${object.id}.partial`;
  await writeFile(partial, bytes.subarray(0, 3333));
  await receiver.downloadFile(receipt.seq, object.id, destination, { resume: true });
  assert.deepEqual(await readFile(destination), bytes);
  await assert.rejects(receiver.downloadFile(receipt.seq, object.id, destination), { code: 'EEXIST' });
  assert.deepEqual(await readFile(destination), bytes);
  const wrong = join(f.dir, 'wrong.bin'); const wrongPartial = `${wrong}.${object.id}.partial`;
  await writeFile(wrongPartial, Buffer.alloc(3333, 99));
  await assert.rejects(receiver.downloadFile(receipt.seq, object.id, wrong, { resume: true }), /checksum/);
  await assert.rejects(stat(wrong), /ENOENT/);
  assert.equal((await stat(wrongPartial)).size, bytes.length, 'partial stays available for program policy after failure');
  await assert.rejects(receiver.downloadFile(receipt.seq, object.id, destination, { resume: true, overwrite: true, partialPath: join(f.dir, '.', 'resumed.bin') }), /must differ/);
  const alias = join(f.dir, 'hardlink.bin'); await link(destination, alias);
  await assert.rejects(receiver.downloadFile(receipt.seq, object.id, destination, { resume: true, overwrite: true, partialPath: alias }), /aliases/);
  assert.deepEqual(await readFile(destination), bytes, 'path aliases cannot append into the existing destination');
});
