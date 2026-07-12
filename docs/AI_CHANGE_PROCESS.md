# AI Change Process

## Goal

CloudX uses repository-resident engineering automation for two entry paths:

- a signed GitHub issue can produce a bounded, reviewed pull request through the
  external AI manager; and
- an ordinary pull request can receive deterministic classification, isolated
  area reviews, a fresh aggregate review, and exact-head merge evaluation.

The system is not implemented inside the CloudX server or web application.
CloudX publicly owns instructions, skills, schemas, policy, classification, and
credential-free CI. The private `cloudx-ai-manager` repository owns the durable
manager, model runner, publisher and merge controllers, deployment, and
credentials.

## Normative Authorities

| Concern                                                         | Authority                                              |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| Module ownership and trust boundaries                           | `AGENTS.md` and `docs/architecture/`                   |
| Classification, reviewer selection, risk, and merge eligibility | `.agents/pr-review-policy.toml`                        |
| Typed handoffs                                                  | `.agents/schemas/*.schema.json`                        |
| Local change state                                              | `scripts/ai-change/state-machine.mjs`                  |
| Artifact semantics                                              | `scripts/ai-change/artifact-validation.mjs`            |
| Managed run and stage state                                     | Private manager PostgreSQL repositories and migrations |
| Exact CI, review, and intent identity                           | Private controller `check-identity.mjs`                |
| Merge readiness                                                 | Private controller `merge-readiness.mjs`               |
| Main update                                                     | Private controller under the Merge Authority App       |
| Repository activation                                           | Private controller activation verifier                 |

The machine policy is normative. Labels and prose summarize state; they cannot
weaken policy, satisfy a typed artifact, replace a current check, or authorize a
merge.

## Roles

| Role                              | Skill or controller                  | Authority                                              |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Orchestrator                      | `$change-orchestrator`               | Route work and typed artifacts                         |
| Issue triager                     | `$triage-issue`                      | Classify one immutable issue snapshot                  |
| Triage reviewer                   | `$review-issue-triage`               | Review classification in a fresh context               |
| Planner                           | `$plan-change`                       | Write a plan artifact                                  |
| Plan reviewer                     | `$review-plan`                       | Review the plan in a fresh context                     |
| Reproducer                        | `$reproduce-issue`                   | Establish a discriminating baseline                    |
| Patch synthesizer                 | `$implement-change`                  | Propose one bounded patch for accepted paths           |
| Verifier                          | `$verify-change`                     | Run deterministic read-only proof                      |
| Area reviewers                    | Policy-selected finite review skills | Write exact-subject findings only                      |
| Aggregate implementation reviewer | `$review-change`                     | Reconcile every managed area finding                   |
| Aggregate PR reviewer             | `$review-pr`                         | Reconcile every ordinary-PR area finding               |
| Candidate publisher               | Candidate Publisher App controller   | Publish a validated branch, PR, labels, and provenance |
| Interactive shipper               | `$ship-change`                       | Authorized attended GitHub mutations                   |
| Merge controller                  | Merge Authority App controller       | One policy-gated exact-head squash request             |

Every judgment role runs in a fresh context. A reviewer receives trusted
instructions, the original task, a bounded typed subject, repository source,
the current diff, and test evidence. It does not inherit the conversation that
created the subject.

Every model job runs on the single dedicated `cloudx-codex` self-hosted runner
as its non-root service account. The local action invokes the pinned Codex CLI
directly and reuses that account's file-backed ChatGPT login. The audited Codex
profiles expose only minimal runtime paths, temporary files, and the workspace;
only bounded reproduction receives workspace write authority. Implementation
synthesis disables `shell_tool` and emits a proposal without trusted byte or
digest claims. Trusted code captures the patch; only the credential-free
no-network verifier applies or executes candidate code.

