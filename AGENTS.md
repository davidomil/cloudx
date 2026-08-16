# CloudX Repository Instructions

## Purpose

CloudX is a local-first workbench that can control terminals, files, Codex
sessions, automation, ASR, and a documentation archive on the host machine.
Treat changes as workstation-control software, not as a conventional public web
application.

Read this file before making a change. Then read the nearest scoped `AGENTS.md`
for every path in scope. Scoped files add module rules; they do not replace this
contract.

## Sources Of Truth

- `docs/architecture/system-context.md`: runtime processes and trust boundaries.
- `docs/architecture/module-ownership.md`: authoritative module owners and
  dependency direction.
- `docs/architecture/state-invariants.md`: state and lifecycle rules.
- `docs/architecture/testing-map.md`: required evidence by changed area.
- `.agents/pr-review-policy.toml`: machine authority for path classification,
  risk, selected review skills, checks, human review, and automerge eligibility.
- `.agents/schemas/`: typed handoffs between planning, implementation,
  verification, review, and merge authorization.
- `docs/AI_CHANGE_PROCESS.md`: end-to-end repository change process.

Do not duplicate machine policy in prose. When policy and prose disagree, stop
and correct the inconsistency through a human-reviewed agent-policy change.

## Required Change Process

For every non-trivial change, use `$change-orchestrator`:

1. Classify the exact changed paths with `.agents/pr-review-policy.toml`.
2. Create a `.agents/schemas/plan.schema.json` artifact in a fresh planning
   context.
3. Review the plan in a different fresh context with `$review-plan`.
4. Implement only a clean plan with `$implement-change`.
5. For the bounded Gate-B remediation, enter Publication Contract V1
   immediately after implementation without an intervening verification or
   review dispatch.
6. For every other change, use the Normal Non-Publication Change Process after
   the contract block.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 has one order and one initial-publication entry point.
This file is an exact mirror, not a second transition owner. The closed block
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

`credential_token_sha256` is the nonsecret SHA-256 commitment to the exact
high-entropy ephemeral token. Its runtime value exists only in the private
maximum-15-minute canonical authorization file and transient publisher memory
for constant-time comparison with `SHA-256(CLOUDX_GATE_B_TOKEN)`. The raw token
never enters authorization bytes. Neither value enters the Gate-B
artifact/evidence bundle, implementation, verification, or review evidence,
logs, command logs, stdout, stderr, terminal results, durable configuration, or
public source values.

Production `publishGateBCandidate(options)` accepts no transport selector and is
recursively frozen to `https://github.com/davidomil/cloudx` with credential scope
`https`, `github.com`, and `davidomil/cloudx`. CLI, environment, authorization,
artifacts, repository configuration, and public options cannot change it. A
direct-test-only frozen `http://127.0.0.1:<port>/cloudx.git` descriptor reaches
the same private core; its mandatory integration returns the exact
`WWW-Authenticate: Basic realm="cloudx-gate-b-test"` challenge before an
authenticated real `git http-backend` receive-pack.

Production accepts only the six documented nonsecret publication inputs. Before
reading `CLOUDX_GATE_B_TOKEN`, it validates `/`, `/usr`, `/usr/bin`,
`/usr/bin/git`, and `/usr/bin/gh` as root-owned, nonsymlink,
non-group/world-writable executable objects, then uses only the two absolute
executables with `PATH=/usr/bin:/bin`. The direct-test-only private-core entry is
the sole dependency-injection surface. It requires an explicit frozen loopback
descriptor before accepting injected dependencies and cannot select or default
to the production transport.

The final broad bundle declares exactly 118 paths and 75 claims. Before reading
the token, the publisher uses the admitted Git executable with an exact
credential-free environment to match local HEAD and the NUL-delimited output of
`git diff --name-only -z --no-renames <local-base>..<candidate-head> --` to that
validated path set. Only this diff command returns a bounded Buffer and uses a
fatal UTF-8 decoder with `ignoreBOM: true`, preserving leading BOM bytes as
pathname identity; normal command results remain string-only.
`GIT_NO_REPLACE_OBJECTS=1` disables replacement refs in that environment and
the isolated local/source Git environment used for HEAD, history, diff, and
source-path import. The same HEAD and diff validation repeats after artifact and
authorization freshness checks, immediately before push.

