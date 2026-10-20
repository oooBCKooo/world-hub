// Run-scoped communication grants for externally owned programs. No processes
// are adopted, started or signalled; no private credential is persisted here.
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '../../scripts/runtime/paths.mjs';
import { safeId } from '../../scripts/runtime/package.mjs';
import { observedBridge } from './topology.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault('GLOBAL_EXTERNAL_INVALID', 'Unsupported external communication declaration.'); }
function contracts(value) {
  if (!Array.isArray(value) || value.length > 32) throw fault('GLOBAL_EXTERNAL_INVALID', 'Declare at most 32 exact capability contracts.');
  const seen = new Set();
  for (const row of value) {
    fields(row, ['id','version']);
    if (typeof row.id !== 'string' || !row.id || row.id.length > 128 || row.id.includes('\0') || typeof row.version !== 'string'
        || row.version.length > 128 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(row.version)
        || seen.has(JSON.stringify([row.id,row.version]))) throw fault('GLOBAL_EXTERNAL_INVALID', 'Capability contracts need distinct IDs and exact versions.');
    seen.add(JSON.stringify([row.id,row.version]));
  }
  return clone(value);
}
function topics(value) {
  if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length || value.some(topic => typeof topic !== 'string' || !topic || topic.length > 512 || /[\s\0#+]/.test(topic) || topic.split('/').some(part => !part)))
    throw fault('GLOBAL_EXTERNAL_INVALID', 'Explicitly select distinct concrete publish and subscribe topics; wildcard grants are not inferred.');
  return [...value];
}
function declaration(input) {
  safeId(input.programId, 'external program ID');
  if (input.programId.length > 48 || input.title !== undefined && (typeof input.title !== 'string' || !input.title || input.title.length > 256 || input.title.includes('\0'))
      || !Array.isArray(input.bridges) || !input.bridges.length || input.bridges.length > 8) throw fault('GLOBAL_EXTERNAL_INVALID', 'Choose an external program ID, optional title and one to eight bridge slots.');
  const slots = new Set(), bridges = input.bridges.map(row => {
    fields(row, ['slot','publish','subscribe']); safeId(row.slot, 'bridge slot');
    if (slots.has(row.slot)) throw fault('GLOBAL_EXTERNAL_INVALID', 'Bridge slots must be distinct.'); slots.add(row.slot);
    return { slot: row.slot, publish: topics(row.publish), subscribe: topics(row.subscribe) };
  });
  const provides = contracts(input.provides ?? []), requires = contracts(input.requires ?? []), bindings = input.bindings ?? [];
  if (!Array.isArray(bindings) || bindings.length > 32) throw fault('GLOBAL_EXTERNAL_INVALID', 'Declare at most 32 capability references.');
  const seen = new Set();
  for (const row of bindings) {
    fields(row, ['providerId','contract']); safeId(row.providerId, 'provider ID'); contracts([row.contract]);
    const key = JSON.stringify([row.providerId,row.contract.id,row.contract.version]);
    if (row.providerId === input.programId || seen.has(key) || !requires.some(required => required.id === row.contract.id && required.version === row.contract.version))
      throw fault('GLOBAL_EXTERNAL_INVALID', 'Capability references must be distinct declared requirements of another program.');
    seen.add(key);
  }
  const effectiveAllow = Object.fromEntries(['publish','subscribe'].map(direction => [direction, [...new Set(bridges.flatMap(row => row[direction]))]]));
  const row = { programId: input.programId, title: input.title ?? input.programId, principal: 'external.' + input.programId, bridges, provides, requires,
    bindings: clone(bindings), contractsVerified: false, effectiveAllow, ownership: 'external', process: 'unmanaged' };
  if (Buffer.byteLength(JSON.stringify(row)) > 128 * 1024) throw fault('GLOBAL_EXTERNAL_INVALID', 'External communication declaration exceeds 128 KiB.');
  return row;
}

export class GlobalExternalPrograms {
  constructor({ getHub, updateCredentials, managedPrincipals, isStopping = () => false }) {
    Object.assign(this, { getHub, updateCredentials, managedPrincipals, isStopping });
    this.handle = null; this.revision = 0; this.records = new Map(); this.reviews = new Map(); this.queue = Promise.resolve();
  }
  enqueue(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  current() {
    const candidate = this.getHub(), handle = candidate && !candidate.exit && candidate.url ? candidate : null;
    if (handle !== this.handle) { this.handle = handle; this.revision = 0; this.records.clear(); this.reviews.clear(); }
    return { handle, runId: handle?.launcherRunId ?? null };
  }
  assert(context) { const current = this.current(); if (!context.handle || current.handle !== context.handle || current.runId !== context.runId) throw fault('GLOBAL_EXTERNAL_STALE_RUN', 'The owned Hub run changed. Refresh its current external communication grants.'); }
  check(input, context) {
    this.assert(context);
    if (this.isStopping()) throw fault('GLOBAL_EXTERNAL_STOPPING', 'The owned Hub is stopping. Wait for its confirmed result before changing external communication grants.');
    if (input.expectedRunId !== context.runId || input.expectedRevision !== this.revision) throw fault('GLOBAL_EXTERNAL_CHANGED', 'The Hub run or external grant revision changed. Refresh and review again.');
  }
  async management(context, body) {
    this.assert(context);
    const request = async (path, input, token) => {
      const response = await fetch(new URL(path, context.handle.url), { method: input === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: input === undefined ? {} : { 'content-type': 'application/json', 'x-management-token': token }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      const chunks = []; let size = 0;
      for await (const bytes of response.body) { size += bytes.length; if (size > 4 * 1024 * 1024) throw fault('GLOBAL_EXTERNAL_OBSERVATION_LIMIT', 'Hub observation exceeded its bound.'); chunks.push(bytes); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); this.assert(context);
      if (!response.ok) throw fault('GLOBAL_EXTERNAL_OBSERVATION_FAILED', 'The owned Hub rejected the communication operation.');
      return value;
    };
    const snapshot = await request('/manage/api/state');
    if (!Array.isArray(snapshot.bridges) || snapshot.bridges.length > 4096) throw fault('GLOBAL_EXTERNAL_OBSERVATION_FAILED', 'No current Hub communication observation is available.');
    if (body !== undefined) return request('/manage/api/bridge', body, snapshot.csrfToken);
    return snapshot;
  }
  async inventoryNow() {
    const context = this.current(), empty = { runId: context.runId, revision: this.revision, observation: 'unavailable', scope: 'current-hub-run', programs: [], observedSessions: [], startsPrograms: false, adoptsProcesses: false };
    if (!context.handle || this.isStopping()) return empty;
    const snapshot = await this.management(context), managed = this.managedPrincipals(), grants = new Map(snapshot.bridges.map(row => [row.key, row]));
    const sessions = snapshot.bridges.filter(row => !managed.has(row.key)).flatMap(row => (row.instances ?? []).map(bridge => ({ ...observedBridge(bridge),
      connectionId: bridge.connectionId, effectiveAllow: clone(row.allow ?? { publish: [], subscribe: [] }), paused: row.paused === true, ownership: 'external', process: 'unmanaged' })));
    const programs = [...this.records.values()].map(row => ({ ...clone(row), effectiveAllow: clone(grants.get(row.principal)?.allow ?? { publish: [], subscribe: [] }),
      communication: sessions.some(session => session.principal === row.principal) ? 'connected' : 'disconnected', connections: sessions.filter(session => session.principal === row.principal) }));
    const issued = new Set([...this.records.values()].map(row => row.principal));
    return { ...empty, observation: 'live', programs, observedSessions: sessions.filter(session => !issued.has(session.principal)), observedAt: new Date().toISOString() };
  }
  inventory() { return this.enqueue(() => this.inventoryNow()); }
  async prepare(input, context) {
    this.check(input, context);
    if (input.action === 'admit') {
      fields(input, ['action','expectedRunId','expectedRevision','programId','title','bridges','provides','requires','bindings']);
      const row = declaration(input);
      if (this.records.has(row.programId)) throw fault('GLOBAL_EXTERNAL_EXISTS', 'Revoke the existing external grant before issuing a new one.');
      if (this.records.size >= 128) throw fault('GLOBAL_EXTERNAL_LIMIT', 'At most 128 run-scoped external grants are supported.');
      const snapshot = await this.management(context);
      if (snapshot.bridges.some(bridge => bridge.key === row.principal)) throw fault('GLOBAL_EXTERNAL_EXISTS', 'This communication principal is already present; choose a different external ID.');
      return { action: input.action, program: row };
    }
    if (input.action === 'revoke') {
      fields(input, ['action','expectedRunId','expectedRevision','programId']); safeId(input.programId);
      const row = this.records.get(input.programId); if (!row) throw fault('GLOBAL_EXTERNAL_NOT_FOUND', 'This Hub run has no such issued external grant.');
      return { action: input.action, program: clone(row) };
    }
    if (input.action === 'disconnect') {
      fields(input, ['action','expectedRunId','expectedRevision','principal','connectionIds']); safeId(input.principal, 'communication principal');
      if (this.managedPrincipals().has(input.principal)) throw fault('GLOBAL_EXTERNAL_MANAGED', 'Use the managed program controls for this communication principal.');
      if (!Array.isArray(input.connectionIds) || !input.connectionIds.length || input.connectionIds.length > 128 || new Set(input.connectionIds).size !== input.connectionIds.length
          || input.connectionIds.some(id => typeof id !== 'string' || !id || id.length > 80)) throw fault('GLOBAL_EXTERNAL_INVALID', 'Select distinct current connection IDs.');
      const snapshot = await this.management(context), bridge = snapshot.bridges.find(row => row.key === input.principal);
      const connections = input.connectionIds.map(id => bridge?.instances?.find(row => row.connectionId === id));
      if (connections.some(row => !row || row.principal !== input.principal)) throw fault('GLOBAL_EXTERNAL_CONNECTION_CHANGED', 'A selected connection changed or belongs to another principal. Refresh its exact session.');
      return { action: input.action, principal: input.principal, connections: connections.map(row => ({ connectionId: row.connectionId, bridgeId: row.bridgeId, session: row.session, principal: row.principal })) };
    }
    throw fault('GLOBAL_EXTERNAL_INVALID', 'Choose admit, revoke or disconnect.');
  }
  preview(input) { return this.enqueue(async () => {
    const context = this.current(), prepared = await this.prepare(input, context); this.check(input, context);
    const reviewId = randomUUID(), review = { format: 'world-hub.global-external-review/v1', runId: context.runId, revision: this.revision,
      ...prepared, scope: 'current-hub-run', startsPrograms: false, adoptsProcesses: false, grantsExecution: false,
      credentialScope: 'principal-union-of-declared-slots', contractsVerified: false };
    this.reviews.set(reviewId, { context, input: clone(input), digest: hash(JSON.stringify(prepared)), createdAt: Date.now() });
    while (this.reviews.size > 32) this.reviews.delete(this.reviews.keys().next().value);
    return { reviewId, review, expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
  }); }
  apply({ reviewId, accepted }) { return this.enqueue(async () => {
    const saved = this.reviews.get(reviewId);
    if (accepted !== true || !saved || Date.now() - saved.createdAt > 10 * 60000) throw fault('GLOBAL_EXTERNAL_REVIEW_REQUIRED', 'Review and accept this exact current communication change.');
    const prepared = await this.prepare(saved.input, saved.context);
    if (hash(JSON.stringify(prepared)) !== saved.digest) throw fault('GLOBAL_EXTERNAL_CHANGED', 'The reviewed external communication state changed. Review it again.');
    this.reviews.delete(reviewId);
    const options = { transient: true, expectedHub: saved.context.handle };
    let connection;
    if (prepared.action === 'admit') {
      const row = prepared.program, token = randomBytes(32).toString('base64url');
      try { await this.updateCredentials({ credentials: { [row.principal]: { token, maxConnections: row.bridges.length, allow: row.effectiveAllow } }, remove: [] }, options); }
      catch (cause) {
        this.records.set(row.programId, { ...row, authorization: 'unknown' }); this.revision++;
        try { await this.updateCredentials({ credentials: {}, remove: [row.principal] }, options); this.records.delete(row.programId); }
        catch { throw fault('GLOBAL_EXTERNAL_CLEANUP_REQUIRED', 'External authorization confirmation failed. Revoke this retained uncertain grant; no process was adopted.'); }
        throw fault('GLOBAL_EXTERNAL_APPLY_FAILED', 'External authorization was not confirmed and its credential was removed. Review again.');
      }
      this.assert(saved.context); this.records.set(row.programId, row);
      const endpoint = new URL('/bridge', saved.context.handle.url).href.replace('http:', 'ws:');
      connection = { format: 'world-hub.global-external-connection/v1', runId: saved.context.runId, programId: row.programId, principal: row.principal, endpoint,
        bridges: row.bridges.map(bridge => ({ ...clone(bridge), endpoint, bridgeId: 'external.' + hash(row.programId + ':' + bridge.slot).slice(0, 40), credential: row.principal, principal: row.principal, token })) };
    } else if (prepared.action === 'revoke') {
      await this.updateCredentials({ credentials: {}, remove: [prepared.program.principal] }, options);
      this.assert(saved.context); this.records.delete(prepared.program.programId);
    } else {
      await this.management(saved.context, { key: prepared.principal, action: 'disconnect', connectionIds: prepared.connections.map(row => row.connectionId) });
    }
    this.revision++; this.reviews.clear();
    return { ok: true, action: prepared.action, runId: saved.context.runId, revision: this.revision, scope: 'current-hub-run',
      startsPrograms: false, adoptsProcesses: false, ...(connection ? { connection } : {}) };
  }); }
}
