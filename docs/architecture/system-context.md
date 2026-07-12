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

| Process                          | Responsibility                                                                                                                            | Must not own                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AI manager, `apps/ai-manager`    | Verify webhooks, snapshot issue context and media, persist run authority, project discussion state, and dispatch exact workflow revisions | Repository-code execution, model credentials, publisher credentials, or merge actuation |
| Logged-in Codex runner           | Run serialized model-only jobs as `cloudx-codex` with persistent ChatGPT account authentication and exact workspace profiles              | GitHub mutation credentials, candidate execution, durable run authority, or host sudo   |
| Managed GitHub Actions workflows | Orchestrate model jobs and run credential-free verification, publication, and merge controllers                                           | Durable run authority or direct access to the Codex account credential                  |
| CI verifier, `containers/ci`     | Supervise candidate commands in a no-network, read-only container and write trusted deterministic evidence                                | Model judgment or GitHub mutation                                                       |
| Candidate publisher controllers  | Validate candidate artifacts, create the candidate branch and PR, and publish provenance                                                  | Issue intake, generated-code execution, or authority to update `main`                   |
| Merge authority controllers      | Recompute exact-head readiness, publish automation intent, and perform one SHA-bound merge                                                | Candidate publication, model judgment, or issue intake                                  |

The manager host holds the read-oriented Manager App key. The private
self-hosted runner holds only the persistent ChatGPT Codex login. Trusted
GitHub-hosted Actions jobs hold separate Candidate Publisher and Merge Authority
App keys. These credentials are not interchangeable, and model jobs receive no
GitHub write credential. Only the Merge Authority App appears in the active
`main` ruleset bypass list.

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
