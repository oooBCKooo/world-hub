# 可选外部整合包 Runtime v1

参考 Runtime 是独立部署工具，负责本地整合包检查、实例目录、进程启停和日志。它与 Hub 的通讯内核分离，使用[开放整合包声明](pack-spec.md)。Hub 不加载 Runtime、不读取 module／pack、不执行外部程序。其他 Launcher 或 Runtime 可以实现同样声明，也可以直接按现有桥协议连接 Hub。

参考 profile 支持 Node／Python 普通前台程序、每实例独立 Hub 和显式本地目录来源。独立 Launcher 另提供经审阅的有限依赖准备、私人备份与创作／分发工具；这些工具不成为 Hub 的运行条件。默认 trusted-local profile 没有 OS 沙箱、共享 Hub、资源强制限额或自动业务恢复。可选 Node 容器隔离与作者明确的数据迁移事务分别见下文。语言、入口和生命周期限制只约束选择此工具的部署包。

## 检查、导入与启动

CLI 入口为 `world-hub-pack`，源码调用为 `node bin/world-hub-pack.mjs`。CLI 使用同一个 Runtime 实现；图形 Launcher 不需要重实现桥协议或业务程序。

```powershell
$review = world-hub-pack plan F:\packs\text-desk --node D:\nodejs\node.exe --python C:\Python\python.exe | ConvertFrom-Json
world-hub-pack import F:\packs\text-desk --root F:\hub-instances --instance desk-one --node D:\nodejs\node.exe --python C:\Python\python.exe
world-hub-pack start --root F:\hub-instances --instance desk-one --trust $review.digest --node D:\nodejs\node.exe --python C:\Python\python.exe
```

`plan` 读取 pack、锁、module 及完整源文件，检查平台、契约绑定、部署依赖、来源路径与内容，并返回权限声明和 review digest。摘要包括 pack／锁／完整模块文件字节、权限、环境探针结果，以及所选解释器解析后的真实路径与二进制 SHA-256。`import` 完成同样验证后将锁定包复制到新实例目录，拒绝覆盖已有实例。导入不启动模块或安装依赖。`start` 在前台监督进程；`--trust` 必须准确匹配当前已审阅的摘要，所有内容和运行环境在启动前再次校验。修改接线、源码、权限或所选解释器后需要重新审阅。

检查为了核对宿主依赖，会启动用户选择的解释器，执行固定的版本和依赖探针；这是受信任解释器的运行，不是“完全不执行任何程序”。探针不运行包入口、不读取安装脚本、不自动修复环境。Python 依赖应在用户管理的环境中先准备好。检查失败提供具体环境或锁不匹配原因，不能把缺依赖误报成模块业务失败。

作者在修改源码或明确选择另一个环境后，使用 `world-hub-pack lock <pack-directory> --node <node-executable> --python <python-executable>` 显式重建 `pack.lock`。这个动作改变后续审阅摘要，不能替代用户检查新内容；不在 import／start 中自动执行。

启动顺序为：校验与 trust 核对 → 获取实例排他所有权 → 准备私有本次运行配置和独立 Hub → 按部署 DAG 启动模块 → 验证启动条件 → 提供入口。启动阶段失败时，监督者停止本次已经启动的所属进程并记录失败；不遗留半套组合。

## 实例与管理命令

```powershell
world-hub-pack status --root F:\hub-instances --instance desk-one
world-hub-pack logs --root F:\hub-instances --instance desk-one
world-hub-pack stop --root F:\hub-instances --instance desk-one
world-hub-pack export --root F:\hub-instances --instance desk-one --destination F:\shared\text-desk-copy
```

同一 root 可具有多个实例，每实例有独立锁定包、可写组件状态、本次运行目录、Hub 存储、凭据与端口。实例同时启动受到排他保护；不共享模块的游标文件。同一实例重新启动保持组件自己的状态，但重建本次通信凭据和健康观察，不能从旧 ready 记录推断在线。

停止命令联系该实例的监督者，按依赖逆序请求模块停止，最后停止 Hub。只有等待实际进程退出后才记录 stopped；超时强制停止应清楚显示。Ctrl+C 也进入同一停止流程。状态文件中的 PID 只供诊断，不能作为杀进程的授权依据；监督者掌握本次创建的子进程对象。

`export` 复制锁定 package 到一个尚不存在的目录；不复制实例成果、游标、Hub 留存、运行日志或 Runtime 生成的凭据。pack 的公开 settings 仍会复制，用户不要将秘密写入这些文件。另一个部署 root 可以重新 plan／import／start，宿主仍需符合锁中的平台和预安装依赖版本。

