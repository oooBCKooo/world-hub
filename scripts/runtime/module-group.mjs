// A distributable group is a recipe for independent module instances. It has
// no Hub, credentials, process identity or application state of its own.
import { join } from 'node:path';
import { safeId, validateModule } from './package.mjs';
import { validateDeployment, validateDeploymentSettings } from './deployment.mjs';
import { relativePath, ordinaryPath, collectFiles, readBounded } from './paths.mjs';
import { resolveStartupOrder } from './startup-order.mjs';
import { validateExecutionDefaults } from './execution-defaults.mjs';

export const DISTRIBUTABLE_MODULE_GROUP_FORMAT = 'world-hub.module-group/v1';
const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const bad = message => Object.assign(new Error(message), { code: 'MODULE_GROUP_INVALID' });
const equalContract = (a, b) => a.id === b.id && a.version === b.version;
function exact(value, keys, name, optional = []) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw bad(`Invalid ${name} fields`);
}
function contracts(values, name) {
  if (!Array.isArray(values) || values.length > 64) throw bad(`Invalid ${name}`);
  for (const item of values) {
    exact(item, ['id', 'version'], name);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128 || item.id.includes('\0') || typeof item.version !== 'string' || item.version.length > 128 || !version.test(item.version)) throw bad(`Invalid ${name}`);
  }
  if (new Set(values.map(item => JSON.stringify([item.id, item.version]))).size !== values.length) throw bad(`Duplicate ${name}`);
}
function publicConfiguration(value) {
  exact(value, ['topics', 'bridges', 'settings', 'bindings'], 'group member configuration', ['executionDefaults']);
  if (value.executionDefaults !== undefined) validateExecutionDefaults(value.executionDefaults);
  validateDeploymentSettings({}, value.settings, { publicSource: true });
  if (!plain(value.topics) || Object.keys(value.topics).length < 1 || Object.keys(value.topics).length > 64) throw bad('Group member needs concrete communication topics');
  for (const [alias, topic] of Object.entries(value.topics)) {
    safeId(alias, 'group topic alias');
    if (typeof topic !== 'string' || !topic || topic.length > 512 || /[\s\0#+]/.test(topic) || topic.split('/').some(part => !part)) throw bad('Invalid group communication topic');
  }
  if (new Set(Object.values(value.topics)).size !== Object.keys(value.topics).length) throw bad('Duplicate group member topic');
  if (!plain(value.bridges) || !Object.keys(value.bridges).length || Object.keys(value.bridges).length > 8) throw bad('Invalid group bridge configuration');
  for (const [slot, rules] of Object.entries(value.bridges)) {
    safeId(slot, 'group bridge slot'); exact(rules, ['publish', 'subscribe'], 'group bridge ACL');
    for (const action of ['publish', 'subscribe']) if (!Array.isArray(rules[action]) || rules[action].length > 64 || new Set(rules[action]).size !== rules[action].length || rules[action].some(alias => !Object.hasOwn(value.topics, alias))) throw bad('Group bridge ACL references unknown topic aliases');
  }
  if (!Array.isArray(value.bindings) || value.bindings.length > 32) throw bad('Invalid group capability bindings');
  for (const binding of value.bindings) {
    exact(binding, ['providerId', 'contract'], 'group capability binding'); safeId(binding.providerId, 'group provider ID'); contracts([binding.contract], 'group bound contract');
  }
  if (new Set(value.bindings.map(item => JSON.stringify([item.providerId, item.contract.id, item.contract.version]))).size !== value.bindings.length) throw bad('Duplicate group capability binding');
}
export function validateModuleGroup(manifest) {
  exact(manifest, ['format', 'id', 'version', 'title', 'license', 'platforms', 'provides', 'requires', 'modules', 'startupPlan'], 'module group');
  if (manifest.format !== DISTRIBUTABLE_MODULE_GROUP_FORMAT) throw bad('Unsupported module group format');
  safeId(manifest.id, 'module group ID');
  if (typeof manifest.version !== 'string' || manifest.version.length > 128 || !version.test(manifest.version)) throw bad('Invalid group version');
  for (const [key, maximum] of [['title', 256], ['license', 128]]) if (typeof manifest[key] !== 'string' || !manifest[key].trim() || manifest[key].length > maximum || /[\0\r\n]/.test(manifest[key])) throw bad(`Invalid group ${key}`);
  if (!Array.isArray(manifest.platforms) || !manifest.platforms.length || manifest.platforms.length > 32 || new Set(manifest.platforms).size !== manifest.platforms.length || manifest.platforms.some(item => typeof item !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(item))) throw bad('Invalid group platforms');
  contracts(manifest.provides, 'group provides'); contracts(manifest.requires, 'group requires');
  if (!Array.isArray(manifest.modules) || !manifest.modules.length || manifest.modules.length > 128) throw bad('A module group contains 1..128 members');
  const ids = new Set(), paths = new Set();
  for (const member of manifest.modules) {
    exact(member, ['id', 'path', 'moduleId', 'version', 'configuration'], 'module group member');
    safeId(member.id, 'group member ID'); safeId(member.moduleId, 'group member module ID'); relativePath(member.path);
    if (ids.has(member.id) || paths.has(member.path.toLowerCase()) || typeof member.version !== 'string' || member.version.length > 128 || !version.test(member.version)) throw bad('Duplicate or invalid group member');
    ids.add(member.id); paths.add(member.path.toLowerCase()); publicConfiguration(member.configuration);
  }
  for (const a of paths) for (const b of paths) if (a !== b && b.startsWith(a + '/')) throw bad('Group module source directories overlap');
  for (const member of manifest.modules) for (const binding of member.configuration.bindings) if (!ids.has(binding.providerId) || binding.providerId === member.id) throw bad('Group capability provider must be another declared group member');
  exact(manifest.startupPlan, ['members', 'onFailure', 'startupOrder'], 'group startup plan');
  const plan = manifest.startupPlan;
  if (!['continue-independent', 'stop-plan'].includes(plan.onFailure) || !Array.isArray(plan.members) || plan.members.length !== ids.size) throw bad('Invalid group startup selection');
  const planned = new Set();
  for (const member of plan.members) {
    exact(member, ['programId', 'enabled', 'after'], 'group startup member');
    if (!ids.has(member.programId) || planned.has(member.programId) || typeof member.enabled !== 'boolean' || !Array.isArray(member.after) || member.after.length > 128 || new Set(member.after).size !== member.after.length || member.after.some(id => !ids.has(id) || id === member.programId)) throw bad('Invalid group startup member');
    planned.add(member.programId);
  }
  if (!Array.isArray(plan.startupOrder)) throw bad('An exact group startup order is required');
  resolveStartupOrder(plan.members.map(member => ({ id: member.programId, after: member.after })), plan.startupOrder);
  return manifest;
}
export function validateModuleGroupFiles(manifest, decoded) {
  validateModuleGroup(manifest);
  const fileMap = new Map(decoded.map(file => [file.path, file.bytes ?? file.content]));
  const parse = path => { const bytes = fileMap.get(path); if (!bytes) throw bad(`Module group lacks ${path}`); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); };
  const modules = manifest.modules.map(member => {
    const module = validateModule(parse(member.path + '/module.json'));
    if (module.id !== member.moduleId || module.version !== member.version) throw bad('Group member module identity differs from declared source');
    if (manifest.platforms.some(platform => !module.platforms.includes(platform))) throw bad('Group platform is unsupported by a member');
    if (!fileMap.has(member.path + '/' + module.runtime.entry)) throw bad('Group module entry is missing');
    const deployment = fileMap.has(member.path + '/deployment.json') ? validateDeployment(parse(member.path + '/deployment.json'), module) : null;
    validateDeploymentSettings(deployment, member.configuration.settings, { publicSource: true });
    if (Object.keys(member.configuration.bridges).length !== module.bridges.length || module.bridges.some(slot => !Object.hasOwn(member.configuration.bridges, slot))) throw bad('Group member bridge slots differ from module declaration');
    for (const binding of member.configuration.bindings) if (!module.requires.some(required => equalContract(required, binding.contract))) throw bad('Group binding is not declared by consumer module');
    for (const required of module.requires) if (!member.configuration.bindings.some(binding => equalContract(binding.contract, required))) throw bad(`Group member ${member.id} lacks a required capability binding: ${required.id}@${required.version}`);
    return { member, manifest: module, deployment, files: decoded.filter(file => file.path.startsWith(member.path + '/')).map(file => ({ path: file.path.slice(member.path.length + 1), bytes: file.bytes ?? file.content })) };
  });
  for (const module of modules) for (const binding of module.member.configuration.bindings) {
    if (!modules.find(provider => provider.member.id === binding.providerId).manifest.provides.some(provided => equalContract(provided, binding.contract))) throw bad('Group provider does not declare the bound contract');
  }
  for (const file of decoded) {
    relativePath(file.path);
    if (file.path === 'module-group.json' || /^(?:README(?:\.[A-Za-z0-9_-]+)?\.md|LICENSE(?:\.txt|\.md)?|NOTICE(?:\.txt|\.md)?)$/i.test(file.path)) continue;
    const module = modules.find(module => file.path.startsWith(module.member.path + '/'));
    if (!module) throw bad('Group contains files outside declared module source directories');
    const local = file.path.slice(module.member.path.length + 1), parts = local.split('/');
    if (parts.some(part => ['__pycache__', '.venv', '.git', '.hub', '.state', '.local', '.artifacts', '.runtime', 'state', 'identities', 'credentials'].includes(part.toLowerCase())) || /(?:^|\/)(?:pack\.json|pack\.lock|template\.json|module-group\.json|\.env(?:\..*)?|credentials\.json|identity\.json|launch\.json)$/i.test(local) || /\.py[co]$/i.test(local) || local !== 'module.json' && parts.at(-1).toLowerCase() === 'module.json') throw bad('Group contains nested, generated or private material');
  }
  return { manifest, modules };
}
export async function readModuleGroup(directory) {
  const root = await ordinaryPath(directory), files = await collectFiles(root), decoded = [];
  for (const file of files) decoded.push({ path: file.path, bytes: await readBounded(join(root, file.path), 8 * 1024 * 1024) });
  const marker = decoded.find(file => file.path === 'module-group.json'); if (!marker) throw bad('Module group lacks module-group.json');
  const result = validateModuleGroupFiles(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(marker.bytes)), decoded);
  return { ...result, modules: result.modules.map(module => ({ ...module, directory: join(root, module.member.path) })) };
}
