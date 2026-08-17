---
name: "review-change"
description: "Reconcile independent area-review findings into the exact-head implementation review gate for a CloudX change."
---

# Review Change

## Responsibility

Produce the aggregate implementation verdict from current source evidence and
fresh policy-selected reviews. Do not edit code, fix findings, rerun verification,
or mutate GitHub.

## Inputs

- Original task and trusted instructions.
- Accepted plan and implementation artifacts.
- Passed verification artifact for the same head.
- Current base-to-head diff.
- One fresh review artifact from every skill selected by policy.

Do not receive the implementation conversation. Confirm each area reviewer was
selected by the current path classification and that every artifact matches the
same policy digest, subject and head.

## Gate

- Trace every behavioral claim from production entry to changed seam and test.
- Reconcile findings by stable ID and evidence, not by prose similarity.
- Preserve the highest supported severity when reviewers disagree.
- Preserve the union of every area-review tag. Add `manual-review` when the
  actual path classification is human-required or this exact head needs a
  maintainer decision despite having no blocking finding.
- Treat missing, stale, malformed or contradictory review evidence as a process
  finding.
- A model assertion cannot override deterministic verification or an unresolved
  area finding.

## Output

Produce JSON matching `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-change"`. A clean
verdict requires zero findings across the aggregate.
Always emit `tags`; use `[]` only when no durable disposition applies.

Findings return to a fresh implementer. The resulting head must be reverified
and reviewed by all selected reviewers. An iteration ceiling blocks the change.
