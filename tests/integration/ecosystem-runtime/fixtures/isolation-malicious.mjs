// Deliberately hostile external fixture; no host-side execution of this file.
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { Bridge } from '#bridge';
const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
const deniedRead = async path => { try { await readFile(path); return false; } catch (error) { return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code); } };
const deniedWrite = async path => { try { await writeFile(path, 'unauthorized'); return false; } catch (error) { return ['EROFS', 'EACCES', 'EPERM', 'ENOENT'].includes(error.code); } };
const deniedConnect = (host, port) => new Promise(resolve => {
  const socket = createConnection({ host, port }); let settled = false;
  const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
  socket.once('connect', () => finish(false)); socket.once('error', () => finish(true)); socket.setTimeout(2000, () => finish(true));
});
const controls = await readFile('/proc/self/status', 'utf8');
const child = spawnSync('/usr/local/bin/node', ['-e', 'process.stdout.write("forbidden child ran")'], { timeout: 2000, encoding: 'utf8' });
const result = {
  hostPrivateDenied: (await Promise.all(config.settings.hostPrivatePaths.map(deniedRead))).every(Boolean),
  otherInstanceDenied: (await Promise.all(config.settings.otherInstancePaths.map(deniedRead))).every(Boolean),
  sourceWriteDenied: await deniedWrite('/source/bridge-kit.mjs'), configWriteDenied: await deniedWrite('/configuration.json'),
  rootWriteDenied: await deniedWrite('/unauthorized-root-file'), dockerSocketDenied: await deniedRead('/var/run/docker.sock'),
  hostNetworkDenied: await deniedConnect('127.0.0.1', config.settings.hostPort), externalNetworkDenied: await deniedConnect('1.1.1.1', 443),
  subprocessDenied: Boolean(child.error) && ['EPERM', 'EACCES'].includes(child.error.code), childFailure: child.error?.code ?? null,
  noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(controls), seccompEnforced: /^Seccomp:\s+2$/m.test(controls), nonRoot: process.getuid() > 0,
};
await writeFile('/state/allowed-output.json', JSON.stringify(result));
const connection = config.bridges[0];
const bridge = new Bridge({ url: connection.endpoint, bridgeId: connection.bridgeId, credential: connection.credential, token: connection.token, reconnectMs: 100 });
bridge.on('error', () => {}); await bridge.connect(); await bridge.registerChannels([{ name: config.topics.result, publish: true, subscribe: false }]);
await bridge.publish(config.topics.result, { text: 'isolated 🌍 SDK result', checks: result }, { timeoutMs: 10000 });
process.stdout.write(JSON.stringify({ event: 'module-ready' }) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', line => { let command; try { command = JSON.parse(line); } catch { return; }
  if (command.command === 'health') process.stdout.write(JSON.stringify({ event: 'module-health', id: command.id, ready: bridge.connected }) + '\n');
  if (command.command === 'stop' && !config.settings.ignoreStop) void bridge.close().then(() => { input.close(); process.exit(0); });
});
