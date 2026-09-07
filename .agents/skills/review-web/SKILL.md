---
name: "review-web"
description: "Review CloudX React UI, browser transport, workspace projection, accessibility, and responsive interaction changes."
---

# Review Web Changes

Read `apps/web/AGENTS.md` and trace the changed interaction through components,
state helpers, `apps/web/src/api.ts`, and relevant server contracts.

- Check stable action targets, removed-ID reconciliation, and stale async results.
- Follow socket, subscription, timer, terminal, audio, and object-URL cleanup.
- Keep server authorization and lifecycle decisions out of browser projections.
- Consider relevant loading, empty, error, reconnect, keyboard, touch, mobile,
  and accessibility behavior.
- Check consistency with the existing Lucide and workbench UI conventions.

Use browser evidence when claims depend on real rendering or interaction; do
not mistake a build or helper test for that evidence. Report actionable findings
and verification gaps. Machine output, when requested, follows
`docs/AI_CHANGE_PROCESS.md`.
