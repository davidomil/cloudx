# Hardware plugin: API and agent workflow

## Overview

**API v1.** The built-in Hardware plugin exposes these actions through the authenticated helper and user management routes. Current runtime contracts and validators live in packages/shared/src/hardware.ts and packages/plugin-api/src/hardware.ts. [contracts.ts](contracts.ts) and [examples.ts](examples.ts) preserve the original design examples. See the [operator guide](runtime.md) for host prerequisites.

## Type extensions

Add `hardwareTypes?: HardwareTypeProvider<unknown>[]` to WorkspacePlugin. HardwareTypeRegistry loads these code contributions at server composition. The owning plugin controls transport code; inventory users configure validated data only. A separate plugin can contribute `vendor.pcie` without changing reservation logic or pretending that PCIe supports a shell.

A provider descriptor has a globally unique `<pluginId>.<typeName>` ID, matching owner plugin ID, `apiVersion: 1`, positive `configVersion`, display name, description, JSON Schema configuration, and named operation input/output schemas. The registry rejects duplicates and unsupported versions. Schemas use draft 2020-12 with bounded depth/size and local references only; validate the schemas themselves at registration.

Type extensions.

| Method | Contract |
|----|----|
| `parseConfig(value)` | Validate unknown serialized configuration. Return the provider’s typed configuration or a field-addressed error. No device or network access. |
| `inspectEndpoint(config)` | Return configured/canonical endpoint conflict keys, local readiness, and blockers without opening a connection. May inspect admitted local files/device metadata. No network probe. |
| `describeAccess(config)` | Return readable non-secret connection metadata. No network connection, serial open, or probe. |
| `connect(config, context)` | Open a managed connection only after the service validates an active reservation. Bind all handles to that reservation generation. |
| `registerKey?(config, input, context)` | Register SSH keys before opening access, under a user-owned active reservation and the same bounded cleanup and outcome contract. |
| `connection.invoke(operationId, input, signal)` | Run one advertised operation with validated input. Return schema-valid JSON or a typed error. The service checks current ownership before each call. |
| `connection.close(signal)` | Close every owned handle. Return only after known cleanup; otherwise report uncertainty. |

HardwareService claims `physical:<physicalResourceId>` plus the union of endpoint keys for every item in that group. SSH keys normalize host and port and intentionally omit username so two accounts on one endpoint conflict. Use an unambiguous tuple encoding rather than delimiter concatenation. UART inspection always returns a configured-path key and adds resolved character-device keys when present. A missing device returns ready=false and prevents selecting that item for acquisition; an unavailable alias does not block an otherwise-ready SSH item in its group.

Reject an endpoint key shared by different physical groups at create/edit and recheck before acquisition, status checks, and access.open. If previously absent device metadata reveals a cross-group duplicate, mark the affected items unavailable until their grouping is corrected. Compute prospective alias keys and test live holds in the same serialized mutation. The status-check gate uses exactly the same group-wide key algorithm. A changed selected endpoint key requires closing/reconciling the claim, not silently switching devices.

The service owns input/output validation, credentials, deadlines, generation checks, history, and reservation transitions. Providers receive only the private context needed for their connection. Neither providers nor operation outputs can mutate claims. Connect/invoke/close return ProviderOutcome with completed, failed/known-effects, or unknown disposition. Register cleanup before connection side effects. The service maps completed to a succeeded receipt, failed to a failed receipt with the existing claim held, and unknown to an unknown receipt plus recovery. Domain result tables below describe completed values. A known command exit failure is still a completed observed result. Release cannot succeed while cleanup or prior effects remain unknown.

## Catalogs and mutations

Catalogs and mutations.

| Action | Input | Result |
|----|----|----|
| `hardware.tags.list` | Optional cursor and limit. | Stable tag IDs, revisions, labels, descriptions, usage counts, next cursor. |
| `hardware.types.list` | Optional cursor and limit. | Installed type descriptors and supported versions; PCIe is absent until contributed. |
| `hardware.statuses.list` | Optional cursor and limit. | Status IDs, labels, value types, enum values, revisions. |
| `hardware.items.list` | HardwareFilter. Empty filter lists all items, paginated. | Items, observations, current reservation/group hold, availability, blockers, store revision, next cursor. |
| `hardware.items.get` | `hardwareId`. | Full current item, notes/revisions, access description, observations, group aliases, current hold, and store revision. |
| `hardware.reservations.list` | State filter and `ownedByMe`, cursor, limit. | Claims and system-check holds with owner observations and reasons. |
| `hardware.statuses.refresh` | `requestId`, `hardwareId`, status IDs; claim reference when owned. | Persisted check receipt. No implicit reserve. |
| `hardware.reserve` | ReserveHardware. Owner is resolved by the server. | Receipt and claim reference; access requires active state. |
| `hardware.access.open` | `requestId`, reservation ID, generation. | Managed connection receipt and supported operations. Repeated open returns the same connection identity. |
| `hardware.access.invoke` | InvokeHardware. | Persisted running receipt followed by the schema-defined result. |
| `hardware.access.close` | `requestId`, reservation ID, generation. | Known closed or failed/unknown cleanup receipt. Closing does not release ownership. |
| `hardware.release` | ReleaseHardware. | Cleanup receipt and held/released outcome. |
| `hardware.receipt.get` | Original request ID. | The caller’s stored operation, phase, result, or precise unknown/pruned-output state. |

