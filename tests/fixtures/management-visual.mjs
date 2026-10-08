// Synthetic visual fixture only. No Hub, mod, external program or disk log runs here.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isValidBridgeId } from '../../src/hub/lib/identity.mjs';
import { validateAnnotation } from '../../src/management/management-state.mjs';

const pageUrl = new URL('../../src/management/console.html', import.meta.url);
const csrfToken = randomBytes(32).toString('base64url');
const startedAt = new Date().toISOString();
const segmentMaxBytes = 64 * 1024;
const bridges = [];
const events = [];
const records = [];
const clients = new Map();
let eventId = 0;
let nextSeq = 1000;
let connectionSerial = 0;
let logBytes = 0;
let capacityBlocked = false;
const counters = { accepted: 0, denied: 0, delivered: 0, dropped: 0, catchUpTruncated: 0 };

// Example themes belong to this fixture, never to the real Hub's topic registry.
const categories = [
  { prefix: 'srv.fabric', label: 'Fabric 游戏服', topic: 'game/world' },
  { prefix: 'srv.paper', label: 'Paper 核心服', topic: 'game/chat' },
  { prefix: 'gw.proxy', label: 'Bungee 网关', topic: 'gateway/route' },
  { prefix: 'svc.ai', label: 'AI 计算程序', topic: 'ai/inference' },
  { prefix: 'bot.matrix', label: 'Matrix 互联桥', topic: 'chat/bridge' },
  { prefix: 'db.sync', label: '跨服同步库', topic: 'sync/storage' },
  { prefix: 'mon.probe', label: '遥测探针', topic: 'metrics/telemetry' },
  { prefix: 'auth.sso', label: '统一鉴权端', topic: 'auth/session' },
];
const sharedOrchestrator = { id: 'prog.cluster-orchestrator', name: '调度程序（多桥注记）' };
const sharedSecurity = { id: 'prog.security-sentry', name: '巡检程序（多桥注记）' };
const sharedAi = { id: 'prog.ai-nexus', name: '推理程序（跨翼注记）' };
const sharedStorage = { id: 'prog.storage-coordinator', name: '存储协调程序（多桥注记）' };

function note(value) {
  events.push({ eventId: ++eventId, at: new Date().toISOString(), ...value });
  if (events.length > 100) events.shift();
}

function connect(bridge) {
  const client = clients.get(bridge.key);
  if (bridge.paused || !client.reconnect) return;
  while (bridge.instances.length < client.instanceCount) {
    const instance = {
      connectionId: `fixture-conn-${++connectionSerial}`,
      bridgeId: bridge.kind === 'credential' ? `${bridge.key}:${connectionSerial}` : bridge.key,
      declaredId: `fixture-client-${client.index}-${connectionSerial}`,
      displayName: bridge.key,
      role: 'fixture',
      since: new Date().toISOString(),
      authenticated: true,
      remoteAddress: '127.0.0.1',
      subscriptions: [`fixture-sub-${connectionSerial}`],
      channels: [{ name: client.topic, publish: true, subscribe: true }],
      published: 0,
      delivered: 0,
    };
    bridge.instances.push(instance);
    note({ kind: 'bridge.join', bridgeId: instance.bridgeId });
  }
}

for (let i = 1; i <= 300; i++) {
  const category = categories[(i - 1) % categories.length];
  const key = `${category.prefix}.${String(i).padStart(3, '0')}`;
  const programs = [];
  if (i % 12 === 1) programs.push(sharedOrchestrator);
  if (i % 16 === 2) programs.push(sharedSecurity);
  if (i === 1 || i === 151) programs.push(sharedAi);
  if (i % 20 === 5) programs.push(sharedStorage);
  if (i % 4 !== 0) programs.push({ id: `prog.worker.${i}`, name: `${category.label} #${i} 程序` });
  const bridge = {
    key, label: `${category.label} #${i}`, paused: i % 13 === 0,
    manageable: true, kind: i % 17 === 0 ? 'credential' : 'bridge',
    programs, instances: [], allow: { publish: [category.topic], subscribe: [category.topic] },
  };
  bridges.push(bridge);
  clients.set(key, { index: i, topic: category.topic, reconnect: i % 19 !== 0, instanceCount: bridge.kind === 'credential' ? 2 : 1 });
  connect(bridge);
}

