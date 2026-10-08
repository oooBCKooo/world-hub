import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const args = process.argv.slice(2);
const demo = args.includes('--demo');
if (demo) args.splice(args.indexOf('--demo'), 1);
if (!(args.length === 0 || (args.length === 2 && args[0] === '--evidence' && args[1]))) throw new Error('usage: node examples/workflows/run-flows.mjs [--demo] [--evidence directory]');
const directory = resolve(root, args[1] ?? `.artifacts/evidence/workflows${demo ? '-demo' : ''}/${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(directory, { recursive: true });
const tests = ['flow.test.mjs', 'advanced-flow.test.mjs', 'blob-flow.test.mjs', 'workflow.test.mjs'];
const sources = ['package.json', 'scripts/verify.mjs', 'examples/workflows/run-flows.mjs', 'examples/workflows/flow-program.mjs', 'examples/workflows/flow-scene.mjs', 'examples/workflows/blob-relay-program.mjs', 'examples/workflows/workflow-program.mjs',
  ...tests.map((name) => `tests/integration/workflows/${name}`), 'examples/directed-transfer/scene-harness.mjs', 'examples/directed-transfer/scenario-peer.mjs', 'tests/helpers/owned-program.mjs',
  'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs', 'src/hub/hub-server.mjs', 'src/hub/ws-server.mjs',
  'tests/helpers/hub-harness.mjs', ...['hub','store','router','blob-store','blob-protocol','address','acl','identity','topic','wire-json'].map((name) => `src/hub/lib/${name}.mjs`)];
const hashes = [];
for (const path of sources) hashes.push({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') });
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, ['--test', '--test-timeout=120000', '--test-reporter=tap', ...(demo ? ['--test-name-pattern=^P5-W01 '] : []),
  ...(demo ? [join(root, 'tests/integration/workflows/workflow.test.mjs')] : tests.map((name) => join(root, 'tests/integration/workflows', name)))], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', spawnError;
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', (data) => { stdout += data.toString(); process.stdout.write(data); });
child.stderr.on('data', (data) => { stderr += data.toString(); process.stderr.write(data); });
const exitCode = await new Promise((done) => { child.once('error', (error) => { spawnError = String(error); done(1); }); child.once('close', (code) => done(code ?? 1)); });
const scenes = [], evidenceErrors = [];
for (const line of stdout.split(/\r?\n/).filter((line) => line.startsWith('# SCENE_EVIDENCE '))) {
  // Node's TAP reporter escapes each diagnostic backslash once more.
  try { scenes.push(JSON.parse(line.slice('# SCENE_EVIDENCE '.length).replaceAll('\\\\', '\\'))); } catch (error) { evidenceErrors.push(String(error)); }
}
const count = (name) => Number(stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
const expectedScenes = demo ? ['P5-W01'] : [...Array.from({ length: 7 }, (_, i) => `P5-F0${i + 1}`), 'P5-B01', 'P5-W01', 'P5-W02'];
const ids = scenes.map((scene) => scene.name.split(' ')[0]);
const workflowProof = scenes.find((scene) => scene.name.startsWith('P5-W01 '))?.checkpoints.find((item) => item.label === 'autonomous-three-round-workflow-artifact');
let artifact;
if (workflowProof && typeof workflowProof.artifact?.content === 'string') {
  const bytes = Buffer.from(workflowProof.artifact.content, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 === workflowProof.artifact.sha256 && bytes.length === workflowProof.artifact.size) {
    await writeFile(join(directory, 'workflow-result.json'), bytes);
    artifact = { path: 'workflow-result.json', size: bytes.length, sha256 };
  } else evidenceErrors.push('saved workflow artifact differs from the caller-verified file');
} else evidenceErrors.push('missing actual workflow artifact content');
const passed = exitCode === 0 && count('tests') === expectedScenes.length && count('pass') === expectedScenes.length &&
  ['fail','cancelled','todo','skipped'].every((name) => count(name) === 0) && scenes.length === expectedScenes.length &&
  new Set(ids).size === scenes.length && expectedScenes.every((id) => ids.includes(id)) && evidenceErrors.length === 0;
const report = { passed, exitCode, demo, startedAt, endedAt: new Date().toISOString(), tests: count('tests'), pass: count('pass'), fail: count('fail'),
  skipped: count('skipped'), cancelled: count('cancelled'), todo: count('todo'), expectedScenes, evidenceErrors, sceneCount: scenes.length, scenes, sources: hashes,
  artifact, ...(spawnError ? { spawnError } : {}), scope: 'Actual local external programs choose and perform every hop over the unchanged Hub protocol',
  limitations: ['Application journal tested only after a completed checkpoint; no exactly-once crash-window guarantee', 'No cross-machine, long-duration load or arbitrary third-party program acceptance'] };
await writeFile(join(directory, 'flows.tap'), stdout);
await writeFile(join(directory, 'stderr.txt'), stderr);
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ passed, scenes: scenes.length, tests: report.tests, report: join(directory, 'report.json') }) + '\n');
if (!passed) process.exitCode = exitCode || 1;
