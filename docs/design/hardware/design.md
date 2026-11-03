# Hardware plugin: product design

## Overview

**Product contract, 2026-11-03.** Hardware gives every CloudX AI tab a shared inventory, discovery skills, and exclusive reservations for validation and deployment. The built-in implementation follows this contract. The [operator guide](runtime.md) describes current host prerequisites and procedures.

## A shared hardware inventory

The plugin ID is `hardware`, its display name is **Hardware**, and its acronym is **HW**. Open its native panel from Add tab. Every panel reads the same inventory on one CloudX host. Closing a panel does not remove hardware or release reservations. Worktrees and workspace windows do not create separate inventories.

A hardware item has a stable ID, name, description, enabled flag, physical resource group, connection type, validated connection configuration, capability tags, notes, custom statuses, and optional reservation scripts. Start with SSH and UART. PCIe is a future code provider; it is not an initial supported connection type.

Create, edit, disable, and delete items in the panel. Require a name, type, valid configuration, and resource group. Creation can create a new resource group in the same transaction. Deleting a held item or a group with items fails with an explanation. Disable prevents new reservations; it does not terminate the current owner’s work. Do not expose credential values in inventory results, browser responses, or generated skills.

An SSH item records host, port, username, one selected authentication method, known-hosts file, and connection timeout. Authentication uses an explicit SSH-agent socket or an identity-file reference. A UART item records the host’s stable device path, baud rate, data bits, stop bits, parity, and flow control. Configuration belongs to the type provider. Notes can add login details, setup instructions, expected software, test paths, and operational limits.

## Capability tags and physical resources

Maintain a shared tag catalog with stable IDs, editable labels, and descriptions. Agents can list the complete catalog and filter with all, any, and excluded tag sets. Renaming a label preserves item membership and saved filters. Reject deletion of a used tag until the user explicitly reassigns or removes its uses. Reject duplicate normalized labels. Return an error for unknown filter IDs rather than silently ignoring them.

Each item belongs to one physical resource group. For example, `web-01` over SSH and `console-01` over UART both belong to `lab-server-01`. Reserving either item holds every item in that group. Show the group and its aliases in item details and the catalog. A new group is the default creation choice for a distinct machine.

Providers also derive normalized endpoint conflict keys. A claim includes the union of endpoint keys for every alias in its physical group. Reject duplicate endpoints across distinct groups; the user must put them in one group. Detect newly resolved duplicates before acquisition and access. Different hostnames or network interfaces can still refer to the same machine; the user must group them explicitly. Do not claim automatic physical-device identification. Freeze group membership and connection identity while any affected key is held.

## Custom statuses

Statuses describe hardware. Reservations control ownership. Keep these separate in the database, API, table columns, and labels. A manually set `Free to use = true` cannot clear a reservation.

The shared status catalog defines stable IDs, labels, and value types: boolean, text, or enum. Each item binds a definition to a manual value or a configured host-side Bash command. The binding can require a particular value before reservation. For example, `Up = true` and `Free to use = true` can be admission requirements; a `Firmware build` text status can be informational.

A command has an explicit working directory, deadline, output bound, maximum observation age, and optional polling interval. Its successful stdout must contain exactly one JSON value of the declared type. Exit zero is required. Stderr contains diagnostics. A nonzero exit, invalid JSON, timeout, or invalid enum value produces an error observation with no inferred value. Thus a script that only executes `ping` is not a boolean status until it explicitly prints JSON `true` or `false`.

Show value, source, observed time, freshness, last error, and next scheduled check. Manual values remain current until changed; command values become stale after their configured maximum age. Missing, stale, or errored values cannot satisfy a reservation requirement. Refresh never happens implicitly during list or reserve. Agents call status refresh, inspect the result, and then request a claim.

Configured checks use the same resource exclusion gate as reservations. A free-resource check persists a short system-owned checking hold before it runs. A concurrent reserve returns `CHECK_IN_PROGRESS`; no automatic waiting or retry occurs. While a reservation is held, scheduled checks skip the group and show the last observation as it ages. The owner can explicitly refresh only through an active, nonrevoked claim; the service serializes that check with its managed access operations. Release cancels or drains owner checks too. A crashed or ambiguous check keeps its resource held for recovery.

Status commands run on the CloudX host under its configured execution policy. They may call tools such as SSH if the operator configured that behavior. They are not provider shell commands and do not silently open UART devices. Treat them as trusted, bounded administrator scripts intended for observation. The plugin cannot prove that arbitrary Bash is free of side effects.

## Discover, reserve, inspect, use, release

The default agent workflow has seven steps.

1.  Read the hardware helper’s current execution context.
2.  List tags, types, and status definitions. Search the inventory with explicit filters.
3.  Read the selected item’s complete configuration metadata, notes, status observations, and revision. Refresh required statuses if necessary.
4.  Reserve that exact item revision for a stated purpose. Wait for the operation receipt to report an active claim. Preparing does not permit access.
5.  Read the current details and notes again after acquisition. Confirm that the hardware fits the task. Release it without using it if it does not.
6.  Open a reservation-bound connection and perform validation, deployment, or other authorized hardware work. Record useful results in the task’s evidence.
7.  Close managed access and release the claim. Inspect the release receipt. Report a recovery hold if cleanup is uncertain.

