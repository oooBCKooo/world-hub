import { readFile, readdir, mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, relativePath, ordinaryPath, readBounded, collectFiles, privateJson, processCwd, processPath, checkPythonExecutablePath } from './paths.mjs';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const sha = /^[a-f0-9]{64}$/;
const object = (v, name) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object`); };
function closed(v, keys, name) {
  object(v, name);
  if (Object.keys(v).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(v, k))) throw new Error(`${name} has missing or unsupported fields`);
}
function text(v, name, max = 256) { if (typeof v !== 'string' || !v || v.length > max || v.includes('\0')) throw new Error(`Invalid ${name}`); }
export function safeId(v, name = 'ID') { if (typeof v !== 'string' || !idPattern.test(v)) throw new Error(`Invalid ${name}`); return v; }
function version(v) { if (typeof v !== 'string' || v.length > 128 || !semver.test(v)) throw new Error(`Invalid exact version: ${v}`); }
function array(v, name, min, max) { if (!Array.isArray(v) || v.length < min || v.length > max) throw new Error(`${name} must contain ${min}..${max} entries`); }
function unique(v, name, key = x => x) { const values = v.map(key); if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}`); }
function contracts(v, name) {
  array(v, name, 0, 32);
  for (const c of v) { closed(c, ['id', 'version'], name); text(c.id, 'contract ID', 128); version(c.version); }
  unique(v, name, c => `${c.id}@${c.version}`);
}
export function validateModule(m) {
  closed(m, ['format', 'id', 'version', 'license', 'platforms', 'runtime', 'bridges', 'provides', 'requires', 'permissions'], 'module');
  if (m.format !== 'world-hub.module/v1') throw new Error('Unsupported module format');
  safeId(m.id); version(m.version); text(m.license, 'license', 128);
  array(m.platforms, 'platforms', 1, 32); unique(m.platforms, 'platform');
  for (const p of m.platforms) if (typeof p !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(p)) throw new Error('Invalid module platform');
  closed(m.runtime, ['kind', 'entry'], 'runtime');
  if (!['node', 'python'].includes(m.runtime.kind)) throw new Error('Reference Runtime v1 supports node and python modules');
  relativePath(m.runtime.entry);
  array(m.bridges, 'bridges', 1, 8); m.bridges.forEach(v => safeId(v, 'bridge slot')); unique(m.bridges, 'bridge slot');
  contracts(m.provides, 'provides'); contracts(m.requires, 'requires');
  closed(m.permissions, ['filesystem', 'network', 'processes'], 'permissions');
  if (m.permissions.filesystem !== 'instance-state' || m.permissions.processes !== 'none') throw new Error('Unsupported permission declaration');
  array(m.permissions.network, 'network permissions', 1, 2); unique(m.permissions.network, 'network permission');
  if (m.permissions.network.some(p => !['hub-loopback', 'loopback-listen'].includes(p))) throw new Error('Unsupported network permission declaration');
  return m;
}
export function validatePack(p) {
  closed(p, ['format', 'id', 'version', 'title', 'license', 'topics', 'components', 'bindings', 'entry', 'startupTimeoutMs', 'healthTimeoutMs', 'stopTimeoutMs'], 'pack');
  if (p.format !== 'world-hub.pack/v1') throw new Error('Unsupported pack format');
  safeId(p.id); version(p.version); text(p.title, 'title'); text(p.license, 'license', 128);
  object(p.topics, 'topics'); const names = Object.keys(p.topics); array(names, 'topics', 1, 64);
  for (const [name, topic] of Object.entries(p.topics)) {
    safeId(name, 'topic key');
    if (typeof topic !== 'string' || !topic || topic.length > 512 || /[\s\0#+]/.test(topic) || topic.split('/').some(s => !s)) throw new Error(`Invalid concrete topic: ${name}`);
  }
  unique(Object.values(p.topics), 'concrete topic');
  array(p.components, 'components', 1, 32); unique(p.components, 'component', c => c?.id);
  for (const c of p.components) {
    closed(c, ['id', 'module', 'after', 'settings', 'bridges'], 'component'); safeId(c.id); relativePath(c.id); safeId(c.module);
    array(c.after, 'after', 0, 31); c.after.forEach(v => safeId(v)); unique(c.after, 'dependency');
    object(c.settings, 'settings'); if (Buffer.byteLength(JSON.stringify(c.settings)) > 65536) throw new Error('Settings exceeds 64 KiB');
    object(c.bridges, 'component bridges'); array(Object.keys(c.bridges), 'component bridges', 1, 8);
    for (const [slot, b] of Object.entries(c.bridges)) {
      safeId(slot, 'bridge slot'); closed(b, ['publish', 'subscribe'], 'bridge ACL');
      for (const action of ['publish', 'subscribe']) {
        array(b[action], action, 0, 64); unique(b[action], 'topic binding');
        if (b[action].some(k => !names.includes(k))) throw new Error('Bridge ACL refers to missing topic');
      }
    }
  }
  const ids = p.components.map(c => c.id);
  for (const c of p.components) if (c.after.some(id => !ids.includes(id) || id === c.id)) throw new Error('Invalid component dependency');
  const ordered = [], visiting = new Set(), visited = new Set();
  function visit(c) {
    if (visiting.has(c.id)) throw new Error('Component dependency cycle');
    if (visited.has(c.id)) return;
    visiting.add(c.id); c.after.forEach(id => visit(p.components.find(x => x.id === id)));
    visiting.delete(c.id); visited.add(c.id); ordered.push(c);
  }
  p.components.forEach(visit);
  array(p.bindings, 'bindings', 0, 1024); unique(p.bindings, 'contract binding', b => JSON.stringify([b?.from, b?.to, b?.contract?.id, b?.contract?.version]));
  for (const b of p.bindings) {
    closed(b, ['from', 'to', 'contract'], 'binding');
    if (!ids.includes(b.from) || !ids.includes(b.to) || b.from === b.to) throw new Error('Invalid contract binding endpoint');
    contracts([b.contract], 'binding contract');
  }
  closed(p.entry, ['component'], 'entry'); if (!ids.includes(p.entry.component)) throw new Error('Missing entry component');
  for (const key of ['startupTimeoutMs', 'healthTimeoutMs', 'stopTimeoutMs']) if (!Number.isInteger(p[key]) || p[key] < 100 || p[key] > 60000) throw new Error(`Invalid ${key}`);
  return ordered;
}
export function filteredEnv(executable, temporary) {
  const env = { PATH: process.platform === 'win32' ? `${dirname(executable)};${process.env.SystemRoot || 'C:\\Windows'}\\System32` : `${dirname(executable)}:/usr/bin:/bin`,
    PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  if (temporary) { env.TEMP = temporary; env.TMP = temporary; env.TMPDIR = temporary; }
  return env;
}
async function interpreter(command, kind, packages = {}) {
  let selected = command ?? (kind === 'node' ? process.execPath : process.platform === 'win32' ? 'python.exe' : 'python3');
  if (!selected.includes('/') && !selected.includes('\\')) {
    let found = null;
    for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
      if (!directory) continue;
      const candidate = join(directory, selected);
      try { if ((await lstat(candidate)).isFile()) { found = candidate; break; } } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    if (!found) throw new Error(`Missing ${kind} runtime: ${selected}`);
    selected = found;
  }
  selected = await realpath(resolve(selected));
  if (kind === 'python') await checkPythonExecutablePath(selected);
  const code = kind === 'node' ? 'console.log(JSON.stringify({executable:process.execPath,version:process.versions.node,packages:{}}))'
    : 'import sys,json,importlib.metadata; print(json.dumps({"executable":sys.executable,"version":".".join(map(str,sys.version_info[:3])),"packages":{name:importlib.metadata.version(name) for name in json.loads(sys.argv[1])}}))';
  const args = kind === 'node' ? ['-e', code] : ['-I', '-c', code, JSON.stringify(Object.keys(packages))];
  // Explicit interpreter probes only, never a module/install script.
  const result = spawnSync(processPath(selected), args, { cwd: processCwd(), shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: filteredEnv(resolve(selected)) });
  if (result.error || result.status !== 0) throw new Error(`Missing or unusable ${kind} runtime/dependency: ${result.error?.message || result.stderr}`);
  let actual;
  try { actual = JSON.parse(result.stdout.trim()); } catch { throw new Error(`Invalid ${kind} runtime probe response`); }
  version(actual.version); object(actual.packages, 'runtime package versions');
  for (const [name, wanted] of Object.entries(packages)) if (actual.packages[name] !== wanted) throw new Error(`Runtime dependency version mismatch: ${name} expected ${wanted}, found ${actual.packages[name]}`);
  actual.executable = await realpath(actual.executable);
  if (actual.executable.toLowerCase() !== selected.toLowerCase()) throw new Error('Interpreter wrappers are unsupported: reported executable differs from reviewed executable');
  if (!(await lstat(actual.executable)).isFile()) throw new Error('Interpreter is not a regular executable');
  actual.sha256 = hash(await readFile(actual.executable));
  return actual;
}
export function validateLock(lock) {
  closed(lock, ['format', 'pack', 'hubVersion', 'platform', 'runtimes', 'modules'], 'lock');
  if (lock.format !== 'world-hub.pack-lock/v1') throw new Error('Unsupported lock format');
  closed(lock.pack, ['id', 'version', 'sha256'], 'locked pack'); safeId(lock.pack.id); version(lock.pack.version);
  if (!sha.test(lock.pack.sha256)) throw new Error('Invalid pack hash');
  version(lock.hubVersion); closed(lock.platform, ['os', 'arch'], 'locked platform');
  text(lock.platform.os, 'OS', 32); text(lock.platform.arch, 'architecture', 32);
  object(lock.runtimes, 'locked runtimes');
  if (!lock.runtimes.node || Object.keys(lock.runtimes).some(k => !['node', 'python'].includes(k))) throw new Error('Unsupported locked runtime');
  for (const [kind, r] of Object.entries(lock.runtimes)) {
    closed(r, kind === 'python' ? ['version', 'packages'] : ['version'], 'locked runtime'); version(r.version);
    if (kind === 'python') {
      object(r.packages, 'Python packages'); if (Object.keys(r.packages).length > 32) throw new Error('Too many Python dependencies');
      for (const [name, v] of Object.entries(r.packages)) { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('Invalid dependency name'); version(v); }
    }
  }
  array(lock.modules, 'locked modules', 1, 32); unique(lock.modules, 'locked module', m => m?.id); unique(lock.modules, 'module source', m => m?.source?.toLowerCase());
  for (const m of lock.modules) {
    closed(m, ['id', 'version', 'source', 'files'], 'locked module'); safeId(m.id); version(m.version); relativePath(m.source);
    array(m.files, 'locked files', 1, 4096); unique(m.files, 'locked file', f => f?.path?.toLowerCase());
    for (const f of m.files) { closed(f, ['path', 'sha256'], 'locked file'); relativePath(f.path); if (!sha.test(f.sha256)) throw new Error('Invalid file hash'); }
  }
  for (const a of lock.modules) for (const b of lock.modules) if (a !== b && b.source.toLowerCase().startsWith(a.source.toLowerCase() + '/')) throw new Error('Overlapping module source trees');
}
async function loadJson(file) { const raw = await readBounded(file); let value; try { value = JSON.parse(raw.toString('utf8')); } catch { throw new Error(`Invalid JSON: ${file}`); } return { value, raw }; }
function checkNodePackagePaths(modules, directory) {
  if (process.platform !== 'win32') return;
  for (const module of modules.filter(m => m.manifest.runtime.kind === 'node')) {
    for (const file of module.files.filter(f => f.path.split('/').at(-1).toLowerCase() === 'package.json')) {
      if (join(directory, module.source, file.path).length >= 248)
        throw Object.assign(new Error('Windows Node package.json path must be shorter than 248 characters to preserve native package scope and imports. Use a shorter package or instance root; program working directories are unchanged.'), { code: 'NODE_PACKAGE_PATH_TOO_LONG' });
    }
  }
}
export async function inspectPackage(packDirectory, options = {}) {
  const directory = await ordinaryPath(packDirectory);
  const { value: pack, raw: packBytes } = await loadJson(join(directory, 'pack.json'));
  const ordered = validatePack(pack);
  const { value: lock, raw: lockBytes } = await loadJson(join(directory, 'pack.lock'));
  validateLock(lock);
  if (lock.pack.id !== pack.id || lock.pack.version !== pack.version || lock.pack.sha256 !== hash(packBytes)) throw new Error('Pack lock identity or content hash mismatch');
  if (lock.platform.os !== process.platform || lock.platform.arch !== process.arch) throw new Error(`Incompatible platform: requires ${lock.platform.os}-${lock.platform.arch}`);
  const hubVersion = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
  if (lock.hubVersion !== hubVersion) throw new Error(`Hub version mismatch: expected ${lock.hubVersion}, installed ${hubVersion}`);
  const modules = [];
  for (const locked of lock.modules) {
    const source = join(directory, locked.source);
    const actual = await collectFiles(source);
    if (actual.length !== locked.files.length || actual.some(f => locked.files.find(x => x.path === f.path)?.sha256 !== f.sha256)) throw new Error(`Module file hash or file set mismatch: ${locked.id}`);
    const { value: manifest } = await loadJson(join(source, 'module.json')); validateModule(manifest);
    if (manifest.id !== locked.id || manifest.version !== locked.version) throw new Error('Locked module identity/version mismatch');
    if (!manifest.platforms.includes(`${process.platform}-${process.arch}`)) throw new Error(`Module platform unsupported: ${manifest.id}`);
    if (!locked.files.some(f => f.path === manifest.runtime.entry)) throw new Error('Module entry is not locked');
    if (!lock.runtimes[manifest.runtime.kind]) throw new Error('Module runtime not locked');
    modules.push({ manifest, source: locked.source, files: actual });
  }
  checkNodePackagePaths(modules, directory);
  for (const c of pack.components) {
    const module = modules.find(m => m.manifest.id === c.module)?.manifest;
    if (!module) throw new Error(`Missing module dependency: ${c.module}`);
    if (Object.keys(c.bridges).length !== module.bridges.length || module.bridges.some(slot => !Object.hasOwn(c.bridges, slot))) throw new Error(`Bridge slots do not match module declaration: ${c.id}`);
    for (const required of module.requires) {
      if (!pack.bindings.some(b => b.to === c.id && b.contract.id === required.id && b.contract.version === required.version)) throw new Error(`Unbound required contract: ${c.id}/${required.id}`);
    }
  }
  if (modules.some(m => !pack.components.some(c => c.module === m.manifest.id))) throw new Error('Unused locked module');
  for (const b of pack.bindings) {
    const from = modules.find(m => m.manifest.id === pack.components.find(c => c.id === b.from).module).manifest;
    const to = modules.find(m => m.manifest.id === pack.components.find(c => c.id === b.to).module).manifest;
    const match = c => c.id === b.contract.id && c.version === b.contract.version;
    if (!from.provides.some(match) || !to.requires.some(match)) throw new Error('Incompatible declared capability contract binding');
  }
  const environment = {};
  for (const [kind, pinned] of Object.entries(lock.runtimes)) {
    environment[kind] = await interpreter(options[`${kind}Path`], kind, pinned.packages ?? {});
    if (environment[kind].version !== pinned.version) throw new Error(`${kind} version mismatch: expected ${pinned.version}, found ${environment[kind].version}`);
  }
  const digest = hash(JSON.stringify({ packBytes: hash(packBytes), lockBytes: hash(lockBytes), modules, environment }));
  return { format: 'world-hub.review/v1', digest, directory, pack, lock, modules, order: ordered.map(c => c.id), environment,
    startsModules: false, sandbox: false, permissions: modules.map(m => ({ module: m.manifest.id, declared: m.manifest.permissions, enforced: false })) };
}
export async function createLock(packDirectory, options = {}) {
  const directory = await ordinaryPath(packDirectory);
  const { value: pack, raw } = await loadJson(join(directory, 'pack.json')); validatePack(pack);
  const sources = options.moduleSources ?? (await readdir(join(directory, 'modules'), { withFileTypes: true })).filter(x => x.isDirectory()).map(x => `modules/${x.name}`);
  const modules = [];
  for (const source of sources) {
    relativePath(source); const { value: manifest } = await loadJson(join(directory, source, 'module.json')); validateModule(manifest);
    modules.push({ id: manifest.id, version: manifest.version, source, files: await collectFiles(join(directory, source)) });
  }
  const node = await interpreter(options.nodePath, 'node');
  const runtimes = { node: { version: node.version } };
  let hasPython = false;
  for (const m of modules) if ((await loadJson(join(directory, m.source, 'module.json'))).value.runtime.kind === 'python') hasPython = true;
  if (hasPython) {
    const packages = options.pythonPackages ?? { websockets: '15.0.1' };
    const python = await interpreter(options.pythonPath, 'python', packages); runtimes.python = { version: python.version, packages: python.packages };
  }
  const lock = { format: 'world-hub.pack-lock/v1', pack: { id: pack.id, version: pack.version, sha256: hash(raw) },
    hubVersion: JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version,
    platform: { os: process.platform, arch: process.arch }, runtimes, modules: modules.sort((a, b) => a.id.localeCompare(b.id, 'en')) };
  validateLock(lock);
  if (options.write !== false) await privateJson(join(directory, 'pack.lock'), lock);
  return lock;
}
export function instancePath(root, instanceId) { safeId(instanceId, 'instance ID'); relativePath(instanceId); return join(resolve(root), 'instances', instanceId); }
export async function copyPackage(plan, destination) {
  const canonicalDestination = await ordinaryPath(destination, { allowMissing: true });
  checkNodePackagePaths(plan.modules, canonicalDestination);
  await mkdir(destination, { mode: 0o700 });
  const files = ['pack.json', 'pack.lock', ...plan.modules.flatMap(m => m.files.map(f => `${m.source}/${f.path}`))];
  for (const file of files) {
    const to = join(destination, relativePath(file)); await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await writeFile(to, await readBounded(join(plan.directory, file), 8 * 1024 * 1024), { flag: 'wx', mode: 0o600 });
  }
}
export async function importPackage(packDirectory, options) {
  const plan = await inspectPackage(packDirectory, options);
  const stateDir = instancePath(options.root, options.instanceId);
  const canonicalState = await ordinaryPath(stateDir, { allowMissing: true });
  checkNodePackagePaths(plan.modules, join(canonicalState, 'package'));
  await mkdir(dirname(stateDir), { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  await copyPackage(plan, join(stateDir, 'package'));
  const copied = await inspectPackage(join(stateDir, 'package'), options);
  // Digest excludes deployment location; copies with identical bytes/environment have identical reviews.
  if (copied.digest !== plan.digest) throw new Error('Source package changed while importing; review the incomplete import before removing it');
  await privateJson(join(stateDir, 'instance.json'), { format: 'world-hub.instance/v1', instanceId: options.instanceId, digest: plan.digest, importedAt: new Date().toISOString() }, { exclusive: true });
  return { instanceId: options.instanceId, stateDir, digest: plan.digest, plan: copied };
}
