// Optional hosted Workshop metadata and immutable distribution files.
// This service never starts a module, probes an interpreter, or controls a Hub.
import { mkdir, open, rename, unlink, lstat, readdir, link } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { ordinaryPath, readBounded, hash } from '../../scripts/runtime/paths.mjs';
import { validateArtifactBytes, validateSourceIndex } from '../../scripts/runtime/sources.mjs';

const scrypt = promisify(scryptCallback);
const token = () => randomBytes(32).toString('base64url');
const now = () => new Date().toISOString();
const shaPattern = /^[a-f0-9]{64}$/;
const identifier = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const MAX_METADATA = 16 * 1024 * 1024;
export const MAX_UPLOAD = 8 * 1024 * 1024;
export const publicUser = user => ({ id: user.id, username: user.username, role: user.role, disabled: user.disabled });
export const workshopError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
function requireValue(condition, code, message, status = 400) { if (!condition) throw workshopError(code, message, status); }
function passwordInput(password) { requireValue(typeof password === 'string' && password.length >= 12 && password.length <= 128 && Buffer.byteLength(password) <= 512 && !password.includes('\0'), 'INVALID_PASSWORD', 'Use a password of 12–128 characters.'); }
function textInput(value, maximum, name) { requireValue(typeof value === 'string' && value.trim() && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), 'INVALID_INPUT', `Invalid ${name}.`); return value.trim(); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cleanExpired(state) {
  const time = Date.now();
  state.sessions = state.sessions.filter(v => Date.parse(v.expiresAt) > time);
  state.invitations = state.invitations.filter(v => Date.parse(v.expiresAt) > time);
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  requireValue(bytes.length <= MAX_METADATA, 'METADATA_QUOTA', 'Workshop metadata quota reached.', 507);
  await ordinaryPath(file, { allowMissing: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle, published = false;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const deadline = performance.now() + 4000;
    for (;;) {
      try { await rename(temporary, file); published = true; break; }
      catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || performance.now() >= deadline) throw error; await new Promise(resolveWait => setTimeout(resolveWait, 50)); }
    }
    await syncDirectory(dirname(file));
  } catch (error) { if (published) error.metadataPublished = true; throw error; }
  finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function assertState(state) {
  requireValue(state?.format === 'world-hub.workshop-state/v1' && state.revision >= 0 && Number.isSafeInteger(state.revision)
    && ['users', 'sessions', 'invitations', 'publications'].every(key => Array.isArray(state[key])), 'INVALID_STORE', 'Unsupported or malformed Workshop metadata.', 500);
  requireValue(state.users.length <= 128 && state.sessions.length <= 1024 && state.invitations.length <= 128 && state.publications.length <= 4096, 'INVALID_STORE', 'Workshop metadata exceeds its bounds.', 500);
  const users = new Set(), names = new Set(), publications = new Set(), versions = new Set(), identities = new Map();
  for (const user of state.users) {
    requireValue(identifier.test(user.id) && typeof user.username === 'string' && usernamePattern.test(user.username) && !users.has(user.id) && !names.has(user.username)
      && ['admin', 'member'].includes(user.role) && typeof user.disabled === 'boolean' && /^[a-f0-9]{32}$/.test(user.password?.salt)
      && /^[a-f0-9]{64}$/.test(user.password?.hash), 'INVALID_STORE', 'Invalid Workshop account metadata.', 500);
    users.add(user.id); names.add(user.username);
  }
  for (const session of state.sessions) requireValue(shaPattern.test(session.hash) && users.has(session.userId) && Number.isFinite(Date.parse(session.expiresAt)), 'INVALID_STORE', 'Invalid Workshop session metadata.', 500);
  for (const invitation of state.invitations) requireValue(shaPattern.test(invitation.hash) && users.has(invitation.creatorId) && Number.isFinite(Date.parse(invitation.expiresAt)), 'INVALID_STORE', 'Invalid Workshop invitation metadata.', 500);
  for (const p of state.publications) {
    const key = `${p.kind}:${p.id}`;
    requireValue(identifier.test(p.entryId) && !publications.has(p.entryId) && users.has(p.ownerId) && ['module', 'pack', 'template'].includes(p.kind)
      && shaPattern.test(p.sha256) && typeof p.hidden === 'boolean' && Array.isArray(p.comments) && p.comments.length <= 100
      && Array.isArray(p.proposals) && p.proposals.length <= 32 && (!identities.has(key) || identities.get(key) === p.ownerId), 'INVALID_STORE', 'Invalid Workshop publication metadata.', 500);
    requireValue(!versions.has(`${key}@${p.version}`), 'INVALID_STORE', 'Duplicate immutable publication version.', 500);
    publications.add(p.entryId); versions.add(`${key}@${p.version}`); identities.set(key, p.ownerId);
    requireValue(p.entry?.sha256 === p.sha256 && p.entry.entryId === p.entryId && p.entry.kind === p.kind && p.entry.id === p.id && p.entry.version === p.version, 'INVALID_STORE', 'Publication and source entry disagree.', 500);
    for (const c of p.comments) requireValue(identifier.test(c.id) && users.has(c.authorId) && typeof c.text === 'string' && c.text.length <= 4000, 'INVALID_STORE', 'Invalid comment metadata.', 500);
    for (const q of p.proposals) requireValue(identifier.test(q.id) && users.has(q.authorId) && shaPattern.test(q.sha256) && q.baseSha256 === p.sha256, 'INVALID_STORE', 'Invalid proposal metadata.', 500);
  }
  validateSourceIndex({ format: 'world-hub.source-index/v1', id: 'world-hub-workshop', title: 'World Hub Workshop', entries: state.publications.map(p => p.entry) });
}

