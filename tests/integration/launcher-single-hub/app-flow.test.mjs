// Executes the real app handlers against real HTTP, using an inert DOM model.
// This verifies interactions and request contracts, not browser rendering/CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Element } from './ui-dom.mjs';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';
import { workspace, ROOT, until } from '../launcher/helpers.mjs';

test('actual app handlers import, register, group, configure and selectively run modules through one authenticated Hub', {timeout:60000},async t=>{
  const app=await workspace(t),server=await createLauncherServer({root:app.root});app.cleanups.push(()=>server.close());
  const saved=new Map(),set=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});};
  const timers=[],intervals=[],nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout,nativeInterval=globalThis.setInterval;
  let doc;
  class Dom extends Element {
    append(...children){for(const child of children)if(child instanceof Element&&child.parent)child.remove();super.append(...children);}
    insertBefore(child,next){if(child.parent)child.remove();super.insertBefore(child,next);}
    getAttribute(key){return this.attributes[key]??null;}
    hasAttribute(key){return key in this.attributes;}
    removeAttribute(key){delete this.attributes[key];}
    get classList(){return {add:(...names)=>{this.className=[...new Set([...(this.className??'').split(' '),...names])].join(' ');},remove:(...names)=>{this.className=(this.className??'').split(' ').filter(name=>!names.includes(name)).join(' ');},toggle:(name,on)=>{const exists=(this.className??'').split(' ').includes(name);if(on??!exists)this.classList.add(name);else this.classList.remove(name);}};}
    get isConnected(){return doc?.body.contains(this);}
    get offsetParent(){return this.isConnected?doc.body:null;}
    get selectedOptions(){return this.options.filter(option=>option.selected);}
  }
  const storage=()=>{const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};};
  const body=new Dom('body');body.setAttribute('id','single-hub-app');const html=new Dom('html');html.append(body);
  doc={body,documentElement:html,hidden:false,activeElement:null,createElement:tag=>new Dom(tag),createElementNS:(_,tag)=>new Dom(tag),createTextNode:text=>new Dom('#text',text),querySelector:selector=>body.matches(selector)?body:body.querySelector(selector),querySelectorAll:selector=>body.querySelectorAll(selector)};
  const sidebar=new Dom('aside');sidebar.className='sidebar';body.append(sidebar);
  for(const id of ['refresh','language','theme','sidebar-menu-toggle','tasks','workspace-label','local-description','connection-state','navigation','version','breadcrumb','connection-notice','hub-bar','view-content','toast','topbar-stats']){
    const node=new Dom(id==='language'?'select':['refresh','theme','sidebar-menu-toggle','tasks'].includes(id)?'button':'div');node.setAttribute('id',id);(id==='navigation'?sidebar:body).append(node);
  }
  set('document',doc);set('Node',Element);set('navigator',{language:'en'});set('localStorage',storage());set('sessionStorage',storage());
  const location=new URL(server.launchUrl);set('location',location);set('history',{pushState:(_,__,url)=>{location.href=new URL(url,location).href;},replaceState:(_,__,url)=>{location.href=new URL(url,location).href;}});
  set('window',{addEventListener(){}});set('MutationObserver',class{observe(){}disconnect(){}});
  set('fetch',(url,options={})=>nativeFetch(new URL(url,server.url),{...options,headers:{...options.headers,origin:new URL(server.url).origin}}));
  set('setTimeout',(callback,ms,...args)=>{const timer=nativeTimeout(callback,ms,...args);timer.unref?.();timers.push(timer);return timer;});
  set('setInterval',(callback,ms,...args)=>{const timer=nativeInterval(callback,ms,...args);timer.unref?.();intervals.push(timer);return timer;});
  t.after(()=>{for(const timer of timers)clearTimeout(timer);for(const timer of intervals)clearInterval(timer);for(const [key,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const buttons=(root,label)=>root.querySelectorAll('button').filter(node=>node.textContent.trim()===label);
  const click=async(root,label)=>{const candidates=buttons(root,label);assert.equal(candidates.length,1,`${label}: ${root.textContent.slice(-1200)}`);assert.notEqual(candidates[0].disabled,true,label);await candidates[0].dispatch('click');};
  const active=()=>body.querySelectorAll('dialog').filter(node=>node.open).at(-1);
  const wait=async(condition,label)=>until(()=>{const failure=body.querySelectorAll('dialog').find(node=>node.open&&node.getAttribute('aria-label')==='Operation did not complete');assert.equal(failure,undefined,failure?.textContent);return condition();},{timeoutMs:15000,label});
  const ready=label=>wait(()=>doc.querySelector('#view-content').textContent.includes(label),label);
  const approve=async()=>{const node=active();assert.ok(node);const box=node.querySelector('[name=accepted]');box.checked=true;await box.dispatch('change');await click(node,'Apply this review');await wait(()=>!node.open,'review applied');};
  await import('../../../tools/launcher/public/app.mjs?full-app-contract');
  await wait(()=>doc.querySelector('#connection-state').textContent==='Local session connected','authenticated boot');
  await ready('Connected Modules');await click(doc.querySelector('#view-content'),'Connect local module');
  active().querySelector('[name=artifactPath]').value=join(ROOT,'examples/ecosystem-pack/modules/source');await click(active(),'Check & connect');
  await wait(()=>active()?.getAttribute('aria-label')==='Register an independent module instance','registration form');
  const registration=active();assert.equal(registration.querySelectorAll('textarea').length,1,'defaults are editable without JSON');
  registration.querySelector('[name=programId]').value='model-source';
  await click(registration,'Review registration');await wait(()=>active()!==registration,'registration review');await approve();
  await ready('Connected Modules');assert.equal(server.manager.localPrograms.records.size,1);assert.equal(server.manager.hub,null);
  await click(doc.querySelector('#view-content').querySelector('.sh-page-heading'),'New module group');
  const groupForm=active();groupForm.querySelector('[name=groupId]').value='model-group';groupForm.querySelector('[name=groupTitle]').value='Model group';
  const member=groupForm.querySelector('[name=model-source]');member.checked=true;await member.dispatch('change');await click(groupForm,'Save references');await ready('Model group');
  await click(doc.querySelector('#view-content'),'Startup plan');const planCheck=()=>body.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='Start with plan model-source');await wait(planCheck,'plan editor');
  const enabled=planCheck();enabled.checked=true;await enabled.dispatch('change');await click(doc.querySelector('#view-content'),'Save plan');
  await wait(()=>server.manager.localPrograms.groups.get('model-group').startupPlan.members[0].enabled,'saved plan');
  assert.equal(server.manager.hub,null,'editing a group plan is offline');
  await click(doc.querySelector('#navigation'),'Connected Modules');await click(doc.querySelector('#view-content'),'Configure & wire');
  const setting=body.querySelector('[name=setting-text]');assert.ok(setting,'author settings render as plain fields');setting.value='Edited through real app handlers';await setting.dispatch('input');
  await click(doc.querySelector('#view-content'),'Review and save this instance');await wait(()=>active()?.getAttribute('aria-label')==='Review module configuration','config review');await approve();
  assert.equal(server.manager.localPrograms.row('model-source').settings.text,'Edited through real app handlers');assert.equal(server.manager.hub,null);
  await click(doc.querySelector('#hub-bar'),'Start Hub');await wait(()=>server.manager.hub?.url,'Hub ready');
  await click(doc.querySelector('#navigation'),'Connected Modules');await ready('Model group');await click(doc.querySelector('#view-content'),'Review & start');await wait(()=>active()?.getAttribute('aria-label')==='Model group · Startup plan','group start review');await approve();
  assert.equal(server.manager.localPrograms.row('model-source').state,'running');assert.equal((await server.manager.hubs()).length,1);
  await click(doc.querySelector('#view-content'),'Stop group…');await wait(()=>active()?.getAttribute('aria-label')==='Review stopping module group','stop group review');await approve();
  assert.equal(server.manager.localPrograms.row('model-source').state,'stopped');assert.ok(server.manager.hub&&!server.manager.hub.exit);
  const language=doc.querySelector('#language');language.value='zh';await language.dispatch('change');assert.ok(doc.querySelector('#navigation').textContent.includes('已接入模块'));
  app.record('inert-dom-with-real-http-flow',{imports:1,registered:1,groups:1,directConfiguration:true,sharedHub:true,selectiveStop:true,bilingual:true,browserRendering:false});
});
