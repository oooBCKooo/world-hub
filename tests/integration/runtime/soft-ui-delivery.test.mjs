import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildSoftUiModules } from '../../../scripts/release/build-soft-ui-modules.mjs';
import { inspectDemoZip } from '../../../scripts/release/demo-package-acceptance.mjs';
test('independent module ZIPs contain declarations and source, exclude private state and dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-soft-delivery-')), built = await buildSoftUiModules({ outputDirectory: directory });
  assert.equal(built.packages.length, 2);
  for (const entry of built.packages) {
    const bytes = await readFile(entry.archive), inspected = inspectDemoZip(bytes);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    const names = inspected.entries.map(member => member.path);
    assert.ok(names.some(path => path.endsWith('/module.json'))); assert.ok(names.some(path => path.endsWith('/deployment.json'))); assert.ok(names.some(path => path.endsWith('/program.mjs')));
    assert.equal(names.some(path => /(?:^|\/)(?:node_modules|\.env|\.soft-ui-state|\.soft-ui-local|runtime\.json|identity\.json)(?:\/|$)/.test(path)), false);
    assert.match(await readFile(entry.archive + '.sha256', 'utf8'), new RegExp('^' + entry.sha256 + '  '));
  }
});
