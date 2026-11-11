# Hardware plugin: architecture

## Overview

**Implementation architecture.** The feature belongs to the CloudX server, shared contracts, plugin API, and native web UI. The [research record](research.md) preserves the original baseline investigation. The [operator guide](runtime.md) records current host prerequisites.

## Owners and dependency boundaries

Owners and dependency boundaries.

| Owner | Responsibility |
|----|----|
| `packages/shared/src/hardware.ts` | Serializable items, tags, statuses, reservations, filters, receipts, and runtime validators. |
| `packages/plugin-api/src/index.ts` | The new `HardwareTypeProvider` extension contract and optional `WorkspacePlugin.hardwareTypes` contribution. |
| `apps/server/src/hardware/HardwareService.ts` | The sole domain authority for validation, revisions, conflict keys, claims, operations, and history. |
| `HardwareStore` and `HardwareWriterLease` | Validated snapshot persistence and process-exclusive writer ownership. |
| `HardwareTypeRegistry` | Validate provider descriptors and versions; resolve type IDs. |
| `HardwareStatusService` | Manual observations, bounded command checks, freshness, and scheduling. |
| `HardwareScriptRunner` | Host-side Bash execution, explicit context, output limits, cancellation, and receipts. |
| `HardwareAccessService` | Reservation-bound connection lifetime and typed provider operations. |
| `HardwareOwnerMonitor` | Reconcile exact SessionStore and Forge execution ownership. |
| `AgentHardwareContext` | Private execution-bound helper context and capability rotation. |
| `plugins/HardwarePlugin.ts` | Descriptor, native panel session, system skills, and rule contributions. |
| `hardware/HardwareRoutes.ts` | Thin management, agent, event, and receipt adapters. |
| `apps/web/src/ui/HardwarePanel.tsx` | Project server snapshots and local edit drafts. |

These are responsibility boundaries. Keep small internal collaborators together when that improves readability; do not make the service a collection of untyped event handlers. Routes and UI components must not decide whether a reservation is free. Providers cannot grant, release, or override ownership.

## Persistence and writer ownership

Use one snapshot under the host data directory: `hardware/state.json`. It contains schema version, store revision, items, physical groups, tags, status definitions and observations, active reservations, system-check holds, monotonically increasing generations, operation receipts, and bounded history. Keep connection objects, secrets, process handles, and UI selection out of the snapshot.

Acquire a process-held exclusive writer lease before loading or reconciling state. Follow the existing Forge writer-lease pattern on the Linux host. A second writer fails startup with a specific ownership error. A lock file’s existence does not prove a live owner; kernel-held ownership does. A lost writer lease closes all mutation and hardware-access admission immediately.

HardwareStore must validate the full snapshot and safe directory/file boundaries. First use creates a version-1 empty snapshot only when the state file is absent. Malformed JSON, invalid references, duplicate live keys, unsafe paths, or an unsupported schema blocks startup. Do not reset or substitute an empty inventory after a read failure. No legacy migration or compatibility layer is part of this new feature.

Persist through a mode-0600 temporary file in the same safe directory, sync the file, rename it, and sync the directory before acknowledging the mutation. If a persistence outcome is ambiguous, close admission and reconcile from disk; do not run the next hook. The current generic atomic-write helper does not establish this durability contract by itself. Power-loss behavior requires implementation evidence on the supported filesystem.

Serialize short snapshot mutations in one service queue. Every mutation validates its expected revision and the writer lease, creates the complete next snapshot, persists it, then publishes the new view. External scripts and transports run outside that queue. Re-enter with the original operation ID, reservation ID, generation, and expected phase before applying their results. Unrelated hardware may run concurrently; operations on the same physical group serialize.

Compute each hold’s keys from the physical group plus all its alias endpoint keys. Reject cross-group endpoint duplicates instead of inventing transitive ownership across inconsistent groups. Endpoint inspection returns configured keys even when a device is absent and adds resolved identity when present. An unavailable alias does not block a ready selected item. The same group-key algorithm controls reservation, status checks, alias changes, and access revalidation.

## Atomic claim algorithm

