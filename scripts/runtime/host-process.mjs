// Optional trusted-local deployment lifecycle. This is not an OS sandbox.
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { ownProcess } from './process.mjs';
import { assertHostedPlatform } from './host-profile.mjs';
const directory = dirname(fileURLToPath(import.meta.url)), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function quote(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
export async function ownHostedProcess(executable, argv, options = {}) {
  if (options.ownedChildren === false) return ownProcess(executable, argv, options);
  assertHostedPlatform({ permissions: { processes: 'owned-children' } });
  if (!isAbsolute(executable) || !Array.isArray(argv) || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw failure('HOST_COMMAND_INVALID', 'A reviewed absolute executable and literal argument array are required.');
  let programExited = false, retired = false, ownerReady = false;
  const onFailure = issue => { if (ownerReady && !retired && handle) handle.cleanupIncomplete = true; options.onFailure?.(issue); };
  const onEvent = frame => {
    if (frame.event === 'host-owner-ready') { ownerReady = true; handle.hostOwner = frame; }
    if (frame.event === 'host-program-exit') { programExited = true; handle.programExit = frame; if (!handle.stopping) { handle.error = 'Owned hosted program exited; its tree owner is retained for cleanup.'; options.onFailure?.(failure('HOST_PROGRAM_EXITED', handle.error)); } }
    if (frame.event === 'host-tree-retired') retired = true;
    options.onEvent?.(frame);
  };
  let handle;
  if (process.platform === 'win32') {
    // Fixed system executable, no PATH lookup or shell-built business command.
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); await access(powershell);
    const configuration = Buffer.from(JSON.stringify({ executable, command: [executable, ...argv].map(quote).join(' '), cwd: options.cwd })).toString('base64');
    handle = ownProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'host-owner-windows.ps1'), configuration], { ...options, onEvent, onFailure });
  } else {
    const configuration = Buffer.from(JSON.stringify({ executable, args: argv, cwd: options.cwd })).toString('base64');
    handle = ownProcess(process.execPath, [join(directory, 'host-owner-linux.mjs'), configuration], { ...options, detached: true, onEvent, onFailure });
  }
  handle.hostedLifecycle = { profile: process.platform === 'win32' ? 'windows-job/v1' : 'linux-owned-group/v1', sandbox: false,
    boundary: process.platform === 'linux' ? 'current-owned-group; descendants escaping with setsid are outside this profile' : 'current-owned-job; no breakaway granted' };
  const originalWait = handle.waitFor;
  handle.waitFor = (predicate, timeout) => originalWait(frame => predicate(frame), timeout);
  handle.stop = async timeoutMs => {
    handle.stopping = true; handle.send({ command: 'stop' }); const deadline = Date.now() + (timeoutMs ?? 5000);
    while (!programExited && !handle.exit && Date.now() < deadline) await delay(20);
    handle.forced = !programExited; handle.send({ command: 'retire-host-tree' });
    const closed = await Promise.race([handle.closed.then(() => true), delay(6000).then(() => false)]);
    if (!closed) {
      if (process.platform === 'linux') { await handle.killOwnedGroup(); await Promise.race([handle.closed, delay(5000)]); }
      else if (!ownerReady) { handle.child.kill('SIGKILL'); await Promise.race([handle.closed, delay(5000)]); }
      else { handle.cleanupIncomplete = true; throw failure('HOST_CLEANUP_INCOMPLETE', 'Current owned Job retirement cannot be confirmed; its live owner is retained.'); }
    }
    if (process.platform === 'linux') {
      const end = Date.now() + 5000; while (!(await handle.groupStopped())) { if (Date.now() >= end) { handle.cleanupIncomplete = true; throw failure('HOST_CLEANUP_INCOMPLETE', 'Owned group still has live descendants.'); } await delay(20); } retired = true;
    }
    if (!handle.exit || ownerReady && !retired) { handle.cleanupIncomplete = true; throw failure('HOST_CLEANUP_INCOMPLETE', 'Hosted tree exit remains unconfirmed.'); }
    handle.hostedLifecycle.retired = true; delete handle.cleanupIncomplete; return handle.exit;
  };
  const startupDeadline = Date.now() + 30000;
  while (!ownerReady) {
    if (options.signal?.aborted || handle.exit || handle.error || Date.now() >= startupDeadline) {
      const issue = failure('HOST_OWNER_START_FAILED', `The trusted child-process owner did not initialize. ${handle.stderr} ${handle.stdout}`);
      try { await handle.stop(1000); } catch (cleanup) { throw Object.assign(cleanup, { cause: issue }); }
      throw issue;
    }
    await delay(20);
  }
  return handle;
}
