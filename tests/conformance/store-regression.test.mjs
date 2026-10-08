import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MessageLog } from '../../src/hub/lib/store.mjs';
import { stringifyEnvelope } from '../../src/hub/lib/wire-json.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-store-regression-'));
  const dir = join(root, 'log');
  const options = { dir, enabled: true, segmentMaxBytes: 250, segmentMaxCount: 64, ...overrides };
  const log = new MessageLog(options);
  await log.open();
  t.after(async () => {
    await log.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    assert.ok(target.includes('hub-store-regression-'));
    await rm(target, { recursive: true, force: true });
  });
  return { root, dir, options, log };
}

function message(log, n, pad = 80) {
  return { seq: log.nextSeq(), kind: 'message', topic: 'x', from: 'provider.a', body: { n, pad: 'x'.repeat(pad) } };
}

function range(log, after = 0, limit = 1000) {
  return log.range({ after, upTo: log.lastSeq, filters: ['#'], limit });
}

test('store: rotation keeps its first committed message visible in replay and tail', async (t) => {
  const { log, dir } = await fixture(t);
  await log.append(message(log, 1));
  await log.append(message(log, 2));
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.jsonl')).length, 2);
  assert.deepEqual((await range(log)).records.map((r) => r.seq), [1, 2]);
  assert.deepEqual(log.tail().map((r) => r.seq), [1, 2]);
  assert.equal(log.oldestSeq(), 1);
});

test('store: concurrent append serializes file writes, rotation, retention and restart', async (t) => {
  const { log, dir, options } = await fixture(t);
  const records = Array.from({ length: 40 }, (_, n) => message(log, n));
  assert.deepEqual(await Promise.all(records.map((r) => log.append(r))), records.map((r) => r.seq));
  assert.deepEqual((await range(log)).records.map((r) => r.seq), records.map((r) => r.seq));
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))) {
    assert.ok((await stat(join(dir, name))).size <= options.segmentMaxBytes);
    for (const line of (await readFile(join(dir, name), 'utf8')).trim().split('\n')) JSON.parse(line);
  }
  await log.close();
  const reopened = new MessageLog(options);
  await reopened.open();
  try {
    assert.equal(reopened.lastSeq, 40);
    assert.deepEqual((await range(reopened)).records.map((r) => r.seq), records.map((r) => r.seq));
    assert.deepEqual(reopened.tail(4).map((r) => r.seq), [37, 38, 39, 40]);
  } finally { await reopened.close(); }
});

test('store: batch limit signals hasMore without claiming unavailable retention', async (t) => {
  const { log } = await fixture(t);
  for (let n = 1; n <= 4; n++) await log.append(message(log, n));
  const first = await range(log, 0, 2);
  assert.deepEqual(first.records.map((r) => r.seq), [1, 2]);
  assert.equal(first.hasMore, true);
  assert.equal(first.truncated, false);
  assert.equal(first.oldestAvailable, 1);
  const second = await range(log, 2, 2);
  assert.deepEqual(second.records.map((r) => r.seq), [3, 4]);
  assert.equal(second.hasMore, false);
  assert.equal(second.truncated, false);
});

test('store: retained-prefix loss is explicit even for from=0 and a nonempty batch', async (t) => {
  const { log, dir } = await fixture(t, { segmentMaxCount: 2 });
  for (let n = 1; n <= 5; n++) {
    await log.append(message(log, n));
    await log.release([n], 'provider.a');
  }
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.jsonl')).length, 2);
  assert.equal(log.oldestSeq(), 4);
  const first = await range(log, 0, 1);
  assert.deepEqual(first.records.map((r) => r.seq), [4]);
  assert.equal(first.truncated, true);
  assert.equal(first.hasMore, true);
  assert.equal(first.oldestAvailable, 4);
  const rest = await range(log, 3);
  assert.deepEqual(rest.records.map((r) => r.seq), [4, 5]);
  assert.equal(rest.truncated, false);
  assert.deepEqual(log.tail().map((r) => r.seq), [4, 5]);
});

