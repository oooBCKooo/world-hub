import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { publishArtifact, attachPublisherEvidence, readSourceIndex, fetchSourceArtifact, validateSourceIndex } from '../../../scripts/runtime/sources.mjs';
import { generatePublisherKey, signPublisherEvidence } from '../../../scripts/runtime/publisher-trust.mjs';
import { verifyStoredPublisherEvidence, readPublisherTrust } from '../../../scripts/runtime/publisher-store.mjs';
import { SourceRegistry } from '../../../tools/launcher/source-registry.mjs';

const issuer = 'source.test-author';
const json = value => JSON.stringify(value, null, 2) + '\n';
async function workspace() {
  const base = resolve('.artifacts/publisher-source-tests'); await mkdir(base, { recursive:true });
  const root = await mkdtemp(join(base, 'case-')), module = join(root, 'module'); await mkdir(module);
  await writeFile(join(module, 'module.json'), json({ format:'world-hub.module/v1', id:'source.publisher', version:'1.0.0', license:'MIT',
    platforms:[`${process.platform}-${process.arch}`], runtime:{kind:'node',entry:'program.mjs'}, bridges:['main'], provides:[], requires:[],
    permissions:{filesystem:'instance-state',network:['hub-loopback'],processes:'none'} }));
  await writeFile(join(module, 'program.mjs'), "throw new Error('Acquisition must never run this program');\n");
  const publication = await publishArtifact(module, { kind:'module', destination:join(root,'publication'), redistributionAcknowledged:true });
  return { root, publication, entry:publication.index.entries[0], key:generatePublisherKey(), cacheRoot:join(root,'launcher','source-cache'), trustRoot:join(root,'launcher') };
}
function statement(key, subject, { type='artifact', sequence=1, details={}, expiresAt, issuedAt } = {}) {
  const time = Date.now();
  return signPublisherEvidence({ payload:{type,issuer,keyId:key.keyId,sequence,issuedAt:issuedAt ?? new Date(time-10000).toISOString(),
    expiresAt:expiresAt ?? new Date(time+3600000).toISOString(),subject,details}, privateKeys:[key.privateKeyPem] });
}
const subject = entry => ({kind:entry.kind,id:entry.id,version:entry.version,sha256:entry.sha256});
async function signed(app) {
  const evidence = statement(app.key,subject(app.entry)), evidenceBytes = Buffer.from(json(evidence));
  const attached = await attachPublisherEvidence(app.publication.directory,{evidenceBytes});
  const index = await readSourceIndex(attached.indexPath);
  return { evidence,evidenceBytes,attached,index };
}
async function anchor(registry,key,role='publisher') {
  const change = {action:'anchor',issuer,publicKey:key.publicKey,role,identityBasis:{type:'public-key-fingerprint',note:'Explicit acceptance fixture anchor'}};
  const preview = await registry.previewPublisherTrust(change);
  return registry.applyPublisherTrust({change,reviewDigest:preview.reviewDigest});
}
async function fetchAndRecord(app,registry,index) {
  const chosen = await registry.resolve({source:app.publication.indexPath});
  const result = await fetchSourceArtifact(chosen.source,index.digest,index.index.entries[0].entryId,{cacheRoot:app.cacheRoot,publisherTrustRoot:app.trustRoot});
  const receipt = await registry.recordFetch(chosen,{...result,indexDigest:index.digest});
  return {result,receipt};
}

test('publisher source: unsigned sources remain usable and evidence references retain the strict source policy',async () => {
  const app = await workspace(), index = await readSourceIndex(app.publication.indexPath);
  const fetched = await fetchSourceArtifact(index.source,index.digest,app.entry.entryId,{cacheRoot:app.cacheRoot});
  assert.equal(fetched.publisherEvidence.status,'unsigned'); assert.equal(fetched.startsModules,false); assert.equal(fetched.requiresExecutionReview,true);
  const schema = structuredClone(index.index); schema.entries[0].publisherEvidence = {source:{url:'https://example.test/evidence.json'},sha256:'1'.repeat(64)};
  validateSourceIndex(schema);
  for (const reference of [{source:{url:'http://example.test/evidence.json'},sha256:'1'.repeat(64)},
    {source:{url:'https://127.0.0.1/evidence.json'},sha256:'1'.repeat(64)}, {source:{path:'../key.pem'},sha256:'1'.repeat(64)},
    {source:{path:'public.json'},sha256:'wrong'}, {source:{path:'public.json'},sha256:'1'.repeat(64),privateKey:'never'}]) {
    const bad = structuredClone(schema); bad.entries[0].publisherEvidence = reference; assert.throws(()=>validateSourceIndex(bad));
  }
});

