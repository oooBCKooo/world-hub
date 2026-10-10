# 已停止实例的升级与完整数据回滚

这是可选外部 Runtime 的维护事务，Hub Core 不解释程序的数据格式或选择迁移策略。候选 Pack 必须已完整锁定，当前与候选组件 ID 集合保持相同，Hub 精确版本及宿主环境兼容。需要更改组件集合或 Hub 版本时，先使用私人备份、新实例恢复与作者明确的迁移方案。

每个组件必须提供一种明确策略，工具不猜测兼容性：

```json
[
  {"componentId":"source","mode":"preserve","dataFormat":"provider-defined-v1"},
  {"componentId":"stats","mode":"preserve","dataFormat":"provider-defined-v1"},
  {"componentId":"desk","mode":"preserve","dataFormat":"provider-defined-v1"}
]
```

`preserve` 表示作者声明新程序能读取原始数据，格式名称由程序作者定义。`migrate` 显式声明 `fromFormat`、`toFormat`、`runtime`、`entry` 和 `timeoutMs`，只允许候选模块锁中的普通迁移入口，与该模块运行时一致。迁移程序收到的首个参数为配置文件路径，其中 `dataDirectory` 指向暂存数据；它应自行检查格式并完成转换。工具不会替它实现业务转换。

流程为停止确认、只读预览、审阅摘要、私有快照、暂存候选与迁移、逐组替换、重新审阅后启动。快照包含软件、程序数据、Hub 日志／对象／管理状态与实例身份记录，不包含旧进程凭据的运行目录。预览绑定软件、权限、解释器、策略和当前数据；任何变化使旧确认失效。单文件上限 256 MiB，完整快照最多 8192 文件、512 MiB。

迁移代码属于明确授权的可信本机代码，不受 Node 容器执行 profile 保护。工具检查暂存其他组件与 Hub 数据是否被改写，但这不是 OS 沙箱。不得据此把恶意迁移代码当成安全代码。

```powershell
world-hub-pack upgrade-plan --root C:\MyHub --instance desk --candidate C:\NewPack --state-policies policies.json
world-hub-pack upgrade --root C:\MyHub --instance desk --candidate C:\NewPack --state-policies policies.json --trust <trustDigest>
world-hub-pack upgrade-history --root C:\MyHub --instance desk
world-hub-pack rollback-plan --root C:\MyHub --instance desk --transaction <transactionId>
world-hub-pack rollback-upgrade --root C:\MyHub --instance desk --transaction <transactionId> --trust <trustDigest>
```

正常回滚恢复原始软件和**完整旧数据**，可能替换升级后的新数据。必须重新检查并明确接受；工具先保存最新数据快照，再恢复原快照。不自动回滚后续运行的业务，不自动启动程序。新运行或新数据使以前的回滚预览失效。

每次事务的私有材料在 `instances/<id>/upgrades/<transactionId>/`。保留原快照、事务日志与暂存材料便于诊断。中断事务阻止再次启动，即使手动删除 `owner.lock` 也不能绕过。先用 `rollback-plan` 检查，返回 `recoveryRequired:true` 时用 `recover-upgrade` 与当前摘要显式恢复；恢复不执行迁移、不按历史 PID 杀进程。存留迁移进程退出未确认、外部修改或日志损坏会拒绝恢复，保留数据供人工处理。

公开 API 从 `world-hub/runtime` 导出：`previewUpgrade`、`upgradeInstance`、`inspectUpgradeHistory`、`previewRollback`、`rollbackUpgrade`、`recoverUpgrade`。维护接口都接收 `{root,instanceId,...}`；升级增加 `candidate` 与 `statePolicies`，恢复增加 `transactionId`，变更增加预览返回的 `trustDigest` 作为 `trust`。Launcher 的“存储与备份”中提供对应审阅操作。
