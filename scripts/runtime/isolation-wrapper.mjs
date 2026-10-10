// Runs inside the optional network=none Linux container. Only the host broker
// selects a Hub destination; the external program uses its ordinary SDK.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { attachWebSocketServer } from '../../src/hub/ws-server.mjs';
import { ISOLATION_EVENT, channelChunks, collectChannelChunk } from './isolation-channel.mjs';

const [entry, configPath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const server = createServer((request, response) => { response.writeHead(404); response.end(); });
const ws = attachWebSocketServer(server, { maxPayload: 4 * 1024 * 1024, maxBufferedBytes: 8 * 1024 * 1024 });
const connections = new Map(), incoming = new Map();
ws.on('connection', connection => {
  if (connections.size >= config.bridges.length) { connection.close(1008, 'Connection limit'); return; }
  const id = randomUUID(); connections.set(id, connection); connection.isolationId = id;
  emit({ event: ISOLATION_EVENT, operation: 'open', connection: id });
});
ws.on('message', (connection, text) => {
  if (!connections.has(connection.isolationId)) return;
  for (const frame of channelChunks(connection.isolationId, text)) emit(frame);
});
ws.on('close', connection => {
  const id = connection.isolationId; if (!connections.delete(id)) return;
  incoming.delete(id); emit({ event: ISOLATION_EVENT, operation: 'close', connection: id });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
for (const bridge of config.bridges) bridge.endpoint = `ws://127.0.0.1:${server.address().port}/bridge`;
config.stateDir = '/state';
await writeFile('/tmp/runtime-config.json', JSON.stringify(config));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (line.length > 131072) return;
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.event === ISOLATION_EVENT) {
    const connection = connections.get(frame.connection); if (!connection) return;
    if (frame.operation === 'close') { connection.close(1001, 'Host channel closed'); return; }
    try {
      const result = collectChannelChunk(incoming.get(frame.connection), frame);
      if (result.pending) incoming.set(frame.connection, result.pending); else incoming.delete(frame.connection);
      if (result.text !== null) connection.send(result.text);
    } catch { connection.close(1008, 'Invalid host frame'); }
  }
  if (frame.command === 'stop') {
    // Headless applications own graceful work completion; adapter only retires
    // its extra listener. The supervisor force-stops a noncooperative container.
    setTimeout(() => { ws.closeAll(); server.closeAllConnections(); server.close(); input.close(); process.stdin.pause(); }, 100).unref();
  }
});
input.on('close', () => { ws.closeAll(); server.closeAllConnections(); server.close(); });
process.argv = [process.execPath, entry, '--runtime-config', '/tmp/runtime-config.json'];
emit({ event: 'isolation-ready', nodeVersion: process.versions.node, user: process.getuid(), profile: 'docker-node-headless/v1' });
await import(pathToFileURL(entry).href);
