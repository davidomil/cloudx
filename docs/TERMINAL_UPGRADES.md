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
terminal IDs that remain live after web writers stop. Already-exited
shells keep their saved-tab recovery state and are excluded from the
live attachment requirement. After runtime identity verification, the
updater attaches to the exact captured IDs again and detaches; an
attachment failure prevents completion. This attachment probe sends no
input and never spawns, resizes, kills or terminates terminals.

The broker reports a retained exit before acknowledging attachment. Its
runtime receipt records that guarantee, so split socket delivery cannot
classify an already-exited shell as live. A running broker without that
capability requires a confirmed terminal migration before replacement.

The coordinator also retains the managed Settings integration when
building an older target. That integration includes update controls,
request validation, installation identity and runtime identity
reporting. It is built with the target’s dependencies before activation.
The transition record lists the integration files, and readiness
verifies the resulting artifact hashes. The installed Git revision
remains the selected target. Local edits that conflict with integration
files stop preparation.

Activation persists the effective data directory, installed checkout and
coordinator directory before startup. Settings continues to use the
retained coordinator after a downgrade, including for completion status
and the next update.

For recognized targets before Settings updates existed, the prepared
build adds the maintained Updates panel, server routes and shared
contracts. The panel fits the target's existing Settings categories or
sections. Starting an update waits for pending workspace writes and a
durable workspace save.

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
A failed resumable run offers Resume update for its saved target.
Selecting a different checked target also offers Start selected target.
The server permits a replacement run only before mutation or after
restoration completes. A run with incomplete restoration must resume its
original recovery first.

After a managed update is staged, use its retained CLI for status and
resume. This entry stays outside the checkout, including when an older
target has no updater script or the web service is down. The launch
output prints the full commands. Find the update ID in Settings, the
launch output, or ~/.local/state/cloudx/settings-update/latest.json.

``` bash
CLOUDX_UPDATE_ID="<update-id>"
CLOUDX_UPDATE_CLI="$HOME/.local/state/cloudx/settings-update/$CLOUDX_UPDATE_ID/coordinator/scripts/update-cloudx.mjs"
node "$CLOUDX_UPDATE_CLI" --checkout /path/to/cloudx --status
node "$CLOUDX_UPDATE_CLI" --checkout /path/to/cloudx --resume "$CLOUDX_UPDATE_ID"
```

These commands load the saved installation, target and coordinator
without downloading another launcher. Resume still checks service
ownership and the retained bundle before starting the coordinator. Later
update phases may require network access to prepare dependencies.

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

Selected downgrade snapshots record copy progress before replacing
active data. After a disk error or coordinator interruption, resolve the
reported blocker and resume the same update. Recovery restores the
previous profile before another activation attempt and still rejects
changed Forge ownership or publication records.

Checkout restoration writes each recovered file to a temporary file
before atomically replacing its destination. Resume recognizes
interrupted temporary writes while preserving conflicting operator
edits. The saved source revision, index, generated runtime and
configuration drive restoration together.

Automatic restoration rechecks Forge ownership after stopping writers.
If ownership or publication records changed since the snapshot,
restoration stops with the current records and runtime files intact. A
completed publication cannot become a publishable draft through
rollback. Preserve those records while resolving the reported recovery
blocker.

An absent Forge workflow store and a valid empty worker list represent
the same ownership state. Ordinary empty-store initialization does not
block rollback. Nonempty worker records and other Forge ownership files
still participate in the comparison.

Historical Forge integrations preserve validated review scope during
startup and shutdown. A historical review records its pinned head, base
and merge base, retains those Git objects, and saves the completed draft
and baseline together. Returning to a newer version can continue from
that completed comparison.

Recognized original single-review drafts inherit their saved worker
identity and start time when loading. Their publication receipts remain
unchanged. Rollback recognizes this identity conversion while continuing
to reject publication or ownership changes.

When a historical version kept separate review workers for the same
request, the next review uses the latest worker and its baseline. Its
context includes earlier review bodies and findings from every retained
worker for that repository and request.

These integrations keep ordinary metadata persistence from blocking
rollback. New reviews, publications and ownership changes still block
restoration that would rewind them. Preparation checks the saved review
scope and baseline against the target reader and writer contract;
inconsistent evidence stops the transition before activation.

Restoration stops brokers started by the failed transition, including
when the original broker was inactive or absent. Only the exact
preserved original broker invocation may remain running.

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

Targets before the terminal readiness endpoint use a maintained
lifecycle probe with the target’s own broker and direct terminal
factories. Standard services use the managed startup launcher to attest
prepared artifacts. Historical custom web services receive runtime
identity reporting through the retained update integration.

Historical readiness selects the probe for the target’s terminal spawn
contract. Targets before execution bindings use their factories’
supervised process ownership and cleanup. Both broker and direct probes
require the expected output, a successful exit and confirmed termination
before readiness succeeds.

Targets before persistent brokers use only their direct supervised
factory. Readiness requires the expected output, a successful exit and
confirmed termination. The broker service stays inactive while its
entry point is absent.

Recognized pre-broker targets receive a managed reader and writer
for version-1 saved sessions. Saved tabs keep their IDs, layout,
conversation evidence and inputs without requiring a previous snapshot
from that target. Terminal tabs remain stopped until explicit recovery;
commands and prompts are not replayed.

The historical recovery panel starts a new shell in the saved directory
or displays the validated preserved Codex conversation with a Resume
preserved conversation button. Codex recovery checks source ownership,
the saved receipt and transcript availability before enabling resume
and again before launching. A different conversation must be opened
explicitly in a new tab.

If Codex exits during startup, the same tab offers recovery again after
its supervisor confirms that the process tree stopped. Cleanup that
cannot be confirmed leaves recovery disabled and retains session
ownership. Retrying requires an explicit click and does not replay saved
prompts.

Session persistence also retains new tabs, closed tabs, active selection
and the current local-web URL across historical shutdown.

Regression fixtures build the actual pinned base
a9613fafdc0ed1765fcf72ea7d9f61de08c3914a, its predecessor
26d8291b89309acb59fdea1cbe09234d41d0164f, the target before Settings
channel selection 643ad8eb1c0ebe12cf4e112d72265fbe53814b65, and the target
before terminal execution bindings ad72433b2d6283811fad6bfe288748f2c24b0c5e.
They exercise supervised terminal creation and cleanup, existing-session
attachment, original profile paths, saved update completion and
initiation of the next update.

The matrix also includes 224a75ef7b3efced05b2c6b3b136250d9a532dc3,
before persistent terminal brokers, and CloudX 0.1.3 at
c664071e04091db6be78df09d8c91a1975e9313c, before Codex settings.
Both source fixtures verify direct process cleanup, a retained live shell
and the next Settings handoff. The 0.1.3 integration retains review draft
identities and Git evidence through its older Forge completion workflow.
An interrupted report cleanup resumes the saved completed draft without
launching another review.

Historical integrations must compile against the selected target’s APIs.
Schema checks recognize catalog, session and Forge review evidence
contracts; arbitrary historical or future converters are not implemented. These fixtures do
not establish a complete historical installation matrix or cover reboot,
power loss, disk exhaustion and network outages.

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