test('store: gap records remain in tail but never enter delivery or probeAfter', async (t) => {
  const { log } = await fixture(t);
  await log.append(message(log, 1));
  await log.appendGap({ seq: log.nextSeq(), subscriptionId: 'sub-1', from: 1, to: 1, reason: 'window full' });
  assert.equal(await log.probeAfter(1, 2, ['#']), false);
  await log.append(message(log, 3));
  assert.deepEqual((await range(log)).records.map((r) => r.seq), [1, 3]);
  assert.equal(await log.probeAfter(1, 3, ['#']), true);
  assert.deepEqual(log.tail().map((r) => r.kind), ['message', 'gap', 'message']);
});

test('store: payload JSON bytes survive JSONL persistence, rotation and restart', async (t) => {
  const { log, options, dir } = await fixture(t, { segmentMaxBytes: 400 });
  const bodyRaw = '{\n  "整数":9007199254740993, "nested": [1e+02, -0, "\\u4e16"]\n}';
  const record = { seq: log.nextSeq(), kind: 'message', topic: 'x', body: JSON.parse(bodyRaw) };
  Object.defineProperty(record, 'bodyRaw', { value: bodyRaw, enumerable: false });
  await log.append(record);
  await log.append(message(log, 2, 120));
  await log.close();
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(dir, name), 'utf8')).trim().split('\n')) JSON.parse(line);
  }
  const reopened = new MessageLog(options);
  await reopened.open();
  try {
    const restored = (await range(reopened)).records[0];
    assert.equal(restored.bodyRaw, bodyRaw);
    assert.equal(Object.keys(restored).includes('bodyRaw'), false);
    assert.equal(JSON.stringify(restored).includes('bodyRaw'), false);
    const deliveryText = stringifyEnvelope({ type: 'delivery', body: restored.body }, restored.bodyRaw);
    assert.ok(deliveryText.includes(bodyRaw));
    assert.ok(deliveryText.includes('9007199254740993'));
    assert.equal(deliveryText.includes('bodyRaw'), false);
  } finally { await reopened.close(); }
});

test('store: legacy logs restore raw body spans and top-level seq despite stale manifest', async (t) => {
  const { log, options, dir } = await fixture(t, { segmentMaxBytes: 1000 });
  await log.close();
  const bodyRaw = '{"seq":999999999,"number":9007199254740993}';
  await writeFile(join(dir, 'log-000000.jsonl'),
    '{"body":' + bodyRaw + ',"seq":1,"kind":"message","topic":"x"}\n', 'utf8');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    lastSeq: 0, segmentIndex: 0, sealedSegmentIndex: 10, sealedThrough: 0,
  }), 'utf8');
  const reopened = new MessageLog(options);
  await reopened.open();
  try {
    assert.equal(reopened.lastSeq, 1);
    assert.equal((await range(reopened)).records[0].bodyRaw, bodyRaw);
    assert.equal(reopened.nextSeq(), 2);
  } finally { await reopened.close(); }
});

test('store: recovery removes a torn active tail before appending the next record', async (t) => {
  const { log, options, dir } = await fixture(t, { segmentMaxBytes: 1000 });
  await log.append(message(log, 1));
  await log.close();
  const path = join(dir, 'log-000000.jsonl');
  await writeFile(path, (await readFile(path, 'utf8')) + '{"seq":999,', 'utf8');
  const reopened = new MessageLog(options);
  await reopened.open();
  try {
    assert.equal(reopened.lastSeq, 1);
    await reopened.append(message(reopened, 2));
    const records = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((r) => r.seq), [1, 2]);
  } finally { await reopened.close(); }
});

test('store: a rejected filesystem write is invisible and does not poison later appends', async (t) => {
  const { log } = await fixture(t, { segmentMaxBytes: 1000 });
  await log.append(message(log, 1));
  const path = log.segmentPath;
  const backup = await readFile(path, 'utf8');
  await unlink(path);
  await mkdir(path);
  await assert.rejects(() => log.append(message(log, 2)));
  assert.deepEqual(log.tail().map((r) => r.seq), [1]);
  assert.deepEqual((await range(log)).records.map((r) => r.seq), [1]);
  await rmdir(path); // Empty directory only; no recursive deletion.
  await writeFile(path, backup, 'utf8');
  await log.append(message(log, 3));
  assert.deepEqual((await range(log)).records.map((r) => r.seq), [1, 3]);
});

