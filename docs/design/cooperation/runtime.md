# Use the cooperation blackboard

## Open a shared board

Cooperation is a built-in CloudX panel for editable blackboards. Open it from the new-tab menu to manage boards, or assign a board directly from an AI tab. The original [design package](README.md) describes the intended interaction.

The cooperation skills ask agents to use short titles and bullet points for notes, decisions, and thread answers. They follow ASD-STE100 principles: short sentences, active voice, and consistent terms. Each bullet carries one fact, action, or question. Source links, conditions, uncertainty, code, and quotations retain their meaning.

Right-click an AI tab, press Shift+F10 while its tab button has focus, or long-press its touch header. Under **Blackboard**, choose an existing board or **Create and assign**. Enter a name to create an empty canvas. The manager also permits an initial AI tab assignment. **Create and assign** creates the empty board and assigns that exact tab in one operation. Codex and Claude tabs can share the same board; each AI tab has one current assignment. Existing saved boards keep their content and original files when reopened.

Closing the final assigned AI tab closes live collaboration and retains the saved board and original files. Closing a viewer does not remove an AI assignment. Use the manager to reopen a closed board and assign a coworker. Permanent deletion requires a closed board.

## Work on the canvas

The compact tool rail adds notes, inert code, original images, files, link cards, freehand strokes, flowchart shapes, and WIP regions. Connections have named endpoints, compass ports, direction, descriptions, and editable route points. Use **Board outline** to find and edit content as text. **Focus canvas** hides optional controls; the drawers, tools, minimap, and snapping can be changed through the panel controls.

With no tool active, drag empty space to pan and drag an item heading or a flowchart shape to move it. **Select (V)** enables box selection. **Pan (H)** lets dragging over items move the camera. Text remains selectable outside Pan mode.

Select a zone heading to show its resize handles. Drag an edge or corner to change its bounds. The opposite edge stays fixed. Press Escape to cancel a resize. A focused handle also accepts arrow keys: 20 units per press, or 1 unit with Shift.

Click an active tool again, or press Escape, to clear it. In **Connect items (L)**, click two items, drag between their visible compass ports, or choose **connect by name**. Double-click an item or use its pencil to inspect and edit it.

PNG, JPEG, and WebP originals are accepted up to 10 MiB and 40 million pixels. The server fully decodes an image before accepting it and retains its original bytes. The image card opens the original; the assigned AI resolves a verified copy through its cooperation helper before using its native image tool.

- Use **Add file** or drop/paste a file to share a PDF, document, archive, audio or video original. Other files can contain up to 32 MiB. The board has one 256 MiB budget for staged and committed originals.
- Download any original from its card or outline entry. Audio and video cards have native playback controls. Playback depends on browser codec support; the original download remains available. Other files download as inert attachments.
- Use a link card for a URL, title and short description. Note URLs and discussion source references are clickable. Code remains literal. Link cards show local details and do not fetch remote pages or embed remote content.
- Codex and Claude use the same upload and original-file commands. Each upload belongs to the current tab and assignment; an agent cannot attach another participant's staged token.

For an assigned AI tab, run these commands through its host-provided helper:

```sh
node "$CLOUDX_COOPERATION_HELPER" upload --file ./design.pdf --mime application/pdf
node "$CLOUDX_COOPERATION_HELPER" asset --id ASSET_ID
node "$CLOUDX_COOPERATION_HELPER" discard --token UNUSED_STAGED_TOKEN
```

Upload returns a staged token and asset metadata. Publish it with an `attachAsset` transaction, using an image item for decoded images or a file item for other originals. The installed protocol describes the exact item fields, revision preconditions and receipt checks. Resolving an asset returns a private verified local copy. The agent must use its native reader and report when it cannot decode a document or media file.

## Ask and protect unfinished work

