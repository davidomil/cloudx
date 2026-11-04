# Cooperation plugin: product and interaction design

## A shared place to design together

**Proposed design, 2026-11-02.** An assigned blackboard becomes the shared conversation surface for a person, Codex, and Claude. The AI puts diagrams, design choices, evidence, and answers beside the material being discussed. The terminal keeps short progress notices and links back to the board. These documents describe intended behavior; they do not describe a shipped plugin.

The plugin is named **Cooperation**; each document it manages is a **blackboard**. A blackboard is one semantic document with a canvas view and a text view. It is not a terminal transcript or a screenshot-only whiteboard. [Architecture](architecture.md), [file protocol](file-protocol.md), and [cooperation policy](cooperation.md) define the underlying contracts.

## Assign a board from any AI tab

Right-click a Codex or Claude tab, use the keyboard context-menu key or Shift+F10, or long-press on touch. The Blackboard group offers Create and assign, Assign existing, Open assigned board, and Detach. The current board has a checkmark. Search existing boards by title; show their member tabs and state. Creating from this menu creates and assigns in one durable transaction. A manager view can create an unassigned draft, rename boards, open views, reopen and assign saved boards, export, and explicitly delete closed boards.

Each AI tab has zero or one current blackboard. Many tabs, including a mix of Codex and Claude, can share it. Availability includes user-created and plugin-owned AI tabs; account-switch restrictions must not hide blackboard actions. Moving the tab between panes or switching provider/account keeps its binding. Forks and newly created tabs start unassigned unless the user selects a board in that creation action. Assignment never follows the currently selected browser tab by accident.

An owner-managed replacement tab may receive an explicit atomic transfer for continuation of the same logical run. That is the sole lifecycle exception to new tabs starting unassigned. It does not grant arbitrary siblings, forks, or unrelated runs inherited board access. The owner records the old/new stable IDs and run lineage.

A compact tab badge shows the board title, pending questions, and delivery trouble. Activating it opens the board in a workspace tab beside the agent when space permits. A board view can be duplicated across panes; viewers do not keep the board active. An unassigned AI can discover the skills and report that it needs a binding, but it cannot choose a board from a recent path or another tab.

## Lifetime and saved work

Visible board states and their meaning.

| State | User experience |
|----|----|
| Draft | Created in the manager without assigned AI tabs. Remains editable until first assignment, explicit close, or deletion. |
| Active | At least one assigned AI tab exists. Opening or closing a board view has no effect on membership. |
| Closed | The last assigned AI tab was detached or definitively closed. Live subscriptions and AI delivery stop. Existing views switch to a saved read-only state with Reopen and assign. The file and images remain on disk. |

Automatic close means stopping live collaboration, not deleting the document. It occurs after the host commits the removal of the last member. Closing a browser window, hiding a panel, a provider crash, a failed process termination, a recoverable tab, or server shutdown does not count as that removal. On restart, restore the full tab/managed-owner set before reconciling board lifetime. A draft has never been assigned, so it is not subject to the final-member transition.

## Work on an expanding canvas

First release scene vocabulary.

| Object | Editing and text representation |
|----|----|
| Note | A title and ordered text blocks with stable IDs. Text selection can anchor feedback to one section. |
| Code | A language, title, and text blocks. Show syntax highlighting; code is inert and never runs from the board. |
| Image | Paste, drop, or choose PNG, JPEG, or WebP. Keep original bytes, an asset ID, dimensions, hash, alt text, and an AI-openable local path. |
| Drawing | Pen strokes with point/pressure arrays and an optional human description. A generated preview can help vision but never replaces the strokes. |
| Shape | Rectangle, diamond, ellipse, or cylinder with a label and named connection ports. |
| Connection | A universal relation between items, with custom description, direction, ports, and optional route points. |
| Region | A named rectangle for work in progress or ready material. Its geometry and protection state are text data. |
| Feedback | Reactions and threaded comments on objects, connections, regions, text selections, and individual thread messages. |

