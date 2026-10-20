import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceConsole } from '../../src/management/resource-console.mjs';

// Exercise the real controller's mutation and consent boundary independently
// of its layout. Browser acceptance covers the native dialog and forms.
function scene() {
  const view = Object.create(ResourceConsole.prototype), requests = [], elements = new Map();
  for (const id of ['review', 'review-ack', 'review-stop', 'review-compatibility', 'review-apply']) elements.set(id, { checked: false, hidden: false, disabled: false });
  view.$ = id => elements.get(id); view.t = source => source; view.fresh = true; view.busy = false; view.token = 'local-csrf'; view.state = { revision: 'rev-7' };
  view.receipt = value => { view.lastReceipt = value; }; view.status = value => { view.lastStatus = value; }; view.updateControls = () => {};
  view.refresh = async () => { view.refreshed = true; view.fresh = true; };
  view.environment = { CustomEvent: class { constructor(type) { this.type = type; } }, dispatchEvent: value => { view.lastEvent = value.type; } };
  view.request = async (path, init) => { requests.push({ path, ...init, body: JSON.parse(init.body) }); return { applied: true }; };
  return { view, requests, elements };
}
const review = (kind = 'configuration', extra = {}) => ({ kind, reviewId: 'review-saved-v2', expiresAt: new Date(Date.now() + 60000).toISOString(), review: { blocked: false, conflicts: [], missingModules: [], requiresStop: [], ...extra } });

test('resources UI: configuration apply requires reviewed consent and explicit stop scope, preserves data without starting', async () => {
  const { view, requests } = scene(); view.review = review('configuration', { requiresStop: ['instance-a'] });
  await view.applyReview(); assert.equal(requests.length, 0);
  view.$('review-ack').checked = true; await view.applyReview(); assert.equal(requests.length, 0);
  view.$('review-stop').checked = true; await view.applyReview();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/manage/api/resources/profiles/apply');
  assert.deepEqual(requests[0].body, { reviewId: 'review-saved-v2', accepted: true, stopOwned: true });
  assert.equal(requests[0].headers['X-Management-Token'], 'local-csrf');
  assert.equal(view.review, null); assert.equal(view.refreshed, true); assert.equal(view.lastEvent, 'world-hub:resources-changed');
  assert.match(view.lastStatus, /模块数据保留.*尚未自动启动/);
});

test('resources UI: data restore independently requires compatibility consent and uses the selected reviewed target', async () => {
  const { view, requests } = scene(); view.review = review('data'); view.$('review-ack').checked = true;
  await view.applyReview(); assert.equal(requests.length, 0);
  view.$('review-compatibility').checked = true; await view.applyReview();
  assert.equal(requests[0].path, '/manage/api/resources/data/apply');
  assert.deepEqual(requests[0].body, { reviewId: 'review-saved-v2', accepted: true, dataCompatibilityAcknowledged: true });
});

test('resources UI: missing bodies, conflicts, blockers, stale states and expired reviews cannot be confirmed', async () => {
  for (const extra of [{ blocked: true }, { missingModules: [{ id: 'missing' }] }, { conflicts: [{ programId: 'shared' }] }]) {
    const { view, requests } = scene(); view.review = review('configuration', extra); view.$('review-ack').checked = true;
    await view.applyReview(); assert.equal(requests.length, 0);
  }
  const { view, requests } = scene(); view.review = review(); view.$('review-ack').checked = true; view.fresh = false;
  await view.applyReview(); assert.equal(requests.length, 0);
  view.fresh = true; view.review.expiresAt = '2000-01-01T00:00:00Z'; await view.applyReview(); assert.equal(requests.length, 0);
});

test('resources UI: failed mutation discards consent and marks state stale without retry', async () => {
  const { view } = scene(); let calls = 0; view.review = review();
  view.request = async () => { calls++; throw new Error('response lost'); };
  await assert.rejects(view.mutate('/profiles/apply', { reviewId: 'review-saved-v2', accepted: true }), /response lost/);
  assert.equal(calls, 1); assert.equal(view.review, null); assert.equal(view.fresh, false);
  await assert.rejects(view.post('/profiles/apply', {}), /刷新资源状态/); assert.equal(calls, 1);
});

test('resources UI: cleanup sends only reviewed scope and no data deletion instruction', async () => {
  const { view, requests } = scene(); view.review = review('cleanup'); view.$('review-ack').checked = true;
  await view.applyReview(); assert.equal(requests[0].path, '/manage/api/resources/cleanup/apply');
  assert.deepEqual(requests[0].body, { reviewId: 'review-saved-v2', accepted: true, stopOwned: false });
  assert.match(view.lastStatus, /模块数据保留/);
});

test('resources UI: local exports reject an empty selection and preserve explicit instance boundaries', () => {
  const { view } = scene(), fields = { scope: 'local', programIds: 'a, b a', id: 'saved.example', title: 'Example', version: '1.0.0', destination: '' };
  const form = { elements: { namedItem: name => Object.hasOwn(fields, name) ? { value: fields[name] } : null } };
  assert.deepEqual(view.exportFields(form), { scope: 'local', programIds: ['a', 'b'], id: 'saved.example', title: 'Example', version: '1.0.0' });
  fields.programIds = ''; assert.throws(() => view.exportFields(form), /至少一个实例/);
  fields.scope = 'global'; assert.equal(Object.hasOwn(view.exportFields(form), 'programIds'), false);
});
