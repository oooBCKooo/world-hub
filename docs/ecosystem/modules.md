# 模块资源与实例 / Module resources and instances

模块（module）可理解为“程序 + 枢纽桥”。程序通过枢纽桥与 Hub 双向通信；桥可以嵌入程序或独立运行。通信管理界面的“模块”资源界面区分模块本体、模块配置和模块数据，分别管理和发布。Hub 连接不要求这些分发文件，程序也可以自行安装和运行后直接接入。

| 资源 | 内容 | 版本与使用 |
| --- | --- | --- |
| 模块本体 `module` | `module.json`、程序源码和作者默认声明 | 本体版本独立；导入到本体缓存不会创建或启动实例 |
| 模块配置 `configuration` | `configuration.json`，逻辑实例、精确本体引用、接线、参数、默认运行策略和启动计划 | 配置独立版本，`scope` 为全局或局部；应用前审阅逻辑实例映射与冲突 |
| 模块数据 `data` | `data.json` 与 `data/<逻辑实例>/` 的业务文件，声明适配本体及数据格式 | 数据独立版本，`scope` 为全局或局部；现成数据集可分享，私有备份只在本机导入导出 |

全局／局部是范围，三类资源保持相互独立。配置不携带模块源码，数据不携带管理器身份、凭据、私钥或运行配置。三类制品和版本都可从工坊取得；公开数据只接受 `purpose: "dataset"`，`backup` 不得发布。

## 本体、配置与实例

模块本体以 `module.json` 标识 ID、精确语义版本、许可、平台、解释器入口、桥槽、提供／需要的业务契约和权限声明。[module.schema.json](module.schema.json)描述结构。可选 `deployment.json` 是作者提供的新实例默认值，不是某次安装的私有配置或数据。

同一本体可供多个实例使用；每个实例拥有自己的 `programId`、桥身份、凭据、状态目录和公开配置。实例 ID 是安装时产生的本机身份，配置中的逻辑 ID 用于映射，不充当认证身份。组只引用已有实例，同一实例可被多个组引用而共享实际状态与进程；分组不复制实例、不扩大权限，也不创建另一台 Hub。

“模块配置”面板导入、创建和编辑逻辑配置，再单独打开应用审阅。每个本体依赖固定 `{id,version,digest}`；缺少本体时先取得并导入对应本体。审阅显示新增实例、复用映射、共享冲突和需要停止的受管实例。存在冲突或本体摘要、桥槽、设置及能力约束不符时不能应用；用户明确接受审阅后才修改本机登记，不自动启动程序。导入一个配置资源本身只加入配置库。

全局配置用于整个逻辑范围，局部配置用于明确成员范围。替换配置与复用同一实例需在审阅中显式映射，不能按相同名称猜测身份。配置来源版本、本机配置修订和 Hub 发行版本分别记录。下载历史版本也不会自动切换已安装实例。

## 模块数据

“模块数据”面板展示数据集或本机备份、作用范围、逻辑实例、适配模块本体、业务数据格式、文件数与大小。数据资源使用 `world-hub.module-data/v1`，每个实例将业务文件限定在 `data/<逻辑 ID>/` 中。模块作者定义业务格式和兼容性；管理器保留原始文件字节，不解析数据库、不运行转换脚本，也不因版本号相近而执行迁移。

导入数据与应用数据分别审阅。应用时明确选择目标实例，核对本体版本与摘要、数据格式、当前状态和覆盖影响；正在运行或发生变化的目标须重新处理和审阅。私有备份仅供本机导入导出，不进入社区的发布或提案通道。公开现成数据集也必须由作者审阅内容和再分发许可。

制品封装、完整示例与大小边界见[软件来源](sources.md)，本机事务与范围规则见[模块资源规范](../specs/module-resources.md)。当前公开入口拒绝旧 `module-group`、整合包和模板，不自动把旧制品转换成模块配置。

## 已安装实例的升级、降级与回退

