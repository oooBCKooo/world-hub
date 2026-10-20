// Local deployment recipes only. Hub Core never reads distribution manifests.
import { randomUUID } from 'node:crypto';
import { importLocalArtifact } from '../../tools/launcher/local-artifacts.mjs';
import { hash } from '../../scripts/runtime/paths.mjs';
import { resolveDefaultConnections } from '../../scripts/runtime/default-connections.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const clone = value => structuredClone(value);
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
  constructor(owner) { this.owner = owner; }
  get local() { return this.owner.localPrograms; }
  async preview(input = {}) {
    const imported = await importLocalArtifact({ root: this.owner.root, path: input.path ?? input.directory, kind: input.kind });
    const { object } = imported;
    await this.owner.pathsService.remember({ path: object.path, purpose: object.kind, library: true });
    if (['configuration', 'data'].includes(object.kind)) return { kind: object.kind, object, ...await this.owner.resources.import({ path: object.path }, object.kind), requiresResourceReview: true, startsModules: false };
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
    throw fault('RESOURCE_KIND_INVALID', 'Import module, configuration or data resources.');
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
    throw fault('RESOURCE_REVIEW_REQUIRED', 'Apply configurations and data through their dedicated resource previews.');
  }
  async exportGroup(id, input = {}) {
    if (input.redistributionAcknowledged !== true) throw fault('REDISTRIBUTION_REQUIRED', 'Confirm that this public configuration may be redistributed.');
    const group = this.owner.moduleGroups.row(id, input.expectedRevision);
    if (input.expectedRevision !== group.revision) throw fault('MODULE_GROUP_CHANGED', 'Reload the current configuration scope before export.');
    return this.owner.resources.capture({ ...input, groupId: id, scope: 'local', id: input.id ?? group.origin?.id ?? group.id, title: input.title ?? group.title });
  }
}
