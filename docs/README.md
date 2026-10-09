# 文档入口

世界枢纽只负责程序间通讯。接入者可以采用自己的程序、mod 形态、主题和信息种类；系统提示词、模型、harness、工作流和业务状态由外部程序管理。

| 阅读目标 | 入口 |
| --- | --- |
| 启动、配置、数据与容量 | [部署](deployment.md) |
| 通过 npm 安装 CLI、取得三个语言 SDK | [npm 包](npm.md) |
| 用自己的程序接入 | [mod 接入](onboarding.md) |
| 当前规范 | [规范索引](specs/index.md) |
| 理解源码目录与组件责任 | [仓库结构](repository.md) |
| 修改代码和维护合同 | [开发](development.md) |
| 选择测试与解释结果 | [验证](verification.md) |
| 构建、检查、迁移分发包 | [分发](releases.md) |
| 按用途探索事件面板、模块化助手、数字世界和能力替换 | [用途演示整合包](examples/purpose-demos.md) |
| 独立编写可替换的能力提供者 | [提供者接入契约](modules/provider-contract.md)、[机器契约](modules/text-statistics.contract.json)、[JS SDK](../sdk/javascript/README.md) |
| 外部能力目录、公开合同与独立处理器替换 | [能力目录示例](examples/capability-directory.md) |
| 把本地独立程序部署成可重建整合包 | [开放部署声明](ecosystem/pack-spec.md)、[外部 Runtime](ecosystem/runtime.md)、[跨语言文本台](../examples/ecosystem-pack/README.md) |
| 多来源系统提示词、对话与 harness 示例 | [分布式上下文](examples/distributed-context.md) |
| 多轮、每轮多程序的工作流示例 | [工作流](examples/workflows.md) |

规范描述当前通讯行为及其限制。验证文档列出可运行的测试集合与环境要求，测试报告记录实际执行的范围和结果。

项目源码与文档采用 [MIT 许可](../LICENSE)。第三方运行时和依赖保留各自的许可；许可范围与发布边界见[仓库结构](repository.md)。
