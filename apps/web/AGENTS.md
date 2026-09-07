# Web Scope Instructions

This file applies under `apps/web/` and extends the root `AGENTS.md`.

## Ownership

The React application renders server and plugin state, owns local interaction
state, and sends explicit commands through `src/api.ts`. It must not reproduce
server authorization, path policy, automation safety, or resource lifecycle
decisions.

## Rules

- Keep `App.tsx` as composition and navigation. Put reusable state transitions in
  focused pure modules and feature behavior in focused components/controllers.
- Reconcile local projections when server workspace IDs disappear or change.
- Dispose subscriptions, timers, sockets, terminal views, object URLs, audio
  streams, and async work when their owner unmounts.
- Use shared contracts from `@cloudx/shared`; transport changes update
  `src/api.ts`, the server provider, and contract tests together.
- Preserve keyboard, pointer, touch, mobile viewport, accessibility, loading,
  empty, error, reconnect, and offline states relevant to the changed workflow.
- Use the existing Lucide icon system and workbench visual conventions. Do not
  turn operational screens into marketing layouts or decorative card grids.

## Tests

Add or update the changed component or pure-state tests. Run focused tests, then:

```bash
npm run typecheck
npm test
npm run build -w @cloudx/web
```

Visible behavior also requires browser validation. Check desktop and mobile
viewports and record screenshots for responsive or visual changes.
