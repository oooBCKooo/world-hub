// Public-only local trust state. Review and observation are separate from execution.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { ordinaryPath } from './paths.mjs';
import { PUBLISHER_TRUST_FORMAT, PublisherEvidenceError, emptyPublisherTrust, createPublisherIssuer,
  parsePublisherJson, publisherKeyId, verifyPublisherEvidence } from './publisher-trust.mjs';

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new PublisherEvidenceError(code, message); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v, required, optional = []) => { if (!plain(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => ![...required, ...optional].includes(k))) fail('INVALID_TRUST_FIELDS', 'Trust state fields are closed.'); };
const stamp = value => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_TRUST_TIME', 'Trust time must be exact UTC ISO.'); return value; };
const clone = value => JSON.parse(JSON.stringify(value));
function identity(value, depth = 0) {
  if (depth > 8) fail('INVALID_IDENTITY_BASIS', 'Identity chain exceeds its bound.');
  if (typeof value === 'string') { if (!value.length || value.length > 1024) fail('INVALID_IDENTITY_BASIS', 'Identity basis must be bounded.'); return value; }
  fields(value, ['type'], ['note', 'url', 'previousKeyId', 'previousIdentityBasis']);
  if (!['manual-confirmation', 'public-key-fingerprint', 'external-identity-service', 'dual-signed-rotation'].includes(value.type)) fail('INVALID_IDENTITY_BASIS', 'Unknown identity basis.');
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 1024)) fail('INVALID_IDENTITY_BASIS', 'Identity note must be bounded.');
  if (value.url !== undefined) { const u = new URL(value.url); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || value.url.length > 2048) fail('INVALID_IDENTITY_BASIS', 'Identity URL must be HTTP(S).'); }
  if (value.previousIdentityBasis) identity(value.previousIdentityBasis, depth + 1);
  return value;
}
export function validatePublisherTrust(state) {
  fields(state, ['format', 'revision', 'issuers']);
  if (state.format !== PUBLISHER_TRUST_FORMAT || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.issuers) || state.issuers.length > 64) fail('INVALID_TRUST_STORE', 'Invalid bounded trust store.');
  const issuers = new Set();
  for (const i of state.issuers) {
    fields(i, ['issuer', 'keys', 'highestSequence', 'observations', 'rotations', 'revocations', 'notices', 'lastCheckedAt', 'lastOnlineCheckAt']);
    createPublisherIssuer(i.issuer); if (issuers.has(i.issuer)) fail('DUPLICATE_TRUST_ISSUER', 'Trust issuers must be unique.'); issuers.add(i.issuer);
    if (!Number.isSafeInteger(i.highestSequence) || i.highestSequence < 0 || !Array.isArray(i.keys) || i.keys.length > 64 || !Array.isArray(i.observations) || i.observations.length > 2048 || !Array.isArray(i.rotations) || i.rotations.length > 64 || !Array.isArray(i.revocations) || i.revocations.length > 64 || !Array.isArray(i.notices) || i.notices.length > 256) fail('INVALID_TRUST_HISTORY', 'Trust histories must be bounded.');
    const keys = new Set();
    for (const k of i.keys) {
      fields(k, ['keyId', 'publicKey', 'role', 'identityBasis', 'validFrom', 'validUntil', 'revokedAt'], ['anchoredAt']);
      if (publisherKeyId(k.publicKey) !== k.keyId || keys.has(k.keyId) || !['publisher', 'recovery', 'advisory'].includes(k.role)) fail('INVALID_TRUST_KEY', 'Trust key, fingerprint, or role is invalid.'); keys.add(k.keyId); identity(k.identityBasis); stamp(k.validFrom); if (k.validUntil !== null) stamp(k.validUntil); if (k.revokedAt !== null) stamp(k.revokedAt); if (k.anchoredAt) stamp(k.anchoredAt);
    }
    const seen = new Set(); let highest = 0;
    for (const o of i.observations) { fields(o, ['sequence', 'digest', 'checkedAt'], ['keyId']); const scope = (o.keyId ?? 'legacy-unknown') + ':' + o.sequence; if (!Number.isSafeInteger(o.sequence) || o.sequence < 1 || seen.has(scope) || o.keyId !== undefined && !keys.has(o.keyId) || !/^[a-f0-9]{64}$/.test(o.digest)) fail('INVALID_TRUST_OBSERVATION', 'Observation is invalid.'); seen.add(scope); stamp(o.checkedAt); highest = Math.max(highest, o.sequence); }
    if (highest !== i.highestSequence) fail('INVALID_TRUST_SEQUENCE', 'Highest sequence must equal retained history.');
    if (i.lastCheckedAt !== null) stamp(i.lastCheckedAt);
    if (i.lastOnlineCheckAt !== null) stamp(i.lastOnlineCheckAt);
    // Revalidate cached control records by reconstructing their closed payload shape.
    const recorded = (keyId, sequence, digest) => i.observations.some(o => (keyId === undefined || o.keyId === keyId || o.keyId === undefined) && o.sequence === sequence && o.digest === digest);
    for (const r of i.rotations) { fields(r, ['oldKeyId', 'newKeyId', 'newPublicKey', 'effectiveAt', 'sequence', 'digest']); if (!keys.has(r.oldKeyId) || !keys.has(r.newKeyId) || publisherKeyId(r.newPublicKey) !== r.newKeyId || !recorded(r.oldKeyId, r.sequence, r.digest)) fail('INVALID_TRUST_ROTATION', 'Cached rotation is invalid.'); stamp(r.effectiveAt); }
    for (const r of i.revocations) { fields(r, ['revokedKeyId', 'effectiveAt', 'reason', 'sequence', 'digest'], ['authorityKeyId']); if (!keys.has(r.revokedKeyId) || r.authorityKeyId !== undefined && !keys.has(r.authorityKeyId) || !recorded(r.authorityKeyId, r.sequence, r.digest) || typeof r.reason !== 'string' || !r.reason.length || r.reason.length > 2048) fail('INVALID_TRUST_REVOCATION', 'Cached revocation is invalid.'); stamp(r.effectiveAt); }
    for (const n of i.notices) { fields(n, ['artifacts', 'severity', 'message', 'links', 'issuer', 'keyId', 'authority', 'sequence', 'issuedAt', 'expiresAt', 'digest']); if (n.issuer !== i.issuer || !keys.has(n.keyId) || !recorded(n.keyId, n.sequence, n.digest) || !['publisher-self-report', 'trusted-advisory-authority'].includes(n.authority)) fail('INVALID_TRUST_NOTICE', 'Cached notice is invalid.'); stamp(n.issuedAt); stamp(n.expiresAt); if (!Array.isArray(n.artifacts) || n.artifacts.length > 64 || !Array.isArray(n.links) || n.links.length > 8 || typeof n.message !== 'string' || n.message.length > 4096 || !['info', 'low', 'medium', 'high', 'critical'].includes(n.severity)) fail('INVALID_TRUST_NOTICE', 'Cached notice is invalid.'); for (const a of n.artifacts) { fields(a, ['kind', 'id', 'version', 'sha256']); if (!['module', 'module-group', 'pack', 'template'].includes(a.kind) || !/^[a-f0-9]{64}$/.test(a.sha256) || typeof a.id !== 'string' || typeof a.version !== 'string') fail('INVALID_TRUST_NOTICE', 'Cached notice artifact is invalid.'); } }
  }
  const bytes = Buffer.from(JSON.stringify(state)); if (bytes.length > MAX_STORE_BYTES) fail('TRUST_STORE_FULL', 'Trust store exceeds its limit.'); return state;
}
function locations(root) { if (typeof root !== 'string' || !root.length) fail('TRUST_ROOT_REQUIRED', 'An explicit local trust root is required.'); const directory = resolve(root); return { directory, file: join(directory, 'publisher-trust.json'), lock: join(directory, '.publisher-trust.lock') }; }
async function ensureDirectory(directory) { await ordinaryPath(directory, { allowMissing: true }); await mkdir(directory, { recursive: true, mode: 0o700 }); await ordinaryPath(directory); const s = await lstat(directory); if (!s.isDirectory() || s.isSymbolicLink()) fail('INVALID_TRUST_DIRECTORY', 'Trust root must be a real local directory.'); }
async function readAt(file) {
  let handle;
  try { await ordinaryPath(file); const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_STORE_BYTES) fail('INVALID_TRUST_FILE', 'Trust file must be bounded and regular.'); handle = await open(file, 'r'); const bytes = await handle.readFile(); return validatePublisherTrust(parsePublisherJson(bytes, { maxBytes: MAX_STORE_BYTES, maxNodes: 200000 })); }
  catch (error) { if (error.code === 'ENOENT') return emptyPublisherTrust(); throw error; }
  finally { await handle?.close(); }
}
export async function readPublisherTrust({ root } = {}) { return readAt(locations(root).file); }
async function transaction(root, operation) {
  const paths = locations(root); await ensureDirectory(paths.directory); let lock;
  try { lock = await open(paths.lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('TRUST_STORE_BUSY', 'Another trust operation owns the lock. A stale lock requires explicit operator inspection.'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + '\n'); await lock.sync();
    const current = await readAt(paths.file); const result = await operation(current);
    if (!result.state || JSON.stringify(result.state) === JSON.stringify(current)) return { ...result.value, revision: current.revision };
    result.state.revision = current.revision + 1; validatePublisherTrust(result.state);
    const temp = join(paths.directory, '.publisher-trust-' + randomUUID() + '.tmp'); let output;
    try { output = await open(temp, 'wx', 0o600); await output.writeFile(JSON.stringify(result.state, null, 2) + '\n'); await output.sync(); await output.close(); output = null; await rename(temp, paths.file); }
    finally { await output?.close(); await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    return { ...result.value, state: result.state, revision: result.state.revision };
  } finally { await lock.close(); await unlink(paths.lock); }
}
function reviewChange(current, change, now) {
  const checkedAt = now ?? new Date().toISOString(); stamp(checkedAt);
  if (!plain(change)) fail('INVALID_TRUST_CHANGE', 'Trust change must be an object.');
  const next = clone(current), issuerId = change.issuer; createPublisherIssuer(issuerId);
  let issuer = next.issuers.find(i => i.issuer === issuerId);
  if (change.action === 'anchor') {
    fields(change, ['action', 'issuer', 'publicKey', 'role', 'identityBasis'], ['keyId', 'validFrom']);
    const id = publisherKeyId(change.publicKey); if (change.keyId !== undefined && change.keyId !== id) fail('KEY_FINGERPRINT_MISMATCH', 'Reviewed key ID differs from its public key.');
    if (!['publisher', 'recovery', 'advisory'].includes(change.role)) fail('INVALID_TRUST_ROLE', 'Anchor role must be explicit.'); identity(change.identityBasis);
    if (change.identityBasis?.type === 'dual-signed-rotation') fail('INVALID_IDENTITY_BASIS', 'Only verified dual signatures may create a derived rotation basis.');
    if (!issuer) { issuer = createPublisherIssuer(issuerId); next.issuers.push(issuer); }
    if (issuer.keys.some(k => k.keyId === id)) fail('TRUST_KEY_ALREADY_KNOWN', 'A known key cannot be reset or repurposed by anchoring again.');
    if (change.role === 'recovery' && issuer.keys.some(k => k.role === 'publisher' && k.keyId === id)) fail('RECOVERY_KEY_NOT_INDEPENDENT', 'Recovery must be independently pinned.');
    issuer.keys.push({ keyId: id, publicKey: change.publicKey, role: change.role, identityBasis: clone(change.identityBasis), validFrom: change.validFrom ?? checkedAt, validUntil: null, revokedAt: null, anchoredAt: checkedAt });
  } else if (change.action === 'remove-anchor') {
    fields(change, ['action', 'issuer', 'keyId']); const target = issuer?.keys.find(k => k.keyId === change.keyId); if (!target) fail('TRUST_KEY_NOT_FOUND', 'Anchor was not found.'); target.validUntil = checkedAt;
  } else fail('UNKNOWN_TRUST_ACTION', 'Unknown trust change.');
  validatePublisherTrust(next);
  const summary = { action: change.action, issuer: issuerId, keyId: change.action === 'anchor' ? publisherKeyId(change.publicKey) : change.keyId, role: change.role ?? issuer.keys.find(k => k.keyId === change.keyId).role, identityBasis: change.identityBasis ?? null, startsModules: false, grantsExecution: false, warnings: ['PINNING_A_KEY_IS_NOT_CODE_OR_BUSINESS_APPROVAL'] };
  // Time is not part of the review digest. Caller binds explicit validFrom if needed.
  const reviewDigest = sha(Buffer.from('WORLD-HUB-PUBLISHER-TRUST-REVIEW/1\n' + JSON.stringify({ state: current, change })));
  return { summary, reviewDigest, stateRevision: current.revision, state: next };
}
export async function previewPublisherTrustChange({ root, change, now } = {}) { const current = await readPublisherTrust({ root }); const result = reviewChange(current, change, now); const { state, ...report } = result; return report; }
export async function applyPublisherTrustChange({ root, change, reviewDigest, now } = {}) {
  return transaction(root, async current => { const preview = reviewChange(current, change, now); if (reviewDigest !== preview.reviewDigest) fail('TRUST_REVIEW_REQUIRED', 'Trust change requires the exact current review digest.'); return { state: preview.state, value: { applied: true, ...preview.summary, reviewDigest } }; });
}
export async function verifyStoredPublisherEvidence({ root, artifact, evidenceBytes, now, sourceStatus = 'offline', observe = true, expectedRevision } = {}) {
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) fail('INVALID_EXPECTED_REVISION', 'Expected trust revision must be a nonnegative safe integer.');
  if (!observe) { const current = await readPublisherTrust({ root }); const result = verifyPublisherEvidence({ artifact, evidenceBytes, state: current, now, sourceStatus }); delete result.proposedState; return { ...result, observed: false, revision: current.revision }; }
  return transaction(root, async current => { if (expectedRevision !== undefined && current.revision !== expectedRevision) fail('PUBLISHER_REVIEW_CHANGED', 'Trust state changed after the evidence review.'); const result = verifyPublisherEvidence({ artifact, evidenceBytes, state: current, now, sourceStatus }); const proposed = result.proposedState; delete result.proposedState; if (!result.accepted) return { value: { ...result, observed: false, revision: current.revision } }; return { state: proposed, value: { ...result, observed: true } }; });
}
