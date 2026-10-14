import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLock, inspectPackage, importPackage, validateLock } from '../../../scripts/runtime/package.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { PACK_LOCK_FORMAT_V2, RUNTIME_API, currentHubCompatibility, checkHubCompatibility } from '../../../scripts/runtime/compatibility.mjs';
import { WIRE_VERSION } from '../../../src/hub/lib/hub.mjs';
import { workspace, fixturePackage, samplePackage, environment, json, save, filesBelow, analyze, expectedText, ROOT } from '../launcher/helpers.mjs';

const options = { timeout: 90000, concurrency: false };
const release = async () => (await json(join(ROOT, 'package.json'))).version;
const installedRelease = await release();
const legacy = lock => { const copy = structuredClone(lock); copy.format = 'world-hub.pack-lock/v1'; delete copy.hubCompatibility; return copy; };
const snapshot = async directory => Promise.all((await filesBelow(directory)).map(async file => [file, hash(await readFile(join(directory, file)))]));

test('COMPAT-01 new source locks declare current wire and Runtime contracts and reject obsolete formats', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const before = await snapshot(directory), lock = await createLock(directory, { ...environment, write: false });
  assert.equal(lock.format, PACK_LOCK_FORMAT_V2);
  assert.equal(lock.hubVersion, await release());
  assert.deepEqual(lock.hubCompatibility, { wireVersion: WIRE_VERSION, runtimeApi: RUNTIME_API });
  assert.equal(validateLock(lock), lock);
  assert.deepEqual(await snapshot(directory), before, 'Creating a preview lock must not change source or its existing lock');
  const old = legacy(lock); assert.throws(() => validateLock(old), { code: 'PACK_LOCK_OBSOLETE' });
  assert.throws(() => validateLock({ ...old, hubCompatibility: currentHubCompatibility() }), { code: 'PACK_LOCK_OBSOLETE' });
  assert.throws(() => validateLock({ ...lock, hubCompatibility: { ...lock.hubCompatibility, ignoreVersion: true } }), /unsupported fields/);
  const missing = structuredClone(lock); delete missing.hubCompatibility;
  assert.throws(() => validateLock(missing), /missing/);
  assert.throws(() => validateLock({ ...lock, format: 'world-hub.pack-lock/v3' }), /Unsupported lock format/);
  const schema = await json(join(ROOT, 'docs/ecosystem/pack-lock.schema.json'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.hubCompatibility.additionalProperties, false);
  assert.equal(schema.properties.format.const, PACK_LOCK_FORMAT_V2);
  assert.ok(schema.required.includes('hubCompatibility'));
  assert.equal(schema.oneOf, undefined);
});

test('COMPAT-02 v2 accepts a different recorded product release without editing source or interpreter locks', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const lock = await json(join(directory, 'pack.lock')); lock.hubVersion = '0.18.0';
  await save(join(directory, 'pack.lock'), lock);
  const before = await snapshot(directory), plan = await inspectPackage(directory, environment);
  assert.equal(plan.hubVersion, await release());
  assert.equal(plan.lock.hubVersion, '0.18.0');
  assert.equal(plan.hubCompatibility.mode, 'contracts');
  assert.equal(plan.hubCompatibility.compatible, true);
  assert.equal(plan.hubCompatibility.recordedHubVersion, '0.18.0');
  assert.equal(plan.hubCompatibility.installedHubVersion, await release());
  assert.deepEqual(plan.hubCompatibility.required, currentHubCompatibility());
  assert.deepEqual(await snapshot(directory), before);
  app.record('recorded-release-is-not-contract-requirement', { recorded: lock.hubVersion, installed: plan.hubVersion, compatibility: plan.hubCompatibility });
});

test('COMPAT-03 obsolete locks are refused regardless of recorded release or force flags', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const lock = legacy(await json(join(directory, 'pack.lock')));
  lock.hubVersion = (await release()) === '0.18.0' ? '0.17.0' : '0.18.0';
  await save(join(directory, 'pack.lock'), lock);
  const before = await snapshot(directory);
  for (const extra of [{}, { ignoreHubVersion: true, force: true }]) {
    await assert.rejects(inspectPackage(directory, { ...environment, ...extra }), { code: 'PACK_LOCK_OBSOLETE' });
  }
  assert.deepEqual(await snapshot(directory), before);
  app.record('obsolete-lock-refused', { code: 'PACK_LOCK_OBSOLETE' });
});

test('COMPAT-04 same-release obsolete locks and contract-field additions cannot bypass current-format validation', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app);
  const lock = legacy(await json(join(directory, 'pack.lock'))); await save(join(directory, 'pack.lock'), lock);
  assert.equal(lock.hubVersion, installedRelease);
  await assert.rejects(inspectPackage(directory, environment), { code: 'PACK_LOCK_OBSOLETE' });
  assert.throws(() => checkHubCompatibility(lock, installedRelease), { code: 'PACK_LOCK_OBSOLETE' });
  const forged = { ...lock, hubCompatibility: currentHubCompatibility() };
  assert.throws(() => checkHubCompatibility(forged, installedRelease), { code: 'PACK_LOCK_OBSOLETE' });
  await save(join(directory, 'pack.lock'), forged);
  await assert.rejects(inspectPackage(directory, { ...environment, force: true }), { code: 'PACK_LOCK_OBSOLETE' });
});

