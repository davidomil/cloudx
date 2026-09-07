---
name: "review-security"
description: "Review CloudX changes affecting host execution, origins, paths, credentials, untrusted inputs, or repository automation trust boundaries."
---

# Review Security

Use `docs/SECURITY_MODEL.md` and the affected production boundary to identify
what an untrusted input or candidate can actually reach. CloudX controls a
developer's host; local-first does not make all inputs trustworthy.

- Trace canonicalized paths, symlinks, archive extraction, process cwd and
  environment, resource limits, and cancellation.
- Preserve loopback defaults and explicit trusted-origin restrictions for LAN use.
- Follow secrets through config, errors, logs, browser state, and subprocesses.
- Check that plugin metadata and retrieved documents do not become executable
  code or authority.
- For repository automation, inspect credential isolation, exact-candidate
  evidence, and live authorization checks independently of model verdicts.

Report a concrete attack or failure path, impact, and evidence; distinguish
confirmed exposure from hypotheses. Keep diagnostics secret-safe.
Machine output, when requested, follows `docs/AI_CHANGE_PROCESS.md`.
