# System Context

## Product Boundary

CloudX is a local-first, single-developer workbench. It runs on the developer's
Linux machine and exposes workstation capabilities to a browser over loopback
by default. Remote access should use an authenticated reverse proxy whose
backend connection also terminates on loopback. An explicit IPv4 wildcard bind
is supported only with an exact trusted browser origin and a private, firewalled
LAN; arbitrary interface, hostname, IPv6 wildcard, and public binds remain
unsupported.

Repository AI automation is outside the CloudX runtime. It consumes tracked
repository contracts and GitHub state; it is not a feature of `apps/server` or
`apps/web`.

## Runtime Processes

| Process                                                 | Responsibility                                                                                                                                               | Primary boundary                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Browser, `apps/web`                                     | Render workspace state, collect user commands and audio, and project server/plugin state                                                                     | HTTPS and WebSocket API                                    |
| Node server, `apps/server`                              | Compose capabilities, own sessions and workspace persistence, execute plugins and automation, proxy local tools, and coordinate voice/documentation adapters | Fastify routes, WebSockets, host filesystem, and processes |
| ASR, `services/asr`                                     | Convert uploaded or streamed audio to transcription results                                                                                                  | Local HTTP/WebSocket service                               |
| Documentation indexer, `services/documentation-indexer` | Ingest, extract, persist, search, enrich, export, import, and invalidate documentation                                                                       | Local HTTP service and archive directory                   |
| Codex and shell processes                               | Execute developer-controlled terminal work                                                                                                                   | Child-process and PTY boundary                             |

`packages/shared` carries browser/server data contracts. `packages/plugin-api`
defines plugin, hook, trigger, and contribution contracts used by the server.
The Python services do not import TypeScript packages; their contracts cross
local HTTP boundaries and require consumer/provider tests.

## Repository Automation Boundary

| Surface                     | Public responsibility                                                                  | Explicit exclusion                                           |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Policy and skills           | Classify changes, select finite reviewers, and define typed role behavior              | Durable orchestration or GitHub credentials                  |
| Public classifier           | Project deterministic labels from changed paths and policy                             | Admission or merge authority                                 |
| Public CI verifier          | Execute exact candidates with pinned tooling and no privileged repository credential   | Model judgment or GitHub mutation                            |
| External private controller | Consume the public contract and submit schema-bound checks or allowed GitHub mutations | Changing public policy or self-attesting candidate execution |
| Public rulesets             | Bind required checks and allowed update identities                                     | Private controller deployment details                        |

The external controller is intentionally opaque at this boundary. Its model
authentication, service layout, persistent state, recovery, and credential
handling belong to its private repository. See `docs/AI_CHANGE_PROCESS.md` for
the public protocol.

## External Systems

- Local Git repositories and worktrees.
- Codex CLI and Codex app-server.
- Jira Cloud when configured.
- GitHub for validated plugin metadata and repository contribution workflows.
- User-provided documentation sources and media.
- Optional local dashboards proxied into the workspace.

Every external response and user-supplied path is boundary data. Validate it
before it reaches domain state or host execution.

## Trust Boundary

The trusted principal is the local developer. The browser, server, and local
services still handle high-impact capabilities: terminal input, file mutation,
microphone data, credentials, and arbitrary developer commands. Maintain these
constraints:

- Loopback remains the default server bind.
- The only accepted non-loopback bind is explicit `0.0.0.0`, which requires a
  configured trusted browser origin and a private, firewalled LAN.
- Allowed roots constrain file, Git, worktree, process cwd, and upload paths.
- Secrets stay outside public configuration responses and logs.
- Untrusted plugin repositories contribute validated metadata only; they do not
  execute third-party code through the install path.
- Automation code is explicit host execution and requires bounded resources,
  safety classification, cancellation, and human review for execution changes.

See `docs/SECURITY_MODEL.md` for deployment guidance and known exclusions.
