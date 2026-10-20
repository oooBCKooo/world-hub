# Develop and manage modules

Read this reference when authoring a distributable program or operating modules and groups. Self-managed programs can use hub bridges without adopting these deployment declarations.

## Define a program before packaging it

Specify its application contract: inputs, outputs, identities, errors, side effects, completion, data ownership, and retries. Choose the program's own language, interface, storage, and lifecycle. The Hub imposes a communication format, not the program's architecture. One program may have multiple hub bridges.

A managed module's `module.json` declares:

- `format: 'world-hub.module/v1'`, stable `id`, semantic `version`, license, and supported platforms;
- a runtime kind and source entry point;
- bridge slot names, provided and required contract ID/version pairs;
- declared filesystem, network, and process permissions.

Use the published JSON Schema and current runtime checks. A declared capability is a candidate, not proof that its implementation is correct or authorized. Actual program identity and permissions come from the deployment. Keep secret tokens and machine-specific paths out of public artifacts.

Optional `deployment.json` (`world-hub.deployment/v1`) supplies titles/descriptions, topic defaults, bridge-slot publish/subscribe aliases, settings, dependencies, default connections, and execution defaults. Programs must read the actual generated private runtime configuration rather than continue using author defaults after the user changes wiring. Inspect a maintained example and the deployment Schema before choosing fields; do not infer field names from labels in the UI.

For a managed program, follow the [managed entry point and complete JavaScript example](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/developer.en.md#managed-entry-point-and-private-runtime-configuration). The manager invokes the declared source entry with `--runtime-config <private-file>`; that file uses `world-hub.run/v1`. Find the needed slot in the `bridges` array and pass its `endpoint` as Bridge `url`, plus its actual `bridgeId`, `credential`, and `token`. There is no top-level `hub.url`. Read actual aliases from `topics`, public settings from `settings`, and store private application data under `stateDir`. Never log or publish the runtime file.

The managed example also handles stdin `health`/`stop` requests and reports `module-ready`/`module-health` on stdout; connecting a bridge alone is insufficient for managed startup. This local management contract is separate from the Hub wire protocol. Independently launched programs can choose their own startup and lifecycle instead.

Do not invent obsolete `init-module`, `world-hub-pack`, or template-generation commands. The current module workflow uses source directories/ZIPs and the communication management interface. A source checkout may retain historical files that are not current public entry points.

## Import and connect

Use the Hub's `/manage` interface for local imports and Workshop downloads. Downloading stores an artifact; importing/registering creates a local instance; starting executes its program. These are separate actions.

1. Select the required module or group release, inspect its identity, source digest, platform, runtime, dependencies, and author defaults.
2. Review public parameters, concrete topics, bridges, and requested capabilities. Resolve missing providers by obtaining and importing the needed module, then check wiring again.
3. Register an independent instance and review the generated identity and permissions.
4. Start it only within the user's task. Check its process, readiness report, actual bridge connection, and a real application exchange separately.

`programId` identifies a local instance, not a module product or release. Each independent instance has its own identity, state, and configuration. A module artifact version, local configuration revision, group recipe version, and Hub release version are distinct.

## Author-default wiring

A deployment `connections` declaration can pin a default provider module ID/version, exact required contracts, and topic-alias mappings. This is a management-layer suggestion, not Hub routing logic.

For a single module, a unique eligible registered provider can fill the import review. Several eligible instances require a choice; a missing provider is reported. Do not guess from names or silently download, execute, or expand permissions. A module already in the download library still needs a registered instance to be wired.

A downloadable module group uses `module-group.json` (`world-hub.module-group/v1`) to bundle member sources and a versioned recipe. Member `configuration` supplies complete `topics`, `bridges`, `settings`, and `bindings`; a binding's `providerId` refers to a recipe member. The manager translates member references into instance IDs during import. Full group configuration overrides individual deployment defaults and does not resolve an external target.

Imported group members remain independent instances on the shared local Hub. Groups reference instances and carry management settings; they do not own separate Hubs, credentials, private data, or private processes. One instance may appear in multiple groups. Review how changes and stops affect all consumers of that shared instance.

## Startup and demand policy

Authors may suggest this declaration in `deployment.json` or override it in a group member's configuration:

```json
"executionDefaults": { "mode": "on-demand", "idleTimeoutMs": 60000 }
```

`mode` is `resident` or `on-demand`. Idle timeout is optional, defaults to 60000, and is an integer from 1000 to 86400000 milliseconds. Group-member defaults take precedence over module defaults; without either, new instances default to resident/60000. Imported instances remain stopped and their local allowed-caller list is empty. Author defaults must not include `allowedCallers` or execution grants.

Startup plans select instances, execution order, and prerequisites independently. Orchestration starts selected resident members; it skips on-demand members. A dependency does not silently select or start an instance. Users can start other members later.

On-demand activation uses the local management service's separate lifecycle bridge. It requires locally authorized callers and a lifecycle-aware caller; ordinary business traffic does not start programs. Upgrades and rollback retain existing instances' local execution policy. See the lifecycle reference linked from the communication guide when implementing a caller.

## Change versions, restore, or uninstall

An ordinary import creates a new instance. To update an existing instance, use its reviewed upgrade/downgrade operation, choose the downloaded target release, stop the instances whose code changes, and review public-configuration and private-data policies. Local identities and credentials remain stable. Do not overwrite source files behind the manager's version history.

Choose whether to keep current public configuration or adopt author configuration, and separately whether to keep current private state or start fresh. The manager cannot establish application data compatibility or run a business migration merely from version numbers. Check a real consumer after the change. Published version bytes are immutable; source or recipe changes require a new release.

Transaction-history rollback restores the selected transaction's prior source and public configuration. Restoring its saved private state is an explicit separate choice; external side effects and messages already sent cannot be rolled back. Interrupted version transactions block affected modifications and starts until reviewed recovery. Do not remove recovery markers or transaction directories to bypass this.

Removing a group only removes the group; its instances can remain. Group uninstall reviews exclusive and shared instances and retained consumer dependencies. A provider required by retained consumers cannot be silently removed. Uninstall unregisters selected instances; it is not a promise to delete source or business data. Stop only currently owned processes selected in the review.

## Demonstrate replacement

Verify transport behavior and business outcomes separately: authorization, input/output contract, subscription readiness, disconnection, duplicate delivery, timeout ambiguity, and retained state. A second provider can replace the first only when it implements the same public semantics and the deployment updates the binding appropriately. The repository's independent text-statistics provider contract is a concrete example, not a required contract for all modules.

Authoritative details: [author guide](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/developer.en.md), [module behavior](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/modules.md), [module Schema](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/module.schema.json), [deployment Schema](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/deployment.schema.json), [group Schema](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/module-group.schema.json), [independent provider contract](https://github.com/oooBCKooo/world-hub/blob/main/docs/modules/provider-contract.md), and [machine-readable example contract](https://github.com/oooBCKooo/world-hub/blob/main/docs/modules/text-statistics.contract.json).
