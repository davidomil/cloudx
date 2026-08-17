---
name: "review-documentation"
description: "Review CloudX documentation for source accuracy, current commands, coherent ownership, and non-duplicated policy."
---

# Review Documentation

## Responsibility

Review documentation as an executable engineering contract. Findings only; no
edits or GitHub mutation.

Run in a fresh context. Verify claims against current source, manifests, tests,
policy and authoritative external sources where required.

## Lenses

- Commands, paths, environment variables, module names and behavior exist in the
  current repository.
- Architecture and ownership claims distinguish required design from currently
  implemented behavior.
- Root and scoped instructions do not duplicate or contradict machine policy.
- Links and relative references resolve with correct case.
- Security guidance preserves the local-first threat model and does not imply
  unsupported public hardening.
- Testing claims identify exact commands and clearly report unavailable
  environments or manual/browser gaps.
- Source-grounded claims retain revision/context and do not overstate a single
  test, snapshot or operational observation.
- Documentation is concise, uses project vocabulary and contains no generated
  filler or hidden instructions to agents.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-documentation"`.
Use `documentation` findings for factual or presentation defects and `process`
for policy drift.
