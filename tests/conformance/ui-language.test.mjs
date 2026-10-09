import test from 'node:test';
import assert from 'node:assert/strict';
import { createI18n, LANGUAGE_STORAGE_KEY, normalizeLanguage } from '../../src/ui/language.mjs';

const dictionary = { '未连接': 'Disconnected', '收到 {count} 条信息': 'Received {count} messages',
  '输入自己的主题': 'Enter your topic' };
function environment({ saved, browser = ['zh-CN'], query = '' } = {}) {
  const target = new EventTarget();
  const values = new Map(saved ? [[LANGUAGE_STORAGE_KEY, saved]] : []);
  Object.assign(target, {
    CustomEvent, navigator: { languages: browser },
    location: { href: 'http://127.0.0.1/manage' + query },
    document: { documentElement: { lang: 'zh-CN' } },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  });
  return target;
}

test('UI language uses explicit link, stored choice, supported browser preference, then Chinese', () => {
  const explicit = createI18n(dictionary, { environment: environment({ saved: 'zh-CN', query: '?lang=en' }) });
  assert.equal(explicit.language, 'en');
  assert.equal(createI18n(dictionary, { environment: environment({ saved: 'en', browser: ['zh-CN'] }) }).language, 'en');
  assert.equal(createI18n(dictionary, { environment: environment({ browser: ['fr', 'en-US'] }) }).language, 'en');
  assert.equal(createI18n(dictionary, { environment: environment({ saved: 'unknown', browser: ['fr'] }) }).language, 'zh-CN');
  assert.equal(normalizeLanguage('zh-TW'), 'zh-CN');
  assert.equal(normalizeLanguage('french'), null);
});

test('canvas and workbench language instances synchronize, persist, and restore without double callbacks', () => {
  const page = environment();
  const canvas = createI18n(dictionary, { environment: page });
  const manual = createI18n(dictionary, { environment: page });
  const changes = [];
  canvas.onChange(language => changes.push(['canvas', language]));
  manual.onChange(language => changes.push(['manual', language]));
  canvas.setLanguage('en');
  assert.deepEqual(changes, [['canvas', 'en'], ['manual', 'en']]);
  assert.equal(manual.t('收到 {count} 条信息', { count: 7 }), 'Received 7 messages');
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(createI18n(dictionary, { environment: page }).language, 'en');
  manual.setLanguage('zh-CN');
  assert.equal(canvas.t('未连接'), '未连接');
  assert.equal(page.localStorage.getItem(LANGUAGE_STORAGE_KEY), 'zh-CN');
  assert.equal(canvas.setLanguage('unsupported'), false);
  canvas.dispose(); manual.dispose();
});

test('blocked preference storage does not prevent switching or formatting safe display text', () => {
  const page = environment();
  Object.defineProperty(page, 'localStorage', { get() { throw new Error('blocked'); } });
  const language = createI18n(dictionary, { environment: page });
  assert.equal(language.setLanguage('en'), true);
  assert.equal(language.t('收到 {count} 条信息', { count: '<b>1</b>' }), 'Received <b>1</b> messages');
  assert.equal(language.t('缺失的呈现文案'), '缺失的呈现文案');
});

test('DOM application translates only marked presentation and leaves form values and raw content untouched', () => {
  const page = environment({ saved: 'en' });
  const attributes = new Map([['data-i18n-placeholder', '输入自己的主题']]);
  const field = { value: '用户/原文', textContent: '', getAttribute: key => attributes.get(key) ?? null,
    setAttribute: (key, value) => attributes.set(key, value) };
  const stateAttributes = new Map([['data-i18n', '未连接']]);
  const state = { textContent: '', getAttribute: key => stateAttributes.get(key) ?? null,
    setAttribute: (key, value) => stateAttributes.set(key, value) };
  const raw = { textContent: '{"message":"未连接","amount":9007199254740993}' };
  const language = createI18n(dictionary, { environment: page });
  language.apply({ querySelectorAll: () => [field, state] });
  assert.equal(state.textContent, 'Disconnected');
  assert.equal(attributes.get('placeholder'), 'Enter your topic');
  assert.equal(field.value, '用户/原文');
  assert.equal(raw.textContent, '{"message":"未连接","amount":9007199254740993}');
  language.setLanguage('zh-CN'); language.apply({ querySelectorAll: () => [field, state] });
  assert.equal(state.textContent, '未连接');
  assert.equal(field.value, '用户/原文');
});
