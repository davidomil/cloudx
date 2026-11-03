# Cooperation plugin: implementation and validation plan

## Deliver the whole cooperation loop

**Future implementation plan.** Build toward a mixed Codex/Claude design session in which a user assigns a shared board, sketches and writes, asks a question on exact text, receives an anchored explanation, protects unfinished work, and later closes the final AI tab without losing the board. This document defines future work and release evidence. It does not report feature tests as passed.

Keep the first relation type universal with a custom description. The full initial release still includes notes, code, images, drawing, flowchart shapes, emotes/threads, text access, WIP protection, unobtrusive change marks, compact tools, both providers, and managed tabs. Typed relation presets, remote multi-user service, automatic document execution, and a new plugin runtime installer are outside this design. No backward-compatibility layer or alternate storage path is planned.

## M0: prove provider and lifecycle boundaries

Before building the editor, specify AgentFeedbackPort and a native fixture for each supported provider/account mode. Extend the current Codex control owner in place; prototype the Claude native channel under the actual CloudX overlay/skill policy. Record CLI versions, authentication type, required organization policy, subscription/sandbox configuration, model, and managed-owner mode. Establish how a new context locator reaches an already running unassigned tab without process-env mutation or PTY submission.

M0 must produce observable answers.

| Probe | Required evidence |
|----|----|
| Idle wake | A question reaches the original idle Codex and Claude sessions, and an answer appears in the correct board thread. |
| Busy and composer ownership | While a user draft, permission dialog, command, switch, or active turn owns input, feedback leaves those inputs unchanged and stays queued or enters a verified supported boundary. |
| Native acceptance ambiguity | Kill the connection after native acceptance but before acknowledgment. The board shows unknown, and receipt inspection prevents automatic duplicate delivery. |
| Managed attempts | A question in an owned tab receives an owner-tracked answer without an illegal second worker turn or bypassing the workflow gate. |
| Images | Both native providers open original board image bytes under their actual sandbox; alt text alone is insufficient. |
| Restore and close | Failed close retains membership. Restart waits for user and owner restoration barriers. Actual final removal closes the board and retains its files. |

If the proposed Claude channel is unavailable for a required account policy, update the delivery decision before the full release. Do not rename a next-turn-only notice as automatic notification. A source-supported API is not enough; the production boundary must work with the supported CLI and CloudX launch configuration. These are implementation research gates, not unanswered product choices left for the user.

## M1: domain, file, and lifetime

Define the shared contracts and class interfaces from the architecture first. Write failing service/boundary tests against the intended behavior, then implement the repository queue, current assignment map/generations, board lifecycle, operation receipts, text projections, strict validation, and original asset ownership. Exercise real atomic-state and path-policy boundaries. Add create/assign/detach/reopen commands and committed-close/restoration coordination before exposing UI actions.

Acceptance: two different boards retain independent contents; a Codex and Claude tab read the same revision of one board; a reassignment atomically releases the old board; the last member closes it; a viewer alone does not keep it active; a failed authority commit changes nothing; a committed projection failure reports its exact state; restarting republishes the same semantic document. A stale helper cannot write after assignment changes.

## M2: host integration and skill access

Compose CooperationPlugin and its service in the server, add the composite context resolver and stable per-tab locator to both launches, contribute the three cooperation skills and mandatory runtime rule, and register the native panel renderer. Refactor the common agent menu and add the compact binding badge. Include plugin-owned agent tabs for assignment while keeping their account-switch restrictions. Preserve captured target IDs through asynchronous actions.

Acceptance: all supported Codex and Claude tabs discover the same skill package; an unassigned tab can be assigned without an unsafe terminal injection; switching provider/account keeps the board; the manager works without agent-accounts; right-click, long press and keyboard assignment target the original tab; stale/deleted targets fail clearly; state survives pane moves and browser reconnect.

## M3: canvas, images, and text parity

Implement the React Flow adapter with domain-owned notes, code, images, shapes and universal connections. Add the pen tool as bounded point capture and an explicit preview/export path. Implement note/code block identity and browser-to-code-point selection mapping. Add the text outline and graph export at the same time as the canvas, so each scene action has a text-addressable record. Add scoped clipboard upload and original asset resolution.

Acceptance: paste an image, draw a path, create an editable flowchart, change a relation description, and reproduce the same semantic scene from JSON. All items, routes, blocks and image paths remain inspectable through the helper. Keyboard users can create/edit/connect objects through the outline. Switching tabs preserves drafts/camera without persisting transient pointer samples as complete edits.

## M4: anchored feedback and WIP protection

Add target anchors, emotes on every scene type and connection, threaded replies, one addressed responder, durable inbox claims, and provider/managed delivery adapters proven in M0. Enforce WIP policy at the service boundary. Add user Ready and user-only resolve/reattach actions. Require cooperative turn receipts, while reporting the limits of verifying model prose.

Acceptance: a question on one note phrase produces an explanation in its thread; question state distinguishes saved, queued, accepted, read and answered; deleting/changing the phrase preserves a stale target and original quote. AI scene edits in WIP fail atomically, while an anchored comment succeeds. Releasing one of two overlapping regions does not release the other. AI edits do not wake peer loops, steal focus, cover content, or resolve the user’s question.

## M5: compact interaction, measured budgets, release gate

