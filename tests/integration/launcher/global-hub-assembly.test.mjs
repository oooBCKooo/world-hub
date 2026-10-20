import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { inspectAuthoring, derivePackage } from '../../../scripts/runtime/authoring.mjs';
import { inspectPackage, importPackage } from '../../../scripts/runtime/package.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { deploymentTopics } from '../../../scripts/runtime/deployment.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { workspace, environment, ROOT, filesBelow, expectedText, until } from './helpers.mjs';

const moduleDirectory = name => join(ROOT, 'examples/ecosystem-pack/modules', name);
async function register(manager, programId, directory, configuration = {}) {
  const review = await manager.localPrograms.preview({ programId, directory, ...configuration });
  return manager.localPrograms.register({ reviewId: review.reviewId, accepted: true });
}
function api(server) {
  return async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(60000),
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
}

test('Global Hub source assembly preserves independent program occurrences and exact wiring, then derives and runs an independent cross-language pack', { timeout: 90000 }, async t => {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close());
  const call = api(server), manager = server.manager;
  const sourceTopics = { source: 'assembly/private/read', context: 'assembly/source/unused', published: 'assembly/source/extra-output' };
  const otherTopics = { source: 'assembly/private/read', context: 'assembly/other/unused', published: 'assembly/other/extra-output' };
  // The selected ACL differs from deployment defaults in length and order.
  const grants = { main: { publish: ['published', 'source'], subscribe: ['source'] } };
  await register(manager, 'source-original', moduleDirectory('source'), { topics: sourceTopics, bridges: grants, settings: { text: 'Original global Hub defaults' } });
  await register(manager, 'source-alternate', moduleDirectory('source'), { topics: otherTopics, bridges: grants, settings: { text: 'Alternate source defaults' } });
  await register(manager, 'statistician', moduleDirectory('stats'), { topics: { stats: 'assembly/private/statistics' } });
  await register(manager, 'browser', moduleDirectory('desk'), { topics: { source: sourceTopics.source, stats: 'assembly/private/statistics' },
    bindings: [{ providerId: 'source-original', contract: { id: 'text.read', version: '1.0.0' } },
      { providerId: 'statistician', contract: { id: 'text.statistics', version: '1.0.0' } }] });
  await manager.programStartupPlanSave({ plan: { members: [...manager.localPrograms.records.keys()].map(programId => ({ programId, enabled: true,
    after: programId === 'browser' ? ['source-original','source-alternate','statistician'] : [] })), onFailure: 'continue-independent' },
    expectedRevision: manager.localPrograms.getStartupPlan().revision });
  const registry = await readFile(join(app.root, 'local-programs/registry.json'));
  const identities = await Promise.all([...manager.localPrograms.records.keys()].map(id => readFile(manager.localPrograms.path(id, 'identity.json'))));
  const snapshot = await call('/api/programs/assembly', { entry: 'browser' });
  assert.equal(snapshot.composition.lineage, undefined);
  assert.equal(snapshot.pack.lineage, undefined, 'A registered global source version makes no self-created or publisher provenance claim');
  assert.equal(snapshot.startsModules, false); assert.equal(snapshot.altersPrograms, false);
  assert.equal(snapshot.includesPrivateState, false); assert.equal(snapshot.includesExternalBridges, false);
  assert.equal(snapshot.scope, 'managed-source-only'); assert.equal(snapshot.source, 'launcher.default');
  assert.deepEqual(snapshot.pack.components.map(component => component.id), ['source-original', 'source-alternate', 'statistician', 'browser']);
  assert.deepEqual(snapshot.pack.entry, { component: 'browser' });
  assert.deepEqual(snapshot.pack.bindings.map(binding => [binding.from, binding.to]), [['source-original', 'browser'], ['statistician', 'browser']]);
  assert.equal(manager.hub, null, 'Source assembly must not start the shared Hub or any program');
  assert.equal(manager.localPrograms.handles.size, 0);
  const authoring = await inspectAuthoring(snapshot.directory, environment);
  assert.equal(authoring.review.lock.format, 'world-hub.pack-lock/v2');
  assert.equal(authoring.modules.length, 3, 'Two instances of one exact source share one source tree');
  for (const [id, topics] of [['source-original', sourceTopics], ['source-alternate', otherTopics]]) {
    const component = snapshot.pack.components.find(candidate => candidate.id === id);
    assert.deepEqual(deploymentTopics(snapshot.pack, component, null), topics);
    assert.deepEqual(component.bridges.main.publish.map(key => snapshot.pack.topics[key]), [topics.published, topics.source]);
    assert.equal(component.bridges.main.publish.includes(component.topicAliases.context), false, 'Knowing an alias never grants access');
  }
  const files = await filesBelow(snapshot.directory);
  assert.ok(!files.some(file => /identity\.json|registry\.json|run\.json|logs\.json|[\\/]state[\\/]|node_modules/.test(file)));
  assert.deepEqual(await readFile(join(app.root, 'local-programs/registry.json')), registry);
  for (const [index, id] of [...manager.localPrograms.records.keys()].entries())
    assert.deepEqual(await readFile(manager.localPrograms.path(id, 'identity.json')), identities[index]);
  const pack = structuredClone(authoring.pack); pack.id = 'test.global-derived'; pack.title = 'A separately assembled program set';
  pack.bindings.find(binding => binding.contract.id === 'text.read').from = 'source-alternate';
  pack.components.find(component => component.id === 'source-alternate').settings.text = 'Public edited setting 🌍\r\n';
  const derived = await derivePackage(snapshot.directory, { ...environment, destination: join(app.directory, 'derived'), pack,
    expectedRevision: authoring.revision, redistributionAcknowledged: true });
  const installed = await importPackage(derived.directory, { root: app.root, instanceId: 'assembled-copy', ...environment });
  const session = await startInstance({ root: app.root, instanceId: 'assembled-copy', trust: installed.digest, ...environment });
  app.trackSession(session); app.cleanups.push(() => session.close());
  const text = 'Global Hub → Creator → independent pack 🌍\r\n';
  const response = await fetch(new URL('/analyze', session.ready.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(12000) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(result.result.output, expectedText(text)); assert.equal(result.result.receipts.length, 3);
  assert.deepEqual(await readFile(join(app.root, 'local-programs/registry.json')), registry);
  assert.equal(manager.hub, null); assert.equal(manager.localPrograms.handles.size, 0);
  app.record('managed-source-to-authoring-to-real-independent-pack', { programs: snapshot.programs, uniqueSources: authoring.modules.length,
    preservedAliasMaps: true, editedProvider: 'source-alternate', originalRegistrationsUnchanged: true, receipts: result.result.receipts.length });
});

test('Global Hub assembly rejects empty/oversized registries, changed installed sources and conflicting module content without exporting a partial selection', { timeout: 45000 }, async t => {
  const app = await workspace(t), manager = new LauncherManager({ root: app.root, ...environment });
  await manager.initialize(); app.cleanups.push(() => manager.close());
  await assert.rejects(manager.programAssembly(), { code: 'GLOBAL_ASSEMBLY_EMPTY' });
  await register(manager, 'first', moduleDirectory('source'));
  const source = manager.localPrograms.path('first', 'module/program.mjs'), bytes = await readFile(source);
  await writeFile(source, Buffer.concat([bytes, Buffer.from('\n// edited after registration\n')]));
  await assert.rejects(manager.programAssembly(), { code: 'LOCAL_INSTALLED_CODE_CHANGED' });
  await writeFile(source, bytes);
  const alternate = join(app.directory, 'alternate-source'); await cp(moduleDirectory('source'), alternate, { recursive: true });
  await writeFile(join(alternate, 'program.mjs'), Buffer.concat([bytes, Buffer.from('\n// distinct exact source\n')]));
  await register(manager, 'second', alternate);
  await assert.rejects(manager.programAssembly(), /one exact version\/content per module ID/);
  const first = manager.localPrograms.records.get('first');
  for (let index = 0; index < 31; index++) manager.localPrograms.records.set('extra-' + index, { ...first, programId: 'extra-' + index });
  await assert.rejects(manager.programAssembly(), { code: 'GLOBAL_ASSEMBLY_LIMIT' });
  await assert.rejects(access(join(app.root, 'compositions')), { code: 'ENOENT' });
});

test('Global Hub topology observes real external sessions without claiming their process and never packages those sessions', { timeout: 60000 }, async t => {
  const app = await workspace(t), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close()); const call = api(server), manager = server.manager;
  assert.equal((await call('/api/programs/topology')).observation, 'unavailable');
  await register(manager, 'owned-source', moduleDirectory('source'));
  const review = await manager.localPrograms.reviewStart('owned-source');
  await manager.localPrograms.start('owned-source', { reviewId: review.reviewId, accepted: true });
  const owned = manager.localPrograms.handles.get('owned-source'), hub = manager.hub;
  app.cleanups.unshift(() => { assert.ok(owned.exit && !owned.cleanupIncomplete); assert.ok(hub.exit && !hub.cleanupIncomplete); });
  const externalToken = 'x'.repeat(43);
  await manager.updateLocalCredentials({ credentials: { 'local.external': { token: externalToken, maxConnections: 4,
    allow: { publish: [], subscribe: [] } } }, annotations: {}, remove: [] });
  const external = new Bridge({ url: manager.hub.url.replace('http:', 'ws:') + '/bridge', credential: 'local.external',
    token: externalToken, bridgeId: `local.${hash('owned-source:main').slice(0, 24)}`, displayName: 'owned-source' });
  app.cleanups.push(() => external.close()); await external.connect();
  const topology = await until(async () => { const result = await call('/api/programs/topology'); return result.bridges.length === 2 ? result : null; });
  const managed = topology.bridges.find(bridge => bridge.ownership === 'managed'), foreign = topology.bridges.find(bridge => bridge.ownership === 'external');
  assert.equal(managed.componentId, 'owned-source'); assert.equal(managed.pid, owned.pid);
  assert.equal(foreign.principal, 'local.external'); assert.equal(foreign.process, 'unknown'); assert.equal(foreign.pid, undefined);
  assert.equal(foreign.componentId, undefined); assert.ok(foreign.managementApiUrl); assert.equal(foreign.authenticated, true);
  const identity = manager.localPrograms.identities.get('owned-source');
  assert.ok(!JSON.stringify(topology).includes(identity.token));
  const snapshot = await call('/api/programs/assembly', {});
  assert.deepEqual(snapshot.pack.components.map(component => component.id), ['owned-source']);
  assert.equal(manager.localPrograms.handles.get('owned-source'), owned); assert.equal(owned.exit, null);
  await inspectPackage(snapshot.directory, environment);
  await manager.localPrograms.stop('owned-source');
  const remaining = await call('/api/programs/topology'); assert.equal(remaining.bridges.length, 1);
  assert.equal(remaining.bridges[0].ownership, 'external'); assert.equal(external.connected, true, 'Assembly and stopping an owned program must not stop an external bridge');
  app.record('actual-external-session-separate-from-managed-source', { managed: managed.componentId, externalDeclaredId: foreign.declaredId,
    externalProcess: foreign.process, privateCredentialsReturned: false, sourceComponents: snapshot.pack.components.length });
});