This is Phase-inspired rather than behaviorally identical. One immutable issue
revision receives one logged-in model workflow attempt and one bounded
synthesis-review sequence. A finding or changed requirement starts from a new
canonical issue revision and durable run instead of opening an unbounded
model repair loop.

## Managed Issue Intake

1. `POST /webhooks/github/target` verifies the exact raw body with HMAC-SHA256 and
   durably inserts the GitHub delivery identity before returning `202`.
2. The Manager App fetches the current repository, issue, all comments,
   timeline, author permission, approval-label actor permission, current `main`
   SHA, and policy bytes from GitHub.
3. A current `write`, `maintain`, or `admin` author is admitted. Another author
   requires `ai:issue-approved` from an actor who still has one of those
   permissions. That label event must be strictly newer than the latest issue
   edit or authoritative comment update; retained stale approval blocks.
4. Issue-author comments and comments from actors whose calculated current
   repository permission is `write`, `maintain`, or `admin` are authoritative
   for the semantic source revision. Association is descriptive only. Drive-by
   and manager-authored comments are excluded from the model-visible snapshot,
   revision digest, and media set.
5. Public GitHub-hosted media is downloaded through an HTTPS host/path allowlist
   with redirect, time, count, byte, MIME, and detected-file-type limits.
   Private-repository attachments are rejected until an installation-token
   contract is proven.
6. Two complete canonical reads around bounded media download must produce the
   same URL-level issue document revision. Source revision schema v2 then binds
   every accepted media URL to the downloaded SHA-256, MIME type, and byte
   count. Merge authorization repeats both reads and downloads and requires the
   same v2 revision before consuming the one-time capability. Capacity is
   reserved before snapshot and media persistence.
7. PostgreSQL opens or deduplicates one run and dispatches the workflow at the
   immutable controller tag and exact controller SHA with one-time
   capabilities.

Issue text, comments, media, patches, model output, workflow artifacts, and PR
content remain untrusted data. They never become controller instructions.

## Managed Stage Chain

The managed workflow reports eight content-addressed artifacts to
`POST /v1/workflow-stages` under the result token:

| Order | Stage                   | Durable transition                        |
| ----- | ----------------------- | ----------------------------------------- |
| 1     | `triage`                | `ingested -> triaged`                     |
| 2     | `triage-review`         | `triaged -> triage_review_clean`          |
| 3     | `plan`                  | `triage_review_clean -> planned`          |
| 4     | `plan-review`           | `planned -> plan_review_clean`            |
| 5     | `reproduction`          | `plan_review_clean -> reproduced`         |
| 6     | `implementation`        | `reproduced -> implemented`               |
| 7     | `verification`          | `implemented -> verified`                 |
| 8     | `implementation-review` | `verified -> implementation_review_clean` |

Each callback binds the run, workflow run and attempt, workflow SHA, repository,
issue, base, head, snapshot, policy, expected run version, artifact schema,
artifact digest and size, and subject digest. The manager validates the exact
envelope, artifact bytes, schema, semantic verdict, capacity, current run, and
one-step CAS transition before accepting it.

Snapshot, media, and stage artifacts publish through no-overwrite writes while
the content-capacity authority is held. Known failures delete only newly
created content after a locked reference check. An uncertain database commit
retains the bytes for the bounded orphan inventory rather than risking deletion
of committed evidence.

An accepted stage creates a comment-only issue discussion projection with the
artifact and subject digests. Stage comments do not reconcile labels. Later
run-state projections own the complete manager label set.

The terminal managed result is invalid until all eight rows and exact artifact
digests exist in order. Triage through implementation bind to the generation
base; verification and implementation review bind to the candidate head.

## Static Area Review

Both managed generation and ordinary PR review select from the same finite set:

`review-agent-policy`, `review-architecture`, `review-automation`,
`review-documentation`, `review-installer`, `review-plugin-api`,
`review-python-services`, `review-security`, `review-server`, `review-shared`,
and `review-web`.

The workflows declare 11 explicit conditional jobs. They do not let model output
create a dynamic reviewer matrix.

