import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { GlobalExternalPrograms } from '../../../tools/launcher/global-external-programs.mjs';
import { workspace, environment, until } from './helpers.mjs';

async function scene(t) {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment }), bridges = [], owners = new Set();
  app.cleanups.push(async () => {
    for (const bridge of bridges) await bridge.close(); if (server.manager.hub) owners.add(server.manager.hub);
    await server.close(); for (const handle of owners) assert.ok(handle.exit && !handle.cleanupIncomplete, 'Every actual owned Hub handle must retire');
  });
  const call = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + server.token,
      'x-csrf-token': server.csrfToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const hub = async action => { const started = server.manager.defaultHub(action), operation = server.manager.operations.get(started.operationId); await operation.promise; assert.equal(operation.state, 'succeeded', JSON.stringify(operation.error)); if (server.manager.hub) owners.add(server.manager.hub); };
  const inventory = () => call('/api/programs/external');
  const preview = async input => { const current = await inventory(); return call('/api/programs/external/preview', { ...input, expectedRunId: current.runId, expectedRevision: current.revision }); };
  const apply = review => call('/api/programs/external/apply', { reviewId: review.reviewId, accepted: true });
  const admit = async programId => apply(await preview({ action: 'admit', programId, bridges: [{ slot: 'main', publish: ['external/input'], subscribe: ['external/output'] }] }));
  const connect = async connection => {
    const slot = connection.bridges[0], bridge = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId, credential: slot.credential, token: slot.token });
    bridge.on('error', () => {}); bridges.push(bridge); await bridge.connect(); return bridge;
  };
  return { app, server, call, hub, inventory, preview, apply, admit, connect };
}

test('GLOBAL-EXTERNAL a pending failed Stop cannot discard revocable grants of the same still-live owned Hub', async () => {
  let stopping = false;
  const handle = { launcherRunId: 'owned-run', url: 'http://127.0.0.1:12345', exit: null };
  const owner = new GlobalExternalPrograms({ getHub: () => handle, isStopping: () => stopping, managedPrincipals: () => new Set() });
  owner.management = async () => ({ bridges: [{ key: 'external.retained', allow: { publish: [], subscribe: [] }, instances: [] }] });
  await owner.inventory(); owner.records.set('retained', { programId: 'retained', principal: 'external.retained' });
  assert.equal((await owner.inventory()).programs.length, 1);
  stopping = true; assert.equal((await owner.inventory()).observation, 'unavailable');
  assert.equal(owner.records.size, 1, 'Unconfirmed Stop is not a new run and must retain its revocation record');
  await assert.rejects(owner.preview({ action: 'revoke', programId: 'retained', expectedRunId: 'owned-run', expectedRevision: 0 }), { code: 'GLOBAL_EXTERNAL_STOPPING' });
  stopping = false; assert.equal((await owner.inventory()).programs.length, 1);
  const review = await owner.preview({ action: 'revoke', programId: 'retained', expectedRunId: 'owned-run', expectedRevision: 0 }); assert.equal(review.review.program.programId, 'retained');
  handle.exit = { code: 0 }; assert.equal((await owner.inventory()).runId, null); assert.equal(owner.records.size, 0);
});

test('GLOBAL-EXTERNAL issues explicit run-scoped grants once, observes real sessions without secrets/PIDs and revokes only communications', { timeout: 30000 }, async t => {
  const app = await scene(t); assert.equal((await app.inventory()).observation, 'unavailable'); await app.hub('start');
  const before = await app.inventory(), issued = await app.admit('outside'), slot = issued.connection.bridges[0];
  const bridge = await app.connect(issued.connection); await bridge.registerChannels([{ name: 'external/input', publish: true }, { name: 'external/output', subscribe: true }]);
  await assert.rejects(bridge.registerChannels([{ name: 'forbidden/topic', publish: true }]));
  const observed = await until(async () => { const value = await app.inventory(); return value.programs[0]?.connections.length && value; });
  const row = observed.programs[0], session = row.connections[0];
  assert.equal(row.process, 'unmanaged'); assert.equal(row.ownership, 'external'); assert.equal(row.contractsVerified, false);
  assert.equal(session.authenticated, true); assert.ok(session.connectionId); assert.ok(session.since); assert.ok(session.remoteAddress); assert.equal(session.pid, undefined);
  assert.deepEqual(row.effectiveAllow, { publish: ['external/input'], subscribe: ['external/output'] }); assert.equal(session.channels.length, 2);
  const topology = await app.call('/api/programs/topology'); assert.equal(topology.bridges[0].pid, undefined); assert.ok(topology.bridges[0].since); assert.equal(topology.bridges[0].channels.length, 2);
  for (const value of [observed, topology, await app.call('/api/operations')]) assert.ok(!JSON.stringify(value).includes(slot.token));
  const config = await readFile(join(app.app.root, 'default-hub/hub.json'), 'utf8'); assert.ok(!config.includes(slot.token)); assert.ok(!config.includes('external.outside'));
  const revoke = await app.preview({ action: 'revoke', programId: 'outside' });
  await app.call('/api/programs/external/apply', { reviewId: revoke.reviewId, accepted: false }, 409);
  await app.apply(revoke); await until(() => !bridge.connected);
  assert.equal((await app.inventory()).programs.length, 0); assert.equal(app.server.manager.hub.exit, null);
  await app.call('/api/programs/external/apply', { reviewId: revoke.reviewId, accepted: true }, 409);
  assert.equal(issued.runId, before.runId); app.app.record('run-scoped-external-grants', { verifiedExactAcl: true, secretsInInventory: false, externalProcessOwned: false, oneUseReceipt: true });
});

