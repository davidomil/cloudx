# Draft board templates

These are design examples for the proposed Cooperation plugin. They are not application state, migration inputs, or evidence of a working payment system. Each title starts with `Draft template:`. The snapshots use `status: "active"` to illustrate a board with assigned Codex and Claude tabs; that field describes the simulated lifecycle state.

| File | Scenario |
| --- | --- |
| [system-design.json](system-design.json) | Notes, code, an image, flowchart shapes, labelled universal connections, and a question on a specific note phrase. |
| [decision-review.json](decision-review.json) | Selected-text questions, an answered thread awaiting user resolution, a reaction on a thread message, a Unicode anchor example, and a question on a deleted connection whose last live record is retained. |
| [sketch-wip.json](sketch-wip.json) | A manual drawing and unfinished shapes inside a protected WIP region, with an AI comment and a separate editable proposal outside it. |

All three files use [blackboard.schema.json](blackboard.schema.json), a JSON Schema draft 2020-12 proposal. Every object forbids unknown fields. Connection meaning comes from `description`; the first version has no predefined semantic connection types. Endpoint `port` is one of `north`, `east`, `south`, `west`, or `center`. Version 1 has no editable arbitrary ports.

The schema describes a derived board snapshot. It does not make this file the authority for assignments or lifecycle. It contains no operation protocol. The examples deliberately use proposal language and empty message `sourceRefs` arrays because no payment implementation has been researched or verified.

Actor strings use `user:<userId>` or `agent:<stableTabId>`, such as `agent:tab-codex`. Provider and account labels do not define identity. The active examples map live agent authors to members; the deleted-connection snapshot retains a historical tab actor. Historical authors remain meaningful after their tabs leave. WIP regions in these examples belong to the user.

A reaction or thread whose whole target was deleted includes `target.snapshot` with `removedAtBoardRevision` and the complete last live `record`. Its record kind and ID match the target. The reader shows the missing-target state and stored record rather than inventing a new target. Original anchored quotes remain in the target, and any image asset referenced by a retained record keeps its bytes pinned. A snapshot record contains no nested target, which keeps this schema nonrecursive.

Anchors use zero-based Unicode code-point offsets and `[start,end)` ranges. In the text `🔎 Review café receipt routing with Claude.`, `café receipt` starts at 9 and ends at 21. These positions count neither UTF-8 bytes nor UTF-16 code units. An attached anchor must match its block ID, block revision, exact text, and surrounding context. A stale anchor needs review before it can target an edit.

Drawing points use the drawing item's local coordinates before its geometry transform. Each point contains `[x,y,pressure]`; the point plus half the brush width must remain inside `[0,width] × [0,height]`. Item rotation is clockwise about its rectangle center. The rotated axis-aligned bounding box must remain inside the world coordinate envelope. Regions are axis aligned and require `rotation: 0`.

A connection renders as the exact world polyline from its fixed compass source port, after item rotation, through its persisted waypoints to the rotated target port. No waypoints means a straight line. There is no unpersisted Bézier route. The path has a 2-world-unit stroke. Its label occupies a fixed 200 × 48-world-unit rectangle centered at half the path's arc length; a zero-length path uses its endpoint. Text wraps and clips within that rectangle.

WIP protection includes explicit protected item IDs, contact between the region and a rotated item bounding box, and incident connections. It also includes any connection whose stroke or fixed label rectangle touches the region. Boundary contact counts. Enforcing protection for changes, including group transforms, belongs to the mutation service described in the architecture; the example file does not enforce it.

The real [reference image](assets/reference.png) is an unchanged copy of the generated system-design concept in `../visuals/01-system-design.png`. Each snapshot records its MIME type, SHA-256, byte length, pixel dimensions, and board-owned relative path. Opening this asset through both providers' native image tools remains an implementation acceptance check.

The proposed version 1 limits are:

| Scope | Limit |
| --- | --- |
| Objects per board | 2,000 items; 4,000 connections; 200 regions; 8,000 reactions; 4,000 threads; 512 assets; 64 members. |
| Coordinates and dimensions | Coordinates from −1,000,000 to 1,000,000; width/height from 1 to 100,000; rotation from −180° to 180°. The viewport can expand within this validated envelope. |
| Revisions and event cursors | Nonnegative JavaScript safe integers; object revisions and assignment generations start at 1. |
| Text | Up to 256 blocks per note/code item; 64,000 code points per block; 200 messages per thread; 32,000 code points per message. |
| Ink | Up to 20,000 points per stroke and 200,000 points per board. |
| Images | PNG, JPEG, and WebP; 10 MiB and 40 megapixels per image; 256 MiB of assets per board. |
| Serialized bytes | 8 MiB per UTF-8 board snapshot; 64 MiB for aggregate authoritative state. |

The schema checks local field bounds. Validation outside JSON Schema must check serialized size, aggregate asset bytes, width × height, board-wide point totals, unique IDs, references, native image bytes, anchor text, and authorization. These are proposed release budgets, not measurements of current application capacity.
