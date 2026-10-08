import { runtimeForBundle } from './runtime-helper.mjs';
// Source-only acceptance of the literal bundled onboarding example. Writable
// work happens in retained copies; never start a Hub in the supplied extraction.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const PROCESS_TIMEOUT = 20_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--bundle', '--evidence'].includes(name) || Object.hasOwn(args, name.slice(2))) throw new Error(`unknown or duplicate argument: ${name}`);
    const value = argv[++index];
    if (!value || !isAbsolute(value)) throw new Error(`${name} requires an absolute path`);
    args[name.slice(2)] = resolve(value);
  }
  if (!args.bundle || !args.evidence) throw new Error('usage: node document-onboarding-check.mjs --bundle <absolute actual extraction> --evidence <new absolute directory>');
  if (args.evidence === args.bundle || args.evidence.startsWith(args.bundle + sep)) throw new Error('evidence must be outside the supplied bundle');
  return args;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function inventory(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name), local = relative(root, file).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`unexpected symbolic link: ${file}`);
      if (entry.isDirectory()) { entries.push({ path: local, kind: 'directory' }); await visit(file); }
      else if (entry.isFile()) entries.push({ path: local, kind: 'file', bytes: (await stat(file)).size, sha256: await fileHash(file) });
      else throw new Error(`unexpected nonregular entry: ${file}`);
    }
  }
  await visit(root); return entries;
}
function firstFence(document, language) {
  const match = new RegExp(`(?:^|\\r?\\n)~~~${language}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n~~~(?:\\r?\\n|$)`).exec(document);
  assert.ok(match, `first ${language} code fence exists`); return match[1];
}
function bounded(promise, ms, description, signal) {
  let timer, abort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out after ${ms} ms`)), ms);
    abort = () => reject(signal.reason ?? new Error('acceptance interrupted'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}
async function listening(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const settle = value => { if (settled) return; settled = true; socket.destroy(); done(value); };
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false)); socket.setTimeout(1000, () => settle(false));
  });
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function diskMessages(directory) {
  const records = [];
  for (const name of (await readdir(directory)).filter(name => /^log-\d+\.jsonl$/.test(name)).sort()) {
    const text = await readFile(join(directory, name), 'utf8');
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.kind === 'message') records.push({ file: name, raw: line, record });
    }
  }
  return records;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.evidence, { recursive: false });
  const controller = new AbortController();
  const interrupt = signal => controller.abort(new Error(`acceptance interrupted by ${signal}`));
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const overallTimer = setTimeout(() => controller.abort(new Error('acceptance exceeded 180000 ms')), 180_000);
  const temporaryRoot = join(tmpdir(), `枢纽 文档接入 ${randomUUID()}`);
  const bundleCopy = join(temporaryRoot, '中文 空格 整合包副本');
  const deniedBundleCopy = join(temporaryRoot, '未登记桥 第二个整合包副本');
  const programDirectory = join(temporaryRoot, '自己的 外部程序目录');
  const foreignCwd = join(temporaryRoot, '与包 无关工作目录');
  const children = [], ports = new Set(), steps = [];
  const report = { passed: false, startedAt: new Date().toISOString(), suppliedBundle: args.bundle, evidence: args.evidence,
    sourceHarnessNode: process.versions.node, temporaryRoot, bundleCopy, deniedBundleCopy, programDirectory, foreignCwd, steps, children: [] };
  const save = (name, value) => writeFile(join(args.evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  async function step(name, action) {
    controller.signal.throwIfAborted(); report.activeStep = name;
    try {
      const detail = await action(); controller.signal.throwIfAborted(); steps.push({ name, passed: true, at: new Date().toISOString(), detail });
      console.log(JSON.stringify({ event: 'document-onboarding', name, passed: true })); report.activeStep = null; return detail;
    } catch (error) { steps.push({ name, passed: false, at: new Date().toISOString(), error: error.message }); throw error; }
  }
  function start(command, argv, { ipc = false, label }) {
    const child = spawn(command, argv, { cwd: foreignCwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    const record = { label, pid: child.pid, executable: command, argv, cwd: foreignCwd, stdout: '', stderr: '', messages: [], exit: null };
    const managed = { child, record, ipc }; children.push(managed); report.children.push(record);
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8'); child[stream].on('data', value => {
        if (record[stream].length + value.length > OUTPUT_LIMIT) { record.outputTruncated = true; record[stream] = (record[stream] + value).slice(0, OUTPUT_LIMIT); }
        else record[stream] += value;
      });
    }
    let acceptReady, rejectReady;
    managed.ready = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; }); managed.ready.catch(() => {});
    managed.exited = new Promise((accept, reject) => {
      child.once('error', error => { record.spawnError = error.message; rejectReady(error); reject(error); });
      child.once('close', (code, signal) => { record.exit = { code, signal }; if (!record.ready) rejectReady(new Error(`${label} exited before ready (${code}): ${record.stderr}`)); accept(record.exit); });
    }); managed.exited.catch(() => {});
    if (ipc) child.on('message', message => {
      record.messages.push(message);
      if (message?.type === 'ready') { record.ready = message; if (Number.isInteger(message.port)) ports.add(message.port); acceptReady(message); }
      else if (message?.type === 'error') rejectReady(new Error(message.message));
    });
    return managed;
  }
  async function command(executable, argv, label, { expectedCode = 0 } = {}) {
    const child = start(executable, argv, { label });
    await bounded(child.exited, PROCESS_TIMEOUT, label, controller.signal);
    assert.equal(child.record.outputTruncated, undefined, `${label}: output stays bounded`);
    assert.deepEqual(child.record.exit, { code: expectedCode, signal: null }, `${label}: ${child.record.stderr}`);
    return child.record;
  }
  async function stop(managed) {
    if (managed.record.exit) return managed.record.exit;
    if (managed.ipc && managed.child.connected) managed.child.send({ type: 'stop' }, () => {});
    else managed.child.kill('SIGTERM');
    try { return await bounded(managed.exited, 8000, `${managed.record.label} graceful stop`); }
    catch (error) {
      managed.record.stopFallback = error.message;
      managed.child.kill('SIGKILL');
      return bounded(managed.exited, 5000, `${managed.record.label} owned forced stop`);
    }
  }
  async function management(base) {
    const response = await fetch(base + '/manage/api/state', { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); return response.json();
  }
  let originalInventory, running, nodeExecutable, originalNode;
  try {
    await mkdir(foreignCwd, { recursive: true });
    await mkdir(programDirectory, { recursive: true });
    const manifest = JSON.parse(await readFile(join(args.bundle, 'manifest.json'), 'utf8'));
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'current package version');
    originalNode = await runtimeForBundle(args.bundle); await stat(originalNode);
    await step('original extraction strictly verifies and is inventoried', async () => {
      originalInventory = await inventory(args.bundle); await save('original-inventory-before.json', originalInventory);
      const verify = await command(originalNode, [join(args.bundle, 'scripts/release/verify-package.mjs'), '--root', args.bundle], 'original strict verify before');
      const result = JSON.parse(verify.stdout); assert.equal(result.passed, true);
      await save('original-verify-before.json', result); report.manifestVersion = manifest.version; return result;
    });
    await step('literal documentation and config-only merge in independent copy', async () => {
      await cp(args.bundle, bundleCopy, { recursive: true, force: false, errorOnExist: true });
      assert.deepEqual(await inventory(bundleCopy), originalInventory, 'independent copy initially matches the supplied bundle');
      nodeExecutable = await runtimeForBundle(bundleCopy);
      const documentPath = join(bundleCopy, 'docs/onboarding.md'), documentBytes = await readFile(documentPath);
      const document = documentBytes.toString('utf8'), jsonCode = firstFence(document, 'json'), programCode = firstFence(document, 'js');
      const fragment = JSON.parse(jsonCode), entry = fragment.acl?.bridges?.['my.program'];
      assert.ok(entry && typeof entry === 'object', 'document contributes my.program ACL');
      assert.match(programCode, /bridgeId:\s*['"]my\.program['"]/, 'document program uses the newly registered principal');
      assert.match(programCode, /autoAck:\s*false/, 'document keeps ACK policy manual');
      const connectIndex = programCode.indexOf('await bridge.connect(');
      for (const event of ['error', 'denied']) {
        const listener = new RegExp(`bridge\\.on\\(['"]${event}['"]`).exec(programCode);
        assert.ok(listener && listener.index < connectIndex, `document registers ${event} before connect`);
      }
      assert.match(programCode, /\bcatch\s*\(/, 'document explicitly catches promise rejection');
      assert.doesNotMatch(programCode, /\.release(?:Blob)?\s*\(/, 'document sends no provider release');
      const kind = /kind:\s*(['"])([^'"\\]*)\1/.exec(programCode)?.[2];
      const channel = /name:\s*(['"])([^'"\\]*)\1/.exec(programCode)?.[2];
      assert.ok(kind && channel, 'example declares its own kind and channel');
      const configPath = join(bundleCopy, 'config/hub.json'), beforeBytes = await readFile(configPath), config = JSON.parse(beforeBytes);
      assert.ok(config.acl?.bridges && !Object.hasOwn(config.acl.bridges, 'my.program'), 'fresh default ACL can accept the new item without replacing anything');
      const merged = structuredClone(config); merged.acl.bridges['my.program'] = entry;
      const onlyOld = structuredClone(merged); delete onlyOld.acl.bridges['my.program']; assert.deepEqual(onlyOld, config, 'every default setting and credential is preserved');
      const afterBytes = Buffer.from(JSON.stringify(merged, null, 2) + '\n'); await writeFile(configPath, afterBytes);
      const programPath = join(programDirectory, 'my-program.mjs'); await writeFile(programPath, programCode, { flag: 'wx' });
      assert.equal(await fileHash(programPath), sha256(Buffer.from(programCode)), 'external program is byte-for-byte the JS fence');
      report.documentation = { documentPath, sha256: sha256(documentBytes), jsonFenceSha256: sha256(Buffer.from(jsonCode)), jsFenceSha256: sha256(Buffer.from(programCode)),
        externalProgram: programPath, externalProgramSha256: await fileHash(programPath), configPath, configBeforeSha256: sha256(beforeBytes), configAfterSha256: sha256(afterBytes), kind, channel };
      await save('literal-example.mjs', programCode); await save('acl-fragment.json', jsonCode); await save('copy-config-before.json', beforeBytes.toString('utf8')); await save('copy-config-after.json', afterBytes.toString('utf8'));
      return report.documentation;
    });
    await step('package launcher and literal external program use the selected package runtime', async () => {
      running = start(nodeExecutable, [join(bundleCopy, 'scripts/launcher.mjs'), '--port', '0'], { ipc: true, label: 'copy Hub launcher' });
      const ready = await bounded(running.ready, PROCESS_TIMEOUT, 'copy Hub ready', controller.signal);
      assert.ok(Number.isInteger(ready.port) && ready.port > 0); assert.equal(new URL(ready.wsUrl).port, String(ready.port));
      assert.ok(ready.configPath.startsWith(bundleCopy + sep));
      const baseline = await management(ready.httpUrl); await save('management-before-program.json', baseline);
      const external = await command(nodeExecutable, [report.documentation.externalProgram, bundleCopy, ready.wsUrl], 'literal documentation program');
      const events = external.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const connected = events.find(event => event.event === 'connected'), published = events.find(event => event.event === 'published'), registered = events.find(event => event.event === 'registered');
      assert.equal(connected?.principal, 'my.program'); assert.ok(Number.isSafeInteger(published?.seq) && published.seq > 0);
      assert.ok(registered?.channels?.some(channel => channel.name === report.documentation.channel && channel.publish === true), 'SDK dynamic registration exposes the program-defined channel');
      const state = await management(ready.httpUrl); await save('management-after-program.json', state);
      const disk = await diskMessages(ready.storage.log.path);
      const message = disk.find(item => item.record.seq === published.seq); assert.ok(message, 'published sequence exists in the actual disk log');
      assert.equal(message.record.owner, 'my.program'); assert.equal(message.record.from, 'my.program'); assert.equal(message.record.topic, report.documentation.channel);
      assert.equal(message.record.body.kind, report.documentation.kind); assert.equal(JSON.parse(message.record.bodyRaw).kind, report.documentation.kind);
      assert.equal(state.hub.storage.log.releasedCount, baseline.hub.storage.log.releasedCount, 'no provider release is caused by publish or program exit');
      assert.ok(state.hub.storage.log.protectedCount >= baseline.hub.storage.log.protectedCount + 1, 'unreleased input remains protected');
      assert.ok(!state.events.some(event => event.kind === 'message.released' && event.seq?.includes(published.seq)), 'sample message was never released');
      let releases = { version: 1, seq: [] };
      try { releases = JSON.parse(await readFile(join(ready.storage.log.path, 'releases.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(!releases.seq.includes(published.seq), 'disk release metadata excludes the sample message');
      await save('example-events.json', events); await save('sample-disk-record.json', message); await save('sample-disk-record.jsonl', message.raw + '\n'); await save('release-metadata.json', releases);
      report.observed = { principal: connected.principal, seq: published.seq, channels: registered.channels, bodyKind: message.record.body.kind,
        protectedCountBefore: baseline.hub.storage.log.protectedCount, protectedCountAfter: state.hub.storage.log.protectedCount,
        releasedCountBefore: baseline.hub.storage.log.releasedCount, releasedCountAfter: state.hub.storage.log.releasedCount, providerReleaseRequests: 0 };
      return report.observed;
    });
    await step('owned Hub stops and copy accepts only its intentional config change', async () => {
      const exit = await stop(running); assert.deepEqual(exit, { code: 0, signal: null }); assert.equal(running.record.stopFallback, undefined);
      assert.ok(running.record.stdout.includes('"event":"stopped"')); assert.equal(await listening(running.record.ready.port), false);
      const copiedVerify = await command(nodeExecutable, [join(bundleCopy, 'scripts/release/verify-package.mjs'), '--root', bundleCopy, '--allow-config-change'], 'copy verify allow config change');
      const result = JSON.parse(copiedVerify.stdout); assert.equal(result.passed, true); assert.deepEqual(result.skippedConfiguration, ['config/hub.json']);
      assert.ok(!report.documentation.externalProgram.startsWith(bundleCopy + sep), 'external program is outside the manifest tree');
      await save('copy-verify-allow-config-change.json', result); return { exit, verify: result };
    });
    await step('same literal program handles unregistered identity in a second package', async () => {
      await cp(args.bundle, deniedBundleCopy, { recursive: true, force: false, errorOnExist: true });
      assert.deepEqual(await inventory(deniedBundleCopy), originalInventory, 'second independent copy initially matches the original');
      const deniedConfigPath = join(deniedBundleCopy, 'config/hub.json'), deniedConfigBefore = await readFile(deniedConfigPath);
      const deniedConfig = JSON.parse(deniedConfigBefore);
      assert.ok(!Object.hasOwn(deniedConfig.acl.bridges, 'my.program'), 'second package deliberately has no my.program ACL item');
      const deniedNode = await runtimeForBundle(deniedBundleCopy);
      const deniedHub = start(deniedNode, [join(deniedBundleCopy, 'scripts/launcher.mjs'), '--port', '0'], { ipc: true, label: 'unregistered second Hub launcher' });
      const ready = await bounded(deniedHub.ready, PROCESS_TIMEOUT, 'unregistered second Hub ready', controller.signal);
      const before = await management(ready.httpUrl); await save('denied-management-before.json', before);
      const external = await command(deniedNode, [report.documentation.externalProgram, deniedBundleCopy, ready.wsUrl], 'literal documentation program expected denial', { expectedCode: 1 });
      const output = external.stdout + '\n' + external.stderr;
      assert.doesNotMatch(output, /^\s+at\s|^Error:|^node:|^file:|UnhandledPromiseRejection|triggerUncaughtException/m, 'expected denial is handled without an unhandled stack');
      const stdoutEvents = external.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const stderrEvents = external.stderr.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const events = [...stdoutEvents, ...stderrEvents];
      assert.ok(!events.some(event => ['connected', 'registered', 'published'].includes(event.event)), 'the unregistered bridge cannot connect or publish');
      const deniedIndex = events.findIndex(event => /denied/i.test(event.event) && event.code === 'BRIDGE_NOT_REGISTERED');
      const failedIndex = events.findIndex(event => /failed|failure/i.test(event.event) && event.code === 'BRIDGE_NOT_REGISTERED');
      assert.ok(deniedIndex >= 0 && failedIndex > deniedIndex, 'early denied listener is observed before the promise catch JSON failure');
      assert.ok(events[failedIndex].message, 'catch provides a readable failure reason');
      const after = await management(ready.httpUrl); await save('denied-management-after.json', after);
      assert.equal(after.hub.hubId, before.hub.hubId, 'second Hub remains healthy after denying the program');
      assert.equal(after.hub.lastSeq, before.hub.lastSeq, 'denied program appends no message');
      assert.equal(after.hub.storage.log.protectedCount, before.hub.storage.log.protectedCount);
      assert.equal(after.hub.storage.log.releasedCount, before.hub.storage.log.releasedCount);
      assert.ok(!after.hub.bridges.some(bridge => bridge.principal === 'my.program'));
      assert.equal(sha256(await readFile(deniedConfigPath)), sha256(deniedConfigBefore), 'negative test never edits the second package config');
      const exit = await stop(deniedHub); assert.deepEqual(exit, { code: 0, signal: null }); assert.equal(deniedHub.record.stopFallback, undefined);
      assert.ok(deniedHub.record.stdout.includes('"event":"stopped"')); assert.equal(await listening(ready.port), false);
      const verify = await command(deniedNode, [join(deniedBundleCopy, 'scripts/release/verify-package.mjs'), '--root', deniedBundleCopy], 'unregistered second package strict verify');
      const integrity = JSON.parse(verify.stdout); assert.equal(integrity.passed, true); assert.deepEqual(integrity.skippedConfiguration, []);
      await save('denied-example-events.json', { stdout: stdoutEvents, stderr: stderrEvents }); await save('denied-copy-strict-verify.json', integrity);
      report.expectedDenial = { expectedProgramExit: 1, actualExit: external.exit, code: events[failedIndex].code, message: events[failedIndex].message,
        deniedBeforeCatch: true, unhandledStack: false, hubHealthyAfterDenial: true, hubExit: exit, port: ready.port,
        configSha256: sha256(deniedConfigBefore), externalProgramSha256: await fileHash(report.documentation.externalProgram), strictVerify: integrity.passed };
      return report.expectedDenial;
    });
    await step('original strict verify and inventory remain unchanged', async () => {
      const strict = await command(originalNode, [join(args.bundle, 'scripts/release/verify-package.mjs'), '--root', args.bundle], 'original strict verify after');
      const result = JSON.parse(strict.stdout); assert.equal(result.passed, true); await save('original-verify-after.json', result);
      const after = await inventory(args.bundle); assert.deepEqual(after, originalInventory, 'supplied files, data and directories were never modified'); await save('original-inventory-after.json', after);
      assert.deepEqual(await inventory(foreignCwd), [], 'unrelated cwd acquired no accidental program state or Hub data');
      return { verifiedFiles: result.checkedFiles, originalUnchanged: true, foreignCwdEmpty: true };
    });
    report.passed = true;
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }; console.error(error.stack ?? error);
  } finally {
    clearTimeout(overallTimer);
    const cleanupErrors = [];
    for (const managed of [...children].reverse()) try { await stop(managed); } catch (error) { cleanupErrors.push({ pid: managed.child.pid, message: error.message }); }
    report.listenersAfterStop = await Promise.all([...ports].map(async port => ({ port, listening: await listening(port) })));
    report.pidsAfterStop = children.filter(managed => Number.isInteger(managed.record.pid)).map(managed => ({ pid: managed.record.pid, alive: pidAlive(managed.record.pid), label: managed.record.label }));
    report.allProcessesGone = report.pidsAfterStop.every(item => !item.alive); report.noListeners = report.listenersAfterStop.every(item => !item.listening);
    report.cleanupErrors = cleanupErrors; report.passed &&= report.allProcessesGone && report.noListeners && cleanupErrors.length === 0;
    report.endedAt = new Date().toISOString();
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
    await save('report.json', report);
    console.log(JSON.stringify({ passed: report.passed, checks: steps.length, report: join(args.evidence, 'report.json'), retainedCopy: bundleCopy, externalProgram: report.documentation?.externalProgram }));
    if (!report.passed) process.exitCode = 1;
  }
}
run().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
