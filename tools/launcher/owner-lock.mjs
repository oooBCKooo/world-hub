// Launcher ownership is local deployment coordination, never Hub authority.
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ordinaryPath, readBounded } from '../../scripts/runtime/paths.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (code, message, inspection) => Object.assign(new Error(message), { code, ...(inspection ? { inspection } : {}) });
const delay = ms => new Promise(yes => setTimeout(yes, ms));
const recoverySupported = ['win32', 'linux'].includes(process.platform);
const quotedRoot = root => process.platform === 'win32' ? "'" + root.replaceAll("'", "''") + "'" : "'" + root.replaceAll("'", "'\\''") + "'";
const command = root => `world-hub ui --inspect-lock --root ${quotedRoot(root)}`;
export const defaultLauncherRoot = () => join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'WorldHub', 'launcher');

export function probeLauncherPid(pid, probe = process.kill.bind(process)) {
  try { probe(pid, 0); return 'live-or-reused'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

async function rootPath(root, create = false) {
  const checked = await ordinaryPath(resolve(root), { allowMissing: true });
  if (create) { await mkdir(checked, { recursive: true, mode: 0o700 }); return ordinaryPath(checked); }
  return checked;
}

async function inspect(root, probe) {
  const lockPath = join(root, 'launcher-owner.lock');
  const result = { format: 'world-hub.launcher-owner-inspection/v1', root, lockPath, state: 'unknown', recoveryAllowed: false,
    automaticRecoverySupported: recoverySupported,
    childrenPolicy: 'Existing Runtime and Hub processes are not adopted or signalled; their instance locks and controls remain unchanged.' };
  let bytes;
  try { bytes = await readBounded(lockPath, 4096); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...result, state: 'absent', reason: 'No Launcher owner file exists.' };
    return { ...result, reason: 'Owner file is unreadable, unsafe or exceeds its metadata bound; automatic removal is refused.' };
  }
  let owner;
  try { owner = JSON.parse(bytes.toString('utf8')); } catch {}
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) || typeof owner.nonce !== 'string'
    || !owner.nonce || owner.nonce.length > 128 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647) {
    return { ...result, reason: 'Owner metadata is incomplete or invalid; a writer may still be creating it. Automatic removal is refused.' };
  }
  const state = probeLauncherPid(owner.pid, probe);
  return { ...result, state, recoveryAllowed: state === 'dead' && recoverySupported, owner: { pid: owner.pid, nonce: owner.nonce,
    ...(typeof owner.startedAt === 'string' ? { startedAt: owner.startedAt.slice(0, 128) } : {}) },
    reason: state === 'dead' ? 'The operating system reports ESRCH for this recorded PID.' + (recoverySupported ? '' : ' Automatic recovery is unavailable on this platform; metadata is retained.')
      : state === 'live-or-reused' ? 'This PID currently exists. It may be the owner or a reused PID; no process will be signalled and the file is retained.'
        : 'Process existence could not be established (including permission denial); the file is retained.',
    fingerprint: hash(bytes) };
}

export async function inspectLauncherOwner(root) { return inspect(await rootPath(root)); }

// The guard is kernel-owned: crashes retire it without another stale filesystem
// lock. Every new owner holds it through metadata creation and confirmed cleanup.
// Older Launchers do not hold it, so their existing live/unknown PID also blocks.
async function guard(root) {
  if (!recoverySupported) return null;
  const key = hash(process.platform === 'win32' ? root.toLowerCase() : root);
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\world-hub-launcher-${key}` : '\0world-hub-launcher-' + key;
  const server = createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  try {
    await new Promise((yes, no) => {
      server.once('error', no);
      server.listen({ path, exclusive: true }, () => { server.removeListener('error', no); yes(); });
    });
  } catch (error) {
    if (['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code)) throw failure('LAUNCHER_LOCKED',
      `This Launcher root is owned or its exclusive guard is unavailable. No owner file was changed. Inspect with: ${command(root)}`);
    throw error;
  }
  server.on('error', () => {});
  return () => new Promise(yes => server.close(yes));
}

async function replace(file, temporary) {
  const deadline = Date.now() + 4000;
  while (true) {
    try { await rename(temporary, file); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || Date.now() >= deadline) throw error;
      await delay(50);
    }
  }
}

async function retainCurrent(root, observed) {
  const current = await inspect(root);
  if (current.state !== 'dead' || current.fingerprint !== observed.fingerprint) throw failure('LAUNCHER_LOCK_CHANGED',
    `Owner evidence changed during recovery. No owner file was removed. Inspect with: ${command(root)}`, current);
}

function blocked(root, inspection) {
  return failure('LAUNCHER_LOCKED', `${inspection.reason} Inspect with: ${command(root)}. `
    + 'Only a valid owner whose PID is explicitly absent can be recovered; Runtime locks and existing processes are preserved.', inspection);
}

export async function acquireLauncherOwner(requestedRoot) {
  const root = await rootPath(requestedRoot, true), releaseGuard = await guard(root);
  const path = join(root, 'launcher-owner.lock'), nonce = randomUUID();
  const temporary = path + '.' + nonce + '.tmp';
  let recovered = null, installed = false;
  try {
    const observed = await inspect(root);
    if (observed.state !== 'absent') {
      if (!releaseGuard || observed.state !== 'dead') throw blocked(root, observed);
      recovered = observed;
    }
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ format: 'world-hub.launcher-owner/v2', nonce, pid: process.pid, startedAt: new Date().toISOString() }) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    if (recovered) {
      await retainCurrent(root, recovered);
      // Keep the old file present until complete new metadata atomically replaces
      // it. An old-version wx acquisition cannot enter a delete/create gap.
      await replace(path, temporary);
      installed = true;
    } else {
      // Hard-link installation is atomic and exclusive; no partial main file is
      // visible, and it cannot overwrite a concurrently created legacy owner.
      try { await link(temporary, path); }
      catch (error) { if (error.code === 'EEXIST') throw blocked(root, await inspect(root)); throw error; }
      installed = true;
      await unlink(temporary);
    }
  } catch (error) {
    if (installed) try { if ((await inspect(root)).owner?.nonce === nonce) await unlink(path); } catch (cleanup) { error.cleanupError = cleanup.message; }
    try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.cleanupError = cleanup.message; }
    await releaseGuard?.(); throw error;
  }
  let released = false;
  return { root, path, nonce, recovered,
    async release() {
      if (released) return;
      const current = await inspect(root);
      if (current.owner?.nonce !== nonce) throw failure('LAUNCHER_LOCK_CHANGED', 'Launcher owner metadata changed; the exclusive guard is retained for inspection.', current);
      await unlink(path); released = true; await releaseGuard?.();
    } };
}

// Explicit cleanup obeys exactly the same evidence and guard rules as startup.
// No --force path exists; this does not remove instance owners or kill any PID.
export async function cleanLauncherOwner(requestedRoot) {
  const root = await rootPath(requestedRoot), releaseGuard = await guard(root);
  try {
    const inspection = await inspect(root);
    if (inspection.state === 'absent') return { ...inspection, cleaned: false };
    if (!releaseGuard || inspection.state !== 'dead') throw blocked(root, inspection);
    await retainCurrent(root, inspection); await unlink(inspection.lockPath);
    return { ...inspection, cleaned: true };
  } finally { await releaseGuard?.(); }
}
