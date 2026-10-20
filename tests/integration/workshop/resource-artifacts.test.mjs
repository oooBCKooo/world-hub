import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { sourceFilesDigest } from '../../../scripts/runtime/resource-artifacts.mjs';
import { validateArtifactBytes, validateSourceIndex } from '../../../scripts/runtime/sources.mjs';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';
import { WorkshopStore, MAX_UPLOAD } from '../../../tools/workshop/store.mjs';
import { renderArtifactConfiguration } from '../../../tools/workshop/public/artifact-config-view.mjs';
import { workshopCall, registerMember } from './phase18-helpers.mjs';

const password = 'resource-tests-local-password';
const encode = value => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
const file = (path, value) => { const bytes = encode(value); return { path, sha256:hash(bytes), base64:bytes.toString('base64') }; };
const metadata = (version, scope = 'global') => ({ id:'resource.example', version, title:'Resource example', license:'MIT', platforms:['win32-x64','linux-x64'], provides:[], requires:[], scope });
function resources(version = '1.0.0', sentinel = '', scope = 'global', purpose = 'dataset') {
  const manifest = { ...metadata(version), format:'world-hub.module/v1', runtime:{ kind:'node', entry:'program.mjs' }, bridges:['main'],
    permissions:{ filesystem:'instance-state', network:['hub-loopback'], processes:'none' } }; delete manifest.scope; delete manifest.title;
  const module = { format:'world-hub.source-artifact/v1', kind:'module', id:manifest.id, version,
    files:[file('module.json',manifest),file('program.mjs',`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`)], provenance:{redistributionAcknowledged:true} };
  const reference = { id:module.id, version, digest:sourceFilesDigest(module.files.map(({path,sha256}) => ({path,sha256}))) };
  const configurationManifest = { ...metadata(version,scope), format:'world-hub.configuration/v1', modules:[{id:'reader',module:reference,
    configuration:{topics:{events:'resource/events'},bridges:{main:{publish:['events'],subscribe:[]}},settings:{label:'public dataset'},bindings:[],executionDefaults:{mode:'on-demand',idleTimeoutMs:12000}}}],
    startupPlan:{members:[{programId:'reader',enabled:true,after:[]}],startupOrder:['reader'],onFailure:'continue-independent'} };
  const configuration = { format:module.format, kind:'configuration', id:module.id, version, files:[file('configuration.json',configurationManifest)], provenance:{redistributionAcknowledged:true} };
  const dataManifest = { ...metadata(version,scope), format:'world-hub.module-data/v1', purpose,
    instances:[{id:'reader',module:reference,path:'data/reader',dataFormat:{id:'reader.raw',version:'1.0.0'}}] };
  const data = { format:module.format, kind:'data', id:module.id, version,
    files:[file('data.json',dataManifest),file('data/reader/records.bin',Buffer.from([0,255,195,40,10])),file('data/reader/do-not-execute.mjs',module.files[1] ? Buffer.from(module.files[1].base64,'base64') : '')], provenance:{redistributionAcknowledged:true} };
  return { module, configuration, data };
}
async function fixture(t) {
  const base = resolve('.artifacts/workshop-resource-tests'); await mkdir(base,{recursive:true}); const root = await mkdtemp(join(base,'case-'));
  const store = await WorkshopStore.open({root}); await store.initializeAdmin('admin',password); await store.close();
  const service = await createWorkshopServer({root,baseURL:'http://127.0.0.1:0/workshop',port:0,allowInsecureLoopback:true,secureCookie:false});
  t.after(() => service.close()); const login = await workshopCall(service,'api/login',{username:'admin',password});
  return {root,service,actor:{...login.data,cookie:login.cookie}};
}
const publish = async (service,actor,artifact,status = 201) => (await workshopCall(service,'api/publications',{artifact,redistributionAcknowledged:true},actor,status)).data;