Select an object or an exact passage in a note or code block, then add a question or a described reaction. Replies and source links stay in its thread. Changed text becomes stale; deleted targets retain their last record and selected quote. Use explicit reattachment to select a new target. Answering a question leaves resolution to the user.

Mark unfinished work with a WIP region. An AI tab can create and manage its own zones. The host records the zone owner. The owner can work inside its own WIP, while other AI tabs remain blocked through the union of protected items, geometry, incident connections, and route or label crossings. An AI can leave an anchored thread comment on another participant's WIP. An AI cannot move, release, delete or capture another participant's protected zone. The user can manage all zones. A user **Ready** notifies the addressed AI; the current revision must still match when that AI acts. An AI's own **Ready** does not trigger another agent.

## Follow native feedback

Feedback has one addressed responder. Saved or queued feedback is distinct from native acceptance, a persisted claim, and a committed answer. Native acceptance does not mean that a question was read or resolved. **Activity and sources**, the thread, and **Coworkers** expose delivery state and reasons. Inspect uncertain delivery before redirecting it.

Codex delivery uses the existing native bridge owner. Claude delivery uses a regular MCP child and the original session inbox socket. Busy and inbound-hold states remain queued or explicitly unavailable. The implementation does not create a separate agent or paste feedback into the user’s terminal composer. The native probes exercise [Codex](../../../apps/server/src/cooperationAgent/CodexCooperation.native.test.ts) and [Claude](../../../apps/server/src/cooperationAgent/CooperationNative.native.test.ts) against local synthetic provider endpoints.

Assigned native turns are shown as running, complete, or incomplete. Completion requires an authoritative board receipt or a recorded no-change reason for the same native turn and assignment. A missing receipt stays visible as incomplete; the skills do not guarantee that an arbitrary model will follow every instruction.

A managed Forge run continues through its owner’s existing admission and native-attempt gates. Its board assignment and pending feedback transfer only within the same logical run. A durable owner-admission marker prevents the same unclaimed question from starting repeated automatic continuations. Ordinary siblings remain unassigned.

## Save and recover

A failed or disconnected edit remains a local draft. Use the explicit reconnect, receipt-check, reviewed-apply, or discard action shown for that draft. A lost acknowledgment is checked against its original operation ID before another write. Unsaved editor and camera state survive hiding the panel. Export a current JSON snapshot from board options or the manager.

The server owns one authoritative state file and publishes a complete JSON document plus readable Markdown for each board. Agent helpers use revision-checked transactions; they do not replace these projections. A committed publication failure reports the receipt and blocks further content writes until explicit repair.

The Markdown document is the simple text view of the complete board:

- Notes and code retain their exact text.
- Shapes, drawing strokes, connections, zones and WIP retain their IDs, geometry and editable values.
- Reactions, thread messages, selected passages and retained deleted targets remain represented.
- Each original image or file has a direct managed path. PDF, audio, video and other binary bytes stay in files. They are not embedded as base64 in the text.
- Original paths are relative to `blackboard.md`. Use the item's asset ID with `asset --id` to get the assigned AI tab's private verified local path.
- Use **Export text (.md)** in the board outline to download this text view.

## Implementation and verification

Managed cooperation storage currently requires Linux descriptor-relative file access. Keep the configured CloudX data directory when backing up boards; an exported JSON snapshot does not contain the original files. Runtime state, board assets, and receipt history are owned by the cooperation service.

The [panel browser suite](../../../tests/browser/cooperation.spec.ts) exercises the manager, editable scene, feedback, WIP, original images, draft recovery, compact controls, and theme/touch behavior against real board routes. The [workspace suite](../../../tests/browser/cooperation-workspace.spec.ts) adds actual CloudX tab menus, both provider assignments, live badges, reload, origin checks, and final-member closure. Its model processes are deterministic fixtures.

The [content browser suite](../../../tests/browser/cooperation-content.spec.ts) exercises original-file downloads, native media playback, links, paste/drop, text selection, item placement and zone resizing at different zoom and pan positions.
