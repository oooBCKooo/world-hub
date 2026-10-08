# 开发

从仓库根目录执行命令。Hub、管理界面与 Node 桥使用 Node.js 22.4.0 或以上；本项目固定分发运行时为 22.23.2。Hub 没有 npm 运行依赖。

```powershell
npm run check
npm start
```

`npm start` 使用部署启动器和 `config/hub.json`，提供 `/manage` 并持有数据目录启动锁。手动打开启动输出的管理地址；`npm start -- --open` 可显式打开浏览器。Ctrl+C 正常停止。只开发原服务时可使用 `npm run hub`；该入口直接启动服务，不提供包级重复启动锁。

管理工作台是普通浏览器 mod。管理 API 只处理本机接入与观察；修改数据面功能必须同时维护其协议实现、桥行为与回归，不把管理 API 变成代发业务消息的捷径。

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

测试证据写入 `.artifacts/`，构建默认写入 `dist/` 或调用者指定的新目录，运行数据由配置决定。不要提交生成文件、私人 home、模型配置、凭据、下载的运行时或旧历史包。发布流程见[分发](releases.md)。
