// Reviewed local wiring edits. The Hub does not interpret these author recipes.
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { hash, readBounded, collectFiles } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { readDeployment } from '../../scripts/runtime/deployment.mjs';
import { readModuleGroup } from '../../scripts/runtime/module-group.mjs';
import { resolveDefaultConnections } from '../../scripts/runtime/default-connections.mjs';
import { safeId } from '../../scripts/runtime/package.mjs';
import { importLocalArtifact } from './local-artifacts.mjs';
import { normalizeModuleGroup, moduleGroupWiringBaseline } from './module-groups.mjs';

const clone = value => structuredClone(value), plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fault = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 409, ...details });
const eq = (a, b) => a?.id === b?.id && a?.version === b?.version;
const wiring = row => clone({ topics: row.topics, bridges: row.bridges, bindings: row.bindings });
const stringify = value => JSON.stringify(value);
const own = (dictionary, key) => dictionary && Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const wiringKey = value => stringify(canonical({ topics: value.topics,
  bridges: Object.fromEntries(Object.entries(value.bridges).map(([slot, rules]) => [slot,
    { publish: [...rules.publish].sort(), subscribe: [...rules.subscribe].sort() }])),
  bindings: value.bindings.map(binding => ({ providerId: binding.providerId, contract: { id: binding.contract.id, version: binding.contract.version } }))
    .sort((left, right) => stringify(left).localeCompare(stringify(right), 'en')) }));
const active = handle => Boolean(handle && (!handle.exit || handle.cleanupIncomplete));

