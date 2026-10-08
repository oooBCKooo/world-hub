# npm 包与 SDK

`world-hub` 提供前台运行的 Hub CLI 和外部程序可选用的 JavaScript、Python、PowerShell mod 桥。Hub CLI 与 JavaScript SDK 需要 Node.js 22.4.0 或以上，没有 npm 运行依赖；Node 运行时由使用者安装。Python 和 PowerShell SDK 按各自模块文件路径使用，需要自己的运行环境。npm 安装不会启动业务程序，也不会安装 DSH、模型或 Python 依赖。

## 安装并启动

在自己的部署目录中运行：

```powershell
npm install --global world-hub
New-Item -ItemType Directory -Force my-hub
Set-Location my-hub
world-hub --check
world-hub --open
```

`--check` 只读检查 Node、必需资源、配置和数据路径，第一次运行时也不创建文件。实际启动时，默认在当前目录的 `world-hub-data/hub.json` 写入参考配置，日志、附件和管理状态分别放在 `world-hub-data/log`、`world-hub-data/blobs`、`world-hub-data/management.json`。已存在的配置继续使用，不被安装包模板覆盖；npm 安装目录不保存部署数据。

默认监听 `127.0.0.1:8790`，管理地址为 `http://127.0.0.1:8790/manage`。`--open` 在就绪后打开浏览器；不传时按终端输出手动打开。若端口已有其他服务，可选择自己的端口或使用 `world-hub --port 0 --open`，按启动输出取得系统分配的地址。Ctrl+C 停止，等待 `stopped` 输出再关闭终端。

参考配置仅允许已登记的可信回环身份，预置 `ui.manual` 工作台凭据标识，未设 token。自己的程序需要在配置中登记桥或凭据、主题权限和所需连接额度，保存后重启。私人配置、token 与通讯数据留在部署目录，不提交源码仓库。具体接入和管理边界见[mod 接入](onboarding.md)与[部署](deployment.md)。

## 配置和数据路径

| 选项 | 行为 |
| --- | --- |
| `--config <path>`、`-c <path>` | 使用自己的配置；相对配置路径以调用者当前目录解析，配置内相对存储路径以配置文件目录解析 |
| `--data-dir <path>` | 明确把通讯日志、附件和管理状态放在该数据根；相对路径以调用者当前目录解析 |
| `--config` 与 `--data-dir` 一起使用 | 保留源配置，在数据根的 `configs/` 中生成带内容 hash 的有效配置；不覆盖源配置 |
| `--port <n>`、`-p <n>` | 只在本次覆盖监听端口，范围为 0–65535；0 由系统分配 |
| `--check` | 只读检查，不建配置、数据或锁，不启动服务；不能与 `--open` 同用 |
| `--help`、`-h` | 查看 CLI 帮助 |

例如使用自己的配置并隔离数据：

```powershell
world-hub --check --config ./hub.local.json --data-dir ./deployment-a
world-hub --config ./hub.local.json --data-dir ./deployment-a --open
```

启动器持有部署数据目录的排他锁；正常停止只释放自己的锁。升级可使用 `npm install --global world-hub@latest`，升级前先停止自己运行的实例。备份与迁移仍需保留完整配置和通讯数据，具体方法见[分发与迁移](releases.md)。启动、升级、停止、读取和 ACK 都不会替提供者释放信息。

## 在程序中使用 JavaScript 桥

在外部程序自己的项目里安装：

```powershell
npm install world-hub
```

ESM 命名导出入口：

| 导入路径 | 内容 |
| --- | --- |
| `world-hub` 或 `world-hub/bridge` | `Bridge`、`WIRE_VERSION`、`WIRE_FRAMES`、`defaultCursorPath` |
| `world-hub/blob` | `uploadFile`、`uploadStream`、`downloadFile`、`readAttachment` |

以下示例要求部署方先在 `acl.credentials` 登记 `example.program`、自己的 token 和对 `example/message` 的发布／订阅权限，并重启 Hub。由程序通过自己的环境提供 token；不将实际值写进代码：

```js
import { Bridge } from 'world-hub/bridge';

if (!process.env.WORLD_HUB_TOKEN) throw new Error('需要自己的 WORLD_HUB_TOKEN');
const bridge = new Bridge({
  url: process.env.WORLD_HUB_URL ?? 'ws://127.0.0.1:8790/bridge',
  bridgeId: 'example.mod',
  credential: 'example.program',
  token: process.env.WORLD_HUB_TOKEN,
  autoAck: false,
});
bridge.on('error', error => console.error(error));
bridge.on('denied', frame => console.error(frame));
const deadline = setTimeout(() => { void bridge.close('示例总期限'); }, 10_000);
try {
  await bridge.connect();
  await bridge.registerChannels([{ name: 'example/message', publish: true, subscribe: true }]);
  const receipt = await bridge.publishConfirmed('example/message', {
    kind: 'developer.hello', text: '来自独立程序的信息',
  });
  console.log('Hub 接纳序号', receipt.seq);
} finally {
  clearTimeout(deadline);
  await bridge.close();
}
```

主题和 `body.kind` 由程序约定。`publishConfirmed` 的成功只说明 Hub 接纳，信息可能还没有被任何其他程序抽取；读取、ACK 和关闭也不释放消息。订阅、定向调用、注入、附件、游标与提供者释放方法见[JavaScript SDK](../sdk/javascript/README.md)和[通讯契约](specs/protocol.md)。Node SDK 使用文件 API，不能直接导入浏览器；浏览器桥由接入程序选择自己的实现。

## Python 与 PowerShell 桥

三个 SDK 都在包内的 `sdk/` 下，只有 JavaScript 使用上述 npm 导出入口。Python 与 PowerShell 桥直接连接 Hub，运行时不转交 Node。若在外部程序项目里通过 `npm install world-hub` 取得 SDK，可使用以下文件路径：

```powershell
python -m pip install -r ./node_modules/world-hub/sdk/python/requirements.txt
Import-Module './node_modules/world-hub/sdk/powershell/HubBridge.psm1'
```

Python 程序把 `node_modules/world-hub/sdk/python` 加入模块路径后导入 `hub_bridge`，也可按自己的打包方式携带桥。它需要适用的 Python 和 `websockets==15.0.1`；PowerShell 桥需要 PowerShell 7，通过系统 `Add-Type` 编译包内 C# 辅助类，不需要独立 dotnet SDK。详细接口见[Python SDK](../sdk/python/README.md)与[PowerShell SDK](../sdk/powershell/README.md)。这些 SDK 文档中的 `sdk/...` 示例路径以源码仓库为基准，npm 安装时按自己的安装位置调整。

## 源码、演示与许可

npm 包包含 CLI、通讯核心、管理界面、三个语言 SDK、参考配置和文档。测试、独立业务示例、构建工具、生成 ZIP、官方 Node 二进制与私人部署数据不随 npm 安装。需要开发、运行 `npm test` 或探索用途演示时，克隆 [GitHub 仓库](https://github.com/oooBCKooo/world-hub)，按[开发](development.md)、[验证](verification.md)与[用途演示指南](examples/purpose-demos.md)操作。

项目源码和文档采用 [MIT 许可](../LICENSE)，第三方运行时和依赖遵循各自许可。npm 可安装不代表所有平台、跨机器、长期运行或所有第三方桥都已验收；实际验证范围见[验证说明](verification.md)。
