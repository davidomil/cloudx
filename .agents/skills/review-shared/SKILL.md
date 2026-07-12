---
name: "review-shared"
description: "Review CloudX shared domain contracts, reducers, validators, defaults, and serialization across server and web consumers."
---

# Review Shared

## Responsibility

Review changes under `packages/shared` and every affected consumer. Findings
only; no edits or GitHub mutation.

Run in a fresh context with shared source/tests, server and web consumers,
accepted plan, exact diff and verification evidence.

## Lenses

- The concept is truly shared and serializable; host-only or UI-only behavior
  stays with its owner.
- Runtime guards, defaults, reducers and TypeScript types describe the same valid
  states.
- Discriminated unions are exhaustive and invalid combinations are
  unrepresentable or rejected at a boundary.
- Workspace/layout and automation transitions preserve IDs, references and
  invariants for every operation order.
- Wire-shape changes update producers, consumers, fixtures and runtime
  validation together.
- Compatibility impact is explicit and no compatibility layer appears without
  user approval.
- Tests include valid round trips, malformed serialized data, sibling variants
  and revert-failing state transitions.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-shared"`.
