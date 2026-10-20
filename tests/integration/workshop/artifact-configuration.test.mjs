import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { artifactConfiguration } from '../../../tools/workshop/artifact-configuration.mjs';
import { WorkshopStore, MAX_UPLOAD } from '../../../tools/workshop/store.mjs';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';
import { workshopCall, registerMember } from './phase18-helpers.mjs';

const password = 'configuration-tests-local-password';
const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
const file = (path, value) => { const content = bytes(value); return { path, sha256: hash(content), base64: content.toString('base64') }; };
const get = (artifact, path) => JSON.parse(Buffer.from(artifact.files.find(item => item.path === path).base64, 'base64'));
function replace(artifact, path, value) { const index = artifact.files.findIndex(item => item.path === path); if (index < 0) artifact.files.push(file(path, value)); else artifact.files[index] = file(path, value); return artifact; }
function moduleArtifact({ id = 'configuration.widget', version = '1.0.0', executionDefaults, deployment = true, runtime = 'node' } = {}) {
  const manifest = { format: 'world-hub.module/v1', id, version, license: 'MIT', platforms: ['win32-x64', 'linux-x64'],
    runtime: { kind: runtime, entry: runtime === 'node' ? 'program.mjs' : 'program.py' }, bridges: ['main'], provides: [], requires: [],
    permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
  const files = [file('module.json', manifest), file(manifest.runtime.entry, "throw new Error('Never execute uploaded code');\n")];
  if (deployment) files.push(file('deployment.json', { format: 'world-hub.deployment/v1', title: { zh: '配置模块', en: 'Configuration module' }, description: { zh: '说明', en: 'Description' },
    topics: { events: 'configuration/events' }, bridges: { main: { publish: ['events'], subscribe: [] } },
    settings: [{ key: 'label', label: { zh: '标签', en: 'Label' }, type: 'string', default: 'module default' }],
    ...(executionDefaults === undefined ? {} : { executionDefaults }) }));
  return { format: 'world-hub.source-artifact/v1', kind: 'module', id, version, files,
    provenance: { redistributionAcknowledged: true, allowedCallers: ['not-a-grant'], secret: 'not-projected' } };
}
function groupArtifact() {
  const source = moduleArtifact({ id: 'configuration.source', executionDefaults: { mode: 'on-demand', idleTimeoutMs: 15000 } });
  const inherited = moduleArtifact({ id: 'configuration.inherited', executionDefaults: { mode: 'on-demand', idleTimeoutMs: 17000 } });
  const system = moduleArtifact({ id: 'configuration.system', deployment: false });
  const members = [source, inherited, system].map((item, index) => ({ id: ['source', 'inherited', 'system'][index], path: 'modules/' + ['source', 'inherited', 'system'][index], moduleId: item.id, version: item.version,
    configuration: { topics: { events: 'configuration/group/' + index }, bridges: { main: { publish: ['events'], subscribe: [] } }, settings: index === 2 ? {} : { label: 'group value' }, bindings: [],
      ...(index === 0 ? { executionDefaults: { mode: 'resident', idleTimeoutMs: 24000 } } : {}) } }));
  const manifest = { format: 'world-hub.module-group/v1', id: 'configuration.group', version: '1.0.0', title: 'Configuration group', license: 'MIT', platforms: ['win32-x64', 'linux-x64'], provides: [], requires: [], modules: members,
    startupPlan: { members: members.map(member => ({ programId: member.id, enabled: member.id !== 'system', after: [] })), onFailure: 'continue-independent', startupOrder: members.map(member => member.id) } };
  return { format: 'world-hub.source-artifact/v1', kind: 'module-group', id: manifest.id, version: manifest.version,
    files: [file('module-group.json', manifest), ...[source, inherited, system].flatMap((item, index) => item.files.map(entry => ({ ...entry, path: members[index].path + '/' + entry.path })))], provenance: { redistributionAcknowledged: true } };
}
async function fixture(t) {
  const parent = resolve('.artifacts/workshop-configuration-tests'); await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'case-'));
  const store = await WorkshopStore.open({ root }); await store.initializeAdmin('admin', password); await store.close();
  const service = await createWorkshopServer({ root, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false });
  t.after(() => service.close());
  const login = await workshopCall(service, 'api/login', { username: 'admin', password });
  return { root, service, actor: { ...login.data, cookie: login.cookie } };
}

