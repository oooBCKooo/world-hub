import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { join, relative, basename, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let value = n; for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[n] = value >>> 0; }
const crc32 = buffer => { let value = 0xffffffff; for (const byte of buffer) value = table[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; };
// Standard UTF-8 ZIP, deterministic 2026-01-01 timestamp, no external archiver.
// Package files are under 4 GiB, so ZIP64 is deliberately rejected.
export async function zipDirectory(directory, output) {
  const paths = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('ZIP input cannot contain symbolic links');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) paths.push(full);
      else throw new Error('ZIP input must consist of regular files');
    }
  }
  await visit(directory); paths.sort();
  if (paths.length > 65535) throw new Error('ZIP64 entry count unsupported');
  const locals = []; const central = []; let offset = 0; let centralBytes = 0;
  for (const path of paths) {
    if (!(await lstat(path)).isFile()) throw new Error('ZIP input changed');
    const bytes = await readFile(path); const compressed = deflateRawSync(bytes, { level: 6 });
    const name = Buffer.from(basename(directory) + '/' + relative(directory, path).split(sep).join('/'), 'utf8');
    if (name.length > 65535 || bytes.length >= 0xffffffff || compressed.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('ZIP64 limits exceeded');
    const crc = crc32(bytes); const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(date, 14); header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name); centralBytes += header.length + name.length; offset += local.length + name.length + compressed.length;
  }
  if (offset + centralBytes >= 0xffffffff) throw new Error('ZIP64 total size unsupported');
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(paths.length, 8); end.writeUInt16LE(paths.length, 10); end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  await writeFile(output, Buffer.concat([...locals, ...central, end]), { flag: 'wx' });
  return { entries: paths.length, bytes: offset + centralBytes + end.length };
}
