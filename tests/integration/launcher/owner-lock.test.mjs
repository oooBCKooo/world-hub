import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLauncherOwner, cleanLauncherOwner, inspectLauncherOwner, probeLauncherPid } from '../../../tools/launcher/owner-lock.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { parseUiArgs } from '../../../tools/launcher/cli.mjs';
import { workspace, alive, until, save, json, ROOT } from './helpers.mjs';

const options = { timeout: 30000 };
const canRecover = ['win32', 'linux'].includes(process.platform);
const ownerModule = new URL('../../../tools/launcher/owner-lock.mjs', import.meta.url).href;
const serverModule = new URL('../../../tools/launcher/server.mjs', import.meta.url).href;

function child(t, code, args = []) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', exit;
  process.stdout.on('data', bytes => { stdout += bytes; }); process.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(yes => process.once('close', (code, signal) => { exit = { code, signal }; yes(exit); }));
  t.after(async () => { if (!exit) process.kill('SIGKILL'); await closed; assert.equal(alive(process.pid), false); });
  return { process, closed, line: () => stdout.split('\n').find(Boolean), stderr: () => stderr,
    async ready() { return JSON.parse(await until(() => { if (exit && !this.line()) throw new Error(stderr || 'child exited without result'); return this.line(); }, { label: 'child ownership result' })); },
    async kill() { process.kill('SIGKILL'); await closed; assert.equal(alive(process.pid), false); } };
}

async function deadPid(t) {
  const departed = child(t, 'process.exit(0)'); await departed.closed;
  assert.equal(probeLauncherPid(departed.process.pid), 'dead'); return departed.process.pid;
}

