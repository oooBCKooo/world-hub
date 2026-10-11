import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, open, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generatePublisherKey, signPublisherEvidence, verifyPublisherEvidence, parsePublisherEvidence, parsePublisherJson,
  canonicalPublisherJson, canonicalPublisherPayload, publisherKeyId } from '../../../scripts/runtime/publisher-trust.mjs';
import { readPublisherTrust, previewPublisherTrustChange, applyPublisherTrustChange, verifyStoredPublisherEvidence } from '../../../scripts/runtime/publisher-store.mjs';
import { parsePublisherArgs, runPublisher } from '../../../scripts/runtime/publisher-cli.mjs';

const now = '2026-10-11T03:00:00.000Z', issuedAt = '2026-10-11T02:00:00.000Z', expiresAt = '2026-11-10T02:00:00.000Z';
const artifact = { kind: 'module', id: 'author.example-text', version: '1.2.3', sha256: createHash('sha256').update('actual immutable bytes').digest('hex') };
const issuer = 'author.example';
const signed = (key, type = 'artifact', sequence = 1, details = {}, overrides = {}) => signPublisherEvidence({ payload: { type, issuer, keyId: key.keyId, sequence, issuedAt, expiresAt, subject: type === 'artifact' ? artifact : { kind: 'publisher', id: issuer }, details, ...overrides }, privateKeys: [key.privateKeyPem] });
const bytes = value => Buffer.from(JSON.stringify(value));
async function workspace(t) { const root = await mkdtemp(join(tmpdir(), 'world-hub-publisher-')); t.after(async () => { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); }); return root; }
const changeFor = (key, role = 'publisher') => ({ action: 'anchor', issuer, publicKey: key.publicKey, role, identityBasis: { type: 'public-key-fingerprint', note: 'Test operator independently compared fingerprint.' }, validFrom: issuedAt });
async function anchor(root, key, role = 'publisher') { const change = changeFor(key, role), p = await previewPublisherTrustChange({ root, change, now }); return applyPublisherTrustChange({ root, change, reviewDigest: p.reviewDigest, now }); }
const check = (root, evidence, extra = {}) => verifyStoredPublisherEvidence({ root, evidenceBytes: bytes(evidence), artifact, now, sourceStatus: 'online', ...extra });

test('Real Ed25519 signature is unanchored until an explicit digest-bound public-key pin; wrong content and signatures fail', async t => {
  const root = await workspace(t), key = generatePublisherKey(), other = generatePublisherKey(), evidence = signed(key);
  const unanchored = await check(root, evidence);
  assert.equal(unanchored.signatureStatus, 'verified'); assert.equal(unanchored.publisherIdentity, 'unanchored-key'); assert.equal(unanchored.accepted, false); assert.equal((await readPublisherTrust({ root })).revision, 0);
  const change = changeFor(key), preview = await previewPublisherTrustChange({ root, change, now });
  assert.equal(preview.summary.grantsExecution, false);
  await assert.rejects(applyPublisherTrustChange({ root, change, reviewDigest: 'a'.repeat(64), now }), { code: 'TRUST_REVIEW_REQUIRED' });
  assert.equal((await readPublisherTrust({ root })).revision, 0);
  await applyPublisherTrustChange({ root, change, reviewDigest: preview.reviewDigest, now });
  const report = await check(root, evidence); assert.equal(report.accepted, true); assert.equal(report.contentIntegrity, 'verified'); assert.equal(report.grantsExecution, false); assert.equal(report.startsModules, false);
  const badSignature = structuredClone(evidence); badSignature.signatures[0].value = Buffer.alloc(64).toString('base64');
  assert.equal((await check(root, badSignature)).error.code, 'INVALID_SIGNATURE');
  const fakeKey = structuredClone(evidence); fakeKey.publicKeys[0].publicKey = other.publicKey;
  assert.equal((await check(root, fakeKey)).error.code, 'KEY_FINGERPRINT_MISMATCH');
  for (const edit of [{ kind: 'pack' }, { id: 'other.id' }, { version: '1.2.4' }, { sha256: 'a'.repeat(64) }]) assert.equal((await check(root, evidence, { artifact: { ...artifact, ...edit } })).error.code, 'ARTIFACT_MISMATCH');
  const repeated = await check(root, evidence, { now: '2026-10-11T03:05:00.000Z' }); assert.equal(repeated.sequenceStatus, 'known-statement'); assert.equal(repeated.revision, report.revision);
});

