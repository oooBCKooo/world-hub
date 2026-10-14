// Optional deployment preparation. Hub Core does not install applications.
// Registry archives are data: module/package lifecycle hooks are never run.
import { mkdir, writeFile, readFile, readdir, lstat, open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { inspectDeployment } from './deployment.mjs';
import { collectSourceFiles } from './source-guidance.mjs';
import { ordinaryPath, readBounded, relativePath, hash, privateJson } from './paths.mjs';
import { ownProcess } from './process.mjs';

const FORMAT = 'world-hub.prepared-dependencies/v1';
const ELECTRON_ARCHIVE = { url: 'https://registry.npmjs.org/electron/-/electron-44.7.1.tgz',
  integrity: 'sha512-41b08f4Lq55NiH2UzLaE4WMdW3ufFfln3sAVeXpnRrFbzOwBZckK3XpxlMvPcgHbNNApYiOr3r3hMD+Oyrq2dw==' };
const MiB = 1024 * 1024;
const LIMITS = { archive: 32 * MiB, expanded: 256 * MiB, packageFile: 64 * MiB,
  installedFile: 512 * MiB, installedTotal: 1536 * MiB, files: 65536, registryTotal: 512 * MiB };
const fail = (code, message) => Object.assign(new Error(message), { code });
const abort = signal => { if (signal?.aborted) throw fail('DEPENDENCY_PREPARATION_ABORTED', 'Dependency preparation was cancelled.'); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function fileHash(file, algorithm = 'sha256', max = LIMITS.installedFile) {
  await ordinaryPath(file); const info = await lstat(file);
  if (!info.isFile() || info.size > max) throw fail('DEPENDENCY_FILE_INVALID', 'Dependency material must be an ordinary bounded file.');
  const digest = createHash(algorithm); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; if (size > max) throw fail('DEPENDENCY_FILE_INVALID', 'Dependency file grew beyond its limit.'); digest.update(chunk); }
  return { sha256: digest.digest('hex'), size };
}

async function inventory(directory, signal) {
  await ordinaryPath(directory); const files = [], names = new Set(); let total = 0, count = 0;
  async function walk(local = '') {
    for (const entry of (await readdir(join(directory, local), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      abort(signal); if (++count > LIMITS.files) throw fail('DEPENDENCY_FILE_LIMIT', 'Prepared environment contains too many entries.');
      const path = local ? `${local}/${entry.name}` : entry.name; relativePath(path);
      const full = join(directory, path), info = await lstat(full);
      if (info.isSymbolicLink()) throw fail('DEPENDENCY_LINK_INVALID', 'Prepared environments do not accept links or reparse points.');
      if (entry.isDirectory() && info.isDirectory()) await walk(path);
      else if (entry.isFile() && info.isFile()) {
        const key = path.toLowerCase(); if (names.has(key)) throw fail('DEPENDENCY_PATH_COLLISION', 'Prepared dependency paths collide by case.'); names.add(key);
        const item = await fileHash(full); total += item.size;
        if (total > LIMITS.installedTotal) throw fail('DEPENDENCY_SIZE_LIMIT', 'Prepared environment exceeds the total byte limit.');
        files.push({ path, ...item });
      } else throw fail('DEPENDENCY_FILE_INVALID', 'Prepared environments accept only ordinary files and directories.');
    }
  }
  await walk(); return files.sort((a,b) => a.path.localeCompare(b.path, 'en'));
}

// Exposed for conformance tests and tooling; callers still verify lock integrity
// before extraction. No shell tar, executable bits, symlinks, devices or hooks.
export function inspectRegistryArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.archive) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Compressed registry archive exceeds its byte limit.');
  let tar; try { tar = gunzipSync(bytes, { maxOutputLength: LIMITS.expanded }); }
  catch { throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Invalid or oversized compressed registry archive.'); }
  const files = [], names = new Set(); let at = 0, root, ended = false, entries = 0;
  const field = (header, start, size) => {
    const value = header.subarray(start, start + size), nul = value.indexOf(0);
    // tar string fields terminate at their first NUL. npm's node-type archive
    // also stores timestamp fields beyond its terminated prefix area. Those
    // bytes are metadata, never part of the path we validate or materialize.
    const raw = nul === -1 ? value : value.subarray(0,nul);
    const decoded = raw.toString('utf8'); if (!Buffer.from(decoded).equals(raw)) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Invalid UTF-8 archive path.'); return decoded;
  };
  const octal = value => {
    const text = value.toString('ascii').replace(/[\0 ]+$/g,'').replace(/^ +/,'');
    if (!/^[0-7]+$/.test(text)) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Unsupported archive number.');
    const result = Number.parseInt(text,8); if (!Number.isSafeInteger(result)) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Archive number exceeds its bound.'); return result;
  };
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512); at += 512;
    if (header.every(byte => byte === 0)) { ended = true; break; }
    if (++entries > LIMITS.files) throw fail('DEPENDENCY_FILE_LIMIT', 'Registry archive has too many entries.');
    const checksum = octal(header.subarray(148,156)); let calculated = 0;
    for (let index=0; index<512; index++) calculated += index >=148 && index <156 ? 32 : header[index];
    if (checksum !== calculated) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Archive header checksum differs.');
    const type = header[156], prefix = field(header,345,155), name = field(header,0,100), size = octal(header.subarray(124,136));
    if (![0,48,53].includes(type)) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Registry archives accept only ordinary files and directories.');
    const complete = (prefix ? `${prefix}/` : '') + name;
    const path = type === 53 ? complete.replace(/\/$/,'') : complete; relativePath(path);
    const parts = path.split('/'); root ??= parts[0]; if (parts[0] !== root) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Registry archive has multiple package roots.');
    if (type === 53) { if (size !== 0) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Archive directory contains bytes.'); continue; }
    if (parts.length < 2 || size > LIMITS.packageFile || at + size > tar.length) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Invalid or oversized registry file.');
    const local = parts.slice(1).join('/'); relativePath(local);
    if (local.split('/').some(part => part === 'node_modules')) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Registry packages cannot bundle a second dependency tree.');
    const key = local.toLowerCase(); if (names.has(key)) throw fail('DEPENDENCY_PATH_COLLISION', 'Registry archive paths collide by case.'); names.add(key);
    files.push({ path: local, bytes: tar.subarray(at,at+size) }); if (files.length > LIMITS.files) throw fail('DEPENDENCY_FILE_LIMIT', 'Registry archive has too many files.');
    at += Math.ceil(size/512)*512;
  }
  if (!ended || !files.length || at > tar.length || tar.subarray(at).some(byte => byte !== 0)) throw fail('DEPENDENCY_ARCHIVE_INVALID', 'Registry archive is truncated or has trailing material.');
  // A file may not also be a directory ancestor, even on case-folding systems.
  for (const item of files) { const parts = item.path.toLowerCase().split('/'); parts.pop(); while (parts.length) { if (names.has(parts.join('/'))) throw fail('DEPENDENCY_PATH_COLLISION', 'Registry archive has conflicting file and directory paths.'); parts.pop(); } }
  return files;
}

async function download(url, file, { limit, integrity, algorithm, signal, native = false }) {
  const acceptedHosts = native ? new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']) : new Set(['registry.npmjs.org']);
  const timed = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(native ? 600000 : 45000)]);
  let current = new URL(url), response;
  for (let redirect=0; redirect<=5; redirect++) {
    abort(timed);
    if (current.protocol !== 'https:' || !acceptedHosts.has(current.hostname) || current.username || current.password || current.port && current.port !== '443') throw fail('DEPENDENCY_DOWNLOAD_INVALID', 'Dependency downloads require an approved official HTTPS host.');
    try { response = await fetch(current, { redirect:'manual', signal:timed, headers:{ 'accept-encoding':'identity' } }); }
    catch { throw fail(signal?.aborted ? 'DEPENDENCY_PREPARATION_ABORTED' : timed.aborted ? 'DEPENDENCY_DOWNLOAD_TIMEOUT' : 'DEPENDENCY_DOWNLOAD_FAILED', signal?.aborted ? 'Dependency preparation was cancelled.' : timed.aborted ? 'Official dependency download timed out.' : 'The official dependency host is unavailable.'); }
    if ([301,302,303,307,308].includes(response.status)) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location || redirect===5) throw fail('DEPENDENCY_DOWNLOAD_INVALID', 'Invalid dependency download redirect.'); current = new URL(location,current); continue; }
    break;
  }
  if (!response?.ok || !response.body || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response?.body?.cancel(); throw fail('DEPENDENCY_DOWNLOAD_FAILED', `Official dependency download failed (${response?.status ?? 'unavailable'}).`); }
  const sizeHeader = response.headers.get('content-length');
  if (sizeHeader && (!/^\d+$/.test(sizeHeader) || Number(sizeHeader)>limit)) { await response.body.cancel(); throw fail('DEPENDENCY_DOWNLOAD_LIMIT', 'Dependency download exceeds its byte limit.'); }
  const output = await open(file,'wx',0o600), digest = createHash(algorithm); let size = 0;
  try {
    for await (const chunk of response.body) { abort(timed); size += chunk.length; if (size>limit) throw fail('DEPENDENCY_DOWNLOAD_LIMIT', 'Dependency download exceeds its byte limit.'); digest.update(chunk); await output.writeFile(chunk); }
    if (digest.digest('base64') !== integrity) throw fail('DEPENDENCY_INTEGRITY_MISMATCH', 'Official dependency archive does not match the reviewed checksum.');
  } catch(error) {
    if (error.code?.startsWith?.('DEPENDENCY_')) throw error;
    throw fail(signal?.aborted ? 'DEPENDENCY_PREPARATION_ABORTED' : timed.aborted ? 'DEPENDENCY_DOWNLOAD_TIMEOUT' : 'DEPENDENCY_DOWNLOAD_FAILED', signal?.aborted ? 'Dependency preparation was cancelled.' : timed.aborted ? 'Official dependency download timed out.' : 'The official dependency download was interrupted.');
  } finally { await output.close(); await response.body.cancel().catch(()=>{}); }
  return size;
}

