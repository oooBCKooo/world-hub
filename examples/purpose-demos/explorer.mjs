// An ordinary external application with its own mod, never a Hub business API.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { getProfile, principalFor, bridgeFor } from './profiles.mjs';

const assets = fileURLToPath(new URL('./', import.meta.url));
const MIME = { '/': ['explorer.html', 'text/html; charset=utf-8'],
  '/explorer.css': ['explorer.css', 'text/css; charset=utf-8'], '/explorer.js': ['explorer.js', 'text/javascript; charset=utf-8'] };
const fault = (status, message) => Object.assign(new Error(message), { status });
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startExplorer(settings) {
  const profile = getProfile(settings.profile);
  const events = [], results = [], failures = []; const seen = new Set();
  const operationToken = randomBytes(24).toString('hex');
  let active = false, closing = null, accepted = 0;
  const bridge = new Bridge({ url: settings.endpoint, bridgeId: bridgeFor(profile.id, 'explorer', 'web'),
    credential: principalFor(profile.id, 'explorer'), token: settings.credential, displayName: '用途探索界面' });
  const keep = (list, value, max = 120) => { list.push(value); if (list.length > max) list.shift(); };
  bridge.on('delivery', frame => {
    // A call's temporary subscription and the observation subscription may both
    // deliver a response. Display one envelope while the SDK ACKs each delivery.
    if (seen.has(frame.seq)) return;
    seen.add(frame.seq); if (seen.size > 600) seen.delete(seen.values().next().value);
    keep(events, { ...frame, receivedAt: new Date().toISOString() });
  });
  bridge.on('error', error => keep(failures, { at: new Date().toISOString(), code: error.code, message: error.message }, 12));
  try {
    await bridge.connect();
    await bridge.registerChannels([{ name: `demo/${profile.id}/explorer`, publish: true, subscribe: true }]);
    await bridge.subscribe(profile.observeFilters ?? [`demo/${profile.id}/#`], { from: 0 });
  } catch (error) { bridge.close(); throw error; }
  const data = () => ({ profile, startedAt: started, endpoint: settings.endpoint, managementUrl: settings.managementUrl,
    peers: settings.peers, explorer: { principal: bridge.welcome?.principal, bridge: bridge.bridgeId, connected: bridge.connected },
    events: [...events], results: [...results], failures: [...failures] });
  const started = new Date().toISOString();
  const persist = () => writeFile(join(settings.stateDirectory, 'explorer-results.json'), JSON.stringify(data(), null, 2) + '\n');
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  const json = (res, status, value, extra = {}) => { res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(value)); };
  let origin;
  function sameSite(req) {
    if (`http://${req.headers.host}` !== origin) throw fault(403, '只允许当前本机演示地址');
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fault(403, '跨站操作被拒绝');
  }
  async function readBody(req) {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw fault(415, '需要 JSON 请求');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw fault(413, '演示操作最多 32 KiB'); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
    catch { throw fault(400, '无效的 JSON 对象'); }
  }
  const server = createServer(async (req, res) => {
    try {
      sameSite(req);
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && MIME[path]) {
        const [file, type] = MIME[path]; const body = await readFile(join(assets, file));
        res.writeHead(200, { ...headers, 'content-type': type }); res.end(body); return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        let status = null, statusError = null;
        try {
          const response = await fetch(new URL('/status', settings.managementUrl), { signal: AbortSignal.timeout(2000) });
          if (!response.ok) throw new Error(`Hub status ${response.status}`); status = await response.json();
        } catch (error) { statusError = error.message; }
        json(res, 200, { ...data(), operationToken, hubStatus: status, hubStatusError: statusError, active }); return;
      }
      if (req.method === 'GET' && path === '/api/export') {
        json(res, 200, data(), { 'content-disposition': `attachment; filename="${profile.id}-results.json"` }); return;
      }
      if (req.method === 'POST' && path === '/api/action') {
        if (!safeEqual(operationToken, req.headers['x-demo-token'])) throw fault(403, '需要当前探索界面的操作令牌');
        const value = await readBody(req);
        const action = profile.actions.find(item => item.id === value.id);
        if (!action) throw fault(400, '该操作不属于当前演示场景');
        if (active) throw fault(409, '请等待当前多程序操作完成');
        active = true;
        const body = value.body === undefined ? action.body : value.body;
        const begun = new Date().toISOString();
        try {
          let receipt, response = null;
          // A declared bridge label describes the example's wiring. The wire
          // contract routes by principal, optional session and topic filters.
          const target = { principal: action.target.principal,
            ...(action.target.session ? { session: action.target.session } : {}) };
          if (action.operation === 'request') {
            const call = await bridge.call(target, action.topic, body, { timeoutMs: 25000 });
            receipt = call.request; response = call.response;
          } else if (action.operation === 'inject') receipt = await bridge.sendTo(target, action.topic, body);
          else throw fault(400, '未知的演示操作');
          const result = { index: ++accepted, action: action.id, label: action.label, startedAt: begun,
            finishedAt: new Date().toISOString(), target, topic: action.topic, operation: action.operation,
            body, receipt, response, note: response ? '来自目标程序的回应；业务结果由目标程序解释' : '枢纽已接纳注入；执行效果请观察目标程序发布的信息' };
          keep(results, result, 30); await persist(); json(res, 200, { ok: true, result });
        } catch (error) {
          keep(failures, { at: new Date().toISOString(), action: action.id, message: error.message }, 12);
          await persist(); throw error;
        } finally { active = false; }
        return;
      }
      json(res, 404, { error: '没有这个演示入口' });
    } catch (error) { if (!res.headersSent) json(res, error.status ?? 502, { ok: false, error: error.message }); else res.end(); }
  });
  // Loopback and an OS-selected port keep simultaneous packages independent.
  try { await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); }); }
  catch (error) { bridge.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => closing ??= (async () => {
    bridge.close(); server.closeIdleConnections();
    await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
    await persist();
  })();
  return { ready: { event: 'ready', pid: process.pid, profile: profile.id, url: `${origin}/`,
    principal: bridge.welcome.principal, bridge: bridge.bridgeId }, close, bridge };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app; let pending; let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { app ??= await pending; await app?.close(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { if (process.connected) process.disconnect(); }
  };
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
  if (process.send) {
    process.on('message', message => { if (message?.type === 'stop') void stop(); }); process.on('disconnect', () => void stop());
  }
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--settings') throw new Error('用法：explorer.mjs --settings SESSION_SETTINGS');
    const settings = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
    pending = startExplorer(settings); app = await pending;
    if (!stopping) { console.log(JSON.stringify(app.ready)); if (process.send) process.send(app.ready); }
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; if (app) await app.close(); if (process.connected) process.disconnect(); }
}
