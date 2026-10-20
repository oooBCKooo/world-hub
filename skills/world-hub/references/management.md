# Manage a running Hub without a UI

Use this reference for local deployment controls: module resources and lifecycle, wiring, startup plans, versions, configuration selection and data restoration. For program-to-program communication, use [communication](communication.md) or the communication tools in [MCP](mcp.md). A bridge's credential is not a management credential.

## Discover the installed commands

Use the actual HTTP origin printed by the owned Hub process, without `/bridge` or `/manage/api`:

```sh
world-hub --version
world-hub operations --json
world-hub status --hub http://127.0.0.1:8790 --json
world-hub module list --hub http://127.0.0.1:8790 --json
world-hub resource list --hub http://127.0.0.1:8790 --json
```

`operations` lists the shared operation names, command arrays, input schemas and review requirements. It does not need a running Hub. The CLI uses the public API and preserves its loopback restrictions. Do not expose local management as an arbitrary remote proxy or weaken the Hub's Host/Origin checks to make a client work.

Common areas include `bridge control`, `module`, `startup`, `wiring defaults`, `resource body`, `resource configuration`, `resource data`, `version module`, `uninstall module`, `source`, `workshop`, `external` and `creator`. Inspect the current catalog rather than assuming every operation takes the same fields. The exact operation entry point is:

```sh
world-hub manage programs.inspect --hub http://127.0.0.1:8790 --input ./inspect.json --json
```

For that operation, `inspect.json` contains `{"directory":"/absolute/module-directory"}`. Paths in management inputs belong to the Hub's machine, not a remote agent's filesystem. `--input -` reads a JSON object from stdin. Put settings, instance mappings, startup arrays and other structured arguments in a JSON file; ordinary scalar aliases include `--directory`, `--path`, `--program-id` and `--expected-revision`. Metadata results support `--json`; use `--raw` when reading a retained message if its exact raw JSON representation matters.

## Review, apply and observe

Read operations and previews do not start modules. A preview may save a review or inspect/import metadata, so `readOnly` does not mean every operation is filesystem-free. Imports, downloads and configuration application also do not implicitly start programs.

Source inspection and execution previews can execute interpreter probes; the catalog treats these as writes. Artifact previews that import cache content are also writes. Do not infer read authority from a command's name. `creator scaffold` creates source and registers a stopped module after probing its runtime.

For example, review an already registered instance, inspect that actual review, then start only the reviewed content:

```sh
world-hub module review example.instance --hub http://127.0.0.1:8790 --json
world-hub module start example.instance --hub http://127.0.0.1:8790 --review-id ACTUAL_RETURNED_REVIEW_ID --accept --json
```

`--accept` expresses acceptance of the supplied review, not a request to create one automatically. For JSON inputs, use the returned `reviewId` and `accepted: true` where required. Revision-guarded saves also need the observed revision. Apply neither an invented review ID nor an obsolete review after files or settings have changed. If the operation is already within the user's authorized task, perform it within that scope; the review requirement does not create an extra conversational approval requirement.

Inspect resulting state, logs, version journals or startup status. A network timeout can occur after a management write has taken effect. Preserve operation IDs and review/transaction receipts, query current state, and follow the operation's recovery procedure. Do not automatically recreate a review, accept it or repeat a write. Process start and successful API return do not establish an application's business result.

External admission can create new credentials. Normal stdout omits them. When the user's task requires credential delivery, use `--secrets-file <new-private-file>` with the external apply command, keep that file outside published artifacts and logs, and give it only to the intended program. Do not request secrets through ordinary JSON output or paste them into an agent conversation.

## Explicit management MCP

Management is disabled unless a private MCP configuration specifies both a fixed `management.url` and exact `management.operations`, and enables the matching tools in `permissions.tools`. A management-only adapter can omit `bridge`:

```json
{
  "format": "world-hub.mcp/v1",
  "management": {
    "url": "http://127.0.0.1:8790",
    "operations": ["hub.status", "programs.list", "resources.list"]
  },
  "permissions": {
    "tools": ["hub_manage_operations", "hub_manage_read"]
  }
}
```

This example permits only local inspection. `hub_manage_operations({})` returns only that permitted catalog. Call `hub_manage_read` with `{"operation":"programs.list","input":{}}`. To enable a write, the deployer must add its exact operation name and `hub_manage_write`; call it with the same `operation`/`input` envelope and actual review/acceptance fields where required. The tools do not change their configured origin, tool permissions or operation allowlist, return newly issued credentials, or write arbitrary secret files.

Management uses the local machine's API authority; it is separate from communication ACLs. Adding communication tools requires a configured bridge with its own identity and topic/target permissions. No management tool starts or trusts that bridge as an authorization shortcut.

Authoritative details: [CLI](https://github.com/oooBCKooo/world-hub/blob/main/docs/cli.md), [management API](https://github.com/oooBCKooo/world-hub/blob/main/docs/specs/management.md), [operation catalog](https://github.com/oooBCKooo/world-hub/blob/main/sdk/javascript/management-operations.mjs), and [module resources](https://github.com/oooBCKooo/world-hub/blob/main/docs/specs/module-resources.md).
