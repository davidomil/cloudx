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

Publication Contract V1 defines two disjoint authority paths.

The immutable identities remain distinct: `localChangeBaseSha=7f5693b568f38c207227a5473f14648fd10d4816`, `planningHeadSha=3a5c05272bd4a30bc7646aa710a0807ca85a088b`, `candidateHeadSha=validatedImplementationHeadSha`, `expectedOldCandidateSha=7f5693b568f38c207227a5473f14648fd10d4816`, `targetBaseRef=refs/heads/main`, `expectedTargetBaseSha=02d05f798096431f23acd1e5594a6bee21f3149f`, `repository=davidomil/cloudx`, `pullRequest=1`, `prState=OPEN`, `prBaseRefName=main`, `prBaseRefOid=02d05f798096431f23acd1e5594a6bee21f3149f`, `prHeadRefName=architecture-and-new-codex`, `prHeadRefOid=expectedOldCandidateSha`, and `sameRepository=true`.

Initial publication requires a nonsecret
`.agents/schemas/publication-authorization.schema.json` object with recursively
sorted keys, two-space indentation, and one final LF. The regular nonsymlink
authorization file is at most 32 KiB, outside the artifact directory, private
runtime evidence, and not committed controller state. `--authorization-file`
and `--authorized-publication-sha256` bind its bytes independently from the
`--authorized-manifest-sha256` bundle digest. The grant expires within 15
minutes, binds the complete identity tuple, policy, bundle, credential mode,
principal, and nonce, and selects only `automated-app` or `attended-user`. The
sole secret input is `CLOUDX_GATE_B_TOKEN`; it is pinned to child `GH_TOKEN` and
never serialized, passed in argv, logged, emitted, or stored by a credential
helper.

1. Initial candidate publication requires candidate-bound plan and
   implementation artifacts, deterministic verification, all policy-selected
   area reviews, clean aggregate review, and explicit authorization for both
   immutable digests and the complete identity tuple above. It does not require
   live `$review-pr`, labels, merge intent, or required checks because the new
   candidate head is not live yet.
2. Invoke exactly
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode <automated-app|attended-user> --expected-old-head <sha>`.
   Do not run a raw push. The executable validates authorization before reading
   the secret or running a command, validates the artifact snapshot and remote
   identity, disables ambient credentials and prompts, and revalidates the file,
   digest, identity, bundle, and expiry immediately before publication.
3. The executable may perform exactly one expected-old
   `--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
   update and then authoritative remote and pull-request readback. It has no
   ordinary push, general-force, protected-ref, alternate-ref, retry, rollback,
   or second-use authority. Before the push, a mismatch starts zero publication
   commands. After the sole push starts, every error or identity ambiguity
   produces `outcome=manual-reconciliation-required`, `pushAttempts=1`,
   `retry=false`, and `reviewPrHandoff=false`; that terminal outcome ends
   execution.
4. The initial path grants no label, comment, review, approval, close, enqueue,
   or merge authority. Only published success with complete readback permits
   `$review-pr` handoff.
5. Every later GitHub mutation requires current exact-head artifacts, current
   policy, explicit authorization, and a current clean `$review-pr` for the live
   PR head. A later push stales that review. Merge also requires a current
   `.agents/schemas/merge-intent.schema.json` artifact and all required checks.
6. Before a later operation, reread the live PR and relevant policy state. A
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
