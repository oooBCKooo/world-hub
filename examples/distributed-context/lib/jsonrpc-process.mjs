import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = id => id === null || typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
const validParams = params => params === undefined || (params !== null && typeof params === 'object');

export class JsonRpcTransportError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'JsonRpcTransportError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class JsonRpcRemoteError extends Error {
  constructor(error) {
    super(error.message);
    this.name = 'JsonRpcRemoteError';
    this.code = error.code;
    if (own(error, 'data')) this.data = error.data;
  }
}

/**
 * JSON-RPC 2.0 over UTF-8 newline-delimited stdio for one configured child.
 * This class knows no methods or program roles. The owner configures the child,
 * initialization, reverse-request policy, and graceful shutdown RPC.
 * Events: notification(frame), request(frame), stderr(Buffer),
 * transportError(Error), orphanResponse(frame), exit({ code, signal }), close.
 */
export class JsonRpcProcess extends EventEmitter {
  #options;
  #child;
  #state = 'new';
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #reverse = new Set();
  #closePromise;
  #resolveClose;
  #closeTimer;
  #failure;

  constructor(options = {}) {
    super();
    const {
      command, args = [], cwd, env, stderr,
      requestTimeoutMs = 30_000, closeTimeoutMs = 1_000,
      maxLineBytes = 4 * 1024 * 1024, maxBufferBytes = 8 * 1024 * 1024,
      maxPendingRequests = 256,
    } = options;
    if (typeof command !== 'string' || !command) throw new TypeError('command must be a nonempty string');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new TypeError('args must be strings');
    if (cwd !== undefined && typeof cwd !== 'string') throw new TypeError('cwd must be a string');
    if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) throw new TypeError('env must be an object');
    if (stderr !== undefined && typeof stderr?.write !== 'function') throw new TypeError('stderr must be a writable stream');
    for (const [key, value] of Object.entries({ requestTimeoutMs, closeTimeoutMs, maxLineBytes, maxBufferBytes, maxPendingRequests })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive safe integer`);
    }
    if (maxBufferBytes < maxLineBytes) throw new TypeError('maxBufferBytes must cover maxLineBytes');
    this.#options = { command, args: [...args], cwd, env: env === undefined ? undefined : { ...env }, stderr, requestTimeoutMs, closeTimeoutMs, maxLineBytes, maxBufferBytes, maxPendingRequests };
    this.#closePromise = new Promise(resolve => { this.#resolveClose = resolve; });
  }

  get state() { return this.#state; }
  get pid() { return this.#child?.pid; }
  get pendingRequests() { return this.#pending.size; }

  async start() {
    if (this.#state !== 'new') throw new JsonRpcTransportError('Process has already been started or closed', 'RPC_STATE');
    this.#state = 'starting';
    const { command, args, cwd, env, stderr } = this.#options;
    try {
      this.#child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.#fail(new JsonRpcTransportError(error.message, 'RPC_SPAWN'));
      this.#finish();
      throw this.#failure;
    }
    const child = this.#child;
    child.stdout.on('data', chunk => this.#read(chunk));
    child.stdout.on('end', () => {
      if (this.#state === 'running') this.#fail(new JsonRpcTransportError(this.#buffer.length ? 'Child stdout ended with an incomplete JSON-RPC frame' : 'Child stdout ended', 'RPC_EOF'));
    });
    child.stdout.on('error', error => this.#fail(new JsonRpcTransportError(error.message, 'RPC_STDOUT')));
    child.stdin.on('error', error => this.#fail(new JsonRpcTransportError(error.message, 'RPC_STDIN')));
    child.stdin.on('close', () => {
      if (this.#state === 'running') this.#fail(new JsonRpcTransportError('Child stdin closed', 'RPC_EOF'));
    });
    child.stderr.on('data', chunk => {
      // Do not accumulate diagnostics, print configuration, or dump environment.
      this.emit('stderr', chunk);
      if (stderr) stderr.write(chunk);
    });
    child.on('error', error => this.#fail(new JsonRpcTransportError(error.message, 'RPC_SPAWN')));
    child.on('exit', (code, signal) => {
      if (!this.#failure && this.#state !== 'closing') this.#rejectAll(new JsonRpcTransportError(`Child exited (${signal ?? code})`, 'RPC_EXIT', { code, signal }));
      this.emit('exit', { code, signal });
    });
    child.on('close', () => this.#finish());
    return new Promise((resolve, reject) => {
      child.once('spawn', () => {
        if (this.#state !== 'starting') return reject(this.#failure ?? new JsonRpcTransportError('Process closed during startup', 'RPC_CLOSED'));
        this.#state = 'running';
        resolve(this);
      });
      child.once('error', () => reject(this.#failure ?? new JsonRpcTransportError('Process could not start', 'RPC_SPAWN')));
    });
  }

  request(method, params, { timeoutMs = this.#options.requestTimeoutMs } = {}) {
    try {
      this.#assertRunning();
      this.#checkMethod(method, params);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive safe integer');
      if (this.#pending.size >= this.#options.maxPendingRequests) throw new JsonRpcTransportError('Pending request limit reached', 'RPC_PENDING_LIMIT');
      if (!Number.isSafeInteger(this.#nextId)) throw new JsonRpcTransportError('Request ID range exhausted', 'RPC_ID_LIMIT');
      const id = this.#nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new JsonRpcTransportError(`JSON-RPC request timed out: ${method}`, 'RPC_TIMEOUT'));
        }, timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        try { this.#write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); }
        catch (error) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(error);
        }
      });
    } catch (error) { return Promise.reject(error); }
  }

  notify(method, params) {
    this.#assertRunning();
    this.#checkMethod(method, params);
    this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  respond(id, result = null) {
    this.#respond(id, { result });
  }

  respondError(id, error) {
    if (!this.#validError(error)) throw new TypeError('error must contain integer code and string message');
    this.#respond(id, { error });
  }

  #respond(id, response) {
    this.#assertRunning();
    if (!this.#reverse.has(id)) throw new JsonRpcTransportError('No pending reverse request with that ID', 'RPC_UNKNOWN_REQUEST');
    this.#write({ jsonrpc: '2.0', id, ...response });
    this.#reverse.delete(id);
  }

  async close() {
    if (this.#state === 'closed') return this.#closePromise;
    if (this.#state === 'new') { this.#finish(); return this.#closePromise; }
    this.#beginClose(new JsonRpcTransportError('Process transport closed', 'RPC_CLOSED'));
    return this.#closePromise;
  }

  #assertRunning() {
    if (this.#state !== 'running') throw this.#failure ?? new JsonRpcTransportError('Process transport is not running', 'RPC_CLOSED');
  }

  #checkMethod(method, params) {
    if (typeof method !== 'string' || !method) throw new TypeError('method must be a nonempty string');
    if (!validParams(params)) throw new TypeError('params must be an object or array');
  }

  #write(frame) {
    let wire;
    try { wire = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8'); }
    catch { throw new JsonRpcTransportError('JSON-RPC frame is not serializable', 'RPC_FRAME'); }
    if (wire.length - 1 > this.#options.maxLineBytes) throw new JsonRpcTransportError('Outgoing JSON-RPC line exceeds limit', 'RPC_LINE_LIMIT');
    if (this.#child.stdin.writableLength + wire.length > this.#options.maxBufferBytes) throw new JsonRpcTransportError('Outgoing JSON-RPC buffer exceeds limit', 'RPC_BUFFER_LIMIT');
    this.#child.stdin.write(wire, error => { if (error) this.#fail(new JsonRpcTransportError(error.message, 'RPC_STDIN')); });
  }

  #read(chunk) {
    if (this.#state !== 'running' && this.#state !== 'starting') return;
    if (this.#buffer.length + chunk.length > this.#options.maxBufferBytes) return this.#fail(new JsonRpcTransportError('Incoming JSON-RPC buffer exceeds limit', 'RPC_BUFFER_LIMIT'));
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    let end;
    while ((end = this.#buffer.indexOf(10)) !== -1) {
      const line = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      if (line.length > this.#options.maxLineBytes) return this.#fail(new JsonRpcTransportError('Incoming JSON-RPC line exceeds limit', 'RPC_LINE_LIMIT'));
      let frame;
      try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { return this.#fail(new JsonRpcTransportError('Child emitted malformed UTF-8 JSON', 'RPC_FRAME')); }
      try { this.#frame(frame); }
      catch (error) { this.#fail(error instanceof JsonRpcTransportError ? error : new JsonRpcTransportError(error.message, 'RPC_FRAME')); }
      if (this.#state === 'closing' || this.#state === 'closed') return;
    }
    if (this.#buffer.length > this.#options.maxLineBytes) this.#fail(new JsonRpcTransportError('Incoming JSON-RPC line exceeds limit', 'RPC_LINE_LIMIT'));
  }

  #validError(error) {
    return error !== null && typeof error === 'object' && !Array.isArray(error) && Number.isInteger(error.code) && typeof error.message === 'string';
  }

  #frame(frame) {
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame) || frame.jsonrpc !== '2.0') throw new JsonRpcTransportError('Invalid JSON-RPC envelope', 'RPC_FRAME');
    if (own(frame, 'method')) {
      this.#checkMethod(frame.method, frame.params);
      if (own(frame, 'result') || own(frame, 'error')) throw new JsonRpcTransportError('Request cannot contain a response', 'RPC_FRAME');
      if (!own(frame, 'id')) return this.emit('notification', frame);
      if (!validId(frame.id) || this.#reverse.has(frame.id)) throw new JsonRpcTransportError('Invalid or duplicate reverse request ID', 'RPC_FRAME');
      if (this.#reverse.size >= this.#options.maxPendingRequests) throw new JsonRpcTransportError('Reverse request limit reached', 'RPC_PENDING_LIMIT');
      this.#reverse.add(frame.id);
      this.emit('request', frame);
      return;
    }
    if (!own(frame, 'id') || !validId(frame.id) || own(frame, 'result') === own(frame, 'error') || (own(frame, 'error') && !this.#validError(frame.error))) throw new JsonRpcTransportError('Invalid JSON-RPC response', 'RPC_FRAME');
    const pending = this.#pending.get(frame.id);
    if (!pending) return this.emit('orphanResponse', frame);
    clearTimeout(pending.timer);
    this.#pending.delete(frame.id);
    if (own(frame, 'error')) pending.reject(new JsonRpcRemoteError(frame.error));
    else pending.resolve(frame.result);
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.#reverse.clear();
  }

  #fail(error) {
    if (this.#state === 'closed' || this.#failure) return;
    this.#failure = error;
    this.emit('transportError', error);
    this.#beginClose(error);
  }

  #beginClose(error) {
    if (this.#state === 'closing' || this.#state === 'closed') return;
    this.#state = 'closing';
    this.#buffer = Buffer.alloc(0);
    this.#rejectAll(error);
    if (!this.#child) return this.#finish();
    // On Windows a half-open pipe may retain the handle after writable finish.
    // Flush queued bytes, then close this parent's side so the child sees EOF.
    this.#child.stdin.end(() => this.#child.stdin.destroy());
    this.#closeTimer = setTimeout(() => {
      // Only this instance's own child is targeted. No process discovery or tree kill.
      if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
    }, this.#options.closeTimeoutMs);
  }

  #finish() {
    if (this.#state === 'closed') return;
    clearTimeout(this.#closeTimer);
    this.#rejectAll(this.#failure ?? new JsonRpcTransportError('Process transport closed', 'RPC_CLOSED'));
    this.#buffer = Buffer.alloc(0);
    this.#state = 'closed';
    this.#resolveClose();
    this.emit('close');
  }
}

export default JsonRpcProcess;
