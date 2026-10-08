import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Source packages use the invoking Node; Windows portable packages use their
// verified bundled executable. Acceptance never searches a local runtime cache.
export async function runtimeForBundle(root) {
  const executable = join(root, 'runtime/node.exe');
  try {
    const info = await lstat(executable);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Bundled Node must be a regular file');
    if (process.platform !== 'win32') throw new Error('Windows portable package requires Windows; build a source package for this host');
    return executable;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return process.execPath;
  }
}