### Managed Generation

The verified candidate metadata supplies the selected skills and remains bound
to the accepted triage digest. Every selected area job must succeed with one
schema-valid implementation review. Every unselected job must be skipped. A
canonical manifest records exact role coverage, artifact digests, verdicts,
durable tags, and findings. A fresh `review-change` context aggregates that
manifest.

### Ordinary Pull Requests

The target App sends public pull-request events to the manager. The manager
dispatches the private controller with exact base and head identities.
`prepare-review.mjs` reads the public target without checking out or executing
the PR head, computes actual changed paths and policy classification, and seals
the bounded review subject. `pr-review-fanout.mjs` emits one boolean for each
finite role. No public event can select the logged-in runner.

Capture requires selected-job success and unselected-job skip. It rejects
unknown, missing, duplicate, non-file, noncanonical, wrong-role, and stale
artifacts before sealing `area-review-manifest.json`. A fresh `review-pr`
context aggregates that exact bundle.

### Aggregate Invariant

An aggregate must preserve the complete area-finding multiset and the union of
all area-review tags. It cannot remove a finding, discard `manual-review`, or
turn any blocked area verdict into `clean`. The trusted publisher repeats
manifest, artifact, aggregate, and live identity validation before publishing
`AI Review / head`.

## Typed Artifacts

The repository schemas bind every handoff to its exact subject:

- plans bind task, base, policy, skills, classification, source anchors,
  behavioral claims, allowed paths, forbidden paths, and proof commands;
- reviews bind run, subject type and digest, base, head, policy, reviewer role,
  verdict, durable disposition tags, and stable findings;
- implementations bind the accepted plan, changed paths, production evidence,
  revert-failing assertions, negative cases, and deviations;
- model patch proposals contain no claimed execution result or model-computed
  digest; trusted capture computes exact UTF-8 bytes and SHA-256 before the
  implementation artifact exists;
- verification binds exact commands, exit codes, output digests, and a chained
  before/after source digest for every command; source mutation stops the
  remaining gates;
- managed snapshots, triage, plans, reproduction, implementation, provenance,
  dispatch, stages, outcomes, results, and merge authorization use separate
  strict schemas; and
- merge intent records authorization for one complete current identity. It is
  intent, not readiness proof.

Any material deviation requires replanning and fresh review. A schema error,
unknown field, missing artifact, stale digest, or ambiguous identity blocks the
transition.

## Exact Check Identity

Canonical v2 check IDs bind:

```text
pull request + base SHA + head SHA + GitHub test-merge SHA
+ test-merge tree SHA + policy SHA-256 + kind-specific qualifier
```

`CI / merge-gate` has no qualifier. `AI Review / head` adds the bounded review
subject digest and the exact `manual:required` or `manual:not-required`
disposition. Ordinary and protected intent add the current writer actor. Managed
intent adds the exact managed evidence digest.

The test-merge commit must have exactly two ordered parents: bound base first
and bound head second. The manager accepts the current CI and review only from
the configured Candidate Publisher App and requires both checks to name the
same test-merge commit and tree before dispatching managed automerge.

## GitHub Controllers

CloudX owns only `classify-pr.yml` and `ci.yml`. Every workflow named below
other than those two exists only in the private controller repository and is
`workflow_dispatch`-only.

- `classify-pr.yml` loads policy from trusted controller source, classifies both
  sides of renames, and reconciles manager-owned labels. Labels are projections,
  not authority.
- `ci.yml` executes untrusted PR code without write credentials. The target App
  observes completion and dispatches private `publish-ci.yml`, which validates
  its exact identity artifact and publishes
  `CI / merge-gate` through a short-lived Candidate Publisher App token.
- `managed-issue.yml` runs the eight managed stages, 11 explicit conditional
  area reviews, fresh aggregation, capability-free patch synthesis,
  credential-free patch application and verification, and trusted candidate
  publication. Trusted capture recomputes the selected skill and patch digests.
  Publication accepts every configured risk tier, including human-required
  candidates, but managed automerge accepts only low and medium risk.
