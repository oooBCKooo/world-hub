// A bounded application HTTP tunnel, separate from Hub wire and content routing.
// There is no CONNECT, WebSocket upgrade, arbitrary host URL, or redirect follow.
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { channelChunks, collectChannelChunk } from './isolation-channel.mjs';
export const ISOLATION_HTTP_EVENT = 'world-hub-isolation-http/v1';
export const HTTP_BODY_LIMIT = 1024 * 1024;
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const requestHeaders = new Set(['accept', 'accept-language', 'authorization', 'content-type', 'cookie', 'if-none-match', 'range']);
const responseHeaders = new Set(['content-type', 'cache-control', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'content-security-policy', 'referrer-policy', 'permissions-policy']);
export function internalHttpUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Invalid isolated HTTP URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || Number(url.port) < 1 || Number(url.port) > 65535)
    throw new Error('Isolated HTTP entry must be an explicit container loopback URL');
  return url;
}
export function httpFrames(id, value) { return channelChunks(id, JSON.stringify(value)).map(frame => ({ ...frame, event: ISOLATION_HTTP_EVENT })); }
export function httpBody(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(HTTP_BODY_LIMIT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid bounded HTTP body');
  const bytes = Buffer.from(value, 'base64'); if (bytes.length > HTTP_BODY_LIMIT || bytes.toString('base64') !== value) throw new Error('Invalid bounded HTTP body'); return bytes;
}
export function cleanHttpHeaders(headers, response = false) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 32) throw new Error('Invalid HTTP headers');
  const allowed = response ? responseHeaders : requestHeaders, result = {}; let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name.toLowerCase())) continue;
    if (typeof value !== 'string' || /[\r\n\0]/.test(value) || (bytes += name.length + value.length) > 16384) throw new Error('Invalid bounded HTTP headers');
    result[name.toLowerCase()] = value;
  }
  return result;
}
export function validateHttpRequest(frame) {
  if (!frame || frame.operation !== 'request' || !methods.has(frame.method) || typeof frame.path !== 'string' || frame.path.length > 4096 || !frame.path.startsWith('/') || frame.path.startsWith('//') || /[\r\n\0]/.test(frame.path)) throw new Error('Invalid isolated HTTP request');
  return { method: frame.method, path: frame.path, headers: cleanHttpHeaders(frame.headers), body: httpBody(frame.body) };
}
// Container side: hostname and port are supplied exclusively by the reviewed
// entry setup; a request frame supplies only an origin-form path.
export async function containerHttpRequest(target, frame) {
  const url = internalHttpUrl(target), value = validateHttpRequest(frame);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: Number(url.port), path: value.path, method: value.method, headers: value.headers, agent: false }, response => {
      const body = []; let bytes = 0;
      response.on('data', chunk => { if ((bytes += chunk.length) > HTTP_BODY_LIMIT) { response.destroy(); reject(new Error('Isolated HTTP response exceeds bound')); } else body.push(chunk); });
      response.once('error', reject); response.once('end', () => resolve({ operation: 'response', status: response.statusCode, headers: cleanHttpHeaders(response.headers, true), body: Buffer.concat(body).toString('base64') }));
    });
    request.setTimeout(10000, () => request.destroy(new Error('Isolated HTTP request timeout'))); request.once('error', reject); request.end(value.body);
  });
}
export async function createHttpTunnel(send, entry) {
  const internal = internalHttpUrl(entry), pending = new Map(); let host;
  const server = createServer(async (request, response) => {
    const fail = status => { response.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('Isolated HTTP tunnel rejected request'); };
    if (request.headers.host !== host || request.headers['sec-fetch-site'] === 'cross-site' || request.headers.origin && request.headers.origin !== 'http://' + host || !methods.has(request.method) || !request.url?.startsWith('/') || request.url.startsWith('//') || /[\r\n\0]/.test(request.url) || request.url.length > 4096 || pending.size >= 16) return fail(403);
    const id = randomUUID(), chunks = []; let bytes = 0, record;
    try {
      if (request.headers['content-length'] && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > HTTP_BODY_LIMIT)) return fail(413);
      for await (const chunk of request) { if ((bytes += chunk.length) > HTTP_BODY_LIMIT) return fail(413); chunks.push(chunk); }
      const completed = new Promise((resolve, reject) => { record = { resolve, reject, pending: null, timer: setTimeout(() => reject(new Error('Isolated HTTP request timeout')), 11000) }; pending.set(id, record); });
      for (const frame of httpFrames(id, { operation: 'request', method: request.method, path: request.url, headers: cleanHttpHeaders(request.headers), body: Buffer.concat(chunks).toString('base64') })) send(frame);
      const result = await completed, body = httpBody(result.body);
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || result.operation !== 'response') throw new Error('Invalid HTTP response');
      const headers = cleanHttpHeaders(result.headers, true); headers['content-length'] = body.length; headers['x-content-type-options'] = 'nosniff';
      response.writeHead(result.status, headers); response.end(request.method === 'HEAD' ? undefined : body);
    } catch { if (!response.headersSent) fail(502); else response.destroy(); }
    finally { if (record) clearTimeout(record.timer); pending.delete(id); }
  });
  server.requestTimeout = 12000; server.headersTimeout = 12000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('connect', (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); host = '127.0.0.1:' + server.address().port;
  return { url: 'http://' + host + internal.pathname, receive(frame) {
    const record = pending.get(frame.connection); if (!record) return;
    try { const result = collectChannelChunk(record.pending, frame); record.pending = result.pending; if (result.text !== null) record.resolve(JSON.parse(result.text)); } catch (error) { record.reject(error); }
  }, close: async () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('Isolated HTTP tunnel closed')); } pending.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
