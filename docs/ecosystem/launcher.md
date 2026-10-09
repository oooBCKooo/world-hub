# World Hub 统一入口与可选 Launcher

可选 Launcher 为本地整合包提供统一浏览器入口。后台调用已有的[参考 Runtime](runtime.md)，页面保留进入 Hub 拓扑管理和通信工作台的入口。Hub Core 仍负责通信，Runtime 仍负责所属进程、实例与日志，Launcher 负责用户审阅和导航。安装 Launcher 不要求修改模块的桥协议，也不把 Runtime 加载到 Hub Core 内。

原来的 `world-hub --open`、`npm start`、`world-hub-pack` 和无界面 Runtime API 继续可用。Launcher 是可选入口，Workshop 不是本地启动的依赖。

## 打开整合包管理

```powershell
world-hub ui --open --root F:\hub-instances
```

源码运行方式：

```powershell
node bin/world-hub.mjs ui --open --root F:\hub-instances
```

可以用 `--port 0` 让系统分配端口，并用 `--node <executable>`、`--python <executable>` 选择已经安装的解释器。后台仅绑定 `127.0.0.1`；使用后台输出的本次浏览器地址完成 UI 会话建立。实例 root 是后台启动配置，页面中的单次操作只选择该 root 下的实例 ID。

Launcher 默认展示整合包管理。Hub 管理与通信工作台仍使用现有页面；没有整合包时也可按需打开独立的 Hub 管理入口。Runtime 管理的每个实例拥有自己的 Hub、状态目录、凭据和端口，独立 Hub 入口不被推断为某个整合包实例。

## 首次运行闭环

1. 选择含 `pack.json`、`pack.lock` 和锁定模块的本地整合包目录，选择所用 Node／Python 解释器。
2. 检查清单、平台、模块契约、源码摘要、解释器和锁定依赖。页面显示模块来源、执行入口、依赖顺序、环境及完整权限声明。
3. 创建一个新的实例 ID。导入只复制已校验的 package，不启动模块、不安装依赖，也不覆盖已有实例。
4. 审阅实例当前内容，明确接受执行当前代码与声明权限，再启动。用户不需要手工复制 `review.digest`。
5. 等待启动操作结束，分别观察进程、桥连接、模块准备声明和健康检查。具有合规本机 HTTP 入口的整合包可以打开应用；实际业务结果由应用验证。
6. 查看实例或单个组件日志，打开对应 Hub 通信拓扑；在 Hub 选择实际连接后，可以返回 Launcher 核对归属并查看日志。
7. 停止实例，等待实际退出确认。重新启动仍需检查当前内容并明确接受执行。可以创建第二实例，也可将锁定 package 导出到新目录。

启动和停止是后台异步操作。接受操作不代表模块已运行，也不代表进程已退出；页面须观察操作结果与本次 Runtime 状态。清理未确认时保留错误信息和再次停止的入口，不依据保存的 PID 盲杀进程。

关闭浏览器标签页不等于停止实例。结束后台时在启动它的终端使用 Ctrl+C，并等待 `launcher-stopped`。后台清理本次自己监督的进程；启动失败但清理未确认时也保留真实所属 Runtime 的清理句柄，允许再次停止。无法确认退出时报告错误并保留服务与所有权，不宣称停机完成。

## 环境检测与修复

检查使用宿主的平台／架构和 pack.lock 的要求，核对已选择解释器的真实路径、版本、二进制 SHA-256 及预安装依赖版本。Node 默认使用运行工具的 Node；Python 依照 Runtime 的默认查找规则或用户明确选择的路径解析。

**检查会执行所选解释器的固定版本和依赖探针。** 探针不执行包入口或安装脚本。解释器本身必须受信任；检查不是完全不执行程序的文件扫描。

缺少解释器、依赖或版本不匹配时，检查失败并阻止启动。用户可以选择已经安装且满足锁定要求的解释器，按诊断信息在自己的环境中准备依赖，然后重新检查。Launcher 不自动下载解释器，不自动运行 `npm install`、`pip install` 或第三方 shell 脚本。

锁定要求不符合新宿主时，由包作者通过 `world-hub-pack lock` 明确重建并验收 package。重新锁定改变审阅对象；Launcher 不在检查、导入或启动中静默修改锁文件。

## 对当前审阅内容授权

后台保存一次审阅的标识、对象范围、内容摘要和解释器选择。启动请求需要引用当前实例的审阅并明确表示接受执行；浏览器提交一个摘要或沿用旧的同意记录不能绕过审阅。后台启动前再次检查当前文件和环境，Runtime 再次核对同一个摘要。

