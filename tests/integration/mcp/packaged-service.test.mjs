import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { hubFixture, repository, resultData } from './helpers.mjs';

const requireMcp = createRequire(new URL('../../../tools/mcp/package.json', import.meta.url));
const { Client } = requireMcp('@modelcontextprotocol/client');
const { StdioClientTransport } = requireMcp('@modelcontextprotocol/client/stdio');

async function npmCliPath() {
  for (const path of [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) {
    if (!path.endsWith('npm-cli.js')) continue;
    try { await access(path); return path; } catch {}
  }
  throw new Error('Cannot locate npm-cli.js; run the agents suite through npm.');
}

async function execute(args, { cwd, env = process.env, timeoutMs = 30000 }) {
  const child = spawn(process.execPath, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  try {
    const exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    assert.equal(timedOut, false, `Command timed out: ${stderr}`);
    assert.equal(exit.code, 0, stderr || stdout); assert.equal(exit.signal, null);
    return { stdout, stderr };
  } finally { clearTimeout(timer); }
}

test('actual npm tarball prepares only optional production dependencies and serves MCP from an unrelated cwd', { timeout: 60000 }, async t => {
  const f = await hubFixture(t), npm = await npmCliPath();
  const packed = await execute([npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', f.root], { cwd: repository });
  const archive = join(f.root, JSON.parse(packed.stdout)[0].filename), workspace = join(f.root, 'independent client');
  await mkdir(workspace); await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await execute([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--save=false', archive], { cwd: workspace });
  const installed = join(workspace, 'node_modules/world-hub'), entry = join(installed, 'bin/world-hub-mcp.mjs');
  await assert.rejects(access(join(installed, 'tools/mcp/node_modules')));
  const cli = join(installed, 'bin/world-hub.mjs');
  const catalog = JSON.parse((await execute([cli, 'operations', '--json'], { cwd: workspace })).stdout);
  assert.ok(catalog.operations.some(operation => operation.name === 'resources.profiles.apply'));
  const state = JSON.parse((await execute([cli, 'state', '--hub', f.hub.httpBase, '--json'], { cwd: workspace })).stdout);
  assert.equal(state.csrfToken, undefined); assert.ok(state.hub);
  const exported = await execute(['--input-type=module', '--eval', "import { ManagementClient } from 'world-hub/management'; const value = await new ManagementClient({url:process.argv[1]}).execute('hub.status'); process.stdout.write(JSON.stringify({hasStorage:!!value.storage}));", f.hub.httpBase], { cwd: workspace });
  assert.equal(JSON.parse(exported.stdout).hasStorage, true);
  await assert.rejects(access(join(installed, 'tools/mcp/node_modules')), 'management CLI and SDK need no MCP runtime installation');
  // Preparation is an explicit dependency download in the real CLI contract.
  // Windows runners may select a different npm cache inside npm-run than in
  // the prerequisite step. Do not silently require that unrelated cache state.
  const prepared = await execute([entry, '--prepare'], { cwd: f.root });
  const report = JSON.parse(prepared.stdout);
  assert.equal(report.prepared, true); assert.equal(report.lifecycleScripts, false); assert.equal(report.startsPrograms, false);
  const serverManifest = JSON.parse(await readFile(join(installed, 'tools/mcp/node_modules/@modelcontextprotocol/server/package.json'), 'utf8'));
  assert.equal(serverManifest.version, '2.3.1');
  await assert.rejects(access(join(installed, 'tools/mcp/node_modules/@modelcontextprotocol/client')), 'test client must not be installed in production');
  await assert.rejects(access(join(installed, 'node_modules')), 'Hub package itself remains dependency-free');
  const configFile = join(f.root, 'private-installed-mcp.json');
  await writeFile(configFile, JSON.stringify(f.config()), { mode: 0o600 });
  const client = new Client({ name: 'installed-package-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 2000, maxRetries: 0 } } });
  f.adapters.push({ close: () => client.close() });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--config', configFile], cwd: f.root, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', bytes => { stderr += bytes.toString('utf8'); });
  await client.connect(transport, { timeout: 5000 });
  assert.equal((await client.listTools()).tools.length, 16);
  const identity = resultData(await client.callTool({ name: 'hub_identity', arguments: {} }, { timeout: 5000 }));
  assert.equal(identity.authenticated, true); assert.equal(identity.principal, 'mcp.tools');
  assert.ok(!stderr.includes(f.tokens['mcp.tools']));
  await client.close();
});
