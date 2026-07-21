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

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 keeps verification deterministic, local, and read-only:

The immutable publication identities remain distinct: `localChangeBaseSha=7f5693b568f38c207227a5473f14648fd10d4816`, `expectedOldCandidateSha=7f5693b568f38c207227a5473f14648fd10d4816`, `targetBaseRef=refs/heads/main`, `expectedTargetBaseSha=02d05f798096431f23acd1e5594a6bee21f3149f`, `repository=davidomil/cloudx`, `pullRequest=1`, `prState=OPEN`, `prBaseRefName=main`, `prBaseRefOid=02d05f798096431f23acd1e5594a6bee21f3149f`, `prHeadRefName=architecture-and-new-codex`, `prHeadRefOid=expectedOldCandidateSha`, and `sameRepository=true`; verification grants none of their mutation authority.
After the sole push starts, `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and `reviewPrHandoff=false`; verification cannot alter that outcome.

1. Validate the accepted plan with `validateArtifact("plan", plan)` from
   `scripts/ai-change/artifact-validation.mjs` before invoking any command runner.
   A rejected command starts no process. Verification never publishes, pushes,
   or mutates GitHub.
2. Record the worktree digest, then run each accepted command exactly as planned
   with no model substitution.
3. Preserve each exit code and stdout/stderr digest, record the final worktree
   digest, and validate the result with `validateArtifact("verification", result)`.
4. Any command failure, tree change, incomplete command set, or semantic
   rejection fails verification. This role grants no publication authority.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

A pass requires every command to succeed and identical before/after tree
digests. An unavailable environment, skipped required command, timeout, changed
tree, neutral result, or incomplete output is a failure or explicit gap.

## Output

Produce JSON matching `.agents/schemas/verification.schema.json`, bound to the
implementation head. Report failures verbatim enough for a new implementer to
act without changing the recorded result.

Any subsequent implementation edit invalidates this artifact and requires a
complete new verification run.
