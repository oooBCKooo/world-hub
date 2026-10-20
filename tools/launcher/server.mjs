import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LauncherManager, launcherError } from './manager.mjs';
import { diagnose } from './diagnostics.mjs';
import { acquireLauncherOwner, defaultLauncherRoot } from './owner-lock.mjs';

const secret = () => randomBytes(32).toString('base64url');
const equals = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function fields(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))
    || required.some(k => !Object.hasOwn(body, k))) throw launcherError('INVALID_INPUT', 'Missing or unsupported request fields.', 400);
  for (const [key,value] of Object.entries(body)) {
    if (['accepted','redistributionAcknowledged','allowPrivateNetwork','enabled','observe'].includes(key)) { if(typeof value!=='boolean')throw launcherError('INVALID_INPUT', 'Invalid '+key,400); }
    else if (['priority','revision','offset'].includes(key)) { if(!Number.isSafeInteger(value))throw launcherError('INVALID_INPUT','Invalid '+key,400); }
    else if (key==='expectedSha256'&&value==='') {}
    else if (['plan','startupPlan','group','settings','topics','bridges','change','origin'].includes(key)) { if(!value||typeof value!=='object'||Array.isArray(value))throw launcherError('INVALID_INPUT','Invalid '+key,400); }
    else if (key==='bindings') { if(!Array.isArray(value)||value.length>128||value.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw launcherError('INVALID_INPUT','Invalid bindings',400); }
    else if (key==='programIds') { if(!Array.isArray(value)||value.length>128||value.some(id=>typeof id!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)))throw launcherError('INVALID_INPUT','Invalid program IDs',400); }
    else if (typeof value!=='string'||!value.trim()||value.length>4096||value.includes('\0'))throw launcherError('INVALID_INPUT','Invalid '+key,400);
  }
}
async function bodyOf(request, limit = 32768) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw launcherError('JSON_REQUIRED', 'Use application/json.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw launcherError('BODY_TOO_LARGE', `JSON body exceeds ${limit} bytes.`, 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw launcherError('INVALID_JSON', 'Invalid JSON body.', 400); }
}
export async function createLauncherServer(options = {}) {
  const owner = await acquireLauncherOwner(options.root ?? defaultLauncherRoot());
  const manager = new LauncherManager({ ...options, root: owner.root });
  try { await manager.initialize(); } catch (error) { await owner.release(); throw error; }
  let installedHubVersion = null;
  try {
    installedHubVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {}
  const token = secret(), csrfToken = secret(), bootstrapCode = secret(), tokens = new Set([token]); let bootstrapUsed = false, url, closing;
  const context = () => ({ version: 'world-hub.launcher/v1', root: manager.root, defaults: manager.defaults, csrfToken,
    softwareVersion: options.version ?? installedHubVersion ?? '0.19.0', sandbox: false, ownerRecovery: owner.recovered });
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    let directory;
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.host !== new URL(url).host
        || (request.headers.origin !== undefined && request.headers.origin !== url.slice(0, -1))) throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Only this Launcher origin is accepted.', 403);
      const target = new URL(request.url, url);
      if (target.origin !== new URL(url).origin) throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Invalid request origin.', 403);
      if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']))
        throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Only same-origin API and resource requests are accepted.', 403);
      if (request.method === 'GET' && target.pathname === '/') {
        if (target.search) throw launcherError('INVALID_INPUT', 'Unsupported API navigation query.', 400);
        send(response, 200, { service: 'world-hub-local-management', interface: 'headless', ui: { project: 'world-hub-ui', bundled: false } });
        return;
      }
      if (!target.pathname.startsWith('/api/')) {
        send(response, 404, { ok: false, error: { code: 'UI_SEPARATE_PROJECT', message: 'This server provides management JSON APIs. Use the separate world-hub-ui project for a user interface.' } });
        return;
      }
      const authorization = request.headers.authorization;
      const authenticated = typeof authorization === 'string' && [...tokens].some(value => equals(authorization, 'Bearer ' + value));
      const allowedQuery = [];
      if ([...target.searchParams.keys()].some(key => !allowedQuery.includes(key) || target.searchParams.getAll(key).length !== 1)) throw launcherError('INVALID_INPUT', 'Unsupported query.', 400);
      if (target.pathname === '/api/session' && request.method === 'POST' && !authenticated) {
        if (request.headers.origin !== url.slice(0, -1)) throw launcherError('LOCAL_ORIGIN_REQUIRED', 'Bootstrap requires the exact Launcher origin.', 403);
        const body = await bodyOf(request); fields(body, ['code'], ['code']);
        if (bootstrapUsed || !equals(body.code, bootstrapCode)) throw launcherError('BOOTSTRAP_INVALID', 'Launch code is invalid. Open a new Launcher session from its owning terminal.', 401);
        bootstrapUsed = true;
        const uiToken = secret(); tokens.add(uiToken); send(response, 200, { ok: true, token: uiToken, ...context() }); return;
      }
      if (!authenticated) throw launcherError('AUTH_REQUIRED', 'Launcher authorization required.', 401);
      if (request.method !== 'GET' && !equals(request.headers['x-csrf-token'], csrfToken)) throw launcherError('CSRF_REQUIRED', 'Launcher CSRF token required.', 403);
      let body;
      if (request.method === 'POST') body = await bodyOf(request, 1024 * 1024);
      let result, status=200;
      const post=request.method==='POST', get=request.method==='GET', pathname=target.pathname;
      if(pathname==='/api/session'&&get)result=context();
      else if(pathname==='/api/artifacts/import'&&post){fields(body,['path','kind'],['path','kind']);result=await manager.importArtifact(body);}
      else if(pathname==='/api/deployment/inspect'&&post){fields(body,['directory'],['directory']);result=await manager.localPrograms.inspect(body.directory);}
      else if(pathname==='/api/programs'&&get)result=await manager.programOverview();
      else if(pathname==='/api/programs/topology'&&get)result=await manager.programTopology();
      else if(pathname==='/api/programs/external'&&get)result=await manager.programExternalOverview();
      else if(pathname==='/api/programs/external/preview'&&post){if(!body||typeof body!=='object'||Array.isArray(body))throw launcherError('INVALID_INPUT','External communication input must be an object.',400);result=await manager.programExternalPreview(body);}
      else if(pathname==='/api/programs/external/apply'&&post){fields(body,['reviewId','accepted'],['reviewId','accepted']);result=await manager.programExternalApply(body);}
      else if(pathname==='/api/programs/startup-plan'&&get)result=await manager.programStartupPlan();
      else if(pathname==='/api/programs/startup-plan/save'&&post){fields(body,['plan','expectedRevision'],['plan','expectedRevision']);result=await manager.programStartupPlanSave(body);}
      else if(pathname==='/api/programs/startup-plan/review'&&post){fields(body,[]);result=await manager.programStartupPlanReview();}
      else if(pathname==='/api/programs/startup-plan/start'&&post){fields(body,['reviewId','accepted'],['reviewId','accepted']);result=manager.programStartupPlanStart(body);status=202;}
      else if(pathname==='/api/programs/preview'&&post){fields(body,['programId','directory','settings','topics','bridges','bindings','nodePath','pythonPath'],['programId','directory']);result=await manager.localPrograms.preview(body);}
      else if(pathname==='/api/programs/register'&&post){fields(body,['reviewId','accepted'],['reviewId','accepted']);result=await manager.localPrograms.register(body);}
      else if(/^\/api\/programs\/[a-z0-9][a-z0-9._-]{0,63}\/configuration\/(preview|apply)$/.test(pathname)&&post){
        const [,id,action]=pathname.match(/^\/api\/programs\/([^\/]+)\/configuration\/(.+)$/);
        if(action==='preview'){fields(body,['expectedRevision','directory','settings','topics','bridges','bindings','nodePath','pythonPath'],['expectedRevision']);result=await manager.localPrograms.configurationPreview(id,body);}
        else{fields(body,['reviewId','accepted'],['reviewId','accepted']);result=await manager.localPrograms.configurationApply(id,body);}
      }
      else if(/^\/api\/programs\/[a-z0-9][a-z0-9._-]{0,63}\/(review|start|stop|logs|remove)$/.test(pathname)){
        const [,id,action]=pathname.match(/^\/api\/programs\/([^\/]+)\/(.+)$/);
        if(action==='logs'&&get)result={logs:await manager.localPrograms.logs(id)};
        else if(action==='remove'&&post){fields(body,[]);result=await manager.localPrograms.remove(id);}
        else if(action==='review'&&post){fields(body,[]);result=await manager.localPrograms.reviewStart(id);}
        else if(['start','stop'].includes(action)&&post){fields(body,action==='start'?['reviewId','accepted']:[],action==='start'?['reviewId','accepted']:[]);result=manager.launch('local-'+action,'$local-'+id,(_,signal)=>action==='start'?manager.localPrograms.start(id,{...body,signal}):manager.localPrograms.stop(id));status=202;}
        else throw launcherError('NOT_FOUND','Unknown module action',404);
      }
      else if(pathname==='/api/groups'&&get)result=await manager.moduleGroups.list();
      else if((pathname==='/api/groups'||pathname==='/api/groups/save')&&post){fields(body,['group','expectedRevision'],['group']);result=await manager.moduleGroups.save(body);}
      else if(/^\/api\/groups\/[a-z0-9][a-z0-9._-]{0,63}\/(remove|start\/preview|start\/apply|stop\/preview|stop\/apply)$/.test(pathname)&&post){
        const [,id,action]=pathname.match(/^\/api\/groups\/([^\/]+)\/(.+)$/);
        if(action==='remove'){fields(body,['expectedRevision'],['expectedRevision']);result=await manager.moduleGroups.remove({groupId:id,...body});}
        else if(action.endsWith('preview')){fields(body,['expectedRevision'],['expectedRevision']);result=await manager.moduleGroups[action.startsWith('start')?'reviewStart':'stopPreview']({groupId:id,...body});}
        else if(action==='start/apply'){fields(body,['reviewId','accepted'],['reviewId','accepted']);const saved=manager.localPrograms.reviewed(body.reviewId,'startup-plan');if(saved.review.groupId!==id)throw launcherError('MODULE_GROUP_CHANGED','Review belongs to another group.');result=manager.groupStart(body);status=202;}
        else{fields(body,['reviewId','accepted','programIds'],['reviewId','accepted','programIds']);const saved=manager.localPrograms.reviewed(body.reviewId,'group-stop');if(saved.review.groupId!==id)throw launcherError('MODULE_GROUP_CHANGED','Review belongs to another group.');result=manager.launch('group-stop','$group-stop',()=>manager.moduleGroups.applyStop(body));status=202;}
      }
      else if(pathname==='/api/paths/known'&&get)result=await manager.paths.known(manager);
      else if(pathname==='/api/paths/browse'&&post){fields(body,['directory','purpose','offset']);result=await manager.paths.browse(body);}
      else if(pathname==='/api/paths/check'&&post){fields(body,['path','purpose'],['path']);result=await manager.paths.check(body);}
      else if(pathname==='/api/paths/remember'&&post){fields(body,['path','purpose'],['path']);result=await manager.paths.remember(body);}
      else if(pathname==='/api/paths/forget'&&post){fields(body,['path','purpose'],['path','purpose']);result=await manager.paths.forget(body);}
      else if(pathname==='/api/paths/discover'&&post){fields(body,['directory'],['directory']);result=manager.discoverPaths(body);status=202;}
      else if(pathname==='/api/paths/native-pick'&&post){fields(body,['purpose','initialPath'],['purpose']);result=await manager.paths.nativePick(body);}
      else if(pathname==='/api/environment'&&post){fields(body,['nodePath','pythonPath']);result=await manager.detect(body);}
      else if(pathname==='/api/sources'&&get)result=await manager.sources();
      else if(pathname==='/api/publisher-trust'&&get)result={trust:await manager.publisherTrustState()};
      else if(pathname==='/api/publisher-trust/preview'&&post){fields(body,['change'],['change']);result=await manager.publisherTrustPreview(body.change);}
      else if(pathname==='/api/publisher-trust/apply'&&post){fields(body,['change','reviewDigest','accepted'],['change','reviewDigest','accepted']);result=await manager.publisherTrustApply(body);}
      else if(pathname==='/api/publisher-evidence/preview'&&post){fields(body,['receiptId','evidencePath','artifactPath','sourceId','source','indexDigest','entryId']);result=await manager.publisherEvidencePreview(body);}
      else if(pathname==='/api/publisher-evidence/observe'&&post){fields(body,['previewId','accepted'],['previewId','accepted']);result=await manager.publisherEvidenceObserve(body);}
      else if(['/api/sources','/api/sources/save'].includes(pathname)&&post){fields(body,['id','name','source','enabled','priority','expectedSha256','allowPrivateNetwork','revision'],['name','source']);result=await manager.saveSource(body);}
      else if(/^\/api\/sources\/[a-z0-9._-]+\/delete$/.test(pathname)&&post){fields(body,[]);result=await manager.deleteSource(pathname.split('/').at(-2));}
      else if(pathname==='/api/sources/inspect'&&post){fields(body,['source','sourceId','expectedSha256','allowPrivateNetwork']);if(!body.source&&!body.sourceId)throw launcherError('SOURCE_INPUT','Select a source.',400);result=await manager.source(body);}
      else if(pathname==='/api/sources/fetch'&&post){fields(body,['source','sourceId','receiptId','indexDigest','entryId','allowPrivateNetwork'],['entryId']);if(!body.source&&!body.sourceId)throw launcherError('SOURCE_INPUT','Select a source.',400);result=manager.fetchSource(body);status=202;}
      else if(pathname==='/api/sources/publish'&&post){fields(body,['directory','destination','kind','nodePath','pythonPath','redistributionAcknowledged'],['directory','destination','kind','redistributionAcknowledged']);result=manager.publishModule(body);status=202;}
      else if(pathname==='/api/hubs'&&get)result={hubs:await manager.hubs()};
      else if(/^\/api\/hubs\/default\/(start|stop)$/.test(pathname)&&post){fields(body,[]);result=manager.defaultHub(pathname.split('/').at(-1));status=202;}
      else if(pathname==='/api/operations'&&get)result=manager.operationList();
      else if(/^\/api\/operations\/[a-f0-9-]+\/cancel$/.test(pathname)&&post){fields(body,[]);result={operation:await manager.cancelOperation(pathname.split('/').at(-2))};}
      else if(/^\/api\/operations\/[a-f0-9-]+$/.test(pathname)&&get)result={operation:manager.operation(pathname.split('/').at(-1))};
      else throw launcherError('NOT_FOUND','Unknown Launcher operation.',404);
      send(response, status, { ok: true, ...result });
    } catch (error) {
      send(response,error.status??409,{ok:false,error:{code:error.code??'LAUNCHER_ERROR',message:String(error.message).slice(0,2048),
        ...(error.cleanupIncomplete?{cleanupIncomplete:true}:{}),...(error.incompleteDestination?{incompleteDestination:error.incompleteDestination}:{})},diagnostic:diagnose(error)});
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 15000; server.keepAliveTimeout = 1000;
  try { await new Promise((yes, no) => { server.once('error', no); server.listen(options.port ?? 0, '127.0.0.1', yes); }); }
  catch (error) { await manager.close(); await owner.release(); throw error; }
  url = `http://127.0.0.1:${server.address().port}/`; manager.url = url;
  return { url, launchUrl: url + '#launch=' + bootstrapCode, token, csrfToken, root: manager.root, manager, ownerRecovery: owner.recovered,
    close: () => closing ??= (async () => {
      try {
        await manager.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await owner.release();
      } catch (error) { closing = null; throw error; }
    })() };
}
