import { getManagementOperation, MANAGEMENT_OPERATIONS } from './management-operations.mjs';

export { getManagementOperation, MANAGEMENT_OPERATIONS };

const fault = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const secretNames = new Set(['csrftoken', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'authorizationreceipt', 'authorizationreceipts', 'approvalreceipt', 'approvalreceipts', 'credential', 'credentials', 'credentialtokens', 'password', 'secret', 'snippets']);

// Application envelopes are opaque. A business payload's own "token" field is
// application data, whereas a management connection grant's token is a secret.
export function redactManagementResult(value, { opaque = false, secrets = [] } = {}) {
  if (opaque) return value;
  if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value; }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(child => redactManagementResult(child, { secrets }));
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (secretNames.has(key.toLowerCase())) return [];
    return [[key, redactManagementResult(child, { opaque: key === 'body' || key === 'bodyRaw', secrets })]];
  }));
}

function originURL(input) {
  if (typeof input !== 'string' || /[\s\\]/u.test(input)) throw fault('MANAGEMENT_URL_INVALID', 'Use an explicit loopback HTTP origin, without credentials, path, query or fragment.');
  let parsed;
  try { parsed = new URL(input); } catch { throw fault('MANAGEMENT_URL_INVALID', 'Use a valid loopback HTTP origin.'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/u.test(input)) {
    throw fault('MANAGEMENT_URL_INVALID', 'Management clients accept only a literal loopback HTTP origin without credentials, path, query or fragment.');
  }
  // Never resolve localhost through system DNS or an external proxy hostname.
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  return parsed.origin;
}

function validateInput(operation, input) {
  if (!plainObject(input)) throw fault('MANAGEMENT_INPUT_INVALID', 'Operation input must be a JSON object.');
  if (operation.requiresReview && (typeof input.reviewId !== 'string' || !input.reviewId.trim())) throw fault('MANAGEMENT_REVIEW_REQUIRED', 'Provide the reviewId from the separately inspected current preview.');
  if (operation.requiresAcceptance && input.accepted !== true) throw fault('MANAGEMENT_ACCEPTANCE_REQUIRED', 'Explicit accepted: true is required for this operation.');
  for (const key of operation.schema?.required ?? []) if (!Object.hasOwn(input, key)) throw fault('MANAGEMENT_INPUT_INVALID', `Missing required input: ${key}.`);
  for (const [key, schema] of Object.entries(operation.schema?.properties ?? {})) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (schema.type === 'string' && (typeof value !== 'string' || schema.minLength && value.length < schema.minLength || schema.pattern && !new RegExp(schema.pattern).test(value))
      || schema.type === 'integer' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))
      || schema.type === 'array' && !Array.isArray(value)
      || schema.enum && !schema.enum.includes(value)
      || Object.hasOwn(schema, 'const') && schema.const !== value) throw fault('MANAGEMENT_INPUT_INVALID', `Invalid input: ${key}.`);
  }
  let json;
  try { json = JSON.stringify(input); } catch { throw fault('MANAGEMENT_INPUT_INVALID', 'Operation input must contain JSON-serializable values.'); }
  if (json === undefined) throw fault('MANAGEMENT_INPUT_INVALID', 'Operation input must be a JSON object.');
}

function errorValue(value, status) {
  if (value && typeof value === 'object' && (value.error || value.ok === false)) {
    const detail = typeof value.error === 'object' && value.error ? value.error : value;
    const code = typeof detail.code === 'string' ? detail.code : typeof value.error === 'string' ? value.error : 'MANAGEMENT_OPERATION_FAILED';
    const message = typeof detail.message === 'string' ? detail.message : typeof value.message === 'string' ? value.message : 'The management operation failed.';
    return fault(code, message, { status, details: redactManagementResult(detail) });
  }
  return status >= 400 ? fault('MANAGEMENT_HTTP_ERROR', `Management API returned HTTP ${status}.`, { status }) : null;
}

