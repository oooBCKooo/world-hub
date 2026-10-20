# Module import, connection and direct composition

[简体中文](launcher-deployment.md) · [Launcher](launcher.en.md)

## Import a module

Choose an author's module directory or ZIP in Module Library. It includes `module.json`; optional `deployment.json` supplies public settings, topic aliases and bridge permissions. Arbitrary projects, installed runtimes, packs and templates are not the current module format. Do not guess by omitting files.

Import checks and registers source without executing it. Versions share a project selection. Conflicting bytes for an identical ID/version require an explicit choice. Removing a library version does not stop or delete a registered instance.

## Register with the shared Hub

Select a version and create an independent instance. Review its name, interpreter, settings, concrete topics and bridge publish/subscribe rules. If the author omitted defaults, use its documentation; the Hub does not guess application channels. Multiple instances use distinct identities and state directories.

Review current source and interpreters before starting. Resolve missing dependencies and content changes, then inspect again. Registration is separate from execution approval.

## Save directly in Workbench

Select connected instances and edit settings, topics, bridge permissions and required capability providers. Bind exact provider instances and contracts; matching labels do not establish application compatibility.

Review the current configuration revision, changes and affected scope. Save the chosen instances directly. Stop affected instances when required; unrelated instances keep running. Stale reviews cannot overwrite concurrent changes. Changing settings does not change the Hub release or module artifact version.

Workbench no longer generates packs or instantiates templates. Credentials and business data are not public settings.

## Groups and startup plans

Groups reference existing instances. Two groups referencing one instance share its settings and process. Plans select members, exact order and prerequisites; unselected members can start manually later.

Review affected groups and consumers before stopping or editing a shared member. Deleting a group preserves instances. Instance removal and data cleanup are separate actions. Resetting a plan changes the draft and retains the current member set; saving requires review.

## Sources and unavailable choices

Successfully acquired modules enter the local library. Fetching does not authorize execution. An unavailable source shows its error and previous index observation; only backend-verified artifacts can be used from cache.

Available choices stay selected. A missing choice falls back within the same project, preferably to the same instance, directory or source artifact, with a visible notice. It does not download, upgrade, start or reuse an old review.

Self-managed Electron applications, services and existing software can [connect directly](external-programs.en.md) to the same Hub. Launcher does not take ownership of their windows or unknown processes.