test('Strict bounded UTF-8 parser rejects duplicate keys, non-safe numeric forms, malformed strings, algorithms, and open fields', () => {
  for (const json of ['{"format":"x","format":"y"}', '{"sequence":-0}', '{"sequence":0.0}', '{"sequence":1e3}', '{"sequence":9007199254740992}', '{"value":"\\ud800"}', '{"value":"\\udc00"}', '{"__proto__":{}}', '{"value":1,}']) assert.throws(() => parsePublisherJson(Buffer.from(json)));
  assert.throws(() => parsePublisherJson(Buffer.from([0xc0, 0xaf])), { code: 'INVALID_UTF8' });
  assert.throws(() => parsePublisherJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])), { code: 'INVALID_JSON' });
  assert.throws(() => parsePublisherJson(Buffer.alloc(262145, 32)), { code: 'EVIDENCE_TOO_LARGE' });
  assert.throws(() => canonicalPublisherJson({ value: -0 }), { code: 'INVALID_NUMBER' });
  const key = generatePublisherKey(), evidence = signed(key);
  for (const mutate of [x => { x.extra = true; }, x => { x.payload.details.extra = 'no'; }, x => { x.signatures[0].algorithm = 'RSA'; }, x => { x.signatures.push(x.signatures[0]); }, x => { x.signatures[0].value = x.signatures[0].value.replace(/=$/, ''); }, x => { x.payload.type = 'new-type'; }]) { const v = structuredClone(evidence); mutate(v); assert.throws(() => parsePublisherEvidence(bytes(v))); }
  const stringEvidence = JSON.stringify(evidence, null, 2); assert.equal(parsePublisherEvidence(stringEvidence).payload.sequence, 1);
});

test('Dual-signed rotation retires the old publisher; a new key cannot self-anchor or rotate with only one signature', async t => {
  const root = await workspace(t), old = generatePublisherKey(), next = generatePublisherKey(); await anchor(root, old); await check(root, signed(old));
  const payload = { type: 'key-rotation', issuer, keyId: old.keyId, sequence: 2, issuedAt, expiresAt, subject: { kind: 'publisher', id: issuer }, details: { oldKeyId: old.keyId, newKeyId: next.keyId, newPublicKey: next.publicKey, effectiveAt: now } };
  const one = signPublisherEvidence({ payload, privateKeys: [old.privateKeyPem] }); assert.equal((await check(root, one, { artifact: undefined })).error.code, 'MISSING_ROTATION_PROOF');
  const rotation = signPublisherEvidence({ payload, privateKeys: [old.privateKeyPem, next.privateKeyPem] });
  const changed = await check(root, rotation, { artifact: undefined }); assert.equal(changed.accepted, true);
  assert.equal((await check(root, rotation, { artifact: undefined })).revision, changed.revision);
  assert.equal((await check(root, signed(old, 'artifact', 3))).error.code, 'INACTIVE_KEY');
  const result = await check(root, signed(next, 'artifact', 3, {}, { issuedAt: now })); assert.equal(result.accepted, true); assert.equal(result.identityBasis.type, 'dual-signed-rotation');
  const fork = generatePublisherKey(); const conflict = signPublisherEvidence({ payload: { ...payload, sequence: 4, details: { ...payload.details, newKeyId: fork.keyId, newPublicKey: fork.publicKey } }, privateKeys: [old.privateKeyPem, fork.privateKeyPem] }); assert.equal((await check(root, conflict, { artifact: undefined })).accepted, false);
});

