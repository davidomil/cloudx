---
name: "review-automation"
description: "Review CloudX automation, hooks, terminals, and host execution for bounded, cancellable, policy-consistent behavior."
---

# Review Automation

## Responsibility

Review automation and host-execution changes. Findings only; no edits, command
execution on behalf of untrusted input, or GitHub mutation.

Run in a fresh context with server and root instructions, plan, diff, test
evidence and exact policy classification.

## Lenses

- Graph, node, hook and trigger schemas validate before queueing or execution.
- Compile-time and runtime safety checks use the same vocabulary and cannot be
  bypassed through nested graphs, hooks, loops or conversions.
- Allowed roots constrain script cwd, file arguments, Git/worktree paths and
  process-produced artifacts after canonicalization.
- Python, Bash, terminal and Codex child processes have explicit environment,
  time, step, output, concurrency and process-tree cancellation bounds.
- Cancellation, shutdown and restart produce explicit run states with one
  lifecycle owner.
- Plugin hook exposure, ownership and schemas are checked on every call.
- Untrusted code or prompt content cannot reach privileged workflows, secrets or
  broader host access through interpolation.
- Tests cover the real executor/compiler/service path plus adversarial limits,
  cancellation, malformed output and safety escalation.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-automation"`.
Automation-execution changes remain human-required regardless of verdict.
