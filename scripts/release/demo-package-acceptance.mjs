import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { verifyDemoPackage } from './verify-demo-package.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => {
  const local = relative(resolve(root), resolve(path));
  return Boolean(local) && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local);
};
async function until(read, accept, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await pause(80); }
  throw new Error('Timed out: ' + label);
}

// Inspect names before asking an extractor to create files. Builder ZIPs use a
// single UTF-8 root, regular files, deflate, and no ZIP64 or encrypted members.
export function inspectDemoZip(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  assert.ok(end >= 0, 'ZIP end-of-central-directory is missing');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multi-disk ZIP is not supported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multi-disk ZIP is not supported');
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  assert.ok(count > 0 && count < 2000 && start + length === end, 'Unexpected ZIP directory limits');
  let offset = start, total = 0; const entries = [], seen = new Set(), roots = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP central member');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    assert.equal(flags, 0x800, 'Only unencrypted UTF-8 builder ZIP members are accepted');
    assert.equal(method, 8, 'Only builder deflate members are accepted');
    const compressedBytes = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameBytes = bytes.readUInt16LE(offset + 28), extraBytes = bytes.readUInt16LE(offset + 30), commentBytes = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameBytes + extraBytes + commentBytes;
    assert.ok(next <= end && nameBytes > 0, 'ZIP central member exceeds directory');
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes));
    const parts = path.split('/');
    assert.ok(parts.length > 1 && !path.includes('\\') && !/[:\x00-\x1f]/.test(path)
      && parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
        && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe ZIP path: ' + path);
    assert.ok(!seen.has(path.toLowerCase()), 'Duplicate ZIP path: ' + path); seen.add(path.toLowerCase()); roots.add(parts[0]);
    assert.notEqual((bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000, 0xa000, 'ZIP symlinks are rejected');
    const local = bytes.readUInt32LE(offset + 42);
    assert.ok(local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50, 'Invalid ZIP local member');
    assert.equal(bytes.readUInt16LE(local + 6), flags, 'ZIP local and central flags differ');
    assert.equal(bytes.readUInt16LE(local + 8), method, 'ZIP local and central compression differs');
    const localNameBytes = bytes.readUInt16LE(local + 26), localExtraBytes = bytes.readUInt16LE(local + 28);
    assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameBytes)), path, 'ZIP local and central names differ');
    assert.ok(local + 30 + localNameBytes + localExtraBytes + compressedBytes <= start, 'ZIP local member exceeds data area');
    assert.ok(size < 256 * 1024 * 1024 && compressedBytes < 256 * 1024 * 1024, 'ZIP member exceeds demo package limits');
    total += size; assert.ok(total < 512 * 1024 * 1024, 'ZIP expands beyond demo package limits');
    entries.push({ path, size, compressedBytes }); offset = next;
  }
  assert.equal(offset, end, 'ZIP directory has unparsed bytes'); assert.equal(roots.size, 1, 'ZIP needs one package root');
  return { root: [...roots][0], entries, expandedBytes: total };
}

function cleanEnvironment(portable) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const windows = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const systemPath = [join(windows, 'System32'), windows, join(windows, 'System32/Wbem'), join(windows, 'System32/WindowsPowerShell/v1.0')];
  env.Path = portable ? systemPath.join(';') : [dirname(process.execPath), ...systemPath].join(';');
  return env;
}

function command(program, args, { cwd, env, ipc = false } = {}) {
  const child = spawn(program, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  const record = { program, args, cwd, pid: child.pid, stdout: '', stderr: '', exit: null, spawnError: null, ready: null };
  let pending = '';
  child.stdout.on('data', chunk => {
    const text = chunk.toString('utf8'); record.stdout = (record.stdout + text).slice(-5 * 1024 * 1024); pending += text;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { const receipt = JSON.parse(line); if (receipt.event === 'ready') record.ready = receipt; } catch { /* Preserve human diagnostics in stdout. */ }
    }
    if (pending.length > 1024 * 1024) { record.spawnError = 'Output line exceeds limit'; pending = ''; }
  });
  child.stderr.on('data', chunk => { record.stderr = (record.stderr + chunk.toString('utf8')).slice(-5 * 1024 * 1024); });
  child.on('error', error => { record.spawnError = error.message; });
  const exited = new Promise(ok => child.once('close', (code, signal) => { record.exit = { code, signal }; ok(record.exit); }));
  return { child, record, exited };
}

