import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,parse} from 'node:path';
import {PathsService,identifyDirectory} from '../../../tools/launcher/paths-service.mjs';
import {workspace,ROOT} from '../launcher/helpers.mjs';

test('module path browsing, known candidates and native picker share exact reviewed path selection without execution',async t=>{
  const app=await workspace(t);await mkdir(app.root,{recursive:true});const paths=new PathsService(app.root);await paths.initialize();app.cleanups.push(()=>paths.close());
  const module=join(ROOT,'examples/ecosystem-pack/modules/source');
  assert.equal((await paths.check({path:module,purpose:'module'})).object.kind,'module');
  assert.equal((await identifyDirectory(join(ROOT,'examples/ecosystem-pack'))),null);
  const listing=await paths.browse({directory:join(ROOT,'examples/ecosystem-pack/modules'),purpose:'module'});
  assert.equal(listing.entries.find(row=>row.name==='source').object.kind,'module');assert.equal(listing.startsModules,false);
  const before=process.env.WH_NATIVE_PICK_RESULT;t.after(()=>{if(before===undefined)delete process.env.WH_NATIVE_PICK_RESULT;else process.env.WH_NATIVE_PICK_RESULT=before;});
  process.env.WH_NATIVE_PICK_RESULT=module;
  const picked=await paths.nativePick({purpose:'module'});assert.equal(picked.path,module);assert.equal(picked.cancelled,false);
  process.env.WH_NATIVE_PICK_RESULT='';assert.equal((await paths.nativePick({purpose:'module'})).cancelled,true);
  await assert.rejects(paths.discover({directory:parse(module).root}),{code:'SCAN_ROOT_REFUSED'});
  for(const purpose of ['pack','template'])await assert.rejects(paths.check({path:module,purpose}),{code:'PATH_PURPOSE_INVALID'});
});

test('directory and ZIP chooser modes, Unicode paths and discovery expose modules without accepting retired products',async t=>{
  const app=await workspace(t);await mkdir(app.root,{recursive:true});const paths=new PathsService(app.root);await paths.initialize();app.cleanups.push(()=>paths.close());
  const root=join(app.directory,'中文 空格 🌍');await mkdir(root);const module=join(root,'module');await mkdir(module);await writeFile(join(module,'module.json'),JSON.stringify({format:'world-hub.module/v1',id:'candidate',version:'1.0.0'}));
  const retired=join(root,'retired');await mkdir(retired);await writeFile(join(retired,'template.json'),'{}');
  const zip=join(root,'模块.zip');await writeFile(zip,'selection does not claim archive integrity');
  assert.equal((await paths.check({path:zip,purpose:'source'})).selectable,true);
  assert.equal((await paths.check({path:zip,purpose:'module'})).selectable,true);
  const found=await paths.discover({directory:root});assert.equal(found.objects.filter(row=>row.kind==='module').length,1);assert.ok(found.objects.every(row=>row.kind==='module'));assert.equal(found.startsModules,false);
});