Pan and zoom the canvas; its usable area grows with content. Snapping, alignment, multi-select, grouping by region, fixed compass ports, and manual connector routing support a Visio-inspired flowchart workflow. Start with the universal connection: for example, Checkout API → Event queue, described as publishes accepted payment. Store the description separately from arrow direction. Later relation presets, such as depends on or contradicts, require a separate design revision; the first release must not pretend a free-text label proves a formal relation type.

Pasting an image is scoped to the focused board, not the neighboring terminal. Show a local upload placeholder until the original file and asset record commit; on failure retain a clear failed draft without a completed broken node. Support multiple clipboard images and normal text paste into a selected note. Never auto-fetch arbitrary remote image URLs embedded in pasted HTML.

## Feedback belongs to its exact target

Right-click an object or selected note/code text to add a question, agreement, concern, idea, or custom emote. Every emote has a text name and optional description; a question requires a question description. A connection can be questioned as directly as a note. Use a small badge and count at the target. Open the thread only on request; keep the card text readable.

Example: select “The ledger worker can replay failed work,” add ? with “Could replay charge a customer twice?”, and send it to the author tab or another explicitly selected responder. The board records the selected block, exact text, revision, and question. The recipient gets a durable inbox event. Its explanation appears in the anchored thread, with relevant sources or a clear proposal label. The user resolves the question; an AI answer does not mean the user agrees.

If the target text changes, use a known text-edit transform to retain an unambiguous anchor. Otherwise mark the anchor stale and keep the original quote visible. Do not attach a question to a similar-looking sentence. If an object is removed, its feedback keeps the target ID and target.snapshot containing the last live record. Selected-text feedback also keeps its original quote. Ask for reattachment when needed. An agreeing reaction is feedback, not permission to execute code, change files outside the board, or publish anything.

## Give unfinished work space

The user can draw a region around an unfinished sketch and mark it Work in progress. Show a thin dashed border, a small owner/state label, and minimal tint below the content. The region is click-through except for its border handles. It never captures clicks intended for a note. An AI may read and make an anchored side comment, but cannot edit, delete, move, reroute, or create scene content in protected space. The server enforces this rule even if a skill ignores it.

Protection includes intersecting items, explicitly named protected items, connections incident to those items, and connections whose route crosses the region. Check both old and proposed geometry. A dragged-in item becomes protected. Overlapping WIP regions combine their protection; releasing one does not release another. The user controls release with Mark ready; no timeout or process exit releases protection. Ready queues one notice for the selected responder instead of a notice for each pen movement.

AI comments stay in a border badge, a margin callout outside the protected area, or a collapsed thread. They do not expand into the user’s work. Recent AI edits use thin corner marks or outlines with the author and a Changed here affordance. Their visibility is per viewer; fading or hiding a highlight never removes the durable edit history. Neither comments nor change marks move the camera without user action.

## Small tools and equivalent text access

Default to a narrow collapsible tool rail, a small board header, and compact zoom/status controls. The inspector, members, outline, sources, history, threads, minimap, and manager are optional drawers. Only one optional drawer opens at a time by default. A Focus canvas command collapses them all. Use CloudX theme tokens, existing controls, and Lucide icons; do not hardcode the concept images’ colors into the feature.

Adapt to the actual pane width. In a narrow split pane or on touch, use a bottom sheet for the active tool instead of fixed left and right panels. Preserve camera, selection, open tool, unfinished ink, and edit drafts across tab switches. Keep transient drafts scoped to the board view; save scene changes only through the server. When a view is retired, dispose subscriptions, object URLs, and drawing handlers.

The outline lists every item, relation, region, reaction, and thread with stable IDs and named actions. It supports selection, editing, creating and connecting items, navigating feedback, and reading WIP state without dragging on a canvas. Preserve normal typing in editors; canvas shortcuts must not fire there. Provide focus restoration, Escape dismissal, visible focus, labelled controls, keyboard menu navigation, touch targets, reduced motion, and text labels alongside color and glyphs.

Loading, reconnecting, pending-save, conflict, protected-region, stale-anchor, missing-image, closed-board, and unavailable-agent-delivery states are explicit. After a disconnect, hold new edits as local drafts until a current snapshot is confirmed. Never display Saved for a pending operation. New boards always start with empty scene collections.
