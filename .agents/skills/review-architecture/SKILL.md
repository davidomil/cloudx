---
name: "review-architecture"
description: "Review a CloudX change for correct module ownership, dependency direction, state authority, and maintainable boundaries."
---

# Review Architecture

## Responsibility

Judge whether the change lives at the correct owner and improves or preserves
the system boundary. Findings only; no edits or GitHub mutation.

Run in a fresh context. Read `docs/architecture/system-context.md`,
`module-ownership.md`, `state-invariants.md`, applicable scoped instructions,
the accepted plan, exact diff and verification evidence.

## Lenses

- Correct process, package, module, service and function owns the behavior.
- One mutation authority for persisted state and long-running resources.
- Composition roots wire dependencies and shutdown but do not absorb feature
  logic.
- Shared contracts remain serializable and side-effect free; adapters remain
  thin.
- Browser/server and Node/Python boundaries change together with runtime and
  consumer/provider proof.
- New abstractions remove real complexity or match an established extension
  point; no parallel DTO, service or state shape is introduced unnecessarily.
- Cross-area lifecycle, cancellation, recovery, security and compatibility
  consequences are explicit.
- Tests reach the production seam and would fail if the change were reverted.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-architecture"`.
Name the correct owner in every wrong-seam finding.
