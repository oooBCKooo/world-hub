import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { appendFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLock, importPackage, startInstance } from '../../../scripts/runtime/index.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { mapTopology } from '../../../tools/launcher/topology.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { environment, workspace, fixturePackage, samplePackage, json, save,
  requestJson, analyze, expectedText, filesBelow, until, alive } from './helpers.mjs';

const options = { timeout: 120000, concurrency: false };

async function launcher(app, root = app.root) {
  const server = await createLauncherServer({ root, port: 0, ...environment });
  app.cleanups.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, 'x-csrf-token': server.csrfToken };
  const request = async (path, value, extras = {}) => {
    const response = await fetch(new URL(path, server.url), { signal: AbortSignal.timeout(30000), redirect: 'error',
      method: value === undefined ? 'GET' : 'POST', headers: { ...headers,
        ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...extras.headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), ...extras });
    const body = await response.json(); return { response, body };
  };
  const call = async (path, value) => {
    const { response, body } = await request(path, value);
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
    assert.equal(body.ok, true); return body;
  };
  const rejected = async (path, value, extras) => {
    const { response, body } = await request(path, value, extras);
    assert.ok(response.status >= 400, `${path} unexpectedly succeeded: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false); assert.ok(body.error?.code); assert.ok(body.error?.message); return body;
  };
  const state = async id => {
    const instance = (await call(`/api/instances/${id}`)).instance;
    app.observe(instance.status); return instance;
  };
  const operate = async (id, kind, value = {}) => {
    const accepted = await call(`/api/instances/${id}/${kind}`, value);
    assert.ok(accepted.operationId);
    return until(async () => {
      const operation = (await call(`/api/operations/${accepted.operationId}`)).operation;
      if (id) await state(id);
      return operation.state === 'running' ? false : operation;
    }, { timeoutMs: 45000, label: `${kind} ${id}` });
  };
  const success = async (id, kind, value) => {
    const operation = await operate(id, kind, value);
    assert.equal(operation.state, 'succeeded', JSON.stringify(operation)); return operation;
  };
  const review = directory => call('/api/review', { directory });
  const importReviewed = async (directory, id) => {
    const reviewed = await review(directory);
    const imported = await call('/api/instances', { reviewId: reviewed.reviewId, instanceId: id });
    assert.equal(imported.instance.instanceId, id);
    const instanceReview = await call(`/api/instances/${id}/review`, {});
    assert.equal(instanceReview.review.digest, reviewed.review.digest);
    return { ...instanceReview, instance: imported.instance };
  };
  return { server, headers, request, call, rejected, state, operate, success, review, importReviewed };
}

async function rawJson(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.from(body);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(url, { method, headers: { ...headers,
      ...(payload ? { 'content-length': payload.length } : {}) }, timeout: 15000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveRequest({ status: response.statusCode, headers: response.headers, text,
          body: response.headers['content-type']?.includes('json') ? JSON.parse(text) : null });
      });
    });
    request.on('error', rejectRequest); request.on('timeout', () => request.destroy(new Error('HTTP timeout')));
    request.end(payload);
  });
}

test('LAUNCHER-01 local HTTP authorization, CSRF and cross-site checks precede any managed action', options, async t => {
  const app = await workspace(t), api = await launcher(app);
  const before = await api.call('/api/instances'); assert.deepEqual(before.instances, []);
  const denied = [];
  for (const [label, path, method, extra, body] of [
    ['missing bearer', '/api/instances', 'GET', {}, undefined],
    ['wrong bearer', '/api/instances', 'GET', { authorization: 'Bearer wrong' }, undefined],
    ['foreign Origin read', '/api/instances', 'GET', { ...api.headers, origin: 'http://external.invalid' }, undefined],
    ['cross-site read', '/api/instances', 'GET', { ...api.headers, 'sec-fetch-site': 'cross-site' }, undefined],
    ['cross-port same-site read', '/api/instances', 'GET', { ...api.headers, 'sec-fetch-site': 'same-site' }, undefined],
    ['DNS rebinding Host', '/api/instances', 'GET', { ...api.headers, host: `external.invalid:${new URL(api.server.url).port}` }, undefined],
    ['wrong localhost Host', '/api/instances', 'GET', { ...api.headers, host: `localhost:${new URL(api.server.url).port}` }, undefined],
    ['missing CSRF', '/api/review', 'POST', { authorization: api.headers.authorization, 'content-type': 'application/json' }, '{}'],
    ['wrong CSRF', '/api/review', 'POST', { ...api.headers, 'x-csrf-token': 'wrong', 'content-type': 'application/json' }, '{}'],
    ['foreign Origin mutation', '/api/review', 'POST', { ...api.headers, origin: 'http://external.invalid', 'content-type': 'application/json' }, '{}'],
    ['cross-site mutation', '/api/review', 'POST', { ...api.headers, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, '{}'],
    ['non-JSON mutation', '/api/review', 'POST', { ...api.headers, 'content-type': 'text/plain' }, '{}'],
    ['invalid JSON', '/api/review', 'POST', { ...api.headers, 'content-type': 'application/json' }, '{'],
    ['unknown review fields', '/api/review', 'POST', { ...api.headers, 'content-type': 'application/json' }, '{"directory":"x","shell":"execute"}'],
    ['oversize mutation', '/api/review', 'POST', { ...api.headers, 'content-type': 'application/json' }, JSON.stringify({ directory: 'x'.repeat(300000) })],
  ]) {
    const result = await rawJson(new URL(path, api.server.url), { method, headers: extra, body });
    assert.ok(result.status >= 400, `${label}: ${result.status} ${result.text.slice(0, 200)}`);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    denied.push({ label, status: result.status, code: result.body?.error?.code });
  }
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  app.record('protected-http-boundary-without-mutation', { denied });
});

test('LAUNCHER-02 one-use browser bootstrap issues distinct UI authorization and serves protected local assets', options, async t => {
  const app = await workspace(t), api = await launcher(app);
  const launchUrl = new URL(api.server.launchUrl), fragment = new URLSearchParams(launchUrl.hash.slice(1));
  const code = fragment.get('launch'); assert.ok(code, 'Launcher link must carry its one-use code in a fragment');
  const home = await rawJson(new URL('/', api.server.url));
  assert.equal(home.status, 200); assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(home.text.includes(api.server.token), false); assert.equal(home.text.includes(api.server.csrfToken), false);
  assert.equal(home.text.includes(code), false);
  const returned = new URL(api.server.url);
  for (const [key, value] of Object.entries({ instance: 'desk-one', runId: 'run-one', hubOrigin: 'http://127.0.0.1:32123',
    bridgeId: 'actual-bridge', session: 'actual-session' })) returned.searchParams.set(key, value);
  const returnPage = await rawJson(returned); assert.equal(returnPage.status, 200, returnPage.text);
  assert.match(returnPage.text, /app\.mjs/);
  const crossPortReturn = await rawJson(returned, { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(crossPortReturn.status, 200, crossPortReturn.text);
  for (const path of ['/?unknown=execute', '/?instance=one&instance=two', '/app.mjs?instance=one']) {
    assert.ok((await rawJson(new URL(path, api.server.url))).status >= 400, `Rejected navigation query: ${path}`);
  }
  for (const headers of [{ origin: 'http://external.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    const result = await rawJson(new URL('/api/session', api.server.url), { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code }) });
    assert.ok(result.status >= 400, 'Foreign site must not consume the bootstrap code');
  }
  for (const suffix of ['?unknown=x', '?code=x&code=y']) {
    const result = await rawJson(new URL('/api/session' + suffix, api.server.url), { method: 'POST',
      headers: { 'content-type': 'application/json', origin: api.server.url.replace(/\/$/, '') }, body: JSON.stringify({ code }) });
    assert.ok(result.status >= 400, 'Bootstrap rejects queries before consuming its one-use code');
  }
  const session = await requestJson(api.server.url, '/api/session', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.server.url.replace(/\/$/, '') }, body: JSON.stringify({ code }) });
  assert.equal(session.ok, true); assert.ok(session.token); assert.ok(session.csrfToken);
  assert.notEqual(session.token, api.server.token);
  const context = await requestJson(api.server.url, '/api/session', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(context.ok, true);
  const replay = await rawJson(new URL('/api/session', api.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.server.url.replace(/\/$/, '') }, body: JSON.stringify({ code }) });
  assert.ok(replay.status >= 400);
  app.record('browser-one-use-session', { bootstrapReplayStatus: replay.status, distinctUiToken: true });
});

test('LAUNCHER-03 review and import execute no module; current acceptance is required after code, permissions or environment changes', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await fixturePackage(app);
  const initialManifestPath = join(directory, 'modules/fixture/module.json'), initialManifest = await json(initialManifestPath);
  initialManifest.permissions.network = ['hub-loopback'];
  await save(initialManifestPath, initialManifest); await createLock(directory, environment);
  const reviewed = await api.review(directory);
  assert.match(reviewed.review.digest, /^[a-f0-9]{64}$/);
  assert.equal(reviewed.review.startsModules, false); assert.equal(reviewed.review.sandbox, false);
  assert.ok(reviewed.review.permissions.every(permission => permission.enforced === false));
  await assert.rejects(lstat(join(directory, 'modules/fixture/runtime-observed.json')), { code: 'ENOENT' });
  const imported = await api.call('/api/instances', { reviewId: reviewed.reviewId, instanceId: 'reviewed' });
  const privateDir = imported.instance.directory;
  const initialReview = await api.call('/api/instances/reviewed/review', {});
  assert.equal(initialReview.review.digest, reviewed.review.digest);
  assert.equal((await api.state('reviewed')).status.state, 'imported');
  await api.rejected('/api/instances/reviewed/start', { reviewId: initialReview.reviewId, accepted: false });
  await api.rejected('/api/instances/reviewed/start', { accepted: true });
  await assert.rejects(lstat(join(privateDir, 'programs')), { code: 'ENOENT' });
  await appendFile(join(directory, 'modules/fixture/program.mjs'), '\n// Source changed after review.\n');
  await createLock(directory, environment);
  await api.rejected('/api/instances', { reviewId: reviewed.reviewId, instanceId: 'stale-source' });
  assert.equal((await api.call('/api/instances')).instances.length, 1);
  const packageDir = join(privateDir, 'package'), manifestPath = join(packageDir, 'modules/fixture/module.json');
  const manifest = await json(manifestPath); manifest.permissions.network.push('loopback-listen');
  await save(manifestPath, manifest);
  await appendFile(join(packageDir, 'modules/fixture/program.mjs'), '\n// Changed executable package bytes.\n');
  await createLock(packageDir, environment);
  const changed = await api.call('/api/instances/reviewed/review', {});
  assert.notEqual(changed.review.digest, reviewed.review.digest);
  assert.match(JSON.stringify(changed.permissionDiff), /loopback-listen/, 'Newly declared permissions must be visible for review');
  await api.rejected('/api/instances/reviewed/start', { reviewId: initialReview.reviewId, accepted: true });
  const currentStart = await api.operate('reviewed', 'start', { reviewId: changed.reviewId, accepted: true });
  assert.equal(currentStart.state, 'failed', 'A changed imported package must require explicit reimport, even with its new review');
  assert.match(currentStart.error?.message ?? '', /review|changed|reimport|environment/i);
  await assert.rejects(lstat(join(privateDir, 'programs')), { code: 'ENOENT' });
  const missing = join(app.directory, 'unavailable-node');
  const unavailable = await api.rejected('/api/review', { directory, nodePath: missing });
  assert.match(unavailable.error.message, /missing|unusable|runtime|ENOENT|executable/i);
  app.record('digest-bound-approval-and-read-only-import', { originalDigest: reviewed.review.digest,
    changedDigest: changed.review.digest, oldReviewRejected: true, changedImportStart: currentStart.state, missingInterpreterBlocked: true });
});

test('LAUNCHER-04 HTTP sample executes JS to Python to JS, isolates two instances, restarts and rebuilds an exported pack', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await samplePackage(app);
  const missingPython = await api.rejected('/api/review', { directory, pythonPath: join(app.directory, 'missing-python') });
  assert.match(missingPython.error.message, /missing|unusable|runtime|ENOENT|executable/i);
  assert.ok(missingPython.requirements?.runtimes?.python); assert.ok(missingPython.guidance?.length);
  const lockPath = join(directory, 'pack.lock'), validLock = await json(lockPath), incompatibleLock = structuredClone(validLock);
  incompatibleLock.runtimes.python.version = '0.0.1'; await save(lockPath, incompatibleLock);
  const incompatible = await api.rejected('/api/review', { directory });
  assert.match(incompatible.error.message, /version mismatch/i);
  assert.equal((await json(lockPath)).runtimes.python.version, '0.0.1', 'Launcher does not automatically refresh an incompatible lock');
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  await save(lockPath, validLock);
  const firstReview = await api.importReviewed(directory, 'one'), secondReview = await api.importReviewed(directory, 'two');
  await api.rejected('/api/instances/two/start', { reviewId: firstReview.reviewId, accepted: true });
  await assert.rejects(lstat(join(secondReview.instance.directory, 'programs')), { code: 'ENOENT' });
  await api.success('one', 'start', { reviewId: firstReview.reviewId, accepted: true });
  await api.success('two', 'start', { reviewId: secondReview.reviewId, accepted: true });
  const one = await api.state('one'), two = await api.state('two');
  assert.equal(one.status.state, 'running'); assert.equal(two.status.state, 'running');
  assert.notEqual(one.directory, two.directory); assert.notEqual(one.status.runId, two.status.runId);
  assert.notEqual(one.status.hub.url, two.status.hub.url); assert.notEqual(one.links.entryUrl, two.links.entryUrl);
  const oneConfig = await json(join(one.directory, 'runs', one.status.runId, 'desk.json'));
  const twoConfig = await json(join(two.directory, 'runs', two.status.runId, 'desk.json'));
  assert.notEqual(oneConfig.stateDir, twoConfig.stateDir); assert.notEqual(oneConfig.bridges[0].token, twoConfig.bridges[0].token);
  const text = '第十六期 世界 🌍\r\nCafé\n';
  const resultOne = (await analyze(one.links.entryUrl, text)).result;
  const resultTwo = (await analyze(two.links.entryUrl, 'second instance')).result;
  assert.deepEqual(resultOne.output, expectedText(text)); assert.deepEqual(resultTwo.output, expectedText('second instance'));
  assert.equal(resultOne.receipts.length, 3);
  for (const receipt of resultOne.receipts) { assert.ok(receipt.fromPrincipal); assert.ok(receipt.senderSession); assert.ok(receipt.responseSeq > receipt.requestSeq); }
  const topology = (await api.call(`/api/instances/one/topology?runId=${one.status.runId}`)).topology;
  const actualHub = await requestJson(one.status.hub.url, '/status');
  assert.equal(topology.instanceId, 'one'); assert.equal(topology.runId, one.status.runId);
  assert.equal(topology.bridges.filter(bridge => bridge.ownership === 'managed').length, 3);
  for (const bridge of topology.bridges.filter(bridge => bridge.ownership === 'managed')) {
    const actual = actualHub.bridges.find(row => row.bridgeId === bridge.bridgeId && row.session === bridge.session);
    assert.ok(actual); assert.equal(bridge.principal, actual.principal); assert.equal(bridge.declaredId, actual.declaredId);
    const component = one.status.components.find(row => row.id === bridge.componentId);
    assert.ok(component); assert.equal(bridge.moduleId, component.module); assert.equal(bridge.pid, component.pid);
    assert.equal(bridge.process, 'running'); assert.equal(bridge.readiness, 'ready'); assert.equal(bridge.health.ready, true);
    const managedUrl = new URL(bridge.managementUrl ?? topology.hub.managementUrl);
    assert.equal(managedUrl.origin, one.status.hub.url);
  }
  const logs = (await api.call('/api/instances/one/logs')).logs;
  assert.ok(logs.logs.source); assert.ok(logs.logs.stats); assert.ok(logs.logs.desk);
  const publicText = JSON.stringify({ one, two, topology, logs });
  assert.equal(publicText.includes(oneConfig.bridges[0].token), false);
  app.record('initial-real-cross-language-and-current-mapping', { output: resultOne.output, distinctHubAndEntryPorts: true,
    receiptPrincipals: resultOne.receipts.map(receipt => receipt.fromPrincipal),
    mappings: topology.bridges.filter(row => row.ownership === 'managed').map(row => ({ componentId: row.componentId,
      moduleId: row.moduleId, pid: row.pid, principal: row.principal, declaredId: row.declaredId, bridgeId: row.bridgeId, session: row.session })) });
  const exported = join(app.directory, 'exported');
  const exportOp = await api.success('one', 'export', { destination: exported });
  assert.equal(exportOp.result.includesRuntimeState, false);
  const exportedFiles = await filesBelow(exported);
  assert.ok(exportedFiles.includes('pack.json')); assert.ok(exportedFiles.includes('pack.lock'));
  assert.ok(exportedFiles.every(file => !/(^|[\\/])(runs|programs|hub)([\\/]|$)|control\.json|status\.json|instance\.json/.test(file)));
  await api.success('one', 'stop');
  assert.equal((await api.state('one')).status.state, 'stopped');
  assert.equal((await api.state('two')).status.state, 'running');
  const restartReview = await api.call('/api/instances/one/review', {});
  await api.success('one', 'restart', { reviewId: restartReview.reviewId, accepted: true });
  const restarted = await api.state('one'); assert.notEqual(restarted.status.runId, one.status.runId);
  assert.deepEqual((await requestJson(restarted.links.entryUrl, '/state')).results, [resultOne]);
  assert.deepEqual((await requestJson(two.links.entryUrl, '/state')).results, [resultTwo]);
  await api.rejected(`/api/instances/one/topology?runId=${one.status.runId}`);
  const rebuiltApi = await launcher(app, join(app.directory, 'new-root'));
  const rebuiltReview = await rebuiltApi.importReviewed(exported, 'rebuilt');
  await rebuiltApi.success('rebuilt', 'start', { reviewId: rebuiltReview.reviewId, accepted: true });
  const rebuilt = await rebuiltApi.state('rebuilt');
  assert.deepEqual((await requestJson(rebuilt.links.entryUrl, '/state')).results, []);
  assert.deepEqual((await analyze(rebuilt.links.entryUrl, text)).result.output, expectedText(text));
  app.record('real-cross-language-api-and-clean-export', { output: resultOne.output,
    ownedRuns: [one.status.runId, two.status.runId, restarted.status.runId, rebuilt.status.runId],
    liveMappings: topology.bridges.filter(row => row.ownership === 'managed').length, exportedFiles: exportedFiles.length });
});

test('LAUNCHER-06 connected bridge and module readiness remain separate during startup timeout and early exit cleanup', options, async t => {
  const app = await workspace(t), api = await launcher(app);
  const directory = await fixturePackage(app, { mode: 'no-ready', startupTimeoutMs: 5000 });
  const review = await api.importReviewed(directory, 'not-ready');
  const accepted = await api.call('/api/instances/not-ready/start', { reviewId: review.reviewId, accepted: true });
  const during = await until(async () => {
    const instance = await api.state('not-ready');
    if (instance.status.state !== 'starting' || !instance.status.components?.[0]?.pid || !instance.status.hub?.url) return false;
    const topology = (await api.call(`/api/instances/not-ready/topology?runId=${instance.status.runId}`)).topology;
    return topology.bridges.some(row => row.ownership === 'managed') ? { instance, topology } : false;
  }, { label: 'connected but not module-ready' });
  const bridge = during.topology.bridges.find(row => row.ownership === 'managed');
  assert.ok(bridge.bridgeId); assert.ok(bridge.session); assert.equal(bridge.process, 'running'); assert.equal(bridge.readiness, 'not-ready');
  assert.equal(bridge.health.ready, false); assert.equal(during.instance.links.entryUrl ?? null, null);
  const terminal = await until(async () => {
    const operation = (await api.call(`/api/operations/${accepted.operationId}`)).operation;
    return operation.state === 'running' ? false : operation;
  }, { label: 'readiness timeout operation' });
  assert.equal(terminal.state, 'failed'); assert.match(terminal.error.message, /timeout|ready|wait/i);
  const failed = await api.state('not-ready'); assert.equal(failed.status.state, 'failed'); assert.ok(failed.status.stoppedAt);
  assert.equal(failed.status.cleanupIncomplete ?? false, false);
  for (const pid of app.trackedPids) assert.equal(alive(pid), false, `Timeout owned PID ${pid} retained`);
  const earlyPackage = await fixturePackage(app, { mode: 'early-exit' }), earlyReview = await api.importReviewed(earlyPackage, 'early');
  const earlyOp = await api.operate('early', 'start', { reviewId: earlyReview.reviewId, accepted: true });
  assert.equal(earlyOp.state, 'failed'); const early = await api.state('early');
  assert.equal(early.status.state, 'failed'); assert.ok(early.status.stoppedAt);
  app.record('connected-is-not-ready-and-failure-cleanup', { connectedSession: bridge.session,
    readinessAtConnection: bridge.readiness, healthAtConnection: bridge.health, failures: [terminal.error, earlyOp.error] });
});

test('LAUNCHER-07 the existing Hub console runs on demand in an independent process and external bridge ownership remains unknown', options, async t => {
  const app = await workspace(t), api = await launcher(app);
  const initial = (await api.call('/api/hubs')).hubs.find(hub => hub.id === 'default');
  assert.equal(initial.state, 'stopped'); assert.equal(initial.url, null);
  await assert.rejects(lstat(join(app.root, 'default-hub')), { code: 'ENOENT' });
  const defaultOperation = async kind => {
    const accepted = await api.call(`/api/hubs/default/${kind}`, {});
    return until(async () => {
      const operation = (await api.call(`/api/operations/${accepted.operationId}`)).operation;
      return operation.state === 'running' ? false : operation;
    }, { label: `default Hub ${kind}` });
  };
  assert.equal((await defaultOperation('start')).state, 'succeeded');
  const hub = (await api.call('/api/hubs')).hubs.find(row => row.id === 'default');
  assert.equal(hub.state, 'running'); assert.equal(hub.managedBy, 'launcher'); assert.equal(hub.ownership, 'external');
  const child = api.server.manager.hub; assert.ok(child.pid); assert.notEqual(child.pid, process.pid); app.trackedPids.add(child.pid);
  const page = await fetch(hub.managementUrl), html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /manual-console\.mjs/);
  const management = await requestJson(hub.url, '/manage/api/state');
  assert.ok(management.bridges.some(row => row.key === 'ui.manual'));
  const external = new Bridge({ url: hub.url.replace('http:', 'ws:') + '/bridge', bridgeId: 'runtime.fixture.main', credential: 'ui.manual' });
  external.on('error', () => {}); app.cleanups.push(() => external.close('launcher acceptance cleanup'));
  await external.connect();
  const raw = await requestJson(hub.url, '/status');
  const connection = raw.bridges.find(row => row.declaredId === 'runtime.fixture.main');
  assert.ok(connection); assert.equal(connection.principal, 'ui.manual'); assert.ok(connection.bridgeId); assert.ok(connection.session);
  const mapped = mapTopology({ instanceId: 'default', status: { runId: 'external-hub', state: 'running', hub: { url: hub.url }, components: [] },
    snapshot: raw, launcherUrl: api.server.url });
  const unknown = mapped.bridges.find(row => row.bridgeId === connection.bridgeId && row.session === connection.session);
  assert.equal(unknown.ownership, 'external'); assert.equal(unknown.process, 'unknown'); assert.equal(unknown.pid, undefined);
  await external.close('test complete');
  assert.equal((await defaultOperation('stop')).state, 'succeeded'); assert.equal(alive(child.pid), false);
  assert.equal((await api.call('/api/hubs')).hubs.find(row => row.id === 'default').state, 'stopped');
  assert.deepEqual((await api.call('/api/instances')).instances, []);
  app.record('on-demand-independent-default-hub', { pid: child.pid, actualExternalBridge: connection.bridgeId,
    actualExternalSession: connection.session, ownership: unknown.ownership, stopped: true });
});

test('LAUNCHER-08 stopping startup and an immediately queued default Hub leaves no owned process running', options, async t => {
  const app = await workspace(t), api = await launcher(app);
  const directory = await fixturePackage(app, { mode: 'no-ready', startupTimeoutMs: 12000 });
  const reviewed = await api.importReviewed(directory, 'cancel-start');
  const started = await api.call('/api/instances/cancel-start/start', { reviewId: reviewed.reviewId, accepted: true });
  const starting = await until(async () => {
    const instance = await api.state('cancel-start');
    return instance.status.state === 'starting' && instance.status.components?.some(row => row.pid) ? instance : false;
  }, { label: 'actual startup-owned module process' });
  const stopped = await api.success('cancel-start', 'stop');
  assert.equal(stopped.result.runId, starting.status.runId); assert.ok(stopped.result.stoppedAt);
  assert.equal(stopped.result.cleanupIncomplete ?? false, false);
  const startOperation = (await api.call(`/api/operations/${started.operationId}`)).operation;
  assert.equal(startOperation.state, 'failed'); assert.match(startOperation.error.message, /abort|stopped/i);
  assert.equal((await api.state('cancel-start')).status.state, 'stopped');
  for (const pid of app.trackedPids) assert.equal(alive(pid), false);
  const defaultStarted = await api.call('/api/hubs/default/start', {});
  const defaultStopped = await api.call('/api/hubs/default/stop', {});
  const defaultStop = await until(async () => {
    const operation = (await api.call(`/api/operations/${defaultStopped.operationId}`)).operation;
    return operation.state === 'running' ? false : operation;
  }, { label: 'immediate default Hub stop' });
  assert.equal(defaultStop.state, 'succeeded', JSON.stringify(defaultStop));
  const defaultStart = (await api.call(`/api/operations/${defaultStarted.operationId}`)).operation;
  assert.ok(['succeeded', 'failed'].includes(defaultStart.state), JSON.stringify(defaultStart));
  const child = api.server.manager.hub;
  if (child?.pid) { app.trackedPids.add(child.pid); assert.equal(alive(child.pid), false); }
  assert.equal((await api.call('/api/hubs')).hubs.find(row => row.id === 'default').state, 'stopped');
  app.record('startup-cancellation-and-queued-hub-stop', { cancelledRun: starting.status.runId,
    startupOperation: startOperation.state, defaultStartOperation: defaultStart.state, defaultStopOperation: defaultStop.state });
});

test('LAUNCHER-09 concurrent imports preserve both records and reject a duplicate without overwriting registry data', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await fixturePackage(app);
  const reviewed = await api.review(directory);
  const importOne = instanceId => api.request('/api/instances', { reviewId: reviewed.reviewId, instanceId });
  const separate = await Promise.all([importOne('first'), importOne('second')]);
  for (const { response, body } of separate) { assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true); }
  const duplicate = await Promise.all([importOne('same'), importOne('same')]);
  assert.equal(duplicate.filter(result => result.response.ok).length, 1);
  assert.equal(duplicate.filter(result => !result.response.ok).length, 1);
  const ids = ['first', 'same', 'second'];
  assert.deepEqual((await api.call('/api/instances')).instances.map(row => row.instanceId).sort(), ids);
  assert.deepEqual((await json(join(app.root, 'launcher-instances.json'))).instances.map(row => row.instanceId).sort(), ids);
  for (const id of ids) {
    const instance = await api.state(id); assert.equal(instance.status.state, 'imported');
    await assert.rejects(lstat(join(instance.directory, 'programs')), { code: 'ENOENT' });
  }
  await api.server.close();
  const reopened = await launcher(app);
  assert.deepEqual((await reopened.call('/api/instances')).instances.map(row => row.instanceId).sort(), ids);
  app.record('serialized-import-registry-reopens-with-all-records', { instances: ids, duplicateRejected: true, noModuleExecution: true });
});

test('LAUNCHER-10 a failed owned stop retains the local HTTP endpoint and root lock until a confirmed retry', options, async t => {
  const app = await workspace(t), api = await launcher(app), directory = await fixturePackage(app);
  const reviewed = await api.importReviewed(directory, 'retry-close');
  await api.success('retry-close', 'start', { reviewId: reviewed.reviewId, accepted: true });
  const running = await api.state('retry-close'), originalStop = api.server.manager.stopNow.bind(api.server.manager);
  let injected = false;
  api.server.manager.stopNow = async id => {
    if (!injected) { injected = true; throw Object.assign(new Error('Injected temporary owned stop failure'), { code: 'CLEANUP_INCOMPLETE' }); }
    return originalStop(id);
  };
  await assert.rejects(api.server.close(), /temporary owned stop failure/);
  assert.ok((await lstat(join(app.root, 'launcher-owner.lock'))).isFile());
  assert.equal((await api.state('retry-close')).status.state, 'running');
  assert.ok([...app.trackedPids].every(alive), 'Unconfirmed stop must leave the actual run observable for retry');
  api.server.manager.stopNow = originalStop;
  await api.server.close();
  const stopped = await json(join(running.directory, 'status.json'));
  assert.equal(stopped.runId, running.status.runId); assert.equal(stopped.state, 'stopped'); assert.ok(stopped.stoppedAt);
  assert.ok([...app.trackedPids].every(pid => !alive(pid)));
  await assert.rejects(lstat(join(app.root, 'launcher-owner.lock')), { code: 'ENOENT' });
  app.record('close-failure-retains-authority-and-retries-owned-stop', { runId: running.status.runId,
    endpointAndOwnerLockRetainedOnFailure: true, confirmedStoppedOnRetry: true });
});

test('LAUNCHER-11 actual readiness and initial health failures preserve only a private handle to their exact Runtime owner', options, async t => {
  const app = await workspace(t);
  for (const mode of ['no-ready', 'initial-health-unready']) {
    const directory = await fixturePackage(app, { mode, startupTimeoutMs: 2500 });
    const imported = await importPackage(directory, { root: app.root, instanceId: mode, ...environment });
    let failure;
    try { await startInstance({ root: app.root, instanceId: mode, trust: imported.digest, ...environment }); }
    catch (error) { failure = error; }
    assert.ok(failure, `${mode} must fail startup`);
    assert.ok(failure.runtimeSession); app.cleanups.push(() => failure.runtimeSession.close());
    assert.equal(Object.prototype.propertyIsEnumerable.call(failure, 'runtimeSession'), false);
    assert.equal(JSON.stringify(failure).includes('runtimeSession'), false);
    assert.equal(typeof failure.runtimeSession.close, 'function'); assert.equal(typeof failure.runtimeSession.status, 'function');
    const status = app.observe(await failure.runtimeSession.status());
    assert.equal(status.state, 'failed'); assert.ok(status.stoppedAt); assert.equal(status.cleanupIncomplete ?? false, false);
    assert.ok(status.components[0].pid); assert.ok(status.hub.pid);
    assert.equal((await failure.runtimeSession.closed).runId, status.runId);
    const again = await failure.runtimeSession.close(); assert.equal(again.runId, status.runId); assert.ok(again.stoppedAt);
    assert.ok([...app.trackedPids].every(pid => !alive(pid)));
    app.record('private-exact-owner-error-handle', { mode, runId: status.runId, error: failure.message,
      handleExcludedFromPublicJson: true, actualChildExitsConfirmed: true });
  }
});
