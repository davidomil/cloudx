# Documentation lifecycle

## Owners and storage contract

The Python documentation indexer owns retained sources, catalog schema, extraction revisions, enrichment runs, checkpoints, source campaigns and publication. Node streams evidence, calls configured models and sends validated output to that archive. Node does not keep a second persistent run cache.

The catalog uses schema version 2 (`PRAGMA user_version`). Startup adds the storage tables and rejects a catalog newer than the supported version. A storage upgrade does not itself re-extract sources or invoke an AI model. Source manifests retain the original path, SHA-256, filename, public reference and extraction processor identity. Separate document snapshots isolate extraction artifacts and metadata. Upgrading older retained sources marks their extraction for rebuilding, removes derived chunks without verified dependencies, and quarantines unsupported binary sources.

Vendor-code imports retain original source bytes in an immutable rebuild bundle. `acceptGeneratedCodeDocumentation:true` enables generated documentation for search; `retainRawCodeArtifacts:true` additionally exposes individual raw files as artifacts. It does not control whether original bytes are retained.

The former `POST /documents/{id}/enrich` interface is retired. Update consumers to the run protocol below. Model enrichment spans now require `kind` and `supportAnchorIds`; model answer citations require `evidenceId`.

## Choose the operation

| Intent                                          | Hook                                    | Input and behavior                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebuild extracted evidence from retained bytes  | `documentation.documents.reanalyze`     | `{documentId}`; re-extracts and then runs configured AI enrichment when enabled.                                                                                                          |
| Replace derived AI content                      | `documentation.documents.reenrich`      | `{documentId}`; starts a fresh run by default, keeping the current source extraction.                                                                                                     |
| Resume an interrupted AI run                    | `documentation.documents.reenrich`      | `{documentId, resume:true}`; reuses completed checkpoints. `resume:true` and `force:true` are mutually exclusive.                                                                         |
| Reuse a completed matching AI run               | `documentation.documents.reenrich`      | `{documentId, force:false}`; returns unchanged when the currently published run matches its extraction and processor fingerprints.                                                        |
| Compare the original source with retained bytes | `documentation.documents.checkRevision` | `{documentId}`; records `unchanged`, `known-revision` or `new-revision`.                                                                                                                  |
| Retain changed original bytes                   | `documentation.documents.refresh`       | `{documentId}`; fetches/checks the original and retains a new revision when its bytes are new.                                                                                            |
| Inspect a revision family                       | `documentation.documents.revisions`     | `{documentId}`; returns documents sharing its source key.                                                                                                                                 |
| Assign an explicit revision family              | `documentation.documents.assignSource`  | `{documentId, sourceKey}`.                                                                                                                                                                |
| Permanently remove an inactive revision         | `documentation.documents.purge`         | `{documentId, reason}`; irreversible, including unreferenced retained bytes. Invalidate or remove an active document first. Failed file cleanup remains visible and explicitly retryable. |

If file deletion fails after catalog removal, purge returns `purged:false, cleanupPending:true` with an error. Repeat the same purge request after resolving the file error; no automatic retry runs. Revision listings expose `pendingCleanup`, including when opened through a purged document ID, and the UI offers **Retry file cleanup** after reload. Cleanup uses the recorded old snapshot path and preserves a newly imported document with the same ID.

Revision checks require a fetchable original HTTP(S) URL or local path. Copied text and uploads without an original reference need a new import assigned to the same source key. Video checks reacquire metadata, transcript and selected visual frames, including their byte hashes, and compare the retained evidence pack. The response identifies this comparison as `metadata-transcript-selected-frames`; it does not establish byte equality for the complete video stream. A refresh retains the same acquisition used for its comparison.

## Run and evidence protocol

Start a run with `POST /documents/{id}/enrichment-runs`, supplying `extractionRevision`, `processorFingerprint`, `ownerId`, `resume` and `force`. The response contains `runId` and an opaque `leaseToken`. Send that token in the request body for batch lookup, checkpoint, heartbeat, completion and outcome requests. Media evidence GET requests use `Authorization: Bearer <leaseToken>`; query credentials are not accepted. Treat the token as a credential; do not put it in user-facing progress messages.

For each zero-based batch, use `POST /enrichment-runs/{runId}/batches/{index}/lookup` with `inputFingerprint` and `model`. Reuse a completed matching result. Otherwise call the selected model and `PUT` its validated output to the same batch path. Node selects the image model only when the batch has actual image attachments; a visuals skill alone does not select it. Document and artifact pages contain at most 100 records, and image batches contain at most eight attachments.

Content spans carry retained support anchors containing `documentId`, `extractionRevision`, `locator` and a `chunkId` or `artifactId`. The model selects trusted batch `supportAnchorIds`; Node resolves them to those anchors. `kind:"diagnostic"` records extraction/tool limitations as run metadata. It does not become searchable domain content. Answer citations resolve trusted `evidenceId` values and retain source/AI/media origin and support identity.

`POST /enrichment-runs/{runId}/complete` publishes completed batch content after Python validates the current extraction revision, lease and support anchors. `POST .../outcome` records failed, cancelled or skipped work. Node renews its lease every 15 seconds during media preparation and model work. Failed or interrupted work does not automatically restart; request an explicit resume or a forced new run.

## Retained media and source campaigns

ASR transcripts and selected keyframe bytes are retained through `POST /documents/{id}/media-evidence` before they support generated content. Each request is limited to eight JPEG/PNG frames and 16 MiB of decoded images; transcript text is limited to 200,000 characters. The complete submitted transcript, segment timing and producer metadata are also retained as an immutable JSON artifact, bounded to 1 MiB before its archive wrapper. That artifact survives portable export/import and index rebuilding; generated model batches use its corresponding retained chunks. `POST /enrichment-runs/{runId}/media-complete` marks the retained media stage complete. `GET .../media-evidence` provides pages of at most 100 entries. Retained frames preserve their media origin and producing run. Fresh runs select source chunks and source artifacts; previous derived frames do not become source input. An explicitly resumed run reuses completed retained media without another ASR call. Partially retained media requires a forced new run; it is not silently treated as complete.

For multiple source revisions, use `documentation.documents.reanalyzeCampaign.start` with `{documentIds:[...]}`. A campaign captures each active document's extraction revision and rebuilds source extraction without AI enrichment. It accepts at most 100,000 distinct IDs. Read counts and per-document outcomes with `documentation.documents.reanalyzeCampaign.get` and `{campaignId, offset:0, limit:100}`; the page limit is 200. Use the corresponding `.cancel` and `.resume` hooks with `{campaignId}`. Completed per-document outcomes survive interruption, and changed revisions fail the captured revision check rather than being silently substituted.

The equivalent indexer endpoints are `POST /reanalysis-campaigns`, `GET /reanalysis-campaigns/{id}`, and `POST /reanalysis-campaigns/{id}/cancel` or `/resume`.
