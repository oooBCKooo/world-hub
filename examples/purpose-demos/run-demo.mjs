// Owns an isolated demonstration session. All business is in external peers.
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedProgram } from '../../tests/helpers/owned-program.mjs';
import { getProfile, principalFor } from './profiles.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const DEMO_TOKEN = 'world-hub-purpose-demo'; // Public loopback demonstration credential.
const required = ['package.json', 'config/hub.json', 'src/hub/hub-server.mjs', 'src/hub/ws-server.mjs',
  ...['acl', 'address', 'blob-protocol', 'blob-store', 'hub', 'identity', 'router', 'store', 'topic', 'wire-json'].map(name => `src/hub/lib/${name}.mjs`),
  'src/debug/page.mjs', 'src/ui/language.mjs',
  ...['console.html', 'canvas-i18n.mjs', 'management-http.mjs', 'management-state.mjs', 'manual-bridge.mjs', 'manual-console.mjs', 'manual-i18n.mjs', 'manual-experience-state.mjs', 'manual-console.css'].map(name => `src/management/${name}`),
  'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs',
  'tests/helpers/owned-program.mjs', 'examples/distributed-context/hub-process.mjs',
  ...['profiles.mjs', 'peer.mjs', 'common.mjs', 'event-desk.mjs', 'modular-assistant.mjs', 'digital-world.mjs',
    'traffic-source.mjs', 'extension-material.mjs', 'checklist-harness.mjs', 'explorer.mjs', 'explorer.html', 'explorer.css', 'explorer.js', 'explorer-i18n.mjs']
    .map(name => `examples/purpose-demos/${name}`),
  ...['directory.mjs', 'composition.mjs', 'processor-a.mjs', 'processor-b.mjs', 'contract.json']
    .map(name => `examples/capability-directory/${name}`)];

