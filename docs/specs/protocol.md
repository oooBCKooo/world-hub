# 枢纽与 mod 桥的通讯契约

线协议为 `wire: "0.1"`，附加通讯能力通过 welcome.features 协商。当前绑定为 UTF-8 JSON 文本 WebSocket，默认 `ws://127.0.0.1:8790/bridge`。传输绑定不规定外部程序语言、进程结构或界面形态。

## 连接与身份

首帧 `hello` 必须包含 `wire` 与 `bridge`。桥标识与可选凭据标识均匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`；可附 `credential`、`token`、`role`、`displayName`。配置中的 `acl.bridges` 和 `acl.credentials` 键采用相同规则；非法键拒绝启动，实例冒号仅由 Hub 分配，避免管理主体与实例身份混淆。

配置 `acl.bridges` 是单身份模式，同名连接明确接管旧连接并清理其订阅。`acl.credentials` 允许一个凭据多个连接，枢纽为每次接入分配不与存活连接碰撞的实例身份；身份后缀只在本次枢纽运行期间唯一，不是程序的永久标识。

成功返回 `welcome`：hub、hubWire、wireHash、bridge、declared、authenticated、lastSeq、limits、now。版本不符或身份/凭据拒绝返回 `denied` 并关闭。无 token 的已登记身份仅允许回环连接，恒标未认证。凭据和桥身份只授权通讯，不能替程序授予执行本地工具的权力。

自行实现当前 WebSocket 绑定时，应在构造套接字后同步注册 `open`、`error`、`close`、`message`；连接和帧等待设置有限超时，关闭或错误立即中止未完成等待并保留已收帧诊断。不要延后注册 `open`，也不要仅靠轮询等下一帧。短期客户端示例见[三程序接入说明](../onboarding.md#自研桥连接等待与订阅回执配对)。

`from` 是 Hub 给该连接确定的通讯来源，不是正文中的自称，也不证明未认证接入背后的程序身份。无 token 回环模式依赖受信本机参与者；同名接入仍可接管旧连接。需要来源防伪时，部署方应配置相应认证，消费程序再按自己的接入约定核对来源；`providerId`、业务角色或程序注记不能替代这一步。普通 publish 使用实例 `from`，定向投递才另含稳定 `fromPrincipal` 和 `senderSession`，不能要求旧发布路径凭空具有后两字段。

启用附加能力的 welcome 另含稳定 `principal`、每次认证唯一的 `session`、`features` 与 `blobLimits`。新增 API 先检查特性，不把 target 放进旧 publish 帧；否则旧枢纽可能忽略字段并广播。现有 wireHash 只是版本字符串校验，不代表具体特性存在。

principal 的分发与核对由接入程序负责，Hub 数据面没有程序名册或业务服务发现帧。推荐由部署方将对端 endpoint、稳定 principal、主题写入各程序自己的受信配置，对端用自身 `welcome.principal` 核对配置。程序也可在自行约定的发现主题发布广告，接收方按已认可的通讯来源核对广告；body 中自报 principal 不证明身份。定向 delivery 的 `fromPrincipal` 由 Hub 确定，普通 publish 的 `from` 是连接实例身份。精确 session 是短期地址，不能作为跨重连的稳定配置。本机 `/status` 和 `/manage` 可以列出当前接入主体的 principal、通道和关系注记，但属于运维视图，不是程序业务名册，不能替代以上核对。

## 动态通道注册

```json
{"type":"register","requestToken":"r1","channels":[{"name":"my-mod/new-information","publish":true},{"name":"other-mod/#","subscribe":true}]}
```

```json
{"type":"registered","requestToken":"r1","channels":[{"name":"my-mod/new-information","publish":true,"subscribe":false},{"name":"other-mod/#","publish":false,"subscribe":true}]}
```

`name` 完全由 mod 选择。发布方向必须为具体主题；订阅方向允许过滤器。至少一个方向为 true；同名声明合并方向，重复注册不产生重复订阅。单桥显式声明上限128，整个批次先校验再生效，不能通过声明扩大 ACL。

成功的 `publish`/`subscribe` 也是隐式声明，旧客户端无需新增注册帧即可通讯。隐式声明的诊断表最多记录128项，但此诊断限制不构成可发信息种类清单。显式注册只是声明接口，不自动建立订阅，不装载 handler，不要求主题已存在。断开时清理声明，重接由桥恢复。

声明在本机 `/status` 的 `bridges[].channels` 与调试页可见。显式声明可以在实际收发前公布接口方向；隐式声明保留既有桥的接入兼容。二者都不能把“未列出的信息种类”判为不存在，也不替代主题权限。

通道语法：`a/b/c`；不得空段、空白，长度至多512字符。发布侧不能含 `+`/`#`；订阅 `+` 匹配一层，末尾 `#` 匹配零或多层。授权规则必须覆盖整个过滤器；单层授权不能覆盖多层订阅。

