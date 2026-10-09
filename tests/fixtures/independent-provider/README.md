# 文档隔离的独立提供者

`provider.mjs` 由另一个无项目对话历史的 AI 作者从零编写。作者只获准阅读冻结的[提供者接入契约](../../../docs/modules/provider-contract.md)、[统计机器契约](../../../docs/modules/text-statistics.contract.json)和[JavaScript SDK 文档](../../../sdk/javascript/README.md)，没有获得 A/B、目录、组装器、Hub 或共享业务源码。资料限制由实验指令约束，不是操作系统访问隔离。原始作者记录和运行证据在执行环境保存；公开测试固定这份实现以便重跑。

实现使用 `world-hub/bridge` 的公开导出。运行入口为 `node provider.mjs --config <wiring.json>`，路径相对接线文件解析；接线字段与公开指南一致，另要求 `contractPath` 和独立 `cursorFile`。启动器测试所需的 JSON `ready`、IPC `stop` 和信号停止属于这份测试程序的适配，不是 Hub 或所有 mod 的强制接口。

`ECOSYSTEM-11` 把它放入独立临时目录，只提供机器契约和公共 SDK 文件，以新模块 `vendor-stats`、身份 `vendor.acme`、主题 `vendor/statistics/v1` 接入。测试仅改变部署接线和组装器配置，验证真实成果、Unicode／字节／ID 边界、完整失败回应、业务授权、版本拒绝、租约到期、提供者新 session 及目录重启恢复。测试前后核对原有来源／组装／成果源码的 hash。该程序不自动 release 任何信息。

运行：`npm run test:capabilities`。这个验收证明这三份公开材料和该 AI 实现足以完成上述场景，不声称真实外部人类开发者已完成接入，也不证明任意合同、平台或长期负载都兼容。迟到回应和超时未知由其他能力场景另外验证，不扩大本程序的覆盖范围。
