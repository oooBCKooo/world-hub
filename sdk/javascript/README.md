# Node JavaScript mod 桥

本 SDK 采用仓库 [MIT 许可](../../LICENSE)。通过 npm 的稳定导出入口使用时，安装与导入方法见[npm 包](../../docs/npm.md)；下文相对路径用于源码仓库。

`bridge-kit.mjs` 是供外部程序选用的 Node 桥；`blob-client.mjs` 提供外部文件／流上传与下载。Hub 不加载这些程序接口。运行需要 Node 22.4.0 或以上，没有 npm 依赖。浏览器使用独立的 `src/management/manual-bridge.mjs`，不能直接导入含 Node 文件 API 的模块。

独立实现可替换能力模块时，阅读[提供者接入契约](../../docs/modules/provider-contract.md)及其机器契约。它完整规定外部目录登记、业务输入输出和部署方接线；下文完整运行例仅演示通用 echo 通讯，不提供统计业务实现。

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

## 构造、事件和方法参数

在独立 ESM 程序中使用 `import { Bridge } from 'world-hub/bridge'`。直接携带源码 SDK 时导入 `bridge-kit.mjs`，它旁边还须有 `blob-client.mjs`；不需要导入 Hub 内部实现或任何共享业务示例。

```js
const bridge = new Bridge({
  url: wiring.endpoint,
  bridgeId: wiring.bridgeId,
  credential: wiring.credential, // 凭据标识，不是秘密；单桥 ACL 模式可省略
  token: secretToken,
  role: 'both',                // 默认 both；只描述桥方向，不授予业务权力
  displayName: 'My program',   // 可选显示信息，不是路由地址
  autoAck: true,              // 默认 true；成功处理后确认消费
  reconnectMs: 400,           // 默认 400ms，失败后递增，最高 5000ms
  subscribeTimeoutMs: 8000,
  maxPendingCalls: 32,
  cursorFile: '/my-state/hub-a/provider.cursor.json', // 可省略，改为内存游标
  instanceId: 'worker-1',     // 可省略，仅隔离本地实例游标键
});
```

部署方提供 endpoint、身份、token 和 ACL。握手后以 `welcome.principal` 核对预期主体，需要认证时要求 `welcome.authenticated === true`；`welcome.session` 是本连接临时地址，重连会改变。`welcome.features` 包含 `directed-v1` 才能定向请求；SDK 方法会检查。`credential` 不是某个示例 CLI 选项所称的秘密字符串，SDK 秘密始终传入 `token`。

`on(event, callback)` 返回 bridge，可链式调用。支持 `open`、`delivery`、`published`、`registered`、`released`、`subscribed`、`subscriptionReused`、`unsubscribed`、`caughtUp`、`overflow`、`denied`、`error`、`close`。事件不是 Node EventEmitter；未监听 error 不会触发其特殊抛错行为。没有 `off()`；按桥生命周期安排监听器。

`open` 在每次成功握手及恢复后触发，含 `principal`、`session`、`authenticated`、`features`、`lastSeq` 和 `reconnect`。delivery 回调可以返回 Promise，SDK 按该订阅顺序等待。不同订阅可并发，多个 delivery 回调依次执行；call 的回应也会传给全局 delivery 回调，因此自己的 handler 必须先筛选 `operation` 和 `topic`。

定向 delivery 包含以下可用字段：

| 字段 | 意义 |
| --- | --- |
| `subscription`、`seq`、`at`、`topic` | 本次订阅及留存记录的通讯标识／时间／主题 |
| `operation` | `request`、`response`、`inject` 或 `publish` |
| `from` | 发件连接实例身份 |
| `fromPrincipal`、`senderSession` | Hub 确定的稳定发件主体／发件连接 session；定向通讯才有这些字段 |
| `target` | 定向目标 `{principal,session?}` |
| `requestSeq` | response 对应的原请求序号 |
| `correlation` 等可选标识、`headers`、`attachments` | 发件方选择的关联信息或可信附件描述符；不得替代身份核对 |
| `body` | 解析后的应用正文；字段含义由程序自己的业务契约定义 |

本机受信回环模式可以 `authenticated:false`；delivery 没有一个单独的“发件人已认证”布尔字段，认证前提来自部署配置及参与者核对 welcome。不要把正文 `principal`、`provider`、显示名称或程序注记当成通讯来源。

