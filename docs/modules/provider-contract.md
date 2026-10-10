# 独立能力提供者接入契约

本页、[机器可读业务契约](text-statistics.contract.json)和[JavaScript SDK](../../sdk/javascript/README.md)构成编写独立 `text.statistics@1.0.0` 提供者所需的公开材料。不需要读取已有处理器、目录或组装器的实现。其他语言可以遵守同一应用层契约并使用自己的桥。

Python SDK 只提供底层 `send`／`receive`，跨语言作者还应阅读[Python SDK](../../sdk/python/README.md)、[完整线协议](../specs/protocol.md)、[请求与回应](../specs/directed-and-bulk.md)及[桥互操作](../specs/bridge-interoperability.md)，以公开帧定义建立通道、订阅、配对接纳和回应、确认投递；JS 的高级方法不是所有语言 SDK 都已经实现的接口。完成提供者后可用[公开互操作基准](../ecosystem/interop.md)分别检查声明、桥行为与业务结果。

能力目录和组装器是可选的外部程序。本契约规定的是这套程序如何合作，不成为接入 World Hub 的要求。Hub 只传递任意主题上的信息、校验通讯身份与权限、按提供者策略留存；它不解析清单、选择算法、授予业务权力或决定程序形态。

## 部署方交付的接线信息

作者编写实现前，部署方应交付以下配置。标识、主题和秘密值由部署选择，不从模块名推算，也不在业务正文中自报身份。

| 配置 | 含义 |
| --- | --- |
| `endpoint` | Hub WebSocket URL，如 `ws://127.0.0.1:8790/bridge` |
| `bridgeId` | 本 mod 声明的桥名；与部署登记一致 |
| `credential`、`token` | SDK 的凭据标识和秘密 token；单桥模式可省略 credential，token 仍按部署配置 |
| `principal` | 期望 `welcome.principal`，握手后核对；本页要求 `welcome.authenticated === true` |
| `moduleId`、`moduleVersion` | 目录获准登记的模块标识、实现版本；实现版本与业务契约版本各自独立 |
| `directory.principal` | 信任的外部目录稳定身份 |
| `directory.registerTopic` | 提供者向目录登记和续约的具体主题 |
| `directory.queryTopic` | 调用方查询目录的具体主题 |
| `businessTopic` | 本实现接收统计请求并回应的具体主题；登记在清单中 |
| `allowedCallers` | 提供者认可的业务调用方 principal 列表；与 Hub ACL 分开核对 |
| `leaseMs`、`renewEveryMs` | 本例可用 1800 和 600；必须满足下文目录边界，并预留处理及通讯时间 |
| 状态路径和重试策略 | 由程序选择；文件游标须按 Hub 部署及桥实例隔离 |

一个可以交付给作者的接线对象如下；token 应由私人配置或环境注入，不写入公开文件。

```json
{
  "endpoint": "ws://127.0.0.1:8790/bridge",
  "bridgeId": "vendor.metrics.mod",
  "credential": "vendor.metrics",
  "principal": "vendor.metrics",
  "moduleId": "vendor-metrics",
  "moduleVersion": "1.0.0",
  "directory": {
    "principal": "demo.capability-directory.directory",
    "registerTopic": "demo/capability-directory/catalog/register",
    "queryTopic": "demo/capability-directory/catalog/query"
  },
  "businessTopic": "vendor/text/statistics",
  "allowedCallers": ["demo.capability-directory.composer"],
  "leaseMs": 1800,
  "renewEveryMs": 600
}
```

部署方完成三处互相独立的配置后，程序才具备完整接线条件：

1. Hub 登记各自身份、token、连接额度及主题 ACL。提供者和目录均须获准发布、订阅 registerTopic；提供者和调用方均须获准发布、订阅 businessTopic；目录和调用方均须获准发布、订阅 queryTopic。回应沿原请求主题返回。`registerChannels` 不能扩大 ACL。
2. 目录自己的 `catalog-config.json` 登记 `providers` 主体到模块 ID 的映射，并通过 `topicPrefixes` 接受所用业务主题。部署保存配置后重启该目录；这不是 Hub 的业务配置。
3. 组装器选择模块 ID 和可信目录地址；提供者自己的 `allowedCallers` 认可该组装器身份。目录广告与 `permissions` 声明不授予执行权。

本例外部目录的部署文件可为：

```json
{
  "providers": {
    "vendor.metrics": "vendor-metrics"
  },
  "topicPrefixes": ["vendor/"]
}
```

