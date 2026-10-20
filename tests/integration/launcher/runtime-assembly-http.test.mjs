import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { inspectAuthoring } from '../../../scripts/runtime/authoring.mjs';
import { inspectPackage, createLock } from '../../../scripts/runtime/package.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { workspace, fixturePackage, environment, until, filesBelow } from './helpers.mjs';

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

test('Launcher live composition adds and starts real programs, admits external bridges, exports source only and saves the same instance version', { timeout: 120000 }, async t => {
  const app = await workspace(t), source = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  const initialPack = JSON.parse(await readFile(join(source,'pack.json'),'utf8'));
  initialPack.components[0].topicAliases = { input:'input', output:'output' };
  await writeFile(join(source,'pack.json'),JSON.stringify(initialPack));await createLock(source,environment);
  app.cleanups.push(() => server.close()); const call = api(server), manager = server.manager;
  const reviewed = await call('/api/review', { directory: source });
  await call('/api/instances', { reviewId: reviewed.reviewId, instanceId: 'live-composition' });
  const startReview = await call('/api/instances/live-composition/review', {});
  await operation(call, await call('/api/instances/live-composition/start', { reviewId: startReview.reviewId, accepted: true }, 202));
  app.trackSession(manager.sessions.get('live-composition'));
  const base = '/api/instances/live-composition/assembly', initial = await call(base), hubPid = (await manager.instance('live-composition')).status.hub.pid;
  assert.equal(initial.assembly.programs.length, 1); assert.equal(initial.assembly.programs[0].state, 'running');
  assert.equal(JSON.stringify(initial).includes('runtime-control'), false); assert.equal(initial.assembly.includesCredentials, false);
  const topics = { input: 'acceptance/input', output: 'acceptance/output' }, bridges = { main: { publish: ['input','output'], subscribe: ['input','output'] } };
  await action(call, base, { action: 'set-policy', policy: 'independent' });
  await action(call, base, { action: 'add', componentId: 'second', directory: join(source, 'modules/fixture'), settings: { mode: 'normal' }, topics, bridges });
  let current = await call(base); assert.equal(current.assembly.programs.find(row => row.componentId === 'second').state, 'stopped');
  await action(call, base, { action: 'start', componentId: 'second' });
  app.trackSession(manager.sessions.get('live-composition'));
  current = await call(base); assert.equal(current.assembly.programs.find(row => row.componentId === 'second').state, 'running');
  assert.deepEqual(current.assembly.programs.find(row => row.componentId === 'second').topics, topics);
  const addedStatus = (await manager.instance('live-composition')).status;
  assert.equal(addedStatus.hub.pid, hubPid); assert.equal(addedStatus.runId, initial.runId);
  const admitted = await action(call, base, { action: 'admit-external', componentId: 'independent-sensor', title: 'Independent sensor', topics: { events: 'external/events' },
    bridges: { main: { publish: ['events'], subscribe: ['events'] } }, provides: [], requires: [], bindings: [] });
  assert.equal(admitted.connection.componentId, 'independent-sensor');
  const config = admitted.connection.bridges[0], bridge = new Bridge({ url: config.endpoint, bridgeId: config.bridgeId, credential: config.credential, token: config.token });
  assert.equal(JSON.stringify(await call('/api/operations')).includes(config.token),false);
  bridge.on('error', () => {}); app.cleanups.push(() => bridge.close('test cleanup'));
  await bridge.connect(); await bridge.registerChannels([{ name: 'external/events', publish: true, subscribe: true }]);
  const observed = await until(async () => { const value = await call(base); return value.assembly.external.find(row => row.componentId === 'independent-sensor' && row.communication === 'connected') && value; });
  assert.equal(observed.assembly.external[0].state, 'unknown');
  assert.equal(JSON.stringify(observed).includes(config.token), false);
  await action(call,base,{action:'stop',componentId:'second'});
  const configured=(await call(base)).assembly.programs.find(row=>row.componentId==='second');
  await action(call,base,{action:'configure',componentId:'second',settings:{mode:'normal',label:'Edited while an external peer stays connected'},
    topics:configured.topics,bridges:configured.bridges,bindings:configured.bindings});
  await action(call,base,{action:'start',componentId:'second'});app.trackSession(manager.sessions.get('live-composition'));
  const afterConfigure=await call(base);
  assert.equal(afterConfigure.assembly.programs.find(row=>row.componentId==='second').state,'running');
  assert.equal(afterConfigure.assembly.programs.find(row=>row.componentId==='second').settings.label,'Edited while an external peer stays connected');
  assert.equal(afterConfigure.assembly.external.find(row=>row.componentId==='independent-sensor').communication,'connected');assert.equal(bridge.connected,true);
  assert.equal((await manager.instance('live-composition')).status.hub.pid,hubPid);
  const snapshot = await call(base + '/snapshot', { expectedRevision: afterConfigure.assembly.revision });
  assert.equal(snapshot.pack.components.length, 2); assert.equal(snapshot.pack.components.some(row => row.id === 'independent-sensor'), false);
  const files = await filesBelow(snapshot.directory); assert.equal(files.some(file => /identity|control|runtime-observed|assembly\.json/.test(file)), false);
  const exported = await inspectPackage(snapshot.directory, environment); assert.equal(exported.pack.components.length, 2);
  assert.equal(JSON.stringify(await readFile(join(snapshot.directory, 'pack.json'), 'utf8')).includes(config.token), false);
  await action(call, base, { action: 'revoke-external', componentId: 'independent-sensor' }); await bridge.close('revoked');
  await action(call, base, { action: 'stop', componentId: 'second' });
  assert.equal((await manager.instance('live-composition')).status.hub.pid, hubPid);
  const finalSnapshot = await call(base + '/snapshot', {}), authoring = await inspectAuthoring(finalSnapshot.directory, environment);
  await operation(call, await call('/api/instances/live-composition/stop', {}, 202));
  const pack = { ...finalSnapshot.pack, version: '1.0.1' };
  const save = await call(base + '/save-preview', { directory: finalSnapshot.directory, pack, expectedRevision: authoring.revision,
    origin: finalSnapshot.origin, redistributionAcknowledged: true, ...environment });
  const saved = await operation(call, await call(base + '/save-apply', { previewId: save.previewId, accepted: true }, 202));
  assert.equal(saved.pack.version, '1.0.1'); assert.equal(saved.instance.instanceId, 'live-composition');
  const restart = await call('/api/instances/live-composition/review', {});
  await operation(call, await call('/api/instances/live-composition/start', { reviewId: restart.reviewId, accepted: true }, 202));
  app.trackSession(manager.sessions.get('live-composition'));
  assert.equal((await call(base)).assembly.programs.length, 2);
  app.record('http-live-composition-and-in-place-save', { hubNotRestartedDuringChanges: true, managedPrograms: 2, externalBridgeConnected: true,
    externalCredentialsExcluded: true, sourceSnapshotValidated: true, version: saved.pack.version });
});

