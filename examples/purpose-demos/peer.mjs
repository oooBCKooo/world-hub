#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProfile } from './profiles.mjs';
import { createContext, DEMO_CREDENTIAL } from './common.mjs';
import { startEventDeskPeer } from './event-desk.mjs';
import { startAssistantPeer } from './modular-assistant.mjs';
import { startDigitalWorldPeer } from './digital-world.mjs';

const starters = { 'event-desk': startEventDeskPeer, 'modular-assistant': startAssistantPeer, 'digital-world': startDigitalWorldPeer };
export async function startPurposePeer({ profileId, peerId, endpoint, credential = DEMO_CREDENTIAL, stateDir, starter = null }) {
  const profile = getProfile(profileId), peer = profile.peers.find(item => item.id === peerId);
  if (!peer) throw new Error(`未知 ${profileId} 程序：${peerId}`);
  if (!starter && peer.entryFile) throw new Error(`此程序使用独立入口 ${peer.entryFile}，请运行该入口或用途演示启动器`);
  if (typeof endpoint !== 'string' || !/^wss?:\/\//.test(endpoint)) throw new Error('需要 ws:// 或 wss:// 枢纽 endpoint');
  if (!stateDir) throw new Error('需要独立的 state-dir');
  const context = createContext({ profile, peer, endpoint, credential, stateDir: resolve(stateDir) });
  try { await (starter ?? starters[profileId])(context); return context; }
  catch (error) { await context.close(); throw error; }
}

function argumentsFrom(argv) {
  const values = {};
  const names = { '--profile': 'profileId', '--peer': 'peerId', '--endpoint': 'endpoint', '--credential': 'credential', '--state-dir': 'stateDir' };
  for (let index = 0; index < argv.length; index++) {
    const name = names[argv[index]];
    if (!name || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`参数无效或缺少值：${argv[index]}`);
    values[name] = argv[++index];
  }
  return values;
}

// An independent program entry can reuse process ownership without reusing its
// business implementation. Its own starter handles the same wire contract.
export async function runPurposePeerMain(starter = null) {
  let context, stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    await context?.close();
    if (process.connected) process.disconnect();
  }
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
  if (process.send) { process.on('message', message => { if (message?.type === 'stop') void stop(); }); process.on('disconnect', () => void stop()); }
  try {
    context = await startPurposePeer({ ...argumentsFrom(process.argv.slice(2)), starter });
    if (stopping) await context.close();
    else { const ready = context.ready(); console.log(JSON.stringify(ready)); process.send?.(ready); }
  } catch (error) { console.error(error.message); await stop(); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPurposePeerMain();