`providers` 的 principal 和 module ID 均采用 `^[a-z0-9][a-z0-9._-]{0,63}$`。目录默认登记 `demo.capability-directory.metrics-a → metrics-a` 和 `demo.capability-directory.metrics-b → metrics-b`，默认主题前缀为 `demo/capability-directory/`。`topicPrefixes` 是 1–8 个长度 1–200 的字符串，不含空白、`#` 或 `+`；目录以字面 `startsWith` 判断，建议以 `/` 结尾以限定主题段。Hub 自身的主题语法和 ACL 仍须满足。

## 统计业务契约

[text-statistics.contract.json](text-statistics.contract.json) 的 `inputSchema` 与 `outputSchema` 是完整机器契约。本页补充 Schema 之外的字节、语义、路由和生命周期约定。顶层文档是契约容器；校验业务输入或输出时分别使用其中的 Schema。

输入只有以下字段，不接受额外字段；嵌套 `contract` 同样不接受额外字段：

```json
{
  "contract": { "id": "text.statistics", "version": "1.0.0" },
  "invocationId": "job-001",
  "text": "Hello\n世界 🌍"
}
```

`invocationId` 是 1–256 个 Unicode 码点的字符串，原样返回。该业务契约不要求调用方采用某种 ID 格式；本例组装器另为成果去重使用 `^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$` 的稳定键。文本允许空字符串，必须是没有孤立 UTF-16 代理项的 Unicode，精确 UTF-8 编码最多 16384 字节。Schema 的字符串长度限制不能替代 Unicode 和字节校验。

语义标识为 `utf8-exact-unicode-v1`，逐项含义如下：

| 输出 | 准确语义 |
| --- | --- |
| `codePoints` | Unicode 码点数量；emoji 的代理对为一个码点，组合字符分别计数 |
| `lines` | 用 LF (`U+000A`) 分段所得段数；空文本为 1 行，末尾 LF 会产生最后一个空段 |
| `utf8Bytes` | 原文本准确 UTF-8 编码的字节数；没有额外 BOM |
| `sha256` | 上述原始 UTF-8 字节的 SHA-256，64 位小写十六进制 |

不得修剪、Unicode 规范化、转换大小写或转换换行。CRLF 的 CR 留在原文中，只有 LF 分段；预组合字符与组合字符可能产生不同字节、数量和 hash。空文本的输出是 0 码点、1 行、0 字节及空字节串的 SHA-256。

成功正文的全部字段如下；`provider` **必须等于本清单的 `module.id`**，不填 principal、bridgeId 或实现显示名称。`executionId` 是每次成功执行新生成的 UUID。

```json
{
  "ok": true,
  "kind": "demo.capability-result",
  "contract": { "id": "text.statistics", "version": "1.0.0" },
  "invocationId": "job-001",
  "status": "completed",
  "provider": "vendor-metrics",
  "executionId": "cb853b69-9b21-437a-a859-5d1b3a7b99e8",
  "output": {
    "codePoints": 0,
    "lines": 1,
    "utf8Bytes": 0,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}
```

上面的输出演示空文本，实际统计必须对应本次输入。数值为整数：码点和字节各在 0–16384，行数在 1–16385。输出对象只能有这四个字段；成功正文只能有示例列出的八个字段。

失败正文的全部字段如下，不包含 `output` 或 `executionId`：

```json
{
  "ok": false,
  "kind": "demo.capability-result",
  "contract": { "id": "text.statistics", "version": "1.0.0" },
  "invocationId": "job-001",
  "status": "failed",
  "provider": "vendor-metrics",
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "The provider has not authorized this caller.",
    "retryable": false
  }
}
```

| 业务错误码 | 情况 |
| --- | --- |
| `PERMISSION_DENIED` | `delivery.fromPrincipal` 未获提供者自己的业务授权 |
| `CONTRACT_MISMATCH` | 请求未指定提供者支持的精确契约 ID／版本 |
| `INPUT_INVALID` | 输入字段、Unicode、长度或字节约束不满足 |

失败仍填写提供者实际支持的契约版本。有效且有界的 invocationId 原样返回；不是字符串或超过 256 码点时返回空字符串，避免反射过大非法输入。错误对象必须有非空字符串 `code`、字符串 `message` 和 `retryable:false`，无额外字段。其他业务失败可使用自己的非空错误码；调用方不能把任意字符串错误码等同 Hub 拒绝码。

本例按授权、契约、输入的顺序拒绝请求。修改实现版本不修改业务契约版本；只有确实实现了另一份公开契约时才能公布另一版本。把 `1.0.0` 的 Schema 配上另一个版本号用于演示冲突，不构成对那个版本的实现。