The panel additionally manages item, tag, status-definition, and physical-group create/update/delete; status binding and manual-value updates; and `hardware.forceRelease`. ForceReleaseHardware uses a discriminated reservation or system-check target, its generation, expectedHoldRevision, reason, and unresolved-activity acknowledgement. Every hold transition increments its revision. Every update/delete uses the current record revision. Item creation and item updates can create and assign a group atomically with `newGroupName`; update requests also require the current item revision and an unheld physical group. Referenced tags/groups cannot be deleted. A used status definition’s value type cannot change; create a new definition and explicitly rebind instead. Labels and descriptions can change without changing IDs.

For command statuses, the definition's value type selects the result contract. A normal boolean command exit produces a known value: zero is `true`, and any nonzero code is `false`. Either value completes the refresh successfully; stdout and stderr remain diagnostics. Text and enum commands require exit zero and one JSON value of their declared type. Runner failures and uncertain outcomes retain their existing error and recovery behavior.

The panel defaults new status commands and reservation hooks to `cwd: "/"`. Script input requires an explicit absolute `cwd`. Hardware scripts admit the literal `/`; custom directories must exist inside the server's allowed roots. Configuration saves and script execution both validate the directory.

Reject item connection/type/group/hook/status-binding edits while affected keys are held. Allow notes, tag membership, descriptive metadata, enabled state, and manual status values to change with revisions; these changes never evict the owner. A manual value update preserves the binding revision and updates the observation. Disabling a type contribution does not delete its saved items; they become unavailable until its exact supported code returns.

## Filtering and pagination

The [typed filter example](examples.ts) requests available SSH hardware with both ARM64 and deployment tags and a fresh true Free to use value. `tags.all` requires all listed IDs; `tags.any` requires at least one when nonempty; `tags.none` excludes any listed ID. All specified predicates combine with AND. An empty predicate list imposes no restriction. Match boolean/string values exactly; never coerce text `"true"` to boolean `true`.

Text search is a case-insensitive substring over name, description, and notes. Tag labels are discovered through the catalog; filters use IDs. Type IDs are exact. Unknown tags, definitions, or types return INVALID_FILTER. Default result ordering is normalized name then stable ID; limit defaults to 50 and is bounded to 1–200.

Availability means `available`, `held`, or `ineligible`. Checking, preparing, active, releasing, and recovery states all count as held. Missing, stale, errored, or unequal required status values count as ineligible when no hold exists; return all blockers either way. A fresh false value satisfies a configured equals:false requirement. Selected-endpoint readiness must also be true. `ownedByMe` uses authenticated identity, not a user-supplied tab ID. A user claim matches the admitted user, not the panel tab.

Cursors bind the filter and store revision. If that revision changed, return CURSOR_STALE and require an explicit fresh query. Never silently omit or duplicate changing rows. Agents that need every item or tag page until nextCursor is null. Query results do not guarantee a later reserve succeeds.

## Requests, receipts, and concurrency

All side-effecting requests carry a caller-generated unique requestId. The service scopes it to the authenticated owner and stores a canonical payload digest. A repeated identical request returns the same receipt and current outcome. Reuse with changed input returns REQUEST_ID_REUSED. The compact receipt index persists even after verbose logs are pruned. A new request ID is new work; the client must not create one just because a response timed out.

Agent commands return immediately with a persisted receipt once accepted. The helper can wait for that same receipt, but it must not resend the mutation. The UI shows preparing/running/releasing while the result is pending. Receipt polling is observation, not a retry of external work.

Reserve requires the observed item revision. A stale revision returns REVISION_CONFLICT with current revision and changed field names. A competing claim returns RESERVATION_CONFLICT with non-secret holder metadata. A status check in progress returns CHECK_IN_PROGRESS. No selection queue, automatic next-machine choice, or automatic acquisition retry is part of v1.

