# 新旧实例试用、原位升级与数据恢复

普通用户可以先保留旧实例，把候选版本准备到新的独立实例。已有原位升级也继续可用；两条路径都是外部 Runtime 的维护操作，Hub Core 不解释业务数据格式。预览中的 `diff` 按组件展示代码摘要及新增／移除／变化文件、合同、桥权限、依赖、平台、解释器要求和许可证的前后差异。`declarations:"exact-checked"` 仅表示两个包分别通过精确静态检查；`applicationBehavior:"not-validated"` 表示仍需运行应用场景。

## 先在新实例验证候选

先停止旧实例并确认所有所属进程退出，然后进行只读预览。必须选择新的实例 ID、候选目录、一个不存在的私有备份文件，以及明确的数据策略：

- `statePolicy:"fresh"`：新实例使用全新应用和 Hub 数据；旧数据只进入私人备份，不传给候选程序。这表示没有请求迁移，不能说旧数据已兼容新版本。
- `statePolicy:"provider"`：每个组件必须提供下文的 `preserve` 或 `migrate` 策略，同组件 ID 集合和同精确 Hub 版本才允许复制。`preserve` 是作者声明；迁移入口完成也只说明该次转换进程成功，不自动证明应用能正确使用新数据。

确认当前摘要后，Runtime 在停止锁下先完成一致性备份，随后导入新的候选实例。需要继承状态时，它先从私有备份恢复到新实例，再在新实例执行候选迁移。原实例的程序、身份和数据不会被工具覆盖，新实例使用新的桥凭据。任何源数据、候选内容、解释器或路径变化都会使旧预览失效。

```js
import { previewStagedUpgrade, createStagedUpgrade, inspectPackage, startInstance } from 'world-hub/runtime';
const request = {
  root: '/home/me/my-hub', instanceId: 'old', newInstanceId: 'trial',
  candidate: '/home/me/new-pack', backupDestination: '/home/me/backups/old-before-trial.whbackup',
  statePolicy: 'fresh', nodePath: '/usr/bin/node', pythonPath: '/usr/bin/python3'
};
const preview = await previewStagedUpgrade(request); // 展示 diff、备份范围和数据策略供用户审阅
const prepared = await createStagedUpgrade({ ...request, trust: preview.trustDigest }); // 仅在用户接受当前预览后调用
const execution = await inspectPackage(prepared.stateDir + '/package', request); // 独立的执行审阅
// 用户另行接受 execution 后才启动；trusted-local 不提供 OS 沙箱。
const trial = await startInstance({ ...request, instanceId: 'trial', trust: execution.digest });
// 使用程序公开界面验证真实业务、持久数据和必要副作用；健康检查通过不能替代业务验证。
await trial.close();
```

准备结果的 `healthValidation` 和 `businessValidation` 都是 `not-run`。启动并验证后，由用户决定是否继续使用新实例、保留旧实例或另行处置旧实例；Runtime 不自动切换流量或删除旧实例。候选启动失败、业务失败或作者迁移失败时，停止候选并重新审阅旧实例即可返回。失败候选和私人快照保留用于诊断；中断的候选原位事务仍使用下文恢复接口，不能靠删除锁文件绕过。

迁移入口仍是获授权的本机代码，可以访问其操作系统权限允许的路径。工具不会主动写入旧实例，也会重新检查旧数据是否被外部改写；这不构成对恶意迁移代码的 OS 防护。备份可能包含应用秘密，只用于本地私人恢复，不能作为公开 Pack 上传。

## 原位升级与完整快照回滚

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

流程为停止确认、只读预览、审阅摘要、私有快照、暂存候选与迁移、逐组替换、重新审阅后启动。快照包含软件、程序持久数据、Hub 日志／对象／管理状态与实例身份记录。每个组件数据目录顶层的 `tmp` 被视为临时材料，不进入快照；`runs`、控制凭据和监督者运行记录也不属于恢复的数据范围。程序应将需要保留的业务状态放在其他持久路径。预览绑定软件、权限、解释器、策略和当前数据；任何变化使旧确认失效。单文件上限 256 MiB，完整快照最多 8192 文件、512 MiB。

迁移代码属于明确授权的可信本机代码，不受 Node 容器执行 profile 保护。工具检查暂存其他组件与 Hub 数据是否被改写，但这不是 OS 沙箱。不得据此把恶意迁移代码当成安全代码。

```powershell
world-hub-pack upgrade-plan --root C:\MyHub --instance desk --candidate C:\NewPack --state-policies policies.json
world-hub-pack upgrade --root C:\MyHub --instance desk --candidate C:\NewPack --state-policies policies.json --trust <trustDigest>
world-hub-pack upgrade-history --root C:\MyHub --instance desk
world-hub-pack rollback-plan --root C:\MyHub --instance desk --transaction <transactionId>
world-hub-pack rollback-upgrade --root C:\MyHub --instance desk --transaction <transactionId> --trust <trustDigest>
```

正常回滚恢复原始软件和上述范围内的**完整旧持久数据**，可能替换升级后的新数据。必须重新检查并明确接受；工具先保存最新持久数据快照，再恢复原快照。不自动回滚后续运行的业务，不自动启动程序。新运行或新数据使以前的回滚预览失效。

每次事务的私有材料在 `instances/<id>/upgrades/<transactionId>/`。保留原快照、事务日志与暂存材料便于诊断。中断事务阻止再次启动，即使手动删除 `owner.lock` 也不能绕过。先用 `rollback-plan` 检查，返回 `recoveryRequired:true` 时用 `recover-upgrade` 与当前摘要显式恢复；恢复不执行迁移、不按历史 PID 杀进程。存留迁移进程退出未确认、外部修改或日志损坏会拒绝恢复，保留数据供人工处理。

公开 API 从 `world-hub/runtime` 导出：`previewStagedUpgrade`、`createStagedUpgrade`、`compareUpgradePackages`、`previewUpgrade`、`upgradeInstance`、`inspectUpgradeHistory`、`previewRollback`、`rollbackUpgrade`、`recoverUpgrade`。维护接口都接收 `{root,instanceId,...}`；新实例预览增加 `candidate`、`newInstanceId`、`backupDestination`、`statePolicy`，继承状态时增加 `statePolicies`；原位升级增加 `candidate` 与 `statePolicies`，恢复增加 `transactionId`，变更增加预览返回的 `trustDigest` 作为 `trust`。Launcher 的“存储与备份”中提供对应审阅操作。

## 返回代码版本不等于撤销业务世界

`rollbackBoundary` 在预览和结果中明确列出：工具只恢复所记录的软件和私人文件快照。它不能撤销已经调用的外部 API、已经发送或被其他程序抽取的消息，也不能恢复其他程序或远程数据库的状态。重新启动旧代码可能重新发送消息，业务方应自行实现幂等、补偿、去重或迁移协议。保留旧实例也不代表副作用自动可逆。

自动用例见 `staged-upgrade.test.mjs`：覆盖真实跨语言业务、独立执行授权、状态复制、旧预览失效、候选失败及迁移失败后旧实例继续工作。已有 `upgrade.test.mjs` 覆盖原位中断恢复和后续数据使旧回滚授权失效。这些场景证明其测试范围；真人新用户验收仍保留[待办](../independent-author-acceptance.md)。
