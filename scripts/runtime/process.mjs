import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { filteredEnv } from './package.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function tail(text, bound = 65536) { const bytes = Buffer.from(text); return bytes.length <= bound ? text : bytes.subarray(bytes.length - bound).toString('utf8'); }
export function ownProcess(executable, argv, { cwd, temporary, secrets, onFailure, onEvent, signal } = {}) {
  const child = spawn(executable, argv, { cwd, env: filteredEnv(executable, temporary), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const handle = { child, pid: child.pid, exit: null, ready: null, messages: [], stdout: '', stderr: '', truncated: false, stopping: false };
  let closeResolve;
  handle.closed = new Promise(resolve => { closeResolve = resolve; });
  const redact = value => (secrets ?? []).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
  const record = (stream, value) => {
    const text = redact(handle[stream] + value);
    if (Buffer.byteLength(text) > 65536) handle.truncated = true;
    handle[stream] = tail(text);
  };
  let pending = ''; const decoder = new StringDecoder('utf8');
  child.stdout.on('data', bytes => {
    const value = decoder.write(bytes); record('stdout', value); pending += value;
    // A bounded line parser protects the supervisor even from trusted-code bugs.
    if (Buffer.byteLength(pending) > 131072 && !pending.includes('\n')) {
      pending = ''; onFailure?.(new Error(`Module ${handle.pid} stdout line exceeds 128 KiB`)); return;
    }
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > 131072) { onFailure?.(new Error(`Module ${handle.pid} stdout line exceeds 128 KiB`)); continue; }
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      if (event.event === 'ready' || event.event === 'module-ready') handle.ready = event;
      if (['ready', 'module-ready', 'module-health'].includes(event.event)) {
        handle.messages.push(event); if (handle.messages.length > 128) handle.messages.shift();
      }
      onEvent?.(event);
    }
  });
  child.stderr.on('data', bytes => record('stderr', bytes.toString('utf8')));
  child.stdin.on('error', () => {});
  child.once('error', error => { handle.error = error.message; onFailure?.(error); });
  child.once('close', (code, signal) => {
    handle.exit = { code, signal, at: new Date().toISOString(), ...(handle.error ? { error: handle.error } : {}) };
    closeResolve(handle.exit);
    if (!handle.stopping) onFailure?.(new Error(`Owned program ${handle.pid ?? executable} exited unexpectedly (${code ?? signal})`));
  });
  handle.send = value => { if (!handle.exit && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
  handle.waitFor = async (predicate, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) throw new Error('Runtime startup or health observation aborted');
      const found = handle.ready && predicate(handle.ready) ? handle.ready : handle.messages.find(predicate); if (found) return found;
      if (handle.exit || handle.error) throw new Error(`Owned program exited before readiness: ${handle.error ?? JSON.stringify(handle.exit)}; ${handle.stderr}`);
      if (Date.now() >= end) throw new Error(`Owned program readiness/health timeout (${timeoutMs} ms); ${handle.stderr}`);
      await delay(20);
    }
  };
  handle.stop = async timeoutMs => {
    handle.stopping = true;
    if (handle.exit) return handle.exit;
    handle.send({ command: 'stop' });
    const exited = await Promise.race([handle.closed.then(() => true), delay(timeoutMs).then(() => false)]);
    if (!exited) {
      handle.forced = true;
      child.kill('SIGKILL');
      const closed = await Promise.race([handle.closed.then(() => true), delay(5000).then(() => false)]);
      if (!closed) throw new Error(`Could not confirm owned program ${handle.pid} exited after force-stop`);
    }
    return handle.exit;
  };
  return handle;
}
