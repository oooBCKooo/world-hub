// Optional new-instance upgrade preparation. No automatic start, cutover or Core policy.
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { instancePath, inspectPackage, importPackage, safeId } from './package.mjs';
import { ordinaryPath, hash, readBounded } from './paths.mjs';
import { withStoppedInstance, backupStoppedInstance, persistentFiles, restoreInstance } from './maintenance.mjs';
import { assertNoIncompleteUpgrades, compareUpgradePackages, validateUpgradeStatePolicies, previewUpgrade, upgradeInstance, rollbackBoundary } from './upgrade.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const within = (directory, path) => { const local = relative(resolve(directory), resolve(path)); return !local || local !== '..' && !local.startsWith('..' + sep) && !/^[A-Za-z]:/.test(local); };
const cancelled = signal => { if (signal?.aborted) throw fault('UPGRADE_ABORTED', 'New-instance preparation cancelled; the old instance was not switched'); };

async function sourceSnapshot(directory, stopped, current, options) {
  if ((await inspectPackage(join(directory, 'package'), options)).digest !== current.digest)
    throw fault('UPGRADE_CHANGED', 'The old package or interpreter changed during preparation');
  // Unknown persistent roots must not disappear behind a reassuring backup label.
  if (await exists(join(directory, 'programs'))) {
    const ids = new Set(current.pack.components.map(c => c.id));
    for (const entry of await readdir(join(directory, 'programs'), { withFileTypes: true }))
      if (!entry.isDirectory() || !ids.has(entry.name)) throw fault('UPGRADE_STATE_UNKNOWN', 'Undeclared program state needs an author-defined backup decision');
  }
  if (await exists(join(directory, 'hub'))) for (const name of await readdir(join(directory, 'hub')))
    if (!['log', 'blobs', 'management.json'].includes(name)) throw fault('UPGRADE_STATE_UNKNOWN', 'Unknown Hub state paths require inspection before preparation');
  const contents = await persistentFiles(directory, current, options.signal);
  const runtimeFiles = {};
  for (const name of ['instance.json', 'status.json', 'control.json']) runtimeFiles[name] = await exists(join(directory, name)) ? hash(await readBounded(join(directory, name))) : null;
  return { digest: hash(JSON.stringify({ contents, runtimeFiles })),
    files: contents.files.length, bytes: contents.files.reduce((total, file) => total + file.bytes, 0),
    consistency: stopped.status ? 'confirmed-stopped' : 'never-started' };
}
function validateStatePolicy(options) {
  if (!['fresh', 'provider'].includes(options.statePolicy)) throw fault('UPGRADE_POLICY_REQUIRED', 'Choose fresh data or explicit provider-defined state inheritance');
  if (options.statePolicy === 'fresh' && options.statePolicies !== undefined && (!Array.isArray(options.statePolicies) || options.statePolicies.length))
    throw fault('UPGRADE_POLICY_INVALID', 'Fresh-data preparation does not apply preservation or migration policies');
}
async function stagedPlan(directory, stopped, options) {
  safeId(options.newInstanceId, 'new instance ID');
  if (options.newInstanceId === options.instanceId) throw fault('UPGRADE_TARGET_INVALID', 'The trial must use a different new instance ID');
  validateStatePolicy(options); cancelled(options.signal);
  await assertNoIncompleteUpgrades(directory);
  if (await exists(join(directory, 'detached.json'))) throw fault('INSTANCE_DETACHED', 'Reattach the old instance before preparing its upgrade');
  const current = await inspectPackage(join(directory, 'package'), options), candidate = await inspectPackage(options.candidate, options);
  if (current.digest !== stopped.identity.digest) throw fault('UPGRADE_CHANGED', 'The old instance package or interpreter differs from its identity');
  const targetDirectory = await ordinaryPath(instancePath(options.root, options.newInstanceId), { allowMissing: true });
  if (await exists(targetDirectory)) throw fault('UPGRADE_TARGET_EXISTS', 'The new instance already exists; choose another ID rather than overwriting it');
  const backupDestination = await ordinaryPath(options.backupDestination, { allowMissing: true });
  if (within(directory, backupDestination) || within(targetDirectory, backupDestination) || within(candidate.directory, backupDestination))
    throw fault('BACKUP_PATH', 'Choose a new private backup file outside the old instance, new instance and candidate package');
  if (await exists(backupDestination)) throw fault('BACKUP_EXISTS', 'The backup destination exists; choose a new file rather than replacing a snapshot');
  // Reuse the exact same provider policy checks, without running their migrations.
  const statePolicies = options.statePolicy === 'provider' ? validateUpgradeStatePolicies(current, candidate, options.statePolicies) : [];
  const snapshot = await sourceSnapshot(directory, stopped, current, options);
  const data = options.statePolicy === 'fresh'
    ? { mode: 'fresh', programState: 'not-inherited', hubState: 'not-inherited', migration: 'not-requested', compatibility: 'not-applicable-to-fresh-data' }
    : { mode: 'provider', programState: 'private-copy', hubState: 'exact-version-private-copy',
      migration: statePolicies.some(p => p.mode === 'migrate') ? 'author-migration-required' : 'provider-preservation-declared',
      compatibility: 'provider-declared-business-validation-pending' };
  const trustDigest = hash(JSON.stringify({ operation: 'staged-upgrade', sourceDirectory: directory, instanceId: options.instanceId,
    newInstanceId: options.newInstanceId, targetDirectory, backupDestination, sourceDigest: current.digest, candidateDigest: candidate.digest,
    candidateDirectory: candidate.directory, snapshot: snapshot.digest, data, statePolicies }));
  return { format: 'world-hub.staged-upgrade-preview/v1', instanceId: options.instanceId, newInstanceId: options.newInstanceId,
    sourceDirectory: directory, targetDirectory, backupDestination, trustDigest, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), current: { digest: current.digest, pack: { id: current.pack.id, version: current.pack.version } },
    candidate: { digest: candidate.digest, directory: candidate.directory, pack: { id: candidate.pack.id, version: candidate.pack.version }, permissions: candidate.permissions },
    diff: compareUpgradePackages(current, candidate), data, statePolicies, snapshot, startsModules: false,
    backup: { private: true, mayIncludeApplicationSecrets: true, consistency: snapshot.consistency, excludesGeneratedRuntimeFiles: true },
    runsMigrations: statePolicies.some(p => p.mode === 'migrate'), sandbox: false, changesOldInstance: false, deletesOldInstance: false,
    cutover: 'manual-after-independent-review-and-business-validation', rollbackBoundary,
    _current: current, _candidate: candidate };
}
const publicPlan = ({ _current, _candidate, ...plan }) => plan;

