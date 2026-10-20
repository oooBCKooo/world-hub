// Community presentation assets are separate from executable artifacts and locks.
import { createHash } from 'node:crypto';

export const MAX_PRESENTATION_BYTES = 5 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 1024 * 1024;
export const MAX_PRESENTATION_REQUEST = 8 * 1024 * 1024;
export const MAX_PUBLICATION_REQUEST = 16 * 1024 * 1024;
const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_PRESENTATION', status: 400 }); };
const check = (condition, message = 'Invalid community image.') => { if (!condition) fail(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function dimensions(width, height) { check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 4096 && height <= 4096 && width * height <= 16 * 1024 * 1024, 'Image dimensions must be 1–4096 pixels on each side, at most 16 megapixels.'); return { width, height }; }
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }
function png(bytes) {
  let position = 8, result, data = false, ended = false;
  while (position < bytes.length) {
    check(position + 12 <= bytes.length); const size = bytes.readUInt32BE(position), end = position + 12 + size; check(end <= bytes.length);
    const type = bytes.toString('ascii', position + 4, position + 8); check(/^[A-Za-z]{4}$/.test(type));
    check(crc32(bytes.subarray(position + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'PNG chunk checksum failed.');
    check(!['acTL', 'fcTL', 'fdAT'].includes(type), 'Animated images are not supported.');
    if (!result) {
      check(type === 'IHDR' && size === 13); result = dimensions(bytes.readUInt32BE(position + 8), bytes.readUInt32BE(position + 12));
      const depth = bytes[position + 16], color = bytes[position + 17], depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      check(depths[color]?.includes(depth) && bytes[position + 18] === 0 && bytes[position + 19] === 0 && bytes[position + 20] <= 1);
    } else check(type !== 'IHDR');
    if (type === 'IDAT') data = true;
    if (type === 'IEND') { check(size === 0 && end === bytes.length && data); ended = true; break; }
    position = end;
  }
  check(ended); return result;
}
function jpeg(bytes) {
  check(bytes.length >= 4 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9); let position = 2, result, scan = false;
  while (position < bytes.length - 2) {
    check(bytes[position++] === 0xff); while (bytes[position] === 0xff) position++; const marker = bytes[position++];
    if (marker === 0xd9) break;
    check(marker !== 0 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7));
    check(position + 2 <= bytes.length); const size = bytes.readUInt16BE(position); check(size >= 2 && position + size <= bytes.length);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      check(!result && size >= 11 && bytes[position + 2] === 8); result = dimensions(bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3));
      const components = bytes[position + 7]; check(components >= 1 && components <= 4 && size === 8 + components * 3);
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) fail('Unsupported JPEG encoding.');
    position += size;
    if (marker === 0xda) { check(result && size >= 6); scan = true; while (position < bytes.length - 1) { if (bytes[position] !== 0xff) { position++; continue; } const next = bytes[position + 1]; if (next === 0 || next >= 0xd0 && next <= 0xd7) { position += 2; continue; } break; } }
  }
  check(result && scan && position === bytes.length - 2); return result;
}
function webp(bytes) {
  check(bytes.length >= 20 && bytes.readUInt32LE(4) + 8 === bytes.length); let position = 12, result, frame;
  while (position < bytes.length) {
    check(position + 8 <= bytes.length); const type = bytes.toString('ascii', position, position + 4), size = bytes.readUInt32LE(position + 4), start = position + 8, end = start + size; check(end + (size & 1) <= bytes.length);
    check(!['ANIM', 'ANMF'].includes(type), 'Animated images are not supported.');
    if (type === 'VP8X') { check(position === 12 && size === 10 && !(bytes[start] & 0x02), 'Animated or malformed WebP image.'); result = dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3)); }
    if (type === 'VP8 ') { check(!frame && size >= 10 && !(bytes[start] & 1) && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))); frame = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff); }
    if (type === 'VP8L') { check(!frame && size >= 5 && bytes[start] === 0x2f); const bits = bytes.readUInt32LE(start + 1); check(bits >>> 29 === 0); frame = dimensions(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff)); }
    position = end + (size & 1);
  }
  check(frame && (!result || result.width === frame.width && result.height === frame.height)); return result ?? frame;
}
export function inspectMedia(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_MEDIA_BYTES, 'Each cover or preview must be at most 1 MiB.');
  let mimeType, result;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { mimeType = 'image/png'; result = png(bytes); }
  else if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) { mimeType = 'image/jpeg'; result = jpeg(bytes); }
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') { mimeType = 'image/webp'; result = webp(bytes); }
  else fail('Use a nonanimated PNG, JPEG or WebP image.');
  return { sha256: sha(bytes), mimeType, size: bytes.length, ...result };
}
function altText(value = '') { check(typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value), 'Image alternative text must be at most 256 characters.'); return value.trim(); }
export const mediaExtension = mimeType => types[mimeType];
export const presentationAssets = presentation => [presentation?.icon, presentation?.cover, ...(presentation?.screenshots ?? [])].filter(Boolean);
export function validatePresentation(input, references = new Map()) {
  check(object(input) && Object.keys(input).every(key => ['icon', 'cover', 'screenshots'].includes(key)), 'Unsupported presentation fields.');
  if (input.screenshots !== undefined) check(Array.isArray(input.screenshots) && input.screenshots.length <= 6, 'Use at most six preview images.');
  const assets = new Map(), presentation = {}; let total = 0;
  function asset(value, role) {
    check(object(value)); let descriptor, bytes;
    if (Object.hasOwn(value, 'sha256')) {
      check(Object.keys(value).every(key => ['sha256', 'alt'].includes(key)) && typeof value.sha256 === 'string' && references.has(value.sha256), 'Only this publication’s existing images can be reused.');
      descriptor = { ...references.get(value.sha256), alt: altText(value.alt ?? references.get(value.sha256).alt) }; delete descriptor.url;
    } else {
      check(Object.keys(value).every(key => ['mimeType', 'base64', 'alt'].includes(key)) && Object.hasOwn(types, value.mimeType) && typeof value.base64 === 'string' && value.base64.length <= Math.ceil(MAX_MEDIA_BYTES / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64), 'Invalid image type or canonical base64 encoding.');
      bytes = Buffer.from(value.base64, 'base64'); check(bytes.toString('base64') === value.base64); descriptor = { ...inspectMedia(bytes), alt: altText(value.alt) }; check(descriptor.mimeType === value.mimeType, 'Image content and declared MIME type disagree.');
    }
    check(descriptor.size <= (role === 'icon' ? 512 * 1024 : MAX_MEDIA_BYTES), role === 'icon' ? 'Icon must be at most 512 KiB.' : 'Preview must be at most 1 MiB.');
    total += descriptor.size; check(total <= MAX_PRESENTATION_BYTES, 'Presentation images together must be at most 5 MiB.');
    if (bytes) assets.set(descriptor.sha256, { descriptor, bytes }); return descriptor;
  }
  for (const role of ['icon', 'cover']) if (input[role] !== undefined) presentation[role] = asset(input[role], role);
  if (input.screenshots?.length) presentation.screenshots = input.screenshots.map(value => asset(value, 'screenshot'));
  return { presentation, assets };
}
export function assertPresentation(presentation) {
  check(object(presentation) && Object.keys(presentation).every(key => ['icon', 'cover', 'screenshots'].includes(key)), 'Malformed stored presentation.');
  check(presentation.screenshots === undefined || Array.isArray(presentation.screenshots) && presentation.screenshots.length <= 6);
  const references = new Map();
  for (const asset of presentationAssets(presentation)) {
    check(object(asset) && Object.keys(asset).length === 6 && Object.keys(asset).every(key => ['sha256', 'mimeType', 'size', 'width', 'height', 'alt'].includes(key)), 'Malformed stored image descriptor.');
    check(/^[a-f0-9]{64}$/.test(asset.sha256) && Object.hasOwn(types, asset.mimeType) && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_MEDIA_BYTES); dimensions(asset.width, asset.height); check(altText(asset.alt) === asset.alt); references.set(asset.sha256, asset);
  }
  // Reuse the same role and total-size validation as an incoming update.
  const input = {}; for (const role of ['icon', 'cover']) if (presentation[role]) input[role] = { sha256: presentation[role].sha256 };
  if (presentation.screenshots) input.screenshots = presentation.screenshots.map(asset => ({ sha256: asset.sha256 }));
  validatePresentation(input, references); return presentation;
}
export function publicPresentation(presentation = {}) {
  const asset = value => ({ ...value, url: `/workshop/media/${value.sha256}.${types[value.mimeType]}` });
  return { ...(presentation.icon ? { icon: asset(presentation.icon) } : {}), ...(presentation.cover ? { cover: asset(presentation.cover) } : {}), ...(presentation.screenshots?.length ? { screenshots: presentation.screenshots.map(asset) } : {}) };
}