test('store: memory-only history obeys the same finite retention budget', async (t) => {
  const { log, root } = await fixture(t, { enabled: false, segmentMaxCount: 2 });
  for (let n = 1; n <= 8; n++) {
    await log.append(message(log, n));
    await log.release([n], 'provider.a');
  }
  assert.deepEqual(log.tail().map((r) => r.seq), [7, 8]);
  assert.equal((await range(log)).truncated, true);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(log.tail(0), []);
});

test('store: retention cleanup failure rejects before writing a new publish', async (t) => {
  const { log } = await fixture(t, { segmentMaxCount: 1 });
  await log.append(message(log, 1));
  await log.release([1], 'provider.a');
  const oldestPath = log.segmentPath;
  const backupPath = oldestPath + '.backup';
  await rename(oldestPath, backupPath);
  await mkdir(oldestPath);
  try {
    await assert.rejects(() => log.append(message(log, 2)), 'cleanup must precede the new write');
    assert.ok(log.maintenanceError);
    await assert.rejects(() => log.append(message(log, 3)), 'cleanup must succeed before accepting more');
    assert.deepEqual(log.tail().map((r) => r.seq), [1]);
  } finally {
    await rmdir(oldestPath);
    await rename(backupPath, oldestPath);
  }
  await log.append(message(log, 4));
  assert.equal(log.maintenanceError, null);
  assert.deepEqual(log.tail().map((r) => r.seq), [4]);
});

test('store: input without readers stays protected across restart and refuses new capacity', async (t) => {
  const { log, options, dir } = await fixture(t, { segmentMaxBytes: 1, segmentMaxCount: 2 });
  await log.append(message(log, 1));
  await log.append(message(log, 2));
  await assert.rejects(() => log.append(message(log, 3)), { code: 'LOG_CAPACITY' });
  assert.deepEqual((await range(log)).records.map((r) => r.seq), [1, 2]);
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.jsonl')).length, 2);
  await log.close();
  const reopened = new MessageLog(options);
  await reopened.open();
  try {
    assert.deepEqual((await range(reopened)).records.map((r) => r.seq), [1, 2]);
    await assert.rejects(() => reopened.append(message(reopened, 4)), { code: 'LOG_CAPACITY' });
    assert.deepEqual(reopened.tail().map((r) => r.body.n), [1, 2]);
    assert.equal((await range(reopened)).truncated, false);
  } finally { await reopened.close(); }
});

test('store: provider release is durable, non-destructive and controls prefix cleanup', async (t) => {
  const { log, options, dir } = await fixture(t, { segmentMaxBytes: 1, segmentMaxCount: 2 });
  await log.append({ ...message(log, 1), owner: 'credential.a', from: 'credential.a:1' });
  await log.append({ ...message(log, 2), owner: 'credential.a', from: 'credential.a:1' });
  await assert.rejects(() => log.release([1], 'credential.a:1'), { code: 'RELEASE_DENIED' });
  assert.deepEqual(await log.release([1, 1], 'credential.a'), [1]);
  assert.deepEqual((await range(log)).records.map((r) => r.seq), [1, 2], 'release leaves history readable');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8')), { version: 1, seq: [1] });
  await log.close();
  const reopened = new MessageLog(options);
  await reopened.open();
  try {
    await reopened.append({ ...message(reopened, 3), owner: 'credential.a' });
    assert.deepEqual(reopened.tail().map((r) => r.body.n), [2, 3]);
    assert.equal((await range(reopened)).truncated, true);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8')).seq, [], 'release state is bounded to retained history');
    await assert.rejects(() => reopened.append(message(reopened, 4)), { code: 'LOG_CAPACITY' });
  } finally { await reopened.close(); }
});

