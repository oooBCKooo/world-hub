import { createHash } from 'node:crypto';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { validateConfig } from './config.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const bytesOf = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const topicSchema = { type: 'string', minLength: 1, maxLength: 256 };
const seqSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const targetSchema = { type: 'object', properties: { principal: { type: 'string', minLength: 1, maxLength: 128 }, session: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['principal'], additionalProperties: false };
const optionsSchema = { type: 'object', properties: {
  id: { type: 'string', maxLength: 256 }, correlation: { type: 'string', maxLength: 256 }, replyTo: topicSchema,
  headers: { type: 'object', additionalProperties: { type: 'string' }, maxProperties: 32 },
  attachments: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' } },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
}, additionalProperties: false };
const input = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const messageInput = input({ topic: topicSchema, body: {}, options: optionsSchema }, ['topic', 'body']);
const directedInput = input({ target: targetSchema, topic: topicSchema, body: {}, options: optionsSchema }, ['target', 'topic', 'body']);

export const TOOL_DEFINITIONS = Object.freeze([
  ['hub_identity', 'Read the connected Hub identity, negotiated limits and local subscription state. No credentials are returned.', input(), true],
  ['hub_register_channels', 'Declare exact communication channels and directions. This does not grant Hub ACL permissions or install business handlers.', input({ channels: { type: 'array', minItems: 1, maxItems: 128, items: input({ name: topicSchema, publish: { type: 'boolean' }, subscribe: { type: 'boolean' } }, ['name']) } }, ['channels'])],
  ['hub_publish', 'Publish opaque JSON information. A receipt proves Hub acceptance, not recipient processing or business success. No automatic retry.', messageInput],
  ['hub_subscribe', 'Create a retained/live exact-topic subscription. from is a sequence after which to read, now, or resume. Consumption is never automatically acknowledged.', input({ topics: { type: 'array', minItems: 1, maxItems: 16, items: topicSchema }, from: { anyOf: [{ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { enum: ['now', 'resume'] }] }, operations: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['publish', 'request', 'inject', 'response'] } } }, ['topics', 'from'])],
  ['hub_pull', 'Read bounded buffered deliveries and the latest actual Hub caughtUp barrier, or null while no barrier has arrived. caughtUp.through is a sent/scanned historical waterline; caughtUp.cursor is the ACK cursor when the Hub sent it. Neither proves consumption, business completion, nor absence of future information. Repeated reads repeat unacknowledged deliveries. Use hub_ack after processing; no release is performed. A Hub delivery gap stops this subscription and returns explicit recovery information; unsubscribe and choose a replay sequence explicitly rather than silently accepting missing information.', input({ subscription: { type: 'string', minLength: 1 }, maxMessages: { type: 'integer', minimum: 1 }, waitMs: { type: 'integer', minimum: 0, maximum: 120000 } }, ['subscription']), true],
  ['hub_ack', 'Acknowledge only deliveries actually buffered for this subscription. Acknowledgment advances consumption, never authorizes removal of Hub information.', input({ subscription: { type: 'string', minLength: 1 }, seqs: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: seqSchema } }, ['subscription', 'seqs'])],
  ['hub_unsubscribe', 'Remove this MCP connection\'s subscription. Unacknowledged Hub information remains governed by its provider.', input({ subscription: { type: 'string', minLength: 1 } }, ['subscription'])],
  ['hub_request', 'Submit a directed durable request without waiting for a business response. Acceptance is not completion. No automatic retry.', directedInput],
  ['hub_call', 'Send one directed request and wait for its first authenticated matching response. Returns both Hub acceptance and program response. Timeout/cancellation stops local waiting only, never cancels an accepted request or retries it.', directedInput],
  ['hub_inject', 'Inject information to an explicitly allowed program principal/session. Receipt means Hub acceptance, not recipient execution.', directedInput],
  ['hub_respond', 'Respond to a retained request using Hub-verified original routing. Only request sequences actually buffered by this MCP subscription may be used.', input({ requestSeq: seqSchema, body: {}, options: optionsSchema }, ['requestSeq', 'body'])],
  ['hub_release', 'As provider, permit later capacity cleanup of recent messages successfully published through this MCP connection on locally allowed topics. This bounded local authorization does not cover another bridge, a prior connection, or an unknown timeout outcome. Release does not immediately delete information and is independent of consumer acknowledgment.', input({ seqs: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: seqSchema } }, ['seqs'])],
  ['hub_blob_upload', 'Upload bounded base64 bytes using the Hub chunk protocol; returns an attachment descriptor. No local filesystem path or shell execution is available.', input({ data: { type: 'string' } }, ['data'])],
  ['hub_blob_read', 'Read one bounded base64 attachment chunk from a message actually received through this MCP connection on a locally permitted topic, including hub_call responses. Recent attachment authorizations are bounded; replay the message if it has expired from this local list. The Hub separately checks retained-message access. Offset/size/hash permit full-transfer verification. No local files are written.', input({ messageSeq: seqSchema, id: { type: 'string', minLength: 1, maxLength: 128 }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1 } }, ['messageSeq', 'id']), true],
]);

