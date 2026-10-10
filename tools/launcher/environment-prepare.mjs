// A deliberately finite, reviewed deployment recipe. Never read setup commands
// from modules and never install into the user's base Python environment.
import { mkdir, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ordinaryPath, readBounded, hash, processCwd, processPath } from '../../scripts/runtime/paths.mjs';
import { filteredEnv } from '../../scripts/runtime/package.mjs';
import { probe } from './environment.mjs';

export const PYTHON_RECIPE = Object.freeze({ name: 'websockets', version: '15.0.1', license: 'BSD-3-Clause',
  filename: 'websockets-15.0.1-py3-none-any.whl', size: 169743,
  url: 'https://files.pythonhosted.org/packages/fa/a8/5b41e0da817d64113292ab1f8247140aac61cbf6cfd085d6a0fa77f4984f/websockets-15.0.1-py3-none-any.whl',
  sha256: 'f7a866fbc1e97b5c617ee4116daaa09b722101d4a3c170c787450ba409f9736f',
  metadata: 'https://pypi.org/project/websockets/15.0.1/' });
const fail = (code, message) => Object.assign(new Error(message), { code });
const abort = signal => { if (signal?.aborted) throw fail('PREPARATION_CANCELLED', 'Environment preparation was cancelled.'); };
const inside = (root, value) => { const tail = relative(root, value); return tail !== '' && !isAbsolute(tail) && !tail.startsWith('..'); };

