// Optional publisher evidence. This module never starts code or grants execution.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const PUBLISHER_EVIDENCE_FORMAT = 'world-hub.publisher-evidence/v1';
export const PUBLISHER_TRUST_FORMAT = 'world-hub.publisher-trust/v1';
export const PUBLISHER_EVIDENCE_LIMIT = 262144;
const PREFIX = Buffer.from('WORLD-HUB-PUBLISHER-EVIDENCE/1\n', 'ascii');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const KEY_ID = /^ed25519-sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export class PublisherEvidenceError extends Error {
  constructor(code, message) { super(message); this.name = 'PublisherEvidenceError'; this.code = code; }
}
const fail = (code, message) => { throw new PublisherEvidenceError(code, message); };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function scalar(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('INVALID_STRING', 'Strings must be bounded Unicode scalar values.');
  return value;
}
function fields(value, required, optional = []) {
  if (!plain(value) || required.some(k => !own(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) fail('INVALID_FIELDS', 'Evidence fields are closed and required fields must be present.');
}
function text(value, max = 128) { scalar(value); if (!value.length || value.length > max) fail('INVALID_FIELD', 'Text field has invalid length.'); return value; }
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ID', 'Identifier must be bounded ASCII.'); return value; }
function timestamp(value) { if (typeof value !== 'string' || !STAMP.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_TIME', 'Timestamp must be an exact UTC ISO timestamp.'); return Date.parse(value); }
function keyId(value) { if (typeof value !== 'string' || !KEY_ID.test(value)) fail('INVALID_KEY_ID', 'Invalid Ed25519 fingerprint.'); return value; }
function base64(value, length) {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('INVALID_BASE64', 'Base64 must be canonical and have exact length.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value) fail('INVALID_BASE64', 'Base64 must be canonical and have exact length.');
  return bytes;
}
export function parsePublisherJson(input, { maxBytes = PUBLISHER_EVIDENCE_LIMIT, maxNodes = 8192 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) fail('INVALID_LIMIT', 'Invalid parser bound.');
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 200000) fail('INVALID_LIMIT', 'Invalid parser complexity bound.');
  if (typeof input === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) fail('INVALID_STRING', 'Input contains unpaired Unicode surrogates.');
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) fail('INVALID_EVIDENCE_BYTES', 'Evidence must be a UTF-8 string or a byte buffer.');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.length > maxBytes) fail('EVIDENCE_TOO_LARGE', 'Evidence exceeds the byte limit.');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('INVALID_UTF8', 'Evidence must be valid UTF-8.'); }
  if (source.charCodeAt(0) === 0xfeff) fail('INVALID_JSON', 'UTF-8 BOM is not allowed.');
  let p = 0, nodes = 0;
  const ws = () => { while (/[\t\n\r ]/.test(source[p] ?? '\0')) p++; };
  const string = () => {
    const begin = p++; let escaped = false;
    while (p < source.length) {
      const c = source[p++];
      if (!escaped && c === '"') { try { return scalar(JSON.parse(source.slice(begin, p))); } catch (e) { if (e instanceof PublisherEvidenceError) throw e; fail('INVALID_JSON', 'Invalid JSON string.'); } }
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    fail('INVALID_JSON', 'Unterminated JSON string.');
  };
  const value = depth => {
    if (++nodes > maxNodes || depth > 16) fail('EVIDENCE_COMPLEXITY', 'JSON structure exceeds its bound.');
    ws(); const c = source[p];
    if (c === '"') return string();
    if (c === '{') {
      p++; ws(); const result = Object.create(null), seen = new Set();
      if (source[p] === '}') { p++; return result; }
      do {
        ws(); if (source[p] !== '"') fail('INVALID_JSON', 'Object key must be a string.');
        const k = string();
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k)) fail('INVALID_FIELD', 'Object keys must be supported ASCII fields.');
        if (seen.has(k)) fail('DUPLICATE_KEY', 'Duplicate JSON keys are forbidden.');
        seen.add(k); if (seen.size > 128) fail('EVIDENCE_COMPLEXITY', 'Too many object fields.');
        ws(); if (source[p++] !== ':') fail('INVALID_JSON', 'Missing field separator.'); result[k] = value(depth + 1); ws();
        if (source[p] === '}') { p++; return result; }
        if (source[p++] !== ',') fail('INVALID_JSON', 'Missing object separator.');
      } while (p < source.length);
    }
    if (c === '[') {
      p++; ws(); const result = []; if (source[p] === ']') { p++; return result; }
      do { if (result.length >= 2048) fail('EVIDENCE_COMPLEXITY', 'Too many array items.'); result.push(value(depth + 1)); ws(); if (source[p] === ']') { p++; return result; } if (source[p++] !== ',') fail('INVALID_JSON', 'Missing array separator.'); } while (p < source.length);
    }
    for (const [token, literal] of [['true', true], ['false', false], ['null', null]]) if (source.startsWith(token, p)) { p += token.length; return literal; }
    const number = /^(?:0|[1-9][0-9]*)/.exec(source.slice(p));
    if (number) { p += number[0].length; const result = Number(number[0]); if (!Number.isSafeInteger(result)) fail('INVALID_NUMBER', 'Numbers must be nonnegative safe integers.'); return result; }
    fail('INVALID_JSON', 'Unsupported JSON value.');
  };
  const result = value(0); ws(); if (p !== source.length) fail('INVALID_JSON', 'Trailing or noncanonical numeric tokens.'); return result;
}
export function canonicalPublisherJson(value) {
  let count = 0;
  const visit = (v, depth) => {
    if (++count > 8192 || depth > 16) fail('EVIDENCE_COMPLEXITY', 'JSON structure exceeds its bound.');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(scalar(v));
    if (typeof v === 'number') { if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) fail('INVALID_NUMBER', 'Numbers must be nonnegative safe integers.'); return String(v); }
    if (Array.isArray(v)) { if (v.length > 2048) fail('EVIDENCE_COMPLEXITY', 'Too many array items.'); return '[' + v.map(x => visit(x, depth + 1)).join(',') + ']'; }
    if (!plain(v)) fail('INVALID_JSON', 'Only JSON values are supported.');
    const keys = Object.keys(v).sort(); if (keys.length > 128 || keys.some(k => !/^[A-Za-z][A-Za-z0-9]*$/.test(k) || ['constructor', 'prototype'].includes(k))) fail('INVALID_FIELD', 'Unsupported object keys.');
    return '{' + keys.map(k => JSON.stringify(k) + ':' + visit(v[k], depth + 1)).join(',') + '}';
  };
  const result = visit(value, 0); if (Buffer.byteLength(result) > PUBLISHER_EVIDENCE_LIMIT) fail('EVIDENCE_TOO_LARGE', 'Canonical JSON exceeds the byte limit.'); return result;
}
function artifactSubject(subject) {
  fields(subject, ['kind', 'id', 'version', 'sha256']);
  if (!['module', 'pack', 'template'].includes(subject.kind)) fail('INVALID_ARTIFACT_KIND', 'Artifact kind must be module, pack, or template.');
  identifier(subject.id); text(subject.version, 128);
  if (!SHA.test(subject.sha256)) fail('INVALID_ARTIFACT_SHA', 'Artifact must have exact SHA-256.');
  return subject;
}
export function publisherKeyId(publicKey) { return 'ed25519-sha256:' + digest(base64(publicKey, 32)); }
function publicObject(publicKey) { return createPublicKey({ key: Buffer.concat([SPKI, base64(publicKey, 32)]), format: 'der', type: 'spki' }); }
function validatePublicKey(entry) { fields(entry, ['keyId', 'publicKey']); keyId(entry.keyId); if (publisherKeyId(entry.publicKey) !== entry.keyId) fail('KEY_FINGERPRINT_MISMATCH', 'Public key fingerprint does not match.'); return entry; }
export function validatePublisherPayload(payload) {
  fields(payload, ['type', 'issuer', 'keyId', 'sequence', 'issuedAt', 'expiresAt', 'subject', 'details']);
  identifier(payload.issuer); keyId(payload.keyId);
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) fail('INVALID_SEQUENCE', 'Sequence must be a positive safe integer.');
  const issued = timestamp(payload.issuedAt), expires = timestamp(payload.expiresAt);
  if (expires <= issued || expires - issued > 366 * 86400000) fail('INVALID_VALIDITY', 'Validity must be positive and no longer than 366 days.');
  if (payload.type === 'artifact') { artifactSubject(payload.subject); fields(payload.details, []); }
  else {
    fields(payload.subject, ['kind', 'id']); if (payload.subject.kind !== 'publisher' || payload.subject.id !== payload.issuer) fail('INVALID_SUBJECT', 'Control evidence must bind its issuer.');
    if (payload.type === 'key-rotation') {
      fields(payload.details, ['oldKeyId', 'newKeyId', 'newPublicKey', 'effectiveAt']); keyId(payload.details.oldKeyId); keyId(payload.details.newKeyId); timestamp(payload.details.effectiveAt);
      if (payload.details.oldKeyId !== payload.keyId || payload.details.oldKeyId === payload.details.newKeyId || publisherKeyId(payload.details.newPublicKey) !== payload.details.newKeyId) fail('INVALID_ROTATION', 'Rotation must bind distinct old and new keys.');
    } else if (payload.type === 'key-revocation') {
      fields(payload.details, ['revokedKeyId', 'effectiveAt', 'reason']); keyId(payload.details.revokedKeyId); timestamp(payload.details.effectiveAt); text(payload.details.reason, 2048);
      if (payload.details.revokedKeyId === payload.keyId) fail('SELF_REVOCATION_AUTHORITY', 'Revocation requires an independent recovery authority.');
    } else if (payload.type === 'risk-notice') {
      fields(payload.details, ['artifacts', 'severity', 'message', 'links']);
      if (!Array.isArray(payload.details.artifacts) || !payload.details.artifacts.length || payload.details.artifacts.length > 64) fail('INVALID_NOTICE', 'Notice must bind 1 to 64 exact artifacts.');
      const seen = new Set(); for (const a of payload.details.artifacts) { artifactSubject(a); const d = canonicalPublisherJson(a); if (seen.has(d)) fail('INVALID_NOTICE', 'Notice artifacts must be unique.'); seen.add(d); }
      if (!['info', 'low', 'medium', 'high', 'critical'].includes(payload.details.severity)) fail('INVALID_NOTICE', 'Unknown severity.');
      text(payload.details.message, 4096);
      if (!Array.isArray(payload.details.links) || payload.details.links.length > 8) fail('INVALID_NOTICE', 'Links must be bounded.');
      for (const link of payload.details.links) { text(link, 2048); let url; try { url = new URL(link); } catch { fail('INVALID_NOTICE_URL', 'Notice link must be HTTP(S).'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_NOTICE_URL', 'Notice link must be HTTP(S) without credentials.'); }
    } else fail('UNKNOWN_EVIDENCE_TYPE', 'Unknown publisher evidence type.');
    const effective = payload.details.effectiveAt;
    if (effective && (timestamp(effective) < issued || timestamp(effective) >= expires)) fail('INVALID_EFFECTIVE_TIME', 'Effective time must be within statement validity.');
  }
  canonicalPublisherJson(payload); return payload;
}
export function canonicalPublisherPayload(payload) { validatePublisherPayload(payload); return Buffer.concat([PREFIX, Buffer.from(canonicalPublisherJson(payload), 'utf8')]); }
export function parsePublisherEvidence(bytes) {
  const evidence = parsePublisherJson(bytes);
  fields(evidence, ['format', 'payload', 'signatures'], ['publicKeys']);
  if (evidence.format !== PUBLISHER_EVIDENCE_FORMAT) fail('UNKNOWN_EVIDENCE_FORMAT', 'Unknown publisher evidence format.');
  validatePublisherPayload(evidence.payload);
  if (!Array.isArray(evidence.signatures) || !evidence.signatures.length || evidence.signatures.length > 4) fail('INVALID_SIGNATURES', 'Evidence needs 1 to 4 signatures.');
  const seen = new Set(); for (const s of evidence.signatures) { fields(s, ['keyId', 'algorithm', 'value']); keyId(s.keyId); if (s.algorithm !== 'Ed25519') fail('UNKNOWN_SIGNATURE_ALGORITHM', 'Only Ed25519 is supported.'); base64(s.value, 64); if (seen.has(s.keyId)) fail('DUPLICATE_SIGNATURE', 'Duplicate signatures are forbidden.'); seen.add(s.keyId); }
  if (evidence.publicKeys !== undefined) { if (!Array.isArray(evidence.publicKeys) || evidence.publicKeys.length > 4) fail('INVALID_PUBLIC_KEYS', 'At most 4 untrusted public keys are allowed.'); const keys = new Set(); for (const k of evidence.publicKeys) { validatePublicKey(k); if (keys.has(k.keyId)) fail('DUPLICATE_PUBLIC_KEY', 'Duplicate public keys are forbidden.'); keys.add(k.keyId); } }
  return evidence;
}
export function generatePublisherKey() {
  const keys = generateKeyPairSync('ed25519'); const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { keyId: publisherKeyId(publicKey), publicKey, privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}
export function signPublisherEvidence({ payload, privateKeys }) {
  const bytes = canonicalPublisherPayload(payload);
  if (!Array.isArray(privateKeys) || privateKeys.length < 1 || privateKeys.length > 4) fail('INVALID_SIGNING_KEYS', 'Provide 1 to 4 explicit local private keys.');
  const signatures = [], publicKeys = [], seen = new Set();
  for (const input of privateKeys) { const k = createPrivateKey(input); if (k.asymmetricKeyType !== 'ed25519') fail('INVALID_SIGNING_KEY', 'Signing key must be Ed25519.'); const publicKey = createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'); const id = publisherKeyId(publicKey); if (seen.has(id)) fail('DUPLICATE_SIGNING_KEY', 'Signing keys must be unique.'); seen.add(id); publicKeys.push({ keyId: id, publicKey }); signatures.push({ keyId: id, algorithm: 'Ed25519', value: sign(null, bytes, k).toString('base64') }); }
  const result = { format: PUBLISHER_EVIDENCE_FORMAT, payload: structuredClone(payload), signatures, publicKeys };
  parsePublisherEvidence(Buffer.from(JSON.stringify(result))); return result;
}

export function emptyPublisherTrust() { return { format: PUBLISHER_TRUST_FORMAT, revision: 0, issuers: [] }; }
const clone = value => JSON.parse(JSON.stringify(value));
function atNow(value) { const result = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(value ?? new Date().toISOString())); if (!Number.isSafeInteger(result) || result < 0) fail('INVALID_CLOCK', 'Check time must be a valid UTC instant.'); return result; }
function activeKey(k, now) { return k && Date.parse(k.validFrom) <= now && (!k.validUntil || now < Date.parse(k.validUntil)) && (!k.revokedAt || now < Date.parse(k.revokedAt)); }
function subjectEqual(a, b) { return ['kind', 'id', 'version', 'sha256'].every(k => a?.[k] === b?.[k]); }
function initialIssuer(issuer) { return { issuer, keys: [], highestSequence: 0, observations: [], rotations: [], revocations: [], notices: [], lastCheckedAt: null, lastOnlineCheckAt: null }; }
export function createPublisherIssuer(issuer) { identifier(issuer); return initialIssuer(issuer); }
function validBasis(value, depth = 0) {
  if (depth > 8) fail('INVALID_IDENTITY_BASIS', 'Identity chain exceeds its bound.');
  if (typeof value === 'string') return text(value, 1024);
  fields(value, ['type'], ['note', 'url', 'previousKeyId', 'previousIdentityBasis']);
  if (!['manual-confirmation', 'public-key-fingerprint', 'external-identity-service', 'dual-signed-rotation'].includes(value.type)) fail('INVALID_IDENTITY_BASIS', 'Identity basis must explain the explicit anchor.');
  if (value.note !== undefined) text(value.note, 1024);
  if (value.url !== undefined) { text(value.url, 2048); let u; try { u = new URL(value.url); } catch { fail('INVALID_IDENTITY_BASIS', 'Identity service URL must be HTTP(S).'); } if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) fail('INVALID_IDENTITY_BASIS', 'Identity service URL must be HTTP(S).'); }
  if (value.previousKeyId !== undefined) keyId(value.previousKeyId);
  if (value.previousIdentityBasis !== undefined) validBasis(value.previousIdentityBasis, depth + 1);
}
function validateAuthority(k) {
  validatePublicKey({ keyId: k.keyId, publicKey: k.publicKey });
  if (!['publisher', 'recovery', 'advisory'].includes(k.role)) fail('INVALID_TRUST_ANCHOR', 'Trust authority role must be explicit.');
  validBasis(k.identityBasis); timestamp(k.validFrom); if (k.validUntil !== null && k.validUntil !== undefined) timestamp(k.validUntil); if (k.revokedAt !== null && k.revokedAt !== undefined) timestamp(k.revokedAt); if (k.anchoredAt !== undefined) timestamp(k.anchoredAt);
}

export function verifyPublisherEvidence({ artifact, artifactSha256, evidenceBytes, state, trustedKeys = [], now, sourceStatus = 'offline' } = {}) {
  const checkedMs = atNow(now), checkedAt = new Date(checkedMs).toISOString();
  if (!['online', 'offline'].includes(sourceStatus)) fail('INVALID_SOURCE_STATUS', 'Source status must be online or offline.');
  const report = { format: 'world-hub.publisher-report/v1', accepted: false, contentIntegrity: 'not-checked', publisherIdentity: 'unknown', keyStatus: 'unknown', advisoryStatus: 'cached-only-new-status-unknown', checkedAt, sourceStatus, identityBasis: null, sequenceStatus: 'not-checked', warnings: [sourceStatus === 'offline' ? 'OFFLINE_NEW_REVOCATIONS_AND_NOTICES_UNKNOWN' : 'LATEST_REVOCATIONS_AND_NOTICES_NOT_QUERIED'], startsModules: false, grantsExecution: false };
  // Cached risk is an independent dimension, including when identity has failed
  // or a previously valid key is now revoked. It never becomes execution approval.
  const cachedNotices = (Array.isArray(state?.issuers) ? state.issuers : []).flatMap(i => (Array.isArray(i.notices) ? i.notices : []).map(n => ({ ...clone(n), authorityKeyStatus: activeKey(i.keys?.find(k => k.keyId === n.keyId), checkedMs) ? 'active' : 'inactive-or-revoked' }))).filter(n => artifact && Array.isArray(n.artifacts) && n.artifacts.some(a => subjectEqual(a, artifact)));
  report.notices = cachedNotices.map(n => ({ ...n, expired: checkedMs >= Date.parse(n.expiresAt) }));
  if (cachedNotices.length) report.advisoryStatus = 'cached-notice-new-status-unknown';
  const cachedIssuer = Array.isArray(state?.issuers) ? state.issuers.find(i => i.issuer === cachedNotices[0]?.issuer) : null;
  report.lastStatusCheckedAt = cachedIssuer?.lastOnlineCheckAt ?? null;
  let evidence;
  try {
    evidence = parsePublisherEvidence(evidenceBytes); const p = evidence.payload; report.type = p.type; report.issuer = p.issuer; report.keyId = p.keyId; report.sequence = p.sequence;
    if (p.type === 'artifact' && artifact !== undefined) {
      if (!artifact) fail('ARTIFACT_IDENTITY_REQUIRED', 'Provide the actual artifact file to verify its exact kind, ID, version, and bytes.');
      artifactSubject(artifact);
      if (!subjectEqual(artifact, p.subject)) { report.contentIntegrity = 'mismatch'; fail('ARTIFACT_MISMATCH', 'Evidence does not bind the exact artifact kind, ID, version, and bytes.'); }
      report.contentIntegrity = 'verified';
    }
    const next = clone(state ?? emptyPublisherTrust());
    if (next.format !== PUBLISHER_TRUST_FORMAT || !Array.isArray(next.issuers)) fail('INVALID_TRUST_STORE', 'Invalid publisher trust state.');
    let issuer = next.issuers.find(i => i.issuer === p.issuer);
    if (!issuer) { issuer = initialIssuer(p.issuer); next.issuers.push(issuer); }
    if (!Array.isArray(issuer.keys) || !Array.isArray(issuer.observations) || !Array.isArray(issuer.rotations) || !Array.isArray(issuer.revocations) || !Array.isArray(issuer.notices) || !Number.isSafeInteger(issuer.highestSequence)) fail('INVALID_TRUST_STORE', 'Trust state must contain bounded public histories.');
    issuer.keys.forEach(validateAuthority);
    if (!Array.isArray(trustedKeys) || trustedKeys.length > 64) fail('INVALID_TRUST_ANCHOR', 'Explicit trust anchors must be bounded.');
    for (const k of trustedKeys) {
      if (k.issuer !== p.issuer) continue;
      validatePublicKey({ keyId: k.keyId, publicKey: k.publicKey });
      const normalized = { ...clone(k), validFrom: k.validFrom ?? '1970-01-01T00:00:00.000Z', validUntil: k.validUntil ?? null, revokedAt: k.revokedAt ?? null }; validateAuthority(normalized);
      if (!issuer.keys.some(existing => existing.keyId === k.keyId)) issuer.keys.push(normalized);
    }
    const provided = new Map((evidence.publicKeys ?? []).map(k => [k.keyId, k.publicKey]));
    if (p.type === 'key-rotation') provided.set(p.details.newKeyId, p.details.newPublicKey);
    const signatureValid = id => {
      const signature = evidence.signatures.find(s => s.keyId === id); const known = issuer.keys.find(k => k.keyId === id); const publicKey = known?.publicKey ?? provided.get(id);
      return Boolean(signature && publicKey && verify(null, canonicalPublisherPayload(p), publicObject(publicKey), base64(signature.value, 64)));
    };
    if (!signatureValid(p.keyId)) fail('INVALID_SIGNATURE', 'Issuer signature cannot be verified.');
    report.signatureStatus = 'verified';
    const authority = issuer.keys.find(k => k.keyId === p.keyId);
    if (!authority) { report.publisherIdentity = 'unanchored-key'; report.keyStatus = 'unanchored'; fail('UNANCHORED_KEY', 'A self-supplied public key does not establish a trusted identity.'); }
    report.publisherIdentity = 'anchored-key'; report.identityBasis = authority.identityBasis;
    const statementDigest = digest(canonicalPublisherPayload(p)); report.statementDigest = statementDigest;
    const ownObservations = issuer.observations.filter(x => x.keyId === p.keyId);
    const legacy = issuer.observations.filter(x => x.keyId === undefined);
    const seen = ownObservations.find(x => x.sequence === p.sequence) ?? legacy.find(x => x.sequence === p.sequence && x.digest === statementDigest);
    if (seen && seen.digest !== statementDigest) fail('SEQUENCE_CONFLICT', 'The same issuer sequence was used for a different statement.');
    const knownHigh = Math.max(0, ...ownObservations.map(x => x.sequence));
    // Early v1 development stores did not retain the signing key in observations.
    // Never invent that identity. Previously present publisher keys retain the
    // conservative unknown-authority floor; new and independently pinned
    // recovery/advisory keys use their own authenticated streams.
    const legacyLatest = Math.max(0, ...legacy.map(x => Date.parse(x.checkedAt)));
    const legacyHigh = authority.role === 'publisher' && Date.parse(authority.anchoredAt ?? authority.validFrom) <= legacyLatest ? Math.max(0, ...legacy.map(x => x.sequence)) : 0;
    const authorityHigh = Math.max(knownHigh, legacyHigh);
    report.sequenceScope = 'issuer-key'; report.sequenceAuthorityKeyId = p.keyId; report.authorityHighestSequence = authorityHigh;
    if (!seen && p.sequence <= authorityHigh) fail('SEQUENCE_ROLLBACK', 'Unobserved old statement is a rollback for this issuer and authority key.');
    const knownRotation = p.type === 'key-rotation' && seen && issuer.rotations.some(r => r.digest === statementDigest && r.oldKeyId === authority.keyId) && authority.validUntil === p.details.effectiveAt && !authority.revokedAt;
    if (!activeKey(authority, checkedMs) && !knownRotation) { report.keyStatus = authority.revokedAt && checkedMs >= Date.parse(authority.revokedAt) ? 'revoked' : 'inactive'; fail('INACTIVE_KEY', 'Issuer key is revoked, retired, or not yet active.'); }
    report.keyStatus = 'active';
    const issued = Date.parse(p.issuedAt), expires = Date.parse(p.expiresAt);
    if (issued > checkedMs + 300000) fail('CLOCK_OR_FUTURE_ISSUE', 'Evidence issuance is more than five minutes in the future.');
    if (checkedMs >= expires) fail('EXPIRED_EVIDENCE', 'Evidence has expired.');
    if (authority.identityBasis?.type === 'dual-signed-rotation' && issued < Date.parse(authority.validFrom)) fail('KEY_NOT_ACTIVE_AT_ISSUANCE', 'A rotated key cannot backdate evidence before its activation.');
    if (issuer.lastCheckedAt && checkedMs + 300000 < Date.parse(issuer.lastCheckedAt)) fail('CLOCK_ROLLBACK', 'Local check clock moved backward.');
    report.sequenceStatus = seen ? 'known-statement' : 'new-statement';
    if (p.type === 'artifact') {
      if (authority.role !== 'publisher') fail('WRONG_KEY_ROLE', 'Artifact requires a publisher anchor.');
      if (!artifact && artifactSha256) { report.warnings.push('EXACT_ARTIFACT_IDENTITY_REQUIRED'); fail('ARTIFACT_IDENTITY_REQUIRED', 'SHA alone cannot bind artifact kind, ID, and version.'); }
      if (!artifact) fail('ARTIFACT_IDENTITY_REQUIRED', 'Provide the actual artifact file to verify its exact kind, ID, version, and bytes.');
      artifactSubject(artifact); if (!subjectEqual(artifact, p.subject)) { report.contentIntegrity = 'mismatch'; fail('ARTIFACT_MISMATCH', 'Evidence does not bind the exact artifact kind, ID, version, and bytes.'); }
      report.contentIntegrity = 'verified';
    } else if (p.type === 'key-rotation') {
      if (authority.role !== 'publisher') fail('WRONG_KEY_ROLE', 'Only a publisher key may rotate a publisher key.');
      if (!signatureValid(p.details.newKeyId)) fail('MISSING_ROTATION_PROOF', 'Rotation needs signatures from both old and new keys.');
      const effective = Date.parse(p.details.effectiveAt);
      if (effective > checkedMs) fail('NOT_YET_EFFECTIVE', 'Control evidence is not effective yet.');
      const prior = issuer.rotations.find(r => r.oldKeyId === p.details.oldKeyId);
      if (prior && (prior.newKeyId !== p.details.newKeyId || prior.digest !== statementDigest)) fail('ROTATION_CONFLICT', 'Old key already has a different successor.');
      if (!seen && issuer.keys.some(k => k.keyId === p.details.newKeyId)) fail('ROTATION_CONFLICT', 'Successor key already has another trust entry.');
      if (!seen) {
        authority.validUntil = p.details.effectiveAt;
        issuer.keys.push({ keyId: p.details.newKeyId, publicKey: p.details.newPublicKey, role: 'publisher', identityBasis: { type: 'dual-signed-rotation', previousKeyId: authority.keyId, previousIdentityBasis: authority.identityBasis }, validFrom: p.details.effectiveAt, validUntil: null, revokedAt: null });
        issuer.rotations.push({ ...clone(p.details), sequence: p.sequence, digest: statementDigest });
      }
    } else if (p.type === 'key-revocation') {
      if (authority.role !== 'recovery' || p.details.revokedKeyId === authority.keyId) fail('WRONG_RECOVERY_AUTHORITY', 'Revocation needs a previously pinned independent recovery key.');
      if (!authority.anchoredAt || Date.parse(authority.anchoredAt) > issued) fail('RECOVERY_NOT_PREPINNED', 'Recovery authority must have been explicitly pinned before this revocation was issued.');
      if (Date.parse(p.details.effectiveAt) > checkedMs) fail('NOT_YET_EFFECTIVE', 'Control evidence is not effective yet.');
      const target = issuer.keys.find(k => k.keyId === p.details.revokedKeyId);
      if (!target || target.role === 'recovery') fail('INVALID_REVOCATION_TARGET', 'Target must be a known publisher or advisory key.');
      if (!seen) { if (!target.revokedAt || Date.parse(p.details.effectiveAt) < Date.parse(target.revokedAt)) target.revokedAt = p.details.effectiveAt; issuer.revocations.push({ ...clone(p.details), authorityKeyId: p.keyId, sequence: p.sequence, digest: statementDigest }); }
    } else if (p.type === 'risk-notice') {
      if (!['publisher', 'advisory'].includes(authority.role)) fail('WRONG_KEY_ROLE', 'Notice needs a publisher or explicitly pinned advisory key.');
      report.noticeAuthority = authority.role === 'publisher' ? 'publisher-self-report' : 'trusted-advisory-authority';
      if (!seen) issuer.notices.push({ ...clone(p.details), issuer: p.issuer, keyId: p.keyId, authority: report.noticeAuthority, sequence: p.sequence, issuedAt: p.issuedAt, expiresAt: p.expiresAt, digest: statementDigest });
    }
    if (!seen) { if (issuer.observations.length >= 2048) fail('TRUST_HISTORY_FULL', 'Trust history is full; retain history or explicitly review a new store.'); issuer.observations.push({ keyId: p.keyId, sequence: p.sequence, digest: statementDigest, checkedAt }); issuer.highestSequence = Math.max(issuer.highestSequence, p.sequence); }
    else if (seen.keyId === undefined) { seen.keyId = p.keyId; if (p.type === 'key-revocation') { const cached = issuer.revocations.find(r => r.digest === statementDigest); if (cached) cached.authorityKeyId = p.keyId; } }
    if (!seen) { issuer.lastCheckedAt = !issuer.lastCheckedAt || Date.parse(issuer.lastCheckedAt) < checkedMs ? checkedAt : issuer.lastCheckedAt; if (sourceStatus === 'online') issuer.lastOnlineCheckAt = checkedAt; }
    const notices = next.issuers.flatMap(i => (i.notices ?? []).map(n => ({ ...clone(n), authorityKeyStatus: activeKey(i.keys.find(k => k.keyId === n.keyId), checkedMs) ? 'active' : 'inactive-or-revoked' }))).filter(n => artifact && n.artifacts.some(a => subjectEqual(a, artifact)));
    report.notices = notices.map(n => ({ ...clone(n), expired: checkedMs >= Date.parse(n.expiresAt) }));
    if (notices.length) report.advisoryStatus = 'cached-notice-new-status-unknown';
    report.lastStatusCheckedAt = issuer.lastOnlineCheckAt;
    report.accepted = true; report.proposedState = next;
  } catch (error) {
    if (!(error instanceof PublisherEvidenceError)) throw error;
    report.error = { code: error.code, message: error.message }; report.warnings.push(error.code);
  }
  return report;
}