function simulateTraffic(bridge) {
  if (bridge.paused || !bridge.instances.length || capacityBlocked) return;
  const source = bridge.instances[0];
  const body = { fixture: 'synthetic-visual-data', index: nextSeq, text: '模拟信息，不来自真实程序或 mod' };
  const record = {
    seq: nextSeq, at: new Date().toISOString(), kind: 'message',
    topic: clients.get(bridge.key).topic, from: source.bridgeId,
    bytes: Buffer.byteLength(JSON.stringify(body)), body,
  };
  const storedBytes = Buffer.byteLength(JSON.stringify(record) + '\n');
  if (logBytes + storedBytes > segmentMaxBytes) { capacityBlocked = true; return; }
  records.push(record);
  logBytes += storedBytes;
  nextSeq++;
  source.published++;
  counters.accepted++;
  const { body: _body, ...metadata } = record;
  note(metadata);
  // Deliver to a live simulated subscriber with matching declared topic.
  const receiver = bridges.find(candidate => !candidate.paused && candidate.instances.length
    && clients.get(candidate.key).topic === record.topic && candidate.key !== bridge.key);
  if (receiver) {
    const target = receiver.instances[0];
    target.delivered++;
    counters.delivered++;
    note({ kind: 'delivery', seq: record.seq, from: record.from, to: target.bridgeId,
      topic: record.topic, bytes: record.bytes, sent: true, subscription: target.subscriptions[0] });
  }
}

for (const bridge of bridges.filter(bridge => bridge.instances.length).slice(0, 50)) simulateTraffic(bridge);
const programCount = new Set(bridges.flatMap(bridge => bridge.programs.map(program => program.id))).size;

function snapshot() {
  const instances = bridges.flatMap(bridge => bridge.instances);
  const recent = events.slice(-100);
  const lastSeq = records.at(-1)?.seq ?? 0;
  return {
    fixture: { synthetic: true, purpose: 'visual-only', bridgeCount: bridges.length,
      programCount: new Set(bridges.flatMap(bridge => bridge.programs.map(program => program.id))).size },
    csrfToken,
    hub: {
      hubId: '模拟视觉夹具（非真实 Hub）', wireVersion: '0.1', startedAt, now: new Date().toISOString(),
      lastSeq, logEnabled: true, logDir: '模拟内存留存（不写磁盘）', counters,
      bridges: instances.map(({ connectionId: _connectionId, ...instance }) => instance),
      connections: instances.map(({ connectionId, bridgeId, remoteAddress, since }) => ({ connectionId, bridgeId, remoteAddress, since })),
      subscriptions: instances.map(instance => ({ id: instance.subscriptions[0], bridgeId: instance.bridgeId,
        filters: instance.channels.map(channel => channel.name), cursor: 0, sentUpTo: lastSeq,
        pending: 0, queued: 0, catchUp: false })),
      recent,
    },
    bridges, events: recent,
    log: {
      lastSeq, oldestSeq: records[0]?.seq ?? null, retainedCount: records.length,
      protectedCount: records.length, releasedCount: 0, segmentCount: records.length ? 1 : 0,
      bytes: logBytes, oldestProtected: records.length > 0, nextRotationBlocked: records.length > 0,
      enabled: true, maintenanceError: null, capacity: { segmentMaxBytes, segmentMaxCount: 1 },
      records: records.slice(-200).map(({ body: _body, ...record }) => record),
    },
  };
}

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
    throw failure(415, 'CONTENT_TYPE_REJECTED', '管理操作需要 application/json');
  let length = 0;
  const chunks = [];
  await new Promise((resolve, reject) => {
    let done = false;
    const settle = error => {
      if (done) return;
      done = true;
      if (error) { reject(error); req.resume(); } else resolve();
    };
    req.on('data', chunk => {
      if (done) return;
      length += chunk.length;
      if (length > 16 * 1024) { settle(failure(413, 'MANAGEMENT_BODY_TOO_LARGE', '管理请求过大')); return; }
      chunks.push(chunk);
    });
    req.once('end', () => settle());
    req.once('error', settle);
    req.once('aborted', () => settle(failure(400, 'MANAGEMENT_BODY_INVALID', '管理请求已中断')));
  });
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw failure(400, 'MANAGEMENT_BODY_INVALID', '需要 JSON 对象'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, 'MANAGEMENT_BODY_INVALID', '需要 JSON 对象');
  return value;
}

