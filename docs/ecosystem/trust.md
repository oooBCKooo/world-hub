# 作品来源、执行授权与渐进信任接口

本页区分已经实现的检查与后续可选接口。SHA-256 内容摘要、锁文件验证、本地执行审阅和有限容器 profile 已实现；下面的发布者签名、密钥轮换、撤销和风险公告属于**接口设计**，当前 Runtime／Launcher／Workshop 不实施这些签名的验签，也不自动据此授予执行权。Hub Core 不管理发布者身份。

## 四个独立维度

| 维度 | 当前证据 | 不代表什么 |
| --- | --- | --- |
| 发布者来源 | 软件源 URL、Workshop 账号或作品里的作者声明 | 没有可信锚的声明不能证明真实个人身份；账号也不是安全审计 |
| 内容完整性 | 精确版本、SHA-256、不可覆盖制品和文件锁 | 相同字节不代表内容可信、没有恶意或业务正确 |
| 本地执行授权 | 用户接受绑定当前代码、权限、解释器和配置的摘要 | 不等于发布者身份验证，也不替别的实例授权 |
| 运行隔离 | `trusted-local` 或实际审计过的 `docker-node-headless/v1`、镜像和限制 | 不证明合同业务行为、内核安全或应用副作用可撤销 |

兼容声明、桥行为和业务输出另行报告。界面应保留 `unknown`／`not-checked`／`not-run` 等状态，不把缺失证据渲染为通过。评论、提案、下载量和源摘要都不能替代执行审阅。

## 可选发布者证据包 v1 设计

未来独立来源适配器可以在制品旁发布 `publisher-evidence.json`，不修改 Module、Pack、Hub 协议或作品的精确字节。验证结果也应是旁路报告，制品摘要仍按原始字节计算。最小外部接口形态为：

```js
// 拟议接口，当前 world-hub/runtime 未导出实现。
verifyPublisherEvidence({ artifactSha256, evidenceBytes, trustedKeys, now, lastSeenSequence })
// => { contentIntegrity, publisherIdentity, keyStatus, advisoryStatus, checkedAt,
//      identityBasis, warnings, startsModules:false, grantsExecution:false }
```

`trustedKeys` 由用户或独立策略服务提供，不能直接相信被下载作品附带的公钥。`identityBasis` 必须说明身份锚来自人工确认、公钥指纹固定或外部身份服务。一个能通过密码学验签的公钥，只证明对应私钥授权了该声明；没有身份锚时报告 `publisherIdentity:"unanchored-key"`。

所有声明使用以下封套形态，字段闭合、长度有上限，UTF-8 解析严格，未知类型／算法不接受为已验证：

```json
{
  "format": "world-hub.publisher-evidence/v1",
  "payload": {
    "type": "artifact",
    "issuer": "author.example",
    "keyId": "ed25519-sha256:<public-key-fingerprint>",
    "sequence": 3,
    "issuedAt": "2026-10-10T00:00:00.000Z",
    "expiresAt": "2026-11-10T00:00:00.000Z",
    "subject": {"kind":"module","id":"author.text-stats","version":"1.0.0","sha256":"<64 lowercase hex>"},
    "details": {}
  },
  "signatures": [{"keyId":"ed25519-sha256:<public-key-fingerprint>","algorithm":"Ed25519","value":"<base64 signature>"}]
}
```

签名字节建议固定为 ASCII 前缀 `WORLD-HUB-PUBLISHER-EVIDENCE/1\n` 加 `payload` 的确定性 UTF-8 JSON：对象键按 ASCII 升序递归排列、无空白、仅接受闭合字段、字符串按 JSON 转义、数值仅限非负安全整数；签名不覆盖封套自己的 `signatures`。禁止重复 JSON 键或会产生不同规范化结果的值。制品须有同精确 `kind/id/version/sha256`，不能把签名泛用到其他版本。公钥指纹基于原始 32 字节 Ed25519 公钥的 SHA-256，不是制品摘要。正式实现前必须发布固定测试向量与跨语言验证，当前示例占位值不能验签。

## 轮换、撤销与风险公告

共用封套的 `payload.type`，每种类型有单独闭合 `details`：

| 类型 | 绑定内容和接受条件 |
| --- | --- |
| `artifact` | 声明精确作品摘要；可信锚公钥有效且时间／序列合理 |
| `key-rotation` | `oldKeyId`、`newKeyId`、新公钥、`effectiveAt`；同一 payload 必须同时由原可信旧钥和新钥签名，轮换不能让任意作品自建身份锚 |
| `key-revocation` | `revokedKeyId`、`effectiveAt`、原因；需要预先指定的独立恢复钥或策略服务授权。只由已经泄露的钥签名不构成可靠恢复 |
| `risk-notice` | 精确作品摘要列表、风险等级、说明和可读链接；区分发布者自述与受信公告者。公告不改写本地数据、不自动执行修复代码 |

已见最高 `sequence`、撤销和轮换记录由外部验证器按 issuer 保存；检查回放和回退。过期、来源离线、时钟异常、冲突轮换、已撤销钥和无法锚定的公告都应保留可理解诊断。公告离线时只能报告缓存的检查时间与未知的新状态，不能称“没有风险”。撤销不会召回已经运行的代码或已经泄露的数据。默认执行路径继续要求用户的新审阅；后续是否拒绝新下载或禁止运行由外部 Launcher／用户策略决定。

该设计不引入中心强制注册、平台证书机构或对程序形态的限制。实现可选验签前，需要单独确定信任锚管理、恢复钥、离线策略和规范化测试向量；本阶段不声称这些能力已经实现。
