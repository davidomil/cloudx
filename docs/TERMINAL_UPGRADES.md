# Terminal upgrades and recovery

## Start a managed update

In Settings, choose Releases or Main, review the selected commit, then
start the update. Missing or stale runtime receipts are migration
inputs. If replacing a runtime will interrupt terminals, CloudX explains
the impact and requires confirmation in the same flow. Compatible pinned
brokers remain running.

The command line uses the same coordinator. Run from the installed
checkout, or supply its absolute path. The launcher returns an update
ID; launch acceptance is not update completion.

``` bash
node scripts/update-cloudx.mjs --checkout /path/to/cloudx \
  --target-commit "<40-character-commit>"

# Current installer entry point also hands off to the managed updater.
./install.sh --update
```

Interactive CLI confirmation requires typing yes. For unattended use,
pass `--non-interactive`; add `--confirm-interruption` only after
accepting the disclosed interruption. Without that consent, the update
remains pending. With no explicit target, a new CLI update selects the
current origin/main commit.

For a custom web service, also supply `--service`, `--port` and, when
needed, `--host`. Its EnvironmentFile must explicitly identify the data
directory. Settings initiates updates for the standard installed service
set.

## What the coordinator changes

Before downtime, the updater prepares the selected commit and its
dependencies in a separate release directory. It compares checkout
state, saved configuration and live runtime capabilities independently.
Tracked edits can remain when Git can carry them to the target;
unrelated untracked files remain in place. A conflicting path stops
preparation with diagnostics.

- Prepare: fetch the exact target, build dependencies and artifacts, and
  inspect recognized data contracts.
- Quiesce: verify the coordinator is outside affected service groups,
  check Forge ownership, and stop state writers. Interrupt incompatible
  terminals only with consent.
- Snapshot: verify private copies of persisted data, configured external
  documentation data, and service/configuration recovery records.
- Activate: change the checkout, retain previous generated artifacts,
  and point services at the prepared release.
- Start and verify: start affected services, check web/documentation/ASR
  readiness, create and clean up supervised terminals, and verify the
  selected running build and service invocation.

When a compatible broker stays running, the updater records saved user
terminal IDs that remain attachable after web writers stop. After
runtime identity verification, it attaches to those exact IDs again and
detaches; an attachment failure prevents completion. This probe sends no
terminal input and never spawns, resizes, kills or terminates terminals.

The coordinator is bundled into private update state and runs in its own
systemd user service. Browser or terminal disconnection does not cancel
it. Moving script files alone would not isolate a process: children
inherit their parent’s cgroup, and stopping a service can terminate
every process in that group. These rules come from the primary [Linux
cgroup
documentation](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#processes)
and [systemd termination
documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html#KillMode=).

## Older installations without managed handoff

Use the maintained recovery entry from an external desktop terminal or
SSH connection. It stages a current coordinator itself and preserves the
installed checkout argument. The installed repository is not advanced to
obtain updater scripts.

``` bash
curl -fsSL https://raw.githubusercontent.com/davidomil/cloudx/main/scripts/recover-cloudx.sh \
  | bash -s -- --checkout /path/to/cloudx --target-commit "<40-character-commit>"
```

This bootstrap requires Node.js, Git and network access. A download
failure leaves the installed checkout unchanged. After a run has been
staged, its saved target and recovery records drive resume; resuming
that run does not select a newer channel commit.

## Progress, failure and resume

Settings shows the phase, affected component, cause and recovery action.
A failed resumable run offers Resume update. The CLI provides the same
saved run, including after a service shutdown or reboot:

``` bash
node scripts/update-cloudx.mjs --checkout /path/to/cloudx --status
node scripts/update-cloudx.mjs --checkout /path/to/cloudx --resume "<update-id>"
```

Run records and private logs live under
`~/.local/state/cloudx/settings-update`. Each update directory retains
its coordinator, prepared release and data snapshots; previous generated
artifacts stay beside their original paths with a
`.cloudx-previous-<id>` suffix so activation works across filesystem
boundaries. Keep these directories: active service launchers or rollback
dependencies may still reference them.

A failed or interrupted mutation is restored before activation is
attempted again. When target startup has changed data, restoration first
retains those newer bytes separately. If restoration itself stops,
resolve its reported blocker and resume the same run. Avoid starting
another transition or deleting its recovery data.

## Terminal and data recovery

Disruptive terminal migration saves layouts, available session
identities, Forge ownership records and referenced Codex recovery
evidence before stopping the affected broker. Reopen shells explicitly
and select the exact intended Codex conversation. CloudX does not replay
saved commands or prompts or silently choose a conversation.

A legacy layout with no persisted session identities gets an explicit
warning: its layout can be retained, but its former in-memory tabs and
processes cannot be reconstructed. Empty or partial saved session
records, invalid ownership and transcript mismatches still block unsafe
replacement.

Active Forge workers, pending Git or launch operations, uncertain
publication and missing ownership evidence block disruption. Pause,
finish or recover that work in CloudX before continuing. A stopped
service is not proof that an unrecorded worker completed.

A downgrade must satisfy the target’s recognized persisted-data
contracts. If it cannot read active data, a verified compatible snapshot
is required. Settings discloses the selected snapshot and requires
separate data-restoration consent; the CLI accepts `--restore-snapshot`
with the offered update ID. Newer data is retained first, and restoring
session ownership requires terminal interruption consent too.

## Current support boundaries and validation

Supported targets must provide supervised terminal readiness; earlier
targets are rejected during preparation. Standard services use the
managed startup launcher to attest prepared artifacts, including targets
that lack `/api/runtime`; custom web services need their own runtime
identity endpoint. Schema checks recognize catalog and session
contracts; arbitrary historical or future converters are not
implemented.

Unknown schemas require a target with a supported reader or a verified
snapshot whose actual data passes the target compatibility checks.
Snapshot restoration refuses to rewind changed Forge ownership or
publication records.

Regression runs cover preserved local work, exact-target handoff and
resume, missing or stale runtime evidence, schema and snapshot
rejection, and configuration recovery. Isolated systemd tests ran on
Ubuntu 24.04 with systemd 255 and verified that a staged coordinator
survives owner shutdown and checkout replacement.

A separate fixture exercises the production updater through real Git,
npm and HTTPS. A receiptless update waits for consent before activating
the selected build. A failed target restores the prior build and profile
while retaining newer data.

The fixture readiness endpoint verifies real child-process creation and
cleanup. These isolated services do not establish a complete historical
installation matrix or validate a full CloudX deployment.

``` bash
npx vitest run scripts/install*.test.mjs scripts/managed*.test.mjs scripts/settings-update*.test.mjs scripts/terminal-upgrade-recovery.test.mjs scripts/update-cloudx.test.mjs scripts/write-runtime-build.test.mjs
npx vitest run apps/server/src/system/CloudxUpdateService.test.ts scripts/managed-runtime-launch.test.mjs scripts/managed-update-host.systemd.test.mjs scripts/managed-update-host.test.mjs
```
