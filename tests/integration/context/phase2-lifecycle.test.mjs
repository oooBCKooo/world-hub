import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startPhase2 } from '../../../examples/distributed-context/run-phase2.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';
const launcher = fileURLToPath(new URL('../../../examples/distributed-context/run-phase2.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(fn, label, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`timeout: ${label}`);
}

test('one provider IPC disconnect closes its state owner while other peers remain available', async t => {
  const run = await startPhase2({ fixture: true });
  t.after(() => run.close());
  const source = run.contexts[0]; source.child.disconnect();
  await until(() => source.exited !== null, 'source graceful IPC exit');
  assert.equal(source.exited.code, 0);
  const ui = await fetch(`${run.ui.ready.url}/api/state`).then(response => response.json());
  assert.equal(ui.diagnostics.connected, true);
  assert.ok(alive(run.harness.ready.dshPid));
  await run.close();
  assert.ok(run.children.every(record => record.exited?.code === 0));
});

test('hard exit of owning launcher closes all seven owned processes including the context plugin runtime', async t => {
  const owner = await startOwnedProgram(launcher, { args: ['--fixture'] });
  t.after(() => owner.stop());
  assert.equal(owner.ready.pids.length, 7);
  owner.child.kill('SIGKILL');
  await until(() => owner.exited !== null && owner.ready.pids.every(pid => !alive(pid)), 'all owned PIDs stop after launcher death');
});

test('hard exit of harness during a model call closes its DSH via EOF without killing other programs', async t => {
  const run = await startPhase2({ fixture: true, fixtureOptions: { responseDelayMs: 15000 } });
  t.after(() => run.close());
  const response = await fetch(`${run.ui.ready.url}/api/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'lifecycle fixture: pending model response' }) });
  assert.equal(response.status, 202);
  await until(() => existsSync(run.modelFixture.capturePath), 'real DSH model request started');
  const dshPid = run.harness.ready.dshPid;
  run.harness.child.kill('SIGKILL');
  await until(() => !alive(dshPid), 'DSH bounded exit after client EOF');
  assert.ok(run.contexts.every(record => alive(record.child.pid)));
  const ui = await fetch(`${run.ui.ready.url}/api/state`).then(response => response.json());
  assert.equal(ui.diagnostics.connected, true);
  assert.ok(ui.requests.every(request => request.status !== 'completed'));
});