1.  Authenticate the current caller from the private launch context. Look up the request receipt before starting new work.
2.  In the mutation queue, validate the item revision, enabled state, installed type/config version, selected-endpoint readiness, referenced tags and statuses, required fresh values, and all conflict keys.
3.  Allocate the next reservation generation. Persist the `preparing` claim, immutable acquisition snapshot, and running preparation receipt together. If no hook exists, persist the claim as active in this same mutation.
4.  Run Before reserve once outside the queue. Pass a JSON context on stdin to the explicitly configured host-side Bash program. Do not interpolate names, notes, tags, or request text into shell source.
5.  Re-enter the mutation queue. Accept the result only if the same claim, generation, preparation receipt, and phase still match and the owner has not been revoked.
6.  Persist active after success. Persist `recovery_required` after any failed or uncertain hook. Return a receipt and the current details, including notes. A successful HTTP response carrying a running receipt is not evidence of active ownership.

`available` is a computed view: no conflicting hold exists, the item is enabled, its provider is available, its selected endpoint is ready, and every configured admission requirement is satisfied. It is not a user-editable stored reservation phase. A list response is a snapshot; only the atomic reserve mutation establishes ownership.

## State transitions and invariants

State transitions and invariants.

| From | Trigger | Persisted result |
|----|----|----|
| No conflicting hold | Valid reserve, no preparation hook | Active reservation. |
| No conflicting hold | Valid reserve with preparation hook | Preparing reservation before hook launch. |
| Preparing | Matching successful hook and live owner | Active reservation. |
| Preparing | Failed, lost, or ambiguous hook | Recovery required; keys remain held. |
| Active | Explicit release or confirmed owner end | Releasing; new access is closed. |
| Native agent claim | Explicit closure of its owning tab | Revoke generation; cancel managed work and release after confirmed cleanup. Preserve earlier unknown receipts. |
| Releasing | All managed access closed and release hook succeeded or absent | Remove live claim; append released history and receipt atomically. |
| Any live phase | Unknown owner/effect or cleanup failure | Recovery required; preserve every key. |
| Any held phase | Matching operator override | Revoke old generation first; clear only after cleanup or explicit acceptance of unresolved activity. |
| No conflicting hold | Explicit or scheduled command status check | System checking hold before script launch. |
| System checking hold | Known completed check | Store observation and remove checking hold atomically. |
| System checking hold | Lost/uncertain execution | Recovery hold for operator reconciliation. |

At most one live hold can own any resource key. All aliases in a physical group conflict. Admission and effect dispatch use the same generation. Only an active reservation permits provider connection or invocation. A status observation cannot change a claim. A stale callback can record a superseded result in history but cannot change the current claim.

Persist operation identity for preparation, access, status checks, and release before dispatch. A crash between an external effect and its saved result cannot be made exactly once by a JSON receipt. Preserve unknown outcome and do not replay the effect automatically.

## Safe command checks

All command-based status checks participate in the conflict gate, including checks started from the panel. Free-resource checks acquire a system hold; owner checks require an active, nonrevoked claim both at admission and immediately before dispatch. They bind to its generation and serialize with managed access. Release cancels or drains them. Preparing, releasing, and recovery claims cannot start checks. The scheduler skips held groups. Refresh does not race a claim by bypassing this gate.

A checking hold has a run ID, generation, resource keys, script revision, start time, and receipt. Its successful completion removes the temporary hold even when the observation is `false` or a known command error. Loss of proof that its process ended keeps the hold. A failed measurement and an uncertain process lifetime are different outcomes.

## Script execution

HardwareScriptRunner runs only the stored script revision. Use explicit Bash argv, an approved absolute working directory, a declared credential-reference set, an explicit environment, a wall-clock deadline, and bounded stdout/stderr. Start a process group, consume both output streams, and record actual start, exit, signal, timeout, cancellation, and cleanup outcomes. Do not mistake sending a signal for confirmed exit.

Pass context as JSON stdin: purpose, item ID, physical resource ID, reservation or check ID, generation, owner metadata, and connection metadata. Do not send credential values, the helper capability, arbitrary agent-supplied shell fragments, or automatic note text. A script can use configured credential references through a narrowly scoped environment. Keep full output under private access and redact known secret values before any browser or log projection.

Preparation and release hooks require exit zero. Their stdout is diagnostic, unlike status-check stdout. A hook cannot clear the plugin’s internal claim, even if it changes external state. Cancellation or timeout produces recovery when side effects or process completion are uncertain. There is no automatic rollback script, fallback transport, or retry policy.

## Type provider registration

