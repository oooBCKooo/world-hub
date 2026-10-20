import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import english from '../../src/management/canvas-i18n.mjs';
import { manualEnglish } from '../../src/management/manual-i18n.mjs';

const decode = value => value.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const literal = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const placeholders = value => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();

for (const [dictionary, path] of [[english, 'canvas-i18n.mjs'], [manualEnglish, 'manual-i18n.mjs']]) {
  test(`management language catalog: ${path} has unique, English values and matching interpolation keys`, async () => {
    const source = await readFile(new URL('../../src/management/' + path, import.meta.url), 'utf8');
    const pairs = new RegExp(`(${literal})\\s*:\\s*(${literal})`, 'g');
    const keys = [...source.matchAll(pairs)].map(match => vm.runInNewContext(match[1]));
    assert.equal(keys.length, Object.keys(dictionary).length, 'every entry is checked, including multiple entries on the same line');
    assert.equal(new Set(keys).size, keys.length, 'duplicate keys hide earlier translations');
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', key);
      assert.doesNotMatch(value, /\p{Script=Han}/u, key);
      assert.deepEqual(placeholders(value), placeholders(key), key);
    }
  });
}

for (const [path, dictionary] of [['console.html', english], ['canvas-modes.mjs', english], ['manual-console.mjs', manualEnglish], ['resource-console.mjs', manualEnglish]]) {
  test(`management language catalog: declared labels and literal translation calls in ${path} have English entries`, async () => {
    const source = await readFile(new URL('../../src/management/' + path, import.meta.url), 'utf8'), keys = new Set();
    for (const match of source.matchAll(/\bdata-i18n(?:-(?:title|placeholder|aria-label|alt|tooltip))?="([^"]*)"/g)) {
      const key = decode(match[1]);
      keys.add(path.endsWith('.mjs') ? key.replace(/\\\\/g, '\\') : key);
    }
    const calls = new RegExp(String.raw`\b(?:t|executionText|wiringDefaultsText)\(\s*(${literal})`, 'g');
    for (const match of source.matchAll(calls)) keys.add(vm.runInNewContext(match[1]));
    if (path === 'canvas-modes.mjs') {
      const creates = new RegExp(String.raw`\bcreate\(\s*${literal}\s*,\s*${literal}\s*,\s*(${literal})`, 'g');
      for (const match of source.matchAll(creates)) keys.add(vm.runInNewContext(match[1]));
    }
    const missing = [...keys].filter(key => /\p{Script=Han}/u.test(key) && !Object.hasOwn(dictionary, key));
    assert.deepEqual(missing, []);
  });
}