- `ai-review.yml` checks out the private controller at its immutable release and
  public target source at the exact manager-observed base, never a PR head.
  It runs the 11 explicit conditional area reviews and fresh `review-pr`
  aggregation, then publishes through a short-lived Candidate Publisher App
  token.
- `managed-automerge.yml` passes manager-dispatched current-run identity to the
  trusted exact merge controller. That controller consumes one-time live issue
  authorization only after its final main and PR identity read and immediately
  before its sole SHA-bound merge request.
- `trusted-automerge.yml` binds current writer intent to one ordinary PR
  identity.
- `protected-merge.yml` accepts attended expected base and head inputs and uses
  `cloudx-protected-merge` for required human authorization.

Model jobs do not receive an environment secret. They run only on the dedicated
`cloudx-codex` runner and reuse its persistent ChatGPT login. Controller jobs
that need manager, publisher, or merge credentials run under
`cloudx-controller`, which is restricted to trusted controller refs. Protected
manual merge uses its separate environment and only the Merge App key.
Repository secrets are not a credential authority.

## Logged-In Codex Runner

Activation requires a private controller repository and exactly one online self-hosted
runner carrying `self-hosted`, `Linux`, `X64`, and `cloudx-codex`. The runner
service executes as the non-root `cloudx-codex` account with no passwordless
sudo. Its persistent `CODEX_HOME` is `/home/cloudx-codex/.codex` with directory
mode `0700`; `auth.json` and `config.toml` are owned by the account with mode
`0600`.

Install exactly `codex-cli 0.144.1`, copy
`.github/codex/runner-config.toml` byte-for-byte to the persistent Codex home,
and log in interactively with `codex login --device-auth`. The local action
fails unless `codex login status` reports ChatGPT account authentication, the
refresh token is present, the configuration and CLI version are exact, and the
actor is a trusted CloudX App or a current repository writer. A directory lock
also rejects concurrent local sessions; the single matching runner serializes
workflow jobs so refreshed account state is never shared concurrently.

This deliberately has no API-key or ephemeral-login compatibility path. The
account credential remains on the runner host and is removed from the Codex
child environment surface except through `CODEX_HOME`. Never register this
runner with a public repository: forked pull requests can execute workflow code
on a public self-hosted runner.

OpenAI documents this account-auth pattern only for trusted private automation
and says not to use it for public or open-source repositories. The private
controller removes public runner eligibility but does not make a public CloudX
target officially supported. Production setup therefore requires explicit
`AI_MANAGER_ACCOUNT_AUTH_RISK_ACCEPTED=true` and should not proceed without an
owner accepting that residual support and credential risk.

## Merge Routes

### Managed

The manager observes exact Candidate-Publisher-origin CI and AI review checks,
correlates their test-merge commit and tree, and dispatches managed automerge.
The trusted controller evaluates readiness twice and performs a final main and
PR identity read. It then asks the manager to reread the live issue, current
writer approval, and source revision v2, including bounded redownload and digest
verification for each accepted media item, and consume the run's one-time merge
capability. This authorization call is inside the exact merge controller and
immediately precedes the sole SHA-bound Merge Authority App request. A stale or
rejected authorization makes no merge request or `main` update. Model and
candidate code receive neither the manager result token nor the Merge App token.

### Ordinary

A current repository writer applies `trusted-auto-merge` or dispatches the
trusted intent workflow. The resulting intent check binds that actor and the
complete v2 identity. Fork heads and policy-protected paths are ineligible.

### Human-Required

Human-required paths cannot use either automated route. The same is true when
an exact-head review carries `manual-review` or the live PR has the exact
`manual review` label. Removing the label cannot erase the disposition bound in
`AI Review / head`. An operator dispatches
`protected-merge.yml` with the exact approved base and head. The
`cloudx-protected-merge` environment requires a reviewer, prevents self review,
disables administrator bypass, and restricts deployment to `main`.

