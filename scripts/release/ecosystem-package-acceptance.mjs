// Accept the actual source ZIP through its extracted optional Runtime and programs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inspectDemoZip } from './demo-package-acceptance.mjs';
import { verifyPackage } from './verify-package.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const expected = text => ({ codePoints: [...text].length, lines: text.split('\n').length,
  utf8Bytes: Buffer.byteLength(text, 'utf8'), sha256: sha(Buffer.from(text, 'utf8')) });
const inside = (root, path) => { const local = relative(resolve(root), resolve(path)); return local && !local.startsWith('..' + sep) && local !== '..' && !isAbsolute(local); };
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'No package links may appear');
    const local = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, local));
    else { assert.equal(entry.isFile(), true); result.push(local); }
  }
  return result.sort();
}
async function request(url, path, options) {
  const response = await fetch(new URL(path, url), { redirect: 'error', signal: AbortSignal.timeout(15000), ...options });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true);
  return body;
}
const analyze = (session, text) => request(session.ready.entryUrl, '/analyze', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });

export async function acceptEcosystemArchive({ archive, evidence = join(repository, '.artifacts/evidence/ecosystem-packages'),
  nodePath = process.execPath, pythonPath = process.platform === 'win32' ? 'python.exe' : 'python3' } = {}) {
  assert.equal(process.platform, 'win32', 'This archive extraction acceptance uses native Windows PowerShell');
  assert.ok(archive, 'An actual ZIP is required'); archive = resolve(archive);
  assert.equal((await lstat(archive)).isSymbolicLink(), false); assert.equal((await lstat(archive)).isFile(), true);
  const archiveBytes = await readFile(archive), inspected = inspectDemoZip(archiveBytes);
  const evidenceRoot = resolve(evidence);
  assert.ok(inside(repository, evidenceRoot) && inside(join(repository, '.artifacts'), evidenceRoot), 'Evidence must remain in ignored workspace .artifacts');
  const directory = join(evidenceRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(evidenceRoot, { recursive: true }); await mkdir(directory);
  const extracted = join(directory, 'extracted'); await mkdir(extracted);
  const report = { passed: false, archive, archiveSha256: sha(archiveBytes), archiveBytes: archiveBytes.length,
    evidence: directory, kind: 'actual-ecosystem-source-zip', startsFromActualZip: true, checks: [], sessions: [], cleanup: null,
    startedAt: new Date().toISOString() };
  const sessions = [], environment = { nodePath, pythonPath };
  const record = (id, label, details = {}) => report.checks.push({ id, label, passed: true, ...details });
  const start = async (api, root, instanceId, digest) => {
    const session = await api.startInstance({ root, instanceId, trust: digest, ...environment });
    sessions.push(session); report.sessions.push({ instanceId, root, ready: session.ready }); return session;
  };
  try {
    // The bounded ZIP inspector rejects traversal, symlinks and unsupported formats first.
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:WORLD_HUB_ACCEPT_ARCHIVE -DestinationPath $env:WORLD_HUB_ACCEPT_EXTRACT -ErrorAction Stop'],
    { cwd: directory, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WORLD_HUB_ACCEPT_ARCHIVE: archive, WORLD_HUB_ACCEPT_EXTRACT: extracted } });
    const bundle = join(extracted, inspected.root); report.bundle = bundle;
    const integrity = await verifyPackage(bundle); assert.equal(integrity.passed, true, JSON.stringify(integrity.failed));
    const manifest = await json(join(bundle, 'manifest.json'));
    assert.equal(manifest.kind, 'ecosystem-source'); assert.equal(manifest.runtime, null);
    assert.equal(inspected.entries.length, manifest.files.length + 1);
    record('ZIP-01', 'Actual ZIP paths, extracted manifest, all file sizes and SHA-256 verified',
      { files: integrity.checkedFiles, archiveRoot: inspected.root, version: manifest.version });

    const runtimeFile = join(bundle, 'scripts/runtime/index.mjs');
    const api = await import(pathToFileURL(runtimeFile));
    const packDirectory = join(bundle, 'examples/ecosystem-pack');
    const plan = await api.inspectPackage(packDirectory, environment);
    assert.equal(plan.startsModules, false); assert.equal(plan.sandbox, false); assert.equal(plan.modules.length, 3);
    assert.equal(plan.environment.node.version, '22.23.2'); assert.equal(plan.environment.python.version, '3.14.0');
    assert.equal(plan.environment.python.packages.websockets, '15.0.1');
    assert.equal((await verifyPackage(bundle)).passed, true);
    record('ZIP-02', 'Extracted Runtime imports and inspects the complete extracted locked pack without mutation',
      { runtimeFile, digest: plan.digest, environment: Object.fromEntries(Object.entries(plan.environment).map(([kind, runtime]) => [kind, { version: runtime.version, packages: runtime.packages, sha256: runtime.sha256 }])) });

    const root = join(directory, 'runtime-root');
    const one = await api.importPackage(packDirectory, { root, instanceId: 'one', ...environment });
    const two = await api.importPackage(packDirectory, { root, instanceId: 'two', ...environment });
    assert.equal(one.digest, plan.digest); assert.equal(two.digest, plan.digest);
    const first = await start(api, root, 'one', one.digest), second = await start(api, root, 'two', two.digest);
    const firstStatus = await first.status(), secondStatus = await second.status();
    for (const status of [firstStatus, secondStatus]) {
      assert.equal(status.state, 'running'); assert.equal(status.components.length, 3);
      assert.ok(status.components.every(component => component.process === 'running' && component.readiness === 'ready'
        && component.health.ready === true && component.communication === 'connected' && component.bridges.every(bridge => bridge.connected && bridge.session)));
    }
    record('ZIP-03', 'Two extracted Runtime instances start actual Hub plus three independent JS/Python programs',
      { instances: [first.ready.instanceId, second.ready.instanceId], pids: [...first.ready.pids, ...second.ready.pids], statuses: [firstStatus, secondStatus] });

    for (const key of ['hubUrl', 'entryUrl', 'controlUrl', 'stateDir']) assert.notEqual(first.ready[key], second.ready[key]);
    const configurations = async (session, status) => Promise.all(['source', 'stats', 'desk'].map(id => json(join(session.ready.stateDir, 'runs', status.runId, id + '.json'))));
    const configOne = await configurations(first, firstStatus), configTwo = await configurations(second, secondStatus);
    const tokensOne = new Set(configOne.flatMap(config => config.bridges.map(bridge => bridge.token)));
    const tokensTwo = new Set(configTwo.flatMap(config => config.bridges.map(bridge => bridge.token)));
    assert.equal(tokensOne.size, 3); assert.equal(tokensTwo.size, 3); assert.ok([...tokensOne].every(token => !tokensTwo.has(token)));
    assert.ok(configOne.every(oneConfig => configTwo.every(twoConfig => oneConfig.stateDir !== twoConfig.stateDir)));
    const page = await fetch(first.ready.entryUrl); assert.equal(page.status, 200); assert.match(await page.text(), /id="language"/);
    const ui = await fetch(new URL('/ui.js', first.ready.entryUrl)); assert.equal(ui.status, 200); const script = await ui.text();
    assert.match(script, /Cross-language text desk/); assert.match(script, /跨语言文本台/);
    record('ZIP-04', 'Simultaneous instances separate credentials, ports and writable state; delivered UI offers Chinese and English',
      { independentTokens: tokensOne.size + tokensTwo.size, portsSeparated: true, uiResourcesServed: true, browserRenderingTested: false });

    const text = '世界枢纽 🌍\r\nCafe\u0301\n末行\n';
    const resultOne = (await analyze(first, text)).result, resultTwo = (await analyze(second, '隔离实例二 🚀\n')).result;
    assert.equal(resultOne.text, text); assert.deepEqual(resultOne.output, expected(text));
    assert.deepEqual(resultTwo.output, expected('隔离实例二 🚀\n'));
    assert.equal(resultOne.receipts.length, 3);
    assert.deepEqual(resultOne.receipts.map(receipt => receipt.fromPrincipal), ['runtime.source', 'runtime.source', 'runtime.stats']);
    assert.ok(resultOne.receipts.every(receipt => receipt.responseSeq > receipt.requestSeq && receipt.senderSession));
    const savedOne = (await request(first.ready.entryUrl, '/state')).results;
    assert.deepEqual((await request(second.ready.entryUrl, '/state')).results, [resultTwo]);
    record('ZIP-05', 'Exact Chinese, emoji, CRLF, LF and combining Unicode travel source to Python to desk with authenticated receipts and saved results',
      { result: resultOne, secondInstanceOutput: resultTwo.output });

    const stoppedFirst = await first.close(); assert.equal(stoppedFirst.state, 'stopped');
    assert.ok(first.children.every(child => child.exit?.code === 0 && !child.forced));
    assert.ok(second.ready.pids.every(alive), 'Stopping one instance cannot stop its neighbour');
    const restarted = await start(api, root, 'one', one.digest);
    assert.deepEqual((await request(restarted.ready.entryUrl, '/state')).results, savedOne);
    const source = await json(join(restarted.ready.stateDir, 'programs/source/source.json')); assert.equal(source.text, text);
    const readAgain = await request(restarted.ready.entryUrl, '/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(readAgain.result.text, text); assert.deepEqual(readAgain.result.output, expected(text));
    assert.equal(readAgain.result.receipts.length, 2);
    assert.deepEqual((await request(second.ready.entryUrl, '/state')).results, [resultTwo]);
    record('ZIP-06', 'Normal stop and restart preserve program-owned source and results while the other instance remains isolated',
      { stoppedPids: first.ready.pids, restartedPids: restarted.ready.pids, priorResultsPreserved: savedOne.length });

    const exported = join(directory, 'exported-package');
    const exportedResult = await api.exportInstance({ root, instanceId: 'one', destination: exported, ...environment });
    assert.equal(exportedResult.includesRuntimeState, false);
    const exportedFiles = await files(exported);
    const publicFiles = ['pack.json', 'pack.lock', ...plan.modules.flatMap(module => module.files.map(file => `${module.source}/${file.path}`))].sort();
    assert.deepEqual(exportedFiles, publicFiles);
    for (const local of publicFiles) assert.equal(sha(await readFile(join(exported, local))), sha(await readFile(join(packDirectory, local))), local);
    record('ZIP-07', 'Export carries only exact locked public package bytes, excluding credentials, logs and business state',
      { files: exportedFiles.length, includesRuntimeState: false });

    const rebuiltRoot = join(directory, 'rebuilt-clean-root');
    const rebuilt = await api.importPackage(exported, { root: rebuiltRoot, instanceId: 'rebuilt', ...environment });
    const third = await start(api, rebuiltRoot, 'rebuilt', rebuilt.digest);
    assert.deepEqual((await request(third.ready.entryUrl, '/state')).results, []);
    const resultThree = (await analyze(third, text)).result; assert.deepEqual(resultThree.output, expected(text));
    assert.notEqual(third.ready.stateDir, restarted.ready.stateDir);
    record('ZIP-08', 'Export rebuilds in a fresh deployment root with empty prior results and a new successful real JS/Python flow',
      { pids: third.ready.pids, output: resultThree.output, digest: rebuilt.digest });

    for (const session of [...sessions].reverse()) await session.close();
    const processes = sessions.flatMap(session => session.children.map(child => ({ pid: child.pid, module: child.id,
      exit: child.exit, forced: child.forced === true, aliveAfterCleanup: alive(child.pid) })));
    assert.ok(processes.every(process => process.exit?.code === 0 && !process.forced && !process.aliveAfterCleanup));
    assert.equal((await verifyPackage(bundle)).passed, true, 'Programs must never write into extracted immutable package');
    assert.ok((await files(bundle)).every(local => !/(?:__pycache__|\.pyc$)/.test(local)));
    report.cleanup = { passed: true, processes };
    record('ZIP-09', 'All owned process exits confirmed normal; extracted locked sources remain unchanged after execution',
      { processes: processes.length, exitsConfirmed: true, immutableFilesVerified: true });
    report.passed = true;
  } catch (error) { report.error = error.stack ?? String(error); }
  finally {
    const cleanupErrors = [];
    for (const session of [...sessions].reverse()) {
      try { await session.close(); } catch (error) { cleanupErrors.push(error.message); }
    }
    if (!report.cleanup) report.cleanup = { passed: cleanupErrors.length === 0 && sessions.every(session => session.children.every(child => child.exit && !alive(child.pid))),
      errors: cleanupErrors, processes: sessions.flatMap(session => session.children.map(child => ({ pid: child.pid, module: child.id,
        exit: child.exit, forced: child.forced === true, aliveAfterCleanup: alive(child.pid) }))) };
    if (!report.cleanup.passed) report.passed = false;
    report.finishedAt = new Date().toISOString(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { passed: report.passed, checks: report.checks.length, archive, archiveSha256: report.archiveSha256,
    evidence: directory, report: join(directory, 'report.json'), cleanup: report.cleanup.passed, error: report.error };
}

export function parseEcosystemAcceptanceArguments(args) {
  const options = {}, names = { '--archive': 'archive', '--evidence': 'evidence', '--node': 'nodePath', '--python': 'pythonPath' };
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error('Invalid acceptance option');
    options[key] = value;
  }
  if (!options.archive) throw new Error('--archive requires an actual ecosystem source ZIP');
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await acceptEcosystemArchive(parseEcosystemAcceptanceArguments(process.argv.slice(2))); console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