代码、清单、锁、入口、权限、依赖、接线或解释器变化都会使旧审阅失效。权限是此次完整审阅的一部分，变化后须重新展示并接受。审阅标识不等于社区登录状态，也不是通用执行令牌。

参考 Runtime 的实例记录绑定导入时的摘要。已导入实例的源码或解释器选择变化后，不能自动覆盖 `instance.json` 的摘要来继续运行；应检查新的 package／环境并导入新实例。已有可写数据不会因此自动迁移。

## 状态及归属证据

| 维度 | 证据与含义 |
| --- | --- |
| 进程 | Runtime 本次创建的所属进程启动、退出或清理状态 |
| 通信 | 当前 Hub 快照中的真实桥连接；读取失败或过期时为未知 |
| 模块准备 | 本次进程输出的 `module-ready` 自报声明 |
| 健康 | 对特定本次探针 ID 的模块回应与检查时间 |
| 业务就绪／结果 | Launcher 不代替业务协议验证；桥连接和健康回应不证明业务执行成功 |
| 停止确认 | 同一 runId 有 `stoppedAt` 且没有 `cleanupIncomplete` 才确认所属进程均已退出 |

`running` 是部署状态。桥已连接而模块未准备时，页面分别显示这两个观察。旧的模块准备记录、过期快照或不可联系的监督者都不能证明当前在线。`failed`、停止请求被接受或 `closed` Promise 完成都不能单独证明停止。

归属关联包含实例 ID、本次 runId、component ID、分发 Module ID、PID、Runtime 配置的 principal、声明桥 ID，以及 Hub 实际 bridgeId 和 session。PID 是诊断信息；component ID 与 Module ID 不互相替代。一个组件可有多个桥槽，一个分发模块也可在不同实例中运行。

Launcher 将当前 Hub 的实际连接与本次 Runtime 的 principal 和声明桥 ID 一起核对。名称、端口、主题、程序注记或载荷自报身份均不构成归属证据。未匹配的连接显示“外部接入／运行状态未知”；不能从一个外部桥推断进程、模块健康或业务就绪。

## Hub 双向导航

Launcher 生成的 Hub 管理链接携带无权限的定位片段：Launcher 本机入口、instanceId、runId、当前 hubOrigin，以及可选的 principal 或实际 bridgeId／session。Hub 页面只在此上下文有效时显示整合包导航；普通 Hub 管理页面的行为保持不变。独立 Hub 使用不含实例或运行标识的单独导航上下文，返回 Launcher 的枢纽列表，不据此建立整合包归属。

Hub 管理在同一标签页往返，以保留当前 origin 的 UI 会话。通信工作台链接可以直接打开已有工作台对话框，只读取本机通讯配置；仍须用户自行连接桥和发送消息，不自动代为执行通信操作。整合包应用则在独立标签页打开，不获得管理页面的窗口引用。

从 Hub 返回时，链接携带实际选中连接的 bridgeId 和 session，并保留实例、本次运行及 Hub 地址。Launcher 再与当前拓扑核对完整关联后选择组件日志。URL 只是提示，不能授权启停或证明归属；不携带 UI、Runtime 控制或桥 token。过期 runId、已重连 session、其他 Hub 或未匹配外部连接须明确显示过期／未知，不能默默归入新运行。

Hub 程序注记仍用于人工阅读。导航模块不根据这些注记建立进程归属，不改变 ACL、消息、订阅、管理断开或暂停的语义。断开桥仍是通信操作，停止 Runtime 进程仍由 Launcher／Runtime 完成。

## 本机 API 与浏览器边界

Launcher 使用独立的 UI 会话 bearer 和 CSRF token。启动地址片段中的一次性 code 由 `POST /api/session` 交换，页面随后移除该片段；UI 凭据只保存在当前浏览器 origin 的 sessionStorage 中。原生集成使用服务创建时单独返回的 bearer，页面不会得到该凭据。Runtime 私有控制 token 与桥 token 留在可信后台和实例目录中，不注入页面。

