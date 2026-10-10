import { Bridge } from 'world-hub/bridge';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Authored from the three frozen public documents. No example business code is used.
const CONTRACT_DIGEST = 'ecab20cb65c6f257cd298c7f0f06b580c0444f7749b0a7a922105c4eaa01b047';
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : isObject(value)
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const equal = (a, b) => canonical(a) === canonical(b);
const exactKeys = (value, keys) => isObject(value) && equal(Object.keys(value).sort(), [...keys].sort());
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const failure = (code, message) => Object.assign(new Error(message), { code });
const safeCode = error => typeof error?.code === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(error.code)
  ? error.code : 'LOCAL_OPERATION_FAILED';

function pointCount(text, limit = Infinity) {
  let count = 0;
  for (const unused of text) {
    if (++count > limit) return count;
  }
  return count;
}

// This validator covers every validation keyword used by the frozen schemas.
// It is intentionally not advertised as a general JSON Schema implementation.
function matchesSchema(schema, value) {
  if (schema.oneOf && schema.oneOf.filter(branch => matchesSchema(branch, value)).length !== 1) return false;
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) return false;
  if (schema.type === 'object') {
    if (!isObject(value)) return false;
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && !matchesSchema(field, value[key])) return false;
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    const length = pointCount(value, schema.maxLength ?? Infinity);
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value)) return false;
    if (schema.format === 'uuid' && !UUID.test(value)) return false;
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  return true;
}

function statistics(text) {
  // A valid <= 16384-byte UTF-8 string cannot need more than 16384 UTF-16 units.
  if (text.length > 16384) throw failure('INPUT_INVALID', 'Text exceeds the UTF-8 byte limit.');
  let codePoints = 0;
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = text.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) throw failure('INPUT_INVALID', 'Text contains an unpaired UTF-16 surrogate.');
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw failure('INPUT_INVALID', 'Text contains an unpaired UTF-16 surrogate.');
    }
    codePoints++;
    if (unit === 0x0a) lines++;
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 16384) throw failure('INPUT_INVALID', 'Text exceeds the UTF-8 byte limit.');
  return { codePoints, lines, utf8Bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function validateWiring(value, configPath) {
  if (!isObject(value)) throw failure('CONFIG_INVALID', 'Configuration must be an object.');
  for (const key of ['bridgeId', 'principal', 'moduleId']) {
    if (typeof value[key] !== 'string' || !IDENTIFIER.test(value[key])) throw failure('CONFIG_INVALID', 'An identity field is invalid.');
  }
  if (value.credential !== undefined && (typeof value.credential !== 'string' || !IDENTIFIER.test(value.credential))) throw failure('CONFIG_INVALID', 'Credential identifier is invalid.');
  if (typeof value.token !== 'string' || value.token.length === 0) throw failure('CONFIG_INVALID', 'A private token is required.');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw failure('CONFIG_INVALID', 'Endpoint must be a WebSocket URL.'); }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw failure('CONFIG_INVALID', 'Endpoint must be a WebSocket URL.');
  if (typeof value.moduleVersion !== 'string' || !VERSION.test(value.moduleVersion)) throw failure('CONFIG_INVALID', 'Module version is invalid.');
  if (!isObject(value.directory) || typeof value.directory.principal !== 'string' || !IDENTIFIER.test(value.directory.principal)) throw failure('CONFIG_INVALID', 'Directory principal is invalid.');
  const topicValid = topic => typeof topic === 'string' && topic.length >= 1 && topic.length <= 200 && !/[\s#+]/u.test(topic);
  if (!topicValid(value.businessTopic) || !topicValid(value.directory.registerTopic) || !topicValid(value.directory.queryTopic)) throw failure('CONFIG_INVALID', 'A topic is invalid.');
  if (!Array.isArray(value.allowedCallers) || value.allowedCallers.some(item => typeof item !== 'string' || !IDENTIFIER.test(item))) throw failure('CONFIG_INVALID', 'Allowed callers must be principal identifiers.');
  if (!Number.isSafeInteger(value.leaseMs) || value.leaseMs < 300 || value.leaseMs > 10000) throw failure('CONFIG_INVALID', 'Lease is outside the public directory bounds.');
  if (!Number.isSafeInteger(value.renewEveryMs) || value.renewEveryMs < 1 || value.renewEveryMs >= value.leaseMs) throw failure('CONFIG_INVALID', 'Renewal interval must be positive and shorter than the lease.');
  for (const key of ['contractPath', 'cursorFile']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) throw failure('CONFIG_INVALID', 'Contract and cursor paths are required.');
  }
  const wiring = { ...value, directory: { ...value.directory } };
  wiring.contractPath = resolve(dirname(configPath), value.contractPath);
  wiring.cursorFile = resolve(dirname(configPath), value.cursorFile);
  if (wiring.cursorFile.toLowerCase() === wiring.contractPath.toLowerCase() || wiring.cursorFile.toLowerCase() === configPath.toLowerCase()) throw failure('CONFIG_INVALID', 'Cursor file must be independent from configuration and contract.');
  const defaults = { startupTimeoutMs: 10000, registrationTimeoutMs: 1500, responseTimeoutMs: 1500, controlTimeoutMs: 2500, shutdownTimeoutMs: 5000, reconnectMs: 400 };
  for (const [key, fallback] of Object.entries(defaults)) {
    wiring[key] = value[key] ?? fallback;
    if (!Number.isSafeInteger(wiring[key]) || wiring[key] < 100 || wiring[key] > 60000) throw failure('CONFIG_INVALID', 'An optional timeout is outside 100-60000 milliseconds.');
  }
  return wiring;
}

