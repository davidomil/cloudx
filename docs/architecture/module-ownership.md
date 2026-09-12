# Module Ownership

## Dependency Direction

```text
packages/shared <- packages/plugin-api <- apps/server
       ^                                  |
       +--------------- apps/web --------+

apps/server -> local HTTP -> services/asr
apps/server -> local HTTP -> services/documentation-indexer
```

Python services are independently packaged processes. They do not share
in-memory state with the Node server. The [documentation lifecycle](documentation-lifecycle.md)
describes retained sources, revision families, source campaigns, and archive-owned
AI run checkpoints at that boundary.
The [schematic analysis guide](documentation-schematics.md) covers typed circuit
artifacts, local SINA/OCR provisioning, capability states, and electrical limits.

## Product Owners

| Surface                                                           | Authority                                                                                             | Must not own                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/shared`                                                 | Serializable domain types, validators, workspace layout, and automation graph contracts               | Host I/O, UI behavior, plugin registration, or process lifecycle |
| `packages/plugin-api`                                             | Plugin, action, hook, trigger, skill, rule, configuration, and UI contribution interfaces             | Concrete plugin behavior or server persistence                   |
| `apps/server/src/server.ts`                                       | Fastify composition, route/WebSocket adapters, dependency wiring, and shutdown coordination           | Feature logic that belongs in a focused service                  |
| `apps/server/src/sessionStore.ts` and terminal modules            | Terminal session and PTY lifecycle                                                                    | Workspace layout or browser projection state                     |
| `apps/server/src/workspace/`                                      | Persisted workspace windows, tabs, layouts, and templates                                             | Terminal process ownership                                       |
| `apps/server/src/automation/`                                     | Graph validation and compilation, run orchestration, persistence, bounded execution, and cancellation | UI graph editing or plugin-specific behavior                     |
| `apps/server/src/git/`                                            | Git repository and worktree operations under path policy                                              | UI state or generic filesystem browsing                          |
| `apps/server/src/hooks/` and `triggers/`                          | Validated hook/trigger registration and dispatch                                                      | Hidden plugin-specific semantics                                 |
| `apps/server/src/plugins/`                                        | Concrete built-in plugin capabilities and adapters                                                    | Shared contract definitions                                      |
| `apps/server/src/config*`                                         | Configuration, secret storage, defaults, and public/private projection                                | UI rendering                                                     |
| `apps/server/src/voice/`                                          | Voice planning, execution coordination, audio queueing, and privacy-aware diagnostics                 | Speech model inference                                           |
| `apps/server/src/documentation/` and `archive/`                   | Node client, ingestion queue, enrichment orchestration, and server-facing archive adapters            | Archive index and storage internals                              |
| `apps/web/src/api.ts`                                             | Typed browser transport calls                                                                         | Server-owned domain decisions                                    |
| `apps/web/src/ui/layout.ts`                                       | Pure pane and layout transitions                                                                      | Persistence or terminal lifecycle                                |
| `apps/web/src/ui/`                                                | Rendering, local interaction state, accessibility, and projection of server/plugin contracts          | Host execution, authorization, or duplicated server state        |
| `services/asr`                                                    | ASR backend selection, audio validation, model lifecycle, transcription, and diagnostics              | Voice intent or workspace mutation                               |
| `services/documentation-indexer`                                  | Archive catalog, extraction, indexing, retrieval, import/export, enrichment, and artifact persistence | CloudX workspace or terminal state                               |
| `scripts/install-cloudx.mjs`, `install.sh`, `scripts/setup-*.mjs` | Installation, environment preparation, service setup, and dry-run behavior                            | Runtime application behavior                                     |

## Repository Automation Owners

These interfaces support optional machine-managed workflows; they are not a
required sequence for ordinary development.

| Surface                                                             | Responsibility                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `.agents/skills/` and `AGENTS.md`                                   | Task guidance and repository context                                                   |
| `.agents/pr-review-policy.toml` and `.agents/schemas/`              | Managed classification/admission and typed evidence                                    |
| `scripts/ai-change/policy.mjs`                                      | Path classification and route-owned gates                                              |
| `scripts/ai-change/artifact-validation.mjs` and `review-fanout.mjs` | Artifact identity, validity, and review completeness                                   |
| `scripts/ai-change/review-local.mjs`                                | Guarded Git scope observation and optional local evidence aggregation                  |
| `scripts/ai-change/validate-process.mjs`                            | Skill/reference structure and executable publication, verifier, and workflow contracts |
| `.github/workflows/` and `containers/ci/`                           | Public classification and credential-isolated candidate verification                   |
| External private controller                                         | Durable orchestration and separately authorized GitHub operations                      |

`review-local.mjs` separates shared scope observation from stricter CLI admission.
Shared observation can preserve normal staged entries; CLI modes require index
equal to HEAD. Neither worktree verification nor aggregation attests different
index-only bytes or grants hosting authority. See `docs/AI_CHANGE_PROCESS.md`
and the tools' colocated tests for their machine contracts.

## Composition

- Composition roots construct dependencies and own shutdown ordering.
- Feature services own state transitions; routes and components call them.
- Shared contracts stay side-effect free and serializable.
- The web app projects state rather than reproducing server authorization, path,
  automation-safety, or process-lifecycle decisions.
- Node/Python boundary changes affect both provider and consumer.
- Public automation emits typed requests and evidence. The authorized external
  controller cannot manufacture trusted candidate-verification evidence.
