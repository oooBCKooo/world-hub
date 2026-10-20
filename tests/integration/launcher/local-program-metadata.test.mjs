import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalPrograms } from '../../../tools/launcher/local-programs.mjs';
import { collectSourceFiles } from '../../../scripts/runtime/source-guidance.mjs';
import { workspace, environment, save } from './helpers.mjs';

test('LOCAL-PROGRAM-METADATA managed source cards use registered runtime, entry and complete source inventory without private launch data', { timeout: 20000 }, async t => {
  const app = await workspace(t), directory = join(app.directory, 'author-source');
  await mkdir(join(directory, 'worker'), { recursive: true });
  const manifest = { format: 'world-hub.module/v1', id: 'test.metadata', version: '1.0.0', license: 'MIT',
    platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'python', entry: 'worker/service.py' },
    bridges: ['read', 'write'], provides: [{ id: 'metadata.inspect', version: '1.0.0' }], requires: [],
    permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
  await save(join(directory, 'module.json'), manifest);
  await writeFile(join(directory, 'worker/service.py'), '# Author-selected entry; this metadata test does not launch it.\n');
  await writeFile(join(directory, 'worker/readme.txt'), '注册的第三份源码文件\n');
  const registry = new LocalPrograms({ root: app.root, environment });
  await registry.initialize();
  const reviewed = await registry.preview({ programId: 'chosen-instance', directory, settings: {}, topics: { public: 'metadata/public' },
    bridges: { read: { publish: [], subscribe: ['public'] }, write: { publish: ['public'], subscribe: [] } } });
  const { program } = await registry.register({ reviewId: reviewed.reviewId, accepted: true });
  const identity = JSON.parse(await readFile(registry.path(program.programId, 'identity.json'), 'utf8'));
  assert.equal(program.ownership, 'managed');
  assert.equal(program.sourceDirectory, registry.path(program.programId, 'module'));
  assert.deepEqual(program.manifest, manifest);
  assert.deepEqual(program.runtime, { kind: 'python', entry: 'worker/service.py' });
  assert.equal(program.sourceFileCount, 3);
  assert.deepEqual(program.sourceFiles, await collectSourceFiles(program.sourceDirectory));
  assert.deepEqual((await registry.programs())[0], program);
  const serialized = JSON.stringify(program);
  assert.ok(!serialized.includes(identity.token));
  for (const key of ['identity', 'token', 'environment', 'configPath', 'stateDir']) assert.equal(Object.hasOwn(program, key), false);
  assert.ok(!serialized.includes('identity.json'));
  assert.ok(!serialized.includes(environment.pythonPath));

  // Public snapshots must not expose nested private registry additions or let
  // a caller mutate the source inventory used by later reviews.
  const row = registry.row(program.programId);
  row.manifest.runtime.token = identity.token; row.files[0].privateIdentity = identity.token;
  const snapshot = registry.public(row);
  assert.ok(!JSON.stringify(snapshot).includes(identity.token));
  snapshot.manifest.runtime.entry = 'changed.py'; snapshot.sourceFiles[0].sha256 = 'changed';
  assert.equal(row.manifest.runtime.entry, manifest.runtime.entry);
  assert.notEqual(row.files[0].sha256, 'changed');
  app.record('registered-source-declarations-and-safe-public-inventory', { runtime: program.runtime, sourceFileCount: program.sourceFileCount, ownership: program.ownership });
});