### Shared Actuation

All merge-capable jobs acquire the repository-wide `cloudx-main-merge-v1`
concurrency group with queued, non-cancelling semantics. After acquisition, the
controller:

1. evaluates current policy, classification, checks, review, conversations,
   provenance, approval, and intent;
2. repeats the full evaluation;
3. rereads `main` and the PR identity at the final actuation boundary;
4. rechecks current intent and actor permission when applicable;
5. for the managed route, consumes live manager source authorization
   immediately before merge;
6. sends one squash merge request with the exact head SHA; and
7. confirms the Merge App actor, merged PR, `main` ref, single exact base parent,
   and resulting tree equal to the tested merge tree.

There is no merge retry after a moved head, moved base, conflict, refusal, or
post-merge mismatch.

## Repository Enforcement

The activation verifier requires three active repository rulesets:

- `CloudX main update authority` grants only the Merge Authority App a
  pull-request-only bypass for main updates;
- `CloudX main integrity` has no bypass and requires squash-only pull requests,
  linear history, stale review dismissal, CODEOWNER review, resolved threads,
  and strict App-bound current checks; and
- `CloudX controller tag immutability` permits no update or deletion bypass for
  `cloudx-ai-controller-v1`.

Activation additionally requires a public CloudX target, a separate private
controller repository, exactly one online runner there with the exact
model-runner labels, and `CLOUDX_EXPECTED_CONTROLLER_SHA` from an independently
reviewed release. The immutable private-controller tag must peel to that exact
commit; a missing or mismatched audited SHA blocks activation.

The verifier also requires exact Apps, environments, workflows, variables,
secret-name inventories, Actions allowlist and SHA pinning, model-job runner
labels, read-only default workflow permissions, CODEOWNERS, merge modes, and
absence of legacy branch protection or background merge mechanisms.
`.agents/pr-review-policy.toml` remains the machine authority for those exact
values.

## Invalidation And Failure

- An authoritative issue revision or media change supersedes dependent managed
  evidence.
- A push to `main` supersedes runs bound to an old base and triggers canonical
  recapture.
- A managed PR head change supersedes the run. A close without merge cancels it.
- A PR head, base, test-merge commit, test tree, policy, subject, or current
  writer change invalidates the corresponding check or intent.
- A failed stage, selected reviewer, schema, deterministic command, capacity
  reservation, or publication produces an explicit blocked or failed state.
- Managed check observations are monotonic by completion time. Strictly older
  deliveries cannot replace newer authority. Equal-time distinct check-run IDs,
  or contradictory authority for the same check-run ID, become one canonical
  ambiguous observation and fail closed.
- Workflow run attempt 1 is the only privileged attempt. Reruns do not recover
  a privileged mutation.
- Ambiguous dispatch and database commit outcomes remain explicit. Operators
  inspect durable state rather than retrying blindly.
- Read-only `inspect` returns only current action-specific targets and a SHA-256
  over each target's complete state. It does not expose a dispatch capability or
  failed webhook body.
- `confirm-no-workflow` resolves one `awaiting_registration` dispatch only after
  the operator proves that its exact workflow identity created no GitHub run.
- `confirm-workflow-completed` resolves one registered workflow only from the
  exact completed GitHub run identity and terminal result.
- `requeue-projection` requeues one failed issue-discussion projection after its
  write precondition is corrected.
- `requeue-delivery` requeues one failed signed delivery without changing its
  delivery ID, raw bytes, or payload digest.
- `abandon-delivery` terminalizes one failed delivery that is permanently unsafe
  to replay while retaining its failure and signed-payload evidence.

