const messages = {
  zh: {
    skip:'跳至内容', localWorkspace:'本地工作空间', workspace:'工作空间', overview:'状态总览', myPacks:'我的整合包', hubs:'枢纽管理', workbench:'通信工作台', system:'系统', environment:'环境与诊断', localRuntime:'本机 Runtime', offlineLocal:'本地管理无需社区服务。', localOnly:'仅限本机', refresh:'刷新', packEyebrow:'YOUR LOCAL COLLECTION', packsSubtitle:'让独立的程序一起工作，从一个入口开始。', importPack:'导入整合包', onePlace:'ONE PLACE, YOUR PROGRAMS', welcomeTitle:'组合能力，开启你的工作空间。', welcomeText:'导入本地整合包，审阅来源与权限，再启动自己的实例。随时查看模块、日志与通信状态。', independentInstances:'独立实例 · 本地运行', instances:'整合包实例', searchPlaceholder:'搜索名称或实例 ID', overviewSubtitle:'运行、通信和业务就绪，各有自己的事实。', hubsSubtitle:'从实例进入已有的拓扑管理，沿用 Hub 的通信能力。', hubBoundary:'Hub 负责通信；Runtime 负责实例与进程。连接状态不会替代业务就绪状态。', workbenchSubtitle:'在已有 Hub 管理界面打开通信工作台，调试消息与请求响应。', environmentSubtitle:'检查宿主环境，选择已安装的解释器，再验证整合包要求。', interpreters:'已安装解释器', detectOnly:'仅检测', nodePath:'Node.js 路径（可选）', pythonPath:'Python 路径（可选）', nodePlaceholder:'使用 Launcher 当前 Node.js', pythonPlaceholder:'从 PATH 检测 Python', probeNotice:'检测会运行所选解释器的固定版本与依赖探针，不执行整合包入口或安装脚本。', detectEnvironment:'重新检测环境并发现解释器', securityBoundary:'当前保护边界', noSandbox:'未提供 OS 沙箱', sandboxNotice:'权限是模块的声明，用户审阅是对当前代码和环境的授权。当前 Runtime 不强制限制模块访问文件、网络或系统资源。', isolationNotice:'每个实例拥有独立工作目录与 Hub 身份；同账户下的程序仍可能读取其他实例文件。请只运行你信任的代码，并用操作系统账户与目录权限保护数据。', backToPacks:'我的整合包', runtimeStatus:'运行状态', modulesPermissions:'模块与权限', logs:'运行日志', instanceDetails:'实例信息', footer:'独立程序，共同协作。', localPackage:'LOCAL PACKAGE', selectSource:'选择来源', reviewPackage:'审阅整合包', createInstance:'创建实例', importDescription:'输入本机整合包目录。检查通过后可创建独立实例，导入不会自动启动程序。', packageDirectory:'整合包目录', instanceId:'实例 ID', environmentChoice:'运行环境', selectedInterpreters:'使用下方选择的解释器', chooseInterpreters:'选择已安装的解释器（可选）', cancel:'取消', modifySource:'修改来源', checkPackage:'检查整合包', executionReview:'EXECUTION REVIEW', reviewAndTrust:'审阅并授权运行', trustConsent:'我已审阅当前代码来源、权限与运行环境，信任这些代码在本机执行。', authorizeCurrent:'授权当前审阅内容', exportPackage:'导出整合包', exportNotice:'导出锁定整合包到一个新的本机目录，不包括实例数据、日志或 Runtime 凭据。公开 settings 会包含在内，请先确认其中没有秘密。', destination:'新的目标目录', totalInstances:'全部实例', runningInstances:'运行中', moduleCount:'模块', attention:'需要关注', independentlyManaged:'独立目录与 Hub 身份', observedProcesses:'仅本次运行的进程观察', declaredModules:'实例包含的模块', failuresAndUnknown:'失败或观察已过时', items:'{count} 个实例', start:'启动', stop:'停止', restart:'重启', stopping:'停止中', starting:'启动中', viewDetails:'查看详情', imported:'已导入', running:'运行中', stopped:'已停止', failed:'失败', unknown:'未知', stale:'观察已过时', cleanupIncomplete:'退出未确认', modules:'模块', communication:'通信', connected:'已连接', disconnected:'未连接', ready:'已就绪', notReady:'未就绪', process:'进程', readiness:'模块自报就绪', health:'健康探针', businessResult:'实际业务结果', businessUnknown:'请在应用中验证', healthPassed:'通过', healthFailed:'未通过', noHealthCheck:'尚未观察', processRunning:'运行中', processExited:'已退出', emptyTitle:'你的第一个整合包，从这里开始。', emptyDescription:'准备一个包含 pack.json 和 pack.lock 的本地目录，检查环境与代码来源，再创建自己的实例。', noSearchResults:'没有匹配的实例', openApp:'打开应用', topology:'查看通信拓扑', openWorkbench:'打开通信工作台', review:'重新审阅', reviewBeforeRun:'启动前将审阅当前内容与环境，并要求明确授权。', freshReview:'运行前重新计算审阅内容，授权只适用于当前这份内容。', trustAndStart:'授权并启动', trustAndRestart:'授权并重启', checking:'正在检查…', importing:'正在导入…', loading:'正在读取…', processing:'正在处理…', importedSuccess:'已创建实例 {id}。导入未启动任何模块。', startAccepted:'正在启动实例 {id}。', stopAccepted:'正在停止实例 {id}，等待所属进程退出。', restartAccepted:'正在重启实例 {id}。', exportedSuccess:'已导出到 {destination}。', operationFailed:'操作失败', source:'代码来源', permissions:'声明权限', executionOrder:'执行顺序', environmentReview:'审阅环境', codeExecutionNotice:'启动将执行下列本地模块。权限是声明，当前没有 OS 沙箱。只有信任代码后才授权运行。', importNoExecution:'创建实例会复制锁定整合包，不启动模块、不安装依赖；启动时会再次审阅并授权。', permissionChanges:'权限变化', changesRequireReview:'内容或解释器发生变化时，旧授权不适用。请审阅下列变化。', noPermissionChanges:'当前未报告权限变化；仍需审阅完整的当前内容。', reviewFingerprint:'当前内容指纹', fullManifest:'查看完整模块声明', sourceFiles:'{count} 个锁定源文件', capabilityContracts:'能力契约', declaredNotEnforced:'仅声明，非强制隔离', fileAccess:'文件', networkAccess:'网络', subprocesses:'子进程', noPermissions:'未提供权限声明', bridge:'桥', principal:'通信身份', pid:'进程 ID', runId:'本次运行 ID', observedAt:'观察时间', importedAt:'导入时间', instanceDirectory:'实例目录', instancesRoot:'实例根目录', platform:'系统平台', architecture:'架构', launcherVersion:'Launcher 版本', boundEnvironment:'导入时环境', privacyNotice:'日志可能包含业务数据。Runtime 对已知生成凭据脱敏，不能保证去除模块输出的全部秘密。', noLogs:'当前没有日志。', stdout:'标准输出', stderr:'标准错误', truncated:'日志已截断', allComponents:'全部模块', refreshLogs:'刷新日志', statusMeaning:'通信来自 Hub 连接快照；就绪与健康来自模块自报。这些状态不证明某次业务请求已完成。', staleMeaning:'监督者当前不可联系。这是保存的过时观察，无法据此证明进程在线或已经退出。', cleanupMeaning:'部分所属进程退出未确认。请查看诊断并重试停止；当前不能显示为完全停止。', notStarted:'这个实例还没有开始运行。先审阅并授权当前代码。', noModuleReview:'重新审阅当前实例，以查看完整模块来源、权限与解释器环境。', available:'可用', unavailable:'不可用', repairSteps:'修复指引', copy:'复制', copied:'已复制', copyUnavailable:'请手动选择并复制文本。', checkAgain:'重新检查', detectFirst:'点击重新检测，查看本机解释器和依赖。', detected:'环境检测完成。整合包锁的兼容性仍需逐包检查。', fixedProbes:'检查只运行固定的解释器探针，不自动安装依赖或修复环境。', sessionRequired:'当前页面没有本地授权会话。请运行 world-hub ui --open，从 Launcher 打开的页面进入。', sessionExpired:'本地管理会话已失效。请重新运行 world-hub ui --open 打开新的授权入口。', connectionFailed:'无法连接本机 Launcher。请确认 Launcher 仍在运行，然后刷新。', online:'在线', offline:'离线', toggleTheme:'切换主题', close:'关闭', mainNavigation:'主导航', systemNavigation:'系统导航', searchInstances:'搜索实例', lastRefresh:'最近刷新', sourceSafeText:'模块内容仅作为文本展示，应用入口会在独立标签页打开。', independentHub:'实例独立 Hub', defaultHub:'本机开发 Hub', defaultHubDescription:'供独立接入程序使用，沿用原有拓扑管理与通信工作台。外部桥的进程及业务状态未知。', startHub:'启动开发 Hub', stopHub:'停止开发 Hub', noRunningHub:'实例启动后，其独立 Hub 会出现在这里。', hubWaiting:'此 Hub 尚未运行。', externalUnknown:'外部接入 · 运行状态未知', managedBridge:'由此实例管理', bridgeOwnership:'桥归属', mappingNotice:'归属来自当前实例与本次运行映射；未匹配桥显示外部接入，不能凭名称推断所属。', topologyUnavailable:'启动实例后可查看实时桥归属与通信拓扑。', noBridges:'当前未观察到桥连接。', refreshTopology:'刷新桥归属', bridgeSession:'桥会话', permissionsReview:'查看审阅', sampleDirectory:'本地示例：{directory}', reviewChanged:'当前审阅内容已变化，请重新检查后再授权。', confirmImport:'创建实例', stoppedAt:'确认退出时间', startupFailure:'启动或运行诊断', envMissing:'环境未满足要求。根据以下指引准备环境后，再次检查。', viewInstance:'查看所属实例', defaultHubStarted:'开发 Hub 已启动。', defaultHubStopped:'开发 Hub 已停止。', permissionAdded:'新增', permissionRemoved:'移除', permissionExpanded:'扩大', runtimeCommunication:'Hub 通信状态', reviewEnvironmentHint:'要更换解释器，请先在环境与诊断选择路径，再重新审阅本实例。'
  },
  en: {
    skip:'Skip to content', localWorkspace:'Local workspace', workspace:'WORKSPACE', overview:'Overview', myPacks:'My packs', hubs:'Hub management', workbench:'Communication workbench', system:'SYSTEM', environment:'Environment & diagnostics', localRuntime:'Local Runtime', offlineLocal:'Local management works without community services.', localOnly:'Local only', refresh:'Refresh', packEyebrow:'YOUR LOCAL COLLECTION', packsSubtitle:'Make independent programs work together, from one place.', importPack:'Import a pack', onePlace:'ONE PLACE, YOUR PROGRAMS', welcomeTitle:'Combine capabilities. Make it your workspace.', welcomeText:'Import a local pack, review its source and permissions, and start your own instance. Modules, logs, and communication stay within reach.', independentInstances:'Independent instances · Local execution', instances:'Pack instances', searchPlaceholder:'Search name or instance ID', overviewSubtitle:'Processes, communication, and readiness each tell their own story.', hubsSubtitle:'Open existing topology management from an instance.', hubBoundary:'Hub manages communication; Runtime manages instances and processes. A connection does not establish business readiness.', workbenchSubtitle:'Open the existing communication workbench in Hub management to debug messages and request–response.', environmentSubtitle:'Detect your environment, select installed interpreters, then check each pack’s requirements.', interpreters:'Installed interpreters', detectOnly:'Detection only', nodePath:'Node.js path (optional)', pythonPath:'Python path (optional)', nodePlaceholder:'Use the Launcher’s Node.js', pythonPlaceholder:'Detect Python from PATH', probeNotice:'Detection runs fixed version and dependency probes with the selected interpreters. It does not run pack entry points or install scripts.', detectEnvironment:'Detect Environment & Discover Interpreters', securityBoundary:'Current protection boundary', noSandbox:'No OS sandbox', sandboxNotice:'Permissions are module declarations. Review authorizes the current code and environment. This Runtime does not enforce limits on filesystem, network, or system resource access.', isolationNotice:'Instances have independent directories and Hub identities. Programs running under the same account may still read other instance files. Run trusted code and protect data with operating system accounts and directory permissions.', backToPacks:'My packs', runtimeStatus:'Runtime status', modulesPermissions:'Modules & permissions', logs:'Logs', instanceDetails:'Instance details', footer:'Independent programs. Working together.', localPackage:'LOCAL PACKAGE', selectSource:'Select source', reviewPackage:'Review pack', createInstance:'Create instance', importDescription:'Enter a local pack directory. After validation, create an independent instance. Importing does not start programs.', packageDirectory:'Pack directory', instanceId:'Instance ID', environmentChoice:'Runtime environment', selectedInterpreters:'Use interpreters selected below', chooseInterpreters:'Choose installed interpreters (optional)', cancel:'Cancel', modifySource:'Change source', checkPackage:'Check pack', executionReview:'EXECUTION REVIEW', reviewAndTrust:'Review and authorize execution', trustConsent:'I have reviewed the current code sources, permissions, and environment. I trust this code to execute on this computer.', authorizeCurrent:'Authorize current review', exportPackage:'Export pack', exportNotice:'Export the locked pack into a new local directory, without instance data, logs, or Runtime credentials. Public settings are included; check that they contain no secrets.', destination:'New destination directory', totalInstances:'Total instances', runningInstances:'Running', moduleCount:'Modules', attention:'Needs attention', independentlyManaged:'Independent directories and Hub identities', observedProcesses:'Process observations for the current run', declaredModules:'Modules included in instances', failuresAndUnknown:'Failed or stale observations', items:'{count} instances', start:'Start', stop:'Stop', restart:'Restart', stopping:'Stopping', starting:'Starting', viewDetails:'View details', imported:'Imported', running:'Running', stopped:'Stopped', failed:'Failed', unknown:'Unknown', stale:'Stale observation', cleanupIncomplete:'Exit unconfirmed', modules:'Modules', communication:'Communication', connected:'Connected', disconnected:'Disconnected', ready:'Ready', notReady:'Not ready', process:'Process', readiness:'Module-reported readiness', health:'Health probe', businessResult:'Business result', businessUnknown:'Verify in the application', healthPassed:'Passed', healthFailed:'Not passed', noHealthCheck:'Not observed yet', processRunning:'Running', processExited:'Exited', emptyTitle:'Your first pack starts here.', emptyDescription:'Prepare a local directory with pack.json and pack.lock. Check the environment and code sources, then create your own instance.', noSearchResults:'No matching instances', openApp:'Open application', topology:'View communication topology', openWorkbench:'Open workbench', review:'Review current contents', reviewBeforeRun:'Starting reviews the current contents and environment, then asks for explicit authorization.', freshReview:'The review is recalculated before execution. Authorization applies only to these current contents.', trustAndStart:'Authorize and start', trustAndRestart:'Authorize and restart', checking:'Checking…', importing:'Importing…', loading:'Loading…', processing:'Processing…', importedSuccess:'Instance {id} created. Importing did not start any modules.', startAccepted:'Starting instance {id}.', stopAccepted:'Stopping instance {id}; waiting for owned processes to exit.', restartAccepted:'Restarting instance {id}.', exportedSuccess:'Exported to {destination}.', operationFailed:'Operation failed', source:'Code source', permissions:'Declared permissions', executionOrder:'Execution order', environmentReview:'Reviewed environment', codeExecutionNotice:'Starting executes the local modules below. Permissions are declarations; there is no OS sandbox. Authorize only code you trust.', importNoExecution:'Creating an instance copies the locked pack. It does not start modules or install dependencies. Execution requires a fresh review and authorization.', permissionChanges:'Permission changes', changesRequireReview:'Changed contents or interpreters invalidate previous authorization. Review the changes below.', noPermissionChanges:'No permission changes were reported. Review the complete current contents.', reviewFingerprint:'Current content fingerprint', fullManifest:'View complete module declaration', sourceFiles:'{count} locked source files', capabilityContracts:'Capability contracts', declaredNotEnforced:'Declared, not enforced isolation', fileAccess:'Files', networkAccess:'Network', subprocesses:'Child processes', noPermissions:'No permission declaration provided', bridge:'Bridge', principal:'Communication identity', pid:'Process ID', runId:'Current run ID', observedAt:'Observed at', importedAt:'Imported at', instanceDirectory:'Instance directory', instancesRoot:'Instances root', platform:'Platform', architecture:'Architecture', launcherVersion:'Launcher version', boundEnvironment:'Environment at import', privacyNotice:'Logs may contain business data. Runtime redacts its known generated credentials, but cannot guarantee removal of every secret emitted by modules.', noLogs:'No logs available yet.', stdout:'Standard output', stderr:'Standard error', truncated:'Logs truncated', allComponents:'All components', refreshLogs:'Refresh logs', statusMeaning:'Communication comes from Hub connection snapshots. Readiness and health are module reports. These observations do not prove that a business request completed.', staleMeaning:'The supervisor is currently unreachable. This is a saved, stale observation; it does not prove that processes are online or have exited.', cleanupMeaning:'Some owned process exits are unconfirmed. Review diagnostics and retry stopping. This instance cannot yet be shown as fully stopped.', notStarted:'This instance has not run yet. Review and authorize its current code first.', noModuleReview:'Review the current instance to see complete module sources, permissions, and interpreter details.', available:'Available', unavailable:'Unavailable', repairSteps:'Repair guidance', copy:'Copy', copied:'Copied', copyUnavailable:'Select and copy the text manually.', checkAgain:'Check again', detectFirst:'Detect the environment to inspect installed interpreters and dependencies.', detected:'Environment detected. Each pack’s locked compatibility still needs its own check.', fixedProbes:'Checks run fixed interpreter probes. Dependencies are not installed and environments are not automatically repaired.', sessionRequired:'This page has no local authorization session. Run world-hub ui --open and use the page opened by the Launcher.', sessionExpired:'The local management session expired. Run world-hub ui --open again to open a new authorized entry.', connectionFailed:'Cannot reach the local Launcher. Confirm that it is still running, then refresh.', online:'Online', offline:'Offline', toggleTheme:'Toggle theme', close:'Close', mainNavigation:'Main navigation', systemNavigation:'System navigation', searchInstances:'Search instances', lastRefresh:'Last refreshed', sourceSafeText:'Module content is displayed as text. Application entry points open in a separate tab.', independentHub:'Independent instance Hub', defaultHub:'Local development Hub', defaultHubDescription:'For independently connected programs, with existing topology management and workbench. External bridges have unknown process and business status.', startHub:'Start development Hub', stopHub:'Stop development Hub', noRunningHub:'An instance’s independent Hub appears here after the instance starts.', hubWaiting:'This Hub is not running yet.', externalUnknown:'External connection · Runtime unknown', managedBridge:'Managed by this instance', bridgeOwnership:'Bridge ownership', mappingNotice:'Ownership uses the current instance and run mapping. Unmatched bridges are external; names alone do not establish ownership.', topologyUnavailable:'Start the instance to see live bridge ownership and communication topology.', noBridges:'No bridge connections observed.', refreshTopology:'Refresh bridge ownership', bridgeSession:'Bridge session', permissionsReview:'View review', sampleDirectory:'Local example: {directory}', reviewChanged:'The reviewed contents changed. Check again before authorizing execution.', confirmImport:'Create instance', stoppedAt:'Confirmed exit time', startupFailure:'Startup or runtime diagnostic', envMissing:'Environment requirements are not satisfied. Prepare the environment using this guidance, then check again.', viewInstance:'View owning instance', defaultHubStarted:'Development Hub started.', defaultHubStopped:'Development Hub stopped.', permissionAdded:'Added', permissionRemoved:'Removed', permissionExpanded:'Expanded', runtimeCommunication:'Hub communication status', reviewEnvironmentHint:'To change interpreters, select paths under Environment & diagnostics, then review this instance again.'
  }
};

