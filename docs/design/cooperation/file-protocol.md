# Cooperation plugin: virtual file and command protocol

## One document, two readable projections

**Proposed v1 contract.** All paths and commands here are design contracts, not commands installed by this documentation change. The plugin keeps authoritative state in `<dataDir>/plugins/cooperation/state.json`. It publishes each board at `boards/<boardId>/blackboard.json` and blackboard.md under that same root. A skill uses the cooperation helper to read and write this virtual document. The helper validates the current binding and submits a transaction to the service; it never overwrites the whole shared file.

``` text
<dataDir>/plugins/cooperation/
  state.json                       # sole authoritative state
  tabs/<tabId>/context.json         # non-secret assignment projection
  tabs/<tabId>/capability           # private logical capability
  boards/<boardId>/blackboard.json  # complete derived text document
  boards/<boardId>/blackboard.md    # readable derived view
  boards/<boardId>/assets/<id>.png  # original asset bytes
```

The authority contains schemaVersion, stateGeneration, boards keyed by ID, assignments keyed by tab ID, tabGenerationCounters, inbox records, operationReceipts, and recent event records. A board stores its semantic content, revisions, lifecycle, and history. Membership lists in projections derive from assignments. There is no independently mutable membership array on disk. Assets are immutable board-owned files referenced by an authoritative manifest; asset IDs, not supplied paths, select bytes.

A projection is a real UTF-8 file, not a FIFO or OS-level virtual filesystem. No watcher treats manual rewrites as authoritative edits. read returns a snapshot, board revision, event cursor, projection hash, and projection paths after checking the service’s committed generation. Tools can inspect the file directly once that check succeeds. apply changes the document through the one owner and then republishes the file. This is the predictable read/write path requested for the skills.

## Snapshot shape and stable addresses

The strict [snapshot schema](examples/blackboard.schema.json) is the design reference for scene serialization. A snapshot contains schemaVersion, boardId, title, revision, status, eventCursor, members, items, connections, regions, reactions, threads, and assets. Every object has a stable ID. Editable records have an integer revision. Member entries include a stable tab ID, provider, assignment generation, label, and responder/observer role.

Actor strings use `user:<localUserId>` or `agent:<stableTabId>`. The service supplies them; callers cannot choose attribution. Resolve a current author recipient by the stable tab ID in that actor and the current board assignment. Provider names, tab labels, or a string such as architect never resolve identity. Retain immutable author IDs when a tab leaves. Operation/inbox receipts capture provider, owner, logical run and attempt lineage at the time of the action, so a later provider switch does not rewrite history. An absent former author is not a delivery target.

Lossless text fields by record.

| Record | Required semantic fields |
|----|----|
| Note / code item | geometry; actor attribution; content.title; ordered content.blocks with id, revision, text; code also has language. |
| Image item | geometry; content.assetId; content.alt; title. Asset manifest includes MIME, SHA-256, byte length, dimensions and a managed relative path. |
| Drawing item | geometry; description; strokes with IDs, color, width, and local \[x,y,pressure\] points. |
| Shape item | geometry; rectangle/diamond/ellipse/cylinder; label and title. |
| Universal connection | from/to item IDs and named ports; direction; custom description; route waypoints; revision and attribution. |
| Region | geometry; title; ownerActor; wip/ready mode; explicit protectedItemIds and revision. |
| Reaction | kind and glyph; text description; author; target; optional question thread ID. |
| Thread | target; open/answered/resolved status; question reaction ID when relevant; messages with stable IDs, text, author, and sourceRefs. |

Use UTF-8 text and finite, bounded world coordinates. An item’s geometry is x, y, width, height, rotation; drawing points are local to that geometry. Connection waypoints are world coordinates, so transforms must update them explicitly. A renderer converts these records to React Flow nodes and edges. Saving React Flow internals, DOM HTML, or raster pixels as the only representation would fail the text contract. Unknown kinds and unsupported schema versions fail validation; there is no compatibility adapter in this design.

