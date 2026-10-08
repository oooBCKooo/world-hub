// Addressing uses authenticated communication identities, never UI program notes.
import { isValidBridgeId } from './identity.mjs';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeTarget(target, config) {
  if (!target || typeof target !== 'object' || Array.isArray(target) ||
      Object.keys(target).some((key) => key !== 'principal' && key !== 'session') ||
      !isValidBridgeId(target.principal) ||
      (target.session !== undefined && (typeof target.session !== 'string' || !SESSION.test(target.session)))) {
    throw Object.assign(new Error('target must contain a valid principal and optional authenticated session UUID'), { code: 'TARGET_INVALID' });
  }
  const known = Object.hasOwn(config.acl.bridges, target.principal) || Object.hasOwn(config.acl.credentials, target.principal);
  // Development mode admits lawful future loopback identities too. Their later
  // hello still passes the existing authentication and topic permission checks.
  if (!known && !config.acl.allowUnlistedBridges) {
    throw Object.assign(new Error('target principal is not registered'), { code: 'TARGET_UNKNOWN' });
  }
  return { principal: target.principal, ...(target.session !== undefined ? { session: target.session } : {}) };
}

export function addressMatches(entry, recipient) {
  if (entry.target === undefined) return true;
  const target = entry.target;
  return Boolean(target && typeof target === 'object' && !Array.isArray(target) &&
    typeof target.principal === 'string' && target.principal === recipient?.principal &&
    (target.session === undefined || target.session === recipient?.session));
}

const OPERATIONS = new Set(['publish', 'request', 'inject', 'response']);

export function normalizeOperations(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > OPERATIONS.size ||
      new Set(value).size !== value.length || value.some((operation) => !OPERATIONS.has(operation))) {
    throw Object.assign(new Error('operations must be a nonempty distinct subset of publish/request/inject/response'), { code: 'OPERATIONS_INVALID' });
  }
  return [...value];
}

export function operationMatches(entry, operations) {
  return operations === undefined || operations.includes(entry.operation ?? 'publish');
}
