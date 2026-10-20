> 当前产品入口为单全局 Hub 的 `/manage` 通信管理界面，分别管理模块本体、配置与数据，并维护本机实例及配置范围。独立 Launcher 界面、整合包和模板已退出发行；内部测试路径保留 `launcher-single-hub` 名称。旧整包／模板测试记录仅描述当时版本，不继承历史验收数量。

# 验证范围与命令

所有命令从源码仓库根目录执行。`scripts/verify.mjs` 的统一入口在 `.artifacts/evidence/` 保存报告，给出环境、实际命令、退出码和范围；直接运行单项测试时应另行保存这些证据。该目录被 Git 忽略。测试通过不表示任意第三方桥、任意语言或外部业务通过。

npm 安装包的 `world-hub --check` 是部署前的只读环境与配置检查，不等同以下源码测试。测试与用途演示文件从源码仓库获取；安装和导出入口见[npm 包](npm.md)。

| 测试集合 | 命令 | 需要的环境 |
| --- | --- | --- |
| 默认 Node 通讯与管理回归、独立多程序场景 | `npm test` 或 `npm run verify` | Node 22；默认无需 DSH、Python、pwsh |
| 四个用途演示的独立程序、通讯链路和 source 打包 | `npm run test:demos` | Node 22；无需模型账号或 DSH |
| 外部能力目录、独立处理器替换与可解释故障 | `npm run test:capabilities` | Node 22；无模型账号或 DSH |
| 可选外部 Runtime、真实 JS／Python 文本台、实例隔离与源码分发 | `npm run test:ecosystem` | 参考锁 Node 22.23.2、Python 3.14.0、websockets 15.0.1 |
| 独立托管 Workshop 的账号、发布、协作、停机与迁移 | `npm run test:workshop` | Node 22；隔离回环 HTTP 测试，不访问正式社区 |
| 三类资源契约、独立分发、配置切换、保留闭包与数据恢复 | `npm run test:resources` | Node 22；隔离真实管理 HTTP、临时文件和独立进程 |
| npm CLI 与真实 tarball 隔离安装、启动、桥通讯及停机 | `npm run test:npm` | Node 22 + npm；不改用户全局安装，也不发布 |
| JS／Python／PowerShell 互操作和三个候选桥 profile | `npm run test:cross-language` | Node、Python + websockets、PowerShell 7 |
| 真实已安装 DSH 的隔离测试模型集成 | `npm run test:dsh` | Node、显式 `PEROS_DSH_ROOT` |
| 一座候选桥 | `node tests/bridge-acceptance/run.mjs --bridge tests/bridge-acceptance/python.json` | manifest 所需环境 |
| Python 桥受控检查 | `python tests/fixtures/python/self_check.py` | Python + websockets、Node |
| PowerShell 桥受控检查 | `node tests/fixtures/powershell/smoke.mjs` | Node、PowerShell 7 |

默认 Node 集执行所有 `tests/conformance/*.test.mjs`、JSON-RPC 传输与上下文程序测试、定向／大对象场景、外部工作流、事件面板和三程序链路。真实 DSH 集成需单独运行 `npm run test:dsh`。测试名称用于定位用例，不代表产品模块分类。

用途演示集检查真实独立进程：交通来源自行登记新增主题，汇总从两源扩展为三源；第四个上下文提供者进入组合；另一份独立执行器按相同应用合同返回不同成果；导演逐轮请求 NPC、规则与状态程序。程序返回的内部调用回执与界面自己观察到的通讯分别呈现，不把订阅到的少量事件当作全部定向信息流。演示使用简化业务与确定性本地执行器。

能力目录集合使用真实独立进程与 Hub 请求回应，核验公开合同的两个独立处理器、只改组装配置的替换、真实主体与序号、版本不兼容、应用授权拒绝、目录租约过期以及超时结果未知。目录、清单、幂等与选择均在外部程序；该集合不证明任意第三方软件能自动兼容。完整场景与运行入口见[能力目录示例](../examples/capability-directory/README.md)。

