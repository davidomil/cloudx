---
name: "change-orchestrator"
description: "Orchestrate a CloudX change through classification, isolated planning, implementation, verification, review, and an optional ship handoff."
---

# Change Orchestrator

## Responsibility

Route one change through the repository state machine. Do not plan, implement,
verify, review, or mutate GitHub in the orchestrator context.

## Inputs

- Original task and current worktree/base SHA.
- Root and scoped `AGENTS.md` files.
- `.agents/pr-review-policy.toml` classification.
- Current typed artifacts and finding IDs, if resuming.

## Workflow

1. Classify exact proposed paths and type through `scripts/ai-change/policy.mjs`.
2. Start a fresh `$plan-change` context and validate its output against
   `.agents/schemas/plan.schema.json`.
3. Start a different fresh `$review-plan` context. A blocked review returns to a
   new planner; a review ceiling transitions to `blocked`.
4. Dispatch `$implement-change` only after a clean plan review.
5. Dispatch `$verify-change`. Verification cannot edit or fix the worktree.
6. Start fresh contexts for every reviewer selected by policy. Give each only
   the task, trusted instructions, accepted plan, implementation artifact,
   current diff, and verification artifact.
7. Dispatch `$review-change` to reconcile the exact-head findings. Findings
   return to a fresh implementer, followed by full verification and review.
8. Follow Publication Contract V1 below after the exact local gate is clean.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 limits this role to ordered, isolated dispatch.

The immutable identities remain distinct: `localChangeBaseSha=7f5693b568f38c207227a5473f14648fd10d4816`, `planningHeadSha=3a5c05272bd4a30bc7646aa710a0807ca85a088b`, `candidateHeadSha=validatedImplementationHeadSha`, `expectedOldCandidateSha=7f5693b568f38c207227a5473f14648fd10d4816`, `targetBaseRef=refs/heads/main`, `expectedTargetBaseSha=02d05f798096431f23acd1e5594a6bee21f3149f`, `repository=davidomil/cloudx`, `pullRequest=1`, `prState=OPEN`, `prBaseRefName=main`, `prBaseRefOid=02d05f798096431f23acd1e5594a6bee21f3149f`, `prHeadRefName=architecture-and-new-codex`, `prHeadRefOid=expectedOldCandidateSha`, and `sameRepository=true`.

Initial publication requires a nonsecret
`.agents/schemas/publication-authorization.schema.json` object with recursively
sorted keys, two-space indentation, and one final LF. Its regular nonsymlink
file is at most 32 KiB, outside the artifact directory, private runtime evidence,
and is not committed controller state. `--authorization-file` and
`--authorized-publication-sha256` bind those bytes independently from the
`--authorized-manifest-sha256` bundle digest. A grant lasts at most 15 minutes,
binds the complete identity tuple, policy, bundle, mode, principal, and nonce,
and selects exactly `automated-app` or `attended-user`. The sole secret input is
`CLOUDX_GATE_B_TOKEN`; it is never serialized or durably persisted.

1. Require the candidate-bound accepted plan and implementation, deterministic
   verification, all policy-selected area reviews, and clean aggregate review.
2. Record explicit authorization for both immutable digests and the complete
   identity tuple above, then dispatch `$ship-change` with the sole
   `publish-gate-b.mjs` entry point and exact arguments:
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode <automated-app|attended-user> --expected-old-head <sha>`.
   The orchestrator never runs a publication command or performs another GitHub
   mutation.
3. The publisher validates authorization before secret read or command
   execution, pins the secret to child `GH_TOKEN`, disables ambient credentials
   and prompts, revalidates immediately before publication, and performs at most
   one exact expected-old
   `--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
   update. No ordinary push, general force, retry, rollback, or alternate path is
   authorized.
4. Before the push, every failure starts zero publication commands. After the
   sole push starts, every error or identity ambiguity produces
   `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and
   `reviewPrHandoff=false`; the run stops for explicit reconciliation.
5. Require authoritative remote-ref, base, and pull-request readback before
   dispatching `$review-pr` for the pushed live head. Never dispatch it after a
   rejection or manual-reconciliation result.
6. Dispatch `$ship-change` for a later mutation only with a current clean
   `$review-pr`. A later push stales that review; merge also requires current
   merge intent and required checks. Human-required paths remain human reviewed,
   no automerge is authorized, and the initial exception is never reused.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

The private AI manager owns durable lifecycle transitions. This public skill
produces schema-valid artifacts and exact-head evidence for that manager; it
never infers a later state from prose. An iteration cap, missing reviewer, stale
SHA, schema error, or failed command blocks the run and never permits a bypass.

## Output

Return the current state, artifact paths/digests, finding IDs, exact commands
run, and the next valid action. Do not produce a substitute artifact in prose.

## Prohibitions

- No author self-review or reused author conversation.
- No code edits, commits, or repository-hosting changes.
- No partial PR after failed review or verification.