在通信界面的本机模块或模块组操作中打开“版本升级与回退”。从工坊选择需要的发行版本并下载，或选择本机已有的目录、ZIP、JSON 制品，再将它作为该实例的目标版本。目标可以比当前版本更早；下载历史版本与切换已安装实例是两个步骤。普通“导入”仍创建新实例，不会覆盖现有实例。

1. 停止需要替换代码的模块实例。模块组只要求本次更新涉及的成员停止；仅从组中移除、未替换代码的成员可以继续独立运行。版本操作不会自动停启其他模块。
2. 选择目标版本，选择保留当前公开配置或采用作者配置，再选择保留当前实例数据或使用全新数据。
3. 审阅源码、权限、主题、能力绑定、成员变化和共享实例的影响，并明确确认数据兼容性尚未验证。
4. 应用后核对当前版本，再按需要启动模块或组计划。完成的变更出现在版本历史中，可选择一条记录审阅回退。

原位切换保留已有实例的 `programId`、通讯主体和私有身份凭据。模块业务数据位于各自的状态目录；新版本能否读取旧数据由模块程序负责，管理器不执行数据迁移脚本，也不会因为版本号看起来接近而判断兼容。配置保留仍须通过目标版本的设置、桥槽和能力约束；无法通过时应调整接线或选择作者配置后重新审阅。

同一发行版本不能对应不同源码；作者修改源码后应发布新的版本。通信界面的参数配置入口只修改公开配置，替换源码必须进入版本审阅，以保留可追溯历史。

| 选择 | 公开配置 | 实例私有数据 |
| --- | --- | --- |
| 更新：保留当前配置 | 保留设置、主题、桥权限和能力绑定；组计划保留仍存在的成员，新成员默认不自动启动 | 另选“保留当前实例数据”或“使用全新实例数据” |
| 更新：采用作者配置 | 使用目标模块默认值或模块配置，审阅新的权限与接线 | 同上，配置选择不会替代数据选择 |
| 回退：保留当前实例数据 | 恢复所选历史事务发生前的源码与公开配置 | 保留现在的数据，不撤销升级后程序写入的内容 |
| 回退：恢复历史实例数据 | 恢复所选历史事务发生前的源码与公开配置 | 恢复该事务开始前保存的状态目录快照，覆盖当前实例状态；历史中原本没有状态目录时恢复为不存在 |

“全新实例数据”将当前状态保存在私有事务快照中，再使用空状态目录。版本历史与这些快照只在本机保存，不上传社区、不进入公开配置导出。状态快照只覆盖受管实例自己的状态目录，不包括程序写入其他路径的数据、Hub 中的信息、其他模块状态或已经产生的外部副作用。代码回退不能撤回已发送的请求、已发布的信息或第三方服务中的变化。

### 模块组与共享实例

模块组按发布配方的成员 ID 跟踪原有实例。同一成员升级后继续使用原身份，新增成员创建独立实例；配方中移除的成员只离开本组，保留登记、源码、数据、其他组引用和当前运行状态。回退也不会删除本次新增的实例，它们可继续独立使用。相同逻辑成员 ID 不能悄悄换成另一个模块 ID，作者应给替换模块使用新的成员 ID。

一个实例被多个组引用时，原位升级会影响这些组看到的同一个实例。审阅会列出共享组和已登记消费者，不会为其他组自动复制实例或停止它们。新版本移除某个现有消费者仍绑定的准确能力契约时，切换被拒绝，应先处理消费者接线。配置发行版本表示来源配方；成员单独更新、接线和启动计划的本地调整可以与该来源基线不同。

自行创建、尚未建立发布来源的本地组可在审阅中明确建立一次来源基线。若同一模块在组中有多个候选实例，管理器拒绝猜测成员对应关系；先整理成明确的对应关系，再进行版本切换。

### 失败与中断

