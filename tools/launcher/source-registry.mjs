// Optional Launcher source configuration and observed provenance. This does
// not grant execution, identify publishers, or provide an operating-system sandbox.
import { mkdir, readdir, unlink, lstat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ordinaryPath, readBounded, privateJson, collectFiles, hash } from '../../scripts/runtime/paths.mjs';
import { validateSourceIndex, validateArtifactBytes } from '../../scripts/runtime/sources.mjs';

const sha = /^[a-f0-9]{64}$/;
const id = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const uuid = /^[a-f0-9-]{36}$/;
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const networkPolicy = value => value ? 'trusted-private-ipv4' : 'public-ipv4';
const fault = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const json = async (file, limit = 1024 * 1024) => JSON.parse((await readBounded(file, limit)).toString('utf8'));
const closed = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(name => names.includes(name));

export async function canonicalSource(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw fault('SOURCE_INPUT', 'Use a local index path or a HTTPS index URL.', 400);
  if (/^https?:/i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw fault('SOURCE_INPUT', 'Sources require HTTPS 443 without credentials or fragments.', 400);
    return url.href;
  }
  return ordinaryPath(resolve(value), { allowMissing: true });
}
const keyOf = source => /^https:/i.test(source) ? source : process.platform === 'win32' ? source.toLowerCase() : source;

function validateRecord(record) {
  if (!closed(record, ['id', 'name', 'source', 'enabled', 'priority', 'expectedSha256', 'allowPrivateNetwork', 'revision'])
    || !id.test(record.id) || typeof record.name !== 'string' || !record.name.trim() || record.name.length > 256
    || typeof record.source !== 'string' || !record.source || record.source.length > 4096 || typeof record.enabled !== 'boolean'
    || !Number.isInteger(record.priority) || record.priority < 0 || record.priority > 1000 || typeof record.allowPrivateNetwork !== 'boolean'
    || !Number.isSafeInteger(record.revision) || record.revision < 1 || (record.expectedSha256 !== undefined && !sha.test(record.expectedSha256))) throw fault('SOURCE_REGISTRY_INVALID', 'Source registry has unsupported records; inspect the private configuration.');
  return record;
}

