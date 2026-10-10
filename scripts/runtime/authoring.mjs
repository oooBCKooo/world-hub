// Optional creator tooling. These operations never start a module or alter Hub Core.
import { mkdir, writeFile, open, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectPackage, createLock, validatePack, validateModule, validateLock } from './package.mjs';
import { ordinaryPath, readBounded, collectFiles, hash, relativePath, privateJson } from './paths.mjs';

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
export async function derivePackage(source, options) {
  cancelled(options);
  agreement(options);
  const original = await inspectAuthoring(source, options);
  if (options.expectedRevision !== undefined && options.expectedRevision !== original.revision) throw new Error('Authoring revision conflict: inspect the current package before deriving');
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
    if (!manifest.platforms.includes(`${process.platform}-${process.arch}`)) throw new Error('Replacement platform is unsupported');
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
  // Validate connections before writing any output, using the same contracts as Runtime.
  for (const c of pack.components) {
    const m = used.find(v => v.manifest.id === c.module).manifest;
    if (m.bridges.length !== Object.keys(c.bridges).length || m.bridges.some(slot => !Object.hasOwn(c.bridges, slot))) throw new Error(`Replacement bridge slots do not match: ${c.id}`);
    for (const required of m.requires) if (!pack.bindings.some(b => b.to === c.id && b.contract.id === required.id && b.contract.version === required.version)) throw new Error(`Unbound required contract: ${c.id}/${required.id}`);
  }
  for (const b of pack.bindings) {
    const from = used.find(m => m.manifest.id === pack.components.find(c => c.id === b.from).module).manifest;
    const to = used.find(m => m.manifest.id === pack.components.find(c => c.id === b.to).module).manifest;
    const matches = c => c.id === b.contract.id && c.version === b.contract.version;
    if (!from.provides.some(matches) || !to.requires.some(matches)) throw new Error('Incompatible declared capability contract binding');
  }
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
