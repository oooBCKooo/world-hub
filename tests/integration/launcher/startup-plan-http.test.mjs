import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';
import { ownProcess } from '../../../scripts/runtime/process.mjs';
import { workspace, fixturePackage, environment, until } from './helpers.mjs';

function api(server) { return async (path, body, expected = 200) => {
  const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(90000),
    headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}; }
async function operation(call, started) {
  const row = await until(async () => { const value = (await call('/api/operations/' + started.operationId)).operation; return value.state !== 'running' && value; }, { timeoutMs: 65000 });
  assert.equal(row.state, 'succeeded', JSON.stringify(row)); return row;
}
async function register(call, directory, programId, mode = 'normal', nodePath) {
  const preview = await call('/api/programs/preview', { programId, directory: join(directory, 'modules/fixture'), settings: { mode },
    ...(nodePath ? { nodePath } : {}),
    topics: { input: 'acceptance/input', output: 'acceptance/output' }, bridges: { main: { publish: ['input','output'], subscribe: ['input','output'] } } });
  await call('/api/programs/register', { reviewId: preview.reviewId, accepted: true });
}
async function savePlan(call, members, onFailure = 'continue-independent') {
  const before = (await call('/api/programs/startup-plan')).plan;
  return (await call('/api/programs/startup-plan/save', { plan: { members, onFailure }, expectedRevision: before.revision })).plan;
}
const member = (programId, enabled = true, after = []) => ({ programId, enabled, after });
async function startPlan(call) {
  const review = await call('/api/programs/startup-plan/review', {});
  const started = await call('/api/programs/startup-plan/start', { reviewId: review.reviewId, accepted: true }, 202);
  return { review, started };
}
function trackOwned(app, server) {
  const retained = new Set();
  app.cleanups.push(async () => {
    if (server.manager.hub) retained.add(server.manager.hub);
    for (const handle of server.manager.localPrograms.handles.values()) retained.add(handle);
    await server.close();
    for (const handle of retained) {
      assert.ok(handle.exit && !handle.cleanupIncomplete, 'Owned process exit must be confirmed');
      assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null);
    }
  }); return retained;
}

test('Global startup plan persists explicit selection and order, rejects invalid graphs and stale saves, and never executes on save', { timeout: 45000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  trackOwned(app, server); const call = api(server);
  await register(call, directory, 'first'); await register(call, directory, 'second');
  const initial = (await call('/api/programs/startup-plan')).plan;
  assert.ok(initial.members.every(row => !row.enabled));
  for (const members of [[member('missing')], [member('first'),member('first')], [member('first',true,['second']),member('second',true,['first'])], [member('first',true,['first'])]])
    assert.equal((await call('/api/programs/startup-plan/save', { plan: { members, onFailure: 'stop-plan' }, expectedRevision: initial.revision }, 409)).error.code, 'LOCAL_STARTUP_PLAN_INVALID');
  const saved = await savePlan(call, [member('second',true,['first']),member('first')], 'stop-plan');
  assert.equal((await call('/api/programs/startup-plan/save', { plan: initial, expectedRevision: initial.revision }, 409)).error.code, 'LOCAL_STARTUP_PLAN_CHANGED');
  await register(call, directory, 'later');
  const plan = (await call('/api/programs/startup-plan')).plan;
  assert.equal(plan.members.find(row => row.programId === 'later').enabled, false);
  assert.equal(server.manager.hub, null); assert.ok((await call('/api/programs')).programs.every(row => row.state === 'stopped'));
  await server.close();
  const reloaded = new LauncherManager({ root: app.root, ...environment }); await reloaded.initialize(); app.cleanups.push(() => reloaded.close());
  assert.deepEqual(reloaded.localPrograms.getStartupPlan(), plan); assert.equal(reloaded.hub, null);
  assert.deepEqual(saved.members.find(row => row.programId === 'second').after, ['first']);
  app.record('persisted-explicit-startup-plan', { members: plan.members, noExecution: true });
});

