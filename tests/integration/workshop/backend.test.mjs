import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, access, symlink, open, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { validateSourceIndex, validateArtifactBytes } from '../../../scripts/runtime/sources.mjs';
import { WorkshopStore, initializeAdmin, MAX_UPLOAD } from '../../../tools/workshop/store.mjs';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';
import { main as workshopMain } from '../../../tools/workshop/cli.mjs';

const evidenceRoot = resolve('.artifacts/workshop-tests');
const password = 'local-acceptance-password-2026';
async function directory() { await mkdir(evidenceRoot, { recursive: true }); return mkdtemp(join(evidenceRoot, 'case-')); }
async function absent(file) { await assert.rejects(access(file), { code: 'ENOENT' }); }
async function fixture() {
  const root = await directory(); await initializeAdmin({ root, username: 'admin', password });
  const service = await createWorkshopServer({ root, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false });
  return { root, service };
}
async function call(service, path, body, actor, extra = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = request(new URL(path, service.url), { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { origin: service.origin, 'content-type': 'application/json' }), ...(actor?.cookie ? { cookie: actor.cookie } : {}), ...(actor?.csrfToken ? { 'x-csrf-token': actor.csrfToken } : {}), ...extra } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject); response.on('end', () => { try { const text = Buffer.concat(chunks).toString('utf8'), headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join('; ') : value); resolveResponse({ status: response.statusCode, body: JSON.parse(text), cookie: response.headers['set-cookie']?.[0].split(';')[0], headers }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function login(service, username = 'admin') { const response = await call(service, 'api/login', { username, password }); assert.equal(response.status, 200, JSON.stringify(response.body)); return { ...response.body, cookie: response.cookie }; }
async function member(service, admin, username = 'developer') {
  const invitation = await call(service, 'api/invitations', {}, admin); assert.equal(invitation.status, 201);
  const response = await call(service, 'api/register', { username, password, invitation: invitation.body.invitation }); assert.equal(response.status, 201, JSON.stringify(response.body));
  return { ...response.body, cookie: response.cookie, invitation: invitation.body.invitation };
}
function moduleArtifact(id = 'test.widget', version = '1.0.0', content = "throw new Error('Workshop must never execute uploaded code');\n") {
  const manifest = { format: 'world-hub.module/v1', id, version, license: 'MIT', platforms: ['linux-x64', 'win32-x64'], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [{ id: 'test.echo', version: '1.0.0' }], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
  const bytes = { 'module.json': Buffer.from(JSON.stringify(manifest) + '\n'), 'program.mjs': Buffer.from(content) };
  return { format: 'world-hub.source-artifact/v1', kind: 'module', id, version, files: Object.entries(bytes).map(([path, data]) => ({ path, sha256: hash(data), base64: data.toString('base64') })), provenance: { redistributionAcknowledged: true } };
}
async function samplePackArtifact() {
  const base = resolve('examples/ecosystem-pack'), manifest = JSON.parse(await readFile(join(base, 'pack.json'), 'utf8')), lock = JSON.parse(await readFile(join(base, 'pack.lock'), 'utf8'));
  const paths = ['pack.json', 'pack.lock', ...lock.modules.flatMap(m => m.files.map(f => `${m.source}/${f.path}`))];
  const files = [];
  for (const path of paths) { const bytes = await readFile(join(base, path)); files.push({ path, sha256: hash(bytes), base64: bytes.toString('base64') }); }
  return { format: 'world-hub.source-artifact/v1', kind: 'pack', id: manifest.id, version: manifest.version, files, provenance: { redistributionAcknowledged: true } };
}
function artifactJson(artifact, path) { const file = artifact.files.find(f => f.path === path); assert.ok(file, `Fixture lacks ${path}`); return JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')); }
function replaceArtifactJson(artifact, path, value) { const file = artifact.files.find(f => f.path === path); assert.ok(file, `Fixture lacks ${path}`); const bytes = Buffer.from(JSON.stringify(value) + '\n'); file.base64 = bytes.toString('base64'); file.sha256 = hash(bytes); return file.sha256; }

test('invite-only accounts, hashed credentials, secure session semantics and exact Origin/CSRF', async t => {
  const { root, service } = await fixture(); t.after(() => service.close());
  const anonymous = await call(service, 'api/me'); assert.deepEqual(anonymous.body, { user: null });
  assert.equal((await call(service, 'api/register', { username: 'guest', password, invitation: 'x'.repeat(43) })).status, 403);
  const admin = await login(service);
  const loginResponse = await call(service, 'api/login', { username: 'admin', password });
  assert.match(loginResponse.headers.get('set-cookie'), /HttpOnly/); assert.match(loginResponse.headers.get('set-cookie'), /SameSite=Strict/); assert.match(loginResponse.headers.get('set-cookie'), /Path=\/workshop/);
  assert.equal((await call(service, 'api/invitations', {}, { cookie: admin.cookie })).status, 403);
  assert.equal((await call(service, 'api/invitations', {}, admin, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call(service, 'api/invitations', {}, admin, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const developer = await member(service, admin);
  assert.equal((await call(service, 'api/register', { username: 'another', password, invitation: developer.invitation })).status, 403);
  assert.equal((await call(service, 'api/invitations', {}, developer)).status, 403);
  assert.equal((await call(service, 'api/me', undefined, developer)).body.user.username, 'developer');
  assert.equal((await call(service, 'api/logout', {}, developer)).status, 200);
  assert.equal((await call(service, 'api/me', undefined, developer)).body.user, null);
  const metadata = await readFile(join(root, 'metadata.json'), 'utf8');
  assert.equal(metadata.includes(password), false); assert.equal(metadata.includes(developer.invitation), false); assert.equal(metadata.includes(admin.cookie.split('=')[1]), false); assert.equal(metadata.includes(admin.csrfToken), false);
});

test('immutable module/pack publications produce a valid static source and verified anonymous distribution', async t => {
  const { root, service } = await fixture(); t.after(() => service.close()); const admin = await login(service), developer = await member(service, admin);
  const artifact = moduleArtifact();
  const published = await call(service, 'api/publications', { artifact, redistributionAcknowledged: true, title: 'Echo widget' }, developer); assert.equal(published.status, 201, JSON.stringify(published.body));
  const entryId = published.body.publication.entryId;
  const duplicate = await call(service, 'api/publications', { artifact, redistributionAcknowledged: true }, developer); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true); assert.equal(duplicate.body.publication.sha256, published.body.publication.sha256);
  assert.equal((await call(service, 'api/publications', { artifact: moduleArtifact('test.widget', '1.0.0', '// changed\n'), redistributionAcknowledged: true }, developer)).body.error.code, 'IMMUTABLE_VERSION');
  assert.equal((await call(service, 'api/publications', { artifact: moduleArtifact('test.widget', '2.0.0'), redistributionAcknowledged: true }, admin)).body.error.code, 'IDENTITY_OWNED');
  assert.equal((await call(service, 'api/publications', { artifact, redistributionAcknowledged: 'true' }, developer)).status, 400);
  const corrupted = structuredClone(artifact); corrupted.files[1].base64 = Buffer.from('bad').toString('base64'); assert.equal((await call(service, 'api/publications', { artifact: corrupted, redistributionAcknowledged: true }, developer)).body.error.code, 'INVALID_ARTIFACT');
  const pack = await samplePackArtifact(); assert.equal((await call(service, 'api/publications', { artifact: pack, redistributionAcknowledged: true }, developer)).status, 201);
  const catalog = await call(service, 'api/catalog?kind=module&contract=test.echo&search=widget'); assert.equal(catalog.body.total, 1); assert.equal(catalog.body.publications[0].entryId, entryId);
  const index = (await call(service, 'index.json')).body; assert.equal(index.entries.length, 2);
  // Local tests use HTTP only; the production index has the fixed HTTPS URL.
  validateSourceIndex({ ...index, entries: index.entries.map(e => ({ ...e, source: { url: `https://workshop.example.test/workshop/artifacts/${e.sha256}.json` } })) });
  for (const entry of index.entries) {
    const response = await fetch(entry.source.url); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(hash(bytes), entry.sha256); const validation = validateArtifactBytes(bytes); assert.equal(validation.entry.id, entry.id); assert.match(response.headers.get('cache-control'), /immutable/);
  }
  assert.equal((await call(service, `api/publications/${entryId}`)).body.entry.provides[0].id, 'test.echo');
  await absent(join(root, 'execution-marker')); assert.equal((await readFile(join(root, 'metadata.json'), 'utf8')).includes("Workshop must never execute"), false);
});

test('comments and exact-baseline proposals remain data; moderation and disabled accounts revoke access', async t => {
  const { service } = await fixture(); t.after(() => service.close()); const admin = await login(service), developer = await member(service, admin);
  const publish = await call(service, 'api/publications', { artifact: moduleArtifact(), redistributionAcknowledged: true }, developer); const p = publish.body.publication;
  const comment = await call(service, `api/publications/${p.entryId}/comments`, { text: '<script>alert(1)</script> plain Unicode 🌍' }, admin); assert.equal(comment.status, 201); assert.match(comment.body.comment.text, /<script>/);
  assert.equal((await call(service, `api/publications/${p.entryId}/comments`, { text: 'x'.repeat(4001) }, admin)).status, 400);
  const proposalBody = { artifact: moduleArtifact('test.widget', '1.1.0', '// new version\n'), baseSha256: p.sha256, redistributionAcknowledged: true, title: 'Suggestion' };
  assert.equal((await call(service, `api/publications/${p.entryId}/proposals`, { ...proposalBody, baseSha256: '0'.repeat(64) }, admin)).body.error.code, 'BASELINE_CHANGED');
  const proposal = await call(service, `api/publications/${p.entryId}/proposals`, proposalBody, admin); assert.equal(proposal.status, 201); const q = proposal.body.proposal;
  const downloaded = await call(service, `api/publications/${p.entryId}/proposals/${q.id}`); assert.deepEqual(downloaded.body.artifact, proposalBody.artifact);
  assert.equal((await call(service, 'index.json')).body.entries.length, 1, 'a proposal does not publish a new version automatically');
  assert.equal((await call(service, `api/publications/${p.entryId}/visibility`, { hidden: true }, developer)).status, 403);
  assert.equal((await call(service, `api/publications/${p.entryId}/visibility`, { hidden: 'true' }, admin)).status, 400);
  assert.equal((await call(service, `api/publications/${p.entryId}/visibility`, { hidden: true }, admin)).status, 200);
  assert.equal((await call(service, 'api/catalog')).body.total, 0); assert.equal((await call(service, 'index.json')).body.entries.length, 0);
  assert.equal((await call(service, `api/publications/${p.entryId}`)).status, 404); assert.equal((await call(service, `api/publications/${p.entryId}`, undefined, admin)).status, 200);
  assert.equal((await fetch(`${service.baseURL}/artifacts/${p.sha256}.json`)).status, 404);
  await call(service, `api/publications/${p.entryId}/visibility`, { hidden: false }, admin);
  assert.equal((await call(service, `api/users/${developer.user.id}/status`, { disabled: true }, admin)).status, 200);
  assert.equal((await call(service, 'api/me', undefined, developer)).body.user, null);
  assert.equal((await call(service, `api/publications/${p.entryId}/comments`, { text: 'blocked' }, developer)).status, 401);
  assert.equal((await call(service, 'api/login', { username: developer.user.username, password })).status, 401);
  assert.equal((await call(service, `api/users/${admin.user.id}/status`, { disabled: true }, admin)).body.error.code, 'ADMIN_SELF_DISABLE');
});

test('bounded uploads are authenticated before reading, fixed hosts, JSON and query validation', async t => {
  const { service } = await fixture(); t.after(() => service.close()); const admin = await login(service);
  assert.equal((await call(service, 'health', undefined, null, { host: 'evil.example' })).status, 403);
  assert.equal((await call(service, 'api/catalog?offset=NaN')).status, 400); assert.equal((await call(service, 'api/catalog?limit=101')).status, 400);
  assert.equal((await call(service, 'api/catalog?kind=module&kind=pack')).status, 400);
  assert.equal((await call(service, 'api/login', { username: 'admin', password }, null, { 'content-type': 'text/plain' })).status, 415);
  async function declaredHuge(actor) {
    const target = new URL('api/publications', service.url);
    return new Promise((resolveResponse, reject) => {
      const req = request(target, { method: 'POST', headers: { origin: service.origin, 'content-type': 'application/json', 'content-length': MAX_UPLOAD + 1, ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrfToken } : {}) } }, response => { response.resume(); response.on('end', () => resolveResponse(response.statusCode)); });
      req.on('error', reject); req.end('{');
    });
  }
  assert.equal(await declaredHuge(null), 401); assert.equal(await declaredHuge(admin), 413);
  const invalidTraversal = moduleArtifact(); invalidTraversal.files.push({ path: '../escape.mjs', sha256: hash('x'), base64: Buffer.from('x').toString('base64') });
  assert.equal((await call(service, 'api/publications', { artifact: invalidTraversal, redistributionAcknowledged: true }, admin)).status, 400);
  assert.equal((await call(service, 'api/publications', { artifact: moduleArtifact(), redistributionAcknowledged: true }, admin)).status, 201, 'an upload failure releases the single-upload slot');
});

test('owned durable store restart, session preservation, private stopped export and migration', async t => {
  const { root, service } = await fixture(); const admin = await login(service); const artifact = moduleArtifact(); const published = await call(service, 'api/publications', { artifact, redistributionAcknowledged: true }, admin);
  await assert.rejects(WorkshopStore.open({ root }), { code: 'WORKSHOP_LOCKED' }); await service.close(); await absent(join(root, 'workshop-owner.lock'));
  const reopened = await WorkshopStore.open({ root }); t.after(() => reopened.close());
  assert.equal(reopened.userForSession(admin.cookie.split('=')[1]).username, 'admin'); assert.equal(reopened.catalog().total, 1); assert.equal(hash(await reopened.artifactBytes(published.body.publication.sha256)), published.body.publication.sha256);
  const parent = await directory(), exported = join(parent, 'new-private-export'); const report = await reopened.exportTo(exported); assert.equal(report.artifacts, 1); assert.equal(report.containsCredentials, true); await absent(join(exported, 'workshop-owner.lock'));
  const migrated = await WorkshopStore.open({ root: exported }); try { assert.equal(migrated.catalog().total, 1); assert.equal(migrated.userForSession(admin.cookie.split('=')[1]).username, 'admin'); } finally { await migrated.close(); }
  await assert.rejects(reopened.exportTo(exported), { code: 'EEXIST' });
  await assert.rejects(initializeAdmin({ root: exported, username: 'another', password }), { code: 'ALREADY_INITIALIZED' });
});

test('artifact quota and symlinks refuse unsafe persistence without orphan metadata', async t => {
  const root = await directory(); const store = await WorkshopStore.open({ root, diskQuota: MAX_UPLOAD }); t.after(() => store.close());
  const user = await store.initializeAdmin('admin', password); store.totalArtifactBytes = MAX_UPLOAD;
  await assert.rejects(store.publish(user, { artifact: moduleArtifact(), redistributionAcknowledged: true }), { code: 'ARTIFACT_QUOTA' }); assert.equal(store.catalog().total, 0);
  const target = join(root, 'linked-artifact.json');
  try { await symlink(join(root, 'metadata.json'), target); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('OS did not grant symlink creation; separate source path traversal rejection remains exercised.'); return; } throw error; }
  await assert.rejects(WorkshopStore.open({ root: target }), /Symbolic links|reparse/);
});

test('production configuration preserves Secure cookie and fixed source base without trusting proxy headers', async t => {
  const root = await directory(); await initializeAdmin({ root, username: 'admin', password });
  await assert.rejects(createWorkshopServer({ root, baseURL: 'https://peros.cn/workshop', secureCookie: false }), { code: 'INVALID_CONFIG' });
  await assert.rejects(createWorkshopServer({ root, baseURL: 'http://example.test/workshop', allowInsecureLoopback: true }), { code: 'INVALID_CONFIG' });
  await assert.rejects(createWorkshopServer({ root, bind: '0.0.0.0' }), { code: 'INVALID_CONFIG' });
  const probe = createWorkshopServer({ root, baseURL: 'https://peros.cn/workshop', port: 18970 });
  const service = await probe; t.after(() => service.close());
  const local = { ...service, url: `http://127.0.0.1:${service.port}/workshop/` };
  const response = await call(local, 'api/login', { username: 'admin', password }, null, { host: 'peros.cn', 'x-forwarded-for': 'attacker', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure/); assert.equal(service.baseURL, 'https://peros.cn/workshop');
  assert.equal((await call(local, 'api/login', { username: 'admin', password }, null, { host: 'peros.cn', origin: 'https://attacker.example', 'x-forwarded-host': 'peros.cn' })).status, 403);
});

test('partial artifact write failure cannot publish a canonical file and durable restart remains usable', async t => {
  const root = await directory(), store = await WorkshopStore.open({ root }); const user = await store.initializeAdmin('admin', password);
  const probe = await open(join(root, 'probe-file'), 'wx'); const prototype = Object.getPrototypeOf(probe); const original = prototype.writeFile; await probe.close();
  const mock = t.mock.method(prototype, 'writeFile', async function (bytes, ...args) {
    if (Buffer.isBuffer(bytes) && bytes.toString('utf8', 0, 100).includes('world-hub.source-artifact/v1')) { await original.call(this, bytes.subarray(0, 16), ...args); throw Object.assign(new Error('Injected interrupted artifact write'), { code: 'EIO' }); }
    return original.call(this, bytes, ...args);
  });
  await assert.rejects(store.publish(user, { artifact: moduleArtifact(), redistributionAcknowledged: true }), { code: 'EIO' }); mock.mock.restore();
  assert.deepEqual(await readdir(join(root, 'artifacts')), []); assert.equal(store.catalog().total, 0); await store.close();
  const reopened = await WorkshopStore.open({ root }); t.after(() => reopened.close());
  assert.equal((await reopened.publish(user, { artifact: moduleArtifact(), redistributionAcknowledged: true })).duplicate, false);
  assert.equal(reopened.catalog().total, 1);
});

test('private nonce stop requests gracefully release the current generation; forged requests cannot stop it', async t => {
  const { root, service } = await fixture(); t.after(() => service.close());
  await writeFile(join(root, 'workshop-stop.json'), JSON.stringify({ format: 'world-hub.workshop-stop/v1', nonce: '0'.repeat(36) }));
  await new Promise(resolveWait => setTimeout(resolveWait, 550)); assert.equal((await call(service, 'health')).status, 200);
  const { unlink } = await import('node:fs/promises'); await unlink(join(root, 'workshop-stop.json'));
  const config = join(root, 'private-config.json'); await writeFile(config, JSON.stringify({ root, baseURL: service.baseURL, port: service.port, allowInsecureLoopback: true, secureCookie: false }));
  await workshopMain(['--config', config, '--stop']); await service.closed;
  await absent(join(root, 'workshop-owner.lock')); await absent(join(root, 'workshop-stop.json'));
  const restart = await createWorkshopServer({ root, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false }); try { assert.equal((await call(restart, 'health')).status, 200); } finally { await restart.close(); }
});

test('pure pack validation and HTTP publication reject an undeclared Python runtime despite valid file hashes', async t => {
  const { root, service } = await fixture(); t.after(() => service.close()); const admin = await login(service), artifact = await samplePackArtifact();
  assert.equal(validateArtifactBytes(Buffer.from(JSON.stringify(artifact))).artifact.kind, 'pack');
  const lock = artifactJson(artifact, 'pack.lock'); assert.ok(lock.runtimes.python); delete lock.runtimes.python;
  replaceArtifactJson(artifact, 'pack.lock', lock);
  // The distribution bytes and each file digest are internally valid. The
  // rejection must concern the runtime promised by a module and omitted by lock.
  for (const file of artifact.files) assert.equal(hash(Buffer.from(file.base64, 'base64')), file.sha256);
  assert.throws(() => validateArtifactBytes(Buffer.from(JSON.stringify(artifact))), /module runtime is not locked/i);
  const metadataBefore = await readFile(join(root, 'metadata.json'), 'utf8');
  const response = await call(service, 'api/publications', { artifact, redistributionAcknowledged: true }, admin);
  assert.equal(response.status, 400); assert.equal(response.body.error.code, 'INVALID_ARTIFACT');
  assert.equal(await readFile(join(root, 'metadata.json'), 'utf8'), metadataBefore); assert.deepEqual(await readdir(join(root, 'artifacts')), []);
  assert.equal((await call(service, 'api/catalog')).body.total, 0);
});

test('pure pack validation and HTTP publication reject a module incompatible with the locked platform', async t => {
  const { root, service } = await fixture(); t.after(() => service.close()); const admin = await login(service), artifact = await samplePackArtifact();
  assert.equal(validateArtifactBytes(Buffer.from(JSON.stringify(artifact))).artifact.kind, 'pack');
  const lock = artifactJson(artifact, 'pack.lock'), module = lock.modules.find(m => m.id === 'demo.stats'); assert.ok(module);
  const manifestPath = `${module.source}/module.json`, manifest = artifactJson(artifact, manifestPath); manifest.platforms = ['haiku-x64'];
  assert.notEqual(`${lock.platform.os}-${lock.platform.arch}`, 'haiku-x64');
  const manifestSha = replaceArtifactJson(artifact, manifestPath, manifest);
  const lockedManifest = module.files.find(f => f.path === 'module.json'); assert.ok(lockedManifest); lockedManifest.sha256 = manifestSha;
  replaceArtifactJson(artifact, 'pack.lock', lock);
  for (const file of artifact.files) assert.equal(hash(Buffer.from(file.base64, 'base64')), file.sha256);
  assert.throws(() => validateArtifactBytes(Buffer.from(JSON.stringify(artifact))), /module does not support the locked platform/i);
  const metadataBefore = await readFile(join(root, 'metadata.json'), 'utf8');
  const response = await call(service, 'api/publications', { artifact, redistributionAcknowledged: true }, admin);
  assert.equal(response.status, 400); assert.equal(response.body.error.code, 'INVALID_ARTIFACT');
  assert.equal(await readFile(join(root, 'metadata.json'), 'utf8'), metadataBefore); assert.deepEqual(await readdir(join(root, 'artifacts')), []);
  assert.equal((await call(service, 'api/catalog')).body.total, 0);
});

test('numeric registration usernames are rejected without consuming an invitation or changing metadata', async t => {
  const { root, service } = await fixture(); t.after(() => service.close()); const admin = await login(service);
  const invited = await call(service, 'api/invitations', {}, admin); assert.equal(invited.status, 201);
  const metadataBefore = await readFile(join(root, 'metadata.json'), 'utf8');
  const rejected = await call(service, 'api/register', { username: 123, password, invitation: invited.body.invitation });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error.code, 'INVALID_USERNAME');
  assert.equal(await readFile(join(root, 'metadata.json'), 'utf8'), metadataBefore);
  const accepted = await call(service, 'api/register', { username: 'numeric-retry', password, invitation: invited.body.invitation });
  assert.equal(accepted.status, 201); assert.equal(accepted.body.user.username, 'numeric-retry');
  const authenticated = await call(service, 'api/login', { username: 'numeric-retry', password }); assert.equal(authenticated.status, 200);
});

test('administrator bootstrap rejects numeric usernames and loading refuses numeric account metadata', async t => {
  const root = await directory(), store = await WorkshopStore.open({ root });
  const metadataBefore = await readFile(join(root, 'metadata.json'), 'utf8');
  await assert.rejects(store.initializeAdmin(123, password), { code: 'INVALID_USERNAME', status: 400 });
  assert.equal(await readFile(join(root, 'metadata.json'), 'utf8'), metadataBefore); assert.equal(store.state.users.length, 0);
  await store.initializeAdmin('admin', password); await store.close();
  const poisoned = JSON.parse(await readFile(join(root, 'metadata.json'), 'utf8')); poisoned.users[0].username = 123;
  const poisonedBytes = JSON.stringify(poisoned) + '\n'; await writeFile(join(root, 'metadata.json'), poisonedBytes);
  await assert.rejects(WorkshopStore.open({ root }), { code: 'INVALID_STORE', status: 500 });
  assert.equal(await readFile(join(root, 'metadata.json'), 'utf8'), poisonedBytes); await absent(join(root, 'workshop-owner.lock'));
});

test('non-ASCII CSRF of equal JavaScript length is rejected with 403 without changing metadata', async t => {
  const { root, service } = await fixture(); t.after(() => service.close()); const admin = await login(service);
  assert.equal(admin.csrfToken.length, 64); const malformed = 'é'.repeat(64);
  assert.equal(malformed.length, admin.csrfToken.length); assert.notEqual(Buffer.byteLength(malformed), Buffer.byteLength(admin.csrfToken));
  const metadataBefore = await readFile(join(root, 'metadata.json'), 'utf8');
  const denied = await call(service, 'api/invitations', {}, admin, { 'x-csrf-token': malformed });
  assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'CSRF_REQUIRED');
  assert.equal(await readFile(join(root, 'metadata.json'), 'utf8'), metadataBefore);
  assert.equal((await call(service, 'api/invitations', {}, admin)).status, 201, 'the valid ASCII token still authorizes a subsequent request');
});
