# 世界枢纽 · World Hub

[中文](README.md) | [English](README.en.md)

**互联万物，自由组合，解耦整体，软化硬码，拔插一切，任意流线，无限模块。**

例如：编辑器提供当前文件，聊天程序提供用户对话，资料程序提供知识，执行器调用模型和工具，另一个程序负责界面。每个程序通过自己的双向 mod 桥与枢纽通讯，组合程序按自己的规则选择来源、发起调用、合并成果。

```text
外部程序 ↔ 自己的 mod 桥 ↔ 世界枢纽 ↔ 另一座 mod 桥 ↔ 其他程序
```

世界枢纽提供这些程序共用的通讯十字路口：接纳、寻址、留存和转交信息。各程序继续拥有自己的业务、状态和实现方式。

## 从统一入口开始

```powershell
npm install -g world-hub
world-hub ui --open
```

统一界面默认进入“我的整合包”：检查本机整合包目录和所需环境，导入独立实例，审阅程序内容与声明权限后启动。在实例详情中查看进程、健康、就绪、真实桥连接和日志，进入该实例的 Hub 拓扑或通讯工作台；也可以停止、重新审阅并重启、导出包源码与锁文件。中文／英文可切换。程序状态留在实例目录，导出包不包含运行数据。

首次体验可克隆仓库，安装[跨语言文字台](examples/ecosystem-pack/README.md)指定的 Node、Python 和 websockets，执行 `npm run ui -- --open`，然后导入 `examples/ecosystem-pack`。三个真实程序完成“JavaScript 来源 → Python 统计 → JavaScript 界面”的调用；npm 安装不附带演示程序，可导入自己的包或下载[源码整合包](docs/releases.md)。

实例还可查看分组存储、创建私有备份、恢复到新实例，以及保留数据卸载／重新关联软件。创作工作台显示真实组件和能力连线，支持公开配置修改、兼容模块替换、生成新锁与派生包；旧环境锁可经审阅复制到新目录重建。可选软件源分别发现 Pack／Module／Template，并按公开合同元数据、平台和许可筛选，校验后获取到本机缓存；模板填写参数后生成新 Pack。创作者可生成可分享的索引与制品，交换纯文本评论及带版本冲突检查的协作提案。这些动作都不自动启动第三方程序。

Launcher 是可选的本机部署与导航工具，调用外部 Runtime。Hub Core 继续只负责通讯；独立程序、原有 `world-hub --open` 和无界面部署仍可单独使用。界面可发现已安装解释器；经用户审阅后，有限方案可为锁定的 Python 依赖准备独立环境，其余环境由用户准备。声明权限和 Python venv 都不是操作系统沙箱。软件源无需在线才可运行本地实例，生成发布目录也不代表已上传社区。详见[统一入口指南](docs/ecosystem/launcher.md)。

![统一入口：实际运行的跨语言整合包及其独立程序](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-launcher.jpg?v=0.16.1)

## 编写并交付独立模块

```powershell
world-hub-pack init-module ./my-statistics --id author.statistics --runtime node
world-hub-pack validate-module ./my-statistics
world-hub-pack doctor-module ./my-statistics
node --test ./my-statistics/logic.test.mjs
```

也可选择 `--runtime python`。工具生成可选 Runtime 的文字统计作者样板，包含独立程序、完整桥 SDK、许可、业务合同和自测；不安装或执行生成代码。按[模块作者指南](docs/ecosystem/developer.md)发布开放索引，再发现、下载、预检替换并重新审阅启动。模块结构与业务由作者选择，Hub 不规定必须使用这些样板。

软件源可持久启用、禁用和排序；相同对象身份不同摘要会明确提示冲突。创作工作台可查看实际候选的合同、桥、权限和平台差异。声明兼容仍须用真实消费者验证业务结果。完整能力与验证边界见[第十七期](docs/ecosystem/phase17.md)。

Creator 的引导表单可选择组件和候选模块，无需编辑 JSON 就能预览声明／环境差异、派生新目录，再导入并重新审阅执行。自己的 `text.statistics@1.0.0` 提供者可用 `world-hub-interop verify --config private-wiring.json --report new-report.json` 检查；[公开基准](docs/ecosystem/interop.md)分开声明、桥行为和业务结果，仓库 `npm run test:interop` 可重跑 JS／Python 参考链路。[候选试用](docs/ecosystem/upgrade.md)保留旧实例和私有备份，另建新实例供审阅启动、验证成果后自行切换。[第十八期](docs/ecosystem/phase18.md)明确自动验收、真人待办及签名接口设计的范围。

## 可选托管社区