test('publisher source: exact sidecar bytes never change artifact bytes or automatically trust its embedded key',async () => {
  const app = await workspace(), before = await readFile(app.publication.artifactPath), {index,attached,evidenceBytes} = await signed(app);
  assert.deepEqual(await readFile(app.publication.artifactPath),before); assert.equal(attached.artifactSha256,hash(before));
  assert.equal(attached.evidenceSha256,hash(evidenceBytes));
  const registry = new SourceRegistry(app.trustRoot); await registry.initialize();
  const {result,receipt} = await fetchAndRecord(app,registry,index);
  assert.equal(result.publisherEvidence.signatureStatus,'verified'); assert.equal(result.publisherEvidence.publisherIdentity,'unanchored-key');
  assert.equal(result.publisherEvidence.accepted,false); assert.equal(receipt.publisherIdentityVerified,false);
  assert.deepEqual((await readPublisherTrust({root:app.trustRoot})).issuers,[]);
  assert.equal(receipt.executionAuthorized,false); assert.equal(receipt.codeSafetyVerified,false); assert.equal(receipt.sandbox,false);
  assert.equal((await registry.recognize(result.directory,receipt)).publisherIdentityVerified,false);
  const wrong = statement(app.key,{...subject(app.entry),sha256:'2'.repeat(64)});
  await assert.rejects(attachPublisherEvidence(app.publication.directory,{evidenceBytes:Buffer.from(json(wrong))}),{code:'PUBLISHER_ARTIFACT_MISMATCH'});
  await assert.rejects(attachPublisherEvidence(app.publication.directory,{evidenceBytes:Buffer.from(json({ ...JSON.parse(evidenceBytes),privateKeyPem:app.key.privateKeyPem }))}));
});

test('publisher source: cached provenance rechecks user anchors, risk notices and independently signed revocation',async () => {
  const app = await workspace(), {index,evidenceBytes} = await signed(app), registry = new SourceRegistry(app.trustRoot); await registry.initialize();
  await anchor(registry,app.key);
  const {result,receipt} = await fetchAndRecord(app,registry,index);
  assert.equal(receipt.publisherIdentityVerified,true); assert.equal(receipt.publisherEvidence.accepted,true);
  const recovery = generatePublisherKey(); await anchor(registry,recovery,'recovery');
  const advisory = statement(app.key,{kind:'publisher',id:issuer},{type:'risk-notice',sequence:2,
    details:{artifacts:[subject(app.entry)],severity:'high',message:'Fixture exact-digest notice',links:[]}});
  assert.equal((await verifyStoredPublisherEvidence({root:app.trustRoot,evidenceBytes:Buffer.from(json(advisory)),observe:true})).accepted,true);
  const noticed = await registry.refreshPublisherReceipt(receipt);
  assert.equal(noticed.publisherEvidence.notices[0].severity,'high'); assert.match(noticed.publisherEvidence.advisoryStatus,/cached/);
  const revokedAt = new Date().toISOString();
  const revocation = statement(recovery,{kind:'publisher',id:issuer},{type:'key-revocation',sequence:3,issuedAt:revokedAt,
    details:{revokedKeyId:app.key.keyId,effectiveAt:revokedAt,reason:'Fixture key retired'}});
  assert.equal((await verifyStoredPublisherEvidence({root:app.trustRoot,evidenceBytes:Buffer.from(json(revocation)),observe:true})).accepted,true);
  const changed = await registry.recognize(result.directory,receipt), refreshed = await registry.refreshPublisherReceipt(receipt);
  assert.equal(changed.publisherIdentityVerified,false); assert.equal(refreshed.publisherEvidence.keyStatus,'revoked');
  assert.equal(refreshed.publisherEvidence.signatureStatus,'verified'); assert.equal(refreshed.publisherEvidence.accepted,false);
  assert.equal(refreshed.executionAuthorized,false);
  assert.deepEqual(await readFile(join(app.cacheRoot,`${hash(evidenceBytes)}.publisher.json`)),evidenceBytes);
});

test('publisher source: offline rechecking expires evidence and reports new status unknown while content stays usable',async () => {
  const app = await workspace(), {index,evidenceBytes,attached} = await signed(app), registry = new SourceRegistry(app.trustRoot); await registry.initialize(); await anchor(registry,app.key);
  const first = await fetchAndRecord(app,registry,index); assert.equal(first.result.publisherEvidence.accepted,true);
  await unlink(app.publication.indexPath); await unlink(attached.evidencePath);
  const offline = await fetchSourceArtifact(index.source,index.digest,app.entry.entryId,{cacheRoot:app.cacheRoot,publisherTrustRoot:app.trustRoot,
    now:new Date(Date.now()+7200000).toISOString()});
  assert.equal(offline.offline,true); assert.equal(offline.cached,true); assert.equal(offline.publisherEvidence.accepted,false);
  assert.equal(offline.publisherEvidence.error.code,'EXPIRED_EVIDENCE'); assert.ok(offline.publisherEvidence.warnings.includes('OFFLINE_NEW_REVOCATIONS_AND_NOTICES_UNKNOWN'));
  assert.deepEqual(await readFile(join(app.cacheRoot,`${hash(evidenceBytes)}.publisher.json`)),evidenceBytes);
  assert.equal(offline.requiresExecutionReview,true);
});

