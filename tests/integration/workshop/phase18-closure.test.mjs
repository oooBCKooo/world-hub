import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';
import { initializeAdmin } from '../../../tools/workshop/store.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { publishArtifact, validateArtifactBytes } from '../../../scripts/runtime/sources.mjs';
import { validateModuleDirectory } from '../../../scripts/runtime/developer.mjs';
import { reserveEvidenceRun, saveLatestEvidence } from '../../helpers/evidence-run.mjs';
import { workshopCall, registerMember, launcherClient, prepareNodeScene, mirrorWorkshop, readJson, saveJson, unpackForAuthorReview } from './phase18-helpers.mjs';

const password = 'phase18-local-fixture-password-only';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = path => assert.rejects(access(path), { code: 'ENOENT' });
const expectedStatistics = text => ({ codePoints: [...text].length, lines: text.split('\n').length, utf8Bytes: Buffer.byteLength(text), sha256: checksum(Buffer.from(text)) });

test('PHASE18-WORKSHOP real author/user HTTP closure, immutable updates, independent execution review and offline/hidden local continuity', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-workshop-phase18-'));
  const evidence = await reserveEvidenceRun(resolve('.artifacts/workshop-phase18'));
  const report = { format: 'world-hub.workshop-closure-report/v1', version: JSON.parse(await readFile(new URL('../../../package.json', import.meta.url))).version,
    passed: false, humanIndependentAcceptance: 'pending', transport: 'real-loopback-HTTP-to-static-local-mirror',
    limitations: ['Local actors are automated test roles, not two independent human authors.', 'Production HTTPS download, browser usability and publisher signature identity are separate acceptance scopes.'], checks: [], failures: [] };
  let workshop, launcher; const ownedProcesses = new Map();
  const rememberProcesses=()=>{
    const manager=launcher.manager,runId=manager.hub.launcherRunId;
    for(const handle of [manager.hub,...manager.localPrograms.handles.values()])ownedProcesses.set(runId+':'+handle.pid,{runId,handle});
  };
  t.after(async () => {
    if (launcher) await launcher.close(); if (workshop) await workshop.close();
    report.processes = [...ownedProcesses.values()].map(({ runId, handle }) => {
      // A numeric PID may already belong to another concurrent test's child.
      // Require the retained child object's actual close receipt instead of
      // identifying an owned process through a reusable operating-system ID.
      const exitConfirmed = Boolean(handle.exit && !handle.cleanupIncomplete
        && (handle.child.exitCode !== null || handle.child.signalCode !== null));
      let pidPresentAfterCleanup = false; try { process.kill(handle.pid, 0); pidPresentAfterCleanup = true; } catch {}
      return { pid: handle.pid, runId, exit: handle.exit, exitConfirmed, pidPresentAfterCleanup, aliveAfterCleanup: !exitConfirmed };
    });
    if (report.processes.some(value => value.aliveAfterCleanup)) report.passed = false;
    await saveJson(join(evidence.directory, 'report.json'), report); await saveLatestEvidence(evidence, report);
    t.diagnostic('WORKSHOP_PHASE18_EVIDENCE ' + JSON.stringify({ report: join(evidence.directory, 'report.json'), checks: report.checks.length }));
    assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('world-hub-workshop-phase18-'));
    await rm(directory, { recursive: true, force: true });
    for (const process of report.processes) assert.equal(process.exitConfirmed, true, `Owned runtime process ${process.pid} in run ${process.runId} has no confirmed close receipt`);
  });
  const check = (step, details = {}) => report.checks.push({ step, ...details });
  const serverRoot = join(directory, 'workshop-private'), localRoot = join(directory, 'launcher-private');
  try {
  await initializeAdmin({ root: serverRoot, username: 'operator', password });
  workshop = await createWorkshopServer({ root: serverRoot, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false });
  launcher = await createLauncherServer({ root: localRoot, nodePath: process.execPath, port: 0 });
  const { call, finish } = launcherClient(launcher);
  const login = await workshopCall(workshop, 'api/login', { username: 'operator', password }); const admin = { ...login.data, cookie: login.cookie };
  const author = await registerMember(workshop, admin, 'author-a', password), user = await registerMember(workshop, admin, 'user-b', password);
  assert.notEqual(author.user.id, user.user.id);
  const scene = await prepareNodeScene(directory);
  const publication = await publishArtifact(scene.provider, { kind: 'module', destination: join(directory, 'author-upload'), redistributionAcknowledged: true });
  const artifact = await readJson(publication.artifactPath);
  const published = (await workshopCall(workshop, 'api/publications', { artifact, title: 'Text statistics by author A', redistributionAcknowledged: true }, author, 201)).data.publication;
  const detail = (await workshopCall(workshop, `api/publications/${published.entryId}`)).data;
  assert.equal(detail.publication.owner.username, 'author-a'); assert.equal(detail.entry.license, 'MIT'); assert.deepEqual(detail.entry.provides, [{ id: 'text.statistics', version: '1.0.0' }]);
  await absent(join(serverRoot, 'provider-started.json'));
  check('author-a-published-immutable-module', { entryId: published.entryId, artifactSha256: published.sha256, authorAccount: 'author-a', license: 'MIT', workshopStartsPrograms: false });

  const mirror = await mirrorWorkshop(workshop, join(directory, 'static-mirror'));
  const { source } = await call('/api/sources/save', { name: 'Local Workshop test transport', source: mirror.indexPath });
  const sourceReview = await call('/api/sources/inspect', { sourceId: source.id });
  const discovered = sourceReview.index.entries.find(value => value.entryId === published.entryId); assert.ok(discovered);
  assert.equal(discovered.sha256, published.sha256); assert.deepEqual(discovered.provides, detail.entry.provides);
  const artifactPath = join(mirror.mirrorDirectory, discovered.source.path), originalBytes = await readFile(artifactPath);
  const sourceFetch = () => call('/api/sources/fetch', { sourceId: source.id, receiptId: sourceReview.receiptId, entryId: discovered.entryId }, 202);
  await writeFile(artifactPath, Buffer.concat([originalBytes, Buffer.from(' ')]));
  const corrupt = await finish(await sourceFetch(), 'failed'); assert.match(corrupt.error.message, /Downloaded artifact hash mismatch/);
  assert.ok(corrupt.error.diagnostic?.en); report.failures.push({ scenario: 'downloaded-bytes-mismatch', code: corrupt.error.code, message: corrupt.error.message, diagnostic: corrupt.error.diagnostic });
  await absent(join(localRoot, 'source-cache', discovered.sha256));
  await absent(join(localRoot, 'source-cache', `${discovered.sha256}.artifact.json`));
  await unlink(artifactPath);
  const missing = await finish(await sourceFetch(), 'failed'); assert.equal(missing.error.code, 'ENOENT'); assert.ok(missing.error.diagnostic?.en);
  report.failures.push({ scenario: 'artifact-download-unavailable', code: missing.error.code, message: missing.error.message, diagnostic: missing.error.diagnostic });
  await absent(join(localRoot, 'source-cache', discovered.sha256));
  await writeFile(artifactPath, originalBytes);
  const fetched = (await finish(await sourceFetch())).result;
  assert.equal(fetched.sourceReceipt.integrityVerified, true);
  for (const dimension of ['publisherIdentityVerified', 'codeSafetyVerified', 'executionAuthorized', 'sandbox']) assert.equal(fetched.sourceReceipt[dimension], false);
  await absent(join(fetched.directory, 'provider-started.json'));
  check('user-b-discovered-and-fetched', { upstreamIndexSha256: mirror.upstreamIndexSha256, artifactSha256: fetched.entry.sha256,
    sourceIndexSha256: sourceReview.digest, trust: fetched.sourceReceipt, downloadedSourceNotExecuted: true });

  const unchangedConsumer=checksum(await readFile(join(scene.modules.desk,'program.mjs')));
  const register=async(programId,directory,configuration={})=>{
    const inspected=await call('/api/programs/preview',{programId,directory,...configuration});
    await call('/api/programs/register',{reviewId:inspected.reviewId,accepted:true});return inspected;
  };
  await register('source',scene.modules.source);
  const registration=await register('stats',fetched.directory,{settings:{},topics:{stats:'sample/text/statistics'},bridges:{main:{publish:['stats'],subscribe:['stats']}}});
  await register('desk',scene.modules.desk,{bindings:[{providerId:'source',contract:{id:'text.read',version:'1.0.0'}},{providerId:'stats',contract:{id:'text.statistics',version:'1.0.0'}}]});
  assert.equal(checksum(await readFile(launcher.manager.localPrograms.path('desk','module/program.mjs'))),unchangedConsumer);
  const reused=await finish(await call('/api/programs/stats/start',{reviewId:registration.reviewId,accepted:true},202),'failed');assert.equal(reused.error.code,'LOCAL_REVIEW_REQUIRED');
  let executionReview;
  const startModules=async()=>{
    for(const id of ['source','stats','desk']){
      executionReview=await call('/api/programs/'+id+'/review',{});
      if(id==='stats'){const denied=await finish(await call('/api/programs/'+id+'/start',{reviewId:executionReview.reviewId,accepted:false},202),'failed');assert.equal(denied.error.code,'TRUST_REQUIRED');}
      await finish(await call('/api/programs/'+id+'/start',{reviewId:executionReview.reviewId,accepted:true},202));
    }
    rememberProcesses();return (await call('/api/programs')).programs.find(row=>row.programId==='desk');
  };
  const stopModules=async()=>{for(const id of ['desk','stats','source'])await finish(await call('/api/programs/'+id+'/stop',{},202));};
  const running=await startModules();
  const analyze = async text => {
    const response = await fetch(new URL('/analyze', running.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.deepEqual(value.result.output, expectedStatistics(text));
    assert.equal(value.result.provider, artifact.id); assert.equal(value.result.text, text); assert.equal(value.result.receipts.length, 3); return value;
  };
  const text = ' Workshop → Launcher 🌍\nExact content, unchanged consumer.\n'; const business = await analyze(text);
  check('module-declarations-then-fresh-authorized-execution-then-real-business',{
    consumerSourceSha256:unchangedConsumer,executionReviewDigest:executionReview.review.digest,
    oneHub:(await call('/api/hubs')).hubs.length===1,providerRuntime:'node',business:{text,output:business.result.output,receipts:business.result.receipts}});

  const comment = (await workshopCall(workshop, `api/publications/${published.entryId}/comments`, { text: 'User B verified this exact version with Unicode, spaces and LF. Suggest clarifying the fixture comment.' }, user, 201)).data.comment;
  assert.equal(comment.author.username, 'user-b');
  const nextDirectory = join(directory, 'user-proposed-module'); await cp(scene.provider, nextDirectory, { recursive: true });
  const nextManifest = await readJson(join(nextDirectory, 'module.json')); nextManifest.version = '1.0.1'; await saveJson(join(nextDirectory, 'module.json'), nextManifest);
  await writeFile(join(nextDirectory, 'program.mjs'), '// Reviewed clarification; public contract and business behavior are unchanged.\n' + await readFile(join(nextDirectory, 'program.mjs'), 'utf8'));
  const nextPublication = await publishArtifact(nextDirectory, { kind: 'module', destination: join(directory, 'proposed-upload'), redistributionAcknowledged: true });
  const nextArtifact = await readJson(nextPublication.artifactPath);
  const proposal = (await workshopCall(workshop, `api/publications/${published.entryId}/proposals`, { artifact: nextArtifact, title: 'Exact baseline clarification', baseSha256: published.sha256, redistributionAcknowledged: true }, user, 201)).data.proposal;
  assert.equal((await workshopCall(workshop, 'index.json')).data.entries.length, 1, 'A proposal cannot publish or mutate original code');
  const review = (await workshopCall(workshop, `api/publications/${published.entryId}/proposals/${proposal.id}`, undefined, author)).data;
  assert.equal(review.proposal.baseSha256, published.sha256); const proposedBytes = Buffer.from(JSON.stringify(review.artifact) + '\n');
  assert.equal(checksum(proposedBytes), proposal.sha256); assert.equal(validateArtifactBytes(proposedBytes).artifact.version, '1.0.1');
  const authorReview = await unpackForAuthorReview(review.artifact, join(directory, 'author-review'));
  const authorValidation = await validateModuleDirectory({ directory: authorReview.directory }); assert.equal(authorValidation.ok, true);
  assert.equal(authorValidation.behaviorValidated, false, 'An author declaration check cannot certify business behavior');
  await absent(join(authorReview.directory, 'provider-started.json'));
  const authorPrepared = await publishArtifact(authorReview.directory, { kind: 'module', destination: join(directory, 'author-reviewed-upload'), redistributionAcknowledged: true });
  const authorArtifact = await readJson(authorPrepared.artifactPath);
  const updated = (await workshopCall(workshop, 'api/publications', { artifact: authorArtifact, title: 'Author A reviewed version 1.0.1', redistributionAcknowledged: true }, author, 201)).data.publication;
  assert.notEqual(updated.sha256, published.sha256);
  const conflictArtifact = structuredClone(nextArtifact); conflictArtifact.provenance.changed = true;
  const conflict = await workshopCall(workshop, 'api/publications', { artifact: conflictArtifact, redistributionAcknowledged: true }, author, 409);
  assert.equal(conflict.data.error.code, 'IMMUTABLE_VERSION'); report.failures.push({ scenario: 'version-content-conflict', ...conflict.data.error });
  const stale = await workshopCall(workshop, `api/publications/${updated.entryId}/proposals`, { artifact, baseSha256: published.sha256, redistributionAcknowledged: true }, user, 409);
  assert.equal(stale.data.error.code, 'BASELINE_CHANGED'); report.failures.push({ scenario: 'proposal-baseline-does-not-match-selected-version', ...stale.data.error });
  const historicalResponse = await fetch(new URL(`artifacts/${published.sha256}.json`, workshop.url)); assert.equal(historicalResponse.status, 200);
  assert.equal(checksum(Buffer.from(await historicalResponse.arrayBuffer())), published.sha256);
  check('user-feedback-author-review-and-new-immutable-version', { commentId: comment.id, proposalId: proposal.id,
    proposalBaseSha256: proposal.baseSha256, originalSha256: published.sha256, newSha256: updated.sha256,
    authorLocalValidation: { ok: authorValidation.ok, startsModules: authorValidation.startsModules, behaviorValidated: authorValidation.behaviorValidated },
    oldVersionRemainsDigestAddressable: true, proposalsExecuteCode: false });

  await workshopCall(workshop, `api/publications/${published.entryId}/visibility`, { hidden: true }, admin);
  const hidden = await fetch(new URL(`artifacts/${published.sha256}.json`, workshop.url)); assert.equal(hidden.status, 404);
  await mirrorWorkshop(workshop, mirror.mirrorDirectory);
  const refreshed = await call('/api/sources/inspect', { sourceId: source.id }); assert.equal(refreshed.index.entries.some(value => value.sha256 === published.sha256), false);
  const catalog = await call('/api/sources'); const withdrawn = catalog.entries.find(value => value.sha256 === published.sha256);
  assert.equal(withdrawn.entryState, 'withdrawn'); assert.equal(withdrawn.cached, true); assert.equal(withdrawn.cachedVerified, false, 'Presence alone never claims verified cache contents');
  const staleSource = await finish(await sourceFetch(), 'failed'); assert.match(staleSource.error.message, /Source index changed|Source entry not found/);
  report.failures.push({ scenario: 'online-withdrawn-version-does-not-silently-use-stale-index', code: staleSource.error.code, message: staleSource.error.message });
  await analyze('Hidden source, existing local instance 🌍');
  const workshopURL = workshop.url; await workshop.close(); workshop = null; await unlink(mirror.indexPath);
  await assert.rejects(fetch(new URL('health', workshopURL), { signal: AbortSignal.timeout(3000) }), /fetch failed/);
  const unavailable=await call('/api/sources/inspect',{sourceId:source.id});assert.equal(unavailable.offline,true);
  const offline=(await finish(await sourceFetch())).result;
  assert.equal(offline.cached, true); assert.equal(offline.offline, true); assert.equal(offline.sourceReceipt.integrityVerified, true); assert.equal(offline.sourceReceipt.executionAuthorized, false);
  assert.equal(offline.sourceReceipt.artifactSha256, published.sha256);
  await analyze('Offline community, local business still succeeds 🌍');
  await stopModules();
  const restarted=await startModules();running.entryUrl=restarted.entryUrl;await analyze('Offline restart after a fresh execution review 🌍');
  await stopModules();
  check('hidden-and-offline-community-do-not-revoke-local-code-or-run-authorization', { hiddenCatalogEntry: 'withdrawn', onlineStaleIndexRejected: true,
    offlineCachedArtifactRevalidated: true, runningBusinessSucceeded: true, offlineRestartRequiredNewReview: true, freshReviewRestartSucceeded: true,
    hiddenPublicationRemoteAccessDenied: true, communityHidingDoesNotEraseLocalFiles: true });
  report.passed = true;
  } catch (error) { report.error = { code: error.code ?? 'TEST_FAILURE', message: error.message }; throw error; }
});