export class WorkshopStore {
  constructor(root, options = {}) {
    this.root = root; this.diskQuota = options.diskQuota ?? 512 * 1024 * 1024;
    requireValue(Number.isSafeInteger(this.diskQuota) && this.diskQuota >= MAX_UPLOAD && this.diskQuota <= 8 * 1024 * 1024 * 1024, 'INVALID_CONFIG', 'Invalid Workshop disk quota.');
    this.queue = Promise.resolve(); this.pending = 0; this.authQueue = Promise.resolve(); this.authPending = 0; this.closed = false;
  }
  static async open(options = {}) {
    requireValue(typeof options.root === 'string' && options.root, 'INVALID_CONFIG', 'A private Workshop data root is required.');
    const root = await ordinaryPath(resolve(options.root), { allowMissing: true });
    requireValue(root.length <= 160, 'ROOT_TOO_LONG', 'Use a Workshop data root of at most 160 characters.');
    await mkdir(root, { recursive: true, mode: 0o700 }); await ordinaryPath(root);
    const store = new WorkshopStore(root, options); store.nonce = randomUUID(); store.ownerPath = join(root, 'workshop-owner.lock');
    await ordinaryPath(store.ownerPath, { allowMissing: true });
    try {
      const owner = await open(store.ownerPath, 'wx', 0o600);
      try { await owner.writeFile(JSON.stringify({ format: 'world-hub.workshop-owner/v1', nonce: store.nonce, pid: process.pid, startedAt: now() })); await owner.sync(); } finally { await owner.close(); }
    } catch (error) { if (error.code === 'EEXIST') throw workshopError('WORKSHOP_LOCKED', 'This data root already has an owner. Inspect an abandoned lock manually; recorded PIDs are never killed.', 409); throw error; }
    try {
      store.artifactRoot = join(root, 'artifacts'); await ordinaryPath(store.artifactRoot, { allowMissing: true }); await mkdir(store.artifactRoot, { recursive: true, mode: 0o700 });
      store.metadataPath = join(root, 'metadata.json');
      try { store.state = JSON.parse((await readBounded(store.metadataPath, MAX_METADATA)).toString('utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; store.state = { format: 'world-hub.workshop-state/v1', revision: 0, users: [], sessions: [], invitations: [], publications: [] }; await atomicJson(store.metadataPath, store.state); }
      assertState(store.state); cleanExpired(store.state); store.totalArtifactBytes = 0; store.artifacts = new Map();
      const files = await readdir(store.artifactRoot);
      requireValue(files.length <= 8192, 'ARTIFACT_QUOTA', 'Too many stored artifacts.', 507);
      for (const name of files) {
        // The exclusive data owner may remove only interrupted upload staging
        // files with our exact generated name, never a published artifact.
        if (/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(name)) {
          const temporary = join(store.artifactRoot, name); await ordinaryPath(temporary); const info = await lstat(temporary);
          requireValue(info.isFile() && info.size <= MAX_UPLOAD, 'INVALID_STORE', 'Unsafe interrupted upload staging file.', 500); await unlink(temporary); continue;
        }
        requireValue(/^[a-f0-9]{64}\.json$/.test(name), 'INVALID_STORE', 'Unexpected material in the Workshop artifact directory.', 500);
        const bytes = await readBounded(join(store.artifactRoot, name), MAX_UPLOAD);
        requireValue(hash(bytes) === name.slice(0, 64), 'INVALID_STORE', 'Stored distribution artifact hash mismatch.', 500);
        store.artifacts.set(name.slice(0, 64), bytes.length); store.totalArtifactBytes += bytes.length;
      }
      requireValue(store.totalArtifactBytes <= store.diskQuota, 'ARTIFACT_QUOTA', 'Stored artifacts exceed the configured disk quota.', 507);
      for (const p of store.state.publications) for (const digest of [p.sha256, ...p.proposals.map(q => q.sha256)]) requireValue(store.artifacts.has(digest), 'INVALID_STORE', 'Publication artifact is missing.', 500);
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  transaction(action) {
    requireValue(!this.closed && !this.poisoned && this.pending < 64, 'WORKSHOP_BUSY', 'Workshop is busy or requires a clean restart; retry shortly.', 503); this.pending++;
    const operation = this.queue.then(async () => {
      requireValue(!this.poisoned, 'STORE_RESTART_REQUIRED', 'Workshop metadata durability is uncertain; stop and restart before writing.', 503);
      const draft = structuredClone(this.state); cleanExpired(draft); const result = await action(draft);
      draft.revision++; assertState(draft);
      try { await atomicJson(this.metadataPath, draft); } catch (error) { if (error.metadataPublished) this.poisoned = true; throw error; }
      this.state = draft; return result;
    });
    this.queue = operation.catch(() => {}).finally(() => { this.pending--; }); return operation;
  }
  passwordWork(action) {
    requireValue(!this.closed && this.authPending < 8, 'AUTH_BUSY', 'Account verification is busy; retry shortly.', 503); this.authPending++;
    const operation = this.authQueue.then(action); this.authQueue = operation.catch(() => {}).finally(() => { this.authPending--; }); return operation;
  }
  async passwordHash(password, salt = randomBytes(16).toString('hex')) {
    const derived = await this.passwordWork(() => scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })); return { salt, hash: derived.toString('hex') };
  }
  async initializeAdmin(username, password) {
    requireValue(typeof username === 'string' && usernamePattern.test(username), 'INVALID_USERNAME', 'Use a lowercase username of 3–40 letters, numbers, dots, dashes or underscores.'); passwordInput(password);
    const passwordRecord = await this.passwordHash(password);
    return this.transaction(state => {
      requireValue(state.users.length === 0, 'ALREADY_INITIALIZED', 'Workshop administrator is already initialized.', 409);
      const user = { id: randomUUID(), username, role: 'admin', disabled: false, password: passwordRecord, createdAt: now() }; state.users.push(user); return publicUser(user);
    });
  }
  userForSession(rawToken) {
    if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const session = this.state.sessions.find(v => equal(v.hash, hash(rawToken)) && Date.parse(v.expiresAt) > Date.now());
    const user = session && this.state.users.find(v => v.id === session.userId && !v.disabled); return user ? publicUser(user) : null;
  }
  csrfForSession(rawToken) { return hash(`world-hub.workshop-csrf/v1:${rawToken}`); }
  csrfValid(rawToken, csrf) { return equal(this.csrfForSession(rawToken), csrf); }
  newSession(state, user, rawToken) {
    state.sessions = state.sessions.filter(v => v.userId !== user.id || Date.parse(v.createdAt) > Date.now() - 12 * 60 * 60 * 1000);
    const own = state.sessions.filter(v => v.userId === user.id);
    if (own.length >= 8) state.sessions = state.sessions.filter(v => v !== own[0]);
    requireValue(state.sessions.length < 1024, 'SESSION_QUOTA', 'Session limit reached.', 429);
    state.sessions.push({ hash: hash(rawToken), userId: user.id, createdAt: now(), expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
    return { user: publicUser(user), csrfToken: this.csrfForSession(rawToken), sessionToken: rawToken };
  }
  async login(username, password) {
    requireValue(typeof username === 'string' && typeof password === 'string' && password.length <= 128, 'LOGIN_FAILED', 'Invalid username or password.', 401);
    const user = this.state.users.find(v => v.username === username); const salt = user?.password.salt ?? '00000000000000000000000000000000';
    const derived = await this.passwordHash(password, salt);
    requireValue(user && !user.disabled && equal(derived.hash, user.password.hash), 'LOGIN_FAILED', 'Invalid username or password.', 401);
    const rawToken = token();
    return this.transaction(state => { const current = state.users.find(v => v.id === user.id); requireValue(current && !current.disabled && equal(current.password.hash, derived.hash), 'LOGIN_FAILED', 'Invalid username or password.', 401); return this.newSession(state, current, rawToken); });
  }
  async register(username, password, invitation) {
    requireValue(typeof username === 'string' && usernamePattern.test(username), 'INVALID_USERNAME', 'Use a lowercase username of 3–40 letters, numbers, dots, dashes or underscores.'); passwordInput(password);
    requireValue(typeof invitation === 'string' && /^[A-Za-z0-9_-]{43}$/.test(invitation), 'INVITATION_INVALID', 'Invitation is invalid or expired.', 403);
    const invitationHash = hash(invitation);
    requireValue(this.state.invitations.some(v => v.hash === invitationHash && Date.parse(v.expiresAt) > Date.now()), 'INVITATION_INVALID', 'Invitation is invalid or expired.', 403);
    const passwordRecord = await this.passwordHash(password); const rawToken = token();
    return this.transaction(state => {
      const invite = state.invitations.find(v => v.hash === invitationHash);
      requireValue(invite && Date.parse(invite.expiresAt) > Date.now(), 'INVITATION_INVALID', 'Invitation is invalid or expired.', 403);
      requireValue(state.users.length < 128, 'ACCOUNT_QUOTA', 'Account quota reached.', 429);
      requireValue(!state.users.some(v => v.username === username), 'USERNAME_EXISTS', 'Username is already in use.', 409);
      const user = { id: randomUUID(), username, role: 'member', disabled: false, password: passwordRecord, createdAt: now() }; state.users.push(user);
      state.invitations = state.invitations.filter(v => v !== invite); return this.newSession(state, user, rawToken);
    });
  }
  logout(rawToken) { return this.transaction(state => { state.sessions = state.sessions.filter(v => v.hash !== hash(rawToken)); return { ok: true }; }); }
  requireAdmin(state, user) { requireValue(state.users.some(v => v.id === user.id && v.role === 'admin' && !v.disabled), 'ADMIN_REQUIRED', 'Administrator access required.', 403); }
  requireActive(state, user) { requireValue(state.users.some(v => v.id === user.id && !v.disabled), 'AUTH_REQUIRED', 'Active account required.', 401); }
  invite(user) {
    const invitation = token(); return this.transaction(state => {
      this.requireAdmin(state, user); requireValue(state.invitations.length < 128, 'INVITATION_QUOTA', 'Invitation quota reached.', 429);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); state.invitations.push({ hash: hash(invitation), creatorId: user.id, expiresAt }); return { invitation, expiresAt };
    });
  }
  users(user) { this.requireAdmin(this.state, user); return { users: this.state.users.map(publicUser) }; }
  setUserStatus(actor, userId, disabled) {
    requireValue(typeof disabled === 'boolean', 'INVALID_INPUT', 'disabled must be a boolean.');
    return this.transaction(state => {
      this.requireAdmin(state, actor); const user = state.users.find(v => v.id === userId); requireValue(user, 'NOT_FOUND', 'Account not found.', 404);
      requireValue(user.id !== actor.id, 'ADMIN_SELF_DISABLE', 'An administrator cannot disable their own account.', 409);
      user.disabled = disabled; if (disabled) state.sessions = state.sessions.filter(v => v.userId !== user.id); return { user: publicUser(user) };
    });
  }
  summary(p) {
    const owner = this.state.users.find(v => v.id === p.ownerId);
    return { entryId: p.entryId, kind: p.kind, id: p.id, version: p.version, title: p.title, sha256: p.sha256, license: p.entry.license,
      platforms: p.entry.platforms, provides: p.entry.provides, requires: p.entry.requires, owner: { id: owner.id, username: owner.username },
      createdAt: p.createdAt, hidden: p.hidden, commentsCount: p.comments.length, proposalsCount: p.proposals.length };
  }
  catalog({ search = '', kind = '', contract = '', offset = 0, limit = 40 } = {}, user = null) {
    requireValue(typeof search === 'string' && search.length <= 128 && ['', 'module', 'pack', 'template'].includes(kind) && typeof contract === 'string' && contract.length <= 128
      && Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_INPUT', 'Invalid catalog filter or pagination.');
    const needle = search.toLowerCase();
    const matches = this.state.publications.filter(p => (!p.hidden || user?.role === 'admin') && (!kind || p.kind === kind)
      && (!needle || `${p.id} ${p.title} ${p.entry.license} ${this.state.users.find(v => v.id === p.ownerId).username}`.toLowerCase().includes(needle))
      && (!contract || [...p.entry.provides, ...p.entry.requires].some(c => c.id === contract))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { publications: matches.slice(offset, offset + limit).map(p => this.summary(p)), total: matches.length, offset, limit };
  }
  publication(entryId, user = null) {
    const p = this.state.publications.find(v => v.entryId === entryId);
    requireValue(p && (!p.hidden || user?.role === 'admin' || user?.id === p.ownerId), 'NOT_FOUND', 'Publication not found.', 404); return p;
  }
  commentSummary(c) { const author = this.state.users.find(v => v.id === c.authorId); return { id: c.id, text: c.text, author: { id: author.id, username: author.username }, createdAt: c.createdAt }; }
  proposalSummary(q) { const author = this.state.users.find(v => v.id === q.authorId); return { id: q.id, title: q.title, baseSha256: q.baseSha256, sha256: q.sha256, kind: q.kind, artifactId: q.artifactId, version: q.version, author: { id: author.id, username: author.username }, createdAt: q.createdAt }; }
  detail(entryId, user = null) { const p = this.publication(entryId, user); return { publication: this.summary(p), entry: p.entry, comments: p.comments.map(c => this.commentSummary(c)), proposals: p.proposals.map(q => this.proposalSummary(q)) }; }
  index(baseURL) { return { format: 'world-hub.source-index/v1', id: 'world-hub-workshop', title: 'World Hub Workshop', entries: this.state.publications.filter(p => !p.hidden).map(p => ({ ...p.entry, source: { url: `${baseURL}/artifacts/${p.sha256}.json` } })) }; }
  async artifactBytes(digest) { requireValue(shaPattern.test(digest) && this.artifacts.has(digest), 'NOT_FOUND', 'Artifact not found.', 404); const bytes = await readBounded(join(this.artifactRoot, `${digest}.json`), MAX_UPLOAD); requireValue(hash(bytes) === digest, 'ARTIFACT_CORRUPT', 'Stored artifact failed integrity verification.', 500); return bytes; }
  async artifactHandle(digest) {
    requireValue(shaPattern.test(digest) && this.artifacts.has(digest), 'NOT_FOUND', 'Artifact not found.', 404);
    const file = join(this.artifactRoot, `${digest}.json`); await ordinaryPath(file); const handle = await open(file, 'r');
    try {
      const info = await handle.stat(); requireValue(info.isFile() && info.size <= MAX_UPLOAD && info.size === this.artifacts.get(digest), 'ARTIFACT_CORRUPT', 'Stored artifact failed integrity verification.', 500);
      const sha = createHash('sha256'), chunk = Buffer.alloc(65536); let position = 0;
      while (position < info.size) { const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - position), position); requireValue(bytesRead > 0, 'ARTIFACT_CORRUPT', 'Stored artifact failed integrity verification.', 500); sha.update(chunk.subarray(0, bytesRead)); position += bytesRead; }
      requireValue(sha.digest('hex') === digest, 'ARTIFACT_CORRUPT', 'Stored artifact failed integrity verification.', 500); return { handle, size: info.size };
    } catch (error) { await handle.close(); throw error; }
  }
  async storeArtifact(bytes) {
    const digest = hash(bytes);
    if (this.artifacts.has(digest)) { const stored = await this.artifactBytes(digest); requireValue(stored.equals(bytes), 'ARTIFACT_CORRUPT', 'Stored artifact failed integrity verification.', 500); return digest; }
    requireValue(this.artifacts.size < 8192 && this.totalArtifactBytes + bytes.length <= this.diskQuota, 'ARTIFACT_QUOTA', 'Workshop artifact storage quota reached.', 507);
    const file = join(this.artifactRoot, `${digest}.json`), temporary = join(this.artifactRoot, `${digest}.${randomUUID()}.tmp`);
    await ordinaryPath(file, { allowMissing: true }); const handle = await open(temporary, 'wx', 0o600);
    // Publish with an exclusive hard link on the same filesystem. An existing
    // canonical digest is never overwritten, even if the directory was changed.
    try { await handle.writeFile(bytes); await handle.sync(); await handle.close(); await link(temporary, file); await unlink(temporary); await syncDirectory(this.artifactRoot); }
    finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    this.artifacts.set(digest, bytes.length); this.totalArtifactBytes += bytes.length; return digest;
  }
  validatedArtifact(artifact, acknowledged) {
    requireValue(acknowledged === true, 'REDISTRIBUTION_REQUIRED', 'Explicit redistribution acknowledgement is required.');
    requireValue(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'INVALID_ARTIFACT', 'An artifact object is required.');
    const bytes = Buffer.from(JSON.stringify(artifact) + '\n'); requireValue(bytes.length <= MAX_UPLOAD, 'BODY_TOO_LARGE', 'Artifact exceeds 8 MiB.', 413);
    let validated; try { validated = validateArtifactBytes(bytes); } catch { throw workshopError('INVALID_ARTIFACT', 'Artifact manifest, file set, contract or digest validation failed.'); }
    return { bytes, validated, digest: hash(bytes) };
  }
  publish(user, { artifact, redistributionAcknowledged, title }) {
    const { bytes, validated, digest } = this.validatedArtifact(artifact, redistributionAcknowledged); const displayTitle = textInput(title ?? artifact.id, 256, 'publication title');
    return this.transaction(async state => {
      requireValue(state.users.some(v => v.id === user.id && !v.disabled), 'AUTH_REQUIRED', 'Active account required.', 401);
      const identity = state.publications.find(p => p.kind === artifact.kind && p.id === artifact.id);
      requireValue(!identity || identity.ownerId === user.id, 'IDENTITY_OWNED', 'This package identity belongs to another account.', 409);
      const existing = state.publications.find(p => p.kind === artifact.kind && p.id === artifact.id && p.version === artifact.version);
      if (existing) { requireValue(existing.sha256 === digest, 'IMMUTABLE_VERSION', 'A published version cannot be overwritten. Publish a new version.', 409); return { publication: this.summary(existing), entry: existing.entry, duplicate: true }; }
      requireValue(state.publications.length < 4096 && state.publications.filter(p => p.ownerId === user.id).length < 256, 'PUBLICATION_QUOTA', 'Publication quota reached.', 429);
      await this.storeArtifact(bytes); const entryId = `pub.${digest.slice(0, 40)}`; const entry = { ...validated.entry, entryId, title: displayTitle, sha256: digest, source: { path: `artifacts/${digest}.json` } };
      const p = { entryId, kind: artifact.kind, id: artifact.id, version: artifact.version, title: displayTitle, sha256: digest, ownerId: user.id, createdAt: now(), hidden: false, entry, comments: [], proposals: [] }; state.publications.push(p);
      return { publication: this.summary(p), entry, duplicate: false };
    });
  }
  comment(user, entryId, text) {
    text = textInput(text, 4000, 'comment'); return this.transaction(state => {
      this.requireActive(state, user);
      const p = state.publications.find(v => v.entryId === entryId && !v.hidden); requireValue(p, 'NOT_FOUND', 'Publication not found.', 404);
      requireValue(p.comments.length < 100, 'COMMENT_QUOTA', 'This publication has reached its comment quota.', 429);
      const c = { id: randomUUID(), text, authorId: user.id, createdAt: now() }; p.comments.push(c); return { comment: this.commentSummary(c) };
    });
  }
  propose(user, entryId, { artifact, baseSha256, redistributionAcknowledged, title }) {
    const { bytes, digest } = this.validatedArtifact(artifact, redistributionAcknowledged); const displayTitle = textInput(title ?? `Proposal for ${artifact.id}`, 256, 'proposal title');
    return this.transaction(async state => {
      this.requireActive(state, user);
      const p = state.publications.find(v => v.entryId === entryId && !v.hidden); requireValue(p, 'NOT_FOUND', 'Publication not found.', 404);
      requireValue(baseSha256 === p.sha256, 'BASELINE_CHANGED', 'Proposal must identify the exact immutable baseline digest.', 409);
      requireValue(artifact.kind === p.kind, 'PROPOSAL_KIND', 'Proposal and baseline must have the same artifact kind.');
      requireValue(artifact.id === p.id, 'PROPOSAL_IDENTITY', 'A proposal must preserve its baseline package identity. Publish a fork as a new publication.');
      requireValue(digest !== p.sha256, 'PROPOSAL_UNCHANGED', 'Proposal must contain a changed distribution artifact.');
      requireValue(p.proposals.length < 32 && state.publications.reduce((count, publication) => count + publication.proposals.filter(q => q.authorId === user.id).length, 0) < 256, 'PROPOSAL_QUOTA', 'Proposal quota reached.', 429);
      await this.storeArtifact(bytes); const q = { id: randomUUID(), title: displayTitle, baseSha256, sha256: digest, kind: artifact.kind, artifactId: artifact.id, version: artifact.version, authorId: user.id, createdAt: now() }; p.proposals.push(q); return { proposal: this.proposalSummary(q) };
    });
  }
  async proposal(entryId, proposalId, user) { const p = this.publication(entryId, user); const q = p.proposals.find(v => v.id === proposalId); requireValue(q, 'NOT_FOUND', 'Proposal not found.', 404); return { proposal: this.proposalSummary(q), artifact: JSON.parse((await this.artifactBytes(q.sha256)).toString('utf8')) }; }
  visibility(user, entryId, hidden) {
    requireValue(typeof hidden === 'boolean', 'INVALID_INPUT', 'hidden must be a boolean.'); return this.transaction(state => { this.requireAdmin(state, user); const p = state.publications.find(v => v.entryId === entryId); requireValue(p, 'NOT_FOUND', 'Publication not found.', 404); p.hidden = hidden; return { publication: this.summary(p) }; });
  }
  async exportTo(destination) {
    await this.queue; const target = await ordinaryPath(resolve(destination), { allowMissing: true });
    requireValue(target !== this.root && !target.startsWith(this.root + '/') && !target.startsWith(this.root + '\\'), 'INVALID_EXPORT', 'Export destination must be outside the data root.');
    await mkdir(target, { mode: 0o700 }); await mkdir(join(target, 'artifacts'), { mode: 0o700 });
    await atomicJson(join(target, 'metadata.json'), this.state);
    for (const digest of this.artifacts.keys()) { const bytes = await this.artifactBytes(digest); const handle = await open(join(target, 'artifacts', `${digest}.json`), 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    return { format: 'world-hub.workshop-export/v1', artifacts: this.artifacts.size, bytes: this.totalArtifactBytes, revision: this.state.revision, containsCredentials: true };
  }
  async close() {
    if (this.closed) return; this.closed = true; await this.authQueue; await this.queue;
    if (!this.ownerPath) return;
    const owner = JSON.parse((await readBounded(this.ownerPath, 4096)).toString('utf8'));
    requireValue(owner.nonce === this.nonce, 'OWNER_CHANGED', 'Workshop owner lock changed; refusing to remove it.', 500); await unlink(this.ownerPath);
  }
}

export async function initializeAdmin(options) { const store = await WorkshopStore.open(options); try { return await store.initializeAdmin(options.username, options.password); } finally { await store.close(); } }