| 接口 | 内容 |
| --- | --- |
| `POST /api/session` | `{code}` 交换一次性启动授权；要求当前 Origin；返回 UI bearer、CSRF token 与本次服务上下文 |
| `GET /api/session` | 已认证的服务上下文；不会重新发放启动 code |
| `POST /api/environment` | `{nodePath?,pythonPath?}` 检测已安装环境，返回诊断与手动修复指引 |
| `POST /api/review` | `{directory,nodePath?,pythonPath?}` 检查来源；返回后台 `reviewId`、完整 `review` 与权限差异 |
| `GET /api/instances`、`POST /api/instances` | 列出跟踪实例；用 `{reviewId,instanceId}` 导入新实例 |
| `GET /api/instances/:id` | 实例、本次状态、入口、Hub 导航与进行中的操作 |
| `POST /api/instances/:id/review` | `{nodePath?,pythonPath?}` 检查该实例 package；不能使用另一个实例的审阅授权 |
| `POST /api/instances/:id/start`、`restart` | `{reviewId,accepted:true}` 重查当前内容并开始异步启停操作 |
| `POST /api/instances/:id/stop` | `{}` 请求异步停止；仍须等待本次退出确认 |
| `GET /api/instances/:id/logs` | 当前或已结束运行的有界 Runtime 日志 |
| `GET /api/instances/:id/topology?runId=...` | 当前 Hub 的桥与本次运行映射；不同运行的定位提示明确失败 |
| `POST /api/instances/:id/export` | `{destination}` 异步导出到新目录 |
| `GET /api/hubs` | 独立 Hub 与实例 Hub 的入口及状态 |
| `POST /api/hubs/default/start`、`stop` | `{}` 管理 Launcher 自己创建的独立 Hub |
| `GET /api/operations/:id` | 操作的 `running`／`succeeded`／`failed` 状态和结果或错误 |

异步管理请求返回 HTTP 202 与 `operationId`；它只说明操作已接受。成功响应以 `ok:true` 包装结果，失败以 `ok:false,error:{code,message}` 给出诊断。除启动 code 交换外，API 要求 `Authorization: Bearer <token>`；写操作再带 `X-CSRF-Token` 和 JSON body。不存在通用 shell 执行、任意路径进程终止或任意 Hub URL 转发接口。

直接使用 Runtime JavaScript API 的集成还须处理启动拒绝后的清理：创建了本次监督者的启动错误可带不可枚举的 `error.runtimeSession`，提供 `status()`、`close()` 和 `closed`。它保存真实所属运行的闭包，不是按 PID 重新发现的进程授权。若退出未确认，保存该句柄并明确重试 `close()`；检查本次调用返回的 `stoppedAt`／`cleanupIncomplete`。早先已经完成的 `closed` Promise 不代表之后重试的最新状态。检查、trust 或实例所有权获取前的拒绝不会提供这个句柄。

API 检查本机回环连接、与监听端口完全一致的 Host、存在时必须匹配当前界面的 Origin，以及跨站 Fetch Metadata。管理写操作还需要本次 CSRF token 与 JSON 请求。服务不开放 CORS，不代理任意用户 URL，也不把控制 secret 转发到页面提供的地址。

页面采用同源资源策略，第三方应用在独立入口打开，不被嵌入为有管理权限的页面。模块描述、诊断、日志和外部内容作为文本显示，不执行载荷 HTML。跨站页面不能凭本机端口存在或社区登录状态调用本机管理操作。

这些措施保护浏览器管理边界。与 Launcher 同一账户下运行的恶意本地代码、用户主动选择的恶意解释器，以及拥有当前 UI origin 权限的代码不处于这个隔离边界之外。

## 导出与本期范围

导出只复制锁定 package，不包含实例成果、游标、Hub 留存、运行日志或 Runtime 生成的凭据。pack 的公开 settings 会复制，不能在其中放个人秘密。导出目标须是尚不存在的新目录；另一宿主须重新检查并满足锁定环境。

**权限声明不等于 OS 强制隔离。** 本期没有 OS 沙箱、容器、后代进程约束、资源强制限额或同账户文件访问隔离。Runtime 的路径检查、有限子进程环境、逻辑实例隔离、独立通信 ACL 和有界日志均保留各自实际边界。Windows 文件 mode 也不代替用户配置的目录 ACL。

本期完成本地 P0 入口：检查、导入、明确审阅、启停、环境诊断、状态与日志、Hub 联动和 package 导出。自动环境安装、实例备份／恢复／迁移、数据更新、可视化整合包编辑属于后续 P1；Workshop、第三方分发源与社区账户属于后续 P2。现有导出不应被称作实例备份，当前信任确认也不应被称作代码安全证明。

继续阅读：[Runtime 公共 API 与边界](runtime.md)、[开放 Pack 声明](pack-spec.md)、[现有 Hub 管理](../specs/management.md)、[Hub 边界](../specs/boundaries.md)。
