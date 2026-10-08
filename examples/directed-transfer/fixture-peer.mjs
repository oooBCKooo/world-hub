// External test programs. All application behavior stays here, outside the Hub.
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [role, url, dir, bytesText] = process.argv.slice(2);
const bytes = Number(bytesText);
const bridges = [];
const say = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, role, pid: process.pid, ...fields }) + '\n');
const make = async (id) => {
  const bridge = new Bridge({ url, bridgeId: id, autoAck: true });
  bridges.push(bridge);
  bridge.on('error', (error) => say('bridge_error', { code: error.code, message: error.message }));
  await bridge.connect();
  return bridge;
};
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all(bridges.map((bridge) => bridge.close()));
}
process.on('SIGTERM', () => stop().finally(() => process.exit(0)));
process.on('SIGINT', () => stop().finally(() => process.exit(0)));

async function main() {
  if (role === 'provider') {
    const mod = await make('fixture.provider');
    await mod.registerChannels([{ name: 'chosen/request/information', publish: true, subscribe: true }]);
    mod.on('delivery', async (message) => {
      if (message.operation !== 'request') return;
      const receipt = await mod.respond(message, { providedBy: 'ordinary-external-program', information: message.body.query, count: 42 });
      say('responded', { requestSeq: message.seq, responseSeq: receipt.seq });
    });
    await mod.subscribe(['chosen/request/information'], { from: 0, operations: ['request'] });
    say('ready');
    return;
  }
  if (role === 'receiver') {
    const mod = await make('fixture.receiver');
    await mod.registerChannels([{ name: 'chosen/inject/object', subscribe: true }, { name: 'chosen/receipt/object', publish: true }]);
    mod.on('delivery', async (message) => {
      if (message.operation !== 'inject') return;
      const attachment = message.attachments?.[0];
      if (!attachment) throw new Error('fixture requires a verified attachment');
      const destination = join(dir, 'received.bin');
      const downloaded = await mod.downloadFile(message.seq, attachment.id, destination);
      const info = await stat(destination);
      if (info.size !== bytes) throw new Error('receiver got the wrong file size');
      await mod.sendTo({ principal: 'fixture.caller.bulk' }, 'chosen/receipt/object', { received: true, bytes: info.size, sha256: downloaded.sha256, originalSeq: message.seq });
      say('received', { seq: message.seq, bytes: info.size, sha256: downloaded.sha256 });
    });
    await mod.subscribe(['chosen/inject/object'], { from: 0, operations: ['inject'] });
    say('ready');
    return;
  }
  if (role !== 'caller') throw new Error('unknown fixture role');
  const control = await make('fixture.caller.control');
  const bulk = await make('fixture.caller.bulk');
  await control.registerChannels([{ name: 'chosen/request/information', publish: true, subscribe: true }]);
  await bulk.registerChannels([{ name: 'chosen/inject/object', publish: true }, { name: 'chosen/receipt/object', subscribe: true }]);
  const result = await control.call({ principal: 'fixture.provider' }, 'chosen/request/information', { query: 'information chosen by the requesting program' }, { timeoutMs: 30_000 });
  if (result.response.body.count !== 42 || result.response.requestSeq !== result.request.seq) throw new Error('unmatched program reply');
  say('called', { requestSeq: result.request.seq, responseSeq: result.response.seq, fromPrincipal: result.response.fromPrincipal });
  const path = join(dir, 'source.bin');
  const file = await open(path, 'wx');
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + Math.floor(i / 997)) & 255;
  const hash = createHash('sha256');
  try {
    for (let offset = 0; offset < bytes;) {
      const part = block.subarray(0, Math.min(block.length, bytes - offset));
      for (let written = 0; written < part.length;) {
        const result = await file.write(part, written, part.length - written);
        if (!result.bytesWritten) throw new Error('source file write made no progress');
        written += result.bytesWritten;
      }
      hash.update(part); offset += part.length;
    }
  } finally { await file.close(); }
  const sha256 = hash.digest('hex');
  let resolveReceipt;
  const received = new Promise((resolve) => { resolveReceipt = resolve; });
  bulk.on('delivery', (message) => {
    if (message.operation === 'inject' && message.topic === 'chosen/receipt/object') resolveReceipt(message);
  });
  await bulk.subscribe(['chosen/receipt/object'], { from: 'now', operations: ['inject'] });
  const object = await bulk.uploadFile(path);
  say('uploaded', { id: object.id, bytes: object.size, sha256: object.sha256 });
  const injection = await bulk.sendTo({ principal: 'fixture.receiver' }, 'chosen/inject/object', { description: 'opaque binary fixture', formatChosenByProgram: 'application/octet-stream' }, { attachments: [object.id] });
  const receipt = await received;
  if (receipt.fromPrincipal !== 'fixture.receiver' || receipt.body.bytes !== bytes || receipt.body.sha256 !== sha256 || receipt.body.originalSeq !== injection.seq) throw new Error('object receipt does not match the intended receiver or original bytes');
  // Provider policy chosen by this test program, never by the Hub.
  const released = await bulk.releaseBlob(object.id);
  await bulk.release([injection.seq]);
  await control.release([result.request.seq]);
  say('done', { requestSeq: result.request.seq, responseSeq: result.response.seq, injectionSeq: injection.seq, bytes, sha256, modsInCaller: bridges.length, providerReleasedBlob: released.released });
  await stop();
}
main().catch(async (error) => { say('failed', { message: error.stack ?? error.message }); await stop(); process.exitCode = 1; });