A reservation authorizes broad hardware use for that task. The plugin adds no per-command approval or operation allowlist. Notes such as “Do not reboot this machine” are instructions that the agent must read and follow. The plugin does not interpret or enforce those restrictions. Existing host admission, path boundaries, and the agent platform’s controls still apply.

Notes remain editable while held. Increment their revision and show an update to the owner. Skills reread them before the next work phase. Notes revisions record what the owner saw; they do not act as a server-enforced policy acknowledgement. Treat notes as machine-specific guidance, not authority to override higher-level instructions or reveal secrets.

## Reservation ownership

One server-authenticated execution owns a claim. Store tab ID, provider, execution ID, purpose, and timestamps. For managed work, also store owner plugin, logical run, worker, and attempt IDs. Sibling agents do not inherit ownership. The parent must coordinate their work under the same execution or obtain separate eligible hardware.

The server saves the claim before it starts an optional Before reserve Bash script. Every tab sees the resource as held during preparation. Only a successful, matching preparation result advances the claim to active. A failed or uncertain script leaves it held with `recovery_required`. A repeated request ID returns the recorded operation; it cannot dispatch the script again.

Release first prevents new operations, then drains or cancels managed access, closes connections, and runs the optional On release script. Keep every conflict key held until cleanup has a known successful outcome and the release is saved. A cleanup failure leaves a visible recovery hold. Scripts run once per recorded lifecycle operation; the service does not retry them or replay them after restart.

## Monitor tabs and workers

Owner observation shows active, confirmed ended, or unknown. The view includes last observed time and a link to the exact tab or worker when it still exists. Heartbeats and browser connectivity are diagnostic signals. They do not expire a reservation.

Explicit owner release is the normal path. Confirmed tab termination or confirmed Forge-attempt quiescence requests the same cleanup path automatically. Idle tabs, a completed conversational turn, browser disconnects, missing PIDs, and server session detach do not prove that work ended. If lifecycle evidence or remote effects remain uncertain, keep the resource held and show why.

Restart reconciliation preserves exact surviving claims. Do not transfer them to a new provider execution, fork, or replacement worker attempt automatically. A resumed logical task must finish release or request operator recovery and then acquire a new claim. This avoids introducing a second ownership-transfer protocol in the first version.

## Manual override

The operator can force release any held resource, including a failed checking hold. Show the exact reservation or check ID, generation, hold revision, owner, purpose, age, latest notes, outstanding operations, and uncertainty. Use a discriminated reservation/check target. Require a reason and a matching hold revision. Require explicit acknowledgement only when unresolved external activity remains.

Override first revokes the old generation and prevents new managed access. Cancel and drain CloudX-owned operations and close their handles. Attempt the configured release hook once when it is applicable and no previous release-hook execution exists. The normal result is available after confirmed cleanup. If cleanup remains uncertain, keep the hold until the operator explicitly accepts that state. The accepted override then clears the lock and records the unresolved activity in history.

An old callback, copied claim handle, or old worker attempt cannot reactivate or release a replacement claim. Force release does not promise to terminate arbitrary raw SSH sessions, detached remote jobs, or another local program’s UART handle. Plugin-managed access enforces ownership. Host-shell access outside the plugin is outside that enforcement boundary.

## The native screen

The panel has Inventory, Reservations, Tags & types, and Statuses & hooks views. Inventory provides search, typed filters, capability filters, status filters, availability, owner filtering, and an item inspector. Item details expose notes, connection metadata, reservation controls, and activity. The editor creates both SSH and UART items through the same schema-driven form.

Reservations shows all preparing, active, releasing, and recovery holds. It identifies user reservations, agent reservations, and system checks separately. The history shows who acquired, used, released, or overrode hardware and why. The catalog manages tags and physical groups and displays registered type descriptors. There is no code-upload or marketplace UI for type providers.

SSH access provides bounded script execution and file transfer through the held connection. UART access provides a bounded receive transcript, text or base64 writes, explicit line-ending selection, and explicit RTS/DTR actions. UART output is bytes and observed protocol behavior; it does not automatically produce a shell exit code. Opening a serial device can have electrical effects even without an explicit control-line action.

Use current CloudX theme tokens and existing controls. The generated concepts show information hierarchy and feature coverage; decorative navigation and sample data are illustrative. The [screen specification](visuals.md) records the normative controls and any image deviations.

## Interaction and failure states

Support narrow split panes, keyboard navigation, visible focus, text labels alongside color, and accessible tables. Replace the side inspector with a sheet in a narrow pane. Preserve edit drafts per hardware item. Restore focus after dialogs. Expose connection transcripts as selectable text. Do not move the user’s selected item when another owner changes state.

Represent loading, empty inventory, no search matches, validation errors, stale revision, stale status, owner unknown, preparing, releasing, script failure, unavailable provider, denied operation, recovery hold, and lost server connection explicitly. An empty database and a failed database read must look different. A timeout never displays a successful reservation or release. On reconnect, fetch a current snapshot before enabling mutations; do not silently resend them.
