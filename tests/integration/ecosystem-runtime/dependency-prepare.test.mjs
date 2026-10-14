import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { inspectDeployment } from '../../../scripts/runtime/deployment.mjs';
import { prepareDependencies, inspectRegistryArchive } from '../../../scripts/runtime/dependency-prepare.mjs';

function archive(entries) {
  const pieces=[];
  for(const {path,type='0',bytes=Buffer.from('value')} of entries) {
    const header=Buffer.alloc(512), size=type==='5'?0:bytes.length;
    header.write(path,0); header.write('0000600\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
    header.write(size.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136); header.fill(32,148,156); header.write(type,156); header.write('ustar\0',257); header.write('00',263);
    header.write([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
    pieces.push(header); if(size) pieces.push(bytes,Buffer.alloc((512-size%512)%512));
  }
  return gzipSync(Buffer.concat([...pieces,Buffer.alloc(1024)]));
}
async function fixture(t,{entries,recipes=[]}={}) {
  const root=await mkdtemp(join(tmpdir(),'hub-dependency-test-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'source'),stateDir=join(root,'environment'); await mkdir(directory);
  const manifest={format:'world-hub.module/v1',id:'example.dependencies',version:'1.0.0',license:'MIT',platforms:[`${process.platform}-${process.arch}`],runtime:{kind:'node',entry:'program.mjs'},bridges:['main'],provides:[],requires:[],permissions:{filesystem:'instance-state',network:['hub-loopback'],processes:'none'}};
  const bytes=archive(entries ?? [{path:'package/package.json',bytes:Buffer.from(JSON.stringify({name:'harmless',version:'1.0.0',scripts:{postinstall:'node hook.js'}}))},{path:'package/hook.js',bytes:Buffer.from('throw new Error("MUST NOT EXECUTE");')},{path:'package/index.js',bytes:Buffer.from('export const value=42;')}]);
  const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
  const pkg={name:'example-dependencies',version:'1.0.0',type:'module',dependencies:{harmless:'1.0.0'},scripts:{install:'node project-hook.js'}};
  const lock={lockfileVersion:3,packages:{'':{dependencies:pkg.dependencies},'node_modules/harmless':{version:'1.0.0',resolved:'https://registry.npmjs.org/harmless/-/harmless-1.0.0.tgz',integrity,license:'MIT'}}};
  const deployment={format:'world-hub.deployment/v1',title:{zh:'测试',en:'Test'},description:{zh:'测试环境',en:'Test environment'},topics:{events:'test/events'},bridges:{main:{publish:['events'],subscribe:[]}},settings:[],dependencies:{kind:'npm-lock',manifest:'package.json',lock:'package-lock.json',recipes}};
  for(const [name,value] of Object.entries({'module.json':JSON.stringify(manifest),'package.json':JSON.stringify(pkg),'package-lock.json':JSON.stringify(lock),'deployment.json':JSON.stringify(deployment),'program.mjs':'console.log("module");','project-hook.js':'throw new Error("MUST NOT EXECUTE");'})) await writeFile(join(directory,name),value);
  const review=await inspectDeployment({directory,manifest});
  return {root,directory,stateDir,manifest,review,bytes,lock,pkg};
}
async function fakeDownload(t,bytes,handler) {
  const original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;}); let calls=0;
  globalThis.fetch=async (...args)=> {calls++; assert.equal(args[1].redirect,'manual'); assert.deepEqual(args[1].headers,{'accept-encoding':'identity'}); return handler ? handler(...args) : new Response(bytes,{status:200,headers:{'content-length':String(bytes.length)}});};
  return ()=>calls;
}

test('registry extraction refuses traversal, links, devices, multiple roots and case/file collisions',()=> {
  for(const entries of [
    [{path:'package/../escape'}], [{path:'/package/escape'}], [{path:'package/file',type:'2'}], [{path:'package/file',type:'1'}], [{path:'package/file',type:'3'}],
    [{path:'package/a'},{path:'other/b'}], [{path:'package/A'},{path:'package/a'}], [{path:'package/a'},{path:'package/a/b'}],
    [{path:'package/node_modules/a/file'}], [{path:'package/CON.txt'}], [{path:'package/a\\b'}]
  ]) assert.throws(()=>inspectRegistryArchive(archive(entries)));
  const valid=inspectRegistryArchive(archive([{path:'package/lib/',type:'5'},{path:'package/lib/index.js',bytes:Buffer.from('ok')} ]));
  assert.equal(valid[0].path,'lib/index.js'); assert.equal(valid[0].bytes.toString(),'ok');
});
test('registry extraction refuses malformed checksum, truncation and unexpected trailing material',()=> {
  assert.throws(()=>inspectRegistryArchive(Buffer.from('no gzip')),{code:'DEPENDENCY_ARCHIVE_INVALID'});
  const truncated=gzipSync(Buffer.alloc(512,1)); assert.throws(()=>inspectRegistryArchive(truncated));
  const valid=archive([{path:'package/a'}]); assert.throws(()=>inspectRegistryArchive(Buffer.concat([valid.subarray(0,valid.length-5)])));
});
test('locked dependencies install without module/package hooks and a second start verifies instead of downloading',async t=> {
  const value=await fixture(t),calls=await fakeDownload(t,value.bytes);
  const result=await prepareDependencies(value); assert.ok(result.directory.includes('attempt-'));
  assert.equal(await readFile(join(result.directory,'node_modules/harmless/index.js'),'utf8'),'export const value=42;');
  assert.equal((await readdir(value.directory)).includes('node_modules'),false);
  const receipt=JSON.parse(await readFile(join(value.stateDir,'prepared.json'),'utf8'));
  assert.equal(receipt.runsModuleInstallScripts,false); assert.equal(calls(),1);
  assert.deepEqual(await prepareDependencies(value),result); assert.equal(calls(),1);
});
test('preparation rejects a changed lock after review without any download or source mutation',async t=> {
  const value=await fixture(t),calls=await fakeDownload(t,value.bytes);
  value.lock.packages['node_modules/harmless'].integrity='sha512-'+Buffer.alloc(64,1).toString('base64');
  await writeFile(join(value.directory,'package-lock.json'),JSON.stringify(value.lock));
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_REVIEW_CHANGED'}); assert.equal(calls(),0);
});
test('a lock or program source change during network preparation cannot produce a trusted receipt',async t=> {
  const value=await fixture(t);
  await fakeDownload(t,value.bytes,async()=> { await writeFile(join(value.directory,'program.mjs'),'changed while downloading'); return new Response(value.bytes); });
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_REVIEW_CHANGED'});
  await assert.rejects(readFile(join(value.stateDir,'prepared.json')),{code:'ENOENT'});
});
test('wrong archive integrity retains failure evidence and writes no successful receipt',async t=> {
  const value=await fixture(t); await fakeDownload(t,archive([{path:'package/other'}]));
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_INTEGRITY_MISMATCH'});
  await assert.rejects(readFile(join(value.stateDir,'prepared.json')),{code:'ENOENT'});
  const attempt=(await readdir(value.stateDir)).find(name=>name.startsWith('attempt-')); assert.ok(attempt);
  const failure=JSON.parse(await readFile(join(value.stateDir,attempt,'failure.json'))); assert.equal(failure.code,'DEPENDENCY_INTEGRITY_MISMATCH');
  assert.equal((await readdir(value.stateDir)).includes('preparing.lock'),false);
});
test('a registry archive link is rejected before extraction, even with correct lock integrity',async t=> {
  const value=await fixture(t,{entries:[{path:'package/file',type:'2'}]}); await fakeDownload(t,value.bytes);
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_ARCHIVE_INVALID'});
  await assert.rejects(readFile(join(value.stateDir,'prepared.json')),{code:'ENOENT'});
});
test('a prepared file change or partial environment is rejected on the next start',async t=> {
  const value=await fixture(t); await fakeDownload(t,value.bytes); const result=await prepareDependencies(value);
  await writeFile(join(result.directory,'node_modules/harmless/index.js'),'changed');
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_ENVIRONMENT_CHANGED'});
  await rm(join(result.directory,'node_modules/harmless/index.js'));
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_ENVIRONMENT_CHANGED'});
});
test('receipt and copied source mismatch are refused rather than silently reinstalled',async t=> {
  const value=await fixture(t); await fakeDownload(t,value.bytes); await prepareDependencies(value);
  await writeFile(join(value.directory,'program.mjs'),'changed source');
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_RECEIPT_CHANGED'});
  await writeFile(join(value.stateDir,'prepared.json'),'broken');
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_RECEIPT_INVALID'});
});
test('installed node_modules and an aborted action are refused before downloads',async t=> {
  const value=await fixture(t),calls=await fakeDownload(t,value.bytes); await mkdir(join(value.directory,'node_modules')); await writeFile(join(value.directory,'node_modules/unsafe.js'),'');
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_SOURCE_MIXED'}); assert.equal(calls(),0);
  const controller=new AbortController(); controller.abort(); await assert.rejects(prepareDependencies({...value,signal:controller.signal}),{code:'DEPENDENCY_PREPARATION_ABORTED'});
});
test('redirects to an unapproved host and oversized responses are rejected',async t=> {
  const value=await fixture(t); let stage=0;
  await fakeDownload(t,value.bytes,()=>stage===0?new Response(null,{status:302,headers:{location:'https://unapproved.example/package.tgz'}}):new Response(value.bytes,{headers:{'content-length':String(33*1024*1024)}}));
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_DOWNLOAD_INVALID'}); stage=1;
  await assert.rejects(prepareDependencies(value),{code:'DEPENDENCY_DOWNLOAD_LIMIT'});
});
