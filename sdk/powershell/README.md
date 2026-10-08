# PowerShell mod 桥

本 SDK 采用仓库 [MIT 许可](../../LICENSE)。它引用 .NET 系统 API，不复制 .NET 运行时；系统运行时遵循自己的许可。

`HubBridge.psm1` 和 `HubBridge.cs` 使用 `.NET System.Net.WebSockets.ClientWebSocket` 直接连接 Hub。PowerShell 7 的 `Add-Type` 编译通用桥类型，无需 Node 或 dotnet SDK。模块载入不连接、不注册、不执行程序业务。

```powershell
Import-Module './sdk/powershell/HubBridge.psm1'
$bridge = New-HubBridge
try {
    Connect-HubBridge -Bridge $bridge -Url 'ws://127.0.0.1:8790/bridge'
    Send-HubBridgeRaw -Bridge $bridge -Raw '{"type":"hello","wire":"0.1","bridge":"your-bridge"}'
    $welcomeRaw = Receive-HubBridgeRaw -Bridge $bridge -TimeoutMs 10000
    $welcomeRaw
} finally {
    Close-HubBridge -Bridge $bridge
    $bridge.Dispose()
}
```

先在 Hub 配置登记自己的身份、token 和主题权限。示例 hello 无 token 只适用于可信回环模式；生产 token 应由程序自己的未跟踪配置提供。

模块导出 New／Connect／SendRaw／ReceiveRaw／Close。C# 同时提供 Task 方法 `ConnectAsync`、`SendRawAsync`、`ReceiveRawAsync`、`CloseAsync`；发送用信号量串行，一个连接只有一个底层接收任务。上层程序自行解释 welcome、denied、error、回执、subscription 与 barrier。

默认连接／发送／调用方帧等待 10 秒，已开始的分片消息最多 30 秒；完整帧默认 4 MiB UTF-8，接收队列最多 128 帧、8 MiB 原文。超限明确失败，分片完整组装后严格 UTF-8 解码。关闭握手最多 2 秒；关闭或错误中止未满足等待，已排队完整帧仍可读取。`New-HubBridge` 的本地上限配置不能扩大 Hub 限制。

所有收发使用原始字符串；经过 PowerShell `ConvertFrom-Json`／`ConvertTo-Json` 后重新编码时，数值精度、转义与字面形式由程序负责。发送成功不等于 Hub 接纳。桥不自动登记、订阅、ACK、release、重试、重连、选业务类别或保存游标。

`tests/fixtures/powershell/worker.ps1` 与 `ProtocolWorker.cs` 是额外 NDJSON 测试程序，联合编译桥与夹具，独立于通用模块；Hub 与分发 SDK 不加载其回声业务。`node tests/fixtures/powershell/smoke.mjs` 默认调用 PATH 中 `pwsh`，可设置 `HUB_PWSH` 选择自己的可执行文件，报告写新的 `.artifacts/evidence/powershell-smoke/` 子目录。

实际验证范围由运行报告决定，不因采用 .NET 就宣称独立 dotnet SDK、Windows PowerShell 5.1 或所有操作系统通过。完整跨语言与候选桥方法见[验证](../../docs/verification.md)。
