import test from 'node:test';
import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { workspace, environment, ROOT, until, expectedText, requestJson } from './helpers.mjs';

const moduleSources = process.env.WORLD_HUB_OFFICIAL_ACCEPTANCE_MODULE_ROOT ?? join(ROOT, 'examples/ecosystem-pack/modules');

test('OFFICIAL-LOCAL-HUB real author defaults connect three separately imported programs with selected providers and independent lifecycle', { timeout: 90000, concurrency: false }, async t => {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  const ownedHandles = new Set();
  app.cleanups.push(async () => {
    await server.close();
    for (const handle of ownedHandles) { assert.ok(handle.exit, 'Owned child exit must be confirmed by its actual process handle'); assert.notEqual(handle.cleanupIncomplete, true); }
  });
  const call = async (path, input, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: input === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`); return value;
  };
  const operate = async (programId, kind, input = {}) => {
    const accepted = await call(`/api/programs/${programId}/${kind}`, input, 202);
    const operation = await until(async () => {
      const value = (await call('/api/operations/' + accepted.operationId)).operation;
      return value.state === 'running' ? false : value;
    }, { timeoutMs: 25000, label: `${kind} ${programId}` });
    assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
    if (server.manager.hub) ownedHandles.add(server.manager.hub);
    const handle = server.manager.localPrograms.handles.get(programId); if (handle) ownedHandles.add(handle);
    return operation.result;
  };
  const modules = {};
  for (const kind of ['source', 'stats', 'desk']) {
    const directory = join(app.directory, `${kind}-module`);
    await cp(join(moduleSources, kind), directory, { recursive: true });
    const imported = await call('/api/artifacts/import', { kind: 'module', path: directory });
    assert.equal(imported.startsModules, false);
    const inspection = await call('/api/deployment/inspect', { directory: imported.object.path });
    assert.ok(inspection.deploymentReview?.deployment, `${kind} must publish author-supplied deployment defaults`);
    assert.equal(inspection.manifest.runtime.kind, kind === 'stats' ? 'python' : 'node');
    modules[kind] = { directory: imported.object.path, inspection, deployment: inspection.deploymentReview.deployment };
  }
  const ids = { source: 'chosen-text-origin', stats: 'chosen-count-service', desk: 'chosen-display-client' };
  const initialText = ' 作者字段初始文本 🌍\r\nConfigured source\n尾行 ';
  for (const kind of ['source', 'stats', 'desk']) {
    const required = modules[kind].inspection.manifest.requires;
    const bindings = required.map(contract => {
      const provider = ['source', 'stats'].find(name => modules[name].inspection.manifest.provides.some(offered => offered.id === contract.id && offered.version === contract.version));
      assert.ok(provider, `Official selected provider for ${contract.id}`); return { providerId: ids[provider], contract };
    });
    const settings = Object.fromEntries(modules[kind].deployment.settings.map(field => [field.key, field.default]));
    if (kind === 'source') settings.text = initialText;
    const preview = await call('/api/programs/preview', { programId: ids[kind], directory: modules[kind].directory, settings, bindings });
    assert.equal(preview.review.startsModules, false);
    assert.equal(server.manager.hub, null);
    const registration = await call('/api/programs/register', { reviewId: preview.reviewId, accepted: true });
    assert.equal(registration.program.state, 'stopped');
    assert.deepEqual(registration.program.bindings, bindings);
  }
  assert.equal((await call('/api/instances', undefined, 404)).error.code, 'NOT_FOUND');
  app.record('three-modules-imported-and-registered-with-author-defaults', { programs: ids, createsPack: false });

  assert.equal((await call('/api/programs')).programs.length, 3);
  app.record('author-defaults-and-explicit-providers-reviewed-through-http-without-starting');

  for (const kind of ['source', 'stats', 'desk']) {
    const reviewed = await call(`/api/programs/${ids[kind]}/review`, {});
    assert.equal(reviewed.review.startsModules, false);
    await operate(ids[kind], 'start', { reviewId: reviewed.reviewId, accepted: true });
  }
  const programs = (await call('/api/programs')).programs;
  assert.equal(programs.length, 3); assert.ok(programs.every(program => program.state === 'running' && program.communication === 'connected'));
  assert.equal(new Set(programs.map(program => program.hubUrl)).size, 1);
  const desk = programs.find(program => program.programId === ids.desk);
  const initialized = await requestJson(desk.entryUrl, '/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(initialized.result.text, initialText); assert.deepEqual(initialized.result.output, expectedText(initialText));
  app.record('author-multiline-setting-survives-http-review-registration-and-provider-extraction', { initialText, output: initialized.result.output });
  const text = ' 手动选提供者 🌍\r\nSelected providers\n最后一行 ';
  const analysis = await requestJson(desk.entryUrl, '/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal(analysis.result.text, text); assert.deepEqual(analysis.result.output, expectedText(text));
  assert.deepEqual(analysis.result.receipts.map(receipt => receipt.step), ['source-set', 'source-read', 'python-statistics']);
  const source = programs.find(program => program.programId === ids.source), stats = programs.find(program => program.programId === ids.stats);
  assert.deepEqual(analysis.result.receipts.map(receipt => receipt.fromPrincipal), [source.principal, source.principal, stats.principal]);
  for (const receipt of analysis.result.receipts) assert.ok(receipt.responseSeq > receipt.requestSeq);
  app.record('real-independent-three-program-duplex-text-and-python-result', { text, output: analysis.result.output, receipts: analysis.result.receipts });

  const sharedHubHandle = server.manager.hub, deskHandle = server.manager.localPrograms.handles.get(ids.desk), statsHandle = server.manager.localPrograms.handles.get(ids.stats);
  await operate(ids.source, 'stop');
  assert.ok(server.manager.localPrograms.handles.get(ids.source).exit);
  assert.equal(sharedHubHandle.exit, null); assert.equal(deskHandle.exit, null); assert.equal(statsHandle.exit, null);
  const remaining = (await call('/api/programs')).programs;
  assert.equal(remaining.find(program => program.programId === ids.source).state, 'stopped');
  assert.ok(remaining.filter(program => program.programId !== ids.source).every(program => program.state === 'running'));
  const savedDesk = await requestJson(desk.entryUrl, '/state'); assert.ok(savedDesk.results.some(result => result.text === text));
  app.record('stopping-one-provider-preserves-shared-hub-and-other-program-handles');

  let reviewed = await call(`/api/programs/${ids.source}/review`, {});
  await operate(ids.source, 'start', { reviewId: reviewed.reviewId, accepted: true });
  const restoredSource = await requestJson(desk.entryUrl, '/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(restoredSource.result.text, text); assert.equal(restoredSource.result.sourceRevision, analysis.result.sourceRevision);
  await operate(ids.desk, 'stop'); reviewed = await call(`/api/programs/${ids.desk}/review`, {});
  await operate(ids.desk, 'start', { reviewId: reviewed.reviewId, accepted: true });
  const restartedDesk = (await call('/api/programs')).programs.find(program => program.programId === ids.desk);
  const restoredDesk = await requestJson(restartedDesk.entryUrl, '/state'); assert.ok(restoredDesk.results.some(result => result.text === text));
  assert.equal(server.manager.hub, sharedHubHandle); assert.equal(sharedHubHandle.exit, null);
  assert.equal((await call('/api/instances', undefined, 404)).error.code, 'NOT_FOUND');
  app.record('independent-restarts-preserve-provider-text-and-consumer-results-without-a-pack');
  for (const kind of ['desk', 'stats', 'source']) await operate(ids[kind], 'stop');
  await server.close();
  for (const handle of ownedHandles) assert.ok(handle.exit);
  app.record('all-owned-process-handles-confirm-exit', { count: ownedHandles.size, hubExited: Boolean(sharedHubHandle.exit) });
});
