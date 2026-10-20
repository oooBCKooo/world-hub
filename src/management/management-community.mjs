// Local deployment recipes only. Hub Core never reads distribution manifests.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalPrograms } from '../../tools/launcher/local-programs.mjs';
import { normalizeModuleGroup, moduleGroupWiringBaseline } from '../../tools/launcher/module-groups.mjs';
import { importLocalArtifact } from '../../tools/launcher/local-artifacts.mjs';
import { readModuleGroup } from '../../scripts/runtime/module-group.mjs';
import { publishArtifact } from '../../scripts/runtime/sources.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { ordinaryPath, readBounded, privateJson, hash } from '../../scripts/runtime/paths.mjs';
import { resolveDefaultConnections } from '../../scripts/runtime/default-connections.mjs';
import { executionPolicy } from '../../tools/launcher/execution-policy.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const clone = value => structuredClone(value);
const principalFor = id => `local.${id.slice(0, 35)}.${hash(id).slice(0, 8)}`;
const sameContract = (left, right) => left.id === right.id && left.version === right.version;
// Bind the reviewed target configuration, rather than only its instance ID.
// Process state may change independently without changing this wiring review.
function connectionSnapshot(plan, programs) {
  return { topics: plan.topics, bindings: plan.bindings, connections: plan.connections.map(connection => ({
    id: connection.id, provider: connection.provider, providerId: connection.providerId, status: connection.status,
    target: programs.filter(program => connection.candidates.some(candidate => candidate.programId === program.programId)).map(program => ({
      programId: program.programId, module: program.module, principal: program.principal,
      configurationRevision: program.configurationRevision, topics: program.topics, bridges: program.bridges, provides: program.provides
    }))
  })) };
}

