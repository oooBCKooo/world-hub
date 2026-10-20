// A Launcher group contains references and an operation plan. The shared Hub
// neither reads these records nor owns processes on behalf of a group.
import { safeId } from '../../scripts/runtime/package.mjs';
import { hash } from '../../scripts/runtime/paths.mjs';
import { STARTUP_PLAN_FORMAT, publicStartupPlan, startupPlan } from './startup-plan.mjs';
import { configurationRevision } from './program-configuration.mjs';
import { validateModuleGroup } from '../../scripts/runtime/module-group.mjs';

export const MODULE_GROUP_FORMAT = 'world-hub.launcher-module-group/v1';
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fault = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
export const GROUP_WIRING_BASELINE_FORMAT = 'world-hub.group-wiring-baseline/v1';
// Keep only the author's communication recipe. Settings, process plans and
// private instance state never belong to a wiring reset.
export function moduleGroupWiringBaseline(manifest) {
  return { format: GROUP_WIRING_BASELINE_FORMAT, id: manifest.id, version: manifest.version,
    members: manifest.modules.map(member => ({ id: member.id, moduleId: member.module?.id ?? member.moduleId, version: member.module?.version ?? member.version,
      topics: clone(member.configuration.topics), bridges: clone(member.configuration.bridges), bindings: clone(member.configuration.bindings) })) };
}
function checkedWiringBaseline(input, origin) {
  if (!plain(input) || Object.keys(input).some(key => !['format', 'id', 'version', 'members'].includes(key))
      || input.format !== GROUP_WIRING_BASELINE_FORMAT || !origin || input.id !== origin.id || input.version !== origin.version
      || !Array.isArray(input.members) || input.members.some(member => !plain(member)
        || Object.keys(member).some(key => !['id', 'moduleId', 'version', 'topics', 'bridges', 'bindings'].includes(key))
        || !Object.hasOwn(origin.members, member.id))) throw fault('MODULE_GROUP_BASELINE_INVALID', 'The author wiring baseline must match the exact group source and logical members.');
  try {
    validateModuleGroup({ format: 'world-hub.module-group/v1', id: input.id, version: input.version, title: input.id, license: 'MIT',
      platforms: ['linux-x64'], provides: [], requires: [], modules: input.members.map(member => ({ id: member.id, path: `modules/${member.id}`,
        moduleId: member.moduleId, version: member.version, configuration: { topics: member.topics, bridges: member.bridges, bindings: member.bindings, settings: {} } })),
      startupPlan: { members: input.members.map(member => ({ programId: member.id, enabled: false, after: [] })), startupOrder: input.members.map(member => member.id), onFailure: 'continue-independent' } });
  } catch (issue) { throw fault('MODULE_GROUP_BASELINE_INVALID', `Invalid author wiring baseline: ${issue.message}`); }
  return clone(input);
}
export function normalizeModuleGroup(input, knownIds) {
  if (!plain(input) || Object.keys(input).some(key => !['format', 'id', 'title', 'memberProgramIds', 'startupPlan', 'revision', 'origin', 'wiringBaseline'].includes(key))
      || input.format !== undefined && input.format !== MODULE_GROUP_FORMAT || typeof input.title !== 'string' || !input.title.trim()
      || input.title.length > 256 || /[\0\r\n]/.test(input.title) || !Array.isArray(input.memberProgramIds) || input.memberProgramIds.length > 128
      || new Set(input.memberProgramIds).size !== input.memberProgramIds.length) throw fault('MODULE_GROUP_INVALID', 'A module group contains a title, distinct registered instance references and a startup plan.');
  safeId(input.id, 'module group ID');
  const known = new Set(knownIds);
  for (const id of input.memberProgramIds) { safeId(id, 'module group member'); if (!known.has(id)) throw fault('MODULE_GROUP_MEMBER_MISSING', 'A group member must be an existing module instance.'); }
  const memberProgramIds = [...input.memberProgramIds];
  const startupPlan = publicStartupPlan(input.startupPlan ?? { format: STARTUP_PLAN_FORMAT,
    members: memberProgramIds.map(programId => ({ programId, enabled: false, after: [] })), onFailure: 'continue-independent' }, memberProgramIds);
  let origin;
  if (input.origin !== undefined) {
    const source = input.origin;
    if (!plain(source) || Object.keys(source).some(key => !['id', 'version', 'members'].includes(key)) || !plain(source.members)
        || typeof source.version !== 'string' || source.version.length > 128 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(source.version)
        || Object.keys(source.members).length > 128 || new Set(Object.values(source.members)).size !== Object.values(source.members).length)
      throw fault('MODULE_GROUP_ORIGIN_INVALID', 'Group origin needs an exact source identity, version and distinct logical member mapping.');
    safeId(source.id, 'group source ID');
    // Retained logical mappings allow a detached member to rejoin without
    // allocating a second instance and losing its existing local state.
    for (const [logical, instance] of Object.entries(source.members)) { safeId(logical, 'logical member ID'); safeId(instance, 'group source instance'); }
    origin = clone(source);
  }
  const wiringBaseline = input.wiringBaseline === undefined ? undefined : checkedWiringBaseline(input.wiringBaseline, origin);
  const group = { format: MODULE_GROUP_FORMAT, id: input.id, title: input.title.trim(), memberProgramIds, startupPlan, ...(origin ? { origin } : {}), ...(wiringBaseline ? { wiringBaseline } : {}) };
  return { ...group, revision: hash(JSON.stringify(group)) };
}

