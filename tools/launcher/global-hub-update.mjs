// Reviewed, stopped-only updates to Launcher-owned program configuration.
// Private identities, runtime selections, state and source remain in place.
import { randomUUID } from 'node:crypto';
import { inspectAuthoring } from '../../scripts/runtime/authoring.mjs';
import { validatePack } from '../../scripts/runtime/package.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { deploymentTopics, validateDeploymentSettings } from '../../scripts/runtime/deployment.mjs';
import { hash } from '../../scripts/runtime/paths.mjs';
import { publicStartupPlan } from './startup-plan.mjs';
import { customizePackLineage } from '../../scripts/runtime/pack-lineage.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const error = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const contractEqual = (a, b) => a?.id === b?.id && a?.version === b?.version;
const stableVersion = value => typeof value === 'string' && value.length <= 128 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
function laterVersion(before, after) {
  if (!stableVersion(before) || !stableVersion(after)) return false;
  const a = before.split('.').map(BigInt), b = after.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return b[index] > a[index];
  return false;
}

export function globalAssemblyComposition(localPrograms) {
  const metadata = clone(localPrograms.assembly);
  const programs = [...localPrograms.records.values()].map(row => ({ programId: row.programId, module: row.module,
    manifest: row.manifest, files: row.files, settings: row.settings, topics: row.topics, bridges: row.bridges, bindings: row.bindings }));
  return { ...metadata, revision: hash(JSON.stringify({ metadata, programs, startupPlan: localPrograms.getStartupPlan() })) };
}
function stopped(localPrograms) {
  if (localPrograms.closing) throw error('LAUNCHER_STOPPING', 'Launcher is stopping.');
  for (const row of localPrograms.records.values()) {
    const handle = localPrograms.handles.get(row.programId);
    if (row.state !== 'stopped' || handle && (!handle.exit || handle.cleanupIncomplete))
      throw error('GLOBAL_ASSEMBLY_RUNNING', 'Stop every Launcher-managed program and confirm its exit before updating this local Hub composition. External processes are not controlled.');
  }
}
async function candidate({ localPrograms, directory, pack, expectedRevision, environment, startupPlan: planOptions, customizedAt }) {
  stopped(localPrograms);
  const composition = globalAssemblyComposition(localPrograms);
  if (composition.revision !== expectedRevision) throw error('GLOBAL_ASSEMBLY_CHANGED', 'The registered programs, source or wiring changed after this assembly draft. Load a fresh local Hub assembly.');
  validatePack(pack);
  if (pack.id !== composition.id) throw error('GLOBAL_ASSEMBLY_ID_CHANGED', 'Updating the original local Hub composition must retain its ID. Save a separate composition to use a different ID.');
  if (!laterVersion(composition.version, pack.version)) throw error('GLOBAL_ASSEMBLY_VERSION_REQUIRED', 'Choose a strictly higher stable composition version before updating the original.');
  if (planOptions !== undefined && (!planOptions || typeof planOptions !== 'object' || Array.isArray(planOptions)
      || Object.keys(planOptions).some(key => key !== 'onFailure') || !['continue-independent', 'stop-plan'].includes(planOptions.onFailure)))
    throw error('LOCAL_STARTUP_PLAN_INVALID', 'Choose an explicit local Hub startup failure policy.');
  // Only this reviewed transaction creates the next local revision. A browser
  // declaration cannot replace the first baseline or reset its revision count.
  pack = { ...clone(pack), lineage: customizePackLineage(composition, composition.revision, pack.version,
    customizedAt === undefined ? {} : { now: customizedAt }) };
  const original = await inspectAuthoring(directory, environment), rows = [...localPrograms.records.values()];
  if (['license', 'entry', 'startupTimeoutMs', 'healthTimeoutMs', 'stopTimeoutMs','packType','lifecyclePolicy'].some(key => !same(pack[key], original.pack[key])))
    throw error('GLOBAL_ASSEMBLY_LIFECYCLE_UNSUPPORTED', 'Updating the local Hub changes existing program settings and wiring. Save a new composition to change pack entry, license or lifecycle behavior.');
  if (pack.components.length !== rows.length || pack.components.some(component => !localPrograms.records.has(component.id)))
    throw error('GLOBAL_ASSEMBLY_MODULE_SET_CHANGED', 'Updating the original supports settings and wiring for its existing managed modules. Save a new composition for additions, removals or source replacements.');
  const configurations = [];
  for (const row of rows) {
    const component = pack.components.find(selected => selected.id === row.programId);
    if (Object.hasOwn(component,'critical'))
      throw error('GLOBAL_ASSEMBLY_LIFECYCLE_UNSUPPORTED', 'Critical-member group protection belongs to pack Runtime. The local Hub startup plan supports selection and ordering.');
    const source = original.review.modules.find(module => module.manifest.id === row.module.id);
    const files = await collectSourceFiles(localPrograms.path(row.programId, 'module'));
    if (!same(files, row.files)) throw error('LOCAL_INSTALLED_CODE_CHANGED', `Installed source changed for ${row.programId}. Register reviewed source again.`);
    if (component.module !== row.module.id || !source || !same(source.manifest, row.manifest) || !same(source.files, row.files))
      throw error('GLOBAL_ASSEMBLY_MODULE_SET_CHANGED', 'Updating the original retains exact registered module source. Save a new composition for source replacements.');
    if (Object.keys(component.bridges).length !== row.manifest.bridges.length || row.manifest.bridges.some(slot => !Object.hasOwn(component.bridges, slot)))
      throw error('GLOBAL_ASSEMBLY_BRIDGES_INVALID', `Bridge slots must match the registered module: ${row.programId}.`);
    if (!Object.hasOwn(component, 'topicAliases')) throw error('GLOBAL_ASSEMBLY_TOPICS_REQUIRED', 'Declare the complete per-program topic alias map before updating the local Hub composition.');
    const topics = deploymentTopics(pack, component, row.deployment), aliases = Object.keys(component.topicAliases);
    const bridges = Object.fromEntries(Object.entries(component.bridges).map(([slot, grants]) => [slot,
      Object.fromEntries(['publish', 'subscribe'].map(action => [action, grants[action].map(key => aliases.find(alias => component.topicAliases[alias] === key))]))]));
    validateDeploymentSettings(row.deployment, component.settings, { publicSource: true });
    const bindings = pack.bindings.filter(binding => binding.to === row.programId).map(binding => ({ providerId: binding.from, contract: clone(binding.contract) }));
    for (const required of row.manifest.requires) if (!bindings.some(binding => contractEqual(binding.contract, required)))
      throw error('LOCAL_PROVIDER_REQUIRED', `Select an installed provider for ${required.id}@${required.version}.`);
    for (const binding of bindings) {
      const provider = localPrograms.records.get(binding.providerId);
      if (binding.providerId === row.programId || !provider || !provider.manifest.provides.some(contract => contractEqual(contract, binding.contract))
          || !row.manifest.requires.some(contract => contractEqual(contract, binding.contract)))
        throw error('LOCAL_PROVIDER_INVALID', 'Capability bindings must match the exact registered provider and consumer contracts.');
    }
    configurations.push({ programId: row.programId, settings: clone(component.settings), topics, bridges, bindings });
  }
  if (original.review.modules.some(source => !rows.some(row => row.module.id === source.manifest.id)))
    throw error('GLOBAL_ASSEMBLY_MODULE_SET_CHANGED', 'The source draft contains a different module set. Save it as a new composition.');
  const startupPlan = publicStartupPlan({ format: localPrograms.getStartupPlan().format,
    onFailure: planOptions?.onFailure ?? localPrograms.getStartupPlan().onFailure,
    ...(Object.hasOwn(pack, 'startupOrder') ? { startupOrder: [...pack.startupOrder] } : {}), members: pack.components.map(component => ({ programId: component.id,
    enabled: component.autostart !== false, after: [...component.after] })) }, [...localPrograms.records.keys()]);
  return { composition, configurations, startupPlan, directory: original.directory,
    sourceRevision: original.revision, pack: clone(pack), digest: hash(JSON.stringify({ composition, configurations, startupPlan, sourceRevision: original.revision, pack })) };
}

