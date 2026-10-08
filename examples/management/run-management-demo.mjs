// Owned test fixture: normal user programs, same public mod, ordinary hub.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedProgram } from '../../tests/helpers/owned-program.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runDir = mkdtempSync(join(tmpdir(), 'peros-management-demo-'));
const configFile = join(runDir, 'hub.json');
const bridgeKeys = ['sample.alpha', 'sample.beta', 'sample.panel'];
writeFileSync(configFile, JSON.stringify({ version: '0.1', hub: { id: 'world-hub-console-demo' },
  transport: { host: '127.0.0.1', port: 0, path: '/bridge' }, log: { dir: join(runDir, 'log') },
  management: { stateFile: join(runDir, 'management.json'), annotations: {
    'sample.alpha': { bridgeName: '来源 A · 双向 mod', programs: [{ id: 'program.alpha', name: '事件程序 A' }] },
    'sample.beta': { bridgeName: '来源 B · 双向 mod', programs: [{ id: 'program.beta', name: '事件程序 B' }] },
    'sample.panel': { bridgeName: '观察程序 · 双向 mod', programs: [{ id: 'program.panel', name: '信息观察程序' }] },
  } }, acl: { credentials: { 'ui.manual': { maxConnections: 4, allow: { publish: ['#'], subscribe: ['#'] } } },
    bridges: Object.fromEntries(bridgeKeys.map(key => [key, { allow: { publish: ['playground/#'], subscribe: ['playground/#'] } }])) } }));
const children = []; let stopping = false;
async function stop() { if (stopping) return; stopping = true; for (const child of [...children].reverse()) await child.stop(); if (process.connected) process.disconnect(); }
try {
  const hub = await startOwnedProgram(join(root, 'examples/distributed-context/hub-process.mjs'), { args: ['--config', configFile, '--quiet'] }); children.push(hub);
  for (const key of bridgeKeys) children.push(await startOwnedProgram(join(root, 'examples/management/demo-peer.mjs'), {
    args: [key, key === 'sample.panel' ? 'observer' : 'source', hub.ready.endpoint],
    env: { ...process.env, HUB_CURSOR_FILE: join(runDir, `${key}.cursor.json`) },
  }));
  console.log(JSON.stringify({ event: 'ready', pid: process.pid, url: hub.ready.managementUrl,
    endpoint: hub.ready.endpoint, evidenceDir: runDir, pids: children.map(child => child.child.pid) }));
  for (const child of children) child.child.on('exit', () => { if (!stopping) { process.exitCode = 1; void stop(); } });
} catch (error) { await stop(); throw error; }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
if (process.send) {
  process.on('message', message => { if (message?.type === 'stop') void stop(); });
  process.on('disconnect', () => void stop());
}
