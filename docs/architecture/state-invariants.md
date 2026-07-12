# State Invariants

These are required design and review invariants. A change that cannot prove them
must remain blocked.

## General Ownership

1. Each persisted entity and long-running resource has one mutation authority.
2. Validate a transition before mutating memory or durable state.
3. Persist related state atomically or expose an explicit recoverable failure
   state; never report success for a partially applied transition.
4. IDs remain stable across persistence and reconnect. Deletion removes or
   deterministically reconciles every reference to the deleted ID.
5. A composition root owns startup and shutdown order; feature modules own their
   resources between those boundaries.

## Paths, Processes, And Secrets

- Every file, Git, worktree, upload, extraction, and process-cwd operation stays
  inside the configured allowed roots after canonicalization.
- Symlinks, archives, relative segments, and generated filenames cannot escape
  the owning root.
- Spawned processes have explicit environment, cwd, duration, output, and
  cancellation bounds. Cancellation terminates the owned process tree.
- Secret values never appear in public configuration, logs, notifications,
  browser state, or review artifacts.

## Workspace And UI

- Persisted workspace state is the server authority. Browser state is a
  projection plus explicitly local interaction state.
- A tab belongs to at most one pane. Removing a tab, pane, or window reconciles
  active IDs and layout references before persistence.
- Commands target the ID selected when the command was created; later selection
  changes cannot retarget an in-flight action.
- Subscriptions, timers, object URLs, terminal views, audio streams, and sockets
  are disposed when their owner unmounts or is removed.

## Deployment And Recovery

- A read-only Docker and Compose capability check runs before image, container,
  service, network, or volume mutation. Unsupported commands or options fail the
  operation; there is no compatibility fallback.
- Container authority uses full 64-character IDs. Deployment identity includes
  concrete network and volume names, immutable image IDs, static OCI revision
  labels, non-secret configuration, and secret fingerprints.
- PostgreSQL remains on major version 18. An in-place deployment may change only
  to an equal or newer minor image while preserving every non-image setting,
  exact named data volume, and network. It validates the live server version and
  complete migration ledger before manager replacement.
- Newly started manager or PostgreSQL containers retain `restart=no` until all
  final identity, data, migration, and readiness checks pass. Failure stops each
  uncommitted container and never retries the start.
- Backup, upgrade, and restore bind the same database dump, artifact archive,
  stopped manager, repository revision, immutable manager image, deployment
  identity, and seven-entry checksum manifest. Restore requires an empty target;
  rollback restores the prior co-consistent bundle rather than down-migrating.

## Automation

- Graph schemas and referenced hooks/triggers validate before a run is queued.
- Compile-time and runtime safety decisions use the same safety vocabulary.
- Run steps, duration, process output, loop counts, and concurrent work are
  bounded.
- A cancelled or restarted run has an explicit terminal state; it is never
  silently resumed as a different attempt.
- A polling producer persists its source checkpoint and ordered trigger outbox
  in one atomic state write before dispatch.
- A prepared outbox item becomes dispatching before emission. A
  crash-interrupted dispatch may replay only the same stable key; a controlled
  delivery failure becomes failed and requires explicit operator resolution.
- Automation derives a namespaced event identity from a plugin `eventId` and
  durably claims one queued run per group before acknowledging the trigger. If
  the claim cannot reach disk, acknowledgement fails.
- Python and Bash nodes are host execution. Changes to them are
  `human-required` and receive security review.

## ASR And Documentation

- ASR validates audio before inference, cleans temporary files on every exit,
  keeps model ownership explicit, and does not expose transcript text in logs
  unless the debug privacy setting explicitly permits it.
- Blocking model, media, extraction, and archive work does not run on an async
  request loop without an explicit worker boundary.
- Documentation import/export either commits a valid archive state or preserves
  the previous valid state. Failed extraction or index rebuild cannot publish a
  half-updated document.
- Uploaded, extracted, and generated artifacts remain bounded and path-safe.

## Repository AI Process

The authoritative transition implementation is
`scripts/ai-change/state-machine.mjs`.

- Planning, plan review, implementation, deterministic verification,
  implementation review, PR CI, PR AI review, and merge authorization are
  distinct states.
- Review findings and iteration ceilings block; they never grant progress.
- Verification is read-only. A changed worktree invalidates the verification.
- Every review and merge intent is bound to the current 40-character head SHA.
- A new implementation or PR head clears prior exact-head evidence.
- `trusted-auto-merge` is intent display, not authorization evidence.
- Only `$ship-change` may perform interactive or model-directed GitHub
  mutations. Trusted workflow controllers may perform their narrow,
  deterministic label, check, intent, and exact-head merge operations.

