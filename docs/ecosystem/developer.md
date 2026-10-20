# 模块作者指南

[English](developer.en.md) · [模块声明](modules.md) · [独立程序接入](external-programs.md)

先确定程序负责的业务和公开契约，再选择 SDK 或自行实现枢纽桥。Hub 不规定页面、模型、业务数据或内部架构。

1. 用[通信协议](../specs/protocol.md)和对应 [JavaScript](../../sdk/javascript/README.md)、[Python](../../sdk/python/README.md)、[PowerShell](../../sdk/powershell/README.md) SDK 实现双向连接。
2. 约定主题、消息格式、定向请求与结果语义，校验调用方和回应方身份。抽取、ACK 与业务完成分别处理。
3. 普通程序可由自己的安装器运行。需要通信管理界面管理时，提供[模块清单](modules.md)及可选接入默认值，源码按模块目录或 ZIP 交付。
4. 在模块库导入，创建独立实例，检查解释器、公开参数和权限，审阅后启动到同一个全局 Hub。
5. 用真实消费者验证业务结果、断连、超时、重复投递和替换，再发布新的不可变模块版本。

源码自测由作者自行提供，例如 `node --test <自己的测试文件>`；不把 UI 显示“已连接”视为完整验收。

## 受管程序入口与私有运行配置

选择由通信管理界面启动程序时，管理器使用已审阅的解释器运行 `module.json` 的 `runtime.entry`，追加 `--runtime-config <file>`。例如 Node 入口收到 `node <entry> --runtime-config <file>`；Python 入口收到 `python -B -s <entry> --runtime-config <file>`。`<file>` 是本次运行生成的私有 JSON 文件，工作目录为该实例的 `stateDir`。源码和随附资源应相对入口文件定位，持久业务数据和桥游标写入 `stateDir`。

当前本机受管实例的配置结构如下；尖括号及端口是占位值，实际路径、身份和 token 由管理器生成：

```json
{
  "format": "world-hub.run/v1",
  "instanceId": "launcher-local",
  "componentId": "counter",
  "module": { "id": "example.counter", "version": "1.0.0" },
  "stateDir": "<absolute private instance state directory>",
  "settings": { "step": 1 },
  "topics": { "events": "counter/v1/events" },
  "peers": { "counter": { "principal": "<generated principal>" } },
  "bindings": [],
  "bridges": [{
    "slot": "main",
    "endpoint": "ws://127.0.0.1:12345/bridge",
    "bridgeId": "<generated bridge ID>",
    "credential": "<generated principal>",
    "principal": "<generated principal>",
    "token": "<private token>",
    "publish": [],
    "subscribe": ["counter/v1/events"]
  }]
}
```

- `bridges` 是数组，按清单声明的 `slot` 查找；每个声明的槽都要建立自己的连接。把该项的 `endpoint` 传给 `Bridge.url`，`bridgeId`、`credential`、`token` 原样传给同名选项。认证后的 `welcome.principal` 应等于该项的 `principal`，不能用模块 ID 或槽名替代认证身份。
- `topics` 把业务别名映射到实际主题；`bridges[].publish` / `subscribe` 已是实际主题列表。公开 `deployment.json` 中同名权限字段使用的则是别名。发消息、注册通道和订阅时使用实际主题，`settings` 是用户为该实例选定的公开业务设置对象。
- `peers` 按程序实例 ID 提供 `principal`。能力绑定的运行形态是 `{ "from": "提供者实例 ID", "to": "消费者实例 ID", "contract": { "id": "契约 ID", "version": "准确版本" } }`；通过绑定找到提供者，再从 `peers[from].principal` 取得定向地址，并校验业务消息的认证来源。
- 可选 `lifecycle` 是管理器提供的[生命周期 SDK](../../sdk/javascript/LIFECYCLE.md)描述符；准备依赖时还可能有 `deployment: { "directory": "<prepared code directory>" }`。不要把这些字段当成业务设置或固定本机路径。

配置文件及其中的 token 仅供本机进程使用。不要打印、上传、提交或放入模块 ZIP、公开示例、HTTP 响应和日志；诊断使用固定错误码，不回显整个配置或原始认证错误。公开模块清单和接入默认值不携带凭据。

下面是单个 `main` 桥槽、订阅 `events` 别名的 Node 22+ 最小入口。清单声明 `runtime: { "kind": "node", "entry": "program.mjs" }` 和 `bridges: ["main"]`；接入默认值声明该别名及订阅权限。从已安装包的 `sdk/javascript/` 取得 `bridge-kit.mjs` 和 `blob-client.mjs`，在模块内分别保存为 `sdk/bridge-kit.mjs` 与 `sdk/blob-client.mjs`；自己的 `business.mjs` 导出 `async handleMessage(message, { settings, topics, stateDir, bridge })`。处理器应校验业务正文与来源，只在业务处理成功后返回；SDK 会在其 Promise 成功后自动 ACK。

