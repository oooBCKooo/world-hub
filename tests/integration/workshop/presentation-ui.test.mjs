import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { renderArtifactConfiguration } from '../../../tools/workshop/public/artifact-config-view.mjs';
import { artifactConfiguration } from '../../../tools/workshop/artifact-configuration.mjs';

// Run the real rendering and event handlers with a minimal DOM surface. No
// network, browser globals, or second DOM dependency is needed for these flows.
class Element {
  constructor(tag = '#text', text = '') { this.tag = tag; this.textContent = text; this.children = []; this.attributes = {}; this.listeners = {}; this.classList = { toggle() {} }; this.value = ''; this.files = []; this.disabled = false; }
  setAttribute(name,value) { this.attributes[name] = String(value); if (name === 'value') this.value = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name,fn) { this.listeners[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
const walk = node => [node,...node.children.flatMap(walk)];
const text = node => walk(node).map(node => node.textContent).join('\n');
const find = (node,id) => walk(node).find(node => node.attributes.id === id);
const event = { preventDefault() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));
const source = await readFile(new URL('../../../tools/workshop/public/app.mjs',import.meta.url),'utf8');
function harness(fetcher = () => { throw new Error('Unexpected network access'); }, {previewFetch} = {}) {
  const view = new Element('main'), notice = new Element('div'), language = new Element('select'), account = new Element('span');
  const context = { Node:Element,URL,URLSearchParams,TextDecoder,Uint8Array,atob,btoa,Blob,setTimeout,navigator:{language:'en'},localStorage:{getItem:() => 'en'},location:{hash:'#publish'},
    renderArtifactConfiguration,
    document:{documentElement:{lang:'en'},createElement:tag => new Element(tag),createTextNode:value => new Element('#text',value),querySelector:selector => ({'#view':view,'#notice':notice,'#language':language,'#account-indicator':account}[selector] ?? find(view,selector.slice(1))),querySelectorAll:() => []},fetch:async (url,options) => {
      if (url.pathname.endsWith('/api/artifacts/preview') && previewFetch) return previewFetch(url,options);
      if (url.pathname.endsWith('/api/artifacts/preview')) return {ok:true,json:async () => ({configuration:artifactConfiguration(Buffer.from(JSON.stringify(JSON.parse(options.body).artifact)+'\n'))})};
      return fetcher(url,options);
    } };
  vm.runInNewContext(source.slice(0,source.indexOf("$('#language').addEventListener")).replace(/^import \{ renderArtifactConfiguration \} from [^\r\n]+\r?\n/m,'').replace("const base = new URL('./', import.meta.url);","const base = new URL('https://example.test/workshop/');")+'\nglobalThis.ui={state,renderPublish,renderDetail,presentationInput,presentationEditor,presentationGallery,card,mediaURL,authForm,commentsPanel,proposalsPanel,selectDraftArtifact,validateDraft,loadRoute};',context);
  return {...context.ui,view,notice,context};
}
function asset(char = 'a',extra = {}) { const sha256=char.repeat(64); return {sha256,mimeType:'image/png',size:70,width:20,height:20,url:`/workshop/media/${sha256}.png`,alt:'A useful screenshot',...extra}; }
function publication(extra = {}) { return {entryId:'test.pub',kind:'module',id:'test.example',version:'2.0.0',title:'Example',sha256:'f'.repeat(64),owner:{id:'owner.id',username:'author'},createdAt:'2026-10-18T01:00:00Z',...extra}; }
function detail(p,versions = [p]) { return {publication:p,entry:{license:'MIT',platforms:['win32-x64'],provides:[],requires:[]},comments:[],proposals:[],versions}; }
function imageFile(name = 'safe.png',size = 16,arrayBuffer) { return {name,size,type:'image/png',arrayBuffer:arrayBuffer ?? (async () => new Uint8Array(size).buffer)}; }
function artifactFile() {
  const manifest={format:'world-hub.module/v1',id:'test.example',version:'2.0.0',license:'MIT',platforms:['win32-x64'],runtime:{kind:'node',entry:'program.mjs'},bridges:['main'],provides:[],requires:[],permissions:{filesystem:'instance-state',network:['hub-loopback'],processes:'none'}};
  const file=(path,content) => { const bytes=Buffer.from(content); return {path,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}; };
  const artifact={format:'world-hub.source-artifact/v1',kind:'module',id:manifest.id,version:manifest.version,files:[file('module.json',JSON.stringify(manifest)),file('program.mjs','// source, never executed\n')],provenance:{redistributionAcknowledged:true}};
  return {size:400,name:'artifact.json',text:async () => JSON.stringify(artifact)};
}

test('single publication explains absent history; old selection keeps its exact artifact and metadata', () => {
  const ui=harness(), current=publication(); ui.state.detail=detail(current); ui.renderDetail();
  assert.match(text(ui.view),/Version history/); assert.match(text(ui.view),/Only this version has been published/);
  assert.equal(find(ui.view,'publication-version').children.length,1);
  const old=publication({entryId:'test.old',version:'1.0.0',sha256:'e'.repeat(64),createdAt:'2025-01-01T00:00:00Z'});
  ui.state.detail=detail(old,[current,old]); ui.renderDetail();
  const picker=find(ui.view,'publication-version'); assert.equal(picker.value,'test.old');
  assert.match(text(ui.view),/Selected: 1.0.0/);
  assert.equal(find(ui.view,'artifact-download').attributes.href,`https://example.test/workshop/artifacts/${old.sha256}.json`);
  assert.equal(find(ui.view,'artifact-download').attributes.download,'test.example-1.0.0.module.artifact.json');
  assert.match(text(ui.view),/Jan 1, 2025/);
  picker.value='test.pub'; picker.listeners.change(); assert.equal(ui.context.location.hash,'#publication/test.pub');
  ui.state.language='zh'; ui.renderDetail(); assert.match(text(ui.view),/版本历史/); assert.match(text(ui.view),/当前选择：1.0.0/);
});

test('cards and galleries show safe images and plain descriptions; arbitrary URLs never become image sources', () => {
  const ui=harness(), malicious='<img src=x onerror=alert(1)>', safe=asset('a',{alt:malicious});
  const p=publication({presentation:{icon:safe,cover:asset('b'),screenshots:[safe,asset('c',{url:'https://attacker.test/track.png'})]}});
  const card=ui.card({...p,versionCount:3}); assert.match(text(card),/View 3 versions/);
  assert.equal(walk(card).filter(node => node.tag === 'img').length,2);
  const gallery=ui.presentationGallery(p), images=walk(gallery).filter(node => node.tag === 'img');
  assert.equal(images.length,2); assert.equal(images[1].attributes.alt,malicious); assert.match(text(gallery),/<img src=x onerror=alert\(1\)>/);
  for (const node of walk(gallery).filter(node => node.tag === 'a')) { assert.match(node.attributes.href,/^https:\/\/example.test\/workshop\/media\/[a-f0-9]{64}\.png$/); assert.equal(node.attributes.rel,'noopener noreferrer'); assert.ok(node.attributes['aria-label']); }
  assert.equal(ui.mediaURL(asset('a',{url:'javascript:alert(1)'})),null);
  assert.equal(ui.mediaURL(asset('a',{sha256:'../private',url:'/workshop/media/../private.png'})),null);
  assert.equal(ui.presentationGallery(publication()),null);
  assert.equal(walk(ui.card(publication())).some(node => node.tag === 'img'),false);
});

test('image input ignores stale reads, supports removal and alt descriptions, and blocks invalid choices', async () => {
  const ui=harness(); let changes=0; const media=ui.presentationInput('test-media',() => ++changes);
  const icon=find(media.node,'test-media-icon'); let finishOld;
  icon.files=[imageFile('old.png',16,() => new Promise(resolve => { finishOld=resolve; }))];
  const oldRead=icon.listeners.change(); assert.equal(media.ready(),false);
  icon.files=[imageFile('new.png',24)]; await icon.listeners.change(); assert.equal(media.ready(),true);
  assert.equal(media.value().icon.base64,Buffer.alloc(24).toString('base64'));
  finishOld(new Uint8Array(16).buffer); await oldRead; assert.equal(media.value().icon.base64,Buffer.alloc(24).toString('base64'));
  const alt=walk(media.node).find(node => node.attributes['data-media-alt']==='icon-0'); alt.value='<b>Plain description</b>'; alt.listeners.input(); assert.equal(media.value().icon.alt,alt.value);
  walk(media.node).find(node => node.tag==='button').listeners.click(); assert.equal(media.value().icon,undefined);
  icon.files=[{...imageFile(),type:'image/svg+xml'}]; await icon.listeners.change(); assert.equal(media.ready(),false); assert.match(text(ui.notice),/could not be read/);
  const remove=walk(media.node).filter(node => node.tag==='button')[0]; remove.listeners.click(); assert.equal(media.ready(),true);
  const screenshots=find(media.node,'test-media-screenshots'); screenshots.files=Array.from({length:7},() => imageFile()); await screenshots.listeners.change(); assert.equal(media.ready(),false); assert.match(text(ui.notice),/no more than 6/); assert.ok(changes>=5);
});

test('combined upload size blocks submission and retains existing descriptors by digest', async () => {
  const ui=harness(), media=ui.presentationInput('limit-media',() => {},{icon:asset('a')});
  assert.equal(media.value().icon.sha256,'a'.repeat(64)); assert.equal(media.value().icon.base64,undefined);
  const screenshots=find(media.node,'limit-media-screenshots'); screenshots.files=Array.from({length:6},() => imageFile('one.png',1024*1024)); await screenshots.listeners.change();
  assert.equal(media.ready(),false); assert.match(text(media.node),/5 MiB combined/);
  const screenshotsRemove=walk(media.node).filter(node => node.tag==='button').at(-1); screenshotsRemove.listeners.click(); assert.equal(media.ready(),true);
});

test('publish requires finished media and keeps button disabled during an in-flight publication', async () => {
  const calls=[]; let finishPublish;
  const ui=harness(async (url,options) => { calls.push({url:url.href,body:JSON.parse(options.body)}); return new Promise(resolve => { finishPublish=resolve; }); });
  ui.state.user={id:'owner.id',role:'member'}; ui.renderPublish();
  const upload=find(ui.view,'artifact-file'); upload.files=[artifactFile()]; await upload.listeners.change();
  const ack=find(ui.view,'redistribution-ack'); ack.checked=true; ack.listeners.change();
  const submit=find(ui.view,'publish-submit'); assert.equal(submit.disabled,false);
  const icon=find(ui.view,'publication-images-icon'); let finishImage;
  icon.files=[imageFile('wait.png',16,() => new Promise(resolve => { finishImage=resolve; }))]; const reading=icon.listeners.change(); assert.equal(submit.disabled,true);
  find(ui.view,'publication-form').listeners.submit(event); assert.equal(calls.length,0);
  finishImage(new Uint8Array(16).buffer); await reading; assert.equal(submit.disabled,false);
  find(ui.view,'publication-form').listeners.submit(event); assert.equal(submit.disabled,true); assert.equal(calls.length,1); assert.equal(calls[0].body.presentation.icon.mimeType,'image/png');
  ack.listeners.change(); assert.equal(submit.disabled,true);
  finishPublish({ok:true,json:async () => ({publication:{entryId:'created.pub'}})}); await flush();
  assert.equal(ui.context.location.hash,'#publication/created.pub'); assert.equal(submit.disabled,true,'the published artifact cannot be accidentally re-submitted');
});

test('only owner/admin gets picture editor; editing preserves references and artifact identity', async () => {
  const calls=[], p=publication({presentation:{icon:asset()}});
  const ui=harness(async (url,options) => { calls.push({url:url.href,body:options.body && JSON.parse(options.body)}); return {ok:true,json:async () => ({publication:p})}; });
  ui.state.user={id:'someone.else',role:'member'}; assert.equal(ui.presentationEditor(p),null);
  ui.state.user={id:'owner.id',role:'member'}; const editor=ui.presentationEditor(p);
  const form=find(editor,'presentation-form'); form.listeners.submit(event); await flush();
  assert.equal(calls[0].url,'https://example.test/workshop/api/publications/test.pub/presentation');
  assert.deepEqual(calls[0].body,{presentation:{icon:{sha256:'a'.repeat(64),alt:'A useful screenshot'}}});
  assert.equal(calls[0].body.artifact,undefined); assert.equal(calls[0].body.version,undefined);
});

test('publication keeps its reviewed artifact, edited title and images across language and account navigation without persistence', async () => {
  const ui=harness(); ui.state.user={id:'owner.id',role:'member'}; ui.renderPublish();
  const upload=find(ui.view,'artifact-file'); upload.files=[artifactFile()]; await upload.listeners.change();
  assert.ok(ui.state.publicationDraft.configuration); assert.match(text(ui.view),/Resident/);
  const title=walk(ui.view).find(node => node.attributes.name==='title'); title.value='My own title'; title.listeners.input();
  const image=find(ui.view,'publication-images-icon'); image.files=[imageFile()]; await image.listeners.change();
  const ack=find(ui.view,'redistribution-ack'); ack.checked=true; ack.listeners.change();
  const digest=ui.state.publicationDraft.configuration.sha256;
  ui.context.location.hash='#account'; ui.state.language='zh'; ui.renderPublish();
  assert.equal(walk(ui.view).find(node => node.attributes.name==='title').value,'My own title');
  assert.equal(find(ui.view,'artifact-file').required,false); assert.equal(find(ui.view,'redistribution-ack').checked,true);
  assert.match(text(ui.view),/常驻/); assert.equal(ui.state.publicationDraft.configuration.sha256,digest);
  assert.equal(walk(ui.view).filter(node => node.tag==='img').length,1);
  assert.equal(find(ui.view,'publish-submit').disabled,false);
  assert.equal(ui.context.localStorage.setItem,undefined,'draft handlers cannot write files or credentials to storage');
});

test('a new artifact invalidates review and consent, while a stale validation response cannot replace the new draft', async () => {
  const pending=[];
  const ui=harness(undefined,{previewFetch:async (_url,options) => new Promise(resolve => pending.push({body:JSON.parse(options.body),resolve}))});
  ui.state.user={id:'owner.id',role:'member'}; ui.renderPublish();
  const file=artifactFile(), first=ui.selectDraftArtifact(ui.state.publicationDraft,file); await flush(); assert.equal(pending.length,1);
  ui.state.language='zh'; ui.renderPublish();
  const next=JSON.parse(await file.text()); next.version='2.0.1'; const marker=next.files.find(row => row.path==='module.json'); const manifest=JSON.parse(Buffer.from(marker.base64,'base64')); manifest.version=next.version; const bytes=Buffer.from(JSON.stringify(manifest)); marker.base64=bytes.toString('base64'); marker.sha256=createHash('sha256').update(bytes).digest('hex');
  const second=ui.selectDraftArtifact(ui.state.publicationDraft,{...file,name:'next.json',text:async()=>JSON.stringify(next)}); await flush();
  assert.equal(ui.state.publicationDraft.configuration,null); assert.equal(find(ui.view,'redistribution-ack').checked,false); assert.equal(find(ui.view,'publish-submit').disabled,true);
  const response=item=>({ok:true,json:async()=>({configuration:artifactConfiguration(Buffer.from(JSON.stringify(item.body.artifact)+'\n'))})});
  pending[1].resolve(response(pending[1])); await second;
  const expected=ui.state.publicationDraft.configuration.sha256;
  pending[0].resolve(response(pending[0])); await first;
  assert.equal(ui.state.publicationDraft.configuration.version,'2.0.1'); assert.equal(ui.state.publicationDraft.configuration.sha256,expected);
  assert.match(text(ui.view),/next.json/); assert.equal(find(ui.view,'redistribution-ack').checked,false);
});

test('login submission is locked synchronously, clears passwords, and returns to the saved work only if the user stayed', async () => {
  const calls=[]; let finish;
  const ui=harness(async(url,options)=>{calls.push(url.pathname); return new Promise(resolve=>{finish=resolve;});});
  ui.context.location.hash='#account'; ui.state.returnTo='#publish';
  const form=ui.authForm('login'), username=find(form,'login-username'), password=find(form,'login-password'); username.value='test.user'; password.value='Local test password';
  form.listeners.submit(event); form.listeners.submit(event); assert.equal(calls.length,1); assert.equal(ui.state.authBusy,true);
  finish({ok:true,json:async()=>({user:{id:'owner.id',username:'test.user',role:'member'},csrfToken:'local-test'})}); await flush();
  assert.equal(ui.context.location.hash,'#publish'); assert.equal(password.value,''); assert.equal(ui.state.returnTo,null); assert.equal(ui.state.authBusy,false);
  ui.context.location.hash='#account'; ui.state.returnTo='#publish'; const next=ui.authForm('login'); find(next,'login-password').value='Other local test password'; next.listeners.submit(event); ui.context.location.hash='#catalog';
  finish({ok:true,json:async()=>({user:{id:'owner.id',username:'test.user',role:'member'},csrfToken:'local-test'})}); await flush();
  assert.equal(ui.context.location.hash,'#catalog','a late sign-in does not steal newer navigation');
});

test('an in-flight publication cannot be duplicated by submit events and does not redirect a user who left', async () => {
  let finish; const calls=[];
  const ui=harness(async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Promise(resolve=>{finish=resolve;});});
  ui.state.user={id:'owner.id',role:'member'}; ui.renderPublish(); const file=find(ui.view,'artifact-file'); file.files=[artifactFile()]; await file.listeners.change();
  const ack=find(ui.view,'redistribution-ack'); ack.checked=true; ack.listeners.change(); const form=find(ui.view,'publication-form');
  form.listeners.submit(event); form.listeners.submit(event); ack.listeners.change(); form.listeners.submit(event); assert.equal(calls.length,1);
  ui.context.location.hash='#catalog'; finish({ok:true,json:async()=>({publication:{entryId:'created.pub'}})}); await flush();
  assert.equal(ui.context.location.hash,'#catalog'); assert.equal(ui.state.publicationDraft.preview,null);
});

test('detail renders configuration only for the selected artifact digest', async () => {
  const ui=harness(), config=artifactConfiguration(JSON.parse(await artifactFile().text()));
  const p=publication({sha256:config.sha256}); ui.state.detail={...detail(p),configuration:config}; ui.renderDetail();
  assert.match(text(ui.view),/Resident/); assert.equal(walk(ui.view).find(node=>node.attributes['data-artifact-sha256']).attributes['data-artifact-sha256'],p.sha256);
  ui.state.detail.publication={...p,version:'1.0.0',sha256:'b'.repeat(64)}; ui.renderDetail();
  assert.doesNotMatch(text(ui.view),/Resident/); assert.match(text(ui.view),/has not been loaded/);
});

test('publication and proposal previews can retry a busy server without selecting the artifact again', async () => {
  for (const kind of ['publication','proposal']) {
    let attempts = 0;
    const ui = harness(undefined,{previewFetch:async (_url,options) => {
      if (++attempts === 1) return {ok:false,status:503,json:async () => ({error:{code:'UPLOAD_BUSY',message:'Retry shortly.'}})};
      return {ok:true,json:async () => ({configuration:artifactConfiguration(Buffer.from(JSON.stringify(JSON.parse(options.body).artifact)+'\n'))})};
    }});
    ui.state.user = {id:'owner.id',role:'member'};
    if (kind === 'publication') ui.renderPublish();
    else ui.view.append(ui.proposalsPanel(detail(publication())));
    const upload = find(ui.view,kind === 'publication' ? 'artifact-file' : 'proposal-file');
    upload.files = [artifactFile()]; await upload.listeners.change();
    assert.match(text(ui.view),/UPLOAD_BUSY/);
    const submit = find(ui.view,kind === 'publication' ? 'publish-submit' : 'proposal-submit'); assert.equal(submit.disabled,true);
    const retry = walk(ui.view).find(node => node.tag === 'button' && node.textContent === 'Validate again');
    assert.ok(retry); assert.equal(retry.hidden,false); await retry.listeners.click(); await flush();
    assert.equal(attempts,2); assert.equal(retry.hidden,true); assert.match(text(ui.view),/Resident/);
    const ack = find(ui.view,kind === 'publication' ? 'redistribution-ack' : 'proposal-ack'); ack.checked = true; ack.listeners.change();
    assert.equal(submit.disabled,false);
  }
});
