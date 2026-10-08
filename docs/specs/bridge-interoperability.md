# 跨语言桥合同

Hub 使用 wire 0.1 的 UTF-8 JSON WebSocket 和协商后的 directed-v1／blob-v1。外部程序自行选择语言、框架、进程结构、桥数量和程序与桥的 N:M 关系。

## 必须保持的通讯正确性

任何语言的桥遵守[通讯契约](protocol.md)和[定向／附件扩展](directed-and-bulk.md)。真实 hello/welcome 决定通讯身份与可用特性；bridge、稳定 principal、一次连接 session 各有用途。主题和 body.kind 由 mod／程序选择，身份与主题权限由部署配置授权。不能伪造成功、隐瞒拒绝或混淆本地发送、Hub 接纳和程序完成。

当前绑定使用完整 UTF-8 JSON 文本 WebSocket 消息。底层接收若分片，先组装完整消息再严格解码，不能在跨缓冲区字符中间解析。非法 JSON 的 NaN／Infinity 不能作为数字编码发送。桥可以声明自己的资源上限，超过时明确失败，不能静默截断或扩大 Hub 实际接受范围。

承载原始正文时遵守原始 JSON 透传合同：业务数字可以超过 JS 安全整数范围，也可以有精细小数、指数写法、转义和内部空白。诊断解析值不能重新序列化后充当原文。正文里的 escaped lone surrogate 是合法 JSON 文本，诊断输出不能因编码失败吞掉原始帧。消费程序解释正文或产生新的正文仍是程序责任；headers 等其他字段不享有 body 原文合同。

ACK、读取、扫描、caught_up 和断线都不构成释放许可。消息 release 与 blob_release 分别由各自提供者决定。桥的便利方法不能暗中改变 ACK 条件、提供者留存许可、定向目标、调用失败含义或历史缺口。

## 按使用功能适用的要求

桥可以只交出原始帧，不必内置高层订阅 API。使用多条同时未决订阅时，由桥或调用方正确关联回执与屏障：线上 token 可选，选择 token 配对时应在未决操作之间唯一；根据 subscribed.token 取得 subscription，再关联 delivery／caught_up／catchup_truncated。不能凭返回次序挑选屏障。部分拒绝没有 token，配对机制应明确处理失败与未决操作，不能臆造归属。

使用 seq、from、requestSeq、size、offset、length 等协议整数时，按各字段规则验证，采用 JS 安全整数范围；布尔值不是协议整数。此约束不能扩展为业务正文的数字限制。裸 wire 省略 from 或字符串 now 取 Hub 处理订阅时的水位；显式数字 watermark 可抽取其后留存。JS SDK 无保存游标时采用 welcome.lastSeq 连接快照；resume 是 SDK 本地策略，不是线协议游标值。

进行本地长度预检查时，使用对应字段规则：主题／过滤器以及关联字段按 JS UTF-16 code units；bridge／principal 等稳定身份遵守 ASCII 字符集与 64 字符规则；正文和传输容量按 UTF-8 字节。宿主语言字符计数不能扩大 Hub 接受范围。

使用定向特性时，request／inject 按稳定 principal 和可选 session 寻址。respond 提供原 requestSeq，返回身份和主题由 Hub 从原记录推导。调用方仍需匹配订阅，并核对可信 requestSeq、fromPrincipal 等关联事实。

使用附件特性时，发送 attachments 是对象 ID 数组，delivery 是 Hub 确定的 id／size／sha256 描述符数组。blob_begin 声明合法安全整数大小与小写 SHA-256；blob_chunk 发送规范 base64，按接纳结果推进 offset；blob_commit 后才能引用。读取核对合法消息引用、权限、offset、长度、结束标志和完整 SHA-256。引用其他提供者对象不自动赋予再次提供或释放权。

提供有完成含义的 connect／request／追平等本地方法时，说明错误、关闭、取消、超时与未决操作处理，可让调用方选择等待策略。长期订阅等待下一帧是合法行为；wire 不规定统一等待秒数，也不要求所有桥采用同一种重连方式。

## 可选的桥／程序便利策略

自动重连、重试、持久化游标、订阅复用／重读 API、自动 ACK、文件路径与断点恢复都可由桥或程序实现。自动 ACK 仍须明确确认什么，不能宣称业务已经成功。业务去重、工作流屏障、下一步和终止、释放时机均由外部程序／提供者决定。不同语言的桥无需照搬 JS SDK 的方法名称和本地恢复策略。

Python 的 4000 位阈值只是参考桥诊断整数改为字符串的阈值，合法更长数字仍保存在 raw；不是协议正文数字位数上限。4 MiB 是当前 Hub WebSocket 入口与参考桥的默认帧上限，不是所有桥必须达到的统一下限。1 MiB 是库未覆盖配置时的正文默认容量，不是缓存容量；源码参考配置和分发默认配置均显式设置正文上限 256 KiB。具体值以部署配置、welcome 和桥声明的本地限制为准。

## 可执行验收与范围

[候选桥验收入口](../../tests/bridge-acceptance/README.md)通过 manifest 配置候选可执行文件和 argv；候选桥自行建立 WebSocket。NDJSON 只是验收装置的控制与观察绑定，不规定真实程序形态，也不是新增 Hub 协议。

```powershell
node tests/bridge-acceptance/run.mjs --bridge tests/bridge-acceptance/python.json
```

base profile 执行握手、动态主题双向发布、JSON 原文、订阅关联、水位、ACK／提供者释放和正常关闭七组检查；directed 与 blob 是按功能选用的两组。未选择的 profile 记为 notExecuted，失败前未到达的检查另列，不算通过。测试中用 token 观察关联，不把 token 改成 wire 必填字段。有限超时与正文样本容量属于本装置验收边界，不是所有桥的统一 API 约束。

[跨语言示例](../../examples/cross-language/README.md)保留 14 条实际集成场景。三份示例 manifest 调用已有参考 worker；开放装置不表示任意第三方、所有语言或所有平台已经验收。Python／PowerShell 提供完整帧 connect／send／receive／close；PowerShell 托管 C# 辅助类，不声明独立 dotnet SDK 验收。工作流仍由外部 JS 程序发起三轮、每轮两个语言程序并合并成果。

每次候选的实际环境与执行结果保存为独立报告，方法见[验证说明](../verification.md)。跨语言乱序／重复 ACK、上传中断恢复、错误 SHA-256、跨主机、Linux、长期压力与断电耐久性没有在这 14 个场景中涵盖。既有 Node 测试不能替代其跨语言验收。
