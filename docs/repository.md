# 仓库结构

| 路径 | 内容与责任 |
| --- | --- |
| `src/hub/` | Hub 线协议、主题路由、通讯日志和磁盘对象 |
| `src/management/` | 本机管理 API、拓扑画布、用户通讯工作台 |
| `src/debug/` | 本机只读调试视图 |
| `sdk/javascript/`、`sdk/python/`、`sdk/powershell/` | 外部程序可选用的桥实现，不随 Hub 装载 |
| `config/hub.json` | 可编辑的本机参考接线配置，含身份、主题权限和通讯容量 |
| `examples/` | 独立程序示例与用途演示；业务、上下文、流程及成果都留在程序 |
| `tests/conformance/` | 协议、机制、职责边界、管理与桥回归 |
| `tests/integration/` | 多程序场景与可选真实 DSH 集成 |
| `tests/fixtures/`、`tests/helpers/` | 测试控制程序、隔离进程与取证辅助 |
| `tests/bridge-acceptance/` | 通过 manifest 选择候选桥的开放验收装置 |
| `scripts/` | 启动、检查、验证与可重跑构建工具 |
| `bin/world-hub-pack.mjs`、`scripts/runtime/` | 可选的外部本地整合包 Runtime；导入、审阅、实例与程序生命周期 |
| `docs/ecosystem/` | 外部 module／pack／lock 部署声明、JSON Schema 与 Runtime 接口 |
| `examples/ecosystem-pack/` | 三个独立 JS／Python 程序、随带桥源码和完整参考包锁 |
| `docs/` | 当前规范、使用、接入、开发及分发说明 |
| `.github/workflows/` | 声明实际运行环境和测试范围的 CI |
| `LICENSE` | 项目源码与文档的 MIT 许可 |

目录区分通讯核心、桥、外部示例、测试和工具；不要求接入者仿照这些目录或把自己的程序迁入仓库。

`data/`、`.hub/`、`.artifacts/`、运行时下载缓存、Python bytecode、依赖目录、ZIP、备份、个人配置与密钥都是本机／部署产物，不能提交。正式发布包由明确允许的文件集合重新生成，不将工作区整目录打包。

模型、DSH 的安装、用户 home、业务上下文和程序自己的游标属于外部程序配置。示例只含合成输入和测试身份；真实凭据通过部署方自己的未跟踪配置提供。

## 许可与第三方文件

本仓库的 Hub、管理界面、SDK、示例、测试和文档采用根目录的 [MIT 许可](../LICENSE)，版权署名为 `2026 oooBCKooo`。使用、修改或再分发时保留该版权和许可文本。MIT 标准文本见 [Open Source Initiative](https://opensource.org/license/mit)。

官方 Node 运行时仅按分发构建选项复制到生成包的 `runtime/`，其完整 `runtime/LICENSE`、来源与 SHA-256 记录独立保留，不由本项目重新许可。Python SDK 引用的 `websockets` 由使用者另行安装；PowerShell SDK 使用 .NET 系统 API；可选 DSH 场景调用用户另外安装的运行时。这些第三方软件遵循各自许可，项目 MIT 许可不替代它们的许可。

npm 包采用明确文件清单，提供 Hub CLI、可选外部 Runtime 与 JavaScript、Python、PowerShell 三个 SDK；JavaScript 和 Runtime 提供包导出入口，Python 和 PowerShell 桥按模块文件路径使用，并需要各自运行环境。仓库测试、业务示例、下载的运行时和用户数据不随 npm 安装。源码仓库与 npm 包的操作入口见[npm 包](npm.md)和[开发](development.md)。

生态声明里的 module 是可部署的外部程序包，mod 是程序选用的通讯桥。一个 module 可以有多个 mod，普通程序无需采用这个部署 profile。Hub 不读取清单、不装载程序、不选择能力，也不解释程序业务。公开 `examples/ecosystem-pack/pack.lock` 只锁定该样例源码与环境；运行中的实例锁、私有 run 配置和数据仍为部署产物。
