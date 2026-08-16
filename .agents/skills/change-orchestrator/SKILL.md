---
name: "change-orchestrator"
description: "Orchestrate a CloudX change through classification, isolated planning, implementation, verification, review, and an optional ship handoff."
---

# Change Orchestrator

## Responsibility

Route one change through the repository state machine. Do not plan, implement,
verify, review, or mutate GitHub in the orchestrator context.

## Inputs

- Original task and current worktree/base SHA.
- Root and scoped `AGENTS.md` files.
- `.agents/pr-review-policy.toml` classification.
- Current typed artifacts and finding IDs, if resuming.

## Workflow

1. Classify exact proposed paths and type through `scripts/ai-change/policy.mjs`.
2. Start a fresh `$plan-change` context and validate its output against
   `.agents/schemas/plan.schema.json`.
3. Start a different fresh `$review-plan` context. A blocked review returns to a
   new planner; a review ceiling transitions to `blocked`.
4. Dispatch `$implement-change` only after a clean plan review.
5. Select exactly one post-implementation transition. The bounded Gate-B
   remediation enters Publication Contract V1 immediately, with no intervening
   verification or review dispatch. Every other change uses the Normal
   Non-Publication Flow after the contract block.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 limits this role to ordered, isolated dispatch.
The closed block below is the sole machine transition-order authority.
Validation removes only leading/trailing ASCII space, tab, CR, and LF and folds
internal runs of those bytes to one space; all other bytes are exact.
The complete raw bytes of this operative instruction source are
policy-digest-bound; any edit requires a human-reviewed commitment update.

<!-- CLOUDX-GATE-B-REMEDIATION-ORDER-V1:BEGIN -->

fresh remediation plan -> independent clean plan review -> clean implementation -> attended exact same-parent amend -> invalidate every prior candidate-bound artifact -> regenerate full candidate evidence -> if a preauthorization finding exists below candidate tip 3 return to fresh remediation plan; if a finding exists against candidate tip 3 transition to blocked; otherwise final bounded 15-file bundle -> authorization and publication.
<!-- CLOUDX-GATE-B-REMEDIATION-ORDER-V1:END -->

This correction admits only a bounded pre-publication remediation cycle.
Existing `aae5b372739919537fc7cc08fb7dac4ebe6bc980` counts as candidate tip 1.
The cycle permits at most three candidate tips total, and the ceiling does not
reset after a fresh plan. Before authorization or publication begins, a finding
may return only to a fresh remediation plan and independent clean plan review.
After each clean implementation, only the attended operator may create candidate
tip 2 or tip 3 with `git commit --amend --no-edit`. A finding against candidate
tip 3 transitions terminally to `blocked`; there is no candidate tip 4, bypass,
exception reuse, or implicit continuation.

The current candidate is the clean tracked worktree baseline for each cycle. At
operator handoff the index is empty, and the only tracked worktree changes are
the exact nine remediation paths. The exact nine remediation paths for candidate
tip 3 are `.agents/skills/change-orchestrator/SKILL.md`,
`.agents/skills/implement-change/SKILL.md`,
`.agents/skills/verify-change/SKILL.md`, `AGENTS.md`,
`docs/AI_CHANGE_PROCESS.md`, `docs/architecture/testing-map.md`,
`scripts/ai-change/validate-process.mjs`,
`scripts/ai-change/validate-process.test.mjs`, and
`scripts/ai-change/verify.test.mjs`. The attended amend retains sole parent
`216e6d739155aa1dc5bab11829f56869e6f494ff`, exact subject
`POLICY: harden Gate B publication boundary`, and every other path mode and blob
OID. Its fixed-parent diff is exactly the 63-path union, includes
`apps/web/src/ui/voiceWorkspace.ts` and
`apps/web/src/ui/voiceWorkspace.test.ts`, and has LF-sorted newline SHA-256
`dd08cb93283abf5c1341ed3db13506da4f912423e11a51cf90ef8358404e0325`.
The cumulative 118-path boundary remains unchanged with LF-sorted newline
SHA-256 `a125d814c942a913d63331d3d1d85f11c8c2740e269bd3e0f2e185c4c593d338`.