A shared pure BoardGeometry module defines rendered geometry for the service and canvas. x/y name the unrotated rectangle’s top-left corner. Rotate clockwise about its center in screen coordinates. For local point (u,v), world position is center + R(rotation) × (u − width/2, v − height/2), where R = \[\[cos θ, −sin θ\], \[sin θ, cos θ\]\] and θ is degrees converted to radians. Render note/code/image/shape content inside that rectangle. A text edit that grows a note must persist its new geometry in the same transaction. Unpersisted DOM overflow is not scene geometry.

The five ports are center=(width/2,height/2), north=(width/2,0), east=(width,height/2), south=(width/2,height), and west=(0,height/2), transformed by the same rotation. There are no custom port definitions in v1. A connection is the exact polyline from its source port through persisted world waypoints to its target port. Empty waypoints mean a straight segment. The renderer must not substitute an unpersisted Bézier or automatic route. Its label occupies a fixed 200×48 world-unit box centered halfway along cumulative polyline length; a zero-length route uses its endpoint. Wrap/clip text there and expose the full description in the inspector/outline.

Drawing strokes use straight segments between local samples and round caps/joins. Pressure is retained as data; v1 renders the constant persisted stroke width. Each sample plus half the stroke width must fit inside the item’s local rectangle. Resizing scales points and brush width explicitly. Use the rotated rectangle’s axis-aligned world bounds as a conservative protected footprint. Region rotation is zero. WIP intersection includes boundary contact within 0.000001 world units, both old/new item bounds, connection segments expanded by half their fixed 2-unit stroke, and the label box. Explicit protected IDs and incident relations add protection. Validate transformed bounds against the coordinate envelope. Ink and routes therefore cannot escape the geometry checked on the server.

Markdown lists objects in deterministic spatial order with IDs and revision labels, then relations, regions, reactions, threads, assets, and the event cursor. Every stroke and geometry field remains available in the full JSON even when a compact Markdown view omits point arrays. A graph text export names each endpoint ID and relation description. Re-reading JSON and rendering the board must preserve all semantic data; Markdown alone is not an import format.

## Anchor a question to text or an object

Targets use kind item, connection, region, or threadMessage plus an ID. Whole-object feedback needs no anchor. Selected note/code text adds blockId, blockRevision, start, end, exact, prefix, suffix, and attached/stale status. Offsets count Unicode code points, start inclusive and end exclusive. Preserve exact stored text; do not normalize it between selection and validation. The browser converts UTF-16 selection offsets before submission. Reactions and threads use the same target shape.

Validate that exact equals the selected block slice at the stated revision. Preserve block IDs through ordinary edits. When the known edit transform moves an unchanged range, transform its offsets and revision atomically. If the edit intersects the range or cannot be mapped exactly, mark it stale, retain the old quote/revision, and require explicit reattachment. prefix/suffix aid the human; they do not authorize fuzzy relocation. A removed target keeps a tombstone reference in history and threads. For a connection question, anchor to its stable connection ID rather than its current pixel location.

Every target whose object is absent must include snapshot = {removedAtBoardRevision, record}. The strict record shape matches target.kind: the full last item, connection, region, or thread message, with the same ID. Deletion captures this record for all affected reactions/threads in the same transaction and marks any text anchor stale. The snapshot is immutable evidence, not an editable scene object. A deleted connection keeps its description/endpoints/route; a deleted image keeps its original asset reference; a deleted note keeps its blocks. Snapshot asset references pin the original bytes until the board is explicitly deleted. JSON, Markdown, the outline, and normal feedback reads expose this evidence. A missing ID without a snapshot is invalid, rather than an empty tombstone.

In “🔎 Review café receipt routing with Claude.”, the selected “café receipt” begins at code-point offset 9 and ends at 21. This exercises the difference between browser string indices and the stored contract. Region feedback targets the region; image feedback targets the image item. A future sub-image selector needs a separately specified coordinate contract; whole-image questions work in v1.

## Tab context and proposed helper surface

Both provider launches receive CLOUDX_COOPERATION_CONTEXT and CLOUDX_COOPERATION_HELPER. These proposed environment variable names point to an immutable per-tab locator and the trusted helper entrypoint. The locator’s file contents may change as the user assigns a board. It contains schemaVersion, tabId, assignmentGeneration, boardId or null, board path, service endpoint and a capability-file locator. Secret token bytes live only in the private capability file. The helper reads the locator again for each command; it does not trust shell cwd, browser selection, or a caller-supplied tab identity.

