---
name: hardware-release
description: Close managed hardware access, release its reservation, and report uncertain cleanup honestly.
---

# Release hardware

Design draft. A release is complete only when its saved receipt confirms release.

1. Complete or stop the task's hardware work. Account for task-started background/remote work. Do not assume that a local SSH process exit stopped every remote effect.
2. Close the managed connection with `node "$CLOUDX_HARDWARE_HELPER" access close --input close.json`. Keep the exact current claim ID/generation. Close can settle handles in recovery but does not clear unknown effects. Inspect its receipt.
3. Request `release --input release.json` with a new requestId and the same claim reference. The service drains managed operations and executes the configured cleanup once.
4. Inspect `receipt --request REQUEST_ID`. A lost response means inspect the same request, not issue a second release with a different identity.
5. Report released only after the saved outcome removes the live hold. Another tab can then acquire it if its admission statuses permit.
6. If cleanup or remote outcome is unknown, report the recovery reason and claim reference. Leave the hold in place for operator reconciliation or explicit override.

Do not mark a custom status Free to use to clear a claim. Do not force release through a management endpoint. A stale claim cannot release a later owner's reservation.
