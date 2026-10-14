// External mod helpers: files stay in the external program, Hub gets opaque bytes.
import { createReadStream } from 'node:fs';
import { open, stat, lstat, link, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });
const DEFAULT_CHUNK = 256 * 1024;
const validId = (id) => {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw fail('BLOB_ID_INVALID', 'object ID must be a server-issued UUID');
};
const chunkSize = (bridge, requested) => {
  const value = requested ?? bridge.welcome?.blobLimits?.chunkBytes ?? DEFAULT_CHUNK;
  if (!Number.isSafeInteger(value) || value <= 0 || value > (bridge.welcome?.blobLimits?.chunkBytes ?? DEFAULT_CHUNK)) throw fail('BLOB_CHUNK_INVALID', 'chunk size exceeds the Hub limit');
  return value;
};
const request = (bridge, type, fields, opts = {}) => bridge.communicationRequest(type, fields, { timeoutMs: opts.timeoutMs ?? 30_000 });
const verifyInfo = (info, size, sha256) => {
  if (info.size !== size || info.sha256 !== sha256) throw fail('BLOB_RESUME_MISMATCH', 'upload ID belongs to different content');
};
const fileHash = async (path, end) => {
  const hash = createHash('sha256');
  if (end !== 0) for await (const block of createReadStream(path, end === undefined ? {} : { start: 0, end: end - 1 })) hash.update(block);
  return hash;
};

export async function uploadFile(bridge, path, opts = {}) {
  const info = await stat(path);
  if (!info.isFile() || !Number.isSafeInteger(info.size)) throw fail('BLOB_FILE_INVALID', 'upload source must be a regular file of safe size');
  const sha256 = (await fileHash(path)).digest('hex');
  const object = opts.id ? await request(bridge, 'blob_status', { id: opts.id }, opts) : await request(bridge, 'blob_begin', { size: info.size, sha256 }, opts);
  verifyInfo(object, info.size, sha256);
  opts.onProgress?.({ id: object.id, offset: object.offset, size: info.size });
  if (object.committed) return object;
  const size = chunkSize(bridge, opts.chunkBytes);
  const source = object.offset < info.size ? createReadStream(path, { start: object.offset, highWaterMark: size }) : [];
  return uploadStream(bridge, source, { ...opts, id: object.id, size: info.size, sha256, offset: object.offset });
}

/** source must start at offset when resuming; the caller owns stream production. */
export async function uploadStream(bridge, source, opts = {}) {
  const { size, sha256 } = opts;
  const object = opts.id ? await request(bridge, 'blob_status', { id: opts.id }, opts) : await request(bridge, 'blob_begin', { size, sha256 }, opts);
  verifyInfo(object, size, sha256);
  if (object.committed) return object;
  if ((opts.offset ?? 0) !== object.offset) throw fail('BLOB_RESUME_MISMATCH', 'source must begin at the confirmed upload offset');
  let offset = object.offset;
  const max = chunkSize(bridge, opts.chunkBytes);
  opts.onProgress?.({ id: object.id, offset, size });
  // No read-ahead queue: one disk receipt before sending the next block.
  for await (const value of source) {
    if (!(value instanceof Uint8Array)) throw fail('BLOB_SOURCE_INVALID', 'source must yield byte arrays');
    const block = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    for (let at = 0; at < block.length; at += max) {
      const part = block.subarray(at, Math.min(at + max, block.length));
      if (offset + part.length > size) throw fail('BLOB_SIZE_MISMATCH', 'source exceeds its declared size');
      const receipt = await request(bridge, 'blob_chunk', { id: object.id, offset, data: part.toString('base64') }, opts);
      offset += part.length;
      if (receipt.offset !== offset) throw fail('BLOB_OFFSET_INVALID', 'unexpected confirmed offset');
      opts.onProgress?.({ id: object.id, offset, size });
    }
  }
  if (offset !== size) throw fail('BLOB_SIZE_MISMATCH', 'source ended before its declared size');
  return request(bridge, 'blob_commit', { id: object.id }, { timeoutMs: opts.commitTimeoutMs ?? 120_000 });
}

