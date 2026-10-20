# Connect independent programs through module bridges

[中文](external-programs.md) · [JavaScript SDK](../../sdk/javascript/README.md) · [Protocol](../specs/protocol.md)

Programs may install dependencies, own state, create windows and manage their own child processes, then connect through module bridges. Electron hosts, browsers, games, database services and existing CLIs are ordinary communication participants from the Hub's perspective. Hub Core does not choose their application shape or business behavior.

Launcher optionally manages independent module instances on one Global Hub. A managed module supplies module.json and optional deployment.json defaults. Packs and templates are not current import types. Self-managed Electron hosts, services and other programs retain their own installer, process ownership, windows and business state.

| What you have | What to do |
| --- | --- |
| Application source, Electron project or executable | Install and run using its own instructions, then configure endpoint, identity and permissions |
| Module directory or ZIP with module.json | Import into Module Library, register an independent instance and review startup |
| Historical pack or template | Obtain the current independent modules instead |

Source delivery is bounded by file count and bytes. Installed dependencies and native runtimes must not be silently omitted to fabricate a runnable module. These deployment limits do not restrict Hub business types and do not establish an OS sandbox.

For a real two-way connection, generate separate private tokens with Node's `crypto.randomBytes`, register both identities and their minimum publish/subscribe rights in a private Hub configuration, then start the Hub and programs separately. Default public configuration does not authorize new applications automatically. The [complete configuration and SDK adapter example](external-programs.md#配置一个真实的双向连接) includes the generation command and uses application-selected IDs and topics; they are examples, not reserved categories or built-in UI protocols.

In `acl.credentials`, `credential` is the registered identity ID and `token` is its authentication secret. Use a separate bridge ID for the connection. Wait for connection, channel-registration and subscription receipts before sending consumable data. Route replies to the trusted `fromPrincipal`; an owner claimed in the message body is not an authenticated identity. Follow the SDK's separate `acl.bridges` registration mode when no credential ID is supplied.

Program authors own recovery policy. A saved ACK cursor cannot reconstruct a view held only in memory. Persist required state before ACK, or define a provider snapshot request. Make revisions comparable across restarts or define an application epoch, and retain close/revision information to reject stale opens. Handle asynchronous business failures explicitly, with application-defined deduplication, retry and business acknowledgements. Hub acceptance is not business success.

A desktop process, local HTTP endpoint, authenticated Hub connection, ready subscription and successful business exchange are distinct states. Show actual connection state. Reconnection, credentials, windows, user data and owned child-process cleanup belong to the external program.

Electron's npm package and platform binary are separate installation materials. For the pinned Electron 44.7.1 package, run `npm exec -- install-electron` after installing project dependencies; `npm install` alone does not install a runnable desktop binary. Its tools require Node 22.12 or newer, while the independent Hub SDK still supports Node 22.4 and newer.

Validate bidirectional exchanges, identity-separated views, rejected credentials/permissions, restart recovery, duplicate and late messages, accurate disconnection status, business errors and confirmed shutdown. Report application defects separately from Hub communication defects. One working UI contract does not establish correctness of every future application.
