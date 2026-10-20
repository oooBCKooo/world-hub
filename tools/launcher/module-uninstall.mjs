// Registration transactions belong to deployment management. Source, identity,
// version history and application state remain on disk; the shared Hub stays up.
import { randomUUID } from 'node:crypto';
import { hash } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { safeId } from '../../scripts/runtime/package.mjs';
import { normalizeModuleGroup } from './module-groups.mjs';
import { publicStartupPlan } from './startup-plan.mjs';

const clone = value => structuredClone(value);
const fault = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 409, ...details });
const active = handle => Boolean(handle && (!handle.exit || handle.cleanupIncomplete));
const liveStates = new Set(['running', 'starting', 'stopping', 'unknown']);
const processKeys = new Set(['state', 'communication', 'entryUrl', 'stoppedAt', 'error']);
function planWithout(plan, removed, ids) {
  return publicStartupPlan({ ...plan, members: plan.members.filter(row => !removed.has(row.programId))
    .map(row => ({ ...row, after: row.after.filter(id => !removed.has(id)) })),
  ...(Object.hasOwn(plan, 'startupOrder') ? { startupOrder: plan.startupOrder.filter(id => !removed.has(id)) } : {}) }, ids);
}

export class ModuleUninstall {
  constructor(owner) { this.owner = owner; this.local = owner.localPrograms; this.reviews = new Map(); }
  target(kind, id) {
    safeId(id, 'uninstall target');
    if (kind === 'module') return { ids: [this.local.row(id).programId] };
    if (kind !== 'module-group') throw fault('UNINSTALL_KIND_INVALID', 'Choose a module or module group.');
    const group = this.local.groups.get(id);
    if (!group) throw fault('MODULE_GROUP_NOT_FOUND', 'Unknown module group.');
    return { ids: [...group.memberProgramIds], group };
  }
  async snapshot(selected, { masked = false } = {}) {
    const local = this.local, records = [];
    for (const [id, row] of local.records) {
      const value = clone(row);
      delete value.communicationObservedAt;
      if (masked && selected.has(id)) for (const key of processKeys) delete value[key];
      records.push([id, value]);
    }
    const source = [];
    for (const id of selected) {
      let files;
      try { files = await collectSourceFiles(local.path(id, 'module')); }
      catch (issue) { files = { unavailable: true, code: String(issue.code ?? 'SOURCE_UNAVAILABLE') }; }
      source.push([id, files]);
    }
    return hash(JSON.stringify({ records, source, identities: [...local.identities], groups: [...local.groups],
      plan: local.startupPlanData, handles: [...local.handles].map(([id, handle]) => [id, { pid: handle.pid ?? null,
        ...(masked && selected.has(id) ? {} : { exit: handle.exit ?? null, cleanupIncomplete: Boolean(handle.cleanupIncomplete), stopping: Boolean(handle.stopping) }) }]) }));
  }
  async build(kind, id, input = {}) {
    const local = this.local;
    if (local.closing) throw fault('LAUNCHER_STOPPING', 'Local module management is stopping.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'programIds'))
      throw fault('UNINSTALL_SELECTION_INVALID', 'Choose only module instance IDs from the displayed target.');
    const target = this.target(kind, id), explicit = input.programIds !== undefined;
    if (explicit && (!Array.isArray(input.programIds) || new Set(input.programIds).size !== input.programIds.length
        || input.programIds.some(programId => !target.ids.includes(programId)) || kind === 'module' && (input.programIds.length !== 1 || input.programIds[0] !== id)))
      throw fault('UNINSTALL_SELECTION_INVALID', 'Choose distinct module instance IDs belonging to this target.');
    const selected = new Set(explicit ? input.programIds : target.ids);
    const groupsFor = programId => [...local.groups.values()].filter(group => group.memberProgramIds.includes(programId));
    const consumersFor = programId => [...local.records.values()].filter(row => row.programId !== programId && row.bindings.some(binding => binding.providerId === programId));
    // Default group removal preserves shared members and every provider needed
    // by a retained consumer, including transitive dependency chains and cycles.
    if (kind === 'module-group' && !explicit) {
      for (const programId of selected) if (groupsFor(programId).some(group => group.id !== id)) selected.delete(programId);
      let changed;
      do {
        changed = false;
        for (const programId of selected) if (consumersFor(programId).some(row => !selected.has(row.programId))) { selected.delete(programId); changed = true; }
      } while (changed);
    }
    const blockers = [], add = (code, message, extra = {}) => ({ code, message, ...extra });
    const programs = target.ids.map(programId => {
      const row = local.row(programId), handle = local.handles.get(programId), chosen = selected.has(programId);
      const groups = groupsFor(programId).map(group => ({ id: group.id, title: group.title }));
      const consumers = consumersFor(programId).map(consumer => ({ programId: consumer.programId, module: clone(consumer.module), state: consumer.state,
        selected: selected.has(consumer.programId), contracts: clone(consumer.bindings.filter(binding => binding.providerId === programId).map(binding => binding.contract)) }));
      const issues = [];
      if (kind === 'module-group' && groups.some(group => group.id !== id)) issues.push(add('UNINSTALL_SHARED_MEMBER', 'This instance belongs to another module group.', { programId }));
      if (consumers.some(consumer => !consumer.selected)) issues.push(add('UNINSTALL_PROVIDER_IN_USE', 'A retained module still binds this capability provider.', { programId, consumerIds: consumers.filter(consumer => !consumer.selected).map(consumer => consumer.programId) }));
      if (row.state === 'unknown' && !handle || liveStates.has(row.state) && !handle)
        issues.push(add('LOCAL_PROCESS_OWNERSHIP_UNKNOWN', 'There is no current owned process handle. No recorded or foreign PID will be signalled.', { programId }));
      if (handle?.cleanupIncomplete) issues.push(add('CLEANUP_INCOMPLETE', 'Owned process cleanup is incomplete. Confirm its exit before uninstalling.', { programId }));
      if (chosen) blockers.push(...issues);
      return { programId, module: clone(row.module), state: row.state, selected: chosen, canRemove: issues.length === 0,
        ownsProcess: active(handle), groups, consumers, blockers: issues };
    });
    const remainingIds = [...local.records.keys()].filter(programId => !selected.has(programId)), groupsChanged = [];
    for (const group of local.groups.values()) {
      const removedProgramIds = group.memberProgramIds.filter(programId => selected.has(programId));
      if (kind === 'module-group' && group.id === id) groupsChanged.push({ id: group.id, title: group.title, previousRevision: group.revision, removed: true,
        removedProgramIds, memberProgramIds: [], startupPlan: null });
      else if (removedProgramIds.length) {
        const ids = group.memberProgramIds.filter(programId => !selected.has(programId)), startupPlan = planWithout(group.startupPlan, selected, ids);
        groupsChanged.push({ id: group.id, title: group.title, previousRevision: group.revision, removed: false, removedProgramIds, memberProgramIds: ids, startupPlan });
      }
    }
    const guarded = new Set([...selected, ...groupsChanged.flatMap(group => local.groups.get(group.id).memberProgramIds)]);
    for (const programId of guarded) try { await local.assertVersionReady(programId); }
    catch (issue) { blockers.push(add(issue.code ?? 'VERSION_RECOVERY_REQUIRED', 'Recover the interrupted version operation before uninstalling or changing this instance.', { programId })); }
    for (const group of groupsChanged) try { await local.versionGroupRecoveryGuard?.(group.id); }
    catch (issue) { blockers.push(add(issue.code ?? 'VERSION_RECOVERY_REQUIRED', 'Recover the interrupted group version operation before changing this group.', { groupId: group.id })); }
    const globalPlan = local.getStartupPlan();
    const startupReferences = [{ scope: 'local-hub', plan: globalPlan }, ...[...local.groups.values()].map(group => ({ scope: 'module-group', groupId: group.id, plan: group.startupPlan }))]
      .flatMap(scope => scope.plan.members.filter(row => selected.has(row.programId) || row.after.some(programId => selected.has(programId)))
        .map(row => ({ scope: scope.scope, ...(scope.groupId ? { groupId: scope.groupId } : {}), programId: row.programId,
          removed: selected.has(row.programId), removedAfter: row.after.filter(programId => selected.has(programId)) })));
    const requiresStop = programs.filter(row => row.selected && row.ownsProcess).map(row => row.programId);
    // Consumers stop before providers where possible. Capability cycles are
    // supported because every selected registration is removed in one commit.
    const stopOrder = [], pending = new Set(selected);
    while (pending.size) {
      const next = [...pending].find(programId => !consumersFor(programId).some(row => pending.has(row.programId))) ?? pending.values().next().value;
      stopOrder.push(next); pending.delete(next);
    }
    const review = { format: 'world-hub.module-uninstall-review/v1', kind, targetId: id, programs,
      programIds: [...selected], retainedPrograms: programs.filter(row => !row.selected), groupsChanged, startupReferences,
      startupPlan: planWithout(globalPlan, selected, remainingIds), requiresStop, stopOrder,
      retainedDirectories: [...selected].map(programId => ({ programId, directory: local.path(programId) })),
      blocked: blockers.length > 0, blockers, stopsHub: false, retainsFiles: true };
    const snapshot = await this.snapshot(selected), maskedSnapshot = await this.snapshot(selected, { masked: true });
    review.digest = hash(JSON.stringify({ review, snapshot }));
    return { review, selected, snapshot, maskedSnapshot, handles: new Map(local.handles), input: clone(input) };
  }
  preview(kind, id, input = {}) { return this.local.enqueue(async () => {
    const saved = await this.build(kind, id, input), reviewId = randomUUID(), createdAt = Date.now();
    this.reviews.set(reviewId, { ...saved, createdAt });
    while (this.reviews.size > 32) this.reviews.delete(this.reviews.keys().next().value);
    return { reviewId, review: clone(saved.review), expiresAt: new Date(createdAt + 600000).toISOString() };
  }); }
  apply(kind, id, input = {}) { return this.local.enqueue(async () => {
    if (input.accepted !== true) throw fault('TRUST_REQUIRED', 'Accept the displayed uninstall scope, retained files and affected groups.');
    const saved = this.reviews.get(input.reviewId);
    if (!saved || saved.review.kind !== kind || saved.review.targetId !== id || Date.now() - saved.createdAt > 600000)
      throw fault('UNINSTALL_REVIEW_REQUIRED', 'Review the current uninstall scope before applying it.');
    const local = this.local, fresh = await this.build(kind, id, saved.input);
    if (fresh.review.digest !== saved.review.digest || [...saved.handles].some(([programId, handle]) => local.handles.get(programId) !== handle))
      throw fault('UNINSTALL_REVIEW_CHANGED', 'Module source, identities, running processes, wiring or groups changed. Review uninstall again.');
    if (fresh.review.blocked) throw fault('UNINSTALL_BLOCKED', 'Resolve the displayed uninstall blockers before removing registrations.', { blockers: clone(fresh.review.blockers) });
    if (fresh.review.requiresStop.length && input.stopOwned !== true)
      throw fault('UNINSTALL_STOP_REQUIRED', 'Accept stopping only the selected owned module processes before uninstalling them.', { programIds: fresh.review.requiresStop });
    this.reviews.delete(input.reviewId);
    const stoppedProgramIds = [];
    try {
      for (const programId of fresh.review.stopOrder.filter(programId => fresh.review.requiresStop.includes(programId))) {
        await local.stopNow(programId); stoppedProgramIds.push(programId);
      }
    } catch (issue) {
      throw fault('UNINSTALL_STOP_FAILED', 'A selected owned module could not be confirmed stopped. All registrations are retained; processes already stopped remain stopped.',
        { causeCode: issue.code ?? 'LOCAL_STOP_FAILED', stoppedProgramIds, registrationsRetained: true });
    }
    const stoppedValid = () => fresh.review.requiresStop.every(programId => {
      const row = local.records.get(programId), handle = local.handles.get(programId);
      return row?.state === 'stopped' && handle === saved.handles.get(programId) && handle?.exit && !handle.cleanupIncomplete;
    });
    const selectedSafe = () => [...saved.selected].every(programId => {
      const row = local.records.get(programId);
      return row && !liveStates.has(row.state) && !active(local.handles.get(programId));
    });
    const unchanged = async () => await this.snapshot(saved.selected, { masked: true }) === saved.maskedSnapshot
      && stoppedValid() && selectedSafe() && [...saved.handles].every(([programId, handle]) => local.handles.get(programId) === handle);
    if (!await unchanged()) throw fault('UNINSTALL_REVIEW_CHANGED', 'The installation changed while stopping selected modules. Registrations remain; review uninstall again.', { stoppedProgramIds, registrationsRetained: true });
    const principals = fresh.review.programIds.map(programId => local.row(programId).principal);
    if (principals.length) try { await local.updateCredentials({ credentials: {}, annotations: {}, remove: principals }, {}); }
    catch (issue) {
      throw fault('UNINSTALL_CREDENTIALS_FAILED', 'Credential revocation could not be confirmed. Registrations and files remain. Recheck module connections before retrying.',
        { causeCode: issue.code ?? 'CREDENTIALS_UPDATE_FAILED', stoppedProgramIds, registrationsRetained: true, credentialsMayBeRevoked: true });
    }
    if (!await unchanged()) throw fault('UNINSTALL_REVIEW_CHANGED', 'The installation changed during credential revocation. Registrations remain and selected credentials may be revoked.',
      { stoppedProgramIds, registrationsRetained: true, credentialsMayBeRevoked: principals.length > 0 });
    // Capture after stops: rollback never claims to restart an exited process.
    const previous = { records: new Map(local.records), identities: new Map(local.identities), handles: new Map(local.handles),
      groups: new Map(local.groups), startupPlanData: local.startupPlanData };
    try {
      for (const programId of fresh.review.programIds) { local.records.delete(programId); local.identities.delete(programId); local.handles.delete(programId); }
      for (const changed of fresh.review.groupsChanged) {
        if (changed.removed) local.groups.delete(changed.id);
        else local.groups.set(changed.id, normalizeModuleGroup({ ...previous.groups.get(changed.id), memberProgramIds: changed.memberProgramIds,
          startupPlan: changed.startupPlan }, [...local.records.keys()]));
      }
      local.startupPlanData = fresh.review.startupPlan;
      await local.save();
    }
    catch (issue) {
      for (const key of ['records', 'identities', 'handles', 'groups']) { local[key].clear(); for (const [keyId, value] of previous[key]) local[key].set(keyId, value); }
      local.startupPlanData = previous.startupPlanData;
      throw fault('UNINSTALL_SAVE_FAILED', 'Registry save failed. All registrations and group plans were restored; stopped processes remain stopped and selected credentials remain revoked.',
        { causeCode: issue.code ?? 'REGISTRY_WRITE_FAILED', stoppedProgramIds, registrationsRetained: true, credentialsRevoked: principals.length > 0 });
    }
    for (const programId of fresh.review.programIds) { clearInterval(local.monitors.get(programId)); local.monitors.delete(programId); }
    return { kind, targetId: id, removed: true, programIds: [...fresh.review.programIds], removedProgramIds: [...fresh.review.programIds],
      retainedPrograms: clone(fresh.review.retainedPrograms), groupsChanged: clone(fresh.review.groupsChanged), stoppedProgramIds,
      retainedDirectories: clone(fresh.review.retainedDirectories), retainsFiles: true, stopsHub: false, credentialsRevoked: principals.length > 0 };
  }); }
}
