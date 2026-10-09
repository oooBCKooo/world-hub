import test from 'node:test';
import assert from 'node:assert/strict';
import { mapTopology } from '../../../tools/launcher/topology.mjs';
import { parseLauncherContext } from '../../../src/management/launcher-link.mjs';

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
  assert.equal(stale.hub.managementUrl, null);
});

test('LAUNCHER-TOPOLOGY-02 scoped real-session links roundtrip through the reused Hub management parser', () => {
  const launcherUrl = 'http://127.0.0.1:30300';
  const one = mapTopology({ instanceId: 'one', status, snapshot, launcherUrl });
  const two = mapTopology({ instanceId: 'two', status: { ...status, runId: 'run-two', hub: { url: 'http://127.0.0.1:30124' } }, snapshot, launcherUrl });
  for (const topology of [one, two]) {
    for (const bridge of topology.bridges) {
      const context = parseLauncherContext(bridge.managementUrl);
      assert.ok(context); assert.equal(context.instanceId, topology.instanceId); assert.equal(context.runId, topology.runId);
      assert.equal(context.hubOrigin, topology.hub.url); assert.equal(context.bridgeId, bridge.bridgeId); assert.equal(context.session, bridge.session);
    }
    assert.ok(parseLauncherContext(topology.hub.managementUrl));
    assert.equal(parseLauncherContext(topology.hub.workbenchUrl)?.workbench, true);
  }
  assert.notEqual(one.bridges[0].managementUrl, two.bridges[0].managementUrl);
});
