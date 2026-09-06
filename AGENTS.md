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
5. Select the bounded Gate-B flow only under the conditional routing below;
   every other change uses the Normal Non-Publication Change Process.

<!-- CLOUDX-GATE-B-ROUTING-V1:BEGIN -->

Only when the accepted task explicitly enters the bounded Gate-B remediation
or publication flow, read the complete repository-relative source
`.agents/skills/change-orchestrator/references/gate-b/root.md` before acting.
It is operative only within that flow. Require its exact identities, ordered
gates, independent reviews and explicit authorization. If the source is absent,
unreadable or inconsistent with this routing, stop. Ordinary local or managed
work does not enter that flow or gain its authority; never use local clean
aggregation for Gate-B. This reference grants no new authorization.

<!-- CLOUDX-GATE-B-ROUTING-V1:END -->

## Normal Non-Publication Change Process

Freeze final source and typed evidence, then run the unchanged full verifier
through `$verify-change`. Local route selection and acceptance follow this contract:

<!-- CLOUDX-NORMAL-REVIEW-ROUTING-V1:BEGIN -->

Before local review dispatch, the orchestrator explicitly selects ordinary
independent review or the optional local shortcut. Ordinary independent review
does not invoke or require successful `--print-subject` or clean aggregation.
It directly validates the complete evidence and scope contract in
`docs/AI_CHANGE_PROCESS.md`.

Use `readLocalReviewScope` with guarded Git reads to observe the verified
HEAD/worktree and preserve normal staged entries. Capture the index snapshot
before verification/handoff and compare it at aggregate acceptance; different
index-only bytes remain an explicit verification gap.

The orchestrator independently computes SHA-256 of UTF-8
`cloudx-local-review-v1\n<sha256(raw implementation)>\n<sha256(raw verification)>\n`
from exact raw implementation and passed full verification bytes. Area and
aggregate outputs use `subject: implementation`,
`run_id: verification.run_id`, that composite digest and candidate
base/head/current policy. Require exact observed/declaration/literal allowed
scope and the union of current observed-path policy roles and accepted plan roles.

Start every selected area reviewer in a fresh context, then a different fresh
`$review-change` context for ordinary aggregate judgment. Recheck candidate,
scope/index, effective Git config/attributes and raw evidence before acceptance.
The optional shortcut requires explicit selection and index equal to HEAD;
rejection neither retries nor automatically switches routes. Both routes retain
full verification, raw evidence joins, human review and freshness. Managed and
Gate-B contracts remain separate.

<!-- CLOUDX-NORMAL-REVIEW-ROUTING-V1:END -->

Give each fresh reviewer the original task, accepted plan/review, exact
implementation/verification bytes, validated subject, observed diff and selected
roles. Reviewers read trusted/scoped instructions and conditional references,
then trace relevant claims, production seams, callers and discriminating tests.
Findings require fresh `$review-change` judgment; route them through fresh
implementation, full verification and all selected reviews. An iteration ceiling
blocks the change. Managed changes keep their existing aggregate dispatch.

The planner, implementer, verifier, reviewer and shipper remain separate roles.
Never let an author review its own prior conversation. New verification bytes
require fresh area judgments. Focused author tests, missing environments or
reviewer completeness cannot replace full verification. Keep evidence outside
the repository; no local aggregate grants hosting authority.

For policy/skill self-changes, preserve originally accepted roles, human review
and independent aggregate judgment. Final digest updates are metadata rebinding
only: preserve task, claims, scope and verification commands, obtain a fresh
independent review of the new plan bytes, regenerate the implementation's plan
digest, then run full verification and all new area and aggregate judgments.
Any behavior, scope or proof change returns to fresh planning.

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

Do not select fewer reviewers than the policy requires. Cross-area escalation follows participating owner routes in policy. Supporting
prose still receives its direct documentation review; protected routes retain
their required reviewers and human-review gates.

## Verification Baseline

Run focused tests while implementing, then the broadest applicable checks from
`docs/architecture/testing-map.md`. The canonical repository baseline is:

```bash
npm run --silent verify -- --plan <accepted-plan.json> --base-sha <local-change-base-sha> --head-sha <candidate-head-sha>
```

The production verifier is unconditionally full, accepts no `--scope` or
`--output`, rejects duplicate arguments before plan or HEAD work, and emits its
sole artifact to stdout. It runs policy, formatting, lint, coverage,
build, both Python
services, and desktop/mobile browser smoke checks without editing source. Python
commands require the documented virtual environments; alternate interpreters
must be supplied explicitly with `CLOUDX_ASR_PYTHON` and
`CLOUDX_DOCUMENTATION_PYTHON`. Do not claim a service passed when its environment
was unavailable. Record the gap instead.

Agent-policy, workflow, installer, security, and other `human-required` paths
must not auto-merge even when automated checks pass.
