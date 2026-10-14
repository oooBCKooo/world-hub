import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { workspace, environment, ROOT, until } from './helpers.mjs';

test('official text modules provide author defaults and serve two arbitrarily named consumers on the existing Hub without a pack', { timeout: 90000 }, async t => {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  const owned = new Set();
  app.cleanups.push(async () => {
    await server.close();
    for (const handle of owned) {
      assert.ok(handle.exit && !handle.cleanupIncomplete, 'Every retained owned child must have confirmed exit');
      assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null);
    }
  });
  const call = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30000),
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const finish = async request => until(async () => {
    const { operation } = await call('/api/operations/' + request.operationId);
    if (operation.state === 'failed') throw new Error(JSON.stringify(operation.error));
    return operation.state === 'succeeded' ? operation.result : null;
  }, { timeoutMs: 45000, label: 'local ecosystem program operation' });
  const programs = [
    { programId: 'my-text-vault', module: 'source', bindings: [] },
    { programId: 'counting-service', module: 'stats', bindings: [] },
    ...['browser-one', 'browser-two'].map(programId => ({ programId, module: 'desk', bindings: [
      { providerId: 'my-text-vault', contract: { id: 'text.read', version: '1.0.0' } },
      { providerId: 'counting-service', contract: { id: 'text.statistics', version: '1.0.0' } }
    ] }))
  ];
  for (const program of programs) {
    const directory = join(ROOT, 'examples/ecosystem-pack/modules', program.module);
    const inspected = await call('/api/deployment/inspect', { directory });
    assert.ok(inspected.deploymentReview.deployment, 'Public module must include its author-selected defaults');
    const preview = await call('/api/programs/preview', { programId: program.programId, directory, bindings: program.bindings });
    assert.equal(preview.review.createsPack, false);
    await call('/api/programs/register', { reviewId: preview.reviewId, accepted: true });
  }
  for (const { programId } of programs) {
    const review = await call(`/api/programs/${programId}/review`, {});
    await finish(await call(`/api/programs/${programId}/start`, { reviewId: review.reviewId, accepted: true }, 202));
    owned.add(server.manager.localPrograms.handles.get(programId));
  }
  owned.add(server.manager.hub);
  const registered = (await call('/api/programs')).programs;
  assert.ok(registered.every(program => program.state === 'running' && program.communication === 'connected'));
  assert.equal(new Set(registered.map(program => program.hubUrl)).size, 1);
  assert.deepEqual((await call('/api/instances')).instances, []);
  await assert.rejects(access(join(app.root, 'compositions')), { code: 'ENOENT' });
  for (const programId of ['browser-one', 'browser-two']) {
    const text = `任意实例 ${programId} 🌍\nAuthor defaults, independent programs.\n`;
    const entry = registered.find(program => program.programId === programId).entryUrl;
    const response = await fetch(new URL('/analyze', entry), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result.result.output, { codePoints: [...text].length, lines: text.split('\n').length,
      utf8Bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
    assert.equal(result.result.provider, 'demo.stats'); assert.equal(result.result.receipts.length, 3);
  }
  const hub = server.manager.hub;
  await finish(await call('/api/programs/browser-one/stop', {}, 202));
  assert.equal(hub.exit, null);
  const remaining = (await call('/api/programs')).programs;
  assert.equal(remaining.find(program => program.programId === 'browser-two').state, 'running');
  assert.equal(remaining.find(program => program.programId === 'my-text-vault').state, 'running');
  app.record('official-defaults-and-arbitrary-local-bindings', { programs: registered.map(program => ({ programId: program.programId, module: program.module })),
    sharedHub: true, packCreated: false, businessConsumers: 2, stoppedConsumerDoesNotStopPeers: true });
});

test('the official text provider can start alone before any consumer is registered', { timeout: 60000 }, async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize();
  const owned = new Set();
  app.cleanups.push(async () => { await manager.close(); for (const handle of owned) assert.ok(handle.exit && !handle.cleanupIncomplete); });
  const preview = await manager.localPrograms.preview({ programId: 'single-text-provider', directory: join(ROOT, 'examples/ecosystem-pack/modules/source') });
  assert.deepEqual(preview.review.bindings, []);
  assert.equal(preview.review.settings.text, '你好，世界 🌍\nHello World Hub\n');
  await manager.localPrograms.register({ reviewId: preview.reviewId, accepted: true });
  const review = await manager.localPrograms.reviewStart('single-text-provider');
  const started = await manager.localPrograms.start('single-text-provider', { reviewId: review.reviewId, accepted: true });
  owned.add(manager.hub); owned.add(manager.localPrograms.handles.get('single-text-provider'));
  assert.equal(started.program.state, 'running'); assert.equal(started.program.communication, 'connected');
  assert.deepEqual(await manager.instances(), []);
  app.record('standalone-provider-before-consumer', { module: started.program.module, programId: started.program.programId, authorizedConsumers: 0, connected: true, packCreated: false });
});
