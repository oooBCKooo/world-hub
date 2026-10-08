import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { bridgeFor, principalFor, topicFor } from './profiles.mjs';

export const DEMO_CREDENTIAL = 'world-hub-purpose-demo';
export const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function boundedText(value, name, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum) throw new Error(`${name} 必须是 1–${maximum} 字节的非空文本`);
  return value;
}
export function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} 必须是 ${minimum}–${maximum} 的整数`);
  return value;
}

export async function openState(directory, filename, initial) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; value = structuredClone(initial); }
  async function save(next) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporary, path); value = structuredClone(next);
    return structuredClone(value);
  }
  // A real file exists from the first ready signal, including initially seeded state.
  await save(value);
  return { path, get value() { return structuredClone(value); }, save };
}

export function createContext({ profile, peer, endpoint, credential, stateDir }) {
  const bridges = new Map(); const disposers = []; let stopped = false;
  const context = {
    profile, peer, stateDir,
    topic: suffix => topicFor(profile.id, suffix),
    // Addressing is principal (+ optional authenticated session), while a
    // program's bridges choose which topics/operations they receive.
    target: peerId => ({ principal: principalFor(profile.id, peerId) }),
    bridge: id => bridges.get(id ?? 'main'),
    defer: callback => disposers.push(callback),
    get stopped() { return stopped; },
    async openBridge(id, { channels = [], filters = [], operations = ['request', 'inject'], onDelivery = async () => {} } = {}) {
      if (!peer.bridges.some(bridge => bridge.id === id)) throw new Error(`未声明的桥：${id}`);
      const bridge = new Bridge({ url: endpoint, bridgeId: bridgeFor(profile.id, peer.id, id),
        credential: principalFor(profile.id, peer.id), token: credential,
        displayName: `${peer.label} / ${peer.bridges.find(item => item.id === id).label}`, reconnectMs: 250,
        cursorFile: join(stateDir, `cursor-${id}.json`), maxPendingCalls: 24 });
      bridges.set(id, bridge);
      bridge.on('error', error => {
        if (!stopped) process.stderr.write(`${JSON.stringify({ event: 'bridge-error', peer: peer.id, bridge: id, error })}\n`);
      });
      bridge.on('delivery', async message => {
        // call() owns its response subscription; business request handlers never
        // treat a response as a second business invocation.
        if (message.operation === 'response' || stopped) return;
        try { await onDelivery(message, bridge); }
        catch (error) {
          if (stopped) return;
          if (message.operation === 'request') await bridge.respond(message, { ok: false, error: String(error.message), program: peer.id });
          else await bridge.publishConfirmed(topicFor(profile.id, `${peer.id}/error`), { kind: 'demo.program-error', ok: false, error: String(error.message), receivedSeq: message.seq });
        }
      });
      await bridge.connect();
      if (bridge.welcome?.principal !== principalFor(profile.id, peer.id)) throw new Error('枢纽授权的 principal 与演示程序声明不符');
      if (channels.length) await bridge.registerChannels(channels);
      if (filters.length) await bridge.subscribe(filters, { from: 'now', operations });
      return bridge;
    },
    async close() {
      if (stopped) return; stopped = true;
      for (const dispose of disposers.reverse()) await dispose();
      await Promise.all([...bridges.values()].map(bridge => bridge.close('purpose demo stopped')));
    },
    ready() { return { event: 'ready', profile: profile.id, peer: peer.id, principal: principalFor(profile.id, peer.id), pid: process.pid,
      stateDir, bridges: [...bridges].map(([id, bridge]) => ({ id, bridgeId: bridge.welcome?.bridge, declaredId: bridge.bridgeId,
        principal: bridge.welcome?.principal, session: bridge.welcome?.session, subscriptions: bridge.subscriptions, channels: bridge.channels })) }; },
  };
  return context;
}

export const channel = (name, { publish = true, subscribe = false } = {}) => ({ name, publish, subscribe });
export async function respondOrPublish(bridge, request, body, eventTopic) {
  if (request.operation === 'request') await bridge.respond(request, body);
  if (eventTopic) await bridge.publishConfirmed(eventTopic, { ...body, receivedSeq: request.seq });
}
