// Launcher convenience only: bounded filesystem observation is not package validation.
import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ordinaryPath, privateJson, readBounded } from '../../scripts/runtime/paths.mjs';
import { discoverEnvironment } from './environment.mjs';

export const pathPurposes = new Set(['pack', 'module', 'template', 'proposal', 'source', 'backup', 'comments', 'executable', 'directory', 'file', 'save-directory', 'save-file']);
export const discoveryLimits = Object.freeze({ depth: 4, entries: 2000, directories: 256, objects: 128, milliseconds: 2000, declarationBytes: 65536 });
const fault = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const ignored = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.state', '.hub', 'programs', 'runs', 'containers']);
const filePurposes = new Set(['source', 'backup', 'comments', 'executable', 'file']);
const purposeOf = value => { const purpose = value ?? 'directory'; if (!pathPurposes.has(purpose)) throw fault('PATH_PURPOSE_INVALID', 'Choose a supported path purpose.', 400); return purpose; };
const absolute = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0') || !isAbsolute(value))
    throw fault('PATH_INPUT_INVALID', 'Use an absolute local path.', 400);
  return resolve(value);
};
function validateSavePath(path) {
  if (process.platform !== 'win32') return;
  // The volume spelling owns its drive colon. Components cannot address ADS,
  // devices, or Win32 names which normalize to a different destination.
  for (const part of path.slice(parse(path).root.length).split(/[\\/]/).filter(Boolean)) {
    if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
      throw fault('PATH_NAME_INVALID', 'Output paths cannot contain Windows device names, alternate data streams, invalid characters, or trailing dots/spaces.', 400);
  }
}
const short = value => typeof value === 'string' ? value.slice(0, 256) : undefined;
const shellFile = (path, info) => process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'].includes(extname(path).toLowerCase()) : Boolean(info.mode & 0o111);
const selectable = (kind, purpose, path, info) => kind === 'directory' ? !filePurposes.has(purpose)
  : kind === 'file' && filePurposes.has(purpose) && (purpose !== 'executable' || shellFile(path, info));

