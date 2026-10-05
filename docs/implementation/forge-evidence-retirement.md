# Forge cleanup and durable evidence

## Manage cleanup

Forge → Environments combines the filesystem cleanup inventory and
container evidence decisions. Settings → Workspaces opens all workspace
types. Settings → Updates opens the Forge, trash and container filter.
Retained update backups remain in Updates.

The application shares selection, cleanup jobs and busy state across
navigation. Returning to Updates refreshes capacity. A failed
cleanup-status request blocks cleanup and updates until the user
reconnects status in Environments. Ordinary checkouts and worktrees
remain explicitly labelled. Source discard and permanent deletion
require separate confirmations.

## Evidence handoff

After authoritative closure or merge and process quiescence, named
evidence moves to private storage outside the disposable checkout or
container. The manifest records worker, attempt and commit provenance,
selected paths, byte counts and SHA-256 checksums.

Exports stream to private files, flush their content and receipt, then
publish the archive directory atomically. Content, size, inventory and
provenance are verified before source removal. Verification synchronizes
the archive directory and its parents again after restart. A failed
directory sync keeps the disposable resource protected even when the
archive is visible.

Checkout archives live under `forge-checkout-evidence/<archiveId>`;
container archives live under `forge-evidence/<resourceId>`. Each
directory contains `manifest.json` and flat content files named from the
hash of their source path. Environments exposes manifest and
individual-file downloads after worker retirement. Existing verified
compact container archives remain readable.

## Bounded selections

Each export allows at most 256 MiB of regular file content and 512
files. Metadata is limited to 1 MiB. File content is processed in 64 KiB
chunks. Docker transport also has a 520 MiB tar limit, 8,192-entry limit
and 60-second process timeout.

Declare specific valuable ignored files or subtrees with
`retainedEvidencePaths`. Publication validates their existence,
directory identities, file types and storage bounds. Select a specific
report file inside a build tree instead of naming the entire build or
dependency directory. Generated descendants are excluded from a named
report subtree.

Only ignored, untracked `test-results/.last-run.json` with a recognized
Playwright report shape is automatically handed off. Unknown reports and
reproduction files remain protected until explicitly named or
deliberately discarded. Uncommitted source, unpublished Git refs and
explicitly kept container holds remain protected.

## Existing retained resources

In Environments, inspect the selected paths, commit and consumers before
exporting a legacy hold. Keep preserves the hold; Export verifies the
durable copy and releases the environment; Discard requires its explicit
permanent-evidence confirmation. A verified archive offers cleanup retry
without changing its provenance.

Filesystem cleanup still revalidates session activity, process activity,
directory identity and source protections. Unreadable same-user
processes stay uncertain unless they are the authoritative systemd user
manager or its verified PAM keeper in the exact `init.scope`. Readable
active cwd and open files always protect the candidate. An exited
process leader is skipped only after whole-group exit is established;
surviving or unknown threads keep the candidate protected.