async function finishCommand(running, timeout = 45000) {
  const value = await until(() => running.record, record => record.exit || record.spawnError, 'command exit', timeout);
  if (value.spawnError) throw new Error(value.spawnError);
  assert.equal(value.exit.code, 0, value.stderr || JSON.stringify(value.exit));
  assert.equal(value.exit.signal, null);
  return value;
}

async function inventory(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'No extracted or generated symlink: ' + entry.name);
    const local = prefix + entry.name, full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(full, local + '/'));
    else {
      assert.ok(entry.isFile());
      try { const bytes = await readFile(full); files.push({ path: local, bytes: bytes.length, sha256: sha(bytes) }); }
      catch (error) { if (error.code !== 'ENOENT' || !entry.name.endsWith('.tmp')) throw error; }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

export async function acceptDemoArchive({ archive, evidence = join(repository, '.artifacts/evidence/demo-packages') }) {
  if (process.platform !== 'win32') throw new Error('Actual CMD/portable acceptance requires Windows');
  archive = resolve(archive); evidence = resolve(evidence);
  await mkdir(evidence, { recursive: true });
  const evidenceDir = join(evidence, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(evidenceDir);
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), archive, evidenceDir, passed: false,
    checks: [], commands: [], cleanup: null };
  const save = (name, value) => writeFile(join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const step = async (name, run) => {
    const check = { name, startedAt: new Date().toISOString(), passed: false }; report.checks.push(check);
    try { check.detail = await run(); check.passed = true; }
    catch (error) { check.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
    finally { check.finishedAt = new Date().toISOString(); console.log(JSON.stringify({ event: 'acceptance-step', name, passed: check.passed })); }
  };
  const ownedCommands = [];
  const launch = (program, args, options) => {
    const running = command(program, args, options); report.commands.push(running.record); ownedCommands.push(running); return running;
  };
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let running = null, bundle, profile, ready, base, beforeFiles;
  try {
    await step('archive checksum and safe ZIP paths', async () => {
      const archiveInfo = await lstat(archive); assert.ok(archiveInfo.isFile() && !archiveInfo.isSymbolicLink());
      const bytes = await readFile(archive), checksum = await readFile(archive + '.sha256', 'utf8');
      const match = checksum.trim().match(/^([a-f0-9]{64}) {2}(.+)$/);
      assert.ok(match, 'Adjacent ZIP checksum file is required'); assert.equal(match[2], basename(archive)); assert.equal(sha(bytes), match[1]);
      const zip = inspectDemoZip(bytes); report.archiveSha256 = match[1]; report.archiveBytes = bytes.length; report.zip = zip;
      await save('archive-input.json', { archive, sha256: match[1], bytes: bytes.length, ...zip });
      return { sha256: match[1], files: zip.entries.length, expandedBytes: zip.expandedBytes };
    });
    await step('actual ZIP extraction into Chinese and space directory', async () => {
      const extraction = join(evidenceDir, '中文 空格 解压'); await mkdir(extraction);
      const extracted = launch(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:WORLD_HUB_DEMO_ARCHIVE -DestinationPath $env:WORLD_HUB_DEMO_EXTRACT -ErrorAction Stop"],
      { cwd: evidenceDir, env: { ...cleanEnvironment(true), WORLD_HUB_DEMO_ARCHIVE: archive, WORLD_HUB_DEMO_EXTRACT: extraction } });
      await finishCommand(extracted);
      bundle = join(extraction, report.zip.root); assert.ok(inside(extraction, bundle));
      const extractedFiles = await inventory(extraction);
      assert.deepEqual(extractedFiles.map(item => item.path).sort(), report.zip.entries.map(item => item.path).sort());
      const integrity = await verifyDemoPackage(bundle); assert.equal(integrity.passed, true, JSON.stringify(integrity.failed));
      const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
      profile = (await import(pathToFileURL(join(bundle, 'examples/purpose-demos/profiles.mjs')).href)).getProfile(manifest.purposeProfile);
      report.profile = profile.id; report.kind = manifest.kind; report.bundle = bundle;
      report.runtime = manifest.kind === 'windows-x64-portable' ? join(bundle, 'runtime/node.exe') : process.execPath;
      beforeFiles = await inventory(bundle); await save('integrity-before.json', integrity); await save('inventory-before.json', beforeFiles);
      return { bundle, kind: manifest.kind, profile: profile.id, files: extractedFiles.length };
    });
    const portable = report.kind === 'windows-x64-portable', env = cleanEnvironment(portable);
    report.runtimeEnvironment = { path: env.Path, portable, globalNodeOnPath: !portable };
    const cwd = join(evidenceDir, '外部 工作目录'); await mkdir(cwd);
    async function wrapper(name, args = []) {
      const invoked = launch(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; $demoArguments=@(ConvertFrom-Json -InputObject $env:WORLD_HUB_DEMO_ARGUMENTS); & $env:WORLD_HUB_DEMO_COMMAND @demoArguments; exit $LASTEXITCODE"],
      { cwd, env: { ...env, WORLD_HUB_DEMO_COMMAND: join(bundle, name + '.cmd'), WORLD_HUB_DEMO_ARGUMENTS: JSON.stringify(args) } });
      return finishCommand(invoked);
    }
    await step('real CMD wrappers use package runtime and foreign cwd without writes', async () => {
      if (portable) {
        const absent = launch(powershell, ['-NoProfile', '-NonInteractive', '-Command',
          "if (Get-Command node -ErrorAction SilentlyContinue) { throw 'Global Node unexpectedly exists on isolated PATH' }"], { cwd, env });
        await finishCommand(absent);
      }
      const checked = await wrapper('check');
      const receipts = checked.stdout.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } });
      const receipt = receipts.find(item => item?.event === 'checked');
      assert.ok(receipt); assert.equal(receipt.passed, true); assert.equal(receipt.persisted, false); assert.equal(receipt.profile, profile.id);
      assert.equal(resolve(receipt.nodeExecutable), resolve(report.runtime), 'CMD must select package runtime');
      const verified = await wrapper('verify'); assert.ok(JSON.parse(verified.stdout).passed);
      const help = await wrapper('start', ['--help']); assert.match(help.stdout, /run-demo\.mjs/);
      await assert.rejects(lstat(join(bundle, 'data')), { code: 'ENOENT' });
      assert.deepEqual(await inventory(bundle), beforeFiles); assert.deepEqual(await readdir(cwd), []);
      return { check: receipt, verifyExit: verified.exit, startHelpExit: help.exit, noDataCreated: true, globalNodeAbsent: portable };
    });
    await step('isolated package launch starts real peer processes and browser program', async () => {
      running = launch(report.runtime, [join(bundle, 'examples/purpose-demos/run-demo.mjs'), '--profile', profile.id], { cwd, env, ipc: true });
      await until(() => running.record, record => record.ready || record.exit || record.spawnError, 'launcher ready', 30000);
      assert.ok(running.record.ready, running.record.stderr || JSON.stringify(running.record.exit));
      ready = running.record.ready; assert.equal(ready.profile, profile.id); assert.equal(ready.pid, running.child.pid);
      assert.equal(resolve(ready.nodeExecutable), resolve(report.runtime));
      assert.equal(ready.pids.length, profile.peers.length + 2); assert.equal(new Set(ready.pids).size, ready.pids.length);
      assert.ok(ready.pids.every(pid => Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)));
      const inspected = launch(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $peerIds=ConvertFrom-Json -InputObject $env:WORLD_HUB_DEMO_OWNED_PIDS; $rows=@(foreach ($peerId in $peerIds) { Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + [int]$peerId) -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine }); ConvertTo-Json -InputObject $rows -Depth 4 -Compress"],
      { cwd, env: { ...env, WORLD_HUB_DEMO_OWNED_PIDS: JSON.stringify(ready.peers.map(peer => peer.pid)) } });
      const processInfo = JSON.parse((await finishCommand(inspected)).stdout);
      assert.ok(Array.isArray(processInfo)); assert.equal(processInfo.length, profile.peers.length);
      for (const peer of ready.peers) {
        const declared = profile.peers.find(item => item.id === peer.id), actual = processInfo.find(item => item.ProcessId === peer.pid);
        assert.ok(declared && actual, 'Each declared peer has its own live OS process');
        const entry = declared.entryFile ?? 'peer.mjs';
        assert.equal(peer.ready.pid, peer.pid); assert.equal(peer.ready.programEntry, entry);
        assert.equal(actual.ParentProcessId, ready.pid, 'Launcher owns the peer process');
        assert.equal(resolve(actual.ExecutablePath).toLowerCase(), resolve(report.runtime).toLowerCase());
        const entryPath = join(bundle, 'examples/purpose-demos', entry).replaceAll('\\', '/').toLowerCase();
        assert.ok(actual.CommandLine.replaceAll('\\', '/').toLowerCase().includes(entryPath), 'Actual OS command line runs the declared independent program entry');
      }
      report.peerProcesses = processInfo; await save('peer-processes.json', processInfo);
      assert.ok(inside(join(bundle, 'data'), ready.stateDirectory), 'Session state remains under package data/');
      base = ready.url; assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      const assets = [];
      for (const path of ['', 'explorer.css', 'explorer.js']) {
        const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 0);
        assets.push({ path: path || '/', bytes: bytes.length, sha256: sha(bytes) });
      }
      await save('ready.json', ready); return { ready, assets, independentProcessEntries: processInfo.length };
    });
    const state = async () => {
      const response = await fetch(new URL('api/state', base), { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); return response.json();
    };
    let token;
    const completed = []; report.actions = completed;
    async function action(id, body) {
      const declaration = profile.actions.find(item => item.id === id); assert.ok(declaration);
      const response = await fetch(new URL('api/action', base), { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-token': token },
        body: JSON.stringify({ id, ...(body === undefined ? {} : { body }) }), signal: AbortSignal.timeout(35000) });
      const payload = await response.json(); assert.equal(response.status, 200, JSON.stringify(payload)); assert.equal(payload.ok, true, JSON.stringify(payload));
      const result = payload.result; assert.equal(result.action, id); assert.ok(result.receipt.seq > 0);
      assert.equal(result.target.principal, declaration.target.principal);
      if (declaration.operation === 'inject') {
        assert.equal(result.response, null);
        const observed = await until(state, data => data.events.some(event => (event.operation ?? 'publish') === 'publish'
          && event.body?.receivedSeq === result.receipt.seq && event.body.ok === true), 'injected program publishes execution result');
        result.observedExecution = observed.events.find(event => event.body?.receivedSeq === result.receipt.seq && event.body.ok === true);
      } else {
        assert.equal(result.response.operation, 'response'); assert.equal(result.response.requestSeq, result.receipt.seq);
        assert.equal(result.response.fromPrincipal, declaration.target.principal); assert.equal(result.response.body.ok, true, JSON.stringify(result.response.body));
      }
      completed.push(result); await save(`action-${completed.length}-${id}.json`, result); return result;
    }
    await step('all declared interface actions return actual provider outcomes', async () => {
      const initial = await state(); token = initial.operationToken; assert.equal(typeof token, 'string');
      assert.equal(initial.profile.id, profile.id); assert.equal(initial.peers.length, profile.peers.length); assert.equal(initial.explorer.connected, true);
      assert.equal(initial.failures.length, 0); await save('state-initial.json', initial);
      if (profile.id === 'event-desk') await until(state, data => data.events.some(event => event.body?.latest?.sensor && event.body.latest.market), 'both event sources reach aggregator');
      for (const declared of profile.actions) await action(declared.id);
      return { actions: completed.map(result => ({ id: result.action, seq: result.receipt.seq, responded: Boolean(result.response), injectionObserved: Boolean(result.observedExecution) })) };
    });
    await step('repeated use produces additional results and changed external state', async () => {
      let compositionProof;
      if (profile.id === 'event-desk') {
        const reading = await action('sensor-reading'); assert.equal(reading.response.body.offset, 8);
        assert.equal(reading.response.body.intervalMs, 900); assert.equal(Object.keys(reading.response.body.bridgeMapping).length, 2);
        await until(state, data => data.events.some(event => event.body?.kind === 'demo.summary-updated'
          && event.body.latest.sensor?.value.temperature > 26 && event.body.latest.market?.value.price >= 126), 'updated sources reach aggregator');
        const latest = await action('summary'), first = completed.find(result => result.action === 'summary');
        assert.ok(latest.response.body.received > first.response.body.received);
        assert.ok(latest.response.body.latest.sensor.seq > 0 && latest.response.body.latest.market.seq > 0);
        const sensor = ready.peers.find(peer => peer.id === 'sensor'); assert.equal(sensor.ready.bridges.length, 2);
        assert.equal(new Set(sensor.ready.bridges.map(bridge => bridge.session)).size, 2);
        assert.equal(new Set(sensor.ready.bridges.map(bridge => bridge.principal)).size, 1);
        const traffic = ready.peers.find(peer => peer.id === 'traffic');
        assert.equal(traffic.ready.programEntry, 'traffic-source.mjs');
        assert.ok(!traffic.ready.bridges[0].channels.some(channel => channel.name === 'demo/event-desk/traffic/sample'), 'New topic is absent at initial peer readiness');
        const paused = (await action('traffic-disable', { command: 'disable' })).response.body;
        assert.equal(paused.enabled, false); assert.equal(paused.topicRegistered, true);
        await pause(1250);
        assert.equal((await action('traffic-reading')).response.body.count, paused.count, 'External source actually pauses');
        const history = (await action('summary')).response.body;
        assert.ok(history.latest.traffic.seq > 0, 'Pausing preserves previously supplied information');
        const activated = (await action('traffic-enable', { command: 'enable' })).response.body;
        assert.equal(activated.enabled, true); assert.equal(activated.topicRegistered, true);
        assert.equal(activated.declaredTopic, 'demo/event-desk/traffic/sample');
        assert.equal(activated.principal, traffic.ready.principal);
        // The program reports its configured bridge declaration; deliveries
        // below identify the authenticated live bridge assigned by the Hub.
        assert.equal(activated.bridge, traffic.ready.bridges[0].declaredId);
        assert.ok(activated.count > paused.count);
        await until(state, data => data.events.some(event => event.body?.kind === 'demo.summary-updated'
          && event.body.latest.traffic?.seq > history.latest.traffic.seq), 'New independently provided traffic sample reaches external aggregator');
        const threeSources = (await action('summary')).response.body;
        assert.deepEqual(Object.keys(threeSources.latest).sort(), ['market', 'sensor', 'traffic']);
        assert.equal(threeSources.latest.traffic.from, traffic.ready.bridges[0].bridgeId);
        assert.equal(threeSources.latest.traffic.topic, activated.declaredTopic);
        assert.equal(threeSources.latest.traffic.value.kind, 'demo.traffic-reading');
        assert.ok(threeSources.latest.traffic.value.vehicles > 0);
        assert.ok(threeSources.latest.traffic.seq > history.latest.traffic.seq);
        compositionProof = { type: 'new-independent-source-and-topic', peer: traffic, retainedBeforeResume: history.latest.traffic,
          registeredTopic: activated.declaredTopic, latest: threeSources.latest };
      } else if (profile.id === 'modular-assistant') {
        const result = (await action('compose')).response.body;
        assert.equal(result.modelInvoked, false); assert.equal(result.mode, 'deterministic-template');
        assert.equal(result.context.systemPrompt, profile.actions.find(item => item.id === 'system-update').body.systemPrompt);
        assert.equal(result.context.material, profile.actions.find(item => item.id === 'material-update').body.text);
        assert.ok(result.context.messages.some(item => item.content === profile.actions.find(action => action.id === 'dialogue-update').body.content));
        assert.equal(new Set(result.sources.map(item => item.principal)).size, 3);
        assert.ok(result.sources.every(item => item.requestSeq < item.responseSeq));
        assert.ok(result.harness.requestSeq < result.harness.responseSeq); assert.ok(result.answer.length > 0);
        const baseline = ready.peers.find(peer => peer.id === 'harness'), extension = ready.peers.find(peer => peer.id === 'extension');
        const replacement = ready.peers.find(peer => peer.id === 'checklist');
        assert.notEqual(baseline.pid, replacement.pid); assert.notEqual(baseline.ready.programEntry, replacement.ready.programEntry);
        assert.equal(extension.ready.programEntry, 'extension-material.mjs'); assert.equal(replacement.ready.programEntry, 'checklist-harness.mjs');
        const prompt = '请列出可以独立替换的模块，并考虑新增的扩展约束。';
        const original = (await action('compose-extension', { prompt, materialProviders: ['material', 'extension'], harnessProvider: 'harness' })).response.body;
        const replaced = (await action('compose-checklist', { prompt, materialProviders: ['material', 'extension'], harnessProvider: 'checklist' })).response.body;
        assert.deepEqual(original.sources.map(item => item.provider), ['system', 'dialogue', 'material', 'extension']);
        assert.deepEqual(replaced.sources.map(item => item.provider), ['system', 'dialogue', 'material', 'extension']);
        for (const answer of [original, replaced]) {
          assert.equal(answer.modelInvoked, false); assert.equal(answer.context.messages.at(-1).content, prompt);
          assert.equal(new Set(answer.sources.map(item => item.principal)).size, 4);
          for (const source of answer.sources) {
            const provider = ready.peers.find(peer => peer.id === source.provider); assert.ok(provider);
            assert.equal(source.principal, provider.ready.principal); assert.equal(source.bridge, provider.ready.bridges[0].bridgeId);
            assert.ok(source.requestSeq > 0 && source.requestSeq < source.responseSeq);
          }
          assert.ok(answer.harness.requestSeq > 0 && answer.harness.requestSeq < answer.harness.responseSeq);
          assert.equal(answer.context.materials.at(-1).text, profile.actions.find(item => item.id === 'extension-update').body.text);
          assert.ok(answer.answer.includes(answer.context.materials.at(-1).text));
        }
        assert.equal(original.harness.principal, baseline.ready.principal); assert.equal(original.harness.bridge, baseline.ready.bridges[0].bridgeId);
        assert.equal(replaced.harness.principal, replacement.ready.principal); assert.equal(replaced.harness.bridge, replacement.ready.bridges[0].bridgeId);
        assert.equal(original.executorImplementation, 'context-echo-template'); assert.equal(replaced.executorImplementation, 'source-checklist');
        assert.equal(original.mode, 'deterministic-template'); assert.equal(replaced.mode, 'deterministic-checklist');
        assert.deepEqual(original.context.materials, replaced.context.materials); assert.equal(original.context.systemPrompt, replaced.context.systemPrompt);
        assert.notEqual(original.answer, replaced.answer); assert.match(replaced.answer, /模块检查清单/);
        assert.equal(replaced.checklist.length, 4);
        for (const item of replaced.checklist) {
          const source = replaced.sources.find(source => source.provider === item.provider); assert.ok(source);
          for (const key of ['principal', 'requestSeq', 'responseSeq']) assert.equal(item[key], source[key]);
        }
        assert.ok(replaced.context.messages.some(item => item.role === 'assistant' && item.content === original.answer), 'Real dialogue program retains the previous interaction');
        compositionProof = { type: 'four-sources-and-independent-executor-replacement', sharedPrompt: prompt,
          sourceCountBefore: result.sources.length, sourceCountAfter: replaced.sources.length,
          baseline: { pid: baseline.pid, entry: baseline.ready.programEntry, harness: original.harness, implementation: original.executorImplementation, answer: original.answer },
          replacement: { pid: replacement.pid, entry: replacement.ready.programEntry, harness: replaced.harness, implementation: replaced.executorImplementation, answer: replaced.answer },
          sources: replaced.sources };
      } else if (profile.id === 'digital-world') {
        const advanced = (await action('advance')).response.body;
        assert.deepEqual(advanced.initialState, { turn: 0, energy: 8, inventory: 0, position: 0, weather: '晴朗' });
        assert.equal(advanced.timeline.length, profile.actions.find(item => item.id === 'advance').body.rounds);
        assert.equal(advanced.finalState.turn, advanced.timeline.length); assert.ok(advanced.receipts.every(item => item.requestSeq < item.responseSeq));
        const rested = (await action('rest')).response.body;
        assert.deepEqual(rested.initialState, advanced.finalState, 'Each new run starts from the actual external state');
        assert.ok(rested.finalState.turn > advanced.finalState.turn && rested.finalState.energy > advanced.finalState.energy);
        assert.ok(rested.timeline.every(item => item.npc.includes('两份补给')));
        const snapshot = (await action('world-snapshot')).response.body; assert.deepEqual(snapshot.world, rested.finalState);
        compositionProof = { type: 'multi-round-external-state', initialState: advanced.initialState,
          firstFinalState: advanced.finalState, nextInitialState: rested.initialState, finalState: rested.finalState,
          timeline: [...advanced.timeline, ...rested.timeline], receipts: [...advanced.receipts, ...rested.receipts] };
      } else throw new Error('Unknown demo acceptance profile');
      report.compositionProof = compositionProof; await save('composition-proof.json', compositionProof);
      assert.ok(completed.length > profile.actions.length); return { completed: completed.length, repeatsProduceResults: true, compositionProof };
    });
    await step('downloaded export and external program state agree with outcomes', async () => {
      const response = await fetch(new URL('api/export', base), { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
      const exported = await response.json(); assert.equal(exported.profile.id, profile.id); assert.equal(exported.results.length, completed.length);
      assert.equal(exported.failures.length, 0); assert.ok(exported.results.every(result => result.receipt.seq > 0));
      assert.ok(exported.events.some(event => event.operation === 'response'));
      await save('downloaded-export.json', exported);
      const files = await inventory(ready.stateDirectory); await save('business-data-inventory.json', files);
      assert.ok(files.some(item => item.path === 'explorer-results.json'));
      const readState = async local => { const value = JSON.parse(await readFile(join(ready.stateDirectory, local), 'utf8')); await save(local.replaceAll('/', '-') + '.json', value); return value; };
      if (profile.id === 'event-desk') {
        assert.equal((await readState('programs/sensor/source-state.json')).offset, 8);
        assert.equal((await readState('programs/market/source-state.json')).base, 130);
        const aggregate = await readState('programs/aggregator/summary-state.json'); assert.ok(aggregate.latest.sensor && aggregate.latest.market);
        assert.ok(aggregate.latest.traffic.seq > 0); assert.equal(aggregate.latest.traffic.value.kind, 'demo.traffic-reading');
        const traffic = await readState('programs/traffic/traffic-state.json'); assert.equal(traffic.enabled, true); assert.ok(traffic.count > 0);
      } else if (profile.id === 'modular-assistant') {
        const composer = await readState('programs/composer/last-result.json'), harness = await readState('programs/harness/harness-state.json');
        const checklist = await readState('programs/checklist/checklist-state.json'), extension = await readState('programs/extension/extension-state.json');
        const compositions = completed.filter(result => result.response?.body.kind === 'demo.distributed-assistant-result');
        const templateRuns = compositions.filter(result => result.response.body.harnessProvider === 'harness');
        const checklistRuns = compositions.filter(result => result.response.body.harnessProvider === 'checklist');
        assert.equal(composer.completed, compositions.length); assert.equal(harness.completed, templateRuns.length);
        assert.equal(checklist.completed, checklistRuns.length); assert.ok(templateRuns.length > 0 && checklistRuns.length > 0);
        assert.equal(composer.lastResult.answer, compositions.at(-1).response.body.answer);
        assert.equal(harness.lastResult.answer, templateRuns.at(-1).response.body.answer);
        assert.equal(checklist.lastResult.answer, checklistRuns.at(-1).response.body.answer);
        assert.equal(extension.text, profile.actions.find(item => item.id === 'extension-update').body.text);
        assert.equal((await readState('programs/dialogue/context-state.json')).messages.at(-1).content, composer.lastResult.answer);
      } else {
        const director = await readState('programs/director/last-run.json'), world = await readState('programs/state/world-state.json');
        assert.ok(director.completed >= 4); assert.deepEqual(director.lastResult.finalState, world.world);
        assert.equal((await readState('programs/npc/npc-state.json')).mood, 'friendly');
      }
      report.actions = completed; return { downloadResults: exported.results.length, dataFiles: files.length, externalBusinessStateChecked: true };
    });
    report.passed = true;
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    const cleanup = { launcherExit: null, processes: [], errors: [], passed: true };
    if (running) {
      try {
        if (!running.record.exit && running.child.connected) running.child.send({ type: 'stop' });
        await until(() => running.record.exit, Boolean, 'owned launcher graceful exit', 45000);
        cleanup.launcherExit = running.record.exit; assert.equal(cleanup.launcherExit.code, 0); assert.equal(cleanup.launcherExit.signal, null);
        if (ready) {
          for (const pid of [...ready.pids, ready.pid]) {
            await until(() => pidAlive(pid), alive => !alive, 'owned pid exits: ' + pid, 5000);
            cleanup.processes.push({ pid, alive: false });
          }
          const stopped = JSON.parse(await readFile(join(ready.stateDirectory, 'stopped.json'), 'utf8'));
          assert.deepEqual(stopped.pids, ready.pids); assert.ok(stopped.exits.every(exit => exit?.code === 0 && exit.signal === null));
          cleanup.childrenExitReceipts = stopped; await save('stopped.json', stopped);
        }
      } catch (error) { cleanup.passed = false; cleanup.errors.push({ message: error.message, stack: error.stack }); }
      finally { if (running.child.connected) running.child.disconnect(); }
    }
    if (bundle) {
      try {
        const integrity = await verifyDemoPackage(bundle); cleanup.integrityAfterStop = integrity;
        assert.equal(integrity.passed, true, JSON.stringify(integrity.failed)); await save('integrity-after-stop.json', integrity);
        const allFiles = await inventory(bundle), immutable = allFiles.filter(item => !item.path.startsWith('data/'));
        assert.deepEqual(immutable, beforeFiles); await save('inventory-after-stop.json', allFiles);
      } catch (error) { cleanup.passed = false; cleanup.errors.push({ message: error.message, stack: error.stack }); }
    }
    for (const owned of ownedCommands) {
      if (owned.record.exit || owned.record.spawnError) continue;
      cleanup.passed = false;
      cleanup.errors.push({ message: 'Owned command did not exit normally', pid: owned.child.pid, program: owned.record.program });
      // Only the child handle created above may be terminated. Never use a PID
      // discovered from the filesystem or process inventory as a kill target.
      owned.child.kill();
      try { await until(() => owned.record.exit, Boolean, 'owned command cleanup', 5000); }
      catch (error) { cleanup.errors.push({ pid: owned.child.pid, message: error.message }); owned.child.unref(); owned.child.stdout.destroy(); owned.child.stderr.destroy(); }
    }
    report.cleanup = cleanup; report.passed &&= cleanup.passed; report.endedAt = new Date().toISOString();
    await save('report.json', report);
  }
  return { passed: report.passed, profile: report.profile, kind: report.kind, checks: report.checks.length,
    actions: report.actions?.length ?? 0, evidenceDir, report: join(evidenceDir, 'report.json'), error: report.error?.message, cleanup: report.cleanup.passed };
}

export function parseDemoAcceptanceArguments(args) {
  const options = {}, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], key = { '--archive': 'archive', '--evidence': 'evidence' }[flag];
    if (!key || seen.has(key)) throw new Error('Unknown or duplicate argument: ' + flag);
    seen.add(key); const value = args[++index];
    if (!value || !value.trim() || value.startsWith('--')) throw new Error('Missing value for ' + flag);
    options[key] = value;
  }
  if (!options.archive) throw new Error('Use --archive <builder ZIP> [--evidence <evidence root>]');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await acceptDemoArchive(parseDemoAcceptanceArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
