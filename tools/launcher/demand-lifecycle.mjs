// This is an external local process supervisor, connected through an ordinary
// hub bridge. Hub Core only carries its own opaque request/response contract.
import { randomBytes, randomUUID } from 'node:crypto';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { hash } from '../../scripts/runtime/paths.mjs';
import { executionPolicy, executionPolicyRevision } from './execution-policy.mjs';

const protocol = 'world-hub.lifecycle/v1';
const fault = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const active = handle => !!handle && (!handle.exit || handle.cleanupIncomplete);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const diagnostic = issue => ({ code: typeof issue?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(issue.code) ? issue.code : 'LIFECYCLE_UNAVAILABLE', message: String(issue?.message ?? issue) });

export class DemandLifecycle {
  constructor(owner, { BridgeClass = Bridge, now = Date.now, leaseTtlMs = 30000, renewAfterMs = 10000, tickIntervalMs = 500, connectTimeoutMs = 10000 } = {}) {
    this.owner = owner; this.local = owner.localPrograms; this.BridgeClass = BridgeClass; this.now = now;
    this.leaseTtlMs = leaseTtlMs; this.renewAfterMs = renewAfterMs; this.connectTimeoutMs = connectTimeoutMs;
    const scope = hash(this.local.root).slice(0, 24);
    this.principal = `lifecycle.${scope}`; this.topic = `local/lifecycle/${scope}`; this.token = randomBytes(32).toString('base64url');
    this.bridge = null; this.connecting = null; this.available = false; this.closing = false; this.lastError = null; this.activated = false;
    this.leases = new Map(); this.programStates = new Map(); this.requests = new Map(); this.controllers = new Set(); this.inflight = 0; this.requestFloor = 0; this.retryAt = 0; this.ticking = false;
    this.local.lifecycleDescriptor = () => this.descriptor();
    this.local.lifecycleStarted = (id, info) => this.started(id, info);
    this.local.lifecycleStopped = (id, info) => this.stopped(id, info);
    this.timer = setInterval(() => { void this.tick().catch(issue => { this.lastError = this.describe(issue); }); }, tickIntervalMs); this.timer.unref?.();
  }
  describe(issue) {
    const error = diagnostic(issue);
    const secrets = [this.token, ...[...this.local.identities.values()].map(identity => identity.token), ...this.leases.keys()].filter(value => typeof value === 'string' && value.length > 0);
    for (const secret of secrets) { error.message = error.message.replaceAll(secret, '[redacted]'); error.code = error.code.replaceAll(secret, 'REDACTED'); }
    error.message = error.message.slice(0, 1024);
    return error;
  }
  enabled() { return [...this.local.records.values()].some(row => executionPolicy(row).mode === 'on-demand'); }
  descriptor() { return this.enabled() ? { protocol, principal: this.principal, topic: this.topic } : null; }
  program(id) {
    if (!this.programStates.has(id)) this.programStates.set(id, { auto: null, pinned: false, idleSince: null, lastError: null });
    return this.programStates.get(id);
  }
  async connect() {
    if (this.closing) throw fault('LIFECYCLE_CLOSED', 'The local lifecycle supervisor is stopping.');
    if (!this.enabled()) return this.state();
    this.activated = true;
    if (this.available && this.bridge?.connected) return this.state();
    if (this.connecting) return this.connecting;
    this.connecting = this.connectNow().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async connectNow() {
    // An established Bridge restores this same subscription after reconnect.
    // Never add another subscription with a historical starting cursor.
    if (this.bridge) { await this.bridge.close('lifecycle connection retry'); this.bridge = null; }
    let bridge, timeout;
    try {
      await this.owner.updateCredentials({ credentials: { [this.principal]: { token: this.token, maxConnections: 1,
        allow: { publish: [this.topic], subscribe: [this.topic] } } }, remove: [] });
      if (this.closing) throw fault('LIFECYCLE_CLOSED', 'The local lifecycle supervisor is stopping.');
      const connection = this.owner.connection();
      bridge = new this.BridgeClass({ url: connection.endpoint, bridgeId: this.principal, credential: this.principal, token: this.token, autoAck: false });
      this.bridge = bridge;
      // One slow cold start must not hold the subscription callback chain and
      // prevent already-running work from renewing its lease. Consumption is
      // explicitly acknowledged after the individual response is accepted.
      bridge.on('delivery', message => { void this.deliver(message, bridge).catch(issue => { this.lastError = this.describe(issue); }); });
      bridge.on('close', () => { if (this.bridge === bridge) this.available = false; });
      bridge.on('open', () => { if (this.bridge === bridge && bridge.subscriptions?.length) this.available = true; });
      bridge.on('error', issue => { if (this.bridge === bridge) this.lastError = this.describe(issue); });
      const ready = async () => {
        const welcome = await bridge.connect();
        if (welcome.authenticated !== true || welcome.principal !== this.principal) throw fault('LIFECYCLE_IDENTITY_INVALID', 'The lifecycle bridge did not authenticate as its registered principal.');
        await bridge.registerChannels([{ name: this.topic, publish: true, subscribe: true }]);
        await bridge.subscribe([this.topic], { operations: ['request'], from: 'now' });
      };
      await Promise.race([ready(), new Promise((_, reject) => { timeout = setTimeout(() => reject(fault('LIFECYCLE_UNAVAILABLE', 'The lifecycle bridge could not connect in time.')), this.connectTimeoutMs); timeout.unref?.(); })]);
      if (this.closing || this.bridge !== bridge) throw fault('LIFECYCLE_CLOSED', 'The local lifecycle supervisor is stopping.');
      this.available = true; this.lastError = null; return this.state();
    } catch (issue) {
      this.available = false; this.lastError = this.describe(issue); this.retryAt = this.now() + 5000;
      if (bridge) await bridge.close('lifecycle unavailable').catch(() => {});
      if (this.bridge === bridge) this.bridge = null;
      throw issue;
    } finally { clearTimeout(timeout); }
  }
  async deliver(message, bridge = this.bridge) {
    if (this.closing || message?.operation !== 'request' || message.topic !== this.topic || message.target?.principal !== this.principal) return;
    if (!Number.isSafeInteger(message.seq) || message.seq < 1) return;
    let task = this.requests.get(message.seq);
    if (!task) {
      if (message.seq <= this.requestFloor) task = Promise.resolve({ ok: false, error: this.describe(fault('LIFECYCLE_REQUEST_REPLAY', 'This old lifecycle request cannot be executed again.')) });
      else if (this.inflight >= 256) task = Promise.resolve({ ok: false, error: this.describe(fault('LIFECYCLE_CONTROL_LIMIT', 'Too many lifecycle control requests are already pending.')) });
      else {
        this.inflight++;
        task = this.command(message).then(value => ({ ok: true, ...value }), issue => ({ ok: false, error: this.describe(issue) })).finally(() => { this.inflight--; });
        this.requests.set(message.seq, task);
        task.finally(() => { while (this.requests.size > 512) { const [seq] = this.requests.keys(); this.requests.delete(seq); this.requestFloor = Math.max(this.requestFloor, seq); } }).catch(() => {});
      }
    }
    const result = await task;
    if (!this.closing && bridge === this.bridge && bridge?.connected) {
      const receipt = await bridge.respond(message, result); bridge.ack(message);
      // This adapter voluntarily allows cleanup of its own ephemeral control
      // responses. It never releases either party's application messages.
      if (Number.isSafeInteger(receipt?.seq)) await bridge.release([receipt.seq]).catch(issue => { this.lastError = this.describe(issue); });
    }
  }
  caller(message) {
    if (typeof message.fromPrincipal !== 'string') throw fault('LIFECYCLE_CALLER_DENIED', 'A registered authenticated local caller is required.');
    const row = [...this.local.records.values()].find(candidate => this.local.identities.get(candidate.programId)?.principal === message.fromPrincipal);
    if (!row || row.principal !== message.fromPrincipal) throw fault('LIFECYCLE_CALLER_DENIED', 'This principal does not identify a registered local instance.');
    return row.programId;
  }
  authorize(programId, callerId, expectedPrincipal, expectedToken) {
    const callerRow = this.local.records.get(callerId), callerIdentity = this.local.identities.get(callerId);
    if (!callerRow || !callerIdentity || callerRow.principal !== expectedPrincipal || callerIdentity.principal !== expectedPrincipal || callerIdentity.token !== expectedToken)
      throw fault('LIFECYCLE_CALLER_DENIED', 'The authenticated caller registration or identity changed before this operation could finish.');
    const row = this.local.records.get(programId);
    if (!row) throw fault('LIFECYCLE_TARGET_MISSING', 'The requested local module instance is not registered.');
    const policy = executionPolicy(row);
    if (policy.mode !== 'on-demand') throw fault('DEMAND_MODE_REQUIRED', 'Automatic activation is available only for modules configured as on-demand.');
    if (!policy.allowedCallers.includes(callerId)) throw fault('LIFECYCLE_TRIGGER_DENIED', 'This local module is not allowed to trigger the requested instance.');
    if (this.local.closing || this.local.startsPaused || this.closing) throw fault('LIFECYCLE_CLOSED', 'The local lifecycle supervisor is stopping.');
    return { row, policy };
  }
  async guard(programId, callerId, principal, token) {
    this.authorize(programId, callerId, principal, token);
    await this.local.assertVersionReady(callerId);
    this.authorize(programId, callerId, principal, token);
    await this.local.assertVersionReady(programId);
    return this.authorize(programId, callerId, principal, token);
  }
  async command(message) {
    const body = message.body, callerId = this.caller(message);
    if (!plain(body) || !['acquire', 'renew', 'release'].includes(body.action)) throw fault('LIFECYCLE_REQUEST_INVALID', 'Choose acquire, renew or release.');
    const fields = body.action === 'acquire' ? ['action', 'programId'] : body.action === 'renew' ? ['action', 'leaseId'] : ['action', 'leaseId', 'completed'];
    if (Object.keys(body).some(key => !fields.includes(key))) throw fault('LIFECYCLE_REQUEST_INVALID', 'Lifecycle requests contain only lifecycle control fields.');
    if (body.action === 'acquire') {
      if (typeof body.programId !== 'string') throw fault('LIFECYCLE_REQUEST_INVALID', 'A registered target instance ID is required.');
      return this.acquire(body.programId, callerId, message.fromPrincipal, this.local.identities.get(callerId)?.token);
    }
    if (typeof body.leaseId !== 'string' || body.action === 'release' && typeof body.completed !== 'boolean') throw fault('LIFECYCLE_REQUEST_INVALID', 'A lease ID and an explicit release completion result are required.');
    const updateLease = async () => {
      const lease = this.leases.get(body.leaseId);
      if (!lease || lease.callerId !== callerId || lease.principal !== message.fromPrincipal) throw fault('LIFECYCLE_LEASE_MISSING', 'This caller does not own the requested lease.');
      await this.guard(lease.programId, callerId, lease.principal, lease.callerToken);
      // The guard can await disk access; recheck authorization after it.
      this.authorize(lease.programId, callerId, lease.principal, lease.callerToken); this.expire();
      if (this.leases.get(body.leaseId) !== lease || this.local.handles.get(lease.programId) !== lease.handle || this.local.records.get(lease.programId)?.runId !== lease.runId)
        throw fault('LIFECYCLE_LEASE_MISSING', 'The owned run changed or was explicitly stopped while this lease was being checked.');
      if (body.action === 'renew') {
        if (lease.uncertain) throw fault('LIFECYCLE_LEASE_UNCERTAIN', 'The lease expired or its outcome is uncertain. Explicitly complete it or stop the module manually.');
        lease.expiresAt = this.now() + this.leaseTtlMs; return this.receipt(lease);
      }
      if (body.completed === true) { this.leases.delete(lease.id); this.beginIdle(lease.programId); return { released: true, completed: true, programId: lease.programId }; }
      lease.uncertain = true; lease.pending = false; this.program(lease.programId).idleSince = null;
      return { released: false, completed: false, uncertain: true, programId: lease.programId };
    };
    // These operations change only in-memory lease metadata. Process starts,
    // dependency preparation and idle stops retain the local process queue.
    return updateLease();
  }
  async acquire(programId, callerId, callerPrincipal, callerToken) {
    this.authorize(programId, callerId, callerPrincipal, callerToken);
    const all = [...this.leases.values()];
    if (all.length >= 128 || all.filter(row => row.callerId === callerId).length >= 32 || all.filter(row => row.programId === programId).length >= 32)
      throw fault('LIFECYCLE_LEASE_LIMIT', 'The local lifecycle lease limit has been reached. Resolve outstanding or uncertain calls first.');
    // Reserve before waiting for the shared process queue. A pending activation
    // protects this target from an idle-stop decision already waiting for it.
    const lease = { id: randomUUID(), programId, callerId, principal: callerPrincipal, callerToken,
      pending: true, uncertain: false, expiresAt: null, runId: null, handle: null };
    this.leases.set(lease.id, lease); this.program(programId).idleSince = null;
    try {
      return await this.local.enqueue(async () => {
        if (this.leases.get(lease.id) !== lease) throw fault('LIFECYCLE_ACTIVATION_CANCELLED', 'This activation was cancelled by an explicit stop. Submit a new call only after checking its outcome.');
        const { row } = await this.guard(programId, callerId, callerPrincipal, callerToken);
        const policyRevision = executionPolicyRevision(row);
        const handle = this.local.handles.get(programId);
        if (row.state === 'unknown' || row.state === 'running' && !active(handle)) throw fault('LOCAL_PROCESS_OWNERSHIP_UNKNOWN', 'A confirmed owned local process is required. No saved or foreign PID will be adopted.');
        const reviewed = await this.local.reviewStart(programId);
        if (!active(handle)) {
          this.authorize(programId, callerId, callerPrincipal, callerToken);
          if (executionPolicyRevision(this.local.records.get(programId)) !== policyRevision) { this.local.reviews?.delete(reviewed.reviewId); throw fault('LIFECYCLE_POLICY_CHANGED', 'The trigger policy changed while activation was being reviewed.'); }
          const controller = new AbortController(); this.controllers.add(controller); this.local.startControllers?.add(controller);
          try { await this.local.startNow(programId, { reviewId: reviewed.reviewId, accepted: true, startReason: 'demand', signal: controller.signal }); }
          finally { this.controllers.delete(controller); this.local.startControllers?.delete(controller); }
        } else this.local.reviews?.delete(reviewed.reviewId);
        await this.guard(programId, callerId, callerPrincipal, callerToken);
        const readyRow = this.local.records.get(programId), readyHandle = this.local.handles.get(programId);
        if (readyRow?.state !== 'running' || !active(readyHandle) || readyHandle.cleanupIncomplete || readyHandle.stopping)
          throw fault('LIFECYCLE_TARGET_NOT_READY', 'The requested module does not have a ready owned process.');
        if (executionPolicyRevision(readyRow) !== policyRevision) throw fault('LIFECYCLE_POLICY_CHANGED', 'The trigger policy changed while the requested instance started.');
        lease.pending = false; lease.expiresAt = this.now() + this.leaseTtlMs; lease.runId = readyRow.runId; lease.handle = readyHandle;
        return this.receipt(lease);
      });
    } catch (issue) { this.leases.delete(lease.id); const state = this.program(programId); state.lastError = this.describe(issue); this.beginIdle(programId); throw issue; }
  }
  receipt(lease) { return { leaseId: lease.id, leaseTtlMs: this.leaseTtlMs, renewAfterMs: this.renewAfterMs,
    programId: lease.programId, target: { principal: this.local.identities.get(lease.programId)?.principal } }; }
  started(id, { reason, handle, runId } = {}) {
    const state = this.program(id);
    if (reason === 'demand') { state.auto = { handle, runId }; state.pinned = false; }
    else { state.auto = null; state.pinned = true; }
    state.lastError = null; state.idleSince = null; this.beginIdle(id);
  }
  stopped(id, { handle, runId } = {}) {
    const state = this.program(id);
    // A manual stop explicitly resolves uncertainty for the stopped run. A
    // later process with the same instance ID never inherits the old leases.
    for (const [leaseId, lease] of this.leases) if (lease.programId === id && (lease.pending || lease.handle === handle || lease.runId === runId)) this.leases.delete(leaseId);
    state.auto = null; state.pinned = false; state.idleSince = null;
  }
  beginIdle(id) { const state = this.program(id); if (state.auto && ![...this.leases.values()].some(lease => lease.programId === id) && state.idleSince === null) state.idleSince = this.now(); }
  expire() { for (const lease of this.leases.values()) if (!lease.pending && !lease.uncertain && lease.expiresAt <= this.now()) { lease.uncertain = true; this.program(lease.programId).idleSince = null; } }
  state(id) {
    this.expire();
    const programs = [...this.local.records.values()].filter(row => id === undefined || row.programId === id).map(row => {
      const state = this.program(row.programId), leases = [...this.leases.values()].filter(lease => lease.programId === row.programId), policy = executionPolicy(row);
      const autoStarted = !!state.auto && state.auto.handle === this.local.handles.get(row.programId) && state.auto.runId === row.runId && active(state.auto.handle);
      return { programId: row.programId, autoStarted, pinned: state.pinned && active(this.local.handles.get(row.programId)),
        activeLeaseCount: leases.filter(lease => !lease.uncertain).length, uncertainLeaseCount: leases.filter(lease => lease.uncertain).length,
        idleSince: state.idleSince === null ? null : new Date(state.idleSince).toISOString(),
        idleStopAt: autoStarted && policy.mode === 'on-demand' && state.idleSince !== null && leases.length === 0 ? new Date(state.idleSince + policy.idleTimeoutMs).toISOString() : null,
        ...(state.lastError ? { lastError: state.lastError } : {}) };
    });
    return { enabled: this.enabled(), available: this.available && this.bridge?.connected === true, programs, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
  async tick() {
    if (this.closing || this.ticking) return; this.ticking = true;
    try {
      this.expire();
      if (!this.available || !this.bridge?.connected) {
        if (this.activated && !this.connecting && this.enabled() && this.now() >= this.retryAt) { this.retryAt = this.now() + 5000; void this.connect().catch(() => {}); }
        return;
      }
      for (const [id, state] of this.programStates) {
        const row = this.local.records.get(id);
        if (!row || !state.auto || executionPolicy(row).mode !== 'on-demand' || state.idleSince === null || this.now() - state.idleSince < executionPolicy(row).idleTimeoutMs) continue;
        await this.local.enqueue(async () => {
          const ownership = state.auto;
          const eligible = () => {
            const current = this.local.records.get(id);
            return !this.closing && this.available && this.bridge?.connected === true && !!current && !!ownership && state.auto === ownership && executionPolicy(current).mode === 'on-demand' && state.idleSince !== null
              && this.now() - state.idleSince >= executionPolicy(current).idleTimeoutMs && ![...this.leases.values()].some(lease => lease.programId === id)
              && this.local.handles.get(id) === ownership.handle && current.runId === ownership.runId && current.state === 'running' && active(ownership.handle) && !ownership.handle.cleanupIncomplete && !ownership.handle.stopping;
          };
          if (!eligible()) return;
          try { await this.local.assertVersionReady(id); if (!eligible()) return;
            await this.local.stopNow(id);
          } catch (issue) { state.lastError = this.describe(issue); }
        });
      }
    } finally { this.ticking = false; }
  }
  async close() {
    this.closing = true; this.available = false; clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    if (this.bridge) await this.bridge.close('local lifecycle stopped').catch(() => {});
    // A currently completing connect must not reintroduce a credential later.
    await this.connecting?.catch(() => {});
    await this.owner.updateCredentials({ credentials: {}, remove: [this.principal] });
    this.bridge = null;
  }
}
