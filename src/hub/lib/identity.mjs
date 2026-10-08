// Stable communication IDs never contain the instance separator added by Hub.
export const BRIDGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidBridgeId(id) {
  return typeof id === 'string' && BRIDGE_ID_PATTERN.test(id);
}
