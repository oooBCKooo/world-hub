// User guidance describes an action; it never authorizes a repair or executes it.
export function diagnose(error) {
  const message = String(error.message), code = error.code ?? 'LAUNCHER_ERROR';
  if (['external-program', 'module-source', 'pack-source', 'deployment-source-limit'].includes(error.diagnostic?.kind)
      && typeof error.diagnostic.zh === 'string' && typeof error.diagnostic.en === 'string') return { ...error.diagnostic, code };
  if (code === 'PACK_LOCK_OBSOLETE' || /lock has missing or unsupported fields/i.test(message)) return { code: 'PACK_LOCK_OBSOLETE', kind: 'obsolete-pack-format', action: { view: 'sources' },
    zh: '此资源使用已停用或不完整的锁格式（pack.lock）。启动器只接受符合当前规范的 world-hub.pack-lock/v2。请在软件源获取作者发布的当前资源。',
    en: 'This resource uses a discontinued or incomplete lock format (pack.lock). The Launcher requires world-hub.pack-lock/v2. Get a current resource published by its author from Software Sources.' };
  if (code === 'PACK_HUB_CONTRACT_UNSUPPORTED') return { code, kind: 'unsupported-hub-contract', action: { view: 'sources' },
    zh: '此资源要求的 Hub 通讯或 Runtime 接口契约当前不受支持。请作者适配下方当前契约后发布，再从软件源获取当前资源。',
    en: 'This resource requires an unsupported Hub communication or Runtime API contract. Ask its author to adapt to the current contracts below and publish an updated resource, then obtain it from Software Sources.' };
  if (code === 'INSTANCE_HUB_STATE_VERSION') return { code, kind: 'instance-state-version',
    zh: '此实例的 Hub 状态写入版本未知或不是当前版本。请创建全新实例；现有状态需要明确的迁移方案，修改源码锁不能转换这些状态。',
    en: 'This instance has an unknown or different Hub state writer. Create a fresh instance; existing state requires an explicit migration plan. Rewriting a source lock cannot convert that state.' };
  if (code === 'SOURCE_REVIEW_REQUIRED' || /inspect.*source|source.*receipt/i.test(message)) return { code, kind: 'source-review-required', action: { view: 'sources' },
    zh: '软件源审阅已过期（超过 10 分钟）或软件源配置已变更。请在“下载 / 软件源”中重新点击浏览或检查，刷新凭据后再获取制品。',
    en: 'The software source review has expired (10-minute limit) or its configuration changed. Inspect the source again to refresh credentials before fetching.' };
  let kind = 'action-failed';
  if (/cleanup|exits.*unconfirmed/i.test(message) || error.cleanupIncomplete) kind = 'cleanup-unconfirmed';
  else if (/stale|supervisor.*unavailable|different.*run|ended.*run/i.test(message)) kind = 'stale-run';
  else if (/^INTERPRETER_(?:VERSION|ARCHITECTURE)|^PLATFORM_/.test(code)) kind = 'compatibility';
  else if (/(?:instance|directory|data)(?: is)? locked|holds.*lock|owner.*lock/i.test(message)) kind = 'owned-instance';
  else if (/revision conflict|changed after|changed.*review|source.*changed|review.*changed|hash.*mismatch|digest.*mismatch/i.test(message)) kind = 'content-changed';
  else if (/interpreter.*not found|interpreter.*missing|choose.*installed|missing(?: or unusable)? (?:node|python) runtime|ENOENT.*(?:python|node)/i.test(message)) kind = 'missing-interpreter';
  else if (/dependency|dependencies|recipe.*unavailable|websockets/i.test(message)) kind = 'dependency';
  else if (/version|platform|architecture|incompatible.*environment/i.test(message)) kind = 'compatibility';
  else if (/EADDRINUSE|address.*use|port.*conflict/i.test(message)) kind = 'port-conflict';
  else if (/timeout|deadline|ready.*timed/i.test(message)) kind = 'timeout';
  else if (/exited|crash|tool.*failed|process.*failed/i.test(message)) kind = 'process-failed';
  const guidance = {
    'action-failed': ['检查下方具体原因及目标目录，再重新执行此操作。当前内容没有获得运行授权。', 'Read the concrete cause and check the destination before retrying. This operation grants no execution permission.'],
    'cleanup-unconfirmed': ['所属进程退出尚未确认。重试停止并查看日志；确认前不要备份、卸载或新建同一实例的运行。', 'Owned process exits are unconfirmed. Retry Stop and inspect logs. Wait for confirmation before backup, detach or another run.'],
    'stale-run': ['这份记录不证明程序仍在线。刷新当前实例；若监督者已丢失，保留数据并检查原终端及锁的所有权。', 'This record does not prove the program is online. Refresh the instance. If its supervisor is lost, retain data and inspect the owning terminal and lock.'],
    'owned-instance': ['联系原监督者停止当前运行。锁中的 PID 仅供诊断，不能据此结束其他进程或自动删除锁。', 'Stop the current run through its owning supervisor. A stored PID is diagnostic information, not authority to kill another process or delete its lock.'],
    'content-changed': ['重新读取并审阅当前内容。提案或评论发生版本冲突时保留两份内容，由作者明确解决后再提交。', 'Inspect and review the current content again. Keep both versions of conflicting proposals or comments; resolve them explicitly before submitting.'],
    'missing-interpreter': ['在“环境”中发现或填写已安装解释器路径并检测。可使用便携发行包的 Node；先安装 Python 后才能准备其独立依赖环境。', 'Discover or enter an installed interpreter in Environment and check it. Portable releases include Node. Install Python before preparing its private dependency environment.'],
    'dependency': ['选择匹配的独立环境。受支持的锁定依赖可审阅准备方案；其他依赖请在自己的 venv 中手动准备，然后重新检测。', 'Select a matching private environment. Review a preparation plan for supported pinned dependencies. Prepare other dependencies manually in your own venv, then check again.'],
    'compatibility': ['核对锁定的解释器版本与 OS／架构，选择匹配的已安装环境。需要改变要求时，由作者发布当前格式的资源，再重新审阅。', 'Check the locked interpreter versions and OS/architecture and select a matching installed environment. Changes to requirements need an author-published resource in the current format and a fresh review.'],
    'port-conflict': ['查看日志中报冲突的程序与端口。调整该程序公开配置并创建新派生包；不要结束不属于本实例的进程。', 'Read the application and port in the logs. Adjust its public configuration and create a derived pack; do not terminate processes outside this instance.'],
    'timeout': ['查看模块日志及就绪、健康、通讯各自状态。确认实际清理完成后修正应用配置或环境，再审阅重启。', 'Inspect module logs and the separate ready, health and communication states. After confirmed cleanup, fix application configuration or environment, then review and restart.'],
    'process-failed': ['查看故障模块日志，核对入口、依赖及应用配置。进程退出不代表已提交的业务被取消；等待清理确认后再操作。', 'Inspect the failed module logs, entry, dependencies and application configuration. Process exit does not cancel previously submitted work. Wait for confirmed cleanup.'],
  };
  return { code, kind, zh: guidance[kind][0], en: guidance[kind][1] };
}
