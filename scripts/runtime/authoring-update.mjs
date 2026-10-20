// Explicit source authoring transaction. Hub traffic and running deployments
// are outside this helper; the caller must guard its managed process registry.
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { derivePackage, inspectAuthoring } from './authoring.mjs';
import { validatePack } from './package.mjs';
import { ordinaryPath, readBounded } from './paths.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function cancelled(options) {
  if (options.signal?.aborted) throw options.signal.reason ?? fault('SOURCE_UPDATE_CANCELLED', 'Source update cancelled.');
}
export function compareCompositionVersions(first, second) {
  const parseVersion = value => {
    const [core, ...prerelease] = value.split('-');
    return { core: core.split('.').map(BigInt), prerelease: prerelease.join('-').split('.').filter(Boolean) };
  };
  const a = parseVersion(first), b = parseVersion(second);
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index], right = b.prerelease[index];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const numericLeft = /^\d+$/.test(left), numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) {
      if (BigInt(left) === BigInt(right)) continue;
      return BigInt(left) > BigInt(right) ? 1 : -1;
    }
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}
async function absent(file) {
  try { await lstat(file); return false; }
  catch (issue) { if (issue.code === 'ENOENT') return true; throw issue; }
}
async function sourcePath(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw fault('SOURCE_UPDATE_PATH', 'Select an ordinary source pack directory.');
  const source = await ordinaryPath(directory);
  if (!(await lstat(source)).isDirectory() || same(source, parse(source).root)) throw fault('SOURCE_UPDATE_PATH', 'A filesystem root or ordinary file cannot be replaced as a source pack.');
  // Runtime roots have their own journals and identity lifecycle. Moving those
  // directories is never a source authoring operation.
  for (const marker of ['instance.json', 'owner.lock', 'control.json', 'registry.json', 'launcher-paths.json']) {
    if (!await absent(join(source, marker))) throw fault('SOURCE_UPDATE_RUNTIME_DIRECTORY', 'Select the source pack itself, outside a Runtime or Launcher data root.');
  }
  // A package nested inside another deployment remains owned by that Runtime,
  // even when it belongs to another Launcher or an offline installation.
  // Guard ancestors as well as this manager's known root before moving code.
  for (let ancestor=dirname(source); ; ancestor=dirname(ancestor)) {
    for (const marker of ['instance.json','owner.lock','control.json'])
      if (!await absent(join(ancestor,marker))) throw fault('SOURCE_UPDATE_RUNTIME_DIRECTORY','This source belongs to a managed Runtime instance. Use its reviewed instance upgrade workflow.');
    const registry=join(ancestor,'registry.json');
    if (!await absent(registry)) {
      let data;
      try { data=JSON.parse((await readBounded(registry)).toString()); }
      catch (issue) { if(issue.code!=='ENOENT' && !(issue instanceof SyntaxError))throw issue; }
      if(data?.format==='world-hub.launcher-local-programs/v1')throw fault('SOURCE_UPDATE_RUNTIME_DIRECTORY','This source belongs to registered local programs. Use the local Hub update workflow.');
    }
    if (same(ancestor,parse(ancestor).root)) break;
  }
  return source;
}

