> 历史资料：已退出当前产品。整合包、模板及每包独立 Hub 的使用路径已取消；本页保留原设计和证据，不代表当前支持，也不提供旧版兼容入口。当前使用请看[单 Hub Launcher](launcher.md)。

# 外部程序整合包声明 v1

可选的作者部署默认值、锁定依赖准备和本机 Node 所属子进程 profile 见[部署扩展](launcher-deployment.md)与 [deployment.schema.json](deployment.schema.json)。Hub 不读取这些文件；原有 `processes: none` 模块继续兼容。

这套开放声明描述一组外部程序怎样部署和接线。它与可选的[参考 Runtime](runtime.md)共同构成本地导入、启动、停止和重建的实验。Hub 仍只负责通讯；它不读取这些清单、不选择程序、不安装依赖、不执行业务。

这里的 **枢纽桥（hub bridge）是程序连接 Hub 的双向通信适配层**，**可部署模块（module）可理解为“程序 + 枢纽桥”的外部程序包**。桥是模块的通信组成部分，不是模块整体。一个程序可以具有多座枢纽桥；枢纽桥可以嵌入既有应用，也可以作为独立适配器。可部署模块的启动入口和生命周期约定只适用于选择这套部署工具的程序，不是接入 Hub 的要求。没有 module、pack、目录、Runtime 或 Launcher 的程序仍可按照[通讯协议](../specs/protocol.md)和自己的 SDK 接入。

## 三份声明与校验层次

整合包目录包含 `pack.json`、`pack.lock`，以及锁中列出的模块源目录。推荐结构如下；目录名称不是 Hub 约定。

```text
text-desk/
  pack.json
  pack.lock
  modules/
    source/module.json
    source/program.mjs
    source/sdk/...
    stats/module.json
    stats/program.py
    stats/sdk/...
    desk/module.json
    desk/program.mjs
    desk/sdk/...
```

`pack.json` 表达组合意图；`module.json` 描述一个可启动部署包；`pack.lock` 锁定当前组合使用的完整模块源码、通信／启动配置契约与宿主环境。当前锁格式为 `world-hub.pack-lock/v2`，旧锁格式不受支持。规范独立于下载网站；静态检查、导入和启动授权仍是独立步骤。

机器形状见 [module.schema.json](module.schema.json)、[pack.schema.json](pack.schema.json) 和 [pack-lock.schema.json](pack-lock.schema.json)，采用 JSON Schema 2020-12。参考 Runtime 的手工校验实现是它的 v1 支持范围的权威实现：Schema 之外还必须检查路径、实际文件集合、大小限额、标识重复、交叉引用、依赖环、契约绑定及解释器环境。只通过 Schema 不足以导入或启动。

当前 module／pack v1 与 pack-lock v2 对象采用封闭字段，未知字段拒绝；程序自己的 `settings` 是开放 JSON 对象。版本使用 `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$` 的精确版本语法，不支持 `+build` 或版本范围，不隐式推导兼容性。这是此部署 profile 的简化语法，不是通用 SemVer 校验器。module ID、pack ID、组件 ID、桥槽及主题别名采用 `^[a-z0-9][a-z0-9._-]{0,63}$`。能力契约 ID 是程序间开放声明，不是 Hub 内置信息类别。

模块与组件各为 1–32 个，主题表为 1–64 项，每个模块的桥槽为 1–8 个，单个 provides／requires 为 0–32 个。启动、健康和停止期限各为 100–60000 毫秒。有限规模是参考部署工具的保护范围，不是 Hub 全局模块数或信息种类的上限。

## module.json：程序部署元数据

