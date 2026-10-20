// Distribution resources and deployment plans. Hub Core never reads these records.
import { mkdir, writeFile, rename, readdir, lstat, rm } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalPrograms } from './local-programs.mjs';
import { configurationRevision } from './program-configuration.mjs';
import { executionPolicy } from './execution-policy.mjs';
import { initialExecutionPolicy } from '../../scripts/runtime/execution-defaults.mjs';
import { normalizeModuleGroup, moduleGroupWiringBaseline } from './module-groups.mjs';
import { publicStartupPlan } from './startup-plan.mjs';
import { importLocalArtifact } from './local-artifacts.mjs';
import { validateModule, safeId } from '../../scripts/runtime/package.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { ordinaryPath, readBounded, privateJson, hash, relativePath } from '../../scripts/runtime/paths.mjs';
import { publishArtifact, readSourceIndex, fetchSourceArtifact } from '../../scripts/runtime/sources.mjs';
import { validateConfiguration, validateData, validateConfigurationFiles, validateDataFiles, sourceFilesDigest, readResourceFiles } from '../../scripts/runtime/resource-artifacts.mjs';

const clone = value => structuredClone(value);
const fail = (code, message, details) => Object.assign(new Error(message), { code, status: 409, ...(details ? { details } : {}) });
const principalFor = id => `local.${id.slice(0, 35)}.${hash(id).slice(0, 8)}`;
const empty = () => ({ format: 'world-hub.resources/v1', profiles: [], bodies: [], data: [], active: [] });
const bodyKey = module => `${module.id}@${module.version}:${module.digest}`;
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const configOf = row => ({ topics: clone(row.topics), bridges: clone(row.bridges), settings: clone(row.settings), bindings: clone(row.bindings) });
const running = row => ['running', 'starting', 'stopping', 'unknown'].includes(row.state);
const membersEqual = (first, second) => first.length === second.length && first.every(id => second.includes(id));
const translatedPlan = (profile, mapping) => { const plan = profile.manifest.startupPlan; return { ...clone(plan),
  members: plan.members.map(row => ({ ...row, programId: mapping[row.programId], after: row.after.map(id => mapping[id]) })),
  startupOrder: plan.startupOrder.map(id => mapping[id]) }; };

