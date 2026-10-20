import test from 'node:test';
import assert from 'node:assert/strict';
import { renderArtifactConfiguration } from '../../../tools/workshop/public/artifact-config-view.mjs';

// A small DOM checks the real component without introducing a browser runtime
// or a second implementation of its configuration interpretation.
class Element {
  constructor(tag, value = '') { this.tag = tag; this.textContent = value; this.children = []; this.attributes = {}; this.className = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...children) { this.children.push(...children); }
}
const document = { createElement:tag => new Element(tag), createTextNode:value => new Element('#text', String(value)) };
const walk = node => [node, ...node.children.flatMap(walk)];
const text = node => walk(node).map(item => item.textContent).join('\n');
const render = (value, language = 'en') => renderArtifactConfiguration(value, { language, document });
const moduleManifest = {
  id:'example.reader', version:'2.1.0', runtime:{kind:'node', entry:'reader.mjs'}, platforms:['win32-x64','linux-x64'],
  provides:[{id:'text.read',version:'1.0.0'}], requires:[{id:'ui.render',version:'2.0.0'}],
  permissions:{filesystem:'instance-state',network:['hub-loopback'],processes:'none'}
};
function configuration(extra = {}) {
  return { format:'world-hub.workshop-configuration/v1', sha256:'a'.repeat(64), kind:'module', id:moduleManifest.id, version:moduleManifest.version, manifest:moduleManifest,
    deployment:null, executionDefaults:{declared:null,effective:{mode:'resident',idleTimeoutMs:60000,allowedCallers:[]},source:'system'}, dependencies:null, ...extra };
}

test('missing and loading states do not invent a policy or reuse a previous artifact version', () => {
  const previous = render(configuration()); assert.match(text(previous),/Resident/);
  const empty = render(null); assert.match(text(empty),/has not been loaded/); assert.doesNotMatch(text(empty),/Resident|example.reader|60 seconds/);
  const loading = render({status:'loading'}); assert.match(text(loading),/Validating and reading/); assert.equal(walk(loading).find(node => node.attributes.role === 'status').tag,'p');
  assert.equal(empty.attributes['data-artifact-sha256'],undefined);
  const next = render(configuration({sha256:'b'.repeat(64),version:'2.2.0',manifest:{...moduleManifest,id:'example.next',runtime:{kind:'python',entry:'next.py'}}}));
  assert.equal(next.attributes['data-artifact-sha256'],'b'.repeat(64)); assert.match(text(next),/Python/); assert.doesNotMatch(text(next),/reader.mjs/);
});

test('system policy clearly labels undeclared values and local caller authorization', () => {
  const view = render(configuration()), output = text(view);
  assert.match(output,/System initial values \(author did not declare\)/);
  assert.match(output,/60 seconds/); assert.match(output,/No idle timeout declared/);
  assert.match(output,/Initially empty. Choose allowed callers locally/);
  assert.match(output,/does not provide deployment.json/);
  assert.match(output,/manifest does not specify an interpreter version/);
  assert.match(output,/win32-x64/); assert.match(output,/Instance state directory/);
  assert.equal(walk(view).some(node => ['button','input','iframe','script','a'].includes(node.tag)),false);
});

test('installation dependencies, contracts, source wiring, settings and topic grants are distinct readable sections', () => {
  const view = render(configuration({
    executionDefaults:{declared:{mode:'on-demand',idleTimeoutMs:1500},effective:{mode:'on-demand',idleTimeoutMs:1500,allowedCallers:[]},source:'module'},
    deployment:{settings:[{key:'theme',label:{en:'Theme',zh:'主题'},type:'string',default:'light'}],topics:{request:'ui/render'},bridges:{main:{publish:['request'],subscribe:[]}},connections:[{id:'display',provider:{moduleId:'example.ui',version:'3.0.0'},contracts:[{id:'ui.render',version:'2.0.0'}],topics:{request:'render'}}]},
    dependencies:{installation:{kind:'npm-lock',recipes:['electron']},npm:{dependencies:{electron:'35.0.0'},devDependencies:{typescript:'5.0.0'},optionalDependencies:{optional:'1.0.0'},peerDependencies:{peer:'2.0.0'},lock:{path:'package-lock.json',lockfileVersion:3,packageCount:40}},python:[{path:'requirements.txt',requirements:['requests==2.32.0'],unsupportedCount:1}],unparsed:[{path:'pyproject.toml'}]}
  }));
  const output = text(view);
  for (const expected of ['On demand','Module declaration','1.5 seconds','Installation dependencies','Runtime dependencies','Development dependencies','Optional dependencies','Peer dependencies','Capability contracts','Needs a provider','ui.render@2.0.0','electron','package-lock.json','40','requests==2.32.0','pyproject.toml','example.ui@3.0.0','ui/render','Can send','Can receive','Settings','light']) assert.ok(output.includes(expected),expected);
  assert.doesNotMatch(output,/No idle timeout declared/);
  assert.match(output,/separate from installation dependencies/);
  assert.ok(walk(view).filter(node => node.tag === 'th').every(node => node.attributes.scope === 'col'));
  assert.equal(walk(view).filter(node => node.tag === 'pre').length,0,'configuration is not an opaque raw JSON dump');
});

