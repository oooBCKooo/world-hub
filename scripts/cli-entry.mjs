import { realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function entryIdentity(path) {
  let canonical = realpathSync.native(resolve(path));
  if (process.platform === 'win32') {
    // Windows accepts both ordinary and extended drive/UNC names for one file.
    canonical = canonical.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '');
    return normalize(canonical).toLowerCase();
  }
  return canonical;
}

// Node normally realpaths import.meta.url, while argv retains the invoked link.
// Canonicalize both sides: --preserve-symlinks-main also retains the module link.
// This identifies a CLI entry only; it does not grant any execution permission.
export function isDirectExecution(moduleUrl, entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try { return entryIdentity(entryPath) === entryIdentity(fileURLToPath(moduleUrl)); }
  catch { return false; }
}
