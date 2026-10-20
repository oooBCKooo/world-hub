import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { publishArtifact, validateArtifactBytes, readSourceIndex, fetchSourceArtifact, attachPublisherEvidence } from '../../../scripts/runtime/sources.mjs';
import { generatePublisherKey, signPublisherEvidence } from '../../../scripts/runtime/publisher-trust.mjs';
import { validateConfiguration, validateConfigurationFiles, validateDataFiles, readResourceFiles } from '../../../scripts/runtime/resource-artifacts.mjs';
import { hash, ordinaryPath } from '../../../scripts/runtime/paths.mjs';
import { importLocalArtifact } from '../../../tools/launcher/local-artifacts.mjs';
import { zipDirectory } from '../../../scripts/release/zip.mjs';
import { PathsService } from '../../../tools/launcher/paths-service.mjs';
import { SourceRegistry } from '../../../tools/launcher/source-registry.mjs';
import { verifyStoredPublisherEvidence, readPublisherTrust } from '../../../scripts/runtime/publisher-store.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const contract = { id:'text.convert', version:'1.0.0' };
const encoded = (path, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : json(value)); return {path,sha256:hash(bytes),base64:bytes.toString('base64')}; };
const manifestAt = async (directory, kind) => JSON.parse(await readFile(join(directory, kind+'.json')));
async function fixture(t) {
  const base = resolve('.artifacts/resource-distribution-tests'); await mkdir(base,{recursive:true});
  const root = await mkdtemp(join(base,'case-'));
  t.after(async () => { const target = await ordinaryPath(root); assert.equal(dirname(target),await ordinaryPath(base)); assert.ok(target.startsWith(join(base,'case-'))); await rm(target,{recursive:true,force:false}); });
  const config = (publish,subscribe,bindings = []) => ({topics:{value:'demo/value'},bridges:{main:{publish,subscribe}},settings:{text:'Demo'},bindings});
  const metadata = {id:'text-desk',version:'1.2.3',title:'Text desk',license:'MIT',platforms:[`${process.platform}-${process.arch}`],provides:[contract],requires:[]};
  const configuration = {format:'world-hub.configuration/v1',...metadata,scope:'global',modules:[
    {id:'source',module:{id:'text.source',version:'2.0.0',digest:'a'.repeat(64)},configuration:config(['value'],[])},
    {id:'screen',module:{id:'text.screen',version:'3.0.0',digest:'b'.repeat(64)},configuration:config([],['value'],[{providerId:'source',contract}])}],
    startupPlan:{members:[{programId:'source',enabled:true,after:[]},{programId:'screen',enabled:false,after:['source']}],onFailure:'continue-independent',startupOrder:['source','screen']}};
  const data = {format:'world-hub.module-data/v1',...metadata,scope:'local',purpose:'dataset',instances:configuration.modules.map(member => ({id:member.id,module:member.module,path:'data/'+member.id,dataFormat:{id:'text.rows',version:'1.0.0'}}))};
  const directories = {}, publications = {}, artifacts = {};
  for (const [kind,manifest] of Object.entries({configuration,data})) {
    const directory = directories[kind] = join(root,kind); await mkdir(directory); await writeFile(join(directory,kind+'.json'),json(manifest));
    if (kind === 'data') for (const member of manifest.instances) { await mkdir(join(directory,member.path),{recursive:true}); await writeFile(join(directory,member.path,'rows.bin'),Buffer.from([0,255,195,40])); }
    publications[kind] = await publishArtifact(directory,{kind,redistributionAcknowledged:true,destination:join(root,'publication-'+kind)});
    artifacts[kind] = JSON.parse(await readFile(publications[kind].artifactPath));
  }
  return {root,configuration,data,directories,publications,artifacts};
}
function changeFile(artifact,path,update) {
  const file = artifact.files.find(file => file.path === path), value = JSON.parse(Buffer.from(file.base64,'base64'));
  update(value); Object.assign(file,encoded(path,value));
}

