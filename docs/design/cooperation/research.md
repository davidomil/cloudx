# Cooperation plugin: research and design decisions

## Evidence scope and versions

Research inspected CloudX commit fe78a9353c1f415624710dcf0e0301c1e0855d9d on 2026-11-02. Current source determines integration behavior. Existing architecture documents provide context and were checked against relevant source. Hosted vendor documentation describes its published current interface; it does not prove that the CloudX-pinned native CLIs expose that interface.

The initial design used checked-in provider observations from 2026-10-05 against Claude Code 2.1.289 and Codex 0.153.4. Implementation validation subsequently installed dependencies and ran the production launchers against isolated synthetic providers with Claude Code 2.1.289, installer-pinned Codex 0.157.1 and CI's other supported Codex 0.156.1. The specific native observations are recorded below; they do not establish a remote model's cooperation quality. The lockfile resolves React Flow 12.10.2, Vitest 4.1.11 and Playwright 1.60.0.

## Current CloudX facts that shape the design

Current-source integration evidence. Links are repository-relative and inspectable.

| Observation | Source | Design consequence |
|----|----|----|
| Codex and Claude use the shared agent-terminal tab, with provider selection inside its startup input. | [agents.ts](../../../packages/shared/src/agents.ts), [CodexTerminalPlugin](../../../apps/server/src/plugins/CodexTerminalPlugin.ts) create path. | Bind to WorkspaceTab.id, not conversation ID; keep assignment across provider switch. |
| WorkspacePlugin exposes hooks, rules, skills, UI contributions, sessions and optional restore/recover methods. | [plugin API](../../../packages/plugin-api/src/index.ts), WorkspacePlugin and PluginSkillContribution. | Use existing built-in plugin and system contribution plumbing. |
| Manifest-installed plugins are non-creatable placeholders and cannot create a runtime panel. | [InstalledPluginService](../../../apps/server/src/plugins/InstalledPluginService.ts), InstalledManifestPlugin. | Implement first-party composition; no unsupported third-party loader assumption. |
| The account context menu excludes owned tabs, and App enables it through agent-accounts. | [AgentSwitchMenu](../../../apps/web/src/ui/AgentSwitchMenu.tsx) tabHandlers; [App](../../../apps/web/src/ui/App.tsx) useAgentSwitchMenu. | Common board menu must be independently available and include owned tabs. |
| Definitive close waits for termination; persisted shutdown detaches without normal close. | [SessionStore](../../../apps/server/src/sessionStore.ts), closeTabNow and finishDisposal. | Membership releases on committed removal; restoration needs a barrier. |
| Metadata updates apply runtime context, and the terminal applies that prompt via bracketed paste. | [SessionStore](../../../apps/server/src/sessionStore.ts), updateTabPluginMetadata; [CodexTerminalPlugin](../../../apps/server/src/plugins/CodexTerminalPlugin.ts), applyRuntimeContext. | Binding/events need their own transport, not generic metadata writes. |
| The worker bridge admits one frontend and rejects a second main worker turn in one attempt. | [codex-worker-bridge.mjs](../../../apps/server/helpers/codex-worker-bridge.mjs), connection gate and CodexWorkerTurn.fromClient. | Extend its owner; coordinate managed continuations rather than create a competing client. |
| Current runtime resolver populates rules-skills; both launch overlays materialize system contributions. | [runtime catalog](../../../apps/server/src/rulesSkills/RulesSkillsCatalogService.ts), runtimeContextFor; [plugin contributions](../../../apps/server/src/plugins/pluginContributions.ts). | Compose cooperation context and contribute one shared skill source. |
| A named plugin.panel renderer is dispatched before the built-in panel-kind branches. | [App](../../../apps/web/src/ui/App.tsx), renderPluginPanel; [UI registry](../../../apps/web/src/ui/uiContributions.tsx). | Register a board renderer without expanding panelKind just for display. |
| Only web-viewer panels keep mounted by default; the dock adapts to pane/container width. | [App](../../../apps/web/src/ui/App.tsx), TabPanel; [PluginPanelDock](../../../apps/web/src/ui/PluginPanelDock.tsx). | Own board drafts/camera outside mount lifetime and start optional drawers collapsed. |

## External sources and confidence

