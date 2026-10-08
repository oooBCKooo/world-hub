// 零依赖 WebSocket 服务端（RFC6455 子集）。
//
// 存在理由：枢纽是"十字路口"，少一个依赖就少一条被外部代码污染的路径。
// 只实现枢纽需要的东西：文本帧、ping/pong、close、分片重组、有界载荷。
// 不支持：扩展协商、子协议、二进制帧（线协议文本帧，见《通讯契约》）。

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const READ_HEAD = 0;
const READ_LEN16 = 1;
const READ_LEN64 = 2;
const READ_MASK = 3;
const READ_BODY = 4;

/** 应用层 close code（RFC6455 §7.4.1 之外的区间留给应用） */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED: 1003,
  POLICY: 1008,
  TOO_LARGE: 1009,
  INTERNAL: 1011,
  // 1008 = policy violation。枢纽用它表达"ACL 拒绝""握手失败"这类拒绝。
};

/**
 * @param {import('node:http').Server} httpServer
 * @param {{path?: string, maxPayload?: number, pingIntervalMs?: number, maxBufferedBytes?: number}} [options]
 */
export function attachWebSocketServer(httpServer, options = {}) {
  const path = options.path ?? '/bridge';
  const maxPayload = options.maxPayload ?? 4 * 1024 * 1024;
  const pingIntervalMs = options.pingIntervalMs ?? 0;
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) throw new Error('maxBufferedBytes must be a positive safe integer');
  const connections = new Set();

  const listeners = {
    connection: [],
    message: [],
    close: [],
    pong: [],
  };

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (typeof key !== 'string' || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn = new Connection(socket, { maxPayload, pingIntervalMs, maxBufferedBytes });
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    conn.on('message', (data) => {
      for (const fn of listeners.message) fn(conn, data);
    });
    conn.on('pong', () => {
      for (const fn of listeners.pong) fn(conn);
    });
    conn.on('close', (code, reason) => {
      for (const fn of listeners.close) fn(conn, code, reason);
    });
    // Upgrade may already contain the first WebSocket frame. Install the
    // consumer before decoding it so messages and protocol closes are visible.
    for (const fn of listeners.connection) fn(conn, req);
    if (head && head.length > 0) conn._feed(head);
  });

  return {
    on(event, fn) {
      listeners[event].push(fn);
      return this;
    },
    connections,
    closeAll(code = CLOSE.GOING_AWAY, reason = 'server closing') {
      for (const conn of [...connections]) conn.close(code, reason);
    },
  };
}

class Connection {
  #socket;
  #buffer = Buffer.alloc(0);
  #state = READ_HEAD;
  #frame = null; // { fin, opcode, masked, length, mask, payload }
  #fragmentBuffer = Buffer.alloc(0);
  #fragmentBytes = 0;
  #fragmentOpcode = 0;
  #closed = false;
  #closeEmitted = false;
  #handlers = { message: [], close: [], pong: [] };
  #pingTimer = null;
  #pingIntervalMs;
  #maxPayload;
  #maxBufferedBytes;
  #alive = true;

  constructor(socket, { maxPayload, pingIntervalMs, maxBufferedBytes }) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.#maxBufferedBytes = maxBufferedBytes;
    this.#pingIntervalMs = pingIntervalMs;
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('error', () => this._destroy());
    socket.on('close', () => this.#emitClose(1006, 'socket closed'));
    if (pingIntervalMs > 0) {
      this.#pingTimer = setInterval(() => this.ping(), pingIntervalMs);
      this.#pingTimer.unref?.();
    }
  }

  on(event, fn) {
    this.#handlers[event]?.push(fn);
    return this;
  }

  #emit(event, ...args) {
    for (const fn of this.#handlers[event] ?? []) fn(...args);
  }

  _feed(chunk) {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    try {
      this.#parse();
    } catch (err) {
      this.close(CLOSE.PROTOCOL_ERROR, String(err?.message ?? err).slice(0, 100));
    }
  }

