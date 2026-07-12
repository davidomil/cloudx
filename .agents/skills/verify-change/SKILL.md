---
name: "verify-change"
description: "Run deterministic, read-only verification for an implemented CloudX change and preserve exact command evidence."
---

# Verify Change

## Responsibility

Execute the accepted verification plan and report facts. Do not edit or fix
code, reinterpret a failure, review quality, or mutate GitHub.

## Inputs

- Accepted plan and implementation artifacts.
- Exact current head and policy digest.
- Commands selected from `docs/architecture/testing-map.md`.

## Procedure

1. Record the worktree digest before verification.
2. Run each command exactly as planned with no command substitution by a model.
3. Preserve exit code and stdout/stderr digests for every command.
4. Record the worktree digest after verification.
5. Validate the artifact through `scripts/ai-change/artifact-validation.mjs`.

A pass requires every command to succeed and identical before/after tree
digests. An unavailable environment, skipped required command, timeout, changed
tree, neutral result, or incomplete output is a failure or explicit gap.

## Output

Produce JSON matching `.agents/schemas/verification.schema.json`, bound to the
implementation head. Report failures verbatim enough for a new implementer to
act without changing the recorded result.

Any subsequent implementation edit invalidates this artifact and requires a
complete new verification run.