Runtime 逐级校验并规范化本地路径，支持 Windows 的合法 8.3 短名称。现存祖先中的符号链接和 junction 仍被拒绝；尚不存在的实例或导出目录从已校验的规范父目录创建。

## 模块启动配置

Runtime 用受控解释器和字面参数启动模块入口：

```text
<node-or-python> <absolute-entry> --runtime-config <private-config-file>
```

不通过 shell 解释命令。模块工作目录是其独立组件 state 目录；代码从校验过的锁定 package 读取。子进程环境使用系统运行必要变量的有限集合和固定 Python UTF-8 设置，不继承所有父进程秘密变量。

Windows 下较长的子进程工作目录使用原生 `\\?\` 路径表示，仍指向同一实例／组件目录。程序读取的 cwd 文本可能带此前缀或呈现 Windows 8.3 短名称；不要用字符串全等代替物理路径核对。模块仍自行负责其依赖工具的路径兼容性。

长路径 Python 入口使用固定启动适配，按源码编码读取同一已审阅脚本，在持久的 `__main__` 模块中执行，保留参数、组件工作目录和脚本的本地依赖目录。组件 state 不会成为额外的导入目录，入口返回后的服务线程仍可读取主模块。这是可选 Runtime 的 Windows 启动适配；直接通过桥接入的外部程序不依赖此启动器。

Windows Node 参考 profile 中，Node 模块的 `package.json` 规范化完整路径须少于 248 字符；较长路径下原生包解析可能跳过它并误用外部包作用域。检查、复制及导入会提前拒绝这类路径，请使用较短的源目录／实例 root。没有 Node 包元数据的长目录、原生子进程 cwd 与长路径 Python 入口分别验证；此限制不属于 Hub 通讯协议。

私有配置形状如下。实际路径、token 和 URL 来自当前部署；公开 pack 不携带这些秘密。

```json
{
  "format": "world-hub.run/v1",
  "instanceId": "desk-one",
  "componentId": "source",
  "module": { "id": "demo.source", "version": "1.0.0" },
  "stateDir": "<private-component-state-directory>",
  "settings": { "text": "Hello 世界 🌍\n" },
  "topics": { "source": "custom/text/read", "stats": "custom/text/statistics" },
  "peers": {
    "source": { "principal": "<source-principal>" },
    "stats": { "principal": "<stats-principal>" },
    "desk": { "principal": "<desk-principal>" }
  },
  "bridges": [
    {
      "slot": "main",
      "endpoint": "ws://127.0.0.1:12345/bridge",
      "bridgeId": "<this-bridge-id>",
      "credential": "<source-credential-id>",
      "principal": "<source-principal>",
      "token": "<private-random-token>",
      "publish": ["custom/text/read"],
      "subscribe": ["custom/text/read"]
    }
  ]
}
```

一个模块收到自己的 bridge token，不收到其他组件的秘密凭据或 Runtime 控制 token。`peers` 是部署交付的对方稳定 principal 地址；业务程序仍须从真实 welcome 和可信 delivery 核对身份，不采用载荷自报身份。每座桥必须自行 connect、核对 welcome、registerChannels、subscribe，并 await Hub 建立回执后才宣告自己的应用准备完成。

多个桥槽对应同一程序中的多个 mod。Reference profile 给组件共享主体；ACL 为该主体全部槽的权限并集。桥槽名不规定来源程序、目标程序或业务信息种类。模块没有义务把通信角色转成不同可执行程序。

## 模块生命周期适配

以下 NDJSON 使用模块的 stdin／stdout，是外部部署生命周期接口，不是 Hub 线协议。模块 stdout 每行输出一个 JSON 事件；普通 stderr 用于有界诊断。程序可以在其他 Runtime 中采用不同适配层，不影响 Hub 接入。

| 方向 | 帧 | 意义 |
| --- | --- | --- |
| 模块 → stdout | `{"event":"module-ready"}` | 模块自报本次应用启动准备完成 |
| 模块 → stdout | `{"event":"module-ready","entryUrl":"http://127.0.0.1:12346/"}` | 声明了 loopback-listen 的入口模块给出本机服务地址 |
| Runtime → stdin | `{"command":"health","id":"<probe-id>"}` | 发起有限期限的本次健康探针 |
| 模块 → stdout | `{"event":"module-health","id":"<same-probe-id>","ready":true}` | 当前探针的模块自报健康；必须匹配 id |
| Runtime → stdin | `{"command":"stop"}` | 请求合作停止、关闭桥／服务并退出 |

模块须处理 stdin EOF，避免监督者退出后继续运行。健康帧 `ready:false`、对应探针逾期、启动逾期或进程退出由监督者记录为故障，并停止剩余所属程序。有限强制停止属于生命周期管理，不等于取消已送入 Hub 的业务。此 profile 要求模块不创建后代进程，但没有 OS 强制进程沙箱；不把声明当成隔离保证。

监督者日志有行长和总量上限，并对自己生成的已知 secret 做脱敏。脱敏不能保证去除业务程序自行产生的所有敏感内容；模块作者应避免输出凭据。日志洪泛及非法生命周期输出应得到有限错误和可靠清理，不能无限增长 Runtime 内存。

## 分别观察状态

| 观察 | 能证明的范围 |
| --- | --- |
| 进程启动／退出 | 所属进程正在运行或已经退出 |
| Hub 通讯连接快照 | 对应桥当前确有 Hub 接纳的通信连接 |
| `module-ready` | 模块声明自己已准备接受工作 |
| 健康探针回应 | 模块对特定本次探针声明健康 |
| 实际业务回应 | 应用契约下本次请求的结果，须由调用程序验证 |
| 成果持久提交 | 成果程序按其业务协议完成提交，仍不同于 Hub ACK |

Reference Runtime 的 overall ready 是部署条件，不是业务成果证明。通讯连接、模块健康和应用业务均可能在快照之后变化。只有真实跨语言调用及结果校验才能形成演示的业务验收证据。

## 公共 CLI、JavaScript API 与控制接口

这些接口是外部部署工具的公开契约，不向 Hub 线协议增加命令。第三方 Launcher 可以调用 CLI、`world-hub/runtime` 或本机监督者控制接口；替换界面不要求改变 Hub 或模块源码。

| CLI | 操作与结果 |
| --- | --- |
| `plan <pack-directory> [--node executable] [--python executable]` | 返回审阅 plan，包括 `digest` 和声明权限；不写包或启动模块 |
| `lock <pack-directory> [--node executable] [--python executable]` | 作者显式写 `pack.lock`，返回 lock |
| `import <pack-directory> --root directory --instance id [--node executable] [--python executable]` | 创建新实例，返回 `instanceId`、`stateDir`、`digest`、`plan` |
| `start --root directory --instance id --trust digest [--node executable] [--python executable]` | 前台启动；stdout 输出 `pack-ready` 后继续监督，停止时输出 `pack-stopped` |
| `status --root directory --instance id` | 返回当前或明确标为过时的 runtime-status |
| `logs --root directory --instance id` | 返回有界 runtime-logs；已结束运行可以读保存日志 |
| `stop --root directory --instance id` | 请求所属监督者停止，等待实际终态；不按文件中 PID 杀进程 |
| `export --root directory --instance id --destination new-directory [--node executable] [--python executable]` | 导出 package，返回 `destination`、`digest`、`includesRuntimeState:false` |

未知命令、未知或重复参数、缺值明确失败。CLI 失败为非零 exit code，stderr 输出 `{"ok":false,"error":{"code":"PACK_RUNTIME_ERROR","message":"..."}}`；message 用于诊断，不应被当作稳定机器枚举。成功输出对象本身，不统一包裹 `ok:true`。`start` 具有多行生命周期输出，其他命令通常返回一行 JSON。第三方客户端应接受以后新增的诊断字段，并分别判断部署、通讯和业务状态。

Node 默认使用调用此工具的 Node 可执行文件；Python 默认在 PATH 查找 Windows 的 `python.exe` 或其他平台的 `python3`。为可审阅的部署，建议显式指定解释器。原生解释器 probe 的真实 executable 必须与所选路径一致；不支持隐藏另一解释器路径的 wrapper。

JavaScript 的稳定入口如下；不依赖内部实现文件路径：

```js
import {
  inspectPackage, createLock, importPackage, startInstance,
  statusInstance, logsInstance, stopInstance, exportInstance,
} from 'world-hub/runtime';

