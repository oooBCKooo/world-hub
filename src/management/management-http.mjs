import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isValidBridgeId } from '../hub/lib/acl.mjs';
import { safeEqual } from '../hub/lib/store.mjs';
import { stringifyEnvelope } from '../hub/lib/wire-json.mjs';
import { ManagementState, validateAnnotation } from './management-state.mjs';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const principalOf = bridge => bridge.bridgeId.includes(':') ? bridge.bridgeId.split(':')[0] : bridge.bridgeId;

export async function createManagementHttp(hub, config) {
  const state = await ManagementState.open(config.management.stateFile, config.management.annotations);
  hub.setPausedPrincipals(state.value.paused);
  const csrfToken = randomBytes(32).toString('base64url');
  // Validate the bundled page at startup; request-time reads can fail independently.
  await readFile(new URL('./console.html', import.meta.url), 'utf8');
  function known(key) {
    return Object.hasOwn(config.acl.bridges, key) || Object.hasOwn(config.acl.credentials, key)
      || state.value.paused.includes(key) || hub.snapshot().bridges.some(bridge => principalOf(bridge) === key);
  }
  function snapshot() {
    const live = hub.snapshot(); const settings = state.value;
    const keys = new Set([...Object.keys(config.acl.bridges), ...Object.keys(config.acl.credentials),
      ...Object.keys(settings.annotations), ...settings.paused, ...live.bridges.map(principalOf)]);
    const manageableKeys = new Set([...Object.keys(config.acl.bridges), ...Object.keys(config.acl.credentials),
      ...settings.paused, ...live.bridges.map(principalOf)]);
    const bridges = [...keys].sort().map(key => {
      const instances = live.bridges.filter(bridge => principalOf(bridge) === key).map(bridge => ({ ...bridge,
        connectionId: live.connections.find(connection => connection.bridgeId === bridge.bridgeId)?.connectionId }));
      const entry = config.acl.bridges[key] ?? config.acl.credentials[key];
      const annotation = settings.annotations[key];
      return { key, kind: Object.hasOwn(config.acl.credentials, key) ? 'credential' : Object.hasOwn(config.acl.bridges, key) ? 'bridge' : 'observed',
        paused: settings.paused.includes(key), manageable: manageableKeys.has(key),
        label: annotation?.bridgeName || instances[0]?.displayName || key,
        programs: annotation?.programs ?? [], instances,
        allow: entry?.allow ?? { publish: config.acl.allowUnlistedBridges ? ['#'] : [], subscribe: config.acl.allowUnlistedBridges ? ['#'] : [] } };
    });
    return { csrfToken, transport: { path: config.transport.path }, hub: live, bridges, events: live.recent, blobs: live.storage.blobs,
      log: { ...live.storage.log, records: hub.log.tail(200).map(record => {
        const metadata = {};
        for (const key of ['seq', 'at', 'kind', 'topic', 'from', 'bytes', 'id', 'correlation', 'replyTo', 'subscriptionId', 'to', 'reason']) {
          if (record[key] !== undefined) metadata[key] = record[key];
        }
        return metadata;
      }) } };
  }
  function access(req) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw fail(403, 'MANAGEMENT_LOCAL_ONLY', '管理界面仅允许本机回环访问');
    const expectedPort = String(req.socket.localPort);
    let host;
    try { host = new URL(`http://${req.headers.host}`); } catch { throw fail(403, 'HOST_REJECTED', '管理地址无效'); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || (host.port || '80') !== expectedPort
      || host.username || host.password || host.pathname !== '/') throw fail(403, 'HOST_REJECTED', '管理服务仅接受本机地址');
    if (req.headers.origin && req.headers.origin !== host.origin) throw fail(403, 'ORIGIN_REJECTED', '管理请求必须来自当前界面');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'ORIGIN_REJECTED', '跨站管理请求被拒绝');
    if (req.method === 'POST' && !safeEqual(csrfToken, req.headers['x-management-token'] ?? '')) throw fail(403, 'MANAGEMENT_TOKEN_REQUIRED', '需要当前管理界面的操作令牌');
  }
  async function body(req) {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw fail(415, 'CONTENT_TYPE_REJECTED', '管理操作需要application/json');
    let length = 0; const chunks = [];
    await new Promise((resolveRead, rejectRead) => {
      let done = false;
      const settle = error => { if (done) return; done = true; if (error) { rejectRead(error); req.resume(); } else resolveRead(); };
      req.on('data', chunk => {
        if (done) return;
        length += chunk.length;
        if (length > 16 * 1024) { settle(fail(413, 'MANAGEMENT_BODY_TOO_LARGE', '管理请求过大')); return; }
        chunks.push(chunk);
      });
      req.once('end', () => settle()); req.once('error', settle);
      req.once('aborted', () => settle(fail(400, 'MANAGEMENT_BODY_INVALID', '管理请求已中断')));
    });
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw fail(400, 'MANAGEMENT_BODY_INVALID', '需要JSON对象'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'MANAGEMENT_BODY_INVALID', '需要JSON对象');
    return value;
  }
  return { state, snapshot, async handle(req, res, url) {
    if (!(url.pathname === '/manage' || url.pathname.startsWith('/manage/') || url.pathname === '/ui/language.mjs')) return false;
    try {
      access(req);
      const asset = {
        '/ui/language.mjs': ['../ui/language.mjs', 'text/javascript; charset=utf-8'],
        '/manage/canvas-i18n.mjs': ['./canvas-i18n.mjs', 'text/javascript; charset=utf-8'],
        '/manage/manual-i18n.mjs': ['./manual-i18n.mjs', 'text/javascript; charset=utf-8'],
        '/manage/manual-bridge.mjs': ['./manual-bridge.mjs', 'text/javascript; charset=utf-8'],
        '/manage/manual-console.mjs': ['./manual-console.mjs', 'text/javascript; charset=utf-8'],
        '/manage/manual-experience-state.mjs': ['./manual-experience-state.mjs', 'text/javascript; charset=utf-8'],
        '/manage/manual-console.css': ['./manual-console.css', 'text/css; charset=utf-8'],
      }[url.pathname];
      if (req.method === 'GET' && asset) {
        const content = await readFile(new URL('./' + asset[0], import.meta.url), 'utf8');
        res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(content); return true;
      }
      if (req.method === 'GET' && ['/manage', '/manage/', '/manage/index.html'].includes(url.pathname)) {
        // Finish fallible file I/O before committing a successful response header.
        const latestPage = await readFile(new URL('./console.html', import.meta.url), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${req.headers.host}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` });
        res.end(latestPage); return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/state') { json(res, 200, snapshot()); return true; }
      if (req.method === 'GET' && url.pathname === '/manage/api/message') {
        const seq = Number(url.searchParams.get('seq'));
        if (!Number.isSafeInteger(seq) || seq < 1) throw fail(400, 'SEQUENCE_INVALID', '需要有效通讯序号');
        const record = hub.log.get(seq);
        if (!record) throw fail(404, 'MESSAGE_NOT_RETAINED', '消息不在当前保留范围');
        // Keep the raw body text. Internal retention ownership is not exported.
        const { owner, ...envelope } = record;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end('{"record":' + stringifyEnvelope(envelope, record.bodyRaw) + '}'); return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/bridge') {
        const value = await body(req);
        if (!isValidBridgeId(value.key) || !known(value.key)) throw fail(404, 'MANAGEMENT_TARGET_UNKNOWN', '通讯主体不存在');
        if (!['pause', 'resume', 'disconnect'].includes(value.action)) throw fail(400, 'MANAGEMENT_ACTION_INVALID', '不支持此通讯管理操作');
        let disconnected = 0;
        if (value.action === 'disconnect') {
          if (!Array.isArray(value.connectionIds) || !value.connectionIds.length || value.connectionIds.length > 256
            || value.connectionIds.some(id => typeof id !== 'string' || id.length > 80)) throw fail(400, 'MANAGEMENT_CONNECTIONS_REQUIRED', '断开操作需要当前连接标识');
          disconnected = hub.disconnectConnections(value.key, value.connectionIds);
        }
        else await state.update(next => {
          const paused = new Set(next.paused);
          if (value.action === 'pause') paused.add(value.key); else paused.delete(value.key);
          next.paused = [...paused].sort();
        }, next => hub.setPausedPrincipals(next.paused));
        hub.managementNote({ kind: `management.${value.action}`, principal: value.key });
        json(res, 200, { ok: true, key: value.key, action: value.action, disconnected }); return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/annotation') {
        const value = await body(req);
        if (!isValidBridgeId(value.key)) throw fail(400, 'MANAGEMENT_TARGET_INVALID', '需要合法通讯主体名称');
        const annotation = validateAnnotation(value);
        await state.update(next => { next.annotations[value.key] = annotation; });
        hub.managementNote({ kind: 'management.annotation', principal: value.key });
        json(res, 200, { ok: true }); return true;
      }
      if (!['GET', 'POST'].includes(req.method)) throw fail(405, 'METHOD_NOT_ALLOWED', '管理接口不支持此方法');
      throw fail(404, 'MANAGEMENT_ROUTE_UNKNOWN', '管理接口不存在');
    } catch (error) {
      json(res, error.status ?? (error.code === 'ANNOTATION_INVALID' ? 400 : 500), { error: { code: error.code ?? 'MANAGEMENT_FAILED', message: error.message } });
      return true;
    }
  } };
}
