# World Hub · 世界枢纽

[简体中文](README.md) | **English**

**Connect everything. Decouple systems. Make hardcoded connections adaptable. Route information freely. Extend with open-ended mods.**

For example, an editor provides the current file, a chat program provides the conversation, a knowledge program provides reference material, an executor calls models and tools, and another program supplies the interface. Each program communicates with the Hub through its own bidirectional mod bridge. A composition program chooses sources, makes calls, and combines results according to its own rules.

```text
External program ↔ its mod bridge ↔ World Hub ↔ another mod bridge ↔ another program
```

World Hub is their shared communications crossroads: it accepts, addresses, retains, and forwards information. Each program owns its business logic, state, and implementation.

## Start with the unified interface

```powershell
npm install -g world-hub
world-hub ui --open
```

The interface opens **My packs**. Inspect a local pack and its required environment, import an independent instance, then review the actual code and declared permissions before starting. Instance details show processes, health, readiness, real bridge connections, and logs, with links to that instance's Hub topology and communication workbench. Stop, review and restart, or export package sources and their lock. Simplified Chinese and English are available. Program state stays in the instance directory; exported packages exclude runtime data.

For a first experiment, clone this repository, install the versions of Node, Python, and websockets specified by the [cross-language text desk](examples/ecosystem-pack/README.md), run `npm run ui -- --open`, and import `examples/ecosystem-pack`. Three real programs perform JavaScript source → Python statistics → JavaScript interface calls. The npm installation does not include example programs; import your own pack or use a [source pack bundle](docs/releases.md).

Instances also provide storage accounting, private backups, restoration into new instances, and data-retaining uninstall and reattachment. The creator workspace displays real components and capability bindings, with public settings edits, compatible module replacements, and derived packs with fresh locks. Old environment locks can be explicitly reviewed and rebuilt in a new directory. Optional software sources filter Packs and Modules by contract, platform, and license before verified caching. Creators can produce shareable indexes and artifacts and exchange plain-text comments and proposals with revision conflict checks. These operations do not automatically execute third-party programs.

Launcher is an optional local deployment and navigation tool that calls the external Runtime. Hub Core continues to handle communication. Independent programs, `world-hub --open`, and headless deployment remain available on their own. Discover installed interpreters, then explicitly review a limited recipe to prepare an independent environment for the supported locked Python dependency. Prepare other environments yourself. Permission declarations and Python venvs are not operating-system sandboxes. Local instances work without online sources, and generating a publication directory does not upload to a hosted community. See the [unified interface guide](docs/ecosystem/launcher.md), currently in Chinese.

![Unified interface: a running cross-language pack and its independent programs](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-launcher-en.jpg?v=0.16.1)

## What can you compose?

| System you want to build | Separate external programs | How they cooperate through the Hub |
| --- | --- | --- |
| A dashboard with multiple sources | Sensors, application events, business systems, aggregation, interface | Sources feed one dashboard, and the interface sends control information back to the sources. |
| A modular intelligent workbench | System instructions, conversation, knowledge base, context assembly, model/harness, tools, interface | Context is drawn from different sources and passed to an executor that returns a result. Sources and executors can be replaced separately. |
| A dynamic digital world | World state, rules, NPCs, director, display | Each round, the director requests information from several programs. Rule calculations update state, which is used in the next round. |
| A workflow across programs | Data retrieval, analysis, validation, output, workflow controller | Each round accesses one or more programs. The controller combines results, schedules the next round, and eventually returns the final output. |

These are directions for composition. External programs implement model inference, tool execution, world rules, and workflow scheduling; the Hub supplies their shared communication mechanism.

## Try four hands-on demos

All four demos start real, independent programs that exchange information through real mod bridges. Their interfaces display data, context sources, world rounds, and capability discovery. Raw JSON and communication receipts can be expanded for inspection.

