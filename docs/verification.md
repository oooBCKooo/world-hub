# 验证范围与命令

所有命令从源码仓库根目录执行。`scripts/verify.mjs` 的统一入口在 `.artifacts/evidence/` 保存报告，给出环境、实际命令、退出码和范围；直接运行单项测试时应另行保存这些证据。该目录被 Git 忽略。测试通过不表示任意第三方桥、任意语言或外部业务通过。

npm 安装包的 `world-hub --check` 是部署前的只读环境与配置检查，不等同以下源码测试。测试与用途演示文件从源码仓库获取；安装和导出入口见[npm 包](npm.md)。

| 测试集合 | 命令 | 需要的环境 |
| --- | --- | --- |
| 默认 Node 通讯与管理回归、独立多程序场景 | `npm test` 或 `npm run verify` | Node 22；默认无需 DSH、Python、pwsh |
| 四个用途演示的独立程序、通讯链路和 source 打包 | `npm run test:demos` | Node 22；无需模型账号或 DSH |
| 外部能力目录、独立处理器替换与可解释故障 | `npm run test:capabilities` | Node 22；无模型账号或 DSH |
| 可选外部 Runtime、真实 JS／Python 文本台、实例隔离与源码分发 | `npm run test:ecosystem` | 参考锁 Node 22.23.2、Python 3.14.0、websockets 15.0.1 |
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

## 可选外部整合包 Runtime

`npm run test:ecosystem` 选择 `tests/integration/ecosystem-runtime/` 的真实程序与分发检查。测试环境可通过 `WORLD_HUB_RUNTIME_TEST_PYTHON` 选择预安装解释器；依赖必须先由使用者准备。参考文本台以 JS 来源、Python 统计、JS 浏览器程序完成原文抽取、统计和成果保存；Runtime 只负责生命周期。

该集合检查 CLI 导入与审阅摘要、真实通讯与应用结果、多实例配置／数据／凭据分离、停止／重启保留、导出后干净根目录重建、兼容模块配置替换、多桥，以及内容损坏、环境不符、权限声明、启动／健康／停机故障的拒绝或清理。源码分发另检查完整允许清单、模块锁定字节、Schema、CLI 在无仓库外部引用情况下检查样例，并拒绝额外生成文件。完整性检查、构建成功与实际解压包端到端运行分别取证，不能互相替代。

进程存活、模块 `module-ready`、匹配 id 的 `module-health`、实际 Hub `/status` 中的桥身份／会话，以及每次应用成功是不同证据。部署权限声明没有 OS 强制隔离；解释器探针只检查用户选择的实际环境。这里不证明任意第三方程序安全、不证明跨机器运行，也不意味着业务超时后可安全重试。声明规范和运行接口见[开放部署规范](ecosystem/pack-spec.md)与[外部 Runtime](ecosystem/runtime.md)。

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

CI 当前选择 Windows 和明确的 Node／Python／PowerShell 环境。只有实际工作流结果才能说明远端执行是否通过；本机 green 不等于 GitHub Actions 已执行。Linux、跨机器、断电耐久、至少 24 小时高负载、所有辅助技术与任意容量附件均需另行验收。

管理 DOM 模型、真实 WebSocket 自动测试和人工浏览器操作是不同证据。`published` 仅证明 Hub 接纳，`caught_up` 仅表示扫描／发送屏障，ACK 不表示业务完成也不授权清理。报告必须保留这些区别，不把静态文档存在、候选场景目录或跳过检查计为通过。
