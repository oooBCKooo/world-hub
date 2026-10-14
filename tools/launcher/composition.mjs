// Creates an optional deployment package from independently selected modules.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateModule, validatePack, createLock, inspectPackage, safeId } from '../../scripts/runtime/package.mjs';
import { ordinaryPath, readBounded, hash, privateJson } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { inspectDeployment, validateDeploymentSettings } from '../../scripts/runtime/deployment.mjs';

const same=(a,b)=>a.id===b.id&&a.version===b.version;
const error=message=>Object.assign(new Error(message),{code:'COMPOSITION_INVALID'});
export async function previewComposition(input) {
  if(!Array.isArray(input.modules)||input.modules.length<1||input.modules.length>32) throw error('Add at least one module to the composition');
  safeId(input.id,'composition ID');
  const pack={format:'world-hub.pack/v1',id:input.id,version:input.version??'0.1.0',title:input.title??input.id,license:input.license??'MIT',topics:{},components:[],bindings:[],entry:{component:input.entry??input.modules[0].componentId},startupTimeoutMs:60000,healthTimeoutMs:10000,stopTimeoutMs:10000};
  const sources=[];
  for(const selected of input.modules) {
    safeId(selected.componentId,'component ID');const directory=await ordinaryPath(selected.directory);
    const manifest=JSON.parse(await readBounded(join(directory,'module.json')));validateModule(manifest);
    const files=await collectSourceFiles(directory),deploymentReview=await inspectDeployment({directory,manifest}),defaults=deploymentReview.deployment;
    if(!files.some(file=>file.path===manifest.runtime.entry)) throw error('Module entry is missing');
    const declaredTopics=selected.topics??defaults?.topics;
    if(!declaredTopics || !defaults?.bridges&&!selected.bridges) throw error('Module author must supply deployment defaults, or configure its topics and bridge slots');
    const aliases={};
    for(const [alias,topic] of Object.entries(declaredTopics)) {
      const existing=Object.keys(pack.topics).find(key=>pack.topics[key]===topic),key=existing??`${selected.componentId}.${alias}`;
      safeId(key,'combined topic alias');aliases[alias]=key;pack.topics[key]=topic;
    }
    const declaredBridges=selected.bridges??defaults.bridges,bridges={};
    for(const [slot,acl] of Object.entries(declaredBridges)) bridges[slot]=Object.fromEntries(['publish','subscribe'].map(action=>[action,acl[action].map(alias=>{if(!aliases[alias])throw error('Module bridge refers to an unknown topic');return aliases[alias];})]));
    const settings=selected.settings??Object.fromEntries((defaults?.settings??[]).map(field=>[field.key,field.default]));
    validateDeploymentSettings(defaults,settings,{publicSource:true});
    // Keep per-program alias names as a public input without dictating how an
    // application interprets them; its adapter can use topicAliases directly.
    pack.components.push({id:selected.componentId,module:manifest.id,after:selected.after??[],settings,bridges});
    const existing=sources.find(source=>source.manifest.id===manifest.id);
    if(existing && (existing.manifest.version!==manifest.version || JSON.stringify(existing.files)!==JSON.stringify(files))) throw error('One composition must select one exact version/content per module ID');
    if(!existing) sources.push({directory,manifest,files,deploymentReview});
    for(const binding of selected.providers??[]) pack.bindings.push({from:binding.from,to:selected.componentId,contract:binding.contract});
  }
  validatePack(pack);
  for(const component of pack.components) {
    const manifest=sources.find(source=>source.manifest.id===component.module).manifest;
    for(const required of manifest.requires) if(!pack.bindings.some(binding=>binding.to===component.id&&same(binding.contract,required))) throw error(`Choose a provider for ${component.id}: ${required.id}@${required.version}`);
  }
  for(const binding of pack.bindings) {
    const from=pack.components.find(component=>component.id===binding.from),to=pack.components.find(component=>component.id===binding.to);
    if(!sources.find(source=>source.manifest.id===from.module).manifest.provides.some(contract=>same(contract,binding.contract)) || !sources.find(source=>source.manifest.id===to.module).manifest.requires.some(contract=>same(contract,binding.contract))) throw error('Capability binding must match both programs exactly');
  }
  return {pack,sources,digest:hash(JSON.stringify({pack,sources})),startsModules:false};
}
export async function createComposition({root,input,preview,environment,signal}) {
  const fresh=await previewComposition(input);if(fresh.digest!==preview.digest) throw error('Selected module contents changed after review');
  const destination=await ordinaryPath(join(root,'compositions',input.id+'-'+randomUUID()),{allowMissing:true});
  await mkdir(destination,{recursive:true,mode:0o700});
  try {
    await privateJson(join(destination,'pack.json'),fresh.pack,{exclusive:true});
    for(const source of fresh.sources) for(const file of source.files) {
      if(signal?.aborted) throw error('Composition creation cancelled');
      const bytes=await readBounded(join(source.directory,file.path),8*1024*1024);if(hash(bytes)!==file.sha256) throw error('Module changed while copying');
      const target=join(destination,'modules',source.manifest.id,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});
    }
    await createLock(destination,environment);const review=await inspectPackage(destination,environment);
    return {directory:destination,pack:fresh.pack,digest:review.digest,startsModules:false};
  } catch(issue) {issue.incompleteDestination=destination;throw issue;}
}
