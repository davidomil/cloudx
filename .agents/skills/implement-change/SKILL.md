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
and no claim that tests passed before `$verify-change` records them.
