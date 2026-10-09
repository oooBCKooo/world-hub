# 开发

从仓库根目录执行命令。Hub、管理界面与 Node 桥使用 Node.js 22.4.0 或以上；本项目固定分发运行时为 22.23.2。Hub 没有 npm 运行依赖。

全局 npm 安装提供 `world-hub` CLI、可选外部 `world-hub-pack` Runtime 与三个语言 SDK，不带这里的测试和业务示例。JavaScript SDK 使用 npm 命名导出，Python 和 PowerShell SDK 按文件路径使用并自行准备运行环境。需要修改代码、运行完整回归或构建用途整合包时，克隆 [GitHub 源码仓库](https://github.com/oooBCKooo/world-hub)；CLI 与 SDK 用法见[npm 包](npm.md)。源码采用 [MIT 许可](../LICENSE)，分发时保留许可文本。

```powershell
npm run check
npm start
```

`npm start` 使用部署启动器和 `config/hub.json`，提供 `/manage` 并持有数据目录启动锁。手动打开启动输出的管理地址；`npm start -- --open` 可显式打开浏览器。Ctrl+C 正常停止。只开发原服务时可使用 `npm run hub`；该入口直接启动服务，不提供包级重复启动锁。

管理工作台是普通浏览器 mod。管理 API 只处理本机接入与观察；修改数据面功能必须同时维护其协议实现、桥行为与回归，不把管理 API 变成代发业务消息的捷径。

统一 Launcher 是 `tools/launcher/` 中的可选外部工具，复用 `scripts/runtime/` 与现有 Hub 管理页面。源码启动如下，`npm start` 仍按原方式启动 Hub：

```powershell
node bin/world-hub.mjs ui --open
node bin/world-hub.mjs ui --root .artifacts/my-launcher --port 0 --open
npm run test:launcher
```

选择一个启动命令，使用终端输出的一次性浏览器授权入口。Launcher 不导入业务模块到服务进程；审阅和启动都重新校验当前代码与所选环境。修改界面或控制接口时，维护当前审阅的明确授权、精确实例／运行／桥会话归属、停止的实际进程退出确认、文本渲染和同源管理边界。测试覆盖由服务驱动的真实跨语言交互及异常、安全场景；浏览器外观检查与 API 回归是不同证据。[Launcher 流程与接口](ecosystem/launcher.md)说明界面职责。

```powershell
npm test
npm run demo:management
npm run demo:events
npm run demo:directed
npm run demo:workflow
```

演示分别拥有隔离的 Hub 与外部程序，不连接或修改正式部署的数据。示例程序有自己的业务约定，不能把约定提升为 Hub 内置主题、信息类或执行器。DSH 和跨语言验证是显式可选运行环境，配置和命令见[验证](verification.md)。

增加通用通讯能力时，先确定[职责边界](specs/boundaries.md)，保持正文原始 JSON、身份与主题授权、每订阅 ACK、提供者保护和明确容量失败。新增特性需协商；不能给旧 `publish` 塞进目标字段后假定旧 Hub 会定向路由。规范、实际实现和测试证据分别更新。

Hub 自己的诊断字段登记在 `tests/conformance/diagnostic-contract.mjs`，新增字段需登记用途、值规则和对应行为测试。登记不限制业务正文、mod 主题或外部程序形态，也不能替代职责审查。

可选外部部署工具在 `scripts/runtime/`，CLI 在 `bin/world-hub-pack.mjs`，开放部署规范与 JSON Schema 在 `docs/ecosystem/`。修改它不会给 Hub 增加模块加载、业务调度或社区功能。[跨语言文本台](../examples/ecosystem-pack/README.md)的三个模块各自携带桥，业务源码不从 Runtime 导入。

```powershell
node bin/world-hub-pack.mjs plan examples/ecosystem-pack
npm run test:ecosystem
node scripts/release/build-ecosystem-package.mjs --output dist/ecosystem-source
```

该样例锁要求 Node 22.23.2、Python 3.14.0、websockets 15.0.1。测试可通过 `WORLD_HUB_RUNTIME_TEST_PYTHON` 选择预安装的 Python 可执行文件；运行工具用 `--node`／`--python` 明确选择解释器。锁生成是作者的显式动作，修改源码／接线或选择新环境后使用 `world-hub-pack lock`，再检查新的审阅摘要。不要通过重锁跳过未知文件、依赖或权限变化。开放声明、应用合同和 Hub 通讯契约分别维护；普通桥接程序不必使用这个部署 profile。

测试证据写入 `.artifacts/`，构建默认写入 `dist/` 或调用者指定的新目录，运行数据由配置决定。不要提交生成文件、私人 home、模型配置、凭据、下载的运行时或旧历史包。发布流程见[分发](releases.md)。