test('Global plan launches only selected members after readiness and skips existing owned-ready processes without restart', { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  trackOwned(app, server); const call = api(server);
  for (const id of ['last','first','manual']) await register(call, directory, id);
  await savePlan(call, [member('last',true,['first']),member('first'),member('manual',false)]);
  const started = await startPlan(call), complete = await operation(call, started.started);
  assert.deepEqual(complete.result.order, ['first','last']); assert.deepEqual(complete.result.results.map(row => [row.programId,row.state]), [['first','started'],['last','started']]);
  assert.equal(server.manager.localPrograms.row('manual').state, 'stopped'); assert.equal(server.manager.localPrograms.handles.has('manual'), false);
  const first = server.manager.localPrograms.handles.get('first'), last = server.manager.localPrograms.handles.get('last');
  assert.ok(Date.parse(server.manager.localPrograms.row('first').startedAt) <= Date.parse(server.manager.localPrograms.row('last').startedAt));
  const repeated = await startPlan(call), skipped = await operation(call, repeated.started);
  assert.ok(skipped.result.results.every(row => row.state === 'already-running')); assert.equal(server.manager.localPrograms.handles.get('first'), first); assert.equal(server.manager.localPrograms.handles.get('last'), last);
  const review = await call('/api/programs/manual/review', {}); await operation(call, await call('/api/programs/manual/start', { reviewId: review.reviewId, accepted: true }, 202));
  assert.equal(server.manager.localPrograms.row('manual').state, 'running');
  app.record('selected-readiness-order-and-late-manual', { order: complete.result.order, repeated: skipped.result.results, manualStartedLater: true });
});

test('unselected unmet prerequisites remain manual and block only their dependent startup branch', { timeout: 60000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  trackOwned(app, server); const call = api(server);
  for (const id of ['manual','dependent','unrelated']) await register(call, directory, id);
  await savePlan(call, [member('manual',false),member('dependent',true,['manual']),member('unrelated')]);
  const result = (await operation(call, (await startPlan(call)).started)).result;
  assert.deepEqual(result.results, [{ programId: 'dependent', state: 'blocked', blockedBy: ['manual'] },{ programId: 'unrelated', state: 'started' }]);
  assert.equal(server.manager.localPrograms.handles.has('manual'), false); assert.equal(server.manager.localPrograms.handles.has('dependent'), false);
  app.record('no-implicit-prerequisite-start', { results: result.results });
});

test('failure policy controls pending plan members while preserving earlier successes and preexisting processes', { timeout: 90000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  trackOwned(app, server); const call = api(server);
  for (const id of ['first','failure','dependent','unrelated']) await register(call, directory, id, id === 'failure' ? 'early-exit' : 'normal');
  await savePlan(call, [member('first'),member('failure'),member('dependent',true,['failure']),member('unrelated')]);
  const continued = (await operation(call, (await startPlan(call)).started)).result;
  assert.deepEqual(continued.results.map(row => row.state), ['started','failed','blocked','started']);
  const first = server.manager.localPrograms.handles.get('first');
  await operation(call, await call('/api/programs/unrelated/stop', {}, 202));
  await savePlan(call, [member('first'),member('failure'),member('dependent',true,['failure']),member('unrelated')], 'stop-plan');
  const halted = (await operation(call, (await startPlan(call)).started)).result;
  assert.deepEqual(halted.results.map(row => row.state), ['already-running','failed','not-started','not-started']); assert.equal(halted.halted, true);
  assert.equal(first.exit, null); assert.equal(server.manager.localPrograms.row('unrelated').state, 'stopped');
  app.record('independent-and-stop-remaining-policy', { continued: continued.results, halted: halted.results, earlierSuccessRetained: true });
});

