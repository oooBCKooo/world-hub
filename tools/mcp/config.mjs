import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

export const TOOL_NAMES = Object.freeze([
  'hub_identity', 'hub_register_channels', 'hub_publish', 'hub_subscribe', 'hub_pull',
  'hub_ack', 'hub_unsubscribe', 'hub_request', 'hub_call', 'hub_inject',
  'hub_respond', 'hub_release', 'hub_blob_upload', 'hub_blob_read',
]);
export const DEFAULT_LIMITS = Object.freeze({
  connectTimeoutMs: 8000, requestTimeoutMs: 8000, maxBufferedMessages: 256,
  maxBufferedBytes: 8 * 1024 * 1024, maxResultBytes: 2 * 1024 * 1024,
  maxReadMessages: 64, maxReadWaitMs: 30000, maxBlobBytes: 1024 * 1024,
  maxConcurrentTools: 16,
});
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} has unsupported fields or is not an object`);
}
function string(value, label, max = 256) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a nonempty bounded string`);
  return value;
}
function list(value, label, { exact = false, allowed } = {}) {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} must be an array of at most 256 entries`);
  for (const item of value) {
    string(item, label);
    if (exact && /[#+]/u.test(item)) throw new Error(`${label} accepts exact names, not wildcard filters`);
    if (allowed && !allowed.includes(item)) throw new Error(`${label} contains an unsupported tool`);
  }
  return [...new Set(value)];
}

export function validateConfig(input) {
  keys(input, ['format', 'bridge', 'permissions', 'limits'], 'config');
  if (input.format !== 'world-hub.mcp/v1') throw new Error('config format must be world-hub.mcp/v1');
  keys(input.bridge, ['url', 'bridgeId', 'credential', 'token', 'expectedPrincipal', 'requireAuthenticated'], 'bridge');
  const bridge = { ...input.bridge };
  let url;
  try { url = new URL(string(bridge.url, 'bridge.url', 2048)); } catch { throw new Error('bridge.url must be a WebSocket endpoint'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('bridge.url must not contain credentials, a query, or a fragment');
  if (url.protocol === 'ws:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('unencrypted bridge.url is limited to loopback');
  string(bridge.bridgeId, 'bridge.bridgeId', 64);
  for (const key of ['credential', 'expectedPrincipal']) if (bridge[key] !== undefined) string(bridge[key], `bridge.${key}`, 128);
  if (bridge.token !== undefined) string(bridge.token, 'bridge.token', 8192);
  if (bridge.requireAuthenticated !== undefined && typeof bridge.requireAuthenticated !== 'boolean') throw new Error('bridge.requireAuthenticated must be boolean');
  bridge.requireAuthenticated ??= true;
  const source = input.permissions ?? { tools: ['hub_identity'] };
  keys(source, ['tools', 'publishTopics', 'subscribeTopics', 'targetPrincipals'], 'permissions');
  const permissions = {
    tools: list(source.tools ?? ['hub_identity'], 'permissions.tools', { allowed: TOOL_NAMES }),
    publishTopics: list(source.publishTopics ?? [], 'permissions.publishTopics', { exact: true }),
    subscribeTopics: list(source.subscribeTopics ?? [], 'permissions.subscribeTopics', { exact: true }),
    targetPrincipals: list(source.targetPrincipals ?? [], 'permissions.targetPrincipals', { exact: true }),
  };
  const limits = { ...DEFAULT_LIMITS };
  if (input.limits !== undefined) {
    keys(input.limits, Object.keys(limits), 'limits');
    for (const [key, value] of Object.entries(input.limits)) {
      const cap = key.endsWith('Bytes') ? 32 * 1024 * 1024 : key.endsWith('Ms') ? 120000 : 4096;
      if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error(`limits.${key} is outside its supported range`);
      limits[key] = value;
    }
  }
  if (limits.maxReadMessages > limits.maxBufferedMessages) throw new Error('maxReadMessages must not exceed maxBufferedMessages');
  return { format: input.format, bridge, permissions, limits };
}

export async function loadConfig(path) {
  // Credentials stay in this explicitly selected local file, never in tool arguments.
  const handle = await open(resolve(path), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('MCP config must be a regular file no larger than 64 KiB');
    const bytes = await handle.readFile();
    if (bytes.length > 64 * 1024) throw new Error('MCP config exceeds 64 KiB');
    let input;
    try { input = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')); } catch { throw new Error('MCP config is not valid JSON'); }
    return validateConfig(input);
  } finally { await handle.close(); }
}