export async function previewGlobalHubUpdate({ localPrograms, reviews, directory, pack, expectedRevision, environment, startupPlan }) {
  const checked = await candidate({ localPrograms, directory, pack, expectedRevision, environment, startupPlan });
  const reviewId = randomUUID(), createdAt = Date.now();
  const review = { format: 'world-hub.global-assembly-update-review/v1', beforeVersion: checked.composition.version,
    afterVersion: checked.pack.version, baselineRevision: checked.composition.revision, lineage: clone(checked.pack.lineage),
    ...(checked.composition.lineage ? { beforeLineage: clone(checked.composition.lineage) } : {}),
    programs: checked.configurations.map(configuration => ({ ...clone(configuration), module: clone(localPrograms.row(configuration.programId).module) })),
    startupPlan: clone(checked.startupPlan),
    startsModules: false, preservesPrivateState: true, altersSource: false, requiresStoppedPrograms: true };
  reviews.set(reviewId, { checked, review, createdAt });
  while (reviews.size > 32) reviews.delete(reviews.keys().next().value);
  return { reviewId, review, expiresAt: new Date(createdAt + 10 * 60000).toISOString() };
}

export async function applyGlobalHubUpdate({ localPrograms, reviews, reviewId, accepted, environment }) {
  const saved = reviews.get(reviewId);
  if (accepted !== true || !saved || Date.now() - saved.createdAt > 10 * 60000)
    throw error('GLOBAL_ASSEMBLY_REVIEW_REQUIRED', 'Review and accept the current stopped local Hub composition before updating it.');
  const fresh = await candidate({ localPrograms, directory: saved.checked.directory, pack: saved.checked.pack,
    expectedRevision: saved.checked.composition.revision, environment, startupPlan: { onFailure: saved.checked.startupPlan.onFailure },
    customizedAt: saved.checked.pack.lineage.customizedAt });
  if (fresh.digest !== saved.checked.digest) throw error('GLOBAL_ASSEMBLY_REVIEW_CHANGED', 'The reviewed source or settings changed. Inspect the composition update again.');
  const previous = { assembly: clone(localPrograms.assembly), startupPlanData: clone(localPrograms.startupPlanData), configurations: fresh.configurations.map(configuration => {
    const row = localPrograms.row(configuration.programId);
    return { programId: row.programId, settings: row.settings, topics: row.topics, bridges: row.bridges, bindings: row.bindings };
  }) };
  for (const configuration of fresh.configurations) Object.assign(localPrograms.row(configuration.programId), configuration);
  localPrograms.assembly = { id: fresh.pack.id, version: fresh.pack.version, title: fresh.pack.title, lineage: clone(fresh.pack.lineage) };
  localPrograms.startupPlanData = clone(fresh.startupPlan);
  try { await localPrograms.save(); }
  catch (issue) {
    localPrograms.assembly = previous.assembly;
    localPrograms.startupPlanData = previous.startupPlanData;
    for (const configuration of previous.configurations) Object.assign(localPrograms.row(configuration.programId), configuration);
    throw issue;
  }
  // A new composition version always needs new execution consent, including
  // version-only updates whose per-program configuration digest is unchanged.
  // Clear only after persistence succeeds; a failed update grants/revokes none.
  localPrograms.reviews.clear();
  reviews.delete(reviewId);
  return { composition: globalAssemblyComposition(localPrograms), version: fresh.pack.version,
    startupPlan: localPrograms.getStartupPlan(),
    programs: await localPrograms.programs(), startsModules: false, preservesPrivateState: true, altersSource: false };
}
