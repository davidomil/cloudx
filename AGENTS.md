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
5. Run deterministic, read-only verification with `$verify-change`.
6. Run `$review-change` and every policy-selected area reviewer in fresh
   contexts.
7. Route findings back through implementation, verification, and review until
   clean. An iteration ceiling blocks the change; it never permits a bypass.
8. Use `$review-pr` for current-head PR review. Only `$ship-change` may perform
   interactive or model-directed GitHub mutations; trusted workflow controllers
   may publish deterministic labels, checks, intent, and exact-head merges.

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
