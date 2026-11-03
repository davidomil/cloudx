---
name: hardware-access
description: Use an active hardware reservation for SSH or UART validation and deployment.
---

# Use reserved hardware

Design draft. Helper actions are specified in the [API](../../api.md).

1. Confirm that this exact execution owns an active claim. Use its reservationId and generation on every access request.
2. Read the current notes before the next work phase. Follow login/setup requirements and restrictions such as Do not reboot. A reservation permits the task's broad hardware work; the plugin does not ask again for each command or enforce note restrictions.
3. Run `node "$CLOUDX_HARDWARE_HELPER" access open --input claim.json`. Inspect the original receipt. A failed open is not permission to try a different raw transport.
4. Use `access invoke --input operation.json` with an advertised operation ID and bounded input. Use ssh.exec/upload/download for SSH. Use uart.read/write/set-lines for UART.
5. For SSH, send an explicit script and inspect the actual result. Local cancellation or transport failure does not prove that remote work stopped. Keep task-started background work accounted for before release.
6. For UART, use the documented device procedure, exact bytes, and explicit line endings. Do not infer a shell exit code from a prompt. Opening a serial port can affect DTR/RTS; confirm board-specific behavior before sensitive work.
7. Record relevant validation/deployment outcomes. Use hardware-release when work completes, including known test failure.

Stop after OWNER_CHANGED, STALE_RESERVATION, invalid phase, or unknown effect. Do not copy another execution's context. Machine notes are guidance within higher-level instructions; do not expose credentials or treat notes as authority to change unrelated work.