test('configuration policies, pinned dependencies, exact startup ordering and effective wiring remain visible without embedded module sources', () => {
  const source = {memberId:'source',module:{id:'example.reader',version:'2.1.0',digest:'a'.repeat(64)},executionDefaults:{declared:null,effective:null,source:'module'},effectiveConfiguration:{topics:{source:'profile/source'},bridges:{main:{publish:['source'],subscribe:[]}},settings:{text:'profile custom'},bindings:[]},configurationSources:{topics:'configuration',bridges:'configuration',settings:'configuration',bindings:'configuration'}};
  const ui = {memberId:'ui',module:{id:'example.ui',version:'3.0.0',digest:'b'.repeat(64)},executionDefaults:{declared:{mode:'on-demand',idleTimeoutMs:120000},effective:{mode:'on-demand',idleTimeoutMs:120000,allowedCallers:[]},source:'configuration'},effectiveConfiguration:{topics:{render:'profile/render'},bridges:{main:{publish:[],subscribe:['render']}},settings:{dimensions:{width:640,visible:true}},bindings:[{providerId:'source',contract:{id:'text.read',version:'1.0.0'}}]},configurationSources:{topics:'configuration',bridges:'configuration',settings:'configuration',bindings:'configuration'}};
  const profile = render(configuration({kind:'configuration',scope:'global',manifest:{provides:[],requires:[]},modules:[source,ui],startupPlan:{members:[{programId:'source',enabled:true,after:[]},{programId:'ui',enabled:false,after:['source']}],startupOrder:['ui','source'],onFailure:'continue-independent'}}));
  const output = text(profile);
  for (const expected of ['2 logical instances','Global','example.reader@2.1.0','example.ui@3.0.0','a'.repeat(64),'Not specified by this configuration','Configuration declaration','120 seconds','Continue independent members','Not included','Configured value','profile custom','profile/render','dimensions','640','text.read@1.0.0']) assert.ok(output.includes(expected),expected);
  assert.doesNotMatch(output,/Node.js|Python|reader.mjs|module group/i);
  const startup = walk(profile).find(node => node.tag === 'details' && text(node).includes('Startup failure policy'));
  const rows = walk(startup).filter(node => node.tag === 'tbody')[0].children;
  assert.equal(text(rows[0]).includes('ui'),true); assert.equal(text(rows[1]).includes('source'),true);
  assert.match(output,/Enabled plan entries and resident\/on-demand policies jointly/);
});

test('dataset scope, compatible module, data format and exact business file sizes remain readable in both languages', () => {
  const data = configuration({kind:'data',scope:'local',purpose:'dataset',fileCount:1,byteSize:5,instances:[{id:'reader',module:{id:'example.reader',version:'2.1.0',digest:'c'.repeat(64)},dataFormat:{id:'reader.rows',version:'3.0.0'},fileCount:1,byteSize:5,files:[{path:'data/reader/rows.bin',sha256:'d'.repeat(64),byteSize:5}]}]});
  const english = text(render(data)), chinese = text(render(data,'zh'));
  for (const expected of ['Local','Ready-to-use dataset','example.reader@2.1.0','reader.rows@3.0.0','rows.bin','5 B','c'.repeat(64),'d'.repeat(64)]) assert.ok(english.includes(expected),expected);
  assert.match(chinese,/局部/); assert.match(chinese,/现成数据集/); assert.doesNotMatch(english,/Program entry|Resident|Node.js/);
});

test('publisher text is never markup and unknown source fields or sensitive defaults are not rendered', () => {
  const attack = '<img src=x onerror=alert(1)>', secret = 'DO-NOT-SHOW';
  const view = render(configuration({manifest:{...moduleManifest,runtime:{kind:'node',entry:attack},source:secret},privateKey:secret,sourceCode:secret,
    deployment:{settings:[{key:'caption',type:'string',label:{en:attack},default:attack},{key:'apiToken',type:'string',label:{en:'Access token'},default:secret}]}}));
  const output = text(view); assert.ok(output.includes(attack)); assert.ok(!output.includes(secret));
  assert.match(output,/Sensitive value is not displayed publicly/);
  assert.equal(walk(view).some(node => node.tag === 'img' || node.tag === 'script'),false);
  assert.equal(walk(view).some(node => Object.keys(node.attributes).some(name => /^on/i.test(name))),false);
});

test('Chinese and English use the same projection without stale localized settings or translated identifiers', () => {
  const config = configuration({deployment:{settings:[{key:'caption',type:'string',label:{zh:'标题',en:'Caption'},default:'用户内容 / user content'}],topics:{literal:'汉字-topic'},bridges:{main:{publish:['literal'],subscribe:[]}}}});
  const chinese = text(render(config,'zh')), english = text(render(config,'en'));
  assert.match(chinese,/资源声明与接入/); assert.match(chinese,/标题/); assert.match(english,/Resource declarations & integration/); assert.match(english,/Caption/);
  assert.doesNotMatch(english,/常驻运行|系统初始值|作者未声明|默认参数/);
  for (const output of [chinese,english]) { assert.match(output,/用户内容 \/ user content/); assert.match(output,/汉字-topic/); }
});
