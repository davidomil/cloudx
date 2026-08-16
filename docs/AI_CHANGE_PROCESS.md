# AI Change Process

## Scope

CloudX exposes a public, repository-owned contract for AI-assisted changes. An
external private controller may use that contract to generate and review a
candidate, but it has no authority to weaken public policy or replace public CI.

The public repository owns:

- contributor and agent instructions;
- classification and review policy;
- typed handoff schemas and deterministic validators;
- credential-free candidate verification; and
- the required-check and exact-head merge contract.

The external controller owns its deployment, model login, durable orchestration,
GitHub App credentials, and mutation controls. Those implementation details are
not part of the CloudX product or public workflow surface.

## Public Authorities

| Concern                                                | Authority                                       |
| ------------------------------------------------------ | ----------------------------------------------- |
| Repository and scoped instructions                     | `AGENTS.md` and scoped `AGENTS.md` files        |
| Architecture ownership and invariants                  | `docs/architecture/`                            |
| Classification, risk, reviewers, and merge eligibility | `.agents/pr-review-policy.toml`                 |
| Typed role handoffs                                    | `.agents/schemas/*.schema.json`                 |
| Role behavior                                          | `.agents/skills/*/SKILL.md`                     |
| Deterministic artifact and state validation            | `scripts/ai-change/`                            |
| Candidate verification                                 | `.github/workflows/ci.yml` and `containers/ci/` |
| Public classification                                  | `.github/workflows/classify-pr.yml`             |
| Main-branch update policy                              | GitHub rulesets on the public repository        |

Machine policy is normative. Labels, issue text, pull-request text, comments,
media, patches, model output, and workflow artifacts are untrusted data. They
cannot become controller instructions, satisfy a typed artifact, replace a
current check, or authorize a merge.

## Managed Change Contract

A managed change follows the same public engineering gates as a human-authored
change:

1. Intake binds an immutable issue revision and target base.
2. Triage classifies type, area, risk, selected skills, and admission policy.
3. A fresh reviewer independently checks the triage result.
4. Planning identifies ownership, invariants, implementation steps, and proof.
5. A fresh reviewer independently checks the plan.
6. Issue work establishes a discriminating baseline before implementation.
7. Implementation is limited to accepted paths and produces claim-level
   evidence.
8. The bounded Gate-B remediation enters Publication Contract V1 immediately
   after implementation, without an intervening verification or review dispatch.
9. Every other change uses the Normal Non-Publication Change Process after the
   contract block.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 is the only public authority for this transition. The
document is an exact mirror, not a second transition owner. The closed block
below is the sole machine transition-order mirror of the change-orchestrator
authority. Validation removes only leading/trailing ASCII space, tab, CR, and LF
and folds internal runs of those bytes to one space; all other bytes are exact.
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
for constant-time comparison with `SHA-256(CLOUDX_GATE_B_TOKEN)`. The raw token
never enters authorization bytes. Neither value enters the Gate-B
artifact/evidence bundle, role artifacts, logs, command logs, stdout, stderr,
terminal results, durable configuration, or public source values.

Production accepts no transport selector and is recursively frozen to
`https://github.com/davidomil/cloudx` with its coherent path-bound credential
scope. No CLI, environment, authorization, artifact, repository config, or
public option can alter it. A frozen direct-test-only loopback descriptor reaches
the same private core. The mandatory proof returns exact
`WWW-Authenticate: Basic realm="cloudx-gate-b-test"` before authentication and
then bridges to real `git http-backend` receive-pack.

Production accepts only six nonsecret inputs. Before token access it validates
`/`, `/usr`, `/usr/bin`, `/usr/bin/git`, and `/usr/bin/gh` as root-owned,
nonsymlink, non-group/world-writable executable objects, invokes the two
absolute binaries only, and fixes `PATH=/usr/bin:/bin`. Dependency injection is
confined to the named direct-test-only private-core entry. That entry requires an
explicit frozen loopback descriptor before accepting injected dependencies and
cannot select or default to the production transport.

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

The shared core owns a 0700 parent, empty template, and audited three-key bare
Git repository, imports the candidate without credentials, and runs
authenticated Git only with explicit `--git-dir`, reset generic/host/exact-URL
helpers and headers, disabled prompts and hooks, and one `--no-verify` exact-URL
lease push. Cleanup runs exactly once. Published success and manual
reconciliation are the two exact four-field objects; pre-push rejection emits
only the fixed secret-safe diagnostic capped at 1024 UTF-8 bytes, while
post-push terminal JSON has no diagnostic output.

Artifact acquisition enumerates exactly 15 canonical names through one bounded
directory handle before reading content. Each regular nonsymlink descriptor is
capped at 1 MiB, the safe-integer aggregate is capped at 8 MiB, and stable
`O_RDONLY|O_NOFOLLOW` pre/post metadata includes device, inode, size,
modification time, and change time. The freshness read repeats the same operation.

Initial publication requires a nonsecret
`.agents/schemas/publication-authorization.schema.json` object. Canonical bytes
use recursively sorted keys, two-space indentation, and one final LF. The
regular nonsymlink file is at most 32 KiB, is outside the artifact directory,
remains private runtime evidence rather than committed controller state, and is
bound through `--authorization-file` and the independent
`--authorized-publication-sha256`. `--authorized-manifest-sha256` separately
binds the artifact bundle. The grant expires within 15 minutes and binds the
complete identity tuple, policy, bundle, nonce, credential mode, and principal.
Its only mode is `attended-user` with a `github-user` principal. The sole secret input is
`CLOUDX_GATE_B_TOKEN`; the publisher pins it to child `GH_TOKEN`, disables
ambient credentials and prompts, and never serializes, logs, emits, or durably
stores it.

