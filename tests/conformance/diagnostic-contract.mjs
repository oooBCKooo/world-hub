// Test-only review ledger. The hub never loads this file or application schemas.
// A purpose + executable evidence reference makes a field decision reviewable;
// it cannot mechanically prove that arbitrary new semantics belong in the hub.
import assert from 'node:assert/strict';

const field = (rule, purpose, evidence, optional = false) => ({ rule, purpose, evidence, optional });
const object = fields => ({ fields });
const array = item => ({ item });
const nullable = schema => ({ nullable: schema });
const evidence = (file, test) => ({ file, test });
export const EVIDENCE = {
  full: evidence('capacity-http.test.mjs', 'capacity diagnostics survive a full log: accepted publish, failed gap, owner release and shared HTTP views'),
  log: evidence('capacity-observability.test.mjs', 'capacity observation: oldest unreleased stable owners identify global blockers; release and rotation refresh attribution'),
  segments: evidence('capacity-observability.test.mjs', 'capacity observation: unused segments and active target are distinct; only the oldest segment contributes blocker owners'),
  partial: evidence('capacity-observability.test.mjs', 'capacity observation: partial upload reserves declared bytes and zero-byte objects consume slots'),
  reclaim: evidence('capacity-observability.test.mjs', 'capacity observation: release retains reservation and bytes until a new begin reclaims only permitted objects'),
  pin: evidence('capacity-observability.test.mjs', 'capacity observation: a released object with an append pin is excluded from reclaimable capacity until the lease ends'),
  cold: evidence('recovery-scale.test.mjs', 'REC-01 real hub cold restart replays 12000 matching records and sparse topics through a 17-message ACK window'),
  batch: evidence('recovery-scale.test.mjs', 'REC-03 configured catch-up batch can exceed 256 and still respects maxCatchUpMessages and remaining window'),
  state: evidence('diagnostic-contract.test.mjs', 'diagnostic values depend on transport actions, not payload business claims'),
};

