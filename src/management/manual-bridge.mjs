// A browser program's own mod. No administrator proxy, automatic ACK, release,
// reconnect, or business interpretation. Raw body text is the routing source.
const encoder = new TextEncoder();
const fail = (code, message, frame) => Object.assign(new Error(message), { code, ...(frame ? { frame } : {}) });
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const uuid = () => globalThis.crypto.randomUUID();
const WIRE = '0.1';
const REQUEST_TYPES = new Set(['register', 'publish', 'request', 'respond', 'inject', 'release', 'blob_begin', 'blob_status', 'blob_chunk', 'blob_commit', 'blob_read', 'blob_release']);
const safeCallback = (callback, ...values) => {
  try { Promise.resolve(callback?.(...values)).catch(() => {}); }
  catch { /* An observer cannot change the transport outcome. */ }
};

// JSON.parse validates syntax; its rounded diagnostic body is never sent again.
export function parseManualEnvelope(raw) {
  const frame = JSON.parse(raw);
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw fail('FRAME_INVALID', 'frame must be a JSON object');
  let at = raw.indexOf('{') + 1; const keys = new Set();
  while (at < raw.length) {
    while (/\s/.test(raw[at] ?? '') || raw[at] === ',') at++;
    if (raw[at] === '}') break;
    const begin = at++; let escaped = false;
    while (at < raw.length) { const ch = raw[at++]; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') break; }
    const key = JSON.parse(raw.slice(begin, at));
    if (keys.has(key)) throw fail('FRAME_INVALID', 'duplicate envelope field');
    keys.add(key); while (/\s/.test(raw[at] ?? '')) at++; at++;
    while (/\s/.test(raw[at] ?? '')) at++;
    const start = at; let quoted = false; let depth = 0; escaped = false;
    for (; at < raw.length; at++) {
      const ch = raw[at];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
    }
    if (key === 'body') Object.defineProperty(frame, 'bodyRaw', { value: raw.slice(start, at).trimEnd() });
  }
  return frame;
}

function encodeFrame(type, fields, bodyRaw) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw fail('FIELDS_INVALID', 'fields must be an object');
  const clean = { ...fields, type }; delete clean.bodyRaw;
  if (bodyRaw !== undefined) {
    if (typeof bodyRaw !== 'string' || !bodyRaw.trim()) throw fail('BODY_INVALID', 'bodyRaw must contain one JSON value');
    try { JSON.parse(bodyRaw); } catch { throw fail('BODY_INVALID', 'bodyRaw must contain one JSON value'); }
    clean.body = null;
  }
  return '{' + Object.entries(clean).map(([key, value]) => value === undefined ? null : `${JSON.stringify(key)}:${key === 'body' && bodyRaw !== undefined ? bodyRaw : JSON.stringify(value)}`).filter(Boolean).join(',') + '}';
}
const bytesToBase64 = (bytes) => {
  let value = ''; for (let at = 0; at < bytes.length; at += 8192) value += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(value);
};
const base64ToBytes = (value) => {
  if (typeof value !== 'string') throw fail('BLOB_CHUNK_INVALID', 'object block has no base64 data');
  let decoded; try { decoded = atob(value); } catch { throw fail('BLOB_CHUNK_INVALID', 'object block is not base64'); }
  const bytes = Uint8Array.from(decoded, (ch) => ch.charCodeAt(0));
  if (bytesToBase64(bytes) !== value) throw fail('BLOB_CHUNK_INVALID', 'object block is not canonical base64');
  return bytes;
};
const digest = async (buffer) => {
  if (!globalThis.crypto?.subtle) throw fail('CRYPTO_UNAVAILABLE', 'SHA-256 requires a secure browser context');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (b) => b.toString(16).padStart(2, '0')).join('');
};

