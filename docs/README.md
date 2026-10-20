# 文档入口

世界枢纽只负责程序间通信。模块可理解为“程序 + 枢纽桥”；枢纽桥负责程序与 Hub 之间的双向通信。程序选择自己的枢纽桥、主题、信息种类、上下文和业务。运行 `world-hub --open`，在通信管理界面管理同一个本机 Hub 上的模块实例、模块组、接线和启动计划。

智能体接入见 [官方 Skill 与 MCP](ecosystem/agents.md) / [English](ecosystem/agents.en.md)：Skill 提供使用和开发指导，MCP 通过普通枢纽桥提供通信工具。

| 阅读目标 | 入口 |
| --- | --- |
| 导入模块、登记实例、分组与运行 | [入门流程](../README.md#从模块开始)、[English](../README.en.md#start-with-modules) |
| 单模块、可分享模块组、公开配置与启动计划 | [模块声明](ecosystem/modules.md)、[来源格式](ecosystem/sources.md) |
| 交付通信管理界面可导入的模块 | [模块声明](ecosystem/modules.md)、[作者指南](ecosystem/developer.md)、[English](ecosystem/developer.en.md) |
| 自行运行的桌面宿主、服务和已有软件 | [独立程序接入](ecosystem/external-programs.md)、[English](ecosystem/external-programs.en.md) |
| 直接启动 Hub、配置、数据与容量 | [部署](deployment.md) |
| npm CLI 与三个语言 SDK | [npm 包](npm.md)、[枢纽桥接入](onboarding.md) |
| 通信边界、协议和可靠性 | [现行规格](specs/index.md) |
| 独立编写可替换提供者 | [提供者契约](modules/provider-contract.md)、[机器契约](modules/text-statistics.contract.json)、[互操作基准](ecosystem/interop.md) |
| 获取模块与检查来源 | [软件来源](ecosystem/sources.md)、[信任边界](ecosystem/trust.md) |
| 独立部署社区服务 | [Workshop](ecosystem/workshop.md) |
| 多来源系统提示、对话和 harness | [分布式上下文](examples/distributed-context.md) |
| 多轮、每轮多程序的业务流程 | [工作流](examples/workflows.md) |
| 外部能力目录和处理器替换 | [能力目录](examples/capability-directory.md) |
| 源码结构、开发、验证与构建 | [仓库结构](repository.md)、[开发](development.md)、[验证](verification.md)、[分发](releases.md) |

独立 Launcher、整合包与模板已退出当前产品，历史运行和生成指南不再进入当前导航或发行文档。旧源码和用户数据不因取消这些对象而自动删除。当前通信规范与 SDK 不依赖这些部署对象。

源码与文档采用 [MIT](../LICENSE) 许可，第三方运行时保留自己的许可。