test('exact bytes project author defaults, public configuration and declared dependencies without guessed interpreter versions', () => {
  const artifact = moduleArtifact({ executionDefaults: { mode: 'on-demand' }, runtime: 'python' });
  artifact.files.push(file('package.json', { dependencies: { widget: '1.2.3' }, devDependencies: { tests: '^2.0.0' }, scripts: { install: 'DO NOT RUN' }, privateSecret: 'not-projected' }),
    file('requirements.txt', 'websockets==15.0.1\n# comment\nrequests>=2.0,<3.0\n-r private-requirements.txt\nhttps://user:password@example.test/private.whl\n'),
    file('pyproject.toml', '[project]\nname="example"\n'));
  const original = bytes(artifact), configuration = artifactConfiguration(original);
  assert.equal(configuration.sha256, hash(original)); assert.equal(configuration.format, 'world-hub.workshop-configuration/v1');
  assert.deepEqual(configuration.executionDefaults, { declared: { mode: 'on-demand' }, effective: { mode: 'on-demand', idleTimeoutMs: 60000, allowedCallers: [] }, source: 'module' });
  assert.deepEqual(configuration.manifest.runtime, { kind: 'python', entry: 'program.py' }); assert.equal(configuration.manifest.runtime.version, undefined);
  assert.deepEqual(configuration.effectiveConfiguration.settings, { label: 'module default' }); assert.deepEqual(configuration.configurationSources, { topics: 'module', bridges: 'module', settings: 'module', bindings: 'system' });
  assert.deepEqual(configuration.dependencies.npm.dependencies, { widget: '1.2.3' }); assert.deepEqual(configuration.dependencies.npm.devDependencies, { tests: '^2.0.0' });
  assert.deepEqual(configuration.dependencies.python[0].requirements, ['websockets==15.0.1', 'requests>=2.0,<3.0']); assert.equal(configuration.dependencies.python[0].unsupportedCount, 2);
  assert.equal(configuration.dependencies.unparsed[0].path, 'pyproject.toml');
  assert.doesNotMatch(JSON.stringify(configuration), /DO NOT RUN|privateSecret|not-projected|not-a-grant|user:password/);
  assert.equal(artifactConfiguration(moduleArtifact({ deployment: false })).deployment, null);
  assert.deepEqual(artifactConfiguration(moduleArtifact({ deployment: false })).executionDefaults, { declared: null, effective: { mode: 'resident', idleTimeoutMs: 60000, allowedCallers: [] }, source: 'system' });
});

test('module groups distinguish group overrides, inherited declarations and system defaults; retain actual member settings and startup selection', () => {
  const configuration = artifactConfiguration(groupArtifact());
  assert.equal(configuration.executionDefaults, null); assert.equal(configuration.modules.length, 3);
  const [source, inherited, system] = configuration.modules;
  assert.deepEqual(source.executionDefaults, { declared: { mode: 'resident', idleTimeoutMs: 24000 }, effective: { mode: 'resident', idleTimeoutMs: 24000, allowedCallers: [] }, source: 'module-group' });
  assert.equal(source.deployment.executionDefaults.mode, 'on-demand', 'the module author baseline remains distinct from the group override');
  assert.equal(source.effectiveConfiguration.settings.label, 'group value'); assert.equal(source.deployment.settings[0].default, 'module default');
  assert.equal(source.configurationSources.settings, 'module-group'); assert.equal(inherited.executionDefaults.source, 'module'); assert.equal(inherited.executionDefaults.effective.idleTimeoutMs, 17000);
  assert.equal(system.executionDefaults.source, 'system'); assert.equal(system.executionDefaults.effective.mode, 'resident'); assert.deepEqual(system.effectiveConfiguration.bindings, []);
  assert.equal(configuration.startupPlan.members[2].enabled, false); assert.deepEqual(configuration.startupPlan.startupOrder, ['source', 'inherited', 'system']);
});

test('invalid configuration, forged caller grants and broken dependency recipes fail full preview validation', () => {
  const artifact = moduleArtifact();
  const deployment = get(artifact, 'deployment.json');
  replace(artifact, 'deployment.json', { ...deployment, executionDefaults: { mode: 'on-demand', allowedCallers: ['all'] } });
  assert.throws(() => artifactConfiguration(artifact), /Execution defaults/);
  replace(artifact, 'deployment.json', { ...deployment, settings: [{ key: 'passwd', type: 'string', label: { en: 'Password' }, default: 'private' }] });
  assert.throws(() => artifactConfiguration(artifact), /private configuration/);
  replace(artifact, 'deployment.json', { ...deployment, dependencies: { kind: 'npm-lock', manifest: 'package.json', lock: 'package-lock.json', recipes: [] } });
  assert.throws(() => artifactConfiguration(artifact), /complete bounded npm lock/);
  const forged = groupArtifact(), group = get(forged, 'module-group.json'); group.modules[0].configuration.executionDefaults.allowedCallers = ['attacker']; replace(forged, 'module-group.json', group);
  assert.throws(() => artifactConfiguration(forged), /Execution defaults/);
});

