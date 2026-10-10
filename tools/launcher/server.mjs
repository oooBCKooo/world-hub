import { createServer } from 'node:http';
import { readFile, open, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { LauncherManager, launcherError } from './manager.mjs';
import { ordinaryPath, readBounded } from '../../scripts/runtime/paths.mjs';
import { diagnose } from './diagnostics.mjs';

const secret = () => randomBytes(32).toString('base64url');
const equals = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const defaultRoot = () => join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'WorldHub', 'launcher');
function fields(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))
    || required.some(k => !Object.hasOwn(body, k))) throw launcherError('INVALID_INPUT', 'Missing or unsupported request fields.', 400);
  for (const [key, value] of Object.entries(body)) {
    if (['accepted', 'redistributionAcknowledged', 'allowPrivateNetwork', 'enabled'].includes(key)) { if (typeof value !== 'boolean') throw launcherError('INVALID_INPUT', `Invalid ${key}`, 400); }
    else if (['priority', 'revision'].includes(key)) { if (!Number.isSafeInteger(value)) throw launcherError('INVALID_INPUT', `Invalid ${key}`, 400); }
    else if (key === 'expectedSha256' && value === '') { /* Explicitly clear an optional source pin. */ }
    else if (['pack', 'values', 'identity', 'template', 'isolation'].includes(key)) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw launcherError('INVALID_INPUT', `Invalid ${key} object`, 400); }
    else if (key === 'statePolicies') { if (!Array.isArray(value) || value.length > 32 || value.some(policy => !policy || typeof policy !== 'object' || Array.isArray(policy))) throw launcherError('INVALID_INPUT', 'Invalid state policies', 400); }
    else if (key === 'replacements') {
      if (!Array.isArray(value) || value.length > 32) throw launcherError('INVALID_INPUT', 'Invalid replacements', 400);
      for (const replacement of value) fields(replacement, ['componentId', 'moduleDirectory'], ['componentId', 'moduleDirectory']);
    } else if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw launcherError('INVALID_INPUT', `Invalid ${key}`, 400);
  }
}
async function bodyOf(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw launcherError('JSON_REQUIRED', 'Use application/json.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 32768) throw launcherError('BODY_TOO_LARGE', 'JSON body exceeds 32 KiB.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw launcherError('INVALID_JSON', 'Invalid JSON body.', 400); }
}
async function requirements(directory) {
  try {
    await ordinaryPath(directory);
    const value = JSON.parse((await readBounded(join(resolve(directory), 'pack.lock'))).toString('utf8'));
    const short = text => typeof text === 'string' ? text.slice(0, 128) : null;
    return { hubVersion: short(value.hubVersion), platform: { os: short(value.platform?.os), arch: short(value.platform?.arch) },
      runtimes: Object.fromEntries(['node', 'python'].filter(kind => value.runtimes?.[kind]).map(kind => [kind, { version: short(value.runtimes[kind].version),
        ...(kind === 'python' ? { packages: Object.fromEntries(Object.entries(value.runtimes[kind].packages ?? {}).slice(0, 32).map(([name, version]) => [name.slice(0, 64), short(version)])) } : {}) }])) };
  } catch { return null; }
}
export async function createLauncherServer(options = {}) {
  const manager = new LauncherManager({ ...options, root: options.root ?? defaultRoot() }); await manager.initialize();
  const ownerPath = join(manager.root, 'launcher-owner.lock'), ownerNonce = randomUUID();
  await ordinaryPath(ownerPath, { allowMissing: true });
  let owner;
  try { owner = await open(ownerPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw launcherError('LAUNCHER_LOCKED', 'This root already has a Launcher owner. Inspect abandoned locks manually; stored PIDs are never killed.');
    throw error;
  }
  await owner.writeFile(JSON.stringify({ nonce: ownerNonce, pid: process.pid, startedAt: new Date().toISOString() })); await owner.close();
  const token = secret(), csrfToken = secret(), bootstrapCode = secret(), tokens = new Set([token]); let bootstrapUsed = false, url, closing;
  const context = () => ({ version: 'world-hub.launcher/v1', root: manager.root, defaults: manager.defaults, csrfToken,
    softwareVersion: options.version ?? null, sandbox: false });
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    let directory;
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.host !== new URL(url).host
        || (request.headers.origin !== undefined && request.headers.origin !== url.slice(0, -1))) throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Only this Launcher origin is accepted.', 403);
      const target = new URL(request.url, url);
      if (target.origin !== new URL(url).origin) throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Invalid request origin.', 403);
      const document = request.method === 'GET' && ['/', '/index.html'].includes(target.pathname);
      if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])
        && !(document && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document'))
        throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Only same-origin API and resource requests are accepted.', 403);
      if (request.method === 'GET' && ['/', '/index.html', '/app.mjs', '/advanced.mjs', '/completion-ui.mjs', '/style.css', '/i18n.mjs'].includes(target.pathname)) {
        const navigationKeys = document ? ['instance', 'runId', 'hubOrigin', 'bridgeId', 'session'] : [];
        if ([...target.searchParams.keys()].some(key => !navigationKeys.includes(key) || target.searchParams.getAll(key).length !== 1
          || target.searchParams.get(key).length > 4096)) throw launcherError('INVALID_INPUT', 'Unsupported navigation query.', 400);
        const file = target.pathname === '/' ? 'index.html' : target.pathname.slice(1);
        const bytes = await readFile(new URL('./public/' + file, import.meta.url));
        response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        response.end(bytes); return;
      }
      const authorization = request.headers.authorization;
      const authenticated = typeof authorization === 'string' && [...tokens].some(value => equals(authorization, 'Bearer ' + value));
      const allowedQuery = target.pathname.endsWith('/topology') ? ['runId'] : [];
      if ([...target.searchParams.keys()].some(key => !allowedQuery.includes(key) || target.searchParams.getAll(key).length !== 1)) throw launcherError('INVALID_INPUT', 'Unsupported query.', 400);
      if (target.pathname === '/api/session' && request.method === 'POST' && !authenticated) {
        if (request.headers.origin !== url.slice(0, -1)) throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Bootstrap requires the exact Launcher origin.', 403);
        const body = await bodyOf(request); fields(body, ['code'], ['code']);
        if (bootstrapUsed || !equals(body.code, bootstrapCode)) throw launcherError('BOOTSTRAP_INVALID', 'Launch code is invalid or already used. Open a new Launcher session from its owning terminal.', 401);
        bootstrapUsed = true; const uiToken = secret(); tokens.add(uiToken); send(response, 200, { ok: true, token: uiToken, ...context() }); return;
      }
      if (!authenticated) throw launcherError('AUTH_REQUIRED', 'Launcher authorization required.', 401);
      if (request.method !== 'GET' && !equals(request.headers['x-csrf-token'], csrfToken)) throw launcherError('CSRF_REQUIRED', 'Launcher CSRF token required.', 403);
      let body;
      if (request.method === 'POST') body = await bodyOf(request);
      let result, status = 200;
      if (target.pathname === '/api/session' && request.method === 'GET') result = context();
      else if (target.pathname === '/api/environment' && request.method === 'POST') { fields(body, ['nodePath', 'pythonPath']); result = await manager.detect(body); }
      else if (target.pathname === '/api/isolation/probe' && request.method === 'POST') { fields(body, ['dockerPath', 'endpoint'], ['dockerPath', 'endpoint']); result = await manager.isolationProbe(body); }
      else if (target.pathname === '/api/environment/plan' && request.method === 'POST') { fields(body, ['directory', 'nodePath', 'pythonPath'], ['directory']); directory = body.directory; result = await manager.environmentPlan(body); }
      else if (target.pathname === '/api/environment/prepare' && request.method === 'POST') { fields(body, ['planId', 'accepted'], ['planId', 'accepted']); result = manager.prepareEnvironment(body.planId, body.accepted); status = 202; }
      else if (target.pathname === '/api/backups/inspect' && request.method === 'POST') { fields(body, ['backup'], ['backup']); result = { inspection: await manager.inspectBackup(body.backup) }; }
      else if (target.pathname === '/api/backups/restore' && request.method === 'POST') { fields(body, ['backup', 'sha256', 'instanceId', 'nodePath', 'pythonPath', 'accepted'], ['backup', 'sha256', 'instanceId', 'accepted']); result = await manager.restore(body); status = 202; }
      else if (target.pathname === '/api/templates/inspect' && request.method === 'POST') { fields(body, ['directory'], ['directory']); result = await manager.templateInspect(body); }
      else if (target.pathname === '/api/templates/preview' && request.method === 'POST') { fields(body, ['directory', 'values', 'identity'], ['directory', 'values']); result = await manager.templatePreview(body); }
      else if (target.pathname === '/api/templates/instantiate' && request.method === 'POST') { fields(body, ['previewId', 'destination', 'redistributionAcknowledged'], ['previewId', 'destination', 'redistributionAcknowledged']); result = manager.templateInstantiate(body); status = 202; }
      else if (target.pathname === '/api/templates/create' && request.method === 'POST') { fields(body, ['directory', 'template', 'destination', 'redistributionAcknowledged', 'expectedPackSha256'], ['directory', 'template', 'destination', 'redistributionAcknowledged']); result = manager.templateCreate(body); status = 202; }
      else if (target.pathname === '/api/authoring/inspect' && request.method === 'POST') { fields(body, ['directory', 'nodePath', 'pythonPath'], ['directory']); directory = body.directory; result = { authoring: await manager.authoring(body) }; }
      else if (target.pathname === '/api/authoring/preview' && request.method === 'POST') { fields(body, ['directory', 'componentId', 'moduleDirectory', 'nodePath', 'pythonPath'], ['directory', 'componentId', 'moduleDirectory']); result = { preview: await manager.previewReplacement(body) }; }
      else if (target.pathname === '/api/authoring/read-comments' && request.method === 'POST') { fields(body, ['directory'], ['directory']); result = { comments: await manager.comments(body) }; }
      else if (/^\/api\/authoring\/(derive|rebuild|proposal|apply-proposal|comments|export-comments|import-comments)$/.test(target.pathname) && request.method === 'POST') {
        const kind = target.pathname.split('/').at(-1);
        const allowed = ['directory', 'destination', 'nodePath', 'pythonPath', 'redistributionAcknowledged', 'expectedRevision'];
        const required = ['directory', 'destination', 'redistributionAcknowledged'];
        if (['derive', 'proposal'].includes(kind)) { allowed.push('pack', 'replacements'); required.push('expectedRevision'); }
        if (kind === 'apply-proposal') { allowed.push('proposalDirectory'); required.push('proposalDirectory'); }
        if (kind === 'comments') { allowed.splice(0, allowed.length, 'directory', 'author', 'text', 'expectedRevision'); required.splice(0, required.length, 'directory', 'author', 'text', 'expectedRevision'); }
        if (kind === 'export-comments') { allowed.splice(0, allowed.length, 'directory', 'destination'); required.splice(0, required.length, 'directory', 'destination'); }
        if (kind === 'import-comments') { allowed.splice(0, allowed.length, 'directory', 'source', 'expectedRevision'); required.splice(0, required.length, 'directory', 'source', 'expectedRevision'); }
        fields(body, allowed, required); result = manager.creator(kind === 'comments' ? 'comment' : kind, body); status = 202;
      }
      else if (target.pathname === '/api/sources' && request.method === 'GET') result = await manager.sources();
      else if (['/api/sources', '/api/sources/save'].includes(target.pathname) && request.method === 'POST') { fields(body, ['id', 'name', 'source', 'enabled', 'priority', 'expectedSha256', 'allowPrivateNetwork', 'revision'], ['name', 'source']); result = await manager.saveSource(body); }
      else if (/^\/api\/sources\/[a-z0-9._-]+\/delete$/.test(target.pathname) && request.method === 'POST') { fields(body, []); result = await manager.deleteSource(target.pathname.split('/').at(-2)); }
      else if (target.pathname === '/api/sources/inspect' && request.method === 'POST') { fields(body, ['source', 'sourceId', 'expectedSha256', 'allowPrivateNetwork']); if (!body.source && !body.sourceId) throw launcherError('SOURCE_INPUT', 'Select a source.', 400); result = await manager.source(body); }
      else if (target.pathname === '/api/sources/fetch' && request.method === 'POST') { fields(body, ['source', 'sourceId', 'receiptId', 'indexDigest', 'entryId', 'allowPrivateNetwork'], ['entryId']); if (!body.source && !body.sourceId) throw launcherError('SOURCE_INPUT', 'Select a source.', 400); result = manager.fetchSource(body); status = 202; }
      else if (target.pathname === '/api/sources/publish' && request.method === 'POST') { fields(body, ['directory', 'destination', 'kind', 'nodePath', 'pythonPath', 'redistributionAcknowledged'], ['directory', 'destination', 'kind', 'redistributionAcknowledged']); result = manager.creator('publish', body); status = 202; }
      else if (target.pathname === '/api/review' && request.method === 'POST') { fields(body, ['directory', 'nodePath', 'pythonPath', 'isolation'], ['directory']); directory = body.directory; result = await manager.review(directory, body); }
      else if (target.pathname === '/api/instances' && request.method === 'GET') result = { instances: await manager.instances() };
      else if (target.pathname === '/api/instances' && request.method === 'POST') { fields(body, ['reviewId', 'instanceId'], ['reviewId', 'instanceId']); result = { instance: await manager.import(body.reviewId, body.instanceId) }; }
      else if (target.pathname === '/api/hubs' && request.method === 'GET') result = { hubs: await manager.hubs() };
      else if (/^\/api\/hubs\/default\/(?:start|stop)$/.test(target.pathname) && request.method === 'POST') { fields(body, []); result = manager.defaultHub(target.pathname.split('/').at(-1)); status = 202; }
      else if (/^\/api\/operations\/[a-f0-9-]+$/.test(target.pathname) && request.method === 'GET') result = { operation: manager.operation(target.pathname.split('/').at(-1)) };
      else if (/^\/api\/operations\/[a-f0-9-]+\/cancel$/.test(target.pathname) && request.method === 'POST') { fields(body, []); result = { operation: await manager.cancelOperation(target.pathname.split('/').at(-2)) }; }
      else {
        const match = /^\/api\/instances\/([a-z0-9][a-z0-9._-]{0,63})(?:\/(review|start|stop|restart|logs|export|topology|storage|backup|detach|reattach|upgrade-plan|upgrade|upgrade-history|rollback-plan|rollback-upgrade|recover-upgrade))?$/.exec(target.pathname);
        if (!match) throw launcherError('NOT_FOUND', 'Unknown Launcher operation.', 404);
        const [, id, action] = match;
        if (!action && request.method === 'GET') result = { instance: await manager.instance(id) };
        else if (action === 'review' && request.method === 'POST') { fields(body, ['nodePath', 'pythonPath', 'isolation']); directory = join(manager.row(id).root, 'instances', id, 'package'); result = await manager.reviewInstance(id, body); }
        else if (['start', 'restart'].includes(action) && request.method === 'POST') { fields(body, ['reviewId', 'accepted'], ['reviewId', 'accepted']); result = await manager.start(id, body.reviewId, body.accepted, action === 'restart'); status = 202; }
        else if (action === 'stop' && request.method === 'POST') { fields(body, []); result = manager.stop(id); status = 202; }
        else if (action === 'export' && request.method === 'POST') { fields(body, ['destination'], ['destination']); result = manager.export(id, body.destination); status = 202; }
        else if (action === 'storage' && request.method === 'GET') result = { storage: await manager.storage(id) };
        else if (action === 'upgrade-history' && request.method === 'GET') result = await manager.upgradeHistory(id);
        else if (action === 'upgrade-plan' && request.method === 'POST') { fields(body, ['candidate', 'statePolicies'], ['candidate', 'statePolicies']); result = await manager.upgradePreview(id, body); }
        else if (action === 'rollback-plan' && request.method === 'POST') { fields(body, ['transactionId'], ['transactionId']); result = await manager.rollbackPreview(id, body); }
        else if (['upgrade', 'rollback-upgrade', 'recover-upgrade'].includes(action) && request.method === 'POST') { fields(body, ['previewId', 'accepted'], ['previewId', 'accepted']); result = await manager.completionExecute(id, action, body); status = 202; }
        else if (action === 'backup' && request.method === 'POST') { fields(body, ['destination', 'accepted'], ['destination', 'accepted']); result = manager.backup(id, body.destination, body.accepted); status = 202; }
        else if (action === 'detach' && request.method === 'POST') { fields(body, ['accepted'], ['accepted']); result = manager.detach(id, body.accepted); status = 202; }
        else if (action === 'reattach' && request.method === 'POST') { fields(body, ['reviewId', 'accepted'], ['reviewId', 'accepted']); result = await manager.reattach(id, body.reviewId, body.accepted); status = 202; }
        else if (action === 'logs' && request.method === 'GET') result = { logs: await manager.logs(id) };
        else if (action === 'topology' && request.method === 'GET') result = { topology: await manager.topology(id, target.searchParams.get('runId') ?? undefined) };
        else throw launcherError('NOT_FOUND', 'Unknown Launcher operation.', 404);
      }
      send(response, status, { ok: true, ...result });
    } catch (error) {
      const reqs = directory ? await requirements(directory) : null;
      send(response, error.status ?? (directory ? 422 : 409), { ok: false, error: { code: error.code ?? (directory ? 'REVIEW_FAILED' : 'LAUNCHER_ERROR'), message: String(error.message).slice(0, 2048),
        ...(error.incompleteDestination ? { incompleteDestination: error.incompleteDestination } : {}) }, diagnostic: diagnose(error),
        ...(reqs ? { requirements: reqs, guidance: ['Choose a matching preinstalled interpreter and dependency version, or explicitly rebuild the package lock as its author; inspect again.'] } : {}) });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 15000; server.keepAliveTimeout = 1000;
  try { await new Promise((yes, no) => { server.once('error', no); server.listen(options.port ?? 0, '127.0.0.1', yes); }); }
  catch (error) { await unlink(ownerPath); throw error; }
  url = `http://127.0.0.1:${server.address().port}/`; manager.url = url;
  return { url, launchUrl: url + '#launch=' + bootstrapCode, token, csrfToken, root: manager.root, manager,
    close: () => closing ??= (async () => {
      try {
        await manager.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        const owner = JSON.parse((await readBounded(ownerPath)).toString('utf8')); if (owner.nonce === ownerNonce) await unlink(ownerPath);
      } catch (error) { closing = null; throw error; }
    })() };
}