``` bash
node "$CLOUDX_COOPERATION_HELPER" context
node "$CLOUDX_COOPERATION_HELPER" read --format markdown
node "$CLOUDX_COOPERATION_HELPER" read --format json
node "$CLOUDX_COOPERATION_HELPER" read --item note-decision
node "$CLOUDX_COOPERATION_HELPER" asset --id image-reference
node "$CLOUDX_COOPERATION_HELPER" inbox list
node "$CLOUDX_COOPERATION_HELPER" inbox claim --event event-question-1
node "$CLOUDX_COOPERATION_HELPER" apply --file transaction.json
node "$CLOUDX_COOPERATION_HELPER" receipt --operation op-answer-1
```

context returns explicit unassigned, assigned, or closed state. read can select an item or bounded page, but always identifies omitted ranges and the full-snapshot locator. asset resolves only an asset on the current board and returns its canonical localPath, MIME, SHA-256, dimensions, and byte length. The AI then uses its image-viewing tool on that path. File bytes must be readable under the selected provider sandbox without broadening access to the entire data directory; verify the scoped read grant or materialized read-only image directory in native tests.

The proposed browser/agent service uses /api/cooperation/boards for manager operations, /boards/:id/snapshot for reads, /boards/:id/transactions for apply, /boards/:id/assets for bounded uploads, and /boards/:id/assets/:assetId for reads. A separate authenticated board subscription carries revisions and event cursors. These names are new API proposals. Browser and helper calls use the same domain methods, with different authenticated caller contexts. Do not publish board content in the global workspace snapshot.

## Transactions, concurrency, and duplicate requests

Each apply request carries schemaVersion 1, a unique operationId, boardId, assignmentGeneration, expectedBoardRevision, preconditions, operations, and respondsToEventIds. Preconditions name every existing record the transaction changes, with its expected revision. The service derives author/actor from the caller; an agent cannot impersonate user. Use one serialized queue and conservative board revision comparison. Two simultaneous writes against the same revision cannot both succeed. A conflict returns current revisions and affected IDs for a deliberate re-read and new decision; there is no automatic merge or retry.

``` json
{
  "schemaVersion": 1,
  "operationId": "op-answer-1",
  "boardId": "board-review",
  "assignmentGeneration": 3,
  "expectedBoardRevision": 12,
  "preconditions": [
    {"targetKind": "thread", "targetId": "thread-replay", "expectedRevision": 1}
  ],
  "operations": [
    {
      "kind": "appendThreadMessage",
      "threadId": "thread-replay",
      "message": {
        "id": "message-answer-1",
        "text": "Proposal: replay updates the ledger and never calls the payment provider. We still need evidence for the implementation.",
        "sourceRefs": []
      }
    }
  ],
  "respondsToEventIds": ["event-question-1"]
}
```

The example is a protocol illustration, not a request against the scenario fixture revisions. appendThreadMessage derives message.author from the capability, increments the thread and board revisions, marks its claimed question event answered, and writes the receipt in the same authority commit. The message does not resolve the user’s question. Before commit, verify that the claimed event still belongs to this tab/generation and that the referenced thread is the event’s response target.

Proposed typed operation families.

| Operation | Mutation rule |
|----|----|
| createItem / updateItem / deleteItem | Typed content/geometry only; allocate unique IDs; update requires current item revision. Deletion removes incident connections atomically and preserves feedback tombstones. |
| createConnection / updateConnection / deleteConnection | Universal only; validate live endpoint IDs, ports and route geometry; require expected endpoint/connection revisions. |
| createRegion / updateRegion / markRegionReady | User-only WIP ownership/release changes; geometry and protected IDs validated. Ready may enqueue one addressed event. |
| addReaction / updateReaction / removeReaction | Validate target/anchor; question creates its thread and inbox event atomically. Agents can annotate protected targets without changing scene content. |
| appendThreadMessage / resolveThread / reattachTarget | Append is allowed to assigned members. User resolves or explicitly reattaches stale feedback; answering alone cannot change resolved state. |
| attachAsset | Use a previously validated staged asset token; commit its manifest and image item together. |
| undoOwnOperation | Build an inverse transaction against current revisions. Refuse if it would erase later edits or violate WIP; never restore an old whole-board snapshot. |

