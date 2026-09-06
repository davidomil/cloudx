---
name: "implement-change"
description: "Implement one independently accepted CloudX plan within its allowed worktree paths and record claim-level evidence."
---

# Implement Change

## Responsibility

Translate one accepted plan into code and tests. Do not plan, review, verify the
final result, commit, push, or mutate GitHub.

## Preconditions

- The plan validates against `.agents/schemas/plan.schema.json`.
- A clean plan review matches the plan digest and base/head SHA.
- The worktree and scoped instructions still match the accepted plan.

## Execution

- Re-read each file immediately before editing.
- Edit only `allowed_paths`; never touch `forbidden_paths`.
- Follow the owner and invariants recorded in the plan.
- Add the planned production-path tests with revert-failing assertions and
  negative cases.
- Preserve unrelated and concurrent work. Stage nothing.
- If current code contradicts the plan or scope must grow, stop and return to
  planning rather than improvising.

## Output

Produce JSON matching `.agents/schemas/implementation.schema.json`:

- plan, policy, base and current-head digests;
- exact changed files;
- claim-to-production-path and test evidence;
- revert-failing assertions and negative cases;
- every deviation, including `[]` when none exist.

The artifact is evidence for later deterministic verification and independent
review. It is not a self-review or a pass verdict.

## Prohibitions

No GitHub reads or writes needed for implementation, no `git add -A`, no commit,
and no final verification-pass claim before `$verify-change` records it.
Report focused author-test commands and actual results as implementation evidence;
they do not constitute independent verification or review.

<!-- CLOUDX-GATE-B-ROUTING-V1:BEGIN -->

Only when the accepted task explicitly enters the bounded Gate-B remediation
or publication flow, read the complete repository-relative source
`.agents/skills/change-orchestrator/references/gate-b/implementation.md` before acting.
It is operative only within that flow. Require its exact identities, ordered
gates, independent reviews and explicit authorization. If the source is absent,
unreadable or inconsistent with this routing, stop. Ordinary local or managed
work does not enter that flow or gain its authority; never use local clean
aggregation for Gate-B. This reference grants no new authorization.

<!-- CLOUDX-GATE-B-ROUTING-V1:END -->
