---
name: "review-shared"
description: "Review CloudX shared domain types, validators, defaults, reducers, and browser/server serialization contracts."
---

# Review Shared Contracts

Trace the changed contract in `packages/shared` through its server, web, and
plugin API consumers. Compile-time agreement alone does not validate stored or
external data.

- Keep shared contracts serializable and free of host I/O or UI lifecycle ownership.
- Check runtime guards, defaults, optional fields, stable IDs, and reducers agree
  with the intended semantics.
- Examine persisted-state and wire-format implications, including malformed or
  partially populated data.
- Identify breaking changes explicitly; do not prescribe backward compatibility
  without a product requirement.
- Look for provider/consumer tests that distinguish the changed behavior.

Return evidence-backed findings and material uncertainty. Machine output, when
requested, follows `docs/AI_CHANGE_PROCESS.md`.
