// 枢纽：接线图 + 分发台。
//
// 它持有通讯状态：
//   1. 桥注册表（谁现在接在上面、叫什么、什么时候接上来的）
//   2. 订阅表（谁关心哪些主题）
//   3. 消息流水账（什么主题、什么时候、谁发的、多大）
//   4. 接入暂停策略与有界观测记录（管理设置另行持久保存）
//
// 它不持有任何业务状态，不加载任何外部程序代码，不理解任何主题的含义。
// 见《定位与边界》；conformance/invariants.test.mjs 与 hub-regression 验证通讯边界。

import { randomUUID } from 'node:crypto';
import { Acl } from './acl.mjs';
import { MessageLog, wireContractHash } from './store.mjs';
import { Router } from './router.mjs';
import { normalizeFilters } from './topic.mjs';
import { parseEnvelope, stringifyEnvelope, attachBodyRaw } from './wire-json.mjs';
import { addressMatches, normalizeTarget, normalizeOperations, operationMatches } from './address.mjs';
import { installBlobProtocol } from './blob-protocol.mjs';

export const WIRE_VERSION = '0.1';

export class Hub {
  #config;
  #log;
  #router = new Router();
  #acl;
  #bridges = new Map();
  #connections = new Map();
  #trace = [];
  #instanceSerial = 0;
  #publishQueue = Promise.resolve();
  #pausedPrincipals = new Set();
  #traceSerial = 0;
  #features = new Set(['directed-v1']);
  #extensions = [];
  #attachmentValidator = null;
  #startedAt = new Date().toISOString();
  #counters = { accepted: 0, denied: 0, delivered: 0, dropped: 0, catchUpTruncated: 0, gapLogFailures: 0 };
  #lastGapLogFailure = null;

  constructor(config) {
    this.#config = config;
    this.#acl = new Acl(config);
    this.#log = new MessageLog(config.log);
  }