| 方法签名 | 返回与默认策略 |
| --- | --- |
| `await connect()` | welcome；已经连接时返回当前 welcome，断线可继续等待重连；没有内置总连接期限 |
| `await close(reason = 'bridge done')` | 终止重连、刷新可用 ACK 并拒绝本地未完成等待；不等待业务工作完成、不 release |
| `await registerChannels(channels, {timeoutMs} = {})` | `registered` 帧；默认等收据 8000ms；数组元素 `{name,publish?,subscribe?}`，至少一个方向为 true |
| `await subscribe(filters, {from,operations} = {})` | 建立回执 `{subscription,filters,cursor,catchUpTo?}`，复用可有 `deduped:true`；默认等建立 8000ms |
| `await requestTo(target, topic, body, opts = {})` | `published` 接纳帧 `{type,seq,at,requestToken,...}`；默认等接纳 8000ms，不等待回应 |
| `await respond(requestOrSeq, body, opts = {})` | 同样只等回应的 published 接纳帧；传原 delivery 对象或其 seq |
| `await sendTo(target, topic, body, opts = {})` | inject 接纳帧，不解释接收者的业务执行 |
| `await call(target, topic, body, opts = {})` | `{request:published帧,response:delivery帧}`；先建立同主题 response 订阅，再 requestTo，等待第一份匹配回应 |
| `ack(delivery)` 或 `ack(subscription, seq)` | boolean，确认该订阅实际收到的记录；优先传原 delivery 以拒绝旧连接的过期对象 |
| `flushAcks()` | boolean，尝试发送本地待确认批次，无业务回执 |
| `await unsubscribe(subscriptionOrToken)` | unsubscribed 回执；没有本地订阅时返回 missing 结果，不 release |
| `await release(seqs, {timeoutMs} = {})` | released 回执；数组 1–128 个自己提供的留存 seq，默认等收据 8000ms |

`target` 为 `{principal,session?}`。省略 session 时同主体的多个获准实例都可能抽取；指定 session 只给该连接，新连接不会接管旧 session 请求。Hub 不挑选唯一业务执行者。

requestTo、respond、sendTo、publishConfirmed 的 opts 可用 `timeoutMs` 控制接纳等待，并可附 `id`、`correlation`、`replyTo`、`headers`、`attachments`。respond 的返回目标、主题、可信 requestSeq 从原请求推导，不能用选项改回程地址。标识和 headers 是应用关联信息，不改变身份或授权。

call 的 `timeoutMs` 默认 30000，是包含订阅准备在内的本地回应等待；`receiptTimeoutMs` 默认 `min(timeoutMs,8000)`，控制 requestTo 接纳等待。其余消息选项与 requestTo 相同。默认最多 32 个待完成或未 ACK 的 call，达到上限拒绝并设置 `error.code='CALL_LIMIT'`。`autoAck:false` 时成功 call 的专用订阅保留到 `ack(response)`、显式移除或关闭；默认自动 ACK 会随后清理专用订阅。

call 核对响应的原 requestSeq 和目标 principal；指定 session 的请求还由 Hub 约束回应者 session。它只采用第一份匹配回应。要收多份或迟到回应，使用 requestTo 加普通 `operations:['response']` 订阅，按自己的关联 ID、requestSeq、fromPrincipal／senderSession 处理。call 超时或断线会抛出错误，但错误不承诺携带已接纳请求收据；需要在未知结果时仍记录 requestSeq，应单独调用 requestTo 保存收据。

任何接纳等待超时或断线均可能发生在 Hub 已保存信息后；没有收据不等于没有接纳。SDK 不自动重发 requestTo／业务 call，不取消业务，也不释放留存。明确 Hub 拒绝可读取 `error.code` 与 `error.frame`；本地超时、断线通常只有 message。error／denied 事件用于诊断，同时必须 catch 本次 Promise 的拒绝。

`subscribe` 回执是**订阅建立屏障**：先安装 delivery 回调，await 建立，再公布服务可用或发送依赖回应的请求。它不是历史追平或业务完成屏障；`caughtUp.subscription` 可与回执 subscription 配对，through 只表示扫描／投递追平。from 的数字起点表示该 seq 之后；`'now'` 是 welcome.lastSeq 快照；`'resume'` 是保存游标或 0；省略 from 为保存游标或 welcome 快照。重叠订阅、历史和重连可能重复投递。

## 可独立运行的请求与回应

下面两个程序只用 SDK 实现 echo。部署方先登记两个独立凭据及各自 token，并为双方开放 `example/echo` 的发布和订阅权限。它们不提供统计能力或目录服务；业务 handler 和主题由程序作者替换。

安装 `npm install world-hub` 后，将提供者保存为 `echo-provider.mjs`：

