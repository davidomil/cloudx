# Use the Hardware plugin

## Open Hardware

Open **Hardware** from Add tab. All panels on one CloudX host share the inventory. Closing a panel keeps its items and reservations. Add an SSH or UART item with a name, physical group, connection settings, notes, and capability tags. Put SSH and UART aliases of the same machine in the same physical group.

## Configure host access

Hardware storage, script process ownership, and UART control-line handling require Linux. Install Bash and OpenSSH client tools for SSH/SFTP and `ssh-copy-id`, and Python 3 for Linux UART modem-control operations. Admit explicit local key files, optional known-hosts overrides, UART paths, transfer paths, and custom script directories through `CLOUDX_ALLOWED_ROOTS`. Inventory inspection does not open the endpoint.

SSH defaults to **Current host user**. It uses the CloudX server account's inherited `SSH_AUTH_SOCK` and standard SSH identity files. The browser user's agent is not available to the server. No socket path is required. An explicit socket selects agent-only authentication. Choose **Identity file** to use an admitted private key.

Save a new machine once before setting up a key with a password. In **Edit hardware**, choose **Set up SSH key with password**, enter the one-time password, and select **Set up SSH key**. CloudX creates a dedicated Ed25519 identity, installs its public key with `ssh-copy-id`, and verifies key-only login. The password authorizes installation; it is not used to derive the key. After success, select **Save hardware** to use the verified identity. The private key stays on the CloudX host with owner-only permissions, under `secrets/hardware-ssh` in its data directory. This directory must be within the allowed roots.

New passwords are kept only in host-process memory, expire after 15 minutes, and are never written to the config secret file. Finishing a known key setup discards its temporary password. Restart loses temporary passwords. Existing saved login passwords remain readable until explicitly replaced. Saving key authentication removes the old password when no other item, acquired reservation, or unfinished hardware operation can still need it. The editor reports retained passwords and removal failures. It never displays a saved password.

No known-hosts path is required. SSH uses the host account's normal known-hosts files, saves a new host key on first connection, and rejects a changed key. Explicit file overrides still require an admitted regular file and strict checking.

## Edit and test SSH connections

Select a machine and choose **Edit hardware** to change its host or IP address, port, username, or authentication. An existing password-authenticated machine can use its saved password for key setup when the password field is blank. Entering a replacement stages a one-time password instead of saving a new login password. Complete key setup before saving password-mode connection edits.

For a saved machine, **Test connection** checks the current connection fields, including an unsaved IP address or replacement password. The test does not save the machine. Its result identifies the tested endpoint; changing the connection fields marks that result as outdated. Save a new machine before testing it. The test uses a temporary system-check hold and does not run reservation hooks or grant managed access. Connection edits and tests stay blocked while the resource is held. Use **Inspect hold** to inspect its owner and recovery state before releasing it.

Enabled SSH machines check login every 60 seconds by default. Change the interval in the editor, or disable **Enable automatic SSH login checks**. Checks pause while a physical alias is held, the machine is disabled, or local connection prerequisites are unavailable. **SSH login** reports the latest result and its freshness separately from reservation availability and custom statuses. A failed login can mean rejected authentication, an unreachable endpoint, or a host-key error; inspect the reason. It does not identify a wrong password by itself.

Login checks and custom status checks share time across the machine's physical aliases. The oldest due check runs first, so a short login interval does not prevent another alias's required status from becoming known. A socket connection error such as `ssh: connect to host blocked.example port 22: Permission denied` reports an unreachable server, rather than rejected credentials.

Login checks use bounded execution and close their local processes before clearing the check hold. An observed login failure with confirmed cleanup leaves the machine editable. Unconfirmed cleanup retains a recovery hold. A server restart clears the last login observation and preserves any unfinished check for recovery.

The separate **Register SSH key** action remains available under a user-owned active reservation before opening access. It installs current agent keys or a configured identity-file pair. It requires usable agent identities when no identity file is selected, even if ordinary host-user SSH can use a disk key. Registration does not change saved authentication. Use editor key setup when a password should install a dedicated key. `ssh-copy-id` skips keys that already work. A temporary registration password is discarded after the local operation and cleanup finish.

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

An SSH connection, authentication, or host-key rejection proven to occur before remote dispatch fails without a recovery hold. Inspect the saved receipt diagnostics for the client error. The reservation remains usable for another explicit operation after you fix the endpoint or trust configuration. Hardware does not retry automatically. If remote completion cannot be confirmed, the resource stays held for recovery; closing access does not settle those remote effects.

## Release and recover

Close access and release after the task, including known failure. Reservations permit broad task work; follow notes such as Do not reboot. Notes are agent guidance. Agents must release explicitly when done; an idle tab, completed turn, lost heartbeat, browser disconnect, or server detach does not release a reservation.

Closing the owning AI tab revokes its claims, including claims from earlier executions of that tab. CloudX cancels managed work, closes access, and runs any pending release hook. Successful cleanup clears the lock even when an earlier operation had an unknown outcome; that operation's receipt and history remain available. Failed or unconfirmed cleanup leaves a recovery hold for manual release. Forge workers retain their separate attempt lifecycle.

The Reservations view shows the owner tab's title and available workspace, plus the exact owner and generation in its details. **Open owner** reveals that existing tab, including a tab outside the current workspace or pane. It does not start a replacement execution. A missing tab is unavailable. Reopening a closed tab requires a new reservation and remains blocked while another owner holds the hardware.

The user can release a hold manually. Force release requires the current hold revision, a reason, and acknowledgement when external activity remains unresolved. A replacement execution cannot inherit the old claim.

## Inspect retained outcomes

Completed output and history have default bounds of 30 days and 10,000 entries; completed result payloads also share a 16 MiB budget. The panel shows applied retention settings and explicitly marks pruned output. Live and unknown receipts remain retained. The compact request identity and terminal outcome remain available so pruning cannot replay an old operation.

Hardware returns `CAPACITY_EXCEEDED` at 100,000 retained requests or when new work would consume space needed for saved outcomes or cleanup. Receipt inspection remains available. If ordinary cleanup cannot fit, automatic owner cleanup leaves a recovery hold. Inspect the hold and use Force release with explicit acknowledgement of unresolved activity. The store retains old request identities, including across restart; this version has no identity archival command.
