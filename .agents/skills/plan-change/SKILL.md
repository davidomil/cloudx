---
name: "plan-change"
description: "Produce a source-grounded, typed implementation plan for one classified CloudX change."
---

# Plan Change

## Responsibility

Design the change at the correct owner and define proof before code is written.
Do not edit code, review the plan, or mutate GitHub.

## Inputs

- Original task, base/head SHA, and policy digest.
- Classification from `.agents/pr-review-policy.toml`.
- Root and all applicable scoped `AGENTS.md` files.
- Policy-selected area skills and current source/tests.

Run in a fresh context. Research the current code and read every proposed file.
Trace at least two analogous repository implementations.

## Required Plan

Produce JSON that validates against `.agents/schemas/plan.schema.json` with:

- exact task, SHAs, policy digest, and selected skill digests;
- type, areas, risk, skills, human-review requirement and automerge eligibility;
- at least two path/line anchors and why each is analogous;
- behavioral claims with owner/seam, production-path test, and negative cases;
- explicit allowed and forbidden paths;
- exact verification commands from `docs/architecture/testing-map.md`.

Place behavior at the owner in `docs/architecture/module-ownership.md`. Account
for every affected invariant in `docs/architecture/state-invariants.md`. If the
task requires a compatibility layer, record the break and stop for explicit user
approval before planning compatibility.

## Stop Conditions

Return a blocking gap instead of guessing when ownership, behavior, external
requirements, or a safe proof strategy is unresolved. Scope outside allowed
paths requires a new complete plan.
