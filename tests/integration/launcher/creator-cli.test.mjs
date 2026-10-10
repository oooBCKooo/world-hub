import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, rm, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { workspace, fixturePackage, filesBelow, json, save, ROOT } from './helpers.mjs';

const execute = promisify(execFile);
const cliFile = join(ROOT, 'bin/world-hub-pack.mjs');
const timeout = { timeout: 90000, concurrency: false };
const nodeArgs = ['--node', process.execPath];
const licenses = ['--acknowledge-licenses', 'true'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function present(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function cli(args) {
  const result = await execute(process.execPath, [cliFile, ...args], { cwd: ROOT, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}
async function refuses(args, match) {
  await assert.rejects(() => cli(args), error => {
    assert.equal(error.code, 1, error.message);
    const body = JSON.parse(error.stderr.trim());
    assert.equal(body.ok, false); assert.equal(body.error.code, 'PACK_RUNTIME_ERROR');
    assert.match(body.error.message, match); return true;
  });
}
async function fixture(t) {
  const app = await workspace(t), directory = await fixturePackage(app);
  const sentinel = join(app.directory, 'unexpected-module-execution.txt');
  await writeFile(join(directory, 'modules/fixture/program.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('Creator actions must not execute modules');\n`);
  await cli(['lock', directory, ...nodeArgs]);
  app.cleanups.push(async () => { assert.equal(await present(sentinel), false, 'A data-only CLI action executed a module'); });
  return { ...app, directory, sentinel };
}

test('CREATOR-CLI-01 public commands derive, exchange and apply a proposal while enforcing licenses and revision conflicts', timeout, async t => {
  const app = await fixture(t), model = await cli(['authoring', app.directory, ...nodeArgs]);
  const originalManifest = await readFile(join(app.directory, 'pack.json'));
  const originalLock = await readFile(join(app.directory, 'pack.lock'));
  const edited = structuredClone(model.pack); edited.version = '1.2.0'; edited.title = 'CLI 组合 🌍';
  edited.components[0].settings.note = 'Independent developer edits';
  const manifest = join(app.directory, 'edited.json'); await save(manifest, edited);
  const options = ['--manifest', manifest, '--revision', model.revision, ...licenses, ...nodeArgs];
  const destination = join(app.directory, 'derived');
  const derived = await cli(['derive', app.directory, '--destination', destination, ...options]);
  assert.equal(derived.pack.version, edited.version); assert.equal(derived.pack.title, edited.title);
  assert.equal(derived.requiresNewExecutionReview, true); assert.equal(derived.startsModules, false);
  const proposal = await cli(['proposal', app.directory, '--destination', join(app.directory, 'proposal'), ...options]);
  const applied = await cli(['apply-proposal', app.directory, '--proposal', proposal.directory,
    '--destination', join(app.directory, 'applied'), ...licenses, ...nodeArgs]);
  assert.equal(applied.revision, derived.revision); assert.equal(applied.proposalId, proposal.proposalId);
  assert.deepEqual(await readFile(join(app.directory, 'pack.json')), originalManifest);
  assert.deepEqual(await readFile(join(app.directory, 'pack.lock')), originalLock);
  const denied = join(app.directory, 'not-authorized');
  await refuses(['derive', app.directory, '--destination', denied, '--manifest', manifest, '--revision', model.revision, ...nodeArgs], /acknowledge-licenses/);
  assert.equal(await present(denied), false);
  const conflicting = join(app.directory, 'conflicting');
  await refuses(['derive', app.directory, '--destination', conflicting, '--manifest', manifest,
    '--revision', '0'.repeat(64), ...licenses, ...nodeArgs], /revision conflict/);
  assert.equal(await present(conflicting), false);
  app.record('real-cli-derive-proposal-apply', { revision: derived.revision, proposalId: proposal.proposalId, sourceUnchanged: true, modulesExecuted: false });
});

test('CREATOR-CLI-02 explicit old-lock rebuild produces a new package and never rewrites the incompatible source', timeout, async t => {
  const app = await fixture(t), lock = await json(join(app.directory, 'pack.lock'));
  lock.hubVersion = '0.0.1'; await save(join(app.directory, 'pack.lock'), lock);
  const previous = await readFile(join(app.directory, 'pack.lock'));
  await refuses(['plan', app.directory, ...nodeArgs], /Hub version/);
  const rebuilt = await cli(['rebuild', app.directory, '--destination', join(app.directory, 'rebuilt'), ...licenses, ...nodeArgs]);
  assert.equal(rebuilt.oldRequirements.hubVersion, '0.0.1');
  assert.equal(rebuilt.newRequirements.hubVersion, (await json(join(ROOT, 'package.json'))).version);
  assert.equal(rebuilt.requiresNewExecutionReview, true); assert.equal(rebuilt.startsModules, false);
  assert.deepEqual(await readFile(join(app.directory, 'pack.lock')), previous);
  const inspected = await cli(['authoring', rebuilt.directory, ...nodeArgs]); assert.equal(inspected.revision, rebuilt.revision);
  await refuses(['rebuild', app.directory, '--destination', rebuilt.directory, ...licenses, ...nodeArgs], /exist/i);
  app.record('real-cli-old-lock-rebuild', { oldRequirements: rebuilt.oldRequirements, newRequirements: rebuilt.newRequirements, sourceUnchanged: true });
});

test('CREATOR-CLI-03 source publication, pinned retrieval and archive-only offline cache recovery remain data-only', timeout, async t => {
  const app = await fixture(t), output = join(app.directory, 'publication');
  const published = await cli(['publish', app.directory, '--destination', output, '--kind', 'pack', ...licenses, ...nodeArgs]);
  assert.equal(published.publishedRemotely, false); assert.equal(published.startsModules, false);
  const indexBytes = await readFile(published.indexPath), indexSha256 = digest(indexBytes);
  const source = await cli(['source', published.indexPath, '--sha256', indexSha256]);
  const entry = source.index.entries[0], cacheRoot = join(app.directory, 'cache');
  const argumentsForFetch = ['fetch-source', published.indexPath, '--index-digest', source.digest,
    '--entry', entry.entryId, '--cache', cacheRoot];
  const fetched = await cli(argumentsForFetch);
  assert.equal(fetched.cached, false); assert.equal(fetched.offline, false); assert.equal(fetched.startsModules, false);
  const beforeFiles = await filesBelow(fetched.directory);
  const beforeHashes = await Promise.all(beforeFiles.map(async path => [path, digest(await readFile(join(fetched.directory, path)))]));
  await refuses(['source', published.indexPath, '--sha256', '0'.repeat(64)], /hash mismatch/);
  await rename(output, output + '-offline');
  // Remove only this known extraction inside the test workspace, preserving its verified archive.
  const extraction = await realpath(fetched.directory), cache = await realpath(cacheRoot), tail = relative(cache, extraction);
  assert.equal(dirname(extraction), cache); assert.equal(isAbsolute(tail), false); assert.match(tail, /^[a-f0-9]{64}$/);
  await rm(extraction, { recursive: true, force: false });
  const recovered = await cli(argumentsForFetch);
  assert.equal(recovered.cached, true); assert.equal(recovered.offline, true); assert.equal(recovered.startsModules, false);
  assert.deepEqual(await filesBelow(recovered.directory), beforeFiles);
  assert.deepEqual(await Promise.all(beforeFiles.map(async path => [path, digest(await readFile(join(recovered.directory, path)))])), beforeHashes);
  const modulePublication = await cli(['publish', join(app.directory, 'modules/fixture'), '--destination', join(app.directory, 'module-publication'), '--kind', 'module', ...licenses, ...nodeArgs]);
  assert.equal(modulePublication.index.entries[0].kind, 'module');
  await refuses(['publish', app.directory, '--destination', join(app.directory, 'unlicensed'), '--kind', 'pack', ...nodeArgs], /acknowledge-licenses/);
  app.record('real-cli-publish-fetch-offline', { indexSha256, artifactSha256: entry.sha256, recoveredFiles: beforeFiles.length, modulesExecuted: false });
});

test('CREATOR-CLI-04 backup inspection digest, fresh restore, detach and reviewed reattach preserve opaque program data', timeout, async t => {
  const app = await fixture(t), imported = await cli(['import', app.directory, '--root', app.root, '--instance', 'original', ...nodeArgs]);
  const dataDirectory = join(imported.stateDir, 'programs/fixture'); await mkdir(dataDirectory, { recursive: true });
  const data = Buffer.from('Opaque provider-owned state 世界\n'); await writeFile(join(dataDirectory, 'provider.bin'), data);
  const backup = join(app.directory, 'private.whbackup');
  const snapshot = await cli(['backup', '--root', app.root, '--instance', 'original', '--destination', backup, ...nodeArgs]);
  const inspection = await cli(['inspect-backup', backup]);
  assert.equal(inspection.sha256, snapshot.sha256); assert.equal(inspection.compatible, true); assert.equal(inspection.private, true);
  const restore = ['restore', '--root', app.root, '--instance', 'recovered', '--backup', backup];
  await refuses([...restore, ...nodeArgs], /--backup and --sha256/);
  await refuses([...restore, '--sha256', '0'.repeat(64), ...nodeArgs], /inspected restore plan/);
  assert.equal(await present(join(app.root, 'instances/recovered')), false);
  const recovered = await cli([...restore, '--sha256', inspection.sha256, ...nodeArgs]);
  assert.equal(recovered.startsModules, false); assert.equal(recovered.restoredFrom.sha256, inspection.sha256);
  assert.deepEqual(await readFile(join(recovered.stateDir, 'programs/fixture/provider.bin')), data);
  const identity = await readFile(join(recovered.stateDir, 'instance.json'));
  await refuses([...restore, '--sha256', inspection.sha256, ...nodeArgs], /exist/i);
  assert.deepEqual(await readFile(join(recovered.stateDir, 'instance.json')), identity);
  const detached = await cli(['detach', '--root', app.root, '--instance', 'recovered']);
  assert.equal(detached.preservesData, true); assert.equal(await present(join(recovered.stateDir, 'package')), false);
  const review = await cli(['plan', join(recovered.stateDir, 'detached-package'), ...nodeArgs]);
  await refuses(['reattach', '--root', app.root, '--instance', 'recovered', '--trust', '0'.repeat(64), ...nodeArgs], /reviewed content/);
  const attached = await cli(['reattach', '--root', app.root, '--instance', 'recovered', '--trust', review.digest, ...nodeArgs]);
  assert.equal(attached.detached, false); assert.equal(attached.startsModules, false);
  assert.deepEqual(await readFile(join(recovered.stateDir, 'programs/fixture/provider.bin')), data);
  app.record('real-cli-private-maintenance', { backupSha256: inspection.sha256, sourceInstance: 'original', restoredInstance: 'recovered', preservedBytes: data.length, modulesExecuted: false });
});