Order validation as: request bounds and schema; capability and tab generation; board lifecycle/revision; record and anchor preconditions; WIP and operation permissions; projected resource budget; commit. Persist the operation ID with its payload digest and caller generation. The same ID and same digest returns the original receipt without another mutation. The same ID with different content returns OPERATION_ID_REUSED. A lost response is UNKNOWN until receipt lookup establishes commit state; the helper does not resend on a timer.

Normal success means the authority is durable and both text projections match the new revision. A failed precondition or failed authority write changes nothing. A failed projection after a durable authority write returns COMMITTED_PROJECTION_UNAVAILABLE and the committed receipt; the operator repairs publication before writes resume. Restart validates the authority and republishes its derived files. A missing service is a visible error; the helper must not edit the projection offline as a substitute.

## WIP and annotation rules at the write boundary

Recompute protection on every transaction from current WIP regions. For scene mutations, test old and new item bounds, explicit protected IDs, incident edges, and route/region intersection. Include deletes, label edits, endpoint moves, reroutes, resizing, grouping, and AI-created objects. Reject the entire transaction as REGION_PROTECTED if any scene mutation intersects protection. A region’s own WIP metadata is user-only. Several protection regions combine as a union.

Thread messages and reactions are semantic annotations, not scene geometry mutations. Permit them on a protected target, but place their UI outside the region or behind a collapsed badge. An answer to a question inside WIP must explain in the thread without rewriting the draft. User edits in their WIP region remain allowed. A question is not a temporary release of protection.

## Assets, subscriptions, and resource budgets

Validate clipboard/file bytes by decoding the declared supported MIME, not the extension alone. Enforce the byte and decoded-pixel limits before accepting an asset. Store a generated path, original bytes, and SHA-256; thumbnails or drawing previews are derived. A staged upload expires through explicit transaction cleanup after failure/cancellation. Final scene creation references a committed manifest. Rejected uploads do not leave an accepted image item; committed assets survive board close.

The subscription begins with a current snapshot and cursor. Committed changes carry a monotonic per-board sequence, revision, operation ID, actor, changed IDs, and inbox-state updates. Transient presence/cursor/unfinished-ink previews are separately labelled ephemeral and never enter the durable board file or AI inbox. A reconnect requests events after its cursor. If the bounded event window no longer covers it, return CURSOR_EXPIRED and require an explicit snapshot resynchronization before writes; do not invent missing events.

Provisional v1 limits to verify under load; these are design choices, not measurements.

| Resource | Initial limit |
|----|----|
| Snapshot / authoritative JSON | 8 MiB per projected board; 64 MiB aggregate state, including retained boards, receipts and history. Reject writes before the cap; do not delete saved boards automatically. |
| Scene counts | 2,000 items; 4,000 connections; 200 regions; 8,000 reactions; 4,000 threads; 512 assets per board. |
| Drawing data | 20,000 points per stroke; 200,000 points total per board. |
| Image data | 10 MiB per original; 40 megapixels decoded; 256 MiB original image bytes per board. |
| Coordinates | World x/y within ±1,000,000; width/height 1..100,000; rotation -180..180. Expanding space is not unbounded resource allocation. |
| Transaction / delivery | 256 KiB request and 100 operations; 32 feedback event IDs per delivery; 8 KiB notice excluding on-demand board content. |
| Replay window | 4,096 recent board events. Durable operation receipts/history remain until explicit board deletion and count toward the aggregate budget. |

Other stable error codes are UNASSIGNED, BOARD_CLOSED, ASSIGNMENT_CHANGED, REVISION_CONFLICT, TARGET_STALE, ASSET_INVALID, LIMIT_EXCEEDED, INTEGRITY_ERROR, DELIVERY_UNAVAILABLE, and DELIVERY_UNKNOWN. Map each to a direct recovery action without a compatibility mode or hidden fallback. Exact validation messages must not expose secret capability bytes or unrelated filesystem paths.