1. A clean plan review is required before implementation starts.
2. A clean implementation must remain within the accepted plan.
3. After clean implementation, the orchestrator stops for the attended exact
   same-parent amend. The operator requires the current candidate as the clean
   tracked worktree baseline and an empty index, preserves the pre-existing
   40-path untracked documentation name/content-hash manifest byte-for-byte,
   stages only exact tracked implementation pathspecs through `git add --`, and
   requires the staged set to equal `implementation.changed_files` within
   `plan.allowed_paths`. The operator runs only `git commit --amend --no-edit`,
   then proves the sole parent, exact subject and exact nine-path implementation
   delta, exact fixed-parent 63-path union, and unchanged untracked-document
   snapshot. Agent roles do not commit and no GitHub command runs.
4. The amend invalidates every prior candidate-bound artifact named above.
   Regenerate the cumulative 118-path/75-claim broad plan and its independent clean
   review, implementation artifact, full verification, all fresh reviews,
   aggregate review, and bundle. A preauthorization finding below candidate tip 3
   returns only to a fresh remediation plan; a candidate-tip-3 finding is blocked.
5. Full verification runs only through `$verify-change` and
   `npm run --silent verify -- --plan <accepted-plan.json> --base-sha <local-change-base-sha> --head-sha <candidate-head-sha>`.
   It validates the plan at the production artifact boundary before command
   dispatch, then validates the explicit plan base, actual final head, policy,
   and exact nine command objects before dispatch. The production verifier is
   unconditionally full, accepts no `--scope` or `--output`, rejects duplicate
   arguments before plan or HEAD work, and emits its sole artifact to stdout.
6. Run all fresh selected area reviews against the verified candidate, including
   all ten unique clean area reviews required by policy.
7. Run `$review-change` for the fresh aggregate review against that same
   candidate and its current evidence.
8. Assemble the final 15-file bundle from the candidate-bound implementation,
   verification, selected area reviews, and aggregate review, then validate the
   complete bounded 15-file snapshot.
9. Explicit authorization binds both immutable digests and the complete identity
   tuple above. Authorization and publication then proceed only when
   `$ship-change` invokes
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode attended-user --expected-old-head <sha>`.
   The executable validates authorization before secret read or command
   execution, validates local, artifact, remote, and PR state, and revalidates
   the authorization file, digest, bundle, identity, and expiry immediately
   before publication.
10. The executable alone may perform exactly one expected-old
    `--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
    update to the confirmed unprotected, rules-free candidate ref and then
    authoritative remote and PR readback. No alternate raw push, ordinary push,
    general-force update, protected-ref update, retry, rollback, or second-use
    path exists.
11. Before the push, every failure starts zero publication commands. After the
    sole push starts, every error or identity ambiguity produces
    `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and
    `reviewPrHandoff=false`; no review or mutation follows before explicit
    reconciliation.
12. `$review-pr` evaluates only the pushed live head after successful readback;
    another push stales the result.
13. Every later GitHub mutation requires a current clean `$review-pr`; merge also
    requires current merge intent and required checks. Human-required paths
    remain human reviewed and this change is not automerge eligible.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

## Normal Non-Publication Change Process

This process applies only when Managed Change Contract step 8 did not enter the
one-time Gate-B remediation contract.

1. Run `$verify-change` against the exact candidate bytes.
2. Run every policy-selected area review in fresh contexts against that exact
   head and its current verification evidence.
3. Run `$review-change` in a fresh context to aggregate those reviews.
4. Route findings back through implementation, full verification, all selected
   area reviews, and aggregate review until clean.

Fresh judgment roles do not inherit the context that produced the artifact they
review. A failed review or materially changed requirement starts a new bounded
iteration; it does not silently mutate previously accepted evidence.

## Public Checks

The stable required-check contract is:

- `CI / merge-gate` proves deterministic repository verification for the exact
  candidate head; and
- `AI Review / head` proves that the configured review process completed for
  that same head.

The public CI verifier runs without model credentials or privileged repository
credentials. Candidate code cannot publish its own trusted attestation. A
successful check is evidence only for the commit SHA and workflow identity that
GitHub records; a later push invalidates earlier readiness.

## Review And Merge

- Protected policy, instruction, skill, schema, workflow, installer, security,
  and host-execution changes require human review.
- Selected area reviewers must cover every policy-selected area. A fresh
  aggregate review reconciles their findings.
- No label or model verdict grants a branch-protection bypass.
- Normal automated updates to `main` occur only through the separately
  authorized merge controller named by the public ruleset.
- Merge authorization re-fetches the pull request, base, head, reviews, checks,
  and ruleset-relevant state immediately before an exact-head merge request.
- Interactive shipping remains an attended action governed by the marked
  contract and `$ship-change`.

Public workflows never receive the private controller's model session, App
private keys, publication credentials, or merge credentials.

## Contributor Workflow

Run the focused policy suite while editing this contract:

```bash
npm run policy:validate
npx vitest run scripts/ai-change
npm run format:check
```

Run
`npm run --silent verify -- --plan <accepted-plan.json> --base-sha <local-change-base-sha> --head-sha <candidate-head-sha>`
before merging repository-wide changes. Required evidence
must identify the tested head and the exact commands that produced it. Missing
or stale evidence is a block, not an implicit pass.

## External Controller Boundary

The private controller is an external consumer of this repository contract. It
may snapshot public source, invoke the tracked roles, publish typed results, and
request permitted GitHub mutations. CloudX does not define its host topology,
credential storage, database schema, recovery procedure, or model-account
configuration.

Changes to the public contract must remain understandable and enforceable
without access to the private repository. Changes to private implementation
must continue to satisfy the public policy and exact-head checks described here.