Those five actions are the only database-only recovery mutations. Each requires
the exact target identity, complete-state SHA-256 from the latest inspection, a
new stable operation ID, and a bounded evidence note. Each mutation and its
operation-keyed audit record commit in one transaction. Conflicting reuse of an
operation ID fails closed. Exact commands and external proof requirements are in
`docs/AI_MANAGER_OPERATIONS.md`.

Terminal raw snapshots, media references, and stage bytes are compacted after
retention under bounded cleanup. Run events, workflow results, stage identity,
artifact digests, sizes, subject digests, and compaction timestamps remain
auditable. Raw delivery identity is retained for the configured terminal
retention: 90 days by default and never below 30 days, beyond GitHub Cloud's
documented three-day redelivery window. An abandoned webhook payload row
compacts only after retention and only when its retained operator audit matches
the payload identity, all three timestamps, and failure. The audit remains as a
permanent admission tombstone while the stored-item and byte budgets are
released.

## Deployment And Activation

The supported manager topology is one active process, one PostgreSQL database,
and one content-addressed volume behind a loopback-published TLS proxy.
Before any deployment mutation, the lifecycle proves a reachable Docker Engine,
Compose, and every capability that would otherwise first be exercised after
mutation. The validated baseline is Docker Engine 29.4.3 and Compose 5.1.3;
capability discovery, rather than a version fallback, is authoritative.
PostgreSQL uses the immutable current 18.4 Bookworm image.
`deploy.sh initialize` requires an exact empty Compose target. `backup.sh`
cleanly stops the manager and leaves it stopped; its seven checksummed payload
files plus `SHA256SUMS` include the exact stopped-container identity.
`deploy.sh upgrade` accepts only that bundle with an unchanged project, secrets,
concrete networks and volumes, manager storage, non-image PostgreSQL
configuration, and a descendant repository revision. It may replace PostgreSQL
only for a non-downgrading minor update within major 18, then proves the live
server version and all 12 migration records before replacing the manager. Restore
refuses target containers, volumes, and networks before image mutation. Each
path starts required services with restart disabled and commits restart policy
only after final identity or readiness. A later failure stops each uncommitted
service. There is no retry or force recreation. Schema migrations are numbered,
bounded, transactionally applied, and digest checked. Migration 010 explicitly terminalizes active
pre-010 runs that depend on check observations without check-run identity.
Pre-v2 source revisions require a new canonical attempt; no compatibility
interpretation is provided. Rollback restores the co-consistent prior image,
database dump, and artifact archive; there is no down-migration path.

The local implementation is not the same as live activation. CloudX remains
public. Activation stays blocked until the controller repository is private,
the dedicated logged-in Codex runner is registered only there, both repositories
match the exact App/ruleset contract, the account-auth risk is accepted, and the
private activation verifier returns zero blockers. The private repository owns
the setup, operations, backup, recovery, and disposable-repository proof.

Do not use an extra smoke-hold required check. The repository contract requires
the exact App-bound `CI / merge-gate` and `AI Review / head` inventory. Prove
fail-closed behavior by moving base or head and observing stale evidence
rejection, then allow one small disposable eligible change to complete the
confirmed exact merge path.

Private attachment support remains unproven and disabled.

## Design Basis

- The pinned Phase contribution skill is primary upstream evidence for fresh
  roles, architecture review, verification, adversarial review, and shipping
  discipline.
- Current repository source, schemas, migrations, and tests are primary evidence
  for CloudX behavior.
- Official GitHub documentation is authoritative for webhook HMAC, App
  authentication, private self-hosted runner safety, rulesets, environments,
  concurrency, checks, and SHA-bound pull request merges.
- Official OpenAI Codex authentication, noninteractive execution, CI/CD account
  authentication, and permissions documentation is authoritative for the
  persistent ChatGPT login, refresh behavior, serialized runner requirement,
  direct `codex exec`, and filesystem profiles.
- Official Docker and PostgreSQL documentation is authoritative for Compose
  secrets and logical backup/restore behavior.
- No anecdotal source is used as an architectural authority.
