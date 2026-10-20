// Open, optional static software sources. Downloaded data never executes here.
import { mkdir, writeFile, open, unlink, rename, link, lstat, readdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { request } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { validateModule } from './package.mjs';
import { validateModuleGroupFiles } from './module-group.mjs';
import { validateConfigurationFiles, validateDataFiles, readResourceFiles } from './resource-artifacts.mjs';
import { ordinaryPath, readBounded, collectFiles, hash, relativePath, privateJson } from './paths.mjs';
import { parsePublisherEvidence, verifyPublisherEvidence } from './publisher-trust.mjs';
import { verifyStoredPublisherEvidence } from './publisher-store.mjs';

const sha = /^[a-f0-9]{64}$/;
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const maximumArtifact = 96 * 1024 * 1024;
export const maximumPublisherEvidence = 256 * 1024;
function cancelled(options) { if (options.signal?.aborted) throw options.signal.reason ?? new Error('Operation cancelled'); }
function exact(value, keys, name, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) throw new Error(`Invalid ${name}`);
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b))
      && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0) && !(a === 100 && b >= 64 && b <= 127);
  }
  // Conservative reference downloader: IPv4 only. IPv6 transition and special
  // ranges require a separately reviewed transport adapter.
  return false;
}
function allowedAddress(address, options) {
  if (publicAddress(address)) return true;
  if (options.allowPrivateNetwork !== true || isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && [18, 19].includes(b));
}
const policy = options => options.allowPrivateNetwork === true ? 'trusted-private-ipv4' : 'public-ipv4';
function sourceUrl(value, options = {}) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid software source URL');
  let raw = value.trim();
  if (/^https:\/\/peros\.cn\/workshop\/?$/i.test(raw)) raw = 'https://peros.cn/workshop/index.json';
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443')) throw new Error('Software sources require HTTPS without credentials, fragments or custom ports');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !allowedAddress(host, options))) throw new Error('Remote software sources cannot contact a local or private address under the selected policy');
  return u;
}
async function download(value, maximum, options = {}) {
  cancelled(options); const url = sourceUrl(value, options);
  return new Promise((resolveBytes, reject) => {
    let timer, settled = false;
    const complete = (error, bytes) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolveBytes(bytes); };
    const fail = error => { if (!error.code) error.code = 'SOURCE_UNAVAILABLE'; complete(error); };
    const req = request(url, { method: 'GET', timeout: 15000, signal: options.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'World-Hub-static-source/1' },
      // Pin this request to a checked public address; do not resolve again after validation.
      lookup(host, lookupOptions, callback) {
        lookup(host, { all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error);
          const supported = addresses.filter(v => v.family === 4 && allowedAddress(v.address, options));
          if (!supported.length || addresses.some(v => v.family === 4 && !allowedAddress(v.address, options))) return callback(new Error('Remote source resolved to a private or unsupported address under the selected policy'));
          const selected = supported[0];
          if (lookupOptions.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
        });
      } }, response => {
      if (response.statusCode !== 200) { response.destroy(); return fail(new Error(`Software source HTTP status ${response.statusCode}; redirects are not followed`)); }
      if (Number(response.headers['content-length']) > maximum) { response.destroy(); return complete(new Error('Software source exceeds download size bound')); }
      let length = 0; const chunks = [];
      response.on('data', bytes => {
        length += bytes.length;
        if (length > maximum) response.destroy(new Error('Software source exceeds download size bound'));
        else chunks.push(bytes);
      });
      response.on('error', error => complete(error)); response.on('end', () => complete(null, Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('Software source download timed out')));
    req.on('error', fail);
    timer = setTimeout(() => req.destroy(new Error('Software source total download deadline exceeded')), 15000);
    req.end();
  });
}
export function validateSourceIndex(index, options = {}) {
  exact(index, ['format', 'id', 'title', 'entries'], 'source index');
  if (index.format !== 'world-hub.source-index/v1' || typeof index.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(index.id)
      || typeof index.title !== 'string' || !index.title || index.title.length > 256
      || !Array.isArray(index.entries) || index.entries.length > 4096) throw new Error('Invalid source index identity or entries');
  const ids = new Set();
  for (const entry of index.entries) {
    exact(entry, ['entryId', 'kind', 'id', 'version', 'title', 'license', 'platforms', 'provides', 'requires', 'source', 'sha256'], 'source entry', ['publisherEvidence']);
    if (typeof entry.entryId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.entryId) || ids.has(entry.entryId)
        || !['pack', 'module', 'template', 'module-group', 'configuration', 'data'].includes(entry.kind) || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id)
        || typeof entry.version !== 'string' || entry.version.length > 128 || !semver.test(entry.version)
        || typeof entry.title !== 'string' || !entry.title || entry.title.length > 256
        || typeof entry.license !== 'string' || !entry.license || entry.license.length > 128 || !sha.test(entry.sha256)
        || !Array.isArray(entry.platforms) || entry.platforms.length < 1 || entry.platforms.length > 32
        || new Set(entry.platforms).size !== entry.platforms.length
        || entry.platforms.some(p => typeof p !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(p))) throw new Error('Invalid source entry metadata');
    ids.add(entry.entryId);
    for (const key of ['provides', 'requires']) {
      if (!Array.isArray(entry[key]) || entry[key].length > 64) throw new Error('Invalid source capability list');
      for (const c of entry[key]) {
        exact(c, ['id', 'version'], 'source contract');
        if (typeof c.id !== 'string' || !c.id || c.id.length > 128 || typeof c.version !== 'string' || c.version.length > 128 || !semver.test(c.version)) throw new Error('Invalid source capability contract');
      }
      if (new Set(entry[key].map(c => `${c.id}@${c.version}`)).size !== entry[key].length) throw new Error('Duplicate source capability contract');
    }
    if (Object.hasOwn(entry.source ?? {}, 'path')) { exact(entry.source, ['path'], 'local artifact source'); relativePath(entry.source.path); }
    else { exact(entry.source, ['url'], 'remote artifact source'); sourceUrl(entry.source.url, options); }
    if (entry.publisherEvidence !== undefined) {
      exact(entry.publisherEvidence, ['source', 'sha256'], 'publisher evidence reference');
      if (!sha.test(entry.publisherEvidence.sha256)) throw new Error('Invalid publisher evidence digest');
      if (Object.hasOwn(entry.publisherEvidence.source ?? {}, 'path')) { exact(entry.publisherEvidence.source, ['path'], 'local publisher evidence source'); relativePath(entry.publisherEvidence.source.path); }
      else { exact(entry.publisherEvidence.source, ['url'], 'remote publisher evidence source'); sourceUrl(entry.publisherEvidence.source.url, options); }
    }
  }
  return index;
}
export async function readSourceIndex(source, options = {}) {
  cancelled(options);
  if (typeof source !== 'string' || !source || source.length > 4096) throw new Error('Invalid software source');
  const remote = /^https?:/i.test(source);
  const bytes = remote ? await download(source, 4 * 1024 * 1024, options) : await readBounded(source, 4 * 1024 * 1024);
  const digest = hash(bytes);
  if (options.expectedSha256 !== undefined && (!sha.test(options.expectedSha256) || digest !== options.expectedSha256)) throw new Error('Source index hash mismatch');
  const index = validateSourceIndex(JSON.parse(bytes.toString()), options);
  if (remote && index.entries.some(e => e.source.path || e.publisherEvidence?.source.path)) throw new Error('Remote indices cannot refer to local filesystem artifacts or publisher evidence');
  const result = { source: remote ? sourceUrl(source, options).href : await ordinaryPath(source), digest, index, networkPolicy: policy(options), startsModules: false };
  Object.defineProperty(result, 'indexBytes', { value: bytes });
  return result;
}
function validateArtifact(artifact) {
  exact(artifact, ['format', 'kind', 'id', 'version', 'files', 'provenance'], 'distribution artifact');
  if (artifact.format !== 'world-hub.source-artifact/v1' || !['module', 'module-group', 'configuration', 'data'].includes(artifact.kind)
      || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 8192
      || !artifact.provenance || typeof artifact.provenance !== 'object' || Array.isArray(artifact.provenance)) throw new Error('Invalid distribution artifact');
  const paths = new Set(); let size = 0; const decoded = [];
  for (const f of artifact.files) {
    exact(f, ['path', 'sha256', 'base64'], 'artifact file'); relativePath(f.path);
    if (['module', 'module-group'].includes(artifact.kind) && (f.path.split('/').some(p => ['__pycache__', '.venv', '.git', '.hub', '.state'].includes(p)) || /\.py[co]$/.test(f.path))) throw new Error('Artifact contains generated or private source material');
    const key = f.path.toLowerCase();
    if (paths.has(key) || !sha.test(f.sha256) || typeof f.base64 !== 'string'
        || f.base64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 || f.base64.length % 4 !== 0
        || /[^A-Za-z0-9+/=]/.test(f.base64)) throw new Error('Invalid or duplicate artifact file');
    paths.add(key); const bytes = Buffer.from(f.base64, 'base64'); size += bytes.length;
    if (size > 64 * 1024 * 1024 || bytes.length > 8 * 1024 * 1024 || hash(bytes) !== f.sha256) throw new Error('Artifact file hash or size mismatch');
    decoded.push({ path: f.path, bytes });
    if (bytes.toString('base64') !== f.base64) throw new Error('Artifact file Base64 is not canonical');
  }
  // Reject file/directory prefix conflicts on every platform before writing.
  for (const path of paths) for (const ancestor of path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))) if (paths.has(ancestor)) throw new Error('Artifact file/directory collision');
  const getJson = path => {
    const f = decoded.find(v => v.path === path); if (!f) throw new Error(`Artifact lacks ${path}`); return JSON.parse(f.bytes.toString());
  };
  const manifest = getJson(`${artifact.kind}.json`);
  let modules;
  if (artifact.kind === 'module-group') ({ modules } = validateModuleGroupFiles(manifest, decoded));
  else if (artifact.kind === 'configuration') validateConfigurationFiles(manifest, decoded);
  else if (artifact.kind === 'data') validateDataFiles(manifest, decoded);
  else {
    validateModule(manifest);
    if (!decoded.some(f => f.path === manifest.runtime.entry)) throw new Error('Distributed module entry is missing');
  }
  if (manifest.id !== artifact.id || manifest.version !== artifact.version) throw new Error('Artifact identity mismatch');
  return { artifact, manifest, decoded, ...(modules ? { modules } : {}) };
}
// A hosted catalog validates data without probing interpreters, extracting files
// or executing uploaded programs. Preserve exact bytes for content addressing.
export function validateArtifactBytes(input) {
  const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array
    ? Buffer.from(input) : Buffer.from(JSON.stringify(input) + '\n');
  if (!bytes.length || bytes.length > maximumArtifact) throw new Error('Artifact exceeds distribution size bound');
  const validated = validateArtifact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const { artifact, manifest, decoded } = validated;
  const entry = { entryId: `${artifact.kind}.${artifact.id}.${artifact.version}`, kind: artifact.kind,
    id: artifact.id, version: artifact.version, title: manifest.title ?? manifest.id, license: manifest.license,
    platforms: manifest.platforms, provides: manifest.provides, requires: manifest.requires,
    source: { path: 'artifact.json' }, sha256: hash(bytes) };
  validateSourceIndex({ format: 'world-hub.source-index/v1', id: 'verified-artifact', title: 'Verified artifact', entries: [entry] });
  return { ...validated, bytes, entry };
}
function checkEntry(validated, entry) {
  const { artifact, manifest } = validated;
  const contracts = values => JSON.stringify(values.map(c => `${c.id}@${c.version}`).sort());
  const {platforms,provides,requires}=manifest;
  if (artifact.kind !== entry.kind || artifact.id !== entry.id || artifact.version !== entry.version || manifest.license !== entry.license
      || JSON.stringify([...platforms].sort()) !== JSON.stringify([...entry.platforms].sort())
      || contracts(provides) !== contracts(entry.provides) || contracts(requires) !== contracts(entry.requires)) throw new Error('Artifact disagrees with index metadata');
}
async function verifyCached(directory, artifact) {
  const validated = validateArtifact(artifact);
  for (const f of validated.decoded) if (hash(await readBounded(join(directory, f.path), 8 * 1024 * 1024)) !== hash(f.bytes)) throw new Error('Cached artifact content hash mismatch');
  const actual = ['configuration', 'data'].includes(artifact.kind)
    ? (await readResourceFiles(directory)).map(file => ({ path: file.path, sha256: hash(file.bytes) })) : await collectFiles(directory);
  if (actual.length !== artifact.files.length || actual.some(f => !artifact.files.some(v => v.path === f.path && v.sha256 === f.sha256))) throw new Error('Cached artifact file set changed');
  return validated;
}
async function present(path) { try { await ordinaryPath(path); return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function removeOwnedStage(cache, path) {
  const parent = await ordinaryPath(cache), actual = await ordinaryPath(path);
  if (dirname(actual) !== parent || !actual.startsWith(join(parent, '.artifact-'))) throw new Error('Refusing cleanup outside the owned artifact staging directory');
  let count = 0;
  async function inspect(local) {
    for (const entry of await readdir(local)) {
      if (++count > 16384) throw new Error('Artifact cleanup traversal exceeded its bound');
      const child = join(local, entry); await ordinaryPath(child); const info = await lstat(child);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Artifact cleanup encountered an unsafe path');
      if (info.isDirectory()) await inspect(child);
    }
  }
  await inspect(actual); await rm(actual, { recursive: true, force: false });
}
const publisherArtifact = entry => ({ kind: entry.kind, id: entry.id, version: entry.version, sha256: entry.sha256 });
export function unavailablePublisherEvidence(status = 'unsigned', digest = null, sourceStatus = 'online') {
  return { present: status !== 'unsigned', status, evidenceSha256: digest, integrityVerified: false,
    signatureVerified: false, publisherIdentityVerified: false, sourceStatus,
    executionAuthorized: false, codeSafetyVerified: false, sandbox: false, startsModules: false, grantsExecution: false };
}
// Evidence is optional, separately content addressed public data. A failure to
// obtain it cannot silently become verified identity or prevent ordinary data acquisition.
export async function readSourcePublisherEvidence(current, entry, options = {}) {
  const reference = entry.publisherEvidence;
  if (!reference) return unavailablePublisherEvidence('unsigned', null, options.offline ? 'offline' : 'online');
  const sourceStatus = options.offline ? 'offline' : 'online', cache = await ordinaryPath(options.cacheRoot, { allowMissing: true });
  const cachedPath = join(cache, `${reference.sha256}.publisher.json`);
  let bytes, fromCache = false;
  try {
    cancelled(options);
    if (!options.offline) {
      try { bytes = reference.source.path ? await readBounded(join(dirname(current.source), reference.source.path), maximumPublisherEvidence) : await download(reference.source.url, maximumPublisherEvidence, options); }
      catch (error) {
        if (!['ENOENT', 'SOURCE_UNAVAILABLE'].includes(error.code)) throw error;
        bytes = await readBounded(cachedPath, maximumPublisherEvidence); fromCache = true;
      }
    } else { bytes = await readBounded(cachedPath, maximumPublisherEvidence); fromCache = true; }
    if (hash(bytes) !== reference.sha256) return { ...unavailablePublisherEvidence('evidence-digest-mismatch', reference.sha256, sourceStatus), diagnostic: 'PUBLISHER_EVIDENCE_DIGEST_MISMATCH' };
    const evidence = parsePublisherEvidence(bytes), artifact = publisherArtifact(entry);
    if (evidence.payload.type !== 'artifact' || ['kind', 'id', 'version', 'sha256'].some(key => evidence.payload.subject[key] !== artifact[key])) {
      throw Object.assign(new Error('Source publisher evidence must bind this exact artifact'), { code: 'PUBLISHER_ARTIFACT_MISMATCH' });
    }
    if (!fromCache) {
      await mkdir(cache, { recursive: true, mode: 0o700 });
      const temporary = join(cache, `${reference.sha256}.publisher.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        try { await link(temporary, cachedPath); }
        catch (error) { if (error.code !== 'EEXIST') throw error; if (!bytes.equals(await readBounded(cachedPath, maximumPublisherEvidence))) throw new Error('Publisher evidence cache changed'); }
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    const verificationOptions = { artifact: publisherArtifact(entry), evidenceBytes: bytes, sourceStatus: fromCache ? 'offline' : sourceStatus, now: options.now };
    const { proposedState, ...verification } = options.publisherTrustRoot ? await verifyStoredPublisherEvidence({ ...verificationOptions, root: options.publisherTrustRoot, observe: options.observe !== false }) : await verifyPublisherEvidence(verificationOptions);
    return { ...verification, present: true, evidenceSha256: reference.sha256, integrityVerified: true,
      signatureVerified: verification.signatureStatus === 'verified', publisherIdentityVerified: verification.accepted === true && verification.publisherIdentity === 'anchored-key',
      cachedEvidence: fromCache, sourceStatus: verificationOptions.sourceStatus, executionAuthorized: false, codeSafetyVerified: false,
      sandbox: false, startsModules: false, grantsExecution: false };
  } catch (error) {
    cancelled(options);
    return { ...unavailablePublisherEvidence(error.code === 'ENOENT' || error.code === 'SOURCE_UNAVAILABLE' ? 'evidence-unavailable' : 'evidence-invalid', reference.sha256, sourceStatus),
      diagnostic: typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'PUBLISHER_EVIDENCE_INVALID' };
  }
}
export function validateArtifactPublisherEvidence(bytes, entry) {
  const evidence = parsePublisherEvidence(bytes), artifact = publisherArtifact(entry);
  if (evidence.payload.type !== 'artifact' || ['kind', 'id', 'version', 'sha256'].some(key => evidence.payload.subject[key] !== artifact[key])) {
    throw Object.assign(new Error('Publisher evidence must bind this exact artifact identity and digest'), { code: 'PUBLISHER_ARTIFACT_MISMATCH' });
  }
  const verification = verifyPublisherEvidence({ artifact, evidenceBytes: bytes, sourceStatus: 'online' });
  if (verification.signatureStatus !== 'verified') throw Object.assign(new Error('Publisher evidence signature could not be verified with public data'), { code: verification.error?.code ?? 'PUBLISHER_SIGNATURE_INVALID' });
  return { evidence, verification };
}
// Attach an already signed public sidecar to a local publication. Artifact
// bytes are read and verified, never rewritten or signed by a distribution service.
export async function attachPublisherEvidence(directory, options = {}) {
  exact(options, [], 'publisher attachment options', ['evidencePath', 'evidenceBytes']);
  if ((options.evidencePath === undefined) === (options.evidenceBytes === undefined)) throw new Error('Provide exactly one public evidence path or byte buffer');
  const root = await ordinaryPath(directory), indexPath = join(root, 'index.json'), artifactPath = join(root, 'artifact.json');
  const index = validateSourceIndex(JSON.parse((await readBounded(indexPath, 4 * 1024 * 1024)).toString('utf8')));
  if (index.entries.length !== 1 || index.entries[0].source.path !== 'artifact.json') throw new Error('Use a single local publication with artifact.json');
  const entry = index.entries[0], checked = validateArtifactBytes(await readBounded(artifactPath, maximumArtifact));
  if (checked.entry.sha256 !== entry.sha256) throw new Error('Publication artifact digest changed');
  checkEntry(checked, entry);
  const bytes = options.evidencePath !== undefined ? await readBounded(options.evidencePath, maximumPublisherEvidence) : Buffer.from(options.evidenceBytes);
  if (bytes.length > maximumPublisherEvidence) throw new Error('Publisher evidence exceeds its size bound');
  const { verification } = validateArtifactPublisherEvidence(bytes, entry);
  const digest = hash(bytes), evidencePath = join(root, `${digest}.publisher.json`);
  await ordinaryPath(evidencePath, { allowMissing: true });
  try { await writeFile(evidencePath, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (!(await readBounded(evidencePath, maximumPublisherEvidence)).equals(bytes)) throw new Error('Existing publisher evidence changed'); }
  entry.publisherEvidence = { source: { path: `${digest}.publisher.json` }, sha256: digest };
  validateSourceIndex(index); await privateJson(indexPath, index);
  return { directory: root, artifactPath, indexPath, evidencePath, evidenceSha256: digest, artifactSha256: entry.sha256, index,
    publisherEvidence: verification, startsModules: false, grantsExecution: false, publishedRemotely: false };
}
export async function fetchSourceArtifact(source, indexDigest, entryId, options) {
  cancelled(options); if (!sha.test(indexDigest)) throw new Error('Invalid reviewed source index digest');
  if(options.expectedSha256!==undefined&&(!sha.test(options.expectedSha256)||options.expectedSha256!==indexDigest))throw Object.assign(new Error('Reviewed source digest does not match the configured index pin.'),{code:'SOURCE_PIN_MISMATCH'});
  const cache = await ordinaryPath(options.cacheRoot, { allowMissing: true }); await mkdir(cache, { recursive: true, mode: 0o700 });
  let current, offline = false;
  try {
    current = await readSourceIndex(source, options);
    if (current.digest !== indexDigest) throw new Error('Source index changed: inspect and choose an entry again');
    const file = join(cache, `index-${indexDigest}.json`);
    // The original bytes must still match the caller's reviewed digest offline.
    await privateJson(file, { source: current.source, digest: current.digest, networkPolicy: current.networkPolicy, indexBase64: current.indexBytes.toString('base64') });
  } catch (error) {
    cancelled(options);
    if (!['ENOENT', 'SOURCE_UNAVAILABLE'].includes(error.code)) throw error;
    current = JSON.parse((await readBounded(join(cache, `index-${indexDigest}.json`), 8 * 1024 * 1024)).toString());
    if (current.source !== (typeof source === 'string' && /^https?:/i.test(source) ? sourceUrl(source, options).href : resolve(source)) || current.digest !== indexDigest
        || current.networkPolicy !== policy(options)) throw new Error('Offline source cache does not match the reviewed source or network policy');
    if (typeof current.indexBase64 !== 'string') throw new Error('Invalid offline index cache');
    const original = Buffer.from(current.indexBase64, 'base64');
    if (original.length > 4 * 1024 * 1024 || hash(original) !== indexDigest) throw new Error('Offline source index hash mismatch');
    current.index = JSON.parse(original.toString());
    validateSourceIndex(current.index, options);
    if (/^https:/i.test(current.source) && current.index.entries.some(e => e.source.path || e.publisherEvidence?.source.path)) throw new Error('Remote indices cannot refer to local filesystem artifacts or publisher evidence');
    offline = true;
  }
  const entry = current.index.entries.find(e => e.entryId === entryId); if (!entry) throw new Error('Source entry not found');
  if (!['module', 'configuration', 'data'].includes(entry.kind)) throw new Error('Unsupported distribution kind');
  const directory = join(cache, entry.sha256), artifactFile = join(cache, `${entry.sha256}.artifact.json`);
  const result = async cached => ({ directory, kind: entry.kind, entry, cached, offline, networkPolicy: policy(options),
    publisherEvidence: await readSourcePublisherEvidence(current, entry, { ...options, offline }), startsModules: false, requiresExecutionReview: ['module', 'module-group'].includes(entry.kind) });
  const cachedArtifact = async () => {
    if (!await present(artifactFile)) return null;
    const bytes = await readBounded(artifactFile, maximumArtifact);
    if (hash(bytes) !== entry.sha256) throw new Error('Cached artifact hash mismatch');
    const validated = validateArtifact(JSON.parse(bytes.toString())); checkEntry(validated, entry);
    if (await present(directory)) { await verifyCached(directory, validated.artifact); return { bytes, validated, complete: true }; }
    return { bytes, validated, complete: false };
  };
  let cached = await cachedArtifact(); if (cached?.complete) return result(true);
  if(options.cacheOnly===true&&!cached)throw Object.assign(new Error('This distribution has no verified artifact cache.'),{code:'SOURCE_CACHE_REQUIRED'});
  const lockPath = join(cache, `${entry.sha256}.download.lock`), nonce = randomUUID();
  await ordinaryPath(lockPath, { allowMissing: true });
  let owner;
  try { owner = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') { error.code = 'SOURCE_CACHE_BUSY'; error.message = 'This exact artifact is being prepared; retry after its current owner completes'; } throw error; }
  let stage, temporary, stageCreated = false, temporaryCreated = false, failure;
  try {
    await owner.writeFile(JSON.stringify({ nonce, createdAt: new Date().toISOString() })); await owner.close(); owner = null;
    cached = await cachedArtifact(); if (cached?.complete) return result(true);
    if (offline && !cached) throw new Error('Source is unavailable and this artifact has not been cached');
    const bytes = cached?.bytes ?? (entry.source.path ? await readBounded(join(dirname(current.source), entry.source.path), maximumArtifact) : await download(entry.source.url, maximumArtifact, options));
    cancelled(options); if (hash(bytes) !== entry.sha256) throw new Error('Downloaded artifact hash mismatch');
    const validated = cached?.validated ?? validateArtifact(JSON.parse(bytes.toString())); checkEntry(validated, entry);
    stage = join(cache, `.artifact-${entry.sha256}-${nonce}`); temporary = join(cache, `${entry.sha256}.artifact.${nonce}.tmp`);
    await ordinaryPath(stage, { allowMissing: true }); await mkdir(stage, { mode: 0o700 }); stageCreated = true;
    for (const f of validated.decoded) {
      cancelled(options); const target = join(stage, f.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, f.bytes, { flag: 'wx', mode: 0o600 });
    }
    await verifyCached(stage, validated.artifact); cancelled(options);
    if (!cached) {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); temporaryCreated = true;
      // An exclusive hard link publishes complete bytes atomically without
      // overwriting an existing archive. The temporary name is then removed.
      await link(temporary, artifactFile); await unlink(temporary); temporaryCreated = false;
    }
    if (await present(directory)) await verifyCached(directory, validated.artifact);
    else { await ordinaryPath(directory, { allowMissing: true }); await rename(stage, directory); stageCreated = false; }
    return result(Boolean(cached));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (owner) await owner.close().catch(() => {});
    try {
      if (temporaryCreated) { await ordinaryPath(temporary); await unlink(temporary); }
      if (stageCreated) await removeOwnedStage(cache, stage);
      const lock = JSON.parse((await readBounded(lockPath)).toString()); if (lock.nonce === nonce) await unlink(lockPath);
    } catch (cleanup) {
      const error = failure ?? cleanup; error.cleanupIncomplete = true; error.incompleteDestination = stage ?? temporary;
      error.message += '; owned cache cleanup needs inspection: ' + cleanup.message; throw error;
    }
  }
}
export async function publishArtifact(directory, options) {
  cancelled(options);
  if (options.redistributionAcknowledged !== true) throw new Error('Explicitly acknowledge redistribution rights before publishing');
  if(!['module', 'configuration', 'data'].includes(options.kind))throw new Error('Publication kind must be module, configuration or data');
  const root=await ordinaryPath(directory);
  const manifest=JSON.parse((await readBounded(join(root, `${options.kind}.json`))).toString());
  const files=['configuration','data'].includes(options.kind)?await readResourceFiles(root):await collectFiles(root),{platforms,provides,requires}=manifest,provenance={redistributionAcknowledged:true};
  let size = 0; const encoded = [];
  for (const f of files) {
    cancelled(options); const bytes = f.bytes ?? await readBounded(join(root, f.path), 8 * 1024 * 1024); size += bytes.length;
    if (size > 64 * 1024 * 1024) throw new Error('Publication exceeds total artifact size bound');
    encoded.push({ path: f.path, sha256: hash(bytes), base64: bytes.toString('base64') });
  }
  const artifact = { format: 'world-hub.source-artifact/v1', kind: options.kind, id: manifest.id, version: manifest.version, files: encoded, provenance };
  validateArtifact(artifact); const bytes = Buffer.from(JSON.stringify(artifact) + '\n');
  cancelled(options);
  const destination = await ordinaryPath(options.destination, { allowMissing: true }); await mkdir(destination, { mode: 0o700 });
  try {
  const artifactPath = join(destination, 'artifact.json'), indexPath = join(destination, 'index.json');
  await writeFile(artifactPath, bytes, { flag: 'wx', mode: 0o600 });
  const index = { format: 'world-hub.source-index/v1', id: manifest.id, title: manifest.title ?? manifest.id,
    entries: [{ entryId: `${options.kind}.${manifest.id}.${manifest.version}`, kind: options.kind, id: manifest.id, version: manifest.version,
      title: manifest.title ?? manifest.id, license: manifest.license, platforms, provides, requires, source: { path: 'artifact.json' }, sha256: hash(bytes) }] };
  validateSourceIndex(index); await privateJson(indexPath, index, { exclusive: true });
  return { directory: destination, artifactPath, indexPath, index, startsModules: false, publishedRemotely: false };
  } catch (error) { error.incompleteDestination = destination; throw error; }
}
