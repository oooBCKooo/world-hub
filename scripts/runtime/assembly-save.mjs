// Persist a reviewed run composition as the next baseline. Hub never reads it.
import {lstat,mkdir,readdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {inspectPackage,copyPackage,safeId} from './package.mjs';
import {withStoppedInstance} from './maintenance.mjs';
import {ordinaryPath,privateJson,readBounded,hash} from './paths.mjs';
import {compareCompositionVersions} from './authoring-update.mjs';

const fault=(code,message)=>Object.assign(new Error(message),{code});
const json=async path=>JSON.parse((await readBounded(path,4*1024*1024)).toString());
const exists=async path=>{try{await lstat(path);return true;}catch(issue){if(issue.code==='ENOENT')return false;throw issue;}};
const check=options=>{if(options.signal?.aborted)throw fault('ASSEMBLY_SAVE_CANCELLED','Assembly save cancelled.');};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function assertNoIncompleteAssemblySaves(directory){
  const root=join(directory,'assembly-saves');if(!await exists(root))return;
  await ordinaryPath(root);
  const entries=await readdir(root,{withFileTypes:true});
  if(entries.length>1024)throw fault('ASSEMBLY_SAVE_RECOVERY_REQUIRED','Assembly save history exceeds its bound; inspect retained transactions.');
  for(const entry of entries){
    if(!entry.isDirectory()||!UUID.test(entry.name))throw fault('ASSEMBLY_SAVE_RECOVERY_REQUIRED','Unexpected assembly save history; retain it for inspection.');
    const record=await json(join(root,entry.name,'transaction.json'));
    if(record.format!=='world-hub.assembly-save/v1'||record.transactionId!==entry.name||!['committed','rolled-back'].includes(record.state))
      throw fault('ASSEMBLY_SAVE_RECOVERY_REQUIRED','An incomplete assembly save needs recovery before starting or saving another version.');
  }
}

// Hash opaque state without interpreting any application's files. This bounds
// review work and detects out-of-process writes after the stopped review.
async function inventory(root,options){
  if(!await exists(root))return {directories:[],digest:hash('absent'),files:0,bytes:0};
  const records=[],top=[],seen=new Set();let count=0,bytes=0;
  const visit=async(directory,prefix='')=>{
    check(options);await ordinaryPath(directory);
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      const path=prefix?prefix+'/'+entry.name:entry.name;
      if(++count>32768||seen.has(path.toLowerCase()))throw fault('ASSEMBLY_SAVE_STATE_LIMIT','State tree is too large or contains case-colliding names.');
      seen.add(path.toLowerCase());const full=join(directory,entry.name);await ordinaryPath(full);const stat=await lstat(full);
      if(stat.isSymbolicLink())throw fault('ASSEMBLY_SAVE_STATE_PATH','State links and reparse points are not moved by assembly saves.');
      if(!prefix){safeId(entry.name);if(!stat.isDirectory())throw fault('ASSEMBLY_SAVE_STATE_PATH','Program state roots must be ordinary directories.');top.push(entry.name);}
      if(stat.isDirectory()){records.push({path,directory:true});await visit(full,path);}
      else if(stat.isFile()){
        if(stat.size>256*1024*1024||(bytes+=stat.size)>512*1024*1024)throw fault('ASSEMBLY_SAVE_STATE_LIMIT','Assembly state review exceeds its file or total size bound.');
        const data=await readBounded(full,256*1024*1024);const end=await lstat(full);
        if(data.length!==stat.size||end.size!==stat.size||end.mtimeMs!==stat.mtimeMs||end.ctimeMs!==stat.ctimeMs)throw fault('ASSEMBLY_SAVE_CHANGED','Program state changed during review.');
        records.push({path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
      }else throw fault('ASSEMBLY_SAVE_STATE_PATH','State contains a special filesystem entry.');
    }
  };
  await visit(root);return {directories:top.sort(),digest:hash(JSON.stringify(records)),files:records.filter(row=>!row.directory).length,bytes};
}

function policiesFor(pack,state,supplied){
  const ids=[...new Set([...pack.components.map(c=>c.id),...state.directories])].sort();
  if(!Array.isArray(supplied)||supplied.length!==ids.length||new Set(supplied.map(row=>row?.componentId)).size!==ids.length)
    throw fault('ASSEMBLY_SAVE_POLICY_REQUIRED','Choose an explicit state policy for each retained/new component and each removed state directory.');
  return ids.map(id=>{
    const row=supplied.find(policy=>policy?.componentId===id),present=state.directories.includes(id),selected=pack.components.some(c=>c.id===id);
    if(!row||Object.keys(row).some(key=>!['componentId','mode','dataFormat'].includes(key)))throw fault('ASSEMBLY_SAVE_POLICY_REQUIRED','Unsupported state policy fields.');
    if(selected&&present){
      if(row.mode!=='preserve'||typeof row.dataFormat!=='string'||!row.dataFormat.trim()||row.dataFormat.length>128||/[\x00-\x1f]/.test(row.dataFormat))
        throw fault('ASSEMBLY_SAVE_POLICY_REQUIRED','Existing program data needs its provider-defined format declaration and an explicit preserve choice.');
    }else if(row.mode!==(selected?'fresh':'retain-removed')||Object.hasOwn(row,'dataFormat'))
      throw fault('ASSEMBLY_SAVE_POLICY_REQUIRED','Use fresh for absent new state and retain-removed for archived program data.');
    return structuredClone(row);
  });
}

async function plan(directory,stopped,options){
  await assertNoIncompleteAssemblySaves(directory);check(options);
  const origin=options.origin;
  if(!origin||Object.keys(origin).some(key=>!['runId','revision','baselineDigest','targetInstanceId'].includes(key))||typeof origin.runId!=='string'||!Number.isSafeInteger(origin.revision)||origin.revision<0
      ||stopped.status?.runId!==origin.runId||stopped.status?.assembly?.revision!==origin.revision
      ||origin.targetInstanceId!==undefined&&origin.targetInstanceId!==options.instanceId)
    throw fault('ASSEMBLY_SAVE_STALE','The stopped run or its composition differs from the source snapshot.');
  if(await exists(join(directory,'detached.json')))throw fault('INSTANCE_DETACHED','Reattach the instance before saving its runtime composition.');
  const before=await inspectPackage(join(directory,'package'),options),candidate=await inspectPackage(options.candidate,options);
  if(stopped.identity.digest!==before.digest||origin.baselineDigest!==before.digest||stopped.identity.hubVersion!==candidate.hubVersion)
    throw fault('ASSEMBLY_SAVE_BASE_CHANGED','Instance source or installed environment changed after the runtime snapshot.');
  if(before.pack.id!==candidate.pack.id||compareCompositionVersions(candidate.pack.version,before.pack.version)<=0)
    throw fault('ASSEMBLY_SAVE_VERSION_REQUIRED','Retain the composition ID and choose a strictly higher version.');
  const state=await inventory(join(directory,'programs'),options),statePolicies=options.opaque===true
    ? [...new Set([...candidate.pack.components.map(component=>component.id),...state.directories])].sort().map(componentId=>({componentId,
      mode:candidate.pack.components.some(component=>component.id===componentId)?state.directories.includes(componentId)?'preserve-opaque':'fresh':'retain-removed'}))
    : policiesFor(candidate.pack,state,options.statePolicies);
  const signature={instanceId:options.instanceId,origin,identity:stopped.identity,before:before.digest,candidate:candidate.digest,state,statePolicies};
  return {format:'world-hub.assembly-save-review/v1',digest:hash(JSON.stringify(signature)),beforeVersion:before.pack.version,afterVersion:candidate.pack.version,
    origin:structuredClone(origin),candidateDigest:candidate.digest,statePolicies,retained:statePolicies.filter(row=>['preserve','preserve-opaque'].includes(row.mode)).map(row=>row.componentId),
    fresh:statePolicies.filter(row=>row.mode==='fresh').map(row=>row.componentId),archived:statePolicies.filter(row=>row.mode==='retain-removed').map(row=>row.componentId),
    state:{files:state.files,bytes:state.bytes,digest:state.digest},requiresNewExecutionReview:true,startsModules:false,_candidate:candidate};
}
export async function previewAssemblySave(options){
  return withStoppedInstance(options,async(directory,stopped)=>{const {_candidate,...review}=await plan(directory,stopped,options);return review;});
}
// Used by the full upgrade snapshot transaction while it already owns the
// stopped-instance lock. It retains the exact origin and state-policy checks.
export async function inspectStoppedAssemblySave(directory,stopped,options){
  const {_candidate,...review}=await plan(directory,stopped,options);return review;
}
export async function applyAssemblySave(options){
  if(options.accepted!==true||!/^[a-f0-9]{64}$/.test(options.expectedDigest??''))throw fault('ASSEMBLY_SAVE_REVIEW_REQUIRED','Review and accept the exact stopped composition and provider state policies.');
  return withStoppedInstance(options,async(directory,stopped)=>{
    const review=await plan(directory,stopped,options);
    if(review.digest!==options.expectedDigest)throw fault('ASSEMBLY_SAVE_CHANGED','The candidate, program data or stopped run changed after review.');
    const transactionId=randomUUID(),transaction=join(directory,'assembly-saves',transactionId),previous=join(transaction,'previous'),stage=join(transaction,'stage');
    await ordinaryPath(transaction,{allowMissing:true});await mkdir(stage,{recursive:true,mode:0o700});await mkdir(join(previous,'programs'),{recursive:true,mode:0o700});
    const journal={format:'world-hub.assembly-save/v1',transactionId,instanceId:options.instanceId,state:'preparing',createdAt:new Date().toISOString(),
      identity:stopped.identity,reviewDigest:review.digest,candidateDigest:review.candidateDigest,archived:review.archived,steps:[]};
    const record=()=>privateJson(join(transaction,'transaction.json'),journal);
    let installed=false,moved=false,identityWritten=false,nextIdentity;const archived=[];
    try{
      await record();
      await copyPackage(review._candidate,join(stage,'package'));
      const staged=await inspectPackage(join(stage,'package'),options);if(staged.digest!==review.candidateDigest)throw fault('ASSEMBLY_SAVE_CHANGED','Staged source changed.');
      const fresh=await planWithoutHistory(directory,stopped,options,review);
      if(fresh!==review.state.digest)throw fault('ASSEMBLY_SAVE_CHANGED','Program data changed while staging this save.');
      check(options);journal.state='committing';await record();
      await privateJson(join(previous,'instance.json'),stopped.identity,{exclusive:true});
      await rename(join(directory,'package'),join(previous,'package'));moved=true;journal.steps.push('previous-package');await record();
      for(const id of review.archived){await rename(join(directory,'programs',id),join(previous,'programs',id));archived.push(id);journal.steps.push('archive:'+id);await record();}
      await rename(join(stage,'package'),join(directory,'package'));installed=true;journal.steps.push('next-package');await record();
      nextIdentity={...stopped.identity,digest:staged.digest,hubVersion:staged.hubVersion,assemblySavedAt:new Date().toISOString(),assemblyTransactionId:transactionId};
      await privateJson(join(directory,'instance.json'),nextIdentity);identityWritten=true;journal.steps.push('next-identity');
      const installedPlan=await inspectPackage(join(directory,'package'),options);
      if(installedPlan.digest!==review.candidateDigest)throw fault('ASSEMBLY_SAVE_CHANGED','Installed source changed before commit.');
      journal.state='committed';journal.committedAt=new Date().toISOString();await record();
      return {instanceId:options.instanceId,pack:{id:installedPlan.pack.id,version:installedPlan.pack.version,title:installedPlan.pack.title},plan:installedPlan,transactionId,
        previousDirectory:previous,archived:review.archived,requiresNewExecutionReview:true,startsModules:false};
    }catch(issue){
      const failures=[];const attempt=async task=>{try{await task();}catch(error){failures.push({code:error.code,message:error.message});}};
      if(installed)await attempt(()=>rename(join(directory,'package'),join(stage,'retained-next-package')));
      for(const id of [...archived].reverse())await attempt(()=>rename(join(previous,'programs',id),join(directory,'programs',id)));
      if(moved)await attempt(()=>rename(join(previous,'package'),join(directory,'package')));
      if(identityWritten)await attempt(async()=>{
        const current=await json(join(directory,'instance.json'));
        if(JSON.stringify(current)!==JSON.stringify(nextIdentity))throw fault('ASSEMBLY_SAVE_RECOVERY_REQUIRED','Instance identity no longer belongs to this save; retain it for recovery.');
        await privateJson(join(directory,'instance.json'),stopped.identity);
      });
      journal.state=failures.length?'recovery-required':'rolled-back';journal.failures=failures;await attempt(record);
      if(failures.length){issue.retainMaintenanceOwner=true;issue.cleanupIncomplete=true;issue.rollbackError=failures[0];}
      issue.previousDirectory=previous;issue.incompleteDestination=transaction;throw issue;
    }
  });
}
// The current transaction is intentionally nonterminal during the final state
// check, so do not recursively validate history here.
async function planWithoutHistory(directory,stopped,options,review){
  const identity=await json(join(directory,'instance.json')),status=await json(join(directory,'status.json'));
  if(JSON.stringify(identity)!==JSON.stringify(stopped.identity)||JSON.stringify(status)!==JSON.stringify(stopped.status))
    throw fault('ASSEMBLY_SAVE_CHANGED','Instance identity or stopped status changed while staging the save.');
  const before=await inspectPackage(join(directory,'package'),options),candidate=await inspectPackage(options.candidate,options);
  if(before.digest!==stopped.identity.digest||candidate.digest!==review.candidateDigest)throw fault('ASSEMBLY_SAVE_CHANGED','Source changed during the save.');
  return (await inventory(join(directory,'programs'),options)).digest;
}
