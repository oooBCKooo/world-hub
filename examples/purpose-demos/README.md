# 用途演示源码：改组合，看成果

这组独立外部程序展示三种组合方式：把新的来源纳入同一面板、为上下文增加提供者并切换执行器、由多个程序逐轮产生世界变化。Hub 只转送约定信息；业务、状态和组合策略由各程序拥有。

从源码仓库根目录选择一套：

```powershell
npm run demo:events-explorer
npm run demo:assistant-explorer
npm run demo:world-explorer
```

Node.js 22.4+ 即可启动，无需安装运行依赖。顶部“跟着这条路线试一遍”的步骤按钮只准备操作，再按“运行这个操作”真实发出信息；也可在“我想做什么？”中选择其他动作。表单可改参数，原始 JSON 与信封可展开。完整步骤和包运行说明见[动手探索指南](../../docs/examples/purpose-demos.md)。

| 场景 | 动手路线 | 应观察的真实成果 |
| --- | --- | --- |
| `event-desk` | 读取两源 → 启用第三种来源 → 再读汇总 | 新交通主题由独立来源登记，汇总增加交通读数；传感器另有控制桥 |
| `modular-assistant` | 运行三源上下文 → 加入第四来源 → 换用清单执行器 | 来源与完整上下文增加 `extension`，执行器身份与成果形式改变 |
| `digital-world` | 推进三轮 → 注入 NPC 倾向 → 运行休整回合 | 导演逐轮调用 NPC／规则／状态，起始状态、逐轮回执与最终变化对应 |

扩展来源和替代执行器是已随演示启动的预置独立程序：交通初始只监听控制，启用后登记采样主题；助手由组装程序选择参与本轮的材料和执行器。这里没有任意可执行文件的自动热插拔。两个执行器均为确定性本地实现，返回 `modelInvoked: false`；需要真实模型或 DSH 时，由自己的外部执行器接入。

## 文件与替换入口

| 文件 | 负责的内容 |
| --- | --- |
| [profiles.mjs](profiles.mjs) | 外部程序、桥、操作、演练步骤、主题和目标；可声明独立 Node `entryFile` |
| [run-demo.mjs](run-demo.mjs) | 建立新会话，生成接线配置，拥有并关闭本次 Hub／外部程序 |
| [peer.mjs](peer.mjs) | 默认业务入口与独立入口共用的启动、ready、关闭约定 |
| [common.mjs](common.mjs) | 双向桥、请求回应、状态文件及共用业务校验 |
| [event-desk.mjs](event-desk.mjs) | 环境、行情和汇总；汇总按 `+/sample` 接收来源 |
| [traffic-source.mjs](traffic-source.mjs) | 独立交通进程，控制输出、登记新采样主题和发布读数 |
| [modular-assistant.mjs](modular-assistant.mjs) | 系统／对话／资料提供者、外部组装与模板执行器 |
| [extension-material.mjs](extension-material.mjs) | 独立扩展材料提供者，实现相同材料请求合同 |
| [checklist-harness.mjs](checklist-harness.mjs) | 独立清单执行器，实现相同上下文输入／回答输出合同 |
| [digital-world.mjs](digital-world.mjs) | 独立世界状态、规则、NPC 与多轮导演 |
| [explorer.mjs](explorer.mjs) | 独立浏览器界面程序的 HTTP 入口及双向 mod |
| [explorer.html](explorer.html)、[explorer.js](explorer.js)、[explorer.css](explorer.css) | 引导操作、用途成果和可观察的通讯记录 |

默认业务文件通过不同 `--peer` 启动为独立进程；独立扩展文件使用自己的业务实现和入口。这样的源码组织不规定接入程序必须采取同一形态。传感器有采样与控制两座桥；探索界面也通过自己的桥通讯。

## 从一个模块开始改

| 想替换的程序 | 双方约定的合同入口 | 核对什么 |
| --- | --- | --- |
| 事件来源 | `<来源>/sample` 发布；需要控制时处理 `<来源>/control` | 实际发布桥 `from`、消息 `seq`、汇总 `latest` 与读数变化 |
| 材料提供者 | `context/<提供者>` 的 `snapshot` 请求，返回 `text` 与 `revision` | `sources` 回执与 `context.materials` 包含该来源 |
| 执行器 | `harness/run` 请求含 `context`、`sources`；返回 `answer` 与实现信息 | 实际执行器主体、请求／响应序号、结果与上下文对应 |
| NPC／规则／状态 | `npc/plan`、`rules/step`、`world/state` | 导演 `receipts`、每轮 `timeline`、最终状态 |

以上是演示业务的合同摘要，完整字段与错误返回以对应实现为准。主题前缀为 `demo/<场景>/`；寻址目标是程序的认证主体，桥名用于核对接线。Hub 的通用协议见[通讯规格](../../docs/specs/protocol.md)，各语言桥见[接入指南](../../docs/onboarding.md)。

1. 先运行原场景并保存一次结果，确认输入、返回和程序身份。
2. 写自己的实现，保留相邻程序所需的业务合同；更改信息格式时，同时调整外部调用方或消费者。
3. 在 `profiles.mjs` 声明程序与桥，给新 Node 入口设置 `entryFile`；入口参照现有独立扩展实现相同参数、ready 和退出约定。演示选择材料与执行器的合法名称由外部组装程序约定，也要同步调整。
4. 授予新身份所需的主题权限，让自己的 mod 登记主题并处理信息。无需给 Hub 新增业务 `kind`。
5. 重新运行原链路与新增链路，查证真实来源、消息序号和成果，再构建分享包。

这套启动器拥有 Node 进程。Python、其他运行时或已有软件须自行启动，或调整外部启动器与接线；修改名称不会自动适配其启动和业务合同。参考 `config/hub.json` 不参与本次演示会话，实际配置由启动器生成在本次运行目录。

## 会话、检查与构建

每次启动使用新的运行目录。也可以直接选择场景、只读检查或指定尚不存在的目录：

```powershell
node examples/purpose-demos/run-demo.mjs --profile event-desk --check
node examples/purpose-demos/run-demo.mjs --profile modular-assistant --state-dir './my-new-session' --open
npm run test:demos
npm run build:demos -- --profile event-desk
```

`--check` 不启动程序、不建立文件。正常启动保留终端，在所属终端按 Ctrl+C 并等待关闭。Hub 记录与各外部程序状态分别保存，读取、ACK、回应、暂停和退出不等于提供者释放。每次新会话也不自动续接旧业务。

“本界面观察到的信息”是界面实际有权观察的消息；其他程序之间的定向调用通过返回的 `sources`、`harness`、`receipts` 查证。测试、浏览器操作和 ZIP 解压验收各自记录，不能把完整性检查扩大为业务通过或任意组合通过。

源码按 [MIT 许可](../../LICENSE)使用；便携包的 Node.js 与其他接入程序遵守各自许可。构建、数据文件、生命周期和适用范围见[完整探索指南](../../docs/examples/purpose-demos.md)。