## 帧清单

| 桥→枢纽 | 字段 | 应答 |
| --- | --- | --- |
| hello | wire、bridge；可选credential/token/role/displayName | welcome / denied后关闭 |
| register | channels；可选requestToken | registered / denied |
| publish | topic、body；可选id/correlation/replyTo/headers/requestToken/attachments | published / denied / error |
| request / inject | target、topic、body；可选既有标识/attachments | published / denied / error |
| respond | requestSeq、body；可选既有标识/attachments；地址和主题由原请求推导 | published / denied / error |
| blob_begin / blob_status / blob_chunk / blob_commit / blob_read / blob_release | 大体积对象分块通讯，详见请求／大体积规格 | blob_result / denied / error |
| release | seq数组，1–128个正安全整数；可选requestToken | released / denied / error |
| subscribe | filters非空数组；可选token/from/delivery/operations | subscribed，随后delivery及caught_up或catchup_truncated |
| unsubscribe | subscription | unsubscribed / error |
| ack | subscription、seq数组 | 有效确认无需应答；非法序号error |
| resume | subscription | 接受已报告留存缺口后继续扫描历史 |
| bye | 无 | 关闭 |

枢纽另发 `overflow`（有界投递丢失）和 `error`（帧/协议错误）。`denied` 在握手之外通常保留连接。未知帧明确 `FRAME_UNKNOWN`，非法JSON `FRAME_NOT_JSON`；不能把错误作为业务成功回执。

当前可信定向信封、动作过滤、SDK call 本地策略、附件授权与分块字段按[请求／大体积通讯](directed-and-bulk.md)。新增通讯动作不是业务信息类别，不改变任意通道与 body.kind 的中立性。

定向回应仍通过订阅投递：`respond` 的 `requestSeq` 只用于核验回应者并推导原请求主题和返回地址，不建立订阅、不直接向调用连接推送结果。往返双方均需获准发布和订阅原请求主题，实际接收还须通过 target principal/session 检查。JS SDK `call()` 先在原主题建立 `operations:["response"]` 订阅，再发送请求；只给调用方发布权限会以 `SUBSCRIBE_DENIED` 拒绝这条订阅。自行实现桥同样需要匹配订阅；合法回应被接受但调用方没有订阅时，记录继续留存，可由调用方之后按权限抽取。

## 发布与抽取

```json
{"type":"publish","topic":"my-mod/new-information","body":{"any":"双方自己的信息"},"id":"m1","correlation":"flow1","requestToken":"p1"}
```

`body` 是JSON对象这一通讯载体；标量/数组/二进制可由桥自行编码、包装。枢纽只检验JSON与载体边界，不规定对象内部字段。body 原始JSON文本被保存和转交，包括数值写法、转义及内部空白；接收程序自己的JSON解析器仍须自行处理数值精度。

`published` 含 seq、at，并原样回带可选 requestToken，表示枢纽接受，不表示订阅者已消费或业务已成功。发布失败同样回带 requestToken。id/correlation/replyTo/订阅token/requestToken 允许至多512字符的字符串；超限明确拒绝，不悄悄截断。headers可选对象，由双方约定。

