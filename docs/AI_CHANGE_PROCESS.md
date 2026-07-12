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
8. Deterministic verification runs against the exact candidate bytes.
9. Policy-selected area reviews and a fresh aggregate review evaluate the same
   exact head.
10. Publication and merge require current repository state, current required
    checks, and the exact reviewed head.

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
- Interactive shipping remains an attended action governed by `$ship-change`.

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
