import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalPrograms } from '../../../tools/launcher/local-programs.mjs';
import { ModuleResources } from '../../../tools/launcher/resources.mjs';
import { inspectDeployment } from '../../../scripts/runtime/deployment.mjs';
import { workspace } from '../launcher/helpers.mjs';

const config = () => ({topics:{events:'resource/events'},bridges:{main:{publish:['events'],subscribe:[]}},settings:{limit:3},bindings:[]});
const metadata = () => ({id:'reliability.resource',version:'1.0.0',title:'Reliability fixture',license:'MIT',platforms:[`${process.platform}-${process.arch}`],provides:[],requires:[],scope:'local'});
const writeJson = (path,value) => writeFile(path,JSON.stringify(value,null,2)+'\n');
async function setup(t) {
  const app=await workspace(t),grants=[];
  const local=new LocalPrograms({root:app.root,environment:{nodePath:process.execPath},inspectDeployment,
    updateCredentials:async change=>{grants.push(structuredClone(change));return {confirmed:true};},
    getHub:async()=>{throw new Error('Resource reliability checks must not start a Hub');}});
  await local.initialize();const resources=new ModuleResources({root:app.root,localPrograms:local});await resources.initialize();
  const source=join(app.directory,'module');await mkdir(source);
  const manifest={format:'world-hub.module/v1',id:'reliability.module',version:'1.0.0',license:'MIT',platforms:metadata().platforms,
    runtime:{kind:'node',entry:'program.mjs'},bridges:['main'],provides:[],requires:[],permissions:{filesystem:'instance-state',network:['hub-loopback'],processes:'none'}};
  await writeJson(join(source,'module.json'),manifest);await writeFile(join(source,'program.mjs'),"throw new Error('Resource management must never execute this source');\n");
  const {body}=await resources.import({path:source},'module');
  const module={id:body.id,version:body.version,digest:body.digest};
  const register=async programId=>{const preview=await local.preview({programId,directory:source,...config()});await local.register({reviewId:preview.reviewId,accepted:true});return local.row(programId);};
  const profile=async (mapping={})=>{
    const path=join(app.directory,'configuration');await mkdir(path);
    const manifest={format:'world-hub.configuration/v1',...metadata(),modules:[{id:'first',module,configuration:config()}],
      startupPlan:{members:[{programId:'first',enabled:false,after:[]}],onFailure:'continue-independent',startupOrder:['first']}};
    await writeJson(join(path,'configuration.json'),manifest);const imported=await resources.import({path},'configuration');
    return {profile:imported.profile,preview:await resources.preview({profileId:imported.profile.profileId,mapping})};
  };
  return {app,local,resources,grants,module,register,profile};
}

test('resource reliability: data version identity covers payload bytes and conflicts preserve the previously imported dataset',async t=>{
  const {app,resources,module}=await setup(t),manifest={format:'world-hub.module-data/v1',...metadata(),purpose:'dataset',
    instances:[{id:'first',module,path:'data/first',dataFormat:{id:'reliability.business',version:'1.0.0'}}]};
  for(const [name,bytes]of [['original',Buffer.from([0,255,1])],['changed',Buffer.from([0,255,2])]]) {
    const path=join(app.directory,name);await mkdir(join(path,'data','first'),{recursive:true});await writeJson(join(path,'data.json'),manifest);await writeFile(join(path,'data','first','payload.bin'),bytes);
  }
  const original=await resources.import({path:join(app.directory,'original')},'data');
  await assert.rejects(resources.import({path:join(app.directory,'changed')},'data'),{code:'RESOURCE_VERSION_CONFLICT'});
  assert.equal(resources.state.data.length,1);assert.equal(resources.state.data[0].dataId,original.data.dataId);
  assert.deepEqual(await readFile(join(original.data.path,'data','first','payload.bin')),Buffer.from([0,255,1]));
});

test('resource reliability: applying identical configuration retains a running row object and its existing communication authorization',async t=>{
  const {local,resources,grants,register,profile}=await setup(t),row=await register('existing');
  // Runtime callbacks close over this row. Simulate a currently owned run to
  // check the exact mutation boundary without executing a business program.
  row.state='running';local.handles.set('existing',{exit:null});
  const {preview}=await profile({first:'existing'});assert.deepEqual(preview.review.changes,[]);assert.deepEqual(preview.review.requiresStop,[]);
  const result=await resources.apply({reviewId:preview.reviewId,accepted:true});
  assert.deepEqual(grants,[]);assert.deepEqual(result.stoppedProgramIds,[]);assert.equal(local.row('existing'),row);
  row.state='failed';assert.equal(local.row('existing').state,'failed','A later runtime callback must update the registered row');
  local.handles.delete('existing');
});