Open, invoke, and owner status refresh require an active, nonrevoked claim at admission and dispatch. Close requires the exact current held generation and matching owner; it may run in recovery or releasing to settle handles, but it cannot clear earlier uncertainty. Normal release moves active to releasing; a repeated release in releasing observes that cleanup, while recovery returns RECOVERY_REQUIRED without launching a new hook. The service resolves hardware from the claim; invocation input cannot retarget it. A user override invalidates the generation before cleanup. A delayed completion cannot make an obsolete generation active again.

## SSH operation payloads

SSH configuration uses `auth: { kind: "agent" }` by default. `socketPath` is optional for an explicit agent override. Other modes are `{ kind: "identity_file", path }` and `{ kind: "password", credentialRefId }`. `knownHostsFile` is optional; omitting it uses normal OpenSSH host files with `StrictHostKeyChecking=accept-new`. An explicit override uses strict checking.

The user-only management route `PUT /api/hardware/ssh-passwords/:credentialRefId` accepts `{ password }` and returns only `{ credentialRefId }`. A reference has the form `ssh-password-<UUID>` for a saved login, or `ssh-registration-<UUID>` for a temporary registration password. Repeating the same reference and value is idempotent; a different value for an existing reference is rejected. Passwords are single-line values of 1–1023 UTF-8 bytes. They are stored through the existing private config secret store, outside Hardware inventory and receipts; there is no password read endpoint.

`hardware.ssh.registerKey` accepts `{ requestId, reservationId, generation, timeoutMs, credentialRefId? }`. It requires a user-owned active SSH reservation with closed access. The provider runs `ssh-copy-id` for the current agent keys or the configured identity-file pair. It skips keys that already work. The operation keeps its original request identity, reports uncertain effects as recovery, and does not change authentication mode. Temporary credential cleanup waits for actual provider and process quiescence.

SSH operation payloads.

| Operation | Input | Output |
|----|----|----|
| `ssh.exec` | `script: string`, `timeoutMs: integer`, `maxOutputBytes: integer`. The configured remote entrypoint is Bash; script bytes travel on stdin. | `exitCode: integer`, stdout, stderr, truncated, and durationMs. Unknown exit uses the common unknown envelope and saved diagnostics. |
| `ssh.upload` | `localPath`, `remotePath`, timeoutMs, overwrite boolean. Initial version supports regular files only. | bytesTransferred, destination, and completed=true. Uncertain transfer uses the common unknown envelope. |
| `ssh.download` | `remotePath`, `localPath`, timeoutMs, overwrite boolean. Initial version supports regular files only. | bytesTransferred, destination, and completed=true. Uncertain transfer uses the common unknown envelope. |

SSH exec permits arbitrary script content from the reserved owner, within bounded execution. It does not add a command allowlist. Pass script content separately from local SSH argv. Never treat user names, hostnames, or file paths as shell source. Return command exit failure as a known result when it was observed; distinguish transport error and uncertain remote outcome. Unknown remote effects put the reservation into recovery until reconciled.

Validate SSH host strings as DNS names or IP literals and ports in 1–65535. Reject option-like values and NUL/newline input. Use explicit user, port, host-key, authentication, connection-timeout, and no-control-master settings; verify their effective OpenSSH configuration at implementation time. Do not inherit implicit remote commands or alternate authentication paths from a user’s unrelated SSH config. Require documented remote Bash and SFTP support; fail clearly if absent.

## UART operation payloads

UART operation payloads.

| Operation | Input | Output |
|----|----|----|
| `uart.read` | `durationMs: integer`, `maxBytes: integer`. | dataBase64, bytesRead, timedOut, truncated, startedAt, finishedAt. A quiet window returns zero bytes. |
| `uart.write` | `dataBase64: string`, timeoutMs. Exact bytes; no implicit newline. | bytesWritten and drained=true. Unknown write/drain uses the common envelope. |
| `uart.set-lines` | Explicit optional RTS and DTR booleans, at least one required, timeoutMs. | Applied output-line values. Unknown effect uses the common envelope. |

All lengths and timeouts have runtime limits. Proposed initial access limits are 1 MiB input/output per operation and 1–3,600,000 ms deadline; UART read windows additionally cap at 60,000 ms. Bound the session transcript to 4 MiB with visible truncation. Status/hook output defaults to 64 KiB and cannot exceed 1 MiB. Validate aggregate decoded base64 size before allocation or device writes.

UART has no built-in shell, login, upload, or deployment guarantee. The agent uses notes and a board-specific validated procedure over bytes. Data-chunk boundaries do not define lines. A write callback does not prove drain or target execution. The text UI chooses UTF-8 and no/CR/LF/CRLF line endings explicitly; base64 mode never transforms bytes. Opening may affect control lines and must have real-board evidence for sensitive workflows.

