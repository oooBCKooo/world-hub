# Connect independent programs through module bridges

[中文](external-programs.md) · [JavaScript SDK](../../sdk/javascript/README.md) · [Protocol](../specs/protocol.md)

Programs may install dependencies, own state, create windows and manage their own child processes, then connect through module bridges. Electron hosts, browsers, games, database services and existing CLIs are ordinary communication participants from the Hub's perspective. Hub Core does not choose their application shape or business behavior.

The optional Launcher Runtime v1 is a limited deployment profile with `module.json`, `pack.json`, `pack.lock`, supported Node/Python entries and its lifecycle/permission declarations. It is not a prerequisite for Hub access and does not require stateless programs. Adding a manifest alone does not adapt an Electron host's dependencies, windows or lifecycle.

| What you have | What to do |
| --- | --- |
| An application source tree, Electron project or executable | Install and run it using its own instructions, configure a Hub connection, identity and permissions; Launcher import is unnecessary |
| Runtime module source with `module.json` | Select it as an addition/replacement candidate in Creator; compose a pack |
| A pack root containing `pack.json` and `pack.lock` | Inspect, import, review and authorize the instance in Launcher |

Runtime v1 source distribution permits 8 MiB per file, 64 MiB total and 4096 files. Installed `node_modules` or native runtimes may exceed these bounds. Do not silently drop dependencies to create an incomplete package. Prepare a complete supported distribution or use the application's own installer/host. These bounds neither prohibit binaries, GUIs or child processes from connecting to the Hub nor establish OS sandboxing.

For a real two-way connection, generate separate private tokens with Node's `crypto.randomBytes`, register both identities and their minimum publish/subscribe rights in a private Hub configuration, then start the Hub and programs separately. Default public configuration does not authorize new applications automatically. The [complete configuration and SDK adapter example](external-programs.md#配置一个真实的双向连接) includes the generation command and uses application-selected IDs and topics; they are examples, not reserved categories or built-in UI protocols.

In `acl.credentials`, `credential` is the registered identity ID and `token` is its authentication secret. Use a separate bridge ID for the connection. Wait for connection, channel-registration and subscription receipts before sending consumable data. Route replies to the trusted `fromPrincipal`; an owner claimed in the message body is not an authenticated identity. Follow the SDK's separate `acl.bridges` registration mode when no credential ID is supplied.

Program authors own recovery policy. A saved ACK cursor cannot reconstruct a view held only in memory. Persist required state before ACK, or define a provider snapshot request. Make revisions comparable across restarts or define an application epoch, and retain close/revision information to reject stale opens. Handle asynchronous business failures explicitly, with application-defined deduplication, retry and business acknowledgements. Hub acceptance is not business success.

A desktop process, local HTTP endpoint, authenticated Hub connection, ready subscription and successful business exchange are distinct states. Show actual connection state. Reconnection, credentials, windows, user data and owned child-process cleanup belong to the external program.

Electron's npm package and platform binary are separate installation materials. For the pinned Electron 44.7.1 package, run `npm exec -- install-electron` after installing project dependencies; `npm install` alone does not install a runnable desktop binary. Its tools require Node 22.12 or newer, while the independent Hub SDK still supports Node 22.4 and newer.

Validate bidirectional exchanges, identity-separated views, rejected credentials/permissions, restart recovery, duplicate and late messages, accurate disconnection status, business errors and confirmed shutdown. Report application defects separately from Hub communication defects. One working UI contract does not establish correctness of every future application.