test('OWNER-01 read-only inspection creates nothing and every unsafe/unknown/live owner is retained', options, async t => {
  const app = await workspace(t), missing = join(app.directory, 'never-created');
  assert.equal((await inspectLauncherOwner(missing)).state, 'absent');
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  await mkdir(app.root); const path = join(app.root, 'launcher-owner.lock');
  for (const text of ['', '{', JSON.stringify({ pid: -1, nonce: 'bad' }), JSON.stringify({ pid: process.pid, nonce: 'possibly-reused' })]) {
    await writeFile(path, text);
    const before = await readdir(app.root), inspection = await inspectLauncherOwner(app.root);
    assert.equal(inspection.recoveryAllowed, false); assert.ok(['unknown', 'live-or-reused'].includes(inspection.state));
    await assert.rejects(acquireLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
    await assert.rejects(cleanLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
    assert.equal(await readFile(path, 'utf8'), text); assert.deepEqual(await readdir(app.root), before);
  }
  app.record('readonly-inspection-and-refusal', { currentPidUnsignalled: true, malformedLockPreserved: true, noRegistryCreation: true });
});

test('OWNER-02 EPERM and other probe failures remain unknown and only ESRCH permits recovery', () => {
  const checked = [];
  for (const code of ['EPERM', 'EACCES', 'EINVAL', undefined]) {
    const state = probeLauncherPid(321, (pid, signal) => { checked.push([pid, signal]); throw Object.assign(new Error('probe denied'), { code }); });
    assert.equal(state, 'unknown');
  }
  assert.equal(probeLauncherPid(321, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), 'dead');
  assert.deepEqual(checked, Array(4).fill([321, 0]));
});

test('OWNER-03 actual crashed Launcher follows platform recovery policy without signalling Runtime/foreign processes', options, async t => {
  const app = await workspace(t);
  const unrelated = child(t, `process.stdout.write(JSON.stringify({ ready: true }) + '\\n'); process.stdin.resume();`); await unrelated.ready();
  const old = child(t, `import { createLauncherServer } from ${JSON.stringify(serverModule)};
    const launcher = await createLauncherServer({ root: process.argv[1] });
    process.stdout.write(JSON.stringify({ ready: true, root: launcher.root }) + '\\n'); process.stdin.resume();`, [app.root]);
  await old.ready(); const oldOwner = await json(join(app.root, 'launcher-owner.lock'));
  const runtime = join(app.root, 'instances/orphan'); await mkdir(runtime, { recursive: true });
  await save(join(runtime, 'owner.lock'), { nonce: 'independent-runtime', pid: unrelated.process.pid });
  await save(join(runtime, 'control.json'), { runId: 'independent-runtime', token: 'private-test-token' });
  const before = await readFile(join(runtime, 'owner.lock')); const control = await readFile(join(runtime, 'control.json'));
  await old.kill(); assert.equal((await inspectLauncherOwner(app.root)).state, 'dead');
  if (!canRecover) {
    const rootOwner = await readFile(join(app.root, 'launcher-owner.lock'));
    assert.equal((await inspectLauncherOwner(app.root)).recoveryAllowed, false);
    await assert.rejects(createLauncherServer({ root: app.root }), { code: 'LAUNCHER_LOCKED' });
    await assert.rejects(cleanLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
    assert.deepEqual(await readFile(join(app.root, 'launcher-owner.lock')), rootOwner);
    assert.deepEqual(await readFile(join(runtime, 'owner.lock')), before); assert.deepEqual(await readFile(join(runtime, 'control.json')), control);
    assert.equal(alive(unrelated.process.pid), true);
    app.record('crash-metadata-preserved-on-conservative-platform', { platform: process.platform,
      killedLauncherPid: oldOwner.pid, unrelatedPid: unrelated.process.pid, preservedRuntimeOwnership: true,
      automaticRecoverySupported: false, rootOwnerUnchanged: true });
    return;
  }
  const recovered = await createLauncherServer({ root: app.root }); app.cleanups.push(() => recovered.close());
  assert.equal(recovered.ownerRecovery.owner.nonce, oldOwner.nonce);
  assert.equal(recovered.ownerRecovery.state, 'dead'); assert.equal(alive(unrelated.process.pid), true);
  assert.deepEqual(await readFile(join(runtime, 'owner.lock')), before); assert.deepEqual(await readFile(join(runtime, 'control.json')), control);
  const response = await fetch(recovered.url); assert.equal(response.status, 200); await response.body.cancel();
  await recovered.close(); assert.equal(alive(unrelated.process.pid), true);
  assert.equal((await inspectLauncherOwner(app.root)).state, 'absent');
  app.record('crash-recovery-preserves-independent-processes', { killedLauncherPid: oldOwner.pid, unrelatedPid: unrelated.process.pid,
    preservedRuntimeOwnership: true, actualUiResponds: true });
});

test('OWNER-04 concurrent contenders preserve stale-lock policy and admit exactly one new owner', options, async t => {
  const app = await workspace(t); await mkdir(app.root);
  await save(join(app.root, 'launcher-owner.lock'), { nonce: 'crashed-before-concurrent-restart', pid: await deadPid(t) });
  const code = `import { acquireLauncherOwner } from ${JSON.stringify(ownerModule)};
    try { const owner = await acquireLauncherOwner(process.argv[1]);
      process.stdout.write(JSON.stringify({ won: true, nonce: owner.nonce, pid: process.pid }) + '\\n');
      process.stdin.once('data', async () => { await owner.release(); process.exit(0); });
    } catch (error) { process.stdout.write(JSON.stringify({ won: false, code: error.code }) + '\\n'); }`;
  let raceRoot = app.root;
  if (!canRecover) {
    const staleOwner = await readFile(join(app.root, 'launcher-owner.lock'));
    const refused = [child(t, code, [app.root]), child(t, code, [app.root])];
    const failures = await Promise.all(refused.map(c => c.ready()));
    assert.deepEqual(failures, Array(2).fill({ won: false, code: 'LAUNCHER_LOCKED' }));
    await Promise.all(refused.map(c => c.closed));
    assert.deepEqual(await readFile(join(app.root, 'launcher-owner.lock')), staleOwner);
    assert.equal((await inspectLauncherOwner(app.root)).recoveryAllowed, false);
    app.record('concurrent-stale-recovery-refused-on-conservative-platform', { platform: process.platform,
      bothRefused: true, rootOwnerUnchanged: true });
    // No kernel recovery guard exists here, but atomic exclusive installation
    // must still admit exactly one new owner in a root without old metadata.
    raceRoot = join(app.root, 'fresh-concurrent');
  }
  const contenders = [child(t, code, [raceRoot]), child(t, code, [raceRoot])];
  const results = await Promise.all(contenders.map(c => c.ready()));
  assert.equal(results.filter(r => r.won).length, 1); assert.equal(results.find(r => !r.won).code, 'LAUNCHER_LOCKED');
  const winner = results.find(r => r.won); assert.equal((await json(join(raceRoot, 'launcher-owner.lock'))).nonce, winner.nonce);
  await assert.rejects(cleanLauncherOwner(raceRoot), { code: 'LAUNCHER_LOCKED' });
  assert.equal((await json(join(raceRoot, 'launcher-owner.lock'))).nonce, winner.nonce);
  const index = results.findIndex(r => r.won); contenders[index].process.stdin.write('close'); await contenders[index].closed;
  assert.equal((await inspectLauncherOwner(raceRoot)).state, 'absent');
  app.record(canRecover ? 'real-concurrent-recovery' : 'real-concurrent-new-ownership', {
    exactlyOneOwner: true, winnerPid: winner.pid, loserCouldNotDeleteOwner: true });
});

test('OWNER-05 legacy owner has no guard but its live PID and partially written metadata still prevent takeover', options, async t => {
  const app = await workspace(t); await mkdir(app.root); const path = join(app.root, 'launcher-owner.lock');
  for (const partial of [false, true]) {
    const old = child(t, `import { writeFile } from 'node:fs/promises';
      await writeFile(process.argv[1], ${partial ? "'{'" : "JSON.stringify({ pid: process.pid, nonce: 'legacy-live' })"});
      process.stdout.write('{"ready":true}\\n'); process.stdin.resume();`, [path]);
    await old.ready(); const bytes = await readFile(path);
    await assert.rejects(acquireLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
    await assert.rejects(cleanLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
    assert.deepEqual(await readFile(path), bytes); assert.equal(alive(old.process.pid), true); await old.kill();
  }
  assert.equal((await inspectLauncherOwner(app.root)).state, 'unknown');
  app.record('legacy-and-partial-write-remain-owned', { noGuardRequiredForLegacyRefusal: true, noPidSignalled: true });
});

test('OWNER-06 explicit cleanup only removes proven-dead root metadata and internal ownership CLI remains standalone', options, async t => {
  const app = await workspace(t); await mkdir(app.root); const childRoot = join(app.root, 'instances/preserved'); await mkdir(childRoot, { recursive: true });
  await save(join(childRoot, 'owner.lock'), { nonce: 'foreign-runtime', pid: process.pid });
  await save(join(app.root, 'launcher-owner.lock'), { nonce: 'dead-root-only', pid: await deadPid(t) });
  if (canRecover) {
    const result = await cleanLauncherOwner(app.root); assert.equal(result.cleaned, true);
    assert.equal((await cleanLauncherOwner(app.root)).cleaned, false);
  } else {
    const before = await readFile(join(app.root, 'launcher-owner.lock'));
    await assert.rejects(cleanLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
    assert.deepEqual(await readFile(join(app.root, 'launcher-owner.lock')), before);
    assert.equal((await inspectLauncherOwner(app.root)).recoveryAllowed, false);
  }
  assert.equal((await json(join(childRoot, 'owner.lock'))).nonce, 'foreign-runtime');
  assert.deepEqual(parseUiArgs(['--inspect-lock', '--root', app.root]), { 'inspect-lock': true, root: app.root });
  for (const args of [['--force'], ['--inspect-lock', '--clean-lock'], ['--clean-lock', '--open']]) assert.throws(() => parseUiArgs(args));
  const output = execFileSync(process.execPath, [join(ROOT, 'tools/launcher/cli.mjs'), '--inspect-lock', '--root', app.root], { encoding: 'utf8', windowsHide: true });
  const inspection = JSON.parse(output);
  assert.equal(inspection.state, canRecover ? 'absent' : 'dead'); assert.equal(inspection.recoveryAllowed, false);
  assert.deepEqual((await readdir(app.root)).sort(), canRecover ? ['instances'] : ['instances', 'launcher-owner.lock']);
});

test('OWNER-07 canonical case and Windows 8.3 aliases cannot take over live root ownership', options, async t => {
  const app = await workspace(t), owner = await acquireLauncherOwner(app.root); app.cleanups.push(() => owner.release());
  const canonical = await realpath(app.root); assert.equal(owner.root, canonical);
  const aliases = [canonical];
  if (process.platform === 'win32') {
    aliases.push(canonical.toLowerCase());
    const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("%WORLD_HUB_TEST_OWNER_ROOT%") do @echo %~sI'],
      { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, WORLD_HUB_TEST_OWNER_ROOT: canonical } }).trim().replace(/^"|"$/g, '');
    aliases.push(short);
  }
  for (const alias of aliases) {
    await assert.rejects(acquireLauncherOwner(alias), { code: 'LAUNCHER_LOCKED' });
    assert.equal((await inspectLauncherOwner(alias)).owner.nonce, owner.nonce);
  }
  app.record('aliases-share-live-owner', { aliases: aliases.length, kernelGuardSupported: canRecover, takeoverRefused: true });
});

test('OWNER-08 manager initialization failure releases only its own new root metadata', options, async t => {
  const app = await workspace(t); await mkdir(app.root); await writeFile(join(app.root, 'launcher-paths.json'), '{');
  await assert.rejects(createLauncherServer({ root: app.root })); assert.equal((await inspectLauncherOwner(app.root)).state, 'absent');
  const owner = await acquireLauncherOwner(app.root); await owner.release();
});

test('OWNER-09 unconfirmed manager cleanup preserves HTTP and kernel ownership until a successful retry', options, async t => {
  const app = await workspace(t), launcher = await createLauncherServer({ root: app.root });
  app.cleanups.push(() => launcher.close());
  const original = launcher.manager.close.bind(launcher.manager), nonce = (await inspectLauncherOwner(app.root)).owner.nonce;
  launcher.manager.close = async () => { throw Object.assign(new Error('Owned cleanup unconfirmed'), { code: 'CLEANUP_INCOMPLETE' }); };
  await assert.rejects(launcher.close(), { code: 'CLEANUP_INCOMPLETE' });
  await assert.rejects(acquireLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
  await assert.rejects(cleanLauncherOwner(app.root), { code: 'LAUNCHER_LOCKED' });
  assert.equal((await inspectLauncherOwner(app.root)).owner.nonce, nonce);
  const response = await fetch(launcher.url); assert.equal(response.status, 200); await response.body.cancel();
  launcher.manager.close = original; await launcher.close(); assert.equal((await inspectLauncherOwner(app.root)).state, 'absent');
  app.record('failed-close-retains-kernel-and-http-owner', { originalNonceRetained: true, recoveredAfterRetry: true });
});
