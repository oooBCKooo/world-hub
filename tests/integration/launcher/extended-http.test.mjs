import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { PYTHON_RECIPE } from '../../../tools/launcher/environment-prepare.mjs';
import { workspace, samplePackage, environment, until, json, save, ROOT } from './helpers.mjs';

async function apiFor(app) {
  const server = await createLauncherServer({ root: app.root, ...environment }); app.cleanups.push(() => server.close());
  const call = async (path, body, expected = 200, overrides = {}) => {
    const response = await fetch(new URL(path, server.url), { redirect: 'error', signal: AbortSignal.timeout(30000),
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken,
        'content-type': 'application/json', ...overrides }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const operation = async result => until(async () => { const value = (await call('/api/operations/' + result.operationId)).operation;
    return value.state === 'running' ? false : value; }, { timeoutMs: 90000, label: 'extended management operation' });
  const success = async result => { const value = await operation(result); assert.equal(value.state, 'succeeded', JSON.stringify(value)); return value.result; };
  return { server, call, operation, success };
}

test('EXTENDED-01 environment plan review, stale inputs, cancellation and exact local authorization', { timeout: 120000 }, async t => {
  const app = await workspace(t), api = await apiFor(app), directory = await samplePackage(app);
  const discovered = await api.call('/api/environment', {});
  assert.ok(discovered.candidates.node.some(v => v.path === process.execPath));
  assert.ok(discovered.candidates.python.every(v => v.probed === false));
  const planned = await api.call('/api/environment/plan', { directory });
  assert.equal(planned.plan.download.sha256, PYTHON_RECIPE.sha256);
  assert.equal(planned.plan.changesSystemEnvironment, false); assert.equal(planned.plan.executesModuleScripts, false);
  await api.call('/api/environment/prepare', { planId: planned.planId, accepted: false }, 409);
  await api.call('/api/environment/prepare', { planId: planned.planId, accepted: 'true' }, 400);
  await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true }, 403, { origin: 'https://third-party.invalid' });
  await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true }, 403, { 'x-csrf-token': 'wrong' });
  const lock = await json(join(directory, 'pack.lock')); lock.pack.version = '99.0.0'; await save(join(directory, 'pack.lock'), lock);
  const failed = await api.operation(await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true }, 202));
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'ENVIRONMENT_PLAN_CHANGED');
  assert.ok(failed.error.diagnostic.zh && failed.error.diagnostic.en);
  await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true }, 409);
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  app.record('plan-bound-to-current-lock', { reviewDigest: planned.plan.digest, failed: failed.error.code });
});

test('EXTENDED-02 reviewed pinned venv preparation runs a real pack without modifying base environment', { timeout: 120000 }, async t => {
  const app = await workspace(t), api = await apiFor(app), directory = await samplePackage(app);
  // A previously verified wheel is reused when available; CI can fetch the
  // same small fixed PyPI artifact. Never replace the recipe with fixture code.
  const cache = join(app.root, 'environment-cache'); await mkdir(cache);
  try { await copyFile(join(ROOT, '.artifacts/phase16-followup/environment/environment-cache', PYTHON_RECIPE.filename), join(cache, PYTHON_RECIPE.filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const before = (await api.call('/api/environment', {})).environment;
  const planned = await api.call('/api/environment/plan', { directory });
  const prepared = await api.success(await api.call('/api/environment/prepare', { planId: planned.planId, accepted: true }, 202));
  assert.equal(prepared.environment.packages.websockets, '15.0.1'); assert.notEqual(prepared.pythonPath, before.python.executable);
  const after = (await api.call('/api/environment', {})).environment; assert.deepEqual(after, before);
  const review = await api.call('/api/review', { directory, pythonPath: prepared.pythonPath });
  await api.call('/api/instances', { reviewId: review.reviewId, instanceId: 'private-venv' });
  const current = await api.call('/api/instances/private-venv/review', {});
  const running = await api.success(await api.call('/api/instances/private-venv/start', { reviewId: current.reviewId, accepted: true }, 202));
  app.observe(running.status);
  const response = await fetch(new URL('/analyze', running.links.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Private environment 跨语言 🌍' }) });
  const result = await response.json(); assert.equal(response.ok, true); assert.equal(result.result.provider, 'demo.stats');
  await api.success(await api.call('/api/instances/private-venv/stop', {}, 202));
  app.record('private-environment-real-exchange', { pythonPath: prepared.pythonPath, result, baseUnchanged: true });
});

test('EXTENDED-03 creator, publication, source retrieval and collaborator records remain data-only through HTTP', { timeout: 120000 }, async t => {
  const app = await workspace(t), api = await apiFor(app), directory = await samplePackage(app);
  const current = (await api.call('/api/authoring/inspect', { directory })).authoring;
  const pack = structuredClone(current.pack); pack.version = '1.1.0'; pack.components.find(v => v.id === 'source').settings.text = 'Creator API 世界';
  const destination = join(app.directory, 'derived');
  const derived = await api.success(await api.call('/api/authoring/derive', { directory, destination, pack, expectedRevision: current.revision, redistributionAcknowledged: true }, 202));
  assert.equal(derived.pack.version, '1.1.0'); assert.equal(derived.requiresNewExecutionReview, true);
  const published = await api.success(await api.call('/api/sources/publish', { directory: destination, destination: join(app.directory, 'published'), kind: 'pack', redistributionAcknowledged: true }, 202));
  const source = await api.call('/api/sources/inspect', { source: published.indexPath });
  const fetched = await api.success(await api.call('/api/sources/fetch', { source: published.indexPath, indexDigest: source.digest, entryId: source.index.entries[0].entryId }, 202));
  assert.ok(fetched.directory); assert.equal(fetched.startsModules, false);
  const comments = (await api.call('/api/authoring/read-comments', { directory: destination })).comments;
  const text = '<img src=x onerror="window.evil=true"> plain collaborator comment';
  const added = await api.success(await api.call('/api/authoring/comments', { directory: destination, author: 'Developer B', text, expectedRevision: comments.revision }, 202));
  assert.equal(added.comments[0].text, text);
  const conflicted = await api.operation(await api.call('/api/authoring/comments', { directory: destination, author: 'Developer A', text: 'stale draft', expectedRevision: comments.revision }, 202));
  assert.equal(conflicted.state, 'failed'); assert.equal(conflicted.error.diagnostic.kind, 'content-changed');
  await api.success(await api.call('/api/authoring/export-comments', { directory: destination, destination: join(app.directory, 'discussion.json') }, 202));
  const proposal = await api.success(await api.call('/api/authoring/proposal', { directory, destination: join(app.directory, 'proposal'), pack, expectedRevision: current.revision, redistributionAcknowledged: true }, 202));
  const applied = await api.success(await api.call('/api/authoring/apply-proposal', { directory, destination: join(app.directory, 'applied'), proposalDirectory: proposal.directory, redistributionAcknowledged: true }, 202));
  assert.equal(applied.pack.version, '1.1.0'); assert.deepEqual((await api.call('/api/instances')).instances, []);
  await api.call('/api/sources/publish', { directory, destination: join(app.directory, 'bad'), kind: 'pack', redistributionAcknowledged: true, accepted: true }, 400);
  app.record('data-only-creator-source-collaboration', { sourceDigest: source.digest, retrieved: fetched.directory, proposalId: proposal.proposalId, startsModules: false });
});