export class ManualBridge {
  constructor({ onFrame, onSend, onState, timeoutMs = 15_000, maxFrameBytes = 4 * 1024 * 1024, maxBufferedBytes = 8 * 1024 * 1024, maxBlobBytes = 64 * 1024 * 1024, maxPending = 64 } = {}) {
    for (const [name, value] of Object.entries({ timeoutMs, maxFrameBytes, maxBufferedBytes, maxBlobBytes, maxPending })) if (!positive(value)) throw fail('OPTIONS_INVALID', `${name} must be a positive safe integer`);
    this.options = { timeoutMs, maxFrameBytes, maxBufferedBytes, maxBlobBytes, maxPending };
    this.onFrame = onFrame; this.onSend = onSend; this.onState = onState; this.welcome = null; this.ws = null;
    this.requests = new Map(); this.subscriptions = new Map(); this.unsubscribing = new Map();
    this.generation = 0; this.fileBusy = false; this.connectWaiter = null;
  }
  get connected() { return this.ws?.readyState === 1 && this.welcome !== null; }
  state(status, extra = {}) { safeCallback(this.onState, { status, ...extra }); }
  pendingCount() { return this.requests.size + [...this.subscriptions.values()].filter((s) => s.wait).length + this.unsubscribing.size; }
  requireReady() { if (!this.connected) throw fail('NOT_CONNECTED', 'connect this browser mod before sending'); }
  requireFeature(name) { this.requireReady(); if (!this.welcome.features?.includes(name)) throw fail('FEATURE_UNSUPPORTED', `Hub did not negotiate ${name}`); }
  awaitOperation(resolve, reject, remove, { timeoutMs = this.options.timeoutMs, signal } = {}) {
    if (!positive(timeoutMs)) throw fail('TIMEOUT_INVALID', 'timeoutMs must be a positive safe integer');
    if (signal?.aborted) throw fail('ABORTED', 'operation was canceled locally; retained Hub information was not released');
    let done = false;
    const finish = (method, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); remove(); method(value); };
    const timer = setTimeout(() => finish(reject, fail('TIMEOUT', 'no matching Hub receipt arrived before the local timeout; the operation may have been accepted')), timeoutMs);
    const aborted = () => finish(reject, fail('ABORTED', 'operation was canceled locally; retained Hub information was not released'));
    signal?.addEventListener('abort', aborted, { once: true });
    return { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) };
  }
  abortPending(error) {
    this.connectWaiter?.reject(error); this.connectWaiter = null;
    for (const wait of [...this.requests.values()]) wait.reject(error);
    for (const sub of [...this.subscriptions.values()]) sub.wait?.reject(error);
    for (const wait of [...this.unsubscribing.values()]) wait.reject(error);
    this.requests.clear(); this.subscriptions.clear(); this.unsubscribing.clear();
  }
  connect({ url, bridge, credential, token, displayName } = {}) {
    let endpoint;
    try { endpoint = new URL(url); } catch { return Promise.reject(fail('URL_INVALID', 'provide a ws:// or wss:// bridge URL')); }
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) return Promise.reject(fail('URL_INVALID', 'provide a ws:// or wss:// URL without embedded credentials or a fragment'));
    if (typeof bridge !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(bridge)) return Promise.reject(fail('BRIDGE_INVALID', 'bridge identity must use 1 to 64 lowercase ASCII identity characters'));
    if (credential !== undefined && credential !== '' && (typeof credential !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(credential))) return Promise.reject(fail('CREDENTIAL_INVALID', 'credential identity must use 1 to 64 lowercase ASCII identity characters'));
    if (token !== undefined && typeof token !== 'string') return Promise.reject(fail('TOKEN_INVALID', 'token must be a string'));
    this.close(); const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = new WebSocket(endpoint.href); } catch { reject(fail('CONNECT_FAILED', 'browser could not open the bridge URL')); return; }
      this.ws = socket; this.welcome = null;
      const rejectConnect = (error) => { reject(error); if (this.ws === socket) { this.ws = null; socket.close(); this.state('error', { code: error.code, message: error.message }); } };
      this.connectWaiter = this.awaitOperation(resolve, rejectConnect, () => { this.connectWaiter = null; }, {});
      this.state('connecting');
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return;
        try {
          const hello = encodeFrame('hello', { wire: WIRE, bridge, ...(credential ? { credential } : {}), ...(token ? { token } : {}), ...(displayName ? { displayName } : {}) });
          if (encoder.encode(hello).byteLength > Math.min(this.options.maxFrameBytes, this.options.maxBufferedBytes)) throw fail('FRAME_TOO_LARGE', 'hello exceeds the local frame or send-buffer limit');
          socket.send(hello);
        }
        catch (error) { this.abortPending(error.code ? error : fail('CONNECT_FAILED', 'could not send hello')); socket.close(); }
        finally { token = undefined; credential = undefined; }
      }, { once: true });
      socket.addEventListener('message', (event) => { if (generation === this.generation) this.receive(event.data); });
      socket.addEventListener('error', () => {
        if (generation !== this.generation) return;
        this.abortPending(fail('SOCKET_ERROR', 'WebSocket failed; browser security and the endpoint may be checked'));
        this.welcome = null; this.state('error', { code: 'SOCKET_ERROR', message: 'WebSocket failed' }); socket.close();
      });
      socket.addEventListener('close', (event) => {
        if (generation !== this.generation) return;
        this.ws = null; this.welcome = null; token = undefined; credential = undefined;
        this.abortPending(fail('DISCONNECTED', `bridge closed (${event.code}); no automatic reconnect`));
        this.state('closed', { code: event.code, message: event.reason || 'connection closed' });
      });
    });
  }
  close() {
    ++this.generation; const socket = this.ws; this.ws = null; this.welcome = null;
    this.abortPending(fail('DISCONNECTED', 'browser mod disconnected by user'));
    if (socket && socket.readyState < 2) { try { socket.close(1000, 'user disconnected'); } catch { /* Already closing. */ } }
    this.state('closed');
  }
  disconnect() { this.close(); }
  sendRaw(raw) {
    this.requireReady();
    if (typeof raw !== 'string') throw fail('FRAME_INVALID', 'raw frame must be text');
    const frameBytes = encoder.encode(raw).byteLength;
    if (frameBytes > this.options.maxFrameBytes) throw fail('FRAME_TOO_LARGE', 'frame exceeds this browser mod local byte limit');
    const frame = parseManualEnvelope(raw);
    if (this.ws.bufferedAmount + frameBytes > this.options.maxBufferedBytes) throw fail('SEND_BUFFER_FULL', 'browser send queue is full; retry after it drains');
    try { this.ws.send(raw); } catch { throw fail('SEND_FAILED', 'browser could not queue this frame'); }
    if (frame.type !== 'hello') safeCallback(this.onSend, raw, frame);
  }
  command(type, fields = {}, opts = {}) {
    try {
      this.requireReady();
      if (!REQUEST_TYPES.has(type)) throw fail('COMMAND_UNSUPPORTED', 'use subscribe, unsubscribe, ack, resume, or raw send for this frame type');
      if (type.startsWith('blob_') || fields.attachments !== undefined) this.requireFeature('blob-v1');
      if (['request', 'respond', 'inject'].includes(type)) this.requireFeature('directed-v1');
      if (this.pendingCount() >= this.options.maxPending) throw fail('PENDING_LIMIT', 'too many pending browser operations');
      const requestToken = uuid(); const raw = encodeFrame(type, { ...fields, requestToken }, opts.bodyRaw ?? fields.bodyRaw);
      return new Promise((resolve, reject) => {
        let wait;
        try { wait = this.awaitOperation(resolve, reject, () => this.requests.delete(requestToken), opts); wait.type = type; this.requests.set(requestToken, wait); this.sendRaw(raw); }
        catch (error) { if (wait) wait.reject(error); else reject(error); }
      });
    } catch (error) { return Promise.reject(error); }
  }
  subscribe(fields = {}, opts = {}) {
    try {
      this.requireReady(); const { filters, from, operations, delivery } = fields;
      if (!Array.isArray(filters) || !filters.length || filters.length > (this.welcome.limits?.maxFiltersPerSubscription ?? 16) || filters.some((f) => typeof f !== 'string' || !f.length || f.length > 512)) throw fail('FILTER_INVALID', 'provide nonempty topic filters within the negotiated limit');
      if (from !== undefined && from !== 'now' && (!Number.isSafeInteger(from) || from < 0)) throw fail('CURSOR_INVALID', 'from must be now or a nonnegative safe integer');
      if (operations !== undefined && (!Array.isArray(operations) || !operations.length || operations.length > 4 || new Set(operations).size !== operations.length || operations.some((op) => !['publish', 'request', 'inject', 'response'].includes(op)))) throw fail('OPERATIONS_INVALID', 'operations must be a distinct nonempty wire operation subset');
      if (delivery !== undefined && !['bounded_ack', 'at_least_once', 'at_most_once'].includes(delivery)) throw fail('DELIVERY_INVALID', 'unsupported delivery mode');
      if (this.pendingCount() >= this.options.maxPending || this.subscriptions.size >= (this.welcome.limits?.maxSubscriptionsPerBridge ?? 64)) throw fail('PENDING_LIMIT', 'browser subscription or pending-operation limit reached');
      const token = uuid(); const sub = { token, filters: [...filters], subscription: null, receipt: null, wait: null };
      return new Promise((resolve, reject) => {
        try {
          sub.wait = this.awaitOperation(resolve, reject, () => { sub.wait = null; if (!sub.subscription) this.subscriptions.delete(token); }, opts);
          this.subscriptions.set(token, sub); this.sendRaw(encodeFrame('subscribe', { ...fields, token }));
        } catch (error) { if (sub.wait) sub.wait.reject(error); else reject(error); }
      });
    } catch (error) { return Promise.reject(error); }
  }
  unsubscribe(subscription, opts = {}) {
    try {
      this.requireReady(); if (typeof subscription !== 'string' || !subscription) throw fail('SUBSCRIPTION_INVALID', 'choose a subscription ID');
      if (this.unsubscribing.has(subscription) || this.pendingCount() >= this.options.maxPending) throw fail('PENDING_LIMIT', 'unsubscribe is pending or browser pending-operation limit reached');
      return new Promise((resolve, reject) => {
        let wait;
        try { wait = this.awaitOperation(resolve, reject, () => this.unsubscribing.delete(subscription), opts); this.unsubscribing.set(subscription, wait); this.sendRaw(encodeFrame('unsubscribe', { subscription })); }
        catch (error) { if (wait) wait.reject(error); else reject(error); }
      });
    } catch (error) { return Promise.reject(error); }
  }
  ack(subscription, seq) {
    if (typeof subscription !== 'string' || !subscription || !Array.isArray(seq) || !seq.length || seq.length > 128 || seq.some((n) => !positive(n))) throw fail('ACK_INVALID', 'ACK needs a subscription ID and 1 to 128 positive safe sequences');
    this.sendRaw(encodeFrame('ack', { subscription, seq }));
  }
  resume(subscription) {
    if (typeof subscription !== 'string' || !subscription) throw fail('SUBSCRIPTION_INVALID', 'choose a subscription ID');
    this.sendRaw(encodeFrame('resume', { subscription }));
  }
  receive(raw) {
    let frame;
    try {
      if (typeof raw !== 'string' || encoder.encode(raw).byteLength > this.options.maxFrameBytes) throw fail('FRAME_TOO_LARGE', 'received frame is non-text or exceeds the browser local byte limit');
      frame = parseManualEnvelope(raw);
    } catch (error) { this.abortPending(error); this.state('error', { code: error.code ?? 'FRAME_INVALID', message: 'received invalid frame' }); this.ws?.close(1008, 'invalid frame'); return; }
    safeCallback(this.onFrame, raw, frame);
    if (frame.type === 'welcome') {
      if (!this.connectWaiter) return;
      if (frame.hubWire !== WIRE) { this.connectWaiter.reject(fail('WIRE_VERSION_UNSUPPORTED', 'Hub welcome has a different wire version', frame)); return; }
      this.welcome = frame; this.connectWaiter.resolve(frame); this.state('connected', { welcome: frame }); return;
    }
    if (frame.type === 'denied' || frame.type === 'error') {
      const error = fail(frame.code ?? 'HUB_ERROR', `${frame.code ?? 'HUB_ERROR'}: ${frame.message ?? 'Hub rejected this frame'}`, frame);
      if (this.connectWaiter) this.connectWaiter.reject(error);
      this.requests.get(frame.requestToken)?.reject(error);
      const tokenMatch = this.subscriptions.get(frame.token);
      if (tokenMatch) tokenMatch.wait?.reject(error);
      if (frame.filter) for (const sub of this.subscriptions.values()) if (!sub.subscription && sub.filters.includes(frame.filter)) sub.wait?.reject(error);
      // Uncorrelated wire errors remain visible, never guessed as another receipt.
      return;
    }
    if (['registered', 'released', 'published', 'blob_result'].includes(frame.type)) {
      const wait = this.requests.get(frame.requestToken);
      if (wait) {
        const expected = wait.type.startsWith('blob_') ? 'blob_result' : wait.type === 'register' ? 'registered' : wait.type === 'release' ? 'released' : 'published';
        if (frame.type !== expected || (expected === 'blob_result' && frame.operation !== wait.type)) wait.reject(fail('RECEIPT_INVALID', 'Hub receipt operation does not match this pending command', frame));
        else wait.resolve(frame);
      }
      return;
    }
    if (frame.type === 'subscribed') { const sub = this.subscriptions.get(frame.token); if (sub) { sub.subscription = frame.subscription; sub.receipt = frame; } return; }
    if (frame.type === 'caught_up') {
      for (const sub of this.subscriptions.values()) if (sub.subscription === frame.subscription && sub.receipt) sub.wait?.resolve({ ...sub.receipt, barrier: frame });
      return;
    }
    if (frame.type === 'catchup_truncated' || frame.type === 'overflow') {
      for (const sub of this.subscriptions.values()) if (sub.subscription === frame.subscription) sub.wait?.reject(fail(frame.type.toUpperCase(), 'subscription catch-up is incomplete; choose an explicit recovery action', frame));
      return;
    }
    if (frame.type === 'unsubscribed') {
      for (const [token, sub] of this.subscriptions) if (sub.subscription === frame.subscription) { sub.wait?.reject(fail('UNSUBSCRIBED', 'user removed the subscription before the catch-up barrier')); this.subscriptions.delete(token); }
      this.unsubscribing.get(frame.subscription)?.resolve(frame);
    }
  }
  async uploadFile(file, onProgress, { signal } = {}) {
    this.requireFeature('blob-v1');
    if (this.fileBusy) throw fail('FILE_BUSY', 'finish or cancel this browser file operation first');
    if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size > Math.min(this.options.maxBlobBytes, this.welcome.blobLimits?.maxObjectBytes ?? 0)) throw fail('BLOB_LOCAL_LIMIT', 'file exceeds the negotiated or local in-memory file limit');
    this.fileBusy = true; const generation = this.generation;
    const check = () => { if (signal?.aborted) throw fail('ABORTED', 'file operation canceled; no object was automatically released'); if (generation !== this.generation || !this.connected) throw fail('DISCONNECTED', 'file operation connection was closed'); };
    const progress = (id, offset, stage) => safeCallback(onProgress, { id, offset, size: file.size, bytes: offset, total: file.size, stage });
    try {
      check(); progress(null, 0, 'hashing'); const sha256 = await digest(await file.arrayBuffer()); check();
      const object = await this.command('blob_begin', { size: file.size, sha256 }, { signal });
      if (object.size !== file.size || object.sha256 !== sha256 || object.offset !== 0) throw fail('BLOB_DESCRIPTOR_INVALID', 'Hub upload descriptor differs from the selected file');
      const chunkBytes = this.welcome.blobLimits?.chunkBytes;
      if (!positive(chunkBytes)) throw fail('BLOB_LIMIT_INVALID', 'Hub chunk limit is invalid');
      progress(object.id, 0, 'uploading');
      for (let offset = 0; offset < file.size;) {
        check(); const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer()); check();
        const receipt = await this.command('blob_chunk', { id: object.id, offset, data: bytesToBase64(bytes) }, { signal });
        offset += bytes.length;
        if (receipt.offset !== offset || receipt.id !== object.id || receipt.size !== file.size || receipt.sha256 !== sha256) throw fail('BLOB_OFFSET_INVALID', 'Hub confirmed an unexpected upload block');
        progress(object.id, offset, 'uploading');
      }
      const committed = await this.command('blob_commit', { id: object.id }, { signal, timeoutMs: Math.max(120_000, this.options.timeoutMs) }); check();
      if (!committed.committed || committed.size !== file.size || committed.sha256 !== sha256 || committed.id !== object.id) throw fail('BLOB_DESCRIPTOR_INVALID', 'Hub commit does not match the uploaded file');
      progress(object.id, file.size, 'complete'); return committed;
    } finally { this.fileBusy = false; }
  }
  async downloadBlob({ id, messageSeq, size, sha256 } = {}, onProgress, { signal } = {}) {
    this.requireFeature('blob-v1');
    if (this.fileBusy) throw fail('FILE_BUSY', 'finish or cancel this browser file operation first');
    if (typeof id !== 'string' || !Number.isSafeInteger(size) || size < 0 || size > this.options.maxBlobBytes || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || (messageSeq !== undefined && !positive(messageSeq))) throw fail('BLOB_DESCRIPTOR_INVALID', 'provide object ID, safe size, SHA-256, and an authorized message sequence when needed');
    const chunkBytes = this.welcome.blobLimits?.chunkBytes;
    if (!positive(chunkBytes)) throw fail('BLOB_LIMIT_INVALID', 'Hub chunk limit is invalid');
    this.fileBusy = true; const generation = this.generation;
    const check = () => { if (signal?.aborted) throw fail('ABORTED', 'file operation canceled; no object was automatically released'); if (generation !== this.generation || !this.connected) throw fail('DISCONNECTED', 'file operation connection was closed'); };
    const progress = (offset, stage) => safeCallback(onProgress, { id, offset, size, bytes: offset, total: size, stage });
    try {
      const bytes = new Uint8Array(size); let offset = 0; progress(0, 'downloading');
      for (;;) {
        check(); const frame = await this.command('blob_read', { id, messageSeq, offset, length: chunkBytes }, { signal }); check();
        if (frame.id !== id || frame.offset !== offset || frame.size !== size || frame.sha256 !== sha256) throw fail('BLOB_CONTENT_CHANGED', 'Hub download descriptor differs from the selected information');
        const block = base64ToBytes(frame.data);
        if (frame.bytes !== block.length || offset + block.length > size || (!block.length && !frame.eof) || frame.eof !== (offset + block.length === size)) throw fail('BLOB_CHUNK_INVALID', 'Hub returned an invalid object block');
        bytes.set(block, offset); offset += block.length; progress(offset, 'downloading');
        if (frame.eof) break;
      }
      progress(offset, 'hashing'); if (await digest(bytes) !== sha256) throw fail('BLOB_HASH_MISMATCH', 'downloaded bytes do not match SHA-256'); check();
      progress(offset, 'complete'); return new Blob([bytes]);
    } finally { this.fileBusy = false; }
  }
}