export class ManagementCommunity {
  constructor(owner) { this.owner = owner; this.reviews = new Map(); }
  get local() { return this.owner.localPrograms; }
  async prepare(directory, mapping, groupId) {
    const { manifest, modules } = await readModuleGroup(directory), local = this.local;
    if (local.groups.has(groupId)) throw fault('MODULE_GROUP_EXISTS', 'Choose a new group ID. Existing groups are retained.');
    if (local.groups.size >= 128 || local.records.size + modules.length > 128) throw fault('MODULE_GROUP_LIMIT', 'The group exceeds the local instance or group limit.');
    const staged = new LocalPrograms({ root: local.root, environment: local.environment, getHub: local.getHub,
      updateCredentials: local.updateCredentials, inspectDeployment: local.inspectDeployment, prepareDependencies: local.prepareDependencies });
    staged.records = new Map(local.records); staged.identities = new Map(local.identities);
    staged.groups = new Map(local.groups); staged.startupPlanData = clone(local.startupPlanData);
    staged.save = async () => {}; // Never write provisional peers to the real registry.
    for (const { member, manifest: declared, deployment } of modules) {
      const id = mapping[member.id];
      if (!id || staged.records.has(id)) throw fault('LOCAL_PROGRAM_EXISTS', 'The import instance ID is already registered.');
      const input = { ...member.configuration, bindings: member.configuration.bindings.map(binding => ({ ...binding, providerId: mapping[binding.providerId] })) };
      const configured = staged.configurationFor(input, declared, deployment ?? {});
      staged.records.set(id, { programId: id, principal: principalFor(id), manifest: declared, ...configured });
    }
    const members = [];
    for (const { member, directory: source } of modules) {
      const programId = mapping[member.id], provisional = staged.records.get(programId);
      staged.records.delete(programId);
      const input = { programId, directory: source, settings: provisional.settings, topics: provisional.topics, bridges: provisional.bridges, bindings: provisional.bindings };
      let preview;
      try { preview = await staged.preview(input, { executionDefaults: member.configuration.executionDefaults }); } finally { staged.records.set(programId, provisional); }
      members.push({ id: member.id, programId, review: preview.review });
    }
    const plan = manifest.startupPlan;
    const group = normalizeModuleGroup({ id: groupId, title: manifest.title, memberProgramIds: manifest.modules.map(member => mapping[member.id]),
      origin: { id: manifest.id, version: manifest.version, members: clone(mapping) },
      wiringBaseline: moduleGroupWiringBaseline(manifest),
      startupPlan: { ...plan, members: plan.members.map(member => ({ ...member, programId: mapping[member.programId], after: member.after.map(id => mapping[id]) })),
        startupOrder: plan.startupOrder.map(id => mapping[id]) } }, [...staged.records.keys()]);
    const review = { kind: 'module-group', manifest, group, members, startsModules: false, createsHub: false,
      changesPermissions: false, sandbox: false, digest: hash(JSON.stringify({ manifest, group, members })) };
    return { staged, review, modules };
  }
  async preview(input = {}) {
    const imported = await importLocalArtifact({ root: this.owner.root, path: input.path ?? input.directory, kind: input.kind });
    const { object } = imported;
    await this.owner.pathsService.remember({ path: object.path, purpose: object.kind, library: true });
    if (object.kind === 'module') {
      return this.local.enqueue(async () => {
        const inspected = await this.local.inspect(object.path, input), deployment = inspected.deploymentReview?.deployment ?? {};
        const providers = await this.local.programs();
        const defaults = resolveDefaultConnections({ manifest: inspected.manifest, deployment, programs: providers,
          programId: input.programId, selections: input.connectionSelections ?? {}, topics: input.topics, bindings: input.bindings });
        const genericRequirements = inspected.manifest.requires.filter(contract =>
          !(deployment.connections ?? []).some(connection => connection.contracts.some(required => sameContract(required, contract)))
          && !defaults.bindings.some(binding => sameContract(binding.contract, contract)));
        if (defaults.selectionRequired || genericRequirements.length) return {
          kind: 'module', object, selectionRequired: true, manifest: inspected.manifest, defaultConnections: defaults.connections,
          requiredProviders: genericRequirements.map(contract => ({ contract,
            candidates: providers.filter(program => program.provides.some(offered => offered.id === contract.id && offered.version === contract.version))
              .map(program => ({ programId: program.programId, module: program.module, state: program.state })) })), startsModules: false
        };
        const result = await this.local.preview({ ...input, topics: defaults.topics, bindings: defaults.bindings,
          directory: object.path, programId: input.programId ?? `module-${randomUUID().slice(0, 12)}` });
        const saved = this.local.reviews.get(result.reviewId);
        if (saved.inspected.digest !== inspected.digest) {
          this.local.reviews.delete(result.reviewId);
          throw fault('LOCAL_REVIEW_CHANGED', 'The module changed while resolving its default connections. Review it again.');
        }
        if (defaults.connections.length) {
          const snapshot = connectionSnapshot(defaults, providers);
          saved.defaultConnections = { input: clone(input), snapshot };
          saved.review.defaultConnections = clone(defaults.connections);
          saved.review.digest = hash(JSON.stringify({ review: saved.review.digest, connections: snapshot }));
          result.review = clone(saved.review);
        }
        return { ...result, kind: 'module', object };
      });
    }
    return this.local.enqueue(async () => {
      const { manifest } = await readModuleGroup(object.path);
      const prefix = randomUUID().slice(0, 8), mapping = Object.fromEntries(manifest.modules.map((member, i) => [member.id, `group-${prefix}-${i + 1}`]));
      const groupId = `group-${prefix}`, prepared = await this.prepare(object.path, mapping, groupId);
      const reviewId = randomUUID();
      this.reviews.set(reviewId, { directory: object.path, mapping, groupId, digest: prepared.review.digest, createdAt: Date.now() });
      while (this.reviews.size > 32) this.reviews.delete(this.reviews.keys().next().value);
      return { kind: 'module-group', reviewId, review: prepared.review, object, expiresAt: new Date(Date.now() + 600000).toISOString() };
    });
  }
  async apply(input = {}) {
    if (input.kind === 'module') return this.local.enqueue(async () => {
      const saved = this.local.reviewed(input.reviewId, 'register');
      if (saved.defaultConnections) {
        const providers = await this.local.programs(), original = saved.defaultConnections.input;
        let current;
        try {
          const plan = resolveDefaultConnections({ manifest: saved.inspected.manifest,
            deployment: saved.inspected.deploymentReview?.deployment ?? {}, programs: providers, programId: original.programId,
            selections: original.connectionSelections ?? {}, topics: original.topics, bindings: original.bindings });
          current = connectionSnapshot(plan, providers);
        } catch { throw fault('DEFAULT_CONNECTION_CHANGED', 'A default connection target changed after review. Review the module again.'); }
        if (JSON.stringify(current) !== JSON.stringify(saved.defaultConnections.snapshot))
          throw fault('DEFAULT_CONNECTION_CHANGED', 'A default connection target or its wiring changed after review. Review the module again.');
      }
      return this.local.registerNow(input);
    });
    if (input.accepted !== true) throw fault('TRUST_REQUIRED', 'Review each member, source, runtime, permissions and wiring before importing.');
    return this.local.enqueue(async () => {
      const saved = this.reviews.get(input.reviewId);
      if (!saved || Date.now() - saved.createdAt > 600000) throw fault('MODULE_GROUP_REVIEW_REQUIRED', 'Review this module group again.');
      const { staged, review, modules } = await this.prepare(saved.directory, saved.mapping, saved.groupId);
      if (review.digest !== saved.digest) throw fault('MODULE_GROUP_REVIEW_CHANGED', 'The source, environment or local peers changed after review. Review again.');
      if (this.local.closing) throw fault('MANAGEMENT_STOPPING', 'Wait until management finishes stopping.');
      // Provisional records permit cyclic capability references, but never escape
      // this isolated staging registry. Real records are committed in one save.
      try {
        for (const { member, directory } of modules) {
          const id = saved.mapping[member.id], provisional = staged.records.get(id);
          staged.records.delete(id);
          const current = await staged.preview({ programId: id, directory, settings: provisional.settings, topics: provisional.topics, bridges: provisional.bridges, bindings: provisional.bindings },
            { executionDefaults: member.configuration.executionDefaults });
          await staged.registerNow({ reviewId: current.reviewId, accepted: true });
        }
      } catch (error) {
        this.reviews.delete(input.reviewId);
        error.incompleteDestinations = review.group.memberProgramIds.map(id => this.local.path(id));
        throw error;
      }
      staged.groups.set(review.group.id, review.group);
      const previous = { records: this.local.records, identities: this.local.identities, groups: this.local.groups, startupPlanData: this.local.startupPlanData };
      Object.assign(this.local, { records: staged.records, identities: staged.identities, groups: staged.groups, startupPlanData: staged.startupPlanData });
      try { await this.local.save(); } catch (error) {
        Object.assign(this.local, previous); this.reviews.delete(input.reviewId);
        error.incompleteDestinations = review.group.memberProgramIds.map(id => this.local.path(id));
        throw error;
      }
      this.reviews.delete(input.reviewId);
      return { group: clone(review.group), programs: review.group.memberProgramIds.map(id => this.local.public(this.local.row(id))), startsModules: false, createsHub: false };
    });
  }
  async exportGroup(id, input = {}) {
    if (input.redistributionAcknowledged !== true) throw fault('REDISTRIBUTION_REQUIRED', 'Confirm you may redistribute every group member.');
    return this.local.enqueue(async () => {
      const group = this.owner.moduleGroups.row(id, input.expectedRevision);
      if (input.expectedRevision !== group.revision) throw fault('MODULE_GROUP_CHANGED', 'Reload the current group before export.');
      if (!group.memberProgramIds.length) throw fault('MODULE_GROUP_EMPTY', 'Choose at least one module.');
      const source = join(this.owner.root, 'exports', randomUUID(), 'source');
      await mkdir(source, { recursive: true, mode: 0o700 });
      const modules = []; let platforms;
      const logicalIds = new Map();
      for (const [logicalId, programId] of Object.entries(group.origin?.members ?? {}))
        if (group.memberProgramIds.includes(programId)) logicalIds.set(programId, logicalId);
      for (const programId of group.memberProgramIds) {
        if (logicalIds.has(programId)) continue;
        let logicalId = programId;
        while ([...logicalIds.values()].includes(logicalId) || Object.hasOwn(group.origin?.members ?? {}, logicalId)) logicalId = `member-${randomUUID().slice(0, 12)}`;
        logicalIds.set(programId, logicalId);
      }
      for (const programId of group.memberProgramIds) {
        const row = this.local.row(programId);
        const logicalId = logicalIds.get(programId);
        if (row.bindings.some(binding => !group.memberProgramIds.includes(binding.providerId))) throw fault('MODULE_GROUP_EXTERNAL_BINDING', 'Include every bound provider in the group before sharing.');
        const files = await collectSourceFiles(this.local.path(programId, 'module'));
        if (JSON.stringify(files) !== JSON.stringify(row.files)) throw fault('LOCAL_INSTALLED_CODE_CHANGED', 'Module source changed outside a reviewed update.');
        for (const file of files) {
          const target = join(source, 'modules', logicalId, file.path), bytes = await readBounded(this.local.path(programId, 'module', file.path), 8 * 1024 * 1024);
          if (hash(bytes) !== file.sha256) throw fault('LOCAL_INSTALLED_CODE_CHANGED', 'Source changed during export.');
          await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
        }
        platforms = platforms ? platforms.filter(platform => row.manifest.platforms.includes(platform)) : [...row.manifest.platforms];
        modules.push({ id: logicalId, path: `modules/${logicalId}`, moduleId: row.module.id, version: row.module.version,
          configuration: clone({ topics: row.topics, bridges: row.bridges, settings: row.settings,
            executionDefaults: (({ mode, idleTimeoutMs }) => ({ mode, idleTimeoutMs }))(executionPolicy(row)),
            bindings: row.bindings.map(binding => ({ ...binding, providerId: logicalIds.get(binding.providerId) })) }) });
      }
      const startupPlan = clone(group.startupPlan); delete startupPlan.format; delete startupPlan.revision; delete startupPlan.order;
      startupPlan.startupOrder ??= [...group.memberProgramIds];
      startupPlan.members = startupPlan.members.map(member => ({ ...member, programId: logicalIds.get(member.programId), after: member.after.map(id => logicalIds.get(id)) }));
      startupPlan.startupOrder = startupPlan.startupOrder.map(id => logicalIds.get(id));
      const provides = [...new Map(group.memberProgramIds.flatMap(programId => this.local.row(programId).manifest.provides).map(contract => [JSON.stringify([contract.id, contract.version]), contract])).values()];
      await privateJson(join(source, 'module-group.json'), { format: 'world-hub.module-group/v1', id: input.id ?? group.origin?.id ?? group.id, version: input.version,
        title: input.title ?? group.title, license: input.license ?? 'MIT', platforms, provides, requires: [], modules, startupPlan });
      const destination = await ordinaryPath(input.destination, { allowMissing: true });
      return publishArtifact(source, { kind: 'module-group', destination, redistributionAcknowledged: true });
    });
  }
}
