import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, open, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { Harness } from '../../helpers/hub-harness.mjs';
import { validateModuleDirectory } from '../../../scripts/runtime/developer.mjs';
import { inspectPackage } from '../../../scripts/runtime/package.mjs';
import { readSourceManifest, collectSourceFiles } from '../../../scripts/runtime/source-guidance.mjs';
import { diagnose } from '../../../tools/launcher/diagnostics.mjs';
import { localizeErrorMessage } from '../../../tools/launcher/public/i18n.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { workspace, environment, save, until } from './helpers.mjs';

test('bare external source gets actionable static CLI and Launcher guidance without execution or widening Hub ACL', async t => {
  const app = await workspace(t), source = join(app.directory, 'native-host');
  await mkdir(source); await save(join(source, 'package.json'), { name: 'independent-native-host', scripts: { start: 'node host.mjs' }, devDependencies: { electron: '44.7.1' } });
  await writeFile(join(source, 'host.mjs'), "throw new Error('Source validation must not execute this program');\n");
  const before = await readFile(new URL('../../../config/hub.json', import.meta.url));
  const checked = await validateModuleDirectory({ directory: source });
  assert.equal(checked.ok, false);
  const issue = checked.issues.find(issue => issue.code === 'MODULE_MANIFEST_INVALID');
  assert.equal(issue.diagnostic.kind, 'external-program');
  assert.match(issue.remedy, /independently/); assert.match(issue.diagnostic.zh, /无需先导入/);
  await assert.rejects(inspectPackage(source), error => error.code === 'ENOENT' && diagnose(error).kind === 'external-program');
  const server = await createLauncherServer({ root: app.root, port: 0, ...environment }); app.cleanups.push(() => server.close());
  const response = await fetch(new URL('/api/review', server.url), { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ directory: source }) });
  const result = await response.json();
  assert.equal(result.ok, false); assert.equal(result.diagnostic.kind, 'external-program');
  assert.match(result.diagnostic.en, /optional Runtime/); assert.match(result.diagnostic.zh, /模块桥/);
  assert.deepEqual(await readFile(new URL('../../../config/hub.json', import.meta.url)), before);
});

test('pack and module root mixups are distinguished without pretending they are native-host limitations', async t => {
  const app = await workspace(t), module = join(app.directory, 'module'), pack = join(app.directory, 'pack');
  await mkdir(module); await mkdir(pack);
  await save(join(module, 'module.json'), {}); await save(join(pack, 'pack.json'), {});
  await assert.rejects(readSourceManifest(module, 'pack.json'), error => diagnose(error).kind === 'module-source');
  await assert.rejects(readSourceManifest(pack, 'module.json'), error => diagnose(error).kind === 'pack-source');
  const empty = join(app.directory, 'empty'); await mkdir(empty);
  await assert.rejects(readSourceManifest(empty, 'module.json'), error => error.code === 'ENOENT' && !error.diagnostic);
});