async function load() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw failure('CLI_INVALID', 'Usage: node provider.mjs --config config.json');
  const configPath = resolve(process.argv[3]);
  const wiring = validateWiring(JSON.parse(await readFile(configPath, 'utf8')), configPath);
  const contract = JSON.parse(await readFile(wiring.contractPath, 'utf8'));
  const digest = createHash('sha256').update(canonical(contract)).digest('hex');
  if (digest !== CONTRACT_DIGEST) throw failure('PUBLIC_CONTRACT_MISMATCH', 'The supplied public contract differs from the frozen contract.');
  const manifest = {
    manifestVersion: 1,
    module: { id: wiring.moduleId, version: wiring.moduleVersion },
    capabilities: [{
      id: contract.contract.id, contract: contract.contract,
      inputSchema: contract.inputSchema, outputSchema: contract.outputSchema,
      semantics: contract.semantics, topic: wiring.businessTopic,
      effects: contract.effects, permissions: contract.permissions,
    }],
    leaseMs: wiring.leaseMs,
  };
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > 24000) throw failure('MANIFEST_INVALID', 'Manifest exceeds the public size bound.');
  await mkdir(dirname(wiring.cursorFile), { recursive: true });
  return { wiring, contract, manifest };
}

async function run({ wiring, contract, manifest }) {
  const bridge = new Bridge({
    url: wiring.endpoint, bridgeId: wiring.bridgeId, credential: wiring.credential,
    token: wiring.token, role: 'both', displayName: 'Independent text statistics provider',
    autoAck: true, reconnectMs: wiring.reconnectMs, cursorFile: wiring.cursorFile,
    subscribeTimeoutMs: wiring.controlTimeoutMs, maxPendingCalls: 4,
  });
  const callers = new Set(wiring.allowedCallers);
  const timers = new Set();
  const work = new Set();
  let stopping = false;
  let stopTask;
  let currentWelcome;
  let generation = 0;
  let renewalTimer;
  let startupTimer;
  let lifecycle = Promise.resolve();
  let resolveReady;
  let rejectReady;
  const firstReady = new Promise((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise; });
  // A stop before connect completes must not produce an unhandled latch rejection.
  void firstReady.catch(() => {});

  const diagnostic = (stage, error) => emit({ event: 'diagnostic', stage, code: safeCode(error) });
  const track = promise => {
    work.add(promise);
    promise.then(() => work.delete(promise), () => work.delete(promise));
    return promise;
  };
  const cancelTimer = timer => { if (timer) { clearTimeout(timer); timers.delete(timer); } };
  const later = (callback, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
    return timer;
  };
  const bounded = (promise, ms, code) => {
    let timer;
    const deadline = new Promise((unused, reject) => { timer = later(() => reject(failure(code, 'Local finite wait expired.')), ms); });
    return Promise.race([promise, deadline]).finally(() => cancelTimer(timer));
  };
  const current = gen => !stopping && generation === gen && currentWelcome !== undefined;
  const verifyWelcome = welcome => {
    if (welcome?.principal !== wiring.principal || welcome.authenticated !== true || !UUID.test(welcome.session ?? '') || !Array.isArray(welcome.features) || !welcome.features.includes('directed-v1')) throw failure('WELCOME_REJECTED', 'Authenticated welcome does not match deployment.');
  };

  function businessResult(message) {
    const body = message.body;
    const invocationId = typeof body?.invocationId === 'string' && pointCount(body.invocationId, 256) <= 256 ? body.invocationId : '';
    const reject = (code, text) => ({
      ok: false, kind: 'demo.capability-result', contract: { ...contract.contract }, invocationId,
      status: 'failed', provider: wiring.moduleId,
      error: { code, message: text, retryable: false },
    });
    if (!callers.has(message.fromPrincipal)) return reject('PERMISSION_DENIED', 'The provider has not authorized this caller.');
    if (body?.contract?.id !== contract.contract.id || body?.contract?.version !== contract.contract.version) return reject('CONTRACT_MISMATCH', 'The request does not specify the supported exact contract.');
    if (!matchesSchema(contract.inputSchema, body)) return reject('INPUT_INVALID', 'Input does not match the complete public input schema.');
    let output;
    try { output = statistics(body.text); }
    catch (error) { return reject('INPUT_INVALID', error.message); }
    return {
      ok: true, kind: 'demo.capability-result', contract: { ...contract.contract }, invocationId: body.invocationId,
      status: 'completed', provider: wiring.moduleId, executionId: randomUUID(), output,
    };
  }

  function verifyRegistration(exchange, welcome) {
    const { request, response } = exchange ?? {};
    const body = response?.body;
    const entry = body?.entry;
    if (!Number.isSafeInteger(request?.seq) || request.seq < 1 || response?.requestSeq !== request.seq || response?.operation !== 'response' || response?.topic !== wiring.directory.registerTopic || response?.fromPrincipal !== wiring.directory.principal || !UUID.test(response?.senderSession ?? '')) throw failure('REGISTRATION_UNTRUSTED', 'Registration response does not match trusted routing.');
    if (!exactKeys(body, ['ok', 'kind', 'epoch', 'entry']) || body.ok !== true || body.kind !== 'demo.capability-registration' || !UUID.test(body.epoch)) throw failure('REGISTRATION_NOT_CONFIRMED', 'Directory did not return the complete successful registration form.');
    if (!exactKeys(entry, ['module', 'capabilities', 'principal', 'session', 'registeredAt', 'expiresAt', 'state']) || !equal(entry.module, manifest.module) || !equal(entry.capabilities, manifest.capabilities) || entry.principal !== wiring.principal || entry.session !== welcome.session || entry.state !== 'lease-valid' || !Number.isSafeInteger(entry.registeredAt) || entry.registeredAt < 0 || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt !== entry.registeredAt + wiring.leaseMs) throw failure('REGISTRATION_ENTRY_INVALID', 'Directory entry does not match the complete advertised provider and lease.');
    return body;
  }

  async function register(gen) {
    if (!current(gen)) return;
    const welcome = currentWelcome;
    const exchange = await bridge.call({ principal: wiring.directory.principal }, wiring.directory.registerTopic, manifest, {
      timeoutMs: wiring.registrationTimeoutMs, receiptTimeoutMs: wiring.registrationTimeoutMs,
    });
    if (!current(gen)) return;
    const registration = verifyRegistration(exchange, welcome);
    emit({ event: 'ready', principal: wiring.principal, session: welcome.session, moduleId: wiring.moduleId,
      moduleVersion: wiring.moduleVersion, businessTopic: wiring.businessTopic, contract: contract.contract,
      directoryEpoch: registration.epoch, expiresAt: registration.entry.expiresAt, reconnect: welcome.reconnect === true });
    resolveReady();
  }

  function enqueue(task) {
    lifecycle = lifecycle.then(task).catch(error => { if (!stopping) diagnostic('lifecycle', error); });
    track(lifecycle);
  }

  function schedule(gen, needsSetup) {
    cancelTimer(renewalTimer);
    if (!current(gen)) return;
    renewalTimer = later(() => { enqueue(() => activate(gen, needsSetup)); }, wiring.renewEveryMs);
  }

  async function activate(gen, needsSetup) {
    if (!current(gen)) return;
    let setup = needsSetup;
    try {
      if (setup) {
        await bridge.registerChannels([
          { name: wiring.businessTopic, publish: true, subscribe: true },
          { name: wiring.directory.registerTopic, publish: true, subscribe: true },
        ], { timeoutMs: wiring.controlTimeoutMs });
        if (!current(gen)) return;
        await bridge.subscribe([wiring.businessTopic], { operations: ['request'], from: 'resume' });
        if (!current(gen)) return;
        setup = false;
      }
      await register(gen);
    } catch (error) {
      if (current(gen)) diagnostic(setup ? 'setup' : 'registration', error);
    } finally {
      if (current(gen)) schedule(gen, setup);
    }
  }

  async function stop(reason) {
    if (stopTask) return stopTask;
    stopping = true;
    generation++;
    currentWelcome = undefined;
    cancelTimer(renewalTimer);
    cancelTimer(startupTimer);
    rejectReady(failure('PROVIDER_STOPPING', 'Provider is stopping.'));
    stopTask = (async () => {
      try {
        await bounded(bridge.close(reason), wiring.shutdownTimeoutMs, 'CLOSE_TIMEOUT');
        await bounded(Promise.allSettled([...work]), wiring.shutdownTimeoutMs, 'DRAIN_TIMEOUT');
      } catch (error) { diagnostic('shutdown', error); process.exitCode = 1; }
      finally {
        for (const timer of [...timers]) cancelTimer(timer);
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('message', onMessage);
        if (process.connected) process.disconnect();
        emit({ event: 'stopped', principal: wiring.principal, moduleId: wiring.moduleId });
      }
    })();
    return stopTask;
  }
  const onSignal = () => { void stop('provider signal stop'); };
  const onMessage = message => { if (message?.type === 'stop') void stop('provider IPC stop'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('message', onMessage);
  bridge.on('error', error => diagnostic('bridge', error));
  bridge.on('denied', error => diagnostic('hub-denied', error));
  bridge.on('close', () => { currentWelcome = undefined; generation++; cancelTimer(renewalTimer); });
  bridge.on('open', welcome => {
    if (stopping) return;
    try { verifyWelcome(welcome); }
    catch (error) { diagnostic('welcome', error); process.exitCode = 1; void stop('welcome rejected'); return; }
    currentWelcome = welcome;
    const gen = ++generation;
    cancelTimer(renewalTimer);
    enqueue(() => activate(gen, true));
  });
  bridge.on('delivery', message => {
    if (message.operation !== 'request' || message.topic !== wiring.businessTopic) return;
    return track((async () => {
      if (stopping) throw failure('PROVIDER_STOPPING', 'Request was not consumed during shutdown.');
      const result = businessResult(message);
      if (!matchesSchema(contract.outputSchema, result)) throw failure('OUTPUT_INVALID', 'Generated result violated the public output schema.');
      try { await bridge.respond(message, result, { timeoutMs: wiring.responseTimeoutMs }); }
      catch (error) { if (!stopping) diagnostic('response-acceptance-unknown', error); throw error; }
    })());
  });

  startupTimer = later(() => {
    if (stopping) return;
    diagnostic('startup', failure('STARTUP_TIMEOUT', 'Startup finite deadline expired.'));
    process.exitCode = 1;
    void stop('startup timeout');
  }, wiring.startupTimeoutMs);
  try {
    const welcome = await bridge.connect();
    if (stopping) return;
    verifyWelcome(welcome);
    await firstReady;
    cancelTimer(startupTimer);
  } catch (error) {
    if (!stopping) { diagnostic('startup', error); process.exitCode = 1; }
    await stop('startup failed');
  }
}

try { await run(await load()); }
catch (error) { emit({ event: 'fatal', stage: 'configuration', code: safeCode(error) }); process.exitCode = 1; }
