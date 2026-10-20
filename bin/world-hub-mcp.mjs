#!/usr/bin/env node
// Optional MCP dependencies stay in their own locked package, outside Hub Core.
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectExecution } from '../scripts/cli-entry.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const HELP = `World Hub MCP service (stdio)

  world-hub-mcp --prepare
  world-hub-mcp --config <absolute-private-config.json>

--prepare  Install only the optional MCP service's locked production dependencies
           using npm ci --omit=dev --ignore-scripts. Run once before configuring
           an MCP client; it downloads dependencies but starts no service.
--config   Serve World Hub communication tools through an independent Hub bridge.
           stdin/stdout carry MCP; diagnostics go to stderr.

Node.js 22.4+ and npm are required. The Hub must be separately configured and
running. This service uses MCP 2026-07-28 and the configured bridge permissions.
No credentials are accepted as tool arguments or included in normal results.
`;

async function npmCliPath() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  for (const path of candidates) {
    if (!path.endsWith('npm-cli.js')) continue;
    try { await access(path); return path; } catch {}
  }
  throw new Error('Cannot locate npm beside Node.js. Install npm, then retry --prepare.');
}

export async function runMcpEntry(argv = process.argv.slice(2), { root = packageRoot, output = text => process.stdout.write(text) } = {}) {
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) { output(HELP); return; }
  if (argv.length === 1 && argv[0] === '--prepare') {
    const directory = join(root, 'tools', 'mcp');
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.dependencies?.['@modelcontextprotocol/server'] !== '2.3.1') throw new Error('Optional MCP dependency declaration differs from the reviewed version.');
    const child = spawn(process.execPath, [await npmCliPath(), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', directory],
      { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr);
    const exit = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal })); });
    if (exit.code !== 0 || exit.signal) throw new Error('Optional MCP dependency preparation failed.');
    const result = { prepared: true, package: manifest.name, dependency: '@modelcontextprotocol/server@2.3.1', lifecycleScripts: false, startsPrograms: false };
    output(JSON.stringify(result) + '\n'); return result;
  }
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1] || argv[1].startsWith('-')) throw new Error('Use --prepare or --config <private-config.json>.');
  try {
    const { runMcpCli } = await import(pathToFileURL(join(root, 'tools/mcp/cli.mjs')).href);
    return await runMcpCli(argv);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /@modelcontextprotocol/.test(error.message)) throw new Error('Optional MCP dependencies are not prepared. Run world-hub-mcp --prepare first.');
    throw error;
  }
}

if (isDirectExecution(import.meta.url)) {
  runMcpEntry().catch(() => { process.stderr.write('World Hub MCP could not start. Check the private configuration and run world-hub-mcp --prepare before connecting.\n'); process.exitCode = 2; });
}
