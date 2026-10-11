import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { validateSourceIndex, readSourceIndex, fetchSourceArtifact } from '../../../scripts/runtime/sources.mjs';
import { generatePublisherKey, signPublisherEvidence, verifyPublisherEvidence } from '../../../scripts/runtime/publisher-trust.mjs';
import { WorkshopStore, initializeAdmin } from '../../../tools/workshop/store.mjs';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';
import { verifyStoredPublisherEvidence } from '../../../scripts/runtime/publisher-store.mjs';
import { SourceRegistry } from '../../../tools/launcher/source-registry.mjs';
import { workshopCall } from './phase18-helpers.mjs';

const password = 'publisher-evidence-acceptance-password';
const json = value => JSON.stringify(value, null, 2) + '\n';
function moduleArtifact(version='1.0.0', id='workshop.publisher') {
  const manifest = {format:'world-hub.module/v1',id,version,license:'MIT',platforms:['linux-x64','win32-x64'],
    runtime:{kind:'node',entry:'program.mjs'},bridges:['main'],provides:[],requires:[],
    permissions:{filesystem:'instance-state',network:['hub-loopback'],processes:'none'}};
  const files = {'module.json':Buffer.from(json(manifest)), 'program.mjs':Buffer.from("throw new Error('Workshop cannot execute uploaded modules');\n")};
  return {format:'world-hub.source-artifact/v1',kind:'module',id,version,files:Object.entries(files).map(([path,bytes])=>({path,sha256:hash(bytes),base64:bytes.toString('base64')})),provenance:{redistributionAcknowledged:true}};
}
function evidence(artifact,key=generatePublisherKey(),sequence=1) {
  const result = signPublisherEvidence({payload:{type:'artifact',issuer:'workshop.test-author',keyId:key.keyId,sequence,
    issuedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),
    subject:{kind:artifact.kind,id:artifact.id,version:artifact.version,sha256:hash(Buffer.from(JSON.stringify(artifact)+'\n'))},details:{}},privateKeys:[key.privateKeyPem]});
  return {value:result,bytes:Buffer.from(json(result)),key};
}
async function fixture(t) {
  const parent = resolve('.artifacts/workshop-publisher-tests'); await mkdir(parent,{recursive:true}); const root = await mkdtemp(join(parent,'case-'));
  await initializeAdmin({root,username:'admin',password});
  const service = await createWorkshopServer({root,baseURL:'http://127.0.0.1:0/workshop',port:0,allowInsecureLoopback:true,secureCookie:false});
  t.after(()=>service.close()); const session = await workshopCall(service,'api/login',{username:'admin',password});
  return {root,service,actor:{...session.data,cookie:session.cookie}};
}
async function publication(service,actor,artifact,publicEvidence,expected=201) {
  return workshopCall(service,'api/publications',{artifact,redistributionAcknowledged:true,...(publicEvidence === undefined ? {} : {publisherEvidence:publicEvidence})},actor,expected);
}
async function rawDownload(url,expected=200) {
  const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000)}); assert.equal(response.status,expected);
  return {bytes:Buffer.from(await response.arrayBuffer()),response};
}

test('Workshop publisher: public sidecars retain exact bytes and immutable identity without account attestation',async t => {
  const {root,service,actor} = await fixture(t), artifact = moduleArtifact(), signed = evidence(artifact), publicText = signed.bytes.toString('utf8');
  const original = Buffer.from(JSON.stringify(artifact)+'\n'), published = await publication(service,actor,artifact,publicText), p = published.data.publication;
  assert.equal(p.sha256,hash(original)); assert.equal(p.publisherEvidence.sha256,hash(signed.bytes));
  assert.equal(p.publisherEvidence.publisherIdentityVerified,false); assert.equal(p.publisherEvidence.codeSafetyVerified,false); assert.equal(p.publisherEvidence.grantsExecution,false);
  assert.equal((await publication(service,actor,artifact,publicText,200)).data.duplicate,true);
  const other = evidence(artifact,signed.key,2);
  const changed = await publication(service,actor,artifact,other.bytes.toString('utf8'),409); assert.equal(changed.data.error.code,'IMMUTABLE_EVIDENCE');
  const index = (await workshopCall(service,'index.json')).data, entry = index.entries[0];
  assert.equal(entry.publisherEvidence.sha256,hash(signed.bytes));
  validateSourceIndex({...index,entries:index.entries.map(value=>({...value,source:{url:`https://workshop.example.test/workshop/artifacts/${value.sha256}.json`},
    publisherEvidence:{source:{url:`https://workshop.example.test/workshop/publisher-evidence/${value.publisherEvidence.sha256}.json`},sha256:value.publisherEvidence.sha256}}))});
  assert.deepEqual((await rawDownload(entry.source.url)).bytes,original);
  const publicDownload = await rawDownload(entry.publisherEvidence.source.url); assert.deepEqual(publicDownload.bytes,signed.bytes); assert.match(publicDownload.response.headers.get('cache-control'),/immutable/);
  const report = verifyPublisherEvidence({artifact:{kind:entry.kind,id:entry.id,version:entry.version,sha256:entry.sha256},evidenceBytes:publicDownload.bytes});
  assert.equal(report.signatureStatus,'verified'); assert.equal(report.publisherIdentity,'unanchored-key'); assert.equal(report.accepted,false);
  assert.equal((await readFile(join(root,'metadata.json'),'utf8')).includes(signed.key.privateKeyPem),false);
  await assert.rejects(access(join(root,'publisher-trust.json')),{code:'ENOENT'});
});

