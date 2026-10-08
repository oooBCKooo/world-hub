# 世界枢纽 · World Hub

**把分散在不同程序里的信息和能力接起来，组合成可以独立替换、继续扩展的系统。**

万物互联，模块解耦，流源任意，模组无限。

例如：编辑器提供当前文件，聊天程序提供用户对话，资料程序提供知识，执行器调用模型和工具，另一个程序负责界面。每个程序通过自己的双向 mod 桥与枢纽通讯，组合程序按自己的规则选择来源、发起调用、合并成果。

```text
外部程序 ↔ 自己的 mod 桥 ↔ 世界枢纽 ↔ 另一座 mod 桥 ↔ 其他程序
```

世界枢纽提供这些程序共用的通讯十字路口：接纳、寻址、留存和转交信息。各程序继续拥有自己的业务、状态和实现方式。

## 可以组合出什么

| 你想构造的系统 | 拆成哪些外部程序 | 经枢纽怎样协作 |
| --- | --- | --- |
| 多来源数据面板 | 传感器、应用事件、业务系统、汇总、界面 | 多个来源进入同一面板，界面再向来源返回控制信息 |
| 模块化智能工作台 | 系统提示、对话、知识库、上下文组装、模型／harness、工具、界面 | 从不同来源抽取上下文，交给执行器，返回成果；来源和执行器可分别替换 |
| 动态数字世界 | 世界状态、规则、NPC、导演、显示 | 每轮由导演请求多个程序，规则计算结果写回状态，再进入下一轮 |
| 多程序工作流 | 数据获取、分析、校验、产出、工作流控制程序 | 每轮访问一个或多个程序，合并结果并安排下一轮，最后返回成果 |

这些是组合方向。模型推理、工具执行、世界规则和工作流安排由外部程序实现；枢纽提供它们之间共用的通讯方式。

## 先用三套演示亲手试

三套演示都启动真实独立程序，通过真实 mod 桥交换信息。界面会展示数据卡片、上下文来源、执行器成果和世界轮次；原始 JSON 与通讯回执可以展开查看。

| 演示 | 亲手操作 | 应该看到的结果 |
| --- | --- | --- |
| 多源事件台 `event-desk` | 启用预置交通来源；调整环境采样参数 | 同一面板从两个来源增加到三个；传感器控制桥收到设置，采样桥继续发布变化后的读数 |
| 分布上下文助手 `modular-assistant` | 加入独立扩展材料；切换独立清单执行器 | 新材料进入组装上下文；执行器身份和成果形式改变，沿用同一通讯合同 |
| 外部数字世界 `digital-world` | 推进三轮世界；运行休整回合 | 起始状态、每轮行动与最终状态可对照；NPC、规则和状态程序各自返回步骤回执 |

多源事件台的实际运行：新增交通读数与环境、行情并列；界面向环境程序回传参数后，读数按新参数继续产生。

![实际三源事件面板与来源程序返回的控制参数](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-event-desk.jpg)

<details>
<summary>查看四源上下文与独立执行器的实际成果</summary>

![四个程序提供上下文，独立清单执行器返回成果和真实来源回执](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-modular-assistant.jpg)

</details>

<details>
<summary>查看外部数字世界的三轮变化</summary>

![独立导演调用 NPC、规则和状态程序，返回起始状态、三轮行动和最终状态](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-digital-world.jpg)

</details>

需要 Node.js 22.4+。从源码运行，每次只选择一个演示：

```powershell
git clone https://github.com/oooBCKooo/world-hub.git
cd world-hub
npm run demo:events-explorer
# 或 npm run demo:assistant-explorer
# 或 npm run demo:world-explorer
```

演示使用本地事件、简化世界和确定性执行器，无需模型账号。助手演示展示上下文组合和执行器替换，不调用真实模型。三个演示里的扩展来源和替代执行器是预置的独立程序；自己的程序接入需要实现桥和约定的应用通讯格式。

也可构建独立源码包或 Windows 便携整合包。逐步操作、源码修改入口和构建方法见[用途演示指南](docs/examples/purpose-demos.md)。npm 包只包含枢纽、管理界面、SDK 和文档；用途演示从源码仓库或演示整合包运行。

## 为什么这些组合可以扩展

- **来源由程序提供**：系统提示、对话、文档、事件、状态可以分别来自不同程序，按用途组合。
- **主题由 mod 声明**：新增业务主题和载荷种类无需修改枢纽。双方自行约定信息含义。
- **程序与桥支持多对多**：一个程序可连接多座桥，一座桥也可适配多个程序；桥可发送、接收或双向通讯。
- **信息可等待后来者**：没有消费者也可发布，其他程序后来按主题和游标抽取；提供者决定何时允许回收。
- **多轮由外部程序安排**：A 经枢纽调用 B，B 再调用 C；工作流程序也可每轮请求多个程序，再合并成果。

“模组无限”指业务模组与用途不预先穷举。每次部署仍受身份授权、通讯合同、连接数、存储和吞吐限制。读取、ACK、回应、断连都不会替提供者释放信息。

## 枢纽管理界面

运行 `world-hub --open` 打开通讯管理界面。用途演示另有自己的外部界面，可以从中进入本次会话的枢纽管理。

![枢纽管理画布：程序、双向 mod 桥、枢纽与真实信息流](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-topology.jpg)

管理画布显示程序、桥、枢纽和信息流，支持接入通断与关联注记。程序注记不代表外部程序的真实执行状态。

<details>
<summary>查看双向 mod 通讯工作台</summary>

![通讯工作台：动态主题、原文信息与真实收发记录](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-workbench.jpg)

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
- [开发与测试](docs/development.md)：`npm test`只要求Node；真实DSH与跨语言验收分别显式运行，不以跳过冒充通过。
- [构建与分发](docs/releases.md)：生成新的源码包或Windows x64便携包，构建输出写 `dist/`，不覆盖部署目录。

`examples/`是独立外部验证程序，说明双向、多来源、多桥及多轮工作流玩法，不由Hub加载或替它们安排业务。默认启动只启动Hub与管理界面。

npm 包包含 Hub、管理界面、三个语言的 SDK、参考配置与文档；源码示例、测试和整合包构建工具在 GitHub 仓库中，不随 npm 安装。若要运行用途演示或源码测试，请先克隆仓库。

## 仓库结构

```text
bin/                  npm 命令行入口
src/hub/              通讯核心与WebSocket入口
src/management/       本机管理HTTP和浏览器工作台
src/debug/            只读调试页
sdk/                  JavaScript、Python、PowerShell桥
config/               可移植默认接线配置
docs/specs/           现行通讯规格
examples/             独立外部验证程序
tests/                通讯回归、集成测试和夹具
scripts/              启动、验证、构建与分发工具
.github/workflows/    可重跑的Windows CI
```

本仓库只包含最终源码、规格、示例和可重跑工具。原始反馈、归档、阶段审查及证据、历史整合包、依赖缓存和运行数据在本机保留，不进入Git。具体迁移范围见[仓库结构](docs/repository.md)。

当前验证范围及开放边界见[验证说明](docs/verification.md)。消息追加没有每帧fsync；本机管理面属于同一信任域。不要把已有测试扩大为断电耐久、任意第三方桥、所有平台或生产业务资格。

本项目采用 [MIT 许可证](LICENSE)。便携包附带的 Node.js 运行时保留其自己的许可证；外部程序和 harness 按各自许可使用。