| Demo | Try this | Expected result |
| --- | --- | --- |
| Multi-source event desk: `event-desk` | Enable the included traffic source; adjust the environment sampling settings. | The dashboard grows from two sources to three. The sensor's control bridge receives the settings, and its sampling bridge keeps publishing readings with the new settings. |
| Distributed-context assistant: `modular-assistant` | Add material from the independent extension program; switch to the independent checklist executor. | New material appears in the assembled context. The executor's identity and output format change while using the same communication contract. |
| External digital world: `digital-world` | Advance the world by three rounds; run a rest sequence. | Compare the initial state, each round's actions, and the final state. The NPC, rules, and state programs return their own step receipts. |
| Capability discovery and replacement: `capability-directory` | Query the catalog, switch statistics provider A to B through configuration, then try a wrong version, denied authorization, and a slow response. | Source and output code stay unchanged. Two separate implementations follow one public contract, distinguishing Hub acceptance, business failure, and an unknown outcome. |

The event desk below is an actual run. Traffic readings appear alongside environment and market data. After the interface sends settings back to the environment program, readings continue with the new parameters.

![English interface: actual three-source event dashboard and control settings returned by the source program](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-event-desk-en.jpg?v=0.16.1)

<details>
<summary>See actual results from four context sources and an independent executor</summary>

![English interface: four programs provide context; an independent checklist executor returns its output and actual source receipts](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-modular-assistant-en.jpg?v=0.16.1)

</details>

<details>
<summary>See three rounds of change in the external digital world</summary>

![English interface: an independent director calls NPC, rules, and state programs, returning the initial state, three rounds of actions, and the final state](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-digital-world-en.jpg?v=0.16.1)

</details>

<details>
<summary>See the external catalog and actual calls after configuration-only replacement</summary>

![English interface: an independent catalog advertises two statistics implementations; the configured composer selects B and returns statistics and four actual call receipts](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/demo-capability-directory-en.jpg?v=0.16.1)

</details>

Node.js 22.4+ is required. Run from source, choosing one demo at a time:

```powershell
git clone https://github.com/oooBCKooo/world-hub.git
cd world-hub
npm run demo:events-explorer
# Or npm run demo:assistant-explorer
# Or npm run demo:world-explorer
# Or npm run demo:capabilities-explorer
```

The demos use local events, a simplified world, and deterministic executors; no model account is needed. The assistant demo shows context composition and executor replacement without calling a real model. The capability demo supplies an optional [capability contract and catalog](docs/examples/capability-directory.md): two processors depend only on the SDK and a public contract, with separate implementations. The catalog and composer are external programs. These included examples and isolated integration tests do not establish interoperability with arbitrary third-party developers. To connect your own program, implement a bridge and agree on the application contract.

To build a replaceable module from scratch against the same contract, start with the [provider integration contract](docs/modules/provider-contract.md) and [JavaScript SDK](sdk/javascript/README.md). The guide specifies business envelopes, capability registration and discovery, identity binding, leases, and result validation. The [machine-readable contract](docs/modules/text-statistics.contract.json) ships with npm, Hub bundles, and purpose demo bundles. Your deployer supplies the endpoint, separate identity credentials, and topic permissions, then configures the external catalog and composer. The Hub needs no new business types. The detailed provider guide is currently in Chinese.

You can also build standalone source bundles or Windows portable bundles. See the [purpose demo guide](docs/examples/purpose-demos.md) for experiments, source editing entry points, and build instructions. The npm package contains the Hub, management interface, SDKs, optional external Runtime, and documentation; run purpose demos from the source repository or demo bundles.

## Design principles

**Interconnection, Decoupling, Adaptability, Freedom, and Open-ended extension.**

| Principle | What it means in World Hub |
| --- | --- |
| Interconnection | Programs exchange information and access each other's capabilities through bidirectional mod bridges. |
| Decoupling | Programs own their business logic, state, and implementation, and can be composed and replaced according to communication contracts. |
| Adaptability | Fixed wiring and communication arrangements between programs become configurable, replaceable, and extensible bridges and contracts. |
| Freedom | Programs choose information sources, topics, and routes, combining bidirectional, many-to-many, and multi-round information flows. |
| Open-ended extension | Business mods, information types, and uses are not exhaustively listed in advance, leaving room for new integrations. |

