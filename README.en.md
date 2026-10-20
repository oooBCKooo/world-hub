# World Hub

[中文](README.md) | [English](README.en.md)

**Connect everything. Compose freely. Decouple systems. Soften hardcoding. Plug everything. Route freely. Extend without a fixed module catalogue.**

World Hub is a communication crossroads for independent programs. Bidirectional hub bridges register channels, publish and pull information, request and return information, inject information, and transfer large objects. Programs own their business rules, context, workflows and interfaces.

```text
Program A ↔ hub bridge ─┐             ┌─ hub bridge ↔ Program B
Program C ↔ hub bridge ─┼─ one Global Hub ──┼─ hub bridge ↔ Program D
Other app ↔ hub bridge ┘             └─ hub bridge ↔ Other app
```

This repository contains **headless components only**: the server, SDKs, CLI, management APIs, module resource and process tools, optional Workshop backend, Skill and MCP. Browser management and community pages are a separate [World Hub UI](docs/specs/ui-separation.md) project. Hub neither imports that project nor requires a browser or UI assets to start.

## Start a headless Hub

```powershell
npm install -g world-hub
world-hub --port 8790
world-hub --check --config ./hub.json
world-hub --config ./hub.json --data-dir ./private-hub-data
```

First startup creates configuration and state in `world-hub-data/` under the invoking directory. The machine-readable `ready` line supplies the actual WebSocket endpoint, `statusUrl` and `managementApiUrl`. Stop with Ctrl+C and wait for normal shutdown. Unconfigured bridges are denied by default; provision identities and topic grants using the [external program guide](docs/ecosystem/external-programs.en.md).

```powershell
Invoke-RestMethod http://127.0.0.1:8790/status
Invoke-RestMethod http://127.0.0.1:8790/manage/api/state
```

The root route returns service information as JSON. `/manage` serves no page, and Hub no longer accepts `--open`. Start World Hub UI separately with an explicit Hub address when needed. Stopping or editing the UI does not stop Hub.

## Build a hub bridge

A module is a **program plus its hub bridge**. One program can use several bridges, embedded or independently running. Bridges register channels; Hub has no built-in enumeration of business message types.

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

Deployment supplies addresses, credentials and grants. Use the actual path in `ready.endpoint`. [JavaScript](sdk/javascript/README.md), [Python](sdk/python/README.md), [PowerShell](sdk/powershell/README.md), and the [wire protocol](docs/specs/protocol.md) work independently of any UI.

Matching capability names alone do not establish substitutability. Implement the same application contract and input/output semantics; see the [provider contract](docs/modules/provider-contract.md) and [interoperability benchmark](docs/ecosystem/interop.md).

## What can be composed?

| Use | Programs outside Hub |
| --- | --- |
| Multi-source dashboards | Sensors, events, aggregation and interaction |
| Distributed intelligent systems | Prompts, conversations, knowledge, context assembly, model or harness, tools |
| Dynamic digital worlds | World state, rules, NPCs, directors and presentation |
| Multi-round workflows | Controllers calling multiple programs, validating and combining results |
| Replaceable module ecosystems | External discovery and composition following public contracts |

Hub admits, addresses, retains and forwards information. Providers decide retention and release; pulls and ACKs are not business success. Hub does not interpret system prompts, execute world rules, select models or schedule application workflows.

## APIs, resources and community

Local APIs provide bridge admission control, registration, execution review, start/stop, resident/on-demand policies, wiring, versions and resources. Scripts, tools and the separate UI use the same APIs. Loopback, Host, Origin and operation-token checks remain in place; see [management APIs](docs/specs/management.md).

Independent module instances and reference groups are all connected to **the same Hub**. Groups organize deployment without creating a separate communication world. Module bodies, configurations and data have independent versions. Global/local describe scope in a shared pool. Configurations pin exact bodies; downloading, configuration application, data restoration and execution grants are separate actions. Retention cleanup preserves business data. See [module resources](docs/specs/module-resources.md).

[Workshop](https://peros.cn/workshop/) is optional. This repository supplies account, artifact, source and collaboration APIs; pages live in World Hub UI. Its backend starts without pages. Explicit `uiRoot` can mount a separately deployed frontend directory.

## Skill and MCP

```powershell
world-hub-skill --install ./my-agent/.agents/skills/world-hub
world-hub-mcp --prepare
world-hub-mcp --config ./private/world-hub-mcp.json
```

The Skill supplies documentation. MCP uses its own bridge, identity and permissions over stdio. Neither needs a UI or bypasses authorization. See [agent integration](docs/ecosystem/agents.en.md).

## Develop and verify

```powershell
git clone https://github.com/oooBCKooo/world-hub.git
cd world-hub
npm test
npm run test:resources
npm run test:workshop
npm run test:npm
npm run build -- --output .artifacts/packages/world-hub-source
```

[Documentation](docs/README.md) · [Deployment](docs/deployment.md) · [npm](docs/npm.md) · [Development](docs/development.md) · [Verification](docs/verification.md) · [Distribution](docs/releases.md) · [Repository](docs/repository.md)

The wire protocol remains `wire: "0.1"`; extensions use `welcome.features`. Open-ended composition remains bounded by resources, authorization, protocol limits and application capability.

**Connect. Compose. Decouple. Soften. Plug. Route. Extend.** Source and documentation use [MIT](LICENSE).
