import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from '../../src/hub/ws-server.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { Acl } from '../../src/hub/lib/acl.mjs';

function maskedFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([(fin ? 128 : 0) | opcode, 128 | length, 0, 0, 0, 0]);
  else {
    header = Buffer.alloc(8);
    header[0] = (fin ? 128 : 0) | opcode;
    header[1] = 128 | 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

async function startTransport(maxPayload = 1024, options = {}, onConnection) {
  const server = createServer();
  const wss = attachWebSocketServer(server, { maxPayload, ...options });
  const records = [];
  wss.on('connection', (connection, req) => {
    const record = { connection, socket: req.socket, messages: [], closeCodes: [], waiters: [] };
    records.push(record);
    const notify = () => {
      for (const waiter of [...record.waiters]) if (waiter.predicate(record)) {
        clearTimeout(waiter.timer);
        record.waiters.splice(record.waiters.indexOf(waiter), 1);
        waiter.resolve(record);
      }
    };
    connection.on('message', (message) => { record.messages.push(message); notify(); });
    connection.on('close', (code) => { record.closeCodes.push(code); notify(); });
    record.wait = (predicate) => {
      if (predicate(record)) return Promise.resolve(record);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('transport event timeout')), 5000) };
        record.waiters.push(waiter);
      });
    };
    onConnection?.(connection, record);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  return {
    async open(initialFrames = Buffer.alloc(0)) {
      const socket = connect(server.address().port, '127.0.0.1');
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('data', (data) => {
          if (data.toString().startsWith('HTTP/1.1 101')) resolve();
          else reject(new Error('WebSocket handshake failed'));
        });
        const request = 'GET /bridge HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: aaaaaaaaaaaaaaaaaaaaaa==\r\nSec-WebSocket-Version: 13\r\n\r\n';
        socket.once('connect', () => socket.write(Buffer.concat([Buffer.from(request), initialFrames])));
      });
      return { socket, record: records.at(-1) };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      wss.closeAll();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('transport shutdown timeout')), 2000);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

async function barrier(socket, frames) {
  const pong = new Promise((resolve) => socket.once('data', resolve));
  socket.write(Buffer.concat([frames, maskedFrame(9, Buffer.from('barrier'))]));
  await pong;
}

async function fragmentStress() {
  const count = 200000;
  const transport = await startTransport(count + 1);
  try {
    const empty = await transport.open();
    empty.socket.write(maskedFrame(1, Buffer.alloc(0), false));
    const emptyFrames = Buffer.alloc(6 * count).fill(maskedFrame(0, Buffer.alloc(0), false));
    await barrier(empty.socket, emptyFrames);
    global.gc();
    const emptyHeap = process.memoryUsage().heapUsed;
    empty.socket.write(maskedFrame(0));
    await empty.record.wait((r) => r.messages.length > 0);
    assert.equal(empty.record.messages[0], '');
    assert.deepEqual(empty.record.closeCodes, []);
    empty.socket.destroy();

    const small = await transport.open();
    small.socket.write(maskedFrame(1, Buffer.alloc(0), false));
    const smallFrame = maskedFrame(0, Buffer.from('a'), false);
    await barrier(small.socket, Buffer.alloc(smallFrame.length * count).fill(smallFrame));
    global.gc();
    const smallHeap = process.memoryUsage().heapUsed;
    small.socket.write(maskedFrame(0, Buffer.from('b')));
    await small.record.wait((r) => r.messages.length > 0);
    assert.equal(small.record.messages[0], 'a'.repeat(count) + 'b');
    assert.deepEqual(small.record.closeCodes, []);
    console.log(JSON.stringify({ count, emptyHeap, smallHeap, decodedBytes: small.record.messages[0].length }));
  } finally { await transport.close(); }
}

