import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { Harness } from '../../helpers/hub-harness.mjs';

const worker = fileURLToPath(new URL('./worker.ps1', import.meta.url));
const pwsh = process.env.HUB_PWSH ?? 'pwsh';
const children = [];
const results = [];
function start(url, bridge, args = []) {
  const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-File', worker, '-Url', url, '-Bridge', bridge, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = []; let pending = ''; let stderr = ''; const waiters = [];
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => {
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n'); if (newline < 0) break;
      const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line); messages.push(message);
      for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  const rec = { child, messages, exited, wait(match, timeout = 12000) {
    const found = messages.find(match); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const w = { match, resolve, timer: setTimeout(() => reject(new Error(`Worker deadline: ${stderr}`)), timeout) }; waiters.push(w); });
  }, send(command) { child.stdin.write(JSON.stringify(command) + '\n'); } };
  children.push(rec); return rec;
}
async function check(name, run) { const t = Date.now(); await run(); results.push({ name, passed: true, milliseconds: Date.now() - t }); }
function bounded(promise) { return Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Exit deadline')), 7000); timer.unref(); })]); }
function serverFrame(bytes, opcode = 1, fin = true) {
  const head = bytes.length < 126 ? Buffer.from([(fin ? 128 : 0) | opcode, bytes.length]) : Buffer.from([(fin ? 128 : 0) | opcode, 126, bytes.length >> 8, bytes.length & 255]);
  return Buffer.concat([head, bytes]);
}

const temp = await mkdtemp(join(tmpdir(), 'hub-powershell-smoke-'));
const hub = new Harness();
let sender;
try {
  const config = join(temp, 'hub.json');
  await writeFile(config, JSON.stringify({ version: '0.1', log: { enabled: false }, acl: { defaultDeny: true, allowUnlistedBridges: false, bridges: { 'ps.smoke': { allow: { publish: ['#'], subscribe: ['#'] } }, 'js.control': { allow: { publish: ['#'], subscribe: ['#'] } } } } }));
  await hub.startHub({ configPath: config });
  sender = new WebSocket(hub.endpoint);
  const senderFrames = []; const senderWaiters = [];
  sender.addEventListener('message', event => { const frame = JSON.parse(event.data); senderFrames.push(frame); for (const item of [...senderWaiters]) if (item.match(frame)) { senderWaiters.splice(senderWaiters.indexOf(item), 1); clearTimeout(item.timer); item.resolve(frame); } });
  const waitSender = match => { const existing = senderFrames.find(match); return existing ? Promise.resolve(existing) : new Promise((resolve, reject) => { const item = { match, resolve, timer: setTimeout(() => reject(new Error('Sender deadline')), 7000) }; senderWaiters.push(item); }); };
  await new Promise((resolve, reject) => { sender.addEventListener('open', resolve, { once: true }); sender.addEventListener('error', reject, { once: true }); });
  sender.send(JSON.stringify({ type: 'hello', wire: '0.1', bridge: 'js.control' })); await waitSender(frame => frame.type === 'welcome');
  await check('real-hub-receive-while-stdin-idle-and-raw-fidelity', async () => {
    const ps = start(hub.endpoint, 'ps.smoke'); const ready = await ps.wait(message => message.event === 'ready'); assert.equal(ready.language, 'powershell');
    ps.send({ id: 'subscribe', action: 'send', frame: { type: 'subscribe', token: 's1', filters: ['ps/test'], from: 'now' } });
    await ps.wait(message => message.event === 'frame' && message.frame.type === 'caught_up');
    const rawBody = '{"文本":"中文🧭", "large":900719925474099312345, "exact":1.2300e+04}';
    sender.send('{"type":"publish","topic":"ps/test","body":' + rawBody + ',"requestToken":"raw1"}');
    const delivery = await ps.wait(message => message.event === 'frame' && message.frame.type === 'delivery');
    assert(delivery.raw.includes(rawBody)); assert.equal(delivery.frame.body['文本'], '中文🧭');
    ps.send({ id: 'raw-send', action: 'send', raw: '{"type":"publish","topic":"ps/out","body":' + rawBody + ',"requestToken":"psraw"}' });
    await ps.wait(message => message.event === 'frame' && message.frame.type === 'published' && message.frame.requestToken === 'psraw');
    ps.send({ id: 'close', action: 'close' }); await ps.wait(message => message.id === 'close' && message.ok === true);
    assert.equal((await bounded(ps.exited)).code, 0);
  });
  await check('real-hub-echo-program-directed-response-and-eof', async () => {
    sender.send(JSON.stringify({ type: 'subscribe', token: 'response', filters: ['ps/workflow'], from: 'now', operations: ['response'] })); await waitSender(frame => frame.type === 'subscribed' && frame.token === 'response');
    const ps = start(hub.endpoint, 'ps.smoke', ['-EchoTopic', 'ps/workflow']); await ps.wait(message => message.event === 'ready');
    sender.send(JSON.stringify({ type: 'request', target: { principal: 'ps.smoke' }, topic: 'ps/workflow', body: { fixture: 'phase7', runId: 'ps-smoke', steps: ['javascript'], payload: { text: '多轮' } } }));
    const response = await waitSender(frame => frame.type === 'delivery' && frame.operation === 'response');
    assert.deepEqual(response.body.steps, ['javascript', 'powershell']); assert.equal(response.fromPrincipal, 'ps.smoke'); assert.equal(response.body.payload.text, '多轮');
    sender.send('{"type":"request","target":{"principal":"ps.smoke"},"topic":"ps/workflow","body":{"fixture":"phase7","runId":"ps-surrogate-workflow","steps":["javascript","\\ud800"],"payload":{"text":"\\udfff","number":900719925474099312345}}}');
    const surrogateResponse = await waitSender(frame => frame.type === 'delivery' && frame.operation === 'response' && frame.body.runId === 'ps-surrogate-workflow');
    assert.equal(surrogateResponse.body.steps[1].charCodeAt(0), 0xd800);
    assert.equal(surrogateResponse.body.payload.text.charCodeAt(0), 0xdfff);
    assert.equal(surrogateResponse.body.steps[2], 'powershell');
    ps.child.stdin.end(); assert.equal((await bounded(ps.exited)).code, 0);
  });
  await check('real-hub-escaped-lone-surrogate-forward-and-worker-remains-live', async () => {
    const ps = start(hub.endpoint, 'ps.smoke'); await ps.wait(message => message.event === 'ready');
    ps.send({ id: 'surrogate-subscribe', action: 'send', frame: { type: 'subscribe', token: 'surrogate', filters: ['ps/surrogate'], from: 'now' } });
    await ps.wait(message => message.event === 'frame' && message.frame.type === 'caught_up');
    const rawBody = '{\n "text":"\\ud800", "low":"\\udfff", "number":900719925474099312345\n}';
    sender.send('{"type":"publish","topic":"ps/surrogate","body":' + rawBody + ',"requestToken":"surrogate-publish"}');
    const delivery = await ps.wait(message => message.event === 'frame' && message.frame.type === 'delivery' && message.frame.topic === 'ps/surrogate');
    assert(delivery.raw.includes(rawBody));
    assert.equal(delivery.frame.body.text.charCodeAt(0), 0xd800);
    assert.equal(delivery.frame.body.low.charCodeAt(0), 0xdfff);
    ps.send({ id: 'still-live', action: 'send', raw: '{"type":"publish","topic":"ps/alive","body":{"ok":true},"requestToken":"still-live"}' });
    await ps.wait(message => message.id === 'still-live' && message.ok === true);
    await ps.wait(message => message.event === 'frame' && message.frame.type === 'published' && message.frame.requestToken === 'still-live');
    assert.equal(ps.messages.filter(message => message.event === 'error').length, 0);
    ps.send({ id: 'surrogate-close', action: 'close' }); await ps.wait(message => message.id === 'surrogate-close' && message.ok === true);
    assert.equal((await bounded(ps.exited)).code, 0);
  });
  await check('real-hub-handshake-denied-exact-code-nonzero', async () => {
    const ps = start(hub.endpoint, 'ps.unregistered');
    const denied = await ps.wait(message => message.event === 'frame' && message.frame.type === 'denied'); assert.equal(denied.frame.code, 'BRIDGE_NOT_REGISTERED');
    const error = await ps.wait(message => message.event === 'error'); assert.equal(error.error.code, 'BRIDGE_NOT_REGISTERED'); assert.equal((await bounded(ps.exited)).code, 2);
  });
  await check('real-hub-remote-close-with-open-idle-stdin-nonzero', async () => {
    const ps = start(hub.endpoint, 'ps.smoke'); await ps.wait(message => message.event === 'ready');
    await hub.stop(); const error = await ps.wait(message => message.event === 'error'); assert(['WS_CLOSED', 'RECEIVE_FAILED'].includes(error.error.code)); assert.equal((await bounded(ps.exited)).code, 2);
  });
  for (const oversized of [false, true]) await check(oversized ? 'transport-bound-rejects-oversize' : 'transport-utf8-fragment-reassembly', async () => {
    const sockets = new Set(); const server = createServer(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.once('data', () => {
        const text = JSON.stringify({ type: 'welcome', text: '中文🧭', padding: oversized ? 'x'.repeat(200) : '' }); const bytes = Buffer.from(text);
        const split = bytes.indexOf(Buffer.from('🧭')) + 1;
        socket.write(serverFrame(bytes.subarray(0, split), 1, false)); socket.write(serverFrame(bytes.subarray(split), 0, true));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const ps = start(`ws://127.0.0.1:${server.address().port}/bridge`, 'ps.fragment', ['-MaxFrameBytes', '128']);
      if (oversized) { const error = await ps.wait(message => message.event === 'error'); assert.equal(error.error.code, 'FRAME_TOO_LARGE'); assert.equal((await bounded(ps.exited)).code, 2); }
      else { const ready = await ps.wait(message => message.event === 'ready'); assert.equal(ready.welcome.text, '中文🧭'); ps.child.stdin.end(); assert.equal((await bounded(ps.exited)).code, 0); }
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
  const evidence = { executedAt: new Date().toISOString(), hubPid: hub.hub.pid, node: process.version, pwsh, workerPids: children.map(rec => rec.child.pid), checks: results, passed: results.length, failed: 0, scope: 'PowerShell bridge controlled smoke; final two checks use a synthetic transport peer, first five use real Hub' };
  const directory = fileURLToPath(new URL(`../../../.artifacts/evidence/powershell-smoke/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  evidence.report = join(directory, 'report.json');
  await writeFile(evidence.report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(evidence));
} finally { sender?.close(); for (const rec of children) if (rec.child.exitCode == null) rec.child.kill(); await hub.stop(); await rm(temp, { recursive: true, force: true }); }
