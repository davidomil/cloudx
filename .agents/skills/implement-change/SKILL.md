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

For the Gate-B remediation handoff, return the exact changed tracked paths and
the preserved pre-existing untracked-document snapshot to the orchestrator.
Existing `aae5b372739919537fc7cc08fb7dac4ebe6bc980` counts as candidate tip 1;
only candidate tips 2 and 3 may follow, and a candidate-tip-3 finding is blocked.
Only the attended operator may require the current candidate as the clean tracked
worktree baseline, assert sole required parent
`216e6d739155aa1dc5bab11829f56869e6f494ff`, require an empty index, preserve the
40-path untracked name/content-hash manifest byte-for-byte, require the exact
staged set to equal `implementation.changed_files` within `plan.allowed_paths`,
stage those exact nine remediation pathspecs with `git add --`, and run only
`git commit --amend --no-edit` while preserving exact subject
`POLICY: harden Gate B publication boundary`. No agent role commits and no
GitHub command runs. The operator proves the replacement has the sole required
parent, exact subject, exact nine-path delta, exact fixed-parent 63-path union
with LF-sorted newline SHA-256
`dd08cb93283abf5c1341ed3db13506da4f912423e11a51cf90ef8358404e0325`, and
the cumulative 118-path boundary remains unchanged with LF-sorted newline
SHA-256 `a125d814c942a913d63331d3d1d85f11c8c2740e269bd3e0f2e185c4c593d338`.
The exact nine remediation paths for candidate tip 3 are
`.agents/skills/change-orchestrator/SKILL.md`,
`.agents/skills/implement-change/SKILL.md`,
`.agents/skills/verify-change/SKILL.md`, `AGENTS.md`,
`docs/AI_CHANGE_PROCESS.md`, `docs/architecture/testing-map.md`,
`scripts/ai-change/validate-process.mjs`,
`scripts/ai-change/validate-process.test.mjs`, and
`scripts/ai-change/verify.test.mjs`. The operator also proves the unchanged
snapshot. The amend invalidates this implementation artifact and all
other prior candidate-bound precommit evidence; every artifact and review must
be regenerated against the final candidate head before authorization.
