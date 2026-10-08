# Node JavaScript mod 桥

本 SDK 采用仓库 [MIT 许可](../../LICENSE)。通过 npm 的稳定导出入口使用时，安装与导入方法见[npm 包](../../docs/npm.md)；下文相对路径用于源码仓库。

`bridge-kit.mjs` 是供外部程序选用的 Node 桥；`blob-client.mjs` 提供外部文件／流上传与下载。Hub 不加载这些程序接口。运行需要 Node 22.4.0 或以上，没有 npm 依赖。浏览器使用独立的 `src/management/manual-bridge.mjs`，不能直接导入含 Node 文件 API 的模块。

最小登记与发布示例见[接入说明](../../docs/onboarding.md)。先登记对应身份和主题 ACL，先监听 `error`／`denied`，再用 try/catch 处理异步 API；诊断事件不能替代 Promise 的拒绝处理。

| 接口 | 意义 |
| --- | --- |
| `connect()`、`close()` | 等握手、有限关闭；SDK 可在断线后按自己的策略重连 |
| `registerChannels(channels)` | mod 声明合法主题与方向，不建立业务 handler 或扩大 ACL |
| `publish()`、`publishConfirmed()` | 本地发送与等待 Hub 接纳是不同接口 |
| `subscribe()`、`replay()`、`unsubscribe()`、`cursorOf()` | 订阅、显式重读、清理和本地已处理游标 |
| `ack(message)`、`flushAcks()` | 确认本连接订阅的实际投递，不释放消息 |
| `requestTo()`、`respond()`、`sendTo()`、`call()` | 定向请求、可信回应、注入及有界本地往返等待 |
| `release(seqs)`、`releaseBlob(id)` | 仅以自己的提供者身份许可后续回收 |
| `uploadFile()`、`uploadStream()`、`downloadFile()`、`readAttachment()` | 程序侧路径／流便利层，分块和完整性核对 |

默认有 delivery 消费回调时，SDK 按订阅顺序等待所有回调成功完成、保存配置的文件游标后才 ACK；没有消费者或处理失败不自动 ACK。`autoAck:false` 由程序自行确认。没有自动 release。业务成功、持久幂等和副作用提交仍由程序负责。

裸 wire 的 `from:"now"` 取处理订阅时水位；该 SDK 无保存游标时使用握手 `welcome.lastSeq` 数字快照。`from:"resume"` 是 SDK 本地策略，不是线上游标值。重叠订阅、历史与重连可以重复交付，程序须按自己的业务决定去重和分别 ACK。

文件游标应按逻辑 Hub 部署与桥实例独立保存。`cursorFile` 写整个快照，不提供共享写入合并或锁；只换 `instanceId` 仍共用文件会互相覆盖。SDK 不在默认游标键里加入 Hub 部署 ID，不能仅凭同端口、URL 或 `hub.id` 判断是同一个部署。

`connect()` 可继续等待重连，短期调用者应设置自己的总期限并在期限后显式 close；本地超时不能撤销已接受消息。`call()` 默认本地等待 30 秒，默认并发上限 32；请求主题双方都需要发布和订阅权限。诊断观察回调失败不改变已成功的握手或通讯收据，但 delivery 消费回调会影响消费成功与自动 ACK 条件。

传入 JS 对象会经 JS JSON 序列化，程序须自行处理大数或既有原文；Hub 的 body 原文合同不能补回桥端序列化已损失的精度。完整合同见[通讯契约](../../docs/specs/protocol.md)和[请求／大对象](../../docs/specs/directed-and-bulk.md)。

## SDK 的重读、复用与实例游标

`replay(filters,{from:0,operations?})` 替换相同过滤器与 operations 的订阅，明确从给定序号之后重新读取；省略 from 为零。它返回订阅建立回执，随后通过普通 delivery 接收历史，追平后仍保持实时订阅。它不改变其他重叠订阅，重连时仍恢复已提交游标，不再自动从零开始。`caughtUp` 只表示扫描追平，程序自己的处理函数仍需自行完成。

```js
bridge.on('subscriptionReused', (event) => {
  console.log('复用订阅', event.subscription, '当前确认位置', event.cursor);
});
const receipt = await bridge.subscribe(['example/my/output'], { from: 0 });
// 再次 subscribe 相同初始策略会返回 deduped:true 并发出 subscriptionReused。
// 要真正重读，请显式使用 replay；若只要回应，须保留对应 operations 条件。
await bridge.replay(['example/my/output'], { from: 0 });
```

例如初始订阅使用 `operations:['response']`，replay 也传同一条件；不传则是另一条订阅，原回应订阅继续存在。

默认游标路径仍是 `.hub/cursors/<bridgeId>.json`，兼容旧单实例程序。独立实例不能共同写这个文件；桥不合并多个进程的游标提交。建议每个实例使用稳定的本地 `instanceId`，在 Bridge 选项与 `defaultCursorPath(bridgeId,instanceId)` 中传入同一值，同时得到独立键和 `.hub/cursors/instances/b-<bridgeId>/i-<编码后的instanceId>.json` 文件；重启该实例时保持此值，不使用每次变化的 session。也可显式配置各自独立的 `cursorFile`。instanceId 编码后须为 1–64 个文件名字符；不配置 cursorFile 时，游标只保存在当前桥的内存中。

```js
const bridgeId = 'shared-worker';
const instanceId = 'window-a'; // 另一个独立实例用 window-b，重启仍使用原值
const instanceBridge = new Bridge({
  bridgeId,
  credential: 'shared-workers',
  url: 'ws://127.0.0.1:8790/bridge',
  instanceId,
  cursorFile: defaultCursorPath(bridgeId, instanceId),
});
```

这段多实例配置需要部署方先登记 `acl.credentials.shared-workers`、连接额度与主题权限；单身份参考配置使用 `acl.bridges`，同名连接会接管旧连接。`instanceId` 只隔离外部桥的本地游标，不发送给 Hub，不是认证身份、principal 或 Hub 分配的 session。它也不让两个进程安全共享同一个显式游标文件。
