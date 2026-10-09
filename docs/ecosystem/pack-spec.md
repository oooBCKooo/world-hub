# 外部程序整合包声明 v1

这套开放声明描述一组外部程序怎样部署和接线。它与可选的[参考 Runtime](runtime.md)共同构成本地导入、启动、停止和重建的实验。Hub 仍只负责通讯；它不读取这些清单、不选择程序、不安装依赖、不执行业务。

这里的 **mod 是通讯桥**，**module 是外部程序部署包**。两者不是同一对象。一个程序可以具有多座桥；桥可以嵌入既有应用，也可以作为独立适配器。module 的启动入口和生命周期约定只适用于选择这套部署工具的程序，不是接入 Hub 的要求。没有 module、pack、目录、Runtime 或 Launcher 的程序仍可按照[通讯协议](../specs/protocol.md)和自己的 SDK 接入。

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

`pack.json` 表达组合意图；`module.json` 描述一个可启动部署包；`pack.lock` 锁定当前组合使用的完整模块源码与环境版本。规范独立于下载网站。v1 参考实现只导入本地普通目录，不下载远程程序、不解压不受信任归档、不执行安装脚本。

机器形状见 [module.schema.json](module.schema.json)、[pack.schema.json](pack.schema.json) 和 [pack-lock.schema.json](pack-lock.schema.json)，采用 JSON Schema 2020-12。参考 Runtime 的手工校验实现是它的 v1 支持范围的权威实现：Schema 之外还必须检查路径、实际文件集合、大小限额、标识重复、交叉引用、依赖环、契约绑定及解释器环境。只通过 Schema 不足以导入或启动。

v1 对象采用封闭字段，未知字段拒绝；程序自己的 `settings` 是开放 JSON 对象。版本使用 `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$` 的精确版本语法，不支持 `+build` 或版本范围，不隐式推导兼容性。这是此部署 profile 的简化语法，不是通用 SemVer 校验器。module ID、pack ID、组件 ID、桥槽及主题别名采用 `^[a-z0-9][a-z0-9._-]{0,63}$`。能力契约 ID 是程序间开放声明，不是 Hub 内置信息类别。

模块与组件各为 1–32 个，主题表为 1–64 项，单模块桥槽为 1–8 个，单个 provides／requires 为 0–32 个。启动、健康和停止期限各为 100–60000 毫秒。有限规模是参考部署工具的保护范围，不是 Hub 全局模块数或信息种类的上限。

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

权限对象的 v1 支持值为 `filesystem:"instance-state"`、`processes:"none"`、`network` 中 1–2 个唯一的 `hub-loopback`／`loopback-listen`。未知声明明确拒绝，不能悄悄当作获得授权。`loopback-listen` 允许模块声明一个本机服务入口；`instance-state` 表达程序将数据写到指定目录的意图。参考实现没有文件系统、网络或进程沙箱，不能防止受信任运行的代码越过这些意图。详见[执行与隔离边界](runtime.md#执行与隔离边界)。

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

主体现有权限仍由 Hub 校验。通道须由模块自己的 mod 握手后声明／订阅；Runtime 不代替模块在 Hub 中注册业务通道，也不把 pack 主题表加入 Hub 的业务类别。程序主动新增的信息种类仍由其桥和双方的应用契约安排。

当前部署模型每组件分配一个 principal／credential，多桥使用同一主体，并按桥槽分配独立 bridgeId 和连接额度。组件中各桥声明的 ACL 汇总为该主体的通讯授权上限；它不是同一主体内部每座桥之间的安全隔离。需要互不信任的桥身份时，应使用不同组件／主体，或扩展外部部署工具。Hub 本身的 N:M 注记与多身份接入能力不因此改变。

`after` 是部署启动依赖，必须引用已有组件并构成无环图。它表示前置组件达到本次启动条件后再启动当前组件；不会使 Hub 执行业务工作流，也不保证前置程序永远健康。`bindings` 表明 `from` 提供与 `to` 需要的精确契约均存在；每个 required 契约必须具备绑定。Runtime 只校验声明，程序仍负责授权、请求、语义和结果验证。它不会依据能力 ID 自动选择提供者，不重写载荷，也不猜测可替换算法。

`entry.component` 选择整合包入口程序。入口 URL 由该程序启动后提供；参考 Runtime 只接受其声明过的 loopback HTTP 服务地址。URL 可用不证明完整业务成功。`settings` 是程序自己的公开配置，Runtime 不解释其业务含义。不要把密码、API key 或私人正文放入可分享的 settings；导出会保留 pack 配置。

## pack.lock：完整源码和环境版本

```json
{
  "format": "world-hub.pack-lock/v1",
  "pack": {
    "id": "demo.polyglot", "version": "1.0.0",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "hubVersion": "0.15.0",
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

`hubVersion`、解释器版本及 Python 库版本固定当前运行环境的兼容选择。Python `packages` 是最多 32 项的预安装分发包名到精确版本的映射；锁定工具默认检查 `websockets:15.0.1`，另一个 Python 程序可以显式选择自己的依赖集合。这不是允许自动运行依赖安装脚本。版本相同不能证明解释器或已安装第三方库的二进制字节相同；这份 v1 锁没有下载这些制品，也没有给它们提供签名或二进制哈希。锁校验不是来源认证、安全证明、OS 隔离或所有业务行为可复现的保证。

变更模块源码、pack 接线、权限或环境选择后，应使用显式锁定工具重新生成锁并审阅。导入／启动不得因不匹配自动更新锁。另一平台或解释器版本需要明确重新锁定；不静默忽略平台信息。

## 标识、状态与留存

module ID 和版本属于可分发程序；component ID 属于部署组合；桥槽是本地接线名；principal／credential／bridgeId 是当前通讯身份配置；session 是 Hub 握手分配的当前连接地址。实例 ID 隔离整合包状态，不能代替认证身份。程序不能以业务正文中的这些字符串替代可信通讯信封。

锁定包与实例可写状态分开保存。每实例独立配置、游标、成果、Hub 日志／附件、凭据和监听端口；停止后保留实例数据，重新启动使用同一实例状态。复制包不会隐式复制用户成果或未消费通信记录。

Runtime 停止程序、探测健康失败、本地等待超时、SDK ACK、目录租约过期都不释放信息，也不证明请求未执行。提供者决定何时经自己的 mod `release`；恢复和幂等由外部程序自行安排。部署工具不自动重放未知业务结果的请求。

继续阅读：[Runtime CLI、生命周期与控制接口](runtime.md)、[独立能力提供者契约](../modules/provider-contract.md)、[Hub 边界](../specs/boundaries.md)。
