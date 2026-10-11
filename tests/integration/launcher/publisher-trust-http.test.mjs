import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { publishArtifact, attachPublisherEvidence } from '../../../scripts/runtime/sources.mjs';
import { generatePublisherKey, signPublisherEvidence } from '../../../scripts/runtime/publisher-trust.mjs';
import { verifyStoredPublisherEvidence } from '../../../scripts/runtime/publisher-store.mjs';
import { workspace, fixturePackage, environment } from './helpers.mjs';
const issuer = 'launcher.http-author';
const signed = (key, type, subject, sequence = 1, details = {}) => {
  const issuedAt=new Date().toISOString();
  return signPublisherEvidence({payload:{type,issuer,keyId:key.keyId,sequence,
    issuedAt,expiresAt:new Date(Date.now()+3600000).toISOString(),subject,details:details.effectiveAt?{...details,effectiveAt:issuedAt}:details},privateKeys:[key.privateKeyPem]});
};
async function setup(t) {
  const app=await workspace(t), server=await createLauncherServer({root:app.root,port:0,...environment});app.cleanups.push(()=>server.close());
  const call=async(path,body,expected=200)=>{const r=await fetch(new URL(path,server.url),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+server.token,'x-csrf-token':server.csrfToken,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const v=await r.json();assert.equal(r.status,expected,JSON.stringify(v));return v;};
  const anchor=async(key,role='publisher')=>{const change={action:'anchor',issuer,publicKey:key.publicKey,role,identityBasis:{type:'public-key-fingerprint'}};const preview=await call('/api/publisher-trust/preview',{change});await call('/api/publisher-trust/apply',{change,reviewDigest:preview.reviewDigest,accepted:true});};
  return{app,server,call,anchor};
}
async function operation(manager, request) {const row=manager.operations.get(request.operationId);await row.promise;if(row.state!=='succeeded')throw Object.assign(new Error(row.error.message),row.error);return row.result;}
test('PUBLISHER-HTTP public-key trust requires an exact reviewed change; private and stale requests cannot mutate state',async t=>{
  const {call,anchor}=await setup(t),key=generatePublisherKey(),other=generatePublisherKey();
  assert.equal((await call('/api/publisher-trust')).trust.revision,0);
  const change={action:'anchor',issuer,publicKey:key.publicKey,role:'publisher',identityBasis:{type:'public-key-fingerprint'}};
  const p=await call('/api/publisher-trust/preview',{change});
  assert.equal((await call('/api/publisher-trust/apply',{change,reviewDigest:p.reviewDigest,accepted:false},409)).error.code,'TRUST_REQUIRED');
  await anchor(other,'recovery');
  assert.equal((await call('/api/publisher-trust/apply',{change,reviewDigest:p.reviewDigest,accepted:true},409)).error.code,'TRUST_REVIEW_REQUIRED');
  await call('/api/publisher-trust/preview',{change,privateKey:'never accepted'},400);
  const current=await call('/api/publisher-trust');assert.equal(current.trust.revision,1);assert.equal(JSON.stringify(current).includes('never accepted'),false);
});
test('PUBLISHER-HTTP evidence preview binds current file bytes and trust revision, and observing does not execute programs',async t=>{
  const {app,call,anchor,server}=await setup(t),key=generatePublisherKey(),other=generatePublisherKey();await anchor(key,'recovery');await anchor(other);
  const file=join(app.directory,'public.json'),subject={kind:'publisher',id:issuer},details={revokedKeyId:other.keyId,effectiveAt:new Date().toISOString(),reason:'Independent recovery test.'};
  await writeFile(file,JSON.stringify(signed(key,'key-revocation',subject,1,details)));const preview=await call('/api/publisher-evidence/preview',{evidencePath:file});assert.equal(preview.report.accepted,true);
  await call('/api/publisher-evidence/observe',{previewId:preview.previewId,accepted:false},409);
  await writeFile(file,JSON.stringify(signed(key,'key-revocation',subject,2,details)));
  assert.equal((await call('/api/publisher-evidence/observe',{previewId:preview.previewId,accepted:true},409)).error.code,'PUBLISHER_REVIEW_CHANGED');
  const stale=await call('/api/publisher-evidence/preview',{evidencePath:file});await anchor(generatePublisherKey(),'advisory');
  await call('/api/publisher-evidence/observe',{previewId:stale.previewId,accepted:true},409);
  const fresh=await call('/api/publisher-evidence/preview',{evidencePath:file}),result=await call('/api/publisher-evidence/observe',{previewId:fresh.previewId,accepted:true});
  assert.equal(result.report.observed,true);assert.equal(result.report.startsModules,false);assert.equal(server.manager.records.size,0);
});
test('PUBLISHER-HTTP a recovery revocation invalidates a previously reviewed real imported source before execution',async t=>{
  const {app,server,anchor}=await setup(t),manager=server.manager,key=generatePublisherKey(),recovery=generatePublisherKey();await anchor(key);await anchor(recovery,'recovery');
  const pack=await fixturePackage(app),published=await publishArtifact(pack,{destination:join(app.directory,'published'),kind:'pack',redistributionAcknowledged:true,...environment}),entry=published.index.entries[0];
  const subject=Object.fromEntries(['kind','id','version','sha256'].map(k=>[k,entry[k]]));
  await attachPublisherEvidence(published.directory,{evidenceBytes:Buffer.from(JSON.stringify(signed(key,'artifact',subject)))});
  const source=await manager.source({source:published.indexPath}),fetched=await operation(manager,manager.fetchSource({source:published.indexPath,receiptId:source.receiptId,entryId:entry.entryId}));assert.equal(fetched.sourceReceipt.publisherIdentityVerified,true);
  const imported=await manager.review(fetched.directory,environment);await manager.import(imported.reviewId,'signed');
  const prior=await manager.reviewInstance('signed');assert.equal(prior.sourceReceipt.publisherIdentityVerified,true);
  const revocation=signed(recovery,'key-revocation',{kind:'publisher',id:issuer},1,{revokedKeyId:key.keyId,effectiveAt:new Date().toISOString(),reason:'Test independent recovery revocation.'});
  const report=await verifyStoredPublisherEvidence({root:app.root,evidenceBytes:Buffer.from(JSON.stringify(revocation))});assert.equal(report.accepted,true);
  await assert.rejects(manager.verifyReview(manager.reviews.get(prior.reviewId)),{code:'PUBLISHER_REVIEW_CHANGED'});
  const current=await manager.reviewInstance('signed');assert.equal(current.sourceReceipt.publisherIdentityVerified,false);assert.equal(current.sourceReceipt.publisherEvidence.keyStatus,'revoked');assert.equal((await manager.instance('signed')).status.state,'imported');
});
