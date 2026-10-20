// Author-selected installation and UI defaults for the optional deployment layer.
// Hub Core never reads this file or interprets an application's capabilities.
import { join } from 'node:path';
import { readBounded, hash, relativePath } from './paths.mjs';
import { assertHostedPlatform } from './host-profile.mjs';
import { validateDefaultConnections } from './default-connections.mjs';
import { validateExecutionDefaults } from './execution-defaults.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const bad = message => Object.assign(new Error(message), { code: 'DEPLOYMENT_INVALID' });
export function validateDeploymentSettings(deployment,settings,{publicSource=false}={}) {
  if(!object(settings)||Buffer.byteLength(JSON.stringify(settings))>65536)throw bad('Public settings must be an object within 64 KiB');
  if(publicSource){const check=value=>{if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(/password|passwd|secret|token|credential|private.?key|api.?key/i.test(key))throw bad('Keep private configuration out of shared composition settings');check(item);}};check(settings);}
  for(const field of deployment?.settings??[]) {
    const value=settings[field.key];if(typeof value!==field.type || field.type==='number'&&(!Number.isFinite(value)||field.min!==undefined&&value<field.min||field.max!==undefined&&value>field.max) || field.type==='string'&&(value.length>4096||value.includes('\0')))throw bad(`Invalid setting: ${field.key}`);
  }
  return settings;
}
export function deploymentTopics(pack,component,deployment) {
  // An explicit component map preserves a program's own aliases independently
  // of pack-wide names and the author's initial bridge permission defaults.
  // This maps names only; effective access remains the selected bridge ACL.
  if (Object.hasOwn(component, 'topicAliases')) {
    const aliases=component.topicAliases;
    if(!object(aliases)||!Object.keys(aliases).length||Object.keys(aliases).length>64)throw bad('Invalid explicit program topic aliases');
    const topics={};
    for(const [alias,key] of Object.entries(aliases)) {
      if(!id.test(alias)||typeof key!=='string'||!Object.hasOwn(pack.topics,key))throw bad('Program topic alias refers to an unknown pack topic');
      topics[alias]=pack.topics[key];
    }
    if(new Set(Object.values(aliases)).size!==Object.keys(aliases).length)throw bad('Program topic aliases must name distinct topics');
    for(const rules of Object.values(component.bridges))for(const action of ['publish','subscribe'])
      if(rules[action].some(key=>!Object.values(aliases).includes(key)))throw bad('Bridge permissions must refer to the program topic map');
    return topics;
  }
  const topics={...pack.topics};if(!deployment)return topics;
  for(const [slot,rules] of Object.entries(deployment.bridges)) for(const action of ['publish','subscribe']) {
    const aliases=rules[action],bindings=component.bridges[slot]?.[action];
    if(!bindings||bindings.length!==aliases.length)throw bad('Deployment topic defaults and selected bridge bindings differ');
    aliases.forEach((alias,index)=>{const value=pack.topics[bindings[index]];if(topics[alias]&&topics[alias]!==value)throw bad('Deployment topic alias is ambiguous');topics[alias]=value;});
  }
  return topics;
}
export async function readDeployment(directory, manifest) {
  let bytes;
  try { bytes = await readBounded(join(directory, 'deployment.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value; try { value = JSON.parse(bytes); } catch { throw bad('Invalid deployment.json'); }
  return validateDeployment(value, manifest);
}
// Public distribution validation shares the same author-default checks without
// probing a runtime, extracting files or executing uploaded code.
export function validateDeployment(value, manifest) {
  if (!object(value) || value.format !== 'world-hub.deployment/v1'
      || Object.keys(value).some(key => !['format','title','description','topics','bridges','settings','dependencies','connections','executionDefaults'].includes(key))) throw bad('Unsupported deployment fields');
  for (const key of ['title','description']) if (!object(value[key]) || Object.keys(value[key]).some(language => !['zh','en'].includes(language))
      || Object.values(value[key]).some(text => typeof text !== 'string' || !text || text.length > 2048)) throw bad(`Invalid deployment ${key}`);
  if (!object(value.topics) || Object.keys(value.topics).length > 64 || !Object.keys(value.topics).length) throw bad('Declare communication topic defaults');
  for (const [alias,topic] of Object.entries(value.topics)) if (!id.test(alias) || typeof topic !== 'string' || !topic || topic.length > 512 || /[\s\0#+]/.test(topic) || topic.split('/').some(part => !part)) throw bad('Invalid communication topic');
  if (!object(value.bridges) || manifest && (Object.keys(value.bridges).length !== manifest.bridges.length || manifest.bridges.some(slot => !Object.hasOwn(value.bridges,slot)))) throw bad('Declare defaults for each module bridge');
  for (const [slot,rules] of Object.entries(value.bridges)) {
    if (!id.test(slot) || !object(rules) || Object.keys(rules).sort().join(',') !== 'publish,subscribe') throw bad('Invalid bridge defaults');
    for (const action of ['publish','subscribe']) if (!Array.isArray(rules[action]) || rules[action].length > 64 || new Set(rules[action]).size !== rules[action].length || rules[action].some(alias => !Object.hasOwn(value.topics,alias))) throw bad('Unknown topic alias in bridge defaults');
  }
  if (!Array.isArray(value.settings) || value.settings.length > 64 || new Set(value.settings.map(field => field.key)).size !== value.settings.length) throw bad('Invalid setting fields');
  for (const field of value.settings) {
    if (!object(field) || !id.test(field.key) || /password|secret|token|credential|private.?key|api.?key/i.test(field.key)
        || Object.keys(field).some(key => !['key','label','type','default','min','max'].includes(key)) || !['string','number','boolean'].includes(field.type)
        || typeof field.default !== field.type || !object(field.label) || Object.values(field.label).some(text => typeof text !== 'string' || text.length > 256)) throw bad('Invalid public setting field');
    if (field.type === 'number' && (!Number.isFinite(field.default) || ['min','max'].some(key => field[key] !== undefined && !Number.isFinite(field[key])))) throw bad('Invalid numeric setting');
  }
  if (value.dependencies) {
    const dep = value.dependencies;
    if (!object(dep) || Object.keys(dep).sort().join(',') !== 'kind,lock,manifest,recipes' || dep.kind !== 'npm-lock'
        || dep.manifest !== 'package.json' || dep.lock !== 'package-lock.json' || !Array.isArray(dep.recipes)
        || dep.recipes.length > 1 || dep.recipes.some(recipe => recipe !== 'electron')) throw bad('Unsupported dependency installation recipe');
    relativePath(dep.manifest); relativePath(dep.lock);
  }
  if (Object.hasOwn(value, 'connections')) validateDefaultConnections(value.connections, manifest, value);
  if (Object.hasOwn(value, 'executionDefaults')) validateExecutionDefaults(value.executionDefaults);
  return value;
}
export async function inspectDeployment({directory,manifest}) {
  assertHostedPlatform(manifest);
  const deployment = await readDeployment(directory,manifest);
  if (!deployment) return { deployment: null, dependencies: null, digest: hash('no-deployment') };
  let dependencies = null;
  if (deployment.dependencies) {
    const packageBytes = await readBounded(join(directory,'package.json')), lockBytes = await readBounded(join(directory,'package-lock.json'));
    const pkg = JSON.parse(packageBytes), lock = JSON.parse(lockBytes);
    if (lock.lockfileVersion !== 3 || !object(lock.packages) || !object(lock.packages['']) || Object.keys(lock.packages).length > 257) throw bad('Use a complete bounded npm lock v3');
    const packages = [];
    for (const [path,item] of Object.entries(lock.packages)) {
      if (!path) continue;
      relativePath(path);
      if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i.test(path) || !object(item) || item.link) throw bad('Dependency must be an ordinary registry package');
      const url = new URL(item.resolved);
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity ?? '')) throw bad('Dependencies require official registry URLs and SHA-512 integrity');
      packages.push({path,version:item.version,url:url.href,integrity:item.integrity,license:item.license ?? null});
    }
    const wanted = {...pkg.dependencies,...pkg.devDependencies};
    if (JSON.stringify(wanted) !== JSON.stringify({...lock.packages[''].dependencies,...lock.packages[''].devDependencies})) throw bad('Manifest and lock dependencies differ');
    for (const [name,version] of Object.entries(wanted)) if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || lock.packages['node_modules/'+name]?.version !== version) throw bad('Pin every direct dependency to an exact locked version');
    if (deployment.dependencies.recipes.includes('electron') && wanted.electron !== '44.7.1') throw bad('This reviewed Electron recipe currently supports 44.7.1');
    dependencies = {kind:'npm-lock',packages,recipes:deployment.dependencies.recipes,manifestSha256:hash(packageBytes),lockSha256:hash(lockBytes),
      installsDependencies:true,runsModuleInstallScripts:false, ...(deployment.dependencies.recipes.includes('electron') ? {nativeDownload:'Official Electron release binary with the Electron installer checksum verification'} : {})};
  }
  return {deployment,dependencies,digest:hash(JSON.stringify({deployment,dependencies}))};
}
