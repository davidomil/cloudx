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

## Authority

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 defines two disjoint authority paths:

The immutable identities remain distinct: `localChangeBaseSha=7f5693b568f38c207227a5473f14648fd10d4816`, `expectedOldCandidateSha=7f5693b568f38c207227a5473f14648fd10d4816`, `targetBaseRef=refs/heads/main`, `expectedTargetBaseSha=02d05f798096431f23acd1e5594a6bee21f3149f`, `repository=davidomil/cloudx`, `pullRequest=1`, `prState=OPEN`, `prBaseRefName=main`, `prBaseRefOid=02d05f798096431f23acd1e5594a6bee21f3149f`, `prHeadRefName=architecture-and-new-codex`, `prHeadRefOid=expectedOldCandidateSha`, and `sameRepository=true`.
After the sole push starts, every error or identity ambiguity produces `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and `reviewPrHandoff=false`; that terminal outcome ends execution.

1. Initial candidate publication requires the exact local head, current valid
   plan and implementation, deterministic verification, all policy-selected area
   reviews, clean aggregate review, explicit user authorization for an immutable
   Gate-B manifest digest and the complete identity tuple above. It does not
   require live `$review-pr`, labels, merge intent, or required checks because
   the new candidate head is not live yet.
2. Invoke exactly
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --expected-old-head <sha>`.
   Do not run a raw push. The executable validates the exact artifact snapshot,
   unique reviewer identities, digests, local head, eight commit subjects, clean
   index and tracked worktree, repository `ADMIN` permission, Gate-B base,
   expected old ref, PR `#1`, fast-forward relation, and the unprotected,
   rules-free `architecture-and-new-codex` ref before it performs the single
   pinned non-force update. It rechecks the authorized manifest immediately
   before the update and binds the remote and PR readback afterward.
3. The initial path grants no label, comment, review, approval, close, enqueue,
   merge, protected-branch, force-update, retry, alternate-ref, or second-use
   authority. A mismatch is terminal.
4. Every later GitHub mutation requires current exact-head artifacts, current
   policy, explicit authorization, and a current clean `$review-pr` for the live
   PR head. A later push stales that review. Merge also requires a current
   `.agents/schemas/merge-intent.schema.json` artifact and all required checks.
5. Before a later operation, reread the live PR and relevant policy state. A
   human-required or non-automerge classification stops at handoff. Never reuse
   initial-publication authority for a later operation.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

## Output

Report PR URL/number, branch, exact head, labels changed, review/merge operation,
readback state and remaining action. Only record the state-machine `merged`
transition after the authorized exact head is confirmed on the base branch.

## Prohibitions

Do not infer authority from prose outside the marked contract or from
`trusted-auto-merge` alone.
