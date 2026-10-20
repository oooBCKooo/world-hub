import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {workspace,fixturePackage,environment,json,save} from '../launcher/helpers.mjs';
import {importPackage,inspectPackage,createLock} from '../../../scripts/runtime/package.mjs';
import {startInstance} from '../../../scripts/runtime/runtime.mjs';
import {previewAssemblySave,applyAssemblySave,assertNoIncompleteAssemblySaves} from '../../../scripts/runtime/assembly-save.mjs';

async function setup(t){
  const app=await workspace(t),source=await fixturePackage(app),id='composition';
  const imported=await importPackage(source,{root:app.root,instanceId:id,...environment});
  const sessions=[];app.cleanups.push(async()=>{for(const session of sessions)await session.close();});
  const start=async()=>{const plan=await inspectPackage(join(imported.stateDir,'package'),environment);const session=await startInstance({root:app.root,instanceId:id,...environment,trust:plan.digest});sessions.push(session);app.trackSession(session);return session;};
  const session=await start();await session.close();
  const status=await json(join(imported.stateDir,'status.json'));
  const origin={runId:status.runId,revision:status.assembly.revision,baselineDigest:imported.digest,targetInstanceId:id};
  return {...app,id,directory:imported.stateDir,start,origin};
}
async function candidate(app,version,edit){
  const target=join(app.directory,'candidate-'+randomUUID());
  await cp(join(app.directory,'package'),target,{recursive:true});
  const pack=await json(join(target,'pack.json'));pack.version=version;edit?.(pack);
  await save(join(target,'pack.json'),pack);await createLock(target,environment);return target;
}

test('ASSEMBLY-SAVE stopped composition additions and removals persist on the same instance with explicit state policies and recoverable data', {timeout:90000},async t=>{
  const app=await setup(t),stateFile=join(app.directory,'programs/fixture/private-document.txt');
  await writeFile(stateFile,'Private opaque document 🌍');
  const next=await candidate(app,'2.0.0',pack=>{pack.components.push({...structuredClone(pack.components[0]),id:'added'});pack.lifecyclePolicy='independent';});
  const options={root:app.root,instanceId:app.id,candidate:next,origin:app.origin,...environment,
    statePolicies:[{componentId:'fixture',mode:'preserve',dataFormat:'fixture.documents/v1'},{componentId:'added',mode:'fresh'}]};
  const preview=await previewAssemblySave(options);
  const updated=await applyAssemblySave({...options,expectedDigest:preview.digest,accepted:true});
  assert.equal(updated.pack.version,'2.0.0');assert.equal(updated.instanceId,app.id);assert.equal(updated.startsModules,false);
  assert.equal(updated.plan.directory,join(app.directory,'package'));
  assert.equal((await inspectPackage(updated.plan.directory,environment)).digest,updated.plan.digest);
  assert.equal(await readFile(stateFile,'utf8'),'Private opaque document 🌍');
  assert.equal((await inspectPackage(join(app.directory,'package'),environment)).pack.components.length,2);
  assert.equal((await inspectPackage(join(updated.previousDirectory,'package'),environment)).pack.version,'1.0.0');
  const run=await app.start();assert.equal((await run.status()).components.length,2);await run.close();
  await writeFile(join(app.directory,'programs/added/kept.txt'),'New module private data');
  const status=await json(join(app.directory,'status.json')),before=await inspectPackage(join(app.directory,'package'),environment);
  const removed=await candidate(app,'2.0.1',pack=>{pack.components=pack.components.filter(component=>component.id!=='fixture');pack.entry.component='added';});
  const removeOptions={...options,candidate:removed,origin:{runId:status.runId,revision:status.assembly.revision,baselineDigest:before.digest,targetInstanceId:app.id},
    statePolicies:[{componentId:'fixture',mode:'retain-removed'},{componentId:'added',mode:'preserve',dataFormat:'fixture.documents/v1'}]};
  const removeReview=await previewAssemblySave(removeOptions),saved=await applyAssemblySave({...removeOptions,expectedDigest:removeReview.digest,accepted:true});
  assert.equal(await readFile(join(saved.previousDirectory,'programs/fixture/private-document.txt'),'utf8'),'Private opaque document 🌍');
  assert.equal(await readFile(join(app.directory,'programs/added/kept.txt'),'utf8'),'New module private data');
  const restarted=await app.start();assert.deepEqual((await restarted.status()).components.map(row=>row.id),['added']);await restarted.close();
});

test('ASSEMBLY-SAVE rejects missing policies, stale source/run/version and data changed after review without replacing source', {timeout:60000},async t=>{
  const app=await setup(t),next=await candidate(app,'2.0.0'),original=await readFile(join(app.directory,'package/pack.lock'));
  const options={root:app.root,instanceId:app.id,candidate:next,origin:app.origin,...environment,statePolicies:[{componentId:'fixture',mode:'preserve',dataFormat:'fixture/v1'}]};
  await assert.rejects(previewAssemblySave({...options,statePolicies:[]}),{code:'ASSEMBLY_SAVE_POLICY_REQUIRED'});
  await assert.rejects(previewAssemblySave({...options,origin:{...app.origin,revision:999}}),{code:'ASSEMBLY_SAVE_STALE'});
  const preview=await previewAssemblySave(options);
  await writeFile(join(app.directory,'programs/fixture/unreviewed.txt'),'State changed');
  await assert.rejects(applyAssemblySave({...options,expectedDigest:preview.digest,accepted:true}),{code:'ASSEMBLY_SAVE_CHANGED'});
  assert.deepEqual(await readFile(join(app.directory,'package/pack.lock')),original);
  await assert.rejects(applyAssemblySave({...options,expectedDigest:preview.digest,accepted:false}),{code:'ASSEMBLY_SAVE_REVIEW_REQUIRED'});
});

test('ASSEMBLY-SAVE incomplete journals block Runtime start even if someone removes the maintenance lock', {timeout:60000},async t=>{
  const app=await setup(t),transactionId=randomUUID(),directory=join(app.directory,'assembly-saves',transactionId);
  await mkdir(directory,{recursive:true});await save(join(directory,'transaction.json'),{format:'world-hub.assembly-save/v1',transactionId,state:'committing'});
  await assert.rejects(assertNoIncompleteAssemblySaves(app.directory),{code:'ASSEMBLY_SAVE_RECOVERY_REQUIRED'});
  await assert.rejects(app.start(),{code:'ASSEMBLY_SAVE_RECOVERY_REQUIRED'});
});
