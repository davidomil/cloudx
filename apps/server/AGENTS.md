# Server Scope Instructions

This file applies under `apps/server/` and extends the root `AGENTS.md`.

## Ownership

The server is the host capability and composition boundary. `src/server.ts`
wires Fastify, routes, WebSockets, plugins, services, and shutdown. Put feature
state and behavior in the focused owner named in
`docs/architecture/module-ownership.md`, not in route handlers.

## Rules

- Keep route and WebSocket adapters thin. Validate external input and map
  service errors at the boundary.
- Preserve allowed-root checks for files, Git, worktrees, uploads, extraction,
  and process cwd.
- Give every terminal, session, queue, poller, socket, timer, and child process
  one lifecycle owner and explicit cancellation/shutdown behavior.
- Keep plugin contracts in `packages/plugin-api` and shared serializable data in
  `packages/shared`; do not create server-local parallel DTOs without cause.
- Do not expose secrets through public config, errors, logs, or notifications.

## Tests

Add or update the colocated `*.test.ts` for the changed owner. Run focused tests,
then:

```bash
npm run typecheck
npm test
npm run build
```

Composition, route, WebSocket, lifecycle, cancellation, and path-policy changes
need integration or adversarial tests, not helper-only assertions.