if (process.argv.includes('--stress-helper')) {
  await fragmentStress();
} else {
  test('config: identical IDs in bridge and credential ACL namespaces are rejected', () => {
    const bridges = { shared: { token: 'admin', allow: { publish: ['#'], subscribe: ['#'] } } };
    const credentials = { shared: { token: 'limited', maxConnections: 2, allow: { publish: ['public/#'], subscribe: ['public/#'] } } };
    assert.throws(() => normalizeConfig({ acl: { bridges, credentials } }), /both acl\.bridges and acl\.credentials/);
  });

  test('config: distinct identities preserve each authentication grant', () => {
    const bridges = { administrator: { token: 'admin', allow: { publish: ['#'], subscribe: ['#'] } } };
    const credentials = { reader: { token: 'limited', maxConnections: 2, allow: { publish: [], subscribe: ['public/#'] } } };
    const acl = new Acl(normalizeConfig({ acl: { bridges, credentials } }));
    assert.equal(acl.authenticate('program', 'limited', '127.0.0.1', 'reader', 0).ok, true);
    assert.equal(acl.canSubscribe('reader', 'private/#').ok, false);
    assert.equal(acl.canSubscribe('reader', 'public/#').ok, true);
    assert.equal(acl.canSubscribe('administrator', '#').ok, true);
  });

  test('transport: upgrade and initial hello in one TCP write preserve frame order and normal close', async (t) => {
    const transport = await startTransport();
    t.after(() => transport.close());
    const hello = JSON.stringify({ type: 'hello', wire: '0.1', bridge: 'head.reader' });
    const { socket, record } = await transport.open(Buffer.concat([
      maskedFrame(1, Buffer.from(hello)), maskedFrame(1, Buffer.from('same-write-followup')),
    ])); // open() verifies that the HTTP response starts with 101.
    socket.write(maskedFrame(1, Buffer.from('after-upgrade')));
    await record.wait((r) => r.messages.includes('after-upgrade'));
    assert.deepEqual(record.messages, [hello, 'same-write-followup', 'after-upgrade']);
    assert.deepEqual(JSON.parse(record.messages[0]), { type: 'hello', wire: '0.1', bridge: 'head.reader' });
    const code = Buffer.alloc(2); code.writeUInt16BE(1000);
    socket.write(maskedFrame(8, code));
    await record.wait((r) => r.closeCodes.length > 0);
    assert.deepEqual(record.closeCodes, [1000]);
  });

  test('transport: invalid UTF-8 in upgrade head reaches the registered close observer once', async (t) => {
    const transport = await startTransport();
    t.after(() => transport.close());
    const { record } = await transport.open(maskedFrame(1, Buffer.from([0xff])));
    await record.wait((r) => r.closeCodes.length > 0);
    assert.deepEqual(record.messages, []);
    assert.deepEqual(record.closeCodes, [1002]);
  });

  test('transport: connection callback rejection suppresses frames buffered in upgrade head', async (t) => {
    const transport = await startTransport(1024, {}, (connection) => connection.close(1008, 'rejected at connection'));
    t.after(() => transport.close());
    const { record } = await transport.open(maskedFrame(1, Buffer.from('must-not-be-delivered')));
    assert.deepEqual(record.messages, []);
    assert.deepEqual(record.closeCodes, [1008]);
  });

  test('transport: many empty and tiny fragments retain bounded heap and assemble exactly', async () => {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--expose-gc', '--max-old-space-size=32', fileURLToPath(import.meta.url), '--stress-helper'],
      { timeout: 15000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.count, 200000);
    assert.equal(result.decodedBytes, 200001);
    assert.ok(result.emptyHeap < 20 * 1024 * 1024, JSON.stringify(result));
    assert.ok(result.smallHeap < 20 * 1024 * 1024, JSON.stringify(result));
  });

  test('transport: multibyte UTF-8 split across frames decodes only after complete assembly', async (t) => {
    const transport = await startTransport(3);
    t.after(() => transport.close());
    const { socket, record } = await transport.open();
    const bytes = Buffer.from('世');
    socket.write(Buffer.concat([
      maskedFrame(1, bytes.subarray(0, 1), false),
      maskedFrame(0, bytes.subarray(1, 2), false),
      maskedFrame(0, bytes.subarray(2)),
    ]));
    await record.wait((r) => r.messages.length > 0);
    assert.deepEqual(record.messages, ['世']);
    assert.deepEqual(record.closeCodes, []);
  });

  test('transport: aggregate fragment bytes exceeding the limit never reach the consumer', async (t) => {
    const transport = await startTransport(8);
    t.after(() => transport.close());
    const { socket, record } = await transport.open();
    socket.write(Buffer.concat([maskedFrame(1, Buffer.from('1234567'), false), maskedFrame(0, Buffer.from('89'))]));
    await record.wait((r) => r.closeCodes.length > 0);
    assert.deepEqual(record.messages, []);
    assert.deepEqual(record.closeCodes, [1002]);
  });

  test('transport: binary rejection prevents later frames in the same chunk from delivery', async (t) => {
    const transport = await startTransport();
    t.after(() => transport.close());
    const { socket, record } = await transport.open();
    socket.write(Buffer.concat([maskedFrame(2), maskedFrame(1, Buffer.from('after-close'))]));
    await record.wait((r) => r.closeCodes.length > 0);
    assert.deepEqual(record.closeCodes, [1003]);
    assert.deepEqual(record.messages, []);
  });

  test('transport: malformed UTF-8 is rejected instead of being replaced inside a text payload', async (t) => {
    const transport = await startTransport();
    t.after(() => transport.close());
    const { socket, record } = await transport.open();
    socket.write(maskedFrame(1, Buffer.from([0xc3, 0x28])));
    await record.wait((r) => r.closeCodes.length > 0);
    assert.deepEqual(record.closeCodes, [1002]);
    assert.deepEqual(record.messages, []);
  });

  test('transport: outgoing messages retain the individual payload limit', async t => {
    const transport = await startTransport(8); t.after(() => transport.close());
    const { record } = await transport.open();
    assert.equal(record.connection.send('123456789'), false);
    await record.wait(r => r.closeCodes.length > 0);
    assert.deepEqual(record.closeCodes, [1009]);
    assert.equal(record.connection.send('more'), false);
  });

  test('transport: a slow reader cannot grow the server output buffer beyond its limit', async t => {
    const limit = 256 * 1024;
    const transport = await startTransport(64 * 1024, { maxBufferedBytes: limit }); t.after(() => transport.close());
    const { socket, record } = await transport.open();
    socket.pause();
    let serverSocket;
    // Read-only socket accounting verifies the actual transport queue, rather
    // than a mock send method. The accepted HTTP socket is the same WS socket.
    // startTransport records it through the new local observation below.
    serverSocket = record.socket;
    assert.ok(serverSocket);
    const payload = 'x'.repeat(64 * 1024); let highWater = 0, sent = 0;
    for (; sent < 8192; sent++) {
      const accepted = record.connection.send(payload);
      highWater = Math.max(highWater, serverSocket.writableLength);
      if (!accepted) break;
    }
    assert.ok(sent < 8192, 'output capacity must stop an indefinitely stalled reader');
    assert.ok(highWater <= limit, `server queue reached ${highWater} bytes`);
    assert.deepEqual(record.closeCodes, [1013]);
    assert.equal(record.connection.send('after overflow'), false);
    assert.equal(serverSocket.destroyed, true);
  });
}