test('oversize installed dependency yields a deployment-profile explanation and is not silently dropped', async t => {
  const app = await workspace(t), source = join(app.directory, 'installed-host'), dependency = join(source, 'node_modules', 'native-host', 'dist');
  await mkdir(dependency, { recursive: true }); await save(join(source, 'package.json'), { name: 'native-host' });
  const file = await open(join(dependency, 'runtime.dll'), 'wx');
  try { await file.truncate(8 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(collectSourceFiles(source), error => error.code === 'MODULE_SOURCE_LIMIT'
    && error.sourceRelativePath === 'node_modules/native-host/dist/runtime.dll'
    && diagnose(error).kind === 'deployment-source-limit'
    && /do not restrict program shapes/.test(diagnose(error).en));
  const checked = await validateModuleDirectory({ directory: source });
  assert.equal(checked.ok, false); assert.equal(checked.issues[0].diagnostic.kind, 'deployment-source-limit');
  assert.match(checked.issues[0].remedy, /4096 files/);
});

test('invalid package links retain path rejection instead of being read for diagnostic hints', async t => {
  const app = await workspace(t), source = join(app.directory, 'source'), target = join(app.directory, 'outside');
  await mkdir(source); await mkdir(target); await save(join(target, 'package.json'), { name: 'outside' });
  await symlink(target, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectSourceFiles(source), /Package link is not allowed/);
});

test('the published independent-program guide establishes real authenticated two-way SDK traffic and commits a cursor', { timeout: 20000 }, async t => {
  const app = await workspace(t), doc = await readFile(new URL('../../../docs/ecosystem/external-programs.md', import.meta.url), 'utf8');
  const config = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
  const displayToken = randomBytes(24).toString('base64url'), workerToken = randomBytes(24).toString('base64url');
  config.acl.credentials['app.display'].token = displayToken; config.acl.credentials['app.worker'].token = workerToken;
  const configPath = join(app.directory, 'private-hub.json'); await save(configPath, config);
  const harness = new Harness(), bridges = [];
  app.cleanups.push(async () => { for (const bridge of bridges) await bridge.close(); await harness.stop(); });
  await harness.startHub({ configPath });
  const worker = new Bridge({ url: harness.endpoint, bridgeId: 'app.worker.mod', credential: 'app.worker', token: workerToken }); bridges.push(worker);
  const welcome = await worker.connect(); assert.equal(welcome.authenticated, true);
  const events = []; worker.on('delivery', message => events.push(message));
  await worker.registerChannels([{name: 'app/panel/commands', publish: true}, {name: 'app/panel/events', subscribe: true}]);
  await worker.subscribe(['app/panel/events'], {from: 0, operations: ['inject']});
  let snippet = doc.match(/```javascript\n([\s\S]*?)\n```/)[1].replace(/^import .*;\n/gm, '').replace('ws://127.0.0.1:8890/bridge', harness.endpoint);
  const stateDirectory = join(app.directory, 'private-display-state'); await mkdir(stateDirectory);
  const failures = [], snapshot = join(stateDirectory, 'view.json');
  class RecordedBridge extends Bridge { constructor(options) { super(options); bridges.push(this); } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('Bridge', 'join', 'process', 'persistAndApplyViewCommand', 'reportApplicationFailure', snippet + '\nreturn bridge;');
  await run(RecordedBridge, join, {env: {DISPLAY_HUB_TOKEN: displayToken, DISPLAY_STATE_DIRECTORY: stateDirectory}},
    async body => save(snapshot, body), error => failures.push(error));
  await until(() => events.length);
  assert.equal(events[0].fromPrincipal, 'app.display'); assert.equal(events[0].body.elementId, 'refresh');
  const command = {protocol: 'my-panel/1', kind: 'open', text: '界面 🙂', claimedOwner: 'not-an-identity'};
  await worker.sendTo({principal: 'app.display'}, 'app/panel/commands', command);
  await until(async () => { try { return JSON.parse(await readFile(snapshot, 'utf8')).text === command.text; } catch { return false; } });
  await until(async () => { try { return (await readFile(join(stateDirectory, 'display.cursor.json'), 'utf8')).length > 0; } catch { return false; } });
  assert.equal(failures.length, 0);
});

test('software source and runtime error messages are localized into natural Chinese when language is zh', () => {
  const err404 = new Error('Software source HTTP status 404; redirects are not followed');
  const d404 = diagnose(err404);
  assert.equal(d404.kind, 'source-not-found');
  assert.match(d404.zh, /HTTP 404/);

  assert.equal(localizeErrorMessage(err404.message, 'zh'), '软件源未找到该资源（HTTP 404）；出于安全考虑系统不跟随重定向');
  assert.equal(localizeErrorMessage(err404.message, 'en'), 'Software source HTTP status 404; redirects are not followed');

  const netErr = 'connect ECONNREFUSED 127.0.0.1:51780';
  assert.equal(localizeErrorMessage(netErr, 'zh'), '连接目标服务失败：目标拒绝连接 (127.0.0.1:51780)');
  assert.equal(localizeErrorMessage(netErr, 'en'), netErr);

  const fetchErr = '无法连接本机 Launcher。请确认 Launcher 仍在运行，然后刷新。 fetch failed';
  assert.equal(localizeErrorMessage(fetchErr, 'zh'), '无法连接本机 Launcher。请确认 Launcher 仍在运行，然后刷新。 网络请求失败 (fetch failed)');

  const bootstrapErr = 'Launch code is invalid. Open a new Launcher session from its owning terminal.';
  assert.equal(localizeErrorMessage(bootstrapErr, 'zh'), '启动授权码无效或已失效。请从启动该服务的终端重新打开一次新的 Launcher 页面。');
  assert.equal(localizeErrorMessage(bootstrapErr, 'en'), bootstrapErr);

  const dBootstrap = diagnose(Object.assign(new Error(bootstrapErr), { code: 'BOOTSTRAP_INVALID' }));
  assert.equal(dBootstrap.kind, 'bootstrap-invalid');
  assert.match(dBootstrap.zh, /启动授权码/);
});
