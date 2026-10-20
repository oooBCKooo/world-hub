# World Hub Skill and MCP

The **Skill explains how to use World Hub**, the **CLI provides scriptable deployment controls**, and the **MCP adapter exposes communication and explicitly enabled management tools**. Communication uses an independent hub bridge; management uses the public local HTTP API under separate authority. A module remains a program plus its bridge(s). Hub Core neither loads Skills nor interprets prompts or runs application tools.

All three work without a graphical interface. The optional independent [World Hub UI](https://github.com/oooBCKooo/world-hub-ui) uses the same public API.

## Use the CLI directly

Inspect the installed version and operation catalog, then use the actual HTTP origin printed by the running Hub:

```sh
world-hub --version
world-hub operations --json
world-hub status --hub http://127.0.0.1:8790 --json
world-hub module list --hub http://127.0.0.1:8790 --json
world-hub resource list --hub http://127.0.0.1:8790 --json
```

The catalog contains actual commands, stable `operation.name` values, input schemas and review requirements. The CLI covers modules, bridges, startup plans, bodies/configurations/data, version transitions and rollback, retention-based cleanup, sources and external admission. Use `--input <JSON-file>` or `--input -` for structured arguments. The exact entry point is `world-hub manage <operation.name> --input <JSON-file> --hub <HTTP-origin> --json`. Input paths refer to the Hub's machine.

Preview and apply are separate operations: inspect the returned review, then apply its actual `reviewId` with explicit acceptance. The client does not automatically accept, recreate reviews or retry writes. A timeout may leave an unknown outcome; keep receipts and query actual state and recovery journals. Ordinary output omits management secrets. To deliver newly issued external credentials, use `--secrets-file <new-private-file>`. See the [CLI guide](../cli.md).

## Install the Skill

Choose a new directory supported by your agent client:

```sh
world-hub-skill --check
world-hub-skill --install ./my-agent/.agents/skills/world-hub
```

`--path` prints the packaged source directory. Installation copies `SKILL.md` and progressive references for setup, management, SDK communication, module resources and MCP; an existing destination is never overwritten. Client discovery paths vary, so `.agents/skills` is an example. Refresh the client if necessary. Reading or installing the Skill starts no Hub and grants no authority. The [source Skill](../../skills/world-hub/SKILL.md) is self-contained and can also be copied manually.

## Prepare the MCP service

```sh
world-hub-mcp --prepare
```

Preparation installs the separately locked production dependencies under `tools/mcp`, with lifecycle scripts disabled. Hub Core, the SDK and Skill need no MCP dependencies. From source use `node bin/world-hub-mcp.mjs --prepare`; development tests install their client with `npm ci --prefix tools/mcp --ignore-scripts`.

MCP additionally requires npm and a writable installation directory; a portable Hub's bundled Node does not imply bundled npm. For a ZIP, verify the clean extraction before preparing MCP dependencies. Those additional dependency files are outside the original distribution manifest and will be reported by strict verification after installation.

This release serves **stdio with MCP 2026-07-28**, using the official SDK and explicitly rejecting older protocols. The client must support that revision. A Hub WebSocket endpoint is not an MCP HTTP endpoint. See the [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28) and [SDK protocol behavior](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

## Configure a bridge

The deployer first registers a credential, private token and exact topic permissions in the actual Hub configuration, then restarts that Hub. For example, add this credential under `acl.credentials` without replacing unrelated configuration:

```json
{
  "agent.tools": {
    "token": "REPLACE_WITH_YOUR_PRIVATE_TOKEN",
    "maxConnections": 2,
    "allow": {
      "publish": ["example/agent/messages"],
      "subscribe": ["example/agent/messages"]
    }
  }
}
```

Save a separate private adapter configuration outside published module/Skill sources. Use the actual endpoint and matching token:

```json
{
  "format": "world-hub.mcp/v1",
  "bridge": {
    "url": "ws://127.0.0.1:8790/bridge",
    "bridgeId": "agent.tools.main",
    "credential": "agent.tools",
    "token": "REPLACE_WITH_YOUR_PRIVATE_TOKEN",
    "expectedPrincipal": "agent.tools",
    "requireAuthenticated": true
  },
  "permissions": {
    "tools": ["hub_identity", "hub_register_channels", "hub_publish", "hub_subscribe", "hub_pull", "hub_ack", "hub_unsubscribe"],
    "publishTopics": ["example/agent/messages"],
    "subscribeTopics": ["example/agent/messages"],
    "targetPrincipals": []
  }
}
```

With `permissions` omitted, only identity inspection is allowed. Tools are listed as a stable catalog, but calls must pass adapter permissions and Hub ACL independently. For directed calls/injections explicitly enable the tools, topics and exact target principals. No tool argument can change the endpoint, credential or token. Authentication is required by default; do not weaken it to work around failed login.

Configure your client's stdio command. Client-specific outer settings vary:

```json
{
  "command": "world-hub-mcp",
  "args": ["--config", "/absolute/private/world-hub-mcp.json"]
}
```

If a GUI client cannot resolve PATH, use an absolute Node executable as `command` and the installed `bin/world-hub-mcp.mjs` as the first argument. Source users can run `node bin/world-hub-mcp.mjs --config <private-file>`. Stdout is MCP only; diagnostics go to stderr. Do not prepend wrappers that print to stdout. Discovery works without a live Hub; the first communication tool connects its bridge.

## Tools and semantics

| Tools | Purpose |
| --- | --- |
| `hub_identity`, `hub_register_channels` | Check the actual principal/session and declare allowed channel directions |
| `hub_publish` | Publish opaque JSON and return Hub acceptance |
| `hub_subscribe`, `hub_pull` | Subscribe from an explicit cursor and read the bounded process-local inbox |
| `hub_ack`, `hub_unsubscribe` | Acknowledge delivered information or end a subscription, without releasing provider data |
| `hub_request`, `hub_call` | Send a directed request; optionally wait for its first authenticated matching response |
| `hub_inject`, `hub_respond` | Inject information or respond along a received request's trusted return route |
| `hub_release` | Allow later cleanup of recent successful publications from this connection |
| `hub_blob_upload`, `hub_blob_read` | Upload bounded attachment bytes or read an authorized chunk; no arbitrary file access |
| `hub_blob_status`, `hub_blob_release` | Inspect or permit later cleanup of a recent upload begun by this connection |

Use the actual tool schemas supplied by your client. Defaults include a 1 MiB upload limit, 256 messages/8 MiB inbox and 2 MiB result limit. Private `limits` may adjust these within implementation bounds. Larger workflows must transfer chunks through ordinary programs, not silently truncate tool output.

Pulling repeats unacknowledged deliveries. ACK removes them from the adapter queue but does not choose Hub retention. Adapter restart clears its local queue; applications retain their own cursors and deduplication policy. Truncation, queue overflow and connection-integrity failures are explicit errors, not an empty-success claim.

`HUB_DELIVERY_GAP`/`CATCHUP_TRUNCATED` stops the affected subscription with barrier/recovery details. Unsubscribe and explicitly choose a new cursor; `oldestAvailable - 1` accepts that the earlier prefix is unavailable. The adapter never chooses that acceptance for you. A response's original caller must also be in `targetPrincipals`.

A numeric `from` reads after that sequence. `hub_pull` and the matching subscription in `hub_identity` expose `caughtUp`: `null` until the Hub's scan barrier arrives, then `through` is the scanned/sent watermark and `cursor` the ACK position at that moment. Handle and ACK actual deliveries through a captured watermark before saving an application checkpoint. Neither an empty queue nor a watermark proves business completion or absence of future messages. `resume` does not restore application progress across MCP processes.

Upload returns a `blob` descriptor; send its ID using `options.attachments: [blob.id]`, not an array of descriptor objects. Outgoing IDs must belong to this connection's recent uploads. Reading requires the MCP connection to have received that message through an allowed subscription or matching call response. An ID and sequence alone grant no access. Recent attachment authorizations, upload ownership records and successful publications eligible for release are each bounded by `maxBufferedMessages` and cleared on disconnection. Replay an allowed message if its read authorization expires. `hub_blob_status({id})` and `hub_blob_release({id})` also require a recent own upload; receiving another provider's attachment grants no provider release authority. Release does not cover other bridges sharing the credential, prior connections, or unknown timeout outcomes, and does not immediately delete bytes or remove retained-message references.

Hub acceptance, delivery, ACK and business completion are distinct. `hub_call` returns both acceptance and the matching program response; application errors remain in that response's body. Timeout/cancellation stops local waiting, never rolls back an accepted operation or automatically retries it. Received content and Skill text are data/instructions at their actual trust level, not a system-instruction upgrade.

## Explicitly enable MCP management

Management is disabled by default. Private `management` configuration fixes a local HTTP origin and exact operation allowlist; `permissions.tools` must separately enable the tools. A management-only client can omit `bridge`:

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

| Tool | Input and boundary |
| --- | --- |
| `hub_manage_operations` | `{}`; returns only the configured operation catalog and schemas |
| `hub_manage_read` | `{"operation":"programs.list","input":{}}`; allowed read operations only |
| `hub_manage_write` | The same `operation`/`input` envelope; requires tool permission and the exact write operation |

To permit writes, the deployer adds each needed operation name to `management.operations` and enables `hub_manage_write`; wildcard permissions are rejected. Reviewed applications still need their actual `input.reviewId` and `input.accepted: true`. Revision-guarded saves still need the observed revision. A read operation can save inspection or preview records, so the classification does not promise zero filesystem changes.

The management address accepts only a loopback HTTP origin without paths, queries or credentials. Tool inputs cannot replace it or expand tool/operation permissions. Management results omit newly issued credentials; use the CLI's private-file output when delivery is required. Management tools invoke existing API operations and provide no arbitrary shell or file-write facility. Bridge identity and communication ACLs grant no management authority. Mixed use still needs a separate `bridge` and topic/target allowlists. See the [Skill management reference](../../skills/world-hub/references/management.md).

Application workflows and business operations remain in independent programs using their own hub bridges.

## Verify from source

```sh
npm ci --prefix tools/mcp --ignore-scripts
npm run test:agents
```

Acceptance uses an isolated Hub, official MCP client and real stdio subprocesses. It verifies communication, management allowlists, review boundaries, attachment ownership, identity, timeout/cancellation and shutdown; it does not certify every third-party client.