test('authenticated preview shares publication validation, rejects independent summaries and leaves no stored artifact or revision', async t => {
  const { root, service, actor } = await fixture(t), artifact = moduleArtifact({ executionDefaults: { mode: 'on-demand', idleTimeoutMs: 3000 } });
  const before = await readFile(join(root, 'metadata.json'), 'utf8');
  await workshopCall(service, 'api/artifacts/preview', { artifact }, null, 401);
  await workshopCall(service, 'api/artifacts/preview', { artifact }, { cookie: actor.cookie }, 403);
  const result = (await workshopCall(service, 'api/artifacts/preview', { artifact }, actor)).data;
  assert.deepEqual(result.configuration, artifactConfiguration(bytes(artifact)));
  await workshopCall(service, 'api/artifacts/preview', { artifact, configuration: { executionDefaults: { mode: 'resident' } } }, actor, 400);
  const corrupted = structuredClone(artifact); corrupted.files[0].sha256 = '0'.repeat(64);
  assert.equal((await workshopCall(service, 'api/artifacts/preview', { artifact: corrupted }, actor, 400)).data.error.code, 'INVALID_ARTIFACT');
  assert.equal(await readFile(join(root, 'metadata.json'), 'utf8'), before); assert.deepEqual(await readdir(join(root, 'artifacts')), []);
  const malformed = structuredClone(artifact); replace(malformed, 'deployment.json', { ...get(malformed, 'deployment.json'), unsupportedGrant: true });
  assert.equal((await workshopCall(service, 'api/publications', { artifact: malformed, redistributionAcknowledged: true }, actor, 400)).data.error.code, 'INVALID_ARTIFACT');
});

test('historical versions and restarted publications derive configuration from their own immutable digest', async t => {
  const { root, service, actor } = await fixture(t);
  const baseline = (await workshopCall(service, 'api/publications', { artifact: moduleArtifact(), redistributionAcknowledged: true }, actor, 201)).data.publication;
  const current = (await workshopCall(service, 'api/publications', { artifact: moduleArtifact({ version: '2.0.0', executionDefaults: { mode: 'on-demand', idleTimeoutMs: 3000 } }), redistributionAcknowledged: true }, actor, 201)).data.publication;
  const old = (await workshopCall(service, `api/publications/${baseline.entryId}`)).data;
  const next = (await workshopCall(service, `api/publications/${current.entryId}/configuration`)).data;
  assert.equal(old.configuration.sha256, baseline.sha256); assert.equal(next.sha256, current.sha256); assert.notEqual(next.sha256, old.configuration.sha256);
  assert.equal(old.configuration.executionDefaults.effective.mode, 'resident'); assert.equal(next.executionDefaults.effective.mode, 'on-demand');
  await service.close(); const reopened = await WorkshopStore.open({ root }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.configuration(baseline.entryId), old.configuration); assert.deepEqual(await reopened.configuration(current.entryId), next);
});

test('hidden configuration follows publication visibility and never becomes an anonymous digest backdoor', async t => {
  const { service, actor } = await fixture(t), owner = await registerMember(service, actor, 'owner', password), stranger = await registerMember(service, actor, 'stranger', password);
  const publication = (await workshopCall(service, 'api/publications', { artifact: groupArtifact(), redistributionAcknowledged: true }, owner, 201)).data.publication;
  await workshopCall(service, `api/publications/${publication.entryId}/visibility`, { hidden: true }, actor);
  await workshopCall(service, `api/publications/${publication.entryId}/configuration`, undefined, null, 404);
  await workshopCall(service, `api/publications/${publication.entryId}/configuration`, undefined, stranger, 404);
  const authorized = (await workshopCall(service, `api/publications/${publication.entryId}/configuration`, undefined, owner)).data;
  assert.equal(authorized.sha256, publication.sha256); assert.equal(authorized.modules[0].executionDefaults.source, 'module-group');
  await workshopCall(service, `api/publications/${publication.entryId}/configuration`, undefined, actor);
  assert.equal((await fetch(`${service.baseURL}/artifacts/${publication.sha256}.json`)).status, 404);
  await workshopCall(service, `api/publications/${publication.entryId}/configuration/extra`, undefined, actor, 404);
});

test('preview enforces per-account upload quota and bounds without saving input', async t => {
  const { service, actor } = await fixture(t), artifact = moduleArtifact();
  for (let index = 0; index < 10; index++) await workshopCall(service, 'api/artifacts/preview', { artifact }, actor);
  assert.equal((await workshopCall(service, 'api/artifacts/preview', { artifact }, actor, 429)).data.error.code, 'RATE_LIMITED');
  assert.equal(service.store.artifacts.size, 0);
  const another = await registerMember(service, actor, 'large-input', password);
  const rejectedStatus = await new Promise((resolveResponse, reject) => {
    const upload = request(new URL('api/artifacts/preview', service.url), { method: 'POST', headers: { origin: service.origin, 'content-type': 'application/json', 'content-length': MAX_UPLOAD + 1025, cookie: another.cookie, 'x-csrf-token': another.csrfToken } }, response => { response.resume(); response.on('end', () => resolveResponse(response.statusCode)); });
    upload.on('error', reject); upload.end('{');
  });
  assert.equal(rejectedStatus, 413);
});
