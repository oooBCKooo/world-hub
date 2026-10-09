#!/usr/bin/env node
// Source, result sink and composer are separate processes. All are optional applications.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPurposePeerMain } from '../purpose-demos/peer.mjs';
import { channel, openState } from '../purpose-demos/common.mjs';

const CONTRACT = { id: 'text.statistics', version: '1.0.0' };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fault = (code, message) => Object.assign(new Error(message), { code });
const key = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
const canonical = value => JSON.stringify(value, (_, child) => object(child)
  ? Object.fromEntries(Object.keys(child).sort().map(name => [name, child[name]])) : child);
const validText = value => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 16384;
const validOutput = value => object(value) && Object.keys(value).sort().join(',') === 'codePoints,lines,sha256,utf8Bytes'
  && ['codePoints', 'lines', 'utf8Bytes'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= (field === 'lines' ? 16385 : 16384))
  && value.lines >= 1 && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256);
const fieldsAre = (value, fields) => object(value) && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
const validResult = (value, invocationId, provider) => object(value)
  && value.kind === 'demo.capability-result' && canonical(value.contract) === canonical(CONTRACT)
  && value.invocationId === invocationId && value.provider === provider && (
    value.ok === true && value.status === 'completed'
      && fieldsAre(value, 'ok,kind,contract,invocationId,status,provider,executionId,output')
      && typeof value.executionId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.executionId)
      && validOutput(value.output)
    || value.ok === false && value.status === 'failed'
      && fieldsAre(value, 'ok,kind,contract,invocationId,status,provider,error')
      && fieldsAre(value.error, 'code,message,retryable') && typeof value.error.code === 'string' && value.error.code.length > 0
      && typeof value.error.message === 'string' && value.error.retryable === false
  );

async function source(context) {
  const state = await openState(context.stateDir, 'source-state.json', { version: 1, revision: 0, text: '世界枢纽\nWorld Hub 🌍\n' });
  const topic = context.topic('source/read');
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true })], filters: [topic], operations: ['request'],
    onDelivery: async (message, bridge) => {
      const body = message.body;
      if (!object(body) || !['read', 'set'].includes(body.command))
        return bridge.respond(message, { ok: false, status: 'failed', error: { code: 'INPUT_INVALID', message: 'Expected read or set.' } });
      if (body.command === 'set') {
        if (message.fromPrincipal !== context.target('explorer').principal || !validText(body.text))
          return bridge.respond(message, { ok: false, status: 'failed', error: { code: 'SOURCE_UPDATE_DENIED', message: 'Only the explorer can set bounded Unicode text.' } });
        await state.save({ ...state.value, text: body.text, revision: state.value.revision + 1 });
      }
      await bridge.respond(message, { ok: true, kind: 'demo.capability-source', ...state.value });
    } });
}

async function sink(context) {
  const state = await openState(context.stateDir, 'output-state.json', { version: 1, records: [] });
  const commit = context.topic('output/commit'), read = context.topic('output/read');
  await context.openBridge('main', { channels: [channel(commit, { subscribe: true }), channel(read, { subscribe: true })],
    filters: [commit, read], operations: ['request'], onDelivery: async (message, bridge) => {
      try {
        if (message.topic === read) {
          if (message.body?.command !== 'snapshot') throw fault('INPUT_INVALID', 'Expected snapshot.');
          await bridge.respond(message, { ok: true, kind: 'demo.capability-output', records: state.value.records }); return;
        }
        if (message.fromPrincipal !== context.target('composer').principal) throw fault('PERMISSION_DENIED', 'Only the configured composer can commit results.');
        const body = message.body;
        if (!object(body) || !key(body.invocationId) || canonical(body.contract) !== canonical(CONTRACT)
            || !validOutput(body.output) || !object(body.processor) || !object(body.processor.module)
            || typeof body.processor.principal !== 'string' || typeof body.processor.session !== 'string')
          throw fault('OUTPUT_INVALID', 'Expected the agreed statistics result and provider provenance.');
        const payload = { invocationId: body.invocationId, contract: body.contract, output: body.output, processor: body.processor };
        const previous = state.value.records.find(record => record.invocationId === body.invocationId);
        if (previous) {
          const { completedAt, ...saved } = previous;
          if (canonical(saved) !== canonical(payload)) throw fault('IDEMPOTENCY_CONFLICT', 'This invocationId already has a different result.');
          await bridge.respond(message, { ok: true, kind: 'demo.capability-output', status: 'completed', record: previous, cached: true }); return;
        }
        // This example demonstrates durable duplicate detection after an orderly restart.
        // It is not a transaction with the Hub, a power-loss guarantee or exactly-once execution.
        if (state.value.records.length >= 64) throw fault('OUTPUT_FULL', 'This demonstration keeps at most 64 results. Start a new session for more.');
        const record = { ...payload, completedAt: new Date().toISOString() };
        await state.save({ ...state.value, records: [...state.value.records, record] });
        await bridge.respond(message, { ok: true, kind: 'demo.capability-output', status: 'completed', record, cached: false });
      } catch (error) { await bridge.respond(message, { ok: false, kind: 'demo.capability-output', status: 'failed',
        error: { code: error.code ?? 'OUTPUT_FAILED', message: error.message, retryable: false } }); }
    } });
}

