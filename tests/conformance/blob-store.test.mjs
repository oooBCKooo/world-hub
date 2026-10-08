import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, rmdir, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BlobStore } from '../../src/hub/lib/blob-store.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = bytes => Buffer.from(bytes).toString('base64');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-blob-regression-'));
  const config = { dir: join(root, 'blobs'), maxObjectBytes: 256, maxTotalBytes: 1024, maxObjects: 8, chunkBytes: 8, ...options };
  const store = new BlobStore(config); await store.open();
  t.after(async () => {
    await store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('hub-blob-regression-'));
    await rm(target, { recursive: true, force: true });
  });
  return { root, config, store, path: id => join(config.dir, `${id}.bin`) };
}
async function put(store, bytes, owner = 'provider') {
  const buffer = Buffer.from(bytes), blob = await store.begin(owner, { size: buffer.length, sha256: digest(buffer) });
  for (let offset = 0; offset < buffer.length; offset += store.chunkBytes) {
    await store.write(blob.id, owner, { offset, data: buffer.subarray(offset, offset + store.chunkBytes).toString('base64') });
  }
  return store.commit(blob.id, owner);
}

async function largeHelper() {
  const root = await mkdtemp(join(tmpdir(), 'hub-blob-regression-large-'));
  const chunkBytes = 256 * 1024, size = 100 * 1024 * 1024;
  const store = new BlobStore({ dir: join(root, 'blobs'), chunkBytes, maxTotalBytes: size, maxObjectBytes: size });
  const block = Buffer.alloc(chunkBytes, 0xa5);
  const expected = createHash('sha256');
  for (let offset = 0; offset < size; offset += chunkBytes) expected.update(block);
  const sha256 = expected.digest('hex');
  let maxRss = 0, maxExternal = 0;
  const sample = () => {
    global.gc(); const memory = process.memoryUsage();
    maxRss = Math.max(maxRss, memory.rss); maxExternal = Math.max(maxExternal, memory.external);
  };
  try {
    await store.open(); sample(); const baselineRss = process.memoryUsage().rss;
    const blob = await store.begin('provider', { size, sha256 });
    for (let offset = 0; offset < size; offset += chunkBytes) {
      await store.write(blob.id, 'provider', { offset, data: block.toString('base64') });
      if (offset % (8 * 1024 * 1024) === 0) sample();
    }
    await store.commit(blob.id, 'provider'); sample();
    const actual = createHash('sha256');
    for (let offset = 0; offset < size; offset += chunkBytes) {
      const part = await store.read(blob.id, { offset }); actual.update(Buffer.from(part.data, 'base64'));
      if (offset % (8 * 1024 * 1024) === 0) sample();
    }
    assert.equal(actual.digest('hex'), sha256); sample();
    assert.equal((await stat(join(root, 'blobs', `${blob.id}.bin`))).size, size);
    console.log(JSON.stringify({ size, chunkBytes, baselineRss, maxRss, maxExternal, sha256 }));
  } finally {
    await store.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('hub-blob-regression-large-'));
    await rm(target, { recursive: true, force: true });
  }
}

