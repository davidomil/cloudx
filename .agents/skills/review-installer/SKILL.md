---
name: "review-installer"
description: "Review CloudX installation, setup, service, upgrade, or removal changes for host safety and operational correctness."
---

# Review Installation

Trace the affected entry point and helpers in `scripts/install-cloudx.mjs`,
`install.sh`, or setup scripts. Check supported environments and commands
against `docs/SETUP.md` and current source.

- Examine privilege, file ownership, permissions, environment, and secret handling.
- Check existing-install behavior, idempotency, version selection, data retention,
  and recovery from partially completed operations.
- Confirm dry-run behavior does not mutate the host and that service definitions
  launch the intended binaries with the intended working directory.
- Distinguish mocked command assertions from an actual supported-host smoke test.

Report specific failure modes and verification limits. Do not run installation,
restart services, or remove data on a live host merely to review a patch.
Machine output, when requested, follows `docs/AI_CHANGE_PROCESS.md`.
