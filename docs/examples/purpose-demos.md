# 动手探索：把独立程序组合成用途

世界枢纽让各自运行的程序通过 mod 桥交换信息。这三套演示把通讯变成可观察的成果：同一面板纳入新的事件来源、上下文增加一个提供者并切换执行器、多个程序逐轮推进一个小世界。浏览器探索界面也是普通外部程序，通过自己的桥请求、注入和接收信息。

| 想探索的能力 | 启动哪套演示 | 亲手做什么 |
| --- | --- | --- |
| 多来源信息汇合、双向控制、同程序多桥 | `event-desk`：多源事件台 | 把环境、行情两源扩展为三源，再向来源回传参数 |
| 分布上下文、增加来源、替换独立模块 | `modular-assistant`：分布上下文助手 | 增加第四个上下文来源，再切换到独立清单执行器 |
| 多轮、多程序成果 | `digital-world`：外部数字世界 | 观察状态变化与逐轮回执，再修改 NPC 倾向继续运行 |

## 启动一套演示

需要 Node.js 22.4+。从 GitHub 克隆源码后，在仓库根目录选择一条命令；无需安装 npm 运行依赖：

```powershell
npm run demo:events-explorer
npm run demo:assistant-explorer
npm run demo:world-explorer
```

每次选择一个场景，保留启动终端。浏览器自动打开探索地址；启动输出也给出实际地址。顶部“跟着这条路线试一遍”的按钮会准备对应操作；可修改普通表单字段，再按“运行这个操作”实际发出信息。也可以在“我想做什么？”中选择其他操作。路线按钮不会自动执行整条链路，便于逐步查看成果。