test('configuration and data publish, source fetch, directory, JSON and ZIP import preserve logical instances without execution', async t => {
  const fixtureValue = await fixture(t), {root,directories,publications,artifacts} = fixtureValue;
  for (const kind of ['configuration','data']) {
    const manifest = fixtureValue[kind], publication = publications[kind], directory = directories[kind];
    const validated = validateArtifactBytes(await readFile(publication.artifactPath));
    assert.equal(validated.entry.kind,kind); assert.equal(validated.entry.title,manifest.title); assert.deepEqual(validated.manifest,manifest);
    if (kind === 'configuration') assert.deepEqual(validated.decoded.map(file => file.path),['configuration.json']);
    const index = await readSourceIndex(publication.indexPath), fetched = await fetchSourceArtifact(index.source,index.digest,index.index.entries[0].entryId,{cacheRoot:join(root,'cache-'+kind)});
    assert.equal(fetched.kind,kind); assert.equal(fetched.startsModules,false); assert.equal(fetched.requiresExecutionReview,false);
    assert.deepEqual(await manifestAt(fetched.directory,kind),manifest);
    assert.equal((await importLocalArtifact({root,path:directory})).object.kind,kind);
    const imported = await importLocalArtifact({root,path:publication.artifactPath,kind});
    assert.equal(imported.object.memberCount,2); assert.equal(imported.startsModules,false); assert.deepEqual(await manifestAt(imported.object.path,kind),manifest);
    const archive = join(root,kind+'.zip'); await zipDirectory(directory,archive); const zipped = await importLocalArtifact({root,path:archive});
    assert.equal(zipped.object.kind,kind); assert.equal(zipped.object.memberCount,2); assert.equal(zipped.object.requiresReview,true);
    assert.deepEqual(await manifestAt(zipped.object.path,kind),manifest);
    await assert.rejects(importLocalArtifact({root,path:publication.artifactPath,kind:'module'}),/Choose a module distribution/);
    assert.deepEqual(JSON.parse(await readFile(publication.artifactPath)),artifacts[kind]);
    if (kind === 'data') assert.deepEqual(await readFile(join(zipped.object.path,'data/source/rows.bin')),Buffer.from([0,255,195,40]));
  }
});

test('configuration validation rejects malformed pins, unsafe fields, private settings and impossible logical startup or capability wiring', async t => {
  const {artifacts} = await fixture(t), artifact = artifacts.configuration;
  const mutations = [
    value => { value.modules[0].path = '../outside'; },
    value => { value.modules[1].module.digest = 'not-a-digest'; },
    value => { value.modules[1].id = value.modules[0].id; },
    value => { value.modules[0].module.id = '../unrelated.source'; },
    value => { value.modules[0].module.version = 'latest'; },
    value => { value.modules[0].configuration.settings.apiToken = 'private'; },
    value => { value.modules[0].configuration.settings.nested = {password:'private'}; },
    value => { value.modules[0].configuration.topics.value = 'demo/#'; },
    value => { value.modules[0].configuration.bridges.other = {publish:['unknown'],subscribe:[]}; },
    value => { value.modules[1].configuration.bindings[0].providerId = 'missing'; },
    value => { value.modules[1].configuration.bindings[0].contract.version = 'latest'; },
    value => { value.startupPlan.startupOrder = ['screen','source']; },
    value => { value.startupPlan.members[0].after = ['screen']; },
    value => { value.startupPlan.members[1].enabled = 'yes'; },
    value => { value.hub = {port:51780}; },
    value => { value.runtime = {entry:'program.mjs'}; }
  ];
  for (const mutation of mutations) { const changed = structuredClone(artifact); changeFile(changed,'configuration.json',mutation); assert.throws(() => validateArtifactBytes(changed)); }
  assert.throws(() => validateConfiguration({...JSON.parse(Buffer.from(artifact.files[0].base64,'base64')),format:'world-hub.pack/v1'}));
});

