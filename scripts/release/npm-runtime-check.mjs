// Copied into a clean installed npm application's workspace by acceptance.
// Uses public exports and deployed SDK files only, never repository code.
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLock, importPackage, startInstance, statusInstance, exportInstance } from 'world-hub/runtime';

const workspace = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(fileURLToPath(import.meta.resolve('world-hub/package.json')));
const deployment = join(workspace, 'runtime-acceptance'), packDir = join(deployment, 'pack'), moduleDir = join(packDir, 'modules/peer');
await mkdir(moduleDir, { recursive: true });
for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(packageRoot, 'sdk/javascript', file), join(moduleDir, file));
const program = `import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Bridge } from '#bridge';
const config = JSON.parse(await readFile(process.argv[process.argv.indexOf('--runtime-config') + 1], 'utf8'));
const wiring = config.bridges[0];
const bridge = new Bridge({ url:wiring.endpoint, bridgeId:wiring.bridgeId, credential:wiring.credential, token:wiring.token, instanceId:randomUUID() });
const welcome = await bridge.connect();
if (welcome.principal !== wiring.principal || welcome.authenticated !== true) throw new Error('Unexpected deployment identity');
await bridge.registerChannels([...new Set([...wiring.publish, ...wiring.subscribe])].map(name => ({name,publish:wiring.publish.includes(name),subscribe:wiring.subscribe.includes(name)})));
await bridge.subscribe(wiring.subscribe);
let closing = false;
const stop = async () => { if (closing) return; closing = true; await bridge.close(); process.exit(0); };
const input = createInterface({input:process.stdin});
input.on('line', line => { const command = JSON.parse(line); if (command.command === 'stop') void stop(); else if (command.command === 'health') console.log(JSON.stringify({event:'module-health',id:command.id,ready:true})); });
input.on('close', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
console.log(JSON.stringify({event:'module-ready'}));
`;
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
await writeFile(join(moduleDir, 'program.mjs'), program);
await save(join(moduleDir, 'package.json'), { imports: { '#bridge': './bridge-kit.mjs' } });
await save(join(moduleDir, 'module.json'), { format: 'world-hub.module/v1', id: 'npm.peer', version: '1.0.0', license: 'MIT',
  platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [],
  permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
await save(join(packDir, 'pack.json'), { format: 'world-hub.pack/v1', id: 'npm.pack', version: '1.0.0', title: 'Installed Runtime verification', license: 'MIT',
  topics: { shared: 'npm/runtime/check' }, components: [{ id: 'peer', module: 'npm.peer', after: [], settings: {}, bridges: { main: { publish: ['shared'], subscribe: ['shared'] } } }],
  bindings: [], entry: { component: 'peer' }, startupTimeoutMs: 10000, healthTimeoutMs: 3000, stopTimeoutMs: 3000 });
await createLock(packDir, { nodePath: process.execPath });
const options = { root: join(deployment, 'instances'), instanceId: 'installed', nodePath: process.execPath };
const imported = await importPackage(packDir, options);
let session;
try {
  session = await startInstance({ ...options, trust: imported.digest });
  const state = await statusInstance(options);
  assert.equal(state.state, 'running'); assert.equal(state.components[0].communication, 'connected');
  assert.equal(state.components[0].readiness, 'ready'); assert.equal(state.components[0].health.ready, true);
  await exportInstance({ ...options, destination: join(deployment, 'export') });
} finally { if (session) await session.close(); }
const terminal = await session.closed;
assert.equal(terminal.state, 'stopped'); assert.ok(terminal.stoppedAt);
assert.equal(terminal.hub.exit.code, 0); assert.equal(terminal.components[0].exit.code, 0);
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
console.log(JSON.stringify({ passed: true, version: pkg.version, moduleProcesses: terminal.components.length, pids: session.ready.pids, exited: true, imported: true, exported: true }));