export async function planPythonEnvironment({ root, directory, nodePath = process.execPath, pythonPath = process.platform === 'win32' ? 'python.exe' : 'python3', destination }) {
  const environments = await ordinaryPath(resolve(root, 'environments'), { allowMissing: true });
  const target = destination ?? join(environments, 'python-' + randomUUID());
  if (!inside(environments, resolve(target))) throw fail('UNSAFE_ENVIRONMENT_PATH', 'Prepared environments must be inside the Launcher environment directory.');
  const canonicalTarget = await ordinaryPath(target, { allowMissing: true });
  if (process.platform === 'win32' && join(canonicalTarget, 'Scripts', 'python.exe').length >= 248)
    throw fail('ENVIRONMENT_PATH_TOO_LONG', 'Windows private-environment interpreter path must be shorter than 248 characters. Choose a shorter Launcher root or select an interpreter prepared in a shorter directory. Instance and module directories may still be long.');
  const lockBytes = await readBounded(join(await ordinaryPath(directory), 'pack.lock'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.format !== 'world-hub.pack-lock/v1' || lock.platform?.os !== process.platform || lock.platform?.arch !== process.arch)
    throw fail('ENVIRONMENT_PLATFORM_MISMATCH', 'This recipe requires a lock for the current OS and architecture.');
  const packages = lock.runtimes?.python?.packages;
  if (!packages || Object.keys(packages).length !== 1 || packages.websockets !== PYTHON_RECIPE.version)
    throw fail('ENVIRONMENT_RECIPE_UNAVAILABLE', 'Automatic preparation supports only the pinned websockets 15.0.1 wheel. Prepare other dependencies manually in a private environment.');
  const [base, node] = await Promise.all([probe(pythonPath, 'python'), probe(nodePath, 'node')]);
  if (!base.available || !node.available) throw fail('INTERPRETER_MISSING', 'Choose installed native Node and Python interpreters before preparing dependencies.');
  if (base.version !== lock.runtimes.python.version || node.version !== lock.runtimes.node.version || base.arch !== process.arch || node.arch !== process.arch)
    throw fail('INTERPRETER_VERSION_MISMATCH', 'The selected interpreters must match the locked versions and architecture. Preparation does not rewrite the lock.');
  base.sha256 = hash(await readBounded(base.executable, 256 * 1024 * 1024));
  node.sha256 = hash(await readBounded(node.executable, 256 * 1024 * 1024));
  const value = { format: 'world-hub.environment-plan/v1', directory: resolve(directory), lockSha256: hash(lockBytes),
    lockRequirements: lock.runtimes, platform: lock.platform, base, node, destination: target, download: PYTHON_RECIPE,
    actions: ['Create a new isolated Python venv without pip using the selected interpreter.', 'Use the verified cached wheel or download it from the displayed PyPI file URL.',
      'Install the fixed pure-Python wheel with a bounded standard-library copier; no setup scripts or installer subprocesses.', 'Probe the new environment; select it and review your package again.'],
    changesSystemEnvironment: false, executesModuleScripts: false, sandbox: false };
  return { ...value, digest: hash(JSON.stringify(value)) };
}

async function run(executable, args, { signal, cwd, timeout = 120000 }) {
  abort(signal);
  return new Promise((yes, no) => {
    const child = spawn(processPath(executable), args, { cwd: processCwd(cwd), env: filteredEnv(executable, cwd), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', reason, timer, forceTimer, endTimer, settled = false, exited = false, exitResolve;
    const closed = new Promise(resolveExit => { exitResolve = resolveExit; });
    const cleanupHandle = { closed, stop: async () => {
      if (!exited) child.kill('SIGKILL');
      return await Promise.race([closed.then(() => true), new Promise(resolveWait => { const timer = setTimeout(() => resolveWait(false), 5000); timer.unref(); })]);
    } };
    const stop = value => { if (reason) return; reason = value; child.kill();
      forceTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1000);
      endTimer = setTimeout(() => {
        if (exited || settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        reason.cleanupIncomplete = true; Object.defineProperty(reason, 'cleanupHandle', { value: cleanupHandle }); no(reason);
      }, 6000);
    };
    const cancel = () => stop(fail('PREPARATION_CANCELLED', 'Environment preparation was cancelled.'));
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => stop(fail('PREPARATION_TIMEOUT', 'Environment tool exceeded its preparation deadline.')), timeout);
    let outputBytes = 0;
    const collect = bytes => { outputBytes += bytes.length;
      output = Buffer.concat([Buffer.from(output), bytes]).subarray(-65536).toString('utf8');
      if (outputBytes > 65536) stop(fail('PREPARATION_OUTPUT_LIMIT', 'Environment tool exceeded its output bound.')); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    for (const stream of ['stdout', 'stderr']) child[stream].on('error', () => {
      if (exited || settled) return;
      stop(fail('PREPARATION_PIPE_FAILED', `Environment tool ${stream} pipe failed. Wait for confirmed cleanup before retrying.`));
    });
    child.once('error', error => { reason ??= error; });
    child.once('close', code => { exited = true; exitResolve(); clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(endTimer); signal?.removeEventListener('abort', cancel);
      if (settled) return; settled = true;
      if (reason) no(reason); else if (code !== 0) no(fail('PREPARATION_TOOL_FAILED', 'Selected environment tool failed: ' + output.slice(-2048))); else yes(); });
    if (signal?.aborted) cancel();
  });
}
export async function cleanupPreparedEnvironment(root, directory) {
  const environments = await ordinaryPath(join(root, 'environments')), target = await ordinaryPath(directory);
  if (!inside(environments, target)) throw fail('UNSAFE_ENVIRONMENT_PATH', 'Environment cleanup target escaped its root');
  await rm(target, { recursive: true, force: true });
}

async function verifiedWheel(root, signal) {
  const cache = join(root, 'environment-cache'); await ordinaryPath(cache, { allowMissing: true }); await mkdir(cache, { recursive: true, mode: 0o700 });
  const file = join(cache, PYTHON_RECIPE.filename);
  const check = async () => { const bytes = await readBounded(file, PYTHON_RECIPE.size); if (bytes.length !== PYTHON_RECIPE.size || hash(bytes) !== PYTHON_RECIPE.sha256) throw fail('WHEEL_INTEGRITY_MISMATCH', 'Cached wheel differs from the reviewed PyPI digest. Remove the invalid cache file and prepare again.'); return file; };
  try { return { file: await check(), cached: true }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  abort(signal);
  const response = await fetch(PYTHON_RECIPE.url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) throw fail('WHEEL_DOWNLOAD_FAILED', 'The reviewed PyPI wheel is unavailable. A verified cached copy can be used offline.');
  const chunks = []; let size = 0;
  for await (const bytes of response.body) { size += bytes.length; if (size > PYTHON_RECIPE.size) throw fail('WHEEL_INTEGRITY_MISMATCH', 'Wheel download exceeded its reviewed size.'); chunks.push(bytes); }
  const bytes = Buffer.concat(chunks);
  if (size !== PYTHON_RECIPE.size || hash(bytes) !== PYTHON_RECIPE.sha256) throw fail('WHEEL_INTEGRITY_MISMATCH', 'Downloaded wheel differs from the reviewed PyPI digest.');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { try { await unlink(temporary); } catch {} }
  return { file: await check(), cached: false };
}

export async function preparePythonEnvironment({ root, plan, signal }) {
  abort(signal);
  const actual = await planPythonEnvironment({ root, directory: plan.directory, nodePath: plan.node.executable,
    pythonPath: plan.base.executable, destination: plan.destination });
  if (actual.digest !== plan.digest) throw fail('ENVIRONMENT_PLAN_CHANGED', 'The lock or selected interpreter changed after review. Check the preparation plan again.');
  let created = false;
  try {
    const wheel = await verifiedWheel(root, signal); abort(signal);
    await mkdir(dirname(plan.destination), { recursive: true, mode: 0o700 });
    await ordinaryPath(plan.destination, { allowMissing: true }); await mkdir(plan.destination, { mode: 0o700 }); created = true;
    await run(plan.base.executable, ['-I', '-m', 'venv', '--copies', '--without-pip', plan.destination], { signal, cwd: plan.destination });
    const pythonPath = join(plan.destination, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    // This exact wheel has no scripts, data relocation or native extensions.
    // No installer or module subprocess is invoked. Windows' native venv
    // redirector may relaunch its base interpreter in its own lifetime job;
    // unsupported long venv paths are refused by the preparation plan.
    const installer = `import sys,sysconfig,pathlib,zipfile,io,hashlib,stat\nwheel=pathlib.Path(sys.argv[1]).read_bytes()\nassert len(wheel)==${PYTHON_RECIPE.size} and hashlib.sha256(wheel).hexdigest()=='${PYTHON_RECIPE.sha256}'\nbase=pathlib.Path(sys.prefix).resolve(); target=pathlib.Path(sysconfig.get_path('purelib')).resolve()\nassert target.is_relative_to(base)\narchive=zipfile.ZipFile(io.BytesIO(wheel)); entries=archive.infolist(); assert len(entries)<=1024\ntotal=0; seen=set()\nfor entry in entries:\n name=entry.filename; parts=name.rstrip('/').split('/'); assert all(p and p not in ('.','..') and ':' not in p and chr(92) not in p for p in parts)\n assert parts[0] in ('websockets','websockets-15.0.1.dist-info') and not stat.S_ISLNK(entry.external_attr>>16)\n key=name.lower(); assert key not in seen; seen.add(key)\n total+=entry.file_size; assert entry.file_size<=8388608 and total<=67108864\n file=target.joinpath(*parts); assert file.resolve().is_relative_to(target)\n if entry.is_dir(): file.mkdir(parents=True,exist_ok=True)\n else:\n  file.parent.mkdir(parents=True,exist_ok=True)\n  with file.open('xb') as output: output.write(archive.read(entry))\n`;
    await run(pythonPath, ['-I', '-c', installer, wheel.file], { signal, cwd: plan.destination });
    const environment = await probe(pythonPath, 'python'); abort(signal);
    if (!environment.available || environment.version !== plan.base.version || environment.packages.websockets !== PYTHON_RECIPE.version)
      throw fail('ENVIRONMENT_VERIFICATION_FAILED', 'Prepared environment did not match the reviewed requirements.');
    await writeFile(join(plan.destination, 'world-hub-environment.json'), JSON.stringify({ format: 'world-hub.prepared-environment/v1', planDigest: plan.digest,
      base: plan.base, dependency: PYTHON_RECIPE, createdAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
    return { pythonPath, environment, directory: plan.destination, cached: wheel.cached, changesSystemEnvironment: false,
      nextAction: 'Select this Python interpreter and inspect the package again. Existing instance reviews are not rewritten.' };
  } catch (error) {
    if (error.cleanupIncomplete) error.retainedDirectory = plan.destination;
    else if (created) try {
      await cleanupPreparedEnvironment(root, plan.destination);
    } catch (cleanup) { error.cleanupIncomplete = true; error.retainedDirectory = plan.destination; error.message += ' Partial environment retained: ' + cleanup.message; }
    throw error;
  }
}