test('cancelling a startup plan retires the pending owned start and leaves completed members running', { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  const owned = trackOwned(app, server), call = api(server);
  for (const id of ['first','waiting','last']) await register(call, directory, id, id === 'waiting' ? 'no-ready' : 'normal');
  await savePlan(call, [member('first'),member('waiting'),member('last')]); const { started } = await startPlan(call);
  await until(() => server.manager.localPrograms.handles.get('waiting')); const pending = server.manager.localPrograms.handles.get('waiting'); owned.add(pending);
  const observedBeforeCancel = server.manager.localPrograms.row('first').communicationObservedAt;
  await call('/api/operations/' + started.operationId + '/cancel', {});
  const result = (await operation(call, started)).result;
  assert.equal(result.cancelled, true); assert.deepEqual(result.results.map(row => row.state), ['started','cancelled','cancelled']);
  assert.ok(pending.exit && !pending.cleanupIncomplete); assert.equal(server.manager.localPrograms.handles.get('first').exit, null); assert.equal(server.manager.localPrograms.handles.has('last'), false);
  await until(() => server.manager.localPrograms.row('first').communicationObservedAt !== observedBeforeCancel, { timeoutMs: 5000 });
  assert.equal(server.manager.localPrograms.row('first').state, 'running', 'Cancelling the plan must preserve completed members and their ongoing health observations');
  app.record('cancel-plan-with-owned-cleanup', { results: result.results, firstPreserved: true, pendingExitConfirmed: true });
});

test('changed reviewed source or plan fails closed before execution and a Global workbench roundtrip retains selection and order', { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  trackOwned(app, server); const call = api(server);
  await register(call, directory, 'first'); await register(call, directory, 'second');
  await savePlan(call, [member('first'),member('second',false,['first'])]);
  const snapshot = await call('/api/programs/assembly', {});
  assert.equal(snapshot.pack.components.find(row => row.id === 'second').autostart, false); assert.deepEqual(snapshot.pack.components.find(row => row.id === 'second').after, ['first']);
  const pack = structuredClone(snapshot.pack); pack.version = '0.1.1'; pack.components.find(row => row.id === 'second').autostart = true;
  const update = await call('/api/programs/assembly/preview', { directory: snapshot.directory, pack, expectedRevision: snapshot.composition.revision });
  await call('/api/programs/assembly/apply', { reviewId: update.reviewId, accepted: true });
  assert.equal((await call('/api/programs/startup-plan')).plan.members.find(row => row.programId === 'second').enabled, true);
  const sourceReview = await call('/api/programs/startup-plan/review', {}), sourceFile = server.manager.localPrograms.path('first','module/program.mjs'), original = await readFile(sourceFile);
  await writeFile(sourceFile, Buffer.concat([original,Buffer.from('\n// changed after review\n')]));
  const started = await call('/api/programs/startup-plan/start', { reviewId: sourceReview.reviewId, accepted: true }, 202);
  const rejected = await until(async () => { const row = (await call('/api/operations/' + started.operationId)).operation; return row.state !== 'running' && row; });
  assert.equal(rejected.state, 'failed'); assert.equal(server.manager.hub, null); await writeFile(sourceFile, original);
  const planReview = await call('/api/programs/startup-plan/review', {}); await savePlan(call, [member('first',false),member('second',false)]);
  const changed = await call('/api/programs/startup-plan/start', { reviewId: planReview.reviewId, accepted: true }, 202);
  const mismatch = await until(async () => { const row = (await call('/api/operations/' + changed.operationId)).operation; return row.state !== 'running' && row; });
  assert.equal(mismatch.state, 'failed'); assert.equal(mismatch.error.code, 'LOCAL_STARTUP_PLAN_CHANGED'); assert.equal(server.manager.hub, null);
  app.record('global-workbench-plan-and-failclosed-review', { snapshotSelection: snapshot.startupPlan.members, planApplied: true, sourceChangedRejected: true, planChangedRejected: true });
});

test('source drift between plan members halts remaining launches even with continue-independent policy', { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  trackOwned(app, server); const call = api(server);
  for (const id of ['first','changed','last']) await register(call, directory, id);
  await savePlan(call, [member('first'),member('changed'),member('last')]);
  const review = await call('/api/programs/startup-plan/review', {}), file = server.manager.localPrograms.path('changed','module/program.mjs'), original = await readFile(file);
  let changed = false;
  const result = await server.manager.localPrograms.startStartupPlan({ reviewId: review.reviewId, accepted: true, progress: progress => {
    if (!changed && progress.results.some(row => row.programId === 'first' && row.state === 'started')) { changed = true; writeFileSync(file, Buffer.concat([original,Buffer.from('\n// edited during plan\n')])); }
  } });
  assert.equal(changed, true); assert.deepEqual(result.results.map(row => row.state), ['started','failed','not-started']); assert.equal(result.halted, true);
  assert.equal(result.results[1].error.code, 'LOCAL_INSTALLED_CODE_CHANGED'); assert.equal(server.manager.localPrograms.handles.has('changed'), false); assert.equal(server.manager.localPrograms.handles.has('last'), false);
  assert.equal(server.manager.localPrograms.handles.get('first').exit, null);
  app.record('mid-plan-source-drift-failclosed', { results: result.results, priorOwnedSuccessRetained: true });
});

