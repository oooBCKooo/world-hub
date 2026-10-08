#!/usr/bin/env node
// Runs executable process scenarios and preserves both successful and failed evidence.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const index = args.indexOf('--evidence');
if (!(args.length === 0 || (args.length === 2 && args[0] === '--evidence' && args[1]))) throw new Error('usage: node examples/directed-transfer/run-scenarios.mjs [--evidence <directory>]');
const directory = resolve(root, index >= 0 ? args[index + 1] : `.artifacts/evidence/directed-transfer/${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(directory, { recursive: true });
const testPaths = ['call-scenarios.test.mjs', 'route-scenarios.test.mjs', 'bulk-scenarios.test.mjs'].map((name) => join(root, 'tests/integration/directed-transfer', name));
const sources = ['package.json', 'scripts/verify.mjs', 'examples/directed-transfer/run-scenarios.mjs', 'examples/directed-transfer/scene-harness.mjs', 'examples/directed-transfer/scenario-peer.mjs',
  'examples/directed-transfer/dsh-scenario-program.mjs', ...testPaths.map((path) => path.slice(root.length + 1)),
  'tests/fixtures/dsh/dsh-fixture.mjs', 'examples/distributed-context/dsh-context-plugin.mjs', 'tests/helpers/owned-program.mjs', 'examples/distributed-context/lib/jsonrpc-process.mjs',
  'sdk/javascript/bridge-kit.mjs', 'src/hub/lib/hub.mjs', 'src/hub/lib/blob-store.mjs', 'sdk/javascript/blob-client.mjs',
  'src/hub/lib/blob-protocol.mjs', 'src/hub/lib/store.mjs', 'src/hub/lib/router.mjs',
  'src/hub/lib/address.mjs', 'src/hub/lib/acl.mjs', 'src/hub/lib/identity.mjs',
  'src/hub/lib/topic.mjs', 'src/hub/lib/wire-json.mjs', 'src/hub/ws-server.mjs',
  'src/hub/hub-server.mjs', 'tests/helpers/hub-harness.mjs', 'src/management/management-http.mjs', 'src/management/management-state.mjs'];
const hashes = [];
for (const source of sources) hashes.push({ path: source.replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(resolve(root, source))).digest('hex') });
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, ['--test', '--test-timeout=120000', '--test-reporter=tap', ...testPaths], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', (data) => { const text = data.toString(); stdout += text; process.stdout.write(text); });
child.stderr.on('data', (data) => { const text = data.toString(); stderr += text; process.stderr.write(text); });
let spawnError;
const code = await new Promise((resolveExit) => {
  child.once('error', (error) => { spawnError = String(error); resolveExit(1); });
  child.once('exit', (value) => resolveExit(value ?? 1));
});
const scenes = [], evidenceErrors = [];
for (const line of stdout.split(/\r?\n/).filter((line) => line.startsWith('# SCENE_EVIDENCE '))) {
  try { scenes.push(JSON.parse(line.slice('# SCENE_EVIDENCE '.length))); }
  catch (error) { evidenceErrors.push(String(error)); }
}
const statistic = (name) => Number(stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
const expectedNames = [
  ...Array.from({ length: 5 }, (_, i) => `SC-CALL-0${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `P4-S0${i + 6}`),
  ...Array.from({ length: 5 }, (_, i) => `P4-B0${i + 1}`),
];
const sceneNames = scenes.map((scene) => scene.name.split(' ')[0]);
const passed = code === 0 && statistic('fail') === 0 && statistic('tests') === expectedNames.length && statistic('pass') === expectedNames.length &&
  ['skipped', 'cancelled', 'todo'].every((name) => statistic(name) === 0) && scenes.length === expectedNames.length && new Set(sceneNames).size === scenes.length &&
  expectedNames.every((name) => sceneNames.includes(name)) && evidenceErrors.length === 0;
const report = { passed, exitCode: code, startedAt, endedAt: new Date().toISOString(), testRunnerPid: child.pid, tests: statistic('tests'), pass: statistic('pass'), fail: statistic('fail'),
  skipped: statistic('skipped'), cancelled: statistic('cancelled'), todo: statistic('todo'), expectedScenes: expectedNames,
  evidenceErrors,
  sceneCount: scenes.length, scenes, sources: hashes, ...(spawnError ? { spawnError } : {}),
  scope: 'Independent local programs through actual mod Bridge / Hub WebSocket',
  limitations: ['No external model API or real device acceptance', 'No cross-machine, long-duration load or power-loss acceptance', 'DSH application scenarios are a separate optional suite'] };
await writeFile(join(directory, 'scenarios.tap'), stdout);
await writeFile(join(directory, 'stderr.txt'), stderr);
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ passed, tests: report.tests, sceneCount: report.sceneCount, report: join(directory, 'report.json') }) + '\n');
if (!passed) process.exitCode = code || 1;
