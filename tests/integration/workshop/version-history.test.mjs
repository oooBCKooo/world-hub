import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkshopStore } from '../../../tools/workshop/store.mjs';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { readSourceIndex, fetchSourceArtifact } from '../../../scripts/runtime/sources.mjs';
import { mirrorWorkshop, workshopCall } from './phase18-helpers.mjs';

const password = 'version-history-fixture-password';
const encoded = (path, content) => {
  const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content) + '\n');
  return { path, sha256: hash(bytes), base64: bytes.toString('base64') };
};
function artifact(kind, version) {
  const id = 'test.history-module';
  const manifest = { format: 'world-hub.module/v1', id, version: kind === 'module' ? version : '1.0.0', license: 'MIT', platforms: ['win32-x64', 'linux-x64'], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
  // If a downloader or preview executes this file, this test must fail.
  const files = [encoded('module.json', manifest), encoded('program.mjs', "throw new Error('Historical source was executed instead of downloaded');\n")];
  if (kind === 'module') return { format: 'world-hub.source-artifact/v1', kind, id, version, files, provenance: { redistributionAcknowledged: true } };
  const metadata = {id:'test.history-'+kind,version,title:'Version history '+kind,license:'MIT',platforms:manifest.platforms,provides:[],requires:[],scope:'global'};
  const reference = {id,version:'1.0.0',digest:'a'.repeat(64)};
  const document = kind === 'configuration' ? {format:'world-hub.configuration/v1',...metadata,modules:[{id:'widget',module:reference,configuration:{topics:{events:'test/history/events'},bridges:{main:{publish:['events'],subscribe:[]}},settings:{},bindings:[]}}],startupPlan:{members:[{programId:'widget',enabled:false,after:[]}],onFailure:'continue-independent',startupOrder:['widget']}}
    : {format:'world-hub.module-data/v1',...metadata,purpose:'dataset',instances:[{id:'widget',module:reference,path:'data/widget',dataFormat:{id:'test.rows',version:'1.0.0'}}]};
  return {format:'world-hub.source-artifact/v1',kind,id:document.id,version,files:[encoded(kind+'.json',document),...(kind === 'data' ? [encoded('data/widget/rows.json',{version})] : [])],provenance:{redistributionAcknowledged:true}};
}

for (const kind of ['module', 'configuration', 'data']) test(`${kind} historical releases remain selectable and exact downloads never resolve to the latest release`, async t => {
  const parent = resolve('.artifacts/workshop-history-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')), data = join(root, 'data');
  const initial = await WorkshopStore.open({ root: data }); await initial.initializeAdmin('admin', password); await initial.close();
  const service = await createWorkshopServer({ root: data, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false });
  t.after(() => service.close());
  const session = await workshopCall(service, 'api/login', { username: 'admin', password });
  const actor = { ...session.data, cookie: session.cookie }, published = new Map();
  // History can be backfilled after the newest release has already shipped.
  for (const version of ['3.0.0', '1.0.0', '2.0.0']) published.set(version, (await workshopCall(service, 'api/publications', { artifact: artifact(kind, version), redistributionAcknowledged: true }, actor, 201)).data.publication);
  const latest = published.get('3.0.0'), oldest = published.get('1.0.0');
  const catalog = (await workshopCall(service, 'api/catalog')).data;
  assert.equal(catalog.total, 1); assert.equal(catalog.publications[0].entryId, latest.entryId); assert.equal(catalog.publications[0].versionCount, 3);
  const detail = (await workshopCall(service, `api/publications/${latest.entryId}`)).data;
  assert.deepEqual(detail.versions.map(row => row.version), ['3.0.0', '2.0.0', '1.0.0']);
  const mirror = await mirrorWorkshop(service, join(root, 'mirror')), observed = await readSourceIndex(mirror.indexPath);
  assert.deepEqual(observed.index.entries.map(row => row.version).sort(), ['1.0.0', '2.0.0', '3.0.0']);
  const fetched = await fetchSourceArtifact(mirror.indexPath, observed.digest, oldest.entryId, { cacheRoot: join(root, 'cache') });
  assert.equal(fetched.entry.version, '1.0.0'); assert.equal(fetched.kind, kind);
  assert.equal(fetched.entry.sha256, oldest.sha256); assert.notEqual(fetched.entry.sha256, latest.sha256);
  const cachedArtifact = JSON.parse(await readFile(join(root, 'cache', oldest.sha256 + '.artifact.json'), 'utf8'));
  assert.deepEqual(cachedArtifact, artifact(kind, '1.0.0'));
  assert.equal(fetched.startsModules, false); assert.equal(fetched.requiresExecutionReview, kind === 'module');
  const selected = (await workshopCall(service, `api/publications/${oldest.entryId}`)).data;
  assert.equal(selected.publication.sha256, oldest.sha256); assert.equal(selected.publication.version, '1.0.0');
  const before = await service.store.artifactBytes(oldest.sha256);
  // Explicit moderation hides one version, rather than deleting every older release.
  await workshopCall(service, `api/publications/${latest.entryId}/visibility`, { hidden: true }, actor);
  const fallback = (await workshopCall(service, 'api/catalog')).data;
  assert.equal(fallback.publications[0].version, '2.0.0'); assert.equal(fallback.publications[0].versionCount, 2);
  assert.deepEqual((await workshopCall(service, `api/publications/${oldest.entryId}`)).data.versions.map(row => row.version), ['2.0.0', '1.0.0']);
  assert.ok((await service.store.artifactBytes(oldest.sha256)).equals(before));
  const cachedManifest = await readFile(join(fetched.directory, kind + '.json'), 'utf8');
  assert.equal(JSON.parse(cachedManifest).version, '1.0.0');
});