test('three independently versioned kinds publish over HTTP, discover historical versions and download their exact original bytes without execution', async t => {
  const {root,service,actor} = await fixture(t), sentinel = join(root,'must-not-exist'), published = [];
  for (const version of ['1.0.0','2.0.0']) for (const artifact of Object.values(resources(version,sentinel,version === '1.0.0' ? 'global' : 'local'))) {
    const result = await publish(service,actor,artifact), bytes = encode(artifact);
    assert.equal(result.publication.sha256,hash(bytes)); published.push({artifact,bytes,publication:result.publication});
  }
  const source = (await workshopCall(service,'index.json')).data;
  assert.equal(source.entries.length,6);
  // Production source validation rejects HTTP loopback; replacing transport URLs
  // here tests the source document without weakening the live network policy.
  validateSourceIndex({...source,entries:source.entries.map(entry => ({...entry,source:{path:`artifacts/${entry.sha256}.json`}}))});
  const catalog = (await workshopCall(service,'api/catalog')).data;
  assert.equal(catalog.total,3); assert.deepEqual(catalog.publications.map(p => p.kind).sort(),['configuration','data','module']);
  for (const kind of ['module','configuration','data']) {
    const filtered = (await workshopCall(service,`api/catalog?kind=${kind}`)).data;
    assert.equal(filtered.total,1); assert.equal(filtered.publications[0].version,'2.0.0'); assert.equal(filtered.publications[0].versionCount,2);
    const first = published.find(row => row.artifact.kind === kind), detail = (await workshopCall(service,`api/publications/${first.publication.entryId}`)).data;
    assert.deepEqual(detail.versions.map(row => row.version),['2.0.0','1.0.0']); assert.equal(detail.configuration.sha256,first.publication.sha256);
    const preview = (await workshopCall(service,'api/artifacts/preview',{artifact:first.artifact},actor)).data.configuration;
    assert.deepEqual(preview,detail.configuration);
    if (kind === 'configuration') { assert.equal(preview.scope,'global'); assert.equal(preview.modules[0].module.digest,JSON.parse(Buffer.from(first.artifact.files[0].base64,'base64')).modules[0].module.digest); assert.equal(preview.modules[0].executionDefaults.source,'configuration'); assert.equal(preview.modules[0].manifest,undefined); }
    if (kind === 'data') { assert.equal(preview.purpose,'dataset'); assert.equal(preview.fileCount,2); assert.equal(preview.instances[0].dataFormat.id,'reader.raw'); assert.equal(preview.instances[0].files[0].byteSize,5); }
  }
  for (const {artifact,bytes,publication} of published) {
    const entry = source.entries.find(entry => entry.entryId === publication.entryId), response = await fetch(entry.source.url);
    assert.equal(response.status,200); const downloaded = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(downloaded),entry.sha256); assert.deepEqual(downloaded,bytes); assert.equal(validateArtifactBytes(downloaded).entry.kind,artifact.kind);
    for (const original of artifact.files) assert.deepEqual(Buffer.from(JSON.parse(downloaded).files.find(item => item.path === original.path).base64,'base64'),Buffer.from(original.base64,'base64'));
  }
  await assert.rejects(lstat(sentinel),{code:'ENOENT'});
});

test('community APIs refuse retired module groups and private backups before storage, including preview and proposal uploads', async t => {
  const {root,service,actor} = await fixture(t), artifacts = resources(), publication = (await publish(service,actor,artifacts.data)).publication;
  const retired = {...artifacts.configuration,kind:'module-group'}, backup = resources('2.0.0','','local','backup').data;
  for (const artifact of [retired,backup]) {
    const expected = artifact.kind === 'module-group' ? 'ARTIFACT_KIND_RETIRED' : 'PRIVATE_BACKUP';
    assert.equal((await publish(service,actor,artifact,400)).error.code,expected);
    assert.equal((await workshopCall(service,'api/artifacts/preview',{artifact},actor,400)).data.error.code,expected);
    assert.equal((await workshopCall(service,`api/publications/${publication.entryId}/proposals`,{artifact,baseSha256:publication.sha256,redistributionAcknowledged:true},actor,400)).data.error.code,expected);
  }
  await workshopCall(service,'api/catalog?kind=module-group',undefined,null,400);
  assert.equal(service.store.state.publications.length,1); assert.equal((await readdir(join(root,'artifacts'))).length,1);
});

test('configuration and dataset versions retain immutability, collaboration and visibility boundaries', async t => {
  const {service,actor} = await fixture(t), owner = await registerMember(service,actor,'resource-owner',password), author = await registerMember(service,actor,'resource-author',password);
  for (const kind of ['configuration','data']) {
    const artifact = resources()[kind], result = await publish(service,owner,artifact), publication = result.publication;
    assert.equal((await publish(service,owner,artifact,200)).duplicate,true);
    const changed = structuredClone(artifact); changed.files[0] = file(changed.files[0].path,{...JSON.parse(Buffer.from(changed.files[0].base64,'base64')),title:'Changed same version'});
    assert.equal((await publish(service,owner,changed,409)).error.code,'IMMUTABLE_VERSION');
    const comment = (await workshopCall(service,`api/publications/${publication.entryId}/comments`,{text:'Reviewed exact resource version'},author,201)).data.comment;
    assert.equal(comment.author.username,'resource-author');
    const proposal = (await workshopCall(service,`api/publications/${publication.entryId}/proposals`,{artifact:resources('1.1.0')[kind],baseSha256:publication.sha256,redistributionAcknowledged:true},author,201)).data.proposal;
    assert.equal(proposal.kind,kind); const proposed = (await workshopCall(service,`api/publications/${publication.entryId}/proposals/${proposal.id}`)).data;
    assert.equal(hash(encode(proposed.artifact)),proposal.sha256);
    await workshopCall(service,`api/publications/${publication.entryId}/visibility`,{hidden:true},actor);
    await workshopCall(service,`api/publications/${publication.entryId}/configuration`,undefined,null,404);
    assert.equal((await fetch(`${service.baseURL}/artifacts/${publication.sha256}.json`)).status,404);
    assert.equal((await workshopCall(service,`api/publications/${publication.entryId}/configuration`,undefined,owner)).data.kind,kind);
  }
});