test('Launcher composition reviews reject changed source, stale revisions, cross-instance reuse and ended runs', { timeout: 90000 }, async t => {
  const app = await workspace(t), source = await fixturePackage(app), candidate = join(app.directory, 'candidate');
  await cp(join(source, 'modules/fixture'), candidate, { recursive: true });
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment }); app.cleanups.push(() => server.close());
  const call = api(server), reviewed = await call('/api/review', { directory: source }); await call('/api/instances', { reviewId: reviewed.reviewId, instanceId: 'guarded' });
  const start = await call('/api/instances/guarded/review', {});
  await operation(call, await call('/api/instances/guarded/start', { reviewId: start.reviewId, accepted: true }, 202)); app.trackSession(server.manager.sessions.get('guarded'));
  const base = '/api/instances/guarded/assembly', initial = (await call(base)).assembly;
  const input = { action: 'add', componentId: 'reviewed', directory: candidate, settings: { mode: 'normal' }, topics: { input: 'acceptance/input', output: 'acceptance/output' },
    bridges: { main: { publish: ['input','output'], subscribe: ['input','output'] } }, expectedRevision: initial.revision };
  const preview = await call(base + '/preview', input);
  await writeFile(join(candidate, 'program.mjs'), (await readFile(join(candidate, 'program.mjs'), 'utf8')) + '\n// unreviewed source\n');
  const changed = await call(base + '/apply', { reviewId: preview.reviewId, accepted: true }, 202);
  const failure = await until(async () => { const row = (await call('/api/operations/' + changed.operationId)).operation; return row.state !== 'running' && row; });
  assert.equal(failure.state, 'failed'); assert.ok(['ASSEMBLY_REVIEW_CHANGED','ASSEMBLY_MODULE_COLLISION'].includes(failure.error.code), JSON.stringify(failure));
  const policy = await call(base + '/preview', { action: 'set-policy', policy: 'independent', expectedRevision: initial.revision });
  const wrong = await call('/api/instances/not-this-instance/assembly/apply', { reviewId: policy.reviewId, accepted: true }, 409);
  assert.equal(wrong.error.code, 'RUNTIME_ASSEMBLY_REVIEW_REQUIRED');
  await operation(call, await call(base + '/apply', { reviewId: policy.reviewId, accepted: true }, 202));
  const stale = await call(base + '/preview', { action: 'stop', componentId: 'fixture', expectedRevision: initial.revision }, 409);
  assert.equal(stale.error.code, 'RUNTIME_ASSEMBLY_CHANGED');
  const now = await call(base), terminal = await call(base + '/preview', { action: 'stop', componentId: 'fixture', expectedRevision: now.assembly.revision });
  await operation(call, await call('/api/instances/guarded/stop', {}, 202));
  const ended = await call(base + '/apply', { reviewId: terminal.reviewId, accepted: true }, 202);
  const endedOp = await until(async () => { const row = (await call('/api/operations/' + ended.operationId)).operation; return row.state !== 'running' && row; });
  assert.equal(endedOp.state, 'failed'); assert.equal(endedOp.error.code, 'RUNTIME_ASSEMBLY_NOT_RUNNING');
  app.record('review-boundaries', { changedCodeRejected: true, staleRevisionRejected: true, crossInstanceRejected: true, stoppedRunRejected: true });
});