test('Workshop publisher: unsigned publications work; private data, fake signatures and wrong artifact bindings are rejected',async t => {
  const {service,actor,root} = await fixture(t), unsigned = moduleArtifact('1.0.0','workshop.unsigned');
  const first = await publication(service,actor,unsigned); assert.equal(Object.hasOwn(first.data.publication,'publisherEvidence'),false);const unsignedIndex=await workshopCall(service,'index.json');assert.equal(Object.hasOwn(unsignedIndex.data.entries[0],'publisherEvidence'),false);
  const artifact = moduleArtifact(), signed = evidence(artifact), forged = structuredClone(signed.value);
  forged.signatures[0].value = Buffer.alloc(64).toString('base64');
  for (const input of [json(forged),json({...signed.value,privateKeyPem:signed.key.privateKeyPem}), signed.key.privateKeyPem,
    evidence(moduleArtifact('2.0.0')).bytes.toString('utf8'), 'x'.repeat(256*1024+1)]) {
    assert.equal((await publication(service,actor,artifact,input,400)).data.error.code,'PUBLISHER_EVIDENCE_INVALID');
  }
  const valid = await publication(service,actor,artifact,signed.bytes.toString('utf8'));
  const digest = valid.data.publication.publisherEvidence.sha256, sidecar = join(root,'publisher-evidence',`${digest}.json`);
  await writeFile(sidecar,'{"changed":true}\n');
  const broken = await rawDownload(`${service.baseURL}/publisher-evidence/${digest}.json`,500);
  assert.equal(JSON.parse(broken.bytes).error.code,'PUBLISHER_EVIDENCE_CORRUPT');
  assert.deepEqual((await rawDownload(`${service.baseURL}/artifacts/${valid.data.publication.sha256}.json`)).bytes,Buffer.from(JSON.stringify(artifact)+'\n'));
  assert.equal((await workshopCall(service,'api/catalog')).data.total,2);
});

test('Workshop publisher: proposal evidence remains bound to changed artifact, visibility and export recovery preserve originals',async t => {
  const {root,service,actor} = await fixture(t), artifact = moduleArtifact(), signed = evidence(artifact);
  const baseline = (await publication(service,actor,artifact,signed.bytes.toString('utf8'))).data.publication;
  const candidate = moduleArtifact('1.1.0'), candidateEvidence = evidence(candidate,signed.key,2);
  const body = {artifact:candidate,baseSha256:baseline.sha256,redistributionAcknowledged:true,publisherEvidence:candidateEvidence.bytes.toString('utf8')};
  assert.equal((await workshopCall(service,`api/publications/${baseline.entryId}/proposals`,{...body,baseSha256:'0'.repeat(64)},actor,409)).data.error.code,'BASELINE_CHANGED');
  const proposal = (await workshopCall(service,`api/publications/${baseline.entryId}/proposals`,body,actor,201)).data.proposal;
  assert.equal(proposal.publisherEvidence.sha256,hash(candidateEvidence.bytes));
  const originalIndex = (await workshopCall(service,'index.json')).data; assert.equal(originalIndex.entries.length,1); assert.equal(originalIndex.entries[0].sha256,baseline.sha256);
  assert.deepEqual((await rawDownload(`${service.baseURL}/publisher-evidence/${proposal.publisherEvidence.sha256}.json`)).bytes,candidateEvidence.bytes);
  await workshopCall(service,`api/publications/${baseline.entryId}/visibility`,{hidden:true},actor);
  await rawDownload(`${service.baseURL}/publisher-evidence/${baseline.publisherEvidence.sha256}.json`,404);
  await rawDownload(`${service.baseURL}/publisher-evidence/${proposal.publisherEvidence.sha256}.json`,404);
  await workshopCall(service,`api/publications/${baseline.entryId}/visibility`,{hidden:false},actor);
  await service.close();
  const reopened = await WorkshopStore.open({root});
  try {
    const exported = join(root+'-export'), report = await reopened.exportTo(exported); assert.equal(report.publisherEvidence,2); assert.equal(report.artifacts,2);
    const copied = await WorkshopStore.open({root:exported});
    try {
      assert.equal(copied.detail(baseline.entryId).publication.sha256,baseline.sha256);
      assert.deepEqual(await copied.publisherBytes(baseline.publisherEvidence.sha256),signed.bytes);
      assert.deepEqual(await copied.publisherBytes(proposal.publisherEvidence.sha256),candidateEvidence.bytes);
      assert.deepEqual(await copied.artifactBytes(baseline.sha256),Buffer.from(JSON.stringify(artifact)+'\n'));
    } finally { await copied.close(); }
  } finally { await reopened.close(); }
});

