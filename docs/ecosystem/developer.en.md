# Module author guide

[简体中文](developer.md) · [Declarations](modules.md) · [Independent programs](external-programs.en.md)

Choose the program's business responsibilities and public application contract, then select an SDK or implement a bridge. The Hub does not define pages, models, business storage or internal architecture.

1. Implement bidirectional communication with the [protocol](../specs/protocol.md) and [JavaScript](../../sdk/javascript/README.md), [Python](../../sdk/python/README.md) or [PowerShell](../../sdk/powershell/README.md) SDK.
2. Define topics, payloads, directed calls and result semantics. Verify participant identities; distinguish delivery, ACK and business completion.
3. Use your own installer, or supply a [module manifest](modules.md) and optional deployment defaults for the communication management interface. Deliver source as a module directory or ZIP.
4. Import, register an independent instance, inspect the interpreter and permissions, then explicitly review startup on the shared Global Hub.
5. Test actual consumers, disconnections, timeouts, redelivery and replacement before publishing an immutable version.

Authors supply their own tests, for example `node --test <test file>`. A connected badge is not complete acceptance.

## Managed entry point and private runtime configuration

When the communication management interface starts a program, it runs the reviewed interpreter with the manifest's `runtime.entry` and appends `--runtime-config <file>`. A Node entry receives `node <entry> --runtime-config <file>`; a Python entry receives `python -B -s <entry> --runtime-config <file>`. `<file>` is private JSON generated for that run. The working directory is the instance's `stateDir`. Resolve source files and bundled resources relative to the entry file; write durable application data and bridge cursors under `stateDir`.

The current local managed configuration has this structure. Angle brackets and the port below are placeholders; the manager generates the actual paths, identities and token:

```json
{
  "format": "world-hub.run/v1",
  "instanceId": "launcher-local",
  "componentId": "counter",
  "module": { "id": "example.counter", "version": "1.0.0" },
  "stateDir": "<absolute private instance state directory>",
  "settings": { "step": 1 },
  "topics": { "events": "counter/v1/events" },
  "peers": { "counter": { "principal": "<generated principal>" } },
  "bindings": [],
  "bridges": [{
    "slot": "main",
    "endpoint": "ws://127.0.0.1:12345/bridge",
    "bridgeId": "<generated bridge ID>",
    "credential": "<generated principal>",
    "principal": "<generated principal>",
    "token": "<private token>",
    "publish": [],
    "subscribe": ["counter/v1/events"]
  }]
}
```

- `bridges` is an array. Find an entry by its declared `slot` and establish a connection for every declared slot. Pass its `endpoint` as `Bridge.url`, and pass `bridgeId`, `credential` and `token` unchanged to the matching options. The authenticated `welcome.principal` must equal the entry's `principal`; a module ID or slot name cannot replace the authentication identity.
- `topics` maps application aliases to concrete topics. `bridges[].publish` / `subscribe` already contain concrete topics, whereas the matching permission fields in public `deployment.json` contain aliases. Use concrete topics for messages, channel registration and subscriptions. `settings` is the public application settings object chosen for this instance.
- `peers` maps program instance IDs to their `principal`. Runtime capability bindings have the form `{ "from": "provider instance ID", "to": "consumer instance ID", "contract": { "id": "contract ID", "version": "exact version" } }`. Find the provider through a binding, address it using `peers[from].principal`, and validate the authenticated origin of application messages.
- Optional `lifecycle` is a manager-provided [lifecycle SDK](../../sdk/javascript/LIFECYCLE.md) descriptor. Dependency preparation may also add `deployment: { "directory": "<prepared code directory>" }`. These fields are not application settings or fixed local paths.

The configuration file and its token are private to local processes. Do not print, upload, commit or include them in module ZIPs, public examples, HTTP responses or logs. Report fixed diagnostic codes without echoing the configuration or raw authentication errors. Public manifests and deployment defaults carry no credentials.

This minimal Node 22+ entry uses one `main` slot and subscribes to the `events` alias. Declare `runtime: { "kind": "node", "entry": "program.mjs" }` and `bridges: ["main"]` in the manifest, and declare the alias and subscription permission in deployment defaults. Copy `bridge-kit.mjs` and `blob-client.mjs` from the installed package's `sdk/javascript/` into the module as `sdk/bridge-kit.mjs` and `sdk/blob-client.mjs`. Your own `business.mjs` exports `async handleMessage(message, { settings, topics, stateDir, bridge })`. Validate application payloads and origins there, and return only after successful application processing; the SDK automatically ACKs after that Promise succeeds.

