import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args[0] !== '--evidence' || args.length !== 2)) throw new Error('usage: node scripts/test-recovery.mjs [--evidence directory]');
const evidenceDir = resolve(root, args[1] ?? `.artifacts/evidence/recovery/${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(evidenceDir, { recursive: true });
const sources = ['src/hub/lib/hub.mjs', 'src/hub/lib/store.mjs', 'src/hub/lib/wire-json.mjs',
  'tests/conformance/recovery-scale.test.mjs', 'tests/fixtures/recovery-probe.mjs', 'scripts/test-recovery.mjs'];
const hashes = Object.fromEntries(await Promise.all(sources.map(async (path) => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', 'tests/conformance/recovery-scale.test.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
const exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
const count = (key) => Number(stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? -1);
const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [key, count(key)]));
const samples = [], parseErrors = [];
// Base64 prevents TAP diagnostic escaping from changing raw JSON backslashes or #.
for (const line of stdout.split('\n')) if (line.startsWith('# RECOVERY_EVIDENCE_BASE64 ')) { try { samples.push(JSON.parse(Buffer.from(line.slice('# RECOVERY_EVIDENCE_BASE64 '.length), 'base64').toString('utf8'))); } catch (error) { parseErrors.push(error.message); } }
const passed = exitCode === 0 && totals.tests === 3 && totals.pass === 3 && ['fail', 'cancelled', 'skipped', 'todo'].every((key) => totals[key] === 0) && samples.length === 2 && parseErrors.length === 0;
const report = { startedAt, completedAt: new Date().toISOString(), passed, exitCode, totals, sourceHashes: hashes, samples, parseErrors,
  limits: ['OS RSS or working-set snapshots only, not a peak or generic memory ratio', 'local Windows run does not establish Linux, cross-host, long-run or power-loss acceptance'] };
await writeFile(join(evidenceDir, 'recovery.tap'), stdout);
await writeFile(join(evidenceDir, 'stderr.txt'), stderr);
await writeFile(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ evidenceDir, passed, totals }));
process.exitCode = passed ? 0 : 1;
