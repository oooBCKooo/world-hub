import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setup, okay, refused, moduleSource, importModule, importGroup, groupSource } from '../helpers/module-versions-scene.mjs';

const policyPath = id => `/manage/api/programs/${id}/execution-policy`;
async function setPolicy(scene, id, policy) {
  const row = scene.owner.localPrograms.public(scene.owner.localPrograms.row(id));
  return okay(await scene.call(policyPath(id), { expectedRevision: row.executionPolicyRevision, policy }));
}
const demand = callers => ({ mode: 'on-demand', idleTimeoutMs: 1000, allowedCallers: callers });
async function waitFor(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 30)); }
  assert.fail(message);
}
const program = caller => `import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {Bridge} from './bridge-kit.mjs';
${caller ? "import {callManaged} from './lifecycle-client.mjs';" : ''}
const config=JSON.parse(await readFile(process.argv[3],'utf8')), c=config.bridges[0];
const bridge=new Bridge({url:c.endpoint,bridgeId:c.bridgeId,credential:c.credential,token:c.token,autoAck:true});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
bridge.on('error',error=>emit({event:'diagnostic',code:error.code}));
${caller ? '' : "bridge.on('delivery',async message=>{if(message.operation!=='request')return;const body=message.body;await new Promise(done=>setTimeout(done,body.delay??0));await bridge.respond(message,{ok:true,text:body.text,pid:process.pid});});"}
const input=createInterface({input:process.stdin});let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;await bridge.close();input.close();};
input.on('line',line=>{const value=JSON.parse(line);if(value.command==='health')emit({event:'module-health',id:value.id,ready:!stopped});if(value.command==='stop')void stop();
${caller ? "if(value.command==='invoke')void (async()=>{try{const result=await callManaged(bridge,config.lifecycle,value.programId,config.topics.events,value.body,{timeoutMs:value.timeoutMs??10000,activationTimeoutMs:30000});emit({event:'call-result',id:value.id,ok:true,body:result.response.body});}catch(error){emit({event:'call-result',id:value.id,ok:false,error:{code:error.code,message:error.message}});}})();" : ''}
});
input.on('close',()=>void stop());process.on('SIGTERM',()=>void stop());
await bridge.connect();await bridge.registerChannels([{name:config.topics.events,publish:true,subscribe:true}]);
${caller ? '' : "await bridge.subscribe([config.topics.events],{from:'now',operations:['request']});"}
emit({event:'module-ready'});
`;
async function sceneWithCallers(t, { outsider = false } = {}) {
  const scene = await setup(t);
  for (const [id, caller] of [['provider', false], ['caller', true], ...(outsider ? [['outsider', true]] : [])]) {
    const source = await moduleSource(scene, id, '1.0.0');
    await writeFile(join(source.directory, 'program.mjs'), program(caller));
    if (caller) await copyFile(resolve('sdk/javascript/lifecycle-client.mjs'), join(source.directory, 'lifecycle-client.mjs'));
    await importModule(scene, source, id);
  }
  await setPolicy(scene, 'provider', demand(['caller']));
  return scene;
}
function invoke(scene, callerId, id, body, timeoutMs, programId = 'provider') {
  const handle = scene.owner.localPrograms.handles.get(callerId);
  handle.send({ command: 'invoke', id, programId, body, timeoutMs });
  return waitFor(() => handle.stdout.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(event => event?.event === 'call-result' && event.id === id), `Caller ${callerId} should report ${id}: ${handle.stderr}`, 45000);
}

