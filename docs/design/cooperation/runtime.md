# Use the cooperation blackboard

## Open a shared board

Cooperation is a built-in CloudX panel for editable blackboards. Open it from the new-tab menu to manage boards, or assign a board directly from an AI tab. The original [design package](README.md) and [visual concepts](visual-templates.md) describe the intended interaction.

Right-click an AI tab, press Shift+F10 while its tab button has focus, or long-press its touch header. Under **Blackboard**, choose an existing board or **Create and assign**. Pick a blank canvas or a system-design, decision-review, or sketch template. Codex and Claude tabs can share the same board; each AI tab has one current assignment.

Closing the final assigned AI tab closes live collaboration and retains the saved board and images. Closing a viewer does not remove an AI assignment. Use the manager to reopen a closed board and assign a coworker. Permanent deletion requires a closed board.

## Work on the canvas

The compact tool rail adds notes, inert code, original images, freehand strokes, flowchart shapes, and WIP regions. Connections have named endpoints, compass ports, direction, descriptions, and editable route points. Use **Board outline** to find and edit content as text. **Focus canvas** hides optional controls; the drawers, tools, minimap, and snapping can be changed through the panel controls.

With no tool active, drag empty space to pan and drag an item heading or a flowchart shape to move it. **Select (V)** enables box selection. **Pan (H)** lets dragging over items move the camera. Text remains selectable outside Pan mode.

Click an active tool again, or press Escape, to clear it. In **Connect items (L)**, click two items, drag between their visible compass ports, or choose **connect by name**. Double-click an item or use its pencil to inspect and edit it.

PNG, JPEG, and WebP originals are accepted up to 10 MiB and 40 million pixels. The server fully decodes an image before accepting it and retains its original bytes. The image card opens the original; the assigned AI resolves a verified copy through its cooperation helper before using its native image tool.

## Ask and protect unfinished work

Select an object or an exact passage in a note or code block, then add a question or a described reaction. Replies and source links stay in its thread. Changed text becomes stale; deleted targets retain their last record and selected quote. Use explicit reattachment to select a new target. Answering a question leaves resolution to the user.

Mark unfinished work with a WIP region. The server prevents AI scene edits through the union of protected items, geometry, incident connections, and route or label crossings. An AI can leave an anchored thread comment. Only the user releases the region with **Ready**; the current revision must still match when an AI acts on that event.

## Follow native feedback

Feedback has one addressed responder. Saved or queued feedback is distinct from native acceptance, a persisted claim, and a committed answer. Native acceptance does not mean that a question was read or resolved. **Activity and sources**, the thread, and **Coworkers** expose delivery state and reasons. Inspect uncertain delivery before redirecting it.

Codex delivery uses the existing native bridge owner. Claude delivery uses a regular MCP child and the original session inbox socket. Busy and inbound-hold states remain queued or explicitly unavailable. The implementation does not create a separate agent or paste feedback into the user’s terminal composer. The native probes exercise [Codex](../../../apps/server/src/cooperationAgent/CodexCooperation.native.test.ts) and [Claude](../../../apps/server/src/cooperationAgent/CooperationNative.native.test.ts) against local synthetic provider endpoints.

Assigned native turns are shown as running, complete, or incomplete. Completion requires an authoritative board receipt or a recorded no-change reason for the same native turn and assignment. A missing receipt stays visible as incomplete; the skills do not guarantee that an arbitrary model will follow every instruction.

A managed Forge run continues through its owner’s existing admission and native-attempt gates. Its board assignment and pending feedback transfer only within the same logical run. A durable owner-admission marker prevents the same unclaimed question from starting repeated automatic continuations. Ordinary siblings remain unassigned.

## Save and recover

A failed or disconnected edit remains a local draft. Use the explicit reconnect, receipt-check, reviewed-apply, or discard action shown for that draft. A lost acknowledgment is checked against its original operation ID before another write. Unsaved editor and camera state survive hiding the panel. Export a current JSON snapshot from board options or the manager.

The server owns one authoritative state file and publishes a complete JSON document plus readable Markdown for each board. Agent helpers use revision-checked transactions; they do not replace these projections. A committed publication failure reports the receipt and blocks further content writes until explicit repair.

## Implementation and verification

Managed cooperation storage currently requires Linux descriptor-relative file access. Keep the configured CloudX data directory when backing up boards; an exported JSON snapshot is not a complete image backup. Runtime state, board assets, and receipt history are owned by the cooperation service.

The [panel browser suite](../../../tests/browser/cooperation.spec.ts) exercises the manager, editable scene, feedback, WIP, original images, draft recovery, compact controls, and theme/touch behavior against real board routes. The [workspace suite](../../../tests/browser/cooperation-workspace.spec.ts) adds actual CloudX tab menus, both provider assignments, live badges, reload, origin checks, and final-member closure. Its model processes are deterministic fixtures.
