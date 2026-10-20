import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { Hub } from '../../src/hub/lib/hub.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { attachWebSocketServer } from '../../src/hub/ws-server.mjs';
import { createManagementHttp } from '../../src/management/management-http.mjs';
import { publishArtifact, validateArtifactBytes } from '../../scripts/runtime/sources.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { sourceFilesDigest } from '../../scripts/runtime/resource-artifacts.mjs';
import { ordinaryPath } from '../../scripts/runtime/paths.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const rootDirectory = resolve('.artifacts/management-community-tests');
const contract = { id: 'community.echo', version: '1.0.0' };
const program = `import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {Bridge} from './bridge-kit.mjs';
const config=JSON.parse(await readFile(process.argv[3],'utf8')), connection=config.bridges[0];
const bridge=new Bridge({url:connection.endpoint,bridgeId:connection.bridgeId,credential:connection.credential,token:connection.token,autoAck:true});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
bridge.on('error',error=>emit({event:'diagnostic',code:error.code}));
bridge.on('delivery',message=>emit({event:'received',body:message.body}));
const input=createInterface({input:process.stdin});let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;await bridge.close();input.close();};
input.on('line',line=>{const value=JSON.parse(line);if(value.command==='health')emit({event:'module-health',id:value.id,ready:!stopped});if(value.command==='stop')void stop();});
input.on('close',()=>void stop());process.on('SIGTERM',()=>void stop());
await bridge.connect();await bridge.registerChannels([{name:config.topics.events,publish:true,subscribe:true}]);
await bridge.subscribe([config.topics.events],{from:0});await bridge.publishConfirmed(config.topics.events,{member:config.componentId});
emit({event:'module-ready'});
`;
async function setup(t) {
  await mkdir(rootDirectory, { recursive: true }); const root = await mkdtemp(join(rootDirectory, 'case-'));
  const config = normalizeConfig({ transport: { port: 0 }, acl: { allowUnlistedBridges: false, credentials: {}, bridges: {} }, log: { enabled: false, dir: join(root, 'log') }, blobs: { dir: join(root, 'blobs') }, management: { stateFile: join(root, 'management.json'), explicitStateFile: true } }, null);
  const hub = await Hub.create(config); let management;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/status') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(hub.snapshot())); return; }
    if (await management.handle(request, response, url)) return;
    response.writeHead(404); response.end();
  });
  const ws = attachWebSocketServer(server, { path: config.transport.path, maxPayload: 4 * 1024 * 1024 }); ws.on('connection', connection => hub.onConnection(connection));
  await new Promise(done => server.listen(0, '127.0.0.1', done)); config.transport.port = server.address().port;
  management = await createManagementHttp(hub, config); const base = `http://127.0.0.1:${config.transport.port}`;
  t.after(async () => { await management.modules.localPrograms.close(); ws.closeAll(1001, 'test complete'); await new Promise(done => server.close(done)); await hub.stop(); const actual = await ordinaryPath(root); assert.equal(dirname(actual), await ordinaryPath(rootDirectory)); assert.ok(actual.startsWith(join(rootDirectory, 'case-'))); await rm(actual, { recursive: true, force: false }); });
  const call = async (path, body) => { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-management-token': management.snapshot().csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) }); return { status: response.status, body: await response.json() }; };
  return { root, hub, management, owner: management.modules, call, base };
}
async function distribution(scene, { cyclic = false } = {}) {
  const directory = join(scene.root, 'author'); await mkdir(directory);
  const members = ['first', 'second']; const modules = [];
  for (const id of members) {
    const source = join(directory, 'modules', id); await mkdir(source, { recursive: true });
    const provides = cyclic || id === 'first' ? [contract] : [], requires = cyclic || id === 'second' ? [contract] : [];
    const manifest = { format: 'world-hub.module/v1', id: 'community.' + id, version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides, requires, permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
    const configuration = { topics: { events: 'community/group-test' }, bridges: { main: { publish: ['events'], subscribe: ['events'] } }, settings: {}, bindings: requires.length ? [{ providerId: id === 'first' ? 'second' : 'first', contract }] : [] };
    await writeFile(join(source, 'module.json'), json(manifest)); await writeFile(join(source, 'program.mjs'), program);
    for (const name of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(resolve('sdk/javascript', name), join(source, name));
    await writeFile(join(source, 'deployment.json'), json({ format: 'world-hub.deployment/v1', title: { en: id }, description: { en: 'Communication test module' }, topics: configuration.topics, bridges: configuration.bridges, settings: [] }));
    modules.push({ id, path: 'modules/' + id, moduleId: manifest.id, version: manifest.version, configuration });
  }
  const configurationDirectory = join(scene.root, 'configuration'); await mkdir(configurationDirectory);
  const manifest = { format: 'world-hub.configuration/v1', scope: 'local', id: 'community.desk', version: '1.0.0', title: 'Communication desk', license: 'MIT', platforms: [`${process.platform}-${process.arch}`], provides: [], requires: [], modules: [],
    startupPlan: { members: members.map(programId => ({ programId, enabled: programId === 'first', after: [] })), startupOrder: members, onFailure: 'continue-independent' } };
  for (const member of modules) {
    const path = join(directory, member.path);
    manifest.modules.push({ id: member.id, module: { id: member.moduleId, version: member.version, digest: sourceFilesDigest(await collectSourceFiles(path)) }, configuration: member.configuration });
    okay(await scene.call('/manage/api/resources/bodies/import', { path }));
  }
  await writeFile(join(configurationDirectory, 'configuration.json'), json(manifest));
  const publication = await publishArtifact(configurationDirectory, { kind: 'configuration', destination: join(scene.root, 'published'), redistributionAcknowledged: true });
  return { directory, configurationDirectory, manifest, publication };
}
function okay(result, expected = 200) { assert.equal(result.status, expected, JSON.stringify(result.body)); return result.body; }
async function editJson(path, edit) { const value = JSON.parse(await readFile(path)); edit(value); await writeFile(path, json(value)); }
async function dedicatedConsumer(directory, { capability = true } = {}) {
  const consumer = join(directory, 'modules/second');
  if (!capability) await editJson(join(consumer, 'module.json'), value => { value.requires = []; });
  await editJson(join(consumer, 'deployment.json'), value => {
    value.topics.events = 'consumer/unconnected';
    value.connections = [{ id: 'dedicated', provider: { moduleId: 'community.first', version: '1.0.0' }, contracts: capability ? [contract] : [], topics: { events: 'events' } }];
  });
  return consumer;
}
async function importIndependent(scene, path, programId, configuration = {}) {
  const review = okay(await scene.call('/manage/api/artifacts/preview', { path, programId, ...configuration }));
  assert.ok(review.reviewId); assert.equal(review.selectionRequired, undefined);
  return okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: review.reviewId, accepted: true }));
}

