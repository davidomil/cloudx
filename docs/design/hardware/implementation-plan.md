# Hardware plugin: implementation and validation plan

## Overview

**Implementation and acceptance plan.** These milestones guided the built-in implementation. [Validation](validation.md) records observed results and remaining physical-hardware limits. Running scripts against a real board requires its documented procedure and an admitted target.

## Milestone 1: domain and provider contract

Define the shared records and runtime schemas from [contracts.ts](contracts.ts). Define HardwareService, HardwareTypeRegistry, HardwareStore, HardwareWriterLease, HardwareStatusService, HardwareScriptRunner, HardwareAccessService, HardwareOwnerMonitor, and AgentHardwareContext responsibilities before implementation. Adopt the vocabulary in these documents; avoid generic untyped resource/action wrappers in the core domain.

Write failing contract tests first. Cover namespaced provider identity, duplicate registration, unsupported API/config versions, local schema validation, type-specific configuration, item references, status value types, filter semantics, and result validation. An in-memory test provider with a non-shell operation must register without changing reservation code. It is a test double, not a shipped PCIe implementation.

Implement the domain and registry until those tests pass. Keep shared contracts free of I/O. Add the optional hardwareTypes contribution to the plugin API without a legacy adapter. Do not change the existing GitHub metadata installer into a runtime loader.

## Milestone 2: persistence and claims

Implement the exclusive writer lease and safe versioned snapshot store. Implement serialized revision-checked inventory mutations, group and endpoint conflict keys, operation identity, and claim transitions. Add the compact receipt index and explicit log-retention bounds. Commit a preparing claim before scheduling any hook.

Write failing tests for two simultaneous owners, SSH/UART aliases, duplicate endpoints, stale revisions, script barriers, persistence failure before dispatch, stale callback completion, duplicate request IDs, mismatched payload IDs, held-record edits, and invalid snapshot recovery. Use a second actual process for writer-lease exclusion; two promises in one process do not prove that boundary.

Fault-inject after each persistence/dispatch boundary: before claim write, after write/before hook, during hook, after effect/before receipt, during release, and after override/before old callback. Assert the saved state and exact dispatch count. Prove that restart neither replays an effect nor advertises uncertain hardware as available. Validate actual filesystem sync behavior before claiming power-loss durability.

## Milestone 3: status checks and lifecycle scripts

Implement editable status definitions, manual bindings, command bindings, freshness, admission requirements, refresh, and scheduled checks. Use the same exclusion gate for checks and reservations. Implement the bounded host-side Bash runner and structured stdin context, with explicit credential references and private/redacted logs.

Test boolean exit zero as true and normal nonzero exits as false, with empty, noisy, and misleading JSON stdout. Check configured equals:true and equals:false, replacement of an earlier success, and captured exit/output diagnostics. Text and enum commands still require exit zero and one typed JSON value; test malformed, multiple, empty, and invalid enum output. Verify that a status command and both hooks save and run at the default `/` with workspace-only allowed roots. Reject custom outside paths and symlinks to `/`. Cover truncation, deadlines, cancellation, signal termination without an exit code, unsafe working directories, and missing credentials. Check that stale/error observations do not satisfy requirements. Check that a manual Free to use update cannot remove a claim.

Use controlled test scripts and barriers to prove claim-before-hook ordering, one dispatch per request, no arbitrary code interpolation, known process cleanup, blocked competing reserve during a check, owner-only refresh while held, skipped scheduled checks, and failed/unknown release remaining held. A timed-out shell with unconfirmed descendants must not be declared stopped.

## Milestone 4: SSH and UART access

Implement explicit active-claim access.open, typed invoke, and close. Revalidate claim generation at admission and completion. Keep transport handles server-owned and drain them before release. Implement SSH exec/upload/download and UART read/write/set-lines from [API v1](api.md).

SSH tests use a local controlled SSH/SFTP fixture. Cover exact script bytes and metacharacters, explicit authentication selection, unknown/changed host key rejection, effective connection settings, missing remote Bash/SFTP, nonzero remote exit, connection deadline versus task deadline, bounded output, cancellation, transfer overwrite policy, local path policy, SFTP path serialization, and uncertain remote outcomes. Do not claim remote descendants stopped from the local SSH exit alone.

Pin and verify SerialPort 13.0.0 source/native binding against the supported Node/OS matrix. Use its mock binding and a PTY/emulator for fragmented and binary data, quiet reads, exact line endings, invalid base64, output bounds, disconnect during read/write/drain, OS port contention, close failure, control-line errors, and explicit re-open. Assert that catalog/list/edit do not open a port. Emulation does not establish electrical DTR/RTS behavior.

Real-hardware validation requires an approved lab target and a reproducible script under debug_tooling. Validate UART parameters, system calls, device identity, and any board-specific register/address/control-line assumptions against the board documentation before running it. Record commands and observations. Do not commit debug_tooling or claim physical results from the proposed fixture tests.

## Milestone 5: every AI tab and worker

Contribute the default rule, four skills, and helper through the system catalog. Add hardware runtime context to both provider launch adapters and the server’s runtime-context composition. Implement a private capability bound to the exact tab/provider execution and Forge worker/attempt. Make management routes and agent mutation routes distinct in caller identity.

