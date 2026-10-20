# 开发

从仓库根目录执行命令。Hub、管理界面与 Node 桥使用 Node.js 22.4.0 或以上；本项目固定分发运行时为 22.23.2。Hub 没有 npm 运行依赖。

全局 npm 安装提供 `world-hub` CLI、通信管理界面与三个语言 SDK，不带这里的测试和业务示例。JavaScript SDK 使用 npm 命名导出，Python 和 PowerShell SDK 按文件路径使用并自行准备运行环境。需要修改代码、运行完整回归或构建当前分发时，克隆 [GitHub 源码仓库](https://github.com/oooBCKooo/world-hub)；CLI 与 SDK 用法见[npm 包](npm.md)。源码采用 [MIT 许可](../LICENSE)，分发时保留许可文本。

```powershell
npm run check
npm start
```

`npm start` 使用部署启动器和 `config/hub.json`，提供 `/manage` 并持有数据目录启动锁。手动打开启动输出的管理地址；`npm start -- --open` 可显式打开浏览器。Ctrl+C 正常停止。只开发原服务时可使用 `npm run hub`；该入口直接启动服务，不提供包级重复启动锁。

管理工作台是普通浏览器枢纽桥。管理 API 只处理本机接入与观察；修改数据面功能必须同时维护其协议实现、桥行为与回归，不把管理 API 变成代发业务消息的捷径。

当前模块管理直接位于 Hub 的 `/manage` 页面。源码也可使用 npm CLI 入口，选择数据目录并打开界面：

```powershell
node bin/world-hub.mjs --open
node bin/world-hub.mjs --data-dir .artifacts/my-hub --port 0 --open
npm run test:launcher
```

选择一个启动命令，使用终端输出的本机管理地址。管理器以独立进程运行受管模块；审阅和启动都重新校验当前代码与所选环境。修改界面或控制接口时，维护当前审阅的明确授权、精确实例／运行／桥会话归属、停止的实际进程退出确认、文本渲染和同源管理边界。测试覆盖由服务驱动的真实跨语言交互及异常、安全场景；浏览器外观检查与 API 回归是不同证据。[通信管理指南](ecosystem/launcher.md)说明界面职责。

界面入口为 `src/management/console.html` 与 `canvas-modes.mjs`，模块管理由 `management-modules.mjs` 提供。独立 Launcher 页面、服务、整包生成与每包 Runtime 不进入当前发行。`tools/launcher/` 和 `scripts/runtime/` 中实际被管理界面依赖的校验、路径、来源和进程辅助继续分发；保留的内部目录名不代表另有独立应用或公开旧整包 API。审阅必须绑定精确内容和配置修订，不能静默执行第三方程序。

```powershell
npm test
npm run demo:management
npm run demo:events
npm run demo:directed
npm run demo:workflow
```

演示分别拥有隔离的 Hub 与外部程序，不连接或修改正式部署的数据。示例程序有自己的业务约定，不能把约定提升为 Hub 内置主题、信息类或执行器。DSH 和跨语言验证是显式可选运行环境，配置和命令见[验证](verification.md)。

增加通用通讯能力时，先确定[职责边界](specs/boundaries.md)，保持正文原始 JSON、身份与主题授权、每订阅 ACK、提供者保护和明确容量失败。新增特性需协商；不能给旧 `publish` 塞进目标字段后假定旧 Hub 会定向路由。规范、实际实现和测试证据分别更新。

Hub 自己的诊断字段登记在 `tests/conformance/diagnostic-contract.mjs`，新增字段需登记用途、值规则和对应行为测试。登记不限制业务正文、枢纽桥主题或外部程序形态，也不能替代职责审查。

模块声明见[模块格式](ecosystem/modules.md)，本机实例和分组指南见[通信管理](ecosystem/launcher.md)。通信管理回归包括 `tests/conformance/management-*.test.mjs`；`npm run test:launcher` 运行单 Hub 管理辅助的集成场景。旧 pack/template 路由测试仅为历史源码资料，不继续定义产品要求。模块替换须验证真实消费者行为，声明匹配不能替代业务兼容验收。

测试证据写入 `.artifacts/`，构建默认写入 `dist/` 或调用者指定的新目录，运行数据由配置决定。不要提交生成文件、私人 home、模型配置、凭据、下载的运行时或旧历史包。发布流程见[分发](releases.md)。
