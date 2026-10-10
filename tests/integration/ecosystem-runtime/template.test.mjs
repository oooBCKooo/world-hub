import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, cp, unlink, rm, symlink } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { createLock, inspectPackage, importPackage, startInstance, statusInstance } from '../../../scripts/runtime/runtime.mjs';
import { createTemplate, inspectTemplate, previewTemplate, instantiateTemplate, validateTemplate, validateTemplateFiles } from '../../../scripts/runtime/template.mjs';
import { publishArtifact, readSourceIndex, fetchSourceArtifact, validateArtifactBytes } from '../../../scripts/runtime/sources.mjs';
import { WorkshopStore } from '../../../tools/workshop/store.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const clone = value => JSON.parse(JSON.stringify(value));
const save = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const absent = file => assert.rejects(access(file), { code: 'ENOENT' });
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-template-test-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('world-hub-template-test-')); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
function declaration() {
  return { format: 'world-hub.template/v1', id: 'template.test', version: '1.0.0', title: 'Literal business configuration', license: 'MIT', base: 'base', parameters: [
    { name: 'greeting', title: 'Greeting', type: 'string', default: 'Hello 🌍', constraints: { minLength: 1, maxLength: 1024 }, targets: [{ kind: 'setting', component: 'fixture', path: ['greeting'] }] },
    { name: 'count', title: 'Count', type: 'integer', default: 2, constraints: { minimum: 1, maximum: 10 }, targets: [{ kind: 'setting', component: 'fixture', path: ['options', 'count'] }] },
    { name: 'enabled', title: 'Enabled', type: 'boolean', default: true, constraints: {}, targets: [{ kind: 'setting', component: 'fixture', path: ['enabled'] }] },
    { name: 'input-topic', title: 'Input topic', type: 'string', default: 'template/input', constraints: { maxLength: 512 }, targets: [{ kind: 'topic', key: 'input' }] }
  ] };
}
async function fixture(directory) {
  const source = join(directory, 'original'), module = join(source, 'modules/fixture'); await mkdir(module, { recursive: true });
  const sentinel = join(directory, 'PROGRAM_MUST_NOT_RUN');
  await writeFile(join(module, 'program.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed'); throw new Error('Template tooling must never execute this program');\n`);
  await save(join(module, 'module.json'), { format: 'world-hub.module/v1', id: 'template.fixture', version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
  const pack = { format: 'world-hub.pack/v1', id: 'test.pack', version: '1.0.0', title: 'Template base', license: 'MIT', topics: { input: 'base/input' },
    components: [{ id: 'fixture', module: 'template.fixture', after: [], settings: { greeting: 'Base', options: { count: 1 }, enabled: false, filePath: 'fixed/data.json' }, bridges: { main: { publish: ['input'], subscribe: ['input'] } } }],
    bindings: [], entry: { component: 'fixture' }, startupTimeoutMs: 1000, healthTimeoutMs: 1000, stopTimeoutMs: 1000 };
  await save(join(source, 'pack.json'), pack);
  const files = await Promise.all(['module.json', 'program.mjs'].map(async path => ({ path, sha256: hash(await readFile(join(module, path))) })));
  await save(join(source, 'pack.lock'), { format: 'world-hub.pack-lock/v1', pack: { id: pack.id, version: pack.version, sha256: hash(await readFile(join(source, 'pack.json'))) },
    hubVersion: JSON.parse(await readFile(join(root, 'package.json'))).version, platform: { os: process.platform, arch: process.arch }, runtimes: { node: { version: process.versions.node } }, modules: [{ id: 'template.fixture', version: '1.0.0', source: 'modules/fixture', files }] });
  const template = join(directory, 'template'); await createTemplate(source, { destination: template, template: declaration(), redistributionAcknowledged: true });
  return { source, template, sentinel, pack };
}

test('TEMPLATE-01 creates and inspects a separately declared locked composition without executing code or probing interpreters', async t => {
  const directory = await workspace(t), f = await fixture(directory), checked = await inspectTemplate(f.template, { nodePath: '/does/not/exist', pythonPath: '/does/not/exist' });
  assert.equal(checked.manifest.format, 'world-hub.template/v1'); assert.equal(checked.manifest.parameters.length, 4);
  assert.equal(checked.startsModules, false); assert.equal(checked.probesInterpreters, false); assert.equal(checked.writesFiles, false);
  assert.match(checked.revision, /^[a-f0-9]{64}$/); assert.deepEqual(checked.platforms, [`${process.platform}-${process.arch}`]);
  assert.equal(checked.lock.pack.sha256, hash(await readFile(join(f.source, 'pack.json')))); await absent(f.sentinel);
  await assert.rejects(createTemplate(f.source, { destination: join(directory, 'denied'), template: declaration() }), /redistribution/); await absent(join(directory, 'denied'));
});

test('TEMPLATE-02 preview and fresh Pack generation preserve exact module code, runtime versions and ACLs while rebuilding the configuration lock', async t => {
  const directory = await workspace(t), f = await fixture(directory), inspected = await inspectTemplate(f.template);
  const values = { greeting: '你好 ${HOME} $(touch example) ../data', count: 7, enabled: false, 'input-topic': 'custom/literal/input' };
  const identity = { id: 'test.generated', version: '2.0.0', title: 'Generated application' }, preview = await previewTemplate(f.template, { values, identity, expectedRevision: inspected.revision });
  assert.equal(preview.writesFiles, false); assert.equal(preview.pack.components[0].settings.greeting, values.greeting); assert.equal(preview.pack.topics.input, values['input-topic']);
  assert.deepEqual(preview.lock.modules, inspected.lock.modules); assert.deepEqual(preview.lock.runtimes, inspected.lock.runtimes); assert.deepEqual(preview.pack.components[0].bridges, inspected.pack.components[0].bridges);
  assert.notEqual(preview.lock.pack.sha256, inspected.lock.pack.sha256); await absent(f.sentinel);
  const destination = join(directory, 'generated'), generated = await instantiateTemplate(f.template, { destination, values, identity, expectedRevision: inspected.revision, expectedPreviewDigest: preview.previewDigest, redistributionAcknowledged: true });
  assert.equal(generated.lock.pack.sha256, hash(await readFile(join(destination, 'pack.json'))));
  assert.equal(hash(await readFile(join(destination, 'modules/fixture/program.mjs'))), hash(await readFile(join(f.source, 'modules/fixture/program.mjs'))));
  assert.equal(generated.requiresNewExecutionReview, true); assert.equal(generated.provenance.parameterDigest, preview.parameterDigest);
  const normalReview = await inspectPackage(destination); assert.equal(normalReview.pack.id, identity.id); assert.equal(normalReview.startsModules, false); await absent(f.sentinel);
  await assert.rejects(instantiateTemplate(f.template, { destination, redistributionAcknowledged: true }), { code: 'EEXIST' });
});

test('TEMPLATE-03 invalid, unknown, constrained and duplicate parameters are rejected before any destination exists', async t => {
  const directory = await workspace(t), f = await fixture(directory), destination = join(directory, 'invalid');
  for (const values of [{ count: '7' }, { count: 11 }, { count: 1.5 }, { greeting: '' }, { enabled: 1 }, { unexpected: 'value' }, { 'input-topic': 'wild/#' }, { greeting: '\0' }]) {
    await assert.rejects(instantiateTemplate(f.template, { destination, values, redistributionAcknowledged: true })); await absent(destination);
  }
  const invalid = declaration(); invalid.parameters[0].constraints = { enum: ['only'] }; assert.throws(() => validateTemplate(invalid), /enum/);
  const repeated = declaration(); repeated.parameters.push(clone(repeated.parameters[0])); assert.throws(() => validateTemplate(repeated), /Duplicate/);
  const duplicateTarget = declaration(); duplicateTarget.parameters[1].targets = clone(duplicateTarget.parameters[0].targets); assert.throws(() => validateTemplate(duplicateTarget), /Duplicate/);
  const badConstraint = declaration(); badConstraint.parameters[1].constraints = { minimum: 10, maximum: 1 }; assert.throws(() => validateTemplate(badConstraint), /range/);
  await absent(f.sentinel);
});

test('TEMPLATE-04 no parameter can address runtime entries, commands, paths, credentials, ACLs or prototype keys', async t => {
  const directory = await workspace(t), f = await fixture(directory);
  for (const path of [['filePath'], ['command'], ['programEntry'], ['args'], ['cwd'], ['environment'], ['options', 'constructor'], ['apiKey']]) {
    const invalid = declaration(); invalid.parameters[0].targets = [{ kind: 'setting', component: 'fixture', path }];
    await assert.rejects(createTemplate(f.source, { destination: join(directory, 'rejected'), template: invalid, redistributionAcknowledged: true }), /cannot parameterize/); await absent(join(directory, 'rejected'));
  }
  for (const target of [{ kind: 'runtime', component: 'fixture', path: ['entry'] }, { kind: 'bridge', component: 'fixture', path: ['main'] }]) {
    const invalid = declaration(); invalid.parameters[0].targets = [target]; assert.throws(() => validateTemplate(invalid), /only parameterizes/);
  }
  const missing = declaration(); missing.parameters[0].targets[0].path = ['absent']; assert.throws(() => validateTemplate(missing, f.pack), /existing scalar/);
  const wrongType = declaration(); wrongType.parameters = [wrongType.parameters[1]]; wrongType.parameters[0].targets[0].path = ['greeting']; assert.throws(() => validateTemplate(wrongType, f.pack), /type mismatch/); await absent(f.sentinel);
});

test('TEMPLATE-05 changes to selected parameters, identity or Template bytes invalidate reviewed generation', async t => {
  const directory = await workspace(t), f = await fixture(directory), preview = await previewTemplate(f.template), destination = join(directory, 'stale');
  const common = { destination, expectedRevision: preview.templateRevision, expectedPreviewDigest: preview.previewDigest, redistributionAcknowledged: true };
  await assert.rejects(instantiateTemplate(f.template, { ...common, values: { count: 8 } }), /preview conflict/); await absent(destination);
  await assert.rejects(instantiateTemplate(f.template, { ...common, identity: { id: 'changed', version: '1.0.0', title: 'Changed' } }), /preview conflict/); await absent(destination);
  await writeFile(join(f.template, 'README.md'), 'Changed author notes.\n');
  await assert.rejects(instantiateTemplate(f.template, common), /revision conflict/); await absent(destination);
  const fresh = await previewTemplate(f.template, { values: { count: 8 } }); assert.notEqual(fresh.previewDigest, preview.previewDigest); assert.notEqual(fresh.parameterDigest, preview.parameterDigest);
});

test('TEMPLATE-06 publish, discover, fetch, offline reuse and instantiate a Template as the third source object kind', async t => {
  const directory = await workspace(t), f = await fixture(directory), publication = await publishArtifact(f.template, { kind: 'template', destination: join(directory, 'source'), redistributionAcknowledged: true });
  const index = await readSourceIndex(publication.indexPath), entry = index.index.entries[0]; assert.equal(entry.kind, 'template'); assert.deepEqual(entry.provides, []); assert.deepEqual(entry.requires, []);
  const artifact = validateArtifactBytes(await readFile(publication.artifactPath)); assert.equal(artifact.manifest.id, declaration().id); assert.equal(artifact.entry.kind, 'template');
  const cacheRoot = join(directory, 'cache'), fetched = await fetchSourceArtifact(publication.indexPath, index.digest, entry.entryId, { cacheRoot });
  assert.equal(fetched.kind, 'template'); assert.equal(fetched.startsModules, false); assert.equal((await inspectTemplate(fetched.directory)).manifest.id, entry.id);
  await unlink(publication.indexPath); const offline = await fetchSourceArtifact(publication.indexPath, index.digest, entry.entryId, { cacheRoot }); assert.equal(offline.offline, true); assert.equal(offline.cached, true);
  const generated = await instantiateTemplate(offline.directory, { destination: join(directory, 'offline-generated'), values: { count: 5 }, redistributionAcknowledged: true });
  assert.equal(generated.pack.components[0].settings.options.count, 5); await absent(f.sentinel);
});

test('TEMPLATE-07 tampering, unlocked private files, absent runtime locks and traversal targets cannot be published', async t => {
  const directory = await workspace(t), f = await fixture(directory), publication = await publishArtifact(f.template, { kind: 'template', destination: join(directory, 'source'), redistributionAcknowledged: true });
  const original = JSON.parse(await readFile(publication.artifactPath));
  const changed = clone(original), entry = changed.files.find(f => f.path.endsWith('/program.mjs')); entry.base64 = Buffer.from('changed').toString('base64'); entry.sha256 = hash(Buffer.from('changed'));
  assert.throws(() => validateArtifactBytes(changed), /module hash/);
  const extra = clone(original); extra.files.push({ path: 'base/private.json', sha256: hash(Buffer.from('{}')), base64: Buffer.from('{}').toString('base64') }); assert.throws(() => validateArtifactBytes(extra), /private or unlocked/);
  const traversal = clone(original); traversal.files[0].path = '../template.json'; assert.throws(() => validateArtifactBytes(traversal), /Unsafe relative/);
  const badLock = clone(original), lockFile = badLock.files.find(f => f.path === 'base/pack.lock'), lock = JSON.parse(Buffer.from(lockFile.base64, 'base64')); lock.runtimes = {}; const bytes = Buffer.from(JSON.stringify(lock)); lockFile.base64 = bytes.toString('base64'); lockFile.sha256 = hash(bytes); assert.throws(() => validateArtifactBytes(badLock), /locked runtime/);
  await writeFile(join(f.template, 'unlocked.json'), '{}'); await assert.rejects(inspectTemplate(f.template), /private or unlocked/); await absent(f.sentinel);
});

test('TEMPLATE-08 a hosted Workshop publishes and rediscovers Template metadata durably without executing its code', async t => {
  const directory = await workspace(t), f = await fixture(directory), publication = await publishArtifact(f.template, { kind: 'template', destination: join(directory, 'source'), redistributionAcknowledged: true });
  const artifact = JSON.parse(await readFile(publication.artifactPath)), storeRoot = join(directory, 'workshop');
  let store = await WorkshopStore.open({ root: storeRoot });
  try {
  const author = await store.initializeAdmin('admin', 'template-acceptance-password-2026'), published = await store.publish(author, { artifact, redistributionAcknowledged: true });
  assert.equal(published.entry.kind, 'template'); assert.equal(store.catalog({ kind: 'template' }).total, 1); assert.equal(store.catalog({ kind: 'module' }).total, 0);
  const entry = store.index('https://example.test/workshop').entries[0]; assert.equal(entry.kind, 'template'); assert.match(entry.source.url, /^https:\/\/example.test\/workshop\/artifacts\//);
  assert.equal(validateArtifactBytes(await store.artifactBytes(published.entry.sha256)).artifact.kind, 'template');
  await store.close(); store = await WorkshopStore.open({ root: storeRoot }); assert.equal(store.catalog({ kind: 'template' }).total, 1); await absent(f.sentinel);
  } finally { await store.close(); }
});

test('TEMPLATE-09 symbolic source aliases and cached code changes are rejected without writing a generated Pack', async t => {
  const directory = await workspace(t), f = await fixture(directory), alias = join(directory, 'alias'); await symlink(f.template, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectTemplate(alias), /Symbolic|reparse/);
  await writeFile(join(f.template, 'base/modules/fixture/program.mjs'), '// changed\n');
  await assert.rejects(instantiateTemplate(f.template, { destination: join(directory, 'rejected'), redistributionAcknowledged: true }), /module hash/); await absent(join(directory, 'rejected')); await absent(f.sentinel);
});

test('TEMPLATE-11 public declaration example and independent schema describe the complete static Template contract', async () => {
  const schema = JSON.parse(await readFile(join(root, 'docs/ecosystem/template.schema.json'))), example = JSON.parse(await readFile(join(root, 'docs/ecosystem/template.example.json'))), pack = JSON.parse(await readFile(join(root, 'examples/ecosystem-pack/pack.json')));
  assert.equal(schema.properties.format.const, 'world-hub.template/v1'); assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.base.const, 'base');
  assert.equal(validateTemplate(example, pack), example); assert.equal(example.parameters.length, 2);
  assert.throws(() => validateTemplateFiles([{ path: 'base/pack.json', bytes: Buffer.from('{}') }, { path: 'base/pack.json/child', bytes: Buffer.from('{}') }]), /file\/directory collision/);
});

test('TEMPLATE-10 generated three-program cross-language Pack returns the parameterized real business result after explicit execution review', { timeout: 120000, concurrency: false }, async t => {
  const directory = await workspace(t), sample = join(directory, 'sample'); await cp(join(root, 'examples/ecosystem-pack'), sample, { recursive: true });
  const environment = { nodePath: process.execPath, pythonPath: process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3') }; await createLock(sample, environment);
  const template = { format: 'world-hub.template/v1', id: 'demo.text-template', version: '1.0.0', title: 'Reusable text workbench', license: 'MIT', base: 'base', parameters: [
    { name: 'text', title: 'Initial text', type: 'string', default: 'Template default', constraints: { maxLength: 4096 }, targets: [{ kind: 'setting', component: 'source', path: ['text'] }] },
    { name: 'source-topic', title: 'Source communication topic', type: 'string', default: 'template/text/read', constraints: { minLength: 1, maxLength: 512 }, targets: [{ kind: 'topic', key: 'source' }] }
  ] };
  const original = await createTemplate(sample, { destination: join(directory, 'template'), template, redistributionAcknowledged: true });
  const published = await publishArtifact(original.directory, { kind: 'template', destination: join(directory, 'publication'), redistributionAcknowledged: true }), index = await readSourceIndex(published.indexPath);
  const fetched = await fetchSourceArtifact(published.indexPath, index.digest, index.index.entries[0].entryId, { cacheRoot: join(directory, 'cache') });
  const text = '由共享模板组合 🌍\nindependent programs', selected = await previewTemplate(fetched.directory, { values: { text } });
  const generated = await instantiateTemplate(fetched.directory, { destination: join(directory, 'generated'), values: { text }, expectedPreviewDigest: selected.previewDigest, redistributionAcknowledged: true });
  assert.deepEqual(generated.lock.modules, original.lock.modules);
  const instanceRoot = join(directory, 'instances'), imported = await importPackage(generated.directory, { root: instanceRoot, instanceId: 'template-application', ...environment });
  const session = await startInstance({ root: instanceRoot, instanceId: imported.instanceId, trust: imported.digest, ...environment });
  try {
    const response = await fetch(new URL('/analyze', session.ready.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) }), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true); assert.equal(body.result.text, text);
    assert.deepEqual(body.result.output, { codePoints: [...text].length, lines: text.split('\n').length, utf8Bytes: Buffer.byteLength(text), sha256: hash(Buffer.from(text)) }); assert.equal(body.result.receipts.length, 2);
    assert.equal((await session.status()).state, 'running');
    t.diagnostic('TEMPLATE_BUSINESS ' + JSON.stringify({ languages: ['node', 'python', 'node'], templateRevision: selected.templateRevision, generatedPackSha256: generated.lock.pack.sha256, output: body.result.output, receipts: body.result.receipts.length }));
  } finally { await session.close(); }
  assert.equal((await statusInstance({ root: instanceRoot, instanceId: imported.instanceId })).state, 'stopped');
});
