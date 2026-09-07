---
name: "verify-change"
description: "Run deterministic, read-only verification for an implemented CloudX change and preserve exact command evidence."
---

# Verify Change

## Responsibility

Execute the accepted verification plan and report facts. Do not edit or fix
code, reinterpret a failure, review quality, or mutate GitHub.

## Inputs

- Accepted plan and implementation artifacts.
- Exact current head and policy digest.
- Commands selected from `docs/architecture/testing-map.md`.

## Procedure

<!-- CLOUDX-GATE-B-ROUTING-V1:BEGIN -->

Only when the accepted task explicitly enters the bounded Gate-B remediation
or publication flow, read the complete repository-relative source
`.agents/skills/change-orchestrator/references/gate-b/verification.md` before acting.
It is operative only within that flow. Require its exact identities, ordered
gates, independent reviews and explicit authorization. If the source is absent,
unreadable or inconsistent with this routing, stop. Ordinary local or managed
work does not enter that flow or gain its authority; never use local clean
aggregation for Gate-B. This reference grants no new authorization.

<!-- CLOUDX-GATE-B-ROUTING-V1:END -->

1. Validate the accepted plan using `validateArtifact("plan", plan)` from
   `scripts/ai-change/artifact-validation.mjs`. Require the explicit local base
   to equal `plan.base_sha`, actual HEAD to equal the candidate head, current
   policy and the exact nine full verification command objects.
2. Invoke only
   `npm run --silent verify -- --plan <accepted-plan.json> --base-sha <local-change-base-sha> --head-sha <candidate-head-sha>`.
   The production verifier is unconditionally full, accepts no `--scope` or
   `--output`, rejects duplicate arguments before plan or HEAD work, and emits
   its sole artifact to stdout.
3. Preserve the exact output bytes outside the repository, including execution
   `run_id`, command exit codes/output digests and before/after worktree digests.
   Validate the verification schema. Do not replace a command or soften a failure.

For explicit local review, the verification execution ID may differ from the
plan, plan-review and implementation producer IDs. Every fresh local area and
aggregate review uses `verification.run_id` and the composite subject binding
the raw implementation and these exact verification bytes. The orchestrator
obtains that subject after full verification; new verification bytes invalidate
older local reviews even at the same HEAD. Managed and Gate-B identities retain
their existing contracts.

A pass requires every command to succeed and identical before/after tree
digests. An unavailable environment, skipped required command, timeout, changed
tree, neutral result, or incomplete output is a failure or explicit gap.

## Output

Produce JSON matching `.agents/schemas/verification.schema.json`, bound to the
implementation head. Report failures verbatim enough for a new implementer to
act without changing the recorded result.

Any subsequent implementation edit invalidates this artifact and requires a
complete new verification run.