test('GLOBAL-EXTERNAL exact disconnect cannot cross principals, retains grants and rejects stale revisions and runs', { timeout: 30000 }, async t => {
  const app = await scene(t); await app.hub('start');
  const first = await app.admit('one'), firstBridge = await app.connect(first.connection);
  const second = await app.admit('two'), secondBridge = await app.connect(second.connection);
  const inventory = await app.inventory(), one = inventory.programs.find(row => row.programId === 'one').connections[0], two = inventory.programs.find(row => row.programId === 'two').connections[0];
  await app.call('/api/programs/external/preview', { action: 'disconnect', principal: one.principal, connectionIds: [two.connectionId], expectedRunId: inventory.runId, expectedRevision: inventory.revision }, 409);
  const disconnect = await app.preview({ action: 'disconnect', principal: one.principal, connectionIds: [one.connectionId] }); await app.apply(disconnect);
  await until(() => !firstBridge.connected); assert.equal(secondBridge.connected, true); assert.equal((await app.inventory()).programs.length, 2);
  const reconnected = await app.connect(first.connection); assert.equal(reconnected.connected, true, 'Disconnect does not revoke its grant');
  const staleRevision = await app.preview({ action: 'revoke', programId: 'one' }); await app.admit('third');
  const stale = await app.call('/api/programs/external/apply', { reviewId: staleRevision.reviewId, accepted: true }, 409); assert.match(stale.error.code, /REVIEW_REQUIRED|CHANGED/);
  const oldRun = await app.preview({ action: 'revoke', programId: 'two' }); const oldRunId = (await app.inventory()).runId;
  await app.hub('stop'); await app.hub('start');
  await app.call('/api/programs/external/apply', { reviewId: oldRun.reviewId, accepted: true }, 409);
  const fresh = await app.inventory(); assert.notEqual(fresh.runId, oldRunId); assert.equal(fresh.programs.length, 0);
  const denied = new Bridge({ url: app.server.manager.hub.url.replace('http:', 'ws:') + '/bridge', bridgeId: first.connection.bridges[0].bridgeId,
    credential: first.connection.principal, token: first.connection.bridges[0].token }); denied.on('error', () => {});
  try { await assert.rejects(denied.connect()); } finally { await denied.close(); }
});

test('GLOBAL-EXTERNAL rejects implicit wildcard/duplicate grants and cannot disconnect registered managed identities', { timeout: 30000 }, async t => {
  const app = await scene(t); await app.hub('start'); const current = await app.inventory();
  for (const bridges of [[{ slot: 'main', publish: ['#'], subscribe: [] }], [{ slot: 'main', publish: ['external/input','external/input'], subscribe: [] }]])
    await app.call('/api/programs/external/preview', { action: 'admit', programId: 'bad', bridges, expectedRunId: current.runId, expectedRevision: current.revision }, 409);
  const contract = { id: 'example.contract', version: '1.0.0' };
  await app.call('/api/programs/external/preview', { action: 'admit', programId: 'bad', bridges: [{ slot: 'main', publish: [], subscribe: [] }],
    provides: [contract, { version: '1.0.0', id: 'example.contract' }], expectedRunId: current.runId, expectedRevision: current.revision }, 409);
  app.server.manager.localPrograms.identities.set('owned', { principal: 'local.owned' });
  await app.call('/api/programs/external/preview', { action: 'disconnect', principal: 'local.owned', connectionIds: ['conn-no-such'], expectedRunId: current.runId, expectedRevision: current.revision }, 409);
  assert.equal((await app.inventory()).programs.length, 0);
});
