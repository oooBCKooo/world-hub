// Bounded local distribution ingestion; no archive member is ever executed.
import { inflateRawSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ordinaryPath, readBounded, relativePath, hash } from '../../scripts/runtime/paths.mjs';
import { validateModule } from '../../scripts/runtime/package.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { readDeployment } from '../../scripts/runtime/deployment.mjs';
import { readResourceFiles, validateConfigurationFiles, validateDataFiles } from '../../scripts/runtime/resource-artifacts.mjs';
import { validateArtifactBytes } from '../../scripts/runtime/sources.mjs';

const bad = message => Object.assign(new Error(message),{code:'LOCAL_ARTIFACT_INVALID'});
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) { crc ^= value; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^0xffffffff)>>>0; }
export function readLocalZip(bytes) {
  let end=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--) if(bytes.readUInt32LE(offset)===0x06054b50 && offset+22+bytes.readUInt16LE(offset+20)===bytes.length) {end=offset;break;}
  if(end<0 || bytes.readUInt16LE(end+4) || bytes.readUInt16LE(end+6)) throw bad('Unsupported or damaged ZIP');
  const count=bytes.readUInt16LE(end+10),start=bytes.readUInt32LE(end+16),length=bytes.readUInt32LE(end+12);
  if(!count || count>4096 || count!==bytes.readUInt16LE(end+8) || start+length!==end) throw bad('Unsupported ZIP directory');
  let cursor=start,total=0; const files=[],seen=new Set(),ranges=[];
  const decoder=new TextDecoder('utf-8',{fatal:true});
  for(let index=0;index<count;index++) {
    if(cursor+46>end || bytes.readUInt32LE(cursor)!==0x02014b50) throw bad('Invalid ZIP member');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),crc=bytes.readUInt32LE(cursor+16);
    const names=bytes.readUInt16LE(cursor+28),extras=bytes.readUInt16LE(cursor+30),comments=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42),next=cursor+46+names+extras+comments;
    if(next>end || flags & ~0x808 || ![0,8].includes(method) || compressed>64*1024*1024 || size>8*1024*1024) throw bad('Unsupported ZIP compression or member limits');
    const name=decoder.decode(bytes.subarray(cursor+46,cursor+46+names)),directory=name.endsWith('/'),path=directory?name.slice(0,-1):name;
    relativePath(path);
    const unix=(bytes.readUInt32LE(cursor+38)>>>16)&0xf000;
    if(unix && ![0x8000,0x4000].includes(unix) || seen.has(path.toLowerCase())) throw bad('ZIP links, special files or duplicate paths are not supported');
    seen.add(path.toLowerCase());
    if(local+30>start || bytes.readUInt32LE(local)!==0x04034b50 || bytes.readUInt16LE(local+6)!==flags || bytes.readUInt16LE(local+8)!==method) throw bad('ZIP local header mismatch');
    const localNames=bytes.readUInt16LE(local+26),localExtras=bytes.readUInt16LE(local+28),data=local+30+localNames+localExtras,dataEnd=data+compressed;
    if(dataEnd>start || decoder.decode(bytes.subarray(local+30,local+30+localNames))!==name || ranges.some(([a,b])=>local<b&&dataEnd>a)) throw bad('ZIP has overlapping or mismatched data');
    ranges.push([local,dataEnd]);
    const content=method===0?bytes.subarray(data,dataEnd):inflateRawSync(bytes.subarray(data,dataEnd),{maxOutputLength:Math.max(1,size)});
    if(content.length!==size || crc32(content)!==crc || directory&&size) throw bad('ZIP content integrity mismatch');
    total+=size;if(total>64*1024*1024) throw bad('ZIP source exceeds 64 MiB');
    if(!directory) files.push({path,content});cursor=next;
  }
  if(cursor!==end) throw bad('Unparsed ZIP directory');
  for(const file of files) if(files.some(other=>other!==file&&other.path.toLowerCase().startsWith(file.path.toLowerCase()+'/'))) throw bad('ZIP file/directory path collision');
  return files;
}
async function identify(directory) {
  const markers=[];
  for(const kind of ['module','configuration','data']) try { const value=JSON.parse(await readBounded(join(directory,`${kind}.json`))); markers.push({kind,value}); } catch(error) { if(error.code!=='ENOENT') throw error; }
  if(markers.length!==1) throw bad('Choose one complete module, configuration or data root. Ordinary application source is not an installable module.');
  const {kind,value}=markers[0];
  if(kind==='module') {validateModule(value);await readDeployment(directory,value);const files=await collectSourceFiles(directory);if(!files.some(file=>file.path===value.runtime.entry)) throw bad('Module entry is missing');}
  else (kind==='configuration'?validateConfigurationFiles:validateDataFiles)(value,await readResourceFiles(directory));
  return {kind,id:value.id,version:value.version,title:value.title??value.id,path:directory,checked:true,requiresReview:true,startsModules:false,
    ...(kind==='configuration'?{memberCount:value.modules.length,scope:value.scope}:kind==='data'?{memberCount:value.instances.length,scope:value.scope,purpose:value.purpose}:{})};
}
export async function importLocalArtifact({root,path,kind}={}) {
  const source=await ordinaryPath(path);
  if(kind!==undefined&&!['module','configuration','data'].includes(kind)) throw bad('Only module, configuration and data distributions can be imported');
  const zip=source.toLowerCase().endsWith('.zip'),json=source.toLowerCase().endsWith('.json');
  if(!zip&&!json) {const object=await identify(source);if(kind&&object.kind!==kind) throw bad(`Choose a ${kind} distribution`);return {object,startsModules:false};}
  const bytes=await readBounded(source,(json?96:64)*1024*1024);
  let files,prefix='',detected=kind;
  if(json) {const validated=validateArtifactBytes(bytes);detected=validated.artifact.kind;files=validated.decoded.map(file=>({path:file.path,content:file.bytes}));}
  else {
    files=readLocalZip(bytes);
    const markers=files.filter(file=>['module.json','configuration.json','data.json'].includes(file.path.split('/').at(-1)));
    const depth=Math.min(...markers.map(file=>file.path.split('/').length));
    const candidates=markers.filter(file=>file.path.split('/').length===depth);
    if(candidates.length!==1) throw bad('Archive must contain one complete module, configuration or data root');
    detected=candidates[0].path.split('/').at(-1).slice(0,-5);
    prefix=candidates[0].path.slice(0,-candidates[0].path.split('/').at(-1).length);
    if(files.some(file=>prefix&&!file.path.startsWith(prefix))) throw bad('Files outside the distribution root');
    if(detected==='configuration'||detected==='data')(detected==='configuration'?validateConfigurationFiles:validateDataFiles)(JSON.parse(candidates[0].content),files.map(file=>({path:file.path.slice(prefix.length),bytes:file.content})));
  }
  if(!['module','configuration','data'].includes(detected))throw bad('Only module, configuration and data distributions can be imported');
  if(kind&&detected!==kind)throw bad(`Choose a ${kind} distribution`);
  const destination=await ordinaryPath(join(root,'local-artifacts',detected+'-'+hash(bytes).slice(0,12)+'-'+randomUUID()),{allowMissing:true});
  await mkdir(destination,{recursive:true,mode:0o700});
  try {
    for(const file of files) {const local=file.path.slice(prefix.length);relativePath(local);const target=join(destination,local);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,file.content,{flag:'wx',mode:0o600});}
    const object=await identify(destination);if(object.kind!==detected) throw bad('Archive kind differs from import');
    return {object,archive:{path:source,sha256:hash(bytes)},startsModules:false};
  } catch(error) {error.incompleteDestination=destination;throw error;}
}
