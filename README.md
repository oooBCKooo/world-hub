# 世界枢纽 · World Hub

世界枢纽是外部程序经双向 mod 桥接入的通讯十字路口。它只约定信息如何进入、寻址、留存及抽取。程序形态、信息种类、上下文组合、harness执行和工作流业务由外部程序决定。

程序可以连接多座桥，一座桥也可以双向通讯。主题由mod动态声明或发布／订阅隐式登记，不内置业务通道或kind穷举。没有消费者时也可接纳信息，后来者按游标抽取；读取、ACK、回应、断连与重启都不替提供者释放。

## 启动

需要 Node.js 22.4+，已验证的便携运行时为22.23.2。Hub与浏览器管理界面只使用Node内置模块，无需安装npm依赖：

```powershell
npm run check
npm start
```

打开启动器给出的 `/manage` 地址（默认本机8790端口）。“通讯工作台”使用界面自己的真实mod，可以发布、订阅、请求／回应、注入、传输附件及手动ACK；“接入管理”控制通讯主体或连接、编辑程序／桥注记。注记不作为身份、寻址或权限。

默认配置在 [config/hub.json](config/hub.json)，仅监听127.0.0.1，未登记身份被拒绝。`ui.manual`是本机参考credential，无token时显示未认证。正式接线请复制配置，按自己的程序身份和主题配置权限：

```powershell
node scripts/launcher.mjs --config config/local.json --port 8791
```

停止时在所属终端按Ctrl+C并等待退出。默认持久数据写入忽略的 `data/`；完整迁移须连同自己的接线配置、日志、对象和管理状态一起保留。并行实例不可共享同一份数据或程序游标文件。

## 接入、验证与构建

- [接入材料](docs/onboarding.md)：JavaScript、浏览器、Python、PowerShell及裸线协议；SDK在 `sdk/`。
- [现行规格与说明索引](docs/README.md)：通讯边界、定向信息、附件、留存、部署及工作台。
- [开发与测试](docs/development.md)：`npm test`只要求Node；真实DSH与跨语言验收分别显式运行，不以跳过冒充通过。
- [构建与分发](docs/releases.md)：生成新的源码包或Windows x64便携包，构建输出写 `dist/`，不覆盖部署目录。

`examples/`是独立外部验证程序，说明双向、多来源、多桥及多轮工作流玩法，不由Hub加载或替它们安排业务。默认启动只启动Hub与管理界面。

## 仓库结构

```text
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

当前验证范围及开放边界见[验证说明](docs/verification.md)。消息追加没有每帧fsync；本机管理面属于同一信任域。不要把已有测试扩大为断电耐久、任意第三方桥、所有平台或生产业务资格。代码尚未授予开源许可证。
