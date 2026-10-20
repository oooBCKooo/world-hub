// Workshop is an optional distribution service. This page never executes code
// or contacts local management APIs. Remote strings are rendered as text only.
import { renderArtifactConfiguration } from './artifact-config-view.mjs';
const base = new URL('./', import.meta.url);
const $ = selector => document.querySelector(selector);
const uploadMaximum = 96 * 1024 * 1024;
const aboutWork = { zh:'作品信息', en:'About this work' };
const languages = {
  zh: {
    skip:'跳至内容', language:'语言', brandCaption:'独立能力，自由组合', hosted:'托管社区', catalog:'发现作品', publish:'发布作品', account:'我的账号', loading:'正在加载…', footer:'社区提供模块本体、模块配置与模块数据的发现和分享。本机 Hub 无需社区也能独立运行。', documentation:'开发者文档 ↗', anonymous:'浏览访客', heroEyebrow:'YOUR PROGRAMS, MORE POSSIBILITIES', heroBefore:'发现独立能力，', heroAfter:'组合你的世界。', heroText:'模块由程序及其枢纽桥组成。分别分享模块本体、模块配置与现成数据集，沿着能力契约连接程序。作品属于开发者，如何使用由你决定。', explore:'浏览作品', share:'分享你的作品', artSource:'信息来源', artModule:'独立模块', artGroup:'自由组合', collection:'社区作品', items:'{count} 件作品', search:'搜索', searchPlaceholder:'名称、ID 或发布者', kind:'作品类型', allKinds:'全部类型', module:'模块本体', configuration:'模块配置', data:'模块数据', contract:'能力契约', contractPlaceholder:'契约 ID（精确匹配）', filter:'筛选', noPublications:'从第一件作品开始。', noResults:'没有找到匹配的作品。', emptyText:'发布模块本体、模块配置或现成数据集，让其他开发者探索新的组合。', emptyFilter:'试试其他关键词、类型或能力契约。', provides:'提供能力', requires:'需要能力', noContracts:'未声明外部契约', comments:'评论', proposals:'提案', unknownOwner:'未知发布者', previous:'上一页', next:'下一页', page:'第 {page} 页', sourceTitle:'用你自己的入口探索', sourceText:'复制开放的软件源索引，在本机通讯管理界面的社区来源中添加并审阅。', copySource:'复制软件源地址', viewSource:'查看索引 ↗', boundary:'分享与下载不启动任何程序。请在本机通讯管理界面导入模块本体、模块配置或模块数据并独立审阅，再决定是否启动。Hub 只负责通信。', copied:'已复制。', copyUnavailable:'无法自动复制，请复制此地址：', networkError:'暂时无法连接社区，请稍后重试。', refresh:'重试', publishEyebrow:'SHARE YOUR BUILDING BLOCKS', publishTitle:'让能力被更多人发现。', publishSubtitle:'上传通讯管理界面或开发者工具导出的 artifact.json。服务器保存和分发文件，不运行上传的代码。', loginRequired:'请先登录或使用邀请注册，再发布作品、发表评论与提交提案。', goAccount:'前往账号', uploadTitle:'1. 选择作品制品', artifactLabel:'制品文件', uploadHint:'world-hub.source-artifact/v1 · JSON · 最大 96 MiB', uploadHelp:'选择模块本体、模块配置或模块数据的 artifact.json。三类制品独立版本；全局／局部是配置与数据的范围。配置引用模块本体摘要，数据集包含现成业务文件。私有备份仅可在本机导入导出。', titleLabel:'显示标题（可选）', titlePlaceholder:'留空则使用清单中的标题', previewTitle:'2. 审阅作品信息', previewNote:'此处预览来自上传文件。服务器将独立验证格式、文件摘要、路径、清单与许可证；预览不是代码安全认证。', id:'标识', version:'版本', license:'许可证', platforms:'平台', files:'文件数', byteSize:'上传体积', contracts:'能力契约', notDeclared:'未声明', previewNone:'选择文件后显示预览。', redistribute:'我已审阅将分享的全部文件，拥有再分发权，并接受文件清单声明的许可证。', publishConfirm:'确认发布', publishing:'正在发布…', published:'作品已发布。下载不会自动执行代码。', duplicate:'该版本与摘要已发布，打开已有作品。', invalidArtifact:'请选择完整的 world-hub.source-artifact/v1 JSON 制品。', fileTooLarge:'制品 JSON 超过 96 MiB；单文件最多 8 MiB，解码后的文件合计最多 64 MiB。', invalidManifest:'无法读取制品中的模块本体、模块配置或模块数据清单。', immutable:'版本不可覆盖', publishRules:'每个 ID 与版本对应不可覆盖的制品。要分享修改，请使用新版本；相同版本的不同摘要会被拒绝。', initialQuota:'初期闭环', quotaText:'邀请制账号，单次制品 JSON 不超过 96 MiB，单文件最多 8 MiB，解码后合计最多 64 MiB。服务端设有账号、发布与存储配额，达到上限会明确拒绝；保留本地原始文件。', safeFiles:'只分享准备公开的资源', safeFilesText:'可公开分享已审阅的现成数据集；不要上传私有备份、密钥、缓存或本地环境凭据。服务端不会执行上传制品，下载后的代码仍需你独立审阅。', backCatalog:'返回作品目录', download:'下载制品 JSON', publisher:'发布者', publishedAt:'发布于', exactDigest:'制品 SHA-256', downloadNote:'下载后，在本机通讯管理界面按资源类型导入模块本体、模块配置或模块数据并审阅。配置中的逻辑实例引用精确的模块本体版本和摘要。下载、评论或提案都不授予运行权限。', hidden:'已隐藏', hidePublication:'隐藏作品', showPublication:'恢复展示', visibilityChanged:'作品展示状态已更新。', noComments:'还没有评论。可以从用途、能力契约或接入体验开始讨论。', commentLabel:'写一条评论', commentPlaceholder:'纯文本，最多 4000 字符', sendComment:'发表评论', commentSent:'评论已发表。', noProposals:'还没有改进提案。提案以当前制品摘要为基线独立保存，不自动修改作品。', proposalLabel:'改进后的制品 JSON', proposalTitle:'提案标题（可选）', proposalHelp:'上传完整的修改后制品，保留基线作品的类型与 ID。不同版本可以作为提案，发布者在本地审阅后决定是否采用。', proposalBase:'当前基线 SHA-256', proposalAck:'我拥有改进制品的再分发权，并已审阅其中全部文件及许可证。', submitProposal:'提交提案', proposalSent:'提案已提交。基线作品未被修改。', downloadProposal:'下载提案制品', proposalDownload:'正在获取提案制品…', proposalMismatch:'提案必须使用与基线相同的作品类型与 ID。', signInEyebrow:'YOUR WORKSHOP ACCOUNT', accountTitle:'账号与分享权限', accountSubtitle:'访客可浏览和下载。受邀开发者可发布、评论与交换提案。社区账号不会连接或控制你的本机 Runtime。', login:'登录', register:'邀请注册', username:'用户名', usernameHelp:'3–40 位小写字母、数字、点、下划线或连字符，以字母或数字开头。', password:'密码', passwordHelp:'12–128 个字符。密码只用于本次请求，不保存在浏览器存储中。', invitation:'邀请码', invitationPlaceholder:'管理员提供的一次性邀请', loginSuccess:'已登录。', registered:'账号已创建并登录。', logout:'退出登录', loggedOut:'已退出登录。', administrator:'管理员', member:'开发者', adminTitle:'社区管理', adminSubtitle:'邀请码与账号状态属于此社区服务，不影响任何本地模块或实例。', mintInvite:'生成一次性邀请', inviteExpires:'有效期至 {date}', inviteSecret:'请通过你选择的渠道分享邀请码。它仅在此页面会话显示，不会自动发送。', copyInvite:'复制邀请码', usersTitle:'账号状态', usersLoading:'正在读取账号…', disableUser:'停用账号', enableUser:'恢复账号', disabled:'已停用', active:'可用', userUpdated:'账号状态已更新。', localTitle:'打开本机通讯管理界面', localText:'可选入口。填写已经启动的本机通讯管理界面地址；新窗口由本机界面独立验证身份。社区不会请求本机接口，也不会传递账号凭据。', localHubURL:'本机通讯管理界面地址', localHubPlaceholder:'例如 http://127.0.0.1:51780/manage/', openLocalHub:'在独立窗口打开 ↗', invalidLocalHub:'请输入不含凭据的 localhost、127.0.0.1 或 [::1] HTTP(S) 地址。', connection:'社区连接', changeLanguage:'界面语言已更新。', publicationMissing:'作品不存在或不可见。', retry:'重新加载', loadingDetail:'正在读取作品…', fileCount:'{count} 个文件', copiedURL:'已复制软件源地址，可在本机通讯管理界面的社区来源中添加。', adminOnly:'仅管理员可管理邀请和账号。', sourceIndex:'软件源索引', accountReady:'账号已就绪', uploadReadFailed:'文件读取或 JSON 解析失败。', adminSelf:'当前账号', commentCount:'{count} 条评论', proposalCount:'{count} 个提案', publishedTotal:'已发布 {count} 件作品', noUsers:'暂无账号。', licenseNotice:'作品由作者声明许可证。摘要用于确定内容身份，不证明作者身份或代码安全。'
  },
  en: {
    skip:'Skip to content', language:'Language', brandCaption:'Independent capabilities. Your combinations.', hosted:'Hosted community', catalog:'Discover', publish:'Publish', account:'My account', loading:'Loading…', footer:'Discover and share module bodies, configurations, and data. Your local Hub works independently of this community.', documentation:'Developer docs ↗', anonymous:'Browsing as a guest', heroEyebrow:'YOUR PROGRAMS, MORE POSSIBILITIES', heroBefore:'Discover capabilities.', heroAfter:'Build your own world.', heroText:'A module combines a program with the hub bridges it uses to connect. Share module bodies, configurations, and ready-to-use datasets independently through capability contracts. Developers own their work; you choose how to use it.', explore:'Explore the catalog', share:'Share your work', artSource:'Any source', artModule:'Independent modules', artGroup:'Your combinations', collection:'Community works', items:'{count} works', search:'Search', searchPlaceholder:'Name, ID, or publisher', kind:'Type', allKinds:'All types', module:'Module body', configuration:'Module configuration', data:'Module data', contract:'Capability contract', contractPlaceholder:'Exact contract ID', filter:'Filter', noPublications:'Start with the first building block.', noResults:'No matching works found.', emptyText:'Publish a module body, configuration, or ready-to-use dataset and help other developers explore new combinations.', emptyFilter:'Try a different search, type, or capability contract.', provides:'Provides', requires:'Requires', noContracts:'No external contracts declared', comments:'Comments', proposals:'Proposals', unknownOwner:'Unknown publisher', previous:'Previous', next:'Next', page:'Page {page}', sourceTitle:'Explore with your own tools', sourceText:'Copy the open source index, then add and review it in Community sources in your local communication interface.', copySource:'Copy source URL', viewSource:'View index ↗', boundary:'Sharing and downloading start no programs. Import module bodies, configurations, or data in your local communication interface, review them independently, then choose whether to start them. Hub remains a communication crossroads.', copied:'Copied.', copyUnavailable:'Automatic copy is unavailable. Copy this address: ', networkError:'The community is temporarily unavailable. Please try again.', refresh:'Retry', publishEyebrow:'SHARE YOUR BUILDING BLOCKS', publishTitle:'Help others discover your capabilities.', publishSubtitle:'Upload artifact.json exported by the communication interface or developer tools. The server stores and distributes files; it never runs uploaded code.', loginRequired:'Sign in or register with an invitation to publish works, comment, and submit proposals.', goAccount:'Go to my account', uploadTitle:'1. Choose an artifact', artifactLabel:'Artifact file', uploadHint:'world-hub.source-artifact/v1 · JSON · maximum 96 MiB', uploadHelp:'Choose artifact.json for a module body, configuration, or data resource. Each kind has independent versions. Global/local describes the scope of configuration and data. Configurations pin module body digests; datasets contain ready-to-use business files. Private backups stay on your computer.', titleLabel:'Display title (optional)', titlePlaceholder:'Use the manifest title when blank', previewTitle:'2. Review the work', previewNote:'This preview comes from the uploaded file. The server independently validates format, hashes, paths, manifests, and license metadata. A preview does not establish code safety.', id:'Identity', version:'Version', license:'License', platforms:'Platforms', files:'Files', byteSize:'Upload size', contracts:'Capability contracts', notDeclared:'Not declared', previewNone:'Choose a file to see its preview.', redistribute:'I have reviewed all files, hold redistribution rights, and accept the licenses declared in their manifests.', publishConfirm:'Confirm publication', publishing:'Publishing…', published:'Published. Downloading does not execute code.', duplicate:'This version and digest are already published. Opening the existing work.', invalidArtifact:'Choose a complete world-hub.source-artifact/v1 JSON artifact.', fileTooLarge:'Artifact JSON exceeds 96 MiB. Each decoded file is limited to 8 MiB, with 64 MiB total.', invalidManifest:'The module body, configuration, or data manifest cannot be read from this artifact.', immutable:'Versions cannot be overwritten', publishRules:'An ID and version identify an immutable artifact. Share a change with a new version; a different digest for the same version is refused.', initialQuota:'An initial, complete loop', quotaText:'Accounts are invite-only, with a 96 MiB artifact JSON limit, 8 MiB per decoded file, and 64 MiB total decoded files. Server account, publication, and storage quotas explicitly refuse requests when full. Keep your original local files.', safeFiles:'Share prepared public resources', safeFilesText:'Reviewed ready-to-use datasets may be shared. Exclude private backups, keys, caches, and local credentials. The server does not run uploads. Independently review downloaded code before execution.', backCatalog:'Back to the catalog', download:'Download artifact JSON', publisher:'Publisher', publishedAt:'Published', exactDigest:'Artifact SHA-256', downloadNote:'Import and review the module body, configuration, or data in your local communication interface. Configurations pin exact module body versions and digests. Downloads, comments, and proposals grant no execution permission.', hidden:'Hidden', hidePublication:'Hide this work', showPublication:'Show this work', visibilityChanged:'Publication visibility updated.', noComments:'No comments yet. Discuss uses, capability contracts, or your integration experience.', commentLabel:'Write a comment', commentPlaceholder:'Plain text, up to 4000 characters', sendComment:'Post comment', commentSent:'Comment posted.', noProposals:'No proposals yet. A proposal uses the current artifact digest as its base and is stored separately. It never changes the original automatically.', proposalLabel:'Improved artifact JSON', proposalTitle:'Proposal title (optional)', proposalHelp:'Upload the complete modified artifact, preserving the original kind and ID. Another version can be proposed; the publisher decides whether to adopt it after local review.', proposalBase:'Current base SHA-256', proposalAck:'I hold redistribution rights for this proposal and have reviewed all of its files and licenses.', submitProposal:'Submit proposal', proposalSent:'Proposal submitted. The base publication has not changed.', downloadProposal:'Download proposal artifact', proposalDownload:'Retrieving proposal artifact…', proposalMismatch:'A proposal must keep the base publication’s kind and ID.', signInEyebrow:'YOUR WORKSHOP ACCOUNT', accountTitle:'Your account and sharing permissions', accountSubtitle:'Guests can browse and download. Invited developers can publish, comment, and exchange proposals. A community account cannot connect to or control your local Hub.', login:'Sign in', register:'Register with an invitation', username:'Username', usernameHelp:'3–40 lowercase letters, digits, dots, underscores, or hyphens; start with a letter or digit.', password:'Password', passwordHelp:'12–128 characters. Used only for this request and never saved in browser storage.', invitation:'Invitation', invitationPlaceholder:'A one-time invitation from an administrator', loginSuccess:'Signed in.', registered:'Account created. You are signed in.', logout:'Sign out', loggedOut:'Signed out.', administrator:'Administrator', member:'Developer', adminTitle:'Community administration', adminSubtitle:'Invitations and account status belong to this community. They do not affect local modules or instances.', mintInvite:'Create a one-time invitation', inviteExpires:'Expires {date}', inviteSecret:'Share the invitation through a channel you choose. It is shown only in this page session and is never sent automatically.', copyInvite:'Copy invitation', usersTitle:'Account status', usersLoading:'Loading accounts…', disableUser:'Disable account', enableUser:'Enable account', disabled:'Disabled', active:'Active', userUpdated:'Account status updated.', localTitle:'Open your local communication interface', localText:'An optional shortcut to an already running local communication interface. It opens in a separate window and verifies its own identity. This community never calls local APIs or passes account credentials.', localHubURL:'Local communication interface URL', localHubPlaceholder:'For example, http://127.0.0.1:51780/manage/', openLocalHub:'Open in a separate window ↗', invalidLocalHub:'Enter an HTTP(S) localhost, 127.0.0.1, or [::1] address without credentials.', connection:'Community connection', changeLanguage:'Interface language updated.', publicationMissing:'The work does not exist or is not visible.', retry:'Reload', loadingDetail:'Loading this work…', fileCount:'{count} files', copiedURL:'Source URL copied. Add it in Community sources in your local communication interface.', adminOnly:'Only administrators manage invitations and accounts.', sourceIndex:'Source index', accountReady:'Account ready', uploadReadFailed:'The file could not be read or parsed as JSON.', adminSelf:'Your account', commentCount:'{count} comments', proposalCount:'{count} proposals', publishedTotal:'{count} published works', noUsers:'No accounts to display.', licenseNotice:'Authors declare their licenses. Digests establish content identity, not publisher identity or code safety.'
  }
};
Object.assign(languages.zh, { evidenceLabel:'发布者公共证据（可选）', evidenceHint:'选择本机已签好的公共 JSON，最大 256 KiB。不要选择私钥；签名不等于实名或安全审计。', evidenceInvalid:'请选择只包含公共声明、公钥与签名的发布者证据 JSON。', evidenceDownload:'下载发布者公共证据', evidenceStatus:'已附公共证据；请在本地独立核对身份锚与当前状态。', evidenceBoundary:'社区账号、制品摘要、密码学签名、本地身份锚与执行授权彼此独立。社区不保管私钥，不授予执行权限。' });
Object.assign(languages.en, { evidenceLabel:'Public publisher evidence (optional)', evidenceHint:'Choose public JSON already signed on your computer, up to 256 KiB. Never choose a private key; a signature is neither real-world identity nor a safety audit.', evidenceInvalid:'Choose publisher evidence JSON containing only public statements, keys, and signatures.', evidenceDownload:'Download public publisher evidence', evidenceStatus:'Public evidence attached. Independently verify identity anchors and current status locally.', evidenceBoundary:'Community accounts, artifact digests, cryptographic signatures, local identity anchors, and execution permission are separate. This service holds no private keys and grants no execution permission.' });
function initialLanguage() {
  try { const saved = localStorage.getItem('world-hub.workshop.language'); if (saved === 'zh' || saved === 'en') return saved; } catch {}
  return navigator.language?.startsWith('zh') ? 'zh' : 'en';
}
Object.assign(languages.zh, { versionCount:'{count} 个版本', chooseVersion:'选择版本', scope:'范围', global:'全局', local:'局部', dataset:'公开数据集', backupRejected:'私有备份仅可在本机导入导出，不能发布到社区。', resourceTypes:'独立版本的三类资源', moduleHelp:'程序源码、运行依赖与作者默认声明', configurationHelp:'逻辑实例、模块摘要依赖、接线、参数与默认运行策略', dataHelp:'适配模块与数据格式明确的现成业务数据集' });
Object.assign(languages.en, { versionCount:'{count} versions', chooseVersion:'Choose a version', scope:'Scope', global:'Global', local:'Local', dataset:'Public dataset', backupRejected:'Private backups are for local import and export only and cannot be published to the community.', resourceTypes:'Three independently versioned resources', moduleHelp:'Program source, runtime dependencies, and author defaults', configurationHelp:'Logical instances, pinned module dependencies, wiring, settings, and default execution policies', dataHelp:'Ready-to-use business datasets with explicit compatible modules and data formats' });
Object.assign(languages.zh, {
  versionHistory:'版本历史', onePublishedVersion:'作者目前只发布了这一个版本。', versionHelp:'按你的兼容性与使用需求选择已发布版本；下载始终对应当前选中的版本。', currentVersion:'当前选择：{version}', viewVersions:'查看 {count} 个版本',
  presentationTitle:'作品图片（可选）', presentationHelp:'上传图标、封面和最多 6 张预览图，帮助使用者辨认作品。仅支持静态 PNG、JPEG、WebP；图标最大 512 KiB，其他图片每张最大 1 MiB，合计最大 5 MiB。',
  iconLabel:'图标', coverLabel:'封面', screenshotsLabel:'预览图（最多 6 张）', imageAlt:'图片说明', imageAltPlaceholder:'简短描述图片内容，方便无法看到图片的人理解', imageRemove:'移除', imageReadPending:'正在读取图片…', imageInvalid:'无法读取图片。请选择限制内的 PNG、JPEG 或 WebP 图片。', imageTotalTooLarge:'图片合计超过 5 MiB，请减少图片或缩小文件。', imageCountTooMany:'最多选择 6 张预览图。', imagePreviewTitle:'作品预览', imageOpen:'查看完整图片：{name}', screenshotName:'预览图 {number}', editPresentation:'编辑作品图片', presentationSave:'保存图片', presentationSaved:'作品图片已更新，制品版本和摘要保持不变。', presentationEditHelp:'图片可独立更新；保存不会覆盖代码制品、版本或摘要。移除全部图片后保存即可恢复文字展示。', noPresentation:'尚未添加作品图片。', imageReadError:'图片尚未准备好，请重新选择或移除。'
});
Object.assign(languages.en, {
  versionHistory:'Version history', onePublishedVersion:'Only this version has been published so far.', versionHelp:'Choose a published version for your compatibility and usage needs. The download always matches the selected version.', currentVersion:'Selected: {version}', viewVersions:'View {count} versions',
  presentationTitle:'Work images (optional)', presentationHelp:'Add an icon, cover, and up to 6 preview images to make your work recognizable. Static PNG, JPEG, or WebP only. Icon: up to 512 KiB; other images: up to 1 MiB each; 5 MiB combined.',
  iconLabel:'Icon', coverLabel:'Cover', screenshotsLabel:'Preview images (up to 6)', imageAlt:'Image description', imageAltPlaceholder:'Briefly describe the image for people who cannot see it', imageRemove:'Remove', imageReadPending:'Reading images…', imageInvalid:'The image could not be read. Choose a PNG, JPEG, or WebP image within the limits.', imageTotalTooLarge:'Images exceed 5 MiB combined. Remove images or use smaller files.', imageCountTooMany:'Choose no more than 6 preview images.', imagePreviewTitle:'Work preview', imageOpen:'View full image: {name}', screenshotName:'Preview image {number}', editPresentation:'Edit work images', presentationSave:'Save images', presentationSaved:'Work images updated. The artifact version and digest are unchanged.', presentationEditHelp:'Images can be updated independently. Saving preserves the code artifact, version, and digest. Remove all images and save to return to a text-only presentation.', noPresentation:'No work images have been added.', imageReadError:'Images are not ready. Choose them again or remove them.'
});
Object.assign(languages.zh, { selectedArtifact:'已选择：{name}', validatingArtifact:'正在核对制品配置…', reviewFailed:'制品未通过核对。请更换文件或重试。', retryReview:'重新核对', draftMemory:'文件与草稿仅保留在当前页面内存。刷新或关闭页面后清除。', clearDraft:'清空草稿', publishStepFile:'选择制品', publishStepReview:'核对配置', publishStepSubmit:'确认发布', configuration:'模块配置', basicInformation:'基本信息', wiringInformation:'接线与参数', retainedFile:'已保留所选制品，可继续审阅或选择其他文件。', draftSaved:'已保留当前草稿。', returnToWork:'登录后会返回刚才的操作。', nothingFound:'暂时未能读取作品。', reviewReady:'配置已核对', deploymentTitle:'作者声明的名称', authorConfiguration:'作者默认配置' });
Object.assign(languages.en, { selectedArtifact:'Selected: {name}', validatingArtifact:'Validating artifact configuration…', reviewFailed:'Artifact validation failed. Choose another file or retry.', retryReview:'Validate again', draftMemory:'Files and drafts stay in this page’s memory only. Refreshing or closing the page clears them.', clearDraft:'Clear draft', publishStepFile:'Choose an artifact', publishStepReview:'Review configuration', publishStepSubmit:'Confirm publication', configuration:'Module configuration', basicInformation:'Basic information', wiringInformation:'Wiring and settings', retainedFile:'The selected artifact is retained. Continue reviewing or choose another file.', draftSaved:'Your current draft is retained.', returnToWork:'After signing in, you will return to your previous action.', nothingFound:'This work could not be loaded.', reviewReady:'Configuration validated', deploymentTitle:'Author-declared name', authorConfiguration:'Author defaults' });
Object.assign(languages.zh,{downloadDetails:'摘要与软件源',previewNote:'配置已由服务器从这份制品完整核对。这里的声明不代表代码安全认证，运行和授权仍由本机审阅。'});
Object.assign(languages.en,{downloadDetails:'Digest and source',previewNote:'The server has validated this artifact and read its configuration. Declarations do not certify code safety; execution and permissions are reviewed locally.'});
const newDraft = () => ({ preview:null, configuration:null, title:'', titleEdited:false, acknowledged:false, generation:0, reading:false, submitting:false, reviewError:null, evidence:{}, media:{}, refresh:null });
const state = { language:initialLanguage(), user:null, csrfToken:null, detail:null, catalog:null, request:0, publicationPreview:null, proposalPreview:null, publicationDraft:newDraft(), proposalDrafts:new Map(), commentDrafts:new Map(), returnTo:null, authBusy:false, invitation:null, users:null, search:'', kind:'', contract:'', offset:0, limit:24, localHubURL:'' };
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
function accountLink(cls = 'button small') {
  const node = link(t('goAccount'),'#account',cls);
  node.addEventListener('click',() => { state.returnTo = location.hash || '#catalog'; });
  return node;
}
function selectedTitle(preview, configuration) {
  const declared = configuration?.deployment?.title;
  return typeof declared === 'string' ? declared : declared?.[state.language] || declared?.en || declared?.zh || preview?.manifest?.title || preview?.manifest?.id || '';
}
function renderConfiguration(configuration) { return configuration ? renderArtifactConfiguration(configuration,{language:state.language,document}) : null; }
function draftCurrent(draft, generation) { return generation === draft.generation; }
async function validateDraft(draft, generation = draft.generation) {
  if (!draft.preview || !state.user || draft.submitting) return;
  draft.reading = true; draft.reviewError = null; draft.refresh?.();
  try {
    const result = await api('api/artifacts/preview',{artifact:draft.preview.artifact});
    if (!draftCurrent(draft,generation)) return;
    const configuration = result.configuration, artifact = draft.preview.artifact;
    if (configuration?.format !== 'world-hub.workshop-configuration/v1' || !/^[a-f0-9]{64}$/.test(configuration.sha256 ?? '') || ['kind','id','version'].some(key => configuration[key] !== artifact[key])) throw new Error(t('reviewFailed'));
    draft.configuration = result.configuration;
    if (!draft.titleEdited) draft.title = selectedTitle(draft.preview,draft.configuration);
  } catch (error) { if (draftCurrent(draft,generation)) { draft.configuration = null; draft.reviewError = errorText(error); inform(draft.reviewError,true); } }
  finally { if (draftCurrent(draft,generation)) { draft.reading = false; draft.refresh?.(); } }
}
async function selectDraftArtifact(draft, file, sameIdentity) {
  const generation = ++draft.generation;
  draft.preview = null; draft.configuration = null; draft.acknowledged = false; draft.reviewError = null; draft.reading = true; draft.refresh?.();
  try {
    const preview = await readArtifact(file);
    if (!draftCurrent(draft,generation)) return;
    if (preview && sameIdentity && (preview.artifact.kind !== sameIdentity.kind || preview.artifact.id !== sameIdentity.id)) throw new Error(t('proposalMismatch'));
    draft.preview = preview;
    if (!draft.titleEdited) draft.title = selectedTitle(preview,null);
    if (preview && state.user) await validateDraft(draft,generation);
  } catch (error) { if (draftCurrent(draft,generation)) { draft.reviewError = errorText(error); inform(draft.reviewError,true); } }
  finally { if (draftCurrent(draft,generation)) { draft.reading = false; draft.refresh?.(); } }
}
function discardDraft(draft) {
  ++draft.generation;
  for (const slot of Object.values(draft.media.slots ?? {})) ++slot.generation;
  ++draft.evidence.generation;
  Object.assign(draft,{preview:null,configuration:null,title:'',titleEdited:false,acknowledged:false,reading:false,reviewError:null,evidence:{},media:{}});
}
function contractText(list) { return Array.isArray(list) && list.length ? list.map(c => `${c.id}@${c.version}`).join(', ') : t('notDeclared'); }
function definitions(rows) { return el('dl',{class:'definition-list'},rows.flatMap(([name,value]) => [el('dt',{text:name}),el('dd',{text:value})])); }
function versionPicker(detail) {
  const versions = Array.isArray(detail.versions) && detail.versions.length ? detail.versions : [detail.publication];
  const select = el('select',{id:'publication-version'},versions.map(version => el('option',{value:version.entryId,text:`${version.version}${version.hidden ? ` · ${t('hidden')}` : ''}`})));
  select.value = detail.publication.entryId;
  select.addEventListener('change',() => { location.hash = publicationHash(select.value); });
  return el('section',{class:'version-history','data-testid':'version-history'},[el('h3',{text:t('versionHistory')}),el('p',{class:'field-help',text:t('versionCount',{count:versions.length})}),field(t('chooseVersion'),select),el('p',{class:'field-help',text:t(versions.length === 1 ? 'onePublishedVersion' : 'versionHelp')}),el('p',{class:'selected-version',text:t('currentVersion',{version:detail.publication.version})})]);
}
const mediaTypes = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp' };
// Build every public image URL from a checked content digest. Never trust a
// publisher-supplied URL or inject image descriptions as markup.
function mediaURL(asset) {
  const extension = mediaTypes[asset?.mimeType];
  if (!extension || !/^[a-f0-9]{64}$/.test(asset?.sha256 ?? '')) return null;
  const path = `/workshop/media/${asset.sha256}.${extension}`;
  if (asset.url !== path) return null;
  return new URL(path,base).href;
}
function publicImage(asset, cls = '', fallbackAlt = '') {
  const src = mediaURL(asset);
  return src ? el('img',{src,alt:typeof asset.alt === 'string' ? asset.alt : fallbackAlt,class:cls,loading:'lazy',decoding:'async',width:asset.width,height:asset.height}) : null;
}
function publicationIcon(publication) {
  return publicImage(publication.presentation?.icon,'publication-icon',publication.title ?? publication.id) ?? el('span',{class:`package-icon ${publication.kind === 'module' ? 'module' : ''}`,'aria-hidden':'true',text:publication.kind === 'module' ? '◇' : '⌘'});
}
function presentationGallery(publication) {
  const presentation = publication.presentation ?? {}, images = [];
  if (mediaURL(presentation.cover)) images.push({asset:presentation.cover,name:t('coverLabel'),cover:true});
  for (const [index,asset] of (Array.isArray(presentation.screenshots) ? presentation.screenshots.slice(0,6) : []).entries()) if (mediaURL(asset)) images.push({asset,name:t('screenshotName',{number:index+1})});
  if (!images.length) return null;
  return el('section',{class:'panel presentation-gallery','aria-label':t('imagePreviewTitle')},[el('h2',{text:t('imagePreviewTitle')}),el('div',{class:'gallery-grid'},images.map(({asset,name,cover}) => el('a',{href:mediaURL(asset),target:'_blank',rel:'noopener noreferrer',class:`gallery-item${cover ? ' gallery-cover' : ''}`,'aria-label':t('imageOpen',{name:asset.alt || name})},[publicImage(asset,'gallery-image',name),el('span',{class:'gallery-caption',text:asset.alt || name})]))) ]);
}
function boundary() { return el('div',{class:'boundary-banner'},[el('span',{'aria-hidden':'true',text:'↗'}),el('p',{text:t('boundary')})]); }
function loginNotice() { return el('div',{class:'notice inline'},[el('p',{text:t('loginRequired')}),accountLink(),el('p',{class:'field-help',text:t('returnToWork')})]); }
function sourceStrip() { return el('div',{class:'source-strip'},[el('div',{},[el('h3',{text:t('sourceTitle')}),el('p',{text:t('sourceText')})]),el('div',{class:'source-actions'},[button(t('copySource'),() => copy(sourceURL(),t('copiedURL'))),external(t('viewSource'),sourceURL(),'button quiet')])]); }
function hero() {
  const node = (cls,icon,name) => el('div',{class:`art-node ${cls}`},[el('span',{class:'art-icon','aria-hidden':'true',text:icon}),el('span',{text:t(name)})]);
  return el('section',{class:'hero'},[el('div',{class:'hero-copy'},[el('div',{class:'eyebrow',text:t('heroEyebrow')}),el('h1',{},[t('heroBefore'),el('br'),el('em',{text:t('heroAfter')})]),el('p',{text:t('heroText')}),link(t('share'),'#publish','button primary')]),el('div',{class:'hero-art','aria-hidden':'true'},[el('div',{class:'orbit'}),el('div',{class:'orbit wide'}),el('div',{class:'orbit tall'}),el('span',{class:'orbit-core',text:'✳'}),node('one','◫','artSource'),node('two','◇','artModule'),node('three','⌘','artGroup'),el('span',{class:'art-dot'})])]);
}
function card(item) {
  const contracts = [...(item.provides ?? []),...(item.requires ?? [])];
  return el('a',{class:'publication-card',href:publicationHash(item.entryId),'data-entry-id':item.entryId,'data-kind':item.kind},[
    publicImage(item.presentation?.cover,'card-cover',''),
    el('div',{class:'card-top'},[publicationIcon(item),el('span',{class:'pill',text:t(item.kind)}),item.scope ? el('span',{class:'pill',text:t(item.scope)}) : null]),
    el('div',{},[el('h3',{text:item.title ?? item.id}),el('div',{class:'card-id',text:`${item.id} · ${item.version}`}),el('span',{class:'card-versions',text:t(item.versionCount > 1 ? 'viewVersions' : 'versionCount',{count:item.versionCount ?? 1})})]),
    el('div',{class:'card-contracts'},contracts.length ? contracts.slice(0,2).map(c => el('span',{class:'pill green',text:c.id})) : el('span',{class:'muted',text:item.license ?? t('noContracts')})),
    el('div',{class:'card-bottom'},[el('span',{class:'owner',text:owner(item.owner)}),el('span',{text:`${item.commentsCount ?? 0} ${t('comments')} · ${item.proposalsCount ?? 0} ${t('proposals')}`})])
  ]);
}
function renderCatalog() {
  const search = el('input',{name:'search',type:'search',maxlength:128,value:state.search,placeholder:t('searchPlaceholder')});
  const contract = el('input',{name:'contract',maxlength:128,value:state.contract,placeholder:t('contractPlaceholder')});
  const applyFilters = (kind = state.kind) => {
    state.search = search.value.trim(); state.kind = kind; state.contract = contract.value.trim(); state.offset = 0;
    return loadRoute();
  };
  const filters = el('form',{id:'catalog-filter',class:'filters'},[el('label',{},[t('search'),search]),el('label',{},[t('contract'),contract]),el('button',{type:'submit',class:'button',text:t('filter')})]);
  filters.addEventListener('submit',event => { event.preventDefault(); return applyFilters(); });
  const total = state.catalog?.total ?? 0, items = state.catalog?.publications ?? [];
  const paging = el('div',{class:'pagination'},[button(t('previous'),() => { state.offset = Math.max(0,state.offset - state.limit); loadRoute(); }),el('span',{text:t('page',{page:Math.floor(state.offset/state.limit)+1})}),button(t('next'),() => { state.offset += state.limit; loadRoute(); })]);
  paging.firstChild.disabled = state.offset === 0; paging.lastChild.disabled = state.offset + state.limit >= total;
  const kinds = el('div',{class:'resource-tabs',role:'group','aria-label':t('resourceTypes')},['','module','configuration','data'].map(value => { const tab = button(t(value || 'allKinds'),() => applyFilters(value),state.kind === value ? 'primary' : 'quiet'); tab.setAttribute('aria-pressed',String(state.kind === value)); tab.dataset.kind = value; return tab; }));
  replaceView(hero(),el('div',{class:'toolbar'},[el('div',{},[el('h2',{},[t('collection'),el('span',{class:'count',text:t('items',{count:total})})])]),filters]),kinds,items.length ? el('div',{class:'card-grid'},items.map(card)) : empty(t(state.search || state.contract || state.kind ? 'noResults' : 'noPublications'),t(state.search || state.contract || state.kind ? 'emptyFilter' : 'emptyText'),link(t('share'),'#publish','button primary')),total > state.limit ? paging : null,sourceStrip(),boundary());
}
async function readArtifact(file) {
  if (!file) return null;
  if (file.size > uploadMaximum) throw new Error(t('fileTooLarge'));
  let artifact;
  try { artifact = JSON.parse(await file.text()); } catch { throw new Error(t('uploadReadFailed')); }
  if (!artifact || artifact.format !== 'world-hub.source-artifact/v1' || !['module','configuration','data'].includes(artifact.kind) || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 8192) throw new Error(t('invalidArtifact'));
  let manifest;
  const decode = path => {
    const value = artifact.files.find(f => f.path === path)?.base64;
    if (typeof value !== 'string' || value.length > Math.ceil(1024*1024/3)*4) throw new Error(t('invalidManifest'));
    const decoded = Uint8Array.from(atob(value),c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded));
  };
  try { manifest = decode({module:'module.json',configuration:'configuration.json',data:'data.json'}[artifact.kind]); }
  catch { throw new Error(t('invalidManifest')); }
  if (manifest.id !== artifact.id || manifest.version !== artifact.version || manifest.format !== ({module:'world-hub.module/v1',configuration:'world-hub.configuration/v1',data:'world-hub.module-data/v1'}[artifact.kind])
    || (artifact.kind === 'configuration' && (!Array.isArray(manifest.modules) || !manifest.modules.length || manifest.modules.length > 128))) throw new Error(t('invalidManifest'));
  if (artifact.kind === 'data' && manifest.purpose !== 'dataset') throw new Error(t('backupRejected'));
  return { artifact, manifest, size:file.size, fileName:file.name, platforms:manifest.platforms };
}
function previewNode(preview, configuration = null) {
  if (!preview) return el('div',{class:'preview'},[el('h3',{text:t('previewTitle')}),el('p',{class:'form-help',text:t('previewNone')})]);
  if (!configuration) return el('div',{class:'preview'},[el('h3',{text:t('previewTitle')}),el('p',{class:'form-help',text:t('retainedFile')})]);
  const m = configuration.manifest;
  return el('div',{class:'preview','data-testid':'artifact-preview'},[
    el('h3',{text:t('previewTitle')}),definitions([[t('kind'),t(configuration.kind)],[t('id'),String(m.id)],[t('version'),String(m.version)],...(m.scope ? [[t('scope'),t(m.scope)]] : []),[t('license'),String(m.license ?? t('notDeclared'))],[t('platforms'),Array.isArray(m.platforms) ? m.platforms.join(', ') : t('notDeclared')],[t('files'),t('fileCount',{count:configuration.artifactFileCount})],[t('byteSize'),`${(configuration.artifactByteSize/1024).toFixed(1)} KiB`],[t('provides'),contractText(m.provides)],[t('requires'),contractText(m.requires)]]),
    configuration ? renderConfiguration(configuration) : null,configuration ? el('p',{class:'field-help',text:t('previewNote')}) : null
  ]);
}
function acknowledgment(text,id) { const check = el('input',{type:'checkbox',id,required:true}); return { check, label:el('label',{class:'check'},[check,el('span',{text})]) }; }
function publicEvidenceInput(id, changed, saved = {}) {
  const input = el('input', { id, type:'file', accept:'.json,application/json' });
  saved.generation ??= 0; saved.pending ??= false; saved.invalid ??= false;
  const status = el('p',{class:'field-help',role:'status'});
  const refresh = () => { status.textContent = saved.pending ? t('loading') : saved.name ? t('selectedArtifact',{name:saved.name}) : ''; changed(); };
  saved.refresh = refresh;
  input.addEventListener('change', async () => {
    const current = ++saved.generation; saved.value = undefined; saved.pending = true; saved.invalid = false; saved.name = ''; saved.refresh();
    try {
      const file = input.files[0];
      if (file) {
        if (file.size > 256 * 1024) throw new Error(t('evidenceInvalid'));
        const bytes = await file.text(), parsed = JSON.parse(bytes);
        if (parsed?.format !== 'world-hub.publisher-evidence/v1' || parsed.payload?.type !== 'artifact' || !Array.isArray(parsed.signatures)
          || Object.keys(parsed).some(key => !['format','payload','signatures','publicKeys'].includes(key))
          || Object.keys(parsed.payload).some(key => !['type','issuer','keyId','sequence','issuedAt','expiresAt','subject','details'].includes(key))
          || Object.keys(parsed.payload.details ?? {}).length
          || (parsed.publicKeys ?? []).some(key => Object.keys(key).some(name => !['keyId','publicKey'].includes(name)))) throw new Error(t('evidenceInvalid'));
        if (current === saved.generation) { saved.value = bytes; saved.name = file.name; }
      }
    } catch { if (current === saved.generation) { saved.invalid = true; inform(t('evidenceInvalid'), true); } }
    finally { if (current === saved.generation) { saved.pending = false; saved.refresh(); } }
  });
  status.textContent = saved.pending ? t('loading') : saved.name ? t('selectedArtifact',{name:saved.name}) : '';
  return { node:el('div',{},[field(t('evidenceLabel'), input, t('evidenceHint')),status]), ready:() => !saved.pending && !saved.invalid,
    apply:body => { if (saved.value !== undefined) body.publisherEvidence = saved.value; } };
}
function publisherEvidenceLink(evidence) {
  if (!/^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '')) return null;
  return el('div', {}, [el('p', { class:'field-help', text:t('evidenceStatus') }),
    el('a', { class:'button small', href:new URL(`publisher-evidence/${evidence.sha256}.json`, base).href, download:`${evidence.sha256}.publisher.json`, text:t('evidenceDownload') }),
    el('p', { class:'field-help', text:t('evidenceBoundary') })]);
}
async function readImage(file, maximum) {
  if (!file || !Object.hasOwn(mediaTypes,file.type) || !file.size || file.size > maximum) throw new Error(t('imageInvalid'));
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { throw new Error(t('imageInvalid')); }
  if (!bytes.length || bytes.length !== file.size || bytes.length > maximum) throw new Error(t('imageInvalid'));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return {mimeType:file.type,base64:btoa(binary),size:bytes.length,alt:''};
}
function presentationInput(id, changed, initial = {}, saved = {}) {
  const slots = saved.slots ??= {
    icon:{label:'iconLabel',maximum:512*1024,values:initial.icon && mediaURL(initial.icon) ? [{...initial.icon}] : []},
    cover:{label:'coverLabel',maximum:1024*1024,values:initial.cover && mediaURL(initial.cover) ? [{...initial.cover}] : []},
    screenshots:{label:'screenshotsLabel',maximum:1024*1024,values:(Array.isArray(initial.screenshots) ? initial.screenshots : []).filter(mediaURL).slice(0,6).map(asset => ({...asset})),multiple:true}
  };
  const total = () => Object.values(slots).reduce((sum,slot) => sum + slot.values.reduce((size,asset) => size + (asset.size ?? 0),0),0);
  const totalNotice = el('p',{class:'field-help media-error',role:'status'});
  const notify = () => { totalNotice.textContent = total() > 5*1024*1024 ? t('imageTotalTooLarge') : ''; changed(); };
  const sections = Object.entries(slots).map(([key,slot]) => {
    const input = el('input',{id:`${id}-${key}`,type:'file',accept:'image/png,image/jpeg,image/webp',multiple:slot.multiple});
    const previews = el('div',{class:`media-selection ${key}`}), status = el('p',{class:'field-help',role:'status'});
    slot.generation ??= 0; slot.pending ??= false; slot.invalid ??= false;
    const clear = () => { ++slot.generation; slot.pending = false; slot.invalid = false; slot.values = []; input.value = ''; slot.render(); saved.notify(); };
    const render = () => {
      status.textContent = slot.pending ? t('imageReadPending') : slot.invalid ? t('imageReadError') : '';
      previews.replaceChildren(...slot.values.map((asset,index) => {
        const alt = el('input',{type:'text',maxlength:256,value:asset.alt ?? '',placeholder:t('imageAltPlaceholder'),'data-media-alt':`${key}-${index}`});
        alt.addEventListener('input',() => { asset.alt = alt.value; });
        const src = asset.base64 ? `data:${asset.mimeType};base64,${asset.base64}` : mediaURL(asset);
        const remove = button(t('imageRemove'),() => { slot.values.splice(index,1); if (!slot.values.length) input.value = ''; slot.render(); saved.notify(); },'small');
        remove.setAttribute('aria-label',`${t('imageRemove')} · ${t(slot.label)}${slot.multiple ? ` ${index+1}` : ''}`);
        return el('div',{class:'media-preview'},[el('img',{src,alt:asset.alt ?? '',class:'media-thumbnail'}),el('div',{class:'media-caption-editor'},[field(t('imageAlt'),alt),remove])]);
      }));
    };
    slot.render = render;
    input.addEventListener('change',async () => {
      const generation = ++slot.generation, files = Array.from(input.files ?? []);
      slot.values = []; slot.pending = true; slot.invalid = false; slot.render(); saved.notify();
      try {
        if (files.length > (slot.multiple ? 6 : 1)) throw new Error(t('imageCountTooMany'));
        const assets = await Promise.all(files.map(file => readImage(file,slot.maximum)));
        if (generation !== slot.generation) return;
        slot.values = assets;
      } catch (error) { if (generation === slot.generation) { slot.invalid = true; inform(errorText(error),true); } }
      finally { if (generation === slot.generation) { slot.pending = false; slot.render(); saved.notify(); } }
    });
    render();
    const removeAll = button(t('imageRemove'),clear,'small quiet');
    removeAll.setAttribute('aria-label',`${t('imageRemove')} · ${t(slot.label)}`);
    return el('div',{class:'media-field'},[field(t(slot.label),input),previews,status,removeAll]);
  });
  saved.notify = notify;
  totalNotice.textContent = total() > 5*1024*1024 ? t('imageTotalTooLarge') : '';
  return { node:el('fieldset',{class:'presentation-editor',id},[el('legend',{text:t('presentationTitle')}),el('p',{class:'field-help',text:t('presentationHelp')}),...sections,totalNotice]),
    ready:() => Object.values(slots).every(slot => !slot.pending && !slot.invalid) && total() <= 5*1024*1024,
    value:() => Object.fromEntries(Object.entries(slots).filter(([,slot]) => slot.values.length).map(([key,slot]) => {
      const values = slot.values.map(asset => asset.base64 ? {mimeType:asset.mimeType,base64:asset.base64,alt:asset.alt ?? ''} : {sha256:asset.sha256,alt:asset.alt ?? ''});
      return [key,slot.multiple ? values : values[0]];
    })) };
}
function presentationEditor(publication) {
  if (!state.user || (state.user.role !== 'admin' && state.user.id !== publication.owner?.id)) return null;
  const submit = el('button',{type:'submit',class:'button',text:t('presentationSave')});
  let submitting = false;
  const media = presentationInput('edit-presentation',() => available(),publication.presentation);
  const available = () => { submit.disabled = submitting || !media.ready(); };
  const form = el('form',{id:'presentation-form',class:'presentation-edit-form'},[el('p',{class:'field-help',text:t('presentationEditHelp')}),media.node,submit]);
  form.addEventListener('submit',event => {
    event.preventDefault(); if (submitting || !media.ready()) return;
    submitting = true; available(); const startedHash = location.hash;
    busy(submit,async () => { try { await api(`${publicationPath(publication.entryId)}/presentation`,{presentation:media.value()}); inform(t('presentationSaved')); if (location.hash === startedHash) await loadRoute(); } finally { submitting = false; } }).finally(available);
  });
  return el('details',{class:'panel presentation-edit'},[el('summary',{text:t('editPresentation')}),form]);
}
function renderPublish() {
  const draft = state.publicationDraft;
  if (!draft.titleEdited && draft.preview) draft.title = selectedTitle(draft.preview,draft.configuration);
  const upload = el('input',{id:'artifact-file',type:'file',accept:'.json,application/json',required:!draft.preview});
  const title = el('input',{name:'title',maxlength:256,value:draft.title,placeholder:t('titlePlaceholder')});
  const preview = el('div',{id:'publication-preview'}), fileStatus = el('p',{class:'selected-artifact field-help',role:'status'});
  const ack = acknowledgment(t('redistribute'),'redistribution-ack');
  const submit = el('button',{id:'publish-submit',type:'submit',class:'button primary',disabled:true,text:t('publishConfirm')});
  const evidence = publicEvidenceInput('publisher-evidence-file',() => available(),draft.evidence);
  const media = presentationInput('publication-images',() => available(),{},draft.media);
  const steps = el('ol',{class:'publish-steps'}), retry = button(t('retryReview'),() => validateDraft(draft),'small');
  const available = () => { submit.disabled = draft.submitting || draft.reading || !state.user || !draft.configuration || !draft.preview || !draft.acknowledged || !evidence.ready() || !media.ready(); submit.textContent = t(draft.submitting ? 'publishing' : 'publishConfirm'); };
  draft.refresh = () => {
    state.publicationPreview = draft.preview;
    upload.required = !draft.preview; upload.disabled = draft.submitting; ack.check.checked = draft.acknowledged; ack.check.disabled = draft.reading || draft.submitting || !draft.configuration;
    if (!draft.titleEdited) title.value = draft.title;
    fileStatus.textContent = draft.preview ? t('selectedArtifact',{name:draft.preview.fileName}) : '';
    preview.replaceChildren(previewNode(draft.preview,draft.configuration),...(draft.reading ? [el('p',{class:'field-help',role:'status',text:t('validatingArtifact')})] : []),...(draft.reviewError ? [el('p',{class:'field-help media-error',role:'alert',text:draft.reviewError})] : []));
    retry.hidden = !draft.preview || !!draft.configuration || draft.reading || !state.user; retry.disabled = draft.submitting;
    available();
    steps.replaceChildren(...['publishStepFile','publishStepReview','publishStepSubmit'].map((key,index) => { const complete = index === 0 ? !!draft.preview : index === 1 ? !!draft.configuration : draft.acknowledged && !submit.disabled; return el('li',{'data-complete':complete,class:complete ? 'is-complete' : '',text:t(key)}); }));
  };
  title.addEventListener('input',() => { draft.title = title.value; draft.titleEdited = true; });
  ack.check.addEventListener('change',() => { draft.acknowledged = ack.check.checked; draft.refresh(); });
  upload.addEventListener('change',() => selectDraftArtifact(draft,upload.files[0]));
  const clear = button(t('clearDraft'),() => { if (draft.submitting) return; discardDraft(draft); renderPublish(); },'quiet small');
  const form = el('form',{id:'publication-form',class:'panel publish-form'},[el('h2',{text:t('uploadTitle')}),el('div',{class:'upload-box'},[el('div',{class:'upload-icon','aria-hidden':'true',text:'⇧'}),field(t('artifactLabel'),upload),el('p',{text:t('uploadHint')}),fileStatus]),el('p',{class:'field-help',text:t('uploadHelp')}),el('p',{class:'field-help',text:t('draftMemory')}),field(t('titleLabel'),title),preview,retry,media.node,evidence.node,ack.label,el('div',{class:'form-actions'},[submit,clear])]);
  form.addEventListener('submit',event => {
    event.preventDefault(); available(); if (submit.disabled) return;
    draft.submitting = true; draft.refresh(); const startedHash = location.hash;
    const payload = {artifact:draft.preview.artifact,redistributionAcknowledged:true,presentation:media.value()}; evidence.apply(payload); if (draft.title.trim()) payload.title = draft.title.trim();
    busy(submit,async () => {
      try {
        const result = await api('api/publications',payload); inform(t(result.duplicate ? 'duplicate' : 'published'));
        discardDraft(draft); state.publicationPreview = null;
        if (location.hash === startedHash && route().view === 'publish') location.hash = publicationHash(result.publication.entryId);
      } finally { draft.submitting = false; draft.refresh?.(); }
    }).finally(available);
  });
  const outline = el('aside',{class:'publish-outline stack'},[el('section',{class:'panel'},[el('h2',{text:t('previewTitle')}),steps]),el('section',{class:'panel','data-testid':'resource-kinds'},[el('h2',{text:t('resourceTypes')}),...['module','configuration','data'].map(kind => el('div',{},[el('h3',{class:'small-heading',text:t(kind)}),el('p',{class:'form-help',text:t(kind + 'Help')})]))]),...[[t('immutable'),t('publishRules')],[t('safeFiles'),t('safeFilesText')],[t('initialQuota'),t('quotaText')]].map(([name,text]) => el('section',{class:'panel'},[el('h2',{text:name}),el('p',{class:'form-help',text})]))]);
  replaceView(heading(t('publishEyebrow'),t('publishTitle'),t('publishSubtitle')),!state.user ? loginNotice() : null,el('div',{class:'publish-workspace'},[form,outline]),boundary());
  draft.refresh();
  if (draft.preview && !draft.configuration && !draft.reading && !draft.reviewError && state.user) void validateDraft(draft);
}
function downloadLink(digest, publication) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return el('p',{class:'muted',text:t('publicationMissing')});
  const fileName = publication ? `${publication.id}-${publication.version}.${publication.kind}.artifact.json`.replace(/[^a-z0-9._-]/gi,'_') : `${digest}.json`;
  return el('a',{id:'artifact-download',class:'button primary',href:new URL(`artifacts/${digest}.json`,base).href,download:fileName,text:t('download')});
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
  if (!state.user) { panel.append(accountLink()); return panel; }
  const key = detail.publication.entryId;
  if (!state.commentDrafts.has(key)) state.commentDrafts.set(key,{text:'',submitting:false});
  const draft = state.commentDrafts.get(key);
  const text = el('textarea',{name:'text',id:'comment-text',maxlength:4000,required:true,placeholder:t('commentPlaceholder')}); text.value = draft.text;
  const submit = el('button',{type:'submit',class:'button primary',text:t('sendComment')});
  const form = el('form',{id:'comment-form',class:'comment-form'},[field(t('commentLabel'),text),submit]);
  draft.refresh = () => { submit.disabled = draft.submitting; text.disabled = draft.submitting; };
  text.addEventListener('input',() => { draft.text = text.value; });
  form.addEventListener('submit',event => { event.preventDefault(); if (draft.submitting || !draft.text.trim()) return; draft.submitting = true; draft.refresh(); const startedHash = location.hash; busy(submit,async () => { try { await api(`${publicationPath(key)}/comments`,{text:draft.text.trim()}); draft.text = ''; inform(t('commentSent')); if (location.hash === startedHash) await loadRoute(); } finally { draft.submitting = false; draft.refresh?.(); } }); });
  draft.refresh();
  panel.append(form); return panel;
}
function proposalsPanel(detail) {
  const proposals = Array.isArray(detail.proposals) ? detail.proposals : [];
  const panel = el('section',{class:'panel'},[el('h2',{text:t('proposalCount',{count:proposals.length})})]);
  if (!proposals.length) panel.append(el('p',{class:'form-help',text:t('noProposals')}));
  else panel.append(el('ul',{class:'proposal-list'},proposals.map(proposal => {
    const download = button(t('downloadProposal'),event => busy(event.currentTarget,() => downloadProposal(detail.publication.entryId,proposal.id)),'small');
    return el('li',{class:'proposal-item'},[el('h3',{text:proposal.title ?? `${proposal.artifactId} · ${proposal.version}`}),el('div',{class:'proposal-meta'},[el('span',{text:owner(proposal.author)}),el('span',{text:date(proposal.createdAt)})]),el('div',{class:'small-heading',text:t('proposalBase')}),el('code',{class:'digest',text:proposal.baseSha256}),download,publisherEvidenceLink(proposal.publisherEvidence)]);
  })));
  if (!state.user) { panel.append(accountLink()); return panel; }
  const baseSha256 = detail.publication.sha256, entryId = detail.publication.entryId;
  const key = `${entryId}:${baseSha256}`;
  if (!state.proposalDrafts.has(key)) state.proposalDrafts.set(key,newDraft());
  const draft = state.proposalDrafts.get(key);
  const upload = el('input',{id:'proposal-file',type:'file',accept:'.json,application/json',required:!draft.preview});
  const title = el('input',{name:'title',maxlength:256,value:draft.title,placeholder:t('titlePlaceholder')});
  const ack = acknowledgment(t('proposalAck'),'proposal-ack');
  const preview = el('div',{id:'proposal-preview'});
  const retry = button(t('retryReview'),() => validateDraft(draft),'small');
  const submit = el('button',{id:'proposal-submit',type:'submit',class:'button',disabled:true,text:t('submitProposal')});
  const evidence = publicEvidenceInput('proposal-publisher-evidence-file',() => available(),draft.evidence);
  const available = () => { submit.disabled = draft.submitting || draft.reading || !state.user || !draft.preview || !draft.configuration || !draft.acknowledged || !evidence.ready(); };
  draft.refresh = () => { state.proposalPreview = draft.preview; upload.disabled = draft.submitting; upload.required = !draft.preview; ack.check.checked = draft.acknowledged; ack.check.disabled = draft.submitting || draft.reading || !draft.configuration; if (!draft.titleEdited) title.value = draft.title; preview.replaceChildren(...(draft.preview ? [el('p',{class:'field-help',text:t('selectedArtifact',{name:draft.preview.fileName})}),previewNode(draft.preview,draft.configuration)] : []),...(draft.reading ? [el('p',{class:'field-help',role:'status',text:t('validatingArtifact')})] : []),...(draft.reviewError ? [el('p',{class:'field-help media-error',role:'alert',text:draft.reviewError})] : [])); retry.hidden = !draft.preview || !!draft.configuration || draft.reading; retry.disabled = draft.submitting; available(); };
  title.addEventListener('input',() => { draft.title = title.value; draft.titleEdited = true; });
  ack.check.addEventListener('change',() => { draft.acknowledged = ack.check.checked; draft.refresh(); });
  upload.addEventListener('change',() => selectDraftArtifact(draft,upload.files[0],detail.publication));
  const form = el('form',{id:'proposal-form',class:'comment-form'},[field(t('proposalLabel'),upload,t('proposalHelp')),field(t('proposalTitle'),title),evidence.node,el('div',{class:'small-heading',text:t('proposalBase')}),el('code',{class:'digest',text:baseSha256}),preview,retry,ack.label,submit]);
  form.addEventListener('submit',event => { event.preventDefault(); available(); if (submit.disabled) return; draft.submitting = true; draft.refresh(); const startedHash = location.hash; const body = {artifact:draft.preview.artifact,baseSha256,redistributionAcknowledged:true}; evidence.apply(body); if (draft.title.trim()) body.title = draft.title.trim(); busy(submit,async () => { try { await api(`${publicationPath(entryId)}/proposals`,body); discardDraft(draft); inform(t('proposalSent')); if (location.hash === startedHash) await loadRoute(); } finally { draft.submitting = false; draft.refresh?.(); } }).finally(available); });
  draft.refresh();
  if (draft.preview && !draft.configuration && !draft.reading && !draft.reviewError) void validateDraft(draft);
  panel.append(form); return panel;
}
function renderDetail() {
  const detail = state.detail, p = detail.publication, entry = detail.entry;
  const controls = [];
  if (state.user?.role === 'admin') controls.push(button(t(p.hidden ? 'showPublication' : 'hidePublication'),event => busy(event.currentTarget,async () => { await api(`${publicationPath(p.entryId)}/visibility`,{hidden:!p.hidden}); inform(t('visibilityChanged')); await loadRoute(); }),'small danger'));
  const aside = el('aside',{class:'panel detail-aside'},[el('h2',{text:t('download')}),versionPicker(detail),definitions([[t('publishedAt'),date(p.createdAt)],[t('platforms'),entry.platforms.join(', ')]]),downloadLink(p.sha256,p),publisherEvidenceLink(p.publisherEvidence),el('p',{text:t('downloadNote')}),el('details',{class:'download-technical'},[el('summary',{text:t('downloadDetails')}),el('div',{class:'small-heading',text:t('exactDigest')}),el('code',{class:'digest',text:p.sha256}),button(t('copySource'),() => copy(sourceURL(),t('copiedURL')),'small'),el('p',{text:t('licenseNotice')})]),...controls]);
  const metadata = el('section',{class:'panel'},[el('h2',{text:aboutWork[state.language]}),definitions([[t('id'),p.id],[t('version'),p.version],[t('license'),entry.license],[t('platforms'),entry.platforms.join(', ')],[t('provides'),contractText(entry.provides)],[t('requires'),contractText(entry.requires)],[t('publisher'),owner(p.owner)],[t('publishedAt'),date(p.createdAt)]])]);
  const configuration = detail.configuration?.sha256 === p.sha256 ? detail.configuration : null;
  const configurationPanel = el('section',{class:'panel configuration-panel','data-testid':'publication-configuration'},configuration ? renderConfiguration(configuration) : renderArtifactConfiguration(null,{language:state.language,document}));
  replaceView(link(`← ${t('backCatalog')}`,'#catalog','back-link'),el('div',{class:'detail-heading'},[publicationIcon(p),el('div',{},[el('h1',{text:p.title}),el('div',{class:'detail-id',text:`${p.id} · ${p.version}`})])]),el('div',{class:'detail-meta'},[el('span',{class:'pill green',text:t(p.kind)}),p.scope ? el('span',{class:'pill',text:t(p.scope)}) : null,el('span',{class:'pill',text:entry.license}),p.hidden ? el('span',{class:'pill amber',text:t('hidden')}) : null]),el('div',{class:'detail-layout'},[el('div',{class:'stack'},[presentationGallery(p),metadata,configurationPanel,presentationEditor(p),commentsPanel(detail),proposalsPanel(detail)]),aside]),boundary());
}
function authForm(kind) {
  const username = el('input',{name:'username',id:`${kind}-username`,autocomplete:'username',required:true,minlength:3,maxlength:40,pattern:'[a-z0-9][a-z0-9._\\-]{2,39}',autocapitalize:'none',spellcheck:'false'});
  const password = el('input',{name:'password',id:`${kind}-password`,type:'password',autocomplete:kind === 'login' ? 'current-password' : 'new-password',required:true,minlength:12,maxlength:128});
  const invitation = kind === 'register' ? el('input',{name:'invitation',id:'register-invitation',required:true,autocomplete:'off',placeholder:t('invitationPlaceholder'),maxlength:256,spellcheck:'false'}) : null;
  const submit = el('button',{type:'submit',class:`button ${kind === 'login' ? 'primary' : ''}`,text:t(kind)});
  const form = el('form',{id:`${kind}-form`,class:'panel'},[el('h2',{text:t(kind)}),field(t('username'),username,t('usernameHelp')),field(t('password'),password,t('passwordHelp')),invitation ? field(t('invitation'),invitation) : null,submit]);
  form.addEventListener('submit',event => {
    event.preventDefault(); if (state.authBusy) return;
    state.authBusy = true; const startedHash = location.hash;
    const body = {username:username.value,password:password.value}; if (invitation) body.invitation = invitation.value.trim();
    busy(submit,async () => {
      try {
        const session = await api(`api/${kind}`,body); state.user = session.user; state.csrfToken = session.csrfToken; state.invitation = null; applyLanguage(); inform(t(kind === 'login' ? 'loginSuccess' : 'registered'));
        const destination = state.returnTo; state.returnTo = null;
        if (location.hash === startedHash && route().view === 'account') {
          if (destination && /^#(?:publish|catalog|publication\/[a-z0-9._-]+)$/.test(destination)) location.hash = destination;
          else await loadRoute();
        }
      } finally { password.value = ''; body.password = ''; state.authBusy = false; }
    });
  });
  return form;
}
function localHubPanel() {
  const url = el('input',{id:'local-hub-url',type:'url',value:state.localHubURL,placeholder:t('localHubPlaceholder'),required:true,autocomplete:'off'});
  const form = el('form',{id:'local-hub-form',class:'panel'},[el('h2',{text:t('localTitle')}),el('p',{class:'form-help',text:t('localText')}),field(t('localHubURL'),url),el('button',{type:'submit',class:'button',text:t('openLocalHub')})]);
  form.addEventListener('submit',event => { event.preventDefault(); try { const target = new URL(url.value); if (!['http:','https:'].includes(target.protocol) || !['localhost','127.0.0.1','[::1]'].includes(target.hostname) || target.username || target.password || target.search || target.hash) throw new Error(t('invalidLocalHub')); state.localHubURL = target.href; window.open(target.href,'_blank','noopener,noreferrer'); } catch { inform(t('invalidLocalHub'),true); } });
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
  if (!state.user) { replaceView(intro,el('div',{class:'panels'},[authForm('login'),authForm('register')]),el('div',{class:'source-strip'},localHubPanel())); return; }
  const logout = button(t('logout'),event => busy(event.currentTarget,async () => { await api('api/logout',{}); state.user = null; state.csrfToken = null; state.invitation = null; state.users = null; state.detail = null; applyLanguage(); inform(t('loggedOut')); await loadRoute(); }));
  const profile = el('section',{class:'panel'},[el('div',{class:'account-card'},[el('div',{class:'avatar','aria-hidden':'true',text:'◎'}),el('div',{},[el('h2',{text:state.user.username}),el('span',{class:'pill green',text:t(state.user.role === 'admin' ? 'administrator' : 'member')})])]),el('p',{class:'form-help',text:t('accountSubtitle')}),el('div',{class:'form-actions'},[link(t('publish'),'#publish','button primary'),logout])]);
  replaceView(intro,el('div',{class:'panels'},[el('div',{class:'stack'},[profile,localHubPanel()]),state.user.role === 'admin' ? adminPanel() : el('section',{class:'panel'},[el('h2',{text:t('sourceTitle')}),el('p',{class:'form-help',text:t('sourceText')}),el('code',{class:'digest',text:sourceURL()}),button(t('copySource'),() => copy(sourceURL(),t('copiedURL'))),boundary()]) ]));
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