test('store: release validates the whole owner batch before changing protection', async (t) => {
  const { log, dir } = await fixture(t, { segmentMaxBytes: 1, segmentMaxCount: 2 });
  await log.append(message(log, 1));
  await log.append({ ...message(log, 2), from: 'provider.b' });
  await assert.rejects(() => log.release([1, 2], 'provider.a'), { code: 'RELEASE_DENIED' });
  await assert.rejects(() => log.release([1, 999], 'provider.a'), { code: 'MESSAGE_NOT_FOUND' });
  await assert.rejects(() => log.release([0], 'provider.a'), { code: 'MESSAGE_NOT_FOUND' });
  await assert.rejects(() => readFile(join(dir, 'releases.json')), { code: 'ENOENT' });
  await assert.rejects(() => log.append(message(log, 3)), { code: 'LOG_CAPACITY' });
  assert.deepEqual(await log.release([2], 'provider.b'), [2]);
  await assert.rejects(() => log.append(message(log, 4)), { code: 'LOG_CAPACITY' }, 'a later released segment cannot bypass the protected prefix');
  assert.deepEqual(log.tail().map((r) => r.seq), [1, 2]);
});

test('store: failed release metadata commit keeps the original protection', async (t) => {
  const { log, dir } = await fixture(t, { segmentMaxBytes: 1, segmentMaxCount: 1 });
  await log.append(message(log, 1));
  const releasesPath = join(dir, 'releases.json');
  await mkdir(releasesPath);
  try {
    await assert.rejects(() => log.release([1], 'provider.a'));
    await assert.rejects(() => log.append(message(log, 2)), { code: 'LOG_CAPACITY' });
    assert.deepEqual(log.tail().map((r) => r.seq), [1]);
    assert.equal((await readdir(dir)).includes('releases.json.tmp'), false);
  } finally { await rmdir(releasesPath); }
  assert.deepEqual(await log.release([1], 'provider.a'), [1]);
  await log.append(message(log, 3));
  assert.deepEqual(log.tail().map((r) => r.seq), [3]);
});

test('store: corrupt release metadata refuses startup without deleting protected input', async (t) => {
  const { log, options, dir } = await fixture(t, { segmentMaxBytes: 1, segmentMaxCount: 1 });
  await log.append(message(log, 1));
  await log.close();
  await writeFile(join(dir, 'releases.json'), '{"version":1,"seq":[', 'utf8');
  const reopened = new MessageLog(options);
  await assert.rejects(() => reopened.open(), { code: 'LOG_RELEASE_CORRUPT' });
  const lines = (await readFile(join(dir, 'log-000000.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((r) => r.seq), [1]);
});

test('store: memory-only capacity is protected until the provider releases input', async (t) => {
  const { log, root } = await fixture(t, { enabled: false, segmentMaxBytes: 1, segmentMaxCount: 1 });
  await log.append(message(log, 1));
  await assert.rejects(() => log.append(message(log, 2)), { code: 'LOG_CAPACITY' });
  await log.release([1], 'provider.a');
  await log.append(message(log, 3));
  assert.deepEqual(log.tail().map((r) => r.seq), [3]);
  assert.deepEqual(await readdir(root), []);
});

test('store: a diagnostic gap cannot rotate away protected messages', async (t) => {
  const { log } = await fixture(t, { segmentMaxBytes: 1, segmentMaxCount: 1 });
  await log.append(message(log, 1));
  await assert.rejects(() => log.appendGap({ seq: log.nextSeq(), subscriptionId: 's', from: 1, to: 1, reason: 'full' }), { code: 'LOG_CAPACITY' });
  assert.deepEqual(log.tail().map((r) => r.kind), ['message']);
  await log.release([1], 'provider.a');
  await log.appendGap({ seq: log.nextSeq(), subscriptionId: 's', from: 1, to: 1, reason: 'full' });
  await log.append(message(log, 4));
  assert.deepEqual(log.tail().map((r) => r.seq), [4], 'gap itself carries no provider protection');
});
