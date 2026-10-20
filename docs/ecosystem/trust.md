# 作品证据、发布者公钥与执行授权

可选外部 Runtime、Launcher 和 Workshop 已实现 Ed25519 发布签名检查、本机公钥锚、双签名轮换、独立恢复钥撤销及精确作品风险公告。证据作为制品旁路保存，不改变 Module、Pack、Hub 协议或原始制品字节；未签名作品仍可取得并进入独立审阅流程。Hub Core 不管理作者身份或程序的执行策略。

## 五个独立维度

| 维度 | 当前证据 | 不代表什么 |
| --- | --- | --- |
| 密码学签名 | 确定性声明上的真实 Ed25519 验签 | 只证明对应私钥签署了声明；未知公钥仍是 `unanchored-key` |
| 发布者公钥信任 | 用户审阅的公钥指纹、角色和 `identityBasis` | Workshop 账号不自动成为锚；人工记录或外部身份服务标签也不是工具自动完成的实名认证 |
| 内容完整性 | 精确版本、SHA-256、不可覆盖制品和文件锁 | 相同字节不代表内容可信、没有恶意或业务正确 |
| 本地执行授权 | 用户接受绑定当前代码、权限、解释器和配置的摘要 | 不等于发布者身份验证，也不替别的实例授权 |
| 运行隔离 | 实际执行 profile、提供者、限制和组件状态，见[隔离指南](isolation.md) | 声明权限和 venv 不是 OS 沙箱；更换系统用户也不等于容器隔离 |

代码安全未由这些证据认证。兼容声明、桥行为和业务输出另行报告。界面保留 `unknown`／`not-checked` 等状态，不把缺失证据渲染为通过。评论、提案、下载量和源摘要都不能替代执行审阅。只查看索引声明时，不称已校验实际制品字节。

## 公共证据封套 v1

`world-hub.publisher-evidence/v1` 是最大 **256 KiB** 的公共 UTF-8 JSON。证据单独按摘要分发和缓存，不嵌入原始制品。共用验签实现使用以下检查形态（不是 npm 的公开 Runtime 导出）：

```js
verifyPublisherEvidence({ artifact: {kind, id, version, sha256}, evidenceBytes,
  state, trustedKeys, now, sourceStatus: 'offline' })
// => { accepted, signatureStatus, contentIntegrity, publisherIdentity, keyStatus, advisoryStatus, checkedAt,
//      identityBasis, warnings, startsModules:false, grantsExecution:false }
```

`trustedKeys` 或本机信任库由用户明确配置，不能直接相信被下载作品附带的公钥。`identityBasis` 记录人工确认、公钥指纹固定或外部身份服务等依据；它不是工具自动完成的身份认证。即使密码学验签通过，没有锚仍报告 `publisherIdentity:"unanchored-key"`、`accepted:false`，不会自动固定作品自己的公钥。