async function profilePreview(scene, path, options = {}) {
  const saved = okay(await scene.call('/manage/api/resources/profiles/import', { path }));
  return okay(await scene.call('/manage/api/resources/profiles/preview', { profileId: saved.profile.profileId, ...options }));
}
async function profileApply(scene, preview) {
  return okay(await scene.call('/manage/api/resources/profiles/apply', { reviewId: preview.reviewId, accepted: true }));
}

test('management community: single JSON import is reviewed, registered stopped, and keeps private identity out of responses', async t => {
  const scene = await setup(t), { directory } = await distribution(scene);
  const publication = await publishArtifact(join(directory, 'modules/first'), { kind: 'module', destination: join(scene.root, 'single'), redistributionAcknowledged: true });
  const preview = okay(await scene.call('/manage/api/artifacts/preview', { path: publication.artifactPath, programId: 'single' }));
  assert.equal(preview.kind, 'module'); assert.equal(scene.owner.localPrograms.records.size, 0); assert.equal(scene.owner.localPrograms.handles.size, 0);
  assert.notEqual((await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: preview.reviewId, accepted: false })).status, 200);
  const applied = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: preview.reviewId, accepted: true }));
  assert.equal(applied.program.state, 'stopped'); assert.equal(applied.program.hubId, 'default'); assert.equal(scene.owner.localPrograms.handles.size, 0);
  const identity = scene.owner.localPrograms.identities.get('single'); assert.equal(JSON.stringify({ preview, applied }).includes(identity.token), false); assert.equal(Object.keys(scene.hub.config?.acl?.credentials ?? {}).length, 0);
});

