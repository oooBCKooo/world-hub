// Bounded text framing for the optional external container adapter, not Hub wire.
export const ISOLATION_EVENT = 'world-hub-isolation/v1';
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export function channelChunks(connection, text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error('Isolation frame exceeds 4 MiB');
  const values = [];
  for (let offset = 0; offset < text.length || offset === 0; offset += 8192) values.push({ event: ISOLATION_EVENT, operation: 'chunk', connection, index: values.length, final: offset + 8192 >= text.length, text: text.slice(offset, offset + 8192) });
  return values;
}
export function collectChannelChunk(pending, frame) {
  if (!frame || frame.operation !== 'chunk' || !Number.isSafeInteger(frame.index) || frame.index < 0
      || typeof frame.final !== 'boolean' || typeof frame.text !== 'string' || frame.text.length > 8192) throw new Error('Invalid isolation chunk');
  const record = pending ?? { next: 0, text: '', bytes: 0 };
  if (frame.index !== record.next) throw new Error('Isolation frame order changed');
  record.next++; record.text += frame.text; record.bytes += Buffer.byteLength(frame.text);
  if (record.bytes > MAX_FRAME_BYTES) throw new Error('Isolation frame exceeds 4 MiB');
  return { pending: frame.final ? null : record, text: frame.final ? record.text : null };
}
