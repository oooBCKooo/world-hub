# 独立程序接入：桌面宿主、原有软件与模块桥

[English](external-programs.en.md) · [SDK](../../sdk/javascript/README.md) · [通信协议](../specs/protocol.md)

程序可以自行安装依赖、管理状态、创建窗口和启动它拥有的子进程，再通过模块桥接入 Hub。Electron、浏览器、游戏、数据库服务与现有 CLI 都可以采用这种方式。相对 Hub，它们与 Launcher 管理的程序是同类通信参与者；Hub 不根据程序形态决定其业务。

Launcher 的可选 Runtime v1 则是一种有限的部署方案：需要 `module.json`、`pack.json` 和 `pack.lock`，支持规定的 Node/Python 入口、就绪/健康/停止接口及权限声明。它不是所有程序接入的前提，也不要求程序无状态。原生桌面宿主不能仅靠添加一个 `module.json` 就获得 Electron 依赖准备、窗口管理和完整生命周期支持。

## 选择正确的入口

| 手中的内容 | 操作 |
| --- | --- |
| 普通程序源码、Electron 项目或已有可执行程序 | 按程序自己的说明安装、启动，给它配置 Hub 地址、桥身份和权限；无需导入 Launcher |
| 含 `module.json` 的 Runtime 模块源码 | 在创作工作台中用作新增/替换候选，由作者组合成整合包 |
| 含 `pack.json` 和 `pack.lock` 的整合包根目录 | 在 Launcher 中检查、导入、审阅并授权启动 |

Runtime v1 的源码分发限制是每文件 8 MiB、合计 64 MiB、4096 个文件。已安装的 `node_modules`、Electron 二进制与其他本机运行时可能超限；不要自动删文件或省略依赖后把残缺包当作可运行模块。这些限制不是 Hub 对二进制、UI、子进程或业务类型的禁令，也不代表已实施 OS 沙箱。需要另一种部署方式时，由程序的安装器/宿主负责，或由作者适配明确支持的部署 profile。

## 配置一个真实的双向连接

以下名称与主题是**应用示例**，不是 Hub 内置协议或预留类别。应用作者可以自行选择其他值。

1. 为显示程序和业务程序分别生成独立的随机 token。运行下面的 Node 命令两次，每次生成一个 token；它不登记身份。将 token 存放在自己的私人配置中。
2. 在私人 Hub 配置中登记身份及最小主题权限。默认公开配置不会自动授权新程序；只写主题名不足以连接。
3. 分别启动 Hub 与两个程序。收到连接、通道登记和订阅确认后，再发送需要消费的信息。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

将下面的两个 token 占位符替换为本机生成的不同值，保存到自己的私人 `hub.json`，不要提交或分发：

```json
{
  "version": "0.1",
  "hub": { "id": "my-local-hub" },
  "transport": { "host": "127.0.0.1", "port": 8890, "path": "/bridge" },
  "log": { "enabled": true, "dir": "./event-log" },
  "blobs": { "dir": "./blobs" },
  "management": { "stateFile": "./management.json" },
  "acl": {
    "defaultDeny": true,
    "allowUnlistedBridges": false,
    "bridges": {},
    "credentials": {
      "app.display": {
        "token": "<display-token-generated-locally>",
        "maxConnections": 1,
        "allow": { "publish": ["app/panel/events"], "subscribe": ["app/panel/commands"] }
      },
      "app.worker": {
        "token": "<worker-token-generated-locally>",
        "maxConnections": 1,
        "allow": { "publish": ["app/panel/commands"], "subscribe": ["app/panel/events"] }
      }
    }
  }
}
```

```powershell
world-hub --config '<私人配置目录>/hub.json'
```

显示程序使用 `credential:'app.display'`、它自己的 token 和桥标识，例如 `bridgeId:'app.display.mod'`。业务程序使用 `credential:'app.worker'` 与另一个 token。**credential 是登记的身份 ID，token 才是认证秘密**。不要把 token 填进 credential 字段。使用 `acl.bridges` 单连接登记方式时则按 SDK 文档省略 credential。

