// Optional local instance maintenance. No business data interpretation or Hub commands.
import { lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { instancePath, inspectPackage, repository, safeId, validateModule, validatePack } from './package.mjs';
import { ordinaryPath, privateJson, readBounded, relativePath } from './paths.mjs';

const MAGIC = Buffer.from('WORLD-HUB-INSTANCE-BACKUP/1\n', 'ascii');
const FORMAT = 'world-hub.instance-backup/v1';
export const backupLimits = Object.freeze({ files: 8192, entries: 32768, fileBytes: 256 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024, headerBytes: 4 * 1024 * 1024 });
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const fault = (code, message) => Object.assign(new Error(message), { code });
const json = async file => JSON.parse((await readBounded(file)).toString('utf8'));
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const cancelled = signal => { if (signal?.aborted) throw fault('MAINTENANCE_ABORTED', 'Instance maintenance was cancelled'); };
const within = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !/^[A-Za-z]:/.test(path));
};
function closed(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))
      || keys.some(k => !Object.hasOwn(value, k))) throw fault('BACKUP_INVALID', `Invalid ${label} fields`);
}
function exactVersion(value, label) {
  if (typeof value !== 'string' || value.length > 128 || !VERSION.test(value)) throw fault('BACKUP_INVALID', `Invalid ${label}`);
}
function portablePath(path) {
  try { return relativePath(path); } catch { throw fault('BACKUP_PATH', `Unsafe backup path: ${String(path).slice(0, 256)}`); }
}
async function installedVersion() { return (await json(join(repository, 'package.json'))).version; }