Default all optional tools to collapsed, adapt drawers to pane width, add focus/keyboard/touch handling, and verify both CloudX themes and reduced motion. Run the scenario fixtures in browser tests and native provider sessions. Measure save latency, subscription recovery, large-board rendering, image decode limits, and shutdown cleanup at the proposed budgets. If the single atomic JSON authority is too expensive at those budgets, revise the storage decision with measurements before implementing another store.

A release passes only when the complete user journey works for both providers and managed tabs. Initial internal milestones may expose draft capabilities for development, but do not mark the full plugin ready while automatic feedback or another requested scene type is absent. Preserve original board bytes and source references through export/close/reopen. Add a plugin user guide to the shipped catalog only when the feature exists.

## Test strategy and tools

Reuse the repository’s Vitest service/component tests and Playwright browser setup. The lockfile pins Vitest 4.1.11, Playwright 1.60.0, and React Flow 12.10.2 at this revision. Native-provider probes belong in debug_tooling and are not committed. Test doubles verify deterministic domain policy, while native runs establish actual input-channel and image-read behavior. Browser evidence establishes drawing, compact layout, focus and overlays. No one layer proves the others.

Future tests must distinguish the old behavior and cover the actual boundary.

| Area | Required cases |
|----|----|
| Transactions and persistence | Conflicting same-revision writers; duplicate ID/digest; changed payload with same ID; write failure; post-commit projection failure; crash/restart; invalid authority; explicit repair. |
| Membership | Both providers; all tab kinds; independent boards; reassign; provider switch; final-member close; view-close independence; failed close; shutdown detach; restore barrier; missing managed owner. |
| Path and input | Traversal, absolute asset paths, symlink escapes, malformed IDs/JSON, unsupported kind/version, forged tab/generation/token, inactive membership, text/point/count/byte/pixel limits, HTML injection and remote image references. |
| Anchors and feedback | Unicode offsets; changed/deleted text; full removed-target snapshots and pinned images; actor-to-tab identity across switch/departure; stale reattachment; all target kinds; claim ownership; lost native ack; no duplicate answer; AI-origin loop prevention. |
| WIP | Shared fixed-port/polyline/label geometry; contained ink; rotated bounds; boundary contact; old/new geometry; new objects; endpoint changes; route crossing; deletion; label edit; explicit members; overlapping regions; stale Ready; annotation-only permission. |
| Lifecycle and resources | Upload cancellation, staged-file cleanup, duplicate viewers, panel unmount drafts, subscription disposal, expired cursor resync, closed-board reads, asset retention/deletion. |
| Browser | 1440×960 desktop, narrow split pane, Pixel 7, both themes, touch/keyboard menu, focused paste, tab switching, all tools collapsed, unchanged viewport on AI reply, non-obstructive WIP and highlights. |
| Native integration | Idle/busy/draft/modal/unknown states, account/provider switching, real image opening, managed continuation receipts, session recovery and policy refusal. |

Use named production-path tests such as two coworkers cannot overwrite a newer note, a question stays on its board after reassignment, and a comment cannot release unfinished work. Assert observable state and behavior. Avoid tests that merely copy operation implementation details. Future validation records must state which command ran, which source/configuration it used, what passed or was measured, and what remains unverified. The documentation-only verification record is separate in [Validation](validation.md).

## Requirement trace

All requested behavior remains in the design and full-release acceptance scope.

| ID | User requirement | Design location / release milestone |
|----|----|----|
| R01 | Design plan and architecture documents | This plan; architecture.md; research.md. |
| R02 | Plugin and skills available to all Codex/Claude tabs | architecture.md host/managed integration; cooperation.md; M0/M2. |
| R03 | Shared virtual disk file accessed through skills | file-protocol.md; skill drafts; M1/M2. |
| R04 | Multiple boards; right-click assign/create; many tabs share one | design.md assignment; architecture.md membership; M1/M2. |
| R05 | Auto-close with final assigned AI tab | design.md lifetime; architecture.md state diagram; M0/M1. |
| R06 | Each board opens in its own workspace tab | design.md; native panel contribution; M2. |
| R07 | Paste images; AI opens their original bytes | file-protocol.md assets; image fixtures; M0/M3. |
| R08 | Notes and code blocks | design.md vocabulary; strict schema/templates; M3. |
| R09 | Manual drawing and flowchart editor | design.md canvas; sketch-wip.json; cooperation-diagram skill; M3. |
| R10 | Universal custom-described connections first; extensible later | file-protocol.md connection model; M3. |
| R11 | Emotes/descriptions on all scene types and connections | design.md feedback; schema/examples; M4. |
| R12 | Question a specific note section; notify AI; explain | cooperation.md sequence; code-point anchors; M0/M4. |
| R13 | Everything represented in text; images remain viewable | file-protocol.md complete JSON/readable Markdown; outline; M0/M3. |
| R14 | Mandatory board-first AI graphs, decisions and coworker language | cooperation.md; system rule and skill drafts; M2/M4. |
| R15 | Expanding canvas; WIP tells AI to wait, permits comments | design.md WIP; server guard; sketch fixture; M3/M4. |
| R16 | Non-obstructive regions, comments and AI-change highlights | design.md; visual 03; browser acceptance in M4/M5. |
| R17 | Collapsible tools use little screen area | design.md compact tools; visuals; M5. |
| R18 | Series of imagegen templates in CloudX styling | visual-templates.md, four PNGs, exact prompts.json, three semantic templates. |
