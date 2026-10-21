# 用途场景源码

这些是普通外部程序，用于验证多来源事件、分布式上下文、可替换执行器、多轮世界回合与外部能力目录。业务状态和组合逻辑由程序拥有，Hub 只提供通信。

从仓库根目录运行：

```powershell
npm run test:demos
npm run test:capabilities
```

命令运行真实程序与通信场景，不需要浏览器。结果检查、适用边界和其他直接演示入口见[用途场景指南](../../docs/examples/purpose-demos.md)。演练页面和浏览器入口属于独立的 [world-hub-ui](https://github.com/oooBCKooo/world-hub-ui) 项目。

| 文件 | 外部程序职责 |
| --- | --- |
| [profiles.mjs](profiles.mjs) | 场景中的程序、桥、主题、目标与业务操作描述 |
| [peer.mjs](peer.mjs) | 共用的程序启动、就绪及关闭约定 |
| [common.mjs](common.mjs) | 枢纽桥、请求回应、程序状态与业务校验 |
| [event-desk.mjs](event-desk.mjs) | 环境、行情与汇总程序 |
| [traffic-source.mjs](traffic-source.mjs) | 控制输出、动态登记主题与发布交通采样 |
| [modular-assistant.mjs](modular-assistant.mjs) | 系统／对话／材料提供者、组装程序及模板执行器 |
| [extension-material.mjs](extension-material.mjs) | 独立的扩展材料提供者 |
| [checklist-harness.mjs](checklist-harness.mjs) | 使用相同输入合同的独立清单执行器 |
| [digital-world.mjs](digital-world.mjs) | 独立状态、规则、NPC 与多轮导演 |
| [explorer.mjs](explorer.mjs) | 场景的无界面 HTTP API 与通信适配 |

## 替换程序时的约定

| 替换目标 | 演示业务合同入口 | 核对内容 |
| --- | --- | --- |
| 事件来源 | `<来源>/sample` 发布；可选 `<来源>/control` | 实际发布桥、消息序号、汇总与控制结果 |
| 材料提供者 | `context/<提供者>` 的 `snapshot` 请求 | 来源回执和组装后的 `context.materials` |
| 执行器 | `harness/run` 的上下文输入与回答输出 | 提供者身份、请求／回应序号与成果 |
| NPC、规则、状态 | `npc/plan`、`rules/step`、`world/state` | 每轮调用回执、`timeline` 与最终状态 |

以上字段由示例业务约定，完整输入输出和错误以实现为准。先运行原场景再修改相应程序；更改业务格式时同步修改调用方或消费者。每个实际运行程序有自己的身份和枢纽桥，一个程序也可使用多座桥。Hub 不规定它们的语言、页面或进程组织。

助手中的两个执行器都是确定性本地实现，返回 `modelInvoked: false`。业务数据在程序的运行目录保存，通信记录在 Hub 保存；读取、ACK、回应和退出均不等于提供者释放。参见[通信协议](../../docs/specs/protocol.md)与[接入指南](../../docs/onboarding.md)。源码按 [Apache License 2.0](../../LICENSE)使用。