test('management community: cyclic configuration peers share independent cached bodies and export references without credentials', async t => {
  const scene = await setup(t), { publication } = await distribution(scene, { cyclic: true });
  const preview = await profilePreview(scene, publication.artifactPath);
  assert.equal(preview.review.adds.length, 2); assert.equal(preview.review.blocked, false); assert.equal(scene.owner.localPrograms.records.size, 0);
  assert.notEqual((await scene.call('/manage/api/resources/profiles/apply', { reviewId: preview.reviewId })).status, 200);
  const applied = await profileApply(scene, preview), ids = Object.values(applied.mapping);
  assert.equal(scene.owner.localPrograms.handles.size, 0);
  assert.equal(scene.owner.localPrograms.row(ids[0]).bindings[0].providerId, ids[1]);
  assert.equal(scene.owner.localPrograms.row(ids[1]).bindings[0].providerId, ids[0]);
  const exported = okay(await scene.call('/manage/api/resources/profiles/export', { profileId: applied.profile.profileId }));
  const bytes = await readFile(exported.artifactPath), checked = validateArtifactBytes(bytes);
  assert.equal(checked.artifact.kind, 'configuration'); assert.deepEqual(checked.artifact.files.map(file => file.path), ['configuration.json']);
  for (const id of ids) assert.equal(bytes.includes(Buffer.from(scene.owner.localPrograms.identities.get(id).token)), false);
  const again = await profilePreview(scene, exported.artifactPath, { mapping: { first: 'new-first', second: 'new-second' } });
  const installed = await profileApply(scene, again);
  assert.equal(scene.owner.localPrograms.records.size, 4);
  assert.ok(Object.values(installed.mapping).every(id => !ids.includes(id)));
});

test('management community: changed reviewed cached body refuses all configuration registry changes', async t => {
  const scene = await setup(t), { publication } = await distribution(scene);
  const preview = await profilePreview(scene, publication.artifactPath);
  const body = scene.owner.resources.state.bodies[1]; await writeFile(join(body.path, 'program.mjs'), program + '\n// altered cache\n');
  const result = await scene.call('/manage/api/resources/profiles/apply', { reviewId: preview.reviewId, accepted: true });
  assert.notEqual(result.status, 200); assert.equal(scene.owner.localPrograms.records.size, 0); assert.equal(scene.owner.localPrograms.identities.size, 0);
});

