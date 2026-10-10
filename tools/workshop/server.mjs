import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readBounded } from '../../scripts/runtime/paths.mjs';
import { WorkshopStore, workshopError, MAX_UPLOAD } from './store.mjs';
import { validateSourceIndex } from '../../scripts/runtime/sources.mjs';
import { pipeline } from 'node:stream/promises';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const cookieName = 'world_hub_workshop_session';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
function fields(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(body, k))) throw workshopError('INVALID_INPUT', 'Missing or unsupported request fields.');
}
function sessionCookie(request) {
  const parts = (request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`));
  if (parts.length !== 1) return null; return parts[0].slice(cookieName.length + 1);
}
async function readJson(request, maximum) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw workshopError('JSON_REQUIRED', 'Use application/json.', 415);
  if (Number(request.headers['content-length']) > maximum) throw workshopError('BODY_TOO_LARGE', `Request exceeds ${maximum} bytes.`, 413);
  let size = 0; const chunks = [];
  // A finite total body deadline also covers chunked slow upload clients.
  const timer = setTimeout(() => request.destroy(), 15000); timer.unref();
  try {
    for await (const chunk of request) { size += chunk.length; if (size > maximum) throw workshopError('BODY_TOO_LARGE', `Request exceeds ${maximum} bytes.`, 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw workshopError('INVALID_JSON', 'Invalid JSON request.'); }
  } finally { clearTimeout(timer); }
}
function config(options) {
  const base = new URL(options.baseURL ?? 'https://peros.cn/workshop');
  const insecure = options.allowInsecureLoopback === true;
  if (base.username || base.password || base.hash || base.search || !['/workshop', '/workshop/'].includes(base.pathname)
      || (base.protocol !== 'https:' && !(insecure && base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))
      || (base.protocol === 'https:' && base.port && base.port !== '443')) throw workshopError('INVALID_CONFIG', 'Workshop requires a fixed HTTPS origin on port 443 and /workshop base path.');
  if (options.secureCookie === false && !(insecure && base.protocol === 'http:')) throw workshopError('INVALID_CONFIG', 'Insecure cookies are allowed only for an explicit local HTTP test origin.');
  const bind = options.bind ?? '127.0.0.1', port = options.port ?? 8970;
  if (!['127.0.0.1', '::1'].includes(bind) || !Number.isInteger(port) || port < 0 || port > 65535 || (port === 0 && !insecure)) throw workshopError('INVALID_CONFIG', 'Bind the Workshop privately on loopback; port 0 is only for local tests.');
  const allowedHosts = options.allowedHosts ?? [base.host];
  if (!Array.isArray(allowedHosts) || !allowedHosts.length || allowedHosts.length > 8 || allowedHosts.some(v => typeof v !== 'string' || !/^(?:[a-z0-9.-]+|\[::1\])(?::[0-9]{1,5})?$/.test(v))) throw workshopError('INVALID_CONFIG', 'Use a fixed Host allowlist.');
  return { base, insecure, bind, port, allowedHosts: new Set(allowedHosts), secureCookie: options.secureCookie !== false };
}
export async function createWorkshopServer(options = {}) {
  const settings = config(options), store = await WorkshopStore.open(options); let uploadBusy = false, downloads = 0, closing, baseURL, origin, stopPoll, pollBusy = false, resolveClosed;
  const closed = new Promise(resolveClosure => { resolveClosed = resolveClosure; });
  const rates = new Map();
  function rate(key, limit, windowMs = 60000) {
    const time = Date.now(); if (rates.size > 512) for (const [k, value] of rates) if (value.until <= time) rates.delete(k);
    let value = rates.get(key); if (!value || value.until <= time) { if (!value && rates.size >= 512) throw workshopError('RATE_LIMITED', 'Too many simultaneous account requests; retry after one minute.', 429); value = { count: 0, until: time + windowMs }; rates.set(key, value); }
    if (++value.count > limit) throw workshopError('RATE_LIMITED', 'Request rate exceeded; retry after one minute.', 429);
  }
  const securityHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': CSP };
  const send = (response, status, value, extra = {}) => { response.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', ...extra }); response.end(JSON.stringify(value)); };
  function cookie(rawToken, clear = false) { return `${cookieName}=${clear ? '' : rawToken}; Path=/workshop; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${settings.secureCookie ? '; Secure' : ''}`; }
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    let uploadOwned = false;
    try {
      // The only accepted direct peer is the configured local TLS gateway.
      // X-Forwarded-For is deliberately ignored: it is not an identity or rate key.
      if (!loopback(request.socket.remoteAddress) || !settings.allowedHosts.has(request.headers.host)) throw workshopError('HOST_REQUIRED', 'Configured Workshop host required.', 403);
      if (request.url.length > 4096 || !request.url.startsWith('/') || request.url.startsWith('//')) throw workshopError('INVALID_INPUT', 'Invalid request target.');
      const target = new URL(request.url, origin);
      if (target.origin !== origin || /%2f|%5c|%00/i.test(target.pathname)) throw workshopError('INVALID_INPUT', 'Invalid request target.');
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw workshopError('METHOD_NOT_ALLOWED', 'Use GET, HEAD or POST.', 405);
      const rawToken = sessionCookie(request), user = store.userForSession(rawToken);
      const path = target.pathname;
      const staticFiles = new Map([['/workshop', 'index.html'], ['/workshop/', 'index.html'], ['/workshop/index.html', 'index.html'], ['/workshop/app.mjs', 'app.mjs'], ['/workshop/style.css', 'style.css']]);
      if (staticFiles.has(path) && ['GET', 'HEAD'].includes(request.method)) {
        if (target.search) throw workshopError('INVALID_INPUT', 'Static pages do not accept query parameters.');
        const file = staticFiles.get(path), bytes = await readFile(new URL('./public/' + file, import.meta.url));
        response.writeHead(200, { ...securityHeaders, 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'content-length': bytes.length }); response.end(request.method === 'HEAD' ? undefined : bytes); return;
      }
      if (request.method === 'GET' && ['/health', '/workshop/health'].includes(path)) { send(response, 200, { ok: true, service: 'world-hub-workshop', format: 'world-hub.workshop/v1' }); return; }
      if (!path.startsWith('/workshop/')) throw workshopError('NOT_FOUND', 'Route not found.', 404);
      const allowedQuery = path === '/workshop/api/catalog' ? ['search', 'kind', 'contract', 'offset', 'limit'] : [];
      if ([...target.searchParams.keys()].some(k => !allowedQuery.includes(k) || target.searchParams.getAll(k).length !== 1)) throw workshopError('INVALID_INPUT', 'Unsupported or duplicate query field.');
      if (request.method === 'GET' && path === '/workshop/index.json') {
        const index = store.index(baseURL); if (!settings.insecure) validateSourceIndex(index); send(response, 200, index); return;
      }
      const artifactMatch = /^\/workshop\/artifacts\/([a-f0-9]{64})\.json$/.exec(path);
      if (request.method === 'GET' && artifactMatch) {
        const digest = artifactMatch[1];
        const visible = store.state.publications.some(p => !p.hidden && (p.sha256 === digest || p.proposals.some(q => q.sha256 === digest)));
        if (!visible) throw workshopError('NOT_FOUND', 'Artifact not found.', 404);
        if (downloads >= 8) throw workshopError('DOWNLOAD_BUSY', 'Download capacity reached; retry shortly.', 503);
        downloads++; let handle;
        try {
          const artifact = await store.artifactHandle(digest); handle = artifact.handle;
          response.writeHead(200, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'content-length': artifact.size, etag: `"${digest}"`, 'cache-control': 'public, max-age=31536000, immutable' });
          const deadline = setTimeout(() => response.destroy(), 20000); deadline.unref();
          try { await pipeline(handle.createReadStream({ start: 0, autoClose: false }), response); } finally { clearTimeout(deadline); }
        } finally { await handle?.close(); downloads--; }
        return;
      }
      if (request.method === 'GET' && path === '/workshop/api/me') { send(response, 200, { user, ...(user ? { csrfToken: store.csrfForSession(rawToken) } : {}) }); return; }
      if (request.method === 'GET' && path === '/workshop/api/catalog') {
        const parameters = Object.fromEntries(target.searchParams); for (const field of ['offset', 'limit']) if (Object.hasOwn(parameters, field)) { if (!/^\d+$/.test(parameters[field])) throw workshopError('INVALID_INPUT', 'Invalid pagination.'); parameters[field] = Number(parameters[field]); }
        send(response, 200, store.catalog(parameters, user)); return;
      }
      const publicationMatch = /^\/workshop\/api\/publications\/([a-z0-9][a-z0-9._-]{0,127})(?:\/(comments|proposals|visibility)(?:\/([a-z0-9][a-z0-9._-]{0,127}))?)?$/.exec(path);
      if (request.method === 'GET' && publicationMatch && !publicationMatch[2]) { send(response, 200, store.detail(publicationMatch[1], user)); return; }
      if (request.method === 'GET' && publicationMatch?.[2] === 'proposals' && publicationMatch[3]) { send(response, 200, await store.proposal(publicationMatch[1], publicationMatch[3], user)); return; }
      if (request.method === 'GET' && path === '/workshop/api/users') { if (!user) throw workshopError('AUTH_REQUIRED', 'Sign in first.', 401); send(response, 200, store.users(user)); return; }
      if (request.method !== 'POST') throw workshopError('NOT_FOUND', 'Route not found.', 404);
      if (request.headers.origin !== origin || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) throw workshopError('ORIGIN_REQUIRED', 'Exact Workshop origin required.', 403);
      rate('global-mutation', 120);
      const authentication = ['/workshop/api/login', '/workshop/api/register'].includes(path);
      if (!authentication) {
        if (!user) throw workshopError('AUTH_REQUIRED', 'Sign in first.', 401);
        if (!store.csrfValid(rawToken, request.headers['x-csrf-token'])) throw workshopError('CSRF_REQUIRED', 'Valid Workshop CSRF token required.', 403);
        rate(`mutation:${user.id}`, 60);
      }
      const upload = path === '/workshop/api/publications' || (publicationMatch?.[2] === 'proposals' && !publicationMatch[3]);
      if (upload) { if (uploadBusy) throw workshopError('UPLOAD_BUSY', 'Another upload is being validated; retry shortly.', 503); uploadBusy = true; uploadOwned = true; rate(`upload:${user.id}`, 10); }
      if (authentication) rate('global-auth', 24);
      const body = await readJson(request, upload ? MAX_UPLOAD : 16384); let result, status = 200, headers = {};
      if (path === '/workshop/api/login') { fields(body, ['username', 'password'], ['username', 'password']); rate(`login:${String(body.username).slice(0, 40)}`, 8); result = await store.login(body.username, body.password); }
      else if (path === '/workshop/api/register') { fields(body, ['username', 'password', 'invitation'], ['username', 'password', 'invitation']); result = await store.register(body.username, body.password, body.invitation); status = 201; }
      else if (path === '/workshop/api/logout') { fields(body, []); result = await store.logout(rawToken); headers['set-cookie'] = cookie('', true); }
      else if (path === '/workshop/api/invitations') { fields(body, []); result = await store.invite(user); status = 201; }
      else if (path === '/workshop/api/publications') { fields(body, ['artifact', 'redistributionAcknowledged', 'title'], ['artifact', 'redistributionAcknowledged']); result = await store.publish(user, body); status = result.duplicate ? 200 : 201; }
      else if (publicationMatch?.[2] === 'comments' && !publicationMatch[3]) { fields(body, ['text'], ['text']); rate(`comment:${user.id}`, 20); result = await store.comment(user, publicationMatch[1], body.text); status = 201; }
      else if (publicationMatch?.[2] === 'proposals' && !publicationMatch[3]) { fields(body, ['artifact', 'baseSha256', 'redistributionAcknowledged', 'title'], ['artifact', 'baseSha256', 'redistributionAcknowledged']); result = await store.propose(user, publicationMatch[1], body); status = 201; }
      else if (publicationMatch?.[2] === 'visibility' && !publicationMatch[3]) { fields(body, ['hidden'], ['hidden']); result = await store.visibility(user, publicationMatch[1], body.hidden); }
      else if (/^\/workshop\/api\/users\/[a-z0-9][a-z0-9._-]{0,127}\/status$/.test(path)) { fields(body, ['disabled'], ['disabled']); result = await store.setUserStatus(user, path.split('/')[4], body.disabled); }
      else throw workshopError('NOT_FOUND', 'Route not found.', 404);
      if (result.sessionToken) { headers['set-cookie'] = cookie(result.sessionToken); delete result.sessionToken; }
      send(response, status, result, headers);
    } catch (error) {
      // Filesystem paths, passwords, cookies and uploaded source are never echoed.
      if (!response.headersSent && !response.destroyed) send(response, error.status ?? 500, { error: { code: error.status ? error.code : 'WORKSHOP_FAILURE', message: error.status ? error.message : 'Workshop could not complete this operation.' } }, request.method === 'POST' ? { connection: 'close' } : {});
    } finally { if (uploadOwned) uploadBusy = false; }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.timeout = 30000; server.maxConnections = 64; server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('error', () => {});
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(settings.port, settings.bind, () => { server.removeListener('error', reject); resolveListen(); }); });
    if (settings.insecure && settings.port === 0) { settings.base.port = String(server.address().port); settings.allowedHosts = new Set([settings.base.host]); }
    origin = settings.base.origin; baseURL = `${origin}/workshop`;
  } catch (error) { await store.close(); throw error; }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(stopPoll); const stopped = new Promise(resolveClose => server.close(resolveClose)); server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), 2000); timer.unref(); await stopped; clearTimeout(timer);
      // Remove only the current generation's private stop request, before
      // releasing its exclusive owner lock to a replacement server.
      try { const value = JSON.parse((await readBounded(join(store.root, 'workshop-stop.json'), 4096)).toString('utf8')); if (value.format === 'world-hub.workshop-stop/v1' && value.nonce === store.nonce) await unlink(join(store.root, 'workshop-stop.json')); } catch { /* Leave an unsafe or malformed private request untouched. */ }
      await store.close(); resolveClosed();
    })(); return closing;
  }
  stopPoll = setInterval(async () => {
    if (pollBusy || closing) return; pollBusy = true;
    try {
      const value = JSON.parse((await readBounded(join(store.root, 'workshop-stop.json'), 4096)).toString('utf8'));
      if (value.format === 'world-hub.workshop-stop/v1' && value.nonce === store.nonce) await close();
    } catch (error) { if (error.code !== 'ENOENT') { /* A malformed private file cannot authorize shutdown. */ } }
    finally { pollBusy = false; }
  }, 250); stopPoll.unref();
  return { server, store, url: `${baseURL}/`, origin, baseURL, bind: settings.bind, port: server.address().port, close, closed };
}
