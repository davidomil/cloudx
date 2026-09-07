---
name: "review-documentation"
description: "Review CloudX documentation for correctness, missing operational context, stale references, and clarity."
---

# Review Documentation

Check statements against current source, tests, configuration, and authoritative
external documentation where needed. Verify commands, paths, prerequisites,
defaults, and behavior rather than accepting confident wording as evidence.

Look for missing context that changes how someone uses or operates the feature,
especially security boundaries, destructive actions, and unsupported environments.
Keep observed behavior distinct from proposals and unverified assumptions.

Favor concise, task-oriented guidance. Do not require diagrams, screenshots,
templates, or process artifacts unless they materially support the content.
Report substantive inaccuracies and broken references with evidence.
Machine output, when requested, follows `docs/AI_CHANGE_PROCESS.md`.
