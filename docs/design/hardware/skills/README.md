# Draft hardware skills

These four SKILL.md files preserve the original design drafts. The built-in HardwarePlugin installs current runtime versions from apps/server/src/hardware/hardwareContributions.ts as system entries, independently of a selected template. See the [operator guide](../runtime.md) for current helper readiness and procedures.

| Skill ID | Purpose |
| --- | --- |
| hardware-discover | List tags/types/statuses; list, filter, and inspect hardware. |
| hardware-reserve | Acquire an exact item revision and reread notes. |
| hardware-access | Use the active claim through typed SSH/UART operations. |
| hardware-release | Close access, release, and report uncertain cleanup. |

## Default rule: hardware-access-policy

Use the Hardware plugin workflow for registered hardware. If the user requests hardware that is not managed by the plugin, use ordinary SSH, UART, or host tools without registration, a Hardware reservation, or the helper. Existing host controls and higher-priority instructions still apply.

Check the complete inventory and known physical aliases when deciding whether a requested target is managed. Disabled, held, ineligible, or unavailable entries remain managed. A missing helper, failed lookup, denied reservation, or unknown outcome does not prove that a target is unmanaged.

For registered hardware, read this execution's context. Discover suitable hardware, reserve it, read its current notes, confirm suitability, perform the authorized work, and release it. Do not use hardware held by another owner. Do not bypass a denied or unknown claim through raw host tools.

A reservation permits broad work for the task without a new per-command approval from the plugin. Follow machine-specific notes, including restrictions such as Do not reboot. Those restrictions are agent guidance and are not enforced by a server policy parser. Existing higher-level instructions and host controls still apply.

Keep the same request ID when inspecting a delayed result. Preparing is held but not usable. Report failed or uncertain cleanup without claiming the hardware is free. A heartbeat is diagnostic and does not expire ownership. Force release is an operator action, not a default agent command.
