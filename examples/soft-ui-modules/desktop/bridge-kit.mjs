// External adapter: applications decide when consumption is complete.
// With autoAck:false call ack(message) explicitly. Otherwise all delivery
// listeners must finish successfully; no listener means no automatic ACK.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { uploadFile, uploadStream, downloadFile, readAttachment } from './blob-client.mjs';
export const WIRE_VERSION = '0.1';
function encodedInstanceId(instanceId) {
  let encoded;
  if (typeof instanceId === 'string') try { encoded = encodeURIComponent(instanceId).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); } catch { /* Invalid Unicode cannot name a stable path. */ }
  if (!encoded || encoded.length > 64) throw new Error('instanceId must be a nonempty stable string encoding to at most 64 filename characters');
  return encoded;
}

export class Bridge {
  #opts; #ws = null; #closed = false; #welcome = null; #hadWelcome = false;
  #reconnectMs; #reconnectTimer = null; #cursorFile; #cursors = {}; #cursorLoadError = null;
  #handlers = Object.fromEntries(['open', 'delivery', 'published', 'registered', 'released', 'subscribed', 'subscriptionReused', 'unsubscribed', 'caughtUp', 'overflow', 'denied', 'error', 'close'].map((name) => [name, []]));
  #readyWaiters = []; #subs = new Map(); #unsubscribeWaiters = new Map();
  #requests = new Map(); #channels = new Map(); #ackBatch = new Map(); #nextToken = 1;
  #deliverySessions = new WeakMap(); #calls = new Map(); #callSlots = 0;