test('editing public settings preserves a valid implicit author topic map instead of converting duplicate runtime aliases', { timeout: 45000 }, async t => {
  const app=await workspace(t),source=await fixturePackage(app);
  await writeFile(join(source,'modules/fixture/deployment.json'),JSON.stringify({format:'world-hub.deployment/v1',title:{en:'Fixture'},description:{en:'Independent alias fixture'},
    topics:{message:'author/input',result:'author/output'},bridges:{main:{publish:['message','result'],subscribe:['message','result']}},settings:[]}));
  await createLock(source,environment);
  const server=await createLauncherServer({root:app.root,port:0,...environment});app.cleanups.push(()=>server.close());const call=api(server);
  const review=await call('/api/review',{directory:source});await call('/api/instances',{reviewId:review.reviewId,instanceId:'implicit-alias'});
  const start=await call('/api/instances/implicit-alias/review',{});
  await operation(call,await call('/api/instances/implicit-alias/start',{reviewId:start.reviewId,accepted:true},202));app.trackSession(server.manager.sessions.get('implicit-alias'));
  const base='/api/instances/implicit-alias/assembly';await action(call,base,{action:'stop',componentId:'fixture'});
  const before=(await call(base)).assembly,row=before.programs[0];assert.equal(row.topics.message,row.topics.input);
  await action(call,base,{action:'configure',componentId:'fixture',settings:{mode:'normal',label:'Changed public label'},topics:row.topics,bridges:row.bridges,bindings:row.bindings});
  const after=(await call(base)).assembly;assert.equal(Object.hasOwn(after.pack.components[0],'topicAliases'),false);assert.deepEqual(after.programs[0].topics,row.topics);
  assert.equal(after.programs[0].settings.label,'Changed public label');
  app.record('implicit-author-topic-map-preserved',{aliases:Object.keys(row.topics),unchangedCommunication:true});
});
