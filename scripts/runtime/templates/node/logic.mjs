import { createHash } from 'node:crypto';
export function statistics(text) {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > 16384) throw new Error('INPUT_INVALID');
  return { codePoints: [...text].length, lines: text.split('\n').length, utf8Bytes: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}
