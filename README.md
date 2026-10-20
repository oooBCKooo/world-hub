# 世界枢纽 · World Hub

[中文](README.md) | [English](README.en.md)

**互联万物，自由组合，解耦整体，软化硬码，拔插一切，任意流线，无限模块。**

World Hub 是独立程序之间的通信十字路口。程序通过各自的双向枢纽桥登记通道、发布和抽取信息、请求与返回信息、注入信息，并传输大对象。业务、上下文、工作流、程序形态与界面由外部程序自己决定。

```text
程序 A ↔ 枢纽桥 ─┐                ┌─ 枢纽桥 ↔ 程序 B
程序 C ↔ 枢纽桥 ─┼─ 一个全局 Hub ─┼─ 枢纽桥 ↔ 程序 D
外部程序 ↔ 枢纽桥┘                └─ 枢纽桥 ↔ 其他程序
```

本项目只包含**非界面部分**：通信服务、SDK、CLI、管理 API、模块资源与运行工具，以及可选的社区后端、Skill 和 MCP。可视化管理和社区网页属于独立的 [World Hub UI](docs/specs/ui-separation.md) 项目。Hub 不加载该项目，不需要浏览器或页面文件。

## 启动无界面 Hub

```powershell
npm install -g world-hub
world-hub --port 8790
# 检查或使用自己的配置
world-hub --check --config ./hub.json
world-hub --config ./hub.json --data-dir ./private-hub-data
```

首次启动在当前工作目录的 `world-hub-data/` 创建配置和数据。`ready` 标准输出提供真实 WebSocket 地址、`statusUrl` 和 `managementApiUrl`；使用 Ctrl+C 等待正常停机。默认配置拒绝未配置的枢纽桥；按[独立程序接入](docs/ecosystem/external-programs.md)设置身份和主题权限。

```powershell
Invoke-RestMethod http://127.0.0.1:8790/status
Invoke-RestMethod http://127.0.0.1:8790/manage/api/state
```

根路径返回服务信息 JSON；`/manage` 不提供页面，Hub 命令不再接受 `--open`。需要图形界面时，另行启动 World Hub UI 并提供 Hub 地址。关闭或修改界面不会停止 Hub。

## 开发枢纽桥

**模块**是“程序 + 枢纽桥”的可独立交付单元。一个程序可使用多个桥；桥可嵌入程序，也可独立运行。通道由桥注册，Hub 不硬编码业务信息种类。

```javascript
import { Bridge } from 'world-hub/bridge';

const bridge = new Bridge({
  url: process.env.HUB_URL,
  bridgeId: 'my-program',
  token: process.env.HUB_BRIDGE_TOKEN,
});
await bridge.connect();
await bridge.registerChannels([{ name: 'example/events', publish: true, subscribe: false }]);
await bridge.publishConfirmed('example/events', { message: 'Hello World Hub' });
await bridge.close();
```

地址、凭据和权限由部署方提供。使用 `ready.endpoint` 的实际通信路径。[JavaScript](sdk/javascript/README.md)、[Python](sdk/python/README.md)、[PowerShell](sdk/powershell/README.md) SDK 和[线协议](docs/specs/protocol.md)均可独立使用。

相同能力名称不代表可替换，仍需遵守共同的输入输出契约。参考[提供者契约](docs/modules/provider-contract.md)与[互操作基准](docs/ecosystem/interop.md)。

## 可以组合出什么

| 用途 | 在 Hub 外部实现的程序 |
| --- | --- |
| 多来源数据面板 | 传感器、事件来源、汇总与交互界面 |
| 分布式智能系统 | 系统提示、对话、知识、上下文组装、模型或 harness、工具 |
| 动态数字世界 | 世界状态、规则、NPC、导演与显示 |
| 多轮工作流 | 每轮调用多个程序、校验、合并并产出成果的控制程序 |
| 可替换能力生态 | 按公开契约发现、选择与替换提供者的外部程序 |

Hub 负责接纳、寻址、留存和转交。信息何时释放由提供者策略决定；抽取或 ACK 不代表业务成功。Hub 不解释系统提示词、不运行世界规则、不选择模型、不调度业务工作流。

## 管理 API、资源与社区

本机管理 API 提供桥暂停／恢复／断开、程序接入、权限审阅、启动／停止、常驻／按需策略、接线、版本和模块资源管理。脚本、外部工具和独立 UI 使用同一套 API，保留回环、Host、Origin 与操作令牌检查。见[管理 API](docs/specs/management.md)。

资源为独立版本的**模块本体、模块配置、模块数据**。全局／局部是范围，共用本体库；配置只引用精确本体。下载、应用配置、恢复数据和授权运行分别审阅，保留法清理不自动删除业务数据。见[模块资源](docs/specs/module-resources.md)。

[Workshop](https://peros.cn/workshop/) 是可选的独立社区。此仓库提供账号、制品、来源与协作 API 后端，网页在 World Hub UI 项目。后端可不带网页单独启动；明确配置 `uiRoot` 时才挂载外部部署的静态目录。

## Skill 与 MCP

```powershell
world-hub-skill --install ./my-agent/.agents/skills/world-hub
world-hub-mcp --prepare
world-hub-mcp --config ./private/world-hub-mcp.json
```

Skill 提供公开文档；MCP 使用自己的枢纽桥、身份和授权通过 stdio 接入。两者不依赖界面，也不绕过通信权限。见[智能体接入](docs/ecosystem/agents.md)。

## 开发与验证

```powershell
git clone https://github.com/oooBCKooo/world-hub.git
cd world-hub
npm test
npm run test:resources
npm run test:workshop
npm run test:npm
npm run build -- --output .artifacts/packages/world-hub-source
```

[文档入口](docs/README.md) · [部署](docs/deployment.md) · [npm](docs/npm.md) · [开发](docs/development.md) · [验证](docs/verification.md) · [分发](docs/releases.md) · [仓库结构](docs/repository.md)

线协议保持 `wire: "0.1"`，扩展通过 `welcome.features` 协商。开放的组合空间仍受资源、授权、协议和程序能力限制。

**互联，自由，解耦，软化，拔插，任意，无限。** 源码与文档采用 [MIT](LICENSE) 许可。