## Why these compositions can keep growing

- **Programs supply the sources:** system instructions, conversations, documents, events, and state can come from different programs and be combined for each use.
- **Mods declare topics:** adding business topics and payload types does not require changing the Hub. Participants agree on what the information means.
- **Programs and bridges support many-to-many arrangements:** a program can connect through multiple bridges, and a bridge can adapt multiple programs. Bridges can send, receive, or communicate in both directions.
- **Information can wait for later consumers:** programs can publish without a current consumer. Other programs can later retrieve information by topic and cursor. The provider decides when to permit reclamation.
- **External programs arrange multiple rounds:** A can call B through the Hub, and B can call C in turn. A workflow program can also request several programs per round and combine their results.

“Making hardcoded connections adaptable” concerns connections and communication composition between programs; each program still implements its business code and rules. “Open-ended mods” means that business mods and uses are not enumerated in advance. Every deployment is still subject to identity permissions, communication contracts, connection limits, storage capacity, and throughput. Reading, ACKs, replies, and disconnections do not release information on the provider's behalf.

## Hub management interface

Run `world-hub --open` to open the communications management interface. Purpose demos have their own external interfaces, with a link to Hub management for the current session.

The management canvas, communication workbench, and all four purpose demos offer Simplified Chinese / English switching and remember your choice in the browser. Switching changes interface wording and display formats; user-provided names, annotations, topics, application content, and original communication records retain their original text.

![English interface: Hub management canvas with programs, bidirectional mod bridges, the Hub, and actual information flow](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-topology-en.jpg?v=0.16.1)

The management canvas displays programs, bridges, the Hub, and information flow. It supports enabling and disabling connections and editing association annotations. Program annotations do not represent the actual execution state of external programs.

<details>
<summary>See the bidirectional mod communication workbench</summary>