Add optional `hardwareTypes` contributions to `WorkspacePlugin`. At composition, HardwareTypeRegistry collects these contributions from built-in code plugins and validates unique namespaced type IDs, exact `apiVersion: 1`, unique operation IDs, bounded local JSON schemas, and valid configuration versions. Duplicate IDs or incompatible API versions fail startup clearly. The initial Hardware plugin contributes `hardware.ssh` and `hardware.uart`.

The extension contract is in [contracts.ts](contracts.ts). Descriptors and configuration forms are serializable; transport implementations run on the server. No runtime code is imported from inventory records, a browser form, or a GitHub metadata manifest. A code plugin must be registered in the composition root before it can contribute a provider. The current installer is not a third-party runtime loader.

The descriptor supplies configuration and operation schemas. Runtime parse/validation is mandatory on create/edit, persisted load, invocation input, and invocation output. Unsupported configuration versions make affected items unavailable. Any future version migration must be deliberate; do not add a silent compatibility path.

A provider implements parseConfig, inspectEndpoint, describeAccess, and connect. Endpoint inspection returns conflict keys and local readiness without opening hardware. The resulting connection implements invoke and close. HardwareAccessService validates the claim before every operation and never exposes a raw connection handle to agents. A future PCIe provider can add register or device operations without implementing an SSH-shaped exec method.

The provider wraps every effect/cleanup result in ProviderOutcome. Completed carries a schema-defined domain result; failed records a known none/settled effect; unknown closes access admission and puts the claim into recovery. A known nonzero SSH command exit is a completed domain result. Before any connect-side effect, register cleanup with the host context so an interrupted open can still be drained. Unexpected throws after dispatch are unknown unless the service can prove no effect occurred. A successful close alone never erases an earlier unknown remote outcome.

## SSH provider

Use the host’s OpenSSH tools with one selected authentication method. Default to the server's current SSH agent without requiring a socket path. Password authentication resolves an opaque private-store reference and supplies the value through a private askpass socket; it does not place the value in argv, environment, inventory, or receipts. Use the normal known-hosts files unless an explicit admitted override is configured. The default accepts and records a new key, and rejects changed keys. An explicit override uses strict checking. The connection path uses no shared persistent control master and no automatic reconnect.

Key registration is a separate user action under an active reservation. The service persists its request identity before calling the provider's optional `registerKey` method. It invokes `ssh-copy-id` without requiring a prior connection and keeps uncertainty held. Temporary password cleanup waits for the provider and registered process cleanup to finish. Registration never changes authentication mode or replays an earlier request.

Operations are `ssh.exec`, `ssh.upload`, and `ssh.download`. Exec accepts an explicit remote Bash script, streams it to a fixed remote Bash entrypoint, and returns bounded stdout/stderr and observed process outcome. Do not assume that local argument arrays preserve remote shell argument boundaries. The configured machine must have the selected Bash entrypoint; its absence fails clearly.

Upload/download use structured local and remote paths with recursive behavior disabled initially. Validate local source/destination paths under existing host path policy. Run OpenSSH SFTP in noninteractive batch mode with a tested path serializer. Reject NUL, CR/LF, and glob metacharacters in initial-version transfer paths; quote whitespace and test parser boundaries. Do not build a remote shell command from a path. Verify batch parsing and OpenSSH interoperability before shipping transfer. A reserved owner can deploy new files through these operations without a second approval layer.

Keep connection timeout and whole-operation deadline separate. Exit 255, lost transport, or local cancellation cannot establish whether a remote job completed. Record unknown outcome and hold for reconciliation when remote work may still be active. Local process termination cannot prove remote termination. Ordinary remote exit codes remain observed command results, not automatic reservation release.

## UART provider

Use one server-owned serial handle per held reservation, opened only through explicit `access.open`. Inventory, edit, discovery, and description never open it. Initial transport candidate: SerialPort 13.0.0, with its tagged source and native binding checked on the supported Node/OS combination before adoption. The public stream reference currently identifies itself as 12.x; it is not a substitute for this version gate.

Open with automatic opening disabled, error listeners installed before the explicit open, explicit serial settings, and OS-level exclusive access. Do not silently switch to another serial library or device path. The configured stable path must resolve to an admitted character device; capture its identity for endpoint conflict checks. A replug or changed identity closes access and requires a fresh explicit open after reconciliation.

Operations are `uart.read`, `uart.write`, and `uart.set-lines`. Read returns a bounded byte window and timeout/truncation information. Write takes exact base64 bytes and returns written/drained state. The text UI converts the chosen text encoding and line ending to bytes before this request. Control-line changes can set RTS and DTR only; CTS and DSR are observed inputs. Do not flush buffers or reconnect automatically.

