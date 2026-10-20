import test from 'node:test';
import assert from 'node:assert/strict';
import { LauncherManager } from '../../../tools/launcher/manager.mjs';

test('module starts and credential updates await the same pending Hub readiness',async()=>{
  const manager=new LauncherManager({root:'.local/not-created-by-race-test'});
  let release;const ready=new Promise(resolve=>{release=resolve;});
  manager.hub={exit:null};manager.busy.set('$default',{kind:'start',state:'running',promise:ready});
  let started=0;manager.defaultHub=()=>{started++;throw Error('Must reuse the pending start');};
  let done=false;const result=manager.localPrograms.getHub({ensure:true}).then(value=>{done=true;return value;});
  await Promise.resolve();assert.equal(done,false);
  manager.hub.url='http://127.0.0.1:12345';release();
  assert.equal((await result).endpoint,'ws://127.0.0.1:12345/bridge');assert.equal(started,0);
  let releaseCredentials;const nextReady=new Promise(resolve=>{releaseCredentials=resolve;});
  let sent=false;const hub=manager.hub;delete hub.url;hub.send=()=>{sent=true;};hub.waitFor=async()=>({ok:true});
  manager.busy.set('$default',{kind:'start',state:'running',promise:nextReady});
  const credentials=manager.updateLocalCredentials({credentials:{'external.test':{token:'test'}},remove:[]},{transient:true,expectedHub:hub});
  await Promise.resolve();assert.equal(sent,false);
  hub.url='http://127.0.0.1:12345';releaseCredentials();assert.equal((await credentials).confirmed,true);assert.equal(sent,true);
});

test('stop admission interrupts a pending Hub consumer before it receives connection details',async()=>{
  const manager=new LauncherManager({root:'.local/not-created-by-race-test'});
  let release;const ready=new Promise(resolve=>{release=resolve;});
  manager.hub={exit:null,url:'http://127.0.0.1:12345'};manager.busy.set('$default',{kind:'start',state:'running',promise:ready});
  const result=manager.localPrograms.getHub({ensure:true});manager.defaultHubStopping=true;release();
  await assert.rejects(result,{code:'LOCAL_HUB_STOPPING'});
});
