import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hub } from '../../src/hub/lib/hub.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { attachWebSocketServer } from '../../src/hub/ws-server.mjs';
import { createManagementHttp } from '../../src/management/management-http.mjs';
import { ordinaryPath, hash } from '../../scripts/runtime/paths.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const rootDirectory = resolve('.artifacts/management-version-tests');
const nativeProgram = version => `import {readFile} from 'node:fs/promises';
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
await bridge.subscribe([config.topics.events],{from:0});await bridge.publishConfirmed(config.topics.events,{member:config.componentId,version:'${version}'});
emit({event:'module-ready'});
`;
async function setup(t) {
  await mkdir(rootDirectory, { recursive: true });
  const root = await mkdtemp(join(rootDirectory, 'case-'));
  const config = normalizeConfig({ transport: { port: 0 }, acl: { allowUnlistedBridges: false, credentials: {}, bridges: {} },
    log: { enabled: false, dir: join(root, 'log') }, blobs: { dir: join(root, 'blobs') },
    management: { stateFile: join(root, 'management.json'), explicitStateFile: true } }, null);
  const hub = await Hub.create(config); let management;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/status') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(hub.snapshot())); return; }
    if (await management.handle(request, response, url)) return;
    response.writeHead(404); response.end();
  });
  const ws = attachWebSocketServer(server, { path: config.transport.path, maxPayload: 4 * 1024 * 1024 });
  ws.on('connection', connection => hub.onConnection(connection));
  await new Promise(done => server.listen(0, '127.0.0.1', done)); config.transport.port = server.address().port;
  management = await createManagementHttp(hub, config); const base = `http://127.0.0.1:${config.transport.port}`;
  const scene = { root, hub, base, get owner() { return management.modules; },
    call: async (path, body) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-management-token': management.snapshot().csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
      return { status: response.status, body: await response.json() };
    },
    reload: async () => { await management.modules.close(); management = await createManagementHttp(hub, config); }
  };
  t.after(async () => {
    await management.modules.close(); ws.closeAll(1001, 'test complete'); await new Promise(done => server.close(done)); await hub.stop();
    const actual = await ordinaryPath(root); assert.equal(dirname(actual), await ordinaryPath(rootDirectory)); assert.ok(actual.startsWith(join(rootDirectory, 'case-')));
    await rm(actual, { recursive: true, force: false });
  });
  return scene;
}
function okay(result, expected = 200) { assert.equal(result.status, expected, JSON.stringify(result.body)); return result.body; }
function refused(result) { assert.notEqual(result.status, 200, JSON.stringify(result.body)); return result.body; }
const endpoint = (kind, id, action = '') => `/manage/api/versions/${kind}/${encodeURIComponent(id)}${action ? '/' + action : ''}`;
async function overview(scene, kind, id) { return okay(await scene.call(endpoint(kind, id))); }
async function preview(scene, kind, id, path, options = {}) {
  const current = await overview(scene, kind, id);
  return okay(await scene.call(endpoint(kind, id, 'preview'), { path, expectedRevision: current.current.revision, dataPolicy: 'preserve', configurationPolicy: 'preserve', ...options }));
}
async function apply(scene, kind, id, review) {
  return okay(await scene.call(endpoint(kind, id, 'apply'), { reviewId: review.reviewId, accepted: true, dataAcknowledged: true }));
}
async function rollbackPreview(scene, kind, id, transactionId, dataPolicy = 'preserve') {
  const current = await overview(scene, kind, id);
  return okay(await scene.call(endpoint(kind, id, 'rollback-preview'), { transactionId, expectedRevision: current.current.revision, dataPolicy }));
}
async function moduleSource(scene, name, version, { moduleId = `versions.${name}`, topic = 'versions/communication', title = name, provides = [], requires = [] } = {}) {
  const directory = join(scene.root, `author-${name}-${version}`); await mkdir(directory, { recursive: true });
  const manifest = { format: 'world-hub.module/v1', id: moduleId, version, license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
    runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides, requires,
    permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
  const configuration = { topics: { events: topic }, bridges: { main: { publish: ['events'], subscribe: ['events'] } }, settings: { label: version }, bindings: [] };
  await writeFile(join(directory, 'module.json'), json(manifest)); await writeFile(join(directory, 'program.mjs'), nativeProgram(version));
  for (const name of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(resolve('sdk/javascript', name), join(directory, name));
  await writeFile(join(directory, 'deployment.json'), json({ format: 'world-hub.deployment/v1', title: { en: title }, description: { en: 'Version transition test' },
    topics: configuration.topics, bridges: configuration.bridges, settings: [{ key: 'label', type: 'string', label: { en: 'Label' }, default: version }] }));
  return { directory, manifest, configuration };
}
async function importModule(scene, source, programId, options = {}) {
  const review = okay(await scene.call('/manage/api/artifacts/preview', { path: source.directory, programId, ...options }));
  return okay(await scene.call('/manage/api/artifacts/apply', { kind: 'module', reviewId: review.reviewId, accepted: true }));
}
async function groupSource(scene, version, definitions) {
  const directory = join(scene.root, `group-${version}`); await mkdir(join(directory, 'modules'), { recursive: true });
  const modules = [];
  for (const definition of definitions) {
    const name = typeof definition === 'string' ? definition : definition.id;
    const moduleVersion = typeof definition === 'string' ? version : definition.version ?? version;
    const source = await moduleSource(scene, `${name}-group-${version}`, moduleVersion, { moduleId: typeof definition === 'string' ? `versions.${name}` : definition.moduleId ?? `versions.${name}` });
    const target = join(directory, 'modules', name); await mkdir(target);
    for (const file of ['module.json', 'deployment.json', 'program.mjs', 'bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(source.directory, file), join(target, file));
    modules.push({ id: name, path: `modules/${name}`, moduleId: source.manifest.id, version: moduleVersion, configuration: source.configuration });
  }
  const manifest = { format: 'world-hub.module-group/v1', id: 'versions.group', version, title: 'Versioned group', license: 'MIT',
    platforms: [`${process.platform}-${process.arch}`], provides: [], requires: [], modules,
    startupPlan: { members: modules.map(row => ({ programId: row.id, enabled: true, after: [] })), startupOrder: modules.map(row => row.id), onFailure: 'continue-independent' } };
  await writeFile(join(directory, 'module-group.json'), json(manifest)); return { directory, manifest };
}
async function configurationSource(scene, source) {
  const { readModuleGroup } = await import('../../scripts/runtime/module-group.mjs');
  const { sourceFilesDigest } = await import('../../scripts/runtime/resource-artifacts.mjs');
  const { collectSourceFiles } = await import('../../scripts/runtime/source-guidance.mjs');
  const { manifest, modules } = await readModuleGroup(source.directory);
  const directory = join(scene.root, 'configuration-' + randomUUID()); await mkdir(directory);
  const configuration = { ...manifest, format: 'world-hub.configuration/v1', scope: 'local', provides: [], requires: [], modules: [] };
  for (const row of modules) configuration.modules.push({ id: row.member.id, module: { id: row.manifest.id, version: row.manifest.version, digest: sourceFilesDigest(await collectSourceFiles(row.directory)) }, configuration: row.member.configuration });
  await writeFile(join(directory, 'configuration.json'), json(configuration));
  return { directory, manifest: configuration };
}
async function importGroup(scene, source) {
  // Group lifecycle/version tests need a local reference group, not a retired
  // downloadable bundle. Assemble it through independent body/configuration APIs.
  const { readModuleGroup } = await import('../../scripts/runtime/module-group.mjs');
  const { moduleGroupWiringBaseline } = await import('../../tools/launcher/module-groups.mjs');
  const { sourceFilesDigest } = await import('../../scripts/runtime/resource-artifacts.mjs');
  const { collectSourceFiles } = await import('../../scripts/runtime/source-guidance.mjs');
  const { manifest, modules } = await readModuleGroup(source.directory);
  const directory = join(scene.root, 'configuration-' + randomUUID()); await mkdir(directory);
  const configuration = { ...manifest, format: 'world-hub.configuration/v1', scope: 'local', provides: [], requires: [], modules: [] };
  for (const row of modules) {
    okay(await scene.call('/manage/api/resources/bodies/import', { path: row.directory }));
    configuration.modules.push({ id: row.member.id, module: { id: row.manifest.id, version: row.manifest.version, digest: sourceFilesDigest(await collectSourceFiles(row.directory)) }, configuration: row.member.configuration });
  }
  await writeFile(join(directory, 'configuration.json'), json(configuration));
  const imported = okay(await scene.call('/manage/api/resources/profiles/import', { path: directory }));
  const review = okay(await scene.call('/manage/api/resources/profiles/preview', { profileId: imported.profile.profileId }));
  const result = okay(await scene.call('/manage/api/resources/profiles/apply', { reviewId: review.reviewId, accepted: true }));
  okay(await scene.call('/manage/api/resources/profiles/deactivate', { profileIds: [imported.profile.profileId], accepted: true }));
  const groupId = 'configuration-' + hash(manifest.id).slice(0, 24), group = scene.owner.localPrograms.groups.get(groupId);
  const saved = okay(await scene.call('/manage/api/groups/save', { expectedRevision: group.revision, group: { ...group, origin: { id: manifest.id, version: manifest.version, members: result.mapping }, wiringBaseline: moduleGroupWiringBaseline(manifest) } }));
  return { group: saved.group, programs: Object.values(result.mapping).map(id => scene.owner.localPrograms.public(scene.owner.localPrograms.row(id))), startsModules: false, createsHub: false };
}
async function stateFile(scene, id, value) {
  const directory = scene.owner.localPrograms.path(id, 'state'); await mkdir(directory, { recursive: true });
  const path = join(directory, 'application.txt'); if (value !== undefined) await writeFile(path, value); return path;
}

export { json, nativeProgram, setup, okay, refused, endpoint, overview, preview, apply, rollbackPreview, moduleSource, importModule, groupSource, importGroup, configurationSource, stateFile };
