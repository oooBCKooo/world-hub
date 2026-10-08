import { spawn } from 'node:child_process';

// Launcher-side lifecycle, independent of hub traffic and SDK requests.
export async function startOwnedProgram(script, { args = [], env = process.env, cwd = process.cwd(), ipc = true, timeoutMs = 15000 } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  const record = { child, lines: [], stderr: '', exited: null, ready: null };
  let buffer = '', resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error(`program did not become ready: ${script}\n${record.stderr}`)), timeoutMs);
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => {
    record.exited = { code, signal }; resolve(record.exited);
    rejectReady(new Error(`program exited before ready (${code ?? signal}): ${script}\n${record.stderr}`));
  }));
  child.once('error', (err) => rejectReady(err));
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1024 * 1024) { rejectReady(new Error('program output line exceeds launcher limit')); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (record.lines.length < 1000) record.lines.push(line);
      try { const event = JSON.parse(line); if (event.event === 'ready') { record.ready = event; resolveReady(event); } } catch { /* Human diagnostics are not a ready receipt. */ }
    }
  });
  child.stderr.on('data', (chunk) => { record.stderr = (record.stderr + chunk.toString('utf8')).slice(-65536); });
  record.stop = async () => {
    if (record.exited) return record.exited;
    if (ipc && child.connected) { try { child.send({ type: 'stop' }); } catch { child.kill(); } }
    else child.kill('SIGTERM');
    let killTimer;
    try { return await Promise.race([exit, new Promise((resolve) => { killTimer = setTimeout(() => { child.kill('SIGKILL'); resolve({ forced: true }); }, 5000); })]); }
    finally { clearTimeout(killTimer); }
  };
  try { await ready; return record; }
  catch (err) { await record.stop(); throw err; }
  finally { clearTimeout(timer); }
}
