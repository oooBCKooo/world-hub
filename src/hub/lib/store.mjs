// 枢纽的持久化：接线配置、通讯流水账与接入管理设置。
//
// 通讯日志在此处理；接入暂停与视图注记在 manage/management-state.mjs 处理。
// 任何业务状态都不在此列，见《定位与边界》。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rename, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { topicMatches, isValidFilter } from './topic.mjs';
import { parseEnvelope } from './wire-json.mjs';
import { isValidBridgeId } from './identity.mjs';
import { addressMatches, operationMatches } from './address.mjs';

export const CONFIG_VERSION = '0.1';

export const DEFAULT_LIMITS = {
  maxPayloadBytes: 1 * 1024 * 1024,
  maxSubscriptionsPerBridge: 64,
  maxFiltersPerSubscription: 16,
  maxPendingDeliveries: 512, // 每订阅未确认投递上限（背压窗口）
  maxCatchUpMessages: 5000, // 批取上限；批次边界不等于历史缺失
  catchUpBatchSize: 256,
  catchUpIdleMs: 30_000,
  maxQueuedFrames: 64,
  maxQueuedFrameBytes: 8 * 1024 * 1024,
  maxConnections: 256,
  maxBridges: 128,
};

export const DEFAULT_LOG = {
  enabled: true,
  dir: './.hub/log',
  segmentMaxBytes: 8 * 1024 * 1024,
  segmentMaxCount: 8,
};

export const DEFAULT_BLOBS = {
  maxObjectBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxObjects: 128,
  chunkBytes: 256 * 1024,
};

export const DEFAULT_TRANSPORT = {
  host: '127.0.0.1',
  port: 8790,
  path: '/bridge',
};

export function loadConfig(configPath) {
  let raw = {};
  if (configPath) {
    if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  }
  return normalizeConfig(raw, configPath);
}

export function normalizeConfig(raw, configPath) {
  // Fail malformed communications settings before any storage is opened. Only
  // validate fields owned by this config; unknown program/body fields stay opaque.
  configObject(raw, 'config', false);
  configObject(raw.log, 'log');
  configObject(raw.acl, 'acl');
  configObject(raw.acl?.bridges, 'acl.bridges');
  configObject(raw.acl?.credentials, 'acl.credentials');
  const baseDir = configPath ? dirname(resolve(configPath)) : process.cwd();
  const transport = { ...DEFAULT_TRANSPORT, ...(raw.transport ?? {}) };
  const limits = { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error(`limits.${key} must be a positive safe integer`);
  }
  const log = { ...DEFAULT_LOG, ...(raw.log ?? {}) };
  if (typeof log.enabled !== 'boolean') throw new Error('log.enabled must be a boolean');
  for (const key of ['segmentMaxBytes', 'segmentMaxCount']) {
    if (!Number.isSafeInteger(log[key]) || log[key] <= 0) throw new Error(`log.${key} must be a positive safe integer`);
  }
  log.dir = resolve(baseDir, log.dir);
  const blobs = { ...DEFAULT_BLOBS, ...(raw.blobs ?? {}) };
  for (const key of Object.keys(DEFAULT_BLOBS)) {
    if (!Number.isSafeInteger(blobs[key]) || blobs[key] <= 0) throw new Error(`blobs.${key} must be a positive safe integer`);
  }
  if (blobs.maxObjectBytes > blobs.maxTotalBytes) throw new Error('blobs.maxObjectBytes must not exceed blobs.maxTotalBytes');
  if (blobs.chunkBytes > 512 * 1024) throw new Error('blobs.chunkBytes must not exceed 512 KiB');
  blobs.dir = resolve(baseDir, raw.blobs?.dir ?? join(log.dir, 'blobs'));
  blobs.explicitDir = raw.blobs?.dir !== undefined;

  for (const id of [...Object.keys(raw.acl?.bridges ?? {}), ...Object.keys(raw.acl?.credentials ?? {})]) {
    if (!isValidBridgeId(id)) throw new Error(`ACL identity "${id}" is invalid: must match [a-z0-9][a-z0-9._-]{0,63}`);
  }

  for (const id of Object.keys(raw.acl?.bridges ?? {})) {
    if (Object.hasOwn(raw.acl?.credentials ?? {}, id)) {
      throw new Error(`ACL identity "${id}" occurs in both acl.bridges and acl.credentials`);
    }
  }

  const acl = {
    defaultDeny: raw.acl?.defaultDeny !== false,
    bridges: Object.create(null),
    credentials: Object.create(null),
    allowUnlistedBridges: raw.acl?.allowUnlistedBridges === true,
  };
  for (const [id, entry] of Object.entries(raw.acl?.bridges ?? {})) {
    validateAclEntry(entry, `acl.bridges.${id}`);
    acl.bridges[id] = {
      token: entry.token ?? null,
      allow: {
        publish: entry.allow?.publish ?? [],
        subscribe: entry.allow?.subscribe ?? [],
      },
    };
  }
  // 凭据配额：一个凭据允许多条连接（同一程序的多实例），每条连接拿独立实例身份。
  for (const [id, entry] of Object.entries(raw.acl?.credentials ?? {})) {
    validateAclEntry(entry, `acl.credentials.${id}`, true);
    acl.credentials[id] = {
      token: entry.token ?? null,
      maxConnections: entry.maxConnections ?? 1,
      allow: {
        publish: entry.allow?.publish ?? [],
        subscribe: entry.allow?.subscribe ?? [],
      },
    };
  }

  return {
    version: raw.version ?? CONFIG_VERSION,
    hub: { id: raw.hub?.id ?? 'local-hub' },
    transport,
    limits,
    log,
    blobs,
    acl,
    management: {
      stateFile: resolve(baseDir, raw.management?.stateFile ?? join(log.dir, 'management.json')),
      explicitStateFile: raw.management?.stateFile !== undefined,
      annotations: raw.management?.annotations ?? {},
    },
    configPath: configPath ? resolve(configPath) : null,
    baseDir,
  };
}