test('Independent pre-pinned recovery revocation persists and a cached old artifact cannot resurrect a revoked key', async t => {
  const root = await workspace(t), key = generatePublisherKey(), recovery = generatePublisherKey(), fake = generatePublisherKey(); await anchor(root, key); await anchor(root, recovery, 'recovery');
  const old = signed(key); await check(root, old);
  const details = { revokedKeyId: key.keyId, effectiveAt: now, reason: 'Publisher reports exposed signing device.' };
  const unauthorized = signed(fake, 'key-revocation', 2, details); assert.equal((await check(root, unauthorized, { artifact: undefined })).publisherIdentity, 'unanchored-key');
  assert.throws(() => signed(key, 'key-revocation', 2, details), { code: 'SELF_REVOCATION_AUTHORITY' });
  const backdated = await check(root, signed(recovery, 'key-revocation', 2, details), { artifact: undefined }); assert.equal(backdated.error.code, 'RECOVERY_NOT_PREPINNED');
  const revoked = await check(root, signed(recovery, 'key-revocation', 2, details, { issuedAt: now }), { artifact: undefined }); assert.equal(revoked.accepted, true);
  const before = await readFile(join(root, 'publisher-trust.json'));
  const offlineDownload = await check(root, old, { sourceStatus: 'offline' }); assert.equal(offlineDownload.keyStatus, 'revoked'); assert.equal(offlineDownload.accepted, false); assert.ok(offlineDownload.warnings.includes('OFFLINE_NEW_REVOCATIONS_AND_NOTICES_UNKNOWN'));
  assert.deepEqual(await readFile(join(root, 'publisher-trust.json')), before);
  await assert.rejects(anchor(root, key), { code: 'TRUST_KEY_ALREADY_KNOWN' });
});

test('Notice authority and exact affected artifacts remain separate from signature, integrity, execution, and offline freshness', async t => {
  const root = await workspace(t), key = generatePublisherKey(), advisor = generatePublisherKey(); await anchor(root, key); await anchor(root, advisor, 'advisory');
  const details = { artifacts: [artifact], severity: 'high', message: '测试公告：保留原始数据。\nReview before running.', links: ['https://example.com/advisories/1'] };
  const notice = await check(root, signed(advisor, 'risk-notice', 1, details), { artifact: undefined }); assert.equal(notice.noticeAuthority, 'trusted-advisory-authority');
  const good = await check(root, signed(key, 'artifact', 2)); assert.equal(good.accepted, true); assert.equal(good.notices.length, 1); assert.equal(good.notices[0].severity, 'high'); assert.equal(good.advisoryStatus, 'cached-notice-new-status-unknown'); assert.equal(good.grantsExecution, false);
  const offline = await check(root, signed(key, 'artifact', 2), { sourceStatus: 'offline', now: '2026-10-11T03:10:00.000Z' }); assert.equal(offline.lastStatusCheckedAt, now); assert.equal(offline.notices.length, 1);
  const changedBytes = await check(root, signed(key, 'artifact', 3, {}, { subject: { ...artifact, sha256: 'a'.repeat(64) } }), { artifact: { ...artifact, sha256: 'a'.repeat(64) } }); assert.equal(changedBytes.notices.length, 0);
  assert.throws(() => signed(advisor, 'risk-notice', 4, { ...details, links: ['javascript:alert(1)'] }), { code: 'INVALID_NOTICE_URL' });
});

