# Modules and headless deployment resources

World Hub and its APIs work without a graphical interface. World Hub UI is a separate optional client. Use the same local management API from scripts or tools rather than depending on browser selectors.

Use [management](management.md) for CLI commands and explicitly allowed management MCP tools. Discover the installed operation schemas with `world-hub operations --json`; complex bodies belong in JSON input files, rather than guessed command flags.

A module is a program and its hub bridges. Publish independent `module`, `configuration` and `data` artifacts: bodies contain code; configurations pin exact bodies and describe logical instances, wiring, settings and startup plans; datasets contain author-declared business files. Global/local is scope. Private backups stay local. Retired pack/template/module-group artifacts are not automatically converted.

Direct HTTP clients GET `/manage/api/state` for the current operation token and `/manage/api/resources` for resource state, then POST resource operations with `Content-Type: application/json` and `X-Management-Token`. The CLI and management MCP adapter obtain this token internally and omit it from ordinary results. Keep the loopback, Host and Origin restrictions; a browser proxy is not an execution grant.

Import body artifacts before instantiating programs. Importing a configuration saves it; `profiles/prepare` fetches missing exact bodies from enabled configured sources. `profiles/preview` reviews mappings, conflicts and required stops; `profiles/apply` applies the current review after explicit acceptance without starting programs.

Datasets are independently imported. Review their target mappings while instances are stopped, then explicitly acknowledge application data compatibility before restore. The manager preserves bytes and a previous-data image; it does not understand or migrate business formats. Configuration data references do not silently download or restore data.

Active, retained and explicitly selected configurations plus running/unknown instances protect shared dependencies. Preview cleanup from the set to retain; do not uninstall everything associated with one configuration when another configuration references the same instances. Cleanup unregisters reviewed instances, preserves business data, and can remove only unreferenced cached bodies.

Author defaults do not grant local execution. Inspect code, interpreter/dependencies, ownership and permissions before starting. Resident/on-demand lifecycle policies and allowed callers are separate local decisions. Version transitions and rollback use reviewed transactions; do not modify files behind saved digests or remove recovery journals. Business compatibility and external side effects remain the application's responsibility.

Local reference groups can select existing instances for management without duplicating module bodies. They are not the retired downloadable module-group artifact. Published assembly belongs in independently versioned configuration artifacts, with exact module-body references and explicit data references.

Authoritative references: [module resources](https://github.com/oooBCKooo/world-hub/blob/main/docs/specs/module-resources.md), [management API](https://github.com/oooBCKooo/world-hub/blob/main/docs/specs/management.md), [module author guide](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/developer.en.md), [module Schema](https://github.com/oooBCKooo/world-hub/blob/main/docs/ecosystem/module.schema.json), and [provider contract](https://github.com/oooBCKooo/world-hub/blob/main/docs/modules/provider-contract.md).
