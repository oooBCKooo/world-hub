// Workshop is an optional distribution service. This page never executes code
// or contacts a local Launcher API. Remote strings are rendered as text only.
const base = new URL('./', import.meta.url);
const $ = selector => document.querySelector(selector);
const uploadMaximum = 8 * 1024 * 1024;
const aboutWork = { zh:'作品信息', en:'About this work' };
const languages = {
  zh: {
    skip:'跳至内容', language:'语言', brandCaption:'独立能力，自由组合', hosted:'托管社区', catalog:'发现作品', publish:'发布作品', account:'我的账号', loading:'正在加载…', footer:'社区提供发现与分享。本地 Launcher 无需社区也能独立运行。', documentation:'开发者文档 ↗', anonymous:'浏览访客', heroEyebrow:'YOUR PROGRAMS, MORE POSSIBILITIES', heroBefore:'发现独立能力，', heroAfter:'组合你的世界。', heroText:'分享模块与整合包，沿着能力契约连接程序。作品属于开发者，如何使用由你决定。', explore:'浏览作品', share:'分享你的作品', artSource:'信息来源', artModule:'独立模块', artPack:'自由组合', collection:'社区作品', items:'{count} 件作品', search:'搜索', searchPlaceholder:'名称、ID 或发布者', kind:'作品类型', allKinds:'全部类型', module:'模块', pack:'整合包', template:'模板', contract:'能力契约', contractPlaceholder:'契约 ID（精确匹配）', filter:'筛选', noPublications:'从第一件作品开始。', noResults:'没有找到匹配的作品。', emptyText:'发布独立模块或整合包，让其他开发者探索新的组合。', emptyFilter:'试试其他关键词、类型或能力契约。', provides:'提供能力', requires:'需要能力', noContracts:'未声明外部契约', comments:'评论', proposals:'提案', unknownOwner:'未知发布者', previous:'上一页', next:'下一页', page:'第 {page} 页', sourceTitle:'用你自己的入口探索', sourceText:'复制开放的软件源索引，在本地 Launcher 中添加并审阅。', copySource:'复制软件源地址', viewSource:'查看索引 ↗', boundary:'分享与下载不启动任何程序。导入、代码审阅与执行由你自己的本地 Launcher 或兼容工具完成。Hub 继续只负责通信。', copied:'已复制。', copyUnavailable:'无法自动复制，请复制此地址：', networkError:'暂时无法连接社区，请稍后重试。', refresh:'重试', publishEyebrow:'SHARE YOUR BUILDING BLOCKS', publishTitle:'让能力被更多人发现。', publishSubtitle:'上传本地创作工具导出的 artifact.json。服务器保存和分发文件，不运行上传的代码。', loginRequired:'请先登录或使用邀请注册，再发布作品、发表评论与提交提案。', goAccount:'前往账号', uploadTitle:'1. 选择作品制品', artifactLabel:'制品文件', uploadHint:'world-hub.source-artifact/v1 · JSON · 最大 8 MiB', uploadHelp:'在本地 Launcher 的创作工作台发布到新目录，选择其中的 artifact.json；也可使用 Runtime 的 publishArtifact。', titleLabel:'显示标题（可选）', titlePlaceholder:'留空则使用清单中的标题', previewTitle:'2. 审阅作品信息', previewNote:'此处预览来自上传文件。服务器将独立验证格式、文件摘要、路径、清单与许可证；预览不是代码安全认证。', id:'标识', version:'版本', license:'许可证', platforms:'平台', files:'文件数', byteSize:'上传体积', contracts:'能力契约', notDeclared:'未声明', previewNone:'选择文件后显示预览。', redistribute:'我已审阅将分享的全部文件，拥有再分发权，并接受文件清单声明的许可证。', publishConfirm:'确认发布', publishing:'正在发布…', published:'作品已发布。下载不会自动执行代码。', duplicate:'该版本与摘要已发布，打开已有作品。', invalidArtifact:'请选择完整的 world-hub.source-artifact/v1 JSON 制品。', fileTooLarge:'文件超过 8 MiB，请缩小初期社区的制品体积。', invalidManifest:'无法读取制品中的模块／整合包清单。', immutable:'版本不可覆盖', publishRules:'每个 ID 与版本对应不可覆盖的制品。要分享修改，请使用新版本；相同版本的不同摘要会被拒绝。', initialQuota:'初期闭环', quotaText:'邀请制账号，单次制品不超过 8 MiB。服务端设有账号、发布与存储配额，达到上限会明确拒绝；保留本地原始文件。', safeFiles:'只分享准备好的源码', safeFilesText:'不要上传密钥、运行数据、缓存或本地环境凭据。服务端不会执行上传制品，下载后的代码仍需你独立审阅。', backCatalog:'返回作品目录', download:'下载制品 JSON', publisher:'发布者', publishedAt:'发布于', exactDigest:'制品 SHA-256', downloadNote:'下载到本地后，在 Launcher 软件源或兼容工具中审阅。下载、评论或提案都不授予运行权限。', hidden:'已隐藏', hidePublication:'隐藏作品', showPublication:'恢复展示', visibilityChanged:'作品展示状态已更新。', noComments:'还没有评论。可以从用途、能力契约或接入体验开始讨论。', commentLabel:'写一条评论', commentPlaceholder:'纯文本，最多 4000 字符', sendComment:'发表评论', commentSent:'评论已发表。', noProposals:'还没有改进提案。提案以当前制品摘要为基线独立保存，不自动修改作品。', proposalLabel:'改进后的制品 JSON', proposalTitle:'提案标题（可选）', proposalHelp:'上传完整的修改后制品，保留基线作品的类型与 ID。不同版本可以作为提案，发布者在本地审阅后决定是否采用。', proposalBase:'当前基线 SHA-256', proposalAck:'我拥有改进制品的再分发权，并已审阅其中全部文件及许可证。', submitProposal:'提交提案', proposalSent:'提案已提交。基线作品未被修改。', downloadProposal:'下载提案制品', proposalDownload:'正在获取提案制品…', proposalMismatch:'提案必须使用与基线相同的作品类型与 ID。', signInEyebrow:'YOUR WORKSHOP ACCOUNT', accountTitle:'账号与分享权限', accountSubtitle:'访客可浏览和下载。受邀开发者可发布、评论与交换提案。社区账号不会连接或控制你的本机 Runtime。', login:'登录', register:'邀请注册', username:'用户名', usernameHelp:'3–40 位小写字母、数字、点、下划线或连字符，以字母或数字开头。', password:'密码', passwordHelp:'12–128 个字符。密码只用于本次请求，不保存在浏览器存储中。', invitation:'邀请码', invitationPlaceholder:'管理员提供的一次性邀请', loginSuccess:'已登录。', registered:'账号已创建并登录。', logout:'退出登录', loggedOut:'已退出登录。', administrator:'管理员', member:'开发者', adminTitle:'社区管理', adminSubtitle:'邀请码与账号状态属于此社区服务，不影响任何本地模块或实例。', mintInvite:'生成一次性邀请', inviteExpires:'有效期至 {date}', inviteSecret:'请通过你选择的渠道分享邀请码。它仅在此页面会话显示，不会自动发送。', copyInvite:'复制邀请码', usersTitle:'账号状态', usersLoading:'正在读取账号…', disableUser:'停用账号', enableUser:'恢复账号', disabled:'已停用', active:'可用', userUpdated:'账号状态已更新。', localTitle:'打开你自己的本地 Launcher', localText:'可选入口。请填写已经启动的本地 Launcher 地址；新窗口打开后，由本地 Launcher 独立验证身份。社区不会请求本机接口，也不会传递账号凭据。', launcherURL:'本地 Launcher 地址', launcherPlaceholder:'例如 http://127.0.0.1:4810/', openLauncher:'在独立窗口打开 ↗', invalidLauncher:'请输入不含凭据的 localhost、127.0.0.1 或 [::1] HTTP(S) 地址。', connection:'社区连接', changeLanguage:'界面语言已更新。', publicationMissing:'作品不存在或不可见。', retry:'重新加载', loadingDetail:'正在读取作品…', fileCount:'{count} 个文件', copiedURL:'已复制软件源地址，可在本地 Launcher 中添加。', adminOnly:'仅管理员可管理邀请和账号。', sourceIndex:'软件源索引', accountReady:'账号已就绪', uploadReadFailed:'文件读取或 JSON 解析失败。', adminSelf:'当前账号', commentCount:'{count} 条评论', proposalCount:'{count} 个提案', publishedTotal:'已发布 {count} 件作品', noUsers:'暂无账号。', licenseNotice:'作品由作者声明许可证。摘要用于确定内容身份，不证明作者身份或代码安全。'
  },
  en: {
    skip:'Skip to content', language:'Language', brandCaption:'Independent capabilities. Your combinations.', hosted:'Hosted community', catalog:'Discover', publish:'Publish', account:'My account', loading:'Loading…', footer:'A place to discover and share. Your local Launcher works independently of this community.', documentation:'Developer docs ↗', anonymous:'Browsing as a guest', heroEyebrow:'YOUR PROGRAMS, MORE POSSIBILITIES', heroBefore:'Discover capabilities.', heroAfter:'Build your own world.', heroText:'Share modules and packs. Connect independent programs through capability contracts. Developers own their work; you choose how to use it.', explore:'Explore the catalog', share:'Share your work', artSource:'Any source', artModule:'Independent modules', artPack:'Your combinations', collection:'Community works', items:'{count} works', search:'Search', searchPlaceholder:'Name, ID, or publisher', kind:'Type', allKinds:'All types', module:'Module', pack:'Pack', template:'Template', contract:'Capability contract', contractPlaceholder:'Exact contract ID', filter:'Filter', noPublications:'Start with the first building block.', noResults:'No matching works found.', emptyText:'Publish an independent module or pack and help other developers explore new combinations.', emptyFilter:'Try a different search, type, or capability contract.', provides:'Provides', requires:'Requires', noContracts:'No external contracts declared', comments:'Comments', proposals:'Proposals', unknownOwner:'Unknown publisher', previous:'Previous', next:'Next', page:'Page {page}', sourceTitle:'Explore with your own tools', sourceText:'Copy the open source index, then add and review it in your local Launcher.', copySource:'Copy source URL', viewSource:'View index ↗', boundary:'Sharing and downloading start no programs. Your own local Launcher or compatible tool handles import, code review, and execution. Hub remains a communication crossroads.', copied:'Copied.', copyUnavailable:'Automatic copy is unavailable. Copy this address: ', networkError:'The community is temporarily unavailable. Please try again.', refresh:'Retry', publishEyebrow:'SHARE YOUR BUILDING BLOCKS', publishTitle:'Help others discover your capabilities.', publishSubtitle:'Upload artifact.json exported by your local creator tools. The server stores and distributes files; it never runs uploaded code.', loginRequired:'Sign in or register with an invitation to publish works, comment, and submit proposals.', goAccount:'Go to my account', uploadTitle:'1. Choose an artifact', artifactLabel:'Artifact file', uploadHint:'world-hub.source-artifact/v1 · JSON · maximum 8 MiB', uploadHelp:'Publish to a new directory from the local Launcher creator workbench, then choose artifact.json. Runtime publishArtifact can also export it.', titleLabel:'Display title (optional)', titlePlaceholder:'Use the manifest title when blank', previewTitle:'2. Review the work', previewNote:'This preview comes from the uploaded file. The server independently validates format, hashes, paths, manifests, and license metadata. A preview does not establish code safety.', id:'Identity', version:'Version', license:'License', platforms:'Platforms', files:'Files', byteSize:'Upload size', contracts:'Capability contracts', notDeclared:'Not declared', previewNone:'Choose a file to see its preview.', redistribute:'I have reviewed all files, hold redistribution rights, and accept the licenses declared in their manifests.', publishConfirm:'Confirm publication', publishing:'Publishing…', published:'Published. Downloading does not execute code.', duplicate:'This version and digest are already published. Opening the existing work.', invalidArtifact:'Choose a complete world-hub.source-artifact/v1 JSON artifact.', fileTooLarge:'The file exceeds 8 MiB. Use a smaller artifact for this initial community.', invalidManifest:'The module or pack manifest cannot be read from this artifact.', immutable:'Versions cannot be overwritten', publishRules:'An ID and version identify an immutable artifact. Share a change with a new version; a different digest for the same version is refused.', initialQuota:'An initial, complete loop', quotaText:'Accounts are invite-only, with an 8 MiB limit per artifact. Server account, publication, and storage quotas explicitly refuse requests when full. Keep your original local files.', safeFiles:'Share prepared source files', safeFilesText:'Exclude keys, runtime data, caches, and local credentials. The server does not run uploads. Independently review downloaded code before execution.', backCatalog:'Back to the catalog', download:'Download artifact JSON', publisher:'Publisher', publishedAt:'Published', exactDigest:'Artifact SHA-256', downloadNote:'Review locally using Launcher software sources or a compatible tool. Downloads, comments, and proposals grant no execution permission.', hidden:'Hidden', hidePublication:'Hide this work', showPublication:'Show this work', visibilityChanged:'Publication visibility updated.', noComments:'No comments yet. Discuss uses, capability contracts, or your integration experience.', commentLabel:'Write a comment', commentPlaceholder:'Plain text, up to 4000 characters', sendComment:'Post comment', commentSent:'Comment posted.', noProposals:'No proposals yet. A proposal uses the current artifact digest as its base and is stored separately. It never changes the original automatically.', proposalLabel:'Improved artifact JSON', proposalTitle:'Proposal title (optional)', proposalHelp:'Upload the complete modified artifact, preserving the original kind and ID. Another version can be proposed; the publisher decides whether to adopt it after local review.', proposalBase:'Current base SHA-256', proposalAck:'I hold redistribution rights for this proposal and have reviewed all of its files and licenses.', submitProposal:'Submit proposal', proposalSent:'Proposal submitted. The base publication has not changed.', downloadProposal:'Download proposal artifact', proposalDownload:'Retrieving proposal artifact…', proposalMismatch:'A proposal must keep the base publication’s kind and ID.', signInEyebrow:'YOUR WORKSHOP ACCOUNT', accountTitle:'Your account and sharing permissions', accountSubtitle:'Guests can browse and download. Invited developers can publish, comment, and exchange proposals. A community account cannot connect to or control your local Runtime.', login:'Sign in', register:'Register with an invitation', username:'Username', usernameHelp:'3–40 lowercase letters, digits, dots, underscores, or hyphens; start with a letter or digit.', password:'Password', passwordHelp:'12–128 characters. Used only for this request and never saved in browser storage.', invitation:'Invitation', invitationPlaceholder:'A one-time invitation from an administrator', loginSuccess:'Signed in.', registered:'Account created. You are signed in.', logout:'Sign out', loggedOut:'Signed out.', administrator:'Administrator', member:'Developer', adminTitle:'Community administration', adminSubtitle:'Invitations and account status belong to this community. They do not affect local modules or instances.', mintInvite:'Create a one-time invitation', inviteExpires:'Expires {date}', inviteSecret:'Share the invitation through a channel you choose. It is shown only in this page session and is never sent automatically.', copyInvite:'Copy invitation', usersTitle:'Account status', usersLoading:'Loading accounts…', disableUser:'Disable account', enableUser:'Enable account', disabled:'Disabled', active:'Active', userUpdated:'Account status updated.', localTitle:'Open your own local Launcher', localText:'An optional shortcut. Enter the address of an already running local Launcher. It opens in a separate window and verifies its own identity. This community never calls local APIs or passes account credentials.', launcherURL:'Local Launcher address', launcherPlaceholder:'For example, http://127.0.0.1:4810/', openLauncher:'Open in a separate window ↗', invalidLauncher:'Enter an HTTP(S) localhost, 127.0.0.1, or [::1] address without credentials.', connection:'Community connection', changeLanguage:'Interface language updated.', publicationMissing:'The work does not exist or is not visible.', retry:'Reload', loadingDetail:'Loading this work…', fileCount:'{count} files', copiedURL:'Source URL copied. Add it in your local Launcher.', adminOnly:'Only administrators manage invitations and accounts.', sourceIndex:'Source index', accountReady:'Account ready', uploadReadFailed:'The file could not be read or parsed as JSON.', adminSelf:'Your account', commentCount:'{count} comments', proposalCount:'{count} proposals', publishedTotal:'{count} published works', noUsers:'No accounts to display.', licenseNotice:'Authors declare their licenses. Digests establish content identity, not publisher identity or code safety.'
  }
};
function initialLanguage() {
  try { const saved = localStorage.getItem('world-hub.workshop.language'); if (saved === 'zh' || saved === 'en') return saved; } catch {}
  return navigator.language?.startsWith('zh') ? 'zh' : 'en';
}
const state = { language:initialLanguage(), user:null, csrfToken:null, detail:null, catalog:null, request:0, publicationPreview:null, proposalPreview:null, invitation:null, users:null, search:'', kind:'', contract:'', offset:0, limit:24, launcherURL:'' };
const t = (key, variables = {}) => (languages[state.language][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? ''));
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'checked' || key === 'disabled' || key === 'required') node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [children].flat()) if (child !== undefined && child !== null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function button(text, action, cls = '') {
  const node = el('button', { type:'button', class:`button ${cls}`, text });
  if (action) node.addEventListener('click', action); return node;
}
const link = (text, href, cls = '') => el('a', { class:cls, href, text });
function external(text, href, cls = 'button') { return el('a', { href, class:cls, target:'_blank', rel:'noopener noreferrer', text }); }
const date = value => { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? '—' : new Intl.DateTimeFormat(state.language === 'zh' ? 'zh-CN' : 'en', { dateStyle:'medium', timeStyle:'short' }).format(parsed); };
const owner = value => value?.username ?? t('unknownOwner');
const sourceURL = () => new URL('index.json', base).href;
const publicationPath = id => `api/publications/${encodeURIComponent(id)}`;
const publicationHash = id => `#publication/${encodeURIComponent(id)}`;
function inform(text, error = false) { const notice = $('#notice'); notice.textContent = text; notice.classList.toggle('error',error); notice.hidden = !text; }
function replaceView(...children) { $('#view').replaceChildren(...children.filter(child => child !== null && child !== undefined)); }
function applyLanguage() {
  document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en'; $('#language').value = state.language;
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
  $('#account-indicator').textContent = state.user ? `${state.user.username} · ${t(state.user.role === 'admin' ? 'administrator' : 'member')}` : t('anonymous');
}
async function api(path, body) {
  const headers = { Accept:'application/json' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken; }
  let response;
  try { response = await fetch(new URL(path,base), { method:body === undefined ? 'GET' : 'POST', headers, credentials:'same-origin', body:body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error(t('networkError')); }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !['api/login','api/register'].includes(path)) { state.user = null; state.csrfToken = null; state.invitation = null; applyLanguage(); }
    const error = new Error(value.error?.message ?? t('networkError')); error.code = value.error?.code; throw error;
  }
  return value;
}
function errorText(error) { return `${error.code ? `[${error.code}] ` : ''}${error.message ?? t('networkError')}`; }
async function busy(node, operation) { node.disabled = true; node.setAttribute('aria-busy','true'); try { await operation(); } catch (error) { inform(errorText(error),true); } finally { node.disabled = false; node.removeAttribute('aria-busy'); } }
async function copy(text, message = t('copied')) { try { await navigator.clipboard.writeText(text); inform(message); } catch { inform(t('copyUnavailable') + text); } }
function empty(title, text, action) { return el('div',{class:'empty-state'},[el('span',{class:'empty-icon','aria-hidden':'true',text:'◇'}),el('h2',{text:title}),el('p',{text}),action]); }
let fieldSequence = 0;
function field(label, input, help) {
  const helpId = `field-help-${++fieldSequence}`;
  if (help) input.setAttribute('aria-describedby',helpId);
  return el('div',{class:'field'},[el('label',{},[el('span',{class:'field-label',text:label}),input]),help ? el('p',{id:helpId,class:'field-help',text:help}) : null]);
}
function heading(eyebrow, title, text) { return el('div',{class:'page-heading'},el('div',{},[el('div',{class:'eyebrow',text:eyebrow}),el('h1',{text:title}),el('p',{text})])); }
function contractText(list) { return Array.isArray(list) && list.length ? list.map(c => `${c.id}@${c.version}`).join(', ') : t('notDeclared'); }
function definitions(rows) { return el('dl',{class:'definition-list'},rows.flatMap(([name,value]) => [el('dt',{text:name}),el('dd',{text:value})])); }
function boundary() { return el('div',{class:'boundary-banner'},[el('span',{'aria-hidden':'true',text:'↗'}),el('p',{text:t('boundary')})]); }
function loginNotice() { return el('div',{class:'notice inline'},[el('p',{text:t('loginRequired')}),link(t('goAccount'),'#account','button small')]); }
function sourceStrip() { return el('div',{class:'source-strip'},[el('div',{},[el('h3',{text:t('sourceTitle')}),el('p',{text:t('sourceText')})]),el('div',{class:'source-actions'},[button(t('copySource'),() => copy(sourceURL(),t('copiedURL'))),external(t('viewSource'),sourceURL(),'button quiet')])]); }
function hero() {
  const node = (cls,icon,name) => el('div',{class:`art-node ${cls}`},[el('span',{class:'art-icon','aria-hidden':'true',text:icon}),el('span',{text:t(name)})]);
  return el('section',{class:'hero'},[el('div',{class:'hero-copy'},[el('div',{class:'eyebrow',text:t('heroEyebrow')}),el('h1',{},[t('heroBefore'),el('br'),el('em',{text:t('heroAfter')})]),el('p',{text:t('heroText')}),link(t('share'),'#publish','button primary')]),el('div',{class:'hero-art','aria-hidden':'true'},[el('div',{class:'orbit'}),el('div',{class:'orbit wide'}),el('div',{class:'orbit tall'}),el('span',{class:'orbit-core',text:'✳'}),node('one','◫','artSource'),node('two','◇','artModule'),node('three','⌘','artPack'),el('span',{class:'art-dot'})])]);
}
function card(item) {
  const contracts = [...(item.provides ?? []),...(item.requires ?? [])];
  return el('a',{class:'publication-card',href:publicationHash(item.entryId),'data-entry-id':item.entryId},[el('div',{class:'card-top'},[el('span',{class:`package-icon ${item.kind === 'module' ? 'module' : ''}`,'aria-hidden':'true',text:item.kind === 'module' ? '◇' : '⌘'}),el('span',{class:'pill',text:t(item.kind)})]),el('div',{},[el('h3',{text:item.title ?? item.id}),el('div',{class:'card-id',text:`${item.id} · ${item.version}`})]),el('div',{class:'card-contracts'},contracts.length ? contracts.slice(0,2).map(c => el('span',{class:'pill green',text:c.id})) : el('span',{class:'muted',text:item.license ?? t('noContracts')})),el('div',{class:'card-bottom'},[el('span',{class:'owner',text:owner(item.owner)}),el('span',{text:`${item.commentsCount ?? 0} ${t('comments')} · ${item.proposalsCount ?? 0} ${t('proposals')}`})])]);
}
function renderCatalog() {
  const search = el('input',{name:'search',type:'search',maxlength:128,value:state.search,placeholder:t('searchPlaceholder')});
  const kind = el('select',{name:'kind'},[['',t('allKinds')],['module',t('module')],['pack',t('pack')],['template',t('template')]].map(([value,text]) => el('option',{value,text}))); kind.value = state.kind;
  const contract = el('input',{name:'contract',maxlength:128,value:state.contract,placeholder:t('contractPlaceholder')});
  const filters = el('form',{id:'catalog-filter',class:'filters'},[el('label',{},[t('search'),search]),el('label',{},[t('kind'),kind]),el('label',{},[t('contract'),contract]),el('button',{type:'submit',class:'button',text:t('filter')})]);
  filters.addEventListener('submit',event => { event.preventDefault(); state.search = search.value.trim(); state.kind = kind.value; state.contract = contract.value.trim(); state.offset = 0; loadRoute(); });
  const total = state.catalog?.total ?? 0, items = state.catalog?.publications ?? [];
  const paging = el('div',{class:'pagination'},[button(t('previous'),() => { state.offset = Math.max(0,state.offset - state.limit); loadRoute(); }),el('span',{text:t('page',{page:Math.floor(state.offset/state.limit)+1})}),button(t('next'),() => { state.offset += state.limit; loadRoute(); })]);
  paging.firstChild.disabled = state.offset === 0; paging.lastChild.disabled = state.offset + state.limit >= total;
  replaceView(hero(),el('div',{class:'toolbar'},[el('div',{},[el('h2',{},[t('collection'),el('span',{class:'count',text:t('items',{count:total})})])]),filters]),items.length ? el('div',{class:'card-grid'},items.map(card)) : empty(t(state.search || state.contract || state.kind ? 'noResults' : 'noPublications'),t(state.search || state.contract || state.kind ? 'emptyFilter' : 'emptyText'),link(t('share'),'#publish','button primary')),total > state.limit ? paging : null,sourceStrip(),boundary());
}
async function readArtifact(file) {
  if (!file) return null;
  if (file.size > uploadMaximum) throw new Error(t('fileTooLarge'));
  let artifact;
  try { artifact = JSON.parse(await file.text()); } catch { throw new Error(t('uploadReadFailed')); }
  if (!artifact || artifact.format !== 'world-hub.source-artifact/v1' || !['module','pack','template'].includes(artifact.kind) || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 8192) throw new Error(t('invalidArtifact'));
  let manifest, lock;
  const decode = path => {
    const value = artifact.files.find(f => f.path === path)?.base64;
    if (typeof value !== 'string' || value.length > Math.ceil(uploadMaximum/3)*4) throw new Error(t('invalidManifest'));
    const decoded = Uint8Array.from(atob(value),c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded));
  };
  try { manifest = decode(artifact.kind === 'module' ? 'module.json' : artifact.kind === 'template' ? 'template.json' : 'pack.json'); if (artifact.kind !== 'module') lock = decode(artifact.kind === 'template' ? 'base/pack.lock' : 'pack.lock'); }
  catch { throw new Error(t('invalidManifest')); }
  if (manifest.id !== artifact.id || manifest.version !== artifact.version) throw new Error(t('invalidManifest'));
  return { artifact, manifest, size:file.size, fileName:file.name, platforms:artifact.kind !== 'module' ? [`${lock.platform?.os}-${lock.platform?.arch}`] : manifest.platforms };
}
function previewNode(preview) {
  if (!preview) return el('div',{class:'preview'},[el('h3',{text:t('previewTitle')}),el('p',{class:'form-help',text:t('previewNone')})]);
  const m = preview.manifest;
  return el('div',{class:'preview','data-testid':'artifact-preview'},[el('h3',{text:t('previewTitle')}),definitions([[t('kind'),t(preview.artifact.kind)],[t('id'),String(m.id)],[t('version'),String(m.version)],[t('license'),String(m.license ?? t('notDeclared'))],[t('platforms'),Array.isArray(preview.platforms) ? preview.platforms.join(', ') : t('notDeclared')],[t('files'),t('fileCount',{count:preview.artifact.files.length})],[t('byteSize'),`${(preview.size/1024).toFixed(1)} KiB`],[t('provides'),contractText(m.provides)],[t('requires'),contractText(m.requires)]]),el('p',{class:'field-help',text:t('previewNote')})]);
}
function acknowledgment(text,id) { const check = el('input',{type:'checkbox',id,required:true}); return { check, label:el('label',{class:'check'},[check,el('span',{text})]) }; }
function renderPublish() {
  state.publicationPreview = null;
  const upload = el('input',{id:'artifact-file',type:'file',accept:'.json,application/json',required:true});
  const title = el('input',{name:'title',maxlength:256,placeholder:t('titlePlaceholder')});
  const preview = el('div',{id:'publication-preview'},previewNode(null));
  const ack = acknowledgment(t('redistribute'),'redistribution-ack');
  const submit = el('button',{id:'publish-submit',type:'submit',class:'button primary',disabled:true,text:t('publishConfirm')});
  let readGeneration = 0;
  const available = () => { submit.disabled = !state.user || !state.publicationPreview || !ack.check.checked; };
  ack.check.addEventListener('change',available);
  upload.addEventListener('change',async () => {
    const generation = ++readGeneration; state.publicationPreview = null; ack.check.checked = false; available();
    try { const result = await readArtifact(upload.files[0]); if (generation !== readGeneration) return; state.publicationPreview = result; preview.replaceChildren(previewNode(result)); available(); }
    catch (error) { if (generation === readGeneration) { preview.replaceChildren(previewNode(null)); inform(errorText(error),true); } }
  });
  const form = el('form',{id:'publication-form',class:'panel'},[el('h2',{text:t('uploadTitle')}),el('div',{class:'upload-box'},[el('div',{class:'upload-icon','aria-hidden':'true',text:'⇧'}),field(t('artifactLabel'),upload),el('p',{text:t('uploadHint')})]),el('p',{class:'field-help',text:t('uploadHelp')}),el('div',{class:'form-actions'},field(t('titleLabel'),title)),preview,ack.label,el('div',{class:'form-actions'},submit)]);
  form.addEventListener('submit',event => { event.preventDefault(); if (!state.publicationPreview || !ack.check.checked || !state.user) return; busy(submit,async () => { const payload = {artifact:state.publicationPreview.artifact,redistributionAcknowledged:true}; if (title.value.trim()) payload.title = title.value.trim(); const result = await api('api/publications',payload); inform(t(result.duplicate ? 'duplicate' : 'published')); state.publicationPreview = null; location.hash = publicationHash(result.publication.entryId); }); });
  replaceView(heading(t('publishEyebrow'),t('publishTitle'),t('publishSubtitle')),!state.user ? loginNotice() : null,el('div',{class:'panels'},[form,el('div',{class:'stack'},[[t('immutable'),t('publishRules')],[t('initialQuota'),t('quotaText')],[t('safeFiles'),t('safeFilesText')]].map(([title,text]) => el('section',{class:'panel'},[el('h2',{text:title}),el('p',{class:'form-help',text})])))]),boundary());
}
function downloadLink(digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return el('p',{class:'muted',text:t('publicationMissing')});
  return el('a',{id:'artifact-download',class:'button primary',href:new URL(`artifacts/${digest}.json`,base).href,download:`${digest}.json`,text:t('download')});
}
async function downloadProposal(entryId,proposalId) {
  const result = await api(`${publicationPath(entryId)}/proposals/${encodeURIComponent(proposalId)}`);
  // Download data, never evaluate or load it as a script.
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.artifact)+'\n'],{type:'application/json'}));
  const anchor = el('a',{href:url,download:`proposal-${proposalId.replace(/[^a-z0-9._-]/gi,'_')}.json`});
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url),10000);
}
function commentsPanel(detail) {
  const comments = Array.isArray(detail.comments) ? detail.comments : [];
  const list = el('ul',{class:'comment-list'},comments.map(comment => el('li',{class:'comment'},[el('div',{class:'comment-meta'},[el('strong',{text:owner(comment.author)}),el('span',{text:date(comment.createdAt)})]),el('p',{text:comment.text})])));
  const panel = el('section',{class:'panel'},[el('h2',{text:t('commentCount',{count:comments.length})}),comments.length ? list : el('p',{class:'form-help',text:t('noComments')})]);
  if (!state.user) { panel.append(link(t('goAccount'),'#account','button small')); return panel; }
  const text = el('textarea',{name:'text',id:'comment-text',maxlength:4000,required:true,placeholder:t('commentPlaceholder')});
  const submit = el('button',{type:'submit',class:'button primary',text:t('sendComment')});
  const form = el('form',{id:'comment-form',class:'comment-form'},[field(t('commentLabel'),text),submit]);
  form.addEventListener('submit',event => { event.preventDefault(); if (!text.value.trim()) return; busy(submit,async () => { await api(`${publicationPath(detail.publication.entryId)}/comments`,{text:text.value.trim()}); inform(t('commentSent')); await loadRoute(); }); });
  panel.append(form); return panel;
}
function proposalsPanel(detail) {
  const proposals = Array.isArray(detail.proposals) ? detail.proposals : [];
  const panel = el('section',{class:'panel'},[el('h2',{text:t('proposalCount',{count:proposals.length})})]);
  if (!proposals.length) panel.append(el('p',{class:'form-help',text:t('noProposals')}));
  else panel.append(el('ul',{class:'proposal-list'},proposals.map(proposal => {
    const download = button(t('downloadProposal'),event => busy(event.currentTarget,() => downloadProposal(detail.publication.entryId,proposal.id)),'small');
    return el('li',{class:'proposal-item'},[el('h3',{text:proposal.title ?? `${proposal.artifactId} · ${proposal.version}`}),el('div',{class:'proposal-meta'},[el('span',{text:owner(proposal.author)}),el('span',{text:date(proposal.createdAt)})]),el('div',{class:'small-heading',text:t('proposalBase')}),el('code',{class:'digest',text:proposal.baseSha256}),download]);
  })));
  if (!state.user) { panel.append(link(t('goAccount'),'#account','button small')); return panel; }
  state.proposalPreview = null;
  const baseSha256 = detail.publication.sha256, entryId = detail.publication.entryId;
  const upload = el('input',{id:'proposal-file',type:'file',accept:'.json,application/json',required:true});
  const title = el('input',{name:'title',maxlength:256,placeholder:t('titlePlaceholder')});
  const ack = acknowledgment(t('proposalAck'),'proposal-ack');
  const preview = el('div',{id:'proposal-preview'});
  const submit = el('button',{id:'proposal-submit',type:'submit',class:'button',disabled:true,text:t('submitProposal')});
  let readGeneration = 0;
  const available = () => { submit.disabled = !state.proposalPreview || !ack.check.checked; };
  ack.check.addEventListener('change',available);
  upload.addEventListener('change',async () => { const generation = ++readGeneration; state.proposalPreview = null; ack.check.checked = false; preview.replaceChildren(); available(); try { const result = await readArtifact(upload.files[0]); if (generation !== readGeneration) return; if (result && (result.artifact.kind !== detail.publication.kind || result.artifact.id !== detail.publication.id)) throw new Error(t('proposalMismatch')); state.proposalPreview = result; preview.replaceChildren(previewNode(result)); available(); } catch (error) { if (generation === readGeneration) inform(errorText(error),true); } });
  const form = el('form',{id:'proposal-form',class:'comment-form'},[field(t('proposalLabel'),upload,t('proposalHelp')),field(t('proposalTitle'),title),el('div',{class:'small-heading',text:t('proposalBase')}),el('code',{class:'digest',text:baseSha256}),preview,ack.label,submit]);
  form.addEventListener('submit',event => { event.preventDefault(); if (!state.proposalPreview || !ack.check.checked) return; busy(submit,async () => { const body = { artifact:state.proposalPreview.artifact,baseSha256,redistributionAcknowledged:true }; if (title.value.trim()) body.title = title.value.trim(); await api(`${publicationPath(entryId)}/proposals`,body); inform(t('proposalSent')); await loadRoute(); }); });
  panel.append(form); return panel;
}
function renderDetail() {
  const detail = state.detail, p = detail.publication, entry = detail.entry;
  const controls = [];
  if (state.user?.role === 'admin') controls.push(button(t(p.hidden ? 'showPublication' : 'hidePublication'),event => busy(event.currentTarget,async () => { await api(`${publicationPath(p.entryId)}/visibility`,{hidden:!p.hidden}); inform(t('visibilityChanged')); await loadRoute(); }),'small danger'));
  const aside = el('aside',{class:'panel detail-aside'},[el('h2',{text:t('download')}),downloadLink(p.sha256),el('p',{text:t('downloadNote')}),el('div',{class:'small-heading',text:t('exactDigest')}),el('code',{class:'digest',text:p.sha256}),button(t('copySource'),() => copy(sourceURL(),t('copiedURL')),'small'),el('p',{text:t('licenseNotice')}),...controls]);
  const metadata = el('section',{class:'panel'},[el('h2',{text:aboutWork[state.language]}),definitions([[t('id'),p.id],[t('version'),p.version],[t('license'),entry.license],[t('platforms'),entry.platforms.join(', ')],[t('provides'),contractText(entry.provides)],[t('requires'),contractText(entry.requires)],[t('publisher'),owner(p.owner)],[t('publishedAt'),date(p.createdAt)]])]);
  replaceView(link(`← ${t('backCatalog')}`,'#catalog','back-link'),el('div',{class:'detail-heading'},[el('span',{class:`package-icon ${p.kind === 'module' ? 'module' : ''}`,'aria-hidden':'true',text:p.kind === 'module' ? '◇' : '⌘'}),el('div',{},[el('h1',{text:p.title}),el('div',{class:'detail-id',text:`${p.id} · ${p.version}`})])]),el('div',{class:'detail-meta'},[el('span',{class:'pill green',text:t(p.kind)}),el('span',{class:'pill',text:entry.license}),p.hidden ? el('span',{class:'pill amber',text:t('hidden')}) : null]),el('div',{class:'detail-layout'},[el('div',{class:'stack'},[metadata,commentsPanel(detail),proposalsPanel(detail)]),aside]),boundary());
}
function authForm(kind) {
  const username = el('input',{name:'username',id:`${kind}-username`,autocomplete:'username',required:true,minlength:3,maxlength:40,pattern:'[a-z0-9][a-z0-9._\\-]{2,39}',autocapitalize:'none',spellcheck:'false'});
  const password = el('input',{name:'password',id:`${kind}-password`,type:'password',autocomplete:kind === 'login' ? 'current-password' : 'new-password',required:true,minlength:12,maxlength:128});
  const invitation = kind === 'register' ? el('input',{name:'invitation',id:'register-invitation',required:true,autocomplete:'off',placeholder:t('invitationPlaceholder'),maxlength:256,spellcheck:'false'}) : null;
  const submit = el('button',{type:'submit',class:`button ${kind === 'login' ? 'primary' : ''}`,text:t(kind)});
  const form = el('form',{id:`${kind}-form`,class:'panel'},[el('h2',{text:t(kind)}),field(t('username'),username,t('usernameHelp')),field(t('password'),password,t('passwordHelp')),invitation ? field(t('invitation'),invitation) : null,submit]);
  form.addEventListener('submit',event => { event.preventDefault(); const body = {username:username.value,password:password.value}; if (invitation) body.invitation = invitation.value.trim(); busy(submit,async () => { try { const session = await api(`api/${kind}`,body); state.user = session.user; state.csrfToken = session.csrfToken; state.invitation = null; applyLanguage(); inform(t(kind === 'login' ? 'loginSuccess' : 'registered')); await loadRoute(); } finally { password.value = ''; body.password = ''; } }); });
  return form;
}
function localLauncherPanel() {
  const url = el('input',{id:'local-launcher-url',type:'url',value:state.launcherURL,placeholder:t('launcherPlaceholder'),required:true,autocomplete:'off'});
  const form = el('form',{id:'local-launcher-form',class:'panel'},[el('h2',{text:t('localTitle')}),el('p',{class:'form-help',text:t('localText')}),field(t('launcherURL'),url),el('button',{type:'submit',class:'button',text:t('openLauncher')})]);
  form.addEventListener('submit',event => { event.preventDefault(); try { const target = new URL(url.value); if (!['http:','https:'].includes(target.protocol) || !['localhost','127.0.0.1','[::1]'].includes(target.hostname) || target.username || target.password || target.search || target.hash) throw new Error(t('invalidLauncher')); state.launcherURL = target.href; window.open(target.href,'_blank','noopener,noreferrer'); } catch { inform(t('invalidLauncher'),true); } });
  return form;
}
function adminPanel() {
  const mint = button(t('mintInvite'),event => busy(event.currentTarget,async () => { state.invitation = await api('api/invitations',{}); renderAccount(); }),'small');
  const invite = state.invitation ? el('div',{},[el('div',{class:'invitation-code',text:state.invitation.invitation}),el('p',{class:'field-help',text:t('inviteExpires',{date:date(state.invitation.expiresAt)})}),el('p',{class:'field-help',text:t('inviteSecret')}),button(t('copyInvite'),() => copy(state.invitation.invitation),'small')]) : null;
  const users = state.users?.length ? el('ul',{class:'user-list'},state.users.map(user => {
    const status = button(t(user.disabled ? 'enableUser' : 'disableUser'),event => busy(event.currentTarget,async () => { await api(`api/users/${encodeURIComponent(user.id)}/status`,{disabled:!user.disabled}); inform(t('userUpdated')); await loadRoute(); }),'small');
    if (user.id === state.user?.id) status.disabled = true;
    return el('li',{class:'user-item'},[el('div',{},[el('span',{class:'name',text:user.username}),el('span',{class:`pill ${user.disabled ? 'amber' : 'green'}`,text:`${t(user.role === 'admin' ? 'administrator' : 'member')} · ${t(user.disabled ? 'disabled' : 'active')}`}),user.id === state.user?.id ? el('span',{class:'field-help',text:` · ${t('adminSelf')}`}) : null]),status]);
  })) : el('p',{class:'form-help',text:t(state.users ? 'noUsers' : 'usersLoading')});
  return el('section',{class:'panel'},[el('h2',{text:t('adminTitle')}),el('p',{class:'form-help',text:t('adminSubtitle')}),mint,invite,el('h3',{class:'small-heading',text:t('usersTitle')}),users]);
}
function renderAccount() {
  const intro = heading(t('signInEyebrow'),t('accountTitle'),t('accountSubtitle'));
  if (!state.user) { replaceView(intro,el('div',{class:'panels'},[authForm('login'),authForm('register')]),el('div',{class:'source-strip'},localLauncherPanel())); return; }
  const logout = button(t('logout'),event => busy(event.currentTarget,async () => { await api('api/logout',{}); state.user = null; state.csrfToken = null; state.invitation = null; state.users = null; state.detail = null; applyLanguage(); inform(t('loggedOut')); await loadRoute(); }));
  const profile = el('section',{class:'panel'},[el('div',{class:'account-card'},[el('div',{class:'avatar','aria-hidden':'true',text:'◎'}),el('div',{},[el('h2',{text:state.user.username}),el('span',{class:'pill green',text:t(state.user.role === 'admin' ? 'administrator' : 'member')})])]),el('p',{class:'form-help',text:t('accountSubtitle')}),el('div',{class:'form-actions'},[link(t('publish'),'#publish','button primary'),logout])]);
  replaceView(intro,el('div',{class:'panels'},[el('div',{class:'stack'},[profile,localLauncherPanel()]),state.user.role === 'admin' ? adminPanel() : el('section',{class:'panel'},[el('h2',{text:t('sourceTitle')}),el('p',{class:'form-help',text:t('sourceText')}),el('code',{class:'digest',text:sourceURL()}),button(t('copySource'),() => copy(sourceURL(),t('copiedURL'))),boundary()]) ]));
}
function route() {
  const raw = location.hash.slice(1) || 'catalog';
  if (raw.startsWith('publication/')) { try { return {view:'detail',entryId:decodeURIComponent(raw.slice(12))}; } catch {} }
  return {view:['catalog','publish','account'].includes(raw) ? raw : 'catalog'};
}
async function loadRoute() {
  const request = ++state.request, target = route();
  for (const node of document.querySelectorAll('[data-nav]')) { if (node.dataset.nav === (target.view === 'detail' ? 'catalog' : target.view)) node.setAttribute('aria-current','page'); else node.removeAttribute('aria-current'); }
  $('#view').setAttribute('aria-busy','true');
  try {
    if (target.view === 'catalog') {
      const params = new URLSearchParams({search:state.search,kind:state.kind,contract:state.contract,offset:String(state.offset),limit:String(state.limit)});
      const catalog = await api(`api/catalog?${params}`); if (request !== state.request) return; state.catalog = catalog; renderCatalog();
    } else if (target.view === 'detail') {
      $('#view').replaceChildren(empty(t('loadingDetail'),''));
      const detail = await api(publicationPath(target.entryId)); if (request !== state.request) return; state.detail = detail; renderDetail();
    } else if (target.view === 'publish') renderPublish();
    else {
      state.users = null; renderAccount();
      if (state.user?.role === 'admin') { const result = await api('api/users'); if (request !== state.request) return; state.users = result.users; renderAccount(); }
    }
  } catch (error) { if (request !== state.request) return; inform(errorText(error),true); $('#view').replaceChildren(empty(t(target.view === 'detail' ? 'publicationMissing' : 'networkError'),'',button(t('retry'),loadRoute))); }
  finally { if (request === state.request) $('#view').setAttribute('aria-busy','false'); }
}
$('#language').addEventListener('change',() => { state.language = $('#language').value === 'en' ? 'en' : 'zh'; try { localStorage.setItem('world-hub.workshop.language',state.language); } catch {} applyLanguage(); inform(''); loadRoute(); });
$('.skip-link').addEventListener('click',event => { event.preventDefault(); $('#main').focus(); $('#main').scrollIntoView(); });
window.addEventListener('hashchange',async () => { await loadRoute(); $('#main').focus({preventScroll:true}); window.scrollTo({top:0,behavior:'auto'}); });
applyLanguage();
try { const session = await api('api/me'); state.user = session.user; state.csrfToken = session.csrfToken ?? null; applyLanguage(); }
catch (error) { inform(errorText(error),true); }
await loadRoute();