test('retired persisted records remain unchanged on restart and cannot be discovered or downloaded', async t => {
  const {root,service,actor} = await fixture(t), published = (await publish(service,actor,resources().module)).publication;
  await service.close(); const path = join(root,'metadata.json'), state = JSON.parse(await readFile(path,'utf8'));
  state.publications[0].kind = 'module-group'; state.publications[0].entry.kind = 'module-group';
  await writeFile(path,JSON.stringify(state)+'\n'); const before = await readFile(path,'utf8');
  const reopened = await createWorkshopServer({root,baseURL:'http://127.0.0.1:0/workshop',port:0,allowInsecureLoopback:true,secureCookie:false}); t.after(() => reopened.close());
  assert.equal((await workshopCall(reopened,'api/catalog')).data.total,0); assert.equal((await workshopCall(reopened,'index.json')).data.entries.length,0);
  await workshopCall(reopened,`api/publications/${published.entryId}`,undefined,null,404);
  assert.equal((await fetch(`${reopened.baseURL}/artifacts/${published.sha256}.json`)).status,404);
  assert.equal(await readFile(path,'utf8'),before);
});

test('artifact uploads remain bounded at the HTTP boundary after raising the JSON limit to 96 MiB', async t => {
  const {service,actor} = await fixture(t); assert.equal(MAX_UPLOAD,96*1024*1024);
  const status = await new Promise((resolveResponse,reject) => {
    const upload = request(new URL('api/artifacts/preview',service.url),{method:'POST',headers:{origin:service.origin,'content-type':'application/json','content-length':MAX_UPLOAD+1025,cookie:actor.cookie,'x-csrf-token':actor.csrfToken}},response => { response.resume(); response.on('end',() => resolveResponse(response.statusCode)); });
    upload.on('error',reject); upload.end('{');
  });
  assert.equal(status,413); assert.equal(service.store.artifacts.size,0);
});

test('a dataset with two individually bounded files uploads and downloads more than 8 MiB over real HTTP', async t => {
  const {service,actor} = await fixture(t), artifact = resources().data;
  artifact.files = [artifact.files[0],file('data/reader/part-one.bin',Buffer.alloc(5*1024*1024,0xff)),file('data/reader/part-two.bin',Buffer.alloc(4*1024*1024,0x17))];
  const original = encode(artifact); assert.ok(original.length > 8*1024*1024);
  validateArtifactBytes(original);
  const {publication} = await publish(service,actor,artifact);
  const preview = (await workshopCall(service,`api/publications/${publication.entryId}/configuration`)).data;
  assert.equal(preview.byteSize,9*1024*1024); assert.equal(preview.fileCount,2);
  const response = await fetch(`${service.baseURL}/artifacts/${publication.sha256}.json`), downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200); assert.equal(hash(downloaded),publication.sha256); assert.deepEqual(downloaded,original);
});

class Element {
  constructor(tag,value = '') { this.tag = tag; this.textContent = value; this.children = []; this.attributes = {}; }
  setAttribute(key,value) { this.attributes[key] = String(value); }
  append(...children) { this.children.push(...children); }
}
const document = {createElement:tag => new Element(tag),createTextNode:value => new Element('#text',String(value))};
const text = node => [node.textContent,...node.children.map(text)].join('\n');
test('validated configuration and dataset previews show scopes, exact dependencies and data sizes in both languages', async t => {
  const {service,actor} = await fixture(t);
  for (const [kind,required] of [['configuration',['Logical instances','resource.example@1.0.0','On demand','events','public dataset']],['data',['Ready-to-use dataset','reader.raw@1.0.0','records.bin','5 B']]]) {
    const configuration = (await workshopCall(service,'api/artifacts/preview',{artifact:resources()[kind]},actor)).data.configuration;
    const english = text(renderArtifactConfiguration(configuration,{language:'en',document}));
    for (const phrase of required) assert.ok(english.toLowerCase().includes(phrase.toLowerCase()),phrase);
    assert.match(english,/Global/); assert.doesNotMatch(english,/Module group|Group startup/);
    const chinese = text(renderArtifactConfiguration(configuration,{language:'zh',document})); assert.match(chinese,/全局/);
    assert.equal(text(renderArtifactConfiguration({...configuration,scope:'local'},{language:'zh',document})).includes('局部'),true);
  }
});
