# Cooperation plugin design

This proposal gives a person, Codex, and Claude a shared blackboard for design work. Assigned AI tabs put diagrams, decisions, evidence, questions, and explanations on the board. Skills read and write its disk-backed text document through one plugin-owned transaction path.

These documents record the design reviewed against CloudX commit `fe78a9353c1f415624710dcf0e0301c1e0855d9d` on 2026-11-02. The implementation is included in this branch. Start with [using the implemented blackboard](runtime.md) for current behavior, controls, recovery, and verification scope; the proposal documents retain the original design rationale.

| Read | Purpose |
| --- | --- |
| [Use the cooperation blackboard](runtime.md) | Implemented panel, assignment, feedback, WIP, native delivery, and recovery. |
| [Product and interaction design](design.md) | Assignment, lifetime, scene types, reactions, WIP, compact tools, and text access. |
| [Architecture](architecture.md) | Ownership, host extensions, persistence, lifecycle, provider delivery, and managed tabs. |
| [File and command protocol](file-protocol.md) | Virtual files, semantic model, revisions, anchors, assets, operations, and errors. |
| [AI cooperation policy](cooperation.md) | Mandatory board-first behavior, coworker language, skill packaging, and feedback flow. |
| [Implementation and validation plan](implementation-plan.md) | Ordered milestones, native integration gates, future tests, and requirement trace. |
| [Research and decisions](research.md) | Current-source findings, rated primary sources, choices, tradeoffs, and engineering gates. |
| [Visual templates](visual-templates.md) | Four imagegen concepts with exact prompts and review notes. |
| [Semantic templates](examples/README.md) | Three scenario snapshots, a strict JSON Schema, and a real image asset. |
| [Validation record](validation.md) | Checks actually performed on this documentation package and their limits. |

The main decisions are:

- One board per assigned AI tab; many Codex/Claude tabs can share it. Every AI tab type, including managed tabs, remains in scope.
- Right-click, keyboard, or long-press assignment. Open each board in its own workspace tab.
- Close live collaboration when the final assigned AI tab is definitively removed. Keep its saved document and images. Board viewers, disconnects, crashes, and restarts do not substitute for tab removal.
- One authoritative state owner, with complete JSON and readable Markdown files on disk. Revision-checked skill commands prevent blind shared-file replacement.
- Editable notes, code, images, pen strokes, shapes, and universal connections with custom descriptions. Reactions and questions target exact objects or note sections.
- Server-enforced WIP protection. AI can leave small anchored comments while the user draws, then wait for Ready.
- Compact, collapsible tools and a text outline. AI changes use subtle marks and never move the user’s camera automatically.

Automatic feedback uses the original Codex bridge owner and Claude's original-session inbox through its regular MCP child. Managed continuation remains inside Forge's existing native-attempt gates. Native acceptance, a claim, an answer, and the user's resolution remain separate states. See the [implementation notes](runtime.md) and [research addendum](research.md) for evidence and limits.

The original skill drafts live under [skills](skills/cooperation-board/SKILL.md). The built-in plugin installs the current rules, skills, and helper from [cooperationContributions.ts](../../../apps/server/src/cooperationAgent/cooperationContributions.ts).
