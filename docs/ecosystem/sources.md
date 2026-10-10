# Open static software sources

Launcher additionally persists named source configurations in its own private root. Enable/disable, digest pins, private-network policy and priority are backend decisions. Disabling a registered address also rejects legacy raw-address requests, retaining caches and local instances. Priority only orders candidates; it never silently chooses conflicting bytes or updates running programs. Current and withdrawn entries retain observation times, with explicit same-kind/ID/version conflicts when hashes differ. These are observations, not publisher signatures or revocation of an already running program.

Verified fetches produce backend provenance receipts bound to the actual index and artifact digests. Receipts identify content integrity while explicitly leaving publisher identity, code safety and OS isolation unverified. Import and later execution reviews preserve the receipt only while the reviewed content/environment digest remains unchanged. Raw UI input cannot invent this provenance. See the [Launcher guide](launcher.md) and [module author quickstart](developer.en.md).

Software sources are optional distribution inputs. Local package inspection, import, start, stop and export continue to work when every source is unavailable. They have no role in Hub routing or program business logic. Third parties can implement the following formats without an official account, website or GUI.

## Index version 1

The optional [hosted Workshop](workshop.md) serves the same open index and artifact formats at `https://peros.cn/workshop/index.json`. Community accounts are required for publication and collaboration; reading and fetching this source require no login. Local execution remains a separate review and authorization step.

An index is UTF-8 JSON of at most 4 MiB, with at most 4096 entries. Fields are closed: unknown fields are rejected in this version.

```json
{
  "format": "world-hub.source-index/v1",
  "id": "example.local",
  "title": "My local and private packages",
  "entries": [{
    "entryId": "module.example.stats.1.0.0",
    "kind": "module",
    "id": "example.stats",
    "version": "1.0.0",
    "title": "Text statistics",
    "license": "MIT",
    "platforms": ["win32-x64", "linux-x64"],
    "provides": [{ "id": "text.statistics", "version": "1.0.0" }],
    "requires": [],
    "source": { "path": "artifact.json" },
    "sha256": "64 lowercase hexadecimal characters"
  }]
}
```

`kind` is `module` or `pack`. IDs use lower-case letters, digits, dots, underscores and hyphens. Object IDs are at most 64 characters; unique `entryId` values are at most 128. Versions are exact semantic versions. `title` is plain display text, at most 256 characters; `license` is the author's license statement, at most 128. Platforms use `os-architecture`. `provides` and `requires` hold capability contract IDs and exact versions; they are discovery metadata, and Runtime independently validates actual module declarations. Pack publication currently lists empty external contract lists and its locked platform.

For local indices, `source.path` is a safe slash-separated path relative to the index directory. Absolute paths, empty or dot segments, traversal, Windows device names, links and case-colliding artifact paths are rejected. For remote entries, replace `source` with `{ "url": "https://publisher.example/artifact.json" }`. Remote indices may only reference remote URLs, never a local filesystem path. Several index files or URLs can be configured and inspected independently, including user-chosen private and local sources. No source is mandatory or privileged.

`readSourceIndex(source, { expectedSha256 })` returns the index and its exact-byte `digest`. The optional expected hash can pin an index distributed through another trusted channel. `fetchSourceArtifact(source, reviewedDigest, entryId, { cacheRoot, signal })` rechecks that digest before retrieving the selected entry; changed indices require another inspection. All remote requests require HTTPS on the default port, without embedded credentials or fragments. Redirects are not followed. The reference downloader connects only to public IPv4 addresses: private, loopback, link-local and unsupported ranges are refused; the checked DNS result is used for that exact connection. IPv6-only hosting requires another transport adapter or delivery as local files. Requests have a 15-second timeout and bounded responses. Network credentials, Launcher management tokens and browser session tokens are never attached.

