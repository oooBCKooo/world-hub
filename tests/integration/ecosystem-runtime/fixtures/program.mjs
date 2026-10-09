// Deliberately small external program. Failure modes exercise supervisor behavior;
// they never alter the Hub or use its internals.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Bridge } from '#bridge';

const argument = process.argv.indexOf('--runtime-config');
if (argument < 0 || !process.argv[argument + 1]) throw new Error('Missing runtime config');
const config = JSON.parse(await readFile(process.argv[argument + 1], 'utf8'));
const mode = config.settings.mode ?? 'normal';
await writeFile(join(config.stateDir, 'runtime-observed.json'), JSON.stringify({
  pid: process.pid, cwd: process.cwd(), parentSecret: process.env.WORLD_HUB_TEST_PARENT_SECRET ?? null,
  module: config.module, bridges: config.bridges, peers: config.peers,
}), { mode: 0o600 });
if (mode === 'early-exit') process.exit(19);

const bridges = [];
for (const slot of config.bridges) {
  const bridge = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId,
    credential: slot.credential, token: slot.token, reconnectMs: 100 });
  bridge.on('error', () => {});
  bridges.push(bridge); await bridge.connect();
  const topics = [...new Set([...slot.publish, ...slot.subscribe])];
  await bridge.registerChannels(topics.map(name => ({ name,
    publish: slot.publish.includes(name), subscribe: slot.subscribe.includes(name) })));
}

let closed = false;
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ connected: bridges.map(bridge => bridge.connected), pid: process.pid }));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const entryUrl = `http://127.0.0.1:${server.address().port}/`;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const started = Date.now();
const keepalive = setInterval(() => {}, 200);
const input = createInterface({ input: process.stdin });
async function stop() {
  if (closed || mode === 'ignore-stop') return;
  closed = true; clearInterval(keepalive);
  await Promise.all(bridges.map(bridge => bridge.close('fixture stopped')));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  input.close(); process.exit(0);
}
input.on('line', line => {
  let command; try { command = JSON.parse(line); } catch { return; }
  if (command.command === 'stop') stop().catch(error => { console.error(error); process.exit(2); });
  if (command.command === 'health') {
    if (mode === 'health-timeout' && Date.now() - started > 1500) return;
    const healthy = mode !== 'health-unready' || Date.now() - started <= 1500;
    emit({ event: 'module-health', id: command.id, ready: healthy && bridges.every(bridge => bridge.connected) });
  }
});
input.on('close', () => stop());
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());

if (mode === 'delay-restart') {
  const launchesFile = join(config.stateDir, 'launches.json');
  let launches = 0;
  try { launches = JSON.parse(await readFile(launchesFile, 'utf8')).launches; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(launchesFile, JSON.stringify({ launches: launches + 1 }));
  if (launches === 0) emit({ event: 'module-ready', entryUrl });
  else setTimeout(() => emit({ event: 'module-ready', entryUrl }), 12000);
} else if (mode !== 'no-ready') emit({ event: 'module-ready', entryUrl });
if (mode === 'crash-after-ready') setTimeout(() => process.exit(23), 2200);
if (mode === 'oversize-line') setTimeout(() => process.stdout.write('X'.repeat(262144) + '\n'), 1200);
if (mode === 'flood') {
  const secret = config.bridges[0].token;
  // Each line stays below the protocol bound; the aggregate is intentionally large.
  for (let index = 0; index < 220; index += 1) {
    emit({ event: 'fixture-log', index, secret, text: 'flood-'.repeat(700) });
    process.stderr.write(`fixture secret=${secret} ${'log-'.repeat(700)}\n`);
  }
  emit({ event: 'fixture-log', message: 'flood-finished' });
}
if (mode === 'split-secret') {
  const secret = config.bridges[0].token;
  setTimeout(() => {
    process.stdout.write(`split-stdout=${secret.slice(0, 12)}`);
    process.stderr.write(`split-stderr=${secret.slice(0, 12)}`);
    setTimeout(() => {
      process.stdout.write(secret.slice(12) + '\nsplit-secret-finished\n');
      process.stderr.write(secret.slice(12) + '\nsplit-secret-finished\n');
    }, 300);
  }, 500);
}
