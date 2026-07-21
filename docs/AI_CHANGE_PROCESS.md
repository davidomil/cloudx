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
8. Verification runs against the exact candidate bytes.
9. Policy-selected area reviews and a fresh aggregate review evaluate the same
   exact head.
10. Complete publication and live-head review under Publication Contract V1.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->

Publication Contract V1 is the only public authority for this transition.

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

The shared core owns a 0700 parent, empty template, and audited three-key bare
Git repository, imports the candidate without credentials, and runs
authenticated Git only with explicit `--git-dir`, reset generic/host/exact-URL
helpers and headers, disabled prompts and hooks, and one `--no-verify` exact-URL
lease push. Cleanup runs exactly once. Published success and manual
reconciliation are the two exact four-field objects; pre-push rejection emits
only the fixed secret-safe diagnostic capped at 1024 UTF-8 bytes, while
post-push terminal JSON has no diagnostic output.

Initial publication requires a nonsecret
`.agents/schemas/publication-authorization.schema.json` object. Canonical bytes
use recursively sorted keys, two-space indentation, and one final LF. The
regular nonsymlink file is at most 32 KiB, is outside the artifact directory,
remains private runtime evidence rather than committed controller state, and is
bound through `--authorization-file` and the independent
`--authorized-publication-sha256`. `--authorized-manifest-sha256` separately
binds the artifact bundle. The grant expires within 15 minutes and binds the
complete identity tuple, policy, bundle, nonce, credential mode, and principal.
Its exact modes are `automated-app` and `attended-user`. The sole secret input is
`CLOUDX_GATE_B_TOKEN`; the publisher pins it to child `GH_TOKEN`, disables
ambient credentials and prompts, and never serializes, logs, emits, or durably
stores it.

1. Verification validates the accepted plan through the production artifact
   boundary before command dispatch and remains deterministic, local, read-only,
   and unable to mutate GitHub.
2. Candidate-bound implementation, verification, all selected area reviews, and
   aggregate review plus explicit authorization bind both immutable digests and
   the complete identity tuple above.
3. `$ship-change` invokes only
   `node scripts/ai-change/publish-gate-b.mjs --artifact-dir <bundle> --authorized-manifest-sha256 <sha256> --authorization-file <path> --authorized-publication-sha256 <sha256> --credential-mode <automated-app|attended-user> --expected-old-head <sha>`.
   The executable validates authorization before secret read or command
   execution, validates local, artifact, remote, and PR state, and revalidates
   the authorization file, digest, bundle, identity, and expiry immediately
   before publication.
4. The executable alone may perform exactly one expected-old
   `--force-with-lease=refs/heads/architecture-and-new-codex:<expectedOldCandidateSha>`
   update to the confirmed unprotected, rules-free candidate ref and then
   authoritative remote and PR readback. No alternate raw push, ordinary push,
   general-force update, protected-ref update, retry, rollback, or second-use
   path exists.
5. Before the push, every failure starts zero publication commands. After the
   sole push starts, every error or identity ambiguity produces
   `outcome=manual-reconciliation-required`, `pushAttempts=1`, `retry=false`, and
   `reviewPrHandoff=false`; no review or mutation follows before explicit
   reconciliation.
6. `$review-pr` evaluates only the pushed live head after successful readback;
   another push stales the result.
7. Every later GitHub mutation requires a current clean `$review-pr`; merge also
   requires current merge intent and required checks. Human-required paths remain
   human reviewed and this change is not automerge eligible.

<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->

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

Run `npm run verify` before merging repository-wide changes. Required evidence
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
