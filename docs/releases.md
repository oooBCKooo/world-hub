# 构建、分发与迁移

当前分发以一个全局 Hub、模块实例和模块组为产品入口。Hub、通信管理界面、SDK 和本机模块管理辅助层按明确允许清单构建。独立 Launcher 界面、整合包 Runtime、模板生成、旧专用界面与历史阶段资料不进入当前发行。

## 0.21.0

- 提供可单独安装的官方 `world-hub` Skill，包含安装诊断、普通枢纽桥通信、模块开发与 MCP 使用参考。使用 `world-hub-skill --install <新目录>` 复制，不覆盖已有技能目录。
- 提供独立 stdio MCP 服务 `world-hub-mcp`，通过自己的认证枢纽桥进行发布、历史抽取、ACK、定向请求／回应、注入与附件传输。仅支持 MCP 2026-07-28，不加载到 Hub Core。
- MCP 私有配置限定工具、精确主题与目标主体，Hub ACL 继续独立执行。历史缺口、缓冲上限、断线和超时明确返回；不会自动重发业务请求、释放历史信息或跳过缺失历史。
- MCP 依赖使用单独锁文件，显式执行 `world-hub-mcp --prepare` 后才安装；Hub 根包、SDK 和 Skill 不需要这些依赖。安装不运行依赖生命周期脚本。
- 修复本机按需运行辅助层的竞态：旧进程空闲停止期间到达的新调用不再被误当作手动取消；手动停止仍会取消对应的排队激活。

安装与配置见[智能体接入](ecosystem/agents.md)／[Agent integration](ecosystem/agents.en.md)。源码测试使用官方 MCP 客户端和真实隔离 Hub，不代表所有客户端或真人独立开发已经验收。

## 0.20.0

- 在同一个 `/manage` 通信管理界面管理独立模块与模块组、接线、启动计划、运行状态和信息流；不再提供独立 Launcher、整合包或模板入口。
- 工坊按模块与模块组展示发行版本、图标与预览图。已安装实例支持经审阅的升级、降级和回退，保留或重置私有数据需明确选择。
- 模块和模块组可携带作者默认接线；导入核对本机提供者，缺失或存在多个候选时要求补齐或选择。接线模式可审阅并恢复默认接线。
- 支持单实例与整组卸载审阅，标明共享成员和消费者依赖；当前卸载注销实例，不删除源码和私有数据。
- 支持常驻与按需运行、允许唤醒的调用者及空闲停止。作者可用 `deployment.json` 的 `executionDefaults` 提供模式与空闲时间建议；本机授权不随制品发布。
- 补齐通信管理界面的英文文案和语言切换，保留自定义名称、主题与消息原文。

Hub 仍只负责通信。运行辅助通过普通枢纽桥管理本机受管程序，不把业务调度或运行策略加入 Hub Core。真人独立开发、新手使用和实际浏览器验收的状态见[验证范围](verification.md)，不因发行构建通过而视为完成。

## npm 与 ZIP

npm 提供 `world-hub`、`world-hub-interop`、独立 `world-hub-workshop`、`world-hub-skill` 和 `world-hub-mcp` 命令。SDK 保留 `world-hub`／`world-hub/bridge`、`world-hub/blob` 和 `world-hub/lifecycle` 导出；社区保留 `world-hub/workshop`。不公开旧 `world-hub/runtime`，不安装 `world-hub-pack`。

源码 ZIP 使用本机 Node 22.4.0 或以上。Windows x64 便携 ZIP 携带已核对的官方 Node 22.23.2 与独立许可。业务模块和其依赖另行取得，不自动执行。

```powershell
npm run build
node scripts/release/verify-package.mjs --root dist/world-hub-0.21.0-source
```

目标目录、ZIP 或校验文件已存在时拒绝覆盖。需要便携运行时：

```powershell
node scripts/release/prepare-runtime.mjs --download --output .artifacts/runtime/node-win-x64
npm run build -- --runtime .artifacts/runtime/node-win-x64
```

缓存必须是新目录，只有匹配固定版本官方摘要后才复制运行文件。默认目录及 ZIP 名称使用 `package.json` 的版本：本版为 `world-hub-0.21.0-source.zip` 和 `world-hub-0.21.0-win-x64.zip`，每份 ZIP 附 `.zip.sha256` 校验文件。构建不意味着所有平台已经验收。

## 运行入口

完整解压到可写目录，用 `ui.cmd` 打开通信管理界面，或运行 `node bin/world-hub.mjs --open`。这两种入口默认把配置与数据放在当前工作目录的 `world-hub-data`。`start.cmd` 则使用发行目录中的 `config/hub.json` 参考配置启动相同通信服务并打开管理界面；使用自己的配置可显式传入 `--config`。不要以不同入口同时占用同一监听端口或数据目录。

`verify.cmd` 检查原始文件；修改配置后可用 `--allow-config-change`，仅允许配置内容变化，不忽略损坏的代码或运行时。SHA-256 清单用于发现损坏，不替代发布者身份验证。

## 私有数据与升级

安装目录、模块制品版本、本机实例配置修订、Hub 发行版本分别管理。升级程序前先停止所属进程，把新发行解压到新目录，保留自己的 Hub 配置、模块管理数据、身份和完整通信数据。不要覆盖正在运行的安装目录。

取消整合包和模板不自动迁移、删除或执行旧实例。保留旧私人数据供自己核对；要重用其中程序，取得当前独立模块再登记到同一个全局 Hub。不通过兼容旧入口重新启动它们。

读取、ACK、停止和升级不替提供者释放消息。程序自己的业务游标和状态由程序管理。完整数据迁移还包括 Hub 日志、对象和管理状态，见[部署](deployment.md)。

## 验证与许可

`npm run test:distribution` 验证当前文件清单、源码包入口和损坏检测。`npm run test:npm` 在隔离前缀里安装实际 tarball，核对 CLI、SDK 与发行内容；不会发布 npm。

构建产物的 manifest 记录路径、大小、SHA-256、文件角色与运行时来源。生成 ZIP、校验与测试报告不是源码文件。项目采用 [MIT](../LICENSE)，第三方运行时保留自己的许可。测试结果只适用于实际执行的场景，见[验证说明](verification.md)。
