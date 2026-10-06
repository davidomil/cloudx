# Automatic Forge retirement

Forge removes disposable checkouts and owned containers after authoritative
issue closure or merge and process quiescence. A completed review still protects
its workspace until the request is merged. Paused, failed and unfinished workers,
open batch issues and shared consumers remain protected.

There is no workspace cleanup menu, selection, trash workflow or cleanup shortcut
in Settings or Updates. Forge → Evidence is read-only: it lists saved reports and
Git history with manifest and file downloads. Retained installation backups are
still managed separately in Settings → Updates.

## Reports survive the checkout

Retirement uses the attempt recorded in the completion receipt, even after the
active attempt has ended. Named evidence and untracked report trees under
`.cloudx`, `test-results`, `playwright-report`, `coverage` and `debug_tooling` move
to private storage outside the disposable checkout. Automatic report selection
chooses untracked and ignored report subtrees and individual files disjoint from
tracked paths, including reports beside tracked documentation in the same root.
Tracked edits and uncommitted source outside report roots remain protected.
Dependencies and build descendants are excluded.

Each archive contains at most 256 MiB of regular files and 512 files. A completed
checkout can split up to 1 GiB and 4096 files into multiple archives; an individual
file cannot exceed 256 MiB. Metadata is limited to 1 MiB. Content streams in
64 KiB chunks. Named publication selections use the same bounded multiarchive
plan. Unknown links, special files, embedded repositories and changed evidence block
automatic retirement rather than being silently discarded.

Every archive and its ownership receipt must be durable before any selected
source file is removed. Manifests record worker, completion attempt, commit,
checkout identity, source paths, byte counts and SHA-256 checksums. Verification
checks contents, inventory and provenance, and synchronizes archive directory
names again after restart. Failed archive or receipt synchronization preserves
the checkout. A cleanup failure appears on its worker instead of becoming a
manual filesystem deletion workflow.

After partial archival, retirement discovers remaining automatic reports and
appends durable supplemental receipts with the original completion provenance.
Pending supplemental receipts survive restart without clearing the validated
original-removal marker. All recorded archives are exported and verified before
exact manifest-listed source files are unlinked.

The original named publication fingerprint remains required until the
original-removal marker is durably saved. After removal starts, missing old named
files do not block supplemental archival. New unknown files appearing after
export remain protected by the normal retention check; changed selected files
block unlink.

Checkout archives live under `forge-checkout-evidence/<archiveId>`; container
archives live under `forge-evidence/<resourceId>`. Container creation requires
specific evidence paths when evidence retention is requested. Legacy unnamed or
explicitly kept holds are not silently discarded.

## Generated Git history survives retirement

Forge-generated `refs/cloudx/before-rebase/<commit>` snapshots are preserved in
self-contained Git bundles under `forge-git-history/<archiveId>`. Before retiring
the checkout, Forge restores the exact refs into an empty repository and verifies
its objects. The bundle, provenance and ownership receipt are then synchronized
and checksum-verified. Arbitrary unpublished branches, stashes and other Git refs
remain protected; this is not authority to discard unpublished work.

Reviewer checkouts receive the same unpublished-ref checks as issue checkouts,
before and after capturing removal contents. The receipt-recorded review head
and comparison base are known comparison commits; mutable refs do not establish
that authority. A private branch, tag or stash remains protected even when HEAD
matches the reviewed commit and the report has already been archived.

Rewritten reviews can leave older head or base snapshots unreachable from the
current comparison. Exact `refs/cloudx/reviews/<head>/<base>/head` and `/base`
snapshots use the same verified bundle archive. The ref must resolve directly to
the commit embedded in its name; unpublished malformed, symbolic or retargeted
snapshots remain protected. Archiving a generated snapshot does not exempt a private
branch pointing to the same commit.

Download `history.bundle` from Forge → Evidence to recover a snapshot. For example,
after creating an empty repository, fetching the manifest-listed ref from the
bundle into a local branch restores it: `git fetch /path/to/history.bundle
refs/cloudx/before-rebase/<commit>:refs/heads/recovered`.

## Ownership remains authoritative

Automatic removal still revalidates checkout ownership, Git state, process
quiescence and directory identities. Container cleanup only removes exact
receipt-owned containers after all consumers close; images and shared volumes
are preserved. Ordinary repositories and developer worktrees are not part of
automatic Forge retirement.

Transient device numbers can change after reboot. Archive traversal compares
descendants with the opened checkout's current device only after validating its
durable filesystem identity. Generated dependency links are unlinked without
following their targets; unknown or escaping links remain protected. Regular
report files named `build` or `dist` are saved, not treated as directories.
