---
name: "review-architecture"
description: "Review CloudX ownership, dependency, state, or lifecycle changes, especially those spanning multiple runtime areas."
---

# Review Architecture

Use `docs/architecture/module-ownership.md` and
`docs/architecture/state-invariants.md` as orientation, then trace the current
implementation and consumers.

- Check that persisted state and long-running resources have one clear owner.
- Keep composition and transport adapters separate from feature behavior.
- Look for duplicated domain decisions, circular dependencies, or abstractions
  without a concrete need.
- Trace contract changes through both providers and consumers, including
  Node/Python boundaries and shared browser/server data.
- Check failure, startup, shutdown, and cancellation behavior where affected.

Report concrete design risks with locations, impact, and evidence. Prefer the
smallest correction that restores a clear boundary over a broad redesign.
Machine output, when requested, follows `docs/AI_CHANGE_PROCESS.md`.
