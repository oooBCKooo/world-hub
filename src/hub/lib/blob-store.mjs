// Opaque communication bytes, retained on disk until their provider permits
// capacity cleanup. This store never interprets file contents or consumer ACKs.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, truncate, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DEFAULT_BLOBS = {
  dir: './.hub/blobs', maxObjectBytes: 1024 ** 3, maxTotalBytes: 2 * 1024 ** 3,
  maxObjects: 128, chunkBytes: 256 * 1024,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const problem = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const copy = object => ({ ...object });

export class BlobStore {
  #config; #objects = new Map(); #ready = false; #operations = Promise.resolve(); #pendingGarbage = new Set(); #pins = new Map();
  constructor(config = {}) {
    this.#config = { ...DEFAULT_BLOBS, ...config };
    if (typeof this.#config.dir !== 'string' || !this.#config.dir) throw new Error('blobs.dir must be a nonempty string');
    this.#config.dir = resolve(this.#config.dir);
    for (const key of ['maxObjectBytes', 'maxTotalBytes', 'maxObjects', 'chunkBytes']) {
      if (!Number.isSafeInteger(this.#config[key]) || this.#config[key] <= 0) throw new Error(`blobs.${key} must be a positive safe integer`);
    }
  }
  get dir() { return this.#config.dir; }
  get chunkBytes() { return this.#config.chunkBytes; }
  #enqueue(operation) {
    const task = this.#operations.then(operation);
    this.#operations = task.catch(() => {});
    return task;
  }
  #path(id, suffix = 'bin') { return join(this.dir, `${id}.${suffix}`); }
  #used(objects = this.#objects) { return [...objects.values()].reduce((sum, object) => sum + BigInt(object.size), 0n); }
  #capacity(objects, size) {
    return objects.size >= this.#config.maxObjects || this.#used(objects) + BigInt(size) > BigInt(this.#config.maxTotalBytes);
  }
  #require(id) {
    if (!this.#ready) throw problem('BLOB_STORE_CLOSED', 'blob store is not open');
    if (typeof id !== 'string' || !UUID.test(id)) throw problem('BLOB_ID_INVALID', 'blob id must be a server-issued UUID');
    const object = this.#objects.get(id);
    if (!object) throw problem('BLOB_NOT_FOUND', 'blob is not retained');
    return object;
  }
  #owned(id, owner) {
    const object = this.#require(id);
    if (object.owner !== owner) throw problem('BLOB_OWNER_DENIED', 'blob belongs to another provider');
    return object;
  }
  #validateMetadata(object) {
    if (!object || typeof object !== 'object' || typeof object.id !== 'string' || !UUID.test(object.id) ||
      typeof object.owner !== 'string' || !object.owner || object.owner.length > 128 ||
      !Number.isSafeInteger(object.size) || object.size < 0 || typeof object.sha256 !== 'string' || !HASH.test(object.sha256) ||
      !Number.isSafeInteger(object.offset) || object.offset < 0 || object.offset > object.size ||
      typeof object.committed !== 'boolean' || typeof object.released !== 'boolean' ||
      (object.committed && object.offset !== object.size)) {
      throw problem('BLOB_STORE_CORRUPT', 'blob metadata has an invalid schema');
    }
    return { id: object.id, owner: object.owner, size: object.size, sha256: object.sha256,
      offset: object.offset, committed: object.committed, released: object.released };
  }
  async #save(objects) {
    const temporary = join(this.dir, `objects.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(JSON.stringify({ version: 1, objects: [...objects.values()] }));
      await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, join(this.dir, 'objects.json'));
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  async #regular(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw problem('BLOB_STORE_CORRUPT', 'blob storage entry is not a regular file');
    return info;
  }
  async #exists(path) {
    try { await this.#regular(path); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  open() {
    return this.#enqueue(async () => {
      if (this.#ready) return;
      await mkdir(this.dir, { recursive: true });
      const names = await readdir(this.dir);
      let manifest;
      try {
        await this.#regular(join(this.dir, 'objects.json'));
        manifest = JSON.parse(await readFile(join(this.dir, 'objects.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT' && !names.some(name => /^[0-9a-f-]+\.(bin|gc)$/.test(name))) manifest = { version: 1, objects: [] };
        else throw problem('BLOB_STORE_CORRUPT', 'blob metadata is missing or unreadable', error);
      }
      if (manifest?.version !== 1 || !Array.isArray(manifest.objects)) throw problem('BLOB_STORE_CORRUPT', 'blob metadata has an invalid schema');
      const restored = new Map();
      for (const entry of manifest.objects) {
        const object = this.#validateMetadata(entry);
        if (restored.has(object.id)) throw problem('BLOB_STORE_CORRUPT', 'duplicate blob metadata id');
        restored.set(object.id, object);
      }
      for (const object of restored.values()) {
        const path = this.#path(object.id);
        if (!await this.#exists(path)) {
          // A crash during begin/cleanup can leave a named transaction file.
          const recovery = object.released ? this.#path(object.id, 'gc') :
            (!object.committed && object.offset === 0 ? this.#path(object.id, 'new') : null);
          if (!recovery || !await this.#exists(recovery)) throw problem('BLOB_STORE_CORRUPT', 'acknowledged blob bytes are missing');
          await rename(recovery, path);
        }
        const info = await this.#regular(path);
        if (info.size < object.offset || (object.committed && info.size !== object.size)) throw problem('BLOB_STORE_CORRUPT', 'blob file is shorter than its confirmed offset or has an invalid committed size');
        if (!object.committed && info.size > object.offset) await truncate(path, object.offset);
      }
      for (const name of names) {
        const match = name.match(/^([0-9a-f-]+)\.(bin|new|gc)$/);
        if (!match) continue;
        if (!UUID.test(match[1])) throw problem('BLOB_STORE_CORRUPT', 'invalid blob storage filename');
        if (restored.has(match[1])) continue;
        if (match[2] === 'bin') throw problem('BLOB_STORE_CORRUPT', 'retained blob bytes have no metadata');
        // .new is an unaccepted begin; .gc was explicitly released before the
        // index removed it. No protected object is eligible for this cleanup.
        await this.#regular(join(this.dir, name));
        await unlink(join(this.dir, name));
      }
      this.#objects = restored;
      await this.#save(restored);
      this.#ready = true;
    });
  }
  get(id) { return copy(this.#require(id)); }
  status(id, owner) { return this.#enqueue(() => copy(this.#owned(id, owner))); }
  /** Short-lived append lease, not consumer retention policy. Validate the
   * entire batch before pinning so failure cannot reserve only part of it. */
  pinAttachments(owner, ids) {
    return this.#enqueue(() => {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 16 || new Set(ids).size !== ids.length) {
        throw problem('BLOB_ATTACHMENTS_INVALID', 'attachments must contain 1 to 16 distinct blob ids');
      }
      const objects = ids.map(id => {
        const object = this.#owned(id, owner);
        if (!object.committed) throw problem('BLOB_NOT_COMMITTED', 'attachment upload is not complete');
        if (object.released) throw problem('BLOB_RELEASED', 'released blobs cannot be attached to a new message');
        return object;
      });
      const pins = this.#pins;
      for (const id of ids) pins.set(id, (pins.get(id) ?? 0) + 1);
      let released = false;
      return { attachments: objects.map(({ id, size, sha256 }) => ({ id, size, sha256 })),
        release() {
          if (released) return;
          released = true;
          for (const id of ids) {
            const count = (pins.get(id) ?? 0) - 1;
            if (count > 0) pins.set(id, count); else pins.delete(id);
          }
        } };
    });
  }
  snapshot() {
    const objects = [...this.#objects.values()];
    const reserved = this.#used();
    const remaining = BigInt(this.#config.maxTotalBytes) - reserved;
    const released = objects.filter(object => object.released);
    // A pin is only the short append transaction lease. It can temporarily
    // exclude an explicitly released object from capacity reclamation; it does
    // not protect consumer work or change the provider's release policy.
    const reclaimable = released.filter(object => !this.#pins.has(object.id));
    const sumBytes = collection => collection.reduce((sum, object) => sum + BigInt(object.size), 0n).toString();
    return { dir: this.dir, count: objects.length, reservedBytes: Number(reserved),
      reservedBytesExact: reserved.toString(),
      remainingBytes: (remaining > 0n ? remaining : 0n).toString(),
      remainingObjectSlots: Math.max(0, this.#config.maxObjects - objects.length),
      releasedBytes: sumBytes(released),
      reclaimableBytes: sumBytes(reclaimable),
      reclaimableObjectCount: reclaimable.length,
      writtenBytes: objects.reduce((sum, object) => sum + object.offset, 0),
      protectedCount: objects.filter(object => !object.released).length,
      releasedCount: objects.filter(object => object.released).length,
      uploadingCount: objects.filter(object => !object.committed).length,
      pinnedCount: this.#pins.size,
      limits: { ...this.#config, dir: undefined } };
  }
  async #reclaim(size) {
    for (const id of this.#pendingGarbage) {
      await unlink(this.#path(id, 'gc'));
      this.#pendingGarbage.delete(id);
    }
    for (const object of this.#objects.values()) {
      if (!this.#capacity(this.#objects, size)) break;
      if (!object.released || this.#pins.has(object.id)) continue;
      const path = this.#path(object.id), tomb = this.#path(object.id, 'gc');
      await rename(path, tomb);
      const next = new Map(this.#objects); next.delete(object.id);
      try { await this.#save(next); }
      catch (error) { await rename(tomb, path).catch(() => {}); throw error; }
      this.#objects = next;
      this.#pendingGarbage.add(object.id);
      await unlink(tomb); // Report failed physical cleanup rather than over-accept.
      this.#pendingGarbage.delete(object.id);
    }
  }
  begin(owner, { size, sha256 } = {}) {
    return this.#enqueue(async () => {
      if (!this.#ready) throw problem('BLOB_STORE_CLOSED', 'blob store is not open');
      if (typeof owner !== 'string' || !owner || owner.length > 128) throw problem('BLOB_OWNER_INVALID', 'provider identity is invalid');
      if (!Number.isSafeInteger(size) || size < 0 || size > this.#config.maxObjectBytes) throw problem('BLOB_SIZE_INVALID', 'blob size exceeds the object limit or is invalid');
      if (typeof sha256 !== 'string' || !HASH.test(sha256)) throw problem('BLOB_HASH_INVALID', 'sha256 must be 64 lowercase hexadecimal characters');
      if (size > this.#config.maxTotalBytes) throw problem('BLOB_CAPACITY', 'blob exceeds total storage capacity');
      await this.#reclaim(size);
      if (this.#capacity(this.#objects, size)) throw problem('BLOB_CAPACITY', 'blob storage capacity contains provider-protected objects');
      const object = { id: randomUUID(), owner, size, sha256, offset: 0, committed: false, released: false };
      const temporary = this.#path(object.id, 'new'), path = this.#path(object.id);
      const handle = await open(temporary, 'wx');
      try { await handle.sync(); } finally { await handle.close(); }
      const next = new Map(this.#objects); next.set(object.id, object);
      try { await this.#save(next); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      this.#objects = next;
      await rename(temporary, path);
      return copy(object);
    });
  }
  write(id, owner, { offset, data } = {}) {
    return this.#enqueue(async () => {
      const object = this.#owned(id, owner);
      if (object.committed) throw problem('BLOB_COMMITTED', 'completed blobs are immutable');
      if (object.released) throw problem('BLOB_RELEASED', 'released uploads cannot accept more bytes');
      if (!Number.isSafeInteger(offset) || offset < 0) throw problem('BLOB_OFFSET_INVALID', 'offset must be a nonnegative safe integer');
      if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || data.length > Math.ceil(this.chunkBytes / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw problem('BLOB_CHUNK_INVALID', 'data must be canonical base64 within the chunk limit');
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length > this.chunkBytes || buffer.toString('base64') !== data) throw problem('BLOB_CHUNK_INVALID', 'data must be canonical base64 within the chunk limit');
      if (offset > object.offset || buffer.length > object.size - offset) throw problem('BLOB_OFFSET_INVALID', 'chunk is outside the sequential upload range');
      const handle = await open(this.#path(id), 'r+');
      try {
        if (offset < object.offset) {
          if (buffer.length > object.offset - offset) throw problem('BLOB_OFFSET_INVALID', 'retry overlaps the unconfirmed upload range');
          const stored = Buffer.alloc(buffer.length);
          let received = 0;
          while (received < stored.length) {
            const part = await handle.read(stored, received, stored.length - received, offset + received);
            if (part.bytesRead === 0) throw problem('BLOB_STORE_CORRUPT', 'confirmed blob bytes are missing');
            received += part.bytesRead;
          }
          if (!buffer.equals(stored)) throw problem('BLOB_CHUNK_CONFLICT', 'retry differs from the confirmed bytes');
          return copy(object);
        }
        let written = 0;
        try {
          while (written < buffer.length) {
            const part = await handle.write(buffer, written, buffer.length - written, offset + written);
            if (part.bytesWritten === 0) throw problem('BLOB_WRITE_FAILED', 'blob write made no progress');
            written += part.bytesWritten;
          }
          await handle.sync();
          const updated = { ...object, offset: offset + buffer.length };
          const next = new Map(this.#objects); next.set(id, updated);
          await this.#save(next); this.#objects = next;
          return copy(updated);
        } catch (error) {
          await handle.truncate(object.offset).catch(() => {});
          throw error;
        }
      } finally { await handle.close(); }
    });
  }
  commit(id, owner) {
    return this.#enqueue(async () => {
      const object = this.#owned(id, owner);
      if (object.committed) return copy(object);
      if (object.released) throw problem('BLOB_RELEASED', 'released uploads cannot be committed');
      if (object.offset !== object.size) throw problem('BLOB_INCOMPLETE', 'blob has unconfirmed bytes');
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of createReadStream(this.#path(id), { highWaterMark: this.chunkBytes })) { hash.update(chunk); bytes += chunk.length; }
      if (bytes !== object.size || hash.digest('hex') !== object.sha256) throw problem('BLOB_HASH_MISMATCH', 'blob bytes do not match the declared size and sha256');
      const updated = { ...object, committed: true }, next = new Map(this.#objects); next.set(id, updated);
      await this.#save(next); this.#objects = next;
      return copy(updated);
    });
  }
  read(id, { offset = 0, length = this.chunkBytes } = {}) {
    return this.#enqueue(async () => {
      const object = this.#require(id);
      if (!object.committed) throw problem('BLOB_NOT_COMMITTED', 'upload is not available for reading');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > object.size ||
        !Number.isSafeInteger(length) || length <= 0 || length > this.chunkBytes) throw problem('BLOB_READ_INVALID', 'read range exceeds the chunk limit or is invalid');
      const bytes = Math.min(length, object.size - offset), buffer = Buffer.alloc(bytes);
      const handle = await open(this.#path(id), 'r');
      try {
        let received = 0;
        while (received < bytes) {
          const part = await handle.read(buffer, received, bytes - received, offset + received);
          if (part.bytesRead === 0) throw problem('BLOB_STORE_CORRUPT', 'committed blob bytes are missing');
          received += part.bytesRead;
        }
      } finally { await handle.close(); }
      return { id, offset, data: buffer.toString('base64'), bytes, eof: offset + bytes === object.size };
    });
  }
  release(id, owner) {
    return this.#enqueue(async () => {
      const object = this.#owned(id, owner);
      if (object.released) return copy(object);
      const updated = { ...object, released: true }, next = new Map(this.#objects); next.set(id, updated);
      await this.#save(next); this.#objects = next;
      return copy(updated);
    });
  }
  close() { return this.#enqueue(() => { this.#ready = false; }); }
}