Serial data arrives in arbitrary chunks. Do not infer a command exit status from receiving bytes or finding a prompt. Login and validation protocols belong in notes and agent tooling unless a later provider adds a defined protocol. Opening a port can change electrical control lines even without an explicit set-lines call. Document the board’s behavior and validate it on real hardware before claiming that a no-reset workflow is safe.

## Agent identity and skill distribution

The Hardware plugin contributes one default rule plus hardware-discover, hardware-reserve, hardware-access, and hardware-release skills through the current system catalog. They are independent of user templates. Package their helper through contribution files. Include the same system skills in Codex and Claude launches, resumed sessions, forks, and Forge workers on both providers.

AgentHardwareContext follows the private execution-locator pattern, independently of Cooperation assignments. Inject `CLOUDX_HARDWARE_CONTEXT` and `CLOUDX_HARDWARE_HELPER` through runtime context and both provider launch adapters. Bind a random capability to the exact tab, provider execution, and managed worker/attempt identity. Rotate it on replacement. Authenticate on every request against current server ownership. Never print the capability or accept a caller-supplied owner as proof.

Read-only discovery hooks can use ordinary plugin hooks. Agent reserve/access/release requests must use the authenticated helper endpoint. Management routes act as the user and retain existing Origin/Host admission. Do not infer an AI owner from the selected tab or a `targetTabId` in an HTTP body. Protect force release as a user-management action; the default agent helper does not expose it.

Deployment reports per-execution skill readiness and a clear Relaunch required state. New and resumed launches must receive the full skill set and helper environment before their first hardware task. Existing Codex executions can receive updated skill text, but a runtime prompt cannot add environment variables to an already-running process. Existing Codex and Claude executions therefore require a normal, deliberate relaunch if their launch lacked the hardware context. Claude also requires relaunch for changed policy. Do not silently restart active work or claim complete rollout while any execution lacks the policy/helper. Native coverage of these cases is a release gate.

## Lifecycle, startup, and shutdown

HardwareOwnerMonitor subscribes to SessionStore tab changes/removal and Forge attempt lifecycle. Explicit native-tab removal is an intentional lease revocation, distinct from proof of producer termination. Revoke the tab's helper capability first, then revoke all native reservation generations for its exact tab ID and run managed cleanup. Earlier unknown effects remain in receipts and history but do not prevent release after successful cleanup. Failed native cleanup or a failed release hook remains held for manual recovery. Forge retains its exact-attempt quiescence authority.

Keep owner liveness separate from UI tab status. New executions, provider switches, forks, and new worker attempts do not inherit claims. Reopening a closed tab must obtain a new reservation and cannot bypass a subsequent owner's generation.

Startup order is writer lease, validated snapshot, closed access admission, complete workspace/Forge restoration, exact-owner and receipt reconciliation, persisted reconciliation, then open admission. Preserve an active claim only for the exact surviving execution. Unknown owners, interrupted checking/preparation/release, and missing receipts remain held. Never replay scripts or auto-expire on startup.

Shutdown closes admission, stops scheduling, drains known local operations, persists remaining claims and outcomes, detaches/preserves eligible terminal sessions through their owners, then releases the writer lease. It does not clear all reservations. A final tab removal can request cleanup; server shutdown itself cannot.

## Event and history projections

Expose monotonic store revision and event cursor. Events include item/status updates, reservation phase changes, owner observations, note edits, and operation outcomes. The web UI invalidates its affected snapshot; a missed-event window requires a full refresh. Do not resend failed mutations on reconnect.

Keep complete live receipts and unresolved evidence. Retain detailed completed history for a configured period and size bound; default bounds are 30 days and 10,000 completed entries, with an additional 16 MiB completed-result budget, with a visible retention setting. Keep a compact request-ID, caller, payload-hash, and terminal-outcome index for the lifetime of this v1 store. Pruning output or detailed history must not make an old request executable again. Live/unknown receipts are never pruned. New ordinary work stops at 100,000 retained requests or a 48 MiB accounted budget. Account for pending results and cleanup of every live hold before admission; the physical snapshot remains bounded at 64 MiB. Cleanup requests can use separate headroom, but cannot consume the last acknowledged-override allowance for a hold. Capacity rejection preserves writer readiness and saved request identities. An archival/compaction protocol needs a separate design before deleting identities.
