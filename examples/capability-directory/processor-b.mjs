#!/usr/bin/env node
// Provider B implements the published semantics with an independent algorithm.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, webcrypto } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';

const name = 'metrics-b', identity = 'demo.capability-directory.metrics-b';
const trustedController = 'demo.capability-directory.explorer', normalCaller = 'demo.capability-directory.composer';
const measurementTopic = 'demo/capability-directory/text/statistics';
const administrationTopic = 'demo/capability-directory/provider/metrics-b';
const registrationTopic = 'demo/capability-directory/catalog/register';
const object = item => !!item && typeof item === 'object' && !Array.isArray(item);

function checkSettings(value) {
  if (!object(value) || typeof value.contractVersion !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.contractVersion)) throw new Error('contractVersion must have three numeric components of at most six digits');
  if (!Number.isSafeInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 10000) throw new Error('delayMs must be an integer between 0 and 10000');
  if (typeof value.announcing !== 'boolean') throw new Error('announcing must be boolean');
  if (!Array.isArray(value.allowPrincipals) || !value.allowPrincipals.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(item))) throw new Error('allowPrincipals must contain valid principal names');
  return value;
}

// Validate UTF-16 pairs before TextEncoder, which would otherwise replace lone
// surrogates. Count scalar values and LF boundaries without iterator or split.
function inspectText(text) {
  let codePoints = 0, lines = 1;
  for (let position = 0; position < text.length;) {
    const unit = text.charCodeAt(position);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = text.charCodeAt(position + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return null;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    const point = text.codePointAt(position);
    if (point === 10) lines++;
    codePoints++; position += point > 0xffff ? 2 : 1;
  }
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= 16384 ? { codePoints, lines, bytes } : null;
}

export async function startProcessorB(options) {
  if (!options.stateDir || typeof options.endpoint !== 'string' || !/^wss?:\/\//.test(options.endpoint) || typeof options.credential !== 'string' || !options.credential) throw new Error('Missing valid endpoint, credential or state directory');
  const storage = resolve(options.stateDir); await mkdir(storage, { recursive: true });
  const contractDocument = JSON.parse(await readFile(new URL('./contract.json', import.meta.url), 'utf8'));
  let settings = { contractVersion: '1.0.0', delayMs: 0, allowPrincipals: [normalCaller], announcing: true };
  let record = { requests: 0, executions: 0, failures: 0, lastResult: null };
  try { settings = checkSettings(Object.assign(settings, JSON.parse(await readFile(join(storage, 'provider.json'), 'utf8')))); } catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
  try { record = JSON.parse(await readFile(join(storage, 'statistics.json'), 'utf8')); if (!object(record) || !['requests', 'executions', 'failures'].every(key => Number.isSafeInteger(record[key]) && record[key] >= 0)) throw new Error('Invalid persisted statistics'); } catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
  let writes = Promise.resolve();
  function save(filename, data) {
    const encoded = JSON.stringify(data, null, 2) + '\n';
    const write = writes.then(async () => { const scratch = join(storage, `${filename}.${process.pid}.tmp`); await writeFile(scratch, encoded, 'utf8'); await rename(scratch, join(storage, filename)); });
    writes = write.catch(() => {}); return write;
  }
  await save('provider.json', settings); await save('statistics.json', record);
  const mod = new Bridge({ url: options.endpoint, bridgeId: `${identity}.main`, credential: identity, token: options.credential,
    displayName: 'Independent WebCrypto metrics provider', cursorFile: join(storage, 'cursor.json'), reconnectMs: 250 });
  const interrupt = new AbortController();
  let ending = false, renewalTimer, renewalBusy = false;
  const catalog = { epoch: null, lastRegisteredAt: null, lastError: null };
  function snapshot() { return { ok: true, kind: 'demo.capability-provider', provider: name,
    config: structuredClone(settings), statistics: structuredClone(record), directory: structuredClone(catalog) }; }
  function rejected(input, code, message) {
    let echoedId = '';
    if (typeof input?.invocationId === 'string') { let count = 0; for (let i = 0; i < input.invocationId.length && count <= 256; count++) i += input.invocationId.codePointAt(i) > 0xffff ? 2 : 1; if (count <= 256) echoedId = input.invocationId; }
    return { ok: false, kind: 'demo.capability-result', contract: { id: 'text.statistics', version: settings.contractVersion },
      invocationId: echoedId, status: 'failed', provider: name, error: { code, message, retryable: false } };
  }
  mod.on('error', problem => { if (!ending) console.error(JSON.stringify({ event: 'provider-diagnostic', provider: name, error: problem })); });
  mod.on('delivery', async delivery => {
    if (ending || delivery.operation !== 'request') return;
    const input = delivery.body;
    if (delivery.topic === administrationTopic) {
      let result;
      if (delivery.fromPrincipal !== trustedController) result = { ok: false, kind: 'demo.capability-provider', provider: name,
        error: { code: 'CONTROL_DENIED', message: 'Provider administration requires the explorer principal', retryable: false } };
      else try {
        if (!object(input) || !['snapshot', 'configure'].includes(input.command)) throw new Error('Unknown provider command');
        if (input.command === 'configure') {
          if (Object.keys(input).some(key => !['command', 'delayMs', 'allowComposer', 'announcing', 'contractVersion'].includes(key))) throw new Error('Unknown provider setting');
          if (input.allowComposer !== undefined && typeof input.allowComposer !== 'boolean') throw new Error('allowComposer requires a boolean');
          const replacement = { ...settings };
          if (input.delayMs !== undefined) replacement.delayMs = input.delayMs;
          if (input.announcing !== undefined) replacement.announcing = input.announcing;
          if (input.contractVersion !== undefined) replacement.contractVersion = input.contractVersion;
          if (input.allowComposer === false) replacement.allowPrincipals = settings.allowPrincipals.filter(item => item !== normalCaller);
          if (input.allowComposer === true && !settings.allowPrincipals.includes(normalCaller)) replacement.allowPrincipals = settings.allowPrincipals.concat(normalCaller);
          const checked = checkSettings(replacement); await save('provider.json', checked); settings = checked;
        }
        result = snapshot();
      } catch (problem) { result = { ok: false, kind: 'demo.capability-provider', provider: name, error: { code: 'CONTROL_INVALID', message: problem.message, retryable: false } }; }
      await mod.respond(delivery, result); return;
    }
    if (delivery.topic !== measurementTopic) return;
    record.requests++;
    let outcome;
    try {
      if (!settings.allowPrincipals.includes(delivery.fromPrincipal)) outcome = rejected(input, 'PERMISSION_DENIED', 'Caller lacks the provider text.read authorization');
      else if (!object(input?.contract) || input.contract.id !== 'text.statistics' || input.contract.version !== settings.contractVersion) outcome = rejected(input, 'CONTRACT_MISMATCH', 'Provider requires an exact matching text.statistics version');
      else {
        const idLength = typeof input?.invocationId === 'string' ? (() => { let count = 0; for (let i = 0; i < input.invocationId.length; count++) i += input.invocationId.codePointAt(i) > 0xffff ? 2 : 1; return count; })() : 0;
        const inspected = typeof input?.text === 'string' ? inspectText(input.text) : null;
        if (!object(input) || Object.keys(input).some(key => !['contract', 'invocationId', 'text'].includes(key))
            || Object.keys(input.contract).some(key => !['id', 'version'].includes(key)) || idLength < 1 || idLength > 256 || !inspected) outcome = rejected(input, 'INPUT_INVALID', 'Input needs a valid invocationId and well-formed text within the UTF-8 byte limit');
        else {
          const version = settings.contractVersion;
          if (settings.delayMs) await sleep(settings.delayMs, undefined, { signal: interrupt.signal });
          if (ending) return;
          const hashBytes = new Uint8Array(await webcrypto.subtle.digest('SHA-256', inspected.bytes));
          let hexadecimal = ''; for (const octet of hashBytes) hexadecimal += octet.toString(16).padStart(2, '0');
          outcome = { ok: true, kind: 'demo.capability-result', contract: { id: 'text.statistics', version }, invocationId: input.invocationId,
            status: 'completed', provider: name, executionId: randomUUID(),
            output: { codePoints: inspected.codePoints, lines: inspected.lines, utf8Bytes: inspected.bytes.length, sha256: hexadecimal } };
          record.executions++;
        }
      }
      if (!outcome.ok) record.failures++;
      record.lastResult = structuredClone(outcome); await save('statistics.json', record);
      await mod.respond(delivery, outcome);
    } catch (problem) { if (ending) return; console.error(JSON.stringify({ event: 'provider-request-failed', provider: name, requestSeq: delivery.seq, message: problem.message })); throw problem; }
  });
  async function register() {
    if (ending || renewalBusy || !settings.announcing || !mod.connected) return;
    renewalBusy = true;
    try {
      const response = await mod.call({ principal: 'demo.capability-directory.directory' }, registrationTopic, {
        manifestVersion: 1, module: { id: name, version: '1.0.0' }, capabilities: [{ id: 'text.statistics',
          contract: { id: 'text.statistics', version: settings.contractVersion }, inputSchema: contractDocument.inputSchema, outputSchema: contractDocument.outputSchema,
          semantics: contractDocument.semantics, topic: measurementTopic, effects: 'read-only', permissions: ['text.read'] }], leaseMs: 1800 }, { timeoutMs: 1500 });
      if (response.response.body?.ok !== true) throw new Error(response.response.body?.error?.message ?? 'Capability directory rejected registration');
      catalog.epoch = response.response.body.epoch ?? null; catalog.lastRegisteredAt = new Date().toISOString(); catalog.lastError = null;
    } catch (problem) { if (!ending) { catalog.lastError = problem.message; console.error(JSON.stringify({ event: 'provider-registration-failed', provider: name, message: problem.message })); } }
    finally { renewalBusy = false; }
  }
  async function close() { if (ending) return; ending = true; interrupt.abort(); clearInterval(renewalTimer); await mod.close('independent provider stopped'); await writes; }
  try {
    await mod.connect();
    if (mod.welcome?.principal !== identity || mod.welcome?.authenticated !== true) throw new Error('Provider requires its configured token-authenticated principal');
    await mod.registerChannels([measurementTopic, administrationTopic, registrationTopic].map(topic => ({ name: topic, publish: true, subscribe: true })));
    await mod.subscribe([measurementTopic], { operations: ['request'], from: 'now' });
    await mod.subscribe([administrationTopic], { operations: ['request'], from: 'now' });
    renewalTimer = setInterval(() => void register(), 600); void register();
    return { close, bridge: mod, snapshot, ready: () => ({ event: 'ready', profile: 'capability-directory', peer: name, pid: process.pid, principal: identity,
      programEntry: '../capability-directory/processor-b.mjs', implementation: 'independent-webcrypto-statistics', stateDir: storage,
      bridges: [{ id: 'main', bridgeId: mod.welcome?.bridge, declaredId: mod.bridgeId, principal: mod.welcome?.principal,
        session: mod.welcome?.session, channels: mod.channels, subscriptions: mod.subscriptions }] }) };
  } catch (problem) { await close(); throw problem; }
}

async function run(argumentsList) {
  const flags = { '--profile': 'profile', '--peer': 'peer', '--endpoint': 'endpoint', '--credential': 'credential', '--state-dir': 'stateDir' }, options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = flags[argumentsList[index]], value = argumentsList[index + 1];
    if (!key || typeof value !== 'string' || !value || value.startsWith('--') || key in options) throw new Error('Expected unique named options with values'); options[key] = value;
  }
  if (options.profile !== 'capability-directory' || options.peer !== name) throw new Error('This processor only serves capability-directory/metrics-b');
  let provider, ending = false;
  const finish = async () => { if (ending) return; ending = true; await provider?.close(); if (process.connected) process.disconnect(); };
  process.on('SIGINT', () => void finish()); process.on('SIGTERM', () => void finish());
  if (process.send) { process.on('message', message => { if (message?.type === 'stop') void finish(); }); process.on('disconnect', () => void finish()); }
  try { provider = await startProcessorB(options); if (ending) await provider.close(); else { const event = provider.ready(); console.log(JSON.stringify(event)); process.send?.(event); } }
  catch (problem) { await finish(); throw problem; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run(process.argv.slice(2)).catch(problem => { console.error(problem.message); process.exitCode = 1; });
