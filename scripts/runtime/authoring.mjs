// Optional creator tooling. These operations never start a module or alter Hub Core.
import { mkdir, writeFile, open, unlink, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectPackage, createLock, validatePack, validateModule, validateLock } from './package.mjs';
import { ordinaryPath, readBounded, collectFiles, hash, relativePath, privateJson } from './paths.mjs';
import { doctorModule } from './developer.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const sha = /^[a-f0-9]{64}$/;
function cancelled(options) { if (options.signal?.aborted) throw options.signal.reason ?? new Error('Operation cancelled'); }
function agreement(options) {
  if (options.redistributionAcknowledged !== true) throw new Error('Review component licenses and explicitly acknowledge redistribution rights before copying or publishing');
}
function nonsensitive(value) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/(?:password|passwd|secret|token|credential|private.?key|api.?key)/i.test(key)) throw new Error(`Keep sensitive configuration out of shared packages: ${key}`);
    nonsensitive(item);
  }
}
function revision(plan) {
  // Environment paths differ between collaborators. Content revisions do not.
  return hash(JSON.stringify({ pack: plan.pack, lock: plan.lock, modules: plan.modules }));
}
export async function inspectAuthoring(directory, options = {}) {
  cancelled(options);
  const plan = await inspectPackage(directory, options);
  cancelled(options);
  return { directory: plan.directory, revision: revision(plan), pack: copy(plan.pack),
    modules: plan.modules.map(m => ({ ...copy(m.manifest), source: m.source })),
    review: plan, startsModules: false };
}
async function copyTree(directory, files, destination, options) {
  for (const f of files) {
    cancelled(options);
    const bytes = await readBounded(join(directory, relativePath(f.path)), 8 * 1024 * 1024);
    if (hash(bytes) !== f.sha256) throw new Error('Module changed while copying; the incomplete destination requires a fresh review');
    const target = join(destination, f.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}
async function prepareDerivation(original, options) {
  const pack = copy(options.pack ?? original.pack);
  validatePack(pack); pack.components.forEach(c => nonsensitive(c.settings));
  const available = original.review.modules.map(m => ({ manifest: m.manifest, files: m.files, directory: join(original.directory, m.source) }));
  const replacements = options.replacements ?? [];
  if (!Array.isArray(replacements) || replacements.length > 32 || new Set(replacements.map(r => r.componentId)).size !== replacements.length) throw new Error('Invalid or duplicate module replacements');
  for (const r of replacements) {
    cancelled(options);
    if (!r || Object.keys(r).some(k => !['componentId', 'moduleDirectory'].includes(k))) throw new Error('Unsupported replacement fields');
    const component = pack.components.find(c => c.id === r.componentId);
    if (!component) throw new Error('Replacement refers to an absent component');
    const directory = await ordinaryPath(r.moduleDirectory);
    const manifest = JSON.parse((await readBounded(join(directory, 'module.json'))).toString()); validateModule(manifest);
    const files = await collectFiles(directory);
    if (!files.some(f => f.path === manifest.runtime.entry)) throw new Error('Replacement entry is absent');
    // One module ID has one content tree. Replacing a shared module changes every
    // reference to that ID; choosing a new ID affects only this component.
    const previous = available.findIndex(m => m.manifest.id === manifest.id);
    if (previous >= 0) available.splice(previous, 1);
    available.push({ manifest, files, directory }); component.module = manifest.id;
  }
  validatePack(pack);
  const used = [...new Set(pack.components.map(c => c.module))].map(id => {
    const m = available.find(v => v.manifest.id === id); if (!m) throw new Error(`Missing module source: ${id}`); return m;
  });
  const diagnostics = [];
  for (const m of used) if (!m.manifest.platforms.includes(`${process.platform}-${process.arch}`)) diagnostics.push({ code: 'PLATFORM_UNSUPPORTED', message: `Replacement platform is unsupported: ${m.manifest.id}`, moduleId: m.manifest.id });
  // The preview and the actual derivation use identical declaration checks.
  for (const c of pack.components) {
    const m = used.find(v => v.manifest.id === c.module).manifest;
    if (m.bridges.length !== Object.keys(c.bridges).length || m.bridges.some(slot => !Object.hasOwn(c.bridges, slot))) diagnostics.push({ code: 'BRIDGE_SLOTS_MISMATCH', message: `Replacement bridge slots do not match: ${c.id}`, componentId: c.id });
    for (const required of m.requires) if (!pack.bindings.some(b => b.to === c.id && b.contract.id === required.id && b.contract.version === required.version)) diagnostics.push({ code: 'CONTRACT_UNBOUND', message: `Unbound required contract: ${c.id}/${required.id}`, componentId: c.id });
  }
  for (const b of pack.bindings) {
    const from = used.find(m => m.manifest.id === pack.components.find(c => c.id === b.from).module).manifest;
    const to = used.find(m => m.manifest.id === pack.components.find(c => c.id === b.to).module).manifest;
    const matches = c => c.id === b.contract.id && c.version === b.contract.version;
    if (!from.provides.some(matches) || !to.requires.some(matches)) diagnostics.push({ code: 'CONTRACT_INCOMPATIBLE', message: 'Incompatible declared capability contract binding', binding: copy(b) });
  }
  return { pack, used, diagnostics };
}
// Read-only creator preflight. Compatibility here is a declaration check, not
// evidence that third-party code implements the business contract correctly.
export async function previewReplacement(source, options) {
  cancelled(options);
  const original = await inspectAuthoring(source, options);
  const component = original.pack.components.find(c => c.id === options.componentId);
  if (!component) throw new Error('Replacement refers to an absent component');
  const before = original.review.modules.find(m => m.manifest.id === component.module).manifest;
  const prepared = await prepareDerivation(original, { ...options, replacements: [{ componentId: options.componentId, moduleDirectory: options.moduleDirectory }] });
  const nextComponent = prepared.pack.components.find(c => c.id === options.componentId);
  const candidate = prepared.used.find(m => m.manifest.id === nextComponent.module);
  const after = candidate.manifest;
  const doctor = await doctorModule({ directory: candidate.directory, nodePath: options.nodePath, pythonPath: options.pythonPath });
  const interpreter = doctor.interpreter ? copy(doctor.interpreter) : null;
  if (interpreter?.available) interpreter.sha256 = hash(await readFile(interpreter.executable));
  const requirements = async directory => {
    try { return (await readBounded(join(directory, 'requirements.txt'), 65536)).toString(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const previousModule = original.review.modules.find(m => m.manifest.id === before.id);
  const beforeDependencies = { components: component.after, contracts: before.requires, requirements: await requirements(join(original.directory, previousModule.source)) };
  const afterDependencies = { components: nextComponent.after, contracts: after.requires, requirements: await requirements(candidate.directory) };
  const environment = { runtime: after.runtime.kind, interpreter, otherDependenciesChecked: doctor.otherDependenciesChecked ?? false,
    runsFixedInterpreterProbe: true, executesModule: false };
  const diagnosticActions = { PLATFORM_UNSUPPORTED: 'Choose a module for this platform.', BRIDGE_SLOTS_MISMATCH: 'Choose matching bridge slots or derive an adapted pack.',
    CONTRACT_UNBOUND: 'Connect the required contract in a derived pack.', CONTRACT_INCOMPATIBLE: 'Choose the exact bound contract version or adapt the external consumer.' };
  const diagnostics = [...prepared.diagnostics.map(d => ({ ...d, layer: d.code === 'PLATFORM_UNSUPPORTED' ? 'environment' : 'declaration', action: diagnosticActions[d.code] })),
    ...doctor.issues.filter(d => d.code !== 'MODULE_PLATFORM_UNSUPPORTED').map(d => ({ ...d, layer: ['environment', 'dependency'].includes(d.stage) ? 'environment' : 'declaration', action: d.remedy }))];
  const declarationCompatible = !diagnostics.some(d => d.layer === 'declaration');
  const environmentCompatible = !diagnostics.some(d => d.layer === 'environment');
  const differences = Object.fromEntries([
    ['identity', { id: before.id, version: before.version }, { id: after.id, version: after.version }],
    ['contracts', { provides: before.provides, requires: before.requires }, { provides: after.provides, requires: after.requires }],
    ...['bridges', 'permissions', 'platforms', 'runtime', 'license'].map(key => [key, before[key], after[key]]),
    ['startupDependencies', beforeDependencies, afterDependencies]
  ].map(([key, previous, next]) => [key, { before: copy(previous), after: copy(next), changed: JSON.stringify(previous) !== JSON.stringify(next) }]));
  return { sourceRevision: original.revision, candidate: { manifest: copy(after), directory: candidate.directory },
    candidateDigest: hash(JSON.stringify(candidate.files)), compatible: declarationCompatible && environmentCompatible,
    declarationCompatible, environmentCompatible, environment,
    differences, affectedComponents: prepared.pack.components.filter(c => c.id === options.componentId || c.module === after.id).map(c => c.id),
    diagnostics, businessValidated: false, stateCompatibility: 'unknown',
    requiresNewExecutionReview: true, startsModules: false, writesFiles: false };
}
export async function derivePackage(source, options) {
  cancelled(options);
  agreement(options);
  const original = await inspectAuthoring(source, options);
  if (options.expectedRevision !== undefined && options.expectedRevision !== original.revision) throw new Error('Authoring revision conflict: inspect the current package before deriving');
  const { pack, used, diagnostics } = await prepareDerivation(original, options);
  if (diagnostics.length) throw new Error(diagnostics[0].message);
  const destination = await ordinaryPath(options.destination, { allowMissing: true });
  cancelled(options);
  await mkdir(destination, { mode: 0o700 }); // Never overwrite a source or existing package.
  try {
  await privateJson(join(destination, 'pack.json'), pack, { exclusive: true });
  for (const m of used) await copyTree(m.directory, m.files, join(destination, 'modules', m.manifest.id), options);
  await createLock(destination, { ...options, pythonPackages: options.pythonPackages ?? original.review.lock.runtimes.python?.packages });
  const result = await inspectAuthoring(destination, options);
  const provenance = { format: 'world-hub.derivation/v1', createdAt: new Date().toISOString(),
    from: { id: original.pack.id, version: original.pack.version, revision: original.revision },
    to: { id: result.pack.id, version: result.pack.version, revision: result.revision },
    licenses: used.map(m => ({ id: m.manifest.id, version: m.manifest.version, license: m.manifest.license })),
    redistributionAcknowledged: true };
  await privateJson(join(destination, 'authoring.json'), provenance, { exclusive: true });
  return { ...result, provenance, requiresNewExecutionReview: true };
  } catch (error) { error.incompleteDestination = destination; throw error; }
}
// Explicit lock migration is a creator action, never an import/start fallback.
// The old content is checked even when its Hub/runtime versions are unavailable.
export async function rebuildPackage(source, options) {
  cancelled(options); agreement(options);
  const directory = await ordinaryPath(source);
  const packBytes = await readBounded(join(directory, 'pack.json'));
  const pack = JSON.parse(packBytes.toString()); validatePack(pack); pack.components.forEach(c => nonsensitive(c.settings));
  const lock = JSON.parse((await readBounded(join(directory, 'pack.lock'))).toString()); validateLock(lock);
  if (lock.pack.id !== pack.id || lock.pack.version !== pack.version || lock.pack.sha256 !== hash(packBytes)) throw new Error('Old package lock identity or content hash mismatch');
  const modules = [];
  for (const m of lock.modules) {
    cancelled(options); const local = join(directory, m.source), files = await collectFiles(local);
    if (files.length !== m.files.length || files.some(f => m.files.find(v => v.path === f.path)?.sha256 !== f.sha256)) throw new Error(`Old module file hash or file set mismatch: ${m.id}`);
    const manifest = JSON.parse((await readBounded(join(local, 'module.json'))).toString()); validateModule(manifest);
    if (manifest.id !== m.id || manifest.version !== m.version || !files.some(f => f.path === manifest.runtime.entry)
        || !lock.runtimes[manifest.runtime.kind]) throw new Error('Old module identity, entry or runtime differs from lock');
    modules.push({ manifest, source: m.source, files });
  }
  const baseRevision = revision({ pack, lock, modules });
  if (options.expectedRevision !== undefined && options.expectedRevision !== baseRevision) throw new Error('Authoring revision conflict: inspect the current package before rebuilding');
  const destination = await ordinaryPath(options.destination, { allowMissing: true }); cancelled(options);
  await mkdir(destination, { mode: 0o700 });
  try {
    await writeFile(join(destination, 'pack.json'), packBytes, { flag: 'wx', mode: 0o600 });
    for (const m of modules) await copyTree(join(directory, m.source), m.files, join(destination, m.source), options);
    await createLock(destination, { ...options, moduleSources: lock.modules.map(m => m.source), pythonPackages: options.pythonPackages ?? lock.runtimes.python?.packages });
    const result = await inspectAuthoring(destination, options);
    const oldRequirements = { hubVersion: lock.hubVersion, platform: lock.platform, runtimes: lock.runtimes };
    const newRequirements = { hubVersion: result.review.lock.hubVersion, platform: result.review.lock.platform, runtimes: result.review.lock.runtimes };
    const provenance = { format: 'world-hub.derivation/v1', operation: 'explicit-lock-rebuild', createdAt: new Date().toISOString(),
      from: { id: pack.id, version: pack.version, revision: baseRevision }, to: { id: result.pack.id, version: result.pack.version, revision: result.revision },
      oldRequirements, newRequirements, licenses: modules.map(m => ({ id: m.manifest.id, version: m.manifest.version, license: m.manifest.license })), redistributionAcknowledged: true };
    await privateJson(join(destination, 'authoring.json'), provenance, { exclusive: true });
    return { ...result, provenance, oldRequirements, newRequirements, requiresNewExecutionReview: true };
  } catch (error) { error.incompleteDestination = destination; throw error; }
}
export async function exportProposal(source, options) {
  cancelled(options);
  const original = await inspectAuthoring(source, options);
  if (options.expectedRevision !== undefined && options.expectedRevision !== original.revision) throw new Error('Authoring revision conflict: inspect the current package before proposing');
  const destination = await ordinaryPath(options.destination, { allowMissing: true }); await mkdir(destination, { mode: 0o700 });
  try {
  const artifact = await derivePackage(source, { ...options, expectedRevision: original.revision, destination: join(destination, 'artifact') });
  const proposal = { format: 'world-hub.proposal/v1', proposalId: randomUUID(), baseRevision: original.revision,
    artifactRevision: artifact.revision, createdAt: new Date().toISOString() };
  await privateJson(join(destination, 'proposal.json'), proposal, { exclusive: true });
  return { directory: destination, ...proposal, artifact: artifact.directory, startsModules: false };
  } catch (error) { error.incompleteDestination = destination; throw error; }
}
export async function applyProposal(source, proposalDirectory, options) {
  cancelled(options);
  agreement(options);
  const original = await inspectAuthoring(source, options), proposalRoot = await ordinaryPath(proposalDirectory);
  if (options.expectedRevision !== undefined && options.expectedRevision !== original.revision) throw new Error('Authoring revision conflict: inspect the current package before applying');
  const proposal = JSON.parse((await readBounded(join(proposalRoot, 'proposal.json'))).toString());
  if (proposal.format !== 'world-hub.proposal/v1' || !sha.test(proposal.baseRevision) || !sha.test(proposal.artifactRevision)
      || typeof proposal.proposalId !== 'string' || proposal.proposalId.length > 128 || Object.keys(proposal).some(k => !['format', 'proposalId', 'baseRevision', 'artifactRevision', 'createdAt'].includes(k))) throw new Error('Invalid proposal');
  if (proposal.baseRevision !== original.revision) throw new Error('Proposal revision conflict: base package changed; resolve and create a new proposal');
  const artifact = await inspectAuthoring(join(proposalRoot, 'artifact'), options);
  if (artifact.revision !== proposal.artifactRevision) throw new Error('Proposal artifact content changed');
  const result = await derivePackage(artifact.directory, { ...options, expectedRevision: artifact.revision });
  result.provenance.proposal = { proposalId: proposal.proposalId, baseRevision: proposal.baseRevision };
  await privateJson(join(result.directory, 'authoring.json'), result.provenance);
  return { ...result, proposalId: proposal.proposalId };
}

function validateComments(value) {
  if (!value || value.format !== 'world-hub.comments/v1' || !Array.isArray(value.comments) || value.comments.length > 1000
      || Object.keys(value).some(k => !['format', 'comments'].includes(k))) throw new Error('Invalid comments document');
  const ids = new Set();
  for (const c of value.comments) {
    if (!c || Object.keys(c).some(k => !['id', 'author', 'text', 'createdAt'].includes(k))
        || typeof c.id !== 'string' || c.id.length > 128 || ids.has(c.id)
        || typeof c.author !== 'string' || !c.author.trim() || c.author.length > 128
        || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 4000 || c.text.includes('\0')
        || typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt))) throw new Error('Invalid comment');
    ids.add(c.id);
  }
  return value;
}
export async function readComments(directory) {
  const root = await ordinaryPath(directory); let value;
  try { value = JSON.parse((await readBounded(join(root, 'comments.json'), 8 * 1024 * 1024)).toString()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; value = { format: 'world-hub.comments/v1', comments: [] }; }
  validateComments(value);
  return { ...value, revision: hash(JSON.stringify(value)) };
}
async function updateComments(directory, options, mutate) {
  cancelled(options);
  const root = await ordinaryPath(directory), lock = join(root, '.comments.lock');
  await ordinaryPath(lock, { allowMissing: true });
  const handle = await open(lock, 'wx', 0o600);
  try {
    const current = await readComments(root);
    if (options.expectedRevision !== current.revision) throw new Error('Comments revision conflict: refresh before submitting');
    const value = validateComments({ format: current.format, comments: mutate(current.comments) });
    cancelled(options);
    await privateJson(join(root, 'comments.json'), value); return readComments(root);
  } finally { await handle.close(); await unlink(lock); }
}
export async function addComment(directory, options) {
  return updateComments(directory, options, comments => [...comments, { id: randomUUID(), author: options.author,
    text: options.text, createdAt: new Date().toISOString() }]);
}
export async function exportComments(directory, { destination, signal }) {
  cancelled({ signal });
  const current = await readComments(directory), target = await ordinaryPath(destination, { allowMissing: true });
  await privateJson(target, { format: current.format, comments: current.comments }, { exclusive: true });
  return { path: target, revision: current.revision, count: current.comments.length };
}
export async function importComments(directory, source, options) {
  const imported = validateComments(JSON.parse((await readBounded(source, 8 * 1024 * 1024)).toString()));
  return updateComments(directory, options, current => {
    const result = [...current];
    for (const c of imported.comments) {
      const existing = result.find(v => v.id === c.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(c)) throw new Error('Comment ID conflict: preserve both documents and resolve explicitly');
      if (!existing) result.push(c);
    }
    return result;
  });
}