test('configuration preserves every declared provider binding while source-dependent capability completeness waits for local review', async t => {
  const {artifacts} = await fixture(t), complete = structuredClone(artifacts.configuration), otherContract = {id:'text.describe',version:'2.0.0'};
  changeFile(complete,'configuration.json',value => { value.modules[1].configuration.bindings.push({providerId:'source',contract:otherContract}); });
  assert.equal(validateArtifactBytes(complete).manifest.modules[1].configuration.bindings.length,2);
  for (const required of [contract,otherContract]) {
    const partial = structuredClone(complete); changeFile(partial,'configuration.json',value => { value.modules[1].configuration.bindings = value.modules[1].configuration.bindings.filter(binding => binding.contract.id !== required.id); });
    const checked = validateArtifactBytes(partial); assert.equal(checked.manifest.modules[1].configuration.bindings.length,1);
    assert.equal(checked.modules,undefined,'a configuration cannot infer requires/provides from module references');
  }
  const self = structuredClone(complete); changeFile(self,'configuration.json',value => { value.modules[1].configuration.bindings[0].providerId = 'screen'; }); assert.throws(() => validateArtifactBytes(self),/another declared logical instance/);
  const duplicate = structuredClone(complete); changeFile(duplicate,'configuration.json',value => { value.modules[1].configuration.bindings.push(value.modules[1].configuration.bindings[0]); }); assert.throws(() => validateArtifactBytes(duplicate),/Duplicate capability binding/);
});

test('configuration preserves explicit pub/sub wiring without inventing capability bindings or embedding module sources', async t => {
  const {artifacts} = await fixture(t), pubsubOnly = structuredClone(artifacts.configuration);
  changeFile(pubsubOnly,'configuration.json',value => { value.modules[1].configuration.bindings = []; });
  const validated = validateArtifactBytes(pubsubOnly), members = validated.manifest.modules;
  assert.deepEqual(members[1].configuration.bindings,[]); assert.deepEqual(members[0].configuration.bridges.main.publish,['value']);
  assert.deepEqual(members[1].configuration.bridges.main.subscribe,['value']); assert.equal(members[0].configuration.topics.value,members[1].configuration.topics.value);
  assert.equal(validated.decoded.length,1); assert.equal(validated.modules,undefined);
});

test('resource file validation enforces manifest boundaries, opaque business subtrees, hashes, size bounds and archive integrity', async t => {
  const {artifacts,root,directories,configuration,data} = await fixture(t);
  for (const path of ['outside.mjs','modules/source/module.json','deployment.json','pack.lock','.env','.state/data.json','identity.json','subdir/module.json']) {
    const changed = structuredClone(artifacts.configuration); changed.files.push(encoded(path,'private')); assert.throws(() => validateArtifactBytes(changed),/configuration.json only/);
  }
  for (const path of ['outside.mjs','data/missing/rows.bin','identity.json','credentials.json']) {
    const changed = structuredClone(artifacts.data); changed.files.push(encoded(path,'private')); assert.throws(() => validateArtifactBytes(changed),/declared logical instance/);
  }
  const opaque = structuredClone(artifacts.data); opaque.files.push(encoded('data/source/identity.json','opaque business data')); validateArtifactBytes(opaque);
  const missing = structuredClone(artifacts.configuration); missing.files = []; assert.throws(() => validateArtifactBytes(missing),/distribution artifact/);
  const wrongDefault = structuredClone(artifacts.configuration); changeFile(wrongDefault,'configuration.json',value => { value.modules[0].configuration.executionDefaults = {mode:'execute-anything'}; }); assert.throws(() => validateArtifactBytes(wrongDefault),/Execution defaults/);
  const mismatched = structuredClone(artifacts.configuration); changeFile(mismatched,'configuration.json',value => { value.id = 'another.configuration'; }); assert.throws(() => validateArtifactBytes(mismatched),/identity/);
  const corrupt = structuredClone(artifacts.data); corrupt.files[0].sha256 = '0'.repeat(64); assert.throws(() => validateArtifactBytes(corrupt),/hash/);
  const tooLarge = structuredClone(artifacts.data); tooLarge.files[1].base64 = 'A'.repeat(Math.ceil(8*1024*1024/3)*4+4); assert.throws(() => validateArtifactBytes(tooLarge),/artifact file/);
  validateConfigurationFiles(configuration,await readResourceFiles(directories.configuration)); validateDataFiles(data,await readResourceFiles(directories.data));
  await writeFile(join(directories.configuration,'outside.mjs'),'throw new Error("outside source")'); const archive = join(root,'invalid.zip'); await zipDirectory(directories.configuration,archive);
  await assert.rejects(importLocalArtifact({root,path:archive}),/configuration.json only/);
});