## 向外部目录登记和续约

提供者先完成握手、身份核对、主题声明和业务请求订阅，再发送广告。以 `Bridge.call({principal: directory.principal}, directory.registerTopic, manifest, {timeoutMs:1500})` 请求；返回值中的 `response.body` 才是目录的业务登记结果。`request` 成功收据仅证明 Hub 接纳。

从机器契约构造清单时复制完整两个 Schema，不使用说明性缩写：

```js
const manifest = {
  manifestVersion: 1,
  module: { id: wiring.moduleId, version: wiring.moduleVersion },
  capabilities: [{
    id: contract.contract.id,
    contract: contract.contract,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    semantics: contract.semantics,
    topic: wiring.businessTopic,
    effects: contract.effects,
    permissions: contract.permissions,
  }],
  leaseMs: wiring.leaseMs,
};
const registration = await bridge.call(
  { principal: wiring.directory.principal },
  wiring.directory.registerTopic, manifest, { timeoutMs: 1500 });
const result = registration.response.body;
if (result?.ok !== true || result.kind !== 'demo.capability-registration') {
  throw new Error(result?.error?.message ?? 'Registration was not confirmed');
}
```

清单不发送 `principal`、`session` 或 `endpoint`。目录从 Hub 的定向信封 `fromPrincipal` 和 `senderSession` 获取提供者地址，再按自己的 principal→module allowlist 核对 `module.id`。正文自报身份不能替代此过程。

目录接受的边界：

| 字段 | 约束 |
| --- | --- |
| 整体 | 对象、`manifestVersion:1`；解析后 JSON 序列化的 UTF-8 大小不超过 24000 字节 |
| `module` | 对象；id 必须等于目录给当前主体配置的模块 ID |
| `module.version`、`capabilities[].contract.version` | `^\d{1,6}\.\d{1,6}\.\d{1,6}$`；三个数字分量各 1–6 位，不推断版本兼容范围 |
| `leaseMs` | 300–10000 的安全整数 |
| `capabilities` | 1–8 个对象，能力 ID 不重复 |
| 能力 `id`、`contract.id`、每个 permission | `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `inputSchema`、`outputSchema` | 对象；目录不执行通用 Schema 验证器，调用方另核对公开契约 |
| `semantics` | 字符串，最多 200 个 JS 字符；本统计契约必须准确为 `utf8-exact-unicode-v1` |
| `topic` | 字符串，最多 200 个 JS 字符；匹配目录配置前缀，不含空白、`#`、`+`；仍遵守 Hub 的具体主题语法 |
| `effects` | `read-only`、`writes-state` 或 `external-effects`；本统计契约必须为 `read-only` |
| `permissions` | 最多 16 个 permission；本统计契约必须准确为 `["text.read"]` |

按上表发送已定义字段即可；目录只做其有界格式校验，不把广告作为业务执行证明。当前目录以 principal 为键保存一份条目，同一主体续约会替换这份条目的模块、能力和 session。多个连接共享同一主体时不要并发争用该广告；确需多个独立实例广告时由部署选择独立主体，或另设计外部目录契约。

登记成功返回：

```json
{
  "ok": true,
  "kind": "demo.capability-registration",
  "epoch": "目录本次运行的 UUID",
  "entry": {
    "module": { "id": "vendor-metrics", "version": "1.0.0" },
    "capabilities": [],
    "principal": "vendor.metrics",
    "session": "提供者本次连接的 UUID",
    "registeredAt": 1791500000000,
    "expiresAt": 1791500001800,
    "state": "lease-valid"
  }
}
```

`capabilities` 实际包含登记的完整描述符；以上空数组只为展示回应的外层字段。时间戳是目录自身接收消息时的 Unix 毫秒值，expiresAt 等于 registeredAt + leaseMs。客户端应检查回应的 `ok`、`kind`、epoch 和完整 entry，而不是只收到一份回应就认为登记成功。

## 查询、信任与替换规则

调用方定向请求 `directory.queryTopic`，目标为配置里的可信 `directory.principal`：

```json
{ "capability": "text.statistics" }
```

空对象 `{}` 查询全部条目。可选 `capability` 必须是上述 ID 格式；目录选择包含该能力的条目，但每个条目的 capabilities 仍是完整清单。成功回应的字段如下：

