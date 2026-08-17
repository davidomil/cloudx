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
8. After a clean local gate, dispatch `$review-pr` for the current PR head.
9. Dispatch `$ship-change` only when the user explicitly requests a GitHub
   mutation or merge action.

The private AI manager owns durable lifecycle transitions. This public skill
produces schema-valid artifacts and exact-head evidence for that manager; it
never infers a later state from prose. An iteration cap, missing reviewer, stale
SHA, schema error, or failed command blocks the run and never permits a bypass.

## Output

Return the current state, artifact paths/digests, finding IDs, exact commands
run, and the next valid action. Do not produce a substitute artifact in prose.

## Prohibitions

- No author self-review or reused author conversation.
- No code edits, commits, pushes, labels, PR reviews, approvals, or merges.
- No partial PR after failed review or verification.