export function parseDemoArgs(argv) {
  const options = { profile: null, stateDirectory: null, check: false, open: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--profile', '--state-dir', '--check', '--open', '--help'].includes(key) || seen.has(key)) throw new Error(`未知或重复参数：${key}`);
    seen.add(key);
    if (key === '--profile' || key === '--state-dir') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`);
      options[key === '--profile' ? 'profile' : 'stateDirectory'] = value;
    } else options[key.slice(2)] = true;
  }
  if (options.check && options.open) throw new Error('--check 与 --open 不能同时使用');
  return options;
}

async function selectProfile(id) {
  let bundled = null;
  try { bundled = JSON.parse(await readFile(join(root, 'demo-profile.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bundled && (!bundled.profile || (id && id !== bundled.profile))) throw new Error('演示包只启动 demo-profile.json 指定的场景；其他场景请使用对应包或源码仓库');
  return getProfile(id ?? bundled?.profile ?? 'event-desk');
}

export async function checkDemo({ profile: id, stateDirectory } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 4)) throw new Error('需要 Node.js 22.4 或更高版本');
  const profile = await selectProfile(id);
  for (const file of required) {
    const info = await lstat(join(root, file));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`必须是普通文件：${file}`);
  }
  // Validate using the ordinary Hub normalizer without starting its entrypoint.
  const { loadConfig } = await import('../../src/hub/lib/store.mjs');
  loadConfig(join(root, 'config/hub.json'));
  let ancestor = resolve(stateDirectory ? dirname(stateDirectory) : join(root, 'data/purpose-demos', profile.id));
  if (stateDirectory) {
    try { await lstat(resolve(stateDirectory)); throw new Error('--state-dir 必须指向尚不存在的新目录，以免覆盖或共享会话数据'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (!info.isDirectory()) throw new Error('数据路径的父级必须是目录');
      await access(ancestor, constants.W_OK); break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return { event: 'checked', passed: true, profile: profile.id, node: process.versions.node,
    nodeExecutable: process.execPath,
    programs: profile.peers.length + 1, bridges: profile.peers.reduce((n, p) => n + p.bridges.length, 1),
    writableAncestor: ancestor, startsPrograms: false, persisted: false };
}

function openBrowser(url) {
  // Only the HTTP URL produced by our loopback server reaches the OS launcher.
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('演示浏览器地址无效');
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  child.once('error', error => console.error(`自动打开失败，请手动打开 ${url}：${error.message}`));
  child.unref();
}

export async function startPurposeDemo({ profile: id, stateDirectory = null, open = false } = {}) {
  await checkDemo({ profile: id, stateDirectory });
  const profile = await selectProfile(id);
  const sessionDir = resolve(stateDirectory ?? join(root, 'data/purpose-demos', profile.id,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
  await mkdir(dirname(sessionDir), { recursive: true });
  await mkdir(sessionDir); // Never replace a previous session, including a raced creation.
  const credentials = {}, annotations = {};
  for (const peer of profile.peers) {
    const principal = principalFor(profile.id, peer.id);
    credentials[principal] = { token: profile.isolatedCredentials ? randomUUID() : DEMO_TOKEN, maxConnections: peer.bridges.length,
      allow: { publish: [`demo/${profile.id}/#`], subscribe: [`demo/${profile.id}/#`] } };
    // Management annotations describe the credential principal, not a declared
    // instance label. A program's multiple mod connections share this annotation;
    // their actual instances and channels remain separately observable.
    annotations[principal] = { bridgeName: `${peer.label} · Mod桥`,
      programs: [{ id: principal, name: peer.label }] };
  }
  const explorerPrincipal = principalFor(profile.id, 'explorer');
  credentials[explorerPrincipal] = { token: profile.isolatedCredentials ? randomUUID() : DEMO_TOKEN, maxConnections: profile.explorerMaxConnections ?? 1,
    allow: { publish: [`demo/${profile.id}/#`], subscribe: [`demo/${profile.id}/#`] } };
  credentials['ui.manual'] = { maxConnections: 4, allow: { publish: ['#'], subscribe: ['#'] } };
  annotations[explorerPrincipal] = { bridgeName: '探索界面 · 双向桥',
    programs: [{ id: explorerPrincipal, name: '用途探索界面' }] };
  const configFile = join(sessionDir, 'hub.json');
  await writeFile(configFile, JSON.stringify({ version: '0.1', hub: { id: `purpose-${profile.id}` },
    transport: { host: '127.0.0.1', port: 0, path: '/bridge' },
    log: { dir: join(sessionDir, 'log') }, blobs: { dir: join(sessionDir, 'blobs') },
    management: { stateFile: join(sessionDir, 'management.json'), annotations },
    acl: { defaultDeny: true, allowUnlistedBridges: false, credentials, bridges: {} } }, null, 2) + '\n', { flag: 'wx' });
  const children = []; let closing = null;
  const close = () => closing ??= (async () => {
    for (const child of [...children].reverse()) await child.stop();
    await mkdir(join(sessionDir, 'diagnostics'), { recursive: true });
    for (const child of children) {
      await writeFile(join(sessionDir, 'diagnostics', `${child.child.pid}.stdout.txt`), child.lines.join('\n') + '\n');
      await writeFile(join(sessionDir, 'diagnostics', `${child.child.pid}.stderr.txt`), child.stderr);
    }
    await writeFile(join(sessionDir, 'stopped.json'), JSON.stringify({ stoppedAt: new Date().toISOString(),
      pids: children.map(child => child.child.pid), exits: children.map(child => child.exited) }, null, 2) + '\n');
  })();
  try {
    const hub = await startOwnedProgram(join(root, 'examples/distributed-context/hub-process.mjs'),
      { args: ['--config', configFile, '--quiet'], cwd: root }); children.push(hub);
    const peers = [];
    for (const peer of profile.peers) {
      const stateDir = join(sessionDir, 'programs', peer.id); await mkdir(stateDir, { recursive: true });
      const child = await startOwnedProgram(join(root, 'examples/purpose-demos', peer.entryFile ?? 'peer.mjs'), {
        args: ['--profile', profile.id, '--peer', peer.id, '--endpoint', hub.ready.endpoint,
          '--credential', credentials[principalFor(profile.id, peer.id)].token, '--state-dir', stateDir], cwd: root });
      children.push(child); peers.push({ id: peer.id, label: peer.label, pid: child.child.pid, ready: child.ready });
    }
    const settingsFile = join(sessionDir, 'explorer-settings.json');
    await writeFile(settingsFile, JSON.stringify({ profile: profile.id, endpoint: hub.ready.endpoint,
      managementUrl: hub.ready.managementUrl, credential: credentials[explorerPrincipal].token, stateDirectory: sessionDir, peers,
      hubPid: hub.child.pid }, null, 2) + '\n', { flag: 'wx' });
    const explorer = await startOwnedProgram(join(root, 'examples/purpose-demos/explorer.mjs'),
      { args: ['--settings', settingsFile], cwd: root }); children.push(explorer);
    const ready = { event: 'ready', profile: profile.id, title: profile.title, pid: process.pid,
      nodeExecutable: process.execPath, node: process.versions.node,
      url: explorer.ready.url, managementUrl: hub.ready.managementUrl, endpoint: hub.ready.endpoint,
      stateDirectory: sessionDir, pids: children.map(child => child.child.pid), peers };
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify(ready, null, 2) + '\n', { flag: 'wx' });
    for (const child of children) child.child.once('exit', () => {
      if (!closing) { console.error(`演示程序退出：${child.child.pid}`); process.exitCode = 1; void close().catch(error => console.error(error.message)); }
    });
    if (children.some(child => child.exited)) throw new Error('有演示程序在准备完成前退出');
    if (open) openBrowser(ready.url);
    return { ready, profile, children, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let session; let pending; let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { if (pending) session ??= await pending; if (session) await session.close(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { if (process.connected) process.disconnect(); }
  };
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
  if (process.send) {
    process.on('message', message => { if (message?.type === 'stop') void stop(); });
    process.on('disconnect', () => void stop());
  }
  try {
    const options = parseDemoArgs(process.argv.slice(2));
    if (options.help) {
      console.log('node examples/purpose-demos/run-demo.mjs [--profile event-desk|modular-assistant|digital-world|capability-directory] [--state-dir 新目录] [--check | --open]');
      if (process.connected) process.disconnect();
    } else if (options.check) {
      console.log(JSON.stringify(await checkDemo(options)));
      if (process.connected) process.disconnect();
    } else {
      pending = startPurposeDemo(options); session = await pending;
      if (stopping) await stop();
      else {
        console.log(JSON.stringify(session.ready));
        if (process.send) process.send(session.ready);
        console.log(`打开 ${session.ready.url} 探索 ${session.ready.title}；Ctrl+C 停止所属程序。记录保留于 ${session.ready.stateDirectory}`);
      }
    }
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; if (session) await session.close(); if (process.connected) process.disconnect(); }
}
