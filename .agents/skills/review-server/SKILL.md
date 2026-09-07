---
name: "review-server"
description: "Review CloudX Fastify routes, WebSockets, sessions, persistence, host capabilities, and server service changes."
---

# Review Server Changes

Read `apps/server/AGENTS.md` and trace the affected owner through its adapters,
callers, and production-path tests.

- Check runtime input validation, service error mapping, and shared contracts.
- Look for duplicated state authority or feature logic leaking into composition.
- Follow session, process, queue, timer, and socket lifecycles through failure,
  reconnect, cancellation, and shutdown.
- Exercise wrong or stale IDs and path-policy boundaries where behavior changed.
- Check public config, notifications, and errors for accidental secret exposure.

Report actionable regressions with locations, impact, and evidence, including
important coverage gaps. Machine output, when requested, follows
`docs/AI_CHANGE_PROCESS.md`.