Private sources can be privately distributed local files, or HTTPS hosting reachable without an embedded login credential. An authenticated remote-source adapter is not included. The default `public-ipv4` policy refuses private addresses. A user can explicitly select a trusted private network or DNS proxy with `allowPrivateNetwork: true`, which uses the `trusted-private-ipv4` policy. This additionally permits only RFC 1918 IPv4 ranges (`10/8`, `172.16/12`, `192.168/16`) and the `198.18/15` benchmarking range used by some DNS proxy tools. HTTPS, certificate validation, default port 443, no URL credentials and no redirects remain required. Loopback, unspecified, link-local/cloud-metadata, multicast and all IPv6 addresses remain refused in both policies. Requests never carry local management credentials.

Some VPNs and proxy tools replace public DNS answers with addresses in a private or benchmarking range. Those answers are rejected by default. After reviewing and choosing that network, use the explicit trusted-network setting, ordinary public DNS, or retrieve the index and artifacts separately as local files. `readSourceIndex` and `fetchSourceArtifact` return the selected `networkPolicy`; a cached index records it and offline retrieval refuses a different policy. A network choice permits bounded downloads only. It is not trust in the downloaded code or authorization to run it. Local sources and previously verified cached artifacts remain usable independently of remote services.

## Artifact version 1

`world-hub.source-artifact/v1` is a bounded JSON container rather than an executable installer or shell script:

```json
{
  "format": "world-hub.source-artifact/v1",
  "kind": "module",
  "id": "example.stats",
  "version": "1.0.0",
  "files": [{ "path": "module.json", "sha256": "...", "base64": "..." }],
  "provenance": { "redistributionAcknowledged": true }
}
```

The complete artifact's exact bytes must match the index SHA-256. Each file has its own SHA-256 and canonical Base64 encoding. A file is at most 8 MiB; decoded files total at most 64 MiB, with at most 8192 files. The downloaded artifact is at most 96 MiB. Prefix conflicts, duplicate paths, case collisions, traversal and generated/private deployment trees such as `.git`, `.venv`, `.state`, `.hub` and `__pycache__` are rejected before extraction.

A module artifact contains `module.json` and its declared executable entry. A pack artifact contains `pack.json`, `pack.lock` and exactly the files locked under its module sources. Runtime control credentials, running instance directories and unlisted files are excluded. Application code may itself contain secrets, so publishers remain responsible for reviewing their source before sharing. `provenance` is metadata, never an install instruction or permission grant.

Downloads are stored by exact artifact digest in a local cache. Cached bytes and the extracted file set are revalidated on every use; tampering is rejected, rather than silently repaired. Reviewed index bytes are also cached under their digest. If the original index becomes unavailable, an already downloaded artifact can be retrieved using that same source identity, reviewed digest and entry ID. An uncached artifact cannot be fetched offline.

Preparing an artifact takes an exclusive `wx` lock for that digest and extracts into a separate UUID staging directory. Only fully validated content is published to the digest-named cache directory; concurrent preparation returns `SOURCE_CACHE_BUSY`. Cancellation or failure removes this operation's temporary files and staging directory, after checking that they remain ordinary paths inside the selected cache. If cleanup cannot be confirmed, the error reports `cleanupIncomplete` and `incompleteDestination`; inspect the reported paths before retrying. A process crash can leave a staging directory or download lock: first confirm that its owner has stopped, then remove only that abandoned entry. The tooling never kills a process based on a saved PID, overwrites a completed cached artifact, or changes existing local instances and their data.

## Trust and execution

Inspecting an index, downloading an artifact, publishing local files and reading comments execute no module code and create no running instance. Obtaining an artifact returns a local directory. Import and execution use the normal Launcher/Runtime review, which checks actual files, current locks, interpreters and permissions. Replacing a component goes through the same contract checks as any local package edit.

SHA-256 establishes content identity and integrity relative to a selected index. It does not establish author identity or code safety. Version 1 does not implement publisher signatures; future signatures can identify a publisher but cannot certify that their program is safe. The reference Runtime is trusted-local execution, without an OS sandbox. A downloaded module runs with the user's operating-system privileges only after explicit execution review. Remote descriptions, comments and package metadata are plain text in the UI and cannot call the privileged local API.
