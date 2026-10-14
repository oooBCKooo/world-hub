// Launcher convenience only: bounded filesystem observation is not package validation.
import { lstat, opendir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ordinaryPath, privateJson, readBounded, relativePath } from '../../scripts/runtime/paths.mjs';
import { discoverEnvironment } from './environment.mjs';

export const pathPurposes = new Set(['pack', 'module', 'template', 'proposal', 'source', 'backup', 'comments', 'executable', 'directory', 'file', 'save-directory', 'save-file']);
export const discoveryLimits = Object.freeze({ depth: 4, entries: 2000, directories: 256, objects: 128, milliseconds: 2000, declarationBytes: 65536 });
export const knownLimits = Object.freeze({ entries: 512, directories: 128, objects: 128, milliseconds: 2000 });
export const nativePickerEncoding = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)';
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
    return {
      kind, path: directory, declaration: name, ...Object.fromEntries(['id', 'version', 'title'].map(key => [key, short(found.value?.[key])]).filter(([, value]) => value !== undefined)),
      ...(lockPresent === undefined ? {} : { lockPresent }), warnings, checked: false, requiresReview: true, startsModules: false,
      ...(kind === 'module' ? {
        description: short(found.value?.description),
        runtime: found.value?.runtime,
        provides: Array.isArray(found.value?.provides) ? found.value.provides : [],
        requires: Array.isArray(found.value?.requires) ? found.value.requires : []
      } : {}),
      ...(kind === 'template' ? {
        description: short(found.value?.description),
        license: short(found.value?.license),
        base: short(found.value?.base),
        parameters: Array.isArray(found.value?.parameters) ? found.value.parameters : []
      } : {})
    };
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

// A modal chooser is still an owned helper. Bound both output and lifetime;
// keep an unconfirmed child in the owner's set so shutdown can retry cleanup.
export function runPickerProcess(command, args, options = {}, { children = new Set(), timeoutMs = 120000, stopTimeoutMs = 3000, maxBytes = 16384 } = {}) {
  return new Promise((resolveResult, reject) => {
    let child, timer, stopTimer, failure = null, bytes = 0; const chunks = [];
    const finish = (error, value) => { clearTimeout(timer); clearTimeout(stopTimer); error ? reject(error) : resolveResult(value); };
    try { child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (error) { finish(fault('NATIVE_PICK_FAILED', `Could not open the system chooser: ${error.message}`)); return; }
    children.add(child);
    const terminate = error => {
      if (failure) return; failure = error;
      try { child.kill(); } catch {}
      stopTimer = setTimeout(() => finish(Object.assign(fault('CLEANUP_INCOMPLETE', 'System chooser exit remains unconfirmed. Retain the Launcher and retry shutdown.'), { cleanupIncomplete: true })), stopTimeoutMs);
    };
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) terminate(fault('NATIVE_PICK_OUTPUT_LIMIT', 'System chooser output exceeded its path bound.')); else chunks.push(chunk); });
    child.once('error', error => { children.delete(child); finish(fault('NATIVE_PICK_FAILED', `Could not open the system chooser: ${error.message}`)); });
    child.once('close', code => {
      children.delete(child);
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(null, null); return; }
      finish(null, Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '') || null);
    });
    timer = setTimeout(() => terminate(fault('NATIVE_PICK_TIMEOUT', 'System chooser timed out; choose a path in the Launcher or retry.')), timeoutMs);
  });
}

