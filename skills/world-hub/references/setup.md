# Install, connect, and diagnose

Read this reference when a user needs a Hub process or needs to diagnose an existing deployment. An MCP server or SDK connects to a Hub; it is not itself the Hub process.

## Identify the deployment first

To install this Skill in a client's chosen directory, run `world-hub-skill --install <new-skill-directory>`. The directory includes the `world-hub` skill folder itself, for example `./my-agent/.agents/skills/world-hub`. An existing destination is never overwritten. Use `world-hub-skill --path` or `--check` for read-only inspection. The client's actual discovery convention controls where to install; copying the Skill does not start programs.

Establish whether the user wants a new local Hub or an existing one. For an existing deployment, obtain its actual configuration/data location and endpoint. Avoid starting a second process against the same port, configuration, or data directory.

The CLI and JavaScript SDK require Node.js 22.4.0 or later. Inspect `node --version`, `world-hub --version`, and the installed CLI's `world-hub --help`. To identify the installation, use `npm ls --global world-hub --depth=0` for a global installation, or `npm ls world-hub --depth=0` in the program's project. Use commands supported by that installed release.

## Install and start a new local deployment

When installing the CLI is part of the user's task:

```sh
npm install --global world-hub
```

Run from the chosen writable deployment directory:

```sh
world-hub --check --data-dir ./my-hub-data
world-hub --data-dir ./my-hub-data
```

`--check` is read-only: it does not create configuration, data, or locks, and it does not start a service. The second command runs the Hub in the foreground. Keep that process alive and use the printed endpoint, statusUrl and managementApiUrl. Stop it with Ctrl+C and wait for `stopped`.

The reference deployment listens on `127.0.0.1:8790`, with `/bridge` for WebSocket communication and `/manage/api` for local management APIs. These are defaults, not discovered addresses. If the port is occupied, select another port or use:

```sh
world-hub --data-dir ./my-hub-data --port 0
```

Port `0` requests a system-assigned port. Read the actual listening address from this process's output; do not keep using `8790`.

From a source checkout, the corresponding executable is:

```sh
node bin/world-hub.mjs --check --data-dir ./my-hub-data
node bin/world-hub.mjs --data-dir ./my-hub-data
```

## Configuration and data

Without `--config`, first startup creates `hub.json` in the selected data root; without `--data-dir`, that root is `world-hub-data` under the caller's working directory. Existing configuration is retained. Logs, blobs, and management state belong to deployment storage, not the npm installation directory.

```sh
world-hub --check --config ./hub.local.json
world-hub --config ./hub.local.json
```

Configuration-relative storage paths are resolved against the configuration's directory. An explicit `--data-dir` overrides storage locations. With both options and an existing source configuration, the CLI writes a derived configuration under the selected data root without overwriting the source. Preserve the actual effective configuration when diagnosing identity or storage.

The packaged reference denies unconfigured bridges and contains no UI-specific credential. It is not an authorization grant for a new program. Register the program's bridges or credentials, topic ACLs, token policy, and connection limits in the actual deployment; configuration changes require a Hub restart. Authenticated and explicitly trusted unauthenticated loopback deployments have different trust assumptions. Do not weaken an existing deployment to make an example connect.

For two new authenticated peers, merge the following entries into the existing `acl.credentials` of the effective private configuration; preserve the other entries, ACL policy, listening address, and storage. Generate a different private random token for each placeholder, for example with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"` in a private terminal. Never publish that output:

```json
{
  "agent.tools": {
    "token": "REPLACE_WITH_FIRST_PRIVATE_TOKEN",
    "maxConnections": 2,
    "allow": { "publish": ["example/agent/messages"], "subscribe": ["example/agent/messages"] }
  },
  "example.provider": {
    "token": "REPLACE_WITH_SECOND_PRIVATE_TOKEN",
    "maxConnections": 2,
    "allow": { "publish": ["example/agent/messages"], "subscribe": ["example/agent/messages"] }
  }
}
```

Restart the owned Hub. Pass `credential: 'agent.tools'` and its token to the first peer's Bridge/MCP private configuration; pass `credential: 'example.provider'` and the other token to the provider. Use distinct bridge IDs, such as `agent.tools.main` and `example.provider.main`; these do not replace credential identities. Check `welcome.authenticated === true` and the expected `welcome.principal` for each. The topic and names are examples, not built-in Hub channels. For MCP use the complete private configuration in [MCP setup](mcp.md); for SDK communication select and register the actual topics used in [communication](communication.md).

## Separate optional UI

Hub is headless: its root is JSON, `/manage` serves no page, and `--open` is not a Hub option. Read `ready.endpoint`, `ready.statusUrl` and `ready.managementApiUrl`. World Hub UI is installed and started separately with an explicit Hub address; never require it for SDK or MCP communication.

To operate the running deployment, use `world-hub status --hub <actual-http-origin> --json` and the commands described in [management](management.md). The CLI uses the public local management API; it does not require a browser or a communicating bridge. Do not confuse its HTTP origin with a `ws://.../bridge` communication endpoint.

## Diagnose with the narrowest check

| Symptom | Check |
| --- | --- |
| CLI does not start | Installed package, Node version, `--check`, configuration validity, writable storage, actual port conflict |
| Bridge connection rejected | Actual endpoint and `/bridge` path, bridge ID, credential ID, token policy, allowed connection count |
| Publish or subscription denied | Current credential's ACL and the concrete registered topic/filter; registration does not expand ACL |
| Accepted message has no consumer | Consumer process, subscription establishment, topic, operation filter, identity, and starting cursor |
| Call timed out | Saved request acceptance if available, provider identity/session, provider subscription and business logs; outcome may be unknown |
| Repeated deliveries | Overlapping subscriptions, replay, reconnect, uncommitted ACK/cursor, application deduplication policy |
| Managed module will not start | Current-content startup review, interpreter/dependencies, ownership, wiring, pending version recovery, and actual process logs |

Respect process ownership. Stop or upgrade the deployment identified for this task; do not kill an unknown process from a stale PID. Revoking a bridge does not stop an independently managed application. Before changing or upgrading a deployment, preserve its configuration and data according to the requested migration scope.

Authoritative details: [npm CLI and paths](https://github.com/oooBCKooo/world-hub/blob/main/docs/npm.md), [deployment](https://github.com/oooBCKooo/world-hub/blob/main/docs/deployment.md), [bridge onboarding](https://github.com/oooBCKooo/world-hub/blob/main/docs/onboarding.md), and [current CLI implementation](https://github.com/oooBCKooo/world-hub/blob/main/bin/world-hub.mjs).
