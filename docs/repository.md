# 仓库结构

| 路径 | 内容与责任 |
| --- | --- |
| `src/hub/` | 线协议、寻址、主题路由、通信日志和对象存储 |
| `src/management/` | 本机通信管理 API、拓扑和用户通信工作台 |
| `src/debug/` | 本机只读调试视图 |
| `sdk/javascript/`、`sdk/python/`、`sdk/powershell/` | 外部程序可选择的模块桥实现 |
| `config/hub.json` | 直接部署 Hub 的参考接线与容量配置 |
| `bin/world-hub.mjs` | 启动 Hub 与 `/manage` 通信管理界面的 npm 入口 |
| `tools/launcher/` | 通信管理所用的模块、实例、分组、路径与进程辅助；旧独立界面与服务不进入发行 |
| `scripts/runtime/` | 源码树中的共用校验、来源、解释器与进程辅助；发行只带实际依赖闭包，不提供旧整包 Runtime 入口 |
| `tools/workshop/` | 独立托管社区服务，不运行上传程序 |
| `tools/interop/` | 独立能力契约验收装置 |
| `examples/` | 普通外部程序与通信演示，业务和成果留在程序 |
| `tests/` | 通信合同、SDK、模块管理、社区与发行验收 |
| `docs/specs/` | 当前通信规范；旧整包工具规格标为历史 |
| `docs/ecosystem/` | 模块声明、接入和分发指南 |
| `scripts/release/` | 明确文件清单的构建与完整性检查 |
| `.github/workflows/` | 持续集成 |
| `LICENSE` | 项目源码与文档的 MIT 许可 |

模块（module）是外部程序制品；模块桥（module bridge）是它的通信适配层。一个程序可使用多座桥。普通程序无需采用管理器的模块声明即可接入；Hub 不读取模块组，也不装载业务程序。

## 发行边界

npm 和 Hub 源码／便携 ZIP 提供通信核心、管理界面、SDK、共用运行辅助与当前文档。`world-hub --open` 在同一个本机 Hub 的 `/manage` 中管理模块和模块组。旧独立 Launcher、`world-hub-pack` 命令、`world-hub/runtime` 公开导出、整包运行器、模板素材和专用旧界面不在当前发行入口。历史源码保留供审计，不代表仍支持该产品路径。

私有配置、身份秘密、通信日志、游标、业务数据、依赖缓存、测试证据和生成制品不打进公开发行。管理器的数据目录属于私人部署，不能直接作为模块上传。

## 许可

项目源码和文档采用 [MIT](../LICENSE)，保留版权和许可。便携包官方 Node 的 `runtime/LICENSE`、来源与 SHA-256 独立保留。Python 的 websockets、Electron、模型和其他程序使用各自许可；项目许可不替代它们的许可。

[npm 使用](npm.md) · [构建与分发](releases.md) · [模块接入](ecosystem/launcher-deployment.md)
