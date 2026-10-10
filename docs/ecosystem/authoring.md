# Create, derive and collaborate on local packages

Creator tooling is optional and lives beside Runtime. Hub Core continues to exchange messages; it does not edit packages, choose modules, manage software sources or merge business state. A package is a deployment choice for independent programs.

The Launcher creator view can inspect an existing package, edit its composition and non-sensitive settings, select module directories, and produce a new package directory. The source is preserved. Every derived package receives a fresh `pack.lock` for the selected local environment and requires a new execution review before it can start.

## Composition and replacement

To exchange publications, comments, and proposals online, use the independent [Workshop service](workshop.md). Local creator functions continue to work offline; a community account never authorizes local program execution.

`inspectAuthoring(directory, environment)` returns the complete editable `pack` model, module declarations, an independent content `revision`, and Runtime's environment and permission review. `derivePackage(source, options)` accepts:

```js
{
  destination: '/new/package-directory',
  expectedRevision: inspected.revision,
  pack: editedPack,
  replacements: [{ componentId: 'stats', moduleDirectory: '/module/source' }],
  redistributionAcknowledged: true,
  nodePath: '/selected/node',
  pythonPath: '/selected/python'
}
```

`pack` is the full `world-hub.pack/v1` object. Editors can change components, dependency order, topics, bridge topic bindings, capability bindings, entry component and ordinary settings. The existing [package specification](pack-spec.md) defines their meaning. Missing dependencies, cycles, unknown topics and incompatible contract bindings are rejected. The returned model exposes the exact same graph to a visual editor; visual connections must still pass these checks.

A replacement must declare the same bridge slots used by its component and satisfy every incoming and outgoing capability binding, including exact contract versions. Different code and languages can implement that contract. The reference deployment profile supports Node and Python; the Hub communications protocol remains independent of that profile. Passing declaration checks does not prove that a program correctly implements its declared behavior. Review and run a relevant business example separately.

Each module ID has one source tree in a package. Replacing a module with the same ID affects every component using that ID. Choose a distinct module ID when only one component should change. Unused modules are omitted. A destination must not already exist. An interrupted operation can leave an incomplete new destination; it is never accepted as an executable instance or used to overwrite the source.

Before deriving, call `previewReplacement(source, { componentId, moduleDirectory, ...environment })`. This read-only check uses the same replacement validation as derivation and returns the source revision, candidate digest, affected components, diagnostics, and differences in identity, contracts, bridge slots, permissions, platforms, runtime and license. It creates no destination and starts no modules. The Launcher shows this preview before saving a replacement into the draft. A changed candidate or source requires another preview; the final derive operation validates the current files again. Declaration compatibility does not prove business behavior or state compatibility, and execution requires a fresh review.

The preview's `declarationCompatible` and `environmentCompatible` fields distinguish wiring declarations from the selected environment; `compatible` requires both. Its stable `environment` record contains the runtime kind and fixed interpreter probe result, including available executable, version, architecture, SDK dependency versions and executable SHA-256. Diagnostics identify their `layer` and a suggested `action`; `differences.startupDependencies` compares component order, required contracts and the Python requirements declaration. `businessValidated` remains `false`, and `otherDependenciesChecked:false` explicitly leaves additional application dependencies to the program author. Interpreter probing does not run module code or grant permission to run it.

### Replace a module without editing JSON

The Launcher offers a guided path alongside the advanced composition editor:

1. Open **Creator workspace**, enter an existing locked pack directory, and choose **Inspect and open a draft**. An imported instance can also open its retained package in Creator.
2. In **Replace a module and retain the application**, select the component and enter a candidate module directory. For the text-statistics example, select `stats`. To discover a published candidate, choose **Find a module in software sources**, fetch its exact version into the verified cache, and choose **Use in creator workspace**. The base draft remains selected.
3. Choose **Check candidate and impact**. Read the actual candidate identity, affected components, content digest, contract and bridge differences, declared permissions, platform, interpreter, dependencies, and license. An exact declaration match is labelled **business behavior unverified**. Contract or bridge mismatches require author adaptation; unavailable platforms or environments explain the blocker. The technical record remains available in a collapsed panel.
4. Choose **Use this candidate module** only after reviewing the differences. This checks the candidate again. Changed source, candidate contents, or selected interpreter prevents an old preview from being used. **Cancel candidate preview** leaves the draft unchanged; **Discard this replacement** removes an already selected draft replacement.
5. Enter a **New derived pack directory** and choose **Validate and create derived pack**. Review and acknowledge the component licenses. Derivation retains existing consumer code, component settings, and wiring for this guided replacement. It writes a new directory and lock; it does not modify or stop an existing instance.
6. Choose **Import and review execution**. The new directory is already filled in the normal import dialog. Select a new instance ID, inspect and import, then explicitly review and authorize **Start**. Import itself grants no execution permission.
7. Check the application output against the contract's expected business result. Healthy processes and connected bridges are observations, not business acceptance. If validation fails, stop the new instance, choose **Return to existing instances**, and review the previous instance before running it.

