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
5. Run verification with `$verify-change` under the versioned contract below.
6. Run `$review-change` and every policy-selected area reviewer in fresh
   contexts.
7. Route findings back through implementation, verification, and review until
   clean. An iteration ceiling blocks the change; it never permits a bypass.
8. Complete publication and live-head review under the versioned contract below.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 has one order and one initial-publication entry point.

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
credential mode, principal, and nonce. The only modes are `automated-app` and
`attended-user`. The sole secret input is `CLOUDX_GATE_B_TOKEN`; it exists only
in the publisher process environment and pinned child `GH_TOKEN`, never in the
authorization, arguments, artifacts, logs, output, or durable credential state.

1. `$verify-change` validates the accepted plan through
   `scripts/ai-change/artifact-validation.mjs` before it dispatches any command.
   Verification is deterministic, local, read-only, and cannot mutate GitHub.
2. After the candidate head has current clean implementation, verification,
   policy-selected area-review, and aggregate-review artifacts, explicit user
   authorization binds both digests and the complete identity tuple above.
3. `$ship-change` invokes only
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode <automated-app|attended-user> --expected-old-head <sha>`.
   The executable validates authorization before reading the secret or running
   a command, revalidates the file and expiry immediately before publication,
   and may perform exactly one expected-old
   `--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
   update. It uses a one-shot Git helper with ambient helpers and prompts
   disabled, then completes authoritative remote and pull-request readback. No
   prose or role has an alternate raw push path, ordinary or general-force
   authority, protected-branch authority, retry, rollback, or second-use
   exception.
4. Before the push, every failure starts zero publication commands. After the
   sole push starts, every error or identity ambiguity produces
   `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and
   `reviewPrHandoff=false`.
5. `$review-pr` evaluates the pushed live head only after successful readback. A
   later push makes the result stale.
6. Every later GitHub mutation requires a current clean `$review-pr`; merge also
   requires current merge intent and required checks. Human-required paths stay
   human reviewed and this change is not automerge eligible.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

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
npm run verify
```

`npm run verify` runs policy, formatting, lint, coverage, build, both Python
services, and desktop/mobile browser smoke checks without editing source. Python
commands require the documented virtual environments; alternate interpreters
must be supplied explicitly with `CLOUDX_ASR_PYTHON` and
`CLOUDX_DOCUMENTATION_PYTHON`. Do not claim a service passed when its environment
was unavailable. Record the gap instead.

Agent-policy, workflow, installer, security, and other `human-required` paths
must not auto-merge even when automated checks pass.