```js
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Bridge } from './sdk/bridge-kit.mjs';
import { handleMessage } from './business.mjs';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let bridge, ready = false, closing;
const input = createInterface({ input: process.stdin });
const stop = () => closing ??= (async () => {
  ready = false;
  await bridge?.close('Program stopped');
  input.close();
})();
input.on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.command === 'stop') void stop();
  if (command.command === 'health' && typeof command.id === 'string')
    emit({ event: 'module-health', id: command.id,
      ready: ready && !closing && bridge?.connected === true });
});
input.on('close', () => { void stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-config')
    throw new Error('Invalid startup arguments');
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const slot = config.bridges?.find(item => item.slot === 'main');
  const topic = config.topics?.events;
  if (config.format !== 'world-hub.run/v1' || !slot ||
      typeof topic !== 'string' || !slot.subscribe.includes(topic))
    throw new Error('Invalid runtime configuration');
  bridge = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId,
    credential: slot.credential, token: slot.token, autoAck: true,
    cursorFile: join(config.stateDir, 'main-cursor.json') });
  bridge.on('error', () => { ready = false; });
  bridge.on('close', () => { ready = false; });
  bridge.on('open', welcome => {
    if (welcome.authenticated !== true || welcome.principal !== slot.principal) void stop();
  });
  bridge.on('subscribed', () => { ready = !closing; });
  bridge.on('delivery', message => handleMessage(message,
    { settings: config.settings, topics: config.topics, stateDir: config.stateDir, bridge }));
  const welcome = await bridge.connect();
  if (welcome.authenticated !== true || welcome.principal !== slot.principal)
    throw new Error('Unexpected authenticated identity');
  const names = [...new Set([...slot.publish, ...slot.subscribe])];
  await bridge.registerChannels(names.map(name => ({ name,
    publish: slot.publish.includes(name), subscribe: slot.subscribe.includes(name) })));
  await bridge.subscribe([topic], { from: 'resume' });
  if (!closing) { ready = true; emit({ event: 'module-ready' }); }
} catch {
  emit({ event: 'module-diagnostic', code: 'MODULE_START_FAILED' });
  process.exitCode = 1;
  await stop();
}
```

管理器通过 stdin 发送逐行 JSON 的 `{"command":"health","id":"..."}` 与 `{"command":"stop"}`；入口通过 stdout 输出逐行 JSON 的 `module-ready`，以及带原 `id` 和布尔 `ready` 的 `module-health`。完成连接、订阅和自身业务初始化后再报告就绪，停止时关闭桥与自己的资源。示例中的就绪条件仅覆盖通信；有额外业务资源时一并检查。完整的设置、能力绑定、业务状态与定向消息实现可参考[软界面计数器入口](../../examples/soft-ui-modules/counter/program.mjs)。

这是独立管理层与其受管子进程之间的启动接口，不是 Hub 线协议强制的程序形态。独立程序仍可用自己的参数、配置和生命周期接入 Hub；业务处理、页面和业务存储始终留在程序自身。

可在 `deployment.json` 中建议新实例的运行方式：

```json
"executionDefaults": { "mode": "on-demand", "idleTimeoutMs": 60000 }
```

`mode` 必填，可为 `resident` 或 `on-demand`；可选空闲时间为 1000 至 86400000 的整数毫秒，省略时为 60000。模块组成员的 `configuration.executionDefaults` 优先于模块默认值；都未声明时，新实例默认为常驻／60 秒。导入审阅会显示最终策略与来源，实例仍以停止状态导入，允许唤醒的调用者为空。用户可覆盖本机策略；升级、降级和回退保留已有实例当前的本机策略。导出组仅携带模式与空闲时间，作者默认值不得包含 `allowedCallers` 或启动授权。更多边界见[常驻与按需运行](modules.md#常驻与按需运行)与[生命周期 SDK](../../sdk/javascript/LIFECYCLE.md)。

文字统计示例的[提供者契约](../modules/provider-contract.md)和[机器契约](../modules/text-statistics.contract.json)可用于独立实现。完成后用[互操作基准](interop.md)分别检查声明、桥行为和业务语义。

当前不提供整合包／模板生成 CLI，不再公开旧 `world-hub/runtime` API。历史作者样板和整包部署指南不作为当前分发入口。SDK 的通信导出和线协议保持独立。

## 分开分发本体、配置和数据

模块本体、配置和数据分别使用独立版本。配置只引用精确本体版本与源码摘要，不嵌入程序文件；数据集单独发布，私人备份只用于本机迁移。全局或局部范围共用本体库。应用配置、准备依赖、授权执行与恢复数据分别审阅，业务数据兼容性由模块定义。见[资源规格](../specs/module-resources.md)与[来源格式](sources.md)。
