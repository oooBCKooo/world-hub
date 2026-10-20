import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLock, inspectPackage, validatePack } from '../../../scripts/runtime/package.mjs';
import { PACK_LINEAGE_FORMAT, validatePackLineage, summarizePackLineage, customizePackLineage } from '../../../scripts/runtime/pack-lineage.mjs';
import { summarizePack } from '../../../scripts/runtime/pack-paradigms.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';

const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64), now = '2026-10-16T10:15:00.000Z';
const basePack = () => ({ format: 'world-hub.pack/v1', id: 'lineage.fixture', version: '1.0.0', title: 'Lineage fixture', license: 'MIT',
  topics: { events: 'lineage/events' }, components: [{ id: 'entry', module: 'lineage.fixture', after: [], settings: {}, bridges: { main: { publish: ['events'], subscribe: [] } } }],
  bindings: [], entry: { component: 'entry' }, startupTimeoutMs: 1000, healthTimeoutMs: 1000, stopTimeoutMs: 1000 });
const selfCreated = () => ({ format: PACK_LINEAGE_FORMAT, kind: 'self-created' });
const customized = () => ({ format: PACK_LINEAGE_FORMAT, kind: 'customized', base: { id: 'lineage.fixture', version: '1.0.0', sourceDigest: revision }, revision: 1, customizedAt: now });

test('unmarked sources stay unmarked and self-created declarations cannot claim a source baseline', () => {
  const pack = basePack(); assert.doesNotThrow(() => validatePack(pack));
  assert.equal(validatePackLineage(pack), null); assert.equal(summarizePackLineage(pack), null);
  assert.equal(Object.hasOwn(summarizePack(pack), 'lineage'), false);
  pack.lineage = selfCreated(); assert.doesNotThrow(() => validatePack(pack));
  assert.deepEqual(summarizePack(pack).lineage, selfCreated());
  assert.throws(() => validatePack({ ...pack, lineage: { ...selfCreated(), base: customized().base } }), { code: 'PACK_LINEAGE_INVALID' });
});

test('first customization declares the precise original authoring baseline and keeps the deployable version separate', () => {
  const original = basePack(), unchanged = structuredClone(original);
  const lineage = customizePackLineage(original, revision, '1.0.1', { now });
  assert.deepEqual(lineage, customized()); assert.deepEqual(original, unchanged);
  const changed = { ...original, version: '1.0.1', lineage };
  assert.doesNotThrow(() => validatePack(changed));
  const summary = summarizePack(changed); assert.equal(summary.version, '1.0.1'); assert.equal(summary.lineage.base.version, '1.0.0');
  summary.lineage.base.version = '9.9.9'; assert.equal(changed.lineage.base.version, '1.0.0', 'Public summary must not mutate source lineage');
});

test('successive customization retains its first baseline, increments revision, and supports distinct derived IDs', () => {
  const original = { ...basePack(), version: '1.0.1', lineage: customized() };
  const next = customizePackLineage(original, nextRevision, '1.0.2', { now: () => new Date('2026-10-16T11:00:00.000Z') });
  assert.deepEqual(next.base, original.lineage.base); assert.equal(next.revision, 2); assert.equal(next.customizedAt, '2026-10-16T11:00:00.000Z');
  const derived = customizePackLineage(original, nextRevision, '0.1.0', { now, packId: 'lineage.derived' });
  assert.deepEqual(derived.base, original.lineage.base); assert.equal(derived.revision, 2);
  assert.doesNotThrow(() => validatePack({ ...original, id: 'lineage.derived', version: '0.1.0', lineage: derived }));
});

test('self-created same-ID saves retain their identity while a new derived package declares its original source', () => {
  const original = { ...basePack(), lineage: selfCreated() };
  assert.deepEqual(customizePackLineage(original, revision, '1.0.1', { now }), selfCreated());
  const derived = customizePackLineage(original, revision, '0.1.0', { now, packId: 'lineage.derived' });
  assert.deepEqual(derived, customized());
});

