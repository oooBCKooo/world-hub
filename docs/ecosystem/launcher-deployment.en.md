# Install, compose and connect independent programs with Launcher

[简体中文](launcher-deployment.md)

Launcher is an optional deployment service. Programs own their business, state, windows and internal children; the Hub handles module bridge communications. An ordinary source project is not automatically treated as an installable module.

In My Modules, select Import Local Module, choose a ZIP or distribution folder, then Inspect and Import. This validates the distribution without running its code. A source folder missing its declaration produces an error rather than a success card.

To build a pack, select Create Composition on a module card or Create Pack in Workbench. Add modules, choose exact versions and capability providers, enter public program settings, then review and create/import the pack. Select Start on its card and review execution and dependency preparation. No configuration-file editing is required; a runnable pack must have complete wiring.

To share the local Hub without creating a pack, select Connect to Local Hub. Register the provider, then register its consumers and choose their provider in the form. Register all collaborators before reviewing their starts in Manage Local Independent Programs. Programs have separate private identities, permissions and state directories. Stopping one preserves the shared Hub and other programs. Stopping the local Hub cancels active preparation and queued program starts, waits for cleanup, stops its owned programs, then stops the Hub. New starts are blocked until stopping finishes.

Provider configuration is a reviewed startup snapshot. If a new consumer needs its identity accepted by an already running provider, review and restart that provider. The Hub accepts new bridges but does not change application business authorization. Launcher never adopts unknown processes or kills a process using a saved PID.

Packs, modules, templates and downloaded artifacts are grouped by stable project ID. Select an exact version, source, directory or instance within its card. Refreshing or discovering a newer release preserves the selection. A disappeared selection requires explicit reselection. Runtime instances, state and stop operations remain independent. Removing a module/template library option hides that selected directory; it does not delete source files.

## Author declaration

`module.json` retains `world-hub.module/v1`. Optional `deployment.json` uses `world-hub.deployment/v1`; see its [schema](deployment.schema.json) and [desktop example](../../examples/soft-ui-modules/desktop/deployment.json). It provides bilingual names, default topics and bridge permissions, plus public setting fields. Capability semantics remain application-owned.

`world-hub.run/v1` now includes `bindings`, the selected exact capability edges, and optional `deployment.directory`, the private prepared code/dependency directory. Topic aliases map declaration defaults to actual bridge wiring. Programs resolve collaborators through `peers` and `bindings` rather than fixed instance IDs. The existing `--runtime-config`, `module-ready`, `module-health` and cooperative stop lifecycle remains in use.

The `npm-lock` dependency recipe requires package manifests, a complete v3 lock, exact direct versions, official npm registry URLs and SHA-512 integrity. Preparation follows explicit execution review, runs no module-defined or dependency installation hooks, and uses no global npm account/configuration. The prepared source and dependency inventory is checked before reuse; changed source, locks or installed files require a new review or are rejected.

The optional Electron recipe currently supports pinned Electron 44.7.1 through its official installer and release checksums, requiring Node 22.12.0 or later. The first installation can download a large runtime. Completed, verified environments can be reused.

Node modules may declare `permissions.processes: "owned-children"` for reviewed local native hosting. Windows uses a current-owner Job; Linux uses a current live supervisor's process group. Cooperative stop is followed by owned-tree retirement when necessary. Other platforms refuse this deployment profile before installation. Linux descendants deliberately escaping the group are outside its guarantee. This is lifecycle ownership, not an OS sandbox. Existing `none` modules remain compatible; container profiles still require no declared child processes.

The separate demonstration distributions are `world-hub-soft-ui-desktop-0.3.0.zip` and `world-hub-soft-ui-counter-0.3.0.zip`. Their source is in [examples/soft-ui-modules](../../examples/soft-ui-modules/README.md). Windows and counter business state remain outside the Hub.
