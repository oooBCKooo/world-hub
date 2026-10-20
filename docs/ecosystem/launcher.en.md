# Communication management: one local Hub and module groups

[简体中文](launcher.md) · [Installation and Workbench](launcher-deployment.en.md)

The local Hub's `/manage` interface manages modules, instances, groups, wiring and processes owned by the manager. Local instances share this Hub. Module management belongs to the management layer; the communication core does not read groups, interpret applications or load modules as core plugins. The separate Launcher is retired.

## Start

```powershell
world-hub --open
# Source: node bin/world-hub.mjs --open
# Choose a data directory: world-hub --data-dir ./my-hub --port 0 --open
```

Without an explicit configuration, the CLI stores configuration and data in `world-hub-data` under the current directory. Use `--data-dir <writable directory>` to choose the data root, or `--config <file>` for your Hub configuration. With `--port 0`, open the `/manage` address printed for the assigned Hub port. Existing configuration is not overwritten with the packaged reference. See [npm usage](../npm.md) for all options.

Keep the terminal running and use Ctrl+C to stop cleanly. The manager cleans up module processes it owns; self-managed applications retain their own lifecycle. Do not start a second Hub using the same configuration, data directory or listening port. The former `ui` subcommand and `--root` are not current CLI options.

## Navigation and objects

| Interface function | Purpose |
| --- | --- |
| Topology canvas and information flow | Observe the Hub, programs, module bridges and actual communication |
| Local import and online Workshop | Acquire module/group artifacts, choose releases and review imports |
| Module inspector | Inspect instance settings, wiring, processes, logs and actual bridge sessions |
| Groups and scope selection | Organize existing instances and group startup plans |
| Wiring and startup plans | Edit instance settings, capability bindings, selected members and execution order |
| Versions, restoration and uninstall | Review upgrades, downgrades, history rollback, default wiring and instance/group uninstall |
| Communication workbench | Publish, pull, call, inject and transfer attachments using the page's own bridge |
| Environment and path selection | Inspect local interpreters and select or browse local paths |

An artifact version identifies code. `programId` identifies an independent instance. A configuration revision identifies settings and wiring changes. None is the Hub release version.

## Shared members

Groups store references and management settings. They do not own Hubs, credentials, data or processes. An instance may belong to several groups; starting an already running member reuses that process. Membership grants no permissions and proves no business readiness.

Review shared stops, removals and configuration changes with their affected groups and consumers. Deleting a group does not uninstall its modules or delete business data. Register another instance when independent parameters, identity or data are needed.

Startup plans distinguish selected members, exact order and prerequisites. Orchestration starts selected resident members; other members can start manually later. Calling an on-demand module requires the lifecycle client and local caller authorization; ordinary business messages do not start programs automatically. Authors can supply execution defaults and users can override them; see [module execution policy](modules.md#常驻与按需运行). Plan failures and application failures are separate. The Hub does not choose business retries.

## Review and observation

Import and download obtain source only. Registration, configuration and startup use current-content reviews. Changed digests or configuration require fresh checks; review is not transferred to a replacement version.

Keep credentials in private local files, not public settings. Declared permissions are not OS isolation. Process state, self-reported readiness and real bridge connections are separate observations. Acceptance, ACK and health checks do not prove a business outcome.

The management interface distinguishes owned instances from independently connected programs, presents actual sessions and supports topic authorizations. Revoking communication access does not stop an external application's process. Manual communication uses the management page's own module bridge.

## Paths and unavailable choices

Fields offer local selection, browsing, recent paths and bounded discovery, not whole-disk scans. Returned paths require content checks. The browser cannot invent backend provenance.

An available selected version stays selected. When it disappears, choose an available option, preferably the same instance, directory or source artifact, and display a notice. Automatic choice does not download, upgrade, start or inherit execution approval.

Save uncommitted interface changes before exit. Private management data may contain identities, credentials, cursors and business state; it is not a public module artifact. After an abnormal exit, inspect terminal errors, data paths and actual process ownership. Do not kill unknown processes using historical PIDs. The current CLI does not expose the old Launcher's lock inspection or cleanup subcommands. See [deployment](../deployment.md) and [distribution](../releases.md) for data and upgrade guidance.

## Current scope

Packs, per-pack Hubs, template generation and pack Runtime are no longer product entry points. Old packs and templates are not converted into module groups; their source and private data are not automatically deleted. Obtain individual current modules to reuse their programs.

Ordinary external programs can connect without the manager's module declarations. See [independent connections](external-programs.en.md), [module declarations](modules.md) and [communication specifications](../specs/index.md).