export class ModuleResources {
  constructor(owner) {
    this.owner = owner; this.local = owner.localPrograms; this.root = join(owner.root, 'resources'); this.reviews = new Map();
  }
  get state() { return this.local.resourceState; }
  async initialize() {
    await ordinaryPath(this.root, { allowMissing: true }); await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.local.resourceState ??= empty();
    const value = this.state;
    if (value.format !== 'world-hub.resources/v1' || !['profiles', 'bodies', 'data', 'active'].every(key => Array.isArray(value[key]))
      || value.profiles.length > 256 || value.data.length > 256 || value.bodies.length > 4096) throw fail('RESOURCE_REGISTRY_INVALID', 'Inspect the local resource registry before continuing.');
    for (const p of value.profiles) {
      validateConfiguration(p.manifest);
      if (p.profileId !== 'c-' + hash(JSON.stringify(p.manifest)).slice(0, 32) || !p.mapping || typeof p.mapping !== 'object' || Array.isArray(p.mapping) || Object.keys(p.mapping).some(id => !p.manifest.modules.some(member => member.id === id)) || typeof p.retained !== 'boolean') throw fail('RESOURCE_REGISTRY_INVALID', 'Invalid saved configuration identity or mapping.');
      for (const id of Object.values(p.mapping)) safeId(id);
      if (p.groupId !== undefined) safeId(p.groupId, 'configuration group ID');
      if (p.ownsGroup !== undefined && typeof p.ownsGroup !== 'boolean') throw fail('RESOURCE_REGISTRY_INVALID', 'Invalid configuration group ownership.');
    }
    for (const d of value.data) { validateData(d.manifest); if (!/^[a-f0-9]{64}$/.test(d.contentDigest) || d.dataId !== 'd-' + d.contentDigest.slice(0, 32)) throw fail('RESOURCE_REGISTRY_INVALID', 'Invalid saved data identity.'); }
    for (const key of ['profiles', 'data']) if (new Set(value[key].map(row => `${row.manifest.id}@${row.manifest.version}`)).size !== value[key].length) throw fail('RESOURCE_REGISTRY_INVALID', 'Duplicate resource versions.');
    if (new Set(value.active).size !== value.active.length || value.active.some(id => !value.profiles.some(profile => profile.profileId === id))) throw fail('RESOURCE_REGISTRY_INVALID', 'Active configurations must refer to saved versions.');
    for (const b of value.bodies) { safeId(b.id); if (!/^[a-f0-9]{64}$/.test(b.digest) || b.path !== join(this.root, 'bodies', b.digest)) throw fail('RESOURCE_REGISTRY_INVALID', 'Body path is not in the resource pool.'); }
    this.local.resourceRecoveryGuard = async id => {
      try { const journal = JSON.parse(await readBounded(join(this.root, 'pending-data.json'))); if (journal.ids.includes(id)) throw fail('RESOURCE_RECOVERY_REQUIRED', 'Restore the interrupted data transaction before modifying or starting this instance.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  profile(id) { const p = this.state.profiles.find(row => row.profileId === id); if (!p) throw fail('CONFIGURATION_NOT_FOUND', 'Choose a saved configuration version.'); return p; }
  dataset(id) { const d = this.state.data.find(row => row.dataId === id); if (!d) throw fail('DATA_NOT_FOUND', 'Choose an imported dataset.'); return d; }
  revision() { return hash(JSON.stringify({ resources: this.state, programs: [...this.local.records.values()].map(row => [row.programId, configurationRevision(row)]), groups: [...this.local.groups.values()], plan: this.local.getStartupPlan() })); }
  checkRevision(value) { if (value !== undefined && value !== this.revision()) throw fail('RESOURCE_REVIEW_CHANGED', 'Resources or instance configuration changed. Reload before continuing.'); }
  async save(change) {
    const previous = clone(this.state);
    try { const result = await change(this.state); await this.local.save(); return result; }
    catch (error) { this.local.resourceState = previous; throw error; }
  }
  async body(ref) {
    const record = this.state.bodies.find(row => bodyKey(row) === bodyKey(ref));
    if (!record) return null;
    if (sourceFilesDigest(await collectSourceFiles(record.path)) !== ref.digest) throw fail('MODULE_BODY_CHANGED', 'A cached module body differs from its pinned source digest.');
    return record;
  }
  async addBody(directory) {
    directory = await ordinaryPath(directory);
    const manifestBytes = await readBounded(join(directory, 'module.json')), manifest = JSON.parse(manifestBytes); validateModule(manifest);
    const files = await collectSourceFiles(directory), digest = sourceFilesDigest(files);
    if (files.find(file => file.path === 'module.json')?.sha256 !== hash(manifestBytes)) throw fail('MODULE_BODY_CHANGED', 'Module identity changed while caching.');
    const ref = { id: manifest.id, version: manifest.version, digest };
    if (this.state.bodies.some(row => row.id === ref.id && row.version === ref.version && row.digest !== digest)) throw fail('MODULE_VERSION_CONFLICT', 'One module version cannot identify different source bytes.');
    const existing = await this.body(ref); if (existing) return existing;
    if (this.state.bodies.length >= 4096) throw fail('RESOURCE_LIMIT', 'At most 4096 cached module bodies are supported.');
    const destination = join(this.root, 'bodies', digest), stage = destination + '-' + randomUUID();
    await ordinaryPath(stage, { allowMissing: true }); await mkdir(stage, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const bytes = await readBounded(join(directory, file.path), 8 * 1024 * 1024);
      if (hash(bytes) !== file.sha256) throw fail('MODULE_BODY_CHANGED', 'Source changed while caching it.');
      const target = join(stage, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    if (!same(await collectSourceFiles(stage), files)) throw fail('MODULE_BODY_CHANGED', 'Copied source differs from the reviewed body.');
    try { await rename(stage, destination); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || sourceFilesDigest(await collectSourceFiles(destination)) !== digest) throw error;
      await this.removeOwned(stage);
    }
    const record = { ...ref, path: destination, files, manifest, addedAt: new Date().toISOString() };
    this.state.bodies.push(record); return record;
  }
  async removeOwned(path) {
    const target = resolve(path), base = resolve(this.root);
    if (!target.startsWith(base + sep) || target === base) throw fail('RESOURCE_PATH_INVALID', 'Deletion must remain inside the resource store.');
    await ordinaryPath(target); await rm(target, { recursive: true });
  }
  async missing(profile) {
    const missing = [];
    for (const member of profile.manifest.modules) if (!await this.body(member.module)) missing.push({ instanceId: member.id, ...member.module });
    return missing;
  }
  async overview() {
    return this.local.enqueue(async () => { let recoveryProgramIds = [], recoveryRequired = false;
      try { const journal = JSON.parse(await readBounded(join(this.root, 'pending-data.json'))); recoveryProgramIds = Array.isArray(journal.ids) ? journal.ids : []; recoveryRequired = true; }
      catch (error) { if (error.code !== 'ENOENT') recoveryRequired = true; }
      return { format: 'world-hub.resource-state/v1', revision: this.revision(), recoveryRequired, recoveryProgramIds, sources: clone(this.owner.sourceRegistry?.records ?? []),
      profiles: await Promise.all(this.state.profiles.map(async p => ({ ...clone(p), ...p.manifest, manifest: clone(p.manifest), active: this.state.active.includes(p.profileId), missingModules: await this.missing(p) }))),
      bodies: this.state.bodies.map(b => ({ ...clone(b), programIds: [...this.local.records.values()].filter(row => row.module.id === b.id && row.module.version === b.version && sourceFilesDigest(row.files) === b.digest).map(row => row.programId) })),
      data: this.state.data.map(d => ({ ...clone(d), ...d.manifest, manifest: clone(d.manifest) })), programs: [...this.local.records.values()].map(row => this.local.public(row)), activeProfileIds: clone(this.state.active) }; });
  }
  async import(input, expectedKind) {
    if (expectedKind === 'module') {
      const path = await ordinaryPath(input.path), info = await lstat(path);
      const indexPath = info.isDirectory() ? join(path, 'index.json') : path;
      let hasModule = false;
      if (info.isDirectory()) try { await lstat(join(path, 'module.json')); hasModule = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!hasModule && (info.isDirectory() || /[\\/]index\.json$/i.test(path))) {
        try { await lstat(indexPath); return this.importBodySet(indexPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return this.local.enqueue(async () => this.save(async () => {
      const { object } = await importLocalArtifact({ root: this.owner.root, path: input.path, ...(expectedKind ? { kind: expectedKind } : {}) });
      if (object.kind === 'module') return { body: await this.addBody(object.path), startsModules: false };
      if (!['configuration', 'data'].includes(object.kind)) throw fail('RESOURCE_KIND_INVALID', 'Import a module body, configuration or data artifact.');
      const name = object.kind === 'configuration' ? 'configuration.json' : 'data.json';
      const manifest = JSON.parse(await readBounded(join(object.path, name))), resourceFiles = await readResourceFiles(object.path), contentDigest = hash(JSON.stringify(resourceFiles.map(file => ({ path: file.path, sha256: hash(file.bytes) })))), digest = object.kind === 'data' ? contentDigest : hash(JSON.stringify(manifest));
      if (object.kind === 'configuration') validateConfigurationFiles(manifest, resourceFiles); else validateDataFiles(manifest, resourceFiles);
      const rows = object.kind === 'configuration' ? this.state.profiles : this.state.data;
      const key = object.kind === 'configuration' ? 'profileId' : 'dataId', value = (object.kind === 'configuration' ? 'c-' : 'd-') + digest.slice(0, 32);
      const old = rows.find(row => row.manifest.id === manifest.id && row.manifest.version === manifest.version);
      if (old && (!same(old.manifest, manifest) || object.kind === 'data' && old.contentDigest !== contentDigest)) throw fail('RESOURCE_VERSION_CONFLICT', 'A resource version cannot be replaced with different contents.');
      if (old) return { [object.kind === 'configuration' ? 'profile' : 'data']: clone(old), deduped: true, startsModules: false };
      if (rows.length >= 256) throw fail('RESOURCE_LIMIT', 'At most 256 saved configurations and datasets are supported.');
      const directory = join(this.root, object.kind === 'configuration' ? 'profiles' : 'data', value);
      await ordinaryPath(directory, { allowMissing: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const file of resourceFiles) { const target = join(directory, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 }); }
      const record = { [key]: value, manifest, path: directory, contentDigest, ...(object.kind === 'configuration' ? { mapping: {}, retained: false } : {}), importedAt: new Date().toISOString() };
      rows.push(record); return { [object.kind === 'configuration' ? 'profile' : 'data']: clone(record), path: directory, startsModules: false };
    }));
  }
  async retain(input) {
    return this.local.enqueue(async () => {
      this.checkRevision(input.expectedRevision);
      if (!Array.isArray(input.profileIds) || input.profileIds.length > 256 || new Set(input.profileIds).size !== input.profileIds.length) throw fail('CONFIGURATION_SELECTION_INVALID', 'Choose distinct saved configuration versions.');
      for (const id of input.profileIds) this.profile(id);
      await this.save(state => { for (const p of state.profiles) p.retained = input.profileIds.includes(p.profileId); });
      return { retainedProfileIds: input.profileIds, revision: this.revision(), startsModules: false };
    });
  }
  async deactivate(input) {
    if (input.accepted !== true) throw fail('RESOURCE_REVIEW_REQUIRED', 'Confirm deactivating the selected configuration references.');
    return this.local.enqueue(async () => {
      this.checkRevision(input.expectedRevision);
      if (!Array.isArray(input.profileIds) || !input.profileIds.length || new Set(input.profileIds).size !== input.profileIds.length || input.profileIds.some(id => !this.state.active.includes(id))) throw fail('CONFIGURATION_SELECTION_INVALID', 'Select currently active configuration versions.');
      const groups = this.local.groups;
      try { await this.save(state => {
        state.active = state.active.filter(id => !input.profileIds.includes(id));
        this.local.groups = this.retainedProfileGroups(new Map(groups), state.active);
      }); } catch (error) { this.local.groups = groups; throw error; }
      return { activeProfileIds: clone(this.state.active), preservesData: true, changesRunningState: false, revision: this.revision() };
    });
  }
  async exportProfile(input) {
    return this.local.enqueue(async () => {
      const profile = this.profile(input.profileId), directory = await this.exportDirectory(input, 'configuration');
      await privateJson(join(directory, 'configuration.json'), profile.manifest);
      const publication = await publishArtifact(directory, { kind: 'configuration', destination: directory + '-distribution', redistributionAcknowledged: true });
      return { directory, artifactPath: publication.artifactPath, profileId: profile.profileId, startsModules: false };
    });
  }
  async importBodySet(indexPath) {
    return this.local.enqueue(async () => this.save(async () => {
      const source = await readSourceIndex(indexPath), entries = source.index.entries;
      if (!entries.length || entries.length > 128 || entries.some(entry => entry.kind !== 'module' || !entry.source.path || entry.source.url)) throw fail('RESOURCE_BODY_SET_INVALID', 'Choose a local static index containing 1 to 128 module body artifacts.');
      const bodies = [];
      for (const entry of entries) {
        const artifact = await fetchSourceArtifact(indexPath, source.digest, entry.entryId, { cacheRoot: this.owner.sourceRegistry.cacheRoot });
        bodies.push(clone(await this.addBody(artifact.directory)));
      }
      return { bodies, startsModules: false, createsInstances: false };
    }));
  }
  closure(ids) {
    const kept = new Set(ids), pending = [...kept];
    while (pending.length) { const row = this.local.row(pending.pop()); for (const binding of row.bindings) if (!kept.has(binding.providerId)) { kept.add(binding.providerId); pending.push(binding.providerId); } }
    return [...kept];
  }
  selected(input, { dependencies = true } = {}) {
    if (!['global', 'local'].includes(input.scope)) throw fail('RESOURCE_SCOPE_INVALID', 'Choose global or local scope.');
    const ids = input.scope === 'global' ? [...this.local.records.keys()] : input.programIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 128 || new Set(ids).size !== ids.length) throw fail('RESOURCE_SELECTION_INVALID', 'Select one or more distinct local instances.');
    for (const id of ids) this.local.row(id);
    return dependencies ? this.closure(ids) : [...ids];
  }
  async exportDirectory(input, prefix) {
    const directory = input.destination ? resolve(input.destination) : join(this.root, 'exports', prefix + '-' + randomUUID());
    await ordinaryPath(directory, { allowMissing: true }); await mkdir(directory, { recursive: false, mode: 0o700 }).catch(async error => {
      if (error.code !== 'ENOENT') throw error; await mkdir(dirname(directory), { recursive: true, mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
    }); return directory;
  }
  async capture(input) {
    return this.local.enqueue(async () => this.save(async () => {
      if (this.state.profiles.length >= 256) throw fail('RESOURCE_LIMIT', 'At most 256 saved configuration versions are supported.');
      const group = input.groupId ? this.owner.moduleGroups.row(input.groupId, input.expectedRevision) : null;
      const ids = this.selected(group ? { ...input, scope: 'local', programIds: group.memberProgramIds } : input), logical = Object.fromEntries(ids.map(id => [id, id])), modules = [];
      for (const id of ids) {
        const row = this.local.row(id); await this.local.assertVersionReady(id);
        const body = await this.addBody(this.local.path(id, 'module'));
        if (!same(body.files, row.files)) throw fail('MODULE_BODY_CHANGED', 'An installed source differs from its registered source.');
        const policy = executionPolicy(row);
        modules.push({ id: logical[id], module: { id: body.id, version: body.version, digest: body.digest }, configuration: { ...configOf(row),
          bindings: row.bindings.map(binding => ({ ...clone(binding), providerId: logical[binding.providerId] })), executionDefaults: { mode: policy.mode, idleTimeoutMs: policy.idleTimeoutMs } } });
      }
      const previous = group?.startupPlan ?? this.local.getStartupPlan();
      const startupPlan = { members: ids.map(id => { const member = previous.members.find(row => row.programId === id); return { programId: logical[id], enabled: member?.enabled ?? false, after: (member?.after ?? []).filter(dep => ids.includes(dep)).map(dep => logical[dep]) }; }), onFailure: previous.onFailure,
        startupOrder: [...(previous.startupOrder ?? ids).filter(id => ids.includes(id)), ...ids.filter(id => !(previous.startupOrder ?? ids).includes(id))].map(id => logical[id]) };
      const manifest = validateConfiguration({ format: 'world-hub.configuration/v1', id: input.id, title: input.title, version: input.version,
        license: input.license ?? 'MIT', platforms: [`${process.platform}-${process.arch}`], provides: [], requires: [], scope: input.scope, modules, startupPlan });
      const prior = this.state.profiles.find(row => row.manifest.id === manifest.id && row.manifest.version === manifest.version);
      if (prior && !same(prior.manifest, manifest)) throw fail('RESOURCE_VERSION_CONFLICT', 'Save changed configuration under a new version.');
      const profileId = 'c-' + hash(JSON.stringify(manifest)).slice(0, 32), directory = await this.exportDirectory(input, 'configuration');
      await privateJson(join(directory, 'configuration.json'), manifest);
      const publication = await publishArtifact(directory, { kind: 'configuration', destination: directory + '-distribution', redistributionAcknowledged: true });
      const profile = prior ?? { profileId, manifest, path: directory, mapping: logical, retained: false };
      if (!prior) this.state.profiles.push(profile);
      return { profile: clone(profile), path: directory, artifactPath: publication.artifactPath, includedProgramIds: ids, startsModules: false };
    }));
  }
  stageLocal() {
    const local = this.local, stage = new LocalPrograms({ root: local.root, environment: local.environment, getHub: local.getHub,
      updateCredentials: local.updateCredentials, inspectDeployment: local.inspectDeployment, prepareDependencies: local.prepareDependencies });
    stage.records = new Map([...local.records].map(([id, row]) => [id, clone(row)])); stage.identities = new Map(local.identities); stage.groups = new Map(local.groups); stage.startupPlanData = clone(local.startupPlanData);
    stage.save = async () => {}; return stage;
  }
  profileOwnsGroup(profile, group) {
    // An ID prefix is never ownership evidence. Recognize old generated groups
    // only when their exact saved recipe and publisher mapping also agree.
    if (!group || !(profile.ownsGroup === true && profile.groupId === group.id
      || group.id === `configuration-${hash(profile.manifest.id).slice(0, 24)}`)) return false;
    const origin = group.origin, logical = profile.manifest.modules.map(member => member.id);
    return origin?.id === profile.manifest.id && origin.version === profile.manifest.version
      && membersEqual(Object.keys(origin.members), logical)
      && group.memberProgramIds.every(id => Object.values(origin.members).includes(id))
      && same(group.wiringBaseline, moduleGroupWiringBaseline(profile.manifest));
  }
  generatedProfileGroups() {
    return new Set([...this.local.groups.values()].filter(group => this.state.profiles.some(profile => this.profileOwnsGroup(profile, group))).map(group => group.id));
  }
  retainedProfileGroups(groups, activeIds, keepGroupId, rebindProfileIds = []) {
    for (const groupId of this.generatedProfileGroups()) {
      if (groupId === keepGroupId) continue;
      const group = groups.get(groupId);
      const retained = group && activeIds.some(id => {
        if (rebindProfileIds.includes(id)) return false;
        const profile = this.profile(id);
        return (profile.groupId === groupId || this.profileOwnsGroup(profile, group))
          && membersEqual(Object.values(profile.mapping), group.memberProgramIds);
      });
      if (!retained) groups.delete(groupId);
    }
    return groups;
  }
  configurationGroup(profile, mapping, replacement, requestedGroupId) {
    const ids = Object.values(mapping), generated = this.generatedProfileGroups();
    const matches = [...this.local.groups.values()].filter(group => membersEqual(group.memberProgramIds, ids));
    const business = matches.filter(group => !generated.has(group.id));
    let target;
    if (requestedGroupId !== undefined) {
      safeId(requestedGroupId, 'configuration group ID');
      target = matches.find(group => group.id === requestedGroupId);
      if (!target) return { groupId: requestedGroupId, conflicts: [{ code: 'CONFIGURATION_GROUP_MEMBERS_MISMATCH', groupId: requestedGroupId }] };
    } else if (business.length > 1) return { conflicts: [{ code: 'CONFIGURATION_GROUP_CHOICE_REQUIRED', groupIds: business.map(group => group.id).sort() }] };
    else target = business[0] ?? matches.find(group => group.id === profile.groupId) ?? matches.sort((a, b) => a.id.localeCompare(b.id))[0];
    const groupId = target?.id ?? `configuration-${hash(JSON.stringify([...ids].sort())).slice(0, 24)}`;
    if (!target && this.local.groups.has(groupId)) return { groupId, conflicts: [{ code: 'CONFIGURATION_GROUP_ID_CONFLICT', groupId }] };
    const retainedActive = this.state.active.filter(id => !replacement.includes(id) && id !== profile.profileId);
    const plan = translatedPlan(profile, mapping), rebindProfileIds = [], conflicts = [];
    for (const activeId of retainedActive) {
      const active = this.profile(activeId);
      if (!membersEqual(Object.values(active.mapping), ids)) continue;
      if (!same(translatedPlan(active, active.mapping), plan)) conflicts.push({ code: 'ACTIVE_CONFIGURATION_GROUP_CONFLICT', groupId, profileId: activeId });
      if (active.groupId !== groupId && [...this.local.groups.values()].some(group => generated.has(group.id)
        && (active.groupId === group.id || this.profileOwnsGroup(active, group)))) rebindProfileIds.push(activeId);
    }
    const prospective = this.retainedProfileGroups(new Map(this.local.groups), retainedActive, groupId, rebindProfileIds);
    if (!target && prospective.size >= 128) conflicts.push({ code: 'MODULE_GROUP_LIMIT' });
    return { groupId, createsGroup: !target, ownsGroup: !target || generated.has(groupId), updatesGroup: Boolean(target), rebindProfileIds,
      removesGroupIds: [...this.local.groups.keys()].filter(id => !prospective.has(id)), conflicts };
  }
  async configurationPlan(input) {
    const profile = this.profile(input.profileId), manifest = profile.manifest, mapping = Object.assign(Object.create(null), profile.mapping, input.mapping), missingModules = await this.missing(profile), conflicts = [], changes = [], adds = [], requiresStop = [];
    if (input.mapping && (typeof input.mapping !== 'object' || Array.isArray(input.mapping) || Object.keys(input.mapping).some(id => !manifest.modules.some(member => member.id === id)))) throw fail('CONFIGURATION_MAPPING_INVALID', 'Map only this configuration’s logical instances.');
    for (const member of manifest.modules) {
      if (!mapping[member.id]) {
        const candidates = [...this.local.records.values()].filter(row => row.module.id === member.module.id && row.module.version === member.module.version && sourceFilesDigest(row.files) === member.module.digest);
        if (candidates.length > 1) conflicts.push({ code: 'INSTANCE_CHOICE_REQUIRED', instanceId: member.id, candidates: candidates.map(row => row.programId) });
        mapping[member.id] = candidates.length === 1 ? candidates[0].programId : `cfg-${hash(profile.profileId + ':' + member.id).slice(0, 24)}`;
      }
      safeId(mapping[member.id], 'mapped instance');
    }
    if (new Set(Object.values(mapping)).size !== manifest.modules.length) throw fail('CONFIGURATION_MAPPING_INVALID', 'Each logical instance needs a distinct local instance.');
    const replacement = input.replaceProfileIds ?? this.state.active.filter(id => manifest.scope === 'global' || this.profile(id).manifest.id === manifest.id);
    if (!Array.isArray(replacement) || replacement.some(id => !this.state.active.includes(id))) throw fail('CONFIGURATION_SELECTION_INVALID', 'Replace only currently active configuration versions.');
    const stage = this.stageLocal(), inspected = new Map(), configured = new Map(), restored = new Map();
    for (const member of manifest.modules) {
      const id = mapping[member.id], body = await this.body(member.module); if (!body) continue;
      const found = await stage.inspect(body.path), inputConfig = { ...member.configuration, bindings: member.configuration.bindings.map(binding => ({ ...binding, providerId: mapping[binding.providerId] })) };
      const config = stage.configurationFor(inputConfig, found.manifest, found.deploymentReview?.deployment ?? {}), old = this.local.records.get(id);
      if (!old) {
        let retained;
        try {
          await lstat(this.local.path(id));
          const marker = await readBounded(this.local.path(id, 'retired-resource.json'), 64 * 1024 * 1024), archive = JSON.parse(marker), identityBytes = await readBounded(this.local.path(id, 'identity.json')), identity = JSON.parse(identityBytes);
          if (archive.format !== 'world-hub.retired-instance/v1' || archive.row?.programId !== id || archive.row.principal !== principalFor(id) || running(archive.row) || archive.row.module.id !== member.module.id || archive.row.module.version !== member.module.version || archive.identityDigest !== hash(identityBytes)
            || identity.programId !== id || identity.principal !== principalFor(id) || typeof identity.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(identity.token)
            || sourceFilesDigest(archive.row.files) !== member.module.digest || !same(await collectSourceFiles(this.local.path(id, 'module')), archive.row.files)) throw fail('INSTANCE_RETIRED_CHANGED', 'Retained instance metadata, source or identity changed. Select a new instance ID and explicitly restore its data.');
          executionPolicy(archive.row);
          retained = { ...archive, identity, digest: hash(marker) + ':' + hash(identityBytes) };
        } catch (error) {
          if (error.code !== 'ENOENT') conflicts.push({ code: error.code ?? 'INSTANCE_DIRECTORY_RETAINED', programId: id });
          else try { await lstat(this.local.path(id)); conflicts.push({ code: 'INSTANCE_DIRECTORY_RETAINED', programId: id }); } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
        }
        if (retained) restored.set(id, retained);
      }
      inspected.set(id, found); configured.set(id, config);
      if (old && (old.module.id !== member.module.id || old.module.version !== member.module.version || sourceFilesDigest(old.files) !== member.module.digest)) conflicts.push({ code: 'INSTANCE_BODY_CONFLICT', programId: id, expected: member.module, actual: old.module });
      if (old && !same(await collectSourceFiles(this.local.path(id, 'module')), old.files)) conflicts.push({ code: 'INSTANCE_BODY_CHANGED', programId: id });
      const changed = old && !same(configOf(old), config);
      if (changed) {
        changes.push({ programId: id, previous: configOf(old), next: config });
        if (running(old) || this.local.handles.get(id) && !this.local.handles.get(id).exit) requiresStop.push(id);
        for (const activeId of this.state.active.filter(key => key !== profile.profileId && !replacement.includes(key))) {
          const active = this.profile(activeId); if (Object.values(active.mapping).includes(id)) conflicts.push({ code: 'ACTIVE_CONFIGURATION_CONFLICT', programId: id, profileId: activeId });
        }
      }
      if (!old && !restored.has(id)) adds.push({ programId: id, instanceId: member.id, module: member.module });
      stage.records.set(id, old || restored.has(id) ? { ...clone(old ?? restored.get(id).row), ...config } : { programId: id, principal: principalFor(id), module: { id: found.manifest.id, version: found.manifest.version }, manifest: found.manifest, deployment: found.deploymentReview?.deployment ?? null, ...config,
        executionPolicy: initialExecutionPolicy(found.deploymentReview?.deployment, member.configuration.executionDefaults), environment: {}, files: found.files, state: 'stopped' });
    }
    if (stage.records.size > 128) conflicts.push({ code: 'LOCAL_PROGRAM_LIMIT' });
    const group = this.configurationGroup(profile, mapping, replacement, input.groupId);
    conflicts.push(...group.conflicts);
    if (!missingModules.length && !conflicts.length) for (const member of manifest.modules) stage.validateBindings(mapping[member.id], inspected.get(mapping[member.id]).manifest, configured.get(mapping[member.id]).bindings);
    const retainedActiveInstances = new Set(this.state.active.filter(id => !replacement.includes(id)).flatMap(id => Object.values(this.profile(id).mapping)));
    for (const id of replacement.flatMap(id => Object.values(this.profile(id).mapping))) if (!Object.values(mapping).includes(id) && !retainedActiveInstances.has(id) && this.local.records.has(id) && running(this.local.row(id))) requiresStop.push(id);
    const review = { profileId: profile.profileId, scope: manifest.scope, mapping, replaceProfileIds: replacement, missingModules, conflicts, changes, adds, requiresStop: [...new Set(requiresStop)],
      group: { groupId: group.groupId, createsGroup: group.createsGroup, ownsGroup: group.ownsGroup, updatesGroup: group.updatesGroup,
        rebindProfileIds: group.rebindProfileIds ?? [], removesGroupIds: group.removesGroupIds ?? [] },
      restores: [...restored].map(([programId, value]) => ({ programId, module: value.row.module, metadataDigest: value.digest })), blocked: Boolean(missingModules.length || conflicts.length), preservesData: true, startsModules: false, removesInstances: false, revision: this.revision(), sourceReviews: [...inspected].map(([id, value]) => [id, value.digest]) };
    return { profile, stage, inspected, configured, restored, review, input: { ...clone(input), mapping, replaceProfileIds: replacement } };
  }
  remember(kind, prepared) { const reviewId = randomUUID(); this.reviews.set(reviewId, { kind, ...prepared, digest: hash(JSON.stringify(prepared.review)), createdAt: Date.now() }); while (this.reviews.size > 32) this.reviews.delete(this.reviews.keys().next().value); return { reviewId, review: clone(prepared.review) }; }
  reviewed(input, kind) { const review = this.reviews.get(input.reviewId); if (input.accepted !== true || !review || review.kind !== kind || Date.now() - review.createdAt > 600000) throw fail('RESOURCE_REVIEW_REQUIRED', 'Accept a current resource preview before applying.'); return review; }
  async preview(input) { return this.local.enqueue(async () => { this.checkRevision(input.expectedRevision); return this.remember('configuration', await this.configurationPlan(input)); }); }
  async apply(input) {
    return this.local.enqueue(async () => {
      const saved = this.reviewed(input, 'configuration'), fresh = await this.configurationPlan(saved.input);
      if (hash(JSON.stringify(fresh.review)) !== saved.digest) throw fail('RESOURCE_REVIEW_CHANGED', 'The configuration, sources or affected instances changed. Preview again.');
      if (fresh.review.blocked) throw fail('CONFIGURATION_BLOCKED', 'Resolve missing modules and configuration conflicts first.', fresh.review);
      if (fresh.review.requiresStop.length && input.stopOwned !== true) throw fail('CONFIGURATION_STOP_REQUIRED', 'Accept stopping the affected owned instances.');
      const stoppedProgramIds = [];
      try { for (const id of fresh.review.requiresStop) { await this.local.stopNow(id); stoppedProgramIds.push(id); } }
      catch (error) { this.reviews.delete(input.reviewId); error.stoppedProgramIds = stoppedProgramIds; error.registrationsRetained = true; throw error; }
      const { stage, profile, inspected, configured } = fresh, before = { records: this.local.records, identities: this.local.identities, groups: this.local.groups, startupPlanData: this.local.startupPlanData, resourceState: clone(this.state) };
      for (const id of fresh.review.requiresStop) if (stage.records.has(id) && this.local.records.has(id)) stage.records.set(id, { ...clone(this.local.row(id)), ...configured.get(id) });
      const additions = new Set(fresh.review.adds.map(row => row.programId));
      try {
        for (const member of profile.manifest.modules) {
          const id = fresh.review.mapping[member.id]; await this.local.assertVersionReady(id);
          if (fresh.restored.has(id)) {
            stage.identities.set(id, fresh.restored.get(id).identity);
            const row = stage.row(id); row.state = 'stopped'; row.communication = 'disconnected'; delete row.error;
          } else if (additions.has(id)) {
            stage.records.delete(id);
            const review = await stage.preview({ programId: id, directory: inspected.get(id).directory, ...configured.get(id) }, { executionDefaults: member.configuration.executionDefaults });
            await stage.registerNow({ reviewId: review.reviewId, accepted: true });
          } else {
            if (fresh.review.changes.some(change => change.programId === id)) {
              const row = stage.row(id); Object.assign(row, configured.get(id), { configuredAt: new Date().toISOString() });
              await this.local.updateCredentials({ credentials: {}, annotations: {}, remove: [row.principal] }, {});
            }
          }
        }
        const ids = profile.manifest.modules.map(member => fresh.review.mapping[member.id]);
        const translated = translatedPlan(profile, fresh.review.mapping);
        if (profile.manifest.scope === 'global') {
          const all = [...stage.records.keys()]; stage.startupPlanData = publicStartupPlan({ ...translated, members: [...translated.members, ...all.filter(id => !ids.includes(id)).map(programId => ({ programId, enabled: false, after: [] }))], startupOrder: [...translated.startupOrder, ...all.filter(id => !ids.includes(id))] }, all);
        }
        const { groupId, ownsGroup, rebindProfileIds } = fresh.review.group;
        const remainingActive = this.state.active.filter(id => !fresh.review.replaceProfileIds.includes(id) && id !== profile.profileId);
        stage.groups = this.retainedProfileGroups(stage.groups, remainingActive, groupId, rebindProfileIds);
        const existingGroup = stage.groups.get(groupId);
        stage.groups.set(groupId, normalizeModuleGroup(ownsGroup ? { id: groupId, title: profile.manifest.title, memberProgramIds: ids, startupPlan: translated,
          origin: { id: profile.manifest.id, version: profile.manifest.version, members: fresh.review.mapping }, wiringBaseline: moduleGroupWiringBaseline(profile.manifest) }
          : { ...existingGroup, startupPlan: translated }, [...stage.records.keys()]));
        // Runtime callbacks retain their row object. Never replace a live,
        // unchanged instance with a validation clone.
        const changedIds = new Set(fresh.review.changes.map(change => change.programId));
        for (const [id, row] of this.local.records) if (!additions.has(id) && !changedIds.has(id)) stage.records.set(id, row);
        this.local.records = stage.records; this.local.identities = stage.identities; this.local.groups = stage.groups; this.local.startupPlanData = stage.startupPlanData;
        profile.mapping = clone(fresh.review.mapping); profile.groupId = groupId; profile.ownsGroup = ownsGroup;
        for (const id of rebindProfileIds) Object.assign(this.profile(id), { groupId, ownsGroup });
        this.state.active = [...remainingActive, profile.profileId];
        await this.local.save(); this.reviews.delete(input.reviewId);
        return { profile: clone(profile), mapping: clone(profile.mapping), revision: this.revision(), preservesData: true, startsModules: false, stoppedProgramIds: fresh.review.requiresStop };
      } catch (error) { Object.assign(this.local, before); this.reviews.delete(input.reviewId); error.incompleteDestinations = [...additions].map(id => this.local.path(id)); error.stoppedProgramIds = stoppedProgramIds; error.credentialsMayBeRevoked = fresh.review.changes.length > 0; error.registrationsRetained = true; throw error; }
    });
  }
  async prepare(input) {
    if (input.accepted !== true) throw fail('RESOURCE_DOWNLOAD_REVIEW_REQUIRED', 'Accept downloading the configuration’s pinned modules without executing them.');
    return this.local.enqueue(async () => this.save(async () => {
      const profile = this.profile(input.profileId), requested = await this.missing(profile), fetched = [], unavailable = [];
      const sources = [];
      for (const row of [...this.owner.sourceRegistry.records].filter(row => row.enabled).sort((a, b) => b.priority - a.priority)) {
        const chosen = await this.owner.sourceRegistry.resolve({ sourceId: row.id });
        try { const index = await readSourceIndex(chosen.source, chosen); await this.owner.sourceRegistry.assertCurrent(chosen); sources.push({ chosen, index }); }
        catch (error) { unavailable.push({ sourceId: row.id, code: error.code ?? 'SOURCE_UNAVAILABLE' }); }
      }
      for (const ref of requested) {
        if (await this.body(ref)) continue;
        let found = false;
        for (const { chosen, index } of sources) {
          const candidates = index.index.entries.filter(entry => entry.kind === 'module' && entry.id === ref.id && entry.version === ref.version);
          for (const entry of candidates) {
            const result = await fetchSourceArtifact(chosen.source, index.digest, entry.entryId, { ...chosen, cacheRoot: this.owner.sourceRegistry.cacheRoot });
            await this.owner.sourceRegistry.assertCurrent(chosen);
            if (sourceFilesDigest(await collectSourceFiles(result.directory)) !== ref.digest) { unavailable.push({ sourceId: chosen.sourceId, entryId: entry.entryId, code: 'MODULE_BODY_CONFLICT' }); continue; }
            const body = await this.addBody(result.directory); fetched.push({ id: body.id, version: body.version, digest: body.digest, sourceId: chosen.sourceId }); found = true; break;
          }
          if (found) break;
        }
      }
      return { fetched, missingModules: await this.missing(profile), unavailableSources: unavailable, startsModules: false, installsDependencies: false };
    }));
  }
  async exportBodies(input) {
    return this.local.enqueue(async () => this.save(async () => {
      const ids = this.selected(input), directory = await this.exportDirectory(input, 'bodies'), bodies = new Map();
      for (const id of ids) { const row = this.local.row(id), body = await this.addBody(this.local.path(id, 'module')); if (!same(body.files, row.files)) throw fail('MODULE_BODY_CHANGED', 'Installed source changed.'); bodies.set(bodyKey(body), body); }
      const entries = [];
      for (const body of bodies.values()) {
        const subdir = body.digest, publication = await publishArtifact(body.path, { kind: 'module', destination: join(directory, subdir), redistributionAcknowledged: true });
        entries.push({ ...publication.index.entries[0], source: { path: `${subdir}/artifact.json` } });
      }
      const index = { format: 'world-hub.source-index/v1', id: input.id ?? 'exported-module-bodies', title: input.title ?? 'Module bodies', entries };
      await privateJson(join(directory, 'index.json'), index);
      return { directory, path: directory, indexPath: join(directory, 'index.json'), modules: [...bodies.values()].map(({ id, version, digest }) => ({ id, version, digest })), startsModules: false };
    }));
  }
  async assertStopped(id) {
    await this.local.assertVersionReady(id); const row = this.local.row(id), handle = this.local.handles.get(id);
    if (row.state !== 'stopped' || handle && (!handle.exit || handle.cleanupIncomplete)) throw fail('RESOURCE_REQUIRES_STOPPED', 'Stop the affected owned instances before reading or restoring a consistent data snapshot.', { programId: id });
  }
  async exportData(input) {
    return this.local.enqueue(async () => this.save(async () => {
      if (this.state.data.length >= 256) throw fail('RESOURCE_LIMIT', 'At most 256 saved dataset versions are supported.');
      const ids = this.selected(input, { dependencies: false });
      if (!['backup', 'dataset'].includes(input.purpose) || input.purpose === 'dataset' && input.publicDataAcknowledged !== true) throw fail('DATA_PUBLIC_REVIEW_REQUIRED', 'Choose private backup, or explicitly confirm the selected application data may be redistributed.');
      for (const id of ids) await this.assertStopped(id);
      const directory = await this.exportDirectory(input, 'data'), instances = [];
      for (const id of ids) {
        const row = this.local.row(id), body = await this.addBody(this.local.path(id, 'module')), path = `data/${id}`;
        if (!same(body.files, row.files)) throw fail('MODULE_BODY_CHANGED', 'Installed source changed after registration.');
        const from = this.local.path(id, 'state'); await mkdir(from, { recursive: true, mode: 0o700 });
        const files = await readResourceFiles(from);
        await mkdir(join(directory, path), { recursive: true, mode: 0o700 });
        for (const file of files) { const target = join(directory, path, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 }); }
        if (!same(files.map(file => [file.path, hash(file.bytes)]), (await readResourceFiles(from)).map(file => [file.path, hash(file.bytes)]))) throw fail('DATA_CHANGED', 'Application data changed while capturing the snapshot.');
        instances.push({ id, module: { id: body.id, version: body.version, digest: body.digest }, path, dataFormat: input.dataFormat ?? { id: 'opaque-instance-state', version: '1.0.0' } });
      }
      const manifest = validateData({ format: 'world-hub.module-data/v1', id: input.id, version: input.version, title: input.title, license: input.license ?? 'MIT',
        platforms: [`${process.platform}-${process.arch}`], provides: [], requires: [], scope: input.scope, purpose: input.purpose, instances });
      await privateJson(join(directory, 'data.json'), manifest);
      const publication = await publishArtifact(directory, { kind: 'data', destination: directory + '-distribution', redistributionAcknowledged: true });
      const all = await readResourceFiles(directory), contentDigest = hash(JSON.stringify(all.map(file => ({ path: file.path, sha256: hash(file.bytes) })))), dataId = 'd-' + contentDigest.slice(0, 32);
      const previous = this.state.data.find(row => row.manifest.id === manifest.id && row.manifest.version === manifest.version);
      if (previous && previous.contentDigest !== contentDigest) throw fail('RESOURCE_VERSION_CONFLICT', 'Changed data needs a new dataset version.');
      const record = previous ?? { dataId, manifest, path: directory, contentDigest, importedAt: new Date().toISOString() };
      if (!previous) this.state.data.push(record);
      return { data: clone(record), path: directory, artifactPath: publication.artifactPath, snapshotOnly: true, includesHubLog: false, includesLocalCredentials: false };
    }));
  }
  async dataPlan(input) {
    const data = this.dataset(input.dataId), mapping = input.mapping ?? {}, entries = [], conflicts = [];
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).some(id => !data.manifest.instances.some(member => member.id === id))) throw fail('DATA_MAPPING_INVALID', 'Map dataset logical instances to local instances.');
    const files = await readResourceFiles(data.path), digest = hash(JSON.stringify(files.map(file => ({ path: file.path, sha256: hash(file.bytes) }))));
    if (digest !== data.contentDigest) throw fail('DATA_CHANGED', 'Dataset bytes changed after import.');
    for (const member of data.manifest.instances) {
      const id = Object.hasOwn(mapping, member.id) ? mapping[member.id] : undefined; if (!id) { conflicts.push({ instanceId: member.id, code: 'DATA_MAPPING_REQUIRED' }); continue; }
      const row = this.local.row(id); await this.assertStopped(id);
      const actualFiles = await collectSourceFiles(this.local.path(id, 'module'));
      if (row.module.id !== member.module.id || row.module.version !== member.module.version || sourceFilesDigest(row.files) !== member.module.digest || !same(actualFiles, row.files)) conflicts.push({ programId: id, code: 'DATA_MODULE_CONFLICT', expected: member.module, actual: row.module });
      const state = this.local.path(id, 'state'); await mkdir(state, { recursive: true, mode: 0o700 });
      entries.push({ instanceId: member.id, programId: id, path: member.path, previous: (await readResourceFiles(state)).map(file => ({ path: file.path, sha256: hash(file.bytes) })) });
    }
    if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw fail('DATA_MAPPING_INVALID', 'Two data instances cannot overwrite the same target.');
    return { data, files, review: { dataId: data.dataId, mapping: clone(mapping), entries, conflicts, blocked: Boolean(conflicts.length), purpose: data.manifest.purpose,
      revision: this.revision(), contentDigest: digest, preservesIdentity: true, replacesData: true, requiresCompatibilityAcknowledgement: true, startsModules: false } };
  }
  async previewData(input) { return this.local.enqueue(async () => this.remember('data', await this.dataPlan(input))); }
  async applyData(input) {
    return this.local.enqueue(async () => {
      const saved = this.reviewed(input, 'data');
      if (input.dataCompatibilityAcknowledged !== true) throw fail('DATA_COMPATIBILITY_REQUIRED', 'Confirm that module-defined data compatibility was checked; management does not migrate business data.');
      const fresh = await this.dataPlan(saved.review);
      if (fresh.review.blocked || hash(JSON.stringify(fresh.review)) !== saved.digest) throw fail('RESOURCE_REVIEW_CHANGED', 'Dataset or instance data changed. Preview again.');
      const transaction = join(this.root, 'data-transactions', randomUUID()); await mkdir(transaction, { recursive: true, mode: 0o700 });
      const moves = [];
      for (const entry of fresh.review.entries) {
        const stage = join(transaction, entry.programId, 'after'), backup = join(transaction, entry.programId, 'before'); await mkdir(stage, { recursive: true, mode: 0o700 });
        for (const file of fresh.files.filter(file => file.path.startsWith(entry.path + '/'))) {
          const target = join(stage, file.path.slice(entry.path.length + 1)); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
        }
        moves.push({ programId: entry.programId, stage, backup, state: this.local.path(entry.programId, 'state') });
      }
      const journalPath = join(this.root, 'pending-data.json');
      try { await lstat(journalPath); throw fail('RESOURCE_RECOVERY_REQUIRED', 'Recover the pending data transaction first.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await privateJson(journalPath, { format: 'world-hub.data-transaction/v1', ids: moves.map(row => row.programId), moves });
      try {
        for (const move of moves) { await rename(move.state, move.backup); await rename(move.stage, move.state); }
        await rename(journalPath, join(transaction, 'committed.json')); this.reviews.delete(input.reviewId);
        return { restoredProgramIds: moves.map(row => row.programId), retainedPreviousData: moves.map(row => ({ programId: row.programId, path: row.backup })), startsModules: false, preservesIdentity: true };
      } catch (error) {
        try { await this.rollbackData(moves); await rename(journalPath, join(transaction, 'rolled-back.json')); }
        catch { throw fail('RESOURCE_RECOVERY_REQUIRED', 'Data restore was interrupted; instances remain blocked until recovery.', { transaction }); }
        throw error;
      }
    });
  }
  async rollbackData(moves) {
    // Validate every journal entry before moving any directory. An interrupted
    // transaction must never turn an edited journal into a filesystem command.
    if (!Array.isArray(moves) || !moves.length || moves.length > 128) throw fail('RESOURCE_PATH_INVALID', 'Invalid recovery journal.');
    const transactionRoot = resolve(this.root, 'data-transactions') + sep;
    for (const move of moves) {
      safeId(move.programId);
      if (typeof move.backup !== 'string' || typeof move.stage !== 'string' || !resolve(move.backup).startsWith(transactionRoot) || dirname(move.stage) !== dirname(move.backup) || move.backup !== join(dirname(move.stage), 'before') || move.stage !== join(dirname(move.backup), 'after') || move.state !== this.local.path(move.programId, 'state')) throw fail('RESOURCE_PATH_INVALID', 'Invalid recovery target.');
      await ordinaryPath(move.backup, { allowMissing: true }); await ordinaryPath(move.stage, { allowMissing: true }); await ordinaryPath(move.state, { allowMissing: true });
    }
    for (const move of [...moves].reverse()) {
      const backup = await ordinaryPath(move.backup, { allowMissing: true });
      if (!resolve(backup).startsWith(resolve(this.root, 'data-transactions') + sep) || move.state !== this.local.path(move.programId, 'state')) throw fail('RESOURCE_PATH_INVALID', 'Invalid recovery target.');
      try { await lstat(backup); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try { await lstat(move.state); await rename(move.state, move.stage + '-failed-' + randomUUID()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(backup, move.state);
    }
  }
  async recoverData(input) {
    if (input.accepted !== true) throw fail('RESOURCE_REVIEW_REQUIRED', 'Accept restoring the pre-transaction data.');
    return this.local.enqueue(async () => {
      const path = join(this.root, 'pending-data.json'), journal = JSON.parse(await readBounded(path));
      if (journal.format !== 'world-hub.data-transaction/v1' || !Array.isArray(journal.ids) || !Array.isArray(journal.moves) || !same(journal.ids, journal.moves.map(row => row.programId)) || new Set(journal.ids).size !== journal.ids.length) throw fail('RESOURCE_PATH_INVALID', 'Invalid recovery journal.');
      for (const id of journal.ids) { const row = this.local.row(id); if (running(row) || this.local.handles.get(id) && !this.local.handles.get(id).exit) throw fail('RESOURCE_REQUIRES_STOPPED', 'Stop affected instances before recovery.'); }
      await this.rollbackData(journal.moves); await rename(path, path + '.recovered-' + randomUUID()); return { recovered: true, startsModules: false };
    });
  }
  async cleanupPlan(input) {
    for (const [key, maximum] of [['keepProfileIds', 256], ['keepProgramIds', 128]]) if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > maximum || new Set(input[key]).size !== input[key].length || input[key].some(id => typeof id !== 'string' || !id))) throw fail('RESOURCE_SELECTION_INVALID', 'Select distinct configuration and instance IDs as arrays.');
    if (input.removeUnreferencedBodies !== undefined && typeof input.removeUnreferencedBodies !== 'boolean') throw fail('RESOURCE_SELECTION_INVALID', 'Choose explicitly whether unused body caches should be removed.');
    const keepProfileIds = [...new Set([...this.state.active, ...this.state.profiles.filter(row => row.retained).map(row => row.profileId), ...(input.keepProfileIds ?? [])])];
    for (const id of keepProfileIds) this.profile(id);
    const roots = new Set(input.keepProgramIds ?? []), reasons = new Map();
    const keep = (id, reason) => { this.local.row(id); roots.add(id); reasons.set(id, [...(reasons.get(id) ?? []), reason]); };
    for (const id of [...roots]) keep(id, 'manual');
    for (const id of keepProfileIds) {
      const profile = this.profile(id);
      for (const member of profile.manifest.modules) {
        const mapped = profile.mapping[member.id];
        if (mapped && this.local.records.has(mapped)) keep(mapped, `configuration:${id}`);
        else for (const row of this.local.records.values()) if (row.module.id === member.module.id && row.module.version === member.module.version && sourceFilesDigest(row.files) === member.module.digest) keep(row.programId, `unmapped-configuration:${id}`);
      }
    }
    for (const row of this.local.records.values()) if (running(row) || this.local.handles.get(row.programId)?.cleanupIncomplete) keep(row.programId, 'running-or-ownership-protected');
    const retainedIds = this.closure([...roots]), retained = new Set(retainedIds), removable = [];
    for (const id of retainedIds) if (!reasons.has(id)) reasons.set(id, ['dependency']);
    for (const row of this.local.records.values()) if (!retained.has(row.programId)) { await this.local.assertVersionReady(row.programId); removable.push({ programId: row.programId, module: clone(row.module), state: row.state, configurationRevision: configurationRevision(row) }); }
    const bodyRoots = new Set(keepProfileIds.flatMap(id => this.profile(id).manifest.modules.map(member => bodyKey(member.module))));
    for (const id of retainedIds) { const row = this.local.row(id); bodyRoots.add(bodyKey({ ...row.module, digest: sourceFilesDigest(row.files) })); }
    const bodyCandidates = [];
    if (input.removeUnreferencedBodies === true) for (const body of this.state.bodies) if (!bodyRoots.has(bodyKey(body))) { await this.body(body); bodyCandidates.push({ id: body.id, version: body.version, digest: body.digest, path: body.path }); }
    const review = { keepProfileIds, retained: retainedIds.map(programId => ({ programId, reasons: reasons.get(programId) })), removable, removableBodies: bodyCandidates, blocked: false,
      requiresStop: [], preservesData: true, preservesSavedConfigurations: true, revision: this.revision(), protectedRunningInstances: retainedIds.filter(id => running(this.local.row(id))) };
    return { review, input: clone(input) };
  }
  async previewCleanup(input) { return this.local.enqueue(async () => this.remember('cleanup', await this.cleanupPlan(input))); }
  async applyCleanup(input) {
    return this.local.enqueue(async () => {
      const saved = this.reviewed(input, 'cleanup'), fresh = await this.cleanupPlan(saved.input);
      if (hash(JSON.stringify(fresh.review)) !== saved.digest) throw fail('RESOURCE_REVIEW_CHANGED', 'References or protected instances changed. Preview cleanup again.');
      const plan = this.local.getStartupPlan();
      const removed = new Set(fresh.review.removable.map(row => row.programId)), before = { records: new Map(this.local.records), identities: new Map(this.local.identities), handles: new Map(this.local.handles), groups: new Map(this.local.groups), startupPlanData: clone(this.local.startupPlanData), resourceState: clone(this.state) };
      try {
        const principals = [...removed].map(id => this.local.row(id).principal);
        if (principals.length) await this.local.updateCredentials({ credentials: {}, annotations: {}, remove: principals }, {});
        for (const id of removed) { await this.local.markResourceRetired(id); this.local.records.delete(id); this.local.identities.delete(id); this.local.handles.delete(id); }
        for (const [id, group] of this.local.groups) if (group.memberProgramIds.some(id => removed.has(id))) {
          const members = group.memberProgramIds.filter(id => !removed.has(id));
          const plan = group.startupPlan;
          this.local.groups.set(id, normalizeModuleGroup({ ...group, memberProgramIds: members, startupPlan: { ...plan, members: plan.members.filter(row => !removed.has(row.programId)).map(row => ({ ...row, after: row.after.filter(id => !removed.has(id)) })), startupOrder: plan.startupOrder?.filter(id => !removed.has(id)) } }, [...this.local.records.keys()]));
        }
        const ids = [...this.local.records.keys()];
        this.local.startupPlanData = publicStartupPlan({ ...plan, members: plan.members.filter(row => !removed.has(row.programId)).map(row => ({ ...row, after: row.after.filter(id => !removed.has(id)) })), ...(plan.startupOrder ? { startupOrder: plan.startupOrder.filter(id => !removed.has(id)) } : {}) }, ids);
        const digests = new Set(fresh.review.removableBodies.map(row => row.digest)); this.state.bodies = this.state.bodies.filter(row => !digests.has(row.digest));
        await this.local.save(); this.reviews.delete(input.reviewId);
      } catch (error) { Object.assign(this.local, before); error.credentialsMayBeRevoked = removed.size > 0; throw error; }
      for (const id of removed) { clearInterval(this.local.monitors.get(id)); this.local.monitors.delete(id); }
      // Commit references first. A crash can leave an unused cached directory,
      // but can never leave a live registry pointing at a moved-away body.
      const disposalFailures = []; for (const body of fresh.review.removableBodies) try { await this.removeOwned(body.path); } catch { disposalFailures.push(body.path); }
      return { removedProgramIds: [...removed], removedBodies: fresh.review.removableBodies, preservesData: true, preservesSavedConfigurations: true,
        retainedInstanceDirectories: [...removed].map(id => this.local.path(id)), disposalFailures, revision: this.revision() };
    });
  }
  async dispatch(method, operation, input = {}) {
    if (method === 'GET' && !operation) return this.overview();
    if (method !== 'POST') throw fail('RESOURCE_ROUTE_INVALID', 'Unsupported resource operation.');
    const routes = {
      'bodies/import': () => this.import(input, 'module'), 'bodies/export': () => this.exportBodies(input),
      'sources/save': () => this.owner.sourceRegistry.save(input), 'sources/remove': () => this.owner.sourceRegistry.delete(input.sourceId),
      'profiles/import': () => this.import(input, 'configuration'), 'profiles/capture': () => this.capture(input), 'profiles/retain': () => this.retain(input), 'profiles/deactivate': () => this.deactivate(input), 'profiles/export': () => this.exportProfile(input),
      'profiles/preview': () => this.preview(input), 'profiles/apply': () => this.apply(input), 'profiles/prepare': () => this.prepare(input),
      'cleanup/preview': () => this.previewCleanup(input), 'cleanup/apply': () => this.applyCleanup(input),
      'data/import': () => this.import(input, 'data'), 'data/export': () => this.exportData(input), 'data/preview': () => this.previewData(input), 'data/apply': () => this.applyData(input), 'data/recover': () => this.recoverData(input)
    };
    if (!routes[operation]) throw fail('RESOURCE_ROUTE_INVALID', 'Unknown resource operation.'); return routes[operation]();
  }
}