async function runNativePicker({ isDirectory, initialPath, title, children }) {
  if (process.env.WH_NATIVE_PICK_RESULT !== undefined) {
    return process.env.WH_NATIVE_PICK_RESULT || null;
  }
  if (process.platform === 'win32') {
      const script = `
${nativePickerEncoding}
Add-Type -AssemblyName System.Windows.Forms
$source = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[ComImport]
[Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

[ComImport]
[Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
}

[ComImport]
[Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
[ClassInterface(ClassInterfaceType.None)]
public class FileOpenDialogRCW {}

public class ModernPicker {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

    public static string Pick(bool isFolder, string initialPath, string title) {
        try {
            SetProcessDpiAwarenessContext((IntPtr)(-4));
        } catch {
            try { SetProcessDPIAware(); } catch {}
        }
        string selected = null;
        Thread t = new Thread(() => {
            try {
                IntPtr hDesk = OpenDesktop("default", 0, false, 0x10000000);
                if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
            } catch {}
            IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
            try {
                uint options = 0x00000040 | 0x00000800; // FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
                if (isFolder) {
                    options |= 0x00000020; // FOS_PICKFOLDERS
                } else {
                    options |= 0x00001000; // FOS_FILEMUSTEXIST
                }
                dialog.SetOptions(options);
                if (!string.IsNullOrEmpty(title)) {
                    dialog.SetTitle(title);
                }
                if (!string.IsNullOrEmpty(initialPath)) {
                    Guid shellItemGuid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                    IShellItem folderItem;
                    if (SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemGuid, out folderItem) == 0 && folderItem != null) {
                        dialog.SetFolder(folderItem);
                    }
                }
                using (Form owner = new Form()) {
                    owner.TopMost = true;
                    owner.Width = 0;
                    owner.Height = 0;
                    owner.StartPosition = FormStartPosition.CenterScreen;
                    owner.ShowInTaskbar = false;
                    int hr = dialog.Show(owner.Handle);
                    if (hr == 0) {
                        IShellItem resultItem;
                        dialog.GetResult(out resultItem);
                        if (resultItem != null) {
                            string path;
                            resultItem.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
                            selected = path;
                        }
                    }
                }
            } finally {
                Marshal.ReleaseComObject(dialog);
            }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        return selected;
    }
}
"@
Add-Type -TypeDefinition $source -ReferencedAssemblies "System.Windows.Forms"
$res = [ModernPicker]::Pick(($env:WH_PICK_FOLDER -eq '1'), $env:WH_INITIAL_PATH, $env:WH_PICK_TITLE)
if ($res) { [Console]::Out.Write($res) }
`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      return runPickerProcess('powershell.exe', ['-STA', '-NoProfile', '-EncodedCommand', encoded], {
        env: {
          ...process.env,
          WH_PICK_FOLDER: isDirectory ? '1' : '0',
          WH_INITIAL_PATH: initialPath ?? '',
          WH_PICK_TITLE: title ?? (isDirectory ? '选择目录' : '选择文件')
        }
      }, { children });
  } else if (process.platform === 'darwin') {
      const prompt = (title ?? (isDirectory ? '选择目录' : '选择文件')).replace(/"/g, '\\"');
      const script = isDirectory
        ? `try\nset p to POSIX path of (choose folder with prompt "${prompt}")\ndo shell script "printf %s " & quoted form of p\nend try`
        : `try\nset p to POSIX path of (choose file with prompt "${prompt}")\ndo shell script "printf %s " & quoted form of p\nend try`;
      return runPickerProcess('osascript', ['-e', script], {}, { children });
  } else if (process.platform === 'linux') {
      const args = ['--file-selection', `--title=${title ?? (isDirectory ? '选择目录' : '选择文件')}`];
      if (isDirectory) args.push('--directory');
      if (initialPath) args.push(`--filename=${initialPath}`);
      return runPickerProcess('zenity', args, {}, { children });
  }
  return null;
}

export class PathsService {
  constructor(root) { this.root = root; this.recents = []; this.discovered = []; this.queue = Promise.resolve(); this.children = new Set(); }
  async close() {
    for (const child of this.children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise((resolveClose, reject) => {
        const timer = setTimeout(() => reject(fault('CLEANUP_INCOMPLETE', 'System chooser exit remains unconfirmed; retry Launcher shutdown.')), 3000);
        child.once('close', () => { clearTimeout(timer); this.children.delete(child); resolveClose(); });
        try { child.kill(); } catch {}
      });
    }
  }
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
  async builtinTemplates(manager) {
    const candidates = []; let scannedEntries = 0, partial = false;
    const started = Date.now(), root = manager.defaults.templateDirectory;
    if (!root) return { candidates, partial, startsModules: false, requiresReview: true };
    try {
      const directory = await ordinaryPath(root);
      for await (const entry of await opendir(directory)) {
        if (scannedEntries >= 32 || Date.now() - started >= knownLimits.milliseconds) { partial = true; break; }
        scannedEntries++;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = await ordinaryPath(join(directory, entry.name)), object = await identifyDirectory(path);
        if (object?.kind !== 'template' || object.warnings.length) continue;
        let basePack = null, runtimeKinds = [], platforms = [], componentCount = null;
        try {
          const base = relativePath(object.base), baseDirectory = await ordinaryPath(join(path, base));
          const pack = (await declaration(baseDirectory, 'pack.json'))?.value;
          if (pack?.format === 'world-hub.pack/v1' && Array.isArray(pack.components) && pack.components.length <= 32) {
            componentCount = pack.components.length;
            basePack = { id: short(pack.id), title: short(pack.title), version: short(pack.version) };
            const modules = join(baseDirectory, 'modules'); let count = 0;
            for await (const module of await opendir(await ordinaryPath(modules))) {
              if (count++ >= 32 || Date.now() - started >= knownLimits.milliseconds) { partial = true; break; }
              if (!module.isDirectory() || module.isSymbolicLink()) continue;
              const manifest = (await declaration(join(modules, module.name), 'module.json'))?.value;
              if (['node', 'python'].includes(manifest?.runtime?.kind)) runtimeKinds.push(manifest.runtime.kind);
              if (Array.isArray(manifest?.platforms)) platforms.push(...manifest.platforms.filter(value => typeof value === 'string' && value.length <= 64));
            }
          }
        } catch { /* Identification is a hint; full template inspection follows selection. */ }
        candidates.push({ ...object, directory: path, origin: 'builtin', basePack, componentCount,
          runtimeKinds: [...new Set(runtimeKinds)], platforms: [...new Set(platforms)] });
      }
    } catch { partial = true; }
    return { candidates, scannedEntries, partial, startsModules: false, requiresReview: true };
  }
  async known(manager) {
    await this.queue;
    const places = [{ id: 'launcher', label: 'Launcher', path: this.root }, { id: 'home', label: basename(homedir()) || homedir(), path: homedir() }];
    for (const name of ['Desktop', 'Documents', 'Downloads']) try { const path = await ordinaryPath(join(homedir(), name)); if ((await lstat(path)).isDirectory()) places.push({ id: name.toLowerCase(), label: name, path }); } catch {}
    if (manager.defaults.packDirectory) places.push({ id: 'examples', label: 'Examples', path: dirname(manager.defaults.packDirectory) });
    const cache = join(this.root, 'source-cache'); let canonicalCache = null;
    try { const path = await ordinaryPath(cache); if ((await lstat(path)).isDirectory()) { canonicalCache = path; places.push({ id: 'cache', label: 'Source cache', path }); } } catch {}
    const objects = [], seen = new Set(), started = Date.now(); let scannedEntries = 0, scannedDirectories = 0, partial = false, skipped = 0;
    const exhausted = () => objects.length >= knownLimits.objects || scannedEntries >= knownLimits.entries
      || scannedDirectories >= knownLimits.directories || Date.now() - started >= knownLimits.milliseconds;
    const add = async path => {
      if (exhausted()) { partial = true; return; }
      if (seen.has(process.platform === 'win32' ? path.toLowerCase() : path)) return;
      seen.add(process.platform === 'win32' ? path.toLowerCase() : path);
      try { const canonical = await ordinaryPath(path), info = await lstat(canonical); const object = info.isDirectory() ? await identifyDirectory(canonical) : info.isFile() ? await identifyFile(canonical, 'file', info) : null; if (object) objects.push({ ...object, ...(canonicalCache && same(dirname(canonical), canonicalCache) ? { origin: 'cache' } : {}) }); } catch {}
    };
    const scan = async directory => {
      if (exhausted()) { partial = true; return; }
      scannedDirectories++;
      try {
        const canonical = await ordinaryPath(directory);
        for await (const entry of await opendir(canonical)) {
          if (exhausted()) { partial = true; break; }
          scannedEntries++;
          if (entry.isSymbolicLink()) { skipped++; continue; }
          if (entry.isDirectory() && !ignored.has(entry.name)) await add(join(canonical, entry.name));
        }
      } catch { skipped++; }
    };
    const builtin = await this.builtinTemplates(manager);
    partial ||= builtin.partial; scannedEntries += builtin.scannedEntries ?? 0;
    for (const candidate of builtin.candidates) { if (exhausted()) { partial = true; break; } objects.push(candidate); seen.add(process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path); }
    if (manager.defaults.packDirectory) {
      await add(manager.defaults.packDirectory);
      await scan(join(manager.defaults.packDirectory, 'modules'));
    }
    for (const row of manager.records.values()) {
      if (row.deletion) continue;
      if (exhausted()) { partial = true; break; }
      const pkgDir = join(this.root, 'instances', row.instanceId, row.detached ? 'detached-package' : 'package');
      await add(pkgDir);
      await scan(join(pkgDir, 'modules'));
    }
    const recents = [];
    for (const recent of this.recents) {
      let exists = false; try { await ordinaryPath(recent.path); exists = true; } catch {}
      recents.push({ ...recent, exists }); if (exists) await add(recent.path);
    }
    for (const object of this.discovered) { if (exhausted()) { partial = true; break; } await add(object.path); }
    await scan(cache);
    await scan(join(this.root,'local-artifacts'));
    for (const record of manager.sourceRegistry.records) { if (exhausted()) { partial = true; break; } if (!/^https?:/i.test(record.source)) await add(record.source); }
    const executables = exhausted() ? {} : await discoverEnvironment(manager.defaults);
    for (const [runtimeKind, group] of Object.entries(executables)) for (const entry of group) {
      if (exhausted()) { partial = true; break; }
      const checked = await this.check({ path: entry.path, purpose: 'executable' }).catch(() => null);
      if (checked?.selectable && !objects.some(object => same(object.path, checked.path))) objects.push({ kind: 'executable', path: checked.path, runtimeKind, warnings: ['CONTENTS_NOT_CHECKED'], checked: false, requiresReview: true, startsModules: false });
    }
    return { places, recents, objects, truncated: partial, partial, skipped, scannedEntries, scannedDirectories,
      limits: knownLimits, startsModules: false, requiresReview: true };
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
  async nativePick(input) {
    const purpose = purposeOf(input.purpose);
    if (this.children.size) throw fault('NATIVE_PICK_BUSY', 'Close the current system chooser before opening another.');
    const save = purpose.startsWith('save-'), isFile = filePurposes.has(purpose);
    let initialPath;
    if (input.initialPath) {
      try {
        const canonical = await ordinaryPath(absolute(input.initialPath), { allowMissing: true });
        let info; try { info = await lstat(canonical); } catch {}
        initialPath = info?.isDirectory() ? canonical : dirname(canonical);
      } catch {}
    }
    const selected = await runNativePicker({
      isDirectory: !isFile,
      initialPath,
      title: save ? '选择新输出的父目录 / Choose output parent directory' : isFile ? '选择文件 / Choose file' : '选择目录 / Choose directory',
      children: this.children
    });
    if (!selected) return { cancelled: true, startsModules: false };
    const checked = await this.check({ path: selected, purpose: save ? 'directory' : purpose });
    return {
      cancelled: false,
      path: checked.path,
      exists: checked.exists,
      kind: checked.kind,
      selectable: checked.selectable,
      purpose,
      selectionMode: save ? 'parent' : 'path',
      parent: checked.parent,
      object: checked.object,
      startsModules: false,
      requiresReview: true
    };
  }
}
