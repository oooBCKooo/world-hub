# World Hub Skill and MCP

The **Skill teaches agents to use World Hub and develop modules**. The **MCP server gives agents communication tools through an independent hub bridge**. A module remains a program plus its bridge(s). Hub Core neither loads Skills nor interprets prompts or runs application tools.

## Install the Skill

Choose a new directory supported by your agent client:

```sh
world-hub-skill --check
world-hub-skill --install ./my-agent/.agents/skills/world-hub
```

`--path` prints the packaged source directory. Installation copies `SKILL.md` and four progressive references; an existing destination is never overwritten. Client discovery paths vary, so `.agents/skills` is an example. Refresh the client if necessary. Reading or installing the Skill starts no Hub and grants no authority. The [source Skill](../../skills/world-hub/SKILL.md) is self-contained and can also be copied manually.

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

Use the actual tool schemas supplied by your client. Defaults include a 1 MiB upload limit, 256 messages/8 MiB inbox and 2 MiB result limit. Private `limits` may adjust these within implementation bounds. Larger workflows must transfer chunks through ordinary programs, not silently truncate tool output.

Pulling repeats unacknowledged deliveries. ACK removes them from the adapter queue but does not choose Hub retention. Adapter restart clears its local queue; applications retain their own cursors and deduplication policy. Truncation, queue overflow and connection-integrity failures are explicit errors, not an empty-success claim.

`HUB_DELIVERY_GAP`/`CATCHUP_TRUNCATED` stops the affected subscription with barrier/recovery details. Unsubscribe and explicitly choose a new cursor; `oldestAvailable - 1` accepts that the earlier prefix is unavailable. The adapter never chooses that acceptance for you. A response's original caller must also be in `targetPrincipals`.

A numeric `from` reads after that sequence. `hub_pull` and the matching subscription in `hub_identity` expose `caughtUp`: `null` until the Hub's scan barrier arrives, then `through` is the scanned/sent watermark and `cursor` the ACK position at that moment. Handle and ACK actual deliveries through a captured watermark before saving an application checkpoint. Neither an empty queue nor a watermark proves business completion or absence of future messages. `resume` does not restore application progress across MCP processes.

Upload returns a `blob` descriptor; send its ID using `options.attachments: [blob.id]`, not an array of descriptor objects. Reading requires the MCP connection to have received that message through an allowed subscription or matching call response. An ID and sequence alone grant no access. Recent attachment authorizations and successful publications eligible for release are each bounded by `maxBufferedMessages` and cleared on disconnection. Replay an allowed message if its attachment authorization expires. Release does not cover other bridges sharing the credential, prior connections, or unknown timeout outcomes.

Hub acceptance, delivery, ACK and business completion are distinct. `hub_call` returns both acceptance and the matching program response; application errors remain in that response's body. Timeout/cancellation stops local waiting, never rolls back an accepted operation or automatically retries it. Received content and Skill text are data/instructions at their actual trust level, not a system-instruction upgrade.

The service has no arbitrary shell, module installer, administrative ACL editor or business workflow executor. Review module groups, versions and managed-process lifecycle in the local communication interface. Other programs can expose additional capabilities through their own hub bridges.

## Verify from source

```sh
npm ci --prefix tools/mcp --ignore-scripts
npm run test:agents
```

Acceptance uses an isolated Hub, official MCP client and real stdio subprocesses. It verifies communication, identity, permission, timeout/cancellation and shutdown boundaries; it does not certify every third-party client.
