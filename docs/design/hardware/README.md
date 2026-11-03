# Hardware plugin design

## Overview

**Design reference and implementation, 2026-11-03.** Hardware gives CloudX a shared machine inventory, SSH and UART access types, editable capability tags and notes, configurable statuses, and exclusive reservations for AI tabs and workers. The built-in plugin now implements this design. Start with the [operator guide](runtime.md) and [actual UI gallery](implementation/README.md). This directory also preserves the original concepts and design rationale.

The source baseline is CloudX commit `38ce47a0dc9495133267222652c1d1372a3f4a60`. The design was created against that baseline; current production contracts live in packages/shared/src/hardware.ts and packages/plugin-api/src/hardware.ts. The [research record](research.md) identifies the current integration points and their limits.

Design package documents.

| Read | Purpose |
|----|----|
| [Operator guide](runtime.md) | Configure hardware, scripts, credentials, managed access, and recovery. |
| [Actual UI gallery](implementation/README.md) | Seven screens captured from the emulated running plugin. |
| [Product design](design.md) | Inventory, tags, statuses, notes, reservation permissions, and screen behavior. |
| [Architecture](architecture.md) | State ownership, persistence, concurrency, providers, scripts, and lifecycle. |
| [API and agent workflow](api.md) | Type extension API, actions, filters, receipts, errors, and exact access semantics. |
| [TypeScript contracts](contracts.ts) | Proposed serializable records and server-side provider interfaces. |
| [Typed examples](examples.ts) | SSH/UART configuration, a shared physical group, filtering, and a reservation. |
| [Implementation and validation plan](implementation-plan.md) | Ordered milestones, dependencies, tests, and requirement coverage. |
| [Screen designs](visuals.md) | Seven imagegen concepts, control coverage, prompts, and review notes. |
| [Draft agent skills](skills/README.md) | Default discovery, reservation, access, and release procedures. |
| [Research and decisions](research.md) | Rated sources, observed integration constraints, and chosen approach. |
| [Validation record](validation.md) | Runtime, browser, transport, build, and local-environment results. |

## Main decisions

- One host-wide service owns inventory and claims. Panels and agents share it.
- Hardware types are code contributions with a versioned API. Start with SSH and UART; add PCIe later through the same contract.
- Tags and status definitions have stable IDs and editable labels. Discovery can list them before filtering.
- Manual/command statuses describe hardware. They cannot override an internal reservation.
- Persist an exclusive claim before the optional preparation script. Script failure keeps a recovery hold.
- Bind a claim to the exact tab execution or worker attempt. A lost heartbeat does not release it.
- Release after explicit completion or confirmed owner termination and cleanup. Manual override revokes the old generation.
- A reservation permits broad hardware use. Notes contain agent instructions such as “Do not reboot”; the plugin does not enforce those restrictions.
- Default system skills reach Codex, Claude, and Forge launch paths. Existing executions without the helper context need a deliberate relaunch; rollout readiness is visible and tested.

## Review the full workflow

An agent lists tags, searches for available ARM64 deployment hardware, reads `web-01`, reserves its exact revision, rereads notes, opens SSH access, deploys or validates, closes access, and releases it. While the optional reserve script runs, other agents already see the hardware as held. A UART alias in the same physical group cannot be reserved by another tab.

The seven generated screens cover inventory and notes, the item editor, UART access, SSH execution and transfer, custom statuses and scripts, reservation monitoring and force release, and tag/type/group catalogs. They are concepts, not running-product screenshots. Use the written contracts for exact behavior and identifiers.
