# Storage lifecycle

Storage retirement follows ownership and consumers. File age, a closed tab,
and a completed worker attempt do not establish that retained data is disposable.
These owners remove eligible payloads directly. They do not create trash copies
or impose new workload size limits.

## Codex launch caches

`CodexLaunchCacheLifecycle` reclaims recognized native plugin installation and
remote catalog cache entries after confirmed tab removal and during periodic
reconciliation. `SessionStore` protects active, starting, recovering, persisted,
and fork-source profiles. Launch and restoration use the same per-profile queue.
Startup waits for Forge tab restoration before reconciliation. Reconciliation
requires a broker lookup to establish that no writer remains; an unavailable
broker preserves the cache.

Cleanup validates the source binding and directory identity. It does not follow
history links or remove unknown bundles, hard links, credentials, configuration,
plugin data, or generated images. Native mutable caches remain private per tab.
Reclamation events report removed allocated bytes.

## Native Codex history

`CodexStorageService` measures configured source homes and SQLite overrides,
including retained launch bindings. Settings > Codex separates native history,
native databases, other retained data, and rebuildable caches from launch views.
The scan counts hard-linked inodes once and does not traverse child symlinks.
Allocated bytes use `st_blocks * 512`; shared extents and concurrent writers can
make this differ from a filesystem free-space measurement. Incomplete scans
report warnings.

Only authoritative terminal Forge work can request `CodexHistoryMaintenance`.
Its recorded native version, executable, source, effective SQLite home and launch
identity must still match. Session admission excludes pending resume and recovery
consumers throughout retirement. Recovery needs, user adoption, retained files,
references, spawned descendants and attachments preserve history.

Deletion is enabled only for Codex **0.166.0**, whose
[native lifecycle and locks](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/thread-store/src/local/delete_thread.rs)
were verified with isolated real processes. The service calls native
`thread/delete`, which owns writer/reference locks and projection removal. It
never edits native schemas, truncates JSONL, or deletes database files. A durable
intent receipt precedes deletion. An uncertain acknowledgement or process exit
remains held across restart. Settings exposes those reasons and unsupported
versions. Legacy bindings without an effective SQLite-home receipt remain held.
No supported foreground compaction or deduplication of retained native history
was verified.

## Forge archives

`ForgeWorkflowService` records archive retirement authority only after the owning
work is merged or closed and workspace cleanup completes. `ForgeArchiveRetirement`
reconciles checkout evidence, container evidence, generated Git history, routine
snapshot recovery, reports and task contexts. Its journal preserves terminal
owner identities and reference/retirement receipts after cards disappear.

Consumers, active downloads, recovery needs, published references, and explicit
retention holds preserve payloads. Removal verifies candidate ownership, archive
receipts, directory identity and file hashes. Interrupted removal resumes only
against that inventory. Unknown legacy ownership remains held. Retired payloads
leave compact audit metadata; download views no longer offer them.

## Documentation extraction

PDF rendering keeps its scale and dimensions. New figures use the smaller of
optimized PNG and lossless WebP. Reanalysis preserves existing published figure
formats and paths. Original sources and intentional source revisions remain
authoritative. No automatic corpus rewrite changes existing citations.

`ExtractionStorage` uses local sidecar ownership receipts and POSIX leases.
Publication is serialized across archive instances and processes. Reader and
enrichment leases protect old generations; active staging cannot be reclaimed.
Startup and lifespan-owned periodic reconciliation remove only owned,
unreferenced products. Unknown directories remain intact. Runtime receipts stay
outside portable exports; export/import and index rebuilding retain source and
artifact references.

Production-path regression tests live beside these owners. Native lifecycle
validation is included in `npm run test:codex-recovery` with an explicit
`CLOUDX_NATIVE_CODEX` executable. See also [resource limits](resource-limits.md)
and [documentation lifecycle](documentation-lifecycle.md).
