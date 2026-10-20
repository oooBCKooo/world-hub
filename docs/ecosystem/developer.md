# 模块作者指南

[English](developer.en.md) · [模块声明](modules.md) · [独立程序接入](external-programs.md)

先确定程序负责的业务和公开契约，再选择 SDK 或自行实现枢纽桥。Hub 不规定页面、模型、业务数据或内部架构。

1. 用[通信协议](../specs/protocol.md)和对应 [JavaScript](../../sdk/javascript/README.md)、[Python](../../sdk/python/README.md)、[PowerShell](../../sdk/powershell/README.md) SDK 实现双向连接。
2. 约定主题、消息格式、定向请求与结果语义，校验调用方和回应方身份。抽取、ACK 与业务完成分别处理。
3. 普通程序可由自己的安装器运行。需要通信管理界面管理时，提供[模块清单](modules.md)及可选接入默认值，源码按模块目录或 ZIP 交付。
4. 在模块库导入，创建独立实例，检查解释器、公开参数和权限，审阅后启动到同一个全局 Hub。
5. 用真实消费者验证业务结果、断连、超时、重复投递和替换，再发布新的不可变模块版本。

源码自测由作者自行提供，例如 `node --test <自己的测试文件>`；不把 UI 显示“已连接”视为完整验收。

可在 `deployment.json` 中建议新实例的运行方式：

```json
"executionDefaults": { "mode": "on-demand", "idleTimeoutMs": 60000 }
```

`mode` 必填，可为 `resident` 或 `on-demand`；可选空闲时间为 1000 至 86400000 的整数毫秒，省略时为 60000。模块组成员的 `configuration.executionDefaults` 优先于模块默认值；都未声明时，新实例默认为常驻／60 秒。导入审阅会显示最终策略与来源，实例仍以停止状态导入，允许唤醒的调用者为空。用户可覆盖本机策略；升级、降级和回退保留已有实例当前的本机策略。导出组仅携带模式与空闲时间，作者默认值不得包含 `allowedCallers` 或启动授权。更多边界见[常驻与按需运行](modules.md#常驻与按需运行)与[生命周期 SDK](../../sdk/javascript/LIFECYCLE.md)。

文字统计示例的[提供者契约](../modules/provider-contract.md)和[机器契约](../modules/text-statistics.contract.json)可用于独立实现。完成后用[互操作基准](interop.md)分别检查声明、桥行为和业务语义。

当前不提供整合包／模板生成 CLI，不再公开旧 `world-hub/runtime` API。历史作者样板和整包部署指南不作为当前分发入口。SDK 的通信导出和线协议保持独立。