`world-hub --open` 和源码的 `npm start` 打开 Hub 管理界面。用途演示由上述独立入口启动；npm 安装包不包含演示源码或构建工具。已有演示 ZIP 的运行方法见下文[分享与运行整合包](#分享与运行整合包)。

## 路线一：一个面板接纳不同来源

环境传感器、行情来源、交通来源、汇总程序和探索界面各自运行。传感器的采样桥和控制桥属于同一个程序。汇总程序接收来源事件，界面请求汇总并把控制信息返回给来源。

| 操作 | 应看到的成果 |
| --- | --- |
| 等待首轮采样，执行“读取多源汇总” | 环境与行情分别显示最近读数、来源和消息序号；刚启动时可稍等后重试 |
| 执行“启用第三种来源”，再执行“读取多源汇总” | 交通程序返回自己的身份、桥和新增主题；汇总增加第三种交通读数 |
| 执行“调节采样参数”，再执行“请求环境读数” | 返回新周期与偏移；环境采样继续从该程序另一座桥发布 |
| 执行“暂停交通输出”，再读取汇总 | 新交通采样暂停；已经产生的通讯记录与最近读数仍保留 |

交通程序在启动时已经有独立进程和桥，初始只监听控制。启用动作让它首次登记 `demo/event-desk/traffic/sample` 并发布读数；这是将预置独立来源加入信息流。汇总程序自己的 `+/sample` 订阅约定接收新增来源，Hub 无需增加“交通”业务代码。

原始汇总结果的 `latest` 保存各来源的 `value`、桥 `from`、主题 `topic` 与消息 `seq`。交通来源还返回 `declaredTopic`、`topicRegistered`、`enabled` 和 `last`；读数包含 `vehicles` 与 `congestion`。认证主体以请求返回的响应信封 `fromPrincipal` 为准，采样发布信封只提供实际桥 `from`。传感器读数的 `bridgeMapping` 可对照同一程序的两座桥。

可继续尝试“注入环境偏移”“调节行情参数”。注入接纳回执说明 Hub 接纳信息，执行效果以来源随后发布的变更和读数为准。环境样例自行约定 `intervalMs` 为 250–10000 毫秒、`offset` 为 -20–20；行情与交通也是演示数据。这些限制和含义属于来源程序。

## 路线二：分布上下文，加来源，再换执行器

这套演示组合系统提示、用户对话、资料和执行器。系统提示与用户对话都在上下文中，由各自程序持有；组装程序决定请求哪些提供者、如何组合，并把结果交给独立执行器。

| 操作 | 应看到的成果 |
| --- | --- |
| “运行分布上下文” | 三个来源 `system`、`dialogue`、`material` 的文本和真实回执，以及模板执行器的回答 |
| “加入第四个上下文来源” | `extension` 独立提供者加入；上下文材料与回答包含扩展约束 |
| “换用独立清单执行器” | 执行器身份由 `harness` 变为 `checklist`；结果变成可阅读的来源检查清单 |
| “修改扩展来源”，再运行含第四来源的操作 | 扩展程序保存的新文本出现在下一次组合中 |

扩展材料与清单执行器是不同入口文件、不同进程、不同身份的预置程序。这里展示选择另一份独立实现，并保持双方约定的通讯格式。原执行器仍可供后续调用；这不是任意可执行文件的自动热插拔。

查看“实际调用的上下文来源”“组装后交给执行器的上下文”和“执行器输出”，再展开“本次操作的原始回应与接纳回执”。原始结果的 `context.systemPrompt`、`context.messages`、`context.materials` 展示实际组装输入；`sources` 记录提供者、主体、桥、请求序号和响应序号。`harness` 记录实际执行器的回执，`harnessProvider` 与 `executorImplementation` 标明本次选择。清单执行器的 `checklist` 逐项引用来源回执。

选择“修改系统提示”“增加用户对话”“修改参考材料”也可改变各程序拥有的输入。可以在表单里修改本轮问题；扩展操作使用 `materialProviders: ["material", "extension"]`，切换执行器使用 `harnessProvider: "checklist"`。组装程序将本轮问题和返回的回答交给对话提供者保存，继续操作会形成多轮历史。

两种执行器都是确定性本地实现：模板模式 `deterministic-template` 回显上下文，清单模式 `deterministic-checklist` 输出来源检查项，均明确返回 `modelInvoked: false`。接入真实模型或 DSH 时，用独立执行器实现约定的输入输出；模型配置、凭据与工具权限仍由它自己处理。另有[真实 DSH 的分布式上下文示例](distributed-context.md)。

## 路线三：多程序、多轮次产生世界变化

世界状态、NPC、行动规则、导演和界面分别通讯。导演每轮请求 NPC 行动、规则计算与状态提交，最终返回整段成果。每次跨程序调用经 Hub 传递；轮次和行动由外部导演决定。

| 操作 | 应看到的成果 |
| --- | --- |
| “推进 3 轮世界” | 本次起始状态、三轮变化与最终状态可对照；也可用“读取世界状态”单独查询 |
| “注入 NPC 倾向” | 注入接纳回执，以及 NPC 自己发布的设置变更 |
| “运行休整回合” | 后续轮次使用新的 NPC 倾向，出现补给与体力恢复 |
| “重置演示世界” | 状态程序的业务世界被重置；已有 Hub 通讯记录继续保留 |

查看“当前世界状态”“导演返回的逐轮行动”“程序返回的调用回执”。原始结果的 `initialState` 是导演本次实际读取的起始状态，`timeline` 记录每轮行动与状态，`finalState` 是最终业务状态，`receipts` 给出 NPC／规则／状态程序的真实调用身份和消息序号。可修改轮数和行动；导演样例约定一次 1–12 轮，行动为 `scout`、`rest`、`trade`。

这套有限世界用来观察“多个独立程序协作产生连续成果”。可以独立改 NPC、替换状态存储，或让新的渲染程序订阅世界事件；这些实现仍在 Hub 外。

## 把预置模块换成自己的程序

从[源码入口与合同](../../examples/purpose-demos/README.md)识别程序、桥与对应文件。建议先改一个模块，保留相邻程序约定的请求与返回格式，再增加自己的信息种类。

1. 记录原场景一次操作的输入、返回、主体和消息序号。
2. 为自己的来源或执行器分配身份、桥和主题，并在接线配置中授予所需权限。主题和 `body.kind` 由 mod／程序约定，业务含义由参与程序解释。
3. 实现对应业务合同。例如新材料提供者响应 `snapshot` 返回 `text` 与 `revision`；新执行器处理 `harness/run` 的上下文并返回 `answer`。参照[扩展材料](../../examples/purpose-demos/extension-material.mjs)与[清单执行器](../../examples/purpose-demos/checklist-harness.mjs)实现完整字段和错误返回。
4. 需要用演示启动器拥有该 Node 程序时，在外部 `profiles.mjs` 中声明 `entryFile` 并实现同一启动参数、ready 和关闭约定；既有程序默认由 `peer.mjs` 启动。换成 Python、已有软件或其他运行时时，需自行启动程序，或调整外部启动器与接线。只填一个名称不能自动适配程序。
5. 更新外部调用方选择的提供者、订阅与结果处理，再分别验证原场景和新增链路。

启动器在本次运行目录生成自己的 `hub.json`；包内 `config/hub.json` 是正常部署的参考配置，编辑它不会改变演示会话权限。为同一程序增加另一座桥时，各桥分别管理连接、订阅和游标；共享 credential 的信任、配额与释放归属也需由程序选择。

[JavaScript／Python／PowerShell 接入材料](../onboarding.md)提供通用通讯入口。业务合同与 Hub 通讯合同需要同时满足；接通桥后，各程序仍须约定如何理解信息。

## 会话、数据与可见记录

直接入口可以选择场景、只读检查或独立运行目录：

```powershell
node examples/purpose-demos/run-demo.mjs --profile event-desk --check
node examples/purpose-demos/run-demo.mjs --profile event-desk --open
node examples/purpose-demos/run-demo.mjs --profile modular-assistant --state-dir './my-new-session' --open
```

`--check` 只读检查文件和环境，不启动进程、不建立运行目录。每次启动默认在 `data/purpose-demos/<场景>/<本次运行目录>` 创建独立会话，保留 Hub 日志与各程序状态。`--state-dir` 必须指向尚不存在的新目录，避免覆盖或共享会话。新会话不自动续接上一次业务；停止时在所属终端按 Ctrl+C，等待启动器关闭自己拥有的程序。

| 程序 | 自己保存的业务文件 |
| --- | --- |
| 事件来源／汇总 | `source-state.json`、`traffic-state.json`、`summary-state.json` |
| 上下文提供者／组装／执行器 | `context-state.json`、`extension-state.json`、`last-result.json`、`harness-state.json`、`checklist-state.json` |
| 世界状态／NPC／导演 | `world-state.json`、`npc-state.json`、`last-run.json` |

各文件位于对应程序的运行目录。探索界面保存 `explorer-results.json`，可用“下载本次记录”导出当前记录；“查看枢纽与桥”打开这个会话自己的 Hub 管理页。

“本界面观察到的信息”展示探索界面有权观察的消息和自己的回应；内部定向调用通过业务成果中的 `sources`、`harness` 或 `receipts` 查证。二者不等于全程网络抓包。提供者决定何时释放原始信息，读取、ACK、回应、暂停输出和停止会话都不自动释放它。

## 分享与运行整合包

从源码仓库构建全部三套源码包，或只选择一个场景：

```powershell
npm run build:demos
npm run build:demos -- --profile event-desk --output-root dist/event-desk-source
```

源码包使用接收者 PATH 中的 Node。Windows x64 便携包携带经官方 SHA-256 核对的 Node 22.23.2、许可证与来源记录；先准备新的运行时缓存目录，再构建：

```powershell
node scripts/release/prepare-runtime.mjs --download --output .artifacts/runtime/demo-node-win-x64
npm run build:demos -- --runtime .artifacts/runtime/demo-node-win-x64 --output-root dist/purpose-demos-portable
```

构建器支持 `--profile event-desk|modular-assistant|digital-world|all`。默认输出 `dist/purpose-demos`；名称为 `world-hub-<版本>-<场景>-source` 或 `world-hub-<版本>-<场景>-win-x64`，同时生成 ZIP、`.zip.sha256` 与 `.build.json`。已有目标会失败，不覆盖旧包；生成物不提交源码 Git。

完整解压到新的可写目录后：

1. 运行 `verify.cmd`，检查 manifest 与文件 SHA-256。
2. 运行 `check.cmd`，检查环境与演示文件。
3. 运行 `start.cmd`，打开对应场景；终端保持运行，Ctrl+C 停止。

便携包优先使用包内 Node。`demo-profile.json` 固定该包的场景；模块源码随包提供。仅 `data/**` 可变，编辑源码、UI 或配置会产生完整性差异；分享修改版应从源码重新构建。manifest 是文件完整性检查，不是发布者签名。

项目源码采用 [MIT 许可](../../LICENSE)。便携包中的 Node.js 保留自己的许可证；接入的外部程序和 harness 按各自许可使用。

## 验证与适用边界

```powershell
npm run test:demos
```

测试需依据独立程序经 Hub 的真实请求、注入、回应、登记主题及成果。浏览器操作、源码链路测试和实际 ZIP 解压后的验收分别记录；`--check`、manifest 通过或压缩成功不能替代运行验收。

Hub 负责接纳、寻址、留存和传递信息。提供者选择、上下文顺序、执行器调用、事件汇总、世界时钟、NPC 和多轮业务流程由外部程序负责。这里的预置演练不代表任意第三方程序无需适配即可接入，也不提供成品智能系统、完整世界引擎或无限容量保证。权限、资源、跨机器与长期运行应按实际部署验证，参见[现行规格](../specs/index.md)和[验证范围](../verification.md)。