/** Read-only stopped-instance review; all source data and candidate files bind approval. */
export async function previewStagedUpgrade(options) {
  return withStoppedInstance(options, async (directory, stopped) => publicPlan(await stagedPlan(directory, stopped, options)));
}

/** Consistent old backup, then a new stopped candidate. Execution review is always separate. */
export async function createStagedUpgrade(options) {
  return withStoppedInstance(options, async (directory, stopped) => {
    const plan = await stagedPlan(directory, stopped, options);
    if (options.trust !== plan.trustDigest) throw fault('UPGRADE_TRUST_REQUIRED', 'Accept the current new-instance preview, private backup path, candidate and state policy');
    cancelled(options.signal);
    const backup = await backupStoppedInstance(directory, stopped, { ...options, destination: plan.backupDestination });
    if ((await sourceSnapshot(directory, stopped, plan._current, options)).digest !== plan.snapshot.digest)
      throw Object.assign(fault('UPGRADE_CHANGED', 'Old data changed while backing up; no new instance was imported'), { backup });
    let target;
    try {
      cancelled(options.signal);
      if (options.statePolicy === 'fresh') target = await importPackage(plan._candidate.directory, { ...options, instanceId: options.newInstanceId });
      else {
        target = await restoreInstance({ ...options, instanceId: options.newInstanceId, backup: backup.destination, expectedSha256: backup.sha256 });
        const upgradeOptions = { ...options, instanceId: options.newInstanceId, candidate: plan._candidate.directory, statePolicies: plan.statePolicies };
        const review = await previewUpgrade(upgradeOptions);
        if (review.candidate.digest !== plan.candidate.digest) throw fault('UPGRADE_CHANGED', 'Candidate changed after the new-instance review');
        target = await upgradeInstance({ ...upgradeOptions, trust: review.trustDigest });
      }
      if (target.digest !== plan.candidate.digest) throw fault('UPGRADE_CHANGED', 'Candidate changed during new-instance import');
      const unchanged = (await sourceSnapshot(directory, stopped, plan._current, options)).digest === plan.snapshot.digest;
      if (!unchanged) throw fault('UPGRADE_SOURCE_CHANGED', 'An external writer changed old instance data during preparation; inspect both private instances');
      return { format: 'world-hub.staged-upgrade-result/v1', instanceId: options.instanceId, newInstanceId: options.newInstanceId,
        sourceDirectory: directory, stateDir: target.stateDir, digest: target.digest, plan: target.plan, backup, data: plan.data,
        stateCompatibility: plan.runsMigrations ? 'migration-completed-business-validation-pending' : plan.data.compatibility,
        oldInstancePreserved: true, startsModules: false, requiresNewExecutionReview: true, healthValidation: 'not-run', businessValidation: 'not-run',
        cutover: 'manual', returnToOldInstance: { instanceId: options.instanceId, stateDir: directory, requiresExecutionReview: true }, rollbackBoundary };
    } catch (error) {
      // Keep failed candidate and snapshot evidence. Never delete or start the old instance.
      let unchanged = false;
      try { unchanged = (await sourceSnapshot(directory, stopped, plan._current, { ...options, signal: undefined })).digest === plan.snapshot.digest; } catch {}
      throw Object.assign(error, { backup, newInstanceId: options.newInstanceId, candidateStateDir: plan.targetDirectory,
        oldInstancePreserved: unchanged, returnToOldInstance: { instanceId: options.instanceId, stateDir: directory, requiresExecutionReview: true },
        candidateMayNeedRecovery: await exists(plan.targetDirectory), rollbackBoundary });
    }
  });
}