```json
{
  "format": "world-hub.module/v1",
  "id": "demo.source",
  "version": "1.0.0",
  "license": "MIT",
  "platforms": ["win32-x64", "linux-x64", "darwin-arm64"],
  "runtime": { "kind": "node", "entry": "program.mjs" },
  "bridges": ["main"],
  "provides": [{ "id": "text.read", "version": "1.0.0" }],
  "requires": [],
  "permissions": {
    "filesystem": "instance-state",
    "network": ["hub-loopback"],
    "processes": "none"
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `format` | 必须为 `world-hub.module/v1` |
| `id`、`version` | 部署包的身份与实现版本；不等于能力契约版本或通讯身份 |
| `license` | 非空许可声明；作者须另外携带需要的许可文本并遵守再分发条件 |
| `platforms` | 1–32 个 `os-arch` 平台名，语法为 `^[a-z0-9]+-[a-z0-9]+$`；例如 `win32-x64`。实际启动须匹配宿主且解释器可用，列出不构成已验收证明 |
| `runtime` | 此参考实现支持 `node`、`python`；`entry` 相对模块源目录，不是 shell 命令 |
| `bridges` | 1–8 个唯一的本地桥槽名；例如 `["input", "output"]` 对应同一程序的两座桥 |
| `provides`、`requires` | 提供或要求的能力 `{id,version}`；属于外部部署契约声明 |
| `permissions` | 有限的运行意图声明，用于审阅和信任摘要；不是 OS 沙箱授权 |

模块目录必须包含 `module.json`、入口及运行所需的所有随包源文件。使用 JavaScript 桥时，桥文件对 `blob-client.mjs` 的导入也必须随包携带或按自己的公开打包机制解决；锁不能只覆盖顶层入口。使用 Python 桥的模块携带自己的 `hub_bridge.py`，v1 的第三方 `websockets` 依赖由宿主预安装并核对锁中的版本。

参考 Runtime 的有限语言枚举是部署适配器的支持范围，不是 Hub 对语言或程序形态的限制。Rust、浏览器、宿主插件或其他形态仍可以直接接入 Hub，或由另一套 Runtime 启动。

权限对象的 v1 支持值为 `filesystem:"instance-state"`、`processes:"none"`、`network` 中 1–2 个唯一的 `hub-loopback`／`loopback-listen`。未知声明明确拒绝，不能悄悄当作获得授权。`loopback-listen` 允许模块声明一个本机服务入口；`instance-state` 表达程序将数据写到指定目录的意图。默认 trusted-local 执行没有文件系统、网络或进程沙箱，不能防止受信任运行的代码越过这些意图。可选 [Node 无界面容器 profile](isolation.md)采用独立审阅与固定限制，并拒绝 Python 或 `loopback-listen` 等不支持的形态；声明本身不会开启它。详见[执行与隔离边界](runtime.md#执行与隔离边界)。

## pack.json：组合与通信接线

```json
{
  "format": "world-hub.pack/v1",
  "id": "demo.polyglot",
  "version": "1.0.0",
  "title": "Cross-language text desk",
  "license": "MIT",
  "topics": {
    "source": "custom/text/read",
    "stats": "custom/text/statistics"
  },
  "components": [
    {
      "id": "source", "module": "demo.source", "after": [],
      "settings": { "text": "Hello 世界 🌍\n" },
      "bridges": { "main": { "publish": ["source"], "subscribe": ["source"] } }
    },
    {
      "id": "stats", "module": "demo.stats", "after": [], "settings": {},
      "bridges": { "main": { "publish": ["stats"], "subscribe": ["stats"] } }
    },
    {
      "id": "desk", "module": "demo.desk", "after": ["source", "stats"], "settings": {},
      "bridges": {
        "main": { "publish": ["source", "stats"], "subscribe": ["source", "stats"] }
      }
    }
  ],
  "bindings": [
    { "from": "source", "to": "desk", "contract": { "id": "text.read", "version": "1.0.0" } },
    { "from": "stats", "to": "desk", "contract": { "id": "text.statistics", "version": "1.0.0" } }
  ],
  "entry": { "component": "desk" },
  "startupTimeoutMs": 10000,
  "healthTimeoutMs": 3000,
  "stopTimeoutMs": 3000
}
```

`components[].id` 是这个组合中的部署实例名，`module` 引用锁中的部署包 ID。同一模块可以部署成多个组件；同一个组件也可以有多座桥。组件的 `bridges` 必须准确覆盖模块声明的桥槽。每座桥的 `publish`、`subscribe` 引用 `topics` 中的别名，Runtime 转换成通讯 ACL；主题值必须满足 Hub 的具体主题语法。这个部署 profile 只接受具体主题，不接受通配符。

可选的 `components[].topicAliases` 明确映射“程序自己的主题别名 → 包级主题键”，例如 `{"request":"t0","reply":"t1"}`。提供此映射时，程序配置中的 `topics` 仅包含这些别名及对应的具体主题；各桥 ACL 仍引用包级键，且必须落在该程序的映射范围内。映射不会增加权限，也不要求 ACL 的数量或顺序与作者初始默认值相同。Launcher 从本机 Hub 静态装配时使用此字段，完整保留独立程序的别名、未授予桥的主题和自定义桥权限；模块源码保持原样。

主体现有权限仍由 Hub 校验。通道须由模块自己的枢纽桥握手后声明／订阅；Runtime 不代替模块在 Hub 中注册业务通道，也不把 pack 主题表加入 Hub 的业务类别。程序主动新增的信息种类仍由其桥和双方的应用契约安排。

当前部署模型每组件分配一个 principal／credential，多桥使用同一主体，并按桥槽分配独立 bridgeId 和连接额度。组件中各桥声明的 ACL 汇总为该主体的通讯授权上限；它不是同一主体内部每座桥之间的安全隔离。需要互不信任的桥身份时，应使用不同组件／主体，或扩展外部部署工具。Hub 本身的 N:M 注记与多身份接入能力不因此改变。

`after` 是部署启动依赖，必须引用已有组件并构成无环图。它表示前置组件达到本次启动条件后再启动当前组件；不会使 Hub 执行业务工作流，也不保证前置程序永远健康。`bindings` 表明 `from` 提供与 `to` 需要的精确契约均存在；每个 required 契约必须具备绑定。Runtime 只校验声明，程序仍负责授权、请求、语义和结果验证。它不会依据能力 ID 自动选择提供者，不重写载荷，也不猜测可替换算法。

可选 `startupOrder` 列出全部当前组件 ID 各一次，包括手动启动的成员。例如 `["stats","source","desk"]` 使两个无前置的提供者按 stats → source 启动，再启动 desk。该列表必须满足全部显式 `after`，不能遗漏、重复或包含未知 ID；冲突明确拒绝。实际初始执行再按 `autostart` 筛选，不隐式启动计划外前置。省略字段时按原声明生成稳定拓扑顺序。动态增删与工作台快照同步维护列表，能力绑定不推导顺序。

`entry.component` 选择整合包入口程序。入口 URL 由该程序启动后提供；参考 Runtime 只接受其声明过的 loopback HTTP 服务地址。URL 可用不证明完整业务成功。`settings` 是程序自己的公开配置，Runtime 不解释其业务含义。不要把密码、API key 或私人正文放入可分享的 settings；导出会保留 pack 配置。

可选 `packType` 选择部署启动预设，省略为 `"atomic"`，也可明确选择 `"mesh"`。两型都按组件可选布尔值 `autostart`（缺省 true）选择初始计划成员。Atomic 要求本次选中集合全部启动成功，任一选中成员失败或受阻时清理整组；Mesh 采用 independent 时非关键成员实际启动失败可保留 Hub 和无关成员。`autostart:false` 不会被依赖方暗中改成启动；前置未就绪显示 `blockedBy`。全部手动时，两型都允许仅 Hub 运行而入口 URL 为空，其他成员之后可单独审阅启动。

可选 `lifecyclePolicy` 选择意外故障策略，显式值优先；省略时 Atomic 使用 `"fail-fast"`，Mesh 使用 `"independent"`。两种模式都允许高级覆盖，不从独立故障策略推断包类型。Mesh 显式采用 fail-fast 时，实际非关键初始启动失败也会停止整组；Atomic 初始全成约束始终保留。组件可选布尔值 `critical`（缺省 false）表示关键启动／运行保护：被请求启动的关键成员失败或关键成员意外失联、退出、健康失败时停止全组，即使采用 independent。尚未请求的手动关键成员不算失败，主动停止也不等于意外故障。

两个预设均保留经审阅的动态装配能力，既不是 Hub 业务类型，也不是应用安全等级或业务事务原子性保证。能力绑定不强加隐式启动顺序；需要前置就绪时明确声明 `after`。本次还可审阅选择 `startupMode:"hub-only"`，不改保存的计划。全部锁定源码和解释器仍须预检，取消、Hub 故障或清理未确认等部署错误不因“非关键”被忽略。详见[Atomic／Mesh 部署预设](../specs/dual-pack-paradigms-atomic-and-mesh-spec.md)与[启动计划](../specs/startup-plans-spec.md)。

当前 trusted-local Runtime 支持[运行中动态装配](../specs/dynamic-pack-assembly-spec.md)：经过审阅后添加受管模块、单独启停、调整停止组件的配置、移除，以及接纳自管外部程序。运行修改属于当前 run，不会悄悄改写 `pack.json` 或锁；工作台可将实际组合固化为更高版本。程序读到的配置仍是其启动快照，并非自动热更新。动态操作使用当前格式；不增加旧锁或旧协议兼容。

## pack.lock：完整源码、通信契约和环境

```json
{
  "format": "world-hub.pack-lock/v2",
  "pack": {
    "id": "demo.polyglot", "version": "1.0.0",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "hubVersion": "0.19.0",
  "hubCompatibility": { "wireVersion": "0.1", "runtimeApi": "world-hub.run/v1" },
  "platform": { "os": "win32", "arch": "x64" },
  "runtimes": {
    "node": { "version": "22.23.2" },
    "python": { "version": "3.14.0", "packages": { "websockets": "15.0.1" } }
  },
  "modules": [
    {
      "id": "demo.source", "version": "1.0.0", "source": "modules/source",
      "files": [
        { "path": "module.json", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
        { "path": "program.mjs", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
      ]
    }
  ]
}
```

上述零 hash 只说明形状，不能通过实际校验；完整示例还须列出其他模块及所有随包文件。`pack.sha256` 是 `pack.json` 原始文件字节的 SHA-256，不是重新序列化对象的 hash。模块 files 是源目录中**完整且准确**的普通文件集合，每个 path 相对其 source。缺文件、多文件、内容改动、重复路径、大小写冲突、链接或目录逃逸均须拒绝。目录之外的解释器、Hub 和第三方库不偷偷混进“源码锁定”的证明范围。

`hubVersion` 只记录生成锁时所用产品发布版本，不是导入或启动的兼容条件。`hubCompatibility` 必须完整声明当前通信协议 `wireVersion: "0.1"` 和模块启动配置 `runtimeApi: "world-hub.run/v1"`；两者均须与当前实现完全一致。不存在旧协议实现、范围推断或自动降级。旧版、未知格式、缺少契约或不受支持的契约均拒绝；应由作者提供当前格式的整合包。

OS／架构、解释器版本及 Python 库版本仍是精确要求。Python `packages` 是最多 32 项的预安装分发包名到精确版本的映射；锁定工具默认检查 `websockets:15.0.1`，另一个 Python 程序可以显式选择自己的依赖集合。这不是允许自动运行依赖安装脚本。版本相同不能证明解释器或已安装第三方库的二进制字节相同；源码锁不下载这些制品，也不给它们提供签名或二进制哈希。锁校验不是来源认证、安全证明、OS 隔离或所有业务行为可复现的保证。

变更模块源码、pack 接线、权限或环境选择后，应使用显式锁定工具重新生成锁并审阅。导入／启动不得因不匹配自动更新锁。另一平台或解释器版本需要明确重新锁定；不静默忽略平台信息。

**English — current compatibility contract.** Only `world-hub.pack-lock/v2` is accepted. `hubVersion` records the product release used to generate the lock; it does not require that release at import or start. `hubCompatibility` must exactly match the current wire protocol (`0.1`) and module run-configuration API (`world-hub.run/v1`). Missing, obsolete or unknown lock formats and unsupported contracts are rejected, without fallback. OS, architecture, interpreter and Python dependency versions remain exact requirements. The source hashes and full file set are still verified. Matching communications contracts do not establish compatibility of existing application or Hub persistent data; backup restore retains its separate actual-Hub-release checks.

## 标识、状态与留存

整合包可使用锁定的 `lineage` 声明来源基线与本地改装次数；当前部署版本始终是 `pack.version`。工作台空白创建的包标为自建，派生包保留首次来源。来源声明与摘要不是官方身份或安全证明。工作台可在停止后直接审阅保存至原实例，自动创建私有快照；详见[改装与版本恢复](../specs/pack-customization-spec.md)。

module ID 和版本属于可分发程序；component ID 属于部署组合；桥槽是本地接线名；principal／credential／bridgeId 是当前通讯身份配置；session 是 Hub 握手分配的当前连接地址。实例 ID 隔离整合包状态，不能代替认证身份。程序不能以业务正文中的这些字符串替代可信通讯信封。

锁定包与实例可写状态分开保存。每实例独立配置、游标、成果、Hub 日志／附件、凭据和监听端口；停止后保留实例数据，重新启动使用同一实例状态。复制包不会隐式复制用户成果或未消费通信记录。

Runtime 停止程序、探测健康失败、本地等待超时、SDK ACK、目录租约过期都不释放信息，也不证明请求未执行。提供者决定何时经自己的枢纽桥 `release`；恢复和幂等由外部程序自行安排。部署工具不自动重放未知业务结果的请求。

继续阅读：[Runtime CLI、生命周期与控制接口](runtime.md)、[独立能力提供者契约](../modules/provider-contract.md)、[Hub 边界](../specs/boundaries.md)。