发布不要求已有消费者或订阅。成功接受的消息默认受保护，未获得提供者释放许可前不得因历史段轮转清理。容量不允许继续写入时，先返回 `LOG_CAPACITY`，不回 `published`；既有消息保持可按权限和游标读取。

`LOG_CAPACITY` 拒绝帧可附 `logCapacity`，字段形状与 `/status.storage.log` 相同，是失败时的通讯存储快照：包含最旧受保护段的 owner/seq 摘要、空闲段位和活动段水位，不包含消息 body、凭据 token 或释放许可。诊断采样不可用时可缺省该字段，拒绝码语义不变。通过有接纳回执的 SDK API 发送时，可读取 `error.code` 与 `error.frame?.logCapacity` 展示原因；没有诊断字段不表示已接纳，真正接纳仍以 `published` 为准。快照只帮助程序判断容量阻塞，不授予释放其他提供者记录的权力。

```json
{"type":"subscribe","token":"s1","filters":["my-mod/#"],"from":0,"delivery":"bounded_ack"}
```

from是非负安全整数：取该序号之后的匹配信息；在线上帧中省略或使用`"now"`，取 Hub 处理该次 subscribe 时的当前水位之后的信息。可订未来主题。数字超过lastSeq，明确CURSOR_AHEAD并夹紧后建立订阅。`"resume"`是JS桥SDK的本地游标策略，不是线上from值。JS参考桥显式`from:'now'`，或省略from且无已保存游标时，发送连接`welcome.lastSeq`快照这一数字；不能把SDK这一策略等同于裸线协议的订阅时水位。

subscribed先回带token、subscription、filters、cursor、catchUpFrom/To。delivery含type、subscription、seq、at、topic、from、body及发布方提供的关联字段。枢纽来源身份为该连接的身份；载荷里的source等字段仍只是程序信息。

`token` 在线上可选；桥有多个待建立订阅时应为每次 subscribe 分配本连接内唯一的 token，以 `subscribed.token` 配对请求，再以该回执的 `subscription` 配对后续 delivery、caught_up、catchup_truncated。subscribed同时带token与subscription；caught_up以subscription标识订阅，不回带token。不能凭返回先后顺序把另一条订阅的追平水位认成自己的。

历史抽取就是带from的普通订阅，抽取非破坏。多个程序可分别读取同一记录；程序完成抽取后可unsubscribe，不需要面向某个业务种类的专用查询API。发送、读取、ACK、`caught_up` 或解除订阅不会清理记录。