Every replacement invalidates every prior candidate-bound `plan`, `plan-review`,
`implementation`, `verification`, `selected area-review`, `aggregate-review`,
`final-bundle`, and `authorization` artifact. It then requires, in order, a
regenerated cumulative 118-path/75-claim broad plan with updated contract and
voice claims and only the exact safe nine verification commands, a fresh clean
plan review, a regenerated implementation artifact, full canonical verification,
all fresh policy-selected area reviews, aggregate review, and a final bounded
15-file bundle. No remediation cycle exists after authorization creation, token
read, publisher invocation, publication attempt, or any GitHub mutation. During
a cycle, no authorization is created. No token is read, no publisher is invoked,
no publication command runs, and no GitHub mutation occurs.

The immutable identities remain distinct: `localChangeBaseSha=7f5693b568f38c207227a5473f14648fd10d4816`, `planningHeadSha=bca78352e91bb40e5f2a46d664872a4b25890cf3`, `candidateHeadSha=validatedImplementationHeadSha`, `expectedOldCandidateSha=7f5693b568f38c207227a5473f14648fd10d4816`, `targetBaseRef=refs/heads/main`, `expectedTargetBaseSha=02d05f798096431f23acd1e5594a6bee21f3149f`, `repository=davidomil/cloudx`, `pullRequest=1`, `prState=OPEN`, `prBaseRefName=main`, `prBaseRefOid=02d05f798096431f23acd1e5594a6bee21f3149f`, `prHeadRefName=architecture-and-new-codex`, `prHeadRefOid=expectedOldCandidateSha`, and `sameRepository=true`.

`credential_token_sha256` is the approved nonsecret SHA-256 commitment to the
exact high-entropy ephemeral token. Its runtime value exists only in the private
maximum-15-minute canonical authorization file and transient publisher memory
for constant-time comparison. The raw token never enters authorization bytes;
neither value enters the Gate-B artifact/evidence bundle, role evidence, logs,
stdout, stderr, terminal results, durable configuration, or public source.

The orchestrator supplies no transport selector. Production is recursively frozen to
`https://github.com/davidomil/cloudx`; no CLI, environment, authorization,
artifact, repository config, or public option can alter it. The frozen loopback
descriptor is direct-test-only and reaches the same private empty-template,
audited bare Git, token-free import, explicit `--git-dir`, reset-helper/header,
hooks-disabled, `--no-verify` exact-lease core. Its required proof challenges
before authentication and bridges to real `git http-backend` receive-pack. The
direct-test entry requires an explicit frozen loopback descriptor before
accepting injected dependencies and cannot select or default to the production
transport.
The final broad bundle declares exactly 118 paths and 75 claims. Before token
read, the publisher uses the admitted Git executable with an exact
credential-free environment to match local HEAD and the NUL-delimited output of
`git diff --name-only -z --no-renames <local-base>..<candidate-head> --` to that
validated path set. Only this diff command returns a bounded Buffer and uses a
fatal UTF-8 decoder with `ignoreBOM: true`, preserving leading BOM bytes as
pathname identity; normal command results remain string-only.
`GIT_NO_REPLACE_OBJECTS=1` disables replacement refs in that environment and
the isolated local/source Git environment used for HEAD, history, diff, and
source-path import. The same HEAD and diff validation repeats after artifact and
authorization freshness checks, immediately before push.
Cleanup runs exactly once. The only results are exactly
`{"outcome":"published","pushAttempts":1,"retry":false,"reviewPrHandoff":true}`
or `{"outcome":"manual-reconciliation-required","pushAttempts":1,"retry":false,"reviewPrHandoff":false}`;
pre-push rejection emits only the fixed bounded diagnostic and post-push emits
no diagnostic beyond terminal JSON.

Initial publication requires a nonsecret
`.agents/schemas/publication-authorization.schema.json` object with recursively
sorted keys, two-space indentation, and one final LF. Its regular nonsymlink
file is at most 32 KiB, outside the artifact directory, private runtime evidence,
and is not committed controller state. `--authorization-file` and
`--authorized-publication-sha256` bind those bytes independently from the
`--authorized-manifest-sha256` bundle digest. A grant lasts at most 15 minutes,
binds the complete identity tuple, policy, bundle, mode, principal, and nonce,
and selects only `attended-user` with a `github-user` principal. The sole secret input is
`CLOUDX_GATE_B_TOKEN`; it is never serialized or durably persisted.

