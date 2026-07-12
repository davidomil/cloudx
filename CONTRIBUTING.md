# Contributing To CloudX

CloudX is a local-first workstation-control application. A change can affect
terminal processes, host files, credentials, automation code, microphone data,
or the documentation archive. Review scope and evidence must match that impact.

## Before Editing

1. Read root `AGENTS.md` and each scoped `AGENTS.md` in the paths you will touch.
2. Read the ownership, invariant, and testing documents under
   `docs/architecture/`.
3. Classify the proposed paths using `.agents/pr-review-policy.toml`.
4. Use `$change-orchestrator` for every non-trivial change.
5. If the change breaks an existing contract, state the break. Ask before adding
   backward compatibility.

The policy, not the contributor or model, determines area labels, risk, required
review skills, checks, human review, and automerge eligibility.

## Plan, Implement, Verify, Review

The repository uses typed handoffs under `.agents/schemas/`:

- `$plan-change` produces a change plan.
- A fresh `$review-plan` context must return a clean plan review.
- `$implement-change` implements only the accepted plan and records claim-level
  evidence and deviations.
- `$verify-change` runs deterministic checks without editing the worktree.
- Fresh policy-selected reviewers and `$review-change` review the exact verified
  head.
- Review findings return to implementation. The resulting change is verified
  and reviewed again.

An iteration cap is a safety stop. Reaching it blocks the change; it does not
allow a partial PR, skipped review, or merge.

## Tests

Every behavior change needs a production-path test with an assertion that would
fail on the old behavior. Include sibling, negative, cancellation, cleanup, and
error cases appropriate to the changed seam. Use the commands and evidence map
in `docs/architecture/testing-map.md`.

Run at least the root TypeScript baseline when TypeScript is affected:

```bash
npm run typecheck
npm test
npm run build
```

Run the service-specific pytest command for each changed Python service. UI
changes also require browser behavior evidence; responsive or visible changes
require desktop and mobile screenshots.

## Commits And Pull Requests

- Stage only owned paths. Do not use `git add -A`.
- Commit subjects use `<THEME> (JIRA): <summary>` or `<THEME>: <summary>`.
- Keep generated output out of the change unless the policy and plan require it.
- The PR description must identify the task, classified areas and risk, exact
  head SHA, plan and review artifacts, verification commands, and remaining
  risks.
- A new push makes previous verification, AI review, and merge intent stale.

`$review-pr` is advisory and does not mutate GitHub. `$ship-change` is the only
interactive skill allowed to push, open or update a PR, change labels or
reviews, authorize a merge, or merge. Trusted workflow controllers implement
the same ship authority for deterministic label, check, intent, and exact-head
merge operations. Human-required paths always need explicit protected-path
approval.

See `docs/AI_CHANGE_PROCESS.md` for the complete state and artifact protocol.