Write launch/materialization tests for Codex and Claude with no selected template, a selected template, resume, fork, provider/account switch, and Forge workers on both providers. Run native provider checks that discover the four skills and call authenticated context/discovery in the intended execution. A copied or superseded capability and a body-supplied tab ID must not acquire or use a claim.

Test current-session rollout separately: Codex text update cannot add helper environment; existing Codex/Claude launches without context show Relaunch required; deliberate relaunch supplies complete policy and helper; active work is preserved until that relaunch. Readiness must not report complete coverage while an execution lacks the helper/skills. No silent restart is permitted.

Implement HardwareOwnerMonitor against exact lifecycle evidence. Test explicit release, confirmed tab removal, failed termination, idle/completed conversational turn, browser loss, broker loss, server detach/restart, missing owner, Forge completion/pause/stop with confirmed quiescence, and replacement attempts. Confirm normal cleanup releases eligible hardware and uncertain outcomes remain held. No automatic claim transfer occurs.

## Milestone 6: native screen and operator workflows

Register HardwarePlugin in server composition and hardware.panel in the web renderer registry. Implement Inventory, Reservations, Tags & types, and Statuses & hooks using typed API adapters. Use the [seven concepts](visuals.md) and their written specifications. Implement SSH/UART creation, notes/tags, groups, statuses, scripts, receipt-backed operations, owner links, history, normal release, and manual override.

Browser checks must show two panels/owners racing one item, held state during preparation, note edits visible to the owner, status freshness, tag rename preserving membership, shared-group aliases, disabled/delete conflicts, failed script recovery, stale-generation rejection after override, and released hardware discoverable by another owner. Verify override reason, exact target, unresolved-activity acknowledgement, and owner-only access controls.

Verify keyboard navigation, focus restoration, labels, touch targets, selectable transcripts, narrow split panes, reconnect, loading, empty/error distinction, and no mutation replay on reconnect. Use screenshots and interaction checks for layout-dependent claims. Generated images alone cannot prove these properties.

## Milestone 7: end-to-end acceptance

Use one controlled SSH target and one UART target. Run the complete agent workflow for both supported providers and a Forge worker: list catalogs, filter, inspect, reserve, reread notes, validate/deploy through managed access, close, release, and rediscover. Run a second concurrent owner and prove exclusion during preparation, active use, release, and recovery. Use the same-machine SSH/UART alias scenario as a separate acceptance case.

Verify that notes guide the agent without a server prohibition parser or per-command approval. Demonstrate a documented no-reboot task without rebooting the target. Verify one manual override against an intentionally stuck fixture, including rejection of the old owner’s subsequent call. Keep raw host-shell bypass and arbitrary remote detached-work limits explicit in the release notes.

Run focused Vitest tests as each production path is added, then workspace typecheck and build, then the relevant browser/native gates. Use current repo Vitest and Playwright conventions; add no separate testing framework. A green metadata/schema check does not substitute for concurrency, lifecycle, native skill-discovery, or actual transport evidence.

## Requirement coverage

Requirement coverage.

| Requirement | Design evidence | Implementation gate |
|----|----|----|
| Native plugin screen and generated designs | design.md; visuals.md; seven PNGs. | Milestone 6 browser evidence. |
| Create hardware with a type | contracts.ts HardwareItem; SSH/UART editor specification. | Milestones 1 and 6. |
| Code-based extensible type API | HardwareTypeProvider; registry and contribution contract. | Milestone 1 non-shell test provider. |
| Start with SSH and UART; later PCIe | API operation tables and provider boundaries. | Milestone 4 transport checks; no initial PCIe claim. |
| Notes include login/capabilities/restrictions | Product notes workflow; typed examples; skill drafts. | Milestones 6 and 7. |
| Editable capability catalog and AI discovery | Catalog actions; all/any/none filters. | Milestones 1, 5, and 6. |
| Configurable manual or Bash statuses | StatusDefinition/Binding/Observation; boolean exit codes, text/enum JSON output, and freshness. | Milestone 3. |
| List all hardware and custom filters | Paginated list/get/catalog actions. | Milestones 1 and 5. |
| Find suitable available hardware | Availability and admission predicates. | Milestone 7. |
| Reserve with optional script and internal exclusion | Atomic claim algorithm; phase table; request receipts. | Milestones 2 and 3 race/barrier checks. |
| Read notes after reserve and validate suitability | Seven-step workflow; hardware-reserve skill. | Milestone 7 native agent trace. |
| Broad use after reserve; note restrictions remain advisory | Product permission model; hardware-access skill. | Milestone 7; no server note-policy parser. |
| Monitor tabs/workers and release | Exact owner adapter; restart/shutdown contract. | Milestone 5 lifecycle cases. |
| Manual override and reuse by another tab | Revocation/generation/cleanup protocol. | Milestones 6 and 7. |
| Default skills in every supported AI path | System contributions; readiness and rollout matrix. | Milestone 5 native coverage. |

## Known implementation prerequisites

The provider contribution field, execution context, authenticated endpoint, durable store, adapters, and native panel are implemented. Local OpenSSH/SFTP and native SerialPort PTY emulation provide runtime evidence. Sensitive UART electrical behavior still requires board-specific documentation and physical measurements. See the [validation record](validation.md).
