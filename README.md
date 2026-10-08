# 世界枢纽 · World Hub

世界枢纽是外部程序经双向 mod 桥接入的通讯十字路口。它只约定信息如何进入、寻址、留存及抽取。程序形态、信息种类、上下文组合、harness执行和工作流业务由外部程序决定。

程序可以连接多座桥，一座桥也可以双向通讯。主题由mod动态声明或发布／订阅隐式登记，不内置业务通道或kind穷举。没有消费者时也可接纳信息，后来者按游标抽取；读取、ACK、回应、断连与重启都不替提供者释放。

![枢纽管理画布：程序、双向 mod 桥、枢纽与真实信息流](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-topology.jpg)

管理画布直观呈现程序、桥与枢纽的连接和信息流，支持接入通断与关联注记。上图使用独立事件程序产生真实通讯；外部程序的执行状态由其自行提供，注记不代表业务运行状态。

![通讯工作台：动态主题、原文信息与真实收发记录](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-workbench.jpg)

工作台通过自己的 mod 手动发布、订阅与抽取信息，也可请求／回应、注入、声明通道、传输附件及管理接入。截图显示一次实际发布及枢纽接纳回执。

## 可以用来做什么

把已有程序或新模块接到同一通讯层，分别维护、替换，再组合成新的用途。例如：

| 用途 | 外部程序各自负责 | 探索入口 |
| --- | --- | --- |
| 多来源数据面板与控制台 | 采集事件、显示记录、回传参数修改 | `event-desk`：多源事件台 |
| 模块化智能系统 | 提供系统提示词、对话和材料；组装上下文；执行 harness；显示结果 | `modular-assistant`：分布上下文助手 |
| 动态数字世界 | 保存世界状态、决定行动与规则、运行 NPC、呈现变化 | `digital-world`：外部数字世界 |
| 多轮、多程序工作流 | 安排每轮访问的程序、合并结果、保存成果 | [工作流示例](docs/examples/workflows.md) |

前三个用途有独立的[演示整合包与开发者指南](docs/examples/purpose-demos.md)，可从源码启动，也可构建 Windows 便携包。演示界面、状态和业务都在外部程序中；默认 `npm start` 仍只启动 Hub 与管理界面。助手演示使用确定性本地 harness，不需模型账号或 DSH；它展示上下文和结果如何流动，不提供真实模型能力。

接入程序、桥和信息种类可按合同继续扩展，实际运行仍受容量、权限和各程序实现限制。这些演示供开发者探索组合方式，不代表成品智能系统、完整数字世界或所有第三方程序均已验收。

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
