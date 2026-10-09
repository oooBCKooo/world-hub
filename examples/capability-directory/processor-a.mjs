#!/usr/bin/env node
// Independent provider A: only the public contract and the mod SDK are shared.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';

const PROVIDER = 'metrics-a', PRINCIPAL = 'demo.capability-directory.metrics-a';
const EXPLORER = 'demo.capability-directory.explorer', COMPOSER = 'demo.capability-directory.composer';
const STATISTICS = 'demo/capability-directory/text/statistics';
const CONTROL = 'demo/capability-directory/provider/metrics-a';
const CATALOG = 'demo/capability-directory/catalog/register';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validConfig(config) {
  if (!plain(config) || typeof config.contractVersion !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(config.contractVersion)
      || !Number.isSafeInteger(config.delayMs) || config.delayMs < 0 || config.delayMs > 10000
      || typeof config.announcing !== 'boolean' || !Array.isArray(config.allowPrincipals)
      || config.allowPrincipals.some(value => typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value))) {
    throw new Error('Invalid provider configuration');
  }
  return config;
}

export async function startProcessorA({ endpoint, credential, stateDir }) {
  if (typeof endpoint !== 'string' || !/^wss?:\/\//.test(endpoint) || typeof credential !== 'string' || !credential || !stateDir) throw new Error('endpoint, credential and state-dir are required');
  const directory = resolve(stateDir); await mkdir(directory, { recursive: true });
  const publicContract = JSON.parse(await readFile(new URL('./contract.json', import.meta.url), 'utf8'));
  let config = { contractVersion: '1.0.0', delayMs: 0, allowPrincipals: [COMPOSER], announcing: true };
  let statistics = { requests: 0, executions: 0, failures: 0, lastResult: null };
  try { config = validConfig({ ...config, ...JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8')) }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const saved = JSON.parse(await readFile(join(directory, 'statistics.json'), 'utf8')); if (!plain(saved) || ['requests', 'executions', 'failures'].some(key => !Number.isSafeInteger(saved[key]) || saved[key] < 0)) throw new Error('Invalid provider statistics'); statistics = saved; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let fileQueue = Promise.resolve();
  const persist = (name, value) => {
    const bytes = JSON.stringify(value, null, 2) + '\n';
    const next = fileQueue.then(async () => { const temporary = join(directory, `${name}.${process.pid}.tmp`); await writeFile(temporary, bytes, 'utf8'); await rename(temporary, join(directory, name)); });
    fileQueue = next.catch(() => {}); return next;
  };
  await persist('provider.json', config); await persist('statistics.json', statistics);
  const bridge = new Bridge({ url: endpoint, bridgeId: `${PRINCIPAL}.main`, credential: PRINCIPAL, token: credential,
    displayName: 'Independent Buffer metrics provider', cursorFile: join(directory, 'cursor.json'), reconnectMs: 250 });
  let stopped = false, timer = null, registrationPending = false;
  const closing = new AbortController();
  const catalogState = { epoch: null, lastRegisteredAt: null, lastError: null };
  const currentContract = () => ({ id: 'text.statistics', version: config.contractVersion });
  const snapshot = () => ({ ok: true, kind: 'demo.capability-provider', provider: PROVIDER,
    config: structuredClone(config), statistics: structuredClone(statistics), directory: structuredClone(catalogState) });
  const failure = (body, code, message) => ({ ok: false, kind: 'demo.capability-result', contract: currentContract(),
    invocationId: typeof body?.invocationId === 'string' && [...body.invocationId].length <= 256 ? body.invocationId : '', status: 'failed', provider: PROVIDER,
    error: { code, message, retryable: false } });
  bridge.on('error', error => { if (!stopped) process.stderr.write(JSON.stringify({ event: 'provider-diagnostic', provider: PROVIDER, error }) + '\n'); });
  bridge.on('delivery', async message => {
    if (stopped || message.operation !== 'request') return;
    const body = message.body;
    if (message.topic === CONTROL) {
      let result;
      if (message.fromPrincipal !== EXPLORER) result = { ok: false, kind: 'demo.capability-provider', provider: PROVIDER, error: { code: 'CONTROL_DENIED', message: 'Only the configured explorer may control this provider', retryable: false } };
      else try {
        if (!plain(body) || !['configure', 'snapshot'].includes(body.command)) throw new Error('Expected configure or snapshot');
        if (body.command === 'configure') {
          if (Object.keys(body).some(key => !['command', 'delayMs', 'allowComposer', 'announcing', 'contractVersion'].includes(key))) throw new Error('Unknown configuration field');
          if (body.allowComposer !== undefined && typeof body.allowComposer !== 'boolean') throw new Error('allowComposer must be boolean');
          const next = { ...config };
          for (const key of ['delayMs', 'announcing', 'contractVersion']) if (body[key] !== undefined) next[key] = body[key];
          if (body.allowComposer !== undefined) next.allowPrincipals = body.allowComposer ? [...new Set([...config.allowPrincipals, COMPOSER])] : config.allowPrincipals.filter(value => value !== COMPOSER);
          const validated = validConfig(next); await persist('provider.json', validated); config = validated;
        }
        result = snapshot();
      } catch (error) { result = { ok: false, kind: 'demo.capability-provider', provider: PROVIDER, error: { code: 'CONTROL_INVALID', message: error.message, retryable: false } }; }
      await bridge.respond(message, result); return;
    }
    if (message.topic !== STATISTICS) return;
    statistics.requests++;
    let result;
    try {
      if (!config.allowPrincipals.includes(message.fromPrincipal)) result = failure(body, 'PERMISSION_DENIED', 'This provider has not authorized the caller to read text');
      else if (!plain(body?.contract) || body.contract.id !== 'text.statistics' || body.contract.version !== config.contractVersion) result = failure(body, 'CONTRACT_MISMATCH', 'Exact text.statistics contract version required');
      else if (!plain(body) || Object.keys(body).some(key => !['contract', 'invocationId', 'text'].includes(key))
        || Object.keys(body.contract).some(key => !['id', 'version'].includes(key))
        || typeof body.invocationId !== 'string' || !body.invocationId.length || [...body.invocationId].length > 256
        || typeof body.text !== 'string' || !body.text.isWellFormed() || Buffer.byteLength(body.text, 'utf8') > 16384) result = failure(body, 'INPUT_INVALID', 'Expected invocationId and well-formed Unicode text up to 16384 UTF-8 bytes');
      else {
        const version = config.contractVersion, waiting = config.delayMs;
        if (waiting) await delay(waiting, undefined, { signal: closing.signal });
        if (stopped) return;
        const bytes = Buffer.from(body.text, 'utf8');
        result = { ok: true, kind: 'demo.capability-result', contract: { id: 'text.statistics', version }, invocationId: body.invocationId,
          status: 'completed', provider: PROVIDER, executionId: randomUUID(),
          output: { codePoints: [...body.text].length, lines: body.text.split('\n').length, utf8Bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
        statistics.executions++;
      }
      if (!result.ok) statistics.failures++;
      statistics.lastResult = structuredClone(result); await persist('statistics.json', statistics);
      await bridge.respond(message, result);
    } catch (error) {
      if (stopped) return;
      process.stderr.write(JSON.stringify({ event: 'provider-request-failed', provider: PROVIDER, requestSeq: message.seq, message: error.message }) + '\n');
      throw error;
    }
  });
  async function announce() {
    if (stopped || registrationPending || !config.announcing || !bridge.connected) return;
    registrationPending = true;
    try {
      const reply = await bridge.call({ principal: 'demo.capability-directory.directory' }, CATALOG, {
        manifestVersion: 1, module: { id: PROVIDER, version: '1.0.0' }, capabilities: [{ id: 'text.statistics', contract: currentContract(),
          inputSchema: publicContract.inputSchema, outputSchema: publicContract.outputSchema, semantics: publicContract.semantics,
          topic: STATISTICS, effects: 'read-only', permissions: ['text.read'] }], leaseMs: 1800 }, { timeoutMs: 1500 });
      if (reply.response.body?.ok !== true) throw new Error(reply.response.body?.error?.message ?? 'Directory declined registration');
      catalogState.epoch = reply.response.body.epoch ?? null; catalogState.lastRegisteredAt = new Date().toISOString(); catalogState.lastError = null;
    } catch (error) { if (!stopped) { catalogState.lastError = error.message; process.stderr.write(JSON.stringify({ event: 'provider-registration-failed', provider: PROVIDER, message: error.message }) + '\n'); } }
    finally { registrationPending = false; }
  }
  async function close() { if (stopped) return; stopped = true; closing.abort(); clearInterval(timer); await bridge.close('provider stopped'); await fileQueue; }
  try {
    await bridge.connect();
    if (bridge.welcome?.principal !== PRINCIPAL || bridge.welcome?.authenticated !== true) throw new Error('Authenticated provider principal does not match configuration');
    await bridge.registerChannels([{ name: STATISTICS, publish: true, subscribe: true }, { name: CONTROL, publish: true, subscribe: true }, { name: CATALOG, publish: true, subscribe: true }]);
    await bridge.subscribe([STATISTICS], { operations: ['request'], from: 'now' });
    await bridge.subscribe([CONTROL], { operations: ['request'], from: 'now' });
    timer = setInterval(() => void announce(), 600); void announce();
    return { close, bridge, snapshot, ready: () => ({ event: 'ready', profile: 'capability-directory', peer: PROVIDER, pid: process.pid, principal: PRINCIPAL,
      programEntry: '../capability-directory/processor-a.mjs', implementation: 'independent-buffer-statistics', stateDir: directory,
      bridges: [{ id: 'main', bridgeId: bridge.welcome?.bridge, declaredId: bridge.bridgeId, principal: bridge.welcome?.principal,
        session: bridge.welcome?.session, channels: bridge.channels, subscriptions: bridge.subscriptions }] }) };
  } catch (error) { await close(); throw error; }
}

async function main(argv) {
  const options = {}; const names = { '--profile': 'profile', '--peer': 'peer', '--endpoint': 'endpoint', '--credential': 'credential', '--state-dir': 'stateDir' };
  for (let i = 0; i < argv.length; i++) { const name = names[argv[i]], value = argv[++i]; if (!name || !value || value.startsWith('--') || options[name] !== undefined) throw new Error('Invalid or duplicate command-line option'); options[name] = value; }
  if (options.profile !== 'capability-directory' || options.peer !== PROVIDER) throw new Error('This entry runs capability-directory/metrics-a only');
  let runtime, stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runtime?.close(); if (process.connected) process.disconnect(); };
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
  if (process.send) { process.on('message', message => { if (message?.type === 'stop') void stop(); }); process.on('disconnect', () => void stop()); }
  try { runtime = await startProcessorA(options); if (stopping) await runtime.close(); else { const event = runtime.ready(); console.log(JSON.stringify(event)); process.send?.(event); } }
  catch (error) { await stop(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
