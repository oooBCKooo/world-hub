// Opaque communication objects. No application paths, URLs or payload semantics.
import { BlobStore } from './blob-store.mjs';

const TYPES = new Set(['blob_begin', 'blob_status', 'blob_chunk', 'blob_commit', 'blob_read', 'blob_release']);
const descriptor = ({ id, size, sha256, offset, committed, released }) => ({ id, size, sha256, offset, committed, released });
const fail = (code, message) => Object.assign(new Error(message), { code });

export async function installBlobProtocol(hub, config) {
  const store = new BlobStore(config.blobs);
  await store.open();
  hub.registerExtension({
    features: ['blob-v1'],
    snapshot: () => ({ blobs: store.snapshot() }),
    close: () => store.close(),
    async validateAttachments(principal, ids) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw fail('ATTACHMENTS_INVALID', 'attachments must contain 1 to 16 distinct object IDs');
      }
      try { return await store.pinAttachments(principal, ids); }
      catch (error) { if (error.code === 'BLOB_OWNER_DENIED') throw fail('BLOB_DENIED', 'only the object provider may attach it'); throw error; }
    },
    async handleFrame(frame, ctx) {
      if (!TYPES.has(frame.type)) return false;
      try {
        let result;
        switch (frame.type) {
          case 'blob_begin': result = descriptor(await store.begin(ctx.principal, frame)); break;
          case 'blob_status': result = descriptor(await store.status(frame.id, ctx.principal)); break;
          case 'blob_chunk': result = descriptor(await store.write(frame.id, ctx.principal, frame)); break;
          case 'blob_commit': result = descriptor(await store.commit(frame.id, ctx.principal)); break;
          case 'blob_release': result = descriptor(await store.release(frame.id, ctx.principal)); break;
          case 'blob_read': {
            const object = store.get(frame.id);
            if (!object) throw fail('BLOB_NOT_FOUND', 'object is not retained');
            if (!object.committed) throw fail('BLOB_INCOMPLETE', 'object has not been committed');
            if (object.owner !== ctx.principal) {
              if (!Number.isSafeInteger(frame.messageSeq) || frame.messageSeq <= 0) throw fail('BLOB_DENIED', 'a retained authorized message is required');
              const entry = hub.log.get(frame.messageSeq);
              if (!entry || !entry.attachments?.some((a) => a.id === object.id) || !ctx.canRead(entry)) {
                throw fail('BLOB_DENIED', 'object is not referenced by an authorized retained message');
              }
            }
            result = { ...descriptor(object), ...await store.read(frame.id, { offset: frame.offset, length: frame.length }) };
            break;
          }
        }
        ctx.send({ type: 'blob_result', operation: frame.type, requestToken: frame.requestToken, ...result });
      } catch (error) {
        ctx.send({ type: error.code === 'BLOB_DENIED' ? 'denied' : 'error', code: error.code ?? 'HUB_INTERNAL', message: String(error.message ?? error).slice(0, 200), requestToken: frame.requestToken });
      }
      return true;
    },
  });
}
