import test from 'node:test';
import assert from 'node:assert/strict';
import { statistics } from './logic.mjs';
test('exact Unicode and LF semantics, including empty text and invalid input', () => {
  assert.deepEqual(statistics(''), { codePoints: 0, lines: 1, utf8Bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  const value = statistics('中🌍\r\n'); assert.equal(value.codePoints, 4); assert.equal(value.lines, 2); assert.equal(value.utf8Bytes, 9);
  assert.throws(() => statistics('\ud800'), /INPUT_INVALID/); assert.throws(() => statistics('a'.repeat(16385)), /INPUT_INVALID/);
});
