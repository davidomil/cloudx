---
name: "review-plan"
description: "Independently review a CloudX change plan for ownership, completeness, risk, and discriminating proof."
---

# Review Plan

## Responsibility

Judge one plan. Return findings or a clean verdict; do not revise the plan,
implement code, or mutate GitHub.

## Isolation

Run in a fresh context. Receive only:

- original task;
- trusted root/scoped instructions and architecture docs;
- policy classification;
- the plan artifact and current source needed to verify it.

Do not receive the planner's conversation. Bind the result to the plan digest
and exact base/head SHA.

## Review Lenses

- Correct module owner and production seam.
- Complete affected paths, consumers, serialized boundaries and lifecycle.
- Policy classification, risk, reviewers, checks and human-review decision.
- Compatibility assumptions and explicit user decisions.
- Two real analogous anchors.
- One claim-to-test row per behavior with a production entry point,
  revert-failing assertion and meaningful negative cases.
- Failure, cancellation, cleanup, concurrency, security, UX and recovery cases
  appropriate to the scope.
- Verification commands that cover every classified area.

## Output

Produce JSON matching `.agents/schemas/review.schema.json` with
`subject: "plan"` and `reviewer_role: "review-plan"`. `clean` means zero
findings. Every blocked finding needs a stable ID, severity, category,
path/line evidence and required fix.

An iteration ceiling remains blocked. Never lower a finding to let work start.