function abortable(promise, signal, timeoutMs, onAbort) {
  if (signal?.aborted) return Promise.reject(fail('CANCELLED', 'Local MCP wait cancelled; accepted Hub information is unchanged'));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => { try { onAbort?.(); } catch { /* Cleanup cannot replace cancellation. */ } finish(reject, fail('CANCELLED', 'Local MCP wait cancelled; accepted Hub information is unchanged')); };
    const timer = setTimeout(() => { try { onAbort?.(); } catch { /* Cleanup cannot replace timeout. */ } finish(reject, fail('LOCAL_TIMEOUT', 'Local wait timed out; Hub acceptance may already have occurred. Do not automatically retry')); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export class HubMcpService {
  constructor(config) {
    this.config = validateConfig(config);
    this.bridge = null; this.connecting = null; this.closed = false; this.fault = null;
    this.subscriptions = new Map(); this.waiters = new Set(); this.bufferedBytes = 0; this.bufferedMessages = 0; this.active = 0;
    this.subscriptionTokens = new Map(); this.subscriptionIds = new Map();
    this.attachmentReads = new Map();
    this.providerMessages = new Map();
  }
  safe(value) {
    const token = this.config.bridge.token;
    // Known private credentials are never included, even if a remote error echoes them.
    // Redact JSON string values, never serialized JSON syntax or protocol
    // field names. Tokens may contain quotes/backslashes, and even a valid
    // one-character token such as "o" must not corrupt the fixed "ok" field.
    const redact = text => token ? text.split(token).join('[REDACTED]') : text;
    const copy = JSON.parse(JSON.stringify(value));
    const visit = item => {
      if (typeof item === 'string') return redact(item);
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
      return item;
    };
    return visit(copy);
  }
  wake() { for (const notify of [...this.waiters]) notify(); }
  check(signal) {
    if (this.closed) throw fail('CLOSED', 'MCP service is closed');
    if (this.fault) throw fail(this.fault, 'Subscription buffering or connection integrity failed; restart this MCP connection before receiving again');
    if (signal?.aborted) throw fail('CANCELLED', 'Local MCP wait cancelled');
  }
  topic(topic, direction) {
    if (!this.config.permissions[`${direction}Topics`].includes(topic)) throw fail('LOCAL_PERMISSION_DENIED', `Topic is not permitted for ${direction}`);
  }
  directed(args, reply = false) {
    this.topic(args.topic, 'publish');
    if (reply) this.topic(args.topic, 'subscribe');
    if (!this.config.permissions.targetPrincipals.includes(args.target.principal)) throw fail('LOCAL_PERMISSION_DENIED', 'Target principal is not permitted');
  }
  options(args) {
    const opts = { ...args.options };
    if (opts.replyTo !== undefined) this.topic(opts.replyTo, 'subscribe');
    opts.timeoutMs = Math.min(opts.timeoutMs ?? this.config.limits.requestTimeoutMs, this.config.limits.requestTimeoutMs);
    return opts;
  }
  async connect(signal) {
    this.check(signal);
    if (this.bridge?.connected) return this.bridge;
    if (!this.connecting) {
      const { requireAuthenticated, expectedPrincipal, ...options } = this.config.bridge;
      const bridge = new Bridge({ ...options, autoAck: false, subscribeTimeoutMs: this.config.limits.requestTimeoutMs, maxPendingCalls: this.config.limits.maxConcurrentTools });
      this.bridge = bridge;
      // These listeners precede every subscribe call. The subscribed token
      // binds the Hub ID before an immediate historical delivery/barrier.
      bridge.on('subscribed', frame => this.bindSubscription(frame));
      bridge.on('delivery', message => this.receive(message));
      bridge.on('caughtUp', frame => this.observeCaughtUp(frame));
      bridge.on('overflow', frame => this.deliveryGap(frame, 'HUB_DELIVERY_GAP'));
      bridge.on('error', frame => { if (frame.code === 'CATCHUP_TRUNCATED') this.deliveryGap(frame, 'CATCHUP_TRUNCATED'); });
      bridge.on('close', () => {
        // A reconnect changes session and invalidates delivery-object ACK handles.
        if (this.closed) return;
        if (this.subscriptions.size) {
          this.fault = 'HUB_DISCONNECTED'; this.clearBuffers(); this.wake(); void bridge.close('MCP subscription connection ended');
        }
        // The SDK's automatic reconnect would accept a fresh welcome without
        // rerunning this adapter's authenticated/expected-principal checks.
        // Retire it even without subscriptions. A later explicit tool call may
        // create a new, fully verified connection; no accepted work is retried.
        this.attachmentReads.clear();
        this.providerMessages.clear();
        if (this.bridge === bridge) this.bridge = null;
        void bridge.close('MCP connection ended; a fresh handshake is required');
      });
      this.connecting = abortable(bridge.connect(), null, this.config.limits.connectTimeoutMs, () => { void bridge.close('MCP connection timeout'); }).then(welcome => {
        if ((requireAuthenticated && welcome.authenticated !== true) || (expectedPrincipal !== undefined && welcome.principal !== expectedPrincipal)) throw fail('HUB_IDENTITY_MISMATCH', 'Hub authentication or expected principal verification failed');
        return bridge;
      }).catch(async error => { await bridge.close('MCP connection rejected'); if (this.bridge === bridge) this.bridge = null; throw error; }).finally(() => { this.connecting = null; });
    }
    return abortable(this.connecting, signal, this.config.limits.connectTimeoutMs);
  }
  receive(message) {
    // A raw blob ID and guessed message sequence are not a local topic grant.
    // Remember only descriptor IDs actually delivered through allowed MCP
    // subscriptions/calls, without retaining arbitrary message bodies again.
    if (this.config.permissions.subscribeTopics.includes(message.topic) && Array.isArray(message.attachments) && message.attachments.length) {
      const ids = message.attachments.map(item => item?.id).filter(id => typeof id === 'string');
      if (ids.length) {
        this.attachmentReads.set(message.seq, { topic: message.topic, ids: new Set(ids) });
        while (this.attachmentReads.size > this.config.limits.maxBufferedMessages) this.attachmentReads.delete(this.attachmentReads.keys().next().value);
      }
    }
    const record = this.subscriptionIds.get(message.subscription);
    if (!record || record.barrier) return; // SDK call responses use their own bounded subscription.
    record.id = message.subscription;
    if (record.messages.has(message.seq)) return;
    const size = bytesOf(message);
    if (this.bufferedMessages >= this.config.limits.maxBufferedMessages || this.bufferedBytes + size > this.config.limits.maxBufferedBytes) {
      this.fault = 'BUFFER_LIMIT'; this.clearBuffers(); this.wake(); void this.bridge.close('MCP inbox capacity reached'); return;
    }
    record.messages.set(message.seq, { frame: message, size }); this.bufferedMessages++; this.bufferedBytes += size; this.wake();
  }
  bindSubscription(frame) {
    const record = this.subscriptionTokens.get(frame.token);
    if (!record) return; // A call owns its SDK subscription independently.
    record.id = frame.subscription;
    this.subscriptionIds.set(frame.subscription, record);
  }
  observeCaughtUp(frame) {
    const record = this.subscriptionIds.get(frame.subscription);
    if (!record || record.barrier) return;
    const observation = { type: 'caught_up', subscription: frame.subscription,
      ...(Number.isSafeInteger(frame.cursor) && frame.cursor >= 0 ? { cursor: frame.cursor } : {}),
      ...(Number.isSafeInteger(frame.through) && frame.through >= 0 ? { through: frame.through } : {}) };
    // Bridge dispatches deliveries through its per-subscription promise tail.
    // A wire barrier may arrive before that tail's final callback has run.
    // Let those already queued, synchronous inbox callbacks drain before
    // publishing the barrier, so a checkpoint cannot skip unseen deliveries.
    setImmediate(() => {
      if (this.closed || this.fault || record.barrier || this.subscriptionIds.get(frame.subscription) !== record) return;
      record.caughtUp = observation;
      this.wake();
    });
  }
  deliveryGap(frame, code) {
    const record = this.subscriptionIds.get(frame.subscription);
    if (!record || record.barrier) return;
    record.id = frame.subscription;
    record.barrier = { code, subscription: frame.subscription,
      ...(Array.isArray(frame.dropped) ? { dropped: frame.dropped.slice(0, 2) } : {}),
      ...(Number.isSafeInteger(frame.cursor) ? { cursor: frame.cursor } : {}),
      ...(Number.isSafeInteger(frame.oldestAvailable) ? { oldestAvailable: frame.oldestAvailable } : {}),
      ...(Number.isSafeInteger(frame.lastSeq) ? { lastSeq: frame.lastSeq } : {}),
      recovery: 'Unsubscribe this stopped subscription, then explicitly choose from when subscribing again. For a delivery-window gap, replay from before the first missing sequence; for a missing retention prefix, explicitly choosing oldestAvailable - 1 accepts that unavailable prefix. No provider information was released.' };
    // Never ACK across a gap or automatically accept a missing retention
    // prefix. Retire the Hub subscription but keep its diagnostic and existing
    // buffered deliveries until the consumer explicitly removes it.
    void this.bridge.unsubscribe(frame.subscription).catch(() => {});
    this.wake();
  }
  checkSubscription(sub) {
    if (!sub.barrier) return;
    throw Object.assign(fail(sub.barrier.code, 'Hub reported a delivery gap; this subscription stopped without accepting missing information'), { details: sub.barrier });
  }
  clearBuffers() { for (const sub of this.subscriptions.values()) sub.messages.clear(); this.bufferedBytes = 0; this.bufferedMessages = 0; }
  dropBuffered(sub) {
    for (const item of sub.messages.values()) { this.bufferedBytes -= item.size; this.bufferedMessages--; }
    sub.messages.clear();
  }
  forgetSubscription(sub) {
    this.dropBuffered(sub);
    this.subscriptionTokens.delete(sub.token);
    if (this.subscriptionIds.get(sub.id) === sub) this.subscriptionIds.delete(sub.id);
    for (const [key, value] of this.subscriptions) if (sub === value) this.subscriptions.delete(key);
    this.wake();
  }
  rememberPublication(receipt, topic) {
    if (!Number.isSafeInteger(receipt?.seq) || receipt.seq < 1) throw fail('RECEIPT_INVALID', 'Hub returned an invalid publication sequence');
    this.providerMessages.set(receipt.seq, topic);
    while (this.providerMessages.size > this.config.limits.maxBufferedMessages) this.providerMessages.delete(this.providerMessages.keys().next().value);
    return receipt;
  }
  getSub(id) {
    const sub = this.subscriptionIds.get(id);
    if (!sub) throw fail('SUBSCRIPTION_UNKNOWN', 'Subscription does not belong to this MCP connection');
    return sub;
  }
  async execute(name, args, signal) {
    this.check(signal);
    if (!this.config.permissions.tools.includes(name)) throw fail('LOCAL_PERMISSION_DENIED', 'Tool is not allowed by the private MCP configuration');
    if (this.active >= this.config.limits.maxConcurrentTools) throw fail('TOOL_LIMIT', 'Too many concurrent MCP operations');
    this.active++;
    try {
      const bridge = await this.connect(signal); this.check(signal);
      const opts = this.options(args);
      const wait = (promise, cleanup) => abortable(promise, signal, opts.timeoutMs + 100, cleanup);
      switch (name) {
        case 'hub_identity': {
          const w = bridge.welcome;
          return { ok: true, connected: bridge.connected, bridgeId: bridge.bridgeId, hub: w.hub, principal: w.principal, session: w.session, authenticated: w.authenticated, features: w.features, limits: w.limits, blobLimits: w.blobLimits,
            subscriptions: [...this.subscriptions.values()].map(sub => ({ subscription: sub.id, filters: sub.topics, buffered: sub.messages.size, caughtUp: sub.caughtUp, ...(sub.barrier ? { stopped: true, barrier: sub.barrier } : {}) })), bufferedMessages: this.bufferedMessages, bufferedBytes: this.bufferedBytes };
        }
        case 'hub_register_channels':
          for (const channel of args.channels) {
            if (channel.publish !== true && channel.subscribe !== true) throw fail('INPUT_INVALID', 'Each channel needs at least one true direction');
            if (channel.publish) this.topic(channel.name, 'publish'); if (channel.subscribe) this.topic(channel.name, 'subscribe');
          }
          return { ok: true, receipt: await wait(bridge.registerChannels(args.channels, opts)) };
        case 'hub_publish': this.topic(args.topic, 'publish'); return { ok: true, receipt: this.rememberPublication(await wait(bridge.publishConfirmed(args.topic, args.body, opts)), args.topic) };
        case 'hub_request': this.directed(args); return { ok: true, receipt: this.rememberPublication(await wait(bridge.requestTo(args.target, args.topic, args.body, opts)), args.topic) };
        case 'hub_inject': this.directed(args); return { ok: true, receipt: this.rememberPublication(await wait(bridge.sendTo(args.target, args.topic, args.body, opts)), args.topic) };
        case 'hub_call': {
          this.directed(args, true);
          const before = new Set(bridge.subscriptions.map(sub => sub.token));
          const pending = bridge.call(args.target, args.topic, args.body, opts);
          const own = bridge.subscriptions.filter(sub => !before.has(sub.token));
          const cleanup = () => { for (const sub of own) void bridge.unsubscribe(sub.id ?? sub.token).catch(() => {}); };
          const result = await wait(pending, cleanup);
          this.rememberPublication(result.request, args.topic);
          bridge.ack(result.response); // Complete this bounded adapter call, never release provider information.
          return { ok: true, ...result };
        }
        case 'hub_subscribe': {
          for (const topic of args.topics) this.topic(topic, 'subscribe');
          const topics = [...new Set(args.topics)].sort(), operations = args.operations ? [...new Set(args.operations)].sort() : undefined;
          const key = JSON.stringify([topics, operations ?? null]);
          const old = this.subscriptions.get(key);
          if (old && old.from !== args.from) throw fail('SUBSCRIPTION_EXISTS', 'Unsubscribe before changing a subscription starting point');
          if (old?.id) return { ok: true, subscription: old.id, filters: topics, deduped: true };
          if (old) throw fail('SUBSCRIPTION_PENDING', 'An identical subscription is still being established');
          const before = new Set(bridge.subscriptions.map(sub => sub.token));
          const pending = bridge.subscribe(topics, { from: args.from, ...(operations ? { operations } : {}) });
          const sdk = bridge.subscriptions.find(sub => !before.has(sub.token));
          const record = { token: sdk?.token, id: null, topics, operations, from: args.from, messages: new Map(), caughtUp: null };
          this.subscriptions.set(key, record);
          if (record.token) this.subscriptionTokens.set(record.token, record);
          try { const receipt = await wait(pending, () => { void bridge.unsubscribe(record.id ?? record.token).catch(() => {}); }); record.id = receipt.subscription; return { ok: true, ...receipt }; }
          catch (error) { this.forgetSubscription(record); throw error; }
        }
        case 'hub_pull': {
          const sub = this.getSub(args.subscription), limit = args.maxMessages ?? Math.min(16, this.config.limits.maxReadMessages), waitMs = args.waitMs ?? 0;
          this.checkSubscription(sub);
          if (limit > this.config.limits.maxReadMessages || waitMs > this.config.limits.maxReadWaitMs) throw fail('INPUT_LIMIT', 'Requested read count or wait exceeds the configured limit');
          if (!sub.messages.size && waitMs) {
            let notify;
            const caughtUpBeforeWait = sub.caughtUp;
            const wake = new Promise(resolve => {
              notify = () => { if (sub.messages.size || sub.caughtUp !== caughtUpBeforeWait || sub.barrier || this.subscriptionIds.get(sub.id) !== sub || this.closed || this.fault) resolve(); };
              this.waiters.add(notify);
            });
            try { await abortable(wake, signal, waitMs).catch(error => { if (error.code !== 'LOCAL_TIMEOUT') throw error; }); }
            finally { this.waiters.delete(notify); }
            this.check(signal);
            this.getSub(args.subscription);
            this.checkSubscription(sub);
          }
          const messages = []; let size = 256;
          for (const item of sub.messages.values()) {
            if (messages.length >= limit || size + item.size > this.config.limits.maxResultBytes / 2) break;
            messages.push(item.frame); size += item.size;
          }
          if (!messages.length && sub.messages.size) throw fail('RESULT_LIMIT', 'A delivery exceeds the MCP result limit; increase the private limit or read through another authorized bridge');
          return { ok: true, subscription: sub.id, messages, remaining: sub.messages.size - messages.length, caughtUp: sub.caughtUp };
        }
        case 'hub_ack': {
          const sub = this.getSub(args.subscription);
          if (args.seqs.some(seq => !sub.messages.has(seq))) throw fail('DELIVERY_UNKNOWN', 'A sequence was not buffered on this subscription');
          const acknowledged = [];
          for (const seq of args.seqs) {
            const item = sub.messages.get(seq);
            if (!bridge.ack(item.frame)) throw fail('ACK_FAILED', 'The delivery can no longer be acknowledged on this connection');
            sub.messages.delete(seq); this.bufferedBytes -= item.size; this.bufferedMessages--; acknowledged.push(seq);
          }
          return { ok: true, subscription: sub.id, acknowledged };
        }
        case 'hub_unsubscribe': {
          const sub = this.getSub(args.subscription), receipt = await wait(bridge.unsubscribe(sub.id));
          // Concurrent removals can await the same ID: only the first cleanup
          // owns the buffered entries, so clearing them is part of accounting.
          this.forgetSubscription(sub);
          return { ok: true, receipt };
        }
        case 'hub_respond': {
          const request = [...this.subscriptions.values()].flatMap(sub => [...sub.messages.values()]).find(item => item.frame.seq === args.requestSeq && item.frame.operation === 'request');
          if (!request) throw fail('REQUEST_UNKNOWN', 'Only a currently buffered request can be answered');
          this.topic(request.frame.topic, 'publish');
          if (!this.config.permissions.targetPrincipals.includes(request.frame.fromPrincipal)) throw fail('LOCAL_PERMISSION_DENIED', 'Request sender is not an allowed response target');
          return { ok: true, receipt: this.rememberPublication(await wait(bridge.respond(request.frame, args.body, opts)), request.frame.topic) };
        }
        case 'hub_release':
          for (const seq of args.seqs) {
            const topic = this.providerMessages.get(seq);
            if (topic === undefined) throw fail('MESSAGE_NOT_PUBLISHED', 'Release only recent messages successfully published through this MCP connection; other bridge messages and unknown outcomes are not authorized locally');
            this.topic(topic, 'publish');
          }
          return { ok: true, receipt: await wait(bridge.release(args.seqs, opts)) };
        case 'hub_blob_upload': {
          if (args.data.length > Math.ceil(this.config.limits.maxBlobBytes / 3) * 4) throw fail('INPUT_LIMIT', 'Blob exceeds the configured byte limit');
          const bytes = Buffer.from(args.data, 'base64');
          if (bytes.toString('base64') !== args.data || bytes.length > this.config.limits.maxBlobBytes) throw fail('INPUT_INVALID', 'Expected canonical bounded base64');
          const source = async function* () { if (signal?.aborted) throw fail('CANCELLED', 'Local upload cancelled'); yield bytes; };
          const blob = await wait(bridge.uploadStream(source(), { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), timeoutMs: opts.timeoutMs, commitTimeoutMs: opts.timeoutMs }));
          return { ok: true, blob };
        }
        case 'hub_blob_read': {
          const permission = this.attachmentReads.get(args.messageSeq);
          if (!permission?.ids.has(args.id)) throw fail('ATTACHMENT_NOT_RECEIVED', 'Read only attachments from messages recently received by this MCP connection; replay the message on an allowed topic first');
          this.topic(permission.topic, 'subscribe');
          const length = args.length ?? Math.min(65536, this.config.limits.maxBlobBytes, bridge.welcome.blobLimits?.chunkBytes ?? 65536);
          if (length > this.config.limits.maxBlobBytes || length * 3 > this.config.limits.maxResultBytes) throw fail('INPUT_LIMIT', 'Blob chunk exceeds the configured result limit');
          const chunk = await wait(bridge.communicationRequest('blob_read', { messageSeq: args.messageSeq, id: args.id, offset: args.offset ?? 0, length }, opts));
          const bytes = Buffer.from(chunk.data ?? '', 'base64');
          if (bytes.length > length || bytes.toString('base64') !== chunk.data || chunk.bytes !== bytes.length) throw fail('BLOB_INVALID', 'Hub returned an invalid attachment chunk');
          return { ok: true, chunk };
        }
        default: throw fail('TOOL_UNKNOWN', 'Unknown World Hub MCP tool');
      }
    } finally { this.active--; }
  }
  async result(name, args, signal) {
    let value;
    try {
      value = this.safe(await this.execute(name, args, signal));
      if (bytesOf(value) * 2 + 512 > this.config.limits.maxResultBytes) throw fail('RESULT_LIMIT', 'MCP result exceeds the private limit; no Hub information was released');
    } catch (error) {
      const message = String(error.message ?? 'Hub operation failed');
      const code = typeof error.code === 'string' ? error.code : /timed? ?out|timeout/i.test(message) ? 'LOCAL_TIMEOUT' : 'HUB_OPERATION_FAILED';
      value = this.safe({ ok: false, error: { code, message: message.slice(0, 1024), ...(error.details ? { details: error.details } : {}) } });
    }
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok ? {} : { isError: true }) };
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.wake(); this.clearBuffers(); this.subscriptions.clear(); this.subscriptionTokens.clear(); this.subscriptionIds.clear(); this.attachmentReads.clear(); this.providerMessages.clear(); await this.bridge?.close('MCP client disconnected');
  }
}

export function createHubMcpServer(config, service = new HubMcpService(config)) {
  const server = new McpServer({ name: 'world-hub', version: '0.21.0', title: 'World Hub communication' }, { capabilities: { tools: {} } });
  for (const [name, description, schema, readOnly = false] of TOOL_DEFINITIONS) {
    server.registerTool(name, {
      description, inputSchema: fromJsonSchema(schema),
      annotations: { readOnlyHint: readOnly, destructiveHint: name === 'hub_release', idempotentHint: readOnly, openWorldHint: true },
    }, (args, context) => service.result(name, args, context.mcpReq.signal));
  }
  return { server, service };
}
