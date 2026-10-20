# 无界面用途场景：独立程序组合与替换

这些场景让独立程序通过枢纽桥完成事件汇合、分布式上下文、连续世界回合和能力发现。Hub 负责接纳、寻址、留存和传递信息；来源选择、上下文组装、工作流与业务成果由外部程序实现。

## 运行验证

克隆仓库，使用 Node.js 22.4+，从根目录执行：

```powershell
npm run test:demos
npm run test:capabilities
```

这些命令运行实际独立程序和通信链路，保存验证报告，不启动浏览器。用途场景的演练界面及视觉发行工具已移出本项目，见[项目分离](../specs/ui-separation.md)；本仓库不提供旧的 `demo:*-explorer` 或 `build:demos` 命令。

| 场景 | 外部程序如何组合 | 需核对的成果 |
| --- | --- | --- |
| `event-desk` | 环境、行情、交通分别提供事件，汇总程序接收；传感器使用采样与控制两座桥 | 启用第三来源后的新增主题、汇总读数、控制后的变化与真实消息序号 |
| `modular-assistant` | 系统提示、对话与材料来自不同程序；组装程序选择来源与执行器 | 第四来源进入上下文、执行器更换、来源身份与请求／回应回执 |
| `digital-world` | 导演每轮请求 NPC、规则和状态程序，逐轮提交业务变化 | 起始状态、逐轮 `timeline`、最终状态与实际调用回执 |
| `capability-directory` | 目录提供合同与租约，组装程序选择统计实现 A 或 B | 来源和输出程序不变，替换处理器后结果与身份正确；版本、授权、超时失败有明确结果 |

两个助手执行器为确定性本地实现，返回 `modelInvoked: false`。接入真实模型、DSH 或其他 harness 时，由外部执行器自己处理模型配置、凭据与工具权限。扩展来源、替代执行器和交通来源是演示预置的独立程序，不能据此推导任意第三方程序无需适配即可接入。

## 其他通信入口

下面的源码命令也不依赖管理界面：

```powershell
npm run demo:events
npm run demo:context
npm run demo:directed
npm run demo:workflow
npm run demo:three
```

分别演示双向事件、分布式上下文、请求／注入与附件、多轮工作流和三程序信息流。真实 DSH 验证另需安装并显式选择本机运行时，见[分布式上下文](distributed-context.md)。

## 修改外部程序

用途源码及替换入口见 [examples/purpose-demos](../../examples/purpose-demos/README.md)。先执行原场景，保留一次真实回执，再替换自己的实现并重跑。信息格式变化时同步调整外部调用方；新增业务种类不需要给 Hub 增加专门代码。

提供者拥有自己的状态与数据，并决定何时释放原始信息。读取、ACK、回应、暂停或结束会话均不等于释放。协议、SDK、运行时资源边界与当前验证范围分别见[通信规格](../specs/index.md)、[接入指南](../onboarding.md)与[验证说明](../verification.md)。
