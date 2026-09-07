# State Invariants

These product and automation invariants help identify relevant risks and tests.
Check the affected boundary against current source; not every change touches
every invariant below.

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

## Automation

- Graph schemas and referenced hooks or triggers validate before a run is
  queued.
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
  durably claims one queued run per group before acknowledging the trigger.
- Python and Bash nodes are host execution. Relevant tests exercise adversarial
  paths, environment handling, timeouts, cancellation, and output bounds.

## Voice And ASR

- Each captured utterance has one queue identity and one terminal outcome.
- Stopping capture or removing its owner closes browser, server, and ASR stream
  resources.
- Transcript ordering follows accepted utterance identity, not callback timing.
- Audio, transcripts, and model diagnostics do not enter logs unless the user
  explicitly enables the documented diagnostic path.

## Documentation Archive

- Catalog metadata and on-disk artifacts commit as one logical import or expose
  a recoverable incomplete state.
- Rebuild, import, and invalidation do not silently discard the last usable
  archive.
- Extraction and enrichment enforce file, archive, page, frame, transcript,
  memory, time, and concurrency bounds before expensive work begins.
- Derived chunks, keyframes, transcripts, and metadata retain source and
  transformation provenance.

## Repository AI Automation

These apply when using the machine-managed interfaces, not as a required
contributor workflow.

- Issue text, comments, media, pull-request content, patches, model output,
  links, candidate-supplied instructions, and workflow artifacts
  are untrusted data.
- The public repository contains policy, schemas, role contracts, deterministic
  validators, and credential-free CI; it contains no private model session or
  privileged controller credential.
- A typed artifact is valid only for its declared subject, base, head, policy,
  role, schema version, and evidence. A later push makes earlier head-bound
  evidence stale.
- Candidate code cannot replace the verifier, publish its own trusted check, or
  gain a privileged repository token from the verification environment.
- Labels and prose are projections. They cannot satisfy a required check,
  weaken policy, or authorize a merge.
- Consumers of managed policy preserve its human-review and admission decisions;
  guidance changes do not implicitly waive executable authorization checks.
- Automated publication and merge use separate, least-privilege external
  identities. Merge readiness is revalidated against current GitHub state and
  the exact reviewed head immediately before the update request.
- The public ruleset is the authority for required checks and permitted updates
  to `main`; private deployment details cannot override it.
