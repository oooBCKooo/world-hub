import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { inspectAuthoring, derivePackage } from '../../../scripts/runtime/authoring.mjs';
import { createLock, inspectPackage } from '../../../scripts/runtime/package.mjs';
import { compareUpgradePackages } from '../../../scripts/runtime/upgrade.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { workspace, fixturePackage, environment, until, ROOT } from './helpers.mjs';

function api(server) {
  return async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(120000),
      headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
}
async function operation(call, started) {
  const row = await until(async () => { const value = (await call('/api/operations/' + started.operationId)).operation; return value.state !== 'running' && value; }, { timeoutMs: 90000 });
  assert.equal(row.state, 'succeeded', JSON.stringify(row)); return row.result;
}
async function action(call, base, input) {
  const snapshot = await call(base), review = await call(base + '/preview', { ...input, expectedRevision: snapshot.assembly.revision });
  return operation(call, await call(base + '/apply', { reviewId: review.reviewId, accepted: true }, 202));
}

test('Mesh composition HTTP preserves manual-start and critical flags, reuses reviewed member controls, and saves its next version to the same instance', { timeout: 90000 }, async t => {
  const app=await workspace(t),source=await fixturePackage(app),server=await createLauncherServer({root:app.root,port:0,...environment});app.cleanups.push(()=>server.close());const call=api(server);
  const input={id:'test.mesh',version:'1.0.0',title:'Manual mesh',packType:'mesh',modules:[{componentId:'manual',directory:join(source,'modules/fixture'),autostart:false,critical:true,
    topics:{input:'acceptance/input',output:'acceptance/output'},bridges:{main:{publish:['input','output'],subscribe:['input','output']}},settings:{mode:'normal'}}]};
  const preview=await call('/api/compositions/preview',input);assert.equal(preview.preview.pack.packType,'mesh');assert.equal(Object.hasOwn(preview.preview.pack,'lifecyclePolicy'),false);
  const created=await operation(call,await call('/api/compositions/create',{reviewId:preview.reviewId,accepted:true},202));
  const originalBytes=await readFile(join(created.directory,'pack.json'));const inspected=await call('/api/review',{directory:created.directory});
  const imported=await call('/api/instances',{reviewId:inspected.reviewId,instanceId:'mesh-manual'});
  assert.equal(imported.instance.pack.packType,'mesh');assert.equal(imported.instance.pack.lifecyclePolicy,'independent');assert.equal(imported.instance.pack.components[0].autostart,false);
  assert.equal(imported.instance.pack.components[0].critical,true);assert.equal(imported.instance.packMetadataUnavailable,false);
  const review=await call('/api/instances/mesh-manual/review',{});
  await operation(call,await call('/api/instances/mesh-manual/start',{reviewId:review.reviewId,accepted:true},202));app.trackSession(server.manager.sessions.get('mesh-manual'));
  const base='/api/instances/mesh-manual/assembly',initial=(await call(base)).assembly,hubPid=(await server.manager.instance('mesh-manual')).status.hub.pid;
  assert.equal(initial.packType,'mesh');assert.equal(initial.lifecyclePolicy,'independent');assert.equal(initial.programs[0].state,'stopped');assert.equal(initial.programs[0].critical,true);
  const wrongRun=await call(base+'/preview',{action:'start',componentId:'manual',expectedRunId:'00000000-0000-4000-8000-000000000000',expectedRevision:initial.revision},409);
  assert.equal(wrongRun.error.code,'RUNTIME_ASSEMBLY_STALE_RUN');
  assert.equal((await call('/api/instances/mesh-manual')).instance.links.entryUrl,null);
  await call('/api/instances/mesh-manual/components/manual/start',{},404);
  await action(call,base,{action:'start',componentId:'manual'});app.trackSession(server.manager.sessions.get('mesh-manual'));
  assert.equal((await call(base)).assembly.programs[0].state,'running');
  await action(call,base,{action:'stop',componentId:'manual'});
  const stopped=(await call(base)).assembly.programs[0];
  await call(base+'/preview',{action:'configure',componentId:'manual',autostart:'false',expectedRevision:(await call(base)).assembly.revision},400);
  await action(call,base,{action:'configure',componentId:'manual',settings:{mode:'normal',label:'Explicit configuration'},topics:stopped.topics,bridges:stopped.bridges,
    bindings:[],autostart:false,critical:true});
  const configured=(await call(base)).assembly.programs[0];assert.equal(configured.autostart,false);assert.equal(configured.critical,true);
  await action(call,base,{action:'set-policy',policy:'fail-fast'});
  const active=(await call('/api/instances/mesh-manual')).instance;assert.equal(active.pack.packType,'mesh');assert.equal(active.pack.lifecyclePolicy,'fail-fast');
  assert.equal(active.status.hub.pid,hubPid);assert.deepEqual(await readFile(join(created.directory,'pack.json')),originalBytes);
  const snapshot=await call(base+'/snapshot',{}),snapshotAuthoring=await inspectAuthoring(snapshot.directory,environment);assert.equal(snapshot.pack.lifecyclePolicy,'fail-fast');
  const pack={...snapshot.pack,version:'1.0.1'};const derived=await derivePackage(snapshot.directory,{...environment,pack,expectedRevision:snapshotAuthoring.revision,
    destination:join(app.directory,'derived-mesh'),redistributionAcknowledged:true});
  assert.equal(derived.pack.packType,'mesh');assert.equal(derived.pack.components[0].critical,true);assert.equal(derived.pack.components[0].autostart,false);
  await operation(call,await call('/api/instances/mesh-manual/stop',{},202));
  const save=await call(base+'/save-preview',{directory:snapshot.directory,pack,expectedRevision:snapshotAuthoring.revision,origin:snapshot.origin,
    redistributionAcknowledged:true,...environment});
  const saved=await operation(call,await call(base+'/save-apply',{previewId:save.previewId,accepted:true},202));
  assert.equal(saved.instance.pack.version,'1.0.1');assert.equal(saved.instance.pack.packType,'mesh');assert.equal(saved.instance.pack.lifecyclePolicy,'fail-fast');
  const restart=await call('/api/instances/mesh-manual/review',{});
  await operation(call,await call('/api/instances/mesh-manual/start',{reviewId:restart.reviewId,accepted:true},202));app.trackSession(server.manager.sessions.get('mesh-manual'));
  assert.equal((await call(base)).assembly.programs[0].state,'stopped');
  await operation(call,await call('/api/instances/mesh-manual/stop',{},202));
  server.manager.records.get('mesh-manual').pack={id:'test.mesh',version:'0.0.0',title:'Stale registry'};await server.manager.save();
  const reloaded=new LauncherManager({root:app.root,...environment});await reloaded.initialize();app.cleanups.push(()=>reloaded.close());
  const actual=await reloaded.instance('mesh-manual');assert.equal(actual.pack.version,'1.0.1');assert.equal(actual.pack.packType,'mesh');assert.equal(actual.pack.lifecyclePolicy,'fail-fast');
  app.record('manual-mesh-http-and-save',{manualMemberReviewed:true,hubNotRestartedDuringChanges:true,packType:'mesh',override:'fail-fast',version:'1.0.1',staleRegistryIgnored:true});
});

