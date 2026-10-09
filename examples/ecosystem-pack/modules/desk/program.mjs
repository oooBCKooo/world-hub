import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Bridge } from './bridge-kit.mjs';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const textValid = value => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 16384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sourceContract = Object.freeze({ id: 'text.read', version: '1.0.0' });
const statsContract = Object.freeze({ id: 'text.statistics', version: '1.0.0' });
let bridge, server, stopping = false, ready = false, busy = false, active, closeTask;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function stop() {
  if (closeTask) return closeTask;
  stopping = true; ready = false;
  return closeTask = (async () => {
    const closed = server ? new Promise(resolveClose => { server.closeIdleConnections(); server.close(resolveClose); }) : Promise.resolve();
    if (bridge) await bridge.close('module stopped');
    if (active) await active.catch(() => {});
    await closed;
    input.close();
  })();
}
input.on('line', line => {
  if (line.length > 65536) return;
  let request; try { request = JSON.parse(line); } catch { return; }
  if (request.command === 'health' && typeof request.id === 'string' && request.id.length <= 256)
    emit({ event: 'module-health', id: request.id, ready: ready && !stopping });
  if (request.command === 'stop') void stop();
});
input.on('close', () => { if (!stopping) void stop(); });
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());

function verifyExchange(exchange, principal, topic) {
  const { request, response } = exchange ?? {};
  if (!Number.isSafeInteger(request?.seq) || request.seq < 1 || response?.requestSeq !== request.seq
      || response.operation !== 'response' || response.topic !== topic || response.fromPrincipal !== principal
      || !UUID.test(response.senderSession ?? '') || !Number.isSafeInteger(response.seq) || response.seq <= request.seq)
    throw fault('RESPONSE_UNTRUSTED');
  return response.body;
}
function receipt(exchange) {
  return { requestSeq: exchange.request.seq, responseSeq: exchange.response.seq,
    fromPrincipal: exchange.response.fromPrincipal, senderSession: exchange.response.senderSession };
}
function verifySource(body, invocationId) {
  if (!exactKeys(body, ['ok', 'kind', 'contract', 'invocationId', 'provider', 'text', 'revision']) || body.ok !== true
      || body.kind !== 'ecosystem.text-result' || !exactKeys(body.contract, ['id', 'version'])
      || body.contract.id !== sourceContract.id || body.contract.version !== sourceContract.version
      || body.invocationId !== invocationId || typeof body.provider !== 'string' || !body.provider
      || !textValid(body.text) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw fault('SOURCE_RESULT_INVALID');
}
function verifyStatistics(body, invocationId) {
  if (!exactKeys(body, ['ok', 'kind', 'contract', 'invocationId', 'status', 'provider', 'executionId', 'output'])
      || body.ok !== true || body.kind !== 'demo.capability-result' || body.status !== 'completed'
      || !exactKeys(body.contract, ['id', 'version']) || body.contract.id !== statsContract.id || body.contract.version !== statsContract.version
      || body.invocationId !== invocationId || typeof body.provider !== 'string' || !body.provider || !UUID.test(body.executionId ?? '')
      || !exactKeys(body.output, ['codePoints', 'lines', 'utf8Bytes', 'sha256'])
      || !Number.isSafeInteger(body.output.codePoints) || body.output.codePoints < 0 || body.output.codePoints > 16384
      || !Number.isSafeInteger(body.output.lines) || body.output.lines < 1 || body.output.lines > 16385
      || !Number.isSafeInteger(body.output.utf8Bytes) || body.output.utf8Bytes < 0 || body.output.utf8Bytes > 16384
      || !/^[a-f0-9]{64}$/.test(body.output.sha256)) throw fault('STATISTICS_RESULT_INVALID');
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value) + '\n');
}
async function readBody(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw fault('HTTP_BODY_TOO_LARGE'); chunks.push(chunk); }
  let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw fault('HTTP_BODY_INVALID'); }
  if (!object(body) || Object.keys(body).some(key => key !== 'text') || (Object.hasOwn(body, 'text') && !textValid(body.text))) throw fault('INPUT_INVALID');
  return body;
}

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-config') throw fault('CLI_INVALID');
  const config = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
  const connection = config.bridges?.find(item => item.slot === 'main');
  const sourcePrincipal = config.peers?.source?.principal, statsPrincipal = config.peers?.stats?.principal;
  const sourceTopic = config.topics?.source, statsTopic = config.topics?.stats;
  if (config.format !== 'world-hub.run/v1' || !connection || typeof config.stateDir !== 'string'
      || typeof sourcePrincipal !== 'string' || typeof statsPrincipal !== 'string'
      || typeof sourceTopic !== 'string' || typeof statsTopic !== 'string'
      || ![sourceTopic, statsTopic].every(topic => connection.publish.includes(topic) && connection.subscribe.includes(topic))) throw fault('CONFIG_INVALID');
  await mkdir(config.stateDir, { recursive: true });
  const filename = join(config.stateDir, 'results.json');
  let state;
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, results: [] }; }
  if (state?.version !== 1 || !Array.isArray(state.results) || state.results.length > 20) throw fault('STATE_INVALID');
  const save = async next => {
    await writeFile(filename + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(filename + '.tmp', filename); state = next;
  };
  await save(state);
  if (stopping) throw fault('MODULE_STOPPED');
  bridge = new Bridge({ url: connection.endpoint, bridgeId: connection.bridgeId,
    credential: connection.credential, token: connection.token, instanceId: randomUUID(),
    reconnectMs: 250, maxPendingCalls: 4, displayName: 'Cross-language text desk' });
  bridge.on('error', event => emit({ event: 'module-diagnostic', code: typeof event.code === 'string' ? event.code : 'BRIDGE_ERROR' }));
  const welcome = await bridge.connect();
  if (welcome.principal !== connection.principal || welcome.authenticated !== true) throw fault('WELCOME_UNTRUSTED');
  await bridge.registerChannels([sourceTopic, statsTopic].map(name => ({ name, publish: true, subscribe: true })));
  async function analyze(body) {
    const receipts = [];
    if (Object.hasOwn(body, 'text')) {
      const invocationId = randomUUID();
      const exchange = await bridge.call({ principal: sourcePrincipal }, sourceTopic,
        { contract: sourceContract, command: 'set', invocationId, text: body.text }, { timeoutMs: 2000, receiptTimeoutMs: 1000 });
      const result = verifyExchange(exchange, sourcePrincipal, sourceTopic); verifySource(result, invocationId);
      if (result.text !== body.text) throw fault('SOURCE_TEXT_CHANGED');
      receipts.push({ step: 'source-set', ...receipt(exchange) });
    }
    const readId = randomUUID();
    const source = await bridge.call({ principal: sourcePrincipal }, sourceTopic,
      { contract: sourceContract, command: 'read', invocationId: readId }, { timeoutMs: 2000, receiptTimeoutMs: 1000 });
    const original = verifyExchange(source, sourcePrincipal, sourceTopic); verifySource(original, readId);
    receipts.push({ step: 'source-read', ...receipt(source) });
    const statsId = randomUUID();
    const statistics = await bridge.call({ principal: statsPrincipal }, statsTopic,
      { contract: statsContract, invocationId: statsId, text: original.text }, { timeoutMs: 2000, receiptTimeoutMs: 1000 });
    const computed = verifyExchange(statistics, statsPrincipal, statsTopic); verifyStatistics(computed, statsId);
    receipts.push({ step: 'python-statistics', ...receipt(statistics) });
    const result = { id: randomUUID(), completedAt: new Date().toISOString(), text: original.text,
      sourceRevision: original.revision, output: computed.output, provider: computed.provider, executionId: computed.executionId, receipts };
    await save({ version: 1, results: [...state.results, result].slice(-20) });
    return result;
  }
  const html = await readFile(new URL('./index.html', import.meta.url));
  const script = await readFile(new URL('./ui.js', import.meta.url));
  if (stopping) throw fault('MODULE_STOPPED');
  let origin;
  server = createServer((req, res) => { void (async () => {
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.host !== new URL(origin).host) return json(res, 403, { ok: false, error: { code: 'LOOPBACK_REQUIRED' } });
    const path = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
      return res.end(html);
    }
    if (req.method === 'GET' && path === '/ui.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(script);
    }
    if (req.method === 'GET' && path === '/state') return json(res, 200, { ok: true, instanceId: config.instanceId, busy, ...state });
    if (req.method === 'POST' && path === '/analyze') {
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return json(res, 403, { ok: false, error: { code: 'ORIGIN_REJECTED' } });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { ok: false, error: { code: 'ORIGIN_REJECTED' } });
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(res, 415, { ok: false, error: { code: 'JSON_REQUIRED' } });
      if (!ready || stopping) return json(res, 503, { ok: false, error: { code: 'MODULE_STOPPING' } });
      if (busy) return json(res, 409, { ok: false, error: { code: 'ANALYSIS_BUSY' } });
      const body = await readBody(req); busy = true;
      try { active = analyze(body); const result = await active; return json(res, 200, { ok: true, result }); }
      catch (error) { return json(res, 502, { ok: false, status: 'uncertain', error: { code: error.code ?? 'RESULT_UNKNOWN' } }); }
      finally { busy = false; active = undefined; }
    }
    json(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
  })().catch(error => { if (!res.headersSent) json(res, 400, { ok: false, error: { code: error.code ?? 'HTTP_REQUEST_FAILED' } }); else res.end(); }); });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (stopping) await stop();
  else { ready = true; emit({ event: 'module-ready', entryUrl: origin + '/' }); }
} catch (error) {
  if (!stopping) { emit({ event: 'module-diagnostic', code: error.code ?? 'DESK_START_FAILED' }); process.exitCode = 1; }
  await stop();
}