  #parse() {
    for (;;) {
      if (this.#closed) return;
      if (this.#state === READ_HEAD) {
        if (this.#buffer.length < 2) return;
        const b0 = this.#buffer[0];
        const b1 = this.#buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        const len7 = b1 & 0x7f;
        if (rsv !== 0) throw new Error('reserved bits set');
        if (!masked) throw new Error('client frame not masked');
        this.#frame = { fin, opcode, masked, length: len7, mask: null, payload: null };
        this.#buffer = this.#buffer.subarray(2);
        if (len7 === 126) this.#state = READ_LEN16;
        else if (len7 === 127) this.#state = READ_LEN64;
        else this.#state = READ_MASK;
      } else if (this.#state === READ_LEN16) {
        if (this.#buffer.length < 2) return;
        this.#frame.length = this.#buffer.readUInt16BE(0);
        this.#buffer = this.#buffer.subarray(2);
        this.#state = READ_MASK;
      } else if (this.#state === READ_LEN64) {
        if (this.#buffer.length < 8) return;
        const big = this.#buffer.readBigUInt64BE(0);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
        this.#frame.length = Number(big);
        this.#buffer = this.#buffer.subarray(8);
        this.#state = READ_MASK;
      } else if (this.#state === READ_MASK) {
        if (this.#buffer.length < 4) return;
        this.#frame.mask = this.#buffer.subarray(0, 4);
        this.#buffer = this.#buffer.subarray(4);
        this.#state = READ_BODY;
      } else {
        const need = this.#frame.length;
        if (need > this.#maxPayload) throw new Error(`payload exceeds ${this.#maxPayload}`);
        if (this.#buffer.length < need) return;
        const raw = this.#buffer.subarray(0, need);
        this.#buffer = this.#buffer.subarray(need);
        const mask = this.#frame.mask;
        const payload = Buffer.allocUnsafe(need);
        for (let i = 0; i < need; i++) payload[i] = raw[i] ^ mask[i & 3];
        const frame = { ...this.#frame, payload };
        this.#frame = null;
        this.#state = READ_HEAD;
        this.#handleFrame(frame);
      }
    }
  }

  #handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    if (opcode === OP_PING) {
      if (!fin || payload.length > 125) throw new Error('invalid control frame');
      this.#writeFrame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      if (!fin || payload.length > 125) throw new Error('invalid control frame');
      this.#alive = true;
      this.#emit('pong');
      return;
    }
    if (opcode === OP_CLOSE) {
      if (!fin || payload.length > 125 || payload.length === 1) throw new Error('invalid close frame');
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.NORMAL;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.close(code === 1005 || code === 1006 ? CLOSE.NORMAL : code, '');
      this.#emitClose(code, reason);
      return;
    }
    if (opcode === OP_CONT) {
      if (this.#fragmentOpcode === 0) throw new Error('continuation without start');
      this.#appendFragment(payload);
      if (fin) {
        const full = this.#fragmentBuffer.subarray(0, this.#fragmentBytes);
        const op = this.#fragmentOpcode;
        this.#resetFragments();
        this.#deliver(op, full);
      }
      return;
    }
    if (opcode !== OP_TEXT && opcode !== OP_BIN) throw new Error(`unknown opcode ${opcode}`);
    if (this.#fragmentOpcode !== 0) throw new Error('new data frame during fragmented message');
    if (opcode === OP_BIN) { this.close(CLOSE.UNSUPPORTED, 'text frames required'); return; }
    if (!fin) {
      this.#fragmentOpcode = opcode;
      this.#appendFragment(payload);
      return;
    }
    this.#deliver(opcode, payload);
  }

  #appendFragment(payload) {
    const length = this.#fragmentBytes + payload.length;
    if (length > this.#maxPayload) throw new Error('fragmented payload exceeds limit');
    if (payload.length === 0) return;
    if (length > this.#fragmentBuffer.length) {
      let capacity = Math.min(this.#maxPayload, Math.max(256, this.#fragmentBuffer.length));
      while (capacity < length) capacity = Math.min(this.#maxPayload, capacity * 2);
      const buffer = Buffer.allocUnsafe(capacity);
      this.#fragmentBuffer.subarray(0, this.#fragmentBytes).copy(buffer);
      this.#fragmentBuffer = buffer;
    }
    payload.copy(this.#fragmentBuffer, this.#fragmentBytes);
    this.#fragmentBytes = length;
  }

  #resetFragments() {
    this.#fragmentBuffer = Buffer.alloc(0);
    this.#fragmentBytes = 0;
    this.#fragmentOpcode = 0;
  }

  #deliver(opcode, payload) {
    if (payload.length > this.#maxPayload) throw new Error('payload exceeds limit');
    this.#emit('message', new TextDecoder('utf-8', { fatal: true }).decode(payload));
  }

  send(text) {
    if (this.#closed || this.#socket.destroyed) return false;
    if (Buffer.byteLength(text, 'utf8') > this.#maxPayload) {
      this.#terminateWithoutFrame(CLOSE.TOO_LARGE, 'outgoing payload exceeds limit');
      return false;
    }
    return this.#writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  ping() {
    if (this.#closed) return;
    if (!this.#alive) {
      this._destroy();
      return;
    }
    this.#alive = false;
    this.#writeFrame(OP_PING, Buffer.alloc(0));
  }

  close(code = CLOSE.NORMAL, reason = '') {
    if (this.#closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this.#writeFrame(OP_CLOSE, payload);
    } catch {
      /* socket already gone */
    }
    this.#closed = true;
    clearInterval(this.#pingTimer);
    // 给对端一点时间收到 close 帧，然后强制结束。
    setTimeout(() => this.#socket.destroy(), 50).unref?.();
    this.#emitClose(code, reason);
  }

  #emitClose(code, reason) {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.#resetFragments();
    clearInterval(this.#pingTimer);
    this.#emit('close', code, reason);
  }

  #writeFrame(opcode, payload) {
    if (this.#closed || this.#socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode，服务端帧不加掩码
    if (this.#socket.writableLength + header.length + len > this.#maxBufferedBytes) {
      // Do not append even a close frame to an already full output queue. The
      // connection's local close event records the reason; protected input can
      // be pulled again by the next connection instead of buffering forever.
      this.#terminateWithoutFrame(1013, 'output queue full');
      return false;
    }
    this.#socket.write(Buffer.concat([header, payload]));
    return true;
  }

  #terminateWithoutFrame(code, reason) {
    this.#closed = true;
    clearInterval(this.#pingTimer);
    this.#socket.destroy();
    this.#emitClose(code, reason);
  }

  _destroy() {
    this.#closed = true;
    clearInterval(this.#pingTimer);
    this.#socket.destroy();
    this.#emitClose(1006, 'destroyed');
  }

  get remoteAddress() {
    return this.#socket.remoteAddress ?? null;
  }
}