test('management community: imported members connect to the same existing Hub and independently exchange messages', async t => {
  const scene = await setup(t), { publication } = await distribution(scene);
  const preview = await profilePreview(scene, publication.artifactPath);
  const applied = await profileApply(scene, preview);
  const ids = Object.values(applied.mapping);
  // Start each independently; group import and its disabled startup selection did not launch anything.
  for (const id of ids) okay(await scene.call(`/manage/api/programs/${id}/start`, {}));
  const rows = await scene.owner.localPrograms.programs(); assert.ok(rows.every(row => row.state === 'running' && row.communication === 'connected'));
  assert.ok(rows.every(row => row.hubUrl === scene.base + '/')); assert.equal(scene.hub.snapshot().bridges.length, 2);
  const first = scene.owner.localPrograms.handles.get(ids[0]);
  const received = () => first.stdout.split('\n').some(line => { try { const event = JSON.parse(line); return event.event === 'received' && event.body.member === ids[1]; } catch { return false; } });
  const deadline = Date.now() + 5000; while (!received() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(received(), first.stdout);
  okay(await scene.call(`/manage/api/programs/${ids[0]}/stop`, {}));
  assert.equal(scene.owner.localPrograms.row(ids[1]).state, 'running'); assert.equal(scene.hub.snapshot().bridges.filter(row => row.principal === rows[1].principal).length, 1);
});

test('management community: source download pins the reviewed index and saves configurations without activating instances', async t => {
  const scene = await setup(t), { publication } = await distribution(scene);
  const observed = okay(await scene.call('/manage/api/workshop/inspect', { source: publication.indexPath }));
  const entryId = observed.index.entries[0].entryId;
  const downloaded = okay(await scene.call('/manage/api/workshop/fetch', { source: observed.source, digest: observed.digest, entryId }));
  assert.equal(downloaded.kind, 'configuration'); assert.equal(downloaded.startsModules, false);
  const paths = okay(await scene.call('/manage/api/paths/known'));
  assert.ok(paths.objects.some(object => object.kind === 'configuration' && object.path === downloaded.directory));
  const before = await readFile(publication.indexPath); await writeFile(publication.indexPath, Buffer.concat([before, Buffer.from('\n')]));
  const changed = await scene.call('/manage/api/workshop/fetch', { source: observed.source, digest: observed.digest, entryId });
  assert.notEqual(changed.status, 200); assert.match(JSON.stringify(changed.body), /index changed/);
  assert.equal(scene.owner.localPrograms.records.size, 0);
});

test('management community: failed configuration commit retains the previous registry without exposing provisional peers', async t => {
  const scene = await setup(t), { publication } = await distribution(scene);
  const preview = await profilePreview(scene, publication.artifactPath), local = scene.owner.localPrograms, save = local.save;
  local.save = async () => { throw new Error('test registry write failure'); };
  try {
    const result = await scene.call('/manage/api/resources/profiles/apply', { reviewId: preview.reviewId, accepted: true });
    assert.notEqual(result.status, 200); assert.equal(local.records.size, 0); assert.equal(local.identities.size, 0); assert.equal(local.groups.size, 0);
    assert.deepEqual(scene.owner.resources.state.active, []);
  } finally { local.save = save; }
});

test('management community: community top-level link opens the local page while cross-site API requests stay blocked', async t => {
  const scene = await setup(t);
  const read = (path, extra = {}) => new Promise((done, reject) => {
    const req = request(scene.base + path, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...extra } }, response => {
      response.resume(); response.on('end', () => done(response.statusCode));
    }); req.on('error', reject); req.end();
  });
  assert.equal(await read('/manage'), 200);
  assert.equal(await read('/manage/api/programs'), 403);
  assert.equal(await read('/manage', { origin: 'https://peros.cn' }), 403);
  assert.equal(await read('/manage', { 'sec-fetch-mode': 'cors' }), 403);
});

test('management community: an individual consumer asks for exact installed providers before review', async t => {
  const scene = await setup(t), { directory } = await distribution(scene);
  const consumer = join(directory, 'modules/second'), source = join(directory, 'modules/first');
  const missing = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer }));
  assert.equal(missing.selectionRequired, true); assert.equal(missing.requiredProviders[0].candidates.length, 0); assert.equal(missing.reviewId, undefined);
  const sourceReview = okay(await scene.call('/manage/api/artifacts/preview', { path: source, programId: 'chosen-source' }));
  okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: sourceReview.reviewId, accepted: true }));
  const selection = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer }));
  assert.equal(selection.requiredProviders[0].candidates[0].programId, 'chosen-source');
  const review = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer, bindings: [{ providerId: 'chosen-source', contract }] }));
  assert.ok(review.reviewId); assert.equal(review.review.bindings[0].providerId, 'chosen-source');
  const imported = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: review.reviewId, accepted: true }));
  assert.equal(imported.program.state, 'stopped'); assert.equal(imported.program.bindings[0].providerId, 'chosen-source');
});