test('Workshop publisher: real HTTP author-to-reader loop uses exact bytes and cached identity responds to local revocation',async t => {
  const {root,service,actor} = await fixture(t), artifact = moduleArtifact(), signed = evidence(artifact);
  const published = (await publication(service,actor,artifact,signed.bytes.toString('utf8'))).data.publication;
  const upstream = (await workshopCall(service,'index.json')).data, entry = upstream.entries[0];
  const artifactBytes = (await rawDownload(entry.source.url)).bytes, publicBytes = (await rawDownload(entry.publisherEvidence.source.url)).bytes;
  assert.equal(hash(artifactBytes),entry.sha256); assert.equal(hash(publicBytes),entry.publisherEvidence.sha256);
  // Explicit local HTTP test transport adapter. Only references are changed;
  // the actual upstream artifact and evidence bytes retain both exact hashes.
  const mirror = root+'-reader-source', localRoot = root+'-reader'; await mkdir(mirror);
  await writeFile(join(mirror,'artifact.json'),artifactBytes); await writeFile(join(mirror,'publisher.json'),publicBytes);
  const indexPath = join(mirror,'index.json'); await writeFile(indexPath,json({...upstream,entries:[{...entry,source:{path:'artifact.json'},publisherEvidence:{source:{path:'publisher.json'},sha256:entry.publisherEvidence.sha256}}]}));
  const registry = new SourceRegistry(localRoot); await registry.initialize();
  const change = {action:'anchor',issuer:signed.value.payload.issuer,publicKey:signed.key.publicKey,role:'publisher',identityBasis:{type:'public-key-fingerprint',note:'Explicit HTTP acceptance user pin'}};
  const preview = await registry.previewPublisherTrust(change); await registry.applyPublisherTrust({change,reviewDigest:preview.reviewDigest});
  const current = await readSourceIndex(indexPath), chosen = await registry.resolve({source:indexPath});
  const fetched = await fetchSourceArtifact(indexPath,current.digest,entry.entryId,{cacheRoot:registry.cacheRoot,publisherTrustRoot:localRoot});
  const receipt = await registry.recordFetch(chosen,{...fetched,indexDigest:current.digest}); assert.equal(receipt.publisherIdentityVerified,true);
  const recovery = generatePublisherKey(), recoveryChange = {...change,publicKey:recovery.publicKey,role:'recovery'};
  const recoveryPreview = await registry.previewPublisherTrust(recoveryChange); await registry.applyPublisherTrust({change:recoveryChange,reviewDigest:recoveryPreview.reviewDigest});
  const effectiveAt = new Date().toISOString(), revoke = signPublisherEvidence({payload:{type:'key-revocation',issuer:change.issuer,keyId:recovery.keyId,sequence:2,issuedAt:effectiveAt,
    expiresAt:new Date(Date.now()+3600000).toISOString(),subject:{kind:'publisher',id:change.issuer},details:{revokedKeyId:signed.key.keyId,effectiveAt,reason:'HTTP fixture recovery statement'}},privateKeys:[recovery.privateKeyPem]});
  assert.equal((await verifyStoredPublisherEvidence({root:localRoot,evidenceBytes:Buffer.from(json(revoke)),observe:true})).accepted,true);
  const recognized = await registry.recognize(fetched.directory,receipt);
  assert.equal(recognized.publisherEvidence.keyStatus,'revoked'); assert.equal(recognized.publisherIdentityVerified,false); assert.equal(recognized.executionAuthorized,false);
  assert.deepEqual((await rawDownload(entry.source.url)).bytes,artifactBytes);
  assert.deepEqual((await rawDownload(entry.publisherEvidence.source.url)).bytes,publicBytes);
  assert.equal((await workshopCall(service,`api/publications/${published.entryId}`)).data.publication.sha256,published.sha256);
});
