// Lineage is a publisher/author declaration covered by the package lock. It
// identifies an authoring baseline, never proof of publisher identity or trust.
export const PACK_LINEAGE_FORMAT = 'world-hub.pack-lineage/v1';
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalid(message) { throw Object.assign(new Error(`Invalid pack lineage: ${message}`), { code: 'PACK_LINEAGE_INVALID' }); }
function closed(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => !fields.includes(field)) || fields.some(field => !Object.hasOwn(value, field))) invalid(`${name} has missing or unsupported fields`);
}
function id(value, name) { if (typeof value !== 'string' || !idPattern.test(value)) invalid(`${name} must be a package ID`); }
function version(value, name) { if (typeof value !== 'string' || value.length > 128 || !versionPattern.test(value)) invalid(`${name} must be an exact package version`); }
function digest(value) { if (typeof value !== 'string' || !digestPattern.test(value)) invalid('sourceDigest must be a lowercase SHA-256 authoring revision'); }
function timestamp(value) {
  if (typeof value !== 'string' || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('customizedAt must be a real canonical UTC ISO timestamp');
}

export function validatePackLineage(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) invalid('pack must be an object');
  if (!Object.hasOwn(pack, 'lineage')) return null;
  const value = pack.lineage;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('lineage must be an object');
  if (value.format !== PACK_LINEAGE_FORMAT) invalid('unsupported format');
  if (value.kind === 'self-created') {
    closed(value, ['format', 'kind'], 'self-created lineage');
    return { format: PACK_LINEAGE_FORMAT, kind: 'self-created' };
  }
  if (value.kind !== 'customized') invalid('unsupported kind');
  closed(value, ['format', 'kind', 'base', 'revision', 'customizedAt'], 'customized lineage');
  closed(value.base, ['id', 'version', 'sourceDigest'], 'base');
  id(value.base.id, 'base.id'); version(value.base.version, 'base.version'); digest(value.base.sourceDigest);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) invalid('revision must be a positive safe integer');
  timestamp(value.customizedAt);
  return { format: PACK_LINEAGE_FORMAT, kind: 'customized',
    base: { id: value.base.id, version: value.base.version, sourceDigest: value.base.sourceDigest },
    revision: value.revision, customizedAt: value.customizedAt };
}

export function summarizePackLineage(pack) { return validatePackLineage(pack); }

export function customizePackLineage(originalPack, originalRevision, nextVersion, { now, packId = originalPack?.id } = {}) {
  id(originalPack?.id, 'original package ID'); version(originalPack?.version, 'original package version');
  id(packId, 'next package ID'); version(nextVersion, 'next package version'); digest(originalRevision);
  const previous = validatePackLineage(originalPack);
  if (previous?.kind === 'self-created' && packId === originalPack.id) return previous;
  const instant = typeof now === 'function' ? now() : now === undefined ? new Date() : now;
  if (instant instanceof Date && !Number.isFinite(instant.getTime())) invalid('customizedAt must be a real canonical UTC ISO timestamp');
  const customizedAt = instant instanceof Date ? instant.toISOString() : instant;
  const lineage = { format: PACK_LINEAGE_FORMAT, kind: 'customized',
    base: previous?.kind === 'customized' ? previous.base : { id: originalPack.id, version: originalPack.version, sourceDigest: originalRevision },
    revision: previous?.kind === 'customized' ? previous.revision + 1 : 1, customizedAt };
  return validatePackLineage({ lineage });
}
