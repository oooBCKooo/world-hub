#!/usr/bin/env node
// A clean checkout runs Node-only checks. Optional runtimes are explicit suites.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDshInstall } from '../tests/fixtures/dsh/installed-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let suite = 'node', evidenceRoot = join(root, '.artifacts/evidence');
const seen = new Set();
for (let index = 0; index < args.length; index += 2) {
  const option = args[index], value = args[index + 1];
  if (!['--suite', '--evidence'].includes(option) || !value || seen.has(option)) throw new Error('usage: node scripts/verify.mjs [--suite node|dsh|cross-language|demos|capabilities|ecosystem|launcher|workshop] [--evidence directory]');
  seen.add(option);
  if (option === '--suite') suite = value; else evidenceRoot = resolve(value);
}
if (!['node', 'dsh', 'cross-language', 'demos', 'capabilities', 'ecosystem', 'launcher', 'workshop'].includes(suite)) throw new Error(`unknown suite: ${suite}`);
const directory = join(evidenceRoot, `${suite}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const report = { suite, startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  evidence: directory, passed: false, checks: [], limitations: ['Only the selected suite and recorded local runtimes were executed; optional suites are separate checks.'] };
const save = (name, value) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function execute(label, argv, { command = process.execPath, timeoutMs = 300_000, test = false } = {}) {
  const index = report.checks.length + 1, prefix = String(index).padStart(2, '0');
  process.stdout.write(`\n[${suite}] ${label}\n`);
  const child = spawn(command, argv, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const row = { label, command, args: argv, pid: child.pid, passed: false, startedAt: new Date().toISOString() };
  report.checks.push(row);
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', bytes => { stdout += bytes; process.stdout.write(bytes); });
  child.stderr.on('data', bytes => { stderr += bytes; process.stderr.write(bytes); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  try {
    row.exit = await new Promise(resolveExit => {
      child.once('error', error => resolveExit({ code: 1, signal: null, error: error.message }));
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
  } finally { clearTimeout(timer); }
  row.finishedAt = new Date().toISOString(); row.timedOut = timedOut;
  if (test) {
    row.totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key =>
      [key, Number([...stdout.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].at(-1)?.[1] ?? -1)]));
  }
  row.passed = row.exit.code === 0 && row.exit.signal === null && !timedOut &&
    (!test || row.totals.tests > 0 && row.totals.pass === row.totals.tests && ['fail', 'cancelled', 'skipped', 'todo'].every(key => row.totals[key] === 0));
  row.stdout = `${prefix}.stdout.txt`; row.stderr = `${prefix}.stderr.txt`;
  await save(row.stdout, stdout); await save(row.stderr, stderr);
  if (!row.passed) throw new Error(`${label} failed; see ${join(directory, row.stderr)} and ${join(directory, row.stdout)}`);
  return row;
}

const nodeTests = files => ['--test', '--test-timeout=120000', '--test-concurrency=1', '--test-reporter=tap', ...files];
try {
  report.sourceHashes = {};
  for (const file of ['package.json', 'scripts/verify.mjs']) report.sourceHashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  if (suite === 'node') {
    const conformance = (await readdir(join(root, 'tests/conformance'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/conformance/${name}`);
    await execute('Hub, protocol, SDK and management conformance', nodeTests(conformance), { test: true });
    await execute('Node application context and JSON-RPC transport', nodeTests(['tests/integration/context/jsonrpc-process.test.mjs', 'tests/integration/context/ui-context.test.mjs']), { test: true });
    await execute('Directed requests, injection and large transfers', nodeTests(['tests/integration/directed-transfer/call-scenarios.test.mjs', 'tests/integration/directed-transfer/route-scenarios.test.mjs', 'tests/integration/directed-transfer/bulk-scenarios.test.mjs']), { test: true });
    await execute('Multiple-round external program workflows', ['examples/workflows/run-flows.mjs', '--evidence', join(directory, 'workflows')]);
    await execute('Bidirectional event panel with independent programs', ['examples/event-panel/run-demo.mjs']);
    await execute('Independent-program directed transfer', ['examples/directed-transfer/run-phase4.mjs']);
    await execute('Three-program route', ['examples/three-programs/run-three.mjs']);
    await execute('Source distribution allowlist, integrity and safe outputs', nodeTests(['scripts/release/distribution.test.mjs']), { test: true });
  } else if (suite === 'demos') {
    await execute('Purpose demos: real external programs, bidirectional actions, distributed context and world rounds', nodeTests([
      'tests/integration/purpose-demos/scenarios.test.mjs', 'tests/integration/purpose-demos/launcher.test.mjs',
      'tests/integration/purpose-demos/explorer-view.test.mjs',
      'tests/integration/capability-directory/ecosystem.test.mjs',
    ]), { test: true });
    await execute('Purpose bundles: allowlist, fixed profiles, integrity and safe build outputs', nodeTests(['scripts/release/demo-distribution.test.mjs']), { test: true });
  } else if (suite === 'capabilities') {
    await execute('External capability directory, independent processor replacement and explained failures', nodeTests([
      'tests/integration/capability-directory/ecosystem.test.mjs',
      'tests/integration/purpose-demos/explorer-view.test.mjs',
      'tests/integration/purpose-demos/launcher.test.mjs',
    ]), { test: true });
  } else if (suite === 'ecosystem') {
    await execute('Optional trusted-local Runtime: cross-language deploy, isolate, rebuild and reliable cleanup', nodeTests([
      'tests/integration/ecosystem-runtime/runtime.test.mjs',
      'tests/integration/ecosystem-runtime/distribution.test.mjs',
      'tests/integration/ecosystem-runtime/paths.test.mjs',
      'tests/integration/ecosystem-runtime/maintenance.test.mjs',
      'tests/integration/ecosystem-runtime/developer.test.mjs',
      'tests/integration/ecosystem-runtime/replacement-preview.test.mjs',
      'tests/integration/ecosystem-runtime/developer-cli.test.mjs',
    ]), { test: true });
  } else if (suite === 'launcher') {
    const cases = (await readdir(join(root, 'tests/integration/launcher'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/integration/launcher/${name}`);
    await execute('Unified Launcher: reviewed starts, real cross-language packs, lifecycle and navigation', nodeTests(cases), { test: true });
  } else if (suite === 'workshop') {
    const cases = (await readdir(join(root, 'tests/integration/workshop'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/integration/workshop/${name}`);
    await execute('Optional hosted Workshop: publication, accounts, collaboration and persistence', nodeTests(cases), { test: true });
  } else if (suite === 'dsh') {
    report.dsh = requireDshInstall();
    await execute('Explicit local DSH integration', nodeTests(['tests/integration/context/harness-program.test.mjs', 'tests/integration/context/phase2-e2e.test.mjs', 'tests/integration/context/phase2-lifecycle.test.mjs', 'tests/integration/directed-transfer/dsh-scenario.test.mjs']), { test: true });
  } else {
    const python = process.env.HUB_PYTHON ?? process.env.PHASE7_PYTHON ?? 'python';
    const powershell = process.env.HUB_PWSH ?? process.env.PHASE7_POWERSHELL ?? 'pwsh';
    process.env.PHASE7_PYTHON = python; process.env.PHASE7_POWERSHELL = powershell;
    await execute('Python adapter dependency', ['-c', 'import sys, websockets; print(sys.version); print(websockets.__version__)'], { command: python, timeoutMs: 30_000 });
    await execute('PowerShell 7 runtime', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }; $PSVersionTable.PSVersion.ToString()'], { command: powershell, timeoutMs: 30_000 });
    await execute('Cross-language independent-program scenarios', ['examples/cross-language/run-cross-language.mjs', '--evidence', join(directory, 'cross-language')]);
    for (const language of ['javascript', 'python', 'powershell']) await execute(`${language} adapter acceptance`, ['tests/bridge-acceptance/run.mjs', '--bridge', `tests/bridge-acceptance/${language}.json`, '--evidence', join(directory, 'bridge-acceptance')]);
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error); process.stderr.write(`${error.message}\n`); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await save('report.json', report);
  process.stdout.write(JSON.stringify({ suite, passed: report.passed, checks: report.checks.length, report: join(directory, 'report.json') }) + '\n');
}