if (process.argv.includes('--large-helper')) {
  await largeHelper();
} else {
  test('blob: immutable opaque bytes round trip through bounded disk reads', async t => {
    const { store, path, config } = await fixture(t);
    const bytes = Buffer.from([0, 0xff, 0xc0, 0x80, ...Buffer.from('世界'), 13, 10]);
    const blob = await put(store, bytes);
    assert.equal(blob.committed, true); assert.equal(blob.offset, bytes.length);
    const pieces = [];
    for (let offset = 0; offset < blob.size; offset += store.chunkBytes) {
      const part = await store.read(blob.id, { offset });
      assert.ok(part.bytes <= store.chunkBytes); pieces.push(Buffer.from(part.data, 'base64'));
    }
    assert.deepEqual(Buffer.concat(pieces), bytes); assert.deepEqual(await readFile(path(blob.id)), bytes);
    const metadata = JSON.parse(await readFile(join(config.dir, 'objects.json'), 'utf8'));
    assert.deepEqual(Object.keys(metadata.objects[0]).sort(), ['committed', 'id', 'offset', 'owner', 'released', 'sha256', 'size']);
    assert.equal(store.snapshot().protectedCount, 1);
    await assert.rejects(store.write(blob.id, 'provider', { offset: 0, data: encode('x') }), { code: 'BLOB_COMMITTED' });
  });

  test('blob: zero byte objects commit and return an empty EOF chunk', async t => {
    const { store } = await fixture(t); const blob = await put(store, '');
    assert.deepEqual(await store.read(blob.id), { id: blob.id, offset: 0, data: '', bytes: 0, eof: true });
    assert.deepEqual(await store.commit(blob.id, 'provider'), blob);
  });

  test('blob: partial input is protected and not readable before verified commit', async t => {
    const { store } = await fixture(t);
    const blob = await store.begin('provider', { size: 4, sha256: digest('abcd') });
    await store.write(blob.id, 'provider', { offset: 0, data: encode('ab') });
    await assert.rejects(store.read(blob.id), { code: 'BLOB_NOT_COMMITTED' });
    await assert.rejects(store.commit(blob.id, 'provider'), { code: 'BLOB_INCOMPLETE' });
    assert.equal((await store.status(blob.id, 'provider')).released, false);
  });

  test('blob: sequential offsets and byte-identical retries do not duplicate data', async t => {
    const { store, path } = await fixture(t);
    const blob = await store.begin('provider', { size: 6, sha256: digest('abcdef') });
    await store.write(blob.id, 'provider', { offset: 0, data: encode('abc') });
    assert.equal((await store.write(blob.id, 'provider', { offset: 0, data: encode('abc') })).offset, 3);
    assert.equal((await store.write(blob.id, 'provider', { offset: 1, data: encode('bc') })).offset, 3);
    await assert.rejects(store.write(blob.id, 'provider', { offset: 0, data: encode('xyz') }), { code: 'BLOB_CHUNK_CONFLICT' });
    await assert.rejects(store.write(blob.id, 'provider', { offset: 1, data: encode('bcde') }), { code: 'BLOB_OFFSET_INVALID' });
    await assert.rejects(store.write(blob.id, 'provider', { offset: 4, data: encode('e') }), { code: 'BLOB_OFFSET_INVALID' });
    await assert.rejects(store.write(blob.id, 'provider', { offset: 3, data: encode('defg') }), { code: 'BLOB_OFFSET_INVALID' });
    await store.write(blob.id, 'provider', { offset: 3, data: encode('def') }); await store.commit(blob.id, 'provider');
    assert.equal((await readFile(path(blob.id))).toString(), 'abcdef');
  });

  test('blob: chunks require canonical base64 and bounded decoded bytes', async t => {
    const { store } = await fixture(t);
    const blob = await store.begin('provider', { size: 32, sha256: digest('unused') });
    for (const data of ['', 'YQ', 'YQ==\n', 'YR==', 'YQ__', encode('123456789')]) {
      await assert.rejects(store.write(blob.id, 'provider', { offset: 0, data }), { code: 'BLOB_CHUNK_INVALID' });
    }
    assert.equal((await store.status(blob.id, 'provider')).offset, 0);
  });

  test('blob: read ranges cannot enlarge the per-chunk allocation', async t => {
    const { store } = await fixture(t); const blob = await put(store, 'abc');
    for (const options of [{ length: 9 }, { length: 0 }, { length: Infinity }, { offset: -1 }, { offset: 4 }, { offset: 0.5 }]) {
      await assert.rejects(store.read(blob.id, options), { code: 'BLOB_READ_INVALID' });
    }
    assert.equal((await store.read(blob.id, { offset: 3 })).eof, true);
  });

  test('blob: stable provider identity controls status, writes, commit and release', async t => {
    const { store } = await fixture(t);
    const blob = await store.begin('fleet', { size: 1, sha256: digest('a') });
    for (const action of [() => store.status(blob.id, 'other'), () => store.write(blob.id, 'other', { offset: 0, data: encode('a') }),
      () => store.commit(blob.id, 'other'), () => store.release(blob.id, 'other')]) await assert.rejects(action(), { code: 'BLOB_OWNER_DENIED' });
    await store.write(blob.id, 'fleet', { offset: 0, data: encode('a') });
    const view = store.get(blob.id); view.owner = 'other';
    assert.equal(store.get(blob.id).owner, 'fleet');
  });

  test('blob: path traversal and fabricated object IDs are rejected', async t => {
    const { store } = await fixture(t);
    for (const id of ['../objects.json', 'C:\\system', '/tmp/x', '00000000-0000-0000-0000-000000000000', null]) {
      assert.throws(() => store.get(id), { code: 'BLOB_ID_INVALID' });
      await assert.rejects(store.read(id), { code: 'BLOB_ID_INVALID' });
    }
    assert.throws(() => store.get('11111111-1111-4111-8111-111111111111'), { code: 'BLOB_NOT_FOUND' });
  });

  test('blob: invalid size/hash/config input never reserves capacity', async t => {
    const { store } = await fixture(t);
    for (const size of [-1, 0.5, Infinity, 257]) await assert.rejects(store.begin('provider', { size, sha256: digest('') }), { code: 'BLOB_SIZE_INVALID' });
    for (const sha256 of ['x', digest('').toUpperCase(), null]) await assert.rejects(store.begin('provider', { size: 0, sha256 }), { code: 'BLOB_HASH_INVALID' });
    await assert.rejects(store.begin('', { size: 0, sha256: digest('') }), { code: 'BLOB_OWNER_INVALID' });
    for (const key of ['maxObjectBytes', 'maxTotalBytes', 'maxObjects', 'chunkBytes']) assert.throws(() => new BlobStore({ [key]: 0 }), /positive safe integer/);
    assert.equal(store.snapshot().count, 0);
  });

  test('blob: declared sizes reserve global capacity before concurrent uploads', async t => {
    const { store } = await fixture(t, { maxTotalBytes: 10 });
    const results = await Promise.allSettled([store.begin('a', { size: 6, sha256: digest('abcdef') }), store.begin('b', { size: 6, sha256: digest('abcdef') })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BLOB_CAPACITY');
    assert.equal(store.snapshot().reservedBytes, 6); assert.equal(store.snapshot().writtenBytes, 0);
  });

  test('blob: zero-byte and partial objects still count toward object capacity', async t => {
    const { store } = await fixture(t, { maxObjects: 1 }); await put(store, '');
    await assert.rejects(store.begin('provider', { size: 0, sha256: digest('') }), { code: 'BLOB_CAPACITY' });
  });

  test('blob: reads and release preserve bytes until explicit permission permits capacity cleanup', async t => {
    const { store, path } = await fixture(t, { maxTotalBytes: 8 });
    const a = await put(store, 'abcd', 'a'), b = await put(store, 'efgh', 'b');
    await store.read(a.id); await store.read(b.id);
    await assert.rejects(store.begin('c', { size: 4, sha256: digest('ijkl') }), { code: 'BLOB_CAPACITY' });
    const released = await store.release(a.id, 'a'); assert.equal(released.released, true);
    assert.equal((await stat(path(a.id))).size, 4); assert.equal((await store.read(a.id)).data, encode('abcd'));
    const c = await store.begin('c', { size: 4, sha256: digest('ijkl') });
    assert.throws(() => store.get(a.id), { code: 'BLOB_NOT_FOUND' });
    await assert.rejects(stat(path(a.id)), { code: 'ENOENT' });
    assert.equal(store.get(b.id).released, false); assert.equal(store.get(c.id).released, false);
  });

  test('blob: owner may release partial reservations but released uploads cannot grow', async t => {
    const { store } = await fixture(t, { maxObjects: 1 });
    const a = await store.begin('provider', { size: 6, sha256: digest('abcdef') });
    await store.write(a.id, 'provider', { offset: 0, data: encode('ab') });
    await store.release(a.id, 'provider');
    await assert.rejects(store.write(a.id, 'provider', { offset: 2, data: encode('cd') }), { code: 'BLOB_RELEASED' });
    await assert.rejects(store.commit(a.id, 'provider'), { code: 'BLOB_RELEASED' });
    await store.begin('provider', { size: 0, sha256: digest('') });
    assert.throws(() => store.get(a.id), { code: 'BLOB_NOT_FOUND' });
  });

  test('blob: wrong final hash is rejected without releasing accepted input', async t => {
    const { store } = await fixture(t);
    const blob = await store.begin('provider', { size: 3, sha256: digest('xyz') });
    await store.write(blob.id, 'provider', { offset: 0, data: encode('abc') });
    await assert.rejects(store.commit(blob.id, 'provider'), { code: 'BLOB_HASH_MISMATCH' });
    assert.equal(store.get(blob.id).released, false); assert.equal(store.get(blob.id).committed, false);
  });

  test('blob: restart resumes confirmed offset and truncates only an unconfirmed tail', async t => {
    const { store, config, path } = await fixture(t);
    const blob = await store.begin('fleet', { size: 6, sha256: digest('abcdef') });
    await store.write(blob.id, 'fleet', { offset: 0, data: encode('abc') }); await store.close();
    await appendFile(path(blob.id), 'unconfirmed');
    const recovered = new BlobStore(config); await recovered.open(); t.after(() => recovered.close());
    assert.equal((await recovered.status(blob.id, 'fleet')).offset, 3); assert.equal((await stat(path(blob.id))).size, 3);
    await recovered.write(blob.id, 'fleet', { offset: 3, data: encode('def') }); await recovered.commit(blob.id, 'fleet');
    assert.equal((await recovered.read(blob.id)).data, encode('abcdef'));
  });

  test('blob: committed and released metadata survives restart and keeps bytes readable', async t => {
    const { store, config } = await fixture(t); const blob = await put(store, 'persist');
    await store.release(blob.id, 'provider'); await store.close();
    const recovered = new BlobStore(config); await recovered.open(); t.after(() => recovered.close());
    assert.equal(recovered.get(blob.id).released, true); assert.equal(recovered.get(blob.id).committed, true);
    assert.equal((await recovered.read(blob.id)).data, encode('persist'));
    assert.equal((await recovered.release(blob.id, 'provider')).released, true);
  });

  test('blob: damaged metadata or missing confirmed files fails startup closed', async t => {
    for (const damage of ['invalid-json', 'missing-index', 'duplicate-id', 'coerced-id', 'coerced-hash', 'short-file', 'missing-file', 'extra-committed']) {
      await t.test(damage, async t => {
        const { store, config, path } = await fixture(t); const blob = await put(store, 'abc'); await store.close();
        const index = join(config.dir, 'objects.json');
        if (damage === 'invalid-json') await writeFile(index, '{broken');
        if (damage === 'missing-index') await unlink(index);
        if (damage === 'duplicate-id') await writeFile(index, JSON.stringify({ version: 1, objects: [{ ...blob }, { ...blob }] }));
        if (damage === 'coerced-id') await writeFile(index, JSON.stringify({ version: 1, objects: [{ ...blob, id: [blob.id] }] }));
        if (damage === 'coerced-hash') await writeFile(index, JSON.stringify({ version: 1, objects: [{ ...blob, sha256: [blob.sha256] }] }));
        if (damage === 'short-file') await truncate(path(blob.id), 1);
        if (damage === 'missing-file') await unlink(path(blob.id));
        if (damage === 'extra-committed') await appendFile(path(blob.id), 'x');
        await assert.rejects(new BlobStore(config).open(), { code: 'BLOB_STORE_CORRUPT' });
      });
    }
  });

  test('blob: interrupted begin and released cleanup transactions recover safely', async t => {
    const { store, config, path } = await fixture(t);
    const pending = await store.begin('provider', { size: 3, sha256: digest('abc') });
    const released = await put(store, 'xyz'); await store.release(released.id, 'provider'); await store.close();
    await rename(path(pending.id), join(config.dir, `${pending.id}.new`));
    await rename(path(released.id), join(config.dir, `${released.id}.gc`));
    const recovered = new BlobStore(config); await recovered.open(); t.after(() => recovered.close());
    assert.equal((await stat(path(pending.id))).size, 0); assert.equal((await recovered.read(released.id)).data, encode('xyz'));
  });

  test('blob: metadata write failure rolls file back and permits safe retry', async t => {
    const { store, config, path } = await fixture(t);
    const blob = await store.begin('provider', { size: 3, sha256: digest('abc') });
    const index = join(config.dir, 'objects.json'), backup = join(config.dir, 'objects.saved');
    await rename(index, backup); await mkdir(index);
    await assert.rejects(store.write(blob.id, 'provider', { offset: 0, data: encode('abc') }));
    assert.equal(store.get(blob.id).offset, 0); assert.equal((await stat(path(blob.id))).size, 0);
    await rmdir(index); await rename(backup, index);
    await store.write(blob.id, 'provider', { offset: 0, data: encode('abc') }); await store.commit(blob.id, 'provider');
    assert.equal((await store.read(blob.id)).data, encode('abc'));
  });

  test('blob: failed release persistence does not authorize later capacity cleanup', async t => {
    const { store, config } = await fixture(t, { maxObjects: 1 }); const blob = await put(store, 'abc');
    const index = join(config.dir, 'objects.json'), backup = join(config.dir, 'objects.saved');
    await rename(index, backup); await mkdir(index);
    await assert.rejects(store.release(blob.id, 'provider'));
    assert.equal(store.get(blob.id).released, false);
    await rmdir(index); await rename(backup, index);
    await assert.rejects(store.begin('provider', { size: 0, sha256: digest('') }), { code: 'BLOB_CAPACITY' });
    assert.equal((await store.read(blob.id)).data, encode('abc'));
  });

  test('blob: failed cleanup metadata write restores the explicitly released file', async t => {
    const { store, config, path } = await fixture(t, { maxObjects: 1 }); const blob = await put(store, 'abc');
    await store.release(blob.id, 'provider');
    const index = join(config.dir, 'objects.json'), backup = join(config.dir, 'objects.saved');
    await rename(index, backup); await mkdir(index);
    await assert.rejects(store.begin('provider', { size: 0, sha256: digest('') }));
    assert.equal(store.get(blob.id).released, true); assert.equal((await stat(path(blob.id))).size, 3);
    await rmdir(index); await rename(backup, index);
    await store.begin('provider', { size: 0, sha256: digest('') });
    assert.throws(() => store.get(blob.id), { code: 'BLOB_NOT_FOUND' });
  });

  test('blob: append pins prevent release/reclaim races until all append leases end', async t => {
    const { store, path } = await fixture(t, { maxObjects: 1 }); const blob = await put(store, 'abc');
    const first = await store.pinAttachments('provider', [blob.id]);
    const second = await store.pinAttachments('provider', [blob.id]);
    assert.deepEqual(first.attachments, [{ id: blob.id, size: 3, sha256: digest('abc') }]);
    const results = await Promise.allSettled([
      store.release(blob.id, 'provider'), store.begin('provider', { size: 0, sha256: digest('') }),
    ]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'BLOB_CAPACITY');
    assert.equal(store.get(blob.id).released, true); assert.equal((await stat(path(blob.id))).size, 3);
    first.release(); first.release();
    await assert.rejects(store.begin('provider', { size: 0, sha256: digest('') }), { code: 'BLOB_CAPACITY' });
    second.release(); second.release();
    assert.equal(store.snapshot().pinnedCount, 0);
    await store.begin('provider', { size: 0, sha256: digest('') });
    assert.throws(() => store.get(blob.id), { code: 'BLOB_NOT_FOUND' });
  });

  test('blob: attachment batch checks are atomic and reject foreign, partial and released objects', async t => {
    const { store } = await fixture(t);
    const own = await put(store, 'abc'), foreign = await put(store, 'xyz', 'other');
    const partial = await store.begin('provider', { size: 1, sha256: digest('a') });
    await assert.rejects(store.pinAttachments('provider', [own.id, foreign.id]), { code: 'BLOB_OWNER_DENIED' });
    await assert.rejects(store.pinAttachments('provider', [own.id, partial.id]), { code: 'BLOB_NOT_COMMITTED' });
    await assert.rejects(store.pinAttachments('provider', [own.id, own.id]), { code: 'BLOB_ATTACHMENTS_INVALID' });
    assert.equal(store.snapshot().pinnedCount, 0);
    await store.release(own.id, 'provider');
    await assert.rejects(store.pinAttachments('provider', [own.id]), { code: 'BLOB_RELEASED' });
    assert.equal(store.snapshot().pinnedCount, 0);
  });

  test('blob: 100 MiB disk transfer verifies SHA-256 with bounded process memory', async () => {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--expose-gc', '--max-old-space-size=48', fileURLToPath(import.meta.url), '--large-helper'],
      { timeout: 45000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.size, 100 * 1024 * 1024); assert.equal(result.chunkBytes, 256 * 1024);
    // Node external-memory accounting can retain the previous GC interval's
    // freed chunk buffers. Both allowances remain far below the 100 MiB file.
    assert.ok(result.maxExternal < 32 * 1024 * 1024, JSON.stringify(result));
    assert.ok(result.maxRss - result.baselineRss < 64 * 1024 * 1024, JSON.stringify(result));
  });
}
