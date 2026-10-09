import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Bridge } from './bridge-kit.mjs';

const contract = Object.freeze({ id: 'text.read', version: '1.0.0' });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wellFormed = text => typeof text === 'string' && text.isWellFormed() && Buffer.byteLength(text, 'utf8') <= 16384;
let bridge, stopping = false, ready = false, work = Promise.resolve(), closeTask;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function stop() {
  if (closeTask) return closeTask;
  stopping = true; ready = false;
  return closeTask = (async () => {
    if (bridge) await bridge.close('module stopped');
    await work.catch(() => {});
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

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-config') throw fault('CLI_INVALID');
  const config = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
  const connection = config.bridges?.find(item => item.slot === 'main');
  const caller = config.peers?.desk?.principal, topic = config.topics?.source;
  if (config.format !== 'world-hub.run/v1' || !connection || typeof config.stateDir !== 'string'
      || typeof caller !== 'string' || typeof topic !== 'string'
      || !connection.publish.includes(topic) || !connection.subscribe.includes(topic)) throw fault('CONFIG_INVALID');
  await mkdir(config.stateDir, { recursive: true });
  const filename = join(config.stateDir, 'source.json');
  let state;
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { text: config.settings.text ?? '', revision: 0 }; }
  if (!wellFormed(state.text) || !Number.isSafeInteger(state.revision) || state.revision < 0) throw fault('STATE_INVALID');
  const save = async next => {
    const temporary = filename + '.tmp';
    await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
    await rename(temporary, filename); state = next;
  };
  await save(state);
  if (stopping) throw fault('MODULE_STOPPED');
  bridge = new Bridge({ url: connection.endpoint, bridgeId: connection.bridgeId,
    credential: connection.credential, token: connection.token, autoAck: true,
    instanceId: randomUUID(), reconnectMs: 250, displayName: 'Text source' });
  bridge.on('error', event => emit({ event: 'module-diagnostic', code: typeof event.code === 'string' ? event.code : 'BRIDGE_ERROR' }));
  bridge.on('delivery', message => {
    if (stopping || message.operation !== 'request' || message.topic !== topic) return;
    const pending = work.then(async () => {
      const body = message.body;
      const invocationId = typeof body?.invocationId === 'string' ? body.invocationId : '';
      const failure = code => ({ ok: false, kind: 'ecosystem.text-result', contract, invocationId,
        provider: config.module.id, error: { code, retryable: false } });
      let result;
      if (message.fromPrincipal !== caller) result = failure('PERMISSION_DENIED');
      else if (!object(body?.contract) || Object.keys(body.contract).length !== 2
          || body.contract.id !== contract.id || body.contract.version !== contract.version) result = failure('CONTRACT_MISMATCH');
      else if (!object(body) || !['read', 'set'].includes(body.command) || !invocationId
          || [...invocationId].length > 256 || Object.keys(body).some(key => !['contract', 'invocationId', 'command', 'text'].includes(key))
          || (body.command === 'set' && !wellFormed(body.text)) || (body.command === 'read' && Object.hasOwn(body, 'text'))) result = failure('INPUT_INVALID');
      else {
        if (body.command === 'set') await save({ text: body.text, revision: state.revision + 1 });
        result = { ok: true, kind: 'ecosystem.text-result', contract, invocationId,
          provider: config.module.id, text: state.text, revision: state.revision };
      }
      await bridge.respond(message, result);
    });
    work = pending.catch(() => { emit({ event: 'module-diagnostic', code: 'SOURCE_OPERATION_FAILED' }); });
    return pending;
  });
  const welcome = await bridge.connect();
  if (welcome.principal !== connection.principal || welcome.authenticated !== true) throw fault('WELCOME_UNTRUSTED');
  await bridge.registerChannels([{ name: topic, publish: true, subscribe: true }]);
  await bridge.subscribe([topic], { operations: ['request'], from: 'now' });
  if (stopping) await stop();
  else { ready = true; emit({ event: 'module-ready' }); }
} catch (error) {
  if (!stopping) { emit({ event: 'module-diagnostic', code: error.code ?? 'SOURCE_START_FAILED' }); process.exitCode = 1; }
  await stop();
}
