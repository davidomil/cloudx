# System Context

## Product Boundary

CloudX is a local-first, single-developer workbench. It runs on the developer's
Linux machine and exposes workstation capabilities to a browser over loopback.
Remote access requires an authenticated reverse proxy whose backend connection
also terminates on loopback. Direct LAN, tailnet, and public binds are
unsupported.

The repository AI change process is outside this runtime. It operates through
tracked repository artifacts and GitHub controls; it must not be added to
`apps/server` as a product feature.

## Repository Automation Processes

| Process                       | Responsibility                                                                                                        | Must not own                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| AI manager, `apps/ai-manager` | Verify signed target webhooks, snapshot exact subjects, own PostgreSQL execution state, and issue one-time capability | Model authentication, candidate execution, publication, or merge keys                     |
| Local executor                | Claim one execution, materialize bounded context, route fixed stages, and statically validate proposed patches        | App keys, Codex authentication, candidate execution, arbitrary commands, or durable state |
| Codex worker                  | Run one serialized, schema-bound, read-only and shell-free model stream                                               | GitHub credentials, source fetching, verification, or host sudo                           |
| Public CI verifier            | Execute exact candidates on GitHub-hosted runners with pinned tooling and no privileged repository credential         | Model judgment or GitHub mutation                                                         |
| Publisher actuator            | Revalidate typed publication requests and publish candidate branches, PRs, labels, and checks                         | Model authentication, merge authority, or arbitrary repository writes                     |
| Merge actuator                | Re-fetch current readiness, publish exact intent, and perform one SHA-bound merge                                     | Candidate publication, model judgment, or issue intake                                    |

The private repository is source distribution, not the runtime trust anchor.
The host installs a root-owned exact commit and canonical source digest. Public
CloudX keeps GitHub-hosted CI and public rulesets; no public workflow can select
the logged-in Codex worker. See [CloudX Local AI Controller V4](local-ai-controller.md).

## Runtime Processes

| Process                                                 | Responsibility                                                                                                                                               | Primary boundary                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Browser, `apps/web`                                     | Render workspace state, collect user commands and audio, and project server/plugin state                                                                     | HTTPS and WebSocket API                                   |
| Node server, `apps/server`                              | Compose capabilities, own sessions and workspace persistence, execute plugins and automation, proxy local tools, and coordinate voice/documentation adapters | Fastify routes, WebSockets, host filesystem and processes |
| ASR, `services/asr`                                     | Convert uploaded or streamed audio to transcription results                                                                                                  | Local HTTP/WebSocket service                              |
| Documentation indexer, `services/documentation-indexer` | Ingest, extract, persist, search, enrich, export, import, and invalidate documentation                                                                       | Local HTTP service and archive directory                  |
| Codex and shell processes                               | Execute developer-controlled terminal work                                                                                                                   | Child-process and PTY boundary                            |

`packages/shared` carries browser/server data contracts. `packages/plugin-api`
defines plugin, hook, trigger, and contribution contracts used by the server.
The Python services do not import TypeScript packages; their contracts cross
local HTTP boundaries and require consumer/provider tests.

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
- Non-loopback product binds fail configuration validation.
- Allowed roots constrain file, Git, worktree, process cwd, and upload paths.
- Secrets stay outside public configuration responses and logs.
- Untrusted plugin repositories contribute validated metadata only; they do not
  execute third-party code through the install path.
- Automation code is explicit host execution and requires bounded resources,
  safety classification, cancellation, and human review for execution changes.

See `docs/SECURITY_MODEL.md` for deployment guidance and known exclusions.
