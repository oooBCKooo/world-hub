// Optional user-facing deployment workflows. No application protocol lives here.
export function createDeploymentUi(ctx) {
  const {state,api,el,button,toast,refresh,navigate}=ctx;
  const say=(zh,en)=>state.language==='zh'?zh:en;
  const label=value=>typeof value==='string'?value:value?.[state.language]??value?.en??value?.zh??'';
  const programState=value=>say({running:'运行中',stopped:'已停止',starting:'启动中',stopping:'停止中',failed:'需要处理',unknown:'退出待确认'}[value]??value,value);
  const communication=value=>say({connected:'已连接',disconnected:'未连接',unknown:'尚未观察'}[value]??value,value);
  let serial=0;
  const unique=prefix=>`${prefix}.${Date.now().toString(36)}${(++serial).toString(36)}`;
  function dialog(title) {
    const node=el('dialog',{class:'dialog deployment-dialog','aria-label':title});
    const close=button(say('关闭','Close'),()=>node.close(),'button button-quiet');
    const content=el('div'),status=el('p',{role:'status',class:'field-help'});
    node.append(el('div',{class:'dialog-heading'},[el('h2',{},title),close]),content,status);
    node.addEventListener('close',()=>node.remove(),{once:true});document.body.append(node);node.showModal();
    return {node,content,status};
  }
  const field=(title,input)=>el('label',{},[el('span',{},title),input]);
  function settingsFields(deployment,settings) {
    return (deployment?.settings??[]).map(item=>{
      const multiline=item.type==='string'&&/[\r\n]/.test(item.default);
      const input=el(multiline?'textarea':'input',{...(multiline?{rows:4}:{type:item.type==='number'?'number':item.type==='boolean'?'checkbox':'text'}),...(item.min!==undefined?{min:item.min}:{}),...(item.max!==undefined?{max:item.max}:{}),'aria-label':label(item.label)});
      if(item.type==='boolean')input.checked=settings[item.key];else input.value=settings[item.key];
      input.addEventListener('change',()=>{settings[item.key]=item.type==='boolean'?input.checked:item.type==='number'?Number(input.value):input.value;});
      return field(label(item.label),input);
    });
  }
  async function waitOperation(id,status) {
    for(;;){const {operation}=await api(`/api/operations/${encodeURIComponent(id)}`);if(operation.state==='succeeded')return operation.result;if(operation.state==='failed')throw new Error(operation.error?.message??say('操作失败','Operation failed'));status.textContent=say('正在处理，请稍候…','Working…');await new Promise(done=>setTimeout(done,500));}
  }
  function reviewContents(review) {
    const sources=review.sources??(review.manifest?[{manifest:review.manifest,directory:review.directory,deploymentReview:review.deployment}]:[]);
    return [el('p',{},say('请核对所选程序、版本、来源和接线。本机运行不提供操作系统沙箱。','Review programs, versions, sources and wiring. Local execution has no OS sandbox.')),
      ...sources.map(source=>el('article',{class:'panel'},[el('h3',{},`${source.manifest.id} @${source.manifest.version}`),el('p',{class:'mono'},source.directory),
        el('p',{},source.manifest.permissions.processes==='owned-children'?say('允许程序创建并管理所属子进程与窗口。','Program may create and manage its own child processes and windows.'):say('程序声明不创建子进程。','Program declares no child processes.')),
        source.deploymentReview?.dependencies?el('p',{},say('将按锁定摘要从官方 npm 源安装依赖；Electron 配方会下载官方桌面运行时。不会执行模块自定义安装命令。','Installs locked dependencies from the official npm registry. The Electron recipe downloads its official desktop runtime. Module installation commands are not run.')):null].filter(Boolean))),
      el('details',{},[el('summary',{},say('查看完整接线与声明','Full wiring and declarations')),el('pre',{},JSON.stringify(review,null,2))])];
  }
  async function importArtifact(kind='module') {
    const view=dialog(say('导入本地发行包','Import local distribution'));
    const path=el('input',{name:'artifactPath','data-path-purpose':'directory','aria-label':say('ZIP 或发行目录','ZIP or distribution folder')});
    const choose=button(say('选择 ZIP…','Choose ZIP…'),()=>ctx.openPathPicker(path,'file'),'button button-quiet');
    const folder=button(say('选择文件夹…','Choose folder…'),()=>ctx.openPathPicker(path,'directory'),'button button-quiet');
    const submit=button(say('检查并导入','Inspect and import'),async()=>{
      submit.disabled=true;try{const result=await api('/api/artifacts/import',{path:path.value.trim(),kind});view.status.textContent=say('已导入','Imported')+`: ${result.object.id} @${result.object.version}`;
        await ctx.loadKnown?.();toast(view.status.textContent);view.node.close();navigate(kind==='module'?'modules':kind==='template'?'templates':'packs');}
      catch(error){view.status.textContent=error.message;}finally{submit.disabled=false;}
    },'button button-primary');
    view.content.append(el('p',{},say('选择作者提供的完整模块 ZIP 或发行目录。普通应用源码需先由作者适配。导入不会启动程序。','Choose a complete author-supplied distribution ZIP or folder. Ordinary application sources require author adaptation. Import does not start a program.')),field(say('ZIP 或发行目录','ZIP or distribution folder'),path),el('div',{class:'result-actions'},[choose,folder,submit]));
  }
  async function compose(initial) {
    const view=dialog(say('从模块创建整合包','Create a pack from modules')),selected=[];
    const known=await api('/api/paths/known'),rows=known.objects.filter(row=>row.kind==='module');
    const picker=el('select',{'aria-label':say('选择模块版本','Choose module version')},[el('option',{value:''},say('选择模块…','Choose module…')),...rows.map((row,index)=>el('option',{value:String(index)},`${row.id} @${row.version} · ${row.path}`))]);
    const list=el('div'),id=el('input',{value:unique('my.pack'),'aria-label':say('整合包标识','Pack ID')}),title=el('input',{value:say('我的组合','My composition'),'aria-label':say('整合包名称','Pack name')}),version=el('input',{value:'0.1.0','aria-label':say('版本','Version')});
    const entry=el('select',{'aria-label':say('启动入口','Entry program')});
    function render() {
      const prior=entry.value;entry.replaceChildren(...selected.map(item=>el('option',{value:item.componentId},label(item.deployment?.title)||item.manifest.id)));if(selected.some(item=>item.componentId===prior))entry.value=prior;
      list.replaceChildren(...selected.map(item=>{
        const contracts=item.manifest.requires.map(required=>{
          const options=selected.filter(other=>other!==item&&other.manifest.provides.some(offered=>offered.id===required.id&&offered.version===required.version));
          const input=el('select',{'aria-label':`${item.componentId} · ${required.id}`},[el('option',{value:''},say('请选择能力提供者','Choose a capability provider')),...options.map(other=>el('option',{value:other.componentId},label(other.deployment?.title)||other.manifest.id))]);
          const existing=item.providers.find(binding=>binding.contract.id===required.id&&binding.contract.version===required.version);if(existing)input.value=existing.from;
          if(!existing&&options.length===1){input.value=options[0].componentId;item.providers.push({from:options[0].componentId,contract:required});}
          input.addEventListener('change',()=>{item.providers=item.providers.filter(binding=>binding.contract.id!==required.id||binding.contract.version!==required.version);if(input.value)item.providers.push({from:input.value,contract:required});});
          return field(`${required.id} @${required.version}`,input);
        });
        return el('article',{class:'panel'},[el('h3',{},`${label(item.deployment?.title)||item.manifest.id} @${item.manifest.version}`),...settingsFields(item.deployment,item.settings),...contracts,button(say('移除','Remove'),()=>{selected.splice(selected.indexOf(item),1);render();},'button button-quiet')]);
      }));
    }
    async function add(row) {
      if(selected.some(item=>item.directory===row.path))return;
      const result=await api('/api/deployment/inspect',{directory:row.path}),deployment=result.deploymentReview?.deployment;
      if(!deployment)throw new Error(say('此模块尚未提供装配默认值，请由作者补充 deployment.json。','The module author must supply deployment defaults.'));
      let ordinal=1;while(selected.some(item=>item.componentId==='program'+ordinal))ordinal++;
      selected.push({componentId:'program'+ordinal,directory:row.path,manifest:result.manifest,deployment,settings:Object.fromEntries(deployment.settings.map(item=>[item.key,item.default])),providers:[]});render();
    }
    const addButton=button(say('添加模块','Add module'),async()=>{try{if(picker.value!=='')await add(rows[Number(picker.value)]);}catch(error){view.status.textContent=error.message;}},'button');
    const previewButton=button(say('审阅组合','Review composition'),async()=>{
      previewButton.disabled=true;try{
        const input={id:id.value.trim(),title:title.value.trim(),version:version.value.trim(),entry:entry.value,modules:selected.map(item=>({componentId:item.componentId,directory:item.directory,settings:item.settings,providers:item.providers,after:[...new Set(item.providers.map(binding=>binding.from))]}))};
        const result=await api('/api/compositions/preview',input),review=dialog(say('审阅并创建整合包','Review and create pack'));
        const create=button(say('确认创建并导入','Create and import'),async()=>{create.disabled=true;try{const operation=await api('/api/compositions/create',{reviewId:result.reviewId,accepted:true}),created=await waitOperation(operation.operationId,review.status);
          const reviewed=await api('/api/review',{directory:created.directory}),instance=await api('/api/instances',{reviewId:reviewed.reviewId,instanceId:unique('pack')});
          await refresh({explicit:true});await ctx.loadKnown?.();review.node.close();view.node.close();navigate('packs');toast(say('已创建并导入，选择启动以审阅执行。','Created and imported. Select Start to review execution.'));
        }catch(error){review.status.textContent=error.message;create.disabled=false;}},'button button-primary');review.content.append(...reviewContents(result.preview),create);
      }catch(error){view.status.textContent=error.message;}finally{previewButton.disabled=false;}
    },'button button-primary');
    view.content.append(el('p',{},say('从空白组合开始，加入独立模块、选择能力提供者，然后创建可启动整合包。','Start an empty composition, add modules, select capability providers, then create a runnable pack.')),field(say('整合包标识','Pack ID'),id),field(say('整合包名称','Pack name'),title),field(say('版本','Version'),version),el('div',{class:'result-actions'},[picker,addButton]),list,field(say('启动入口','Entry program'),entry),previewButton);
    if(initial)try{await add(initial);}catch(error){view.status.textContent=error.message;}
  }
  async function register(initial) {
    const view=dialog(say('接入本机 Hub','Connect to local Hub'));
    try {
      const inspected=await api('/api/deployment/inspect',{directory:initial.path}),deployment=inspected.deploymentReview?.deployment;
      if(!deployment)throw new Error(say('此模块需要作者提供接入默认值。','Module author must supply deployment defaults.'));
      const installed=(await api('/api/programs')).programs,settings=Object.fromEntries(deployment.settings.map(item=>[item.key,item.default])),bindings=[];
      const id=el('input',{value:unique('program'),'aria-label':say('程序实例名称','Program instance ID')});
      const fields=inspected.manifest.requires.map(required=>{
        const providers=installed.filter(program=>program.provides.some(offered=>offered.id===required.id&&offered.version===required.version));
        const select=el('select',{'aria-label':required.id},[el('option',{value:''},say('选择提供者','Choose provider')),...providers.map(provider=>el('option',{value:provider.programId},`${label(provider.title)} · ${provider.programId}`))]);
        if(providers.length===1){select.value=providers[0].programId;bindings.push({providerId:select.value,contract:required});}
        select.addEventListener('change',()=>{const prior=bindings.findIndex(binding=>binding.contract.id===required.id);if(prior>=0)bindings.splice(prior,1);if(select.value)bindings.push({providerId:select.value,contract:required});});return field(required.id,select);
      });
      const submit=button(say('审阅接入','Review connection'),async()=>{
        submit.disabled=true;try{const result=await api('/api/programs/preview',{programId:id.value.trim(),directory:initial.path,settings,bindings}),review=dialog(say('审阅独立程序','Review independent program'));
          const confirm=button(say('确认安装与登记','Install and register'),async()=>{confirm.disabled=true;try{await api('/api/programs/register',{reviewId:result.reviewId,accepted:true});review.node.close();view.node.close();await managePrograms();}catch(error){review.status.textContent=error.message;confirm.disabled=false;}},'button button-primary');review.content.append(...reviewContents(result.review),confirm);
        }catch(error){view.status.textContent=error.message;}finally{submit.disabled=false;}
      },'button button-primary');
      view.content.append(el('p',{},say('程序连接本机 Hub，无需创建整合包。先登记所有协作程序，再审阅启动。','Connects this program to the local Hub without creating a pack. Register collaborating programs before reviewing their starts.')),field(say('程序实例名称','Program instance ID'),id),...settingsFields(deployment,settings),...fields,submit);
    }catch(error){view.status.textContent=error.message;}
  }
  async function managePrograms() {
    const view=dialog(say('本机 Hub 的独立程序','Independent programs on local Hub'));
    async function render(){const {programs}=await api('/api/programs');view.content.replaceChildren(el('p',{},say('启动或停止一个程序只操作它所属的进程。本机 Hub 可供多个程序共用。','Each start or stop controls only that program’s owned processes. Multiple programs share the local Hub.')),...programs.map(program=>{
      const start=button(say('审阅并启动','Review and start'),async()=>{start.disabled=true;try{const result=await api(`/api/programs/${program.programId}/review`,{}),review=dialog(say('审阅本次启动','Review this start'));
        const confirm=button(say('确认安装依赖并启动','Prepare dependencies and start'),async()=>{confirm.disabled=true;try{const op=await api(`/api/programs/${program.programId}/start`,{reviewId:result.reviewId,accepted:true});await waitOperation(op.operationId,review.status);review.node.close();await render();await refresh({explicit:true});}catch(error){review.status.textContent=error.message;confirm.disabled=false;}},'button button-primary');
        review.content.append(el('p',{},`${program.module.id} @${program.module.version}`),...reviewContents({...result.review,manifest:result.review.manifest??{...program.module,permissions:program.permissions},directory:result.review.directory??'',deployment:result.review.deployment}),confirm);
      }catch(error){view.status.textContent=error.message;}finally{start.disabled=false;}},'button button-primary');start.disabled=program.state==='running';
      const stop=button(say('停止 / 重试清理','Stop / retry cleanup'),async()=>{stop.disabled=true;try{const op=await api(`/api/programs/${program.programId}/stop`,{});await waitOperation(op.operationId,view.status);await render();}catch(error){view.status.textContent=error.message;stop.disabled=false;}},'button button-quiet');stop.disabled=!['running','failed','starting','stopping','unknown'].includes(program.state);
      return el('article',{class:'panel'},[el('h3',{},label(program.title)),el('p',{class:'mono'},`${program.module.id} @${program.module.version} · ${program.programId}`),el('p',{},`${programState(program.state)} · ${communication(program.communication)}`),program.error?el('p',{},program.error.message):null,el('div',{class:'result-actions'},[start,stop])].filter(Boolean));}));view.node.scrollTop=0;}
    try{await render();}catch(error){view.status.textContent=error.message;}
  }
  return {importArtifact,compose,register,managePrograms};
}