显示程序的 JavaScript 适配片段如下；它的窗口创建和视图状态实现留在程序自身：

```javascript
import { Bridge } from 'world-hub/bridge';
import { join } from 'node:path';

const commands = 'app/panel/commands';
const events = 'app/panel/events';
const bridge = new Bridge({
  url: 'ws://127.0.0.1:8890/bridge',
  bridgeId: 'app.display.mod',
  credential: 'app.display',
  token: process.env.DISPLAY_HUB_TOKEN,
  autoAck: false,
  cursorFile: join(process.env.DISPLAY_STATE_DIRECTORY, 'display.cursor.json')
});

bridge.on('delivery', async message => {
  if (message.operation !== 'inject' || message.topic !== commands) return;
  if (message.fromPrincipal !== 'app.worker') return;
  try {
    // 自己验证业务合同，幂等应用，并持久化所需状态后再确认。
    await persistAndApplyViewCommand(message.body);
    if (!bridge.ack(message)) throw new Error('Delivery session ended before ACK');
  } catch (error) {
    reportApplicationFailure(error); // 不把 Hub 接纳当作业务成功。
  }
});

const welcome = await bridge.connect();
if (!welcome.authenticated || welcome.principal !== 'app.display') {
  await bridge.close();
  throw new Error('Unexpected or unauthenticated display identity');
}
await bridge.registerChannels([
  { name: commands, subscribe: true },
  { name: events, publish: true }
]);
await bridge.subscribe([commands], { from: 'resume', operations: ['inject'] });

// 用户操作时，按照已认证的所属程序定向返回。
await bridge.sendTo({ principal: 'app.worker' }, events, {
  protocol: 'my-panel/1', kind: 'clicked', elementId: 'refresh'
});
```

这里的 `persistAndApplyViewCommand` 和 `reportApplicationFailure` 是应用自行实现的函数，片段不是可直接执行的完整程序。先准备自己的私人状态目录并设置 `DISPLAY_STATE_DIRECTORY` 与 `DISPLAY_HUB_TOKEN`。业务程序反向登记发布 commands、订阅 events，并使用 `sendTo({principal:'app.display'}, commands, body)`。接收身份来自 Hub 的 `fromPrincipal`，不要相信 body 中自报的 owner。认证状态在 `welcome.authenticated`，普通 delivery 没有 `authenticated` 字段；对端身份可信还依赖部署配置为该对端登记独立 token。

## 重启、状态与窗口仍由程序负责

- ACK/游标表示通信进度。若显示状态只存在内存，重启却从已保存游标 resume，已确认的视图不会自动重建。程序需要持久化状态，或约定向提供者重新请求快照；Hub 不替应用选择恢复策略。
- 修订号应跨应用重启保持可比较，或在业务合同中定义 epoch/会话。关闭视图需保留相应旧修订的拒绝信息，避免迟到的 open 把它复活。
- 业务回调失败时不要依赖未经处理的 async EventEmitter 返回值。明确记录失败、处理重试/去重和业务确认；是否保留或重发由程序合同决定。
- 桌面宿主启动成功、本地 HTTP 端口可用、Hub 已认证、订阅 ready 和业务交互成功是不同状态。界面应显示实际连接状态。
- 程序自行管理断线重连、凭据、用户数据及子进程退出。窗口关闭、隐藏和程序退出的关系也由宿主决定。

Electron 的 npm 包与平台二进制是不同安装材料。固定版本可能提供单独的安装命令；以该版本说明为准。对 Electron 44.7.1，先安装项目依赖，再显式运行 `npm exec -- install-electron` 安装二进制；仅 `npm install` 不会生成可运行的桌面环境。该 Electron 工具要求 Node 22.12 或更高，独立 Hub SDK 的 Node 下限仍是 22.4。

## 验证接入

至少验证：不同程序双向往返、同名 viewId 按可信身份隔离、错误凭据和错误权限被拒绝、重启恢复、重复/迟到信息、断线时真实状态、业务错误以及宿主拥有的进程退出。把程序修复与 Hub 通信缺陷分别记录；某个 UI 合同可行，不等于其他应用业务已被验收。
