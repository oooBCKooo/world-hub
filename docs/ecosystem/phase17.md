# 第十七期：模块作者闭环与操作事实

本期沿用已有 Core / 外部 Runtime / 可选 Launcher / 可选 Workshop 分层。两份架构反馈提出的环境准备、实例备份恢复、协作提案和托管分发，在十六期已有有限实现；本期修复实际缺口，没有再次把它们描述为待开发能力。

| 本期交付 | 检查与证据入口 |
| --- | --- |
| Node/Python 作者样板、独立静态校验与固定探针诊断 | `developer.test.mjs`；[作者指南](developer.md) |
| 公开 CLI 生成 → 发布 → 发现 → 获取 → 替换 → 独立实例真实业务结果 | `developer-cli.test.mjs`，来源/消费者原代码保持不变 |
| 软件源后端持久登记、启停与排序；禁用拒绝旧地址绕过 | `source-management.test.mjs`，缓存和本地实例保留 |
| 相同对象身份不同摘要的内容冲突、撤回与不可用观察 | 优先级仅排列选项，不自动选择或关闭运行实例 |
| 下载来源收据贯穿导入和启动审阅 | 后端记录实际索引与制品摘要；页面不能自行提交来源授权；文件或审阅摘要变化不沿用 |
| 不执行代码的替换差异预检 | `replacement-preview.test.mjs`，与派生共用合同/槽/平台检查，列出全部受影响组件 |
| 明确未知观察、日志运行身份和审阅有效期 | Launcher 中英文页面，刷新失败后不沿用旧绿色状态；日志绑定实例和 runId |
| 使用/创作导航与从实例进入创作 | 可选外部工具，不改变 Hub 的原有入口和通信协议 |

SHA 摘要验证内容一致性；来源身份、代码安全、用户授权和 OS 强制隔离分别是不同事实。默认执行为 trusted-local；权限声明和 Python venv 不提供文件/网络/进程强制限制。可选 docker-node-headless/v1 实施有限容器 profile，单独验收并显式选择。业务状态兼容性与数据迁移由程序作者负责。

补完增加第三种分发对象 Template：独立 Schema、锁定基包、声明参数、只读预览和新 Pack 实例化；软件源与 Workshop 支持其发现与分发。已停止实例增加提供者定义策略的升级、完整私有快照、显式数据回滚与中断恢复。可选 Node 无界面容器执行使用真实 Docker 限制，不支持的形态拒绝。游戏等业务适配、大型社区运营及任意语言的隔离方式仍由外部生态演化；它们不成为 Hub 通信接入的前置条件。

已有文档隔离作者 fixture 标明 AI 来源，保留原合同互操作验收。本期生成样板链路验证开发工具与部署协作，不替代真人第三方从文档独立接入的验收，也不据此宣称任意程序或全部平台已通过。

可重跑：`npm run test:ecosystem`、`npm run test:launcher`、`npm run test:npm`。报告记录本机实际平台、运行时与零跳过结果；分发包必须从实际 tarball 安装或 ZIP 解压副本验收。测试命令或构建成功不等于全部实际验收通过。

补完检查入口：`template.test.mjs`（包含真实 Node→Python→Node 业务）、`upgrade.test.mjs`（真实迁移、崩溃与数据恢复）、`isolation.test.mjs`（不可用与静态边界）、Linux Docker 专项 `isolation-docker.test.mjs`、Launcher `completion-http.test.mjs`。CLI、公开 Runtime API 和中英文界面都暴露对应操作。

真人独立作者与新用户验收经维护者决定暂缓，明确保留待办；[公开契约与 SDK 验收资料](../independent-author-acceptance.md)已备，自动验收不替代真人结果。
