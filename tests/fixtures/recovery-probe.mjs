// Ordinary external probe program: owns data generation, selection and ACK timing.
// The hub receives only opaque payloads and ordinary subscription filters.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnvelope } from '../../src/hub/lib/wire-json.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const emit = (event, data = {}) => console.log(JSON.stringify({ event, pid: process.pid, ...data }));
const topicFor = (n) => n % 101 === 0 ? 'scale/rare' : n % 2 ? 'scale/odd' : 'scale/even';
const socket = new WebSocket(config.endpoint);
const inbox = [], waiters = [];
let ackTimer, subscription, ackQueue = [], firstWindow = true, closing = false;
const received = [], rawReceived = [];
function fail(error) { console.error(error?.stack ?? error); process.exitCode = 1; void stop(); }
const wait = (predicate, timeoutMs = 60000) => {
  const existing = inbox.findIndex((entry) => predicate(entry.frame));
  if (existing >= 0) return Promise.resolve(inbox.splice(existing, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('probe frame timeout')); }, timeoutMs);
    waiters.push(waiter);
  });
};
const send = (frame) => socket.send(JSON.stringify(frame));
function flushAck() {
  clearTimeout(ackTimer); ackTimer = undefined;
  if (ackQueue.length && socket.readyState === WebSocket.OPEN) send({ type: 'ack', subscription, seq: ackQueue.splice(0) });
}
function queueAck(frame) {
  ackQueue.push(frame.seq);
  if (!ackTimer) ackTimer = setTimeout(flushAck, firstWindow ? config.initialPauseMs ?? 150 : config.ackDelayMs ?? 2);
  if (ackQueue.length === config.window) {
    if (firstWindow) { firstWindow = false; emit('first_window', { subscription, pending: ackQueue.length, through: frame.seq }); }
  }
}
socket.addEventListener('message', (event) => {
  try {
    const frame = JSON.parse(event.data);
    if (frame.type === 'delivery') {
      received.push({ seq: frame.seq, topic: frame.topic, body: frame.body });
      if (config.mode === 'raw-consume') rawReceived.push({ seq: frame.seq, raw: parseEnvelope(event.data).bodyRaw });
      subscription ??= frame.subscription;
      queueAck(frame);
      return;
    }
    if (['error', 'denied', 'overflow', 'catchup_truncated'].includes(frame.type)) throw new Error('unexpected probe frame: ' + JSON.stringify(frame));
    const matched = waiters.findIndex((entry) => entry.predicate(frame));
    if (matched >= 0) { const waiting = waiters.splice(matched, 1)[0]; clearTimeout(waiting.timer); waiting.resolve({ frame, text: event.data }); }
    else inbox.push({ frame, text: event.data });
  } catch (error) { fail(error); }
});
socket.addEventListener('error', () => { if (!closing) fail(new Error('probe websocket error')); });
socket.addEventListener('close', () => { if (!closing) fail(new Error('probe disconnected before owned stop')); });
async function stop() {
  if (closing) return;
  closing = true; clearTimeout(ackTimer);
  for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('probe stopped')); }
  if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'owned probe stopped');
  await new Promise((resolve) => { if (socket.readyState === WebSocket.CLOSED) resolve(); else { const timer = setTimeout(resolve, 1000); socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true }); } });
  process.exit(process.exitCode ?? 0);
}
process.on('message', (message) => { if (message?.type === 'stop') void stop(); });
process.on('disconnect', () => { void stop(); });
try {
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  send({ type: 'hello', wire: '0.1', bridge: config.bridge, token: config.token });
  const { frame: welcome } = await wait((frame) => frame.type === 'welcome');
  emit('ready', { bridge: welcome.bridge, mode: config.mode, limits: welcome.limits });
  const started = performance.now();
  if (config.mode === 'seed' || config.mode === 'raw-seed') {
    const accepted = [];
    for (let n = 0; n < (config.rawBodies?.length ?? config.count); n++) {
      const requestToken = randomUUID();
      if (config.mode === 'raw-seed') socket.send('{"type":"publish","topic":"raw/newlines","requestToken":' + JSON.stringify(requestToken) + ',"body":' + config.rawBodies[n] + '}');
      else send({ type: 'publish', topic: topicFor(n), requestToken, body: { n, pad: 'x'.repeat(config.padBytes) } });
      const { frame } = await wait((frame) => frame.type === 'published' && frame.requestToken === requestToken);
      accepted.push(frame.seq);
    }
    assert.deepEqual(accepted, Array.from({ length: accepted.length }, (_, n) => n + 1));
    emit('completed', { count: accepted.length, elapsedMs: performance.now() - started, lastSeq: accepted.at(-1) });
  } else {
    send({ type: 'subscribe', token: 'recover', from: 0, filters: config.filters });
    const { frame: subscribed } = await wait((frame) => frame.type === 'subscribed');
    subscription = subscribed.subscription;
    const { frame: caught } = await wait((frame) => frame.type === 'caught_up');
    flushAck();
    const expected = config.mode === 'raw-consume' ? config.rawBodies.map((_, n) => n) : Array.from({ length: config.count }, (_, n) => n).filter((n) => config.filters.includes('scale/#') || topicFor(n) === 'scale/rare');
    assert.deepEqual(received.map((message) => message.seq), expected.map((n) => n + 1));
    if (config.mode === 'raw-consume') assert.deepEqual(rawReceived.map((message) => message.raw), config.rawBodies);
    else {
      assert.deepEqual(received.map((message) => message.body.n), expected);
      for (const message of received) { assert.equal(message.topic, topicFor(message.body.n)); assert.equal(message.body.pad, 'x'.repeat(config.padBytes)); }
    }
    assert.equal(new Set(received.map((message) => message.seq)).size, received.length);
    emit('completed', { count: received.length, elapsedMs: performance.now() - started, through: caught.through,
      sequenceHash: createHash('sha256').update(JSON.stringify(received.map((message) => message.seq))).digest('hex'),
      ...(config.mode === 'raw-consume' ? { rawHashes: rawReceived.map((message) => createHash('sha256').update(message.raw).digest('hex')) } : {}) });
  }
} catch (error) { fail(error); }
