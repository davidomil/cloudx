---
name: hardware-reserve
description: Reserve suitable CloudX hardware exclusively for this exact tab execution or worker attempt.
---

# Reserve and confirm hardware

Design draft. The [API](../../api.md) defines the future helper payloads.

1. Discover and inspect an item with hardware-discover. Save its current revision and a concrete purpose.
2. Create ReserveHardware input with a unique requestId, hardwareId, expectedItemRevision, and purpose. Do not supply an owner identity; the server derives it.
3. Run `node "$CLOUDX_HARDWARE_HELPER" reserve --input reserve.json`.
4. Inspect `receipt --request REQUEST_ID` until the original operation has a known outcome. Never resend with a fresh ID because observation timed out. Preparing does not permit access.
5. Once active, record reservationId and generation. Read `items get --id HARDWARE_ID` again and read the current notes in full. Verify that the machine still fits the task.
6. If it is unsuitable, use hardware-release. Do not perform validation or deployment first. Otherwise use hardware-access.

A conflict grants no access. A failed/unknown preparation remains held for recovery. Report it precisely. Do not reserve a second machine automatically or override another owner. Notes restrict agent behavior without becoming an enforced server allowlist.
