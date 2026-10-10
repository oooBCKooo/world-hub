import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, lstat, unlink, readdir, realpath } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectAuthoring, derivePackage, rebuildPackage, exportProposal, applyProposal, readComments, addComment, exportComments, importComments } from '../../../scripts/runtime/authoring.mjs';
import { readSourceIndex, publishArtifact, fetchSourceArtifact, validateSourceIndex } from '../../../scripts/runtime/sources.mjs';
import { createLock, importPackage } from '../../../scripts/runtime/package.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const environment = { nodePath: process.execPath, pythonPath: process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3') };
const options = { timeout: 90000, concurrency: false };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const agreed = { redistributionAcknowledged: true, ...environment };
async function setup(t, sample = false) {
  const root = await mkdtemp(join(tmpdir(), 'world-hub-authoring-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('world-hub-authoring-'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, 'source');
  if (sample) await cp(join(repository, 'examples/ecosystem-pack'), directory, { recursive: true });
  else {
    await mkdir(join(directory, 'modules/one'), { recursive: true });
    await save(join(directory, 'pack.json'), { format: 'world-hub.pack/v1', id: 'creator.fixture', version: '1.0.0', title: 'Creator fixture', license: 'MIT',
      topics: { input: 'creator/input' }, components: [{ id: 'one', module: 'creator.one', after: [], settings: {}, bridges: { main: { publish: ['input'], subscribe: ['input'] } } }],
      bindings: [], entry: { component: 'one' }, startupTimeoutMs: 1000, healthTimeoutMs: 1000, stopTimeoutMs: 1000 });
    await save(join(directory, 'modules/one/module.json'), { format: 'world-hub.module/v1', id: 'creator.one', version: '1.0.0', license: 'MIT',
      platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [],
      permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
    await writeFile(join(directory, 'modules/one/program.mjs'), 'throw new Error("Distribution operations must never execute this module");\n');
  }
  await createLock(directory, environment); return { root, directory, model: await inspectAuthoring(directory, environment) };
}

test('CREATOR-01 real derived JS/Python pack runs with a contract-compatible independent module replacement', options, async t => {
  const app = await setup(t, true), replacement = join(app.root, 'alternative-statistics');
  await cp(join(app.directory, 'modules/stats'), replacement, { recursive: true });
  const manifest = await json(join(replacement, 'module.json')); manifest.id = 'creator.statistics'; manifest.version = '1.0.1';
  await save(join(replacement, 'module.json'), manifest);
  const pack = app.model.pack; pack.id = 'creator.derived'; pack.version = '1.1.0'; pack.components.find(c => c.id === 'source').settings.text = '派生模块 🌍';
  const derived = await derivePackage(app.directory, { ...agreed, expectedRevision: app.model.revision, destination: join(app.root, 'derived'), pack,
    replacements: [{ componentId: 'stats', moduleDirectory: replacement }] });
  assert.equal(derived.requiresNewExecutionReview, true); assert.notEqual(derived.revision, app.model.revision);
  assert.equal(derived.pack.components.find(c => c.id === 'stats').module, 'creator.statistics');
  assert.equal((await json(join(app.directory, 'pack.json'))).id, 'demo.polyglot', 'Source is immutable');
  const imported = await importPackage(derived.directory, { root: join(app.root, 'runtime'), instanceId: 'derived', ...environment });
  const session = await startInstance({ root: join(app.root, 'runtime'), instanceId: 'derived', trust: imported.digest, ...environment });
  t.after(() => session.close());
  const response = await fetch(new URL('/analyze', session.ready.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.result.provider, 'creator.statistics'); assert.equal(result.result.text, '派生模块 🌍');
  assert.equal(result.result.output.codePoints, [...'派生模块 🌍'].length);
  await session.close(); assert.equal((await session.status()).state, 'stopped');
});

test('CREATOR-02 mismatched contracts and bridge slots are rejected before creating output', options, async t => {
  const app = await setup(t, true), replacement = join(app.root, 'wrong');
  await cp(join(app.directory, 'modules/stats'), replacement, { recursive: true });
  const manifest = await json(join(replacement, 'module.json')); manifest.provides[0].version = '2.0.0'; await save(join(replacement, 'module.json'), manifest);
  const destination = join(app.root, 'rejected');
  await assert.rejects(derivePackage(app.directory, { ...agreed, destination, replacements: [{ componentId: 'stats', moduleDirectory: replacement }] }), /contract binding/);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  manifest.provides[0].version = '1.0.0'; manifest.bridges = ['different']; await save(join(replacement, 'module.json'), manifest);
  await assert.rejects(derivePackage(app.directory, { ...agreed, destination, replacements: [{ componentId: 'stats', moduleDirectory: replacement }] }), /bridge slots/);
});

test('CREATOR-03 visual model edits validate dependencies, preserve source and require explicit redistribution', options, async t => {
  const app = await setup(t); const pack = structuredClone(app.model.pack); pack.components[0].settings = { greeting: 'Shared setting' };
  await assert.rejects(derivePackage(app.directory, { ...environment, destination: join(app.root, 'no-consent'), pack }), /redistribution rights/);
  await assert.rejects(derivePackage(app.directory, { ...agreed, destination: join(app.root, 'secret'), pack: { ...pack,
    components: [{ ...pack.components[0], settings: { apiToken: 'never-share' } }] } }), /sensitive configuration/);
  await assert.rejects(derivePackage(app.directory, { ...agreed, destination: join(app.root, 'conflict'), expectedRevision: '0'.repeat(64), pack }), /revision conflict/);
  const derived = await derivePackage(app.directory, { ...agreed, destination: join(app.root, 'derived'), pack });
  assert.equal(derived.pack.components[0].settings.greeting, 'Shared setting');
  await assert.rejects(derivePackage(app.directory, { ...agreed, destination: derived.directory }), /exist|EEXIST/i);
  pack.components[0].after = ['one'];
  await assert.rejects(derivePackage(app.directory, { ...agreed, destination: join(app.root, 'bad-graph'), pack }), /dependency/);
});

test('CREATOR-04 offline proposal exchange checks optimistic base revisions and artifact changes', options, async t => {
  const app = await setup(t), pack = structuredClone(app.model.pack); pack.title = 'Collaborator proposal';
  await assert.rejects(exportProposal(app.directory, { ...agreed, expectedRevision: '0'.repeat(64), destination: join(app.root, 'stale-proposal'), pack }), /revision conflict/);
  await assert.rejects(lstat(join(app.root, 'stale-proposal')), { code: 'ENOENT' });
  const proposal = await exportProposal(app.directory, { ...agreed, destination: join(app.root, 'proposal'), pack });
  const applied = await applyProposal(app.directory, proposal.directory, { ...agreed, expectedRevision: app.model.revision, destination: join(app.root, 'merged') });
  assert.equal(applied.pack.title, pack.title); assert.equal(applied.proposalId, proposal.proposalId);
  const changed = await derivePackage(app.directory, { ...agreed, destination: join(app.root, 'changed'), pack: { ...pack, title: 'Concurrent change' } });
  await assert.rejects(applyProposal(changed.directory, proposal.directory, { ...agreed, destination: join(app.root, 'conflict') }), /revision conflict/);
  const altered = await json(join(proposal.artifact, 'pack.json')); altered.title = 'Tampered'; await save(join(proposal.artifact, 'pack.json'), altered);
  await createLock(proposal.artifact, environment);
  await assert.rejects(applyProposal(app.directory, proposal.directory, { ...agreed, destination: join(app.root, 'tampered') }), /content changed/);
});

test('CREATOR-05 comments export/import supports offline collaboration, stale updates and conflicting IDs', options, async t => {
  const app = await setup(t), initial = await readComments(app.directory);
  const text = '<img src=x onerror=alert(1)>\n评论只作为文本';
  const current = await addComment(app.directory, { author: 'Developer A', text, expectedRevision: initial.revision });
  assert.equal(current.comments[0].text, text);
  await assert.rejects(addComment(app.directory, { author: 'Developer B', text: 'stale', expectedRevision: initial.revision }), /revision conflict/);
  const exchange = join(app.root, 'comments.json'); await exportComments(app.directory, { destination: exchange });
  const other = await derivePackage(app.directory, { ...agreed, destination: join(app.root, 'other') });
  const empty = await readComments(other.directory);
  const imported = await importComments(other.directory, exchange, { expectedRevision: empty.revision });
  assert.equal(imported.comments[0].text, text);
  const again = await importComments(other.directory, exchange, { expectedRevision: imported.revision }); assert.equal(again.comments.length, 1);
  const altered = await json(exchange); altered.comments[0].text = 'same ID, conflicting text'; await save(exchange, altered);
  await assert.rejects(importComments(other.directory, exchange, { expectedRevision: again.revision }), /ID conflict/);
});

test('SOURCES-01 pack and module publication, retrieval and offline cache work without executing entries', options, async t => {
  const app = await setup(t); const cacheRoot = join(app.root, 'cache');
  const marker = join(app.root, 'entry-was-executed');
  await writeFile(join(app.directory, 'modules/one/program.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unauthorized execution');\n`);
  await createLock(app.directory, environment); app.model = await inspectAuthoring(app.directory, environment);
  for (const kind of ['pack', 'module']) {
    const publication = await publishArtifact(kind === 'pack' ? app.directory : join(app.directory, 'modules/one'),
      { ...agreed, destination: join(app.root, `${kind}-publication`), kind });
    assert.equal(publication.publishedRemotely, false);
    const source = await readSourceIndex(publication.indexPath), entry = source.index.entries[0];
    const fetched = await fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot });
    assert.equal(fetched.kind, kind); assert.equal(fetched.startsModules, false); assert.equal(fetched.cached, false);
    if (kind === 'pack') assert.equal((await inspectAuthoring(fetched.directory, environment)).revision, app.model.revision);
    await unlink(publication.indexPath);
    const offline = await fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot });
    assert.equal(offline.cached, true); assert.equal(offline.offline, true);
    assert.equal(offline.networkPolicy, 'public-ipv4');
    await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot, allowPrivateNetwork: true }), /network policy/);
  }
  await assert.rejects(lstat(marker), { code: 'ENOENT' }, 'Source publication, inspection and retrieval cannot execute downloaded entries');
});

test('SOURCES-02 source changes, digest mismatch, unsafe paths and private URLs are rejected', options, async t => {
  const app = await setup(t), publication = await publishArtifact(app.directory, { ...agreed, destination: join(app.root, 'publication'), kind: 'pack' });
  const source = await readSourceIndex(publication.indexPath), index = structuredClone(source.index);
  await assert.rejects(readSourceIndex(publication.indexPath, { expectedSha256: '0'.repeat(64) }), /hash mismatch/);
  index.title = 'Changed source'; await save(publication.indexPath, index);
  await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, source.index.entries[0].entryId, { cacheRoot: join(app.root, 'cache') }), /index changed/);
  index.entries[0].source = { path: '../outside.json' }; assert.throws(() => validateSourceIndex(index), /Unsafe relative/);
  for (const url of ['http://example.com/artifact.json', 'https://127.0.0.1/artifact.json', 'https://user:secret@example.com/artifact.json', 'https://[::1]/artifact.json', 'https://[2001:db8::1]/artifact.json', 'https://[2002:7f00:1::1]/artifact.json']) {
    index.entries[0].source = { url }; assert.throws(() => validateSourceIndex(index), /HTTPS|local or private/);
  }
  for (const url of ['https://10.2.3.4/artifact.json', 'https://172.16.0.5/artifact.json', 'https://192.168.2.3/artifact.json', 'https://198.18.0.39/artifact.json']) {
    index.entries[0].source = { url };
    assert.throws(() => validateSourceIndex(index), /local or private/);
    assert.equal(validateSourceIndex(index, { allowPrivateNetwork: true }), index);
  }
  for (const url of ['https://127.0.0.1/artifact.json', 'https://0.0.0.0/artifact.json', 'https://169.254.169.254/artifact.json', 'https://224.0.0.1/artifact.json', 'https://[::ffff:127.0.0.1]/artifact.json']) {
    index.entries[0].source = { url }; assert.throws(() => validateSourceIndex(index, { allowPrivateNetwork: true }), /local or private/);
  }
});

test('SOURCES-03 tampered downloaded contents and poisoned cache are rejected instead of silently repaired', options, async t => {
  const app = await setup(t), cacheRoot = join(app.root, 'cache');
  const publication = await publishArtifact(app.directory, { ...agreed, destination: join(app.root, 'publication'), kind: 'pack' });
  const source = await readSourceIndex(publication.indexPath), entry = source.index.entries[0];
  const bytes = await readFile(publication.artifactPath); await writeFile(publication.artifactPath, Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot }), /artifact hash mismatch/);
  await writeFile(publication.artifactPath, bytes);
  const fetched = await fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot });
  await writeFile(join(fetched.directory, 'unlocked-secret'), 'must reject altered cache');
  await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot }), /file set changed/);
  await unlink(publication.indexPath);
  const cachedIndex = join(cacheRoot, `index-${source.digest}.json`), poisoned = await json(cachedIndex);
  poisoned.indexBase64 = Buffer.from(JSON.stringify({ ...source.index, title: 'Poisoned' })).toString('base64'); await save(cachedIndex, poisoned);
  await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot }), /Offline source index hash mismatch/);
});

test('SOURCES-04 malicious artifacts never traverse paths or extract unreviewed files', options, async t => {
  const app = await setup(t), publication = await publishArtifact(app.directory, { ...agreed, destination: join(app.root, 'publication'), kind: 'pack' });
  const artifact = await json(publication.artifactPath); artifact.files[0].path = '../escape';
  const bytes = Buffer.from(JSON.stringify(artifact)); await writeFile(publication.artifactPath, bytes);
  const index = await json(publication.indexPath); index.entries[0].sha256 = hash(bytes); await save(publication.indexPath, index);
  const source = await readSourceIndex(publication.indexPath);
  await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, index.entries[0].entryId, { cacheRoot: join(app.root, 'cache') }), /Unsafe relative/);
  await assert.rejects(lstat(join(app.root, 'escape')), { code: 'ENOENT' });
});

test('CREATOR-06 cancelled authoring and publication do not create destinations', options, async t => {
  const app = await setup(t), signal = AbortSignal.abort(new Error('Cancelled by user'));
  const destination = join(app.root, 'cancelled');
  await assert.rejects(derivePackage(app.directory, { ...agreed, destination, signal }), /Cancelled by user/);
  await assert.rejects(publishArtifact(app.directory, { ...agreed, destination, kind: 'pack', signal }), /Cancelled by user/);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('CREATOR-07 explicit old-lock rebuild copies verified files into a new current-environment package', options, async t => {
  const app = await setup(t), lockFile = join(app.directory, 'pack.lock');
  const old = await json(lockFile); old.hubVersion = '0.1.0'; old.runtimes.node.version = '1.0.0'; await save(lockFile, old);
  const before = await readFile(lockFile);
  await assert.rejects(inspectAuthoring(app.directory, environment), /Hub version mismatch/);
  await assert.rejects(rebuildPackage(app.directory, { ...environment, destination: join(app.root, 'no-ack') }), /redistribution rights/);
  const rebuilt = await rebuildPackage(app.directory, { ...agreed, destination: join(app.root, 'rebuilt') });
  assert.equal(rebuilt.oldRequirements.hubVersion, '0.1.0'); assert.equal(rebuilt.oldRequirements.runtimes.node.version, '1.0.0');
  assert.equal(rebuilt.newRequirements.runtimes.node.version, process.versions.node); assert.equal(rebuilt.requiresNewExecutionReview, true);
  assert.equal(rebuilt.provenance.operation, 'explicit-lock-rebuild'); assert.deepEqual(await readFile(lockFile), before);
  assert.equal(rebuilt.startsModules, false);
  await writeFile(join(app.directory, 'modules/one/program.mjs'), 'tampered source');
  await assert.rejects(rebuildPackage(app.directory, { ...agreed, destination: join(app.root, 'tampered') }), /file hash or file set mismatch/);
  await assert.rejects(lstat(join(app.root, 'tampered')), { code: 'ENOENT' });
});

test('SOURCES-05 cancellation after actual staging writes removes partial state and retry succeeds', options, async t => {
  const app = await setup(t), cacheRoot = join(app.root, 'cache'); await mkdir(cacheRoot);
  for (let i = 0; i < 80; i++) await writeFile(join(app.directory, 'modules/one', `file-${String(i).padStart(3, '0')}.txt`), Buffer.alloc(65536, i));
  await createLock(app.directory, environment);
  const publication = await publishArtifact(app.directory, { ...agreed, destination: join(app.root, 'publication'), kind: 'pack' });
  const source = await readSourceIndex(publication.indexPath), entry = source.index.entries[0], controller = new AbortController();
  let observedWrittenFile = false, polling = false;
  const observer = setInterval(async () => {
    if (polling || observedWrittenFile) return; polling = true;
    try {
      const stage = (await readdir(cacheRoot)).find(name => name.startsWith('.artifact-'));
      if (stage && (await readdir(join(cacheRoot, stage))).length) { observedWrittenFile = true; controller.abort(new Error('Cancelled after first staging write')); }
    } catch {} finally { polling = false; }
  }, 1);
  try { await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot, signal: controller.signal }), /Cancelled after first staging write/); }
  finally { clearInterval(observer); }
  assert.equal(observedWrittenFile, true, 'Cancellation must happen after real writes, not before download');
  assert.ok((await readdir(cacheRoot)).every(name => !name.startsWith('.artifact-') && !name.endsWith('.download.lock') && !name.endsWith('.tmp')));
  const retry = await fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot });
  assert.equal(retry.cached, false); assert.equal((await readdir(cacheRoot)).filter(name => name === entry.sha256).length, 1);
});

test('SOURCES-06 concurrent exact-artifact retrieval is bounded and archive-only cache recovery works offline', options, async t => {
  const app = await setup(t), cacheRoot = join(app.root, 'cache');
  const publication = await publishArtifact(app.directory, { ...agreed, destination: join(app.root, 'publication'), kind: 'pack' });
  const source = await readSourceIndex(publication.indexPath), entry = source.index.entries[0];
  const results = await Promise.allSettled([1, 2].map(() => fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot })));
  assert.ok(results.some(r => r.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'SOURCE_CACHE_BUSY');
  const cached = await fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot });
  assert.equal(cached.cached, true);
  assert.equal(dirname(resolve(cached.directory)), await realpath(cacheRoot));
  await rm(cached.directory, { recursive: true }); // Simulates an archive published before directory commit.
  await unlink(publication.indexPath);
  const recovered = await fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot });
  assert.equal(recovered.offline, true); assert.equal(recovered.cached, true);
  await writeFile(join(recovered.directory, 'pack.json'), 'poisoned');
  await assert.rejects(fetchSourceArtifact(publication.indexPath, source.digest, entry.entryId, { cacheRoot }), /hash mismatch/);
});