export class WiringDefaults {
  constructor(owner) { this.owner = owner; this.local = owner.localPrograms; this.reviews = new Map(); }
  async source(group, path, previous) {
    if (typeof path !== 'string' || !path.trim()) throw fault('WIRING_GROUP_SOURCE_INVALID', 'Choose the exact author module-group directory, ZIP or artifact JSON.');
    const info = await lstat(path), original = info.isDirectory() ? await collectFiles(path) : hash(await readBounded(path, 96 * 1024 * 1024));
    const imported = previous ?? await importLocalArtifact({ root: this.owner.root ?? this.local.root, path, kind: 'module-group' });
    const source = await readModuleGroup(imported.object.path), files = await collectFiles(imported.object.path);
    if (source.manifest.id !== group.origin.id || source.manifest.version !== group.origin.version)
      throw fault('WIRING_GROUP_SOURCE_MISMATCH', 'Choose the exact ID and version of this group origin.');
    for (const member of source.modules) {
      const id = own(group.origin.members, member.member.id);
      if (!id || !group.memberProgramIds.includes(id)) continue;
      const row = this.local.records.get(id);
      if (!row || row.module.id !== member.member.moduleId || row.module.version !== member.member.version
          || stringify(await collectSourceFiles(member.directory)) !== stringify(row.files))
        throw fault('WIRING_GROUP_SOURCE_MEMBER_MISMATCH', 'The selected author artifact member bytes, module ID or version differ from the currently registered source.');
    }
    return { imported, baseline: moduleGroupWiringBaseline(source.manifest), snapshot: { path, original, files } };
  }
  async snapshot(ids) {
    const local = this.local, sources = [], identities = [];
    for (const id of ids) sources.push([id, await collectSourceFiles(local.path(id, 'module'))]);
    for (const [id, identity] of local.identities) {
      const bytes = await readBounded(local.path(id, 'identity.json')), disk = JSON.parse(bytes);
      if (disk.programId !== id || disk.principal !== local.row(id).principal || disk.token !== identity.token || stringify(canonical(disk)) !== stringify(canonical(identity)))
        throw fault('LOCAL_IDENTITY_INVALID', 'The private module identity differs from its registration.');
      identities.push([id, hash(stringify(identity)), hash(bytes)]);
    }
    return hash(stringify({ records: [...local.records.values()].map(row => {
      const value = clone(row); delete value.communicationObservedAt; return value;
    }), groups: [...local.groups.values()], identities, sources, startupPlan: local.startupPlanData,
    handles: [...local.handles].map(([id, handle]) => [id, { pid: handle.pid, exit: handle.exit ?? null,
      cleanupIncomplete: handle.cleanupIncomplete === true, stopping: handle.stopping === true }]) }));
  }
  async build(input = {}, prepared = {}) {
    const local = this.local;
    if (local.closing) throw fault('MANAGEMENT_STOPPING', 'Wait until management finishes stopping.');
    if (!plain(input) || Object.keys(input).some(key => !['scope', 'targetId', 'groupSources', 'connectionSelections'].includes(key))
        || !['all', 'group', 'module'].includes(input.scope) || input.scope === 'all' && input.targetId !== undefined
        || input.groupSources !== undefined && !plain(input.groupSources) || input.connectionSelections !== undefined && !plain(input.connectionSelections))
      throw fault('WIRING_DEFAULTS_INPUT_INVALID', 'Choose all modules, one module group, or one module instance.');
    if (input.scope !== 'all') safeId(input.targetId, 'wiring defaults target');
    const target = input.scope === 'group' ? local.groups.get(input.targetId) : input.scope === 'module' ? local.records.get(input.targetId) : null;
    if (input.scope !== 'all' && !target) throw fault('WIRING_DEFAULTS_TARGET_MISSING', 'The selected module or group is no longer registered.');
    const ids = input.scope === 'all' ? [...local.records.keys()] : input.scope === 'group' ? [...target.memberProgramIds] : [input.targetId];
    const groups = input.scope === 'module' ? [] : input.scope === 'group' ? [target] : [...local.groups.values()].filter(group => group.memberProgramIds.some(id => ids.includes(id)));
    const blockers = [], missingGroupSources = [], baselines = new Map(), established = new Map(), sources = Object.create(null), sourceSnapshots = [], inspected = new Map();
    const block = (code, message, details = {}) => {
      const item = { code, message, ...details }; if (!blockers.some(row => stringify(row) === stringify(item))) blockers.push(item);
    };
    for (const id of Object.keys(input.connectionSelections ?? {})) if (!ids.includes(id) || !plain(input.connectionSelections[id]))
      throw fault('WIRING_DEFAULTS_INPUT_INVALID', 'Default connection choices must belong to a selected module instance.');
    for (const id of Object.keys(input.groupSources ?? {})) if (!groups.some(group => group.id === id && group.origin))
      throw fault('WIRING_DEFAULTS_INPUT_INVALID', 'Choose author sources only for module groups in this review.');
    for (const group of groups) {
      try { await local.versionGroupRecoveryGuard?.(group.id); }
      catch (issue) { block(issue.code ?? 'VERSION_RECOVERY_REQUIRED', issue.message, { groupId: group.id }); }
      if (!group.origin) continue;
      if (group.wiringBaseline) { baselines.set(group.id, group.wiringBaseline); continue; }
      const path = own(input.groupSources, group.id);
      if (!path) {
        missingGroupSources.push({ groupId: group.id, id: group.origin.id, version: group.origin.version });
        block('WIRING_GROUP_SOURCE_REQUIRED', 'This group has no retained author wiring recipe. Choose its exact original author artifact.', { groupId: group.id });
        continue;
      }
      try {
        const source = await this.source(group, path, own(prepared.sources, group.id)?.imported);
        sources[group.id] = source; sourceSnapshots.push([group.id, source.snapshot]);
        const normalized = normalizeModuleGroup({ ...group, wiringBaseline: source.baseline }, [...local.records.keys()]);
        baselines.set(group.id, normalized.wiringBaseline); established.set(group.id, normalized);
      } catch (issue) { block(issue.code ?? 'WIRING_GROUP_SOURCE_INVALID', issue.message, { groupId: group.id }); }
    }
    const configs = new Map(), moduleDefaults = new Map(), provenance = new Map();
    for (const id of ids) {
      const row = local.row(id);
      try {
        await local.assertVersionReady(id);
        const files = await collectSourceFiles(local.path(id, 'module'));
        if (stringify(files) !== stringify(row.files)) throw fault('LOCAL_INSTALLED_CODE_CHANGED', 'Installed module source differs from its registered release. Review a version update first.');
        const deployment = await readDeployment(local.path(id, 'module'), row.manifest);
        inspected.set(id, files);
        const recipes = [];
        for (const group of groups.filter(group => group.memberProgramIds.includes(id))) {
          const baseline = baselines.get(group.id), entry = baseline?.members.find(member => own(group.origin.members, member.id) === id);
          if (!entry) continue;
          if (entry.moduleId !== row.module.id || entry.version !== row.module.version) {
            block('WIRING_GROUP_MEMBER_VERSION_MISMATCH', 'The group author recipe requires a different member module ID or version. Restore or update the group source version first.', { groupId: group.id, programId: id }); continue;
          }
          const bindings = [];
          for (const binding of entry.bindings) {
            const providerId = own(group.origin.members, binding.providerId);
            if (!providerId || !group.memberProgramIds.includes(providerId) || !local.records.has(providerId))
              block('WIRING_GROUP_PROVIDER_MISSING', 'An author-wired provider has left this group or is no longer registered. No module will be re-added by wiring reset.', { groupId: group.id, programId: id });
            else bindings.push({ providerId, contract: clone(binding.contract) });
          }
          recipes.push({ config: { topics: entry.topics, bridges: entry.bridges, bindings },
            source: { kind: 'module-group', id: baseline.id, version: baseline.version, groupId: group.id } });
        }
        if (recipes.length) {
          const first = recipes[0];
          if (recipes.some(recipe => wiringKey(recipe.config) !== wiringKey(first.config)))
            block('WIRING_GROUP_DEFAULT_CONFLICT', 'This shared instance has conflicting author recipes in multiple groups. Choose one group explicitly.', { programId: id, groupIds: recipes.map(recipe => recipe.source.groupId) });
          configs.set(id, clone(first.config)); provenance.set(id, first.source);
          if (Object.keys(own(input.connectionSelections, id) ?? {}).length) block('WIRING_CONNECTION_SELECTION_UNUSED', 'This member uses the selected group recipe rather than module default connections.', { programId: id });
        } else {
          if (!deployment?.topics || !deployment?.bridges) throw fault('WIRING_MODULE_DEFAULTS_MISSING', 'This module author did not provide complete deployment topic and bridge defaults.');
          const bindings = row.bindings.filter(binding => row.manifest.requires.some(required => eq(binding.contract, required))
            && !(deployment.connections ?? []).some(connection => connection.contracts.some(required => eq(required, binding.contract))));
          const initial = { topics: clone(deployment.topics), bridges: clone(deployment.bridges), bindings: clone(bindings) };
          configs.set(id, initial); moduleDefaults.set(id, { deployment, bindings });
          provenance.set(id, { kind: 'module', id: row.module.id, version: row.module.version });
        }
      } catch (issue) { block(issue.code ?? 'WIRING_SOURCE_INVALID', issue.message, { programId: id }); configs.set(id, wiring(row)); provenance.set(id, { kind: 'module', ...row.module }); }
    }
    // Resolve against the complete batch's candidate maps. A provider being
    // restored in the same operation must never leak its old local topic map.
    let connections = [], stable = moduleDefaults.size === 0;
    for (let pass = 0; pass <= ids.length + 1 && !stable; pass++) {
      const providers = [...local.records.values()].map(row => ({ ...row, ...(configs.get(row.programId) ?? {}), provides: row.manifest.provides })), next = new Map(configs);
      connections = [];
      for (const [id, defaults] of moduleDefaults) {
        const row = local.row(id);
        try {
          const resolved = resolveDefaultConnections({ manifest: row.manifest, deployment: defaults.deployment, programs: providers, programId: id,
            selections: own(input.connectionSelections, id) ?? {}, bindings: defaults.bindings });
          connections.push(...resolved.connections.map(connection => ({ programId: id, ...connection })));
          next.set(id, { topics: resolved.topics, bridges: defaults.deployment.bridges, bindings: resolved.bindings });
          for (const connection of resolved.connections) if (connection.status !== 'resolved')
            block(connection.status === 'ambiguous' ? 'WIRING_CONNECTION_SELECTION_REQUIRED' : 'WIRING_CONNECTION_PROVIDER_MISSING',
              connection.status === 'ambiguous' ? 'Choose one exact compatible provider for this author connection.' : 'Install the exact provider required by this author connection.', { programId: id, connectionId: connection.id });
        } catch (issue) { block(issue.code ?? 'WIRING_CONNECTION_INVALID', issue.message, { programId: id }); }
      }
      stable = [...configs].every(([id, config]) => wiringKey(config) === wiringKey(next.get(id)));
      for (const [id, config] of next) configs.set(id, config);
    }
    if (!stable) block('WIRING_CONNECTION_CYCLE', 'Author connections form a topic cycle without a stable default. Review the module author declarations.');
    const candidates = new Map(local.records);
    for (const id of ids) {
      const row = local.row(id);
      try {
        const config = local.configurationFor({ settings: row.settings, ...configs.get(id) }, row.manifest, row.deployment ?? {});
        candidates.set(id, { ...row, ...config });
      } catch (issue) { block(issue.code ?? 'WIRING_CONFIGURATION_INVALID', issue.message, { programId: id }); }
    }
    // Validate all bindings against the final batch, not a partially changed
    // registry. This also checks retained consumers outside the selected scope.
    for (const row of candidates.values()) {
      for (const required of row.manifest.requires) if (!row.bindings.some(binding => eq(binding.contract, required)))
        block('LOCAL_PROVIDER_REQUIRED', `An installed provider is required for ${required.id}@${required.version}.`, { programId: row.programId });
      for (const binding of row.bindings) if (binding.providerId === row.programId || !candidates.get(binding.providerId)?.manifest.provides.some(offered => eq(offered, binding.contract)))
        block('LOCAL_PROVIDER_INVALID', 'A final capability binding does not refer to an exact installed provider.', { programId: row.programId });
    }
    const requiresStop = [], programs = ids.map(id => {
      const row = local.row(id), before = wiring(row), after = wiring(candidates.get(id)), changed = wiringKey(before) !== wiringKey(after), handle = local.handles.get(id);
      if (changed && (row.state !== 'stopped' || active(handle))) {
        requiresStop.push(id); block('WIRING_REQUIRES_STOPPED', 'Stop this managed module, then review the defaults again. No process is stopped by this action.', { programId: id });
      }
      return { programId: id, module: clone(row.module), state: row.state, source: provenance.get(id), before, after, changed,
        affected: { sharedWithGroups: [...local.groups.values()].filter(group => group.memberProgramIds.includes(id) && (input.scope !== 'group' || group.id !== input.targetId)).map(group => ({ id: group.id, title: group.title })),
          consumers: [...local.records.values()].filter(peer => peer.programId !== id && peer.bindings.some(binding => binding.providerId === id)).map(peer => ({ programId: peer.programId, state: peer.state })) } };
    });
    const used = new Set([...ids, ...programs.flatMap(program => program.after.bindings.map(binding => binding.providerId)), ...connections.flatMap(connection => connection.candidates.map(candidate => candidate.programId))]);
    for (const id of used) {
      if (!local.records.has(id)) continue;
      try {
        await local.assertVersionReady(id);
        if (!inspected.has(id)) {
          const files = await collectSourceFiles(local.path(id, 'module'));
          if (stringify(files) !== stringify(local.row(id).files)) throw fault('LOCAL_INSTALLED_CODE_CHANGED', 'A candidate provider source changed outside a reviewed update.');
        }
      } catch (issue) { block(issue.code ?? 'WIRING_SOURCE_INVALID', issue.message, { programId: id }); }
    }
    let snapshot;
    try { snapshot = await this.snapshot([...used].filter(id => local.records.has(id))); }
    catch (issue) { block(issue.code ?? 'WIRING_SNAPSHOT_INVALID', 'Source or private identity could not be verified. Retain the installation for inspection.'); snapshot = null; }
    const review = { format: 'world-hub.wiring-defaults-review/v1', scope: input.scope, ...(input.targetId ? { targetId: input.targetId } : {}), programs,
      changed: programs.some(program => program.changed) || established.size > 0,
      blockers, blocked: blockers.length > 0, missingGroupSources, connections, requiresStop, groupBaselinesEstablished: [...established.keys()],
      startsModules: false, preservesPrivateState: true, preservesIdentity: true };
    review.digest = hash(stringify({ review, snapshot, sourceSnapshots }));
    return { input: clone(input), review, configs, established, sources, used: [...used], snapshot, handles: new Map(local.handles) };
  }
  preview(input = {}) { return this.local.enqueue(async () => {
    const value = await this.build(input), reviewId = randomUUID(), createdAt = Date.now();
    this.reviews.set(reviewId, { ...value, createdAt }); while (this.reviews.size > 32) this.reviews.delete(this.reviews.keys().next().value);
    return { reviewId, review: clone(value.review), expiresAt: new Date(createdAt + 600000).toISOString() };
  }); }
  apply(input = {}) { return this.local.enqueue(async () => {
    if (!plain(input) || Object.keys(input).some(key => !['reviewId', 'accepted'].includes(key)) || input.accepted !== true)
      throw fault('TRUST_REQUIRED', 'Accept the exact restored topics, bridge permissions and capability bindings.');
    const saved = this.reviews.get(input.reviewId);
    if (!saved || Date.now() - saved.createdAt > 600000) throw fault('WIRING_REVIEW_REQUIRED', 'Review the current defaults before applying them.');
    const local = this.local;
    const recheck = async () => {
      let value;
      try { value = await this.build(saved.input, saved); }
      catch (issue) { throw fault('WIRING_REVIEW_CHANGED', 'Source, identities, wiring, groups or processes changed. Review defaults again.', { causeCode: issue.code }); }
      if (value.review.digest !== saved.review.digest || saved.handles.size !== local.handles.size || [...saved.handles].some(([id, handle]) => local.handles.get(id) !== handle))
        throw fault('WIRING_REVIEW_CHANGED', 'Source, identities, wiring, groups or processes changed. Review defaults again.');
      return value;
    };
    let fresh = await recheck();
    if (fresh.review.blocked) throw fault('WIRING_DEFAULTS_BLOCKED', 'Resolve the displayed defaults blockers, then review again.', { blockers: clone(fresh.review.blockers) });
    const changed = fresh.review.programs.filter(program => program.changed);
    this.reviews.delete(input.reviewId);
    if (changed.length) {
      try { await local.updateCredentials({ credentials: {}, annotations: {}, remove: changed.map(program => local.row(program.programId).principal) }, {}); }
      catch (issue) { throw fault('WIRING_CREDENTIALS_FAILED', 'Old grants could not be confirmed revoked. Configuration is retained; selected credentials may be revoked.', { causeCode: issue.code, credentialsMayBeRevoked: true }); }
      fresh = await recheck();
    }
    const previousRecords = new Map(local.records), previousGroups = new Map(local.groups);
    try {
      for (const program of changed) {
        const old = local.row(program.programId);
        local.records.set(program.programId, { ...old, ...clone(program.after), configuredAt: new Date().toISOString(), communication: 'disconnected' });
      }
      for (const [id, group] of fresh.established) local.groups.set(id, group);
      await local.save();
    } catch (issue) {
      local.records.clear(); for (const [id, row] of previousRecords) local.records.set(id, row);
      local.groups.clear(); for (const [id, group] of previousGroups) local.groups.set(id, group);
      throw fault('WIRING_SAVE_FAILED', 'Registry save failed. Previous wiring and group baselines were restored. Old grants remain revoked.', { causeCode: issue.code, credentialsRevoked: changed.length > 0 });
    }
    return { restored: true, programIds: changed.map(program => program.programId), groupBaselinesEstablished: [...fresh.established.keys()],
      startsModules: false, stopsModules: false, preservesPrivateState: true, preservesIdentity: true, credentialsRevoked: changed.length > 0 };
  }); }
}