test('lineage rejects unsupported trust claims, incomplete fields, invalid bounded values and impossible timestamps', () => {
  const bad = [null, [], {}, { ...customized(), official: true }, { ...customized(), kind: 'official' },
    { ...customized(), format: 'world-hub.pack-lineage/v0' }, { ...customized(), revision: 0 }, { ...customized(), revision: 1.5 },
    { ...customized(), revision: Number.MAX_SAFE_INTEGER + 1 }, { ...customized(), customizedAt: '2026-02-30T10:15:00.000Z' },
    { ...customized(), customizedAt: '2026-10-16T10:15:00Z' }, { ...customized(), customizedAt: '2026-10-16T18:15:00.000+08:00' },
    ...[{ id: '../source' }, { id: 'x'.repeat(65) }, { version: 'latest' }, { version: '1.0.0+build' }, { version: '1'.repeat(129) },
      { sourceDigest: 'sha256:' + revision }, { sourceDigest: revision.toUpperCase() }, { official: true }, { source: 'https://example.invalid/' }]
      .map(patch => ({ ...customized(), base: { ...customized().base, ...patch } }))];
  for (const lineage of bad) assert.throws(() => validatePack({ ...basePack(), lineage }), { code: 'PACK_LINEAGE_INVALID' }, JSON.stringify(lineage));
  for (const field of ['base', 'revision', 'customizedAt']) { const lineage = customized(); delete lineage[field]; assert.throws(() => validatePackLineage({ lineage }), { code: 'PACK_LINEAGE_INVALID' }); }
  assert.throws(() => validatePack({ ...basePack(), upstream: { official: true } }), /unsupported fields/);
  assert.throws(() => validatePack({ ...basePack(), customization: { customVersion: '2.0.0' } }), /unsupported fields/);
  assert.throws(() => customizePackLineage(basePack(), 'unreviewed', '1.0.1', { now }), { code: 'PACK_LINEAGE_INVALID' });
  assert.throws(() => customizePackLineage(basePack(), revision, 'latest', { now }), { code: 'PACK_LINEAGE_INVALID' });
  assert.throws(() => customizePackLineage(basePack(), revision, '1.0.1', { now: new Date(NaN) }), { code: 'PACK_LINEAGE_INVALID' });
  assert.throws(() => customizePackLineage({ ...basePack(), lineage: { ...customized(), revision: Number.MAX_SAFE_INTEGER } }, revision, '1.0.1', { now }), { code: 'PACK_LINEAGE_INVALID' });
});

test('real package locks cover lineage bytes and tampered metadata requires a fresh lock and review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-lineage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'modules', 'fixture'); await mkdir(source, { recursive: true });
  const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
  await save(join(source, 'module.json'), { format: 'world-hub.module/v1', id: 'lineage.fixture', version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
    runtime: { kind: 'node', entry: 'entry.mjs' }, bridges: ['main'], provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
  await writeFile(join(source, 'entry.mjs'), 'export {};\n');
  const pack = { ...basePack(), version: '1.0.1', lineage: customized() };
  await save(join(directory, 'pack.json'), pack);
  const firstLock = await createLock(directory, { nodePath: process.execPath });
  const firstReview = await inspectPackage(directory, { nodePath: process.execPath });
  assert.equal(firstLock.pack.sha256, hash(await readFile(join(directory, 'pack.json'))));
  pack.lineage.customizedAt = '2026-10-16T11:00:00.000Z'; await save(join(directory, 'pack.json'), pack);
  await assert.rejects(inspectPackage(directory, { nodePath: process.execPath }), /content hash mismatch/);
  const nextLock = await createLock(directory, { nodePath: process.execPath });
  const nextReview = await inspectPackage(directory, { nodePath: process.execPath });
  assert.notEqual(nextLock.pack.sha256, firstLock.pack.sha256); assert.notEqual(nextReview.digest, firstReview.digest);
  assert.equal(nextReview.pack.lineage.customizedAt, pack.lineage.customizedAt);
});
