// Authors may suggest a module's initial lifecycle mode and idle timeout.
// These deployment defaults never grant callers permission or start a process.
const invalid = message => Object.assign(new Error(message), { code: 'DEPLOYMENT_INVALID' });
const fields = new Set(['mode', 'idleTimeoutMs']);

export function validateExecutionDefaults(value) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (!value || typeof value !== 'object' || prototype !== Object.prototype && prototype !== null
      || Reflect.ownKeys(value).some(key => !fields.has(key))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, 'value'))
      || !Object.hasOwn(value, 'mode') || !['resident', 'on-demand'].includes(value.mode)) {
    throw invalid('Execution defaults require a resident or on-demand mode and only an optional idle timeout.');
  }
  const idleTimeoutMs = Object.hasOwn(value, 'idleTimeoutMs') ? value.idleTimeoutMs : 60000;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 86400000) {
    throw invalid('Execution defaults require an idle timeout from 1000 to 86400000 ms.');
  }
  return { mode: value.mode, idleTimeoutMs };
}

export function initialExecutionPolicy(deployment = {}, override) {
  const declared = override !== undefined ? override
    : Object.hasOwn(deployment ?? {}, 'executionDefaults') ? deployment.executionDefaults
      : { mode: 'resident' };
  return { ...validateExecutionDefaults(declared), allowedCallers: [] };
}
