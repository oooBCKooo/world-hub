import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test helper: genuine installed DSH runtime, deterministic test adapter.
// It creates its own home/profile/workspace; it never loads the user's DSH home.
export async function createDshFixture({ installRoot, tempRoot = tmpdir(), responsePrefix = 'fixture-echo: ', responseDelayMs = 0, holdResponse = false } = {}) {
  if (!installRoot) throw new TypeError('installRoot is required');
  installRoot = resolve(installRoot);
  const root = await mkdtemp(join(tempRoot, 'peros-dsh-fixture-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  const guardPath = join(root, 'no-network.mjs');
  const adapterPath = join(root, 'fixture-adapter.mjs');
  const patchPath = join(root, 'fixture.patch.yml');
  const capturePath = join(root, 'request-capture.jsonl');
  const responseGatePath = join(root, 'response-release');
  const llmUrl = pathToFileURL(join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href;
  await writeFile(guardPath, [
    "import http from 'node:http';",
    "import https from 'node:https';",
    "import net from 'node:net';",
    "import tls from 'node:tls';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const blocked = () => { throw new Error('DSH test fixture prohibits network access'); };",
    "globalThis.fetch = async () => blocked();",
    "globalThis.WebSocket = class { constructor() { blocked(); } };",
    "http.request = http.get = https.request = https.get = blocked;",
    "net.connect = net.createConnection = tls.connect = blocked;",
    "syncBuiltinESMExports();",
    ''
  ].join('\n'));
  await writeFile(adapterPath, [
    'import { LlmAdapter } from ' + JSON.stringify(llmUrl) + ';',
    "import { appendFile, access } from 'node:fs/promises';",
    "export const name = 'peros-test-fixture';",
    "export const inject = ['llm'];",
    'const capturePath = ' + JSON.stringify(capturePath) + ';',
    'const prefix = ' + JSON.stringify(responsePrefix) + ';',
    'const responseDelayMs = ' + JSON.stringify(responseDelayMs) + ';',
    'const holdResponse = ' + JSON.stringify(holdResponse) + ';',
    'const responseGatePath = ' + JSON.stringify(responseGatePath) + ';',
    'class FixtureAdapter extends LlmAdapter {',
    "  providerInfo(provider) { return { id: provider, name: 'DSH test fixture' }; }",
    '  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1000000 } }); }',
    '  async *stream(options) {',
    "    const user = [...options.messages].reverse().find(message => message.role === 'user');",
    "    const promptText = (user?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\\n');",
    "    await appendFile(capturePath, JSON.stringify({ sessionId: options.sessionId, promptText, messages: options.messages }) + '\\n');",
    '    if (holdResponse) {',
    '      const deadline = Date.now() + 30000;',
    '      for (;;) {',
    "        try { await access(responseGatePath); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }",
    "        if (Date.now() >= deadline) throw new Error('DSH fixture response gate was not released within 30s');",
    '        await new Promise(resolve => setTimeout(resolve, 10));',
    '      }',
    '    }',
    '    if (responseDelayMs) await new Promise(resolve => setTimeout(resolve, responseDelayMs));',
    '    const text = prefix + promptText;',
    "    yield { type: 'block-start', index: 0, blockType: 'text' };",
    "    yield { type: 'text-delta', index: 0, text };",
    "    yield { type: 'block-end', index: 0, block: { type: 'text', text } };",
    "    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };",
    "    yield { type: 'finish', reason: { kind: 'stop' } };",
    '  }',
    '}',
    "export function apply(ctx) { ctx.llm.registerAdapter(['peros-test'], new FixtureAdapter()); }",
    ''
  ].join('\n'));
  await writeFile(patchPath, [
    '- id: llm-deepseek',
    '  disabled: true',
    '- insert:',
    '    - id: peros-test-fixture',
    '      name: ' + JSON.stringify(pathToFileURL(adapterPath).href),
    ''
  ].join('\n'));
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec', 'OS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.DSH_HOME = home;
  env.DSH_TELEMETRY_DISABLED = 'true';
  return {
    root, workspace, home, guardPath, adapterPath, patchPath, capturePath, env, responsePrefix,
    // Test-owned model response control; independent of Hub and real DSH code.
    releaseResponse: () => writeFile(responseGatePath, 'released\n', 'utf8'),
    executable: process.execPath,
    args: ['--import', pathToFileURL(guardPath).href, join(installRoot, 'lib', 'bin.js'), '--profile', 'sdk-minimal', '--patch', patchPath],
    initialize: { cwd: workspace, provider: 'peros-test', model: 'fixture' }
  };
}
