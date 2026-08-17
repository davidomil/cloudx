---
name: "review-web"
description: "Review CloudX web changes for state projection, API contracts, cleanup, accessibility, responsive behavior, and browser proof."
---

# Review Web

## Responsibility

Review React/Vite behavior and its browser/server boundary. Findings only; no
edits or GitHub mutation.

Run in a fresh context with root and web instructions, shared/API contracts,
accepted plan, exact diff, component tests and browser evidence.

## Lenses

- Components render/project server state and send explicit commands; they do not
  duplicate server authorization, path, automation-safety or lifecycle logic.
- Root composition stays readable; reusable transitions move to focused pure
  modules or controllers.
- Async effects handle stale responses, target stable IDs and clean up timers,
  sockets, subscriptions, object URLs, terminal views and audio streams.
- Loading, empty, error, reconnect and offline states are coherent.
- Keyboard, pointer and touch workflows remain accessible and equivalent.
- Text fits controls; panes, dialogs, toolbars and fixed-format elements remain
  stable at desktop and mobile viewports without overlap.
- Existing workbench conventions and Lucide icons are preserved.
- Tests reach user-visible behavior; visible changes include browser validation
  and desktop/mobile screenshots. A successful build alone is not UX proof.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-web"`.
