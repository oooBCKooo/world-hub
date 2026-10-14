// Trusted, continuously live session leader. Business code is always a child.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const config = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const text = readFileSync('/proc/self/stat', 'utf8'), stat = text.slice(text.lastIndexOf(') ') + 2).split(/\s+/);
if (process.platform !== 'linux' || Number(stat[2]) !== process.pid || Number(stat[3]) !== process.pid) throw new Error('Owned Host must lead its own Linux group and session');
const child = spawn(config.executable, config.args, { cwd: config.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false }); child.stdin.on('error', () => {});
child.once('spawn', () => emit({ event: 'host-owner-ready', programPid: child.pid, profile: 'linux-owned-group/v1' }));
child.once('error', error => emit({ event: 'host-program-exit', error: error.code ?? 'SPAWN_FAILED' }));
child.once('close', (code, signal) => emit({ event: 'host-program-exit', code, signal }));
setInterval(() => {}, 1000);
const retire = () => process.kill(-process.pid, 'SIGKILL');
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (Buffer.byteLength(line) > 131072) return retire(); let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.command === 'retire-host-tree') return retire(); if (!child.stdin.destroyed) child.stdin.write(line + '\n'); });
input.on('close', retire); process.on('SIGINT', retire); process.on('SIGTERM', retire);
for (const stream of [process.stdout, process.stderr, process.stdin, child.stdout, child.stderr]) stream.on('error', retire);