[World Hub Workshop](https://peros.cn/workshop/) 提供公开的 Pack／Module 目录和下载。受邀开发者可以发布不可变版本、发表评论，并提交绑定原版摘要的改进提案；作者检查后发布新版本。将 `https://peros.cn/workshop/index.json` 加到 Launcher 的“软件源”，即可校验、缓存，再按本机审阅流程导入与启动。

Workshop 是独立的外部服务，上传的程序不会在社区服务器运行。社区登录不授予本机执行权限；已有本地实例可以离线使用。当前采用邀请注册和单服务器配置，运行方法、容量限制及迁移见[Workshop 指南](docs/ecosystem/workshop.md)。

## 可以组合出什么

| 你想构造的系统 | 拆成哪些外部程序 | 经枢纽怎样协作 |
| --- | --- | --- |
| 多来源数据面板 | 传感器、应用事件、业务系统、汇总、界面 | 多个来源进入同一面板，界面再向来源返回控制信息 |
| 模块化智能工作台 | 系统提示、对话、知识库、上下文组装、模型／harness、工具、界面 | 从不同来源抽取上下文，交给执行器，返回成果；来源和执行器可分别替换 |
| 动态数字世界 | 世界状态、规则、NPC、导演、显示 | 每轮由导演请求多个程序，规则计算结果写回状态，再进入下一轮 |
| 多程序工作流 | 数据获取、分析、校验、产出、工作流控制程序 | 每轮访问一个或多个程序，合并结果并安排下一轮，最后返回成果 |

这些是组合方向。模型推理、工具执行、世界规则和工作流安排由外部程序实现；枢纽提供它们之间共用的通讯方式。

## 先用四套演示亲手试

四套演示都启动真实独立程序，通过真实 mod 桥交换信息。界面展示数据、上下文、世界轮次和能力目录；原始 JSON 与通讯回执可以展开查看。

| 演示 | 亲手操作 | 应该看到的结果 |
| --- | --- | --- |
| 多源事件台 `event-desk` | 启用预置交通来源；调整环境采样参数 | 同一面板从两个来源增加到三个；传感器控制桥收到设置，采样桥继续发布变化后的读数 |
| 分布上下文助手 `modular-assistant` | 加入独立扩展材料；切换独立清单执行器 | 新材料进入组装上下文；执行器身份和成果形式改变，沿用同一通讯合同 |
| 外部数字世界 `digital-world` | 推进三轮世界；运行休整回合 | 起始状态、每轮行动与最终状态可对照；NPC、规则和状态程序各自返回步骤回执 |
| 能力发现与模块替换 `capability-directory` | 查目录，只改组装配置把统计实现 A 换为 B；再尝试错版本、拒绝授权与慢响应 | 来源与输出源码不变，两套独立实现遵守相同公开合同；明确区分通讯接纳、业务失败与结果未知 |

多源事件台的实际运行：新增交通读数与环境、行情并列；界面向环境程序回传参数后，读数按新参数继续产生。

![中文界面：实际三源事件面板与来源程序返回的控制参数](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-event-desk.jpg?v=0.16.1)

<details>
<summary>查看四源上下文与独立执行器的实际成果</summary>

![中文界面：四个程序提供上下文，独立清单执行器返回成果和真实来源回执](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-modular-assistant.jpg?v=0.16.1)

</details>

<details>
<summary>查看外部数字世界的三轮变化</summary>

![中文界面：独立导演调用 NPC、规则和状态程序，返回起始状态、三轮行动和最终状态](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-digital-world.jpg?v=0.16.1)

</details>

<details>
<summary>查看外部能力目录与配置替换后的真实链路</summary>

![中文界面：独立目录公布两套统计能力，组装程序改配置选用 B，返回相同合同的统计成果和四步真实回执](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-capability-directory.jpg?v=0.16.1)

</details>

需要 Node.js 22.4+。从源码运行，每次只选择一个演示：

```powershell
git clone https://github.com/oooBCKooo/world-hub.git
cd world-hub
npm run demo:events-explorer
# 或 npm run demo:assistant-explorer
# 或 npm run demo:world-explorer
# 或 npm run demo:capabilities-explorer
```

演示使用本地事件、简化世界和确定性执行器，无需模型账号。助手演示展示上下文组合和执行器替换，不调用真实模型。能力演示提供极小的可选[能力契约与目录](docs/examples/capability-directory.md)：两处理器只依赖 SDK 和公开合同，各自独立实现；目录与组装器都是外部程序。预置演示与隔离接入测试不等于已经通过任意第三方开发者的互操作验收；自己的程序仍需实现桥并约定应用合同。

要从零开发遵守同一合同的可替换模块，请阅读[提供者接入契约](docs/modules/provider-contract.md)和[JavaScript SDK](sdk/javascript/README.md)。接入契约完整说明业务格式、能力登记与发现、身份绑定、租约和结果校验；[机器契约](docs/modules/text-statistics.contract.json)随 npm、Hub 整合包和用途演示包提供。部署方提供 endpoint、独立身份凭据与主题权限，再配置外部目录和组装器；枢纽无需增加业务种类。

也可构建独立源码包或 Windows 便携整合包。逐步操作、源码修改入口和构建方法见[用途演示指南](docs/examples/purpose-demos.md)。npm 包包含枢纽、管理界面、SDK、可选外部 Runtime 和文档；用途演示从源码仓库或演示整合包运行。

## 设计理念

**互联，自由，解耦，软化，拔插，任意，无限。**

| 理念 | 在世界枢纽中的含义 |
| --- | --- |
| 互联 | 不同程序通过双向 mod 桥交换信息与调用能力 |
| 自由 | 用户与外部程序按通讯合同自由搭配模块与能力，自行决定组合关系和用途 |
| 解耦 | 程序独立管理业务、状态和实现，按通讯合同组合与替换 |
| 软化 | 将程序间固定的接线与通讯约定，转为可配置、可替换、可扩展的桥与合同 |
| 拔插 | 程序与 mod 桥可按通讯合同接入、断开与替换，组合方决定接线和用途 |
| 任意 | 由程序选择信息来源、主题与流向，组合双向、多对多和多轮信息流 |
| 无限 | 不预先穷举业务模块、信息种类与组合用途，为新的接入方式留出扩展空间 |

## 为什么这些组合可以扩展

- **来源由程序提供**：系统提示、对话、文档、事件、状态可以分别来自不同程序，按用途组合。
- **主题由 mod 声明**：新增业务主题和载荷种类无需修改枢纽。双方自行约定信息含义。
- **程序与桥支持多对多**：一个程序可连接多座桥，一座桥也可适配多个程序；桥可发送、接收或双向通讯。
- **信息可等待后来者**：没有消费者也可发布，其他程序后来按主题和游标抽取；提供者决定何时允许回收。
- **多轮由外部程序安排**：A 经枢纽调用 B，B 再调用 C；工作流程序也可每轮请求多个程序，再合并成果。

“软化硬码”面向程序间的连接与通讯组合，业务代码和规则仍由各程序实现。“无限模块”指业务模块与用途不预先穷举；每次部署仍受身份授权、通讯合同、连接数、存储和吞吐限制。读取、ACK、回应、断连都不会替提供者释放信息。

## 枢纽管理界面

运行 `world-hub --open` 打开通讯管理界面。用途演示另有自己的外部界面，可以从中进入本次会话的枢纽管理。

管理画布、通讯工作台和四套用途演示均支持简体中文／English 切换，并在浏览器中记住选择。切换仅改变界面文案与显示格式，用户提供的名称、注记、主题、业务内容和原始通讯记录保留原文。

![中文界面：枢纽管理画布中的程序、双向 mod 桥、枢纽与真实信息流](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-topology.jpg?v=0.16.1)

管理画布显示程序、桥、枢纽和信息流，支持接入通断与关联注记。程序注记不代表外部程序的真实执行状态。

<details>
<summary>查看双向 mod 通讯工作台</summary>

![中文界面：通讯工作台的动态主题、原文信息与真实收发记录](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-workbench.jpg?v=0.16.1)

工作台通过自己的 mod 发布、订阅与抽取信息，也可请求／回应、注入、声明通道和传输附件。图中是一次实际发布及枢纽接纳回执。

</details>

## 启动

需要 Node.js 22.4+。Hub与浏览器管理界面只使用Node内置模块，没有第三方运行依赖。通过 npm 安装并启动：

```powershell
npm install -g world-hub
world-hub --check
world-hub --open
```

首次启动会在当前工作目录的 `world-hub-data/` 建立可编辑配置和持久数据；`--check` 只检查，不建立文件。可以使用 `--config ./hub.json` 选择自己的接线配置，或 `--data-dir ./my-hub-data` 指定数据目录。完整说明见 [npm 安装与使用](https://github.com/oooBCKooo/world-hub/blob/main/docs/npm.md)。

从 GitHub 克隆源码后，也可以使用：

```powershell
npm run check
npm start
```

打开启动器给出的 `/manage` 地址（默认本机8790端口）。“通讯工作台”使用界面自己的真实mod，可以发布、订阅、请求／回应、注入、传输附件及手动ACK；“接入管理”控制通讯主体或连接、编辑程序／桥注记。注记不作为身份、寻址或权限。

参考配置在 [config/hub.json](config/hub.json)，仅监听127.0.0.1，未登记身份被拒绝。`ui.manual`是本机参考credential，无token时显示未认证。正式接线请编辑 npm 首次启动生成的配置，或在源码副本中复制参考配置，按自己的程序身份和主题配置权限：

```powershell
node scripts/launcher.mjs --config config/local.json --port 8791
```

停止时在所属终端按Ctrl+C并等待退出。npm 启动默认持久数据在当前目录的 `world-hub-data/`，源码启动默认在 `data/`，都不进入 Git。完整迁移须连同自己的接线配置、日志、对象和管理状态一起保留。并行实例不可共享同一份数据或程序游标文件。

## 接入、验证与构建

- [接入材料](docs/onboarding.md)：JavaScript、浏览器、Python、PowerShell及裸线协议；SDK在 `sdk/`。
- [现行规格与说明索引](docs/README.md)：通讯边界、定向信息、附件、留存、部署及工作台。
- [开发与测试](docs/development.md)：`npm test`只要求Node；真实DSH与跨语言集成检查可按需要单独运行。
- [构建与分发](docs/releases.md)：生成新的源码包或Windows x64便携包，构建输出写 `dist/`，不覆盖部署目录。

`examples/`提供独立程序示例，展示双向、多来源、多桥及多轮工作流用法。示例通过自己的桥接入，业务由各程序实现。默认启动只启动Hub与管理界面。

npm 包包含 Hub、管理界面、三个语言的 SDK、参考配置、文档与可选的外部 `world-hub-pack` 部署工具；源码示例、测试和整合包构建工具在 GitHub 仓库中，不随 npm 安装。若要运行用途演示或源码测试，请先克隆仓库。

## 把独立程序部署成整合包

可选的 `world-hub-pack` 把一组已审阅的本地程序包导入为独立实例，统一启动、观察健康、停止、重启和导出。一个模块可携带多座 mod 桥；`module.json` 描述程序部署，`pack.json` 描述组合，`pack.lock` 锁定文件、版本、平台和预安装环境。它们是[开放的外部部署声明](docs/ecosystem/pack-spec.md)，不改变普通 Hub 程序的通讯形态。

```powershell
$review = world-hub-pack plan ./my-pack | ConvertFrom-Json
world-hub-pack import ./my-pack --root ./pack-runtime --instance one
world-hub-pack start --root ./pack-runtime --instance one --trust $review.digest
```

先检查 `plan` 的内容、依赖和权限声明，再使用实际摘要启动。每实例有自己的 Hub、端口、凭据和程序状态；进程、自报健康与真实桥连接分别显示。[跨语言文本台包](examples/ecosystem-pack/README.md)提供三个真实程序：JavaScript 原文来源、Python 统计、JavaScript 浏览器界面；界面经 Hub 请求来源和统计并自己保存成果，支持中文与 English。样例锁要求预安装 Node 22.23.2、Python 3.14.0 与 websockets 15.0.1。

Runtime 是独立部署层，Hub 继续只做通讯十字路口。每个实例有独立 Hub；默认 trusted-local 权限是声明，可另选有限 Node 容器隔离。业务重试仍由程序决定。Launcher 可经用户明确审阅，按有限固定方案准备支持的 Python 依赖，并提供静态软件源与本地创作协作；它不托管在线社区。完整 CLI／公开 API、锁更新及数据边界见[外部 Runtime](docs/ecosystem/runtime.md)。

## 仓库结构

```text
bin/                  npm 命令行入口
src/hub/              通讯核心与WebSocket入口
src/management/       本机管理HTTP和浏览器工作台
src/debug/            只读调试页
sdk/                  JavaScript、Python、PowerShell桥
config/               可移植默认接线配置
docs/specs/           现行通讯规格
examples/             独立程序示例与用途演示
tests/                通讯回归、集成测试和夹具
scripts/              启动、验证、构建与分发工具
tools/launcher/       可选整合包管理后台与统一浏览器入口
.github/workflows/    Windows持续集成
```

各目录的组件职责、SDK 使用方式与分发内容见[仓库结构](docs/repository.md)。

支持环境、测试范围与已知限制见[验证说明](docs/verification.md)。部署时请注意：消息追加不保证断电耐久，本机管理接口面向同一信任域；配置与容量说明见[部署文档](docs/deployment.md)。

本项目采用 [MIT 许可证](LICENSE)。便携包附带的 Node.js 运行时保留其自己的许可证；外部程序和 harness 按各自许可使用。

共享组合还可以制作成[参数化模板](docs/ecosystem/templates.md)，填写公开参数后生成新的锁定包；已停止实例可[升级与完整数据回滚](docs/ecosystem/upgrade.md)，数据策略由各程序作者决定。可选[Node 无界面容器隔离](docs/ecosystem/isolation.md)具有固定文件、网络、子进程与资源限制，需自行准备 Linux Docker 与摘要镜像；其他程序继续按所选部署方式接入。