function validateElectronRecipe(packages) {
  const locked=packages.find(item=>item.path==='node_modules/electron');
  if (!locked || locked.url!==ELECTRON_ARCHIVE.url || locked.integrity!==ELECTRON_ARCHIVE.integrity) throw fail('DEPENDENCY_RECIPE_INVALID', 'The native recipe requires the exact reviewed official Electron 44.7.1 package.');
}
async function installElectron(application, attempt, signal) {
  if (!['win32','linux'].includes(process.platform) || !['x64','arm64'].includes(process.arch)) throw fail('DEPENDENCY_RECIPE_UNSUPPORTED', 'The reviewed Electron installation recipe supports Windows and Linux x64/arm64.');
  const [major,minor] = process.versions.node.split('.').map(Number);
  if (major<22 || major===22 && minor<12) throw fail('DEPENDENCY_RUNTIME_UNSUPPORTED', 'Electron 44.7.1 dependency installation requires Node 22.12 or later.');
  const electron = join(application,'node_modules/electron'), pkg = JSON.parse(await readBounded(join(electron,'package.json')));
  if (pkg.name !== 'electron' || pkg.version !== '44.7.1') throw fail('DEPENDENCY_RECIPE_INVALID', 'Unexpected Electron installation package.');
  const checksums = JSON.parse(await readBounded(join(electron,'checksums.json'))), filename = `electron-v44.7.1-${process.platform}-${process.arch}.zip`;
  if (!/^[a-f0-9]{64}$/.test(checksums[filename] ?? '')) throw fail('DEPENDENCY_RECIPE_INVALID', 'Electron package does not provide the expected official binary checksum.');
  const url = new URL(`https://github.com/electron/electron/releases/download/v44.7.1/${filename}`), cache = join(attempt,'cache');
  const group = new URL(url); group.pathname = posix.dirname(group.pathname); const folder = join(cache,hash(group.toString())); await mkdir(folder,{recursive:true,mode:0o700});
  await download(url.href,join(folder,filename),{limit:LIMITS.installedFile,integrity:Buffer.from(checksums[filename],'hex').toString('base64'),algorithm:'sha256',signal,native:true});
  // Only the integrity-checked official package installer is executable. Seed
  // its private verified cache so its own checksum validation repeats locally.
  const wrapper = join(attempt,'electron-install.cjs'), home = join(attempt,'home'), temporary = join(attempt,'tmp');
  await mkdir(home,{mode:0o700}); await mkdir(temporary,{mode:0o700});
  await writeFile(wrapper,`process.env.HOME=${JSON.stringify(home)}; process.env.USERPROFILE=${JSON.stringify(home)}; process.env.XDG_CACHE_HOME=${JSON.stringify(join(home,'cache'))}; process.env.electron_config_cache=${JSON.stringify(cache)}; process.env.ELECTRON_INSTALL_PLATFORM=${JSON.stringify(process.platform)}; process.env.ELECTRON_INSTALL_ARCH=${JSON.stringify(process.arch)}; require(${JSON.stringify(join(electron,'install.js'))});\n`,{flag:'wx',mode:0o600});
  const handle = ownProcess(process.execPath,[wrapper],{cwd:attempt,temporary,secrets:[],signal}); handle.stopping = true;
  let timeout, listener;
  try {
    const interrupted = new Promise((_,reject) => { timeout=setTimeout(()=>reject(fail('DEPENDENCY_INSTALL_TIMEOUT','Official Electron installation timed out.')),120000); listener=()=>reject(fail('DEPENDENCY_PREPARATION_ABORTED','Dependency preparation was cancelled.')); signal?.addEventListener('abort',listener,{once:true}); });
    abort(signal); const result = await Promise.race([handle.closed,interrupted]);
    if (result.code !== 0 || handle.error) throw fail('DEPENDENCY_INSTALL_FAILED', `Official Electron installer failed (${result.code ?? result.signal ?? 'spawn failure'}).`);
    const path = (await readBounded(join(electron,'path.txt'),1024)).toString('utf8'), expected = process.platform==='win32'?'electron.exe':'electron';
    if (path !== expected || (await readBounded(join(electron,'dist/version'),128)).toString('utf8').trim().replace(/^v/,'') !== '44.7.1') throw fail('DEPENDENCY_INSTALL_FAILED','Official Electron installation is incomplete.');
    await fileHash(join(electron,'dist',expected));
  } catch (error) { await handle.stop(100); if (!handle.exit) throw fail('DEPENDENCY_CLEANUP_INCOMPLETE','Cannot confirm the current owned installer exited.'); throw error; }
  finally { clearTimeout(timeout); if(listener) signal?.removeEventListener('abort',listener); }
}