messages.zh.detached = '软件已隔离';
messages.en.detached = 'Software detached';
Object.assign(messages.zh, { useNavigation: '使用', createNavigation: '装配', my: '我的', observationUnknown: '当前观察未知', currentObservation: '当前运行观察', historicalLogs: '已结束运行的历史日志', currentRunLogs: '本次运行日志', reviewExpired: '审阅已过期，请重新检查后授权。', createFromPack: '以此包装配' });
Object.assign(messages.en, { useNavigation: 'Use', createNavigation: 'Create', my: 'My Assets', observationUnknown: 'Current observation unknown', currentObservation: 'Current runtime observation', historicalLogs: 'Historical logs from a finished run', currentRunLogs: 'Logs for this run', reviewExpired: 'The review expired. Check again before authorizing.', createFromPack: 'Create from this pack' });
Object.assign(messages.zh, { reviewValidUntil: '审阅有效期', sourceReceipt: '软件源来源收据', integrityNotIdentity: '摘要证明内容一致性；发布者身份与代码安全未验证。执行授权仍由你决定，当前没有 OS 沙箱。' });
Object.assign(messages.en, { reviewValidUntil: 'Review expires at', sourceReceipt: 'Software source provenance receipt', integrityNotIdentity: 'Digests establish content integrity. Publisher identity and code safety are unverified. You authorize execution; no OS sandbox is provided.' });
Object.assign(messages.zh, { healthUnknown: '健康未知', mappingUnknown: '归属观察未知' });
Object.assign(messages.en, { healthUnknown: 'Health unknown', mappingUnknown: 'Ownership observation unknown' });
Object.assign(messages.zh, { menuNavigation: '导航', menuOpen: '展开导航', menuClose: '收起导航' });
Object.assign(messages.en, { menuNavigation: 'Menu', menuOpen: 'Open navigation', menuClose: 'Close navigation' });
Object.assign(messages.zh, {
  browseMarketplacePacks: '从工坊获取更多整合包',
  importNewPack: '导入新建整合包',
  importNewPackDesc: '选择本机目录，检查并创建独立实例',
  restorePrivateBackup: '从私有备份恢复',
  restorePrivateBackupDesc: '从归档备份文件完整恢复到新实例',
  delete: '删除',
  deletePack: '删除整合包',
  deleteModule: '删除模块',
  deleteTemplate: '删除模板',
  addModule: '添加模块',
  confirmDelete: '确认删除',
  confirmDeleteTitle: '确认删除',
  addModuleToWorkbench: '添加功能模块到工作台',
  removeFromAssembly: '从装配中移除',
  noModulesAvailable: '暂无可添加的模块',
  selectFromKnownModules: '从模块库选择',
  selectFromLocalDir: '从本地目录选择'
});
Object.assign(messages.en, {
  browseMarketplacePacks: 'Get More Packs from Marketplace',
  importNewPack: 'Import New Pack',
  importNewPackDesc: 'Choose a local pack folder and create an instance',
  restorePrivateBackup: 'Restore Private Backup',
  restorePrivateBackupDesc: 'Restore an instance from a private backup archive',
  delete: 'Delete',
  deletePack: 'Delete Pack',
  deleteModule: 'Delete Module',
  deleteTemplate: 'Delete Template',
  addModule: 'Add Module',
  confirmDelete: 'Confirm Delete',
  confirmDeleteTitle: 'Confirm Delete',
  addModuleToWorkbench: 'Add Module to Workbench',
  removeFromAssembly: 'Remove from Assembly',
  noModulesAvailable: 'No modules available to add',
  selectFromKnownModules: 'Select from Module Library',
  selectFromLocalDir: 'Pick from Local Directory'
});

