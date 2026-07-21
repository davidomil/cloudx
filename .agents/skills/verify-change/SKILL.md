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

Publication Contract V1 keeps verification deterministic, local, and read-only.

The immutable publication identities remain distinct: `localChangeBaseSha=7f5693b568f38c207227a5473f14648fd10d4816`, `planningHeadSha=bca78352e91bb40e5f2a46d664872a4b25890cf3`, `candidateHeadSha=validatedImplementationHeadSha`, `expectedOldCandidateSha=7f5693b568f38c207227a5473f14648fd10d4816`, `targetBaseRef=refs/heads/main`, `expectedTargetBaseSha=02d05f798096431f23acd1e5594a6bee21f3149f`, `repository=davidomil/cloudx`, `pullRequest=1`, `prState=OPEN`, `prBaseRefName=main`, `prBaseRefOid=02d05f798096431f23acd1e5594a6bee21f3149f`, `prHeadRefName=architecture-and-new-codex`, `prHeadRefOid=expectedOldCandidateSha`, and `sameRepository=true`; verification grants none of their mutation authority.

The private maximum-15-minute authorization alone carries the approved
nonsecret `credential_token_sha256` commitment for constant-time comparison;
the raw token never enters authorization. Neither value enters the Gate-B
artifact/evidence bundle, verification evidence, logs, stdout, stderr, terminal
results, durable configuration, or public source, and verification receives
neither.

Production accepts no transport selector and is recursively frozen to
`https://github.com/davidomil/cloudx`. A frozen direct-test-only loopback
descriptor uses the same empty-template audited bare
Git core and proves an exact Basic challenge before real `git http-backend`
receive-pack. Authenticated Git uses explicit `--git-dir`, reset helpers and
headers, disabled hooks, and the sole `--no-verify` exact lease. Cleanup runs
exactly once. Verification cannot alter the exact four-field published or
manual-reconciliation result, the fixed bounded pre-push diagnostic, or the
post-push no-diagnostic boundary.

Later initial-publication handoff uses a nonsecret
`.agents/schemas/publication-authorization.schema.json` object. Its recursively
sorted, two-space-indented, final-LF bytes form a regular nonsymlink file of at
most 32 KiB outside the artifact directory. `--authorization-file` and
`--authorized-publication-sha256` bind it independently from
`--authorized-manifest-sha256`. Its grant lasts at most 15 minutes and binds identity,
policy, bundle, nonce, and exactly one `automated-app` or `attended-user`
principal. The sole secret is `CLOUDX_GATE_B_TOKEN`, pinned to child `GH_TOKEN`
and never available to verification. `$ship-change` alone may invoke
`node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode <automated-app|attended-user> --expected-old-head <sha>`
for at most one exact expected-old
`--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
update.

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
5. Before the push, publisher rejection starts zero publication commands. After
   the sole push starts, `outcome=manual-reconciliation-required`,
   `pushAttempts=1`, `retry=false`, and `reviewPrHandoff=false`; verification
   cannot alter that outcome. Human-required paths remain human reviewed and no
   automerge is authorized.

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
