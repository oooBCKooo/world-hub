import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { publishArtifact } from '../../../scripts/runtime/sources.mjs';
import { workspace, ROOT } from '../launcher/helpers.mjs';

async function setup(t) {
  const app=await workspace(t),server=await createLauncherServer({root:app.root}); app.cleanups.push(()=>server.close());
  const call=async(path,body,headers={})=>{
    const response=await fetch(server.url+path.slice(1),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+server.token,...(body===undefined?{}:{'content-type':'application/json','x-csrf-token':server.csrfToken}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  return {app,server,call};
}

test('single-Hub HTTP contract removes retired products and protects all operations',async t=>{
  const {call,server}=await setup(t);
  assert.equal((await call('/api/hubs')).body.hubs.length,1);
  for(const route of ['/api/instances','/api/templates/builtin','/api/creator-drafts','/advanced.mjs','/deployment-ui.mjs'])assert.equal((await call(route)).status,404,route);
  for(const route of ['/api/compositions/preview','/api/templates/instantiate','/api/programs/assembly','/api/authoring/derive','/api/backups/restore'])assert.equal((await call(route,{})).status,404,route);
  assert.equal((await call('/api/hubs/default/start',{}, {'x-csrf-token':'bad'})).status,403);
  assert.equal((await call('/api/groups',undefined,{authorization:'Bearer bad'})).status,401);
  assert.equal((await call('/api/groups',undefined,{origin:'https://unrelated.example'})).status,403);
  assert.equal((await call('/api/paths/check',{path:ROOT,purpose:'template'})).status,400);
  assert.equal((await call('/api/artifacts/import',{path:ROOT,kind:'pack'})).status,409);
  assert.equal(server.manager.hub,null);
});

test('HTTP import, direct configuration and reference groups stay offline and do not delete source',async t=>{
  const {call,server}=await setup(t),directory=join(ROOT,'examples/ecosystem-pack/modules/source');
  let result=await call('/api/artifacts/import',{path:directory,kind:'module'});assert.equal(result.status,200);
  result=await call('/api/programs/preview',{directory,programId:'source'});assert.equal(result.status,200);const reviewId=result.body.reviewId;
  assert.equal((await call('/api/programs/register',{reviewId,accepted:false})).body.error.code,'TRUST_REQUIRED');
  assert.equal((await call('/api/programs/register',{reviewId,accepted:true})).status,200);
  let program=(await call('/api/programs')).body.programs[0];assert.ok(program.configurationRevision);
  let preview=await call('/api/programs/source/configuration/preview',{expectedRevision:program.configurationRevision,settings:{text:'HTTP direct config'}});
  assert.equal(preview.status,200);assert.equal((await call('/api/programs/source/configuration/apply',{reviewId:preview.body.reviewId,accepted:true})).status,200);
  assert.equal(server.manager.hub,null,'editing a stopped module must not start the Hub');
  program=(await call('/api/programs')).body.programs[0];assert.notEqual(program.configurationRevision,preview.body.review?.beforeRevision);
  result=await call('/api/groups/save',{group:{id:'group-a',title:'Shared module group',memberProgramIds:['source']}});assert.equal(result.status,200);
  const group=result.body.group;
  assert.equal((await call('/api/groups/group-a/remove',{expectedRevision:'stale'})).body.error.code,'MODULE_GROUP_CHANGED');
  assert.equal((await call('/api/programs/source/remove',{})).body.error.code,'LOCAL_PROGRAM_IN_GROUP');
  assert.equal((await call('/api/groups/group-a/remove',{expectedRevision:group.revision})).status,200);
  assert.equal((await call('/api/programs')).body.programs.length,1);
  assert.equal((await call('/api/paths/forget',{path:directory,purpose:'module'})).body.deletesFiles,false);
  assert.ok((await lstat(join(directory,'module.json'))).isFile());
  assert.equal((await call('/api/paths/known')).body.objects.some(row=>row.path===directory),false);
  assert.equal((await call('/api/artifacts/import',{path:directory,kind:'module'})).status,200);
  assert.equal((await call('/api/paths/known')).body.objects.some(row=>row.path===directory),true);
  assert.equal((await call('/api/hubs')).body.hubs[0].state,'stopped');
});

test('module source receipts download into the library and cannot fetch retired resource kinds',async t=>{
  const {call,server,app}=await setup(t),output=join(app.directory,'published');
  const publication=await publishArtifact(join(ROOT,'examples/ecosystem-pack/modules/source'),{kind:'module',destination:output,redistributionAcknowledged:true});
  let result=await call('/api/sources/inspect',{source:publication.indexPath});assert.equal(result.status,200);
  const inspected=result.body,entry=inspected.index.entries[0];
  result=await call('/api/sources/fetch',{source:publication.indexPath,receiptId:inspected.receiptId,entryId:entry.entryId});assert.equal(result.status,202);
  await server.manager.operations.get(result.body.operationId).promise;
  const operation=server.manager.operation(result.body.operationId);assert.equal(operation.state,'succeeded',JSON.stringify(operation.error));assert.equal(operation.result.kind,'module');
  const library=JSON.parse(await readFile(join(app.root,'launcher-paths.json')));assert.equal(library.library.length,1);assert.equal(library.library[0].purpose,'module');
  assert.equal((await call('/api/sources/publish',{directory:ROOT,destination:join(app.directory,'retired'),kind:'template',redistributionAcknowledged:true})).body.error.code,'MODULE_REQUIRED');
  assert.equal(server.manager.hub,null);
});