The guided replacement does not require public settings JSON or consumer source edits. Those advanced edits remain optional. The UI checks declarations and the selected interpreter environment separately; its `compatible` result combines both. Candidate programs are not executed during the preflight, although fixed interpreter probes run to inspect the selected environment. A successful preview does not prove the candidate implements the contract or can read existing application data. New instances have new data directories. External API effects, sent messages, and other programs' state do not roll back when choosing an old code version. For an in-place state-preserving upgrade, use the separate [provider-defined upgrade and rollback procedure](upgrade.md).

Publisher/source observations, matching content hashes, execution authorization, isolation profile, and application acceptance are independent facts. A retrieval receipt is not a code audit, and a locally entered module directory has no authenticated publisher identity by default. The guided path does not introduce a single "safe module" label.

Automated interaction checks cover candidate changes, preserving the consumer/settings, bilingual incompatibility explanations, cancellation, and the handoff to import. A first-time human user's independent acceptance remains a separate pending activity; those checks do not establish that human result.

After a Hub or interpreter update, an older package's exact lock can intentionally refuse inspection or execution. Choose **Copy and rebuild lock** explicitly, or call `rebuildPackage(source, { destination, redistributionAcknowledged: true, ...environment })`. This operation validates the old v1 manifests, identity and full file hashes, then copies them to a new directory and locks that copy to the selected current environment. Its result shows old and new requirements and requires a fresh execution review. It does not update code, change the original lock, migrate business data or prove that an application remains compatible. Missing modules, changed source files and unknown lock formats are refused. Import and start never perform this rebuilding automatically.

Settings with keys resembling passwords, credentials, private keys or tokens are rejected by the editor. This is a guard against common mistakes, not a universal secret detector. Keep personal credentials and business data in program-owned instance storage. Authors must review their source files and license obligations before sharing. Acknowledging redistribution is an explicit statement by the author; it does not grant rights that a component's license withholds.

The `authoring.json` sidecar records the source and resulting content revisions, package identities, component licenses and creation time. Normal Runtime package export continues to include only locked deployment files. Source publication carries derivation metadata separately as artifact provenance.

## Offline collaboration and review

Proposals provide a real file-based workflow for developers who do not share an online account or service:

1. Inspect the same base package and note its content revision.
2. Create a proposal with `exportProposal(source, { destination, pack, replacements, redistributionAcknowledged: true, ...environment })`.
3. Share the resulting directory containing `proposal.json` and `artifact/` by any user-selected transport.
4. The reviewer inspects `artifact/`, its full composition, component files, locks, licenses and permissions.
5. Apply with `applyProposal(base, proposalDirectory, { destination, redistributionAcknowledged: true, ...environment })` to produce another new directory.
6. Import that directory through the normal package review. Starting still requires authorization for its current execution review.

`world-hub.proposal/v1` records `proposalId`, `baseRevision`, `artifactRevision` and `createdAt`. Applying refuses a changed base or changed proposal content. There is no automatic merge of conflicting edits. Resolve the difference explicitly and create a new proposal against the current base. The content revision excludes local interpreter paths, whereas execution review includes them; collaborators can discuss the same content while independently reviewing their own environment. Exact package locks still require a compatible platform, Hub version and runtime versions. This is not a promise of arbitrary cross-platform reproduction.

Comments are plain data in `comments.json`, using `world-hub.comments/v1`. Read with `readComments`; append with `addComment(directory, { author, text, expectedRevision })`. The current comments revision is required to prevent lost concurrent updates. `exportComments` creates a new JSON file and `importComments` merges previously unseen comment IDs. Repeated identical records are idempotent; conflicting content under the same ID is rejected. An author label is self-declared, not an authenticated online identity. The UI renders comment content as text.

These tools implement local publishing, comments, proposal exchange and composition. They do not provide an online account system, hosted forum, real-time collaborative editing or a public moderation service. No shared file or comment can grant permission to start a program.

## Static source publication

`publishArtifact(directory, { kind: 'pack' | 'module', destination, redistributionAcknowledged: true, ...environment })` creates `artifact.json` and `index.json` in a new user-selected directory. Publishing here means creating distributable files, with no automatic upload. See the [open static-source format](sources.md) for how a publisher can host those files or combine several entries into a source index.

All creator functions are available from `world-hub/runtime`. A caller can pass an `AbortSignal` to inspection, derivation, proposals, retrieval and publication. Cancellation stops future work, but does not roll back previously created files. Local comments updates use an exclusive short-lived lock; after a process crashes, an abandoned `.comments.lock` must be investigated before a user removes it. The tooling never kills a process based on a saved PID.
