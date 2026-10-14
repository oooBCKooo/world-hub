// Launcher deployment adapter for an independent native application.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfiguration } from './config.mjs';
import { startHost } from './host.mjs';
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let host, desktop, stopped = false, ready = false, closing;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const stop = () => closing ??= (async () => {
  stopped = true; ready = false;
  if (desktop && desktop.exitCode === null && desktop.signalCode === null) {
    if (desktop.connected) desktop.send({ type: 'soft-ui.stop' });
    await new Promise(resolve => { desktop.once('close', resolve); });
  }
  await host?.close(); input.close();
})();
input.on('line', line => { if (line.length > 65536) return; let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.command === 'stop') void stop();
  if (frame.command === 'health' && typeof frame.id === 'string') emit({ event: 'module-health', id: frame.id, ready: ready && !stopped && host?.ready() === true }); });
input.on('close', () => { if (!stopped) void stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
try {
  const config = await readConfiguration();
  if (typeof config.deployment?.directory !== 'string') throw new Error('Prepare the reviewed desktop environment through Launcher.');
  const requireEnvironment = createRequire(join(config.deployment.directory, 'package.json'));
  const electron = requireEnvironment('electron');
  host = await startHost(config, code => emit({ event: 'module-diagnostic', code }));
  if (stopped) await stop();
  else {
    desktop = spawn(electron, [join(dirname(fileURLToPath(import.meta.url)), 'desktop', 'main.cjs'), '--ui-state-dir', join(config.stateDir, 'desktop')], {
      cwd: config.stateDir, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    desktop.stdout.on('data', bytes => process.stderr.write(bytes)); desktop.stderr.pipe(process.stderr, { end: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop window startup timed out.')), 20000);
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      desktop.once('error', finish(reject));
      desktop.once('exit', finish(() => reject(new Error('Desktop exited before its native interface was ready.'))));
      desktop.on('message', message => { if (message?.type === 'soft-ui.ready') finish(resolve)(); if (message?.type === 'soft-ui.failed') finish(reject)(new Error('Desktop startup failed.')); });
      desktop.once('spawn', () => desktop.send({ type: 'soft-ui.initialize', origin: host.origin, token: host.token }));
    });
    desktop.on('close', () => { if (!stopped) { ready = false; emit({ event: 'module-diagnostic', code: 'DESKTOP_CLOSED' }); void stop(); } });
    if (!stopped) { ready = true; emit({ event: 'module-ready', nativeInterface: true }); }
  }
} catch (error) { emit({ event: 'module-diagnostic', code: 'DESKTOP_START_FAILED', message: error.message }); process.exitCode = 1; await stop(); }