const banner = `<div role="note" style="position:fixed;left:12px;bottom:10px;z-index:400;max-width:calc(100vw - 24px);padding:8px 12px;border:1px solid #e4a741;background:#241d10;color:#ffd78a;font:12px sans-serif;pointer-events:none">模拟视觉夹具 · ${bridges.length} 座桥 / ${programCount} 个程序注记 · 连接、信息流、留存及管理操作均为模拟，不能作为真实枢纽验收证据</div>`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = new URL(`http://${req.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
      || (host.port || '80') !== String(req.socket.localPort)) throw failure(403, 'HOST_REJECTED', '仅接受本机管理地址');
    if ((req.headers.origin && req.headers.origin !== host.origin) || req.headers['sec-fetch-site'] === 'cross-site')
      throw failure(403, 'ORIGIN_REJECTED', '管理请求必须来自当前界面');
    if (req.method === 'POST' && req.headers['x-management-token'] !== csrfToken)
      throw failure(403, 'MANAGEMENT_TOKEN_REQUIRED', '需要当前界面的操作令牌');
    if (req.method === 'GET' && ['/manage', '/manage/', '/manage/index.html'].includes(url.pathname)) {
      const html = (await readFile(pageUrl, 'utf8')).replace('<title>', '<title>模拟视觉夹具 · ').replace(/<body\b[^>]*>/, match => match + banner);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname === '/manage/api/state') { json(res, 200, snapshot()); return; }
    if (req.method === 'GET' && url.pathname === '/manage/api/message') {
      const seq = Number(url.searchParams.get('seq'));
      if (!Number.isSafeInteger(seq) || seq < 1) throw failure(400, 'SEQUENCE_INVALID', '需要有效通讯序号');
      const record = records.find(record => record.seq === seq);
      if (!record) throw failure(404, 'MESSAGE_NOT_RETAINED', '消息不在当前模拟保留范围');
      json(res, 200, { record }); return;
    }
    if (req.method === 'POST' && url.pathname === '/manage/api/bridge') {
      const value = await readBody(req);
      const bridge = isValidBridgeId(value.key) && bridges.find(bridge => bridge.key === value.key);
      if (!bridge || !bridge.manageable) throw failure(404, 'MANAGEMENT_TARGET_UNKNOWN', '通讯主体不存在');
      if (!['pause', 'resume', 'disconnect'].includes(value.action)) throw failure(400, 'MANAGEMENT_ACTION_INVALID', '不支持此通讯管理操作');
      let disconnected = 0;
      if (value.action === 'disconnect') {
        if (!Array.isArray(value.connectionIds) || !value.connectionIds.length || value.connectionIds.length > 256
          || value.connectionIds.some(id => typeof id !== 'string' || id.length > 80))
          throw failure(400, 'MANAGEMENT_CONNECTIONS_REQUIRED', '断开操作需要当前连接标识');
        const before = bridge.instances.length;
        bridge.instances = bridge.instances.filter(instance => !value.connectionIds.includes(instance.connectionId));
        disconnected = before - bridge.instances.length;
      } else {
        bridge.paused = value.action === 'pause';
        if (bridge.paused) bridge.instances = [];
      }
      note({ kind: `management.${value.action}`, principal: value.key });
      json(res, 200, { ok: true, key: value.key, action: value.action, disconnected }); return;
    }
    if (req.method === 'POST' && url.pathname === '/manage/api/annotation') {
      const value = await readBody(req);
      if (!isValidBridgeId(value.key)) throw failure(400, 'MANAGEMENT_TARGET_INVALID', '需要合法通讯主体名称');
      const annotation = validateAnnotation(value);
      let bridge = bridges.find(bridge => bridge.key === value.key);
      if (!bridge) {
        bridge = { key: value.key, label: value.key, kind: 'observed', paused: false, manageable: false, programs: [], instances: [], allow: { publish: [], subscribe: [] } };
        bridges.push(bridge);
      }
      bridge.label = annotation.bridgeName || bridge.instances[0]?.displayName || bridge.key;
      bridge.programs = annotation.programs;
      note({ kind: 'management.annotation', principal: value.key });
      json(res, 200, { ok: true }); return;
    }
    if (!['GET', 'POST'].includes(req.method)) throw failure(405, 'METHOD_NOT_ALLOWED', '管理接口不支持此方法');
    throw failure(404, 'MANAGEMENT_ROUTE_UNKNOWN', '管理接口不存在');
  } catch (error) {
    if (res.destroyed) return;
    json(res, error.status ?? (error.code === 'ANNOTATION_INVALID' ? 400 : 500), { error: { code: error.code ?? 'MANAGEMENT_FAILED', message: error.message } });
  }
});

const interval = setInterval(() => {
  // A synthetic client retry, not a resume operation starting a program.
  for (const bridge of bridges) if (clients.has(bridge.key)) connect(bridge);
  const live = bridges.filter(bridge => !bridge.paused && bridge.instances.length);
  if (live.length) simulateTraffic(live[Math.floor(Math.random() * live.length)]);
}, 2000);

const desiredPort = process.env.PORT === undefined ? 52100 : Number(process.env.PORT);
if (!Number.isInteger(desiredPort) || desiredPort < 0 || desiredPort > 65535) throw new Error('PORT must be an integer from 0 to 65535');
function ready() {
  const port = server.address().port;
  console.log(JSON.stringify({ event: 'ready', fixture: 'synthetic-visual-only', bridgeCount: bridges.length, programCount, port, url: `http://127.0.0.1:${port}/manage` }));
}
server.once('error', error => {
  if (error.code === 'EADDRINUSE') server.listen(0, '127.0.0.1');
  else throw error;
});
server.once('listening', ready);
server.listen(desiredPort, '127.0.0.1');
function shutdown() { clearInterval(interval); server.close(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
