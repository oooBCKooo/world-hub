// Application-side support. The hub never imports this module or these settings.
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';

const DEFAULT_CONFIG = fileURLToPath(new URL('../programs.config.json', import.meta.url));
export function loadSettings(argv = process.argv.slice(2)) {
  let file = DEFAULT_CONFIG;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) file = resolve(argv[++i]);
    else throw new Error(`unknown or incomplete option: ${argv[i]}`);
  }
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(file);
  settings.configFile = file;
  settings.stateDir = resolve(base, settings.stateDir ?? './.state');
  if (settings.context?.file) settings.context.file = resolve(base, settings.context.file);
  if (settings.contextProviders !== undefined) {
    if (!Array.isArray(settings.contextProviders) || !settings.contextProviders.length || settings.contextProviders.length > 32) throw new Error('contextProviders requires 1 to 32 application providers');
    const ids = new Set();
    const providerPeers = new Set();
    const bridgeIds = new Set();
    const applicationBridgeIds = new Set(['ui', 'harness'].map((name) => settings.peers?.[name]?.bridgeId).filter((id) => typeof id === 'string' && id));
    for (const provider of settings.contextProviders) {
      if (!provider || typeof provider.id !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(provider.id) || ['.', '..'].includes(provider.id)) throw new Error('context provider id must be a safe independent directory name');
      const directoryId = process.platform === 'win32' ? provider.id.toLowerCase() : provider.id;
      if (ids.has(directoryId)) throw new Error('context provider state directories must be distinct');
      if (typeof provider.peer !== 'string' || !Object.hasOwn(settings.peers ?? {}, provider.peer)) throw new Error('context provider peer must be configured');
      const bridgeId = settings.peers[provider.peer]?.bridgeId;
      if (['ui', 'harness'].includes(provider.peer) || providerPeers.has(provider.peer) || typeof bridgeId !== 'string' || !bridgeId || bridgeIds.has(bridgeId) || applicationBridgeIds.has(bridgeId)) throw new Error('context provider peers and bridge identities must be independent from each other, ui and harness');
      ids.add(directoryId);
      providerPeers.add(provider.peer);
      bridgeIds.add(bridgeId);
      if (provider.context?.file) provider.context.file = resolve(base, provider.context.file);
    }
  }
  if (settings.harness) {
    if (process.env.PEROS_DSH_ROOT) settings.harness.installRoot = process.env.PEROS_DSH_ROOT;
    for (const key of ['installRoot', 'home', 'cwd', 'patch']) {
      if (settings.harness[key]) settings.harness[key] = resolve(base, settings.harness[key]);
    }
  }
  if (!settings.hub?.url || !settings.channels || !settings.peers) throw new Error('hub.url, channels and peers are required');
  const values = Object.values(settings.channels);
  if (values.some((v) => typeof v !== 'string' || !v || /[+#]/.test(v)) || new Set(values).size !== values.length) {
    throw new Error('application channels must be distinct concrete topics');
  }
  return settings;
}

export class StateFile {
  constructor(path, initial) {
    this.path = path;
    try { this.value = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`application state cannot be read: ${path}`, { cause: err });
      this.value = structuredClone(initial);
    }
    if (!this.value || typeof this.value !== 'object' || Array.isArray(this.value)) throw new Error(`invalid application state: ${path}`);
  }
  commit(next) {
    const serialized = JSON.stringify(next, null, 2);
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      fd = openSync(temp, 'wx'); writeFileSync(fd, serialized, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.path);
      this.value = JSON.parse(serialized);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
}

// OS-exclusive application state ownership, separate from hub identity. A
// second process must not rewrite a live executor's journal during recovery.
export async function acquireStateLease(stateDir, application) {
  mkdirSync(stateDir, { recursive: true });
  let canonical = realpathSync(stateDir);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const hash = createHash('sha256').update(`${canonical}|${application}`).digest('hex').slice(0, 40);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\peros-${hash}` : join(tmpdir(), `peros-${hash}.sock`);
  const server = createServer(socket => socket.destroy());
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', (cause) => rejectListen(Object.assign(new Error(`Application state is already owned or its lock is unavailable: ${stateDir}`, { cause }), { code: 'STATE_IN_USE' })));
    server.listen(address, () => { server.removeAllListeners('error'); resolveListen(); });
  });
  let closing;
  return { address, close() { closing ??= new Promise(resolveClose => server.close(resolveClose)); return closing; } };
}

export async function connectPeer(settings, name, onDelivery, { onEvent } = {}) {
  const peer = settings.peers[name];
  if (!peer?.bridgeId) throw new Error(`missing application peer: ${name}`);
  const publication = peer.publish.map((key) => settings.channels[key]);
  const subscription = peer.subscribe.map((key) => settings.channels[key]);
  if ([...publication, ...subscription].some((t) => !t)) throw new Error(`unknown channel configured for ${name}`);
  const bridge = new Bridge({ url: settings.hub.url, bridgeId: peer.bridgeId, credential: peer.credential, token: peer.token,
    displayName: peer.displayName ?? name, cursorFile: join(settings.stateDir, `${name}.cursor.json`), reconnectMs: 100 });
  bridge.on('delivery', onDelivery);
  for (const event of ['open', 'close', 'error', 'denied', 'overflow', 'caughtUp']) bridge.on(event, (info) => {
    if (onEvent) onEvent({ event, kind: event, ...info });
    else if (['error', 'denied', 'overflow'].includes(event)) console.error(JSON.stringify({ program: name, event, ...info }));
  });
  let timer;
  try {
    await Promise.race([bridge.connect(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('hub connection timeout')), 10000); })]);
    const declarations = [...new Set([...publication, ...subscription])].map((topic) => ({ name: topic,
      publish: publication.includes(topic), subscribe: subscription.includes(topic) }));
    await bridge.registerChannels(declarations);
    await bridge.subscribe(subscription, { from: peer.from ?? 'resume' });
    return bridge;
  } catch (error) { await bridge.close(); throw error; }
  finally { clearTimeout(timer); }
}

export function isMain(url) { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url); }
export function cliLifecycle(program, extra = {}) {
  console.log(JSON.stringify({ event: 'ready', pid: process.pid, bridgeId: program.bridge.bridgeId, ...extra }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await program.close(); } catch (err) { console.error(err.message); process.exitCode = 1; }
    if (process.connected) process.disconnect();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  // An owning launcher/test uses IPC to close gracefully on Windows as well.
  if (process.send) {
    process.on('message', (message) => { if (message?.type === 'stop') void stop(); });
    process.on('disconnect', () => { void stop(); });
  }
}