```json
{
  "ok": true,
  "kind": "demo.capability-directory",
  "epoch": "目录本次运行的 UUID",
  "queriedAt": 1791500000100,
  "entries": [],
  "note": "A valid catalog lease is a provider advertisement, not proof of live execution or permission."
}
```

每个 entries 元素包含与登记回应相同的 module、capabilities、principal、session、registeredAt、expiresAt、state。`state` 由目录按 queriedAt 计算：expiresAt > queriedAt 为 `lease-valid`，否则为 `lease-expired`。过期条目仍可以列出；空 entries 表示没有符合查询的登记。`note` 是提示信息，不参与机器兼容判断。

本例组装器只实现统计组合，但模块 ID、目录和提供者通讯地址可配置。配置选择任意合法 module ID，无需修改来源或成果程序：

```json
{
  "command": "configure",
  "provider": "vendor-metrics",
  "contractVersion": "1.0.0",
  "timeoutMs": 800,
  "directory": {
    "principal": "demo.capability-directory.directory",
    "queryTopic": "demo/capability-directory/catalog/query"
  }
}
```

这个配置请求通过组装器自己的 `compose/run` 主题发出，仅部署认可的控制者可以修改。`directory` 是完整的 `{principal,queryTopic}` 对象；registerTopic 只用于提供者登记，不是组装器选项。省略目录配置时沿用当前值，默认使用上面的目录身份／查询主题；timeoutMs 为 100–10000 的安全整数。组装器的控制主题与控制授权是它自己的接口，独立提供者无须实现它。

组装器在调用前核对：

1. 目录回应确由配置的可信主体通过可信 requestSeq 回应；正文为正确 kind，条目结构完整。
2. 所选 module.id 没有条目时返回 `PROVIDER_UNAVAILABLE`。核对目录的非空 epoch、Unix 毫秒 queriedAt，以及匹配条目的 module.version、capabilities、registeredAt、expiresAt 和租约状态；字段缺失或无效返回 `CATALOG_INVALID` 或 `PROVIDER_DESCRIPTOR_INVALID`。多个租约仍有效的同名条目返回 `PROVIDER_AMBIGUOUS`；过期的旧身份广告不挡住新的有效提供者。
3. 广告租约有效；过期返回 `LEASE_EXPIRED`。目录时间与调用方时间比较需要可比时钟；租约不是在线证明，查询后仍可断线或重启。
4. 能力 ID 和契约 ID 为 `text.statistics`，精确版本为 `1.0.0`，语义、effects、permissions 与公开契约准确一致。
5. 两个完整 Schema 与公开契约规范相等：递归按对象键排序后比较 JSON，数组顺序保留。额外描述、漏字段或不同数组顺序都会导致不相等；不使用一般 Schema 等价推理。业务能力声明不匹配返回 `CONTRACT_MISMATCH`。
6. 使用可信目录广告的 `principal`、精确 `session` 和 `topic` 发起请求，不从 module ID 拼地址，不固定业务主题。所选主题仍须在调用方 Hub ACL 范围内。
7. 回应匹配原请求的 requestSeq、提供者 principal/session、原 invocationId、provider=module.id 及完整业务结果；形状不符合返回 `RESULT_INVALID`。

组装器每一步先建立该主题的 response 订阅，再发送请求，结束本地等待后移除这一步的订阅。切换目录或业务主题不会积累历史回应订阅。实际发送／订阅本身会形成有界诊断通道声明；不依赖为每个历史主题永久显式登记。移除订阅不 release 留存的请求或迟到回应，程序若需处理迟到结果可另行按自己的策略抽取。

成果程序的去重、写入和持久提交是另外一步。统计成功不替代成果程序的业务确认，目录登记也不替代统计成功。

## 目录的业务错误回应

登记或查询失败使用同一个外层格式；即使失败的是登记，其 kind 也为 `demo.capability-directory`：

```json
{
  "ok": false,
  "kind": "demo.capability-directory",
  "epoch": "目录本次运行的 UUID",
  "status": "failed",
  "error": { "code": "REGISTRATION_DENIED", "message": "Reason", "retryable": false }
}
```

| 错误码 | 目录拒绝原因 |
| --- | --- |
| `REGISTRATION_DENIED` | 发件 principal 没有登记许可，或信封没有 senderSession |
| `IDENTITY_NOT_DECLARABLE` | 清单正文含 principal、session 或 endpoint |
| `MODULE_IDENTITY_MISMATCH` | module 形状、ID 或 module.version 不符合该主体获准的登记 |
| `MANIFEST_INVALID` | 清单大小、lease、能力数或描述符约束不满足 |
| `QUERY_INVALID` | 查询不是对象，或 capability 格式不合法 |
| `CATALOG_FAILED` | 目录自身保存或处理失败，没有更具体的业务码 |

