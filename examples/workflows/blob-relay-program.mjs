// A fixture application, outside the Hub: it chooses to verify and copy an
// incoming file before sending its own newly provided object to the next app.
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';

const configuration = JSON.parse(await readFile(process.argv[2], 'utf8'));
const bridge = new Bridge({ url: configuration.url, bridgeId: configuration.mod.id,
  token: configuration.mod.token, reconnectMs: 40 });
const forwarded = [];
let stopping = false;
const emit = (event, fields = {}) => process.stdout.write(JSON.stringify({ event,
  program: configuration.name, pid: process.pid, ...fields }) + '\n');
const errorRecord = (error) => ({ message: error.message, code: error.code });
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return { size: (await stat(path)).size, sha256: hash.digest('hex') };
}

bridge.on('error', (frame) => emit('bridge_error', { frame }));
bridge.on('denied', (frame) => emit('bridge_denied', { frame }));
bridge.on('delivery', async (message) => {
  if (message.operation !== 'inject' || message.topic !== configuration.incomingTopic) return;
  try {
    if (message.attachments?.length !== 1 || !Array.isArray(message.body?.trace))
      throw new Error('relay fixture expects one attachment and an application trace');
    const incoming = message.attachments[0];
    const path = resolve(join(configuration.dir, `${configuration.name}-${message.seq}.bin`));
    if (!path.startsWith(resolve(configuration.dir) + sep)) throw new Error('relay file escaped scene directory');
    await bridge.downloadFile(message.seq, incoming.id, path);
    const verified = await digestFile(path);
    if (verified.sha256 !== incoming.sha256 || verified.size !== incoming.size)
      throw new Error('relay verification differs from the incoming object descriptor');
    // Reading does not make this program the provider of the original object.
    // This separate upload is owned by this program's authenticated principal.
    const provided = await bridge.uploadFile(path);
    if (provided.id === incoming.id) throw new Error('relay did not create its own object');
    const step = { program: configuration.name, pid: process.pid, inputSeq: message.seq,
      inputPrincipal: message.fromPrincipal, inputObject: incoming.id,
      outputObject: provided.id, ...verified };
    const body = { ...message.body, trace: [...message.body.trace, step] };
    const receipt = await bridge.sendTo({ principal: configuration.nextPrincipal },
      configuration.outgoingTopic, body, { attachments: [provided.id], correlation: message.body.flowId });
    const proof = { ...step, outgoingSeq: receipt.seq, incomingTopic: message.topic,
      outgoingTopic: configuration.outgoingTopic, nextPrincipal: configuration.nextPrincipal,
      provided, receipt };
    forwarded.push(proof);
    emit('forwarded', proof);
  } catch (error) { emit('handler_failed', { messageSeq: message.seq, error: errorRecord(error) }); throw error; }
});

async function command(op, args = {}) {
  switch (op) {
    case 'snapshot': return { forwarded, principal: bridge.welcome.principal, session: bridge.welcome.session };
    case 'blobStatus': return bridge.blobStatus(args.id);
    case 'releaseBlob': return bridge.releaseBlob(args.id);
    case 'release': return bridge.release(args.seq);
    case 'blob': return bridge.communicationRequest(args.type, args.fields);
    case 'inject': return bridge.sendTo(args.target, args.topic, args.body, { attachments: args.attachments });
    default: throw new Error(`unknown relay control ${op}`);
  }
}
async function stop() {
  if (stopping) return;
  stopping = true;
  await bridge.close();
  emit('stopped');
  if (process.connected) process.disconnect();
  process.exit(0);
}
process.on('message', async (message) => {
  if (message.type === 'stop') { await stop(); return; }
  if (message.type !== 'command') return;
  try {
    const value = await command(message.op, message.args);
    if (process.connected) process.send({ type: 'result', commandId: message.commandId, value });
  } catch (error) {
    if (process.connected) process.send({ type: 'result', commandId: message.commandId, error: errorRecord(error) });
  }
});
process.on('disconnect', () => { if (!stopping) stop().catch(() => process.exit(1)); });
process.on('SIGTERM', () => stop().catch(() => process.exit(1)));

try {
  await bridge.connect();
  await bridge.registerChannels([
    { name: configuration.incomingTopic, publish: false, subscribe: true },
    { name: configuration.outgoingTopic, publish: true, subscribe: false },
  ]);
  await bridge.subscribe([configuration.incomingTopic], { from: 0, operations: ['inject'] });
  emit('ready', { principal: bridge.welcome.principal, session: bridge.welcome.session });
} catch (error) {
  emit('fatal', { error: errorRecord(error) });
  await bridge.close();
  if (process.connected) process.disconnect();
  process.exitCode = 1;
}