test('Conflicting sequences, old unknown evidence, expiry, future clocks, and backward clocks fail without contaminating observation state', async t => {
  const root = await workspace(t), key = generatePublisherKey(); await anchor(root, key); await check(root, signed(key, 'artifact', 5));
  const before = await readFile(join(root, 'publisher-trust.json'));
  const unknownOld = await check(root, signed(key, 'artifact', 4)); assert.equal(unknownOld.error.code, 'SEQUENCE_ROLLBACK');
  const changedArtifact = { ...artifact, version: '2.0.0' };
  const conflict = await check(root, signed(key, 'artifact', 5, {}, { subject: changedArtifact }), { artifact: changedArtifact }); assert.equal(conflict.error.code, 'SEQUENCE_CONFLICT');
  const expired = await check(root, signed(key, 'artifact', 6), { now: expiresAt }); assert.equal(expired.error.code, 'EXPIRED_EVIDENCE');
  const future = await check(root, signed(key, 'artifact', 6, {}, { issuedAt: '2026-10-11T03:06:00.000Z' })); assert.equal(future.error.code, 'CLOCK_OR_FUTURE_ISSUE');
  const rollback = await check(root, signed(key, 'artifact', 6), { now: '2026-10-11T02:50:00.000Z' }); assert.equal(rollback.error.code, 'CLOCK_ROLLBACK');
  assert.deepEqual(await readFile(join(root, 'publisher-trust.json')), before);
});

test('Trust transactions reject stale review and lock contention without partial writes or erased revocations', async t => {
  const root = await workspace(t), key = generatePublisherKey(), other = generatePublisherKey();
  const firstChange = changeFor(key), stale = await previewPublisherTrustChange({ root, change: firstChange, now }); await anchor(root, other);
  await assert.rejects(applyPublisherTrustChange({ root, change: firstChange, reviewDigest: stale.reviewDigest, now }), { code: 'TRUST_REVIEW_REQUIRED' });
  const prior = await readFile(join(root, 'publisher-trust.json'));
  const lock = await open(join(root, '.publisher-trust.lock'), 'wx'); t.after(() => lock.close());
  await assert.rejects(check(root, signed(other)), { code: 'TRUST_STORE_BUSY' }); assert.deepEqual(await readFile(join(root, 'publisher-trust.json')), prior);
  await lock.close(); await rm(join(root, '.publisher-trust.lock'));
  const change = changeFor(key), preview = await previewPublisherTrustChange({ root, change, now });
  const attempts = await Promise.allSettled([applyPublisherTrustChange({ root, change, reviewDigest: preview.reviewDigest, now }), applyPublisherTrustChange({ root, change, reviewDigest: preview.reviewDigest, now })]); assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  const final = await readPublisherTrust({ root }); assert.equal(final.issuers[0].keys.length, 2); assert.equal((await readdir(root)).filter(x => x.endsWith('.tmp')).length, 0);
  await assert.rejects(check(root, signed(key), { expectedRevision: final.revision - 1 }), { code: 'PUBLISHER_REVIEW_CHANGED' });
  assert.equal((await readPublisherTrust({ root })).revision, final.revision);
});

test('Cached exact-artifact risk remains visible even when publisher or advisory keys are later revoked', async t => {
  const root = await workspace(t), key = generatePublisherKey(), recovery = generatePublisherKey(); await anchor(root, key); await anchor(root, recovery, 'recovery');
  const details = { artifacts: [artifact], severity: 'critical', message: 'Public warning before revocation.', links: [] };
  await check(root, signed(key, 'risk-notice', 1, details), { artifact: undefined }); const cached = signed(key, 'artifact', 2); await check(root, cached);
  await check(root, signed(recovery, 'key-revocation', 3, { revokedKeyId: key.keyId, effectiveAt: now, reason: 'Exposed key.' }, { issuedAt: now }), { artifact: undefined });
  const report = await check(root, cached, { sourceStatus: 'offline' }); assert.equal(report.keyStatus, 'revoked'); assert.equal(report.accepted, false); assert.equal(report.notices[0].severity, 'critical'); assert.equal(report.notices[0].authorityKeyStatus, 'inactive-or-revoked');
});

