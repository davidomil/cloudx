---
name: "review-automation"
description: "Review CloudX automation graph, compiler, executor, scheduling, persistence, or host-execution changes."
---

# Review Automation

Trace the change through the relevant owners in `apps/server/src/automation/`
and their callers rather than reviewing graph helpers in isolation.

- Compile-time validation and runtime execution should use the same safety
  vocabulary, types, and hook/trigger contracts.
- Check explicit cwd/environment, path containment, output and duration bounds,
  concurrency, cancellation, and owned process-tree cleanup.
- Inspect persisted transitions, stable run/event identities, trigger checkpoint
  and outbox handling, and recovery after interrupted work.
- Treat Python and Bash nodes as host execution, with negative tests for the
  affected trust boundary.

Report reachable bugs or risks with evidence and relevant coverage gaps.
Machine output, when requested, follows `docs/AI_CHANGE_PROCESS.md`.
