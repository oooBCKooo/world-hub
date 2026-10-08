import { runtimeForBundle } from './runtime-helper.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i], value = process.argv[i + 1];
  assert.ok(['--bundle', '--evidence'].includes(option) && value && isAbsolute(value), 'bundle and evidence require absolute paths');
  assert.equal(Object.hasOwn(args, option.slice(2)), false, 'arguments may not repeat');
  args[option.slice(2)] = resolve(value);
}
assert.ok(args.bundle && args.evidence);
assert.ok(args.evidence !== args.bundle && !args.evidence.startsWith(args.bundle + sep), 'evidence must be outside the supplied bundle');
await mkdir(args.evidence, { recursive: false });
const baseline = JSON.parse(await readFile(join(args.bundle, 'config/hub.json'), 'utf8'));
const runtime = await runtimeForBundle(args.bundle), launcher = join(args.bundle, 'scripts/launcher.mjs');
const manifest = JSON.parse(await readFile(join(args.bundle, 'manifest.json'), 'utf8'));
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
const cases = [
  ['log-zero', config => { config.log.segmentMaxBytes = 0; }, 'log.segmentMaxBytes'],
  ['acl-wildcard', config => { config.acl.credentials['ui.manual'].allow.publish = ['#/private']; }, 'allow.publish[0]'],
  ['acl-string', config => { config.acl.credentials['ui.manual'].allow.subscribe = '#'; }, 'allow.subscribe'],
  ['acl-quota', config => { config.acl.credentials['ui.manual'].maxConnections = 0; }, 'maxConnections'],
  ['acl-token-type', config => { config.acl.credentials['ui.manual'].token = { secret: 'invalid-config-test-secret-should-not-appear' }; }, '.token'],
];
const report = { startedAt: new Date().toISOString(), version: manifest.version, bundle: args.bundle, commandRuntime: runtime, checks: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(path, prefix = '') {
  const result = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) result.push(...await inventory(join(path, entry.name), prefix + entry.name + '/'));
    else result.push({ path: prefix + entry.name, sha256: hash(await readFile(join(path, entry.name))) });
  }
  return result;
}
const bundleBefore = await inventory(args.bundle);
try {
  for (const [name, mutate, field] of cases) {
    const directory = join(args.evidence, name); await mkdir(directory);
    const config = structuredClone(baseline); config.log.dir = './must-not-exist/log'; config.blobs.dir = './must-not-exist/blobs'; config.management.stateFile = './must-not-exist/manage.json'; mutate(config);
    const configPath = join(directory, 'hub.json'); await writeFile(configPath, JSON.stringify(config));
    const before = await inventory(directory), commands = [];
    for (const flags of [['--check'], []]) {
      const argv = [launcher, ...flags, '--port', '0', '--config', configPath];
      const result = spawnSync(runtime, argv, { cwd: directory, shell: false, windowsHide: true, encoding: 'utf8', timeout: 8000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 2); assert.equal(result.signal, null);
      assert.ok(result.stderr.includes(field), result.stderr);
      assert.ok(!result.stderr.includes('invalid-config-test-secret-should-not-appear'));
      assert.ok(!result.stdout.includes('"type":"ready"') && !result.stdout.includes('"event":"ready"'));
      assert.deepEqual(await inventory(directory), before);
      assert.deepEqual(await readdir(directory), ['hub.json']);
      commands.push({ command: [runtime, ...argv], exitCode: result.status, stdout: result.stdout, stderr: result.stderr, noDataOrLockCreated: true });
    }
    report.checks.push({ name, passed: true, field, commands });
  }
  assert.deepEqual(await inventory(args.bundle), bundleBefore);
  report.passed = true;
} catch (error) { report.passed = false; report.error = { message: error.message, stack: error.stack }; console.error(error.stack); process.exitCode = 1; }
report.endedAt = new Date().toISOString(); await writeFile(join(args.evidence, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: report.passed, cases: report.checks.length, report: join(args.evidence, 'report.json') }));
