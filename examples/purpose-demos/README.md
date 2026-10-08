# 用途演示源码

这是一组独立外部程序，用于探索世界枢纽的组合方式。Hub 只负责通讯；事件采集、参数控制、上下文组装、harness、世界状态、规则及 NPC 均在这些程序中实现。

从仓库根目录运行：

```powershell
node examples/purpose-demos/run-demo.mjs --profile event-desk --open
node examples/purpose-demos/run-demo.mjs --profile modular-assistant --open
node examples/purpose-demos/run-demo.mjs --profile digital-world --open
```

每次选择一个场景；默认写入独立运行目录。只读检查用 `--check` 替代 `--open`，停止时在所属终端按 Ctrl+C 并等待退出。完整的启动、构建、修改及验证指南见 [用途演示整合包](../../docs/examples/purpose-demos.md)。

| 场景 | 外部程序负责的用途 |
| --- | --- |
| `event-desk` | 多来源事件输入、浏览器查看、回传参数修改 |
| `modular-assistant` | 分布式系统提示词／对话／材料、上下文组装、确定性本地 harness、结果显示 |
| `digital-world` | 独立世界状态、规则／行动、NPC、多轮结果显示 |

助手演示不调用在线模型或 DSH。替换成真实 harness 是外部模块开发工作；Hub 不选择模型，不读取模型凭据，也不执行工具。

## 文件与开发入口

| 文件 | 负责的内容 |
| --- | --- |
| [profiles.mjs](profiles.mjs) | 外部场景的程序与桥、动作、主题及定向目标 |
| [run-demo.mjs](run-demo.mjs) | 创建新会话目录，启动并关闭本次拥有的 Hub 与外部程序 |
| [peer.mjs](peer.mjs) | 根据 `--profile`、`--peer` 启动一个外部程序角色 |
| [common.mjs](common.mjs) | 外部程序共用的桥、收发与状态文件工具 |
| [event-desk.mjs](event-desk.mjs) | 两个来源的采样与参数、汇总订阅 |
| [modular-assistant.mjs](modular-assistant.mjs) | 三个上下文提供者、上下文组装、模板 harness |
| [digital-world.mjs](digital-world.mjs) | 世界状态、NPC、行动规则及多轮导演 |
| [explorer.mjs](explorer.mjs) | 独立探索界面的 HTTP 入口与双向 mod |
| [explorer.html](explorer.html)、[explorer.js](explorer.js)、[explorer.css](explorer.css) | 浏览器展示与操作 |

同一个业务文件通过不同 `--peer` 启动成独立进程；代码的组织方式不规定接入程序必须采用这种形态。传感器用两座桥，其余示例角色各用一座桥；探索界面也是通过自己的桥进行通讯的普通外部程序。

修改时先画出程序与桥的对应关系，核对调用方、提供者、输入输出格式和主题权限。新的来源、角色或 `body.kind` 由 mod／程序接入，业务意义由参与程序约定。提供者决定何时释放信息，读取、回应和退出都不自动释放。

```powershell
npm run test:demos
npm run build:demos -- --profile event-desk
```

测试和构建针对已有场景。换模块、增桥、改语言或扩展业务后，需单独验证新链路；不要把原始演示通过扩大为任意组合均已通过。