export class ModuleGroups {
  constructor({ localPrograms } = {}) { this.local = localPrograms; }
  row(id, expectedRevision) {
    safeId(id, 'module group ID'); const row = this.local.groups.get(id);
    if (!row) throw fault('MODULE_GROUP_NOT_FOUND', 'Unknown module group.', 404);
    if (expectedRevision !== undefined && expectedRevision !== row.revision) throw fault('MODULE_GROUP_CHANGED', 'The module group changed. Reload its current members and plan.');
    return row;
  }
  list() { return this.local.enqueue(async () => ({ groups: [...this.local.groups.values()].map(clone) })); }
  save({ group: input, expectedRevision } = {}) { return this.local.enqueue(async () => {
    if (this.local.closing) throw fault('LAUNCHER_STOPPING', 'Launcher is stopping.');
    const previous = this.local.groups.get(input?.id);
    await this.local.versionGroupRecoveryGuard?.(input?.id);
    for (const id of new Set([...(previous?.memberProgramIds ?? []), ...(input?.memberProgramIds ?? [])])) await this.local.assertVersionReady(id);
    if (previous ? expectedRevision !== previous.revision : expectedRevision !== undefined && expectedRevision !== null)
      throw fault('MODULE_GROUP_CHANGED', 'The module group changed. Reload it before saving.');
    if (!previous && this.local.groups.size >= 128) throw fault('MODULE_GROUP_LIMIT', 'Use at most 128 module groups.');
    // Renaming or editing a local group's operation plan cannot erase its
    // publisher identity. Version transactions alone replace this baseline.
    const keptOrigin = previous?.origin;
    const { wiringBaseline: ignoredBaseline, ...editable } = input ?? {};
    const group = normalizeModuleGroup({ ...editable, ...(keptOrigin ? { origin: keptOrigin } : {}),
      ...(previous?.wiringBaseline ? { wiringBaseline: previous.wiringBaseline } : {}) }, [...this.local.records.keys()]);
    this.local.groups.set(group.id, group);
    try { await this.local.save(); } catch (issue) { if (previous) this.local.groups.set(group.id, previous); else this.local.groups.delete(group.id); throw issue; }
    return { group: clone(group), startsModules: false, changesPermissions: false };
  }); }
  remove({ groupId, expectedRevision } = {}) { return this.local.enqueue(async () => {
    if (this.local.closing) throw fault('LAUNCHER_STOPPING', 'Launcher is stopping.');
    const group = this.row(groupId, expectedRevision);
    await this.local.versionGroupRecoveryGuard?.(groupId);
    for (const id of group.memberProgramIds) await this.local.assertVersionReady(id);
    if (expectedRevision !== group.revision) throw fault('MODULE_GROUP_CHANGED', 'Supply the exact current group revision.');
    this.local.groups.delete(group.id);
    try { await this.local.save(); } catch (issue) { this.local.groups.set(group.id, group); throw issue; }
    return { groupId, removed: true, removesPrograms: false, stopsModules: false };
  }); }
  reviewStart({ groupId, expectedRevision } = {}) { return this.local.enqueue(async () => {
    const group = this.row(groupId, expectedRevision);
    if (expectedRevision !== group.revision) throw fault('MODULE_GROUP_CHANGED', 'Supply the exact current group revision.');
    return this.local.reviewStartupPlanNow({ planData: group.startupPlan, ids: group.memberProgramIds,
      scope: { groupId: group.id, groupRevision: group.revision } });
  }); }
  applyStart(input = {}) {
    const saved = this.local.reviewed(input.reviewId, 'startup-plan'), group = this.row(saved.review.groupId, saved.review.groupRevision);
    return this.local.startStartupPlan({ ...input, planData: clone(group.startupPlan), ids: [...group.memberProgramIds],
      scope: { groupId: group.id, groupRevision: group.revision }, validateScope: () => this.row(group.id, group.revision) });
  }
  stopSnapshot(group) {
    const programs = group.memberProgramIds.map(id => {
      const row = this.local.row(id), handle = this.local.handles.get(id);
      return { programId: id, state: row.state, configurationRevision: configurationRevision(row), runId: row.runId ?? null, ownsProcess: Boolean(handle && (!handle.exit || handle.cleanupIncomplete)),
        sharedWithGroups: [...this.local.groups.values()].filter(other => other.id !== group.id && other.memberProgramIds.includes(id)).map(other => ({ id: other.id, title: other.title })),
        consumers: [...this.local.records.values()].filter(other => other.programId !== id && other.bindings.some(binding => binding.providerId === id))
          .map(other => ({ programId: other.programId, state: other.state, configurationRevision: configurationRevision(other), inGroup: group.memberProgramIds.includes(other.programId) })) };
    });
    const stopOrder = startupPlan({ ...group.startupPlan, members: group.startupPlan.members.map(member => ({ ...member, enabled: true })) }, group.memberProgramIds).order.reverse();
    return { format: 'world-hub.module-group-stop-review/v1', groupId: group.id, groupRevision: group.revision, programs, stopOrder,
      stopsHub: false, selectionRequired: true, digest: hash(JSON.stringify({ group, programs })) };
  }
  stopPreview({ groupId, expectedRevision } = {}) { return this.local.enqueue(async () => {
    const group = this.row(groupId, expectedRevision);
    if (expectedRevision !== group.revision) throw fault('MODULE_GROUP_CHANGED', 'Supply the exact current group revision.');
    return this.local.remember('group-stop', this.stopSnapshot(group));
  }); }
  applyStop({ reviewId, accepted, programIds } = {}) { return this.local.enqueue(async () => {
    if (this.local.closing) throw fault('LAUNCHER_STOPPING', 'Launcher is stopping.');
    if (accepted !== true) throw fault('TRUST_REQUIRED', 'Review the selected instances and their shared consumers before stopping.');
    const saved = this.local.reviewed(reviewId, 'group-stop'), group = this.row(saved.review.groupId, saved.review.groupRevision);
    const current = this.stopSnapshot(group);
    if (current.digest !== saved.review.digest) throw fault('MODULE_GROUP_CHANGED', 'The group membership, running instances or shared consumers changed. Review the stop again.');
    if (!Array.isArray(programIds) || new Set(programIds).size !== programIds.length || programIds.some(id => !group.memberProgramIds.includes(id)))
      throw fault('MODULE_GROUP_STOP_SELECTION_REQUIRED', 'Explicitly choose the reviewed module instances to stop; shared members may be left running.');
    const results = [];
    for (const id of current.stopOrder.filter(id => programIds.includes(id))) {
      try { const result = await this.local.stopNow(id); results.push({ programId: id, state: result.program.state }); }
      catch (issue) { results.push({ programId: id, state: 'failed', error: { code: issue.code ?? 'LOCAL_STOP_FAILED', message: issue.message } }); }
    }
    this.local.reviews.delete(reviewId);
    return { groupId: group.id, results, stopsHub: false, partial: results.some(row => row.state === 'failed') };
  }); }
}