所有声明字段闭合。解析拒绝重复 JSON 键、BOM、无效 UTF-8、孤立代理字符、不安全数值及未知类型／算法，支持 1–4 个 Ed25519 签名和最多 4 个公共公钥。不得包含私钥。下面的占位值只是字段示例，不能验签：

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
  "signatures": [{"keyId":"ed25519-sha256:<public-key-fingerprint>","algorithm":"Ed25519","value":"<canonical Base64 of 64 signature bytes>"}],
  "publicKeys": [{"keyId":"ed25519-sha256:<public-key-fingerprint>","publicKey":"<canonical Base64 of 32 public-key bytes>"}]
}
```

签名字节固定为 ASCII 前缀 `WORLD-HUB-PUBLISHER-EVIDENCE/1\n` 加 `payload` 的确定性 UTF-8 JSON：对象键按 ASCII 升序递归排列、无空白、字符串按 JSON 转义、数值仅限非负安全整数；签名不覆盖封套的 `signatures` 或 `publicKeys`。制品须精确绑定 `kind/id/version/sha256`，不能泛用到其他版本或只给摘要。公钥指纹基于原始 32 字节 Ed25519 公钥的 SHA-256。`sequence` 为正安全整数，UTC 时间使用精确毫秒 ISO 格式，有效期不超过 366 天。公开[固定向量](publisher-vectors.json)及独立 [Python 检查器](publisher-vector-check.py)可重现规范化与真实签名核对；其中的测试密钥仅供验证。

## 轮换、撤销与风险公告

共用封套的 `payload.type`，每种类型有单独闭合 `details`：

| 类型 | 绑定内容和接受条件 |
| --- | --- |
| `artifact` | 声明精确作品摘要；可信锚公钥有效且时间／序列合理 |
| `key-rotation` | `oldKeyId`、`newKeyId`、新公钥、`effectiveAt`；同一 payload 必须同时由原可信旧钥和新钥签名，轮换不能让任意作品自建身份锚 |
| `key-revocation` | `revokedKeyId`、`effectiveAt`、原因；由**在声明签发前已经独立固定**的 `recovery` 钥签署；不能是被撤销的钥，事后添加作品附带的恢复钥不满足要求 |
| `risk-notice` | 精确作品摘要列表、风险等级、说明和可读链接；区分发布者自述与受信公告者。公告不改写本地数据、不自动执行修复代码 |

控制声明的 `subject` 为 `{ "kind":"publisher", "id":"<issuer>" }`。轮换要同时核对旧钥和新钥的签名，新钥不能回填生效前的声明。来源制品旁路只接受精确绑定的 `artifact`；不能通过取得作品暗中提交轮换或撤销，控制声明走独立审阅和记录。

本机 `publisher-trust.json` 只保存公共公钥、角色、身份依据和声明历史。角色为 `publisher`、`recovery` 或 `advisory`。添加或停用锚须先预览，再提交当前 `reviewDigest`；其他操作改变信任库时旧摘要失效。停用保留历史，不能重新添加同一已知钥来清空撤销或序列记录。

每个 **`issuer + keyId`** 有独立序列流。同一钥不能对同一序列签不同声明，不能插入尚未见过的旧声明；已见相同声明可重复检查。新轮换钥、恢复钥和公告钥各自推进自己的序列，不会被发布钥的大序列阻断。旧缓存没有 `keyId` 的记录采用保守兼容：重新验签后才关联已知声明，不凭迁移建立身份锚。

**取得在线作品签名也不等于查询了最新撤销或公告**。报告显示 `cached-only-new-status-unknown` 或 `cached-notice-new-status-unknown`，保留实际已见状态时间；离线只使用缓存。无匹配公告不能称“没有风险”。撤销、过期或签名失败时，匹配缓存公告仍显示，并另报公告过期及权威钥状态。

Launcher 在下一次代码／启动审阅时重新核对已取得作品的证据。身份、撤销或风险状态改变后，旧执行审阅失效，用户需查看当前报告并重新审阅。它不远程杀死已运行程序，也不能撤销已发生的调用、设备动作或数据泄露。

## 历史 Launcher 审阅接口（已退役）

当前不分发旧 publisher CLI 或 world-hub/runtime 导出。公共证据格式仍可由作者使用自己的工具生成，不能把私钥提交给管理界面或 Workshop。下表仅记录已退役 Launcher 的接口；当前通信管理界面 `/manage` 不提供这些接口，也不提供旧版兼容入口。

历史 Launcher 后台可读取锚、预览添加／停用，以及审阅公开签名、轮换、撤销和公告文件。选择实际 `artifact.json` 时后端验证真实字节；这些历史本地 HTTP 接口使用管理身份和 CSRF 保护：

| 接口 | 输入与行为 |
| --- | --- |
| `GET /api/publisher-trust` | 读取当前公共信任记录 |
| `POST /api/publisher-trust/preview` | `{change}`，返回当前 `reviewDigest` |
| `POST /api/publisher-trust/apply` | `{change,reviewDigest,accepted:true}` |
| `POST /api/publisher-evidence/preview` | 选择 `{receiptId}`、`{evidencePath,artifactPath?}` 或 `{sourceId或source,indexDigest,entryId}`；只读审阅 |
| `POST /api/publisher-evidence/observe` | `{previewId,accepted:true}`；证据和当前 revision 未变化时才记录 |

历史接口的信任结果保留 `startsModules:false`、`grantsExecution:false`，没有引入中心强制注册、平台证书机构或对程序形态的规定。

公开[固定验签向量](publisher-vectors.json)与[独立 Python 校验器](publisher-vector-check.py)仍可用于其他语言实现；校验器的测试依赖是 `cryptography==50.0.0`，共用 Node 验签实现只用内置 crypto。向量中的固定测试密钥不能用作真实身份信任锚。作品身份须由实际制品字节独立核对为 `{kind,id,version,sha256}`，不能把声明自带的摘要当作实际内容验证。历史 Launcher 的作品文件选择和软件源曾执行这项核对；公开向量本身不代表当前管理界面提供上述历史功能。
