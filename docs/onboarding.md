# mod 接入材料

所有程序都是普通通讯对端。桥的通道名和业务正文由程序自行决定；管理程序注记不参与认证和寻址。下面是最小接线示例，不规定自己的程序目录、语言、业务或 mod 形态。

## 先登记一个桥

打开源码或分发根目录的 `config/hub.json`，在已有 `acl.bridges` 对象中增加 `my.program` 这一项。下面只展示需要新增的部分：合并进自己的配置，保留其他桥、`acl.credentials`、监听、容量和持久路径，不以此片段替换整个文件。

~~~json
{
  "acl": {
    "bridges": {
      "my.program": {
        "allow": {
          "publish": ["example/my/#"],
          "subscribe": ["example/my/#"]
        }
      }
    }
  }
}
~~~

保存后停止并重新启动枢纽。桥以 `bridgeId: 'my.program'` 接入，不填 credential；发布和抽取限定在 `example/my/` 下的主题。这里的身份、主题和正文 kind 都可由接入者更换，须同步修改自己的接线配置。此无 token 样例只适用于当前可信本机回环环境，welcome 显示 `authenticated:false`。需要 token 时，在该桥条目设置自己的 token，并以 SDK 的 `token` 参数传入。

生成凭据片段可运行 `npm run token -- my.program`，必须给出目标 bridge 标识；它只打印新 token 和配置片段后退出，不启动 Hub、不自动写入配置。将 token 放进自己部署的未跟踪配置，并保留需要的主题权限，不能因片段示意 `#` 就扩大自己的授权。不要提交或公开输出中的 token。

## 可用的桥材料

| 语言／环境 | 桥文件 | 外部程序依赖 |
| --- | --- | --- |
| Node JS | [bridge-kit.mjs](../sdk/javascript/bridge-kit.mjs)、[blob-client.mjs](../sdk/javascript/blob-client.mjs) | Node 22.4.0 或以上；SDK 的自动 ACK／游标策略由调用程序选择 |
| 浏览器 | [manual-bridge.mjs](../src/management/manual-bridge.mjs) | 浏览器 WebSocket；工作台使用此桥，只做手动 ACK／释放 |
| Python | [hub_bridge.py](../sdk/python/hub_bridge.py)、[requirements.txt](../sdk/python/requirements.txt) | 接入者自己的 Python 与 websockets==15.0.1；项目曾实测 Python 3.14.0 |
| PowerShell | [HubBridge.psm1](../sdk/powershell/HubBridge.psm1)、[HubBridge.cs](../sdk/powershell/HubBridge.cs) | 接入者自己的 PowerShell 7；模块使用随带 .NET 编译通用 C# 桥 |

不用下载这些语言环境就能启动 Hub。各语言桥不会随 Hub 自动载入。源码 `tests/fixtures/` 中的 worker／ProtocolWorker 是可选测试程序，未随分发包提供，不规定接入形态。自己的程序也可直接调用桥、嵌入 mod 或使用 sidecar。

## 用自己的程序接入

例如把下面代码存为自己的程序目录中的 `my-program.mjs`。程序目录可放在整合包旁边；它和自己的 state 留在包外，可以继续对整合包运行严格 `verify.cmd`。之前把示例放在包根目录也能启动，但新增程序文件会被严格清单列为未登记文件；`--allow-config-change` 只放过配置内容，不放过新增程序文件。

~~~js
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const packageRoot = resolve(process.argv[2]);
const { Bridge } = await import(pathToFileURL(
  resolve(packageRoot, 'sdk/javascript/bridge-kit.mjs')).href);
const bridge = new Bridge({ bridgeId: 'my.program',
  url: process.argv[3] ?? 'ws://127.0.0.1:8790/bridge', autoAck: false });
bridge.on('error', info => console.error(JSON.stringify({
  event: 'bridge-error', code: info.code, message: info.message })));
bridge.on('denied', info => console.error(JSON.stringify({
  event: 'bridge-denied', code: info.code, message: info.message })));
