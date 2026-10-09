# 可选能力目录与模块替换

这份应用层示例验证 `来源 → 组装器 → 能力目录 → 处理器 → 输出`，每个程序通过自己的 mod 连接 World Hub。目录维护能力广告和租约，组装器按配置选择处理器，处理器执行和授权，输出程序保存成果。Hub 沿用现有通讯合同；这些约定不成为接入 World Hub 的要求。

在源码仓库启动：`npm run demo:capabilities-explorer`。界面提供能力查询、切换 A/B、版本冲突、授权拒绝和停止续约等实际操作。状态保存在此次演示的独立目录，停止演示不删除原有通讯记录。

## 从公开资料编写自己的实现

独立作者只需阅读[提供者接入契约](../../docs/modules/provider-contract.md)、[机器契约](../../docs/modules/text-statistics.contract.json)和[JavaScript SDK](../../sdk/javascript/README.md)，再取得部署方提供的通讯地址、身份／凭据、模块 ID、目录主题、业务主题及调用方授权。接入契约完整列出登记与发现格式、错误码、Schema 比较、租约与 session、更换模块所需配置及生命周期，不要求阅读 A/B、目录或组装器源码。

新实现可以使用自己的 module ID、principal、业务主题及程序启动形式。部署方在外部目录的 `catalog-config.json` 中配置 `providers` 映射与 `topicPrefixes`，在 Hub ACL 登记双方的发布／订阅权限，并通过组装器的 configure 请求选择新 module ID 及可信 `directory:{principal,queryTopic}`。组装器使用目录广告中的 principal、精确 session 和 topic；不从模块名拼地址，也不限定选择为 A/B。目录内相同模块 ID 有多个广告时返回 `PROVIDER_AMBIGUOUS`，由部署方消除歧义。

浏览器的 A/B 快捷操作是演示入口，不是可用模块全集。独立模块无须实现 A/B 的 `--profile`／`--peer` CLI、配置控制主题、`allowComposer`、诊断计数、共享业务文件或浏览器按钮；这些只用于现有演示的启动和故障操作。模块须实现的是自己所公布的业务契约、目录登记和部署所约定的授权／接线。

资料隔离的 AI 实现验收可以验证文档是否足够接入一份新实现；它不等于已经有真实外部人类开发者完成验收。完整验收范围以实际测试记录为准。

## 本例的公开契约

[机器契约](../../docs/modules/text-statistics.contract.json)定义 `text.statistics@1.0.0`；本目录的 [contract.json](contract.json) 是保持一致的兼容副本。请求为 `{contract:{id:"text.statistics",version:"1.0.0"},invocationId:"…",text:"…"}`。文本必须是无孤立 UTF-16 代理项的 Unicode，编码为 UTF-8 后最多 16384 字节，允许空字符串。输入、输出字段及约束见两个 JSON Schema；字节上限和 Unicode 有效性还须由程序验证。

语义 `utf8-exact-unicode-v1`：保持原文，不修剪、不规范化、不改大小写或换行；`codePoints` 按 Unicode 码点计数，`lines` 为 LF 分段数，`utf8Bytes` 为准确 UTF-8 字节数，`sha256` 为这些字节的 SHA-256 小写十六进制。空文本是 0 码点、1 行、0 字节。CRLF 中的 CR 保持为原文，组合字符与合成字符的字节和计数可以不同。

成功回应包含 `ok:true`、`status:"completed"`、原 `invocationId`、契约、`provider`、新 `executionId` 和四项 `output`；provider 必须等于登记的 module.id。失败回应包含 `ok:false`、`status:"failed"` 和 `{code,message,retryable:false}`。业务拒绝码包括 `CONTRACT_MISMATCH`、`INPUT_INVALID`、`PERMISSION_DENIED`。Hub 接纳收据、delivery、消费 ACK 与这些业务结果分别记录；消息接纳不表示统计已完成。

## 发现、授权与替换

处理器通过定向请求向目录注册 `manifestVersion:1`、模块 ID/版本、能力 ID、契约 ID/版本、输入输出 Schema、语义 ID、调用主题、`effects:"read-only"`、`permissions:["text.read"]` 和 `leaseMs:1800`。正常每 600ms 续约。目录以信封里的 `fromPrincipal`/`senderSession` 绑定广告，使用自身收到消息的时间计算租期；正文自报地址不能替代来源身份。客户端配置可信目录 principal，演示部署为各主体配置 token。

目录返回的是有期限的广告，不能证明程序现在仍存活；组装器按精确契约版本匹配并调用广告里的 session。租约到期不解除 Hub 留存；目录重启以新 epoch 清空租约，由处理器重新注册。处理器重连得到新 session，原精确 session 的请求不会转交给新连接。版本、Schema、单位和语义都须匹配，结构相同不代表含义兼容。修改演示的 `contractVersion` 只用于制造不兼容广告，不代表这份 Schema 已定义另一个可用版本。

`permissions` 是所需授权的说明，目录广告和 Hub 通讯 ACL 不授予业务执行权。处理器核对 Hub 确定的调用方 `fromPrincipal` 与自己的 `allowPrincipals`；本例默认只授权组装器。配置中的 `allowComposer` 可演示拒绝，`delayMs` 可演示迟到结果。配置控制只接受受信 explorer principal。默认启动器为本场景的各主体生成独立随机秘密凭据，只把各自凭据交给对应程序；部分受信测试夹具采用公开演示凭据，不能用这些夹具声称主体之间具有安全隔离。实际部署仍须保护各程序凭据并审查调用方授权；同一用户的本机管理接口保持原有信任边界。

两个处理器各有独立入口与业务实现，仅依赖 Node、桥 SDK 和这份公开契约：[A](processor-a.mjs) 使用 Buffer/Hash 与字符串迭代，[B](processor-b.mjs) 使用 TextEncoder、码点循环和 WebCrypto。切换时只改变组装器选项，来源和输出源码不变。只读声明描述统计业务，处理器仍保存配置和诊断计数；本例不执行文件、资金或设备等外部副作用。

本地等待超时不取消已被 Hub 接纳的请求；迟到回应仍按原请求通讯。处理器不自动重试业务请求，不自动释放通讯记录。统计计数仅用于观察，配置/计数文件没有业务幂等事务，重放可能再次执行。需写文件或其他副作用的模块应自行实现持久幂等、过期检查、授权与补偿；本例不承诺 exactly-once。