版本审阅绑定目标当前修订、源码摘要、解释器、实例状态和其他接线环境。审阅后源码、数据、成员或相关配置发生变化时，必须重新审阅。应用采用私有源码和状态快照记录事务；注册表写入或源码切换失败时尝试恢复原版本，不将未完成的操作记为成功历史。

若进程中断、磁盘故障等原因使恢复未完成，界面显示“需要恢复”的事务，相关实例在恢复前不能启动或继续修改。使用版本管理中的恢复操作，核对事务后恢复原状态；已经提交、仅清理标记失败的事务只补做清理，不撤销已完成的更新。不要手工删除事务目录或标记来绕过恢复。历史快照当前不自动清理；应为升级、保留的数据和历史快照预留磁盘空间。同次事务的状态快照合计最多 8192 项、512 MiB，单文件最多 256 MiB，包含状态目录内的临时材料；超限时拒绝切换，原实例不变。已脱组的成员可继续独立使用；若以后又注销其注册记录，引用该成员的旧组版本不能直接恢复，需先恢复相应注册。

恢复前若源码、身份、待恢复状态或快照已在管理器之外发生变化，恢复会拒绝覆盖并保留现场。原事务选择保留数据时，恢复也保留现在的数据。即使中断发生在实例标记写入之前，私有事务日志仍会阻止相关实例启动和修改。

## 常驻与按需运行

作者可在 `deployment.json` 中声明可选的 `executionDefaults`，建议模块采用常驻或按需模式及空闲停止时间。模块配置成员的 `configuration.executionDefaults` 可覆盖该模块的默认值。新实例按“配置成员默认值 → 模块默认值 → 常驻、60 秒”选取一份默认值，导入审阅显示最终运行策略及其来源。未填写 `idleTimeoutMs` 时使用 60000 毫秒。无论采用哪份默认值，导入后都保持停止，允许唤醒的调用者始终为空。

作者默认值只包含 `mode` 和可选 `idleTimeoutMs`，不包含 `allowedCallers`、本机实例 ID 或启动授权。用户可在模块抽屉中覆盖本机实例的策略；同一个实例被多个组共享时使用同一份策略。原位升级、降级与回退均保留已有实例的当前本机策略，即使选择采用作者公开配置，也不覆盖运行模式、空闲时间或调用授权；组更新新增的成员才采用新实例的默认规则。

- **常驻**：加入当前范围启动计划的实例随编排启动。常驻不表示开机自启、崩溃自动重启或已经在运行。
- **按需**：编排跳过此实例，保留接线、配置与数据。用户仍可手动启动；已明确授权的其他受管模块可通过生命周期客户端先唤醒，再发送原有业务调用。

启动计划中的选择、执行顺序和前置依赖仍分别保存。实际编排只启动“已选入计划且为常驻”的实例；绘制依赖不会自动选入计划，也不会将按需前置模块偷偷启动。需要尚未运行的前置实例时，该步骤显示受阻。

自动唤醒使用独立的本机生命周期管理枢纽桥契约，Hub Core 不读取运行策略、不查看业务正文，也不因普通消息自动执行代码。调用者使用私有运行配置中的 `lifecycle` 描述符，以及 JavaScript SDK 的 `callManaged` 或显式租约接口，见 [生命周期客户端](../../sdk/javascript/LIFECYCLE.md)。其他语言可按相同普通请求／回应契约实现客户端。已有调用者在首次启用按需功能后需重新启动，取得该描述符及控制主题权限；仅有普通 `Bridge.call` 的程序仍按原行为通讯。

策略中明确选择可唤醒的本机调用者，管理器依据认证后的通讯主体校验，不相信正文自报身份。缺少权限、源码被改动、所有权未知或待恢复的版本事务均不能绕过。多个并发调用共享同一次受管启动，各自持有租约；管理器只回传已确认就绪的目标地址，不代发业务请求。

