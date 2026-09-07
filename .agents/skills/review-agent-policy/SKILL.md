---
name: "review-agent-policy"
description: "Review CloudX agent instructions, skills, schemas, policy, or workflow changes for useful context, clarity, and genuine automation safeguards."
---

# Review Agent Guidance

Check whether the guidance helps an agent understand the task and repository
without prescribing unnecessary roles, approvals, artifacts, or repeated work.
Prefer concise project-specific context over generic advice or duplicated rules.

- Verify paths, commands, skill descriptions, and source claims.
- Look for conflicting instructions, accidental scope expansion, and rigid
  workflow requirements hidden in linked documents or validators.
- Distinguish adaptable prose from actual machine schemas and security checks.
  Simplifying guidance must not silently disable executable authorization,
  credential isolation, candidate identity, or artifact validation.
- Consider realistic tasks: can an agent make a narrow fix, investigate an
  unknown API, or perform a read-only review without unrelated ceremony?

Report substantive findings with evidence and practical corrections. Machine
output, when requested, follows `docs/AI_CHANGE_PROCESS.md`.
