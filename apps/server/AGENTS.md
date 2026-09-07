# Server Context

`src/server.ts` composes Fastify, routes, WebSockets, plugins, services, and
shutdown. Feature state and behavior belong in their focused service, not in
transport handlers. The ownership map is in `docs/architecture/module-ownership.md`.

- Validate external input and map service errors at HTTP/WebSocket boundaries.
- Preserve allowed-root checks for files, Git, worktrees, uploads, extraction,
  and process cwd. Keep secrets out of public config, errors, and notifications.
- Give sessions, terminals, queues, pollers, sockets, timers, and child processes
  a clear owner, including cancellation and shutdown cleanup.
- Use `packages/plugin-api` for plugin contracts and `packages/shared` for
  serializable browser/server data rather than parallel local definitions.

Colocated `*.test.ts` files cover feature owners. For route, composition,
WebSocket, lifecycle, or path-policy changes, exercise the real boundary as well
as any helpers. The root testing map lists broader TypeScript checks.
