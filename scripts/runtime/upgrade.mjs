// Optional local deployment transactions. Hub Core never interprets program data.
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { instancePath, inspectPackage, copyPackage, safeId } from './package.mjs';
import { ordinaryPath, privateJson, readBounded, relativePath, hash, processPath } from './paths.mjs';
import { withStoppedInstance, confirmedStopped, backupStoppedInstance, extractBackup, inspectBackup, backupLimits } from './maintenance.mjs';
import { ownProcess } from './process.mjs';

const FORMAT = 'world-hub.upgrade-transaction/v1';
const GROUPS = ['package', 'programs', 'hub', 'instance.json'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL = new Set(['committed', 'rolled-back', 'aborted']);
const fault = (code, message) => Object.assign(new Error(message), { code });
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = async file => JSON.parse((await readBounded(file, 4 * 1024 * 1024)).toString('utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const cancelled = signal => { if (signal?.aborted) throw fault('UPGRADE_ABORTED', 'Upgrade cancelled before the next consistency operation'); };
const limitedText = (value, name) => { if (typeof value !== 'string' || !value || value.length > 128 || /[\x00-\x1f]/.test(value)) throw fault('UPGRADE_POLICY_INVALID', `Invalid ${name}`); };
const closed = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) throw fault('UPGRADE_POLICY_INVALID', 'State policy has missing or unsupported fields'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const rollbackBoundary = Object.freeze({ softwareAndSnapshotOnly: true, externalApiSideEffects: 'not-restored',
  alreadySentMessages: 'not-retracted', otherProgramState: 'not-restored', applicationReversibility: 'not-inferred' });

/** Compare already inspected packages. These are exact declarations, never a business proof. */
export function compareUpgradePackages(current, candidate) {
  const descriptor = (plan, id) => {
    const component = plan.pack.components.find(c => c.id === id);
    if (!component) return null;
    const module = plan.modules.find(m => m.manifest.id === component.module);
    return { module: { id: module.manifest.id, version: module.manifest.version, source: module.source },
      codeSha256: hash(JSON.stringify(module.files)), license: module.manifest.license, contracts: { provides: module.manifest.provides, requires: module.manifest.requires },
      permissions: module.manifest.permissions, bridges: { slots: module.manifest.bridges, grants: component.bridges },
      dependencies: component.after, platforms: module.manifest.platforms, runtime: { ...module.manifest.runtime,
        pin: plan.lock.runtimes[module.manifest.runtime.kind] }, settingsSha256: hash(JSON.stringify(component.settings)), files: module.files };
  };
  const ids = [...new Set([...current.pack.components, ...candidate.pack.components].map(c => c.id))].sort();
  const components = ids.map(id => {
    const before = descriptor(current, id), after = descriptor(candidate, id);
    const beforeFiles = new Map((before?.files ?? []).map(f => [f.path, f.sha256])), afterFiles = new Map((after?.files ?? []).map(f => [f.path, f.sha256]));
    const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort();
    const code = { added: paths.filter(p => !beforeFiles.has(p)), removed: paths.filter(p => !afterFiles.has(p)),
      changed: paths.filter(p => beforeFiles.has(p) && afterFiles.has(p) && beforeFiles.get(p) !== afterFiles.get(p)) };
    const stripFiles = value => { if (!value) return null; const { files, ...visible } = value; return visible; };
    const dimensions = ['module', 'license', 'contracts', 'permissions', 'bridges', 'dependencies', 'platforms', 'runtime', 'settingsSha256'];
    return { id, change: !before ? 'added' : !after ? 'removed' : same(before, after) ? 'unchanged' : 'changed',
      before: stripFiles(before), after: stripFiles(after), code, changedDimensions: dimensions.filter(key => !same(before?.[key] ?? null, after?.[key] ?? null)) };
  });
  return { format: 'world-hub.upgrade-diff/v1', declarations: 'exact-checked', applicationBehavior: 'not-validated',
    current: { pack: { id: current.pack.id, version: current.pack.version }, digest: current.digest, hubVersion: current.lock.hubVersion,
      platform: current.lock.platform, interpreters: current.environment, runtimes: current.lock.runtimes },
    candidate: { pack: { id: candidate.pack.id, version: candidate.pack.version }, digest: candidate.digest, hubVersion: candidate.lock.hubVersion,
      platform: candidate.lock.platform, interpreters: candidate.environment, runtimes: candidate.lock.runtimes },
    components, bindings: { changed: !same(current.pack.bindings, candidate.pack.bindings), before: current.pack.bindings, after: candidate.pack.bindings },
    topics: { changed: !same(current.pack.topics, candidate.pack.topics), before: current.pack.topics, after: candidate.pack.topics },
    rollbackBoundary };
}
function transactionDirectory(directory, transactionId) {
  if (!UUID.test(transactionId)) throw fault('UPGRADE_TRANSACTION_INVALID', 'Invalid upgrade transaction ID');
  return join(directory, 'upgrades', transactionId);
}
async function readJournal(directory, transactionId) {
  const journal = await json(join(transactionDirectory(directory, transactionId), 'transaction.json'));
  if (journal.format !== FORMAT || journal.transactionId !== transactionId || !Array.isArray(journal.steps)
      || journal.steps.length !== GROUPS.length || journal.steps.some((s, i) => s.name !== GROUPS[i])
      || typeof journal.instanceId !== 'string' || !['preparing', 'ready', 'committing', 'restoring', 'committed', 'rolled-back', 'aborted', 'conflict', 'cleanup-incomplete'].includes(journal.state))
    throw fault('UPGRADE_TRANSACTION_INVALID', 'Unsupported or damaged upgrade transaction journal');
  return journal;
}
async function writeJournal(directory, journal) {
  journal.updatedAt = new Date().toISOString();
  await privateJson(join(transactionDirectory(directory, journal.transactionId), 'transaction.json'), journal);
}
async function fileDigest(file, signal) {
  await ordinaryPath(file); const info = await lstat(file);
  if (!info.isFile() || info.size > backupLimits.fileBytes) throw fault('UPGRADE_SNAPSHOT_LIMIT', 'Persistent file exceeds the 256 MiB snapshot bound');
  const input = await open(file, 'r'), h = createHash('sha256'), block = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (offset < info.size) {
      cancelled(signal);
      const { bytesRead } = await input.read(block, 0, Math.min(block.length, info.size - offset), offset);
      if (!bytesRead) throw fault('UPGRADE_CHANGED', 'Persistent file changed while inspected');
      h.update(block.subarray(0, bytesRead)); offset += bytesRead;
    }
    const end = await input.stat();
    if (end.size !== info.size || end.mtimeMs !== info.mtimeMs || end.ctimeMs !== info.ctimeMs) throw fault('UPGRADE_CHANGED', 'Persistent file changed while inspected');
    return { bytes: offset, sha256: h.digest('hex') };
  } finally { await input.close(); }
}
// Includes empty directories, newly created files and absent roots; no format guessing.
async function signature(path, signal) {
  if (!await exists(path)) return { exists: false, sha256: hash('absent'), files: 0, bytes: 0 };
  const records = [], cases = new Set(); let entries = 0, files = 0, bytes = 0;
  const visit = async (file, local) => {
    cancelled(signal); await ordinaryPath(file); const stat = await lstat(file);
    if (++entries > backupLimits.entries) throw fault('UPGRADE_SNAPSHOT_LIMIT', 'Upgrade tree exceeds its traversal bound');
    if (cases.has(local.toLowerCase())) throw fault('UPGRADE_PATH', 'Case-colliding state paths are unsupported');
    cases.add(local.toLowerCase());
    if (stat.isDirectory()) {
      records.push({ path: local, directory: true });
      for (const entry of (await readdir(file)).sort((a, b) => a.localeCompare(b, 'en'))) {
        relativePath(local ? local + '/' + entry : entry);
        await visit(join(file, entry), local ? local + '/' + entry : entry);
      }
    } else if (stat.isFile()) {
      const item = await fileDigest(file, signal); files++; bytes += item.bytes;
      if (files > backupLimits.files || bytes > backupLimits.totalBytes) throw fault('UPGRADE_SNAPSHOT_LIMIT', 'Upgrade snapshot exceeds the 8192-file or 512 MiB bound');
      records.push({ path: local, ...item });
    } else throw fault('UPGRADE_PATH', 'Upgrade rejects links and special files');
  };
  await visit(path, '');
  return { exists: true, sha256: hash(JSON.stringify(records)), files, bytes };
}
async function instanceSignature(directory, signal) {
  const groups = {};
  for (const name of GROUPS) groups[name] = await signature(join(directory, name), signal);
  const runtime = {};
  for (const name of ['status.json', 'control.json']) runtime[name] = await signature(join(directory, name), signal);
  const bytes = Object.values(groups).reduce((s, item) => s + item.bytes, 0);
  const files = Object.values(groups).reduce((s, item) => s + item.files, 0);
  if (bytes > backupLimits.totalBytes || files > backupLimits.files) throw fault('UPGRADE_SNAPSHOT_LIMIT', 'Combined instance snapshot exceeds its bound');
  return { digest: hash(JSON.stringify({ groups, runtime })), groups, runtime, files, bytes };
}
async function checkStateRoots(directory, pack) {
  if (await exists(join(directory, 'programs'))) {
    const known = new Set(pack.components.map(c => c.id));
    for (const entry of await readdir(join(directory, 'programs'), { withFileTypes: true }))
      if (!entry.isDirectory() || !known.has(entry.name)) throw fault('UPGRADE_STATE_UNKNOWN', 'Undeclared program state requires an explicit authoring decision before upgrade');
  }
  if (await exists(join(directory, 'hub'))) for (const name of await readdir(join(directory, 'hub')))
    if (!['log', 'blobs', 'management.json'].includes(name)) throw fault('UPGRADE_STATE_UNKNOWN', 'Unknown Hub persistent paths must be preserved and inspected before upgrade');
}
export function validateUpgradeStatePolicies(current, candidate, supplied) {
  if (!Array.isArray(supplied) || supplied.length !== current.pack.components.length) throw fault('UPGRADE_POLICY_REQUIRED', 'Explicit provider-defined state policies are required for every component');
  const before = current.pack.components.map(c => c.id).sort(), after = candidate.pack.components.map(c => c.id).sort();
  if (!same(before, after)) throw fault('UPGRADE_COMPONENTS_CHANGED', 'In-place v1 upgrade requires the same stable component IDs; derive and restore a separate instance for topology changes');
  if (current.lock.hubVersion !== candidate.lock.hubVersion) throw fault('UPGRADE_HUB_VERSION', 'Hub state migration is not inferred; both packages must pin the same installed Hub version');
  const result = [], ids = new Set();
  for (const policy of supplied) {
    if (policy?.mode === 'preserve') {
      closed(policy, ['componentId', 'mode', 'dataFormat']); limitedText(policy.dataFormat, 'provider data-format declaration');
    } else if (policy?.mode === 'migrate') {
      closed(policy, ['componentId', 'mode', 'fromFormat', 'toFormat', 'runtime', 'entry', 'timeoutMs']);
      limitedText(policy.fromFormat, 'source data format'); limitedText(policy.toFormat, 'target data format');
      if (!['node', 'python'].includes(policy.runtime)) throw fault('UPGRADE_POLICY_INVALID', 'Migration runtime must be node or python');
      relativePath(policy.entry);
      if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 60000) throw fault('UPGRADE_POLICY_INVALID', 'Migration timeout must be 100..60000 ms');
    } else throw fault('UPGRADE_POLICY_REQUIRED', 'State compatibility must be declared as preserve or author-defined migration');
    safeId(policy.componentId, 'migration component ID');
    if (!before.includes(policy.componentId) || ids.has(policy.componentId)) throw fault('UPGRADE_POLICY_INVALID', 'State policies must identify each stable component exactly once');
    ids.add(policy.componentId);
    if (policy.mode === 'migrate') {
      const component = candidate.pack.components.find(c => c.id === policy.componentId), module = candidate.modules.find(m => m.manifest.id === component.module);
      if (policy.runtime !== module.manifest.runtime.kind || !module.files.some(f => f.path === policy.entry)) throw fault('UPGRADE_POLICY_INVALID', 'Migration entry must be a locked file in its candidate module and use that module runtime');
    }
    result.push(structuredClone(policy));
  }
  return result.sort((a, b) => a.componentId.localeCompare(b.componentId, 'en'));
}
async function upgradePlan(directory, stopped, options) {
  await assertNoIncompleteUpgrades(directory);
  if (await exists(join(directory, 'detached.json'))) throw fault('INSTANCE_DETACHED', 'Reattach and review this instance before in-place upgrade');
  const current = await inspectPackage(join(directory, 'package'), options), candidate = await inspectPackage(options.candidate, options);
  if (stopped.identity.digest !== current.digest) throw fault('UPGRADE_CHANGED', 'Current instance identity differs from its package/environment review');
  const statePolicies = validateUpgradeStatePolicies(current, candidate, options.statePolicies);
  await checkStateRoots(directory, current.pack);
  const snapshot = await instanceSignature(directory, options.signal);
  const trustDigest = hash(JSON.stringify({ operation: 'upgrade', instanceId: options.instanceId, stateDir: directory, current: current.digest, candidate: candidate.digest,
    candidateDirectory: candidate.directory, statePolicies, snapshot: snapshot.digest }));
  const createdAt = new Date().toISOString();
  return { format: 'world-hub.upgrade-preview/v1', instanceId: options.instanceId, trustDigest, createdAt,
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), current: { digest: current.digest, pack: { id: current.pack.id, version: current.pack.version } },
    candidate: { digest: candidate.digest, directory: candidate.directory, pack: { id: candidate.pack.id, version: candidate.pack.version }, permissions: candidate.permissions },
    statePolicies, snapshot: { digest: snapshot.digest, files: snapshot.files, bytes: snapshot.bytes },
    hubDataPolicy: 'preserve-exact-installed-version', startsModules: false, runsMigrations: statePolicies.some(p => p.mode === 'migrate'), sandbox: false,
    fullDataRollbackRequiresNewReview: true, diff: compareUpgradePackages(current, candidate), stateCompatibility: 'provider-declared-not-business-validated',
    rollbackBoundary, _current: current, _candidate: candidate, _snapshot: snapshot };
}
const publicPlan = ({ _current, _candidate, _snapshot, ...plan }) => plan;
/** Read-only plan. Confirmation is an exact digest of software, policy, data and last run. */
export async function previewUpgrade(options) {
  return withStoppedInstance(options, async (directory, stopped) => publicPlan(await upgradePlan(directory, stopped, options)));
}
/** Runtime calls this before start; deleting an owner lock never legitimizes a half transaction. */
export async function assertNoIncompleteUpgrades(directory) {
  if (!await exists(join(directory, 'upgrades'))) return;
  await ordinaryPath(join(directory, 'upgrades'));
  const entries = await readdir(join(directory, 'upgrades'));
  if (entries.length > 128) throw fault('UPGRADE_HISTORY_LIMIT', 'Inspect and archive old private upgrade transactions before proceeding');
  for (const id of entries) {
    const transaction = await readJournal(directory, id);
    if (!TERMINAL.has(transaction.state)) throw fault('UPGRADE_RECOVERY_REQUIRED', `Upgrade ${id} is incomplete; inspect its recovery plan before starting or maintaining this instance`);
  }
}
async function snapshotConsistent(directory, expected, signal) {
  if ((await instanceSignature(directory, signal)).digest !== expected.digest) throw fault('UPGRADE_CHANGED', 'Instance data, software, identity or last run changed after review; no reviewed user data was overwritten');
}
async function materializeCandidate(directory, journal, candidate, options) {
  const transaction = transactionDirectory(directory, journal.transactionId), stage = join(transaction, 'stage');
  // Extract once for each data file, and keep the original compressed-independent private archive.
  await extractBackup(join(transaction, 'snapshot.whbackup'), join(transaction, 'snapshot'), { signal: options.signal });
  await mkdir(stage, { mode: 0o700 });
  await copyPackage(candidate, join(stage, 'package'));
  if ((await inspectPackage(join(stage, 'package'), options)).digest !== candidate.digest) throw fault('UPGRADE_CHANGED', 'Candidate changed while copying');
  for (const name of ['programs', 'hub']) if (await exists(join(transaction, 'snapshot', name))) await rename(join(transaction, 'snapshot', name), join(stage, name));
  await privateJson(join(stage, 'instance.json'), { ...journal.identity, digest: candidate.digest, upgradedAt: new Date().toISOString(), upgradeTransactionId: journal.transactionId }, { exclusive: true });
  const immutable = { package: await signature(join(stage, 'package'), options.signal), hub: await signature(join(stage, 'hub'), options.signal) };
  for (const policy of journal.statePolicies.filter(p => p.mode === 'migrate')) {
    cancelled(options.signal);
    const baseline = {};
    for (const other of journal.statePolicies.filter(p => p.componentId !== policy.componentId)) baseline[other.componentId] = await signature(join(stage, 'programs', other.componentId), options.signal);
    const component = candidate.pack.components.find(c => c.id === policy.componentId), module = candidate.modules.find(m => m.manifest.id === component.module);
    const dataDirectory = join(stage, 'programs', policy.componentId);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const config = join(transaction, 'migration-' + policy.componentId + '.json');
    await privateJson(config, { format: 'world-hub.program-migration/v1', instanceId: journal.instanceId, componentId: policy.componentId,
      fromFormat: policy.fromFormat, toFormat: policy.toFormat, dataDirectory, preservesOpaqueHubData: true }, { exclusive: true });
    const executable = candidate.environment[policy.runtime].executable;
    const argv = [processPath(join(stage, 'package', module.source, policy.entry)), processPath(config)];
    const handle = ownProcess(executable, argv, { cwd: dataDirectory, temporary: join(transaction, 'tmp'), secrets: [], signal: options.signal });
    journal.migrationOwner = { pid: handle.pid ?? null, componentId: policy.componentId, startedAt: new Date().toISOString() };
    await writeJournal(directory, journal);
    let timer, onAbort;
    try {
      const outcome = await Promise.race([handle.closed.then(exit => ({ exit })), new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), policy.timeoutMs); }),
        new Promise(resolve => { onAbort = () => resolve({ cancelled: true }); options.signal?.addEventListener('abort', onAbort, { once: true }); if (options.signal?.aborted) onAbort(); })]);
      if (!outcome.exit) {
        try { await handle.stop(1000); }
        catch { journal.state = 'cleanup-incomplete'; await writeJournal(directory, journal); throw Object.assign(fault('UPGRADE_CLEANUP_INCOMPLETE', 'Migration process exit is unconfirmed; retain ownership and inspect it before recovery'), { retainMaintenanceOwner: true, cleanupIncomplete: true }); }
        throw fault(outcome.cancelled ? 'UPGRADE_ABORTED' : 'UPGRADE_MIGRATION_TIMEOUT', outcome.cancelled ? 'Migration cancelled and its owned process exited' : 'Author migration exceeded its reviewed timeout');
      }
      if (outcome.exit.code !== 0 || outcome.exit.error) throw fault('UPGRADE_MIGRATION_FAILED', `Author migration ${policy.componentId} failed; its bounded stdout/stderr remain private in the transaction`);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      await privateJson(join(transaction, 'migration-' + policy.componentId + '-logs.json'), { exit: handle.exit, stdout: handle.stdout, stderr: handle.stderr, truncated: handle.truncated });
      if (handle.exit) { journal.migrationOwner = null; await writeJournal(directory, journal); }
    }
    if (!same(await signature(join(stage, 'package'), options.signal), immutable.package) || !same(await signature(join(stage, 'hub'), options.signal), immutable.hub))
      throw fault('UPGRADE_MIGRATION_SCOPE', 'Author migration changed staged package or Hub data; it was not committed');
    for (const [id, before] of Object.entries(baseline)) if (!same(await signature(join(stage, 'programs', id), options.signal), before))
      throw fault('UPGRADE_MIGRATION_SCOPE', 'Author migration changed another component state; it was not committed');
  }
  for (const step of journal.steps) step.next = await signature(join(stage, step.name), options.signal);
  journal.state = 'ready'; await writeJournal(directory, journal);
}
async function restoreOriginalGroups(directory, journal) {
  const transaction = transactionDirectory(directory, journal.transactionId);
  await mkdir(join(transaction, 'rejected'), { recursive: true, mode: 0o700 });
  journal.state = 'restoring'; await writeJournal(directory, journal);
  for (const step of [...journal.steps].reverse()) {
    const live = join(directory, step.name), original = join(transaction, 'old', step.name), rejected = join(transaction, 'rejected', step.name);
    const current = await signature(live);
    if (await exists(original)) {
      if (!same(await signature(original), step.before)) throw fault('UPGRADE_RECOVERY_CONFLICT', 'Retained original group changed; preserve it for manual recovery');
      if (current.exists) {
        if (!step.next || !same(current, step.next)) throw fault('UPGRADE_RECOVERY_CONFLICT', 'Installed data changed during the interrupted transaction; recovery must not overwrite newer data');
        if (await exists(rejected)) throw fault('UPGRADE_RECOVERY_CONFLICT', 'Recovery quarantine already contains conflicting data');
        await rename(live, rejected);
      }
      await rename(original, live);
    } else if (step.before.exists) {
      if (!same(current, step.before)) throw fault('UPGRADE_RECOVERY_CONFLICT', 'Original group is missing or live state has newer changes; preserve current data');
    } else if (current.exists) {
      if (!step.next || !same(current, step.next) || await exists(rejected)) throw fault('UPGRADE_RECOVERY_CONFLICT', 'Unexpected data appeared in an originally absent group');
      await rename(live, rejected);
    }
  }
  journal.state = 'rolled-back'; journal.completedAt = new Date().toISOString(); await writeJournal(directory, journal);
}
async function commitGroups(directory, journal, signal) {
  const transaction = transactionDirectory(directory, journal.transactionId);
  await mkdir(join(transaction, 'old'), { mode: 0o700 });
  journal.state = 'committing'; await writeJournal(directory, journal);
  // Cancellation triggers an original-state restoration, never a half committed return.
  for (const step of journal.steps) {
    cancelled(signal); step.phase = 'evacuate'; await writeJournal(directory, journal);
    if (step.before.exists) await rename(join(directory, step.name), join(transaction, 'old', step.name));
    step.phase = 'install'; await writeJournal(directory, journal);
    if (step.next.exists) await rename(join(transaction, 'stage', step.name), join(directory, step.name));
    step.phase = 'done'; await writeJournal(directory, journal);
  }
  journal.after = await instanceSignature(directory);
  journal.state = 'committed'; journal.completedAt = new Date().toISOString(); await writeJournal(directory, journal);
}
/** Trusted local migration code runs only in a staged private copy; no automatic module start. */
export async function upgradeInstance(options) {
  const transactionId = randomUUID();
  return withStoppedInstance({ ...options, maintenanceTransactionId: transactionId }, async (directory, stopped) => {
    const reviewed = await upgradePlan(directory, stopped, options);
    if (options.trust !== reviewed.trustDigest) throw fault('UPGRADE_TRUST_REQUIRED', 'Accept the current upgrade review digest, exact candidate and provider state policies before executing migrations or replacing data');
    cancelled(options.signal);
    const transaction = transactionDirectory(directory, transactionId);
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    const journal = { format: FORMAT, transactionId, instanceId: options.instanceId, state: 'preparing', createdAt: new Date().toISOString(),
      reviewDigest: reviewed.trustDigest, current: reviewed.current, target: reviewed.candidate, identity: stopped.identity, statePolicies: reviewed.statePolicies,
      before: reviewed._snapshot, snapshot: null, migrationOwner: null, steps: GROUPS.map(name => ({ name, before: reviewed._snapshot.groups[name], next: null, phase: 'pending' })) };
    await writeJournal(directory, journal);
    try {
      const snapshot = await backupStoppedInstance(directory, stopped, { ...options, maintenanceTransactionId: transactionId, destination: join(transaction, 'snapshot.whbackup') });
      journal.snapshot = { sha256: snapshot.sha256, files: snapshot.files, bytes: snapshot.bytes }; await writeJournal(directory, journal);
      await snapshotConsistent(directory, reviewed._snapshot, options.signal);
      await materializeCandidate(directory, journal, reviewed._candidate, options);
      await snapshotConsistent(directory, reviewed._snapshot, options.signal);
      await commitGroups(directory, journal, options.signal);
      return { format: 'world-hub.upgrade-result/v1', instanceId: options.instanceId, transactionId, stateDir: directory,
        digest: reviewed._candidate.digest, plan: reviewed._candidate, state: 'committed', snapshot: journal.snapshot,
        private: true, startsModules: false, requiresNewExecutionReview: true, sandbox: false, rollbackBoundary,
        stateCompatibility: journal.statePolicies.some(p => p.mode === 'migrate') ? 'migration-completed-business-validation-pending' : 'provider-declared-not-business-validated' };
    } catch (error) {
      journal.error = { code: error.code ?? 'UPGRADE_FAILED', message: String(error.message).slice(0, 1024) };
      if (error.retainMaintenanceOwner) { await writeJournal(directory, journal); throw Object.assign(error, { transactionId }); }
      try {
        if (journal.state === 'committing') await restoreOriginalGroups(directory, journal);
        else if (journal.state !== 'committed') { journal.state = 'aborted'; journal.completedAt = new Date().toISOString(); await writeJournal(directory, journal); }
      } catch (recoveryError) { journal.state = 'conflict'; journal.recoveryError = { code: recoveryError.code, message: String(recoveryError.message).slice(0, 1024) }; await writeJournal(directory, journal); throw Object.assign(recoveryError, { transactionId, originalError: journal.error }); }
      throw Object.assign(error, { transactionId, rolledBack: journal.state === 'rolled-back', preservesOriginalData: journal.state === 'aborted' || journal.state === 'rolled-back' });
    }
  });
}
async function ownerSnapshot(directory, transactionId) {
  const file = join(directory, 'owner.lock');
  if (!await exists(file)) return null;
  const raw = await readBounded(file), owner = JSON.parse(raw);
  if (owner.format !== 'world-hub.maintenance-owner/v1' || owner.transactionId !== transactionId || typeof owner.nonce !== 'string'
      || !Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) throw fault('INSTANCE_LOCKED', 'A live or unrelated owner still holds this instance; stored PIDs are never killed');
  return { nonce: owner.nonce, sha256: hash(raw), pid: owner.pid };
}
async function rollbackPlan(directory, options, ownsPreviewLock = false) {
  const journal = await readJournal(directory, options.transactionId);
  if (journal.instanceId !== options.instanceId || ['aborted', 'rolled-back'].includes(journal.state)) throw fault('UPGRADE_NOT_ROLLBACKABLE', 'Transaction is already restored or never replaced the original instance');
  if (journal.migrationOwner?.pid && alive(journal.migrationOwner.pid)) throw fault('UPGRADE_CLEANUP_INCOMPLETE', 'An unconfirmed migration process still exists; inspect its owner before recovery, no stored PID is killed');
  const stopped = await confirmedStopped(directory, options.instanceId);
  const recoveryRequired = journal.state !== 'committed';
  const owner = recoveryRequired ? await ownerSnapshot(directory, options.transactionId) : null;
  if (!recoveryRequired && !ownsPreviewLock && await exists(join(directory, 'owner.lock'))) throw fault('INSTANCE_LOCKED', 'Stop the current owner before reviewing data restoration');
  const actual = await instanceSignature(directory, options.signal);
  let snapshot = null;
  if (journal.snapshot) {
    snapshot = await inspectBackup(join(transactionDirectory(directory, options.transactionId), 'snapshot.whbackup'), options);
    if (snapshot.sha256 !== journal.snapshot.sha256 || !snapshot.compatible) throw fault('UPGRADE_SNAPSHOT_CHANGED', 'Original private snapshot differs from its transaction or current exact environment');
  } else if (!recoveryRequired) throw fault('UPGRADE_TRANSACTION_INVALID', 'Committed upgrade is missing its original private snapshot');
  const journalDigest = hash(await readBounded(join(transactionDirectory(directory, options.transactionId), 'transaction.json'), 4 * 1024 * 1024));
  const trustDigest = hash(JSON.stringify({ operation: recoveryRequired ? 'recover-upgrade' : 'rollback-upgrade', stateDir: directory, transactionId: options.transactionId,
    journalDigest, current: actual.digest, snapshot: snapshot?.sha256 ?? null, owner }));
  return { format: 'world-hub.upgrade-rollback-preview/v1', instanceId: options.instanceId, transactionId: options.transactionId, trustDigest,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), recoveryRequired,
    current: { digest: stopped.identity.digest, lastRunId: stopped.status?.runId ?? null, snapshotDigest: actual.digest, files: actual.files, bytes: actual.bytes },
    restores: journal.current, snapshot: journal.snapshot, preservesLatestData: false, discardsCurrentData: !recoveryRequired,
    latestRunChanged: !same(actual.runtime, journal.after?.runtime ?? journal.before.runtime), startsModules: false, runsMigrations: false,
    sandbox: false, rollbackBoundary, _journal: journal, _journalDigest: journalDigest, _actual: actual, _owner: owner };
}
/** A fresh review binds the latest stopped data; old confirmations cannot discard a later run. */
export async function previewRollback(options) {
  const directory = await ordinaryPath(instancePath(options.root, options.instanceId));
  const journal = await readJournal(directory, options.transactionId);
  // Abandoned ownership is observed, never removed by a read-only preview.
  if (!TERMINAL.has(journal.state)) {
    const result = await rollbackPlan(directory, options);
    const { _journal, _journalDigest, _actual, _owner, ...publicResult } = result; return publicResult;
  }
  return withStoppedInstance(options, async directory => {
    // Ignore only this preview's own current maintenance lock, not another owner.
    const result = await rollbackPlan(directory, options, true);
    const { _journal, _journalDigest, _actual, _owner, ...publicResult } = result; return publicResult;
  });
}
async function rollbackExecution(options, requireRecovery) {
  const directory = await ordinaryPath(instancePath(options.root, options.instanceId));
  // Review without changing abandoned ownership; exact owner bytes participate in trust.
  const plan = await rollbackPlan(directory, options);
  if (plan.recoveryRequired !== requireRecovery) throw fault('UPGRADE_RECOVERY_REQUIRED', requireRecovery ? 'Use explicit rollback for a completed upgrade' : 'Use explicit recovery for this interrupted transaction');
  if (options.trust !== plan.trustDigest) throw fault('UPGRADE_TRUST_REQUIRED', 'Accept the current private snapshot restoration review; this operation may discard reviewed current program and Hub data');
  cancelled(options.signal);
  if (plan._owner) {
    const owner = await ownerSnapshot(directory, options.transactionId);
    if (!same(owner, plan._owner)) throw fault('UPGRADE_CHANGED', 'Abandoned owner changed after recovery review');
    await unlink(join(directory, 'owner.lock'));
  }
  const restoreId = requireRecovery ? options.transactionId : randomUUID();
  return withStoppedInstance({ ...options, maintenanceTransactionId: restoreId }, async (directory, stopped) => {
    if (hash(await readBounded(join(transactionDirectory(directory, options.transactionId), 'transaction.json'), 4 * 1024 * 1024)) !== plan._journalDigest)
      throw fault('UPGRADE_CHANGED', 'Transaction journal changed after restoration review');
    await snapshotConsistent(directory, plan._actual, options.signal);
    const journal = plan._journal;
    if (requireRecovery) {
      if (['preparing', 'ready', 'cleanup-incomplete'].includes(journal.state)) {
        // No live group was ever evacuated. Do not replace or interpret original data.
        if ((await instanceSignature(directory)).digest !== journal.before.digest) throw fault('UPGRADE_RECOVERY_CONFLICT', 'Original live data changed during interrupted preparation; preserve it for inspection');
        journal.state = 'aborted'; journal.completedAt = new Date().toISOString(); await writeJournal(directory, journal);
      } else await restoreOriginalGroups(directory, journal);
      return { format: 'world-hub.upgrade-recovery-result/v1', instanceId: options.instanceId, transactionId: options.transactionId,
        recovered: true, state: journal.state, digest: journal.current.digest, startsModules: false, preservesOriginalData: true, rollbackBoundary };
    }
    const transaction = transactionDirectory(directory, restoreId);
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    const restore = { format: FORMAT, transactionId: restoreId, instanceId: options.instanceId, state: 'preparing', createdAt: new Date().toISOString(),
      operation: 'restore-snapshot', restoresTransactionId: options.transactionId, identity: stopped.identity,
      current: { digest: stopped.identity.digest, pack: journal.target.pack }, target: journal.current, reviewDigest: plan.trustDigest,
      before: plan._actual, snapshot: null, statePolicies: [], migrationOwner: null,
      steps: GROUPS.map(name => ({ name, before: plan._actual.groups[name], next: null, phase: 'pending' })) };
    await writeJournal(directory, restore);
    // Preserve latest reviewed data as a separate snapshot before an explicit destructive restore.
    const latest = await backupStoppedInstance(directory, stopped, { ...options, maintenanceTransactionId: restoreId, destination: join(transaction, 'snapshot.whbackup') });
    restore.snapshot = { sha256: latest.sha256, files: latest.files, bytes: latest.bytes }; await writeJournal(directory, restore);
    try {
      await extractBackup(join(transactionDirectory(directory, options.transactionId), 'snapshot.whbackup'), join(transaction, 'stage'), { signal: options.signal });
      // Identity is the original exact recorded value, not a fabricated migration result.
      await writeFile(join(transaction, 'stage', 'instance.json'), JSON.stringify(journal.identity, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const checked = await inspectPackage(join(transaction, 'stage', 'package'), options);
      if (checked.digest !== journal.current.digest) throw fault('UPGRADE_SNAPSHOT_CHANGED', 'Original software/environment no longer matches the recorded review');
      for (const step of restore.steps) step.next = await signature(join(transaction, 'stage', step.name), options.signal);
      await snapshotConsistent(directory, plan._actual, options.signal);
      await commitGroups(directory, restore, options.signal);
      journal.state = 'rolled-back'; journal.restoredByTransactionId = restoreId; journal.completedAt = new Date().toISOString(); await writeJournal(directory, journal);
      return { format: 'world-hub.upgrade-rollback-result/v1', instanceId: options.instanceId, transactionId: options.transactionId, restoreTransactionId: restoreId,
        state: 'rolled-back', digest: checked.digest, plan: checked, snapshot: journal.snapshot, latestDataSnapshot: restore.snapshot,
        restoresAllPersistentData: true, startsModules: false, requiresNewExecutionReview: true, rollbackBoundary };
    } catch (error) {
      restore.error = { code: error.code ?? 'UPGRADE_ROLLBACK_FAILED', message: String(error.message).slice(0, 1024) };
      if (restore.state === 'committing') await restoreOriginalGroups(directory, restore);
      else { restore.state = 'aborted'; restore.completedAt = new Date().toISOString(); await writeJournal(directory, restore); }
      throw Object.assign(error, { transactionId: restoreId });
    }
  });
}
export const rollbackUpgrade = options => rollbackExecution(options, false);
export const recoverUpgrade = options => rollbackExecution(options, true);
export async function inspectUpgradeHistory(options) {
  const directory = await ordinaryPath(instancePath(options.root, options.instanceId));
  if (!await exists(join(directory, 'upgrades'))) return { instanceId: options.instanceId, transactions: [] };
  const ids = await readdir(join(directory, 'upgrades'));
  if (ids.length > 128) throw fault('UPGRADE_HISTORY_LIMIT', 'Upgrade history exceeds its bound');
  const transactions = [];
  for (const id of ids) {
    const journal = await readJournal(directory, id);
    transactions.push({ transactionId: id, state: journal.state, createdAt: journal.createdAt, completedAt: journal.completedAt ?? null,
      current: journal.current, target: { digest: journal.target.digest, pack: journal.target.pack }, snapshot: journal.snapshot,
      error: journal.error ?? null, private: true, mayIncludeApplicationSecrets: true });
  }
  return { instanceId: options.instanceId, transactions: transactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt, 'en')) };
}
