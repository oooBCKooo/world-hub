import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, okay } from '../helpers/module-versions-scene.mjs';

test('author execution defaults: native creator writes reviewed deployment defaults and registers a stopped instance without caller grants', async t => {
  const scene = await setup(t), directory = join(scene.root, 'created-author-module');
  const result = okay(await scene.call('/manage/api/creator/scaffold', {
    id: 'creator-default', runtime: 'node', directory, executionDefaults: { mode: 'on-demand', idleTimeoutMs: 12000 }
  }));
  const deployment = JSON.parse(await readFile(join(directory, 'deployment.json'), 'utf8'));
  assert.deepEqual(deployment.executionDefaults, { mode: 'on-demand', idleTimeoutMs: 12000 });
  const local = scene.owner.localPrograms, row = local.row(result.programId);
  assert.deepEqual(row.executionPolicy, { mode: 'on-demand', idleTimeoutMs: 12000, allowedCallers: [] });
  assert.equal(row.state, 'stopped'); assert.equal(local.handles.size, 0);
});

test('author execution defaults: creator rejects invalid or caller-grant defaults before writing the destination', async t => {
  const scene = await setup(t);
  for (const executionDefaults of [null, { mode: 'automatic' }, { mode: 'on-demand', idleTimeoutMs: 0 }, { mode: 'on-demand', allowedCallers: ['caller'] }]) {
    const directory = join(scene.root, 'rejected-author-module');
    const result = await scene.call('/manage/api/creator/scaffold', { id: 'rejected-default', runtime: 'node', directory, executionDefaults });
    assert.equal(result.status, 400); assert.equal(result.body.error, 'DEPLOYMENT_INVALID');
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
  assert.equal(scene.owner.localPrograms.records.size, 0);
});
