# World Hub unified entry and optional Launcher

[中文](launcher.md) · [Path selection, drafts and task results](../launcher-ux.md#english)

The optional Launcher gives local packs a browser entry for importing, reviewing, running and maintaining independent instances. It calls the existing [reference Runtime](runtime.md) and links to Hub topology management and the communication workbench. Hub Core handles communication; Runtime owns its processes, instances and logs; Launcher handles user review and navigation. Local management does not require Workshop to be online.

## Open Launcher

```powershell
world-hub ui --open --root F:\hub-instances
```

From source:

```powershell
node bin/world-hub.mjs ui --open --root F:\hub-instances
```

Use `--port 0` for an assigned port, and `--node <executable>` or `--python <executable>` to select installed interpreters. The backend binds to `127.0.0.1`. Open the one-time launch URL printed by this backend to establish the browser session. The instance root is selected when the backend starts; instance IDs select objects within that root.

## Import, review and run

1. Select a local directory containing `pack.json`, `pack.lock` and the locked module sources. Use **Browse…**, a known candidate or manual input. Select installed interpreters where necessary.
2. Check declarations, platform, contracts, file digests, interpreters and locked dependencies. Read module sources, entry points, execution order, environment and declared permissions.
3. Create a new instance ID. Import copies the checked package; it does not run modules, install dependencies or overwrite an existing instance.
4. Review the current instance contents and explicitly authorize execution. Changed code, wiring, permissions or interpreters require a new review.
5. Observe process state, real Hub bridge connections, module readiness reports and health probes separately. Open a declared local application entry when available. Confirm business results in the application.
6. Inspect component logs and Hub topology. **Hub management** opens running topology; **Communication workbench** selects a Hub for message and request debugging.
7. Stop the instance and wait for confirmed process exits. Starting again requires checking and authorizing current contents. Exporting a package writes shareable software to a new directory.

An accepted start or stop request is not proof that a process is running or has exited. Closing a browser tab does not stop an instance. Stop the backend with Ctrl+C and wait for its reported result. Unconfirmed cleanup retains diagnostics and the actual ownership needed to retry stopping; an old PID is not authority to terminate a process.

## Paths, drafts and operations

[The bilingual interaction guide](../launcher-ux.md#english) explains the local picker, bounded user-triggered discovery, recoverable private Creator drafts, tasks and results, responsive navigation and language selection.

Creator follows source, composition and generation. Its contract map displays static declarations and draft bindings, not live information flow. Restoring a saved draft rereads the source baseline and rechecks candidates; it restores no execution authorization. Generate a new pack, import a new instance and review it before execution. Existing source packages and instances remain available.

**Tasks & results** can reconnect to tasks after a page refresh while the same Launcher backend is running. It retains up to the latest 128 tasks in that process; history does not survive a backend restart. Output files and private drafts have their own persistence. Cancellation is a request and may leave partial output; inspect its final result.

## Environment and execution boundaries

Path discovery reads files without executing programs. Explicit environment checks run fixed version and dependency probes using the selected trusted interpreters, without executing package entry points or install scripts. Missing or mismatched environments prevent starting. Launcher does not automatically download interpreters or execute third-party repair commands.

Default **trusted-local** execution has no OS sandbox. Optional Node/Python container protection and existing Linux user identity separation require explicit configuration and review. Existing Linux user mode separates accounts without claiming to sandbox that account. Independent instance directories and Hub identities are not filesystem access isolation by themselves. Inspect the profile displayed in each execution review.

The limited Python dependency-preparation flow uses an installed compatible interpreter, a new private venv and the exact reviewed wheel digest. It requires explicit review before preparation. The resulting environment must be selected and rechecked before a pack is imported or run. Unknown dependencies require separate preparation.

## Data, sources and collaboration

Private backups can include business data and secrets. Restore checks the current backup digest and creates a new instance, with new Hub identity and runtime credentials. Execution still requires a new review. Public package exports exclude instance data, logs and generated Runtime credentials, but include public settings; verify that those settings contain no secrets.

Optional sources can be local index files or HTTPS indexes. Fetching checks the reviewed index and artifact digests, then caches content locally. It does not install, import or execute modules. Publisher identity, content integrity, execution authorization, isolation and business acceptance are distinct. Existing local instances remain manageable without community availability.

Creator publication generates local shareable artifacts; it does not upload them automatically. Comments use a private local journal and self-declared authorship. Collaboration proposals bind the source baseline and artifact digest, reject conflicts and write a new output directory. They do not modify the original source, execute modules or automatically send messages to collaborators.

The full [Chinese Launcher reference](launcher.md) documents maintenance, environment preparation, upgrade paths, API routes and browser boundaries. [Runtime](runtime.md), [authoring](authoring.md), [sources](sources.md) and [Workshop](workshop.md) provide the detailed implementation contracts.
