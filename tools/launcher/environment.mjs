import { lstat, realpath, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, parse } from 'node:path';
import { filteredEnv } from '../../scripts/runtime/package.mjs';
import { processCwd, processPath, checkPythonExecutablePath } from '../../scripts/runtime/paths.mjs';

export async function probe(command, kind) {
  try {
    let executable = command;
    if (!command.includes('/') && !command.includes('\\')) {
      executable = null;
      for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
        if (!directory) continue;
        const candidate = join(directory, command);
        try { if ((await lstat(candidate)).isFile()) { executable = candidate; break; } } catch {}
      }
      if (!executable) throw new Error(`Interpreter not found: ${command}`);
    }
    executable = await realpath(resolve(executable));
    if (kind === 'python') await checkPythonExecutablePath(executable);
    const code = kind === 'node'
      ? 'console.log(JSON.stringify({executable:process.execPath,version:process.versions.node,arch:process.arch,packages:{}}))'
      : 'import sys,json,struct,platform,sysconfig,importlib.metadata; p={};\ntry: p["websockets"]=importlib.metadata.version("websockets")\nexcept importlib.metadata.PackageNotFoundError: pass\nm=sysconfig.get_platform().lower() if sys.platform=="win32" else platform.machine().lower(); a={"win-amd64":"x64","win-arm64":"arm64","win32":"ia32","amd64":"x64","x86_64":"x64","arm64":"arm64","aarch64":"arm64","x86":"ia32","i386":"ia32","i686":"ia32"}.get(m,"unknown");\nprint(json.dumps({"executable":sys.executable,"version":".".join(map(str,sys.version_info[:3])),"arch":a,"pointerBits":struct.calcsize("P")*8,"packages":p}))';
    const result = spawnSync(processPath(executable), kind === 'node' ? ['-e', code] : ['-I', '-c', code],
      { cwd: processCwd(), shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8', env: filteredEnv(executable) });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.slice(0, 1024));
    const found = JSON.parse(result.stdout.trim());
    if (!/^\d+\.\d+\.\d+$/.test(found.version) || typeof found.executable !== 'string') throw new Error('Invalid interpreter response');
    const actual = await realpath(found.executable);
    if ((process.platform === 'win32' ? actual.toLowerCase() !== executable.toLowerCase() : actual !== executable)) throw new Error('Interpreter wrappers are unsupported');
    return { available: true, executable, version: found.version, arch: found.arch, ...(kind === 'python' ? { pointerBits: found.pointerBits } : {}), packages: found.packages };
  } catch (error) { return { available: false, requested: command, error: String(error.message).slice(0, 1024) }; }
}
// Discovery lists candidates only. Selecting and checking an interpreter runs
// the fixed probe; finding a filename does not establish trust in its code.
export async function discoverEnvironment(options = {}) {
  const candidates = { node: [], python: [] }, seen = new Set();
  const add = async (kind, path, source) => {
    if (candidates.node.length + candidates.python.length >= 64) return;
    try {
      const value = resolve(path), key = kind + ':' + (process.platform === 'win32' ? value.toLowerCase() : value);
      if (seen.has(key) || !(await lstat(value)).isFile()) return;
      seen.add(key); candidates[kind].push({ path: value, source, probed: false });
    } catch {}
  };
  await add('node', options.nodePath ?? process.execPath, 'selected');
  if (options.pythonPath?.includes('/') || options.pythonPath?.includes('\\')) await add('python', options.pythonPath, 'selected');
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean).slice(0, 128)) {
    for (const [kind, names] of Object.entries(process.platform === 'win32' ? { node: ['node.exe'], python: ['python.exe', 'python3.exe'] } : { node: ['node'], python: ['python3', 'python'] }))
      for (const name of names) await add(kind, join(directory, name), 'PATH');
  }
  if (process.platform === 'win32') {
    const drive = parse(process.execPath).root;
    for (const version of ['39', '310', '311', '312', '313', '314']) await add('python', join(drive, 'Python' + version, 'python.exe'), 'standard-location');
    if (process.env.LOCALAPPDATA) {
      const base = join(process.env.LOCALAPPDATA, 'Programs', 'Python');
      try { for (const item of (await readdir(base, { withFileTypes: true })).slice(0, 32)) if (item.isDirectory() && /^Python[0-9]+$/.test(item.name)) await add('python', join(base, item.name, 'python.exe'), 'standard-location'); } catch {}
    }
  }
  return candidates;
}
export async function detectEnvironment({ nodePath = process.execPath, pythonPath = process.platform === 'win32' ? 'python.exe' : 'python3' } = {}) {
  return { platform: process.platform, arch: process.arch, node: await probe(nodePath, 'node'), python: await probe(pythonPath, 'python') };
}