test('Global Hub exports both selectable presets but rejects lifecycle fields on direct configuration updates without dropping them', { timeout: 60000 }, async t => {
  const app=await workspace(t),manager=new LauncherManager({root:app.root,...environment});await manager.initialize();app.cleanups.push(()=>manager.close());
  const registered=await manager.localPrograms.preview({programId:'source',directory:join(ROOT,'examples/ecosystem-pack/modules/source')});
  await manager.localPrograms.register({reviewId:registered.reviewId,accepted:true});
  const snapshot=await manager.programAssembly({entry:'source'}),original=await readFile(join(app.root,'local-programs/registry.json'));
  const authoring=await inspectAuthoring(snapshot.directory,environment);
  for(const packType of ['atomic','mesh']){
    const pack={...snapshot.pack,version:'0.1.1',packType};pack.components=pack.components.map(component=>({...component,autostart:false,critical:true}));
    const derived=await derivePackage(snapshot.directory,{...environment,pack,expectedRevision:authoring.revision,destination:join(app.directory,'export-'+packType),redistributionAcknowledged:true});
    assert.equal(derived.pack.packType,packType);assert.equal(derived.pack.components[0].autostart,false);assert.equal(derived.pack.components[0].critical,true);
    await assert.rejects(manager.programAssemblyPreview({directory:snapshot.directory,pack,expectedRevision:snapshot.composition.revision}),{code:'GLOBAL_ASSEMBLY_LIFECYCLE_UNSUPPORTED'});
  }
  for(const [key,value] of [['lifecyclePolicy','independent'],['critical',true]]){
    const pack=structuredClone(snapshot.pack);pack.version='0.1.1';if(key==='lifecyclePolicy')pack[key]=value;else pack.components[0][key]=value;
    await assert.rejects(manager.programAssemblyPreview({directory:snapshot.directory,pack,expectedRevision:snapshot.composition.revision}),{code:'GLOBAL_ASSEMBLY_LIFECYCLE_UNSUPPORTED'});
  }
  assert.deepEqual(await readFile(join(app.root,'local-programs/registry.json')),original);assert.equal(manager.hub,null);
  app.record('global-hub-preset-export-only',{exports:['atomic','mesh'],directLifecycleUpdatesRejected:true,registrationsUnchanged:true});
});

test('upgrade review exposes preset, fault policy and per-component initial-start and critical changes without rewriting omitted source fields', { timeout: 45000 }, async t => {
  const app=await workspace(t),source=await fixturePackage(app),current=await inspectPackage(source,environment);
  const bytes=await readFile(join(source,'pack.json')),beforeDigest=hash(bytes),pack=JSON.parse(bytes);pack.version='1.0.1';pack.packType='mesh';
  pack.components[0].autostart=false;pack.components[0].critical=true;
  await writeFile(join(source,'pack.json'),JSON.stringify(pack));await createLock(source,environment);const candidate=await inspectPackage(source,environment);
  const diff=compareUpgradePackages(current,candidate);assert.deepEqual(diff.lifecycle,{changed:true,before:{packType:'atomic',lifecyclePolicy:'fail-fast'},after:{packType:'mesh',lifecyclePolicy:'independent'}});
  assert.ok(diff.components[0].changedDimensions.includes('startup'));assert.deepEqual(diff.components[0].after.startup,{autostart:false,initialStart:false,critical:true});
  assert.equal(diff.current.pack.packType,'atomic');assert.equal(diff.candidate.pack.packType,'mesh');assert.equal(Object.hasOwn(current.pack,'packType'),false);
  assert.equal(hash(bytes),beforeDigest);assert.equal(Object.hasOwn(candidate.pack,'lifecyclePolicy'),false);
  app.record('explicit-upgrade-startup-diff',{lifecycle:diff.lifecycle,component:diff.components[0].after.startup});
});