每个订阅拥有自己的投递窗口和确认游标。一个订阅的多个过滤器同时匹配同一记录只产生一次投递；两条独立订阅的过滤器重叠时，同一 seq 可各投递一次，重连和历史重读也可能重复。程序应分别 ACK 每条订阅的实际投递，不能因另一订阅已 ACK 就推进当前订阅。需要只执行一次业务处理时，由程序协调并发去重与持久幂等，示例见[三程序接入的重叠订阅段](../onboarding.md#重叠订阅与程序去重)。`bounded_ack` 是有界确认模式，旧别名 `at_least_once` 不构成无条件至少一次保证。

## 提供者释放留存

```json
{"type":"release","seq":[1,2],"requestToken":"cleanup1"}
```

```json
{"type":"released","seq":[1,2],"requestToken":"cleanup1"}
```

提供者通过自己的 mod 提交 `release`，决定何时允许回收它提供的记录。`seq` 为1–128个正安全整数，指向仍保留的消息。Hub 整批校验存在性和归属；任何一项不存在或归他人所有，则全批拒绝，不部分释放。不存在或已经轮转清理返回 `MESSAGE_NOT_FOUND`；归属不符返回 `RELEASE_DENIED`；非法数组返回 `FRAME_INVALID`。仍保留的已释放记录重复释放幂等。成功回 `released`，并原样回带可选 `requestToken`；失败也回带该标识。

归属按稳定通讯身份维护：凭据模式使用凭据标识，同凭据的连接实例共享该归属；单身份模式使用 `bridgeId`，不依赖本次连接的临时实例后缀。发布记录的内部 `owner` 只用于通讯存储与释放授权，不进入交付载荷。旧日志缺少 `owner` 时回退到原记录 `from`；不能据此声称已恢复旧消息未记录的凭据关系。订阅权限、消费 ACK 或载荷声明不能取得他人的释放权。

`released` 仅表示提供者允许之后随历史段容量轮转清理。释放不立即删除记录，也不使它立即从历史读取中消失；何时真正清理依照 [可靠性与访问边界](reliability-access.md)。敏感撤回、全副本删除和独占领取尚未实现。

提供者可以根据自己的读取后策略、期限或其他业务条件选择释放时点。Hub 不读取这些条件，不自动在 ACK 后释放，不规定业务保留 mode。去重、业务成功、单消费者和业务重试策略由程序负责。

## 确认、水位与失败

ack只能确认该订阅实际送出的序号。重复有效确认不重复释放投递窗口；确认未送序号不能推进游标。乱序确认保留窗口占用，直到此前送出的消息已确认；cursor表示连续确认过的投递前缀，允许跨越未匹配主题的全局序号。ACK 不触发消息 `release`，不授权日志清理。

caught_up中cursor仍是确认位置，through是本次历史扫描/投递追平水位。它不证明全部载荷已处理、业务完成或上下文完整，也不清理消息。提供者释放后已清理的历史或其他已知历史缺失先发catchup_truncated，不回假完整；程序接受缺口后发resume继续，不接受则自己调整策略或断开。未释放的已接受消息不能因留存轮转变成缺口。

重要错误：FRAME_INVALID、HELLO_REQUIRED、ALREADY_HELLO、WIRE_VERSION_UNSUPPORTED、BRIDGE_ID_INVALID、BRIDGE_NOT_REGISTERED、CREDENTIAL_NOT_REGISTERED、CREDENTIAL_QUOTA_EXCEEDED、BRIDGE_TOKEN_REJECTED、BRIDGE_TOKEN_REQUIRED、HUB_AT_CAPACITY、CHANNEL_INVALID、TOO_MANY_CHANNELS、TOPIC_INVALID、PUBLISH_DENIED、BODY_NOT_OBJECT、PAYLOAD_TOO_LARGE、FILTER_INVALID、TOO_MANY_FILTERS、TOO_MANY_SUBSCRIPTIONS、SUBSCRIBE_DENIED、CURSOR_INVALID、CURSOR_AHEAD、DELIVERY_INVALID、SUBSCRIPTION_NOT_FOUND、ACK_INVALID、CATCHUP_STALLED、INGRESS_OVERFLOW、LOG_CAPACITY、RELEASE_DENIED、MESSAGE_NOT_FOUND、HUB_INTERNAL。

仅配置/版本错误不应持续空转重试；连接与容量故障可退避。消费失败的重试、业务请求超时、业务幂等和业务迟到回执由程序/桥决定。

## JS参考桥

Bridge提供connect、registerChannels、subscribe、unsubscribe、publish、publishConfirmed、release、ack、close及open/delivery/published/released/caughtUp/overflow/error等事件。publishConfirmed等待的是枢纽发布接受回执；release等待提供者释放回执，二者都不是业务结果。默认有消费回调时，按订阅顺序等所有回调成功完成、原子保存已处理游标，再ACK；无消费者或失败不ACK。`autoAck:false`由程序显式ack。参考桥不因消费成功自动release。

应先挂error与denied事件监听以记录诊断，同时对connect等异步API使用try/catch或.catch处理拒绝；握手denied发出denied事件并使connect Promise拒绝。参考桥使用自有事件回调表，不具有Node EventEmitter在无error监听时自动抛错的特殊规则；事件监听不能替代Promise拒绝处理。

同过滤器和同初始策略重复subscribe复用原订阅；明确更换from策略时先unsubscribe再建立，不能泄露旧订阅。重连恢复登记与订阅由桥完成。若需要业务状态耐久性，程序必须在提交消费确认之前完成自己的持久化；枢纽不会替它保存业务状态。

详见[可靠性与访问边界](reliability-access.md)与[验收与演进](../verification.md)。
