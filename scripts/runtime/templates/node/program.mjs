import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Bridge } from './bridge-kit.mjs';
import { statistics } from './logic.mjs';
const contract = { id: 'text.statistics', version: '1.0.0' };
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let bridge, stopping = false, ready = false, work = Promise.resolve(), closing;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const stop = () => closing ??= (async () => { stopping = true; ready = false; await bridge?.close(); await work.catch(() => {}); input.close(); })();
input.on('line', line => { if (line.length > 65536) return; let request; try { request = JSON.parse(line); } catch { return; }
  if (request?.command === 'stop') void stop();
  if (request?.command === 'health' && typeof request.id === 'string' && request.id.length <= 256) emit({ event: 'module-health', id: request.id, ready: ready && !stopping }); });
input.on('close', () => { if (!stopping) void stop(); });
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-config') throw new Error('CLI_INVALID');
  const config = JSON.parse(await readFile(process.argv[3], 'utf8')), connection = config.bridges?.find(item => item.slot === 'main');
  const topic = config.topics?.[config.settings?.topicKey ?? 'stats'], caller = config.peers?.[config.settings?.callerId ?? 'desk']?.principal;
  if (config.format !== 'world-hub.run/v1' || !connection || !topic || !caller || !connection.publish.includes(topic) || !connection.subscribe.includes(topic)) throw new Error('CONFIG_INVALID');
  bridge = new Bridge({ url: connection.endpoint, bridgeId: connection.bridgeId, credential: connection.credential, token: connection.token,
    autoAck: true, reconnectMs: 250, displayName: config.module.id });
  bridge.on('error', error => { ready = false; emit({ event: 'module-diagnostic', code: error.code ?? 'BRIDGE_ERROR' }); });
  bridge.on('delivery', message => {
    if (stopping || message.operation !== 'request' || message.topic !== topic) return;
    const pending = work.then(async () => {
      const body = message.body, invocationId = typeof body?.invocationId === 'string' && [...body.invocationId].length <= 256 ? body.invocationId : '';
      const fail = code => ({ ok: false, kind: 'demo.capability-result', contract, invocationId, status: 'failed', provider: config.module.id, error: { code, message: code, retryable: false } });
      let result;
      if (message.fromPrincipal !== caller) result = fail('PERMISSION_DENIED');
      else if (body?.contract?.id !== contract.id || body?.contract?.version !== contract.version || Object.keys(body.contract).length !== 2) result = fail('CONTRACT_MISMATCH');
      else if (!invocationId || Object.keys(body).length !== 3 || !Object.hasOwn(body, 'text')) result = fail('INPUT_INVALID');
      else { try { result = { ok: true, kind: 'demo.capability-result', contract, invocationId, status: 'completed', provider: config.module.id, executionId: randomUUID(), output: statistics(body.text) }; } catch { result = fail('INPUT_INVALID'); } }
      await bridge.respond(message, result);
    });
    work = pending.catch(() => { ready = false; emit({ event: 'module-diagnostic', code: 'RESPONSE_FAILED' }); }); return pending;
  });
  const welcome = await bridge.connect();
  if (welcome.principal !== connection.principal || welcome.authenticated !== true) throw new Error('WELCOME_UNTRUSTED');
  await bridge.registerChannels([{ name: topic, publish: true, subscribe: true }]); await bridge.subscribe([topic], { operations: ['request'], from: 'now' });
  if (stopping) await stop(); else { ready = true; emit({ event: 'module-ready' }); }
} catch { if (!stopping) { emit({ event: 'module-diagnostic', code: 'MODULE_START_FAILED' }); process.exitCode = 1; } await stop(); }
