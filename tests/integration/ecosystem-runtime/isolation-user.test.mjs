// Explicit real Linux/root gate. The fixture account must already exist; only
// CI setup (outside Runtime) creates it and configures private ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, chmod, chown, readdir, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock, importPackage, inspectPackage, startInstance, reviewIsolationPackage } from '../../../scripts/runtime/index.mjs';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const pythonPath = process.env.WORLD_HUB_TEST_PYTHON;
const user = { uid: Number(process.env.WORLD_HUB_TEST_USER_UID), gid: Number(process.env.WORLD_HUB_TEST_USER_GID) };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function readableSource(directory) { await chmod(directory, 0o755); for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await readableSource(path); else await chmod(path, 0o644); } }
test('ISOLATION-USER real existing non-root UID/GID executes the cross-language HTTP pack with identity separation, never claiming a network sandbox', { timeout: 120000 }, async t => {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0, 'Run the explicitly authorized acceptance with an already privileged supervisor'); assert.ok(pythonPath && user.uid > 0 && user.gid > 0, 'Select an existing CI-only account and exact host Python');
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-user-real-')), root = join(directory, 'root'), pack = join(directory, 'pack'), canary = join(directory, 'root-secret'); let session;
  let visits = 0; const server = createServer((_request, response) => { visits++; response.end('ordinary OS network'); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (session) { const stopped = await session.close(); assert.equal(stopped.cleanupIncomplete, undefined); assert.ok(stopped.stoppedAt); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(directory.split('/').at(-1).startsWith('world-hub-user-real-')); await rm(directory, { recursive: true, force: true }); });
  await writeFile(canary, 'root-secret-canary', { mode: 0o600 }); await cp(join(ROOT, 'examples/ecosystem-pack'), pack, { recursive: true });
  const original = await readFile(join(pack, 'modules/source/program.mjs'), 'utf8');
  const prefix = `import{readFile as isolationRead,writeFile as isolationWrite}from'node:fs/promises';import{spawnSync as isolationSpawn}from'node:child_process';const isolationCfg=JSON.parse(await isolationRead(process.argv[3],'utf8'));let denied=false;try{await isolationRead(isolationCfg.settings.canary)}catch(e){denied=e.code==='EACCES'};const child=isolationSpawn(process.execPath,['-e','process.exit(0)']);const net=await fetch(isolationCfg.settings.hostUrl);await isolationWrite(isolationCfg.stateDir+'/identity.json',JSON.stringify({uid:process.getuid(),gid:process.getgid(),hostPrivateDenied:denied,ordinaryNetworkAvailable:net.ok,ordinarySubprocessAvailable:child.status===0}));\n`;
  await writeFile(join(pack, 'modules/source/program.mjs'), prefix + original);
  const manifest = await json(join(pack, 'pack.json')); Object.assign(manifest.components.find(c => c.id === 'source').settings, { canary, hostUrl: 'http://127.0.0.1:' + server.address().port }); manifest.startupTimeoutMs = 30000; manifest.healthTimeoutMs = 5000;
  await writeFile(join(pack, 'pack.json'), JSON.stringify(manifest)); await createLock(pack, { nodePath: process.execPath, pythonPath });
  const imported = await importPackage(pack, { root, instanceId: 'test', nodePath: process.execPath, pythonPath });
  // This is explicit test deployment preparation, never Runtime behavior.
  for (const path of [directory, root, join(root, 'instances'), imported.stateDir]) { try { await chmod(path, 0o755); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  await readableSource(join(imported.stateDir, 'package')); const programs = join(imported.stateDir, 'programs'); await mkdir(programs, { mode: 0o711 });
  for (const c of manifest.components) { const state = join(programs, c.id); await mkdir(state, { mode: 0o700 }); await chown(state, user.uid, user.gid); await mkdir(join(state, 'tmp'), { mode: 0o700 }); await chown(join(state, 'tmp'), user.uid, user.gid); }
  const plan = await inspectPackage(join(imported.stateDir, 'package'), { nodePath: process.execPath, pythonPath });
  const policy = { profile: 'linux-existing-user/v1', setprivPath: '/usr/bin/setpriv', user };
  await assert.rejects(reviewIsolationPackage(plan, { ...policy, user: { uid: 0, gid: 0 } }), { code: 'ISOLATION_USER_POLICY_INVALID' });
  const review = await reviewIsolationPackage(plan, policy); assert.equal(review.sandbox, false); assert.equal(review.identitySeparation, true);
  // OS preparation is mandatory. A root-owned private state is not silently fixed.
  const sourceState = join(programs, 'source'); await chown(sourceState, 0, 0);
  await assert.rejects(startInstance({ root, instanceId: 'test', pythonPath, trust: plan.digest, isolation: policy, isolationTrust: review.digest }), { code: 'ISOLATION_USER_STATE_UNPREPARED' }); assert.equal((await lstat(sourceState)).uid, 0);
  await chown(sourceState, user.uid, user.gid);
  session = await startInstance({ root, instanceId: 'test', pythonPath, trust: plan.digest, isolation: policy, isolationTrust: review.digest });
  const status = await session.status(); assert.equal(status.sandbox, false); assert.equal(status.identitySeparation, true); assert.equal(status.executionProfile, 'linux-existing-user/v1'); assert.ok(status.components.every(c => c.isolation.sandbox === false && c.isolation.identitySeparation && c.isolation.user.uid === user.uid && c.communication === 'connected'));
  const text = 'Existing UID → Python 🌍'; const response = await fetch(new URL('/analyze', status.entryUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.result.text, text); assert.equal(result.result.output.codePoints, [...text].length);
  const identity = await json(join(sourceState, 'identity.json')); assert.deepEqual(identity, { uid: user.uid, gid: user.gid, hostPrivateDenied: true, ordinaryNetworkAvailable: true, ordinarySubprocessAvailable: true }); assert.equal(visits, 1); assert.equal(await readFile(canary, 'utf8'), 'root-secret-canary');
  for (const c of manifest.components) { const files = (await readdir(join(programs, c.id))).filter(name => name.startsWith('.runtime-')); assert.equal(files.length, 1); const info = await lstat(join(programs, c.id, files[0])); assert.equal(info.uid, user.uid); assert.equal(info.gid, user.gid); assert.equal(info.mode & 0o777, 0o600); }
  await session.close(); for (const c of manifest.components) assert.equal((await readdir(join(programs, c.id))).filter(name => name.startsWith('.runtime-')).length, 0);
  t.diagnostic(JSON.stringify({ profile: review.profile, identity, enforcedIdentity: review.actualIdentity, sandbox: false, configurationOwnedByTarget: true, noAccountsCreatedByRuntime: true }));
});