test('Global Hub Stop cancels an active plan and queued starts before closing every owned program', { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  const owned = trackOwned(app, server), call = api(server);
  for (const id of ['first','waiting','last']) await register(call, directory, id, id === 'waiting' ? 'no-ready' : 'normal');
  await savePlan(call, [member('first'),member('waiting'),member('last')]); const { started } = await startPlan(call);
  await until(() => server.manager.localPrograms.handles.get('waiting'));
  for (const handle of server.manager.localPrograms.handles.values()) owned.add(handle);
  const stop = server.manager.defaultHub('stop'); await server.manager.operations.get(stop.operationId).promise;
  assert.equal(server.manager.operations.get(stop.operationId).state, 'succeeded');
  const result = (await operation(call, started)).result;
  assert.equal(result.cancelled, true); assert.equal(server.manager.localPrograms.handles.has('last'), false);
  assert.ok([...server.manager.localPrograms.handles.values()].every(handle => handle.exit && !handle.cleanupIncomplete)); assert.ok(server.manager.hub.exit);
  app.record('hub-stop-closes-startup-admission', { results: result.results, allOwnedExitConfirmed: true });
});

test('instance start mode is bound to its execution review and hub-only leaves every Atomic member available for a later reviewed start', { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  app.cleanups.push(() => server.close()); const call = api(server);
  const imported = await call('/api/review', { directory }); await call('/api/instances', { reviewId: imported.reviewId, instanceId: 'only-hub' });
  const review = await call('/api/instances/only-hub/review', { startupMode: 'hub-only' });
  assert.equal(review.startupMode, 'hub-only'); assert.equal(review.review.startupMode, 'hub-only'); assert.deepEqual(review.review.initialOrder, []);
  await operation(call, await call('/api/instances/only-hub/start', { reviewId: review.reviewId, accepted: true }, 202));
  const session = server.manager.sessions.get('only-hub'); app.trackSession(session);
  const started = (await call('/api/instances/only-hub')).instance;
  assert.equal(started.status.startupMode, 'hub-only'); assert.equal(started.links.entryUrl, null); assert.ok(started.status.components.every(row => !row.pid));
  await call('/api/instances/only-hub/start', { reviewId: review.reviewId, accepted: true, startupMode: 'plan' }, 400);
  const base = '/api/instances/only-hub/assembly', snapshot = (await call(base)).assembly;
  assert.equal(snapshot.startupMode, 'hub-only'); assert.equal(snapshot.programs[0].autostart, true); assert.equal(snapshot.programs[0].initialAutostart, false);
  const start = await call(base + '/preview', { action: 'start', componentId: 'fixture', expectedRunId: snapshot.runId, expectedRevision: snapshot.revision });
  await operation(call, await call(base + '/apply', { reviewId: start.reviewId, accepted: true }, 202)); app.trackSession(session);
  assert.equal((await call(base)).assembly.programs[0].state, 'running');
  app.record('review-bound-hub-only-start', { startupMode: review.review.startupMode, lateAtomicMember: true });
});