```js
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Bridge } from './sdk/bridge-kit.mjs';
import { handleMessage } from './business.mjs';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let bridge, ready = false, closing;
const input = createInterface({ input: process.stdin });
const stop = () => closing ??= (async () => {
  ready = false;
  await bridge?.close('Program stopped');
  input.close();
})();
input.on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.command === 'stop') void stop();
  if (command.command === 'health' && typeof command.id === 'string')
    emit({ event: 'module-health', id: command.id,
      ready: ready && !closing && bridge?.connected === true });
});
input.on('close', () => { void stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-config')
    throw new Error('Invalid startup arguments');
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const slot = config.bridges?.find(item => item.slot === 'main');
  const topic = config.topics?.events;
  if (config.format !== 'world-hub.run/v1' || !slot ||
      typeof topic !== 'string' || !slot.subscribe.includes(topic))
    throw new Error('Invalid runtime configuration');
  bridge = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId,
    credential: slot.credential, token: slot.token, autoAck: true,
    cursorFile: join(config.stateDir, 'main-cursor.json') });
  bridge.on('error', () => { ready = false; });
  bridge.on('close', () => { ready = false; });
  bridge.on('open', welcome => {
    if (welcome.authenticated !== true || welcome.principal !== slot.principal) void stop();
  });
  bridge.on('subscribed', () => { ready = !closing; });
  bridge.on('delivery', message => handleMessage(message,
    { settings: config.settings, topics: config.topics, stateDir: config.stateDir, bridge }));
  const welcome = await bridge.connect();
  if (welcome.authenticated !== true || welcome.principal !== slot.principal)
    throw new Error('Unexpected authenticated identity');
  const names = [...new Set([...slot.publish, ...slot.subscribe])];
  await bridge.registerChannels(names.map(name => ({ name,
    publish: slot.publish.includes(name), subscribe: slot.subscribe.includes(name) })));
  await bridge.subscribe([topic], { from: 'resume' });
  if (!closing) { ready = true; emit({ event: 'module-ready' }); }
} catch {
  emit({ event: 'module-diagnostic', code: 'MODULE_START_FAILED' });
  process.exitCode = 1;
  await stop();
}
```

The manager sends newline-delimited JSON on stdin: `{"command":"health","id":"..."}` and `{"command":"stop"}`. The entry emits newline-delimited JSON on stdout: `module-ready`, and `module-health` with the original `id` and a boolean `ready`. Report readiness after connecting, subscribing and initializing application resources; close the bridge and your resources when stopping. This sample's readiness condition covers communication only; check any additional application resources too. The [Soft UI counter entry](../../examples/soft-ui-modules/counter/program.mjs) demonstrates settings, capability bindings, application state and directed messages.

This is the startup interface between the separate management layer and its managed child processes. The Hub wire protocol does not require this program structure. Independent programs may connect using their own arguments, configuration and lifecycle; application processing, pages and business storage remain inside those programs.

To suggest an execution mode for new instances, add this field to `deployment.json`:

```json
"executionDefaults": { "mode": "on-demand", "idleTimeoutMs": 60000 }
```

`mode` is required and accepts `resident` or `on-demand`. The optional idle timeout is an integer from 1000 to 86400000 milliseconds; omitting it selects 60000. A group member's `configuration.executionDefaults` overrides its module default. With neither declaration, a new instance defaults to resident with a 60-second timeout. Import review shows the resulting policy and its source. The instance remains stopped with an empty allowed-caller list. Users may override local policy; upgrades, downgrades and rollback retain existing instances' current local policy. Group export carries only mode and idle timeout; author defaults must not include `allowedCallers` or execution grants. See [module behavior](modules.md) and the [lifecycle SDK](../../sdk/javascript/LIFECYCLE.md) for the invocation contract.

The [provider contract](../modules/provider-contract.md) and [machine contract](../modules/text-statistics.contract.json) support an independent text-statistics implementation. The [interoperability benchmark](interop.md) separates declarations, bridge behavior and business results.

The current product does not provide pack/template generation commands or the old public `world-hub/runtime` API. Historical author generators are not current distribution entry points. SDK communication exports and the wire protocol remain independent.

## Distribute bodies, configurations and data independently

Module bodies, configurations and data have independent versions. A configuration pins exact body versions and source digests without embedding code. Datasets are separately published; private backups stay local. Global and local scopes share the body pool. Applying configuration, preparing dependencies, granting execution and restoring data are separate operations. Modules define business data compatibility. See the [resource specification](../specs/module-resources.md) and [source formats](sources.md).
