import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createI18n, LANGUAGE_STORAGE_KEY } from '../../src/ui/language.mjs';
import { manualEnglish } from '../../src/management/manual-i18n.mjs';

const manual = await readFile(new URL('../../src/management/manual-console.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../../src/management/console.html', import.meta.url), 'utf8');

for (const preference of ['link', 'saved']) {
  test(`manual workbench initialization preserves English ${preference} before canvas controls initialize`, () => {
    const environment = new EventTarget();
    const values = new Map(preference === 'saved' ? [[LANGUAGE_STORAGE_KEY, 'en']] : []);
    Object.assign(environment, {
      CustomEvent, navigator: { languages: ['zh-CN'] },
      location: { href: 'http://localhost/manage' + (preference === 'link' ? '?lang=en' : '') },
      localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      document: { documentElement: { lang: 'zh-CN' } },
    });
    const i18n = createI18n(manualEnglish, { environment });
    const events = new Map();
    // HTML has Chinese as its first option, before the canvas module initializes.
    const canvasSelect = { value: 'zh-CN', addEventListener: (name, listener) => events.set(name, listener) };
    let renders = 0;
    const context = vm.createContext({ i18n, document: { getElementById: () => canvasSelect }, refreshLanguage() { renders++; } });
    vm.runInContext(manual.slice(manual.indexOf('const canvasLang = document.getElementById')), context);
    assert.equal(i18n.language, 'en');
    assert.equal(i18n.t('手动通讯工作台'), 'Manual communication workbench');
    assert.equal(renders, 1);
    events.get('change')();
    assert.equal(i18n.language, 'zh-CN');
    assert.equal(renders, 2);
    i18n.dispose();
  });
}

test('manual workbench static labels use its own complete English dictionary', () => {
  const keys = [...manual.matchAll(/data-i18n(?:-(?:title|placeholder|aria-label|alt|tooltip))?="([^"]*)"/g)]
    .map(match => match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
  const missing = [...new Set(keys.filter(key => /\p{Script=Han}/u.test(key) && !Object.hasOwn(manualEnglish, key)))];
  assert.deepEqual(missing, []);
});

test('canvas translation service exists before its initial dynamic-language render', () => {
  const initialization = html.slice(html.indexOf("$('canvas-language').addEventListener('change'"));
  assert.ok(initialization.indexOf('window.hubCanvas =') < initialization.indexOf('renderCanvasLanguage();'));
});
