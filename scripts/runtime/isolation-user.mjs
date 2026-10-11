// Optional existing-account execution. It separates identities and drops
// privileges; it deliberately does not claim file, network or process sandboxing.
import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { ownProcess } from './process.mjs';
import { filteredEnv } from './package.mjs';
import { ordinaryPath, hash, collectFiles, relativePath, readBounded } from './paths.mjs';
import { fileURLToPath } from 'node:url';
const supervisorFile = fileURLToPath(new URL('./isolation-user-supervisor.mjs', import.meta.url));
const failure = (code, message) => Object.assign(new Error(message), { code });
const profile = 'linux-existing-user/v1';
const flags = user => ['--reuid', String(user.uid), '--regid', String(user.gid), '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--'];
async function provider(options) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw failure('ISOLATION_USER_PRIVILEGE_REQUIRED', 'Existing-user execution requires an already privileged Linux supervisor; this adapter never invokes sudo or grants privilege');
  if (!isAbsolute(options.setprivPath ?? '') || !options.user || Object.keys(options.user).some(key => !['uid', 'gid'].includes(key)) || !['uid', 'gid'].every(key => Number.isSafeInteger(options.user[key]) && options.user[key] > 0 && options.user[key] <= 2147483647)) throw failure('ISOLATION_USER_POLICY_INVALID', 'An absolute setpriv executable and existing non-root UID/GID are required');
  const executable = await ordinaryPath(options.setprivPath);
  if (!(await lstat(executable)).isFile()) throw failure('ISOLATION_USER_POLICY_INVALID', 'setpriv must be an ordinary executable');
  const accounts = (await readBounded('/etc/passwd')).toString('utf8').split('\n').map(line => line.split(':'));
  const account = accounts.find(row => row.length === 7 && Number(row[2]) === options.user.uid && Number(row[3]) === options.user.gid);
  const groups = (await readBounded('/etc/group')).toString('utf8').split('\n').map(line => line.split(':'));
  if (!account || !groups.some(row => row.length === 4 && Number(row[2]) === options.user.gid)) throw failure('ISOLATION_USER_NOT_FOUND', 'The specified UID and primary GID must already exist; no account is created');
  return { executable, executableSha256: hash(await readFile(executable)), user: { ...options.user }, username: account[0] };
}
async function run(p, executable, argv, { input = '', timeout = 10000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(p.executable, [...flags(p.user), executable, ...argv], { cwd, shell: false, env: filteredEnv(executable), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(failure('ISOLATION_USER_PROBE_TIMEOUT', 'Existing-user identity or access probe timed out')); }, timeout);
    child.stdin.on('error', () => {}); child.once('error', error => finish(error));
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 65536) { child.kill('SIGKILL'); finish(failure('ISOLATION_USER_PROBE_INVALID', 'Existing-user probe output exceeds bound')); } });
    child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 4096) stderr = stderr.slice(-4096); });
    child.once('close', code => finish(code === 0 ? null : failure('ISOLATION_USER_ACCESS_DENIED', 'Existing-user identity or path access checks failed; preconfigure the account and private component paths before retrying'), stdout)); child.stdin.end(input);
  });
}
const identityCode = `import fs from 'node:fs';const s=fs.readFileSync('/proc/self/status','utf8');const v={uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),noNewPrivileges:/^NoNewPrivs:\\s+1$/m.test(s),capabilitiesDropped:/^CapEff:\\s+0+$/m.test(s)&&/^CapBnd:\\s+0+$/m.test(s)};console.log(JSON.stringify(v));`;
async function identity(p, nodePath = process.execPath) {
  const value = JSON.parse(await run(p, nodePath, ['--input-type=module', '-e', identityCode]));
  if (value.uid !== p.user.uid || value.gid !== p.user.gid || value.groups.some(gid => gid !== p.user.gid) || value.noNewPrivileges !== true || value.capabilitiesDropped !== true) throw failure('ISOLATION_USER_IDENTITY_MISMATCH', 'setpriv did not enforce the reviewed UID/GID, group clearing and privilege drop');
  return value;
}
export async function probeExistingUser(options = {}) {
  const result = { format: 'world-hub.isolation-probe/v1', provider: 'linux-existing-user', profile, available: false, sandbox: false, identitySeparation: true, startsContainers: false, installsProvider: false, createsAccounts: false, changesHostPermissions: false, observedAt: new Date().toISOString() };
  try { const p = await provider(options); Object.assign(result, p, await identity(p), { available: true }); }
  catch (error) { result.error = { code: error.code?.startsWith?.('ISOLATION_') ? error.code : 'ISOLATION_USER_PROVIDER_UNAVAILABLE', message: error.message, remedy: 'Select an already existing non-root account, a reviewed setpriv executable and an already privileged Linux supervisor. No sudo, account creation or permission changes are performed.' }; }
  return result;
}
export async function reviewExistingUserPackage(plan, options = {}) {
  if (Object.keys(options).some(key => !['profile', 'setprivPath', 'user'].includes(key))) throw failure('ISOLATION_USER_POLICY_INVALID', 'Unknown existing-user policy field');
  const p = await provider(options); const actual = await identity(p, plan.environment.node.executable);
  const runtimes = Object.fromEntries([...new Set(plan.modules.map(m => m.manifest.runtime.kind))].map(kind => [kind, plan.environment[kind]]));
  const value = { format: 'world-hub.isolation-review/v1', profile, provider: p, packageDigest: plan.digest, expectedRuntimes: runtimes, components: plan.pack.components.map(c => c.id),
    supervisorSha256: hash(await readBounded(supervisorFile)),
    identitySeparation: true, sandbox: false, actualIdentity: actual, enforcement: { identity: 'existing-non-root-uid-and-primary-gid', privileges: 'no-new-privileges-and-all-capabilities-dropped', filesystem: 'ordinary-os-user-permissions', network: 'ordinary-os-user-permissions', processes: 'ordinary-os-user-permissions; declaration-is-not-enforced' },
    startsPrograms: false, policy: { profile, setprivPath: p.executable, user: p.user } };
  value.digest = hash(JSON.stringify(value)); return value;
}
export async function writeExistingUserConfiguration(policy, configPath, configuration, nodePath = process.execPath) {
  const p = await provider(policy), parent = await ordinaryPath(dirname(configPath));
  await requireState(p, parent); await ordinaryPath(configPath, { allowMissing: true });
  const code = `import fs from 'node:fs';let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;if(Buffer.byteLength(b)>1048576)process.exit(65)});process.stdin.on('end',()=>{JSON.parse(b);fs.writeFileSync(process.argv[1],b,{flag:'wx',mode:0o600});console.log('created')});`;
  await run(p, nodePath, ['--input-type=module', '-e', code, configPath], { input: JSON.stringify(configuration), cwd: parent });
}
async function requireState(p, state) {
  const info = await lstat(state);
  if (!info.isDirectory() || info.uid !== p.user.uid || info.gid !== p.user.gid || info.mode & 0o007) throw failure('ISOLATION_USER_STATE_UNPREPARED', 'Component state must already be private and owned by the selected UID/GID; no chmod or chown is performed');
}
export async function planExistingUser(options = {}) {
  const p = await provider(options), runtime = options.runtime;
  if (!['node', 'python'].includes(runtime) || !options.expectedRuntime?.version || !isAbsolute(options.runtimeExecutable ?? '')) throw failure('ISOLATION_ENVIRONMENT_REQUIRED', 'Select the reviewed absolute interpreter and locked runtime version');
  const executable = await ordinaryPath(options.runtimeExecutable), executableSha256 = hash(await readFile(executable));
  const source = await ordinaryPath(options.sourceDirectory), state = await ordinaryPath(options.stateDirectory), config = await ordinaryPath(options.configPath), entry = relativePath(options.entry);
  await requireState(p, state); await requireState(p, join(state, 'tmp'));
  const configuration = await lstat(config);
  if (!configuration.isFile() || configuration.uid !== p.user.uid || configuration.gid !== p.user.gid || (configuration.mode & 0o077) !== 0) throw failure('ISOLATION_USER_CONFIG_UNPREPARED', 'Component configuration must be a private ordinary file owned by the selected UID/GID');
  const files = await collectFiles(source); if (!files.some(file => file.path === entry)) throw failure('ISOLATION_ENTRY_INVALID', 'The reviewed source must include its entry');
  // Probe only identity and basic OS access with a fixed trusted interpreter,
  // never imports the component or writes/chowns/chmods its source or state.
  const code = `import fs from 'node:fs';for(const p of JSON.parse(process.argv[1]))fs.accessSync(p.path,p.mode);console.log('accessible')`;
  await run(p, options.nodeExecutable ?? process.execPath, ['--input-type=module', '-e', code, JSON.stringify([{ path: source, mode: 5 }, { path: join(source, entry), mode: 4 }, { path: config, mode: 4 }, { path: state, mode: 3 }, { path: join(state, 'tmp'), mode: 3 }, { path: executable, mode: 5 }])], { cwd: state });
  const nodeExecutable = await ordinaryPath(options.nodeExecutable ?? process.execPath), nodeExecutableSha256 = hash(await readFile(nodeExecutable));
  const value = { format: 'world-hub.isolation-plan/v1', profile, provider: p, runtime, expectedRuntime: options.expectedRuntime, executable, executableSha256, nodeExecutable, nodeExecutableSha256, supervisorSha256: hash(await readBounded(supervisorFile)), source, state, config, entry, files, configSha256: hash(await readBounded(config)),
    stateIdentity: { uid: (await lstat(state)).uid, gid: (await lstat(state)).gid, mode: (await lstat(state)).mode }, identitySeparation: true, sandbox: false, startsPrograms: false };
  value.digest = hash(JSON.stringify(value)); return value;
}
const launchNode = `import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';const [entry,config,wantedText]=process.argv.slice(1),wanted=JSON.parse(wantedText);if(process.getuid()!==wanted.user.uid||process.getgid()!==wanted.user.gid||process.versions.node!==wanted.runtime.version)throw new Error('ISOLATION_ENVIRONMENT_MISMATCH');const controls=readFileSync('/proc/self/status','utf8');if(!/^NoNewPrivs:\\s+1$/m.test(controls)||!/^CapEff:\\s+0+$/m.test(controls))throw new Error('ISOLATION_USER_IDENTITY_MISMATCH');console.log(JSON.stringify({event:'isolation-ready',profile:'linux-existing-user/v1',runtime:'node',runtimeVersion:process.versions.node,packages:{},user:process.getuid(),group:process.getgid(),identitySeparation:true,sandbox:false}));process.argv=[process.execPath,entry,'--runtime-config',config];await import(pathToFileURL(entry).href);`;
const launchPython = `import sys,os,json,runpy,importlib.metadata\nentry,config,wantedText=sys.argv[1:]\nwanted=json.loads(wantedText)\nversion='.'.join(map(str,sys.version_info[:3]))\npackages={n:importlib.metadata.version(n) for n in wanted['runtime']['packages']}\nif os.getuid()!=wanted['user']['uid'] or os.getgid()!=wanted['user']['gid'] or version!=wanted['runtime']['version'] or packages!=wanted['runtime']['packages']: raise RuntimeError('ISOLATION_ENVIRONMENT_MISMATCH')\nprint(json.dumps({'event':'isolation-ready','profile':'linux-existing-user/v1','runtime':'python','runtimeVersion':version,'packages':packages,'user':os.getuid(),'group':os.getgid(),'identitySeparation':True,'sandbox':False}),flush=True)\nsys.argv=[entry,'--runtime-config',config]\nsys.path.insert(0,os.path.dirname(entry))\nrunpy.run_path(entry,run_name='__main__')\n`;
export async function ownExistingUserProcess(plan, options = {}) {
  if (options.trust !== plan.digest) throw failure('ISOLATION_REVIEW_REQUIRED', 'Review the current existing-user interpreter, account and source paths');
  const checked = await planExistingUser({ profile, setprivPath: plan.provider.executable, user: plan.provider.user, runtime: plan.runtime, expectedRuntime: plan.expectedRuntime, runtimeExecutable: plan.executable, nodeExecutable: plan.nodeExecutable, sourceDirectory: plan.source, stateDirectory: plan.state, configPath: plan.config, entry: plan.entry });
  if (checked.digest !== plan.digest) throw failure('ISOLATION_REVIEW_CHANGED', 'The account, executable, configuration or reviewed paths changed');
  const wanted = JSON.stringify({ user: plan.provider.user, runtime: plan.expectedRuntime });
  const args = plan.runtime === 'node' ? ['--input-type=module', '-e', launchNode, join(plan.source, plan.entry), plan.config, wanted] : ['-I', '-B', '-c', launchPython, join(plan.source, plan.entry), plan.config, wanted];
  let childStopped = false;
  const command = JSON.stringify({ executable: plan.provider.executable, args: [...flags(plan.provider.user), plan.executable, ...args], cwd: plan.state, env: filteredEnv(plan.executable, options.temporary) });
  const h = ownProcess(plan.nodeExecutable, [supervisorFile, command], { ...options, detached: true, cwd: plan.state, onEvent: frame => {
    if (frame.event === 'isolation-ready') { h.messages.push(frame); if (h.messages.length > 128) h.messages.shift(); }
    if (frame.event === 'existing-user-child-stopped') childStopped = true;
    if (frame.event === 'existing-user-child-exit') { childStopped = true; options.onFailure?.(failure('ISOLATION_USER_PROGRAM_EXITED', 'The existing-user program exited; its current privileged group owner is retained for retirement')); }
    options.onEvent?.(frame);
  } });
  h.isolation = { profile, sandbox: false, identitySeparation: true, user: plan.provider.user, reviewDigest: plan.digest, auditedBeforeStart: true, filesystem: 'ordinary-os-user-permissions', network: 'ordinary-os-user-permissions', processes: 'ordinary-os-user-permissions; declaration-is-not-enforced' };
  h.isolation.lifecycle = 'current-owned-process-group; setsid-escaped-descendants-not-contained';
  h.stop = async timeoutMs => {
    h.stopping = true; h.send({ command: 'stop' }); const deadline = Date.now() + timeoutMs;
    while (!childStopped && !h.exit && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    h.forced = !childStopped; h.send({ command: 'retire-existing-user-group' });
    const finished = await Promise.race([h.closed.then(() => true), new Promise(resolve => setTimeout(resolve, 3000, false))]);
    if (!finished) { h.forced = true; try { await h.killOwnedGroup(); } catch (error) { h.cleanupIncomplete = true; throw error; } await h.closed; }
    const retiredDeadline = Date.now() + 5000;
    while (true) { if (await h.groupStopped()) break; if (Date.now() >= retiredDeadline) { h.cleanupIncomplete = true; throw failure('ISOLATION_USER_CLEANUP_INCOMPLETE', 'Current owned group still contains running processes; ownership retained'); } await new Promise(resolve => setTimeout(resolve, 50)); }
    h.isolation.ownedGroupRetired = true; delete h.cleanupIncomplete; return h.exit;
  };
  return h;
}
