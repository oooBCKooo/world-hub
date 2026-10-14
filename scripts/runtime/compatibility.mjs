// Deployment compatibility is a contract, not a product release number.
// Import the Hub library only: importing this module never opens a server.
import { WIRE_VERSION } from '../../src/hub/lib/hub.mjs';

export const PACK_LOCK_FORMAT_V2 = 'world-hub.pack-lock/v2';
export const RUNTIME_API = 'world-hub.run/v1';

export function currentHubCompatibility() {
  return { wireVersion: WIRE_VERSION, runtimeApi: RUNTIME_API };
}

export function validateHubCompatibility(value) {
  const keys = ['wireVersion', 'runtimeApi'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    throw new Error('hubCompatibility has missing or unsupported fields');
  for (const key of keys) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 128 || /[\s\0]/.test(value[key]))
      throw new Error(`Invalid hubCompatibility.${key}`);
  }
  return value;
}

function incompatible(code, message, compatibility) {
  return Object.assign(new Error(message), { code, compatibility });
}

// Only the current lock format is accepted. Release metadata does not select
// an older protocol implementation or enable fallback behavior.
export function checkHubCompatibility(lock, installedHubVersion) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('lock must be an object');
  if (typeof installedHubVersion !== 'string' || !installedHubVersion) throw new Error('Installed Hub version is required');
  const actual = currentHubCompatibility();
  if (lock.format !== PACK_LOCK_FORMAT_V2) throw Object.assign(new Error('Unsupported lock format. Obtain a current package from its publisher; older lock formats are not supported.'), { code: 'PACK_LOCK_OBSOLETE' });
  validateHubCompatibility(lock.hubCompatibility);
  const required = { ...lock.hubCompatibility };
  const compatibility = { format: 'world-hub.hub-compatibility/v1', mode: 'contracts',
    recordedHubVersion: lock.hubVersion, installedHubVersion, required, actual,
    compatible: required.wireVersion === actual.wireVersion && required.runtimeApi === actual.runtimeApi };
  if (!compatibility.compatible) throw incompatible('PACK_HUB_CONTRACT_UNSUPPORTED',
    `Unsupported Hub compatibility contract: requires wire ${required.wireVersion} and Runtime API ${required.runtimeApi}; installed wire ${actual.wireVersion} and Runtime API ${actual.runtimeApi}.`, compatibility);
  return compatibility;
}
