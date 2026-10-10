# Module authors: independent implementation and replaceable delivery

[中文](developer.md) · [Launcher guide](launcher.md)

Modules are external programs. They exchange information through their own bidirectional mod bridges and agree on application contracts. The optional Runtime deployment profile and author tools below do not prescribe every program's shape or move business logic into Hub Core.

```powershell
npm install -g world-hub
world-hub-pack init-module ./my-statistics --id author.statistics --runtime node
world-hub-pack validate-module ./my-statistics
world-hub-pack doctor-module ./my-statistics
node --test ./my-statistics/logic.test.mjs
```

The destination must be new. Generation includes a manifest, runnable program, business logic and self-test, complete bridge SDK, MIT license and machine-readable contract. It does not install dependencies or execute code. For Python, use `--runtime python`, select your trusted interpreter with `doctor-module --python <path>`, and run `python -B -m unittest test_logic.py` inside the generated directory. Prepare the declared dependency yourself; doctor only probes the interpreter and the known websockets requirement, and does not inspect arbitrary dependencies.

Validation checks the optional Runtime manifest, ordinary bounded files, declared entry and platform. Generic modules are not required to use a particular SDK layout or contract file. Generated samples additionally use an optional `author-sample.json` marker to check their included materials; remove that marker when adopting a different layout. Failures return structured issues with path, stage, code, message and remedy, and a nonzero CLI exit code. Structured results use stdout; command errors use stderr.

The sample implements the exact Unicode, LF, UTF-8 and SHA-256 semantics of `text.statistics@1.0.0`. Its optional Runtime adapter receives `--runtime-config`, handles health/stop over stdin and reports readiness only after actual bridge registration and subscription receipts. Public `topicKey` and `callerId` settings default to `stats` and `desk`; credentials and actual connections come from private deployment configuration. It does not implement the separate capability-directory advertisement/lease profile; follow the [provider contract](../modules/provider-contract.md), currently in Chinese, when adopting that profile. Self-tests establish only the included algorithm's behavior.

```powershell
world-hub-pack publish ./my-statistics --destination ./statistics-publication --kind module --acknowledge-licenses true
world-hub-pack source ./statistics-publication/index.json
world-hub-pack fetch-source ./statistics-publication/index.json --index-digest '<reviewed digest>' --entry '<entryId>' --cache ./artifact-cache
world-hub-pack preview-replacement '<original pack>' --component stats --module '<fetched module>' --python '<Python path>'
```

Publication produces local data artifacts and an open index, without uploading. Choose a static HTTPS source or optional Workshop after reviewing redistribution rights. Launcher also supports discovery, verified caching, persistent source configuration and explicit conflicts; the community server never executes uploads.

Replacement previews compare the actual candidate's contracts, bridge slots, identity, platform, entry, license and declared permissions. A shared Module ID affects all references; a new ID affects only the selected component. The preview and derivation share declaration checks. Previews neither write files nor run code, explicitly return `businessValidated:false`, and leave state compatibility unknown.

Open the original pack in Creator workspace, select a component, enter a candidate directory, review the differences and save. Derive a new directory and lock, import a new instance, then review and authorize the actual code and environment before starting. Headless creator commands remain available through `--help`. Changed code or interpreters require fresh review.

Validate real source → processor → interface results, failed authorization, wrong versions, Unicode boundaries, unknown timeout outcomes, health versus communication, confirmed shutdown and restart identities. Hub acceptance and ACK are not business success. Preserve the original package and instance. Returning to old code does not roll application data back; use a compatible private backup when old state is required.

`test:ecosystem` verifies generation, public CLI publication/discovery/fetch, both language replacements and real bridge results. Existing isolated-author evidence is an AI exercise from frozen documents, not acceptance by two independent human developers. Only Module and Pack are distributable source artifact kinds today. Built-in samples are not shareable Template objects. Arbitrary migrations, OS isolation, all-platform compatibility and human third-party acceptance remain separate work and validation scopes.

Use `--version` and `completion powershell|bash|zsh|fish` for version output and shell completion scripts. All commands support noninteractive parameter-driven use. The original standalone Hub and headless Runtime remain available.
