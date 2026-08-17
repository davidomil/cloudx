---
name: "review-installer"
description: "Review CloudX installer and service setup changes for privilege, idempotency, versions, secrets, and lifecycle safety."
---

# Review Installer

## Responsibility

Review installation, update, uninstall and service-setup behavior. Findings
only; do not run privileged installation, edit code or mutate GitHub.

Run in a fresh context with `docs/SETUP.md`, installer source, accepted plan,
exact diff and dry-run/test evidence.

## Lenses

- Supported operating systems, Node/Python/Git/CUDA versions and prerequisites
  match current source and documentation.
- Privileged operations are explicit, narrowly scoped and never receive
  untrusted shell interpolation.
- Install, update, rerun, partial failure and uninstall preserve user data and
  have deterministic ownership of files, services and virtual environments.
- Secrets, tokens, certificates and service environment files have safe
  permissions and are not printed or committed.
- Dry-run mode does not mutate the host and exercises the same decisions as the
  real path.
- Service units use correct paths, ordering, restart and cleanup semantics.
- No silent version fallback, retry loop or package-source drift is introduced.
- Tests cover arguments, dry run, idempotency, failure boundaries and generated
  configuration.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-installer"`.
Installer changes remain human-required regardless of verdict.