export async function updateSourcePackage(directory, options = {}) {
  if (typeof options.assertUnused !== 'function') throw fault('SOURCE_UPDATE_GUARD_REQUIRED', 'A managed-runtime ownership guard is required before updating source.');
  if (!/^[a-f0-9]{64}$/.test(options.expectedRevision ?? '')) throw fault('SOURCE_UPDATE_REVIEW_REQUIRED', 'Inspect the current source and supply its exact reviewed revision.');
  if (options.redistributionAcknowledged !== true) throw fault('SOURCE_UPDATE_REVIEW_REQUIRED', 'Review module licenses and acknowledge redistribution rights before updating source.');
  validatePack(options.pack);
  const source = await sourcePath(directory), parent = dirname(source);
  if (options.destination !== undefined && !same(resolve(options.destination), source)) throw fault('SOURCE_UPDATE_PATH', 'Updating a source pack keeps its original directory.');
  await options.assertUnused(source); cancelled(options);
  const original = await inspectAuthoring(source, options);
  if (original.revision !== options.expectedRevision) throw fault('SOURCE_UPDATE_REVISION_CHANGED', 'Source revision changed after review; inspect it again before updating.');
  if (options.pack.id !== original.pack.id) throw fault('SOURCE_UPDATE_ID_CHANGED', 'Updating the original source must keep its pack ID. Save a new pack for another ID.');
  if (compareCompositionVersions(options.pack.version, original.pack.version) <= 0) throw fault('SOURCE_UPDATE_VERSION_REQUIRED', 'Updating the original source requires a strictly newer composition version.');
  const nonce = randomUUID(), stem = basename(source).slice(0, 40);
  const staging = join(parent, `.${stem}.update-${nonce}`);
  const previousContainer = join(parent, `.${stem}.previous-${nonce}`);
  const previousDirectory = join(previousContainer, 'package');
  const lockFile = join(parent, `.${stem}.source-update.lock`);
  for (const target of [staging, previousContainer, lockFile]) {
    const checked = await ordinaryPath(target, { allowMissing: true });
    if (!same(dirname(checked), parent)) throw fault('SOURCE_UPDATE_PATH', 'Transaction paths must remain in the source parent directory.');
  }
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (issue) {
    if (issue.code === 'EEXIST') throw fault('SOURCE_UPDATE_BUSY', 'Another source update owns this directory; retain its transaction lock until that operation is resolved.');
    throw issue;
  }
  let movedOriginal = false, installed = false;
  try {
    await lock.writeFile(JSON.stringify({ nonce, directory: source, staging, previousDirectory }) + '\n');
    await lock.close(); lock = null;
    const derived = await derivePackage(source, { ...options, destination: staging, expectedRevision: original.revision });
    // Recheck bytes, environment, and both sides before changing the stable
    // path. Staging contains only the reviewed package, never runtime data.
    const candidate = await inspectAuthoring(staging, options);
    if (candidate.revision !== derived.revision) throw fault('SOURCE_UPDATE_STAGING_CHANGED', 'Staged package changed after generation; retain it for inspection.');
    const current = await inspectAuthoring(source, options);
    if (current.revision !== original.revision) throw fault('SOURCE_UPDATE_REVISION_CHANGED', 'Source changed while preparing the update; the original directory was retained.');
    if (!same(await sourcePath(source), source)) throw fault('SOURCE_UPDATE_PATH', 'Source directory changed during preparation.');
    await options.assertUnused(source); cancelled(options);
    const guarded = await inspectAuthoring(source, options);
    if (guarded.revision !== original.revision) throw fault('SOURCE_UPDATE_REVISION_CHANGED', 'Source changed during the final ownership check; the original directory was retained.');
    if (!same(await ordinaryPath(staging), staging)) throw fault('SOURCE_UPDATE_PATH', 'Staged source directory changed during preparation.');
    await mkdir(previousContainer, { mode: 0o700 });
    await rename(source, previousDirectory); movedOriginal = true;
    try { await rename(staging, source); installed = true; }
    catch (issue) {
      // Never overwrite an independently recreated path during recovery.
      if (await absent(source)) {
        try { await rename(previousDirectory, source); movedOriginal = false; }
        catch (recovery) { issue.rollbackError = { code: recovery.code, message: recovery.message }; }
      } else issue.rollbackError = { code: 'SOURCE_UPDATE_PATH_OCCUPIED', message: 'The source path was recreated; the previous tree remains at previousDirectory.' };
      throw issue;
    }
    // Once the swap commits, finish its validation even if cancellation arrives;
    // report the stable installed result instead of an ambiguous cancelled save.
    const result = await inspectAuthoring(source, { ...options, signal: undefined });
    if (result.revision !== candidate.revision) throw fault('SOURCE_UPDATE_INSTALLED_CHANGED', 'Installed source differs from its reviewed staging tree; retain both directories for inspection.');
    return { ...result, directory: source, version: result.pack.version, previousDirectory, startsModules: false, updatedOriginal: true };
  } catch (issue) {
    issue.sourceDirectory = source;
    issue.incompleteDestination ??= installed ? source : staging;
    if (movedOriginal) issue.previousDirectory = previousDirectory;
    throw issue;
  } finally {
    await lock?.close();
    // Only remove this helper's own lock receipt. Source and staging trees are
    // retained on failure; no user tree is recursively deleted or copied back.
    try { if (JSON.parse((await readBounded(lockFile)).toString()).nonce === nonce) await unlink(lockFile); }
    catch (issue) { if (issue.code !== 'ENOENT') throw issue; }
  }
}
