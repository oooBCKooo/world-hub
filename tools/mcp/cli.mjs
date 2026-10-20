#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.mjs';
import { createHubMcpServer, HubMcpService } from './service.mjs';
import { isDirectExecution } from '../../scripts/cli-entry.mjs';

export async function runMcpCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stderr.write('World Hub MCP (2026-07-28, stdio)\nUsage: node tools/mcp/cli.mjs --config <private.json>\n'); return;
  }
  if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw new Error('Usage: node tools/mcp/cli.mjs --config <private.json>');
  const config = await loadConfig(args[1]);
  const service = new HubMcpService(config);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: config.limits.maxResultBytes });
  let stopping = false, handle;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close(); await handle?.close();
    process.stdin.destroy();
  };
  // stdin EOF is the portable MCP disconnect signal. Also close the Hub socket,
  // otherwise it would keep this independent CLI process alive indefinitely.
  process.stdin.once('end', () => { void stop(); });
  process.stdin.once('close', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  handle = serveStdio(() => createHubMcpServer(config, service).server, {
    legacy: 'reject', transport, maxSubscriptions: 1,
    onerror: () => process.stderr.write('World Hub MCP transport error\n'),
  });
  // The SDK also closes its transport on framing/buffer and stdout failures,
  // independently of stdin EOF. Keep its callback and retire our Hub socket.
  const onclose = transport.onclose;
  transport.onclose = () => { onclose?.(); void stop(); };
}

if (isDirectExecution(import.meta.url)) runMcpCli().catch(() => {
  // Parser/transport errors may contain fragments of private input. Report only
  // a fixed diagnostic here; no token, config bytes or stack reaches stdout.
  process.stderr.write('World Hub MCP startup failed: check --config, its format and private permissions\n');
  process.exitCode = 1;
});