export class SourceRegistry {
  constructor(root) { this.root = root; this.file = join(root, 'launcher-sources.json'); this.observationsRoot = join(root, 'source-observations'); this.receiptsRoot = join(root, 'source-receipts'); this.cacheRoot = join(root, 'source-cache'); this.records = []; this.queue = Promise.resolve(); }
  async initialize() {
    try {
      const state = await json(this.file);
      if (!closed(state, ['format', 'sources']) || state.format !== 'world-hub.launcher-sources/v1' || !Array.isArray(state.sources) || state.sources.length > 32) throw fault('SOURCE_REGISTRY_INVALID', 'Unsupported source registry.');
      const ids = new Set(), addresses = new Set();
      for (const row of state.sources) { validateRecord(row); const canonical = await canonicalSource(row.source); if (canonical !== row.source || ids.has(row.id) || addresses.has(keyOf(row.source))) throw fault('SOURCE_REGISTRY_INVALID', 'Source registry contains aliases or duplicate identities.'); ids.add(row.id); addresses.add(keyOf(row.source)); }
      this.records = state.sources;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  transaction(action) { const operation = this.queue.then(action); this.queue = operation.catch(() => {}); return operation; }
  async save(input) {
    if (!closed(input, ['id', 'name', 'source', 'enabled', 'priority', 'expectedSha256', 'allowPrivateNetwork', 'revision'])) throw fault('SOURCE_INPUT', 'Unsupported source configuration.', 400);
    return this.transaction(async () => {
      const previous = input.id ? this.records.find(row => row.id === input.id) : null;
      if (input.id && !previous) throw fault('SOURCE_NOT_FOUND', 'Unknown registered source.', 404);
      if (input.revision !== undefined && input.revision !== previous?.revision) throw fault('SOURCE_CHANGED', 'Source configuration was updated elsewhere. Reload it before editing.');
      const row = { id: previous?.id ?? 'source.' + randomUUID(), name: input.name, source: await canonicalSource(input.source),
        enabled: input.enabled ?? previous?.enabled ?? true, priority: input.priority ?? previous?.priority ?? 0,
        allowPrivateNetwork: input.allowPrivateNetwork ?? previous?.allowPrivateNetwork ?? false, revision: (previous?.revision ?? 0) + 1 };
      const pinned = Object.hasOwn(input, 'expectedSha256') ? input.expectedSha256 : previous?.expectedSha256;
      if (pinned) row.expectedSha256 = pinned;
      validateRecord(row);
      if (this.records.some(other => other.id !== row.id && keyOf(other.source) === keyOf(row.source))) throw fault('SOURCE_DUPLICATE', 'This index address is already registered; update that source instead.');
      if (!previous && this.records.length >= 32) throw fault('SOURCE_LIMIT', 'Launcher supports at most 32 registered sources.');
      const next = this.records.filter(other => other.id !== row.id).concat(row);
      await privateJson(this.file, { format: 'world-hub.launcher-sources/v1', sources: next }); this.records = next;
      return { source: { ...row }, startsModules: false };
    });
  }
  async delete(sourceId) {
    return this.transaction(async () => {
      if (!this.records.some(row => row.id === sourceId)) throw fault('SOURCE_NOT_FOUND', 'Unknown registered source.', 404);
      const next = this.records.filter(row => row.id !== sourceId);
      await privateJson(this.file, { format: 'world-hub.launcher-sources/v1', sources: next }); this.records = next;
      return { sourceId, removed: true, cachePreserved: true, instancesPreserved: true, startsModules: false };
    });
  }
  async resolve(input) {
    await this.queue;
    let row;
    if (input.sourceId !== undefined) {
      row = this.records.find(item => item.id === input.sourceId);
      if (!row) throw fault('SOURCE_NOT_FOUND', 'Unknown registered source.', 404);
      if (input.source !== undefined && keyOf(await canonicalSource(input.source)) !== keyOf(row.source)) throw fault('SOURCE_CHANGED', 'Source address differs from the registered choice.');
    } else {
      const source = await canonicalSource(input.source); row = this.records.find(item => keyOf(item.source) === keyOf(source));
      if (!row) return { source, allowPrivateNetwork: input.allowPrivateNetwork === true, expectedSha256: input.expectedSha256 };
    }
    if (!row.enabled) throw fault('SOURCE_DISABLED', 'This source is disabled. Enable it explicitly before inspecting or fetching.');
    if (input.allowPrivateNetwork !== undefined && input.allowPrivateNetwork !== row.allowPrivateNetwork) throw fault('SOURCE_POLICY_CHANGED', 'Use the registered source network policy.');
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== row.expectedSha256) throw fault('SOURCE_POLICY_CHANGED', 'Use the registered source index pin.');
    return { ...row, sourceId: row.id };
  }
  async assertCurrent(chosen) {
    await this.queue;
    if (!chosen.sourceId) {
      const registered = this.records.find(row => keyOf(row.source) === keyOf(chosen.source));
      if (registered && !registered.enabled) throw fault('SOURCE_DISABLED', 'This source was disabled while the operation was pending.');
      if (registered) throw fault('SOURCE_CHANGED', 'This source was registered while the operation was pending. Inspect its current configuration again.');
      return;
    }
    const current = this.records.find(row => row.id === chosen.sourceId);
    if (!current || !current.enabled) throw fault('SOURCE_DISABLED', 'This source was removed or disabled while the operation was pending.');
    if (current.revision !== chosen.revision) throw fault('SOURCE_CHANGED', 'Source configuration changed; inspect it again.');
  }
  async observation(row) {
    try {
      const value = await json(join(this.observationsRoot, row.id + '.json'), 16 * 1024 * 1024);
      if (value.format !== 'world-hub.source-observation/v1' || value.sourceId !== row.id || value.source !== row.source || value.networkPolicy !== networkPolicy(row.allowPrivateNetwork)) return null;
      const bytes = Buffer.from(value.indexBase64, 'base64'); if (bytes.length > 4 * 1024 * 1024 || hash(bytes) !== value.digest) throw fault('SOURCE_OBSERVATION_INVALID', 'Stored source observation hash mismatch.');
      const index = validateSourceIndex(JSON.parse(bytes.toString('utf8')), { allowPrivateNetwork: row.allowPrivateNetwork });
      if (!Array.isArray(value.withdrawn) || value.withdrawn.length > 4096) throw fault('SOURCE_OBSERVATION_INVALID', 'Invalid withdrawn-entry observations.');
      validateSourceIndex({ ...index, entries: value.withdrawn }, { allowPrivateNetwork: row.allowPrivateNetwork });
      return { ...value, index };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async observed(chosen, result) {
    if (!chosen.sourceId) return;
    await this.assertCurrent(chosen);
    return this.transaction(async () => {
      await this.assertCurrentWithoutQueue(chosen);
      const prior = await this.observation(chosen), present = new Set(result.index.entries.map(entry => entry.entryId));
      const withdrawn = new Map((prior?.withdrawn ?? []).map(entry => [entry.entryId, entry]));
      for (const entry of prior?.index.entries ?? []) if (!present.has(entry.entryId)) withdrawn.set(entry.entryId, entry);
      for (const entryId of present) withdrawn.delete(entryId);
      await ordinaryPath(this.observationsRoot, { allowMissing: true }); await mkdir(this.observationsRoot, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString();
      const value = { format: 'world-hub.source-observation/v1', sourceId: chosen.sourceId, source: chosen.source, digest: result.digest,
        networkPolicy: result.networkPolicy, indexBase64: result.indexBytes.toString('base64'), observedAt: stamp, checkedAt: stamp,
        unavailable: false, withdrawn: [...withdrawn.values()].slice(-4096) };
      await privateJson(join(this.observationsRoot, chosen.sourceId + '.json'), value);
    });
  }
  assertCurrentWithoutQueue(chosen) {
    const current = this.records.find(row => row.id === chosen.sourceId);
    if (!current || !current.enabled) throw fault('SOURCE_DISABLED', 'Source was removed or disabled.');
    if (current.revision !== chosen.revision) throw fault('SOURCE_CHANGED', 'Source configuration changed; inspect again.');
  }
  async unavailable(chosen) {
    if (!chosen.sourceId) return;
    await this.transaction(async () => {
      const row = this.records.find(item => item.id === chosen.sourceId); if (!row || row.revision !== chosen.revision) return;
      const previous = await this.observation(row); if (!previous) return;
      const { index, ...stored } = previous; stored.unavailable = true; stored.checkedAt = new Date().toISOString();
      await privateJson(join(this.observationsRoot, row.id + '.json'), stored);
    });
  }
  async list() {
    await this.queue; const sources = [], entries = [], identities = new Map(); let totalEntries = 0;
    for (const row of [...this.records].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
      const observation = await this.observation(row);
      sources.push({ ...row, observation: observation ? { digest: observation.digest, observedAt: observation.observedAt, checkedAt: observation.checkedAt,
        state: observation.unavailable ? 'unavailable' : 'observed', withdrawnCount: observation.withdrawn.length } : null });
      if (!observation) continue;
      for (const [state, group] of [['available', observation.index.entries], ['withdrawn', observation.withdrawn]]) for (const entry of group) {
        totalEntries++;
        if (entries.length >= 4096) continue;
        let cached = false; try { cached = (await lstat(await ordinaryPath(join(this.cacheRoot, `${entry.sha256}.artifact.json`)))).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const value = { ...entry, sourceId: row.id, sourceName: row.name, priority: row.priority, sourceEnabled: row.enabled, entryState: state,
          indexDigest: observation.digest, observedAt: observation.observedAt, sourceUnavailable: observation.unavailable, cached, cachedVerified: false };
        entries.push(value);
        if (state === 'available') { const key = `${entry.kind}:${entry.id}@${entry.version}`; const candidates = identities.get(key) ?? []; candidates.push(value); identities.set(key, candidates); }
      }
    }
    const conflicts = [...identities.values()].filter(group => new Set(group.map(entry => entry.sha256)).size > 1).map(group => ({
      kind: group[0].kind, id: group[0].id, version: group[0].version,
      candidates: group.map(entry => ({ sourceId: entry.sourceId, entryId: entry.entryId, sha256: entry.sha256, enabled: entry.sourceEnabled, priority: entry.priority })) }));
    return { sources, entries, conflicts, totalEntries, truncated: entries.length !== totalEntries, automaticSelection: false, startsModules: false };
  }
  async recordFetch(chosen, result) {
    await this.assertCurrent(chosen);
    const directory = await ordinaryPath(result.directory);
    const cache = await ordinaryPath(this.cacheRoot);
    if (!same(dirname(directory), cache) || basename(directory) !== result.entry.sha256) throw fault('SOURCE_RECEIPT_INVALID', 'Fetch result is outside the exact artifact cache.');
    const bytes = await readBounded(join(this.cacheRoot, `${result.entry.sha256}.artifact.json`), 96 * 1024 * 1024);
    if (hash(bytes) !== result.entry.sha256) throw fault('SOURCE_RECEIPT_INVALID', 'Fetched artifact archive changed.');
    const checked = validateArtifactBytes(bytes);
    await this.assertCurrent(chosen);
    const receipt = { format: 'world-hub.source-receipt/v1', receiptId: randomUUID(), sourceId: chosen.sourceId ?? null,
      source: chosen.source, indexDigest: result.indexDigest, artifactSha256: result.entry.sha256, entryId: result.entry.entryId,
      artifact: { kind: checked.artifact.kind, id: checked.artifact.id, version: checked.artifact.version },
      networkPolicy: result.networkPolicy, fetchedAt: new Date().toISOString(), integrityVerified: true,
      publisherIdentityVerified: false, codeSafetyVerified: false, executionAuthorized: false, sandbox: false };
    await ordinaryPath(this.receiptsRoot, { allowMissing: true }); await mkdir(join(this.receiptsRoot, 'by-digest'), { recursive: true, mode: 0o700 });
    await privateJson(join(this.receiptsRoot, `${receipt.receiptId}.json`), { format: 'world-hub.source-receipt-record/v1', receipt,
      files: checked.artifact.files.map(({ path, sha256 }) => ({ path, sha256 })) }, { exclusive: true });
    await privateJson(join(this.receiptsRoot, 'by-digest', `${receipt.artifactSha256}.json`), { receiptId: receipt.receiptId });
    return receipt;
  }
  async recognize(directory, reference) {
    const canonical = await ordinaryPath(directory); let receiptId = reference?.receiptId;
    if (!receiptId) {
      const cache = await ordinaryPath(this.cacheRoot, { allowMissing: true });
      if (!same(dirname(canonical), cache) || !sha.test(basename(canonical))) return null;
      try { receiptId = (await json(join(this.receiptsRoot, 'by-digest', basename(canonical) + '.json'))).receiptId; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    if (!uuid.test(receiptId)) throw fault('SOURCE_RECEIPT_INVALID', 'Invalid stored provenance receipt.');
    const stored = await json(join(this.receiptsRoot, receiptId + '.json'), 2 * 1024 * 1024);
    if (!closed(stored, ['format', 'receipt', 'files']) || stored.format !== 'world-hub.source-receipt-record/v1'
      || stored.receipt?.format !== 'world-hub.source-receipt/v1' || stored.receipt.receiptId !== receiptId || !sha.test(stored.receipt.artifactSha256)
      || !sha.test(stored.receipt.indexDigest) || !Array.isArray(stored.files) || stored.files.length > 8192) throw fault('SOURCE_RECEIPT_INVALID', 'Malformed stored provenance receipt.');
    const actual = await collectFiles(canonical);
    if (actual.length !== stored.files.length || actual.some(file => stored.files.find(entry => entry.path === file.path)?.sha256 !== file.sha256)) return null;
    return { ...stored.receipt, integrityVerified: true, publisherIdentityVerified: false, codeSafetyVerified: false, executionAuthorized: false, sandbox: false };
  }
}