test('source acquisition rejects retired pack/template kinds before artifact retrieval', async t => {
  const {root,publications} = await fixture(t);
  for (const kind of ['pack','template','module-group']) {
    const source = JSON.parse(await readFile(publications.configuration.indexPath)); source.entries[0].kind = kind; source.entries[0].entryId = kind+'.retired.1.0.0'; source.entries[0].source.path = 'does-not-exist.json';
    const path = join(root,kind+'-retired.json'); await writeFile(path,json(source)); const index = await readSourceIndex(path);
    await assert.rejects(fetchSourceArtifact(path,index.digest,source.entries[0].entryId,{cacheRoot:join(root,kind+'-retired-cache')}),/Unsupported distribution kind|Only current/);
  }
});

test('configuration and dataset publisher evidence binds exact bytes and never grants execution on acquisition', async t => {
  const {root,publications} = await fixture(t);
  for (const kind of ['configuration','data']) {
    const publication = publications[kind], entry = publication.index.entries[0], key = generatePublisherKey(), now = Date.now(), issuer = kind+'.author';
    const evidence = signPublisherEvidence({payload:{type:'artifact',issuer,keyId:key.keyId,sequence:1,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),subject:{kind:entry.kind,id:entry.id,version:entry.version,sha256:entry.sha256},details:{}},privateKeys:[key.privateKeyPem]});
    const attached = await attachPublisherEvidence(publication.directory,{evidenceBytes:Buffer.from(json(evidence))}), index = await readSourceIndex(attached.indexPath);
    const result = await fetchSourceArtifact(index.source,index.digest,entry.entryId,{cacheRoot:join(root,'signed-cache-'+kind)});
    assert.equal(result.publisherEvidence.signatureStatus,'verified'); assert.equal(result.publisherEvidence.publisherIdentity,'unanchored-key'); assert.equal(result.publisherEvidence.executionAuthorized,false); assert.equal(result.startsModules,false);
    const registry = new SourceRegistry(join(root,'trust-'+kind)); await registry.initialize();
    const change = {action:'anchor',issuer,publicKey:key.publicKey,role:'publisher',identityBasis:{type:'public-key-fingerprint',note:'Explicit resource fixture anchor'}};
    const preview = await registry.previewPublisherTrust(change); await registry.applyPublisherTrust({change,reviewDigest:preview.reviewDigest});
    const notice = signPublisherEvidence({payload:{type:'risk-notice',issuer,keyId:key.keyId,sequence:2,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),subject:{kind:'publisher',id:issuer},details:{artifacts:[{kind:entry.kind,id:entry.id,version:entry.version,sha256:entry.sha256}],severity:'info',message:'Resource test advisory',links:[]}},privateKeys:[key.privateKeyPem]});
    assert.equal((await verifyStoredPublisherEvidence({root:registry.root,evidenceBytes:Buffer.from(json(notice)),observe:true})).accepted,true);
    assert.equal((await readPublisherTrust({root:registry.root})).issuers[0].notices[0].artifacts[0].kind,kind);
  }
});

test('configuration and data library observation survive restart and removing references keeps original resource bytes', async t => {
  const fixtureValue = await fixture(t), {root,directories} = fixtureValue;
  for (const kind of ['configuration','data']) {
    const directory = directories[kind], libraryRoot = join(root,'library-'+kind), paths = new PathsService(libraryRoot); await paths.initialize();
    const checked = await paths.check({path:directory,purpose:kind}); assert.equal(checked.object.kind,kind); assert.equal(checked.object.checked,false); assert.equal(checked.object.startsModules,false); assert.equal(checked.object.memberCount,2);
    await paths.remember({path:directory,purpose:kind,library:true}); const restored = new PathsService(libraryRoot); await restored.initialize(); assert.equal(restored.library.length,1); assert.equal(restored.library[0].purpose,kind);
    const forgotten = await restored.forget({path:directory,purpose:kind}); assert.equal(forgotten.deletesFiles,false); assert.equal(restored.library.length,0); assert.deepEqual(await manifestAt(directory,kind),fixtureValue[kind]);
    const third = new PathsService(libraryRoot); await third.initialize(); assert.equal(third.library.length,0); assert.ok(third.hidden.includes(directory));
  }
});