```js
import { Bridge } from 'world-hub/bridge';
const topic = process.env.WORLD_HUB_TOPIC ?? 'example/echo';
const principal = process.env.WORLD_HUB_PRINCIPAL;
const caller = process.env.WORLD_HUB_CALLER;
if (!principal || !caller || !process.env.WORLD_HUB_TOKEN) {
  throw new Error('Set WORLD_HUB_PRINCIPAL, WORLD_HUB_CALLER and WORLD_HUB_TOKEN');
}
const bridge = new Bridge({
  url: process.env.WORLD_HUB_URL ?? 'ws://127.0.0.1:8790/bridge',
  bridgeId: process.env.WORLD_HUB_BRIDGE ?? `${principal}.mod`,
  credential: principal,
  token: process.env.WORLD_HUB_TOKEN,
});
let stopping = false;
const stop = async () => { stopping = true; await bridge.close('provider stopped'); };
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
bridge.on('error', event => console.error('bridge diagnostic', event.code, event.message));
bridge.on('denied', event => console.error('bridge denied', event.code, event.message));
bridge.on('delivery', async message => {
  if (stopping || message.operation !== 'request' || message.topic !== topic) return;
  let result;
  if (message.fromPrincipal !== caller) {
    result = { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Caller not authorized' } };
  } else if (typeof message.body?.text !== 'string') {
    result = { ok: false, error: { code: 'INPUT_INVALID', message: 'Expected text' } };
  } else {
    result = { ok: true, text: message.body.text };
  }
  await bridge.respond(message, result); // callback ends after Hub accepts response
});
const deadline = setTimeout(() => { void bridge.close('startup timeout'); }, 10000);
try {
  const welcome = await bridge.connect();
  if (welcome.principal !== principal || welcome.authenticated !== true) {
    throw new Error('Unexpected or unauthenticated principal');
  }
  await bridge.registerChannels([{ name: topic, publish: true, subscribe: true }]);
  await bridge.subscribe([topic], { operations: ['request'], from: 'now' });
  clearTimeout(deadline);
  console.log('ready', welcome.principal, welcome.session);
} catch (error) {
  if (!stopping) { console.error(error.code ?? 'PROGRAM_FAILED', error.message); process.exitCode = 1; }
  await stop();
} finally {
  clearTimeout(deadline);
}
```

提供者保持前台运行，Ctrl+C 停止。在提供者终端设置 `WORLD_HUB_PRINCIPAL='example.provider'`、`WORLD_HUB_CALLER='example.caller'` 和自己的 `WORLD_HUB_TOKEN` 后，运行 `node echo-provider.mjs`。凭据标识须在 Hub 实际登记；桥名也须满足 1–64 字符标识约束。这些环境变量是这个示例自己的配置形式，不是 SDK 或模块契约要求。

将调用方保存为 `echo-caller.mjs`，在另一个终端设置 `WORLD_HUB_PRINCIPAL='example.caller'`、`WORLD_HUB_TARGET='example.provider'` 及调用方自己的 token，再运行 `node echo-caller.mjs`：

```js
import { Bridge } from 'world-hub/bridge';
const principal = process.env.WORLD_HUB_PRINCIPAL;
const targetPrincipal = process.env.WORLD_HUB_TARGET;
if (!principal || !targetPrincipal || !process.env.WORLD_HUB_TOKEN) {
  throw new Error('Set WORLD_HUB_PRINCIPAL, WORLD_HUB_TARGET and WORLD_HUB_TOKEN');
}
const topic = process.env.WORLD_HUB_TOPIC ?? 'example/echo';
const bridge = new Bridge({
  url: process.env.WORLD_HUB_URL ?? 'ws://127.0.0.1:8790/bridge',
  bridgeId: process.env.WORLD_HUB_BRIDGE ?? `${principal}.mod`,
  credential: principal,
  token: process.env.WORLD_HUB_TOKEN,
});
bridge.on('error', event => console.error('bridge diagnostic', event.code, event.message));
bridge.on('denied', event => console.error('bridge denied', event.code, event.message));
const deadline = setTimeout(() => { void bridge.close('caller total timeout'); }, 10000);
try {
  const welcome = await bridge.connect();
  if (welcome.principal !== principal || welcome.authenticated !== true) {
    throw new Error('Unexpected or unauthenticated principal');
  }
  await bridge.registerChannels([{ name: topic, publish: true, subscribe: true }]);
  const result = await bridge.call({ principal: targetPrincipal }, topic,
    { text: 'Hello 🌍' }, { timeoutMs: 3000, receiptTimeoutMs: 2000 });
  console.log('accepted request', result.request.seq, 'response', result.response.seq);
  console.log(result.response.body); // inspect application result separately
} catch (error) {
  console.error(error.code ?? 'LOCAL_WAIT_FAILED', error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await bridge.close();
}
```

等待提供者打印 ready 后调用。call 自己完成 response 订阅建立屏障；没有全局 delivery handler 也可以自动 ACK 它匹配的回应。默认 ACK 清理可能在 call 返回后继续进行，调用方 close 会完成本地清理。上例没有文件游标或持久幂等；重新执行可能再次调用。启动失败、ACL 拒绝、授权失败和本地等待失败应分别观察，打印 request 接纳序号本身不代表 echo 业务成功。

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
