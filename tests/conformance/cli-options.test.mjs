import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, readdir, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(ROOT, 'src/hub/hub-server.mjs');
const OWNED_ENTRY = join(ROOT, 'examples/distributed-context/hub-process.mjs');
const records = [];
const evidence = process.env.HUB_CLI_EVIDENCE;
let sourceHashes;
before(async () => {
  sourceHashes = Object.fromEntries(await Promise.all(['src/hub/hub-server.mjs', 'tests/conformance/cli-options.test.mjs'].map(async path =>
    [path, createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex')])));
});
after(async () => {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'process-report.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version,
    sourceHashes, processes: records, note: 'Generated token stdout is represented by its hash; only selected owned CLI checks were executed.' }, null, 2), { flag: 'wx' });
});
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'world-hub-cli-options-'));
  t.after(async () => {
    assert.equal(dirname(resolve(path)), resolve(tmpdir()));
    assert.ok(basename(path).startsWith('world-hub-cli-options-'));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
function invoke(cwd, argv) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...argv], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { pid: child.pid, argv, cwd, timedOut: false };
    records.push(record);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { record.timedOut = true; child.kill(); }, 2500);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      record.exit = { code, signal }; record.stderr = stderr;
      record.stdoutBytes = Buffer.byteLength(stdout);
      record.stdoutSha256 = createHash('sha256').update(stdout).digest('hex');
      record.ready = stdout.split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line); return row.event === 'ready' ? [row] : []; } catch { return []; } });
      accept({ record, stdout, stderr });
    });
  });
}
async function listening(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = value => { socket.destroy(); done(value); };
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false)); socket.setTimeout(500, () => settle(false));
  });
}

for (const option of ['--config', '-c', '--port', '-p', '--host', '--log-dir', '--print-token']) {
  for (const [name, suffix] of [['terminal value', []], ['empty value', ['']], ['following option as value', ['--quiet']]]) {
    test(`CLI missing ${name}: ${option}`, async t => {
      const cwd = await temporary(t);
      const { record, stdout, stderr } = await invoke(cwd, ['--port', '0', option, ...suffix]);
      assert.equal(record.timedOut, false, JSON.stringify(record));
      assert.deepEqual(record.exit, { code: 2, signal: null });
      assert.ok(stderr.includes(option) && /requires a value/.test(stderr));
      assert.equal(stdout, '');
      assert.deepEqual(record.ready, []);
      assert.deepEqual(await readdir(cwd), [], 'argument rejection creates no data or config');
    });
  }
}

for (const value of ['not-a-port', '-1', '65536', '0.5']) {
  test(`CLI invalid port fails before storage: ${value}`, async t => {
    const cwd = await temporary(t);
    const { record, stdout, stderr } = await invoke(cwd, ['--port', value]);
    assert.equal(record.timedOut, false);
    assert.deepEqual(record.exit, { code: 2, signal: null });
    assert.match(stderr, /--port/);
    assert.equal(stdout, '');
    assert.deepEqual(await readdir(cwd), []);
  });
}

test('CLI valid print-token returns an ACL fragment and never starts or persists a Hub', async t => {
  const cwd = await temporary(t);
  const { record, stdout, stderr } = await invoke(cwd, ['--print-token', 'my.program']);
  assert.deepEqual(record.exit, { code: 0, signal: null });
  assert.equal(record.timedOut, false); assert.equal(stderr, '');
  const token = JSON.parse(stdout);
  assert.equal(token.bridgeId, 'my.program'); assert.ok(typeof token.token === 'string' && token.token.length >= 32);
  assert.deepEqual(token.configSnippet.acl.bridges['my.program'].allow, { publish: ['#'], subscribe: ['#'] });
  assert.deepEqual(record.ready, []); assert.deepEqual(await readdir(cwd), []);
});

test('CLI valid config and numeric aliases preserve real launch, bind and log overrides', async t => {
  const cwd = await temporary(t), configPath = join(cwd, '自己的 配置.json'), logDir = join(cwd, '指定 数据');
  await writeFile(configPath, JSON.stringify({ hub: { id: 'cli-valid-config' }, transport: { host: '127.0.0.1', port: 8790, path: '/custom-mod' },
    log: { enabled: true }, acl: { defaultDeny: true, allowUnlistedBridges: false } }));
  const argv = ['-c', configPath, '-p', '0', '--host', '127.0.0.1', '--log-dir', logDir, '-q'];
  const child = fork(OWNED_ENTRY, argv, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const record = { pid: child.pid, argv, cwd, ownedWrapper: OWNED_ENTRY, stdout: '', stderr: '', exit: null }; records.push(record);
  const exited = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => { record.exit = { code, signal }; accept(record.exit); }); });
  exited.catch(() => {});
  let stopRequested = false;
  const stop = async () => {
    if (record.exit) return record.exit;
    if (!stopRequested && child.connected) { stopRequested = true; child.send({ type: 'stop' }, () => {}); }
    let timer;
    try { return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('owned CLI fixture exceeded stop deadline')); }, 5000); })]); }
    finally { clearTimeout(timer); }
  };
  t.after(stop);
  const ready = await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('owned CLI fixture failed to become ready')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', bytes => {
      record.stdout += bytes;
      for (const line of record.stdout.split(/\r?\n/)) {
        try { const row = JSON.parse(line); if (row.event === 'ready') { clearTimeout(timer); accept(row); } } catch {}
      }
    });
    child.stderr.on('data', bytes => { record.stderr += bytes; });
    child.once('close', () => { clearTimeout(timer); reject(new Error('owned CLI fixture exited before ready: ' + record.stderr)); });
  });
  assert.equal(ready.hub, 'cli-valid-config'); assert.equal(ready.host, '127.0.0.1');
  assert.ok(Number.isInteger(ready.port) && ready.port > 0); assert.ok(ready.endpoint.endsWith('/custom-mod'));
  assert.equal(ready.configPath, configPath); assert.equal(ready.logDir, logDir);
  const status = await fetch(`http://127.0.0.1:${ready.port}/status`, { signal: AbortSignal.timeout(2000) });
  assert.equal(status.status, 200);
  assert.deepEqual(await stop(), { code: 0, signal: null });
  assert.equal(await listening(ready.port), false);
});