export class ManagementClient {
  constructor({ url = 'http://127.0.0.1:8790', timeoutMs = 30000, maxResponseBytes = 8 * 1024 * 1024, fetchImpl = globalThis.fetch } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw fault('MANAGEMENT_OPTIONS_INVALID', 'timeoutMs must be an integer from 1 through 3600000.');
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) throw fault('MANAGEMENT_OPTIONS_INVALID', 'maxResponseBytes must be an integer from 1 through 67108864.');
    if (typeof fetchImpl !== 'function') throw fault('MANAGEMENT_OPTIONS_INVALID', 'fetchImpl must be a function.');
    Object.defineProperties(this, { url: { value: originURL(url), enumerable: true }, timeoutMs: { value: timeoutMs }, maxResponseBytes: { value: maxResponseBytes }, fetchImpl: { value: fetchImpl } });
  }

  async execute(operationName, input = {}, { signal, includeSecrets = false } = {}) {
    const operation = getManagementOperation(operationName);
    if (!operation) throw fault('MANAGEMENT_OPERATION_UNKNOWN', `Unknown management operation: ${String(operationName)}.`);
    validateInput(operation, input);
    if (typeof includeSecrets !== 'boolean') throw fault('MANAGEMENT_OPTIONS_INVALID', 'includeSecrets must be an explicit boolean.');
    if (includeSecrets && operationName !== 'external.apply') throw fault('MANAGEMENT_OPTIONS_INVALID', 'Private credential delivery is available only for external.apply.');
    const controller = new AbortController();
    let timedOut = false, sentWrite = false, csrfToken;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    timer.unref?.();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const request = async (path, init) => {
      const response = await this.fetchImpl(this.url + path, { ...init, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw fault('MANAGEMENT_REDIRECT_REJECTED', 'Management redirects are not followed.', { status: response.status });
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxResponseBytes) { await response.body?.cancel().catch(() => {}); throw fault('MANAGEMENT_RESPONSE_TOO_LARGE', 'Management response exceeded its byte limit.'); }
      const chunks = []; let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            total += value.byteLength;
            if (total > this.maxResponseBytes) { await reader.cancel(); throw fault('MANAGEMENT_RESPONSE_TOO_LARGE', 'Management response exceeded its byte limit.'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let text, value;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); }
      catch { throw fault('MANAGEMENT_RESPONSE_INVALID', 'Management API returned invalid UTF-8 JSON.', { status: response.status }); }
      const failure = errorValue(value, response.status);
      if (failure) { failure.message = redactManagementResult(failure.message, { secrets: [csrfToken] }); failure.details = redactManagementResult(failure.details, { secrets: [csrfToken] }); throw failure; }
      return { value, text };
    };
    try {
      let path = operation.path;
      for (const param of operation.params ?? []) path = path.replace(`:${param}`, encodeURIComponent(input[param]));
      const query = new URLSearchParams();
      if (operation.method === 'GET') {
        const allowed = new Set([...(operation.params ?? []), ...(operation.query ?? [])]);
        for (const key of Object.keys(input)) if (!allowed.has(key)) throw fault('MANAGEMENT_INPUT_INVALID', `Unexpected GET input: ${key}.`);
        for (const key of operation.query ?? []) if (Object.hasOwn(input, key)) query.set(key, String(input[key]));
        if (query.size) path += '?' + query;
      }
      const headers = { accept: 'application/json' };
      let body;
      if (operation.method === 'POST') {
        const { value: state } = await request('/manage/api/state', { method: 'GET', headers });
        if (typeof state?.csrfToken !== 'string' || !state.csrfToken) throw fault('MANAGEMENT_CSRF_MISSING', 'Hub did not return its current local management token.');
        csrfToken = state.csrfToken;
        headers['content-type'] = 'application/json'; headers['x-management-token'] = csrfToken;
        const parameters = new Set(operation.params ?? []);
        body = JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => !parameters.has(key))));
        sentWrite = !operation.readOnly;
      }
      const { value, text } = await request(path, { method: operation.method, headers, ...(body === undefined ? {} : { body }) });
      const result = includeSecrets ? Object.fromEntries(Object.entries(value).filter(([key]) => key.toLowerCase() !== 'csrftoken')) : redactManagementResult(value, { secrets: [csrfToken] });
      // Retained envelopes may use integers outside IEEE-754, exponents or exact
      // JSON escapes. Consumers must use rawJSON for lossless forwarding/export.
      if (['messages.get', 'hub.log'].includes(operationName)) return { ...result, rawJSON: text };
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        const fields = sentWrite ? { outcome: 'unknown', retrySafe: false } : { retrySafe: true };
        throw fault(timedOut ? 'MANAGEMENT_TIMEOUT' : 'MANAGEMENT_ABORTED', `${timedOut ? 'Management request timed out' : 'Management request was aborted'}.${sentWrite ? ' The write outcome is unknown; inspect current state before deciding whether to retry.' : ''}`, fields);
      }
      if (error.code?.startsWith('MANAGEMENT_') || error.status !== undefined) {
        if (sentWrite && ['MANAGEMENT_RESPONSE_INVALID', 'MANAGEMENT_RESPONSE_TOO_LARGE', 'MANAGEMENT_REDIRECT_REJECTED'].includes(error.code)) Object.assign(error, { outcome: 'unknown', retrySafe: false });
        throw error;
      }
      throw fault('MANAGEMENT_REQUEST_FAILED', `Cannot complete the local management request.${sentWrite ? ' The write outcome is unknown; inspect current state before deciding whether to retry.' : ''}`, sentWrite ? { outcome: 'unknown', retrySafe: false } : { retrySafe: true });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