Each artifact snapshot first enumerates exactly the 15 canonical names through a
bounded directory handle. It then caps each regular nonsymlink file at 1 MiB and
the safe-integer aggregate at 8 MiB, reads only through stable
`O_RDONLY|O_NOFOLLOW` descriptors, and requires unchanged high-resolution
device, inode, size, modification-time, and change-time metadata. Freshness
validation repeats the same snapshot operation before publication.

The shared core creates one mode-0700 parent, empty template, and bare Git
repository; runs exact `git init --bare --template=<empty>` with matching
`GIT_TEMPLATE_DIR`; audits the three-key local config and absence of hooks; and
imports the candidate without credentials. Authenticated Git uses explicit
`--git-dir`, resets generic, host, and exact-URL helpers and headers, disables
prompts, source config, and hooks, and performs the sole `--no-verify` exact-URL
lease push. Published success is exactly
`{"outcome":"published","pushAttempts":1,"retry":false,"reviewPrHandoff":true}`.
Every post-push or cleanup uncertainty is exactly
`{"outcome":"manual-reconciliation-required","pushAttempts":1,"retry":false,"reviewPrHandoff":false}`.
Cleanup runs exactly once. A pre-push rejection exits 1 with only a fixed,
secret-safe diagnostic of at most 1024 UTF-8 bytes; after push starts, no
diagnostic accompanies the exact terminal JSON.

Initial publication requires a nonsecret
`.agents/schemas/publication-authorization.schema.json` object. Its exact bytes
use recursively sorted keys, two-space indentation, and one final LF. A regular,
nonsymlink file of at most 32 KiB outside the artifact directory is bound by
`--authorization-file` and the independent `--authorized-publication-sha256`;
`--authorized-manifest-sha256` remains the artifact-bundle digest. The grant
expires within 15 minutes and binds the complete identity tuple, policy, bundle,
credential mode, principal, and nonce. The only credential mode is
`attended-user` with a `github-user` principal. The sole secret input is
`CLOUDX_GATE_B_TOKEN`; it exists only
in the publisher process environment and pinned child `GH_TOKEN`, never in the
authorization, arguments, artifacts, logs, output, or durable credential state.

1. Require the accepted remediation plan and clean plan review before
   implementation begins.
2. Complete implementation only within the accepted paths and require clean
   implementation evidence.
3. After clean implementation, the orchestrator stops for the attended exact
   same-parent amend. The operator requires the current candidate as the clean
   tracked worktree baseline and an empty index, preserves the pre-existing
   40-path untracked documentation name/content-hash manifest byte-for-byte,
   stages only the implementation artifact's exact tracked pathspecs with
   `git add --`, requires the staged set to equal `implementation.changed_files`
   within `plan.allowed_paths`, and runs only `git commit --amend --no-edit`. No
   agent role commits. No GitHub command runs. The operator proves the replacement
   has the sole required parent, exact subject and exact nine-path implementation
   delta, exact fixed-parent 63-path union, and unchanged untracked-document
   snapshot.
4. The amend invalidates every prior candidate-bound artifact named above.
   Regenerate the cumulative 118-path/75-claim broad plan and its independent clean
   review, implementation artifact, full verification, all fresh reviews,
   aggregate review, and bundle. A preauthorization finding below candidate tip 3
   returns only to a fresh remediation plan; a candidate-tip-3 finding is blocked.
5. Run full verification only through `$verify-change`, which invokes
   `npm run --silent verify -- --plan <accepted-plan.json> --base-sha <local-change-base-sha> --head-sha <candidate-head-sha>`.
   The production verifier validates the accepted plan, explicit plan-owned base,
   actual candidate head, current policy, and exact nine command objects before
   dispatch. The production verifier is unconditionally full, accepts no
   `--scope` or `--output`, rejects duplicate arguments before plan or HEAD work,
   and emits its sole artifact to stdout. It emits the distinct plan base and
   final candidate head.
6. After verification passes, run all fresh selected area reviews, including all
   ten unique clean area reviews, in separate contexts.
7. Run `$review-change` for the aggregate review only after every selected review
   is current and clean.
