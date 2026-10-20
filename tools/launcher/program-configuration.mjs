// Direct instance transactions. No group or whole-workspace version is involved.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, ordinaryPath, readBounded } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { executionPolicy } from './execution-policy.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const fault = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const sameContract = (a, b) => a?.id === b?.id && a?.version === b?.version;
export function configurationRevision(row) {
  return hash(JSON.stringify({ programId: row.programId, module: row.module, manifest: row.manifest, deployment: row.deployment,
    settings: row.settings, topics: row.topics, bridges: row.bridges, bindings: row.bindings, environment: row.environment, files: row.files, executionPolicy: executionPolicy(row) }));
}
function stopped(local, id) {
  if (local.closing) throw fault('LAUNCHER_STOPPING', 'Launcher is stopping.');
  const row = local.row(id), handle = local.handles.get(id);
  if (row.state !== 'stopped' || handle && (!handle.exit || handle.cleanupIncomplete))
    throw fault('LOCAL_CONFIGURATION_REQUIRES_STOPPED', 'Stop only this module instance before changing its configuration or source.');
  return row;
}
function impacts(local, id, old, candidate) {
  const consumers = [...local.records.values()].filter(row => row.programId !== id && row.bindings.some(binding => binding.providerId === id)).map(row => ({
    programId: row.programId, state: row.state, contracts: row.bindings.filter(binding => binding.providerId === id).map(binding => binding.contract),
    sharedWithGroups: [...local.groups.values()].filter(group => group.memberProgramIds.includes(row.programId)).map(group => group.id) }));
  const missing = consumers.flatMap(row => row.contracts.filter(required => !candidate.manifest.provides.some(offered => sameContract(required, offered))).map(contract => ({ programId: row.programId, contract })));
  if (missing.length) throw Object.assign(fault('LOCAL_PROVIDER_CONTRACT_IN_USE', 'This source no longer provides contracts used by registered consumers. Rewire those consumers first.'), { consumers: missing });
  const ids = [...new Set([...old.bindings, ...candidate.bindings].map(binding => binding.providerId))];
  return { sharedWithGroups: [...local.groups.values()].filter(group => group.memberProgramIds.includes(id)).map(group => ({ id: group.id, title: group.title })), consumers,
    providers: ids.map(providerId => ({ programId: providerId, state: local.row(providerId).state,
      previousBindings: old.bindings.filter(binding => binding.providerId === providerId), nextBindings: candidate.bindings.filter(binding => binding.providerId === providerId) })),
    configurationBoundary: 'Running peers retain their previously launched configuration. Review and restart affected peers if their application requires the changed wiring; no peer is silently stopped or restarted.' };
}
async function candidate(local, id, input) {
  await local.assertVersionReady(id);
  const row = stopped(local, id);
  if (!input || Object.keys(input).some(key => !['expectedRevision', 'settings', 'topics', 'bridges', 'bindings', 'directory', 'nodePath', 'pythonPath'].includes(key)))
    throw fault('LOCAL_CONFIGURATION_INVALID', 'Edit public settings, topics, bridge permissions, capability bindings and an explicitly chosen source only.');
  if (input.expectedRevision !== configurationRevision(row)) throw fault('LOCAL_CONFIGURATION_CHANGED', 'The instance configuration changed. Reload it before reviewing.');
  const installed = await local.inspect(local.path(id, 'module'), row.environment);
  if (JSON.stringify(installed.files) !== JSON.stringify(row.files)) throw fault('LOCAL_INSTALLED_CODE_CHANGED', 'Installed source changed outside a reviewed update. Retain it for inspection.');
  const source = input.directory === undefined ? local.path(id, 'module') : input.directory;
  const inspected = await local.inspect(source, { ...row.environment, ...(input.nodePath ? { nodePath: input.nodePath } : {}), ...(input.pythonPath ? { pythonPath: input.pythonPath } : {}) });
  if (inspected.manifest.id !== row.module.id) throw fault('LOCAL_MODULE_ID_CHANGED', 'An instance source update must retain its module ID. Register a separate instance for another module.');
  if (inspected.manifest.version === row.module.version && JSON.stringify(inspected.files) !== JSON.stringify(row.files))
    throw fault('VERSION_VERSION_IMMUTABLE', 'Changed source needs a new module version. An existing release identity cannot name different bytes.');
  const config = local.configurationFor({ settings: input.settings ?? row.settings, topics: input.topics ?? row.topics,
    bridges: input.bridges ?? row.bridges, bindings: input.bindings ?? row.bindings }, inspected.manifest, inspected.deploymentReview?.deployment ?? {});
  for (const binding of config.bindings) await local.assertVersionReady(binding.providerId);
  local.validateBindings(id, inspected.manifest, config.bindings);
  const snapshot = local.peerSnapshot(id, inspected.manifest, config), affected = impacts(local, id, row, { ...config, manifest: inspected.manifest });
  const review = { format: 'world-hub.program-configuration-review/v1', programId: id, expectedRevision: input.expectedRevision,
    module: { id: inspected.manifest.id, version: inspected.manifest.version }, directory: inspected.directory,
    previous: { module: clone(row.module), settings: clone(row.settings), topics: clone(row.topics), bridges: clone(row.bridges), bindings: clone(row.bindings) },
    ...config, manifest: inspected.manifest, environment: inspected.environment, deployment: inspected.deploymentReview, sourceFiles: inspected.files,
    affected, peers: snapshot.peers, capabilityBindings: snapshot.bindings,
    replacesSource: JSON.stringify(row.files) !== JSON.stringify(inspected.files), preservesPrivateState: true, preservesIdentity: true,
    startsModules: false, stopsOtherModules: false, installsDependencies: false, sandbox: false, executionProfile: 'trusted-local' };
  review.digest = hash(JSON.stringify({ review, installed: installed.digest, inspected: inspected.digest }));
  return { review, inspected, input: clone(input) };
}
export async function previewProgramConfiguration(local, id, input = {}) {
  const checked = await candidate(local, id, input);
  return local.remember('configuration', checked.review, checked);
}
export async function applyProgramConfiguration(local, id, { reviewId, accepted } = {}) {
  if (accepted !== true) throw fault('TRUST_REQUIRED', 'Accept this exact instance configuration, source, runtime and affected peer review.');
  const saved = local.reviewed(reviewId, 'configuration', id), fresh = await candidate(local, id, saved.input);
  if (fresh.review.digest !== saved.review.digest) throw fault('LOCAL_REVIEW_CHANGED', 'Source, runtime, configuration or affected peers changed after review. Review again.');
  const old = local.row(id), row = clone(old), inspected = fresh.inspected, source = local.path(id, 'module');
  let stage, retainedSourceDirectory, moved = false;
  try {
    if (fresh.review.replacesSource) {
      stage = local.path(id, `source-update-${randomUUID()}`);
      await ordinaryPath(stage, { allowMissing: true }); await mkdir(stage, { mode: 0o700 });
      for (const file of inspected.files) {
        const destination = join(stage, file.path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const bytes = await readBounded(join(inspected.directory, file.path), 8 * 1024 * 1024);
        if (hash(bytes) !== file.sha256) throw fault('LOCAL_REVIEW_CHANGED', 'Source changed while copying the reviewed update.');
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      }
      if (JSON.stringify(await collectSourceFiles(stage)) !== JSON.stringify(inspected.files)) throw fault('LOCAL_REVIEW_CHANGED', 'Copied source does not match the reviewed update.');
      const rechecked = await candidate(local, id, saved.input);
      if (rechecked.review.digest !== saved.review.digest) throw fault('LOCAL_REVIEW_CHANGED', 'Source, runtime or peers changed while the update was copied.');
    }
    // Retire the stopped instance's old grants before storing new permissions.
    // A subsequent start installs only the newly reviewed concrete grants.
    await local.updateCredentials({ credentials: {}, annotations: {}, remove: [old.principal] }, {});
    const final = await candidate(local, id, saved.input);
    if (final.review.digest !== saved.review.digest) throw fault('LOCAL_REVIEW_CHANGED', 'The reviewed instance changed before commit.');
    if (stage) {
      const history = local.path(id, 'source-history'); await ordinaryPath(history, { allowMissing: true }); await mkdir(history, { recursive: true, mode: 0o700 });
      retainedSourceDirectory = join(history, randomUUID());
      await rename(source, retainedSourceDirectory);
      try { await rename(stage, source); moved = true; } catch (issue) { await rename(retainedSourceDirectory, source); throw issue; }
    }
    Object.assign(row, { module: fresh.review.module, manifest: inspected.manifest, deployment: inspected.deploymentReview?.deployment ?? null,
      settings: fresh.review.settings, topics: fresh.review.topics, bridges: fresh.review.bridges, bindings: fresh.review.bindings,
      environment: Object.fromEntries(Object.entries(inspected.environment).map(([kind, runtime]) => [`${kind}Path`, runtime.executable])),
      files: inspected.files, configuredAt: new Date().toISOString(), communication: 'disconnected' });
    local.records.set(id, row);
    try { await local.save(); } catch (issue) { local.records.set(id, old); throw issue; }
    local.reviews.delete(reviewId);
    return { program: local.public(row), configurationRevision: configurationRevision(row), startsModules: false, preservesPrivateState: true, preservesIdentity: true,
      affected: fresh.review.affected, ...(retainedSourceDirectory ? { retainedSourceDirectory } : {}) };
  } catch (issue) {
    if (moved) {
      try { await rename(source, stage); await rename(retainedSourceDirectory, source); }
      catch (rollback) {
        old.state = 'unknown'; old.error = { code: 'LOCAL_CONFIGURATION_ROLLBACK_INCOMPLETE', message: 'Source update rollback is incomplete. Retain all instance directories for inspection.' };
        local.records.set(id, old); try { await local.save(); } catch {}
        throw Object.assign(fault('LOCAL_CONFIGURATION_ROLLBACK_INCOMPLETE', 'Source update rollback is incomplete. Retain all instance directories; do not start it.'), { cleanupIncomplete: true,
          retainedDirectory: local.path(id), incompleteDestination: local.path(id), retainedSourceDirectory, stagedDirectory: stage, cause: rollback });
      }
    }
    if (stage) { issue.retainedStagingDirectory = stage; issue.incompleteDestination ??= stage; }
    throw issue;
  }
}