## Managed Issue Automation

- A webhook delivery ID is deduplicated for the configured terminal-retention
  horizon. The default is 90 days and the minimum is 30 days, both beyond GitHub
  Cloud's documented three-day redelivery window. A retained
  `abandon-delivery` audit is a permanent tombstone after raw-body compaction.
  One issue has at most one non-terminal managed run.
- Canonical issue text, comments, timeline, base SHA, and allowed media are
  content-addressed before model execution. An issue or base change supersedes
  evidence derived from the old snapshot.
- External-author work requires a writer-applied approval event strictly newer
  than the latest authoritative revision. Calculated current repository
  permission, not author association, decides writer authority. Read, triage,
  drive-by, and manager-authored comments are excluded from model context,
  media, and revision identity.
- Workflow dispatch is bound to one exact workflow definition, repository,
  issue, run, snapshot, and one-time capability. Only run attempt 1 can consume
  secrets or write authority.
- Every fresh reviewer produces its own subject-bound artifact. The trusted
  controller recomputes the required reviewer set and fails closed when any
  role, digest, or classification is absent or different.
- Every model job runs as the non-root `cloudx-codex` service account on the one
  dedicated self-hosted model runner. Direct `codex exec` reuses file-backed
  ChatGPT account authentication; no API-key path exists. Exact audited
  profiles expose minimal runtime paths, temporary files, and workspace read
  access, with workspace write access only for bounded reproduction. The
  implementation model has no shell tool and cannot apply or execute its
  proposal. Generated code runs only in the credential-free verifier. The
  verifier supervisor owns its
  attestation path, drops candidate commands to an unprivileged identity,
  runs with an init process that reaps descendants, gives every command an
  explicit timeout and output ceiling, owns a detached POSIX process group,
  applies bounded TERM/KILL cleanup, hashes source only after the process tree
  stops, and stops on the first mutation.
- The Manager App can read repository state, project issue state, and dispatch
  workflows. Its host never receives the Publisher App key.
- The Candidate Publisher App can create candidate branches, pull requests,
  labels, and provenance checks but cannot bypass protection on `main`. Its
  token never reaches generated code or the manager host.
- The Merge Authority App can publish automation intent and perform exact-head
  merges but cannot publish candidate code. Its key is available only to
  SHA-bound merge controllers.
- Any managed fingerprint, including App author, branch prefix, body marker, or
  generated label, selects the managed merge path. Removing a label cannot
  downgrade a managed PR to maintainer intent.
- A successful workflow process exit is not merge authorization. The manager
  advances only from a typed terminal result bound to the registered workflow
  run and confirmed current PR state.
- Managed live source authorization executes inside the deterministic exact
  merge controller after the final main/PR identity read and immediately before
  its sole SHA-bound merge request. A rejected authorization causes no merge
  request or `main` update. Only this controller briefly holds both the manager
  result token and scoped Merge Authority App token; model and candidate code
  receive neither.
- Snapshot, media, and stage bytes reserve repository and global capacity
  before no-overwrite publication. Known failures delete only newly created,
  locked-and-unreferenced content. Unknown commit outcomes retain bytes for the
  bounded orphan scanner.
- Active-work capacity is keyed by run. A new canonical revision excludes the
  same issue's replaceable managed-run slot so it can reach supersession, but
  processing, registration-ambiguous, and dispatched workflows retain their
  external-execution lease. Saturation persists a non-active blocked admission
  and cannot dispatch another workflow.
- Operator recovery mutates only one exact dispatch-registration,
  workflow-completion, or issue-projection target listed by read-only
  inspection. The request binds target ID, run ID, complete state digest,
  sanitized workflow correlation when present, stable operation ID, and
  evidence note. Completion recovery applies the normal lifecycle, releases
  the external lease, projects status, and records its audit in one
  transaction. A recurrence requires a new inspection and operation ID. No
  automatic privileged mutation retry exists.
- The active `main` ruleset permits updates only through the Merge Authority App and
  binds required checks to their expected Apps. Without that live rule, the
  automated merge system is not activated.
- Activation also requires the immutable controller tag to resolve to an
  independently supplied audited commit SHA. Tag immutability alone is not
  controller provenance.