test('resource reliability: failed final configuration save preserves old registration, identity, startup plan and disk registry',async t=>{
  const {local,resources,register,profile}=await setup(t),old=await register('existing');
  const {preview}=await profile({first:'new-instance'});assert.equal(preview.review.adds[0].programId,'new-instance');
  const before={records:local.records,identities:local.identities,groups:local.groups,plan:structuredClone(local.getStartupPlan()),resources:structuredClone(resources.state),
    registry:await readFile(join(local.directory,'registry.json')),identity:await readFile(local.path('existing','identity.json'))};
  const originalSave=local.save;local.save=async()=>{throw Object.assign(new Error('Injected final registry save failure'),{code:'EIO'});};
  let issue;
  try {await resources.apply({reviewId:preview.reviewId,accepted:true});}catch(error){issue=error;}finally{local.save=originalSave;}
  assert.equal(issue?.code,'EIO');assert.ok(issue.incompleteDestinations.includes(local.path('new-instance')));
  assert.equal(local.records,before.records);assert.equal(local.row('existing'),old);assert.equal(local.records.has('new-instance'),false);
  assert.equal(local.identities,before.identities);assert.equal(local.groups,before.groups);assert.deepEqual(local.getStartupPlan(),before.plan);assert.deepEqual(resources.state,before.resources);
  assert.deepEqual(await readFile(join(local.directory,'registry.json')),before.registry);assert.deepEqual(await readFile(local.path('existing','identity.json')),before.identity);
});

test('resource reliability: changed installed source bytes block data restore planning before business data can be replaced',async t=>{
  const {app,local,resources,module,register}=await setup(t);await register('existing');
  const state=local.path('existing','state');await mkdir(state);await writeFile(join(state,'keep.bin'),'keep original data');
  const path=join(app.directory,'dataset');await mkdir(join(path,'data','first'),{recursive:true});
  const manifest={format:'world-hub.module-data/v1',...metadata(),purpose:'dataset',
    instances:[{id:'first',module,path:'data/first',dataFormat:{id:'reliability.business',version:'1.0.0'}}]};
  await writeJson(join(path,'data.json'),manifest);await writeFile(join(path,'data','first','replacement.bin'),'replacement data');
  const {data}=await resources.import({path},'data');await writeFile(local.path('existing','module','program.mjs'),'// bytes changed outside a reviewed source update\n');
  let issue,preview;try {preview=await resources.previewData({dataId:data.dataId,mapping:{first:'existing'}});}catch(error){issue=error;}
  if(issue)assert.match(issue.code,/MODULE_BODY_CHANGED|LOCAL_INSTALLED_CODE_CHANGED|DATA_MODULE_CONFLICT/);
  else {assert.equal(preview.review.blocked,true,'A cached registry file inventory cannot authorize data replacement after installed source changes');assert.ok(preview.review.conflicts.some(row=>row.code==='DATA_MODULE_CONFLICT'));}
  assert.deepEqual(await readFile(join(state,'keep.bin')),Buffer.from('keep original data'));
});

test('resource reliability: constructor is an ordinary logical instance ID and an omitted data target never inherits a prototype value',async t=>{
  const {app,resources,module}=await setup(t),path=join(app.directory,'constructor-config');await mkdir(path);
  const manifest={format:'world-hub.configuration/v1',...metadata(),modules:[{id:'constructor',module,configuration:config()}],startupPlan:{members:[{programId:'constructor',enabled:false,after:[]}],onFailure:'continue-independent',startupOrder:['constructor']}};
  await writeJson(join(path,'configuration.json'),manifest);
  const imported=await resources.import({path},'configuration'),preview=await resources.preview({profileId:imported.profile.profileId});
  assert.equal(preview.review.blocked,false);assert.equal(typeof preview.review.mapping.constructor,'string');
  await assert.rejects(resources.previewCleanup({keepProgramIds:'constructor'}),{code:'RESOURCE_SELECTION_INVALID'});
});