**Primary, high confidence for the documented interface:** React Flow’s [whiteboard guide](https://reactflow.dev/learn/advanced-use/whiteboard) describes custom drawing features and labels its freehand example Pro. Its [accessibility guide](https://reactflow.dev/learn/advanced-use/accessibility) documents keyboard-focusable nodes/edges and ARIA controls. The [project license](https://github.com/xyflow/xyflow/blob/main/LICENSE) is MIT. These support a React Flow rendering adapter; they do not establish complete whiteboard behavior or license the separate Pro example.

**Primary, high confidence for component surfaces:** Excalidraw’s [props reference](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/) exposes scene change callbacks, image/files data, paste hooks, and custom element data. It is a credible sketch-first alternative. **Primary, high confidence for licensing scope:** tldraw’s [license page](https://tldraw.dev/community/license) requires a production license. These facts informed the comparison; no performance or integration benchmark between editors was run.

**Primary standard, high confidence for the selector model:** W3C’s [Web Annotation Data Model](https://www.w3.org/TR/annotation-model/#text-quote-selector) defines exact/prefix/suffix text quotes and positional ranges. The board borrows those ideas, then adds block IDs, explicit revisions and deterministic stale handling. It is an application-specific JSON contract, not a claim of full W3C annotation conformance.

**Primary, high confidence for the published interface:** [App Server](https://learn.chatgpt.com/docs/app-server) distinguishes starting an idle turn from steering an active one. Steering requires the current expectedTurnId. The implementation extends CloudX's original broker and has the pinned native evidence below.

**Primary, high confidence for documented hook/skill semantics:** Claude’s [hooks reference](https://code.claude.com/docs/en/hooks#userpromptsubmit) permits additional context alongside a submitted prompt. Its [skill guidance](https://code.claude.com/docs/en/skills#claude-stops-following-a-skill) recommends hooks for rules that must hold at every relevant event and describes compaction limits. Neither means a file-writing receipt hook wakes an idle CLI or guarantees board-first prose.

**Primary, high confidence for published restrictions; delivery feasibility still a gate:** Claude’s [channels guide](https://code.claude.com/docs/en/channels) documents push events into an open session. It labels channels research preview, requires supported Anthropic authentication, excludes some cloud platforms, and requires organization enablement for Team/Enterprise. Custom channel policy and CloudX launch exposure must be checked. The proposal does not claim today’s Claude adapter already has this capability.

The [custom channel reference](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview) makes the original proposal's production gap concrete. Preview channels need an approved allowlist entry. Its development override requires interactive confirmation and is ignored in print/SDK mode. A private marketplace alone does not approve a channel. The implementation transport decision below replaces that proposed dependency; it does not enable the override.

### Implementation transport decision, 2026-11-02

**Primary documentation and pinned native observation.** Claude's [own-session inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket) explicitly permits scripts and hooks to post into their original session. It exposes `CLAUDE_CODE_MESSAGING_SOCKET` and a per-session `CLAUDE_CODE_MESSAGING_TOKEN` to child processes. The same-machine path supports all providers in v2.1.248 and later, including installations that do not fetch feature flags. Explicit inbound `hold` and `refuse` policy still applies. This source is authoritative for the supported path; the native test establishes the narrower runtime behavior below.

The implementation uses a normal MCP stdio child owned by the existing Claude process. It declares no `claude/channel` capability. The child forwards addressed board events to that original native inbox, and observes the original transcript's native queue record before confirming acceptance. A socket write alone is not acceptance. Native queue acceptance remains separate from an agent's durable inbox claim and board answer. The original TUI remains the session's visible client.

The production-launcher test in [CooperationNative.native.test.ts](../../../apps/server/src/cooperationAgent/CooperationNative.native.test.ts) passed with Claude Code **2.1.289**, an isolated home and synthetic local provider. It observed an idle feedback response in the same saved native conversation. An unfinished composer draft did not enter that feedback request; pressing Enter afterward submitted the exact preserved draft. Its normal `Read` tool opened the byte-identical original board image from the private per-tab image directory. Separate native cases with explicit `hold` and `refuse` settings delivered nothing to the model and retained an honest unknown acknowledgment. No channel development override or inbound-policy override is installed.

The pinned CLI also rejected `--sdk-url ws://127.0.0.1:1 --input-format stream-json --output-format stream-json -p`: that endpoint is reserved for Remote Control workers connecting to approved Anthropic hosts. A separate streaming SDK agent and background-session dispatch were therefore not used as substitutes for the original TUI session.

For Codex, the implementation extends the existing native broker. It sends `turn/start` at idle and identity-checked `turn/steer` only for an explicit immediate action. Busy or modal feedback remains queued. [CodexCooperation.native.test.ts](../../../apps/server/src/cooperationAgent/CodexCooperation.native.test.ts) passed against **0.157.1** and **0.156.1** through the actual TUI, bridge and app server: the saved conversation and composer draft survived idle feedback; `view_image` opened the original board image; an event arriving during a held model response remained unsubmitted until the active turn completed. The 0.156.1 run used workspace-write permissions. Protocol tests separately cover modal admission and explicit steering.

The single-turn worker guard remains intact. An idle managed attempt requires its owner's tracked continuation, which transfers assignment before the new native execution. A durable event admission marker prevents the same unclaimed event from automatically launching another continuation. Native turn completion without a matching board completion receipt is exposed as incomplete; the host does not represent model obedience as proven.

The helper uses the server's configured certificate as explicit, request-scoped TLS trust when CloudX serves HTTPS. Node's [22.23.1 HTTPS reference](https://nodejs.org/download/release/v22.23.1/docs/api/https.html#httpsrequesturl-options-callback) documents the `ca` request option; default certificate and hostname verification remain enabled. Integration tests accept CloudX's generated local certificate and reject an unrelated certificate, a hostname mismatch, and redirects. No process-wide trust override is used.

Agent mutations, claims and completion take their native turn and execution identity from the host's current original-session observation. The domain stores that trusted identity in operation and completion receipts. A receipt from a previous turn cannot prove work in the next turn, even when the tab, board and assignment generation are unchanged. A replacement execution's readiness also invalidates an open view's previous runtime status before new work starts.

Official [Vitest v4 CLI documentation](https://v4.vitest.dev/guide/cli) and [Playwright recording options](https://playwright.dev/docs/test-use-options#recording-options) were checked as primary references for reusing the repository test stack. The checked-in configs remain authoritative for actual test inclusion, zero browser retries and failure evidence. No forum claims, mirrors, or anecdotal benchmarks determine the architecture.

## Decisions and rejected alternatives

Design decisions are proposals grounded in the requested cooperation workflow.

| Decision | Reason and tradeoff |
|----|----|
| D01 · Built-in plugin plus host extensions | Existing plugin contracts cover panels/skills/hooks, but cross-tab close, assignment and safe provider delivery need host cooperation. A manifest-only install cannot supply that behavior. |
| D02 · One atomic JSON authority, derived board files | Keeps assignment and content changes in one transaction with existing infrastructure. Whole-state write cost and retained-history growth must meet measured budgets. Revisit the store if they do not. |
| D03 · Transactional helper, no blind full-file overwrite | Concurrent human/AI edits need revision checks, WIP checks and attribution. This remains a disk-backed virtual document, accessed through the requested skill workflow. |
| D04 · React Flow adapter, independent scene model | Already present at 12.10.2; good fit for labelled editable flowcharts and DOM notes. Implement ink/anchors/regions as board features. Do not copy Pro drawing code without its license. |
| D05 · Considered Excalidraw and tldraw | Excalidraw merits reconsideration if sketching outweighs DOM note/anchor needs; adopting it would still require board semantics and feedback controls. tldraw adds production-license policy. No comparative benchmark supports a stronger claim. |
| D06 · Server-enforced WIP | Prompt guidance alone cannot protect a user draft. Side annotations remain possible; only the user releases their WIP. |
| D07 · Addressed durable inbox and provider control port | A browser toast and PTY paste do not satisfy verified AI notification. One responder limits duplicate answers and avoids automatic AI-to-AI loops. Native parity is a release gate. |
| D08 · Close live work, retain content | Respects the requested final-tab close while preserving notes and images. Reopening requires assignment; deletion remains explicit. |
| D09 · Mandatory board-first rule plus receipts | Makes cooperation the default once assigned, with visible noncompliance and exact server guards. A receipt cannot prove explanation quality or universal model obedience. |
| D10 · Universal relation first | A custom description expresses real collaboration without prematurely assigning formal semantics. Future relation presets need a deliberate contract change. |

## Open engineering gates with owners and evidence

These are implementation checks; they do not block review of the design package.

| Gate | Owner | Closure evidence |
|----|----|----|
| Provider push and cooperative completion | Agent adapters / managed-run owners | Native runs prove idle wake, busy/draft preservation, supported accounts, managed receipt lineage and no competing frontend. |
| Scoped image access | Provider launch / asset boundary | Both native image tools open actual board bytes with the intended sandbox, without a blanket data-root grant. |
| Atomic-store capacity | BlackboardRepository | Latency and crash tests at aggregate budgets; documented decision if another store is necessary. |
| Ink and scene scale | Canvas adapter | Real browser rendering, text round-trip, geometry/WIP crossing and bounded point memory at stated limits. |
| Compactness and accessibility | Web view | Both themes, narrow panes, keyboard outline/menu, mobile touch and non-obstructive overlay evidence. |

The research plan searched the local archive first, inspected original repository sources and relevant tests, searched/opened official external sources, imported the original URLs and selected local sources, then reopened active archive records. The work record retains document IDs, content hashes, retrieval commands and extraction limits. Archive extraction and structural validation do not replace source review or native runtime proof.
