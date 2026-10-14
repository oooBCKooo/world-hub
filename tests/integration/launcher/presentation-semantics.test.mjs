import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIsolationPanel } from '../../../tools/launcher/public/isolation-ui.mjs';
import { createPublisherUi } from '../../../tools/launcher/public/publisher-ui.mjs';
import { createCompletionUi } from '../../../tools/launcher/public/completion-ui.mjs';
import { element } from './ui-dom.mjs';

function harness(language = 'en', api = async () => ({}), stateOverrides = {}) {
  const body = element('body');
  globalThis.document = { body, querySelector: selector => body.querySelector(selector), activeElement: null };
  const state = { language, isolationSelection: null, reviews: new Map(), trustReview: null, ...stateOverrides };
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const ctx = { state, say, api, el: element,
    button: (title, action, className = 'button', disabled = false) => element('button', { type: 'button', class: className, disabled, onclick: action }, title),
    panel: (title, children) => element('section', {}, [element('h2', {}, title), ...children]),
    note: text => element('p', {}, text), date: String, toast() {},
    definition: rows => element('dl', {}, rows.flatMap(([name, item]) => [element('dt', {}, name), element('dd', {}, item)])),
    jsonView: (title, data) => element('details', {}, [element('summary', {}, title), element('pre', {}, JSON.stringify(data))]),
    field: (name, title, value = '', options = {}) => element('label', {}, [element('span', {}, title), element(options.multiline ? 'textarea' : 'input', { name, value, type: options.type ?? 'text' })]),
    form: (children, label, submit) => element('form', { onsubmit: event => submit(event.target) }, [...children, element('button', { type: 'submit' }, label)]),
    value: (form, key) => form.elements[key].value,
    endpoint: (id, action) => `/api/instances/${id}/${action}`, refresh: async () => {}, selectInstance: async () => {}, openImport() {}, reviewAction() {}, operation: async () => {} };
  return { body, ctx, state };
}

test('protection default compares full configuration without claiming changes applied to existing runs', async () => {
  const chosen = { profile: 'docker-runtime/v1', dockerPath: '/usr/bin/docker', endpoint: 'unix:///var/run/docker.sock', images: { node: 'node@sha256:abc' }, http: { components: ['ui'] }, limits: { memoryMiB: 256, pids: 64, cpus: 1, user: 1000 } };
  const { body, ctx, state } = harness('en', async () => ({ probe: { available: true } }), { isolationSelection: chosen });
  body.append(createIsolationPanel(ctx));
  const summary = body.querySelector('.isolation-current'), form = body.querySelector('form');
  assert.match(summary.textContent, /Default for the next review/);
  assert.match(summary.textContent, /Form matches the complete selected configuration/);
  assert.match(summary.textContent, /does not change existing runs/);
  assert.doesNotMatch(summary.textContent, /Active Protection Profile/);
  for (const [name, value] of [['nodeImage', 'node@sha256:new'], ['containerUser', '2000'], ['memoryMiB', '512'], ['endpoint', 'unix:///other.sock'], ['httpComponents', 'another-ui']]) {
    const input = form.elements[name], previous = input.value; input.value = value;
    await form.dispatch('input'); assert.match(summary.textContent, /Pending Configuration Change/, name);
    input.value = previous; await form.dispatch('input'); assert.match(summary.textContent, /Form matches/, name);
  }
  form.elements.memoryMiB.value = '512'; await form.dispatch('submit');
  assert.equal(state.isolationSelection.limits.memoryMiB, 512);
  assert.match(summary.textContent, /Form matches/);
  assert.match(summary.textContent, /does not change existing runs/);
});