空闲计时仅适用于管理器自动唤醒的同一次进程。所有调用明确完成后，等待配置的空闲时间（1 秒至 24 小时，默认 60 秒）再停止；任务持有有效租约时不停止。超时、断线或租约过期不能证明业务完成，会显示“结果未知”并阻止自动停止，需调用方明确完成或用户手动核对、停止。流式处理及收到首份回应后仍继续的任务，应持有显式租约至实际完成。

用户手动启动会固定该次运行，不因空闲而自动停止；修改运行策略不会立即启停进程。生命周期状态显示活动调用、结果未知的调用、手动保持与空闲停止时间。空闲停止不删除文件、不撤销已经产生的外部副作用，也不依据历史 PID 接管程序。

## 卸载实例与整组卸载

模块的“卸载”先显示审阅，列出本次注销的实例、仍会保留的实例、受影响分组和启动计划。实例属于模块组时，单独卸载会同时清理这些组中的成员引用和启动顺序引用，不再要求用户先手工脱组。仍有其他已登记模块通过能力绑定使用它时，卸载被阻止；先修改或卸载消费者，管理器不会静默删除消费者接线。

组管理提供两项不同操作：

- **仅删分组**：只删除分组及其启动计划，成员继续登记并保持运行状态。
- **整组卸载**：默认注销本组独占、且不被保留消费者依赖的成员，然后删除分组。被其他组共享的成员、被组外消费者绑定的成员，以及这些保留成员依赖的提供者继续保留。审阅中可取消更多成员；不能选择删除仍被保留实例使用的提供者或其他组共享的成员。

运行中的选定实例需要明确授权“停止选定模块后卸载”。管理器只停止自己当前拥有的这些子进程，不停止保留的共享实例或本机 Hub。仅有历史 PID、所有权未知或清理未完成的实例不能强制卸载，应先解决进程状态。进行中的版本恢复也会阻止相关卸载。审阅后可读源码、运行状态、接线或分组发生变化，需要重新审阅；纯健康观察时间的更新不使审阅失效。源码缺失或不可读取时仍可注销登记，不尝试重建或删除该目录，也不把它当作可执行源码。

**当前卸载仅注销本机实例，不删除源码、私有身份、运行数据或版本事务目录。** 不撤销已发布的信息、已发送的请求或外部副作用。保留文件不等于可在版本面板一键恢复：版本历史依赖现有实例登记，实例注销后不能直接从旧版本记录回退；重新导入通常创建新的实例和身份。整组注销按一次注册表提交处理，失败时恢复原登记、分组和启动计划；已经获得授权并停止的进程保持停止，不会自动重启，已撤销的连接凭据也不会悄悄重新授权。

## 恢复默认接线

接线模式顶部的“恢复默认接线”先显示审阅，再应用到当前范围。选择全部模块时，已应用模块配置中的成员采用该组保存的作者配方，其他实例采用各自 `deployment.json` 的默认主题与桥权限；选择模块组时采用该组配方。也可明确选择单个模块，这时使用模块自身默认值，审阅会标明来源，可能与它所在模块组的配方不同。没有发布来源的本地分组按成员自身默认值处理。

恢复只修改**主题映射、桥发布／订阅权限和能力绑定**，保留公开设置、源码与版本、身份、私有数据及全局／模块组启动计划。只有接线确实要变化的实例需要先停止；接线不变的运行实例可保持运行。此操作不自动停止、启动、安装或升级任何模块。

单模块的 `connections` 按准确模块 ID、版本、契约及别名权限匹配本机提供者。唯一候选可自动填入；多个候选必须明确选择，缺失时先另行导入需要的模块。若提供者也在同批恢复中，采用它恢复后的主题。作者未指定默认目标的能力要求保留当前合法提供者选择，不凭模块名称猜测替代程序。

模块组的作者接线配方在导入和组版本更新时保存在本机，独立于后来改装的实际接线；组更新选择“保留当前配置”也会记住新版本的作者配方。已有组若尚未保存配方，界面要求重新选择来源 ID、版本和成员匹配的原目录、ZIP 或 JSON 制品，先审阅再保存，不能把当前接线当作作者默认值。已脱组、已卸载或版本不匹配的必要成员不能靠恢复接线自动补回。