async function composer(context) {
  const schema = JSON.parse(await readFile(fileURLToPath(new URL('./contract.json', import.meta.url)), 'utf8'));
  const state = await openState(context.stateDir, 'composition-config.json', {
    version: 1, revision: 0, provider: 'metrics-a', contractVersion: '1.0.0', timeoutMs: 800,
  });
  const validateConfig = config => {
    if (!['metrics-a', 'metrics-b'].includes(config.provider) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(config.contractVersion)
        || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 10000)
      throw fault('CONFIG_INVALID', 'Expected a configured provider, exact version and 100–10000 ms timeout.');
  };
  validateConfig(state.value);
  const topic = context.topic('compose/run');
  const waiting = new Map();
  // requestTo exposes the real acceptance receipt even if the subsequent local
  // wait expires. A normal response subscription is enough; no new SDK frame is needed.
  async function roundTrip(activeBridge, target, calledTopic, body, timeoutMs, receipt) {
    const correlation = randomUUID();
    let resolveResponse, rejectResponse, timer;
    const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    response.catch(() => {});
    const pending = { target, receipt, early: null, resolve: resolveResponse, reject: rejectResponse };
    waiting.set(correlation, pending);
    try {
      receipt.request = await activeBridge.requestTo(target, calledTopic, body, { correlation, timeoutMs: 2500 });
      receipt.requestSeq = receipt.request.seq;
      if (pending.early?.requestSeq === receipt.request.seq) resolveResponse(pending.early);
      timer = setTimeout(() => rejectResponse(new Error('local response wait expired')), timeoutMs);
      receipt.response = await response; receipt.responseSeq = receipt.response.seq;
      return receipt.response.body;
    } finally { clearTimeout(timer); waiting.delete(correlation); }
  }
  context.defer(() => { for (const pending of waiting.values()) pending.reject(new Error('composer stopped')); waiting.clear(); });
  const bridge = await context.openBridge('main', { channels: [channel(topic, { subscribe: true }),
    ...['catalog/query', 'source/read', 'text/statistics', 'output/commit'].map(suffix => channel(context.topic(suffix)))],
    filters: [topic], operations: ['request'], onDelivery: async (message, activeBridge) => {
      const config = state.value, receipts = [];
      const invocationId = message.body?.invocationId ?? randomUUID();
      let selection = null, output = null, sinkResult = null;
      const result = (ok, status, error) => ({ ok, kind: 'demo.capability-composition', status,
        config, invocationId, selection, ...(output ? { output } : {}), receipts,
        ...(sinkResult ? { sink: sinkResult } : {}), ...(error ? { error: { code: error.code ?? 'COMPOSITION_FAILED', message: error.message, retryable: false } } : {}) });
      async function call(stage, target, suffix, body, timeoutMs = 2500) {
        const receipt = { stage, requestSeq: null, responseSeq: null, request: null, response: null };
        receipts.push(receipt);
        try {
          return await roundTrip(activeBridge, target, context.topic(suffix), body, timeoutMs, receipt);
        } catch (error) {
          receipt.error = error.message;
          // An explicit Hub rejection differs from losing the receipt of a sent
          // request. The latter cannot prove that the request was not accepted.
          if (!receipt.response && !error.code) {
            const code = receipt.request ? `${stage.toUpperCase()}_TIMEOUT` : `${stage.toUpperCase()}_ACCEPTANCE_UNKNOWN`;
            throw Object.assign(fault(code, receipt.request
              ? 'The accepted request has no response within the local wait. Execution is unknown; it was not cancelled or retried.'
              : 'No acceptance receipt was obtained. The sent request may have been accepted; it was not retried.'), { uncertain: true });
          }
          throw error;
        }
      }
      try {
        if (message.fromPrincipal !== context.target('explorer').principal) throw fault('PERMISSION_DENIED', 'Only the configured explorer can operate this composer.');
        const body = message.body;
        if (!object(body) || !['configure', 'run'].includes(body.command)) throw fault('INPUT_INVALID', 'Expected configure or run.');
        if (body.command === 'configure') {
          const allowed = new Set(['command', 'provider', 'contractVersion', 'timeoutMs']);
          if (Object.keys(body).some(name => !allowed.has(name))) throw fault('CONFIG_INVALID', 'Unknown configuration option.');
          const next = { ...config };
          for (const field of ['provider', 'contractVersion', 'timeoutMs']) if (body[field] !== undefined) next[field] = body[field];
          validateConfig(next); next.revision++;
          await state.save(next);
          await activeBridge.respond(message, { ok: true, kind: 'demo.capability-configuration', config: next, revision: next.revision }); return;
        }
        if (!key(invocationId)) throw fault('INPUT_INVALID', 'invocationId must be a bounded stable key.');
        const catalog = await call('discovery', context.target('directory'), 'catalog/query', { capability: CONTRACT.id });
        if (catalog?.ok !== true || catalog.kind !== 'demo.capability-directory' || !Array.isArray(catalog.entries)) throw fault('CATALOG_FAILED', 'The configured catalog did not return capability entries.');
        const entry = catalog.entries.find(item => item.module?.id === config.provider);
        if (!entry) throw fault('PROVIDER_UNAVAILABLE', 'The configured provider has not registered with the directory.');
        if (entry.state !== 'lease-valid' || entry.expiresAt <= Date.now()) throw fault('LEASE_EXPIRED', 'The external directory lease expired. This is not proof that the process is offline.');
        const capability = entry.capabilities.find(item => item.id === CONTRACT.id);
        if (!capability || capability.contract?.id !== CONTRACT.id || capability.contract.version !== config.contractVersion
            || config.contractVersion !== CONTRACT.version || capability.semantics !== 'utf8-exact-unicode-v1'
            || capability.effects !== 'read-only' || canonical(capability.permissions) !== canonical(['text.read'])
            || canonical(capability.inputSchema) !== canonical(schema.inputSchema) || canonical(capability.outputSchema) !== canonical(schema.outputSchema))
          throw fault('CONTRACT_MISMATCH', 'Contract id, exact version, schema and declared semantics must match the consumer agreement.');
        if (entry.principal !== context.target(config.provider).principal || typeof entry.session !== 'string'
            || capability.topic !== context.topic('text/statistics')) throw fault('PROVIDER_ADDRESS_MISMATCH', 'The selected module must use its configured principal and declared topic.');
        selection = { module: entry.module, principal: entry.principal, session: entry.session, capability, catalogEpoch: catalog.epoch };
        const original = await call('source', context.target('source'), 'source/read', { command: 'read' });
        if (original?.ok !== true || !validText(original.text)) throw fault('SOURCE_INVALID', 'The source must return agreed Unicode text.');
        const processed = await call('processor', { principal: entry.principal, session: entry.session }, 'text/statistics',
          { contract: CONTRACT, invocationId, text: original.text }, config.timeoutMs);
        if (!validResult(processed, invocationId, config.provider))
          throw fault('RESULT_INVALID', 'The provider response must match the agreed result envelope.');
        if (!processed.ok) throw fault(processed.error.code, processed.error.message);
        output = processed.output;
        sinkResult = await call('output', context.target('output'), 'output/commit', {
          invocationId, contract: CONTRACT, output, processor: { module: entry.module, principal: entry.principal, session: entry.session },
        });
        if (sinkResult?.ok !== true || sinkResult.status !== 'completed')
          throw fault(sinkResult?.error?.code ?? 'OUTPUT_FAILED', sinkResult?.error?.message ?? 'The sink did not confirm a business commit.');
        await activeBridge.respond(message, result(true, 'completed'));
      } catch (error) { await activeBridge.respond(message, result(false, error.uncertain ? 'uncertain' : 'failed', error)); }
    } });
  bridge.on('delivery', message => {
    if (message.operation !== 'response') return;
    const pending = waiting.get(message.correlation);
    if (!pending || message.fromPrincipal !== pending.target.principal
        || (pending.target.session && message.senderSession !== pending.target.session)) return;
    if (!pending.receipt.request) pending.early = message;
    else if (message.requestSeq === pending.receipt.request.seq) pending.resolve(message);
  });
  await bridge.subscribe(['catalog/query', 'source/read', 'text/statistics', 'output/commit'].map(suffix => context.topic(suffix)),
    { operations: ['response'], from: 'now' });
  return bridge;
}

export async function startCompositionPeer(context) {
  if (context.profile.id !== 'capability-directory') throw new Error('This entry runs external capability composition programs.');
  const starters = { source, output: sink, composer };
  if (!Object.hasOwn(starters, context.peer.id)) throw new Error('Expected source, output or composer.');
  await starters[context.peer.id](context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPurposePeerMain(startCompositionPeer);