能力目录用途启动器为各主体分配独立随机凭据；手工受信测试夹具可能使用公开 token 来控制通讯场景，不能据此证明恶意程序的主体隔离。真实部署的身份绑定取决于各凭据的隔离，清单声明不是授权。

提供者接入材料包含[应用层接入契约](modules/provider-contract.md)、[机器契约](modules/text-statistics.contract.json)和[SDK 方法及独立请求／回应例子](../sdk/javascript/README.md)。能力集合中的 `ECOSYSTEM-11` 使用无项目历史的独立 AI 作者，只给冻结的这三份材料，从零生成新的提供者；验收以陌生模块 ID、主体和主题完成配置替换，并核对 Unicode、字节与 ID 边界、错误结构、授权、租约和重启恢复。固定程序与方法公开保留在源码测试装置中。这是 AI 文档隔离验收，不是已获得外部人类开发者的接入反馈；SDK 文件复制隔离、独立作者编写和实际业务完成分别保留证据。

`ECOSYSTEM-10` 验证可信目录地址配置和持久恢复、缺失／非法租约字段拒绝、重复有效模块地址拒绝、过期旧广告不挡住新有效广告，以及切换 140 个查询主题后仍能执行。回应订阅按每步清理，ACK、等待结束和订阅移除均不 release。SDK 文档的 echo 提供者和调用方也曾按代码原文在真实 Hub 与独立进程中执行；它验证通用 SDK 示例，不替代统计模块验收。

## 通信管理界面与本机模块运行辅助

`npm run test:ecosystem` 检查当前模块所用的路径规则、公开签名、声明依赖准备、独立宿主生命周期及软界面模块。它不再选择旧整包、模板、整包升级或派生测试。

`npm run test:launcher` 执行 `tests/integration/launcher-single-hub/`，并保留适用的所有者锁、版本选择和外部程序授权检查。覆盖直接修改实例、源码升级保留身份与状态、组的引用与共享进程、选择停组、全局和组启动计划、启停竞态、认证与 CSRF、已取消入口的拒绝、离线缓存完整性和网络策略边界。

真实多组场景使用 JS 来源、Python 统计和两个 JS 界面实例，核验业务请求、共享进程复用及全部受管子进程退出。Python 解释器通过 `WORLD_HUB_RUNTIME_TEST_PYTHON` 选择，需预先安装 `sdk/python/requirements.txt`。

界面处理器的 DOM 测试、HTTP 测试和实际浏览器操作分别取证。DOM 模型不验证 CSS 布局或真实键盘／浏览器行为。模块是否启动、自报就绪、建立桥连接和完成业务仍是不同事实。权限声明不提供 OS 沙箱。

当前专项回归包括模块与模块组的版本切换／恢复、卸载及共享成员保护、默认接线恢复、常驻／按需执行和作者默认值，以及中英文静态与动态文案。语言测试核对切换时保留未提交设置、自定义名称、主题和原始消息，不把 DOM 译文覆盖率当作实际浏览器布局验收。按需测试分别检查调用者授权、受管启动、就绪、租约、结果未知和空闲停止；普通消息不会触发 Hub Core 启动程序。

## 官方 Skill 与 MCP

`npm run test:agents` 需要先执行 `npm ci --prefix tools/mcp --ignore-scripts`。它通过官方 MCP 客户端、独立 stdio 子进程及隔离的真实 Hub，验证工具发现、认证身份、私有工具／主题／目标限制、Hub ACL、发布、留存抽取、ACK、定向请求／回应、注入和附件传输。实际 npm tarball 还需在独立目录安装、准备生产依赖，并由客户端连接安装后的入口；不从源码树补齐安装缺项。

边界场景覆盖超时与取消后不重发、历史截断和队列溢出的显式屏障、断线后重新核验身份、并发退订、凭据脱敏和 stdio 关闭。读、ACK 与释放分开：附件读取需本 MCP 合法收到消息后产生的有界授权，释放仅限本连接近期成功发布的信息。受限工具不修改 Hub 管理权限。

