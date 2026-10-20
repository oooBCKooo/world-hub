import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../../scripts/runtime/source-guidance.mjs';
import { validateConfiguration, validateData, validateConfigurationFiles, validateDataFiles, sourceFilesDigest } from '../../../scripts/runtime/resource-artifacts.mjs';
import { publishArtifact, validateArtifactBytes, readSourceIndex, fetchSourceArtifact } from '../../../scripts/runtime/sources.mjs';
import { importLocalArtifact } from '../../../tools/launcher/local-artifacts.mjs';
import { PathsService } from '../../../tools/launcher/paths-service.mjs';

const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const metadata = { id:'resource.example', version:'1.0.0', title:'Resource fixture', license:'MIT', platforms:[`${process.platform}-${process.arch}`], provides:[], requires:[], scope:'local' };
const moduleRef = { id:'module.example', version:'1.0.0', digest:'1'.repeat(64) };
function configuration() {
  return { format:'world-hub.configuration/v1', ...structuredClone(metadata), modules:['first','second'].map(id => ({ id, module:structuredClone(moduleRef),
    configuration:{ topics:{ events:'resource/events' }, bridges:{ main:{publish:['events'],subscribe:[]} }, settings:{limit:3}, bindings:[] } })),
    startupPlan:{ members:[{programId:'first',enabled:true,after:[]},{programId:'second',enabled:false,after:['first']}], onFailure:'continue-independent', startupOrder:['first','second'] } };
}
function data(purpose = 'dataset') {
  return { format:'world-hub.module-data/v1', ...structuredClone(metadata), purpose,
    instances:[{id:'first',module:structuredClone(moduleRef),path:'data/first',dataFormat:{id:'example.business',version:'1.0.0'}}] };
}
const resourceFiles = (kind, manifest, extra = []) => [{path:`${kind}.json`,bytes:json(manifest)},...extra];
const encoded = (kind, manifest, decoded) => ({format:'world-hub.source-artifact/v1',kind,id:manifest.id,version:manifest.version,
  files:decoded.map(file => ({path:file.path,sha256:hash(file.bytes),base64:file.bytes.toString('base64')})),provenance:{redistributionAcknowledged:true}});
