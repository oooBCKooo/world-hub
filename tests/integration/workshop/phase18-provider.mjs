// Local E2E fixture, not evidence of an independent human author.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Bridge } from '#bridge';

const contract = { id: 'text.statistics', version: '1.0.0' };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let bridge, ready = false, stopping = false, closing;
const control = createInterface({ input: process.stdin, crlfDelay: Infinity });
function stop() {
  if (closing) return closing;
  ready = false; stopping = true;
  return closing = (async () => { if (bridge) await bridge.close(); control.close(); })();
}
control.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.command === 'stop') void stop();
  if (message.command === 'health' && typeof message.id === 'string') emit({ event: 'module-health', id: message.id, ready: ready && !stopping });
});
control.on('close', () => { if (!stopping) void stop(); });
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-config') throw new Error('CLI_INVALID');
  const config = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
  const connection = config.bridges.find(value => value.slot === 'main'), topic = config.topics.stats;
  const caller = config.peers.desk.principal;
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(join(config.stateDir, 'provider-started.json'), JSON.stringify({ version: config.module.version }) + '\n');
  bridge = new Bridge({ url: connection.endpoint, bridgeId: connection.bridgeId, credential: connection.credential, token: connection.token, autoAck: true });
  bridge.on('delivery', async message => {
    if (message.operation !== 'request' || message.topic !== topic) return;
    const body = message.body, invocationId = typeof body?.invocationId === 'string' ? body.invocationId : '';
    const failure = code => ({ ok: false, kind: 'demo.capability-result', contract, invocationId, status: 'failed', provider: config.module.id, error: { code, message: code, retryable: false } });
    let result;
    if (message.fromPrincipal !== caller) result = failure('PERMISSION_DENIED');
    else if (body?.contract?.id !== contract.id || body?.contract?.version !== contract.version) result = failure('CONTRACT_MISMATCH');
    else if (!body || Object.keys(body).sort().join(',') !== 'contract,invocationId,text' || !invocationId || invocationId.length > 256
      || typeof body.text !== 'string' || !body.text.isWellFormed() || Buffer.byteLength(body.text) > 16384) result = failure('INPUT_INVALID');
    else result = { ok: true, kind: 'demo.capability-result', contract, invocationId, status: 'completed', provider: config.module.id,
      executionId: randomUUID(), output: { codePoints: [...body.text].length, lines: body.text.split('\n').length,
        utf8Bytes: Buffer.byteLength(body.text), sha256: createHash('sha256').update(Buffer.from(body.text)).digest('hex') } };
    await bridge.respond(message, result);
  });
  const welcome = await bridge.connect();
  if (welcome.principal !== connection.principal || welcome.authenticated !== true) throw new Error('WELCOME_INVALID');
  await bridge.registerChannels([{ name: topic, publish: true, subscribe: true }]);
  await bridge.subscribe([topic], { operations: ['request'], from: 'now' });
  if (!stopping) { ready = true; emit({ event: 'module-ready' }); }
} catch (error) {
  if (!stopping) { emit({ event: 'module-diagnostic', code: 'WORKSHOP_FIXTURE_FAILED', message: error.message }); process.exitCode = 1; }
  await stop();
}
