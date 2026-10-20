import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { Harness, until } from '../../helpers/hub-harness.mjs';
const requireMcp = createRequire(new URL('../../../tools/mcp/package.json', import.meta.url));
const { Client } = requireMcp('@modelcontextprotocol/client');
const { StdioClientTransport } = requireMcp('@modelcontextprotocol/client/stdio');

export const repository = resolve(import.meta.dirname, '../../..');
export const allowedTopic = 'external/mcp/arbitrary-new-kind';
export const secondTopic = 'external/mcp/retained-information';

// Every Hub path is explicit: default management state would attach tests to
// the user's global module registry. These are isolated real subprocesses.
export async function hubFixture(t, { mcpAllow, limits, log } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'world-hub-mcp-'));
  const tokens = Object.fromEntries(['mcp.tools', 'provider', 'source'].map(id => [id, randomBytes(24).toString('base64url')]));
  const credentials = Object.fromEntries(Object.entries(tokens).map(([id, token]) => [id, {
    token, maxConnections: 8, allow: { publish: ['#'], subscribe: ['#'] }
  }]));
  if (mcpAllow) credentials['mcp.tools'].allow = mcpAllow;
  const configPath = join(root, 'hub.json'), logDir = join(root, 'log');
  await writeFile(configPath, JSON.stringify({ hub: { id: 'mcp-isolated-tests' },
    log: { ...log, dir: logDir }, ...(limits ? { limits } : {}), blobs: { dir: join(root, 'blobs') },
    management: { stateFile: join(root, 'private-management', 'management.json') },
    acl: { defaultDeny: true, allowUnlistedBridges: false, credentials }
  }), { mode: 0o600 });
  const hub = new Harness({ logDir, keepTmp: true }), bridges = [], adapters = [];
  t.after(async () => {
    for (const adapter of adapters.reverse()) await adapter.close();
    for (const bridge of bridges) await bridge.close();
    await hub.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  await hub.startHub({ configPath, isolateLog: false });
  return { root, hub, tokens, bridges, adapters,
    config(overrides = {}) {
      return { format: 'world-hub.mcp/v1', bridge: { url: hub.endpoint,
        bridgeId: 'external.mcp.tools', credential: 'mcp.tools', token: tokens['mcp.tools'], expectedPrincipal: 'mcp.tools' },
        permissions: { tools: ['hub_identity', 'hub_register_channels', 'hub_publish', 'hub_subscribe', 'hub_pull', 'hub_ack', 'hub_unsubscribe',
          'hub_request', 'hub_call', 'hub_inject', 'hub_respond', 'hub_release', 'hub_blob_upload', 'hub_blob_read', 'hub_blob_status', 'hub_blob_release'],
          publishTopics: [allowedTopic, secondTopic], subscribeTopics: [allowedTopic, secondTopic], targetPrincipals: ['provider', 'source'] },
        limits: { connectTimeoutMs: 1500, requestTimeoutMs: 1500, maxReadWaitMs: 2000 }, ...overrides };
    },
    async bridge(principal, bridgeId = principal) {
      const bridge = new Bridge({ url: hub.endpoint, bridgeId, credential: principal, token: tokens[principal], reconnectMs: 30 });
      bridges.push(bridge); const welcome = await bridge.connect();
      assert.equal(welcome.authenticated, true); assert.equal(welcome.principal, principal); return bridge;
    },
    async records() { return (await hub.log(500)).records.filter(row => row.kind === 'message'); },
    async awaitRecord(predicate) { return until(async () => (await this.records()).find(predicate)); }
  };
}

export async function startAdapter(fixture, config = fixture.config(), { legacy = false } = {}) {
  const configFile = join(fixture.root, `mcp-${fixture.adapters.length}.json`);
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const client = new Client({ name: 'independent-mcp-acceptance', version: '1.0.0' },
    legacy ? {} : { versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 2000, maxRetries: 0 } } });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(repository, 'tools/mcp/cli.mjs'), '--config', configFile], cwd: fixture.root, stderr: 'pipe' });
  let stderr = '', closed = false;
  transport.stderr?.on('data', bytes => { stderr += bytes.toString(); });
  const calls = [];
  const adapter = { client, transport, configFile, calls,
    get stderr() { return stderr; },
    async call(name, args = {}, options = {}) {
      const result = await client.callTool({ name, arguments: args }, { timeout: 5000, ...options });
      calls.push({ name, result }); assertNoSecrets(result, fixture.tokens); return result;
    },
    async close() { if (!closed) { closed = true; await client.close(); } }
  };
  fixture.adapters.push(adapter);
  await client.connect(transport, { timeout: 5000 });
  return adapter;
}

export function resultData(result) {
  const value = result.structuredContent;
  assert.ok(value && typeof value === 'object', 'MCP tools provide machine-readable results');
  const text = result.content?.filter(row => row.type === 'text').map(row => row.text).join('\n');
  if (text) assert.deepEqual(JSON.parse(text), value, 'text and structured results describe the same operation');
  return value;
}

export function assertNoSecrets(value, tokens) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const token of Object.values(tokens)) assert.ok(!text.includes(token), 'private Hub tokens must not appear in MCP output');
}
