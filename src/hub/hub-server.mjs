#!/usr/bin/env node
// 枢纽进程入口。
//
// 用法：
//   node src/hub/hub-server.mjs --config <hub.config.json>
//   node src/hub/hub-server.mjs --config x.json --port 8790
//   node src/hub/hub-server.mjs --print-token <bridgeId>
//
// 它是一个普通进程：不在任何外部程序的进程里，也不加载任何外部程序的代码。
// 见《定位与边界》的不执行外部代码与无业务时钟约束。

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig, mintToken, normalizeConfig } from './lib/store.mjs';
import { Hub, WIRE_VERSION } from './lib/hub.mjs';
import { attachWebSocketServer, CLOSE } from './ws-server.mjs';
import { debugPageHtml } from '../debug/page.mjs';
import { stringifyEnvelope } from './lib/wire-json.mjs';
import { createManagementHttp } from '../management/management-http.mjs';

function parseArgs(argv) {
  const args = { config: null, port: null, host: null, logDir: null, quiet: false, printToken: null, help: false };
  const aliases = new Set(['-c', '-p', '-q', '-h']);
  const valueAt = (index, option) => {
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || aliases.has(value)) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') { args.config = valueAt(i, a); i++; }
    else if (a === '--port' || a === '-p') {
      const port = Number(valueAt(i, a)); i++;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${a} requires an integer from 0 to 65535`);
      args.port = port;
    }
    else if (a === '--host') { args.host = valueAt(i, a); i++; }
    else if (a === '--log-dir') { args.logDir = valueAt(i, a); i++; }
    else if (a === '--quiet' || a === '-q') args.quiet = true;
    else if (a === '--print-token') { args.printToken = valueAt(i, a); i++; }
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const HELP = `
枢纽进程（world hub）

  --config, -c <path>     接线配置（JSON）。不传则用默认值：不预置任何桥，所有连接被拒。
  --port,   -p <n>        覆盖配置里的监听端口
  --host <addr>           覆盖配置里的监听地址（默认 127.0.0.1）
  --log-dir <path>        覆盖流水账目录（测试用隔离目录）
  --quiet,  -q            只输出机器可读的 ready 行
  --print-token <bridge>  生成一座桥的凭据片段并退出（不启动枢纽）
  --help,   -h            显示本帮助

调试入口（只读，不出现在线协议里）：
  GET /            接线图 + 实时流水（人看）
  GET /status      只读快照 JSON（机器看）
  GET /log?limit=  流水账尾部 JSON

本机管理入口：
  GET /manage     程序注记、桥、枢纽与信息流；管理桥接入的暂停/恢复/断连
`;

function log(quiet, obj) {
  if (quiet && obj.event !== 'ready') return;
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(String(err.message) + '\n' + HELP);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.printToken) {
    process.stdout.write(
      JSON.stringify(
        {
          bridgeId: args.printToken,
          token: mintToken(),
          configSnippet: {
            acl: {
              bridges: {
                [args.printToken]: {
                  token: '<the token above>',
                  allow: { publish: ['#'], subscribe: ['#'] },
                },
              },
            },
          },
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const configPath = args.config ? resolve(args.config) : null;
  if (configPath && !existsSync(configPath)) {
    process.stderr.write(`config not found: ${configPath}\n`);
    process.exit(2);
  }
  const config = configPath ? loadConfig(configPath) : normalizeConfig({}, null);
  if (args.port !== null && Number.isInteger(args.port)) config.transport.port = args.port;
  if (args.host) config.transport.host = args.host;
  if (args.logDir) {
    config.log.dir = resolve(args.logDir);
    if (!config.management.explicitStateFile) config.management.stateFile = join(config.log.dir, 'management.json');
    if (!config.blobs.explicitDir) config.blobs.dir = join(config.log.dir, 'blobs');
  }

  const hub = await Hub.create(config);
  const management = await createManagementHttp(hub, config);

  const httpServer = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'REQUEST_URL_INVALID', message: 'invalid request URL' } }));
      return;
    }
    if (await management.handle(req, res, url)) return;
    const remote = req.socket.remoteAddress;
    // Debug access is strictly local even when the bridge transport listens on a LAN.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('debug access is loopback only\n');
      return;
    }
    if (url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(hub.snapshot(), null, 2));
      return;
    }
    if (url.pathname === '/log') {
      const requested = Number(url.searchParams.get('limit') ?? 100);
      const limit = Number.isFinite(requested) ? Math.min(500, Math.max(1, Math.floor(requested))) : 100;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{"lastSeq":' + hub.log.lastSeq + ',"records":[' + hub.log.tail(limit).map((record) => stringifyEnvelope(record)).join(',') + ']}');
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(debugPageHtml({ hubId: config.hub.id, wireVersion: WIRE_VERSION }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });

  const wss = attachWebSocketServer(httpServer, {
    path: config.transport.path,
    maxPayload: 4 * 1024 * 1024,
  });
  wss.on('connection', (conn) => hub.onConnection(conn));

  await new Promise((resolve_, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.transport.port, config.transport.host, resolve_);
  });
  const addr = httpServer.address();

  log(args.quiet, {
    event: 'ready',
    hub: config.hub.id,
    wireVersion: WIRE_VERSION,
    wireHash: hub.wireHash,
    host: config.transport.host,
    port: addr.port,
    endpoint: `ws://${config.transport.host}:${addr.port}${config.transport.path}`,
    debugUrl: `http://${config.transport.host}:${addr.port}/`,
    managementUrl: `http://${config.transport.host}:${addr.port}/manage`,
    configPath,
    logDir: hub.log.enabled ? hub.log.dir : null,
    logEnabled: hub.log.enabled,
    storage: hub.snapshot().storage,
    registeredBridges: Object.keys(config.acl.bridges),
    allowUnlistedBridges: config.acl.allowUnlistedBridges,
    pid: process.pid,
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(args.quiet, { event: 'stopping', signal });
    wss.closeAll(CLOSE.GOING_AWAY, 'hub shutting down');
    await new Promise((r) => httpServer.close(r));
    await hub.stop();
    log(args.quiet, { event: 'stopped' });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`hub failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