test('A compromised publisher maximum sequence cannot block independent recovery, advisory, or a newly pinned publisher stream', async t => {
  const root = await workspace(t), key = generatePublisherKey(), recovery = generatePublisherKey(), advisor = generatePublisherKey(), newPublisher = generatePublisherKey();
  await anchor(root, key); await anchor(root, recovery, 'recovery'); await anchor(root, advisor, 'advisory');
  const maximum = await check(root, signed(key, 'artifact', Number.MAX_SAFE_INTEGER)); assert.equal(maximum.accepted, true);
  const noticed = await check(root, signed(advisor, 'risk-notice', 1, { artifacts: [artifact], severity: 'critical', message: 'Independent authority unaffected by compromised publisher sequence.', links: [] }), { artifact: undefined }); assert.equal(noticed.accepted, true);
  const recovered = await check(root, signed(recovery, 'key-revocation', 1, { revokedKeyId: key.keyId, effectiveAt: now, reason: 'Independent emergency recovery.' }, { issuedAt: now }), { artifact: undefined }); assert.equal(recovered.accepted, true);
  await anchor(root, newPublisher); const fresh = await check(root, signed(newPublisher, 'artifact', 1)); assert.equal(fresh.accepted, true); assert.equal(fresh.sequenceAuthorityKeyId, newPublisher.keyId);
  const state = await readPublisherTrust({ root }); assert.equal(state.issuers[0].highestSequence, Number.MAX_SAFE_INTEGER); assert.equal(state.issuers[0].observations.filter(o => o.sequence === 1).length, 3);
  const before = state.revision; assert.equal((await check(root, signed(recovery, 'key-revocation', 1, { revokedKeyId: key.keyId, effectiveAt: now, reason: 'Independent emergency recovery.' }, { issuedAt: now }), { artifact: undefined })).revision, before);
  assert.equal((await check(root, signed(key, 'artifact', Number.MAX_SAFE_INTEGER))).keyStatus, 'revoked');
});

test('Legacy cached observations retain conservative old-key rollback protection and gain key scope only from verified evidence', async t => {
  const root = await workspace(t), old = generatePublisherKey(), recovery = generatePublisherKey(); await anchor(root, old); await anchor(root, recovery, 'recovery');
  const high = signed(old, 'artifact', 8); await check(root, high);
  const file = join(root, 'publisher-trust.json'), legacy = JSON.parse(await readFile(file)); delete legacy.issuers[0].observations[0].keyId; await writeFile(file, JSON.stringify(legacy));
  assert.equal((await check(root, signed(old, 'artifact', 7))).error.code, 'SEQUENCE_ROLLBACK');
  const known = await check(root, high); assert.equal(known.accepted, true); assert.equal((await readPublisherTrust({ root })).issuers[0].observations[0].keyId, old.keyId);
  const revoked = await check(root, signed(recovery, 'key-revocation', 1, { revokedKeyId: old.keyId, effectiveAt: now, reason: 'Legacy recovery remains independent.' }, { issuedAt: now }), { artifact: undefined }); assert.equal(revoked.accepted, true);
});

test('CLI public evidence update review binds bytes, artifact identity and the exact trust-store revision', async t => {
  const root = await workspace(t), key = generatePublisherKey(), evidence = signed(key, 'risk-notice', 1, { artifacts: [artifact], severity: 'info', message: 'Reviewed notice.', links: [] }); await anchor(root, key);
  const evidenceFile = join(root, 'update.json'); await writeFile(evidenceFile, JSON.stringify(evidence));
  const plan = await runPublisher(parsePublisherArgs(['publisher-update-plan', '--root', root, '--evidence', evidenceFile])); assert.equal(plan.accepted, true); assert.equal(plan.observed, false);
  const changed = signed(key, 'risk-notice', 1, { artifacts: [artifact], severity: 'critical', message: 'Different valid signed notice.', links: [] }); await writeFile(evidenceFile, JSON.stringify(changed));
  await assert.rejects(runPublisher(parsePublisherArgs(['publisher-update', '--root', root, '--evidence', evidenceFile, '--review-digest', plan.reviewDigest])), { code: 'PUBLISHER_REVIEW_CHANGED' });
  await writeFile(evidenceFile, JSON.stringify(evidence));
  const result = await runPublisher(parsePublisherArgs(['publisher-update', '--root', root, '--evidence', evidenceFile, '--review-digest', plan.reviewDigest])); assert.equal(result.accepted, true); assert.equal(result.observed, true);
  await assert.rejects(runPublisher(parsePublisherArgs(['publisher-update', '--root', root, '--evidence', evidenceFile, '--review-digest', plan.reviewDigest])), { code: 'PUBLISHER_REVIEW_CHANGED' });
});

