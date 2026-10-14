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

Launcher accepts only the current `world-hub.pack-lock/v2` format. Its `hubVersion` records the product release used to generate the lock; it is not an import/start compatibility requirement. `hubCompatibility` must exactly match the current wire protocol (`0.1`) and module run-configuration API (`world-hub.run/v1`). A different recorded product release alone does not block import. Obsolete/unknown lock formats and unsupported contracts are refused, with no legacy implementation, automatic conversion or fallback. Source hashes, platform, interpreter and dependency versions remain strict requirements.

For a current-format package whose interpreter or platform selection needs to change, the author can explicitly create and test a new lock, or use **Copy and rebuild lock** to verify the source and create a separately reviewed copy for the selected environment. This interface rejects obsolete/unknown formats. Existing Hub state and private backup restore retain separate checks against the actual Hub product release; matching communication contracts do not establish persistent-data compatibility.

## Paths, drafts and operations

[The bilingual interaction guide](../launcher-ux.md#english) explains the local picker, bounded user-triggered discovery, recoverable private Creator drafts, tasks and results, responsive navigation and language selection.

**Browse system…** opens the native picker on the Launcher host. For new backup files, exchange files and output directories, choose a parent folder, then enter a new name in the page and check the complete path. A cancelled or stale picker result does not change another field. Built-in template entries use the actual absolute directories and metadata discovered by the backend, including real runtimes and platforms; they do not depend on the startup working directory or substitute fictional language-specific scaffolds.

Creator follows source, composition and generation. Its contract map displays static declarations and draft bindings, not live information flow. Restoring a saved draft rereads the source baseline and rechecks candidates; it restores no execution authorization. Generate a new pack, import a new instance and review it before execution. Existing source packages and instances remain available.

**Add module** inspects the actual candidate and current draft before addition. Configure public `settings`, pack-level `topics`, the declared `bridges` publish/subscribe topic access and `after` startup dependencies; bridge topic access is empty by default. Changed configurations or candidates require reviewing the fresh preflight and confirming again. Unbound required contracts remain visible gaps and must be explicitly bound before generation; other declaration or environment errors block addition. The canvas never invents Hub providers or subscription connections for missing bindings. Fixed graph coordinates scroll in their own region while page controls stay reachable on small screens.

Saved drafts retain public configuration and candidate source records. Restoration rechecks additions and replacements, their current digests, the source baseline and compatibility; it does not reuse old preflight evidence. Changed sources or candidates retain the saved draft for inspection rather than permitting direct generation. Failed saves retain edits for retry and prevent the return action from silently clearing them. Failed backend deletion of a draft likewise retains the current record instead of reporting a successful discard.

**Tasks & results** can reconnect to tasks after a page refresh while the same Launcher backend is running. It retains up to the latest 128 tasks in that process; history does not survive a backend restart. Output files and private drafts have their own persistence. Cancellation is a request and may leave partial output; inspect its final result.

## Environment and execution boundaries

### Crash recovery and Launcher ownership

On Windows and Linux, Launcher holds an operating-system exclusive guard through owner creation and confirmed cleanup. Windows case and 8.3 aliases share the canonical root. Normal shutdown removes `launcher-owner.lock`. Startup recovers a valid leftover owner only when the operating system explicitly reports its recorded PID absent (`ESRCH`), installing complete replacement metadata atomically without a delete/create gap.

A live PID, including a reused PID, permission-denied or unknown probes, truncated metadata and unreadable locks remain protected. Older active Launchers are also protected even though they have no new guard. No recorded process is killed. Other platforms currently retain stale locks conservatively.

```powershell
world-hub ui --inspect-lock
world-hub ui --inspect-lock --root F:\hub-instances
world-hub ui --clean-lock --root F:\hub-instances
```

Inspection is read-only: it prints the root, lock path, state, reason and recoverability, without creating directories/configuration, starting services or reading instance control credentials. `live-or-reused` confirms current PID existence, not identity. `unknown` requires investigating the original owner or unreadable/incomplete metadata. Corruption is not proof of exit. Explicit cleanup uses the same proven-dead check as startup; no unchecked `--force` exists. Lock operations are standalone and cannot be combined with `--open`.

Recovering root ownership does not adopt or stop existing children. Instance `owner.lock`, `control.json` and data stay unchanged, and root-owner death does not establish child exit. Recovery is reported in `launcher-ready.ownerRecovery` and the local `/api/session`; subsequent instance operations still obey Runtime ownership and fresh execution review.

Path discovery reads files without executing programs. Explicit environment checks run fixed version and dependency probes using the selected trusted interpreters, without executing package entry points or install scripts. Missing or mismatched environments prevent starting. Launcher does not automatically download interpreters or execute third-party repair commands.

Default **trusted-local** execution has no OS sandbox. Optional Node/Python container protection and existing Linux user identity separation require explicit configuration and review. Existing Linux user mode separates accounts without claiming to sandbox that account. Independent instance directories and Hub identities are not filesystem access isolation by themselves. Inspect the profile displayed in each execution review.

The limited Python dependency-preparation flow uses an installed compatible interpreter, a new private venv and the exact reviewed wheel digest. It requires explicit review before preparation. The resulting environment must be selected and rechecked before a pack is imported or run. Unknown dependencies require separate preparation.

## Data, sources and collaboration

Private backups can include business data and secrets. Restore checks the current backup digest and creates a new instance, with new Hub identity and runtime credentials. Execution still requires a new review. Public package exports exclude instance data, logs and generated Runtime credentials, but include public settings; verify that those settings contain no secrets.

Permanent deletion includes the instance's software and private data and needs separate explicit confirmation. The backend records a deletion task and reserves the instance before asynchronous observation. Confirmed owned-process exits and a maintenance lock are required; deletion never cancels or takes over running processes. It journals intent, atomically moves the original directory while holding the lock, then cleans up. `POST /api/instances/:id/delete` with `{accepted:true}` waits for actual success or error; acceptance alone is not completion. Failure retains `deletionPending`, any `retainedDirectory` and diagnostics for inspection and explicit retry. Busy operations, unconfirmed exits or ownership conflicts reject deletion; a failed state or old PID is not exit confirmation.

Optional sources can be local index files or HTTPS indexes. Fetching checks the reviewed index and artifact digests, then caches content locally. It does not install, import or execute modules. Publisher identity, content integrity, execution authorization, isolation and business acceptance are distinct. Existing local instances remain manageable without community availability.

Creator publication generates local shareable artifacts; it does not upload them automatically. Comments use a private local journal and self-declared authorship. Collaboration proposals bind the source baseline and artifact digest, reject conflicts and write a new output directory. They do not modify the original source, execute modules or automatically send messages to collaborators.

Browser management credentials remain in origin-scoped `sessionStorage`. The page removes the one-time launch fragment immediately after reading it, before waiting for session exchange. These credentials are neither passed to community pages nor persisted in `localStorage`.

The full [Chinese Launcher reference](launcher.md) documents maintenance, environment preparation, upgrade paths, API routes and browser boundaries. [Runtime](runtime.md), [authoring](authoring.md), [sources](sources.md) and [Workshop](workshop.md) provide the detailed implementation contracts.
