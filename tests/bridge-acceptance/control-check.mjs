// Verify reporting/selection, not business behavior. Each run still owns its Hub.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../../examples/cross-language/scene-harness.mjs';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const directory = join(ROOT, '.artifacts/evidence/bridge-acceptance/controls', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const sharedEvidence = join(directory, 'runs');
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function execute(manifest) {
  const child = spawn(process.execPath, [runner, '--bridge', manifest, '--evidence', sharedEvidence], { cwd: ROOT, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
  const timer = setTimeout(() => child.kill(), 45000);
  try { return await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal, output })); }); }
  finally { clearTimeout(timer); }
}
const baseManifest = JSON.parse(await readFile(new URL('./javascript.json', import.meta.url), 'utf8'));
baseManifest.profiles = ['base'];
const basePath = join(directory, 'base-only.json');
await writeFile(basePath, JSON.stringify(baseManifest, null, 2) + '\n', { flag: 'wx' });
const baseExit = await execute(basePath); assert.equal(baseExit.code, 0); assert.equal(baseExit.signal, null);
const firstDirs = await readdir(sharedEvidence); assert.equal(firstDirs.length, 1);
const firstPath = join(sharedEvidence, firstDirs[0], 'report.json'), originalBytes = await readFile(firstPath), baseReport = JSON.parse(originalBytes);
assert.equal(baseReport.passed, true); assert.equal(baseReport.expectedChecks.length, 7); assert.equal(baseReport.passedChecks, 7);
assert.deepEqual(baseReport.notExecuted.map((row) => row.profile), ['directed', 'blob']); assert.equal(baseReport.selectedButNotReached.length, 0); assert.equal(baseReport.cleanupCompleted, true);

// An adapter exiting zero before welcome must fail, never count as accepted.
const deadPath = join(directory, 'premature-exit.json');
await writeFile(deadPath, JSON.stringify({ name: 'intentional-premature-exit', command: process.execPath, args: ['-e', 'process.exit(0)'], profiles: ['base'] }, null, 2) + '\n', { flag: 'wx' });
const deadExit = await execute(deadPath); assert.notEqual(deadExit.code, 0); assert.equal(deadExit.signal, null);
const secondDirs = await readdir(sharedEvidence); assert.equal(secondDirs.length, 2);
const secondPath = join(sharedEvidence, secondDirs.find((name) => !firstDirs.includes(name)), 'report.json'), deadReport = JSON.parse(await readFile(secondPath, 'utf8'));
assert.equal(deadReport.passed, false); assert.equal(deadReport.checks[0].passed, false); assert.equal(deadReport.passedChecks, 0); assert.equal(deadReport.selectedButNotReached.length, 6); assert.equal(deadReport.cleanupCompleted, true);
assert.equal(checksum(await readFile(firstPath)), checksum(originalBytes));
const malformedPath = join(directory, 'malformed-output.json');
await writeFile(malformedPath, JSON.stringify({ name: 'intentional-malformed-output', command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({event:"frame"})+"\\n"); process.stdin.resume()'], profiles: ['base'] }, null, 2) + '\n', { flag: 'wx' });
const malformedExit = await execute(malformedPath); assert.notEqual(malformedExit.code, 0); assert.equal(malformedExit.signal, null);
const thirdDirs = await readdir(sharedEvidence); assert.equal(thirdDirs.length, 3);
const thirdPath = join(sharedEvidence, thirdDirs.find((name) => !secondDirs.includes(name)), 'report.json'), malformedReport = JSON.parse(await readFile(thirdPath, 'utf8'));
assert.equal(malformedReport.passed, false); assert.equal(malformedReport.checks[0].passed, false); assert.equal(malformedReport.cleanupCompleted, true);
assert.match(malformedReport.error, /malformed adapter frame output/);
assert.equal(checksum(await readFile(firstPath)), checksum(originalBytes));
const invalidPath = join(directory, 'invalid-profile.json');
await writeFile(invalidPath, JSON.stringify({ ...baseManifest, profiles: { base: true } }, null, 2) + '\n', { flag: 'wx' });
const invalidExit = await execute(invalidPath); assert.notEqual(invalidExit.code, 0); assert.equal(invalidExit.signal, null);
const fourthDirs = await readdir(sharedEvidence); assert.equal(fourthDirs.length, 4);
const fourthPath = join(sharedEvidence, fourthDirs.find((name) => !thirdDirs.includes(name)), 'report.json'), invalidReport = JSON.parse(await readFile(fourthPath, 'utf8'));
assert.equal(invalidReport.passed, false); assert.equal(invalidReport.executedChecks, 0); assert.equal(invalidReport.cleanupCompleted, true);
assert.match(invalidReport.error, /manifest.profiles/);
assert.equal(checksum(await readFile(firstPath)), checksum(originalBytes));
const result = { passed: true, controls: 5, node: process.version, platform: process.platform, baseOnly: { passed: true, checked: 7, notExecuted: ['directed', 'blob'], report: firstPath }, prematureExit: { expectedFailure: true, runnerExit: deadExit.code, report: secondPath }, malformedOutput: { expectedFailure: true, runnerExit: malformedExit.code, report: thirdPath }, invalidProfile: { expectedFailure: true, runnerExit: invalidExit.code, report: fourthPath }, existingReportPreserved: { passed: true, sha256: checksum(originalBytes), sameEvidenceParent: sharedEvidence } };
await writeFile(join(directory, 'control-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...result, evidence: join(directory, 'control-result.json') }));
