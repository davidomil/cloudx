---
name: "review-change"
description: "Reconcile independent area-review findings into the exact-head implementation review gate for a CloudX change."
---

# Review Change

## Responsibility

Judge and reconcile findings from current source evidence and fresh selected
area reviews. Do not edit code, fix findings, rerun verification or mutate GitHub.
Do not receive the implementation conversation or review your own prior work.

## Inputs And Identity

Read the original task, applicable trusted/scoped instructions and conditional
references, independently accepted plan/review, implementation, passed full
verification, observed diff and one fresh artifact per required role.
Required local roles are the union of current observed-path policy roles and
accepted plan roles. Preserve any stricter accepted reviewer and human review.

<!-- CLOUDX-NORMAL-REVIEW-ROUTING-V1:BEGIN -->

Before local review dispatch, the orchestrator explicitly selects ordinary
independent review or the optional local shortcut. Ordinary independent review
does not invoke or require successful `--print-subject` or clean aggregation.
It directly validates the complete evidence and scope contract in
`docs/AI_CHANGE_PROCESS.md`.

Use `readLocalReviewScope` with guarded Git reads to observe the verified
HEAD/worktree and preserve normal staged entries. Capture the index snapshot
before verification/handoff and compare it at aggregate acceptance; different
index-only bytes remain an explicit verification gap.

The orchestrator independently computes SHA-256 of UTF-8
`cloudx-local-review-v1\n<sha256(raw implementation)>\n<sha256(raw verification)>\n`
from exact raw implementation and passed full verification bytes. Area and
aggregate outputs use `subject: implementation`,
`run_id: verification.run_id`, that composite digest and candidate
base/head/current policy. Require exact observed/declaration/literal allowed
scope and the union of current observed-path policy roles and accepted plan roles.

Start every selected area reviewer in a fresh context, then a different fresh
`$review-change` context for ordinary aggregate judgment. Recheck candidate,
scope/index, effective Git config/attributes and raw evidence before acceptance.
The optional shortcut requires explicit selection and index equal to HEAD;
rejection neither retries nor automatically switches routes. Both routes retain
full verification, raw evidence joins, human review and freshness. Managed and
Gate-B contracts remain separate.

<!-- CLOUDX-NORMAL-REVIEW-ROUTING-V1:END -->

For ordinary review, require the orchestrator's independently calculated subject
and complete direct evidence validation from `docs/AI_CHANGE_PROCESS.md`.
Use the unchanged fanout and aggregate validators to check fresh role coverage,
identities, findings and durable tags. Never substitute the raw implementation
digest or retrofit old review JSON; new verification bytes require fresh area
judgments. Plan, plan-review and implementation producer IDs may differ.

Only the explicitly selected optional shortcut obtains its subject through
`--print-subject`. Its staged-index rejection does not block ordinary
independent review of the verified HEAD/worktree. Missing or unsupported evidence
remains a gap; do not mutate the index or claim different index-only bytes were
verified.

## Gate

- Trace relevant claims, production seams, callers and discriminating tests
  through the production path within each required review lens. A clean area
  verdict does not replace that independent substantive work.
- Reconcile findings by stable ID and evidence, preserving the highest supported
  severity when reviewers disagree.
- Preserve the union of every area-review tag. Add `manual-review` when current
  classification or the accepted plan is human-required, or this candidate needs
  a maintainer decision despite having no blocking finding.
- Treat missing, stale, malformed or contradictory evidence as a process finding.
  A model assertion cannot override deterministic verification or unresolved
  findings. Focused author tests and reviewer completeness cannot replace the
  unchanged full verifier.

Only for an explicit local candidate whose complete independent area set is
current and clean may the orchestrator use the deterministic local command to
produce the aggregate without another model dispatch. It performs prerequisite,
observed-scope and freshness checks and rejects every finding-bearing or blocked
area. Findings require this fresh judgment role; the utility cannot dismiss them.
It excludes managed artifacts and the reserved Gate-B base, grants no hosting
authority, and does not approve its own introduction. The workflow optimization
retains its four accepted area roles, human review and independent aggregate.

## Output

Produce JSON matching `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-change"`. A clean verdict
requires zero findings. Always emit `tags`; use `[]` only when no durable
disposition applies. Keep evidence outside the repository.

Findings return to a fresh implementer, then full verification and all selected
reviewers. Any changed verification subject requires fresh area judgments.
An iteration ceiling blocks the change.
