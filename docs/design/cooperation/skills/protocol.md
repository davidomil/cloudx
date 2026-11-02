# Proposed cooperation helper reference

These commands describe the planned helper. No helper executable is delivered in this design-only change. Both providers receive `CLOUDX_COOPERATION_HELPER` and `CLOUDX_COOPERATION_CONTEXT` from the host. Run commands as `node "$CLOUDX_COOPERATION_HELPER" COMMAND`.

| Command | Use |
| --- | --- |
| `context` | Get this tab’s current assignment, generation, board paths, and availability. |
| `read --format markdown` | Read the board’s prose projection, IDs, WIP, feedback and cursor. |
| `read --format json` | Read the complete semantic snapshot, including strokes and geometry. |
| `read --item ID` | Read one item and its revision without guessing its contents. |
| `asset --id ID` | Resolve a current-board image to a canonical local path, MIME, hash and dimensions; then open it with an image-viewing tool. |
| `inbox list` | Inspect feedback addressed to this tab/generation. |
| `inbox claim --event ID` | Persist a claim before responding. |
| `apply --file transaction.json` | Commit bounded operations with current board/record revisions. |
| `receipt --operation ID` | Inspect commit state after a response is lost or unclear. |

The helper derives the tab and logical capability from its private context. Never add token bytes to notes or commands. Never select a board from cwd, the browser’s current selection, or a copied context from another tab.

Apply uses `schemaVersion`, `operationId`, `boardId`, `assignmentGeneration`, `expectedBoardRevision`, `preconditions`, `operations`, and `respondsToEventIds`. Authors are derived by the service. See the [full protocol](../file-protocol.md) for the proposed operation families and an answer transaction.

| State or error | Required behavior |
| --- | --- |
| `UNASSIGNED`, `BOARD_CLOSED` | Report the state; wait for the user’s assignment action. |
| `ASSIGNMENT_CHANGED` | Stop old-board work and read current context. Keep old questions on their board. |
| `REVISION_CONFLICT`, `TARGET_STALE` | Read the affected records and original quote. Make a new decision; do not guess, rebase silently, or loop on retries. |
| `REGION_PROTECTED` | Wait for Ready; an anchored thread comment remains possible. |
| `COMMITTED_PROJECTION_UNAVAILABLE` | Treat the receipt as committed. Stop writes until publication is repaired. |
| `DELIVERY_UNAVAILABLE`, `DELIVERY_UNKNOWN` | State the exact delivery limit. Inspect receipts; do not substitute a new AI session. |
| `LIMIT_EXCEEDED`, `ASSET_INVALID`, `INTEGRITY_ERROR` | Keep the rejected work as a local draft where possible and report the problem. Do not bypass validation or replace managed files. |

No automatic retry, full-file rewrite, offline mutation path, or compatibility mode is part of this contract.
