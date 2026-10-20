// Local lifecycle policy. Artifact authors and Hub Core cannot grant callers
// permission to acquire a process on this machine.
import { safeId } from '../../scripts/runtime/package.mjs';
import { hash } from '../../scripts/runtime/paths.mjs';

const fault = message => Object.assign(new Error(message), { code: 'EXECUTION_POLICY_INVALID', status: 409 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export const DEFAULT_EXECUTION_POLICY = Object.freeze({ mode: 'resident', idleTimeoutMs: 60000, allowedCallers: Object.freeze([]) });

function normalized(value) {
  if (!plain(value) || Object.keys(value).some(key => !['mode', 'idleTimeoutMs', 'allowedCallers'].includes(key))
      || !['resident', 'on-demand'].includes(value.mode)
      || !Number.isSafeInteger(value.idleTimeoutMs) || value.idleTimeoutMs < 1000 || value.idleTimeoutMs > 86400000
      || !Array.isArray(value.allowedCallers) || value.allowedCallers.length > 128
      || new Set(value.allowedCallers).size !== value.allowedCallers.length)
    throw fault('Choose resident or on-demand, an idle timeout from 1000 to 86400000 ms, and distinct registered caller IDs.');
  for (const id of value.allowedCallers) {
    try { safeId(id, 'allowed lifecycle caller'); } catch { throw fault('Allowed callers must be safe local program IDs.'); }
  }
  return { mode: value.mode, idleTimeoutMs: value.idleTimeoutMs, allowedCallers: [...value.allowedCallers].sort() };
}

export function executionPolicy(row) {
  return normalized(row?.executionPolicy === undefined ? DEFAULT_EXECUTION_POLICY : row.executionPolicy);
}

export function executionPolicyRevision(row) {
  return hash(JSON.stringify({ programId: row.programId, policy: executionPolicy(row) }));
}

export function validateExecutionPolicy(input, { targetId, knownIds } = {}) {
  const policy = normalized(input), known = new Set(knownIds ?? []);
  if (!known.has(targetId)) throw fault('Choose a registered target instance.');
  if (policy.allowedCallers.some(id => id === targetId || !known.has(id)))
    throw fault('Each allowed caller must be another registered local instance.');
  return policy;
}