1. Require the accepted remediation plan and clean plan review before dispatching
   implementation.
2. Dispatch implementation only from that clean plan and require clean
   implementation evidence within its accepted paths.
3. After clean implementation, stop for the attended exact same-parent amend.
   The operator requires the current candidate as the clean tracked worktree
   baseline and an empty index, preserves the pre-existing 40-path untracked
   documentation name/content-hash manifest byte-for-byte, stages only exact
   tracked implementation pathspecs with `git add --`, requires the staged set to
   equal `implementation.changed_files` within `plan.allowed_paths`, and runs only
   `git commit --amend --no-edit`. No agent role commits and no GitHub command
   runs. Prove the replacement has the sole required parent, exact subject and
   exact nine-path implementation delta, the exact fixed-parent 63-path union,
   and an unchanged untracked-document snapshot.
4. The amend invalidates every prior candidate-bound artifact named above.
   Regenerate the cumulative 118-path/75-claim broad plan and its independent
   clean review, implementation artifact, full verification, all fresh reviews,
   aggregate review, and bundle. A preauthorization finding below candidate tip 3
   returns only to a fresh remediation plan; a candidate-tip-3 finding is blocked.
5. Dispatch `$verify-change` for full verification against that exact head.
6. After verification passes, dispatch all fresh selected area reviews in
   separate contexts, including the required ten unique area reviews.
7. Dispatch `$review-change` for the aggregate review only after every selected
   area review is current and clean.
8. Validate the final 15-file bundle as one bounded 15-file snapshot containing
   the candidate-bound plan, plan review, implementation, verification, all area
   reviews, and aggregate review.
9. Only after that bundle is valid may authorization and publication begin.
   Record explicit authorization for both immutable digests and the complete
   identity tuple above, then dispatch `$ship-change` with the sole
   `publish-gate-b.mjs` entry point and exact arguments:
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode attended-user --expected-old-head <sha>`.
   The orchestrator never runs a publication command or performs another GitHub
   mutation.
10. The publisher validates authorization before secret read or command
    execution, pins the secret to child `GH_TOKEN`, disables ambient credentials
    and prompts, revalidates immediately before publication, and performs at most
    one exact expected-old
    `--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
    update. No ordinary push, general force, retry, rollback, or alternate path is
    authorized.
11. Before the push, every failure starts zero publication commands. After the
    sole push starts, every error or identity ambiguity produces
    `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and
    `reviewPrHandoff=false`; the run stops for explicit reconciliation.
12. Require authoritative remote-ref, base, and pull-request readback before
    dispatching `$review-pr` for the pushed live head. Never dispatch it after a
    rejection or manual-reconciliation result.
13. Dispatch `$ship-change` for a later mutation only with a current clean
    `$review-pr`. A later push stales that review; merge also requires current
    merge intent and required checks. Human-required paths remain human reviewed,
    no automerge is authorized, and the initial exception is never reused.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

## Normal Non-Publication Flow

This flow applies only when Workflow step 5 did not enter the bounded Gate-B
remediation contract.

1. Dispatch `$verify-change`. Verification cannot edit or fix the worktree.
2. Start fresh contexts for every reviewer selected by policy. Give each only
   the task, trusted instructions, accepted plan, implementation artifact,
   current diff, and verification artifact.
3. Dispatch `$review-change` to reconcile the exact-head findings.
4. Findings return to a fresh implementer, followed by full verification and all
   selected reviews. An iteration ceiling transitions the change to `blocked`;
   it never permits a bypass.

The private AI manager owns durable lifecycle transitions. This public skill
produces schema-valid artifacts and exact-head evidence for that manager; it
never infers a later state from prose. An iteration cap, missing reviewer, stale
SHA, schema error, or failed command blocks the run and never permits a bypass.

## Output

Return the current state, artifact paths/digests, finding IDs, exact commands
run, and the next valid action. Do not produce a substitute artifact in prose.

## Prohibitions

- No author self-review or reused author conversation.
- No code edits, commits, or repository-hosting changes.
- No partial PR after failed review or verification.
