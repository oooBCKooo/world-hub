// Version transactions belong to local deployment management. No Hub routing,
// business migration, dependency execution or process adoption happens here.
import { mkdir, readdir, lstat, rename, writeFile, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { hash, ordinaryPath, readBounded, privateJson as writePrivateJson, relativePath } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { readModuleGroup } from '../../scripts/runtime/module-group.mjs';
import { safeId } from '../../scripts/runtime/package.mjs';
import { resolveDefaultConnections } from '../../scripts/runtime/default-connections.mjs';
import { executionPolicy } from './execution-policy.mjs';
import { initialExecutionPolicy } from '../../scripts/runtime/execution-defaults.mjs';
import { importLocalArtifact } from './local-artifacts.mjs';
import { configurationRevision } from './program-configuration.mjs';
import { normalizeModuleGroup, moduleGroupWiringBaseline } from './module-groups.mjs';

const FORMAT = 'world-hub.module-version-transaction/v1', REVIEW = 'world-hub.module-version-review/v1';
const clone = value => structuredClone(value), now = () => new Date().toISOString();
const fault = (code, message) => Object.assign(new Error(message), { code, status: 409 });
async function privateJson(path, value, options) {
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
    throw fault('VERSION_METADATA_LIMIT', 'Version transaction metadata exceeds its 16 MiB read/write bound.');
  return writePrivateJson(path, value, options);
}
const eq = (a, b) => a.id === b.id && a.version === b.version;
const principalFor = id => `local.${id.slice(0, 35)}.${hash(id).slice(0, 8)}`;
const json = async path => JSON.parse((await readBounded(path, 16 * 1024 * 1024)).toString('utf8'));
const missing = async path => { try { await lstat(path); return false; } catch (issue) { if (issue.code === 'ENOENT') return true; throw issue; } };
const moduleIdentity = row => row ? { id: row.module.id, version: row.module.version } : null;
const publicConfiguration = row => row ? clone({ settings: row.settings, topics: row.topics, bridges: row.bridges,
  bindings: row.bindings, permissions: row.manifest.permissions, executionPolicy: executionPolicy(row) }) : null;
async function inventory(root) {
  if (await missing(root)) return { exists: false, directories: [], files: [], bytes: 0, digest: hash('missing') };
  await ordinaryPath(root); const directories = [], files = []; let bytes = 0, entries = 0;
  async function visit(local = '') {
    for (const entry of (await readdir(join(root, local), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (++entries > 8192) throw fault('VERSION_STATE_LIMIT', 'State snapshots support at most 8192 entries.');
      const path = local ? `${local}/${entry.name}` : entry.name; relativePath(path);
      const full = join(root, path); await ordinaryPath(full); const info = await lstat(full);
      if (info.isDirectory()) { directories.push(path); await visit(path); }
      else if (info.isFile()) {
        if (info.size > 256 * 1024 * 1024) throw fault('VERSION_STATE_LIMIT', 'One state file exceeds the 256 MiB snapshot bound.');
        const content = await readBounded(full, 256 * 1024 * 1024); bytes += content.length;
        if (bytes > 512 * 1024 * 1024) throw fault('VERSION_STATE_LIMIT', 'State snapshot exceeds 512 MiB.');
        files.push({ path, sha256: hash(content), bytes: content.length });
      } else throw fault('VERSION_STATE_SPECIAL_FILE', 'State snapshots require ordinary files and directories.');
    }
  }
  await visit(); const result = { exists: true, directories, files, bytes }; return { ...result, digest: hash(JSON.stringify(result)) };
}
async function copyInventory(source, destination, contents, sourceCode = false) {
  await ordinaryPath(destination, { allowMissing: true }); await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const path of contents.directories ?? []) { relativePath(path); await mkdir(join(destination, path), { recursive: true, mode: 0o700 }); }
  for (const item of contents.files) {
    relativePath(item.path); const bytes = await readBounded(join(source, item.path), sourceCode ? 8 * 1024 * 1024 : 256 * 1024 * 1024);
    if (hash(bytes) !== item.sha256) throw fault('VERSION_REVIEW_CHANGED', 'A reviewed source or state file changed while it was copied.');
    const target = join(destination, item.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  const copied = sourceCode ? await collectSourceFiles(destination) : await inventory(destination);
  if (sourceCode ? JSON.stringify(copied) !== JSON.stringify(contents.files) : contents.exists && copied.digest !== contents.digest)
    throw fault('VERSION_SNAPSHOT_CHANGED', 'The copied snapshot differs from its reviewed inventory.');
}
function stopped(local, id) {
  const row = local.row(id), handle = local.handles.get(id);
  if (row.state !== 'stopped' || handle && (!handle.exit || handle.cleanupIncomplete))
    throw fault('VERSION_REQUIRES_STOPPED', `Stop module instance ${id} before replacing its version. No peer is stopped automatically.`);
  return row;
}

export class ModuleVersions {
  constructor(owner) { this.owner = owner; this.local = owner.localPrograms; this.directory = join(resolve(owner.root ?? this.local.root), 'module-versions'); this.reviews = new Map(); }
  async initialize() {
    await ordinaryPath(this.directory, { allowMissing: true }); await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // The journal is written before per-instance markers. A restart in that
    // window must still fence every affected instance and the target group.
    this.local.versionRecoveryGuard = async programId => {
      const pending = (await this.journals()).find(row => !['committed', 'rolled-back'].includes(row.status) && row.programIds.includes(programId));
      if (pending) throw Object.assign(fault('VERSION_RECOVERY_REQUIRED', 'Recover the interrupted version transaction before changing or starting this module.'), { transactionId: pending.id });
    };
    this.local.versionGroupRecoveryGuard = async groupId => {
      const pending = (await this.journals()).find(row => row.kind === 'module-group' && row.targetId === groupId && !['committed', 'rolled-back'].includes(row.status));
      if (pending) throw Object.assign(fault('VERSION_RECOVERY_REQUIRED', 'Recover the interrupted group version transaction before editing this group.'), { transactionId: pending.id });
    };
    return this;
  }
  target(kind, id) {
    safeId(id, 'version target');
    if (kind === 'module') { const row = this.local.row(id); return { id: row.module.id, version: row.module.version, revision: configurationRevision(row) }; }
    if (kind !== 'module-group') throw fault('VERSION_KIND_INVALID', 'Choose a module or module group.');
    const group = this.local.groups.get(id); if (!group) throw fault('MODULE_GROUP_NOT_FOUND', 'Unknown module group.');
    return { id: group.origin?.id ?? group.id, version: group.origin?.version ?? null, revision: group.revision };
  }
  async journals() {
    await this.initialize(); const result = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      const file = join(this.directory, entry.name, 'journal.json');
      if (await missing(file)) continue;
      const row = await json(file);
      if (row.format !== FORMAT || row.id !== entry.name || !['module', 'module-group'].includes(row.kind) || !Array.isArray(row.programIds)
          || !['preparing', 'switching', 'committed', 'rolled-back'].includes(row.status) || !Array.isArray(row.addedIds)
          || row.programIds.length > 128 || new Set(row.programIds).size !== row.programIds.length || row.addedIds.some(id => !row.programIds.includes(id))) throw fault('VERSION_JOURNAL_INVALID', 'Retain invalid version transaction data for inspection.');
      safeId(row.targetId); for (const id of row.programIds) safeId(id);
      result.push(row);
    }
    if (result.length > 4096) throw fault('VERSION_HISTORY_LIMIT', 'Version history exceeds the supported transaction-count bound.');
    return result;
  }
  summary(row) { return { id: row.id, createdAt: row.createdAt, action: row.action, before: clone(row.before), after: clone(row.after), dataPolicy: row.dataPolicy, configurationPolicy: row.configurationPolicy, status: row.status }; }
  overview(kind, id) { return this.local.enqueue(async () => {
    const current = this.target(kind, id), all = await this.journals(), related = all.filter(row => row.kind === kind && row.targetId === id);
    const affected = kind === 'module' ? [id] : this.local.groups.get(id).memberProgramIds;
    const pending = [];
    for (const row of all) {
      if (!(row.kind === kind && row.targetId === id || row.programIds.some(programId => affected.includes(programId)))) continue;
      let marked = false;
      for (const programId of row.programIds) {
        const path = this.local.path(programId, 'version-transaction.json');
        if (!await missing(path) && (await json(path)).transactionId === row.id) { marked = true; break; }
      }
      if (!['committed', 'rolled-back'].includes(row.status) || marked) pending.push({ transactionId: row.id, kind: row.kind, targetId: row.targetId, status: row.status, programIds: row.programIds });
    }
    return { kind, targetId: id, revision: current.revision, current,
      history: related.filter(row => row.status === 'committed').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(row => this.summary(row)),
      recoveryRequired: pending,
      ...(kind === 'module-group' && this.local.groups.get(id).origin ? { origin: clone(this.local.groups.get(id).origin) } : {}) };
  }); }
  async fingerprint(ids) {
    const states = {}, source = {};
    const identities = {};
    let totalStateBytes = 0, totalStateEntries = 0;
    for (const id of ids) { const row = stopped(this.local, id); await this.local.assertVersionReady(id); source[id] = await collectSourceFiles(this.local.path(id, 'module'));
      if (JSON.stringify(source[id]) !== JSON.stringify(row.files)) throw fault('LOCAL_INSTALLED_CODE_CHANGED', 'Installed source changed outside a reviewed update.');
      states[id] = await inventory(this.local.path(id, 'state'));
      totalStateBytes += states[id].bytes; totalStateEntries += states[id].files.length + states[id].directories.length;
      if (totalStateBytes > 512 * 1024 * 1024 || totalStateEntries > 8192)
        throw fault('VERSION_STATE_LIMIT', 'The combined transaction state exceeds 512 MiB or 8192 entries.');
      const identity = await json(this.local.path(id, 'identity.json'));
      if (JSON.stringify(identity) !== JSON.stringify(this.local.identities.get(id))) throw fault('VERSION_IDENTITY_CHANGED', 'The registered instance identity changed outside management.');
      identities[id] = hash(JSON.stringify(identity));
    }
    const peers = [...this.local.records.values()].map(row => ({ programId: row.programId, revision: configurationRevision(row), state: row.state, principal: row.principal, runId: row.runId ?? null }));
    const groups = [...this.local.groups.values()].map(clone);
    return { states, source, digest: hash(JSON.stringify({ states, source, identities, peers, groups, startupPlan: this.local.getStartupPlan() })) };
  }
  effects(id, candidate, records) {
    const consumers = [...records.values()].filter(row => row.programId !== id && row.bindings.some(binding => binding.providerId === id));
    for (const row of consumers) for (const binding of row.bindings.filter(binding => binding.providerId === id))
      if (!candidate.manifest.provides.some(contract => eq(contract, binding.contract))) throw fault('LOCAL_PROVIDER_CONTRACT_IN_USE', `The new version removes a capability required by registered consumer ${row.programId}. Rewire it first.`);
    return { sharedWithGroups: [...this.local.groups.values()].filter(group => group.memberProgramIds.includes(id)).map(group => ({ id: group.id, title: group.title })),
      consumers: consumers.map(row => ({ programId: row.programId, state: row.state, configurationRevision: configurationRevision(row), contracts: row.bindings.filter(binding => binding.providerId === id).map(binding => clone(binding.contract)) })) };
  }
  validateAll(records, changed) {
    if (records.size > 128) throw fault('LOCAL_PROGRAM_LIMIT', 'The version update would exceed 128 registered module instances.');
    for (const id of changed) { const row = records.get(id);
      for (const required of row.manifest.requires) if (!row.bindings.some(binding => eq(binding.contract, required))) throw fault('LOCAL_PROVIDER_REQUIRED', `Select an installed provider for ${required.id}@${required.version}.`);
      for (const binding of row.bindings) if (binding.providerId === id || !records.get(binding.providerId)?.manifest.provides.some(contract => eq(contract, binding.contract)))
        throw fault('LOCAL_PROVIDER_INVALID', 'Version update has an absent, self-bound or incompatible capability provider.');
      this.effects(id, row, records);
    }
  }
  async prepare(kind, id, input, prepared) {
    if (this.local.closing) throw fault('LAUNCHER_STOPPING', 'Local deployment management is stopping.');
    const current = this.target(kind, id);
    if (kind === 'module-group') await this.local.versionGroupRecoveryGuard?.(id);
    if (input.expectedRevision !== current.revision) throw fault('VERSION_TARGET_CHANGED', 'The target configuration changed. Reload it before reviewing a version update.');
    const dataPolicy = input.dataPolicy ?? 'preserve', configurationPolicy = input.configurationPolicy ?? 'preserve';
    if (!['preserve', 'fresh'].includes(dataPolicy) || !['preserve', 'author'].includes(configurationPolicy)) throw fault('VERSION_POLICY_INVALID', 'Choose preserve/fresh private data and preserve/author public configuration.');
    const object = prepared?.object ?? (await importLocalArtifact({ root: this.directory, path: input.path, kind })).object;
    const oldGroup = kind === 'module-group' ? this.local.groups.get(id) : null;
    if (object.id !== current.id && (!oldGroup || oldGroup.origin)) throw fault('VERSION_SOURCE_ID_CHANGED', 'Choose a release of the same module or module-group source identity.');
    if (oldGroup && !oldGroup.origin && input.establishOrigin !== true) throw fault('VERSION_ORIGIN_REQUIRED', 'This local group has no publisher baseline. Explicitly establish it from the selected group release.');
    const rows = new Map(this.local.records), changed = [], inspectedRows = [], mapping = {}, removed = []; let nextGroup;
    let groupSource = null;
    if (kind === 'module-group') {
      try { groupSource = await readModuleGroup(object.path); }
      catch (issue) { if (prepared) throw fault('VERSION_REVIEW_CHANGED', 'The candidate group source changed after review.'); throw issue; }
      if (prepared && JSON.stringify(groupSource.manifest) !== JSON.stringify(prepared.groupManifest))
        throw fault('VERSION_REVIEW_CHANGED', 'The candidate group source changed after review.');
    }
    if (groupSource) {
      for (const item of groupSource.modules) {
        const logical = item.member.id;
        let programId = oldGroup.origin?.members[logical];
        if (programId && !rows.has(programId)) programId = undefined;
        if (!oldGroup.origin) {
          const candidates = oldGroup.memberProgramIds.filter(programId => rows.get(programId).module.id === item.manifest.id);
          if (candidates.length > 1) throw fault('VERSION_MEMBER_AMBIGUOUS', 'The untracked group has multiple instances of the same module. Establish an unambiguous publisher mapping first.');
          programId = candidates[0];
        }
        mapping[logical] = programId ?? prepared?.mapping?.[logical] ?? `version-${randomUUID().slice(0, 8)}-${Object.keys(mapping).length + 1}`;
      }
      for (const programId of oldGroup.memberProgramIds) if (!Object.values(mapping).includes(programId)) removed.push({ programId, retainedRegistered: true, state: rows.get(programId).state });
    }
    const entries = groupSource ? groupSource.modules.map(item => ({ directory: item.directory, recipe: item.member.configuration, programId: mapping[item.member.id] })) : [{ directory: object.path, programId: id }];
    for (const entry of entries) {
      const previous = rows.get(entry.programId); if (previous) stopped(this.local, entry.programId);
      const inspected = await this.local.inspect(entry.directory, previous?.environment ?? {});
      if (previous && previous.module.id !== inspected.manifest.id) throw fault('VERSION_MEMBER_ID_CHANGED', 'A logical group member cannot replace a different module identity. Use a new logical member ID.');
      if (previous && previous.module.version === inspected.manifest.version && JSON.stringify(previous.files) !== JSON.stringify(inspected.files))
        throw fault('VERSION_VERSION_IMMUTABLE', 'Changed module source needs a new module version; an existing release identity cannot silently name different bytes.');
      const deployment = inspected.deploymentReview?.deployment ?? {};
      let configInput = previous && configurationPolicy === 'preserve' ? { settings: previous.settings, topics: previous.topics, bridges: previous.bridges, bindings: previous.bindings } : entry.recipe ? {
        ...entry.recipe, bindings: entry.recipe.bindings.map(binding => ({ ...binding, providerId: mapping[binding.providerId] })) } : { bindings: (previous?.bindings ?? []).filter(binding => inspected.manifest.requires.some(contract => eq(contract, binding.contract))) };
      if (!entry.recipe && configurationPolicy === 'author' && deployment.connections?.length) {
        configInput.bindings = configInput.bindings.filter(binding => !deployment.connections.some(connection => connection.contracts.some(contract => eq(contract, binding.contract))));
        const defaults = resolveDefaultConnections({ manifest: inspected.manifest, deployment, programs: [...rows.values()].filter(row => row.programId !== id).map(row => ({ ...row, provides: row.manifest.provides })), bindings: configInput.bindings, programId: id });
        if (defaults.selectionRequired) throw fault('VERSION_PROVIDER_SELECTION_REQUIRED', 'The author defaults need an exact installed provider. Add or rewire the provider before updating.');
        configInput = { ...configInput, topics: defaults.topics, bindings: defaults.bindings };
      }
      const config = this.local.configurationFor(configInput, inspected.manifest, deployment);
      const row = { ...(previous ?? { programId: entry.programId, principal: principalFor(entry.programId), registeredAt: now() }), module: { id: inspected.manifest.id, version: inspected.manifest.version },
        manifest: inspected.manifest, deployment: inspected.deploymentReview?.deployment ?? null, ...config,
        executionPolicy: previous ? executionPolicy(previous) : initialExecutionPolicy(deployment, entry.recipe?.executionDefaults),
        environment: Object.fromEntries(Object.entries(inspected.environment).map(([name, runtime]) => [`${name}Path`, runtime.executable])), files: inspected.files, state: 'stopped', communication: 'disconnected' };
      const executionPolicySource = previous ? 'local' : entry.recipe?.executionDefaults !== undefined ? 'module-group' : deployment.executionDefaults !== undefined ? 'module' : 'system';
      rows.set(entry.programId, row); changed.push(entry.programId); inspectedRows.push({ id: entry.programId, previous, row, inspected, executionPolicySource });
    }
    this.validateAll(rows, changed);
    if (groupSource) {
      const plan = groupSource.manifest.startupPlan;
      const authorPlan = { ...plan, members: plan.members.map(member => ({ ...member, programId: mapping[member.programId], after: member.after.map(peer => mapping[peer]) })), startupOrder: plan.startupOrder.map(peer => mapping[peer]) };
      let startupPlan = authorPlan;
      if (configurationPolicy === 'preserve') {
        const ids = Object.values(mapping), kept = oldGroup.startupPlan.members.filter(member => ids.includes(member.programId)).map(member => ({ ...member, after: member.after.filter(peer => ids.includes(peer)) }));
        startupPlan = { ...oldGroup.startupPlan, members: [...kept, ...ids.filter(programId => !kept.some(member => member.programId === programId)).map(programId => ({ programId, enabled: false, after: [] }))], startupOrder: [...(oldGroup.startupPlan.startupOrder ?? oldGroup.memberProgramIds).filter(peer => ids.includes(peer)), ...ids.filter(peer => !oldGroup.memberProgramIds.includes(peer))] };
      }
      nextGroup = normalizeModuleGroup({ id, title: configurationPolicy === 'author' ? groupSource.manifest.title : oldGroup.title, memberProgramIds: Object.values(mapping), startupPlan,
        wiringBaseline: moduleGroupWiringBaseline(groupSource.manifest),
        origin: { id: object.id, version: object.version, members: { ...oldGroup.origin?.members, ...mapping } } }, [...rows.keys()]);
    }
    const fingerprint = await this.fingerprint(inspectedRows.filter(item => item.previous).map(item => item.id));
    const after = kind === 'module' ? { ...rows.get(id).module, revision: configurationRevision(rows.get(id)) } : { id: object.id, version: object.version, revision: nextGroup.revision };
    const review = { format: REVIEW, kind, targetId: id, action: 'update', expectedRevision: current.revision, before: current, after, dataPolicy, configurationPolicy, dataCompatibility: 'not-validated',
      establishesOrigin: Boolean(oldGroup && !oldGroup.origin),
      programs: inspectedRows.map(item => ({ programId: item.id, change: item.previous ? 'update' : 'add', before: moduleIdentity(item.previous), after: moduleIdentity(item.row), previousConfiguration: publicConfiguration(item.previous), settings: clone(item.row.settings), topics: clone(item.row.topics), bridges: clone(item.row.bridges), bindings: clone(item.row.bindings), executionPolicy: executionPolicy(item.row), executionPolicySource: item.executionPolicySource, manifest: clone(item.row.manifest), sourceFiles: clone(item.row.files), affected: this.effects(item.id, item.row, rows) })),
      executionPolicyBoundary: 'Existing instances retain their local execution policy. New instances use the reviewed author or system defaults with no allowed callers; automatic wake-up requires local caller authorization.',
      removedMembers: removed, group: nextGroup ? { before: clone(oldGroup), after: clone(nextGroup) } : null, startsModules: false, stopsOtherModules: false, preservesIdentity: true,
      privateData: dataPolicy === 'fresh' ? 'Fresh empty state replaces the active state; the original is retained in the transaction snapshot.' : 'Current private state is preserved without validating application-level compatibility.' };
    review.digest = hash(JSON.stringify({ review, groupManifest: groupSource?.manifest ?? null,
      fingerprint: fingerprint.digest, inspected: inspectedRows.map(item => item.inspected.digest) }));
    return { review, object, mapping, inspectedRows, fingerprint, nextGroup, groupManifest: groupSource ? clone(groupSource.manifest) : null, input: clone(input) };
  }
  remember(value) { const reviewId = randomUUID(), createdAt = Date.now(); this.reviews.set(reviewId, { ...value, createdAt }); while (this.reviews.size > 64) this.reviews.delete(this.reviews.keys().next().value); return { reviewId, review: clone(value.review), expiresAt: new Date(createdAt + 600000).toISOString() }; }
  preview(kind, id, input = {}) { return this.local.enqueue(async () => { await this.initialize(); return this.remember(await this.prepare(kind, id, input)); }); }
  async transaction(id) {
    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw fault('VERSION_HISTORY_NOT_FOUND', 'Select an existing version transaction.');
    const transaction = (await this.journals()).find(row => row.id === id);
    if (!transaction) throw fault('VERSION_HISTORY_NOT_FOUND', 'Select an existing version transaction.');
    return transaction;
  }
  async snapshot(journal, name) {
    const value = await json(join(this.directory, journal.id, `${name}.json`));
    if (typeof journal[`${name}Digest`] !== 'string' || hash(JSON.stringify(value)) !== journal[`${name}Digest`])
      throw fault('VERSION_SNAPSHOT_CHANGED', 'Version snapshot metadata is incomplete or changed. Retain the private transaction for inspection.');
    return value;
  }
  rollbackPreview(kind, id, input = {}) { return this.local.enqueue(async () => this.remember(await this.prepareRollback(kind, id, input))); }
  async prepareRollback(kind, id, input) {
    if (this.local.closing) throw fault('LAUNCHER_STOPPING', 'Local deployment management is stopping.');
    const current = this.target(kind, id);
    if (kind === 'module-group') await this.local.versionGroupRecoveryGuard?.(id);
    if (input.expectedRevision !== current.revision) throw fault('VERSION_TARGET_CHANGED', 'The current version or configuration changed. Reload before rollback.');
    if (!['preserve', 'restore'].includes(input.dataPolicy ?? 'preserve')) throw fault('VERSION_POLICY_INVALID', 'Rollback data policy is preserve or restore.');
    const selected = await this.transaction(input.transactionId);
    if (selected.status !== 'committed' || selected.kind !== kind || selected.targetId !== id) throw fault('VERSION_HISTORY_NOT_FOUND', 'Select a completed transaction belonging to this target.');
    const before = await this.snapshot(selected, 'before'), rows = new Map(this.local.records), inspectedRows = [];
    for (const saved of before.records) {
      const old = stopped(this.local, saved.programId); if (old.principal !== saved.principal) throw fault('VERSION_IDENTITY_CHANGED', 'The original module identity is no longer registered.');
      const inspected = await this.local.inspect(join(this.directory, selected.id, 'before', saved.programId, 'module'), saved.environment);
      if (JSON.stringify(inspected.files) !== JSON.stringify(saved.files)) throw fault('VERSION_SNAPSHOT_CHANGED', 'Historical source snapshot changed.');
      const config = this.local.configurationFor(saved, inspected.manifest, inspected.deploymentReview?.deployment ?? {});
      const row = { ...clone(saved), ...config, executionPolicy: executionPolicy(old), state: 'stopped', communication: 'disconnected' }; rows.set(saved.programId, row); inspectedRows.push({ id: saved.programId, previous: old, row, inspected });
    }
    this.validateAll(rows, inspectedRows.map(row => row.id));
    if (kind === 'module-group') for (const programId of before.group.memberProgramIds) if (!rows.has(programId))
      throw fault('VERSION_MEMBER_MISSING', `Historical group member ${programId} is no longer registered. Restore its registration before restoring this group.`);
    const nextGroup = kind === 'module-group' ? normalizeModuleGroup({ ...before.group,
      ...(before.group.origin ? { origin: { ...before.group.origin, members: { ...this.local.groups.get(id).origin?.members, ...before.group.origin.members } } } : {}) }, [...rows.keys()]) : null;
    const ids = inspectedRows.map(row => row.id), fingerprint = await this.fingerprint(ids), dataPolicy = input.dataPolicy ?? 'preserve';
    const after = kind === 'module' ? { ...rows.get(id).module, revision: configurationRevision(rows.get(id)) } : { id: nextGroup.origin?.id ?? nextGroup.id, version: nextGroup.origin?.version ?? null, revision: nextGroup.revision };
    const review = { format: REVIEW, kind, targetId: id, action: 'rollback', rollbackOf: selected.id, expectedRevision: current.revision, before: current, after, dataPolicy, configurationPolicy: 'historical', dataCompatibility: 'not-validated',
      programs: inspectedRows.map(item => ({ programId: item.id, change: 'update', before: moduleIdentity(item.previous), after: moduleIdentity(item.row), previousConfiguration: publicConfiguration(item.previous), settings: item.row.settings, topics: item.row.topics, bridges: item.row.bridges, bindings: item.row.bindings, executionPolicy: executionPolicy(item.row), executionPolicySource: 'local', manifest: item.row.manifest, sourceFiles: item.row.files, affected: this.effects(item.id, item.row, rows) })),
      executionPolicyBoundary: 'Rollback retains current local execution mode and caller authorization; it never restores historical caller grants.',
      removedMembers: kind === 'module-group' ? this.local.groups.get(id).memberProgramIds.filter(peer => !nextGroup.memberProgramIds.includes(peer)).map(programId => ({ programId, retainedRegistered: true, state: this.local.row(programId).state })) : [],
      group: nextGroup ? { before: clone(this.local.groups.get(id)), after: clone(nextGroup) } : null, startsModules: false, stopsOtherModules: false, preservesIdentity: true };
    const historicalStates = {};
    if (dataPolicy === 'restore') for (const item of inspectedRows) {
      const state = await inventory(join(this.directory, selected.id, 'before', item.id, 'state'));
      const expected = before.states[item.id]; if (state.digest !== expected.digest) throw fault('VERSION_SNAPSHOT_CHANGED', 'Historical private-state snapshot changed.'); historicalStates[item.id] = state;
    }
    review.digest = hash(JSON.stringify({ review, fingerprint: fingerprint.digest, historicalStates, inspected: inspectedRows.map(item => item.inspected.digest) }));
    return { review, inspectedRows, fingerprint, nextGroup, input: clone(input), selected, historicalStates };
  }
  apply(kind, id, input = {}) { return this.local.enqueue(() => this.applyNow(kind, id, input)); }
  async applyNow(kind, id, { reviewId, accepted, dataAcknowledged } = {}) {
    if (accepted !== true || dataAcknowledged !== true) throw fault('VERSION_TRUST_REQUIRED', 'Accept the exact code, permissions, wiring and unvalidated private-data compatibility review.');
    const saved = this.reviews.get(reviewId);
    if (!saved || Date.now() - saved.createdAt > 600000 || saved.review.kind !== kind || saved.review.targetId !== id) throw fault('VERSION_REVIEW_REQUIRED', 'Review this exact target version before applying it.');
    const candidate = saved.review.action === 'rollback' ? await this.prepareRollback(kind, id, saved.input) : await this.prepare(kind, id, saved.input, saved);
    if (candidate.review.digest !== saved.review.digest) throw fault('VERSION_REVIEW_CHANGED', 'Code, runtime, state, peers or group membership changed. Review the version transaction again.');
    if ((await this.journals()).length >= 4096) throw fault('VERSION_HISTORY_LIMIT', 'Version history is full. Retain its private snapshots; no new transaction was started.');
    const transactionId = randomUUID(), home = join(this.directory, transactionId); await mkdir(home, { mode: 0o700 });
    const recordsBefore = new Map(this.local.records), identitiesBefore = new Map(this.local.identities), groupsBefore = new Map(this.local.groups), planBefore = clone(this.local.startupPlanData);
    const existing = candidate.inspectedRows.filter(item => item.previous), programIds = candidate.inspectedRows.map(item => item.id);
    const before = { records: existing.map(item => clone(item.previous)), group: kind === 'module-group' ? clone(this.local.groups.get(id)) : null, startupPlan: planBefore, states: candidate.fingerprint.states };
    let journal = { format: FORMAT, id: transactionId, kind, targetId: id, createdAt: now(), action: saved.review.action, rollbackOf: saved.review.rollbackOf ?? null,
      before: clone(saved.review.before), after: clone(saved.review.after), dataPolicy: saved.review.dataPolicy, configurationPolicy: saved.review.configurationPolicy,
      beforeDigest: hash(JSON.stringify(before)), programIds, addedIds: candidate.inspectedRows.filter(item => !item.previous).map(item => item.id), status: 'preparing' };
    let journalWritten = false, switching = false, registryAttempted = false, committed = false;
    try {
      await privateJson(join(home, 'before.json'), before, { exclusive: true });
      for (const item of candidate.inspectedRows) {
        if (item.previous) {
          await copyInventory(this.local.path(item.id, 'module'), join(home, 'before', item.id, 'module'), { files: item.previous.files }, true);
          if (before.states[item.id].exists) await copyInventory(this.local.path(item.id, 'state'), join(home, 'before', item.id, 'state'), before.states[item.id]);
        }
        const destination = join(home, 'stage', item.id); await mkdir(destination, { recursive: true, mode: 0o700 });
        await copyInventory(item.inspected.directory, join(destination, 'module'), { files: item.inspected.files }, true);
        if (!item.previous) {
          const identity = { format: 'world-hub.local-program-identity/v1', programId: item.id, principal: item.row.principal, token: randomBytes(32).toString('base64url') };
          await privateJson(join(destination, 'identity.json'), identity, { exclusive: true });
        }
        if (saved.review.dataPolicy === 'fresh') await mkdir(join(destination, 'state'), { mode: 0o700 });
        if (saved.review.dataPolicy === 'restore' && candidate.historicalStates[item.id].exists) await copyInventory(join(this.directory, candidate.selected.id, 'before', item.id, 'state'), join(destination, 'state'), candidate.historicalStates[item.id]);
      }
      const final = saved.review.action === 'rollback' ? await this.prepareRollback(kind, id, saved.input) : await this.prepare(kind, id, saved.input, saved);
      if (final.review.digest !== saved.review.digest) throw fault('VERSION_REVIEW_CHANGED', 'The version transaction changed while snapshots were copied.');
      journal.switchPlan = [];
      for (const item of candidate.inspectedRows) {
        const identityPath = item.previous ? this.local.path(item.id, 'identity.json') : join(home, 'stage', item.id, 'identity.json');
        journal.switchPlan.push({ id: item.id, principal: item.row.principal,
          beforeRevision: item.previous ? configurationRevision(item.previous) : null, afterRevision: configurationRevision(item.row),
          beforeFiles: item.previous?.files ?? null, afterFiles: item.row.files, identityDigest: hash(JSON.stringify(await json(identityPath))),
          intendedState: saved.review.dataPolicy === 'preserve' ? candidate.fingerprint.states[item.id] ?? await inventory(join(home, 'stage', item.id, 'state'))
            : await inventory(join(home, 'stage', item.id, 'state')) });
      }
      await privateJson(join(home, 'journal.json'), journal, { exclusive: true }); journalWritten = true;
      for (const item of existing) await privateJson(this.local.path(item.id, 'version-transaction.json'), { transactionId }, { exclusive: true });
      journal.status = 'switching'; await privateJson(join(home, 'journal.json'), journal); switching = true;
      for (const item of candidate.inspectedRows) {
        const staged = join(home, 'stage', item.id);
        if (!item.previous) {
          if (!await missing(this.local.path(item.id))) throw fault('VERSION_DESTINATION_EXISTS', 'A new module destination already exists. Retain it for inspection.');
          await privateJson(join(staged, 'version-transaction.json'), { transactionId }, { exclusive: true }); await rename(staged, this.local.path(item.id));
        } else {
          const retained = join(home, 'retained', item.id); await mkdir(retained, { recursive: true, mode: 0o700 });
          await rename(this.local.path(item.id, 'module'), join(retained, 'module')); await rename(join(staged, 'module'), this.local.path(item.id, 'module'));
          if (saved.review.dataPolicy !== 'preserve') {
            if (!await missing(this.local.path(item.id, 'state'))) await rename(this.local.path(item.id, 'state'), join(retained, 'state'));
            if (!await missing(join(staged, 'state'))) await rename(join(staged, 'state'), this.local.path(item.id, 'state'));
          }
        }
      }
      // State is never interpreted or migrated. Capture the exact resulting
      // bytes separately from source and configuration history.
      const afterStates = {};
      for (const item of candidate.inspectedRows) {
        afterStates[item.id] = await inventory(this.local.path(item.id, 'state'));
        if (afterStates[item.id].exists) await copyInventory(this.local.path(item.id, 'state'), join(home, 'after', item.id, 'state'), afterStates[item.id]);
        await copyInventory(this.local.path(item.id, 'module'), join(home, 'after', item.id, 'module'), { files: item.row.files }, true);
      }
      const after = { records: candidate.inspectedRows.map(item => item.row), group: candidate.nextGroup ?? null, states: afterStates };
      await privateJson(join(home, 'after.json'), after, { exclusive: true });
      journal.afterDigest = hash(JSON.stringify(after));
      for (const item of existing) await this.local.updateCredentials?.({ credentials: {}, annotations: {}, remove: [item.previous.principal] }, {});
      for (const item of candidate.inspectedRows) {
        this.local.records.set(item.id, clone(item.row));
        if (!item.previous) this.local.identities.set(item.id, await json(this.local.path(item.id, 'identity.json')));
      }
      if (candidate.nextGroup) this.local.groups.set(id, clone(candidate.nextGroup));
      if (Object.hasOwn(this.local.startupPlanData, 'startupOrder')) this.local.startupPlanData = { ...this.local.startupPlanData, startupOrder: [...this.local.startupPlanData.startupOrder, ...journal.addedIds] };
      registryAttempted = true; await this.local.save();
      journal.status = 'committed'; await privateJson(join(home, 'journal.json'), journal); committed = true;
      let cleanupPending = false;
      for (const programId of programIds) try { await this.clearMarker(programId, transactionId); } catch { cleanupPending = true; }
      this.reviews.delete(reviewId);
      return { transactionId, kind, targetId: id, current: this.target(kind, id), programs: candidate.inspectedRows.map(item => this.local.public(this.local.row(item.id))), ...(candidate.nextGroup ? { group: clone(candidate.nextGroup) } : {}), dataPolicy: saved.review.dataPolicy, startsModules: false, preservesIdentity: true, ...(cleanupPending ? { cleanupPending: true } : {}) };
    } catch (issue) {
      // A durable commit must never be undone by a later response/marker error.
      if (committed) { this.reviews.delete(reviewId); throw issue; }
      this.local.records = recordsBefore; this.local.identities = identitiesBefore; this.local.groups = groupsBefore; this.local.startupPlanData = planBefore;
      this.reviews.delete(reviewId);
      if (journalWritten) {
        try {
          if (switching) await this.restoreBefore(journal, before);
          if (registryAttempted) await this.local.save();
          journal.status = 'rolled-back'; await privateJson(join(home, 'journal.json'), journal);
          for (const programId of programIds) await this.clearMarker(programId, transactionId);
        } catch (rollback) { throw Object.assign(fault('VERSION_RECOVERY_REQUIRED', 'The version transaction was interrupted. Its private snapshots were retained; recover it before starting affected modules.'), { transactionId, cleanupIncomplete: true, retainedDirectory: home, cause: rollback }); }
      }
      issue.retainedDirectory = home; throw issue;
    }
  }
  async clearMarker(programId, transactionId) {
    const path = this.local.path(programId, 'version-transaction.json'); if (await missing(path)) return;
    const value = await json(path); if (value.transactionId !== transactionId) throw fault('VERSION_RECOVERY_CONFLICT', 'The module has a different pending version transaction.'); await unlink(path);
  }
  async restoreBefore(journal, before) {
    const home = join(this.directory, journal.id);
    for (const saved of before.records) {
      const id = saved.programId, backup = join(home, 'before', id), destination = this.local.path(id), recovery = join(home, 'recovery-' + randomUUID(), id);
      await copyInventory(join(backup, 'module'), join(recovery, 'module'), { files: saved.files }, true);
      const state = before.states[id]; if (journal.dataPolicy !== 'preserve' && state.exists) await copyInventory(join(backup, 'state'), join(recovery, 'state'), state);
      await ordinaryPath(destination); const displaced = join(home, 'displaced-' + randomUUID(), id); await mkdir(displaced, { recursive: true, mode: 0o700 });
      if (!await missing(join(destination, 'module'))) await rename(join(destination, 'module'), join(displaced, 'module'));
      await rename(join(recovery, 'module'), join(destination, 'module'));
      if (journal.dataPolicy !== 'preserve') {
        if (!await missing(join(destination, 'state'))) await rename(join(destination, 'state'), join(displaced, 'state'));
        if (state.exists) await rename(join(recovery, 'state'), join(destination, 'state'));
      }
    }
    // New instance directories remain in place even when registration is
    // rolled back. Moving them before registry persistence could make restart
    // fail while reading the identity of a still-registered new member.
  }
  async assertRecoverable(journal, before) {
    if (!Array.isArray(journal.switchPlan) || journal.switchPlan.length !== journal.programIds.length)
      throw fault('VERSION_RECOVERY_CONFLICT', 'The interrupted transaction has no complete switching plan. Retain its snapshots for inspection.');
    for (const entry of journal.switchPlan) {
      if (!journal.programIds.includes(entry.id)) throw fault('VERSION_RECOVERY_CONFLICT', 'The transaction switching plan is inconsistent.');
      const current = this.local.records.get(entry.id);
      if (current && (current.principal !== entry.principal || ![entry.beforeRevision, entry.afterRevision].includes(configurationRevision(current))))
        throw fault('VERSION_RECOVERY_CONFLICT', 'An affected registration changed after the interrupted transaction.');
      const home = this.local.path(entry.id);
      if (await missing(home)) {
        if (!journal.addedIds.includes(entry.id)) throw fault('VERSION_RECOVERY_CONFLICT', 'An existing instance directory is missing.');
        continue;
      }
      if (hash(JSON.stringify(await json(join(home, 'identity.json')))) !== entry.identityDigest)
        throw fault('VERSION_IDENTITY_CHANGED', 'The interrupted instance identity changed. It will not be overwritten.');
      if (!await missing(join(home, 'module'))) {
        const files = JSON.stringify(await collectSourceFiles(join(home, 'module')));
        if (files !== JSON.stringify(entry.beforeFiles) && files !== JSON.stringify(entry.afterFiles))
          throw fault('VERSION_RECOVERY_CONFLICT', 'Affected source changed outside the interrupted transaction.');
      }
      if (journal.dataPolicy !== 'preserve') {
        const state = await inventory(join(home, 'state'));
        if (state.exists && state.digest !== before.states[entry.id]?.digest && state.digest !== entry.intendedState.digest)
          throw fault('VERSION_RECOVERY_CONFLICT', 'Affected private data changed after the interrupted transaction. It will not be overwritten.');
      }
    }
  }
  recover(kind, id, { transactionId } = {}) { return this.local.enqueue(async () => {
    this.target(kind, id); const journal = await this.transaction(transactionId);
    if (journal.kind !== kind || journal.targetId !== id) throw fault('VERSION_HISTORY_NOT_FOUND', 'This transaction belongs to another target.');
    if (journal.status === 'committed') {
      const after = await this.snapshot(journal, 'after');
      for (const row of after.records) {
        const marker = this.local.path(row.programId, 'version-transaction.json');
        if (await missing(marker) || (await json(marker)).transactionId !== transactionId) continue;
        const current = this.local.records.get(row.programId);
        if (!current || configurationRevision(current) !== configurationRevision(row)
            || JSON.stringify(await collectSourceFiles(this.local.path(row.programId, 'module'))) !== JSON.stringify(row.files))
          throw fault('VERSION_RECOVERY_CONFLICT', 'The committed instance changed after this transaction. Retain the marker for inspection.');
      }
      for (const programId of journal.programIds) await this.clearMarker(programId, transactionId);
      return { recovered: true, transactionId, status: journal.status, startsModules: false };
    }
    if (journal.status === 'rolled-back') { for (const programId of journal.programIds) await this.clearMarker(programId, transactionId); return { recovered: true, transactionId, status: journal.status, startsModules: false }; }
    for (const programId of journal.programIds) if (this.local.records.has(programId)) stopped(this.local, programId);
    const before = await this.snapshot(journal, 'before');
    await this.assertRecoverable(journal, before);
    await this.restoreBefore(journal, before);
    for (const programId of journal.addedIds) { this.local.records.delete(programId); this.local.identities.delete(programId); }
    for (const row of before.records) this.local.records.set(row.programId, clone(row));
    if (kind === 'module-group') this.local.groups.set(id, normalizeModuleGroup(before.group, [...this.local.records.keys()]));
    // Preserve unrelated registrations created after the interrupted operation.
    this.local.startupPlanData = { ...this.local.startupPlanData,
      members: this.local.startupPlanData.members.filter(member => !journal.addedIds.includes(member.programId))
        .map(member => ({ ...member, after: member.after.filter(peer => !journal.addedIds.includes(peer)) })),
      ...(Object.hasOwn(this.local.startupPlanData, 'startupOrder') ? { startupOrder: this.local.startupPlanData.startupOrder.filter(peer => !journal.addedIds.includes(peer)) } : {}) };
    await this.local.save(); journal.status = 'rolled-back'; await privateJson(join(this.directory, transactionId, 'journal.json'), journal);
    for (const programId of journal.programIds) await this.clearMarker(programId, transactionId);
    return { recovered: true, transactionId, status: journal.status, startsModules: false };
  }); }
}