function configObject(value, field, optional = true) {
  if (optional && value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be a JSON object`);
}

function validateAclEntry(entry, field, credential = false) {
  configObject(entry, field, false);
  if (entry.token !== undefined && entry.token !== null && typeof entry.token !== 'string') {
    throw new Error(`${field}.token must be a string or null`);
  }
  if (credential && entry.maxConnections !== undefined &&
      (!Number.isSafeInteger(entry.maxConnections) || entry.maxConnections <= 0)) {
    throw new Error(`${field}.maxConnections must be a positive safe integer`);
  }
  configObject(entry.allow, `${field}.allow`);
  for (const operation of ['publish', 'subscribe']) {
    const rules = entry.allow?.[operation];
    if (rules === undefined) continue;
    if (!Array.isArray(rules)) throw new Error(`${field}.allow.${operation} must be an array of topic filters`);
    for (let index = 0; index < rules.length; index++) {
      if (!isValidFilter(rules[index])) throw new Error(`${field}.allow.${operation}[${index}] must be a valid topic filter`);
    }
  }
}

export function mintToken() {
  return randomBytes(24).toString('base64url');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 只追加的消息流水账（JSONL 分段）。
 *
 * bodyRaw 可逆保存载荷原始 JSON 文本；body 只是兼容视图。
 * 重投使用原文，不将兼容视图作为业务状态或重投权威，见《通讯契约》。
 */
export class MessageLog {
  #dir;
  #segmentMaxBytes;
  #segmentMaxCount;
  #enabled;
  #records = [];
  #seq = 0;
  #segmentIndex = 0;
  #segmentBytes = 0;
  #segmentPath = null;
  #ready = false;
  #segments = [];
  #operations = Promise.resolve();
  #committedSeq = 0;
  #maintenanceError = null;
  #sealedSegmentIndex = -1;
  #sealedThrough = 0;
  #released = new Set();

  constructor({ dir, segmentMaxBytes, segmentMaxCount, enabled }) {
    this.#dir = dir;
    this.#segmentMaxBytes = segmentMaxBytes;
    this.#segmentMaxCount = segmentMaxCount;
    this.#enabled = enabled;
    if (!Number.isSafeInteger(segmentMaxBytes) || segmentMaxBytes <= 0 ||
        !Number.isSafeInteger(segmentMaxCount) || segmentMaxCount <= 0) {
      throw new Error('log segment limits must be positive safe integers');
    }
  }

  get enabled() {
    return this.#enabled;
  }
  get dir() {
    return this.#dir;
  }
  get lastSeq() {
    return this.#seq;
  }
  get segmentPath() {
    return this.#segmentPath;
  }
  get maintenanceError() {
    return this.#maintenanceError;
  }

  retentionSnapshot() {
    const messages = this.#records.filter(record => record.kind === 'message');
    const protectedCount = messages.filter(record => !this.#released.has(record.seq)).length;
    const oldestProtected = this.#segments.length > 0 && !this.#releasable(this.#segments[0]);
    const owners = new Map();
    for (const record of this.#segments[0]?.records ?? []) {
      if (record.kind !== 'message' || this.#released.has(record.seq)) continue;
      const identity = record.owner ?? record.from;
      // Legacy records retain only from. Unknown metadata is reported as null;
      // it must not be attributed to an invented communication principal.
      const principal = typeof identity === 'string' && identity ? identity : null;
      const summary = owners.get(principal) ?? { principal, firstSeq: record.seq, lastSeq: record.seq, count: 0 };
      summary.firstSeq = Math.min(summary.firstSeq, record.seq);
      summary.lastSeq = Math.max(summary.lastSeq, record.seq);
      summary.count++;
      owners.set(principal, summary);
    }
    const oldestProtectedOwners = [...owners.values()].sort((left, right) => {
      const a = left.principal ?? '', b = right.principal ?? '';
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { lastSeq: this.#seq, oldestSeq: this.oldestSeq(), retainedCount: messages.length,
      protectedCount, releasedCount: messages.length - protectedCount, segmentCount: this.#segments.length,
      bytes: this.#segments.reduce((sum, segment) => sum + segment.bytes, 0), oldestProtected,
      oldestProtectedOwners,
      unusedSegmentSlots: Math.max(0, this.#segmentMaxCount - this.#segments.length),
      // This is the active segment's rotation target, not writable capacity.
      // An oversized record may occupy its own segment; rotation also depends
      // on provider release, filesystem operations and the next record's size.
      activeSegmentTargetRemainingBytes: Math.max(0, this.#segmentMaxBytes - this.#segmentBytes),
      nextRotationBlocked: this.#segments.length >= this.#segmentMaxCount && oldestProtected,
      enabled: this.#enabled, maintenanceError: this.#maintenanceError ? String(this.#maintenanceError.message) : null,
      capacity: { segmentMaxBytes: this.#segmentMaxBytes, segmentMaxCount: this.#segmentMaxCount } };
  }

  #enqueue(operation) {
    const result = this.#operations.then(operation);
    // A failed write is reported to its caller; the following request can retry.
    this.#operations = result.catch(() => {});
    return result;
  }

  #segmentName(index) {
    return `log-${String(index).padStart(6, '0')}.jsonl`;
  }

  #restoreRecord(line) {
    const { frame, bodyRaw: inlineBodyRaw } = parseEnvelope(line);
    if (!Number.isSafeInteger(frame.seq) || frame.seq <= 0) return null;
    const bodyRaw = typeof frame.bodyRaw === 'string' ? frame.bodyRaw : inlineBodyRaw;
    delete frame.bodyRaw;
    if (typeof bodyRaw === 'string') {
      Object.defineProperty(frame, 'bodyRaw', { value: bodyRaw, enumerable: false });
    }
    return frame;
  }

  #rebuildRecords() {
    const bySeq = new Map();
    for (const segment of this.#segments) {
      for (const record of segment.records) bySeq.set(record.seq, record);
    }
    this.#records = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  async open() {
    if (this.#ready) return;
    if (!this.#enabled) {
      if (this.#segments.length === 0) {
        this.#segments = [{ index: 0, path: null, bytes: 0, records: [] }];
      }
      this.#ready = true;
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    const manifestPath = join(this.#dir, 'manifest.json');
    let manifest = null;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch {
        /* 半写的 manifest：靠分段自己的内容恢复 */
      }
    }

    // Restore the top-level sequence of every retained segment. The payload's
    // own "seq" has no authority, and a stale/partial manifest is only a hint.
    const names = (await readdir(this.#dir)).filter((name) => /^log-\d+\.jsonl$/.test(name))
      .sort((a, b) => Number(a.slice(4, -6)) - Number(b.slice(4, -6)));
    this.#segments = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const path = join(this.#dir, name);
      let text = await readFile(path, 'utf8');
      if (i === names.length - 1 && text && !text.endsWith('\n')) {
        // Never concatenate a new record onto a torn JSONL tail after a crash.
        text = text.slice(0, text.lastIndexOf('\n') + 1);
        await truncate(path, Buffer.byteLength(text));
      }
      const records = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = this.#restoreRecord(line);
          if (record) records.push(record);
        } catch {
          // An incomplete/corrupt line is not a committed message.
        }
      }
      this.#segments.push({ index: Number(name.slice(4, -6)), path,
        bytes: Buffer.byteLength(text), records });
    }
    this.#rebuildRecords();
    this.#committedSeq = this.#records.at(-1)?.seq ?? 0;
    const savedSeq = Number.isSafeInteger(manifest?.lastSeq) ? manifest.lastSeq : 0;
    this.#seq = Math.max(savedSeq, this.#committedSeq);
    const releasesPath = join(this.#dir, 'releases.json');
    this.#released = new Set();
    if (existsSync(releasesPath)) {
      let releases;
      try { releases = JSON.parse(await readFile(releasesPath, 'utf8')); }
      catch (error) {
        throw Object.assign(new Error('release metadata is unreadable or corrupt', { cause: error }), { code: 'LOG_RELEASE_CORRUPT' });
      }
      if (releases?.version !== 1 || !Array.isArray(releases.seq) ||
          releases.seq.some((seq) => !Number.isSafeInteger(seq) || seq <= 0)) {
        throw Object.assign(new Error('release metadata has an invalid schema'), { code: 'LOG_RELEASE_CORRUPT' });
      }
      const retained = new Set(this.#records.filter((record) => record.kind === 'message').map((record) => record.seq));
      this.#released = new Set(releases.seq.filter((seq) => retained.has(seq)));
    }
    const savedIndex = Number.isSafeInteger(manifest?.segmentIndex) ? manifest.segmentIndex : 0;
    this.#segmentIndex = Math.max(this.#segments.at(-1)?.index ?? 0, savedIndex);
    this.#segmentPath = join(this.#dir, this.#segmentName(this.#segmentIndex));
    if (this.#segments.at(-1)?.index !== this.#segmentIndex) {
      await writeFile(this.#segmentPath, '', { encoding: 'utf8', flag: 'wx' });
      this.#segments.push({ index: this.#segmentIndex, path: this.#segmentPath, bytes: 0, records: [] });
    }
    this.#segmentBytes = this.#segments.at(-1).bytes;
    this.#sealedSegmentIndex = this.#segments.at(-2)?.index ?? -1;
    this.#sealedThrough = this.#segments.at(-2)?.records.at(-1)?.seq ?? 0;
    await this.#writeManifest();
    await this.#prune();
    this.#ready = true;
  }

  /** 序号是枢纽对被接受消息的唯一权威编号。 */
  nextSeq() {
    if (!this.#ready) throw new Error('log not open');
    if (this.#seq >= Number.MAX_SAFE_INTEGER) throw new Error('log sequence exhausted');
    return ++this.#seq;
  }

  append(record) {
    // body is a compatibility view; the reversible JSON string is the authority
    // for replay. This also keeps payload whitespace/newlines inside one JSONL line.
    const diskRecord = { ...record };
    delete diskRecord.bodyRaw;
    if (typeof record.bodyRaw === 'string') diskRecord.bodyRaw = record.bodyRaw;
    const line = JSON.stringify(diskRecord) + '\n';
    const bytes = Buffer.byteLength(line);
    const committedRecord = this.#restoreRecord(line);
    return this.#enqueue(async () => {
      if (!this.#ready) throw new Error('log not open');
      // A failed retention cleanup may leave one extra segment. Do not keep
      // accepting writes indefinitely while that filesystem failure persists.
      if (this.#maintenanceError || this.#segments.length > this.#segmentMaxCount) {
        await this.#writeManifest();
        await this.#prune();
      }
      if (this.#segments.length > this.#segmentMaxCount) throw this.#capacityError();
      if (!committedRecord || committedRecord.seq <= this.#committedSeq) {
        throw new Error('log sequence must advance');
      }
      if (this.#segmentBytes > 0 && this.#segmentBytes + bytes > this.#segmentMaxBytes) {
        await this.#rotate();
      }
      if (this.#enabled) {
        try {
          await appendFile(this.#segmentPath, line, 'utf8');
        } catch (error) {
          // Best effort rollback of a partial filesystem write. The rejected
          // record is never added to the readable cache.
          try { await truncate(this.#segmentPath, this.#segmentBytes); }
          catch { /* Preserve the original write error. */ }
          throw error;
        }
      }
      const active = this.#segments.at(-1);
      active.records.push(committedRecord);
      active.bytes += bytes;
      this.#segmentBytes = active.bytes;
      this.#records.push(committedRecord);
      this.#committedSeq = committedRecord.seq;
      this.#seq = Math.max(this.#seq, committedRecord.seq);
      return committedRecord.seq;
    });
  }

  async appendGap({ seq, subscriptionId, from, to, reason }) {
    return this.append({
      seq,
      at: new Date().toISOString(),
      kind: 'gap',
      topic: null,
      subscriptionId,
      from,
      to,
      reason,
    });
  }

  async #rotate() {
    // Providers decide when a message becomes disposable. Neither delivery nor
    // acknowledgement relaxes this default protection, including offline input.
    if (this.#segments.length >= this.#segmentMaxCount && !this.#releasable(this.#segments[0])) {
      throw this.#capacityError();
    }
    const index = this.#segmentIndex + 1;
    const path = this.#enabled ? join(this.#dir, this.#segmentName(index)) : null;
    if (this.#enabled) await writeFile(path, '', { encoding: 'utf8', flag: 'wx' });
    this.#sealedSegmentIndex = this.#segmentIndex;
    this.#sealedThrough = this.#committedSeq;
    this.#segmentIndex = index;
    this.#segmentPath = path;
    this.#segmentBytes = 0;
    this.#segments.push({ index, path, bytes: 0, records: [] });
    // Preserve the sequence high-water mark before deleting its last physical
    // record: a crash with an empty new segment must never reuse a released ID.
    try {
      await this.#writeManifest();
      await this.#prune();
    } catch (error) {
      this.#maintenanceError = error;
      throw error;
    }
    if (this.#segments.length > this.#segmentMaxCount) throw this.#capacityError();
  }

  #capacityError() {
    const error = Object.assign(new Error('log capacity is full; its oldest segment contains provider-protected messages'), { code: 'LOG_CAPACITY' });
    // Reuse the same communication-only observation as /status. Failure to
    // collect optional diagnostics must preserve the original capacity error.
    try { error.logCapacity = this.retentionSnapshot(); } catch { /* Preserve LOG_CAPACITY. */ }
    return error;
  }

  #releasable(segment) {
    return segment.records.every((record) => record.kind === 'gap' || this.#released.has(record.seq));
  }

  async #prune() {
    try {
      while (this.#segments.length > this.#segmentMaxCount) {
        const oldest = this.#segments[0];
        if (!this.#releasable(oldest)) break;
        if (this.#enabled) await unlink(oldest.path);
        this.#segments.shift();
        this.#rebuildRecords();
      }
      const retained = new Set(this.#records.filter((record) => record.kind === 'message').map((record) => record.seq));
      const released = new Set([...this.#released].filter((seq) => retained.has(seq)));
      if (released.size !== this.#released.size || this.#maintenanceError) {
        await this.#writeReleases(released);
        this.#released = released;
      }
      this.#maintenanceError = null;
    } catch (error) {
      this.#maintenanceError = error;
      throw error;
    }
  }

  /** Only the stable publishing principal may release its own retained input. */
  release(seqs, owner) {
    return this.#enqueue(async () => {
      if (!this.#ready) throw new Error('log not open');
      if (!Array.isArray(seqs) || seqs.length === 0 || seqs.some((seq) => !Number.isSafeInteger(seq) || seq <= 0)) {
        throw Object.assign(new Error('release references an invalid message sequence'), { code: 'MESSAGE_NOT_FOUND' });
      }
      const unique = [...new Set(seqs)];
      for (const seq of unique) {
        const record = this.#records.find((entry) => entry.seq === seq && entry.kind === 'message');
        if (!record) throw Object.assign(new Error(`message ${seq} is not retained`), { code: 'MESSAGE_NOT_FOUND' });
        if (typeof owner !== 'string' || owner.length === 0 || (record.owner ?? record.from) !== owner) {
          throw Object.assign(new Error(`message ${seq} belongs to another provider`), { code: 'RELEASE_DENIED' });
        }
      }
      const released = new Set(this.#released);
      for (const seq of unique) released.add(seq);
      await this.#writeReleases(released);
      this.#released = released;
      return unique;
    });
  }

  #writeReleases(released) {
    return this.#atomicJson('releases.json', { version: 1, seq: [...released].sort((a, b) => a - b) });
  }

  async #atomicJson(name, value) {
    if (!this.#enabled) return;
    const path = join(this.#dir, name);
    const temporary = path + '.tmp';
    let handle;
    try {
      handle = await open(temporary, 'w');
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  /**
   * 取 (after, upTo] 区间内匹配任一 filter 的记录，按 seq 升序。
   * truncated is ONLY a missing retention prefix; hasMore is ONLY a batch limit.
   * @returns {Promise<{records: object[], truncated: boolean, hasMore: boolean, oldestAvailable: number}>}
   */
  async range({ after, upTo, filters, limit, recipient, operations }) {
    return this.#enqueue(() => {
      const from = after + 1;
      const oldestAvailable = this.oldestSeq();
      const budget = Number.isSafeInteger(limit) && limit >= 0 ? limit : 256;
      const out = [];
      let hasMore = false;
      for (const record of this.#records) {
        if (record.drop || record.kind === 'gap' || typeof record.topic !== 'string') continue;
        if (record.seq < from || record.seq > upTo) continue;
        if (!filters.some((filter) => topicMatches(filter, record.topic))) continue;
        if (!addressMatches(record, recipient)) continue;
        if (!operationMatches(record, operations)) continue;
        if (out.length >= budget) { hasMore = true; break; }
        out.push(record);
      }
      return { records: out, hasMore, oldestAvailable,
        truncated: Math.min(upTo, this.#committedSeq) >= from && from < oldestAvailable };
    });
  }

  /** Read only a retained message. The caller applies its authenticated ACL. */
  get(seq) {
    return this.#records.find((record) => record.seq === seq && record.kind === 'message') ?? null;
  }

  oldestSeq() {
    return this.#records[0]?.seq ?? this.#seq + 1;
  }

  /**
   * (after, upTo] 内是否还存在匹配的记录（不看窗口预算）。
   * 补课循环靠它区分"真的追上了"和"这一批恰好都在窗口外"。
   */
  async probeAfter(after, upTo, filters) {
    const result = await this.range({ after, upTo, filters, limit: 1 });
    return result.records.length > 0;
  }

  tail(n = 50) {
    return Number.isSafeInteger(n) && n > 0 ? this.#records.slice(-n) : [];
  }

  async #writeManifest() {
    if (!this.#enabled) return;
    await this.#atomicJson('manifest.json', {
        lastSeq: this.#seq,
        segmentIndex: this.#segmentIndex,
        sealedSegmentIndex: this.#sealedSegmentIndex,
        sealedThrough: this.#sealedThrough,
      });
  }

  flush() {
    return this.#enqueue(async () => {
      await this.#writeManifest();
      await this.#prune();
    });
  }

  close() {
    return this.#enqueue(async () => {
      if (!this.#ready) return;
      await this.#writeManifest();
      await this.#prune();
      this.#ready = false;
    });
  }
}

/** 契约哈希：随 whoami 上报，两端借此确认线协议一致。 */
export function wireContractHash(wireVersion) {
  return createHash('sha256').update(`hub-wire/${wireVersion}`).digest('hex').slice(0, 16);
}