test('management execution: policy uses CAS and local authorization without starting programs or changing business permissions', async t => {
  const scene = await setup(t); for (const id of ['provider', 'caller']) await importModule(scene, await moduleSource(scene, id, '1.0.0'), id);
  const local = scene.owner.localPrograms, before = local.public(local.row('provider'));
  assert.equal(before.executionPolicy.mode, 'resident');
  const response = await fetch(scene.base + policyPath('provider'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-management-token': 'wrong' }, body: '{}' });
  assert.equal(response.status, 403);
  refused(await scene.call(policyPath('provider'), { expectedRevision: before.executionPolicyRevision, policy: demand(['missing']) }));
  const saved = await setPolicy(scene, 'provider', demand(['caller']));
  assert.equal(saved.startsModules, false); assert.equal(saved.stopsModules, false); assert.equal(local.handles.size, 0);
  assert.deepEqual(local.row('provider').topics, before.topics); assert.deepEqual(local.row('provider').bridges, before.bridges);
  refused(await scene.call(policyPath('provider'), { expectedRevision: before.executionPolicyRevision, policy: demand([]) }));
  const serialized = JSON.stringify(okay(await scene.call('/manage/api/execution/status')));
  assert.equal(serialized.includes(local.identities.get('provider').token), false);
  assert.equal(serialized.includes('leaseId'), false);
  await scene.reload(); assert.deepEqual(local.public(local.row('provider')).executionPolicy, demand(['caller']));
  assert.deepEqual(scene.owner.localPrograms.public(scene.owner.localPrograms.row('provider')).executionPolicy, demand(['caller']));
});

test('management execution: global and group plans skip on-demand modules while manual startup stays available', async t => {
  const scene = await setup(t), imported = await importGroup(scene, await groupSource(scene, '1.0.0', ['one', 'two']));
  const local = scene.owner.localPrograms, [resident, onDemand] = imported.group.memberProgramIds;
  await setPolicy(scene, onDemand, demand([resident]));
  const groupStarted = okay(await scene.call(`/manage/api/groups/${imported.group.id}/start`, {}));
  assert.equal(local.row(resident).state, 'running'); assert.equal(local.row(onDemand).state, 'stopped');
  assert.ok(groupStarted.skipped.some(row => row.programId === onDemand && row.reason === 'on-demand'));
  okay(await scene.call(`/manage/api/programs/${resident}/stop`, {}));
  const overview = okay(await scene.call('/manage/api/programs/startup-plan'));
  const plan = { ...overview.plan, members: [resident, onDemand].map(programId => ({ programId, enabled: true, after: [] })), startupOrder: [onDemand, resident] };
  okay(await scene.call('/manage/api/programs/startup-plan/save', { plan, expectedRevision: overview.plan.revision }));
  const started = okay(await scene.call('/manage/api/programs/startup-plan/start', {}), 202);
  assert.deepEqual(started.result.order, [resident]); assert.equal(local.row(onDemand).state, 'stopped');
  okay(await scene.call(`/manage/api/programs/${onDemand}/start`, {})); assert.equal(local.row(onDemand).state, 'running');
  await new Promise(done => setTimeout(done, 1300)); assert.equal(local.row(onDemand).state, 'running', 'manual startup is pinned');
});

test('management execution: two real caller requests wake a provider once, protect a long call, then retire only that owned idle process', async t => {
  const scene = await sceneWithCallers(t), local = scene.owner.localPrograms;
  okay(await scene.call('/manage/api/programs/caller/start', {}));
  const callerHandle = local.handles.get('caller');
  const first = invoke(scene, 'caller', 'one', { text: 'first', delay: 2200 });
  const second = invoke(scene, 'caller', 'two', { text: 'second', delay: 1800 });
  await waitFor(() => local.row('provider').state === 'running', 'provider should wake');
  const providerHandle = local.handles.get('provider'), runId = local.row('provider').runId;
  await new Promise(done => setTimeout(done, 1300)); assert.equal(providerHandle.exit, null, 'unfinished calls protect the process beyond its idle timeout');
  const results = await Promise.all([first, second]); for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(results.map(row => row.body.text), ['first', 'second']);
  assert.equal(results[0].body.pid, results[1].body.pid); assert.equal(local.row('provider').runId, runId);
  await waitFor(() => local.row('provider').state === 'stopped', 'provider should stop after completed leases become idle');
  assert.ok(providerHandle.exit); assert.equal(callerHandle.exit, null); assert.equal(local.row('caller').state, 'running');
  const third = await invoke(scene, 'caller', 'three', { text: 'wake again', delay: 0 }); assert.equal(third.ok, true, JSON.stringify(third));
  assert.notEqual(local.row('provider').runId, runId);
  await waitFor(() => {
    const business = scene.hub.log.tail(200).filter(row => row.kind === 'message' && row.topic !== scene.owner.demandLifecycle.topic);
    return business.length >= 6 && scene.hub.snapshot().storage.log.protectedCount === business.length;
  }, 'the lifecycle providers should release their own control records while preserving all business requests and responses');
});

test('management execution: unauthorized modules cannot wake a provider even though they know its address', async t => {
  const scene = await sceneWithCallers(t, { outsider: true }); okay(await scene.call('/manage/api/programs/outsider/start', {}));
  const result = await invoke(scene, 'outsider', 'refused', { text: 'not authorized' });
  assert.equal(result.ok, false); assert.equal(scene.owner.localPrograms.row('provider').state, 'stopped');
  assert.equal(scene.owner.localPrograms.handles.has('provider'), false);
});

test('management execution: a call timeout leaves an uncertain lease rather than killing unfinished work; manual stop clears that run', async t => {
  const scene = await sceneWithCallers(t), local = scene.owner.localPrograms;
  okay(await scene.call('/manage/api/programs/caller/start', {}));
  const result = await invoke(scene, 'caller', 'timeout', { text: 'late work', delay: 4000 }, 150);
  assert.equal(result.ok, false);
  await waitFor(async () => okay(await scene.call('/manage/api/execution/status')).programs.find(row => row.programId === 'provider')?.uncertainLeaseCount > 0, 'uncertain work must be visible');
  await new Promise(done => setTimeout(done, 1400)); assert.equal(local.row('provider').state, 'running');
  okay(await scene.call('/manage/api/programs/provider/stop', {}));
  const status = okay(await scene.call('/manage/api/execution/status')).programs.find(row => row.programId === 'provider');
  assert.equal(status?.uncertainLeaseCount ?? 0, 0); assert.equal(local.row('provider').state, 'stopped');
});

test('management execution: a manual start pins an automatically woken instance without creating a second process', async t => {
  const scene = await sceneWithCallers(t), local = scene.owner.localPrograms;
  await setPolicy(scene, 'provider', { ...demand(['caller']), idleTimeoutMs: 5000 });
  okay(await scene.call('/manage/api/programs/caller/start', {}));
  const result = await invoke(scene, 'caller', 'pin', { text: 'pin me' }); assert.equal(result.ok, true, JSON.stringify(result));
  const handle = local.handles.get('provider'); okay(await scene.call('/manage/api/programs/provider/start', {}));
  await setPolicy(scene, 'provider', demand(['caller']));
  await new Promise(done => setTimeout(done, 1400)); assert.equal(handle.exit, null); assert.equal(local.handles.get('provider'), handle);
  const status = okay(await scene.call('/manage/api/execution/status')).programs.find(row => row.programId === 'provider'); assert.equal(status.pinned, true);
});

test('management execution: slow activation of another target does not block renewal of a real ongoing call', async t => {
  const scene = await sceneWithCallers(t), local = scene.owner.localPrograms;
  const source = await moduleSource(scene, 'slow', '1.0.0');
  await writeFile(join(source.directory, 'program.mjs'), program(false).replace('await bridge.connect();', 'await new Promise(done=>setTimeout(done,1800));await bridge.connect();'));
  await importModule(scene, source, 'slow'); await setPolicy(scene, 'slow', demand(['caller']));
  // Shorten only this test supervisor's lease clock so it can exercise a
  // startup longer than a lease without adding 30 seconds to every run.
  scene.owner.demandLifecycle.leaseTtlMs = 700; scene.owner.demandLifecycle.renewAfterMs = 150;
  okay(await scene.call('/manage/api/programs/caller/start', {}));
  const first = invoke(scene, 'caller', 'ongoing', { text: 'ongoing', delay: 2600 });
  await waitFor(() => local.row('provider').state === 'running', 'first provider should wake');
  const second = invoke(scene, 'caller', 'slow-start', { text: 'slow ready' }, undefined, 'slow');
  const results = await Promise.all([first, second]); for (const row of results) assert.equal(row.ok, true, JSON.stringify(row));
  const status = okay(await scene.call('/manage/api/execution/status'));
  for (const id of ['provider', 'slow']) assert.equal(status.programs.find(row => row.programId === id).uncertainLeaseCount, 0, id);
  await waitFor(() => local.row('provider').state === 'stopped' && local.row('slow').state === 'stopped', 'normally completed calls should both retire after idle');
});