Skill 安装验收核对原始文件摘要、独立目录内的相对引用和已有目标保护。自动化独立阅读检查可用于发现文档遗漏，不能替代真人第三方独立开发或新手验收。MCP 当前只验证 2026-07-28 stdio；特定客户端集成、HTTP 传输、长期高负载与任意容量附件须另行验收。

## 可选语言环境

```powershell
python -m pip install -r sdk/python/requirements.txt
npm run test:cross-language
```

可通过 `HUB_PYTHON` 和 `HUB_PWSH` 选择自己的可执行文件；`PHASE7_PYTHON`、`PHASE7_POWERSHELL` 保留作为场景工具的兼容变量。路径只属于调用者环境，不写入仓库。PowerShell 使用随带的 .NET 编译 C# 辅助类，不需要 dotnet SDK。工作流仍由独立 JS 程序决定每轮访问哪些程序与如何合并结果。

跨语言场景覆盖实际独立进程、六个方向广播与定向请求／注入、原文、水位、ACK、释放权、多桥、附件以及受控重启。开放验收装置按 base／directed／blob 选择检查；未选择、失败前未到达和已通过分别记录。有限样本、等待时间与 manifest 控制协议只属于该装置，不规定所有程序采用 NDJSON。

## 可选真实 DSH

在自己的环境安装适用的 `@deepseek-ai/dsh`，将 `PEROS_DSH_ROOT` 指向含 `package.json` 和 `lib/bin.js` 的实际安装根目录，再运行：

```powershell
$env:PEROS_DSH_ROOT = '<你自己的 DSH 安装根目录>'
npm run test:dsh
```

缺少或不匹配的实际运行时明确失败。测试启动真正的 DSH 进程，在独立临时 home 和 workspace 中运行确定性模型适配器，限制网络，不读取用户模型凭据。它验证通讯与真实进程接口，不验证外部模型 API、真实工具业务或 ACP。真实使用时，模型、provider、工具许可和用户配置由外部 harness 选择。

## CI 与结果解释

便携包需从实际 ZIP 解压后核对文件清单、相对导入、静态资源、模块登记和真实运行；npm 验收会先打包到 tarball，再装入隔离前缀，使用安装结果运行 Hub、通信管理界面和 Workshop。不得用源码树中的文件补齐发行缺项。

浏览器验收单独记录中英文、导航、导入、登记、审阅、工作台和窄屏行为。如果浏览器不可用，只能声明实际完成的 HTTP 与 DOM 验收，不把历史截图或测试数量继承为当前验收。真人第三方独立开发与新手验收仍是独立待办。

独立 Workshop 集合检查邀请注册、会话和 CSRF、纯制品校验、不可变版本、公开来源索引与摘要下载、评论和绑定基线的提案、管理员隐藏与禁用、重启、私有导出与新目录恢复，以及部分写入故障和私有 nonce 优雅停机。上传程序不执行。浏览器交互和真实 HTTPS 发布→本机工坊获取→审阅与运行须另行验收；回环测试不证明正式服务器、断电耐久或高负载容量。部署限制见[Workshop 指南](ecosystem/workshop.md)。

CI 按工作流选择 Windows 的 Node／Python／PowerShell 场景、Linux 所有权专项，以及 Windows／Linux 的 MCP 专项。只有实际工作流结果才能说明远端执行是否通过；本机 green 不等于 GitHub Actions 已执行。Linux 全产品、跨机器、断电耐久、至少 24 小时高负载、所有辅助技术与任意容量附件均需另行验收。

管理 DOM 模型、真实 WebSocket 自动测试和人工浏览器操作是不同证据。`published` 仅证明 Hub 接纳，`caught_up` 仅表示扫描／发送屏障，ACK 不表示业务完成也不授权清理。报告必须保留这些区别，不把静态文档存在、候选场景目录或跳过检查计为通过。