const environment = { nodePath: process.execPath, pythonPath: '/absolute/path/to/python' };
const review = await inspectPackage('/absolute/path/to/pack', environment);
// Launcher 此时展示代码来源、review.permissions 与环境，收集用户对 digest 的信任。
const imported = await importPackage('/absolute/path/to/pack', {
  root: '/absolute/path/to/instances-root', instanceId: 'desk-one', ...environment,
});
const session = await startInstance({
  root: '/absolute/path/to/instances-root', instanceId: imported.instanceId,
  trust: review.digest, ...environment,
});
console.log(session.ready);
console.log(await session.status());
await session.close();
console.log(await session.closed);
```

这个示例假定 Launcher 已获得用户对显示摘要的信任，再将 digest 交给 start；`inspectPackage()` 并没有替用户接受代码。方法失败通过 Promise 拒绝／Error.message 交付；调用方须 catch。

| API | 参数与稳定结果 |
| --- | --- |
| `inspectPackage(packDirectory, {nodePath?,pythonPath?})` | plan：`format:"world-hub.review/v1"`、`digest`、`directory`、`pack`、`lock`、`modules`、`order`、`environment`、`startsModules:false`、`sandbox:false`、`permissions` |
| `createLock(packDirectory, {nodePath?,pythonPath?,moduleSources?,pythonPackages?,write?})` | 默认扫描 `modules` 直接子目录并写锁；`write:false` 仅返回 lock；`pythonPackages` 指定待核对的预安装包版本，默认 `websockets:15.0.1` |
| `importPackage(packDirectory, {root,instanceId,nodePath?,pythonPath?})` | 新实例 `{instanceId,stateDir,digest,plan}`；不覆盖已有实例 |
| `startInstance({root,instanceId,trust,nodePath?,pythonPath?,signal?})` | session：`ready`、`status()`、`close()`、`closed` Promise；`signal` 是可选 AbortSignal，可停止启动等待；重复 close 复用当前停止过程，清理未确认可再次请求；closed 返回停止尝试的状态，仍须核对 stoppedAt／cleanupIncomplete |
| `statusInstance({root,instanceId})` | runtime-status；监督者不可联系时返回 `observation:"stale"`、`supervisorUnavailable:true`、`controlError`，不是在线证明 |
| `logsInstance({root,instanceId})` | runtime-logs：`format:"world-hub.runtime-logs/v1"`、`instanceId`、`logs`；每个组件及 `$hub` 含 `pid`、`stdout`、`stderr`、`truncated` |
| `stopInstance({root,instanceId})` | 请求停止并返回确认过的终态；完成 deadline 有限 |
| `exportInstance({root,instanceId,destination,nodePath?,pythonPath?})` | `{destination,digest,includesRuntimeState:false}`；目标必须尚不存在 |

`modules` 的条目为 `{manifest,source,files}`；`environment` 的 Node／Python条目含 `executable`、`version`、`packages`、`sha256`。`permissions` 条目包含 module ID、`declared` 和 `enforced:false`。review digest 绑定当前环境与内容，不绑定导入目录，因此完整复制后可以保持同一审阅摘要。

`pack-ready` 含 `instanceId`、`entryUrl`（没有 HTTP 入口可为 null）、`hubUrl`、`hubEndpoint`、`controlUrl`、`stateDir`、`pids`。runtime-status 的 format 为 `world-hub.runtime-status/v1`，`state` 为 `starting`／`running`／`stopping`／`stopped`／`failed`，并包含本次 runId、reviewDigest、components 与 hub。每组件分别报告 process、communication、readiness、health、预期桥及实际桥连接／session。实际桥项区分 `declaredId`（模块声明的桥名）与 Hub 快照的 `bridgeId`。`failure` 包含诊断 code／message。`stoppedAt` 用于确认本次所属进程已经实际退出，不能由旧状态推断新运行已停止。没有 stoppedAt 且 `cleanupIncomplete:true` 表示清理未能确认，不能显示为已停止。Launcher 不能只根据 `pack-stopped` 事件名、failed 状态或 closed Promise 完成就判定所有进程已退出。

### 私有 HTTP 控制协议

监督者绑定 `127.0.0.1` 的随机端口。实例 `control.json` 的形状是 `{format:"world-hub.runtime-control/v1",runId,url,token}`；该文件是私人管理凭据，不能导出或交给模块。第三方 Launcher 的可信本机后台读取这个文件，以 `Authorization: Bearer <token>` 请求；不要将控制 token 注入浏览器页面。

请求必须使用与 URL 对应的 `Host: 127.0.0.1:<port>`，不得带 Origin。此接口拒绝跨站浏览器调用，不提供 CORS。客户端禁止重定向，只访问已验证的 loopback HTTP 根地址；不要把用户提供的任意 URL 和控制 secret 组合发送。

| 请求 | 成功响应 |
| --- | --- |
| `GET /status` | 200，当前 runtime-status 对象本身 |
| `GET /logs` | 200，当前 runtime-logs 对象本身 |
| `POST /stop` | 202，`{"ok":true,"accepted":true,"state":"stopping"}`，启动停止过程 |

认证／Host／Origin 检查失败返回 401 `{"ok":false,"error":{"code":"UNAUTHORIZED","message":"..."}}`。未知路径或不支持的方法返回 404，code 为 `NOT_FOUND`；每个响应采用 JSON 并禁止缓存。POST stop 的 accepted 不代表进程已退出。监督者完成后会关闭控制服务，CLI 从该实例的持久状态确认同一 runId 的终态和 stoppedAt。

启动前就创建本次 starting 状态与控制服务，`POST /stop` 在启动过程中同样可取消后续启动并清理当前所属进程。控制客户端核对 control.runId 与当前状态，拒绝旧运行的控制记录。清理无法确认时保留控制通路与排他所有权，可再次明确请求停止；实际安全恢复边界仍见状态诊断。

控制记录失效、监督者不可用或进程清理未能确认时，应报告停止状态未知／失败，不能通过旧 PID 盲杀系统进程。管理客户端还须按自己的运行账户保护实例 root；同账户可执行代码能够读取这些目录，不处于本工具的安全隔离之外。

## 执行与隔离边界

执行本地模块前需显式信任 review digest。这个确认说明用户接受当前代码、接线、解释器选择和权限声明；它不将代码变安全。Runtime 验证哈希和完整源树，拒绝路径逃逸／链接／未知配置，生成独立通讯身份，限制控制服务为本机，并限制日志。这些是工具实际实施的管理边界。

`permissions` 是声明，目录与 ACL 是逻辑隔离。默认 trusted-local 没有 OS 沙箱，不强制阻断外部文件、网络、后代进程、CPU 或内存访问。不要把不受信任代码直接放入可信实例；需要这种隔离时应使用容器、独立账户或其他受控执行环境，并在其自身权限模型中验收。

工具创建文件／目录时请求 `0600`／`0700` 权限；这是适用于支持该权限模型的平台的管理措施，Windows 的 mode 参数不能保证等价的访问控制列表隔离。Windows 使用者须通过自己的账户和目录 ACL 保护实例 root。相同账户下运行的本地代码可能读取其他实例的私有配置、控制凭据及状态；参考实现不声称阻止这种访问。

Hub ACL 只授予通信范围；能力契约的 permissions 只声明业务要求；Runtime permissions 只声明运行意图。它们均不互相代授权限。解释器／库版本相同也不等于二进制 hash 相同，锁不能证明宿主环境完全可复现。

## 故障、留存和升级范围

Runtime 不自动重试业务、重放未确认请求、release 消息或回滚应用数据。程序停止、本地等待超时和探针失败不证明请求未执行；SDK ACK 不代表成果完成，更不释放提供者信息。程序自主管理幂等、恢复、迟到结果和释放。

更新可以显式检查新 package 并导入新实例，或者对已停止实例使用[审阅升级与完整数据回滚](upgrade.md)。所有数据兼容或转换策略由程序作者提供。创作工具可校验旧源锁后复制到新目录并明确重建当前环境的锁；它不会替旧运行授权。私人备份与恢复另有停止一致性和精确版本约束，不解释程序的数据格式。源码版本回退不保证业务数据回退；导出 package 也不是数据备份。离线运行仍需本地环境满足锁定依赖，Workshop 或其他线上社区不是启动依赖。

实例维护接口与 CLI 见[私人备份、恢复及存储](maintenance.md)，新目录派生、旧锁重建、评论与协作 API 见[创作工具](authoring.md)，可替换分发来源见[开放软件源](sources.md)。这些接口也由 `world-hub/runtime` 导出。

继续阅读：[pack 声明与源码锁](pack-spec.md)、[Python 桥](../../sdk/python/README.md)、[JavaScript 桥](../../sdk/javascript/README.md)、[Hub 边界](../specs/boundaries.md)。

扩展工具：[参数化模板](templates.md)、[审阅升级与数据回滚](upgrade.md)、[可选 Node 容器隔离](isolation.md)。均不改变 Hub Core，也不自动赋予业务代码信任。
