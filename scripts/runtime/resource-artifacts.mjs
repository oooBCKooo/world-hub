// Public resource documents are deployment data outside Hub Core. Validation
// neither resolves source code nor evaluates any uploaded business data.
import { isDeepStrictEqual } from 'node:util';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, relativePath, ordinaryPath, readBounded } from './paths.mjs';
import { validateDeploymentSettings } from './deployment.mjs';
import { validateExecutionDefaults } from './execution-defaults.mjs';
import { resolveStartupOrder } from './startup-order.mjs';

const id = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const sha = /^[a-f0-9]{64}$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bad = (kind, message) => Object.assign(new Error(message), { code: kind.toUpperCase() + '_INVALID' });
function boundedDocument(value, kind) {
  let nodes = 0; const ancestors = new Set();
  const visit = (item, depth) => {
    if (++nodes > 65536 || depth > 32) throw bad(kind, 'Resource document exceeds its structure bound');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) return;
    if ((!plain(item) && !Array.isArray(item)) || ancestors.has(item)
        || Object.values(Object.getOwnPropertyDescriptors(item)).some(descriptor => !Object.hasOwn(descriptor, 'value'))
        || Reflect.ownKeys(item).some(key => typeof key !== 'string')) throw bad(kind, 'Resource fields must be ordinary JSON values');
    ancestors.add(item); for (const child of Object.values(item)) visit(child, depth + 1); ancestors.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw bad(kind, 'Resource manifest exceeds 1 MiB');
}
function exact(value, required, kind, name, optional = []) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, 'value'))
      || required.some(key => !Object.hasOwn(value, key))) throw bad(kind, `Invalid ${name} fields`);
}
function identifier(value, kind, name) { if (typeof value !== 'string' || !id.test(value)) throw bad(kind, `Invalid ${name}`); }
function version(value, kind) { if (typeof value !== 'string' || value.length > 128 || !semver.test(value)) throw bad(kind, 'Invalid exact resource version'); }
function contracts(values, kind, name) {
  if (!Array.isArray(values) || values.length > 64) throw bad(kind, `Invalid ${name}`);
  for (const item of values) {
    exact(item, ['id', 'version'], kind, name);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128 || item.id.includes('\0')) throw bad(kind, `Invalid ${name}`);
    version(item.version, kind);
  }
  if (new Set(values.map(item => JSON.stringify([item.id, item.version]))).size !== values.length) throw bad(kind, `Duplicate ${name}`);
}
function metadata(manifest, kind) {
  if (manifest.format !== `world-hub.${kind === 'data' ? 'module-data' : kind}/v1`) throw bad(kind, `Unsupported ${kind} format`);
  identifier(manifest.id, kind, 'resource ID'); version(manifest.version, kind);
  for (const [key, maximum] of [['title', 256], ['license', 128]]) if (typeof manifest[key] !== 'string' || !manifest[key].trim()
      || manifest[key].length > maximum || /[\0\r\n]/.test(manifest[key])) throw bad(kind, `Invalid resource ${key}`);
  if (!['global', 'local'].includes(manifest.scope)) throw bad(kind, 'Resource scope must be global or local');
  if (!Array.isArray(manifest.platforms) || !manifest.platforms.length || manifest.platforms.length > 32
      || new Set(manifest.platforms).size !== manifest.platforms.length
      || manifest.platforms.some(item => typeof item !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(item))) throw bad(kind, 'Invalid resource platforms');
  contracts(manifest.provides, kind, 'resource provides'); contracts(manifest.requires, kind, 'resource requires');
}
function moduleReference(value, kind) {
  exact(value, ['id', 'version', 'digest'], kind, 'module source reference'); identifier(value.id, kind, 'module ID'); version(value.version, kind);
  if (typeof value.digest !== 'string' || !sha.test(value.digest)) throw bad(kind, 'Module source digest must be SHA-256');
}
function publicConfiguration(value) {
  const kind = 'configuration'; exact(value, ['topics', 'bridges', 'settings', 'bindings'], kind, 'module public configuration', ['executionDefaults']);
  if (Object.hasOwn(value, 'executionDefaults')) validateExecutionDefaults(value.executionDefaults);
  // Keep the existing deployment public-settings rules, without needing a
  // module body or an author deployment file in this resource directory.
  validateDeploymentSettings({}, value.settings, { publicSource: true });
  if (!plain(value.topics) || Object.keys(value.topics).length < 1 || Object.keys(value.topics).length > 64) throw bad(kind, 'Declare 1..64 concrete communication topics');
  for (const [alias, topic] of Object.entries(value.topics)) {
    identifier(alias, kind, 'topic alias');
    if (typeof topic !== 'string' || !topic || topic.length > 512 || /[\s\0#+]/.test(topic) || topic.split('/').some(part => !part)) throw bad(kind, 'Invalid concrete communication topic');
  }
  if (new Set(Object.values(value.topics)).size !== Object.keys(value.topics).length) throw bad(kind, 'Duplicate concrete communication topic');
  if (!plain(value.bridges) || !Object.keys(value.bridges).length || Object.keys(value.bridges).length > 8) throw bad(kind, 'Declare 1..8 bridge slots');
  for (const [slot, rules] of Object.entries(value.bridges)) {
    identifier(slot, kind, 'bridge slot'); exact(rules, ['publish', 'subscribe'], kind, 'bridge ACL');
    for (const action of ['publish', 'subscribe']) if (!Array.isArray(rules[action]) || rules[action].length > 64
        || new Set(rules[action]).size !== rules[action].length || rules[action].some(alias => !Object.hasOwn(value.topics, alias))) throw bad(kind, 'Bridge ACL references unknown topic aliases');
  }
  if (!Array.isArray(value.bindings) || value.bindings.length > 32) throw bad(kind, 'Invalid capability bindings');
  for (const binding of value.bindings) {
    exact(binding, ['providerId', 'contract'], kind, 'capability binding'); identifier(binding.providerId, kind, 'provider logical instance ID'); contracts([binding.contract], kind, 'bound capability contract');
  }
  if (new Set(value.bindings.map(item => JSON.stringify([item.providerId, item.contract.id, item.contract.version]))).size !== value.bindings.length) throw bad(kind, 'Duplicate capability binding');
}
export function validateConfiguration(manifest) {
  const kind = 'configuration';
  boundedDocument(manifest, kind);
  exact(manifest, ['format', 'id', 'version', 'title', 'license', 'platforms', 'provides', 'requires', 'scope', 'modules', 'startupPlan'], kind, kind, ['data']);
  metadata(manifest, kind);
  if (!Array.isArray(manifest.modules) || !manifest.modules.length || manifest.modules.length > 128) throw bad(kind, 'A configuration contains 1..128 logical instances');
  const ids = new Set();
  for (const member of manifest.modules) {
    exact(member, ['id', 'module', 'configuration'], kind, 'configuration member'); identifier(member.id, kind, 'logical instance ID');
    if (ids.has(member.id)) throw bad(kind, 'Duplicate logical instance ID'); ids.add(member.id);
    moduleReference(member.module, kind); publicConfiguration(member.configuration);
  }
  for (const member of manifest.modules) for (const binding of member.configuration.bindings) if (!ids.has(binding.providerId) || binding.providerId === member.id) throw bad(kind, 'A capability provider must be another declared logical instance');
  const plan = manifest.startupPlan; exact(plan, ['members', 'onFailure', 'startupOrder'], kind, 'startup plan');
  if (!['continue-independent', 'stop-plan'].includes(plan.onFailure) || !Array.isArray(plan.members) || plan.members.length !== ids.size) throw bad(kind, 'Startup plan must include each logical instance');
  const planned = new Set();
  for (const member of plan.members) {
    exact(member, ['programId', 'enabled', 'after'], kind, 'startup member');
    if (!ids.has(member.programId) || planned.has(member.programId) || typeof member.enabled !== 'boolean' || !Array.isArray(member.after)
        || member.after.length > 128 || new Set(member.after).size !== member.after.length || member.after.some(id => !ids.has(id) || id === member.programId)) throw bad(kind, 'Invalid logical instance startup member');
    planned.add(member.programId);
  }
  if (!Array.isArray(plan.startupOrder)) throw bad(kind, 'An exact startup order is required');
  resolveStartupOrder(plan.members.map(member => ({ id: member.programId, after: member.after })), plan.startupOrder);
  if (Object.hasOwn(manifest, 'data')) {
    if (!Array.isArray(manifest.data) || manifest.data.length > 128) throw bad(kind, 'Invalid configuration data references');
    const referenced = new Set();
    for (const reference of manifest.data) {
      exact(reference, ['instanceId', 'id', 'version', 'sha256'], kind, 'data artifact reference'); identifier(reference.id, kind, 'data resource ID'); version(reference.version, kind);
      if (!ids.has(reference.instanceId) || referenced.has(reference.instanceId) || typeof reference.sha256 !== 'string' || !sha.test(reference.sha256)) throw bad(kind, 'Invalid or duplicate instance data reference');
      referenced.add(reference.instanceId);
    }
  }
  return manifest;
}
export function validateData(manifest) {
  const kind = 'data'; boundedDocument(manifest, kind); exact(manifest, ['format', 'id', 'version', 'title', 'license', 'platforms', 'provides', 'requires', 'scope', 'purpose', 'instances'], kind, kind);
  metadata(manifest, kind);
  if (!['dataset', 'backup'].includes(manifest.purpose)) throw bad(kind, 'Data purpose must be dataset or backup');
  if (!Array.isArray(manifest.instances) || !manifest.instances.length || manifest.instances.length > 128) throw bad(kind, 'Data contains 1..128 logical instances');
  const ids = new Set();
  for (const member of manifest.instances) {
    exact(member, ['id', 'module', 'path', 'dataFormat'], kind, 'data member'); identifier(member.id, kind, 'logical instance ID'); moduleReference(member.module, kind);
    if (ids.has(member.id) || member.path !== `data/${member.id}`) throw bad(kind, 'Data member path must be data/<distinct logical instance ID>'); ids.add(member.id);
    relativePath(member.path); exact(member.dataFormat, ['id', 'version'], kind, 'business data format');
    if (typeof member.dataFormat.id !== 'string' || !member.dataFormat.id || member.dataFormat.id.length > 128 || member.dataFormat.id.includes('\0')) throw bad(kind, 'Invalid business data format ID');
    version(member.dataFormat.version, kind);
  }
  return manifest;
}
function checkedFiles(manifest, decoded, kind) {
  if (!Array.isArray(decoded) || !decoded.length || decoded.length > 4096) throw bad(kind, 'Resource files exceed their count bound');
  const paths = new Set(), files = []; let total = 0;
  for (const file of decoded) {
    if (!plain(file)) throw bad(kind, 'Invalid resource file'); relativePath(file.path);
    const bytes = file.bytes ?? file.content;
    if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024 || paths.has(file.path.toLowerCase())) throw bad(kind, 'Invalid, oversized or case-colliding resource file');
    total += bytes.length; if (total > 64 * 1024 * 1024) throw bad(kind, 'Resource exceeds 64 MiB');
    paths.add(file.path.toLowerCase()); files.push({ path: file.path, bytes: Buffer.from(bytes) });
  }
  for (const path of paths) {
    const parts = path.split('/'); for (let index = 1; index < parts.length; index++) if (paths.has(parts.slice(0, index).join('/'))) throw bad(kind, 'Resource file/directory collision');
  }
  const marker = files.find(file => file.path === `${kind}.json`);
  if (!marker || marker.bytes.length > 1024 * 1024) throw bad(kind, `Resource lacks bounded ${kind}.json`);
  const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(marker.bytes));
  if (!isDeepStrictEqual(document, manifest)) throw bad(kind, 'Resource manifest differs from its declared file');
  return files;
}
export function validateConfigurationFiles(manifest, decoded) {
  validateConfiguration(manifest); const files = checkedFiles(manifest, decoded, 'configuration');
  if (files.length !== 1) throw bad('configuration', 'A configuration artifact contains configuration.json only');
  return { manifest, decoded: files };
}
export function validateDataFiles(manifest, decoded) {
  validateData(manifest); const files = checkedFiles(manifest, decoded, 'data');
  for (const file of files) {
    if (file.path === 'data.json') continue;
    const member = manifest.instances.find(member => file.path.startsWith(member.path + '/'));
    if (!member) throw bad('data', 'Data files must be within a declared logical instance data subtree');
    // Business filenames carry no management semantics. Credentials and Hub
    // state live outside the selected instance state directory and are never
    // captured by the manager; authors review dataset contents for publication.
  }
  return { manifest, decoded: files };
}
// This is exactly the existing ordered collectSourceFiles() manifest. Do not
// reconstruct it from artifact encoding or add fields while computing a pin.
export function sourceFilesDigest(files) { return hash(JSON.stringify(files)); }

// Unlike source collection this does not infer a file's role from its business
// name or extension. The resource's declared subtrees define its boundary.
export async function readResourceFiles(directory) {
  const root = await ordinaryPath(directory), files = []; let entries = 0, total = 0;
  async function visit(local = '') {
    for (const entry of await readdir(join(root, local), { withFileTypes: true })) {
      if (++entries > 8192) throw new Error('Resource tree exceeds entry-count bound');
      const path = local ? `${local}/${entry.name}` : entry.name; relativePath(path);
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error('Resource links are not allowed');
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const bytes = await readBounded(join(root, path), 8 * 1024 * 1024); total += bytes.length;
        if (total > 64 * 1024 * 1024 || files.length >= 4096) throw new Error('Resource file count or total size exceeds its bound');
        files.push({ path, bytes });
      } else throw new Error('Resource special files are not allowed');
    }
  }
  await visit(); return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
