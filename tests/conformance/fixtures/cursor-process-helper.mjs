import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function cursorWorker(options) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./bridge-cursor-worker.mjs', import.meta.url))], {
    env: { ...process.env, CURSOR_WORKER_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events = []; const waiters = []; let stderr = ''; let nextToken = 0; let exited = false;
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.resume();
  child.on('exit', () => { exited = true; });
  child.on('message', (event) => {
    events.push(event);
    for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(event); }
  });
  const wait = (match) => {
    const existing = events.find(match); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`cursor worker ${child.pid} timeout; stderr=${stderr}; events=${JSON.stringify(events)}`)); }, 8000) };
      waiters.push(waiter);
    });
  };
  const command = async (fields) => {
    const token = ++nextToken; const result = wait((event) => event.event === 'result' && event.token === token);
    child.send({ ...fields, token }); return result;
  };
  const worker = { child, events, wait, command, async close() {
    if (exited) return;
    if (child.connected) await command({ type: 'close' });
    if (!exited) await new Promise((resolve) => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  } };
  try { worker.ready = await wait((event) => ['ready', 'fatal'].includes(event.event)); if (worker.ready.event === 'fatal') throw new Error(worker.ready.message); return worker; }
  catch (error) { await worker.close(); throw error; }
}
