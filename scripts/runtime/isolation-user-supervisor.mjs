// Trusted existing-user process-group owner. No business imports, code lookup,
// shell, account creation or permission change. The non-root program is a child,
// so its exit cannot retire the privileged live group leader before cleanup.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const configuration = JSON.parse(process.argv[2]);
const fields = readFileSync('/proc/self/stat', 'utf8'); const row = fields.slice(fields.lastIndexOf(') ') + 2).trim().split(/\s+/);
if (process.platform !== 'linux' || process.getuid() !== 0 || Number(row[2]) !== process.pid || Number(row[3]) !== process.pid) throw new Error('Existing-user supervisor must own its current Linux process group');
const child = spawn(configuration.executable, configuration.args, { cwd: configuration.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: configuration.env });
let stopping = false, stopped = false;
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false }); child.stdin.on('error', () => {});
child.once('error', error => { emit({ event: 'existing-user-child-exit', code: null, error: error.code ?? 'SPAWN_FAILED' }); stopped = true; });
child.once('close', (code, signal) => { stopped = true; emit({ event: stopping ? 'existing-user-child-stopped' : 'existing-user-child-exit', code, signal }); });
// Keep the exact current leader alive even if the program has already exited.
const held = setInterval(() => {}, 1000);
const retire = () => { clearInterval(held); process.kill(-process.pid, 'SIGKILL'); };
for (const stream of [child.stdout, child.stderr, process.stdout, process.stderr, process.stdin]) stream.on('error', retire);
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (Buffer.byteLength(line) > 131072) return retire();
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame?.command === 'retire-existing-user-group') return retire();
  if (frame?.command === 'stop') { stopping = true; if (stopped) emit({ event: 'existing-user-child-stopped', alreadyClosed: true }); }
  if (!stopped && !child.stdin.destroyed) child.stdin.write(line + '\n');
});
input.on('close', retire); process.on('SIGTERM', retire); process.on('SIGINT', retire);
