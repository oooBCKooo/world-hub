// Optional application-contract benchmark. Hub Core does not interpret this profile.
import { createHash, randomUUID } from 'node:crypto';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { validateModuleDirectory } from '../../scripts/runtime/developer.mjs';
import { readBounded } from '../../scripts/runtime/paths.mjs';
import { fileURLToPath } from 'node:url';

const contractPath = fileURLToPath(new URL('../../docs/modules/text-statistics.contract.json', import.meta.url));
const contract = { id: 'text.statistics', version: '1.0.0' };
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (v, names) => object(v) && equal(Object.keys(v).sort(), [...names].sort());
const check = (v, message) => { if (!v) throw new Error(message); };
export const expectedStatistics = text => ({ codePoints: [...text].length, lines: text.split('\n').length,
  utf8Bytes: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(text, 'utf8').digest('hex') });

export function checkStatisticsProtocol(exchange, { principal, session }) {
  const response = exchange.response;
  check(Number.isSafeInteger(exchange.request?.seq) && exchange.request.seq > 0, 'No Hub acceptance receipt');
  check(response?.operation === 'response' && response.requestSeq === exchange.request.seq
    && Number.isSafeInteger(response.seq) && response.seq > response.requestSeq, 'Response correlation mismatch');
  check(response.fromPrincipal === principal && (!session || response.senderSession === session), 'Response sender mismatch');
  return { requestSeq: exchange.request.seq, responseSeq: response.seq, senderMatches: true, requestCorrelationMatches: true };
}

export function checkStatisticsResponse(exchange, { principal, session, moduleId, invocationId, text, errorCode }) {
  const protocol = checkStatisticsProtocol(exchange, { principal, session });
  const body = exchange.response.body;
  check(body?.kind === 'demo.capability-result' && body.provider === moduleId && body.invocationId === invocationId
    && keys(body.contract, ['id', 'version']) && body.contract.id === contract.id && body.contract.version === contract.version, 'Business identity or contract mismatch');
  if (errorCode) {
    check(keys(body, ['ok', 'kind', 'contract', 'invocationId', 'status', 'provider', 'error']) && body.ok === false && body.status === 'failed', 'Invalid business failure envelope');
    check(keys(body.error, ['code', 'message', 'retryable']) && body.error.code === errorCode && typeof body.error.message === 'string' && body.error.retryable === false, 'Invalid business error');
  } else {
    check(keys(body, ['ok', 'kind', 'contract', 'invocationId', 'status', 'provider', 'executionId', 'output']) && body.ok === true && body.status === 'completed', 'Invalid business success envelope');
    check(typeof body.executionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.executionId), 'Invalid execution UUID');
    check(keys(body.output, ['codePoints', 'lines', 'utf8Bytes', 'sha256']), 'Invalid output shape');
    const expected = expectedStatistics(text);
    check(Object.entries(expected).every(([k, v]) => body.output[k] === v), 'Business output differs from the public exact-UTF8 semantics');
  }
  return { ...protocol, businessCode: errorCode ?? 'completed', ...(errorCode ? {} : { output: body.output }) };
}