async function workspace() {
  const base = resolve('.artifacts/resource-contract-tests'); await mkdir(base,{recursive:true}); return mkdtemp(join(base,'case-'));
}
async function directory(root, kind, manifest, extras = []) {
  const path = join(root,kind); await mkdir(path);
  for (const file of resourceFiles(kind,manifest,extras)) {const target=join(path,file.path);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,file.bytes);}
  return path;
}
function crc32(bytes) { let crc=0xffffffff;for(const value of bytes){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; }
function zip(files, prefix = 'resource/') {
  const locals=[],central=[];let offset=0;
  for(const file of files) {
    const name=Buffer.from(prefix+file.path),header=Buffer.alloc(30),entry=Buffer.alloc(46),crc=crc32(file.bytes);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);header.writeUInt32LE(file.bytes.length,18);header.writeUInt32LE(file.bytes.length,22);header.writeUInt16LE(name.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(file.bytes.length,20);entry.writeUInt32LE(file.bytes.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    locals.push(header,name,file.bytes);central.push(entry,name);offset+=header.length+name.length+file.bytes.length;
  }
  const records=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(records.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,records,end]);
}

test('resource contracts: configuration pins standalone sources and logical wiring without carrying module bodies', () => {
  const manifest=configuration(); manifest.modules[1].configuration.bindings=[{providerId:'first',contract:{id:'example.contract',version:'1.0.0'}}];
  manifest.modules[1].configuration.executionDefaults={mode:'on-demand',idleTimeoutMs:1000};
  manifest.data=[{instanceId:'first',id:'example.dataset',version:'2.0.0',sha256:'2'.repeat(64)}];
  assert.equal(validateConfiguration(manifest),manifest);
  assert.equal(validateConfigurationFiles(manifest,resourceFiles('configuration',manifest)).manifest,manifest);
  assert.throws(()=>validateConfigurationFiles(manifest,resourceFiles('configuration',manifest,[{path:'module.json',bytes:Buffer.from('{}')}])));
  assert.throws(()=>validateConfigurationFiles(manifest,resourceFiles('configuration',configuration())));
});

test('resource contracts: closed configuration metadata, source pins, public settings, bindings and exact startup plans', () => {
  const changes=[m=>m.privateKey='no',m=>delete m.scope,m=>m.scope='shared',m=>m.modules[0].module.digest='A'.repeat(64),
    m=>m.modules[0].module.version='latest',m=>m.modules[0].path='module-source',m=>m.modules[0].module.source='/local/source',m=>m.modules[1].id='first',
    m=>m.modules[0].configuration.settings={nested:{accessToken:'no'}},m=>m.modules[0].configuration.credentials={},
    m=>m.modules[0].configuration.topics.other='resource/events',m=>m.modules[0].configuration.bridges.main.publish=['missing'],
    m=>m.modules[0].configuration.bindings=[{providerId:'first',contract:{id:'contract',version:'1.0.0'}}],
    m=>m.modules[0].configuration.bindings=[{providerId:'unknown',contract:{id:'contract',version:'1.0.0'}}],
    m=>m.startupPlan.startupOrder=['first'],m=>m.startupPlan.startupOrder=['second','first'],m=>m.startupPlan.members[1].after=['unknown'],
    m=>m.startupPlan.members[1].enabled=1,m=>m.modules[0].configuration.executionDefaults={mode:'on-demand',idleTimeoutMs:999},
    m=>m.data=[{instanceId:'missing',id:'data',version:'1.0.0',sha256:'2'.repeat(64)}],
    m=>m.modules[0].configuration.settings={long:'x'.repeat(65536)},m=>m.requires=[{id:'contract',version:'1.0.0',secret:'no'}]];
  for(const change of changes) {const manifest=configuration();change(manifest);assert.throws(()=>validateConfiguration(manifest));}
  const cycle=configuration();cycle.modules[0].configuration.settings.cycle=cycle;assert.throws(()=>validateConfiguration(cycle));
});

test('resource contracts: data is opaque binary in exact member subtrees, including ordinary code-like business filenames', () => {
  for(const purpose of ['dataset','backup']) {
    const manifest=data(purpose),binary=Buffer.from([0,255,128,13,10,0]);
    const files=resourceFiles('data',manifest,[{path:'data/first/content.bin',bytes:binary},{path:'data/first/cache.pyc',bytes:binary},
      {path:'data/first/data.json',bytes:Buffer.from('opaque')},{path:'data/first/module.json',bytes:Buffer.from('opaque')},
      {path:'data/first/identity.json',bytes:Buffer.from('opaque application identity')},
      {path:'data/first/operation.mjs',bytes:Buffer.from("throw new Error('Must never run business data');")}]);
    assert.equal(validateData(manifest),manifest);assert.deepEqual(validateDataFiles(manifest,files).decoded[1].bytes,binary);
    assert.deepEqual(validateArtifactBytes(encoded('data',manifest,files)).decoded[1].bytes,binary);
  }
});

test('resource contracts: data refuses escaping, overlapping or case-colliding paths outside declared business subtrees', () => {
  const manifest=data();
  for(const path of ['../outside','data/first/../../outside','data/other/bytes.bin','extra.bin','.hub/auth.json','credentials.json','identity.json','.runtime/manager.json'])
    assert.throws(()=>validateDataFiles(manifest,resourceFiles('data',manifest,[{path,bytes:Buffer.from('x')}])));
  for(const paths of [['data/first/A.bin','data/first/a.bin'],['data/first/file','data/first/file/child']])
    assert.throws(()=>validateDataFiles(manifest,resourceFiles('data',manifest,paths.map(path=>({path,bytes:Buffer.from('x')})))));
  const changes=[m=>m.instances[0].path='data/first/nested',m=>m.instances[0].path='data/../first',m=>m.instances.push(structuredClone(m.instances[0])),
    m=>m.instances[0].identity={},m=>m.instances[0].module.sha256='1'.repeat(64),m=>m.instances[0].dataFormat.extra=true,m=>m.purpose='execution',m=>m.startupPlan={}];
  for(const change of changes){const invalid=data();change(invalid);assert.throws(()=>validateData(invalid));}
  assert.throws(()=>validateDataFiles(manifest,resourceFiles('data',manifest,[{path:'data/first/large.bin',bytes:Buffer.alloc(8*1024*1024+1)}])));
});

test('resource contracts: artifact Base64 remains canonical after bounded linear validation', () => {
  const manifest=data(),artifact=encoded('data',manifest,resourceFiles('data',manifest,[{path:'data/first/byte.bin',bytes:Buffer.from([0])}]));
  for(const base64 of ['AP==','A===','A=AA','AAAA====','AA==\n']) {
    const invalid=structuredClone(artifact);invalid.files[1].base64=base64;assert.throws(()=>validateArtifactBytes(invalid));
  }
  assert.deepEqual(validateArtifactBytes(artifact).decoded[1].bytes,Buffer.from([0]));
});

test('resource contracts: source digest exactly matches the existing ordered collectSourceFiles manifest',async () => {
  const root=await workspace();await writeFile(join(root,'z.txt'),'last');await writeFile(join(root,'a.txt'),'first');
  const files=await collectSourceFiles(root);assert.deepEqual(files.map(file=>file.path),['a.txt','z.txt']);
  assert.equal(sourceFilesDigest(files),hash(JSON.stringify(files)));assert.equal(sourceFilesDigest(files),sourceFilesDigest(await collectSourceFiles(root)));
  await writeFile(join(root,'a.txt'),'changed');assert.notEqual(sourceFilesDigest(files),sourceFilesDigest(await collectSourceFiles(root)));
});

test('resource contracts: configuration and data publish, validate, fetch and recheck exact binary cache without executing modules',async () => {
  const root=await workspace();
  for(const kind of ['configuration','data']) {
    const manifest=kind==='configuration'?configuration():data(),extras=kind==='data'?[{path:'data/first/cache.pyc',bytes:Buffer.from([0,255,1])}]:[];
    const source=await directory(root,kind,manifest,extras),published=await publishArtifact(source,{kind,destination:join(root,kind+'-publication'),redistributionAcknowledged:true});
    const checked=validateArtifactBytes(await readFile(published.artifactPath));assert.equal(checked.entry.kind,kind);assert.deepEqual(checked.manifest,manifest);
    assert.equal(checked.entry.sha256,hash(await readFile(published.artifactPath)));assert.equal(checked.decoded.length,extras.length+1);
    const index=await readSourceIndex(published.indexPath),options={cacheRoot:join(root,'cache')};
    const fetched=await fetchSourceArtifact(index.source,index.digest,index.index.entries[0].entryId,options);
    assert.equal(fetched.kind,kind);assert.equal(fetched.startsModules,false);assert.equal(fetched.requiresExecutionReview,false);
    assert.equal((await fetchSourceArtifact(index.source,index.digest,index.index.entries[0].entryId,options)).cached,true);
    const tampered=structuredClone(checked.artifact);tampered.id='another';assert.throws(()=>validateArtifactBytes(tampered));
  }
  await assert.rejects(publishArtifact(root,{kind:'module-group',destination:join(root,'old'),redistributionAcknowledged:true}),/module, configuration or data/);
});

test('resource contracts: directory, ZIP and artifact JSON ingest both new kinds with the same validation',async () => {
  const root=await workspace();
  for(const kind of ['configuration','data']) {
    const manifest=kind==='configuration'?configuration():data('backup'),extras=kind==='data'?[{path:'data/first/data.json',bytes:Buffer.from([0,255])}]:[];
    const files=resourceFiles(kind,manifest,extras),source=await directory(root,kind,manifest,extras);
    const archive=join(root,kind+'.zip'),artifact=join(root,kind+'-artifact.json');await writeFile(archive,zip(files));await writeFile(artifact,json(encoded(kind,manifest,files)));
    for(const path of [source,archive,artifact]) {
      const result=await importLocalArtifact({root,path,kind});assert.equal(result.object.kind,kind);assert.equal(result.startsModules,false);assert.equal(result.object.checked,true);
      if(kind==='data')assert.equal(result.object.purpose,'backup');
    }
    await assert.rejects(importLocalArtifact({root,path:archive,kind:kind==='data'?'module':'data'}));
  }
  const invalid=configuration(),archive=join(root,'invalid.zip');await writeFile(archive,zip(resourceFiles('configuration',invalid,[{path:'private.json',bytes:Buffer.from('{}')}])));
  await assert.rejects(importLocalArtifact({root,path:archive}));
});

test('resource contracts: existing module source publication and all local inputs remain usable',async () => {
  const root=await workspace(),manifest={format:'world-hub.module/v1',id:'module.example',version:'1.0.0',license:'MIT',platforms:metadata.platforms,
    runtime:{kind:'node',entry:'program.mjs'},bridges:['main'],provides:[],requires:[],permissions:{filesystem:'instance-state',network:['hub-loopback'],processes:'none'}};
  const extras=[{path:'program.mjs',bytes:Buffer.from("throw new Error('Import must not execute module source');")}],source=await directory(root,'module',manifest,extras);
  const published=await publishArtifact(source,{kind:'module',destination:join(root,'published'),redistributionAcknowledged:true}),archive=join(root,'module.zip');
  await writeFile(archive,zip(resourceFiles('module',manifest,extras)));
  for(const path of [source,archive,published.artifactPath])assert.equal((await importLocalArtifact({root,path,kind:'module'})).object.kind,'module');
});

test('resource contracts: path library identifies and retains configuration and data directories, ZIP and artifact JSON inputs',async () => {
  const root=await workspace(),paths=new PathsService(root),expected=[];await paths.initialize();
  for(const kind of ['configuration','data']) {
    const manifest=kind==='configuration'?configuration():data(),extras=kind==='data'?[{path:'data/first/module.json',bytes:json({format:'world-hub.module/v1',id:'opaque-business-document'})}]:[];
    const files=resourceFiles(kind,manifest,extras),source=await directory(root,kind,manifest,extras);
    const archive=join(root,kind+'.zip'),artifact=join(root,kind+'-artifact.json');await writeFile(archive,zip(files));await writeFile(artifact,json(encoded(kind,manifest,files)));
    for(const path of [source,archive,artifact]) {
      const checked=await paths.check({path,purpose:kind});assert.equal(checked.object.kind,kind);assert.equal(checked.selectable,true);assert.equal(checked.startsModules,false);
      await paths.remember({path,purpose:kind,library:true});expected.push(path);
    }
    if(kind==='data')assert.deepEqual((await paths.discover({directory:source})).objects.map(object=>object.kind),['data'],'Business data subtrees are not module discovery roots');
  }
  const restored=new PathsService(root);await restored.initialize();assert.equal(restored.library.length,6);
  const manager={defaults:{},localPrograms:{records:new Map()},sourceRegistry:{records:[]}};
  const known=await restored.known(manager);assert.equal(known.objects.filter(object=>object.libraryRegistered).length,6);
  assert.ok(known.objects.filter(object=>object.libraryRegistered).every(object=>['configuration','data'].includes(object.kind)&&object.startsModules===false));
  await restored.forget({path:expected[0],purpose:'configuration'});assert.equal(restored.library.length,5);assert.ok((await readFile(join(expected[0],'configuration.json'))).length);
  await assert.rejects(restored.check({path:expected[0],purpose:'module-group'}),{code:'PATH_PURPOSE_INVALID'});
});
