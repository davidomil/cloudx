# Use the Hardware plugin

## Open Hardware

Open **Hardware** from Add tab. All panels on one CloudX host share the inventory. Closing a panel keeps its items and reservations. Add an SSH or UART item with a name, physical group, connection settings, notes, and capability tags. Put SSH and UART aliases of the same machine in the same physical group.

## Configure host access

Hardware storage, script process ownership, and UART control-line handling require Linux. Install OpenSSH client tools for SSH/SFTP and `ssh-copy-id`, and Python 3 for Linux UART modem-control operations. Admit explicit local key files, optional known-hosts overrides, UART paths, transfer paths, and custom script directories through `CLOUDX_ALLOWED_ROOTS`. Inventory inspection does not open the endpoint.

SSH defaults to **Current SSH agent**. It uses the agent available to the CloudX server through `SSH_AUTH_SOCK`; no socket path is required. This is the server's agent, including when the browser runs on another machine. Choose **Identity file** to use an admitted private key, or **Password** to enter a login password. Passwords are saved in CloudX's private secret store. Inventory contains an opaque reference, and editing an existing item never displays its saved password.

No known-hosts path is required. SSH uses the host account's normal known-hosts files, saves a new host key on first connection, and rejects a changed key. Explicit file overrides still require an admitted regular file and strict checking.

To install keys on a machine, save the item, reserve it, and choose **Register SSH key** before opening access. Enter a registration password when needed. Agent/password items register the keys loaded in the current SSH agent; identity-file items use their configured key pair. `ssh-copy-id` checks which keys already work and skips them. Registration does not change the item's authentication method or retry a failed command. A temporary registration password is discarded after the local operation and cleanup finish; interrupted temporary passwords are cleared on server startup.

## Set statuses and hooks

In **Statuses & hooks**, bind a boolean, text, or enum definition to a manual value or host Bash command. Boolean commands use exit codes: zero means `true`, and any normal nonzero exit means `false`. Output is retained for diagnostics and does not set the boolean value. Text and enum commands must exit zero and print one JSON value of their declared type. Set freshness, scheduling, and an exact required value when it gates reservation; `false` is a valid requirement. Before reserve and On release run in their configured host directory with bounded output and a deadline. They receive JSON context on stdin.

New status commands and hooks default to `/` on the CloudX host. Keep this value, or choose an existing directory inside the server's allowed roots. CloudX validates it when saving and again before running. A rejected directory leaves the configuration editable. While a reservation or check holds the resource, **Inspect hold** opens its exact entry in Reservations, including its state and recovery reason.

For a boolean online check, use a bounded ping directly. For example, set a three-second script deadline and use:

```bash
ping -n -c 1 -W 1 -w 2 192.168.8.100
```

The [iputils documentation](https://github.com/iputils/iputils/blob/20240117/doc/ping.xml) defines the exit codes. A reply gives `true`; a normal nonzero exit gives `false`. Inspect the receipt's exit code and captured output for the reason. CloudX directory, launch, and output-limit errors remain errors; timeout, cancellation, and uncertain cleanup retain recovery holds.

This changes the earlier JSON-based boolean contract. A script that prints `false` but exits zero now reports `true`; return a nonzero exit code to report `false`.

## Resolve script credentials

Configure only the references a script needs. Reference `lab-token` resolves the server-startup environment variable `CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN`. References normalize punctuation to underscores and letters to uppercase. Restart the server after changing its credential environment. Selected scripts receive the requested variables; captured script diagnostics redact their values. Missing references fail explicitly. Inventory and skills contain reference IDs rather than credential values.

## Use the AI workflow

Use this workflow for hardware registered with the Hardware plugin. If the user requests hardware that is not managed by the plugin, use ordinary SSH, UART, or host tools without registering it or obtaining a Hardware reservation. The Hardware helper is not required for that unmanaged access. Existing host controls and higher-priority instructions still apply.

When checking whether a target is managed, inspect the complete inventory and its known physical aliases. An availability-filtered list can omit a registered item. Disabled, held, ineligible, or unavailable hardware remains managed. A missing helper or failed lookup does not prove that a target is unmanaged. A denied reservation or unknown outcome does not authorize raw access to managed hardware.

New Codex, Claude, and Forge launches receive four system skills: `hardware-discover`, `hardware-reserve`, `hardware-access`, and `hardware-release`. The panel identifies existing executions that need deliberate relaunch before managed access. For registered hardware, an agent discovers candidates, reads notes, reserves an exact item revision, waits for an active claim, rereads notes, then opens managed access. Every mutation records a unique request ID. After a lost response, inspect that original receipt; do not start replacement work.

## Run and transfer

Use SSH Run script, Upload, or Download with explicit deadlines and output bounds. A no-overwrite upload requires the server’s SFTP hard-link extension and filesystem support. Failed transfers can leave a named remote staging directory for inspection. UART reads and writes bounded exact bytes with explicit line endings and RTS/DTR controls. Opening a UART can affect the attached board; use its documented procedure before sensitive work.

## Release and recover

Close access and release after the task, including known failure. Reservations permit broad task work; follow notes such as Do not reboot. Notes are agent guidance. Agents must release explicitly when done; an idle tab, completed turn, lost heartbeat, browser disconnect, or server detach does not release a reservation.

Closing the owning AI tab revokes its claims, including claims from earlier executions of that tab. CloudX cancels managed work, closes access, and runs any pending release hook. Successful cleanup clears the lock even when an earlier operation had an unknown outcome; that operation's receipt and history remain available. Failed or unconfirmed cleanup leaves a recovery hold for manual release. Forge workers retain their separate attempt lifecycle.

The Reservations view shows the owner tab's title and available workspace, plus the exact owner and generation in its details. **Open owner** reveals that existing tab, including a tab outside the current workspace or pane. It does not start a replacement execution. A missing tab is unavailable. Reopening a closed tab requires a new reservation and remains blocked while another owner holds the hardware.

The user can release a hold manually. Force release requires the current hold revision, a reason, and acknowledgement when external activity remains unresolved. A replacement execution cannot inherit the old claim.

## Inspect retained outcomes

Completed output and history have default bounds of 30 days and 10,000 entries; completed result payloads also share a 16 MiB budget. The panel shows applied retention settings and explicitly marks pruned output. Live and unknown receipts remain retained. The compact request identity and terminal outcome remain available so pruning cannot replay an old operation.

Hardware returns `CAPACITY_EXCEEDED` at 100,000 retained requests or when new work would consume space needed for saved outcomes or cleanup. Receipt inspection remains available. If ordinary cleanup cannot fit, automatic owner cleanup leaves a recovery hold. Inspect the hold and use Force release with explicit acknowledgement of unresolved activity. The store retains old request identities, including across restart; this version has no identity archival command.