  constructor(opts) {
    if (opts.instanceId !== undefined) encodedInstanceId(opts.instanceId);
    this.#opts = opts;
    this.#reconnectMs = opts.reconnectMs ?? 400;
    this.#cursorFile = opts.cursorFile ?? null;
    if (this.#cursorFile) this.#loadCursors();
  }
  get welcome() { return this.#welcome; }
  get connected() { return this.#welcome !== null && this.#ws?.readyState === 1; }
  get bridgeId() { return this.#opts.bridgeId; }
  get subscriptions() { return [...this.#subs.values()].map((s) => ({ token: s.token, id: s.subscriptionId, filters: [...s.filters], cursor: s.cursor,
    ...(s.operations ? { operations: [...s.operations] } : {}) })); }
  get channels() { return [...this.#channels.values()].map((c) => ({ ...c })); }
  on(event, fn) {
    if (!this.#handlers[event]) throw new Error(`unknown bridge event: ${event}`);
    this.#handlers[event].push(fn);
    return this;
  }
  #reportHandlerError(event, err) {
    const info = { code: 'EVENT_HANDLER_FAILED', event, message: String(err?.message ?? err) };
    // This diagnostic observer cannot replace the original event failure or
    // reject a successful handshake. Handle returned promises as well.
    try { Promise.resolve(this.#opts.onEvent?.({ kind: 'handler_error', ...info })).catch(() => {}); }
    catch { /* Diagnostic observer failure is isolated from communication. */ }
    if (event !== 'error') this.#emit('error', info);
  }
  #emit(event, payload) {
    for (const fn of this.#handlers[event] ?? []) {
      try { Promise.resolve(fn(payload)).catch((err) => this.#reportHandlerError(event, err)); }
      catch (err) { this.#reportHandlerError(event, err); }
    }
  }
  async connect() {
    if (this.#closed) throw new Error('bridge is closed');
    if (this.connected) return this.#welcome;
    if (this.#cursorLoadError) { this.#emit('error', this.#cursorLoadError); this.#cursorLoadError = null; }
    const ready = new Promise((resolve, reject) => this.#readyWaiters.push({ resolve, reject }));
    if (!this.#ws) this.#open();
    return ready;
  }
  #open() {
    let ws;
    try { ws = new WebSocket(this.#opts.url); }
    catch (err) { this.#emit('error', { code: 'SOCKET_ERROR', message: err.message }); this.#scheduleReconnect(); return; }
    this.#ws = ws;
    ws.addEventListener('open', () => {
      if (this.#ws !== ws) return;
      ws.send(JSON.stringify({ type: 'hello', wire: WIRE_VERSION, bridge: this.#opts.bridgeId,
        credential: this.#opts.credential, token: this.#opts.token, role: this.#opts.role ?? 'both', displayName: this.#opts.displayName }));
    });
    ws.addEventListener('message', (e) => {
      if (this.#ws !== ws) return;
      let frame;
      try { frame = JSON.parse(e.data); }
      catch { this.#emit('error', { code: 'FRAME_NOT_JSON' }); return; }
      if (!frame || typeof frame !== 'object') { this.#emit('error', { code: 'FRAME_INVALID' }); return; }
      this.#onFrame(frame);
    });
    ws.addEventListener('error', () => {
      if (this.#ws !== ws) return;
      this.#emit('error', { code: 'SOCKET_ERROR' });
      // Node's failed opening handshake may emit error without a close event.
      // Retire that socket here so another reconnect is not blocked by #ws.
      this.#disconnect(ws, { code: 1006, reason: 'socket error' });
    });
    ws.addEventListener('close', (e) => this.#disconnect(ws, { code: e.code, reason: e.reason }));
  }
  #disconnect(ws, info) {
    if (this.#ws !== ws) return;
    const wasConnected = this.#welcome !== null;
    this.#ws = null; this.#welcome = null; this.#ackBatch.clear();
    for (const sub of this.#subs.values()) {
      sub.subscriptionId = undefined; sub.sent = false; sub.pending.clear(); sub.tail = Promise.resolve(); sub.failed = false;
    }
    this.#rejectRequests(new Error('connection closed before receipt'));
    this.#rejectCalls(new Error('connection closed before response'));
    for (const wait of this.#unsubscribeWaiters.values()) { clearTimeout(wait.timer); wait.reject(new Error('connection closed')); }
    this.#unsubscribeWaiters.clear();
    if (wasConnected) this.#emit('close', info);
    if (!this.#closed) this.#scheduleReconnect();
  }
  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = this.#reconnectMs;
    this.#reconnectMs = Math.min(Math.round(this.#reconnectMs * 1.8), 5000);
    this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = null; if (!this.#closed && !this.#ws) this.#open(); }, delay);
    this.#reconnectTimer.unref?.();
  }
  async #finishWelcome(frame, reconnect, ws) {
    // Registrations are opaque communication declarations chosen by the mod.
    // Restore them before subscriptions. No application category is built in.
    if (reconnect && this.#channels.size) await this.#request('register', { channels: this.channels });
    if (this.#ws !== ws) return;
    for (const sub of this.#subs.values()) this.#sendSubscribe(sub);
    this.#emit('open', { hub: frame.hub, lastSeq: frame.lastSeq, authenticated: frame.authenticated,
      wireHash: frame.wireHash, limits: frame.limits, reconnect,
      principal: frame.principal, session: frame.session, features: frame.features, blobLimits: frame.blobLimits });
    for (const w of this.#readyWaiters.splice(0)) w.resolve(frame);
  }
  #onFrame(frame) {
    switch (frame.type) {
      case 'welcome': {
        const reconnect = this.#hadWelcome;
        this.#hadWelcome = true; this.#welcome = frame; this.#reconnectMs = this.#opts.reconnectMs ?? 400;
        this.#finishWelcome(frame, reconnect, this.#ws).catch((err) => {
          this.#emit('error', { code: 'RESTORE_FAILED', message: err.message });
          for (const w of this.#readyWaiters.splice(0)) w.reject(err);
        });
        return;
      }
      case 'registered':
      case 'released':
      case 'published':
      case 'blob_result': {
        const wait = this.#requests.get(frame.requestToken);
        if (wait) { clearTimeout(wait.timer); this.#requests.delete(frame.requestToken); wait.resolve(frame); }
        this.#emit(frame.type, frame);
        return;
      }
      case 'denied':
      case 'error': {
        const err = new Error(`${frame.code}: ${frame.message ?? ''}`);
        err.code = frame.code; err.frame = frame;
        const wait = this.#requests.get(frame.requestToken);
        if (wait) { clearTimeout(wait.timer); this.#requests.delete(frame.requestToken); wait.reject(err); }
        if (!this.#welcome && frame.type === 'denied') for (const w of this.#readyWaiters.splice(0)) w.reject(err);
        if (frame.filter) for (const sub of this.#subs.values()) if (!sub.subscriptionId && sub.filters.includes(frame.filter)) {
          // This explicit rejection proves that no Hub subscription was made.
          // A call can dispose it immediately instead of waiting for a reply
          // which will never arrive. Timeout without a reply remains distinct.
          sub.sent = false; this.#rejectSub(sub, err);
        }
        this.#emit(frame.type, frame);
        return;
      }
      case 'subscribed': {
        const sub = this.#subs.get(frame.token);
        if (!sub) return;
        sub.subscriptionId = frame.subscription; sub.cursor = frame.cursor; sub.initialized = true;
        clearTimeout(sub.timer);
        sub.resolve?.({ subscription: frame.subscription, filters: frame.filters, cursor: frame.cursor, catchUpTo: frame.catchUpTo });
        sub.resolve = null; sub.reject = null; sub.promise = null;
        this.#emit('subscribed', frame);
        return;
      }
      case 'unsubscribed': {
        const wait = this.#unsubscribeWaiters.get(frame.subscription);
        if (wait) { clearTimeout(wait.timer); this.#unsubscribeWaiters.delete(frame.subscription); wait.resolve(frame); }
        this.#emit('unsubscribed', frame);
        return;
      }
      case 'delivery': {
        const sub = this.#subByHubId(frame.subscription);
        if (!sub || sub.pending.has(frame.seq)) return;
        sub.pending.set(frame.seq, { acknowledged: false, frame });
        const ws = this.#ws;
        this.#deliverySessions.set(frame, { ws, sub });
        sub.tail = sub.tail.then(async () => {
          if (sub.failed || this.#ws !== ws || sub.subscriptionId !== frame.subscription) return;
          // Calls use their own subscription. They do not change the program's
          // subscriptions or consume request/inject traffic on its behalf.
          let called = false;
          if (sub.callId) {
            const call = this.#calls.get(sub.callId);
            if (!call || frame.operation !== 'response') return;
            const receipt = await call.receiptReady;
            if (!receipt || call.completed || frame.requestSeq !== receipt.seq || frame.fromPrincipal !== call.target.principal) return;
            call.completed = true; call.response = frame; clearTimeout(call.timer);
            call.resolve({ request: receipt, response: frame }); called = true;
          }
          const consumers = [...this.#handlers.delivery];
          if (!consumers.length && !called) return;
          try {
            for (const fn of consumers) await fn(frame);
            if (this.#opts.autoAck !== false && this.#ws === ws && sub.subscriptionId === frame.subscription && sub.pending.has(frame.seq)) {
              if (!this.ack(frame)) sub.failed = true;
            }
          } catch (err) {
            const stale = this.#ws !== ws || sub.subscriptionId !== frame.subscription;
            if (!stale) sub.failed = true;
            this.#emit('error', { code: 'DELIVERY_HANDLER_FAILED', subscription: frame.subscription, seq: frame.seq, stale, message: String(err?.message ?? err) });
          }
        });
        return;
      }
      case 'caught_up': this.#emit('caughtUp', frame); return; // Sending caught up, not application completion.
      case 'overflow': this.#emit('overflow', frame); return;
      case 'catchup_truncated': this.#emit('error', { ...frame, code: 'CATCHUP_TRUNCATED' }); return;
      default: this.#emit('error', { code: 'FRAME_UNKNOWN', frame });
    }
  }
  #subByHubId(id) { return [...this.#subs.values()].find((s) => s.subscriptionId === id) ?? null; }
  #cursorKey(filters, operations) {
    if (this.#opts.instanceId !== undefined) return JSON.stringify([this.#opts.bridgeId, this.#opts.instanceId, filters, operations ?? null]);
    return `${this.#opts.bridgeId}|${filters.join(',')}${operations ? `|operations:${operations.join(',')}` : ''}`;
  }
  #startCursor(sub) {
    if (typeof sub.from === 'number') return sub.from;
    if (sub.from === 'now') return this.#welcome?.lastSeq ?? 0;
    if (sub.from === 'resume') return this.#cursors[sub.key] ?? 0;
    return this.#cursors[sub.key] ?? this.#welcome?.lastSeq ?? 0;
  }
  #subPromise(sub) {
    if (sub.promise) return sub.promise;
    sub.promise = new Promise((resolve, reject) => {
      sub.resolve = resolve; sub.reject = reject;
      sub.timer = setTimeout(() => this.#rejectSub(sub, new Error(`subscribe timeout for ${sub.filters.join(',')}`)), this.#opts.subscribeTimeoutMs ?? 8000);
      sub.timer.unref?.();
    });
    sub.promise.catch(() => {}); // Restoration has no caller; errors also reach the error event.
    return sub.promise;
  }
  #rejectSub(sub, err) {
    clearTimeout(sub.timer); sub.reject?.(err); sub.resolve = null; sub.reject = null; sub.promise = null;
    this.#emit('error', { code: 'SUBSCRIBE_FAILED', filters: sub.filters, message: err.message });
  }
  /** from is an initial policy: number = after seq, now = future, resume = saved
   * committed cursor or 0, omitted = saved cursor or now. Repeated same policy
   * reuses the subscription even as its cursor advances. A different explicit
   * policy first unsubscribes. Reconnection resumes the committed cursor.
   */
  subscribe(filters, opts = {}) {
    let options;
    try { options = this.#subscriptionOptions(filters, opts); } catch (error) { return Promise.reject(error); }
    const { normalized, operations, from, key } = options;
    const existing = [...this.#subs.values()].find((s) => s.key === key);
    if (existing) {
      if (from !== undefined && existing.from !== from) {
        if (!existing.replacement) existing.replacement = this.unsubscribe(existing.subscriptionId ?? existing.token).then(() => this.subscribe(normalized, opts));
        return existing.replacement;
      }
      if (existing.subscriptionId) {
        const receipt = { subscription: existing.subscriptionId, filters: [...existing.filters], cursor: existing.cursor, deduped: true };
        const event = { ...receipt, from: existing.from ?? 'saved-or-now', ...(operations ? { operations: [...operations] } : {}) };
        this.#emit('subscriptionReused', event);
        try { Promise.resolve(this.#opts.onEvent?.({ kind: 'subscription_reused', ...event })).catch((error) => this.#emit('error', { code: 'EVENT_HANDLER_FAILED', event: 'subscriptionReused', message: String(error?.message ?? error) })); }
        catch (error) { this.#emit('error', { code: 'EVENT_HANDLER_FAILED', event: 'subscriptionReused', message: String(error?.message ?? error) }); }
        return Promise.resolve(receipt);
      }
      this.#sendSubscribe(existing);
      return this.#subPromise(existing);
    }
    const sub = { token: `b${this.#nextToken++}`, key, filters: normalized, operations, from, cursor: 0,
      initialized: false, sent: false, subscriptionId: undefined, pending: new Map(), tail: Promise.resolve(), failed: false };
    this.#subs.set(sub.token, sub);
    const promise = this.#subPromise(sub); this.#sendSubscribe(sub); return promise;
  }
  #subscriptionOptions(filters, opts) {
    if (this.#closed) throw new Error('bridge is closed');
    if (!Array.isArray(filters) || !filters.length || filters.some((f) => typeof f !== 'string')) throw new Error('filters must be nonempty strings');
    const normalized = [...new Set(filters)].sort();
    const operations = opts.operations === undefined ? undefined : Array.isArray(opts.operations) ? [...new Set(opts.operations)].sort() : null;
    if (operations === null || (operations && (!operations.length || operations.some((op) => !['publish', 'request', 'inject', 'response'].includes(op))))) throw new Error('operations must be a nonempty list of protocol operations');
    if (operations) {
      const unsupported = this.#featureError('directed-v1');
      if (unsupported) throw unsupported;
    }
    const from = opts.from;
    if (from !== undefined && from !== 'now' && from !== 'resume' && !(Number.isSafeInteger(from) && from >= 0)) throw new Error('from must be now, resume, or a nonnegative safe integer');
    return { normalized, operations, from, key: this.#cursorKey(normalized, operations) };
  }
  /** Explicitly replaces this filter+operation subscription and reads retained
   * records after from (default 0), then stays live. Other overlapping
   * subscriptions are unchanged and may deliver the same record again.
   * Reconnection resumes this subscription's committed cursor, not from again.
   */
  async replay(filters, opts = {}) {
    const from = opts.from === undefined ? 0 : opts.from;
    if (!Number.isSafeInteger(from) || from < 0) throw new Error('replay from must be a nonnegative safe integer');
    const { normalized, key } = this.#subscriptionOptions(filters, { ...opts, from });
    const existing = [...this.#subs.values()].find((sub) => sub.key === key);
    if (existing) await this.unsubscribe(existing.subscriptionId ?? existing.token);
    return this.subscribe(normalized, { ...opts, from });
  }
  #sendSubscribe(sub) {
    if (sub.sent || !this.connected) return;
    if (!sub.initialized) sub.cursor = this.#startCursor(sub);
    this.#subPromise(sub);
    sub.sent = this.#send({ type: 'subscribe', token: sub.token, filters: sub.filters, from: sub.cursor,
      ...(sub.operations ? { operations: sub.operations } : {}) });
  }
  /** Explicit completion, limited to deliveries received on this subscription.
   * Out-of-order ACKs cannot advance the committed cursor over unfinished work.
   */
  ack(messageOrSubscription, seq) {
    const id = typeof messageOrSubscription === 'object' ? messageOrSubscription?.subscription : messageOrSubscription;
    const number = typeof messageOrSubscription === 'object' ? messageOrSubscription?.seq : seq;
    const sub = this.#subByHubId(id); const pending = sub?.pending.get(number);
    if (!pending || !this.connected) return false;
    if (typeof messageOrSubscription === 'object') {
      const session = this.#deliverySessions.get(messageOrSubscription);
      if (!session || session.ws !== this.#ws || session.sub !== sub || pending.frame !== messageOrSubscription) return false;
    }
    pending.acknowledged = true;
    let next = sub.cursor; const completed = [];
    for (const [n, rec] of sub.pending) { if (!rec.acknowledged) break; next = n; completed.push(n); }
    if (next !== sub.cursor && !sub.callId && !this.#persistCursor(sub.key, next)) { pending.acknowledged = false; return false; }
    sub.cursor = next;
    for (const n of completed) sub.pending.delete(n);
    if (!this.#ackBatch.has(id)) this.#ackBatch.set(id, new Set());
    this.#ackBatch.get(id).add(number); this.flushAcks();
    const call = sub.callId ? this.#calls.get(sub.callId) : null;
    if (call?.completed && call.response?.seq === number) this.#disposeCall(call);
    return true;
  }
  flushAcks() {
    if (!this.connected) return false;
    for (const [id, seqs] of this.#ackBatch) if (seqs.size && this.#send({ type: 'ack', subscription: id, seq: [...seqs] })) this.#ackBatch.delete(id);
    return this.#ackBatch.size === 0;
  }
  #persistCursor(key, cursor) {
    const next = { ...this.#cursors, [key]: cursor };
    if (!this.#cursorFile) { this.#cursors = next; return true; }
    const temp = `${this.#cursorFile}.${process.pid}.${randomUUID()}.tmp`; let fd;
    try {
      mkdirSync(dirname(this.#cursorFile), { recursive: true }); fd = openSync(temp, 'wx');
      writeFileSync(fd, JSON.stringify(next, null, 2), 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.#cursorFile); this.#cursors = next; return true;
    } catch (err) { this.#emit('error', { code: 'CURSOR_SAVE_FAILED', message: err.message, cursorFile: this.#cursorFile }); return false; }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') this.#emit('error', { code: 'CURSOR_TEMP_CLEANUP_FAILED', message: err.message }); }
    }
  }
  #loadCursors() {
    try {
      const raw = JSON.parse(readFileSync(this.#cursorFile, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw).some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('invalid cursor file');
      this.#cursors = raw;
    } catch (err) {
      this.#cursors = {};
      if (err.code !== 'ENOENT') this.#cursorLoadError = { code: 'CURSOR_LOAD_FAILED', message: err.message, cursorFile: this.#cursorFile };
    }
  }
  cursorOf(filters, opts = {}) { return this.#cursors[this.#cursorKey([...new Set(filters)].sort(), opts.operations ? [...new Set(opts.operations)].sort() : undefined)] ?? null; }
  /** Local send only. JS values use JSON.stringify; true is not acceptance or business success. */
  publish(topic, body, opts = {}) {
    if (opts.attachments !== undefined && !this.#welcome?.features?.includes('blob-v1')) return false;
    return this.#send({ type: 'publish', topic, body, ...this.#messageOptions(opts, true) });
  }
  /** Waits for hub acceptance, not recipient business success. */
  publishConfirmed(topic, body, opts = {}) {
    if (opts.attachments !== undefined) {
      const unsupported = this.#featureError('blob-v1');
      if (unsupported) return Promise.reject(unsupported);
    }
    return this.#request('publish', { topic, body, ...this.#messageOptions(opts) }, opts.timeoutMs);
  }
  #messageOptions(opts, withToken = false) {
    return Object.fromEntries(['id', 'correlation', 'replyTo', 'headers', 'attachments', ...(withToken ? ['requestToken'] : [])]
      .filter((key) => opts[key] !== undefined).map((key) => [key, opts[key]]));
  }
  #featureError(feature) {
    if (!this.connected) return new Error('bridge is not connected');
    if (!this.#welcome.features?.includes(feature)) {
      const err = new Error(`hub does not support ${feature}`); err.code = 'FEATURE_UNSUPPORTED'; return err;
    }
    return null;
  }
  #directedRequest(type, fields, opts) {
    const unsupported = this.#featureError('directed-v1') ?? (opts.attachments !== undefined ? this.#featureError('blob-v1') : null);
    return unsupported ? Promise.reject(unsupported) : this.#request(type, { ...fields, ...this.#messageOptions(opts) }, opts.timeoutMs);
  }
  /** Directed delivery acceptance, not execution or recipient completion. */
  sendTo(target, topic, body, opts = {}) { return this.#directedRequest('inject', { target, topic, body }, opts); }
  /** A durable request envelope. Receiving programs decide whether/how to reply. */
  requestTo(target, topic, body, opts = {}) { return this.#directedRequest('request', { target, topic, body }, opts); }
  /** Hub verifies the responder against the original retained request's target. */
  respond(requestOrSeq, body, opts = {}) {
    const requestSeq = typeof requestOrSeq === 'object' ? requestOrSeq?.seq : requestOrSeq;
    return this.#directedRequest('respond', { requestSeq, body }, opts);
  }
  /** Local first-response policy. Timeout never cancels or releases Hub data.
   * Returns { request: acceptance receipt, response: authenticated delivery }.
   * autoAck:false keeps its subscription until ack(response), close, or removal.
   */
  async call(target, topic, body, opts = {}) {
    const unsupported = this.#featureError('directed-v1') ?? (opts.attachments !== undefined ? this.#featureError('blob-v1') : null);
    if (unsupported) throw unsupported;
    if (!target || typeof target !== 'object' || Array.isArray(target) || typeof target.principal !== 'string') throw new Error('target.principal must be a string');
    if (typeof topic !== 'string' || !topic.length) throw new Error('call topic must be a nonempty string');
    const limit = this.#opts.maxPendingCalls ?? 32;
    if (this.#callSlots >= limit) { const err = new Error('too many pending or unacknowledged calls'); err.code = 'CALL_LIMIT'; throw err; }
    const timeoutMs = opts.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('call timeoutMs must be a positive safe integer');
    const call = { id: `c-${randomUUID()}`, target: { ...target }, completed: false, response: null, sub: null };
    call.receiptReady = new Promise((resolve) => { call.receiptResolve = resolve; });
    const result = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
    result.catch(() => {}); // Subscription/receipt can fail before the caller waits.
    call.timer = setTimeout(() => this.#failCall(call, new Error('call response timeout')), timeoutMs);
    call.timer.unref?.(); this.#calls.set(call.id, call); this.#callSlots++;
    const prepare = async () => {
      const sub = { token: `b${this.#nextToken++}`, key: `${this.#opts.bridgeId}|call|${call.id}`,
        filters: [topic], operations: ['response'], from: 'now', cursor: 0, initialized: false, sent: false, subscriptionId: undefined,
        pending: new Map(), tail: Promise.resolve(), failed: false, callId: call.id };
      call.sub = sub; this.#subs.set(sub.token, sub);
      const subscribed = this.#subPromise(sub); this.#sendSubscribe(sub);
      try { await subscribed; } catch (error) {
        if (error.code !== 'SUBSCRIBE_DENIED') throw error;
        const explained = new Error(`call needs subscribe permission for the called topic ${JSON.stringify(topic)} to receive its response from principal ${JSON.stringify(call.target.principal)}; ${error.message}`, { cause: error });
        explained.code = error.code; explained.frame = error.frame; explained.topic = topic; explained.targetPrincipal = call.target.principal;
        throw explained;
      }
      if (!this.#calls.has(call.id)) return;
      const receipt = await this.requestTo(call.target, topic, body, { ...opts, timeoutMs: opts.receiptTimeoutMs ?? Math.min(timeoutMs, 8000) });
      call.receiptResolve(receipt);
    };
    prepare().catch((err) => this.#failCall(call, err));
    return await result;
  }
  #failCall(call, err) {
    if (!this.#calls.has(call.id)) return;
    clearTimeout(call.timer); call.receiptResolve(null);
    if (!call.completed) call.reject(err);
    this.#disposeCall(call);
  }
  #disposeCall(call) {
    if (!this.#calls.delete(call.id)) return;
    clearTimeout(call.timer); call.receiptResolve(null);
    if (call.sub) this.unsubscribe(call.sub.subscriptionId ?? call.sub.token)
      .catch((err) => this.#emit('error', { code: 'CALL_SUBSCRIPTION_CLEANUP_FAILED', message: err.message }))
      .finally(() => { this.#callSlots--; });
    else this.#callSlots--;
  }
  #rejectCalls(err) { for (const call of [...this.#calls.values()]) this.#failCall(call, err); }
  /** Restricted transport helper for the file/stream adapter. */
  communicationRequest(type, fields = {}, { timeoutMs } = {}) {
    if (!['blob_begin', 'blob_status', 'blob_chunk', 'blob_commit', 'blob_read', 'blob_release'].includes(type)) return Promise.reject(new Error('unsupported communication request'));
    const unsupported = this.#featureError('blob-v1');
    return unsupported ? Promise.reject(unsupported) : this.#request(type, fields, timeoutMs);
  }
  blobStatus(id, opts = {}) { return this.communicationRequest('blob_status', { id }, opts); }
  releaseBlob(id, opts = {}) { return this.communicationRequest('blob_release', { id }, opts); }
  uploadFile(path, opts = {}) { return uploadFile(this, path, opts); }
  uploadStream(source, opts = {}) { return uploadStream(this, source, opts); }
  downloadFile(messageSeq, id, path, opts = {}) { return downloadFile(this, messageSeq, id, path, opts); }
  readAttachment(messageSeq, id, opts = {}) { return readAttachment(this, messageSeq, id, opts); }
  async registerChannels(channels, opts = {}) {
    const frame = await this.#request('register', { channels }, opts.timeoutMs);
    for (const c of frame.channels) this.#channels.set(c.name, { ...c });
    return frame;
  }
  /** Provider permission for future capacity cleanup of its own messages.
   * This is independent of consumer ACKs and does not request immediate deletion.
   */
  release(seqs, opts = {}) { return this.#request('release', { seq: seqs }, opts.timeoutMs); }
  #request(type, fields, timeoutMs = 8000) {
    if (!this.connected) return Promise.reject(new Error('bridge is not connected'));
    const requestToken = `r-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#requests.delete(requestToken); reject(new Error(`${type} receipt timeout`)); }, timeoutMs);
      timer.unref?.(); this.#requests.set(requestToken, { resolve, reject, timer });
      if (!this.#send({ ...fields, type, requestToken })) { clearTimeout(timer); this.#requests.delete(requestToken); reject(new Error(`${type} could not be sent`)); }
    });
  }
  #rejectRequests(err) { for (const wait of this.#requests.values()) { clearTimeout(wait.timer); wait.reject(err); } this.#requests.clear(); }
  resume(subscription) { return this.#send({ type: 'resume', subscription }); }
  unsubscribe(idOrToken) {
    const sub = this.#subByHubId(idOrToken) ?? this.#subs.get(idOrToken);
    if (!sub) return Promise.resolve({ subscription: idOrToken, missing: true });
    const call = sub.callId ? this.#calls.get(sub.callId) : null;
    if (call) {
      // Explicit removal is an external program decision. Keep slot accounting
      // until this subscription's actual cleanup has completed.
      this.#calls.delete(call.id); clearTimeout(call.timer); call.receiptResolve(null);
      if (!call.completed) call.reject(new Error('call subscription removed'));
      return this.unsubscribe(idOrToken).finally(() => { this.#callSlots--; });
    }
    if (!sub.subscriptionId && sub.sent) {
      // The hub may already be creating this subscription. Keep the registration
      // until its reply supplies the actual ID, then remove that hub resource.
      if (!sub.removing) sub.removing = this.#subPromise(sub).then(() => this.unsubscribe(sub.subscriptionId ?? sub.token)).catch((err) => {
        sub.removing = null;
        throw err;
      });
      return sub.removing;
    }
    const id = sub.subscriptionId; this.#subs.delete(sub.token); sub.subscriptionId = undefined;
    clearTimeout(sub.timer); sub.reject?.(new Error('subscription removed')); this.#ackBatch.delete(id);
    if (!id || !this.connected) return Promise.resolve({ subscription: id, cursor: sub.cursor });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#unsubscribeWaiters.delete(id); reject(new Error('unsubscribe timeout')); }, this.#opts.subscribeTimeoutMs ?? 8000);
      timer.unref?.(); this.#unsubscribeWaiters.set(id, { resolve, reject, timer });
      if (!this.#send({ type: 'unsubscribe', subscription: id })) { clearTimeout(timer); this.#unsubscribeWaiters.delete(id); reject(new Error('unsubscribe could not be sent')); }
    });
  }
  #send(frame) {
    if (!this.connected) return false;
    try { this.#ws.send(JSON.stringify(frame)); return true; }
    catch (err) { this.#emit('error', { code: 'SEND_FAILED', message: err.message }); return false; }
  }
  /** Stops immediately. Unfinished work remains unacknowledged for replay. */
  async close(reason = 'bridge done') {
    this.#closed = true; clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; this.flushAcks();
    const ws = this.#ws; this.#ws = null; this.#welcome = null; const err = new Error('bridge closed');
    for (const w of this.#readyWaiters.splice(0)) w.reject(err);
    for (const sub of this.#subs.values()) { clearTimeout(sub.timer); sub.reject?.(err); sub.subscriptionId = undefined; }
    this.#rejectRequests(err); this.#rejectCalls(err);
    for (const wait of this.#unsubscribeWaiters.values()) { clearTimeout(wait.timer); wait.reject(err); }
    this.#unsubscribeWaiters.clear();
    if (ws && ws.readyState < 2) try { ws.close(1000, reason.slice(0, 100)); } catch (error) { this.#emit('error', { code: 'CLOSE_FAILED', message: error.message }); }
  }
}

export const WIRE_FRAMES = {
  bridgeToHub: ['hello', 'register', 'release', 'publish', 'request', 'inject', 'respond', 'blob_begin', 'blob_status', 'blob_chunk', 'blob_commit', 'blob_read', 'blob_release', 'subscribe', 'unsubscribe', 'ack', 'resume', 'bye'],
  hubToBridge: ['welcome', 'registered', 'released', 'denied', 'published', 'blob_result', 'subscribed', 'unsubscribed', 'delivery', 'caught_up', 'catchup_truncated', 'overflow', 'error'],
};
/** Each concurrent durable consumer needs its own stable path. Keep one-argument
 * filenames compatible; use the same instanceId here and in Bridge options.
 * Sharing one file is unsupported, even when consumers use different keys.
 */
export function defaultCursorPath(bridgeId, instanceId) {
  if (instanceId === undefined) return join(process.cwd(), '.hub', 'cursors', `${bridgeId}.json`);
  if (typeof bridgeId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(bridgeId)) throw new Error('instance cursor bridgeId must match [a-z0-9][a-z0-9._-]{0,63}');
  return join(process.cwd(), '.hub', 'cursors', 'instances', `b-${bridgeId}`, `i-${encodedInstanceId(instanceId)}.json`);
}
