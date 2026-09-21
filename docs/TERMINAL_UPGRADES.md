# Terminal upgrades and recovery

## Updates that preserve running terminals

CloudX pins the supervisor helper used by each running broker and web
process. Later compatible updates can rebuild the checkout while the
existing broker keeps its terminals. The updater verifies runtime
ownership before changing installed code and dependencies.

A running service without verified runtime ownership blocks an ordinary
update. Use the explicit migration below to replace a legacy runtime.
Broker replacement interrupts terminals; save active work first.

## First adoption from an older installation

Run the new updater from a temporary directory before changing the
installed checkout. An older updater can replace the helper before it
loads the new safeguards. From the installed repository root, stage the
scripts from the exact target commit:

``` bash
git fetch origin main
upgrade_commit=$(git rev-parse FETCH_HEAD)
upgrade_scripts=$(mktemp -d)
git archive "$upgrade_commit" scripts | tar -x -C "$upgrade_scripts"
node "$upgrade_scripts/scripts/install-cloudx.mjs" --checkout "$PWD" \
  --update --target-commit "$upgrade_commit" --migrate-terminals
```

The target commit must contain these upgrade safeguards. The installed
checkout must have no tracked changes; unrelated untracked files are
allowed. The migration flag requires an explicit
standard-service update; Settings and custom-service updates cannot
authorize this interruption.

## What migration preserves

Migration checks Forge ownership before stopping the web service. With
the web service stopped, it saves and verifies a private
terminal-recovery directory under the CloudX data directory. Only then
does it stop the broker. Stopping the web service first prevents broker
exit notifications from closing saved panels.

The snapshot contains exact workspace and session files, Forge workflow
and ownership records, per-tab Codex source and conversation receipts,
and the exact referenced transcripts. Its manifest records SHA-256
hashes and maps each original tab to its last observed conversation ID.
Backup files use mode 0600 and directories use mode 0700.

The snapshot rejects invalid saved layouts or session metadata, missing
or conflicting conversation identities, transcript mismatches, changed
sources, symlinks, oversized files, and write or verification failures.
If snapshot preparation fails after the web service stops, the broker
remains running and the checkout remains unchanged. Resolve the reported
condition before continuing.

## Recovery after interruption

Keep the existing tabs and layouts. Start each shell explicitly. In each
Codex tab, select the exact saved conversation you intend to resume. The
last observed receipt cannot prove the current native selection after an
idle /resume or /new. CloudX does not automatically replay saved shell
commands or AI prompts.

Active Forge workers, pending launches or Git operations, unresolved
publication, and missing ownership records block migration. Stop or
recover the worker through CloudX before updating. The updater preserves
ownership records and never invents completion evidence. Service
restarts alone do not prove an unrecorded worker ended.

Custom services require an operator-controlled interruption. Identify
their actual data directory, preserve the same recovery evidence, stop
the web service before its broker, and verify that both service control
groups are empty before running the custom-service update. A legacy
layout without saved session identities cannot be restored from its
layout backup alone.
