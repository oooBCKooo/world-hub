import test from 'node:test';
import assert from 'node:assert/strict';
import { managementApiLink, mapTopology } from '../../../tools/launcher/topology.mjs';

const status = { runId: 'run-one', state: 'running', hub: { url: 'http://127.0.0.1:30123' },
  components: [{ id: 'same-name', module: 'test.fixture', pid: 123, process: 'running', principal: 'runtime.same-name',
    expectedBridges: ['runtime.same-name.main'], readiness: 'ready', health: { ready: true },
    bridges: [{ declaredId: 'runtime.same-name.main', bridgeId: 'actual-1', session: 'session-1', connected: true }] }] };
const snapshot = { bridges: [
  { principal: 'runtime.same-name', declaredId: 'runtime.same-name.main', bridgeId: 'actual-1', session: 'session-1' },
  { principal: 'foreign-principal', declaredId: 'runtime.same-name.main', bridgeId: 'foreign-1', session: 'foreign-session', displayName: 'same-name' },
  { principal: 'runtime.same-name', declaredId: 'foreign-slot', bridgeId: 'foreign-2', session: 'foreign-session-2', displayName: 'same-name' },
] };

test('LAUNCHER-05 exact topology identity leaves foreign, mismatched and historical bridges externally owned', () => {
  const topology = mapTopology({ instanceId: 'one', status, snapshot, launcherUrl: 'http://127.0.0.1:30300' });
  const managed = topology.bridges.filter(row => row.ownership === 'managed');
  assert.equal(managed.length, 1); assert.equal(managed[0].bridgeId, 'actual-1');
  assert.equal(managed[0].componentId, 'same-name'); assert.equal(managed[0].moduleId, 'test.fixture'); assert.equal(managed[0].pid, 123);
  const foreign = topology.bridges.filter(row => row.ownership === 'external'); assert.equal(foreign.length, 2);
  for (const row of foreign) {
    assert.equal(row.componentId, undefined); assert.equal(row.moduleId, undefined); assert.equal(row.pid, undefined);
    assert.equal(row.process, 'unknown'); assert.equal(row.readiness, 'unknown');
  }
  const stale = mapTopology({ instanceId: 'one', status: { ...status, observation: 'stale', supervisorUnavailable: true },
    snapshot, launcherUrl: 'http://127.0.0.1:30300' });
  assert.equal(stale.bridges.filter(row => row.ownership === 'managed').length, 0, 'A stale run cannot authorize current process ownership');
  assert.equal(stale.hub.managementApiUrl, null);
  assert.equal(stale.hub.statusUrl, null);
});

test('headless topology exposes real API endpoints while stable bridge and session identity stays in structured fields', () => {
  const launcherUrl = 'http://127.0.0.1:30300';
  const one = mapTopology({ instanceId: 'one', status, snapshot, launcherUrl });
  const two = mapTopology({ instanceId: 'two', status: { ...status, runId: 'run-two', hub: { url: 'http://127.0.0.1:30124' } }, snapshot, launcherUrl });
  for (const topology of [one, two]) {
    for (const bridge of topology.bridges) {
      const endpoint = new URL(bridge.managementApiUrl);
      assert.equal(endpoint.origin, topology.hub.url);
      assert.equal(endpoint.pathname, '/manage/api');
      assert.equal(endpoint.hash, '');
      assert.ok(bridge.bridgeId); assert.ok(bridge.session);
      assert.equal(Object.hasOwn(bridge, 'managementUrl'), false);
    }
    assert.equal(topology.hub.managementApiUrl, topology.hub.url + '/manage/api');
    assert.equal(topology.hub.statusUrl, topology.hub.url + '/status');
    assert.equal(Object.hasOwn(topology.hub, 'workbenchUrl'), false);
  }
  assert.notEqual(one.bridges[0].managementApiUrl, two.bridges[0].managementApiUrl);
  assert.equal(managementApiLink({ hubUrl: 'https://unrelated.example' }), null);
});
