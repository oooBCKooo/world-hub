// Optional deployment-tool filesystem rules; no Hub protocol dependency.
import { lstat, realpath, readdir, readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, parse, join, toNamespacedPath, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function processPath(value) {
  return process.platform === 'win32' && isAbsolute(value) && value.length >= 248 ? toNamespacedPath(value) : value;
}
// CreateProcess can reject an existing long cwd with ENOENT. Use the native
// Windows spelling of the same directory, without relocating program state.
// Keep ordinary short cwd spelling; reserve room at the legacy directory limit.
export function processCwd(value = process.cwd()) {
  if (process.platform !== 'win32') return value;
  const absolute = resolve(value);
  return absolute.length >= 248 ? processPath(absolute) : value;
}
export async function checkPythonExecutablePath(executable) {
  if (process.platform !== 'win32' || executable.length < 248) return;
  // The Windows venv redirector can hang while relaunching its base interpreter
  // from a long executable path. Refuse this unsupported profile before spawn.
  try { await lstat(join(dirname(dirname(executable)), 'pyvenv.cfg')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Object.assign(new Error('Windows virtual-environment interpreter path is too long. Select an environment in a shorter directory; long instance and module directories are supported independently.'), { code: 'WINDOWS_VENV_PATH_TOO_LONG' });
}
export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\')
      || value.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p)
        || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error(`Unsafe relative package path: ${value}`);
  }
  return value;
}
export async function ordinaryPath(value, { allowMissing = false } = {}) {
  const absolute = resolve(value), drive = parse(absolute).root;
  const parts = absolute.slice(drive.length).split(/[\\/]/).filter(Boolean);
  const samePath = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  let current = await realpath(drive);
  for (let index = 0; index < parts.length; index++) {
    const candidate = join(current, parts[index]);
    let info;
    try { info = await lstat(candidate); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return join(current, ...parts.slice(index));
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Symbolic links or reparse paths are not accepted: ${candidate}`);
    const actual = await realpath(candidate);
    // Windows 8.3 names can change a component's spelling without moving it.
    // Every ancestor is checked separately; resolution must keep this parent.
    if (!samePath(dirname(actual), current)) throw new Error(`Path resolved outside its declared location: ${candidate}`);
    current = actual;
  }
  return current;
}
export async function readBounded(file, max = 1024 * 1024) {
  await ordinaryPath(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > max) throw new Error(`Expected ordinary file of at most ${max} bytes: ${file}`);
  const bytes = await readFile(file);
  if (bytes.length > max) throw new Error(`File grew beyond its bound: ${file}`);
  return bytes;
}
export async function collectFiles(root) {
  await ordinaryPath(root);
  const files = []; let bytes = 0, entries = 0;
  async function visit(local = '') {
    for (const entry of (await readdir(join(root, local), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (++entries > 8192) throw new Error('Module tree exceeds entry-count bound');
      const path = local ? `${local}/${entry.name}` : entry.name;
      if (['__pycache__', '.venv', '.git', '.hub', '.state'].includes(entry.name) || /\.py[co]$/.test(entry.name)) throw new Error(`Generated/private module material is not a deployment source: ${path}`);
      relativePath(path);
      const full = join(root, path); const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Package link is not allowed: ${path}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const content = await readBounded(full, 8 * 1024 * 1024);
        bytes += content.length;
        if (bytes > 64 * 1024 * 1024 || files.length >= 4096) throw new Error('Module source tree exceeds v1 size or file-count bound');
        files.push({ path, sha256: hash(content) });
      } else throw new Error(`Package special file is not allowed: ${path}`);
    }
  }
  await visit();
  const cases = new Set();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (cases.has(key)) throw new Error(`Case-colliding package path: ${file.path}`);
    cases.add(key);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function privateJson(file, value, { exclusive = false } = {}) {
  await ordinaryPath(dirname(file), { allowMissing: true });
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await ordinaryPath(file, { allowMissing: true });
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) return writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    // Windows readers and antivirus can briefly deny replacement of the old
    // journal. Retry the same atomic rename; never remove the destination or
    // turn a persistent permission failure into an in-place write. A bounded
    // four-second window also covers slower Windows runners and scanners.
    const replacementDeadline = performance.now() + 4000;
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        const remaining = replacementDeadline - performance.now();
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
        await new Promise(resolveWait => setTimeout(resolveWait, Math.min((attempt + 1) * 25, 100, remaining)));
      }
    }
  } catch (error) { try { await unlink(temporary); } catch {} throw error; }
}
