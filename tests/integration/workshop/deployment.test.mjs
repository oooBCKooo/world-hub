import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createGatewayPatch, createWindowsTaskScript } from '../../../scripts/deploy/workshop-deployment.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const calls = [];
let backend, gateway, source, options, patch;
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => !server?.listening ? Promise.resolve() : new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
function send(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: gateway.address().port, path, method, headers: { host: 'example.test', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Test request timed out'))); req.on('error', reject); req.end(body);
  });
}
before(async () => {
  backend = createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const seen = { url: req.url, headers: req.headers, sha256: hash(Buffer.concat(chunks)) }; calls.push(seen);
      res.writeHead(201, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(seen));
    });
  });
  await listen(backend);
  source = Buffer.from("const http=require('node:http');\nfunction routeRequest(req, res, defaultProto) {\n  const url=new URL(req.url,'https://example.test');\n  // 0. WeChat security verification file\n  res.end('old:'+url.pathname);\n}\nmodule.exports={routeRequest};\n");
  options = { expectedSha256: hash(source), port: backend.address().port, publicBaseUrl: 'https://example.test/workshop/' };
  patch = createGatewayPatch(source, options);
  const context = { require: createRequire(import.meta.url), URL, module: { exports: {} }, console };
  vm.runInNewContext(patch.bytes.toString(), context);
  gateway = createServer((req, res) => context.module.exports.routeRequest(req, res, req.headers['test-protocol'] || 'https'));
  await listen(gateway);
});
after(async () => { await close(gateway); await close(backend); });

test('gateway forwards only the exact Workshop namespace and preserves path/query', async () => {
  for (const path of ['/workshop', '/workshop/', '/workshop/api/catalog?limit=2']) {
    const response = await send(path); assert.equal(response.status, 201); assert.equal(JSON.parse(response.body).url, path);
  }
});

test('gateway keeps neighboring namespaces and existing routes unchanged', async () => {
  for (const path of ['/workshop-suffix', '/api/health', '/exams/']) assert.equal((await send(path)).body, 'old:' + path);
});

test('gateway denies private static files and encoded Windows filesystem aliases', async () => {
  const paths = [];
  for (const prefix of ['', '/exams', '/practice']) {
    for (const name of ['server.js', 'daemon.bat', 'domain.pfx', 'default.pfx', 'settings.pem', 'secret.key', 'node.exe', 'deploy.ps1', 'stdout.log', 'server-data/users.json', '.git/config', '.env', '.env.production']) paths.push(prefix + '/' + name);
  }
  paths.push('/%73erver%2ejs', '/EXAMS/SeRvEr.Js', '/exams/%2fserver.js', '/practice/%5cdaemon.bat', '/%252eenv', '/exams/%73erver.js::$DATA', '/server.js.%20', '/exams/a/../server.js', '/exams/%2e%2e/domain.pfx', '/exams/server-data.%20/users.json', '/exams/.git%2e/config', '/exams/%255cserver.js');
  assert.equal(paths.length, 51);
  for (const path of paths) {
    const response = await send(path); assert.equal(response.status, 404, path); assert.equal(response.body, 'Not found', path); assert.equal(response.headers['cache-control'], 'no-store', path);
  }
});

test('gateway keeps legitimate frontend files and existing application APIs reachable', async () => {
  for (const path of ['/exams/app.js', '/practice/style.css', '/exams/data/banks.js', '/exams/assets/img/diagram.png', '/exams/api/me', '/api/tavern/health', '/vendor/server.js']) assert.equal((await send(path)).body, 'old:' + path, path);
});

test('HTTP redirects use the configured HTTPS host and writes never forward credentials', async () => {
  const before = calls.length;
  const redirect = await send('/workshop/?a=1', { headers: { 'test-protocol': 'http', host: 'attacker.invalid' } });
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, 'https://example.test/workshop/?a=1');
  const refused = await send('/workshop/api/login', { method: 'POST', headers: { 'test-protocol': 'http' }, body: 'fake-test-credential' });
  assert.equal(refused.status, 426); assert.equal(calls.length, before);
});

test('gateway streams the exact body and owns forwarding headers independently of clients', async () => {
  const body = Buffer.alloc(32768, 0x41);
  const response = await send('/workshop/api/upload', { method: 'POST', headers: { 'content-length': body.length, 'content-type': 'application/octet-stream', 'x-forwarded-for': 'spoofed', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'http', forwarded: 'for=spoofed', connection: 'x-removed', 'x-removed': 'fake-test-value' }, body });
  assert.equal(response.status, 201);
  const seen = JSON.parse(response.body);
  assert.equal(seen.sha256, hash(body)); assert.equal(seen.headers['x-forwarded-proto'], 'https'); assert.equal(seen.headers['x-forwarded-host'], 'example.test'); assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1'); assert.equal(seen.headers.forwarded, undefined); assert.equal(seen.headers['x-removed'], undefined); assert.equal(seen.headers.host, 'example.test');
});

test('gateway backend failure produces a bounded response without revealing diagnostics', async () => {
  await close(backend);
  const response = await send('/workshop/health'); assert.equal(response.status, 502); assert.deepEqual(JSON.parse(response.body), { error: 'WORKSHOP_UNAVAILABLE' });
});

test('deployment preparation requires exact source hashes, supports idempotency and isolates its task', () => {
  assert.equal(patch.changed, true);
  const unchanged = createGatewayPatch(patch.bytes, { ...options, expectedSha256: patch.afterSha256 }); assert.equal(unchanged.changed, false); assert.deepEqual(unchanged.bytes, patch.bytes);
  assert.throws(() => createGatewayPatch(source, { ...options, expectedSha256: '0'.repeat(64) }), /changed/);
  assert.throws(() => createGatewayPatch(source, { ...options, publicBaseUrl: 'http://example.test/workshop/' }), /HTTPS/);
  assert.throws(() => createGatewayPatch(Buffer.from(source.toString().replace('  // 0.', '  // different 0.')), { ...options, expectedSha256: hash(Buffer.from(source.toString().replace('  // 0.', '  // different 0.'))) }), /layout changed/);
  const task = createWindowsTaskScript({ deploymentRoot: 'C:\\workshop-example', nodeExecutable: 'C:\\tools\\node.exe', entry: 'tools/workshop/cli.mjs' });
  assert.match(task, /LOCAL SERVICE/); assert.match(task, /--max-old-space-size=128/); assert.match(task, /started = \$false/);
  assert.doesNotMatch(task, /Start-ScheduledTask|Stop-Process|IIS|w3svc/);
});