const deadline = setTimeout(() => { void bridge.close('example timeout'); }, 15000);
try {
  const welcome = await bridge.connect();
  console.log(JSON.stringify({ event: 'connected', principal: welcome.principal }));
  await bridge.registerChannels([{ name: 'example/my/output', publish: true }]);
  console.log(JSON.stringify({ event: 'registered', channels: bridge.channels }));
  const receipt = await bridge.publishConfirmed('example/my/output',
    { kind: '接入者自选类型', text: '我的程序经 mod 发来信息' });
  console.log(JSON.stringify({ event: 'published', seq: receipt.seq }));
} catch (error) {
  console.error(JSON.stringify({ event: 'failed',
    code: error.code ?? 'PROGRAM_FAILED', message: error.message }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await bridge.close();
}
~~~

从自己的程序目录运行，例如在 PowerShell 中：

~~~powershell
& 'F:\你的目录\world-hub\runtime\node.exe' '.\my-program.mjs' 'F:\你的目录\world-hub'
~~~

两个绝对路径都替换为自己的实际解压目录。启动 Hub 的端口或 transport.path 改过时，可在包目录参数后加通讯地址，如 `'ws://127.0.0.1:8791/bridge'`。此示例只演示接入、动态声明与一次发布，成功打印 published 是枢纽接纳，不证明其他程序收到或完成业务；未发送 release，消息继续按提供者策略留存。自己的订阅、业务处理、ACK、游标及退出逻辑由程序安排。

先挂事件监听，再调用 `connect()`；未登记或凭据错误时，示例会打印拒绝事件和 `failed` 的可读原因，以退出码 1 结束。事件监听用于观察通讯事件，`catch` 用于处理本次等待失败，两者职责不同。SDK 在拒绝帧处理内先调用 Promise 的 reject，再同步触发 `denied`；等待者的 `catch` 随后运行，拒绝事件不等于另外触发 `error`。

项目源码的 `examples/three-programs/README.md` 提供完整三程序广播、调用与历史抽取示例，未随本包携带。包中已有 `demo.cmd` 的独立临时三程序演示；它是可选验证材料，默认启动入口不会运行它。

## 命名、凭据与多桥

桥可按 `pkg.alpha`、`pkg.beta` 等命名，但 `pkg.` 只是程序作者的命名约定。Hub 不按前缀分组、授予权限或自动装载 mod；每个桥或 credential 仍按精确配置登记。

`acl.bridges` 中的一个身份对应一条当前连接，同名重连接管旧连接。多桥可以分别登记不同 `acl.bridges` 身份，各有自己的主体与权限。要让多条并存连接共享稳定主体、主题权限和连接配额时，使用同一个 `acl.credentials` 项，设置 `maxConnections` 和主题权限；各连接声明 bridgeId 并使用同一 credential，实际传输实例身份与 session 由 welcome 给出。credential 模式也允许相同的声明 bridgeId 并存，桥名不同不是协议要求。

在同一个 Hub 内，同一个 credential 的桥共享稳定 principal、主题权限、连接配额及提供者释放归属。这意味着共享者能按协议释放该稳定主体的消息／对象，应由接入者按所需信任关系选择共享或独立凭据；桥显示名称和程序注记不产生这类共享。独立桥登记的 principal 是自己的桥身份。不同 Hub 各自配置 ACL、身份、配额和存储；两边出现相同 principal 字符串不会合并这些权限或数据。配置仍由部署方编辑并重启生效，Hub 不自动合并第三方包携带的 ACL，也不认识第三方包业务。

## 同一程序连接多个 Hub

一个程序可以同时建立多条桥连接，分别连接不同 Hub。各 Hub 独立启动，使用独立持久数据目录；程序为各连接选择地址和接线身份。Hub 不替程序决定这些连接的业务关系。

若程序使用本页 Node SDK 的文件游标 `cursorFile`，应为每个逻辑 Hub 部署、每个桥实例选择独立文件。例如程序配置稳定的部署标识 `hub-alpha`／`hub-beta` 和实例标识 `reader-1`，在自己的状态根目录分别使用 `hub-alpha/reader-1.cursor.json`、`hub-beta/reader-1.cursor.json`。这些标识及状态管理方式由程序选择，不是枢纽协议字段。

该 SDK 保存的是实例内游标表的完整快照，同一文件不提供多实例合并或写入锁。游标键默认只含桥／实例标识和订阅过滤器，不含 Hub 部署标识；仅改 `instanceId` 后仍共用文件，也可能覆盖另一实例的快照。同一桥名、相同过滤器跨 Hub 共用文件时，低水位覆盖可能导致重读，高水位来自另一 Hub 时可能让 `from: 'resume'` 跳过未抽取消息。文件隔离同时避免键冲突与快照覆盖。未 ACK、读取或此类跳过均不释放 Hub 中提供者仍保护的消息。

部署标识须由程序稳定配置，不能只以 URL 的端口或默认 `hub.id` 判定：不同主机可用同一端口，地址／端口会变，多个 Hub 也可使用相同 `hub.id`。不用文件游标的桥可自行实现状态管理；枢纽不规定程序的状态文件形态。

请按[通讯契约](../docs/specs/protocol.md)、[请求／大体积通讯](../docs/specs/directed-and-bulk.md)和[跨语言桥合同](../docs/specs/bridge-interoperability.md)核对线协议、原文保真、订阅屏障及按功能适用的条件。收到或 ACK 不等于业务完成；只有提供者按自己的策略释放消息／附件。

## 自研桥连接等待与订阅回执配对

裸 WebSocket 构造后立即开始连接。在同一段同步代码里注册 `open`、`error`、`close` 和 `message`，保存已建立的连接 Promise 后再等待；不要把监听注册推迟到下一次使用连接时。连接及帧等待都要有限超时，`close` 或 `error` 应立即拒绝尚未完成的等待，并附已收帧诊断。单纯的关闭不会让一个正常使用定时器与超时判断的 JavaScript 循环永久跳过超时分支；若循环仍挂起，还须检查探针自己的时钟、等待与控制流。

每次发送 `subscribe` 使用本连接内唯一的 `token`，先按 `subscribed.token` 找到建立回执，再取其中的 `subscription` 匹配后续 `delivery`、`caught_up` 或 `catchup_truncated`。`subscribed` 同时含 **token 与 subscription**，`caught_up` 使用 subscription；不能拿“下一条 caught_up”或另一订阅的水位代替自己的回执。

下面是可独立运行的短期线协议片段：保存为根目录 `裸线接入.mjs`，在前面的样例枢纽启动后用 Node 22 运行。它只验证握手和两条订阅的配对，不包含消费处理、ACK、恢复或附件实现；遇到任一 `denied`／`error` 帧便停止并保留原帧，完整桥应按各错误的语义处理。某些拒绝帧没有订阅 token，不能在并发订阅时猜它属于哪次请求。此样例保留全部已收帧，长期桥应自行限制诊断缓存并保护其中的正文。

```js
const frames = [];
const pending = new Set();
let stopped;
const diagnostic = (message) => Object.assign(new Error(message), { frames: [...frames] });
const ws = new WebSocket('ws://127.0.0.1:8790/bridge');
const opened = new Promise((resolve, reject) => {
  const timer = setTimeout(() => abort('连接超时'), 5000);
  function abort(message, frame) {
    if (stopped) return;
    stopped = diagnostic(message);
    if (frame) stopped.frame = frame;
    clearTimeout(timer);
    reject(stopped);
    for (const wait of [...pending]) wait.finish(stopped);
  }
  ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  ws.addEventListener('error', () => abort('WebSocket error'));
  ws.addEventListener('close', (event) => abort(`关闭 ${event.code}: ${event.reason}`));
  ws.addEventListener('message', (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { abort('收到非法 JSON'); return; }
    frames.push(frame);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { abort('收到非法帧'); return; }
    if (['denied', 'error'].includes(frame.type)) { abort(`枢纽拒绝: ${frame.code}`, frame); return; }
    for (const wait of [...pending]) {
      if (wait.match(frame)) wait.finish(null, frame);
    }
  });
});
opened.catch(() => {}); // 立即标记拒绝已被观察，下面仍 await 原 Promise 取得错误。
function waitFrame(match, timeoutMs = 5000) {
  if (stopped) return Promise.reject(stopped);
  const found = frames.find(match);
  if (found) return Promise.resolve(found);
  const result = new Promise((resolve, reject) => {
    const wait = { match, finish(error, frame) {
      clearTimeout(timer);
      pending.delete(wait);
      error ? reject(error) : resolve(frame);
    } };
    const timer = setTimeout(() => wait.finish(diagnostic('等帧超时')), timeoutMs);
    pending.add(wait);
  });
  result.catch(() => {});
  return result;
}
let nextToken = 0;
async function subscribe(filters) {
  const token = `s-${++nextToken}`;
  const receipt = waitFrame((frame) => frame.type === 'subscribed' && frame.token === token);
  ws.send(JSON.stringify({ type: 'subscribe', token, filters, from: 'now' }));
  const sub = await receipt;
  const barrier = await waitFrame((frame) =>
    ['caught_up', 'catchup_truncated'].includes(frame.type) && frame.subscription === sub.subscription);
  if (barrier.type !== 'caught_up') throw diagnostic('历史存在缺口，须由程序决定如何继续');
  return { subscription: sub.subscription, through: barrier.through };
}
try {
  await opened;
  const greeting = waitFrame((frame) => frame.type === 'welcome');
  ws.send(JSON.stringify({ type: 'hello', wire: '0.1', bridge: 'my.program' }));
  await greeting;
  console.log(await Promise.all([subscribe(['example/my/output']), subscribe(['example/my/input'])]));
} catch (error) {
  console.error(error.message, error.frames ?? frames);
  process.exitCode = 1;
} finally {
  if (ws.readyState < 2) ws.close();
}
```

`waitFrame` 会检查缓存，因此即使建立回执与追平帧紧邻到达，也不会因为刚开始等下一帧就漏掉已收回执。`caught_up.through` 只表示该订阅本次历史扫描／投递追平；它不等于消费者处理完成、ACK 或提供者 release，也不保证其他订阅或业务上下文完整。

裸线协议的省略 `from` 与 `from:'now'` 取 **Hub 处理这次 subscribe 时** 的水位。JS SDK 则在未有保存游标且省略 `from`、或显式 `from:'now'` 时，发送 `welcome.lastSeq` 这一连接快照；连接建立后、调用订阅前新接受的消息仍可被它读到。要读取全部仍留存的历史，明确使用数字 `from:0`；SDK 的 `from:'resume'` 是本地游标策略，不是线协议值。

## 重叠订阅与程序去重

一个订阅内部的多个过滤器即使都匹配，也只投递一次；独立订阅各自匹配、各自确认。重连、历史重读和重叠订阅都可能带来重复。`bounded_ack` 只承诺有界确认窗口和可按留存游标恢复；兼容别名 `at_least_once` 不表示任何情况都保证至少一次。

下面片段用于同一桥、同一枢纽历史范围内的进程内去重。共享 Promise 避免两条订阅并发执行同一 seq；处理失败后删除记录并向两个回调传播失败，默认桥不会 ACK 失败工作。成功完成后保留最近 1024 个序号，重复回调也正常结束，使每份投递各自获得 ACK。

```js
const workBySeq = new Map();
const completed = [];
bridge.on('delivery', async (message) => {
  let work = workBySeq.get(message.seq);
  if (!work) {
    work = Promise.resolve().then(() => processMessage(message));
    workBySeq.set(message.seq, work);
    work.then(() => {
      completed.push(message.seq);
      while (completed.length > 1024) workBySeq.delete(completed.shift());
    }, () => {
      if (workBySeq.get(message.seq) === work) workBySeq.delete(message.seq);
    });
  }
  await work;
});
```

`processMessage` 是程序自己的处理函数。此片段不保证重启后的幂等，也无法记住已经超出缓存的序号；重新初始化枢纽历史时应重建去重状态。跨进程、跨重启或跨轮业务需要程序自己的持久幂等键和副作用提交策略。不要用 subscription 作为同一记录的业务去重键，也不要因为一条订阅已确认而省略另一条的 ACK。去重与 ACK 均不改变提供者的 release 决定。
