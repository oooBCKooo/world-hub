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