## Public transport and authenticated agent transport

These managed transports apply to hardware registered with the plugin. User-requested hardware outside that inventory can use ordinary SSH, UART, or host tools without registration, a Hardware reservation, or the helper. Check the complete inventory and known physical aliases when deciding whether a target is managed; filtered-out or unavailable entries and failed lookups do not establish unmanaged hardware. Existing host controls and higher-priority instructions still apply.

Management REST routes live under `/api/hardware`: catalogs, item query/get/create/update/delete, group management, status configuration/manual updates, reservations, force release, events, and receipts. Use existing host/origin policy. In v1, every admitted operator panel acts as `{kind: "user", userId: "local"}`, matching CloudX’s local-operator model. Panels therefore share human ownership and request scope; there is no new per-browser login system. The native panel uses typed API functions; it cannot edit snapshot files directly.

Read-only discovery actions can also be registered as plugin hooks. Reserve, access, and release through generic HTTP hooks cannot attribute an AI owner, so they are not an agent mutation path. `POST /api/hardware/agent` accepts an action and input with the private execution capability in the Authorization header. The server derives and validates the complete owner identity. The capability is not in arguments, logs, notes, or returned metadata.

The helper reads its own context file on every call and uses the configured local endpoint and CA. Missing context, unavailable service, or revoked execution fails clearly. It must not substitute another tab, a recent context file, raw SSH, or a UART device path to bypass failure.

## Draft command surface

These are the planned helper commands. They must not be run until the plugin exists. Input files contain the corresponding action payload from this document; keep request IDs unchanged when inspecting a lost response.

``` bash
node "$CLOUDX_HARDWARE_HELPER" context
node "$CLOUDX_HARDWARE_HELPER" tags list
node "$CLOUDX_HARDWARE_HELPER" tags list --input catalog-page.json
node "$CLOUDX_HARDWARE_HELPER" types list
node "$CLOUDX_HARDWARE_HELPER" statuses list
node "$CLOUDX_HARDWARE_HELPER" statuses refresh --input refresh.json
node "$CLOUDX_HARDWARE_HELPER" items list --input filter.json
node "$CLOUDX_HARDWARE_HELPER" items get --id web-01
node "$CLOUDX_HARDWARE_HELPER" reserve --input reserve.json
node "$CLOUDX_HARDWARE_HELPER" receipt --request REQUEST_ID
node "$CLOUDX_HARDWARE_HELPER" access open --input claim.json
node "$CLOUDX_HARDWARE_HELPER" access invoke --input operation.json
node "$CLOUDX_HARDWARE_HELPER" access close --input close.json
node "$CLOUDX_HARDWARE_HELPER" release --input release.json
```

Every catalog list accepts optional `--input` with `{cursor, limit}`; omitting it requests the first page. After reserve becomes active, read the item again. Do not execute against a preparing claim. If the target is unsuitable, close/release it and make a new explicit query. After a timeout, inspect the same receipt. After a stale-generation error, stop operations; only current server state can establish a new valid claim.

## Error contract

Errors return `{code, message, details?}` with non-secret details. Validation failures identify fields. Transport failures never masquerade as an empty list or a released claim.

Error contract.

| Code | Meaning and caller action |
|----|----|
| INVALID_INPUT / INVALID_FILTER | Correct the field/type/ID; no side effect was dispatched. |
| NOT_FOUND / PROVIDER_UNAVAILABLE | Refresh catalog/item state; do not choose an alternate transport implicitly. |
| REVISION_CONFLICT / CURSOR_STALE | Read the current record or restart the paged query. |
| RESERVATION_CONFLICT / CHECK_IN_PROGRESS / STATUS_NOT_READY | Inspect current ownership/status. No claim was granted. |
| FORBIDDEN / OWNER_CHANGED | Stop; the execution capability is absent or revoked. |
| STALE_RESERVATION / INVALID_PHASE | Stop hardware access and inspect the exact claim. |
| REQUEST_ID_REUSED | Reused identity has different payload; inspect original receipt. |
| CAPACITY_EXCEEDED | New work cannot fit while preserving outcomes and cleanup. Inspect receipts; an operator can use reserved capacity for an acknowledged force release. |
| OPERATION_IN_PROGRESS | An acknowledged override already drains this hold. Inspect the original request ID in the error details. |
| HOOK_FAILED / OPERATION_FAILED | Inspect the saved outcome. Do not infer release or absence of effects. |
| OUTCOME_UNKNOWN / RECOVERY_REQUIRED | Keep hardware held; reconcile or ask the operator to override. |
| STORE_UNAVAILABLE / WRITER_LOST | No new dispatch; repair/reconcile the authority before continuing. |