/** Uses only public SDK traffic. It never starts or replaces a provider. */
export async function verifyTextStatistics(config) {
  check(object(config) && typeof config.moduleId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(config.moduleId), 'Configure a valid moduleId');
  check(object(config.target) && typeof config.target.principal === 'string' && typeof config.topic === 'string', 'Configure target principal and topic');
  check(object(config.caller) && typeof config.caller.bridgeId === 'string' && typeof config.endpoint === 'string', 'Configure endpoint and private caller wiring');
  const timeoutMs = config.timeoutMs ?? 5000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 15000, 'timeoutMs must be 100..15000');
  const machineBytes = await readBounded(contractPath), report = { format: 'world-hub.contract-verification/v1', profile: 'text.statistics/1.0.0',
    createdAt: new Date().toISOString(), contractSha256: createHash('sha256').update(machineBytes).digest('hex'),
    moduleId: config.moduleId, environment: { consumerNode: process.versions.node, platform: `${process.platform}-${process.arch}`, providerEnvironment: 'not-inspected' },
    scope: 'One optional exact text statistics application contract; no general contract, platform or long-term reliability claim.',
    humanThirdPartyAcceptance: false, executionsAuthorizedByCaller: true, startsPrograms: false, layers: {
      declaration: { status: 'not-supplied', businessProof: false }, protocol: { status: 'pending', cases: [] }, business: { status: 'pending', cases: [] } },
    lifecycle: { status: 'not-run', note: 'Timeout, disconnect and reconnect fault injection belongs to the separate controlled reference suite.' } };
  if (config.moduleDirectory) {
    const manifest = await validateModuleDirectory({ directory: config.moduleDirectory });
    const declared = manifest.ok && manifest.manifest.id === config.moduleId && manifest.manifest.provides.some(c => c.id === contract.id && c.version === contract.version);
    report.layers.declaration = { status: declared ? 'passed' : 'failed', contentDigest: manifest.contentDigest, businessProof: false,
      diagnostics: manifest.issues.map(i => ({ code: i.code, stage: i.stage })), declaredContractMatches: !!declared };
  }
  const bridges = [];
  const connect = async caller => {
    const bridge = new Bridge({ url: config.endpoint, ...caller, autoAck: true, reconnectMs: 0 });
    bridge.on('error', () => {}); bridges.push(bridge);
    const welcome = await bridge.connect();
    check(welcome.authenticated === true && (!caller.principal || welcome.principal === caller.principal), 'Caller authentication mismatch');
    return bridge;
  };
  try {
    const bridge = await connect(config.caller);
    const cases = [
      ['empty', ''], ['unicode-crlf-whitespace', ' 世界 🌍\r\n e\u0301 \n'], ['unicode-distinction', 'é\ne\u0301'],
      ['ascii-byte-boundary', 'a'.repeat(16384)], ['emoji-byte-boundary', '🌍'.repeat(4096)],
      ['over-byte-boundary', 'a'.repeat(16385), 'INPUT_INVALID'], ['unpaired-surrogate', '\ud800', 'INPUT_INVALID'],
      ['numeric-text-not-string', Number.MAX_SAFE_INTEGER + 1, 'INPUT_INVALID'],
      ['extra-input-field', 'text', 'INPUT_INVALID', { extra: true }], ['wrong-contract-version', 'text', 'CONTRACT_MISMATCH', { contract: { ...contract, version: '2.0.0' } }],
      ['invalid-invocation', 'text', 'INPUT_INVALID', { invocationId: 1 }], ['invocation-codepoint-boundary', '', null, { invocationId: '🌍'.repeat(256) }]
    ];
    const executionIds = new Set();
    const runCase = async ([name, text, errorCode, changes = {}], callerBridge = bridge) => {
      const body = { contract, invocationId: randomUUID(), text, ...changes };
      try {
        const exchange = await callerBridge.call(config.target, config.topic, body, { timeoutMs, receiptTimeoutMs: timeoutMs });
        checkStatisticsProtocol(exchange, config.target);
        report.layers.protocol.cases.push({ name, passed: true });
        const evidence = checkStatisticsResponse(exchange, { ...config.target, moduleId: config.moduleId,
          invocationId: typeof body.invocationId === 'string' && [...body.invocationId].length <= 256 ? body.invocationId : '', text, errorCode });
        if (!errorCode) { check(!executionIds.has(exchange.response.body.executionId), 'executionId reused across executions'); executionIds.add(exchange.response.body.executionId); }
        report.layers.business.cases.push({ name, passed: true, ...evidence });
      } catch (error) {
        if (!report.layers.protocol.cases.some(c => c.name === name)) report.layers.protocol.cases.push({ name, passed: false, code: error.code ?? 'NO_VALID_EXCHANGE' });
        report.layers.business.cases.push({ name, passed: false, code: error.code ?? 'RESULT_INVALID' });
      }
    };
    for (const c of cases) await runCase(c);
    if (config.deniedCaller) await runCase(['provider-authorization-denied', 'secret', 'PERMISSION_DENIED'], await connect(config.deniedCaller));
    else report.layers.business.cases.push({ name: 'provider-authorization-denied', status: 'not-run', reason: 'No separate deniedCaller wiring supplied' });
  } catch (error) { report.connectionError = { code: error.code ?? 'CONNECTION_FAILED' }; }
  finally { await Promise.all(bridges.map(bridge => bridge.close('contract verification finished'))); }
  for (const layer of ['protocol', 'business']) report.layers[layer].status = report.layers[layer].cases.length && report.layers[layer].cases.every(c => c.passed === true) && !report.connectionError ? 'passed' : 'incomplete-or-failed';
  report.passed = report.layers.declaration.status === 'passed' && report.layers.protocol.status === 'passed' && report.layers.business.status === 'passed';
  report.unverified = ['Human independent authors and novice users', 'Other business contracts and platforms', 'Long-running load and power-loss durability', 'External side-effect rollback'];
  return report;
}