test('management community: imported group execution respects explicit order and leaves unselected members stopped', async t => {
  const scene = await setup(t), { publication } = await distribution(scene);
  const preview = await profilePreview(scene, publication.artifactPath);
  const applied = await profileApply(scene, preview);
  const imported = { group: [...scene.owner.localPrograms.groups.values()][0] };
  const ids = Object.values(applied.mapping);
  let group = okay(await scene.call('/manage/api/groups/save', { expectedRevision: imported.group.revision, group: { ...imported.group,
    startupPlan: { ...imported.group.startupPlan, members: ids.map(programId => ({ programId, enabled: true, after: [] })), startupOrder: [...ids].reverse() } } })).group;
  const started = okay(await scene.call(`/manage/api/groups/${group.id}/start`, {}));
  assert.deepEqual(started.results.map(result => result.programId), [...ids].reverse()); assert.ok(started.results.every(result => result.ok));
  okay(await scene.call(`/manage/api/groups/${group.id}/stop`, {}));
  group = okay(await scene.call('/manage/api/groups/save', { expectedRevision: group.revision, group: { ...group,
    startupPlan: { ...group.startupPlan, members: ids.map((programId, i) => ({ programId, enabled: i === 1, after: [] })) } } })).group;
  const selected = okay(await scene.call(`/manage/api/groups/${group.id}/start`, {}));
  assert.deepEqual(selected.results.map(result => result.programId), [ids[1]]);
  assert.equal(scene.owner.localPrograms.row(ids[0]).state, 'stopped'); assert.equal(scene.owner.localPrograms.row(ids[1]).state, 'running');
});

test('management community: a missing dedicated module names the exact required release and refuses same-contract substitutes', async t => {
  const scene = await setup(t), { directory } = await distribution(scene), consumer = await dedicatedConsumer(directory);
  const source = join(directory, 'modules/first'), sourceManifest = join(source, 'module.json');
  const checkMissing = async expectedCount => {
    const preview = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'dedicated-consumer' }));
    assert.equal(preview.selectionRequired, true); assert.equal(preview.reviewId, undefined);
    assert.equal(preview.startsModules, false); assert.deepEqual(preview.requiredProviders, []);
    assert.deepEqual(preview.defaultConnections[0].provider, { moduleId: 'community.first', version: '1.0.0' });
    assert.equal(preview.defaultConnections[0].status, 'missing'); assert.deepEqual(preview.defaultConnections[0].candidates, []);
    assert.equal(scene.owner.localPrograms.records.size, expectedCount); assert.equal(scene.owner.localPrograms.identities.size, expectedCount);
    assert.equal(scene.owner.localPrograms.reviews.size, 0); assert.equal(scene.owner.localPrograms.handles.size, 0);
    if (expectedCount) {
      const rejected = await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'dedicated-consumer', connectionSelections: { dedicated: expectedCount === 1 ? 'wrong-version' : 'wrong-module' } });
      assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'DEFAULT_CONNECTION_INVALID');
      assert.equal(scene.owner.localPrograms.records.size, expectedCount); assert.equal(scene.owner.localPrograms.reviews.size, 0);
    }
  };
  await checkMissing(0);
  await editJson(sourceManifest, value => { value.version = '2.0.0'; });
  await importIndependent(scene, source, 'wrong-version', { topics: { events: 'provider/wrong-version' } });
  await checkMissing(1);
  await editJson(sourceManifest, value => { value.id = 'community.other'; value.version = '1.0.0'; });
  await importIndependent(scene, source, 'wrong-module', { topics: { events: 'provider/wrong-module' } });
  await checkMissing(2);
});