// Each leaf states its communication purpose and an executable acceptance case.
// Never allow a namespace wholesale (including counters or blob limits).
export const DIAGNOSTIC_SCHEMA = object({
  counters: object({
    accepted: field('count', '本进程成功接纳消息数；不是完成业务数', EVIDENCE.state),
    denied: field('count', '本进程拒绝通讯帧数；不是程序审批决定', EVIDENCE.state),
    delivered: field('count', '本进程实际执行投递次数；不是接收方业务成功', EVIDENCE.state),
    dropped: field('count', '本进程窗口或队列溢出投递数；不是内容淘汰策略', EVIDENCE.full),
    catchUpTruncated: field('count', '本进程报告保留历史缺失的次数', EVIDENCE.cold),
    gapLogFailures: field('count', '已接纳消息的诊断gap追加失败次数，重启归零', EVIDENCE.full),
  }),
  storage: object({
    log: object({
      lastSeq: field('count', '通讯序号分配高水位，可包含拒绝追加后的空洞', EVIDENCE.log),
      oldestSeq: field('positive', '仍保留的最早通讯序号或空日志下一序号', EVIDENCE.segments),
      retainedCount: field('count', '保留message记录数，不含gap记录', EVIDENCE.log),
      protectedCount: field('count', '未获提供者释放许可的message记录数', EVIDENCE.log),
      releasedCount: field('count', '已获许可但尚未轮转删除的message记录数', EVIDENCE.log),
      segmentCount: field('count', '当前通讯日志段数，含活动段', EVIDENCE.segments),
      bytes: field('number', '保留通讯日志编码字节，非业务数据价值', EVIDENCE.log),
      oldestProtected: field('boolean', '最旧段是否仍含未释放message', EVIDENCE.log),
      oldestProtectedOwners: array(object({
        principal: field('identity', '最旧段未释放message的通讯归属，历史缺失则null', EVIDENCE.log),
        firstSeq: field('positive', '该主体在最旧段第一条未释放通讯序号', EVIDENCE.log),
        lastSeq: field('positive', '该主体在最旧段最后一条未释放通讯序号', EVIDENCE.log),
        count: field('positive', '该主体在最旧段未释放message数', EVIDENCE.log),
      })),
      unusedSegmentSlots: field('count', '尚未使用的日志段位；不是无限可写许可', EVIDENCE.segments),
      activeSegmentTargetRemainingBytes: field('number', '活动段距轮转目标的字节；不等于精确容量', EVIDENCE.segments),
      nextRotationBlocked: field('boolean', '段位耗尽且最旧段受保护时的通讯轮转阻挡', EVIDENCE.full),
      enabled: field('boolean', '是否启用跨重启磁盘通讯留存', EVIDENCE.segments),
      maintenanceError: field('textOrNull', '通讯存储清理失败的诊断文本，非业务错误分类', EVIDENCE.state),
      capacity: object({
        segmentMaxBytes: field('positive', '日志单段轮转目标配置', EVIDENCE.segments),
        segmentMaxCount: field('positive', '日志段数上限配置', EVIDENCE.segments),
      }),
    }),
    blobs: object({
      dir: field('text', '附件通讯对象存储目录，非外部程序工作目录', EVIDENCE.state),
      count: field('count', '保留附件对象数，含未完成与已释放对象', EVIDENCE.partial),
      reservedBytes: field('number', '兼容数值预约量，精确量另用decimal字符串', EVIDENCE.partial),
      reservedBytesExact: field('decimal', '已预约对象声明size之和，包含partial', EVIDENCE.partial),
      remainingBytes: field('decimal', '配置总预约上限减当前预约，下限0', EVIDENCE.partial),
      remainingObjectSlots: field('count', '空闲对象位，零字节对象也占位', EVIDENCE.partial),
      releasedBytes: field('decimal', '已获提供者许可但仍占用的预约字节', EVIDENCE.reclaim),
      reclaimableBytes: field('decimal', '已释放且无短期追加pin的预约字节', EVIDENCE.pin),
      reclaimableObjectCount: field('count', '已释放且无短期追加pin的对象数', EVIDENCE.pin),
      writtenBytes: field('number', '对象确认offset之和，不等于声明预约量', EVIDENCE.partial),
      protectedCount: field('count', '未获提供者释放许可的附件对象数', EVIDENCE.reclaim),
      releasedCount: field('count', '已获许可但尚未按需回收的对象数', EVIDENCE.reclaim),
      uploadingCount: field('count', '尚未commit的通讯对象数', EVIDENCE.partial),
      pinnedCount: field('count', '当前有短期消息追加租约的对象数，非消费者保留策略', EVIDENCE.pin),
      limits: object({
        maxObjectBytes: field('positive', '单个附件size上限', EVIDENCE.partial),
        maxTotalBytes: field('positive', '全部对象声明size预约上限', EVIDENCE.partial),
        maxObjects: field('positive', '全部附件对象位上限', EVIDENCE.partial),
        chunkBytes: field('positive', '一次分块通讯字节上限', EVIDENCE.partial),
        explicitDir: field('boolean', '对象目录是否显式配置，影响log-dir覆盖归属', EVIDENCE.state, true),
        dir: field('undefined', '避免limits重复导出目录；序列化时应省略', EVIDENCE.state, true),
      }),
    }),
  }),
  lastGapLogFailure: nullable(object({
    at: field('timestamp', '最近诊断gap追加失败的通讯时刻', EVIDENCE.full),
    seq: field('allocatedSequence', '若已为失败gap分配序号则报告；序号耗尽可缺失，不声称落盘', EVIDENCE.full, true),
    subscription: field('text', '发生当次投递缺口的订阅标识', EVIDENCE.full),
    from: field('positive', '缺口消息序号区间起点', EVIDENCE.full),
    to: field('positive', '缺口消息序号区间终点', EVIDENCE.full),
    reason: field('text', '窗口或队列溢出的通讯原因', EVIDENCE.full),
    code: field('text', 'gap存储失败的通讯错误码', EVIDENCE.full),
  })),
});

const RULES = {
  count: value => Number.isSafeInteger(value) && value >= 0,
  positive: value => Number.isSafeInteger(value) && value > 0,
  number: value => Number.isFinite(value) && Number.isInteger(value) && value >= 0,
  boolean: value => typeof value === 'boolean',
  decimal: value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value),
  text: value => typeof value === 'string' && value.length > 0,
  textOrNull: value => value === null || typeof value === 'string',
  identity: value => value === null || typeof value === 'string' && value.length > 0,
  timestamp: value => typeof value === 'string' && Number.isFinite(Date.parse(value)),
  undefined: value => value === undefined,
  allocatedSequence: value => value === undefined || Number.isSafeInteger(value) && value > 0,
};

export function diagnosticEntries(schema = DIAGNOSTIC_SCHEMA, path = '') {
  if (schema.fields) return Object.entries(schema.fields).flatMap(([key, child]) => diagnosticEntries(child, path ? `${path}.${key}` : key));
  if (schema.item) return diagnosticEntries(schema.item, `${path}[]`);
  if (schema.nullable) return diagnosticEntries(schema.nullable, path);
  return [{ path, ...schema }];
}

