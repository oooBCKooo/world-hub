import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_FILES, SDK_FILES, SDK_DOCUMENTATION_FILES, SHARED_RUNTIME_FILES, LAUNCHER_FILES,
  WORKSHOP_FILES, INTEROP_FILES, AGENT_FILES, CURRENT_DOCUMENTATION_FILES, ECOSYSTEM_SCHEMA_FILES } from '../../../scripts/release/build-package.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => readFile(resolve(root, file), 'utf8');

test('npm exposes communication SDKs and current commands without a cancelled pack API', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['world-hub', 'world-hub-interop', 'world-hub-mcp', 'world-hub-skill', 'world-hub-workshop']);
  assert.equal(pkg.exports['./runtime'], undefined);
  assert.equal(pkg.exports['.'], './sdk/javascript/bridge-kit.mjs');
  assert.equal(pkg.exports['./blob'], './sdk/javascript/blob-client.mjs');
  assert.equal(pkg.exports['./workshop'], './tools/workshop/server.mjs');
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.files.every(path => !path.includes('*')), 'Published source uses an explicit list, not a broad historical-directory glob');
  for (const path of [...SHARED_RUNTIME_FILES, ...LAUNCHER_FILES, ...WORKSHOP_FILES, ...INTEROP_FILES, ...AGENT_FILES, ...ECOSYSTEM_SCHEMA_FILES]) {
    assert.ok(pkg.files.includes(path), path);
  }
  for (const path of ['bin/world-hub-pack.mjs','scripts/runtime/index.mjs','scripts/runtime/runtime.mjs','scripts/runtime/template.mjs',
    'tools/launcher/public/advanced.mjs','tools/launcher/composition.mjs','docs/ecosystem/pack-spec.md','docs/ecosystem/templates.md']) {
    assert.ok(!pkg.files.includes(path), path);
  }
});

test('the distributed program dependency closure resolves without pack runtime or template entry files', async () => {
  const files = new Set([...APPLICATION_FILES,...SDK_FILES,...SDK_DOCUMENTATION_FILES,...SHARED_RUNTIME_FILES,...LAUNCHER_FILES,...WORKSHOP_FILES,...INTEROP_FILES,...AGENT_FILES,
    'scripts/launcher.mjs','scripts/launcher-support.mjs','package.json','config/hub.json']);
  const missing = [];
  for (const path of files) {
    await access(resolve(root, path));
    if (!path.endsWith('.mjs')) continue;
    const source = await read(path);
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = relative(root, resolve(dirname(resolve(root, path)), match[1])).replaceAll('\\', '/');
      if (!files.has(target)) missing.push({ importer: path, target });
    }
  }
  assert.deepEqual(missing, [], 'Every static and literal dynamic import must be available in the actual release list');
});

test('current documentation navigation and bilingual readmes describe module instances and groups', async () => {
  for (const path of ['README.md','README.en.md','docs/README.md','docs/specs/index.md']) {
    const source = await read(path);
    assert.doesNotMatch(source, /\]\((?:docs\/)?ecosystem\/(?:pack-spec|runtime|templates|authoring|upgrade)\.md/);
    assert.doesNotMatch(source, /world-hub-pack (?:start|plan|import|init-module)/);
  }
  assert.match(await read('README.md'), /互联万物，自由组合，解耦整体，软化硬码，拔插一切，任意流线，无限模块/);
  const english = await read('README.en.md');
  assert.match(english, /one Global Hub/);
  assert.match(english, /all connected to \*\*the same Hub\*\*/);
  assert.ok(CURRENT_DOCUMENTATION_FILES.includes('docs/ecosystem/modules.md'));
  assert.ok(CURRENT_DOCUMENTATION_FILES.every(path => !/pack-spec|templates\.md|phase1[78]|plans\//.test(path)));
});

test('new Workshop distribution offers modules while retaining unrelated account and collaboration functionality', async () => {
  assert.ok(WORKSHOP_FILES.every(path => !path.startsWith('tools/workshop/public/')));
  await assert.rejects(access(resolve(root, 'tools/workshop/public/app.mjs')), { code: 'ENOENT' });
  const store = await read('tools/workshop/store.mjs');
  assert.match(store, /const distributedKinds = new Set\(\['module',\s*'configuration',\s*'data'\]\)/);
  assert.match(store, /this\.state\.publications\.filter\(p => distributedKinds\.has\(p\.kind\)/);
  assert.match(store, /commentSummary/);
  assert.match(store, /proposalSummary/);
});
