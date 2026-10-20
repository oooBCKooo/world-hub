# Module author guide

[简体中文](developer.md) · [Declarations](modules.md) · [Independent programs](external-programs.en.md)

Choose the program's business responsibilities and public application contract, then select an SDK or implement a bridge. The Hub does not define pages, models, business storage or internal architecture.

1. Implement bidirectional communication with the [protocol](../specs/protocol.md) and [JavaScript](../../sdk/javascript/README.md), [Python](../../sdk/python/README.md) or [PowerShell](../../sdk/powershell/README.md) SDK.
2. Define topics, payloads, directed calls and result semantics. Verify participant identities; distinguish delivery, ACK and business completion.
3. Use your own installer, or supply a [module manifest](modules.md) and optional deployment defaults for the communication management interface. Deliver source as a module directory or ZIP.
4. Import, register an independent instance, inspect the interpreter and permissions, then explicitly review startup on the shared Global Hub.
5. Test actual consumers, disconnections, timeouts, redelivery and replacement before publishing an immutable version.

Authors supply their own tests, for example `node --test <test file>`. A connected badge is not complete acceptance.

To suggest an execution mode for new instances, add this field to `deployment.json`:

```json
"executionDefaults": { "mode": "on-demand", "idleTimeoutMs": 60000 }
```

`mode` is required and accepts `resident` or `on-demand`. The optional idle timeout is an integer from 1000 to 86400000 milliseconds; omitting it selects 60000. A group member's `configuration.executionDefaults` overrides its module default. With neither declaration, a new instance defaults to resident with a 60-second timeout. Import review shows the resulting policy and its source. The instance remains stopped with an empty allowed-caller list. Users may override local policy; upgrades, downgrades and rollback retain existing instances' current local policy. Group export carries only mode and idle timeout; author defaults must not include `allowedCallers` or execution grants. See [module behavior](modules.md) and the [lifecycle SDK](../../sdk/javascript/LIFECYCLE.md) for the invocation contract.

The [provider contract](../modules/provider-contract.md) and [machine contract](../modules/text-statistics.contract.json) support an independent text-statistics implementation. The [interoperability benchmark](interop.md) separates declarations, bridge behavior and business results.

The current product does not provide pack/template generation commands or the old public `world-hub/runtime` API. Historical author generators are not current distribution entry points. SDK communication exports and the wire protocol remain independent.