export function validateRegistry(schema = DIAGNOSTIC_SCHEMA) {
  function structure(node, path) {
    assert.ok(node && typeof node === 'object', `${path}: diagnostic schema required`);
    const kinds = ['fields', 'item', 'nullable', 'rule'].filter(key => Object.hasOwn(node, key));
    assert.equal(kinds.length, 1, `${path}: schema requires exactly one explicit shape`);
    if (node.fields) {
      assert.ok(Object.keys(node.fields).length > 0, `${path}: empty diagnostic namespaces cannot be registered without leaf purposes`);
      for (const [key, child] of Object.entries(node.fields)) structure(child, path ? `${path}.${key}` : key);
    } else if (node.item) structure(node.item, `${path}[]`);
    else if (node.nullable) structure(node.nullable, path);
  }
  structure(schema, '');
  const entries = diagnosticEntries(schema);
  for (const entry of entries) {
    assert.ok(typeof entry.purpose === 'string' && entry.purpose.trim(), `${entry.path}: communication purpose is required`);
    assert.ok(typeof entry.rule === 'string' && Object.hasOwn(RULES, entry.rule), `${entry.path}: an explicit value rule is required`);
    assert.ok(typeof entry.evidence?.file === 'string' && /^[a-z0-9-]+\.test\.mjs$/.test(entry.evidence.file)
      && typeof entry.evidence.test === 'string' && entry.evidence.test.trim(), `${entry.path}: executable evidence is required`);
  }
  return entries;
}

function validate(value, schema, path) {
  if (schema.nullable) { if (value === null) return; return validate(value, schema.nullable, path); }
  if (schema.item) { assert.ok(Array.isArray(value), `${path}: array required`); value.forEach((item, index) => validate(item, schema.item, `${path}[${index}]`)); return; }
  if (schema.fields) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path}: object required`);
    for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.fields, key), `${path}.${key}: unregistered diagnostic field`);
    for (const [key, child] of Object.entries(schema.fields)) {
      if (!Object.hasOwn(value, key) && child.optional) continue;
      assert.ok(Object.hasOwn(value, key), `${path}.${key}: registered field missing`);
      validate(value[key], child, `${path}.${key}`);
    }
    return;
  }
  assert.ok(RULES[schema.rule](value), `${path}: ${schema.rule} rule failed (${schema.purpose})`);
}

export function assertDiagnosticContract(snapshot, schema = DIAGNOSTIC_SCHEMA) {
  validateRegistry(schema);
  validate({ counters: snapshot.counters, storage: snapshot.storage, lastGapLogFailure: snapshot.lastGapLogFailure }, schema, 'snapshot');
  const log = snapshot.storage.log, blobs = snapshot.storage.blobs;
  assert.equal(log.retainedCount, log.protectedCount + log.releasedCount, 'message protection partitions the retained messages');
  assert.equal(log.unusedSegmentSlots, Math.max(0, log.capacity.segmentMaxCount - log.segmentCount), 'unused log slots derive from segment count');
  assert.equal(log.oldestProtected, log.oldestProtectedOwners.length > 0, 'oldest protection must have an observable communication owner');
  assert.equal(log.nextRotationBlocked, log.segmentCount >= log.capacity.segmentMaxCount && log.oldestProtected, 'rotation blockage depends on capacity and provider permission');
  for (const owner of log.oldestProtectedOwners) {
    assert.ok(owner.firstSeq <= owner.lastSeq && owner.count <= log.protectedCount, 'owner summaries describe retained protected sequence ranges');
  }
  const reserved = BigInt(blobs.reservedBytesExact), released = BigInt(blobs.releasedBytes), reclaimable = BigInt(blobs.reclaimableBytes);
  assert.equal(blobs.reservedBytes, Number(reserved), 'compatibility reservation number follows the exact reservation');
  assert.equal(BigInt(blobs.remainingBytes), BigInt(blobs.limits.maxTotalBytes) > reserved ? BigInt(blobs.limits.maxTotalBytes) - reserved : 0n, 'remaining reservation cannot invent capacity');
  assert.equal(blobs.remainingObjectSlots, Math.max(0, blobs.limits.maxObjects - blobs.count), 'remaining slots include all retained objects');
  assert.equal(blobs.count, blobs.protectedCount + blobs.releasedCount, 'object protection partitions retained objects');
  assert.ok(reclaimable <= released && released <= reserved && blobs.reclaimableObjectCount <= blobs.releasedCount, 'reclaimable requires provider release');
  assert.ok(blobs.uploadingCount <= blobs.count && blobs.pinnedCount <= blobs.count, 'upload and short leases refer to retained objects');
  if (snapshot.lastGapLogFailure) {
    assert.ok(snapshot.counters.gapLogFailures > 0, 'a gap failure detail requires a real failure count');
    assert.ok(snapshot.lastGapLogFailure.from <= snapshot.lastGapLogFailure.to, 'failure detail has a communication interval');
    if (snapshot.lastGapLogFailure.seq !== undefined) assert.ok(snapshot.lastGapLogFailure.seq <= log.lastSeq, 'allocated gap sequence cannot exceed the allocation high-water mark');
  } else assert.equal(snapshot.counters.gapLogFailures, 0, 'nonzero gap failures require their latest detail');
}