test('Explicit local CLI generates private files, signs and verifies; receipts and public evidence contain no private material', async t => {
  const root = await workspace(t), privateFile = join(root, 'private.pem'), publicFile = join(root, 'public.json');
  const receipt = await runPublisher(parsePublisherArgs(['publisher-keygen', '--private-key', privateFile, '--public-key', publicFile])); assert.equal(receipt.privateKeyInReceipt, false); assert.ok(!JSON.stringify(receipt).includes('BEGIN PRIVATE KEY'));
  if (process.platform !== 'win32') assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
  await assert.rejects(runPublisher(parsePublisherArgs(['publisher-keygen', '--private-key', privateFile, '--public-key', publicFile])), { code: 'EEXIST' });
  const payloadFile = join(root, 'payload.json'), destination = join(root, 'publisher-evidence.json'), artifactFile = join(root, 'artifact.json');
  await writeFile(payloadFile, JSON.stringify({ type: 'artifact', issuer, keyId: receipt.keyId, sequence: 1, issuedAt, expiresAt, subject: artifact, details: {} })); await writeFile(artifactFile, JSON.stringify(artifact));
  const result = await runPublisher(parsePublisherArgs(['publisher-sign', '--payload', payloadFile, '--private-key', privateFile, '--destination', destination])); assert.equal(result.signed, true); assert.ok(!JSON.stringify(result).includes('PRIVATE KEY')); assert.ok(!(await readFile(destination, 'utf8')).includes('PRIVATE KEY'));
  const readonly = await runPublisher(parsePublisherArgs(['publisher-verify', '--root', join(root, 'trust'), '--evidence', destination, '--artifact', artifactFile])); assert.equal(readonly.observed, false); assert.equal(readonly.publisherIdentity, 'unanchored-key');
  assert.throws(() => parsePublisherArgs(['publisher-verify', '--root', root, '--evidence', destination, '--private-key', privateFile]));
  assert.throws(() => parsePublisherArgs(['publisher-update', '--root', root, '--root', root, '--evidence', destination]));
});

test('Fixed public vectors independently reproduce canonical bytes, fingerprints, and Ed25519 verification in Python', async t => {
  const vectorFile = new URL('../../../docs/ecosystem/publisher-vectors.json', import.meta.url); const vectors = JSON.parse(await readFile(vectorFile));
  for (const v of vectors.vectors) { assert.equal(canonicalPublisherPayload(v.evidence.payload).toString('hex'), v.signingBytesHex); for (const key of v.evidence.publicKeys) assert.equal(publisherKeyId(key.publicKey), key.keyId); parsePublisherEvidence(bytes(v.evidence)); }
  const python = process.env.WORLD_HUB_PUBLISHER_TEST_PYTHON ?? process.env.WORLD_HUB_RUNTIME_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3');
  const script = new URL('../../../docs/ecosystem/publisher-vector-check.py', import.meta.url);
  const { fileURLToPath } = await import('node:url'); const result = await promisify(execFile)(python, [fileURLToPath(script), fileURLToPath(vectorFile)], { timeout: 30000 });
  const report = JSON.parse(result.stdout); assert.equal(report.independentLanguage, 'Python'); assert.equal(report.signaturesVerified, 5); assert.equal(report.tamperedSignaturesRejected, 5); assert.equal(report.canonicalBytesMatched, 4);
  t.diagnostic('PUBLISHER_CROSS_LANGUAGE ' + result.stdout.trim());
});
