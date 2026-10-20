import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock, importPackage, startInstance, statusInstance } from '../../../scripts/runtime/runtime.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const environment = { nodePath: process.execPath };
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-entry-urls-'));
  const sessions = [];
  t.after(async () => {
    for (const session of sessions.reverse()) {
      await session.close();
      for (const child of session.children) {
        assert.ok(child.exit && !child.cleanupIncomplete, `Owned process ${child.pid} must confirm cleanup`);
        assert.ok(child.child.exitCode !== null || child.child.signalCode !== null);
      }
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('world-hub-entry-urls-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root: join(directory, 'instances'), sessions };
}

async function packageFixture(app, { entry = 'second', reportedUrl, secondaryListens = true } = {}) {
  const directory = join(app.directory, 'package');
  async function source(id, listens) {
    const home = join(directory, 'modules', id);
    await mkdir(join(home, 'sdk'), { recursive: true });
    const program = await readFile(join(ROOT, 'tests/integration/ecosystem-runtime/fixtures/program.mjs'), 'utf8');
    const original = 'const entryUrl = `http://127.0.0.1:${server.address().port}/`;';
    assert.ok(program.includes(original));
    await writeFile(join(home, 'program.mjs'), program.replace(original,
      'const entryUrl = Object.hasOwn(config.settings, "reportedUrl") ? config.settings.reportedUrl : `http://127.0.0.1:${server.address().port}/`;'));
    for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(ROOT, 'sdk/javascript', file), join(home, 'sdk', file));
    await save(join(home, 'package.json'), { imports: { '#bridge': './sdk/bridge-kit.mjs' } });
    await save(join(home, 'module.json'), {
      format: 'world-hub.module/v1', id, version: '1.0.0', license: 'MIT', platforms: [`${process.platform}-${process.arch}`],
      runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [],
      permissions: { filesystem: 'instance-state', network: listens ? ['hub-loopback', 'loopback-listen'] : ['hub-loopback'], processes: 'none' }
    });
  }
  await source('test.ui', true);
  if (!secondaryListens) await source('test.undeclared-ui', false);
  const components = ['first', 'second'].map(id => ({
    id, module: id !== entry && !secondaryListens ? 'test.undeclared-ui' : 'test.ui', after: [],
    settings: id !== entry && reportedUrl !== undefined ? { reportedUrl } : {},
    bridges: { main: { publish: ['data'], subscribe: ['data'] } }
  }));
  await save(join(directory, 'pack.json'), {
    format: 'world-hub.pack/v1', id: 'test.multiple-interfaces', version: '1.0.0', title: 'Independent interfaces', license: 'MIT',
    topics: { data: 'acceptance/interfaces/data' }, components, bindings: [], entry: { component: entry },
    startupTimeoutMs: 5000, healthTimeoutMs: 1000, stopTimeoutMs: 500
  });
  await createLock(directory, environment);
  return directory;
}

test('RUNTIME-URLS-01 two instances of one UI module retain working interfaces and the selected primary entry', { timeout: 60000 }, async t => {
  const app = await workspace(t);
  const directory = await packageFixture(app);
  for (const entry of ['second', 'first']) {
    const file = join(directory, 'pack.json'), pack = JSON.parse(await readFile(file, 'utf8'));
    pack.entry.component = entry; await save(file, pack); await createLock(directory, environment);
    const imported = await importPackage(directory, { root: app.root, instanceId: entry, ...environment });
    const session = await startInstance({ root: app.root, instanceId: entry, trust: imported.digest, ...environment });
    app.sessions.push(session);
    const status = await session.status();
    assert.equal(status.state, 'running'); assert.equal(status.executionProfile, 'trusted-local');
    assert.equal(status.components.length, 2);
    assert.notEqual(status.components[0].entryUrl, status.components[1].entryUrl);
    assert.equal(status.entryUrl, status.components.find(component => component.id === entry).entryUrl);
    assert.equal(session.ready.entryUrl, status.entryUrl);
    for (const component of status.components) {
      const response = await fetch(component.entryUrl, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { connected: [true], pid: component.pid });
    }
    await session.close();
  }
});

test('RUNTIME-URLS-02 secondary interfaces still require a declared listener and valid loopback HTTP URL', { timeout: 120000 }, async t => {
  for (const [name, input] of [
    ['undeclared listener', { secondaryListens: false }],
    ['remote host', { reportedUrl: 'http://example.com:8000/' }],
    ['credentials', { reportedUrl: 'http://user:password@127.0.0.1:8000/' }],
    ['HTTPS scheme', { reportedUrl: 'https://127.0.0.1:8000/' }],
    ['missing port', { reportedUrl: 'http://127.0.0.1/' }],
    ['zero port', { reportedUrl: 'http://127.0.0.1:0/' }],
    ['query string', { reportedUrl: 'http://127.0.0.1:8000/?token=value' }],
    ['fragment', { reportedUrl: 'http://127.0.0.1:8000/#state' }],
    ['array coerced into URL', { reportedUrl: ['http://127.0.0.1:8000/'] }]
  ]) await t.test(name, async child => {
    const app = await workspace(child), directory = await packageFixture(app, { ...input, entry: 'first' });
    const imported = await importPackage(directory, { root: app.root, instanceId: 'invalid', ...environment });
    await assert.rejects(startInstance({ root: app.root, instanceId: 'invalid', trust: imported.digest, ...environment }),
      /undeclared or invalid loopback entry URL/);
    const failed = await statusInstance({ root: app.root, instanceId: 'invalid' });
    assert.equal(failed.state, 'failed'); assert.ok(failed.stoppedAt);
    assert.ok(failed.hub.exit); assert.ok(failed.components.every(component => component.process === 'exited' && component.exit));
  });
});
