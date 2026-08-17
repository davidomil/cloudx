---
name: "review-server"
description: "Review CloudX server changes for correct service ownership, route contracts, state transitions, lifecycle, and failure behavior."
---

# Review Server

## Responsibility

Review the Node/Fastify server and built-in capability services. Findings only;
no edits or GitHub mutation.

Run in a fresh context with root and server instructions, architecture docs,
accepted plan, exact diff and verification artifact.

## Lenses

- `server.ts` and `index.ts` remain composition/transport owners; feature logic
  lives in the focused service.
- External HTTP/WebSocket input is runtime-validated and errors map to stable,
  non-secret responses.
- Workspace, session, plugin, automation, voice, documentation, Git and config
  state each use their authoritative owner without parallel caches.
- Long-running resources have bounded admission, cancellation, disconnect and
  shutdown behavior.
- Async work is awaited or deliberately supervised; detached failures cannot
  become unhandled rejection or false success.
- Path policy and secret projection apply at every capability boundary.
- Shared/plugin and Node/Python contract changes update all providers and
  consumers.
- Tests reach routes or application services and cover wrong target, stale ID,
  partial persistence, cancellation and shutdown as applicable.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-server"`.