async function confirmedStopped(directory, instanceId) {
  const identity = await json(join(directory, 'instance.json'));
  if (identity.format !== 'world-hub.instance/v1' || identity.instanceId !== instanceId || !SHA.test(identity.digest))
    throw fault('INSTANCE_INVALID', 'Instance identity is invalid');
  let status;
  try { status = await json(join(directory, 'status.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let history = await exists(join(directory, 'control.json'));
    try { await ordinaryPath(join(directory, 'runs')); history ||= (await readdir(join(directory, 'runs'))).length > 0; }
    catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
    if (history) throw fault('INSTANCE_NOT_STOPPED', 'Runtime history exists but its stopped status is missing. Preserve data and inspect the owning supervisor before maintenance.');
    return { identity, status: null };
  }
  if (status.format !== 'world-hub.runtime-status/v1' || status.instanceId !== instanceId
      || !['stopped', 'failed'].includes(status.state) || !status.stoppedAt || status.cleanupIncomplete
      || typeof status.runId !== 'string' || !Array.isArray(status.components)
      || status.components.some(c => !['exited', 'failed'].includes(c.process) || !c.exit)) {
    throw fault('INSTANCE_NOT_STOPPED', 'Stop this instance and confirm every owned process has exited before maintenance; stale or failed status alone is insufficient');
  }
  return { identity, status };
}
async function withStoppedInstance(options, operation) {
  const directory = await ordinaryPath(instancePath(options.root, options.instanceId));
  const file = join(directory, 'owner.lock'), nonce = randomUUID();
  await ordinaryPath(file, { allowMissing: true });
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw fault('INSTANCE_LOCKED', 'An instance owner or maintenance operation still holds its lock; stop the owning supervisor first. Stored PIDs are never killed.');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ format: 'world-hub.maintenance-owner/v1', nonce, pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    await handle.close(); handle = null;
    cancelled(options.signal);
    const stopped = await confirmedStopped(directory, options.instanceId);
    return await operation(directory, stopped);
  } finally {
    if (handle) await handle.close().catch(() => {});
    try { if ((await json(file)).nonce === nonce) await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function streamHash(file, signal, consume) {
  await ordinaryPath(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > backupLimits.fileBytes) throw fault('BACKUP_LIMIT', 'Backup requires ordinary files of at most 256 MiB');
  const handle = await open(file, 'r'), digest = createHash('sha256');
  const block = Buffer.allocUnsafe(1024 * 1024); let position = 0;
  try {
    while (position < info.size) {
      cancelled(signal);
      const { bytesRead } = await handle.read(block, 0, Math.min(block.length, info.size - position), position);
      if (!bytesRead) throw fault('BACKUP_CHANGED', 'An instance file changed during backup');
      const bytes = block.subarray(0, bytesRead); digest.update(bytes); await consume?.(bytes); position += bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== info.size) throw fault('BACKUP_CHANGED', 'An instance file changed during backup');
    return { bytes: position, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}
async function persistentFiles(directory, plan, signal) {
  const files = [], names = new Set(), directories = new Set(); let entries = 0, bytes = 0;
  const add = async path => {
    portablePath(path); cancelled(signal);
    if (names.has(path.toLowerCase())) throw fault('BACKUP_PATH', 'Case-colliding instance file paths are unsupported');
    names.add(path.toLowerCase());
    const info = await streamHash(join(directory, path), signal); bytes += info.bytes;
    if (files.length >= backupLimits.files || bytes > backupLimits.totalBytes) throw fault('BACKUP_LIMIT', 'Backup exceeds the 8192-file or 512 MiB limit');
    files.push({ path, ...info });
  };
  const visit = async path => {
    directories.add(path);
    await ordinaryPath(join(directory, path));
    for (const entry of (await readdir(join(directory, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (++entries > backupLimits.entries) throw fault('BACKUP_LIMIT', 'Instance tree exceeds the traversal bound');
      const next = path + '/' + entry.name; portablePath(next); cancelled(signal);
      const info = await lstat(join(directory, next));
      if (info.isSymbolicLink()) throw fault('BACKUP_PATH', 'Instance backup rejects links and reparse paths');
      if (info.isDirectory()) await visit(next);
      else if (info.isFile()) await add(next);
      else throw fault('BACKUP_PATH', 'Instance backup rejects special files');
    }
  };
  const packageRoot = plan.directory.endsWith('detached-package') ? 'detached-package' : 'package';
  // The archive always uses package/, regardless of whether software is detached.
  for (const path of ['pack.json', 'pack.lock', ...plan.modules.flatMap(m => m.files.map(f => `${m.source}/${f.path}`))]) {
    const source = `${packageRoot}/${path}`;
    await add(source); files.at(-1).path = `package/${path}`;
    files.at(-1).sourcePath = source;
  }
  for (const component of plan.pack.components) {
    const path = `programs/${component.id}`;
    if (!(await exists(join(directory, path)))) continue;
    await ordinaryPath(join(directory, path));
    directories.add(path);
    for (const entry of (await readdir(join(directory, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === 'tmp') continue;
      if (++entries > backupLimits.entries) throw fault('BACKUP_LIMIT', 'Instance tree exceeds the traversal bound');
      const next = path + '/' + entry.name; portablePath(next);
      const info = await lstat(join(directory, next));
      if (info.isSymbolicLink()) throw fault('BACKUP_PATH', 'Instance backup rejects links and reparse paths');
      if (info.isDirectory()) await visit(next); else if (info.isFile()) await add(next); else throw fault('BACKUP_PATH', 'Instance backup rejects special files');
    }
  }
  for (const path of ['hub/log', 'hub/blobs', 'hub/management.json']) {
    if (!(await exists(join(directory, path)))) continue;
    await ordinaryPath(join(directory, path));
    const info = await lstat(join(directory, path));
    if (info.isDirectory() && path !== 'hub/management.json') await visit(path);
    else if (info.isFile() && path === 'hub/management.json') await add(path);
    else throw fault('BACKUP_PATH', 'Unexpected Hub persistent state path');
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    directories: [...directories].sort((a, b) => a.localeCompare(b, 'en')) };
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw new Error('Backup file write failed'); offset += result.bytesWritten; }
}

/** Creates a private, bounded file snapshot only after confirmed Runtime stop. */
export async function backupInstance(options) {
  return withStoppedInstance(options, async (directory, stopped) => {
    const source = await exists(join(directory, 'detached.json')) ? 'detached-package' : 'package';
    const plan = await inspectPackage(join(directory, source), options);
    const destination = await ordinaryPath(options.destination, { allowMissing: true });
    if (within(directory, destination)) throw fault('BACKUP_PATH', 'Choose a backup destination outside the source instance');
    const contents = await persistentFiles(directory, plan, options.signal), { files, directories } = contents;
    const createdAt = new Date().toISOString();
    const header = { format: FORMAT, private: true, excludesGeneratedRuntimeFiles: true, mayIncludeApplicationSecrets: true, createdAt,
      sourceInstanceId: options.instanceId, platform: plan.lock.platform, hubVersion: plan.lock.hubVersion,
      pack: { id: plan.pack.id, version: plan.pack.version },
      consistency: stopped.status ? 'confirmed-stopped' : 'never-started',
      directories, files: files.map(({ sourcePath, ...file }) => file) };
    const encoded = Buffer.from(JSON.stringify(header), 'utf8');
    if (encoded.length > backupLimits.headerBytes) throw fault('BACKUP_LIMIT', 'Backup metadata exceeds 4 MiB');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await ordinaryPath(dirname(destination));
    const output = await open(destination, 'wx', 0o600); let complete = false;
    try {
      const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
      await writeAll(output, MAGIC); await writeAll(output, length); await writeAll(output, encoded);
      for (const file of files) {
        const actual = await streamHash(join(directory, file.sourcePath ?? file.path), options.signal, chunk => writeAll(output, chunk));
        if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw fault('BACKUP_CHANGED', 'Instance data changed during backup; no completed snapshot was produced');
      }
      const final = await persistentFiles(directory, plan, options.signal);
      if (JSON.stringify(final) !== JSON.stringify(contents)) throw fault('BACKUP_CHANGED', 'Instance file set changed during backup');
      await output.sync(); await output.close();
      const checked = await inspectBackup(destination, { signal: options.signal });
      complete = true;
      return { format: 'world-hub.backup-result/v1', destination, private: true, excludesGeneratedRuntimeFiles: true, mayIncludeApplicationSecrets: true,
        files: checked.backup.files, bytes: checked.backup.bytes, sha256: checked.sha256, createdAt, pack: header.pack };
    } finally {
      if (!complete) { await output.close().catch(() => {}); await ordinaryPath(destination); await unlink(destination); }
    }
  });
}

function validateHeader(header) {
  closed(header, ['format', 'private', 'excludesGeneratedRuntimeFiles', 'mayIncludeApplicationSecrets', 'createdAt', 'sourceInstanceId', 'platform', 'hubVersion', 'pack', 'consistency', 'directories', 'files'], 'backup');
  if (header.format !== FORMAT || header.private !== true || header.excludesGeneratedRuntimeFiles !== true || header.mayIncludeApplicationSecrets !== true
      || !['confirmed-stopped', 'never-started'].includes(header.consistency)
      || typeof header.createdAt !== 'string' || header.createdAt.length > 64 || !Number.isFinite(Date.parse(header.createdAt))) throw fault('BACKUP_INVALID', 'Unsupported private backup metadata');
  safeId(header.sourceInstanceId, 'backup source instance ID'); exactVersion(header.hubVersion, 'Hub version');
  closed(header.platform, ['os', 'arch'], 'platform');
  for (const value of Object.values(header.platform)) if (typeof value !== 'string' || !/^[a-z0-9]{1,32}$/.test(value)) throw fault('BACKUP_INVALID', 'Invalid backup platform');
  closed(header.pack, ['id', 'version'], 'pack'); safeId(header.pack.id); exactVersion(header.pack.version, 'pack version');
  if (!Array.isArray(header.files) || header.files.length < 3 || header.files.length > backupLimits.files) throw fault('BACKUP_LIMIT', 'Invalid backup file count');
  if (!Array.isArray(header.directories) || header.directories.length > backupLimits.entries) throw fault('BACKUP_LIMIT', 'Invalid backup directory count');
  const paths = new Set(); let bytes = 0;
  for (const file of header.files) {
    closed(file, ['path', 'bytes', 'sha256'], 'file'); portablePath(file.path);
    if (!/^(?:package\/|programs\/[a-z0-9][a-z0-9._-]{0,63}\/|hub\/(?:log\/|blobs\/|management\.json$))/.test(file.path)
        || /^programs\/[^/]+\/tmp(?:\/|$)/.test(file.path)) throw fault('BACKUP_PATH', 'Backup contains an excluded instance path');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > backupLimits.fileBytes || !SHA.test(file.sha256)) throw fault('BACKUP_LIMIT', 'Invalid backup file size or hash');
    if (paths.has(file.path.toLowerCase())) throw fault('BACKUP_PATH', 'Duplicate or case-colliding backup file path');
    paths.add(file.path.toLowerCase()); bytes += file.bytes;
    if (bytes > backupLimits.totalBytes) throw fault('BACKUP_LIMIT', 'Backup exceeds 512 MiB');
  }
  for (const path of paths) for (const prefix of path.split('/').slice(0, -1).map((_, i) => path.split('/').slice(0, i + 1).join('/')))
    if (paths.has(prefix)) throw fault('BACKUP_PATH', 'Backup file and directory paths overlap');
  const directories = new Set();
  for (const path of header.directories) {
    portablePath(path);
    if (!/^(?:programs\/[a-z0-9][a-z0-9._-]{0,63}(?:\/|$)|hub\/(?:log|blobs)(?:\/|$))/.test(path)
        || /^programs\/[^/]+\/tmp(?:\/|$)/.test(path) || directories.has(path.toLowerCase()))
      throw fault('BACKUP_PATH', 'Backup contains an excluded or duplicate directory path');
    directories.add(path.toLowerCase());
    for (let current = path.toLowerCase(); current; current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '')
      if (paths.has(current)) throw fault('BACKUP_PATH', 'Backup directory overlaps a file path');
  }
  if (!paths.has('package/pack.json') || !paths.has('package/pack.lock')) throw fault('BACKUP_INVALID', 'Backup is missing pack manifests');
  return bytes;
}
async function exactRead(handle, size, position) {
  const buffer = Buffer.allocUnsafe(size); let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset);
    if (!bytesRead) throw fault('BACKUP_INVALID', 'Truncated backup file'); offset += bytesRead;
  }
  return buffer;
}
async function readArchive(file, options = {}, visitor) {
  const path = await ordinaryPath(file), info = await lstat(path);
  if (!info.isFile() || info.size < MAGIC.length + 4 || info.size > MAGIC.length + 4 + backupLimits.headerBytes + backupLimits.totalBytes)
    throw fault('BACKUP_LIMIT', 'Expected an ordinary bounded instance backup file');
  const handle = await open(path, 'r'), entire = createHash('sha256');
  try {
    const prefix = await exactRead(handle, MAGIC.length + 4, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw fault('BACKUP_INVALID', 'Unsupported instance backup file format');
    const length = prefix.readUInt32BE(MAGIC.length);
    if (length < 2 || length > backupLimits.headerBytes) throw fault('BACKUP_LIMIT', 'Backup metadata exceeds its bound');
    const encoded = await exactRead(handle, length, prefix.length);
    let header;
    try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)); }
    catch { throw fault('BACKUP_INVALID', 'Invalid UTF-8 JSON backup metadata'); }
    const bytes = validateHeader(header); let position = prefix.length + length;
    if (position + bytes !== info.size) throw fault('BACKUP_INVALID', 'Backup payload size differs from its declared file set');
    entire.update(prefix); entire.update(encoded);
    const manifests = new Map();
    for (const item of header.files) {
      cancelled(options.signal);
      const digest = createHash('sha256'); let remaining = item.bytes;
      const capture = ['package/pack.json', 'package/pack.lock'].includes(item.path) || /^package\/.*\/module\.json$/.test(item.path);
      if (capture && item.bytes > 1024 * 1024) throw fault('BACKUP_LIMIT', 'Backup manifests exceed 1 MiB');
      const chunks = []; const sink = await visitor?.(item);
      try {
        while (remaining > 0) {
          cancelled(options.signal);
          const block = await exactRead(handle, Math.min(1024 * 1024, remaining), position);
          position += block.length; remaining -= block.length; digest.update(block); entire.update(block);
          if (capture) chunks.push(block); await sink?.write(block);
        }
        if (digest.digest('hex') !== item.sha256) throw fault('BACKUP_HASH', `Backup file content hash mismatch: ${item.path}`);
      } finally { await sink?.close(); }
      if (capture) {
        try { manifests.set(item.path, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { throw fault('BACKUP_INVALID', 'Invalid backup package manifest'); }
      }
    }
    const final = await handle.stat();
    if (final.size !== info.size || final.mtimeMs !== info.mtimeMs || final.ctimeMs !== info.ctimeMs) throw fault('BACKUP_CHANGED', 'Backup changed while being inspected');
    validateArchivedPackage(header, manifests);
    return { path, header, bytes, sha256: entire.digest('hex') };
  } finally { await handle.close(); }
}
function validateArchivedPackage(header, manifests) {
  const pack = manifests.get('package/pack.json'), lock = manifests.get('package/pack.lock');
  validatePack(pack);
  if (!lock || lock.format !== 'world-hub.pack-lock/v1' || lock.hubVersion !== header.hubVersion
      || JSON.stringify(lock.platform) !== JSON.stringify(header.platform) || lock.pack?.id !== pack.id || lock.pack?.version !== pack.version
      || header.pack.id !== pack.id || header.pack.version !== pack.version || !Array.isArray(lock.modules) || lock.modules.length < 1 || lock.modules.length > 32)
    throw fault('BACKUP_INVALID', 'Backup and package lock metadata disagree');
  const packFile = header.files.find(f => f.path === 'package/pack.json');
  if (lock.pack.sha256 !== packFile.sha256) throw fault('BACKUP_HASH', 'Backup pack manifest differs from its lock');
  const expected = new Set(['package/pack.json', 'package/pack.lock']);
  for (const module of lock.modules) {
    safeId(module.id); portablePath(module.source); exactVersion(module.version, 'module version');
    if (!Array.isArray(module.files) || !module.files.length || module.files.length > 4096) throw fault('BACKUP_INVALID', 'Invalid backup module file set');
    const manifest = manifests.get(`package/${module.source}/module.json`); validateModule(manifest);
    if (manifest.id !== module.id || manifest.version !== module.version) throw fault('BACKUP_INVALID', 'Backup module identity differs from its lock');
    for (const file of module.files) {
      const path = `package/${module.source}/${portablePath(file.path)}`;
      const actual = header.files.find(f => f.path === path);
      if (!actual || actual.sha256 !== file.sha256 || expected.has(path)) throw fault('BACKUP_HASH', 'Backup module content or file set differs from its lock');
      expected.add(path);
    }
  }
  if (header.files.some(f => f.path.startsWith('package/') && !expected.has(f.path))) throw fault('BACKUP_INVALID', 'Backup has unlocked package files');
  const ids = new Set(pack.components.map(c => c.id));
  if (header.files.some(f => f.path.startsWith('programs/') && !ids.has(f.path.split('/')[1]))) throw fault('BACKUP_INVALID', 'Backup contains state for an undeclared component');
  if (header.directories.some(path => path.startsWith('programs/') && !ids.has(path.split('/')[1]))) throw fault('BACKUP_INVALID', 'Backup contains a directory for an undeclared component');
}

/** Read-only inspection; verifies every payload hash and performs no module execution. */
export async function inspectBackup(file, options = {}) {
  const archive = await readArchive(file, options), current = await installedVersion(), incompatible = [];
  if (archive.header.platform.os !== process.platform || archive.header.platform.arch !== process.arch)
    incompatible.push(`Platform requires ${archive.header.platform.os}-${archive.header.platform.arch}; current ${process.platform}-${process.arch}`);
  if (archive.header.hubVersion !== current) incompatible.push(`Hub version requires ${archive.header.hubVersion}; installed ${current}`);
  const { files, directories, ...backup } = archive.header;
  return { format: 'world-hub.backup-inspection/v1', backup: { ...backup, files: files.length, directories: directories.length, bytes: archive.bytes },
    sha256: archive.sha256, compatible: incompatible.length === 0, incompatibilities: incompatible, private: true,
    excludesGeneratedRuntimeFiles: true, mayIncludeApplicationSecrets: true };
}

async function removeCreatedDirectory(path, parent) {
  const actual = await ordinaryPath(path);
  const intended = await ordinaryPath(parent);
  if (!within(intended, actual) || actual === intended || dirname(actual) !== intended) throw fault('BACKUP_PATH', 'Refusing cleanup outside the created instance directory');
  // Verify the entire created tree before recursive removal; do not follow links.
  async function check(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name); await ordinaryPath(child);
    const info = await lstat(child); if (info.isSymbolicLink()) throw fault('BACKUP_PATH', 'Restore cleanup encountered a link'); if (info.isDirectory()) await check(child);
  } }
  await check(actual); await rm(actual, { recursive: true, force: false });
}
/** Restores only into a new instance directory; generated identities/tokens are never copied. */
export async function restoreInstance(options) {
  safeId(options.instanceId, 'instance ID');
  const checked = await inspectBackup(options.backup, { signal: options.signal });
  if (!checked.compatible) throw fault('BACKUP_INCOMPATIBLE', checked.incompatibilities.join('; '));
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== checked.sha256)
    throw fault('BACKUP_CHANGED', 'Backup differs from the inspected restore plan');
  const stateDir = await ordinaryPath(instancePath(options.root, options.instanceId), { allowMissing: true });
  await mkdir(dirname(stateDir), { recursive: true, mode: 0o700 }); await ordinaryPath(dirname(stateDir));
  await mkdir(stateDir, { mode: 0o700 });
  let complete = false;
  try {
    const archive = await readArchive(options.backup, { signal: options.signal }, async file => {
      const destination = join(stateDir, portablePath(file.path));
      await ordinaryPath(destination, { allowMissing: true });
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const output = await open(destination, 'wx', 0o600);
      return { write: bytes => writeAll(output, bytes), close: () => output.close() };
    });
    if (archive.sha256 !== checked.sha256) throw fault('BACKUP_CHANGED', 'Backup changed after inspection; restored instance was discarded');
    for (const path of archive.header.directories) {
      const directory = join(stateDir, portablePath(path)); await ordinaryPath(directory, { allowMissing: true });
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const plan = await inspectPackage(join(stateDir, 'package'), options);
    await privateJson(join(stateDir, 'instance.json'), { format: 'world-hub.instance/v1', instanceId: options.instanceId,
      digest: plan.digest, importedAt: new Date().toISOString(), restoredFrom: { sha256: checked.sha256,
        sourceInstanceId: checked.backup.sourceInstanceId, createdAt: checked.backup.createdAt } }, { exclusive: true });
    complete = true;
    return { instanceId: options.instanceId, stateDir, digest: plan.digest, plan,
      restoredFrom: { sha256: checked.sha256, sourceInstanceId: checked.backup.sourceInstanceId, createdAt: checked.backup.createdAt }, startsModules: false };
  } finally { if (!complete) await removeCreatedDirectory(stateDir, dirname(stateDir)); }
}

/** Bounded disk usage observation. A live scan is explicitly not a consistent snapshot. */
export async function storageInstance(options) {
  const directory = await ordinaryPath(instancePath(options.root, options.instanceId));
  const groups = Object.fromEntries(['package', 'programs', 'hub', 'runs', 'control', 'other'].map(k => [k, { bytes: 0, files: 0 }]));
  let entries = 0, unstable = false;
  const visit = async (path, group) => {
    if (++entries > backupLimits.entries) throw fault('STORAGE_LIMIT', 'Instance storage scan exceeds its entry bound');
    cancelled(options.signal);
    let info;
    try { await ordinaryPath(path); info = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') { unstable = true; return; } throw error; }
    if (info.isSymbolicLink()) throw fault('BACKUP_PATH', 'Instance storage scan rejects links');
    if (info.isDirectory()) for (const item of await readdir(path)) await visit(join(path, item), group);
    else if (info.isFile()) { groups[group].bytes += info.size; groups[group].files++; }
    else throw fault('BACKUP_PATH', 'Instance storage scan rejects special files');
  };
  for (const entry of await readdir(directory)) {
    const group = ['package', 'programs', 'hub', 'runs'].includes(entry) ? entry : entry === 'detached-package' ? 'package'
      : ['instance.json', 'owner.lock', 'control.json', 'status.json', 'detached.json'].includes(entry) ? 'control' : 'other';
    await visit(join(directory, entry), group);
  }
  let consistency = 'live-or-unknown';
  if (!unstable && !(await exists(join(directory, 'owner.lock')))) {
    try { await confirmedStopped(directory, options.instanceId); consistency = 'stopped'; } catch {}
  }
  return { format: 'world-hub.instance-storage/v1', instanceId: options.instanceId, stateDir: directory, groups,
    bytes: Object.values(groups).reduce((sum, g) => sum + g.bytes, 0), files: Object.values(groups).reduce((sum, g) => sum + g.files, 0),
    consistency, observedAt: new Date().toISOString(), unstable, detached: await exists(join(directory, 'detached.json')) };
}

/** Uninstalls the active software path while retaining data and a private recovery copy. */
export async function detachInstance(options) {
  return withStoppedInstance(options, async directory => {
    if (await exists(join(directory, 'detached.json')) || await exists(join(directory, 'detached-package')))
      throw fault('INSTANCE_DETACHED', 'Instance software is already detached or recovery requires inspection');
    await ordinaryPath(join(directory, 'package'));
    await rename(join(directory, 'package'), join(directory, 'detached-package'));
    try { await privateJson(join(directory, 'detached.json'), { format: 'world-hub.detached-instance/v1', instanceId: options.instanceId,
      detachedAt: new Date().toISOString(), preservesData: true, softwareRetainedInQuarantine: true }, { exclusive: true }); }
    catch (error) { await rename(join(directory, 'detached-package'), join(directory, 'package')); throw error; }
    return { instanceId: options.instanceId, detached: true, preservesData: true, softwareRetainedInQuarantine: true };
  });
}

/** Rechecks current environment and sources before reattaching; still does not execute modules. */
export async function reattachInstance(options) {
  return withStoppedInstance(options, async (directory, stopped) => {
    const detached = await json(join(directory, 'detached.json'));
    if (detached.format !== 'world-hub.detached-instance/v1' || detached.instanceId !== options.instanceId)
      throw fault('INSTANCE_INVALID', 'Detached instance metadata is invalid');
    if (await exists(join(directory, 'package'))) throw fault('INSTANCE_INVALID', 'Active package already exists');
    const plan = await inspectPackage(join(directory, 'detached-package'), options);
    if (options.trust !== undefined && options.trust !== plan.digest) throw fault('REVIEW_CHANGED', 'Detached software differs from the reviewed content and environment');
    await rename(join(directory, 'detached-package'), join(directory, 'package'));
    try {
      const checked = await inspectPackage(join(directory, 'package'), options);
      if (checked.digest !== plan.digest) throw fault('REVIEW_CHANGED', 'Detached package changed while reattaching');
      await privateJson(join(directory, 'instance.json'), { ...stopped.identity, digest: checked.digest, reattachedAt: new Date().toISOString() });
      await unlink(join(directory, 'detached.json'));
      return { instanceId: options.instanceId, stateDir: directory, digest: checked.digest, plan: checked, detached: false, startsModules: false };
    } catch (error) { await rename(join(directory, 'package'), join(directory, 'detached-package')); throw error; }
  });
}