![English interface: communication workbench with dynamic topics, original messages, and actual send/receive records](https://raw.githubusercontent.com/oooBCKooo/world-hub/main/docs/images/hub-workbench-en.jpg?v=0.16.1)

The workbench uses its own mod to publish, subscribe, and retrieve information. It also supports requests and replies, injection, channel declarations, and attachment transfer. The screenshot shows an actual publication and the Hub's acceptance receipt.

</details>

## Start the Hub

Node.js 22.4+ is required. The Hub and browser management interface use Node's built-in modules and have no third-party runtime dependencies. Install and start through npm:

```powershell
npm install -g world-hub
world-hub --check
world-hub --open
```

On the first start, the launcher creates editable configuration and persistent data in `world-hub-data/` under the current working directory. `--check` only checks and creates no files. Use `--config ./hub.json` to select your wiring configuration, or `--data-dir ./my-hub-data` to choose a data directory. See [npm installation and usage](https://github.com/oooBCKooo/world-hub/blob/main/docs/npm.md) for details.

After cloning the source from GitHub, you can also run:

```powershell
npm run check
npm start
```

Open the `/manage` address printed by the launcher; the default local port is 8790. The communication workbench uses its own real mod to publish, subscribe, make requests and replies, inject information, transfer attachments, and send ACKs manually. Connection management controls communication principals or connections and edits program/bridge annotations. Annotations do not determine identity, addressing, or permissions.

The [reference configuration](config/hub.json) listens only on `127.0.0.1` and rejects unregistered identities. `ui.manual` is a local reference credential; without a token, the interface shows an unauthenticated state. For your deployment, edit the configuration generated on the first npm start, or copy the reference configuration in a source checkout and configure permissions for your own program identities and topics:

```powershell
node scripts/launcher.mjs --config config/local.json --port 8791
```

To stop, press Ctrl+C in the owning terminal and wait for the process to exit. The default persistent data directory is `world-hub-data/` for an npm launch and `data/` for a source launch. Both are excluded from Git. A complete migration must preserve your wiring configuration, logs, objects, and management state. Parallel instances must not share the same data or program cursor files.

## Integration, validation, and builds

- [Integration materials](docs/onboarding.md): JavaScript, browsers, Python, PowerShell, and the raw wire protocol. SDKs are in `sdk/`.
- [Current specifications and documentation index](docs/README.md): communication boundaries, directed messages, attachments, retention, deployment, and the workbench.
- [Development and testing](docs/development.md): `npm test` requires only Node. Real DSH and cross-language integration checks can be run separately as needed.
- [Building and distribution](docs/releases.md): create source bundles or Windows x64 portable bundles. Builds write to `dist/` without overwriting deployment directories.

`examples/` contains independent programs demonstrating bidirectional communication, multiple sources, multiple bridges, and workflows with multiple rounds. Examples connect through their own bridges, and each program implements its own business logic. The default launch starts only the Hub and management interface.

The npm package contains the Hub, management interface, SDKs for three languages, reference configuration, documentation, and the optional external `world-hub-pack` deployment tool. Source examples, tests, and bundle build tools are available in the GitHub repository and are not installed by npm. Clone the repository to run purpose demos or source tests.

## Deploy independent programs as a pack

The optional `world-hub-pack` tool imports reviewed local program packages into separate instances, then starts, observes, stops, restarts, and exports them. A module may carry several mod bridges. `module.json` declares program deployment, `pack.json` describes the composition, and `pack.lock` pins files, versions, platform, and preinstalled environments. These are [open external deployment declarations](docs/ecosystem/pack-spec.md); ordinary Hub programs do not have to adopt them.

```powershell
$review = world-hub-pack plan ./my-pack | ConvertFrom-Json
world-hub-pack import ./my-pack --root ./pack-runtime --instance one
world-hub-pack start --root ./pack-runtime --instance one --trust $review.digest
```

Review the contents, dependencies, and declared permissions before starting with the actual digest. Each instance has its own Hub, ports, credentials, and program state. Process status, self-reported health, and real bridge connections are observed separately. The [cross-language text desk pack](examples/ecosystem-pack/README.md) contains three real programs: a JavaScript text source, a Python statistics provider, and a JavaScript browser desk. The desk requests the source and statistics through the Hub and saves its own results, with Chinese and English UI. Its reference lock requires preinstalled Node 22.23.2, Python 3.14.0, and websockets 15.0.1.

Runtime is an external deployment layer; the Hub remains a communication crossroads. Each instance has a separate Hub. Permissions are declarations, with no OS sandbox or automatic business retry. Launcher can prepare the supported fixed Python dependency through an explicitly reviewed recipe, and provides static source distribution and local creator collaboration. It does not host an online community. See the [external Runtime guide](docs/ecosystem/runtime.md) for the CLI, public API, explicit re-locking, and data boundaries.

## Repository structure

```text
bin/                  npm command-line entry point
src/hub/              Communication core and WebSocket entry point
src/management/       Local management HTTP server and browser workbench
src/debug/            Read-only debug page
sdk/                  JavaScript, Python, and PowerShell bridges
config/               Portable default wiring configuration
docs/specs/           Current communication specifications
examples/             Independent program examples and purpose demos
tests/                Communication regression tests, integration tests, and fixtures
scripts/              Launch, validation, build, and distribution tools
tools/launcher/       Optional pack management backend and unified browser entry
.github/workflows/    Windows continuous integration
```

See [repository structure](docs/repository.md) for component responsibilities, SDK usage, and distribution contents. The detailed guides are currently primarily in Chinese.

Supported environments, test scope, and known limits are described in [verification notes](docs/verification.md). For deployment, message appends do not guarantee durability through power loss, and the local management interface is intended for a single trust domain. See [deployment documentation](docs/deployment.md) for configuration and capacity details.

This project is licensed under [MIT](LICENSE). The Node.js runtime included in portable bundles retains its own license. External programs and harnesses use their respective licenses.