共享实例在多个组的默认接线不同时，“全部模块”会列出冲突并阻止恢复。明确选择某个组后可采用该组配方，但同一实例在其他组中的实际接线也会受影响，审阅列出这些共享组与能力消费者。审阅后源码、配置、分组或进程状态改变，需要重新审阅。批量应用采用一次注册表提交，失败恢复整批原接线；已撤销的凭据保持撤销，模块仍须通过正常启动审阅重新授权。

## 可选接入默认值

`deployment.json` 使用 `world-hub.deployment/v1`，结构见[deployment.schema.json](deployment.schema.json)。

- `topics`：别名到具体主题的映射；主题由程序作者约定。
- `bridges`：每个声明桥槽按别名指定发布／订阅权限。
- `settings`：带类型、名称、默认值和可选范围的公开设置。
- `dependencies`：可选、明确受支持的锁定依赖准备声明；不是任意安装脚本入口。
- `connections`：可选的默认连接，指定准确的目标模块 ID、版本、能力契约，以及本模块别名到目标别名的映射。
- `executionDefaults`：可选的运行建议；必填 `mode` 为 `resident` 或 `on-demand`，可选 `idleTimeoutMs` 为 1000 至 86400000 的整数，默认 60000。不得包含调用者或启动权限。

参数必须满足真实类型与范围，不能放入 token、密码或私钥。默认值只是作者建议，用户审阅后按实际环境配置。未提供默认值不代表 Hub 应猜测协议。

例如，在 `deployment.json` 中增加以下字段，让新实例默认按需运行：

```json
"executionDefaults": {
  "mode": "on-demand",
  "idleTimeoutMs": 60000
}
```

模块组可在某一成员的 `configuration` 中放入相同字段，只覆盖该成员的运行建议。导出模块组时，成员当前策略中的 `mode` 与 `idleTimeoutMs` 写入这份可分发默认值；本机 `allowedCallers` 不导出。接收者仍须自行选择允许唤醒的本机调用者，默认按需不等于任何模块都能启动它。

例如，计数模块可以声明自己需要的桌面显示模块：

```json
"connections": [
  {
    "id": "desktop",
    "provider": {
      "moduleId": "example.soft-ui-desktop",
      "version": "0.3.0"
    },
    "contracts": [{ "id": "soft-ui.windows", "version": "1.0.0" }],
    "topics": { "commands": "commands", "events": "events" }
  }
]
```

`provider` 使用可发布的模块身份，不使用某位用户电脑上的实例 ID；模块版本与能力契约版本分别匹配。`topics` 的键是导入模块自己的别名，值是目标模块的别名。导入审阅采用目标当前配置中的具体主题，不修改目标模块的参数、接线或桥权限。双方已声明的发布／订阅权限还必须支持对应的数据方向。纯主题连接可以使用空 `contracts`，不需要为接线虚构业务能力。

单模块导入按以下情况处理：

- 本机已登记唯一符合目标 ID、模块版本、契约和别名权限的实例：自动填好接线，显示在导入审阅中。
- 存在多个符合的独立实例：显示候选，用户明确选择，不按名称或列表顺序猜测。
- 本机没有匹配实例：显示缺少的模块 ID、版本与契约，提示下载并导入需要的模块；完成后重新检测。已经下载到模块库的制品仍需导入为本机实例。

选择与导入不会自动下载、执行依赖或启动程序，也不会扩大目标权限。目标配置在审阅后发生变化时，需要重新检测接线。发布者更改默认连接应发布新的模块版本，保留已发布制品的原有字节和摘要。没有默认目标的 `requires` 仍用于选择可替换能力提供者；默认目标只是部署层的作者建议，Hub Core 不读取或执行这些规则。

## 运行支持与安全边界