test('management community: a unique dedicated provider is wired automatically and remains valid when the provider starts', async t => {
  const scene = await setup(t), { directory } = await distribution(scene), consumer = await dedicatedConsumer(directory);
  const source = join(directory, 'modules/first'), channel = 'provider/dedicated-live-channel';
  const provider = await importIndependent(scene, source, 'dedicated-source', { topics: { events: channel } });
  const original = structuredClone(scene.owner.localPrograms.row('dedicated-source'));
  const preview = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'dedicated-consumer' }));
  assert.ok(preview.reviewId); assert.equal(preview.selectionRequired, undefined);
  assert.equal(preview.review.defaultConnections[0].status, 'resolved'); assert.equal(preview.review.defaultConnections[0].providerId, 'dedicated-source');
  assert.equal(preview.review.topics.events, channel); assert.deepEqual(preview.review.bindings, [{ providerId: 'dedicated-source', contract }]);
  assert.equal(scene.owner.localPrograms.records.size, 1); assert.equal(scene.owner.localPrograms.handles.size, 0);
  assert.deepEqual(scene.owner.localPrograms.row('dedicated-source'), original);
  okay(await scene.call('/manage/api/programs/dedicated-source/start', {}));
  assert.equal(scene.owner.localPrograms.row('dedicated-source').state, 'running');
  assert.equal(scene.owner.localPrograms.public(scene.owner.localPrograms.row('dedicated-source')).configurationRevision, provider.program.configurationRevision);
  const imported = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: preview.reviewId, accepted: true }));
  assert.equal(imported.program.state, 'stopped'); assert.equal(imported.program.topics.events, channel);
  assert.deepEqual(imported.program.bindings, [{ providerId: 'dedicated-source', contract }]);
  assert.deepEqual(scene.owner.localPrograms.row('dedicated-source').topics, original.topics);
  assert.deepEqual(scene.owner.localPrograms.row('dedicated-source').bridges, original.bridges);
  assert.deepEqual(scene.owner.localPrograms.row('dedicated-source').settings, original.settings);
  assert.equal(scene.owner.localPrograms.handles.size, 1);
  okay(await scene.call('/manage/api/programs/dedicated-consumer/start', {}));
  const handle = scene.owner.localPrograms.handles.get('dedicated-source');
  const received = () => handle.stdout.split('\n').some(line => { try { const event = JSON.parse(line); return event.event === 'received' && event.body.member === 'dedicated-consumer'; } catch { return false; } });
  const deadline = Date.now() + 5000; while (!received() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(received(), handle.stdout);
  assert.equal(scene.hub.snapshot().bridges.length, 2); assert.equal(scene.owner.localPrograms.row('dedicated-source').state, 'running');
});

test('management community: dedicated provider ambiguity requires an explicit compatible instance and never chooses by list order', async t => {
  const scene = await setup(t), { directory } = await distribution(scene), consumer = await dedicatedConsumer(directory), source = join(directory, 'modules/first');
  await importIndependent(scene, source, 'provider-a', { topics: { events: 'provider/a' } });
  await importIndependent(scene, source, 'provider-b', { topics: { events: 'provider/b' } });
  const ambiguous = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'selected-consumer' }));
  assert.equal(ambiguous.selectionRequired, true); assert.equal(ambiguous.reviewId, undefined);
  assert.equal(ambiguous.defaultConnections[0].status, 'ambiguous');
  assert.deepEqual(ambiguous.defaultConnections[0].candidates.map(row => row.programId), ['provider-a', 'provider-b']);
  for (const connectionSelections of [{ dedicated: 'not-installed' }, { dedicated: 42 }, { undeclared: 'provider-b' }]) {
    const rejected = await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'selected-consumer', connectionSelections });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'DEFAULT_CONNECTION_INVALID');
    assert.equal(scene.owner.localPrograms.records.size, 2); assert.equal(scene.owner.localPrograms.reviews.size, 0);
  }
  const review = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'selected-consumer', connectionSelections: { dedicated: 'provider-b' } }));
  assert.equal(review.review.topics.events, 'provider/b'); assert.deepEqual(review.review.bindings, [{ providerId: 'provider-b', contract }]);
  const imported = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: review.reviewId, accepted: true }));
  assert.equal(imported.program.topics.events, 'provider/b'); assert.deepEqual(imported.program.bindings, [{ providerId: 'provider-b', contract }]);
  assert.equal(scene.owner.localPrograms.row('provider-a').topics.events, 'provider/a'); assert.equal(scene.owner.localPrograms.row('provider-b').topics.events, 'provider/b');
  assert.equal(scene.owner.localPrograms.handles.size, 0);
});