test('publisher source: sidecar tampering is explicit and cannot break unsigned-compatible artifact acquisition',async () => {
  const app = await workspace(), {index,attached,evidenceBytes} = await signed(app), registry = new SourceRegistry(app.trustRoot); await registry.initialize(); await anchor(registry,app.key);
  const first = await fetchAndRecord(app,registry,index); assert.equal(first.receipt.publisherIdentityVerified,true);
  await writeFile(attached.evidencePath,'{"tampered":true}\n');
  const changed = await fetchSourceArtifact(index.source,index.digest,app.entry.entryId,{cacheRoot:app.cacheRoot,publisherTrustRoot:app.trustRoot});
  assert.equal(changed.publisherEvidence.status,'evidence-digest-mismatch'); assert.equal(changed.publisherEvidence.integrityVerified,false); assert.equal(changed.cached,true);
  const chosen = await registry.resolve({source:app.publication.indexPath}), failedReceipt = await registry.recordFetch(chosen,{...changed,indexDigest:index.digest});
  assert.equal(failedReceipt.publisherIdentityVerified,false); assert.equal(failedReceipt.publisherEvidence.status,'evidence-digest-mismatch');
  assert.equal((await registry.refreshPublisherReceipt(failedReceipt)).publisherIdentityVerified,false);
  await writeFile(join(app.cacheRoot,`${hash(evidenceBytes)}.publisher.json`),'tampered');
  const receipt = await registry.refreshPublisherReceipt(first.receipt);
  assert.equal(receipt.publisherIdentityVerified,false); assert.equal(receipt.publisherEvidence.status,'evidence-digest-mismatch');
  assert.equal(receipt.integrityVerified,true);
});

test('publisher source: artifact sidecar cannot silently apply publisher control events during acquisition',async () => {
  const app = await workspace(), registry = new SourceRegistry(app.trustRoot); await registry.initialize(); await anchor(registry,app.key);
  const successor = generatePublisherKey(), issuedAt = new Date().toISOString();
  const rotation = signPublisherEvidence({payload:{type:'key-rotation',issuer,keyId:app.key.keyId,sequence:1,issuedAt,
    expiresAt:new Date(Date.now()+3600000).toISOString(),subject:{kind:'publisher',id:issuer},
    details:{oldKeyId:app.key.keyId,newKeyId:successor.keyId,newPublicKey:successor.publicKey,effectiveAt:issuedAt}},privateKeys:[app.key.privateKeyPem,successor.privateKeyPem]});
  const bytes = Buffer.from(json(rotation)), file = join(app.publication.directory,'not-an-artifact.publisher.json'); await writeFile(file,bytes);
  const modified = structuredClone(app.publication.index); modified.entries[0].publisherEvidence = {source:{path:'not-an-artifact.publisher.json'},sha256:hash(bytes)};
  await writeFile(app.publication.indexPath,json(modified)); const index = await readSourceIndex(app.publication.indexPath);
  const fetched = await fetchSourceArtifact(index.source,index.digest,app.entry.entryId,{cacheRoot:app.cacheRoot,publisherTrustRoot:app.trustRoot});
  assert.equal(fetched.publisherEvidence.status,'evidence-invalid'); assert.equal(fetched.publisherEvidence.diagnostic,'PUBLISHER_ARTIFACT_MISMATCH');
  const trust = await readPublisherTrust({root:app.trustRoot}); assert.equal(trust.issuers[0].keys.length,1); assert.equal(trust.issuers[0].highestSequence,0);
});

test('publisher source: wrong key and replay are visible; read-only evidence preview cannot grant identity or execution',async () => {
  const app = await workspace(), {index,evidenceBytes} = await signed(app), registry = new SourceRegistry(app.trustRoot); await registry.initialize();
  await anchor(registry,generatePublisherKey());
  const untrusted = await registry.publisherEvidence({source:app.publication.indexPath,indexDigest:index.digest,entryId:app.entry.entryId});
  assert.equal(untrusted.report.publisherIdentity,'unanchored-key'); assert.equal(untrusted.report.artifactBytesVerified,false); assert.equal(untrusted.grantsExecution,false);
  await anchor(registry,app.key);
  const preview = await registry.publisherEvidence({evidencePath:join(app.cacheRoot,`${hash(evidenceBytes)}.publisher.json`),artifactPath:app.publication.artifactPath});
  assert.equal(preview.report.accepted,true); assert.equal(preview.report.observed,false); assert.equal(preview.artifact.sha256,app.entry.sha256);
  assert.equal((await readPublisherTrust({root:app.trustRoot})).issuers[0].highestSequence,0);
  const newer = statement(app.key,subject(app.entry),{sequence:2});
  assert.equal((await verifyStoredPublisherEvidence({root:app.trustRoot,artifact:subject(app.entry),evidenceBytes:Buffer.from(json(newer)),observe:true})).accepted,true);
  const replay = await verifyStoredPublisherEvidence({root:app.trustRoot,artifact:subject(app.entry),evidenceBytes,observe:false});
  assert.equal(replay.accepted,false); assert.equal(replay.error.code,'SEQUENCE_ROLLBACK');
});
