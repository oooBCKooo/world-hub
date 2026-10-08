import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptNpmPackage } from '../../../scripts/release/npm-package-acceptance.mjs';

test('the actual npm tarball installs into clean local/global prefixes and runs without writing installation files', { timeout: 120_000 }, async () => {
  const report = await acceptNpmPackage();
  assert.equal(report.passed, true, `${report.error ?? ''}\nEvidence: ${join(report.evidence, 'report.json')}`);
  assert.ok(report.checks.length >= 11);
  assert.ok(report.checks.every(check => check.passed));
  assert.ok(report.processes.length >= 2);
  assert.ok(report.processes.every(child => child.exit?.code === 0));
  assert.match(report.archiveSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(await readFile(join(report.evidence, 'report.json'), 'utf8')).passed, true);
});
