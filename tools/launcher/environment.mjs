import { lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { filteredEnv } from '../../scripts/runtime/package.mjs';

async function probe(command, kind) {
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
    const code = kind === 'node'
      ? 'console.log(JSON.stringify({executable:process.execPath,version:process.versions.node,arch:process.arch,packages:{}}))'
      : 'import sys,json,struct,platform,importlib.metadata; p={};\ntry: p["websockets"]=importlib.metadata.version("websockets")\nexcept importlib.metadata.PackageNotFoundError: pass\nm=platform.machine().lower(); a={"amd64":"x64","x86_64":"x64","arm64":"arm64","aarch64":"arm64","x86":"ia32","i386":"ia32","i686":"ia32"}.get(m,"unknown");\nprint(json.dumps({"executable":sys.executable,"version":".".join(map(str,sys.version_info[:3])),"arch":a,"pointerBits":struct.calcsize("P")*8,"packages":p}))';
    const result = spawnSync(executable, kind === 'node' ? ['-e', code] : ['-I', '-c', code],
      { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8', env: filteredEnv(executable) });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.slice(0, 1024));
    const found = JSON.parse(result.stdout.trim());
    if (!/^\d+\.\d+\.\d+$/.test(found.version) || typeof found.executable !== 'string') throw new Error('Invalid interpreter response');
    const actual = await realpath(found.executable);
    if (actual.toLowerCase() !== executable.toLowerCase()) throw new Error('Interpreter wrappers are unsupported');
    return { available: true, executable, version: found.version, arch: found.arch, ...(kind === 'python' ? { pointerBits: found.pointerBits } : {}), packages: found.packages };
  } catch (error) { return { available: false, requested: command, error: String(error.message).slice(0, 1024) }; }
}
export async function detectEnvironment({ nodePath = process.execPath, pythonPath = process.platform === 'win32' ? 'python.exe' : 'python3' } = {}) {
  return { platform: process.platform, arch: process.arch, node: await probe(nodePath, 'node'), python: await probe(pythonPath, 'python') };
}
