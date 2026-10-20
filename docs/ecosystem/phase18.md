> 历史资料：已退出当前产品。整合包、模板及每包独立 Hub 的使用路径已取消；本页保留原设计和证据，不代表当前支持，也不提供旧版兼容入口。当前使用请看[单 Hub Launcher](launcher.md)。

# 第十八期：第三方生态的可复现验收与使用闭环

本期补公开证据和已有工具的闭环，不重构 Hub 通讯内核，不新增固定业务通道。Core、可选外部 Runtime、Launcher、Creator、Workshop 的责任继续分开。

| 交付 | 公开入口与验证 |
| --- | --- |
| 公开契约验证 CLI 和分层报告 | [互操作基准](interop.md)，`world-hub-interop verify`；`npm run test:interop` |
| 同一消费者的 JS／Python 配置替换 | 两位 AI 作者的公开文档接入实验；真实进程、精确业务输出、失败格式、消费者源码摘要不变 |
| 无需编辑 JSON 的组件替换 | [Creator](authoring.md)：选择组件／候选、查看兼容与差异、复检、派生新目录、导入并重新审阅 |
| 声明与环境分层预检 | 合同、桥槽、启动依赖、平台、解释器及受支持 SDK 依赖；不执行候选代码、不自动安装 |
| 社区→本地→创作迭代 | [跨角色 E2E](phase18-workshop.md)，实际 Workshop／Launcher HTTP、不可覆盖版本、评论提案、离线缓存运行 |
| 保留旧实例的新版本试用 | [升级](upgrade.md)，CLI／Runtime API／界面；停止一致性备份、新候选实例、独立审阅启动、实际业务验证后自行切换 |
| 发布者信任实装 | [信任](trust.md)：Ed25519 验签、公钥锚、双签轮换、预先独立恢复钥撤销、风险公告、离线历史与按权威防回放；CLI、Launcher、软件源与 Workshop 闭环 |
| 执行形态扩展 | [执行保护](isolation.md)：固定摘要 Node／Python 容器、有限入口 HTTP 通道、已有 Linux 用户的身份分离；真实 Linux 测试单独运行 |

新实例的“全新数据”路径不继承业务／Hub 状态；“提供者策略”路径只按明确 preserve／migrate 策略复制或迁移私人副本。原实例不覆盖、不自动切换、不自动删除。候选程序启动或迁移失败时保留诊断与旧实例；返回旧实例仍需审阅当前代码和环境。代码／快照恢复无法撤销远程调用、设备动作、已发消息或其他程序的状态。

套件入口：`test:interop`、`test:ecosystem`、`test:launcher`、`test:workshop`、`test:npm`；完整发行另检查真实 ZIP／tarball 和当前提交 CI。静态声明、真实桥行为、业务输出、GUI 操作和生产 HTTPS 源按各自实际执行范围报告，不相互冒充。

真人独立作者和新用户验收经维护者决定暂缓；两位独立 AI 作者的公开文档实验不替代真人验收。容器保护包括可选 Linux Docker Node／Python 与有限 HTTP；已有用户身份分离始终报告 `sandbox:false`。大型社区、任意合同／语言／平台及长期高负载不是本期已验收能力。