for (const drift of ['source','runtime']) test(`Global startup rechecks ${drift} bytes after lazy Hub preparation and never spawns changed material`, { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  trackOwned(app, server); const call = api(server);
  let nodePath;
  if (drift === 'runtime') { nodePath = join(app.directory, process.platform === 'win32' ? 'reviewed-node.exe' : 'reviewed-node'); await copyFile(process.execPath,nodePath); }
  await register(call,directory,'first','normal',nodePath); await register(call,directory,'last');
  await savePlan(call,[member('first'),member('last')]);
  const update = server.manager.localPrograms.updateCredentials; let entered, release;
  const atGate = new Promise(done => { entered = done; }), gate = new Promise(done => { release = done; }); app.cleanups.push(() => release());
  server.manager.localPrograms.updateCredentials = async (...args) => { await update(...args); entered(); await gate; };
  const { started } = await startPlan(call); await atGate;
  assert.ok(server.manager.hub && !server.manager.hub.exit, 'The actual lazy Hub exists before the final pre-spawn check');
  const target = drift === 'source' ? server.manager.localPrograms.path('first','module/program.mjs') : nodePath;
  const before = await readFile(target); await writeFile(target,Buffer.concat([before,Buffer.from('\nchanged during startup preparation\n')])); release();
  const result = (await operation(call,started)).result;
  assert.equal(result.partial,true); assert.equal(result.halted,true); assert.deepEqual(result.results.map(row => row.state),['failed','not-started']);
  assert.equal(result.results[0].error.code,drift === 'source' ? 'LOCAL_REVIEW_CHANGED' : 'LOCAL_RUNTIME_CHANGED');
  assert.equal(server.manager.localPrograms.handles.has('first'),false); assert.equal(server.manager.localPrograms.handles.has('last'),false);
  app.record('last-moment-'+drift+'-revalidation',{ results:result.results, unreviewedChildSpawned:false, realLazyHub:true });
});

test('a hosted bootstrap error retains its actual owner privately and incomplete tree cleanup remains retryable after owner exit', { timeout: 65000 }, async t => {
  const app = await workspace(t), directory = await fixturePackage(app), server = await createLauncherServer({ root: app.root, port: 0, ...environment });
  const retained = trackOwned(app,server), call = api(server);
  await register(call,directory,'first'); await register(call,directory,'last'); await savePlan(call,[member('first'),member('last')]);
  const owner = ownProcess(process.execPath,['-e','process.stdin.once("data",()=>process.exit(0));console.log(JSON.stringify({event:"module-ready"}));setInterval(()=>{},1000)'],{cwd:app.directory,secrets:[]}); retained.add(owner);
  const stop = owner.stop; let attempts = 0;
  app.cleanups.push(async () => { owner.stop = stop; delete owner.cleanupIncomplete; await stop(1000); });
  await owner.waitFor(frame => frame.event === 'module-ready',10000);
  // The real child exits; this one-time retained-tree receipt models the
  // existing bootstrap failure seam without adding a product test hook.
  owner.stop = async timeout => { attempts++; if (attempts === 1) { await stop(timeout); owner.cleanupIncomplete = true; return owner.exit; } delete owner.cleanupIncomplete; return stop(timeout); };
  server.manager.localPrograms.prepareDependencies = async () => {
    const issue = Object.assign(new Error('Hosted bootstrap retirement needs retry.'),{code:'HOST_CLEANUP_INCOMPLETE',cleanupIncomplete:true});
    Object.defineProperty(issue,'ownedHandle',{value:owner,enumerable:false}); throw issue;
  };
  const { started } = await startPlan(call);
  const failed = await until(async () => { const operation = (await call('/api/operations/'+started.operationId)).operation; return operation.state !== 'running' && operation; });
  assert.equal(failed.state,'failed'); assert.equal(failed.error.cleanupIncomplete,true); assert.equal(failed.result.partial,true);
  assert.deepEqual(failed.result.results.map(row => row.state),['failed','not-started']); assert.equal(failed.result.results[0].error.cleanupIncomplete,true);
  assert.equal(server.manager.localPrograms.handles.get('first'),owner); assert.equal(server.manager.localPrograms.row('first').state,'unknown'); assert.ok(owner.exit && owner.cleanupIncomplete);
  assert.equal(JSON.stringify(failed).includes('ownedHandle'),false); assert.equal(server.manager.localPrograms.handles.has('last'),false);
  await operation(call,await call('/api/programs/first/stop',{},202));
  assert.equal(attempts,2); assert.equal(owner.cleanupIncomplete,undefined); assert.equal(server.manager.localPrograms.row('first').state,'stopped');
  app.record('retained-hosted-bootstrap-owner',{actualChild:true,ownerExitBeforeRetirement:true,initialOperationFailed:true,stopRetryConfirmed:true,privateHandleNotSerialized:true});
});
