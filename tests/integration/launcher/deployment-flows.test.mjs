import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,writeFile,cp} from 'node:fs/promises';
import {workspace,fixturePackage,environment,json,save,until} from './helpers.mjs';
import {LauncherManager} from '../../../tools/launcher/manager.mjs';
import {importLocalArtifact,readLocalZip} from '../../../tools/launcher/local-artifacts.mjs';
import {previewComposition,createComposition} from '../../../tools/launcher/composition.mjs';
import {zipDirectory} from '../../../scripts/release/zip.mjs';
import {inspectPackage} from '../../../scripts/runtime/package.mjs';
import {createLauncherServer} from '../../../tools/launcher/server.mjs';

async function moduleFixture(app) {
  const pkg=await fixturePackage(app),source=join(pkg,'modules/fixture');
  await save(join(source,'deployment.json'),{format:'world-hub.deployment/v1',title:{zh:'测试程序',en:'Test program'},description:{zh:'测试接入',en:'Test connection'},topics:{input:'acceptance/input',output:'acceptance/output'},bridges:{main:{publish:['input','output'],subscribe:['input','output']}},settings:[{key:'mode',label:{zh:'模式',en:'Mode'},type:'string',default:'normal'}]});return source;
}
test('ZIP import validates complete module content and ordinary sources do not produce a success result',async t=>{
  const app=await workspace(t),source=await moduleFixture(app),zip=join(app.directory,'module.zip');await zipDirectory(source,zip);
  const imported=await importLocalArtifact({root:app.root,path:zip,kind:'module'});assert.equal(imported.object.id,'test.fixture');assert.equal(imported.startsModules,false);
  assert.deepEqual(await readFile(join(imported.object.path,'program.mjs')),await readFile(join(source,'program.mjs')));
  await assert.rejects(importLocalArtifact({root:app.root,path:app.directory,kind:'module'}),/complete module/);
  const damaged=Buffer.from(await readFile(zip));damaged[damaged.length-22+16]^=1;assert.throws(()=>readLocalZip(damaged),/ZIP/);
});
test('a fresh composition needs no base pack, pins selected modules and refuses changed review content',async t=>{
  const app=await workspace(t),source=await moduleFixture(app);
  const input={id:'test.blank',title:'From independent modules',modules:[{componentId:'one',directory:source}]};
  const preview=await previewComposition(input),created=await createComposition({root:app.root,input,preview,environment});
  const plan=await inspectPackage(created.directory,environment);assert.equal(plan.pack.components.length,1);assert.equal(plan.pack.topics['one.input'],'acceptance/input');
  await writeFile(join(source,'program.mjs'),(await readFile(join(source,'program.mjs')))+'\n// changed\n');
  await assert.rejects(createComposition({root:app.root,input,preview,environment}),/changed after review/);
});
test('independent programs share the real local Hub; stopping one preserves its peer and private credentials',async t=>{
  const app=await workspace(t),source=await moduleFixture(app),manager=new LauncherManager({root:app.root,...environment});await manager.initialize();app.cleanups.push(()=>manager.close());
  for(const id of ['first','second']){const preview=await manager.localPrograms.preview({programId:id,directory:source});await manager.localPrograms.register({reviewId:preview.reviewId,accepted:true});}
  for(const id of ['first','second']){const reviewed=await manager.localPrograms.reviewStart(id);await manager.localPrograms.start(id,{reviewId:reviewed.reviewId,accepted:true});}
  const programs=await manager.localPrograms.programs();assert.equal(programs.length,2);assert.ok(programs.every(program=>program.state==='running'&&program.communication==='connected'));assert.equal(programs[0].hubUrl,programs[1].hubUrl);
  manager.localPrograms.row('first').state='failed';
  await assert.rejects(manager.localPrograms.remove('first'),/Stop this owned/);
  assert.ok(manager.localPrograms.handles.has('first'));assert.equal(manager.localPrograms.handles.get('first').exit,null);
  app.trackedPids.add(manager.hub.pid);for(const handle of manager.localPrograms.handles.values())app.trackedPids.add(handle.pid);
  const hubPid=manager.hub.pid;await manager.localPrograms.stop('first');assert.equal(manager.hub.pid,hubPid);assert.equal(manager.hub.exit,null);assert.equal((await manager.localPrograms.programs()).find(program=>program.programId==='second').state,'running');
  const identity=await json(join(app.root,'local-programs/first/identity.json'));assert.equal(JSON.stringify(await manager.localPrograms.programs()).includes(identity.token),false);
  assert.equal((await json(join(app.root,'default-hub/hub.json'))).acl.allowUnlistedBridges,false);
  const restored=new LauncherManager({root:app.root,...environment});await restored.initialize();assert.equal((await restored.localPrograms.programs()).find(program=>program.programId==='second').state,'unknown');await restored.close();
  assert.equal(manager.localPrograms.handles.get('second').exit,null);assert.equal(manager.hub.exit,null);
});
test('HTTP accepts actual composition and program form objects and returns a usable precise review',async t=>{
  const app=await workspace(t),source=await moduleFixture(app),server=await createLauncherServer({root:app.root,port:0,...environment});app.cleanups.push(()=>server.close());
  const call=async(path,body)=>{const response=await fetch(new URL(path,server.url),{method:'POST',headers:{authorization:'Bearer '+server.token,'x-csrf-token':server.csrfToken,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.ok,true,JSON.stringify(value));return value;};
  const composition=await call('/api/compositions/preview',{id:'test.http',title:'HTTP composition',version:'1.0.0',modules:[{componentId:'one',directory:source,settings:{mode:'normal'},providers:[],after:[]}]});assert.ok(composition.reviewId);assert.equal(composition.preview.pack.components[0].id,'one');
  const local=await call('/api/programs/preview',{programId:'http-program',directory:source,settings:{mode:'normal'},bindings:[]});assert.equal(local.review.createsPack,false);const registered=await call('/api/programs/register',{reviewId:local.reviewId,accepted:true});assert.equal(registered.program.state,'stopped');
  const created=await call('/api/compositions/create',{reviewId:composition.reviewId,accepted:true});const operation=await until(()=>{const op=server.manager.operation(created.operationId);if(op.state==='failed')throw new Error(op.error.message);return op.state==='succeeded'?op:null;});assert.equal(operation.result.pack.id,'test.http');
});
test('stopping the local Hub cancels active and queued preparation, blocks new starts and waits for cleanup',async t=>{
  const app=await workspace(t),source=await moduleFixture(app),manager=new LauncherManager({root:app.root,...environment});await manager.initialize();app.cleanups.push(()=>manager.close());
  for(const id of ['preparing','queued']){const preview=await manager.localPrograms.preview({programId:id,directory:source});await manager.localPrograms.register({reviewId:preview.reviewId,accepted:true});}
  const firstReview=await manager.localPrograms.reviewStart('preparing'),secondReview=await manager.localPrograms.reviewStart('queued');
  const hubStart=manager.defaultHub('start');await manager.operations.get(hubStart.operationId).promise;assert.equal(manager.operation(hubStart.operationId).state,'succeeded');app.trackedPids.add(manager.hub.pid);
  let preparationCount=0,preparationSignal,entered,releaseCleanup;
  const enteredPromise=new Promise(done=>{entered=done;}),cleanupGate=new Promise(done=>{releaseCleanup=done;});
  // Model a long author-declared download and its controlled abort cleanup.
  // No external network or install hooks are used by this regression.
  manager.localPrograms.prepareDependencies=async({signal})=>{
    preparationCount++;preparationSignal=signal;entered();
    await new Promise(done=>{if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});});
    await cleanupGate;throw Object.assign(new Error('Preparation cancelled'),{code:'DEPENDENCY_PREPARATION_ABORTED'});
  };
  const first=manager.launch('local-start','$local-preparing',(_,signal)=>manager.localPrograms.start('preparing',{reviewId:firstReview.reviewId,accepted:true,signal}));
  await enteredPromise;
  const second=manager.launch('local-start','$local-queued',(_,signal)=>manager.localPrograms.start('queued',{reviewId:secondReview.reviewId,accepted:true,signal}));
  await until(()=>manager.localPrograms.startControllers.size===2);
  const stop=manager.defaultHub('stop');assert.equal(preparationSignal.aborted,true);
  assert.equal(manager.defaultHub('stop').operationId,stop.operationId);
  assert.throws(()=>manager.defaultHub('start'),error=>error.code==='LOCAL_HUB_STOPPING');
  assert.throws(()=>manager.launch('local-start','$local-new',()=>{}),error=>error.code==='LOCAL_HUB_STOPPING');
  assert.throws(()=>manager.localPrograms.start('queued',{reviewId:secondReview.reviewId,accepted:true}),error=>error.code==='LOCAL_HUB_STOPPING');
  assert.equal(manager.operation(stop.operationId).state,'running');assert.equal(manager.hub.exit,null);
  releaseCleanup();
  await Promise.all([manager.operations.get(first.operationId).promise,manager.operations.get(second.operationId).promise,manager.operations.get(stop.operationId).promise]);
  assert.equal(manager.operation(first.operationId).state,'failed');assert.equal(manager.operation(second.operationId).state,'failed');
  assert.equal(manager.operation(stop.operationId).state,'succeeded');assert.equal(preparationCount,1);assert.ok(manager.hub.exit);
  assert.equal(manager.localPrograms.handles.size,0);assert.equal(manager.localPrograms.startControllers.size,0);
  assert.ok((await manager.localPrograms.programs()).every(program=>program.state==='stopped'));
  assert.equal(manager.defaultHubStopping,false);assert.equal(manager.localPrograms.startsPaused,false);
});
test('local Hub Stop retries owned cleanup even after its wrapper has already exited',async t=>{
  const app=await workspace(t),source=await moduleFixture(app),manager=new LauncherManager({root:app.root,...environment});await manager.initialize();app.cleanups.push(()=>manager.close());
  const reviewed=await manager.localPrograms.preview({programId:'retirement',directory:source});await manager.localPrograms.register({reviewId:reviewed.reviewId,accepted:true});
  let retries=0,canRetire=false;const handle={exit:{code:0},cleanupIncomplete:true,stdout:'',stderr:'',truncated:false,stop:async()=>{retries++;if(!canRetire)throw new Error('Owned tree retirement still unconfirmed');delete handle.cleanupIncomplete;return handle.exit;}};
  manager.localPrograms.handles.set('retirement',handle);manager.localPrograms.row('retirement').state='unknown';
  const first=manager.defaultHub('stop');await manager.operations.get(first.operationId).promise;
  assert.equal(manager.operation(first.operationId).state,'failed');assert.equal(handle.cleanupIncomplete,true);
  assert.equal((await manager.localPrograms.programs())[0].state,'unknown');canRetire=true;
  const stop=manager.defaultHub('stop');await manager.operations.get(stop.operationId).promise;
  assert.equal(manager.operation(stop.operationId).state,'succeeded');assert.equal(retries,2);assert.equal(handle.cleanupIncomplete,undefined);
  assert.equal((await manager.localPrograms.programs())[0].state,'stopped');
});