  static async create(config) {
    const hub = new Hub(config);
    await hub.#log.open();
    try { await installBlobProtocol(hub, config); }
    catch (error) { await hub.#log.close().catch(() => {}); throw error; }
    return hub;
  }

  registerExtension({ features = [], handleFrame, validateAttachments, close, snapshot } = {}) {
    for (const feature of features) this.#features.add(feature);
    if (validateAttachments) this.#attachmentValidator = validateAttachments;
    this.#extensions.push({ handleFrame, close, snapshot });
  }

  get features() { return [...this.#features]; }

  get config() {
    return this.#config;
  }
  get log() {
    return this.#log;
  }
  get counters() {
    return { ...this.#counters };
  }
  get wireHash() {
    return wireContractHash(WIRE_VERSION);
  }

  // Local management controls only the communication principal. Resuming
  // never starts an application or grants new topic permissions.
  setPausedPrincipals(principals) {
    this.#pausedPrincipals = new Set(principals);
    for (const principal of this.#pausedPrincipals) this.disconnectPrincipal(principal, 'management paused');
  }

  disconnectPrincipal(principal, reason = 'management disconnected') {
    return this.disconnectConnections(principal, null, reason);
  }

  disconnectConnections(principal, ids, reason = 'management disconnected') {
    let count = 0;
    for (const record of [...this.#connections.values()]) {
      if (record.credentialId !== principal || (ids && !ids.includes(record.id))) continue;
      this.#onClose(record); // Retire queued frames and subscriptions immediately.
      try { record.conn.close(1008, reason); } catch { /* already retired */ }
      count++;
    }
    return count;
  }

  managementNote(note) { this.#traceNote(note); }

  /** 调试入口用的只读快照：这就是"接线图 + 流水账"的全部内容。 */
  snapshot() {
    return {
      hubId: this.#config.hub.id,
      wireVersion: WIRE_VERSION,
      wireHash: this.wireHash,
      startedAt: this.#startedAt,
      now: new Date().toISOString(),
      lastSeq: this.#log.lastSeq,
      logEnabled: this.#log.enabled,
      logDir: this.#log.dir,
      counters: this.counters,
      lastGapLogFailure: this.#lastGapLogFailure ? { ...this.#lastGapLogFailure } : null,
      storage: { log: this.#log.retentionSnapshot(),
        ...Object.assign({}, ...this.#extensions.map(extension => extension.snapshot?.() ?? {})) },
      bridges: [...this.#bridges.values()].map((b) => ({
        bridgeId: b.bridgeId,
        principal: b.credentialId,
        session: b.session,
        declaredId: b.declaredId,
        displayName: b.displayName,
        role: b.role,
        since: b.since,
        authenticated: b.authenticated,
        remoteAddress: b.remoteAddress,
        subscriptions: [...b.subscriptions],
        channels: [...b.channels.values()],
        published: b.published,
        delivered: b.delivered,
      })),
      connections: [...this.#connections.values()].map((c) => ({
        connectionId: c.id,
        bridgeId: c.bridgeId,
        remoteAddress: c.remoteAddress,
        since: c.since,
      })),
      subscriptions: this.#router.all().map((s) => ({
        id: s.id,
        bridgeId: s.bridgeId,
        filters: s.filters,
        ...(s.operations ? { operations: [...s.operations] } : {}),
        cursor: s.cursor,
        sentUpTo: s.sentUpTo,
        pending: s.pending,
        queued: s.queue.length,
        catchUp: s.catchUp,
        catchUpTarget: s.catchUpTarget,
        scannedUpTo: s.scanCursor,
        effectiveBatchLimit: Math.min(this.#config.limits.catchUpBatchSize, this.#config.limits.maxCatchUpMessages, Math.max(0, s.maxPending - s.pending)),
        windowLimit: s.maxPending,
        lastProgressAt: s.lastProgressAt ?? null,
      })),
      recent: this.#trace.slice(-100),
    };
  }

  // ── 连接生命周期 ────────────────────────────────────────────────

  onConnection(conn) {
    if (this.#connections.size >= this.#config.limits.maxConnections) {
      this.#send(conn, { type: 'denied', code: 'HUB_AT_CAPACITY', message: 'too many connections' });
      conn.close(1013, 'hub at capacity');
      return null;
    }
    const record = {
      id: `conn-${randomUUID().slice(0, 8)}`,
      conn,
      bridgeId: null,
      remoteAddress: conn.remoteAddress,
      since: new Date().toISOString(),
      frameQueue: Promise.resolve(),
      queuedFrames: 0,
      queuedBytes: 0,
    };
    this.#connections.set(record.id, record);
    conn.on('message', (text) => {
      const bytes = Buffer.byteLength(text);
      if (record.closed) return;
      if (record.queuedFrames >= (this.#config.limits.maxQueuedFrames ?? 64) || record.queuedBytes + bytes > (this.#config.limits.maxQueuedFrameBytes ?? 8 * 1024 * 1024)) {
        this.#send(conn, { type: 'error', code: 'INGRESS_OVERFLOW', message: 'connection input queue is full' });
        conn.close(1013, 'input queue full');
        return;
      }
      record.queuedFrames++;
      record.queuedBytes += bytes;
      record.frameQueue = record.frameQueue.then(() => this.#onFrame(record, text)).catch((err) => {
        this.#send(record.conn, {
          type: 'error',
          code: 'HUB_INTERNAL',
          message: String(err?.message ?? err).slice(0, 200),
        });
      }).finally(() => {
        record.queuedFrames--;
        record.queuedBytes -= bytes;
      });
    });
    conn.on('close', () => this.#onClose(record));
    return record;
  }

  #onClose(record) {
    record.closed = true;
    this.#connections.delete(record.id);
    if (!record.bridgeId) return;
    const bridge = this.#bridges.get(record.bridgeId);
    if (!bridge || bridge.connectionId !== record.id) return; // 已被新连接接管
    const removed = this.#router.removeAllOf(record.bridgeId);
    this.#bridges.delete(record.bridgeId);
    this.#traceNote({ kind: 'bridge.detached', bridgeId: record.bridgeId, subscriptions: removed.length });
  }

  // ── 线协议帧 ────────────────────────────────────────────────────

  async #onFrame(record, text) {
    if (record.closed || this.#connections.get(record.id) !== record) return;
    let frame;
    let bodyRaw;
    try {
      ({ frame, bodyRaw } = parseEnvelope(text));
    } catch {
      this.#send(record.conn, { type: 'error', code: 'FRAME_NOT_JSON', message: 'frame is not valid JSON' });
      return;
    }
    if (!frame || Array.isArray(frame) || typeof frame.type !== 'string') {
      this.#send(record.conn, { type: 'error', code: 'FRAME_INVALID', message: 'frame has no type' });
      return;
    }
    for (const key of ['id', 'correlation', 'replyTo', 'requestToken', ...(frame.type === 'subscribe' ? ['token'] : [])]) {
      if (frame[key] !== undefined && (typeof frame[key] !== 'string' || frame[key].length > 512)) {
        this.#send(record.conn, { type: 'error', code: 'FRAME_INVALID', message: `${key} must be a string of at most 512 characters`, requestToken: typeof frame.requestToken === 'string' && frame.requestToken.length <= 512 ? frame.requestToken : undefined });
        return;
      }
    }

    if (!record.bridgeId) {
      if (frame.type !== 'hello') {
        this.#send(record.conn, { type: 'error', code: 'HELLO_REQUIRED', message: 'first frame must be hello' });
        return;
      }
      await this.#onHello(record, frame);
      return;
    }

    switch (frame.type) {
      case 'publish':
      case 'request':
      case 'inject':
      case 'respond':
        {
          const task = this.#publishQueue.then(() => this.#onMessage(record, frame, bodyRaw));
          this.#publishQueue = task.catch(() => {});
          try { await task; }
          catch (err) {
            this.#counters.denied++;
            this.#send(record.conn, { type: 'error', code: err.code ?? 'HUB_INTERNAL', message: String(err?.message ?? err), requestToken: frame.requestToken,
              ...(err.code === 'LOG_CAPACITY' && err.logCapacity ? { logCapacity: err.logCapacity } : {}) });
          }
        }
        return;
      case 'register':
        this.#onRegister(record, frame);
        return;
      case 'release':
        await this.#onRelease(record, frame);
        return;
      case 'subscribe':
        await this.#onSubscribe(record, frame);
        return;
      case 'unsubscribe':
        this.#onUnsubscribe(record, frame);
        return;
      case 'ack':
        this.#onAck(record, frame);
        return;
      case 'resume':
        this.#onResume(record, frame);
        return;
      case 'bye':
        record.conn.close(1000, 'bye');
        return;
      case 'hello':
        this.#send(record.conn, { type: 'error', code: 'ALREADY_HELLO', message: 'hello already accepted' });
        return;
      default:
        try {
          const context = {
            principal: record.credentialId,
            session: record.session,
            bridgeId: record.bridgeId,
            send: (response) => this.#send(record.conn, response),
            canRead: (entry) => entry?.kind === 'message' && addressMatches(entry, { principal: record.credentialId, session: record.session }) &&
              this.#acl.canSubscribe(record.credentialId, entry.topic).ok,
          };
          for (const extension of this.#extensions) {
            if (extension.handleFrame && await extension.handleFrame(frame, context)) return;
          }
        } catch (error) {
          this.#send(record.conn, { type: 'error', code: error.code ?? 'HUB_INTERNAL', message: String(error.message ?? error), requestToken: frame.requestToken });
          return;
        }
        this.#send(record.conn, {
          type: 'error',
          code: 'FRAME_UNKNOWN',
          message: `unknown frame type "${frame.type}"`,
        });
    }
  }

  async #onHello(record, frame) {
    if (frame.wire !== WIRE_VERSION) {
      this.#counters.denied++;
      this.#send(record.conn, {
        type: 'denied',
        code: 'WIRE_VERSION_UNSUPPORTED',
        message: `hub speaks wire ${WIRE_VERSION}, bridge sent ${String(frame.wire)}`,
        hubWire: WIRE_VERSION,
      });
      record.conn.close(1008, 'wire version unsupported');
      return;
    }
    // 凭据模式：一个凭据允许多条连接，每条连接拿到独立实例身份 "<credential>:<n>"。
    // 单身份模式：bridgeId 即身份，同名重连 = 接管旧连接。
    const credentialId = typeof frame.credential === 'string' && frame.credential.length > 0 ? frame.credential : null;
    const liveInstances = credentialId ? this.#countLiveInstances(credentialId) : 0;
    const auth = this.#acl.authenticate(frame.bridge, frame.token, record.remoteAddress, credentialId, liveInstances);
    if (!auth.ok) {
      this.#counters.denied++;
      this.#send(record.conn, { type: 'denied', code: auth.code, message: auth.message });
      record.conn.close(1008, 'not authorized');
      this.#traceNote({
        kind: 'bridge.rejected',
        bridgeId: typeof frame.bridge === 'string' ? frame.bridge : null,
        code: auth.code,
      });
      return;
    }

    if (this.#pausedPrincipals.has(auth.credential ?? frame.bridge)) {
      this.#counters.denied++;
      this.#send(record.conn, { type: 'denied', code: 'BRIDGE_PAUSED', message: 'communication principal is paused by local management' });
      record.conn.close(1008, 'management paused');
      return;
    }

    const identity = credentialId ? `${credentialId}:${++this.#instanceSerial}` : frame.bridge;
    if (!credentialId && this.#bridges.has(identity)) {
      // 单身份模式下同名再次接入 = 重连：接管，旧连接明确关闭。
      const old = this.#bridges.get(identity);
      this.#connections.get(old.connectionId)?.conn.close(1000, 'superseded by a newer connection');
      this.#router.removeAllOf(identity);
      this.#bridges.delete(identity);
    }
    if (this.#bridges.size >= this.#config.limits.maxBridges) {
      this.#send(record.conn, { type: 'denied', code: 'HUB_AT_CAPACITY', message: 'too many bridges' });
      record.conn.close(1013, 'hub at capacity');
      return;
    }

    record.bridgeId = identity;
    record.credentialId = auth.credential ?? frame.bridge;
    record.session = randomUUID();
    this.#bridges.set(identity, {
      bridgeId: identity,
      declaredId: frame.bridge,
      credentialId: auth.credential ?? frame.bridge,
      session: record.session,
      connectionId: record.id,
      since: new Date().toISOString(),
      authenticated: auth.authenticated,
      remoteAddress: record.remoteAddress,
      subscriptions: new Set(),
      channels: new Map(),
      published: 0,
      delivered: 0,
      role: typeof frame.role === 'string' ? frame.role.slice(0, 40) : null,
      displayName: typeof frame.displayName === 'string' ? frame.displayName.slice(0, 120) : null,
    });

    this.#send(record.conn, {
      type: 'welcome',
      hub: this.#config.hub.id,
      hubWire: WIRE_VERSION,
      wireHash: this.wireHash,
      bridge: identity,
      principal: record.credentialId,
      session: record.session,
      features: this.features,
      blobLimits: Object.fromEntries(['chunkBytes', 'maxObjectBytes', 'maxTotalBytes', 'maxObjects'].map((key) => [key, this.#config.blobs[key]])),
      declared: frame.bridge,
      authenticated: auth.authenticated,
      lastSeq: this.#log.lastSeq,
      limits: this.#config.limits,
      now: new Date().toISOString(),
    });
    this.#traceNote({
      kind: 'bridge.attached',
      bridgeId: identity,
      declared: frame.bridge,
      authenticated: auth.authenticated,
      role: typeof frame.role === 'string' ? frame.role : null,
    });
  }

  /** 某个凭据当前有多少条存活连接（配额用）。 */
  #countLiveInstances(credentialId) {
    let n = 0;
    for (const b of this.#bridges.values()) {
      if (b.credentialId === credentialId) n++;
    }
    return n;
  }

  #onRegister(record, frame) {
    const error = (code, message) => this.#send(record.conn, { type: 'denied', code, message, requestToken: frame.requestToken });
    if (!Array.isArray(frame.channels) || frame.channels.length === 0 || frame.channels.length > 128) return error('CHANNEL_INVALID', 'channels must contain 1 to 128 declarations');
    const bridge = this.#bridges.get(record.bridgeId);
    if (!bridge) return;
    const prospective = new Map(bridge.channels);
    for (const channel of frame.channels) {
      if (!channel || typeof channel.name !== 'string' || (!channel.publish && !channel.subscribe) ||
          (channel.publish !== undefined && typeof channel.publish !== 'boolean') ||
          (channel.subscribe !== undefined && typeof channel.subscribe !== 'boolean')) return error('CHANNEL_INVALID', 'each channel declares name and publish/subscribe booleans');
      for (const direction of ['publish', 'subscribe']) {
        if (!channel[direction]) continue;
        const allowed = direction === 'publish' ? this.#acl.canPublish(record.credentialId, channel.name) : this.#acl.canSubscribe(record.credentialId, channel.name);
        if (!allowed.ok) return error(allowed.code, allowed.message);
      }
      const old = prospective.get(channel.name) ?? { name: channel.name, publish: false, subscribe: false };
      prospective.set(channel.name, { name: channel.name, publish: old.publish || channel.publish === true, subscribe: old.subscribe || channel.subscribe === true });
    }
    if (prospective.size > 128) return error('TOO_MANY_CHANNELS', 'at most 128 declared channels per bridge');
    bridge.channels = prospective;
    this.#send(record.conn, { type: 'registered', requestToken: frame.requestToken, channels: [...prospective.values()] });
  }

  #declareChannel(record, name, direction) {
    const channels = this.#bridges.get(record.bridgeId)?.channels;
    if (!channels) return;
    // Implicit declarations from publish/subscribe are diagnostic only and bounded.
    // They never decide whether an information category exists.
    if (!channels.has(name) && channels.size >= 128) return;
    const declaration = channels.get(name) ?? { name, publish: false, subscribe: false };
    declaration[direction] = true;
    channels.set(name, declaration);
  }

  async #onMessage(record, frame, bodyRaw) {
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
    for (const key of ['operation', 'owner', 'fromPrincipal', 'senderSession']) {
      if (Object.hasOwn(frame, key)) fail('FRAME_INVALID', `${key} is assigned by the hub`);
    }
    if (frame.type === 'publish') {
      if (Object.hasOwn(frame, 'target') || Object.hasOwn(frame, 'requestSeq')) fail('FRAME_INVALID', 'publish cannot claim directed message metadata');
      await this.#onPublish(record, frame, bodyRaw);
      return;
    }
    if (frame.type === 'respond') {
      if (Object.hasOwn(frame, 'target') || Object.hasOwn(frame, 'topic')) fail('FRAME_INVALID', 'response destination and topic are derived from its request');
      if (!Number.isSafeInteger(frame.requestSeq) || frame.requestSeq <= 0) fail('FRAME_INVALID', 'respond.requestSeq must be a positive safe integer');
      const request = await this.#log.get(frame.requestSeq);
      if (!request || request.operation !== 'request') fail('REQUEST_NOT_FOUND', 'request is not retained');
      if (!addressMatches(request, { principal: record.credentialId, session: record.session })) fail('RESPONSE_DENIED', 'this communication identity is not the request target');
      const routed = { ...frame, topic: request.topic };
      if (typeof request.correlation === 'string') routed.correlation = request.correlation;
      else delete routed.correlation;
      await this.#onPublish(record, routed, bodyRaw, { operation: 'response', target: { principal: request.owner ?? request.from }, requestSeq: request.seq });
      return;
    }
    if (Object.hasOwn(frame, 'requestSeq')) fail('FRAME_INVALID', 'requestSeq is assigned only to responses');
    const target = normalizeTarget(frame.target, this.#config);
    await this.#onPublish(record, frame, bodyRaw, { operation: frame.type, target });
  }

  async #onPublish(record, frame, bodyRaw, routing = null) {
    if (!this.#connections.has(record.id)) return;
    const bridgeId = record.bridgeId;
    const topic = frame.topic;
    // 权限按"凭据"判：同一凭据的多个实例共享同一套授权上限。
    const allow = this.#acl.canPublish(record.credentialId, topic);
    if (!allow.ok) {
      this.#counters.denied++;
      this.#send(record.conn, { type: 'denied', code: allow.code, message: allow.message, topic, requestToken: frame.requestToken });
      return;
    }
    if (!frame.body || typeof frame.body !== 'object' || Array.isArray(frame.body)) {
      this.#counters.denied++;
      this.#send(record.conn, {
        type: 'denied',
        code: 'BODY_NOT_OBJECT',
        message: 'body must be a JSON object',
        topic,
        requestToken: frame.requestToken,
      });
      return;
    }
    const bodyBytes = Buffer.byteLength(bodyRaw ?? JSON.stringify(frame.body));
    if (bodyBytes > this.#config.limits.maxPayloadBytes) {
      this.#counters.denied++;
      this.#send(record.conn, {
        type: 'denied',
        code: 'PAYLOAD_TOO_LARGE',
        message: `body is ${bodyBytes} bytes, limit is ${this.#config.limits.maxPayloadBytes}`,
        topic,
        requestToken: frame.requestToken,
      });
      return;
    }

    let attachments, releaseAttachments, seq, at, entry;
    try {
      if (frame.attachments !== undefined) {
        if (!Array.isArray(frame.attachments) || frame.attachments.length === 0 || frame.attachments.length > 16 ||
            new Set(frame.attachments).size !== frame.attachments.length ||
            frame.attachments.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
          throw Object.assign(new Error('attachments must contain 1 to 16 unique blob UUIDs'), { code: 'FRAME_INVALID' });
        }
        if (!this.#attachmentValidator) throw Object.assign(new Error('blob attachments are not supported'), { code: 'ATTACHMENTS_UNSUPPORTED' });
        const validated = await this.#attachmentValidator(record.credentialId, frame.attachments);
        if (Array.isArray(validated)) attachments = validated;
        else {
          releaseAttachments = validated?.release;
          attachments = validated?.attachments;
        }
        if (!Array.isArray(attachments)) throw new Error('attachment validator returned an invalid descriptor list');
      }
      if (record.closed || this.#connections.get(record.id) !== record) return;

      seq = this.#log.nextSeq();
      at = new Date().toISOString();
      entry = {
        seq,
        at,
        kind: 'message',
        topic,
        from: bridgeId,
        owner: record.credentialId, // Stable communication principal controls retention; never a payload field.
        body: frame.body, // JSON 查看视图；实际保存与转发以 bodyRaw 原文为准，见《通讯契约》。
        bytes: bodyBytes,
      };
      if (routing) Object.assign(entry, routing, { fromPrincipal: record.credentialId, senderSession: record.session });
      if (attachments) entry.attachments = attachments;
      attachBodyRaw(entry, bodyRaw);
      if (typeof frame.id === 'string' && frame.id.length > 0) entry.id = frame.id;
      if (typeof frame.correlation === 'string') entry.correlation = frame.correlation;
      if (typeof frame.replyTo === 'string') entry.replyTo = frame.replyTo;
      if (frame.headers && typeof frame.headers === 'object' && !Array.isArray(frame.headers)) {
        entry.headers = frame.headers;
      }
      await this.#log.append(entry);
    } finally {
      // This short communication lease protects the append transaction only.
      // It neither overrides a provider release nor waits for consumption.
      if (typeof releaseAttachments === 'function') await releaseAttachments();
    }
    this.#counters.accepted++;
    const bridge = this.#bridges.get(bridgeId);
    if (bridge) bridge.published++;

    this.#declareChannel(record, topic, 'publish');
    this.#send(record.conn, { type: 'published', seq, at, requestToken: frame.requestToken,
      ...(routing ? { operation: routing.operation, ...(routing.requestSeq !== undefined ? { requestSeq: routing.requestSeq } : {}) } : {}) });

    const { deliver, drop } = this.#router.route(topic, seq, entry);
    for (const { sub } of deliver) {
      this.#deliver(sub, entry);
    }
    for (const { sub, reason } of drop) {
      this.#counters.dropped++;
      this.#send(this.#connOf(sub.bridgeId), {
        type: 'overflow',
        subscription: sub.id,
        dropped: [seq, seq],
        reason,
      });
      let gapSeq;
      try {
        await this.#log.appendGap({
          seq: gapSeq = this.#log.nextSeq(),
          subscriptionId: sub.id,
          from: seq,
          to: seq,
          reason,
        });
      } catch (error) {
        // The publish is already committed. A diagnostic write must not report
        // that accepted publish as rejected, or delete a protected message.
        this.#counters.gapLogFailures++;
        this.#lastGapLogFailure = { at: new Date().toISOString(), seq: gapSeq,
          subscription: sub.id, from: seq, to: seq, reason, code: error.code ?? 'HUB_INTERNAL' };
        this.#traceNote({ kind: 'gap.log_failed', ...this.#lastGapLogFailure });
      }
    }

    this.#traceNote({
      kind: 'message',
      seq,
      topic,
      from: bridgeId,
      bytes: bodyBytes,
      deliveredTo: deliver.map((d) => d.sub.bridgeId),
      dropped: drop.length,
    });
  }

  async #onRelease(record, frame) {
    const seqs = Array.isArray(frame.seq) ? [...new Set(frame.seq)] : [];
    if (!Array.isArray(frame.seq) || frame.seq.length === 0 || frame.seq.length > 128 || seqs.some((seq) => !Number.isSafeInteger(seq) || seq <= 0)) {
      this.#send(record.conn, { type: 'error', code: 'FRAME_INVALID', message: 'release.seq must contain 1 to 128 positive safe integers', requestToken: frame.requestToken });
      return;
    }
    try {
      const released = await this.#log.release(seqs, record.credentialId);
      this.#send(record.conn, { type: 'released', seq: released, requestToken: frame.requestToken });
      this.#traceNote({ kind: 'message.released', bridgeId: record.bridgeId, seq: released });
    } catch (error) {
      this.#send(record.conn, { type: error.code === 'RELEASE_DENIED' ? 'denied' : 'error', code: error.code ?? 'HUB_INTERNAL', message: String(error.message ?? error), requestToken: frame.requestToken });
    }
  }

  async #onSubscribe(record, frame) {
    const bridgeId = record.bridgeId;
    let operations;
    try { operations = normalizeOperations(frame.operations); }
    catch (error) {
      this.#send(record.conn, { type: 'error', code: error.code, message: error.message, token: frame.token });
      return;
    }
    const filters = normalizeFilters(Array.isArray(frame.filters) ? frame.filters : []);
    if (filters.length === 0) {
      this.#send(record.conn, { type: 'error', code: 'FILTER_INVALID', message: 'filters must be a non-empty array' });
      return;
    }
    if (frame.from !== undefined && (!Number.isSafeInteger(frame.from) || frame.from < 0) && frame.from !== 'now') {
      this.#send(record.conn, { type: 'error', code: 'CURSOR_INVALID', token: frame.token, message: 'from must be a nonnegative safe integer or now' });
      return;
    }
    if (frame.delivery !== undefined && !['bounded_ack', 'at_least_once', 'at_most_once'].includes(frame.delivery)) {
      this.#send(record.conn, { type: 'error', code: 'DELIVERY_INVALID', token: frame.token, message: 'unsupported delivery mode' });
      return;
    }
    if (filters.length > this.#config.limits.maxFiltersPerSubscription) {
      this.#send(record.conn, {
        type: 'error',
        code: 'TOO_MANY_FILTERS',
        message: `at most ${this.#config.limits.maxFiltersPerSubscription} filters per subscription`,
      });
      return;
    }
    if (this.#router.subscriptionsOf(bridgeId).length >= this.#config.limits.maxSubscriptionsPerBridge) {
      this.#send(record.conn, {
        type: 'error',
        code: 'TOO_MANY_SUBSCRIPTIONS',
        message: `at most ${this.#config.limits.maxSubscriptionsPerBridge} subscriptions per bridge`,
      });
      return;
    }
    for (const f of filters) {
      const allow = this.#acl.canSubscribe(record.credentialId, f);
      if (!allow.ok) {
        this.#counters.denied++;
        this.#send(record.conn, { type: 'denied', code: allow.code, message: allow.message, filter: f });
        return;
      }
    }

    const lastSeq = this.#log.lastSeq;
    let cursor = lastSeq;
    if (typeof frame.from === 'number' && Number.isInteger(frame.from) && frame.from >= 0) {
      if (frame.from > lastSeq) {
        this.#send(record.conn, {
          type: 'error',
          code: 'CURSOR_AHEAD',
          message: `from=${frame.from} is beyond hub lastSeq=${lastSeq}; cursor clamped`,
        });
      }
      cursor = Math.min(frame.from, lastSeq);
    }
    const atMostOnce = frame.delivery === 'at_most_once';
    const sub = this.#router.add({
      bridgeId,
      principal: record.credentialId,
      session: record.session,
      filters,
      operations,
      cursor,
      atMostOnce,
      maxPending: this.#config.limits.maxPendingDeliveries,
    });
    const bridge = this.#bridges.get(bridgeId);
    if (bridge) bridge.subscriptions.add(sub.id);
    for (const filter of filters) this.#declareChannel(record, filter, 'subscribe');

    this.#send(record.conn, {
      type: 'subscribed',
      // 原样回带请求标识：桥据此把应答对上自己的请求（重连后重挂时尤其重要）。
      token: typeof frame.token === 'string' ? frame.token : null,
      subscription: sub.id,
      filters,
      ...(operations ? { operations } : {}),
      cursor: sub.cursor,
      catchUpFrom: cursor,
      catchUpTo: lastSeq,
    });
    this.#traceNote({ kind: 'subscribe', bridgeId, subscription: sub.id, filters, from: cursor });

    if (!atMostOnce && lastSeq > cursor) {
      sub.catchUp = true;
      sub.catchUpTarget = lastSeq;
      await this.#runCatchUp(sub);
    } else if (lastSeq === cursor) {
      this.#send(record.conn, { type: 'caught_up', subscription: sub.id, cursor: sub.cursor, through: lastSeq });
    }
  }

  #onUnsubscribe(record, frame) {
    const sub = this.#router.get(frame.subscription);
    if (!sub || sub.bridgeId !== record.bridgeId) {
      this.#send(record.conn, {
        type: 'error',
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: `no subscription "${String(frame.subscription)}" for this bridge`,
      });
      return;
    }
    this.#router.remove(sub.id);
    this.#bridges.get(record.bridgeId)?.subscriptions.delete(sub.id);
    this.#send(record.conn, { type: 'unsubscribed', subscription: sub.id, cursor: sub.cursor });
  }

  #onAck(record, frame) {
    const sub = this.#router.get(frame.subscription);
    if (!sub || sub.bridgeId !== record.bridgeId) {
      this.#send(record.conn, { type: 'error', code: 'SUBSCRIPTION_NOT_FOUND', message: 'subscription does not belong to this bridge' });
      return;
    }
    const seqs = Array.isArray(frame.seq) ? frame.seq : [];
    let changed = false;
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq) || seq < 0 || seq > sub.sentUpTo) {
        this.#send(record.conn, { type: 'error', code: 'ACK_INVALID', message: 'ack must reference a delivered sequence' });
        continue;
      }
      if (seq > sub.cursor && !sub.inFlight.has(seq) && !sub.acknowledged.has(seq)) {
        this.#send(record.conn, { type: 'error', code: 'ACK_INVALID', message: 'sequence was never delivered on this subscription' });
        continue;
      }
      changed = this.#router.ack(sub, seq) || changed;
    }
    if (changed) { clearTimeout(sub.idleTimer); sub.idleTimer = null; sub.lastProgressAt = new Date().toISOString(); }
    if (sub.catchUp) this.#runCatchUp(sub).catch((err) => this.#catchUpError(sub, err));
  }

  /** 客户端在收到 catchup_truncated 后，显式请求继续补历史。 */
  #onResume(record, frame) {
    const sub = this.#router.get(frame.subscription);
    if (!sub || sub.bridgeId !== record.bridgeId) {
      this.#send(record.conn, {
        type: 'error',
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: `no subscription "${String(frame.subscription)}" for this bridge`,
      });
      return;
    }
    sub.catchUp = true;
    sub.catchUpTarget = this.#log.lastSeq;
    sub.retentionPaused = false;
    this.#runCatchUp(sub).catch((err) => this.#catchUpError(sub, err));
  }

  // ── 补课与背压 ──────────────────────────────────────────────────

  #catchUpError(sub, err) {
    this.#send(this.#connOf(sub.bridgeId), { type: 'error', code: 'HUB_INTERNAL', message: String(err?.message ?? err) });
  }

  #armStall(sub) {
    if (sub.idleTimer) return;
    sub.idleTimer = setTimeout(() => { // transport flow-control timeout, never a business tick
      sub.idleTimer = null;
      if (this.#router.get(sub.id) !== sub || !sub.catchUp || sub.pending < sub.maxPending) return;
      this.#send(this.#connOf(sub.bridgeId), { type: 'error', code: 'CATCHUP_STALLED', message: 'delivery window remained full without progress' });
      this.#connOf(sub.bridgeId)?.close(1013, 'catch-up stalled');
    }, this.#config.limits.catchUpIdleMs ?? 30_000);
    sub.idleTimer.unref?.();
  }

  async #runCatchUp(sub) {
    if (sub.catchUpRunning) { sub.catchUpAgain = true; return; }
    sub.catchUpRunning = true;
    try {
      do {
        sub.catchUpAgain = false;
        while (sub.catchUp && !sub.retentionPaused && this.#router.get(sub.id) === sub) {
          if (sub.pending >= sub.maxPending) { this.#armStall(sub); return; }
          const budget = Math.max(1, Math.min(this.#config.limits.catchUpBatchSize, this.#config.limits.maxCatchUpMessages, sub.maxPending - sub.pending));
          const { records, truncated, hasMore, oldestAvailable } = await this.#log.range({
            after: sub.scanCursor, upTo: sub.catchUpTarget, filters: sub.filters, limit: budget,
            recipient: { principal: sub.principal, session: sub.session },
            operations: sub.operations,
          });
          if (this.#router.get(sub.id) !== sub) return;
          if (truncated) {
            this.#counters.catchUpTruncated++;
            const missing = [sub.scanCursor + 1, oldestAvailable - 1];
            sub.scanCursor = Math.max(sub.scanCursor, oldestAvailable - 1);
            sub.retentionPaused = true;
            this.#send(this.#connOf(sub.bridgeId), { type: 'catchup_truncated', subscription: sub.id,
              cursor: sub.cursor, oldestAvailable, lastSeq: this.#log.lastSeq, dropped: missing,
              reason: 'history older than retention window; send resume to accept the missing prefix' });
            return;
          }
          for (const entry of records) {
            sub.scanCursor = entry.seq;
            this.#deliver(sub, entry);
          }
          if (hasMore) continue;
          sub.scanCursor = sub.catchUpTarget;
          // The history scan is complete. Drain newer queued records in order,
          // retaining unsent entries when acknowledgements hold the window full.
          while (sub.queue.length > 0 && sub.pending < sub.maxPending) {
            const seq = sub.queue.shift();
            const entry = sub.queueEntries.get(seq);
            sub.queueEntries.delete(seq);
            if (entry) this.#deliver(sub, entry);
          }
          if (sub.queue.length > 0) { this.#armStall(sub); return; }
          if (sub.pending >= sub.maxPending) { this.#armStall(sub); return; }
          sub.catchUp = false;
          clearTimeout(sub.idleTimer);
          sub.idleTimer = null;
          this.#send(this.#connOf(sub.bridgeId), { type: 'caught_up', subscription: sub.id,
            cursor: sub.cursor, through: Math.max(sub.catchUpTarget, sub.sentUpTo) });
          this.#traceNote({ kind: 'caught_up', bridgeId: sub.bridgeId, subscription: sub.id, cursor: sub.cursor });
        }
      } while (sub.catchUpAgain && !sub.retentionPaused);
    } finally { sub.catchUpRunning = false; }
  }

  #connOf(bridgeId) {
    const bridge = this.#bridges.get(bridgeId);
    if (!bridge) return null;
    return this.#connections.get(bridge.connectionId)?.conn ?? null;
  }

  #deliver(sub, entry) {
    if (!addressMatches(entry, sub) || !operationMatches(entry, sub.operations)) return;
    const conn = this.#connOf(sub.bridgeId);
    if (!conn) return;
    // 同一订阅绝不重复投递同一个序号（补课与实时队列的交界处最容易撞上）。
    // 这是一道安全网：真正的顺序保证由游标推进负责。
    if (!this.#router.markSent(sub, entry.seq)) return;
    sub.sentSeqs.add(entry.seq);
    if (sub.sentSeqs.size > 8192) {
      // 有界：只保留最近的一批序号
      const keep = [...sub.sentSeqs].slice(-4096);
      sub.sentSeqs = new Set(keep);
    }
    const bridge = this.#bridges.get(sub.bridgeId);
    if (bridge) bridge.delivered++;
    this.#counters.delivered++;
    const frame = {
      type: 'delivery',
      subscription: sub.id,
      seq: entry.seq,
      at: entry.at,
      topic: entry.topic,
      from: entry.from,
      body: entry.body,
    };
    if (entry.id) frame.id = entry.id;
    if (entry.correlation) frame.correlation = entry.correlation;
    if (entry.replyTo) frame.replyTo = entry.replyTo;
    if (entry.headers) frame.headers = entry.headers;
    for (const key of ['operation', 'target', 'requestSeq', 'fromPrincipal', 'senderSession', 'attachments']) {
      if (entry[key] !== undefined) frame[key] = entry[key];
    }
    const sent = this.#send(conn, frame, entry.bodyRaw);
    if (sent) sub.lastProgressAt = new Date().toISOString();
    this.#traceNote({ kind: 'delivery', seq: entry.seq, topic: entry.topic, from: entry.from,
      to: sub.bridgeId, subscription: sub.id, bytes: entry.bytes, sent });
  }

  #send(conn, frame, bodyRaw) {
    if (!conn) return false;
    try {
      return conn.send(stringifyEnvelope(frame, bodyRaw)) !== false;
    } catch {
      /* 连接已断：由 close 流程清理 */
      return false;
    }
  }

  #traceNote(note) {
    this.#trace.push({ eventId: ++this.#traceSerial, at: new Date().toISOString(), ...note });
    if (this.#trace.length > 500) this.#trace.splice(0, this.#trace.length - 500);
  }

  async stop() {
    for (const sub of this.#router.all()) clearTimeout(sub.idleTimer);
    await this.#publishQueue;
    let failure;
    for (const extension of this.#extensions) {
      try { if (extension.close) await extension.close(); }
      catch (error) { failure ??= error; }
    }
    try { await this.#log.close(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}
