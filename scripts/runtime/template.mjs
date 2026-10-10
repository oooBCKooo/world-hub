// Optional, shareable composition Templates. Pure data operations: no program,
// interpreter, installer or user-supplied expression is executed here.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { validatePack, validateModule, validateLock, safeId } from './package.mjs';
import { ordinaryPath, readBounded, collectFiles, hash, relativePath, privateJson } from './paths.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const sha = /^[a-f0-9]{64}$/;
const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const reserved = /(?:path|file|directory|folder|entry|script|exec|command|shell|cwd|args|environment|^env$|interpreter|binary|loader|password|secret|token|credential|private.?key|api.?key)/i;
const unsafeKey = key => ['__proto__', 'prototype', 'constructor'].includes(key);
function cancelled(options) { if (options.signal?.aborted) throw options.signal.reason ?? new Error('Operation cancelled'); }
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`); }
function closed(value, required, optional, name) {
  object(value, name);
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) throw new Error(`Invalid ${name} fields`);
}
function text(value, name, maximum = 256) { if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${name}`); }
function scalar(value) { return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)); }
function checkValue(parameter, value) {
  const type = parameter.type;
  if ((type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== type) || !scalar(value)) throw new Error(`Parameter type mismatch: ${parameter.name}`);
  const c = parameter.constraints;
  if (type === 'string') {
    if (value.includes('\0') || value.length > (c.maxLength ?? 4096) || value.length < (c.minLength ?? 0)) throw new Error(`Parameter string bound: ${parameter.name}`);
  } else if (['integer', 'number'].includes(type) && ((c.minimum !== undefined && value < c.minimum) || (c.maximum !== undefined && value > c.maximum))) throw new Error(`Parameter numeric bound: ${parameter.name}`);
  if (c.enum && !c.enum.some(v => v === value)) throw new Error(`Parameter enum mismatch: ${parameter.name}`);
}
function targetKey(target) { return target.kind === 'topic' ? `topic:${target.key}` : `setting:${target.component}:${JSON.stringify(target.path)}`; }
function targetValue(pack, target) {
  if (target.kind === 'topic') {
    if (!Object.hasOwn(pack.topics, target.key)) throw new Error(`Template refers to an absent topic: ${target.key}`);
    return { parent: pack.topics, key: target.key };
  }
  const component = pack.components.find(c => c.id === target.component);
  if (!component) throw new Error(`Template refers to an absent component: ${target.component}`);
  let parent = component.settings;
  for (const key of target.path.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || Array.isArray(parent) || !Object.hasOwn(parent, key)) throw new Error('Template setting path does not exist');
    parent = parent[key];
  }
  const key = target.path.at(-1);
  if (!parent || typeof parent !== 'object' || Array.isArray(parent) || !Object.hasOwn(parent, key) || !scalar(parent[key])) throw new Error('Template target must be an existing scalar business setting');
  return { parent, key };
}
export function validateTemplate(template, pack) {
  closed(template, ['format', 'id', 'version', 'title', 'license', 'base', 'parameters'], [], 'template');
  if (template.format !== 'world-hub.template/v1' || template.base !== 'base') throw new Error('Unsupported Template format or fixed base directory');
  safeId(template.id); text(template.version, 'template version', 128); if (!version.test(template.version)) throw new Error('Template version must be exact');
  text(template.title, 'template title'); text(template.license, 'template license', 128);
  if (!Array.isArray(template.parameters) || template.parameters.length > 64) throw new Error('Template parameters must contain at most 64 entries');
  const names = new Set(), targets = new Set();
  for (const p of template.parameters) {
    closed(p, ['name', 'title', 'type', 'default', 'constraints', 'targets'], [], 'template parameter');
    safeId(p.name, 'parameter name'); if (names.has(p.name) || unsafeKey(p.name)) throw new Error('Duplicate or reserved Template parameter name'); names.add(p.name);
    text(p.title, 'parameter title'); if (!['string', 'number', 'integer', 'boolean'].includes(p.type)) throw new Error('Unsupported Template parameter type');
    const allowed = p.type === 'string' ? ['minLength', 'maxLength', 'enum'] : p.type === 'boolean' ? ['enum'] : ['minimum', 'maximum', 'enum'];
    closed(p.constraints, [], allowed, 'parameter constraints'); const c = p.constraints;
    for (const key of ['minLength', 'maxLength']) if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || c[key] < 0 || c[key] > 4096)) throw new Error('Invalid Template string constraint');
    if ((c.minLength ?? 0) > (c.maxLength ?? 4096)) throw new Error('Invalid Template string constraint range');
    for (const key of ['minimum', 'maximum']) if (c[key] !== undefined && (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || (p.type === 'integer' && !Number.isSafeInteger(c[key])))) throw new Error('Invalid Template numeric constraint');
    if (c.minimum !== undefined && c.maximum !== undefined && c.minimum > c.maximum) throw new Error('Invalid Template numeric constraint range');
    if (c.enum !== undefined) {
      if (!Array.isArray(c.enum) || !c.enum.length || c.enum.length > 64 || new Set(c.enum).size !== c.enum.length) throw new Error('Invalid Template enum');
      for (const value of c.enum) checkValue({ ...p, constraints: { ...c, enum: undefined } }, value);
    }
    checkValue(p, p.default);
    if (!Array.isArray(p.targets) || !p.targets.length || p.targets.length > 32) throw new Error('Invalid Template parameter targets');
    for (const target of p.targets) {
      if (target?.kind === 'topic') { closed(target, ['kind', 'key'], [], 'topic target'); safeId(target.key, 'topic target key'); if (p.type !== 'string') throw new Error('Topic parameters must be strings'); }
      else if (target?.kind === 'setting') {
        closed(target, ['kind', 'component', 'path'], [], 'business setting target'); safeId(target.component);
        if (!Array.isArray(target.path) || !target.path.length || target.path.length > 8 || target.path.some(k => typeof k !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(k) || unsafeKey(k) || reserved.test(k))) throw new Error('Template cannot parameterize commands, paths, credentials or runtime configuration');
      } else throw new Error('Template only parameterizes business settings and whole topic values');
      const key = targetKey(target); if (targets.has(key)) throw new Error('Duplicate Template target'); targets.add(key);
      if (pack) { const destination = targetValue(pack, target); checkValue({ ...p, constraints: {} }, destination.parent[destination.key]); }
    }
  }
  if (pack) materialize(template, pack, {}); // Defaults must yield a valid Pack.
  return template;
}
function materialize(template, base, values) {
  object(values, 'Template values');
  if (Object.keys(values).some(k => unsafeKey(k) || !template.parameters.some(p => p.name === k))) throw new Error('Unknown Template parameter');
  const pack = clone(base), selected = {};
  for (const p of template.parameters) {
    const value = Object.hasOwn(values, p.name) ? values[p.name] : p.default; checkValue(p, value); selected[p.name] = value;
    for (const target of p.targets) { const destination = targetValue(pack, target); destination.parent[destination.key] = value; }
  }
  validatePack(pack); return { pack, values: selected };
}
// Used by both filesystem tooling and hosted distribution validation. Byte data
// is supplied explicitly; this function does not access a filesystem or process.
export function validateTemplateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 8192) throw new Error('Invalid Template file set');
  const paths = new Set(); let total = 0;
  for (const f of files) {
    relativePath(f.path); const key = f.path.toLowerCase();
    if (f.path.split('/').some(p => ['__pycache__', '.venv', '.git', '.hub', '.state'].includes(p)) || /\.py[co]$/.test(f.path)) throw new Error('Template contains generated or private material');
    if (paths.has(key) || !Buffer.isBuffer(f.bytes) || f.bytes.length > 8 * 1024 * 1024 || (total += f.bytes.length) > 64 * 1024 * 1024) throw new Error('Invalid Template file data'); paths.add(key);
  }
  for (const path of paths) for (const ancestor of path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))) if (paths.has(ancestor)) throw new Error('Template file/directory collision');
  const getJson = path => {
    const f = files.find(f => f.path === path); if (!f) throw new Error(`Template lacks ${path}`);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(f.bytes));
  };
  const manifest = getJson('template.json'), pack = getJson('base/pack.json'), lock = getJson('base/pack.lock');
  validatePack(pack); validateLock(lock);
  if (lock.pack.id !== pack.id || lock.pack.version !== pack.version || lock.pack.sha256 !== hash(files.find(f => f.path === 'base/pack.json').bytes)) throw new Error('Template base lock identity or content hash mismatch');
  const allowed = new Set(['template.json', 'base/pack.json', 'base/pack.lock']); if (paths.has('readme.md')) allowed.add('README.md');
  const modules = [];
  for (const locked of lock.modules) {
    const prefix = `base/${locked.source}/`, manifest = getJson(prefix + 'module.json'); validateModule(manifest);
    if (manifest.id !== locked.id || manifest.version !== locked.version || !manifest.platforms.includes(`${lock.platform.os}-${lock.platform.arch}`)
        || !lock.runtimes[manifest.runtime.kind] || !locked.files.some(f => f.path === 'module.json') || !locked.files.some(f => f.path === manifest.runtime.entry)) throw new Error('Template base module identity, platform, runtime or entry mismatch');
    for (const f of locked.files) {
      const path = prefix + relativePath(f.path); allowed.add(path); const bytes = files.find(v => v.path === path)?.bytes;
      if (!bytes || hash(bytes) !== f.sha256) throw new Error('Template base module hash mismatch');
    }
    modules.push({ manifest, source: locked.source, files: clone(locked.files) });
  }
  if (files.some(f => !allowed.has(f.path))) throw new Error('Template includes private or unlocked files');
  for (const component of pack.components) {
    const module = modules.find(m => m.manifest.id === component.module)?.manifest;
    if (!module || module.bridges.length !== Object.keys(component.bridges).length || module.bridges.some(slot => !Object.hasOwn(component.bridges, slot))) throw new Error('Template base component bridge slots do not match');
    for (const contract of module.requires) if (!pack.bindings.some(b => b.to === component.id && b.contract.id === contract.id && b.contract.version === contract.version)) throw new Error('Template base required contract is unbound');
  }
  if (modules.some(m => !pack.components.some(c => c.module === m.manifest.id))) throw new Error('Template base includes unused module');
  for (const binding of pack.bindings) {
    const from = modules.find(m => m.manifest.id === pack.components.find(c => c.id === binding.from).module).manifest;
    const to = modules.find(m => m.manifest.id === pack.components.find(c => c.id === binding.to).module).manifest;
    const matches = contract => contract.id === binding.contract.id && contract.version === binding.contract.version;
    if (!from.provides.some(matches) || !to.requires.some(matches)) throw new Error('Template base capability binding is incompatible');
  }
  validateTemplate(manifest, pack);
  return { manifest, pack, lock, modules, files: files.map(f => ({ path: f.path, sha256: hash(f.bytes) })), platforms: [`${lock.platform.os}-${lock.platform.arch}`] };
}
export async function inspectTemplate(directory, options = {}) {
  cancelled(options); const root = await ordinaryPath(directory), listed = await collectFiles(root), decoded = [];
  for (const f of listed) { cancelled(options); const bytes = await readBounded(join(root, f.path), 8 * 1024 * 1024); if (hash(bytes) !== f.sha256) throw new Error('Template changed while reading'); decoded.push({ path: f.path, bytes }); }
  const checked = validateTemplateFiles(decoded);
  return { ...checked, directory: root, revision: hash(JSON.stringify(checked.files)), startsModules: false, probesInterpreters: false, writesFiles: false, requiresNewExecutionReview: true };
}
async function copyFiles(root, files, destination, options, prefix = '') {
  for (const f of files) {
    cancelled(options); const bytes = await readBounded(join(root, f.path), 8 * 1024 * 1024); if (hash(bytes) !== f.sha256) throw new Error('Locked Template source changed while copying');
    const target = join(destination, prefix, f.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}
export async function createTemplate(packDirectory, options = {}) {
  cancelled(options); if (options.redistributionAcknowledged !== true) throw new Error('Acknowledge redistribution rights before creating a shareable Template');
  const root = await ordinaryPath(packDirectory), packBytes = await readBounded(join(root, 'pack.json')), lockBytes = await readBounded(join(root, 'pack.lock'));
  const lock = JSON.parse(lockBytes.toString()); validateLock(lock); const files = [];
  for (const m of lock.modules) for (const f of m.files) {
    const path = `${m.source}/${f.path}`; files.push({ path, sha256: f.sha256 });
  }
  const templateBytes = Buffer.from(JSON.stringify(options.template, null, 2) + '\n');
  const decoded = [{ path: 'template.json', bytes: templateBytes }, { path: 'base/pack.json', bytes: packBytes }, { path: 'base/pack.lock', bytes: lockBytes }];
  for (const f of files) { cancelled(options); decoded.push({ path: `base/${f.path}`, bytes: await readBounded(join(root, relativePath(f.path)), 8 * 1024 * 1024) }); }
  const checked = validateTemplateFiles(decoded);
  if (options.expectedPackSha256 !== undefined && (!sha.test(options.expectedPackSha256) || options.expectedPackSha256 !== hash(packBytes))) throw new Error('Template creation Pack content changed');
  const destination = await ordinaryPath(options.destination, { allowMissing: true }); cancelled(options); await mkdir(destination, { mode: 0o700 });
  try {
    for (const f of decoded) { cancelled(options); const target = join(destination, f.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, f.bytes, { flag: 'wx', mode: 0o600 }); }
    const result = await inspectTemplate(destination, options); return { ...result, redistributionAcknowledged: true, licenses: checked.modules.map(m => ({ id: m.manifest.id, license: m.manifest.license })) };
  } catch (error) { error.incompleteDestination = destination; throw error; }
}
export async function previewTemplate(directory, options = {}) {
  const original = await inspectTemplate(directory, options);
  if (options.expectedRevision !== undefined && options.expectedRevision !== original.revision) throw new Error('Template revision conflict; inspect the current Template');
  const selected = materialize(original.manifest, original.pack, options.values ?? {}), pack = selected.pack;
  if (options.identity !== undefined) { closed(options.identity, ['id', 'version', 'title'], [], 'generated Pack identity'); Object.assign(pack, options.identity); validatePack(pack); }
  const packBytes = Buffer.from(JSON.stringify(pack, null, 2) + '\n'), lock = clone(original.lock);
  lock.pack = { id: pack.id, version: pack.version, sha256: hash(packBytes) }; validateLock(lock);
  const parameterDigest = hash(JSON.stringify(selected.values));
  const previewDigest = hash(JSON.stringify({ templateRevision: original.revision, parameterDigest, packSha256: lock.pack.sha256 }));
  if (options.expectedParameterDigest !== undefined && options.expectedParameterDigest !== parameterDigest) throw new Error('Template parameter revision conflict; preview the selected values again');
  if (options.expectedPreviewDigest !== undefined && options.expectedPreviewDigest !== previewDigest) throw new Error('Template preview conflict; inspect the current Template and selected Pack identity/values again');
  return { templateId: original.manifest.id, templateVersion: original.manifest.version, templateRevision: original.revision,
    pack, lock, values: selected.values, modules: original.modules, parameterDigest, previewDigest,
    startsModules: false, probesInterpreters: false, writesFiles: false, requiresNewExecutionReview: true, businessValidated: false };
}
export async function instantiateTemplate(directory, options = {}) {
  cancelled(options); if (options.redistributionAcknowledged !== true) throw new Error('Acknowledge component redistribution rights before generating a Pack');
  const source = await ordinaryPath(directory), preview = await previewTemplate(source, options);
  const destination = await ordinaryPath(options.destination, { allowMissing: true }); cancelled(options); await mkdir(destination, { mode: 0o700 });
  try {
    for (const m of preview.modules) await copyFiles(join(source, 'base', m.source), m.files, join(destination, m.source), options);
    await privateJson(join(destination, 'pack.json'), preview.pack, { exclusive: true }); await privateJson(join(destination, 'pack.lock'), preview.lock, { exclusive: true });
    const current = await inspectTemplate(source, options); if (current.revision !== preview.templateRevision) throw new Error('Template changed while generating Pack; review the incomplete destination');
    const provenance = { format: 'world-hub.template-instantiation/v1', template: { id: preview.templateId, version: preview.templateVersion, revision: preview.templateRevision },
      parameterDigest: preview.parameterDigest, packSha256: preview.lock.pack.sha256, redistributionAcknowledged: true };
    await privateJson(join(destination, 'authoring.json'), provenance, { exclusive: true });
    return { ...preview, directory: destination, provenance, writesFiles: true, requiresNewExecutionReview: true };
  } catch (error) { error.incompleteDestination = destination; throw error; }
}
