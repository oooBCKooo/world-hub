import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNpmArgs, planNpmInvocation } from '../../../bin/world-hub.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(root, 'bin/world-hub.mjs');
let evidence;
before(async () => {
  const directory = join(root, '.artifacts/npm-cli');
  await mkdir(directory, { recursive: true });
  evidence = await mkdtemp(join(directory, 'checks-'));
});
async function workspace(label) { const cwd = join(evidence, label); await mkdir(cwd); return cwd; }
async function customConfig(cwd, name = 'hub.json') {
  const raw = JSON.parse(await readFile(join(root, 'config/hub.json'), 'utf8'));
  raw.transport.port = 0;
  raw.log.dir = './provided-log'; raw.blobs.dir = './provided-blobs'; raw.management.stateFile = './provided-management.json';
  const path = join(cwd, name); await writeFile(path, JSON.stringify(raw)); return { path, raw };
}
function execute(cwd, args) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000 }); }
async function assertClosed(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) }));
}

test('first npm check previews cwd storage without writing configuration, folders or locks', async () => {
  const cwd = await workspace('首次 检查');
  const result = execute(cwd, ['--check', '--port', '0']);
  assert.equal(result.status, 0, result.stderr);
  const checked = JSON.parse(result.stdout);
  assert.equal(checked.persisted, false); assert.equal(checked.wouldCreateConfig, true);
  assert.equal(checked.configPath, join(cwd, 'world-hub-data/hub.json'));
  assert.equal(checked.transport.port, 0);
  for (const entry of Object.values(checked.storage)) assert.ok(entry.path.startsWith(join(cwd, 'world-hub-data') + sep));
  assert.deepEqual(await readdir(cwd), []);
});

test('npm argument failures cannot initialize a workspace', async () => {
  const cwd = await workspace('无效 参数');
  for (const args of [['--data-dir'], ['--data-dir', '--open'], ['--data-dir', 'a', '--data-dir', 'b'],
    ['--port', '65536'], ['--check', '--open'], ['--unknown']]) {
    const result = execute(cwd, args); assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(await readdir(cwd), []);
  }
});

test('a supplied relative config retains its declared storage relative to its own directory', async () => {
  const cwd = await workspace('指定 配置');
  await mkdir(join(cwd, '配置'));
  const { path } = await customConfig(join(cwd, '配置'));
  const before = await readFile(path);
  const result = execute(cwd, ['--check', '-c', '配置/hub.json']);
  assert.equal(result.status, 0, result.stderr);
  const checked = JSON.parse(result.stdout);
  assert.equal(checked.configPath, path);
  assert.equal(checked.storage.log.path, join(cwd, '配置/provided-log'));
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(join(cwd, '配置')), ['hub.json']);
});

test('explicit data-dir scopes all persistence without overwriting supplied config', async () => {
  const cwd = await workspace('隔离 检查'); const { path } = await customConfig(cwd);
  const before = await readFile(path);
  const result = execute(cwd, ['--check', '--config', 'hub.json', '--data-dir', '我的 数据']);
  assert.equal(result.status, 0, result.stderr);
  const checked = JSON.parse(result.stdout);
  assert.ok(checked.configPath.startsWith(join(cwd, '我的 数据/configs') + sep));
  for (const entry of Object.values(checked.storage)) assert.ok(entry.path.startsWith(join(cwd, '我的 数据') + sep));
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(cwd), ['hub.json']);
});

test('malformed existing default configuration is rejected instead of replaced with a template', async () => {
  const cwd = await workspace('错误 配置'); await mkdir(join(cwd, 'world-hub-data'));
  const path = join(cwd, 'world-hub-data/hub.json');
  for (const bytes of ['null', '[]', '{"log":{"enabled":"yes"}}', '{broken']) {
    await writeFile(path, bytes); const result = execute(cwd, ['--check', '--port', '0']);
    assert.equal(result.status, 2, result.stderr); assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await readdir(join(cwd, 'world-hub-data')), ['hub.json']);
  }
  await writeFile(join(cwd, 'supplied.json'), '{"log":"invalid"}');
  const invalidOverride = execute(cwd, ['--check', '--config', 'supplied.json', '--data-dir', 'new-data']);
  assert.equal(invalidOverride.status, 2); assert.match(invalidOverride.stderr, /log must be a JSON object/);
  assert.deepEqual(await readdir(cwd), ['supplied.json', 'world-hub-data']);
});

test('npm default start creates workspace config and serves the real management UI, then stops cleanly', async () => {
  const cwd = await workspace('真实 启停'); const record = await startOwnedProgram(cli, { cwd, args: ['--port', '0'] });
  const port = record.ready.port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/manage`);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /world-hub|世界枢纽/i);
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status, 200);
    const raw = JSON.parse(await readFile(join(cwd, 'world-hub-data/hub.json'), 'utf8'));
    assert.equal(raw.log.dir, './log'); assert.equal(raw.blobs.dir, './blobs'); assert.equal(raw.management.stateFile, './management.json');
    assert.ok((await readdir(join(cwd, 'world-hub-data/log'))).includes('.world-hub-package.lock'));
  } finally { const stopped = await record.stop(); assert.equal(stopped.code, 0, record.stderr); }
  assert.ok(!(await readdir(join(cwd, 'world-hub-data/log'))).includes('.world-hub-package.lock'));
  await assertClosed(port);
});

test('two npm instances can use separate data roots while same-root simultaneous start is refused', async () => {
  const cwd = await workspace('双 实例'); const { path } = await customConfig(cwd); const before = await readFile(path);
  const alpha = await startOwnedProgram(cli, { cwd, args: ['--config', 'hub.json', '--data-dir', '甲 数据', '--port', '0'] });
  let beta;
  try {
    beta = await startOwnedProgram(cli, { cwd, args: ['--config', 'hub.json', '--data-dir', '乙 数据', '--port', '0'] });
    assert.notEqual(alpha.ready.port, beta.ready.port);
    const denied = execute(cwd, ['--config', 'hub.json', '--data-dir', '甲 数据', '--port', '0']);
    assert.equal(denied.status, 2, denied.stderr); assert.match(denied.stderr, /运行锁/);
    assert.equal((await fetch(`http://127.0.0.1:${alpha.ready.port}/status`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${beta.ready.port}/status`)).status, 200);
    assert.deepEqual(await readFile(path), before);
  } finally {
    if (beta) assert.equal((await beta.stop()).code, 0, beta.stderr);
    assert.equal((await alpha.stop()).code, 0, alpha.stderr);
  }
  await assertClosed(alpha.ready.port); if (beta) await assertClosed(beta.ready.port);
});

test('plans preserve existing default configuration edits and reject storage parent files', async () => {
  const cwd = await workspace('现有 配置'); await mkdir(join(cwd, 'world-hub-data'));
  const { path, raw } = await customConfig(join(cwd, 'world-hub-data'));
  raw.hub.id = 'developer-hub'; raw.limits.maxConnections = 5; await writeFile(path, JSON.stringify(raw));
  const plan = await planNpmInvocation(parseNpmArgs(['--check']), { cwd });
  assert.equal(plan.materialize, false); assert.equal(plan.raw.hub.id, 'developer-hub'); assert.equal(plan.raw.limits.maxConnections, 5);
  await writeFile(join(cwd, 'blocked'), 'file');
  await assert.rejects(planNpmInvocation(parseNpmArgs(['--check', '--data-dir', 'blocked/child']), { cwd }), /not a directory|ENOTDIR|不是目录/i);
});