test('publisher view shows unsigned evidence, independent identity trust and no automatic sandbox or demo anchor', async () => {
  for (const language of ['zh', 'en']) {
    const { body, ctx } = harness(language, async () => ({ trust: { issuers: [] } }));
    const ui = createPublisherUi(ctx); body.append(ui.trustPanel()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(body.querySelector('input[name="publicKey"]').value, '');
    assert.equal(body.querySelector('input[name="issuer"]').value, '');
    assert.doesNotMatch(body.textContent, /MC4CAQAw|Fill sample demo|填入示例数据|sandboxed user review|本地沙箱人工审阅|全自动核验哈希与防伪签名/);
    assert.match(body.textContent, language === 'zh' ? /默认 trusted-local.*不提供 OS 沙箱/ : /default trusted-local provides no OS sandbox/);
    const report = ui.reportView({ present: false, signatureStatus: 'unsigned', publisherIdentity: 'unanchored-key', contentIntegrity: 'not-checked' });
    assert.match(report.textContent, language === 'zh' ? /未提供数字防伪签名/ : /No signature evidence/);
    assert.doesNotMatch(report.textContent, /Signature valid only|证明.*来源于声明的作者/);
    assert.match(report.textContent, language === 'zh' ? /不授权运行/ : /grants no execution permission/);
  }
});

test('publisher key with a future expiry is active and a future valid-from stays inactive', async () => {
  const { body, ctx } = harness('en', async () => ({ trust: { issuers: [{ issuer: 'tester', keys: [
    { keyId: 'valid', validFrom: '2000-01-01T00:00:00Z', validUntil: '2999-01-01T00:00:00Z' },
    { keyId: 'future', validFrom: '2999-01-01T00:00:00Z' }
  ] }] } }));
  body.append(createPublisherUi(ctx).trustPanel()); await new Promise(resolve => setImmediate(resolve));
  const cards = body.querySelectorAll('.publisher-cert-card'); assert.equal(cards.length, 2);
  assert.match(cards[0].querySelector('.cert-status-badge').textContent, /Active/);
  assert.match(cards[1].querySelector('.cert-status-badge').textContent, /Inactive/);
});

test('template shortcut resolves the backend-discovered absolute path and refuses an absent candidate', async () => {
  const calls = [], directory = 'F:\\installed elsewhere\\模板 🌍';
  const { ctx } = harness('en', async (path, request) => {
    calls.push([path, request]);
    if (path === '/api/templates/builtin') return { candidates: [{ directory, id: 'text-desk', version: '1.0.0' }] };
    throw new Error('inspection fixture stops here');
  });
  await assert.rejects(createCompletionUi(ctx).openTemplate(), /inspection fixture/);
  assert.deepEqual(calls, [['/api/templates/builtin', undefined], ['/api/templates/inspect', { directory }]]);
  const absent = harness('en', async path => { assert.equal(path, '/api/templates/builtin'); return { candidates: [] }; });
  await assert.rejects(createCompletionUi(absent.ctx).openTemplate(), /No built-in templates/);
});

test('candidate and rollback dialogs keep independent authorization and data limits in both languages', () => {
  for (const language of ['zh', 'en']) {
    const { ctx } = harness(language);
    const ui = createCompletionUi(ctx), views = ui.maintenance({ instanceId: 'sample', stagedFrom: 'old' });
    assert.match(views.trialDialog.textContent, language === 'zh' ? /重新启动仍须审阅授权/ : /fresh execution review/);
    assert.match(views.upgradeDialog.textContent, language === 'zh' ? /回滚可能替换后续数据/ : /Rollback may replace later data/);
    assert.match(views.upgradeDialog.textContent, language === 'zh' ? /无法撤销.*外部副作用/ : /cannot undo.*external effects/);
    assert.doesNotMatch(views.trialDialog.textContent + views.upgradeDialog.textContent, /随时无损|一键回退/);
    assert.equal(views.historyDialog.querySelector('button').attributes['aria-label'], language === 'zh' ? '关闭' : 'Close');
    assert.equal(ui.createTemplatePanel().querySelector('textarea').value, '');
  }
});

function contrast(a, b) {
  const luminance = hex => { const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4); return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722; };
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b); return (values[1] + 0.05) / (values[0] + 0.05);
}

test('actual theme variables keep small body text and primary-button labels above 4.5:1', async () => {
  const css = await readFile(new URL('../../../tools/launcher/public/style.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/:root(?:\[data-theme="light"\])?\s*\{([^}]+)\}/g)].slice(0, 2);
  const themes = blocks.map(block => Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name, color]) => [name, color])));
  assert.equal(themes.length, 2);
  for (const [index, theme] of themes.entries()) {
    for (const text of ['ink', 'ink-secondary', 'dim', 'muted']) for (const surface of ['bg-canvas', 'bg-surface', 'bg-surface-raised', 'bg-surface-sunken']) {
      const ratio = contrast(theme[text], theme[surface]); assert.ok(ratio >= 4.5, `theme ${index}: ${text}/${surface} ${ratio}`);
    }
    assert.ok(contrast(theme['accent-cyan-ink'], theme['accent-cyan']) >= 4.5, `theme ${index}: primary button`);
  }
  // This checks selected colors only; real browser layout and screen-reader acceptance are separate.
});
