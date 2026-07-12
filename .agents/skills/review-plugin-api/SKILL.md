---
name: "review-plugin-api"
description: "Review CloudX plugin API changes for coherent contracts, schemas, exposure, ownership, and consumer coverage."
---

# Review Plugin API

## Responsibility

Review the in-process plugin contract and its server consumers. Findings only;
no edits or GitHub mutation.

Run in a fresh context with root instructions, `packages/plugin-api`, shared
contracts, server registry/hook/trigger consumers, plan, diff and verification.

## Lenses

- Contract responsibility belongs in plugin API rather than concrete plugins or
  shared domain types.
- IDs, descriptors, configuration, actions, hooks, triggers, rules, skills and
  UI contribution shapes are typed, serializable and runtime-validated at
  external boundaries.
- Exposure and ownership cannot be widened accidentally or bypassed through a
  generic call path.
- Additions compose with existing extension points rather than create parallel
  registration or descriptor shapes.
- Every constructor/converter/consumer is updated; server registry and
  contribution tests cover the new contract.
- Compatibility impact is explicit. Do not accept a compatibility shim unless
  the user approved it.
- Do not imply installed GitHub plugin metadata executes third-party code; that
  install path is metadata-only today.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-plugin-api"`.
