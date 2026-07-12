---
name: "ship-change"
description: "Perform authorized CloudX GitHub mutations and exact-head merge handling after every repository gate is proven."
---

# Ship Change

## Responsibility

This is the sole skill allowed to mutate GitHub for the AI change process. It
may push an already prepared branch, open or update a PR, reconcile labels,
submit an authorized review, and request a merge only when policy permits.
It does not plan, implement, verify, or review code.

## Preconditions

- Valid current plan, implementation, verification and clean review artifacts.
- Clean `$review-pr` artifact for the live PR head.
- Current policy classification and reconciled label set.
- A `.agents/schemas/merge-intent.schema.json` artifact for the same PR head.
- Explicit user authorization for the requested GitHub mutation.

Before a merge action, reread the live pull request and prove that required
checks, clean review, resolved conversations, protected-path approval, merge
intent, and head SHA are all current. Automated merge authority belongs to the
private controller; this public skill must not substitute a local merge path.

## Procedure

1. Re-read the live PR head immediately before mutation.
2. Refuse stale artifacts, missing checks, neutral/skipped/cancelled checks,
   unresolved conversations or a different head.
3. Reconcile managed labels; remove stale managed labels as well as adding
   current ones.
4. For `human-required` or `automerge: false` classifications, prepare the PR
   handoff and stop before automatic merge.
5. For an eligible authorized change, request the policy-approved squash merge
   path and verify the live result. Do not claim `merged` from an enqueue
   acknowledgement.
6. Record the exact command/API operation and authoritative readback.

## Output

Report PR URL/number, branch, exact head, labels changed, review/merge operation,
readback state and remaining action. Only record the state-machine `merged`
transition after the authorized exact head is confirmed on the base branch.

## Prohibitions

No force push, no direct protected-branch push, no merge-policy bypass, no blind
retry, and no mutation based only on `trusted-auto-merge`.