export async function prepareDependencies({ directory, manifest, review, stateDir, signal } = {}) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15 * 60000)]);
  abort(signal); const current = await inspectDeployment({directory,manifest});
  if (!review || !same(current,review)) throw fail('DEPENDENCY_REVIEW_CHANGED','Deployment or dependency declarations changed after review.');
  if (!current.dependencies) return null;
  if(current.dependencies.recipes.includes('electron')) validateElectronRecipe(current.dependencies.packages);
  const source = await collectSourceFiles(directory);
  if (source.some(item=>item.path.split('/').some(part=>part.toLowerCase()==='node_modules'))) throw fail('DEPENDENCY_SOURCE_MIXED','Dependency preparation requires source without installed node_modules.');
  const root = await ordinaryPath(stateDir,{allowMissing:true}); await mkdir(root,{recursive:true,mode:0o700}); await ordinaryPath(root);
  const receiptFile = join(root,'prepared.json'); let existing;
  try { existing = JSON.parse(await readBounded(receiptFile,16*MiB)); } catch(error) { if(error.code!=='ENOENT') throw fail('DEPENDENCY_RECEIPT_INVALID','Prepared dependency receipt is invalid. Retain the environment for inspection.'); }
  if (existing) {
    if (existing.format !== FORMAT || existing.reviewDigest !== current.digest || !same(existing.source,source)
        || !/^attempt-[a-f0-9-]{36}$/.test(existing.attempt ?? '') || !Array.isArray(existing.files) || existing.inventoryDigest!==hash(JSON.stringify(existing.files))) throw fail('DEPENDENCY_RECEIPT_CHANGED','Prepared dependency receipt no longer matches the reviewed module.');
    const attempt = join(root,existing.attempt), files = await inventory(attempt,signal);
    if (!same(files,existing.files)) throw fail('DEPENDENCY_ENVIRONMENT_CHANGED','Prepared dependencies changed or are incomplete; no program was started.');
    return { directory:join(attempt,'application') };
  }
  const lockFile = join(root,'preparing.lock'), owner = randomUUID();
  try { await writeFile(lockFile,owner,{flag:'wx',mode:0o600}); } catch(error) { if(error.code==='EEXIST') throw fail('DEPENDENCY_PREPARATION_BUSY','This environment is being prepared, or an interrupted preparation needs inspection.'); throw error; }
  const attemptName = `attempt-${randomUUID()}`, attempt = join(root,attemptName), application = join(attempt,'application');
  try {
    await mkdir(application,{recursive:true,mode:0o700}); await mkdir(join(attempt,'archives'),{mode:0o700});
    for (const item of source) { abort(signal); const bytes = await readBounded(join(directory,item.path),8*MiB); if(hash(bytes)!==item.sha256) throw fail('DEPENDENCY_REVIEW_CHANGED','Module source changed during dependency preparation.'); const target=join(application,item.path); await mkdir(dirname(target),{recursive:true,mode:0o700}); await writeFile(target,bytes,{flag:'wx',mode:0o600}); }
    let downloaded = 0, expanded = 0, entries = source.length;
    for (const [index,item] of current.dependencies.packages.entries()) {
      abort(signal); const archive=join(attempt,'archives',`${index}.tgz`);
      const remaining=LIMITS.registryTotal-downloaded;
      if(remaining<=0) throw fail('DEPENDENCY_DOWNLOAD_LIMIT','Locked registry dependencies exceed the combined download limit.');
      downloaded += await download(item.url,archive,{limit:Math.min(LIMITS.archive,remaining),integrity:item.integrity.slice(7),algorithm:'sha512',signal});
      const files=inspectRegistryArchive(await readBounded(archive,LIMITS.archive)), destination=join(application,item.path);
      await ordinaryPath(destination,{allowMissing:true}); await mkdir(destination,{recursive:true,mode:0o700});
      for (const file of files) {
        abort(signal); expanded+=file.bytes.length;
        if(++entries>LIMITS.files || expanded>LIMITS.registryTotal) throw fail('DEPENDENCY_SIZE_LIMIT','Expanded locked dependencies exceed their combined file or byte limit.');
        const target=join(destination,file.path); await ordinaryPath(target,{allowMissing:true}); await mkdir(dirname(target),{recursive:true,mode:0o700}); await writeFile(target,file.bytes,{flag:'wx',mode:0o600});
      }
      const installed=JSON.parse(await readBounded(join(destination,'package.json'))), expectedName=item.path.split('/node_modules/').at(-1).replace(/^node_modules\//,'');
      if(installed.name!==expectedName || installed.version!==item.version) throw fail('DEPENDENCY_PACKAGE_MISMATCH','Registry package identity differs from the reviewed lock.');
    }
    if(current.dependencies.recipes.includes('electron')) await installElectron(application,attempt,signal);
    abort(signal);
    if(!same(source,await collectSourceFiles(directory)) || !same(current,await inspectDeployment({directory,manifest}))) throw fail('DEPENDENCY_REVIEW_CHANGED','Module source or its dependency lock changed during installation.');
    const files=await inventory(attempt,signal); abort(signal);
    await privateJson(receiptFile,{format:FORMAT,reviewDigest:current.digest,source,attempt:attemptName,files,inventoryDigest:hash(JSON.stringify(files)),preparedAt:new Date().toISOString(),runsModuleInstallScripts:false},{exclusive:true});
    return { directory:application };
  } catch(error) { try { await privateJson(join(attempt,'failure.json'),{code:error.code ?? 'DEPENDENCY_PREPARATION_FAILED',message:'Dependency preparation failed; incomplete private files were retained.',at:new Date().toISOString()},{exclusive:true}); } catch {} throw error; }
  finally { try { if((await readFile(lockFile,'utf8'))===owner) await unlink(lockFile); } catch {} }
}