这些是外部目录解释的业务码。Hub 握手、主题 ACL、容量等拒绝通过 SDK Promise 的 `error.code`／`error.frame` 返回，不包成成功目录条目。调用者保留接纳收据、回应和业务正文，分别判定通讯与业务状态。

## 运行与生命周期

提供者接线顺序为：监听诊断和 delivery → connect 并核对 welcome → registerChannels → await subscribe 的建立回执 → 登记广告 → 周期续约。订阅 `businessTopic` 时使用 `operations:['request']`；SDK 的 call 会自己在 registerTopic 建立 response 订阅，因此该主题仍需两个方向。`subscribe()` 完成只表示订阅已建立；不是消费完成屏障。SDK 的 `from:'now'` 用 welcome.lastSeq 作为数字起点，详见 SDK 文档。

delivery 的可信通讯字段是 `operation`、`topic`、`seq`、`fromPrincipal`、`senderSession` 等；body 是请求方自己的信息。核对 operation/topic 和业务授权后，按业务契约生成结果，使用 `respond(delivery, result)` 回应。不要用 body 内的回程地址、principal 或 invocationId 改写通讯目标。`respond` 从仍留存的原请求推导返回身份、原主题和关联关系。

续约任务须避免并发登记堆积，并处理有限等待失败。正常实现可以每 600ms 以 1800ms 租期登记；目录按接收时间续期，响应延迟会缩短提供者所观察的剩余时间。目录重启生成新 epoch，并让保存的旧条目立即过期；收到新登记才能重新有效。提供者重连得到新的 session，必须重新登记；指向旧精确 session 的请求不会转交新连接。SDK 会恢复已登记通道和订阅，应用仍负责检查新 welcome、重新公布广告和处理未完成工作。

默认 SDK 在全部 delivery 回调成功、文件游标保存成功后 ACK；无回调或回调失败不自动 ACK。业务拒绝也是成功处理一份请求，可以在回应被 Hub 接纳后结束回调。若通讯中断或回应接纳不确定，不应伪报业务失败并重新执行；由程序决定恢复、幂等或诊断策略。共享凭据的多个实例可能收到同一未指定 session 的请求，Hub 不挑选唯一执行者。

调用方本地超时不是取消。已接纳请求未及时回应时业务状态为未知，提供者可能仍执行并产生迟到回应。SDK `call` 结束这次等待；迟到信息仍留存，可通过普通 response 订阅或明确历史抽取处理。需在超时后仍保有请求接纳序号时，用 `requestTo` 保存收据并自行建立 response 等待，不依赖 call 抛出的错误包含收据。没有接纳收据也不能证明发送的请求未被接纳；不要因此盲目重发副作用。

停止续约后条目自然过期；此目录契约没有强制注销接口。停止程序应清理自己的计时器／未完成工作并显式 `bridge.close()`，不自动 release 请求、回应或广告。请求、回应分别属于发送它们的提供者；只有它们自己的策略决定何时允许回收。ACK、业务成功、查询、租约过期、超时和停止都不释放记录。续约较频繁时，部署方和程序须自行规划通讯容量与自己发送的历史记录保留策略。

只读统计可以重复执行；本例没有跨重启 exactly-once 承诺。写入、设备动作或其他副作用的能力应另行定义持久幂等、截止时间、补偿和业务确认契约。能力清单不能替代这些行为约定。

## 独立实现的验收边界

验收应只给作者本页、机器契约、SDK 文档／SDK 文件和一份部署接线配置，不给已有处理器或共享业务程序。验证作者从零生成的实现能：登记任意新 module ID；在自己公布的主题提供统计；仅改变组装器配置完成替换；保持来源和成果程序不变；处理空文本、emoji、组合字符、CRLF、字节边界、非法输入、授权拒绝；经受目录／提供者重启、租约过期和迟到回应。

AI 在隔离资料环境中编写并通过真实进程接入，证明公开资料和该实现足以完成这些用例。它不等于一个真实外部人类开发者已经完成接入，也不证明任意合同、平台、模块或长期负载全部兼容。外部开发者仍需自行测试自己的实现与部署。

通用通讯、附件及完整错误边界见[请求与大体积通讯](../specs/directed-and-bulk.md)和[部署接入](../onboarding.md)。外部程序可以建立不同的能力目录、版本政策或工作流；新的业务约定不进入 Hub 通讯内核。