function decodeChunk(frame, expectedOffset) {
  if (frame.offset !== expectedOffset || typeof frame.data !== 'string') throw fail('BLOB_OFFSET_INVALID', 'unexpected object block');
  const bytes = Buffer.from(frame.data, 'base64');
  if (bytes.toString('base64') !== frame.data || frame.bytes !== bytes.length || expectedOffset + bytes.length > frame.size || (!bytes.length && !frame.eof)) throw fail('BLOB_CHUNK_INVALID', 'invalid object block');
  if (frame.eof !== (expectedOffset + bytes.length === frame.size)) throw fail('BLOB_SIZE_MISMATCH', 'invalid object end marker');
  return bytes;
}

/** Full reads verify SHA-256 before successful iterator completion. */
export async function* readAttachment(bridge, messageSeq, id, opts = {}) {
  let offset = opts.offset ?? 0;
  const start = offset;
  const hash = createHash('sha256');
  let expected;
  for (;;) {
    const frame = await request(bridge, 'blob_read', { messageSeq, id, offset, length: chunkSize(bridge, opts.chunkBytes) }, opts);
    if (!expected) expected = { size: frame.size, sha256: frame.sha256 };
    else if (frame.size !== expected.size || frame.sha256 !== expected.sha256) throw fail('BLOB_CONTENT_CHANGED', 'object descriptor changed during reading');
    const block = decodeChunk(frame, offset);
    hash.update(block); offset += block.length;
    if (block.length) yield block;
    if (frame.eof) {
      if (start === 0 && hash.digest('hex') !== expected.sha256) throw fail('BLOB_HASH_MISMATCH', 'download checksum does not match');
      return;
    }
  }
}

/** Keep the partial file on failure. resume:true reuses it and verifies its prefix. */
export async function downloadFile(bridge, messageSeq, id, path, opts = {}) {
  validId(id);
  path = resolve(path);
  const partial = resolve(opts.partialPath ?? `${path}.${id}.partial`);
  const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (pathKey(partial) === pathKey(path)) throw fail('BLOB_FILE_INVALID', 'partial and destination paths must differ');
  let destination;
  try { destination = await stat(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (destination && !opts.overwrite) throw fail('EEXIST', 'download destination already exists');
  let previous;
  try {
    previous = await lstat(partial);
    if (!previous.isFile() || previous.isSymbolicLink()) throw fail('BLOB_FILE_INVALID', 'partial path must be a regular file without a symbolic link');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(partial, previous && opts.resume ? 'r+' : 'wx');
  const hash = createHash('sha256');
  let offset = 0;
  let expected;
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || (previous && (actual.dev !== previous.dev || actual.ino !== previous.ino)) ||
        (destination && actual.dev === destination.dev && actual.ino === destination.ino)) throw fail('BLOB_FILE_INVALID', 'partial file aliases the destination or changed before opening');
    offset = actual.size;
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < offset;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, offset - position), position);
      if (!bytesRead) throw fail('BLOB_FILE_INVALID', 'partial file shortened while checking its prefix');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    for (;;) {
      const frame = await request(bridge, 'blob_read', { messageSeq, id, offset, length: chunkSize(bridge, opts.chunkBytes) }, opts);
      if (!expected) expected = { size: frame.size, sha256: frame.sha256 };
      else if (frame.size !== expected.size || frame.sha256 !== expected.sha256) throw fail('BLOB_CONTENT_CHANGED', 'object descriptor changed during reading');
      const block = decodeChunk(frame, offset);
      for (let written = 0; written < block.length;) {
        const result = await handle.write(block, written, block.length - written, offset + written);
        if (!result.bytesWritten) throw fail('BLOB_WRITE_FAILED', 'download destination made no progress');
        written += result.bytesWritten;
      }
      hash.update(block); offset += block.length;
      opts.onProgress?.({ id, offset, size: frame.size });
      if (frame.eof) break;
    }
    if (hash.digest('hex') !== expected.sha256) throw fail('BLOB_HASH_MISMATCH', 'download checksum does not match');
    await handle.sync();
  } finally { await handle.close(); }
  if (opts.overwrite) await rename(partial, path);
  else { await link(partial, path); await unlink(partial); } // atomically refuse to replace an existing file
  return { id, ...expected, path };
}
