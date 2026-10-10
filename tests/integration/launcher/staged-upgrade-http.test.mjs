import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { createLock } from '../../../scripts/runtime/index.mjs';
import { workspace, samplePackage, environment, json, save, analyze, expectedText, until } from './helpers.mjs';

test('STAGED-HTTP stopped old instance, exact preview, new registered candidate and independently reviewed business, then return to old', { timeout: 180000 }, async t => {
  const app = await workspace(t), directory = await samplePackage(app), server = await createLauncherServer({ root: app.root, ...environment });
  app.cleanups.push(() => server.close());
  const call = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  };
  const finish = async request => until(async () => {
    const op = (await call('/api/operations/' + request.operationId)).operation;
    if (op.state === 'running') return false; assert.equal(op.state, 'succeeded', JSON.stringify(op)); return op.result;
  }, { timeoutMs: 100000 });
  const review = await call('/api/review', { directory }); await call('/api/instances', { reviewId: review.reviewId, instanceId: 'old' });
  const start = async id => {
    const reviewed = await call(`/api/instances/${id}/review`, {});
    const result = await finish(await call(`/api/instances/${id}/start`, { reviewId: reviewed.reviewId, accepted: true }, 202)); app.observe(result.status); return result;
  };
  const old = await start('old'); await analyze(old.links.entryUrl, 'retain private old state 🌍');
  const candidate = join(app.directory, 'candidate'); await cp(directory, candidate, { recursive: true });
  const pack = await json(join(candidate, 'pack.json')); pack.version = '9.0.0'; await save(join(candidate, 'pack.json'), pack); await createLock(candidate, environment);
  const input = { candidate, newInstanceId: 'trial', backupDestination: join(app.directory, 'old-private.whbackup'), statePolicy: 'fresh' };
  await call('/api/instances/old/staged-upgrade-plan', input, 409);
  await finish(await call('/api/instances/old/stop', {}, 202));
  const original = await readFile(join(old.directory, 'programs/source/source.json'));
  const preview = await call('/api/instances/old/staged-upgrade-plan', input);
  assert.equal(preview.preview.changesOldInstance, false); assert.equal(preview.preview.data.programState, 'not-inherited');
  await call('/api/instances/old/staged-upgrade', { previewId: preview.previewId, accepted: false }, 409);
  await call('/api/instances/old/staged-upgrade', { previewId: preview.previewId, accepted: true, candidate }, 400);
  const prepared = await finish(await call('/api/instances/old/staged-upgrade', { previewId: preview.previewId, accepted: true }, 202));
  assert.equal(prepared.oldInstancePreserved, true); assert.equal(prepared.instance.pack.version, '9.0.0');
  assert.equal(prepared.instance.status.state, 'imported'); assert.equal(prepared.requiresNewExecutionReview, true);
  await call('/api/instances/old/staged-upgrade', { previewId: preview.previewId, accepted: true }, 409);
  const trial = await start('trial'), text = 'real independently reviewed trial 🌍\r\n e\u0301 ';
  assert.deepEqual((await analyze(trial.links.entryUrl, text)).result.output, expectedText(text));
  await finish(await call('/api/instances/trial/stop', {}, 202));
  assert.deepEqual(await readFile(join(old.directory, 'programs/source/source.json')), original);
  const returned = await start('old'); assert.deepEqual((await analyze(returned.links.entryUrl, 'return to old')).result.output, expectedText('return to old'));
  await finish(await call('/api/instances/old/stop', {}, 202));
  app.record('new-instance-trial-through-authenticated-http', { oldId: 'old', candidateId: 'trial', oldPreserved: true, candidateBusinessPassed: true, oldBusinessPassed: true, automaticCutover: false });
});