export function initialLanguage() {
  try { const saved = localStorage.getItem('world-hub.launcher.language'); if (saved === 'zh' || saved === 'en') return saved; } catch {}
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function translate(language, key, variables = {}) {
  let value = messages[language]?.[key] ?? messages.en[key] ?? key;
  for (const [name, replacement] of Object.entries(variables)) value = value.replaceAll(`{${name}}`, String(replacement));
  return value;
}

export function applyLanguage(language, root = document) {
  if (root === document) document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = translate(language, element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-label]')) element.setAttribute('aria-label', translate(language, element.dataset.i18nLabel));
  for (const element of root.querySelectorAll('[data-i18n-title]')) element.title = translate(language, element.dataset.i18nTitle);
  for (const element of root.querySelectorAll('[data-placeholder]')) element.placeholder = translate(language, element.dataset.placeholder);
}

Object.assign(messages.zh, { noSandbox:'可信本机模式：无 OS 沙箱', sandboxNotice:'trusted-local 模式不强制限制模块的文件、网络或资源。可在环境页面明确选择 Node／Python 容器保护或已有 Linux 用户身份分离；逐包审阅展示当前选择。', codeExecutionNotice:'启动将执行下列模块。请核对本次执行模式、代码来源、权限与环境后授权。可信本机模式没有 OS 沙箱；容器模式仅在声明范围内提供隔离。', integrityNotIdentity:'摘要证明内容一致性，发布者身份与代码安全未验证。请核对本次执行保护等级后授权。' });
Object.assign(messages.en, { noSandbox:'Trusted-local: no OS sandbox', sandboxNotice:'Trusted-local does not enforce module file, network, or resource restrictions. Select Node/Python container protection or existing Linux user identity separation on the environment page; each package review displays the current selection.', codeExecutionNotice:'Starting executes the modules below. Review this execution profile, code sources, permissions, and environment before authorizing. Trusted-local has no OS sandbox; the container profile enforces only its documented scope.', integrityNotIdentity:'Digests establish content integrity, not publisher identity or code safety. Inspect the current execution profile before authorizing.' });
Object.assign(messages.zh, { emptyDescription: '选择本机整合包，或从软件源获取。路径选择器提供已知候选与目录发现；检查来源与环境后创建实例。', importDescription: '选择或输入本机整合包目录，可从已知候选或目录发现开始。检查通过后创建独立实例，导入不会自动启动程序。' });
Object.assign(messages.en, { emptyDescription: 'Choose a local pack or fetch one from a software source. The path picker offers known candidates and folder discovery. Check the source and environment, then create an instance.', importDescription: 'Choose or enter a local pack folder. Start from known candidates or discover in a folder. After inspection, create an independent instance. Importing does not start programs.' });

Object.assign(messages.zh, {
  instanceHubsTitle: '实例独立通信枢纽',
  instanceHubsSubtitle: '每个实例运行完全隔离的通信总线与桥接拓扑，保障进程间通信与安全边界。',
  independentHubNotice: '专属于此实例的独立通信总线与桥接拓扑，保障本地模块隔离。',
  devHubTitle: '本机独立开发枢纽',
  devHubSubtitle: '供外部脚本、独立接入程序与调试桥连接，独立于整合包实例生命周期。',
  workbenchHeroTitle: '通信线协议与消息调试工作台',
  workbenchHeroSubtitle: '在独立窗口中以原生 Hub 视图调试 WebSocket 桥接、帧序列、RPC 请求响应及事件订阅。',
  workbenchTargetsTitle: '通信调试目标',
  workbenchTargetsSubtitle: '选择运行中的实例枢纽或开发枢纽，一键接入协议调试工作台。',
  workbenchTargetActive: '协议端点已就绪，可直接接入调试',
  workbenchTargetInactive: '实例未运行。启动后将自动激活独立 WebSocket 桥接端点',
  workbenchInstanceActive: '实例正在运行，已建立专属通信总线，可直接调试模块间消息与调用。',
  workbenchInstanceInactive: '实例未启动。点击下方按钮即可审阅并启动，自动开启专属调试端点。',
  workbenchDefaultDesc: '供开发调试使用的公用通信枢纽，可接入外部自定义桥接程序。',
  protocolReady: '协议端点在线',
  startInstanceToConnect: '启动实例并接入通信',
  openWorkbenchTarget: '打开调试工作台',
  openTopologyTarget: '打开拓扑控制台',
  noInstancesFound: '当前还没有导入任何整合包实例',
  noInstancesHubHint: '导入并创建实例后，其实例专属通信枢纽将自动展示在这里。',
  myModules: '我的模块',
  myTemplates: '我的模板',
  modulesTitle: '本地功能模块',
  modulesSubtitle: '显示本机已下载、缓存与发现的独立功能模块。模块拥有独立代码和能力契约，可在工作台中自由插拔改装。',
  templatesTitle: '整合包起步模板',
  templatesSubtitle: '基于官方与自定义规范骨架，一键脚手架生成全新整合包并载入工作台。',
  importModule: '导入本地模块',
  createTemplate: '制作新模板',
  scaffoldPack: '基于此模板创建整合包',
  useInCreator: '添加到整合包',
  modulesCountLabel: '{count} 个模块',
  templatesCountLabel: '{count} 个模板',
  noModulesFound: '暂无已发现的独立模块',
  noModulesHint: '模块是提供特定能力的微服务（如文本读取、词频统计、音频计算）。你可以前往「🛍️ 下载」获取扩展模块，或将包含 module.json 的本地目录导入。',
  noTemplatesFound: '暂无自定义模板',
  noTemplatesHint: '模板是快速生成整合包的标准骨架。你可以使用下方预置的官方模板，或将已有整合包制作并导出为新模板。'
});

Object.assign(messages.en, {
  instanceHubsTitle: 'Instance Communication Hubs',
  instanceHubsSubtitle: 'Each instance runs an isolated communication bus and bridge topology.',
  independentHubNotice: 'Dedicated communication bus and bridge topology isolated for this instance.',
  devHubTitle: 'Local Development Hub',
  devHubSubtitle: 'For external scripts, standalone bridges, and testing, independent of pack lifecycle.',
  workbenchHeroTitle: 'Wire Protocol & Message Debugger',
  workbenchHeroSubtitle: 'Debug WebSocket bridges, frame sequences, RPC requests, and event subscriptions in a dedicated tab.',
  workbenchTargetsTitle: 'Active Debug Targets',
  workbenchTargetsSubtitle: 'Select an active instance or development hub to inspect protocol streams.',
  workbenchTargetActive: 'Protocol endpoint ready for interactive debugging',
  workbenchTargetInactive: 'Instance is stopped. Start it to activate the WebSocket bridge endpoint',
  workbenchInstanceActive: 'Instance is running with a dedicated bus. Ready for message and RPC inspection.',
  workbenchInstanceInactive: 'Instance is stopped. Start it to open the dedicated debug endpoint.',
  workbenchDefaultDesc: 'Shared communication hub for development and custom external bridges.',
  protocolReady: 'Protocol Online',
  startInstanceToConnect: 'Start Instance & Connect',
  openWorkbenchTarget: 'Open Debugger Workbench',
  openTopologyTarget: 'Open Topology Console',
  noInstancesFound: 'No pack instances imported yet',
  noInstancesHubHint: 'Import and create an instance to see its dedicated communication hub here.',
  myModules: 'My Modules',
  myTemplates: 'My Templates',
  modulesTitle: 'Local Modules',
  modulesSubtitle: 'Discovered and cached modular components. Ready for composition and module swapping in Studio.',
  templatesTitle: 'Pack Templates',
  templatesSubtitle: 'Scaffold brand-new packs from official or custom templates and load them into Studio.',
  importModule: 'Import Module',
  createTemplate: 'Create Template',
  scaffoldPack: 'Create Pack from Template',
  useInCreator: 'Add to Pack',
  modulesCountLabel: '{count} modules',
  templatesCountLabel: '{count} templates',
  noModulesFound: 'No modules discovered yet',
  noModulesHint: 'Modules provide specific microservice capabilities (e.g. text reading, token statistics). You can fetch them from Marketplace or import a folder containing module.json.',
  noTemplatesFound: 'No custom templates yet',
  noTemplatesHint: 'Templates are standardized project skeletons. You can start with official templates below or create new templates from existing packs.'
});

Object.assign(messages.zh, {
  workbenchSubtitle: '管理实例通信拓扑与独立开发枢纽，在专用控制台调试原生线协议与消息流。',
  hostDiagnosticsEyebrow: '宿主运行时基线',
  hostDiagnosticsTitle: '宿主运行时基线与安全防护',
  hostDiagnosticsDesc: '检测已安装的解释器与固定依赖探针，配置执行隔离等级，确保整合包在受审阅的环境中安全运行。',
  trustedLocalProfile: '可信本机 · 无 OS 沙箱',
  dockerRuntimeProfile: 'Docker 容器隔离',
  dockerHeadlessProfile: 'Docker 原 Node 无界面',
  linuxUserProfile: 'Linux 用户身份分离',
  interpretersSubhead: '配置运行时可执行路径，运行固定探针或从本机快速发现可用候选。',
  probeResults: '探针检测结果',
  discoveryTitle: '发现与快速选用',
  discoveryDesc: '扫描 PATH 与系统常见路径中的解释器，一键填入左侧表单。',
  scanInterpreters: '发现已安装解释器',
  useThisPath: '选用此路径',
  securityBoundaryTitle: '执行保护模式与安全边界',
  activeProtection: '下次审阅的默认选择',
  pendingChange: '待应用变更',
  configMatchesActive: '表单与已选择的完整配置一致',
  securityAdvisoryTitle: '权限模型与保护边界说明',
  advancedOpsTitle: '高级依赖维护与产物库',
  sourcesEyebrow: '工坊与资源下载',
  sourcesHeroTitle: '社区内容与下载',
  sourcesHeroDesc: '浏览并获取官方及社区整合包、扩展模块与模板，经 SHA-256 安全校验后下载到本地使用。',
  sourcesActiveCount: '个已启用下载源',
  offlineCachePolicy: '仅限本机安全缓存 · 离线可用',
  integrityGuaranteed: 'SHA-256 完整性核验',
  creatorEyebrow: '整合包编排工作室',
  creatorHeroTitle: '工作台',
  creatorHeroDesc: '从来源开始，组合独立模块并配置能力合同，预检差异并派生新整合包。',
  openInCreator: '在工作台中打开',
  stepSource: '1 来源与基线',
  stepComposition: '2 组合与配置',
  stepGenerate: '3 检查与生成',
  launchpadTitle: '选择装配起始方式',
  launchpadOpenExisting: '打开本机整合包',
  launchpadTemplate: '从模板快速新建',
  launchpadRebuild: '环境锁重建',
  marketplaceEyebrow: '工坊内容浏览',
  marketplaceTitle: '浏览与下载',
  marketplaceDesc: '按分类检索整合包与功能模块，校验后一键下载到本机。',
  marketplaceSearchPlaceholder: '搜索整合包名称、功能模块或关键词…',
  sourcesConfigToggle: '管理下载源',
  sourcesConfigTitle: '下载源管理与设置',
  spotlightTitle: 'Peros 官方工坊内容下载',
  spotlightDesc: '获取经过声明摘要核对的跨语言模块与整合包，再单独审阅身份、代码和运行环境。',
  spotlightInspectFirst: '🚀 查看可用下载内容',
  composerEyebrow: '编排工作室',
  composerTitle: '依赖编排工作室',
  composerDesc: '以本地整合包为基准，可视化组合跨语言模块并校验能力合同，安全派生新版本。',
  launchpadHeroTitle: '选择或导入整合包，开启可视化装配',
  topologyTitle: '模块拓扑与能力连线',
  inspectorTitle: '属性检查与模块替换',
  deriveTitle: '派生并导出为新整合包',
  filterAll: '全部内容',
  filterPacks: '📦 完整整合包',
  filterModules: '🧩 功能模块',
  filterTemplates: '📋 起步模板',
  toolsetTitle: '装配与维护扩展工具箱',
  toolsetEyebrow: '扩展与维护',
  toolsetDesc: '模板脚手架 · 协作提案 · 离线发布 · 评论交换 · 锁文件重建',
  tabTemplates: '📋 模板脚手架',
  tabCollaboration: '🤝 协作与提案',
  tabPublish: '📦 制品发布',
  tabComments: '💬 本地评论',
  tabRebuild: '⚙ 环境与锁重建',
  securityAuditTitle: '发布者公钥与签名审计',
  securityAuditDesc: '公钥只用于验证签名并提示发布者身份，不会自动信任任何执行权限。',
  viewSecurityAudit: '查看签名证书与撤销清单 ▾',
  envTabInterpreters: '🔍 解释器与探针',
  envTabIsolation: '🛡️ 隔离模式与安全诊断',
  envTabDependencies: '📦 依赖环境准备',
  sourcesTabMarketplace: '🛍️ 浏览与下载',
  sourcesTabManage: '⚙️ 下载源管理'
});

Object.assign(messages.en, {
  workbenchSubtitle: 'Manage topology and debug wire protocol streams from instance and development hubs.',
  hostDiagnosticsEyebrow: 'HOST RUNTIME BASELINE',
  hostDiagnosticsTitle: 'Host Runtime Baseline & Security Boundaries',
  hostDiagnosticsDesc: 'Inspect installed interpreters and fixed probes, configure execution protection profiles, and verify pack requirements in a reviewed environment.',
  trustedLocalProfile: 'Trusted Local · No OS Sandbox',
  dockerRuntimeProfile: 'Docker Container Isolation',
  dockerHeadlessProfile: 'Docker Node Headless',
  linuxUserProfile: 'Linux User Separation',
  interpretersSubhead: 'Configure runtime executable paths, run fixed probes, or discover available candidates locally.',
  probeResults: 'Probe Results',
  discoveryTitle: 'Discovery & Quick Select',
  discoveryDesc: 'Scan PATH and common system locations for interpreters, then fill into configuration form.',
  scanInterpreters: 'Discover Installed Interpreters',
  useThisPath: 'Use this path',
  securityBoundaryTitle: 'Execution Protection Profiles & Security Boundaries',
  activeProtection: 'Default for the next review',
  pendingChange: 'Pending change',
  configMatchesActive: 'Form matches the complete selected configuration',
  securityAdvisoryTitle: 'Permission Model & Security Boundaries',
  advancedOpsTitle: 'Advanced Dependency Tools & Artifacts',
  sourcesEyebrow: 'WORKSHOP & DOWNLOADS',
  sourcesHeroTitle: 'Downloads & Workshop',
  sourcesHeroDesc: 'Browse and fetch official and community packs, modules, and templates with SHA-256 integrity verification.',
  sourcesActiveCount: 'active download sources',
  offlineCachePolicy: 'Local Secure Cache · Offline Ready',
  integrityGuaranteed: 'SHA-256 Integrity Checks',
  creatorEyebrow: 'PACK STUDIO · COMPOSITION & DERIVATION',
  creatorHeroTitle: 'Pack Studio',
  creatorHeroDesc: 'Start from a source, compose components and capability contracts, preview differences and create a derived pack.',
  openInCreator: 'Open in Creator',
  stepSource: '1 Source & Baseline',
  stepComposition: '2 Compose & Configure',
  stepGenerate: '3 Check & Create',
  launchpadTitle: 'Choose Starting Point',
  launchpadOpenExisting: 'Open Local Pack',
  launchpadTemplate: 'Start from Template',
  launchpadRebuild: 'Rebuild Lock',
  marketplaceEyebrow: 'WORKSHOP BROWSER',
  marketplaceTitle: 'Browse & Downloads',
  marketplaceDesc: 'Browse and search packs and modules by category, and download to local storage after verification.',
  marketplaceSearchPlaceholder: 'Search packs, modules, or keywords…',
  sourcesConfigToggle: 'Manage Download Sources',
  sourcesConfigTitle: 'Download Sources & Settings',
  spotlightTitle: 'Explore Peros Workshop Downloads',
  spotlightDesc: 'Get hash-verified polyglot components and packs ready for local composition.',
  spotlightInspectFirst: '🚀 Browse Available Downloads',
  composerEyebrow: 'COMPOSER STUDIO',
  composerTitle: 'Dependency Composer Studio',
  composerDesc: 'Based on a local pack, visually compose polyglot modules, verify capability contracts, and derive new packs.',
  launchpadHeroTitle: 'Select or import a pack to begin visual composition',
  topologyTitle: 'Component Topology & Bindings',
  inspectorTitle: 'Properties Inspector & Replacement',
  deriveTitle: 'Derive and Export as New Pack',
  filterAll: 'All Items',
  filterPacks: '📦 Full Packs',
  filterModules: '🧩 Modules',
  filterTemplates: '📋 Templates',
  toolsetTitle: 'Studio Extensions & Toolset',
  toolsetEyebrow: 'EXTENSIONS & UTILITIES',
  toolsetDesc: 'Templates · Collaboration · Publishing · Comments · Lock Rebuild',
  tabTemplates: '📋 Templates',
  tabCollaboration: '🤝 Collaboration',
  tabPublish: '📦 Publish',
  tabComments: '💬 Comments',
  tabRebuild: '⚙ Rebuild Lock',
  securityAuditTitle: 'Publisher Keys & Signature Audit',
  securityAuditDesc: 'Signatures are checked against keys; identity needs independently pinned trust. Neither grants execution permission.',
  viewSecurityAudit: 'View keys & revocations ▾',
  envTabInterpreters: '🔍 Interpreters & Probes',
  envTabIsolation: '🛡️ Isolation & Security',
  envTabDependencies: '📦 Dependency Preparation',
  sourcesTabMarketplace: '🛍️ Browse & Downloads',
  sourcesTabManage: '⚙️ Source Settings'
});