test('management community: a dedicated pub/sub module without required contracts imports with its publisher-default connection', async t => {
  const scene = await setup(t), { directory } = await distribution(scene), consumer = await dedicatedConsumer(directory, { capability: false });
  await importIndependent(scene, join(directory, 'modules/first'), 'topic-source', { topics: { events: 'provider/pubsub-only' } });
  const preview = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'topic-consumer' }));
  assert.deepEqual(preview.review.manifest.requires, []); assert.deepEqual(preview.review.bindings, []);
  assert.equal(preview.review.defaultConnections[0].providerId, 'topic-source'); assert.equal(preview.review.topics.events, 'provider/pubsub-only');
  const imported = okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: preview.reviewId, accepted: true }));
  assert.deepEqual(imported.program.bindings, []); assert.equal(imported.program.topics.events, 'provider/pubsub-only');
  assert.equal(imported.program.state, 'stopped'); assert.equal(scene.owner.localPrograms.handles.size, 0);
});

test('management community: changing a reviewed default target topic, bridge ACL or configuration rejects import without partial registration', async t => {
  for (const [name, change] of [
    ['topic', { topics: { events: 'provider/changed-topic' } }],
    ['bridge permissions', { bridges: { main: { publish: [], subscribe: [] } } }],
    ['configuration revision', { settings: { display: 'changed after connection review' } }]
  ]) await t.test(name, async child => {
    const scene = await setup(child), { directory } = await distribution(scene), consumer = await dedicatedConsumer(directory);
    const provider = await importIndependent(scene, join(directory, 'modules/first'), 'changing-provider', { topics: { events: 'provider/original-topic' } });
    const preview = okay(await scene.call('/manage/api/artifacts/preview', { path: consumer, programId: 'not-imported' }));
    assert.ok(preview.reviewId);
    const edit = okay(await scene.call('/manage/api/programs/changing-provider/configuration/preview', { expectedRevision: provider.program.configurationRevision, ...change }));
    const updated = okay(await scene.call('/manage/api/programs/changing-provider/configuration/apply', { reviewId: edit.reviewId }));
    assert.notEqual(updated.program.configurationRevision, provider.program.configurationRevision);
    const local = scene.owner.localPrograms, registryBefore = await readFile(join(local.directory, 'registry.json'));
    const rejected = await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: preview.reviewId, accepted: true });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'DEFAULT_CONNECTION_CHANGED');
    assert.equal(local.records.size, 1); assert.equal(local.identities.size, 1); assert.equal(local.groups.size, 0); assert.equal(local.handles.size, 0);
    assert.equal(local.records.has('not-imported'), false); assert.equal(local.identities.has('not-imported'), false);
    assert.deepEqual(await readFile(join(local.directory, 'registry.json')), registryBefore);
    await assert.rejects(readFile(local.path('not-imported', 'identity.json')), { code: 'ENOENT' });
  });
});

test('management community: explicit configuration wiring selects its logical provider instead of an outside matching module', async t => {
  const scene = await setup(t), { directory, publication } = await distribution(scene);
  const outside = await importIndependent(scene, join(directory, 'modules/first'), 'outside-provider', { topics: { events: 'outside/channel' } });
  const preview = await profilePreview(scene, publication.artifactPath, { mapping: { first: 'inside-source', second: 'inside-consumer' } });
  await profileApply(scene, preview);
  assert.deepEqual(scene.owner.localPrograms.row('inside-consumer').bindings, [{ providerId: 'inside-source', contract }]);
  assert.deepEqual(scene.owner.localPrograms.public(scene.owner.localPrograms.row('outside-provider')), outside.program);
  assert.equal(scene.owner.localPrograms.handles.size, 0);
});
