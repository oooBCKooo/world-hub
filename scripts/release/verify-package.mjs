import { readFile, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyPackage(root, { allowConfigChange = false } = {}) {
  root = resolve(root);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid package manifest');
  const failed = []; const allowed = []; const known = new Set(['manifest.json']);
  const skippedConfiguration = [];
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || item.path.includes('\\') || item.path.startsWith('/') || item.path.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(item.path) || known.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('Unsafe or duplicate manifest entry');
    known.add(item.path);
    const path = resolve(root, ...item.path.split('/'));
    if (!path.startsWith(root + sep)) throw new Error('Manifest path escapes package');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
      const actual = createHash('sha256').update(await readFile(path)).digest('hex');
      if (allowConfigChange && item.path === 'config/hub.json') { skippedConfiguration.push(item.path); continue; }
      if (actual !== item.sha256 || info.size !== item.size) failed.push({ path: item.path, reason: 'size or SHA-256 differs' });
    } catch (error) { failed.push({ path: item.path, reason: error.message }); }
  }
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); const local = relative(root, path).split(sep).join('/');
      if (local === 'data' && entry.isDirectory() && !entry.isSymbolicLink()) { allowed.push('data/**'); continue; }
      if (entry.isSymbolicLink()) { failed.push({ path: local, reason: 'symbolic link not allowed' }); continue; }
      if (entry.isDirectory()) await visit(path);
      else if (!known.has(local)) failed.push({ path: local, reason: 'unlisted file outside data/' });
    }
  }
  await visit(root);
  return { passed: failed.length === 0, version: manifest.version, kind: manifest.kind, checkedFiles: manifest.files.length, allowedRuntimeData: allowed, skippedConfiguration, failed, note: 'Checks accidental changes against the supplied manifest; not a publisher signature' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let root = fileURLToPath(new URL('../../', import.meta.url)); let allowConfigChange = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = args[++i];
    else if (args[i] === '--allow-config-change') allowConfigChange = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  try { const result = await verifyPackage(root, { allowConfigChange }); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