test('COMPAT-05 unknown wire and Runtime API contracts are refused before any module starts', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), lock = await json(join(directory, 'pack.lock'));
  for (const [key, value] of [['wireVersion', '999.0'], ['runtimeApi', 'world-hub.run/v99']]) {
    const candidate = structuredClone(lock); candidate.hubCompatibility[key] = value;
    await save(join(directory, 'pack.lock'), candidate);
    const before = await snapshot(directory);
    await assert.rejects(inspectPackage(directory, environment), error => {
      assert.equal(error.code, 'PACK_HUB_CONTRACT_UNSUPPORTED');
      assert.equal(error.compatibility.compatible, false);
      assert.equal(error.compatibility.required[key], value);
      assert.deepEqual(error.compatibility.actual, currentHubCompatibility());
      return true;
    });
    assert.deepEqual(await snapshot(directory), before);
  }
});

test('COMPAT-06 v2 still refuses altered source, wrong OS/architecture and exact interpreter drift', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), original = await json(join(directory, 'pack.lock'));
  for (const [field, value] of [['os', 'unsupported-os'], ['arch', 'unsupported-arch']]) {
    const lock = structuredClone(original); lock.platform[field] = value; await save(join(directory, 'pack.lock'), lock);
    await assert.rejects(inspectPackage(directory, environment), /Incompatible platform/);
  }
  const drifted = structuredClone(original); drifted.runtimes.node.version = '1.0.0'; await save(join(directory, 'pack.lock'), drifted);
  await assert.rejects(inspectPackage(directory, environment), /node version mismatch/);
  await save(join(directory, 'pack.lock'), original);
  await writeFile(join(directory, 'modules/fixture/program.mjs'), '\n// altered module\n', { flag: 'a' });
  await assert.rejects(inspectPackage(directory, environment), /Module file hash or file set mismatch/);
});

test('COMPAT-07 review digest binds the actual installed release and rejects prior release trust', options, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), lock = await json(join(directory, 'pack.lock'));
  lock.hubVersion = '0.18.0'; await save(join(directory, 'pack.lock'), lock);
  const plan = await inspectPackage(directory, environment);
  const oldRelease = plan.hubVersion === '0.18.0' ? '0.17.0' : '0.18.0';
  const earlierReviewDigest = hash(JSON.stringify({ packBytes: hash(await readFile(join(directory, 'pack.json'))),
    lockBytes: hash(await readFile(join(directory, 'pack.lock'))), modules: plan.modules, environment: plan.environment,
    hubVersion: oldRelease, hubCompatibility: checkHubCompatibility(lock, oldRelease) }));
  assert.notEqual(plan.digest, earlierReviewDigest);
  const imported = await importPackage(directory, { root: app.root, instanceId: 'fresh-review', ...environment });
  assert.equal(imported.digest, plan.digest);
  await assert.rejects(startInstance({ root: app.root, instanceId: 'fresh-review', trust: earlierReviewDigest, ...environment }), /current review digest/);
  app.record('cross-release-reviews-are-distinct', { earlierReviewDigest, currentReviewDigest: plan.digest });
});

test('COMPAT-08 contract-compatible pack with 0.18 release metadata runs real JS to Python to JS traffic', options, async t => {
  const app = await workspace(t), directory = await samplePackage(app);
  const lock = await json(join(directory, 'pack.lock')); lock.hubVersion = '0.18.0'; await save(join(directory, 'pack.lock'), lock);
  const sourceBefore = await snapshot(directory);
  const imported = await importPackage(directory, { root: app.root, instanceId: 'cross-release', ...environment });
  const session = await startInstance({ root: app.root, instanceId: 'cross-release', trust: imported.digest, ...environment });
  app.cleanups.push(() => session.close());
  const status = app.observe(await session.status());
  assert.equal(status.components.length, 3);
  assert.ok(status.components.every(component => component.communication === 'connected'));
  const text = '0.18 → current Hub 🌍\n跨语言往返';
  const result = (await analyze(session.ready.entryUrl, text)).result;
  assert.deepEqual(result.output, expectedText(text));
  assert.equal(result.receipts.length, 3);
  for (const receipt of result.receipts) assert.ok(receipt.responseSeq > receipt.requestSeq);
  assert.deepEqual(await snapshot(directory), sourceBefore);
  await session.close();
  app.record('real-contract-compatible-cross-language-round-trip', { recordedHubVersion: lock.hubVersion, installedHubVersion: imported.plan.hubVersion, output: result.output, receipts: result.receipts });
});