当前参考管理器支持明确的 Node／Python 程序入口，检查源码、解释器、接线和公开设置后生成独立私有配置。就绪、自报健康、进程存活和真实桥连接分别观察。实际源码分发有文件数和字节上限；已安装依赖或大型原生应用应采用自己的安装方式，再通过桥接入。

声明权限不是操作系统沙箱。自行运行的桌面宿主、服务或其他语言程序使用自己的安装、状态和生命周期，见[独立程序接入](external-programs.md)。

## 开发与替换

业务契约由外部程序选择。要实现示例的可替换统计能力，阅读[提供者契约](../modules/provider-contract.md)、[机器契约](../modules/text-statistics.contract.json)和对应 SDK。匹配的 `provides`／`requires` 仅是候选声明，实际消费者仍需验证身份、版本、权限和业务结果。

A module combines a program and its hub bridge in an installable artifact; a hub bridge provides bidirectional communication between the program and the Hub. A program may use several bridges, embedded or separate. The communication management interface uses `module.json` for optional deployment assistance; it is not a Hub handshake requirement. A downloadable configuration pins exact module body versions and source digests without embedding sources; independently versioned datasets carry business files. Imported members remain independent instances on the same local Hub. Global/local configuration scopes share the same Hub. Public datasets and local private backups carry no manager credentials or runtime configuration; acquisition starts no programs. Artifact versions, local configuration revisions and Hub releases are distinct. Application compatibility must be tested through real consumers.

An optional `deployment.json` `connections` entry pins a default provider module ID and version, required contracts, and consumer-to-provider topic aliases. A unique matching installed instance is filled into the import review; multiple matches require an explicit choice; missing providers show what to download and import before checking again. The manager uses the chosen provider's current topic values without changing that provider's configuration or permissions. Full member configuration in a configuration resource takes precedence over member deployment defaults and never resolves an external target. These are deployment suggestions interpreted by the management layer; Hub Core retains its communication-only role.

Installed modules and groups support reviewed in-place upgrades, downgrades and transaction-history rollback through the communication interface. Stop the instances whose code will change, select a downloaded release or local artifact, review configuration and private-data policies, and apply. Existing instance identities and credentials remain unchanged. Removed group members remain independently registered; shared instances affect every group referencing them. Missing capabilities still required by an installed consumer block a change. Rollback restores the selected transaction's previous code and public configuration, while keeping current private state or explicitly restoring that transaction's pre-change state snapshot. Data compatibility and migrations belong to the application; external side effects cannot be undone. Interrupted transactions block affected starts until recovery; downloads, updates, rollback and recovery do not start programs.

Authors may set `executionDefaults` in `deployment.json`, for example `{"mode":"on-demand","idleTimeoutMs":60000}`. `mode` is required (`resident` or `on-demand`); the optional idle timeout is an integer from 1000 to 86400000 milliseconds and defaults to 60000. A configuration member's `configuration.executionDefaults` takes precedence over its module default; otherwise a new instance defaults to resident with a 60-second timeout. Import review shows the selected policy and its source. Every imported instance remains stopped and has an empty `allowedCallers` list. These defaults grant no execution permission. Users may change local policy; upgrades, downgrades and rollback retain existing instances' current policy even when author configuration is selected. Newly added group members use the new-instance rules. Configuration export writes only mode and idle timeout as member defaults, never local caller IDs or grants.

Uninstall is reviewed registration removal. Removing one module also detaches its group and startup-plan references, but retained capability consumers block provider removal. “Remove group only” retains its modules and their running state; “Uninstall group” defaults to removing exclusive members while retaining shared instances and the full provider dependency closure needed by retained consumers. Only selected, currently owned processes may be stopped with explicit acceptance. Source, identity, state and version files remain in place, but history cannot directly restore an unregistered instance. A failed registry commit retains all registrations and plans; authorized stops remain stopped and revoked credentials are not silently restored. The shared Hub keeps running.
