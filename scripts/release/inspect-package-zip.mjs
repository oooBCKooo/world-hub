import assert from 'node:assert/strict';

// Inspect names before asking an extractor to create files. Builder ZIPs use a
// single UTF-8 root, regular files, deflate, and no ZIP64 or encrypted members.
export function inspectPackageZip(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  assert.ok(end >= 0, 'ZIP end-of-central-directory is missing');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multi-disk ZIP is not supported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multi-disk ZIP is not supported');
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  assert.ok(count > 0 && count < 2000 && start + length === end, 'Unexpected ZIP directory limits');
  let offset = start, total = 0; const entries = [], seen = new Set(), roots = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP central member');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    assert.equal(flags, 0x800, 'Only unencrypted UTF-8 builder ZIP members are accepted');
    assert.equal(method, 8, 'Only builder deflate members are accepted');
    const compressedBytes = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameBytes = bytes.readUInt16LE(offset + 28), extraBytes = bytes.readUInt16LE(offset + 30), commentBytes = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameBytes + extraBytes + commentBytes;
    assert.ok(next <= end && nameBytes > 0, 'ZIP central member exceeds directory');
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes));
    const parts = path.split('/');
    assert.ok(parts.length > 1 && !path.includes('\\') && !/[:\x00-\x1f]/.test(path)
      && parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
        && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe ZIP path: ' + path);
    assert.ok(!seen.has(path.toLowerCase()), 'Duplicate ZIP path: ' + path); seen.add(path.toLowerCase()); roots.add(parts[0]);
    assert.notEqual((bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000, 0xa000, 'ZIP symlinks are rejected');
    const local = bytes.readUInt32LE(offset + 42);
    assert.ok(local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50, 'Invalid ZIP local member');
    assert.equal(bytes.readUInt16LE(local + 6), flags, 'ZIP local and central flags differ');
    assert.equal(bytes.readUInt16LE(local + 8), method, 'ZIP local and central compression differs');
    const localNameBytes = bytes.readUInt16LE(local + 26), localExtraBytes = bytes.readUInt16LE(local + 28);
    assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameBytes)), path, 'ZIP local and central names differ');
    assert.ok(local + 30 + localNameBytes + localExtraBytes + compressedBytes <= start, 'ZIP local member exceeds data area');
    assert.ok(size < 256 * 1024 * 1024 && compressedBytes < 256 * 1024 * 1024, 'ZIP member exceeds package limits');
    total += size; assert.ok(total < 512 * 1024 * 1024, 'ZIP expands beyond package limits');
    entries.push({ path, size, compressedBytes }); offset = next;
  }
  assert.equal(offset, end, 'ZIP directory has unparsed bytes'); assert.equal(roots.size, 1, 'ZIP needs one package root');
  return { root: [...roots][0], entries, expandedBytes: total };
}