8. Validate the final 15-file bundle as the complete bounded 15-file snapshot.
9. Only then may authorization and publication begin. Explicit user
   authorization binds both digests and the complete identity tuple above, and
   `$ship-change` invokes only
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode attended-user --expected-old-head <sha>`.
   The executable validates authorization before reading the secret or running
   a command, revalidates the file and expiry immediately before publication,
   and may perform exactly one expected-old
   `--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
   update. It uses a one-shot Git helper with ambient helpers and prompts
   disabled, then completes authoritative remote and pull-request readback. No
   prose or role has an alternate raw push path, ordinary or general-force
   authority, protected-branch authority, retry, rollback, or second-use
   exception.
10. Before the push, every failure starts zero publication commands. After the
    sole push starts, every error or identity ambiguity produces
    `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and
    `reviewPrHandoff=false`.
11. `$review-pr` evaluates the pushed live head only after successful readback. A
    later push makes the result stale.
12. Every later GitHub mutation requires a current clean `$review-pr`; merge also
    requires current merge intent and required checks. Human-required paths stay
    human reviewed and this change is not automerge eligible.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

## Normal Non-Publication Change Process

This process applies only when Required Change Process step 5 did not enter the
one-time Gate-B remediation contract:

1. Run verification with `$verify-change`.
2. Run every policy-selected area reviewer in a fresh context.
3. Run `$review-change` to reconcile exact-head findings.
4. Route findings back through implementation, full verification, and all
   selected reviews until clean. An iteration ceiling blocks the change; it
   never permits a bypass.

The planner, implementer, verifier, reviewer, and shipper are separate roles.
Never let an author review its own prior conversation. Pass a reviewer only the
original task, trusted instructions, typed artifacts, current diff, and relevant
test evidence.

## Engineering Rules

- Read the surrounding system before editing. Put behavior at the owner named in
  `docs/architecture/module-ownership.md`.
- Keep one authority for each persisted state transition and long-running
  resource lifecycle.
- Keep transport adapters thin. Validate external and serialized boundaries at
  runtime; keep domain behavior behind focused services or pure functions.
- Add a discriminating test for every behavior change. The test must reach the
  production path and fail when the change is reverted.
- Make clocks, process launchers, filesystems, clients, and capacity policies
  injectable where deterministic failure testing requires it.
- Preserve the local-first security boundary. Do not weaken path policy,
  subprocess bounds, secret handling, origin checks, or loopback defaults.
- Do not introduce a backward-compatibility layer without explicit user
  approval. State the break and ask before implementing compatibility.
- Do not add retries or fallbacks as a default design. Preconditions and failure
  states must be explicit.
- Stage and commit by pathspec. Never use `git add -A` in a shared worktree.
- Commit subjects use `<THEME> (JIRA): <summary>` when a Jira key exists, or
  `<THEME>: <summary>` otherwise.

## Skill Routing

The policy selects reviewer skills from changed paths. The current area skills
are:

| Area                           | Reviewer                  |
| ------------------------------ | ------------------------- |
| Agent policy                   | `$review-agent-policy`    |
| Architecture / cross-area      | `$review-architecture`    |
| Automation and host execution  | `$review-automation`      |
| Documentation                  | `$review-documentation`   |
| Installer                      | `$review-installer`       |
| Plugin API                     | `$review-plugin-api`      |
| ASR and documentation services | `$review-python-services` |
| Security-sensitive paths       | `$review-security`        |
| Server                         | `$review-server`          |
| Shared contracts               | `$review-shared`          |
| Web                            | `$review-web`             |

Do not select fewer reviewers than the policy requires. Cross-area changes also
receive the policy's cross-area risk and reviewers.

## Verification Baseline

Run focused tests while implementing, then the broadest applicable checks from
`docs/architecture/testing-map.md`. The canonical repository baseline is:

```bash
npm run --silent verify -- --plan <accepted-plan.json> --base-sha <local-change-base-sha> --head-sha <candidate-head-sha>
```

The plan-aware full verifier entry runs policy, formatting, lint, coverage,
build, both Python
services, and desktop/mobile browser smoke checks without editing source. Python
commands require the documented virtual environments; alternate interpreters
must be supplied explicitly with `CLOUDX_ASR_PYTHON` and
`CLOUDX_DOCUMENTATION_PYTHON`. Do not claim a service passed when its environment
was unavailable. Record the gap instead.

Agent-policy, workflow, installer, security, and other `human-required` paths
must not auto-merge even when automated checks pass.