async function declaration(directory, name) {
  const file = join(directory, name);
  try {
    const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile()) return { warning: 'DECLARATION_NOT_ORDINARY' };
    if (info.size > discoveryLimits.declarationBytes) return { warning: 'DECLARATION_TOO_LARGE' };
    const value = JSON.parse((await readBounded(file, discoveryLimits.declarationBytes)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { warning: 'DECLARATION_INVALID' };
    return { value };
  } catch (error) { if (error.code === 'ENOENT') return null; return { warning: 'DECLARATION_UNREADABLE' }; }
}
export async function identifyDirectory(directory) {
  for (const [kind, name, format] of [['pack', 'pack.json', 'world-hub.pack/v1'], ['module', 'module.json', 'world-hub.module/v1'],
    ['template', 'template.json', 'world-hub.template/v1'], ['proposal', 'proposal.json', 'world-hub.proposal/v1']]) {
    const found = await declaration(directory, name); if (!found) continue;
    const warnings = found.warning ? [found.warning] : [];
    if (found.value && found.value.format !== format) warnings.push('DECLARATION_FORMAT_UNRECOGNIZED');
    let lockPresent;
    if (kind === 'pack') { try { const lock = await lstat(join(directory, 'pack.lock')); lockPresent = lock.isFile() && !lock.isSymbolicLink(); } catch { lockPresent = false; } if (!lockPresent) warnings.push('PACK_LOCK_MISSING'); }
    return { kind, path: directory, declaration: name, ...Object.fromEntries(['id', 'version', 'title'].map(key => [key, short(found.value?.[key])]).filter(([, value]) => value !== undefined)),
      ...(lockPresent === undefined ? {} : { lockPresent }), warnings, checked: false, requiresReview: true, startsModules: false };
  }
  return null;
}
async function identifyFile(path, purpose, info) {
  let kind = extname(path).toLowerCase() === '.whbackup' ? 'backup' : shellFile(path, info) ? 'executable' : null;
  if (info.size <= discoveryLimits.declarationBytes && extname(path).toLowerCase() === '.json') {
    try {
      const value = JSON.parse((await readBounded(path, discoveryLimits.declarationBytes)).toString('utf8'));
      const found = { 'world-hub.source-index/v1': 'source', 'world-hub.comments/v1': 'comments' }[value?.format];
      if (found) return { kind: found, path, ...Object.fromEntries(['id', 'version', 'title'].map(key => [key, short(value?.[key])]).filter(([, value]) => value !== undefined)), warnings: [], checked: false, requiresReview: true, startsModules: false };
    } catch { /* File selection does not validate business or archive contents. */ }
  }
  return kind ? { kind, path, warnings: ['CONTENTS_NOT_CHECKED'], checked: false, requiresReview: true, startsModules: false } : null;
}

export class PathsService {
  constructor(root) { this.root = root; this.recents = []; this.discovered = []; this.queue = Promise.resolve(); }
  async initialize() {
    try {
      const value = JSON.parse((await readBounded(join(this.root, 'launcher-paths.json'), 128 * 1024)).toString('utf8'));
      if (value.format !== 'world-hub.launcher-paths/v1' || !Array.isArray(value.recents) || value.recents.length > 32) throw fault('PATH_RECENTS_INVALID', 'Inspect the private recent-path registry.');
      this.recents = value.recents.map(row => ({ path: absolute(row.path), purpose: purposeOf(row.purpose), usedAt: short(row.usedAt) ?? '' }));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async roots() {
    const candidates = process.platform === 'win32' ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => letter + ':\\') : ['/'];
    const roots = [];
    for (const path of candidates) try { const canonical = await ordinaryPath(path); if ((await lstat(canonical)).isDirectory()) roots.push({ name: canonical, path: canonical }); } catch {}
    return roots;
  }
  async check(input) {
    const path = absolute(input.path), purpose = purposeOf(input.purpose), save = purpose.startsWith('save-');
    if (save) validateSavePath(path);
    const canonical = await ordinaryPath(path, { allowMissing: true }); let info;
    try { info = await lstat(canonical); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const kind = info?.isDirectory() ? 'directory' : info?.isFile() ? 'file' : info ? 'blocked' : 'missing';
    const parent = dirname(canonical); let parentExists = false;
    try { parentExists = (await lstat(await ordinaryPath(parent))).isDirectory(); } catch {}
    return { path: canonical, exists: Boolean(info), kind, selectable: save ? !info && parentExists : selectable(kind, purpose, canonical, info),
      parent, parentExists, purpose, ...(kind === 'directory' ? { object: await identifyDirectory(canonical) } : kind === 'file' ? { object: await identifyFile(canonical, purpose, info) } : {}), requiresReview: true, startsModules: false };
  }
  async browse(input = {}) {
    const purpose = purposeOf(input.purpose), offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fault('PATH_OFFSET_INVALID', 'Invalid directory page.', 400);
    const path = absolute(input.directory ?? this.root), directory = await ordinaryPath(path);
    if (!(await lstat(directory)).isDirectory()) throw fault('PATH_NOT_DIRECTORY', 'Choose a directory to browse.', 400);
    const entries = []; let seen = 0, truncated = false;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (seen++ < offset) continue;
      if (entries.length >= 100) { truncated = true; break; }
      const path = join(directory, entry.name); let info, kind = 'blocked';
      try { const canonical = await ordinaryPath(path); info = await lstat(canonical); kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'blocked'; } catch {}
      entries.push({ name: entry.name, path, kind, selectable: selectable(kind, purpose, path, info),
        ...(kind === 'directory' ? { object: await identifyDirectory(path) } : kind === 'file' ? { object: await identifyFile(path, purpose, info) } : {}) });
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
    const parent = dirname(directory);
    return { directory, parent: same(parent, directory) ? null : parent, roots: await this.roots(), entries, offset,
      nextOffset: truncated ? offset + entries.length : null, truncated, purpose, startsModules: false };
  }
  async remember(input) {
    const purpose = purposeOf(input.purpose), checked = await this.check({ path: input.path, purpose });
    if ((!purpose.startsWith('save-') && !checked.exists) || checked.kind === 'blocked') throw fault('PATH_UNAVAILABLE', 'This path is unavailable.');
    const action = this.queue.then(async () => {
      this.recents = [{ path: checked.path, purpose, usedAt: new Date().toISOString() }, ...this.recents.filter(row => !same(row.path, checked.path) || row.purpose !== purpose)].slice(0, 32);
      await privateJson(join(this.root, 'launcher-paths.json'), { format: 'world-hub.launcher-paths/v1', recents: this.recents });
      return { remembered: true, path: checked.path };
    }); this.queue = action.catch(() => {}); return action;
  }
  async known(manager) {
    await this.queue;
    const places = [{ id: 'launcher', label: 'Launcher', path: this.root }, { id: 'home', label: basename(homedir()) || homedir(), path: homedir() }];
    for (const name of ['Desktop', 'Documents', 'Downloads']) try { const path = await ordinaryPath(join(homedir(), name)); if ((await lstat(path)).isDirectory()) places.push({ id: name.toLowerCase(), label: name, path }); } catch {}
    if (manager.defaults.packDirectory) places.push({ id: 'examples', label: 'Examples', path: dirname(manager.defaults.packDirectory) });
    const cache = join(this.root, 'source-cache'); let canonicalCache = null;
    try { const path = await ordinaryPath(cache); if ((await lstat(path)).isDirectory()) { canonicalCache = path; places.push({ id: 'cache', label: 'Source cache', path }); } } catch {}
    const objects = [], seen = new Set(), add = async path => {
      if (objects.length >= 128 || seen.has(process.platform === 'win32' ? path.toLowerCase() : path)) return;
      seen.add(process.platform === 'win32' ? path.toLowerCase() : path);
      try { const canonical = await ordinaryPath(path), info = await lstat(canonical); const object = info.isDirectory() ? await identifyDirectory(canonical) : info.isFile() ? await identifyFile(canonical, 'file', info) : null; if (object) objects.push({ ...object, ...(canonicalCache && same(dirname(canonical), canonicalCache) ? { origin: 'cache' } : {}) }); } catch {}
    };
    if (manager.defaults.packDirectory) await add(manager.defaults.packDirectory);
    for (const row of manager.records.values()) await add(join(this.root, 'instances', row.instanceId, row.detached ? 'detached-package' : 'package'));
    const recents = [];
    for (const recent of this.recents) {
      let exists = false; try { await ordinaryPath(recent.path); exists = true; } catch {}
      recents.push({ ...recent, exists }); if (exists) await add(recent.path);
    }
    for (const object of this.discovered) await add(object.path);
    try { let count = 0; for await (const entry of await opendir(await ordinaryPath(cache))) { if (++count > 128) break; if (entry.isDirectory() && !entry.isSymbolicLink()) await add(join(cache, entry.name)); } } catch {}
    for (const record of manager.sourceRegistry.records) if (!/^https?:/i.test(record.source)) await add(record.source);
    const executables = await discoverEnvironment(manager.defaults);
    for (const [runtimeKind, group] of Object.entries(executables)) for (const entry of group) {
      if (objects.length >= 128) break;
      const checked = await this.check({ path: entry.path, purpose: 'executable' }).catch(() => null);
      if (checked?.selectable && !objects.some(object => same(object.path, checked.path))) objects.push({ kind: 'executable', path: checked.path, runtimeKind, warnings: ['CONTENTS_NOT_CHECKED'], checked: false, requiresReview: true, startsModules: false });
    }
    return { places, recents, objects, truncated: objects.length >= 128, startsModules: false, requiresReview: true };
  }
  async discover(input, signal) {
    const directory = await ordinaryPath(absolute(input.directory));
    if (!(await lstat(directory)).isDirectory()) throw fault('PATH_NOT_DIRECTORY', 'Choose a directory to discover.', 400);
    // Root recursion is never implicit; a user must choose a narrower directory.
    if (same(directory, parse(directory).root)) throw fault('SCAN_ROOT_REFUSED', 'Choose a project or collection directory instead of a whole filesystem root.', 400);
    const queue = [{ path: directory, depth: 0 }], objects = [], started = Date.now(); let entries = 0, directories = 0, skipped = 0, partial = false;
    const exhausted = () => signal?.aborted || Date.now() - started >= discoveryLimits.milliseconds || entries >= discoveryLimits.entries || directories >= discoveryLimits.directories || objects.length >= discoveryLimits.objects;
    while (queue.length && !exhausted()) {
      const next = queue.shift(); directories++;
      try {
        await ordinaryPath(next.path); const object = await identifyDirectory(next.path); if (object) objects.push(object);
        if (exhausted()) { partial = true; break; }
        for await (const entry of await opendir(next.path)) {
          if (exhausted()) { partial = true; break; } entries++;
          if (entry.isSymbolicLink()) { skipped++; continue; }
          if (!entry.isDirectory()) continue;
          if (ignored.has(entry.name) || next.depth >= discoveryLimits.depth) { skipped++; partial = true; continue; }
          queue.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
        }
      } catch { skipped++; partial = true; }
    }
    partial ||= queue.length > 0 || Boolean(signal?.aborted);
    this.discovered = [...objects, ...this.discovered.filter(old => !objects.some(found => same(found.path, old.path)))].slice(0, 128);
    return { directory, objects, partial, cancelled: Boolean(signal?.aborted), skipped, scannedEntries: entries, scannedDirectories: directories,
      limits: discoveryLimits, startsModules: false, requiresReview: true };
  }
}
