// User guidance describes an action; it never authorizes a repair or executes it.
export function diagnose(error) {
  const message = String(error.message), code = error.code ?? 'LAUNCHER_ERROR';
  let kind = 'action-failed';
  if (/cleanup|exits.*unconfirmed/i.test(message) || error.cleanupIncomplete) kind = 'cleanup-unconfirmed';
  else if (/stale|supervisor.*unavailable|different.*run|ended.*run/i.test(message)) kind = 'stale-run';
  else if (/locked|holds.*lock|owner.*lock/i.test(message)) kind = 'owned-instance';
  else if (/revision conflict|changed after|changed.*review|source.*changed|review.*changed|hash.*mismatch|digest.*mismatch/i.test(message)) kind = 'content-changed';
  else if (/interpreter.*not found|interpreter.*missing|choose.*installed|ENOENT.*python/i.test(message)) kind = 'missing-interpreter';
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
    'compatibility': ['核对要求的 Hub、解释器版本与 OS／架构。选择匹配环境；作者可明确重建源码锁，再重新审阅，不自动改锁。', 'Check the required Hub/interpreter versions and OS/architecture. Select a matching environment. Authors may explicitly rebuild a source lock, then review again; locks are not changed automatically.'],
    'port-conflict': ['查看日志中报冲突的程序与端口。调整该程序公开配置并创建新派生包；不要结束不属于本实例的进程。', 'Read the application and port in the logs. Adjust its public configuration and create a derived pack; do not terminate processes outside this instance.'],
    'timeout': ['查看组件日志及就绪、健康、通讯各自状态。确认实际清理完成后修正应用配置或环境，再审阅重启。', 'Inspect component logs and the separate ready, health and communication states. After confirmed cleanup, fix application configuration or environment, then review and restart.'],
    'process-failed': ['查看故障组件日志，核对入口、依赖及应用配置。进程退出不代表已提交的业务被取消；等待清理确认后再操作。', 'Inspect the failed component logs, entry, dependencies and application configuration. Process exit does not cancel previously submitted work. Wait for confirmed cleanup.'],
  };
  return { code, kind, zh: guidance[kind][0], en: guidance[kind][1] };
}
